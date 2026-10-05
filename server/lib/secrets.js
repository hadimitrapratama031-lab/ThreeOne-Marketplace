import crypto from 'node:crypto';
import { config } from '../config/env.js';

/**
 * Enkripsi rahasia (API Key KlikQRIS) di MongoDB: AES-256-GCM, kunci diturunkan dari APP_SECRET (HKDF).
 * Format tersimpan: v1.<iv>.<tag>.<ciphertext> (base64url). Rahasia tidak pernah dikirim balik ke browser.
 */
const key = () => Buffer.from(crypto.hkdfSync('sha256', config.appSecret, 'marketplace-secrets-v1', 'payment-settings', 32));

export function encryptSecret(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

/** '' bila kosong, rusak, atau APP_SECRET berubah (admin harus menyimpan ulang API Key). */
export function decryptSecret(stored) {
  try {
    const [v, iv, tag, data] = String(stored || '').split('.');
    if (v !== 'v1' || !iv || !tag || !data) return '';
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Perbandingan waktu-konstan untuk dua string (signature, token). */
export function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}
