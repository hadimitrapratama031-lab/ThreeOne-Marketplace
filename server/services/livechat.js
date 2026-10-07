import { LiveChat, LiveChatMessage } from '../models/index.js';
import { HttpError, escapeRegex } from '../lib/http.js';
import { config } from '../config/env.js';
import { sniff } from '../lib/sniff.js';
import { formatWhatsapp } from '../lib/phone.js';
import { emitAdmin, emitToRoom, closeRoom, livechatRoom, setLivechatJoinHandler } from '../lib/realtime.js';
import { livechatTokenFor, livechatTokenOk, newConversationId, CONVERSATION_ID_RE } from '../lib/livechatToken.js';
import { isLivechatEnabled } from './livechatSettings.js';
import * as assets from './assets.js';
import { notifyConversationCreated, notifyCustomerMessage, failStaleNotifications } from './livechatNotify.js';

/**
 * Live Chat — satu-satunya sumber logika percakapan untuk Marketplace (pelanggan) dan Admin Web.
 *
 * Aturan yang dijaga di sini (bukan di browser):
 *  - expiresAt = waktu SERVER saat dibuat + 24 jam. Tidak pernah digeser oleh aktivitas / pergantian tanggal.
 *  - "Aktif" = status bukan expired DAN expiresAt > sekarang. Dicek di setiap baca/tulis, jadi percakapan lewat batas
 *    tidak pernah dilayani walau worker belum menandainya.
 *  - Worker (5 dtk) menandai expired lewat transisi atomic -> hanya pemenang transisi yang menyiarkan event.
 *  - Pesan idempoten lewat (conversation, clientId): retry jaringan / reconnect / dobel klik tidak menggandakan pesan.
 */
export const TTL_MS = 24 * 3600 * 1000;
export const MAX_MESSAGES = 300;
const LIVE_STATUSES = ['active', 'closed'];
const WORKER_MS = 5000;

const LIVECHAT_OWNER = (id) => ({ type: 'livechat', id: String(id) });

/* ------------------------------------------------------------------ views */
export const msgView = (m, { forAdmin = false } = {}) => ({
  id: String(m._id), seq: m.seq, clientId: m.clientId || '', sender: m.sender, type: m.type, text: m.text || '',
  image: m.image?.url ? { url: m.image.url, mime: m.image.mime || '', size: m.image.size || 0 } : null,
  at: m.createdAt,
  ...(forAdmin ? { senderName: m.senderName || '' } : {}),
});

export const customerView = (c) => ({
  id: c.conversationId, name: c.customer.name, whatsapp: c.customer.whatsapp || '', status: c.status,
  createdAt: c.createdAt, expiresAt: c.expiresAt, unread: c.unreadCustomer || 0, adminReadSeq: c.adminReadSeq || 0, customerReadSeq: c.customerReadSeq || 0,
});

export const adminView = (c) => ({
  id: c.conversationId, name: c.customer.name, whatsapp: c.customer.whatsapp || '', whatsappFormatted: formatWhatsapp(c.customer.whatsapp),
  status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt, expiresAt: c.expiresAt, closedAt: c.closedAt || null, expiredAt: c.expiredAt || null,
  unread: c.unreadAdmin || 0, messageCount: c.messageCount || 0, adminReadSeq: c.adminReadSeq || 0, customerReadSeq: c.customerReadSeq || 0,
  lastMessage: c.lastMessage ? { sender: c.lastMessage.sender, type: c.lastMessage.type, text: c.lastMessage.text, at: c.lastMessage.at, seq: c.lastMessage.seq } : null,
  lastMessageAt: c.lastMessageAt,
  retentionDays: config.livechat.retentionDays,
});

/* ------------------------------------------------------------------ helpers */
const isLive = (c, now = new Date()) => Boolean(c) && LIVE_STATUSES.includes(c.status) && c.expiresAt > now;
const gone = (code, message) => new HttpError(code === 'closed' ? 409 : 410, message, { code });
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Total pesan belum dibaca admin pada percakapan yang masih hidup (badge sidebar). Percakapan expired tidak dihitung. */
export async function totalUnread() {
  const [r] = await LiveChat.aggregate([
    { $match: { status: { $in: LIVE_STATUSES }, expiresAt: { $gt: new Date() }, unreadAdmin: { $gt: 0 } } },
    { $group: { _id: null, n: { $sum: '$unreadAdmin' } } },
  ]);
  return r?.n || 0;
}

