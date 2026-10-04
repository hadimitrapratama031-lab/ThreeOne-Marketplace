import { Router } from 'express';
import { Product, Category, Review, Faq, Contact, Asset } from '../models/index.js';
import { asyncH } from '../lib/http.js';
import { admProduct, admReview } from '../lib/serialize.js';
import { getOnline } from '../lib/realtime.js';

const r = Router();
const LOW = 10;

r.get('/', asyncH(async (_req, res) => {
  const [total, active, out, low, categories, faqs, contacts, reviewsPublished, reviewsHidden, assetsTotal] = await Promise.all([
    Product.countDocuments({}),
    Product.countDocuments({ active: true }),
    Product.countDocuments({ stock: 0 }),
    Product.countDocuments({ stock: { $gt: 0, $lte: LOW } }),
    Category.find().sort({ order: 1 }).lean(),
    Faq.countDocuments({ active: true }),
    Contact.countDocuments({ active: true }),
    Review.countDocuments({ status: 'published' }),
    Review.countDocuments({ status: 'hidden' }),
    Asset.countDocuments({}),
  ]);

  const perCat = await Promise.all(categories.map((c) => Product.countDocuments({ category: c._id })));
  const dist = await Promise.all([5, 4, 3, 2, 1].map((s) => Review.countDocuments({ status: 'published', stars: s })));
  const ratingTotal = dist.reduce((a, b) => a + b, 0);
  const ratingSum = dist.reduce((sum, n, i) => sum + n * (5 - i), 0);

  const [attention, recentReviews, recentProducts] = await Promise.all([
    Product.find({ stock: { $lte: LOW } }).sort({ stock: 1, productId: 1 }).limit(8).populate('category', 'name active'),
    Review.find().sort({ createdAt: -1 }).limit(5),
    Product.find().sort({ updatedAt: -1 }).limit(5).populate('category', 'name active'),
  ]);
  const names = new Map((await Product.find({ productId: { $in: recentReviews.map((x) => x.productId) } }).select('productId name').lean()).map((p) => [p.productId, p]));

  res.json({
    online: getOnline(),
    products: { total, active, inactive: total - active, out, low, healthy: Math.max(0, total - out - low) },
    categories: categories.map((c, i) => ({ id: String(c._id), name: c.name, active: c.active, count: perCat[i] })),
    reviews: { published: reviewsPublished, hidden: reviewsHidden, average: ratingTotal ? ratingSum / ratingTotal : null, distribution: { 5: dist[0], 4: dist[1], 3: dist[2], 2: dist[3], 1: dist[4] } },
    content: { faqs, contacts, assets: assetsTotal },
    attention: attention.map((p) => admProduct(p)),
    recentProducts: recentProducts.map((p) => admProduct(p)),
    recentReviews: recentReviews.map((x) => admReview(x, names.get(x.productId))),
  });
}));

export default r;
