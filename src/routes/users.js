import { Router } from 'express';
import { User } from '../models/User.js';
import { protect, can, hasPermission, isSuperAdmin } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

const router = Router();
router.use(protect);

const EDITABLE = ['name', 'email', 'phone', 'role', 'designation', 'monthlySalary', 'joiningDate', 'isActive', 'shiftStart', 'shiftEnd', 'fullDayHours', 'halfDayHours'];

function checkShift(data) {
  const full = Number(data.fullDayHours ?? 8), half = Number(data.halfDayHours ?? 4);
  if (half > full) throw new HttpError(400, 'Half day hours cannot be more than full day hours');
}
const pick = (body) => Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]]));

// Only Super Admin can create or manage Admin / Super Admin accounts, so nobody
// can raise their own access through the Team page.
function guardRole(req, targetRole) {
  if (!isSuperAdmin(req.user) && targetRole && targetRole !== 'team')
    throw new HttpError(403, 'Only Super Admin can manage Admin and Super Admin accounts');
}

// Everyone can list members (needed for pickers like Schedule); full details
// such as salary only for those with Team Members → View.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = { deletedAt: null };
    if (req.query.role) filter.role = req.query.role;
    if (req.query.active === 'true') filter.isActive = true;
    const full = hasPermission(req, 'team', 'view');
    const users = await User.find(full ? filter : { ...filter, isActive: true })
      .select(full ? '' : 'name role designation')
      .sort({ createdAt: -1 });
    res.json({ users });
  })
);

router.post(
  '/',
  can('team', 'create'),
  asyncHandler(async (req, res) => {
    guardRole(req, req.body.role || 'team');
    if (!req.body.password || req.body.password.length < 6)
      throw new HttpError(400, 'Password must be at least 6 characters');
    if (await User.exists({ email: req.body.email?.toLowerCase().trim() }))
      throw new HttpError(400, 'A user with this email already exists');
    checkShift(req.body);
    const user = await User.create({ ...pick(req.body), password: req.body.password });
    user.password = undefined;
    res.status(201).json({ user });
  })
);

router.put(
  '/:id',
  can('team', 'edit'),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, deletedAt: null });
    if (!user) throw new HttpError(404, 'User not found');
    guardRole(req, user.role);
    guardRole(req, req.body.role);
    if (user._id.equals(req.user._id) && req.body.isActive === false)
      throw new HttpError(400, 'You cannot disable your own account');
    if (user._id.equals(req.user._id) && req.body.role && req.body.role !== user.role)
      throw new HttpError(400, 'You cannot change your own role');

    Object.assign(user, pick(req.body));
    checkShift(user);
    if (req.body.password) {
      if (req.body.password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
      user.password = req.body.password;
    }
    await user.save();
    user.password = undefined;
    res.json({ user });
  })
);

// Removes a member from the CRM. Their past records stay (see User.deletedAt);
// the email is freed so it can be used for a new account.
router.delete(
  '/:id',
  can('team', 'delete'),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, deletedAt: null });
    if (!user) throw new HttpError(404, 'User not found');
    guardRole(req, user.role);
    if (user._id.equals(req.user._id)) throw new HttpError(400, 'You cannot delete your own account');
    user.isActive = false;
    user.deletedAt = new Date();
    user.email = `deleted-${user._id}-${user.email}`;
    await user.save();
    res.json({ message: `${user.name} deleted` });
  })
);

export default router;
