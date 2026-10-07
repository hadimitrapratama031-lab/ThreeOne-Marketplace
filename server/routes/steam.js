import { Router } from 'express';
import { asyncH } from '../lib/http.js';
import { steamLimiter } from '../middleware/security.js';
import * as steam from '../services/steam.js';

const r = Router();

// Cari data game dari Steam App ID. Teks + URL asli screenshot/video Steam (referensi eksternal, tidak disalin ke R2);
// hanya gambar utama yang disiapkan di R2 sebagai aset 'temp'. Tidak ada endpoint unduh video: video Steam tidak pernah diunduh.
r.get('/:appId', steamLimiter, asyncH(async (req, res) => res.json({ item: await steam.searchApp(req.params.appId) })));

export default r;
