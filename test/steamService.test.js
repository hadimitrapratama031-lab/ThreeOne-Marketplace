// Tes layanan Steam tanpa database/R2: fetch Steam diganti stub. Mencakup App ID valid/invalid dan metadata sebagian.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { NODE_ENV: 'test', R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET_NAME: '', R2_PUBLIC_URL: '', R2_ENDPOINT: '' });
const steam = await import('../server/services/steam.js');
const media = await import('../server/lib/steamMedia.js');

const realFetch = globalThis.fetch;
let calls = [];
let handler;
globalThis.fetch = async (url, opts) => { calls.push(String(url)); return handler(String(url), opts); };
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; steam.clearSteamCache(); });

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const REQ = '<strong>Minimum:</strong><br><ul class="bb_ul"><li><strong>OS:</strong> Windows 10<br></li><li><strong>Memory:</strong> 8 GB RAM<br></li></ul>';
const FULL = {
  name: 'Contoh Game', short_description: 'Ringkasan &amp; singkat.', about_the_game: '<p>Paragraf satu.</p><p>Paragraf dua.</p>',
  header_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/header.jpg?t=1',
  pc_requirements: { minimum: REQ, recommended: REQ.replace('Minimum', 'Recommended').replace('8 GB', '16 GB') },
  developers: ['Studio A'], publishers: ['Publisher B', 'Publisher C'], release_date: { coming_soon: false, date: '10 Jul, 2020' }, metacritic: { score: 88, url: 'https://www.metacritic.com/game/x' },
  screenshots: [
    { id: 0, path_thumbnail: 'https://shared.akamai.steamstatic.com/s/0.600x338.jpg?t=1', path_full: 'https://shared.akamai.steamstatic.com/s/0.1920x1080.jpg?t=1' },
    { id: 1, path_thumbnail: 'https://shared.akamai.steamstatic.com/s/1.600x338.jpg', path_full: 'https://shared.akamai.steamstatic.com/s/1.1920x1080.jpg' },
    { id: 2, path_full: 'https://evil.example.com/2.jpg' },
    { id: 3, path_full: 'https://shared.akamai.steamstatic.com/s/1.1920x1080.jpg?dup=1' },
  ],
  movies: [{ id: 1, name: 'Trailer', highlight: true, mp4: { 480: 'https://video.akamai.steamstatic.com/a/480.mp4', max: 'https://video.akamai.steamstatic.com/a/max.mp4' } }],
};

test('App ID tidak valid (format) ditolak tanpa menghubungi Steam', async () => {
  for (const bad of ['', 'abc', '12a', '-5', '0', '1'.repeat(11), ' ']) {
    await assert.rejects(steam.searchApp(bad), (e) => e.status === 422 && e.message === 'Steam App ID tidak valid.', bad);
  }
  assert.equal(calls.length, 0);
});

test('App ID tidak ada di Steam -> 404 "Steam App ID tidak valid."', async () => {
  handler = () => json({ 999: { success: false } });
  await assert.rejects(steam.searchApp('999'), (e) => e.status === 404 && e.message === 'Steam App ID tidak valid.' && e.details.code === 'APPID_NOT_FOUND');
});

test('Steam tidak terjangkau / 429 / 5xx / bukan JSON -> error jelas, bukan "ID tidak valid"', async () => {
  handler = () => { throw new TypeError('fetch failed'); };
  await assert.rejects(steam.searchApp('10'), (e) => e.status === 502 && e.details.code === 'STEAM_UNREACHABLE');
  handler = () => new Response('', { status: 429 });
  await assert.rejects(steam.searchApp('10'), (e) => e.status === 429);
  handler = () => new Response('oops', { status: 503 });
  await assert.rejects(steam.searchApp('10'), (e) => e.status === 502);
  handler = () => new Response('<html>', { status: 200 });
  await assert.rejects(steam.searchApp('10'), (e) => e.status === 502);
  assert.equal(calls.length, 4, 'kegagalan tidak boleh di-cache');
});

