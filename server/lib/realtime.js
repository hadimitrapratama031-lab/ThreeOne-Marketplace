import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { parseCookie } from 'cookie';
import { config } from '../config/env.js';
import { Admin } from '../models/index.js';

/**
 * Socket.IO
 *  - namespace "/"      : Marketplace (publik, hanya menerima data publik).
 *                         Halaman Payment bergabung ke room "order:<orderNo>" (butuh token pelanggan) dan hanya
 *                         menerima event order:update miliknya sendiri; data order tidak pernah di-broadcast.
 *  - namespace "/admin" : Admin Web (wajib login; cookie sesi dicek saat handshake)
 * Daftar event publik:  <entity>:create|update|delete|reorder
 */
let io;
let adminNs;
let presenceTimer;
let orderJoin = null;   // diisi services/payments.js: (orderNo, token) => tampilan order publik | null

/** Didaftarkan oleh modul pembayaran supaya realtime.js tidak bergantung pada layer service. */
export const setOrderJoinHandler = (fn) => { orderJoin = fn; };

export const SESSION_COOKIE = 'mp_admin';

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.appSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

async function authAdminSocket(socket, next) {
  try {
    const raw = socket.handshake.headers.cookie || '';
    const token = parseCookie(raw)[SESSION_COOKIE];
    const payload = token && verifyToken(token);
    if (!payload) return next(new Error('unauthorized'));
    const admin = await Admin.findById(payload.sub).select('tokenVersion name').lean();
    if (!admin || admin.tokenVersion !== payload.tv) return next(new Error('unauthorized'));
    socket.data.adminId = String(admin._id);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
}

const publicOnline = () => (io ? io.of('/').sockets.size : 0);

function schedulePresence() {
  if (!adminNs || presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = undefined;
    adminNs.emit('presence:update', { online: publicOnline() });
  }, 500);
  presenceTimer.unref?.();
}

export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: config.corsOrigins.length ? { origin: config.corsOrigins, credentials: true } : undefined,
    serveClient: true,
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  io.of('/').on('connection', (socket) => {
    schedulePresence();
    socket.on('disconnect', schedulePresence);

    // Halaman Payment: gabung ke room order setelah token diverifikasi, balas dengan keadaan terkini (ack)
    socket.on('order:join', async (msg, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const orderNo = msg?.orderNo;
        const joined = (socket.data.orders ||= new Set());
        if (!orderJoin || typeof orderNo !== 'string' || typeof msg?.token !== 'string') return reply({ ok: false });
        if (joined.size >= 5 && !joined.has(orderNo)) return reply({ ok: false });
        const order = await orderJoin(orderNo, msg.token);
        if (!order) return reply({ ok: false });
        socket.join(`order:${orderNo}`);
        joined.add(orderNo);
        reply({ ok: true, order });
      } catch {
        reply({ ok: false });
      }
    });
  });

  adminNs = io.of('/admin');
  adminNs.use(authAdminSocket);
  adminNs.on('connection', (socket) => {
    socket.emit('presence:update', { online: publicOnline() });
  });
  return io;
}

export async function closeRealtime() {
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = undefined;
  if (io) await new Promise((resolve) => io.close(resolve));
  io = undefined;
  adminNs = undefined;
}

const safe = (fn) => {
  try { fn(); } catch (err) { console.error('[realtime] emit gagal:', err.message); }
};
export const emitPublic = (event, payload) => safe(() => io?.of('/').emit(event, payload));
export const emitAdmin = (event, payload) => safe(() => adminNs?.emit(event, payload));
export const emitToRoom = (room, event, payload) => safe(() => io?.of('/').to(room).emit(event, payload));
export const getOnline = publicOnline;

/**
 * Kirim perubahan entitas. Publik hanya menerima data publik, dan transisi visibilitas
 * diterjemahkan: disembunyikan -> :delete, ditampilkan lagi -> :create.
 */
export function emitChange(entity, { before, after, adm, pub, visible, id, admDel, pubDel }) {
  const wasVisible = before ? visible(before) : false;
  const isVisible = after ? visible(after) : false;
  const delAdm = (d) => (admDel ? admDel(d) : { id: id(d) });
  const delPub = (d) => (pubDel ? pubDel(d) : { id: id(d) });

  if (!before && after) emitAdmin(`${entity}:create`, adm(after));
  else if (before && after) emitAdmin(`${entity}:update`, adm(after));
  else if (before && !after) emitAdmin(`${entity}:delete`, delAdm(before));

  if (!wasVisible && isVisible) emitPublic(`${entity}:create`, pub(after));
  else if (wasVisible && isVisible) emitPublic(`${entity}:update`, pub(after));
  else if (wasVisible && !isVisible) emitPublic(`${entity}:delete`, delPub(before));
}
