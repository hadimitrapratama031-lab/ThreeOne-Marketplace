import crypto from 'node:crypto';
import { config } from '../config/env.js';

/**
 * Klien 31 QRIS (API Gateway), mengikuti "Dokumentasi API 31 QRIS" v1.0.0 (rev f2c49445).
 * Dipanggil HANYA dari backend; API Key tidak pernah dikirim ke browser maupun ditulis ke log.
 *
 *   Base URL : config.qris31.base  (default https://31-qris-gateway-production.up.railway.app)
 *   Auth     : Authorization: Bearer 31QRIS_...
 *   Respons  : sukses { success: true, ... } | gagal { success: false, error: { code, message, details, field, request_id, retry_after } }
 *
 *   GET  /v1/me                                 cek API Key (tanpa izin khusus)
 *   POST /v1/transactions                       transactions:create  body { order_id, amount, description?, metadata?, expiry_minutes? }
 *   GET  /v1/transactions/{id}                  transactions:read
 *   GET  /v1/transactions/by-order/{order_id}   transactions:read
 *   GET  /v1/transactions                       transactions:read
 *   POST /v1/transactions/{id}/cancel           transactions:cancel
 *   GET  /v1/qris                               qris:read
 *
 *   Objek transaksi: id, order_id, status (PENDING|PAID|EXPIRED|NEEDS_REVIEW), review_reason, resolution (CANCELLED|REJECTED|null),
 *   base_amount, unique_code, amount (= NOMINAL YANG HARUS DIBAYAR = base_amount + unique_code), expires_at, paid_at, qris_image_url.
 *
 *   Webhook: header X-31QRIS-Signature = "sha256=" + HMAC-SHA256(secret, `${X-31QRIS-Timestamp}.${body mentah}`) hex; toleransi 300 detik;
 *   X-31QRIS-Event-ID = kunci idempotensi. Payload { id, type, api_version, created_at, data: { transaction_id, order_id, status, amount, ... } }.
 */

/** kind: 'auth' | 'scope' | 'notfound' | 'api' | 'network' | 'invalid' */
export class GatewayError extends Error {
  constructor(message, { status = 0, detail = '', kind = 'api', code = '', requestId = '', endpoint = '' } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.detail = detail;
    this.kind = kind;
    this.code = code;
    this.requestId = requestId;
    this.endpoint = endpoint;
  }

  /** Ringkasan diagnostik satu baris (aman: tanpa API Key / secret). Dipakai log server dan catatan order di Admin Web. */
  summary() {
    const parts = [`[${this.kind}]`];
    if (this.endpoint) parts.push(this.endpoint);
    if (this.status) parts.push(`HTTP ${this.status}`);
    if (this.code) parts.push(this.code);
    parts.push(this.detail || this.message);
    if (this.requestId) parts.push(`(${this.requestId})`);
    return parts.join(' ');
  }
}

export const PROVIDER = 'qris31';
export const PROVIDER_LEGACY = 'klikqris';   // order lama: hanya histori, tidak pernah dipanggil ke gateway mana pun

const TIMEOUT_MS = 15_000;
export const SIGNATURE_TOLERANCE_S = 300;

/** -> 'paid' | 'review' | 'rejected' | 'expired' | 'cancelled' | 'pending' | 'unknown'. EXPIRED dibedakan lewat `resolution`. */
export function classifyStatus(raw, resolution = '') {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const r = String(resolution ?? '').trim().toUpperCase();
  if (s === 'PAID') return 'paid';
  if (s === 'NEEDS_REVIEW') return 'review';
  if (s === 'EXPIRED') return r === 'CANCELLED' ? 'cancelled' : r === 'REJECTED' ? 'rejected' : 'expired';
  if (s === 'PENDING') return 'pending';
  return 'unknown';
}

/* ---------- HTTP ---------- */
const baseUrl = () => config.qris31.base;

