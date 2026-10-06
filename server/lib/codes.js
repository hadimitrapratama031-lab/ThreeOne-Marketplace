/**
 * Helper murni untuk Sistem Code (tanpa akses database / jaringan).
 * Format input Admin: satu code per baris.
 */
export const MAX_CODES_PER_SUBMIT = 2000;           // JSON body Express dibatasi 256 KB; 2000 code ≈ 40–80 KB
export const CODE_RE = /^[\x21-\x7E]{4,100}$/;      // ASCII yang tercetak, tanpa spasi, 4–100 karakter

/** Kunci pembanding duplikat: tidak peduli huruf besar/kecil. Code asli tetap disimpan apa adanya. */
export const codeKeyOf = (code) => String(code ?? '').trim().toUpperCase();

/**
 * @param {string|string[]} input teks (satu code per baris) atau array
 * @returns {{ codes: {code:string, codeKey:string}[], invalid: {line:number, value:string, reason:string}[], duplicatesInInput: string[], tooMany: boolean }}
 */
export function parseCodeLines(input) {
  const lines = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/\r\n|\r|\n/);
  const seen = new Set();
  const codes = [];
  const invalid = [];
  const duplicatesInInput = [];
  lines.forEach((raw, i) => {
    const value = raw.trim();
    if (!value) return;                                           // baris kosong diabaikan
    if (!CODE_RE.test(value)) {
      invalid.push({ line: i + 1, value: value.slice(0, 40), reason: /\s/.test(value) ? 'mengandung spasi' : value.length < 4 ? 'terlalu pendek (min 4 karakter)' : value.length > 100 ? 'terlalu panjang (maks 100 karakter)' : 'berisi karakter yang tidak didukung' });
      return;
    }
    const codeKey = codeKeyOf(value);
    if (seen.has(codeKey)) { duplicatesInInput.push(value); return; }
    seen.add(codeKey);
    codes.push({ code: value, codeKey });
  });
  return { codes, invalid, duplicatesInInput, tooMany: codes.length > MAX_CODES_PER_SUBMIT };
}

/** Langkah tutorial: satu langkah per baris; awalan nomor ("1.", "2)", "-", "•") dibuang karena UI memberi nomor sendiri. */
export function tutorialSteps(text) {
  return String(text ?? '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim().replace(/^(?:\d{1,2}\s*[.)]|[-*•])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 30);
}

/** Untuk log: jangan pernah menulis code utuh ke log server. */
export const maskCode = (code) => {
  const c = String(code ?? '');
  return c.length <= 6 ? '••••' : `${c.slice(0, 2)}••••${c.slice(-2)}`;
};
