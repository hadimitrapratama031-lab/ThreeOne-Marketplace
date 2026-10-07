import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Product, Category, Review, Faq, Contact } from '../models/index.js';
import { asyncH, parse, HttpError, pageMeta } from '../lib/http.js';
import { pubCategory, pubProductCard, pubProductDetail, pubFaq, pubContact, pubReview } from '../lib/serialize.js';
import { publicReviewInput, publicReviewListQuery } from '../lib/schemas.js';
import { config, r2Configured } from '../config/env.js';
import { getAllSettings, publicSetting, SETTING_KEYS } from '../services/settings.js';
import { recordImageError } from '../services/imageErrors.js';
import { withLiveStats, withLiveProductPage, liveStats } from '../services/stats.js';
import { memo, invalidate } from '../lib/memo.js';
import { onPublicEmit } from '../lib/realtime.js';
import { summarize, listPublic, createFromCustomer } from '../services/reviews.js';
import { soldByProduct, soldOf } from '../services/sales.js';
import { ORDER_SORT } from '../services/productOrder.js';
import { listRecentSales } from '../services/salesFeed.js';
import { publicLimiter, telemetryLimiter, reviewSubmitLimiter, originGuard } from '../middleware/security.js';

const r = Router();
r.use(publicLimiter);
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // data harus selalu terbaru

const MAX_PRODUCTS = 1000;

// Cache memori singkat (lib/memo.js). Setiap event publik Socket.IO membuangnya, jadi realtime tetap segar;
// TTL hanya pengaman untuk perubahan yang tidak lewat event.
onPublicEmit(invalidate);
const TTL_MS = 3000;

/** Kirim hasil memo dengan ETag: klien yang datanya belum berubah cukup menerima 304 (tanpa body). */
function sendMemo(res, entry) {
  res.set('Cache-Control', 'no-cache');   // boleh disimpan, tapi SELALU divalidasi ulang ke server
  res.set('ETag', entry.etag);
  res.json(entry.value);
}

async function visibleProducts() {
  const cats = await Category.find({ active: true }).sort({ order: 1, _id: 1 }).lean();
  const names = new Map(cats.map((c) => [String(c._id), c.name]));
  const products = await Product.find({ active: true, category: { $in: cats.map((c) => c._id) } }).sort(ORDER_SORT).limit(MAX_PRODUCTS).lean();
  const sold = await soldByProduct(products.map((p) => p._id));   // satu agregasi untuk seluruh grid
  return { cats, products: products.map((p) => pubProductCard(p, names.get(String(p.category)), sold.get(String(p._id)) ?? 0)) };
}

async function buildBootstrap() {
  // Semua pembacaan berjalan paralel; statistik hidup dihitung SATU kali (sebelumnya dua kali, berurutan)
  const [{ cats, products }, settings, faqs, contacts, live] = await Promise.all([
    visibleProducts(),
    getAllSettings(),
    Faq.find({ active: true }).sort({ order: 1, _id: 1 }).lean(),
    Contact.find({ active: true }).sort({ order: 1, _id: 1 }).lean(),
    liveStats(),
  ]);
  const pub = {};
  for (const k of SETTING_KEYS) pub[k] = publicSetting(k, settings[k]);
  pub.productPage = await withLiveProductPage(pub.productPage, live);
  pub.stats = await withLiveStats(pub.stats, live);   // pelanggan & pesanan dihitung dari database order
  return {
    settings: pub,
    categories: cats.map(pubCategory),
    products,
    faq: faqs.map(pubFaq),
    contacts: contacts.map(pubContact),
  };
}

/** Satu permintaan untuk memuat seluruh Marketplace; dipakai juga untuk sinkron ulang setelah reconnect. */
r.get('/bootstrap', asyncH(async (_req, res) => {
  const entry = await memo('bootstrap', TTL_MS, buildBootstrap);
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', entry.etag);
  res.json({ ...entry.value, serverTime: new Date().toISOString() });
}));

/** Floating Order Notification: order SUCCESS terbaru -> terlama (semua, sampai FEED_LIMIT), sudah ber-masking di sini (email utuh tidak pernah keluar dari server).
 *  Dipakai saat Marketplace dibuka dan untuk sinkron ulang setelah reconnect; order baru datang lewat Socket.IO `sale:create`. */
