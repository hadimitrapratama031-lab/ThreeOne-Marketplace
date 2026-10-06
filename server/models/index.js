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
  // 'code' = Sistem Code: stok = jumlah RedeemCode berstatus available (dijaga services/codes.js), bukan angka manual.
  kind: { type: String, enum: ['normal', 'code'], default: 'normal' },
  // Cara redeem, satu langkah per baris. Ditulis Admin; tampil HANYA di halaman Payment Success pembeli.
  redeemTutorial: { type: String, default: '', maxlength: 4000 },
  description: { type: String, default: '', maxlength: 300 },
  about: { type: String, default: '', maxlength: 4000 },
  specs: {
    min: { type: [specRow], default: [] },
    rec: { type: [specRow], default: [] },
    source: { type: String, default: '', maxlength: 120 },
  },
  // Info game (mis. dari Steam). Semua opsional; kosong = tidak tersedia, tidak pernah dikarang.
  gameInfo: {
    steamAppId: { type: String, default: '', maxlength: 10 },
    developer: { type: String, default: '', maxlength: 200 },
    publisher: { type: String, default: '', maxlength: 200 },
    releaseDate: { type: String, default: '', maxlength: 60 },
    genres: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
    metacritic: { ...int, default: null, min: 0, max: 100 },
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
productSchema.index({ kind: 1 });
export const Product = mongoose.model('Product', productSchema);

/* Review (rating & ulasan per produk) */
const reviewSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: 'Product', default: null },   // opsional: ulasan umum tanpa produk
  productId: { ...int, default: null },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  stars: { ...int, required: true, min: 1, max: 5 },
  text: { type: String, required: true, trim: true, maxlength: 1000 },
  date: { type: Date, default: Date.now },
  images: { type: [new Schema({ key: String, url: String }, { _id: false })], default: [] },
  status: { type: String, enum: ['published', 'hidden'], default: 'published' },
  legacyId: { type: String },                                        // id rating di project lama (hanya terisi oleh script migrasi; kunci anti-dobel)
}, { timestamps: true });
reviewSchema.index({ legacyId: 1 }, { unique: true, partialFilterExpression: { legacyId: { $type: 'string' } } });
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

/* Order — checkout + pembayaran QRIS (KlikQRIS).
   Status order dikelola backend: PENDING -> SUCCESS | EXPIRED | FAILED.
   SUCCESS/EXPIRED mengikuti status KlikQRIS (PAID/SUCCESS, EXPIRED); FAILED adalah status INTERNAL
   untuk transaksi yang gagal dibuat di gateway (KlikQRIS tidak punya status gagal). */
export const ORDER_STATUSES = ['PENDING', 'SUCCESS', 'EXPIRED', 'FAILED'];
const orderEvent = new Schema({ at: { type: Date, default: Date.now }, type: { type: String, maxlength: 40 }, detail: { type: String, maxlength: 300, default: '' } }, { _id: false });
const orderSchema = new Schema({
  orderNo: { type: String, required: true, unique: true },            // juga dipakai sebagai order_id di KlikQRIS
  clientKey: { type: String, maxlength: 64 },                          // kunci idempotensi dari browser (anti dobel klik)
  status: { type: String, enum: ORDER_STATUSES, default: 'PENDING' },
  rev: { ...int, default: 1 },                                         // naik setiap perubahan; klien mengabaikan event usang/ganda
  customer: {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    whatsapp: { type: String, required: true, maxlength: 20 },
  },
  product: {
    ref: { type: Schema.Types.ObjectId, ref: 'Product', default: null },   // kosong = riwayat impor dari produk yang sudah dihapus di sistem lama
    productId: { ...int, default: null },
    name: { type: String, required: true },
    category: { type: String, default: '' },
    imageKey: { type: String, default: '' },
    kind: { type: String, enum: ['normal', 'code'], default: 'normal' },  // snapshot saat checkout: order lama / produk yang berubah tidak memengaruhi
  },
  amount: { ...int, required: true, min: 1 },                          // harga produk (snapshot saat checkout)
  totalAmount: { type: Number, default: null },                        // total_amount dari KlikQRIS (bisa memuat kode unik)
  uniqueAmount: { type: Number, default: 0 },                          // amount_uniq dari KlikQRIS
  expiresAt: { type: Date, default: null },                            // batas bayar (waktu SERVER) = QRIS dibuat + 10 menit
  payment: {
    provider: { type: String, default: 'klikqris' },
    mode: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
    gatewayStatus: { type: String, default: '' },                      // status terakhir dari KlikQRIS apa adanya
    qrisUrl: { type: String, default: '' },
    reportUrl: { type: String, default: '' },
    signature: { type: String, select: false },                        // signature dari respons create; pembanding webhook
    gatewayExpiredAt: { type: String, default: '' },
    gatewayPaidAt: { type: String, default: '' },
    createdAt: Date,
    paidAt: Date,
    source: { type: String, default: '' },                             // webhook | status-check
    lastCheckedAt: Date,
    webhookCount: { ...int, default: 0 },
    lastWebhookAt: Date,
  },
  latePayment: { type: Boolean, default: false },                      // dana masuk setelah order dinyatakan kedaluwarsa
  stockNote: { type: String, default: '' },                            // 'short' = stok sudah habis saat pembayaran masuk
  // Produk Sistem Code: '' = belum diproses, 'assigned' = code sudah diberikan, 'waiting' = sudah dibayar tapi stok code habis
  // (diberikan otomatis begitu Admin menambah stok). Sumber kebenaran relasinya tetap RedeemCode.order.
  codeState: { type: String, enum: ['', 'waiting', 'assigned'], default: '' },
  failureReason: { type: String, default: '', maxlength: 300 },
  origin: { type: String, default: '', maxlength: 200 },               // origin toko saat checkout (untuk tautan di notifikasi)
  events: { type: [orderEvent], default: [] },
}, { timestamps: true });
orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index({ status: 1, 'product.ref': 1 });                  // hitung "Terjual" per produk (services/sales.js)
orderSchema.index({ clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'product.kind': 1, status: 1, codeState: 1 });                       // pemulihan order code yang belum diproses
orderSchema.index({ 'product.ref': 1, createdAt: 1 }, { partialFilterExpression: { codeState: 'waiting' } });   // antrean order menunggu code (FIFO)
orderSchema.index({ 'customer.email': 1 });
export const Order = mongoose.model('Order', orderSchema);

