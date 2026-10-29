import { Router } from 'express';
import mongoose from 'mongoose';
import { Sale } from '../models/Sale.js';
import { SalePayment } from '../models/SalePayment.js';
import { Customer } from '../models/Customer.js';
import { CustomerService } from '../models/CustomerService.js';
import { B2BPartner } from '../models/B2BPartner.js';
import { User } from '../models/User.js';
import { nextNumber } from '../models/Counter.js';
import { protect, can, hasPermission } from '../middleware/auth.js';
import { computeFees, recalcSale } from '../services/sales.js';
import { monthBounds } from '../services/payroll.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const MODES = ['Cash', 'Bank', 'UPI', 'Cheque'];
const escapeRegex = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const populate = (q) =>
  q
    .populate('customer', 'businessName phone gstNumber')
    .populate('service', 'name')
    .populate('soldBy', 'name')
    .populate('b2bPartner', 'name firmName percentage');

// Date range from ?month= or ?from=&to= (defaults to this month).
function range(q) {
  if (isDayKey(q.from) && isDayKey(q.to)) return [q.from, q.to];
  return monthBounds(isMonth(q.month) ? q.month : todayKey().slice(0, 7));
}

async function buildSale(body, existing) {
  const data = {};
  const customerId = body.customer ?? existing?.customer;
  if (!mongoose.isValidObjectId(customerId) || !(await Customer.exists({ _id: customerId }))) throw new HttpError(400, 'Select a customer');
  data.customer = customerId;

  if (body.customerService !== undefined) {
    if (body.customerService) {
      const cs = await CustomerService.findById(body.customerService);
      if (!cs || String(cs.customer) !== String(customerId)) throw new HttpError(400, 'That service is not assigned to this customer');
      data.customerService = cs._id;
      data.service = cs.service;
    } else {
      data.customerService = undefined;
      data.service = mongoose.isValidObjectId(body.service) ? body.service : undefined;
    }
  } else if (body.service !== undefined) {
    data.service = mongoose.isValidObjectId(body.service) ? body.service : undefined;
  }

  const title = (body.title ?? existing?.title)?.trim();
  if (!title) throw new HttpError(400, 'Add what the sale is for');
  data.title = title;

  const fees = computeFees(body.professionalFee ?? existing?.professionalFee, body.govtFee ?? existing?.govtFee);
  if (fees.totalAmount <= 0) throw new HttpError(400, 'Enter the professional fee and/or government fee');
  if (existing && fees.totalAmount < existing.receivedAmount + existing.discountAmount)
    throw new HttpError(400, `Total cannot be less than what is already received (₹${existing.receivedAmount + existing.discountAmount})`);
  Object.assign(data, fees);

  const saleDate = body.saleDate ?? existing?.saleDate ?? todayKey();
  if (!isDayKey(saleDate)) throw new HttpError(400, 'Pick the sale date');
  data.saleDate = saleDate;

  if (body.soldBy !== undefined) {
    if (body.soldBy && !(mongoose.isValidObjectId(body.soldBy) && (await User.exists({ _id: body.soldBy })))) throw new HttpError(400, 'Select a valid member');
    data.soldBy = body.soldBy || undefined;
  }

  if (body.b2bPartner !== undefined) {
    if (body.b2bPartner) {
      const partner = await B2BPartner.findById(body.b2bPartner);
      if (!partner) throw new HttpError(400, 'Select a valid B2B partner');
      data.b2bPartner = partner._id;
      const pct = body.b2bPercent === undefined || body.b2bPercent === '' ? partner.percentage : Number(body.b2bPercent);
      if (!(pct >= 0 && pct <= 100)) throw new HttpError(400, 'Partner % must be between 0 and 100');
      data.b2bPercent = pct;
    } else {
      data.b2bPartner = undefined;
      data.b2bPercent = 0;
    }
  } else if (body.b2bPercent !== undefined && existing?.b2bPartner) {
    data.b2bPercent = Number(body.b2bPercent) || 0;
  }
  if (body.notes !== undefined) data.notes = body.notes;
  return data;
}

// ---------- list & stats ----------

