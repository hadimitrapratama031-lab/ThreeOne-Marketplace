/**
 * Cache memori singkat untuk data publik Marketplace (bootstrap, detail produk, daftar order terbaru).
 *
 * Aturan kesegaran (supaya tidak pernah mengganggu realtime):
 *  - Setiap event publik Socket.IO (product/category/settings/faq/contact/review/sale/...) memanggil invalidate(),
 *    sehingga data yang dibaca sesudah perubahan selalu dihitung ulang dari MongoDB.
 *  - Hasil yang sedang dihitung ketika terjadi perubahan TIDAK disimpan (dijaga `gen`), jadi tidak ada data lama yang "menyelinap".
 *  - Pengaman tambahan: entri otomatis kedaluwarsa (TTL) walau tidak ada event.
 *  - Permintaan bersamaan untuk kunci yang sama berbagi satu perhitungan (tidak ada query ganda).
 */
const BOOT = Date.now().toString(36);   // beda tiap proses: ETag lama dari proses sebelumnya tidak pernah cocok
let seq = 0;
let gen = 0;
const entries = new Map();   // key -> { value, etag, exp }
const inflight = new Map();  // key -> Promise<{ value, etag }>

export const invalidate = () => { gen++; entries.clear(); inflight.clear(); };

/** @returns {Promise<{ value: any, etag: string }>} */
export function memo(key, ttlMs, loader) {
  const hit = entries.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;

  const startGen = gen;
  const p = (async () => {
    const value = await loader();
    const entry = { value, etag: `W/"${BOOT}-${++seq}"`, exp: Date.now() + ttlMs };
    if (startGen === gen) {
      if (entries.size >= 500) entries.clear();   // pengaman memori (kunci berasal dari URL)
      entries.set(key, entry);
    }   // ada perubahan saat menghitung -> jangan simpan
    return entry;
  })().finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}
