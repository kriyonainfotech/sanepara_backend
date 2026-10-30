// Single source of truth for what can be permitted. The Roles & Permissions
// page renders this catalog, and routes check against these keys.
// A user always has access to their *own* attendance, tasks and incentive —
// these permissions control access to everyone else's data.

const CRUD = [
  { key: 'view', label: 'View' },
  { key: 'create', label: 'Create' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
];

export const PERMISSION_CATALOG = [
  {
    group: 'Overview',
    modules: [
      { key: 'dashboard', label: 'Dashboard', description: 'Business summary and team performance', actions: [{ key: 'view', label: 'View' }] },
      { key: 'reports', label: 'Reports & Matrix', description: 'Team performance and month-wise service matrix', actions: [{ key: 'view', label: 'View' }] },
    ],
  },
  {
    group: 'Operations',
    modules: [
      { key: 'customers', label: 'Customers', description: 'Customer database', actions: CRUD },
      {
        key: 'services',
        label: 'Services',
        description: 'Services, task lists and assigning them to customers',
        actions: [...CRUD, { key: 'assign', label: 'Assign to customer' }],
      },
      { key: 'schedule', label: 'Schedule Management', description: 'Schedule customer work items as tasks', actions: [{ key: 'view', label: 'View' }, { key: 'manage', label: 'Schedule / edit' }] },
      {
        key: 'tasks',
        label: 'Tasks Management',
        description: "Everyone's tasks, daily task rules and checklist templates",
        actions: [...CRUD, { key: 'rituals', label: 'Daily task rules' }, { key: 'templates', label: 'Checklist templates' }],
      },
      { key: 'gst_filing', label: 'Running GST Filing', description: 'Stop / resume filing for customers, monthly GST work settings', actions: [{ key: 'view', label: 'View' }, { key: 'manage', label: 'Stop / resume' }] },
      { key: 'compliance', label: 'Compliance Calendar', description: 'GST / ITR / TDS / trademark due dates and alerts', actions: [{ key: 'view', label: 'View' }, { key: 'manage', label: 'Add / mark done / move dates' }] },
      {
        key: 'reminders',
        label: 'Monthly Reminders',
        description: 'Purchase / sales bill reminders',
        actions: [{ key: 'view', label: 'View' }, { key: 'mark', label: 'Mark received' }, { key: 'send', label: 'Send WhatsApp' }],
      },
    ],
  },
  {
    group: 'Finance',
    modules: [
      { key: 'sales', label: 'Sales', description: 'Sales, payments received, outstanding, customer ledger', actions: [...CRUD, { key: 'collect', label: 'Record payments' }] },
      { key: 'b2b', label: 'B2B Partners', description: 'Partners, percentages, commission and payouts (Edit = pay out)', actions: CRUD },
      { key: 'collection', label: 'Collection', description: 'Collection, reserves, daily limit and goals', actions: [{ key: 'view', label: 'View' }, { key: 'manage', label: 'Manage' }] },
      { key: 'expenses', label: 'Expenses', description: 'Expense entries', actions: CRUD },
      { key: 'banks', label: 'Bank & Cash', description: 'Bank / cash accounts, balances, statements, money in / out and transfers', actions: CRUD },
      { key: 'invoices', label: 'Invoices', description: 'Sales invoices', actions: [{ key: 'view', label: 'View' }, { key: 'create', label: 'Create' }] },
      { key: 'payment_qr', label: 'Payment QR', description: 'Generate UPI payment QR', actions: [{ key: 'use', label: 'Use' }] },
    ],
  },
  {
    group: 'Team',
    modules: [
      { key: 'team', label: 'Team Members', description: 'Team accounts and salary details', actions: [{ key: 'view', label: 'View' }, { key: 'create', label: 'Create' }, { key: 'edit', label: 'Edit' }, { key: 'delete', label: 'Delete' }] },
      { key: 'attendance', label: 'Attendance (all members)', description: "Everyone's attendance, monthly report, holidays", actions: [{ key: 'view', label: 'View' }, { key: 'edit', label: 'Mark / edit' }] },
      { key: 'payroll', label: 'Payroll', description: 'Salary from attendance, salary payments', actions: [{ key: 'view', label: 'View' }, { key: 'manage', label: 'Record payments' }] },
      { key: 'incentives', label: 'Incentives (all members)', description: 'Referral incentives of everyone', actions: [{ key: 'view', label: 'View' }, { key: 'manage', label: 'Manage' }] },
      { key: 'sop', label: 'SOP Management', description: 'Business SOPs (step-by-step procedures)', actions: [{ key: 'view', label: 'View all' }, { key: 'manage', label: 'Create / assign' }] },
      { key: 'rules', label: 'Rule Management', description: 'Business rules', actions: [{ key: 'view', label: 'View all' }, { key: 'manage', label: 'Create / assign' }] },
    ],
  },
];

export const ALL_MODULES = PERMISSION_CATALOG.flatMap((g) => g.modules);

export const fullPermissions = () =>
  Object.fromEntries(ALL_MODULES.map((m) => [m.key, m.actions.map((a) => a.key)]));

export const DEFAULT_PERMISSIONS = {
  admin: fullPermissions(),
  team: {
    dashboard: ['view'],
    customers: ['view', 'create'],
    services: ['view'],
    reminders: ['view', 'mark'],
    compliance: ['view'],
    payment_qr: ['use'],
  },
};

// Drop unknown modules/actions so stored data always matches the catalog.
export function sanitizePermissions(input = {}) {
  const out = {};
  for (const m of ALL_MODULES) {
    const allowed = new Set(m.actions.map((a) => a.key));
    const picked = (Array.isArray(input[m.key]) ? input[m.key] : []).filter((a) => allowed.has(a));
    if (picked.length) out[m.key] = [...new Set(picked)];
  }
  return out;
}
