import { Product, Order, RedeemCode } from '../models/index.js';
import { HttpError, escapeRegex } from '../lib/http.js';
import { parseCodeLines, codeKeyOf, tutorialSteps, maskCode, MAX_CODES_PER_SUBMIT } from '../lib/codes.js';
import { emitAdmin, emitChange } from '../lib/realtime.js';
import { admProduct, pubProductCard } from '../lib/serialize.js';
import { soldOf } from './sales.js';

/**
 * Sistem Code (Order Code Redeem). Database = sumber kebenaran.
 *
 * Keamanan data:
 *  - Code mentah hanya keluar lewat (a) API Admin yang dilindungi requireAdmin, dan (b) tampilan order pelanggan
 *    yang sudah lolos verifikasi token order (lihat redeemViewFor). Tidak ada API publik yang membaca RedeemCode.
 *  - Code tidak pernah ditulis ke log server maupun ke order.events.
 *
 * Atomicity (tanpa transaksi multi-dokumen, jadi tetap jalan di MongoDB standalone):
 *  - Mengambil code = SATU findOneAndUpdate {status:'available'} -> 'sold'. Dua order tidak mungkin mendapat code yang sama.
 *  - Index unik parsial pada RedeemCode.order: satu order tidak mungkin memegang dua code, walau webhook, polling,
 *    refresh, dan reconnect memanggil assignCode bersamaan (yang kalah mendapat E11000 dan membaca code yang sudah ada).
 *  - Status hanya bergerak maju (available -> sold -> redeemed); filter status pada setiap update menjaganya.
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);
const evt = (type, detail = '') => ({ $each: [{ at: new Date(), type, detail: String(detail).slice(0, 300) }], $slice: -30 });

/* ------------------------------------------------------------------ bentuk data */

/** Untuk Admin. Code `available` disamarkan di daftar; isi utuh lewat endpoint reveal. */
export function admCode(c, { reveal = false } = {}) {
  const hidden = c.status === 'available' && !reveal;
  return {
    id: String(c._id),
    productId: c.productId,
    productName: c.product?.name ?? null,
    code: hidden ? maskCode(c.code) : c.code,
    masked: hidden,
    status: c.status,
    orderNo: c.orderNo || '',
    customer: { name: c.customer?.name || '', email: c.customer?.email || '', whatsapp: c.customer?.whatsapp || '' },
    assignedAt: iso(c.assignedAt),
    redeemedAt: iso(c.redeemedAt),
    redeemSource: c.redeemSource || '',
    createdAt: iso(c.createdAt),
  };
}

/** Tampilan untuk PEMILIK order saja (dipanggil dari pubOrder setelah token diverifikasi). */
export async function redeemViewFor(o) {
  if (o.product?.kind !== 'code') return null;
  if (o.status !== 'SUCCESS') return { enabled: true, state: 'locked' };   // code tidak pernah ada sebelum pembayaran SUCCESS
  const [code, prod] = await Promise.all([
    RedeemCode.findOne({ order: o._id }).lean(),
    o.product.ref ? Product.findById(o.product.ref).select('redeemTutorial').lean() : null,
  ]);
  const tutorial = tutorialSteps(prod?.redeemTutorial);
  if (!code) return { enabled: true, state: 'waiting', tutorial };
  return { enabled: true, state: 'assigned', code: code.code, status: code.status, assignedAt: iso(code.assignedAt), redeemedAt: iso(code.redeemedAt), tutorial };
}

/** Untuk notifikasi (WhatsApp/Email): code milik order ini, atau '' bila belum ada. */
export async function codeOfOrder(orderId) {
  if (!orderId) return '';
  const c = await RedeemCode.findOne({ order: orderId }).select('code').lean();
  return c?.code || '';
}

/* ------------------------------------------------------------------ statistik & realtime */

