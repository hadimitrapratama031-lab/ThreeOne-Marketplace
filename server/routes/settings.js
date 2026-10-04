import { Router } from 'express';
import { asyncH, HttpError } from '../lib/http.js';
import { SETTING_KEYS, getAllSettings, saveSetting, publicSetting } from '../services/settings.js';
import { emitAdmin, emitPublic } from '../lib/realtime.js';

const r = Router();

r.get('/', asyncH(async (_req, res) => res.json({ settings: await getAllSettings() })));

r.put('/:key', asyncH(async (req, res) => {
  const { key } = req.params;
  if (!SETTING_KEYS.includes(key)) throw new HttpError(404, 'Pengaturan tidak ditemukan.');
  const value = await saveSetting(key, req.body);
  if (key === 'hero') {
    emitPublic('hero:update', publicSetting(key, value));
    emitAdmin('hero:update', value);
  } else {
    emitPublic('settings:update', { key, value: publicSetting(key, value) });
    emitAdmin('settings:update', { key, value });
  }
  res.json({ key, value });
}));

export default r;
