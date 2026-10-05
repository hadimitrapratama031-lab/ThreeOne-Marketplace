import { z } from 'zod';
import { objectIdStr } from './http.js';
import { CONTACT_ICONS } from '../models/index.js';

const str = (min, max) => z.string().trim().min(min).max(max);
const int = (min, max) => z.number().int().min(min).max(max);
const mediaRef = z.object({ key: z.string().min(3).max(200) });

// Tautan yang boleh: http(s), mailto, tel, anchor (#x) atau path internal (/x). Menolak javascript:, data:, dll.
export const href = z.string().trim().max(300).refine(
  (v) => v === '' || /^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[^\s]+|#[\w-]*|\/[^\s]*)$/i.test(v),
  'Tautan tidak valid (gunakan https://, mailto:, tel:, #bagian atau /halaman)',
);

export const specRows = z.array(z.object({ label: str(1, 60), value: str(1, 200) })).max(20);

export const productInput = z.object({
  name: str(2, 120),
  category: objectIdStr,
  price: int(0, 1_000_000_000),
  oldPrice: int(0, 1_000_000_000).nullable().optional().default(null),
  stock: int(0, 1_000_000),
  sold: int(0, 100_000_000).optional().default(0),
  active: z.boolean().optional().default(true),
  description: z.string().trim().max(300).optional().default(''),
  about: z.string().trim().max(4000).optional().default(''),
  specs: z.object({
    min: specRows.optional().default([]),
    rec: specRows.optional().default([]),
    source: z.string().trim().max(120).optional().default(''),
  }).optional().default({}),
  gameInfo: z.object({
    steamAppId: z.string().trim().regex(/^(\d{1,10})?$/, 'App ID hanya angka').optional().default(''),
    developer: z.string().trim().max(200).optional().default(''),
    publisher: z.string().trim().max(200).optional().default(''),
    releaseDate: z.string().trim().max(60).optional().default(''),
    genres: z.array(str(1, 40)).max(10).optional().default([]),
    metacritic: int(0, 100).nullable().optional().default(null),
  }).optional().default({}),
  media: z.array(mediaRef).optional().default([]),   // tanpa batas jumlah (gambar & video); key duplikat tetap ditolak di resolveForOwner
}).refine((v) => v.oldPrice == null || v.oldPrice > v.price, { path: ['oldPrice'], message: 'Harga coret harus lebih besar dari harga jual' });

export const productListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional().default(''),
  category: objectIdStr.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  stock: z.enum(['in', 'low', 'out']).optional(),
  sort: z.enum(['newest', 'oldest', 'updated', 'name', 'price_asc', 'price_desc', 'stock_asc', 'stock_desc']).default('newest'),
});

export const categoryInput = z.object({ name: str(2, 40), active: z.boolean().optional().default(true) });
export const faqInput = z.object({ question: str(3, 200), answer: str(1, 2000), active: z.boolean().optional().default(true) });
export const contactInput = z.object({
  label: str(1, 40),
  value: str(1, 120),
  href: href.optional().default(''),
  icon: z.enum(Object.keys(CONTACT_ICONS)).default('link'),
  active: z.boolean().optional().default(true),
});
export const statusInput = z.object({ active: z.boolean() });
export const reorderInput = z.object({ ids: z.array(objectIdStr).min(1).max(500) });

export const reviewInput = z.object({
  productId: int(1, 1_000_000_000),
  name: str(1, 60),
  stars: int(1, 5),
  text: str(1, 1000),
  date: z.coerce.date().optional(),
  status: z.enum(['published', 'hidden']).optional().default('published'),
  images: z.array(mediaRef).max(3).optional().default([]),
});
// Form ulasan dari pelanggan (multipart/form-data, jadi semua nilai datang sebagai string)
export const publicReviewInput = z.object({
  productId: z.coerce.number({ invalid_type_error: 'Pilih produk', required_error: 'Pilih produk' }).int('Pilih produk').min(1, 'Pilih produk').max(1_000_000_000, 'Pilih produk'),
  name: z.string({ required_error: 'Nama wajib diisi' }).trim().min(2, 'Nama minimal 2 karakter').max(60, 'Nama maksimal 60 karakter'),
  stars: z.coerce.number({ invalid_type_error: 'Pilih rating 1 sampai 5', required_error: 'Pilih rating 1 sampai 5' }).int('Pilih rating 1 sampai 5').min(1, 'Pilih rating 1 sampai 5').max(5, 'Pilih rating 1 sampai 5'),
  text: z.string({ required_error: 'Ulasan wajib diisi' }).trim().min(5, 'Ulasan minimal 5 karakter').max(1000, 'Ulasan maksimal 1000 karakter'),
});
export const publicReviewListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(30).default(8),
  productId: z.coerce.number().int().min(1).optional(),
  stars: z.coerce.number().int().min(1).max(5).optional(),
  sort: z.enum(['newest', 'oldest', 'stars_desc', 'stars_asc']).default('newest'),
});
export const reviewListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional().default(''),
  productId: z.coerce.number().int().optional(),
  stars: z.coerce.number().int().min(1).max(5).optional(),
  status: z.enum(['published', 'hidden']).optional(),
  sort: z.enum(['newest', 'oldest', 'stars_desc', 'stars_asc']).default('newest'),
});

const cta = z.object({ label: str(1, 40), href });
export const settingSchemas = {
  branding: z.object({ name: str(1, 40), siteTitle: str(1, 80), logo: mediaRef.nullable().default(null) }),
  hero: z.object({
    eyebrow: z.string().trim().max(60),
    title: str(1, 120),
    desc: z.string().trim().max(300),
    primaryCta: cta,
    secondaryCta: cta,
    chips: z.array(str(1, 40)).max(2),
    covers: z.array(mediaRef.nullable()).length(3),
  }),
  stats: z.object({ customers: int(0, 1_000_000_000), orders: int(0, 1_000_000_000), support: z.string().trim().max(20) }),
  sections: z.object({
    products: z.object({ title: str(1, 80), subtitle: z.string().trim().max(200) }),
    faq: z.object({ title: str(1, 80) }),
    contact: z.object({ title: str(1, 80), subtitle: z.string().trim().max(200) }),
  }),
  productPage: z.object({
    notes: z.array(str(1, 500)).max(4),
    platforms: z.array(z.object({ icon: z.enum(['windows', 'steam', 'store']), label: str(1, 24) })).max(6),
    completedOrders: int(0, 1_000_000_000),
  }),
};

export const loginInput = z.object({ email: z.string().trim().toLowerCase().email().max(120), password: z.string().min(1).max(200) });
export const profileInput = z.object({ name: str(1, 60), email: z.string().trim().toLowerCase().email().max(120) });
export const passwordInput = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10, 'Minimal 10 karakter').max(200) });
