/**
 * Galeri produk = campuran dua jenis media, urutan dari Admin dipertahankan:
 *   - upload manual   { source:'upload', key }  -> file di Cloudflare R2 (aset divalidasi & dilampirkan seperti biasa)
 *   - media Steam     { source:'steam', url...} -> REFERENSI URL asli Steam; tidak ada aset, tidak ada R2, tidak ada batas MB
 */
import * as assets from './assets.js';
import { urlKey } from '../lib/steamMedia.js';

/** Identitas satu item galeri (dipakai membandingkan hasil simpan): key R2 untuk upload, URL untuk Steam. */
export const mediaIdent = (m) => (m.source === 'steam' ? `steam:${urlKey(m.url)}` : m.key);

/**
 * @param refs  hasil parse productMediaRef (urut sesuai Admin)
 * @returns { media: item siap simpan, keys: key R2 yang dipakai (untuk assets.attach) }
 */
export async function resolveProductMedia(refs, ownerRef) {
  const keys = refs.filter((r) => r.source !== 'steam').map((r) => r.key);
  // Tanpa batas jumlah gambar/video; key R2 ganda tetap ditolak di resolveForOwner.
  const found = await assets.resolveForOwner(keys, ownerRef, { folders: ['products'], kinds: ['image', 'video'], max: Infinity });
  const byKey = new Map(found.map((a) => [a.key, a]));

  const seenSteam = new Set();
  const media = [];
  for (const r of refs) {
    if (r.source === 'steam') {
      const id = `${r.type}:${r.type === 'video' && r.ref ? `ref:${r.ref}` : urlKey(r.url)}`;
      if (seenSteam.has(id)) continue;   // tidak ada media Steam ganda
      seenSteam.add(id);
      media.push(r.type === 'video'
        ? { type: 'video', source: 'steam', key: '', url: r.url, poster: r.poster || '', title: r.title || '', ref: r.ref || '', sources: r.sources || [] }
        : { type: 'image', source: 'steam', key: '', url: r.url });
    } else {
      const a = byKey.get(r.key);
      media.push({ type: a.kind, source: 'upload', key: a.key, url: a.url });
    }
  }
  return { media, keys };
}
