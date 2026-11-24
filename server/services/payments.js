import crypto from 'node:crypto';
import { Order, Product, NotificationLog, WebhookLog } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { config } from '../config/env.js';
import { tokenFor, tokenOk, watchTokenFor, watchTokenOk } from '../lib/orderToken.js';
import { ORDER_NO_RE } from '../lib/schemas.js';
import { queueOrderEvent } from './notifications.js';
import { publicUrl } from '../lib/r2.js';
import { admProduct, pubProductCard } from '../lib/serialize.js';
import { emitChange, emitToRoom, emitAdmin, setOrderJoinHandler, setTrackJoinHandler } from '../lib/realtime.js';
import { getPaymentConfig, getCredentials } from './paymentSettings.js';
import { soldOf } from './sales.js';
import { assignCode, redeemViewFor } from './codes.js';
import { publishSale, unpublishSale } from './salesFeed.js';
import * as qris31 from './qris31.js';

/**
 * Alur pembayaran (backend = sumber kebenaran):
 *   createCheckout -> order PENDING -> 31 QRIS POST /v1/transactions -> expiresAt = sekarang + 10 menit (waktu SERVER)
 *   Webhook 31 QRIS (X-31QRIS-Signature, HMAC atas `timestamp.body`) hanyalah PEMICU: setelah signature valid, status dibaca ulang dari gateway
 *   (GET /v1/transactions/{id} atau /by-order/{order_id}); pengecekan berkala memakai jalur yang sama.
 *   -> applyGatewayStatus (transisi atomik, idempoten) -> MongoDB -> Socket.IO (room per-order) -> halaman Payment berubah tanpa refresh.
 *   Pembayaran hanya SUCCESS bila status 'paid' dan nominal cocok dari gateway; 'perlu dicek' tidak pernah mengaktifkan pesanan.
 * Order lama (provider 'klikqris*') hanya histori: tidak pernah dipanggil ke gateway; yang masih PENDING habis lewat batas waktu lokal.
 */
export const EXPIRY_MS = 10 * 60 * 1000;
const POLL_EVERY_MS = 10_000;          // jeda minimum cek status 31 QRIS per order (fallback bila webhook terlambat)
const EXPIRY_GRACE_MS = 120_000;       // bila 31 QRIS tak terjangkau saat jatuh tempo, tunggu paling lama ini sebelum menutup order
const ORPHAN_MS = 90_000;              // order PENDING tanpa QRIS lebih lama dari ini dianggap gagal dibuat

/* ---------- ID & token ---------- */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // tanpa 0/O/1/I/L agar mudah dibaca & diketik
function newOrderNo() {
  const ymd = new Date(Date.now() + 7 * 3600_000).toISOString().slice(2, 10).replaceAll('-', '');   // tanggal WIB
  let rand = '';
  for (let i = 0; i < 6; i += 1) rand += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `MP-${ymd}-${rand}`;
}
/* ---------- Bentuk data ---------- */
const iso = (d) => (d ? new Date(d).toISOString() : null);
const PUBLIC_FAIL = 'Transaksi pembayaran tidak dapat dibuat. Tidak ada dana yang ditagihkan.';
const FAIL_TEXT = {
  rejected: 'Pembayaran ditolak oleh gateway. Jika Anda sudah membayar, hubungi admin dan sertakan ID transaksi.',
  cancelled: 'Transaksi pembayaran dibatalkan.',
};
const publicFail = (o) => (o.status === 'FAILED' ? (FAIL_TEXT[o.failureKind] || PUBLIC_FAIL) : null);

/** `redeem` (dari redeemViewFor) hanya diisi di jalur yang sudah memverifikasi token pelanggan; Cek Pesanan (pubTrack) tidak pernah memuatnya. */
export function pubOrder(o, { waAdmin = '', redeem = null } = {}) {
  const pending = o.status === 'PENDING';
  const unique = o.totalAmount != null ? Math.max(0, Math.round((o.totalAmount - o.amount) * 100) / 100) : 0;
  return {
    orderNo: o.orderNo,
    status: o.status,
    rev: o.rev,
    serverTime: new Date().toISOString(),
    createdAt: iso(o.createdAt),
    expiresAt: iso(o.expiresAt),
    paidAt: iso(o.payment?.paidAt),
    mode: o.payment?.mode || 'sandbox',
    method: 'QRIS',
    product: { id: o.product.productId, name: o.product.name, category: o.product.category, imageUrl: o.product.imageKey ? publicUrl(o.product.imageKey) : null },
    customer: { name: o.customer.name, email: o.customer.email, whatsapp: o.customer.whatsapp },
    amount: o.amount,
    uniqueAmount: unique,
    totalAmount: o.totalAmount,
    qrisUrl: pending ? (o.payment?.qrisUrl || null) : null,
    qrisImage: pending ? (o.payment?.qrisImage || null) : null,
    failureReason: publicFail(o),
    failureKind: o.status === 'FAILED' ? (o.failureKind || 'create') : '',
    needsReview: o.status === 'PENDING' && Boolean(o.payment?.review),
    waAdmin,
    ...(redeem ? { redeem } : {}),
  };
}

