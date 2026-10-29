import mongoose from 'mongoose';
import { GstFiling } from '../models/GstFiling.js';
import { CustomerService } from '../models/CustomerService.js';
import { ScheduleItem } from '../models/ScheduleItem.js';
import { Service } from '../models/Service.js';
import { Task } from '../models/Task.js';
import { User } from '../models/User.js';
import { getSetting } from '../models/Setting.js';
import { createItemsForAssignment, syncItemFromTask } from '../services/scheduleSync.js';
import { HttpError } from '../utils/asyncHandler.js';
import { todayKey } from '../utils/dates.js';
import { periodEnd, periodLabel, workPeriodFor } from '../utils/periods.js';

const TASK_TYPE = { team: 'Team', admin: 'Admin', superadmin: 'Personal' };

// `dueDay` of `day`'s month (clamped to the month's length), but never before `day`.
const dueDateIn = (day, dueDay) => {
  const [y, m] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const due = `${day.slice(0, 7)}-${String(Math.min(Math.max(Number(dueDay) || 1, 1), last)).padStart(2, '0')}`;
  return due < day ? day : due;
};

let running = false;

// Give every running GST customer this month's GST work (the configured service, for last
// month / last quarter). Each filing remembers the periods it already got, so this is safe to
// run any number of times. `manual` runs even before `createOnDay` and when switched off.
export async function createGstWork({ manual = false, userId } = {}) {
  if (running) return { created: 0 };
  running = true;
  try {
    const day = todayKey();
    const cfg = await getSetting('gstWork');
    if (!manual && (!cfg.enabled || Number(day.slice(8)) < (Number(cfg.createOnDay) || 1))) return { created: 0 };

    const service = mongoose.isValidObjectId(cfg.serviceId) ? await Service.findById(cfg.serviceId) : null;
    if (!service?.isActive || !service.tasks.length) {
      if (manual) throw new HttpError(400, 'Choose the GST service (with its task list) in the monthly GST work settings first');
      return { created: 0 };
    }
    const assignee = mongoose.isValidObjectId(cfg.assignTo) ? await User.findOne({ _id: cfg.assignTo, isActive: true }).select('role') : null;
    const by = userId || (await User.findOne({ role: 'superadmin', isActive: true }).select('_id'))?._id;
    if (!by) return { created: 0 };

    let created = 0;
    let startedLater = 0; // filing began after the period ended; their work starts next period
    for (const f of await GstFiling.find({ isRunning: true })) {
      const period = workPeriodFor(f.returnType, day);
      if (!period || f.workPeriods.includes(period)) continue;
      if (f.startedOn > periodEnd(period)) {
        startedLater++;
        continue;
      }
      const label = periodLabel(period);
      const cs = await CustomerService.create({
        customer: f.customer,
        service: service._id,
        assignedBy: by,
        gstFiling: f._id,
        gstReturnType: f.returnType,
        period,
        periodLabel: label,
      });
      await createItemsForAssignment(cs, service, by);
      await ScheduleItem.updateMany({ customerService: cs._id }, { description: `${f.returnType} GST return for ${label}` });

      if (assignee) {
        const items = await ScheduleItem.find({ customerService: cs._id }).sort({ order: 1 });
        const tasks = await Task.insertMany(
          items.map((i) => ({
            title: i.content,
            description: i.description,
            type: TASK_TYPE[assignee.role] || 'Team',
            status: 'Pending',
            dueDate: dueDateIn(day, cfg.dueDay),
            taskCategory: 'GST',
            assignedTo: assignee._id,
            createdBy: by,
            client: f.customer,
            scheduleItem: i._id,
            customerService: cs._id,
            order: i.order,
          }))
        );
        for (const t of tasks) await syncItemFromTask(t);
      }
      await GstFiling.updateOne({ _id: f._id }, { $addToSet: { workPeriods: period } });
      created++;
    }
    if (created) console.log(`[GST work] Created GST work for ${created} customers`);
    return { created, startedLater };
  } finally {
    running = false;
  }
}

export function startGstWorkJob() {
  const run = () => createGstWork().catch((e) => console.error('[GST work] Failed:', e.message));
  run();
  setInterval(run, 15 * 60 * 1000);
}
