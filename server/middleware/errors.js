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

  if (err instanceof HttpError) {
    status = err.status; message = err.message; details = err.details;
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file terlalu besar.' : 'Upload tidak valid.';
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

  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err); // tanpa body/cookie agar tidak membocorkan rahasia
  res.status(status).json({ error: { message, ...(details ? { details } : {}), ...(config.isProd || status < 500 ? {} : { debug: err?.message }) } });
}
