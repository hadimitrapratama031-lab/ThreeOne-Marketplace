import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { boot, PNG } from './helpers/boot.js';
import { startS3Mock } from './helpers/s3mock.js';

const run = promisify(execFile);
let oldS3; let t; let a; let oldUri; let oldConn; let newName;
const OID = () => new mongoose.Types.ObjectId();
const node = (script, args = [], env = {}) => run('node', [script, ...args], { env: { ...process.env, ...env }, cwd: process.cwd() }).then((r) => r.stdout, (e) => { throw new Error(`${script} gagal: ${e.stdout}\n${e.stderr}`); });

before(async () => {
  t = await boot();
  oldS3 = await startS3Mock();   // R2 LAMA tiruan (bucket "oldbkt")
  for (const k of ['products/111-aaa.png', 'products/222-bbb.png']) oldS3.store.set(`oldbkt/${k}`, { body: PNG, type: 'image/png' });
  a = await t.admin();
  newName = t.name;
  const base = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
  oldUri = `${base.replace(/\/[^/?]*(\?.*)?$/, '')}/mp_old_${randomBytes(4).toString('hex')}`;
  oldConn = await mongoose.createConnection(oldUri).asPromise();
  const cat1 = OID(); const cat2 = OID(); const p1 = OID(); const p2 = OID(); const p3 = OID(); const o1 = OID(); const o2 = OID(); const o3 = OID();
  const d = oldConn.db;
  await d.collection('categories').insertMany([{ _id: cat1, name: 'Game', sortOrder: 1, status: 'active' }, { _id: cat2, name: 'Aplikasi', sortOrder: 2, status: 'inactive' }]);
  await d.collection('products').insertMany([
    { _id: p1, name: 'Game A', categoryId: cat1, price: 50000, stock: 7, sold: 12, status: 'active', description: 'DESKRIPSI LAMA', shortDescription: 'Ringkas lama', imageKey: 'products/111-aaa.png', image: `${oldS3.url}/oldbkt/products/111-aaa.png`, additionalImages: [{ key: 'products/222-bbb.png', url: `${oldS3.url}/oldbkt/products/222-bbb.png` }, { key: 'products/hilang.png', url: `${oldS3.url}/oldbkt/products/hilang.png` }] },
    { _id: p2, name: 'App B', categoryId: cat2, price: 25000, stock: 0, sold: 3, status: 'inactive' },
    { _id: p3, name: 'Game C', categoryId: OID(), price: 1, stock: 1, sold: 0, status: 'active' },   // kategori hilang -> dilewati
  ]);
  await d.collection('orders').insertMany([
    { _id: o1, orderCode: 'ORD-20260101-AAAAAA', customer: { name: 'Budi', email: 'Budi@Mail.com', whatsapp: '6281234567890' }, product: { productId: p1, name: 'Game A', price: 50000, category: 'Game' }, quantity: 1, total: 50000, status: 'COMPLETED', paymentStatus: 'SUCCESS', createdAt: new Date('2026-01-01T10:00:00Z'), updatedAt: new Date('2026-01-01T10:05:00Z') },
    { _id: o2, orderCode: 'ORD-20260102-BBBBBB', customer: { name: '', email: 'siti@mail.com', whatsapp: '081211112222' }, product: { productId: p2, name: 'App B', price: 25000, category: 'Aplikasi' }, quantity: 2, total: 50000, status: 'PENDING', paymentStatus: 'PENDING', createdAt: new Date('2026-01-02T10:00:00Z') },
    { _id: o3, orderCode: 'ORD-20260103-CCCCCC', customer: { name: 'Ani', email: 'ani@mail.com', whatsapp: '6285500000000' }, product: { productId: OID(), name: 'Produk Terhapus' }, quantity: 1, total: 10000, status: 'PAID', paymentStatus: 'SUCCESS' },
  ]);
  const o4 = OID(); const o5 = OID();
  await d.collection('orders').insertMany([
    { _id: o4, orderCode: 'ORD-20260104-DDDDDD', customer: { name: 'Eko', email: 'eko@mail.com', whatsapp: '6281399990000' }, product: { productId: p1, name: 'Game A', price: 50000, category: 'Game' }, quantity: 1, total: 50000, status: 'FAILED', paymentStatus: 'FAILED', createdAt: new Date('2026-01-04T10:00:00Z') },
    { _id: o5, orderCode: 'ORD-20260105-EEEEEE', customer: { email: '', whatsapp: '' }, product: { productId: p1, name: 'Game A', price: 50000 }, quantity: 2, total: 100000, status: 'EXPIRED', paymentStatus: 'EXPIRED', createdAt: new Date('2026-01-05T10:00:00Z') },
  ]);
  await d.collection('transactions').insertOne({ transactionId: 'ORD-20260101-AAAAAA', orderId: o1, environment: 'sandbox', amount: 50000, totalAmount: 50016, status: 'SUCCESS', paidAt: new Date('2026-01-01T10:04:00Z') });
  await d.collection('customers').insertMany([{ email: 'budi@mail.com', whatsapp: '6281234567890' }, { email: 'siti@mail.com', whatsapp: '6281211112222' }]);
  await d.collection('ratings').insertMany([
    { user: 'Budi', rating: 5, review: 'Mantap', productId: p1, status: 'approved', createdAt: new Date('2026-01-03T00:00:00Z') },
    { user: 'Siti', rating: 4, review: 'Baru masuk', productId: p1, status: 'pending' },
    { user: 'Umum', rating: 5, review: 'Tanpa produk', status: 'approved' },
    { user: 'Dewi', rating: 3, review: 'Produknya dilewati', productId: p3, status: 'approved' },   // produk dilewati → tetap jadi ulasan umum
  ]);
});
after(async () => { await oldConn.dropDatabase(); await oldConn.close(); await oldS3.close(); await t.stop(); });