router.get(
  '/',
  can('sales', 'view'),
  asyncHandler(async (req, res) => {
    const [from, to] = range(req.query);
    const filter = { saleDate: { $gte: from, $lte: to } };
    if (['Pending', 'Partial', 'Cleared', 'Written Off'].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.status === 'open') filter.balance = { $gt: 0 };
    for (const k of ['customer', 'b2bPartner', 'soldBy', 'service']) if (mongoose.isValidObjectId(req.query[k])) filter[k] = req.query[k];
    if (req.query.search?.trim()) {
      const rx = { $regex: escapeRegex(req.query.search.trim()), $options: 'i' };
      const customers = await Customer.find({ $or: [{ businessName: rx }, { phone: rx }] }).distinct('_id');
      filter.$or = [{ title: rx }, { saleNo: rx }, { customer: { $in: customers } }];
    }
    const sales = await populate(Sale.find(filter).sort({ saleDate: -1, createdAt: -1 }).limit(1000));
    const sum = (k) => Math.round(sales.reduce((a, s) => a + (s[k] || 0), 0) * 100) / 100;
    res.json({
      from, to,
      data: sales,
      stats: {
        count: sales.length,
        total: sum('totalAmount'),
        professional: sum('professionalFee'),
        govt: sum('govtFee'),
        received: sum('receivedAmount'),
        discount: sum('discountAmount'),
        balance: sum('balance'),
        commission: sum('b2bCommission'),
      },
    });
  })
);

// Customers who still owe money (all time) — "payment baaki" list.
router.get(
  '/outstanding',
  can('sales', 'view'),
  asyncHandler(async (_req, res) => {
    const rows = await Sale.aggregate([
      { $match: { balance: { $gt: 0 } } },
      {
        $group: {
          _id: '$customer',
          balance: { $sum: '$balance' },
          total: { $sum: '$totalAmount' },
          received: { $sum: '$receivedAmount' },
          sales: { $sum: 1 },
          oldest: { $min: '$saleDate' },
        },
      },
      { $sort: { balance: -1 } },
      { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'customer' } },
      { $unwind: '$customer' },
      { $project: { balance: 1, total: 1, received: 1, sales: 1, oldest: 1, 'customer._id': 1, 'customer.businessName': 1, 'customer.phone': 1, 'customer.contactPerson': 1 } },
    ]);
    res.json({ data: rows, total: Math.round(rows.reduce((a, r) => a + r.balance, 0) * 100) / 100 });
  })
);

// Payments received in a range (with the govt / professional split).
router.get(
  '/payments',
  can('sales', 'view'),
  asyncHandler(async (req, res) => {
    const [from, to] = range(req.query);
    const filter = { date: { $gte: from, $lte: to } };
    if (mongoose.isValidObjectId(req.query.customer)) filter.customer = req.query.customer;
    if (MODES.includes(req.query.mode)) filter.mode = req.query.mode;
    const payments = await SalePayment.find(filter)
      .populate('customer', 'businessName')
      .populate('sale', 'saleNo title')
      .populate('receivedBy', 'name')
      .sort({ date: -1, createdAt: -1 });
    const sum = (k) => Math.round(payments.reduce((a, p) => a + (p[k] || 0), 0) * 100) / 100;
    const byMode = {};
    for (const p of payments) byMode[p.mode] = (byMode[p.mode] || 0) + p.amount;
    res.json({ from, to, data: payments, stats: { count: payments.length, amount: sum('amount'), govt: sum('govtPart'), professional: sum('professionalPart'), discount: sum('discount'), byMode } });
  })
);

router.get(
  '/:id',
  can('sales', 'view'),
  asyncHandler(async (req, res) => {
    const sale = await populate(Sale.findById(req.params.id)).populate('createdBy', 'name');
    if (!sale) throw new HttpError(404, 'Sale not found');
    const payments = await SalePayment.find({ sale: sale._id }).populate('receivedBy', 'name').sort({ date: 1, createdAt: 1 });
    res.json({ data: sale, payments });
  })
);

// ---------- create / edit / delete ----------

