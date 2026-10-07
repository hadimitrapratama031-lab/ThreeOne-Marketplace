import crypto from 'node:crypto';
import { Asset } from '../models/index.js';
import { putObject, headObject, deleteObjects, publicUrl } from '../lib/r2.js';
import { sniff } from '../lib/sniff.js';
import { HttpError } from '../lib/http.js';
import { config } from '../config/env.js';

export const FOLDERS = ['products', 'reviews', 'hero', 'branding', 'livechat'];

const sameOwner = (a, b) => a?.type === b.type && a?.id === String(b.id);

/** Upload buffer ke R2 dan catat sebagai aset 'temp' (belum dipakai entitas manapun). */
export async function uploadAsset({ buffer, originalName, folder }) {
  if (!FOLDERS.includes(folder)) throw new HttpError(422, 'Folder upload tidak valid', { fields: { folder: 'Pilihan tidak valid' } });
  const info = sniff(buffer);
  if (!info) throw new HttpError(415, 'Format file tidak didukung. Gunakan JPG, PNG, WebP, GIF, AVIF (gambar) atau MP4/WebM (video).');
  const max = info.kind === 'video' ? config.limits.videoBytes : config.limits.imageBytes;
  if (buffer.length > max) throw new HttpError(413, `Ukuran file terlalu besar (maksimal ${Math.round(max / 1048576)} MB untuk ${info.kind === 'video' ? 'video' : 'gambar'}).`);
  if (info.kind === 'video' && folder !== 'products') throw new HttpError(422, 'Video hanya boleh untuk galeri produk.');

  const now = new Date();
  const key = `${folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${info.ext}`;
  await putObject({ key, body: buffer, contentType: info.mime });

  // Setelah objek ada di R2, kegagalan apa pun (verifikasi / simpan ke MongoDB) tidak boleh meninggalkan objek yatim
  // yang tidak tercatat di koleksi assets (sweeper tidak akan pernah menemukannya).
  try {
    // Verifikasi objek benar-benar ada di R2 sebelum dilaporkan berhasil
    const head = await headObject(key);
    if (!head.exists || head.size !== buffer.length) throw new HttpError(502, 'Upload ke penyimpanan gagal diverifikasi. Coba lagi.');
    return await Asset.create({
      key, url: publicUrl(key), kind: info.kind, mime: info.mime, size: buffer.length,
      folder, originalName: String(originalName || '').slice(0, 200), status: 'temp',
    });
  } catch (err) {
    await deleteObjects([key]).catch(() => {});
    throw err;
  }
}

/**
 * Validasi daftar key dari klien untuk sebuah pemilik (produk/review/hero…).
 * - key harus terdaftar sebagai aset, folder sesuai, belum dimiliki entitas lain
 * - aset baru ('temp') diverifikasi masih ada di R2
 * Mengembalikan aset berurutan sesuai input.
 */
export async function resolveForOwner(keys, owner, { folders, kinds = ['image'], max = 99 } = {}) {
  const uniq = [...new Set(keys)];
  if (uniq.length !== keys.length) throw new HttpError(422, 'Gambar duplikat dalam satu daftar.');
  if (keys.length > max) throw new HttpError(422, `Maksimal ${max} file.`);
  if (!keys.length) return [];

  const found = await Asset.find({ key: { $in: keys } });
  const byKey = new Map(found.map((a) => [a.key, a]));
  const out = [];
  for (const key of keys) {
    const a = byKey.get(key);
    if (!a) throw new HttpError(422, 'Salah satu file tidak dikenal. Upload ulang file tersebut.');
    if (!folders.includes(a.folder)) throw new HttpError(422, 'File ini tidak boleh dipakai di bagian tersebut.');
    if (!kinds.includes(a.kind)) throw new HttpError(422, a.kind === 'video' ? 'Video tidak diizinkan di bagian ini.' : 'Hanya gambar yang diizinkan di bagian ini.');
    if (a.status === 'used' && !sameOwner(a.owner, owner)) throw new HttpError(409, 'File ini sudah dipakai oleh data lain.');
    out.push(a);
  }
  // Verifikasi file baru masih ada di R2 (mis. belum terhapus oleh pembersihan otomatis)
  for (const a of out.filter((x) => x.status !== 'used')) {
    const head = await headObject(a.key);
    if (!head.exists) throw new HttpError(422, 'File yang diupload tidak ditemukan di penyimpanan. Upload ulang.');
  }
  return out;
}

/** Hapus objek R2 + catatan aset. Yang gagal dihapus ditandai 'orphan' agar dicoba lagi oleh sweeper. */
export async function destroyAssets(assets) {
  if (!assets.length) return;
  const { deleted, failed } = await deleteObjects(assets.map((a) => a.key));
  if (deleted.length) await Asset.deleteMany({ key: { $in: deleted } });
  if (failed.length) await Asset.updateMany({ key: { $in: failed } }, { $set: { status: 'orphan', owner: null } });
}

/**
 * Setelah data entitas tersimpan di MongoDB: tandai key terpakai, lalu hapus aset milik
 * entitas yang sudah tidak direferensikan (urutan: simpan baru -> hapus lama).
 */
export async function attach(owner, keys) {
  const ownerDoc = { type: owner.type, id: String(owner.id) };
  if (keys.length) await Asset.updateMany({ key: { $in: keys } }, { $set: { status: 'used', owner: ownerDoc } });
  const stale = await Asset.find({ 'owner.type': ownerDoc.type, 'owner.id': ownerDoc.id, key: { $nin: keys } });
  await destroyAssets(stale);
}

/**
 * Tandai key terpakai oleh pemilik TANPA menghapus aset lain milik pemilik yang sama (beda dengan attach()).
 * Dipakai Live Chat: gambar bertambah satu per pesan, jadi daftar milik percakapan terus tumbuh.
 */
export async function markUsed(owner, keys) {
  if (!keys.length) return;
  await Asset.updateMany({ key: { $in: keys } }, { $set: { status: 'used', owner: { type: owner.type, id: String(owner.id) } } });
}

/** Entitas dihapus: hapus semua aset miliknya. */
export async function releaseOwner(owner) {
  const stale = await Asset.find({ 'owner.type': owner.type, 'owner.id': String(owner.id) });
  await destroyAssets(stale);
}

/** Bersihkan upload yang tidak pernah disimpan (>6 jam) dan coba ulang hapus yang gagal. */
export async function sweepAssets({ tempMaxAgeMs = 6 * 3600 * 1000 } = {}) {
  const cutoff = new Date(Date.now() - tempMaxAgeMs);
  const stale = await Asset.find({ $or: [{ status: 'temp', createdAt: { $lt: cutoff } }, { status: 'orphan' }] }).limit(200);
  await destroyAssets(stale);
  return stale.length;
}
