import { Router } from 'express';
import mongoose from 'mongoose';
import { DailyTaskRule } from '../models/DailyTaskRule.js';
import { User } from '../models/User.js';
import { protect, can } from '../middleware/auth.js';
import { generateForRule } from '../jobs/dailyTaskScheduler.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey } from '../utils/dates.js';

const router = Router();
router.use(protect, can('tasks', 'rituals'));

const populate = (q) =>
  q.populate('assignedTo', 'name role').populate('clients', 'businessName').populate('checklistTemplate', 'title items');

async function clean(b) {
  const data = {
    title: b.title?.trim(),
    description: b.description?.trim() || '',
    assignedTo: b.assignedTo,
    frequency: ['Daily', 'Weekly', 'Monthly', 'Yearly'].includes(b.frequency) ? b.frequency : 'Daily',
    daysOfWeek: (Array.isArray(b.daysOfWeek) ? b.daysOfWeek : []).map(Number).filter((d) => d >= 0 && d <= 6),
    dateOfMonth: b.dateOfMonth ? Number(b.dateOfMonth) : undefined,
    monthOfYear: b.monthOfYear ? Number(b.monthOfYear) : undefined,
    isChecklistTask: Boolean(b.isChecklistTask),
    checklistTemplate: mongoose.isValidObjectId(b.checklistTemplate) ? b.checklistTemplate : null,
    customChecklist: (Array.isArray(b.customChecklist) ? b.customChecklist : []).map((s) => String(s).trim()).filter(Boolean),
    clients: (Array.isArray(b.clients) ? b.clients : []).filter((id) => mongoose.isValidObjectId(id)),
    isActive: b.isActive !== false,
  };
  if (!data.title) throw new HttpError(400, 'Please add a title');
  if (!mongoose.isValidObjectId(data.assignedTo) || !(await User.exists({ _id: data.assignedTo, isActive: true })))
    throw new HttpError(400, 'Please select who the task is for');
  if (data.frequency === 'Weekly' && !data.daysOfWeek.length) throw new HttpError(400, 'Select at least one day of the week');
  if (['Monthly', 'Yearly'].includes(data.frequency) && !(data.dateOfMonth >= 1 && data.dateOfMonth <= 31))
    throw new HttpError(400, 'Enter a date between 1 and 31');
  if (data.frequency === 'Yearly' && !(data.monthOfYear >= 1 && data.monthOfYear <= 12)) throw new HttpError(400, 'Select a month');
  // Checklist rules may also have customers (one checklist task per customer); for them customers are optional.
  if (data.isChecklistTask) {
    if (!data.checklistTemplate && !data.customChecklist.length)
      throw new HttpError(400, 'Select a checklist template or add custom checklist items');
  } else if (!data.clients.length) {
    throw new HttpError(400, 'Please select at least 1 customer');
  }
  return data;
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await populate(DailyTaskRule.find().sort({ createdAt: -1 })) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const rule = await DailyTaskRule.create({ ...(await clean(req.body)), createdBy: req.user._id });
    res.status(201).json({ data: rule });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const rule = await DailyTaskRule.findById(req.params.id);
    if (!rule) throw new HttpError(404, 'Rule not found');
    Object.assign(rule, await clean(req.body));
    await rule.save();
    res.json({ data: rule });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const rule = await DailyTaskRule.findByIdAndDelete(req.params.id);
    if (!rule) throw new HttpError(404, 'Rule not found');
    res.json({ message: 'Rule deleted' });
  })
);

// Generate the rule's tasks for a chosen date right now.
router.post(
  '/:id/trigger',
  asyncHandler(async (req, res) => {
    const { targetDate } = req.body;
    if (!isDayKey(targetDate)) throw new HttpError(400, 'Please pick a date');
    const rule = await DailyTaskRule.findById(req.params.id);
    if (!rule) throw new HttpError(404, 'Rule not found');
    if (!rule.isActive) throw new HttpError(400, 'Cannot trigger an inactive rule');
    const created = await generateForRule(rule, targetDate, req.user._id);
    res.json({ message: `Generated ${created} task${created === 1 ? '' : 's'} for ${targetDate}` });
  })
);

export default router;
