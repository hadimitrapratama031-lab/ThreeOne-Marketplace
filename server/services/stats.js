import { Order } from '../models/index.js';
import { SOLD_STATUS } from './sales.js';
import { emitPublic, emitAdmin, setChangeHook } from '../lib/realtime.js';
import { summarize, visibleProducts } from './reviews.js';
import { getSetting } from './settings.js';

/**
 * Statistik beranda yang dihitung langsung dari database (bukan angka yang diketik manual):
 *  - orders : "Pesanan Selesai" = jumlah order berstatus SUCCESS di koleksi Order (definisi yang sama dengan "Terjual" per produk
 *             di services/sales.js, dan sama dengan daftar Pesanan di Admin Web). Bukan Product.sold (counter lama yang bisa
 *             terisi dari seed/manual/migrasi dan tidak selalu cocok dengan order nyata).
 *  - rating : rata-rata bintang dari ulasan yang tayang (0 bila belum ada), + ratingCount.
 */
export async function liveStats() {
  const [completed, visible] = await Promise.all([
    Order.countDocuments({ status: SOLD_STATUS }),
    visibleProducts(),
  ]);
  const ids = [...visible.keys()];
  const summary = await summarize({ status: 'published', productId: { $in: [...ids, null] } });   // sama dengan halaman Rating
  return { orders: completed, rating: summary.avg ?? 0, ratingCount: summary.total };
}

/** Gabungkan angka hidup ke pengaturan stats (sisanya, mis. `support`, tetap dari pengaturan admin). */
export async function withLiveStats(stats = {}, live) {
  const { customers, ...rest } = stats;   // `customers` bawaan data lama tidak dipakai lagi
  return { ...rest, ...(live ?? await liveStats()) };
}

/** "N pesanan selesai" di halaman produk = angka yang sama dengan beranda. */
export async function withLiveProductPage(pp = {}, live) {
  return { ...pp, completedOrders: (live ?? await liveStats()).orders };
}

/** Umumkan statistik terbaru ke Marketplace + Admin. */
export async function broadcastStats() {
  try {
    const [stats, page] = await Promise.all([getSetting('stats'), getSetting('productPage')]);
    const [s, p] = await Promise.all([withLiveStats(stats), withLiveProductPage(page)]);
    emitPublic('settings:update', { key: 'stats', value: s });
    emitAdmin('settings:update', { key: 'stats', value: s });
    emitPublic('settings:update', { key: 'productPage', value: p });
    emitAdmin('settings:update', { key: 'productPage', value: p });
  } catch (err) {
    console.error('[stats] gagal menyiarkan statistik:', err.message);
  }
}

// Produk (terjual berubah) atau ulasan berubah -> siarkan ulang statistik (digabung agar tidak beruntun)
let timer;
setChangeHook((entity) => {
  if (entity !== 'product' && entity !== 'review') return;
  clearTimeout(timer);
  timer = setTimeout(broadcastStats, 300);
  timer.unref?.();
});
