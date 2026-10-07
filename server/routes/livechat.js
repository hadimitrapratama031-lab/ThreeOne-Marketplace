import { Router } from 'express';
import multer from 'multer';
import { asyncH, parse, HttpError } from '../lib/http.js';
import { config, r2Configured } from '../config/env.js';
import { formatWhatsapp } from '../lib/phone.js';
import { CONVERSATION_ID_RE } from '../lib/livechatToken.js';
import { createConversationInput, messageInput, readInput, adminListQuery, livechatSettingsInput } from '../lib/livechatSchemas.js';
import { LiveChat } from '../models/index.js';
import { emitAdmin, emitPublic } from '../lib/realtime.js';
import { originGuard, publicLimiter, uploadLimiter, livechatCreateLimiter, livechatSendLimiter, livechatReadLimiter } from '../middleware/security.js';
import * as chat from '../services/livechat.js';
import { getLivechatSettings, saveLivechatSettings, recordLivechatTest, isLivechatEnabled } from '../services/livechatSettings.js';
import { sendTestNotification } from '../services/livechatNotify.js';
import { getAdminView as getIntegrationView } from '../services/integrationSettings.js';

const originOf = (req) => `${req.protocol}://${req.get('host')}`;

/** multipart satu gambar (field "image"). Batas ukuran dari config; tipe file diperiksa dari byte aslinya di service. */
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.limits.imageBytes, files: 1, fields: 6, parts: 8 } }).single('image');
function receiveImage(req, res, next) {
  imageUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      const msg = tooBig ? `Ukuran gambar terlalu besar (maksimal ${Math.round(config.limits.imageBytes / 1048576)} MB).` : 'Hanya satu gambar per pesan.';
      return next(new HttpError(tooBig ? 413 : 422, msg, { fields: { image: msg } }));
    }
    next(err);
  });
}
function requireR2ForImage(req, _res, next) {
  if (req.body?.type === 'image' && !r2Configured()) return next(new HttpError(503, 'Penyimpanan gambar belum tersedia. Kirim pesan teks atau coba lagi nanti.'));
  next();
}

/* ================================================================ Marketplace (pelanggan) — /api/livechat */
export const livechatPublicRouter = Router();
const pub = livechatPublicRouter;
pub.use(publicLimiter);
pub.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const tokenOf = (req) => String(req.get('x-livechat-token') || '');
const paramId = (req) => { const id = String(req.params.id || ''); if (!CONVERSATION_ID_RE.test(id)) throw new HttpError(404, 'Percakapan tidak ditemukan.'); return id; };

pub.get('/config', asyncH(async (_req, res) => res.json({ enabled: await isLivechatEnabled(), serverTime: new Date().toISOString() })));

pub.post('/conversations', originGuard, livechatCreateLimiter, asyncH(async (req, res) => {
  if (String(req.body?.website || '').trim()) throw new HttpError(422, 'Data tidak valid');   // kolom jebakan bot
  await chat.assertEnabled();
  const data = parse(createConversationInput, req.body);
  const { conv, token } = await chat.createConversation({ ...data, origin: originOf(req) });
  res.status(201).json({ token, ...(await chat.snapshotFor(conv)) });
}));

// Pemulihan sesi (refresh / tab baru / reconnect). Hanya pemegang token yang bisa membaca; expired -> 410.
pub.get('/conversations/:id', livechatReadLimiter, asyncH(async (req, res) => {
  const conv = await chat.authorize(paramId(req), tokenOf(req));
  await chat.assertEnabled();
  res.json(await chat.snapshotFor(conv));
}));

pub.post('/conversations/:id/messages', originGuard, livechatSendLimiter, receiveImage, requireR2ForImage, asyncH(async (req, res) => {
  const conv = await chat.authorize(paramId(req), tokenOf(req));
  await chat.assertEnabled();
  const data = parse(messageInput, req.body);
  const r = await chat.postMessage({ conv, sender: 'customer', ...data, file: req.file, origin: originOf(req) });
  res.status(r.duplicate ? 200 : 201).json({ message: chat.msgView(r.message), conversation: chat.customerView(r.conversation), duplicate: r.duplicate });
}));

