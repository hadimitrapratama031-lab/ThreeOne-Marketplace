/** Pemetaan murni (tanpa database) dari data project lama ke bentuk project baru. Diuji terpisah. */
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Project lama: order.status ∈ PENDING|PAID|FAILED|EXPIRED|CANCELLED|COMPLETED, order.paymentStatus ∈ PENDING|SUCCESS|FAILED|EXPIRED|CANCELLED.
// Beranda lama menghitung "pesanan selesai" dari order berstatus PAID (COMPLETED juga dianggap berhasil di Admin lama).
const up = (v) => String(v ?? '').trim().toUpperCase();
const PAID_WORDS = new Set(['SUCCESS', 'PAID', 'COMPLETED']);
const FAIL_WORDS = new Set(['FAILED', 'CANCELLED']);

/** `t` = transaksi pembayaran lama milik order (opsional): status/paidAt-nya ikut jadi bukti bahwa order sudah dibayar. */
export const mapOrderStatus = (o, t) => {
  const vals = [o?.status, o?.paymentStatus, t?.status].map(up);
  if (vals.some((v) => PAID_WORDS.has(v)) || t?.paidAt) return 'SUCCESS';
  if (vals.some((v) => FAIL_WORDS.has(v))) return 'FAILED';
  return 'EXPIRED';   // PENDING/EXPIRED lama: tidak pernah diimpor sebagai PENDING agar worker pembayaran tidak memprosesnya
};

/** Label status lama (untuk laporan migrasi): order.status/paymentStatus/transaksi. */
export const legacyStatusLabel = (o, t) => `${up(o?.status) || '-'}/${up(o?.paymentStatus) || '-'}/${up(t?.status) || '-'}`;
export const mapReviewStatus = (s) => (String(s) === 'approved' ? 'published' : 'hidden');   // approved → tayang; hidden & pending → tersembunyi

export const cleanName = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const toInt = (v, min = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, n) : NaN; };
export const normalizeWa = (raw, normalize) => normalize(raw) || String(raw || '').replace(/\D/g, '');
export const sameDb = (a, b) => {
  const k = (u) => { try { const x = new URL(String(u).replace(/^mongodb(\+srv)?:/, 'http:')); return `${x.hostname}${x.pathname}`.toLowerCase(); } catch { return String(u); } };
  return k(a) === k(b);
};
