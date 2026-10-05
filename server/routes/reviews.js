import { Router } from 'express';
import { Review, Product } from '../models/index.js';
import { asyncH, parse, HttpError, objectIdStr, pageMeta, escapeRegex } from '../lib/http.js';
import { reviewInput, reviewListQuery, statusInput } from '../lib/schemas.js';
import { admReview } from '../lib/serialize.js';
import { emitChange, emitPublic } from '../lib/realtime.js';
import * as assets from '../services/assets.js';
import { reviewOwner as owner, reviewEvents as events, SORTS } from '../services/reviews.js';
import { z } from 'zod';

const r = Router();
const visible = events.visible;

async function loadReview(rawId) {
  if (!objectIdStr.safeParse(rawId).success) throw new HttpError(404, 'Ulasan tidak ditemukan.');
  const doc = await Review.findById(rawId);
  if (!doc) throw new HttpError(404, 'Ulasan tidak ditemukan.');
  return doc;
}
async function productByPid(productId) {
  const p = await Product.findOne({ productId }).select('_id productId name').lean();
  if (!p) throw new HttpError(422, 'Produk tidak ditemukan.', { fields: { productId: 'Produk tidak ditemukan' } });
  return p;
}
const resolveImages = (keys, ownerRef) => assets.resolveForOwner(keys, ownerRef, { folders: ['reviews'], kinds: ['image'], max: 3 });

r.get('/', asyncH(async (req, res) => {
  const q = parse(reviewListQuery, req.query);
  const filter = {};
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); filter.$or = [{ name: rx }, { text: rx }]; }
  if (q.productId) filter.productId = q.productId;
  if (q.stars) filter.stars = q.stars;
  if (q.status) filter.status = q.status;
  const [total, docs] = await Promise.all([
    Review.countDocuments(filter),
    Review.find(filter).sort({ ...SORTS[q.sort], _id: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
  ]);
  const pids = [...new Set(docs.map((d) => d.productId))];
  const prods = await Product.find({ productId: { $in: pids } }).select('productId name').lean();
  const names = new Map(prods.map((p) => [p.productId, p]));
  res.json({ items: docs.map((d) => admReview(d, names.get(d.productId))), ...pageMeta(q.page, q.limit, total) });
}));

r.post('/', asyncH(async (req, res) => {
  const data = parse(reviewInput, req.body);
  const product = await productByPid(data.productId);
  const keys = data.images.map((i) => i.key);
  const found = await resolveImages(keys, owner('new'));
  const doc = await Review.create({
    product: product._id, productId: product.productId, name: data.name, stars: data.stars, text: data.text,
    date: data.date || new Date(), status: data.status, images: found.map((a) => ({ key: a.key, url: a.url })),
  });
  await assets.attach(owner(doc._id), keys);
  emitChange('review', { before: null, after: doc.toObject(), ...events });
  res.status(201).json({ item: admReview(doc, product) });
}));

r.put('/:id', asyncH(async (req, res) => {
  const current = await loadReview(req.params.id);
  const before = current.toObject();
  const data = parse(reviewInput, req.body);
  const product = await productByPid(data.productId);
  const keys = data.images.map((i) => i.key);
  const found = await resolveImages(keys, owner(current._id));
  const updated = await Review.findOneAndUpdate({ _id: current._id }, {
    $set: { product: product._id, productId: product.productId, name: data.name, stars: data.stars, text: data.text, date: data.date || current.date, status: data.status, images: found.map((a) => ({ key: a.key, url: a.url })) },
  }, { new: true });
  await assets.attach(owner(current._id), keys);
  emitChange('review', { before, after: updated.toObject(), ...events });
  // Bila ulasan dipindah ke produk lain, halaman produk lama perlu menghapusnya
  if (before.productId !== updated.productId && visible(before)) emitPublic('review:delete', events.pubDel(before));
  res.json({ item: admReview(updated, product) });
}));

r.patch('/:id/status', asyncH(async (req, res) => {
  const { active } = parse(z.object({ active: statusInput.shape.active }), req.body);
  const doc = await loadReview(req.params.id);
  const before = doc.toObject();
  doc.status = active ? 'published' : 'hidden';
  await doc.save();
  emitChange('review', { before, after: doc.toObject(), ...events });
  const product = await Product.findOne({ productId: doc.productId }).select('productId name').lean();
  res.json({ item: admReview(doc, product) });
}));

r.delete('/:id', asyncH(async (req, res) => {
  const doc = await loadReview(req.params.id);
  const before = doc.toObject();
  await Review.deleteOne({ _id: doc._id });
  await assets.releaseOwner(owner(doc._id));
  emitChange('review', { before, after: null, ...events });
  res.json({ ok: true });
}));

export default r;
