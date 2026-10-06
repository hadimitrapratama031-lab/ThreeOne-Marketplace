import { $, $$, html, mount, icon, toast, toastError, busy, fieldErrors } from '../ui.js';
import { api } from '../api.js';
import { mediaManager } from './_media.js';

const PLATFORM_ICONS = { windows: 'Windows', steam: 'Steam', store: 'Logo toko' };

export default {
  async mount(root, ctx) {
    const { settings: s } = await api.get('/settings');

    const platformRow = (p = { icon: 'windows', label: '' }) => html`
      <div class="spec-row" data-platform style="grid-template-columns:150px 1fr auto">
        <select aria-label="Ikon">${Object.entries(PLATFORM_ICONS).map(([k, v]) => html`<option value="${k}" ${p.icon === k ? 'selected' : ''}>${v}</option>`)}</select>
        <input value="${p.label}" maxlength="24" placeholder="Nama platform" aria-label="Nama platform">
        <button type="button" class="icon-btn" data-rm-platform aria-label="Hapus">${icon('x')}</button>
      </div>`;

    mount(root, html`
      <div class="page-head"><div><h2>Pengaturan Marketplace</h2><p>Hanya pengaturan yang benar-benar dipakai Marketplace. Setiap kartu disimpan terpisah.</p></div></div>
      <div class="stack" style="max-width:820px">

        <form class="card" data-card="branding" novalidate>
          <div class="card__head"><h3>Brand</h3></div>
          <div class="card__body stack">
            <div class="grid-2">
              <label class="field"><span>Nama brand</span><input name="name" value="${s.branding.name}" maxlength="40" required><small>Tampil di header dan footer.</small></label>
              <label class="field"><span>Judul tab browser</span><input name="siteTitle" value="${s.branding.siteTitle}" maxlength="80" required></label>
            </div>
            <div class="field" data-field="logo"><span>Logo</span><small>Kosong = ikon bawaan. Tinggi logo ditampilkan 26 px.</small><div class="media-grid" style="grid-template-columns:160px"><div id="logo-host" style="display:contents"></div></div></div>
            <div class="actions"><button class="btn btn--primary" type="submit">Simpan brand</button></div>
          </div>
        </form>

        <form class="card" data-card="stats" novalidate>
          <div class="card__head"><h3>Statistik di beranda</h3></div>
          <div class="card__body stack">
            <p class="muted">“Total Produk” dihitung otomatis dari database. “Pelanggan” dan “Total Pesanan” juga dihitung otomatis dari pesanan yang sudah dibayar. Di sini hanya teks Support yang bisa diatur.</p>
            <div class="grid-3">
              <label class="field"><span>Pelanggan (otomatis)</span><input type="text" value="${Number(s.stats.customers || 0).toLocaleString('id-ID')}" disabled></label>
              <label class="field"><span>Total pesanan (otomatis)</span><input type="text" value="${Number(s.stats.orders || 0).toLocaleString('id-ID')}" disabled></label>
              <label class="field"><span>Support</span><input name="support" value="${s.stats.support}" maxlength="20" placeholder="24/7"></label>
            </div>
            <div class="actions"><button class="btn btn--primary" type="submit">Simpan statistik</button></div>
          </div>
        </form>

        <form class="card" data-card="sections" novalidate>
          <div class="card__head"><h3>Judul bagian halaman</h3></div>
          <div class="card__body stack">
            <div class="grid-2">
              <label class="field"><span>Judul produk</span><input name="productsTitle" value="${s.sections.products.title}" maxlength="80" required></label>
              <label class="field"><span>Judul FAQ</span><input name="faqTitle" value="${s.sections.faq.title}" maxlength="80" required></label>
            </div>
            <label class="field"><span>Keterangan produk</span><input name="productsSub" value="${s.sections.products.subtitle}" maxlength="200"></label>
            <label class="field"><span>Judul kontak</span><input name="contactTitle" value="${s.sections.contact.title}" maxlength="80" required></label>
            <label class="field"><span>Keterangan kontak</span><input name="contactSub" value="${s.sections.contact.subtitle}" maxlength="200"></label>
            <div class="actions"><button class="btn btn--primary" type="submit">Simpan judul</button></div>
          </div>
        </form>

        <form class="card" data-card="productPage" novalidate>
          <div class="card__head"><h3>Halaman detail produk</h3></div>
          <div class="card__body stack">
            <label class="field"><span>Catatan di “Tentang Produk”</span><textarea name="notes" rows="5" maxlength="2000">${s.productPage.notes.join('\n\n')}</textarea><small>Ditambahkan di bawah deskripsi setiap produk. Pisahkan paragraf dengan satu baris kosong (maks. 4).</small></label>
            <label class="field"><span>Pesanan selesai (otomatis)</span><input type="text" value="${Number(s.productPage.completedOrders || 0).toLocaleString('id-ID')}" disabled><small>Dihitung dari pesanan yang sudah dibayar. Ditampilkan sebagai “N+ pesanan selesai”; tersembunyi bila 0.</small></label>
            <div class="field"><span>Strip platform & toko</span>
              <div class="spec-rows" id="platforms">${s.productPage.platforms.map(platformRow)}</div>
              <div><button type="button" class="btn btn--sm" id="add-platform">${icon('plus')}Tambah platform</button></div>
            </div>
            <div class="actions"><button class="btn btn--primary" type="submit">Simpan halaman produk</button></div>
          </div>
        </form>
      </div>`);

    const logo = mediaManager($('#logo-host', root), { max: 1, folder: 'branding', limits: ctx.meta.limits, initial: s.branding.logo ? [{ ...s.branding.logo, type: 'image' }] : [], addLabel: 'Unggah logo' });

    root.addEventListener('click', (e) => {
      if (e.target.closest('#add-platform')) {
        const box = $('#platforms', root);
        if (box.children.length >= 6) return toast('Maksimal 6 platform', { type: 'error' });
        box.insertAdjacentHTML('beforeend', platformRow().s);
        box.lastElementChild.querySelector('input').focus();
      }
      const rm = e.target.closest('[data-rm-platform]');
      if (rm) rm.closest('[data-platform]').remove();
    });

    const BODIES = {
      branding: (f) => ({ name: f.name.value, siteTitle: f.siteTitle.value, logo: logo.get()[0] ?? null }),
      stats: (f) => ({ support: f.support.value }),
      sections: (f) => ({
        products: { title: f.productsTitle.value, subtitle: f.productsSub.value },
        faq: { title: f.faqTitle.value },
        contact: { title: f.contactTitle.value, subtitle: f.contactSub.value },
      }),
      productPage: (f) => ({
        notes: f.notes.value.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean),
        platforms: $$('[data-platform]', root).map((r) => ({ icon: $('select', r).value, label: $('input', r).value.trim() })).filter((p) => p.label),
      }),
    };
    const FIELD_MAP = { 'sections.products.title': 'productsTitle', 'sections.faq.title': 'faqTitle', 'sections.contact.title': 'contactTitle', 'products.title': 'productsTitle', 'faq.title': 'faqTitle', 'contact.title': 'contactTitle' };

    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target.closest('form[data-card]');
      if (!form) return;
      const key = form.dataset.card;
      if (key === 'branding' && logo.busy()) return toast('Tunggu upload selesai', { type: 'error' });
      try {
        await busy($('button[type="submit"]', form), () => api.put(`/settings/${key}`, BODIES[key](form.elements)));
        toast('Pengaturan disimpan', { detail: 'Marketplace sudah menerima pembaruan.' });
      } catch (err) {
        const fields = Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [FIELD_MAP[k] || k, v]));
        if (!fieldErrors(form, fields)) toast(err.message, { type: 'error', detail: Object.values(err.fields)[0] || '' });
      }
    });
    return { destroy() {}, onLive() {} };
  },
};
