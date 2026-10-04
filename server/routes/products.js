import { Router } from 'express';
import { Product, Category, Review, nextSeq } from '../models/index.js';
import { asyncH, parse, HttpError, objectIdStr, pageMeta, escapeRegex } from '../lib/http.js';
import { productInput, productListQuery, statusInput } from '../lib/schemas.js';
import { admProduct, pubProductCard } from '../lib/serialize.js';
import { emitChange } from '../lib/realtime.js';
import * as assets from '../services/assets.js';
import { config } from '../config/env.js';

const r = Router();
const LOW_STOCK = 10; // sama dengan batas "Stok terbatas" di Marketplace

const SORTS = {
  newest: { productId: -1 }, oldest: { productId: 1 }, updated: { updatedAt: -1 }, name: { name: 1 },
  price_asc: { price: 1 }, price_desc: { price: -1 }, stock_asc: { stock: 1 }, stock_desc: { stock: -1 },
};

const owner = (id) => ({ type: 'product', id: String(id) });
const visible = (p) => p.active && p.category?.active !== false;
const events = {
  adm: (p) => admProduct(p),
  pub: (p) => pubProductCard(p, p.category?.name),
  visible,
  id: (p) => p.productId,
  admDel: (p) => ({ id: String(p._id), productId: p.productId }),
  pubDel: (p) => ({ id: p.productId }),
};

async function loadProduct(rawId) {
  if (!objectIdStr.safeParse(rawId).success) throw new HttpError(404, 'Produk tidak ditemukan.');
  const doc = await Product.findById(rawId).populate('category');
  if (!doc) throw new HttpError(404, 'Produk tidak ditemukan.');
  return doc;
}

async function checkCategory(id) {
  const cat = await Category.findById(id);
  if (!cat) throw new HttpError(422, 'Kategori tidak ditemukan.', { fields: { category: 'Kategori tidak ditemukan' } });
  return cat;
}

async function resolveMedia(keys, ownerRef) {
  const found = await assets.resolveForOwner(keys, ownerRef, { folders: ['products'], kinds: ['image', 'video'], max: config.limits.productMedia });
  if (found.filter((a) => a.kind === 'video').length > 1) throw new HttpError(422, 'Maksimal 1 video per produk.', { fields: { media: 'Maksimal 1 video' } });
  return found.map((a) => ({ type: a.kind, key: a.key, url: a.url }));
}

r.get('/', asyncH(async (req, res) => {
  const q = parse(productListQuery, req.query);
  const filter = {};
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: rx }, { description: rx }, ...(/^\d{1,9}$/.test(q.q) ? [{ productId: Number(q.q) }] : [])];
  }
  if (q.category) filter.category = q.category;
  if (q.status) filter.active = q.status === 'active';
  if (q.stock === 'out') filter.stock = 0;
  if (q.stock === 'low') filter.stock = { $gt: 0, $lte: LOW_STOCK };
  if (q.stock === 'in') filter.stock = { $gt: LOW_STOCK };

  const [total, docs] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).sort({ ...SORTS[q.sort], _id: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('category', 'name active'),
  ]);
  res.json({ items: docs.map((d) => admProduct(d)), ...pageMeta(q.page, q.limit, total) });
}));

r.get('/:id', asyncH(async (req, res) => res.json({ item: admProduct(await loadProduct(req.params.id)) })));

r.post('/', asyncH(async (req, res) => {
  const data = parse(productInput, req.body);
  const cat = await checkCategory(data.category);
  const keys = data.media.map((m) => m.key);
  const media = await resolveMedia(keys, owner('new'));
  const productId = await nextSeq('product');
  const doc = await Product.create({ ...data, media, productId });
  await assets.attach(owner(doc._id), keys);
  doc.category = cat;
  emitChange('product', { before: null, after: doc, ...events });
  res.status(201).json({ item: admProduct(doc, cat) });
}));

r.put('/:id', asyncH(async (req, res) => {
  const current = await loadProduct(req.params.id);
  const before = current.toObject();
  const data = parse(productInput, req.body);
  const cat = await checkCategory(data.category);
  const keys = data.media.map((m) => m.key);

  // 1) upload baru sudah ada & valid  2) simpan ke MongoDB  3) cek hasil tersimpan  4) baru hapus gambar lama
  const media = await resolveMedia(keys, owner(current._id));
  const updated = await Product.findOneAndUpdate({ _id: current._id }, { $set: { ...data, media } }, { new: true, runValidators: true });
  const saved = updated.media.map((m) => m.key).join('|');
  if (saved !== keys.join('|')) throw new HttpError(500, 'Penyimpanan data gambar tidak konsisten. Gambar lama tidak dihapus.');
  await assets.attach(owner(current._id), keys);

  updated.category = cat;
  emitChange('product', { before, after: updated.toObject(), ...events });
  res.json({ item: admProduct(updated, cat) });
}));

r.patch('/:id/status', asyncH(async (req, res) => {
  const { active } = parse(statusInput, req.body);
  const current = await loadProduct(req.params.id);
  const before = current.toObject();
  current.active = active;
  await current.save();
  emitChange('product', { before, after: current.toObject(), ...events });
  res.json({ item: admProduct(current) });
}));

r.delete('/:id', asyncH(async (req, res) => {
  const doc = await loadProduct(req.params.id);
  const before = doc.toObject();
  const reviews = await Review.find({ product: doc._id }).select('_id').lean();

  await Product.deleteOne({ _id: doc._id }); // data dulu, file R2 sesudahnya (kalau gagal -> ditandai orphan dan dicoba ulang)
  await Review.deleteMany({ product: doc._id });
  for (const rv of reviews) await assets.releaseOwner({ type: 'review', id: rv._id });
  await assets.releaseOwner(owner(doc._id));

  emitChange('product', { before, after: null, ...events });
  res.json({ ok: true, removedReviews: reviews.length });
}));

export default r;