test('metadata lengkap: nama, deskripsi, spesifikasi terparse; video terdeteksi', async () => {
  handler = () => json({ 1: { success: true, data: FULL } });
  const r = await steam.searchApp('0001');
  assert.equal(r.appId, '1');
  assert.equal(r.name, 'Contoh Game');
  assert.equal(r.description, 'Ringkasan & singkat.');
  assert.equal(r.about, 'Paragraf satu.\n\nParagraf dua.');
  assert.deepEqual(r.specs.min, [{ label: 'OS', value: 'Windows 10' }, { label: 'Memory', value: '8 GB RAM' }]);
  assert.equal(r.specs.rec[1].value, '16 GB RAM');
  assert.deepEqual(r.video, { available: true, count: 1 });
  assert.equal(r.videos[0].source, 'steam');
  assert.equal(r.videos[0].title, 'Trailer');
  assert.equal(r.videos[0].url, 'https://video.akamai.steamstatic.com/a/max.mp4', 'URL asli dari respons Steam, kualitas tertinggi dulu');
  assert.deepEqual(r.videos[0].sources.map((x) => `${x.format}/${x.quality}`), ['mp4/max', 'mp4/480']);
  assert.deepEqual(r.screenshots.map((x) => x.url), [FULL.screenshots[0].path_full, FULL.screenshots[1].path_full], 'screenshot = URL asli Steam, tanpa unduh');
  assert.ok(r.screenshots.every((x) => x.source === 'steam' && x.type === 'image'));
  assert.equal(r.info.developer, 'Studio A');
  assert.equal(r.info.publisher, 'Publisher B, Publisher C');
  assert.equal(r.info.releaseDate, '10 Jul, 2020');
  assert.equal(r.info.metacritic, 88);
  assert.equal(r.screenshotsAvailable, 2, 'host asing & duplikat tidak dihitung');
  assert.match(calls[0], /appids=1&/);
  assert.equal(calls.length, 1, 'hanya appdetails yang dipanggil: screenshot & video Steam tidak diunduh');
});

test('App ID valid tapi metadata sebagian -> tetap sukses dengan warnings (bukan "tidak valid")', async () => {
  handler = () => json({ 2: { success: true, data: { name: 'Game Minim', short_description: '', pc_requirements: [] } } });
  const r = await steam.searchApp('2');
  assert.equal(r.name, 'Game Minim');
  assert.equal(r.partial, true);
  const fields = r.warnings.map((w) => w.field).sort();
  assert.deepEqual(fields, ['about', 'description', 'developer', 'genres', 'image', 'publisher', 'releaseDate', 'screenshots', 'specsMin', 'specsRec', 'video'].sort());
  assert.equal(r.info.metacritic, null, 'Metacritic kosong tidak menjadi warning dan tidak dikarang');
  assert.deepEqual(r.screenshots, []);
  assert.deepEqual(r.specs.min, []);
  assert.equal(r.image, null);
  assert.equal(r.video.available, false);
  assert.ok(r.warnings.find((w) => w.field === 'video').message.includes('upload manual'));
});

test('gambar ditemukan tetapi R2 belum dikonfigurasi -> warning, tidak gagal', async () => {
  handler = () => json({ 1: { success: true, data: FULL } });
  const r = await steam.searchApp('1');
  assert.equal(r.image, null);
  assert.ok(r.warnings.some((w) => w.field === 'image' && /R2/.test(w.message)));
  // Screenshot & video Steam tidak memakai R2, jadi tetap tersedia walau R2 belum dikonfigurasi
  assert.equal(r.screenshots.length, 2);
  assert.equal(r.videos.length, 1);
  assert.ok(!r.warnings.some((w) => w.field === 'screenshots' || w.field === 'video'));
});

test('cache: lookup berulang tidak membebani Steam; permintaan bersamaan digabung', async () => {
  handler = async () => { await new Promise((r) => setTimeout(r, 20)); return json({ 1: { success: true, data: FULL } }); };
  await Promise.all([steam.searchApp('1'), steam.searchApp('1'), steam.searchApp('1')]);
  await steam.searchApp('1');
  assert.equal(calls.length, 1);
});

