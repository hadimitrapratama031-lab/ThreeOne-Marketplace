import { config } from '../config/env.js';

/**
 * Klien KlikQRIS PG (In-House QRIS) — hanya endpoint yang ada di https://klikqris.com/dokumentasi-api :
 *   POST {base}/qris/create            body: order_id, amount, id_merchant, keterangan?, callback_url?
 *   GET  {base}/qris/status/{order_id}
 *   GET  {base}/qris/history           (dipakai untuk uji koneksi kredensial)
 * Sandbox memakai {base}/sandbox/... dengan format sama persis. Header wajib: x-api-key dan id_merchant.
 * Status resmi: PENDING, SUCCESS (webhook mengirim PAID), EXPIRED. Tidak ada status lain yang diasumsikan.
 */
export class GatewayError extends Error {
  constructor(message, { status = 0, detail = '' } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.detail = detail;
  }
}

const TIMEOUT_MS = 15_000;
const root = (mode) => `${config.klikqrisBase}${mode === 'production' ? '' : '/sandbox'}`;

async function call(cred, method, path, body) {
  let res;
  try {
    res = await fetch(`${root(cred.mode)}${path}`, {
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
    throw new GatewayError('KlikQRIS tidak dapat dihubungi.', { detail: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err) });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  if (!res.ok || !json || json.status !== true || typeof json.data !== 'object' || json.data === null) {
    const msg = typeof json?.message === 'string' ? json.message : text.slice(0, 160);
    throw new GatewayError('KlikQRIS menolak permintaan.', { status: res.status, detail: msg });
  }
  return json.data;
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/** Buat tagihan QRIS. `total_amount` dari respons adalah nominal final yang harus dibayar. */
export async function createTransaction(cred, { orderId, amount, keterangan, callbackUrl }) {
  const d = await call(cred, 'POST', '/qris/create', {
    order_id: orderId,
    amount,
    id_merchant: cred.merchantId,
    ...(keterangan ? { keterangan } : {}),
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
  });
  const total = num(d.total_amount);
  if (d.order_id !== orderId || !Number.isFinite(total) || total < amount || !d.qris_url || !d.signature) {
    throw new GatewayError('Respons KlikQRIS tidak lengkap.', { detail: `order_id=${d.order_id} total_amount=${d.total_amount} qris_url=${Boolean(d.qris_url)} signature=${Boolean(d.signature)}` });
  }
  return {
    status: String(d.status || ''),
    totalAmount: total,
    uniqueAmount: Number.isFinite(num(d.amount_uniq)) ? num(d.amount_uniq) : 0,
    qrisUrl: String(d.qris_url),
    reportUrl: d.report_url ? String(d.report_url) : '',
    signature: String(d.signature),
    expiredAt: d.expired_at ? String(d.expired_at) : '',
  };
}

/** Cek status satu transaksi. */
export async function checkStatus(cred, orderId) {
  const d = await call(cred, 'GET', `/qris/status/${encodeURIComponent(orderId)}`);
  return {
    status: String(d.status || '').toUpperCase(),
    totalAmount: Number.isFinite(num(d.total_amount)) ? num(d.total_amount) : null,
    paidAt: d.paid_at ? String(d.paid_at) : '',
    expiredAt: d.expired_at ? String(d.expired_at) : '',
  };
}

/** Uji kredensial lewat endpoint riwayat (GET /qris/history). */
export async function testCredentials(cred) {
  await call(cred, 'GET', '/qris/history');
  return true;
}
