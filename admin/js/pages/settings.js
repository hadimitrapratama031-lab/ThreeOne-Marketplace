import { $, $$, html, mount, icon, toast, toastError, busy, fieldErrors, emptyState, raw, esc } from '../ui.js';
import { api } from '../api.js';
import { mediaManager } from './_media.js';

const PLATFORM_ICONS = { windows: 'Windows', steam: 'Steam', store: 'Logo toko' };

// Aturan file per bagian (server memeriksa ulang isi file, ukuran, dan format)
const IMG_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const IMG_FORMATS = 'JPG, PNG, WebP, GIF, atau AVIF';
const FAVICON_MIMES = ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/webp', 'image/jpeg', 'image/gif'];

// Kartu gambar -> field di setting `branding`. Tiap kartu hanya mengirim field miliknya, jadi tidak saling menimpa.
const MEDIA_CARDS = { storeLogo: 'logo', footerLogo: 'footerLogo', favicon: 'favicon' };
const TARGET = { brand: 'branding', storeLogo: 'branding', footerLogo: 'branding', favicon: 'branding' };
const SAVED = {
  brand: ['Identitas brand disimpan', 'Marketplace sudah menerima pembaruan.'],
  storeLogo: ['Store logo disimpan', 'Header Marketplace langsung memakai logo ini.'],
  footerLogo: ['Footer logo disimpan', 'Footer Marketplace langsung memakai logo ini.'],
  favicon: ['Favicon disimpan', 'Tab browser Marketplace berganti otomatis.'],
};

const mediaCard = ({ card, field, title, desc, hint, tile = 160 }) => html`
  <form class="card" data-card="${card}" novalidate>
    <div class="card__head"><h3>${title}</h3><small class="save-state" data-state></small></div>
    <div class="card__body stack">
      <div class="field" data-field="${field}"><span>${desc}</span><small>${hint}</small>
        <div class="media-grid media-grid--contain" style="grid-template-columns:${tile}px"><div data-media="${field}" style="display:contents"></div></div>
      </div>
      <div class="actions"><button class="btn btn--primary" type="submit">Simpan ${title.toLowerCase()}</button></div>
    </div>
  </form>`;

