/** Pemetaan murni (tanpa database) dari data project lama ke bentuk project baru. Diuji terpisah. */
import crypto from 'node:crypto';

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

/* ---------- Teks produk ---------- */

/** Teks panjang (Tentang produk): pertahankan baris baru, rapikan spasi berlebih, potong di `max`. */
export const cleanText = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

/**
 * Ringkasan produk (field `description` di project baru, maks. 300). Memakai shortDescription lama apa adanya;
 * bila kosong, diambil dari awal deskripsi lengkap (dipotong di batas kata). Tidak pernah mengarang teks.
 */
export const makeBlurb = (short, full, max = 300) => {
  const s = cleanName(short, max);
  if (s) return s;
  const f = cleanName(full, 100000);
  if (!f) return '';
  if (f.length <= max) return f;
  const cut = f.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
};

/* ---------- Gambar produk ---------- */

/** Gambar utama + gambar tambahan produk lama, berurutan, tanpa duplikat. Tiap item { key, url } (salah satunya boleh kosong). */
export function legacyImageRefs(p) {
  const refs = []; const seen = new Set();
  const add = (key, url) => {
    const k = String(key ?? '').trim(); const u = String(url ?? '').trim(); const id = k || u;
    if (!id || seen.has(id)) return;
    seen.add(id); refs.push({ key: k, url: u });
  };
  add(p?.imageKey, p?.image);
  for (const a of Array.isArray(p?.additionalImages) ? p.additionalImages : []) add(a?.key, a?.url);
  return refs;
}

export const LEGACY_PREFIX = 'products/legacy/';
export const isLegacyKey = (key) => String(key ?? '').startsWith(LEGACY_PREFIX);

/** Penanda di Asset.originalName: menghubungkan aset baru dengan gambar lama (anti dobel saat migrasi diulang). */
export const legacyMarker = (ref) => {
  const id = ref.key || ref.url;
  const m = `legacy:${id}`;
  return m.length <= 200 ? m : `legacy:sha1:${crypto.createHash('sha1').update(id).digest('hex')}`;
};

const pathOf = (u) => { try { const p = new URL(u).pathname; try { return decodeURIComponent(p); } catch { return p; } } catch { return String(u); } };

/** Key R2 baru, deterministik per (produk, gambar lama): upload ulang menimpa objek yang sama, bukan menggandakan. */
export function legacyNewKey(ownerId, ref, ext) {
  const raw = (ref.key || pathOf(ref.url)).split('/').pop().replace(/\.[^.]*$/, '');
  const base = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    || crypto.createHash('sha1').update(ref.key || ref.url).digest('hex').slice(0, 16);
  return `${LEGACY_PREFIX}${ownerId}/${base}.${ext}`;
}

/** Host + nama database (tanpa kredensial) untuk membandingkan "apakah ini database yang sama". Tahan URI multi-host. */
export const dbTarget = (uri, dbName) => `${String(uri).replace(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+).*$/s, '$1').toLowerCase()}/${String(dbName || '').toLowerCase()}`;
