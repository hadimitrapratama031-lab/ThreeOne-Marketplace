import { $, html, mount, icon, bytes, dateTime, pagerHTML, emptyState, debounce, toast, toastError, confirmDialog } from '../ui.js';
import { api } from '../api.js';

const FOLDERS = { products: 'Produk', reviews: 'Ulasan', hero: 'Hero', branding: 'Branding', contacts: 'Ikon kontak' };
const OWNERS = { product: 'Produk', review: 'Ulasan', settings: 'Pengaturan' };

export default {
  async mount(root, ctx) {
    const q = { page: 1, limit: 24, status: '', kind: '', folder: '' };
    let alive = true;
    let reqId = 0;

    mount(root, html`
      <div class="page-head"><div><h2>Aset gambar</h2><p>Semua file yang tersimpan di Cloudflare R2. File yang tidak dipakai (upload yang tidak jadi disimpan) dibersihkan otomatis setelah 6 jam.</p></div></div>
      ${ctx.meta.r2Ready ? '' : html`<div class="form-error" style="margin-bottom:16px">Cloudflare R2 belum dikonfigurasi di server. Upload gambar tidak akan berfungsi sampai variabel R2_* diisi.</div>`}
      <section class="card" id="errors-card" hidden style="margin-bottom:16px">
        <div class="card__head"><h3>Gambar gagal dimuat di Marketplace</h3><button class="btn btn--sm" type="button" id="clear-errors">Bersihkan daftar</button></div>
        <div class="card__body"><div class="list" id="errors"></div></div>
      </section>
      <section class="card">
        <div class="toolbar">
          <select id="f-status" aria-label="Filter pemakaian"><option value="">Semua file</option><option value="used">Dipakai</option><option value="unused">Tidak dipakai</option></select>
          <select id="f-folder" aria-label="Filter folder"><option value="">Semua folder</option>${Object.entries(FOLDERS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
          <select id="f-kind" aria-label="Filter jenis"><option value="">Gambar & video</option><option value="image">Gambar</option><option value="video">Video</option></select>
        </div>
        <div id="grid"></div><div id="pager"></div>
      </section>`);

    async function load() {
      const id = ++reqId;
      try {
        const res = await api.get('/media', q);
        if (!alive || id !== reqId) return;
        if (!res.items.length && q.page > 1) { q.page = res.totalPages; return load(); }
        $('#grid', root).innerHTML = (res.items.length ? html`<div class="asset-grid">${res.items.map((a) => html`
          <article class="asset">
            ${a.kind === 'video' ? html`<video class="thumb-lg" src="${a.url}" muted preload="metadata"></video>` : html`<img class="thumb-lg" src="${a.url}" alt="" loading="lazy">`}
            <div class="asset__meta">
              <span class="pill ${a.status === 'used' ? 'pill--ok' : 'pill--warn'}">${a.status === 'used' ? `Dipakai · ${OWNERS[a.owner?.type] || 'data'}` : 'Tidak dipakai'}</span>
              <span>${FOLDERS[a.folder] || a.folder} · ${bytes(a.size)}</span>
              <div class="asset__foot"><small>${dateTime(a.createdAt)}</small>
                <span>
                  <a class="icon-btn" href="${a.url}" target="_blank" rel="noopener" aria-label="Buka file">${icon('external')}</a>
                  <button class="icon-btn danger" type="button" data-del="${a.id}" ${a.status === 'used' ? 'disabled title="Sedang dipakai"' : ''} aria-label="Hapus file">${icon('trash')}</button>
                </span>
              </div>
            </div>
          </article>`)}</div>` : emptyState('Belum ada file', 'File akan muncul di sini setelah diunggah dari form produk, ulasan, hero, atau pengaturan.', 'image')).s;
        $('#pager', root).innerHTML = pagerHTML(res).s;
      } catch (err) { if (alive) toastError(err, 'Aset gagal dimuat'); }
    }

    async function loadErrors() {
      try {
        const { items } = await api.get('/media/errors');
        if (!alive) return;
        $('#errors-card', root).hidden = !items.length;
        mount($('#errors', root), items.map((e) => html`<div class="list__row"><div class="list__main"><b>${e.url}</b><small>Halaman ${e.page || '—'} · ${e.count}× · ${dateTime(e.lastAt)}</small></div><a class="btn btn--sm" href="${e.url}" target="_blank" rel="noopener">Buka</a></div>`));
      } catch { /* abaikan */ }
    }

    for (const [id, key] of [['f-status', 'status'], ['f-folder', 'folder'], ['f-kind', 'kind']]) {
      $('#' + id, root).addEventListener('change', (e) => { q[key] = e.target.value; q.page = 1; load(); });
    }
    root.addEventListener('click', async (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { q.page = +pg.dataset.page; return load(); }
      if (e.target.closest('#clear-errors')) { await api.del('/media/errors'); loadErrors(); return; }
      const del = e.target.closest('[data-del]');
      if (del && !del.disabled) {
        if (!(await confirmDialog({ title: 'Hapus file?', message: 'File akan dihapus permanen dari Cloudflare R2.', confirmLabel: 'Hapus', danger: true }))) return;
        try { await api.del(`/media/${del.dataset.del}`); toast('File dihapus'); load(); } catch (err) { toastError(err); }
      }
    });

    await Promise.all([load(), loadErrors()]);
    const reload = debounce(() => { load(); loadErrors(); }, 500);
    return {
      destroy() { alive = false; reload.cancel(); },
      onLive(evt) { if (evt === 'media:error' || evt === 'resync' || /^(product|review|hero|settings):/.test(evt)) reload(); },
    };
  },
};
