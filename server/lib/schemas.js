import { z } from 'zod';
import { objectIdStr } from './http.js';
import { CONTACT_ICONS } from '../models/index.js';
import { normalizeWhatsapp } from './phone.js';
import { cleanSteamRef } from './steamMedia.js';

const str = (min, max) => z.string().trim().min(min).max(max);
const int = (min, max) => z.number().int().min(min).max(max);
const mediaRef = z.object({ key: z.string().min(3).max(200) });

// Media galeri produk (Tambah/Ubah produk): file upload R2 ({ key }) ATAU referensi eksternal Steam
// ({ source:'steam', type, url, ... }). Referensi Steam hanya diterima bila URL-nya host CDN resmi Steam; tidak ada pengecekan ukuran/jumlah.
export const productMediaRef = z.object({
  key: z.string().max(200).optional(),
  source: z.enum(['upload', 'steam']).optional(),
  type: z.string().max(10).optional(),
  url: z.string().max(1000).optional(),
  poster: z.string().max(1000).optional().nullable(),
  title: z.string().max(200).optional().nullable(),
  ref: z.union([z.string().max(20), z.number()]).optional().nullable(),
  sources: z.array(z.object({ url: z.string().max(1000), format: z.string().max(10), quality: z.union([z.string().max(20), z.number()]).optional().nullable() })).max(12).optional().nullable(),
}).superRefine((v, ctx) => {
  if (v.source === 'steam') {
    const r = cleanSteamRef(v);
    if (typeof r === 'string') ctx.addIssue({ code: 'custom', message: r });
  } else if (!v.key || v.key.length < 3) {
    ctx.addIssue({ code: 'custom', message: 'File media tidak valid.' });
  }
}).transform((v) => (v.source === 'steam' ? cleanSteamRef(v) : { source: 'upload', key: v.key }));

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
  media: z.array(productMediaRef).optional().default([]),   // tanpa batas jumlah (gambar & video); key R2 duplikat ditolak di resolveForOwner, URL Steam duplikat dibuang di services/productMedia.js
}).refine((v) => v.oldPrice == null || v.oldPrice > v.price, { path: ['oldPrice'], message: 'Harga coret harus lebih besar dari harga jual' });

export const productListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional().default(''),
  category: objectIdStr.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  stock: z.enum(['in', 'low', 'out']).optional(),
  sort: z.enum(['manual', 'newest', 'oldest', 'updated', 'name', 'price_asc', 'price_desc', 'stock_asc', 'stock_desc']).default('newest'),
});

/* ---------- Sistem Code ---------- */
// Stok TIDAK dikirim dari form: stok produk code = jumlah code available di database.
export const codeProductInput = z.object({
  name: str(2, 120),
  category: objectIdStr,
  price: int(1, 1_000_000_000),
  active: z.boolean().optional().default(true),
  description: z.string().trim().max(300).optional().default(''),
  about: z.string().trim().max(4000).optional().default(''),
  redeemTutorial: z.string().trim().max(4000).optional().default(''),
  media: z.array(mediaRef).optional().default([]),
  codes: z.string().max(400_000).optional().default(''),   // satu code per baris (hanya saat membuat produk)
});
export const codeProductUpdateInput = codeProductInput.omit({ codes: true });
export const addCodesInput = z.object({ codes: z.string({ required_error: 'Masukkan minimal satu code' }).max(400_000) });

// Edit satu code di Laporan Code. `confirm` wajib true bila code sudah diberikan ke pelanggan (dicek ulang di server).
export const codeEditInput = z.object({
  code: z.string({ required_error: 'Masukkan code' }).max(200),
  confirm: z.boolean().optional().default(false),
});

const codeStatus = z.enum(['available', 'sold']);   // sold = sudah diberikan ke pelanggan
export const codeListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  productId: z.coerce.number().int().min(1).optional(),
  status: codeStatus.optional(),
  order: z.string().trim().max(40).optional().default(''),
  email: z.string().trim().max(120).optional().default(''),
  customer: z.string().trim().max(60).optional().default(''),
  code: z.string().trim().max(100).optional().default(''),
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD').optional().or(z.literal('')).default(''),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD').optional().or(z.literal('')).default(''),
  sort: z.enum(['newest', 'oldest']).default('newest'),
});

export const categoryInput = z.object({ name: str(2, 40), active: z.boolean().optional().default(true) });
export const faqInput = z.object({ question: str(3, 200), answer: str(1, 2000), active: z.boolean().optional().default(true) });
export const contactInput = z.object({
  label: str(1, 40),
  value: str(1, 120),
  href: href.optional().default(''),
  icon: z.enum(Object.keys(CONTACT_ICONS)).default('link'),
  iconImage: mediaRef.nullable().optional(),   // tidak dikirim = tidak berubah; null = pakai ikon bawaan
  active: z.boolean().optional().default(true),
});
export const contactIconInput = z.object({ iconImage: mediaRef.nullable() });
export const statusInput = z.object({ active: z.boolean() });
export const moveInput = z.object({ to: z.enum(['up', 'down', 'top', 'bottom']) });
export const reorderInput = z.object({ ids: z.array(objectIdStr).min(1).max(500) });