test('video: hanya URL host CDN Steam yang dipakai (host asing diabaikan); http:// dinaikkan ke https://', () => {
  const c = media.movieDrafts({ movies: [
    { name: 'x', highlight: false, mp4: { 480: 'https://evil.example.com/a.mp4' } },
    { name: 'y', highlight: true, webm: { 480: 'https://video.akamai.steamstatic.com/y480.webm', max: 'http://video.akamai.steamstatic.com/ymax.webm' } },
    { name: 'z', mp4: { 480: 'ftp://video.akamai.steamstatic.com/z.mp4', max: 'http://evil.example.com/z.mp4' } },
  ] });
  assert.equal(c.length, 1, 'x (host asing) dan z (protokol/host tidak sah) dibuang');
  assert.deepEqual(c[0].progressive.map((v) => v.url), ['https://video.akamai.steamstatic.com/ymax.webm', 'https://video.akamai.steamstatic.com/y480.webm']);
});

test('video: SEMUA movies[] dibaca, satu entri per video; highlight dulu, selebihnya urutan Steam; duplikat dibuang; tidak ada batas jumlah', () => {
  const mk = (id, over = {}) => ({ id, name: `Video ${id}`, highlight: false, thumbnail: `https://shared.akamai.steamstatic.com/t/${id}.jpg?t=9`, webm: { 480: `http://video.akamai.steamstatic.com/store_trailers/${id}/movie480.webm?t=1`, max: `http://video.akamai.steamstatic.com/store_trailers/${id}/movie_max.webm?t=1` }, mp4: { 480: `http://video.akamai.steamstatic.com/store_trailers/${id}/movie480.mp4?t=1`, max: `http://video.akamai.steamstatic.com/store_trailers/${id}/movie_max.mp4?t=1` }, ...over });
  const movies = [mk(1), mk(2), mk(3, { highlight: true }), mk(4), mk(2), mk(5), mk(6), mk(7), mk(8)];
  const drafts = media.movieDrafts({ movies });
  assert.equal(drafts.length, 8, '8 video unik (satu duplikat dibuang)');
  const items = drafts.map((d) => media.toVideoItem(d));
  assert.deepEqual(items.map((m) => m.title), ['Video 3', 'Video 1', 'Video 2', 'Video 4', 'Video 5', 'Video 6', 'Video 7', 'Video 8']);
  assert.deepEqual(items[0].sources.map((v) => `${v.format}/${v.quality}`), ['mp4/max', 'webm/max', 'mp4/480', 'webm/480'], 'kualitas tertinggi dulu; MP4 sebelum WebM');
  assert.equal(items[0].url, 'https://video.akamai.steamstatic.com/store_trailers/3/movie_max.mp4?t=1');
  assert.equal(items[0].poster, 'https://shared.akamai.steamstatic.com/t/3.jpg?t=9', 'thumbnail = URL asli Steam');
  assert.equal(items[0].ref, '3');
  assert.ok(items.every((m) => m.source === 'steam' && m.type === 'video' && m.sources.every((v) => v.url.startsWith('https://'))), 'semua URL https, sumber steam');
  assert.deepEqual(media.movieDrafts({}), []);
  assert.deepEqual(media.movieDrafts({ movies: 'x' }), []);
  const lots = media.movieDrafts({ movies: Array.from({ length: 40 }, (_, i) => mk(100 + i)) });
  assert.equal(lots.length, 40);
});

test('screenshot: semua entri screenshots[] dibaca (bukan hanya satu), urutan Steam dipertahankan, URL asli apa adanya', () => {
  const c = media.screenshotItems(FULL);
  assert.equal(c.length, 2);
  assert.deepEqual(c.map((x) => x.url), [FULL.screenshots[0].path_full, FULL.screenshots[1].path_full], 'path_full, lengkap dengan ?t=');
  const many = { screenshots: Array.from({ length: 30 }, (_, i) => ({ id: i, path_full: `https://shared.akamai.steamstatic.com/s/${i}.jpg` })) };
  assert.equal(media.screenshotItems(many).length, 30, 'tidak ada batas jumlah');
  assert.deepEqual(media.screenshotItems({}), []);
  assert.deepEqual(media.screenshotItems({ screenshots: 'x' }), []);
  // thumbnail hanya dipakai bila path_full tidak ada
  assert.equal(media.screenshotItems({ screenshots: [{ id: 0, path_thumbnail: 'https://shared.akamai.steamstatic.com/s/t.jpg' }] })[0].url, 'https://shared.akamai.steamstatic.com/s/t.jpg');
});

