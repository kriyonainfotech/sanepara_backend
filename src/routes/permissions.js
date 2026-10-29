import { Router } from 'express';
import { RolePermission } from '../models/RolePermission.js';
import { PERMISSION_CATALOG, DEFAULT_PERMISSIONS } from '../config/permissions.js';
import { protect, superAdminOnly } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

const router = Router();
router.use(protect, superAdminOnly);

const ROLES = ['admin', 'team'];

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [admin, team] = await Promise.all(ROLES.map((r) => RolePermission.forRole(r)));
    res.json({ catalog: PERMISSION_CATALOG, roles: { admin, team }, defaults: DEFAULT_PERMISSIONS });
  })
);

router.put(
  '/:role',
  asyncHandler(async (req, res) => {
    if (!ROLES.includes(req.params.role)) throw new HttpError(400, 'Unknown role');
    const permissions = await RolePermission.setForRole(req.params.role, req.body.permissions, req.user._id);
    res.json({ permissions });
  })
);

export default router;
