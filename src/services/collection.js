import { SalePayment } from '../models/SalePayment.js';
import { getSetting } from '../models/Setting.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Net business is split into the reserve heads by %; together they are the day's saving.
// Saving is kept aside; what is left of net business after it is the day's expense limit.
export function splitNet(net, heads = []) {
  const split = heads.map((h) => r2((net * (Number(h.percent) || 0)) / 100));
  const saving = r2(split.reduce((a, x) => a + x, 0));
  return { split, saving, limit: r2(net - saving) };
}

// A day's expense limit is net business minus saving. Spending more is allowed; it is only flagged.
export async function expenseLimitOn(date) {
  const [{ heads }, [agg]] = await Promise.all([
    getSetting('collection'),
    SalePayment.aggregate([{ $match: { date } }, { $group: { _id: null, net: { $sum: '$professionalPart' } } }]),
  ]);
  return splitNet(r2(agg?.net), heads).limit;
}
