import { Category, Product, Review, Faq, Contact, Setting, nextSeq, Counter } from '../models/index.js';
import * as fx from './fixture.js';
import { nextTopOrder } from '../services/productOrder.js';

/** Isi database dengan data prototype Marketplace. Aman dipanggil berulang: berhenti bila sudah ada produk. */
export async function seedDemo({ force = false } = {}) {
  if (!force && (await Product.countDocuments({})) > 0) return { skipped: true };
  if (force) {
    await Promise.all([Category, Product, Review, Faq, Contact, Setting, Counter].map((m) => m.deleteMany({})));
  }

  const cats = {};
  for (const [order, name] of fx.categories.entries()) {
    cats[name] = await Category.create({ name, nameKey: name.toLowerCase(), order });
  }
  const created = [];
  for (const p of fx.productFixtures) {
    created.push(await Product.create({ ...p, category: cats[p.category]._id, productId: await nextSeq('product'), order: await nextTopOrder() }));
  }
  const first = created[0];
  for (const r of fx.reviews) await Review.create({ ...r, product: first._id, productId: first.productId });
  for (const [order, f] of fx.faq.entries()) await Faq.create({ ...f, order });
  for (const [order, c] of fx.contacts.entries()) await Contact.create({ ...c, order });
  for (const [key, value] of Object.entries(fx.settings)) await Setting.create({ key, value });
  return { skipped: false, products: created.length };
}