export async function codeStats() {
  const [rows, waitingRows, products] = await Promise.all([
    RedeemCode.aggregate([{ $group: { _id: { p: '$product', s: '$status' }, n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { 'product.kind': 'code', status: 'SUCCESS', codeState: 'waiting' } }, { $group: { _id: '$product.ref', n: { $sum: 1 } } }]),
    Product.find({ kind: 'code' }).select('productId name active price').sort({ productId: -1 }).lean(),
  ]);
  const per = new Map();
  const slot = (id) => { const k = String(id); if (!per.has(k)) per.set(k, { available: 0, sold: 0, redeemed: 0, waiting: 0 }); return per.get(k); };
  for (const r of rows) slot(r._id.p)[r._id.s] = r.n;
  for (const r of waitingRows) slot(r._id).waiting = r.n;
  const total = { available: 0, sold: 0, redeemed: 0, waiting: 0 };
  const list = products.map((p) => {
    const c = slot(p._id);
    for (const k of Object.keys(total)) total[k] += c[k];
    return { id: String(p._id), productId: p.productId, name: p.name, active: p.active, price: p.price, ...c, total: c.available + c.sold + c.redeemed };
  });
  return { total: total.available + total.sold + total.redeemed, ...total, products: list, at: new Date().toISOString() };
}

let statsTimer;
/** Siarkan ringkasan terbaru ke semua Admin Web yang terbuka (digabung agar tidak beruntun). */
export function scheduleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(async () => {
    statsTimer = undefined;
    try { emitAdmin('code:stats', await codeStats()); } catch (err) { console.error('[code] gagal menyiarkan statistik:', err.message); }
  }, 250);
  statsTimer.unref?.();
}

async function broadcastCode(codeDoc) {
  try {
    const c = codeDoc.product?.name !== undefined ? codeDoc : await RedeemCode.findById(codeDoc._id).populate('product', 'name');
    if (c) emitAdmin('code:update', admCode(c, { reveal: true }));   // namespace admin: wajib login (cookie sesi dicek saat handshake)
  } catch (err) { console.error('[code] gagal menyiarkan code:', err.message); }
  scheduleStats();
}

/** Stok di Marketplace (event publik product:update) + tabel Produk di Admin. */
export async function broadcastProduct(ref) {
  try {
    const p = await Product.findById(ref).populate('category');
    if (!p) return;
    const sold = await soldOf(p._id);
    emitChange('product', {
      before: p, after: p, visible: (x) => x.active && x.category?.active !== false,
      adm: (x) => admProduct(x, undefined, sold), pub: (x) => pubProductCard(x, x.category?.name, sold),
      id: (x) => x.productId, admDel: (x) => ({ id: String(x._id), productId: x.productId }), pubDel: (x) => ({ id: x.productId }),
    });
  } catch (err) { console.error('[code] gagal menyiarkan produk:', err.message); }
}

/** Stok produk code = jumlah code available. Dihitung ulang dari database; diulang bila ada perubahan di tengah jalan. */
export async function syncProductStock(ref) {
  let n = 0;
  for (let i = 0; i < 3; i += 1) {
    n = await RedeemCode.countDocuments({ product: ref, status: 'available' });
    await Product.updateOne({ _id: ref }, { $set: { stock: n } });
    if ((await RedeemCode.countDocuments({ product: ref, status: 'available' })) === n) break;
  }
  return n;
}

/* ------------------------------------------------------------------ stok code (Admin) */

/**
 * Menambah code ke produk. Duplikat (global, tanpa peduli huruf besar/kecil) TIDAK disimpan.
 * Baris tidak valid menolak seluruh permintaan supaya Admin memperbaikinya (tidak ada yang tersimpan setengah-setengah).
 */
export function validateCodeInput(text) {
  const parsed = parseCodeLines(text);
  if (parsed.invalid.length) {
    const first = parsed.invalid.slice(0, 5).map((x) => `baris ${x.line} (${x.reason})`).join(', ');
    throw new HttpError(422, 'Ada code yang tidak valid.', { fields: { codes: `${parsed.invalid.length} baris tidak valid: ${first}${parsed.invalid.length > 5 ? ', …' : ''}` } });
  }
  if (!parsed.codes.length) throw new HttpError(422, 'Masukkan minimal satu code.', { fields: { codes: 'Masukkan minimal satu code (satu code per baris)' } });
  if (parsed.tooMany) throw new HttpError(422, 'Terlalu banyak code sekaligus.', { fields: { codes: `Maksimal ${MAX_CODES_PER_SUBMIT} code per simpan (sekarang ${parsed.codes.length}). Bagi menjadi beberapa kali simpan.` } });
  return parsed;
}

