import { Order } from '../models/index.js';
import { emitPublic, emitAdmin } from '../lib/realtime.js';

/**
 * Statistik beranda yang dihitung langsung dari koleksi `orders` (MongoDB), bukan angka yang diketik manual.
 *  - orders    : jumlah pesanan yang sudah dibayar (status SUCCESS)
 *  - customers : jumlah pelanggan unik (email) dari pesanan yang sudah dibayar
 */
export async function liveStats() {
  const [orders, grouped] = await Promise.all([
    Order.countDocuments({ status: 'SUCCESS' }),
    Order.aggregate([
      { $match: { status: 'SUCCESS' } },
      { $group: { _id: '$customer.email' } },
      { $count: 'n' },
    ]),
  ]);
  return { customers: grouped[0]?.n ?? 0, orders };
}

/** Gabungkan angka hidup ke pengaturan stats (sisanya, mis. `support`, tetap dari pengaturan admin). */
export async function withLiveStats(stats = {}) {
  return { ...stats, ...(await liveStats()) };
}

/** Umumkan statistik terbaru ke Marketplace + Admin (dipanggil setelah pembayaran berhasil). */
export async function broadcastStats(base = {}) {
  try {
    const value = await withLiveStats(base);
    emitPublic('settings:update', { key: 'stats', value });
    emitAdmin('settings:update', { key: 'stats', value });
  } catch (err) {
    console.error('[stats] gagal menyiarkan statistik:', err.message);
  }
}
