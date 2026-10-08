/*
 * meta.js — Social Share / Open Graph untuk seluruh halaman Marketplace.
 *
 * Satu banner global (diatur Admin Web, lewat setting "socialShare") dipakai sebagai og:image / twitter:image
 * di SEMUA halaman. Title & description berbeda per halaman: override dari Admin (socialShare.pages.<page>)
 * atau, bila kosong, teks default di PAGE_DEFAULTS di bawah. Product Detail memakai nama + deskripsi produk
 * asli dari database (bukan teks statis).
 *
 * Dipakai oleh server/index.js saat menyajikan setiap halaman (lihat renderHtml/injectMeta di sana).
 */
import { getSetting } from '../services/settings.js';
import { getPublicBaseUrl } from '../services/paymentSettings.js';
import { resolvePublicOrigin, pagePath, PAGES, isPublicOrigin } from './urls.js';
import { imageSize } from './sniff.js';
import { config } from '../config/env.js';
import { memo } from './memo.js';
import { Product } from '../models/index.js';

export const SITE_NAME = '31Store';

// Teks bawaan per halaman (dipakai bila Admin belum mengisi override di Admin Web). Sesuai fungsi masing-masing
// halaman — bukan satu description generik untuk semua halaman.
export const PAGE_DEFAULTS = {
  home: {
    title: '31Store — Marketplace Game & Produk Digital',
    description: 'Temukan berbagai pilihan game dan produk digital di 31Store dengan proses pembelian yang mudah, informasi produk yang jelas, dan layanan yang siap membantu kebutuhan gaming kamu.',
  },
  product: {
    title: 'Produk Game & Digital — 31Store',
    description: 'Jelajahi berbagai produk game dan digital yang tersedia di 31Store. Temukan produk yang sesuai dengan kebutuhanmu, lihat detailnya, dan lanjutkan pembelian dengan mudah.',
  },
  rating: {
    title: 'Rating & Ulasan Pelanggan — 31Store',
    description: 'Lihat pengalaman, rating, dan ulasan dari pelanggan 31Store sebelum memilih produk game dan digital yang ingin kamu beli.',
  },
  // FAQ & Contact: saat ini '/faq' dan '/contact' adalah redirect 301 ke bagian di beranda (bukan halaman
  // tersendiri — lihat LEGACY di server/index.js), jadi preview share-nya akan memakai og:... dari Home
  // (hasil akhir redirect). Teks berikut disiapkan untuk Admin Web & dipakai bila kedua URL itu nanti
  // dijadikan halaman sendiri, tanpa perlu ubahan lain di sini.
  faq: {
    title: 'FAQ — Pertanyaan Umum Seputar 31Store',
    description: 'Temukan jawaban mengenai produk, proses pembelian, pembayaran, pesanan, serta informasi lainnya seputar layanan 31Store.',
  },
  contact: {
    title: 'Hubungi 31Store — Customer Support',
    description: 'Butuh bantuan mengenai produk, pembelian, pembayaran, atau pesanan? Hubungi tim 31Store melalui kontak yang tersedia.',
  },
  track: {
    title: 'Cek Pesanan — Lihat Status Transaksi | 31Store',
    description: 'Periksa status pesanan dan informasi transaksi kamu dengan mudah menggunakan ID transaksi atau email yang digunakan saat melakukan pembelian.',
  },
  // Checkout & Payment: satu URL dipakai untuk semua keadaan (menunggu/berhasil/gagal/kedaluwarsa — lihat
  // public/js/payment.js), jadi description-nya sengaja umum dan TIDAK PERNAH memuat data pesanan (sesuai
  // permintaan: tidak ada orderId/email/WhatsApp/nominal di metadata share).
  checkout: {
    title: 'Checkout Pesanan — 31Store',
    description: 'Selesaikan proses checkout pesanan kamu dengan aman dan mudah di 31Store.',
  },
  payment: {
    title: 'Pembayaran Pesanan — 31Store',
    description: 'Selesaikan pembayaran pesanan kamu melalui metode pembayaran yang tersedia di 31Store.',
  },
};