export function admOrder(o) {
  return {
    id: String(o._id),
    orderNo: o.orderNo,
    status: o.status,
    customer: o.customer,
    product: { id: o.product.productId, name: o.product.name, kind: o.product.kind || 'normal' },
    codeState: o.codeState || '',
    amount: o.amount,
    totalAmount: o.totalAmount,
    mode: o.payment?.mode || 'sandbox',
    gatewayStatus: o.payment?.gatewayStatus || '',
    source: o.payment?.source || '',
    latePayment: Boolean(o.latePayment),
    stockNote: o.stockNote || '',
    failureReason: o.failureReason || '',
    failureKind: o.failureKind || '',
    provider: o.payment?.provider || '',
    gatewayTxId: o.payment?.gatewayTxId || '',
    needsReview: Boolean(o.payment?.review),
    webhookCount: o.payment?.webhookCount || 0,
    reportUrl: o.payment?.reportUrl || o.payment?.directUrl || '',
    createdAt: iso(o.createdAt),
    expiresAt: iso(o.expiresAt),
    paidAt: iso(o.payment?.paidAt),
    events: (o.events || []).map((e) => ({ at: iso(e.at), type: e.type, detail: e.detail })),
  };
}

/* ---------- Cek Pesanan: tampilan publik ber-masking ----------
   Pencarian hanya butuh ID atau email, jadi siapa pun yang tahu salah satunya bisa melihat hasilnya. Karena itu data pribadi
   TIDAK dikirim utuh: nama/email/WhatsApp disamarkan (cukup untuk dikenali pemiliknya), dan tidak ada QRIS, token,
   signature, URL laporan, status gateway, atau catatan internal. Data utuh hanya di halaman Payment (token pelanggan). */
const DOT = '•';
const maskWord = (w) => {
  const keep = w.length <= 2 ? 1 : 2;
  return w.slice(0, keep) + DOT.repeat(Math.max(1, Math.min(w.length - keep, 4)));
};
export const maskName = (name) => String(name || '').trim().split(/\s+/).filter(Boolean).map(maskWord).join(' ');
export function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  return `${local.slice(0, 2)}${DOT.repeat(Math.max(2, Math.min(local.length - 2, 5)))}@${domain}`;
}
export function maskWhatsapp(wa) {
  const d = String(wa || '').replace(/\D/g, '');
  if (d.length < 8) return '';
  return `+${d.slice(0, 2)} ${DOT.repeat(Math.max(3, d.length - 6))} ${d.slice(-4)}`;
}

/** `redeem` = { state, code } untuk produk code yang SUDAH dibayar (lihat trackRedeem). Tanpa itu, Cek Pesanan tidak memuat code. */
export function pubTrack(o, { redeem = null } = {}) {
  const pending = o.status === 'PENDING';
  const unique = o.totalAmount != null ? Math.max(0, Math.round((o.totalAmount - o.amount) * 100) / 100) : 0;
  return {
    orderNo: o.orderNo,
    status: o.status,
    rev: o.rev,
    createdAt: iso(o.createdAt),
    expiresAt: pending ? iso(o.expiresAt) : null,
    paidAt: iso(o.payment?.paidAt),
    mode: o.payment?.mode || 'sandbox',
    method: 'QRIS',
    product: { id: o.product.productId, name: o.product.name, category: o.product.category, imageUrl: o.product.imageKey ? publicUrl(o.product.imageKey) : null },
    quantity: 1,   // satu produk per order (stok berkurang 1 saat SUCCESS)
    customer: { name: maskName(o.customer.name), email: maskEmail(o.customer.email), whatsapp: maskWhatsapp(o.customer.whatsapp) },
    amount: o.amount,
    uniqueAmount: unique,
    totalAmount: o.totalAmount,
    failureReason: publicFail(o),
    failureKind: o.status === 'FAILED' ? (o.failureKind || 'create') : '',
    needsReview: o.status === 'PENDING' && Boolean(o.payment?.review),
    ...(redeem ? { redeem } : {}),
  };
}

/** Bagian code yang ditampilkan di Cek Pesanan: hanya state + code (tanpa tutorial), dan hanya setelah pembayaran SUCCESS. */
async function trackRedeem(o) {
  const r = await redeemViewFor(o);
  return r && r.state !== 'locked' ? { state: r.state, code: r.code || '' } : null;
}

const log = (type, detail = '') => ({ at: new Date(), type, detail: String(detail).slice(0, 300) });
const push = (...events) => ({ $each: events, $slice: -30 });

/** Kirim perubahan ke halaman Payment (room khusus order) dan ke Admin Web. */
export async function emitOrder(o) {
  const { waAdmin } = await getPaymentConfig();
  const redeem = await redeemViewFor(o);   // code hanya ke room order:<id> (anggota room sudah lolos verifikasi token); admin lewat laporan Code
  emitToRoom(`order:${o.orderNo}`, 'order:update', pubOrder(o, { waAdmin, redeem }));
  emitToRoom(`track:${o.orderNo}`, 'track:update', pubTrack(o, { redeem: redeem && redeem.state !== 'locked' ? { state: redeem.state, code: redeem.code || '' } : null }));   // halaman Cek Pesanan (ber-masking)
  emitAdmin('order:update', admOrder(o));
}

