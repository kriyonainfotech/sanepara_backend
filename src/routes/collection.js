import { Router } from 'express';
import { SalePayment } from '../models/SalePayment.js';
import { Sale } from '../models/Sale.js';
import { Expense } from '../models/Expense.js';
import { getSetting, setSetting } from '../models/Setting.js';
import { protect, can } from '../middleware/auth.js';
import { eachDay, monthBounds } from '../services/payroll.js';
import { splitNet } from '../services/collection.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Date-wise collection sheet for a month.
 * Collection = money received on sales that day; government fee part is
 * passed on, the rest is net business. Net business is split into the
 * reserve heads by %; together they are the day's saving, kept aside. What is
 * left of net business after saving is that day's expense limit (spending
 * more is allowed, it is only shown as over).
 */
router.get(
  '/',
  can('collection', 'view'),
  asyncHandler(async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : todayKey().slice(0, 7);
    const [from, to] = monthBounds(month);
    const [settings, goal, payments, expenses, salesAgg] = await Promise.all([
      getSetting('collection'),
      getSetting(`goal:${month}`),
      SalePayment.aggregate([
        { $match: { date: { $gte: from, $lte: to } } },
        { $group: { _id: '$date', collection: { $sum: '$amount' }, govt: { $sum: '$govtPart' }, net: { $sum: '$professionalPart' }, count: { $sum: 1 } } },
      ]),
      Expense.aggregate([{ $match: { date: { $gte: from, $lte: to } } }, { $group: { _id: '$date', expense: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Sale.aggregate([{ $match: { saleDate: { $gte: from, $lte: to } } }, { $group: { _id: null, total: { $sum: '$totalAmount' }, professional: { $sum: '$professionalFee' }, count: { $sum: 1 } } }]),
    ]);
    const payBy = Object.fromEntries(payments.map((p) => [p._id, p]));
    const expBy = Object.fromEntries(expenses.map((e) => [e._id, e]));
    const heads = settings.heads || [];
    const today = todayKey();

    const days = eachDay(from, to)
      .filter((d) => d <= today || payBy[d] || expBy[d])
      .map((date) => {
        const p = payBy[date] || {};
        const net = r2(p.net);
        const { split, saving, limit } = splitNet(net, heads);
        const expense = r2(expBy[date]?.expense);
        return {
          date,
          collection: r2(p.collection),
          govt: r2(p.govt),
          net,
          payments: p.count || 0,
          heads: split,
          saving,
          limit,
          expense,
          remaining: r2(limit - expense),
        };
      });

    const sum = (k) => r2(days.reduce((a, d) => a + d[k], 0));
    const totals = {
      collection: sum('collection'),
      govt: sum('govt'),
      net: sum('net'),
      heads: heads.map((_, i) => r2(days.reduce((a, d) => a + d.heads[i], 0))),
      saving: sum('saving'),
      expense: sum('expense'),
      limit: sum('limit'),
      overDays: days.filter((d) => d.remaining < 0).length,
    };
    totals.remaining = r2(totals.limit - totals.expense);

    const s = salesAgg[0] || {};
    res.json({
      month,
      settings,
      days: days.reverse(),
      totals,
      goals: {
        salesGoal: Number(goal.salesGoal) || 0,
        collectionGoal: Number(goal.collectionGoal) || 0,
        sales: r2(s.total),
        salesCount: s.count || 0,
        collection: totals.collection,
      },
    });
  })
);

router.put(
  '/settings',
  can('collection', 'manage'),
  asyncHandler(async (req, res) => {
    const heads = (Array.isArray(req.body.heads) ? req.body.heads : [])
      .map((h) => ({ name: String(h.name || '').trim(), percent: Number(h.percent) }))
      .filter((h) => h.name);
    if (heads.some((h) => !(h.percent >= 0 && h.percent <= 100))) throw new HttpError(400, 'Each head % must be between 0 and 100');
    if (heads.reduce((a, h) => a + h.percent, 0) > 100) throw new HttpError(400, 'Heads cannot add up to more than 100%');
    const current = await getSetting('collection');
    const accounts = Array.isArray(req.body.expenseAccounts)
      ? [...new Set(req.body.expenseAccounts.map((a) => String(a).trim()).filter(Boolean))]
      : current.expenseAccounts;
    res.json({ message: 'Collection settings saved', data: await setSetting('collection', { heads, expenseAccounts: accounts }, req.user._id) });
  })
);

router.put(
  '/goals',
  can('collection', 'manage'),
  asyncHandler(async (req, res) => {
    if (!isMonth(req.body.month)) throw new HttpError(400, 'Select the month');
    const salesGoal = Number(req.body.salesGoal) || 0;
    const collectionGoal = Number(req.body.collectionGoal) || 0;
    if (salesGoal < 0 || collectionGoal < 0) throw new HttpError(400, 'Goals cannot be negative');
    res.json({ message: 'Goals saved', data: await setSetting(`goal:${req.body.month}`, { salesGoal, collectionGoal }, req.user._id) });
  })
);

export default router;
