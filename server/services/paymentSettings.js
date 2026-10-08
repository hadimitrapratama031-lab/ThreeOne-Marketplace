import { Setting } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import { normalizeWhatsapp } from '../lib/phone.js';
import { config } from '../config/env.js';

/**
 * Pengaturan pembayaran (Admin Web) disimpan di koleksi settings dengan key "payment".
 * Sengaja TIDAK masuk SETTING_KEYS: grup itu dikirim penuh ke Marketplace lewat /bootstrap dan Socket.IO publik,
 * sedangkan di sini ada API Key. API Key dienkripsi (AES-256-GCM) dan tidak pernah dikembalikan ke browser.
 */
const KEY = 'payment';
export const MODES = ['sandbox', 'production'];
const emptySet = () => ({ merchantId: '', apiKeyEnc: '' });
const DEFAULT = () => ({ mode: 'sandbox', sandbox: emptySet(), production: emptySet(), waAdmin: '', publicBaseUrl: '' });

async function stored() {
  const doc = await Setting.findOne({ key: KEY }).lean();
  const v = doc?.value || {};
  const d = DEFAULT();
  return {
    mode: MODES.includes(v.mode) ? v.mode : d.mode,
    sandbox: { ...d.sandbox, ...(v.sandbox || {}) },
    production: { ...d.production, ...(v.production || {}) },
    waAdmin: v.waAdmin || '',
    publicBaseUrl: v.publicBaseUrl || '',
  };
}

const credOf = (s, mode) => {
  const apiKey = decryptSecret(s[mode].apiKeyEnc);
  const merchantId = String(s[mode].merchantId || '').trim();
  return { mode, apiKey, merchantId, ready: Boolean(apiKey && merchantId) };
};

/** Kredensial untuk satu mode (default: mode aktif). Dipakai backend saja. */
export async function getCredentials(mode) {
  const s = await stored();
  return credOf(s, MODES.includes(mode) ? mode : s.mode);
}

/** Pengaturan runtime untuk backend: mode aktif + kredensial + WhatsApp + URL publik. */
export async function getPaymentConfig() {
  const s = await stored();
  return { ...credOf(s, s.mode), waAdmin: s.waAdmin, publicBaseUrl: s.publicBaseUrl || config.publicBaseUrl };
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

/** Bentuk untuk Admin Web: kredensial hanya berupa status & 4 karakter terakhir. */
export async function getAdminPayment() {
  const s = await stored();
  const view = (mode) => {
    const c = credOf(s, mode);
    return {
      merchantId: c.merchantId,
      apiKeySet: Boolean(s[mode].apiKeyEnc),
      apiKeyReadable: Boolean(c.apiKey) || !s[mode].apiKeyEnc,
      apiKeyHint: c.apiKey ? `••••${c.apiKey.slice(-4)}` : '',
      ready: c.ready,
    };
  };
  return { mode: s.mode, sandbox: view('sandbox'), production: view('production'), waAdmin: s.waAdmin, publicBaseUrl: s.publicBaseUrl };
}

function cleanBaseUrl(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  let u;
  try { u = new URL(t); } catch { throw new HttpError(422, 'Data tidak valid', { fields: { publicBaseUrl: 'URL tidak valid (contoh: https://toko.domainmu.com)' } }); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(422, 'Data tidak valid', { fields: { publicBaseUrl: 'Gunakan http:// atau https://' } });
  return u.origin;
}

/** Simpan pengaturan. API Key kosong = pertahankan yang tersimpan. */
export async function savePaymentSettings(input) {
  const cur = await stored();
  const next = { ...cur, mode: input.mode };

  for (const mode of MODES) {
    const inc = input[mode];
    next[mode] = { merchantId: inc.merchantId, apiKeyEnc: cur[mode].apiKeyEnc };
    if (inc.clearApiKey) next[mode].apiKeyEnc = '';
    if (inc.apiKey) next[mode].apiKeyEnc = encryptSecret(inc.apiKey);
  }

  if (input.waAdmin) {
    const wa = normalizeWhatsapp(input.waAdmin);
    if (!wa) throw new HttpError(422, 'Data tidak valid', { fields: { waAdmin: 'Nomor WhatsApp tidak valid (contoh: 0812 3456 7890)' } });
    next.waAdmin = wa;
  } else next.waAdmin = '';
  next.publicBaseUrl = cleanBaseUrl(input.publicBaseUrl);

  if (!credOf(next, next.mode).ready) {
    const label = next.mode === 'production' ? 'Production' : 'Sandbox';
    throw new HttpError(422, `Lengkapi API Key dan Merchant ID ${label} sebelum mengaktifkannya.`, { fields: { [`${next.mode}MerchantId`]: 'Wajib diisi untuk mode aktif', [`${next.mode}ApiKey`]: 'Wajib diisi untuk mode aktif' } });
  }

  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: next } }, { upsert: true, new: true });
  return getAdminPayment();
}
