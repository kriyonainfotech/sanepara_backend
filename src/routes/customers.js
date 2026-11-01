import { Router } from 'express';
import { Customer } from '../models/Customer.js';
import { CustomerService } from '../models/CustomerService.js';
import { GstFiling } from '../models/GstFiling.js';
import { Service } from '../models/Service.js';
import { Task } from '../models/Task.js';
import { ScheduleItem } from '../models/ScheduleItem.js';
import { createItemsForAssignment } from '../services/scheduleSync.js';
import mongoose from 'mongoose';
import { Sale } from '../models/Sale.js';
import { SalePayment } from '../models/SalePayment.js';
import { User } from '../models/User.js';
import { Referral } from '../models/Referral.js';
import { B2BPartner } from '../models/B2BPartner.js';
import { nextNumber } from '../models/Counter.js';
import { buildSale, recalcSale } from '../services/sales.js';
import { creditIncentive } from '../services/incentive.js';
import { hasPermission } from '../middleware/auth.js';
import { protect, can } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { todayKey } from '../utils/dates.js';
import { GST_RE, cleanGstNumber, firmOf, gstsFrom } from '../utils/gst.js';

const router = Router();
router.use(protect);

const EDITABLE = ['businessName', 'contactPerson', 'phone', 'email', 'address', 'referredBy', 'referredByPartner', 'notes'];
const pick = (body) => {
  const out = Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]]));
  if ('referredByPartner' in out) out.referredByPartner = out.referredByPartner || null;
  if ('gsts' in body || 'gstNumber' in body) out.gsts = gstsFrom(body);
  return out;
};

// A GSTIN belongs to one customer only.
async function checkGstsFree(gsts, customerId) {
  if (!gsts?.length) return;
  const other = await Customer.findOne({ _id: { $ne: customerId }, 'gsts.gstNumber': { $in: gsts.map((g) => g.gstNumber) } }).select('businessName gsts').lean();
  if (!other) return;
  const taken = other.gsts.find((g) => gsts.some((x) => x.gstNumber === g.gstNumber));
  throw new HttpError(400, `GST number ${taken.gstNumber} is already with customer ${other.businessName}`);
}
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get(
  '/',
  can('customers', 'view'),
  asyncHandler(async (req, res) => {
    const filter = {};
    const q = req.query.q?.trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ businessName: rx }, { contactPerson: rx }, { phone: rx }, { 'gsts.gstNumber': rx }, { 'gsts.firmName': rx }];
    }
    const isId = (v) => /^[a-f\d]{24}$/i.test(v || '');
    if (isId(req.query.addedBy)) filter.addedBy = req.query.addedBy;
    const from = req.query.from && new Date(`${req.query.from}T00:00:00+05:30`);
    const to = req.query.to && new Date(`${req.query.to}T23:59:59.999+05:30`);
    if (from && !isNaN(from)) filter.createdAt = { ...filter.createdAt, $gte: from };
    if (to && !isNaN(to)) filter.createdAt = { ...filter.createdAt, $lte: to };
    // Each id filter narrows the allowed set of customers.
    const idSets = [];
    if (isId(req.query.service)) idSets.push(await CustomerService.distinct('customer', { service: req.query.service, status: { $ne: 'cancelled' } }));
    const gst = req.query.gst;
    if (gst === 'running' || gst === 'stopped') idSets.push(await GstFiling.distinct('customer', { isRunning: gst === 'running' }));
    else if (gst === 'has') filter['gsts.0'] = { $exists: true };
    else if (gst === 'none') filter['gsts.0'] = { $exists: false };
    else if (gst === 'multiple') filter['gsts.1'] = { $exists: true };
    if (idSets.length) filter._id = { $in: idSets.reduce((a, b) => a.filter((id) => b.some((x) => x.equals(id)))) };
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);

    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .populate('addedBy', 'name')
        .populate('referredByPartner', 'name firmName')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Customer.countDocuments(filter),
    ]);
    res.json({ customers, total, page, pages: Math.ceil(total / limit) || 1 });
  })
);

// Names only, for pickers (task forms, filters, daily task rules).
router.get(
  '/options',
  asyncHandler(async (_req, res) => {
    const customers = await Customer.find().select('businessName contactPerson gsts.gstNumber gsts.firmName gsts.ownerName').sort({ businessName: 1 }).lean();
    res.json({ data: customers });
  })
);

