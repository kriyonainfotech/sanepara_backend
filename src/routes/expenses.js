import { Router } from 'express';
import { Expense } from '../models/Expense.js';
import { SalePayment } from '../models/SalePayment.js';
import { getSetting } from '../models/Setting.js';
import { protect, can } from '../middleware/auth.js';
import { monthBounds } from '../services/payroll.js';
import { expenseLimitOn, splitNet } from '../services/collection.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MODES = ['Cash', 'Bank', 'UPI', 'Cheque'];

// Period of the list: a day range (today = same from and to), a whole year, or a month.
function range(q) {
  if (isDayKey(q.from) && isDayKey(q.to)) return q.from <= q.to ? [q.from, q.to] : [q.to, q.from];
  if (/^\d{4}$/.test(q.year)) return [`${q.year}-01-01`, `${q.year}-12-31`];
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

// Per month ('YYYY-MM') between two day keys: entries, spent, limit (= month's net business − saving), remaining.
async function monthSummary(from, to) {
  const byMonth = { $substrBytes: ['$date', 0, 7] };
  const [{ heads }, spent, net] = await Promise.all([
    getSetting('collection'),
    Expense.aggregate([{ $match: { date: { $gte: from, $lte: to } } }, { $group: { _id: byMonth, spent: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    SalePayment.aggregate([{ $match: { date: { $gte: from, $lte: to } } }, { $group: { _id: byMonth, net: { $sum: '$professionalPart' } } }]),
  ]);
  const months = {};
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
    const s = spent.find((x) => x._id === m);
    const limit = splitNet(r2(net.find((x) => x._id === m)?.net), heads).limit;
    months[m] = { month: m, count: s?.count || 0, spent: r2(s?.spent), limit, remaining: r2(limit - r2(s?.spent)) };
    const [y, mm] = m.split('-').map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  }
  return Object.values(months);
}

const overLimitNote = (s) => (s.remaining < 0 ? ` — ₹${Math.abs(s.remaining)} over the day's expense limit of ₹${s.limit}` : '');

router.get(
  '/',
  can('expenses', 'view'),
  asyncHandler(async (req, res) => {
    const [from, to] = range(req.query);
    const filter = { date: { $gte: from, $lte: to } };
    if (req.query.account) filter.account = req.query.account;
    const [data, accounts, today, monthRows] = await Promise.all([
      Expense.find(filter).populate('createdBy', 'name').sort({ date: -1, createdAt: -1 }),
      knownAccounts(),
      dayStatus(todayKey()),
      monthSummary(from, to),
    ]);
    const byAccount = {};
    for (const e of data) byAccount[e.account] = r2((byAccount[e.account] || 0) + e.amount);
    res.json({
      from, to, data,
      accounts,
      today,
      // Limit / spent for the whole selected period (not narrowed by account).
      period: monthRows.reduce((a, m) => ({ count: a.count + m.count, spent: r2(a.spent + m.spent), limit: r2(a.limit + m.limit), remaining: r2(a.remaining + m.remaining) }), { count: 0, spent: 0, limit: 0, remaining: 0 }),
      stats: { count: data.length, total: r2(data.reduce((a, e) => a + e.amount, 0)), byAccount },
    });
  })
);

// Month-wise count, spent and limit for a year (months after the current one are left out).
router.get(
  '/monthly',
  can('expenses', 'view'),
  asyncHandler(async (req, res) => {
    const year = /^\d{4}$/.test(req.query.year) ? req.query.year : todayKey().slice(0, 4);
    const last = year === todayKey().slice(0, 4) ? todayKey().slice(0, 7) : `${year}-12`;
    if (last < `${year}-01`) return res.json({ year, data: [] });
    res.json({ year, data: (await monthSummary(`${year}-01-01`, monthBounds(last)[1])).reverse() });
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
