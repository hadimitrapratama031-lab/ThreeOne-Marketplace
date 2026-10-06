import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { boot } from './helpers/boot.js';

const run = promisify(execFile);
let t; let a; let oldUri; let oldConn; let newName;
const OID = () => new mongoose.Types.ObjectId();
const node = (script, args = [], env = {}) => run('node', [script, ...args], { env: { ...process.env, ...env }, cwd: process.cwd() }).then((r) => r.stdout, (e) => { throw new Error(`${script} gagal: ${e.stdout}\n${e.stderr}`); });

before(async () => {
  t = await boot();
  a = await t.admin();
  newName = t.name;
  const base = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
  oldUri = `${base.replace(/\/[^/?]*(\?.*)?$/, '')}/mp_old_${randomBytes(4).toString('hex')}`;
  oldConn = await mongoose.createConnection(oldUri).asPromise();
  const cat1 = OID(); const cat2 = OID(); const p1 = OID(); const p2 = OID(); const p3 = OID(); const o1 = OID(); const o2 = OID(); const o3 = OID();
  const d = oldConn.db;
  await d.collection('categories').insertMany([{ _id: cat1, name: 'Game', sortOrder: 1, status: 'active' }, { _id: cat2, name: 'Aplikasi', sortOrder: 2, status: 'inactive' }]);
  await d.collection('products').insertMany([
    { _id: p1, name: 'Game A', categoryId: cat1, price: 50000, stock: 7, sold: 12, status: 'active', description: 'DESKRIPSI LAMA' },
    { _id: p2, name: 'App B', categoryId: cat2, price: 25000, stock: 0, sold: 3, status: 'inactive' },
    { _id: p3, name: 'Game C', categoryId: OID(), price: 1, stock: 1, sold: 0, status: 'active' },   // kategori hilang -> dilewati
  ]);
  await d.collection('orders').insertMany([
    { _id: o1, orderCode: 'ORD-20260101-AAAAAA', customer: { name: 'Budi', email: 'Budi@Mail.com', whatsapp: '6281234567890' }, product: { productId: p1, name: 'Game A', price: 50000, category: 'Game' }, quantity: 1, total: 50000, status: 'COMPLETED', paymentStatus: 'SUCCESS', createdAt: new Date('2026-01-01T10:00:00Z'), updatedAt: new Date('2026-01-01T10:05:00Z') },
    { _id: o2, orderCode: 'ORD-20260102-BBBBBB', customer: { name: '', email: 'siti@mail.com', whatsapp: '081211112222' }, product: { productId: p2, name: 'App B', price: 25000, category: 'Aplikasi' }, quantity: 2, total: 50000, status: 'PENDING', paymentStatus: 'PENDING', createdAt: new Date('2026-01-02T10:00:00Z') },
    { _id: o3, orderCode: 'ORD-20260103-CCCCCC', customer: { name: 'Ani', email: 'ani@mail.com', whatsapp: '6285500000000' }, product: { productId: OID(), name: 'Produk Terhapus' }, quantity: 1, total: 10000, status: 'PAID', paymentStatus: 'SUCCESS' },
  ]);
  await d.collection('transactions').insertOne({ transactionId: 'ORD-20260101-AAAAAA', orderId: o1, environment: 'sandbox', amount: 50000, totalAmount: 50016, status: 'SUCCESS', paidAt: new Date('2026-01-01T10:04:00Z') });
  await d.collection('customers').insertMany([{ email: 'budi@mail.com', whatsapp: '6281234567890' }, { email: 'siti@mail.com', whatsapp: '6281211112222' }]);
  await d.collection('ratings').insertMany([
    { user: 'Budi', rating: 5, review: 'Mantap', productId: p1, status: 'approved', createdAt: new Date('2026-01-03T00:00:00Z') },
    { user: 'Siti', rating: 4, review: 'Baru masuk', productId: p1, status: 'pending' },
    { user: 'Umum', rating: 5, review: 'Tanpa produk', status: 'approved' },
  ]);
});
after(async () => { await oldConn.dropDatabase(); await oldConn.close(); await t.stop(); });

const env = () => ({ OLD_MONGODB_URI: oldUri, MONGODB_URI: process.env.MONGODB_URI });
const counts = async () => ({
  products: (await a.get('/products?limit=100')).body.items.length,
  orders: (await a.get('/orders?limit=100')).body.total,
  reviews: (await a.get('/reviews?limit=100')).body.total,
});

test('dry-run tidak menulis apa pun', async () => {
  const out = await node('scripts/migrate-from-old.js', [], env());
  assert.match(out, /DRY-RUN/);
  assert.deepEqual(await counts(), { products: 0, orders: 0, reviews: 0 });
});

test('apply: kategori, produk (harga/stok/terjual), pesanan+pembeli, rating; produk tanpa kategori dilewati', async () => {
  const out = await node('scripts/migrate-from-old.js', ['--apply'], env());
  assert.match(out, /MIGRASI SELESAI/);
  const prods = (await a.get('/products?limit=100')).body.items;
  assert.equal(prods.length, 2);
  const g = prods.find((p) => p.name === 'Game A');
  assert.equal(g.price, 50000); assert.equal(g.stock, 7); assert.equal(g.sold, 12); assert.equal(g.active, true);
  assert.equal(g.description, '', 'deskripsi TIDAK diambil dari project lama');
  assert.equal(prods.find((p) => p.name === 'App B').active, false);

  const orders = (await a.get('/orders?limit=100')).body.items;
  assert.equal(orders.length, 2, 'pesanan dengan produk terhapus dilewati');
  const o1 = orders.find((o) => o.orderNo === 'ORD-20260101-AAAAAA');
  assert.equal(o1.status, 'SUCCESS'); assert.equal(o1.customer.email, 'budi@mail.com'); assert.equal(o1.mode, 'sandbox'); assert.equal(o1.totalAmount, 50016);
  const o2 = orders.find((o) => o.orderNo === 'ORD-20260102-BBBBBB');
  assert.equal(o2.status, 'EXPIRED', 'PENDING lama tidak pernah menjadi PENDING');
  assert.equal(o2.customer.whatsapp, '6281211112222'); assert.equal(o2.customer.name, 'Pelanggan');

  const reviews = (await a.get('/reviews?limit=100')).body.items;
  assert.equal(reviews.length, 2, 'rating tanpa produk dilewati');
  assert.equal(reviews.find((r) => r.text === 'Mantap').status, 'published');
  assert.equal(reviews.find((r) => r.text === 'Baru masuk').status, 'hidden');
});

test('tanpa efek samping: stok tetap, tidak ada notifikasi, jalan ulang tidak membuat dobel', async () => {
  await new Promise((r) => setTimeout(r, 6000));   // beri worker pembayaran kesempatan memproses (seharusnya tidak ada yang PENDING)
  assert.equal((await a.get('/notifications')).body.total, 0);
  const before = await counts();
  await node('scripts/migrate-from-old.js', ['--apply'], env());
  assert.deepEqual(await counts(), before);
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
