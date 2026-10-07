import { Setting } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { normalizeWhatsapp } from '../lib/phone.js';

/**
 * Pengaturan Live Chat (Admin Web) -> koleksi settings, key "livechat".
 * Sengaja TIDAK masuk SETTING_KEYS: grup itu dikirim penuh ke Marketplace publik, sedangkan di sini ada nomor WhatsApp admin.
 * Marketplace hanya menerima { enabled } lewat endpoint publik khusus. Tidak ada cache: setiap request membaca MongoDB,
 * jadi perubahan dari Admin Web langsung berlaku di semua instance.
 */
const KEY = 'livechat';
const DEFAULT = () => ({ enabled: true, waNumber: '', notifyNewConversation: true, notifyNewMessage: true, messageCooldownSec: 0, lastTest: { status: 'untested', at: null, message: '' } });

export async function getLivechatSettings() {
  const doc = await Setting.findOne({ key: KEY }).lean();
  const d = DEFAULT();
  const v = doc?.value || {};
  return { ...d, ...v, lastTest: { ...d.lastTest, ...(v.lastTest || {}) } };
}

export const isLivechatEnabled = async () => (await getLivechatSettings()).enabled !== false;

export async function saveLivechatSettings(input) {
  const cur = await getLivechatSettings();
  let waNumber = '';
  if (input.waNumber) {
    waNumber = normalizeWhatsapp(input.waNumber);
    if (!waNumber) throw new HttpError(422, 'Data tidak valid', { fields: { waNumber: 'Nomor WhatsApp tidak valid (contoh: 0812 3456 7890)' } });
  }
  const next = { ...cur, enabled: input.enabled, waNumber, notifyNewConversation: input.notifyNewConversation, notifyNewMessage: input.notifyNewMessage, messageCooldownSec: input.messageCooldownSec };
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: next } }, { upsert: true, new: true });
  return next;
}

export async function recordLivechatTest(ok, message) {
  const cur = await getLivechatSettings();
  const next = { ...cur, lastTest: { status: ok ? 'success' : 'error', at: new Date(), message: String(message || '').slice(0, 300) } };
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: next } }, { upsert: true, new: true });
  return next;
}