/* ---------- Checkout ---------- */
export async function createCheckout(input, { requestBase }) {
  const cfg = await getPaymentConfig();
  if (!cfg.ready) throw new HttpError(503, 'Pembayaran belum tersedia. Silakan coba lagi nanti.');

  if (input.clientKey) {   // klik ganda / kirim ulang setelah koneksi putus -> order yang sama
    const dup = await Order.findOne({ clientKey: input.clientKey });
    if (dup) return { orderNo: dup.orderNo, token: tokenFor(dup.orderNo), status: dup.status };
  }

  const product = await Product.findOne({ productId: input.productId, active: true }).populate('category');
  if (!product || product.category?.active === false) throw new HttpError(404, 'Produk tidak ditemukan.');
  if (product.stock < 1) throw new HttpError(409, 'Maaf, stok produk ini sudah habis.');
  if (!Number.isInteger(product.price) || product.price < 1) throw new HttpError(422, 'Produk ini belum dapat dibeli.');

  let order;
  for (let attempt = 0; attempt < 4 && !order; attempt += 1) {
    try {
      order = await Order.create({
        orderNo: newOrderNo(),
        clientKey: input.clientKey,
        customer: { name: input.name, email: input.email, whatsapp: input.whatsapp },
        product: { ref: product._id, productId: product.productId, name: product.name, category: product.category?.name || '', imageKey: (product.media || []).find((m) => m.type === 'image' && m.key && m.source !== 'steam')?.key || '', kind: product.kind || 'normal' },
        amount: product.price,
        payment: { mode: cfg.mode, provider: qris31.PROVIDER },
        origin: cfg.publicBaseUrl || requestBase,   // dipakai tautan di notifikasi (tanpa request)
        events: [log('created', `produk #${product.productId}`)],
      });
    } catch (err) {
      if (err?.code === 11000 && err.keyPattern?.clientKey) {
        const dup = await Order.findOne({ clientKey: input.clientKey });
        if (dup) return { orderNo: dup.orderNo, token: tokenFor(dup.orderNo), status: dup.status };
      }
      if (err?.code !== 11000) throw err;   // bentrok orderNo -> coba nomor baru
    }
  }
  if (!order) throw new HttpError(500, 'Gagal membuat pesanan. Silakan coba lagi.');

  try {
    const tx = await qris31.createTransaction(cfg, { orderId: order.orderNo, amount: order.amount, description: `${product.name} (${order.orderNo})`, expiryMinutes: EXPIRY_MS / 60_000 });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRY_MS);   // 10 menit sejak transaksi dibuat, jam server
    order = await Order.findOneAndUpdate(
      { _id: order._id, status: 'PENDING' },
      {
        $set: {
          totalAmount: tx.totalAmount, uniqueAmount: tx.uniqueAmount, expiresAt,
          'payment.gatewayStatus': tx.status, 'payment.gatewayTxId': tx.id, 'payment.qrisUrl': tx.qrisUrl, 'payment.qrisImage': tx.qrisImage,
          'payment.gatewayExpiredAt': tx.expiredAt, 'payment.createdAt': now,
        },
        $inc: { rev: 1 },
        $push: { events: push(log('qris_created', `total ${tx.totalAmount}`)) },
      },
      { new: true },
    );
    scheduleExpiry(order);
  } catch (err) {
    // Diagnostik lengkap (endpoint, HTTP status, kode & pesan gateway, request_id, waktu) ke log server dan catatan order di Admin Web; tanpa kredensial.
    const detail = err instanceof qris31.GatewayError ? err.summary() : String(err?.message || err);
    console.error(`[payment] ${new Date().toISOString()} gagal membuat transaksi 31 QRIS untuk ${order.orderNo}: ${detail}`);
    order = await Order.findOneAndUpdate(
      { _id: order._id, status: 'PENDING' },
      { $set: { status: 'FAILED', failureKind: 'create', failureReason: detail.slice(0, 300) }, $inc: { rev: 1 }, $push: { events: push(log('create_failed', detail)) } },
      { new: true },
    ) || order;
  }
  await emitOrder(order);
  // Notifikasi dikirim dari state yang SUDAH tersimpan, di latar belakang (idempoten lewat NotificationLog)
  if (order.status === 'PENDING') queueOrderEvent(order, 'orderCreated');
  else if (order.status === 'FAILED') queueOrderEvent(order, 'paymentFailed');
  return { orderNo: order.orderNo, token: tokenFor(order.orderNo), status: order.status };
}

/* ---------- Transisi status (atomik & idempoten) ---------- */
const productVisible = (p) => p.active && p.category?.active !== false;

async function adjustStock(order) {
  // Produk Sistem Code: stok = jumlah code available, dikurangi oleh assignCode (bukan di sini).
  if (order.product?.kind === 'code') return;
  // Stok berkurang SEKALI, hanya oleh pemenang transisi PENDING/EXPIRED -> SUCCESS.
  const hit = await Product.findOneAndUpdate({ _id: order.product.ref, stock: { $gt: 0 } }, { $inc: { stock: -1, sold: 1 } }, { new: false });
  if (!hit) await Order.updateOne({ _id: order._id }, { $set: { stockNote: 'short' }, $push: { events: push(log('stock_short', 'stok habis saat pembayaran masuk')) } });
}

/**
 * Setelah order SUCCESS tersimpan: siarkan stok + jumlah "Terjual" terbaru produk itu lewat Socket.IO yang sudah ada
 * (event publik product:update -> kartu di Marketplace; event admin product:update -> tabel Produk).
 * Tetap dikirim walau stok sudah 0 (pembayaran masuk saat stok habis): penjualan tetap tercatat dan angkanya berubah.
 * Kegagalan di sini TIDAK boleh membatalkan alur pembayaran (order sudah SUCCESS), jadi hanya dicatat.
 */
async function publishProductSale(order) {
  try {
    if (!order.product?.ref) return;
    const p = await Product.findById(order.product.ref).populate('category');
    if (!p) return;   // produk sudah dihapus
    const sold = await soldOf(p._id);
    emitChange('product', {
      before: p, after: p, visible: productVisible,
      adm: (x) => admProduct(x, undefined, sold), pub: (x) => pubProductCard(x, x.category?.name, sold),
      id: (x) => x.productId, admDel: (x) => ({ id: String(x._id), productId: x.productId }), pubDel: (x) => ({ id: x.productId }),
    });
  } catch (err) {
    console.error(`[payment] gagal menyiarkan penjualan untuk ${order.orderNo}: ${err.message}`);
  }
}

