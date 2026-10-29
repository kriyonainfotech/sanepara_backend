import { Router } from 'express';
import { Customer } from '../models/Customer.js';
import { Service } from '../models/Service.js';
import { User } from '../models/User.js';
import { ScheduleItem } from '../models/ScheduleItem.js';
import { protect, can, hasPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.use(protect);

router.get(
  '/summary',
  can('dashboard', 'view'),
  asyncHandler(async (req, res) => {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [customers, customersThisMonth, services, team, pendingSchedule, recentCustomers] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ createdAt: { $gte: monthStart } }),
      Service.countDocuments({ isActive: true }),
      User.countDocuments({ isActive: true, role: 'team' }),
      ScheduleItem.countDocuments({ status: 'Unscheduled' }),
      hasPermission(req, 'customers', 'view')
        ? Customer.find().sort({ createdAt: -1 }).limit(6).populate('addedBy', 'name').lean()
        : null,
    ]);

    res.json({ customers, customersThisMonth, services, team, pendingSchedule, recentCustomers });
  })
);

export default router;
