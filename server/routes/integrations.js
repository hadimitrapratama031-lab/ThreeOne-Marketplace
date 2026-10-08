import { Router } from 'express';
import { asyncH, parse, HttpError, objectIdStr, pageMeta } from '../lib/http.js';
import { fonnteSettingsInput, resendSettingsInput, discordSettingsInput, notificationPrefsInput, templatesInput, testFonnteInput, testResendInput, notificationLogQuery } from '../lib/schemas.js';
import { getAdminView, saveFonnte, saveResend, saveDiscord, saveNotificationPrefs, saveTemplates, recordTest, recordDiscordConnection } from '../services/integrationSettings.js';
import * as fonnte from '../services/fonnte.js';
import * as resend from '../services/resend.js';
import * as discord from '../services/discord.js';
import { listLogs, retryLog, previewTemplates } from '../services/notifications.js';
import { emitAdmin } from '../lib/realtime.js';
import { config } from '../config/env.js';
import { getPaymentConfig } from '../services/paymentSettings.js';

/* ---------- /api/admin/integrations ---------- */
export const integrationsRouter = Router();

async function withMeta(view, req) {
  const pay = await getPaymentConfig();
  const base = (pay.publicBaseUrl || config.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return { ...view, resend: { ...view.resend, webhookUrl: `${base}/api/webhooks/resend` } };
}
// Satu pintu: simpan -> sinkron ke semua Admin Web yang terbuka lewat Socket.IO yang sudah ada
const publish = async (view, req) => { const v = await withMeta(view, req); emitAdmin('integrations:update', v); return v; };

integrationsRouter.get('/', asyncH(async (req, res) => res.json({ settings: await withMeta(await getAdminView(), req) })));

integrationsRouter.put('/fonnte', asyncH(async (req, res) => res.json({ settings: await publish(await saveFonnte(parse(fonnteSettingsInput, req.body)), req) })));
integrationsRouter.put('/resend', asyncH(async (req, res) => res.json({ settings: await publish(await saveResend(parse(resendSettingsInput, req.body)), req) })));
// Discord: semua perubahan dan uji lewat sini (hanya Admin — router ini dipasang di bawah autentikasi admin). Token tidak pernah ada di respons.
// Pemeriksaan koneksi dijalankan di latar belakang setelah simpan: status bot ikut tersiarkan realtime tanpa menahan request,
// dan kegagalannya tidak pernah menggagalkan penyimpanan.
async function checkDiscord(req) {
  const r = await discord.verifyConnection().catch((err) => ({ ok: false, message: 'Pemeriksaan koneksi gagal: ' + (err?.message || 'error') }));
  const view = await publish(await recordDiscordConnection(r), req);
  return { r, view };
}
integrationsRouter.put('/discord', asyncH(async (req, res) => {
  const view = await publish(await saveDiscord(parse(discordSettingsInput, req.body)), req);
  if (view.discord.configured) setImmediate(() => checkDiscord(req).catch(() => {}));
  res.json({ settings: view });
}));
integrationsRouter.post('/discord/check', asyncH(async (req, res) => {
  const { r, view } = await checkDiscord(req);
  res.status(r.ok ? 200 : 422).json({ ok: r.ok, message: r.message, settings: view });
}));
integrationsRouter.post('/discord/test', asyncH(async (req, res) => {
  const r = await discord.sendTestNotification();
  await publish(await recordTest('discord', r.success, r.message), req);
  res.status(r.success ? 200 : 422).json({ ok: r.success, message: r.message });
}));
integrationsRouter.post('/discord/test-dm', asyncH(async (req, res) => {
  const r = await discord.sendTestDirectMessage();
  await publish(await recordTest('discord', r.success, r.message), req);
  res.status(r.success ? 200 : 422).json({ ok: r.success, message: r.message });
}));

integrationsRouter.put('/notifications', asyncH(async (req, res) => res.json({ settings: await publish(await saveNotificationPrefs(parse(notificationPrefsInput, req.body)), req) })));
integrationsRouter.put('/templates', asyncH(async (req, res) => res.json({ settings: await publish(await saveTemplates(parse(templatesInput, req.body)), req) })));

integrationsRouter.post('/fonnte/test', asyncH(async (req, res) => {
  const { testTarget } = parse(testFonnteInput, req.body);
  const r = await fonnte.testConnection(testTarget);
  await publish(await recordTest('fonnte', r.success, r.message), req);
  res.status(r.success ? 200 : 422).json({ ok: r.success, message: r.message });
}));
integrationsRouter.post('/resend/test', asyncH(async (req, res) => {
  const { testTo } = parse(testResendInput, req.body);
  const r = await resend.testConnection(testTo);
  await publish(await recordTest('resend', r.success, r.message), req);
  res.status(r.success ? 200 : 422).json({ ok: r.success, message: r.message });
}));
integrationsRouter.get('/resend/domain-status', asyncH(async (_req, res) => {
  const r = await resend.getDomainStatus();
  res.status(r.success ? 200 : 502).json(r);
}));
integrationsRouter.get('/preview', asyncH(async (req, res) => res.json(await previewTemplates(String(req.query.orderNo || '')))));

/* ---------- /api/admin/notifications (log pengiriman) ---------- */
export const notificationsRouter = Router();

notificationsRouter.get('/', asyncH(async (req, res) => {
  const q = parse(notificationLogQuery, req.query);
  const { items, total } = await listLogs(q);
  res.json({ items, ...pageMeta(q.page, q.limit, total) });
}));
notificationsRouter.post('/:id/retry', asyncH(async (req, res) => {
  if (!objectIdStr.safeParse(req.params.id).success) throw new HttpError(404, 'Log notifikasi tidak ditemukan.');
  const r = await retryLog(req.params.id);
  res.status(r.code).json({ ok: r.success, message: r.message });
}));
