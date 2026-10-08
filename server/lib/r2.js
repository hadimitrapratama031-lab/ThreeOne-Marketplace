import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config, r2Configured } from '../config/env.js';
import { HttpError } from './http.js';
import { classifyR2Error, redact } from './r2Errors.js';

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

/* ---------- Penanganan & pencatatan error ---------- */

const endpointHost = () => {
  try { return new URL(config.r2.endpoint).host; } catch { return '(endpoint tidak valid)'; }
};
const secrets = () => [config.r2.accessKeyId, config.r2.secretAccessKey];

/** Catat kegagalan R2 di log server: operasi, status, kode, bucket, endpoint, key. Tidak pernah memuat kredensial. */
function logFailure(op, key, err, info) {
  const detail = redact(err?.message, secrets()).replace(/\s+/g, ' ').slice(0, 200);
  const reqId = err?.$metadata?.requestId || err?.$metadata?.cfId || '-';
  console.error(
    `[r2] ${op} GAGAL status=${info.httpStatus ?? '-'} code=${info.code} jenis=${info.kind} bucket=${config.r2.bucket} endpoint=${endpointHost()}${key ? ` key=${key}` : ''} requestId=${reqId} pesan="${detail}"\n`
    + `[r2] -> ${info.message}`,
  );
}

/** Ubah error SDK menjadi HttpError yang jelas (bukan 500 generik) dan catat penyebab aslinya. */
function failure(op, key, err) {
  const info = classifyR2Error(err);
  logFailure(op, key, err, info);
  return new HttpError(info.status, info.message);
}

async function send(op, key, command) {
  try {
    return await getClient().send(command);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw failure(op, key, err);
  }
}

/* ---------- Operasi objek ---------- */

export async function putObject({ key, body, contentType }) {
  await send('PutObject', key, new PutObjectCommand({
    Bucket: config.r2.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

/** Unduh isi objek (dipakai membuat rendition banner Social Share dari file asli di R2). */
export async function getObjectBuffer(key) {
  const r = await send('GetObject', key, new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}

export async function headObject(key) {
  let r;
  try {
    r = await getClient().send(new HeadObjectCommand({ Bucket: config.r2.bucket, Key: key }));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return { exists: false };
    throw failure('HeadObject', key, err);
  }
  return { exists: true, size: Number(r.ContentLength), contentType: r.ContentType };
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
        logFailure('DeleteObject', batch[n], r.reason, classifyR2Error(r.reason));
      }
    });
  }
  return { deleted, failed };
}

/* ---------- Diagnosa konfigurasi & izin (dipanggil saat server start) ---------- */

/** Ringkasan variable R2 yang terbaca server. Hanya status/panjang — nilai rahasia TIDAK pernah ditampilkan. */
export function r2EnvReport() {
  const env = process.env;
  const { accountId, accessKeyId, secretAccessKey, bucket, publicUrl: pub, endpoint } = config.r2;
  const lines = [];
  const warn = [];
  const secret = (name, v, expect) => {
    if (!v) { lines.push(`${name}: KOSONG`); return; }
    const raw = String(env[name] ?? '');
    if (raw !== v) warn.push(`${name} mengandung spasi/tanda kutip di awal/akhir (otomatis dibersihkan, tetapi sebaiknya perbaiki nilainya).`);
    if (v.length !== expect) warn.push(`${name} panjangnya ${v.length}, biasanya ${expect} karakter (salah salin/terpotong?).`);
    lines.push(`${name}: terbaca (${v.length} karakter)`);
  };
  secret('R2_ACCOUNT_ID', accountId, 32);
  secret('R2_ACCESS_KEY_ID', accessKeyId, 32);
  secret('R2_SECRET_ACCESS_KEY', secretAccessKey, 64);
  lines.push(`R2_BUCKET_NAME: ${bucket || 'KOSONG'}`);
  lines.push(`R2_PUBLIC_URL: ${pub || 'KOSONG'}`);
  lines.push(`R2_ENDPOINT: ${endpoint || 'KOSONG'}${env.R2_ENDPOINT ? ' (diisi manual)' : ' (dibentuk dari R2_ACCOUNT_ID)'}`);
  try {
    const u = new URL(endpoint);
    if (u.pathname !== '/') warn.push('R2_ENDPOINT berisi path (mis. nama bucket). Hapus path-nya: harus hanya https://<account>.r2.cloudflarestorage.com');
  } catch { if (endpoint) warn.push('R2_ENDPOINT bukan URL yang valid.'); }
  if (bucket && /[\s/]/.test(bucket)) warn.push('R2_BUCKET_NAME berisi spasi atau "/". Isi hanya nama bucket.');
  return { lines, warn };
}

/**
 * Uji nyata ke R2: baca (list) -> tulis (put) -> verifikasi (head) -> hapus (delete) satu objek kecil di `_healthcheck/`.
 * Tidak melempar; hasilnya dicatat di log supaya penyebab upload gagal (izin token, bucket, endpoint) langsung terlihat.
 */
export async function probeR2() {
  const result = { list: '-', put: '-', head: '-', delete: '-' };
  if (!r2Configured()) return { ok: false, result };
  const key = `_healthcheck/${crypto.randomUUID()}.txt`;
  const bucket = config.r2.bucket;
  const step = async (name, fn) => {
    try { const v = await fn(); result[name] = 'ok'; return { ok: true, v }; } catch (err) {
      const info = classifyR2Error(err);
      result[name] = `${info.code}${info.httpStatus ? `/${info.httpStatus}` : ''}`;
      return { ok: false, info };
    }
  };
  const c = getClient();
  const list = await step('list', () => c.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 })));
  const put = await step('put', () => c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from('ok'), ContentType: 'text/plain' })));
  if (put.ok) {
    await step('head', () => c.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
    await step('delete', () => c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))); // selalu bersihkan objek uji
  }
  const ok = put.ok && result.head === 'ok' && result.delete === 'ok';
  console.log(`[r2] cek akses bucket=${bucket} endpoint=${endpointHost()} -> baca(list)=${result.list} tulis(put)=${result.put} verifikasi(head)=${result.head} hapus(delete)=${result.delete}`);
  if (ok) {
    console.log('[r2] OK: server dapat menulis, membaca, dan menghapus objek di bucket R2. Upload media siap.');
  } else if (!put.ok && put.info.kind === 'permission') {
    console.error(list.ok
      ? '[r2] DIAGNOSA: token bisa MEMBACA tetapi DITOLAK MENULIS (AccessDenied) -> API Token R2 kemungkinan "Object Read only". Buat token baru dengan izin "Object Read & Write" untuk bucket ini, lalu perbarui R2_ACCESS_KEY_ID dan R2_SECRET_ACCESS_KEY di server.'
      : `[r2] DIAGNOSA: token DITOLAK untuk membaca maupun menulis bucket "${bucket}" (AccessDenied) -> token dibatasi ke bucket lain, atau R2_BUCKET_NAME / R2_ACCOUNT_ID tidak cocok dengan token. Periksa "Permissions" dan "Specify bucket(s)" pada API Token di Cloudflare R2.`);
  } else if (!put.ok) {
    console.error(`[r2] DIAGNOSA: ${put.info.message}`);
  } else {
    console.error(`[r2] DIAGNOSA: tulis berhasil tetapi verifikasi/hapus gagal (head=${result.head}, delete=${result.delete}). Pastikan token berizin "Object Read & Write". Objek uji tersisa: ${key}`);
  }
  return { ok, result };
}
