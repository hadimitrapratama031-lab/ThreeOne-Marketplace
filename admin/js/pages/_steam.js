/* Mode "Otomatis (Steam App ID)" pada form Tambah produk DAN Ubah produk (satu modul, satu integrasi Steam).
   Alur: App ID -> Search (backend) -> isi formulir -> admin review/edit -> Simpan (alur produk yang sudah ada).
   Modul ini hanya mengisi kolom formulir yang sama dengan mode Manual; tidak ada form kedua.
   Mode Ubah (editing): data yang sudah tersimpan diperlakukan sebagai data admin. Tidak ada yang ditimpa tanpa konfirmasi,
   data yang tidak disediakan Steam tidak pernah menghapus data lama, dan menutup dialog berarti tidak ada yang berubah.
   MEDIA: screenshot & video Steam disimpan sebagai REFERENSI URL asli Steam ({ source:'steam', url }), tidak diunduh dan tidak diupload ke R2.
   Hanya gambar utama dari Steam yang masih berupa aset R2 'temp' (sistem lama). Media upload manual Admin tidak pernah disentuh modul ini. */
import { $, html, mount, icon, dialog, busy, esc } from '../ui.js';
import { api } from '../api.js';

const MSG = {
  searching: 'Searching Steam...',
  found: 'Game ditemukan',
  partialMeta: 'Game ditemukan, tetapi beberapa metadata tidak tersedia.',
  partialMedia: 'Game ditemukan, beberapa media tidak tersedia.',
  partialBoth: 'Game ditemukan, beberapa media dan metadata tidak tersedia.',
  invalid: 'Steam App ID tidak valid.',
  cancelled: 'Dibatalkan. Data produk tidak diubah.',
};
const BADGE = '✓ Data from Steam';
const MEDIA_FIELDS = new Set(['image', 'screenshots', 'video', 'videoSkipped']);

const isSteam = (m) => m.source === 'steam';
const base = (u) => String(u || '').split('?')[0];            // `?t=` berubah tiap Steam memperbarui aset; path tetap
const sameSteam = (a, b) => isSteam(a) && a.type === b.type && (a.type === 'video' && a.ref && b.ref ? a.ref === b.ref : base(a.url) === base(b.url));
const MIME = { mp4: 'video/mp4', webm: 'video/webm', hls: 'application/vnd.apple.mpegurl' };

// Kolom teks yang diisi dari Steam: [nama input, label untuk dialog timpa, nilai dari hasil Search]
const TEXT_FIELDS = [
  ['name', 'Nama produk', (i) => i.name],
  ['description', 'Deskripsi singkat', (i) => i.description],
  ['about', 'Deskripsi lengkap', (i) => i.about],
  ['gameInfo.steamAppId', 'Steam App ID', (i) => i.appId],
  ['gameInfo.developer', 'Developer', (i) => i.info.developer],
  ['gameInfo.publisher', 'Publisher', (i) => i.info.publisher],
  ['gameInfo.releaseDate', 'Tanggal rilis', (i) => i.info.releaseDate],
  ['gameInfo.genres', 'Genre', (i) => i.info.genres.join(', ')],
  ['gameInfo.metacritic', 'Metacritic', (i) => (i.info.metacritic == null ? '' : String(i.info.metacritic))],
];

