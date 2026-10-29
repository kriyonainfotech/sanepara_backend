import { CalendarException } from '../models/CalendarException.js';
import { isSunday, todayKey } from '../utils/dates.js';

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
export const istTime = (date = new Date()) => timeFmt.format(date); // 'HH:mm'
export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return h * 60 + m;
};
// 'YYYY-MM-DD' + 'HH:mm' (India) → Date
export const istDate = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
export const round2 = (n) => Math.round(n * 100) / 100;

export const lateBy = (inTime, shiftStart) => Math.max(0, toMinutes(inTime) - toMinutes(shiftStart || '09:00'));

// Hours worked → day status, using the member's own thresholds.
export function statusFor(hours, user) {
  const full = user?.fullDayHours ?? 8;
  const half = user?.halfDayHours ?? 4;
  if (hours >= full) return 'Full Day';
  if (hours >= half) return 'Half Day';
  return 'Absent';
}

// Recalculate hours / status / lateness from the stored times.
export function recompute(record, user, { keepStatus = false } = {}) {
  if (record.inTime) {
    record.lateMinutes = lateBy(record.inTime, user?.shiftStart);
    record.isLate = record.lateMinutes > 0;
    record.clockIn = istDate(record.date, record.inTime);
  }
  if (record.inTime && record.outTime) {
    let mins = toMinutes(record.outTime) - toMinutes(record.inTime);
    if (mins < 0) mins = 0;
    record.totalHours = round2(mins / 60);
    record.clockOut = istDate(record.date, record.outTime);
    if (!keepStatus) record.status = statusFor(record.totalHours, user);
  } else if (record.inTime && !record.outTime) {
    record.totalHours = 0;
    record.clockOut = undefined;
    if (!keepStatus) record.status = 'Working';
  }
  return record;
}

export async function exceptionsBetween(from, to) {
  return CalendarException.find({ date: { $gte: from, $lte: to } }).lean();
}

// Is the office open on `day`? Sundays are off unless marked Working Sunday;
// other days are open unless marked Holiday.
export function dayInfo(day, exceptions) {
  const ex = exceptions.find((e) => e.date === day);
  if (isSunday(day)) return { working: ex?.type === 'Working Sunday', holiday: null, sunday: true, exception: ex };
  if (ex?.type === 'Holiday') return { working: false, holiday: ex, sunday: false, exception: ex };
  return { working: true, holiday: null, sunday: false, exception: ex };
}

export async function isWorkingToday() {
  const day = todayKey();
  return dayInfo(day, await exceptionsBetween(day, day));
}
