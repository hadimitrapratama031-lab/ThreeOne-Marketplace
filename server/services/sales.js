import mongoose from 'mongoose';
import { Order, Product } from '../models/index.js';

/**
 * Satu-satunya definisi "Terjual" untuk Marketplace dan Admin:
 *   jumlah order berstatus SUCCESS (dibayar) yang product.ref-nya menunjuk produk tersebut.
 * PENDING, EXPIRED dan FAILED tidak dihitung. Order yang dibayar setelah sempat EXPIRED menjadi SUCCESS
 * lewat alur pembayaran yang sama (latePayment), jadi ikut terhitung karena dananya memang sudah masuk.
 *
 * Dihitung dari koleksi Order, bukan dari field Product.sold (counter lama yang bisa diisi manual/seed).
 * Satu tambahan: Product.soldAdjust (default 0) hanya terisi oleh script migrasi dari project lama, supaya angka terjual lama
 * tetap tampil walau jumlah pesanan yang diimpor berbeda (mis. pesanan lama dengan quantity > 1). Hasil tidak pernah di bawah 0.
 */
export const SOLD_STATUS = 'SUCCESS';

/** @param {Iterable<any>} refs _id produk (ObjectId atau string). @returns {Promise<Map<string, number>>} key = String(_id), nilai 0 bila belum ada penjualan */
export async function soldByProduct(refs) {
  const ids = [...new Set([...refs].filter(Boolean).map(String))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));   // aggregate tidak melakukan cast otomatis
  const out = new Map(ids.map((id) => [String(id), 0]));
  if (!ids.length) return out;
  const [rows, adjusted] = await Promise.all([
    Order.aggregate([
      { $match: { status: SOLD_STATUS, 'product.ref': { $in: ids } } },
      { $group: { _id: '$product.ref', n: { $sum: 1 } } },
    ]),
    Product.find({ _id: { $in: ids }, soldAdjust: { $exists: true, $ne: 0 } }).select('soldAdjust').lean(),
  ]);
  for (const row of rows) out.set(String(row._id), row.n);
  for (const p of adjusted) out.set(String(p._id), Math.max(0, (out.get(String(p._id)) ?? 0) + (Number(p.soldAdjust) || 0)));
  return out;
}

export async function soldOf(ref) {
  return (await soldByProduct([ref])).get(String(ref)) ?? 0;
}
