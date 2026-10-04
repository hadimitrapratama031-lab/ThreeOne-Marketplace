import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config, r2Configured } from '../config/env.js';
import { HttpError } from './http.js';

let client;
function getClient() {
  if (!r2Configured()) throw new HttpError(503, 'Penyimpanan gambar (Cloudflare R2) belum dikonfigurasi di server.');
  client ||= new S3Client({
    region: 'auto',
    endpoint: config.r2.endpoint,
    forcePathStyle: config.r2.forcePathStyle,
    credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey },
    // R2 belum menerima checksum tambahan SDK terbaru pada semua operasi
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

/** Hanya untuk tes: reset client agar membaca ulang config. */
export function resetR2Client() {
  client = undefined;
}

export const publicUrl = (key) => `${config.r2.publicUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;

export async function putObject({ key, body, contentType }) {
  await getClient().send(new PutObjectCommand({
    Bucket: config.r2.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

export async function headObject(key) {
  try {
    const r = await getClient().send(new HeadObjectCommand({ Bucket: config.r2.bucket, Key: key }));
    return { exists: true, size: Number(r.ContentLength), contentType: r.ContentType };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return { exists: false };
    throw err;
  }
}

/** Hapus beberapa objek. Mengembalikan { deleted, failed } — tidak pernah melempar per-objek. */
export async function deleteObjects(keys) {
  const deleted = [];
  const failed = [];
  for (let i = 0; i < keys.length; i += 10) {
    const batch = keys.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map((key) => getClient().send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }))),
    );
    results.forEach((r, n) => {
      if (r.status === 'fulfilled') deleted.push(batch[n]);
      else {
        failed.push(batch[n]);
        console.error(`[r2] gagal menghapus ${batch[n]}: ${r.reason?.message || r.reason}`);
      }
    });
  }
  return { deleted, failed };
}
