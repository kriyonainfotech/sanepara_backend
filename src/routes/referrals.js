import { Router } from 'express';
import mongoose from 'mongoose';
import { Referral } from '../models/Referral.js';
import { Customer } from '../models/Customer.js';
import { Service } from '../models/Service.js';
import { Sale } from '../models/Sale.js';
import { User } from '../models/User.js';
import { getSetting, setSetting } from '../models/Setting.js';
import { protect, can, hasPermission } from '../middleware/auth.js';
import { monthBounds } from '../services/payroll.js';
import { incentiveFor } from '../services/incentive.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const seesAll = (req) => hasPermission(req, 'incentives', 'view') || hasPermission(req, 'incentives', 'manage');

const populate = (q) =>
  q
    .populate('customer', 'businessName phone')
    .populate('service', 'name price')
    .populate('referredBy', 'name role')
    .populate('reviewedBy', 'name')
    .populate('sale', 'saleNo title professionalFee totalAmount saleDate');

// Referrals: everyone sees their own; incentive viewers see all.
// ?month= filters by referred date; converted ones also show by converted month.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = {};
    if (!seesAll(req)) filter.referredBy = req.user._id;
    else if (mongoose.isValidObjectId(req.query.member)) filter.referredBy = req.query.member;
    if (['Pending', 'Converted', 'Rejected'].includes(req.query.status)) filter.status = req.query.status;
    if (isMonth(req.query.month)) {
      const [from, to] = monthBounds(req.query.month);
      filter.$or = [{ referredOn: { $gte: from, $lte: to } }, { convertedOn: { $gte: from, $lte: to } }];
    }
    res.json({ data: await populate(Referral.find(filter).sort({ referredOn: -1, createdAt: -1 }).limit(1000)), seesAll: seesAll(req) });
  })
);

// Incentive per member for a month (counted on the converted date).
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : todayKey().slice(0, 7);
    const [from, to] = monthBounds(month);
    const match = seesAll(req) ? {} : { referredBy: req.user._id };
    const [referred, converted, pending] = await Promise.all([
      Referral.aggregate([{ $match: { ...match, referredOn: { $gte: from, $lte: to } } }, { $group: { _id: '$referredBy', count: { $sum: 1 } } }]),
      Referral.aggregate([{ $match: { ...match, status: 'Converted', convertedOn: { $gte: from, $lte: to } } }, { $group: { _id: '$referredBy', count: { $sum: 1 }, incentive: { $sum: '$incentive' } } }]),
      Referral.aggregate([{ $match: { ...match, status: 'Pending' } }, { $group: { _id: '$referredBy', count: { $sum: 1 } } }]),
    ]);
    const ids = [...new Set([...referred, ...converted, ...pending].map((x) => String(x._id)))];
    const users = await User.find({ _id: { $in: ids } }).select('name role designation').lean();
    const idx = (arr) => Object.fromEntries(arr.map((x) => [String(x._id), x]));
    const [a, b, c] = [idx(referred), idx(converted), idx(pending)];
    const members = users
      .map((u) => ({ member: u, referred: a[u._id]?.count || 0, converted: b[u._id]?.count || 0, pending: c[u._id]?.count || 0, incentive: r2(b[u._id]?.incentive) }))
      .sort((x, y) => y.incentive - x.incentive || y.converted - x.converted);
    const sum = (k) => r2(members.reduce((s, m) => s + m[k], 0));
    res.json({ month, members, stats: { referred: sum('referred'), converted: sum('converted'), pending: sum('pending'), incentive: sum('incentive') } });
  })
);

// Pickers for the "Refer a service" form — open to everyone (Team may not see the Services page).
router.get(
  '/options',
  asyncHandler(async (_req, res) => {
    const [customers, services] = await Promise.all([
      Customer.find().select('businessName').sort({ businessName: 1 }).lean(),
      Service.find({ isActive: true }).select('name price').sort({ name: 1 }).lean(),
    ]);
    res.json({ customers, services });
  })
);

router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json({ data: await getSetting('incentive') });
  })
);

router.put(
  '/settings',
  can('incentives', 'manage'),
  asyncHandler(async (req, res) => {
    const type = (t) => (t === 'fixed' ? 'fixed' : 'percent');
    const value = (v, t) => {
      const n = Number(v);
      if (!(n >= 0) || (t === 'percent' && n > 100)) throw new HttpError(400, 'Incentive must be 0–100% or a positive amount');
      return n;
    };
    const defaultType = type(req.body.defaultType);
    const services = (Array.isArray(req.body.services) ? req.body.services : [])
      .filter((s) => mongoose.isValidObjectId(s.service))
      .map((s) => ({ service: String(s.service), type: type(s.type), value: value(s.value, type(s.type)) }));
    const data = await setSetting('incentive', { defaultType, defaultValue: value(req.body.defaultValue, defaultType), services }, req.user._id);
    res.json({ message: 'Incentive rules saved', data });
  })
);

