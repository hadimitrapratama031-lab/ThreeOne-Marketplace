import crypto from 'node:crypto';
import { Order, Product, NotificationLog } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { safeEqual } from '../lib/secrets.js';
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
    failureReason: o.status === 'FAILED' ? PUBLIC_FAIL : null,
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
    webhookCount: o.payment?.webhookCount || 0,
    reportUrl: o.payment?.reportUrl || '',
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
    failureReason: o.status === 'FAILED' ? PUBLIC_FAIL : null,
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
        product: { ref: product._id, productId: product.productId, name: product.name, category: product.category?.name || '', imageKey: (product.media || []).find((m) => m.type === 'image' && m.key && m.source !== 'steam')?.key || '', kind: product.kind || 'normal' },
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
          'payment.gatewayStatus': tx.status, 'payment.qrisUrl': tx.qrisUrl, 'payment.qrisImage': tx.qrisImage, 'payment.reportUrl': tx.reportUrl,
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
      $set: { status: 'SUCCESS', latePayment: late, 'payment.paidAt': now, 'payment.source': source, 'payment.gatewayStatus': gatewayStatus, 'payment.gatewayPaidAt': gatewayPaidAt },
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
  // Order yang sudah lewat batas bayar dituntaskan dulu (cek KlikQRIS), sama seperti halaman Payment: status tidak pernah usang
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
