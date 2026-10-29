import { Router } from 'express';
import mongoose from 'mongoose';
import { Invoice } from '../models/Invoice.js';
import { Sale } from '../models/Sale.js';
import { SalePayment } from '../models/SalePayment.js';
import { Customer } from '../models/Customer.js';
import { nextNumber } from '../models/Counter.js';
import { getSetting } from '../models/Setting.js';
import { protect, can } from '../middleware/auth.js';
import { monthBounds } from '../services/payroll.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const escapeRegex = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Give every sale without an invoice its number (oldest first), and drop
// invoices of deleted sales. Runs one at a time so numbers stay in order.
let running = null;
export function ensureInvoices() {
  running ||= (async () => {
    try {
      const saleIds = await Sale.distinct('_id');
      await Invoice.deleteMany({ sale: { $nin: saleIds } });
      const invoiced = await Invoice.distinct('sale');
      const pending = await Sale.find({ _id: { $nin: invoiced } }).select('saleDate').sort({ saleDate: 1, createdAt: 1 }).lean();
      for (const s of pending) await Invoice.create({ sale: s._id, invoiceDate: s.saleDate, invoiceNo: await nextNumber('invoice', 'INV') });
      return pending.length;
    } finally {
      running = null;
    }
  })();
  return running;
}

const populateSale = {
  path: 'sale',
  populate: [
    { path: 'customer', select: 'businessName contactPerson phone email gstNumber address' },
    { path: 'service', select: 'name' },
  ],
};

router.get(
  '/',
  can('invoices', 'view'),
  asyncHandler(async (req, res) => {
    await ensureInvoices();
    const filter = {};
    if (isMonth(req.query.month)) {
      const [from, to] = monthBounds(req.query.month);
      filter.invoiceDate = { $gte: from, $lte: to };
    }
    if (req.query.search?.trim()) {
      const rx = { $regex: escapeRegex(req.query.search.trim()), $options: 'i' };
      const customers = await Customer.find({ $or: [{ businessName: rx }, { phone: rx }, { gstNumber: rx }] }).distinct('_id');
      const sales = await Sale.find({ $or: [{ customer: { $in: customers } }, { saleNo: rx }, { title: rx }] }).distinct('_id');
      filter.$or = [{ invoiceNo: rx }, { sale: { $in: sales } }];
    }
    if (mongoose.isValidObjectId(req.query.customer)) {
      const sales = await Sale.find({ customer: req.query.customer }).distinct('_id');
      filter.sale = { $in: sales };
    }
    const data = await Invoice.find(filter).populate(populateSale).sort({ invoiceDate: -1, invoiceNo: -1 }).limit(1000).lean();
    const sum = (k) => Math.round(data.reduce((a, i) => a + (i.sale?.[k] || 0), 0) * 100) / 100;
    res.json({ data, stats: { count: data.length, total: sum('totalAmount'), received: sum('receivedAmount'), balance: sum('balance') } });
  })
);

// Invoice for a sale (creating it if needed) — used by "Invoice" buttons.
router.get(
  '/by-sale/:saleId',
  can('invoices', 'view'),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.saleId) || !(await Sale.exists({ _id: req.params.saleId }))) throw new HttpError(404, 'Sale not found');
    await ensureInvoices();
    const inv = await Invoice.findOne({ sale: req.params.saleId }).select('_id');
    res.json({ id: inv._id });
  })
);

router.get(
  '/:id',
  can('invoices', 'view'),
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id).populate(populateSale).lean();
    if (!invoice || !invoice.sale) throw new HttpError(404, 'Invoice not found');
    const [payments, firm] = await Promise.all([
      SalePayment.find({ sale: invoice.sale._id }).sort({ date: 1, createdAt: 1 }).lean(),
      getSetting('firm'),
    ]);
    res.json({ data: invoice, payments, firm, today: todayKey() });
  })
);

router.put(
  '/:id',
  can('invoices', 'create'),
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    if (req.body.invoiceDate !== undefined) {
      if (!isDayKey(req.body.invoiceDate)) throw new HttpError(400, 'Pick the invoice date');
      invoice.invoiceDate = req.body.invoiceDate;
    }
    if (req.body.notes !== undefined) invoice.notes = req.body.notes;
    await invoice.save();
    res.json({ message: 'Invoice updated', data: invoice });
  })
);

export default router;
