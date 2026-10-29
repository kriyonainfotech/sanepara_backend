import { Router } from 'express';
import { Expense } from '../models/Expense.js';
import { getSetting } from '../models/Setting.js';
import { protect, can } from '../middleware/auth.js';
import { monthBounds } from '../services/payroll.js';
import { expenseLimitOn } from '../services/collection.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MODES = ['Cash', 'Bank', 'UPI', 'Cheque'];

function range(q) {
  if (isDayKey(q.from) && isDayKey(q.to)) return [q.from, q.to];
  return monthBounds(isMonth(q.month) ? q.month : todayKey().slice(0, 7));
}

const knownAccounts = async () => [...new Set([...((await getSetting('collection')).expenseAccounts || []), ...(await Expense.distinct('account'))])];

const clean = async (b) => {
  const amount = r2(b.amount);
  if (!(amount > 0)) throw new HttpError(400, 'Enter the amount');
  let account = String(b.account || '').trim().replace(/\s+/g, ' ');
  if (!account) throw new HttpError(400, 'Select the expense account');
  // "office" / "OFFICE " are the same account as "Office", so totals don't split.
  account = (await knownAccounts()).find((a) => a.toLowerCase() === account.toLowerCase()) || account;
  const date = isDayKey(b.date) ? b.date : todayKey();
  if (date > todayKey()) throw new HttpError(400, 'Expense date cannot be in the future');
  const text = (v) => String(v ?? '').trim();
  return { date, amount, account, mode: MODES.includes(b.mode) ? b.mode : 'Cash', paidTo: text(b.paidTo), note: text(b.note) };
};

// What is left of a day's limit (= net business − saving) after its expenses.
async function dayStatus(date) {
  const [limit, [agg]] = await Promise.all([
    expenseLimitOn(date),
    Expense.aggregate([{ $match: { date } }, { $group: { _id: null, spent: { $sum: '$amount' } } }]),
  ]);
  const spent = r2(agg?.spent);
  return { date, limit, spent, remaining: r2(limit - spent) };
}

const overLimitNote = (s) => (s.remaining < 0 ? ` — ₹${Math.abs(s.remaining)} over the day's expense limit of ₹${s.limit}` : '');

router.get(
  '/',
  can('expenses', 'view'),
  asyncHandler(async (req, res) => {
    const [from, to] = range(req.query);
    const filter = { date: { $gte: from, $lte: to } };
    if (req.query.account) filter.account = req.query.account;
    const [data, accounts, today] = await Promise.all([
      Expense.find(filter).populate('createdBy', 'name').sort({ date: -1, createdAt: -1 }),
      knownAccounts(),
      dayStatus(todayKey()),
    ]);
    const byAccount = {};
    for (const e of data) byAccount[e.account] = r2((byAccount[e.account] || 0) + e.amount);
    res.json({
      from, to, data,
      accounts,
      today,
      stats: { count: data.length, total: r2(data.reduce((a, e) => a + e.amount, 0)), byAccount },
    });
  })
);

// Limit / spent for any day, so the form can warn for past dates too.
router.get(
  '/day',
  can('expenses', 'view'),
  asyncHandler(async (req, res) => {
    if (!isDayKey(req.query.date)) throw new HttpError(400, 'Invalid date');
    res.json({ data: await dayStatus(req.query.date) });
  })
);

router.post(
  '/',
  can('expenses', 'create'),
  asyncHandler(async (req, res) => {
    const expense = await Expense.create({ ...(await clean(req.body)), createdBy: req.user._id });
    const status = await dayStatus(expense.date);
    res.status(201).json({ message: `Expense of ₹${expense.amount} added${overLimitNote(status)}`, data: expense, day: status });
  })
);

router.put(
  '/:id',
  can('expenses', 'edit'),
  asyncHandler(async (req, res) => {
    const expense = await Expense.findByIdAndUpdate(req.params.id, await clean(req.body), { new: true, runValidators: true });
    if (!expense) throw new HttpError(404, 'Expense not found');
    const status = await dayStatus(expense.date);
    res.json({ message: `Expense updated${overLimitNote(status)}`, data: expense, day: status });
  })
);

router.delete(
  '/:id',
  can('expenses', 'delete'),
  asyncHandler(async (req, res) => {
    const e = await Expense.findByIdAndDelete(req.params.id);
    if (!e) throw new HttpError(404, 'Expense not found');
    res.json({ message: 'Expense deleted' });
  })
);

export default router;