router.get(
  '/:id',
  can('customers', 'view'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id).populate('addedBy', 'name').populate('referredByPartner', 'name firmName');
    if (!customer) throw new HttpError(404, 'Customer not found');
    const services = await CustomerService.find({ customer: customer._id })
      .populate('service', 'name tasks price')
      .sort({ createdAt: -1 })
      .lean();
    const counts = await ScheduleItem.aggregate([
      { $match: { customerService: { $in: services.map((s) => s._id) }, status: { $ne: 'Cancelled' } } },
      { $group: { _id: '$customerService', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } }, scheduled: { $sum: { $cond: [{ $eq: ['$status', 'Scheduled'] }, 1, 0] } } } },
    ]);
    const byId = Object.fromEntries(counts.map((c) => [String(c._id), c]));
    // "Service billed or not": sales linked to each assigned service.
    const showSales = hasPermission(req, 'sales', 'view');
    const billed = showSales
      ? await Sale.aggregate([{ $match: { customerService: { $in: services.map((s) => s._id) } } }, { $group: { _id: '$customerService', amount: { $sum: '$totalAmount' }, balance: { $sum: '$balance' }, count: { $sum: 1 } } }])
      : [];
    const billedBy = Object.fromEntries(billed.map((b) => [String(b._id), b]));
    res.json({
      customer,
      services: services.map((s) => ({
        ...s,
        total: byId[s._id]?.total || 0,
        done: byId[s._id]?.done || 0,
        scheduled: byId[s._id]?.scheduled || 0,
        ...(showSales && { billing: billedBy[s._id] || null }),
      })),
    });
  })
);

// Account statement: sales (debit) and payments (credit) with running balance.
router.get(
  '/:id/ledger',
  can('sales', 'view'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id).select('businessName phone gstNumber gsts address').lean();
    if (!customer) throw new HttpError(404, 'Customer not found');
    const [sales, payments] = await Promise.all([
      Sale.find({ customer: customer._id }).populate('service', 'name').sort({ saleDate: 1, createdAt: 1 }).lean(),
      SalePayment.find({ customer: customer._id }).populate('sale', 'saleNo firmName gstNumber').sort({ date: 1, createdAt: 1 }).lean(),
    ]);
    // One amount split over several sales (a receipt) shows as one line, with what it paid.
    const paymentEntries = [];
    const byReceipt = new Map();
    for (const p of payments) {
      const part = { saleId: p.sale?._id, saleNo: p.sale?.saleNo, firmName: p.sale?.firmName, gstNumber: p.sale?.gstNumber, amount: p.amount, discount: p.discount, paymentId: p._id };
      if (p.receipt && byReceipt.has(p.receipt)) {
        const e = byReceipt.get(p.receipt);
        e.parts.push(part);
        e.amount += p.amount;
        e.discount += p.discount;
        e.credit += p.amount + p.discount;
        continue;
      }
      const e = { type: 'payment', date: p.date, at: p.createdAt, receipt: p.receipt, ref: p.receipt || p.sale?.saleNo, saleId: p.receipt ? undefined : p.sale?._id, paymentId: p._id, title: p.amount ? `Payment received (${p.mode})${p.reference ? ` · ${p.reference}` : ''}` : 'Discount / written off', debit: 0, credit: p.amount + p.discount, amount: p.amount, discount: p.discount, note: p.note, parts: [part] };
      if (p.receipt) byReceipt.set(p.receipt, e);
      paymentEntries.push(e);
    }
    const entries = [
      ...sales.map((s) => ({ type: 'sale', date: s.saleDate, at: s.createdAt, ref: s.saleNo, saleId: s._id, title: s.title, firmName: s.firmName, ownerName: s.ownerName, gstNumber: s.gstNumber, professionalFee: s.professionalFee, govtFee: s.govtFee, debit: s.totalAmount, credit: 0, status: s.status })),
      ...paymentEntries,
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.type === b.type ? new Date(a.at) - new Date(b.at) : a.type === 'sale' ? -1 : 1));
    let bal = 0;
    for (const e of entries) e.balance = Math.round((bal += e.debit - e.credit) * 100) / 100;
    const sum = (arr, k) => Math.round(arr.reduce((a, x) => a + (x[k] || 0), 0) * 100) / 100;
    // Firm-wise account: every GSTIN of the customer, plus work billed to the customer itself.
    const firms = [...(customer.gsts || []).map((g) => g.gstNumber), ''].map((gstNumber) => {
      const g = customer.gsts?.find((x) => x.gstNumber === gstNumber);
      const list = sales.filter((s) => (s.gstNumber || '') === gstNumber);
      return {
        gstNumber,
        firmName: g?.firmName || (gstNumber ? '' : customer.businessName),
        ownerName: g?.ownerName || '',
        sales: list.length,
        billed: sum(list, 'totalAmount'),
        received: sum(list, 'receivedAmount'),
        discount: sum(list, 'discountAmount'),
        outstanding: sum(list, 'balance'),
      };
    }).filter((f) => f.gstNumber || f.sales);
    res.json({
      customer,
      entries,
      firms,
      totals: {
        billed: sum(sales, 'totalAmount'),
        professional: sum(sales, 'professionalFee'),
        govt: sum(sales, 'govtFee'),
        received: sum(payments, 'amount'),
        discount: sum(payments, 'discount'),
        outstanding: Math.round(bal * 100) / 100,
      },
      sales,
    });
  })
);

