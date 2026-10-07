import { Router } from 'express';
import { Product, Category, Review, nextSeq } from '../models/index.js';
import { asyncH, parse, HttpError, objectIdStr, pageMeta, escapeRegex } from '../lib/http.js';
import { productInput, productListQuery, statusInput, moveInput } from '../lib/schemas.js';
import { admProduct, pubProductCard } from '../lib/serialize.js';
import { emitChange, emitAdmin, emitPublic } from '../lib/realtime.js';
import * as assets from '../services/assets.js';
import { resolveProductMedia, mediaIdent } from '../services/productMedia.js';
import { soldByProduct, soldOf } from '../services/sales.js';
import { releaseProductCodes, deleteProductCodes } from '../services/codes.js';
import { ORDER_SORT, nextTopOrder, moveProduct, positionsFor, ensureProductOrder } from '../services/productOrder.js';

const r = Router();
const LOW_STOCK = 10; // sama dengan batas "Stok terbatas" di Marketplace

const SORTS = {
  manual: ORDER_SORT,   // urutan yang diatur Admin = urutan tampil di Marketplace
  newest: { productId: -1 }, oldest: { productId: 1 }, updated: { updatedAt: -1 }, name: { name: 1 },
  price_asc: { price: 1 }, price_desc: { price: -1 }, stock_asc: { stock: 1 }, stock_desc: { stock: -1 },
};

const owner = (id) => ({ type: 'product', id: String(id) });
const visible = (p) => p.active && p.category?.active !== false;
const events = {
  visible,
  id: (p) => p.productId,
  admDel: (p) => ({ id: String(p._id), productId: p.productId }),
  pubDel: (p) => ({ id: p.productId }),
};
// "Terjual" dihitung dari order SUCCESS (services/sales.js); event realtime membawa angka yang sama dengan API,
// jadi kartu di Marketplace tidak kehilangan/merusak angka saat admin mengubah produk.
const eventsWith = (sold) => ({
  ...events,
  adm: (p) => admProduct(p, undefined, sold),
  pub: (p) => pubProductCard(p, p.category?.name, sold),
});

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

r.get('/', asyncH(async (req, res) => {
  const q = parse(productListQuery, req.query);
  const filter = {};
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: rx }, { description: rx }, ...(/^\d{1,9}$/.test(q.q) ? [{ productId: Number(q.q) }] : [])];
  }
  if (q.category) filter.category = q.category;
  if (q.sort === 'manual') await ensureProductOrder();   // data lama tanpa order dirapikan dulu supaya urutan pasti
  if (q.status) filter.active = q.status === 'active';
  if (q.stock === 'out') filter.stock = 0;
  if (q.stock === 'low') filter.stock = { $gt: 0, $lte: LOW_STOCK };
  if (q.stock === 'in') filter.stock = { $gt: LOW_STOCK };

  const [total, docs] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).sort({ ...SORTS[q.sort], _id: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('category', 'name active'),
  ]);
  const sold = await soldByProduct(docs.map((d) => d._id));
  // Urutan manual: sertakan posisi di dalam kategorinya (untuk tombol naik/turun di Admin)
  const pos = q.sort === 'manual' ? await positionsFor(docs) : null;
  res.json({ items: docs.map((d) => ({ ...admProduct(d, undefined, sold.get(String(d._id)) ?? 0), ...(pos ? { position: pos.get(String(d._id)) ?? null } : {}) })), ...pageMeta(q.page, q.limit, total) });
}));

/** Pindah posisi produk di dalam kategorinya: body { to: 'up' | 'down' | 'top' | 'bottom' }. Harus sebelum rute '/:id' lain bila ada bentrok. */
r.patch('/:id/move', asyncH(async (req, res) => {
  const { to } = parse(moveInput, req.body);
  const doc = await loadProduct(req.params.id);
  const changed = await moveProduct(doc, to);
  if (changed.length) {
    emitAdmin('product:reorder', { items: changed.map((c) => ({ id: String(c._id), productId: c.productId, order: c.order })) });
    // Marketplace hanya menerima produk yang tampil (aktif + kategori aktif); produk tersembunyi tidak bocor lewat event
    const shown = await Product.find({ _id: { $in: changed.map((c) => c._id) }, active: true }).populate('category', 'active').select('productId order category').lean();
    const items = shown.filter((p) => p.category?.active !== false).map((p) => ({ id: p.productId, order: p.order }));
    if (items.length) emitPublic('product:reorder', { items });
  }
  res.json({ ok: true, moved: changed.length > 0, items: changed.map((c) => ({ id: String(c._id), productId: c.productId, order: c.order })) });
}));