r.get('/recent-orders', asyncH(async (_req, res) => {
  const { value } = await memo('recent-orders', TTL_MS, () => listRecentSales());   // data sama dipakai bersama semua pengunjung
  res.json({ items: value, serverTime: new Date().toISOString() });
}));

// Ringkasan rating Product Detail memakai perhitungan yang sama dengan halaman Rating
const reviewSummary = (productId) => summarize({ productId, status: 'published' });

const pidParam = z.coerce.number().int().min(1).max(1_000_000_000);

async function findVisible(rawId) {
  const pid = pidParam.safeParse(rawId);
  if (!pid.success) throw new HttpError(404, 'Produk tidak ditemukan.');
  const p = await Product.findOne({ productId: pid.data, active: true }).populate('category').lean();
  if (!p || p.category?.active === false) throw new HttpError(404, 'Produk tidak ditemukan.');
  return p;
}

/* ---------- Rating & ulasan (halaman Rating) ---------- */

// Semua ulasan dari semua produk yang tampil, plus ringkasan rating
r.get('/reviews', asyncH(async (req, res) => {
  const q = parse(publicReviewListQuery, req.query);
  const { docs, total, summary, visible } = await listPublic(q);
  res.json({ items: docs.map((d) => pubReview(d, visible.get(d.productId))), summary, ...pageMeta(q.page, q.limit, total) });
}));

// Kirim ulasan (multipart: productId (opsional), name, stars, text, images[]). Langsung tampil, tanpa persetujuan.
const reviewUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.imageBytes, files: 3, fields: 8, parts: 12 },
}).array('images', 3);

function receiveReview(req, res, next) {
  reviewUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Ukuran foto terlalu besar (maksimal ${Math.round(config.limits.imageBytes / 1048576)} MB per foto).`
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Maksimal 3 foto per ulasan.' : 'Data ulasan tidak valid.';
      return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 422, msg, { fields: { images: msg } }));
    }
    next(err);
  });
}

r.post('/reviews', originGuard, reviewSubmitLimiter, receiveReview, asyncH(async (req, res) => {
  if (String(req.body?.website || '').trim()) throw new HttpError(422, 'Data tidak valid');   // kolom jebakan bot: manusia tidak melihatnya
  const files = req.files || [];
  if (files.length && !r2Configured()) throw new HttpError(503, 'Penyimpanan foto belum tersedia. Kirim ulasan tanpa foto atau coba lagi nanti.');
  const data = parse(publicReviewInput, req.body);
  const { saved, product } = await createFromCustomer({ ...data, files });
  res.status(201).json({ item: pubReview(saved, product) });
}));

const reviewQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(20).default(3) });

async function reviewPageOf(p, page, limit) {
  const filter = { product: p._id, status: 'published' };
  const [total, docs] = await Promise.all([
    Review.countDocuments(filter),
    Review.find(filter).sort({ date: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return { items: docs.map(pubReview), ...pageMeta(page, limit, total) };
}

/** Detail produk. `?reviews=1[&limit=n]` ikut membawa halaman ulasan pertama, jadi halaman Detail cukup SATU request
 *  (sebelumnya: detail -> baru ulasan, berurutan, dan findVisible dijalankan dua kali). Tanpa parameter: respons lama. */
r.get('/products/:id', asyncH(async (req, res) => {
  const withReviews = req.query.reviews === '1';
  const limit = withReviews ? reviewQuery.parse({ limit: req.query.limit }).limit : 0;
  const entry = await memo(`pd:${req.params.id}:${limit}`, TTL_MS, async () => {
    const p = await findVisible(req.params.id);
    const [sold, reviews, reviewPage] = await Promise.all([
      soldOf(p._id),
      reviewSummary(p.productId),
      withReviews ? reviewPageOf(p, 1, limit) : null,
    ]);
    return { product: pubProductDetail(p, p.category?.name, sold), reviews, ...(reviewPage ? { reviewPage } : {}) };
  });
  sendMemo(res, entry);
}));

r.get('/products/:id/reviews', asyncH(async (req, res) => {
  const p = await findVisible(req.params.id);
  const { page, limit } = reviewQuery.parse(req.query);
  res.json(await reviewPageOf(p, page, limit));
}));

// Marketplace melaporkan gambar yang gagal dimuat -> log server + notifikasi admin
r.post('/image-error', telemetryLimiter, (req, res) => {
  recordImageError(req.body?.url, req.body?.page);
  res.status(204).end();
});

export default r;