// `addedBy` records which member added the customer.
router.post(
  '/',
  can('customers', 'create'),
  asyncHandler(async (req, res) => {
    const fields = pick(req.body);
    await checkGstsFree(fields.gsts);
    const customer = await Customer.create({ ...fields, addedBy: req.user._id });
    await customer.populate([{ path: 'addedBy', select: 'name' }, { path: 'referredByPartner', select: 'name firmName' }]);
    res.status(201).json({ customer });
  })
);

// Import old clients from an Excel / CSV sheet (parsed in the browser into `rows`).
// `dryRun` only checks the rows. Rows with an existing GST number, or the same mobile and
// business name as an existing customer, are skipped. A "GST filing" value also adds the
// customer to Running GST Filing. A "Referred by" value that matches one active B2B partner
// (name, firm name, or "Name — Firm") links that partner; anything else is kept as text.
const IMPORT_RETURN_TYPES = { monthly: 'Monthly', yes: 'Monthly', quarterly: 'Quarterly (QRMP)', qrmp: 'Quarterly (QRMP)', 'quarterly (qrmp)': 'Quarterly (QRMP)', composition: 'Composition' };
const cleanPhone = (v) => {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};

router.post(
  '/import',
  can('customers', 'create'),
  asyncHandler(async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) throw new HttpError(400, 'The file has no customer rows');
    if (rows.length > 2000) throw new HttpError(400, 'Import at most 2000 customers at a time');
    const canStartGst = hasPermission(req, 'gst_filing', 'manage');

    const existing = await Customer.find().select('businessName phone gsts.gstNumber').lean();
    const nameKey = (phone, name) => `${phone}|${name.toLowerCase().replace(/\s+/g, ' ')}`;
    const seenName = new Set(existing.map((c) => nameKey(c.phone, c.businessName)));
    const seenGst = new Set(existing.flatMap((c) => (c.gsts || []).map((g) => g.gstNumber)));
    const refKey = (v) => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
    const partnersByKey = new Map();
    for (const p of await B2BPartner.find({ isActive: true }).select('name firmName').lean()) {
      const keys = new Set([p.name, p.firmName, p.firmName && `${p.name}${p.firmName}`].map(refKey).filter(Boolean));
      for (const k of keys) partnersByKey.set(k, partnersByKey.has(k) ? null : p); // null = more than one partner, ambiguous
    }

    const results = [];
    const toCreate = [];
    rows.forEach((r, i) => {
      const str = (v) => String(v ?? '').trim();
      const c = {
        businessName: str(r.businessName).replace(/\s+/g, ' '),
        contactPerson: str(r.contactPerson),
        phone: cleanPhone(r.phone),
        email: str(r.email).toLowerCase(),
        gstNumber: cleanGstNumber(r.gstNumber),
        address: str(r.address),
        notes: str(r.notes),
      };
      const ref = str(r.referredBy);
      const partner = ref ? partnersByKey.get(refKey(ref)) : null;
      if (partner) c.referredByPartner = partner._id;
      else if (ref) c.referredBy = ref;
      const filing = str(r.gstFiling).toLowerCase();
      const returnType = filing && !['no', '-'].includes(filing) ? IMPORT_RETURN_TYPES[filing] : null;
      let status = 'ok';
      let message = '';
      if (!c.businessName) [status, message] = ['error', 'Business name is missing'];
      else if (!c.phone) [status, message] = ['error', 'Mobile number is missing'];
      else if (!/^\d{10}$/.test(c.phone)) [status, message] = ['error', `Mobile "${str(r.phone)}" is not 10 digits`];
      else if (c.gstNumber && !GST_RE.test(c.gstNumber)) [status, message] = ['error', `GST number "${c.gstNumber}" looks wrong`];
      else if (returnType === undefined) [status, message] = ['error', 'GST filing must be Monthly, Quarterly or Composition (or empty)'];
      else if (c.gstNumber && seenGst.has(c.gstNumber)) [status, message] = ['duplicate', 'GST number already in customers'];
      else if (seenName.has(nameKey(c.phone, c.businessName))) [status, message] = ['duplicate', 'Same business and mobile already in customers'];
      else {
        seenName.add(nameKey(c.phone, c.businessName));
        if (c.gstNumber) seenGst.add(c.gstNumber);
        toCreate.push({ c, returnType });
        message = [
          returnType && (canStartGst ? `GST filing: ${returnType}` : 'GST filing not started (no access)'),
          partner ? `Referred by B2B partner ${partner.name}` : ref && `Referred by ${ref}`,
        ].filter(Boolean).join(' · ');
      }
      results.push({ row: Number(r.row) || i + 2, businessName: c.businessName, phone: c.phone, gstNumber: c.gstNumber, status, message });
    });

    const counts = { ok: toCreate.length, duplicate: results.filter((r) => r.status === 'duplicate').length, error: results.filter((r) => r.status === 'error').length };
    if (req.body.dryRun || !toCreate.length) return res.json({ dryRun: true, results, counts });

    const docs = await Customer.insertMany(
      toCreate.map(({ c: { gstNumber, ...c } }) => ({ ...c, gsts: gstNumber ? [{ gstNumber, firmName: c.businessName, address: c.address }] : [], addedBy: req.user._id }))
    );
    const today = todayKey();
    const filings = canStartGst
      ? docs
          .map((d, i) => toCreate[i].returnType && { customer: d._id, gstNumber: d.gstNumber || '', firmName: d.gsts[0]?.firmName || '', returnType: toCreate[i].returnType, startedOn: today, addedBy: req.user._id, history: [{ action: 'Started', date: today, note: 'Imported from Excel', by: req.user._id }] })
          .filter(Boolean)
      : [];
    if (filings.length) await GstFiling.insertMany(filings);
    res.status(201).json({
      dryRun: false,
      results,
      counts,
      message: `${docs.length} customer${docs.length === 1 ? '' : 's'} imported${filings.length ? `, ${filings.length} added to Running GST Filing` : ''}`,
    });
  })
);

