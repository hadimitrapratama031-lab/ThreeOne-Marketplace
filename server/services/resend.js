import { config } from '../config/env.js';
import { isValidEmail } from '../lib/phone.js';
import { isFreemailAddress } from '../lib/emailDomains.js';
import { getResendConfig } from './integrationSettings.js';

/**
 * Resend — POST {base}/emails, header Authorization: Bearer <api_key> (sama dengan project lama).
 * Hasil: { success, permanent, message, response, httpStatus }. Sukses hanya bila Resend mengembalikan id pesan.
 * Selalu mengirim text/plain berdampingan dengan HTML (multipart), header X-Entity-Ref-ID per order,
 * dan Reply-To hanya bila admin mengisinya.
 */
const TIMEOUT_MS = 20_000;

function classify(status, body) {
  const providerMessage = body?.message || body?.name;
  if (status >= 500) return { permanent: false, message: `Resend mengembalikan error server (HTTP ${status}).` };
  if (status === 429) return { permanent: false, message: 'Resend membatasi jumlah permintaan (HTTP 429).' };
  if (status === 401 || status === 403) return { permanent: true, message: `API key Resend ditolak (HTTP ${status}). Periksa API key di Admin Web.` };
  return { permanent: true, message: providerMessage ? `Resend menolak permintaan: ${providerMessage}` : `Resend menolak permintaan (HTTP ${status}).` };
}

async function http(method, path, apiKey, body) {
  try {
    const res = await fetch(`${config.resendBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* bukan JSON */ }
    return { status: res.status, ok: res.ok, json };
  } catch (err) {
    return { status: 0, ok: false, json: null, error: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err) };
  }
}

export async function sendEmailRaw({ apiKey, fromEmail, fromName, replyTo, to, subject, html, text, entityRef, attachments }) {
  if (!apiKey) return { success: false, permanent: true, message: 'API key Resend belum dikonfigurasi.' };
  if (!fromEmail || !isValidEmail(fromEmail)) return { success: false, permanent: true, message: `Alamat pengirim Resend tidak valid: ${fromEmail || '(kosong)'}` };
  if (isFreemailAddress(fromEmail)) return { success: false, permanent: true, message: `Alamat pengirim "${fromEmail}" memakai domain email gratisan dan tidak bisa diautentikasi (SPF/DKIM/DMARC) atas nama domain toko. Gunakan alamat di domain toko yang sudah diverifikasi di Resend, mis. noreply@namatoko.com.` };
  if (!isValidEmail(to)) return { success: false, permanent: true, message: `Alamat email tujuan tidak valid: ${to || '(kosong)'}` };
  if (!subject || !String(subject).trim()) return { success: false, permanent: true, message: 'Subject email kosong.' };
  if (!html || !String(html).trim()) return { success: false, permanent: true, message: 'Isi email kosong.' };

  const r = await http('POST', '/emails', apiKey, {
    from: `${fromName || 'Store'} <${fromEmail}>`,
    to: [to],
    ...(replyTo && isValidEmail(replyTo) ? { reply_to: replyTo } : {}),
    subject,
    html,
    text: text && String(text).trim() ? text : String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    ...(entityRef ? { headers: { 'X-Entity-Ref-ID': String(entityRef) } } : {}),
    ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
  });
  if (r.status === 0) return { success: false, permanent: false, message: `Resend tidak dapat dihubungi${r.error === 'timeout' ? ' (timeout)' : ''}.`, httpStatus: null };
  if (!r.ok) return { success: false, ...classify(r.status, r.json), httpStatus: r.status };
  if (!r.json?.id) return { success: false, permanent: false, message: 'Resend membalas tanpa id pesan — email tidak masuk antrean.', response: r.json, httpStatus: r.status };
  return { success: true, permanent: false, message: '', response: r.json, httpStatus: r.status };
}

export async function sendEmail({ to, subject, html, text, entityRef, attachments }) {
  const cfg = await getResendConfig();
  if (!cfg.enabled) return { success: false, permanent: true, disabled: true, message: 'Resend belum diaktifkan/dikonfigurasi.' };
  return sendEmailRaw({ ...cfg, to, subject, html, text, entityRef, attachments });
}

export async function testConnection(testTo) {
  const cfg = await getResendConfig();
  if (!cfg.apiKey || !cfg.fromEmail) return { success: false, message: 'API key / email pengirim belum diisi.' };
  if (!testTo || !isValidEmail(testTo)) return { success: false, message: 'Email tujuan uji tidak valid.' };
  const r = await sendEmailRaw({
    apiKey: cfg.apiKey, fromEmail: cfg.fromEmail, fromName: cfg.fromName, to: testTo,
    subject: 'Test koneksi Resend', html: '<p>Test koneksi Resend dari Admin Web berhasil.</p>', text: 'Test koneksi Resend dari Admin Web berhasil.',
  });
  return r.success ? { success: true, message: 'Email uji berhasil dikirim.' } : { success: false, message: r.message || 'Gagal mengirim email uji.' };
}

/** Status verifikasi domain apa adanya dari Resend (GET /domains) — record DNS tidak pernah dikarang. */
export async function getDomainStatus() {
  const cfg = await getResendConfig();
  if (!cfg.apiKey) return { success: false, message: 'API key Resend belum dikonfigurasi.', domains: [] };
  const list = await http('GET', '/domains', cfg.apiKey);
  if (!list.ok) return { success: false, message: list.status === 0 ? 'Resend tidak dapat dihubungi.' : classify(list.status, list.json).message, domains: [] };
  const fromDomain = String(cfg.fromEmail || '').split('@')[1] || '';
  const detailed = await Promise.all((list.json?.data || []).map(async (d) => {
    const det = await http('GET', `/domains/${encodeURIComponent(d.id)}`, cfg.apiKey);
    return det.ok ? det.json : d;
  }));
  return {
    success: true, fromEmail: cfg.fromEmail, fromDomain,
    domains: detailed.map((d) => ({
      id: d.id, name: d.name, status: d.status, region: d.region, isSendingDomain: d.name === fromDomain,
      records: (d.records || []).map((x) => ({ record: x.record, type: x.type, name: x.name, value: x.value, status: x.status, priority: x.priority })),
    })),
  };
}