r.get('/:id', asyncH(async (req, res) => {
  const doc = await loadProduct(req.params.id);
  res.json({ item: admProduct(doc, undefined, await soldOf(doc._id)) });
}));

r.post('/', asyncH(async (req, res) => {
  const data = parse(productInput, req.body);
  const cat = await checkCategory(data.category);
  const { media, keys } = await resolveProductMedia(data.media, owner('new'));   // upload -> R2, media Steam -> URL asli (tanpa R2)
  const productId = await nextSeq('product');
  const doc = await Product.create({ ...data, media, productId, order: await nextTopOrder() });   // produk baru = paling atas, produk lain tidak bergeser
  await assets.attach(owner(doc._id), keys);
  doc.category = cat;
  emitChange('product', { before: null, after: doc, ...eventsWith(0) });   // produk baru belum punya order
  res.status(201).json({ item: admProduct(doc, cat, 0) });
}));

r.put('/:id', asyncH(async (req, res) => {
  const current = await loadProduct(req.params.id);
  if (current.kind === 'code') throw new HttpError(409, 'Produk ini memakai Sistem Code. Ubah lewat form Produk Code (stok dikelola dari daftar code).');
  const before = current.toObject();
  const data = parse(productInput, req.body);
  const cat = await checkCategory(data.category);

  // 1) upload baru sudah ada & valid  2) simpan ke MongoDB  3) cek hasil tersimpan  4) baru hapus gambar lama
  const { media, keys } = await resolveProductMedia(data.media, owner(current._id));
  const updated = await Product.findOneAndUpdate({ _id: current._id }, { $set: { ...data, media } }, { new: true, runValidators: true });
  const saved = updated.media.map(mediaIdent).join('|');
  if (saved !== media.map(mediaIdent).join('|')) throw new HttpError(500, 'Penyimpanan data gambar tidak konsisten. Gambar lama tidak dihapus.');
  await assets.attach(owner(current._id), keys);

  updated.category = cat;
  const sold = await soldOf(updated._id);
  emitChange('product', { before, after: updated.toObject(), ...eventsWith(sold) });
  res.json({ item: admProduct(updated, cat, sold) });
}));

r.patch('/:id/status', asyncH(async (req, res) => {
  const { active } = parse(statusInput, req.body);
  const current = await loadProduct(req.params.id);
  const before = current.toObject();
  current.active = active;
  await current.save();
  const sold = await soldOf(current._id);
  emitChange('product', { before, after: current.toObject(), ...eventsWith(sold) });
  res.json({ item: admProduct(current, undefined, sold) });
}));

r.delete('/:id', asyncH(async (req, res) => {
  const doc = await loadProduct(req.params.id);
  if (doc.kind === 'code') await releaseProductCodes(doc);   // ditolak (409) bila ada code terjual atau pesanan menunggu code
  const before = doc.toObject();
  const reviews = await Review.find({ product: doc._id }).select('_id').lean();

  await Product.deleteOne({ _id: doc._id }); // data dulu, file R2 sesudahnya (kalau gagal -> ditandai orphan dan dicoba ulang)
  await Review.deleteMany({ product: doc._id });
  if (doc.kind === 'code') await deleteProductCodes(doc);
  for (const rv of reviews) await assets.releaseOwner({ type: 'review', id: rv._id });
  await assets.releaseOwner(owner(doc._id));

  emitChange('product', { before, after: null, ...events });
  res.json({ ok: true, removedReviews: reviews.length });
}));

export default r;
