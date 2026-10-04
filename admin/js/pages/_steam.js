/* Mode "Otomatis (Steam App ID)" pada form Tambah produk.
   Alur: App ID -> Search (backend) -> isi formulir -> admin review/edit -> Simpan (alur produk yang sudah ada).
   Modul ini hanya mengisi kolom formulir yang sama dengan mode Manual; tidak ada form kedua. */
import { $, html, mount, icon, toast, dialog, busy, esc } from '../ui.js';
import { api } from '../api.js';

const MSG = {
  searching: 'Searching Steam...',
  found: 'Game ditemukan',
  partial: 'Game ditemukan, tetapi beberapa metadata tidak tersedia.',
  invalid: 'Steam App ID tidak valid.',
  noVideo: 'Video tidak tersedia, silakan upload manual.',
};
const BADGE = '✓ Data from Steam';
const MAX_MEDIA = 6;

export const steamSourceBlock = () => html`
  <div class="fieldset">
    <h3>Sumber produk</h3>
    <div class="seg" role="group" aria-label="Sumber produk">
      <button type="button" class="seg__btn" data-src="manual" aria-pressed="true">Manual</button>
      <button type="button" class="seg__btn" data-src="steam" aria-pressed="false">Otomatis (Steam App ID)</button>
    </div>
    <div class="steam" data-steam hidden>
      <div class="steam__row">
        <label class="field"><span>Steam App ID</span><input data-steam-id inputmode="numeric" maxlength="10" autocomplete="off" placeholder="mis. 1245620" aria-describedby="steam-status"></label>
        <button type="button" class="btn btn--primary" data-steam-search>${icon('search')}Search</button>
      </div>
      <p class="steam__status" id="steam-status" role="status" aria-live="polite" data-steam-status></p>
      <div data-steam-card></div>
    </div>
  </div>`;

const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Dialog dua pilihan. Mengembalikan true (timpa) / false (hanya isi yang kosong). */
function askOverwrite(fields) {
  return new Promise((resolve) => {
    const d = dialog({
      title: 'Timpa isian yang sudah ada?',
      body: html`<p>Kolom berikut sudah berisi data: <b>${fields.join(', ')}</b>.</p><p class="muted">Data dari Steam bisa menimpanya, atau hanya mengisi kolom yang masih kosong.</p>`,
      foot: html`<button type="button" class="btn" data-keep>Isi yang kosong saja</button><button type="button" class="btn btn--primary" data-over>Timpa dengan data Steam</button>`,
    });
    let result = false;
    $('[data-over]', d.el).addEventListener('click', () => { result = true; d.close(); });
    $('[data-keep]', d.el).addEventListener('click', () => d.close());
    d.closed.then(() => resolve(result));
    $('[data-keep]', d.el).focus();
  });
}

/**
 * @param {HTMLFormElement} f  form produk
 * @param {{ media, setSpecRows(kind, rows), readSpecs(kind), onCount() }} deps
 */
