import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Admin } from '../models/index.js';
import { asyncH, parse, HttpError } from '../lib/http.js';
import { loginInput, profileInput, passwordInput } from '../lib/schemas.js';
import { signSession, setSessionCookie, clearSessionCookie, requireAdmin, loginLimiter } from '../middleware/security.js';

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
const me = (a) => ({ id: String(a._id), name: a.name, email: a.email, lastLoginAt: a.lastLoginAt || null });

const r = Router();

r.post('/login', loginLimiter, asyncH(async (req, res) => {
  const { email, password } = parse(loginInput, req.body);
  const admin = await Admin.findOne({ email });
  const ok = await bcrypt.compare(password, admin?.passwordHash || DUMMY_HASH); // waktu sama walau email tidak ada
  if (!admin || !ok) throw new HttpError(401, 'Email atau password salah.');
  admin.lastLoginAt = new Date();
  await admin.save();
  setSessionCookie(res, signSession(admin));
  res.json({ admin: me(admin) });
}));

r.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

r.get('/me', requireAdmin, (req, res) => {
  // Perpanjang sesi (sliding) bila token sudah lebih dari 1 hari
  if (Date.now() / 1000 - (req.auth.iat || 0) > 86_400) setSessionCookie(res, signSession(req.admin));
  res.json({ admin: me(req.admin) });
});

r.patch('/me', requireAdmin, asyncH(async (req, res) => {
  const data = parse(profileInput, req.body);
  const taken = await Admin.findOne({ email: data.email, _id: { $ne: req.admin._id } });
  if (taken) throw new HttpError(409, 'Email sudah dipakai admin lain.', { fields: { email: 'Email sudah dipakai' } });
  req.admin.name = data.name;
  req.admin.email = data.email;
  await req.admin.save();
  res.json({ admin: me(req.admin) });
}));

r.post('/me/password', requireAdmin, asyncH(async (req, res) => {
  const { currentPassword, newPassword } = parse(passwordInput, req.body);
  if (!(await bcrypt.compare(currentPassword, req.admin.passwordHash))) {
    throw new HttpError(422, 'Password saat ini salah.', { fields: { currentPassword: 'Password saat ini salah' } });
  }
  req.admin.passwordHash = await bcrypt.hash(newPassword, 12);
  req.admin.tokenVersion += 1; // semua sesi lain otomatis keluar
  await req.admin.save();
  setSessionCookie(res, signSession(req.admin));
  res.json({ ok: true });
}));

export default r;
