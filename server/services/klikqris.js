import { config } from '../config/env.js';

/**
 * Klien KlikQRIS — https://klikqris.com/dokumentasi-api
 *
 * MODE PRODUCTION = MY PG (Personal Gateway; dana langsung ke rekening/QRIS milik merchant):
 *   POST {base}/qrisv2/create                          body: order_id, id_merchant, amount, keterangan?   (TANPA callback_url:
 *                                                      URL webhook didaftarkan di dashboard KlikQRIS)
 *   GET  {base}/qrisv2/status/{id_merchant}/{order_id}
 *   Header wajib: x-api-key dan id_merchant. Respons create: order_id, amount, total_amount, status, direct_url, qris_url,
 *   expired_at, signature (tanpa qris_image / amount_uniq / report_url).
 *
 * MODE SANDBOX = satu-satunya simulator yang didokumentasikan KlikQRIS (format In-House, {base}/sandbox/qris/...). Dokumentasi
 * tidak punya sandbox khusus MY PG, jadi jalur ini dipertahankan terpisah (`legacy`) dan tidak memakai uang asli.
 * Pesanan lama (provider 'klikqris') yang masih PENDING saat migrasi juga dicek lewat jalur legacy ini.
 *
 * Status resmi: PENDING, SUCCESS (webhook mengirim PAID), EXPIRED. Tidak ada status lain yang diasumsikan.
 */
export const PROVIDER_MYPG = 'klikqris-mypg';
export const PROVIDER_LEGACY = 'klikqris';
export const providerFor = (mode) => (mode === 'production' ? PROVIDER_MYPG : PROVIDER_LEGACY);

