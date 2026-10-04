import { Router } from 'express';
import { z } from 'zod';
import { Product, Category, Review, Faq, Contact } from '../models/index.js';
import { asyncH, HttpError, pageMeta } from '../lib/http.js';
import { pubCategory, pubProductCard, pubProductDetail, pubFaq, pubContact, pubReview } from '../lib/serialize.js';
import { getAllSettings, publicSetting, SETTING_KEYS } from '../services/settings.js';
import { recordImageError } from '../services/imageErrors.js';
import { publicLimiter, telemetryLimiter } from '../middleware/security.js';

const r = Router();
r.use(publicLimiter);
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // data harus selalu terbaru

const MAX_PRODUCTS = 1000;

async function visibleProducts() {
  const cats = await Category.find({ active: true }).sort({ order: 1, _id: 1 }).lean();
  const names = new Map(cats.map((c) => [String(c._id), c.name]));
  const products = await Product.find({ active: true, category: { $in: cats.map((c) => c._id) } }).sort({ productId: -1 }).limit(MAX_PRODUCTS).lean();
  return { cats, products: products.map((p) => pubProductCard(p, names.get(String(p.category)))) };
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
  res.json({
    settings: pub,
    categories: cats.map(pubCategory),
    products,
    faq: faqs.map(pubFaq),
    contacts: contacts.map(pubContact),
    serverTime: new Date().toISOString(),
  });
}));

async function reviewSummary(productObjectId) {
  const counts = await Promise.all([5, 4, 3, 2, 1].map((s) => Review.countDocuments({ product: productObjectId, status: 'published', stars: s })));
  const total = counts.reduce((a, b) => a + b, 0);
  const sum = counts.reduce((acc, n, i) => acc + n * (5 - i), 0);
  return { avg: total ? Math.round((sum / total) * 10) / 10 : null, total, dist: { 5: counts[0], 4: counts[1], 3: counts[2], 2: counts[3], 1: counts[4] } };
}

const pidParam = z.coerce.number().int().min(1).max(1_000_000_000);

async function findVisible(rawId) {
  const pid = pidParam.safeParse(rawId);
  if (!pid.success) throw new HttpError(404, 'Produk tidak ditemukan.');
  const p = await Product.findOne({ productId: pid.data, active: true }).populate('category').lean();
  if (!p || p.category?.active === false) throw new HttpError(404, 'Produk tidak ditemukan.');
  return p;
}

r.get('/products/:id', asyncH(async (req, res) => {
  const p = await findVisible(req.params.id);
  res.json({ product: pubProductDetail(p, p.category?.name), reviews: await reviewSummary(p._id) });
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
