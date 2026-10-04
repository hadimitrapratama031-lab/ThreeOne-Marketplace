import { config } from '../config/env.js';
import { emitAdmin } from '../lib/realtime.js';

/** Gambar publik yang gagal dimuat browser (dilaporkan Marketplace). Disimpan di memori, maksimal 50 URL. */
const errors = new Map();

export function recordImageError(url, page) {
  if (typeof url !== 'string' || url.length > 600) return false;
  // Hanya URL milik R2 kita yang dicatat, supaya endpoint ini tidak bisa dipakai menyampah log
  if (!config.r2.publicUrl || !url.startsWith(config.r2.publicUrl + '/')) return false;
  const prev = errors.get(url);
  const entry = { url, page: String(page || '').slice(0, 200), count: (prev?.count || 0) + 1, lastAt: new Date().toISOString() };
  errors.delete(url);
  errors.set(url, entry);
  if (errors.size > 50) errors.delete(errors.keys().next().value);
  if (!prev) console.warn(`[image-error] gambar publik gagal dimuat: ${url} (halaman ${entry.page || '-'})`);
  emitAdmin('media:error', entry);
  return true;
}
export const listImageErrors = () => [...errors.values()].reverse();
export const clearImageErrors = () => errors.clear();