async function markPaid(orderNo, { source, gatewayStatus, gatewayPaidAt = '' }) {
  const cur = await Order.findOne({ orderNo }).select('status');
  if (!cur || !['PENDING', 'EXPIRED'].includes(cur.status)) return null;
  const late = cur.status === 'EXPIRED';
  const now = new Date();
  const won = await Order.findOneAndUpdate(
    { orderNo, status: { $in: ['PENDING', 'EXPIRED'] } },     // hanya satu pemanggil yang lolos; callback ganda tidak memproses ulang
    {
      $set: { status: 'SUCCESS', latePayment: late, 'payment.review': false, 'payment.paidAt': now, 'payment.source': source, 'payment.gatewayStatus': gatewayStatus, 'payment.gatewayPaidAt': gatewayPaidAt },
      $inc: { rev: 1 },
      $push: { events: push(log('paid', `${source}${late ? ' · setelah order dinyatakan kedaluwarsa' : ''}`)) },
    },
    { new: true },
  );
  if (!won) return null;
  await adjustStock(won);
  // Sistem Code: code diberikan SETELAH status SUCCESS tersimpan dan SEBELUM disiarkan, jadi satu event membawa code-nya.
  // Gagal di sini tidak membatalkan pembayaran: order tetap SUCCESS dan dipulihkan oleh ensureOrderCode (halaman Payment / worker).
  try { await assignCode(won); } catch (err) { console.error(`[payment] gagal memberi code untuk ${won.orderNo}: ${err.message}`); }
  await publishProductSale(won);
  const fresh = (await Order.findById(won._id)) || won;
  await emitOrder(fresh);
  publishSale(fresh);   // Floating Order Notification di Marketplace (data ber-masking, lihat services/salesFeed.js)
  queueOrderEvent(fresh, 'paymentSuccess');   // hanya pemenang transisi yang sampai di sini: callback ganda tidak mengirim ulang
  return fresh;
}

async function markExpired(orderNo, { source, gatewayStatus = '' }) {
  const won = await Order.findOneAndUpdate(
    { orderNo, status: 'PENDING' },
    { $set: { status: 'EXPIRED', ...(gatewayStatus ? { 'payment.gatewayStatus': gatewayStatus } : {}) }, $inc: { rev: 1 }, $push: { events: push(log('expired', source)) } },
    { new: true },
  );
  if (won) {
    await emitOrder(won);
    queueOrderEvent(won, 'paymentExpired');
  }
  return won;
}

async function markFailed(orderNo, { kind, reason, source, gatewayStatus = '' }) {
  const won = await Order.findOneAndUpdate(
    { orderNo, status: 'PENDING' },
    {
      $set: { status: 'FAILED', failureKind: kind, failureReason: reason.slice(0, 300), 'payment.review': false, ...(gatewayStatus ? { 'payment.gatewayStatus': gatewayStatus } : {}) },
      $inc: { rev: 1 },
      $push: { events: push(log(kind === 'cancelled' ? 'cancelled' : 'rejected', `${source} · ${reason}`)) },
    },
    { new: true },
  );
  if (won) {
    await emitOrder(won);
    queueOrderEvent(won, 'paymentFailed');
  }
  return won;
}

/** Gateway menandai pembayaran 'perlu dicek': pesanan TIDAK diaktifkan; ditandai agar Admin memeriksa. Idempoten. */
async function markReview(orderNo, { source, gatewayStatus }) {
  const won = await Order.findOneAndUpdate(
    { orderNo, status: { $in: ['PENDING', 'EXPIRED'] }, 'payment.review': { $ne: true } },
    { $set: { 'payment.review': true, 'payment.gatewayStatus': gatewayStatus }, $inc: { rev: 1 }, $push: { events: push(log('review', `${source} · gateway meminta pembayaran diperiksa`)) } },
    { new: true },
  );
  if (won) await emitOrder(won);
  return won;
}

/**
 * Satu pintu untuk webhook dan pengecekan status. `gw` = hasil klasifikasi qris31 ({ kind, status, paidAt }).
 * Mengembalikan order yang berubah, atau null bila tidak ada perubahan (mis. callback ganda).
 */
export async function applyGatewayStatus(orderNo, gw, { source } = {}) {
  const status = String(gw?.status || '').toUpperCase();
  switch (gw?.kind) {
    case 'paid': return markPaid(orderNo, { source, gatewayStatus: status, gatewayPaidAt: gw.paidAt || '' });
    case 'expired': return markExpired(orderNo, { source: `${source} · 31 QRIS EXPIRED`, gatewayStatus: status });
    case 'rejected': return markFailed(orderNo, { kind: 'rejected', reason: 'Pembayaran ditolak oleh gateway', source, gatewayStatus: status });
    case 'cancelled': return markFailed(orderNo, { kind: 'cancelled', reason: 'Transaksi dibatalkan', source, gatewayStatus: status });
    case 'review': return markReview(orderNo, { source, gatewayStatus: status });
    case 'pending': return null;
    default:
      console.warn(`[payment] status 31 QRIS tidak dikenali untuk ${orderNo}: "${status.slice(0, 40)}" (diabaikan)`);
      return null;
  }
}

/* ---------- Webhook ---------- */
const sameMoney = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
const TERMINAL_WEBHOOK = new Set(['applied', 'duplicate', 'ignored']);
const clip = (v, n) => String(v ?? '').slice(0, n);

