import { $, $$, html, mount, icon, num, rp, dateTime, pagerHTML, emptyState, skeletonRows, debounce, toast, toastError, dialog, confirmDialog, busy, fieldErrors } from '../ui.js';
import { api } from '../api.js';
import { tallyCodes } from './_codeProduct.js';

const STATUS = {
  available: ['Tersedia', 'pill--ok'],
  sold: ['Terjual', ''],
  redeemed: ['Digunakan', 'pill--mute'],
};
const pill = (s) => html`<span class="pill ${(STATUS[s] || ['', ''])[1]}">${(STATUS[s] || [s])[0]}</span>`;

const FILTERS = { productId: '', status: '', order: '', email: '', customer: '', code: '', from: '', to: '' };

/**
 * Laporan Code. Semua angka dan baris dari MongoDB lewat API Admin (/api/admin/codes).
 * Realtime lewat Socket.IO admin yang sudah ada: code:stats (angka), code:update (satu baris), code:refresh (muat ulang).
 * Code berstatus Tersedia disamarkan di daftar; isi utuh hanya lewat tombol "Lihat" (permintaan admin yang sedang login).
 */
export default {
  async mount(root) {
    const q = { page: 1, limit: 25, sort: 'newest', ...FILTERS };
    let stats = null;
    let alive = true;
    let reqId = 0;
    let rows = new Map();

    mount(root, html`
      <div class="page-head">
        <div><h2>Laporan Code</h2><p>Stok code, code yang sudah dikirim ke pelanggan, dan yang sudah digunakan. Berubah otomatis tanpa refresh.</p></div>
      </div>

      <section class="card code-sum" id="sum" aria-label="Ringkasan code">${skeletonRows(4, 1)}</section>

      <section class="card" style="margin-top:16px">
        <div class="card__head"><h3>Stok per produk</h3><small>Klik produk untuk menyaring daftar di bawah.</small></div>
        <div class="table-wrap" id="per-product">${skeletonRows(6, 3)}</div>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card__head"><h3>Daftar code</h3><small id="list-note"></small></div>
        <div class="toolbar code-filters">
          <select id="f-product" aria-label="Produk"><option value="">Semua produk</option></select>
          <select id="f-status" aria-label="Status code">
            <option value="">Semua status</option>
            <option value="available">Tersedia</option>
            <option value="delivered">Sudah dikirim (terjual + digunakan)</option>
            <option value="sold">Terjual, belum digunakan</option>
            <option value="redeemed">Sudah digunakan</option>
          </select>
          <label class="search"><span class="sr-only">Cari code</span>${icon('key')}<input id="f-code" type="search" placeholder="Code" autocomplete="off" spellcheck="false"></label>
          <label class="search"><span class="sr-only">Order ID</span>${icon('receipt')}<input id="f-order" type="search" placeholder="Order ID / ID transaksi" autocomplete="off"></label>
          <label class="search"><span class="sr-only">Email</span>${icon('mail')}<input id="f-email" type="search" placeholder="Email" autocomplete="off"></label>
          <label class="search"><span class="sr-only">Customer</span>${icon('user')}<input id="f-customer" type="search" placeholder="Nama customer" autocomplete="off"></label>
          <label class="datefield"><span>Diberikan dari</span><input id="f-from" type="date"></label>
          <label class="datefield"><span>sampai</span><input id="f-to" type="date"></label>
          <button class="btn btn--ghost btn--sm" type="button" id="f-reset">Atur ulang</button>
        </div>
        <div class="table-wrap" id="table">${skeletonRows(8)}</div>
        <div id="pager"></div>
      </section>`);

    /* ---------- Ringkasan & stok per produk ---------- */
    function renderStats() {
      if (!stats) return;
      const cell = (label, n, cls = '') => html`<div class="code-sum__item ${cls}"><span>${label}</span><b>${num(n)}</b></div>`;
      $('#sum', root).innerHTML = html`
        <div class="code-sum__row">
          ${cell('Total code', stats.total)}${cell('Tersedia', stats.available, 'is-ok')}${cell('Terjual', stats.sold)}${cell('Digunakan', stats.redeemed, 'is-mute')}
        </div>
        ${stats.waiting ? html`<p class="code-sum__alert" role="status">${icon('alert')}<span><b>${num(stats.waiting)} pesanan</b> sudah dibayar tetapi belum mendapat code karena stok habis. Tambah stok di tabel di bawah; pesanan dipenuhi otomatis, yang terlama lebih dulu.</span></p>` : ''}`.s;

      const sel = $('#f-product', root);
      const cur = sel.value;
      sel.innerHTML = html`<option value="">Semua produk</option>${stats.products.map((p) => html`<option value="${p.productId}">${p.name}</option>`)}`.s;
      sel.value = stats.products.some((p) => String(p.productId) === cur) ? cur : '';

      $('#per-product', root).innerHTML = (stats.products.length ? html`
        <table>
          <thead><tr><th>Produk</th><th class="num">Harga</th><th class="num">Tersedia</th><th class="num">Terjual</th><th class="num">Digunakan</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>${stats.products.map((p) => html`<tr data-pid="${p.productId}">
            <td><b><a href="#/codes" data-filter-product="${p.productId}">${p.name}</a></b>${p.active ? '' : html` <span class="pill pill--mute">nonaktif</span>`}${p.waiting ? html`<br><small class="faint">${num(p.waiting)} pesanan menunggu code</small>` : ''}</td>
            <td class="num">${rp(p.price)}</td>
            <td class="num">${p.available === 0 ? html`<span class="pill pill--danger">Habis</span>` : p.available <= 10 ? html`<span class="pill pill--warn">${num(p.available)}</span>` : html`<b>${num(p.available)}</b>`}</td>
            <td class="num">${num(p.sold)}</td><td class="num">${num(p.redeemed)}</td><td class="num">${num(p.total)}</td>
            <td><div class="row-actions"><button class="btn btn--sm" type="button" data-addstock="${p.id}">${icon('plus')}Tambah stok</button></div></td>
          </tr>`)}</tbody>
        </table>` : emptyState('Belum ada produk code', 'Buat lewat Produk → Tambah produk → Sistem Code.', 'key')).s;
    }
    async function loadStats() {
      try { stats = await api.get('/codes/stats'); if (alive) renderStats(); }
      catch (err) { if (alive) toastError(err, 'Ringkasan code gagal dimuat'); }
    }

    /* ---------- Daftar ---------- */
    const rowHTML = (c) => html`<tr data-id="${c.id}">
      <td><div class="code-cell"><code class="code-chip ${c.masked ? 'is-masked' : ''}">${c.code}</code>
        ${c.masked ? html`<button class="icon-btn" type="button" data-reveal="${c.id}" aria-label="Lihat isi code" title="Lihat isi code">${icon('eye')}</button>` : html`<button class="icon-btn" type="button" data-copy="${c.code}" aria-label="Salin code" title="Salin code">${icon('copy')}</button>`}</div></td>
      <td>${c.productName ?? html`<span class="faint">—</span>`}</td>
      <td>${c.orderNo ? html`<b>${c.orderNo}</b>` : html`<span class="faint">—</span>`}</td>
      <td>${c.customer.name ? html`${c.customer.name}<br><small class="faint">${c.customer.email}${c.customer.whatsapp ? ` · +${c.customer.whatsapp}` : ''}</small>` : html`<span class="faint">—</span>`}</td>
      <td>${pill(c.status)}${c.redeemSource ? html`<br><small class="faint">via ${c.redeemSource === 'api' ? 'sistem redeem' : 'admin'}</small>` : ''}</td>
      <td class="muted">${dateTime(c.assignedAt)}</td>
      <td class="muted">${dateTime(c.redeemedAt)}</td>
      <td><div class="row-actions">${c.status === 'sold' ? html`<button class="btn btn--sm" type="button" data-redeem="${c.id}">Tandai digunakan</button>` : ''}</div></td>
    </tr>`;

    async function load() {
      const id = ++reqId;
      try {
        const res = await api.get('/codes', q);
        if (!alive || id !== reqId) return;
        if (!res.items.length && q.page > 1) { q.page = res.totalPages; return load(); }
        rows = new Map(res.items.map((c) => [c.id, c]));
        const filtered = Object.keys(FILTERS).some((k) => q[k]);
        $('#table', root).innerHTML = (res.items.length ? html`
          <table>
            <thead><tr><th>Code</th><th>Produk</th><th>Order ID</th><th>Customer</th><th>Status</th><th>Diberikan</th><th>Digunakan</th><th></th></tr></thead>
            <tbody id="rows">${res.items.map(rowHTML)}</tbody>
          </table>` : emptyState(filtered ? 'Tidak ada code yang cocok' : 'Belum ada code', filtered ? 'Ubah kata kunci atau filter.' : 'Tambahkan code lewat Produk → Sistem Code.', 'key')).s;
        $('#pager', root).innerHTML = pagerHTML(res).s;
        $('#list-note', root).textContent = res.total ? `${num(res.total)} code` : '';
      } catch (err) { if (alive) { if (err.fields && Object.keys(err.fields).length) toast(Object.values(err.fields)[0], { type: 'error' }); else toastError(err, 'Daftar code gagal dimuat'); } }
    }
    const loadSoon = debounce(load, 300);
    const refreshAll = () => { loadStats(); load(); };

    /* ---------- Filter ---------- */
    const bind = (sel, key, { immediate = false } = {}) => $(sel, root).addEventListener(immediate ? 'change' : 'input', (e) => { q[key] = e.target.value.trim(); q.page = 1; immediate ? load() : loadSoon(); });
    bind('#f-product', 'productId', { immediate: true });
    bind('#f-status', 'status', { immediate: true });
    bind('#f-from', 'from', { immediate: true });
    bind('#f-to', 'to', { immediate: true });
    bind('#f-code', 'code'); bind('#f-order', 'order'); bind('#f-email', 'email'); bind('#f-customer', 'customer');
    $('#f-reset', root).addEventListener('click', () => {
      Object.assign(q, FILTERS, { page: 1 });
      $$('.code-filters input, .code-filters select', root).forEach((el) => { el.value = ''; });
      load();
    });

    /* ---------- Aksi ---------- */
    async function copy(text, btn) {
      try { await navigator.clipboard.writeText(text); }
      catch { const ta = Object.assign(document.createElement('textarea'), { value: text }); ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch { /* abaikan */ } ta.remove(); }
      toast('Code disalin');
      btn?.blur();
    }

    function addStockDialog(product) {
      const d = dialog({
        title: `Tambah stok — ${product.name}`,
        body: html`<p class="muted" style="margin-top:-6px">Satu code per baris. Code yang sudah ada di sistem otomatis dilewati.</p>
          <label class="field"><span class="sr-only">Code baru</span><textarea name="codes" class="mono code-input" rows="9" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="CODE-AAAA-BBBB&#10;CODE-CCCC-DDDD"></textarea><small id="tally" aria-live="polite"></small></label>`,
        foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--primary">Tambah ke stok</button>`,
      });
      const f = d.form;
      f.elements.codes.addEventListener('input', () => {
        const t = f.elements.codes.value.trim() ? tallyCodes(f.elements.codes.value) : null;
        $('#tally', f).textContent = t ? `${num(t.valid)} code valid${t.dup ? ` · ${num(t.dup)} duplikat diabaikan` : ''}${t.bad ? ` · ${num(t.bad)} baris tidak valid` : ''}` : '';
      });
      f.addEventListener('submit', async () => {
        try {
          const r = await busy($('button[type="submit"]', f), () => api.post(`/code-products/${product.id}/codes`, { codes: f.elements.codes.value }));
          d.close();
          toast(`${num(r.added)} code ditambahkan`, { detail: [r.duplicates ? `${num(r.duplicates)} sudah ada dan dilewati` : '', r.fulfilled ? `${num(r.fulfilled)} pesanan yang menunggu langsung dipenuhi` : '', `Stok sekarang ${num(r.stock)}`].filter(Boolean).join(' · ') });
        } catch (err) { if (!fieldErrors(f, err.fields)) toastError(err); }
      });
      f.elements.codes.focus();
    }

    root.addEventListener('click', async (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { q.page = +pg.dataset.page; return load(); }

      const fp = e.target.closest('[data-filter-product]');
      if (fp) { e.preventDefault(); q.productId = fp.dataset.filterProduct; q.page = 1; $('#f-product', root).value = q.productId; return load(); }

      const add = e.target.closest('[data-addstock]');
      if (add) { const p = stats?.products.find((x) => x.id === add.dataset.addstock); if (p) addStockDialog(p); return; }

      const cp = e.target.closest('[data-copy]');
      if (cp) return copy(cp.dataset.copy, cp);

      const rev = e.target.closest('[data-reveal]');
      if (rev) {
        try {
          const { item } = await busy(rev, () => api.get(`/codes/${rev.dataset.reveal}/reveal`));
          rows.set(item.id, item);
          const tr = $(`tr[data-id="${item.id}"]`, root);
          if (tr) tr.outerHTML = rowHTML(item).s;
        } catch (err) { toastError(err, 'Code gagal ditampilkan'); }
        return;
      }

      const red = e.target.closest('[data-redeem]');
      if (red) {
        const c = rows.get(red.dataset.redeem);
        const ok = await confirmDialog({ title: 'Tandai sudah digunakan?', message: `Code untuk pesanan ${c?.orderNo || ''} akan ditandai Digunakan dan tidak bisa dipakai lagi. Lakukan ini hanya bila code memang sudah diredeem.`, confirmLabel: 'Tandai digunakan' });
        if (!ok) return;
        try { await api.post(`/codes/${red.dataset.redeem}/redeem`); toast('Code ditandai digunakan'); }
        catch (err) { toastError(err, 'Gagal menandai code'); }
      }
    });

    await Promise.all([loadStats(), load()]);

    return {
      destroy() { alive = false; loadSoon.cancel(); },
      onLive(evt, payload) {
        if (!alive) return;
        if (evt === 'resync' || evt === 'code:refresh') return refreshAll();
        if (evt === 'code:stats') { stats = payload; return renderStats(); }
        if (evt === 'code:update') {
          const tr = $(`tr[data-id="${payload.id}"]`, root);
          if (tr) {
            rows.set(payload.id, payload);
            tr.outerHTML = rowHTML(payload).s;
            const fresh = $(`tr[data-id="${payload.id}"]`, root);
            fresh?.classList.add('row-flash');
          } else if (q.page === 1) loadSoon();   // code baru diberikan: muncul di daftar bila cocok dengan filter
        }
      },
    };
  },
};
