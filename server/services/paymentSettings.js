import { Setting } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import { normalizeWhatsapp } from '../lib/phone.js';
import { config } from '../config/env.js';

/**
 * Pengaturan pembayaran 31 QRIS (Admin Web) disimpan di koleksi settings dengan key "payment".
 * Sengaja TIDAK masuk SETTING_KEYS: grup itu dikirim penuh ke Marketplace lewat /bootstrap dan Socket.IO publik,
 * sedangkan di sini ada API Key & Webhook Secret. Keduanya dienkripsi (AES-256-GCM) dan tidak pernah dikembalikan ke browser.
 * Nilai Admin Web didahulukan; env QRIS31_API_KEY / QRIS31_WEBHOOK_SECRET hanya cadangan.
 * Sisa field lama KlikQRIS (sandbox/production/merchantId) di dokumen yang sama diabaikan dan dibersihkan saat disimpan.
 */
const KEY = 'payment';
export const MODE = 'production';   // 31 QRIS tidak memiliki mode sandbox pada dokumentasinya; field mode order dipertahankan untuk histori

async function stored() {
  const doc = await Setting.findOne({ key: KEY }).lean();
  const v = doc?.value || {};
  return {
    apiKeyEnc: typeof v.apiKeyEnc === 'string' ? v.apiKeyEnc : '',
    webhookSecretEnc: typeof v.webhookSecretEnc === 'string' ? v.webhookSecretEnc : '',
    waAdmin: v.waAdmin || '',
    publicBaseUrl: v.publicBaseUrl || '',
  };
}

const credOf = (s) => {
  const apiKey = decryptSecret(s.apiKeyEnc) || config.qris31.apiKey;
  const webhookSecret = decryptSecret(s.webhookSecretEnc) || config.qris31.webhookSecret;
  return { mode: MODE, apiKey, webhookSecret, ready: Boolean(apiKey) };
};

/** Kredensial aktif. Dipakai backend saja. */
export async function getCredentials() {
  return credOf(await stored());
}

/** Pengaturan runtime untuk backend: kredensial + WhatsApp + URL publik. */
export async function getPaymentConfig() {
  const s = await stored();
  return { ...credOf(s), waAdmin: s.waAdmin, publicBaseUrl: s.publicBaseUrl || config.publicBaseUrl };
}

/** Alamat publik toko yang dikonfigurasi Admin (tanpa membuka kredensial pembayaran). Dipakai untuk og:url. */
export async function getPublicBaseUrl() {
  const s = await stored();
  return s.publicBaseUrl || '';
}

/** Info publik (tanpa rahasia). */
export async function getPublicPayment() {
  const c = await getPaymentConfig();
  return { ready: c.ready, mode: c.mode, waAdmin: c.waAdmin };
}

/** Bentuk untuk Admin Web: rahasia hanya berupa status & 4 karakter terakhir. */
export async function getAdminPayment() {
  const s = await stored();
  const own = (enc) => decryptSecret(enc);
  const apiKey = own(s.apiKeyEnc);
  const secret = own(s.webhookSecretEnc);
  const c = credOf(s);
  return {
    gateway: { name: '31 QRIS', baseUrl: config.qris31.base },
    apiKeySet: Boolean(s.apiKeyEnc),
    apiKeyReadable: Boolean(apiKey) || !s.apiKeyEnc,
    apiKeyHint: c.apiKey ? `••••${c.apiKey.slice(-4)}` : '',
    apiKeyFromEnv: Boolean(!apiKey && config.qris31.apiKey),
    webhookSecretSet: Boolean(s.webhookSecretEnc),
    webhookSecretReadable: Boolean(secret) || !s.webhookSecretEnc,
    webhookSecretHint: c.webhookSecret ? `••••${c.webhookSecret.slice(-4)}` : '',
    webhookSecretFromEnv: Boolean(!secret && config.qris31.webhookSecret),
    ready: c.ready,
    webhookReady: Boolean(c.webhookSecret),
    waAdmin: s.waAdmin,
    publicBaseUrl: s.publicBaseUrl,
  };
}

function cleanBaseUrl(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  let u;
  try { u = new URL(t); } catch { throw new HttpError(422, 'Data tidak valid', { fields: { publicBaseUrl: 'URL tidak valid (contoh: https://toko.domainmu.com)' } }); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(422, 'Data tidak valid', { fields: { publicBaseUrl: 'Gunakan http:// atau https://' } });
  return u.origin;
}

/** Simpan pengaturan. API Key / Webhook Secret kosong = pertahankan yang tersimpan. */
export async function savePaymentSettings(input) {
  const cur = await stored();
  const next = { ...cur };
  if (input.clearApiKey) next.apiKeyEnc = '';
  if (input.apiKey) next.apiKeyEnc = encryptSecret(input.apiKey);
  if (input.clearWebhookSecret) next.webhookSecretEnc = '';
  if (input.webhookSecret) next.webhookSecretEnc = encryptSecret(input.webhookSecret);

  if (input.waAdmin) {
    const wa = normalizeWhatsapp(input.waAdmin);
    if (!wa) throw new HttpError(422, 'Data tidak valid', { fields: { waAdmin: 'Nomor WhatsApp tidak valid (contoh: 0812 3456 7890)' } });
    next.waAdmin = wa;
  } else next.waAdmin = '';
  next.publicBaseUrl = cleanBaseUrl(input.publicBaseUrl);

  // $set seluruh value: field lama KlikQRIS (sandbox/production/merchantId/mode) ikut hilang dari pengaturan; riwayat order tidak tersentuh.
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: next } }, { upsert: true, new: true });
  return getAdminPayment();
}
