import { Router } from 'express';
import mongoose from 'mongoose';
import { Sale } from '../models/Sale.js';
import { SalePayment } from '../models/SalePayment.js';
import { Customer } from '../models/Customer.js';
import { Service } from '../models/Service.js';
import { B2BPartner } from '../models/B2BPartner.js';
import { BankAccount } from '../models/BankAccount.js';
import { nextNumber } from '../models/Counter.js';
import { protect, can, hasPermission } from '../middleware/auth.js';
import { buildSale, computeFees, recalcSale } from '../services/sales.js';
import { monthBounds } from '../services/payroll.js';
import { pickBank } from '../services/banks.js';
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
      filter.$or = [{ title: rx }, { saleNo: rx }, { firmName: rx }, { gstNumber: rx }, { customer: { $in: customers } }];
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
      .populate({ path: 'sale', select: 'saleNo title firmName referredBy b2bPartner service', populate: [{ path: 'b2bPartner', select: 'name' }, { path: 'service', select: 'name' }] })
      .populate('receivedBy', 'name')
      .populate('bank', 'name')
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
    const payments = await SalePayment.find({ sale: sale._id }).populate('receivedBy', 'name').populate('bank', 'name').sort({ date: 1, createdAt: 1 });
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
        mode: MODES.includes(req.body.receivedMode) ? req.body.receivedMode : 'Cash', bank: await pickBank(req.body.receivedBank), receivedBy: req.user._id,
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
      bank: amount > 0 ? await pickBank(req.body.bank) : undefined,
      reference: req.body.reference, note: req.body.note, receivedBy: req.user._id,
    });
    await recalcSale(sale);
    res.status(201).json({ message: amount ? `₹${amount} received` : `₹${discount} written off`, data: sale });
  })
);

// One amount from a customer for several sales (e.g. a person paying for all their firms).
// `allocations: [{ sale, amount, discount? }]` says how much goes to each sale; without it the
// amount clears the oldest pending sales first. Every part shares one receipt number.
router.post(
  '/receive',
  canCollect,
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!mongoose.isValidObjectId(b.customer)) throw new HttpError(400, 'Select a customer');
    const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const date = isDayKey(b.date) ? b.date : todayKey();
    if (date > todayKey()) throw new HttpError(400, 'Payment date cannot be in the future');
    const open = await Sale.find({ customer: b.customer, balance: { $gt: 0 } }).sort({ saleDate: 1, createdAt: 1 });
    if (!open.length) throw new HttpError(400, 'Nothing is pending for this customer');

    let parts;
    if (Array.isArray(b.allocations)) {
      parts = [];
      for (const a of b.allocations) {
        const amount = money(a.amount), discount = money(a.discount);
        if (amount < 0 || discount < 0) throw new HttpError(400, 'Amounts cannot be negative');
        if (amount + discount <= 0) continue;
        const sale = open.find((s) => String(s._id) === String(a.sale));
        if (!sale) throw new HttpError(400, 'A selected sale is not pending for this customer');
        if (parts.some((p) => p.sale === sale)) throw new HttpError(400, `Sale ${sale.saleNo} is selected twice`);
        if (amount + discount > sale.balance + 0.001) throw new HttpError(400, `Only ₹${sale.balance} is pending on ${sale.saleNo}`);
        parts.push({ sale, amount, discount });
      }
    } else {
      let left = money(b.amount);
      if (left <= 0) throw new HttpError(400, 'Enter the amount received');
      parts = [];
      for (const sale of open) {
        if (left <= 0) break;
        const amount = money(Math.min(left, sale.balance));
        parts.push({ sale, amount, discount: 0 });
        left = money(left - amount);
      }
      if (left > 0) throw new HttpError(400, `Only ₹${money(open.reduce((a, s) => a + s.balance, 0))} is pending for this customer`);
    }
    if (!parts.length) throw new HttpError(400, 'Enter the amount for at least one sale');
    const total = money(parts.reduce((a, p) => a + p.amount, 0));
    if (b.amount !== undefined && b.amount !== '' && money(b.amount) !== total) throw new HttpError(400, `Amount received (₹${money(b.amount)}) and the split over sales (₹${total}) do not match`);

    const receipt = await nextNumber('receipt', 'R');
    const mode = MODES.includes(b.mode) ? b.mode : 'Cash';
    const bank = total > 0 ? await pickBank(b.bank) : undefined;
    for (const p of parts) {
      await SalePayment.create({
        sale: p.sale._id, customer: b.customer, amount: p.amount, discount: p.discount, date, mode,
        bank: p.amount > 0 ? bank : undefined, reference: b.reference, note: b.note, receivedBy: req.user._id, receipt,
      });
      await recalcSale(p.sale);
    }
    res.status(201).json({ receipt, message: `₹${total} received (${receipt}) for ${parts.length} sale${parts.length === 1 ? '' : 's'}` });
  })
);

