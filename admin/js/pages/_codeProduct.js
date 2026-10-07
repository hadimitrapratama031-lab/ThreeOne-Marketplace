/* Add Product → Sistem Code: pemilih jenis produk + form produk code (terpisah dari form produk biasa). */
import { $, html, icon, num, toast, dialog, busy, fieldErrors } from '../ui.js';
import { api } from '../api.js';
import { mediaManager, mainImagePicker } from './_media.js';

/** Popup pilihan jenis produk. Resolve 'normal' | 'code' | null (ditutup). */
export function chooseProductType() {
  return new Promise((resolve) => {
    let picked = null;
    const d = dialog({
      title: 'Tambah produk',
      body: html`
        <p class="muted" style="margin-top:-6px">Pilih jenis produk yang ingin dibuat.</p>
        <div class="type-pick" role="group" aria-label="Jenis produk">
          <button type="button" class="type-pick__opt" data-pick="normal">
            <span class="type-pick__icon">${icon('box')}</span>
            <span class="type-pick__text"><b>Sistem Biasa</b><small>Produk dengan stok angka. Pesanan diproses admin secara manual.</small></span>
          </button>
          <button type="button" class="type-pick__opt" data-pick="code">
            <span class="type-pick__icon">${icon('key')}</span>
            <span class="type-pick__text"><b>Sistem Code</b><small>Setiap pembeli otomatis menerima 1 code redeem unik setelah pembayaran berhasil.</small></span>
          </button>
        </div>`,
      foot: html`<button type="button" class="btn" data-close>Batal</button>`,
    });
    d.el.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-pick]');
      if (opt) { picked = opt.dataset.pick; d.close(); }
    });
    d.closed.then(() => resolve(picked));
    $('[data-pick="normal"]', d.el)?.focus();
  });
}

/* Hitung cepat di browser (tampilan saja). Validasi yang menentukan tetap di server. */
const CODE_RE = /^[\x21-\x7E]{4,100}$/;
export function tallyCodes(text) {
  const seen = new Set();
  let valid = 0; let dup = 0; let bad = 0;
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const v = raw.trim();
    if (!v) continue;
    if (!CODE_RE.test(v)) { bad += 1; continue; }
    const k = v.toUpperCase();
    if (seen.has(k)) dup += 1; else { seen.add(k); valid += 1; }
  }
  return { valid, dup, bad };
}

const tallyText = ({ valid, dup, bad }) => [
  `${num(valid)} code valid`,
  dup ? `${num(dup)} duplikat dalam daftar (diabaikan)` : '',
  bad ? `${num(bad)} baris tidak valid` : '',
].filter(Boolean).join(' · ');

const stepsCount = (t) => String(t).split(/\r\n|\r|\n/).filter((l) => l.trim()).length;

/**
 * @param {{ctx:any, categories:any[], product?:any, onSaved:()=>void}} o
 * product = item dari GET /code-products/:id (berisi `codes` = jumlah per status) saat mengubah.
 */
