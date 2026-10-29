import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { protect, permissionsFor } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

const router = Router();

const signToken = (user) =>
  jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) throw new HttpError(400, 'Email and password are required');

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!user || !(await user.comparePassword(password)))
      throw new HttpError(401, 'Invalid email or password');
    if (!user.isActive) throw new HttpError(403, 'Your account is disabled');

    user.password = undefined;
    res.json({ token: signToken(user), user, permissions: await permissionsFor(user) });
  })
);

router.get('/me', protect, (req, res) => res.json({ user: req.user, permissions: req.permissions }));

router.post(
  '/change-password',
  protect,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6)
      throw new HttpError(400, 'New password must be at least 6 characters');
    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.comparePassword(currentPassword || '')))
      throw new HttpError(400, 'Current password is incorrect');
    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password updated' });
  })
);

export default router;
