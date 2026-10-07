/**
 * Menyalin gambar produk dari R2 lama ke R2 baru dan mendaftarkannya sebagai Asset milik produk.
 * Semua akses (R2 lama, R2 baru, MongoDB) masuk lewat `deps` supaya logikanya bisa diuji tanpa server nyata.
 *
 * Anti dobel: setiap Asset hasil salin membawa penanda `legacy:<key lama>` (originalName) + pemilik produk; jalan ulang memakai
 * kembali aset itu (selama objeknya masih ada di R2 baru). Key R2 baru deterministik, jadi upload ulang tidak menggandakan objek.
 */
import { legacyMarker, legacyNewKey } from './legacyMap.js';

/**
 * @param {{refs: {key:string,url:string}[], ownerId: any, apply: boolean}} input
 * @param deps { source:{exists,get}, sniff, putObject, headObject, publicUrl, findAsset(marker, ownerId), saveAsset(doc) }
 * @returns {{items:{type:'image',key:string,url:string}[], found:number, copied:number, reused:number, failed:{label:string,reason:string}[]}}
 */
export async function migrateProductImages({ refs, ownerId, apply }, deps) {
  const out = { items: [], found: 0, copied: 0, reused: 0, failed: [] };
  for (const ref of refs) {
    const label = ref.key || ref.url;
    try {
      if (!apply) {   // dry-run: hanya memastikan gambar lama ada, tidak menulis apa pun
        if (await deps.source.exists(ref)) out.found += 1; else out.failed.push({ label, reason: 'tidak ditemukan di R2 lama' });
        continue;
      }
      const marker = legacyMarker(ref);
      const existing = await deps.findAsset(marker, ownerId);
      if (existing) {
        const head = await deps.headObject(existing.key);
        if (head.exists) { out.items.push({ type: 'image', key: existing.key, url: existing.url }); out.found += 1; out.reused += 1; continue; }
      }
      const buf = await deps.source.get(ref);
      const info = deps.sniff(buf);
      if (!info || info.kind !== 'image') throw new Error('format file tidak didukung (bukan JPG/PNG/WebP/GIF/AVIF)');
      const key = existing?.key || legacyNewKey(ownerId, ref, info.ext);
      await deps.putObject({ key, body: buf, contentType: info.mime });
      const head = await deps.headObject(key);
      if (!head.exists || head.size !== buf.length) throw new Error('verifikasi setelah upload gagal');
      const url = deps.publicUrl(key);
      await deps.saveAsset({ key, url, kind: 'image', mime: info.mime, size: buf.length, folder: 'products', originalName: marker, ownerId });
      out.items.push({ type: 'image', key, url }); out.found += 1; out.copied += 1;
    } catch (e) {
      out.failed.push({ label, reason: String(e?.message || e).replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return out;
}
