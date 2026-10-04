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
  assert.deepEqual(r.video, { available: true, title: 'Trailer' });
  assert.match(calls[0], /appids=1&/);
});

test('App ID valid tapi metadata sebagian -> tetap sukses dengan warnings (bukan "tidak valid")', async () => {
  handler = () => json({ 2: { success: true, data: { name: 'Game Minim', short_description: '', pc_requirements: [] } } });
  const r = await steam.searchApp('2');
  assert.equal(r.name, 'Game Minim');
  assert.equal(r.partial, true);
  const fields = r.warnings.map((w) => w.field).sort();
  assert.deepEqual(fields, ['about', 'description', 'image', 'specsMin', 'specsRec', 'video'].sort());
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

test('video: kandidat hanya MP4/WebM dari host CDN Steam (host lain & HLS diabaikan)', () => {
  const c = steam.videoCandidates({ movies: [
    { name: 'x', highlight: false, mp4: { 480: 'https://evil.example.com/a.mp4' }, hls_h264: 'https://video.akamai.steamstatic.com/a.m3u8' },
    { name: 'y', highlight: true, webm: { 480: 'https://video.akamai.steamstatic.com/y480.webm', max: 'http://video.akamai.steamstatic.com/ymax.webm' } },
  ] });
  assert.deepEqual(c.map((v) => v.url), ['https://video.akamai.steamstatic.com/y480.webm']);
});
