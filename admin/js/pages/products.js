import { $, $$, html, raw, mount, icon, rp, num, dateShort, stockPill, pagerHTML, emptyState, skeletonRows, debounce, toast, toastError, dialog, confirmDialog, busy, fieldErrors } from '../ui.js';
import { api } from '../api.js';
import { mediaManager } from './_media.js';
import { steamSourceBlock, initSteam } from './_steam.js';

const SORTS = [['newest', 'Terbaru'], ['oldest', 'Terlama'], ['updated', 'Terakhir diubah'], ['name', 'Nama A–Z'], ['price_asc', 'Harga terendah'], ['price_desc', 'Harga tertinggi'], ['stock_asc', 'Stok tersedikit'], ['stock_desc', 'Stok terbanyak']];

const thumb = (p) => { const m = p.media.find((x) => x.type === 'image'); return m ? html`<span class="thumb"><img src="${m.url}" alt="" loading="lazy"></span>` : html`<span class="thumb">${icon('image')}</span>`; };

export default {
  async mount(root, ctx) {
    const q = { page: 1, limit: 25, q: '', category: '', status: '', stock: '', sort: 'newest' };
    let categories = [];
    let alive = true;
    let reqId = 0;

    categories = (await api.get('/categories')).items;

    mount(root, html`
      <div class="page-head">
        <div><h2>Produk</h2><p>Semua perubahan langsung tersimpan di database dan dikirim ke Marketplace secara realtime.</p></div>
        <div class="actions"><button class="btn btn--primary" type="button" data-add>${icon('plus')}Tambah produk</button></div>
      </div>
      <section class="card">
        <div class="toolbar">
          <label class="search"><span class="sr-only">Cari produk</span>${icon('search')}<input id="f-q" type="search" placeholder="Cari nama, deskripsi, atau ID" autocomplete="off"></label>
          <select id="f-category" aria-label="Filter kategori"><option value="">Semua kategori</option>${categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
          <select id="f-status" aria-label="Filter status"><option value="">Semua status</option><option value="active">Aktif</option><option value="inactive">Nonaktif</option></select>
          <select id="f-stock" aria-label="Filter stok"><option value="">Semua stok</option><option value="in">Tersedia</option><option value="low">Stok terbatas</option><option value="out">Habis</option></select>
          <select id="f-sort" aria-label="Urutkan">${SORTS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
        </div>
        <div class="table-wrap" id="table">${skeletonRows(7)}</div>
        <div id="pager"></div>
      </section>`);

    /* ---------- Daftar ---------- */
    async function load() {
      const id = ++reqId;
      try {
        const res = await api.get('/products', q);
        if (!alive || id !== reqId) return;
        if (!res.items.length && q.page > 1) { q.page = res.totalPages; return load(); }   // halaman terakhir terhapus
        renderTable(res);
      } catch (err) { if (alive) toastError(err, 'Produk gagal dimuat'); }
    }

    function renderTable(res) {
      const filtered = q.q || q.category || q.status || q.stock;
      $('#table', root).innerHTML = res.items.length ? html`
        <table>
          <thead><tr><th>Produk</th><th>Kategori</th><th class="num">Harga</th><th>Stok</th><th class="num">Terjual</th><th>Tampil</th><th>Diubah</th><th></th></tr></thead>
          <tbody>${res.items.map((p) => html`
            <tr data-id="${p.id}">
              <td><div class="cell-product">${thumb(p)}<div><b><a href="#/products?edit=${p.id}" data-edit="${p.id}">${p.name}</a></b><small>ID ${p.productId}${p.media.length ? ` · ${p.media.length} media` : ' · tanpa gambar'}</small></div></div></td>
              <td>${p.category.name}${p.category.active ? '' : raw(' <span class="pill pill--mute">nonaktif</span>')}</td>
              <td class="num">${rp(p.price)}${p.oldPrice ? html`<br><small class="faint"><s>${rp(p.oldPrice)}</s></small>` : ''}</td>
              <td>${stockPill(p.stock)}</td>
              <td class="num">${num(p.sold)}</td>
              <td><label class="switch"><input type="checkbox" data-toggle="${p.id}" ${p.active ? 'checked' : ''} aria-label="Tampilkan ${p.name} di Marketplace"><i></i></label></td>
              <td class="muted">${dateShort(p.updatedAt)}</td>
              <td><div class="row-actions"><button class="icon-btn" type="button" data-edit="${p.id}" aria-label="Ubah ${p.name}">${icon('edit')}</button><button class="icon-btn danger" type="button" data-del="${p.id}" aria-label="Hapus ${p.name}">${icon('trash')}</button></div></td>
            </tr>`)}</tbody>
        </table>`.s
        : emptyState(filtered ? 'Tidak ada produk yang cocok' : 'Belum ada produk', filtered ? 'Ubah kata kunci atau filter.' : 'Klik “Tambah produk” untuk mulai.').s;
      $('#pager', root).innerHTML = pagerHTML(res).s;
      root.__items = new Map(res.items.map((p) => [p.id, p]));
    }

    const loadDebounced = debounce(load, 300);
    const resetAndLoad = () => { q.page = 1; load(); };

    $('#f-q', root).addEventListener('input', (e) => { q.q = e.target.value.trim(); q.page = 1; loadDebounced(); });
    for (const [id, key] of [['f-category', 'category'], ['f-status', 'status'], ['f-stock', 'stock'], ['f-sort', 'sort']]) {
      $('#' + id, root).addEventListener('change', (e) => { q[key] = e.target.value; resetAndLoad(); });
    }

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-add]')) { openForm(); return; }
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { q.page = +pg.dataset.page; load(); return; }
      const edit = e.target.closest('[data-edit]');
      if (edit) { e.preventDefault(); openForm(root.__items.get(edit.dataset.edit)); return; }
      const del = e.target.closest('[data-del]');
      if (del) remove(root.__items.get(del.dataset.del));
    });
    root.addEventListener('change', async (e) => {
      const box = e.target.closest('[data-toggle]');
      if (!box) return;
      try {
        await api.patch(`/products/${box.dataset.toggle}/status`, { active: box.checked });
        toast(box.checked ? 'Produk ditampilkan di Marketplace' : 'Produk disembunyikan dari Marketplace');
        load();
      } catch (err) { box.checked = !box.checked; toastError(err); }
    });

    async function remove(p) {
      if (!p) return;
      const ok = await confirmDialog({
        title: 'Hapus produk?',
        message: `“${p.name}” akan dihapus permanen dari database, termasuk ulasannya dan ${p.media.length} file di penyimpanan R2. Tindakan ini tidak bisa dibatalkan.`,
        confirmLabel: 'Hapus permanen', danger: true,
      });
      if (!ok) return;
      try { const r = await api.del(`/products/${p.id}`); toast('Produk dihapus', { detail: r.removedReviews ? `${r.removedReviews} ulasan ikut dihapus.` : '' }); load(); }
      catch (err) { toastError(err, 'Gagal menghapus'); }
    }

    /* ---------- Form tambah / ubah ---------- */
    const specRowHTML = (kind, i, r = {}) => html`
      <div class="spec-row" data-spec-row>
        <input name="specs.${kind}.${i}.label" value="${r.label ?? ''}" placeholder="OS" maxlength="60" aria-label="Nama spesifikasi">
        <input name="specs.${kind}.${i}.value" value="${r.value ?? ''}" placeholder="Windows 10 64-bit" maxlength="200" aria-label="Nilai spesifikasi">
        <button type="button" class="icon-btn" data-spec-rm aria-label="Hapus baris">${icon('x')}</button>
      </div>`;

    function openForm(p) {
      if (!categories.length) { toast('Buat kategori dulu', { type: 'error', detail: 'Produk harus punya kategori.' }); ctx.go('categories'); return; }
      const d = dialog({
        kind: 'drawer',
        title: p ? 'Ubah produk' : 'Tambah produk',
        body: html`
          ${p ? '' : steamSourceBlock()}
          <div class="fieldset">
            <h3>Informasi dasar</h3>
            <label class="field"><span>Nama produk</span><input name="name" value="${p?.name ?? ''}" maxlength="120" required></label>
            <label class="field"><span>Kategori</span><select name="category">${categories.map((c) => html`<option value="${c.id}" ${(p?.category.id ?? categories[0].id) === c.id ? 'selected' : ''}>${c.name}${c.active ? '' : ' (nonaktif)'}</option>`)}</select></label>
            <label class="field"><span>Deskripsi singkat</span><textarea name="description" rows="2" maxlength="300">${p?.description ?? ''}</textarea><small>Tampil di kartu produk. <span id="desc-count"></span></small></label>
            <label class="field"><span>Deskripsi lengkap</span><textarea name="about" rows="5" maxlength="4000">${p?.about ?? ''}</textarea><small>Tampil di bagian “Tentang Produk”. Pisahkan paragraf dengan satu baris kosong.</small></label>
          </div>
          <div class="fieldset">
            <h3>Harga & stok</h3>
            <div class="grid-2">
              <label class="field"><span>Harga jual</span><div class="input-prefix"><span>Rp</span><input name="price" type="number" min="0" step="1" value="${p?.price ?? ''}" required></div></label>
              <label class="field"><span>Harga coret</span><div class="input-prefix"><span>Rp</span><input name="oldPrice" type="number" min="0" step="1" value="${p?.oldPrice ?? ''}"></div><small>Opsional. Diskon dihitung otomatis.</small></label>
              <label class="field"><span>Stok</span><input name="stock" type="number" min="0" step="1" value="${p?.stock ?? 0}" required></label>
              <label class="field"><span>Jumlah terjual</span><input name="sold" type="number" min="0" step="1" value="${p?.sold ?? 0}"><small>Diisi manual sampai modul pesanan aktif.</small></label>
            </div>
          </div>
          <div class="fieldset">
            <h3>Galeri</h3>
            <p class="hint muted">Maksimal 6 file (gambar, dan 1 video). Gambar pertama jadi gambar utama di kartu produk. JPG, PNG, WebP, GIF, AVIF hingga ${ctx.meta.limits.imageMB} MB; video MP4/WebM hingga ${ctx.meta.limits.videoMB} MB.</p>
            <div class="field" data-field="media"><div class="media-grid" id="media-host"></div></div>
          </div>
          <div class="fieldset">
            <h3>Persyaratan sistem</h3>
            <p class="hint muted">Opsional. Bagian ini disembunyikan di Marketplace bila kosong.</p>
            ${['min', 'rec'].map((kind) => html`
              <div class="field"><span>${kind === 'min' ? 'Minimum' : 'Disarankan'}</span>
                <div class="spec-rows" data-spec-list="${kind}">${(p?.specs[kind] ?? []).map((r, i) => specRowHTML(kind, i, r))}</div>
                <div><button type="button" class="btn btn--sm" data-spec-add="${kind}">${icon('plus')}Tambah baris</button></div>
              </div>`)}
            <label class="field"><span>Sumber (opsional)</span><input name="source" value="${p?.specs.source ?? ''}" maxlength="120" placeholder="Sumber: Steam"></label>
          </div>
          <div class="fieldset">
            <h3>Status</h3>
            <label class="switch"><input type="checkbox" name="active" ${p ? (p.active ? 'checked' : '') : 'checked'}><i></i><span>Tampilkan di Marketplace</span></label>
          </div>`,
        foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--primary">${p ? 'Simpan perubahan' : 'Tambah produk'}</button>`,
      });
      const f = d.form;
      let steam = null;
      const media = mediaManager($('#media-host', f), { max: 6, folder: 'products', video: true, limits: ctx.meta.limits, initial: p?.media ?? [], showMain: true, addLabel: 'Tambah media', onChange: () => steam?.onMediaChange() });

      const count = () => { $('#desc-count', f).textContent = `${f.elements.description.value.length}/300`; };
      f.elements.description.addEventListener('input', count); count();

      f.addEventListener('click', (e) => {
        const add = e.target.closest('[data-spec-add]');
        if (add) {
          const list = $(`[data-spec-list="${add.dataset.specAdd}"]`, f);
          list.insertAdjacentHTML('beforeend', specRowHTML(add.dataset.specAdd, list.children.length).s);
          list.lastElementChild.querySelector('input').focus();
        }
        const rm = e.target.closest('[data-spec-rm]');
        if (rm) rm.closest('[data-spec-row]').remove();
      });

      const readSpecs = (kind) => $$(`[data-spec-list="${kind}"] [data-spec-row]`, f)
        .map((row) => { const [a, b] = $$('input', row); return { label: a.value.trim(), value: b.value.trim() }; })
        .filter((r) => r.label || r.value);

      const setSpecRows = (kind, rows) => { $(`[data-spec-list="${kind}"]`, f).innerHTML = rows.map((r, i) => specRowHTML(kind, i, r).s).join(''); };
      if (!p) steam = initSteam(f, { media, setSpecRows, readSpecs, onCount: count });

      f.addEventListener('submit', async () => {
        const btn = $('button[type="submit"]', f);
        if (media.busy() || steam?.pending()) { toast('Tunggu upload selesai', { type: 'error', detail: steam?.pending() ? 'Trailer Steam masih diunduh.' : '' }); return; }
        const el = f.elements;
        const num = (name) => (el[name].value === '' ? NaN : Number(el[name].value));
        const body = {
          name: el.name.value, category: el.category.value,
          price: num('price'), oldPrice: el.oldPrice.value === '' ? null : Number(el.oldPrice.value),
          stock: num('stock'), sold: el.sold.value === '' ? 0 : Number(el.sold.value),
          active: el.active.checked, description: el.description.value, about: el.about.value,
          specs: { min: readSpecs('min'), rec: readSpecs('rec'), source: el.source.value },
          media: media.get(),
        };
        try {
          const res = await busy(btn, () => (p ? api.put(`/products/${p.id}`, body) : api.post('/products', body)));
          d.close();
          toast(p ? 'Produk disimpan' : 'Produk ditambahkan', { detail: res.item.active ? 'Marketplace sudah menerima pembaruan.' : 'Produk nonaktif, tidak tampil di Marketplace.' });
          load();
        } catch (err) {
          const msgs = Object.values(err.fields);
          if (!fieldErrors(f, err.fields)) toast(err.message, { type: 'error', detail: msgs[0] || '' });
          else if (msgs.length > 1) toast('Periksa kembali isian formulir', { type: 'error', detail: `${msgs.length} kolom perlu diperbaiki.` });
        }
      });
      $('input[name="name"]', f).focus();
    }

    // Tautan dari Dashboard: #/products?edit=<id>
    const editId = new URLSearchParams(location.hash.split('?')[1] || '').get('edit');
    await load();
    if (editId) {
      try { openForm((await api.get(`/products/${editId}`)).item); } catch { /* produk sudah tidak ada */ }
      history.replaceState(null, '', '#/products');
    }

    return {
      destroy() { alive = false; loadDebounced.cancel(); },
      onLive(evt) {
        if (/^(product|category):/.test(evt) || evt === 'resync') {
          if (/^category:/.test(evt) || evt === 'resync') api.get('/categories').then((r) => { categories = r.items; }).catch(() => {});
          loadDebounced();
        }
      },
    };
  },
};