// Refer a service to a customer (Team panel).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { customer, service, note } = req.body;
    if (!mongoose.isValidObjectId(customer) || !(await Customer.exists({ _id: customer }))) throw new HttpError(400, 'Select a customer');
    if (!mongoose.isValidObjectId(service) || !(await Service.exists({ _id: service }))) throw new HttpError(400, 'Select a service');
    let referredBy = req.user._id;
    if (req.body.referredBy && hasPermission(req, 'incentives', 'manage')) {
      if (!mongoose.isValidObjectId(req.body.referredBy) || !(await User.exists({ _id: req.body.referredBy }))) throw new HttpError(400, 'Select a valid member');
      referredBy = req.body.referredBy;
    }
    if (await Referral.exists({ customer, service, status: 'Pending' })) throw new HttpError(400, 'This service is already referred for this customer');
    const ref = await Referral.create({ customer, service, note, referredBy, referredOn: isDayKey(req.body.referredOn) ? req.body.referredOn : todayKey() });
    res.status(201).json({ message: 'Service referred', data: await populate(Referral.findById(ref._id)) });
  })
);

// Suggested incentive for a service at a professional fee (assign service → sale form).
router.get(
  '/suggest-incentive',
  can('incentives', 'manage'),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.query.service)) throw new HttpError(400, 'Select a service');
    res.json(await incentiveFor(req.query.service, { professionalFee: Number(req.query.fee) || 0 }));
  })
);

// Suggested incentive for a referral (optionally against a sale).
router.get(
  '/:id/suggest',
  can('incentives', 'manage'),
  asyncHandler(async (req, res) => {
    const ref = await Referral.findById(req.params.id);
    if (!ref) throw new HttpError(404, 'Referral not found');
    const sale = mongoose.isValidObjectId(req.query.sale) ? await Sale.findById(req.query.sale) : null;
    const sales = await Sale.find({ customer: ref.customer }).select('saleNo title professionalFee totalAmount saleDate service').sort({ saleDate: -1 }).limit(50).lean();
    res.json({ ...(await incentiveFor(ref.service, sale)), sales });
  })
);

router.post(
  '/:id/convert',
  can('incentives', 'manage'),
  asyncHandler(async (req, res) => {
    const ref = await Referral.findById(req.params.id);
    if (!ref) throw new HttpError(404, 'Referral not found');
    let sale = null;
    if (req.body.sale) {
      sale = await Sale.findById(req.body.sale);
      if (!sale || String(sale.customer) !== String(ref.customer)) throw new HttpError(400, 'Pick a sale of this customer');
    }
    const incentive = req.body.incentive === undefined || req.body.incentive === '' ? (await incentiveFor(ref.service, sale)).incentive : r2(req.body.incentive);
    if (!(incentive >= 0)) throw new HttpError(400, 'Incentive cannot be negative');
    Object.assign(ref, {
      status: 'Converted',
      sale: sale?._id,
      incentive,
      convertedOn: isDayKey(req.body.convertedOn) ? req.body.convertedOn : sale?.saleDate || todayKey(),
      rejectReason: undefined,
      reviewedBy: req.user._id,
    });
    await ref.save();
    res.json({ message: `Converted — ₹${incentive} incentive`, data: await populate(Referral.findById(ref._id)) });
  })
);

router.post(
  '/:id/reject',
  can('incentives', 'manage'),
  asyncHandler(async (req, res) => {
    const ref = await Referral.findById(req.params.id);
    if (!ref) throw new HttpError(404, 'Referral not found');
    Object.assign(ref, { status: 'Rejected', rejectReason: req.body.reason, incentive: 0, sale: undefined, convertedOn: undefined, reviewedBy: req.user._id });
    await ref.save();
    res.json({ message: 'Referral marked not converted', data: await populate(Referral.findById(ref._id)) });
  })
);

router.post(
  '/:id/reopen',
  can('incentives', 'manage'),
  asyncHandler(async (req, res) => {
    const ref = await Referral.findById(req.params.id);
    if (!ref) throw new HttpError(404, 'Referral not found');
    Object.assign(ref, { status: 'Pending', rejectReason: undefined, incentive: 0, sale: undefined, convertedOn: undefined, reviewedBy: req.user._id });
    await ref.save();
    res.json({ message: 'Referral moved back to pending', data: await populate(Referral.findById(ref._id)) });
  })
);

// Members can withdraw their own pending referral; managers can delete any.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ref = await Referral.findById(req.params.id);
    if (!ref) throw new HttpError(404, 'Referral not found');
    const manager = hasPermission(req, 'incentives', 'manage');
    if (!manager && (String(ref.referredBy) !== String(req.user._id) || ref.status !== 'Pending'))
      throw new HttpError(403, 'You can only remove your own pending referrals');
    await ref.deleteOne();
    res.json({ message: 'Referral removed' });
  })
);

export default router;