router.post(
  '/',
  can('sales', 'create'),
  asyncHandler(async (req, res) => {
    const data = await buildSale({ soldBy: String(req.user._id), ...req.body });
    // Optional payment taken at the time of the sale — validated before anything is saved.
    const upfront = Math.round((Number(req.body.receivedNow) || 0) * 100) / 100;
    if (upfront < 0 || upfront > data.totalAmount) throw new HttpError(400, 'Received amount must be between 0 and the total');
    if (upfront > 0 && data.saleDate > todayKey()) throw new HttpError(400, 'A future-dated sale cannot have a payment yet');

    const sale = new Sale({ ...data, saleNo: await nextNumber('sale', 'S'), createdBy: req.user._id });
    await recalcSale(sale);
    if (upfront > 0) {
      await SalePayment.create({
        sale: sale._id, customer: sale.customer, amount: upfront, date: sale.saleDate,
        mode: MODES.includes(req.body.receivedMode) ? req.body.receivedMode : 'Cash', receivedBy: req.user._id,
      });
      await recalcSale(sale);
    }
    res.status(201).json({ message: `Sale ${sale.saleNo} created`, data: await populate(Sale.findById(sale._id)) });
  })
);

router.put(
  '/:id',
  can('sales', 'edit'),
  asyncHandler(async (req, res) => {
    const sale = await Sale.findById(req.params.id);
    if (!sale) throw new HttpError(404, 'Sale not found');
    if (req.body.customer && String(req.body.customer) !== String(sale.customer) && (await SalePayment.exists({ sale: sale._id })))
      throw new HttpError(400, 'Customer cannot change once payments are recorded');
    Object.assign(sale, await buildSale(req.body, sale));
    await recalcSale(sale);
    res.json({ message: 'Sale updated', data: await populate(Sale.findById(sale._id)) });
  })
);

router.delete(
  '/:id',
  can('sales', 'delete'),
  asyncHandler(async (req, res) => {
    const sale = await Sale.findById(req.params.id);
    if (!sale) throw new HttpError(404, 'Sale not found');
    if (await SalePayment.exists({ sale: sale._id })) throw new HttpError(400, 'Remove its payments first');
    await sale.deleteOne();
    res.json({ message: `Sale ${sale.saleNo} deleted` });
  })
);

// ---------- payments ----------

const canCollect = (req, _res, next) =>
  hasPermission(req, 'sales', 'collect') || hasPermission(req, 'sales', 'edit') ? next() : next(new HttpError(403, 'You do not have access to this'));

router.post(
  '/:id/payments',
  canCollect,
  asyncHandler(async (req, res) => {
    const sale = await Sale.findById(req.params.id);
    if (!sale) throw new HttpError(404, 'Sale not found');
    const amount = Math.round((Number(req.body.amount) || 0) * 100) / 100;
    const discount = Math.round((Number(req.body.discount) || 0) * 100) / 100;
    if (amount < 0 || discount < 0) throw new HttpError(400, 'Amounts cannot be negative');
    if (amount + discount <= 0) throw new HttpError(400, 'Enter the amount received (or a discount)');
    if (amount + discount > sale.balance + 0.001) throw new HttpError(400, `Only ₹${sale.balance} is pending on this sale`);
    const date = isDayKey(req.body.date) ? req.body.date : todayKey();
    if (date > todayKey()) throw new HttpError(400, 'Payment date cannot be in the future');

    await SalePayment.create({
      sale: sale._id, customer: sale.customer, amount, discount, date,
      mode: MODES.includes(req.body.mode) ? req.body.mode : 'Cash',
      reference: req.body.reference, note: req.body.note, receivedBy: req.user._id,
    });
    await recalcSale(sale);
    res.status(201).json({ message: amount ? `₹${amount} received` : `₹${discount} written off`, data: sale });
  })
);

router.delete(
  '/:id/payments/:paymentId',
  canCollect,
  asyncHandler(async (req, res) => {
    const p = await SalePayment.findOneAndDelete({ _id: req.params.paymentId, sale: req.params.id });
    if (!p) throw new HttpError(404, 'Payment not found');
    const sale = await recalcSale(req.params.id);
    res.json({ message: 'Payment removed', data: sale });
  })
);

export default router;
