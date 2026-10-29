import { Referral } from '../models/Referral.js';
import { Service } from '../models/Service.js';
import { getSetting } from '../models/Setting.js';
import { monthBounds } from './payroll.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Incentive for a referred service: the service's own rule, else the default.
// % rules apply to the sale's professional fee (or the service price if no sale is linked).
export async function incentiveFor(serviceId, sale) {
  const rules = await getSetting('incentive');
  const rule = (rules.services || []).find((s) => String(s.service) === String(serviceId)) || { type: rules.defaultType, value: rules.defaultValue };
  if (rule.type === 'fixed') return { incentive: r2(rule.value), basis: `Fixed ₹${rule.value}` };
  const base = sale ? sale.professionalFee : (await Service.findById(serviceId).select('price'))?.price || 0;
  return { incentive: r2((base * (Number(rule.value) || 0)) / 100), basis: `${rule.value}% of ${sale ? 'professional fee' : 'service price'} ₹${base}` };
}

// { userId: amount } of converted incentive in a month (for payroll).
export async function incentivesByMember(month) {
  const [from, to] = monthBounds(month);
  const rows = await Referral.aggregate([
    { $match: { status: 'Converted', convertedOn: { $gte: from, $lte: to } } },
    { $group: { _id: '$referredBy', incentive: { $sum: '$incentive' } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r2(r.incentive)]));
}

// Credit a member's incentive for a sale: converts their pending referral of this
// customer + service if there is one, else records a converted one.
export async function creditIncentive({ customer, service, member, sale, amount, by }) {
  const done = { status: 'Converted', sale: sale._id, convertedOn: sale.saleDate, incentive: r2(amount), rejectReason: undefined, reviewedBy: by };
  const pending = await Referral.findOne({ customer, service, referredBy: member, status: 'Pending' }).sort({ referredOn: 1 });
  if (pending) return Object.assign(pending, done).save();
  return Referral.create({ customer, service, referredBy: member, referredOn: sale.saleDate, note: `Sale ${sale.saleNo}`, ...done });
}
