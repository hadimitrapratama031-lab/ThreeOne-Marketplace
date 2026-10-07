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
let cdnLog = [];              // semua fetch ke CDN Steam: { method, url }

before(async () => {
  t = await boot(); a = await t.admin();
  ({ clearSteamCache } = await import('../server/services/steam.js'));   // modul yang sama dengan server; diimpor SETELAH boot agar config R2 terbaca
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://store.steampowered.com/')) { steamCalls++; return new Response(JSON.stringify(appdetails), { status: 200 }); }
    if (/steamstatic\.com|akamaihd\.net/.test(new URL(u).hostname)) {
      cdnLog.push({ method: opts?.method || 'GET', url: u });
      if (failUrls.has(u.split('?')[0])) return new Response('nope', { status: 404 });
      if (opts?.method === 'HEAD') return new Response('', { status: 200, headers: { 'content-type': 'video/mp4' } });
      if (new URL(u).pathname.endsWith('.jpg')) return new Response(PNG, { status: 200, headers: { 'content-length': String(PNG.length) } });
      return new Response(MP4, { status: 200 });
    }
    return realFetch(url, opts);
  };
});
after(async () => { globalThis.fetch = realFetch; await t.stop(); });
beforeEach(() => { clearSteamCache(); steamCalls = 0; failUrls.clear(); cdnLog = []; });   // cache lookup 10 menit di server membuat tes saling bocor bila tidak dibersihkan

// Hanya gambar utama (header) yang boleh diunduh dari CDN Steam; screenshot & video Steam tidak boleh diunduh sama sekali.
const downloadedExceptHero = () => cdnLog.filter((c) => c.method === 'GET' && !/\/header\.jpg/.test(c.url));

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

