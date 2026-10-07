import { LiveChat, LiveChatMessage } from '../models/index.js';
import { config } from '../config/env.js';
import { formatWhatsapp } from '../lib/phone.js';
import { getLivechatSettings } from './livechatSettings.js';
import { getPaymentConfig } from './paymentSettings.js';
import * as fonnte from './fonnte.js';

/**
 * Notifikasi WhatsApp ke Admin untuk Live Chat — memakai integrasi Fonnte yang sudah ada (services/fonnte.js:
 * token terenkripsi + saklar Enabled dari Admin Web -> Email & WhatsApp). Tidak ada pengirim WhatsApp baru.
 *
 * Idempotensi: slot pengiriman di-CLAIM secara atomic pada dokumen (pesan: `wa`, percakapan baru: `waCreated`)
 * SEBELUM Fonnte dipanggil. Reconnect / event ganda / request ulang tidak pernah mengirim dua kali untuk pesan yang sama.
 * Kegagalan hanya dicatat di sub-dokumen itu; status percakapan tidak pernah disentuh. Dipanggil di latar belakang.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000;
const BACKOFF_MS = 1500;
const MAX_ATTEMPTS = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPublicBase = (u) => { try { const h = new URL(u).hostname; return !(/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(h) || h.endsWith('.local')); } catch { return false; } };

/** Tautan ke Live Chat Admin; kosong bila tidak ada alamat publik (localhost tidak berguna di WhatsApp). */
async function adminLink(origin, conversationId) {
  const pay = await getPaymentConfig().catch(() => ({}));
  const base = [pay.publicBaseUrl, config.publicBaseUrl, origin].find((u) => u && isPublicBase(u));
  return base ? `${base.replace(/\/+$/, '')}/admin/#/livechat?c=${encodeURIComponent(conversationId)}` : '';
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function sendWithRetry(target, text) {
  let last;
  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    last = await fonnte.sendWhatsApp(target, text);
    if (last.success || last.permanent) return last;
    if (i < MAX_ATTEMPTS) await sleep(BACKOFF_MS);
  }
  return last;
}

/** Claim atomic: 'none' -> 'sending'. Mengembalikan true hanya untuk satu pemanggil. */
const claim = (Model, filter, path) => Model.findOneAndUpdate(
  { ...filter, [`${path}.status`]: 'none' },
  { $set: { [`${path}.status`]: 'sending', [`${path}.claimedAt`]: new Date() }, $inc: { [`${path}.attempts`]: 1 } },
  { new: true },
).lean().then(Boolean);

const settle = (Model, id, path, status, error = '') => Model.updateOne({ _id: id }, { $set: { [`${path}.status`]: status, [`${path}.error`]: String(error).slice(0, 300), [`${path}.at`]: new Date() } });

async function deliver({ Model, id, path, target, text, conversationId }) {
  try {
    const r = await sendWithRetry(target, text);
    if (r.success) { await settle(Model, id, path, 'sent'); return; }
    // Fonnte dimatikan admin = dilewati (bukan kegagalan); selain itu gagal. Percakapan tidak pernah diubah.
    await settle(Model, id, path, r.disabled ? 'skipped' : 'failed', r.message);
    if (!r.disabled) console.warn(`[livechat] WhatsApp admin gagal (${conversationId}): ${r.message}`);
  } catch (err) {
    await settle(Model, id, path, 'failed', err?.message || 'error').catch(() => {});
  }
}

const whoLines = (conv) => [`Nama: ${conv.customer.name}`, ...(conv.customer.whatsapp ? [`WhatsApp: ${formatWhatsapp(conv.customer.whatsapp)}`] : [])];

