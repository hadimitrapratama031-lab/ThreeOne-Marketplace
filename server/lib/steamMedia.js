/**
 * Media Steam sebagai REFERENSI EKSTERNAL (tanpa unduh, tanpa upload ke R2).
 * Modul ini murni (tanpa database & jaringan): hanya membaca respons appdetails Steam dan memvalidasi URL.
 *
 * Bentuk media Steam yang disimpan di Product.media:
 *   { type: 'image', source: 'steam', url }
 *   { type: 'video', source: 'steam', url, poster, title, ref, sources: [{ url, format, quality }] }
 * Media upload manual tetap { type, key, url } (source 'upload') dan tetap lewat Cloudflare R2.
 *
 * Semua URL berasal dari respons Steam. Satu-satunya yang bukan salinan langsung adalah `derivedMovieUrls()` (cadangan
 * untuk trailer yang hanya membawa manifest): kandidatnya wajib diverifikasi ada di CDN Steam sebelum dipakai (lihat services/steam.js).
 */

const CDN_HOST = /(^|\.)(steamstatic\.com|akamaihd\.net)$/i;

/** URL CDN Steam yang aman dipakai, atau null. Hanya host *.steamstatic.com / *.akamaihd.net; `http:` dinaikkan ke `https:`. */
export const cdnUrl = (raw) => {
  try {
    const u = new URL(raw);
    if (!CDN_HOST.test(u.hostname)) return null;
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' ? u : null;
  } catch { return null; }
};

/** String URL Steam yang sudah tervalidasi (tanpa kredensial/port aneh, maks 1000 karakter), atau null. */
export const steamUrl = (raw) => {
  if (typeof raw !== 'string' || raw.length > 1000) return null;
  const u = cdnUrl(raw.trim());
  return u && !u.username && !u.password && !u.port ? u.href : null;
};

/** Kunci identitas URL tanpa query (`?t=` berubah tiap Steam memperbarui aset, path-nya tetap). */
export const urlKey = (u) => String(u || '').split('?')[0];

export const FORMAT_MIME = { mp4: 'video/mp4', webm: 'video/webm', hls: 'application/vnd.apple.mpegurl' };
/** Format yang bisa diputar langsung oleh <video> (dash tidak dipakai: butuh library). */
export const PLAYABLE = new Set(['mp4', 'webm', 'hls']);
export const FORMATS = ['mp4', 'webm', 'hls', 'dash'];

// Urutan preferensi: kualitas tertinggi dulu; MP4 (H.264) jalan di semua browser. HLS paling akhir (native hanya Safari/iOS).
const TIERS = [['mp4', 'max'], ['webm', 'max'], ['mp4', '480'], ['webm', '480']];
const MANIFESTS = [['hls_h264', 'hls'], ['dash_h264', 'dash'], ['dash_av1', 'dash']];

/** Screenshot Steam -> [{ type:'image', source:'steam', url }]. Semua entri, urutan Steam, tanpa duplikat. path_full dulu, thumbnail hanya bila full tidak ada. */
export function screenshotItems(data) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(data?.screenshots) ? data.screenshots : []) {
    const url = steamUrl(s?.path_full) || steamUrl(s?.path_thumbnail);
    if (!url) continue;
    const k = urlKey(url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ type: 'image', source: 'steam', url });
  }
  return out;
}

const movieIdOf = (m) => { const n = Number(m?.id); return Number.isSafeInteger(n) && n > 0 ? n : null; };

/**
 * `movies[]` Steam -> draf per video (trailer utama/highlight dulu, selebihnya urutan Steam; duplikat dibuang).
 * `progressive` = MP4/WebM yang DIDEKLARASIKAN Steam; `manifests` = HLS/DASH yang dideklarasikan Steam.
 */
