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
  discord: { enabled: false, tokenEnc: '', guildId: '', channelId: '', adminUserId: '', liveChatDm: true, connection: { status: 'unchecked', botName: '', botId: '', at: null, message: '' }, lastTest: lastTest() },
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
    discord: { ...d.discord, ...(v.discord || {}), connection: { ...d.discord.connection, ...(v.discord?.connection || {}) }, lastTest: { ...d.discord.lastTest, ...(v.discord?.lastTest || {}) } },
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
/**
 * Konfigurasi Discord untuk backend (tidak pernah ke browser). Nilai Admin Web menang atas ENV; token dibaca dari MongoDB
 * (terenkripsi) setiap kali, jadi token/channel baru langsung dipakai tanpa restart. REST-only: tidak ada proses bot yang hidup terus.
 *   enabled = saklar Admin Web + token ada; ready = enabled + channel ada (cukup untuk notifikasi order);
 *   usable  = token + channel ada walau saklar mati (dipakai tombol uji agar kredensial baru bisa diverifikasi dulu).
 */
export async function getDiscordConfig() {
  const s = (await load()).discord;
  const e = config.envFallback;
  const token = (s.tokenEnc ? decryptSecret(s.tokenEnc) : '') || e.discordBotToken;
  const channelId = s.channelId || e.discordChannelId;
  return {
    enabled: Boolean(s.enabled) && Boolean(token), token,
    guildId: s.guildId || e.discordGuildId, channelId,
    adminUserId: s.adminUserId || e.discordAdminUserId,
    liveChatDm: s.liveChatDm !== false,
    ready: Boolean(s.enabled) && Boolean(token) && Boolean(channelId),
    usable: Boolean(token) && Boolean(channelId),
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
    discord: (() => {
      const d = s.discord;
      const dtoken = d.tokenEnc ? decryptSecret(d.tokenEnc) : '';
      return {
        enabled: d.enabled,
        tokenSet: Boolean(d.tokenEnc), tokenReadable: !d.tokenEnc || Boolean(dtoken), tokenHint: hint(dtoken),
        fromEnv: !d.tokenEnc && Boolean(e.discordBotToken),
        configured: Boolean((dtoken || e.discordBotToken) && (d.channelId || e.discordChannelId)),
        guildId: d.guildId || e.discordGuildId, channelId: d.channelId || e.discordChannelId, adminUserId: d.adminUserId || e.discordAdminUserId,
        liveChatDm: d.liveChatDm !== false,
        connection: d.connection, lastTest: d.lastTest,
      };
    })(),
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

const SNOWFLAKE = /^\d{17,20}$/;   // ID Discord (server/channel/user) selalu numerik, 17–20 digit
/** Token bot: tempelan "Bot xxx" dirapikan; bentuknya dicek longgar (3 bagian dipisah titik) agar format baru Discord tidak ikut ditolak. */
const cleanBotToken = (t) => String(t || '').trim().replace(/^bot\s+/i, '');
const looksLikeBotToken = (t) => /^[\w-]{15,}\.[\w-]{4,}\.[\w-]{20,}$/.test(t) && t.length <= 150;

export async function saveDiscord(input) {
  const s = await load();
  const d = { ...s.discord };
  const before = { token: d.tokenEnc, guildId: d.guildId, channelId: d.channelId };
  const fields = {};

  if (input.clearToken) d.tokenEnc = '';
  if (input.token) {
    const t = cleanBotToken(input.token);
    if (!looksLikeBotToken(t)) fields.token = 'Format token bot tidak dikenali. Salin ulang dari Discord Developer Portal → Bot → Reset Token.';
    else d.tokenEnc = encryptSecret(t);
  }
  for (const [k, label] of [['guildId', 'Guild ID'], ['channelId', 'Channel ID'], ['adminUserId', 'User ID admin']]) {
    if (input[k] === undefined) continue;
    const v = String(input[k]).trim();
    if (v && !SNOWFLAKE.test(v)) fields[k] = `${label} harus berupa angka 17–20 digit (Discord → Pengaturan → Advanced → Developer Mode → klik kanan → Copy ID).`;
    else d[k] = v;
  }
  d.liveChatDm = input.liveChatDm !== false;
  d.enabled = Boolean(input.enabled);
  if (Object.keys(fields).length) throw bad(fields);

  if (d.enabled) {
    const e = config.envFallback;
    if (!d.tokenEnc && !e.discordBotToken) fields.token = 'Isi token bot sebelum mengaktifkan';
    if (!(d.channelId || e.discordChannelId)) fields.channelId = 'Wajib diisi untuk mengaktifkan';
    if (Object.keys(fields).length) throw bad(fields, 'Lengkapi pengaturan Discord sebelum mengaktifkan.');
  }
  // Kredensial/tujuan berubah: status koneksi lama tidak lagi berlaku sampai diperiksa ulang
  if (before.token !== d.tokenEnc || before.guildId !== d.guildId || before.channelId !== d.channelId) {
    d.connection = { status: 'unchecked', botName: '', botId: '', at: null, message: '' };
  }
  await persist({ ...s, discord: d });
  return getAdminView();
}

/** Hasil pemeriksaan koneksi terakhir (token valid, bot ada di server, channel terjangkau). */
export async function recordDiscordConnection({ ok, botName = '', botId = '', message = '' }) {
  const s = await load();
  s.discord.connection = { status: ok ? 'connected' : 'error', botName, botId, at: new Date(), message: String(message || '').slice(0, 300) };
  await persist(s);
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
