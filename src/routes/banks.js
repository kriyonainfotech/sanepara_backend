import { Router } from 'express';
import mongoose from 'mongoose';
import { BANK_KINDS, BankAccount } from '../models/BankAccount.js';
import { BankEntry } from '../models/BankEntry.js';
import { protect, can } from '../middleware/auth.js';
import { isBankUsed, movements, totalsByBank } from '../services/banks.js';
import { monthBounds } from '../services/payroll.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const text = (v) => String(v ?? '').trim();
const escapeRegex = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleanAccount = async (b, id) => {
  // The account is just a type typed by hand (Cash, Personal, Company…) and its opening balance.
  const name = text(b.name).replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Enter the account type');
  if (await BankAccount.exists({ name: new RegExp(`^${escapeRegex(name)}$`, 'i'), ...(id && { _id: { $ne: id } }) }))
    throw new HttpError(400, `A "${name}" account is already added`);
  return {
    name, kind: BANK_KINDS.find((k) => k.toLowerCase() === name.toLowerCase()) || 'Other',
    openingBalance: r2(b.openingBalance), isDefault: Boolean(b.isDefault), active: b.active === undefined ? true : Boolean(b.active),
  };
};

// Only one default account: the one just saved as default wins.
const keepOneDefault = async (account) => {
  if (account.isDefault) await BankAccount.updateMany({ _id: { $ne: account._id } }, { isDefault: false });
};

// Accounts for the dropdowns in sale payment / expense / salary / payout forms.
router.get(
  '/options',
  asyncHandler(async (_req, res) => {
    res.json({ data: await BankAccount.find({ active: true }).select('name kind isDefault').sort({ isDefault: -1, name: 1 }) });
  })
);

// All accounts with money in / out and current balance.
router.get(
  '/',
  can('banks', 'view'),
  asyncHandler(async (_req, res) => {
    const today = todayKey();
    const [accounts, totals, todayTotals] = await Promise.all([
      BankAccount.find().sort({ active: -1, isDefault: -1, name: 1 }).lean(),
      totalsByBank(),
      totalsByBank(today),
    ]);
    const data = accounts.map((a) => {
      const t = totals[String(a._id)] || { in: 0, out: 0, count: 0 };
      const d = todayTotals[String(a._id)] || { in: 0, out: 0 };
      return { ...a, in: t.in, out: t.out, entries: t.count, todayIn: d.in, todayOut: d.out, balance: r2(a.openingBalance + t.in - t.out) };
    });
    const sum = (k) => r2(data.filter((a) => a.active).reduce((s, a) => s + a[k], 0));
    res.json({ data, stats: { balance: sum('balance'), in: sum('in'), out: sum('out'), todayIn: sum('todayIn'), todayOut: sum('todayOut') } });
  })
);

router.post(
  '/',
  can('banks', 'create'),
  asyncHandler(async (req, res) => {
    const account = await BankAccount.create({ ...(await cleanAccount(req.body)), createdBy: req.user._id });
    await keepOneDefault(account);
    res.status(201).json({ message: `${account.name} added`, data: account });
  })
);

router.put(
  '/:id',
  can('banks', 'edit'),
  asyncHandler(async (req, res) => {
    const account = await BankAccount.findByIdAndUpdate(req.params.id, await cleanAccount(req.body, req.params.id), { new: true, runValidators: true });
    if (!account) throw new HttpError(404, 'Account not found');
    await keepOneDefault(account);
    res.json({ message: `${account.name} updated`, data: account });
  })
);

router.delete(
  '/:id',
  can('banks', 'delete'),
  asyncHandler(async (req, res) => {
    const account = await BankAccount.findById(req.params.id);
    if (!account) throw new HttpError(404, 'Account not found');
    if (await isBankUsed(account._id)) throw new HttpError(400, `${account.name} has entries — mark it inactive instead of deleting`);
    await account.deleteOne();
    res.json({ message: `${account.name} deleted` });
  })
);