export const reviewInput = z.object({
  productId: int(1, 1_000_000_000).nullish().transform((v) => v ?? null),
  name: str(1, 60),
  stars: int(1, 5),
  text: str(1, 1000),
  date: z.coerce.date().optional(),
  status: z.enum(['published', 'hidden']).optional().default('published'),
  images: z.array(mediaRef).max(3).optional().default([]),
});
// Form ulasan dari pelanggan (multipart/form-data, jadi semua nilai datang sebagai string)
export const publicReviewInput = z.object({
  // Produk opsional: kosong = ulasan umum (tanpa produk tertentu)
  productId: z.preprocess((v) => (v === '' || v == null ? undefined : v),
    z.coerce.number({ invalid_type_error: 'Produk tidak valid' }).int('Produk tidak valid').min(1, 'Produk tidak valid').max(1_000_000_000, 'Produk tidak valid').optional())
    .transform((v) => v ?? null),
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
  // Semua field opsional: tiap kartu di halaman Pengaturan hanya mengirim field miliknya dan field lain tidak berubah.
  // null = hapus gambar, tidak dikirim = biarkan.
  branding: z.object({
    name: str(1, 40).optional(),
    siteTitle: str(1, 80).optional(),
    logo: mediaRef.nullable().optional(),
    footerLogo: mediaRef.nullable().optional(),
    favicon: mediaRef.nullable().optional(),
  }),
  hero: z.object({
    eyebrow: z.string().trim().max(60),
    title: str(1, 120),
    desc: z.string().trim().max(300),
    primaryCta: cta,
    secondaryCta: cta,
    chips: z.array(str(1, 40)).max(2),
    covers: z.array(mediaRef.nullable()).length(3),
  }),
  stats: z.object({ support: z.string().trim().max(20) }),   // pelanggan & pesanan dihitung dari database order
  sections: z.object({
    products: z.object({ title: str(1, 80), subtitle: z.string().trim().max(200) }),
    faq: z.object({ title: str(1, 80) }),
    contact: z.object({ title: str(1, 80), subtitle: z.string().trim().max(200) }),
  }),
  productPage: z.object({
    notes: z.array(str(1, 500)).max(4),
    platforms: z.array(z.object({ icon: z.enum(['windows', 'steam', 'store']), label: str(1, 24) })).max(6),
  }),
  // Social Share / Open Graph. Semua field opsional: kartu banner dan kartu teks disimpan terpisah
  // (sama seperti `branding`), jadi menyimpan salah satu tidak menimpa field milik kartu lainnya.
  // '' pada title/description berarti "pakai default" (field dikosongkan oleh admin, bukan dihapus).
  socialShare: z.object({
    banner: mediaRef.nullable().optional(),
    defaultTitle: z.string().trim().max(100).optional(),
    defaultDescription: z.string().trim().max(300).optional(),
    pages: z.object({
      home: z.object({ title: z.string().trim().max(100), description: z.string().trim().max(300) }),
      product: z.object({ title: z.string().trim().max(100), description: z.string().trim().max(300) }),
      rating: z.object({ title: z.string().trim().max(100), description: z.string().trim().max(300) }),
      faq: z.object({ title: z.string().trim().max(100), description: z.string().trim().max(300) }),
      contact: z.object({ title: z.string().trim().max(100), description: z.string().trim().max(300) }),
      track: z.object({ title: z.string().trim().max(100), description: z.string().trim().max(300) }),
    }).partial().optional(),
  }),
};

export const loginInput = z.object({ email: z.string().trim().toLowerCase().email().max(120), password: z.string().min(1).max(200) });
export const profileInput = z.object({ name: str(1, 60), email: z.string().trim().toLowerCase().email().max(120) });
export const passwordInput = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10, 'Minimal 10 karakter').max(200) });

/* ---------- Checkout & pembayaran ---------- */
export const checkoutInput = z.object({
  productId: z.coerce.number({ invalid_type_error: 'Produk tidak valid', required_error: 'Produk tidak valid' }).int('Produk tidak valid').min(1, 'Produk tidak valid').max(1_000_000_000, 'Produk tidak valid'),
  name: z.string({ required_error: 'Nama wajib diisi' }).trim().min(2, 'Nama minimal 2 karakter').max(60, 'Nama maksimal 60 karakter'),
  email: z.string({ required_error: 'Email wajib diisi' }).trim().toLowerCase().min(1, 'Email wajib diisi').email('Format email belum benar').max(120, 'Email maksimal 120 karakter'),
  whatsapp: z.string({ required_error: 'Nomor WhatsApp wajib diisi' }).trim().min(1, 'Nomor WhatsApp wajib diisi').max(25, 'Nomor terlalu panjang')
    .transform((v) => normalizeWhatsapp(v))
    .refine((v) => v !== '', 'Nomor WhatsApp tidak valid (contoh: 0812 3456 7890)'),
  clientKey: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});

