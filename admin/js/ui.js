/* Helper UI. Template `html` MENGESCAPE semua nilai yang disisipkan, kecuali yang dibungkus raw()/html. */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v == null || v === false ? '' : esc(v));
export const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const mount = (el, h) => { el.innerHTML = part(h); };

/* ---------- Ikon ---------- */
const P = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.2 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  layout: 'M3 4h18v16H3zM3 10h18M9 10v10',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5M12 17h.01',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M9 9h.01',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  up: 'm6 15 6-6 6 6',
  top: 'M6 4h12M6 18l6-6 6 6',
  down: 'm6 9 6 6 6-6',
  left: 'm15 6-6 6 6 6',
  right: 'm9 6 6 6-6 6',
  x: 'M6 6l12 12M18 6 6 18',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  external: 'M14 4h6v6M20 4 10 14M18 14v6H4V6h6',
  logout: 'M9 21H5V3h4M16 17l5-5-5-5M21 12H9',
  check: 'm5 12 5 5 9-10',
  menu: 'M4 7h16M4 12h16M4 17h16',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  wallet: 'M3 7a2 2 0 0 1 2-2h14v4M3 7v10a2 2 0 0 0 2 2h16V9H5a2 2 0 0 1-2-2zM16 14h.01',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  mail: 'M3 7l9 6 9-6M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
  key: 'M21 2l-2 2M11.4 11.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zM11.4 11.6 15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  send: 'M5 12 20 4l-5 16-3-6.5zM12 13.5 20 4',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  clip: 'm21 11.5-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8',
  volume: 'M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  mute: 'M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2',
  eyeoff: 'M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 7.6A17 17 0 0 0 2 12s4 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
};
export const icon = (name, cls = '') => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[name] || ''}"/></svg>`);

/* ---------- Format ---------- */
export const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
export const num = (n) => Number(n || 0).toLocaleString('id-ID');
export const dateShort = (iso) => (iso ? new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const bytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
export const starsHTML = (n) => html`<span class="stars" role="img" aria-label="${n} dari 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>`;
export const debounce = (fn, ms = 300) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };

export const STOCK_LOW = 10;
export const stockPill = (stock) => (stock === 0 ? html`<span class="pill pill--danger">Habis</span>` : stock <= STOCK_LOW ? html`<span class="pill pill--warn">${num(stock)} · terbatas</span>` : html`<span class="pill pill--ok">${num(stock)}</span>`);

/* ---------- Toast ---------- */
export function toast(message, { type = 'ok', detail = '' } = {}) {
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = part(html`${icon(type === 'error' ? 'alert' : 'check')}<div><b>${message}</b>${detail ? html`<small>${detail}</small>` : ''}</div>`);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3600);
}
export const toastError = (err, fallback = 'Terjadi kesalahan') => toast(err?.message || fallback, { type: 'error' });

/* ---------- Tombol sibuk ---------- */
export async function busy(btn, fn) {
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try { return await fn(); } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
}

/* ---------- Dialog / drawer ---------- */
export function dialog({ kind = 'modal', title, body, foot = '' }) {
  const el = document.createElement('dialog');
  el.className = kind;
  el.setAttribute('aria-label', title);
  el.innerHTML = part(html`
    <form class="dlg" novalidate>
      <header class="dlg__head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Tutup">${icon('x')}</button></header>
      <div class="dlg__body">${body}</div>
      <footer class="dlg__foot">${foot}</footer>
    </form>`);
  document.body.append(el);
  const ctl = {
    el,
    form: $('form', el),
    body: $('.dlg__body', el),
    close: () => el.close(),
    closed: new Promise((resolve) => el.addEventListener('close', () => { el.remove(); resolve(); }, { once: true })),
  };
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) el.close(); });
  ctl.form.addEventListener('submit', (e) => e.preventDefault());
  el.showModal();
  return ctl;
}

export function confirmDialog({ title, message, confirmLabel = 'Ya, lanjutkan', danger = false }) {
  return new Promise((resolve) => {
    const d = dialog({
      title,
      body: html`<p>${message}</p>`,
      foot: html`<button type="button" class="btn" data-close>Batal</button><button type="button" class="btn ${danger ? 'btn--danger-solid' : 'btn--primary'}" data-ok>${confirmLabel}</button>`,
    });
    let result = false;
    $('[data-ok]', d.el).addEventListener('click', () => { result = true; d.close(); });
    d.closed.then(() => resolve(result));
    $('[data-ok]', d.el).focus();
  });
}

/* ---------- Pagination ---------- */
export function pagerHTML({ page, totalPages, total, limit }) {
  const from = total ? (page - 1) * limit + 1 : 0;
  const to = Math.min(total, page * limit);
  const nums = [];
  for (let i = 1; i <= totalPages; i++) if (i === 1 || i === totalPages || Math.abs(i - page) <= 1) nums.push(i);
  const withGaps = nums.flatMap((n, i) => (i && n - nums[i - 1] > 1 ? ['…', n] : [n]));
  return html`<div class="pager">
    <span>${total ? html`Menampilkan ${num(from)}–${num(to)} dari ${num(total)}` : 'Tidak ada data'}</span>
    ${totalPages > 1 ? html`<div class="pager__nav">
      <button class="btn btn--sm" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Halaman sebelumnya">${icon('left')}</button>
      ${withGaps.map((n) => (n === '…' ? html`<span class="faint">…</span>` : html`<button class="btn btn--sm" type="button" data-page="${n}" ${n === page ? raw('aria-current="page"') : ''}>${n}</button>`))}
      <button class="btn btn--sm" type="button" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''} aria-label="Halaman berikutnya">${icon('right')}</button>
    </div>` : ''}
  </div>`;
}

export const emptyState = (title, text, ico = 'box') => html`<div class="empty">${icon(ico)}<b>${title}</b><span>${text}</span></div>`;
export const skeletonRows = (cols, rows = 6) => html`<table><tbody>${Array.from({ length: rows }, () => html`<tr class="skeleton">${Array.from({ length: cols }, () => html`<td><i></i></td>`)}</tr>`)}</tbody></table>`;

export function fieldErrors(form, fields = {}) {
  $$('.field.invalid', form).forEach((f) => { f.classList.remove('invalid'); $('.err', f)?.remove(); });
  let first = null;
  for (const [name, msg] of Object.entries(fields)) {
    const input = form.elements[name] || $(`[data-field="${name}"]`, form);
    const field = input?.closest?.('.field');
    if (!field) continue;
    field.classList.add('invalid');
    field.insertAdjacentHTML('beforeend', part(html`<span class="err" role="alert">${msg}</span>`));
    first ||= input;
  }
  first?.focus?.();
  return Boolean(first);
}
