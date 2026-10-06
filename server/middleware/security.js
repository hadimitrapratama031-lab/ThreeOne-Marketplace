import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';
import { Admin } from '../models/index.js';
import { HttpError, asyncH } from '../lib/http.js';
import { SESSION_COOKIE, verifyToken } from '../lib/realtime.js';

export function signSession(admin) {
  return jwt.sign({ sub: String(admin._id), tv: admin.tokenVersion }, config.appSecret, { algorithm: 'HS256', expiresIn: `${config.sessionDays}d` });
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.sessionDays * 86_400_000,
    path: '/',
  });
}
export const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, { path: '/' });

export const requireAdmin = asyncH(async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  const payload = token && verifyToken(token);
  if (!payload) throw new HttpError(401, 'Sesi berakhir. Silakan login kembali.');
  const admin = await Admin.findById(payload.sub);
  if (!admin || admin.tokenVersion !== payload.tv) throw new HttpError(401, 'Sesi berakhir. Silakan login kembali.');
  req.admin = admin;
  req.auth = payload;
  next();
});

/** Tolak permintaan mutasi lintas-situs: header Origin harus sama dengan host sendiri atau CORS_ORIGINS. */
export function originGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next(); // klien non-browser (curl/test); cookie SameSite=Lax sudah melindungi browser
  const self = `${req.protocol}://${req.get('host')}`;
  if (origin === self || config.corsOrigins.includes(origin)) return next();
  next(new HttpError(403, 'Origin tidak diizinkan.'));
}

const limiterOpts = { standardHeaders: true, legacyHeaders: false };
export const loginLimiter = rateLimit({
  ...limiterOpts, windowMs: 15 * 60_000, limit: config.isProd ? 10 : 100, skipSuccessfulRequests: true,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.')),
});
export const adminLimiter = rateLimit({
  ...limiterOpts, windowMs: 60_000, limit: 600,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak permintaan. Coba lagi sebentar.')),
});
export const uploadLimiter = rateLimit({
  ...limiterOpts, windowMs: 60_000, limit: 60,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak upload. Coba lagi sebentar.')),
});
export const steamLimiter = rateLimit({
  ...limiterOpts, windowMs: 60_000, limit: 20,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak pencarian Steam. Coba lagi sebentar.')),
});
// Unduh media Steam ke R2: satu permintaan per video (game bisa punya belasan video), jadi batasnya lebih longgar daripada pencarian.
export const steamMediaLimiter = rateLimit({
  ...limiterOpts, windowMs: 60_000, limit: 120,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak unduhan media Steam. Coba lagi sebentar.')),
});
export const publicLimiter = rateLimit({
  ...limiterOpts, windowMs: 60_000, limit: 300,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak permintaan.')),
});
// Kirim ulasan oleh pelanggan (tanpa login): cukup longgar untuk pengguna biasa, cukup ketat untuk spam
export const reviewSubmitLimiter = rateLimit({
  ...limiterOpts, windowMs: 10 * 60_000, limit: config.isProd ? 8 : 200,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak ulasan dikirim. Coba lagi beberapa menit lagi.')),
});
export const telemetryLimiter = rateLimit({ ...limiterOpts, windowMs: 60_000, limit: 20, handler: (_req, res) => res.status(204).end() });

// Checkout publik: cukup longgar untuk pembeli biasa, cukup ketat agar tidak membanjiri transaksi KlikQRIS
export const checkoutLimiter = rateLimit({
  ...limiterOpts, windowMs: 10 * 60_000, limit: config.isProd ? 15 : 300,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak percobaan checkout. Coba lagi beberapa menit lagi.')),
});
export const orderReadLimiter = rateLimit({
  ...limiterOpts, windowMs: 60_000, limit: 240,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak permintaan. Coba lagi sebentar.')),
});
// Cek Pesanan: pencarian tanpa login, jadi dibatasi ketat agar ID/email tidak bisa ditebak beruntun
export const trackLimiter = rateLimit({
  ...limiterOpts, windowMs: 10 * 60_000, limit: config.isProd ? 30 : 300,
  handler: (_req, _res, next) => next(new HttpError(429, 'Terlalu banyak pencarian. Coba lagi beberapa menit lagi.')),
});
// Webhook server-ke-server dari KlikQRIS (dengan percobaan ulang) — batas longgar, tanpa originGuard
export const webhookLimiter = rateLimit({
  ...limiterOpts, windowMs: 60_000, limit: 600,
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'terlalu banyak permintaan' }),
});
