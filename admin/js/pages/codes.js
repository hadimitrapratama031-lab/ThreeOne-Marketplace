import { $, $$, html, mount, icon, num, rp, dateTime, pagerHTML, emptyState, skeletonRows, debounce, toast, toastError, dialog, busy, fieldErrors } from '../ui.js';
import { api } from '../api.js';
import { tallyCodes } from './_codeProduct.js';

const STATUS = {
  available: ['Tersedia', 'pill--ok'],
  sold: ['Terjual', ''],
};
const pill = (s) => html`<span class="pill ${(STATUS[s] || ['', ''])[1]}">${(STATUS[s] || [s])[0]}</span>`;

const FILTERS = { productId: '', status: '', order: '', email: '', customer: '', code: '', from: '', to: '' };

/**
 * Laporan Code. Semua angka dan baris dari MongoDB lewat API Admin (/api/admin/codes).
 * Realtime lewat Socket.IO admin yang sudah ada: code:stats (angka), code:update (satu baris), code:refresh (muat ulang).
 * Code berstatus Tersedia disamarkan di daftar; isi utuh hanya lewat tombol "Lihat" (permintaan admin yang sedang login).
 * Edit / Hapus satu code lewat API Admin (PUT/DELETE /api/admin/codes/:id); code yang sudah terjual wajib konfirmasi tambahan.
 * Hapus massal: centang beberapa code (pilihan bertahan antar halaman, maks 500) lalu "Hapus terpilih" (POST /api/admin/codes/bulk-delete).
 * Realtime: code:update (baris berubah) dan code:delete (baris hilang) dari Socket.IO admin.
 */