pub.post('/conversations/:id/read', originGuard, livechatReadLimiter, asyncH(async (req, res) => {
  const conv = await chat.authorize(paramId(req), tokenOf(req));
  const { upToSeq } = parse(readInput, req.body);
  await chat.markRead({ conv, by: 'customer', upToSeq });
  res.json({ ok: true });
}));

/* ================================================================ Admin Web — /api/admin/livechat (sudah di balik requireAdmin) */
export const livechatAdminRouter = Router();
const adm = livechatAdminRouter;

async function loadConv(rawId) {
  if (!CONVERSATION_ID_RE.test(String(rawId))) throw new HttpError(404, 'Percakapan tidak ditemukan.');
  const conv = await LiveChat.findOne({ conversationId: rawId }).lean();
  if (!conv) throw new HttpError(404, 'Percakapan tidak ditemukan atau sudah dihapus.');
  return conv;
}

async function settingsView() {
  const [s, integ] = await Promise.all([getLivechatSettings(), getIntegrationView()]);
  return {
    enabled: s.enabled !== false, waNumber: s.waNumber, waNumberFormatted: formatWhatsapp(s.waNumber),
    notifyNewConversation: s.notifyNewConversation, notifyNewMessage: s.notifyNewMessage, messageCooldownSec: s.messageCooldownSec,
    lastTest: s.lastTest, fonnte: { configured: integ.fonnte.configured, enabled: integ.fonnte.enabled },
    ttlHours: chat.TTL_MS / 3_600_000, retentionDays: config.livechat.retentionDays,
  };
}
const publishSettings = async () => {
  const v = await settingsView();
  emitAdmin('livechat:settings', v);
  emitPublic('livechat:settings', { enabled: v.enabled });   // widget Marketplace muncul/hilang langsung tanpa refresh
  return v;
};

adm.get('/summary', asyncH(async (_req, res) => res.json({ totalUnread: await chat.totalUnread() })));

adm.get('/settings', asyncH(async (_req, res) => res.json({ settings: await settingsView() })));
adm.put('/settings', asyncH(async (req, res) => {
  await saveLivechatSettings(parse(livechatSettingsInput, req.body));
  res.json({ settings: await publishSettings() });
}));
adm.post('/settings/test', asyncH(async (_req, res) => {
  const r = await sendTestNotification();
  await recordLivechatTest(r.success, r.message);
  await publishSettings();
  res.status(r.success ? 200 : 422).json({ ok: r.success, message: r.message });
}));

adm.get('/conversations', asyncH(async (req, res) => {
  const q = parse(adminListQuery, req.query);
  const { items, total, totalUnread } = await chat.listForAdmin(q);
  res.json({ items, total, page: q.page, limit: q.limit, totalPages: Math.max(1, Math.ceil(total / q.limit)), totalUnread, serverTime: new Date().toISOString() });
}));

adm.get('/conversations/:id', asyncH(async (req, res) => res.json(await chat.snapshotFor(await loadConv(req.params.id), { forAdmin: true }))));

adm.post('/conversations/:id/messages', uploadLimiter, receiveImage, requireR2ForImage, asyncH(async (req, res) => {
  const conv = await loadConv(req.params.id);
  const data = parse(messageInput, req.body);
  const r = await chat.postMessage({ conv, sender: 'admin', admin: req.admin, ...data, file: req.file, origin: originOf(req) });
  res.status(r.duplicate ? 200 : 201).json({ message: chat.msgView(r.message, { forAdmin: true }), conversation: chat.adminView(r.conversation), duplicate: r.duplicate });
}));

adm.post('/conversations/:id/read', asyncH(async (req, res) => {
  const conv = await loadConv(req.params.id);
  const { upToSeq } = parse(readInput, req.body);
  await chat.markRead({ conv, by: 'admin', upToSeq });
  res.json({ ok: true, totalUnread: await chat.totalUnread() });
}));

adm.post('/conversations/:id/close', asyncH(async (req, res) => { const c = await chat.setStatus((await loadConv(req.params.id)).conversationId, 'closed'); res.json({ conversation: chat.adminView(c) }); }));
adm.post('/conversations/:id/reopen', asyncH(async (req, res) => { const c = await chat.setStatus((await loadConv(req.params.id)).conversationId, 'active'); res.json({ conversation: chat.adminView(c) }); }));