/**
 * Webhook 31 QRIS (POST /api/payments/31qris/webhook). Urutan:
 *   1. X-31QRIS-Signature = sha256=HMAC(secret, `${X-31QRIS-Timestamp}.${byte mentah body}`), timestamp maks. 300 detik -> 401 bila salah; tidak ada yang disentuh.
 *   2. Idempotensi: X-31QRIS-Event-ID (cadangan: hash body) yang sudah selesai diproses dibalas 200 `duplicate` tanpa memproses ulang.
 *   3. Order dicari lewat order_id / ID transaksi; tak dikenal = 200 diabaikan (bisa milik aplikasi lain pada gateway yang sama).
 *   4. Isi webhook TIDAK dipercaya untuk menentukan status: status dibaca ulang dari gateway, lalu nominal divalidasi dan diterapkan secara atomik.
 *   5. Gateway tak terjangkau / respons tak valid -> 503 supaya gateway mencoba ulang (worker juga tetap mengecek berkala).
 * Setiap pengiriman dicatat di WebhookLog (termasuk yang ditolak).
 */
export async function handleWebhook({ rawBody, body, signature, timestamp, eventId = '', ip = '' }) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const parsed = payload ? qris31.parseWebhook(payload) : { id: '', orderId: '', status: '', event: '', kind: 'unknown', totalAmount: null, paidAmount: null };
  const base = {
    provider: qris31.PROVIDER, orderNo: clip(parsed.orderId, 40), txId: clip(parsed.id, 80), event: clip(parsed.event, 80), gatewayStatus: clip(parsed.status, 40),
    payload: raw.toString('utf8').slice(0, 8192), ip: clip(ip, 64), receivedAt: new Date(),
  };
  const reject = async (code, error, note) => {
    await WebhookLog.create({ ...base, signatureValid: false, outcome: 'rejected', httpCode: code, note }).catch(() => {});
    return { code, body: { ok: false, error } };
  };

  const cred = await getCredentials();
  if (!cred.webhookSecret) {
    console.warn('[payment] webhook 31 QRIS diterima tetapi Webhook Secret belum diatur');
    return reject(503, 'webhook secret belum diatur', 'Webhook Secret belum diatur di server');
  }
  const sig = qris31.checkWebhookSignature(raw, { signature, timestamp }, cred.webhookSecret);
  if (!sig.ok) {
    const why = { missing: 'Header X-31QRIS-Signature / X-31QRIS-Timestamp tidak ada', stale: 'X-31QRIS-Timestamp di luar toleransi 300 detik', mismatch: 'X-31QRIS-Signature tidak cocok (periksa Webhook Secret)', '': 'X-31QRIS-Signature tidak cocok (periksa Webhook Secret)' }[sig.reason];
    console.warn(`[payment] webhook 31 QRIS DITOLAK: ${why}`);
    return reject(401, 'signature tidak valid', why);
  }
  if (!payload) return reject(400, 'payload tidak valid', 'Body bukan objek JSON');

  // Event ID sama pada setiap percobaan kirim ulang -> kunci idempotensi resmi. Tanpa header itu, pakai hash byte mentah body.
  const evId = clip(eventId || parsed.eventId, 80);
  const bodyHash = evId ? `evt:${evId}` : crypto.createHash('sha256').update(raw).digest('hex');
  let entry;
  try {
    entry = await WebhookLog.create({ ...base, bodyHash, signatureValid: true, outcome: 'processing' });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const prev = await WebhookLog.findOneAndUpdate({ bodyHash }, { $inc: { deliveries: 1 }, $set: { receivedAt: new Date() } }, { new: true });
    if (prev && TERMINAL_WEBHOOK.has(prev.outcome)) return { code: 200, body: { ok: true, duplicate: true } };
    if (!prev) return { code: 503, body: { ok: false, error: 'coba lagi' } };
    if (prev.outcome === 'processing' && Date.now() - prev.updatedAt.getTime() < 15_000) return { code: 503, body: { ok: false, error: 'sedang diproses' } };   // kiriman ganda bersamaan
    entry = prev;   // pengiriman sebelumnya gagal (error/rejected): proses ulang
  }
  const finish = async (code, resBody, outcome, note = '') => {
    await WebhookLog.updateOne({ _id: entry._id }, { $set: { outcome, httpCode: code, note: clip(note, 300) } }).catch(() => {});
    emitAdmin('payment-webhook', { orderNo: base.orderNo, outcome });   // Admin Web memuat ulang riwayat webhook
    return { code, body: resBody };
  };

  try {
    if (parsed.event === 'webhook.test') return finish(200, { ok: true, ignored: 'webhook.test' }, 'ignored', 'uji kirim dari aplikasi 31 QRIS');
    const order = (parsed.orderId && await Order.findOne({ orderNo: parsed.orderId }))
      || (parsed.id && await Order.findOne({ 'payment.gatewayTxId': parsed.id }));
    if (!order) return finish(200, { ok: true, ignored: 'order tidak dikenal' }, 'ignored', 'order tidak dikenal');
    if (order.payment?.provider !== qris31.PROVIDER) return finish(200, { ok: true, ignored: 'bukan order 31 QRIS' }, 'ignored', 'order lama (bukan 31 QRIS)');
    await WebhookLog.updateOne({ _id: entry._id }, { $set: { orderNo: order.orderNo, txId: order.payment.gatewayTxId || base.txId } });

    // Nominal pada webhook (bila ada) harus cocok dengan transaksi tersimpan; ketidakcocokan = ditolak, status tidak disentuh.
    const claimed = parsed.paidAmount ?? parsed.totalAmount;
    if (claimed !== null && claimed !== undefined && order.totalAmount !== null && !sameMoney(claimed, order.totalAmount)) {
      console.warn(`[payment] webhook DITOLAK (nominal ${claimed} != ${order.totalAmount}) untuk ${order.orderNo}`);
      await Order.updateOne({ _id: order._id }, { $push: { events: push(log('amount_mismatch', `webhook ${claimed} != ${order.totalAmount}`)) } });
      return finish(400, { ok: false, error: 'nominal tidak cocok' }, 'rejected', `nominal ${claimed} != ${order.totalAmount}`);
    }
    await Order.updateOne({ _id: order._id }, { $inc: { 'payment.webhookCount': 1 }, $set: { 'payment.lastWebhookAt': new Date() } });

    // Status SELALU dibaca ulang dari gateway; isi webhook hanya pemicu.
    const result = await checkRemote(order, { source: 'webhook' });
    // Webhook menyatakan perubahan tetapi gateway masih 'pending' (mis. webhook mendahului commit gateway): jangan dianggap selesai.
    // 503 + outcome 'error' = gateway mencoba ulang dan kiriman yang sama diproses ulang (bukan dilewati sebagai duplikat).
    if (!result.changed && result.kind === 'pending' && ['paid', 'review', 'rejected', 'expired', 'cancelled'].includes(parsed.kind)) {
      return finish(503, { ok: false, error: 'gateway belum mengonfirmasi, coba lagi' }, 'error', `webhook ${parsed.status} tetapi gateway masih ${result.status}`);
    }
    const note = result.changed ? `→ ${result.changed.status}` : `gateway: ${result.status || '—'}; tidak ada perubahan`;
    return finish(200, { ok: true, duplicate: !result.changed }, result.changed ? 'applied' : 'duplicate', note);
  } catch (err) {
    const detail = err instanceof qris31.GatewayError ? err.summary() : String(err?.message || err);
    console.error(`[payment] ${new Date().toISOString()} webhook 31 QRIS gagal diproses: ${detail}`);
    return finish(503, { ok: false, error: 'gagal memverifikasi ke gateway, coba lagi' }, 'error', detail);   // 503: gateway akan mencoba ulang
  }
}

