import { Router } from 'express';
import { asyncH } from '../lib/http.js';
import { steamLimiter } from '../middleware/security.js';
import * as steam from '../services/steam.js';

const r = Router();
r.use(steamLimiter);

// Cari metadata game dari Steam App ID (data teks + gambar utama yang sudah disiapkan di R2 sebagai aset 'temp')
r.get('/:appId', asyncH(async (req, res) => res.json({ item: await steam.searchApp(req.params.appId) })));

// Unduh trailer Steam ke R2 (terpisah karena bisa puluhan MB). Selalu 200 bila hanya "video tidak tersedia".
r.post('/:appId/video', asyncH(async (req, res) => res.json(await steam.fetchVideo(req.params.appId))));

export default r;
