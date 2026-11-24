import crypto from 'node:crypto';
import { config } from '../config/env.js';

/**
 * Klien 31 QRIS (API Gateway). Dipanggil HANYA dari backend; API Key tidak pernah dikirim ke browser.
 *
 *   Base URL : config.qris31.base  (default https://31-qris-gateway-production.up.railway.app)
 *   Auth     : Authorization: Bearer <API Key>
 *   Endpoint (sesuai dokumentasi gateway):
 *     POST /v1/transactions                       transactions:create   buat transaksi (+ nominal dengan kode unik)
 *     GET  /v1/transactions/{id}                  transactions:read     status satu transaksi
 *     GET  /v1/transactions/by-order/{order_id}   transactions:read     status berdasarkan ID pesanan
 *     GET  /v1/transactions                       transactions:read     riwayat transaksi
 *     POST /v1/transactions/{id}/cancel           transactions:cancel   batalkan transaksi yang masih menunggu
 *     GET  /v1/qris                               qris:read             status QRIS di gateway
 *   Kunci dengan izin terbatas dibalas 403 INSUFFICIENT_SCOPE untuk endpoint di luar izinnya.
 *   Webhook: dikirim saat transaksi berhasil / perlu dicek / ditolak, ditandatangani HMAC di header X-Signature,
 *   dicoba ulang otomatis bila gagal; secret berformat "whsec_...".
 *
 * ASUMSI YANG BELUM TERCANTUM DI DOKUMENTASI (screenshot hanya memuat daftar endpoint & ringkasan webhook).
 * Seluruhnya dikumpulkan di file ini supaya mudah dicocokkan, tanpa menyentuh logika bisnis:
 *   - body create: { order_id, amount }
 *   - nama field respons: lihat ALIAS di bawah (alias pertama yang ada dipakai; bila nominal/ID/QR tidak ada -> GatewayError 'invalid',
 *     transaksi TIDAK dianggap berhasil dibuat)
 *   - nama status: lihat classifyStatus()
 *   - HMAC: HMAC-SHA256 atas byte mentah body, hex (boleh berawalan "sha256="); lihat verifySignature()
 */

/** kind: 'auth' | 'scope' | 'notfound' | 'api' | 'network' | 'invalid' */
export class GatewayError extends Error {
  constructor(message, { status = 0, detail = '', kind = 'api', code = '' } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.detail = detail;
    this.kind = kind;
    this.code = code;
  }
}

export const PROVIDER = 'qris31';
export const PROVIDER_LEGACY = 'klikqris';   // order lama: hanya histori, tidak pernah dipanggil ke gateway mana pun

const TIMEOUT_MS = 15_000;

/* ---------- Pemetaan nama field & status (satu-satunya tempat yang perlu disesuaikan bila dokumentasi berbeda) ---------- */
const ALIAS = {
  id: ['id', 'transaction_id', 'txn_id'],
  orderId: ['order_id', 'orderId'],
  status: ['status', 'state'],
  total: ['total_amount', 'amount_total', 'payable_amount', 'final_amount', 'amount_to_pay', 'total'],
  unique: ['unique_code', 'unique_amount', 'amount_uniq', 'unique'],
  paid: ['amount_paid', 'paid_amount'],
  qr: ['qris_image', 'qr_image', 'qr_image_url', 'qris_url', 'qr_url', 'image_url', 'qr'],
  expires: ['expires_at', 'expired_at', 'expiry'],
  paidAt: ['paid_at', 'payment_date', 'settled_at'],
};
const pick = (d, key) => {
  for (const k of ALIAS[key]) if (d && d[k] !== undefined && d[k] !== null && d[k] !== '') return d[k];
  return undefined;
};
const unwrap = (j) => {
  if (j && typeof j === 'object') {
    for (const k of ['data', 'transaction', 'result']) if (j[k] && typeof j[k] === 'object' && !Array.isArray(j[k])) return j[k];
  }
  return j;
};