/* ---------- Cek Pesanan (pencarian publik) ---------- */
export const ORDER_NO_RE = /^MP-\d{6}-[A-Z0-9]{6}$/;
const orderNoField = z.string({ required_error: 'ID transaksi wajib diisi' }).trim()
  .min(1, 'ID transaksi wajib diisi').max(30, 'ID transaksi terlalu panjang')
  .transform((v) => {
    const t = v.toUpperCase().replace(/[\s_]+/g, '');
    const m = /^MP-?(\d{6})-?([A-Z0-9]{6})$/.exec(t);   // toleransi: tanpa tanda hubung / spasi
    return m ? `MP-${m[1]}-${m[2]}` : t;
  })
  .refine((v) => ORDER_NO_RE.test(v), 'Format ID transaksi belum benar (contoh: MP-260506-AB3CD4)');
const trackEmailField = z.string({ required_error: 'Email wajib diisi' }).trim().toLowerCase()
  .min(1, 'Email wajib diisi').max(120, 'Email maksimal 120 karakter').email('Format email belum benar');
export const trackInput = z.discriminatedUnion('by', [
  z.object({ by: z.literal('order'), q: orderNoField }),
  z.object({ by: z.literal('email'), q: trackEmailField }),
]);

const credSet = z.object({
  merchantId: z.string().trim().max(120).optional().default(''),
  apiKey: z.string().trim().max(400).optional().default(''),
  clearApiKey: z.boolean().optional().default(false),
});
export const paymentSettingsInput = z.object({
  mode: z.enum(['sandbox', 'production']),
  sandbox: credSet.optional().default({}),
  production: credSet.optional().default({}),
  waAdmin: z.string().trim().max(25).optional().default(''),
  publicBaseUrl: z.string().trim().max(200).optional().default(''),
});

export const adminOrderListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional().default(''),
  status: z.enum(['PENDING', 'SUCCESS', 'EXPIRED', 'FAILED']).optional(),
});

/* ---------- Laporan: Keuntungan Per Bulan ---------- */
const validDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00+07:00`));
const reportDay = z.string().trim().refine((v) => v === '' || validDay(v), 'Format tanggal harus YYYY-MM-DD').optional().default('');
const reportFilters = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  from: reportDay,
  to: reportDay,
  productId: z.coerce.number().int().min(1).optional(),
  category: z.string().trim().max(40).optional().default(''),
  payment: z.enum(['', 'ontime', 'late']).optional().default(''),   // semua yang dihitung sudah SUCCESS; ini hanya membedakan tepat waktu / terlambat
});
const reportRules = (s) => s
  .refine((q) => !q.month || q.year, { message: 'Pilih tahun terlebih dahulu', path: ['month'] })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'Tanggal akhir harus setelah tanggal awal', path: ['to'] });
export const monthlyReportQuery = reportRules(reportFilters);
export const monthlyDetailQuery = reportRules(reportFilters.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}));
export const reportMonthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Bulan harus berformat YYYY-MM');
export const clearMonthQuery = z.object({ asOf: z.string().trim().min(1).max(40) });

/* ---------- Integrasi: Fonnte, Resend, notifikasi ---------- */
const opt = (max) => z.string().trim().max(max).optional();
export const fonnteSettingsInput = z.object({
  enabled: z.boolean(),
  token: opt(300),
  clearToken: z.boolean().optional().default(false),
  testTarget: opt(25),
});
export const resendSettingsInput = z.object({
  enabled: z.boolean(),
  apiKey: opt(300),
  clearApiKey: z.boolean().optional().default(false),
  fromEmail: opt(120),
  fromName: opt(80),
  replyTo: opt(120),
  webhookSecret: opt(300),
  clearWebhookSecret: z.boolean().optional().default(false),
  testTo: opt(120),
});
const evKeys = ['orderCreated', 'paymentSuccess', 'paymentFailed', 'paymentExpired'];
export const notificationPrefsInput = z.object({
  whatsappEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  events: z.object(Object.fromEntries(evKeys.map((k) => [k, z.boolean().optional()]))).partial(),
});
export const templatesInput = z.object({
  whatsapp: z.object(Object.fromEntries(evKeys.map((k) => [k, z.string().max(4000).optional()]))).partial().optional(),
  email: z.object(Object.fromEntries(evKeys.map((k) => [k, z.object({ subject: z.string().max(200).optional(), html: z.string().max(60000).optional() }).optional()]))).partial().optional(),
});
export const testFonnteInput = z.object({ testTarget: z.string().trim().max(25).optional().default('') });
export const testResendInput = z.object({ testTo: z.string().trim().max(120).optional().default('') });
export const notificationLogQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  orderNo: z.string().trim().max(40).optional().default(''),
  event: z.enum(evKeys).optional(),
  channel: z.enum(['whatsapp', 'email']).optional(),
  status: z.enum(['pending', 'sending', 'sent', 'failed']).optional(),
});
