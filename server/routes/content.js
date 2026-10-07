import { Category, Product, Faq, Contact } from '../models/index.js';
import { categoryInput, faqInput, contactInput, contactIconInput } from '../lib/schemas.js';
import { HttpError, objectIdStr, asyncH, parse } from '../lib/http.js';
import { pubCategory, pubFaq, pubContact, admCategory, admFaq, admContact } from '../lib/serialize.js';
import { emitAdmin, emitPublic, emitChange } from '../lib/realtime.js';
import * as assets from '../services/assets.js';
import { orderedCrud } from './orderedCrud.js';

export const categoriesRouter = orderedCrud({
  Model: Category,
  entity: 'category',
  input: categoryInput,
  adm: (c) => admCategory(c),
  pub: pubCategory,
  hooks: {
    async decorateList(docs) {
      const counts = await Promise.all(docs.map((d) => Product.countDocuments({ category: d._id })));
      return docs.map((d, i) => admCategory(d, counts[i]));
    },
    async beforeSave(data, current) {
      const nameKey = data.name.trim().toLowerCase();
      const clash = await Category.findOne({ nameKey, ...(current ? { _id: { $ne: current._id } } : {}) }).select('_id').lean();
      if (clash) throw new HttpError(409, 'Nama kategori sudah dipakai.', { fields: { name: 'Nama kategori sudah dipakai' } });
      return { nameKey };
    },
    // ?moveTo=<categoryId> memindahkan produk ke kategori lain sebelum menghapus
    async beforeDelete(doc, query) {
      const count = await Product.countDocuments({ category: doc._id });
      if (!count) return;
      const moveTo = query?.moveTo;
      if (!moveTo || !objectIdStr.safeParse(moveTo).success || String(moveTo) === String(doc._id)) {
        throw new HttpError(409, `Kategori masih dipakai ${count} produk. Pindahkan produknya ke kategori lain dulu.`, { productCount: count });
      }
      const target = await Category.findById(moveTo);
      if (!target) throw new HttpError(422, 'Kategori tujuan tidak ditemukan.');
      await Product.updateMany({ category: doc._id }, { $set: { category: target._id } });
      emitAdmin('product:bulk', { reason: 'category-moved' });
      emitPublic('product:bulk', { reason: 'category-moved' }); // klien Marketplace sinkron ulang
    },
  },
});

export const faqRouter = orderedCrud({ Model: Faq, entity: 'faq', input: faqInput, adm: admFaq, pub: pubFaq });
/* ---------- Ikon kontak (gambar custom di R2; ikon bawaan tetap jadi fallback) ---------- */
const contactOwner = (id) => ({ type: 'contact', id: String(id) });
const CONTACT_ICON_RULES = { folders: ['contacts'], max: 1, mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'], maxBytes: 2 * 1048576 };

export const contactsRouter = orderedCrud({
  Model: Contact,
  entity: 'contact',
  input: contactInput,
  adm: admContact,
  pub: pubContact,
  hooks: {
    async beforeSave(data, current) {
      if (data.iconImage) await assets.resolveForOwner([data.iconImage.key], contactOwner(current?._id ?? 'new'), CONTACT_ICON_RULES);
      return {};
    },
    // Tandai gambar terpakai, lepas ikon lama yang sudah diganti/dihapus
    afterSave: (doc) => assets.attach(contactOwner(doc._id), doc.iconImage?.key ? [doc.iconImage.key] : []),
    afterDelete: (before) => assets.releaseOwner(contactOwner(before._id)),
  },
});

// Ubah hanya ikon satu kontak (dipakai halaman Pengaturan) tanpa menimpa teks/tautan kontak
contactsRouter.put('/:id/icon', asyncH(async (req, res) => {
  if (!objectIdStr.safeParse(req.params.id).success) throw new HttpError(404, 'Data tidak ditemukan.');
  const { iconImage } = parse(contactIconInput, req.body);
  const doc = await Contact.findById(req.params.id);
  if (!doc) throw new HttpError(404, 'Data tidak ditemukan.');
  if (iconImage) {
    try { await assets.resolveForOwner([iconImage.key], contactOwner(doc._id), CONTACT_ICON_RULES); }
    catch (err) { throw err instanceof HttpError ? new HttpError(err.status, err.message, { fields: { iconImage: err.message } }) : err; }
  }
  const before = doc.toObject();
  doc.iconImage = iconImage ? { key: iconImage.key } : null;
  await doc.save();
  await assets.attach(contactOwner(doc._id), doc.iconImage?.key ? [doc.iconImage.key] : []);
  emitChange('contact', { before, after: doc.toObject(), adm: admContact, pub: pubContact, visible: (d) => d.active !== false, id: (d) => String(d._id) });
  res.json({ item: admContact(doc) });
}));
