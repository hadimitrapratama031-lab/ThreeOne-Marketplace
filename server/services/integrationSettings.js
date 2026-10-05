import { Setting } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import { isValidEmail, normalizeWhatsapp } from '../lib/phone.js';
import { isFreemailAddress } from '../lib/emailDomains.js';
import { config } from '../config/env.js';

/**
 * Pengaturan Resend + Fonnte + notifikasi (Admin Web) — struktur data mengikuti IntegrationSettings project lama:
 * fonnte{enabled,token}, resend{enabled,apiKey,fromEmail,fromName,replyTo}, notifications{whatsappEnabled,emailEnabled,events},
 * templates{whatsapp,email} (kosong = template bawaan). Disimpan di koleksi settings (key "integrations"), rahasia dienkripsi
 * AES-256-GCM dan TIDAK pernah dikembalikan ke browser. Tidak ada cache: setiap pengiriman membaca pengaturan terbaru dari MongoDB,
 * jadi perubahan dari Admin Web langsung dipakai. Key ini sengaja bukan bagian SETTING_KEYS (tidak ikut ke Marketplace publik).
 */
const KEY = 'integrations';
export const EVENTS = ['orderCreated', 'paymentSuccess', 'paymentFailed', 'paymentExpired'];

const lastTest = () => ({ status: 'untested', at: null, message: '' });
const DEFAULT = () => ({
  fonnte: { enabled: false, tokenEnc: '', testTarget: '', lastTest: lastTest() },
  resend: { enabled: false, apiKeyEnc: '', fromEmail: '', fromName: '', replyTo: '', webhookSecretEnc: '', testTo: '', lastTest: lastTest() },
  notifications: { whatsappEnabled: true, emailEnabled: true, events: Object.fromEntries(EVENTS.map((e) => [e, true])) },
  templates: {
    whatsapp: Object.fromEntries(EVENTS.map((e) => [e, ''])),
    email: Object.fromEntries(EVENTS.map((e) => [e, { subject: '', html: '' }])),
  },
});

async function load() {
  const doc = await Setting.findOne({ key: KEY }).lean();
  const v = doc?.value || {};
  const d = DEFAULT();
  return {
    fonnte: { ...d.fonnte, ...(v.fonnte || {}), lastTest: { ...d.fonnte.lastTest, ...(v.fonnte?.lastTest || {}) } },
    resend: { ...d.resend, ...(v.resend || {}), lastTest: { ...d.resend.lastTest, ...(v.resend?.lastTest || {}) } },
    notifications: { ...d.notifications, ...(v.notifications || {}), events: { ...d.notifications.events, ...(v.notifications?.events || {}) } },
    templates: {
      whatsapp: { ...d.templates.whatsapp, ...(v.templates?.whatsapp || {}) },
      email: Object.fromEntries(EVENTS.map((e) => [e, { ...d.templates.email[e], ...(v.templates?.email?.[e] || {}) }])),
    },
  };
}
const persist = (value) => Setting.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true, new: true });

/* ---------- Dibaca backend saat mengirim (tidak pernah ke browser) ---------- */
export async function getFonnteConfig() {
  const s = (await load()).fonnte;
  const token = (s.tokenEnc ? decryptSecret(s.tokenEnc) : '') || config.envFallback.fonnteToken;
  return { enabled: Boolean(s.enabled) && Boolean(token), token };
}
export async function getResendConfig() {
  const s = (await load()).resend;
  const e = config.envFallback;
  const apiKey = (s.apiKeyEnc ? decryptSecret(s.apiKeyEnc) : '') || e.resendApiKey;
  return {
    enabled: Boolean(s.enabled) && Boolean(apiKey),
    apiKey,
    fromEmail: s.fromEmail || e.resendFromEmail,
    fromName: s.fromName || e.resendFromName,
    replyTo: s.replyTo || e.resendReplyTo || '',   // kosong = header Reply-To tidak dikirim
  };
}
export async function getResendWebhookSecret() {
  const s = (await load()).resend;
  return (s.webhookSecretEnc ? decryptSecret(s.webhookSecretEnc) : '') || config.envFallback.resendWebhookSecret;
}
export async function getNotificationPrefs() {
  const s = await load();
  return { ...s.notifications, templates: s.templates };
}

/* ---------- Bentuk untuk Admin Web (tanpa rahasia) ---------- */
const hint = (plain) => (plain ? `••••••••${plain.slice(-4)}` : '');
export async function getAdminView() {
  const s = await load();
  const e = config.envFallback;
  const token = s.fonnte.tokenEnc ? decryptSecret(s.fonnte.tokenEnc) : '';
  const apiKey = s.resend.apiKeyEnc ? decryptSecret(s.resend.apiKeyEnc) : '';
  const hook = s.resend.webhookSecretEnc ? decryptSecret(s.resend.webhookSecretEnc) : '';
  return {
    fonnte: {
      enabled: s.fonnte.enabled,
      tokenSet: Boolean(s.fonnte.tokenEnc), tokenReadable: !s.fonnte.tokenEnc || Boolean(token), tokenHint: hint(token),
      fromEnv: !s.fonnte.tokenEnc && Boolean(e.fonnteToken),
      configured: Boolean(token || e.fonnteToken),
      testTarget: s.fonnte.testTarget, lastTest: s.fonnte.lastTest,
    },
    resend: {
      enabled: s.resend.enabled,
      apiKeySet: Boolean(s.resend.apiKeyEnc), apiKeyReadable: !s.resend.apiKeyEnc || Boolean(apiKey), apiKeyHint: hint(apiKey),
      fromEnv: !s.resend.apiKeyEnc && Boolean(e.resendApiKey),
      configured: Boolean(apiKey || e.resendApiKey),
      fromEmail: s.resend.fromEmail || e.resendFromEmail, fromName: s.resend.fromName || e.resendFromName, replyTo: s.resend.replyTo || e.resendReplyTo,
      webhookSecretSet: Boolean(s.resend.webhookSecretEnc) || Boolean(e.resendWebhookSecret), webhookSecretHint: hint(hook),
      testTo: s.resend.testTo, lastTest: s.resend.lastTest,
    },
    notifications: s.notifications,
    templates: s.templates,
  };
}