export default {
  async mount(root) {
    const q = { page: 1, limit: 25, sort: 'newest', ...FILTERS };
    let stats = null;
    let alive = true;
    let reqId = 0;
    let rows = new Map();
    const selected = new Map();   // id -> baris (pilihan hapus massal; bertahan antar halaman, dikosongkan saat filter berubah)
    const MAX_BULK = 500;

    mount(root, html`
      <div class="page-head">
        <div><h2>Laporan Code</h2><p>Stok code dan code yang sudah dikirim ke pelanggan. Berubah otomatis tanpa refresh.</p></div>
      </div>

      <section class="card code-sum" id="sum" aria-label="Ringkasan code">${skeletonRows(4, 1)}</section>

      <section class="card" style="margin-top:16px">
        <div class="card__head"><h3>Stok per produk</h3><small>Klik produk untuk menyaring daftar di bawah.</small></div>
        <div class="table-wrap" id="per-product">${skeletonRows(6, 3)}</div>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card__head"><h3>Daftar code</h3><span class="code-head-r"><small id="list-note"></small><select id="f-limit" aria-label="Jumlah baris per halaman"><option value="25">25 / halaman</option><option value="50">50 / halaman</option><option value="100">100 / halaman</option></select></span></div>
        <div class="toolbar code-filters">
          <select id="f-product" aria-label="Produk"><option value="">Semua produk</option></select>
          <select id="f-status" aria-label="Status code">
            <option value="">Semua status</option>
            <option value="available">Tersedia</option>
            <option value="sold">Terjual (sudah dikirim)</option>
          </select>
          <label class="search"><span class="sr-only">Cari code</span>${icon('key')}<input id="f-code" type="search" placeholder="Code" autocomplete="off" spellcheck="false"></label>
          <label class="search"><span class="sr-only">Order ID</span>${icon('receipt')}<input id="f-order" type="search" placeholder="Order ID / ID transaksi" autocomplete="off"></label>
          <label class="search"><span class="sr-only">Email</span>${icon('mail')}<input id="f-email" type="search" placeholder="Email" autocomplete="off"></label>
          <label class="search"><span class="sr-only">Customer</span>${icon('user')}<input id="f-customer" type="search" placeholder="Nama customer" autocomplete="off"></label>
          <label class="datefield"><span>Diberikan dari</span><input id="f-from" type="date"></label>
          <label class="datefield"><span>sampai</span><input id="f-to" type="date"></label>
          <button class="btn btn--ghost btn--sm" type="button" id="f-reset">Atur ulang</button>
        </div>
        <div class="bulkbar" id="bulkbar" hidden role="region" aria-label="Aksi massal"></div>
        <div class="table-wrap" id="table">${skeletonRows(8)}</div>
        <div id="pager"></div>
      </section>`);

    /* ---------- Ringkasan & stok per produk ---------- */
    function renderStats() {
      if (!stats) return;
      const cell = (label, n, cls = '') => html`<div class="code-sum__item ${cls}"><span>${label}</span><b>${num(n)}</b></div>`;
      $('#sum', root).innerHTML = html`
        <div class="code-sum__row">
          ${cell('Total code', stats.total)}${cell('Tersedia', stats.available, 'is-ok')}${cell('Terjual', stats.sold)}
        </div>
        ${stats.waiting ? html`<p class="code-sum__alert" role="status">${icon('alert')}<span><b>${num(stats.waiting)} pesanan</b> sudah dibayar tetapi belum mendapat code karena stok habis. Tambah stok di tabel di bawah; pesanan dipenuhi otomatis, yang terlama lebih dulu.</span></p>` : ''}`.s;

      const sel = $('#f-product', root);
      const cur = sel.value;
      sel.innerHTML = html`<option value="">Semua produk</option>${stats.products.map((p) => html`<option value="${p.productId}">${p.name}</option>`)}`.s;
      sel.value = stats.products.some((p) => String(p.productId) === cur) ? cur : '';

      $('#per-product', root).innerHTML = (stats.products.length ? html`
        <table>
          <thead><tr><th>Produk</th><th class="num">Harga</th><th class="num">Tersedia</th><th class="num">Terjual</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>${stats.products.map((p) => html`<tr data-pid="${p.productId}">
            <td><b><a href="#/codes" data-filter-product="${p.productId}">${p.name}</a></b>${p.active ? '' : html` <span class="pill pill--mute">nonaktif</span>`}${p.waiting ? html`<br><small class="faint">${num(p.waiting)} pesanan menunggu code</small>` : ''}</td>
            <td class="num">${rp(p.price)}</td>
            <td class="num">${p.available === 0 ? html`<span class="pill pill--danger">Habis</span>` : p.available <= 10 ? html`<span class="pill pill--warn">${num(p.available)}</span>` : html`<b>${num(p.available)}</b>`}</td>
            <td class="num">${num(p.sold)}</td><td class="num">${num(p.total)}</td>
            <td><div class="row-actions"><button class="btn btn--sm" type="button" data-addstock="${p.id}">${icon('plus')}Tambah stok</button></div></td>
          </tr>`)}</tbody>
        </table>` : emptyState('Belum ada produk code', 'Buat lewat Produk → Tambah produk → Sistem Code.', 'key')).s;
    }
    async function loadStats() {
      try { stats = await api.get('/codes/stats'); if (alive) renderStats(); }
      catch (err) { if (alive) toastError(err, 'Ringkasan code gagal dimuat'); }
    }

    /* ---------- Daftar ---------- */
    const rowHTML = (c) => html`<tr data-id="${c.id}"${selected.has(c.id) ? html` class="is-selected"` : ''}>
      <td class="sel-col"><input type="checkbox" data-sel="${c.id}" aria-label="Pilih code" ${selected.has(c.id) ? 'checked' : ''}></td>
      <td><div class="code-cell"><code class="code-chip ${c.masked ? 'is-masked' : ''}">${c.code}</code>
        ${c.masked ? html`<button class="icon-btn" type="button" data-reveal="${c.id}" aria-label="Lihat isi code" title="Lihat isi code">${icon('eye')}</button>` : html`<button class="icon-btn" type="button" data-copy="${c.code}" aria-label="Salin code" title="Salin code">${icon('copy')}</button>`}</div></td>
      <td>${c.productName ?? html`<span class="faint">—</span>`}</td>
      <td>${c.orderNo ? html`<b>${c.orderNo}</b>` : html`<span class="faint">—</span>`}</td>
      <td>${c.customer.name ? html`${c.customer.name}<br><small class="faint">${c.customer.email}${c.customer.whatsapp ? ` · +${c.customer.whatsapp}` : ''}</small>` : html`<span class="faint">—</span>`}</td>
      <td>${pill(c.status)}</td>
      <td class="muted">${dateTime(c.assignedAt)}</td>
      <td><div class="row-actions">
        <button class="icon-btn" type="button" data-edit="${c.id}" aria-label="Edit code" title="Edit code">${icon('edit')}</button>
        <button class="icon-btn danger" type="button" data-del="${c.id}" aria-label="Hapus code" title="Hapus code">${icon('trash')}</button>
      </div></td>
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
            <thead><tr><th class="sel-col"><input type="checkbox" id="sel-all" aria-label="Pilih semua code di halaman ini"></th><th>Code</th><th>Produk</th><th>Order ID</th><th>Customer</th><th>Status</th><th>Diberikan</th><th><span class="sr-only">Aksi</span></th></tr></thead>
            <tbody id="rows">${res.items.map(rowHTML)}</tbody>
          </table>` : emptyState(filtered ? 'Tidak ada code yang cocok' : 'Belum ada code', filtered ? 'Ubah kata kunci atau filter.' : 'Tambahkan code lewat Produk → Sistem Code.', 'key')).s;
        $('#pager', root).innerHTML = pagerHTML(res).s;
        $('#list-note', root).textContent = res.total ? `${num(res.total)} code` : '';
        syncSel();
      } catch (err) { if (alive) { if (err.fields && Object.keys(err.fields).length) toast(Object.values(err.fields)[0], { type: 'error' }); else toastError(err, 'Daftar code gagal dimuat'); } }
    }
    const loadSoon = debounce(load, 300);
    const refreshAll = () => { loadStats(); load(); };

    /* ---------- Pilihan hapus massal ---------- */
    function syncSel() {
      const boxes = $$('input[data-sel]', root);
      const all = $('#sel-all', root);
      if (all) {
        const on = boxes.filter((b) => b.checked).length;
        all.checked = boxes.length > 0 && on === boxes.length;
        all.indeterminate = on > 0 && on < boxes.length;
      }
      $$('tbody tr[data-id]', root).forEach((tr) => tr.classList.toggle('is-selected', selected.has(tr.dataset.id)));
      const bar = $('#bulkbar', root);
      if (!selected.size) { bar.hidden = true; bar.innerHTML = ''; return; }
      const sold = [...selected.values()].filter((c) => c.status === 'sold').length;
      bar.hidden = false;
      bar.innerHTML = html`
        <span class="bulkbar__n"><b>${num(selected.size)}</b> code dipilih${sold ? html` <span class="faint">· ${num(sold)} sudah terjual</span>` : ''}${selected.size > MAX_BULK ? html` <span class="bulkbar__over">maks ${num(MAX_BULK)} sekali hapus</span>` : ''}</span>
        <span class="bulkbar__btns">
          <button class="btn btn--ghost btn--sm" type="button" data-sel-clear>Batal pilih</button>
          <button class="btn btn--danger btn--sm" type="button" data-bulk-del ${selected.size > MAX_BULK ? 'disabled' : ''}>${icon('trash')}Hapus terpilih</button>
        </span>`.s;
    }
    function clearSel() { selected.clear(); syncSel(); }

    /* ---------- Filter ---------- */
    const bind = (sel, key, { immediate = false } = {}) => $(sel, root).addEventListener(immediate ? 'change' : 'input', (e) => { q[key] = e.target.value.trim(); q.page = 1; clearSel(); immediate ? load() : loadSoon(); });
    $('#f-limit', root).addEventListener('change', (e) => { q.limit = +e.target.value; q.page = 1; load(); });
    bind('#f-product', 'productId', { immediate: true });
    bind('#f-status', 'status', { immediate: true });
    bind('#f-from', 'from', { immediate: true });
    bind('#f-to', 'to', { immediate: true });
    bind('#f-code', 'code'); bind('#f-order', 'order'); bind('#f-email', 'email'); bind('#f-customer', 'customer');
    $('#f-reset', root).addEventListener('click', () => {
      Object.assign(q, FILTERS, { page: 1 });
      $$('.code-filters input, .code-filters select', root).forEach((el) => { el.value = ''; });
      clearSel();
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

    /** Isi utuh code (untuk code Tersedia yang disamarkan di daftar). Code terjual sudah tampil utuh. */
    async function fullCode(c, btn) {
      if (!c.masked) return c;
      const { item } = await busy(btn, () => api.get(`/codes/${c.id}/reveal`));
      return item;
    }
    const customerLine = (c) => html`<b>${c.customer.name || '—'}</b>${c.customer.email ? html` · ${c.customer.email}` : ''}${c.customer.whatsapp ? html` · +${c.customer.whatsapp}` : ''}`;
    const historyBox = (c, text) => html`<div class="code-warn" role="alert">
      ${icon('alert')}
      <div><b>Code ini sudah diberikan ke pelanggan</b>
        <dl class="code-warn__meta"><div><dt>Order</dt><dd>${c.orderNo || '—'}</dd></div><div><dt>Pelanggan</dt><dd>${customerLine(c)}</dd></div><div><dt>Diberikan</dt><dd>${dateTime(c.assignedAt)}</dd></div></dl>
        <p>${text}</p></div></div>`;
    const sameRow = (item) => {
      rows.set(item.id, item);
      const tr = $(`tr[data-id="${item.id}"]`, root);
      if (!tr) return;
      tr.outerHTML = rowHTML(item).s;
      $(`tr[data-id="${item.id}"]`, root)?.classList.add('row-flash');
    };

    async function editDialog(c) {
      const sold = c.status === 'sold';
      const d = dialog({
        title: 'Edit code',
        body: html`
          <div class="code-meta"><span>${c.productName ?? '—'}</span>${pill(c.status)}</div>
          ${sold ? historyBox(c, html`Mengubah code akan mengubah code yang tampil di halaman pesanan pelanggan (diperbarui otomatis). Email atau WhatsApp yang <b>sudah terkirim</b> tidak ikut berubah, jadi pastikan code baru valid dan pelanggan diberi tahu bila perlu. Order dan pembayaran tidak diubah.`) : ''}
          <label class="field"><span>Isi code</span><input name="code" class="mono code-input" type="text" value="${c.code}" spellcheck="false" autocomplete="off" autocapitalize="off" maxlength="100"><small>4–100 karakter tanpa spasi. Tidak boleh sama dengan code lain.</small></label>
          ${sold ? html`<label class="code-ack"><input type="checkbox" name="ack"><span>Saya mengerti code ini sudah dipakai pelanggan dan tetap ingin mengubahnya.</span></label>` : ''}`,
        foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--primary" ${sold ? 'disabled' : ''}>Simpan perubahan</button>`,
      });
      const f = d.form;
      const save = $('button[type="submit"]', f);
      if (sold) f.elements.ack.addEventListener('change', () => { save.disabled = !f.elements.ack.checked; });
      f.addEventListener('submit', async () => {
        if (save.disabled) return;
        const code = f.elements.code.value.trim();
        if (code === c.code) { d.close(); return toast('Tidak ada perubahan'); }
        try {
          const r = await busy(save, () => api.put(`/codes/${c.id}`, { code, confirm: sold }));
          d.close();
          sameRow(r.item);
          toast('Code diperbarui', { detail: sold ? 'Halaman pesanan pelanggan ikut menampilkan code baru.' : '' });
        } catch (err) {
          if (fieldErrors(f, err.fields)) return;
          toastError(err, 'Code gagal diperbarui');
          if (err.status === 409 || err.status === 404) { d.close(); refreshAll(); }
        }
      });
      f.elements.code.focus(); f.elements.code.select();
    }

    function deleteDialog(c) {
      const sold = c.status === 'sold';
      const d = dialog({
        title: 'Hapus code?',
        body: html`
          <p style="margin:0 0 10px">Code berikut akan dihapus permanen dari database:</p>
          <div class="code-target"><code class="code-chip">${c.code}</code><span class="muted">${c.productName ?? ''}</span></div>
          ${sold
            ? html`${historyBox(c, html`Code ini punya riwayat order. <b>Order dan pembayaran tidak dihapus</b>. Pesanan itu kembali ke antrean <b>menunggu code</b> dan otomatis mendapat code pengganti bila stok tersedia (atau saat stok ditambah). Pelanggan yang membuka halaman pesanannya akan melihat code berubah.`)}
              <label class="code-ack"><input type="checkbox" name="ack"><span>Saya mengerti riwayat code ini akan hilang dan ingin tetap menghapusnya.</span></label>`
            : html`<p class="muted" style="margin:10px 0 0">Code ini masih tersedia dan belum diberikan ke siapa pun. Stok produk akan berkurang satu.</p>`}`,
        foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--danger-solid" ${sold ? 'disabled' : ''}>Hapus code</button>`,
      });
      const f = d.form;
      const go = $('button[type="submit"]', f);
      if (sold) f.elements.ack.addEventListener('change', () => { go.disabled = !f.elements.ack.checked; });
      f.addEventListener('submit', async () => {
        if (go.disabled) return;
        try {
          const r = await busy(go, () => api.del(`/codes/${c.id}`, sold ? { confirm: 'sold' } : {}));
          d.close();
          dropRow(c.id);
          toast('Code dihapus', { detail: sold ? (r.replaced ? `Pesanan ${r.orderNo} langsung mendapat code pengganti.` : `Pesanan ${r.orderNo} menunggu code pengganti.`) : '' });
        } catch (err) {
          toastError(err, 'Code gagal dihapus');
          if (err.status === 409 || err.status === 404) { d.close(); refreshAll(); }
        }
      });
    }

    function bulkDeleteDialog() {
      const items = [...selected.values()];
      const sold = items.filter((c) => c.status === 'sold');
      const avail = items.length - sold.length;
      const perProduct = [...items.reduce((m, c) => m.set(c.productName ?? '—', (m.get(c.productName ?? '—') || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
      const d = dialog({
        title: `Hapus ${num(items.length)} code?`,
        body: html`
          <p style="margin:0 0 10px">Code yang dipilih akan dihapus permanen dari database:</p>
          <div class="code-target code-target--list">
            <span><b>${num(avail)}</b> tersedia</span><span><b>${num(sold.length)}</b> sudah terjual</span>
          </div>
          <ul class="code-bulklist">${perProduct.slice(0, 6).map(([n, k]) => html`<li><span>${n}</span><b>${num(k)}</b></li>`)}${perProduct.length > 6 ? html`<li class="faint"><span>+${perProduct.length - 6} produk lain</span></li>` : ''}</ul>
          ${sold.length
            ? html`<div class="code-warn" role="alert">${icon('alert')}<div><b>${num(sold.length)} code sudah diberikan ke pelanggan</b>
                <p>Code ini punya riwayat order. <b>Order dan pembayaran tidak dihapus</b>. Setiap pesanan terkait kembali ke antrean <b>menunggu code</b> dan otomatis mendapat code pengganti bila stok tersedia (atau saat stok ditambah). Pelanggan yang membuka halaman pesanannya akan melihat code berubah.</p></div></div>
              <label class="code-ack"><input type="checkbox" name="ack"><span>Saya mengerti riwayat code yang sudah terjual akan hilang dan ingin tetap menghapusnya.</span></label>`
            : html`<p class="muted" style="margin:10px 0 0">Semua code yang dipilih masih tersedia dan belum diberikan ke siapa pun. Stok produk akan berkurang.</p>`}`,
        foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--danger-solid" ${sold.length ? 'disabled' : ''}>Hapus ${num(items.length)} code</button>`,
      });
      const f = d.form;
      const go = $('button[type="submit"]', f);
      if (sold.length) f.elements.ack.addEventListener('change', () => { go.disabled = !f.elements.ack.checked; });
      f.addEventListener('submit', async () => {
        if (go.disabled) return;
        try {
          const r = await busy(go, () => api.post('/codes/bulk-delete', { ids: [...selected.keys()], confirm: sold.length > 0 }));
          d.close();
          clearSel();
          refreshAll();
          toast(`${num(r.deleted)} code dihapus`, { detail: [
            r.skipped ? `${num(r.skipped)} dilewati (sudah berubah atau sudah terhapus)` : '',
            r.replaced ? `${num(r.replaced)} pesanan langsung mendapat code pengganti` : '',
            r.waiting ? `${num(r.waiting)} pesanan menunggu code pengganti` : '',
          ].filter(Boolean).join(' · ') });
        } catch (err) {
          toastError(err, 'Code gagal dihapus');
          if (err.status === 409 || err.status === 404) { d.close(); refreshAll(); }
        }
      });
    }

    function dropRow(id) {
      selected.delete(id);
      rows.delete(id);
      $(`tr[data-id="${id}"]`, root)?.remove();
      syncSel();
      loadSoon();   // isi kembali halaman, perbarui total & pager
    }

    root.addEventListener('change', (e) => {
      const one = e.target.closest?.('input[data-sel]');
      if (one) {
        if (one.checked) { const c = rows.get(one.dataset.sel); if (c) selected.set(c.id, c); } else selected.delete(one.dataset.sel);
        return syncSel();
      }
      if (e.target.id === 'sel-all') {
        $$('input[data-sel]', root).forEach((b) => {
          b.checked = e.target.checked;
          const c = rows.get(b.dataset.sel);
          if (e.target.checked && c) selected.set(c.id, c); else selected.delete(b.dataset.sel);
        });
        syncSel();
      }
    });

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-sel-clear]')) { $$('input[data-sel]', root).forEach((b) => { b.checked = false; }); return clearSel(); }
      if (e.target.closest('[data-bulk-del]')) { if (selected.size && selected.size <= MAX_BULK) bulkDeleteDialog(); return; }
      const ed = e.target.closest('[data-edit]');
      const dl = e.target.closest('[data-del]');
      if (ed || dl) {
        const btn = ed || dl;
        const c = rows.get(btn.dataset.edit || btn.dataset.del);
        if (!c) return;
        try { const full = await fullCode(c, btn); if (ed) editDialog(full); else deleteDialog(full); }
        catch (err) { toastError(err, 'Code gagal dimuat'); }
        return;
      }

      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { q.page = +pg.dataset.page; return load(); }

      const fp = e.target.closest('[data-filter-product]');
      if (fp) { e.preventDefault(); q.productId = fp.dataset.filterProduct; q.page = 1; $('#f-product', root).value = q.productId; clearSel(); return load(); }

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
    });

    await Promise.all([loadStats(), load()]);

    return {
      destroy() { alive = false; loadSoon.cancel(); },
      onLive(evt, payload) {
        if (!alive) return;
        if (evt === 'resync' || evt === 'code:refresh') return refreshAll();
        if (evt === 'code:stats') { stats = payload; return renderStats(); }
        if (evt === 'code:delete') { selected.delete(payload.id); if (rows.has(payload.id)) dropRow(payload.id); else { syncSel(); loadSoon(); } return; }
        if (evt === 'code:update') {
          if (selected.has(payload.id)) selected.set(payload.id, payload);
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
