// Tes integrasi Steam: server nyata + MongoDB + R2 tiruan. fetch ke Steam diganti stub; fetch lain (127.0.0.1) diteruskan.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, PNG } from './helpers/boot.js';

let t; let a; let clearSteamCache;
const realFetch = globalThis.fetch;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
const REQ = '<ul><li><strong>OS:</strong> Windows 10</li><li><strong>Memory:</strong> 8 GB RAM</li></ul>';
let appdetails;
let steamCalls = 0;
const failUrls = new Set();   // URL CDN yang dibuat gagal (404) pada tes tertentu

before(async () => {
  t = await boot(); a = await t.admin();
  ({ clearSteamCache } = await import('../server/services/steam.js'));   // modul yang sama dengan server; diimpor SETELAH boot agar config R2 terbaca
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://store.steampowered.com/')) { steamCalls++; return new Response(JSON.stringify(appdetails), { status: 200 }); }
    if (failUrls.has(u.split('?')[0])) return new Response('nope', { status: 404 });
    if (new URL(u).pathname.endsWith('.jpg')) return new Response(PNG, { status: 200, headers: { 'content-length': String(PNG.length) } });
    if (u.endsWith('480.mp4')) return new Response(MP4, { status: 200 });
    if (u.endsWith('big.mp4')) return new Response(Buffer.alloc(31 * 1048576), { status: 200 });
    return realFetch(url, opts);
  };
});
after(async () => { globalThis.fetch = realFetch; await t.stop(); });
beforeEach(() => { clearSteamCache(); steamCalls = 0; failUrls.clear(); });   // cache lookup 10 menit di server membuat tes saling bocor bila tidak dibersihkan

