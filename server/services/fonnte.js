import { config } from '../config/env.js';
import { normalizeWhatsapp, isValidWhatsApp } from '../lib/phone.js';
import { getFonnteConfig } from './integrationSettings.js';

/**
 * Fonnte — POST {base}/send, header Authorization: <token>, body form: target, message (sama dengan project lama).
 * Semua fungsi mengembalikan { success, permanent, message, response, httpStatus }.
 * `permanent` = tidak layak di-retry (token/nomor salah). Fonnte bisa membalas HTTP 200 tanpa mengirim apa pun,
 * jadi sukses hanya bila body.status === true DAN ada id pesan.
 */
const TIMEOUT_MS = 20_000;

function interpretBody(body, httpStatus) {
  if (!body || typeof body !== 'object') return { success: false, permanent: false, message: 'Balasan Fonnte tidak dapat dibaca.', response: body, httpStatus };
  if (body.status !== true) {
    const reason = body.reason || body.detail || 'Fonnte menolak pengiriman.';
    return { success: false, permanent: /invalid|not registered|tidak valid|format|target/i.test(String(reason)), message: `Fonnte: ${reason}`, response: body, httpStatus };
  }
  const ids = Array.isArray(body.id) ? body.id : body.id ? [body.id] : [];
  if (!ids.length) return { success: false, permanent: false, message: `Fonnte membalas sukses tanpa id pesan${body.detail ? ` (${body.detail})` : ''} — pesan tidak masuk antrean.`, response: body, httpStatus };
  return { success: true, permanent: false, message: '', response: body, httpStatus };
}

export async function sendWhatsAppRaw(token, target, message) {
  const to = normalizeWhatsapp(target) || String(target || '');
  if (!token) return { success: false, permanent: true, message: 'Token Fonnte belum dikonfigurasi.' };
  if (!isValidWhatsApp(to)) return { success: false, permanent: true, message: `Nomor WhatsApp tujuan tidak valid: ${to || '(kosong)'}` };
  if (!message || !String(message).trim()) return { success: false, permanent: true, message: 'Isi pesan WhatsApp kosong.' };

  let res;
  try {
    res = await fetch(`${config.fonnteBase}/send`, {
      method: 'POST',
      headers: { Authorization: token, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ target: to, message }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { success: false, permanent: false, message: `Fonnte tidak dapat dihubungi${err?.name === 'TimeoutError' ? ' (timeout)' : ''}.`, httpStatus: null };
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* bukan JSON */ }

  if (res.status >= 500) return { success: false, permanent: false, message: `Fonnte mengembalikan error server (HTTP ${res.status}).`, httpStatus: res.status };
  if (res.status === 429) return { success: false, permanent: false, message: 'Fonnte membatasi jumlah permintaan (HTTP 429).', httpStatus: 429 };
  if (res.status === 401 || res.status === 403) return { success: false, permanent: true, message: `Token Fonnte ditolak (HTTP ${res.status}). Periksa token di Admin Web.`, httpStatus: res.status };
  if (res.status >= 400) return { success: false, permanent: true, message: body?.reason ? `Fonnte menolak permintaan: ${body.reason}` : `Fonnte menolak permintaan (HTTP ${res.status}).`, httpStatus: res.status };
  return interpretBody(body, res.status);
}

/** Notifikasi order sungguhan: menghormati saklar Enabled. */
export async function sendWhatsApp(target, message) {
  const cfg = await getFonnteConfig();
  if (!cfg.enabled) return { success: false, permanent: true, disabled: true, message: 'Fonnte belum diaktifkan/dikonfigurasi.' };
  return sendWhatsAppRaw(cfg.token, target, message);
}

/** Tombol "Kirim pesan uji": cukup token tersimpan (tanpa saklar Enabled) agar token baru bisa diverifikasi dulu. */
export async function testConnection(testTarget) {
  const cfg = await getFonnteConfig();
  const token = cfg.token;   // token terbaca walau saklar Enabled masih mati
  if (!token) return { success: false, message: 'Token Fonnte belum diisi.' };
  if (!testTarget) return { success: false, message: 'Nomor tujuan uji tidak boleh kosong.' };
  if (!normalizeWhatsapp(testTarget)) return { success: false, message: 'Format nomor WhatsApp tidak valid.' };
  const r = await sendWhatsAppRaw(token, testTarget, 'Test koneksi Fonnte dari Admin Web berhasil.');
  return r.success ? { success: true, message: 'Pesan uji berhasil dikirim.' } : { success: false, message: r.message || 'Gagal mengirim pesan uji.' };
}
