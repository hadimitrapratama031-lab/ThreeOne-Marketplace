/** Pemetaan murni (tanpa database) dari data project lama ke bentuk project baru. Diuji terpisah. */
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const mapOrderStatus = (o) => {
  const s = String(o?.paymentStatus || o?.status || '').toUpperCase();
  const st = String(o?.status || '').toUpperCase();
  if (['SUCCESS', 'PAID', 'COMPLETED'].includes(s) || ['PAID', 'COMPLETED'].includes(st)) return 'SUCCESS';
  if (['FAILED', 'CANCELLED'].includes(s) || ['FAILED', 'CANCELLED'].includes(st)) return 'FAILED';
  return 'EXPIRED';   // PENDING/EXPIRED lama: tidak pernah diimpor sebagai PENDING agar worker pembayaran tidak memprosesnya
};
export const mapReviewStatus = (s) => (String(s) === 'approved' ? 'published' : 'hidden');   // approved → tayang; hidden & pending → tersembunyi

export const cleanName = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const toInt = (v, min = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, n) : NaN; };
export const normalizeWa = (raw, normalize) => normalize(raw) || String(raw || '').replace(/\D/g, '');
export const sameDb = (a, b) => {
  const k = (u) => { try { const x = new URL(String(u).replace(/^mongodb(\+srv)?:/, 'http:')); return `${x.hostname}${x.pathname}`.toLowerCase(); } catch { return String(u); } };
  return k(a) === k(b);
};
