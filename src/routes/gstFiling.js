import { Router } from 'express';
import mongoose from 'mongoose';
import { GstFiling } from '../models/GstFiling.js';
import { Customer } from '../models/Customer.js';
import { CustomerService } from '../models/CustomerService.js';
import { getSetting, setSetting } from '../models/Setting.js';
import { createGstWork } from '../jobs/gstWork.js';
import { protect, can } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';
import { periodLabel, prevMonthOf } from '../utils/periods.js';

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
      filter.customer = { $in: await Customer.find({ $or: [{ businessName: rx }, { phone: rx }, { gstNumber: rx }, { contactPerson: rx }] }).distinct('_id') };
    }
    const [data, running, stopped] = await Promise.all([
      populate(GstFiling.find(filter).sort({ isRunning: -1, updatedAt: -1 })),
      GstFiling.countDocuments({ isRunning: true }),
      GstFiling.countDocuments({ isRunning: false }),
    ]);
    const byType = await GstFiling.aggregate([{ $match: { isRunning: true } }, { $group: { _id: '$returnType', count: { $sum: 1 } } }]);
    res.json({ data, stats: { running, stopped, byType: Object.fromEntries(byType.map((t) => [t._id, t.count])) } });
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
    if (!mongoose.isValidObjectId(customer) || !(await Customer.exists({ _id: customer }))) throw new HttpError(400, 'Select a customer');
    if (await GstFiling.exists({ customer })) throw new HttpError(400, 'This customer is already in the GST filing list');
    const day = isDayKey(startedOn) ? startedOn : todayKey();
    const filing = await GstFiling.create({
      customer,
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
