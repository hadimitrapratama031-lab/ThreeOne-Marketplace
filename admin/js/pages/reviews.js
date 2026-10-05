import { $, html, mount, icon, dateShort, starsHTML, pagerHTML, emptyState, skeletonRows, debounce, toast, toastError, confirmDialog } from '../ui.js';
import { api } from '../api.js';

const SORTS = [['newest', 'Terbaru'], ['oldest', 'Terlama'], ['stars_desc', 'Rating tertinggi'], ['stars_asc', 'Rating terendah']];

/**
 * Rating & ulasan: admin melihat semua ulasan yang masuk dari Marketplace dan dapat menghapusnya.
 * Tidak ada persetujuan: ulasan pelanggan langsung tampil di Marketplace. Daftar ikut berubah realtime
 * (Socket.IO) saat ulasan baru masuk atau dihapus.
 */
export default {
  async mount(root) {
    const q = { page: 1, limit: 25, q: '', productId: '', stars: '', sort: 'newest' };
    let alive = true;
    let reqId = 0;
    const products = (await api.get('/products', { limit: 100, sort: 'name' })).items;

    mount(root, html`
      <div class="page-head">
        <div><h2>Rating & ulasan</h2><p>Semua ulasan dari pelanggan. Ulasan langsung tampil di Marketplace tanpa menunggu persetujuan; hapus hanya ulasan yang tidak pantas.</p></div>
      </div>
      <section class="card">
        <div class="toolbar">
          <label class="search"><span class="sr-only">Cari ulasan</span>${icon('search')}<input id="f-q" type="search" placeholder="Cari nama atau isi ulasan" autocomplete="off"></label>
          <select id="f-product" aria-label="Filter produk"><option value="">Semua produk</option>${products.map((p) => html`<option value="${p.productId}">${p.name}</option>`)}</select>
          <select id="f-stars" aria-label="Filter rating"><option value="">Semua rating</option>${[5, 4, 3, 2, 1].map((n) => html`<option value="${n}">${n} bintang</option>`)}</select>
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
        const filtered = q.q || q.productId || q.stars;
        $('#table', root).innerHTML = (res.items.length ? html`
          <table>
            <thead><tr><th>Pelanggan</th><th>Produk</th><th>Rating</th><th>Ulasan</th><th>Foto</th><th>Tanggal</th><th></th></tr></thead>
            <tbody>${res.items.map((r) => html`
              <tr>
                <td><div class="cell-product"><span class="avatar" aria-hidden="true">${(r.name[0] || '?').toUpperCase()}</span><b>${r.name}</b></div></td>
                <td>${r.productName}<br><small class="faint">ID ${r.productId}</small></td>
                <td>${starsHTML(r.stars)}</td>
                <td style="max-width:340px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.text}">${r.text}</div>${r.status === 'hidden' ? html`<small class="faint">Disembunyikan dari Marketplace</small>` : ''}</td>
                <td>${r.images.length ? html`<div class="rv-thumbs">${r.images.map((i, n) => html`<a href="${i.url}" target="_blank" rel="noopener" aria-label="Buka foto ${n + 1} dari ${r.name}"><img src="${i.url}" alt="" loading="lazy" width="36" height="36"></a>`)}</div>` : html`<span class="faint">—</span>`}</td>
                <td class="muted">${dateShort(r.date)}</td>
                <td><div class="row-actions"><button class="icon-btn danger" type="button" data-del="${r.id}" aria-label="Hapus ulasan dari ${r.name}">${icon('trash')}</button></div></td>
              </tr>`)}</tbody>
          </table>` : emptyState(filtered ? 'Tidak ada ulasan yang cocok' : 'Belum ada ulasan', filtered ? 'Ubah kata kunci atau filter.' : 'Ulasan dari pelanggan akan muncul di sini begitu dikirim dari Marketplace.', 'star')).s;
        $('#pager', root).innerHTML = pagerHTML(res).s;
        root.__items = new Map(res.items.map((r) => [r.id, r]));
      } catch (err) { if (alive) toastError(err, 'Ulasan gagal dimuat'); }
    }
    const loadDebounced = debounce(load, 300);

    $('#f-q', root).addEventListener('input', (e) => { q.q = e.target.value.trim(); q.page = 1; loadDebounced(); });
    for (const [id, key] of [['f-product', 'productId'], ['f-stars', 'stars'], ['f-sort', 'sort']]) {
      $('#' + id, root).addEventListener('change', (e) => { q[key] = e.target.value; q.page = 1; load(); });
    }
    root.addEventListener('click', async (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { q.page = +pg.dataset.page; return load(); }
      const del = e.target.closest('[data-del]');
      if (!del) return;
      const r = root.__items.get(del.dataset.del);
      if (!r) return;
      if (!(await confirmDialog({
        title: 'Hapus ulasan?',
        message: `Ulasan dari ${r.name} akan dihapus permanen dari Marketplace${r.images.length ? ` beserta ${r.images.length} foto di penyimpanan` : ''}.`,
        confirmLabel: 'Hapus',
        danger: true,
      }))) return;
      try { await api.del(`/reviews/${r.id}`); toast('Ulasan dihapus'); load(); } catch (err) { toastError(err); }
    });

    await load();
    return {
      destroy() { alive = false; loadDebounced.cancel(); },
      onLive(evt) { if (/^(review|product):/.test(evt) || evt === 'resync') loadDebounced(); },
    };
  },
};
