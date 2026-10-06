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
import { withLiveStats, withLiveProductPage } from '../services/stats.js';
import { summarize, listPublic, createFromCustomer } from '../services/reviews.js';
import { soldByProduct, soldOf } from '../services/sales.js';
import { publicLimiter, telemetryLimiter, reviewSubmitLimiter, originGuard } from '../middleware/security.js';

const r = Router();
r.use(publicLimiter);
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // data harus selalu terbaru

const MAX_PRODUCTS = 1000;

async function visibleProducts() {
  const cats = await Category.find({ active: true }).sort({ order: 1, _id: 1 }).lean();
  const names = new Map(cats.map((c) => [String(c._id), c.name]));
  const products = await Product.find({ active: true, category: { $in: cats.map((c) => c._id) } }).sort({ productId: -1 }).limit(MAX_PRODUCTS).lean();
  const sold = await soldByProduct(products.map((p) => p._id));   // satu agregasi untuk seluruh grid
  return { cats, products: products.map((p) => pubProductCard(p, names.get(String(p.category)), sold.get(String(p._id)) ?? 0)) };
}

/** Satu permintaan untuk memuat seluruh Marketplace; dipakai juga untuk sinkron ulang setelah reconnect. */
r.get('/bootstrap', asyncH(async (_req, res) => {
  const [{ cats, products }, settings, faqs, contacts] = await Promise.all([
    visibleProducts(),
    getAllSettings(),
    Faq.find({ active: true }).sort({ order: 1, _id: 1 }).lean(),
    Contact.find({ active: true }).sort({ order: 1, _id: 1 }).lean(),
  ]);
  const pub = {};
  for (const k of SETTING_KEYS) pub[k] = publicSetting(k, settings[k]);
  pub.productPage = await withLiveProductPage(pub.productPage);
  pub.stats = await withLiveStats(pub.stats);   // pelanggan & pesanan dihitung dari database order
  res.json({
    settings: pub,
    categories: cats.map(pubCategory),
    products,
    faq: faqs.map(pubFaq),
    contacts: contacts.map(pubContact),
    serverTime: new Date().toISOString(),
  });
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

r.get('/products/:id', asyncH(async (req, res) => {
  const p = await findVisible(req.params.id);
  res.json({ product: pubProductDetail(p, p.category?.name, await soldOf(p._id)), reviews: await reviewSummary(p.productId) });
}));

const reviewQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(20).default(3) });
r.get('/products/:id/reviews', asyncH(async (req, res) => {
  const p = await findVisible(req.params.id);
  const { page, limit } = reviewQuery.parse(req.query);
  const filter = { product: p._id, status: 'published' };
  const [total, docs] = await Promise.all([
    Review.countDocuments(filter),
    Review.find(filter).sort({ date: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  res.json({ items: docs.map(pubReview), ...pageMeta(page, limit, total) });
}));

// Marketplace melaporkan gambar yang gagal dimuat -> log server + notifikasi admin
r.post('/image-error', telemetryLimiter, (req, res) => {
  recordImageError(req.body?.url, req.body?.page);
  res.status(204).end();
});

export default r;
