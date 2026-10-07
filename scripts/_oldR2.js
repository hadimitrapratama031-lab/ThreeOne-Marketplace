/**
 * Pembaca bucket Cloudflare R2 LAMA (hanya baca). Dipakai migrate-from-old.js untuk menyalin gambar produk.
 *
 * Variabel (di .env atau lingkungan, awalan OLD_R2_ supaya tidak bentrok dengan R2_* milik project baru):
 *   OLD_R2_ACCOUNT_ID, OLD_R2_ACCESS_KEY_ID, OLD_R2_SECRET_ACCESS_KEY, OLD_R2_BUCKET_NAME   (wajib bila dipakai)
 *   OLD_R2_PUBLIC_URL        (opsional: dipakai bila key gambar tidak tercatat, atau sebagai cadangan unduh lewat URL)
 *   OLD_R2_ENDPOINT, OLD_R2_FORCE_PATH_STYLE   (opsional: hanya untuk R2 tiruan / uji)
 * Tanpa OLD_R2_*: gambar diunduh lewat URL publik yang tersimpan di produk lama (lebih lambat; domain *.r2.dev bisa kena throttle).
 */
import { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const clean = (v) => (v ? String(v).trim().replace(/^(["'])(.*)\1$/s, '$2').trim() : '');
const trimSlash = (v) => clean(v).replace(/\/+$/, '');
const MAX_BYTES = 50 * 1024 * 1024;

export function readOldR2Env(env = process.env) {
  const cfg = {
    accountId: clean(env.OLD_R2_ACCOUNT_ID), accessKeyId: clean(env.OLD_R2_ACCESS_KEY_ID), secretAccessKey: clean(env.OLD_R2_SECRET_ACCESS_KEY),
    bucket: clean(env.OLD_R2_BUCKET_NAME), publicUrl: trimSlash(env.OLD_R2_PUBLIC_URL),
    forcePathStyle: ['1', 'true', 'yes', 'on'].includes(clean(env.OLD_R2_FORCE_PATH_STYLE).toLowerCase()),
  };
  cfg.endpoint = trimSlash(env.OLD_R2_ENDPOINT) || (cfg.accountId ? `https://${cfg.accountId}.r2.cloudflarestorage.com` : '');
  cfg.any = Boolean(cfg.accountId || clean(env.OLD_R2_ENDPOINT) || cfg.accessKeyId || cfg.secretAccessKey || cfg.bucket);
  cfg.missing = [['OLD_R2_ACCOUNT_ID', cfg.endpoint], ['OLD_R2_ACCESS_KEY_ID', cfg.accessKeyId], ['OLD_R2_SECRET_ACCESS_KEY', cfg.secretAccessKey], ['OLD_R2_BUCKET_NAME', cfg.bucket]]
    .filter(([, v]) => !v).map(([k]) => k);
  cfg.complete = cfg.any && cfg.missing.length === 0;
  return cfg;
}

const isMissing = (e) => e?.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(e?.name) || e?.Code === 'NoSuchKey';

/** @param cfg hasil readOldR2Env()  @param opts.fetchImpl untuk uji */
export function createOldSource(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const useS3 = cfg.complete;
  let client;
  const s3 = () => (client ||= new S3Client({
    region: 'auto', endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  }));

  /** Key objek di bucket lama: dari field imageKey, atau diturunkan dari URL publik lama. */
  const keyOf = (ref) => {
    if (ref.key) return ref.key.replace(/^\/+/, '');
    if (cfg.publicUrl && ref.url.startsWith(`${cfg.publicUrl}/`)) {
      try { return decodeURIComponent(ref.url.slice(cfg.publicUrl.length + 1).split(/[?#]/)[0]); } catch { return ''; }
    }
    return '';
  };

  const httpUrl = (ref) => (/^https?:\/\//i.test(ref.url) ? ref.url : '');
  async function httpExists(url) {
    const t = () => AbortSignal.timeout(20_000);
    let r = await fetchImpl(url, { method: 'HEAD', signal: t() }).catch(() => null);
    if (!r || !r.ok) r = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, signal: t() }).catch(() => null);
    return Boolean(r && (r.ok || r.status === 206));
  }
  async function httpGet(url) {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`unduh via URL gagal (HTTP ${r.status})`);
    if (Number(r.headers.get('content-length')) > MAX_BYTES) throw new Error('file terlalu besar (>50 MB)');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('file terlalu besar (>50 MB)');
    return buf;
  }

  return {
    mode: useS3 ? 's3' : 'http',
    describe: () => (useS3 ? `R2 lama via API (bucket ${cfg.bucket})` : 'URL publik lama (OLD_R2_* tidak diisi)'),
    keyOf,

    /** Uji akses baca bucket lama (hanya mode s3). */
    async check() {
      if (!useS3) return { ok: true, message: 'mode URL publik: tidak ada yang diuji di muka' };
      try { await s3().send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 })); return { ok: true, message: 'bucket lama bisa dibaca' }; } catch (e) {
        const st = e?.$metadata?.httpStatusCode;
        const why = st === 403 ? 'akses ditolak: token OLD_R2_* tidak berhak membaca bucket ini' : e?.name === 'NoSuchBucket' ? 'bucket tidak ditemukan: periksa OLD_R2_BUCKET_NAME' : `${e?.name || 'error'}${st ? ` (HTTP ${st})` : ''}`;
        return { ok: false, message: `Tidak bisa membaca bucket R2 lama — ${why}` };
      }
    },

    async exists(ref) {
      const key = keyOf(ref);
      if (useS3 && key) {
        try { await s3().send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key })); return true; } catch (e) { if (!isMissing(e)) throw e; }
      }
      const url = httpUrl(ref);
      return url ? httpExists(url) : false;
    },

    async get(ref) {
      const key = keyOf(ref);
      let s3Error = '';
      if (useS3 && key) {
        try {
          const r = await s3().send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
          const buf = Buffer.from(await r.Body.transformToByteArray());
          if (buf.length > MAX_BYTES) throw new Error('file terlalu besar (>50 MB)');
          return buf;
        } catch (e) { if (!isMissing(e)) throw e; s3Error = 'tidak ada di bucket lama'; }
      }
      const url = httpUrl(ref);
      if (!url) throw new Error(s3Error || 'tidak ada key maupun URL yang bisa dipakai');
      return httpGet(url);
    },
  };
}