router.put(
  '/:id',
  can('customers', 'edit'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id);
    if (!customer) throw new HttpError(404, 'Customer not found');
    const fields = pick(req.body);
    await checkGstsFree(fields.gsts, customer._id);
    if (fields.gsts) {
      // A GSTIN with GST filing cannot be removed (remove its filing first).
      const filed = await GstFiling.findOne({ customer: customer._id, gstNumber: { $nin: ['', ...fields.gsts.map((g) => g.gstNumber)] } }).select('gstNumber').lean();
      if (filed) throw new HttpError(400, `GST number ${filed.gstNumber} is in Running GST Filing — remove it there first`);
    }
    customer.set(fields);
    await customer.save();
    // Filings keep the firm name of their GSTIN.
    // Filings, services and sales keep the firm / owner name of their GSTIN.
    for (const g of customer.gsts) {
      const where = { customer: customer._id, gstNumber: g.gstNumber };
      await Promise.all([
        GstFiling.updateMany(where, { firmName: g.firmName || '' }),
        CustomerService.updateMany(where, { firmName: g.firmName || '' }),
        Sale.updateMany(where, { firmName: g.firmName || '', ownerName: g.ownerName || '' }),
      ]);
    }
    await customer.populate([{ path: 'addedBy', select: 'name' }, { path: 'referredByPartner', select: 'name firmName' }]);
    res.json({ customer });
  })
);

router.delete(
  '/:id',
  can('customers', 'delete'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id);
    if (!customer) throw new HttpError(404, 'Customer not found');
    if (await Sale.exists({ customer: customer._id })) throw new HttpError(400, 'This customer has sales — delete those first');
    await customer.deleteOne();
    await Promise.all([
      CustomerService.deleteMany({ customer: customer._id }),
      ScheduleItem.deleteMany({ customer: customer._id }),
      Task.deleteMany({ client: customer._id }),
    ]);
    res.json({ message: 'Customer deleted' });
  })
);

