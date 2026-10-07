/*
 * urls.js — SATU-SATUNYA tempat yang tahu bentuk URL halaman Marketplace dan alamat publik toko.
 *
 * Clean URL (tanpa .html). File fisik di /public tetap *.html; server (server/index.js) yang memetakan
 * URL bersih -> file dan mengalihkan URL lama (/rating.html -> /rating) dengan query string utuh.
 * Pembuat tautan notifikasi (Email / WhatsApp / Live Chat) wajib lewat file ini, bukan menulis path sendiri.
 */
import { config } from '../config/env.js';

/** Path bersih tiap halaman. `file` = nama file HTML di /public (tanpa .html). */
export const PAGES = Object.freeze({
  home:     { path: '/',            file: 'index' },
  rating:   { path: '/rating',      file: 'rating' },
  product:  { path: '/product',     file: 'product' },    // detail: /product/<id>
  checkout: { path: '/checkout',    file: 'checkout' },
  payment:  { path: '/payment',     file: 'payment' },    // sukses / gagal / kedaluwarsa = keadaan di halaman yang sama
  track:    { path: '/cek-pesanan', file: 'track' },
});

const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i;
// Host sementara/internal/preview: boleh dipakai sebagai alamat yang DIKONFIGURASI admin, tetapi tidak boleh
// dipercaya bila hanya berasal dari header request (mis. checkout dibuka lewat domain Railway / preview).
const TEMP_HOST = /(\.local|\.internal|\.up\.railway\.app|\.vercel\.app|\.netlify\.app|\.onrender\.com|\.pages\.dev|\.trycloudflare\.com|\.loca\.lt|\.ngrok(-free)?\.(app|io|dev))$/i;

const originOf = (u) => {
  try { const x = new URL(String(u || '').trim()); return /^https?:$/.test(x.protocol) ? x.origin : ''; } catch { return ''; }
};
const hostOf = (o) => new URL(o).hostname;

/** Origin yang terjangkau dari internet (bukan localhost / *.local). */
export const isPublicOrigin = (u) => { const o = originOf(u); return Boolean(o) && !LOCAL_HOST.test(hostOf(o)) && !hostOf(o).endsWith('.local'); };

/**
 * Alamat publik toko untuk tautan yang dikirim ke pelanggan.
 * Urutan: alamat yang dikonfigurasi (Admin Web, PUBLIC_BASE_URL) -> origin request saat checkout (hanya bila domain publik asli)
 * -> alamat production bawaan (hanya di production). Tidak pernah localhost / URL internal / preview. '' bila tidak ada.
 */
export function resolvePublicOrigin({ configured = [], requestOrigin = '' } = {}) {
  for (const u of configured) if (isPublicOrigin(u)) return originOf(u);
  if (isPublicOrigin(requestOrigin) && !TEMP_HOST.test(hostOf(originOf(requestOrigin)))) return originOf(requestOrigin);
  return config.defaultPublicOrigin && isPublicOrigin(config.defaultPublicOrigin) ? originOf(config.defaultPublicOrigin) : '';
}

/** Path bersih halaman. pagePath('product', { id: 5 }) -> /product/5 */
export function pagePath(page, { id } = {}) {
  const p = PAGES[page];
  if (!p) throw new Error(`Halaman tidak dikenal: ${page}`);
  return page === 'product' && id != null && id !== '' ? `${p.path}/${encodeURIComponent(id)}` : p.path;
}

/**
 * URL absolut halaman: pageUrl(origin, 'payment', { query: { order, t } }) -> https://host/payment?order=..&t=..
 * Parameter query dipertahankan apa adanya (hanya di-encode); nilai kosong dilewati. '' bila origin kosong.
 */
export function pageUrl(origin, page, { id, query = {}, hash = '' } = {}) {
  const base = String(origin || '').replace(/\/+$/, '');
  if (!base) return '';
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}${pagePath(page, { id })}${qs ? `?${qs}` : ''}${hash ? `#${hash.replace(/^#/, '')}` : ''}`;
}