export async function notifyConversationCreated(conv, { origin } = {}) {
  const s = await getLivechatSettings();
  if (!s.enabled || !s.notifyNewConversation || !s.waNumber) { await LiveChat.updateOne({ _id: conv._id, 'waCreated.status': 'none' }, { $set: { 'waCreated.status': 'skipped', 'waCreated.at': new Date() } }); return; }
  if (!(await claim(LiveChat, { _id: conv._id }, 'waCreated'))) return;
  const link = await adminLink(origin, conv.conversationId);
  const text = ['*Live Chat baru*', ...whoLines(conv), `ID: ${conv.conversationId}`, ...(link ? [`Buka: ${link}`] : [])].join('\n');
  await deliver({ Model: LiveChat, id: conv._id, path: 'waCreated', target: s.waNumber, text, conversationId: conv.conversationId });
}

export async function notifyCustomerMessage(conv, msg, { origin } = {}) {
  const s = await getLivechatSettings();
  const skip = (why) => LiveChatMessage.updateOne({ _id: msg._id, 'wa.status': 'none' }, { $set: { 'wa.status': 'skipped', 'wa.error': why, 'wa.at': new Date() } });
  if (!s.enabled || !s.notifyNewMessage || !s.waNumber) return skip('Notifikasi pesan dimatikan atau nomor admin belum diisi');
  if (!(await claim(LiveChatMessage, { _id: msg._id }, 'wa'))) return;   // pesan ini sudah ditangani

  if (s.messageCooldownSec > 0) {   // jeda antar notifikasi per percakapan (atomic, tidak bergantung memori proses)
    const now = new Date();
    const slot = await LiveChat.findOneAndUpdate(
      { _id: conv._id, $or: [{ waLastNotifiedAt: null }, { waLastNotifiedAt: { $exists: false } }, { waLastNotifiedAt: { $lte: new Date(now.getTime() - s.messageCooldownSec * 1000) } }] },
      { $set: { waLastNotifiedAt: now } }, { new: true },
    ).lean();
    if (!slot) return settle(LiveChatMessage, msg._id, 'wa', 'skipped', 'Ditahan oleh jeda notifikasi');
  }
  const link = await adminLink(origin, conv.conversationId);
  const body = msg.type === 'image' ? '[Gambar]' : clip(msg.text, 200);
  const text = ['*Pesan baru Live Chat*', ...whoLines(conv), `Pesan: ${body}`, `ID: ${conv.conversationId}`, ...(link ? [`Buka: ${link}`] : [])].join('\n');
  await deliver({ Model: LiveChatMessage, id: msg._id, path: 'wa', target: s.waNumber, text, conversationId: conv.conversationId });
}

/** Pesan uji dari Admin Web (menghormati saklar Fonnte). */
export async function sendTestNotification() {
  const s = await getLivechatSettings();
  if (!s.waNumber) return { success: false, message: 'Isi dan simpan nomor WhatsApp admin terlebih dahulu.' };
  const r = await fonnte.sendWhatsApp(s.waNumber, '*Uji notifikasi Live Chat*\nNotifikasi WhatsApp Live Chat berhasil tersambung ke nomor ini.');
  return r.success ? { success: true, message: 'Pesan uji berhasil dikirim.' } : { success: false, message: r.disabled ? 'Fonnte belum aktif. Aktifkan di menu Email & WhatsApp.' : (r.message || 'Gagal mengirim pesan uji.') };
}

/** Klaim 'sending' yatim (proses mati di tengah jalan) ditandai gagal; TIDAK dikirim ulang agar tidak berisiko dobel. */
export async function failStaleNotifications() {
  const before = new Date(Date.now() - STALE_CLAIM_MS);
  const patch = { $set: { 'wa.status': 'failed', 'wa.error': 'Proses berhenti sebelum pengiriman selesai' } };
  await LiveChatMessage.updateMany({ 'wa.status': 'sending', 'wa.claimedAt': { $lt: before } }, patch);
  await LiveChat.updateMany({ 'waCreated.status': 'sending', 'waCreated.claimedAt': { $lt: before } }, { $set: { 'waCreated.status': 'failed', 'waCreated.error': 'Proses berhenti sebelum pengiriman selesai' } });
}
