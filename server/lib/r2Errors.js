/**
 * Klasifikasi error dari SDK S3 / Cloudflare R2 menjadi status HTTP + pesan yang aman ditampilkan.
 * Modul murni (tanpa import) supaya mudah diuji. TIDAK PERNAH menyertakan access key / secret.
 *
 * Mengapa perlu: sebelumnya semua error R2 jatuh ke "500 Terjadi kesalahan di server." sehingga
 * penyebab asli (mis. AccessDenied 403 karena API Token R2 tidak punya izin tulis) tidak terlihat.
 */

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
]);

/** @returns {{kind:string,status:number,code:string,httpStatus:number|undefined,message:string}} */
export function classifyR2Error(err) {
  const httpStatus = err?.$metadata?.httpStatusCode;
  // SDK S3 mengisi `Code` (dari XML) dan `name`; error jaringan Node memakai `code` (huruf kecil).
  const code = String(err?.Code || err?.code || err?.name || '').trim();
  const base = { code: code || (httpStatus ? String(httpStatus) : 'UnknownError'), httpStatus };

  if (code === 'InvalidAccessKeyId') {
    return { ...base, kind: 'credentials', status: 503, message: 'Cloudflare R2 menolak Access Key ID (InvalidAccessKeyId). Periksa R2_ACCESS_KEY_ID di server: harus memakai S3 API token dari R2 (Manage API Tokens), tanpa spasi atau tanda kutip.' };
  }
  if (code === 'SignatureDoesNotMatch' || code === 'InvalidSignature') {
    return { ...base, kind: 'credentials', status: 503, message: 'Cloudflare R2 menolak tanda tangan permintaan (SignatureDoesNotMatch). Periksa R2_SECRET_ACCESS_KEY di server: salah, terpotong, atau ada spasi/tanda kutip.' };
  }
  if (code === 'NoSuchBucket' || (httpStatus === 404 && code !== 'NotFound' && code !== 'NoSuchKey')) {
    return { ...base, kind: 'bucket', status: 503, message: 'Bucket Cloudflare R2 tidak ditemukan (NoSuchBucket). Periksa R2_BUCKET_NAME dan R2_ACCOUNT_ID/R2_ENDPOINT (bucket jurisdiksi EU memakai endpoint *.eu.r2.cloudflarestorage.com).' };
  }
  if (code === 'AccessDenied' || code === 'Forbidden' || code === 'AllAccessDisabled' || httpStatus === 403) {
    return { ...base, kind: 'permission', status: 503, message: 'Cloudflare R2 menolak akses (AccessDenied 403). API Token R2 di server tidak punya izin menulis ke bucket ini. Buat token dengan izin "Object Read & Write" untuk bucket yang dipakai (atau semua bucket), lalu perbarui R2_ACCESS_KEY_ID dan R2_SECRET_ACCESS_KEY di server dan deploy ulang.' };
  }
  if (code === 'EntityTooLarge' || httpStatus === 413) {
    return { ...base, kind: 'too-large', status: 413, message: 'File ditolak penyimpanan karena terlalu besar.' };
  }
  if (code === 'SlowDown' || code === 'ServiceUnavailable' || code === 'RequestLimitExceeded' || httpStatus === 429 || httpStatus === 503) {
    return { ...base, kind: 'throttled', status: 503, message: 'Cloudflare R2 sedang membatasi/menolak permintaan sementara. Coba lagi sebentar lagi.' };
  }
  if (NETWORK_CODES.has(code) || code === 'TimeoutError' || code === 'RequestTimeout' || code === 'AbortError') {
    return { ...base, kind: 'network', status: 502, message: 'Server tidak dapat terhubung ke Cloudflare R2 (jaringan/timeout). Periksa R2_ENDPOINT / R2_ACCOUNT_ID, lalu coba lagi.' };
  }
  return { ...base, kind: 'unknown', status: 502, message: `Upload ke Cloudflare R2 gagal (${base.code}). Detail ada di log server.` };
}

/** Ganti nilai rahasia (bila muncul di teks) dengan ***. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out;
}
