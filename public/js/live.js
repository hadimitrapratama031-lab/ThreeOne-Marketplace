/* ==========================================================================
   live.js — koneksi realtime Marketplace (Socket.IO) + sinkron ulang
   - Semua listener didaftarkan SEKALI. Saat koneksi putus lalu tersambung lagi,
     Socket.IO memakai socket yang sama (tidak ada listener baru) dan kita
     cukup memanggil onSync() agar data diambil ulang dari MongoDB lewat API.
   - Tanpa Socket.IO (script gagal dimuat) Marketplace tetap jalan dari API.
   ========================================================================== */
const Live = (() => {
  const EVENTS = [
    'product:create', 'product:update', 'product:delete', 'product:bulk',
    'category:create', 'category:update', 'category:delete', 'category:reorder',
    'hero:update', 'settings:update',
    'faq:create', 'faq:update', 'faq:delete', 'faq:reorder',
    'contact:create', 'contact:update', 'contact:delete', 'contact:reorder',
    'review:create', 'review:update', 'review:delete',
  ];
  let socket = null;
  let started = false;
  let hadConnection = false;

  const apiBase = (document.querySelector('meta[name="mp-api"]')?.content || '').replace(/\/$/, '');

  function start({ onEvent, onSync, onStatus }) {
    if (started) return socket;               // mencegah listener ganda
    started = true;
    if (typeof io === 'undefined') {
      onStatus?.('offline');
      return null;
    }
    socket = io(apiBase || undefined, { transports: ['websocket', 'polling'], reconnectionDelayMax: 8000 });

    EVENTS.forEach((name) => socket.on(name, (payload) => onEvent(name, payload)));

    socket.on('connect', () => {
      onStatus?.('online');
      if (hadConnection) onSync();            // sesudah reconnect: sinkron dari database
      hadConnection = true;
    });
    socket.on('disconnect', () => onStatus?.('offline'));
    socket.on('connect_error', () => onStatus?.('offline'));
    return socket;
  }

  return { start, apiBase, get socket() { return socket; } };
})();
