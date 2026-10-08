import { $, $$, html, mount, icon, toast, toastError } from './ui.js';
import { api, auth, onUnauthorized } from './api.js';
import { chatCore } from './chatCore.js';

/* Menu hanya berisi fitur yang benar-benar ada di Marketplace dan sudah berfungsi. */
const ROUTES = [
  { path: 'dashboard', title: 'Dashboard', icon: 'dashboard', load: () => import('./pages/dashboard.js') },
  { group: 'Marketplace', path: 'products', title: 'Produk', icon: 'box', load: () => import('./pages/products.js') },
  { group: 'Marketplace', path: 'categories', title: 'Kategori', icon: 'tag', load: () => import('./pages/categories.js') },
  { group: 'Marketplace', path: 'reviews', title: 'Rating & Ulasan', icon: 'star', load: () => import('./pages/reviews.js') },
  { group: 'Penjualan', path: 'orders', title: 'Pesanan', icon: 'receipt', load: () => import('./pages/orders.js') },
  { group: 'Penjualan', path: 'profit-monthly', title: 'Keuntungan Per Bulan', icon: 'trend', load: () => import('./pages/profit-monthly.js') },
  { group: 'Penjualan', path: 'codes', title: 'Laporan Code', icon: 'key', load: () => import('./pages/codes.js') },
  { group: 'Penjualan', path: 'payment', title: 'Pembayaran', icon: 'wallet', load: () => import('./pages/payment.js') },
  { group: 'Live Chat', path: 'livechat', title: 'Percakapan', icon: 'chat', load: () => import('./pages/livechat.js') },
  { group: 'Live Chat', path: 'livechat-settings', title: 'Pengaturan Live Chat', icon: 'sliders', load: () => import('./pages/livechat-settings.js') },
  { group: 'Integrasi', path: 'integrations', title: 'Email & WhatsApp', icon: 'plug', load: () => import('./pages/integrations.js') },
  { group: 'Integrasi', path: 'notifications', title: 'Log Notifikasi', icon: 'bell', load: () => import('./pages/notifications.js') },
  { group: 'Konten', path: 'hero', title: 'Hero', icon: 'layout', load: () => import('./pages/hero.js') },
  { group: 'Konten', path: 'faq', title: 'FAQ', icon: 'help', load: () => import('./pages/faq.js') },
  { group: 'Konten', path: 'contacts', title: 'Kontak', icon: 'chat', load: () => import('./pages/contacts.js') },
  { group: 'Media', path: 'assets', title: 'Aset Gambar', icon: 'image', load: () => import('./pages/assets.js') },
  { group: 'Sistem', path: 'settings', title: 'Pengaturan', icon: 'sliders', load: () => import('./pages/settings.js') },
  { group: 'Sistem', path: 'account', title: 'Akun Admin', icon: 'user', load: () => import('./pages/account.js') },
];

const LIVE_EVENTS = [
  'product:create', 'product:update', 'product:delete', 'product:bulk', 'product:reorder',
  'category:create', 'category:update', 'category:delete', 'category:reorder',
  'hero:update', 'settings:update',
  'faq:create', 'faq:update', 'faq:delete', 'faq:reorder',
  'contact:create', 'contact:update', 'contact:delete', 'contact:reorder',
  'review:create', 'review:update', 'review:delete',
  'media:error',
  'order:update', 'order:delete', 'report:update', 'payment-settings:update',
  'integrations:update', 'notification:log',
  'code:update', 'code:delete', 'code:stats', 'code:refresh',
  'livechat:conversation:created', 'livechat:conversation:updated', 'livechat:conversation:expired',
  'livechat:message:new', 'livechat:read', 'livechat:unread', 'livechat:settings',
];

const ctx = { admin: null, meta: null, online: 0, go: (path) => { location.hash = `#/${path}`; } };
let current = null;      // { route, instance }
let navToken = 0;
let socket = null;

/* ---------- Layar: login vs aplikasi ---------- */
function show(which) {
  $('#boot').hidden = true;
  $('#login').hidden = which !== 'login';
  $('#shell').hidden = which !== 'shell';
}

function showLogin(message) {
  teardown();
  show('login');
  const err = $('#login-error');
  err.hidden = !message;
  err.textContent = message || '';
  $('#login-form').elements.password.value = '';
  $('#login-form').elements[message ? 'password' : 'email'].focus();
}

function teardown() {
  navToken++;
  current?.instance?.destroy?.();
  current = null;
  chatCore.setUnread(0);
  socket?.disconnect();   // socket lama dibuang beserta listener-nya -> login ulang tidak menumpuk listener
  socket = null;
  $('#view').replaceChildren();
}

async function showApp(admin) {
  ctx.admin = admin;
  ctx.meta = ctx.meta || (await api.get('/meta'));
  $('#account-name').textContent = admin.name;
  $('#account-email').textContent = admin.email;
  $('#account-avatar').textContent = (admin.name || '?')[0].toUpperCase();
  show('shell');
  buildNav();
  connectSocket();
  chatCore.init();   // badge unread Live Chat di sidebar + judul tab, di halaman admin mana pun
  await navigate();
}