export const steamSourceBlock = ({ editing = false, appId = '' } = {}) => html`
  <div class="fieldset">
    <h3>Sumber produk</h3>
    <div class="seg" role="group" aria-label="Sumber produk">
      <button type="button" class="seg__btn" data-src="manual" aria-pressed="true">Manual</button>
      <button type="button" class="seg__btn" data-src="steam" aria-pressed="false">Otomatis (Steam App ID)</button>
    </div>
    <div class="steam" data-steam hidden>
      <div class="steam__row">
        <label class="field"><span>Steam App ID</span><input data-steam-id inputmode="numeric" maxlength="10" autocomplete="off" placeholder="mis. 1245620" value="${appId}" aria-describedby="steam-status"></label>
        <button type="button" class="btn btn--primary" data-steam-search>${icon('search')}Search</button>
      </div>
      ${editing ? html`<p class="hint muted">Data produk yang sudah ada tidak diganti tanpa konfirmasi, dan data yang tidak disediakan Steam tidak dihapus. Harga, stok, status, dan jumlah terjual tidak disentuh.</p>` : ''}
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

/** Dialog mode Ubah. Mengembalikan { overwrite, media: 'keep'|'append'|'replace' }, atau null bila admin menutup dialog (tidak ada yang diubah). */
function askEdit({ fields, gallery }) {
  return new Promise((resolve) => {
    const d = dialog({
      title: 'Terapkan data Steam ke produk ini?',
      body: html`
        ${fields.length ? html`<p>Kolom berikut sudah berisi data: <b>${fields.join(', ')}</b>.</p>` : ''}
        ${gallery ? html`
          <fieldset class="merge-media">
            <legend>Galeri sudah berisi ${gallery} media</legend>
            <label><input type="radio" name="media" value="append" checked><span>Perbarui media Steam <small>Screenshot &amp; video Steam yang baru ditambahkan, yang sudah ada diperbarui (tidak digandakan). Media upload manual dan gambar utama tidak berubah.</small></span></label>
            <label><input type="radio" name="media" value="replace"><span>Ganti semua media Steam di galeri dengan hasil terbaru <small>Hanya media bersumber Steam yang diganti; media upload manual tidak dihapus.</small></span></label>
            <label><input type="radio" name="media" value="keep"><span>Biarkan galeri seperti sekarang</span></label>
          </fieldset>` : ''}
        <p class="muted">Hasil Steam masih bisa Anda ubah sebelum disimpan. Menutup dialog ini tidak mengubah apa pun.</p>`,
      foot: fields.length
        ? html`<button type="button" class="btn" data-keep>Isi yang kosong saja</button><button type="button" class="btn btn--primary" data-over>Timpa dengan data Steam</button>`
        : html`<button type="button" class="btn" data-close>Batal</button><button type="button" class="btn btn--primary" data-keep>Terapkan</button>`,
    });
    let result = null;
    const pick = (overwrite) => {
      result = { overwrite, media: d.form.querySelector('input[name="media"]:checked')?.value || 'append' };
      d.close();
    };
    $('[data-keep]', d.el).addEventListener('click', () => pick(false));
    $('[data-over]', d.el)?.addEventListener('click', () => pick(true));
    d.closed.then(() => resolve(result));
    $('[data-keep]', d.el).focus();
  });
}

/**
 * @param {HTMLFormElement} f  form produk
 * @param {{ media, setSpecRows(kind, rows), readSpecs(kind), onCount() }} deps
 * Semua screenshot & semua video yang disediakan Steam masuk galeri; tidak ada batas jumlah.
 */
export function initSteam(f, { media, setSpecRows, readSpecs, onCount, editing = false }) {
  const panel = $('[data-steam]', f);
  const input = $('[data-steam-id]', f);
  const searchBtn = $('[data-steam-search]', f);
  const statusEl = $('[data-steam-status]', f);
  const cardEl = $('[data-steam-card]', f);
  const categoryEl = f.elements.category;

  let heroKey = null;            // key gambar utama dari Steam (aset R2 'temp'), bila masih ada di galeri
  let searching = false;
  let view = null;               // { item, mediaKept }
  let overwriteAll = false;

  /* ---------- Mode ---------- */
  f.addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    for (const x of f.querySelectorAll('[data-src]')) x.setAttribute('aria-pressed', String(x === b));
    panel.hidden = b.dataset.src !== 'steam';
    if (!panel.hidden) input.focus();
  });
  // Kategori default = opsi pertama. Hanya kategori yang dipilih admin sendiri yang dianggap "data manual".
  categoryEl.addEventListener('change', () => { categoryEl.dataset.touched = '1'; });

  /* ---------- Indikator "Data from Steam" ---------- */
  const labelOf = {
    min: () => $('[data-spec-list="min"]', f).closest('.field').firstElementChild,
    rec: () => $('[data-spec-list="rec"]', f).closest('.field').firstElementChild,
    media: () => $('#media-host', f).closest('.fieldset').querySelector('h3'),
  };
  const labelEl = (key) => (labelOf[key] ? labelOf[key]() : f.elements[key].closest('.field').firstElementChild);
  const mark = (key) => {
    const l = labelEl(key);
    if (l.querySelector('.from-steam')) return;
    const i = document.createElement('i');
    i.className = 'from-steam';
    i.textContent = BADGE;
    l.append(' ', i);
  };
  const unmark = (el) => el?.querySelector('.from-steam')?.remove();
  // Admin mengubah kolom -> data tidak lagi persis dari Steam, indikator dilepas
  f.addEventListener('input', (e) => { const field = e.target.closest('.field'); if (field && !e.target.matches('[data-steam-id]')) unmark(field.firstElementChild); });

  /* ---------- Status & kartu pratinjau ---------- */
  function setStatus(kind, text, detail = '') {
    statusEl.className = `steam__status is-${kind}`;
    statusEl.innerHTML = text ? `${esc(text)}${detail ? ` <small>${esc(detail)}</small>` : ''}` : '';
  }

  // "App ID valid" dan "data/media tidak lengkap" adalah dua hal berbeda: di sini game SUDAH ditemukan.
  function refreshStatus() {
    if (!view) return;
    const { item } = view;
    const mediaGap = !view.mediaKept && item.warnings.some((w) => MEDIA_FIELDS.has(w.field));
    const metaGap = item.warnings.some((w) => !MEDIA_FIELDS.has(w.field));
    const text = mediaGap && metaGap ? MSG.partialBoth : mediaGap ? MSG.partialMedia : metaGap ? MSG.partialMeta : MSG.found;
    setStatus(mediaGap || metaGap ? 'warn' : 'ok', text, item.name);
  }

  const chip = (ok, label) => html`<li class="chip ${ok ? 'chip--ok' : 'chip--miss'}">${icon(ok ? 'check' : 'alert')}${label}${ok ? '' : html` <span class="sr-only">tidak tersedia</span>`}</li>`;
  const sourceTags = (m) => (m.sources || []).filter((x) => MIME[x.format]).map((x) => html`<source src="${x.url}" type="${MIME[x.format]}">`);

  function renderCard() {
    if (!view) { mount(cardEl, ''); return; }
    const { item } = view;
    const items = media.items();
    const hero = items.find((m) => m.key && m.key === heroKey) || (view.mediaKept ? item.image : null);   // galeri dibiarkan: tetap tampilkan pratinjau gambar Steam
    const shots = items.filter((m) => isSteam(m) && m.type === 'image');
    const vids = items.filter((m) => isSteam(m) && m.type === 'video');
    const shotTotal = item.screenshots.length;
    const vidTotal = item.videos.length;
    const count = (n, total) => (total ? `${n}${n === total ? '' : `/${total}`}` : `${n}`);

    const notes = item.warnings.filter((w) => w.field !== 'video').map((w) => w.message);
    const cat = item.categoryMatch
      ? `Kategori diisi “${item.categoryMatch.name}” (cocok dengan genre ${item.categoryMatch.via}).`
      : item.info.genres.length ? `Genre Steam: ${item.info.genres.join(', ')}. Tidak ada kategori toko dengan nama yang sama; pilih kategori secara manual.` : '';
    if (cat) notes.push(cat);
    if (view.mediaKept) notes.unshift('Galeri produk tidak diubah, media Steam tidak dipakai.');
    else if (shots.length || vids.length) notes.push('Screenshot & video dipakai langsung dari URL Steam (tidak disalin ke penyimpanan toko).');

    mount(cardEl, html`
      <div class="steam-card">
        <div class="steam-card__img">${hero ? html`<img src="${hero.url}" alt="Gambar utama dari Steam">` : html`<span>${icon('image')}${item.image ? 'Gambar utama dihapus dari galeri' : 'Gambar utama tidak tersedia'}</span>`}</div>
        <div class="steam-card__body">
          <b>${item.name || 'Tanpa nama'}</b>
          <small>App ID ${item.appId}, <a href="${item.storeUrl}" target="_blank" rel="noopener noreferrer">buka di Steam</a></small>
          <ul class="chips">
            ${view.mediaKept ? '' : html`${chip(Boolean(hero), 'Gambar utama')}${chip(shots.length > 0, `Screenshot (${count(shots.length, shotTotal)})`)}${chip(vids.length > 0, `Video (${count(vids.length, vidTotal)})`)}`}
            ${chip(Boolean(item.about || item.description), 'Deskripsi')}${chip(item.specs.min.length > 0, 'Spek minimum')}${chip(item.specs.rec.length > 0, 'Spek disarankan')}
          </ul>
          ${notes.length ? html`<ul class="steam-notes">${notes.map((m) => html`<li>${m}</li>`)}</ul>` : ''}
        </div>
        ${shots.length ? html`<ul class="steam-card__shots" aria-label="Screenshot dari Steam">${shots.map((m, i) => html`<li><img src="${m.url}" alt="Screenshot ${i + 1}" loading="lazy"></li>`)}</ul>` : ''}
        ${vids.length ? html`<div class="steam-card__video">
          ${vids.map((v, i) => html`<video controls preload="none" ${v.poster ? html`poster="${v.poster}"` : ''} aria-label="Pratinjau video Steam ${i + 1}">${sourceTags(v)}</video>`)}
        </div>` : ''}
      </div>`);
  }

  // Dipanggil media manager bila admin menambah/menghapus/mengurutkan/mengganti file
  function onMediaChange() {
    const items = media.items();
    if (heroKey && !items.some((m) => m.key === heroKey)) heroKey = null;
    if (!items.some(isSteam) && !heroKey) unmark(labelOf.media());
    renderCard();
  }

  /* ---------- Isi formulir ---------- */
  async function apply(item) {
    const cur = {}; const next = {}; const label = {};
    for (const [name, lab, get] of TEXT_FIELDS) { cur[name] = f.elements[name].value.trim(); next[name] = get(item); label[name] = lab; }
    cur.min = readSpecs('min'); next.min = item.specs.min; label.min = 'Persyaratan minimum';
    cur.rec = readSpecs('rec'); next.rec = item.specs.rec; label.rec = 'Persyaratan disarankan';
    // Tambah: kategori default (opsi pertama) bukan data admin. Ubah: kategori yang tersimpan adalah data yang ada.
    cur.category = editing || categoryEl.dataset.touched ? categoryEl.value : ''; next.category = item.categoryMatch?.id || ''; label.category = 'Kategori';

    const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : !v);
    const same = (k) => (Array.isArray(next[k]) ? sameRows(cur[k], next[k]) : cur[k] === next[k]);
    const hasNew = (k) => !isEmpty(next[k]);
    const conflicts = Object.keys(next).filter((k) => hasNew(k) && !isEmpty(cur[k]) && !same(k));

    // Hanya kolom yang datang dari Steam yang disentuh; kolom lain (harga, stok, dst.) tidak pernah diubah di sini.
    const steamHasMedia = Boolean(item.image || item.screenshots.length || item.videos.length);
    const galleryCount = editing ? media.items().length : 0;
    let mediaMode = 'fill';   // fill = perilaku Tambah produk (Steam di depan, file manual tetap di belakang)
    if (editing) {
      const askGallery = galleryCount > 0 && steamHasMedia;
      if (conflicts.length || askGallery) {
        const choice = await askEdit({ fields: conflicts.map((k) => label[k]), gallery: askGallery ? galleryCount : 0 });
        if (!choice) return false;   // dialog ditutup: tidak ada yang diubah
        overwriteAll = choice.overwrite;
        if (askGallery) mediaMode = choice.media;   // galeri kosong: tetap 'fill' (tidak ada yang bisa hilang)
      } else {
        overwriteAll = false;
      }
      if (galleryCount > 0 && !askGallery) mediaMode = 'keep';
    } else {
      overwriteAll = conflicts.length ? await askOverwrite(conflicts.map((k) => label[k])) : false;
    }
    const can = (k) => hasNew(k) && (overwriteAll || isEmpty(cur[k]) || same(k));

    for (const [name] of TEXT_FIELDS) if (can(name)) { f.elements[name].value = next[name]; mark(name); }
    if (can('category')) { categoryEl.value = next.category; mark('category'); }
    onCount();
    for (const k of ['min', 'rec']) if (can(k)) { setSpecRows(k, next[k]); mark(k); }
    if ((can('min') || can('rec')) && (overwriteAll || !f.elements.source.value.trim())) f.elements.source.value = item.specs.source;
    return applyMedia(item, mediaMode);
  }

  /** Media Steam masuk galeri sebagai REFERENSI URL asli Steam (tanpa unduh, tanpa R2). Hanya gambar utama yang berupa aset R2 'temp'.
   *  Gambar utama (bila ada) = urutan pertama, lalu SEMUA screenshot, lalu SEMUA video, sesuai urutan Steam.
   *  Mode:
   *   fill    : Tambah produk / galeri kosong. Media upload manual tidak disentuh dan tetap di belakang; hasil Search sebelumnya diganti.
   *   keep    : (Ubah) galeri tidak disentuh sama sekali.
   *   append  : (Ubah) media Steam diperbarui: yang sudah ada (path/ID sama) diperbarui di tempat (URL `?t=` baru), yang baru ditambahkan di belakang.
   *             Tidak ada duplikat; media manual, urutan, dan gambar utama yang ada tidak berubah; media Steam lama yang tidak lagi dikirim Steam tidak dihapus.
   *   replace : (Ubah) semua media bersumber Steam diganti hasil terbaru. Media upload manual TIDAK dihapus. Hanya bila Steam mengirim media,
   *             supaya galeri tidak pernah dikosongkan.
   *  Mengembalikan mode yang benar-benar dipakai. */
  function applyMedia(item, mode = 'fill') {
    const fresh = [...item.screenshots, ...item.videos];
    if (mode === 'replace' && !fresh.length) mode = 'append';
    if (mode === 'keep') return 'keep';
    const current = media.items();

    if (mode === 'append') {
      const next = [...current];
      for (const m of fresh) {
        const at = next.findIndex((x) => sameSteam(x, m));
        if (at >= 0) next[at] = m; else next.push(m);
      }
      media.set(next);
    } else if (mode === 'replace') {
      const kept = current.filter((m) => !isSteam(m));
      const needHero = item.image && !kept.some((m) => m.type === 'image');   // tidak ada gambar manual: gambar utama Steam jadi yang pertama
      if (needHero) heroKey = item.image.key;
      media.set([...(needHero ? [item.image] : []), ...kept, ...fresh]);
    } else {
      const manual = current.filter((m) => !isSteam(m) && !(m.key && m.key === heroKey));   // hasil Search sebelumnya (hero R2 + media Steam) diganti
      heroKey = item.image ? item.image.key : null;
      media.set([...(item.image ? [item.image] : []), ...fresh, ...manual]);
    }
    if (media.items().some(isSteam) || heroKey) mark('media'); else unmark(labelOf.media());
    return mode;
  }

  /* ---------- Search ---------- */
  async function search() {
    if (searching) return;
    const id = input.value.trim();
    if (!/^\d{1,10}$/.test(id) || Number(id) < 1) { setStatus('error', MSG.invalid, 'Isi angka saja, mis. 570 atau 1245620.'); input.focus(); return; }
    searching = true;
    setStatus('busy', MSG.searching);
    try {
      await busy(searchBtn, async () => {
        const { item } = await api.get(`/steam/${id}`);
        view = { item, mediaKept: false };
        const mode = await apply(item);
        if (mode === false) { view = null; setStatus('warn', MSG.cancelled); renderCard(); return; }   // mode Ubah: dialog ditutup
        view.mediaKept = mode === 'keep';
        refreshStatus();
        renderCard();
      });
    } catch (err) {
      // Gagal: isian formulir TIDAK disentuh (tidak ada data manual yang hilang)
      setStatus('error', err.message, err.details?.hint || 'Anda tetap bisa mengisi produk secara manual.');
    } finally { searching = false; }
  }

  searchBtn.addEventListener('click', search);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); });

  // pending(): tidak ada lagi unduhan video di latar belakang (video Steam hanya URL), jadi Simpan tidak perlu menunggu apa pun.
  return { pending: () => false, onMediaChange };
}
