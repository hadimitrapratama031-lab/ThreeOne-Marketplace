/**
 * Normalkan nomor WhatsApp ke format internasional tanpa "+" (contoh: 081234567890 -> 6281234567890). '' bila tidak valid.
 * Nomor yang diawali "+" atau "00" dianggap sudah internasional dan dipakai apa adanya (mis. +60 12-345 6789 -> 60123456789).
 * Tanpa itu, awalan 0 / 8 dianggap nomor Indonesia (perilaku lama). Nomor luar negeri sebaiknya dikirim lengkap dengan +kode negara.
 */
export function normalizeWhatsapp(input) {
  const raw = String(input ?? '').trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (!raw.startsWith('+') && d.startsWith('8')) d = `62${d}`;   // 812xxxx tanpa 0
  if (d.startsWith('620')) d = `62${d.slice(3)}`;                     // "+62 0812..." salah ketik umum
  if (d.startsWith('600')) d = `60${d.slice(3)}`;                     // "+60 012-345..." (Malaysia): angka 0 setelah kode negara salah ketik umum
  if (!/^[1-9]\d{7,14}$/.test(d)) return '';                          // E.164: maksimal 15 digit
  if (d.startsWith('62') && (d.length < 10 || d.length > 15)) return '';
  if (d.startsWith('60') && (d.length < 10 || d.length > 12)) return '';   // Malaysia: 60 + 8–10 digit
  return d;
}

/** Tampilan ramah: 6281234567890 -> +62 812-3456-7890 */
export function formatWhatsapp(d) {
  const s = String(d || '');
  if (!s.startsWith('62')) return s ? `+${s}` : '';
  const rest = s.slice(2);
  return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}-${rest.slice(7)}`.replace(/-$/, '');
}

/** Nomor yang sudah dinormalkan layak dikirim ke Fonnte: format internasional 8–15 digit (Indonesia tetap 62 + 8–13 digit seperti project lama). */
export const isValidWhatsApp = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(d) && (!d.startsWith('62') || /^62\d{8,13}$/.test(d));
};
export const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
