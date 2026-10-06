/* ==========================================================================
   Marketplace — Home
   Data berasal dari backend (MongoDB) lewat /api/public/bootstrap dan diperbarui
   realtime lewat Socket.IO (live.js). Tidak ada lagi data fixture di sini.
   Daftar isi:
   1. Helper
   2. Data (diisi dari API)
   3. Template (logo, artwork, kartu produk)
   4. Render bagian statis
   5. Daftar produk (cari, urut, filter)
   6. Animasi (reveal, hitung angka)
   7. Header, menu mobile, scroll-spy
   8. Efek tambahan (glow kartu)
   9. Sinkron data + realtime
   ========================================================================== */


/* 1. Helper
   -------------------------------------------------------------------------- */
const $  = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Angka acak yang konsisten (seed), supaya artwork placeholder tidak berubah tiap reload
const seeded = (n) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const formatRupiah = (n) => 'Rp ' + n.toLocaleString('id-ID');

const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Semua teks dari admin WAJIB lewat esc() sebelum masuk innerHTML
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = (h) => (/^(https?:\/\/|mailto:|tel:|#|\/)/i.test(h || '') ? h : '');
const extAttrs = (h) => (/^https?:\/\//i.test(h) ? ' target="_blank" rel="noopener"' : '');


/* 2. Data (diisi dari API)
   -------------------------------------------------------------------------- */
const DEFAULT_SETTINGS = {
  branding: { name: 'Marketplace', siteTitle: 'Marketplace', logoUrl: null },
  hero: { eyebrow: '', title: '', desc: '', primaryCta: { label: '', href: '#product' }, secondaryCta: { label: '', href: '#product' }, chips: [], covers: [null, null, null] },
  stats: { customers: 0, orders: 0, support: '' },
  sections: {
    products: { title: 'Produk Tersedia', subtitle: '' },
    faq: { title: 'Pertanyaan Umum' },
    contact: { title: 'Hubungi Kami', subtitle: '' },
  },
  productPage: { notes: [], platforms: [], completedOrders: 0 },
};

const DATA = {
  get brand() { return DATA.settings.branding.name; },
  settings: structuredClone(DEFAULT_SETTINGS),
  categories: [],
  products: [],
  faq: [],
  contacts: [],
};

const PRODUCTS = DATA.products; // diubah di tempat (splice) supaya referensi ini selalu terbaru
const replaceList = (target, list) => target.splice(0, target.length, ...list);

const API = (typeof Live !== 'undefined' ? Live.apiBase : '') + '/api/public';
async function api(path) {
  const res = await fetch(API + path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}


/* 3. Template
   -------------------------------------------------------------------------- */
const LOGO_SVG = `
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
    <path d="M12 2.5l8.5 5v9l-8.5 5-8.5-5v-9z"/>
    <path d="M12 8l4 2.3v4.4L12 17l-4-2.3v-4.4z" fill="currentColor" stroke="none"/>
  </svg>`;

// Artwork placeholder (gelap + ungu terang). Dipakai hanya bila imageUrl kosong.
function artwork(i) {
  let circles = '';
  for (let k = 0; k < 5; k++) {
    const cx = (seeded(i * 7 + k) * 320) | 0;
    const cy = (seeded(i * 11 + k) * 200) | 0;
    const r  = (18 + seeded(i * 5 + k) * 60) | 0;
    const opacity = (.1 + seeded(k + i) * .16).toFixed(2);
    circles += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(167,139,250,${opacity})"/>`;
  }

  const x = (seeded(i + 2) * 200 + 40) | 0;
  const y = (seeded(i + 4) * 90 + 40) | 0;
  const hue = 258 + ((seeded(i) * 22) | 0);
  const light = 12 + ((seeded(i + 1) * 7) | 0);
  const tilt = (seeded(i) * 50 - 10) | 0;
  const lineStart = (120 + seeded(i) * 50) | 0;
  const lineEnd = (40 + seeded(i + 3) * 60) | 0;

  return `
    <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="art-${i}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="hsl(${hue} 55% ${light}%)"/>
          <stop offset="1" stop-color="#0b0b0a"/>
        </linearGradient>
      </defs>
      <rect width="320" height="200" fill="url(#art-${i})"/>
      ${circles}
      <path d="M0 ${lineStart}L320 ${lineEnd}" stroke="rgba(255,255,255,.08)"/>
      <rect x="${x}" y="${y}" width="56" height="56" rx="10"
            transform="rotate(${tilt} ${x + 28} ${y + 28})"
            fill="rgba(167,139,250,.12)" stroke="rgba(167,139,250,.45)"/>
    </svg>`;
}

function stockInfo(stock) {
  return stock ? (stock <= 10 ? ['stock--low', 'Stok terbatas'] : ['', 'Tersedia']) : ['stock--out', 'Habis'];
}

function productCard(p) {
  const [stockClass, stockLabel] = stockInfo(p.stock);

  const media = p.imageUrl
    ? `<img loading="lazy" alt="${esc(p.name)}" src="${esc(p.imageUrl)}" data-seed="${p.id}">`
    : artwork(p.id);

  return `
    <li class="reveal">
      <article class="card">
        <div class="card__media">
          ${media}
          <span class="card__tag">${esc(p.category)}</span>
        </div>
        <div class="card__body">
          <h4><a class="card__link" href="product.html?id=${p.id}">${esc(p.name)}</a></h4>
          <p>${esc(p.description)}</p>
          <span class="stock ${stockClass}">${stockLabel}</span>
          <div class="card__foot">
            <span class="price">${formatRupiah(p.price)}</span>
            <button class="buy-btn" type="button" data-id="${p.id}"${p.stock ? '' : ' disabled'}>${p.stock ? 'Beli' : 'Habis'}</button>
          </div>
        </div>
      </article>
    </li>`;
}

// Gambar dari R2 gagal dimuat: tampilkan artwork, dan laporkan ke server (tidak disembunyikan)
const reportedImages = new Set();
function reportImageError(url) {
  if (!url || reportedImages.has(url) || /^(data|blob):/.test(url)) return;
  reportedImages.add(url);
  fetch(API + '/image-error', {
    method: 'POST', keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, page: location.pathname + location.search }),
  }).catch(() => {});
}
function probeImage(url) {
  const probe = new Image();
  probe.onerror = () => reportImageError(url);
  probe.src = url;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  reportImageError(img.currentSrc || img.src);
  if (img.classList.contains('logo__img')) img.outerHTML = LOGO_SVG;
  else if (img.dataset.seed && img.closest('.card__media')) img.outerHTML = artwork(+img.dataset.seed);
}, true);


/* 4. Render bagian statis
   -------------------------------------------------------------------------- */
const isHome = Boolean($('#hero-title'));

function renderBrand() {
  const b = DATA.settings.branding;
  const mark = b.logoUrl ? `<img class="logo__img" src="${esc(b.logoUrl)}" alt="" height="26">` : LOGO_SVG;
  $$('.logo').forEach((el) => { el.innerHTML = `${mark}<b>${esc(b.name)}</b>`; });
  const copy = $('#copyright');
  if (copy) copy.textContent = `© ${new Date().getFullYear()} ${b.name}`;
  if (isHome) document.title = b.siteTitle;
}

function setCta(el, cta) {
  if (!el) return;
  const href = safeHref(cta.href);
  el.hidden = !cta.label || !href;
  el.textContent = cta.label;
  el.setAttribute('href', href || '#');
  el.removeAttribute('target');
  el.removeAttribute('rel');
  if (extAttrs(href)) { el.target = '_blank'; el.rel = 'noopener'; }
}

function renderHero() {
  if (!isHome) return;
  const h = DATA.settings.hero;
  const eyebrow = $('#hero-eyebrow');
  eyebrow.textContent = h.eyebrow;
  eyebrow.hidden = !h.eyebrow;
  $('#hero-title').textContent = h.title;
  $('#hero-desc').textContent = h.desc;
  $('#hero-desc').hidden = !h.desc;
  setCta($('#hero-cta-1'), h.primaryCta);
  setCta($('#hero-cta-2'), h.secondaryCta);
  // Artwork hero ada di background (bg-artwork); di sini hanya chip yang melayang di atasnya
  $('#hero-visual').innerHTML = h.chips.slice(0, 2).map((c, i) => `<span class="float-chip float-chip--${i + 1}">${esc(c)}</span>`).join('');
  // Cover hero: slot a/b/c. Kosong = artwork bawaan.
  ['a', 'b', 'c'].forEach((slot, i) => {
    const el = $(`.bg-cover--${slot}`);
    const url = h.covers[i];
    if (!el) return;
    if (url) { el.style.setProperty('--cover-img', `url("${url.replace(/"/g, '%22')}")`); probeImage(url); }
    else el.style.removeProperty('--cover-img');
  });
}

// Tampilkan langsung (tanpa animasi masuk) untuk pembaruan realtime
function settleIn(root) {
  if (!root) return;
  $$('.reveal:not(.show)', root).forEach((el) => el.classList.add('show'));
  $$('b[data-n]', root).forEach((b) => { b.textContent = (+b.dataset.n).toLocaleString('id-ID') + b.dataset.suffix; });
}

function renderStats(settle) {
  const root = $('#stats');
  if (!root) return;
  const s = DATA.settings.stats;
  const stats = [{ label: 'Total Produk', value: PRODUCTS.length, suffix: '' }];
  if (s.customers > 0) stats.push({ label: 'Pelanggan', value: s.customers, suffix: '' });
  if (s.orders > 0) stats.push({ label: 'Pesanan Selesai', value: s.orders, suffix: '' });
  if (s.support) stats.push({ label: 'Support', text: s.support });

  root.style.setProperty('--cols', stats.length);
  root.innerHTML = stats.map((st) => `
    <div class="stat reveal">
      <b${typeof st.value === 'number' ? ` data-n="${st.value}" data-suffix="${st.suffix}"` : ''}>${typeof st.value === 'number' ? 0 : esc(st.text)}</b>
      <span>${st.label}</span>
    </div>`).join('');
  if (settle) settleIn(root); else observeReveals();
}

function renderSections() {
  if (!isHome) return;
  const s = DATA.settings.sections;
  const set = (sel, text) => { const el = $(sel); el.textContent = text; el.hidden = !text; };
  set('#products-title', s.products.title);
  set('#products-sub', s.products.subtitle);
  set('#faq-title', s.faq.title);
  set('#contact-title', s.contact.title);
  set('#contact-sub', s.contact.subtitle);
}

// Seksi tanpa isi disembunyikan beserta tautan menunya
function toggleSection(id, show) {
  const section = $('#' + id);
  if (section) section.hidden = !show;
  $$(`.nav a[href="#${id}"], .footer__links a[href="#${id}"]`).forEach((a) => { a.hidden = !show; });
}

function renderFaq(settle) {
  const root = $('#faq-list');
  if (!root) return;
  const open = new Set($$('.faq__item.is-open', root).map((el) => el.dataset.id));
  root.innerHTML = DATA.faq.map((item) => `
    <div class="faq__item reveal${open.has(item.id) ? ' is-open' : ''}" data-id="${item.id}">
      <button class="faq__q" type="button" aria-expanded="${open.has(item.id)}">${esc(item.q)}</button>
      <div class="faq__a"><div><p>${esc(item.a)}</p></div></div>
    </div>`).join('');
  toggleSection('faq', DATA.faq.length > 0);
  if (settle) settleIn(root); else observeReveals();
}

function renderContacts(settle) {
  const root = $('#contact-list');
  if (!root) return;
  root.innerHTML = DATA.contacts.map((c) => {
    const href = safeHref(c.href);
    return `
    <a class="contact-card reveal" href="${esc(href || '#')}"${href ? extAttrs(href) : ' data-placeholder'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="${esc(c.icon)}"/>
      </svg>
      <small>${esc(c.label)}</small>
      <b>${esc(c.value)}</b>
    </a>`;
  }).join('');
  toggleSection('contact', DATA.contacts.length > 0);
  if (settle) settleIn(root); else observeReveals();
}

function setupStaticHandlers() {
  $('#faq-list').addEventListener('click', (e) => {
    const button = e.target.closest('.faq__q');
    if (!button) return;
    const isOpen = button.parentElement.classList.toggle('is-open');
    button.setAttribute('aria-expanded', isOpen);
  });
  $('#product-groups').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) sync({ settle: false }).catch(renderLoadError);
  });
  // Link placeholder (belum ada tujuan) tidak boleh melompat ke atas halaman
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-placeholder]')) e.preventDefault();
  });
}


