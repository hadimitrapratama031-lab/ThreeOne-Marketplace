import { Setting } from '../models/index.js';
import { settingSchemas } from '../lib/schemas.js';
import { parse, HttpError } from '../lib/http.js';
import { publicUrl } from '../lib/r2.js';
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

function withUrls(key, value) {
  if (key === 'branding') return { ...value, ...Object.fromEntries(BRANDING_FIELDS.map((f) => [f, mediaRef(value[f])])) };
  if (key === 'hero') return { ...value, covers: value.covers.map((c) => (c ? { key: c.key, url: publicUrl(c.key) } : null)) };
  if (key === 'socialShare') return { ...value, banner: mediaRef(value.banner) };
  return value;
}

const keysOf = (key, value) => {
  if (key === 'branding') return BRANDING_FIELDS.map((f) => value[f]?.key).filter(Boolean);
  if (key === 'hero') return value.covers.filter(Boolean).map((c) => c.key);
  if (key === 'socialShare') return value.banner?.key ? [value.banner.key] : [];
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

  if (value.banner) {
    // JPEG/PNG saja: beberapa platform (sebagian cache WhatsApp, sebagian bot share-preview) tidak selalu
    // merender og:image berformat WebP/AVIF/GIF. JPEG/PNG didukung SEMUA platform (WhatsApp, Discord,
    // Telegram, Facebook, X, dll) -> ini supaya banner pasti muncul di semua platform, bukan hanya sebagian.
    await assets.resolveForOwner([value.banner.key], owner, {
      folders: ['social'], max: 1, mimes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1048576,
    });
  }

  const $set = {};
  if (value.banner !== undefined) $set['value.banner'] = value.banner ? { key: value.banner.key } : null;
  if (value.defaultTitle !== undefined) $set['value.defaultTitle'] = value.defaultTitle;
  if (value.defaultDescription !== undefined) $set['value.defaultDescription'] = value.defaultDescription;
  if (value.pages !== undefined) $set['value.pages'] = { ...DEFAULTS.socialShare.pages, ...current.pages, ...value.pages };
  if (Object.keys($set).length) await Setting.findOneAndUpdate({ key: 'socialShare' }, { $set }, { upsert: true, new: true });

  // Kunci yang dipakai dihitung dari data yang benar-benar tersimpan, bukan dari input (aman saat dua kartu disimpan bersamaan)
  const stored = (await Setting.findOne({ key: 'socialShare' }).lean())?.value || {};
  await assets.attach(owner, keysOf('socialShare', { ...DEFAULTS.socialShare, ...stored }));
  return getSetting('socialShare');
}

/** Bentuk publik: tanpa key R2 (hanya URL). */
export function publicSetting(key, value) {
  if (key === 'branding') {
    return { name: value.name, siteTitle: value.siteTitle, logoUrl: value.logo?.url ?? null, footerLogoUrl: value.footerLogo?.url ?? null, faviconUrl: value.favicon?.url ?? null };
  }
  if (key === 'hero') return { ...value, covers: value.covers.map((c) => c?.url ?? null) };
  return value;
}
