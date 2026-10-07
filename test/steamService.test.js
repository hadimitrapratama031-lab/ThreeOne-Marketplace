// Tes layanan Steam tanpa database/R2: fetch Steam diganti stub. Mencakup App ID valid/invalid dan metadata sebagian.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { NODE_ENV: 'test', R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET_NAME: '', R2_PUBLIC_URL: '', R2_ENDPOINT: '' });
const steam = await import('../server/services/steam.js');

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
  assert.deepEqual(r.video, { available: true, title: 'Trailer', count: 1, items: [{ index: 0, title: 'Trailer' }] });
  assert.equal(r.info.developer, 'Studio A');
  assert.equal(r.info.publisher, 'Publisher B, Publisher C');
  assert.equal(r.info.releaseDate, '10 Jul, 2020');
  assert.equal(r.info.metacritic, 88);
  assert.equal(r.screenshotsAvailable, 2, 'host asing & duplikat tidak dihitung');
  assert.match(calls[0], /appids=1&/);
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
});

test('cache: lookup berulang tidak membebani Steam; permintaan bersamaan digabung', async () => {
  handler = async () => { await new Promise((r) => setTimeout(r, 20)); return json({ 1: { success: true, data: FULL } }); };
  await Promise.all([steam.searchApp('1'), steam.searchApp('1'), steam.searchApp('1')]);
  await steam.searchApp('1');
  assert.equal(calls.length, 1);
});

test('video: kandidat hanya MP4/WebM dari host CDN Steam (host lain & HLS diabaikan); http:// dinaikkan ke https://', () => {
  const c = steam.movieCandidates({ movies: [
    { name: 'x', highlight: false, mp4: { 480: 'https://evil.example.com/a.mp4' }, hls_h264: 'https://video.akamai.steamstatic.com/a.m3u8' },
    { name: 'y', highlight: true, webm: { 480: 'https://video.akamai.steamstatic.com/y480.webm', max: 'http://video.akamai.steamstatic.com/ymax.webm' } },
    { name: 'z', mp4: { 480: 'ftp://video.akamai.steamstatic.com/z.mp4', max: 'http://evil.example.com/z.mp4' } },
  ] });
  assert.equal(c.length, 1, 'x (host asing) dan z (protokol/host tidak sah) dibuang');
  assert.deepEqual(c[0].sources.map((v) => v.url), ['https://video.akamai.steamstatic.com/y480.webm', 'https://video.akamai.steamstatic.com/ymax.webm']);
});

test('video: SEMUA movies[] dibaca, satu entri per video; highlight dulu, selebihnya urutan Steam; duplikat dibuang', () => {
  const mk = (id, over = {}) => ({ id, name: `Video ${id}`, highlight: false, webm: { 480: `http://video.akamai.steamstatic.com/store_trailers/${id}/movie480.webm?t=1`, max: `http://video.akamai.steamstatic.com/store_trailers/${id}/movie_max.webm?t=1` }, mp4: { 480: `http://video.akamai.steamstatic.com/store_trailers/${id}/movie480.mp4?t=1`, max: `http://video.akamai.steamstatic.com/store_trailers/${id}/movie_max.mp4?t=1` }, ...over });
  const movies = [mk(1), mk(2), mk(3, { highlight: true }), mk(4), mk(2), mk(5), mk(6), mk(7), mk(8)];
  const c = steam.movieCandidates({ movies });
  assert.equal(c.length, 8, '8 video unik (satu duplikat dibuang), bukan hanya 1');
  assert.deepEqual(c.map((m) => m.title), ['Video 3', 'Video 1', 'Video 2', 'Video 4', 'Video 5', 'Video 6', 'Video 7', 'Video 8']);
  assert.deepEqual(c.map((m) => m.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  // URL yang dideklarasikan Steam: urutan tetap 480 dulu (paling kecil). Cadangan berbasis movie ID (derived) menyusul di tier yang sama.
  assert.deepEqual(c[0].sources.filter((v) => !v.derived).map((v) => `${v.format}/${v.quality}`), ['mp4/480', 'webm/480', 'mp4/max', 'webm/max'], '480 dicoba dulu (paling kecil)');
  const tiers = c[0].sources.map((v) => `${v.format}/${v.quality}`);
  assert.deepEqual([...new Set(tiers)], ['mp4/480', 'webm/480', 'mp4/max', 'webm/max'], 'cadangan tidak mengubah urutan tier');
  assert.equal(c[0].sources.find((v) => v.format === 'mp4' && v.quality === '480').derived, false, 'yang dideklarasikan Steam selalu lebih dulu dalam tier-nya');
  assert.ok(c.every((m) => m.sources.every((v) => v.url.startsWith('https://'))), 'semua URL sudah https');
  assert.deepEqual(steam.movieCandidates({}), []);
  assert.deepEqual(steam.movieCandidates({ movies: 'x' }), []);
});

test('screenshot: semua entri screenshots[] dibaca (bukan hanya satu), urutan Steam dipertahankan, full lebih dulu dari thumbnail', () => {
  const c = steam.screenshotCandidates(FULL);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0].urls, [FULL.screenshots[0].path_full, FULL.screenshots[0].path_thumbnail]);
  const many = { screenshots: Array.from({ length: 30 }, (_, i) => ({ id: i, path_full: `https://shared.akamai.steamstatic.com/s/${i}.jpg` })) };
  assert.equal(steam.screenshotCandidates(many).length, 30, 'tidak ada batas 1 di tahap parsing');
  assert.deepEqual(steam.screenshotCandidates({}), []);
  assert.deepEqual(steam.screenshotCandidates({ screenshots: 'x' }), []);
});

