import { Attendance } from '../models/Attendance.js';
import { User } from '../models/User.js';
import { recompute, toMinutes } from '../services/attendance.js';
import { todayKey } from '../utils/dates.js';

// Anyone who forgot to clock out on an earlier day is clocked out at their
// shift end (or their clock-in time, if they came after the shift ended).
export async function runAutoClockOut() {
  const open = await Attendance.find({ date: { $lt: todayKey() }, inTime: { $exists: true, $ne: null }, $or: [{ outTime: null }, { outTime: { $exists: false } }] });
  for (const r of open) {
    const user = await User.findById(r.user).select('shiftStart shiftEnd fullDayHours halfDayHours');
    const end = user?.shiftEnd || '18:00';
    r.outTime = toMinutes(end) > toMinutes(r.inTime) ? end : r.inTime;
    r.autoClockOut = true;
    recompute(r, user);
    await r.save();
  }
  if (open.length) console.log(`[Attendance] Auto clocked out ${open.length} record(s)`);
}

export function startAutoClockOut() {
  const run = () => runAutoClockOut().catch((e) => console.error('[Attendance] Auto clock-out failed:', e.message));
  run();
  setInterval(run, 10 * 60 * 1000);
}
