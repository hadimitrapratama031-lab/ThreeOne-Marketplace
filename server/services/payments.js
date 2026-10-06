import crypto from 'node:crypto';
import { Order, Product } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { safeEqual } from '../lib/secrets.js';
import { config } from '../config/env.js';
import { tokenFor, tokenOk } from '../lib/orderToken.js';
import { queueOrderEvent } from './notifications.js';
import { publicUrl } from '../lib/r2.js';
import { admProduct, pubProductCard } from '../lib/serialize.js';
import { broadcastStats } from './stats.js';
import { getSetting } from './settings.js';
import { emitChange, emitToRoom, emitAdmin, setOrderJoinHandler } from '../lib/realtime.js';
import { getPaymentConfig, getCredentials } from './paymentSettings.js';
import * as klikqris from './klikqris.js';

/**
 * Alur pembayaran (backend = sumber kebenaran):
 *   createCheckout -> order PENDING -> KlikQRIS /qris/create -> expiresAt = sekarang + 10 menit (waktu SERVER)
 *   KlikQRIS webhook / pengecekan status -> applyGatewayStatus (transisi atomik, idempoten)
 *   -> MongoDB -> Socket.IO (room per-order) -> halaman Payment berubah tanpa refresh.
 */
export const EXPIRY_MS = 10 * 60 * 1000;
const POLL_EVERY_MS = 10_000;          // jeda minimum cek status KlikQRIS per order (fallback bila webhook terlambat)
const EXPIRY_GRACE_MS = 120_000;       // bila KlikQRIS tak terjangkau saat jatuh tempo, tunggu paling lama ini sebelum menutup order
const ORPHAN_MS = 90_000;              // order PENDING tanpa QRIS lebih lama dari ini dianggap gagal dibuat
const PAID = new Set(['PAID', 'SUCCESS']);   // webhook mengirim PAID, cek status mengirim SUCCESS

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

export function pubOrder(o, { waAdmin = '' } = {}) {
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
    failureReason: o.status === 'FAILED' ? PUBLIC_FAIL : null,
    waAdmin,
  };
}

export function admOrder(o) {
  return {
    id: String(o._id),
    orderNo: o.orderNo,
    status: o.status,
    customer: o.customer,
    product: { id: o.product.productId, name: o.product.name },
    amount: o.amount,
    totalAmount: o.totalAmount,
    mode: o.payment?.mode || 'sandbox',
    gatewayStatus: o.payment?.gatewayStatus || '',
    source: o.payment?.source || '',
    latePayment: Boolean(o.latePayment),
    stockNote: o.stockNote || '',
    failureReason: o.failureReason || '',
    webhookCount: o.payment?.webhookCount || 0,
    reportUrl: o.payment?.reportUrl || '',
    createdAt: iso(o.createdAt),
    expiresAt: iso(o.expiresAt),
    paidAt: iso(o.payment?.paidAt),
    events: (o.events || []).map((e) => ({ at: iso(e.at), type: e.type, detail: e.detail })),
  };
}

const log = (type, detail = '') => ({ at: new Date(), type, detail: String(detail).slice(0, 300) });
const push = (...events) => ({ $each: events, $slice: -30 });

/** Kirim perubahan ke halaman Payment (room khusus order) dan ke Admin Web. */
async function emitOrder(o) {
  const { waAdmin } = await getPaymentConfig();
  emitToRoom(`order:${o.orderNo}`, 'order:update', pubOrder(o, { waAdmin }));
  emitAdmin('order:update', admOrder(o));
}

