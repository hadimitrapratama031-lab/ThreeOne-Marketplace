import 'dotenv/config';
import crypto from 'node:crypto';

const e = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const list = (v) => (v ? v.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean) : []);
// Nilai yang disalin ke dashboard Railway sering terbawa spasi/baris baru/tanda kutip; itu membuat kredensial R2 tidak cocok.
const clean = (v) => (v ? String(v).trim().replace(/^(["'])(.*)\1$/s, '$2').trim() : '');
const trimSlash = (v) => clean(v).replace(/\/+$/, '');

const isProd = e.NODE_ENV === 'production';

export const config = {
  env: e.NODE_ENV || 'development',
  isProd,
  port: Number(e.PORT) || 3000,
  mongoUri: e.MONGODB_URI || '',
  // Dev tanpa APP_SECRET: rahasia sementara (sesi login hilang saat restart). Production wajib mengisi.
  appSecret: e.APP_SECRET || (isProd ? '' : crypto.randomBytes(32).toString('hex')),
  appSecretIsEphemeral: !e.APP_SECRET,
  sessionDays: Number(e.SESSION_DAYS) || 7,
  admin: { email: (e.ADMIN_EMAIL || '').trim().toLowerCase(), password: e.ADMIN_PASSWORD || '', name: e.ADMIN_NAME || 'Admin' },
  r2: {
    accountId: clean(e.R2_ACCOUNT_ID),
    accessKeyId: clean(e.R2_ACCESS_KEY_ID),
    secretAccessKey: clean(e.R2_SECRET_ACCESS_KEY),
    bucket: clean(e.R2_BUCKET_NAME),
    publicUrl: trimSlash(e.R2_PUBLIC_URL),
    endpoint: trimSlash(e.R2_ENDPOINT) || (clean(e.R2_ACCOUNT_ID) ? `https://${clean(e.R2_ACCOUNT_ID)}.r2.cloudflarestorage.com` : ''),
    forcePathStyle: bool(e.R2_FORCE_PATH_STYLE),
  },
  // Pembayaran (KlikQRIS). Kredensial diatur di Admin Web, bukan di env. Base URL hanya untuk uji otomatis.
  klikqrisBase: trimSlash(e.KLIKQRIS_BASE_URL) || 'https://klikqris.com/api',
  publicBaseUrl: trimSlash(e.PUBLIC_BASE_URL),
  // Provider notifikasi. Kredensial diatur di Admin Web; nilai env hanya cadangan (sama seperti project lama) dan base URL untuk uji.
  fonnteBase: trimSlash(e.FONNTE_BASE_URL) || 'https://api.fonnte.com',
  resendBase: trimSlash(e.RESEND_BASE_URL) || 'https://api.resend.com',
  envFallback: {
    fonnteToken: clean(e.FONNTE_TOKEN),
    resendApiKey: clean(e.RESEND_API_KEY),
    resendFromEmail: clean(e.RESEND_FROM_EMAIL),
    resendFromName: clean(e.RESEND_FROM_NAME),
    resendReplyTo: clean(e.RESEND_REPLY_TO),
    resendWebhookSecret: clean(e.RESEND_WEBHOOK_SECRET),
  },
  corsOrigins: list(e.CORS_ORIGINS),
  trustProxy: e.TRUST_PROXY !== undefined ? (Number.isNaN(Number(e.TRUST_PROXY)) ? e.TRUST_PROXY : Number(e.TRUST_PROXY)) : (isProd ? 1 : false),
  seedDemo: bool(e.SEED_DEMO),
  // Live Chat: berapa hari riwayat conversation EXPIRED disimpan (audit) sebelum pesan + gambar R2-nya dihapus. 0 = hapus segera.
  livechat: { retentionDays: Number.isFinite(Number(e.LIVECHAT_RETENTION_DAYS)) && e.LIVECHAT_RETENTION_DAYS !== undefined && e.LIVECHAT_RETENTION_DAYS !== '' ? Math.max(0, Number(e.LIVECHAT_RETENTION_DAYS)) : 7 },
  // Tidak ada batas JUMLAH media produk (gambar maupun video): hanya ukuran per file. Galeri Steam bisa berisi puluhan screenshot + banyak trailer.
  limits: { imageBytes: 8 * 1024 * 1024, videoBytes: 30 * 1024 * 1024 },
};

export const r2Configured = () =>
  Boolean(config.r2.accessKeyId && config.r2.secretAccessKey && config.r2.bucket && config.r2.publicUrl && config.r2.endpoint);

/** Kembalikan daftar masalah konfigurasi. Production gagal cepat bila ada yang fatal. */
export function checkConfig() {
  const fatal = [];
  const warn = [];
  if (!config.mongoUri) fatal.push('MONGODB_URI belum diisi.');
  if (isProd && config.appSecret.length < 32) fatal.push('APP_SECRET wajib diisi (minimal 32 karakter) di production.');
  if (!isProd && config.appSecretIsEphemeral) warn.push('APP_SECRET kosong: memakai rahasia sementara, sesi admin hilang saat server restart.');

  if (!r2Configured()) {
    (isProd ? fatal : warn).push('Cloudflare R2 belum lengkap (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL). Upload gambar dinonaktifkan.');
  } else {
    const pub = config.r2.publicUrl;
    if (/r2\.cloudflarestorage\.com/i.test(pub)) fatal.push('R2_PUBLIC_URL tidak boleh endpoint S3 privat (*.r2.cloudflarestorage.com). Pakai custom domain (disarankan untuk production) atau domain publik r2.dev (hanya uji coba).');
    if (isProd && !/^https:\/\//i.test(pub)) fatal.push('R2_PUBLIC_URL harus https di production.');
    if (isProd && /localhost|127\.0\.0\.1|\.railway\.internal/i.test(pub)) fatal.push('R2_PUBLIC_URL tidak boleh localhost / URL internal di production.');
  }
  if (isProd && (!config.admin.email || config.admin.password.length < 10)) {
    warn.push('ADMIN_EMAIL / ADMIN_PASSWORD (min 10 karakter) dipakai untuk membuat admin pertama. Abaikan bila admin sudah ada.');
  }
  return { fatal, warn };
}
