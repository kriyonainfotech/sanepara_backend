import { Router } from 'express';
import mongoose from 'mongoose';
import { ScheduleItem } from '../models/ScheduleItem.js';
import { CustomerService } from '../models/CustomerService.js';
import { Task } from '../models/Task.js';
import { User } from '../models/User.js';
import { protect, can } from '../middleware/auth.js';
import { syncCustomerService, syncItemFromTask, revertItemForTask } from '../services/scheduleSync.js';
import { isDoneStatus } from '../services/taskStatus.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

// Service bunches are the unit of scheduling. A bunch is "unscheduled" while
// any of its items has no task, "scheduled" while it has open tasks, and
// "completed" when every item is done (a partly scheduled bunch counts as both
// unscheduled and scheduled).
const bunchState = (b) => ({
  unscheduled: b.unscheduled > 0,
  scheduled: b.scheduled > 0,
  completed: b.total > 0 && b.completed === b.total,
});

const groupItems = [
  { $match: { status: { $ne: 'Cancelled' }, customerService: { $ne: null } } },
  {
    $group: {
      _id: '$customerService',
      customer: { $first: '$customer' },
      total: { $sum: 1 },
      unscheduled: { $sum: { $cond: [{ $eq: ['$status', 'Unscheduled'] }, 1, 0] } },
      scheduled: { $sum: { $cond: [{ $eq: ['$status', 'Scheduled'] }, 1, 0] } },
      completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
    },
  },
];

router.get(
  '/analytics',
  can('schedule', 'view'),
  asyncHandler(async (_req, res) => {
    const bunches = await ScheduleItem.aggregate(groupItems);
    const states = bunches.map(bunchState);
    res.json({
      data: {
        totalServices: bunches.length,
        totalPending: states.filter((s) => s.unscheduled).length,
        totalScheduled: states.filter((s) => s.scheduled).length,
        totalCompleted: states.filter((s) => s.completed).length,
      },
    });
  })
);

// Per-customer service counts, with the customer's name for the left column.
router.get(
  '/summary',
  can('schedule', 'view'),
  asyncHandler(async (_req, res) => {
    const bunches = await ScheduleItem.aggregate(groupItems);
    const byCustomer = {};
    for (const b of bunches) {
      const s = bunchState(b);
      const c = (byCustomer[b.customer] ||= { _id: b.customer, total: 0, unscheduled: 0, scheduled: 0, completed: 0 });
      c.total++;
      if (s.unscheduled) c.unscheduled++;
      if (s.scheduled) c.scheduled++;
      if (s.completed) c.completed++;
    }
    const customers = await mongoose.model('Customer').find({ _id: { $in: Object.keys(byCustomer) } }).select('businessName contactPerson phone').lean();
    const data = customers
      .map((c) => ({ ...byCustomer[c._id], businessName: c.businessName, contactPerson: c.contactPerson, phone: c.phone }))
      .sort((a, b) => a.businessName.localeCompare(b.businessName));
    res.json({ data });
  })
);

// All service bunches of a customer with their items (and linked task info).
router.get(
  '/customer/:id',
  can('schedule', 'view'),
  asyncHandler(async (req, res) => {
    const [services, items] = await Promise.all([
      CustomerService.find({ customer: req.params.id, status: { $ne: 'cancelled' } }).populate('service', 'name').sort({ createdAt: -1 }).lean(),
      ScheduleItem.find({ customer: req.params.id, status: { $ne: 'Cancelled' } })
        .populate({ path: 'linkedTask', select: 'title status dueDate taskTime assignedTo completedAt', populate: { path: 'assignedTo', select: 'name' } })
        .sort({ order: 1 })
        .lean(),
    ]);
    const byBunch = {};
    for (const i of items) (byBunch[i.customerService] ||= []).push(i);
    const data = services
      .map((s) => {
        const its = byBunch[s._id] || [];
        const tasks = its.map((i) => i.linkedTask).filter(Boolean);
        const open = tasks.filter((t) => !isDoneStatus(t.status));
        const ref = open[0] || tasks[0];
        return {
          ...s,
          serviceName: [s.service?.name || its[0]?.postType || 'Service', s.periodLabel].filter(Boolean).join(' · '),
          items: its,
          total: its.length,
          unscheduled: its.filter((i) => i.status === 'Unscheduled').length,
          scheduled: its.filter((i) => i.status === 'Scheduled').length,
          completed: its.filter((i) => i.status === 'Completed').length,
          assignedTo: ref?.assignedTo || null,
          dueDate: ref?.dueDate || null,
          taskTime: ref?.taskTime || null,
          mixed: new Set(open.map((t) => `${t.assignedTo?._id}|${t.dueDate}`)).size > 1,
        };
      })
      .filter((b) => b.total > 0);
    res.json({ data });
  })
);