/* 5. Daftar produk (cari, urut, filter)
   -------------------------------------------------------------------------- */
const state = { query: '', category: 'Semua', sort: 'new' };

const SORTERS = {
  new: (a, b) => b.id - a.id,
  lo:  (a, b) => a.price - b.price,
  hi:  (a, b) => b.price - a.price,
  az:  (a, b) => a.name.localeCompare(b.name),
};

function renderProducts({ settle = false } = {}) {
  const root = $('#product-groups');
  if (!root) return;
  const list = PRODUCTS
    .filter((p) => state.category === 'Semua' || p.categoryId === state.category)
    .filter((p) => (p.name + p.description).toLowerCase().includes(state.query))
    .sort(SORTERS[state.sort]);

  const html = DATA.categories.map((category) => {
    const items = list.filter((p) => p.categoryId === category.id);
    if (!items.length) return '';

    return `
      <section class="category">
        <div class="category__head">
          <h3>${esc(category.name)}</h3>
          <small>${items.length} produk</small>
        </div>
        <ul class="product-grid" data-stagger>${items.map(productCard).join('')}</ul>
      </section>`;
  }).join('');

  root.innerHTML = html ||
    `<p class="section__sub">${PRODUCTS.length ? 'Produk tidak ditemukan. Coba kata kunci lain atau pilih kategori Semua.' : 'Belum ada produk yang tersedia saat ini.'}</p>`;

  if (settle) settleIn(root); else observeReveals();
}