test('video: jumlah & daftar semua video yang tersedia dilaporkan', async () => {
  const two = { ...FULL, movies: [...FULL.movies, { id: 2, name: 'Gameplay', mp4: { 480: 'https://video.akamai.steamstatic.com/b/480.mp4' } }] };
  handler = () => json({ 1: { success: true, data: two } });
  const r = await steam.searchApp('1');
  assert.equal(r.video.count, 2);
  assert.equal(r.video.title, 'Trailer', 'trailer highlight didahulukan');
  assert.deepEqual(r.video.items, [{ index: 0, title: 'Trailer' }, { index: 1, title: 'Gameplay' }]);
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

test('video: trailer yang hanya membawa manifest HLS/DASH tetap dikenali; kandidat file MP4/WebM dicari lewat movie ID', () => {
  const c = steam.movieCandidates({ movies: [manifestOnly()] });
  assert.equal(c.length, 1, 'dulu dibuang karena tidak ada mp4/webm -> \"video tidak tersedia\"');
  const [m] = c;
  assert.equal(m.id, 9001);
  assert.equal(m.title, 'Trailer Baru');
  assert.equal(m.streamOnly, true);
  assert.equal(m.thumbnail, 'https://video.akamai.steamstatic.com/store_trailers/9001/movie.293x165.jpg?t=1');
  assert.ok(m.sources.length >= 4 && m.sources.every((s) => s.derived));
  // 480p lebih dulu dari max; MP4 lebih dulu dari WebM pada kualitas yang sama
  assert.deepEqual(m.sources.map((s) => `${s.format}|${s.quality}`).filter((v, i, a) => a.indexOf(v) === i), ['mp4|480', 'webm|480', 'mp4|max', 'webm|max']);
  assert.equal(m.sources[0].url, 'https://video.akamai.steamstatic.com/store_trailers/9001/movie480.mp4');
  for (const s of m.sources) {
    assert.match(s.url, /^https:\/\/(video|cdn)\.akamai\.steamstatic\.com\/.*\/9001\//, s.url);
    assert.match(s.url, /\.(mp4|webm)$/, 'manifest .m3u8/.mpd tidak pernah dijadikan sumber <video>');
  }
  assert.equal(new Set(m.sources.map((s) => s.url)).size, m.sources.length, 'tidak ada URL ganda');
});

test('video: URL yang dideklarasikan Steam didahulukan; pola movie ID hanya cadangan dan tidak menggandakan URL yang sama', () => {
  const declared = 'https://video.akamai.steamstatic.com/store_trailers/9002/movie480.mp4?t=77';
  const [m] = steam.movieCandidates({ movies: [{ id: 9002, name: 'Lama', mp4: { 480: declared }, webm: { max: 'http://video.akamai.steamstatic.com/x/max.webm' } }] });
  assert.deepEqual(m.sources[0], { url: declared, format: 'mp4', quality: '480', derived: false });
  assert.equal(m.sources.filter((s) => s.url.startsWith('https://video.akamai.steamstatic.com/store_trailers/9002/movie480.mp4')).length, 1, 'URL yang sama (tanpa ?t=) tidak muncul dua kali');
  const declaredWebmMax = m.sources.find((s) => s.format === 'webm' && s.quality === 'max' && !s.derived);
  assert.equal(declaredWebmMax.url, 'https://video.akamai.steamstatic.com/x/max.webm', 'http:// dinaikkan ke https://');
  assert.ok(m.sources.some((s) => s.derived), 'cadangan tetap tersedia bila URL yang dideklarasikan 404');
  assert.equal(m.streamOnly, false);
});

test('video: manifest tanpa movie ID dan tanpa mp4/webm = tidak ada yang bisa diunduh (dilewati, bukan error); id tidak valid tidak dipakai', () => {
  assert.deepEqual(steam.movieCandidates({ movies: [{ name: 'x', hls_h264: 'https://video.akamai.steamstatic.com/a.m3u8' }] }), []);
  for (const id of [0, -3, 'abc', 1.5, null]) {
    assert.deepEqual(steam.movieCandidates({ movies: [manifestOnly({ id })] }), [], `id=${id}`);
  }
  // host asing pada manifest tidak membuat entri menjadi streamOnly
  const [m] = steam.movieCandidates({ movies: [{ id: 9003, name: 'y', hls_h264: 'https://evil.example.com/a.m3u8', mp4: { 480: 'https://video.akamai.steamstatic.com/a/480.mp4' } }] });
  assert.equal(m.streamOnly, false);
});

test('video: movie ID yang sama tidak dilaporkan dua kali', () => {
  const c = steam.movieCandidates({ movies: [manifestOnly(), manifestOnly({ highlight: false }), manifestOnly({ id: 9004, name: 'Lain', highlight: false })] });
  assert.deepEqual(c.map((m) => m.id), [9001, 9004]);
  assert.deepEqual(c.map((m) => m.index), [0, 1]);
});

test('searchApp: game dengan trailer manifest-only dilaporkan punya video (bukan warning \"tidak tersedia\")', async () => {
  handler = () => json({ 1: { success: true, data: { ...FULL, movies: [manifestOnly()] } } });
  const r = await steam.searchApp('1');
  assert.deepEqual(r.video, { available: true, title: 'Trailer Baru', count: 1, items: [{ index: 0, title: 'Trailer Baru' }] });
  assert.ok(!r.warnings.some((w) => w.field === 'video'));
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