async function validateSchedule(body) {
  const { assignedTo, dueDate } = body;
  if (!mongoose.isValidObjectId(assignedTo) || !(await User.exists({ _id: assignedTo, isActive: true })))
    throw new HttpError(400, 'Select an active team member');
  if (!isDayKey(dueDate)) throw new HttpError(400, 'Please pick a date');
  if (dueDate < todayKey()) throw new HttpError(400, 'Date cannot be in the past');
  const taskTime = /^\d{2}:\d{2}$/.test(body.taskTime || '') ? body.taskTime : undefined;
  return { assignedTo, dueDate, taskTime };
}

const categoryFor = (name = '') => {
  const s = name.toLowerCase();
  if (s.includes('gst')) return 'GST';
  if (s.includes('itr') || s.includes('income tax')) return 'ITR';
  if (s.includes('trademark')) return 'Trademark';
  return 'General';
};

// Schedule a whole service: every unscheduled item becomes a task for one member on one day.
router.post(
  '/bunch/:id',
  can('schedule', 'manage'),
  asyncHandler(async (req, res) => {
    const cs = await CustomerService.findById(req.params.id).populate('service', 'name');
    if (!cs) throw new HttpError(404, 'Service not found');
    const { assignedTo, dueDate, taskTime } = await validateSchedule(req.body);
    const items = await ScheduleItem.find({ customerService: cs._id, status: 'Unscheduled' }).sort({ order: 1 });
    if (!items.length) throw new HttpError(400, 'Everything in this service is already scheduled');

    const category = categoryFor(cs.service?.name);
    const tasks = await Task.insertMany(
      items.map((i) => ({
        title: i.content,
        description: i.description,
        type: 'Team',
        status: 'Pending',
        dueDate,
        taskTime,
        taskCategory: category,
        assignedTo,
        createdBy: req.user._id,
        client: cs.customer,
        scheduleItem: i._id,
        customerService: cs._id,
        order: i.order,
      }))
    );
    for (const t of tasks) await syncItemFromTask(t);
    res.status(201).json({ message: `${tasks.length} tasks scheduled`, count: tasks.length });
  })
);

// Reschedule: move every open task of the service to a member / day.
router.put(
  '/bunch/:id',
  can('schedule', 'manage'),
  asyncHandler(async (req, res) => {
    const cs = await CustomerService.findById(req.params.id);
    if (!cs) throw new HttpError(404, 'Service not found');
    const { assignedTo, dueDate, taskTime } = await validateSchedule(req.body);
    const tasks = await Task.find({ customerService: cs._id });
    const open = tasks.filter((t) => !isDoneStatus(t.status));
    if (!open.length) throw new HttpError(400, 'No open tasks to reschedule');
    for (const t of open) {
      Object.assign(t, { assignedTo, dueDate, taskTime: taskTime ?? t.taskTime });
      await t.save();
      await syncItemFromTask(t);
    }
    res.json({ message: `${open.length} tasks rescheduled`, count: open.length });
  })
);

// Unschedule: remove the service's open tasks; their items go back to Unscheduled.
router.delete(
  '/bunch/:id',
  can('schedule', 'manage'),
  asyncHandler(async (req, res) => {
    const cs = await CustomerService.findById(req.params.id);
    if (!cs) throw new HttpError(404, 'Service not found');
    const open = (await Task.find({ customerService: cs._id })).filter((t) => !isDoneStatus(t.status));
    if (!open.length) throw new HttpError(400, 'No open tasks to unschedule');
    await Task.deleteMany({ _id: { $in: open.map((t) => t._id) } });
    for (const t of open) await revertItemForTask(t);
    res.json({ message: `${open.length} tasks unscheduled`, count: open.length });
  })
);

// Rename a single item inside a service (title follows onto its task).
router.put(
  '/:id',
  can('schedule', 'manage'),
  asyncHandler(async (req, res) => {
    const item = await ScheduleItem.findById(req.params.id);
    if (!item) throw new HttpError(404, 'Item not found');
    if (item.status === 'Completed') throw new HttpError(400, 'You cannot edit a completed item');
    const content = req.body.content?.trim();
    if (!content) throw new HttpError(400, 'Title is required');
    item.content = content;
    await item.save();
    if (item.linkedTask) await Task.findByIdAndUpdate(item.linkedTask, { title: content });
    res.json({ data: item });
  })
);

router.delete(
  '/:id',
  can('schedule', 'manage'),
  asyncHandler(async (req, res) => {
    const item = await ScheduleItem.findById(req.params.id);
    if (!item) throw new HttpError(404, 'Item not found');
    if (item.status === 'Completed') throw new HttpError(400, 'You cannot delete a completed item');
    if (item.linkedTask) await Task.findByIdAndDelete(item.linkedTask);
    await item.deleteOne();
    await syncCustomerService(item.customerService);
    res.json({ message: 'Item removed from the service' });
  })
);

export default router;