/* ---------- Checkout ---------- */
function callbackUrlFor(base) {
  try {
    const u = new URL(base);
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u.hostname) || u.hostname.endsWith('.local')) return '';   // tak terjangkau dari internet
    return `${u.origin}/api/payments/klikqris/webhook`;
  } catch { return ''; }
}

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
        product: { ref: product._id, productId: product.productId, name: product.name, category: product.category?.name || '', imageKey: (product.media || []).find((m) => m.type === 'image')?.key || '' },
        amount: product.price,
        payment: { mode: cfg.mode },
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

  const base = cfg.publicBaseUrl || requestBase;
  try {
    const tx = await klikqris.createTransaction(cfg, {
      orderId: order.orderNo,
      amount: order.amount,
      keterangan: `Pembelian ${order.product.name}`.slice(0, 100),
      callbackUrl: callbackUrlFor(base),
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRY_MS);   // 10 menit sejak transaksi dibuat, jam server
    order = await Order.findOneAndUpdate(
      { _id: order._id, status: 'PENDING' },
      {
        $set: {
          totalAmount: tx.totalAmount, uniqueAmount: tx.uniqueAmount, expiresAt,
          'payment.gatewayStatus': tx.status, 'payment.qrisUrl': tx.qrisUrl, 'payment.reportUrl': tx.reportUrl,
          'payment.signature': tx.signature, 'payment.gatewayExpiredAt': tx.expiredAt, 'payment.createdAt': now,
        },
        $inc: { rev: 1 },
        $push: { events: push(log('qris_created', `total ${tx.totalAmount}`)) },
      },
      { new: true },
    );
    scheduleExpiry(order);
  } catch (err) {
    const detail = err instanceof klikqris.GatewayError ? `${err.message} ${err.status || ''} ${err.detail}`.trim() : String(err?.message || err);
    console.error(`[payment] gagal membuat transaksi KlikQRIS untuk ${order.orderNo}: ${detail}`);   // tanpa kredensial
    order = await Order.findOneAndUpdate(
      { _id: order._id, status: 'PENDING' },
      { $set: { status: 'FAILED', failureReason: detail.slice(0, 300) }, $inc: { rev: 1 }, $push: { events: push(log('create_failed', detail)) } },
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
async function adjustStock(order) {
  // Stok berkurang SEKALI, hanya oleh pemenang transisi PENDING/EXPIRED -> SUCCESS.
  const before = await Product.findOneAndUpdate({ _id: order.product.ref, stock: { $gt: 0 } }, { $inc: { stock: -1, sold: 1 } }, { new: false }).populate('category');
  if (!before) {
    await Order.updateOne({ _id: order._id }, { $set: { stockNote: 'short' }, $push: { events: push(log('stock_short', 'stok habis saat pembayaran masuk')) } });
    return;
  }
  const after = await Product.findById(before._id).populate('category');
  const visible = (p) => p.active && p.category?.active !== false;
  emitChange('product', {
    before, after, visible,
    adm: (p) => admProduct(p), pub: (p) => pubProductCard(p, p.category?.name),
    id: (p) => p.productId, admDel: (p) => ({ id: String(p._id), productId: p.productId }), pubDel: (p) => ({ id: p.productId }),
  });
}

async function markPaid(orderNo, { source, gatewayStatus, gatewayPaidAt = '' }) {
  const cur = await Order.findOne({ orderNo }).select('status');
  if (!cur || !['PENDING', 'EXPIRED'].includes(cur.status)) return null;
  const late = cur.status === 'EXPIRED';
  const now = new Date();
  const won = await Order.findOneAndUpdate(
    { orderNo, status: { $in: ['PENDING', 'EXPIRED'] } },     // hanya satu pemanggil yang lolos; callback ganda tidak memproses ulang
    {
      $set: { status: 'SUCCESS', latePayment: late, 'payment.paidAt': now, 'payment.source': source, 'payment.gatewayStatus': gatewayStatus, 'payment.gatewayPaidAt': gatewayPaidAt },
      $inc: { rev: 1 },
      $push: { events: push(log('paid', `${source}${late ? ' · setelah order dinyatakan kedaluwarsa' : ''}`)) },
    },
    { new: true },
  );
  if (!won) return null;
  await adjustStock(won);
  const fresh = (await Order.findById(won._id)) || won;
  await emitOrder(fresh);
  broadcastStats(await getSetting('stats').catch(() => ({})), await getSetting('productPage').catch(() => ({})));   // Pelanggan & Total Pesanan di beranda ikut naik
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

/**
 * Satu pintu untuk webhook dan pengecekan status. Hanya status resmi KlikQRIS yang dikenali.
 * Mengembalikan order yang berubah, atau null bila tidak ada perubahan (mis. callback ganda).
 */
export async function applyGatewayStatus(orderNo, gwStatus, { source, gatewayPaidAt = '' } = {}) {
  const s = String(gwStatus || '').toUpperCase();
  if (PAID.has(s)) return markPaid(orderNo, { source, gatewayStatus: s, gatewayPaidAt });
  if (s === 'EXPIRED') return markExpired(orderNo, { source: `${source} · KlikQRIS EXPIRED`, gatewayStatus: s });
  if (s !== 'PENDING') console.warn(`[payment] status KlikQRIS tidak dikenali untuk ${orderNo}: "${String(gwStatus).slice(0, 40)}" (diabaikan)`);
  return null;
}

/* ---------- Webhook ---------- */
/**
 * Payload resmi (datar): order_id, status (PAID/EXPIRED), amount, total_amount, payment_date, signature, ...
 * Validasi: signature callback HARUS sama dengan signature dari respons create (sesuai dokumentasi).
 * Balasan 200 = diterima (termasuk callback ganda); 401 = signature salah.
 */
export async function handleWebhook(body) {
  const orderId = typeof body?.order_id === 'string' ? body.order_id : '';
  const signature = typeof body?.signature === 'string' ? body.signature : '';
  if (!orderId || !signature || typeof body?.status !== 'string') return { code: 400, body: { ok: false, error: 'payload tidak valid' } };

  const order = await Order.findOne({ orderNo: orderId }).select('+payment.signature');
  if (!order) return { code: 200, body: { ok: true, ignored: 'order tidak dikenal' } };   // bisa milik aplikasi lain pada merchant yang sama; 200 agar tidak diulang terus
  if (!order.payment?.signature || !safeEqual(signature, order.payment.signature)) {
    console.warn(`[payment] webhook DITOLAK (signature tidak cocok) untuk ${orderId}`);
    return { code: 401, body: { ok: false, error: 'signature tidak valid' } };
  }
  if (body.total_amount !== undefined && body.total_amount !== null && Number(body.total_amount) !== order.totalAmount) {
    console.warn(`[payment] webhook DITOLAK (total_amount ${body.total_amount} != ${order.totalAmount}) untuk ${orderId}`);
    return { code: 400, body: { ok: false, error: 'nominal tidak cocok' } };
  }
  await Order.updateOne({ _id: order._id }, { $inc: { 'payment.webhookCount': 1 }, $set: { 'payment.lastWebhookAt': new Date() } });
  const changed = await applyGatewayStatus(orderId, body.status, { source: 'webhook', gatewayPaidAt: typeof body.payment_date === 'string' ? body.payment_date : '' });
  return { code: 200, body: { ok: true, duplicate: !changed } };
}

/* ---------- Pengecekan status (fallback) & kedaluwarsa ---------- */
const inflight = new Map();
const once = (key, fn) => {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
};

async function checkRemote(order) {
  const cred = await getCredentials(order.payment?.mode);
  if (!cred.ready) return null;
  await Order.updateOne({ _id: order._id }, { $set: { 'payment.lastCheckedAt': new Date() } });
  const r = await klikqris.checkStatus(cred, order.orderNo);
  return applyGatewayStatus(order.orderNo, r.status, { source: 'status-check', gatewayPaidAt: r.paidAt });
}

/** Jatuh tempo: tanyakan KlikQRIS dulu (mungkin sudah dibayar), baru tutup order. Tidak ada pembatalan sepihak oleh frontend. */
async function settleExpiry(order) {
  let reachable = true;
  try {
    const changed = await checkRemote(order);
    if (changed) return changed;                      // dibayar (SUCCESS) atau KlikQRIS menyatakan EXPIRED
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
    { $set: { status: 'FAILED', failureReason: 'Transaksi tidak selesai dibuat.' }, $inc: { rev: 1 }, $push: { events: push(log('create_failed', 'tidak ada QRIS setelah batas waktu')) } },
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

/* ---------- Pembacaan oleh pelanggan ---------- */
export async function getOrderForCustomer(orderNo, token) {
  if (typeof orderNo !== 'string' || !/^MP-\d{6}-[A-Z0-9]{6}$/.test(orderNo) || !tokenOk(orderNo, token)) return null;   // 404 untuk semuanya: tidak membocorkan keberadaan order
  let order = await Order.findOne({ orderNo });
  if (!order) return null;
  order = await settleIfDue(order);
  const { waAdmin } = await getPaymentConfig();
  return pubOrder(order, { waAdmin });
}

setOrderJoinHandler(getOrderForCustomer);

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
    // Fallback bila webhook terlambat/tidak sampai (mis. localhost tanpa tunnel): cek status ke KlikQRIS secara berkala
    const stale = await Order.find({
      status: 'PENDING', expiresAt: { $gt: now },
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
  if (!cred.ready) throw new HttpError(422, 'Lengkapi API Key dan Merchant ID untuk mode aktif terlebih dahulu.');
  try {
    await klikqris.testCredentials(cred);
    return { ok: true, mode: cred.mode };
  } catch (err) {
    throw new HttpError(502, err instanceof klikqris.GatewayError && err.status ? `KlikQRIS menolak kredensial (HTTP ${err.status}). Periksa API Key dan Merchant ID.` : 'KlikQRIS tidak dapat dihubungi. Coba lagi.');
  }
}
