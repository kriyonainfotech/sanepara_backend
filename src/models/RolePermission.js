import mongoose from 'mongoose';
import { DEFAULT_PERMISSIONS, sanitizePermissions } from '../config/permissions.js';

// Permissions for the configurable roles. Super Admin always has everything.
const rolePermissionSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['admin', 'team'], required: true, unique: true },
    permissions: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false }
);

// Roles are few and read on every request, so keep them in memory.
const cache = new Map();

rolePermissionSchema.statics.forRole = async function (role) {
  if (cache.has(role)) return cache.get(role);
  const doc = await this.findOne({ role }).lean();
  const perms = sanitizePermissions(doc ? doc.permissions : DEFAULT_PERMISSIONS[role]);
  cache.set(role, perms);
  return perms;
};

rolePermissionSchema.statics.setForRole = async function (role, permissions, userId) {
  const clean = sanitizePermissions(permissions);
  await this.findOneAndUpdate({ role }, { permissions: clean, updatedBy: userId }, { upsert: true });
  cache.set(role, clean);
  return clean;
};

export const RolePermission = mongoose.model('RolePermission', rolePermissionSchema);
