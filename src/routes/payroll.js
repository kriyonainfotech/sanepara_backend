import { Router } from 'express';
import mongoose from 'mongoose';
import { Attendance } from '../models/Attendance.js';
import { SalaryPayment } from '../models/SalaryPayment.js';
import { CLOCKING_ROLES, User } from '../models/User.js';
import { protect, can } from '../middleware/auth.js';
import { exceptionsBetween } from '../services/attendance.js';
import { monthBounds, summarize } from '../services/payroll.js';
import { incentivesByMember } from '../services/incentive.js';
import { pickBank } from '../services/banks.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);

// Payroll for a month: every member (not Super Admins) who had joined by month end.
router.get(
  '/',
  can('payroll', 'view'),
  asyncHandler(async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : todayKey().slice(0, 7);
    const [from, to] = monthBounds(month);
    const members = (await User.find({ isActive: true, role: { $in: CLOCKING_ROLES } }).select('name role designation monthlySalary joiningDate shiftStart shiftEnd fullDayHours halfDayHours createdAt').sort({ name: 1 }).lean())
      .filter((m) => !m.joiningDate || new Date(m.joiningDate).toISOString().slice(0, 10) <= to);
    const [records, exceptions, payments, incentives] = await Promise.all([
      Attendance.find({ user: { $in: members.map((m) => m._id) }, date: { $gte: from, $lte: to } }).lean(),
      exceptionsBetween(from, to),
      SalaryPayment.find({ month }).lean(),
      incentivesByMember(month),
    ]);
    const recsBy = {}, paidBy = {};
    for (const r of records) (recsBy[r.user] ||= []).push(r);
    for (const p of payments) paidBy[p.user] = (paidBy[p.user] || 0) + p.amount;

    const list = members.map((m) => {
      const s = summarize(m, month, recsBy[m._id] || [], exceptions);
      const paid = paidBy[m._id] || 0;
      // Incentive (converted referrals this month) is shown separately and added to the final total.
      const incentive = incentives[m._id] || 0;
      const total = s.earned + incentive;
      return { member: m, summary: s, incentive, total, paid, balance: Math.max(0, total - paid) };
    });
    const stats = {
      totalPayroll: list.reduce((a, r) => a + r.summary.salary, 0),
      earned: list.reduce((a, r) => a + r.summary.earned, 0),
      incentive: list.reduce((a, r) => a + r.incentive, 0),
      total: list.reduce((a, r) => a + r.total, 0),
      paid: list.reduce((a, r) => a + r.paid, 0),
      workingDays: list[0]?.summary.workingDays ?? 0,
    };
    stats.balance = Math.max(0, stats.total - stats.paid);
    res.json({ month, stats, list });
  })
);

router.get(
  '/payments',
  can('payroll', 'view'),
  asyncHandler(async (req, res) => {
    const filter = {};
    if (isMonth(req.query.month)) filter.month = req.query.month;
    if (mongoose.isValidObjectId(req.query.userId)) filter.user = req.query.userId;
    res.json({ data: await SalaryPayment.find(filter).populate('user', 'name').populate('paidBy', 'name').populate('bank', 'name').sort({ paidOn: -1, createdAt: -1 }) });
  })
);

router.post(
  '/payments',
  can('payroll', 'manage'),
  asyncHandler(async (req, res) => {
    const { userId, month, amount, paidOn, mode, note } = req.body;
    if (!mongoose.isValidObjectId(userId) || !(await User.exists({ _id: userId, role: { $in: CLOCKING_ROLES } }))) throw new HttpError(400, 'Select a member');
    if (!isMonth(month)) throw new HttpError(400, 'Select the salary month');
    if (!(Number(amount) > 0)) throw new HttpError(400, 'Enter an amount');
    const payment = await SalaryPayment.create({
      user: userId, month, amount: Number(amount), paidOn: isDayKey(paidOn) ? paidOn : todayKey(),
      mode: ['Cash', 'Bank', 'UPI', 'Cheque'].includes(mode) ? mode : 'Bank', bank: await pickBank(req.body.bank), note, paidBy: req.user._id,
    });
    res.status(201).json({ message: 'Salary payment recorded', data: payment });
  })
);

router.delete(
  '/payments/:id',
  can('payroll', 'manage'),
  asyncHandler(async (req, res) => {
    const p = await SalaryPayment.findByIdAndDelete(req.params.id);
    if (!p) throw new HttpError(404, 'Payment not found');
    res.json({ message: 'Payment removed' });
  })
);

export default router;
