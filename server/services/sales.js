import mongoose from 'mongoose';
import { Order } from '../models/index.js';

/**
 * Satu-satunya definisi "Terjual" untuk Marketplace dan Admin:
 *   jumlah order berstatus SUCCESS (dibayar) yang product.ref-nya menunjuk produk tersebut.
 * PENDING, EXPIRED dan FAILED tidak dihitung. Order yang dibayar setelah sempat EXPIRED menjadi SUCCESS
 * lewat alur pembayaran yang sama (latePayment), jadi ikut terhitung karena dananya memang sudah masuk.
 *
 * Dihitung dari koleksi Order, bukan dari field Product.sold (counter lama yang bisa diisi manual/seed).
 */
export const SOLD_STATUS = 'SUCCESS';

/** @param {Iterable<any>} refs _id produk (ObjectId atau string). @returns {Promise<Map<string, number>>} key = String(_id), nilai 0 bila belum ada penjualan */
export async function soldByProduct(refs) {
  const ids = [...new Set([...refs].filter(Boolean).map(String))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));   // aggregate tidak melakukan cast otomatis
  const out = new Map(ids.map((id) => [String(id), 0]));
  if (!ids.length) return out;
  const rows = await Order.aggregate([
    { $match: { status: SOLD_STATUS, 'product.ref': { $in: ids } } },
    { $group: { _id: '$product.ref', n: { $sum: 1 } } },
  ]);
  for (const row of rows) out.set(String(row._id), row.n);
  return out;
}

export async function soldOf(ref) {
  return (await soldByProduct([ref])).get(String(ref)) ?? 0;
}
