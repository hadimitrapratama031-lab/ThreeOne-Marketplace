import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { config, checkConfig } from './config/env.js';
import { Admin, syncAllIndexes } from './models/index.js';
import { initRealtime, closeRealtime } from './lib/realtime.js';
import { requireAdmin, originGuard, adminLimiter } from './middleware/security.js';
import { notFoundApi, errorHandler } from './middleware/errors.js';
import { sweepAssets } from './services/assets.js';
import { seedDemo } from './seed/seed.js';
import { CONTACT_ICONS } from './models/index.js';
import { r2Configured } from './config/env.js';
import { FOLDERS } from './services/assets.js';
import authRouter from './routes/auth.js';
import publicRouter from './routes/public.js';
import productsRouter from './routes/products.js';
import reviewsRouter from './routes/reviews.js';
import settingsRouter from './routes/settings.js';
import mediaRouter from './routes/media.js';
import dashboardRouter from './routes/dashboard.js';
import { categoriesRouter, faqRouter, contactsRouter } from './routes/content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_DIR = path.join(__dirname, '..', 'admin');

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  const r2Origin = config.r2.publicUrl ? new URL(config.r2.publicUrl).origin : null;
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:', ...(r2Origin ? [r2Origin] : [])],
        'media-src': ["'self'", 'blob:', ...(r2Origin ? [r2Origin] : [])],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ ok: dbUp, db: dbUp ? 'up' : 'down' });
  });

  const apiCors = config.corsOrigins.length ? cors({ origin: config.corsOrigins, credentials: true }) : (_req, _res, next) => next();
  app.use('/api', apiCors);
  app.use('/api/public', publicRouter);

  app.use('/api/admin/auth', originGuard, authRouter);
  const admin = express.Router();
  admin.use(originGuard, adminLimiter, requireAdmin);
  admin.get('/meta', (_req, res) => res.json({
    r2Ready: r2Configured(),
    contactIcons: CONTACT_ICONS,
    uploadFolders: FOLDERS,
    limits: { imageMB: config.limits.imageBytes / 1048576, videoMB: config.limits.videoBytes / 1048576, productMedia: 6, reviewImages: 3 },
  }));
  admin.use('/dashboard', dashboardRouter);
  admin.use('/products', productsRouter);
  admin.use('/categories', categoriesRouter);
  admin.use('/reviews', reviewsRouter);
  admin.use('/faq', faqRouter);
  admin.use('/contacts', contactsRouter);
  admin.use('/settings', settingsRouter);
  admin.use('/media', mediaRouter);
  app.use('/api/admin', admin);
  app.use('/api', notFoundApi);

  const html = { setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } };
  app.use('/admin', express.static(ADMIN_DIR, { index: 'index.html', maxAge: config.isProd ? '1h' : 0, ...html }));
  app.use(express.static(PUBLIC_DIR, { maxAge: config.isProd ? '1h' : 0, ...html }));

  app.use(errorHandler);
  return app;
}

async function ensureAdmin() {
  if (await Admin.countDocuments({})) return;
  const { email, password, name } = config.admin;
  if (!email || password.length < 10) {
    console.warn('[auth] Belum ada admin. Isi ADMIN_EMAIL dan ADMIN_PASSWORD (min 10 karakter) lalu restart untuk membuat admin pertama.');
    return;
  }
  await Admin.create({ email, name, passwordHash: await bcrypt.hash(password, 12) });
  console.log(`[auth] Admin pertama dibuat: ${email}`);
}

let sweeper;
export async function start({ port = config.port, quiet = false } = {}) {
  const { fatal, warn } = checkConfig();
  if (!quiet) warn.forEach((w) => console.warn(`[config] ${w}`));
  if (fatal.length) throw new Error(`Konfigurasi tidak valid:\n- ${fatal.join('\n- ')}`);

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  await syncAllIndexes();
  await ensureAdmin();
  if (config.seedDemo) {
    const r = await seedDemo();
    if (!quiet && !r.skipped) console.log(`[seed] ${r.products} produk contoh dibuat.`);
  }

  const server = http.createServer(createApp());
  initRealtime(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });

  sweeper = setInterval(() => sweepAssets().catch((e) => console.error('[sweep]', e.message)), 3600_000);
  sweeper.unref();
  const actualPort = server.address().port;
  if (!quiet) console.log(`Marketplace  http://localhost:${actualPort}\nAdmin Web    http://localhost:${actualPort}/admin`);

  const stop = async () => {
    clearInterval(sweeper);
    await closeRealtime();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
  };
  return { server, port: actualPort, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(({ stop }) => {
    const shutdown = () => stop().finally(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((err) => { console.error(err.message); process.exit(1); });
}
