import { Order, Product, Contact, NotificationLog, NOTIFICATION_EVENTS } from '../models/index.js';
import { publicUrl } from '../lib/r2.js';
import { config } from '../config/env.js';
import { tokenFor } from '../lib/orderToken.js';
import { pageUrl, resolvePublicOrigin } from '../lib/urls.js';
import { isValidWhatsApp, isValidEmail } from '../lib/phone.js';
import { emitAdmin } from '../lib/realtime.js';
import { getNotificationPrefs, getDiscordConfig } from './integrationSettings.js';
import { getPaymentConfig } from './paymentSettings.js';
import { getSetting } from './settings.js';
import * as fonnte from './fonnte.js';
import * as resend from './resend.js';
import * as discord from './discord.js';
import { embedContextImages } from './emailImages.js';
import * as T from './notificationTemplates.js';
import { codeOfOrder } from './codes.js';

/**
 * Notification Service — satu-satunya jalur keluar untuk WhatsApp (Fonnte) dan Email (Resend).
 * Port dari notification.service.js project lama; alurnya sama:
 *
 *   Event → bangun template → validasi tujuan → claim slot → kirim → simpan hasil → log + Socket.IO (admin)
 *
 * Empat event, sama dengan project lama: orderCreated, paymentSuccess, paymentFailed, paymentExpired.
 * Discord = channel ketiga (port discord.service.js lama), HANYA untuk paymentSuccess — batas yang sama dengan project lama:
 * orderCreated, paymentFailed, dan paymentExpired tidak pernah sampai ke Discord. Tujuannya channel server toko (Admin Web),
 * jadi yang divalidasi adalah keberadaan konfigurasi, bukan format nomor/email.
 * Tiap event punya channel dengan status sendiri; satu channel gagal tidak mempengaruhi channel lain.
 * Dipanggil HANYA setelah status order tersimpan, dan hanya oleh pemenang transisi status (lihat payments.js).
 */
export const SUPPORTED_EVENTS = NOTIFICATION_EVENTS;

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = (process.env.NOTIFICATION_BACKOFF_MS || '2000,6000').split(',').map((n) => Number(n) || 0);   // env hanya untuk uji
const STALE_CLAIM_MS = 2 * 60 * 1000;   // baris "sending" yatim (proses mati di tengah jalan) boleh di-claim ulang
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ idempotency */
/**
 * Meng-claim slot (orderId, event, channel) SEBELUM provider dipanggil. Penulisan atomic lewat unique index, bukan
 * pengecekan di memori: webhook/refresh/reconnect yang masuk bersamaan tidak bisa mengirim dua kali.
 */
