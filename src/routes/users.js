import { Router } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Attendance } from '../models/Attendance.js';
import { Customer } from '../models/Customer.js';
import { Sale } from '../models/Sale.js';
import { SalePayment } from '../models/SalePayment.js';
import { Task } from '../models/Task.js';
import { CustomerService } from '../models/CustomerService.js';
import { protect, can, hasPermission, isSuperAdmin, superAdminOnly } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

const router = Router();
router.use(protect);

router.get(
  '/:id/activity',
  superAdminOnly,
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Member not found');
    const member = new mongoose.Types.ObjectId(req.params.id);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'Invalid activity offset');
    const pageSize = 10;
    const loadRemaining = req.query.remaining === 'true';
    const union = (model, pipeline) => ({ $unionWith: { coll: model.collection.name, pipeline } });
    const created = (actorField, action, title, extra = {}) => [
      { $match: { [actorField]: member } },
      { $project: { action: { $literal: action }, title, date: '$createdAt', ...extra } },
    ];
    const entries = await Task.aggregate([
      { $match: { $or: [{ createdBy: member }, { 'statusHistory.updatedBy': member }, { 'pendingReasons.updatedBy': member }] } },
      { $project: {
        title: 1,
        events: { $concatArrays: [
          { $cond: [{ $eq: ['$createdBy', member] }, [{ actor: member, action: 'Task created', date: '$createdAt' }], []] },
          { $map: { input: { $ifNull: ['$statusHistory', []] }, as: 'event', in: {
            actor: '$$event.updatedBy', action: { $concat: ['Task status: ', '$$event.status'] }, date: '$$event.updatedAt', note: '$$event.note',
          } } },
          { $map: { input: { $ifNull: ['$pendingReasons', []] }, as: 'event', in: {
            actor: '$$event.updatedBy', action: 'Pending reason added', date: '$$event.date', note: '$$event.reason',
          } } },
        ] },
      } },
      { $unwind: { path: '$events', includeArrayIndex: 'eventIndex' } },
      { $match: { 'events.actor': member } },
      { $project: { title: 1, eventIndex: 1, action: '$events.action', date: '$events.date', note: '$events.note' } },
      union(CustomerService, [
        { $match: { 'remarks.author': member } },
        { $unwind: { path: '$remarks', includeArrayIndex: 'eventIndex' } },
        { $match: { 'remarks.author': member } },
        { $project: { service: 1, customer: 1, periodLabel: 1, eventIndex: 1, action: { $literal: 'Service remark added' }, date: '$remarks.date', note: '$remarks.note' } },
      ]),
      union(CustomerService, created('assignedBy', 'Service assigned', '$firmName', { service: 1, customer: 1, periodLabel: 1 })),
      union(Customer, created('addedBy', 'Customer added', '$businessName')),
      union(User, created('createdBy', 'Team member added', '$name')),
      union(User, created('_id', 'Account created', '$name')),
      union(Sale, created('createdBy', 'Sale created', '$title')),
      union(SalePayment, created('receivedBy', 'Payment recorded', '$receipt', { customer: 1, amount: 1 })),
      union(Attendance, [
        { $match: { user: member, manual: { $ne: true } } },
        { $project: { events: [
          { action: 'Clocked in', date: '$clockIn' },
          { action: { $cond: ['$autoClockOut', 'Automatic clock-out', 'Clocked out'] }, date: '$clockOut' },
        ] } },
        { $unwind: { path: '$events', includeArrayIndex: 'eventIndex' } },
        { $project: { eventIndex: 1, action: '$events.action', date: '$events.date' } },
      ]),
      { $match: { date: { $type: 'date' } } },
      { $sort: { date: -1, _id: -1, action: 1, eventIndex: -1 } },
      { $skip: offset },
      ...(loadRemaining ? [] : [{ $limit: pageSize + 1 }]),
    ]);
    const hasMore = !loadRemaining && entries.length > pageSize;
    const page = loadRemaining ? entries : entries.slice(0, pageSize);
    await CustomerService.populate(page, [{ path: 'service', select: 'name' }, { path: 'customer', select: 'businessName' }]);
    res.json({
      entries: page.map(({ action, title, date, note, service, customer, periodLabel, amount }) => ({
        action, title: [title, service?.name, customer?.businessName, periodLabel].filter(Boolean).join(' · '), date, note, amount,
      })),
      nextOffset: hasMore ? offset + pageSize : null,
    });
  })
);

const EDITABLE = ['name', 'email', 'phone', 'role', 'designation', 'monthlySalary', 'joiningDate', 'isActive', 'shiftStart', 'shiftEnd', 'fullDayHours', 'halfDayHours'];

function checkShift(data) {
  const full = Number(data.fullDayHours ?? 8), half = Number(data.halfDayHours ?? 4);
  if (half > full) throw new HttpError(400, 'Half day hours cannot be more than full day hours');
}
const pick = (body) => Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]]));

// Only Super Admin can create or manage Admin / Super Admin accounts, so nobody
// can raise their own access through the Team page.
function guardRole(req, targetRole) {
  if (!isSuperAdmin(req.user) && targetRole && targetRole !== 'team')
    throw new HttpError(403, 'Only Super Admin can manage Admin and Super Admin accounts');
}

// Everyone can list members (needed for pickers like Schedule); full details
// such as salary only for those with Team Members → View.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = { deletedAt: null };
    if (req.query.role) filter.role = req.query.role;
    if (req.query.active === 'true') filter.isActive = true;
    const full = hasPermission(req, 'team', 'view');
    const users = await User.find(full ? filter : { ...filter, isActive: true })
      .select(full ? '' : 'name role designation')
      .sort({ createdAt: -1 });
    res.json({ users });
  })
);

router.post(
  '/',
  can('team', 'create'),
  asyncHandler(async (req, res) => {
    guardRole(req, req.body.role || 'team');
    if (!req.body.password || req.body.password.length < 6)
      throw new HttpError(400, 'Password must be at least 6 characters');
    if (await User.exists({ email: req.body.email?.toLowerCase().trim() }))
      throw new HttpError(400, 'A user with this email already exists');
    checkShift(req.body);
    const user = await User.create({ ...pick(req.body), password: req.body.password, createdBy: req.user._id });
    user.password = undefined;
    res.status(201).json({ user });
  })
);

router.put(
  '/:id',
  can('team', 'edit'),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, deletedAt: null });
    if (!user) throw new HttpError(404, 'User not found');
    guardRole(req, user.role);
    guardRole(req, req.body.role);
    if (user._id.equals(req.user._id) && req.body.isActive === false)
      throw new HttpError(400, 'You cannot disable your own account');
    if (user._id.equals(req.user._id) && req.body.role && req.body.role !== user.role)
      throw new HttpError(400, 'You cannot change your own role');

    Object.assign(user, pick(req.body));
    checkShift(user);
    if (req.body.password) {
      if (req.body.password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
      user.password = req.body.password;
    }
    await user.save();
    user.password = undefined;
    res.json({ user });
  })
);

// Removes a member from the CRM. Their past records stay (see User.deletedAt);
// the email is freed so it can be used for a new account.
router.delete(
  '/:id',
  can('team', 'delete'),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, deletedAt: null });
    if (!user) throw new HttpError(404, 'User not found');
    guardRole(req, user.role);
    if (user._id.equals(req.user._id)) throw new HttpError(400, 'You cannot delete your own account');
    user.isActive = false;
    user.deletedAt = new Date();
    user.email = `deleted-${user._id}-${user.email}`;
    await user.save();
    res.json({ message: `${user.name} deleted` });
  })
);

export default router;
