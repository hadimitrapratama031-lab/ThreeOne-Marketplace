import { $, html, mount, icon, dateShort, starsHTML, pagerHTML, emptyState, skeletonRows, debounce, toast, toastError, dialog, confirmDialog, busy, fieldErrors } from '../ui.js';
import { api } from '../api.js';
import { mediaManager } from './_media.js';

const SORTS = [['newest', 'Terbaru'], ['oldest', 'Terlama'], ['stars_desc', 'Rating tertinggi'], ['stars_asc', 'Rating terendah']];
const inputDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));

export default {
  async mount(root, ctx) {
    const q = { page: 1, limit: 25, q: '', productId: '', stars: '', status: '', sort: 'newest' };
    let alive = true;
    let reqId = 0;
    let products = (await api.get('/products', { limit: 100, sort: 'name' })).items;

    mount(root, html`
      <div class="page-head">
        <div><h2>Rating & ulasan</h2><p>Sembunyikan ulasan yang tidak pantas atau tambahkan testimoni. Hanya ulasan berstatus “Tampil” yang muncul di halaman produk dan masuk hitungan rating.</p></div>
        <div class="actions"><button class="btn btn--primary" type="button" data-add>${icon('plus')}Tambah ulasan</button></div>
      </div>
      <section class="card">
        <div class="toolbar">
          <label class="search"><span class="sr-only">Cari ulasan</span>${icon('search')}<input id="f-q" type="search" placeholder="Cari nama atau isi ulasan" autocomplete="off"></label>
          <select id="f-product" aria-label="Filter produk"><option value="">Semua produk</option>${products.map((p) => html`<option value="${p.productId}">${p.name}</option>`)}</select>
          <select id="f-stars" aria-label="Filter rating"><option value="">Semua rating</option>${[5, 4, 3, 2, 1].map((n) => html`<option value="${n}">${n} bintang</option>`)}</select>
          <select id="f-status" aria-label="Filter status"><option value="">Semua status</option><option value="published">Tampil</option><option value="hidden">Disembunyikan</option></select>
          <select id="f-sort" aria-label="Urutkan">${SORTS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
        </div>
        <div class="table-wrap" id="table">${skeletonRows(7)}</div>
        <div id="pager"></div>
      </section>`);

    async function load() {
      const id = ++reqId;
      try {
        const res = await api.get('/reviews', q);
        if (!alive || id !== reqId) return;
        if (!res.items.length && q.page > 1) { q.page = res.totalPages; return load(); }
        const filtered = q.q || q.productId || q.stars || q.status;
        $('#table', root).innerHTML = (res.items.length ? html`
          <table>
            <thead><tr><th>Pelanggan</th><th>Produk</th><th>Rating</th><th>Ulasan</th><th>Tanggal</th><th>Tampil</th><th></th></tr></thead>
            <tbody>${res.items.map((r) => html`
              <tr>
                <td><div class="cell-product"><span class="avatar" aria-hidden="true">${(r.name[0] || '?').toUpperCase()}</span><b>${r.name}</b></div></td>
                <td>${r.productName}<br><small class="faint">ID ${r.productId}</small></td>
                <td>${starsHTML(r.stars)}</td>
                <td style="max-width:340px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.text}</div>${r.images.length ? html`<small class="faint">${r.images.length} foto</small>` : ''}</td>
                <td class="muted">${dateShort(r.date)}</td>
                <td><label class="switch"><input type="checkbox" data-toggle="${r.id}" ${r.status === 'published' ? 'checked' : ''} aria-label="Tampilkan ulasan ${r.name}"><i></i></label></td>
                <td><div class="row-actions"><button class="icon-btn" type="button" data-edit="${r.id}" aria-label="Ubah ulasan">${icon('edit')}</button><button class="icon-btn danger" type="button" data-del="${r.id}" aria-label="Hapus ulasan">${icon('trash')}</button></div></td>
              </tr>`)}</tbody>
          </table>` : emptyState(filtered ? 'Tidak ada ulasan yang cocok' : 'Belum ada ulasan', filtered ? 'Ubah kata kunci atau filter.' : 'Klik “Tambah ulasan” untuk memasukkan testimoni.', 'star')).s;
        $('#pager', root).innerHTML = pagerHTML(res).s;
        root.__items = new Map(res.items.map((r) => [r.id, r]));
      } catch (err) { if (alive) toastError(err, 'Ulasan gagal dimuat'); }
    }
    const loadDebounced = debounce(load, 300);

    $('#f-q', root).addEventListener('input', (e) => { q.q = e.target.value.trim(); q.page = 1; loadDebounced(); });
    for (const [id, key] of [['f-product', 'productId'], ['f-stars', 'stars'], ['f-status', 'status'], ['f-sort', 'sort']]) {
      $('#' + id, root).addEventListener('change', (e) => { q[key] = e.target.value; q.page = 1; load(); });
    }
    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-add]')) return openForm();
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { q.page = +pg.dataset.page; return load(); }
      const edit = e.target.closest('[data-edit]');
      if (edit) return openForm(root.__items.get(edit.dataset.edit));
      const del = e.target.closest('[data-del]');
      if (del) {
        const r = root.__items.get(del.dataset.del);
        if (!(await confirmDialog({ title: 'Hapus ulasan?', message: `Ulasan dari ${r.name} akan dihapus permanen${r.images.length ? ` beserta ${r.images.length} fotonya` : ''}. Untuk sekadar menyembunyikan, matikan saklar “Tampil”.`, confirmLabel: 'Hapus', danger: true }))) return;
        try { await api.del(`/reviews/${r.id}`); toast('Ulasan dihapus'); load(); } catch (err) { toastError(err); }
      }
    });
    root.addEventListener('change', async (e) => {
      const box = e.target.closest('[data-toggle]');
      if (!box) return;
      try { await api.patch(`/reviews/${box.dataset.toggle}/status`, { active: box.checked }); toast(box.checked ? 'Ulasan ditampilkan' : 'Ulasan disembunyikan'); load(); }
      catch (err) { box.checked = !box.checked; toastError(err); }
    });

    function openForm(r) {
      const opts = [...products];
      if (r && !opts.some((p) => p.productId === r.productId)) opts.unshift({ productId: r.productId, name: r.productName });
      const d = dialog({
        kind: 'modal',
        title: r ? 'Ubah ulasan' : 'Tambah ulasan',
        body: html`
          <label class="field"><span>Produk</span><select name="productId">${opts.map((p) => html`<option value="${p.productId}" ${(r?.productId ?? opts[0]?.productId) === p.productId ? 'selected' : ''}>${p.name}</option>`)}</select></label>
          <div class="grid-2">
            <label class="field"><span>Nama pelanggan</span><input name="name" value="${r?.name ?? ''}" maxlength="60" required></label>
            <label class="field"><span>Rating</span><select name="stars">${[5, 4, 3, 2, 1].map((n) => html`<option value="${n}" ${(r?.stars ?? 5) === n ? 'selected' : ''}>${n} bintang</option>`)}</select></label>
          </div>
          <label class="field"><span>Ulasan</span><textarea name="text" rows="4" maxlength="1000" required>${r?.text ?? ''}</textarea></label>
          <div class="grid-2">
            <label class="field"><span>Tanggal</span><input name="date" type="date" value="${inputDate(r?.date)}"></label>
            <label class="field"><span>Status</span><select name="status"><option value="published" ${r?.status !== 'hidden' ? 'selected' : ''}>Tampil</option><option value="hidden" ${r?.status === 'hidden' ? 'selected' : ''}>Disembunyikan</option></select></label>
          </div>
          <div class="field" data-field="images"><span>Foto (maks. 3)</span><div class="media-grid" id="media-host"></div></div>`,
        foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--primary">Simpan</button>`,
      });
      const f = d.form;
      const media = mediaManager($('#media-host', f), { max: 3, folder: 'reviews', limits: ctx.meta.limits, initial: (r?.images ?? []).map((i) => ({ ...i, type: 'image' })), addLabel: 'Tambah foto' });
      f.addEventListener('submit', async () => {
        if (media.busy()) { toast('Tunggu upload selesai', { type: 'error' }); return; }
        const el = f.elements;
        const body = { productId: Number(el.productId.value), name: el.name.value, stars: Number(el.stars.value), text: el.text.value, date: el.date.value || undefined, status: el.status.value, images: media.get() };
        try {
          await busy($('button[type="submit"]', f), () => (r ? api.put(`/reviews/${r.id}`, body) : api.post('/reviews', body)));
          d.close(); toast(r ? 'Ulasan disimpan' : 'Ulasan ditambahkan', { detail: body.status === 'published' ? 'Muncul di halaman produk.' : 'Disembunyikan dari Marketplace.' }); load();
        } catch (err) { if (!fieldErrors(f, err.fields)) toastError(err); }
      });
      $('input[name="name"]', f).focus();
    }

    await load();
    return {
      destroy() { alive = false; loadDebounced.cancel(); },
      onLive(evt) { if (/^(review|product):/.test(evt) || evt === 'resync') loadDebounced(); },
    };
  },
};