export default {
  async mount(root, ctx) {
    const { settings: s } = await api.get('/settings');
    // Daftar kontak untuk bagian "Ikon kontak". Bila gagal dimuat, bagian lain di halaman ini tetap berfungsi.
    let contacts = [];
    let contactsError = '';
    try { contacts = (await api.get('/contacts')).items; } catch (err) { contactsError = err.message || 'Daftar kontak gagal dimuat.'; }

    const platformRow = (p = { icon: 'windows', label: '' }) => html`
      <div class="spec-row" data-platform style="grid-template-columns:150px 1fr auto">
        <select aria-label="Ikon">${Object.entries(PLATFORM_ICONS).map(([k, v]) => html`<option value="${k}" ${p.icon === k ? 'selected' : ''}>${v}</option>`)}</select>
        <input value="${p.label}" maxlength="24" placeholder="Nama platform" aria-label="Nama platform">
        <button type="button" class="icon-btn" data-rm-platform aria-label="Hapus">${icon('x')}</button>
      </div>`;

    mount(root, html`
      <div class="page-head"><div><h2>Pengaturan Marketplace</h2><p>Logo, favicon, dan ikon kontak punya bagian sendiri. Setiap kartu disimpan terpisah dan langsung tampil di Marketplace.</p></div></div>
      <div class="stack" style="max-width:820px">

        <form class="card" data-card="brand" novalidate>
          <div class="card__head"><h3>Identitas brand</h3></div>
          <div class="card__body stack">
            <div class="grid-2">
              <label class="field"><span>Nama brand</span><input name="name" value="${s.branding.name}" maxlength="40" required><small>Tampil di header dan footer.</small></label>
              <label class="field"><span>Judul tab browser</span><input name="siteTitle" value="${s.branding.siteTitle}" maxlength="80" required></label>
            </div>
            <div class="actions"><button class="btn btn--primary" type="submit">Simpan identitas</button></div>
          </div>
        </form>

        ${mediaCard({ card: 'storeLogo', field: 'logo', title: 'Store logo', desc: 'Logo di header', hint: 'Kosong = ikon bawaan. Tinggi ditampilkan 26 px. JPG, PNG, WebP, GIF, atau AVIF. Footer juga memakainya selama Footer logo belum diatur.' })}

        ${mediaCard({ card: 'footerLogo', field: 'footerLogo', title: 'Footer logo', desc: 'Logo di footer', hint: 'Tampil di footer semua halaman. Kosong = footer memakai Store logo. Tinggi ditampilkan 26 px.' })}

        ${mediaCard({ card: 'favicon', field: 'favicon', title: 'Favicon', desc: 'Ikon tab browser', tile: 120, hint: 'PNG atau ICO persegi, minimal 32 × 32 px (disarankan 48 × 48 atau lebih). Maksimal 1 MB. Format lain yang bisa: WebP, JPG, GIF. SVG tidak didukung.' })}

        <section class="card" id="contact-icons">
          <div class="card__head"><h3>Ikon kontak</h3></div>
          <div class="card__body stack">
            <p class="muted">Setiap kontak di bagian “${s.sections.contact.title}” bisa memakai gambar sendiri. Hapus gambar lalu simpan untuk kembali ke ikon bawaan. Teks dan tautan kontak diatur di halaman Kontak.</p>
            ${contactsError ? html`<p role="alert" style="color:var(--danger)">${contactsError}</p>`
              : !contacts.length ? emptyState('Belum ada kontak', 'Tambahkan kontak di halaman Kontak, lalu atur ikonnya di sini.', 'chat')
              : html`<div class="contact-icons">${contacts.map((c) => html`
              <div class="contact-icon-row" data-contact="${c.id}">
                <div class="contact-icon-row__info">
                  <span class="row__icon">${raw(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${esc(c.iconPath)}"/></svg>`)}</span>
                  <div><b>${c.label}</b>${c.active ? '' : html` <span class="pill pill--mute">Disembunyikan</span>`}<p class="muted">${c.value}</p></div>
                </div>
                <div class="media-grid media-grid--contain" style="grid-template-columns:96px"><div data-icon-host style="display:contents"></div></div>
                <div class="contact-icon-row__save">
                  <small class="save-state" data-state>${c.iconImage ? 'Tersimpan' : 'Ikon bawaan'}</small>
                  <button class="btn btn--primary btn--sm" type="button" data-save-icon>Simpan ikon</button>
                </div>
              </div>`)}</div>`}
          </div>
        </section>

        <form class="card" data-card="stats" novalidate>
          <div class="card__head"><h3>Statistik di beranda</h3></div>
          <div class="card__body stack">
            <p class="muted">“Total Produk” dihitung otomatis dari database. “Pesanan Selesai” (jumlah terjual) dan “Rating” (rata-rata ulasan) juga dihitung otomatis dari database. Di sini hanya teks Support yang bisa diatur.</p>
            <div class="grid-3">
              <label class="field"><span>Rating (otomatis)</span><input type="text" value="${Number((+s.stats.rating || 0).toFixed(1))}/5 · ${Number(s.stats.ratingCount || 0).toLocaleString('id-ID')} ulasan" disabled></label>
              <label class="field"><span>Pesanan selesai (otomatis)</span><input type="text" value="${Number(s.stats.orders || 0).toLocaleString('id-ID')}" disabled></label>
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
            <label class="field"><span>Pesanan selesai (otomatis)</span><input type="text" value="${Number(s.productPage.completedOrders || 0).toLocaleString('id-ID')}" disabled><small>Sama dengan “Pesanan Selesai” di beranda (jumlah terjual dari database). Ditampilkan apa adanya sebagai “N pesanan selesai”; tersembunyi bila 0.</small></label>
            <div class="field"><span>Strip platform & toko</span>
              <div class="spec-rows" id="platforms">${s.productPage.platforms.map(platformRow)}</div>
              <div><button type="button" class="btn btn--sm" id="add-platform">${icon('plus')}Tambah platform</button></div>
            </div>
            <div class="actions"><button class="btn btn--primary" type="submit">Simpan halaman produk</button></div>
          </div>
        </form>
      </div>`);

    // ----- Gambar branding: Store logo, Footer logo, Favicon -----
    const setState = (form, text, dirty = false) => {
      const el = $('[data-state]', form);
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('is-dirty', dirty);
    };
    const media = {};
    for (const [card, field] of Object.entries(MEDIA_CARDS)) {
      const form = $(`form[data-card="${card}"]`, root);
      const isIco = field === 'favicon';
      media[card] = mediaManager($(`[data-media="${field}"]`, form), {
        max: 1, folder: 'branding', limits: ctx.meta.limits, replace: true,
        accept: isIco ? FAVICON_MIMES : IMG_MIMES,
        formats: isIco ? 'PNG, ICO, WebP, JPG, atau GIF' : IMG_FORMATS,
        maxMB: isIco ? 1 : null,
        addLabel: isIco ? 'Unggah favicon' : 'Unggah logo',
        initial: s.branding[field] ? [{ ...s.branding[field], type: 'image' }] : [],
        onChange: () => { fieldErrors(form, {}); setState(form, 'Perubahan belum disimpan', true); },
      });
      setState(form, s.branding[field] ? 'Tersimpan' : 'Belum diatur');
    }

    // ----- Ikon kontak: satu pengelola gambar per kontak, disimpan per kontak -----
    const iconMgrs = new Map();
    for (const row of $$('[data-contact]', root)) {
      const c = contacts.find((x) => x.id === row.dataset.contact);
      if (!c) continue;
      iconMgrs.set(c.id, mediaManager($('[data-icon-host]', row), {
        max: 1, folder: 'contacts', limits: ctx.meta.limits, replace: true,
        accept: IMG_MIMES, formats: IMG_FORMATS, maxMB: 2, addLabel: 'Unggah',
        initial: c.iconImage ? [{ ...c.iconImage, type: 'image' }] : [],
        onChange: () => setState(row, 'Perubahan belum disimpan', true),
      }));
    }

    root.addEventListener('click', (e) => {
      if (e.target.closest('#add-platform')) {
        const box = $('#platforms', root);
        if (box.children.length >= 6) return toast('Maksimal 6 platform', { type: 'error' });
        box.insertAdjacentHTML('beforeend', platformRow().s);
        box.lastElementChild.querySelector('input').focus();
      }
      const rm = e.target.closest('[data-rm-platform]');
      if (rm) rm.closest('[data-platform]').remove();

      const save = e.target.closest('[data-save-icon]');
      if (save) saveContactIcon(save);
    });

    async function saveContactIcon(btn) {
      const row = btn.closest('[data-contact]');
      const id = row.dataset.contact;
      const mgr = iconMgrs.get(id);
      const c = contacts.find((x) => x.id === id);
      if (!mgr || !c) return;
      if (mgr.busy()) return toast('Tunggu upload selesai', { type: 'error' });
      try {
        const { item } = await busy(btn, () => api.put(`/contacts/${id}/icon`, { iconImage: mgr.get()[0] ?? null }));
        Object.assign(c, item);
        setState(row, item.iconImage ? 'Tersimpan' : 'Ikon bawaan');
        toast('Ikon kontak disimpan', { detail: `${c.label} sudah diperbarui di Marketplace.` });
      } catch (err) {
        setState(row, 'Gagal menyimpan', true);
        toast(err.message || 'Ikon gagal disimpan', { type: 'error', detail: err.fields?.iconImage || '' });
      }
    }

    const BODIES = {
      brand: (f) => ({ name: f.name.value, siteTitle: f.siteTitle.value }),
      storeLogo: () => ({ logo: media.storeLogo.get()[0] ?? null }),
      footerLogo: () => ({ footerLogo: media.footerLogo.get()[0] ?? null }),
      favicon: () => ({ favicon: media.favicon.get()[0] ?? null }),
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
      if (media[key]?.busy()) return toast('Tunggu upload selesai', { type: 'error' });
      try {
        await busy($('button[type="submit"]', form), () => api.put(`/settings/${TARGET[key] || key}`, BODIES[key](form.elements)));
        const [title, detail] = SAVED[key] || ['Pengaturan disimpan', 'Marketplace sudah menerima pembaruan.'];
        toast(title, { detail });
        if (media[key]) setState(form, media[key].get().length ? 'Tersimpan' : 'Belum diatur');
      } catch (err) {
        const fields = Object.fromEntries(Object.entries(err.fields || {}).map(([k, v]) => [FIELD_MAP[k] || k, v]));
        const shown = fieldErrors(form, fields);
        // Kartu gambar selalu memberi toast gagal agar tidak terlewat; kartu lain hanya bila tidak ada kolom yang cocok
        if (!shown || media[key]) toast(err.message || 'Gagal menyimpan', { type: 'error', detail: Object.values(err.fields || {})[0] || '' });
        if (media[key]) setState(form, 'Gagal menyimpan', true);
      }
    });
    return { destroy() {}, onLive() {} };
  },
};
