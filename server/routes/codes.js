import { Router } from 'express';
import { Product, Category, nextSeq } from '../models/index.js';
import { asyncH, parse, HttpError, objectIdStr, pageMeta } from '../lib/http.js';
import { codeProductInput, codeProductUpdateInput, addCodesInput, codeListQuery } from '../lib/schemas.js';
import { admProduct, pubProductCard } from '../lib/serialize.js';
import { emitChange } from '../lib/realtime.js';
import * as assets from '../services/assets.js';
import { soldOf } from '../services/sales.js';
import { addCodes, validateCodeInput, listCodes, revealCode, codeStats, productCounts, broadcastProduct } from '../services/codes.js';
import { fulfillWaitingOrders } from '../services/redeem.js';
import { nextTopOrder } from '../services/productOrder.js';

const owner = (id) => ({ type: 'product', id: String(id) });
const visible = (p) => p.active && p.category?.active !== false;
const eventsWith = (sold) => ({
  visible,
  id: (p) => p.productId,
  admDel: (p) => ({ id: String(p._id), productId: p.productId }),
  pubDel: (p) => ({ id: p.productId }),
  adm: (p) => admProduct(p, undefined, sold),
  pub: (p) => pubProductCard(p, p.category?.name, sold),
});

async function checkCategory(id) {
  const cat = await Category.findById(id);
  if (!cat) throw new HttpError(422, 'Kategori tidak ditemukan.', { fields: { category: 'Kategori tidak ditemukan' } });
  return cat;
}
async function loadCodeProduct(rawId) {
  if (!objectIdStr.safeParse(rawId).success) throw new HttpError(404, 'Produk tidak ditemukan.');
  const doc = await Product.findOne({ _id: rawId, kind: 'code' }).populate('category');
  if (!doc) throw new HttpError(404, 'Produk code tidak ditemukan.');
  return doc;
}
const resolveImages = (keys, ownerRef) => assets.resolveForOwner(keys, ownerRef, { folders: ['products'], kinds: ['image'], max: 10 })
  .then((found) => found.map((a) => ({ type: a.kind, key: a.key, url: a.url })));

const withCounts = async (doc, sold) => ({ ...admProduct(doc, undefined, sold), codes: await productCounts(doc._id) });

/* ---------- /api/admin/code-products  (Add Product → Sistem Code) ---------- */
export const codeProductsRouter = Router();

codeProductsRouter.get('/:id', asyncH(async (req, res) => {
  const doc = await loadCodeProduct(req.params.id);
  res.json({ item: await withCounts(doc, await soldOf(doc._id)) });
}));

// Buat produk code + stok code awal. Baris code tidak valid menolak seluruh permintaan SEBELUM produk dibuat.
codeProductsRouter.post('/', asyncH(async (req, res) => {
  const data = parse(codeProductInput, req.body);
  const cat = await checkCategory(data.category);
  const hasCodes = data.codes.trim() !== '';
  if (hasCodes) validateCodeInput(data.codes);

  const keys = data.media.map((m) => m.key);
  const media = await resolveImages(keys, owner('new'));
  const productId = await nextSeq('product');
  const { codes, ...fields } = data;
  const doc = await Product.create({ ...fields, media, productId, kind: 'code', stock: 0, order: await nextTopOrder() });
  await assets.attach(owner(doc._id), keys);

  const result = hasCodes ? await addCodes(doc, codes) : null;   // menyinkronkan stok = jumlah code available
  const saved = await Product.findById(doc._id).populate('category');
  emitChange('product', { before: null, after: saved, ...eventsWith(0) });
  res.status(201).json({ item: await withCounts(saved, 0), codes: result });
}));

// Ubah info produk (BUKAN stok code; stok hanya berubah lewat penambahan code dan penjualan)
codeProductsRouter.put('/:id', asyncH(async (req, res) => {
  const current = await loadCodeProduct(req.params.id);
  const before = current.toObject();
  const data = parse(codeProductUpdateInput, req.body);
  const cat = await checkCategory(data.category);
  const keys = data.media.map((m) => m.key);
  const media = await resolveImages(keys, owner(current._id));
  const updated = await Product.findOneAndUpdate({ _id: current._id }, { $set: { ...data, media } }, { new: true, runValidators: true });
  if (updated.media.map((m) => m.key).join('|') !== keys.join('|')) throw new HttpError(500, 'Penyimpanan data gambar tidak konsisten. Gambar lama tidak dihapus.');
  await assets.attach(owner(current._id), keys);
  updated.category = cat;
  const sold = await soldOf(updated._id);
  emitChange('product', { before, after: updated.toObject(), ...eventsWith(sold) });
  res.json({ item: await withCounts(updated, sold) });
}));

// Tambah stok code (satu code per baris). Duplikat tidak disimpan; pesanan yang menunggu code langsung dipenuhi.
codeProductsRouter.post('/:id/codes', asyncH(async (req, res) => {
  const doc = await loadCodeProduct(req.params.id);
  const { codes } = parse(addCodesInput, req.body);
  const result = await addCodes(doc, codes);
  const fulfilled = await fulfillWaitingOrders(doc._id);
  await broadcastProduct(doc._id);   // stok baru langsung tampil di Marketplace
  const fresh = await Product.findById(doc._id).populate('category');
  res.status(201).json({ ...result, fulfilled, item: await withCounts(fresh, await soldOf(doc._id)) });
}));

/* ---------- /api/admin/codes  (Laporan Code) ---------- */
export const codesRouter = Router();

codesRouter.get('/stats', asyncH(async (_req, res) => res.json(await codeStats())));

codesRouter.get('/', asyncH(async (req, res) => {
  const q = parse(codeListQuery, req.query);
  const { items, total } = await listCodes(q);
  res.json({ items, ...pageMeta(q.page, q.limit, total) });
}));

// Melihat isi code available (di daftar disamarkan). Sesuai akses Admin yang sudah ada: harus login.
codesRouter.get('/:id/reveal', asyncH(async (req, res) => {
  if (!objectIdStr.safeParse(req.params.id).success) throw new HttpError(404, 'Code tidak ditemukan.');
  res.set('Cache-Control', 'no-store');
  res.json({ item: await revealCode(req.params.id) });
}));
