import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { boot, PNG } from './helpers/boot.js';
let t; let a; let sweepAssets; let Asset;
// Modul server dimuat SETELAH boot() mengisi env (config dibaca saat impor)
before(async () => {
  t = await boot({ seed: true });
  a = await t.admin();
  ({ sweepAssets } = await import('../server/services/assets.js'));
  ({ Asset } = await import('../server/models/index.js'));
});
after(async () => { await t.stop(); });

test('seed: data awal dari prototype masuk database dan tidak digandakan saat restart', async () => {
  const before = (await a.get('/products?limit=100')).body;
  assert.equal(before.total, 12);
  assert.equal((await t.req('/api/public/bootstrap')).body.faq.length, 5);
  await t.restart();
  a = await t.admin();
  assert.equal((await a.get('/products?limit=100')).body.total, 12, 'SEED_DEMO tidak menggandakan data');
});

test('persistensi: data dan gambar tetap ada setelah server restart', async () => {
  const cat = (await a.get('/categories')).body.items[0];
  const img = (await a.upload()).body.asset;
  const p = (await a.post('/products', { name: 'Tahan Restart', category: cat.id, price: 777, stock: 3, media: [{ key: img.key }] })).body.item;
  await a.put('/settings/stats', { support: 'Senin-Jumat' });
  await t.restart();
  a = await t.admin();
  const got = (await a.get(`/products/${p.id}`)).body.item;
  assert.equal(got.name, 'Tahan Restart');
  assert.equal(got.media[0].key, img.key);
  assert.equal((await t.req('/api/public/bootstrap')).body.settings.stats.support, 'Senin-Jumat');
  assert.equal((await fetch(got.media[0].url)).status, 200, 'gambar tetap bisa diakses di URL publik');
  // id produk berikutnya melanjutkan, tidak mengulang
  const next = (await a.post('/products', { name: 'Berikutnya', category: cat.id, price: 1, stock: 1 })).body.item;
  assert.ok(next.productId > got.productId);
});

test('indeks MongoDB terpasang sesuai desain', async () => {
  const db = mongoose.connection.db;
  const idx = async (c) => (await db.collection(c).indexes()).map((i) => ({ key: Object.keys(i.key).join(','), unique: !!i.unique }));
  const has = (list, key, unique) => list.some((i) => i.key === key && (unique === undefined || i.unique === unique));

  const products = await idx('products');
  assert.ok(has(products, 'productId', true), 'products.productId unik');
  for (const k of ['active,category', 'category', 'createdAt', 'updatedAt', 'name', 'price', 'stock']) assert.ok(has(products, k), `products.${k}`);
  assert.ok(has(await idx('categories'), 'nameKey', true));
  assert.ok(has(await idx('admins'), 'email', true));
  assert.ok(has(await idx('assets'), 'key', true));
  assert.ok(has(await idx('settings'), 'key', true));
  const reviews = await idx('reviews');
  for (const k of ['product,status,date', 'status,date', 'productId']) assert.ok(has(reviews, k), `reviews.${k}`);
  assert.ok(has(await idx('faqs'), 'order'));
  assert.ok(has(await idx('contacts'), 'order'));
});

test('pembersihan: upload yang tak pernah disimpan dibuang dari R2 oleh sweeper', async () => {
  const stray = (await a.upload()).body.asset;
  assert.ok(t.inBucket(stray.key));
  assert.equal(await sweepAssets({ tempMaxAgeMs: 24 * 3600 * 1000 }), 0, 'upload baru belum disentuh');
  assert.ok(t.inBucket(stray.key));
  assert.ok((await sweepAssets({ tempMaxAgeMs: -1 })) >= 1);
  assert.equal(t.inBucket(stray.key), false);
  assert.equal(await Asset.countDocuments({ key: stray.key }), 0);
});

test('hapus aman: jika R2 gagal menghapus, data tetap terhapus dan file ditandai orphan lalu dibersihkan', async () => {
  const cat = (await a.get('/categories')).body.items[0];
  const img = (await a.upload()).body.asset;
  const p = (await a.post('/products', { name: 'Hapus R2 gagal', category: cat.id, price: 1, stock: 1, media: [{ key: img.key }] })).body.item;
  t.s3.fail.delete = true;
  const del = await a.del(`/products/${p.id}`);
  t.s3.fail.delete = false;
  assert.equal(del.status, 200, 'API tidak gagal hanya karena penghapusan file gagal');
  assert.equal((await a.get(`/products/${p.id}`)).status, 404);
  assert.ok(t.inBucket(img.key), 'file masih ada di R2');
  assert.equal((await Asset.findOne({ key: img.key })).status, 'orphan');
  await sweepAssets();
  assert.equal(t.inBucket(img.key), false, 'sweeper mencoba lagi dan berhasil');
});
