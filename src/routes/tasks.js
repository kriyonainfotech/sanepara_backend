import { Router } from 'express';
import mongoose from 'mongoose';
import { Task } from '../models/Task.js';
import { User } from '../models/User.js';
import { Customer } from '../models/Customer.js';
import { ScheduleItem } from '../models/ScheduleItem.js';
import { ChecklistTemplate } from '../models/ChecklistTemplate.js';
import { protect, can, hasPermission } from '../middleware/auth.js';
import { syncItemFromTask, revertItemForTask } from '../services/scheduleSync.js';
import { isDoneStatus, STATUSES } from '../services/taskStatus.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const deny = () => new HttpError(403, 'You do not have access to this');
const escapeRegex = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isOwn = (req, task) => String(task.assignedTo?._id || task.assignedTo) === String(req.user._id);

const populate = (q) =>
  q
    .populate('assignedTo', 'name email role designation')
    .populate('createdBy', 'name')
    .populate('client', 'businessName contactPerson phone email gstNumber address')
    .populate({ path: 'customerService', select: 'service status', populate: { path: 'service', select: 'name' } });

const EDITABLE = ['title', 'description', 'type', 'status', 'priority', 'dueDate', 'taskTime', 'taskCategory', 'assignedTo', 'client'];
const pick = (body) => Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k] === '' || body[k] === 'none' ? null : body[k]]));

const checklistFrom = async (templateId) => {
  if (!templateId || templateId === 'none' || !mongoose.isValidObjectId(templateId)) return null;
  const tpl = await ChecklistTemplate.findById(templateId);
  if (!tpl || !tpl.items.length) return null;
  return { template: tpl._id, items: tpl.items.map((text) => ({ text, isCompleted: false })) };
};

const assertChecklistDone = (task) => {
  if (task.checklist?.some((i) => !i.isCompleted))
    throw new HttpError(400, 'Please complete all checklist items before marking the task as Done.');
};

