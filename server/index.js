import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
import { invalidate as invalidatePublicCache } from './lib/memo.js';
import { requireAdmin, originGuard, adminLimiter } from './middleware/security.js';
import { notFoundApi, errorHandler } from './middleware/errors.js';
import { sweepAssets } from './services/assets.js';
import { ensureProductOrder } from './services/productOrder.js';
import { r2EnvReport, probeR2 } from './lib/r2.js';
import { seedDemo } from './seed/seed.js';
import { CONTACT_ICONS } from './models/index.js';
import { r2Configured } from './config/env.js';
import { FOLDERS } from './services/assets.js';
import { getSetting } from './services/settings.js';
import authRouter from './routes/auth.js';
import publicRouter from './routes/public.js';
import productsRouter from './routes/products.js';
import reviewsRouter from './routes/reviews.js';
import settingsRouter from './routes/settings.js';
import mediaRouter from './routes/media.js';
import steamRouter from './routes/steam.js';
import dashboardRouter from './routes/dashboard.js';
import { ordersRouter, webhookRouter } from './routes/orders.js';
import { paymentSettingsRouter, adminOrdersRouter } from './routes/paymentAdmin.js';
import { startPaymentWorker, stopPaymentWorker } from './services/payments.js';
import { integrationsRouter, notificationsRouter } from './routes/integrations.js';
import webhooksRouter from './routes/webhooks.js';
import { categoriesRouter, faqRouter, contactsRouter } from './routes/content.js';
import { codeProductsRouter, codesRouter } from './routes/codes.js';
import { livechatPublicRouter, livechatAdminRouter } from './routes/livechat.js';
import { startLivechatWorker, stopLivechatWorker } from './services/livechat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_DIR = path.join(__dirname, '..', 'admin');