function renderLoadError() {
  const root = $('#product-groups');
  if (root && !PRODUCTS.length) {
    root.innerHTML = '<p class="section__sub" role="alert">Data belum bisa dimuat. <button class="filter" type="button" data-retry>Coba lagi</button></p>';
  }
}

function renderFilters() {
  const root = $('#filters');
  if (!root) return;
  if (state.category !== 'Semua' && !DATA.categories.some((c) => c.id === state.category)) state.category = 'Semua';
  const all = [{ id: 'Semua', name: 'Semua' }, ...DATA.categories];
  root.innerHTML = all.map((c) => `<button class="filter${c.id === state.category ? ' on' : ''}" type="button" data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join('');
}

function setupProductControls() {
  $('#filters').addEventListener('click', (e) => {
    const button = e.target.closest('.filter');
    if (!button) return;
    state.category = button.dataset.cat;
    $$('.filter', $('#filters')).forEach((f) => f.classList.toggle('on', f === button));
    renderProducts();
  });

  $('#search-input').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderProducts();
  });

  $('#sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderProducts();
  });
}


/* 6. Animasi (reveal, hitung angka)
   -------------------------------------------------------------------------- */
function countUp(el) {
  const target = +el.dataset.n;
  const suffix = el.dataset.suffix;
  const duration = 1100;
  const start = performance.now();

  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased).toLocaleString('id-ID') + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  };

  prefersReducedMotion ? tick(start + duration) : requestAnimationFrame(tick);
}

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('show');
    revealObserver.unobserve(entry.target);
    $$('b[data-n]', entry.target).forEach(countUp);
  });
}, { threshold: .15, rootMargin: '0px 0px -5% 0px' });

function observeReveals() {
  // Jeda bertahap antar item dalam satu grup
  $$('[data-stagger]').forEach((group) => {
    [...group.children].forEach((child, i) => child.style.setProperty('--d', (i % 6) * 70 + 'ms'));
  });
  $$('.reveal:not(.show)').forEach((el) => revealObserver.observe(el));
}


/* 7. Header, menu mobile, scroll-spy
   -------------------------------------------------------------------------- */
function setupHeader() {
  const header = $('#site-header');
  const toggle = $('#menu-toggle');

  addEventListener('scroll', () => {
    header.classList.toggle('is-scrolled', scrollY > 8);
  }, { passive: true });

  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-expanded', header.classList.toggle('is-open'));
  });

  $$('.nav a').forEach((link) => link.addEventListener('click', () => {
    header.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', false);
  }));

  // Tandai menu aktif sesuai seksi yang sedang terlihat
  const navLinks = $$('.nav a[href^="#"]');
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      navLinks.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + entry.target.id));
    });
  }, { rootMargin: '-45% 0px -50% 0px' });

  $$('main > section[id]').forEach((section) => spy.observe(section));
}


/* 8. Efek tambahan
   -------------------------------------------------------------------------- */
// Glow kartu mengikuti pointer
function setupCardGlow() {
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', e.clientX - rect.left + 'px');
    card.style.setProperty('--my', e.clientY - rect.top + 'px');
  }, { passive: true });
}

/* 9. Sinkron data + realtime
   --------------------------------------------------------------------------
   MongoDB adalah sumber kebenaran. Event Socket.IO hanya membawa perubahan;
   setelah koneksi putus lalu tersambung lagi, seluruh data diambil ulang dari API.
   Halaman lain (product.js) ikut mendengar lewat event DOM "mp:change".
   -------------------------------------------------------------------------- */
let loaded = false;
let rendered = false;
let syncing = null;

const announce = (entity, action, payload) =>
  document.dispatchEvent(new CustomEvent('mp:change', { detail: { entity, action, payload } }));

function applyBootstrap(d) {
  DATA.settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, { ...DEFAULT_SETTINGS[k], ...(d.settings?.[k] || {}) }]));
  DATA.categories = d.categories;
  replaceList(PRODUCTS, d.products);
  DATA.faq = d.faq;
  DATA.contacts = d.contacts;
  loaded = true;
}

function renderAll(settle) {
  renderBrand();
  if (isHome) {
    renderHero();
    renderSections();
    renderFilters();
    renderStats(settle);
    renderFaq(settle);
    renderContacts(settle);
    renderProducts({ settle });
  }
}

function sync({ settle = rendered } = {}) {
  syncing ||= api('/bootstrap').then(applyBootstrap).finally(() => { syncing = null; });
  return syncing.then(() => {
    renderAll(settle);
    rendered = true;
    announce('sync', 'done');
  });
}

function upsertById(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) list.push(item); else list[i] = item;
}

function onLiveEvent(name, p) {
  const [entity, action] = name.split(':');

  if (entity === 'product') {
    if (action === 'bulk') { sync().catch(() => {}); return; }
    if (action === 'delete') {
      const i = PRODUCTS.findIndex((x) => x.id === p.id);
      if (i >= 0) PRODUCTS.splice(i, 1);
    } else if (!DATA.categories.some((c) => c.id === p.categoryId)) {
      sync().catch(() => {}); return;            // kategori belum dikenal -> ambil ulang
    } else upsertById(PRODUCTS, p);
    renderStats(true);
    renderProducts({ settle: true });

  } else if (entity === 'category') {
    if (action === 'update') {
      upsertById(DATA.categories, p);
      DATA.categories.sort((a, b) => a.order - b.order);
      PRODUCTS.forEach((x) => { if (x.categoryId === p.id) x.category = p.name; });
      renderFilters();
      renderProducts({ settle: true });
    } else {
      if (action === 'delete') {
        DATA.categories = DATA.categories.filter((c) => c.id !== p.id);
        replaceList(PRODUCTS, PRODUCTS.filter((x) => x.categoryId !== p.id));
        renderFilters(); renderStats(true); renderProducts({ settle: true });
      }
      sync().catch(() => {});                    // create / delete / reorder -> sinkron dari database
    }

  } else if (entity === 'hero') {
    DATA.settings.hero = { ...DEFAULT_SETTINGS.hero, ...p };
    renderHero();

  } else if (entity === 'settings') {
    DATA.settings[p.key] = { ...DEFAULT_SETTINGS[p.key], ...p.value };
    renderBrand(); renderSections(); renderStats(true);

  } else if (entity === 'faq' || entity === 'contact') {
    const key = entity === 'faq' ? 'faq' : 'contacts';
    if (action === 'reorder') { sync().catch(() => {}); return; }
    if (action === 'delete') DATA[key] = DATA[key].filter((x) => x.id !== p.id);
    else { upsertById(DATA[key], p); DATA[key].sort((a, b) => a.order - b.order); }
    if (entity === 'faq') renderFaq(true); else renderContacts(true);
  }

  announce(entity, action, p);                  // product.js & review: ikut menyesuaikan
}

/* Mulai
   -------------------------------------------------------------------------- */
setupHeader();
setupCardGlow();
if (isHome) {
  setupStaticHandlers();
  setupProductControls();
}

const ready = sync({ settle: false }).catch((err) => { renderLoadError(err); });
let poller;
const socket = Live.start({
  onEvent: onLiveEvent,
  onSync: () => sync().catch(() => {}),
  onStatus: (status) => {
    document.documentElement.dataset.live = status;
    if (status === 'online' && !loaded) sync({ settle: false }).catch(renderLoadError);  // server baru hidup setelah halaman dibuka
  },
});
if (!socket) poller = setInterval(() => sync().catch(() => {}), 30000);   // tanpa Socket.IO: polling pelan

window.MP = { ready, sync, get loaded() { return loaded; } };

// Tombol Beli pada kartu membuka Product Detail
document.addEventListener('click', (e) => {
  const button = e.target.closest('.buy-btn');
  if (button && !button.disabled) location.href = 'product.html?id=' + button.dataset.id;
});