const data = (over = {}) => ({ 7: { success: true, data: {
  name: 'Game Uji', short_description: 'Ringkas', about_the_game: '<p>Panjang</p>',
  header_image: 'https://shared.akamai.steamstatic.com/a/header.jpg',
  pc_requirements: { minimum: REQ, recommended: REQ },
  developers: ['Studio Uji'], publishers: ['Penerbit Uji'], release_date: { coming_soon: false, date: '10 Jul, 2020' },
  genres: [{ id: '1', description: 'Action' }], metacritic: { score: 87, url: 'https://www.metacritic.com/game/x' },
  screenshots: Array.from({ length: 8 }, (_, i) => ({ id: i, path_thumbnail: `https://shared.akamai.steamstatic.com/s/${i}.600x338.jpg`, path_full: `https://shared.akamai.steamstatic.com/s/${i}.1920x1080.jpg?t=1` })),
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

  // ROOT CAUSE sebelumnya: hanya header_image yang dibaca. Sekarang screenshot ikut masuk (maks slot galeri - 1 = 5).
  assert.equal(it.screenshotsAvailable, 8);
  assert.equal(it.screenshots.length, 5, 'hero + 5 screenshot memenuhi 6 slot galeri');
  const shotKeys = it.screenshots.map((x) => x.key);
  assert.equal(new Set([it.image.key, ...shotKeys]).size, 6, 'semua key unik');
  for (const k of shotKeys) assert.ok(t.inBucket(k), 'screenshot ada di R2: ' + k);
  assert.deepEqual([it.info.developer, it.info.publisher, it.info.releaseDate, it.info.metacritic], ['Studio Uji', 'Penerbit Uji', '10 Jul, 2020', 87]);
  assert.deepEqual(it.info.genres, ['Action']);

  const again = await a.get('/steam/7');
  assert.equal(again.body.item.image.key, it.image.key, 'Search berulang memakai aset temp yang sama');
  assert.deepEqual(again.body.item.screenshots.map((x) => x.key), shotKeys, 'screenshot juga tidak diunggah ganda');
  assert.equal(steamCalls, 1, 'lookup ke Steam di-cache');

  const v = await a.post('/steam/7/video');
  assert.equal(v.status, 200);
  assert.equal(v.body.video.type, 'video');
  assert.ok(t.inBucket(v.body.video.key));

  const cat = (await a.post('/categories', { name: 'Steam' })).body.item;
  const saved = await a.post('/products', {
    name: it.name, category: cat.id, price: 1000, stock: 1, description: it.description, about: it.about, specs: it.specs,
    gameInfo: { steamAppId: it.appId, developer: it.info.developer, publisher: it.info.publisher, releaseDate: it.info.releaseDate, genres: it.info.genres, metacritic: it.info.metacritic },
    media: [{ key: it.image.key }, ...shotKeys.slice(0, 4).map((key) => ({ key })), { key: v.body.video.key }],   // hero + 4 screenshot + video = 6
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.item.media.map((m) => m.type), ['image', 'image', 'image', 'image', 'image', 'video']);
  assert.equal(saved.body.item.gameInfo.developer, 'Studio Uji');

  // "Refresh": data dibaca ulang dari MongoDB (bukan dari respons simpan) -> media & info tetap utuh
  const reread = (await a.get(`/products/${saved.body.item.id}`)).body.item;
  assert.deepEqual(reread.media.map((m) => m.key), saved.body.item.media.map((m) => m.key));
  assert.deepEqual(reread.gameInfo, { steamAppId: '7', developer: 'Studio Uji', publisher: 'Penerbit Uji', releaseDate: '10 Jul, 2020', genres: ['Action'], metacritic: 87 });
  const { Asset } = await import('../server/models/index.js');
  for (const k of [it.image.key, ...shotKeys.slice(0, 4), v.body.video.key]) {
    const rec = await Asset.findOne({ key: k }).lean();
    assert.equal(rec.status, 'used', `${k} milik produk setelah Simpan`);
    assert.equal(rec.owner.id, saved.body.item.id);
  }
  assert.equal((await Asset.findOne({ key: shotKeys[4] }).lean()).status, 'temp', 'screenshot yang tidak dipilih tetap temp (dibersihkan sweeper)');
  const pubMedia = (await t.req(`/api/public/products/${saved.body.item.productId}`)).body;
  assert.deepEqual(pubMedia.product.media.map((m) => m.type), ['image', 'image', 'image', 'image', 'image', 'video'], 'Marketplace menerima seluruh galeri');
  const pub = await t.req(`/api/public/products/${saved.body.item.productId}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.product.specs.min.length, 2);
});

test('steam: video terlalu besar / tidak ada -> 200 dengan pesan "upload manual", bukan error', async () => {
  appdetails = data({ movies: [{ name: 'Besar', mp4: { 480: 'https://video.akamai.steamstatic.com/a/big.mp4' } }] });
  const big = await a.post('/steam/7/video');
  assert.equal(big.status, 200);
  assert.equal(big.body.video, null);
  assert.match(big.body.message, /Video tidak tersedia, silakan upload manual/);
});

test('steam: satu screenshot gagal diunduh -> digantikan kandidat berikutnya, warning, bukan error', async () => {
  appdetails = data();
  failUrls.add('https://shared.akamai.steamstatic.com/s/1.1920x1080.jpg');
  failUrls.add('https://shared.akamai.steamstatic.com/s/1.600x338.jpg');   // thumbnail cadangan juga gagal
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200);
  assert.equal(r.body.item.screenshots.length, 5, 'tetap 5: kandidat ke-6 menggantikan yang gagal');
  const w = r.body.item.warnings.find((x) => x.field === 'screenshots');
  assert.match(w.message, /1 screenshot gagal/);
});

test('steam: full gagal tetapi thumbnail tersedia -> thumbnail dipakai sebagai cadangan', async () => {
  appdetails = data();
  failUrls.add('https://shared.akamai.steamstatic.com/s/0.1920x1080.jpg');
  const r = await a.get('/steam/7');
  assert.equal(r.body.item.screenshots.length, 5);
  assert.ok(!r.body.item.warnings.some((x) => x.field === 'screenshots'));
});

test('steam: semua screenshot gagal -> gambar utama & metadata tetap terisi', async () => {
  appdetails = data();
  for (let i = 0; i < 8; i++) { failUrls.add(`https://shared.akamai.steamstatic.com/s/${i}.1920x1080.jpg`); failUrls.add(`https://shared.akamai.steamstatic.com/s/${i}.600x338.jpg`); }
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200);
  assert.ok(r.body.item.image);
  assert.deepEqual(r.body.item.screenshots, []);
  assert.equal(r.body.item.name, 'Game Uji');
  assert.ok(r.body.item.warnings.some((x) => x.field === 'screenshots' && /semuanya gagal/.test(x.message)));
});

test('steam: tanpa screenshot/video/metacritic -> sisanya tetap terisi, field kosong dibiarkan kosong', async () => {
  appdetails = data({ screenshots: undefined, movies: undefined, metacritic: undefined });
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200);
  const it = r.body.item;
  assert.ok(it.image);
  assert.deepEqual(it.screenshots, []);
  assert.equal(it.video.available, false);
  assert.equal(it.info.metacritic, null);
  assert.equal(it.info.developer, 'Studio Uji');
  assert.ok(it.warnings.some((x) => x.field === 'screenshots'));
  assert.ok(!it.warnings.some((x) => x.field === 'metacritic'));
});

test('steam: genre dicocokkan ke kategori toko yang aktif; tidak ada yang cocok -> null (tidak membuat kategori baru)', async () => {
  appdetails = data({ genres: [{ id: '3', description: 'RPG' }, { id: '1', description: 'Action' }] });
  const before = (await a.get('/categories')).body.items.length;
  assert.equal((await a.get('/steam/7')).body.item.categoryMatch, null);
  assert.equal((await a.get('/categories')).body.items.length, before, 'kategori tidak dibuat otomatis');

  const rpg = (await a.post('/categories', { name: 'rpg', active: false })).body.item;
  const action = (await a.post('/categories', { name: 'ACTION' })).body.item;
  clearSteamCache();
  const m = (await a.get('/steam/7')).body.item.categoryMatch;
  assert.equal(m.id, action.id, 'RPG nonaktif dilewati, Action (beda huruf besar) cocok');
  assert.equal(m.via, 'Action');
  assert.notEqual(m.id, rpg.id);
});

test('produk: batas galeri tetap 6 file di server, info game divalidasi', async () => {
  const cat = (await a.post('/categories', { name: 'Batas' })).body.item;
  const keys = [];
  for (let i = 0; i < 7; i++) keys.push((await a.upload()).body.asset.key);
  const base = { name: 'Batas Galeri', category: cat.id, price: 1000, stock: 1 };
  const over = await a.post('/products', { ...base, media: keys.map((key) => ({ key })) });
  assert.equal(over.status, 422);
  const ok = await a.post('/products', { ...base, media: keys.slice(0, 6).map((key) => ({ key })) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.item.media.length, 6);
  assert.deepEqual(ok.body.item.gameInfo, { steamAppId: '', developer: '', publisher: '', releaseDate: '', genres: [], metacritic: null }, 'produk manual: info game kosong');
  const bad = await a.post('/products', { ...base, gameInfo: { metacritic: 150, steamAppId: 'abc' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.details?.fields?.['gameInfo.metacritic'] ?? bad.body.error.fields?.['gameInfo.metacritic']);
});