/** -> 'paid' | 'review' | 'rejected' | 'expired' | 'cancelled' | 'pending' | 'unknown' */
export function classifyStatus(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['PAID', 'SUCCESS', 'SUCCEEDED', 'SETTLED', 'COMPLETED', 'COMPLETE', 'BERHASIL'].includes(s)) return 'paid';
  if (['REVIEW', 'NEEDS_REVIEW', 'NEED_REVIEW', 'NEEDS_CHECK', 'NEED_CHECK', 'CHECK', 'MANUAL_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW', 'PERLU_DICEK', 'PERLU_DICEK_MANUAL'].includes(s)) return 'review';
  if (['REJECTED', 'DENIED', 'DECLINED', 'FAILED', 'FAILURE', 'DITOLAK'].includes(s)) return 'rejected';
  if (['EXPIRED', 'EXPIRE', 'KEDALUWARSA'].includes(s)) return 'expired';
  if (['CANCELLED', 'CANCELED', 'VOID', 'VOIDED', 'DIBATALKAN'].includes(s)) return 'cancelled';
  if (['PENDING', 'WAITING', 'UNPAID', 'CREATED', 'OPEN', 'MENUNGGU'].includes(s)) return 'pending';
  return 'unknown';
}

/* ---------- HTTP ---------- */
const baseUrl = () => config.qris31.base;

async function call(cred, method, path, body) {
  if (!cred?.apiKey) throw new GatewayError('API Key 31 QRIS belum diisi.', { kind: 'auth' });
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
    throw new GatewayError('31 QRIS tidak dapat dihubungi.', { kind: 'network', detail: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err) });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }

  if (!res.ok) {
    const code = String(json?.error?.code || json?.code || (typeof json?.error === 'string' ? json.error : '') || '').toUpperCase();
    const msg = String(json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : '') || text.slice(0, 160));
    if (res.status === 403 && (code === 'INSUFFICIENT_SCOPE' || /insufficient_scope/i.test(msg))) {
      throw new GatewayError('API Key 31 QRIS tidak memiliki izin untuk endpoint ini (INSUFFICIENT_SCOPE). Periksa izin kunci di dashboard 31 QRIS.', { status: 403, kind: 'scope', code: 'INSUFFICIENT_SCOPE', detail: msg });
    }
    if (res.status === 401 || res.status === 403) throw new GatewayError('Autentikasi 31 QRIS gagal (periksa API Key).', { status: res.status, kind: 'auth', code, detail: msg });
    if (res.status === 404) throw new GatewayError('Transaksi tidak ditemukan di 31 QRIS.', { status: 404, kind: 'notfound', code, detail: msg });
    throw new GatewayError('31 QRIS menolak permintaan.', { status: res.status, kind: 'api', code, detail: msg });
  }
  if (json === null || typeof json !== 'object') {
    throw new GatewayError('Respons 31 QRIS bukan JSON yang valid.', { status: res.status, kind: 'invalid', detail: text.slice(0, 120) });
  }
  return json;
}

/* ---------- Normalisasi ---------- */
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;

/** Gambar QRIS: data URI (PNG/JPEG/WebP) -> qrisImage; URL https (atau path relatif ke gateway) -> qrisUrl; base64 polos -> data URI. */
export function parseQr(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return { qrisImage: '', qrisUrl: '' };
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return { qrisImage: s.replace(/\s+/g, ''), qrisUrl: '' };
  if (/^[A-Za-z0-9+/=\s]{200,}$/.test(s)) return { qrisImage: `data:image/png;base64,${s.replace(/\s+/g, '')}`, qrisUrl: '' };
  try {
    const u = new URL(s, baseUrl());
    if (u.protocol === 'https:') return { qrisImage: '', qrisUrl: u.toString() };
    if (u.protocol === 'http:' && config.qris31.base.startsWith('http://')) return { qrisImage: '', qrisUrl: u.toString() };
  } catch { /* bukan URL */ }
  return { qrisImage: '', qrisUrl: '' };
}

const isoOrEmpty = (v) => { if (!v) return ''; const t = new Date(v); return Number.isNaN(t.getTime()) ? String(v) : t.toISOString(); };

