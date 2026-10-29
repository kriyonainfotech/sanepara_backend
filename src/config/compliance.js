// Statutory due dates shown on the Compliance Calendar. Government extensions are
// handled per occurrence from the calendar ("Change date"), so these stay the regular dates.
//  - months: months (1-12) the date falls in; omitted = every month
//  - appliesTo: GST return types whose running customers this concerns
//  - workPeriod(day): the GST work period ('YYYY-MM' / 'YYYY-Qn') it is for, to show
//    progress of the monthly GST work (jobs/gstWork.js)
//  - period(day): label of what the return is for
import { periodLabel, prevMonthOf, prevQuarterOf } from '../utils/periods.js';

const QUARTER_START = [1, 4, 7, 10];
const NOT_QUARTER_START = [2, 3, 5, 6, 8, 9, 11, 12];
const QRMP = 'Quarterly (QRMP)';

const monthPeriod = { workPeriod: prevMonthOf, period: (d) => periodLabel(prevMonthOf(d)) };
const quarterPeriod = { workPeriod: prevQuarterOf, period: (d) => periodLabel(prevQuarterOf(d)) };
// Financial year (Apr–Mar) that ended before `day`.
const lastFy = (day) => {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y - 1 : y - 2;
  return `FY ${start}-${String(start + 1).slice(2)}`;
};

export const COMPLIANCE_CATEGORIES = ['GST', 'Income Tax', 'TDS', 'Trademark', 'ROC', 'Other'];

export const COMPLIANCE_RULES = [
  // GST — monthly filers
  { key: 'gstr1', title: 'GSTR-1', category: 'GST', day: 11, appliesTo: ['Monthly'], description: 'Sales (outward supplies) return of monthly filers.', ...monthPeriod },
  { key: 'gstr3b', title: 'GSTR-3B', category: 'GST', day: 20, appliesTo: ['Monthly'], description: 'Summary return and tax payment of monthly filers.', ...monthPeriod },
  // GST — QRMP (quarterly) filers
  { key: 'pmt06', title: 'PMT-06 tax payment', category: 'GST', day: 25, months: NOT_QUARTER_START, appliesTo: [QRMP], description: 'Monthly tax payment by QRMP filers for the first two months of the quarter.', ...monthPeriod },
  { key: 'gstr1q', title: 'GSTR-1 (QRMP)', category: 'GST', day: 13, months: QUARTER_START, appliesTo: [QRMP], description: 'Quarterly sales return of QRMP filers.', ...quarterPeriod },
  { key: 'gstr3bq', title: 'GSTR-3B (QRMP)', category: 'GST', day: 22, months: QUARTER_START, appliesTo: [QRMP], description: 'Quarterly summary return. 22nd for Gujarat, Maharashtra and other Category-I states; 24th for Category-II states.', ...quarterPeriod },
  // GST — Composition
  { key: 'cmp08', title: 'CMP-08', category: 'GST', day: 18, months: QUARTER_START, appliesTo: ['Composition'], description: 'Quarterly tax payment statement of composition dealers.', ...quarterPeriod },
  { key: 'gstr4', title: 'GSTR-4 (annual)', category: 'GST', day: 30, months: [4], appliesTo: ['Composition'], description: 'Annual return of composition dealers.', period: lastFy },
  // GST — annual
  { key: 'gstr9', title: 'GSTR-9 / 9C (annual)', category: 'GST', day: 31, months: [12], appliesTo: ['Monthly', QRMP], description: 'Annual return (and reconciliation statement where turnover requires it).', period: lastFy },
  // Income tax
  { key: 'advtax', title: 'Advance tax instalment', category: 'Income Tax', day: 15, months: [3, 6, 9, 12], description: 'Advance tax instalment (15% / 45% / 75% / 100% of the year’s tax by Jun / Sep / Dec / Mar).' },
  { key: 'itr', title: 'ITR filing (non-audit)', category: 'Income Tax', day: 31, months: [7], description: 'Income tax returns of individuals and businesses not needing an audit.', period: lastFy },
  { key: 'taxaudit', title: 'Tax audit report', category: 'Income Tax', day: 30, months: [9], description: 'Tax audit report (Form 3CA / 3CB – 3CD).', period: lastFy },
  { key: 'itraudit', title: 'ITR filing (audit cases)', category: 'Income Tax', day: 31, months: [10], description: 'Income tax returns of businesses that need a tax audit.', period: lastFy },
  { key: 'itrlate', title: 'Belated / revised ITR', category: 'Income Tax', day: 31, months: [12], description: 'Last date for belated or revised income tax returns.', period: lastFy },
  // TDS
  { key: 'tdspay', title: 'TDS / TCS payment', category: 'TDS', day: 7, months: [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12], description: 'Deposit of TDS / TCS deducted last month.', period: (d) => periodLabel(prevMonthOf(d)) },
  { key: 'tdspaymar', title: 'TDS payment (March)', category: 'TDS', day: 30, months: [4], description: 'Deposit of TDS deducted in March.', period: (d) => periodLabel(prevMonthOf(d)) },
  { key: 'tdsreturn', title: 'TDS return (24Q / 26Q)', category: 'TDS', day: 31, months: [1, 5, 7, 10], description: 'Quarterly TDS returns.', period: (d) => periodLabel(prevQuarterOf(d) || `${d.slice(0, 4)}-Q1`) },
];
