/** Deteksi tipe file dari byte awal (bukan dari nama/header yang bisa dipalsukan). SVG sengaja ditolak (risiko XSS). */
export function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (a, b) => buf.toString('latin1', a, b);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  // ICO (favicon): header 00 00 01 00, jumlah gambar 1-64, byte cadangan entri pertama = 0. Hanya diizinkan di folder branding.
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0 && buf.length >= 22 && buf[4] >= 1 && buf[4] <= 64 && buf[5] === 0 && buf[9] === 0) {
    return { kind: 'image', mime: 'image/x-icon', ext: 'ico' };
  }
  if (ascii(0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return { kind: 'image', mime: 'image/avif', ext: 'avif' };
    // Brand umum MP4 dari kamera HP / ekspor editor (iso3-iso6, mp71, mmp4, MSNV selain isom/mp42 yang paling sering)
    if (['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mp71', 'mmp4', 'MSNV', 'avc1', 'M4V ', 'dash'].includes(brand)) return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: 'video', mime: 'video/webm', ext: 'webm' };
  return null;
}

/**
 * Ukuran piksel (width x height) dari header PNG/JPEG — tanpa library. Dipakai og:image:width/height agar nilainya
 * sesuai gambar sebenarnya (bukan angka tebakan). null bila format lain / header rusak.
 */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    const width = buf.readUInt32BE(16); const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // SOF0-SOF15 (kecuali DHT 0xC4, JPG 0xC8, DAC 0xCC) memuat ukuran frame
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const height = buf.readUInt16BE(i + 5); const width = buf.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}
