import crypto from 'node:crypto';
import { Order } from '../models/index.js';
import { config } from '../config/env.js';
import { publicUrl } from '../lib/r2.js';
import { emitPublic } from '../lib/realtime.js';

/**
 * Floating Order Notification (social proof di Marketplace).
 *
 * Sumber data = koleksi Order yang sudah ada. Yang dianggap valid hanya status SUCCESS, definisi yang sama dengan
 * "Terjual" (services/sales.js). PENDING / EXPIRED / FAILED tidak pernah keluar dari sini.
 *
 * Data yang boleh publik (dan hanya ini): ID opaque, nama depan, email ber-masking, nama produk, gambar produk, waktu bayar.
 * Tidak ada orderNo (orderNo membuka Cek Pesanan, termasuk code redeem), WhatsApp, nominal, token, atau data gateway.
 */
/** Semua order SUCCESS ikut tampil. Batas ini hanya pengaman agar respons tidak tak terbatas besarnya (500 order ≈ 100 KB). Naikkan bila perlu. */
export const FEED_LIMIT = 500;

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** ID publik stabil & tidak bisa ditebak/dibalik. Dipakai klien sebagai kunci unik (dedup); BUKAN orderNo. */
export const saleId = (order) =>
  crypto.createHmac('sha256', config.appSecret).update(`sale:${order._id}`).digest('base64url').slice(0, 22);

/** Nama depan saja, maksimal 20 karakter. Huruf pertama dibesarkan hanya bila diketik huruf kecil semua. */
export function feedName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const chars = [...first].slice(0, 20);
  if (!chars.length) return 'Pelanggan';
  const word = chars.join('');
  return word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/**
 * rizky123@gmail.com -> rizk*****@gmail.com
 * Selalu ada bagian yang disembunyikan (minimal 3 bintang), jadi email pendek pun tidak tampil utuh.
 * Jumlah bintang dibatasi 3-8 supaya panjang email asli tidak bocor dan tampilan tetap rapi.
 * Bila bentuknya bukan email yang valid, hasilnya '' (tidak ditampilkan sama sekali).
 */
export function maskFeedEmail(email) {
  const s = String(email || '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return '';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return '';
  const chars = [...local];
  const keep = Math.min(4, Math.floor(chars.length / 2));   // 1 huruf -> 0, 2-3 -> 1, 4-5 -> 2, 6-7 -> 3, 8+ -> 4
  const stars = Math.max(3, Math.min(chars.length - keep, 8));
  return `${chars.slice(0, keep).join('')}${'*'.repeat(stars)}@${domain}`;
}

/** Bentuk publik satu order. Menerima dokumen Order (lean atau bukan). */
export function pubSale(o) {
  return {
    id: saleId(o),
    name: feedName(o.customer?.name),
    email: maskFeedEmail(o.customer?.email),
    product: String(o.product?.name || '').slice(0, 120),
    imageUrl: o.product?.imageKey ? publicUrl(o.product.imageKey) : null,
    at: iso(o.payment?.paidAt || o.createdAt),
  };
}

/** Order SUCCESS terbaru -> terlama (berdasarkan waktu bayar), sampai FEED_LIMIT. Hanya field yang dibutuhkan yang dibaca dari database. */
export async function listRecentSales(limit = FEED_LIMIT) {
  const rows = await Order.find({ status: 'SUCCESS' })
    .sort({ 'payment.paidAt': -1, createdAt: -1, _id: -1 })
    .limit(Math.max(1, Math.min(limit, FEED_LIMIT)))
    .select('customer.name customer.email product.name product.imageKey payment.paidAt createdAt')
    .lean();
  return rows.map(pubSale);
}

/**
 * Siarkan order yang baru saja SUCCESS ke Marketplace lewat Socket.IO yang sudah ada (event publik `sale:create`).
 * Dipanggil hanya oleh pemenang transisi PENDING/EXPIRED -> SUCCESS di markPaid, jadi webhook ganda tidak menyiarkan ulang.
 * Klien tetap dedup lewat `id`, sehingga aman terhadap reconnect / event ganda.
 * Kegagalan di sini tidak boleh memengaruhi alur pembayaran.
 */
export function publishSale(order) {
  try {
    emitPublic('sale:create', pubSale(order));
  } catch (err) {
    console.error(`[sales-feed] gagal menyiarkan order ${order?.orderNo}: ${err.message}`);
  }
}

/**
 * Order SUCCESS dihapus Admin -> tarik dari Floating Order Notification di Marketplace (event publik `sale:delete`).
 * Hanya membawa ID opaque yang sama dengan `sale:create`; orderNo tidak ikut keluar. Tidak boleh mengganggu alur hapus.
 */
export function unpublishSale(order) {
  try {
    emitPublic('sale:delete', { id: saleId(order) });
  } catch (err) {
    console.error(`[sales-feed] gagal menyiarkan penghapusan order ${order?.orderNo}: ${err.message}`);
  }
}