const TTL_MS = 5000;   // selaras dengan TTL memo publik lain (lib/memo.js dibagikan ke seluruh proses -> ikut invalidate saat settings:update)
// Teks meta = satu baris polos: tanpa tag HTML, newline, atau spasi ganda (deskripsi produk bisa berisi semuanya).
const clip = (s, max) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Platform (terutama Facebook/WhatsApp) hanya menerima URL gambar absolut HTTPS yang dapat dijangkau publik.
// Alamat lokal/dev (tes, localhost) dibiarkan apa adanya; alamat publik selalu dipaksa https.
const httpsIfPublic = (u) => (isPublicOrigin(u) ? String(u).replace(/^http:\/\//i, 'https://') : String(u || ''));

// Ukuran banner: dari data tersimpan; banner lama (diunggah sebelum ukuran dicatat) dibaca SEKALI dari URL publiknya —
// sekaligus pemeriksaan nyata bahwa URL itu HTTP 200, bertipe image/*, dan terbaca tanpa login. Key R2 tidak pernah
// berubah isinya (UUID), jadi hasilnya aman di-cache selamanya per key. Gagal -> ukuran dikosongkan (bukan angka tebakan).
const dimsCache = new Map();
async function bannerSize(banner) {
  if (banner.width && banner.height) return { width: banner.width, height: banner.height };
  if (dimsCache.has(banner.key)) return dimsCache.get(banner.key);
  let size = null;
  try {
    const r = await fetch(banner.url, { signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'MarketplaceMetaCheck/1.0' } });
    const type = r.headers.get('content-type') || '';
    if (!r.ok) console.error(`[meta] PERINGATAN: banner Social Share tidak dapat diambil (HTTP ${r.status}) ${banner.url}`);
    else if (!/^image\//i.test(type)) console.error(`[meta] PERINGATAN: Content-Type banner bukan gambar (${type || 'kosong'}) ${banner.url}`);
    else size = imageSize(Buffer.from(await r.arrayBuffer()));
  } catch (err) { console.error(`[meta] PERINGATAN: banner Social Share tidak terjangkau dari server: ${err.message}`); }
  if (size) { if (dimsCache.size > 50) dimsCache.clear(); dimsCache.set(banner.key, size); }
  return size;   // gagal tidak di-cache: dicoba lagi pada permintaan berikutnya
}

async function socialShareSetting() {
  const entry = await memo('meta:socialShare', TTL_MS, () => getSetting('socialShare'));
  return entry.value;
}

/** Judul + deskripsi untuk Product Detail: dari data produk asli (bukan teks statis). null bila produk tidak ada/disembunyikan. */
async function productMeta(productId, social) {
  const entry = await memo(`meta:product:${productId}`, TTL_MS, async () => {
    const n = Number(productId);
    if (!Number.isInteger(n) || n < 1) return null;
    return Product.findOne({ productId: n, active: true }, 'name description').lean();
  });
  const p = entry.value;
  if (!p) return null;
  const desc = clip(p.description, 300) || clip(social.defaultDescription, 300) || PAGE_DEFAULTS.product.description;
  return { title: `${clip(p.name, 150)} — ${SITE_NAME}`, description: desc, found: true };
}

/**
 * Meta Social Share untuk satu halaman. `page` salah satu dari PAGE_DEFAULTS (dan 'checkout'/'payment'
 * meski keduanya bukan bagian PAGES clean-URL biasa). `productId` hanya dipakai untuk page === 'product'.
 */
export async function buildMeta(req, page, { productId } = {}) {
  const social = await socialShareSetting();

  let title;
  let description;
  let isProduct = false;   // og:type 'product' hanya bila produknya benar-benar ada
  if (page === 'product' && productId != null) {
    const pm = await productMeta(productId, social).catch(() => null);
    if (pm) { ({ title, description } = pm); isProduct = true; }
  }
  if (title === undefined) {
    const override = social.pages?.[page] || {};
    const def = PAGE_DEFAULTS[page] || PAGE_DEFAULTS.home;
    title = clip(override.title, 100) || clip(social.defaultTitle, 100) || def.title;
    description = clip(override.description, 300) || clip(social.defaultDescription, 300) || def.description;
  }

  // og:url: SELALU alamat production bersih (tidak pernah localhost/preview/.html) — memakai helper URL yang
  // sama dengan tautan Email/WhatsApp (lib/urls.js + payment.publicBaseUrl), bukan generator URL baru.
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  let configuredBase = '';
  try { configuredBase = await getPublicBaseUrl(); } catch { /* URL publik Admin opsional */ }
  // Di belakang proxy berlapis (Cloudflare -> Railway) req.protocol bisa 'http': og:url tetap dipaksa https untuk domain publik.
  const origin = httpsIfPublic(resolvePublicOrigin({ configured: [configuredBase, config.publicBaseUrl], requestOrigin }) || requestOrigin);
  const path = page === 'product' && productId != null ? pagePath('product', { id: productId }) : (PAGES[page]?.path || '/');

  // Banner global: TIDAK pernah diganti gambar produk, dan bila Admin belum mengatur banner, og:image/twitter:image
  // sengaja dikosongkan (tidak ada gambar bawaan nyata di proyek ini untuk dijadikan fallback).
  const image = social.banner?.url ? httpsIfPublic(social.banner.url) : '';
  const size = image ? await bannerSize({ ...social.banner, url: image }) : null;
  // Dibatasi JPEG/PNG saat disimpan (lihat services/settings.js) justru supaya og:image ini pasti dikenali
  // SEMUA platform; og:image:type diisi dari ekstensi key yang tersimpan (bukan ditebak/di-hardcode).
  const imageType = image ? mimeOfKey(social.banner.key) : '';

  return {
    title,
    description,
    url: `${origin}${path}`,
    image,
    imageType,
    imageWidth: size?.width || 0,
    imageHeight: size?.height || 0,
    siteName: SITE_NAME,
    type: isProduct ? 'product' : 'website',
  };
}

const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const mimeOfKey = (key) => MIME_BY_EXT[String(key || '').split('.').pop().toLowerCase()] || 'image/jpeg';

/** Sisipkan <title> + og:/twitter: meta ke HTML halaman (dipanggil per request, HTML dasar tetap di-cache). */
export function injectMeta(html, meta) {
  const tags = [
    `<meta property="og:type" content="${escAttr(meta.type)}">`,
    `<meta property="og:site_name" content="${escAttr(meta.siteName)}">`,
    '<meta property="og:locale" content="id_ID">',
    `<meta property="og:title" content="${escAttr(meta.title)}">`,
    `<meta property="og:description" content="${escAttr(meta.description)}">`,
    meta.url ? `<meta property="og:url" content="${escAttr(meta.url)}">` : '',
    // og:image DAN og:image:secure_url (Facebook/beberapa platform lama khusus mencari secure_url untuk https) diisi URL yang sama.
    meta.image ? `<meta property="og:image" content="${escAttr(meta.image)}">` : '',
    meta.image ? `<meta property="og:image:secure_url" content="${escAttr(meta.image)}">` : '',
    meta.image && meta.imageType ? `<meta property="og:image:type" content="${escAttr(meta.imageType)}">` : '',
    meta.image && meta.imageWidth ? `<meta property="og:image:width" content="${meta.imageWidth}">` : '',
    meta.image && meta.imageHeight ? `<meta property="og:image:height" content="${meta.imageHeight}">` : '',
    meta.image ? `<meta property="og:image:alt" content="${escAttr(meta.siteName)}">` : '',
    `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`,
    meta.url ? `<meta name="twitter:url" content="${escAttr(meta.url)}">` : '',
    `<meta name="twitter:title" content="${escAttr(meta.title)}">`,
    `<meta name="twitter:description" content="${escAttr(meta.description)}">`,
    meta.image ? `<meta name="twitter:image" content="${escAttr(meta.image)}">` : '',
    meta.image ? `<meta name="twitter:image:alt" content="${escAttr(meta.siteName)}">` : '',
  ].filter(Boolean).join('\n  ');

  // Tambahan untuk mesin pencari: <meta name="description"> + canonical (bukan hanya og:). Pemanggilan replace memakai
  // FUNGSI, bukan string: deskripsi/judul produk boleh berisi "$&", "$'" dsb. yang kalau tidak akan dianggap pola
  // pengganti oleh String.replace dan merusak HTML (bagian halaman setelahnya ikut tersalin ke dalam meta).
  const seo = [
    `<meta name="description" content="${escAttr(meta.description)}">`,
    meta.url ? `<link rel="canonical" href="${escAttr(meta.url)}">` : '',
  ].filter(Boolean).join('\n  ');
  return html
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escAttr(meta.title)}</title>`)
    .replace('</head>', () => `  ${seo}\n  ${tags}\n</head>`);
}