test('video: jumlah & daftar semua video yang tersedia dilaporkan', async () => {
  const two = { ...FULL, movies: [...FULL.movies, { id: 2, name: 'Gameplay', mp4: { 480: 'https://video.akamai.steamstatic.com/b/480.mp4' } }] };
  handler = () => json({ 1: { success: true, data: two } });
  const r = await steam.searchApp('1');
  assert.deepEqual(r.video, { available: true, count: 2 });
  assert.deepEqual(r.videos.map((v) => v.title), ['Trailer', 'Gameplay'], 'trailer highlight didahulukan');
});

/* ---------- Trailer berbentuk manifest (tanpa mp4/webm) & pemilihan amplop appdetails ---------- */
// Fixture: id & URL di bawah hanya contoh bentuk data; bukan trailer sungguhan.
const manifestOnly = (over = {}) => ({
  id: 9001, name: 'Trailer Baru', highlight: true,
  thumbnail: 'https://video.akamai.steamstatic.com/store_trailers/9001/movie.293x165.jpg?t=1',
  hls_h264: 'https://video.akamai.steamstatic.com/store_trailers/9001/hls_264_master.m3u8?t=1',
  dash_av1: 'https://video.akamai.steamstatic.com/store_trailers/9001/dash_av1.mpd?t=1',
  ...over,
});

test('video: trailer yang hanya membawa manifest HLS/DASH tetap dikenali; HLS dipakai sebagai source, DASH hanya dicatat', () => {
  const [d] = media.movieDrafts({ movies: [manifestOnly()] });
  assert.equal(d.id, 9001);
  assert.deepEqual(d.progressive, [], 'Steam tidak mendeklarasikan MP4/WebM');
  const item = media.toVideoItem(d);
  assert.equal(item.poster, 'https://video.akamai.steamstatic.com/store_trailers/9001/movie.293x165.jpg?t=1');
  assert.deepEqual(item.sources.map((x) => x.format), ['hls', 'dash']);
  assert.equal(item.url, 'https://video.akamai.steamstatic.com/store_trailers/9001/hls_264_master.m3u8?t=1');
  // DASH saja = tidak ada yang bisa diputar <video> -> null (dilewati)
  assert.equal(media.toVideoItem(media.movieDrafts({ movies: [manifestOnly({ hls_h264: undefined })] })[0]), null);
});

