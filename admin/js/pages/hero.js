import { $, html, mount, toast, toastError, busy, fieldErrors, raw } from '../ui.js';
import { api } from '../api.js';
import { mediaManager } from './_media.js';

export default {
  async mount(root, ctx) {
    let alive = true;
    const { settings } = await api.get('/settings');
    const h = settings.hero;
    const covers = [0, 1, 2].map(() => null);

    mount(root, html`
      <div class="page-head"><div><h2>Hero halaman utama</h2><p>Bagian pertama yang dilihat pengunjung. Perubahan yang disimpan langsung tampil di Marketplace yang sedang terbuka.</p></div></div>
      <div class="split">
        <form class="card" id="form" novalidate>
          <div class="card__body stack">
            <label class="field"><span>Teks kecil di atas judul</span><input name="eyebrow" value="${h.eyebrow}" maxlength="60"><small>Kosongkan untuk menyembunyikan.</small></label>
            <label class="field"><span>Judul</span><input name="title" value="${h.title}" maxlength="120" required></label>
            <label class="field"><span>Deskripsi</span><textarea name="desc" rows="3" maxlength="300">${h.desc}</textarea></label>
            <div class="grid-2">
              <label class="field"><span>Tombol utama</span><input name="primaryLabel" value="${h.primaryCta.label}" maxlength="40" required></label>
              <label class="field"><span>Tautan tombol utama</span><input name="primaryHref" value="${h.primaryCta.href}" maxlength="300" placeholder="#product"></label>
              <label class="field"><span>Tombol kedua</span><input name="secondaryLabel" value="${h.secondaryCta.label}" maxlength="40" required></label>
              <label class="field"><span>Tautan tombol kedua</span><input name="secondaryHref" value="${h.secondaryCta.href}" maxlength="300" placeholder="#product"></label>
            </div>
            <div class="grid-2">
              <label class="field"><span>Label melayang 1</span><input name="chip1" value="${h.chips[0] ?? ''}" maxlength="40"></label>
              <label class="field"><span>Label melayang 2</span><input name="chip2" value="${h.chips[1] ?? ''}" maxlength="40"></label>
            </div>
            <div class="field" data-field="covers">
              <span>Cover game</span>
              <small>Tiga cover bertumpuk di sisi kanan hero. Kosong = artwork bawaan. Rasio 2:3 (potret) paling pas.</small>
              <div class="cover-slots">${[0, 1, 2].map((i) => html`<div class="cover-slot"><label>Cover ${i + 1}</label><div id="cover-${i}"></div></div>`)}</div>
            </div>
            <div class="actions"><button class="btn btn--primary" type="submit">Simpan hero</button></div>
          </div>
        </form>
        <aside class="preview" aria-label="Pratinjau">
          <div class="preview__label">Pratinjau</div>
          <span class="preview__eyebrow" id="pv-eyebrow"></span>
          <h3 id="pv-title"></h3><p id="pv-desc"></p>
          <div class="preview__cta"><span id="pv-cta1"></span><span id="pv-cta2"></span></div>
          <div class="preview__chips" id="pv-chips"></div>
          <div class="preview__covers" id="pv-covers"></div>
        </aside>
      </div>`);

    const form = $('#form', root);
    const managers = [0, 1, 2].map((i) => {
      const host = $(`#cover-${i}`, root);
      const m = mediaManager(host, { max: 1, folder: 'hero', limits: ctx.meta.limits, initial: h.covers[i] ? [{ ...h.covers[i], type: 'image' }] : [], addLabel: 'Unggah', onChange: () => preview() });
      return m;
    });

    function preview() {
      const e = form.elements;
      const set = (id, text) => { const el = $(id, root); el.textContent = text; el.hidden = !text; };
      set('#pv-eyebrow', e.eyebrow.value); set('#pv-title', e.title.value); set('#pv-desc', e.desc.value);
      set('#pv-cta1', e.primaryLabel.value); set('#pv-cta2', e.secondaryLabel.value);
      mount($('#pv-chips', root), [e.chip1.value, e.chip2.value].filter(Boolean).map((c) => html`<span>${c}</span>`));
      mount($('#pv-covers', root), managers.map((m) => {
        const it = m.items()[0];
        return raw(`<i style="${it ? `background-image:url('${encodeURI(it.url)}')` : ''}"></i>`);
      }));
    }
    form.addEventListener('input', preview);
    preview();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (managers.some((m) => m.busy())) { toast('Tunggu upload selesai', { type: 'error' }); return; }
      const f = form.elements;
      const body = {
        eyebrow: f.eyebrow.value, title: f.title.value, desc: f.desc.value,
        primaryCta: { label: f.primaryLabel.value, href: f.primaryHref.value },
        secondaryCta: { label: f.secondaryLabel.value, href: f.secondaryHref.value },
        chips: [f.chip1.value, f.chip2.value].map((c) => c.trim()).filter(Boolean),
        covers: managers.map((m) => m.get()[0] ?? null),
      };
      try {
        await busy($('button[type="submit"]', form), () => api.put('/settings/hero', body));
        toast('Hero disimpan', { detail: 'Marketplace sudah menerima pembaruan.' });
      } catch (err) {
        const mapped = { primaryCta: 'primaryLabel', secondaryCta: 'secondaryLabel' };
        const fields = Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [mapped[k.split('.')[0]] && k.endsWith('label') ? mapped[k.split('.')[0]] : k.startsWith('primaryCta.href') ? 'primaryHref' : k.startsWith('secondaryCta.href') ? 'secondaryHref' : k, v]));
        if (!fieldErrors(form, fields)) toastError(err);
      }
    });

    return { destroy() { alive = false; }, onLive() {} };
  },
};
