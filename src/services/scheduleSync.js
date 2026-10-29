import { ScheduleItem } from '../models/ScheduleItem.js';
import { CustomerService } from '../models/CustomerService.js';
import { isDoneStatus } from './taskStatus.js';

// CustomerService status follows its schedule items.
export async function syncCustomerService(customerServiceId) {
  if (!customerServiceId) return;
  const items = await ScheduleItem.find({ customerService: customerServiceId, status: { $ne: 'Cancelled' } }).select('status').lean();
  const cs = await CustomerService.findById(customerServiceId);
  if (!cs || cs.status === 'cancelled') return;

  const total = items.length;
  const completed = items.filter((i) => i.status === 'Completed').length;
  const started = items.filter((i) => i.status !== 'Unscheduled').length;
  if (total > 0 && completed === total) {
    cs.status = 'completed';
    cs.completedAt = cs.completedAt || new Date();
  } else {
    cs.status = started > 0 ? 'in_progress' : 'pending';
    cs.completedAt = undefined;
  }
  await cs.save();
}

// After a linked task is created / changed, mirror it onto its schedule item.
export async function syncItemFromTask(task) {
  if (!task?.scheduleItem) return;
  const item = await ScheduleItem.findByIdAndUpdate(
    task.scheduleItem,
    {
      linkedTask: task._id,
      date: task.dueDate,
      content: task.title,
      status: isDoneStatus(task.status) ? 'Completed' : 'Scheduled',
    },
    { new: true }
  );
  if (item) await syncCustomerService(item.customerService);
}

// Deleting the task puts the item back to Unscheduled.
export async function revertItemForTask(task) {
  if (!task?.scheduleItem) return;
  const item = await ScheduleItem.findByIdAndUpdate(
    task.scheduleItem,
    { status: 'Unscheduled', $unset: { date: 1, linkedTask: 1 } },
    { new: true }
  );
  if (item) await syncCustomerService(item.customerService);
}

export async function createItemsForAssignment(cs, service, userId) {
  await ScheduleItem.insertMany(
    service.tasks.map((t, i) => ({
      customer: cs.customer,
      customerService: cs._id,
      service: service._id,
      postType: service.name,
      serviceTask: t._id,
      content: t.title,
      order: i,
      addedBy: userId,
    }))
  );
}

// After a service's task list is edited, apply only what changed in that edit to
// every running assignment (completed / cancelled ones are left alone):
//  - an added task gets an Unscheduled item,
//  - a removed task's item is deleted if no work was started on it,
//  - a renamed task renames items that still carry the old title (per-customer
//    renames are kept),
//  - item order follows the service.
// Items a member deleted for one customer are not brought back.
export async function syncServiceTasks(oldTasks, service, userId) {
  const oldById = new Map(oldTasks.map((t) => [String(t._id), t]));
  const newIds = new Set(service.tasks.map((t) => String(t._id)));
  const added = service.tasks.filter((t) => !oldById.has(String(t._id)));
  const removed = oldTasks.filter((t) => !newIds.has(String(t._id)));
  const renamed = service.tasks.filter((t) => oldById.has(String(t._id)) && oldById.get(String(t._id)).title !== t.title);
  const orderOf = new Map(service.tasks.map((t, i) => [String(t._id), i]));

  const assignments = await CustomerService.find({ service: service._id, status: { $in: ['pending', 'in_progress'] } });
  for (const cs of assignments) {
    const items = await ScheduleItem.find({ customerService: cs._id, status: { $ne: 'Cancelled' } });
    // Older items have no serviceTask link yet; they are matched by their original title.
    const unlinked = items.filter((it) => !it.serviceTask);
    const claimed = new Set();
    const itemFor = (task) => {
      const linked = items.find((it) => String(it.serviceTask) === String(task._id));
      if (linked) return linked;
      const legacy = unlinked.find((it) => it.content === task.title && !claimed.has(it));
      if (legacy) claimed.add(legacy);
      return legacy;
    };

    const ops = [];
    for (const t of oldTasks) {
      const it = itemFor(t);
      if (!it) continue;
      const id = String(t._id);
      if (!newIds.has(id)) {
        if (it.status === 'Unscheduled') ops.push({ deleteOne: { filter: { _id: it._id } } });
        continue;
      }
      const update = { serviceTask: t._id, order: orderOf.get(id) };
      const now = service.tasks[orderOf.get(id)];
      if (now.title !== t.title && it.content === t.title) update.content = now.title;
      ops.push({ updateOne: { filter: { _id: it._id }, update } });
    }
    if (ops.length) await ScheduleItem.bulkWrite(ops);
    if (added.length) {
      await ScheduleItem.insertMany(
        added.map((t) => ({ customer: cs.customer, customerService: cs._id, service: service._id, serviceTask: t._id, postType: service.name, content: t.title, order: orderOf.get(String(t._id)), addedBy: userId }))
      );
    }
    if (added.length || removed.length || renamed.length) await syncCustomerService(cs._id);
  }
}
