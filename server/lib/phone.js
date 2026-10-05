/** Normalkan nomor WhatsApp ke format internasional tanpa "+" (contoh: 081234567890 -> 6281234567890). '' bila tidak valid. */
export function normalizeWhatsapp(input) {
  const raw = String(input ?? '').trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (!raw.startsWith('+') && d.startsWith('8')) d = `62${d}`;   // 812xxxx tanpa 0
  if (d.startsWith('620')) d = `62${d.slice(3)}`;                     // "+62 0812..." salah ketik umum
  if (!/^[1-9]\d{7,14}$/.test(d)) return '';
  if (d.startsWith('62') && (d.length < 10 || d.length > 15)) return '';
  return d;
}

/** Tampilan ramah: 6281234567890 -> +62 812-3456-7890 */
export function formatWhatsapp(d) {
  const s = String(d || '');
  if (!s.startsWith('62')) return s ? `+${s}` : '';
  const rest = s.slice(2);
  return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}-${rest.slice(7)}`.replace(/-$/, '');
}

/** Nomor yang sudah dinormalkan (62…) layak dikirim ke Fonnte: 62 + 8–13 digit (aturan sama dengan project lama). */
export const isValidWhatsApp = (n) => /^62\d{8,13}$/.test(String(n || '').replace(/\D/g, ''));
export const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
