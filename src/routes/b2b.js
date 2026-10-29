import { Router } from 'express';
import mongoose from 'mongoose';
import { B2BPartner } from '../models/B2BPartner.js';
import { B2BPayout } from '../models/B2BPayout.js';
import { Sale } from '../models/Sale.js';
import { protect, can } from '../middleware/auth.js';
import { monthBounds } from '../services/payroll.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const r2 = (n) => Math.round(n * 100) / 100;

const clean = (b) => {
  const pct = Number(b.percentage);
  if (!b.name?.trim()) throw new HttpError(400, 'Partner name is required');
  if (b.percentage === '' || b.percentage == null || !(pct >= 0 && pct <= 100)) throw new HttpError(400, 'Percentage must be between 0 and 100');
  if (b.phone && !/^\d{10}$/.test(String(b.phone).trim())) throw new HttpError(400, 'Mobile number must be exactly 10 digits');
  return { name: b.name.trim(), firmName: b.firmName, phone: b.phone, email: b.email, percentage: pct, notes: b.notes, isActive: b.isActive !== false };
};

// Partners with commission: this month, all time, paid and pending.
router.get(
  '/',
  can('b2b', 'view'),
  asyncHandler(async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : todayKey().slice(0, 7);
    const [from, to] = monthBounds(month);
    const [partners, allTime, thisMonth, payouts] = await Promise.all([
      B2BPartner.find().sort({ name: 1 }).lean(),
      Sale.aggregate([{ $match: { b2bPartner: { $ne: null } } }, { $group: { _id: '$b2bPartner', commission: { $sum: '$b2bCommission' }, sales: { $sum: 1 }, business: { $sum: '$totalAmount' } } }]),
      Sale.aggregate([{ $match: { b2bPartner: { $ne: null }, saleDate: { $gte: from, $lte: to } } }, { $group: { _id: '$b2bPartner', commission: { $sum: '$b2bCommission' }, sales: { $sum: 1 }, business: { $sum: '$totalAmount' } } }]),
      B2BPayout.aggregate([{ $group: { _id: '$partner', paid: { $sum: '$amount' } } }]),
    ]);
    const idx = (arr) => Object.fromEntries(arr.map((x) => [String(x._id), x]));
    const [a, m, p] = [idx(allTime), idx(thisMonth), idx(payouts)];
    const data = partners.map((pt) => {
      const total = a[pt._id]?.commission || 0;
      const paid = p[pt._id]?.paid || 0;
      return {
        ...pt,
        month: { sales: m[pt._id]?.sales || 0, business: r2(m[pt._id]?.business || 0), commission: r2(m[pt._id]?.commission || 0) },
        allTime: { sales: a[pt._id]?.sales || 0, business: r2(a[pt._id]?.business || 0), commission: r2(total) },
        paid: r2(paid),
        pending: r2(Math.max(0, total - paid)),
      };
    });
    const sum = (f) => r2(data.reduce((s, x) => s + f(x), 0));
    res.json({ month, data, stats: { monthCommission: sum((x) => x.month.commission), pending: sum((x) => x.pending), paid: sum((x) => x.paid), partners: data.filter((x) => x.isActive).length } });
  })
);

// Active partner names only, for pickers (customer "referred by").
router.get(
  '/options',
  asyncHandler(async (_req, res) => {
    const partners = await B2BPartner.find({ isActive: true }).select('name firmName percentage').sort({ name: 1 }).lean();
    res.json({ data: partners });
  })
);

// One partner: their sales (with commission) and payouts.
router.get(
  '/:id',
  can('b2b', 'view'),
  asyncHandler(async (req, res) => {
    const partner = await B2BPartner.findById(req.params.id).lean();
    if (!partner) throw new HttpError(404, 'Partner not found');
    const filter = { b2bPartner: partner._id };
    if (isMonth(req.query.month)) {
      const [from, to] = monthBounds(req.query.month);
      filter.saleDate = { $gte: from, $lte: to };
    }
    const [sales, payouts] = await Promise.all([
      Sale.find(filter).populate('customer', 'businessName').populate('service', 'name').sort({ saleDate: -1 }).lean(),
      B2BPayout.find({ partner: partner._id }).populate('paidBy', 'name').sort({ paidOn: -1 }).lean(),
    ]);
    res.json({ data: partner, sales, payouts });
  })
);

router.post(
  '/',
  can('b2b', 'create'),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await B2BPartner.create(clean(req.body)) });
  })
);

router.put(
  '/:id',
  can('b2b', 'edit'),
  asyncHandler(async (req, res) => {
    const partner = await B2BPartner.findByIdAndUpdate(req.params.id, clean(req.body), { new: true, runValidators: true });
    if (!partner) throw new HttpError(404, 'Partner not found');
    res.json({ data: partner, message: 'Partner updated. Existing sales keep the % they were made with.' });
  })
);

router.delete(
  '/:id',
  can('b2b', 'delete'),
  asyncHandler(async (req, res) => {
    if (await Sale.exists({ b2bPartner: req.params.id })) throw new HttpError(400, 'This partner has sales — mark them inactive instead');
    await B2BPayout.deleteMany({ partner: req.params.id });
    const p = await B2BPartner.findByIdAndDelete(req.params.id);
    if (!p) throw new HttpError(404, 'Partner not found');
    res.json({ message: 'Partner deleted' });
  })
);

router.post(
  '/:id/payouts',
  can('b2b', 'edit'),
  asyncHandler(async (req, res) => {
    const partner = await B2BPartner.findById(req.params.id);
    if (!partner) throw new HttpError(404, 'Partner not found');
    const amount = Number(req.body.amount);
    if (!(amount > 0)) throw new HttpError(400, 'Enter an amount');
    const payout = await B2BPayout.create({
      partner: partner._id, amount, paidOn: isDayKey(req.body.paidOn) ? req.body.paidOn : todayKey(),
      mode: ['Cash', 'Bank', 'UPI', 'Cheque'].includes(req.body.mode) ? req.body.mode : 'Bank', note: req.body.note, paidBy: req.user._id,
    });
    res.status(201).json({ message: `₹${amount} paid to ${partner.name}`, data: payout });
  })
);

router.delete(
  '/:id/payouts/:payoutId',
  can('b2b', 'edit'),
  asyncHandler(async (req, res) => {
    const p = await B2BPayout.findOneAndDelete({ _id: req.params.payoutId, partner: req.params.id });
    if (!p) throw new HttpError(404, 'Payout not found');
    res.json({ message: 'Payout removed' });
  })
);

export default router;