export function openCodeProductForm({ ctx, categories, product: p, onSaved }) {
  if (!categories.length) { toast('Buat kategori dulu', { type: 'error', detail: 'Produk harus punya kategori.' }); ctx.go('categories'); return; }
  const c = p?.codes;
  const d = dialog({
    kind: 'drawer',
    title: p ? 'Ubah produk code' : 'Tambah produk — Sistem Code',
    body: html`
      <div class="fieldset">
        <h3>Informasi produk</h3>
        <label class="field"><span>Nama produk</span><input name="name" value="${p?.name ?? ''}" maxlength="120" required></label>
        <div class="grid-2">
          <label class="field"><span>Kategori</span><select name="category">${categories.map((x) => html`<option value="${x.id}" ${(p?.category.id ?? categories[0].id) === x.id ? 'selected' : ''}>${x.name}${x.active ? '' : ' (nonaktif)'}</option>`)}</select></label>
          <label class="field"><span>Harga</span><div class="input-prefix"><span>Rp</span><input name="price" type="number" min="1" step="1" value="${p?.price ?? ''}" required></div></label>
        </div>
        <label class="field"><span>Deskripsi singkat</span><textarea name="description" rows="2" maxlength="300">${p?.description ?? ''}</textarea><small>Tampil di kartu produk. <span id="desc-count"></span></small></label>
        <label class="field"><span>Deskripsi lengkap <em class="faint" style="font-style:normal;font-weight:500">(opsional)</em></span><textarea name="about" rows="4" maxlength="4000">${p?.about ?? ''}</textarea><small>Tampil di bagian “Tentang Produk”. Pisahkan paragraf dengan satu baris kosong.</small></label>
      </div>

      <div class="fieldset">
        <h3>Gambar utama</h3>
        <div class="field" data-field="media"><div id="main-image-host"></div></div>
      </div>

      <div class="fieldset">
        <h3>Gambar produk</h3>
        <p class="hint muted">Gambar pertama jadi gambar utama. JPG, PNG, WebP, GIF, AVIF hingga ${ctx.meta.limits.imageMB} MB.</p>
        <div class="media-grid" id="media-host"></div>
      </div>

      <div class="fieldset">
        <h3>Cara redeem</h3>
        <p class="hint muted">Tampil sebagai langkah bernomor di halaman Pembayaran Berhasil milik pembeli. Tulis satu langkah per baris; nomor ditambahkan otomatis.</p>
        <label class="field"><span class="sr-only">Cara redeem</span><textarea name="redeemTutorial" rows="6" maxlength="4000" placeholder="Buka aplikasi atau situs redeem&#10;Masuk ke akun Anda&#10;Pilih menu Redeem Code&#10;Tempel code lalu konfirmasi">${p?.redeemTutorial ?? ''}</textarea><small><span id="steps-count"></span></small></label>
      </div>

      <div class="fieldset">
        <h3>Stock code</h3>
        ${p ? html`
          <div class="code-counts" aria-label="Jumlah code per status">
            <div><b>${num(c.available)}</b><span>Tersedia</span></div>
            <div><b>${num(c.sold)}</b><span>Terjual</span></div>
            ${c.waiting ? html`<div class="is-warn"><b>${num(c.waiting)}</b><span>Menunggu code</span></div>` : ''}
          </div>
          <p class="hint muted">Stok Marketplace = jumlah code tersedia. Untuk menambah stok, tempel code baru di bawah lalu klik “Tambah ke stok”; code lama tidak berubah.</p>` : html`
          <p class="hint muted">Satu code per baris. Code disimpan ke database dan tidak pernah tampil di Marketplace. Code yang sudah ada di sistem otomatis dilewati.</p>`}
        <label class="field"><span>${p ? 'Tambah code baru' : 'Daftar code'}</span>
          <textarea name="codes" class="mono code-input" rows="8" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="CODE-AAAA-BBBB&#10;CODE-CCCC-DDDD&#10;CODE-EEEE-FFFF"></textarea>
          <small id="codes-tally" aria-live="polite"></small>
        </label>
        ${p ? html`<div><button type="button" class="btn" id="add-codes">${icon('plus')}Tambah ke stok</button></div>` : ''}
      </div>

      <div class="fieldset">
        <h3>Status</h3>
        <label class="switch"><input type="checkbox" name="active" ${p ? (p.active ? 'checked' : '') : 'checked'}><i></i><span>Tampilkan di Marketplace</span></label>
      </div>`,
    foot: html`<button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn btn--primary">${p ? 'Simpan perubahan' : 'Simpan produk'}</button>`,
  });
  const f = d.form;
  const media = mediaManager($('#media-host', f), { folder: 'products', video: false, max: 10, limits: ctx.meta.limits, initial: p?.media ?? [], showMain: true, addLabel: 'Tambah gambar' });
  mainImagePicker($('#main-image-host', f), media, { limits: ctx.meta.limits });

  const desc = () => { $('#desc-count', f).textContent = `${f.elements.description.value.length}/300`; };
  const steps = () => { const n = stepsCount(f.elements.redeemTutorial.value); $('#steps-count', f).textContent = n ? `${n} langkah` : 'Belum ada langkah. Pembeli akan melihat arahan untuk menghubungi admin.'; };
  const tally = () => { const t = f.elements.codes.value.trim() ? tallyCodes(f.elements.codes.value) : null; const el = $('#codes-tally', f); el.textContent = t ? tallyText(t) : (p ? '' : 'Belum ada code. Anda bisa menambahkannya nanti, tetapi produk akan tampil habis sampai ada stok.'); el.style.color = t?.bad ? 'var(--danger)' : ''; };
  f.elements.description.addEventListener('input', desc); desc();
  f.elements.redeemTutorial.addEventListener('input', steps); steps();
  f.elements.codes.addEventListener('input', tally); tally();

  const showFieldError = (err) => {
    const msgs = Object.values(err.fields);
    if (!fieldErrors(f, err.fields)) toast(err.message, { type: 'error', detail: msgs[0] || '' });
    else if (msgs.length > 1) toast('Periksa kembali isian formulir', { type: 'error', detail: `${msgs.length} kolom perlu diperbaiki.` });
  };
  const codesNote = (r) => [r.duplicates ? `${num(r.duplicates)} code sudah ada dan dilewati` : '', r.duplicatesInInput ? `${num(r.duplicatesInInput)} duplikat dalam daftar diabaikan` : ''].filter(Boolean).join(' · ');

  // Mode ubah: tambah stok langsung (tanpa menyimpan ulang info produk)
  $('#add-codes', f)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      const r = await busy(btn, () => api.post(`/code-products/${p.id}/codes`, { codes: f.elements.codes.value }));
      f.elements.codes.value = ''; tally();
      toast(`${num(r.added)} code ditambahkan`, { detail: [codesNote(r), r.fulfilled ? `${num(r.fulfilled)} pesanan yang menunggu langsung dipenuhi` : '', `Stok sekarang ${num(r.stock)}`].filter(Boolean).join(' · ') });
      onSaved();
      d.close();
    } catch (err) { showFieldError(err); }
  });

  f.addEventListener('submit', async () => {
    const btn = $('button[type="submit"]', f);
    if (media.busy()) { toast('Tunggu upload selesai', { type: 'error' }); return; }
    const el = f.elements;
    const body = {
      name: el.name.value, category: el.category.value, price: el.price.value === '' ? NaN : Number(el.price.value),
      active: el.active.checked, description: el.description.value, about: el.about.value, redeemTutorial: el.redeemTutorial.value,
      media: media.get(),
      ...(p ? {} : { codes: el.codes.value }),
    };
    try {
      let extra = null;   // mode ubah: code yang sudah diketik ikut disimpan (tidak hilang diam-diam)
      const res = await busy(btn, async () => {
        if (!p) return api.post('/code-products', body);
        const saved = await api.put(`/code-products/${p.id}`, body);
        if (el.codes.value.trim()) extra = await api.post(`/code-products/${p.id}/codes`, { codes: el.codes.value });
        return saved;
      });
      d.close();
      if (p) toast('Produk code disimpan', { detail: extra ? [`${num(extra.added)} code ditambahkan`, codesNote(extra), extra.fulfilled ? `${num(extra.fulfilled)} pesanan yang menunggu langsung dipenuhi` : ''].filter(Boolean).join(' · ') : res.item.active ? 'Marketplace sudah menerima pembaruan.' : 'Produk nonaktif, tidak tampil di Marketplace.' });
      else toast('Produk code ditambahkan', { detail: [res.codes ? `${num(res.codes.added)} code tersimpan` : 'Belum ada stok code', res.codes ? codesNote(res.codes) : ''].filter(Boolean).join(' · ') });
      onSaved();
    } catch (err) { showFieldError(err); }
  });
  $('input[name="name"]', f).focus();
}