export async function addCodes(product, text) {
  const parsed = validateCodeInput(text);

  const startedAt = new Date();
  const dupes = [];
  let added = 0;
  const CHUNK = 500;
  for (let off = 0; off < parsed.codes.length; off += CHUNK) {
    const part = parsed.codes.slice(off, off + CHUNK);
    // upsert + $setOnInsert: code yang sudah ada TIDAK ditimpa dan tidak menimbulkan error; hanya yang benar-benar baru yang masuk
    const ops = part.map((c) => ({
      updateOne: {
        filter: { codeKey: c.codeKey },
        update: { $setOnInsert: { product: product._id, productId: product.productId, code: c.code, status: 'available', order: null, orderNo: '', customer: { name: '', email: '', whatsapp: '' }, assignedAt: null, redeemedAt: null, redeemSource: '' } },
        upsert: true,
      },
    }));
    try {
      const res = await RedeemCode.bulkWrite(ops, { ordered: false });
      const ids = res.upsertedIds || {};
      part.forEach((c, i) => { if (!(i in ids)) dupes.push(c.code); });
      added += res.upsertedCount ?? Object.keys(ids).length;
    } catch (err) {
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
      // Balapan dua simpan bersamaan pada code yang sama: hitung ulang dari database apa adanya
      const mine = new Set((await RedeemCode.find({ codeKey: { $in: part.map((c) => c.codeKey) }, product: product._id, createdAt: { $gte: startedAt } }).select('codeKey').lean()).map((x) => x.codeKey));
      part.forEach((c) => { if (mine.has(c.codeKey)) added += 1; else dupes.push(c.code); });
    }
  }
  const stock = await syncProductStock(product._id);
  scheduleStats();
  emitAdmin('code:refresh', { productId: product.productId });
  return { added, duplicates: dupes.length, duplicateSample: dupes.slice(0, 10), duplicatesInInput: parsed.duplicatesInInput.length, stock };
}

/** Jumlah per status untuk satu produk (form Ubah produk code). */
export async function productCounts(ref) {
  const [available, sold, redeemed, waiting] = await Promise.all([
    RedeemCode.countDocuments({ product: ref, status: 'available' }),
    RedeemCode.countDocuments({ product: ref, status: 'sold' }),
    RedeemCode.countDocuments({ product: ref, status: 'redeemed' }),
    Order.countDocuments({ 'product.ref': ref, status: 'SUCCESS', codeState: 'waiting' }),
  ]);
  return { available, sold, redeemed, waiting, total: available + sold + redeemed };
}

/* ------------------------------------------------------------------ pemberian code ke order */

/**
 * Memberi 1 code ke order yang SUDAH SUCCESS. Idempoten: dipanggil berapa kali pun (webhook ganda, refresh, reconnect,
 * pemulihan worker) satu order tetap memegang tepat satu code.
 * @returns {{ state: 'skip'|'assigned'|'waiting', code?: object, changed: boolean }} changed = dokumen order berubah (perlu disiarkan)
 */
export async function assignCode(order) {
  if (order?.product?.kind !== 'code' || order.status !== 'SUCCESS') return { state: 'skip', changed: false };

  let code = await RedeemCode.findOne({ order: order._id });
  let fresh = false;
  if (!code) {
    try {
      code = await RedeemCode.findOneAndUpdate(
        { product: order.product.ref, status: 'available' },
        { $set: { status: 'sold', order: order._id, orderNo: order.orderNo, customer: { name: order.customer.name, email: order.customer.email, whatsapp: order.customer.whatsapp }, assignedAt: new Date() } },
        { sort: { _id: 1 }, new: true },
      );
      fresh = Boolean(code);
    } catch (err) {
      if (err?.code !== 11000) throw err;
      code = await RedeemCode.findOne({ order: order._id });   // proses lain sudah memberi code untuk order ini
    }
  }

  if (!code) {   // sudah dibayar tapi stok code habis: ditandai menunggu, diberikan otomatis saat stok ditambah
    const r = await Order.updateOne(
      { _id: order._id, codeState: { $nin: ['assigned', 'waiting'] } },
      { $set: { codeState: 'waiting', stockNote: 'short' }, $inc: { rev: 1 }, $push: { events: evt('code_waiting', 'dibayar saat stok code habis') } },
    );
    if (r.modifiedCount) scheduleStats();
    return { state: 'waiting', changed: r.modifiedCount === 1 };
  }

  const r = await Order.updateOne(
    { _id: order._id, codeState: { $ne: 'assigned' } },
    { $set: { codeState: 'assigned', stockNote: '' }, $inc: { rev: 1 }, $push: { events: evt('code_assigned', `produk #${order.product.productId}`) } },   // code TIDAK dicatat di events
  );
  if (fresh) {
    await syncProductStock(order.product.ref);
    await broadcastCode(await RedeemCode.findById(code._id).populate('product', 'name'));
  }
  return { state: 'assigned', code, changed: r.modifiedCount === 1 || fresh };
}

