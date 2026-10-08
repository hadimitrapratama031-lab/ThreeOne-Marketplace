import crypto from 'node:crypto';
import sharp from 'sharp';
import { Setting, Asset } from '../models/index.js';
import { settingSchemas } from '../lib/schemas.js';
import { parse, HttpError } from '../lib/http.js';
import { publicUrl, putObject, getObjectBuffer } from '../lib/r2.js';
import * as assets from './assets.js';

/** Nilai awal = teks yang sebelumnya hardcoded di Marketplace. Angka statistik default 0 (tidak ditampilkan). */
export const DEFAULTS = {
  branding: { name: 'Marketplace', siteTitle: 'Marketplace', logo: null, footerLogo: null, favicon: null },
  hero: {
    eyebrow: 'Gaming Digital Marketplace',
    title: 'Temukan Game dan Produk Digital Favoritmu',
    desc: 'Temukan berbagai game dan produk digital dengan proses pembelian yang praktis dan aman.',
    primaryCta: { label: 'Jelajahi Produk', href: '#product' },
    secondaryCta: { label: 'Lihat Produk', href: '#product' },
    chips: ['Pembayaran aman', 'Proses cepat'],
    covers: [null, null, null],
  },
  stats: { support: '24/7' },
  sections: {
    products: { title: 'Produk Tersedia', subtitle: 'Pilih game, akun, dan tools digital. Stok dan harga diperbarui langsung.' },
    faq: { title: 'Pertanyaan Umum' },
    contact: { title: 'Hubungi Kami', subtitle: 'Ada kendala dengan pesanan? Kirim nomor pesanan Anda, tim kami siap membantu.' },
  },
  productPage: { notes: [], platforms: [] },   // completedOrders dihitung dari database order
  // Social Share / Open Graph: 1 banner global dipakai seluruh halaman Marketplace; title & description per halaman.
  // Default title/description per halaman (dipakai bila admin belum mengisi) ada di server/lib/meta.js, bukan di sini,
  // supaya nilainya dipakai juga oleh fallback saat dokumen settings belum ada.
  socialShare: {
    banner: null,
    defaultTitle: '',
    defaultDescription: '',
    pages: { home: { title: '', description: '' }, product: { title: '', description: '' }, rating: { title: '', description: '' }, faq: { title: '', description: '' }, contact: { title: '', description: '' }, track: { title: '', description: '' } },
  },
};

export const SETTING_KEYS = Object.keys(DEFAULTS);

// Pengaturan yang memuat gambar R2: lokasi key -> folder
const MEDIA_FOLDERS = { branding: ['branding'], hero: ['hero'] };

// Gambar branding: tiap field menyimpan hanya { key } di MongoDB; URL publik dibentuk dari key + R2_PUBLIC_URL saat dikirim.
const BRANDING_MEDIA = {
  logo: { label: 'Store logo', mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] },
  footerLogo: { label: 'Footer logo', mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] },
  // Favicon: ICO + format gambar yang didukung semua browser (AVIF dan SVG sengaja tidak dipakai), maks. 5 MB
  favicon: { label: 'Favicon', mimes: ['image/png', 'image/x-icon', 'image/webp', 'image/jpeg', 'image/gif'], maxBytes: 5 * 1048576 },
};
const BRANDING_FIELDS = Object.keys(BRANDING_MEDIA);
const mediaRef = (m) => (m?.key ? { key: m.key, url: publicUrl(m.key) } : null);
// Banner Social Share ikut membawa ukuran asli (bila diketahui) untuk og:image:width/height
const ogRef = (o) => (o?.key ? { key: o.key, url: publicUrl(o.key), width: o.width, height: o.height } : null);
const bannerRef = (m) => (m?.key ? { ...mediaRef(m), ...(m.width && m.height ? { width: m.width, height: m.height } : {}), og: ogRef(m.og) } : null);

function withUrls(key, value) {
  if (key === 'branding') return { ...value, ...Object.fromEntries(BRANDING_FIELDS.map((f) => [f, mediaRef(value[f])])) };
  if (key === 'hero') return { ...value, covers: value.covers.map((c) => (c ? { key: c.key, url: publicUrl(c.key) } : null)) };
  if (key === 'socialShare') return { ...value, banner: bannerRef(value.banner) };
  return value;
}

const keysOf = (key, value) => {
  if (key === 'branding') return BRANDING_FIELDS.map((f) => value[f]?.key).filter(Boolean);
  if (key === 'hero') return value.covers.filter(Boolean).map((c) => c.key);
  if (key === 'socialShare') return [value.banner?.key, value.banner?.og?.key].filter(Boolean);
  return [];
};

export async function getSetting(key) {
  const doc = await Setting.findOne({ key }).lean();
  const merged = { ...DEFAULTS[key], ...(doc?.value || {}) };
  return withUrls(key, merged);
}

