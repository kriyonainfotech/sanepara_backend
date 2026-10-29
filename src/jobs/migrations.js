import mongoose from 'mongoose';
import { CustomerService } from '../models/CustomerService.js';
import { ScheduleItem } from '../models/ScheduleItem.js';
import { Service } from '../models/Service.js';
import { RolePermission } from '../models/RolePermission.js';
import { Task } from '../models/Task.js';
import { User } from '../models/User.js';
import { createItemsForAssignment, syncCustomerService } from '../services/scheduleSync.js';

// One-time upgrades from the first Schedule/Tasks version.
export async function runMigrations() {
  // Assigned services from before schedule items existed get their items now.
  const assignments = await CustomerService.find({ status: { $ne: 'cancelled' } });
  for (const cs of assignments) {
    if (await ScheduleItem.exists({ customerService: cs._id })) continue;
    const service = await Service.findById(cs.service);
    if (!service) continue;
    await createItemsForAssignment(cs, service, cs.assignedBy);
    await syncCustomerService(cs._id);
  }

  // Old-format tasks (day/type service|ritual|regular) and rituals are dropped.
  const db = mongoose.connection.db;
  await Task.deleteMany({ dueDate: { $exists: false } });
  await Task.syncIndexes();
  if ((await db.listCollections({ name: 'dailyrituals' }).toArray()).length) await db.dropCollection('dailyrituals');
  await CustomerService.updateMany({ status: 'scheduled' }, { status: 'in_progress' });

  // Members created before shifts existed get the default shift rules.
  for (const [field, value] of [['shiftStart', '09:00'], ['shiftEnd', '18:00'], ['fullDayHours', 8], ['halfDayHours', 4]]) {
    await User.updateMany({ [field]: { $exists: false } }, { $set: { [field]: value } });
  }

  // SOP & Rules was one permission; Rules got their own. Roles keep the access they had (once only,
  // so a later removal of Rule access is not undone).
  for (const doc of await RolePermission.collection.find({ rulesSplit: { $ne: true } }).toArray()) {
    const set = { rulesSplit: true };
    if (doc.permissions?.sop?.length && !doc.permissions.rules) set['permissions.rules'] = doc.permissions.sop;
    await RolePermission.collection.updateOne({ _id: doc._id }, { $set: set });
  }

  // Compliance Calendar is new: saved roles get it like Running GST Filing (once only).
  for (const doc of await RolePermission.collection.find({ complianceAdded: { $ne: true } }).toArray()) {
    const set = { complianceAdded: true };
    const gst = doc.permissions?.gst_filing || [];
    if (gst.length && !doc.permissions.compliance) set['permissions.compliance'] = gst.includes('manage') ? ['view', 'manage'] : ['view'];
    await RolePermission.collection.updateOne({ _id: doc._id }, { $set: set });
  }

  // Scheduled tasks remember their service bunch.
  const unlinked = await Task.find({ scheduleItem: { $exists: true }, customerService: { $exists: false } });
  for (const t of unlinked) {
    const item = await ScheduleItem.findById(t.scheduleItem).select('customerService order');
    if (item) await Task.updateOne({ _id: t._id }, { customerService: item.customerService, order: item.order });
  }
}