const monthRange = (day) => {
  const [y, m] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${day.slice(0, 7)}-01`, `${day.slice(0, 7)}-${String(last).padStart(2, '0')}`];
};

// Shared filters for the Tasks Management list and its calendar.
async function buildQuery(q) {
  const query = {};
  if (q.type && q.type !== 'all') query.type = q.type;
  if (q.client && q.client !== 'all' && mongoose.isValidObjectId(q.client)) query.client = q.client;
  if (q.assignedTo && q.assignedTo !== 'all' && mongoose.isValidObjectId(q.assignedTo)) query.assignedTo = q.assignedTo;
  if (q.status && q.status !== 'all') query.status = { $regex: `^${escapeRegex(q.status)}$`, $options: 'i' };
  if (q.search?.trim()) {
    const rx = { $regex: escapeRegex(q.search.trim()), $options: 'i' };
    const [users, clients] = await Promise.all([
      User.find({ $or: [{ name: rx }, { email: rx }] }).distinct('_id'),
      Customer.find({ businessName: rx }).distinct('_id'),
    ]);
    query.$or = [
      { title: rx }, { description: rx }, { taskCategory: rx }, { status: rx }, { priority: rx },
      { assignedTo: { $in: users } }, { createdBy: { $in: users } }, { client: { $in: clients } },
    ];
  }
  return query;
}

// Per-day totals + colour: red if anything overdue, green if all done, else yellow.
async function calendarFor(query, from, to) {
  const tasks = await Task.find({ ...query, dueDate: { $gte: from, $lte: to } }, 'dueDate status').lean();
  const today = todayKey();
  const data = {};
  for (const t of tasks) {
    const d = (data[t.dueDate] ||= { total: 0, completed: 0, color: '#eab308' });
    d.total++;
    const done = isDoneStatus(t.status);
    if (done) d.completed++;
    const overdue = !done && (String(t.status).toLowerCase() === 'overdue' || t.dueDate < today);
    if (overdue) d.color = '#ef4444';
    else if (d.completed === d.total) d.color = '#22c55e';
    else if (d.color !== '#ef4444') d.color = '#eab308';
  }
  return data;
}

// Tasks Management list (needs Tasks → View).
router.get(
  '/',
  can('tasks', 'view'),
  asyncHandler(async (req, res) => {
    const query = await buildQuery(req.query);
    const today = todayKey();
    const startDate = isDayKey(req.query.startDate) ? req.query.startDate : today;
    const endDate = isDayKey(req.query.endDate) ? req.query.endDate : startDate;
    const listQuery = { ...query, dueDate: { $gte: startDate, $lte: endDate } };
    const limit = Math.min(500, parseInt(req.query.limit) || 500);

    const [tasks, total] = await Promise.all([
      populate(Task.find(listQuery).sort({ dueDate: 1, createdAt: 1 }).limit(limit)),
      Task.countDocuments(listQuery),
    ]);
    res.json({ data: tasks, total });
  })
);

router.get(
  '/calendar',
  can('tasks', 'view'),
  asyncHandler(async (req, res) => {
    const query = await buildQuery(req.query);
    const [from, to] = monthRange(isDayKey(req.query.month) ? req.query.month : todayKey());
    res.json({ data: await calendarFor(query, from, to) });
  })
);

// Everything assigned to the logged-in member (Team "My Tasks").
router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const tasks = await populate(Task.find({ assignedTo: req.user._id }).sort({ dueDate: 1 }));
    res.json({ data: tasks, today: todayKey() });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await populate(Task.findById(req.params.id)).populate('statusHistory.updatedBy', 'name').populate('pendingReasons.updatedBy', 'name');
    if (!task) throw new HttpError(404, 'Task not found');
    if (!isOwn(req, task) && !hasPermission(req, 'tasks', 'view')) throw deny();
    res.json({ data: task });
  })
);

async function validateAssignee(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, 'Select who the task is for');
  const user = await User.findOne({ _id: id, isActive: true });
  if (!user) throw new HttpError(400, 'Select an active member');
  return user;
}

// Create. Scheduling a schedule item needs Schedule → Manage, other tasks Tasks → Create.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = pick(req.body);
    const itemId = req.body.scheduleItem;
    if (itemId ? !hasPermission(req, 'schedule', 'manage') : !hasPermission(req, 'tasks', 'create')) throw deny();

    data.assignedTo = data.assignedTo || String(req.user._id);
    await validateAssignee(data.assignedTo);
    if (!data.title?.trim()) throw new HttpError(400, 'Task title is required');
    if (!isDayKey(data.dueDate)) throw new HttpError(400, 'Please pick a due date');
    if (data.dueDate < todayKey()) throw new HttpError(400, 'Due date cannot be in the past');
    if (data.status && !STATUSES.includes(data.status)) data.status = 'Pending';

    let item;
    if (itemId) {
      item = await ScheduleItem.findById(itemId);
      if (!item) throw new HttpError(404, 'Schedule item not found');
      if (item.status !== 'Unscheduled') throw new HttpError(400, 'This item is already scheduled');
      data.client = item.customer;
      data.scheduleItem = item._id;
      data.customerService = item.customerService;
      data.order = item.order;
      data.type = 'Team';
    }

    const checklist = await checklistFrom(req.body.checklistTemplateId);
    const task = await Task.create({
      ...data,
      type: data.type || (data.client ? 'Team' : 'Personal'),
      createdBy: req.user._id,
      ...(checklist && { checklistTemplate: checklist.template, checklist: checklist.items, requiresChecklistCompletion: true }),
    });
    await syncItemFromTask(task);
    res.status(201).json({ data: await populate(Task.findById(task._id)) });
  })
);

router.post(
  '/bulk',
  can('tasks', 'create'),
  asyncHandler(async (req, res) => {
    const { tasks } = req.body;
    if (!Array.isArray(tasks) || !tasks.length) throw new HttpError(400, 'No tasks provided');
    if (tasks.length > 1000) throw new HttpError(400, 'Too many tasks at once');
    const today = todayKey();
    const prepared = [];
    for (const t of tasks) {
      const data = pick(t);
      if (!data.title?.trim() || !isDayKey(data.dueDate) || data.dueDate < today) throw new HttpError(400, 'Every task needs a title and a date from today onwards');
      prepared.push({ ...data, type: data.type || (data.client ? 'Team' : 'Personal'), createdBy: req.user._id });
    }
    await Promise.all([...new Set(prepared.map((p) => String(p.assignedTo)))].map(validateAssignee));
    const created = await Task.insertMany(prepared);
    res.status(201).json({ message: `${created.length} tasks created successfully`, count: created.length });
  })
);

// Tasks linked to a schedule item can also be managed by Schedule → Manage.
const canManageTask = (req, task, action) =>
  hasPermission(req, 'tasks', action) || (task.scheduleItem && hasPermission(req, 'schedule', 'manage'));

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await Task.findById(req.params.id);
    if (!task) throw new HttpError(404, 'Task not found');
    if (!canManageTask(req, task, 'edit')) throw deny();

    const data = pick(req.body);
    if (data.dueDate !== undefined && data.dueDate !== task.dueDate) {
      if (!isDayKey(data.dueDate)) throw new HttpError(400, 'Please pick a due date');
      if (data.dueDate < todayKey()) throw new HttpError(400, 'Due date cannot be in the past');
    }
    if (data.assignedTo && String(data.assignedTo) !== String(task.assignedTo)) await validateAssignee(data.assignedTo);
    if (data.assignedTo === null) delete data.assignedTo;
    if (task.scheduleItem) delete data.client; // stays with its customer
    if (data.status && isDoneStatus(data.status) && !isDoneStatus(task.status)) {
      assertChecklistDone(task);
      task.completedAt = new Date();
    }

    Object.assign(task, data);

    if ('checklistTemplateId' in req.body && String(req.body.checklistTemplateId || '') !== String(task.checklistTemplate || '')) {
      const checklist = await checklistFrom(req.body.checklistTemplateId);
      task.checklistTemplate = checklist?.template;
      task.checklist = checklist?.items || [];
      task.requiresChecklistCompletion = Boolean(checklist);
    }

    await task.save();
    await syncItemFromTask(task);
    res.json({ data: await populate(Task.findById(task._id)) });
  })
);

// Status change: the assignee, or anyone with Tasks → Edit.
router.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const { status, note } = req.body;
    const task = await Task.findById(req.params.id);
    if (!task) throw new HttpError(404, 'Task not found');
    if (!isOwn(req, task) && !canManageTask(req, task, 'edit')) throw deny();
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');

    if (isDoneStatus(status)) {
      assertChecklistDone(task);
      task.completedAt = new Date();
    } else {
      task.completedAt = undefined;
    }
    task.status = status;
    task.statusHistory.push({ status, note: (note || '').slice(0, 300), updatedBy: req.user._id });
    await task.save();
    await syncItemFromTask(task);
    res.json({ data: await populate(Task.findById(task._id)) });
  })
);

router.put(
  '/:id/checklist/:index',
  asyncHandler(async (req, res) => {
    const task = await Task.findById(req.params.id);
    if (!task) throw new HttpError(404, 'Task not found');
    if (!isOwn(req, task) && !canManageTask(req, task, 'edit')) throw deny();
    const i = parseInt(req.params.index);
    if (isNaN(i) || i < 0 || i >= task.checklist.length) throw new HttpError(400, 'Invalid item');
    const item = task.checklist[i];
    item.isCompleted = !item.isCompleted;
    item.completedAt = item.isCompleted ? new Date() : undefined;
    await task.save();
    res.json({ data: task });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await Task.findById(req.params.id);
    if (!task) throw new HttpError(404, 'Task not found');
    if (!canManageTask(req, task, 'delete')) throw deny();
    await task.deleteOne();
    await revertItemForTask(task);
    res.json({ message: 'Task deleted' });
  })
);

router.post(
  '/bulk/delete',
  can('tasks', 'delete'),
  asyncHandler(async (req, res) => {
    const ids = (req.body.taskIds || []).filter((id) => mongoose.isValidObjectId(id));
    if (!ids.length) throw new HttpError(400, 'No tasks selected');
    const tasks = await Task.find({ _id: { $in: ids } });
    await Task.deleteMany({ _id: { $in: ids } });
    for (const t of tasks) await revertItemForTask(t);
    res.json({ message: `${tasks.length} tasks deleted`, deletedCount: tasks.length });
  })
);

// Bulk change of status or due date.
router.put(
  '/bulk/update',
  can('tasks', 'edit'),
  asyncHandler(async (req, res) => {
    const ids = (req.body.taskIds || []).filter((id) => mongoose.isValidObjectId(id));
    const { status, dueDate } = req.body.updates || {};
    if (!ids.length) throw new HttpError(400, 'No tasks selected');
    if (status && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
    if (dueDate && (!isDayKey(dueDate) || dueDate < todayKey())) throw new HttpError(400, 'Pick a date from today onwards');
    if (!status && !dueDate) throw new HttpError(400, 'Nothing to update');

    const tasks = await Task.find({ _id: { $in: ids } });
    let skipped = 0;
    for (const t of tasks) {
      if (status) {
        if (isDoneStatus(status) && t.checklist?.some((c) => !c.isCompleted)) { skipped++; continue; }
        t.status = status;
        t.completedAt = isDoneStatus(status) ? new Date() : undefined;
        t.statusHistory.push({ status, note: 'Bulk update', updatedBy: req.user._id });
      }
      if (dueDate) t.dueDate = dueDate;
      await t.save();
      await syncItemFromTask(t);
    }
    res.json({
      message: `${tasks.length - skipped} tasks updated${skipped ? `, ${skipped} skipped (checklist not complete)` : ''}`,
      modifiedCount: tasks.length - skipped,
    });
  })
);

// Reasons for still-pending tasks, given at clock-out.
router.post(
  '/pending-reasons',
  asyncHandler(async (req, res) => {
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    for (const u of updates) {
      if (!u.reason?.trim() || !mongoose.isValidObjectId(u.taskId)) continue;
      await Task.updateOne(
        { _id: u.taskId, assignedTo: req.user._id },
        { $push: { pendingReasons: { reason: u.reason.trim().slice(0, 500), updatedBy: req.user._id } } }
      );
    }
    res.json({ message: 'Pending reasons saved' });
  })
);

export default router;