export async function getAllSettings() {
  const docs = await Setting.find({}).lean();
  const byKey = new Map(docs.map((d) => [d.key, d.value]));
  const out = {};
  for (const key of SETTING_KEYS) out[key] = withUrls(key, { ...DEFAULTS[key], ...(byKey.get(key) || {}) });
  return out;
}

/** Simpan satu grup pengaturan: validasi -> verifikasi gambar R2 -> simpan MongoDB -> hapus gambar lama. */
export async function saveSetting(key, input) {
  const schema = settingSchemas[key];
  const value = parse(schema, input);
  const owner = { type: 'settings', id: key };
  if (key === 'branding') return saveBranding(value, owner);
  if (key === 'socialShare') return saveSocialShare(value, owner);
  const folders = MEDIA_FOLDERS[key];
  const keys = keysOf(key, value);
  if (keys.length) await assets.resolveForOwner(keys, owner, { folders, max: 3 });

  const stored = key === 'hero'
    ? { ...value, covers: value.covers.map((c) => (c ? { key: c.key } : null)) }
    : value;
  await Setting.findOneAndUpdate({ key }, { $set: { value: stored } }, { upsert: true, new: true });
  await assets.attach(owner, keys);
  return getSetting(key);
}

/**
 * Simpan branding secara parsial: hanya field yang dikirim yang berubah (Store logo, Footer logo, dan Favicon
 * disimpan dari kartu masing-masing tanpa saling menimpa). Gambar lama dilepas oleh assets.attach() setelah
 * data baru tersimpan.
 */
async function saveBranding(value, owner) {
  const current = (await Setting.findOne({ key: 'branding' }).lean())?.value || {};
  const merged = { ...DEFAULTS.branding, ...current, ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) };

  const mergedKeys = BRANDING_FIELDS.map((f) => merged[f]?.key).filter(Boolean);
  if (new Set(mergedKeys).size !== mergedKeys.length) {
    throw new HttpError(422, 'Satu gambar tidak bisa dipakai untuk dua bagian. Upload ulang untuk bagian lainnya.', { fields: {} });
  }

  // Verifikasi hanya gambar yang baru dikirim (format, ukuran, folder, kepemilikan, masih ada di R2)
  for (const f of BRANDING_FIELDS) {
    const ref = value[f];
    if (!ref) continue;
    try {
      await assets.resolveForOwner([ref.key], owner, { folders: ['branding'], max: 1, mimes: BRANDING_MEDIA[f].mimes, maxBytes: BRANDING_MEDIA[f].maxBytes });
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(err.status, `${BRANDING_MEDIA[f].label}: ${err.message}`, { ...(err.details || {}), fields: { [f]: err.message } });
      throw err;
    }
  }

  const $set = {};
  if (value.name !== undefined) $set['value.name'] = value.name;
  if (value.siteTitle !== undefined) $set['value.siteTitle'] = value.siteTitle;
  for (const f of BRANDING_FIELDS) if (value[f] !== undefined) $set[`value.${f}`] = value[f] ? { key: value[f].key } : null;
  if (Object.keys($set).length) await Setting.findOneAndUpdate({ key: 'branding' }, { $set }, { upsert: true, new: true });

  // Kunci yang dipakai dihitung dari data yang benar-benar tersimpan, bukan dari input (aman saat dua kartu disimpan bersamaan)
  const stored = (await Setting.findOne({ key: 'branding' }).lean())?.value || {};
  await assets.attach(owner, keysOf('branding', stored));
  return getSetting('branding');
}

/**
 * Simpan Social Share secara parsial: kartu Banner dan kartu Teks (judul/deskripsi per halaman) disimpan
 * terpisah, field yang tidak dikirim tetap dipertahankan — sama seperti branding.
 */
async function saveSocialShare(value, owner) {
  const current = (await Setting.findOne({ key: 'socialShare' }).lean())?.value || {};

  let bannerDims = {};
  if (value.banner) {
    // JPEG/PNG saja: beberapa platform (sebagian cache WhatsApp, sebagian bot share-preview) tidak selalu
    // merender og:image berformat WebP/AVIF/GIF. JPEG/PNG didukung SEMUA platform (WhatsApp, Discord,
    // Telegram, Facebook, X, dll) -> ini supaya banner pasti muncul di semua platform, bukan hanya sebagian.
    const [asset] = await assets.resolveForOwner([value.banner.key], owner, {
      folders: ['social'], max: 1, mimes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1048576,
    });
    bannerDims = asset?.width && asset?.height ? { width: asset.width, height: asset.height } : {};
  }

  const $set = {};
  if (value.banner !== undefined) $set['value.banner'] = value.banner ? { key: value.banner.key, ...bannerDims } : null;
  if (value.defaultTitle !== undefined) $set['value.defaultTitle'] = value.defaultTitle;
  if (value.defaultDescription !== undefined) $set['value.defaultDescription'] = value.defaultDescription;
  if (value.pages !== undefined) $set['value.pages'] = { ...DEFAULTS.socialShare.pages, ...current.pages, ...value.pages };
  if (Object.keys($set).length) await Setting.findOneAndUpdate({ key: 'socialShare' }, { $set }, { upsert: true, new: true });

  if (value.banner) await ensureBannerRendition().catch((err) => console.error('[socialShare] rendition banner gagal:', err.message));

  // Kunci yang dipakai dihitung dari data yang benar-benar tersimpan, bukan dari input (aman saat dua kartu disimpan bersamaan)
  const stored = (await Setting.findOne({ key: 'socialShare' }).lean())?.value || {};
  await assets.attach(owner, keysOf('socialShare', { ...DEFAULTS.socialShare, ...stored }));
  return getSetting('socialShare');
}

