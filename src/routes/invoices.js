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

async function addToAutomaticInvoice(key, sales) {
  const [first] = sales;
  const filter = { invoiceGroupKey: key };
  const addSales = { $addToSet: { groupedSales: { $each: sales.map((sale) => sale._id) } } };
  if ((await Invoice.updateOne(filter, addSales)).matchedCount) return;
  try {
    await Invoice.create({
      invoiceGroupKey: key,
      sale: first._id,
      invoiceDate: first.saleDate,
      invoiceNo: await nextNumber('invoice', 'INV'),
      groupedSales: sales.map((sale) => sale._id),
    });
  } catch (error) {
    if (error.code !== 11000 || !(await Invoice.updateOne(filter, addSales)).matchedCount) throw error;
  }
}

export function ensureInvoices() {
  running ||= (async () => {
    try {
      const saleIds = await Sale.distinct('_id');
      await Invoice.deleteMany({ sale: { $nin: saleIds }, groupedSales: { $nin: saleIds } });
      const [singleSales, groupedSales] = await Promise.all([Invoice.distinct('sale'), Invoice.distinct('groupedSales')]);
      const pending = await Sale.find({ _id: { $nin: [...singleSales, ...groupedSales] } })
        .select('saleDate invoiceBatch invoiceGroupKey').sort({ saleDate: 1, createdAt: 1, _id: 1 }).lean();
      const batches = new Map();
      for (const sale of pending) {
        const key = sale.invoiceGroupKey || String(sale.invoiceBatch || sale._id);
        if (!batches.has(key)) batches.set(key, []);
        batches.get(key).push(sale);
      }
      for (const sales of batches.values()) {
        const [first] = sales;
        if (first.invoiceGroupKey) {
          await addToAutomaticInvoice(first.invoiceGroupKey, sales);
          continue;
        }
        try {
          await Invoice.create({
            sale: first._id,
            invoiceDate: first.saleDate,
            invoiceNo: await nextNumber('invoice', 'INV'),
            ...(sales.length > 1 && { groupedSales: sales.map((sale) => sale._id) }),
          });
        } catch (error) {
          if (error.code !== 11000 || !await Invoice.exists({ sale: first._id })) throw error;
        }
      }
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
    { path: 'customer', select: 'businessName contactPerson phone email gstNumber gsts address' },
    { path: 'service', select: 'name' },
  ],
};
const populateGroupedSales = { ...populateSale, path: 'groupedSales' };
const moneyFields = ['totalAmount', 'receivedAmount', 'discountAmount', 'balance'];
const sumMoney = (rows, key) => Math.round(rows.reduce((sum, row) => sum + (row?.[key] || 0), 0) * 100) / 100;

function invoiceData(invoice) {
  const grouped = Boolean(invoice.groupedSales?.length);
  const sales = grouped ? invoice.groupedSales : [invoice.sale].filter(Boolean);
  const totals = Object.fromEntries(moneyFields.map((key) => [key, sumMoney(sales, key)]));
  const status = sales.length === 1 ? sales[0].status
    : totals.balance > 0 ? (totals.receivedAmount || totals.discountAmount ? 'Partial' : 'Pending')
      : sales.every((sale) => sale.status === 'Written Off') ? 'Written Off' : 'Cleared';
  return { ...invoice, grouped, sale: sales[0], sales, totals, status };
}

const invoiceForSale = async (saleId) =>
  (await Invoice.findOne({ groupedSales: saleId })) || Invoice.findOne({ sale: saleId });

router.get(
  '/',
  can('invoices', 'view'),
  asyncHandler(async (req, res) => {
    await ensureInvoices();
    const groupedSaleIds = await Invoice.distinct('groupedSales');
    const filter = { $and: [{ $or: [{ groupedSales: { $exists: true } }, { sale: { $nin: groupedSaleIds } }] }] };
    if (isMonth(req.query.month)) {
      const [from, to] = monthBounds(req.query.month);
      filter.invoiceDate = { $gte: from, $lte: to };
    }
    if (req.query.search?.trim()) {
      const rx = { $regex: escapeRegex(req.query.search.trim()), $options: 'i' };
      const customers = await Customer.find({ $or: [{ businessName: rx }, { phone: rx }, { gstNumber: rx }] }).distinct('_id');
      const sales = await Sale.find({ $or: [{ customer: { $in: customers } }, { saleNo: rx }, { title: rx }, { firmName: rx }, { gstNumber: rx }] }).distinct('_id');
      const matchingInvoices = await Invoice.find({ invoiceNo: rx }).distinct('sale');
      const ids = [...sales, ...matchingInvoices];
      filter.$and.push({ $or: [{ sale: { $in: ids } }, { groupedSales: { $in: ids } }] });
    }
    if (mongoose.isValidObjectId(req.query.customer)) {
      const sales = await Sale.find({ customer: req.query.customer }).distinct('_id');
      filter.$and.push({ $or: [{ sale: { $in: sales } }, { groupedSales: { $in: sales } }] });
    }
    const invoices = await Invoice.find(filter).populate([populateSale, populateGroupedSales]).sort({ invoiceDate: -1, invoiceNo: -1 }).limit(1000).lean();
    const data = invoices.map(invoiceData).filter((invoice) => invoice.sale);
    const sum = (key) => sumMoney(data.map((invoice) => invoice.totals), key);
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
    const inv = await invoiceForSale(req.params.saleId);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    res.json({ id: inv._id });
  })
);

router.post(
  '/combine',
  can('invoices', 'create'),
  asyncHandler(async (req, res) => {
    const ids = req.body.invoiceIds;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !mongoose.isValidObjectId(id)) || new Set(ids).size !== ids.length) {
      throw new HttpError(400, 'Select 2 to 100 invoices');
    }
    const invoices = await Invoice.find({ _id: { $in: ids } }).populate('sale').sort({ invoiceDate: 1, invoiceNo: 1 });
    if (invoices.length !== ids.length || invoices.some((invoice) => !invoice.sale)) throw new HttpError(404, 'An invoice is no longer available');
    const [primary] = invoices;
    const sales = invoices.map((invoice) => invoice.sale);
    const saleIds = sales.map((sale) => sale._id);
    if (sales.some((sale) => !sale.customer?.equals(primary.sale.customer) || (sale.gstNumber || '') !== (primary.sale.gstNumber || ''))) {
      throw new HttpError(400, 'Select invoices for the same customer and GSTIN');
    }
    if (await Invoice.exists({ groupedSales: { $in: saleIds } })) throw new HttpError(409, 'An invoice is already combined');
    try {
      const result = await Invoice.updateOne(
        { _id: primary._id, groupedSales: { $exists: false } },
        { $set: { groupedSales: saleIds } },
        { runValidators: true },
      );
      if (!result.modifiedCount) throw new HttpError(409, 'An invoice is already combined');
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, 'An invoice is already combined');
      throw error;
    }
    res.json({ id: primary._id, message: 'Invoices combined' });
  })
);

router.get(
  '/:id',
  can('invoices', 'view'),
  asyncHandler(async (req, res) => {
    await ensureInvoices();
    const requested = await Invoice.findById(req.params.id).select('sale');
    if (!requested) throw new HttpError(404, 'Invoice not found');
    const canonical = await invoiceForSale(requested.sale);
    const record = await Invoice.findById(canonical._id).populate([populateSale, populateGroupedSales]).lean();
    if (!record) throw new HttpError(404, 'Invoice not found');
    const invoice = invoiceData(record);
    if (!invoice.sale) throw new HttpError(404, 'Invoice not found');
    const [payments, firm] = await Promise.all([
      SalePayment.find({ sale: { $in: invoice.sales.map((sale) => sale._id) } }).sort({ date: 1, createdAt: 1 }).lean(),
      getSetting('firm'),
    ]);
    res.json({ data: invoice, payments, firm, today: todayKey() });
  })
);

router.put(
  '/:id',
  can('invoices', 'create'),
  asyncHandler(async (req, res) => {
    const requested = await Invoice.findById(req.params.id).select('sale');
    if (!requested) throw new HttpError(404, 'Invoice not found');
    const invoice = await invoiceForSale(requested.sale);
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
