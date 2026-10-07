/**
 * Integrasi Steam Store (satu-satunya di project ini). Dipanggil HANYA dari backend.
 *
 * Sumber data: endpoint publik Steam Store `https://store.steampowered.com/api/appdetails?appids=<id>`.
 * Tidak memakai API key apa pun, jadi tidak ada rahasia yang bisa bocor ke frontend.
 *
 * Alur media (SETELAH perubahan "media Steam = referensi eksternal"):
 *   - SCREENSHOT & VIDEO/TRAILER: TIDAK diunduh dan TIDAK diupload ke R2. Yang diambil hanya URL asli dari respons Steam
 *     (screenshots[].path_full, movies[].mp4/webm/hls, movies[].thumbnail) dan dikembalikan sebagai
 *     { type, source:'steam', url, ... }. Tidak ada batas ukuran MB, kompresi, resize, maupun batas jumlah.
 *   - GAMBAR UTAMA: tetap mengikuti sistem lama (disalin ke R2 sebagai aset 'temp' lewat services/assets.js, jadi milik produk
 *     setelah admin menekan Simpan), karena gambar utama dipakai kartu produk, email, dan pesanan yang mengambil file dari R2.
 *   - Trailer yang di respons Steam hanya membawa manifest (HLS/DASH) dan tanpa MP4/WebM: file progresif dicari lewat movie ID dan
 *     HANYA dipakai bila CDN Steam benar-benar menjawab ada (HEAD, tanpa mengunduh isi). Kandidat yang tidak ada dibuang.
 * Biner tidak pernah masuk MongoDB; yang tersimpan di produk hanyalah referensi.
 */
import { Asset, Category } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { config, r2Configured } from '../config/env.js';
import { uploadAsset, destroyAssets } from './assets.js';
import { aboutText, shortDescription, parsePcRequirements, parseGameInfo } from '../lib/steamParse.js';
import { cdnUrl, steamUrl, screenshotItems, movieDrafts, derivedMovieUrls, toVideoItem } from '../lib/steamMedia.js';

const STORE_API = 'https://store.steampowered.com/api/appdetails';
const TTL_FOUND = 10 * 60_000;     // data lama tidak boleh permanen
const TTL_MISSING = 2 * 60_000;    // "tidak ditemukan" di-cache lebih singkat
const CACHE_MAX = 300;

export const isValidAppId = (v) => /^\d{1,10}$/.test(String(v ?? '').trim()) && Number(v) > 0;

/* ---------- HTTP aman ---------- */

/** Unduh dengan batas ukuran & waktu (HANYA untuk gambar utama; media Steam lain tidak pernah diunduh). Redirect hanya diikuti bila tujuan tetap host CDN Steam yang diizinkan. */
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

export const clearSteamCache = () => { cache.clear(); inflight.clear(); stagedByUrl.clear(); probeCache.clear(); };

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
  const entry = pickEnvelope(json, appId);
  if (!entry || entry.success !== true || !entry.data || typeof entry.data !== 'object') return { found: false };
  return { found: true, data: entry.data };
}

/**
 * Pilih amplop jawaban appdetails untuk `appId`. Respons berbentuk { "<appid>": { success, data } }.
 * Ada laporan bahwa Steam kadang memberi label kunci dengan appid lain (mis. salah satu DLC) padahal isinya game yang diminta,
 * jadi isi (`data.steam_appid`) dicocokkan lebih dulu; bila tidak ada yang cocok, dipakai kunci yang diminta (ini yang menangani
 * appid yang dialihkan Steam, mis. 100 -> data milik 80). Perilaku lama tidak berubah untuk respons normal.
 */