/* ---------- Navigasi ---------- */
function buildNav() {
  const groups = [];
  for (const r of ROUTES) {
    const label = r.group || '';
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push((g = { label, items: [] }));
    g.items.push(r);
  }
  mount($('#nav'), groups.map((g) => html`
    <div class="nav__group">
      ${g.label ? html`<span class="nav__label">${g.label}</span>` : ''}
      ${g.items.map((r) => html`<a class="nav__link" href="#/${r.path}" data-route="${r.path}">${icon(r.icon)}<span>${r.title}</span>${r.path === 'livechat' ? html`<b class="nav__badge" data-chat-badge hidden></b>` : ''}</a>`)}
    </div>`));
  chatCore.paint();
  mount($('#open-store'), html`${icon('external')}<span>Buka Marketplace</span>`);
  mount($('#menu-btn'), icon('menu'));
  mount($('#menu-account'), html`${icon('user')}<span>Akun Admin</span>`);
  mount($('#logout-btn'), html`${icon('logout')}<span>Keluar</span>`);
}

async function navigate() {
  if (!ctx.admin) return;
  const path = (location.hash.replace(/^#\/?/, '') || 'dashboard').split(/[?/]/)[0];
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];
  const token = ++navToken;

  current?.instance?.destroy?.();
  current = null;
  $('#page-title').textContent = route.title;
  chatCore.setTitle(`${route.title} — Admin Marketplace`);
  $$('.nav__link[data-route]').forEach((a) => (a.dataset.route === route.path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  closeSidebar();

  // Wadah BARU untuk setiap halaman: listener halaman sebelumnya ikut terbuang bersama wadahnya
  // (kalau semua halaman memakai #view yang sama, listener-nya menumpuk antar navigasi).
  const view = $('#view');
  const host = document.createElement('div');
  view.replaceChildren(host);
  try {
    const mod = await route.load();
    if (token !== navToken) return;
    const instance = await mod.default.mount(host, ctx);
    if (token !== navToken) { instance?.destroy?.(); return; }
    current = { route, instance };
    view.focus({ preventScroll: true });
  } catch (err) {
    if (token !== navToken || err.status === 401) return;
    console.error(err);
    mount(host, html`<div class="card"><div class="empty">${icon('alert')}<b>Halaman gagal dimuat</b><span>${err.message}</span><button class="btn" type="button" id="retry-page">Coba lagi</button></div></div>`);
    $('#retry-page')?.addEventListener('click', navigate);
  }
}

/* ---------- Realtime (satu socket, satu set listener) ---------- */
function setLive(state) {
  const chip = $('#live-chip');
  chip.dataset.state = state;
  $('#live-text').textContent = state === 'online' ? `Live · ${ctx.online} pengunjung online` : state === 'connecting' ? 'Menghubungkan…' : 'Terputus · mencoba lagi';
}

function connectSocket() {
  if (socket || typeof io === 'undefined') { if (typeof io === 'undefined') setLive('offline'); return; }
  setLive('connecting');
  let hadConnection = false;
  socket = io('/admin', { transports: ['websocket', 'polling'], reconnectionDelayMax: 8000 });
  const dispatch = (event, payload) => {
    if (event === 'resync' || event.startsWith('livechat:')) chatCore.onLive(event, payload);   // global: berlaku di semua halaman
    current?.instance?.onLive?.(event, payload);
  };

  LIVE_EVENTS.forEach((name) => socket.on(name, (payload) => dispatch(name, payload)));
  socket.on('presence:update', ({ online }) => { ctx.online = online; if (socket.connected) setLive('online'); dispatch('presence:update', { online }); });
  socket.on('connect', () => {
    setLive('online');
    if (hadConnection) dispatch('resync');      // setelah reconnect: ambil ulang dari database
    hadConnection = true;
  });
  socket.on('disconnect', () => setLive('offline'));
  socket.on('connect_error', async (err) => {
    setLive('offline');
    if (err?.message === 'unauthorized') {
      try { await auth.me(); } catch { /* 401 -> onUnauthorized menampilkan login */ }
    }
  });
}

/* ---------- Event DOM global ---------- */
onUnauthorized(() => { if (ctx.admin) { ctx.admin = null; showLogin('Sesi berakhir. Silakan login kembali.'); } });
addEventListener('hashchange', navigate);

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('button[type="submit"]', form);
  const err = $('#login-error');
  err.hidden = true;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const { admin } = await auth.login(form.elements.email.value, form.elements.password.value);
    form.elements.password.value = '';
    if (!location.hash) location.hash = '#/dashboard';
    await showApp(admin);
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await auth.logout(); } catch { /* tetap keluar */ }
  ctx.admin = null;
  showLogin();
});

const accountBtn = $('#account-btn');
const accountMenu = $('#account-menu');
const toggleMenu = (open) => { accountMenu.hidden = !open; accountBtn.setAttribute('aria-expanded', String(open)); };
accountBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(accountMenu.hidden); });
document.addEventListener('click', (e) => { if (!accountMenu.hidden && !e.target.closest('#account-menu')) toggleMenu(false); });
accountMenu.addEventListener('click', () => toggleMenu(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleMenu(false); });

const openSidebar = () => { $('#sidebar').classList.add('is-open'); $('#scrim').hidden = false; };
function closeSidebar() { $('#sidebar').classList.remove('is-open'); $('#scrim').hidden = true; }
$('#menu-btn').addEventListener('click', openSidebar);
$('#scrim').addEventListener('click', closeSidebar);

/* ---------- Mulai ---------- */
(async () => {
  try {
    const { admin } = await auth.me();
    await showApp(admin);
  } catch (err) {
    if (err.status === 401 || err.status === 0) showLogin(err.status === 0 ? err.message : '');
    else { console.error(err); showLogin(err.message); }
  }
})();

export { toast, toastError };