/** Percakapan milik pelanggan: token harus cocok. Salah ID / salah token memberi respons sama (tidak membocorkan keberadaan ID). */
export async function authorize(conversationId, token, { allowExpiredCheck = true } = {}) {
  if (!CONVERSATION_ID_RE.test(String(conversationId)) || !livechatTokenOk(conversationId, token)) throw new HttpError(404, 'Percakapan tidak ditemukan.');
  const conv = await LiveChat.findOne({ conversationId }).lean();
  if (!conv) throw new HttpError(404, 'Percakapan tidak ditemukan.');
  if (allowExpiredCheck && !(LIVE_STATUSES.includes(conv.status) && conv.expiresAt > new Date())) throw gone('expired', 'Percakapan sudah berakhir.');
  return conv;
}

export async function assertEnabled() {
  if (!(await isLivechatEnabled())) throw new HttpError(403, 'Live Chat sedang tidak tersedia.', { code: 'disabled' });
}

async function messagesOf(conv) {
  return LiveChatMessage.find({ conversation: conv._id }).sort({ seq: 1 }).limit(MAX_MESSAGES + 5).lean();
}

export async function snapshotFor(conv, { forAdmin = false } = {}) {
  const msgs = await messagesOf(conv);
  return {
    conversation: forAdmin ? adminView(conv) : customerView(conv),
    messages: msgs.map((m) => msgView(m, { forAdmin })),
    serverTime: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ pelanggan: buat / ambil */
export async function createConversation({ name, whatsapp, clientKey, origin }) {
  const found = await LiveChat.findOne({ clientKey }).lean();
  if (found) {
    if (!isLive(found)) throw gone('expired', 'Percakapan sudah berakhir.');
    return { conv: found, token: livechatTokenFor(found.conversationId), created: false };
  }
  const now = new Date();
  let conv;
  for (let i = 0; i < 5 && !conv; i += 1) {
    try {
      conv = (await LiveChat.create({
        conversationId: newConversationId(), clientKey, customer: { name, whatsapp: whatsapp || '' },
        status: 'active', lastMessageAt: now, expiresAt: new Date(now.getTime() + TTL_MS),   // 24 jam dari waktu SERVER
      })).toObject();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const again = await LiveChat.findOne({ clientKey }).lean();   // balapan dua request dengan clientKey sama
      if (again) return { conv: again, token: livechatTokenFor(again.conversationId), created: false };
    }
  }
  if (!conv) throw new HttpError(500, 'Gagal membuat percakapan. Coba lagi.');

  emitAdmin('livechat:conversation:created', { conversation: adminView(conv), totalUnread: await totalUnread() });
  setImmediate(() => notifyConversationCreated(conv, { origin }).catch((e) => console.error('[livechat] notifikasi WA:', e?.message)));
  return { conv, token: livechatTokenFor(conv.conversationId), created: true };
}

/* ------------------------------------------------------------------ kirim pesan (pelanggan & admin) */
/**
 * Urutan: validasi -> cek duplikat (clientId) -> upload R2 (bila gambar) -> reservasi seq + update percakapan SECARA ATOMIC
 * (hanya bila masih aktif) -> simpan pesan -> siarkan. Kegagalan setelah upload menghapus gambar dari R2; kegagalan
 * setelah reservasi mengembalikan penghitung. Notifikasi WhatsApp hanya dipicu oleh request yang benar-benar menyimpan pesan baru.
 */
export async function postMessage({ conv, sender, admin = null, clientId, type, text, file, origin }) {
  const now = new Date();
  if (conv.status === 'expired' || conv.expiresAt <= now) throw gone('expired', 'Percakapan sudah berakhir.');
  if (conv.status === 'closed') throw gone('closed', sender === 'admin' ? 'Percakapan sudah ditutup. Buka kembali untuk membalas.' : 'Percakapan ini sudah ditutup oleh tim kami.');

  const dup = await LiveChatMessage.findOne({ conversation: conv._id, clientId }).lean();
  if (dup) return { message: dup, conversation: conv, duplicate: true };
  if ((conv.messageCount || 0) >= MAX_MESSAGES) throw new HttpError(422, 'Batas pesan untuk percakapan ini sudah tercapai.', { code: 'limit' });

  let asset = null;
  if (type === 'image') {
    if (!file?.buffer?.length) throw new HttpError(422, 'Gambar belum dipilih.', { fields: { image: 'Pilih gambar terlebih dahulu' } });
    const info = sniff(file.buffer);
    if (!info || info.kind !== 'image') throw new HttpError(415, 'Format file tidak didukung. Gunakan JPG, PNG, WebP, atau GIF.', { fields: { image: 'Format tidak didukung' } });
    asset = await assets.uploadAsset({ buffer: file.buffer, originalName: file.originalname, folder: 'livechat' });   // validasi byte, ukuran, verifikasi R2
    try { await assets.markUsed(LIVECHAT_OWNER(conv.conversationId), [asset.key]); } catch (err) { await assets.destroyAssets([asset]).catch(() => {}); throw err; }
  }
  const cleanup = async () => { if (asset) await assets.destroyAssets([asset]).catch(() => {}); };

  const unreadField = sender === 'customer' ? 'unreadAdmin' : 'unreadCustomer';
  const preview = type === 'image' ? 'Gambar' : clip(text, 120);
  let reserved;
  try {
    // Update berbentuk pipeline: seq baru dipakai juga untuk lastMessage.seq dalam satu operasi atomic.
    // $literal wajib untuk teks pengguna agar nilai seperti "$100" tidak dibaca sebagai field path.
    reserved = await LiveChat.findOneAndUpdate(
      { _id: conv._id, status: 'active', expiresAt: { $gt: now } },
      [{
        $set: {
          messageSeq: { $add: [{ $ifNull: ['$messageSeq', 0] }, 1] },
          messageCount: { $add: [{ $ifNull: ['$messageCount', 0] }, 1] },
          [unreadField]: { $add: [{ $ifNull: [`$${unreadField}`, 0] }, 1] },
          lastMessage: { seq: { $add: [{ $ifNull: ['$messageSeq', 0] }, 1] }, sender: { $literal: sender }, type: { $literal: type }, text: { $literal: preview }, at: { $literal: now } },
          lastMessageAt: { $literal: now },
        },
      }],
      { new: true },
    ).lean();
  } catch (err) { await cleanup(); throw err; }
  if (!reserved) { await cleanup(); throw gone('expired', 'Percakapan sudah berakhir atau ditutup.'); }

  let msg;
  try {
    msg = (await LiveChatMessage.create({
      conversation: conv._id, conversationId: conv.conversationId, seq: reserved.messageSeq, clientId, sender, type,
      text: type === 'text' ? text : '', senderName: sender === 'admin' ? (admin?.name || '') : '', adminId: sender === 'admin' ? admin?._id : null,
      image: asset ? { key: asset.key, url: asset.url, mime: asset.mime, size: asset.size } : null,
    })).toObject();
  } catch (err) {
    // Pesan gagal disimpan: kembalikan penghitung yang sudah dinaikkan (seq boleh berlubang, tidak berbahaya)
    await LiveChat.updateOne({ _id: conv._id }, { $inc: { messageCount: -1, [unreadField]: -1 } }).catch(() => {});
    if (err?.code === 11000) {   // dua request clientId sama bersamaan: yang kalah mengembalikan pesan milik pemenang
      const winner = await LiveChatMessage.findOne({ conversation: conv._id, clientId }).lean();
      if (winner) { await cleanup(); return { message: winner, conversation: reserved, duplicate: true }; }
    }
    await cleanup();
    throw err;
  }

  const unread = await totalUnread();
  emitAdmin('livechat:message:new', { conversationId: conv.conversationId, message: msgView(msg, { forAdmin: true }), conversation: adminView(reserved), totalUnread: unread });
  emitToRoom(livechatRoom(conv.conversationId), 'livechat:message:new', { conversationId: conv.conversationId, message: msgView(msg), conversation: customerView(reserved) });

  if (sender === 'customer') {
    setImmediate(() => notifyCustomerMessage(reserved, msg, { origin }).catch((e) => console.error('[livechat] notifikasi WA:', e?.message)));
  }
  return { message: msg, conversation: reserved, duplicate: false };
}

/* ------------------------------------------------------------------ tanda baca */
/** Tandai dibaca sampai upToSeq. Penghitung dihitung ulang dari pesan sebenarnya (self-healing) dengan penjaga messageSeq. */
export async function markRead({ conv, by, upToSeq }) {
  if (!isLive(conv)) return null;
  const readField = by === 'admin' ? 'adminReadSeq' : 'customerReadSeq';
  const unreadField = by === 'admin' ? 'unreadAdmin' : 'unreadCustomer';
  const otherSender = by === 'admin' ? 'customer' : 'admin';
  for (let i = 0; i < 3; i += 1) {
    const cur = await LiveChat.findById(conv._id).select('messageSeq adminReadSeq customerReadSeq unreadAdmin unreadCustomer').lean();
    if (!cur) return null;
    const readTo = Math.max(cur[readField] || 0, Math.min(upToSeq, cur.messageSeq));
    const unread = await LiveChatMessage.countDocuments({ conversation: conv._id, sender: otherSender, seq: { $gt: readTo } });
    const upd = await LiveChat.findOneAndUpdate({ _id: conv._id, messageSeq: cur.messageSeq }, { $set: { [readField]: readTo, [unreadField]: unread } }, { new: true }).lean();
    if (!upd) continue;   // ada pesan baru di sela-sela: hitung ulang
    const changed = (cur[readField] || 0) !== readTo || (cur[unreadField] || 0) !== unread;
    if (changed) {
      const room = livechatRoom(conv.conversationId);
      if (by === 'admin') {
        emitAdmin('livechat:unread', { conversationId: conv.conversationId, unreadAdmin: unread, totalUnread: await totalUnread() });
        emitToRoom(room, 'livechat:read', { conversationId: conv.conversationId, by: 'admin', upToSeq: readTo });
      } else {
        emitAdmin('livechat:read', { conversationId: conv.conversationId, by: 'customer', upToSeq: readTo });
        emitToRoom(room, 'livechat:unread', { conversationId: conv.conversationId, unread });
      }
    }
    return upd;
  }
  return null;
}

/* ------------------------------------------------------------------ admin: status */
export async function setStatus(conversationId, next) {
  const now = new Date();
  const from = next === 'closed' ? 'active' : 'closed';
  const patch = next === 'closed' ? { $set: { status: 'closed', closedAt: now } } : { $set: { status: 'active' }, $unset: { closedAt: '' } };
  const conv = await LiveChat.findOneAndUpdate({ conversationId, status: from, expiresAt: { $gt: now } }, patch, { new: true }).lean();
  if (!conv) {
    const cur = await LiveChat.findOne({ conversationId }).lean();
    if (!cur) throw new HttpError(404, 'Percakapan tidak ditemukan.');
    if (cur.status === 'expired' || cur.expiresAt <= now) throw gone('expired', 'Percakapan sudah kedaluwarsa.');
    return cur;   // sudah berada di status tujuan: idempoten
  }
  emitAdmin('livechat:conversation:updated', { conversation: adminView(conv), totalUnread: await totalUnread() });
  emitToRoom(livechatRoom(conversationId), 'livechat:status', { conversationId, status: conv.status, expiresAt: conv.expiresAt });
  return conv;
}

/* ------------------------------------------------------------------ admin: daftar */
export async function listForAdmin({ filter, q, page, limit }) {
  const now = new Date();
  const base = {
    active: { status: 'active', expiresAt: { $gt: now } },
    unread: { status: { $in: LIVE_STATUSES }, expiresAt: { $gt: now }, unreadAdmin: { $gt: 0 } },
    closed: { status: 'closed', expiresAt: { $gt: now } },
    expired: { $or: [{ status: 'expired' }, { expiresAt: { $lte: now } }] },
  }[filter];
  const query = { ...base };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    const digits = q.replace(/\D/g, '');
    const or = [{ 'customer.name': rx }, { conversationId: rx }];
    if (digits.length >= 4) or.push({ 'customer.whatsapp': new RegExp(escapeRegex(digits.startsWith('0') ? `62${digits.slice(1)}` : digits)) });
    query.$and = [...(query.$and || []), { $or: or }];
  }
  const [total, docs, unread] = await Promise.all([
    LiveChat.countDocuments(query),
    LiveChat.find(query).sort({ lastMessageAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    totalUnread(),
  ]);
  return { items: docs.map(adminView), total, totalUnread: unread };
}

/* ------------------------------------------------------------------ realtime join (pelanggan) */
setLivechatJoinHandler(async (conversationId, token) => {
  if (!CONVERSATION_ID_RE.test(conversationId) || !livechatTokenOk(conversationId, token)) return { ok: false, reason: 'invalid' };
  if (!(await isLivechatEnabled())) return { ok: false, reason: 'disabled' };
  const conv = await LiveChat.findOne({ conversationId }).lean();
  if (!conv) return { ok: false, reason: 'invalid' };
  if (!isLive(conv)) return { ok: false, reason: 'expired' };
  return { ok: true, snapshot: await snapshotFor(conv) };
});

/* ------------------------------------------------------------------ worker: expire + purge */
/** Tandai expired setiap percakapan yang lewat batas. Transisi atomic: hanya pemenang yang menyiarkan event. */
export async function expireDue(now = new Date()) {
  const due = await LiveChat.find({ status: { $in: LIVE_STATUSES }, expiresAt: { $lte: now } }).select('_id').limit(100).lean();
  let n = 0;
  const retentionMs = config.livechat.retentionDays * 86_400_000;
  for (const { _id } of due) {
    const conv = await LiveChat.findOneAndUpdate(
      { _id, status: { $in: LIVE_STATUSES }, expiresAt: { $lte: now } },
      { $set: { status: 'expired', expiredAt: now, purgeAt: new Date(now.getTime() + retentionMs) } },
      { new: true },
    ).lean();
    if (!conv) continue;   // sudah diproses proses/instance lain
    n += 1;
    const room = livechatRoom(conv.conversationId);
    emitAdmin('livechat:conversation:expired', { conversationId: conv.conversationId, conversation: adminView(conv), totalUnread: await totalUnread() });
    emitToRoom(room, 'livechat:expired', { conversationId: conv.conversationId });
    closeRoom(room);
  }
  return n;
}

/** Hapus pesan + gambar R2 + percakapan yang sudah melewati masa simpan. */
export async function purgeOld(now = new Date()) {
  const old = await LiveChat.find({ status: 'expired', purgeAt: { $lte: now } }).select('_id conversationId').limit(50).lean();
  for (const c of old) {
    try {
      await assets.releaseOwner(LIVECHAT_OWNER(c.conversationId));   // R2 + catatan aset (yang gagal ditandai orphan dan dicoba ulang sweeper)
      await LiveChatMessage.deleteMany({ conversation: c._id });
      await LiveChat.deleteOne({ _id: c._id, status: 'expired' });
    } catch (err) { console.error('[livechat] purge gagal:', c.conversationId, err?.message); }
  }
  return old.length;
}

let timer;
let lastHousekeeping = 0;
export function startLivechatWorker() {
  if (timer) return;
  const tick = async () => {
    try {
      await expireDue();
      if (Date.now() - lastHousekeeping > 60_000) {
        lastHousekeeping = Date.now();
        await purgeOld();
        await failStaleNotifications();
      }
    } catch (err) { console.error('[livechat] worker:', err?.message); }
    timer = setTimeout(tick, WORKER_MS);
    timer.unref?.();
  };
  timer = setTimeout(tick, 500);   // langsung berjalan saat start: percakapan yang lewat batas selama server mati ditandai segera
  timer.unref?.();
}
export function stopLivechatWorker() { clearTimeout(timer); timer = undefined; }