// Assign a service — each of its tasks lands in Schedule Management as Unscheduled.
router.post(
  '/:id/services',
  can('services', 'assign'),
  asyncHandler(async (req, res) => {
    const [customer, service] = await Promise.all([
      Customer.findById(req.params.id),
      Service.findById(req.body.serviceId),
    ]);
    if (!customer) throw new HttpError(404, 'Customer not found');
    if (!service || !service.isActive) throw new HttpError(400, 'Select a valid service');
    const firm = firmOf(customer, req.body.gstNumber); // which of the customer's firms the work is for

    // Optional sale created with the assignment: fees, sold by, B2B partner, referral person, incentive.
    const s = req.body.sale;
    let saleData = null;
    let incentive = null;
    if (s) {
      if (!hasPermission(req, 'sales', 'create')) throw new HttpError(403, 'You do not have access to create sales');
      saleData = await buildSale({
        customer: customer._id,
        service: service._id,
        gstNumber: firm.gstNumber,
        title: s.title || service.name,
        professionalFee: s.professionalFee,
        govtFee: s.govtFee,
        saleDate: s.saleDate,
        soldBy: s.soldBy ?? String(req.user._id),
        b2bPartner: s.b2bPartner || '',
        b2bPercent: s.b2bPercent,
        referredBy: s.referredBy,
        referralAmount: s.referralAmount,
        notes: s.notes,
      });
      if (s.incentiveMember) {
        if (!hasPermission(req, 'incentives', 'manage')) throw new HttpError(403, 'You do not have access to give incentives');
        if (!(mongoose.isValidObjectId(s.incentiveMember) && (await User.exists({ _id: s.incentiveMember })))) throw new HttpError(400, 'Select a valid member for the incentive');
        const amount = Math.round((Number(s.incentive) || 0) * 100) / 100;
        if (amount < 0) throw new HttpError(400, 'Incentive cannot be negative');
        incentive = { member: s.incentiveMember, amount };
      }
    }

    const assignment = await CustomerService.create({
      customer: customer._id,
      service: service._id,
      assignedBy: req.user._id,
      gstNumber: firm.gstNumber,
      firmName: firm.firmName,
    });
    await createItemsForAssignment(assignment, service, req.user._id);
    await assignment.populate('service', 'name tasks');

    let sale = null;
    if (saleData) {
      sale = new Sale({ ...saleData, customerService: assignment._id, saleNo: await nextNumber('sale', 'S'), createdBy: req.user._id });
      await recalcSale(sale);
      if (incentive) await creditIncentive({ customer: customer._id, service: service._id, member: incentive.member, sale, amount: incentive.amount, by: req.user._id });
    }
    res.status(201).json({ assignment, sale });
  })
);

router.delete(
  '/:id/services/:assignmentId',
  can('services', 'assign'),
  asyncHandler(async (req, res) => {
    const assignment = await CustomerService.findOne({
      _id: req.params.assignmentId,
      customer: req.params.id,
    });
    if (!assignment) throw new HttpError(404, 'Assigned service not found');
    if (await ScheduleItem.exists({ customerService: assignment._id, status: { $in: ['Scheduled', 'Completed'] } }))
      throw new HttpError(400, 'Some of its work is already scheduled — remove those from Schedule Management first');

    // Its sale goes with it, unless money was already received on it.
    const sales = await Sale.find({ customerService: assignment._id });
    if (sales.length) {
      if (!hasPermission(req, 'sales', 'delete')) throw new HttpError(403, 'This service has a sale entry — you need permission to delete sales');
      if (await SalePayment.exists({ sale: { $in: sales.map((s) => s._id) } }))
        throw new HttpError(400, `Sale ${sales.map((s) => s.saleNo).join(', ')} has payments — remove its payments first`);
      // Incentive credited with the sale: one made by the sale is removed, an earlier referral goes back to pending.
      const refs = await Referral.find({ sale: { $in: sales.map((s) => s._id) } });
      for (const r of refs) {
        const sale = sales.find((s) => s._id.equals(r.sale));
        if (r.note === `Sale ${sale.saleNo}`) await r.deleteOne();
        else await Object.assign(r, { status: 'Pending', incentive: 0, sale: undefined, convertedOn: undefined }).save();
      }
      await Sale.deleteMany({ _id: { $in: sales.map((s) => s._id) } });
    }

    await ScheduleItem.deleteMany({ customerService: assignment._id });
    await assignment.deleteOne();
    res.json({ message: sales.length ? `Service and sale ${sales.map((s) => s.saleNo).join(', ')} removed` : 'Service removed' });
  })
);

export default router;
