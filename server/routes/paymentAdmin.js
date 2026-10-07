import { Router } from 'express';
import { asyncH, parse, HttpError, objectIdStr, pageMeta, escapeRegex } from '../lib/http.js';
import { paymentSettingsInput, adminOrderListQuery } from '../lib/schemas.js';
import { Order } from '../models/index.js';
import { getAdminPayment, savePaymentSettings, getPublicPayment } from '../services/paymentSettings.js';
import { admOrder, testGateway, deleteOrder } from '../services/payments.js';
import { emitAdmin, emitPublic } from '../lib/realtime.js';
import { config } from '../config/env.js';

/* ---------- /api/admin/payment-settings ---------- */
export const paymentSettingsRouter = Router();

const withWebhook = (data, req) => {
  const base = data.publicBaseUrl || config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  return { ...data, webhookUrl: `${base.replace(/\/$/, '')}/api/payments/klikqris/webhook` };
};

paymentSettingsRouter.get('/', asyncH(async (req, res) => res.json({ settings: withWebhook(await getAdminPayment(), req) })));

paymentSettingsRouter.put('/', asyncH(async (req, res) => {
  const saved = await savePaymentSettings(parse(paymentSettingsInput, req.body));
  const view = withWebhook(saved, req);
  // Backend membaca pengaturan dari MongoDB pada setiap transaksi, jadi perubahan langsung berlaku.
  // Sinkron: admin lain + halaman Payment yang terbuka (nomor WhatsApp Admin) lewat Socket.IO yang sudah ada.
  emitAdmin('payment-settings:update', view);
  const pub = await getPublicPayment();
  emitPublic('payment:settings', { waAdmin: pub.waAdmin });
  res.json({ settings: view });
}));

paymentSettingsRouter.post('/test', asyncH(async (_req, res) => res.json(await testGateway())));

/* ---------- /api/admin/orders ---------- */
export const adminOrdersRouter = Router();

adminOrdersRouter.get('/', asyncH(async (req, res) => {
  const q = parse(adminOrderListQuery, req.query);
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ orderNo: rx }, { 'customer.name': rx }, { 'customer.email': rx }, { 'customer.whatsapp': rx }, { 'product.name': rx }];
  }
  const [total, docs] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
  ]);
  res.json({ items: docs.map(admOrder), ...pageMeta(q.page, q.limit, total) });
}));

adminOrdersRouter.get('/:id', asyncH(async (req, res) => {
  if (!objectIdStr.safeParse(req.params.id).success) throw new HttpError(404, 'Pesanan tidak ditemukan.');
  const o = await Order.findById(req.params.id);
  if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan.');
  res.json({ item: admOrder(o) });
}));

// Hapus permanen pesanan dari database
adminOrdersRouter.delete('/:id', asyncH(async (req, res) => {
  if (!objectIdStr.safeParse(req.params.id).success) throw new HttpError(404, 'Pesanan tidak ditemukan.');
  const r = await deleteOrder(req.params.id);
  res.json({ ok: true, ...r });
}));
