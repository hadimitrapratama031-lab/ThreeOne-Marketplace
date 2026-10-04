import { html, icon, num, toast, toastError, dialog, confirmDialog, busy, $ } from '../ui.js';
import { api } from '../api.js';
import { listPage } from './_list.js';

export default listPage({
  endpoint: '/categories',
  liveMatch: /^(category|product):/,
  heading: 'Kategori produk',
  description: 'Kategori menentukan pengelompokan dan filter di Marketplace. Kategori yang dinonaktifkan menyembunyikan seluruh produknya.',
  addLabel: 'Tambah kategori',
  editTitle: 'Ubah kategori',
  addedMessage: 'Kategori ditambahkan',
  emptyTitle: 'Belum ada kategori',
  emptyText: 'Buat kategori dulu sebelum menambahkan produk.',
  emptyIcon: 'tag',
  rowMain: (c) => html`<b>${c.name}</b><p>${num(c.productCount)} produk</p>`,
  fields: (c) => html`<label class="field"><span>Nama kategori</span><input name="name" value="${c?.name ?? ''}" maxlength="40" required></label>`,
  read: (form) => ({ name: form.elements.name.value }),
  async remove(cat, items, reload) {
    if (!cat.productCount) {
      const ok = await confirmDialog({ title: 'Hapus kategori?', message: `Kategori “${cat.name}” akan dihapus.`, confirmLabel: 'Hapus', danger: true });
      if (!ok) return;
      try { await api.del(`/categories/${cat.id}`); toast('Kategori dihapus'); reload(); } catch (err) { toastError(err); }
      return;
    }
    const others = items.filter((c) => c.id !== cat.id);
    if (!others.length) { toast('Tidak bisa dihapus', { type: 'error', detail: 'Kategori ini satu-satunya dan masih punya produk.' }); return; }
    const d = dialog({
      title: 'Hapus kategori',
      body: html`<p>“${cat.name}” masih dipakai ${num(cat.productCount)} produk. Pindahkan produk tersebut ke kategori lain sebelum menghapus.</p>
        <label class="field"><span>Pindahkan produk ke</span><select name="moveTo">${others.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></label>`,
      foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--danger-solid">Pindahkan & hapus</button>`,
    });
    d.form.addEventListener('submit', async () => {
      try {
        await busy($('button[type="submit"]', d.form), () => api.del(`/categories/${cat.id}`, { moveTo: d.form.elements.moveTo.value }));
        d.close(); toast('Kategori dihapus', { detail: 'Produknya sudah dipindahkan.' }); reload();
      } catch (err) { toastError(err); }
    });
  },
});
