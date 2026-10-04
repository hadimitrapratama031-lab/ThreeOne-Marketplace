/**
 * Parser murni (tanpa I/O) untuk data Steam Store `appdetails`.
 * Steam mengirim deskripsi & persyaratan sistem sebagai HTML; di sini diubah menjadi teks bersih
 * dan baris { label, value } yang cocok dengan skema produk (specs.min / specs.rec).
 */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const clean = (s) => s
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b\ufeff]/g, '') // karakter kontrol & zero-width
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t]+/g, ' ');

/** HTML -> teks. Blok (p, div, li, br, h1-6) menjadi baris baru; tag lain dibuang; script/style dibuang beserta isinya. */
export function htmlToText(input, { paragraphs = true } = {}) {
  let s = String(input ?? '');
  if (!s.trim()) return '';
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|ul|ol|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<(p|div|ul|ol|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '');
  s = clean(decodeEntities(s));
  const lines = s.split('\n').map((l) => l.trim());
  // baris kosong berurutan -> satu pemisah paragraf
  const out = [];
  let blank = false;
  for (const l of lines) {
    if (!l) { blank = out.length > 0; continue; }
    if (blank && paragraphs) out.push('');
    blank = false;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** Potong di batas kalimat/paragraf terdekat sebelum `max` karakter. Mengembalikan { text, truncated }. */
export function fitText(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return { text: t, truncated: false };
  const head = t.slice(0, max);
  const para = head.lastIndexOf('\n\n');
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  let cut = para > max * 0.5 ? para : sentence > max * 0.6 ? sentence + 1 : -1;
  if (cut < 0) {
    const sp = head.lastIndexOf(' ');
    return { text: head.slice(0, sp > max * 0.6 ? sp : max - 1).trimEnd() + '…', truncated: true };
  }
  return { text: head.slice(0, cut).trim(), truncated: true };
}

/** Deskripsi singkat (kartu produk, maks 300): ringkasan Steam dalam satu paragraf. */
export function shortDescription(html, max = 300) {
  const flat = htmlToText(html, { paragraphs: false }).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return fitText(flat, max);
}

/** Deskripsi lengkap (maks 4000): paragraf dipisah satu baris kosong, sesuai format "Tentang Produk". */
export function aboutText(html, max = 4000) {
  const text = htmlToText(html).replace(/^• /gm, '- ');
  return fitText(text, max);
}

/* ---------- Persyaratan sistem ---------- */

const HEADING = /^(minimum|recommended|min\.?|rec\.?|minimum requirements|recommended requirements|system requirements)\s*:?$/i;
// label tidak boleh terlalu panjang, supaya kalimat biasa yang kebetulan memuat ':' tidak dianggap label
const LABEL_VALUE = /^([^:：]{1,40}?)\s*[:：]\s*(.*)$/;

const tidyLabel = (l) => l.replace(/\s*\*+\s*$/, '').replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();
const tidyValue = (v) => v.replace(/\s+/g, ' ').trim();

/**
 * Teks/HTML persyaratan Steam -> [{label, value}]. Menangani dua bentuk umum:
 *  1) <ul><li><strong>OS:</strong> Windows 10</li>...</ul>
 *  2) teks datar dipisah <br>: "OS: Windows 10<br>Processor: ..."
 * Baris tanpa label (mis. catatan) ditambahkan ke nilai baris sebelumnya bila itu lanjutan, atau menjadi "Notes".
 * Tidak pernah mengarang label/nilai: yang tidak ada dibiarkan kosong.
 */
export function parseRequirements(raw) {
  const result = { rows: [], truncated: 0, dropped: 0 };
  if (!raw || typeof raw !== 'string' || !raw.trim()) return result;

  // Tandai <strong>Label:</strong> sebagai "Label:" agar bentuk (1) dan (2) diproses sama
  const text = htmlToText(raw.replace(/<strong>\s*([^<]*?)\s*<\/strong>/gi, '$1'), { paragraphs: false });
  const rows = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^•\s*/, '').trim();
    if (!line || HEADING.test(line.replace(/\*+$/, '').trim())) continue;
    const m = line.match(LABEL_VALUE);
    if (m && tidyLabel(m[1])) {
      const label = tidyLabel(m[1]);
      const value = tidyValue(m[2]);
      if (HEADING.test(label) && !value) continue;
      rows.push({ label, value });
    } else if (rows.length && (!rows[rows.length - 1].value || !/^[*\-–]/.test(line))) {
      const last = rows[rows.length - 1];
      last.value = (last.value ? last.value + ' ' : '') + tidyValue(line); // lanjutan baris sebelumnya
    } else {
      rows.push({ label: 'Notes', value: tidyValue(line.replace(/^[*\-–]\s*/, '')) });
    }
  }

  const seen = new Set();
  for (const r of rows) {
    if (!r.value) { result.dropped++; continue; } // label tanpa nilai: dibiarkan kosong, tidak dikarang
    if (r.label.length > 60) r.label = r.label.slice(0, 59) + '…';
    if (r.value.length > 200) { r.value = fitText(r.value, 200).text; result.truncated++; }
    const k = `${r.label}|${r.value}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    result.rows.push(r);
  }
  if (result.rows.length > 20) { result.dropped += result.rows.length - 20; result.rows.length = 20; }
  return result;
}

/** pc_requirements dari Steam bisa berupa objek {minimum, recommended} atau array kosong []. */
export function parsePcRequirements(pc) {
  const o = pc && !Array.isArray(pc) && typeof pc === 'object' ? pc : {};
  return { min: parseRequirements(o.minimum), rec: parseRequirements(o.recommended) };
}