function normalize(json) {
  const d = unwrap(json) || {};
  const status = String(pick(d, 'status') ?? '');
  const paid = num(pick(d, 'paid'));
  return {
    id: pick(d, 'id') !== undefined ? String(pick(d, 'id')) : '',
    orderId: pick(d, 'orderId') !== undefined ? String(pick(d, 'orderId')) : '',
    status: status.toUpperCase(),
    kind: classifyStatus(status),
    totalAmount: Number.isFinite(num(pick(d, 'total'))) ? num(pick(d, 'total')) : null,
    uniqueAmount: Number.isFinite(num(pick(d, 'unique'))) ? num(pick(d, 'unique')) : null,
    paidAmount: Number.isFinite(paid) ? paid : null,
    paidAt: isoOrEmpty(pick(d, 'paidAt')),
    expiredAt: isoOrEmpty(pick(d, 'expires')),
    ...parseQr(pick(d, 'qr')),
  };
}

/* ---------- Operasi ---------- */
/**
 * Buat transaksi. `totalAmount` dari respons = nominal final yang harus dibayar (sudah memuat kode unik).
 * Respons tanpa ID transaksi, nominal, atau QR dianggap tidak valid: order tidak pernah dianggap berhasil dibuat.
 */
export async function createTransaction(cred, { orderId, amount }) {
  const t = normalize(await call(cred, 'POST', '/v1/transactions', { order_id: orderId, amount }));
  const problems = [];
  if (!t.id) problems.push('id');
  if (t.orderId && t.orderId !== orderId) problems.push('order_id');
  if (t.totalAmount === null || t.totalAmount < amount) problems.push('total_amount');
  if (!t.qrisUrl && !t.qrisImage) problems.push('qris');
  if (problems.length) throw new GatewayError('Respons 31 QRIS tidak lengkap.', { kind: 'invalid', detail: `bermasalah: ${problems.join(', ')}` });
  return { ...t, uniqueAmount: t.uniqueAmount !== null ? t.uniqueAmount : round2(t.totalAmount - amount) };
}

/** Status transaksi: lewat ID gateway bila ada, selain itu lewat ID pesanan. */
export async function getTransaction(cred, { id = '', orderId = '' }) {
  const path = id ? `/v1/transactions/${encodeURIComponent(id)}` : `/v1/transactions/by-order/${encodeURIComponent(orderId)}`;
  const t = normalize(await call(cred, 'GET', path));
  if (t.orderId && orderId && t.orderId !== orderId) throw new GatewayError('Respons status 31 QRIS tidak sesuai pesanan.', { kind: 'invalid', detail: `order_id=${t.orderId}` });
  if (!t.status) throw new GatewayError('Respons status 31 QRIS tidak memuat status.', { kind: 'invalid' });
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
  return normalize(await call(cred, 'POST', `/v1/transactions/${encodeURIComponent(id)}/cancel`));
}

/** Uji kredensial: GET /v1/qris (izin qris:read). 403 INSUFFICIENT_SCOPE = kunci valid tetapi tanpa izin itu. */
export async function getQrisStatus(cred) {
  return call(cred, 'GET', '/v1/qris');
}

/* ---------- Webhook ---------- */
/**
 * Verifikasi X-Signature: HMAC-SHA256(rawBody, webhookSecret) dalam hex (atau base64), boleh berawalan "sha256=" / "v1=".
 * Perbandingan waktu-konstan atas byte mentah body (bukan hasil parse JSON).
 */
export function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  const given = String(header).trim().replace(/^(sha256|v1)=/i, '');
  const mac = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const candidates = [mac.toString('hex'), mac.toString('base64'), mac.toString('base64url')];
  const g = Buffer.from(/^[0-9a-f]+$/i.test(given) ? given.toLowerCase() : given);
  return candidates.some((c) => { const b = Buffer.from(c); return b.length === g.length && crypto.timingSafeEqual(b, g); });
}

/** Ambil field penting dari payload webhook (bentuk datar atau bersarang). */
export function parseWebhook(body) {
  const t = normalize(body);
  const top = body && typeof body === 'object' ? body : {};
  const event = String(top.event || top.type || '');
  return { ...t, event, status: t.status || String(top.status || '').toUpperCase(), kind: t.status ? t.kind : classifyStatus(top.status) };
}
