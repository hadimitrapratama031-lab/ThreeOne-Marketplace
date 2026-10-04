import { Router } from 'express';
import multer from 'multer';
import { Asset } from '../models/index.js';
import { asyncH, HttpError, objectIdStr, pageMeta } from '../lib/http.js';
import { admAsset } from '../lib/serialize.js';
import { uploadLimiter } from '../middleware/security.js';
import { config, r2Configured } from '../config/env.js';
import * as assets from '../services/assets.js';
import { listImageErrors, clearImageErrors } from '../services/imageErrors.js';
import { z } from 'zod';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.limits.videoBytes, files: 1, fields: 5 } });

r.post('/', uploadLimiter, upload.single('file'), asyncH(async (req, res) => {
  if (!r2Configured()) throw new HttpError(503, 'Penyimpanan gambar (Cloudflare R2) belum dikonfigurasi di server.');
  if (!req.file) throw new HttpError(400, 'File belum dipilih.');
  const asset = await assets.uploadAsset({ buffer: req.file.buffer, originalName: req.file.originalname, folder: String(req.body.folder || '') });
  res.status(201).json({ asset: admAsset(asset) });
}));

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  status: z.enum(['used', 'unused']).optional(),
  kind: z.enum(['image', 'video']).optional(),
  folder: z.enum(assets.FOLDERS).optional(),
});

r.get('/', asyncH(async (req, res) => {
  const q = listQuery.parse(req.query);
  const filter = {};
  if (q.status === 'used') filter.status = 'used';
  if (q.status === 'unused') filter.status = { $in: ['temp', 'orphan'] };
  if (q.kind) filter.kind = q.kind;
  if (q.folder) filter.folder = q.folder;
  const [total, docs] = await Promise.all([
    Asset.countDocuments(filter),
    Asset.find(filter).sort({ createdAt: -1, _id: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
  ]);
  res.json({ items: docs.map(admAsset), ...pageMeta(q.page, q.limit, total) });
}));

r.get('/errors', (_req, res) => res.json({ items: listImageErrors() }));
r.delete('/errors', (_req, res) => { clearImageErrors(); res.json({ ok: true }); });

// Hanya aset yang tidak dipakai entitas manapun yang boleh dihapus manual
r.delete('/:id', asyncH(async (req, res) => {
  if (!objectIdStr.safeParse(req.params.id).success) throw new HttpError(404, 'File tidak ditemukan.');
  const a = await Asset.findById(req.params.id);
  if (!a) throw new HttpError(404, 'File tidak ditemukan.');
  if (a.status === 'used') throw new HttpError(409, 'File ini sedang dipakai. Lepas dari produk/konten yang memakainya dulu.');
  await assets.destroyAssets([a]);
  res.json({ ok: true });
}));

export default r;
