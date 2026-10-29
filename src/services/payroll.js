import { addDaysKey, todayKey } from '../utils/dates.js';
import { dayInfo } from './attendance.js';

export const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
};

export function eachDay(from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDaysKey(d, 1)) days.push(d);
  return days;
}

/**
 * Salary & attendance summary for one member in one month.
 * Per-day rate = monthly salary ÷ working days in the month (Sundays off,
 * holidays removed, working Sundays added). Full Day earns 1 rate, Half Day ½,
 * a paid holiday earns 1 rate. Only days up to today count.
 */
export function summarize(user, month, records, exceptions) {
  const [from, to] = monthBounds(month);
  const today = todayKey();
  const joined = user.joiningDate ? new Date(user.joiningDate).toISOString().slice(0, 10) : null;
  const allDays = eachDay(from, to);
  const workingDays = allDays.filter((d) => dayInfo(d, exceptions).working);
  const paidHolidays = allDays.filter((d) => dayInfo(d, exceptions).holiday?.isPaid);
  const payableDays = workingDays.length + paidHolidays.length;
  const salary = user.monthlySalary || 0;
  const dailyRate = payableDays ? salary / payableDays : 0;

  const byDay = Object.fromEntries(records.map((r) => [r.date, r]));
  const s = { present: 0, full: 0, half: 0, absent: 0, leave: 0, late: 0, lateMinutes: 0, holidays: 0, paidDays: 0, workingPassed: 0, totalHours: 0 };

  for (const d of allDays) {
    if (d > today || (joined && d < joined)) continue;
    const info = dayInfo(d, exceptions);
    const r = byDay[d];
    if (info.working) s.workingPassed++;
    if (r?.isLate && (r.status === 'Full Day' || r.status === 'Half Day' || r.status === 'Working')) {
      s.late++;
      s.lateMinutes += r.lateMinutes || 0;
    }
    if (r) s.totalHours += r.totalHours || 0;

    if (r?.status === 'Full Day' || (r?.status === 'Working' && d === today)) {
      s.full++; s.present++; s.paidDays += 1;
    } else if (r?.status === 'Half Day') {
      s.half++; s.present++; s.paidDays += info.holiday?.isPaid ? 1 : 0.5;
    } else if (info.holiday) {
      s.holidays++;
      if (info.holiday.isPaid) s.paidDays += 1;
    } else if (info.working && d < today) {
      if (r?.status === 'Leave') s.leave++;
      else s.absent++; // Absent record or no record at all
    }
  }

  return {
    ...s,
    totalHours: Math.round(s.totalHours * 100) / 100,
    workingDays: workingDays.length,
    payableDays,
    salary,
    dailyRate: Math.round(dailyRate * 100) / 100,
    earned: Math.round(dailyRate * s.paidDays),
  };
}
