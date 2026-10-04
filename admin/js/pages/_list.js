/* Halaman daftar berurutan (kategori, FAQ, kontak): tambah, ubah, hapus, aktif/nonaktif, urutkan. */
import { $, $$, html, mount, icon, debounce, toast, toastError, dialog, confirmDialog, busy, fieldErrors, emptyState } from '../ui.js';
import { api } from '../api.js';

export function listPage(cfg) {
  return {
    async mount(root) {
      let items = [];
      let alive = true;

      mount(root, html`
        <div class="page-head">
          <div><h2>${cfg.heading}</h2><p>${cfg.description}</p></div>
          <div class="actions"><button class="btn btn--primary" type="button" data-add>${icon('plus')}${cfg.addLabel}</button></div>
        </div>
        <section class="card"><div class="rows" id="rows"><div class="row"><i class="skel" style="width:40%"></i></div></div></section>`);

      const rowsEl = $('#rows', root);

      function render() {
        if (!items.length) { mount(rowsEl, emptyState(cfg.emptyTitle, cfg.emptyText, cfg.emptyIcon || 'box')); return; }
        mount(rowsEl, items.map((it, i) => html`
          <div class="row ${it.active ? '' : 'is-off'}" data-id="${it.id}">
            <div class="order-btns">
              <button class="icon-btn" type="button" data-up="${it.id}" ${i === 0 ? 'disabled' : ''} aria-label="Naikkan urutan">${icon('up')}</button>
              <button class="icon-btn" type="button" data-down="${it.id}" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Turunkan urutan">${icon('down')}</button>
            </div>
            ${cfg.rowIcon ? html`<span class="row__icon">${cfg.rowIcon(it)}</span>` : ''}
            <div class="row__main">${cfg.rowMain(it)}</div>
            <label class="switch" title="${it.active ? 'Tampil di Marketplace' : 'Disembunyikan'}"><input type="checkbox" data-toggle="${it.id}" ${it.active ? 'checked' : ''} aria-label="Tampilkan di Marketplace"><i></i></label>
            <button class="icon-btn" type="button" data-edit="${it.id}" aria-label="Ubah">${icon('edit')}</button>
            <button class="icon-btn danger" type="button" data-del="${it.id}" aria-label="Hapus">${icon('trash')}</button>
          </div>`));
      }

      async function load() {
        try { items = (await api.get(cfg.endpoint)).items; if (alive) render(); }
        catch (err) { if (alive) toastError(err, 'Data gagal dimuat'); }
      }

      async function openForm(item) {
        const d = dialog({
          title: item ? cfg.editTitle : cfg.addLabel,
          body: cfg.fields(item),
          foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--primary">Simpan</button>`,
        });
        d.form.addEventListener('submit', async () => {
          const btn = $('button[type="submit"]', d.form);
          // Status tampil/sembunyi dipertahankan saat mengubah isi (diubah lewat saklar di daftar)
          const body = { ...cfg.read(d.form), active: item ? item.active : true };
          try {
            await busy(btn, () => (item ? api.put(`${cfg.endpoint}/${item.id}`, body) : api.post(cfg.endpoint, body)));
            d.close();
            toast(item ? 'Perubahan disimpan' : cfg.addedMessage, { detail: 'Marketplace sudah menerima pembaruan.' });
            load();
          } catch (err) {
            if (!fieldErrors(d.form, err.fields)) toastError(err);
          }
        });
        $('input, textarea, select', d.form)?.focus();
      }

      async function move(id, dir) {
        const i = items.findIndex((x) => x.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= items.length) return;
        const next = [...items];
        [next[i], next[j]] = [next[j], next[i]];
        const prev = items;
        items = next; render();
        try { items = (await api.put(`${cfg.endpoint}/reorder`, { ids: next.map((x) => x.id) })).items; render(); }
        catch (err) { items = prev; render(); toastError(err, 'Urutan gagal disimpan'); }
      }

      async function remove(item) {
        if (cfg.remove) { await cfg.remove(item, items, load); return; }
        const ok = await confirmDialog({ title: cfg.deleteTitle, message: cfg.deleteMessage(item), confirmLabel: 'Hapus', danger: true });
        if (!ok) return;
        try { await api.del(`${cfg.endpoint}/${item.id}`); toast('Dihapus'); load(); }
        catch (err) { toastError(err, 'Gagal menghapus'); }
      }

      root.addEventListener('click', (e) => {
        const find = (attr) => { const el = e.target.closest(`[${attr}]`); return el && items.find((x) => x.id === el.getAttribute(attr)); };
        if (e.target.closest('[data-add]')) return openForm();
        const edit = find('data-edit'); if (edit) return openForm(edit);
        const del = find('data-del'); if (del) return remove(del);
        const up = e.target.closest('[data-up]'); if (up) return move(up.dataset.up, -1);
        const down = e.target.closest('[data-down]'); if (down) return move(down.dataset.down, 1);
      });
      root.addEventListener('change', async (e) => {
        const box = e.target.closest('[data-toggle]');
        if (!box) return;
        try { await api.patch(`${cfg.endpoint}/${box.dataset.toggle}/status`, { active: box.checked }); toast(box.checked ? 'Ditampilkan di Marketplace' : 'Disembunyikan dari Marketplace'); load(); }
        catch (err) { box.checked = !box.checked; toastError(err); }
      });

      await load();
      const reload = debounce(load, 300);
      return {
        destroy() { alive = false; reload.cancel(); },
        onLive(evt) { if (evt === 'resync' || cfg.liveMatch.test(evt)) reload(); },
      };
    },
  };
}
