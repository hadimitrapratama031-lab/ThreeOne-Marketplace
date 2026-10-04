import multer from 'multer';
import mongoose from 'mongoose';
import { HttpError } from '../lib/http.js';
import { config } from '../config/env.js';

export function notFoundApi(_req, _res, next) {
  next(new HttpError(404, 'Endpoint tidak ditemukan.'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = 500;
  let message = 'Terjadi kesalahan di server.';
  let details;

  // Koneksi klien putus di tengah upload (tab ditutup, jaringan putus, upload dibatalkan). Bukan kesalahan server.
  const clientAborted = err?.message === 'Request aborted' || err?.type === 'request.aborted';
  // Body multipart rusak/terpotong (busboy melempar Error biasa tanpa kode)
  const badMultipart = !(err instanceof HttpError) && typeof err?.message === 'string'
    && /^(Unexpected end of form|Multipart: |Malformed part header|Malformed urlencoded form|Missing Content-Type|Part terminated early|Unexpected end of multipart data)/.test(err.message);

  if (err instanceof HttpError) {
    status = err.status; message = err.message; details = err.details;
  } else if (clientAborted) {
    status = 400; message = 'Upload dibatalkan sebelum selesai (koneksi terputus).';
    console.warn(`[upload] dibatalkan klien: ${req.method} ${req.originalUrl}`);
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file terlalu besar.'
      : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Field upload harus bernama "file" (satu file saja).'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Hanya satu file per upload.' : 'Upload tidak valid.';
  } else if (badMultipart) {
    status = 400; message = 'Data upload (multipart/form-data) tidak valid atau terpotong. Coba unggah ulang.';
  } else if (err?.code === 11000) {
    status = 409; message = 'Data dengan nilai tersebut sudah ada.';
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 422; message = 'Data tidak valid';
    details = { fields: Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message])) };
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400; message = 'Parameter tidak valid.';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400; message = 'Body permintaan bukan JSON yang valid.';
  } else if (err?.type === 'entity.too.large') {
    status = 413; message = 'Permintaan terlalu besar.';
  }

  if (status >= 500) {
    // HttpError sudah dicatat penyebab aslinya oleh pembuatnya (mis. lib/r2.js); cukup satu baris ringkas di sini.
    // Tanpa body/cookie agar tidak membocorkan rahasia.
    if (err instanceof HttpError) console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
    else console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }
  res.status(status).json({ error: { message, ...(details ? { details } : {}), ...(config.isProd || status < 500 ? {} : { debug: err?.message }) } });
}