// Statement of one account: balance before `from`, every entry in the range with a running balance.
router.get(
  '/:id/ledger',
  can('banks', 'view'),
  asyncHandler(async (req, res) => {
    const account = await BankAccount.findById(req.params.id).lean();
    if (!account) throw new HttpError(404, 'Account not found');
    let [from, to] = isDayKey(req.query.from) && isDayKey(req.query.to) ? [req.query.from, req.query.to] : monthBounds(todayKey().slice(0, 7));
    if (from > to) [from, to] = [to, from];
    const [before, rows] = await Promise.all([totalsByBank({ $lt: from }), movements(account._id, from, to)]);
    const b = before[String(account._id)] || { in: 0, out: 0 };
    const opening = r2(account.openingBalance + b.in - b.out);
    let running = opening;
    const data = rows.map((r) => ({ ...r, balance: (running = r2(running + r.in - r.out)) }));
    res.json({
      account, from, to, opening, closing: running, data,
      in: r2(rows.reduce((a, r) => a + r.in, 0)),
      out: r2(rows.reduce((a, r) => a + r.out, 0)),
    });
  })
);

// Every entry of all accounts (or ?bank=) in a date range, newest first, with in / out totals.
router.get(
  '/entries',
  can('banks', 'view'),
  asyncHandler(async (req, res) => {
    let [from, to] = isDayKey(req.query.from) && isDayKey(req.query.to) ? [req.query.from, req.query.to] : monthBounds(todayKey().slice(0, 7));
    if (from > to) [from, to] = [to, from];
    const bank = mongoose.isValidObjectId(req.query.bank) ? req.query.bank : null;
    const rows = (await movements(bank, from, to)).reverse();
    res.json({
      from, to, data: rows,
      in: r2(rows.reduce((a, r) => a + r.in, 0)),
      out: r2(rows.reduce((a, r) => a + r.out, 0)),
    });
  })
);

// ---------- manual entries: money in / out / transfer ----------

const cleanEntry = async (b) => {
  const type = ['in', 'out', 'transfer'].includes(b.type) ? b.type : null;
  if (!type) throw new HttpError(400, 'Pick money in, money out or transfer');
  const amount = r2(b.amount);
  if (!(amount > 0)) throw new HttpError(400, 'Enter the amount');
  if (!mongoose.isValidObjectId(b.bank) || !(await BankAccount.exists({ _id: b.bank })))
    throw new HttpError(400, type === 'transfer' ? 'Select the account to transfer from' : 'Select the account');
  let toBank = null;
  if (type === 'transfer') {
    if (!mongoose.isValidObjectId(b.toBank) || !(await BankAccount.exists({ _id: b.toBank }))) throw new HttpError(400, 'Select the account to transfer to');
    if (String(b.toBank) === String(b.bank)) throw new HttpError(400, 'Pick two different accounts to transfer between');
    toBank = b.toBank;
  }
  const date = isDayKey(b.date) ? b.date : todayKey();
  if (date > todayKey()) throw new HttpError(400, 'Date cannot be in the future');
  return { type, amount, bank: b.bank, toBank, date, party: text(b.party), note: text(b.note) };
};

const entryMessage = (e) => (e.type === 'transfer' ? `₹${e.amount} transferred` : e.type === 'in' ? `₹${e.amount} added` : `₹${e.amount} taken out`);

router.post(
  '/entries',
  can('banks', 'create'),
  asyncHandler(async (req, res) => {
    const entry = await BankEntry.create({ ...(await cleanEntry(req.body)), createdBy: req.user._id });
    res.status(201).json({ message: entryMessage(entry), data: entry });
  })
);

router.put(
  '/entries/:id',
  can('banks', 'edit'),
  asyncHandler(async (req, res) => {
    const entry = await BankEntry.findByIdAndUpdate(req.params.id, await cleanEntry(req.body), { new: true, runValidators: true });
    if (!entry) throw new HttpError(404, 'Entry not found');
    res.json({ message: 'Entry updated', data: entry });
  })
);

router.delete(
  '/entries/:id',
  can('banks', 'delete'),
  asyncHandler(async (req, res) => {
    const entry = await BankEntry.findByIdAndDelete(req.params.id);
    if (!entry) throw new HttpError(404, 'Entry not found');
    res.json({ message: 'Entry deleted' });
  })
);


export default router;
