/* Pengelola media: upload ke backend -> R2, urutkan, hapus dari daftar. Hanya menyimpan referensi {type,key,url}. */
import { $, html, mount, icon, toast, toastError } from '../ui.js';
import { api } from '../api.js';

// `max` opsional: tanpa `max` jumlah file tidak dibatasi (dipakai galeri produk). Halaman lain tetap memberi batas sendiri.
// Opsional (hanya bila diisi, perilaku lama tidak berubah): `accept` = daftar MIME yang boleh dipilih (divalidasi di browser,
// server tetap memeriksa isi file), `formats` = teks format untuk pesan error, `maxMB` = batas ukuran khusus bagian ini.
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon' };

export function mediaManager(host, { max = Infinity, folder, video = false, limits, initial = [], showMain = false, addLabel = 'Tambah gambar', addHint = '', replace = false, accept = null, formats = '', maxMB = null, onChange }) {
  let items = initial.map((m) => ({ type: m.type || 'image', key: m.key, url: m.url }));
  let pending = 0;

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = max > 1;
  input.accept = accept ? [...new Set([...accept, ...Object.entries(EXT_MIME).filter(([, m]) => accept.includes(m)).map(([e]) => `.${e}`)])].join(',')
    : video ? 'image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm' : 'image/jpeg,image/png,image/webp,image/gif,image/avif';

  /** Validasi di browser sebelum upload. Mengembalikan { title, detail } bila ditolak. */
  function problem(file) {
    if (accept) {
      const byExt = EXT_MIME[(file.name.split('.').pop() || '').toLowerCase()];
      const ok = accept.includes(file.type) || (!file.type && byExt && accept.includes(byExt));
      if (!ok) return { title: `${file.name} tidak didukung`, detail: formats ? `Gunakan ${formats}.` : 'Format file tidak sesuai.' };
    }
    const isVideo = file.type.startsWith('video/');
    const cap = Math.min(isVideo ? limits.videoMB : limits.imageMB, maxMB ?? Infinity);
    if (file.size > cap * 1048576) return { title: `${file.name} terlalu besar`, detail: `Maksimal ${cap} MB.` };
    return null;
  }

  const swap = document.createElement('input');   // pilih satu file pengganti untuk tile tertentu
  swap.type = 'file';
  swap.accept = input.accept;   // dibaca setelah input.accept diisi di atas
  let swapIndex = -1;

  function render() {
    const firstImage = items.findIndex((m) => m.type === 'image');
    const tiles = items.map((m, i) => html`
      <div class="media-tile">
        ${m.type === 'video' ? html`<video src="${m.url}" muted preload="metadata"></video>` : html`<img src="${m.url}" alt="" loading="lazy">`}
        ${m.type === 'video' ? html`<span class="badge badge--video">Video</span>` : showMain && i === firstImage ? html`<span class="badge">Utama</span>` : ''}
        <div class="tools">
          ${max > 1 ? html`<span><button type="button" class="icon-btn" data-mv="${i}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Geser ke kiri">${icon('left')}</button><button type="button" class="icon-btn" data-mv="${i}:1" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Geser ke kanan">${icon('right')}</button></span>` : html`<span></span>`}
          <span>${replace ? html`<button type="button" class="icon-btn" data-rp="${i}" aria-label="Ganti file ini">${icon('upload')}</button>` : ''}<button type="button" class="icon-btn" data-rm="${i}" aria-label="Hapus dari daftar">${icon('x')}</button></span>
        </div>
      </div>`);
    const uploading = Array.from({ length: pending }, () => html`<div class="media-tile is-uploading"><span>Mengunggah…</span></div>`);
    const add = items.length + pending < max
      ? html`<button type="button" class="media-add" data-add>${icon('upload')}<span>${addLabel}</span>${addHint ? html`<small>${addHint}</small>` : ''}</button>` : '';
    mount(host, html`${tiles}${uploading}${add}`);
  }

  async function addFiles(files) {
    const room = max - items.length - pending;
    const list = [...files].slice(0, Math.max(0, room));
    if (files.length > list.length) toast(`Maksimal ${max} file`, { type: 'error', detail: 'Sebagian file tidak ditambahkan.' });
    for (const file of list) {
      const bad = problem(file);
      if (bad) { toast(bad.title, { type: 'error', detail: bad.detail }); continue; }
      pending++; render();
      try {
        const { asset } = await api.upload(file, folder);
        items.push({ type: asset.kind, key: asset.key, url: asset.url });
        onChange?.(items);
      } catch (err) { toastError(err, 'Upload gagal'); }
      finally { pending--; render(); }
    }
  }

  /** Ganti file pada posisi yang sama (urutan & status "Utama" tetap). File lama baru dilepas saat produk disimpan. */
  async function replaceFile(file) {
    const i = swapIndex;
    swapIndex = -1;
    if (!file || !items[i]) return;
    const bad = problem(file);
    if (bad) { toast(bad.title, { type: 'error', detail: bad.detail }); return; }
    const old = items[i];
    pending++; render();
    try {
      const { asset } = await api.upload(file, folder);
      const at = items.indexOf(old);   // posisi bisa berubah selama upload (admin menggeser/menghapus)
      if (at >= 0) items[at] = { type: asset.kind, key: asset.key, url: asset.url };
      else items.push({ type: asset.kind, key: asset.key, url: asset.url });
      onChange?.(items);
    } catch (err) { toastError(err, 'Upload gagal'); }
    finally { pending--; render(); }
  }

  host.addEventListener('click', (e) => {
    const rp = e.target.closest('[data-rp]');
    if (rp) { swapIndex = +rp.dataset.rp; swap.value = ''; swap.click(); return; }
    if (e.target.closest('[data-add]')) { input.value = ''; input.click(); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) { items.splice(+rm.dataset.rm, 1); render(); onChange?.(items); return; }
    const mv = e.target.closest('[data-mv]');
    if (mv) {
      const [i, d] = mv.dataset.mv.split(':').map(Number);
      [items[i], items[i + d]] = [items[i + d], items[i]];
      render(); onChange?.(items);
    }
  });
  input.addEventListener('change', () => addFiles(input.files));
  swap.addEventListener('change', () => replaceFile(swap.files[0]));

  render();
  return {
    get: () => items.map((m) => ({ key: m.key })),
    items: () => items,
    set(list) { items = list.map((m) => ({ type: m.type || 'image', key: m.key, url: m.url })); render(); },
    busy: () => pending > 0,
  };
}
