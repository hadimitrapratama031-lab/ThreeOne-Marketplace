/**
 * Integrasi Steam Store (satu-satunya di project ini). Dipanggil HANYA dari backend.
 *
 * Sumber data: endpoint publik Steam Store `https://store.steampowered.com/api/appdetails?appids=<id>`.
 * Tidak memakai API key apa pun, jadi tidak ada rahasia yang bisa bocor ke frontend.
 *
 * Alur media: SEMUA `screenshots[]` dan SEMUA `movies[]` dari appdetails diunduh server dari CDN resmi Steam (hanya host
 * *.steamstatic.com / *.akamaihd.net, selalu lewat HTTPS, redirect divalidasi ulang), lalu disimpan sebagai aset 'temp' di Cloudflare R2 lewat services/assets.js.
 * Aset baru menjadi milik produk hanya setelah admin menekan Simpan (alur upload yang sama dengan upload manual).
 * Biner tidak pernah masuk MongoDB; yang tersimpan di produk hanyalah referensi {type, key, url}.
 */
import { Asset, Category } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { config, r2Configured } from '../config/env.js';
import { uploadAsset, destroyAssets } from './assets.js';
import { aboutText, shortDescription, parsePcRequirements, parseGameInfo } from '../lib/steamParse.js';

const STORE_API = 'https://store.steampowered.com/api/appdetails';
const CDN_HOST = /(^|\.)(steamstatic\.com|akamaihd\.net)$/i;
const TTL_FOUND = 10 * 60_000;     // data lama tidak boleh permanen
const TTL_MISSING = 2 * 60_000;    // "tidak ditemukan" di-cache lebih singkat
const CACHE_MAX = 300;

export const isValidAppId = (v) => /^\d{1,10}$/.test(String(v ?? '').trim()) && Number(v) > 0;

/* ---------- HTTP aman ---------- */

/**
 * URL CDN Steam yang boleh diunduh, atau null. Hanya host *.steamstatic.com / *.akamaihd.net.
 * appdetails kadang mengirim URL `movies[]` sebagai `http://` (host CDN yang sama); itu dinaikkan ke https, bukan dibuang,
 * karena kalau dibuang trailer dianggap "tidak tersedia". Protokol lain (ftp:, javascript:, dst.) tetap ditolak.
 */
const cdnUrl = (raw) => {
  try {
    const u = new URL(raw);
    if (!CDN_HOST.test(u.hostname)) return null;
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' ? u : null;
  } catch { return null; }
};

