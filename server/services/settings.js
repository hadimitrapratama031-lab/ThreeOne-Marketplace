import { Setting } from '../models/index.js';
import { settingSchemas } from '../lib/schemas.js';
import { parse } from '../lib/http.js';
import { publicUrl } from '../lib/r2.js';
import * as assets from './assets.js';

/** Nilai awal = teks yang sebelumnya hardcoded di Marketplace. Angka statistik default 0 (tidak ditampilkan). */
export const DEFAULTS = {
  branding: { name: 'Marketplace', siteTitle: 'Marketplace', logo: null },
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
  productPage: { notes: [], platforms: [], completedOrders: 0 },
};

export const SETTING_KEYS = Object.keys(DEFAULTS);

// Pengaturan yang memuat gambar R2: lokasi key -> folder
const MEDIA_FOLDERS = { branding: ['branding'], hero: ['hero'] };

function withUrls(key, value) {
  if (key === 'branding') return { ...value, logo: value.logo ? { key: value.logo.key, url: publicUrl(value.logo.key) } : null };
  if (key === 'hero') return { ...value, covers: value.covers.map((c) => (c ? { key: c.key, url: publicUrl(c.key) } : null)) };
  return value;
}

const keysOf = (key, value) => {
  if (key === 'branding') return value.logo ? [value.logo.key] : [];
  if (key === 'hero') return value.covers.filter(Boolean).map((c) => c.key);
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
  const folders = MEDIA_FOLDERS[key];
  const keys = keysOf(key, value);
  if (keys.length) await assets.resolveForOwner(keys, owner, { folders, max: 3 });

  const stored = key === 'hero'
    ? { ...value, covers: value.covers.map((c) => (c ? { key: c.key } : null)) }
    : key === 'branding' ? { ...value, logo: value.logo ? { key: value.logo.key } : null } : value;
  await Setting.findOneAndUpdate({ key }, { $set: { value: stored } }, { upsert: true, new: true });
  await assets.attach(owner, keys);
  return getSetting(key);
}

/** Bentuk publik: tanpa key R2 (hanya URL). */
export function publicSetting(key, value) {
  if (key === 'branding') return { name: value.name, siteTitle: value.siteTitle, logoUrl: value.logo?.url ?? null };
  if (key === 'hero') return { ...value, covers: value.covers.map((c) => c?.url ?? null) };
  return value;
}
