import { Expense } from '../models/Expense.js';
import { B2BPayout } from '../models/B2BPayout.js';

export const B2B_COMMISSION_ACCOUNT = 'B2B Partner Commission';

export function expenseTotals(date, groupBy, amountKey) {
  return Expense.aggregate([
    { $match: { date } },
    { $project: { date: 1, amount: 1 } },
    { $unionWith: { coll: B2BPayout.collection.name, pipeline: [
      { $match: { paidOn: date } },
      { $project: { date: '$paidOn', amount: 1 } },
    ] } },
    { $group: { _id: groupBy, [amountKey]: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
}
