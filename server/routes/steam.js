import { Router } from 'express';
import { asyncH } from '../lib/http.js';
import { steamLimiter, steamMediaLimiter } from '../middleware/security.js';
import * as steam from '../services/steam.js';

const r = Router();

// Cari metadata game dari Steam App ID (data teks + gambar utama yang sudah disiapkan di R2 sebagai aset 'temp')
r.get('/:appId', steamLimiter, asyncH(async (req, res) => res.json({ item: await steam.searchApp(req.params.appId) })));

// Unduh SATU video Steam ke R2 (terpisah karena bisa puluhan MB). Body opsional { movie: <index 0..count-1>, have: [<key video di galeri>] }, default movie 0.
// Klien memanggilnya untuk setiap index agar semua video masuk galeri. `have` mencegah video Steam yang sama masuk dua kali.
// Selalu 200 bila hanya "video tidak tersedia".
r.post('/:appId/video', steamMediaLimiter, asyncH(async (req, res) => res.json(await steam.fetchVideo(req.params.appId, req.body?.movie ?? 0, req.body?.have))));

export default r;
