/* Pengelola media: upload ke backend -> R2, urutkan, hapus dari daftar. Hanya menyimpan referensi {type,key,url}. */
import { $, html, mount, icon, toast, toastError } from '../ui.js';
import { api } from '../api.js';

// `max` opsional: tanpa `max` jumlah file tidak dibatasi (dipakai galeri produk). Halaman lain tetap memberi batas sendiri.
// Opsional (hanya bila diisi, perilaku lama tidak berubah): `accept` = daftar MIME yang boleh dipilih (divalidasi di browser,
// server tetap memeriksa isi file), `formats` = teks format untuk pesan error, `maxMB` = batas ukuran khusus bagian ini.
// Item galeri: upload manual = { type, key, url } (R2). Media Steam = { type, source:'steam', url, ... } referensi URL asli Steam (tanpa key, tanpa R2).
const MIME = { mp4: 'video/mp4', webm: 'video/webm', hls: 'application/vnd.apple.mpegurl' };
const norm = (m) => ({
  type: m.type || 'image', key: m.key || '', url: m.url,
  ...(m.source === 'steam' ? { source: 'steam', poster: m.poster || '', title: m.title || '', ref: m.ref || '', sources: Array.isArray(m.sources) ? m.sources : [] } : {}),
});
const wire = (m) => (m.source === 'steam'
  ? { source: 'steam', type: m.type, url: m.url, ...(m.type === 'video' ? { poster: m.poster || '', title: m.title || '', ref: m.ref || '', sources: m.sources || [] } : {}) }
  : { key: m.key });
const sourceTags = (m) => (m.sources || []).filter((x) => MIME[x.format]).map((x) => html`<source src="${x.url}" type="${MIME[x.format]}">`);
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon' };

