// WhatsApp sending. Super Admin sets the provider in Settings → WhatsApp API
// (stored as the 'whatsapp' setting); .env keys are the fallback until then:
//  - InstantBroadcast: WHATSAPP_PROVIDER=instantbroadcast + INSTANTBROADCAST_TOKEN
//  - WhatsApp Cloud API (Meta): WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID
// Most WhatsApp gateways take the Cloud API message format, so a new provider
// only needs its endpoint, key, how the key is sent and whether the message is
// wrapped in a key (InstantBroadcast: { messageObject: {...} }).
// Messages started by the business need an approved template (body params:
// {{1}} name, {{2}} bills, {{3}} month). Not configured → wa.me click-to-send link.
import { Setting } from '../models/Setting.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

export const PROVIDER_PRESETS = {
  instantbroadcast: { endpoint: 'https://api.instantbroadcast.in/api/v1/send-message', authType: 'query', authParam: 'token', wrapKey: 'messageObject' },
  meta: { endpoint: `${GRAPH}/PHONE_NUMBER_ID/messages`, authType: 'bearer', authParam: '', wrapKey: '' },
};

function envConfig() {
  const e = process.env;
  const base = { enabled: false, provider: 'instantbroadcast', ...PROVIDER_PRESETS.instantbroadcast, apiKey: '', templateName: e.WHATSAPP_TEMPLATE_NAME || '', templateLang: e.WHATSAPP_TEMPLATE_LANG || 'en' };
  if (e.WHATSAPP_PROVIDER === 'instantbroadcast' && e.INSTANTBROADCAST_TOKEN) {
    return { ...base, enabled: true, endpoint: e.INSTANTBROADCAST_URL || base.endpoint, apiKey: e.INSTANTBROADCAST_TOKEN };
  }
  if (e.WHATSAPP_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID) {
    return { ...base, ...PROVIDER_PRESETS.meta, enabled: true, provider: 'meta', endpoint: `${GRAPH}/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`, apiKey: e.WHATSAPP_TOKEN };
  }
  return base;
}

export async function getWhatsAppConfig() {
  const doc = await Setting.findById('whatsapp').lean();
  return doc?.value ? { ...envConfig(), ...doc.value } : envConfig();
}

const ready = (c) => Boolean(c.enabled && c.endpoint && c.apiKey);
export const isWhatsAppConfigured = async () => ready(await getWhatsAppConfig());

// Indian numbers → 91XXXXXXXXXX. Returns null when it doesn't look like a mobile number.
export function waNumber(phone = '') {
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export const waLink = (phone, text) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;

export async function sendWhatsApp(phone, text, params = [], config) {
  const c = config || (await getWhatsAppConfig());
  if (!ready(c)) throw new Error('WhatsApp API is not set up');
  const to = waNumber(phone);
  if (!to) throw new Error('Invalid mobile number');

  // Outside the 24-hour customer service window WhatsApp only delivers approved templates.
  const message = c.templateName
    ? {
        to,
        type: 'template',
        template: {
          name: c.templateName,
          language: { code: c.templateLang || 'en' },
          components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }],
        },
      }
    : { to, type: 'text', text: { preview_url: false, body: text } };
  const body = c.wrapKey ? { [c.wrapKey]: message } : { messaging_product: 'whatsapp', ...message };

  const url = new URL(c.endpoint);
  const headers = { 'Content-Type': 'application/json' };
  if (c.authType === 'bearer') headers.Authorization = `Bearer ${c.apiKey}`;
  else url.searchParams.set(c.authParam || 'token', c.apiKey);

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  // Some gateways answer 200 with { status: false / success: false, message }.
  const failed = !res.ok || json.status === false || json.success === false || json.status === 'error' || json.error;
  if (failed) throw new Error(json.error?.message || (typeof json.error === 'string' && json.error) || json.message || `WhatsApp API error (${res.status})`);
  return json;
}
