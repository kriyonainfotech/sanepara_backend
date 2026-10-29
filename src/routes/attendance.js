import { Router } from 'express';
import mongoose from 'mongoose';
import { Attendance } from '../models/Attendance.js';
import { CalendarException } from '../models/CalendarException.js';
import { Task } from '../models/Task.js';
import { CLOCKING_ROLES, User } from '../models/User.js';
import { protect, can, hasPermission } from '../middleware/auth.js';
import { isDoneStatus } from '../services/taskStatus.js';
import { dayInfo, exceptionsBetween, istTime, isWorkingToday, recompute } from '../services/attendance.js';
import { monthBounds, summarize } from '../services/payroll.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const SHIFT_FIELDS = 'name role designation shiftStart shiftEnd fullDayHours halfDayHours monthlySalary joiningDate';

// Tasks that matter at clock-out: due today or earlier and not done.
async function openTasksFor(userId) {
  const tasks = await Task.find({ assignedTo: userId, dueDate: { $lte: todayKey() } })
    .select('title description status dueDate isDailyTask taskCategory pendingReasons client')
    .populate('client', 'businessName')
    .lean();
  const open = tasks.filter((t) => !isDoneStatus(t.status));
  const todayStart = new Date(`${todayKey()}T00:00:00+05:30`);
  return {
    daily: open.filter((t) => t.isDailyTask && t.dueDate === todayKey()),
    pending: open
      .filter((t) => !(t.isDailyTask && t.dueDate === todayKey()))
      .map((t) => ({ ...t, reasonGivenToday: (t.pendingReasons || []).some((p) => new Date(p.date) >= todayStart) })),
  };
}

// ---------- own attendance ----------

router.get(
  '/me/today',
  asyncHandler(async (req, res) => {
    const day = todayKey();
    const [record, info] = await Promise.all([Attendance.findOne({ user: req.user._id, date: day }), isWorkingToday()]);
    const u = req.user;
    res.json({
      today: day,
      now: istTime(),
      record,
      working: info.working,
      holiday: info.holiday?.description || (info.sunday && !info.working ? 'Sunday' : null),
      shift: { start: u.shiftStart, end: u.shiftEnd, fullDayHours: u.fullDayHours, halfDayHours: u.halfDayHours },
    });
  })
);

router.get(
  '/me/month',
  asyncHandler(async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : todayKey().slice(0, 7);
    const [from, to] = monthBounds(month);
    const [records, exceptions] = await Promise.all([
      Attendance.find({ user: req.user._id, date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean(),
      exceptionsBetween(from, to),
    ]);
    res.json({ month, records, exceptions, summary: summarize(req.user, month, records, exceptions) });
  })
);

router.post(
  '/clock-in',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'superadmin') throw new HttpError(403, 'Super Admins do not clock in.');
    const day = todayKey();
    const info = await isWorkingToday();
    if (!info.working) throw new HttpError(400, info.sunday ? 'Today is Sunday — the office is closed.' : `Today is a holiday${info.holiday?.description ? ` (${info.holiday.description})` : ''}.`);
    const existing = await Attendance.findOne({ user: req.user._id, date: day });
    if (existing?.inTime) throw new HttpError(400, 'You have already clocked in for today.');
    if (existing?.status === 'Leave') throw new HttpError(400, 'You are marked on leave today.');

    const record = existing || new Attendance({ user: req.user._id, date: day });
    record.inTime = istTime();
    record.status = 'Working';
    recompute(record, req.user);
    await record.save();
    res.json({ message: record.isLate ? `Clocked in — ${record.lateMinutes} min late` : 'Clocked in successfully!', record });
  })
);

// What stands between the member and clocking out.
router.get(
  '/clock-out/check',
  asyncHandler(async (req, res) => {
    res.json(await openTasksFor(req.user._id));
  })
);

