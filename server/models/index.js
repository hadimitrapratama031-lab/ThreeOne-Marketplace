import mongoose from 'mongoose';
const { Schema } = mongoose;

const int = { type: Number, validate: { validator: (v) => v == null || Number.isInteger(v), message: '{PATH} harus bilangan bulat' } };

/* Counter — id produk numerik berurutan (URL Marketplace memakai product.html?id=1) */
export const Counter = mongoose.model('Counter', new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false }));
export async function nextSeq(name) {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return doc.seq;
}

/* Admin */
const adminSchema = new Schema({
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  passwordHash: { type: String, required: true },
  tokenVersion: { type: Number, default: 0 },
  lastLoginAt: Date,
}, { timestamps: true });
export const Admin = mongoose.model('Admin', adminSchema);

/* Category */
const categorySchema = new Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 40 },
  nameKey: { type: String, required: true, unique: true }, // lowercase, untuk unik tanpa peduli huruf besar
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });
categorySchema.index({ order: 1 });
export const Category = mongoose.model('Category', categorySchema);

/* Product */
const mediaSchema = new Schema({
  type: { type: String, enum: ['image', 'video'], required: true },
  key: { type: String, required: true },
  url: { type: String, required: true },
}, { _id: false });
const specRow = new Schema({
  label: { type: String, required: true, trim: true, maxlength: 60 },
  value: { type: String, required: true, trim: true, maxlength: 200 },
}, { _id: false });

const productSchema = new Schema({
  productId: { ...int, required: true, unique: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
  price: { ...int, required: true, min: 0 },
  oldPrice: { ...int, default: null, min: 0 },
  stock: { ...int, required: true, min: 0, default: 0 },
  sold: { ...int, min: 0, default: 0 },
  active: { type: Boolean, default: true },
  description: { type: String, default: '', maxlength: 300 },
  about: { type: String, default: '', maxlength: 4000 },
  specs: {
    min: { type: [specRow], default: [] },
    rec: { type: [specRow], default: [] },
    source: { type: String, default: '', maxlength: 120 },
  },
  media: { type: [mediaSchema], default: [] },
}, { timestamps: true });
productSchema.index({ active: 1, category: 1 });
productSchema.index({ category: 1 });
productSchema.index({ createdAt: -1 });
productSchema.index({ updatedAt: -1 });
productSchema.index({ name: 1 });
productSchema.index({ price: 1 });
productSchema.index({ stock: 1 });
export const Product = mongoose.model('Product', productSchema);

/* Review (rating & ulasan per produk) */
const reviewSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  productId: { ...int, required: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  stars: { ...int, required: true, min: 1, max: 5 },
  text: { type: String, required: true, trim: true, maxlength: 1000 },
  date: { type: Date, default: Date.now },
  images: { type: [new Schema({ key: String, url: String }, { _id: false })], default: [] },
  status: { type: String, enum: ['published', 'hidden'], default: 'published' },
}, { timestamps: true });
reviewSchema.index({ product: 1, status: 1, date: -1 });
reviewSchema.index({ status: 1, date: -1 });
reviewSchema.index({ stars: 1 });
reviewSchema.index({ productId: 1 });
export const Review = mongoose.model('Review', reviewSchema);

/* FAQ */
const faqSchema = new Schema({
  question: { type: String, required: true, trim: true, minlength: 3, maxlength: 200 },
  answer: { type: String, required: true, trim: true, maxlength: 2000 },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });
faqSchema.index({ order: 1 });
export const Faq = mongoose.model('Faq', faqSchema);

/* Contact */
export const CONTACT_ICONS = {
  whatsapp: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z',
  discord: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  email: 'M3 7l9 6 9-6M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  telegram: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
};
const contactSchema = new Schema({
  label: { type: String, required: true, trim: true, maxlength: 40 },
  value: { type: String, required: true, trim: true, maxlength: 120 },
  href: { type: String, default: '', maxlength: 300 },
  icon: { type: String, enum: Object.keys(CONTACT_ICONS), default: 'link' },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });
contactSchema.index({ order: 1 });
export const Contact = mongoose.model('Contact', contactSchema);

/* Setting — satu dokumen per key: branding, hero, stats, sections, productPage */
const settingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });
export const Setting = mongoose.model('Setting', settingSchema);

/* Asset — pelacak setiap objek di R2 (siapa pemiliknya) supaya penghapusan aman */
const assetSchema = new Schema({
  key: { type: String, required: true, unique: true },
  url: { type: String, required: true },
  kind: { type: String, enum: ['image', 'video'], required: true },
  mime: String,
  size: Number,
  folder: { type: String, required: true },
  originalName: { type: String, maxlength: 200 },
  status: { type: String, enum: ['temp', 'used', 'orphan'], default: 'temp' },
  owner: { type: { type: String }, id: String },
}, { timestamps: true });
assetSchema.index({ 'owner.type': 1, 'owner.id': 1 });
assetSchema.index({ status: 1, createdAt: 1 });
assetSchema.index({ createdAt: -1 });
export const Asset = mongoose.model('Asset', assetSchema);

export const ALL_MODELS = [Counter, Admin, Category, Product, Review, Faq, Contact, Setting, Asset];

export async function syncAllIndexes() {
  for (const m of ALL_MODELS) await m.syncIndexes();
}