/** Unduh dengan batas ukuran & waktu. Redirect hanya diikuti bila tujuan tetap host CDN Steam yang diizinkan. */
async function download(url, { maxBytes, timeoutMs }) {
  let u = cdnUrl(url);
  if (!u) throw new Error('host-not-allowed');
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= 3; hop++) {
    const res = await fetch(u, { redirect: 'manual', signal, headers: { accept: '*/*', 'user-agent': 'marketplace-admin/1.0' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      u = cdnUrl(new URL(res.headers.get('location'), u).href);
      if (!u) throw new Error('redirect-not-allowed');
      continue;
    }
    if (!res.ok) throw new Error(`http-${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw new Error('too-large');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) { res.body.cancel?.().catch?.(() => {}); throw new Error('too-large'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('too-many-redirects');
}

/* ---------- Lookup + cache ---------- */

const cache = new Map();     // appId -> { at, ttl, value }
const inflight = new Map();  // appId -> Promise  (permintaan bersamaan untuk ID yang sama hanya menembak Steam sekali)

export const clearSteamCache = () => { cache.clear(); inflight.clear(); stagedByUrl.clear(); };

function remember(appId, value, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(appId, { at: Date.now(), ttl, value });
}

async function fetchAppDetails(appId) {
  let res;
  try {
    res = await fetch(`${STORE_API}?appids=${appId}&l=english`, {
      signal: AbortSignal.timeout(12_000),
      headers: { accept: 'application/json', 'user-agent': 'marketplace-admin/1.0' },
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new HttpError(502, timeout ? 'Steam tidak merespons (waktu habis). Coba lagi sebentar atau isi manual.' : 'Tidak dapat terhubung ke Steam. Coba lagi sebentar atau isi manual.', { code: 'STEAM_UNREACHABLE' });
  }
  if (res.status === 429) throw new HttpError(429, 'Steam membatasi permintaan. Tunggu beberapa saat lalu coba lagi.', { code: 'STEAM_RATE_LIMIT' });
  if (!res.ok) throw new HttpError(502, `Steam mengembalikan kesalahan (${res.status}). Coba lagi sebentar atau isi manual.`, { code: 'STEAM_ERROR' });
  let json;
  try { json = await res.json(); } catch { throw new HttpError(502, 'Respons Steam tidak dapat dibaca. Coba lagi sebentar atau isi manual.', { code: 'STEAM_ERROR' }); }
  const entry = json?.[appId];
  if (!entry || entry.success !== true || !entry.data || typeof entry.data !== 'object') return { found: false };
  return { found: true, data: entry.data };
}

/** Ambil data mentah Steam (dengan cache & dedupe). */
export async function lookup(appId) {
  const hit = cache.get(appId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  if (inflight.has(appId)) return inflight.get(appId);
  const p = fetchAppDetails(appId)
    .then((v) => { remember(appId, v, v.found ? TTL_FOUND : TTL_MISSING); return v; })
    .finally(() => inflight.delete(appId));
  inflight.set(appId, p);
  return p;
}

/* ---------- Staging media ke R2 ---------- */

const stagedByUrl = new Map(); // sumber Steam -> key aset 'temp' (hindari upload ganda saat admin menekan Search berulang)

const assetView = (a) => ({ type: a.kind, key: a.key, url: a.url });

async function reuseStaged(srcUrl) {
  const key = stagedByUrl.get(srcUrl);
  if (!key) return null;
  const a = await Asset.findOne({ key, status: 'temp' });
  if (!a) { stagedByUrl.delete(srcUrl); return null; }
  return assetView(a);
}

async function stage(srcUrl, { kind, maxBytes, timeoutMs, name }) {
  const reused = await reuseStaged(srcUrl);
  if (reused) return reused;
  const buffer = await download(srcUrl, { maxBytes, timeoutMs });
  const asset = await uploadAsset({ buffer, originalName: name, folder: 'products' });
  if (asset.kind !== kind) {
    await destroyAssets([asset]);
    throw new Error('wrong-kind');
  }
  stagedByUrl.set(srcUrl, asset.key);
  return assetView(asset);
}

/* ---------- Normalisasi ---------- */

// Tidak ada batas jumlah: semua screenshot & semua video yang disediakan Steam disalin ke R2 (aset 'temp').
// Hanya paralelisme yang dibatasi (bukan jumlahnya) supaya server tidak membuka puluhan koneksi sekaligus.
const STAGE_CONCURRENCY = 6;

const heroCandidates = (d) => [d.header_image, d.capsule_imagev5, d.capsule_image].filter((u) => typeof u === 'string' && cdnUrl(u));

/**
 * Screenshot Steam (`screenshots[]`) -> [{ id, urls: [path_full, path_thumbnail] }] hanya host CDN Steam, tanpa duplikat.
 * path_full (1080p) dicoba lebih dulu; path_thumbnail hanya cadangan bila yang penuh gagal diunduh.
 */
export function screenshotCandidates(data) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(data.screenshots) ? data.screenshots : []) {
    const urls = [s?.path_full, s?.path_thumbnail].filter((u) => typeof u === 'string' && cdnUrl(u));
    if (!urls.length) continue;
    const id = urls[0].split('?')[0];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id: String(s.id ?? out.length), urls });
  }
  return out;
}

// Urutan percobaan per video: yang paling kecil dulu. Hanya MP4/WebM (HLS/DASH tidak didukung Marketplace).
const MOVIE_SOURCES = [['mp4', '480'], ['webm', '480'], ['mp4', 'max'], ['webm', 'max']];

/**
 * `movies[]` Steam -> [{ index, title, sources: [{ url, format, quality }] }]. SATU entri per video (bukan per format).
 * Setiap movie Steam berbentuk { id, name, thumbnail, highlight, webm: { 480, max }, mp4: { 480, max } }.
 * Trailer utama (highlight) didahulukan, selebihnya mengikuti urutan Steam. Video tanpa URL yang bisa dipakai dan duplikat dilewati.
 * `index` = posisi di daftar ini; dipakai klien untuk meminta tiap video satu per satu (POST /steam/:appId/video).
 */
export function movieCandidates(data) {
  const movies = Array.isArray(data?.movies) ? [...data.movies] : [];
  movies.sort((a, b) => Number(Boolean(b?.highlight)) - Number(Boolean(a?.highlight)));   // sort stabil: urutan Steam dipertahankan
  const out = [];
  const seen = new Set();
  for (const m of movies) {
    const sources = [];
    for (const [format, quality] of MOVIE_SOURCES) {
      const u = cdnUrl(m?.[format]?.[quality]);
      if (u) sources.push({ url: u.href, format, quality });
    }
    if (!sources.length) continue;
    const id = sources[0].url.split('?')[0];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ index: out.length, title: String(m?.name || '').slice(0, 120), sources });
  }
  return out;
}

/** Jalankan fn untuk tiap item dengan paralelisme terbatas; hasil berurutan sesuai input. fn tidak boleh melempar. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * Unduh SEMUA screenshot ke R2 (aset 'temp'). Satu gambar gagal tidak menghentikan yang lain (dihitung di `failed`).
 * path_full (1080p) dicoba lebih dulu, path_thumbnail hanya cadangan. Urutan hasil = urutan Steam.
 */
async function stageScreenshots(appId, cands) {
  const res = await mapLimit(cands, STAGE_CONCURRENCY, async (c) => {
    for (const src of c.urls) {
      try { return await stage(src, { kind: 'image', maxBytes: config.limits.imageBytes, timeoutMs: 20_000, name: `steam-${appId}-shot-${c.id}.jpg` }); }
      catch (err) { console.warn(`[steam] screenshot ${appId}/${c.id} gagal (${err?.message || err})`); }
    }
    return null;
  });
  const staged = res.filter(Boolean);
  return { staged, failed: res.length - staged.length };
}

/** Cocokkan genre/kategori Steam dengan kategori toko yang sudah ada (nama sama, tanpa peduli huruf). Tidak pernah membuat kategori baru. */
async function matchCategory(info) {
  const wanted = [...info.genres, ...info.steamCategories];
  if (!wanted.length) return null;
  try {
    const cats = await Category.find({ active: true }).select('name nameKey').lean();
    for (const g of wanted) {
      const c = cats.find((x) => x.nameKey === g.toLowerCase());
      if (c) return { id: String(c._id), name: c.name, via: g };
    }
  } catch (err) { console.warn(`[steam] cocokkan kategori gagal (${err?.message || err})`); }
  return null;
}

const warn = (field, message) => ({ field, message });

/**
 * Cari game dari Steam App ID dan siapkan semua data form.
 * Throw HttpError hanya untuk: ID tidak valid/tidak ditemukan, Steam tidak terjangkau.
 * Metadata/media yang kosong TIDAK menggagalkan: dikembalikan sebagai `warnings`.
 */
export async function searchApp(rawId) {
  if (!isValidAppId(rawId)) throw new HttpError(422, 'Steam App ID tidak valid.', { code: 'APPID_INVALID', hint: 'Isi angka saja, mis. 570 atau 1245620.' });
  const appId = String(Number(rawId)); // buang nol di depan
  const found = await lookup(appId);
  if (!found.found) {
    throw new HttpError(404, 'Steam App ID tidak valid.', {
      code: 'APPID_NOT_FOUND',
      hint: 'Steam tidak mengembalikan data untuk ID ini: ID salah, atau game tidak tersedia di Steam Store.',
    });
  }
  const d = found.data;
  const warnings = [];

  const name = String(d.name || '').trim().slice(0, 120);
  if (name.length < 2) warnings.push(warn('name', 'Nama game tidak tersedia dari Steam.'));

  const short = shortDescription(d.short_description);
  if (!short.text) warnings.push(warn('description', 'Deskripsi singkat tidak tersedia dari Steam.'));
  else if (short.truncated) warnings.push(warn('description', 'Deskripsi singkat dipotong agar muat 300 karakter.'));

  const about = aboutText(d.about_the_game || d.detailed_description);
  if (!about.text) warnings.push(warn('about', 'Deskripsi lengkap tidak tersedia dari Steam.'));
  else if (about.truncated) warnings.push(warn('about', 'Deskripsi lengkap dipotong agar muat 4000 karakter.'));

  const specs = parsePcRequirements(d.pc_requirements);
  if (!specs.min.rows.length) warnings.push(warn('specsMin', 'Persyaratan minimum tidak tersedia dari Steam.'));
  if (!specs.rec.rows.length) warnings.push(warn('specsRec', 'Persyaratan rekomendasi tidak tersedia dari Steam.'));
  if (specs.min.truncated + specs.rec.truncated) warnings.push(warn('specs', 'Beberapa nilai spesifikasi terlalu panjang dan dipotong. Periksa kembali.'));
  if (specs.min.dropped + specs.rec.dropped) warnings.push(warn('specs', 'Beberapa baris spesifikasi tanpa nilai atau melebihi 20 baris tidak dimasukkan.'));

  // Info game (Metacritic & website opsional: tidak diberi warning karena banyak game memang tidak punya)
  const info = parseGameInfo(d);
  if (!info.developer) warnings.push(warn('developer', 'Developer tidak tersedia dari Steam.'));
  if (!info.publisher) warnings.push(warn('publisher', 'Publisher tidak tersedia dari Steam.'));
  if (!info.releaseDate) warnings.push(warn('releaseDate', 'Tanggal rilis tidak tersedia dari Steam.'));
  if (!info.genres.length) warnings.push(warn('genres', 'Genre tidak tersedia dari Steam.'));
  const categoryMatch = await matchCategory(info);

  // Media: gambar utama + screenshot diunduh bersamaan (paralel terbatas); keduanya tidak saling menggagalkan.
  const heroes = heroCandidates(d);
  const shots = screenshotCandidates(d);
  let image = null;
  let screenshots = [];
  if (!heroes.length) warnings.push(warn('image', 'Steam tidak menyediakan gambar utama untuk game ini. Unggah gambar secara manual.'));
  if (!shots.length) warnings.push(warn('screenshots', 'Steam tidak menyediakan screenshot untuk game ini.'));

  if (!r2Configured()) {
    if (heroes.length || shots.length) warnings.push(warn('image', 'Gambar ditemukan, tetapi penyimpanan R2 belum dikonfigurasi di server. Unggah gambar secara manual.'));
  } else {
    const [heroRes, shotRes] = await Promise.all([
      (async () => {
        for (const src of heroes) {
          try { return await stage(src, { kind: 'image', maxBytes: config.limits.imageBytes, timeoutMs: 15_000, name: `steam-${appId}-header.jpg` }); }
          catch (err) { console.warn(`[steam] gambar ${appId} gagal (${err?.message || err})`); }
        }
        return null;
      })(),
      shots.length ? stageScreenshots(appId, shots) : { staged: [], failed: 0 },
    ]);
    image = heroRes;
    screenshots = shotRes.staged;
    if (heroes.length && !image) warnings.push(warn('image', 'Gambar utama ditemukan tetapi gagal diambil. Unggah gambar secara manual.'));
    if (shots.length && !screenshots.length) warnings.push(warn('screenshots', 'Screenshot ditemukan tetapi semuanya gagal diambil.'));
    else if (shotRes.failed) warnings.push(warn('screenshots', `${shotRes.failed} screenshot gagal diambil dan dilewati.`));
  }

  // Video: hanya dilaporkan (jumlah + daftar). Pengunduhan dilakukan terpisah, satu video per permintaan
  // (POST .../video { movie: index }) karena tiap video bisa puluhan MB; klien meminta semuanya satu per satu.
  const movies = movieCandidates(d);
  const video = movies.length
    ? { available: true, title: movies[0].title, count: movies.length, items: movies.map((m) => ({ index: m.index, title: m.title })) }
    : { available: false, count: 0, items: [] };
  if (!movies.length) warnings.push(warn('video', 'Video tidak tersedia, silakan upload manual.'));

  return {
    appId,
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
    name: name.length >= 2 ? name : '',
    description: short.text,
    about: about.text,
    specs: { min: specs.min.rows, rec: specs.rec.rows, source: 'Sumber: Steam' },
    info,
    categoryMatch,
    image,
    screenshots,
    screenshotsAvailable: shots.length,   // jumlah yang disediakan Steam (setelah host asing & duplikat dibuang)
    video,
    warnings,
    partial: warnings.length > 0,
  };
}

/**
 * Unduh SATU video Steam (movie ke-`movie`, default 0 = trailer utama) ke R2 sebagai aset 'temp'.
 * Klien memanggil ini untuk setiap index 0..count-1 sehingga semua video Steam masuk galeri.
 * Tidak melempar untuk kasus "tidak tersedia": mengembalikan { video: null, message, index, count }.
 */
export async function fetchVideo(rawId, movie = 0) {
  if (!isValidAppId(rawId)) throw new HttpError(422, 'Steam App ID tidak valid.', { code: 'APPID_INVALID' });
  const idx = Number(movie);
  if (!Number.isInteger(idx) || idx < 0) throw new HttpError(422, 'Nomor video tidak valid.', { code: 'MOVIE_INVALID' });
  const appId = String(Number(rawId));
  const found = await lookup(appId);
  if (!found.found) throw new HttpError(404, 'Steam App ID tidak valid.', { code: 'APPID_NOT_FOUND' });

  const UNAVAILABLE = 'Video tidak tersedia, silakan upload manual.';
  const movies = movieCandidates(found.data);
  const count = movies.length;
  const none = (message) => ({ video: null, message, index: idx, count });
  if (!r2Configured()) return none(`${UNAVAILABLE} (Penyimpanan R2 belum dikonfigurasi.)`);
  const m = movies[idx];
  if (!m) return none(UNAVAILABLE);

  let tooLarge = false;
  for (const c of m.sources) {
    if (tooLarge && c.quality === 'max') continue;   // versi 480 sudah melebihi batas; versi max pasti lebih besar
    try {
      const v = await stage(c.url, { kind: 'video', maxBytes: config.limits.videoBytes, timeoutMs: 90_000, name: `steam-${appId}-movie-${idx}.${c.format}` });
      return { video: { ...v, title: m.title }, message: '', index: idx, count };
    } catch (err) {
      if (err?.message === 'too-large') tooLarge = true;
      console.warn(`[steam] video ${appId}/${idx} (${c.format} ${c.quality}) gagal: ${err?.message || err}`);
    }
  }
  return none(tooLarge ? `${UNAVAILABLE} (Video Steam melebihi ${config.limits.videoBytes / 1048576} MB.)` : UNAVAILABLE);
}
