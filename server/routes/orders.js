import { Router } from 'express';
import { asyncH, parse, HttpError } from '../lib/http.js';
import { checkoutInput, trackInput } from '../lib/schemas.js';
import { originGuard, checkoutLimiter, orderReadLimiter, trackLimiter, webhookLimiter } from '../middleware/security.js';
import { createCheckout, getOrderForCustomer, handleWebhook, trackOrders, getTrackForWatch } from '../services/payments.js';
import { getPublicPayment } from '../services/paymentSettings.js';

/* ---------- Publik: checkout & status order (/api/orders) ---------- */
export const ordersRouter = Router();
ordersRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Kesiapan pembayaran untuk halaman Checkout (tanpa rahasia)
ordersRouter.get('/config', orderReadLimiter, asyncH(async (_req, res) => {
  const { ready, mode, waAdmin } = await getPublicPayment();
  res.json({ ready, mode, waAdmin, expiryMinutes: 10 });
}));

ordersRouter.post('/', originGuard, checkoutLimiter, asyncH(async (req, res) => {
  if (String(req.body?.website || '').trim()) throw new HttpError(422, 'Data tidak valid');   // kolom jebakan bot
  const data = parse(checkoutInput, req.body);
  const result = await createCheckout(data, { requestBase: `${req.protocol}://${req.get('host')}` });
  res.status(201).json(result);
}));

/* ---------- Cek Pesanan ---------- */
// POST (bukan GET) supaya email tidak masuk URL/log akses. Hasil ber-masking; 404 sama untuk ID maupun email yang tidak ada.
ordersRouter.post('/track', originGuard, trackLimiter, asyncH(async (req, res) => {
  if (String(req.body?.website || '').trim()) throw new HttpError(422, 'Data tidak valid');   // kolom jebakan bot
  const by = req.body?.by;
  if (by !== 'order' && by !== 'email') throw new HttpError(422, 'Data tidak valid', { fields: { by: 'Pilih ID Transaksi atau Email' } });
  const data = parse(trackInput, req.body);
  const result = await trackOrders(data);
  if (!result.orders.length) {
    throw new HttpError(404, by === 'order'
      ? 'Tidak ada pesanan dengan ID transaksi ini. Periksa kembali huruf dan angkanya.'
      : 'Tidak ada pesanan yang memakai email ini. Pastikan email sama dengan yang diisi saat checkout.');
  }
  res.json(result);
}));

// Satu order untuk Cek Pesanan (polling cadangan saat Socket.IO terputus). Token pantau lewat header, bukan query.
ordersRouter.get('/track/:orderNo', orderReadLimiter, asyncH(async (req, res) => {
  const order = await getTrackForWatch(req.params.orderNo, req.get('x-watch-token'));
  if (!order) throw new HttpError(404, 'Pesanan tidak ditemukan.');
  res.json({ order });
}));

// Token pelanggan lewat header (bukan query) supaya tidak tercatat di log akses
ordersRouter.get('/:orderNo', orderReadLimiter, asyncH(async (req, res) => {
  const order = await getOrderForCustomer(req.params.orderNo, req.get('x-order-token'));
  if (!order) throw new HttpError(404, 'Pesanan tidak ditemukan. Periksa kembali tautan pembayaran Anda.');
  res.json({ order });
}));

/* ---------- Webhook KlikQRIS (/api/payments/klikqris/webhook) ---------- */
export const webhookRouter = Router();
webhookRouter.post('/', webhookLimiter, asyncH(async (req, res) => {
  const r = await handleWebhook(req.body);
  res.status(r.code).json(r.body);
}));
