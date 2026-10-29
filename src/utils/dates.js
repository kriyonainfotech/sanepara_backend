// Days are handled as 'YYYY-MM-DD' strings in India time so "today" matches the office.
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

export const dayKey = (date = new Date()) => fmt.format(date);
export const todayKey = () => dayKey();
export const isDayKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
export const isSunday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay() === 0;

export const addDaysKey = (key, n) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