/* NotificationLog — satu baris per (order, event, channel). Baris ini sekaligus KUNCI idempotensi:
   di-claim SEBELUM provider dipanggil, jadi webhook ganda / reconnect / refresh tidak pernah mengirim dua kali.
   Struktur dan arti status sama dengan project Marketplace lama. */
export const NOTIFICATION_EVENTS = ['orderCreated', 'paymentSuccess', 'paymentFailed', 'paymentExpired'];
export const NOTIFICATION_CHANNELS = ['whatsapp', 'email'];
const notificationLogSchema = new Schema({
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  orderCode: { type: String, default: '' },
  channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
  event: { type: String, enum: NOTIFICATION_EVENTS, required: true },
  status: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending' },
  recipient: { type: String, default: '' },
  templateSource: { type: String, enum: ['builtin', 'custom', ''], default: '' },
  attempts: { type: Number, default: 0 },
  permanentFailure: { type: Boolean, default: false },
  error: { type: String, default: '' },
  providerResponse: { type: Schema.Types.Mixed },
  resendMessageId: { type: String },
  deliveryStatus: { type: String, enum: ['unknown', 'delivered', 'bounced', 'complained', 'delayed'], default: 'unknown' },
  deliveryStatusAt: Date,
  claimedAt: Date,
  sentAt: Date,
  failedAt: Date,
}, { timestamps: true });
notificationLogSchema.index({ orderId: 1, event: 1, channel: 1 }, { unique: true });
notificationLogSchema.index({ createdAt: -1 });
notificationLogSchema.index({ orderCode: 1 });
notificationLogSchema.index({ status: 1 });
notificationLogSchema.index({ resendMessageId: 1 }, { sparse: true });
export const NotificationLog = mongoose.model('NotificationLog', notificationLogSchema);


/* RedeemCode — satu dokumen per code. Status hanya bergerak maju: available -> sold. (Redeem terjadi di aplikasi lain, jadi tidak dilacak.)
   - codeKey (huruf besar) unik GLOBAL: code yang sama tidak bisa dimasukkan dua kali, di produk mana pun.
   - index unik parsial pada `order`: satu order tidak pernah bisa memegang dua code, walau dua proses berebut secara bersamaan.
   - Code mentah tidak pernah masuk ke API publik; hanya Admin (API admin) dan pemilik order (token pelanggan) yang membacanya. */
export const CODE_STATUSES = ['available', 'sold'];
const redeemCodeSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  productId: { ...int, required: true },
  code: { type: String, required: true, trim: true, maxlength: 100 },
  codeKey: { type: String, required: true },
  status: { type: String, enum: CODE_STATUSES, default: 'available' },
  order: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
  orderNo: { type: String, default: '' },
  customer: {                                    // snapshot saat code diberikan (laporan tetap benar walau data order berubah)
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    whatsapp: { type: String, default: '' },
  },
  assignedAt: { type: Date, default: null },
}, { timestamps: true });
redeemCodeSchema.index({ codeKey: 1 }, { unique: true });
redeemCodeSchema.index({ order: 1 }, { unique: true, partialFilterExpression: { order: { $type: 'objectId' } } });
redeemCodeSchema.index({ product: 1, status: 1, _id: 1 });                    // mengambil code available berikutnya (FIFO)
redeemCodeSchema.index({ status: 1, assignedAt: -1 });
redeemCodeSchema.index({ assignedAt: -1 });
redeemCodeSchema.index({ updatedAt: -1 });
redeemCodeSchema.index({ orderNo: 1 });
redeemCodeSchema.index({ 'customer.email': 1 });
export const RedeemCode = mongoose.model('RedeemCode', redeemCodeSchema);

export const ALL_MODELS = [Counter, Admin, Category, Product, Review, Faq, Contact, Setting, Asset, Order, NotificationLog, RedeemCode];

export async function syncAllIndexes() {
  for (const m of ALL_MODELS) await m.syncIndexes();
}