router.post(
  '/clock-out',
  asyncHandler(async (req, res) => {
    const day = todayKey();
    const record = await Attendance.findOne({ user: req.user._id, date: day });
    if (!record?.inTime) throw new HttpError(400, 'You must clock in before clocking out.');
    if (record.outTime) throw new HttpError(400, 'You have already clocked out for today.');

    const { daily, pending } = await openTasksFor(req.user._id);
    if (daily.length)
      throw Object.assign(new HttpError(400, 'Complete your daily tasks before clocking out.'), { details: { daily: daily.map((t) => t.title) } });

    // Every still-pending task needs a reason today (given now or earlier today).
    const given = new Map(
      (Array.isArray(req.body.reasons) ? req.body.reasons : [])
        .filter((r) => mongoose.isValidObjectId(r.taskId) && r.reason?.trim())
        .map((r) => [String(r.taskId), r.reason.trim().slice(0, 500)])
    );
    const missing = pending.filter((t) => !t.reasonGivenToday && !given.has(String(t._id)));
    if (missing.length)
      throw Object.assign(new HttpError(400, 'Give a reason for every pending task before clocking out.'), { details: { missing: missing.map((t) => t.title) } });

    for (const t of pending) {
      if (!given.has(String(t._id))) continue;
      await Task.updateOne({ _id: t._id }, { $push: { pendingReasons: { reason: given.get(String(t._id)), updatedBy: req.user._id } } });
    }

    record.outTime = istTime();
    recompute(record, req.user);
    await record.save();
    res.json({ message: `Clocked out — ${record.totalHours} hrs, ${record.status}`, record });
  })
);

// ---------- calendar exceptions ----------

router.get(
  '/exceptions',
  asyncHandler(async (req, res) => {
    const year = /^\d{4}$/.test(req.query.year) ? req.query.year : todayKey().slice(0, 4);
    res.json({ data: await CalendarException.find({ date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }).sort({ date: 1 }) });
  })
);

router.post(
  '/exceptions',
  can('attendance', 'edit'),
  asyncHandler(async (req, res) => {
    const { date, type, description, isPaid } = req.body;
    if (!isDayKey(date)) throw new HttpError(400, 'Pick a date');
    if (!['Holiday', 'Working Sunday'].includes(type)) throw new HttpError(400, 'Unknown type');
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    if (type === 'Working Sunday' && !sunday) throw new HttpError(400, 'Only a Sunday can be a Working Sunday');
    if (type === 'Holiday' && sunday) throw new HttpError(400, 'Sunday is already a holiday');
    if (await CalendarException.exists({ date })) throw new HttpError(400, 'This date already has an override');
    res.status(201).json({ data: await CalendarException.create({ date, type, description, isPaid: isPaid !== false }) });
  })
);

router.delete(
  '/exceptions/:id',
  can('attendance', 'edit'),
  asyncHandler(async (req, res) => {
    const ex = await CalendarException.findByIdAndDelete(req.params.id);
    if (!ex) throw new HttpError(404, 'Not found');
    res.json({ message: 'Override removed' });
  })
);

// ---------- everyone's attendance (Attendance → View) ----------

// One day: every active member with their record.
router.get(
  '/day',
  can('attendance', 'view'),
  asyncHandler(async (req, res) => {
    const date = isDayKey(req.query.date) ? req.query.date : todayKey();
    const filter = { isActive: true, role: ['admin', 'team'].includes(req.query.role) ? req.query.role : { $in: CLOCKING_ROLES } };
    const [members, records, exceptions] = await Promise.all([
      User.find(filter).select(SHIFT_FIELDS).sort({ name: 1 }).lean(),
      Attendance.find({ date }).lean(),
      exceptionsBetween(date, date),
    ]);
    const byUser = Object.fromEntries(records.map((r) => [String(r.user), r]));
    res.json({ date, day: dayInfo(date, exceptions), rows: members.map((m) => ({ member: m, record: byUser[m._id] || null })) });
  })
);

// Month: per-day counts for the calendar + monthly report per member.
router.get(
  '/month',
  can('attendance', 'view'),
  asyncHandler(async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : todayKey().slice(0, 7);
    const [from, to] = monthBounds(month);
    const filter = { isActive: true, role: ['admin', 'team'].includes(req.query.role) ? req.query.role : { $in: CLOCKING_ROLES } };
    const members = await User.find(filter).select(SHIFT_FIELDS).sort({ name: 1 }).lean();
    const [records, exceptions] = await Promise.all([
      Attendance.find({ user: { $in: members.map((m) => m._id) }, date: { $gte: from, $lte: to } }).lean(),
      exceptionsBetween(from, to),
    ]);

    const days = {};
    for (const r of records) {
      const d = (days[r.date] ||= { present: 0, half: 0, absent: 0, leave: 0, late: 0 });
      if (r.status === 'Full Day' || r.status === 'Working') d.present++;
      else if (r.status === 'Half Day') d.half++;
      else if (r.status === 'Leave') d.leave++;
      else d.absent++;
      if (r.isLate) d.late++;
    }
    const byUser = {};
    for (const r of records) (byUser[r.user] ||= []).push(r);
    const report = members.map((m) => {
      const recs = (byUser[m._id] || []).sort((a, b) => a.date.localeCompare(b.date));
      const ins = recs.filter((r) => r.inTime).map((r) => r.inTime);
      const outs = recs.filter((r) => r.outTime).map((r) => r.outTime);
      const avg = (arr) => {
        if (!arr.length) return null;
        const mins = Math.round(arr.reduce((a, t) => a + Number(t.slice(0, 2)) * 60 + Number(t.slice(3)), 0) / arr.length);
        return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      };
      const s = summarize(m, month, recs, exceptions);
      return { member: m, summary: { ...s, earned: undefined, dailyRate: undefined, salary: undefined }, avgIn: avg(ins), avgOut: avg(outs) };
    });
    res.json({ month, days, exceptions, report });
  })
);

