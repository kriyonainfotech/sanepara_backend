import { Router } from 'express';
import mongoose from 'mongoose';
import { GstFiling } from '../models/GstFiling.js';
import { Customer } from '../models/Customer.js';
import { CustomerService } from '../models/CustomerService.js';
import { getSetting, setSetting } from '../models/Setting.js';
import { createGstWork } from '../jobs/gstWork.js';
import { protect, can } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { addDaysKey, isDayKey, todayKey } from '../utils/dates.js';
import { isQuarterly, periodEnd, periodLabel, prevMonthOf } from '../utils/periods.js';
import { COMPLIANCE_RULES } from '../config/compliance.js';
import { returnStatus } from '../services/gstReturns.js';
import { encrypt, decrypt } from '../utils/secretBox.js';

const router = Router();
router.use(protect);

const RETURN_TYPES = ['Monthly', 'Quarterly (QRMP)', 'Composition'];
const escapeRegex = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const populate = (q) =>
  q.populate('customer', 'businessName contactPerson phone gstNumber').populate('addedBy', 'name').populate('history.by', 'name');

// Customers whose GST filing the firm is doing. ?status=running|stopped
router.get(
  '/',
  can('gst_filing', 'view'),
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status === 'running') filter.isRunning = true;
    if (req.query.status === 'stopped') filter.isRunning = false;
    if (req.query.search?.trim()) {
      const rx = { $regex: escapeRegex(req.query.search.trim()), $options: 'i' };
      filter.$or = [
        { customer: { $in: await Customer.find({ $or: [{ businessName: rx }, { phone: rx }, { contactPerson: rx }] }).distinct('_id') } },
        { gstNumber: rx },
        { firmName: rx },
      ];
    }
    const [filings, running, stopped, withLogin] = await Promise.all([
      populate(GstFiling.find(filter).sort({ isRunning: -1, updatedAt: -1 })),
      GstFiling.countDocuments({ isRunning: true }),
      GstFiling.countDocuments({ isRunning: false }),
      GstFiling.find({ 'portalLogin.password': { $nin: [null, ''] } }).distinct('_id'),
    ]);
    const saved = new Set(withLogin.map(String));
    const data = filings.map((f) => ({ ...f.toObject(), hasLogin: saved.has(String(f._id)) }));
    const byType = await GstFiling.aggregate([{ $match: { isRunning: true } }, { $group: { _id: '$returnType', count: { $sum: 1 } } }]);
    res.json({ data, stats:{ running, stopped, byType: Object.fromEntries(byType.map((t) => [t._id, t.count])) } });
  })
);

// Monthly GST work: settings and how far this month's / quarter's work has got.
const lastQuarterOf = (day) => {
  const [y, m] = day.split('-').map(Number);
  const q = Math.floor((m - 1) / 3); // quarters fully over this year
  return q === 0 ? `${y - 1}-Q4` : `${y}-Q${q}`;
};

router.get(
  '/work',
  can('gst_filing', 'view'),
  asyncHandler(async (_req, res) => {
    const today = todayKey();
    const periods = [prevMonthOf(today), lastQuarterOf(today)];
    const counts = await CustomerService.aggregate([
      { $match: { period: { $in: periods }, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$period', total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } },
    ]);
    const by = Object.fromEntries(counts.map((c) => [c._id, c]));
    res.json({
      settings: await getSetting('gstWork'),
      periods: periods.map((p) => ({ period: p, label: periodLabel(p), quarterly: p.includes('Q'), total: by[p]?.total || 0, completed: by[p]?.completed || 0 })),
    });
  })
);

router.put(
  '/work',
  can('gst_filing', 'manage'),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const id = (v) => (mongoose.isValidObjectId(v) ? String(v) : '');
    const day = (v, d) => Math.min(Math.max(parseInt(v) || d, 1), 28);
    const value = { enabled: Boolean(b.enabled), serviceId: id(b.serviceId), assignTo: id(b.assignTo), createOnDay: day(b.createOnDay, 1), dueDay: day(b.dueDay, 10) };
    if (value.enabled && !value.serviceId) throw new HttpError(400, 'Choose the GST service to create every month');
    res.json({ message: 'Monthly GST work settings saved', settings: await setSetting('gstWork', value, req.user._id) });
  })
);

// GST Return Tracker: one row per customer with its GSTR-1 and GSTR-3B for a month (quarterly
// filers: the quarter that month is in). ?month=YYYY-MM&status=pending|filed&member=&search=
const RETURN_RULES = { Monthly: { gstr1: 'gstr1', gstr3b: 'gstr3b' }, 'Quarterly (QRMP)': { gstr1: 'gstr1q', gstr3b: 'gstr3bq' } };