async function claimSlot({ orderId, orderCode, event, channel, recipient }) {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  try {
    const doc = await NotificationLog.findOneAndUpdate(
      { orderId, event, channel, permanentFailure: { $ne: true }, $or: [{ status: { $in: ['pending', 'failed'] } }, { status: 'sending', claimedAt: { $lt: staleBefore } }] },
      { $setOnInsert: { orderCode: orderCode || '' }, $set: { status: 'sending', claimedAt: new Date(), recipient: recipient || '' }, $inc: { attempts: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { claimed: true, doc };
  } catch (err) {
    if (err?.code === 11000) return { claimed: false, doc: await NotificationLog.findOne({ orderId, event, channel }) };
    throw err;
  }
}

export const logView = (l) => ({
  id: String(l._id), orderId: String(l.orderId), orderCode: l.orderCode, event: l.event, channel: l.channel, status: l.status,
  recipient: l.recipient, attempts: l.attempts, error: l.error, templateSource: l.templateSource, deliveryStatus: l.deliveryStatus || 'unknown',
  sentAt: l.sentAt || null, failedAt: l.failedAt || null, createdAt: l.createdAt, updatedAt: l.updatedAt,
});

async function finish(logDoc, patch) {
  const updated = await NotificationLog.findByIdAndUpdate(logDoc._id, { $set: patch }, { new: true });
  if (updated) emitAdmin('notification:log', logView(updated));   // Socket.IO yang sudah ada (namespace admin)
  return updated;
}

const logLine = (level, meta) => console[level]('[Notification]', JSON.stringify(meta));   // tanpa token/API key

/* --------------------------------------------------------------- delivery */
async function deliverChannel({ order, event, channel, recipient, templateSource, send }) {
  const base = { orderId: order._id, orderCode: order.orderNo, event, channel, recipient };
  const valid = channel === 'whatsapp' ? isValidWhatsApp(recipient) : channel === 'discord' ? Boolean(recipient) : isValidEmail(recipient);
  if (!valid) {   // tujuan tidak valid = kesalahan data, tercatat sebagai gagal permanen tanpa memanggil provider
    const error = channel === 'discord' ? 'Channel Discord belum dikonfigurasi (token bot / Channel ID kosong).' : `Tujuan ${channel} tidak valid: ${recipient || '(kosong)'}`;
    const claim = await claimSlot(base);
    if (claim.claimed) await finish(claim.doc, { status: 'failed', permanentFailure: true, error, failedAt: new Date() });
    logLine('error', { orderCode: order.orderNo, event, channel, status: 'FAILED', error });
    return { channel, status: 'FAILED', error };
  }

  const claim = await claimSlot(base);
  if (!claim.claimed) {
    const ex = claim.doc;
    return { channel, status: ex?.status === 'sent' ? 'SENT' : 'SKIPPED', skipped: true };
  }

  const logDoc = claim.doc;
  const startingAttempts = logDoc.attempts;
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await send();
    if (last.success) {
      const resendMessageId = channel === 'email' && last.response?.id ? last.response.id : undefined;
      await finish(logDoc, {
        status: 'sent', sentAt: new Date(), attempts: startingAttempts + attempt - 1, error: '', providerResponse: last.response,
        permanentFailure: false, templateSource: templateSource || '', ...(resendMessageId ? { resendMessageId } : {}),
      });
      logLine('info', { orderCode: order.orderNo, event, channel, status: 'SENT' });
      return { channel, status: 'SENT' };
    }
    if (last.permanent) break;   // kredensial/tujuan salah: mengulang hanya mengulang kegagalan yang sama
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 0);
  }
  const error = last?.message || 'Pengiriman gagal tanpa keterangan dari provider.';
  await finish(logDoc, {
    status: 'failed', failedAt: new Date(), attempts: startingAttempts + (last?.permanent ? 0 : MAX_ATTEMPTS - 1), error,
    providerResponse: last?.response, templateSource: templateSource || '',
    permanentFailure: Boolean(last?.permanent && !last?.disabled),   // channel yang dimatikan admin bukan gagal permanen
  });
  logLine('error', { orderCode: order.orderNo, event, channel, status: 'FAILED', error });
  return { channel, status: 'FAILED', error };
}

/* ---------------------------------------------------------------- context */
const httpUrl = (u) => (/^https?:\/\//i.test(u || '') ? String(u).trim() : '');

async function loadContextInputs(order) {
  const [branding, pay, discordContact] = await Promise.all([
    getSetting('branding'),
    getPaymentConfig(),
    Contact.findOne({ active: true, icon: 'discord' }).sort({ order: 1 }).lean(),
  ]);
  let imageKey = order.product?.imageKey || '';
  if (!imageKey && order.product?.ref) {   // snapshot tanpa gambar: pakai gambar produk yang hidup (aset admin yang sama)
    const live = await Product.findById(order.product.ref).select('media').lean().catch(() => null);
    imageKey = (live?.media || []).find((m) => m.type === 'image' && m.key && m.source !== 'steam')?.key || '';
  }
  const origin = resolvePublicOrigin({ configured: [pay.publicBaseUrl, config.publicBaseUrl], requestOrigin: order.origin });
  // Sistem Code: code dibaca dari database saat pesan dibangun (bukan disalin ke log). Hanya dipakai event paymentSuccess.
  const redeemCode = order.product?.kind === 'code' ? await codeOfOrder(order._id) : '';
  return { branding, pay, discordHref: httpUrl(discordContact?.href), imageKey, redeemCode, origin };
}

/** Data mentah (Order + pengaturan) -> satu objek datar untuk WhatsApp dan Email. Semua nilai dari database. */
export function buildContext({ event, order, inputs }) {
  const { branding, pay, discordHref, imageKey, origin, redeemCode = '' } = inputs;
  const copy = T.EVENT_COPY[event];
  const logoRaw = branding.logo?.url || '';
  const productRaw = imageKey ? publicUrl(imageKey) : '';
  const waDigits = String(pay.waAdmin || '').replace(/\D/g, '');
  const waHref = waDigits ? `https://wa.me/${waDigits}` : '';

  const ctx = {
    event,
    storeName: branding.name || 'Store',
    storeTagline: '',
    logoUrl: logoRaw, logoUrlRaw: logoRaw,
    customerName: order.customer?.name || 'Pelanggan',
    customerEmail: order.customer?.email || '',
    customerWhatsApp: order.customer?.whatsapp || '',
    orderCode: order.orderNo,
    productName: order.product?.name || '',
    productImage: productRaw, productImageRaw: productRaw,
    quantity: 1,
    price: T.formatIDR(order.amount),
    // Yang ditagihkan gateway adalah total_amount (bisa memuat kode unik): angka di notifikasi = angka yang dibayar
    total: T.formatIDR(order.totalAmount || order.amount),
    paymentMethod: 'QRIS',
    redeemCode: event === 'paymentSuccess' ? redeemCode : '',   // kosong untuk event lain dan untuk produk biasa
    storeUrl: origin,
    statusLabel: copy ? copy.statusLabel : order.status,
    orderedAt: T.formatDateTime(order.createdAt),
    paidAt: T.formatDateTime(order.payment?.paidAt),
    expiredAt: T.formatDateTime(order.expiresAt),
    payUrl: '',
    waHref,
    waIcon: '', waIconRaw: '',
    waEnabled: Boolean(waHref),
    discordHref,
    discordIcon: '', discordIconRaw: '',
    discordEnabled: Boolean(discordHref),
    accent: copy ? copy.accent : '#6d3bee',
    accentSoft: copy ? copy.accentSoft : '#f1ecff',
  };
  ctx.subject = copy ? copy.subject(ctx) : `Update pesanan ${ctx.orderCode}`;
  // Halaman payment di project ini memerlukan token pelanggan; halaman yang sama menampilkan invoice/sukses
  const payPageUrl = origin && order.orderNo ? pageUrl(origin, 'payment', { query: { order: order.orderNo, t: tokenFor(order.orderNo) } }) : '';
  ctx.payUrl = payPageUrl;
  ctx.invoiceUrl = payPageUrl;
  ctx.waAdminChatUrl = waHref ? `${waHref}?text=${encodeURIComponent(`Halo Admin, saya ingin bertanya mengenai Order ${ctx.orderCode}`)}` : '';
  return ctx;
}

async function buildEmailPayload(baseCtx, custom, orderCode) {
  const emailCtx = { ...baseCtx };   // salinan: embedContextImages menulis ulang field gambar menjadi cid:
  const attachments = await embedContextImages(emailCtx, { orderCode });
  return { mail: T.resolveEmail(emailCtx, custom), attachments };
}

/* ------------------------------------------------------------------ entry */
export async function notifyOrderEvent(order, eventKey) {
  if (!order?._id) return { event: eventKey, results: [] };
  if (!SUPPORTED_EVENTS.includes(eventKey)) return { event: eventKey, results: [] };

  const prefs = await getNotificationPrefs();   // dibaca dari MongoDB tiap kali: perubahan Admin Web langsung berlaku
  if (!prefs.events[eventKey]) {
    logLine('warn', { orderCode: order.orderNo, event: eventKey, status: 'SKIPPED', error: 'event dinonaktifkan di Admin Web' });
    return { event: eventKey, results: [], disabled: true };
  }
  const ctx = buildContext({ event: eventKey, order, inputs: await loadContextInputs(order) });
  const results = [];

  if (prefs.whatsappEnabled) {
    const wa = T.resolveWhatsApp(ctx, prefs.templates.whatsapp[eventKey]);
    results.push(await deliverChannel({
      order, event: eventKey, channel: 'whatsapp', recipient: ctx.customerWhatsApp, templateSource: wa.source,
      send: () => fonnte.sendWhatsApp(ctx.customerWhatsApp, wa.text),
    }));
  } else results.push({ channel: 'whatsapp', status: 'SKIPPED' });

  if (prefs.emailEnabled) {
    const { mail, attachments } = await buildEmailPayload(ctx, prefs.templates.email[eventKey], order.orderNo);
    results.push(await deliverChannel({
      order, event: eventKey, channel: 'email', recipient: ctx.customerEmail, templateSource: mail.source,
      send: () => resend.sendEmail({ to: ctx.customerEmail, subject: mail.subject, html: mail.html, text: mail.text, entityRef: order.orderNo, attachments }),
    }));
  } else results.push({ channel: 'email', status: 'SKIPPED' });

  // Discord: HANYA paymentSuccess (lihat catatan di atas). Dibaca dari MongoDB tiap kali, jadi token/channel baru langsung dipakai.
  // Discord mati/error tidak pernah mengubah status order/payment: kegagalan hanya tercatat di NotificationLog.
  if (eventKey === 'paymentSuccess') {
    const dc = await getDiscordConfig();
    if (dc.ready) {
      results.push(await deliverChannel({
        order, event: eventKey, channel: 'discord', recipient: `channel:${dc.channelId}`, templateSource: 'builtin',
        send: () => discord.sendPaymentSuccess(ctx),
      }));
    } else {
      logLine('warn', { orderCode: order.orderNo, event: eventKey, channel: 'discord', status: 'SKIPPED', error: dc.enabled ? 'Channel ID Discord belum diisi' : 'Discord dinonaktifkan/belum dikonfigurasi di Admin Web' });
      results.push({ channel: 'discord', status: 'SKIPPED' });
    }
  }

  return { event: eventKey, orderCode: order.orderNo, results };
}

/**
 * Kirim di latar belakang: webhook KlikQRIS harus dibalas 200 secepatnya, kalau tidak gateway mengirim ulang.
 * Jaminan pengiriman ada di NotificationLog, bukan pada lamanya request.
 */
export function queueOrderEvent(order, eventKey) {
  setImmediate(() => {
    notifyOrderEvent(order, eventKey).catch((err) => console.error(`[Notification] gagal di luar dugaan (${order?.orderNo} ${eventKey}):`, err.message));
  });
}

/* ------------------------------------------------------- admin operations */
export async function listLogs({ orderNo, event, channel, status, page = 1, limit = 25 } = {}) {
  const filter = {};
  if (orderNo) filter.orderCode = String(orderNo).trim().toUpperCase();
  if (event) filter.event = event;
  if (channel) filter.channel = channel;
  if (status) filter.status = status;
  const [rows, total] = await Promise.all([
    NotificationLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-providerResponse').lean(),
    NotificationLog.countDocuments(filter),
  ]);
  return { items: rows.map(logView), total };
}

/** Retry manual SATU baris log; channel lain pada event yang sama tidak disentuh. */
export async function retryLog(logId) {
  const log = await NotificationLog.findById(logId);
  if (!log) return { success: false, code: 404, message: 'Log notifikasi tidak ditemukan.' };
  if (log.status === 'sent') return { success: false, code: 409, message: 'Notifikasi ini sudah terkirim — tidak dikirim ulang.' };
  const order = await Order.findById(log.orderId);
  if (!order) return { success: false, code: 404, message: 'Order untuk log ini sudah tidak ada.' };

  // Retry manual = keputusan sadar admin: tanda "gagal permanen" dibuka (mis. setelah token/nomor diperbaiki)
  await NotificationLog.findByIdAndUpdate(log._id, { $set: { permanentFailure: false, status: 'failed' } });
  const prefs = await getNotificationPrefs();
  const ctx = buildContext({ event: log.event, order, inputs: await loadContextInputs(order) });
  let result;
  if (log.channel === 'whatsapp') {
    const wa = T.resolveWhatsApp(ctx, prefs.templates.whatsapp[log.event]);
    result = await deliverChannel({ order, event: log.event, channel: 'whatsapp', recipient: ctx.customerWhatsApp, templateSource: wa.source, send: () => fonnte.sendWhatsApp(ctx.customerWhatsApp, wa.text) });
  } else if (log.channel === 'discord') {
    const dc = await getDiscordConfig();
    result = await deliverChannel({ order, event: log.event, channel: 'discord', recipient: dc.ready ? `channel:${dc.channelId}` : '', templateSource: 'builtin', send: () => discord.sendPaymentSuccess(ctx) });
  } else {
    const { mail, attachments } = await buildEmailPayload(ctx, prefs.templates.email[log.event], order.orderNo);
    result = await deliverChannel({
      order, event: log.event, channel: 'email', recipient: ctx.customerEmail, templateSource: mail.source,
      send: () => resend.sendEmail({ to: ctx.customerEmail, subject: mail.subject, html: mail.html, text: mail.text, entityRef: order.orderNo, attachments }),
    });
  }
  const ok = result.status === 'SENT';
  return { success: ok, code: ok ? 200 : 422, message: ok ? 'Notifikasi berhasil dikirim ulang.' : result.error || 'Pengiriman ulang gagal.', data: result };
}

/**
 * Merender keempat event untuk kedua channel lewat jalur resolver yang SAMA dengan pengiriman sungguhan, tanpa menyentuh
 * Fonnte/Resend. Pakai order sungguhan bila orderNo diisi; kalau tidak, contoh yang ditandai jelas sebagai contoh.
 */
export async function previewTemplates(orderNo) {
  const prefs = await getNotificationPrefs();
  let order = orderNo ? await Order.findOne({ orderNo: String(orderNo).trim().toUpperCase() }) : null;
  const usingSample = !order;
  if (usingSample) {
    const now = new Date();
    order = {
      orderNo: 'CONTOH-0001', customer: { name: 'Nama Pelanggan', email: 'pelanggan@contoh.com', whatsapp: '6281234567890' },
      product: { name: 'Nama Produk', imageKey: '' }, amount: 150000, totalAmount: 150016, createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000), payment: { paidAt: now }, origin: '',
    };
  }
  const inputs = await loadContextInputs(order);
  const events = SUPPORTED_EVENTS.map((event) => {
    const ctx = buildContext({ event, order, inputs });
    const wa = T.resolveWhatsApp(ctx, prefs.templates.whatsapp[event]);
    const mail = T.resolveEmail(ctx, prefs.templates.email[event]);
    return { event, whatsapp: { source: wa.source, text: wa.text }, email: { source: mail.source, subject: mail.subject, html: mail.html, text: mail.text } };
  });
  return { usingSample, orderCode: order.orderNo, events };
}