async function call(cred, method, path, body) {
  if (!cred?.apiKey) throw new GatewayError('API Key 31 QRIS belum diisi.', { kind: 'auth', endpoint: `${method} ${path}` });
  const endpoint = `${method} ${path.split('?')[0].replace(/\/(trx_[0-9a-f]+)/i, '/{id}')}`;
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${cred.apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GatewayError('31 QRIS tidak dapat dihubungi.', { kind: 'network', endpoint, detail: err?.name === 'TimeoutError' ? 'timeout' : String(err?.cause?.code || err?.message || err).slice(0, 120) });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  const headerRid = res.headers.get('x-request-id') || '';

  // Format error resmi: { success:false, error:{ code, message, details, field, request_id } }
  if (!res.ok || json?.success === false) {
    const e = json?.error && typeof json.error === 'object' ? json.error : {};
    const code = String(e.code || (typeof json?.error === 'string' ? json.error : '') || json?.code || '').toUpperCase();
    const message = String(e.message || json?.message || text.slice(0, 160) || `HTTP ${res.status}`);
    const detail = [code && `${code}: ${message}`, !code && message, e.details, e.field && `field: ${e.field}`, e.retry_after && `retry_after: ${e.retry_after}s`].filter(Boolean).join(' | ').slice(0, 260);
    const meta = { status: res.status, code, detail, requestId: String(e.request_id || headerRid), endpoint };
    let err;
    if (res.status === 403 && code === 'INSUFFICIENT_SCOPE') err = new GatewayError('API Key 31 QRIS tidak memiliki izin untuk endpoint ini (INSUFFICIENT_SCOPE). Buat ulang API Key dengan izin yang dibutuhkan.', { ...meta, kind: 'scope' });
    else if (res.status === 401 || res.status === 403) err = new GatewayError(`Autentikasi 31 QRIS gagal${code ? ` (${code})` : ''}. Periksa API Key.`, { ...meta, kind: 'auth' });
    else if (res.status === 404 && code !== 'QRIS_NOT_CONFIGURED') err = new GatewayError('Transaksi tidak ditemukan di 31 QRIS.', { ...meta, kind: 'notfound' });
    else err = new GatewayError('31 QRIS menolak permintaan.', { ...meta, kind: 'api' });
    console.warn(`[31QRIS] ${new Date().toISOString()} ${err.summary()}`);   // tanpa kredensial
    throw err;
  }
  if (json === null || typeof json !== 'object' || json.success !== true) {
    throw new GatewayError('Respons 31 QRIS bukan JSON sukses yang valid.', { status: res.status, kind: 'invalid', endpoint, requestId: headerRid, detail: text.slice(0, 120) });
  }
  return json;
}

/* ---------- Normalisasi ---------- */
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const intOrNull = (v) => (Number.isInteger(num(v)) ? num(v) : null);

/** Gambar QRIS: qris_image_url (https, bertanda tangan) -> qrisUrl; data URI gambar -> qrisImage. */
export function parseQr(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return { qrisImage: '', qrisUrl: '' };
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return { qrisImage: s.replace(/\s+/g, ''), qrisUrl: '' };
  try {
    const u = new URL(s, baseUrl());
    if (u.protocol === 'https:') return { qrisImage: '', qrisUrl: u.toString() };
    if (u.protocol === 'http:' && config.qris31.base.startsWith('http://')) return { qrisImage: '', qrisUrl: u.toString() };
  } catch { /* bukan URL */ }
  return { qrisImage: '', qrisUrl: '' };
}

const isoOrEmpty = (v) => { if (!v) return ''; const t = new Date(v); return Number.isNaN(t.getTime()) ? String(v) : t.toISOString(); };

/** Objek transaksi (respons /v1/transactions...) ATAU `data` webhook (memakai transaction_id). */
function normalizeTx(d) {
  d = d && typeof d === 'object' ? d : {};
  const idRaw = d.id ?? d.transaction_id;
  const status = String(d.status ?? '');
  return {
    id: idRaw !== undefined && idRaw !== null ? String(idRaw) : '',
    orderId: d.order_id !== undefined && d.order_id !== null ? String(d.order_id) : '',
    status: status.toUpperCase(),
    resolution: String(d.resolution ?? '').toUpperCase(),
    kind: classifyStatus(status, d.resolution),
    baseAmount: intOrNull(d.base_amount),
    uniqueAmount: intOrNull(d.unique_code),
    totalAmount: intOrNull(d.amount),   // nominal yang harus dibayar (sudah memuat kode unik)
    paidAmount: null,                   // gateway tidak mengirim nominal terbayar terpisah; `amount` adalah acuannya
    paidAt: isoOrEmpty(d.paid_at),
    expiredAt: isoOrEmpty(d.expires_at),
    ...parseQr(d.qris_image_url),
  };
}
const txOf = (json) => normalizeTx(json?.transaction);

/* ---------- Operasi ---------- */
/**
 * Buat transaksi (POST /v1/transactions). `totalAmount` = transaction.amount = nominal final yang harus dibayar pelanggan.
 * Respons tanpa id, order_id yang cocok, nominal, atau qris_image_url dianggap tidak valid: order TIDAK dianggap berhasil dibuat.
 */
export async function createTransaction(cred, { orderId, amount, description = '', expiryMinutes } = {}) {
  const body = { order_id: orderId, amount };
  const desc = String(description || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  if (desc) body.description = desc;
  if (Number.isInteger(expiryMinutes) && expiryMinutes >= 5 && expiryMinutes <= 1440) body.expiry_minutes = expiryMinutes;
  const json = await call(cred, 'POST', '/v1/transactions', body);
  const t = txOf(json);
  const problems = [];
  if (!t.id) problems.push('id');
  if (t.orderId !== orderId) problems.push('order_id');
  if (t.totalAmount === null || t.totalAmount < amount) problems.push('amount');
  if (t.baseAmount !== null && t.baseAmount !== amount) problems.push('base_amount');
  if (!t.qrisUrl && !t.qrisImage) problems.push('qris_image_url');
  if (t.kind !== 'pending') problems.push(`status=${t.status || '(kosong)'}`);
  if (problems.length) {
    // Hanya NAMA field (bukan nilai) yang dicatat, supaya kecocokan skema terlihat di log/Admin tanpa membocorkan data.
    const keys = Object.keys(json?.transaction || {}).slice(0, 25).join(',');
    throw new GatewayError('Respons 31 QRIS tidak lengkap.', { status: 200, kind: 'invalid', endpoint: 'POST /v1/transactions', detail: `bermasalah: ${problems.join(', ')}; field respons: ${keys || '(kosong)'}` });
  }
  return { ...t, uniqueAmount: t.uniqueAmount !== null ? t.uniqueAmount : t.totalAmount - amount, idempotentReplay: json.idempotent_replay === true };
}

/** Status transaksi: lewat ID gateway bila ada, selain itu lewat ID pesanan. */
export async function getTransaction(cred, { id = '', orderId = '' }) {
  const path = id ? `/v1/transactions/${encodeURIComponent(id)}` : `/v1/transactions/by-order/${encodeURIComponent(orderId)}`;
  const t = txOf(await call(cred, 'GET', path));
  if (t.orderId && orderId && t.orderId !== orderId) throw new GatewayError('Respons status 31 QRIS tidak sesuai pesanan.', { kind: 'invalid', endpoint: 'GET /v1/transactions', detail: `order_id=${t.orderId}` });
  if (!t.status) throw new GatewayError('Respons status 31 QRIS tidak memuat status.', { kind: 'invalid', endpoint: 'GET /v1/transactions' });
  return t;
}

/** Riwayat transaksi di gateway (rekonsiliasi manual). */
export async function listTransactions(cred, query = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return call(cred, 'GET', `/v1/transactions${qs ? `?${qs}` : ''}`);
}

/** Batalkan transaksi yang masih menunggu. */
export async function cancelTransaction(cred, id) {
  if (!id) throw new GatewayError('ID transaksi gateway tidak tersedia.', { kind: 'invalid' });
  return txOf(await call(cred, 'POST', `/v1/transactions/${encodeURIComponent(id)}/cancel`));
}

/** Uji API Key: GET /v1/me (tanpa izin khusus). Memuat izin kunci serta kesiapan QRIS & webhook akun. */
export async function getMe(cred) {
  return call(cred, 'GET', '/v1/me');
}

/** Status QRIS di gateway: GET /v1/qris (izin qris:read). */
export async function getQrisStatus(cred) {
  return call(cred, 'GET', '/v1/qris');
}

/* ---------- Webhook ---------- */
/**
 * Verifikasi webhook: "sha256=" + HMAC-SHA256(secret, `${timestamp}.${body mentah}`) hex, dibandingkan waktu-konstan,
 * dan timestamp (detik UNIX) tidak boleh lebih dari 300 detik dari jam server (anti replay).
 * Mengembalikan { ok, reason } ; reason: '' | 'missing' | 'stale' | 'mismatch'.
 */
export function checkWebhookSignature(rawBody, { signature, timestamp }, secret, nowMs = Date.now()) {
  if (!secret || !Buffer.isBuffer(rawBody)) return { ok: false, reason: 'missing' };
  const ts = String(timestamp ?? '').trim();
  const given = String(signature ?? '').trim();
  if (!/^\d{1,12}$/.test(ts) || !given) return { ok: false, reason: 'missing' };
  if (Math.abs(nowMs / 1000 - Number(ts)) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex')}`);
  const got = Buffer.from(given.toLowerCase().startsWith('sha256=') ? `sha256=${given.slice(7).toLowerCase()}` : given);
  return { ok: got.length === expected.length && crypto.timingSafeEqual(got, expected), reason: '' };
}
export const verifySignature = (rawBody, headers, secret, nowMs) => checkWebhookSignature(rawBody, headers, secret, nowMs).ok;

/** Ambil field penting dari payload webhook { id, type, data:{ transaction_id, order_id, status, amount, ... } }. */
export function parseWebhook(body) {
  const top = body && typeof body === 'object' ? body : {};
  const t = normalizeTx(top.data);
  return { ...t, event: String(top.type || ''), eventId: String(top.id || '') };
}