test('video: kandidat file berbasis movie ID hanya dipakai bila diverifikasi; yang dideklarasikan Steam tetap lebih dulu', () => {
  const [d] = media.movieDrafts({ movies: [manifestOnly()] });
  const ok = { url: 'https://video.akamai.steamstatic.com/store_trailers/9001/movie_max.mp4', format: 'mp4', quality: 'max' };
  const item = media.toVideoItem(d, [ok]);
  assert.deepEqual(item.sources.map((x) => x.format), ['mp4', 'hls', 'dash'], 'file progresif terverifikasi sebelum HLS');
  assert.equal(item.url, ok.url);
  const tiers = media.derivedMovieUrls(9001);
  assert.deepEqual(tiers.map((t) => `${t.format}/${t.quality}`), ['mp4/max', 'webm/max', 'mp4/480', 'webm/480']);
  for (const t of tiers) for (const u of t.urls) assert.match(u, /^https:\/\/(video|cdn)\.akamai\.steamstatic\.com\/.*\/9001\//);
  const declared = 'https://video.akamai.steamstatic.com/store_trailers/9002/movie480.mp4?t=77';
  const [d2] = media.movieDrafts({ movies: [{ id: 9002, name: 'Lama', mp4: { 480: declared }, webm: { max: 'http://video.akamai.steamstatic.com/x/max.webm' } }] });
  const i2 = media.toVideoItem(d2);
  assert.deepEqual(i2.sources.map((x) => x.url), ['https://video.akamai.steamstatic.com/x/max.webm', declared]);
});

test('video: movie tanpa mp4/webm/hls dan tanpa movie ID dilewati (bukan error); id tidak valid tidak dipakai', () => {
  assert.deepEqual(media.movieDrafts({ movies: [{ name: 'x' }] }), []);
  for (const id of [0, -3, 'abc', 1.5, null]) {
    const drafts = media.movieDrafts({ movies: [manifestOnly({ id, hls_h264: undefined, dash_av1: undefined })] });
    assert.deepEqual(drafts, [], `id=${id}`);
  }
});

test('video: movie ID yang sama tidak dilaporkan dua kali', () => {
  const c = media.movieDrafts({ movies: [manifestOnly(), manifestOnly({ highlight: false }), manifestOnly({ id: 9004, name: 'Lain', highlight: false })] });
  assert.deepEqual(c.map((m) => m.id), [9001, 9004]);
});

test('searchApp: trailer manifest-only (file MP4/WebM tidak ada di CDN) -> tetap tersedia lewat HLS; tidak ada unduhan', async () => {
  // Semua permintaan ke CDN (HEAD pengecekan file) dijawab 404; hanya appdetails yang berhasil
  handler = (url) => (url.startsWith('https://store.steampowered.com/') ? json({ 1: { success: true, data: { ...FULL, movies: [manifestOnly()] } } }) : new Response('', { status: 404 }));
  const r = await steam.searchApp('1');
  assert.deepEqual(r.video, { available: true, count: 1 });
  assert.deepEqual(r.videos[0].sources.map((x) => x.format), ['hls', 'dash']);
  assert.ok(!r.warnings.some((w) => w.field === 'video'));
  assert.ok(calls.filter((u) => !u.startsWith('https://store.steampowered.com/')).every((u) => /movie(_max|480)/.test(u)), 'hanya pengecekan kandidat file video');
});

test('searchApp: kandidat file berbasis movie ID yang ADA di CDN ikut disimpan (dicek lewat HEAD, tanpa mengunduh isi)', async () => {
  const methods = [];
  handler = (url, opts) => {
    if (url.startsWith('https://store.steampowered.com/')) return json({ 1: { success: true, data: { ...FULL, movies: [manifestOnly()] } } });
    methods.push(opts?.method);
    return url.endsWith('/9001/movie_max.mp4') ? new Response('', { status: 200, headers: { 'content-type': 'video/mp4' } }) : new Response('', { status: 404 });
  };
  const r = await steam.searchApp('1');
  assert.deepEqual(r.videos[0].sources.map((x) => x.format), ['mp4', 'hls', 'dash']);
  assert.equal(r.videos[0].url, 'https://video.akamai.steamstatic.com/store_trailers/9001/movie_max.mp4');
  assert.ok(methods.length > 0 && methods.every((m) => m === 'HEAD'), 'hanya HEAD, tidak ada GET isi video');
});

test('searchApp: trailer dengan DASH saja dilewati dengan warning, bukan error', async () => {
  handler = (url) => (url.startsWith('https://store.steampowered.com/') ? json({ 1: { success: true, data: { ...FULL, movies: [manifestOnly({ hls_h264: undefined })] } } }) : new Response('', { status: 404 }));
  const r = await steam.searchApp('1');
  assert.equal(r.videos.length, 0);
  assert.equal(r.video.available, false);
  assert.ok(r.warnings.some((w) => w.field === 'video'));
});

test('appdetails: amplop dipilih dari isinya (steam_appid) bila Steam memberi label kunci appid lain; appid yang dialihkan tetap lewat kunci', async () => {
  // kunci berlabel DLC, isi = game yang diminta
  handler = () => json({ 3380990: { success: true, data: { ...FULL, steam_appid: 275850 } } });
  const r = await steam.searchApp('275850');
  assert.equal(r.name, 'Contoh Game');
  steam.clearSteamCache();
  // appid dialihkan: kunci = yang diminta, steam_appid di isi berbeda
  handler = () => json({ 100: { success: true, data: { ...FULL, name: 'Dialihkan', steam_appid: 80 } } });
  assert.equal((await steam.searchApp('100')).name, 'Dialihkan');
  steam.clearSteamCache();
  // isi milik app lain & tidak ada kunci yang diminta -> tetap "tidak ditemukan", bukan data game yang salah
  handler = () => json({ 555: { success: true, data: { ...FULL, steam_appid: 777 } } });
  await assert.rejects(steam.searchApp('276'), (e) => e.status === 404);
});
