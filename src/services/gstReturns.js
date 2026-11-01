import { ScheduleItem } from '../models/ScheduleItem.js';
import { dayKey } from '../utils/dates.js';

// GST returns tracked one by one inside the monthly GST work (jobs/gstWork.js). A step of the
// GST service counts for a return when its title names it: 'GSTR-1 file', 'GSTR 3B filing'…
export const GST_RETURNS = ['gstr1', 'gstr3b'];

export const returnOfStep = (title = '') => {
  const t = String(title).toUpperCase().replace(/[\s_.-]/g, '');
  if (t.includes('3B')) return 'gstr3b';
  if (/GSTR1(?!\d)|IFF/.test(t)) return 'gstr1';
  return null;
};

// For each GST work (CustomerService, lean, with _id and status): where each return stands and
// how many of its steps are done.
//   { gstr1: { status: 'filed' | 'pending' | 'unassigned', filedOn, dueDate, member, taskStatus } | null,
//     gstr3b: …, steps: { total, completed }, members: [{ _id, name }] (everyone with a step of it) }
// A return is null when the service has no step for it (e.g. Composition work).
export async function returnStatus(services) {
  const out = new Map(services.map((cs) => [String(cs._id), { gstr1: null, gstr3b: null, steps: { total: 0, completed: 0 }, members: [] }]));
  if (!services.length) return out;
  const items = await ScheduleItem.find({ customerService: { $in: services.map((cs) => cs._id) }, status: { $ne: 'Cancelled' } })
    .select('customerService content status date linkedTask updatedAt order')
    .populate({ path: 'linkedTask', select: 'status dueDate completedAt assignedTo', populate: { path: 'assignedTo', select: 'name' } })
    .sort({ order: 1 })
    .lean();

  // Several steps can be for one return (prepare + file); it is filed once all of them are.
  const parts = new Map();
  for (const it of items) {
    const row = out.get(String(it.customerService));
    if (!row) continue;
    row.steps.total++;
    if (it.status === 'Completed') row.steps.completed++;
    const who = it.linkedTask?.assignedTo;
    if (who && !row.members.some((m) => String(m._id) === String(who._id))) row.members.push({ _id: who._id, name: who.name });
    const kind = returnOfStep(it.content);
    if (!kind) continue;
    const key = `${it.customerService}:${kind}`;
    if (!parts.has(key)) parts.set(key, { row, kind, list: [] });
    parts.get(key).list.push(it);
  }

  for (const { row, kind, list } of parts.values()) {
    const filed = list.every((i) => i.status === 'Completed');
    const open = list.find((i) => i.status !== 'Completed') || list.at(-1);
    const task = open.linkedTask;
    const doneOn = list.map((i) => (i.linkedTask?.completedAt ? dayKey(new Date(i.linkedTask.completedAt)) : i.status === 'Completed' ? dayKey(new Date(i.updatedAt)) : null));
    row[kind] = {
      status: filed ? 'filed' : list.some((i) => i.status !== 'Unscheduled') ? 'pending' : 'unassigned',
      filedOn: filed ? doneOn.filter(Boolean).sort().at(-1) || null : null,
      dueDate: task?.dueDate || open.date || null,
      member: task?.assignedTo ? { _id: task.assignedTo._id, name: task.assignedTo.name } : null,
      taskStatus: task?.status || null,
    };
  }
  return out;
}

// Whether a return of this GST work is filed; work without a step for it counts when all of it is done.
export const isReturnFiled = (cs, info, kind) => (info?.[kind] ? info[kind].status === 'filed' : cs.status === 'completed');