// Undo a whole receipt (all its parts).
router.delete(
  '/receipts/:receipt',
  canCollect,
  asyncHandler(async (req, res) => {
    const payments = await SalePayment.find({ receipt: req.params.receipt });
    if (!payments.length) throw new HttpError(404, 'Receipt not found');
    await SalePayment.deleteMany({ receipt: req.params.receipt });
    for (const id of new Set(payments.map((p) => String(p.sale)))) await recalcSale(id);
    res.json({ message: `Receipt ${req.params.receipt} removed` });
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

// ---------- import collection from Excel ----------

// Each row (date, amount, mode, sr no, name, service, partner, optional mobile / govt fee)
// becomes one sale for that amount plus its full payment. `dryRun` only checks the rows.
// The customer is found by business name or contact person (mobile decides when names
// repeat); with a mobile number an unknown name becomes a new customer. Mode is Cash /
// UPI / Bank / Cheque or the name of a Bank & Cash account. Partner: a B2B partner's name
// links that partner, "Self" or empty means none, anything else is saved as "Referred by".
// Rows already in the CRM (same customer, date, amount, sr no and work) are skipped.
const nameKey = (v) => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
const importPhone = (v) => {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};
function importDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isDayKey(s) ? s : null;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/); // day first, as written in India
  if (m) {
    const key = `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isDayKey(key) ? key : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000).toISOString().slice(0, 10); // Excel serial
  return null;
}

router.post(
  '/import',
  can('sales', 'create'),
  canCollect,
  asyncHandler(async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) throw new HttpError(400, 'The file has no rows');
    if (rows.length > 2000) throw new HttpError(400, 'Import at most 2000 rows at a time');
    const canAddCustomer = hasPermission(req, 'customers', 'create');
    const today = todayKey();

    const [customers, services, partners, banks] = await Promise.all([
      Customer.find().select('businessName contactPerson phone').lean(),
      Service.find().select('name').lean(),
      B2BPartner.find().select('name firmName percentage isActive').lean(),
      BankAccount.find({ active: true }).select('name kind').lean(),
    ]);
    // name key → list of customers; a key shared by several partners / services is ambiguous (null)
    const byName = new Map();
    for (const c of customers)
      for (const k of new Set([nameKey(c.businessName), nameKey(c.contactPerson)].filter(Boolean))) byName.set(k, [...(byName.get(k) || []), c]);
    const unique = (list, keysOf) => {
      const map = new Map();
      for (const x of list) for (const k of new Set(keysOf(x).map(nameKey).filter(Boolean))) map.set(k, map.has(k) ? null : x);
      return map;
    };
    const serviceBy = unique(services, (s) => [s.name]);
    const partnerBy = unique(partners.filter((p) => p.isActive), (p) => [p.name, p.firmName, p.firmName && `${p.name}${p.firmName}`]);
    const bankBy = unique(banks, (b) => [b.name]);
    const cashBank = banks.find((b) => b.kind === 'Cash');
    const MODE_WORDS = { cash: 'Cash', upi: 'UPI', bank: 'Bank', neft: 'Bank', rtgs: 'Bank', imps: 'Bank', cheque: 'Cheque', check: 'Cheque', chq: 'Cheque' };

    const parsed = [];
    const results = [];
    const dates = new Set();
    rows.forEach((r, i) => {
      const str = (v) => String(v ?? '').trim();
      const row = Number(r.row) || i + 2;
      const name = str(r.name).replace(/\s+/g, ' ');
      const date = importDate(r.date);
      const amount = Math.round((Number(String(r.amount ?? '').replace(/[₹,\s]/g, '')) || 0) * 100) / 100;
      const govt = Math.round((Number(String(r.govtFee ?? '').replace(/[₹,\s]/g, '')) || 0) * 100) / 100;
      const phone = importPhone(r.phone);
      const srNo = str(r.srNo);
      const work = str(r.service).replace(/\s+/g, ' ');
      const modeText = str(r.mode);
      const partnerText = str(r.partner).replace(/\s+/g, ' ');
      const out = { row, name, date, amount, srNo, service: work, status: 'ok', message: '' };
      results.push(out);
      const fail = (message) => Object.assign(out, { status: 'error', message });

      if (!name) return fail('Name is missing');
      if (!str(r.date)) return fail('Date is missing');
      if (!date) return fail(`Date "${str(r.date)}" is not a date (use DD/MM/YYYY)`);
      if (date > today) return fail('Date is in the future');
      if (!(amount > 0)) return fail(`Amount "${str(r.amount)}" is not a number above 0`);
      if (govt < 0 || govt > amount) return fail('Govt fee must be between 0 and the amount');
      if (!work) return fail('Service is missing');
      if (phone && !/^\d{10}$/.test(phone)) return fail(`Mobile "${str(r.phone)}" is not 10 digits`);

      // Mode: a payment mode word or a Bank & Cash account name
      let mode, bank;
      const word = MODE_WORDS[nameKey(modeText)];
      const account = modeText ? bankBy.get(nameKey(modeText)) : undefined;
      if (account) [mode, bank] = [account.kind === 'Cash' ? 'Cash' : 'Bank', account._id];
      else if (word) [mode, bank] = [word, word === 'Cash' ? cashBank?._id : undefined];
      else if (!modeText) mode = 'Cash';
      else return fail(account === null ? `More than one account is named "${modeText}"` : `No Bank & Cash account named "${modeText}" — add it there first`);

      // Customer
      const matches = byName.get(nameKey(name)) || [];
      let customer = matches.length === 1 && (!phone || matches[0].phone === phone) ? matches[0] : matches.find((c) => phone && c.phone === phone);
      if (!customer && matches.length > 1 && !phone) return fail(`${matches.length} customers are named "${name}" — add a Mobile column to pick one`);
      if (!customer && !phone) return fail('Customer not found — add them in Customers first, or add a Mobile column to create them');
      if (!customer && !canAddCustomer) return fail('Customer not found (you cannot add customers)');

      const partner = partnerText ? partnerBy.get(nameKey(partnerText)) : undefined;
      const self = !partnerText || ['self', 'own', 'direct', '-'].includes(partnerText.toLowerCase());
      if (partner === null) return fail(`More than one B2B partner is named "${partnerText}"`);

      dates.add(date);
      parsed.push({
        out, date, amount, govt, mode, bank, srNo, work, phone, name,
        customer, service: serviceBy.get(nameKey(work)) || undefined,
        partner: partner || undefined, referredBy: !partner && !self ? partnerText : '',
      });
    });

    // Skip rows already recorded (or repeated in the file)
    const existing = dates.size
      ? await SalePayment.find({ date: { $in: [...dates] } }).select('customer date amount reference sale').populate('sale', 'title').lean()
      : [];
    const dupKey = (customer, date, amount, ref, title) => [customer, date, amount, nameKey(ref), nameKey(title)].join('|');
    const seen = new Set(existing.map((p) => dupKey(p.customer, p.date, p.amount, p.reference, p.sale?.title)));
    const newCustomers = new Map(); // phone → customer created by this import
    const toCreate = [];
    for (const p of parsed) {
      const who = p.customer ? String(p.customer._id) : `new:${p.phone}`;
      const key = dupKey(who, p.date, p.amount, p.srNo, p.work);
      if (seen.has(key)) {
        Object.assign(p.out, { status: 'duplicate', message: 'Already in the CRM' });
        continue;
      }
      seen.add(key);
      if (!p.customer && !newCustomers.has(p.phone)) newCustomers.set(p.phone, null);
      p.out.message = [
        !p.customer && 'New customer',
        p.bank && banks.find((b) => String(b._id) === String(p.bank))?.name,
        p.partner ? `B2B partner ${p.partner.name}` : p.referredBy && `Referred by ${p.referredBy}`,
        !p.service && 'Service not in list — saved as text',
      ].filter(Boolean).join(' · ');
      toCreate.push(p);
    }

    const counts = { ok: toCreate.length, duplicate: results.filter((r) => r.status === 'duplicate').length, error: results.filter((r) => r.status === 'error').length };
    if (req.body.dryRun || !toCreate.length) return res.json({ dryRun: true, results, counts });

    const defaultBank = await pickBank();
    let total = 0;
    for (const p of toCreate) {
      let customer = p.customer;
      if (!customer) {
        customer = newCustomers.get(p.phone) || (await Customer.create({ businessName: p.name, phone: p.phone, addedBy: req.user._id }));
        newCustomers.set(p.phone, customer);
      }
      const sale = new Sale({
        saleNo: await nextNumber('sale', 'S'),
        customer: customer._id,
        service: p.service?._id,
        title: p.service?.name || p.work,
        saleDate: p.date,
        ...computeFees(p.amount - p.govt, p.govt),
        b2bPartner: p.partner?._id,
        b2bPercent: p.partner?.percentage || 0,
        referredBy: p.referredBy,
        notes: p.srNo ? `Sr No ${p.srNo} (imported)` : 'Imported',
        createdBy: req.user._id,
      });
      await sale.save();
      await SalePayment.create({
        sale: sale._id, customer: customer._id, amount: p.amount, date: p.date, mode: p.mode,
        bank: p.bank || defaultBank, reference: p.srNo, note: 'Imported from Excel', receivedBy: req.user._id,
      });
      await recalcSale(sale);
      total += p.amount;
    }
    const added = [...newCustomers.values()].filter(Boolean).length;
    res.status(201).json({
      dryRun: false,
      results,
      counts,
      message: `${toCreate.length} payment${toCreate.length === 1 ? '' : 's'} imported (₹${Math.round(total * 100) / 100})${added ? `, ${added} new customer${added === 1 ? '' : 's'}` : ''}`,
    });
  })
);

export default router;
