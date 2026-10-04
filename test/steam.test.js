// Tes integrasi Steam: server nyata + MongoDB + R2 tiruan. fetch ke Steam diganti stub; fetch lain (127.0.0.1) diteruskan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, PNG } from './helpers/boot.js';

let t; let a;
const realFetch = globalThis.fetch;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
const REQ = '<ul><li><strong>OS:</strong> Windows 10</li><li><strong>Memory:</strong> 8 GB RAM</li></ul>';
let appdetails;
let steamCalls = 0;

before(async () => {
  t = await boot(); a = await t.admin();
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://store.steampowered.com/')) { steamCalls++; return new Response(JSON.stringify(appdetails), { status: 200 }); }
    if (u.endsWith('.jpg')) return new Response(PNG, { status: 200, headers: { 'content-length': String(PNG.length) } });
    if (u.endsWith('480.mp4')) return new Response(MP4, { status: 200 });
    if (u.endsWith('big.mp4')) return new Response(Buffer.alloc(31 * 1048576), { status: 200 });
    return realFetch(url, opts);
  };
});
after(async () => { globalThis.fetch = realFetch; await t.stop(); });

const data = (over = {}) => ({ 7: { success: true, data: {
  name: 'Game Uji', short_description: 'Ringkas', about_the_game: '<p>Panjang</p>',
  header_image: 'https://shared.akamai.steamstatic.com/a/header.jpg',
  pc_requirements: { minimum: REQ, recommended: REQ },
  movies: [{ name: 'Trailer', highlight: true, mp4: { 480: 'https://video.akamai.steamstatic.com/a/480.mp4' } }],
  ...over,
} } });

test('steam: endpoint hanya untuk admin', async () => {
  assert.equal((await t.req('/api/admin/steam/7')).status, 401);
  assert.equal((await t.req('/api/admin/steam/7/video', { method: 'POST', body: {} })).status, 401);
});

test('steam: App ID tidak valid -> 422/404 dengan pesan yang jelas', async () => {
  const bad = await a.get('/steam/abc');
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.message, 'Steam App ID tidak valid.');
  appdetails = { 8: { success: false } };
  const missing = await a.get('/steam/8');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.message, 'Steam App ID tidak valid.');
});

test('steam: valid -> gambar disalin ke R2 sebagai aset temp, lalu produk bisa disimpan dengan gambar & video tersebut', async () => {
  appdetails = data();
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const it = r.body.item;
  assert.equal(it.name, 'Game Uji');
  assert.equal(it.specs.min.length, 2);
  assert.ok(it.image.key.startsWith('products/'));
  assert.ok(t.inBucket(it.image.key), 'gambar ada di R2');

  const again = await a.get('/steam/7');
  assert.equal(again.body.item.image.key, it.image.key, 'Search berulang memakai aset temp yang sama');
  assert.equal(steamCalls, 1, 'lookup ke Steam di-cache');

  const v = await a.post('/steam/7/video');
  assert.equal(v.status, 200);
  assert.equal(v.body.video.type, 'video');
  assert.ok(t.inBucket(v.body.video.key));

  const cat = (await a.post('/categories', { name: 'Steam' })).body.item;
  const saved = await a.post('/products', {
    name: it.name, category: cat.id, price: 1000, stock: 1, description: it.description, about: it.about, specs: it.specs,
    media: [{ key: it.image.key }, { key: v.body.video.key }],
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.item.media.map((m) => m.type), ['image', 'video']);
  const pub = await t.req(`/api/public/products/${saved.body.item.productId}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.specs?.min?.length ?? pub.body.item?.specs?.min?.length, 2);
});

test('steam: video terlalu besar / tidak ada -> 200 dengan pesan "upload manual", bukan error', async () => {
  appdetails = data({ movies: [{ name: 'Besar', mp4: { 480: 'https://video.akamai.steamstatic.com/a/big.mp4' } }] });
  const big = await a.post('/steam/7/video');
  assert.equal(big.status, 200);
  assert.equal(big.body.video, null);
  assert.match(big.body.message, /Video tidak tersedia, silakan upload manual/);
});