const env = () => ({ OLD_MONGODB_URI: oldUri, MONGODB_URI: process.env.MONGODB_URI, OLD_R2_ENDPOINT: oldS3.url, OLD_R2_FORCE_PATH_STYLE: 'true', OLD_R2_ACCESS_KEY_ID: 'AKIAOLD', OLD_R2_SECRET_ACCESS_KEY: 'OLD-SECRET', OLD_R2_BUCKET_NAME: 'oldbkt' });
const counts = async () => ({
  products: (await a.get('/products?limit=100')).body.items.length,
  orders: (await a.get('/orders?limit=100')).body.total,
  reviews: (await a.get('/reviews?limit=100')).body.total,
});

test('dry-run tidak menulis apa pun', async () => {
  const out = await node('scripts/migrate-from-old.js', [], env());
  assert.match(out, /DRY-RUN/);
  assert.match(out, /ditemukan di R2 lama\s+2/); assert.match(out, /hilang\.png/);
  assert.deepEqual(await counts(), { products: 0, orders: 0, reviews: 0 });
});

test('apply: kategori, produk (harga/stok/terjual), pesanan+pembeli, rating; produk tanpa kategori dilewati', async () => {
  const out = await node('scripts/migrate-from-old.js', ['--apply'], env());
  assert.match(out, /MIGRASI SELESAI/);
  const prods = (await a.get('/products?limit=100')).body.items;
  assert.equal(prods.length, 2);
  const g = prods.find((p) => p.name === 'Game A');
  assert.equal(g.price, 50000); assert.equal(g.stock, 7); assert.equal(g.sold, 12); assert.equal(g.active, true);
  assert.equal(g.description, 'Ringkas lama'); assert.equal(g.about, 'DESKRIPSI LAMA');
  assert.equal(g.media.length, 2, 'gambar utama + tambahan (yang hilang dilaporkan, bukan menggagalkan)');
  for (const m of g.media) { assert.ok(m.key.startsWith('products/legacy/') && t.inBucket(m.key)); assert.ok(t.s3.store.get(`bkt/${m.key}`).body.equals(PNG)); }
  assert.equal(prods.find((p) => p.name === 'App B').sold, 3, 'terjual lama dipertahankan walau tanpa pesanan sukses');
  assert.equal(prods.find((p) => p.name === 'App B').active, false);

  const orders = (await a.get('/orders?limit=100')).body.items;
  assert.equal(orders.length, 5, 'SEMUA pesanan diimpor (sukses, gagal, kedaluwarsa; produk terhapus tetap ikut lewat snapshot nama)');
  const o3 = orders.find((o) => o.orderNo === 'ORD-20260103-CCCCCC');
  assert.equal(o3.status, 'SUCCESS'); assert.equal(o3.product.name, 'Produk Terhapus');
  const o1 = orders.find((o) => o.orderNo === 'ORD-20260101-AAAAAA');
  assert.equal(o1.status, 'SUCCESS'); assert.equal(o1.customer.email, 'budi@mail.com'); assert.equal(o1.mode, 'sandbox'); assert.equal(o1.totalAmount, 50016);
  assert.equal(orders.find((o) => o.orderNo === 'ORD-20260102-BBBBBB').status, 'EXPIRED', 'PENDING lama diimpor sebagai EXPIRED');
  assert.equal(orders.find((o) => o.orderNo === 'ORD-20260104-DDDDDD').status, 'FAILED');
  const o5 = orders.find((o) => o.orderNo === 'ORD-20260105-EEEEEE');
  assert.equal(o5.status, 'EXPIRED'); assert.equal(o5.customer.email, 'tanpa-email@import.invalid', 'data kosong diberi nilai pengganti, pesanan tidak dilewati');
  assert.match(out, /Database di cluster lama/);

  const reviews = (await a.get('/reviews?limit=100')).body.items;
  assert.equal(reviews.length, 4, 'semua rating diimpor; tanpa produk / produk dilewati = ulasan umum');
  assert.equal(reviews.find((r) => r.text === 'Produknya dilewati').status, 'published');
  assert.equal(reviews.find((r) => r.text === 'Mantap').status, 'published');
  assert.equal(reviews.find((r) => r.text === 'Baru masuk').status, 'hidden');
});