/** Riwayat webhook untuk Admin Web (terbaru lebih dulu). */
export async function listWebhookLogs({ page = 1, limit = 20, orderNo = '' } = {}) {
  const filter = orderNo ? { orderNo } : {};
  const [total, docs] = await Promise.all([
    WebhookLog.countDocuments(filter),
    WebhookLog.find(filter).sort({ receivedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return {
    total,
    items: docs.map((w) => ({
      id: String(w._id), at: iso(w.receivedAt), orderNo: w.orderNo, txId: w.txId, event: w.event, gatewayStatus: w.gatewayStatus,
      signatureValid: w.signatureValid, outcome: w.outcome, httpCode: w.httpCode, note: w.note, deliveries: w.deliveries, payload: w.payload, ip: w.ip,
    })),
  };
}

/* ---------- Pengecekan status (fallback) & kedaluwarsa ---------- */
const inflight = new Map();
const once = (key, fn) => {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
};

/**
 * Baca status dari 31 QRIS lalu terapkan. Mengembalikan { changed, status }.
 * Order lama (bukan 31 QRIS) tidak pernah dicek ke gateway. Lunas hanya bila nominal dari gateway sama dengan total tersimpan.
 */
async function checkRemote(order, { source = 'status-check' } = {}) {
  if (order.payment?.provider !== qris31.PROVIDER) return { changed: null, status: '', kind: 'unknown' };
  const cred = await getCredentials();
  if (!cred.ready) throw new qris31.GatewayError('API Key 31 QRIS belum diisi.', { kind: 'auth' });
  await Order.updateOne({ _id: order._id }, { $set: { 'payment.lastCheckedAt': new Date() } });
  const r = await qris31.getTransaction(cred, { id: order.payment?.gatewayTxId, orderId: order.orderNo });
  if (r.kind === 'paid') {
    const reported = r.paidAmount ?? r.totalAmount;
    if (reported !== null && !sameMoney(reported, order.totalAmount)) {
      console.warn(`[payment] status-check DITOLAK (nominal ${reported} != ${order.totalAmount}) untuk ${order.orderNo}`);
      await Order.updateOne({ _id: order._id }, { $push: { events: push(log('amount_mismatch', `${source} ${reported} != ${order.totalAmount}`)) } });
      return { changed: null, status: r.status, kind: r.kind };
    }
  }
  return { changed: await applyGatewayStatus(order.orderNo, r, { source }), status: r.status, kind: r.kind };
}

/** Jatuh tempo: tanyakan 31 QRIS dulu (mungkin sudah dibayar), baru tutup order. Tidak ada pembatalan sepihak oleh frontend. */
async function settleExpiry(order) {
  let reachable = true;
  try {
    const { changed } = await checkRemote(order);
    if (changed) return changed;                      // dibayar / ditolak / dibatalkan / 31 QRIS menyatakan EXPIRED
  } catch (err) {
    reachable = false;
    console.warn(`[payment] cek status ${order.orderNo} gagal: ${err.message}`);
  }
  if (!reachable && Date.now() - order.expiresAt.getTime() < EXPIRY_GRACE_MS) return null;   // coba lagi di putaran berikutnya
  return markExpired(order.orderNo, { source: 'batas 10 menit' });
}

async function failOrphan(order) {
  const won = await Order.findOneAndUpdate(
    { _id: order._id, status: 'PENDING', expiresAt: null },
    { $set: { status: 'FAILED', failureKind: 'create', failureReason: 'Transaksi tidak selesai dibuat.' }, $inc: { rev: 1 }, $push: { events: push(log('create_failed', 'tidak ada QRIS setelah batas waktu')) } },
    { new: true },
  );
  if (won) {
    await emitOrder(won);
    queueOrderEvent(won, 'paymentFailed');
  }
}

export async function settleIfDue(order) {
  if (order.status !== 'PENDING') return order;
  const now = Date.now();
  if (order.expiresAt && order.expiresAt.getTime() <= now) {
    await once(`exp:${order.orderNo}`, () => settleExpiry(order));
    return (await Order.findById(order._id)) || order;
  }
  if (!order.expiresAt && now - order.createdAt.getTime() > ORPHAN_MS) {
    await failOrphan(order);
    return (await Order.findById(order._id)) || order;
  }
  return order;
}

const timers = new Map();
function scheduleExpiry(order) {
  if (!order.expiresAt) return;
  clearTimeout(timers.get(order.orderNo));
  const t = setTimeout(() => {
    timers.delete(order.orderNo);
    Order.findById(order._id).then((o) => o && settleIfDue(o)).catch((e) => console.error('[payment] expiry timer:', e.message));
  }, Math.max(0, order.expiresAt.getTime() - Date.now()) + 250);
  t.unref?.();
  timers.set(order.orderNo, t);
}

/**
 * Hapus permanen satu order dari database (Admin Web). Order PENDING yang belum jatuh tempo ditolak:
 * pelanggan masih bisa membayar dan webhook-nya tidak akan menemukan order.
 * Code redeem yang sudah diberikan TETAP berstatus sold (pelanggan sudah menerimanya); hanya log notifikasi order ini ikut dihapus.
 */
export async function deleteOrder(id) {
  const o = await Order.findById(id);
  if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan.');
  if (o.status === 'PENDING' && o.expiresAt && o.expiresAt.getTime() > Date.now()) {
    throw new HttpError(409, 'Pesanan ini masih menunggu pembayaran. Tunggu sampai kedaluwarsa sebelum dihapus.');
  }
  const res = await Order.deleteOne({ _id: o._id, status: o.status });
  if (!res.deletedCount) throw new HttpError(409, 'Status pesanan baru saja berubah. Muat ulang daftar lalu coba lagi.');
  clearTimeout(timers.get(o.orderNo));
  timers.delete(o.orderNo);
  await NotificationLog.deleteMany({ orderId: o._id }).catch((e) => console.error('[payment] hapus log notifikasi:', e.message));
  emitAdmin('order:delete', { id: String(o._id), orderNo: o.orderNo, mode: o.payment?.mode || 'sandbox' });
  if (o.status === 'SUCCESS') {
    // Order SUCCESS ikut membentuk "Terjual", statistik beranda, dan notifikasi order: segarkan semuanya lewat jalur realtime yang sama
    // dengan saat pembayaran masuk (product:update menghitung ulang dari koleksi Order, lalu statistik disiarkan ulang).
    await publishProductSale(o);
    unpublishSale(o);
  }
  return { orderNo: o.orderNo, status: o.status };
}

/* ---------- Sistem Code: pemulihan & pemenuhan ---------- */
/**
 * Pastikan order SUCCESS produk code memegang code (idempoten). Dipakai halaman Payment, worker, dan pemenuhan antrean.
 * Menyiarkan order bila ada perubahan. Mengembalikan order terbaru.
 */
export async function ensureOrderCode(order) {
  if (order?.product?.kind !== 'code' || order.status !== 'SUCCESS' || order.codeState === 'assigned') return order;
  try {
    const r = await assignCode(order);
    if (!r.changed) return order;
    const fresh = (await Order.findById(order._id)) || order;
    await emitOrder(fresh);
    return fresh;
  } catch (err) {
    console.error(`[payment] pemulihan code ${order.orderNo} gagal: ${err.message}`);
    return order;
  }
}

/* ---------- Pembacaan oleh pelanggan ---------- */
export async function getOrderForCustomer(orderNo, token) {
  if (typeof orderNo !== 'string' || !/^MP-\d{6}-[A-Z0-9]{6}$/.test(orderNo) || !tokenOk(orderNo, token)) return null;   // 404 untuk semuanya: tidak membocorkan keberadaan order
  let order = await Order.findOne({ orderNo });
  if (!order) return null;
  order = await settleIfDue(order);
  order = await ensureOrderCode(order);   // membuka ulang halaman sukses tidak pernah membuat code kedua: assignCode idempoten
  const { waAdmin } = await getPaymentConfig();
  return pubOrder(order, { waAdmin, redeem: await redeemViewFor(order) });
}

setOrderJoinHandler(getOrderForCustomer);

/* ---------- Cek Pesanan (pencarian publik) ---------- */
const TRACK_LIMIT = 10;

/** Cari berdasarkan ID transaksi ATAU email (input sudah divalidasi zod: string murni, bukan operator query). */
export async function trackOrders({ by, q }) {
  let docs;
  if (by === 'order') {
    const one = await Order.findOne({ orderNo: q });
    docs = one ? [one] : [];
  } else {
    docs = await Order.find({ 'customer.email': q }).sort({ createdAt: -1 }).limit(TRACK_LIMIT);   // memakai indeks customer.email
  }
  // Order yang sudah lewat batas bayar dituntaskan dulu (cek 31 QRIS), sama seperti halaman Payment: status tidak pernah usang
  docs = await Promise.all(docs.map(async (d) => ensureOrderCode(await settleIfDue(d))));
  const { waAdmin } = await getPaymentConfig();
  const orders = await Promise.all(docs.map(async (d) => ({ ...pubTrack(d, { redeem: await trackRedeem(d) }), watch: watchTokenFor(d.orderNo) })));
  return { orders, waAdmin };
}

/** Pembacaan satu order untuk halaman Cek Pesanan lewat token pantau (join Socket.IO & polling cadangan). */
export async function getTrackForWatch(orderNo, watch) {
  if (typeof orderNo !== 'string' || !ORDER_NO_RE.test(orderNo) || !watchTokenOk(orderNo, watch)) return null;
  let order = await Order.findOne({ orderNo });
  if (!order) return null;
  order = await ensureOrderCode(await settleIfDue(order));
  return pubTrack(order, { redeem: await trackRedeem(order) });
}

setTrackJoinHandler(getTrackForWatch);

/* ---------- Worker latar belakang ---------- */
let worker;
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    for (const o of await Order.find({ status: 'PENDING', expiresAt: { $lte: now } }).limit(25)) await settleIfDue(o);
    for (const o of await Order.find({ status: 'PENDING', expiresAt: null, createdAt: { $lte: new Date(Date.now() - ORPHAN_MS) } }).limit(25)) await settleIfDue(o);
    // Sistem Code: order yang sudah SUCCESS tapi belum sempat diberi code (proses mati di tengah jalan) dipulihkan di sini
    for (const o of await Order.find({ 'product.kind': 'code', status: 'SUCCESS', codeState: '', updatedAt: { $lte: new Date(Date.now() - 20_000) } }).limit(25)) await ensureOrderCode(o);
    // Fallback bila webhook terlambat/tidak sampai (mis. localhost tanpa tunnel): cek status ke 31 QRIS secara berkala
    const stale = await Order.find({
      status: 'PENDING', expiresAt: { $gt: now }, 'payment.provider': qris31.PROVIDER,
      $or: [{ 'payment.lastCheckedAt': null }, { 'payment.lastCheckedAt': { $lt: new Date(Date.now() - POLL_EVERY_MS) } }],
    }).sort({ 'payment.lastCheckedAt': 1 }).limit(20);
    for (const o of stale) {
      try { await once(`chk:${o.orderNo}`, () => checkRemote(o)); } catch (err) { console.warn(`[payment] cek status ${o.orderNo} gagal: ${err.message}`); }
    }
  } catch (err) {
    console.error('[payment] worker:', err.message);
  } finally {
    running = false;
  }
}

export function startPaymentWorker({ intervalMs = 4000 } = {}) {
  stopPaymentWorker();
  worker = setInterval(tick, intervalMs);
  worker.unref?.();
  // Setelah restart: jadwalkan ulang timer kedaluwarsa order yang masih menunggu
  Order.find({ status: 'PENDING', expiresAt: { $gt: new Date() } }).limit(500).then((list) => list.forEach(scheduleExpiry)).catch(() => {});
}
export function stopPaymentWorker() {
  clearInterval(worker);
  worker = undefined;
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
}

/* ---------- Admin ---------- */
export async function testGateway() {
  const cred = await getCredentials();
  if (!cred.ready) throw new HttpError(422, 'Isi API Key 31 QRIS terlebih dahulu.');
  try {
    const me = await qris31.getMe(cred);   // GET /v1/me: tanpa izin khusus, memuat izin kunci serta kesiapan QRIS & webhook akun
    const scopes = Array.isArray(me.key?.scopes) ? me.key.scopes : [];
    const missing = ['transactions:create', 'transactions:read', 'transactions:cancel'].filter((x) => !scopes.includes(x));
    const warnings = [];
    if (missing.length) warnings.push(`API Key belum memiliki izin: ${missing.join(', ')}.`);
    if (me.account?.qris_configured === false) warnings.push('Gambar QRIS belum diunggah di aplikasi 31 QRIS (transaksi akan ditolak QRIS_NOT_CONFIGURED).');
    return { ok: true, mode: cred.mode, webhookReady: Boolean(cred.webhookSecret), ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
  } catch (err) {
    if (err instanceof qris31.GatewayError && (err.kind === 'auth' || err.kind === 'scope')) throw new HttpError(502, `31 QRIS menolak API Key (HTTP ${err.status || 401}${err.code ? ` ${err.code}` : ''}). Periksa API Key.`);
    if (err instanceof qris31.GatewayError) console.warn(`[payment] tes koneksi 31 QRIS gagal: ${err.summary()}`);
    throw new HttpError(502, '31 QRIS tidak dapat dihubungi. Coba lagi.');
  }
}

/**
 * Batalkan pesanan yang masih menunggu (Admin Web): cek status dulu (jangan membatalkan yang sudah dibayar),
 * lalu POST /v1/transactions/{id}/cancel, lalu tandai FAILED (dibatalkan).
 */
export async function cancelOrder(id) {
  const o = await Order.findById(id);
  if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan.');
  if (o.status !== 'PENDING') throw new HttpError(409, 'Hanya pesanan yang masih menunggu pembayaran yang bisa dibatalkan.');
  if (o.payment?.provider === qris31.PROVIDER && o.payment.gatewayTxId) {
    const cred = await getCredentials();
    try {
      const { changed } = await checkRemote(o, { source: 'admin' });
      if (changed) throw new HttpError(409, `Status pesanan baru saja berubah menjadi ${changed.status}. Muat ulang daftar.`);
      await qris31.cancelTransaction(cred, o.payment.gatewayTxId);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof qris31.GatewayError && err.kind === 'scope') throw new HttpError(403, 'API Key tidak memiliki izin transactions:cancel (INSUFFICIENT_SCOPE).');
      throw new HttpError(502, err instanceof qris31.GatewayError ? `31 QRIS menolak pembatalan: ${err.detail || err.message}` : 'Gagal membatalkan di 31 QRIS.');
    }
  }
  const won = await markFailed(o.orderNo, { kind: 'cancelled', reason: 'Dibatalkan oleh Admin', source: 'admin' });
  if (!won) throw new HttpError(409, 'Status pesanan baru saja berubah. Muat ulang daftar.');
  return { orderNo: won.orderNo, status: won.status };
}