const STEAM_CDN = ['https://*.steamstatic.com', 'https://*.akamaihd.net'];

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
        // klikqris.com: gambar QRIS (qris_url) dimuat langsung dari KlikQRIS, tidak disalin ke R2
        // CDN Steam (*.steamstatic.com, *.akamaihd.net): screenshot, thumbnail & video Steam dimuat LANGSUNG dari Steam, tidak disalin ke R2
        'img-src': ["'self'", 'data:', 'blob:', 'https://klikqris.com', ...STEAM_CDN, ...(r2Origin ? [r2Origin] : [])],
        'media-src': ["'self'", 'blob:', ...STEAM_CDN, ...(r2Origin ? [r2Origin] : [])],
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
  // rawBody: byte mentah dibutuhkan untuk verifikasi signature webhook Resend (Svix)
  app.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/')) req.rawBody = buf; } }));

  app.get('/healthz', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ ok: dbUp, db: dbUp ? 'up' : 'down' });
  });

  const apiCors = config.corsOrigins.length ? cors({ origin: config.corsOrigins, credentials: true }) : (_req, _res, next) => next();
  // Favicon dinamis: halaman Marketplace menautkan /favicon.ico, server mengarahkannya ke favicon yang dipilih Admin (R2).
  // Dengan begitu tab browser langsung memakai favicon yang benar saat halaman dibuka, tanpa menunggu JavaScript.
  app.get('/favicon.ico', async (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    try {
      const { favicon } = await getSetting('branding');
      if (favicon?.url) return res.redirect(302, favicon.url);
    } catch { /* tanpa favicon */ }
    res.status(204).end();
  });

  app.use('/api', apiCors);
  app.use('/api/public', publicRouter);
  app.use('/api/livechat', livechatPublicRouter);                    // Live Chat pelanggan (token percakapan per pelanggan)
  app.use('/api/orders', ordersRouter);                              // checkout + status order (token pelanggan)
  app.use('/api/payments/klikqris/webhook', webhookRouter);
  app.use('/api/webhooks', webhooksRouter);                          // webhook status pengiriman email (Resend)          // callback server-ke-server dari KlikQRIS

  app.use('/api/admin/auth', originGuard, authRouter);
  const admin = express.Router();
  admin.use(originGuard, adminLimiter, requireAdmin);
  admin.get('/meta', (_req, res) => res.json({
    r2Ready: r2Configured(),
    contactIcons: CONTACT_ICONS,
    uploadFolders: FOLDERS,
    limits: { imageMB: config.limits.imageBytes / 1048576, videoMB: config.limits.videoBytes / 1048576, reviewImages: 3 },
  }));
  admin.use('/dashboard', dashboardRouter);
  admin.use('/products', productsRouter);
  admin.use('/categories', categoriesRouter);
  admin.use('/reviews', reviewsRouter);
  admin.use('/faq', faqRouter);
  admin.use('/contacts', contactsRouter);
  admin.use('/settings', settingsRouter);
  admin.use('/media', mediaRouter);
  admin.use('/steam', steamRouter);
  admin.use('/payment-settings', paymentSettingsRouter);
  admin.use('/orders', adminOrdersRouter);
  admin.use('/code-products', codeProductsRouter);
  admin.use('/codes', codesRouter);
  admin.use('/integrations', integrationsRouter);
  admin.use('/notifications', notificationsRouter);
  admin.use('/livechat', livechatAdminRouter);
  app.use('/api/admin', admin);
  app.use('/api', notFoundApi);

  // Aset Marketplace (css/js) diberi versi berdasarkan isi file: HTML menautkan `css/style.css?v=<hash>` dan URL itu di-cache
  // 1 tahun (immutable). Setelah deploy, HTML (selalu divalidasi ulang) membawa hash baru, jadi pengunjung langsung mendapat kode
  // terbaru TANPA harus mengunduh ulang aset yang tidak berubah di setiap halaman.
  const htmlCache = new Map();
  const hashCache = new Map();   // file -> { sig, hash }
  const hashOf = (file) => {
    const st = fs.statSync(file);
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = hashCache.get(file);
    if (hit?.sig === sig) return hit.hash;
    const hash = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
    hashCache.set(file, { sig, hash });
    return hash;
  };
  const ASSET_REF = /\b(href|src)="((?:css|js)\/[A-Za-z0-9._-]+\.(?:css|js))"/g;
  const renderHtml = (file) => {
    const st = fs.statSync(file);
    const hit = htmlCache.get(file);
    if (config.isProd && hit) return hit.html;
    const sig = `${st.mtimeMs}:${st.size}`;
    if (hit?.sig === sig && hit.deps.every((d) => hashOf(d.file) === d.hash)) return hit.html;
    const deps = [];
    const html = fs.readFileSync(file, 'utf8').replace(ASSET_REF, (m, attr, ref) => {
      const abs = path.join(PUBLIC_DIR, ref);
      try { const hash = hashOf(abs); deps.push({ file: abs, hash }); return `${attr}="${ref}?v=${hash}"`; } catch { return m; }
    });
    htmlCache.set(file, { sig, html, deps });
    return html;
  };
  app.get(/^\/(?:([A-Za-z0-9-]+)\.html)?$/, (req, res, next) => {
    const file = path.join(PUBLIC_DIR, `${req.params[0] || 'index'}.html`);
    if (!fs.existsSync(file)) return next();
    res.set('Cache-Control', 'no-cache');   // HTML selalu divalidasi ulang (ETag -> 304): deploy baru langsung terpakai
    res.type('html').send(renderHtml(file));
  });

  // File ber-versi (?v=...) = isinya tidak akan berubah di URL itu -> cache panjang. Tanpa ?v= tetap divalidasi ulang seperti semula.
  const assets = {
    setHeaders: (res, p) => {
      if (!/\.(html|js|css)$/.test(p)) return;
      res.setHeader('Cache-Control', /\.(js|css)$/.test(p) && res.req?.query?.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  };
  app.use('/admin', express.static(ADMIN_DIR, { index: 'index.html', maxAge: config.isProd ? '1h' : 0, ...assets, setHeaders: (res, p) => { if (/\.(html|js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.use(express.static(PUBLIC_DIR, { maxAge: config.isProd ? '1h' : 0, index: false, ...assets }));

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
  await ensureProductOrder();   // produk lama (sebelum fitur urutan) diberi posisi = urutan tampil sebelumnya (terbaru dulu)
  invalidatePublicCache();   // cache memori publik tidak boleh membawa data dari koneksi/database sebelumnya
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
  startLivechatWorker();   // percakapan 24 jam: expire tepat waktu (server-side) + bersihkan riwayat lama
  startPaymentWorker();   // kedaluwarsa tepat waktu + cek status KlikQRIS bila webhook terlambat
  const actualPort = server.address().port;
  if (!quiet) console.log(`Marketplace  http://localhost:${actualPort}\nAdmin Web    http://localhost:${actualPort}/admin`);
  if (!quiet) {
    // Tampilkan variable R2 yang terbaca (tanpa nilai rahasia) lalu uji tulis/baca/hapus nyata ke bucket.
    // Berjalan di latar belakang dan tidak pernah menjatuhkan server: kegagalan R2 hanya memengaruhi upload media.
    const rep = r2EnvReport();
    console.log(`[r2] konfigurasi terbaca:\n  ${rep.lines.join('\n  ')}`);
    rep.warn.forEach((w) => console.warn(`[r2] PERINGATAN: ${w}`));
    if (r2Configured()) probeR2().catch((e) => console.error('[r2] cek akses tidak dapat dijalankan:', e?.message));
  }

  const stop = async () => {
    clearInterval(sweeper);
    stopPaymentWorker();
    stopLivechatWorker();
    await closeRealtime();
    invalidatePublicCache();
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