test('tanpa efek samping: stok tetap, tidak ada notifikasi, jalan ulang tidak membuat dobel', async () => {
  await new Promise((r) => setTimeout(r, 6000));   // beri worker pembayaran kesempatan memproses (seharusnya tidak ada yang PENDING)
  assert.equal((await a.get('/notifications')).body.total, 0);
  const before = await counts();
  const puts = () => t.s3.log.filter((l) => l.startsWith('PUT bkt/products/legacy/')).length; const p0 = puts();
  await node('scripts/migrate-from-old.js', ['--apply'], env());
  assert.deepEqual(await counts(), before); assert.equal(puts(), p0, 'gambar tidak diunggah ulang');
  const g = (await a.get('/products?limit=100')).body.items.find((p) => p.name === 'Game A');
  assert.equal(g.stock, 7);
});

test('reset-data: dry-run tidak menghapus; apply butuh konfirmasi nama DB, menghapus data+gambar, admin & pengaturan tetap', async () => {
  const up = await a.upload();
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const key = up.body.item?.key || up.body.key;
  assert.ok(key && t.inBucket(key));

  const dry = await node('scripts/reset-data.js');
  assert.match(dry, /DRY-RUN/);
  assert.ok((await counts()).products > 0);

  await assert.rejects(node('scripts/reset-data.js', ['--apply', '--yes=salah']), /Konfirmasi tidak cocok/);
  assert.ok((await counts()).products > 0, 'konfirmasi salah = tidak ada yang dihapus');

  await node('scripts/reset-data.js', ['--apply', `--yes=${newName}`]);
  assert.deepEqual(await counts(), { products: 0, orders: 0, reviews: 0 });
  assert.equal(t.inBucket(key), false, 'gambar ikut terhapus dari R2');
  assert.equal((await a.get('/payment-settings')).status, 200, 'admin masih bisa login & pengaturan tetap ada');
});
