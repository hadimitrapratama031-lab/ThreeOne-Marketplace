import crypto from 'node:crypto';

/**
 * Verifikasi webhook Svix (dipakai Resend): HMAC-SHA256 atas "{svix-id}.{svix-timestamp}.{rawBody}" memakai secret
 * "whsec_<base64>", dibandingkan timing-safe dengan tiap signature di header svix-signature. Dihitung atas byte MENTAH body.
 */
const TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature({ secret, id, timestamp, signatureHeader, rawBody }) {
  if (!secret || !id || !timestamp || !signatureHeader || !rawBody) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from(crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody.toString('utf8')}`).digest('base64'));
  return String(signatureHeader).split(' ').map((p) => p.split(',')[1]).filter(Boolean).some((c) => {
    const b = Buffer.from(c);
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
}