/* ---------- Simpan ---------- */
const bad = (fields, message = 'Data tidak valid') => new HttpError(422, message, { fields });

export async function saveFonnte(input) {
  const s = await load();
  const f = { ...s.fonnte };
  if (input.clearToken) f.tokenEnc = '';
  if (input.token) f.tokenEnc = encryptSecret(input.token);
  if (input.testTarget !== undefined) {
    if (input.testTarget && !normalizeWhatsapp(input.testTarget)) throw bad({ testTarget: 'Nomor WhatsApp tidak valid (contoh: 0812 3456 7890)' });
    f.testTarget = input.testTarget ? normalizeWhatsapp(input.testTarget) : '';
  }
  f.enabled = Boolean(input.enabled);
  if (f.enabled && !f.tokenEnc && !config.envFallback.fonnteToken) throw bad({ token: 'Isi token Fonnte sebelum mengaktifkan' }, 'Token Fonnte belum diisi.');
  await persist({ ...s, fonnte: f });
  return getAdminView();
}

export async function saveResend(input) {
  const s = await load();
  const r = { ...s.resend };
  if (input.clearApiKey) r.apiKeyEnc = '';
  if (input.apiKey) r.apiKeyEnc = encryptSecret(input.apiKey);
  if (input.clearWebhookSecret) r.webhookSecretEnc = '';
  if (input.webhookSecret) r.webhookSecretEnc = encryptSecret(input.webhookSecret);
  if (input.fromEmail !== undefined) {
    if (input.fromEmail && !isValidEmail(input.fromEmail)) throw bad({ fromEmail: 'Alamat email pengirim tidak valid' });
    // Ditolak saat disimpan (bukan hanya saat kirim): domain gratisan tidak akan pernah lolos SPF/DKIM atas nama toko
    if (input.fromEmail && isFreemailAddress(input.fromEmail)) throw bad({ fromEmail: 'Jangan pakai email gratisan (Gmail/Yahoo/Outlook). Gunakan alamat di domain toko yang sudah diverifikasi di Resend, mis. noreply@namatoko.com' });
    r.fromEmail = input.fromEmail;
  }
  if (input.fromName !== undefined) r.fromName = input.fromName;
  if (input.replyTo !== undefined) {
    if (input.replyTo && !isValidEmail(input.replyTo)) throw bad({ replyTo: 'Alamat Reply-To tidak valid' });
    r.replyTo = input.replyTo;
  }
  if (input.testTo !== undefined) {
    if (input.testTo && !isValidEmail(input.testTo)) throw bad({ testTo: 'Email uji tidak valid' });
    r.testTo = input.testTo;
  }
  r.enabled = Boolean(input.enabled);
  if (r.enabled) {
    const fields = {};
    if (!r.apiKeyEnc && !config.envFallback.resendApiKey) fields.apiKey = 'Isi API key Resend sebelum mengaktifkan';
    if (!(r.fromEmail || config.envFallback.resendFromEmail)) fields.fromEmail = 'Wajib diisi untuk mengaktifkan';
    if (Object.keys(fields).length) throw bad(fields, 'Lengkapi pengaturan Resend sebelum mengaktifkan.');
  }
  await persist({ ...s, resend: r });
  return getAdminView();
}

export async function saveNotificationPrefs(input) {
  const s = await load();
  await persist({ ...s, notifications: { whatsappEnabled: input.whatsappEnabled, emailEnabled: input.emailEnabled, events: { ...s.notifications.events, ...input.events } } });
  return getAdminView();
}

/** Template kustom: kosong = pakai template bawaan project lama (tidak diubah). */
export async function saveTemplates(input) {
  const s = await load();
  const t = { whatsapp: { ...s.templates.whatsapp }, email: { ...s.templates.email } };
  for (const e of EVENTS) {
    if (input.whatsapp?.[e] !== undefined) t.whatsapp[e] = input.whatsapp[e];
    if (input.email?.[e]) t.email[e] = { subject: input.email[e].subject ?? t.email[e].subject, html: input.email[e].html ?? t.email[e].html };
  }
  await persist({ ...s, templates: t });
  return getAdminView();
}

export async function recordTest(provider, ok, message) {
  const s = await load();
  s[provider].lastTest = { status: ok ? 'success' : 'error', at: new Date(), message: String(message || '').slice(0, 300) };
  await persist(s);
  return getAdminView();
}
