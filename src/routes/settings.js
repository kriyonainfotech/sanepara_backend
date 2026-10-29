import { Router } from 'express';
import { getSetting, setSetting } from '../models/Setting.js';
import { protect, superAdminOnly } from '../middleware/auth.js';
import { getWhatsAppConfig, PROVIDER_PRESETS, sendWhatsApp, waNumber } from '../services/whatsapp.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

const router = Router();
router.use(protect);

const FIRM_FIELDS = ['name', 'address', 'phone', 'email', 'gstNumber', 'upiId', 'upiName', 'invoiceTerms'];

// Firm details are printed on invoices and pre-fill the Payment QR, so everyone can read them.
router.get(
  '/firm',
  asyncHandler(async (_req, res) => {
    res.json({ data: await getSetting('firm') });
  })
);

router.put(
  '/firm',
  superAdminOnly,
  asyncHandler(async (req, res) => {
    const value = Object.fromEntries(FIRM_FIELDS.map((k) => [k, String(req.body[k] ?? '').trim()]));
    if (!value.name) throw new HttpError(400, 'Firm name is required');
    if (value.upiId && !/^[\w.-]+@[\w.-]+$/.test(value.upiId)) throw new HttpError(400, 'Enter a valid UPI ID (e.g. name@bank)');
    value.gstNumber = value.gstNumber.toUpperCase();
    res.json({ message: 'Firm details saved', data: await setSetting('firm', value, req.user._id) });
  })
);

// WhatsApp API — the key never goes back to the browser, only its last 4 characters.
const maskKey = (k = '') => (k ? `••••${k.slice(-4)}` : '');
const publicWhatsApp = (c) => ({ ...c, apiKey: '', apiKeyMasked: maskKey(c.apiKey), hasKey: Boolean(c.apiKey), presets: PROVIDER_PRESETS });

router.get(
  '/whatsapp',
  superAdminOnly,
  asyncHandler(async (_req, res) => {
    res.json({ data: publicWhatsApp(await getWhatsAppConfig()) });
  })
);

router.put(
  '/whatsapp',
  superAdminOnly,
  asyncHandler(async (req, res) => {
    const b = req.body;
    const current = await getWhatsAppConfig();
    const str = (k) => String(b[k] ?? '').trim();
    const value = {
      enabled: Boolean(b.enabled),
      provider: ['instantbroadcast', 'meta', 'custom'].includes(b.provider) ? b.provider : 'custom',
      endpoint: str('endpoint'),
      // Blank key field = keep the saved key.
      apiKey: str('apiKey') || current.apiKey,
      authType: b.authType === 'bearer' ? 'bearer' : 'query',
      authParam: str('authParam') || 'token',
      wrapKey: str('wrapKey'),
      templateName: str('templateName'),
      templateLang: str('templateLang') || 'en',
    };
    if (value.endpoint && !/^https?:\/\/\S+$/.test(value.endpoint)) throw new HttpError(400, 'Enter a valid endpoint URL (https://...)');
    if (value.enabled && !value.endpoint) throw new HttpError(400, 'Endpoint URL is required');
    if (value.enabled && !value.apiKey) throw new HttpError(400, 'API key / token is required');
    await setSetting('whatsapp', value, req.user._id);
    res.json({ message: 'WhatsApp settings saved', data: publicWhatsApp(await getWhatsAppConfig()) });
  })
);

// Sends one message with the saved settings, so a new key / provider can be checked.
router.post(
  '/whatsapp/test',
  superAdminOnly,
  asyncHandler(async (req, res) => {
    const phone = String(req.body.phone || '');
    if (!waNumber(phone)) throw new HttpError(400, 'Enter a valid mobile number');
    const [config, firm] = await Promise.all([getWhatsAppConfig(), getSetting('firm')]);
    try {
      const result = await sendWhatsApp(phone, `Test message from ${firm.name} CRM. WhatsApp API is working.`, ['Test', 'purchase bills and sales bills', 'this month'], { ...config, enabled: true });
      res.json({ message: 'Test message sent', result });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  })
);

export default router;
