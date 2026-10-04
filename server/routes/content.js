import { Category, Product, Faq, Contact } from '../models/index.js';
import { categoryInput, faqInput, contactInput } from '../lib/schemas.js';
import { HttpError, objectIdStr } from '../lib/http.js';
import { pubCategory, pubFaq, pubContact, admCategory, admFaq, admContact } from '../lib/serialize.js';
import { emitAdmin, emitPublic } from '../lib/realtime.js';
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
export const contactsRouter = orderedCrud({ Model: Contact, entity: 'contact', input: contactInput, adm: admContact, pub: pubContact });
