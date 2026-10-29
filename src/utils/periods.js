// GST work periods: 'YYYY-MM' for a monthly return, 'YYYY-Qn' for a calendar
// quarter (Q1 = Jan–Mar … Q4 = Oct–Dec), used by QRMP and Composition returns.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthKey = (y, m) => {
  const d = new Date(Date.UTC(y, m - 1, 1)); // m may be 0 or 13; Date rolls it over
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// The month before the one `day` ('YYYY-MM-DD') falls in.
export const prevMonthOf = (day) => {
  const [y, m] = day.split('-').map(Number);
  return monthKey(y, m - 1);
};

// The quarter that ended just before `day`'s month, or null when `day` is not
// in a quarter's first month (quarterly returns are only due then).
export const prevQuarterOf = (day) => {
  const [y, m] = day.split('-').map(Number);
  if ((m - 1) % 3 !== 0) return null;
  return m === 1 ? `${y - 1}-Q4` : `${y}-Q${(m - 1) / 3}`;
};

export const isQuarterly = (returnType) => returnType !== 'Monthly';

// Period a return type's work is for when it is created on `day`.
export const workPeriodFor = (returnType, day) => (isQuarterly(returnType) ? prevQuarterOf(day) : prevMonthOf(day));

export const periodLabel = (period) => {
  if (!period) return '';
  const [y, part] = period.split('-');
  if (part.startsWith('Q')) {
    const q = Number(part.slice(1));
    return `${MONTHS[q * 3 - 3]}–${MONTHS[q * 3 - 1]} ${y}`;
  }
  return `${MONTHS[Number(part) - 1]} ${y}`;
};

// Last day ('YYYY-MM-DD') of the period.
export const periodEnd = (period) => {
  const [y, part] = period.split('-');
  const lastMonth = part.startsWith('Q') ? Number(part.slice(1)) * 3 : Number(part);
  return new Date(Date.UTC(Number(y), lastMonth, 0)).toISOString().slice(0, 10);
};