router.get(
  '/tracker',
  can('gst_filing', 'view'),
  asyncHandler(async (req, res) => {
    const today = todayKey();
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '') ? req.query.month : prevMonthOf(today);
    const quarter = `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5)) / 3)}`;
    const periodOf = (type) => (isQuarterly(type) ? quarter : month);

    const [filings, work, { overrides = {} }] = await Promise.all([
      GstFiling.find().populate('customer', 'businessName contactPerson phone gstNumber').lean(),
      CustomerService.find({ gstFiling: { $exists: true }, period: { $in: [month, quarter] }, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).lean(),
      getSetting('compliance'),
    ]);
    const info = await returnStatus(work);

    // Due date of a return for the period, with any government extension from the Compliance Calendar.
    const dueOf = (type, period, kind) => {
      const rule = COMPLIANCE_RULES.find((r) => r.key === RETURN_RULES[type]?.[kind]);
      if (!rule) return null;
      const original = `${addDaysKey(periodEnd(period), 1).slice(0, 7)}-${String(rule.day).padStart(2, '0')}`;
      return overrides[`${rule.key}:${original}`] || original;
    };

    const rows = [];
    for (const f of filings) {
      if (!f.customer) continue;
      // Latest work of this filing for the period (the return type may have changed since).
      const cs = work.find((w) => String(w.gstFiling) === String(f._id) && w.period === periodOf(w.gstReturnType));
      const type = cs?.gstReturnType || f.returnType;
      const period = periodOf(type);
      if (!cs && (!f.isRunning || f.startedOn > periodEnd(period))) continue;
      const i = cs ? info.get(String(cs._id)) : null;
      const ret = (kind) => {
        if (!RETURN_RULES[type]) return { status: 'na' };
        const dueOn = dueOf(type, period, kind);
        if (!cs) return { status: 'nowork', dueOn };
        return { ...(i[kind] || { status: cs.status === 'completed' ? 'filed' : 'pending', fromWork: true }), dueOn };
      };
      const gstr1 = ret('gstr1');
      const gstr3b = ret('gstr3b');
      rows.push({
        filingId: f._id,
        customer: f.customer,
        gstNumber: f.gstNumber,
        firmName: f.firmName,
        returnType: type,
        isRunning: f.isRunning,
        period,
        periodLabel: periodLabel(period),
        work: cs ? { _id: cs._id, status: cs.status, steps: i.steps } : null,
        members: i?.members || [],
        gstr1,
        gstr3b,
        done: cs ? (RETURN_RULES[type] ? [gstr1, gstr3b].every((r) => r.status === 'filed') : cs.status === 'completed') : false,
      });
    }

    let list = rows;
    if (mongoose.isValidObjectId(req.query.member)) list = list.filter((r) => r.members.some((m) => String(m._id) === req.query.member));
    if (req.query.search?.trim()) {
      const q = req.query.search.trim().toLowerCase();
      list = list.filter((r) => [r.customer.businessName, r.gstNumber, r.firmName, r.customer.phone, r.customer.contactPerson].some((v) => v?.toLowerCase().includes(q)));
    }
    const applies = list.filter((r) => RETURN_RULES[r.returnType]);
    const stats = {
      total: list.length,
      done: list.filter((r) => r.done).length,
      noWork: list.filter((r) => !r.work).length,
      returns: applies.length,
      gstr1Filed: applies.filter((r) => r.gstr1.status === 'filed').length,
      gstr3bFiled: applies.filter((r) => r.gstr3b.status === 'filed').length,
    };
    if (req.query.status === 'pending') list = list.filter((r) => !r.done);
    if (req.query.status === 'filed') list = list.filter((r) => r.done);
    list.sort((a, b) => a.done - b.done || a.customer.businessName.localeCompare(b.customer.businessName) || a.gstNumber.localeCompare(b.gstNumber));

    res.json({ today, month, monthLabel: periodLabel(month), quarter, quarterLabel: periodLabel(quarter), stats, data: list });
  })
);

// Create this month's work now instead of waiting for the set day.
router.post(
  '/work/run',
  can('gst_filing', 'manage'),
  asyncHandler(async (req, res) => {
    const { created, startedLater } = await createGstWork({ manual: true, userId: req.user._id });
    const later = startedLater ? `${startedLater} customer${startedLater === 1 ? '' : 's'} started filing after that period and will get work from the next one` : '';
    const message = created ? `GST work created for ${created} customer${created === 1 ? '' : 's'}${later ? `. ${later}` : ''}` : later ? `No new work: ${later}` : 'Every running customer already has this period’s GST work';
    res.json({ created, message });
  })
);

