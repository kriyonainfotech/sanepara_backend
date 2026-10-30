import mongoose from 'mongoose';
import { BankAccount } from '../models/BankAccount.js';
import { BankEntry } from '../models/BankEntry.js';
import { SalePayment } from '../models/SalePayment.js';
import { Expense } from '../models/Expense.js';
import { SalaryPayment } from '../models/SalaryPayment.js';
import { B2BPayout } from '../models/B2BPayout.js';
import { HttpError } from '../utils/asyncHandler.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Records that move money, besides manual bank entries. `in` adds to the account, `out` takes from it.
export const SOURCES = [
  { key: 'sale', model: SalePayment, dir: 'in', dateField: 'date', match: { amount: { $gt: 0 } } },
  { key: 'expense', model: Expense, dir: 'out', dateField: 'date' },
  { key: 'salary', model: SalaryPayment, dir: 'out', dateField: 'paidOn' },
  { key: 'b2b', model: B2BPayout, dir: 'out', dateField: 'paidOn' },
];

// The account a payment / expense goes to: the one picked, else the default account
// (none yet = left unassigned, so the app keeps working before any account is added).
export async function pickBank(value) {
  if (value) {
    if (!mongoose.isValidObjectId(value)) throw new HttpError(400, 'Select a valid bank / cash account');
    const bank = await BankAccount.findById(value).select('_id active');
    if (!bank) throw new HttpError(400, 'That bank / cash account no longer exists');
    return bank._id;
  }
  // Same order as the dropdowns, so an empty pick = the first option shown.
  const def = await BankAccount.findOne({ active: true }).sort({ isDefault: -1, name: 1 }).select('_id');
  return def?._id;
}

const sumBy = (model, match, group = '$bank') =>
  model.aggregate([{ $match: match }, { $group: { _id: group, total: { $sum: '$amount' }, count: { $sum: 1 } } }]);

// Money in / out per account (key = account id, 'null' = not assigned to any account).
// `date` is an optional condition on the record date, e.g. { $lt: '2026-10-01' }.
export async function totalsByBank(date) {
  const out = {};
  const add = (rows, dir) => {
    for (const r of rows) {
      const k = String(r._id);
      out[k] ??= { in: 0, out: 0, count: 0 };
      out[k][dir] = r2(out[k][dir] + r.total);
      out[k].count += r.count;
    }
  };
  const withDate = (field, m = {}) => (date ? { ...m, [field]: date } : m);
  const results = await Promise.all([
    ...SOURCES.map((s) => sumBy(s.model, withDate(s.dateField, s.match))),
    sumBy(BankEntry, withDate('date', { type: 'in' })),
    sumBy(BankEntry, withDate('date', { type: { $in: ['out', 'transfer'] } })),
    sumBy(BankEntry, withDate('date', { type: 'transfer' }), '$toBank'),
  ]);
  SOURCES.forEach((s, i) => add(results[i], s.dir));
  add(results[SOURCES.length], 'in');
  add(results[SOURCES.length + 1], 'out');
  add(results[SOURCES.length + 2], 'in');
  return out;
}

const name = (doc, ...keys) => keys.map((k) => doc?.[k]).find(Boolean) || '';

// Every movement between two dates, oldest first, in one shape — of one account (`bankId`) or of
// all accounts (`bankId` empty). A transfer is two rows: out of one account, into the other.
export async function movements(bankId, from, to) {
  const id = bankId ? new mongoose.Types.ObjectId(String(bankId)) : null;
  const bank = id || { $ne: null };
  const date = { $gte: from, $lte: to };
  const acc = (b) => (b ? { _id: b._id, name: b.name } : null);
  const [sales, expenses, salaries, payouts, entries] = await Promise.all([
    SalePayment.find({ bank, date, amount: { $gt: 0 } }).populate('customer', 'businessName').populate('sale', 'saleNo title').populate('receivedBy', 'name').populate('bank', 'name').lean(),
    Expense.find({ bank, date }).populate('createdBy', 'name').populate('bank', 'name').lean(),
    SalaryPayment.find({ bank, paidOn: date }).populate('user', 'name').populate('paidBy', 'name').populate('bank', 'name').lean(),
    B2BPayout.find({ bank, paidOn: date }).populate('partner', 'name firmName').populate('paidBy', 'name').populate('bank', 'name').lean(),
    BankEntry.find({ ...(id && { $or: [{ bank: id }, { toBank: id }] }), date }).populate('bank toBank', 'name').populate('createdBy', 'name').lean(),
  ]);
  const rows = [
    ...sales.map((p) => ({ _id: p._id, source: 'sale', date: p.date, account: acc(p.bank), in: p.amount, out: 0, mode: p.mode, title: name(p.customer, 'businessName') || 'Sale payment', sub: [p.sale?.saleNo, p.sale?.title, p.reference].filter(Boolean).join(' · '), by: p.receivedBy?.name, createdAt: p.createdAt, saleId: p.sale?._id })),
    ...expenses.map((e) => ({ _id: e._id, source: 'expense', date: e.date, account: acc(e.bank), in: 0, out: e.amount, mode: e.mode, title: e.paidTo || e.account, sub: [e.paidTo ? e.account : '', e.note].filter(Boolean).join(' · '), by: e.createdBy?.name, createdAt: e.createdAt })),
    ...salaries.map((s) => ({ _id: s._id, source: 'salary', date: s.paidOn, account: acc(s.bank), in: 0, out: s.amount, mode: s.mode, title: `Salary · ${s.user?.name || 'Member'}`, sub: [s.month, s.note].filter(Boolean).join(' · '), by: s.paidBy?.name, createdAt: s.createdAt })),
    ...payouts.map((p) => ({ _id: p._id, source: 'b2b', date: p.paidOn, account: acc(p.bank), in: 0, out: p.amount, mode: p.mode, title: `B2B payout · ${name(p.partner, 'name', 'firmName')}`, sub: p.note || '', by: p.paidBy?.name, createdAt: p.createdAt })),
    ...entries.flatMap((e) => {
      const entry = { ...e, bank: e.bank?._id, toBank: e.toBank?._id };
      const base = { _id: e._id, date: e.date, by: e.createdBy?.name, createdAt: e.createdAt, entry };
      if (e.type !== 'transfer') {
        return [{ ...base, source: 'entry', account: acc(e.bank), in: e.type === 'in' ? e.amount : 0, out: e.type === 'out' ? e.amount : 0, title: e.party || (e.type === 'in' ? 'Money in' : 'Money out'), sub: e.note || '' }];
      }
      const side = (incoming) => ({ ...base, source: 'transfer', account: acc(incoming ? e.toBank : e.bank), in: incoming ? e.amount : 0, out: incoming ? 0 : e.amount, title: incoming ? `Transfer from ${e.bank?.name || '—'}` : `Transfer to ${e.toBank?.name || '—'}`, sub: e.note || '' });
      return [!id || String(e.bank?._id) === String(id) ? side(false) : null, !id || String(e.toBank?._id) === String(id) ? side(true) : null].filter(Boolean);
    }),
  ];
  return rows.sort((a, b) => (a.date === b.date ? new Date(a.createdAt) - new Date(b.createdAt) : a.date < b.date ? -1 : 1));
}

export async function isBankUsed(bankId) {
  const checks = await Promise.all([...SOURCES.map((s) => s.model.exists({ bank: bankId })), BankEntry.exists({ $or: [{ bank: bankId }, { toBank: bankId }] })]);
  return checks.some(Boolean);
}