export function mediaManager(host, { max = Infinity, folder, video = false, limits, initial = [], showMain = false, addLabel = 'Tambah gambar', addHint = '', replace = false, accept = null, formats = '', maxMB = null, onChange }) {
  let items = initial.map(norm);
  let pending = 0;
  let main = { pending: false, preview: null };   // penggantian gambar utama yang sedang diunggah (pratinjau lokal langsung tampil)
  const listeners = new Set();                    // dipanggil setiap daftar berubah (dipakai pemilih gambar utama)

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
        ${m.type === 'video'
    ? (m.source === 'steam'
      ? html`<video muted preload="none" ${m.poster ? html`poster="${m.poster}"` : ''}>${sourceTags(m)}</video>`   /* video Steam: thumbnail Steam, tanpa memuat file video di daftar */
      : html`<video src="${m.url}" muted preload="metadata"></video>`)
    : html`<img src="${m.url}" alt="" loading="lazy">`}
        ${m.type === 'video' ? html`<span class="badge badge--video">${m.source === 'steam' ? 'Video · Steam' : 'Video'}</span>` : showMain && i === firstImage ? html`<span class="badge">Utama</span>` : m.source === 'steam' ? html`<span class="badge">Steam</span>` : ''}
        <div class="tools">
          ${max > 1 ? html`<span><button type="button" class="icon-btn" data-mv="${i}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Geser ke kiri">${icon('left')}</button><button type="button" class="icon-btn" data-mv="${i}:1" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Geser ke kanan">${icon('right')}</button></span>` : html`<span></span>`}
          <span>${replace ? html`<button type="button" class="icon-btn" data-rp="${i}" aria-label="Ganti file ini">${icon('upload')}</button>` : ''}<button type="button" class="icon-btn" data-rm="${i}" aria-label="Hapus dari daftar">${icon('x')}</button></span>
        </div>
      </div>`);
    const uploading = Array.from({ length: pending }, () => html`<div class="media-tile is-uploading"><span>Mengunggah…</span></div>`);
    const add = items.length + pending < max
      ? html`<button type="button" class="media-add" data-add>${icon('upload')}<span>${addLabel}</span>${addHint ? html`<small>${addHint}</small>` : ''}</button>` : '';
    mount(host, html`${tiles}${uploading}${add}`);
    listeners.forEach((fn) => fn());
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

  /**
   * Ganti GAMBAR UTAMA langsung dari satu file, tanpa menggeser apa pun:
   *  - sudah ada gambar utama -> item itu diganti di posisinya; gambar & video lain, serta urutannya, tidak berubah
   *  - belum ada -> gambar baru jadi item pertama (otomatis menjadi gambar utama)
   * Upload memakai jalur R2 yang sama (api.upload -> /api/admin/media). File lama baru dilepas/dibersihkan server saat produk disimpan.
   */
  async function replaceMain(file) {
    if (!file || main.pending) return;
    if (!file.type.startsWith('image/')) { toast(`${file.name} bukan gambar`, { type: 'error', detail: 'Gambar utama harus berupa gambar (JPG, PNG, WebP, GIF, AVIF).' }); return; }
    const bad = problem(file);
    if (bad) { toast(bad.title, { type: 'error', detail: bad.detail }); return; }
    const old = items.find((m) => m.type === 'image') || null;
    if (!old && items.length >= max) { toast(`Maksimal ${max} file`, { type: 'error', detail: 'Hapus satu file dulu untuk menambah gambar utama.' }); return; }
    const preview = URL.createObjectURL(file);
    main = { pending: true, preview }; render();
    try {
      const { asset } = await api.upload(file, folder);
      if (asset.kind !== 'image') throw new Error('File ini bukan gambar. Pilih JPG, PNG, WebP, GIF, atau AVIF.');
      const fresh = { type: 'image', key: asset.key, url: asset.url };
      const at = old ? items.indexOf(old) : -1;   // posisi bisa berubah selama upload (admin menggeser/menghapus)
      if (at >= 0) items[at] = fresh; else items.unshift(fresh);
      onChange?.(items);
    } catch (err) { toastError(err, 'Upload gagal'); }
    finally { URL.revokeObjectURL(preview); main = { pending: false, preview: null }; render(); }
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
    get: () => items.map(wire),   // upload -> { key }; media Steam -> referensi URL (dikirim apa adanya ke server)
    items: () => items,
    set(list) { items = list.map(norm); render(); },
    busy: () => pending > 0 || main.pending,
    replaceMain,
    mainState: () => main,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/**
 * Bagian "Gambar utama" pada form produk: pratinjau besar + satu tombol untuk memilih gambar pengganti.
 * Hanya tampilan di atas mediaManager yang sama (satu daftar media, satu jalur upload R2), jadi tidak ada sistem baru.
 */
export function mainImagePicker(host, media, { limits }) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif,image/avif';

  function draw() {
    const cur = media.items().find((m) => m.type === 'image');
    const s = media.mainState();
    const src = s.preview || cur?.url;
    mount(host, html`
      <div class="main-image ${s.pending ? 'is-uploading' : ''}">
        <div class="main-image__preview">
          ${src ? html`<img src="${src}" alt="Pratinjau gambar utama">` : html`<span class="main-image__empty">${icon('image')}<span>Belum ada gambar utama</span></span>`}
          ${s.pending ? html`<span class="main-image__busy" role="status">Mengunggah…</span>` : ''}
        </div>
        <div class="main-image__side">
          <button type="button" class="btn btn--primary" data-main-pick ${s.pending ? 'disabled' : ''}>${icon('upload')}${cur ? 'Ganti Gambar Utama' : 'Pilih Gambar Utama'}</button>
          <p class="hint muted">Gambar yang dipilih langsung menjadi gambar utama di kartu produk dan halaman detail setelah disimpan. Galeri lain tidak berubah. JPG, PNG, WebP, GIF, AVIF hingga ${limits.imageMB} MB. Bisa juga seret gambar ke sini.</p>
        </div>
      </div>`);
  }

  host.addEventListener('click', (e) => { if (e.target.closest('[data-main-pick]')) { input.value = ''; input.click(); } });
  input.addEventListener('change', () => media.replaceMain(input.files[0]));
  host.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); host.firstElementChild?.classList.add('is-drag'); } });
  host.addEventListener('dragleave', () => host.firstElementChild?.classList.remove('is-drag'));
  host.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    host.firstElementChild?.classList.remove('is-drag');
    media.replaceMain(file);
  });

  media.subscribe(draw);
  draw();
}