router.post(
  '/',
  can('gst_filing', 'manage'),
  asyncHandler(async (req, res) => {
    const { customer, returnType, startedOn, notes } = req.body;
    const c = mongoose.isValidObjectId(customer) ? await Customer.findById(customer).select('gsts').lean() : null;
    if (!c) throw new HttpError(400, 'Select a customer');
    // One filing per GSTIN of the customer; a customer without any GSTIN saved can have one filing.
    const gstNumber = String(req.body.gstNumber || '').toUpperCase().trim();
    const gst = c.gsts?.find((g) => g.gstNumber === gstNumber);
    if (c.gsts?.length ? !gst : gstNumber) throw new HttpError(400, 'Select one of the customer’s GST numbers');
    if (await GstFiling.exists({ customer, gstNumber })) throw new HttpError(400, gstNumber ? `${gstNumber} is already in the GST filing list` : 'This customer is already in the GST filing list');
    const day = isDayKey(startedOn) ? startedOn : todayKey();
    const filing = await GstFiling.create({
      customer,
      gstNumber,
      firmName: gst?.firmName || '',
      returnType: RETURN_TYPES.includes(returnType) ? returnType : 'Monthly',
      startedOn: day,
      notes,
      addedBy: req.user._id,
      history: [{ action: 'Started', date: day, by: req.user._id }],
    });
    res.status(201).json({ message: 'GST filing started', data: await populate(GstFiling.findById(filing._id)) });
  })
);

router.put(
  '/:id',
  can('gst_filing', 'manage'),
  asyncHandler(async (req, res) => {
    const filing = await GstFiling.findById(req.params.id);
    if (!filing) throw new HttpError(404, 'Not found');
    if (RETURN_TYPES.includes(req.body.returnType)) filing.returnType = req.body.returnType;
    if (req.body.notes !== undefined) filing.notes = req.body.notes;
    await filing.save();
    res.json({ message: 'Saved', data: await populate(GstFiling.findById(filing._id)) });
  })
);

// GST portal login of the customer. Needs GST Filing → GST portal login.
router.get(
  '/:id/login',
  can('gst_filing', 'credentials'),
  asyncHandler(async (req, res) => {
    const filing = await GstFiling.findById(req.params.id).select('+portalLogin').populate('portalLogin.updatedBy', 'name');
    if (!filing) throw new HttpError(404, 'Not found');
    const l = filing.portalLogin || {};
    const password = decrypt(l.password);
    res.json({
      data: { username: l.username || '', password: password || '', unreadable: password === null, updatedAt: l.updatedAt, updatedBy: l.updatedBy?.name },
    });
  })
);

router.put(
  '/:id/login',
  can('gst_filing', 'credentials'),
  asyncHandler(async (req, res) => {
    const filing = await GstFiling.findById(req.params.id).select('+portalLogin');
    if (!filing) throw new HttpError(404, 'Not found');
    const username = String(req.body.username || '').trim().slice(0, 100);
    const password = String(req.body.password || '').slice(0, 100);
    filing.portalLogin = username || password ? { username, password: encrypt(password), updatedAt: new Date(), updatedBy: req.user._id } : undefined;
    await filing.save();
    res.json({ message: username || password ? 'GST login saved' : 'GST login removed' });
  })
);

// Stop or resume filing, keeping a history of every change.
for (const [path, running, action] of [['stop', false, 'Stopped'], ['resume', true, 'Resumed']]) {
  router.post(
    `/:id/${path}`,
    can('gst_filing', 'manage'),
    asyncHandler(async (req, res) => {
      const filing = await GstFiling.findById(req.params.id);
      if (!filing) throw new HttpError(404, 'Not found');
      if (filing.isRunning === running) throw new HttpError(400, running ? 'Filing is already running' : 'Filing is already stopped');
      const day = isDayKey(req.body.date) ? req.body.date : todayKey();
      filing.isRunning = running;
      filing.stoppedOn = running ? undefined : day;
      filing.history.push({ action, date: day, note: req.body.note, by: req.user._id });
      await filing.save();
      res.json({ message: `GST filing ${action.toLowerCase()}`, data: await populate(GstFiling.findById(filing._id)) });
    })
  );
}

router.delete(
  '/:id',
  can('gst_filing', 'manage'),
  asyncHandler(async (req, res) => {
    const filing = await GstFiling.findByIdAndDelete(req.params.id);
    if (!filing) throw new HttpError(404, 'Not found');
    res.json({ message: 'Removed from GST filing list' });
  })
);

export default router;