test('steam: endpoint unduh video sudah tidak ada (video Steam tidak pernah diunduh ke server)', async () => {
  appdetails = data();
  const r = await a.post('/steam/7/video', { movie: 0 });
  assert.equal(r.status, 404);
  assert.equal(downloadedExceptHero().length, 0);
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

test('steam: valid -> screenshot & video = URL asli Steam (tanpa R2), hanya gambar utama yang disalin ke R2; produk menyimpan URL Steam', async () => {
  appdetails = data();
  const { Asset } = await import('../server/models/index.js');
  const assetsBefore = await Asset.countDocuments();
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const it = r.body.item;
  assert.equal(it.name, 'Game Uji');
  assert.equal(it.specs.min.length, 2);
  assert.ok(it.image.key.startsWith('products/'), 'gambar utama tetap mengikuti sistem lama (R2)');
  assert.ok(t.inBucket(it.image.key));

  // Screenshot: SEMUA 8, URL persis dari respons Steam (path_full), tanpa key/aset
  assert.equal(it.screenshotsAvailable, 8);
  assert.deepEqual(it.screenshots.map((x) => x.url), appdetails[7].data.screenshots.map((x) => x.path_full));
  assert.ok(it.screenshots.every((x) => x.source === 'steam' && x.type === 'image' && !x.key && !x.url.includes('31store')));
  // Video: URL asli Steam
  assert.equal(it.videos.length, 1);
  assert.equal(it.videos[0].source, 'steam');
  assert.equal(it.videos[0].url, 'https://video.akamai.steamstatic.com/a/480.mp4');
  assert.equal(it.videos[0].title, 'Trailer');
  // Tidak ada unduhan screenshot/video dan hanya 1 aset baru (gambar utama)
  assert.equal(downloadedExceptHero().length, 0, 'screenshot & video Steam tidak diunduh');
  assert.equal(await Asset.countDocuments(), assetsBefore + 1, 'hanya gambar utama yang masuk R2');
  assert.deepEqual([it.info.developer, it.info.publisher, it.info.releaseDate, it.info.metacritic], ['Studio Uji', 'Penerbit Uji', '10 Jul, 2020', 87]);

  const again = await a.get('/steam/7');
  assert.equal(again.body.item.image.key, it.image.key, 'Search berulang memakai aset temp yang sama');
  assert.equal(await Asset.countDocuments(), assetsBefore + 1);
  assert.equal(steamCalls, 1, 'lookup ke Steam di-cache');

  const cat = (await a.post('/categories', { name: 'Steam' })).body.item;
  const media = [{ key: it.image.key }, ...it.screenshots, ...it.videos];   // persis seperti yang dikirim form Admin
  const saved = await a.post('/products', {
    name: it.name, category: cat.id, price: 1000, stock: 1, description: it.description, about: it.about, specs: it.specs,
    gameInfo: { steamAppId: it.appId, developer: it.info.developer, publisher: it.info.publisher, releaseDate: it.info.releaseDate, genres: it.info.genres, metacritic: it.info.metacritic },
    media,
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.item.media.map((m) => m.type), [...Array(9).fill('image'), 'video']);
  assert.equal(await Asset.countDocuments(), assetsBefore + 1, 'menyimpan produk tidak membuat aset R2 untuk media Steam');

  // "Refresh": dibaca ulang dari MongoDB -> tetap URL Steam, bukan R2
  const reread = (await a.get(`/products/${saved.body.item.id}`)).body.item;
  assert.deepEqual(reread.media.slice(1).map((m) => m.url), [...it.screenshots.map((x) => x.url), it.videos[0].url]);
  assert.ok(reread.media.slice(1).every((m) => m.source === 'steam' && m.key === null && !m.url.includes('31store')));
  assert.equal(reread.media[0].key, it.image.key);
  assert.equal((await Asset.findOne({ key: it.image.key }).lean()).status, 'used', 'gambar utama milik produk setelah Simpan');
  const { Product } = await import('../server/models/index.js');
  const raw = await Product.findById(saved.body.item.id).lean();
  assert.ok(raw.media.slice(1).every((m) => m.source === 'steam' && /steamstatic\.com/.test(m.url)), 'MongoDB menyimpan URL Steam');
  assert.equal(raw.media[9].type, 'video');
  assert.ok(raw.media[9].sources.length >= 1);

  // Marketplace (Product Detail): URL Steam langsung + source video terstruktur
  const pub = (await t.req(`/api/public/products/${saved.body.item.productId}`)).body.product;
  assert.deepEqual(pub.media.map((m) => m.type), [...Array(9).fill('image'), 'video']);
  assert.equal(pub.media[1].url, it.screenshots[0].url);
  assert.equal(pub.media[1].source, 'steam');
  assert.equal(pub.media[9].source, 'steam');
  assert.equal(pub.media[9].url, it.videos[0].url);
  assert.deepEqual(pub.media[9].sources, [{ url: 'https://video.akamai.steamstatic.com/a/480.mp4', format: 'mp4', quality: '480' }]);
  assert.equal(pub.specs.min.length, 2);
});

// Bentuk data mengikuti appdetails Steam yang terdokumentasi: screenshots[] { id, path_thumbnail, path_full } dan
// movies[] { id, name, thumbnail, highlight, webm: { 480, max }, mp4: { 480, max } }; URL movie memakai http:// seperti contoh dokumentasi.
const manyShots = (n) => Array.from({ length: n }, (_, i) => ({ id: i, path_thumbnail: `https://shared.akamai.steamstatic.com/s/ss_${i}.600x338.jpg?t=1`, path_full: `https://shared.akamai.steamstatic.com/s/ss_${i}.1920x1080.jpg?t=1` }));
const manyMovies = (n) => Array.from({ length: n }, (_, i) => ({
  id: 81958 + i, name: `Video ${i + 1}`, thumbnail: `https://shared.akamai.steamstatic.com/t/${i}.jpg?t=1`, highlight: i === 2,
  webm: { 480: `http://video.akamai.steamstatic.com/store_trailers/${i}/movie480.webm?t=1`, max: `http://video.akamai.steamstatic.com/store_trailers/${i}/movie_max.webm?t=1` },
  mp4: { 480: `http://video.akamai.steamstatic.com/store_trailers/${i}/movie480.mp4?t=1`, max: `http://video.akamai.steamstatic.com/store_trailers/${i}/movie_max.mp4?t=1` },
}));

test('steam: game dengan BANYAK screenshot & video (12 + 8, URL movie http://) -> semuanya URL Steam, tidak ada batas, tersimpan, tampil di Marketplace', async () => {
  appdetails = data({ screenshots: manyShots(12), movies: manyMovies(8) });
  const { Asset } = await import('../server/models/index.js');
  const assetsBefore = await Asset.countDocuments();
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const it = r.body.item;
  assert.equal(it.screenshotsAvailable, 12);
  assert.equal(it.screenshots.length, 12, 'bukan hanya 1 dan bukan dipotong');
  assert.equal(it.videos.length, 8);
  assert.equal(it.videos[0].title, 'Video 3', 'trailer highlight dulu');
  assert.ok(it.videos.every((v) => v.url.startsWith('https://') && v.poster.startsWith('https://shared.akamai.steamstatic.com/t/')), 'http:// dinaikkan ke https://, thumbnail = URL Steam');
  assert.equal(new Set(it.videos.map((v) => v.ref)).size, 8, '8 video berbeda');
  assert.ok(!it.warnings.some((w) => w.field === 'video' || w.field === 'screenshots'));
  assert.equal(downloadedExceptHero().length, 0);
  assert.equal(await Asset.countDocuments(), assetsBefore + 1);

  const cat = (await a.post('/categories', { name: 'Banyak Media' })).body.item;
  const media = [{ key: it.image.key }, ...it.screenshots, ...it.videos];
  const saved = await a.post('/products', { name: it.name, category: cat.id, price: 1000, stock: 1, media });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const types = saved.body.item.media.map((m) => m.type);
  assert.equal(types.length, 21);
  assert.equal(types.filter((x) => x === 'image').length, 13);
  assert.equal(types.filter((x) => x === 'video').length, 8);
  assert.equal(saved.body.item.media[0].key, it.image.key, 'gambar utama tetap pertama');

  const reread = (await a.get(`/products/${saved.body.item.id}`)).body.item;
  assert.deepEqual(reread.media.map((m) => m.url), saved.body.item.media.map((m) => m.url), 'urutan & isi galeri utuh setelah dibaca ulang dari DB');
  assert.equal(await Asset.countDocuments({ 'owner.id': saved.body.item.id, status: 'used' }), 1, 'hanya gambar utama yang berupa aset R2');
  const pub = (await t.req(`/api/public/products/${saved.body.item.productId}`)).body.product;
  assert.deepEqual(pub.media.map((m) => m.type), types, 'Marketplace menerima seluruh galeri (13 gambar + 8 video)');
});

test('steam: tidak ada batas MB untuk media Steam (video besar tidak pernah diunduh, jadi tidak pernah ditolak)', async () => {
  appdetails = data({ movies: [{ id: 5, name: 'Besar', mp4: { max: 'https://video.akamai.steamstatic.com/a/big.mp4' } }] });
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200);
  assert.equal(r.body.item.videos.length, 1);
  assert.equal(r.body.item.videos[0].url, 'https://video.akamai.steamstatic.com/a/big.mp4');
  assert.equal(downloadedExceptHero().length, 0);
});

test('steam: kegagalan CDN Steam tidak memengaruhi screenshot & video (tidak pernah diminta server)', async () => {
  appdetails = data();
  for (let i = 0; i < 8; i++) { failUrls.add(`https://shared.akamai.steamstatic.com/s/${i}.1920x1080.jpg`); failUrls.add(`https://shared.akamai.steamstatic.com/s/${i}.600x338.jpg`); }
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200);
  assert.equal(r.body.item.screenshots.length, 8, 'semua tetap masuk sebagai referensi');
  assert.ok(r.body.item.image);
  assert.ok(!r.body.item.warnings.some((x) => x.field === 'screenshots'));
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

test('produk: galeri TIDAK dibatasi jumlahnya di server (30 gambar + 3 video), key duplikat tetap ditolak, info game divalidasi', async () => {
  const cat = (await a.post('/categories', { name: 'Batas' })).body.item;
  const keys = [];
  for (let i = 0; i < 30; i++) keys.push((await a.upload()).body.asset.key);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(30)]);
  const vids = [];
  for (let i = 0; i < 3; i++) vids.push((await a.upload(mp4, 'products', 'v.mp4')).body.asset.key);
  const base = { name: 'Banyak Galeri', category: cat.id, price: 1000, stock: 1 };
  const ok = await a.post('/products', { ...base, media: [...keys, ...vids].map((key) => ({ key })) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.item.media.length, 33);
  assert.equal(ok.body.item.media.filter((m) => m.type === 'video').length, 3, 'lebih dari 1 video diizinkan');
  const dup = await a.post('/products', { ...base, media: [{ key: keys[0] }, { key: keys[0] }] });
  assert.equal(dup.status, 422, 'duplikat tetap ditolak');
  const meta = (await a.get('/meta')).body;
  assert.equal('productMedia' in meta.limits, false, 'Admin Web tidak lagi menerima angka batas galeri');
  const manual = await a.post('/products', { ...base, name: 'Produk Manual' });
  assert.equal(manual.status, 201);
  assert.deepEqual(manual.body.item.gameInfo, { steamAppId: '', developer: '', publisher: '', releaseDate: '', genres: [], metacritic: null }, 'produk manual: info game kosong');
  const bad = await a.post('/products', { ...base, gameInfo: { metacritic: 150, steamAppId: 'abc' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.details?.fields?.['gameInfo.metacritic'] ?? bad.body.error.fields?.['gameInfo.metacritic']);
});

/* ---------- Trailer berbentuk manifest (appdetails tanpa mp4/webm) ---------- */
const manifestMovie = (over = {}) => ({
  id: 9101, name: 'Trailer Baru', highlight: true,
  thumbnail: 'https://video.akamai.steamstatic.com/store_trailers/9101/movie.293x165.jpg?t=1',
  hls_h264: 'https://video.akamai.steamstatic.com/store_trailers/9101/hls_264_master.m3u8?t=1',
  dash_av1: 'https://video.akamai.steamstatic.com/store_trailers/9101/dash_av1.mpd?t=1',
  ...over,
});

test('steam: trailer manifest-only -> file MP4 diverifikasi lewat HEAD (tanpa unduh), tersimpan di produk, Search ulang tidak menggandakan', async () => {
  appdetails = data({ movies: [manifestMovie()] });
  const it = (await a.get('/steam/7')).body.item;
  assert.equal(it.videos.length, 1);
  assert.equal(it.videos[0].ref, '9101');
  assert.equal(it.videos[0].sources[0].format, 'mp4', 'file progresif yang terverifikasi ada di CDN dipakai lebih dulu');
  assert.ok(it.videos[0].sources.some((s) => s.format === 'hls'), 'manifest HLS dari Steam tetap dicatat');
  assert.ok(cdnLog.filter((c) => /9101/.test(c.url)).every((c) => c.method === 'HEAD'), 'video hanya dicek (HEAD), tidak diunduh');

  const cat = (await a.post('/categories', { name: 'Manifest' })).body.item;
  const saved = await a.post('/products', { name: it.name, category: cat.id, price: 1000, stock: 1, media: [{ key: it.image.key }, ...it.videos] });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.item.media.map((m) => m.type), ['image', 'video']);

  // Edit -> Search ulang: kirim media yang sama lagi (URL ?t= boleh berbeda) -> tidak digandakan
  const id = saved.body.item.id;
  const refreshed = { ...it.videos[0], url: it.videos[0].url + '?t=2' };
  const edit = (await a.get(`/products/${id}`)).body.item;
  const put = await a.put(`/products/${id}`, {
    name: edit.name, category: edit.category.id, price: edit.price, stock: edit.stock,
    media: [{ key: it.image.key }, it.videos[0], refreshed],
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.item.media.map((m) => m.type), ['image', 'video'], 'video Steam yang sama (movie ID sama) tidak digandakan');
});

test('steam: trailer manifest-only yang file MP4/WebM-nya tidak ada di CDN -> tetap tersedia lewat HLS (bukan error); screenshot tetap masuk', async () => {
  const movie = manifestMovie({ id: 9102, name: 'Hanya Stream' });
  appdetails = data({ movies: [movie] });
  const { derivedMovieUrls } = await import('../server/lib/steamMedia.js');
  for (const tier of derivedMovieUrls(9102)) for (const u of tier.urls) failUrls.add(u.split('?')[0]);
  const r = await a.get('/steam/7');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.item.videos[0].sources.map((s) => s.format), ['hls', 'dash']);
  assert.ok(r.body.item.image, 'gambar utama tetap masuk');
  assert.equal(r.body.item.screenshots.length, 8, 'screenshot tetap masuk');
});

/* ---------- Penyimpanan media: Steam (referensi) vs upload manual (R2) ---------- */
const shot = (n) => ({ source: 'steam', type: 'image', url: `https://shared.akamai.steamstatic.com/s/ss_${n}.1920x1080.jpg?t=1` });
const clip = { source: 'steam', type: 'video', url: 'https://video.akamai.steamstatic.com/store_trailers/1/movie_max.mp4?t=1', poster: 'https://shared.akamai.steamstatic.com/t/1.jpg?t=1', title: 'T', ref: '1', sources: [{ url: 'https://video.akamai.steamstatic.com/store_trailers/1/movie_max.mp4?t=1', format: 'mp4', quality: 'max' }, { url: 'https://video.akamai.steamstatic.com/store_trailers/1/hls.m3u8', format: 'hls', quality: 'h264' }] };

test('produk: media Steam hanya menerima URL CDN Steam (URL R2/host lain/skema berbahaya ditolak)', async () => {
  const cat = (await a.post('/categories', { name: 'Validasi Steam' })).body.item;
  const base = { name: 'Validasi', category: cat.id, price: 1000, stock: 1 };
  for (const url of ['https://assets.31store.site/products/2026/10/x.jpg', 'https://evil.example.com/a.jpg', 'javascript:alert(1)', 'https://steamstatic.com.evil.com/a.jpg', 'http://evil.example.com/a.jpg']) {
    const r = await a.post('/products', { ...base, media: [{ source: 'steam', type: 'image', url }] });
    assert.equal(r.status, 422, url);
  }
  const badSrc = await a.post('/products', { ...base, media: [{ ...clip, sources: [{ url: 'https://evil.example.com/a.mp4', format: 'mp4', quality: 'max' }] }] });
  assert.equal(badSrc.status, 422);
  const badPoster = await a.post('/products', { ...base, media: [{ ...clip, poster: 'https://evil.example.com/p.jpg' }] });
  assert.equal(badPoster.status, 422);
  const noKey = await a.post('/products', { ...base, media: [{ type: 'image' }] });
  assert.equal(noKey.status, 422, 'upload tanpa key tetap ditolak');
  const fakeKey = await a.post('/products', { ...base, media: [{ key: 'products/2099/01/tidak-ada.jpg' }] });
  assert.equal(fakeKey.status, 422, 'key R2 yang tidak dikenal tetap ditolak');
});

test('produk: galeri campuran (upload manual R2 + media Steam) -> urutan terjaga, upload tetap R2, Steam tetap URL Steam, tanpa duplikat', async () => {
  const { Asset } = await import('../server/models/index.js');
  const cat = (await a.post('/categories', { name: 'Campuran' })).body.item;
  const up1 = (await a.upload()).body.asset;
  const up2 = (await a.upload()).body.asset;
  const created = await a.post('/products', {
    name: 'Campuran', category: cat.id, price: 1000, stock: 1,
    media: [{ key: up1.key }, shot(1), shot(2), clip, { source: 'steam', type: 'image', url: shot(1).url + '&x=1' }, shot(1), { key: up2.key }],   // shot(1) muncul 3x, path sama
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const m = created.body.item.media;
  assert.deepEqual(m.map((x) => x.source || 'upload'), ['upload', 'steam', 'steam', 'steam', 'upload']);
  assert.deepEqual(m.map((x) => x.type), ['image', 'image', 'image', 'video', 'image'], 'duplikat Steam dibuang, urutan Admin terjaga');
  assert.equal(m[0].key, up1.key);
  assert.ok(m[0].url.includes(up1.key) || m[0].url === up1.url, 'media manual tetap URL R2');
  assert.equal(m[1].url, shot(1).url);
  assert.equal(m[1].key, null);
  assert.equal(m[3].poster, clip.poster);
  assert.deepEqual(m[3].sources.map((s) => s.format), ['mp4', 'hls']);
  assert.equal(await Asset.countDocuments({ 'owner.id': created.body.item.id, status: 'used' }), 2, 'hanya 2 upload manual yang menjadi aset R2');

  // Edit: hapus satu media Steam + satu upload manual, tambah screenshot Steam baru. Upload manual yang dilepas dihapus dari R2; Steam tidak menyentuh R2.
  const id = created.body.item.id;
  const put = await a.put(`/products/${id}`, { name: 'Campuran', category: cat.id, price: 1000, stock: 1, media: [{ key: up1.key }, shot(2), shot(3), clip] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.item.media.map((x) => x.url).slice(1), [shot(2).url, shot(3).url, clip.url]);
  assert.equal((await Asset.findOne({ key: up2.key }).lean()), null, 'upload manual yang dilepas dibersihkan seperti biasa');
  assert.equal((await Asset.findOne({ key: up1.key }).lean()).status, 'used');

  // Hapus produk: media Steam tidak punya aset, upload manual dibersihkan
  assert.equal((await a.del(`/products/${id}`)).status, 200);
  assert.equal((await Asset.findOne({ key: up1.key }).lean()), null);
});

test('keamanan: CSP mengizinkan gambar & video dari CDN Steam (media Steam dimuat langsung dari Steam)', async () => {
  const csp = (await t.req('/')).res.headers.get('content-security-policy') || '';
  const dir = (name) => (csp.split(';').map((x) => x.trim()).find((x) => x.startsWith(name + ' ')) || '');
  for (const d of ['img-src', 'media-src']) {
    assert.match(dir(d), /https:\/\/\*\.steamstatic\.com/, d);
    assert.match(dir(d), /https:\/\/\*\.akamaihd\.net/, d);
  }
  assert.doesNotMatch(dir('script-src'), /steam/, 'skrip tetap hanya dari self');
});
