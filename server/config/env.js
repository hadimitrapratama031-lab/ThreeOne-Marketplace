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
  corsOrigins: list(e.CORS_ORIGINS),
  trustProxy: e.TRUST_PROXY !== undefined ? (Number.isNaN(Number(e.TRUST_PROXY)) ? e.TRUST_PROXY : Number(e.TRUST_PROXY)) : (isProd ? 1 : false),
  seedDemo: bool(e.SEED_DEMO),
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
