import { Product } from '../models/index.js';

/**
 * Urutan produk di Marketplace = SATU field: Product.order (angka kecil tampil lebih dulu).
 * Urutan berlaku PER KATEGORI karena Marketplace menampilkan produk dikelompokkan per kategori;
 * produk beda kategori tidak saling memengaruhi.
 *
 * Aturan:
 *  - Produk baru  : ditaruh PALING ATAS (order = order terkecil - 1), sama seperti perilaku lama "Terbaru dulu".
 *                   Posisi produk lain tidak berubah (hanya satu nilai baru yang dibuat).
 *  - Produk dihapus: tidak ada yang perlu digeser; urutan relatif produk lain tetap, celah angka tidak masalah.
 *  - Pindah posisi : tukar nilai `order` di antara produk sekategori saja (tidak menyentuh kategori lain).
 *  - Seri (order sama / null) selalu dipecah dengan productId terbaru dulu, lalu _id, jadi hasilnya selalu pasti.
 */
export const ORDER_SORT = { order: 1, productId: -1, _id: 1 };   // null/kosong terurut paling awal di MongoDB

/** Nilai order untuk produk baru: satu di atas produk paling atas saat ini. */
export async function nextTopOrder() {
  const top = await Product.findOne({ order: { $ne: null } }).sort({ order: 1 }).select('order').lean();
  return top ? top.order - 1 : 0;
}

/** Beri nomor urut 0..n-1 pada SEMUA produk sesuai urutan efektif saat ini (null di atas, seri dipecah ORDER_SORT). Tidak mengubah updatedAt. */
export async function normalizeProductOrder() {
  const docs = await Product.find().sort(ORDER_SORT).select('_id order').lean();
  const ops = [];
  docs.forEach((d, i) => { if (d.order !== i) ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { order: i } } } }); });
  if (ops.length) await Product.collection.bulkWrite(ops, { ordered: false });   // koleksi langsung: tidak menyentuh updatedAt
  return ops.length;
}

/** Pastikan tidak ada produk tanpa order (data lama sebelum fitur ini). Aman dipanggil berulang. */
export async function ensureProductOrder() {
  const missing = await Product.countDocuments({ order: null });
  if (!missing) return 0;
  const withOrder = await Product.countDocuments({ order: { $ne: null } });
  if (!withOrder) return normalizeProductOrder();   // semua kosong: urutan = produk terbaru dulu (sama dengan tampilan sebelumnya)
  // Sebagian sudah punya order: yang kosong ditaruh di atas (terbaru paling atas) tanpa menggeser yang sudah ada.
  const [top, blanks] = await Promise.all([
    Product.findOne({ order: { $ne: null } }).sort({ order: 1 }).select('order').lean(),
    Product.find({ order: null }).sort({ productId: -1, _id: 1 }).select('_id').lean(),
  ]);
  const base = top.order - blanks.length;
  await Product.collection.bulkWrite(blanks.map((d, i) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { order: base + i } } } })), { ordered: false });
  return blanks.length;
}

/**
 * Pindahkan satu produk di dalam kategorinya. to: 'up' | 'down' | 'top' | 'bottom'.
 * Hasil: daftar { _id, productId, order } yang nilainya berubah (kosong bila sudah di ujung).
 */
export async function moveProduct(doc, to) {
  await ensureProductOrder();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const list = await Product.find({ category: doc.category }).sort(ORDER_SORT).select('_id productId order').lean();
    const slots = list.map((d) => d.order);
    if (new Set(slots).size !== slots.length) { await normalizeProductOrder(); continue; }   // seri (mis. dua admin menambah bersamaan): rapikan lalu ulangi

    const from = list.findIndex((d) => String(d._id) === String(doc._id));
    if (from < 0) return [];
    const target = to === 'up' ? from - 1 : to === 'down' ? from + 1 : to === 'top' ? 0 : list.length - 1;
    if (target < 0 || target >= list.length || target === from) return [];

    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    // Nilai order yang sudah dipakai kategori ini dipakai ulang berurutan: kategori lain & posisi relatifnya tidak tersentuh
    const sorted = [...slots].sort((a, b) => a - b);
    const changed = [];
    next.forEach((d, i) => { if (d.order !== sorted[i]) changed.push({ _id: d._id, productId: d.productId, order: sorted[i] }); });
    if (changed.length) await Product.collection.bulkWrite(changed.map((c) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { order: c.order } } } })), { ordered: true });
    return changed;
  }
  return [];
}

/** Posisi (1..total) tiap produk di dalam kategorinya, untuk daftar Admin. Satu query untuk semua kategori yang terlibat. */
export async function positionsFor(docs) {
  const catIds = [...new Set(docs.map((d) => String(d.category?._id || d.category)))];
  if (!catIds.length) return new Map();
  const all = await Product.find({ category: { $in: catIds } }).sort(ORDER_SORT).select('_id category').lean();
  const seen = new Map();
  const total = new Map();
  all.forEach((d) => total.set(String(d.category), (total.get(String(d.category)) || 0) + 1));
  const out = new Map();
  for (const d of all) {
    const c = String(d.category);
    const n = (seen.get(c) || 0) + 1;
    seen.set(c, n);
    out.set(String(d._id), { index: n, total: total.get(c) });
  }
  return out;
}