export function initSteam(f, { media, setSpecRows, readSpecs, onCount }) {
  const panel = $('[data-steam]', f);
  const input = $('[data-steam-id]', f);
  const searchBtn = $('[data-steam-search]', f);
  const statusEl = $('[data-steam-status]', f);
  const cardEl = $('[data-steam-card]', f);

  const steamKeys = new Set();   // key aset (R2, status temp) yang berasal dari Steam pada form ini
  let seq = 0;                   // setiap Search baru membatalkan hasil unduhan video pencarian sebelumnya
  let searching = false;
  let videoLoading = false;
  let view = null;               // { item, videoKey, videoMsg }
  let overwriteAll = false;

  /* ---------- Mode ---------- */
  f.addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    for (const x of f.querySelectorAll('[data-src]')) x.setAttribute('aria-pressed', String(x === b));
    panel.hidden = b.dataset.src !== 'steam';
    if (!panel.hidden) input.focus();
  });

  /* ---------- Indikator "Data from Steam" ---------- */
  const labelOf = {
    name: () => f.elements.name.closest('.field').firstElementChild,
    description: () => f.elements.description.closest('.field').firstElementChild,
    about: () => f.elements.about.closest('.field').firstElementChild,
    min: () => $('[data-spec-list="min"]', f).closest('.field').firstElementChild,
    rec: () => $('[data-spec-list="rec"]', f).closest('.field').firstElementChild,
    media: () => $('#media-host', f).closest('.fieldset').querySelector('h3'),
  };
  const mark = (key) => {
    const l = labelOf[key]();
    if (l.querySelector('.from-steam')) return;
    const i = document.createElement('i');
    i.className = 'from-steam';
    i.textContent = BADGE;
    l.append(' ', i);
  };
  const unmark = (el) => el?.querySelector('.from-steam')?.remove();
  // Admin mengubah kolom -> data tidak lagi persis dari Steam, indikator dilepas
  f.addEventListener('input', (e) => { const field = e.target.closest('.field'); if (field && !e.target.matches('[data-steam-id]')) unmark(field.firstElementChild); });

  /* ---------- Status & kartu hasil ---------- */
  function setStatus(kind, text, detail = '') {
    statusEl.className = `steam__status is-${kind}`;
    statusEl.innerHTML = text ? `${esc(text)}${detail ? ` <small>${esc(detail)}</small>` : ''}` : '';
  }

  const chip = (ok, label) => html`<li class="chip ${ok ? 'chip--ok' : 'chip--miss'}">${icon(ok ? 'check' : 'alert')}${label}${ok ? '' : html` <span class="sr-only">tidak tersedia</span>`}</li>`;

  function renderCard() {
    if (!view) { mount(cardEl, ''); return; }
    const { item } = view;
    const vid = view.videoKey && media.items().find((m) => m.key === view.videoKey);
    const notes = item.warnings.filter((w) => w.field !== 'video');
    mount(cardEl, html`
      <div class="steam-card">
        <div class="steam-card__img">${item.image ? html`<img src="${item.image.url}" alt="Gambar utama dari Steam">` : html`<span>${icon('image')}Gambar tidak tersedia</span>`}</div>
        <div class="steam-card__body">
          <b>${item.name || 'Tanpa nama'}</b>
          <small>App ID ${item.appId}, <a href="${item.storeUrl}" target="_blank" rel="noopener noreferrer">buka di Steam</a></small>
          <ul class="chips">
            ${chip(Boolean(item.image), 'Gambar')}${chip(Boolean(item.about || item.description), 'Deskripsi')}
            ${chip(item.specs.min.length > 0, 'Spek minimum')}${chip(item.specs.rec.length > 0, 'Spek disarankan')}
            ${chip(Boolean(vid) || videoLoading, 'Video')}
          </ul>
          ${notes.length ? html`<ul class="steam-notes">${notes.map((w) => html`<li>${w.message}</li>`)}</ul>` : ''}
        </div>
        <div class="steam-card__video">
          ${videoLoading ? html`<p class="steam__status is-busy">Mengunduh trailer dari Steam...</p>`
    : vid ? html`<video controls preload="metadata" src="${vid.url}" aria-label="Pratinjau trailer Steam"></video>`
      : view.videoMsg ? html`<p class="steam__status is-warn">${view.videoMsg}</p>` : ''}
        </div>
      </div>`);
  }

  // Dipanggil media manager bila admin menambah/menghapus/mengurutkan file
  function onMediaChange() {
    const keys = new Set(media.items().map((m) => m.key));
    for (const k of [...steamKeys]) if (!keys.has(k)) steamKeys.delete(k);
    if (!media.items().some((m) => steamKeys.has(m.key))) unmark(labelOf.media());
    if (view?.videoKey && !keys.has(view.videoKey)) { view.videoKey = null; view.videoMsg = 'Video dihapus dari galeri. Unggah video manual bila perlu.'; }
    renderCard();
  }

  /* ---------- Isi formulir ---------- */
  async function apply(item) {
    const cur = { name: f.elements.name.value.trim(), description: f.elements.description.value.trim(), about: f.elements.about.value.trim(), min: readSpecs('min'), rec: readSpecs('rec') };
    const next = { name: item.name, description: item.description, about: item.about, min: item.specs.min, rec: item.specs.rec };
    const label = { name: 'Nama produk', description: 'Deskripsi singkat', about: 'Deskripsi lengkap', min: 'Persyaratan minimum', rec: 'Persyaratan disarankan' };
    const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : !v);
    const hasNew = (k) => !isEmpty(next[k]);
    const conflicts = Object.keys(next).filter((k) => hasNew(k) && !isEmpty(cur[k]) && (Array.isArray(next[k]) ? !sameRows(cur[k], next[k]) : cur[k] !== next[k]));

    overwriteAll = conflicts.length ? await askOverwrite(conflicts.map((k) => label[k])) : false;
    const can = (k) => hasNew(k) && (overwriteAll || isEmpty(cur[k]) || (Array.isArray(next[k]) ? sameRows(cur[k], next[k]) : cur[k] === next[k]));

    for (const k of ['name', 'description', 'about']) {
      if (can(k)) { f.elements[k].value = next[k]; mark(k); }
    }
    onCount();
    for (const k of ['min', 'rec']) {
      if (can(k)) { setSpecRows(k, next[k]); mark(k); }
    }
    if ((can('min') || can('rec')) && (overwriteAll || !f.elements.source.value.trim())) f.elements.source.value = item.specs.source;

    // Gambar: jadi gambar utama (urutan pertama). Hasil Steam dari pencarian sebelumnya diganti; file manual tidak disentuh.
    let list = media.items().filter((m) => !steamKeys.has(m.key));
    steamKeys.clear();
    if (item.image) {
      if (list.length >= MAX_MEDIA) toast('Galeri penuh', { type: 'error', detail: 'Gambar Steam tidak ditambahkan. Hapus satu file lalu cari lagi.' });
      else { list = [item.image, ...list]; steamKeys.add(item.image.key); }
    }
    media.set(list);
    if (steamKeys.size) mark('media'); else unmark(labelOf.media());
  }

  async function loadVideo(appId, mySeq) {
    videoLoading = true; view.videoMsg = ''; renderCard();
    let res = null; let msg = MSG.noVideo;
    try { res = await api.post(`/steam/${appId}/video`); msg = res.message || MSG.noVideo; } catch (err) { msg = `${MSG.noVideo}${err.message ? ` (${err.message})` : ''}`; }
    if (mySeq !== seq) return;   // sudah ada pencarian baru
    videoLoading = false;
    if (res?.video) {
      let list = media.items();
      const manualVideo = list.find((m) => m.type === 'video' && !steamKeys.has(m.key));
      if (manualVideo && !overwriteAll) msg = 'Video yang sudah Anda unggah dipertahankan; trailer Steam tidak ditambahkan.';
      else {
        if (manualVideo) list = list.filter((m) => m !== manualVideo);
        if (list.length >= MAX_MEDIA) msg = 'Galeri penuh, trailer Steam tidak ditambahkan.';
        else {
          media.set([...list, res.video]);
          steamKeys.add(res.video.key);
          view.videoKey = res.video.key; msg = '';
          mark('media');
        }
      }
    }
    view.videoMsg = msg;
    renderCard();
  }

  /* ---------- Search ---------- */
  async function search() {
    if (searching) return;
    const id = input.value.trim();
    if (!/^\d{1,10}$/.test(id) || Number(id) < 1) { setStatus('error', MSG.invalid, 'Isi angka saja, mis. 570 atau 1245620.'); input.focus(); return; }
    searching = true;
    const mySeq = ++seq;
    setStatus('busy', MSG.searching);
    try {
      await busy(searchBtn, async () => {
        const { item } = await api.get(`/steam/${id}`);
        if (mySeq !== seq) return;
        videoLoading = false;
        view = { item, videoKey: null, videoMsg: '' };
        await apply(item);
        const partial = item.warnings.some((w) => w.field !== 'video') || !item.video.available;
        setStatus(partial ? 'warn' : 'ok', partial ? MSG.partial : MSG.found, item.name);
        view.videoMsg = item.video.available ? '' : MSG.noVideo;
        renderCard();
        if (item.video.available) loadVideo(item.appId, mySeq);   // sengaja tanpa await: Search tidak menunggu unduhan video
      });
    } catch (err) {
      // Gagal: isian formulir TIDAK disentuh (tidak ada data manual yang hilang)
      setStatus('error', err.message, err.details?.hint || 'Anda tetap bisa mengisi produk secara manual.');
    } finally { searching = false; }
  }

  searchBtn.addEventListener('click', search);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); });

  return { pending: () => videoLoading, onMediaChange };
}
