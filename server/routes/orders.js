import { Router } from 'express';
import { asyncH, parse, HttpError } from '../lib/http.js';
import { checkoutInput } from '../lib/schemas.js';
import { originGuard, checkoutLimiter, orderReadLimiter, webhookLimiter } from '../middleware/security.js';
import { createCheckout, getOrderForCustomer, handleWebhook } from '../services/payments.js';
import { getPublicPayment } from '../services/paymentSettings.js';

/* ---------- Publik: checkout & status order (/api/orders) ---------- */
export const ordersRouter = Router();
ordersRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Kesiapan pembayaran untuk halaman Checkout (tanpa rahasia)
ordersRouter.get('/config', orderReadLimiter, asyncH(async (_req, res) => {
  const { ready, mode } = await getPublicPayment();
  res.json({ ready, mode, expiryMinutes: 10 });
}));

ordersRouter.post('/', originGuard, checkoutLimiter, asyncH(async (req, res) => {
  if (String(req.body?.website || '').trim()) throw new HttpError(422, 'Data tidak valid');   // kolom jebakan bot
  const data = parse(checkoutInput, req.body);
  const result = await createCheckout(data, { requestBase: `${req.protocol}://${req.get('host')}` });
  res.status(201).json(result);
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