export function movieDrafts(data) {
  const movies = Array.isArray(data?.movies) ? [...data.movies] : [];
  movies.sort((a, b) => Number(Boolean(b?.highlight)) - Number(Boolean(a?.highlight)));   // sort stabil
  const out = [];
  const seen = new Set();
  for (const m of movies) {
    const id = movieIdOf(m);
    const progressive = [];
    for (const [format, quality] of TIERS) {
      const url = steamUrl(m?.[format]?.[quality]);
      if (url && !progressive.some((s) => urlKey(s.url) === urlKey(url))) progressive.push({ url, format, quality });
    }
    const manifests = [];
    for (const [key, format] of MANIFESTS) {
      const url = steamUrl(m?.[key]);
      if (url) manifests.push({ url, format, quality: key.replace(/^(hls|dash)_/, '') });
    }
    if (!progressive.length && !manifests.length && !id) continue;
    const dedupe = id ? `id:${id}` : urlKey((progressive[0] || manifests[0]).url);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ id, title: String(m?.name || '').trim().slice(0, 120), poster: steamUrl(m?.thumbnail) || '', progressive, manifests });
  }
  return out;
}

/**
 * Pola file progresif di CDN Steam berbasis MOVIE ID, dipakai HANYA untuk trailer yang tidak mendeklarasikan MP4/WebM.
 * Kandidat belum tentu ada: pemanggil wajib memverifikasi (HEAD) sebelum menyimpannya. Urut sesuai TIERS.
 */
export function derivedMovieUrls(id) {
  const video = `https://video.akamai.steamstatic.com/store_trailers/${id}`;
  const cdn = `https://cdn.akamai.steamstatic.com/steam/apps/${id}`;
  return [
    { format: 'mp4', quality: 'max', urls: [`${video}/movie_max.mp4`, `${cdn}/movie_max.mp4`] },
    { format: 'webm', quality: 'max', urls: [`${video}/movie_max_vp9.webm`, `${cdn}/movie_max.webm`] },
    { format: 'mp4', quality: '480', urls: [`${video}/movie480.mp4`, `${cdn}/movie480.mp4`] },
    { format: 'webm', quality: '480', urls: [`${video}/movie480_vp9.webm`, `${cdn}/movie480_vp9.webm`, `${cdn}/movie480.webm`] },
  ];
}

/** Susun sources terurut: progresif (urutan TIERS) -> HLS -> DASH. */
const rank = (s) => {
  if (s.format === 'hls') return 100;
  if (s.format === 'dash') return 200;
  const i = TIERS.findIndex(([f, q]) => f === s.format && q === s.quality);
  return i < 0 ? 50 : i;
};
export const sortSources = (list) => [...list].sort((a, b) => rank(a) - rank(b));

/** Draf video + (opsional) kandidat turunan yang sudah TERVERIFIKASI -> item media, atau null bila tidak ada source yang bisa diputar. */
export function toVideoItem(draft, verifiedDerived = []) {
  const all = [...draft.progressive, ...verifiedDerived, ...draft.manifests];
  const seen = new Set();
  const sources = sortSources(all).filter((s) => { const k = urlKey(s.url); if (seen.has(k)) return false; seen.add(k); return true; });
  const best = sources.find((s) => PLAYABLE.has(s.format));
  if (!best) return null;
  return {
    type: 'video', source: 'steam', url: best.url, poster: draft.poster, title: draft.title,
    ref: draft.id ? String(draft.id) : '', sources,
  };
}

/**
 * Validasi + normalisasi satu referensi media Steam yang dikirim klien (dipakai skema zod).
 * Mengembalikan objek bersih atau string pesan error. Host selain CDN Steam ditolak, jadi data Steam palsu/URL sembarang tidak bisa masuk.
 */
export function cleanSteamRef(v) {
  if (v?.type !== 'image' && v?.type !== 'video') return 'Jenis media Steam tidak valid.';
  const url = steamUrl(v.url);
  if (!url) return 'URL media Steam tidak valid (hanya CDN resmi Steam).';
  if (v.type === 'image') return { source: 'steam', type: 'image', url };
  let poster = '';
  if (v.poster) { poster = steamUrl(v.poster); if (!poster) return 'URL thumbnail video Steam tidak valid.'; }
  const sources = [];
  for (const s of Array.isArray(v.sources) ? v.sources.slice(0, 12) : []) {
    const su = steamUrl(s?.url);
    if (!su || !FORMATS.includes(s?.format)) return 'Source video Steam tidak valid.';
    sources.push({ url: su, format: s.format, quality: String(s.quality || '').slice(0, 20) });
  }
  return {
    source: 'steam', type: 'video', url, poster, sources,
    title: String(v.title || '').trim().slice(0, 120),
    ref: /^\d{1,12}$/.test(String(v.ref ?? '')) ? String(v.ref) : '',
  };
}
