import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { RolePermission } from '../models/RolePermission.js';
import { fullPermissions } from '../config/permissions.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

export const protect = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Not authenticated');

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new HttpError(401, 'Session expired, please log in again');
  }

  const user = await User.findById(payload.id);
  if (!user || !user.isActive) throw new HttpError(401, 'Account not found or disabled');
  req.user = user;
  req.permissions = await permissionsFor(user);
  next();
});

export const isSuperAdmin = (user) => user.role === 'superadmin';

export const permissionsFor = (user) =>
  isSuperAdmin(user) ? fullPermissions() : RolePermission.forRole(user.role);

export const hasPermission = (req, module, action) =>
  isSuperAdmin(req.user) || Boolean(req.permissions?.[module]?.includes(action));

export const can = (module, action) => (req, _res, next) => {
  if (!hasPermission(req, module, action)) return next(new HttpError(403, 'You do not have access to this'));
  next();
};

export const superAdminOnly = (req, _res, next) => {
  if (!isSuperAdmin(req.user)) return next(new HttpError(403, 'Only Super Admin can do this'));
  next();
};