/** Order SUCCESS produk code yang masih menunggu code, urut paling lama (FIFO). */
export const waitingOrders = (productRef, limit = 100) =>
  Order.find({ 'product.ref': productRef, 'product.kind': 'code', status: 'SUCCESS', codeState: 'waiting' }).sort({ createdAt: 1 }).limit(limit);

/* ------------------------------------------------------------------ redeem */

/**
 * sold -> redeemed secara atomic. Code yang sudah redeemed tidak bisa dipakai lagi; code available (belum dijual) ditolak.
 * @param {{ id?: string, code?: string }} by
 * @param {'admin'|'api'} source
 */
export async function markRedeemed(by, source) {
  const filter = by.id ? { _id: by.id } : { codeKey: codeKeyOf(by.code) };
  const doc = await RedeemCode.findOneAndUpdate(
    { ...filter, status: 'sold' },
    { $set: { status: 'redeemed', redeemedAt: new Date(), redeemSource: source } },
    { new: true },
  ).populate('product', 'name');
  if (doc) { await broadcastCode(doc); return doc; }
  const cur = await RedeemCode.findOne(filter).select('status');
  if (!cur) throw new HttpError(404, 'Code tidak ditemukan.');
  if (cur.status === 'redeemed') throw new HttpError(409, 'Code ini sudah digunakan.');
  throw new HttpError(409, 'Code ini belum terjual, jadi belum bisa ditandai sebagai digunakan.');
}

/* ------------------------------------------------------------------ laporan (Admin) */

const rxStart = (s) => new RegExp(`^${escapeRegex(s)}`, 'i');
const wibDay = (ymd, endOfDay = false) => {
  const d = new Date(`${ymd}T00:00:00+07:00`);
  if (Number.isNaN(d.getTime())) return null;
  return endOfDay ? new Date(d.getTime() + 86_400_000) : d;
};

export function buildCodeFilter(q) {
  const f = {};
  if (q.productId) f.productId = q.productId;
  if (q.status) f.status = q.status === 'delivered' ? { $in: ['sold', 'redeemed'] } : q.status;
  if (q.order) f.orderNo = rxStart(q.order);
  if (q.email) f['customer.email'] = rxStart(q.email);
  if (q.customer) f['customer.name'] = new RegExp(escapeRegex(q.customer), 'i');
  if (q.code) f.codeKey = new RegExp(escapeRegex(codeKeyOf(q.code)));
  const from = q.from && wibDay(q.from);
  const to = q.to && wibDay(q.to, true);
  if (from || to) f.assignedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };   // tanggal code DIBERIKAN
  return f;
}

export async function listCodes(q) {
  const filter = buildCodeFilter(q);
  const sort = q.sort === 'oldest' ? { updatedAt: 1, _id: 1 } : { updatedAt: -1, _id: -1 };
  const [total, docs] = await Promise.all([
    RedeemCode.countDocuments(filter),
    RedeemCode.find(filter).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).populate('product', 'name'),
  ]);
  return { total, items: docs.map((d) => admCode(d)) };
}

export async function revealCode(id) {
  const c = await RedeemCode.findById(id).populate('product', 'name');
  if (!c) throw new HttpError(404, 'Code tidak ditemukan.');
  return admCode(c, { reveal: true });
}

/** Menghapus produk code: ditolak bila sudah ada code terjual/digunakan (riwayat penjualan tidak boleh hilang). */
export async function releaseProductCodes(product) {
  const used = await RedeemCode.countDocuments({ product: product._id, status: { $ne: 'available' } });
  if (used) throw new HttpError(409, `Produk ini sudah punya ${used} code terjual/digunakan, jadi tidak bisa dihapus. Nonaktifkan saja agar tidak tampil di Marketplace.`);
  const waiting = await Order.countDocuments({ 'product.ref': product._id, codeState: 'waiting', status: 'SUCCESS' });
  if (waiting) throw new HttpError(409, `Ada ${waiting} pesanan yang sudah dibayar dan menunggu code untuk produk ini. Tambah stok code dulu agar pesanan terpenuhi.`);
}
export async function deleteProductCodes(product) {
  await RedeemCode.deleteMany({ product: product._id, status: 'available' });
  scheduleStats();
  emitAdmin('code:refresh', { productId: product.productId });
}
