import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Pesan validasi berbahasa Indonesia
z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case 'invalid_type':
      return { message: issue.received === 'undefined' ? 'Wajib diisi' : 'Tipe data tidak valid' };
    case 'too_small':
      if (issue.type === 'string') return { message: issue.minimum <= 1 ? 'Wajib diisi' : `Minimal ${issue.minimum} karakter` };
      if (issue.type === 'array') return { message: `Minimal ${issue.minimum} item` };
      return { message: `Minimal ${issue.minimum}` };
    case 'too_big':
      if (issue.type === 'string') return { message: `Maksimal ${issue.maximum} karakter` };
      if (issue.type === 'array') return { message: `Maksimal ${issue.maximum} item` };
      return { message: `Maksimal ${issue.maximum}` };
    case 'invalid_enum_value':
      return { message: 'Pilihan tidak valid' };
    default:
      return { message: ctx.defaultError };
  }
});

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fields = {};
  for (const issue of r.error.issues) {
    const k = issue.path.join('.') || '_';
    if (!(k in fields)) fields[k] = issue.message;
  }
  throw new HttpError(422, 'Data tidak valid', { fields });
}

export const objectIdStr = z.string().regex(/^[a-f\d]{24}$/i, 'ID tidak valid');

export function pageMeta(page, limit, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
