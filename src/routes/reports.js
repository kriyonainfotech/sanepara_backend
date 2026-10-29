import { Router } from 'express';
import { Sale } from '../models/Sale.js';
import { Service } from '../models/Service.js';
import { Task } from '../models/Task.js';
import { Attendance } from '../models/Attendance.js';
import { Customer } from '../models/Customer.js';
import { Referral } from '../models/Referral.js';
import { User } from '../models/User.js';
import { protect, can } from '../middleware/auth.js';
import { monthBounds } from '../services/payroll.js';
import { isDoneStatus } from '../services/taskStatus.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Service matrix: every service × month of the year — how many times it was sold, and for how much.
router.get(
  '/service-matrix',
  can('reports', 'view'),
  asyncHandler(async (req, res) => {
    const year = /^\d{4}$/.test(req.query.year) ? req.query.year : todayKey().slice(0, 4);
    const [rows, services] = await Promise.all([
      Sale.aggregate([
        { $match: { saleDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } } },
        { $group: { _id: { service: '$service', month: { $substrBytes: ['$saleDate', 5, 2] } }, count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } },
      ]),
      Service.find().select('name isActive').sort({ name: 1 }).lean(),
    ]);
    const blank = () => Array.from({ length: 12 }, () => ({ count: 0, amount: 0 }));
    const byService = {};
    for (const r of rows) {
      const key = r._id.service ? String(r._id.service) : 'none';
      const cell = (byService[key] ||= blank())[Number(r._id.month) - 1];
      cell.count += r.count;
      cell.amount = r2(cell.amount + r.amount);
    }
    const line = (id, name, isActive = true) => {
      const months = byService[id] || blank();
      return { id, name, isActive, months, count: months.reduce((a, m) => a + m.count, 0), amount: r2(months.reduce((a, m) => a + m.amount, 0)) };
    };
    const data = services.map((s) => line(String(s._id), s.name, s.isActive));
    if (byService.none) data.push(line('none', 'Other (no service linked)'));
    const totals = Array.from({ length: 12 }, (_, i) => ({ count: data.reduce((a, s) => a + s.months[i].count, 0), amount: r2(data.reduce((a, s) => a + s.months[i].amount, 0)) }));
    res.json({ year, data, totals, grand: { count: totals.reduce((a, m) => a + m.count, 0), amount: r2(totals.reduce((a, m) => a + m.amount, 0)) } });
  })
);

// Team performance for a month: tasks, attendance, sales, referrals, customers added.
router.get(
  '/team-performance',
  can('reports', 'view'),
  asyncHandler(async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : todayKey().slice(0, 7);
    const [from, to] = monthBounds(month);
    const today = todayKey();
    const members = await User.find({ isActive: true }).select('name role designation').sort({ name: 1 }).lean();
    const ids = members.map((m) => m._id);
    const [tasks, attendance, sales, referrals, customers] = await Promise.all([
      Task.find({ assignedTo: { $in: ids }, dueDate: { $gte: from, $lte: to } }).select('assignedTo status dueDate').lean(),
      Attendance.find({ user: { $in: ids }, date: { $gte: from, $lte: to } }).select('user status isLate').lean(),
      Sale.aggregate([{ $match: { soldBy: { $in: ids }, saleDate: { $gte: from, $lte: to } } }, { $group: { _id: '$soldBy', count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }]),
      Referral.aggregate([{ $match: { referredBy: { $in: ids }, status: 'Converted', convertedOn: { $gte: from, $lte: to } } }, { $group: { _id: '$referredBy', count: { $sum: 1 }, incentive: { $sum: '$incentive' } } }]),
      Customer.aggregate([
        { $match: { addedBy: { $in: ids }, createdAt: { $gte: new Date(`${from}T00:00:00+05:30`), $lte: new Date(`${to}T23:59:59.999+05:30`) } } },
        { $group: { _id: '$addedBy', count: { $sum: 1 } } },
      ]),
    ]);
    const idx = (arr) => Object.fromEntries(arr.map((x) => [String(x._id), x]));
    const [s, rf, cu] = [idx(sales), idx(referrals), idx(customers)];
    const data = members.map((m) => {
      const id = String(m._id);
      const t = tasks.filter((x) => String(x.assignedTo) === id);
      const done = t.filter((x) => isDoneStatus(x.status)).length;
      const overdue = t.filter((x) => !isDoneStatus(x.status) && x.dueDate < today).length;
      const a = attendance.filter((x) => String(x.user) === id);
      const present = a.filter((x) => ['Full Day', 'Half Day', 'Working'].includes(x.status));
      return {
        member: m,
        tasks: { total: t.length, done, overdue, pending: t.length - done, rate: t.length ? Math.round((done / t.length) * 100) : null },
        // Super Admins do not clock in, so they have no attendance to show.
        attendance: m.role === 'superadmin' ? null : { present: present.length, full: a.filter((x) => x.status === 'Full Day').length, half: a.filter((x) => x.status === 'Half Day').length, late: present.filter((x) => x.isLate).length },
        sales: { count: s[id]?.count || 0, amount: r2(s[id]?.amount) },
        referrals: { converted: rf[id]?.count || 0, incentive: r2(rf[id]?.incentive) },
        customersAdded: cu[id]?.count || 0,
      };
    });
    res.json({ month, data });
  })
);

export default router;