function pickEnvelope(json, appId) {
  if (!json || typeof json !== 'object') return null;
  const byContent = Object.values(json).find((e) => e && typeof e === 'object' && e.success === true && e.data && typeof e.data === 'object' && String(e.data.steam_appid) === appId);
  return byContent || json[appId] || null;
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

/* ---------- Staging ke R2: HANYA gambar utama (screenshot & video Steam tidak pernah lewat sini) ---------- */

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

/* ---------- Media Steam (referensi eksternal) ---------- */

// Gambar utama = SATU-SATUNYA media Steam yang masih disalin ke R2 (sistem lama, lihat header file).
// Di appdetails, capsule_imagev5 = capsule_184x69 dan capsule_image = capsule_231x87: thumbnail kecil, BUKAN gambar galeri.
// Urutan kandidat dari resolusi asli terbesar: capsule_616x353 (di folder aset yang sama dengan header_image; tidak ada di semua game,
// jadi bila gagal diunduh dicoba berikutnya) -> header_image (460x215) -> capsule kecil hanya sebagai jalan terakhir.
const heroCandidates = (d) => {
  const header = typeof d.header_image === 'string' ? steamUrl(d.header_image) : null;
  const large = header ? header.replace(/[^/?]+(\?.*)?$/, 'capsule_616x353.jpg') : null;
  const out = [large, header, d.capsule_imagev5, d.capsule_image].filter((u) => typeof u === 'string' && cdnUrl(u));
  return [...new Set(out)];
};

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
 * Cek (tanpa mengunduh isi) apakah URL file video ada di CDN Steam: HEAD, redirect hanya ke host CDN Steam.
 * Dipakai HANYA untuk kandidat file progresif berbasis movie ID pada trailer yang tidak mendeklarasikan MP4/WebM.
 */
const probeCache = new Map();   // url -> { at, ok }
async function probe(url) {
  let u = cdnUrl(url);
  if (!u) return false;
  const cacheKey = u.href;
  const hit = probeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_FOUND) return hit.ok;
  let ok = false;
  try {
    const signal = AbortSignal.timeout(7_000);
    for (let hop = 0; hop <= 3; hop++) {
      const res = await fetch(u, { method: 'HEAD', redirect: 'manual', signal, headers: { accept: '*/*', 'user-agent': 'marketplace-admin/1.0' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        u = cdnUrl(new URL(res.headers.get('location'), u).href);
        if (!u) break;
        continue;
      }
      ok = res.ok && !/^text\//i.test(String(res.headers.get('content-type') || ''));
      break;
    }
  } catch { ok = false; }
  if (probeCache.size >= CACHE_MAX) probeCache.delete(probeCache.keys().next().value);
  probeCache.set(cacheKey, { at: Date.now(), ok });
  return ok;
}

/** Cadangan untuk trailer manifest-only: MP4 terbaik lalu WebM terbaik yang BENAR-BENAR ada di CDN Steam (maks 2 source). */
async function verifiedDerived(id) {
  const out = [];
  const tiers = derivedMovieUrls(id);
  for (const format of ['mp4', 'webm']) {
    found: for (const t of tiers.filter((x) => x.format === format)) {
      for (const url of t.urls) {
        if (await probe(url)) { out.push({ url, format: t.format, quality: t.quality }); break found; }
      }
    }
  }
  return out;
}

/**
 * Semua `movies[]` Steam -> [{ type:'video', source:'steam', url, poster, title, ref, sources[] }]. Satu entri per video, trailer utama dulu.
 * Tidak ada yang diunduh. Video tanpa source yang bisa diputar (mis. hanya DASH) dilewati dan dihitung di `skipped`.
 */
async function resolveMovies(data) {
  const drafts = movieDrafts(data);
  const items = await mapLimit(drafts, 4, async (d) => {
    // File "max" yang tidak dideklarasikan Steam dicari lewat movie ID (diverifikasi HEAD); yang tidak ada dibuang.
    const hasMax = d.progressive.some((s) => s.quality === 'max');
    const extra = !hasMax && d.id ? await verifiedDerived(d.id) : [];
    return toVideoItem(d, extra);   // poster = thumbnail asli dari respons Steam (tanpa tebakan URL)
  });
  const videos = items.filter(Boolean);
  return { videos, skipped: drafts.length - videos.length };
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

  // Media. Screenshot & video = URL asli Steam (tanpa unduh/upload R2). Hanya gambar utama yang disalin ke R2 (sistem lama).
  const heroes = heroCandidates(d);
  const screenshots = screenshotItems(d);
  if (!heroes.length) warnings.push(warn('image', 'Steam tidak menyediakan gambar utama untuk game ini. Unggah gambar secara manual.'));
  if (!screenshots.length) warnings.push(warn('screenshots', 'Steam tidak menyediakan screenshot untuk game ini.'));

  let image = null;
  if (heroes.length) {
    if (!r2Configured()) {
      warnings.push(warn('image', 'Gambar utama ditemukan, tetapi penyimpanan R2 belum dikonfigurasi di server. Unggah gambar secara manual.'));
    } else {
      for (const src of heroes) {
        try { image = await stage(src, { kind: 'image', maxBytes: config.limits.imageBytes, timeoutMs: 15_000, name: `steam-${appId}-header.jpg` }); break; }
        catch (err) { console.warn(`[steam] gambar ${appId} gagal (${err?.message || err})`); }
      }
      if (!image) warnings.push(warn('image', 'Gambar utama ditemukan tetapi gagal diambil. Unggah gambar secara manual.'));
    }
  }

  const { videos, skipped } = await resolveMovies(d);
  if (!videos.length) warnings.push(warn('video', 'Video tidak tersedia, silakan upload manual.'));
  else if (skipped) warnings.push(warn('videoSkipped', `${skipped} trailer Steam tidak punya format yang bisa diputar browser dan dilewati.`));

  return {
    appId,
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
    name: name.length >= 2 ? name : '',
    description: short.text,
    about: about.text,
    specs: { min: specs.min.rows, rec: specs.rec.rows, source: 'Sumber: Steam' },
    info,
    categoryMatch,
    image,                                   // gambar utama: aset R2 'temp' ({ type, key, url }) atau null
    screenshots,                             // [{ type:'image', source:'steam', url }] URL asli Steam
    screenshotsAvailable: screenshots.length,
    videos,                                  // [{ type:'video', source:'steam', url, poster, title, ref, sources[] }] URL asli Steam
    video: { available: videos.length > 0, count: videos.length },
    warnings,
    partial: warnings.length > 0,
  };
}
