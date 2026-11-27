import { Router } from 'express';
import { Customer } from '../models/Customer.js';
import { Service } from '../models/Service.js';
import { User } from '../models/User.js';
import { ScheduleItem } from '../models/ScheduleItem.js';
import { Sale } from '../models/Sale.js';
import { SalePayment } from '../models/SalePayment.js';
import { protect, can, hasPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { addDaysKey, todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

async function periodTotals(Model, dateField, amountField, today) {
  const [totals] = await Model.aggregate([
    { $match: { [dateField]: { $gte: addDaysKey(today, -6), $lte: today } } },
    { $group: {
      _id: null,
      today: { $sum: { $cond: [{ $eq: [`$${dateField}`, today] }, `$${amountField}`, 0] } },
      last7Days: { $sum: `$${amountField}` },
    } },
    { $project: { _id: 0, today: 1, last7Days: 1 } },
  ]);
  return totals ?? { today: 0, last7Days: 0 };
}

router.get(
  '/summary',
  can('dashboard', 'view'),
  asyncHandler(async (req, res) => {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const today = todayKey();

    const [customers, customersThisMonth, services, team, pendingSchedule, recentCustomers, sales, collections] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ createdAt: { $gte: monthStart } }),
      Service.countDocuments({ isActive: true }),
      User.countDocuments({ isActive: true, role: 'team' }),
      ScheduleItem.countDocuments({ status: 'Unscheduled' }),
      hasPermission(req, 'customers', 'view')
        ? Customer.find().sort({ createdAt: -1 }).limit(6).populate('addedBy', 'name').lean()
        : null,
      req.user.role === 'superadmin' ? periodTotals(Sale, 'saleDate', 'totalAmount', today) : null,
      req.user.role === 'superadmin' ? periodTotals(SalePayment, 'date', 'amount', today) : null,
    ]);

    res.json({ customers, customersThisMonth, services, team, pendingSchedule, recentCustomers, sales, collections });
  })
);

export default router;