router.get(
  '/user/:id',
  asyncHandler(async (req, res) => {
    const own = String(req.params.id) === String(req.user._id);
    if (!own && !hasPermission(req, 'attendance', 'view') && !hasPermission(req, 'payroll', 'view'))
      throw new HttpError(403, 'You do not have access to this');
    const month = isMonth(req.query.month) ? req.query.month : todayKey().slice(0, 7);
    const [from, to] = monthBounds(month);
    const member = await User.findById(req.params.id).select(SHIFT_FIELDS).lean();
    if (!member) throw new HttpError(404, 'Member not found');
    const [records, exceptions] = await Promise.all([
      Attendance.find({ user: member._id, date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean(),
      exceptionsBetween(from, to),
    ]);
    const summary = summarize(member, month, records, exceptions);
    const showPay = own || hasPermission(req, 'payroll', 'view');
    res.json({ member: showPay ? member : { ...member, monthlySalary: undefined }, month, records, exceptions, summary: showPay ? summary : { ...summary, earned: undefined, salary: undefined, dailyRate: undefined } });
  })
);

// ---------- admin marking (Attendance → Edit) ----------

const STATUSES = ['Full Day', 'Half Day', 'Absent', 'Leave'];

router.post(
  '/mark',
  can('attendance', 'edit'),
  asyncHandler(async (req, res) => {
    const { userId, date, status } = req.body;
    if (!isDayKey(date)) throw new HttpError(400, 'Pick a date');
    if (date > todayKey()) throw new HttpError(400, 'Cannot mark attendance for future dates.');
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
    const member = await User.findById(userId);
    if (!member) throw new HttpError(404, 'Member not found');
    if (!CLOCKING_ROLES.includes(member.role)) throw new HttpError(400, 'Super Admins do not have attendance.');

    const record = (await Attendance.findOne({ user: member._id, date })) || new Attendance({ user: member._id, date });
    // Present without a clock-in: fill shift times so hours / lateness make sense.
    if ((status === 'Full Day' || status === 'Half Day') && !record.inTime) {
      record.inTime = member.shiftStart;
      record.outTime = member.shiftEnd;
    }
    recompute(record, member, { keepStatus: true });
    Object.assign(record, { status, manual: true, markedBy: req.user._id });
    await record.save();
    res.json({ message: `${member.name} marked ${status}`, record });
  })
);

router.put(
  '/:id',
  can('attendance', 'edit'),
  asyncHandler(async (req, res) => {
    const record = await Attendance.findById(req.params.id);
    if (!record) throw new HttpError(404, 'Record not found');
    const member = await User.findById(record.user);
    const { inTime, outTime, status, note } = req.body;
    const re = /^\d{2}:\d{2}$/;
    if (inTime !== undefined) record.inTime = re.test(inTime) ? inTime : undefined;
    if (outTime !== undefined) record.outTime = re.test(outTime) ? outTime : undefined;
    if (record.outTime && !record.inTime) throw new HttpError(400, 'Add a clock-in time first');
    if (note !== undefined) record.note = note;
    if (status) {
      if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
      recompute(record, member, { keepStatus: true });
      record.status = status;
    } else {
      recompute(record, member); // status follows the hours
      if (!record.inTime && record.status === 'Working') record.status = 'Absent';
    }
    Object.assign(record, { manual: true, markedBy: req.user._id, autoClockOut: false });
    await record.save();
    res.json({ message: 'Attendance updated', record });
  })
);

router.delete(
  '/:id',
  can('attendance', 'edit'),
  asyncHandler(async (req, res) => {
    const record = await Attendance.findByIdAndDelete(req.params.id);
    if (!record) throw new HttpError(404, 'Record not found');
    res.json({ message: 'Attendance cleared' });
  })
);

export default router;