/** kind: 'auth' (kredensial ditolak) | 'api' (error dari KlikQRIS) | 'network' (tak terjangkau/timeout) | 'invalid' (respons tak sesuai). */
export class GatewayError extends Error {
  constructor(message, { status = 0, detail = '', kind = 'api' } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

const TIMEOUT_MS = 15_000;
const AUTH_RE = /unauthor|forbidden|api[\s_-]?key|kredensial|credential|(invalid|not found|tidak ditemukan|salah).{0,20}merchant/i;
const root = (cred, legacy) => `${config.klikqrisBase}${legacy && cred.mode !== 'production' ? '/sandbox' : ''}`;

async function call(cred, method, path, body, { legacy = false } = {}) {
  let res;
  try {
    res = await fetch(`${root(cred, legacy)}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-api-key': cred.apiKey,
        id_merchant: cred.merchantId,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GatewayError('KlikQRIS tidak dapat dihubungi.', { kind: 'network', detail: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err) });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  if (!res.ok || !json || json.status !== true || typeof json.data !== 'object' || json.data === null) {
    const msg = typeof json?.message === 'string' ? json.message : text.slice(0, 160);
    const auth = res.status === 401 || res.status === 403 || AUTH_RE.test(msg);
    throw new GatewayError(auth ? 'Autentikasi KlikQRIS gagal (periksa API Key dan Merchant ID).' : 'KlikQRIS menolak permintaan.', { status: res.status, detail: msg, kind: auth ? 'auth' : 'api' });
  }
  return json.data;
}

/** `qris_image` (hanya mode legacy): "data:image/png;base64,...". Bila yang datang base64 polos, dibungkus jadi data URI. Selain PNG/JPEG/WebP base64 -> ''. */
export function toDataUri(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=\s]{200,}$/.test(s)) return `data:image/png;base64,${s.replace(/\s+/g, '')}`;
  return '';
}

/** `qris_url` / `direct_url` selalu dipakai sebagai URL https absolut; path relatif dilengkapi host KlikQRIS. */
export function absoluteUrl(v, mode) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  try {
    const u = new URL(s, 'https://klikqris.com');
    return u.protocol === 'https:' || (u.protocol === 'http:' && mode !== 'production') ? u.toString() : (u.protocol === 'http:' ? `https://${u.host}${u.pathname}${u.search}` : '');
  } catch { return ''; }
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Buat tagihan QRIS. `total_amount` dari respons adalah nominal final yang harus dibayar (sudah memuat kode unik).
 * Production -> MY PG (/qrisv2/create); Sandbox -> simulator (/sandbox/qris/create, memakai callback_url).
 */
export async function createTransaction(cred, { orderId, amount, keterangan, callbackUrl }) {
  const mypg = cred.mode === 'production';
  const d = mypg
    ? await call(cred, 'POST', '/qrisv2/create', {
      order_id: orderId,
      id_merchant: cred.merchantId,
      amount,
      ...(keterangan ? { keterangan } : {}),
    })
    : await call(cred, 'POST', '/qris/create', {
      order_id: orderId,
      amount,
      id_merchant: cred.merchantId,
      ...(keterangan ? { keterangan } : {}),
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    }, { legacy: true });
  const total = num(d.total_amount);
  const qrisImage = toDataUri(d.qris_image);
  const qrisUrl = absoluteUrl(d.qris_url, cred.mode);
  if (d.order_id !== orderId || !Number.isFinite(total) || total < amount || (!qrisUrl && !qrisImage) || !d.signature) {
    throw new GatewayError('Respons KlikQRIS tidak lengkap.', { kind: 'invalid', detail: `order_id=${d.order_id} total_amount=${d.total_amount} qris_url=${Boolean(d.qris_url)} qris_image=${Boolean(d.qris_image)} signature=${Boolean(d.signature)}` });
  }
  // MY PG tidak mengirim amount_uniq: kode unik = total_amount - amount.
  const uniq = mypg ? round2(total - amount) : (Number.isFinite(num(d.amount_uniq)) ? num(d.amount_uniq) : 0);
  return {
    status: String(d.status || ''),
    totalAmount: total,
    uniqueAmount: uniq,
    qrisUrl,
    qrisImage,
    reportUrl: d.report_url ? String(d.report_url) : '',
    directUrl: absoluteUrl(d.direct_url, cred.mode),
    signature: String(d.signature),
    expiredAt: d.expired_at ? String(d.expired_at) : '',
  };
}

/**
 * Cek status satu transaksi. MY PG: GET /qrisv2/status/{id_merchant}/{order_id}.
 * `legacy: true` (sandbox atau pesanan lama dari mode In-House): GET /qris/status/{order_id}.
 */
export async function checkStatus(cred, orderId, { legacy = false } = {}) {
  const path = legacy
    ? `/qris/status/${encodeURIComponent(orderId)}`
    : `/qrisv2/status/${encodeURIComponent(cred.merchantId)}/${encodeURIComponent(orderId)}`;
  const d = await call(cred, 'GET', path, undefined, { legacy });
  if (d.order_id !== undefined && d.order_id !== null && String(d.order_id) !== orderId) {
    throw new GatewayError('Respons status KlikQRIS tidak sesuai.', { kind: 'invalid', detail: `order_id=${d.order_id}` });
  }
  return {
    status: String(d.status || '').toUpperCase(),
    totalAmount: Number.isFinite(num(d.total_amount)) ? num(d.total_amount) : null,
    paidAt: d.paid_at ? String(d.paid_at) : '',
    expiredAt: d.expired_at ? String(d.expired_at) : '',
  };
}

/**
 * Uji kredensial. Sandbox: GET /sandbox/qris/history. Production (MY PG): dokumentasi tidak punya endpoint ping/riwayat,
 * jadi dipakai cek status untuk order_id yang pasti tidak ada: ditolak 401/403 atau pesan autentikasi = kredensial salah,
 * tidak terjangkau/5xx = gagal, selain itu (mis. "transaksi tidak ditemukan") = kredensial diterima.
 */
export async function testCredentials(cred) {
  if (cred.mode !== 'production') {
    await call(cred, 'GET', '/qris/history', undefined, { legacy: true });
    return true;
  }
  try {
    await call(cred, 'GET', `/qrisv2/status/${encodeURIComponent(cred.merchantId)}/${encodeURIComponent(`CEK-KREDENSIAL-${Date.now()}`)}`);
  } catch (err) {
    if (!(err instanceof GatewayError) || err.kind === 'auth' || err.kind === 'network' || err.status >= 500) throw err;
  }
  return true;
}
