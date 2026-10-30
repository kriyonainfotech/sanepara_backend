import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import customerRoutes from './routes/customers.js';
import serviceRoutes from './routes/services.js';
import dashboardRoutes from './routes/dashboard.js';
import permissionRoutes from './routes/permissions.js';
import scheduleRoutes from './routes/schedule.js';
import taskRoutes from './routes/tasks.js';
import checklistTemplateRoutes from './routes/checklistTemplates.js';
import dailyTaskRuleRoutes from './routes/dailyTaskRules.js';
import attendanceRoutes from './routes/attendance.js';
import payrollRoutes from './routes/payroll.js';
import salesRoutes from './routes/sales.js';
import b2bRoutes from './routes/b2b.js';
import settingsRoutes from './routes/settings.js';
import gstFilingRoutes from './routes/gstFiling.js';
import reminderRoutes from './routes/reminders.js';
import collectionRoutes from './routes/collection.js';
import expenseRoutes from './routes/expenses.js';
import invoiceRoutes from './routes/invoices.js';
import referralRoutes from './routes/referrals.js';
import sopRoutes from './routes/sops.js';
import reportRoutes from './routes/reports.js';
import complianceRoutes from './routes/compliance.js';
import bankRoutes from './routes/banks.js';

// CLIENT_URL can list several origins separated by commas; "*" matches one subdomain part,
// e.g. Vercel preview URLs: https://sanepara-frontend-*-kriyona-infotechs-projects.vercel.app
// Browsers send the origin without a trailing slash, so one in CLIENT_URL is ignored.
function allowedOrigins(value) {
  if (!value) return true;
  return value.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean).map((o) =>
    o.includes('*') ? new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`) : o);
}

export function createApp() {
  const app = express();
  app.use(cors({ origin: allowedOrigins(process.env.CLIENT_URL) }));
  app.use(express.json({ limit: '5mb' })); // customer imports send up to 2000 rows
  // Express 5 leaves req.body undefined when a request has no JSON body.
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });
  // API data changes all the time; keep browsers from caching it (a corrupt cache entry
  // showed up as ERR_CACHE_READ_FAILURE / "Network Error" on one customer).
  app.set('etag', false);
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/customers', customerRoutes);
  app.use('/api/services', serviceRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/permissions', permissionRoutes);
  app.use('/api/schedule', scheduleRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/checklist-templates', checklistTemplateRoutes);
  app.use('/api/daily-task-rules', dailyTaskRuleRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/payroll', payrollRoutes);
  app.use('/api/sales', salesRoutes);
  app.use('/api/b2b', b2bRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/gst-filing', gstFilingRoutes);
  app.use('/api/reminders', reminderRoutes);
  app.use('/api/collection', collectionRoutes);
  app.use('/api/expenses', expenseRoutes);
  app.use('/api/invoices', invoiceRoutes);
  app.use('/api/referrals', referralRoutes);
  app.use('/api/sops', sopRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/compliance', complianceRoutes);
  app.use('/api/banks', bankRoutes);

  app.use((_req, res) => res.status(404).json({ message: 'Route not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.name === 'ValidationError') {
      const first = Object.values(err.errors)[0];
      return res.status(400).json({ message: first?.message || 'Invalid data' });
    }
    if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid id' });
    if (err.code === 11000) return res.status(400).json({ message: 'This record already exists' });
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ message: err.status ? err.message : 'Something went wrong', ...(err.details && { details: err.details }) });
  });

  return app;
}
