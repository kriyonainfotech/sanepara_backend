import { Router } from 'express';
import mongoose from 'mongoose';
import { BillReminder } from '../models/BillReminder.js';
import { GstFiling } from '../models/GstFiling.js';
import { getSetting, setSetting } from '../models/Setting.js';
import { protect, can } from '../middleware/auth.js';
import { getWhatsAppConfig, isWhatsAppConfigured, sendWhatsApp, waLink, waNumber } from '../services/whatsapp.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { todayKey } from '../utils/dates.js';

const router = Router();
router.use(protect);

const isMonth = (m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Bills of last month are collected this month, so that is the default.
const defaultMonth = () => {
  const [y, m] = todayKey().split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

const pendingBills = (r) =>
  [!r.purchase?.received && 'purchase bills', !r.sales?.received && 'sales bills'].filter(Boolean).join(' and ');

function buildMessage(template, row, firm) {
  const c = row.customer;
  const vars = { name: c.contactPerson || c.businessName, business: c.businessName, month: monthName(row.month), bills: pendingBills(row), firm: firm.name };
  return { text: template.replace(/\{(\w+)\}/g, (all, k) => vars[k] ?? all), params: [vars.name, vars.bills, vars.month] };
}

// Make sure every running-GST customer has a row for the month.
async function ensureRows(month) {
  const running = await GstFiling.find({ isRunning: true }).distinct('customer');
  const existing = new Set((await BillReminder.find({ month, customer: { $in: running } }).distinct('customer')).map(String));
  const missing = running.filter((id) => !existing.has(String(id)));
  if (missing.length) await BillReminder.insertMany(missing.map((customer) => ({ month, customer })), { ordered: false }).catch((e) => { if (e.code !== 11000) throw e; });
  return running;
}

const populate = (q) => q.populate('customer', 'businessName contactPerson phone gstNumber').populate('sends.by', 'name');

router.get(
  '/',
  can('reminders', 'view'),
  asyncHandler(async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : defaultMonth();
    const running = await ensureRows(month);
    const [rows, settings] = await Promise.all([populate(BillReminder.find({ month, customer: { $in: running } })).lean(), getSetting('reminders')]);
    rows.sort((a, b) => (a.customer?.businessName || '').localeCompare(b.customer?.businessName || ''));
    const done = rows.filter((r) => r.purchase.received && r.sales.received).length;
    res.json({
      month,
      data: rows.map((r) => ({ ...r, hasMobile: Boolean(waNumber(r.customer?.phone)) })),
      stats: {
        total: rows.length,
        complete: done,
        pending: rows.length - done,
        purchasePending: rows.filter((r) => !r.purchase.received).length,
        salesPending: rows.filter((r) => !r.sales.received).length,
      },
      template: settings.template,
      whatsappApi: await isWhatsAppConfigured(),
    });
  })
);

// Mark purchase / sales bills received (or undo).
router.put(
  '/:id/mark',
  can('reminders', 'mark'),
  asyncHandler(async (req, res) => {
    const row = await BillReminder.findById(req.params.id);
    if (!row) throw new HttpError(404, 'Not found');
    for (const k of ['purchase', 'sales']) {
      if (typeof req.body[k] !== 'boolean') continue;
      row[k] = req.body[k] ? { received: true, receivedOn: todayKey(), by: req.user._id } : { received: false };
    }
    await row.save();
    res.json({ message: 'Updated', data: await populate(BillReminder.findById(row._id)) });
  })
);

router.put(
  '/settings',
  can('reminders', 'send'),
  asyncHandler(async (req, res) => {
    const template = String(req.body.template || '').trim();
    if (!template) throw new HttpError(400, 'Write the reminder message');
    res.json({ message: 'Message saved', data: await setSetting('reminders', { template }, req.user._id) });
  })
);

// Send reminders to the given rows. Customers who have sent both bills are
// skipped, so nobody is reminded again after their data arrives.
router.post(
  '/send',
  can('reminders', 'send'),
  asyncHandler(async (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter((id) => mongoose.isValidObjectId(id));
    if (!ids.length) throw new HttpError(400, 'Select customers to remind');
    const [rows, settings, firm] = await Promise.all([populate(BillReminder.find({ _id: { $in: ids } })), getSetting('reminders'), getSetting('firm')]);
    const waConfig = await getWhatsAppConfig();
    const useApi = await isWhatsAppConfigured();
    const results = [];
    for (const row of rows) {
      const name = row.customer?.businessName;
      if (row.purchase.received && row.sales.received) { results.push({ id: row._id, name, skipped: 'Bills already received' }); continue; }
      if (!waNumber(row.customer?.phone)) { results.push({ id: row._id, name, error: 'No valid mobile number' }); continue; }
      const { text, params } = buildMessage(settings.template, row, firm);
      if (useApi) {
        try {
          await sendWhatsApp(row.customer.phone, text, params, waConfig);
          row.sends.push({ channel: 'api', ok: true, by: req.user._id });
          results.push({ id: row._id, name, sent: true });
        } catch (e) {
          row.sends.push({ channel: 'api', ok: false, error: e.message, by: req.user._id });
          results.push({ id: row._id, name, error: e.message, link: waLink(row.customer.phone, text) });
        }
      } else {
        row.sends.push({ channel: 'link', ok: true, by: req.user._id });
        results.push({ id: row._id, name, link: waLink(row.customer.phone, text) });
      }
      await row.save();
    }
    const sent = results.filter((r) => r.sent).length;
    const links = results.filter((r) => r.link && !r.error).length;
    res.json({
      message: useApi ? `${sent} reminder${sent === 1 ? '' : 's'} sent on WhatsApp` : `${links} WhatsApp message${links === 1 ? '' : 's'} ready to send`,
      whatsappApi: useApi,
      results,
    });
  })
);

export default router;
