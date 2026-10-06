import { Review, Product, Category } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { admReview, pubReview } from '../lib/serialize.js';
import { emitChange } from '../lib/realtime.js';
import * as assets from './assets.js';

/**
 * Satu-satunya sumber logika ulasan untuk Marketplace (halaman Rating + Product Detail) dan Admin Web.
 * Ulasan disimpan di koleksi `reviews` (MongoDB); foto hanya berupa referensi {key, url} ke Cloudflare R2.
 */

export const reviewOwner = (id) => ({ type: 'review', id: String(id) });

export const SORTS = {
  newest: { date: -1 },
  oldest: { date: 1 },
  stars_desc: { stars: -1, date: -1 },
  stars_asc: { stars: 1, date: -1 },
};

/** Cara ulasan diumumkan lewat Socket.IO (dipakai bersama oleh route admin dan pengiriman dari pelanggan). */
export const reviewEvents = {
  adm: (rv) => admReview(rv),
  pub: (rv) => pubReview(rv),
  visible: (rv) => rv.status === 'published',
  id: (rv) => String(rv._id),
  admDel: (rv) => ({ id: String(rv._id), productId: rv.productId }),
  pubDel: (rv) => ({ id: String(rv._id), productId: rv.productId }),
};

/** Produk yang tampil di Marketplace (aktif + kategori aktif), sama seperti syarat Product Detail. */
export async function visibleProducts() {
  const cats = await Category.find({ active: true }).select('_id').lean();
  const products = await Product.find({ active: true, category: { $in: cats.map((c) => c._id) } })
    .select('productId name media')
    .lean();
  return new Map(products.map((p) => [p.productId, p]));
}

/** Ringkasan rating (rata-rata, jumlah, distribusi) dari ulasan yang cocok dengan `match`. */
export async function summarize(match) {
  const rows = await Review.aggregate([{ $match: match }, { $group: { _id: '$stars', n: { $sum: 1 } } }]);
  const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let total = 0;
  let sum = 0;
  for (const { _id, n } of rows) {
    if (!(_id in dist)) continue;
    dist[_id] = n;
    total += n;
    sum += n * _id;
  }
  return { avg: total ? Math.round((sum / total) * 10) / 10 : null, total, dist };
}

/** Daftar ulasan publik dari SEMUA produk yang tampil (opsional disaring per produk / bintang). */
export async function listPublic({ page, limit, productId, stars, sort }) {
  const visible = await visibleProducts();
  const ids = [...visible.keys()];
  const scope = { status: 'published', productId: { $in: [...ids, null] } };   // null = ulasan umum tanpa produk
  if (productId !== undefined) scope.productId = ids.includes(productId) ? productId : -1;

  const filter = stars ? { ...scope, stars } : scope;
  const [total, docs, summary] = await Promise.all([
    Review.countDocuments(filter),
    Review.find(filter).sort({ ...SORTS[sort], _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    summarize(scope), // ringkasan tidak ikut tersaring bintang, supaya distribusi tetap utuh
  ]);
  return { docs, total, summary, visible };
}

/**
 * Simpan ulasan baru dari pelanggan: unggah foto ke R2 -> simpan di MongoDB -> tandai foto terpakai -> umumkan realtime.
 * Ulasan langsung berstatus `published` (tanpa persetujuan admin). Bila langkah mana pun gagal, tidak ada
 * data setengah jadi: ulasan dibatalkan dan foto yang sudah terunggah dihapus dari R2.
 */
export async function createFromCustomer({ productId, name, stars, text, files }) {
  // Produk opsional: tanpa productId, ulasan disimpan sebagai ulasan umum
  let product = null;
  if (productId != null) {
    product = await Product.findOne({ productId, active: true }).populate('category').lean();
    if (!product || product.category?.active === false) {
      throw new HttpError(422, 'Produk tidak ditemukan.', { fields: { productId: 'Produk tidak tersedia' } });
    }
  }

  const uploaded = [];
  let doc;
  try {
    for (const f of files) {
      uploaded.push(await assets.uploadAsset({ buffer: f.buffer, originalName: f.originalname, folder: 'reviews' }));
    }
    const keys = uploaded.map((a) => a.key);
    doc = await Review.create({
      product: product?._id ?? null, productId: product?.productId ?? null, name, stars, text,
      date: new Date(), status: 'published', images: uploaded.map((a) => ({ key: a.key, url: a.url })),
    });
    await assets.attach(reviewOwner(doc._id), keys);
  } catch (err) {
    if (doc) await Review.deleteOne({ _id: doc._id }).catch(() => {});
    await assets.destroyAssets(uploaded).catch(() => {});
    throw err;
  }

  // Dibaca ulang agar urutan/field persis seperti di database
  const saved = await Review.findById(doc._id).lean();
  emitChange('review', { before: null, after: saved, ...reviewEvents });
  return { saved, product };
}