/*
 * Rendition banner untuk preview link. WhatsApp (dan sebagian platform lain) diam-diam MEMBUANG og:image yang
 * terlalu besar (batas praktis ~300 KB; resmi Meta < 600 KB) -> link tampil tanpa banner. Admin boleh mengunggah
 * banner sampai 5 MB, jadi file ASLI tidak diubah/dihapus; bila ukurannya melewati OG_MAX_BYTES, dibuat satu salinan
 * JPEG (lebar maks 1200 px, tanpa crop, kualitas diturunkan bertahap HANYA sampai muat) yang dipakai og:image.
 * Banner yang sudah kecil dipakai apa adanya. Hasil disimpan di setting (banner.og) dan tercatat sebagai Asset
 * milik settings/socialShare, jadi ikut terhapus otomatis saat banner diganti.
 */
export const OG_MAX_BYTES = 280 * 1024;
const renditionJobs = new Map();   // key banner -> Promise (hindari pembuatan ganda saat banyak crawler datang bersamaan)
const smallEnough = new Set();     // key banner yang sudah dipastikan tidak perlu rendition

async function renderOg(original) {
  for (const width of [1200, 1000, 800]) {
    for (const quality of [88, 80, 72, 64]) {
      const { data, info } = await sharp(original).rotate().resize({ width, withoutEnlargement: true }).flatten({ background: '#ffffff' })
        .jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      if (data.length <= OG_MAX_BYTES) return { data, width: info.width, height: info.height };
    }
  }
  throw new Error('banner tidak dapat diperkecil sampai batas aman — gunakan gambar yang lebih sederhana');
}

/** Pastikan banner tersimpan punya rendition bila perlu. Mengembalikan { key, url, width, height } atau null (pakai file asli). */
export async function ensureBannerRendition(knownKey = '') {
  if (knownKey && smallEnough.has(knownKey)) return null;   // jalur cepat tiap request: tanpa query database
  const doc = (await Setting.findOne({ key: 'socialShare' }).lean())?.value;
  const banner = doc?.banner;
  if (!banner?.key) return null;
  if (banner.og?.key) return ogRef(banner.og);
  if (smallEnough.has(banner.key)) return null;
  if (renditionJobs.has(banner.key)) return renditionJobs.get(banner.key);

  const job = (async () => {
    const asset = await Asset.findOne({ key: banner.key }).lean();
    if (!asset || (asset.size || 0) <= OG_MAX_BYTES) { smallEnough.add(banner.key); return null; }
    const { data, width, height } = await renderOg(await getObjectBuffer(banner.key));
    const ogKey = banner.key.replace(/\.[a-z0-9]+$/i, '') + '-og.jpg';
    await putObject({ key: ogKey, body: data, contentType: 'image/jpeg' });
    await Asset.updateOne({ key: ogKey }, { $set: {
      key: ogKey, url: publicUrl(ogKey), kind: 'image', mime: 'image/jpeg', size: data.length, width, height, folder: 'social',
      originalName: 'og-rendition.jpg', status: 'used', owner: { type: 'settings', id: 'socialShare' },
    } }, { upsert: true });
    // Hanya tulis bila banner di database belum diganti selama proses berjalan
    const res = await Setting.updateOne({ key: 'socialShare', 'value.banner.key': banner.key }, { $set: { 'value.banner.og': { key: ogKey, width, height } } });
    if (!res.matchedCount) { await assets.destroyAssets(await Asset.find({ key: ogKey })); return null; }
    return { key: ogKey, url: publicUrl(ogKey), width, height };
  })().finally(() => renditionJobs.delete(banner.key));
  renditionJobs.set(banner.key, job);
  return job;
}

/** Bentuk publik: tanpa key R2 (hanya URL). */
export function publicSetting(key, value) {
  if (key === 'branding') {
    return { name: value.name, siteTitle: value.siteTitle, logoUrl: value.logo?.url ?? null, footerLogoUrl: value.footerLogo?.url ?? null, faviconUrl: value.favicon?.url ?? null };
  }
  if (key === 'hero') return { ...value, covers: value.covers.map((c) => c?.url ?? null) };
  return value;
}
