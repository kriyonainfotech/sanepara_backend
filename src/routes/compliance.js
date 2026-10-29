import { Router } from 'express';
import mongoose from 'mongoose';
import { ComplianceItem } from '../models/ComplianceItem.js';
import { CustomerService } from '../models/CustomerService.js';
import { GstFiling } from '../models/GstFiling.js';
import { getSetting, setSetting } from '../models/Setting.js';
import { COMPLIANCE_CATEGORIES, COMPLIANCE_RULES } from '../config/compliance.js';
import { protect, can } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { addDaysKey, isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const pad = (n) => String(n).padStart(2, '0');
const dateIn = (y, m, day) => `${y}-${pad(m)}-${pad(Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate()))}`;
const REPEAT_STEP = { none: 0, monthly: 1, quarterly: 3, yearly: 12 };

function* monthsBetween(from, to) {
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    yield [y, m];
    if (++m > 12) [y, m] = [y + 1, 1];
  }
}

// Every due date between `from` and `to` (both 'YYYY-MM-DD'): statutory ones with any moved
// date applied, plus the firm's own. GST ones carry how many running customers they concern
// and how far that period's GST work has got; once all of it is done they count as done.
async function occurrences(from, to) {
  const { overrides = {}, done = [], hiddenCategories = [] } = await getSetting('compliance');
  const doneSet = new Set(done);
  // Look a little outside the range so dates moved into it are found too.
  const lo = addDaysKey(from, -62);
  const hi = addDaysKey(to, 62);
  const out = [];

  for (const [y, m] of monthsBetween(lo.slice(0, 7), hi.slice(0, 7))) {
    for (const r of COMPLIANCE_RULES) {
      if (r.months && !r.months.includes(m)) continue;
      const original = dateIn(y, m, r.day);
      const id = `${r.key}:${original}`;
      out.push({
        id,
        builtIn: true,
        title: r.title,
        category: r.category,
        description: r.description,
        original,
        date: overrides[id] || original,
        period: r.period?.(original) || '',
        workPeriod: r.workPeriod?.(original) || null,
        appliesTo: r.appliesTo || null,
        done: doneSet.has(id),
      });
    }
  }

  const items = await ComplianceItem.find({ dueDate: { $lte: hi } }).populate('customer', 'businessName phone').lean();
  for (const it of items) {
    const step = REPEAT_STEP[it.repeat] || 0;
    const [y0, m0, d0] = it.dueDate.split('-').map(Number);
    for (let k = 0; ; k++) {
      const months = m0 - 1 + k * step;
      const date = dateIn(y0 + Math.floor(months / 12), (months % 12) + 1, d0);
      if (date > hi) break;
      if (date >= lo) {
        out.push({ id: `c:${it._id}:${date}`, builtIn: false, item: it, title: it.title, category: it.category, description: it.notes, original: date, date, customer: it.customer, done: it.completed.includes(date) });
      }
      if (!step) break;
    }
  }

  const list = out.filter((o) => o.date >= from && o.date <= to && !hiddenCategories.includes(o.category));
  const gst = list.filter((o) => o.appliesTo);
  if (gst.length) {
    const periods = [...new Set(gst.map((o) => o.workPeriod).filter(Boolean))];
    const [running, work] = await Promise.all([
      GstFiling.aggregate([{ $match: { isRunning: true } }, { $group: { _id: '$returnType', count: { $sum: 1 } } }]),
      periods.length
        ? CustomerService.aggregate([
            { $match: { period: { $in: periods }, status: { $ne: 'cancelled' } } },
            { $group: { _id: { period: '$period', type: '$gstReturnType' }, total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } },
          ])
        : [],
    ]);
    const count = Object.fromEntries(running.map((r) => [r._id, r.count]));
    for (const o of gst) {
      o.customers = o.appliesTo.reduce((a, t) => a + (count[t] || 0), 0);
      if (!o.workPeriod) continue;
      const rows = work.filter((w) => w._id.period === o.workPeriod && o.appliesTo.includes(w._id.type));
      const total = rows.reduce((a, w) => a + w.total, 0);
      if (!total) continue;
      o.progress = { total, completed: rows.reduce((a, w) => a + w.completed, 0) };
      if (o.progress.completed === total) o.done = o.autoDone = true;
    }
  }
  return list.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

// ?from=&to= (defaults to this month)
router.get(
  '/',
  can('compliance', 'view'),
  asyncHandler(async (req, res) => {
    const today = todayKey();
    const from = isDayKey(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = isDayKey(req.query.to) && req.query.to >= from ? req.query.to : addDaysKey(from, 41);
    if (addDaysKey(from, 400) < to) throw new HttpError(400, 'Pick a shorter date range');
    const { hiddenCategories = [] } = await getSetting('compliance');
    res.json({ today, categories: COMPLIANCE_CATEGORIES, hiddenCategories, data: await occurrences(from, to) });
  })
);

// Due-date alerts: anything missed in the last 30 days and everything due in the next 7.
// GST returns no running customer files are left out.
router.get(
  '/upcoming',
  can('compliance', 'view'),
  asyncHandler(async (_req, res) => {
    const today = todayKey();
    const open = (await occurrences(addDaysKey(today, -30), addDaysKey(today, 7))).filter((o) => !o.done && o.customers !== 0);
    res.json({ today, overdue: open.filter((o) => o.date < today), upcoming: open.filter((o) => o.date >= today) });
  })
);

function itemFields(b) {
  const customer = mongoose.isValidObjectId(b.customer) ? b.customer : undefined;
  if (!isDayKey(b.dueDate)) throw new HttpError(400, 'Pick the due date');
  return {
    title: String(b.title || '').trim(),
    category: COMPLIANCE_CATEGORIES.includes(b.category) ? b.category : 'Other',
    dueDate: b.dueDate,
    repeat: REPEAT_STEP[b.repeat] !== undefined ? b.repeat : 'none',
    customer,
    notes: String(b.notes || '').trim(),
  };
}

router.post(
  '/items',
  can('compliance', 'manage'),
  asyncHandler(async (req, res) => {
    const item = await ComplianceItem.create({ ...itemFields(req.body), createdBy: req.user._id });
    res.status(201).json({ message: 'Due date added', item });
  })
);

router.put(
  '/items/:id',
  can('compliance', 'manage'),
  asyncHandler(async (req, res) => {
    const { customer, ...fields } = itemFields(req.body);
    const item = await ComplianceItem.findByIdAndUpdate(req.params.id, customer ? { ...fields, customer } : { ...fields, $unset: { customer: 1 } }, { new: true, runValidators: true });
    if (!item) throw new HttpError(404, 'Due date not found');
    res.json({ message: 'Due date saved', item });
  })
);

router.delete(
  '/items/:id',
  can('compliance', 'manage'),
  asyncHandler(async (req, res) => {
    if (!(await ComplianceItem.findByIdAndDelete(req.params.id))) throw new HttpError(404, 'Due date not found');
    res.json({ message: 'Due date deleted' });
  })
);

// Splits an occurrence id: 'c:<itemId>:<date>' for the firm's own, '<ruleKey>:<date>' for statutory.
const parseId = (id = '') => {
  const parts = String(id).split(':');
  if (parts[0] === 'c' && parts.length === 3 && mongoose.isValidObjectId(parts[1]) && isDayKey(parts[2])) return { itemId: parts[1], date: parts[2] };
  if (parts.length === 2 && COMPLIANCE_RULES.some((r) => r.key === parts[0]) && isDayKey(parts[1])) return { rule: parts[0], date: parts[1] };
  throw new HttpError(400, 'Unknown due date');
};

router.post(
  '/done',
  can('compliance', 'manage'),
  asyncHandler(async (req, res) => {
    const { itemId, date } = parseId(req.body.id);
    const done = Boolean(req.body.done);
    if (itemId) {
      const item = await ComplianceItem.findByIdAndUpdate(itemId, done ? { $addToSet: { completed: date } } : { $pull: { completed: date } });
      if (!item) throw new HttpError(404, 'Due date not found');
    } else {
      const s = await getSetting('compliance');
      const set = new Set(s.done || []);
      done ? set.add(req.body.id) : set.delete(req.body.id);
      await setSetting('compliance', { ...s, done: [...set] }, req.user._id);
    }
    res.json({ message: done ? 'Marked done' : 'Marked not done' });
  })
);

// Categories the firm does not handle (e.g. TDS) can be hidden from the calendar and alerts.
router.put(
  '/settings',
  can('compliance', 'manage'),
  asyncHandler(async (req, res) => {
    const hiddenCategories = (Array.isArray(req.body.hiddenCategories) ? req.body.hiddenCategories : []).filter((c) => COMPLIANCE_CATEGORIES.includes(c));
    const s = await getSetting('compliance');
    await setSetting('compliance', { ...s, hiddenCategories }, req.user._id);
    res.json({ message: 'Calendar settings saved', hiddenCategories });
  })
);

// Move a statutory due date (government extension). `date: null` puts it back.
router.post(
  '/move',
  can('compliance', 'manage'),
  asyncHandler(async (req, res) => {
    const { rule } = parseId(req.body.id);
    if (!rule) throw new HttpError(400, 'Edit your own due dates instead');
    const s = await getSetting('compliance');
    const overrides = { ...(s.overrides || {}) };
    if (req.body.date == null || req.body.date === req.body.id.split(':')[1]) delete overrides[req.body.id];
    else if (isDayKey(req.body.date)) overrides[req.body.id] = req.body.date;
    else throw new HttpError(400, 'Pick the new due date');
    await setSetting('compliance', { ...s, overrides }, req.user._id);
    res.json({ message: overrides[req.body.id] ? 'Due date moved' : 'Due date set back to the regular date' });
  })
);

export default router;
