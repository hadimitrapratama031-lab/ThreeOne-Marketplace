/* Mode "Otomatis (Steam App ID)" pada form Tambah produk DAN Ubah produk (satu modul, satu integrasi Steam).
   Alur: App ID -> Search (backend) -> isi formulir -> admin review/edit -> Simpan (alur produk yang sudah ada).
   Modul ini hanya mengisi kolom formulir yang sama dengan mode Manual; tidak ada form kedua.
   Mode Ubah (editing): data yang sudah tersimpan diperlakukan sebagai data admin. Tidak ada yang ditimpa tanpa konfirmasi,
   data yang tidak disediakan Steam tidak pernah menghapus data lama, dan menutup dialog berarti tidak ada yang berubah. */
import { $, html, mount, icon, dialog, busy, esc } from '../ui.js';
import { api } from '../api.js';

const MSG = {
  searching: 'Searching Steam...',
  found: 'Game ditemukan',
  partialMeta: 'Game ditemukan, tetapi beberapa metadata tidak tersedia.',
  partialMedia: 'Game ditemukan, beberapa media tidak tersedia.',
  partialBoth: 'Game ditemukan, beberapa media dan metadata tidak tersedia.',
  invalid: 'Steam App ID tidak valid.',
  noVideo: 'Video tidak tersedia, silakan upload manual.',
  cancelled: 'Dibatalkan. Data produk tidak diubah.',
};
const BADGE = '✓ Data from Steam';
const MEDIA_FIELDS = new Set(['image', 'screenshots', 'video']);

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
            <label><input type="radio" name="media" value="keep" checked><span>Biarkan galeri seperti sekarang</span></label>
            <label><input type="radio" name="media" value="append"><span>Tambahkan media Steam di belakang <small>Gambar utama tidak berubah; trailer Steam yang sudah ada di galeri tidak digandakan.</small></span></label>
            <label><input type="radio" name="media" value="replace"><span>Ganti gambar galeri dengan media Steam <small>Video yang sudah ada tetap dipertahankan. File gambar lama baru dilepas saat Anda menekan Simpan perubahan.</small></span></label>
          </fieldset>` : ''}
        <p class="muted">Hasil Steam masih bisa Anda ubah sebelum disimpan. Menutup dialog ini tidak mengubah apa pun.</p>`,
      foot: fields.length
        ? html`<button type="button" class="btn" data-keep>Isi yang kosong saja</button><button type="button" class="btn btn--primary" data-over>Timpa dengan data Steam</button>`
        : html`<button type="button" class="btn" data-close>Batal</button><button type="button" class="btn btn--primary" data-keep>Terapkan</button>`,
    });
    let result = null;
    const pick = (overwrite) => {
      result = { overwrite, media: d.form.querySelector('input[name="media"]:checked')?.value || 'keep' };
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

  const steamKeys = new Set();   // key aset (R2, status temp) yang berasal dari Steam pada form ini
  let heroKey = null;            // key gambar utama dari Steam (bila masih ada di galeri)
  let seq = 0;                   // setiap Search baru membatalkan hasil unduhan video pencarian sebelumnya
  let searching = false;
  let videoLoading = false;
  let view = null;               // { item, videoKeys[], videoMsg, videoFailed, videoLoaded, videoMissed, videoReason }
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
    const mediaGap = !view.mediaKept && (view.videoFailed || item.warnings.some((w) => MEDIA_FIELDS.has(w.field) && (w.field !== 'video' || !item.video.available)));
    const metaGap = item.warnings.some((w) => !MEDIA_FIELDS.has(w.field));
    const text = mediaGap && metaGap ? MSG.partialBoth : mediaGap ? MSG.partialMedia : metaGap ? MSG.partialMeta : MSG.found;
    setStatus(mediaGap || metaGap ? 'warn' : 'ok', text, item.name);
  }

  const chip = (ok, label) => html`<li class="chip ${ok ? 'chip--ok' : 'chip--miss'}">${icon(ok ? 'check' : 'alert')}${label}${ok ? '' : html` <span class="sr-only">tidak tersedia</span>`}</li>`;

  function renderCard() {
    if (!view) { mount(cardEl, ''); return; }
    const { item } = view;
    const items = media.items();
    const mine = items.filter((m) => steamKeys.has(m.key));
    const hero = mine.find((m) => m.key === heroKey) || (view.mediaKept ? item.image : null);   // galeri dibiarkan: tetap tampilkan pratinjau gambar Steam
    const shots = mine.filter((m) => m.type === 'image' && m.key !== heroKey);
    const vids = view.videoKeys.map((k) => items.find((m) => m.key === k)).filter(Boolean);
    const vidTotal = item.video.count;
    const vidLabel = vidTotal ? `Video (${vids.length}${vids.length === vidTotal ? '' : `/${vidTotal}`})` : 'Video';

    const notes = item.warnings.filter((w) => w.field !== 'video').map((w) => w.message);
    const cat = item.categoryMatch
      ? `Kategori diisi “${item.categoryMatch.name}” (cocok dengan genre ${item.categoryMatch.via}).`
      : item.info.genres.length ? `Genre Steam: ${item.info.genres.join(', ')}. Tidak ada kategori toko dengan nama yang sama; pilih kategori secara manual.` : '';
    if (cat) notes.push(cat);
    if (view.mediaKept) notes.unshift('Galeri produk tidak diubah, media Steam tidak dipakai.');

    mount(cardEl, html`
      <div class="steam-card">
        <div class="steam-card__img">${hero ? html`<img src="${hero.url}" alt="Gambar utama dari Steam">` : html`<span>${icon('image')}${item.image ? 'Gambar utama dihapus dari galeri' : 'Gambar utama tidak tersedia'}</span>`}</div>
        <div class="steam-card__body">
          <b>${item.name || 'Tanpa nama'}</b>
          <small>App ID ${item.appId}, <a href="${item.storeUrl}" target="_blank" rel="noopener noreferrer">buka di Steam</a></small>
          <ul class="chips">
            ${view.mediaKept ? '' : html`${chip(Boolean(hero), 'Gambar utama')}${chip(shots.length > 0, `Screenshot (${shots.length})`)}${chip(vids.length > 0 || videoLoading, vidLabel)}`}
            ${chip(Boolean(item.about || item.description), 'Deskripsi')}${chip(item.specs.min.length > 0, 'Spek minimum')}${chip(item.specs.rec.length > 0, 'Spek disarankan')}
          </ul>
          ${notes.length ? html`<ul class="steam-notes">${notes.map((m) => html`<li>${m}</li>`)}</ul>` : ''}
        </div>
        ${shots.length ? html`<ul class="steam-card__shots" aria-label="Screenshot dari Steam">${shots.map((m, i) => html`<li><img src="${m.url}" alt="Screenshot ${i + 1}" loading="lazy"></li>`)}</ul>` : ''}
        <div class="steam-card__video">
          ${vids.map((v, i) => html`<video controls preload="metadata" src="${v.url}" aria-label="Pratinjau video Steam ${i + 1}"></video>`)}
          ${videoLoading ? html`<p class="steam__status is-busy">Mengunduh video dari Steam (${view.videoLoaded + view.videoMissed}/${vidTotal})...</p>`
    : view.videoMsg ? html`<p class="steam__status is-warn">${view.videoMsg}</p>` : ''}
        </div>
      </div>`);
  }

  // Dipanggil media manager bila admin menambah/menghapus/mengurutkan/mengganti file
  function onMediaChange() {
    const keys = new Set(media.items().map((m) => m.key));
    for (const k of [...steamKeys]) if (!keys.has(k)) steamKeys.delete(k);
    if (heroKey && !keys.has(heroKey)) heroKey = null;
    if (!media.items().some((m) => steamKeys.has(m.key))) unmark(labelOf.media());
    if (view?.videoKeys.length) {
      view.videoKeys = view.videoKeys.filter((k) => keys.has(k));
      if (!view.videoKeys.length && !videoLoading) view.videoMsg = 'Video dihapus dari galeri. Unggah video manual bila perlu.';
    }
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
    const steamHasMedia = Boolean(item.image || item.screenshots.length || item.video.available);
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

  /** Gambar utama + SEMUA screenshot Steam masuk galeri (gambar utama = urutan pertama, screenshot menyusul sesuai urutan Steam).
   *  Mode:
   *   fill    : Tambah produk / galeri kosong. File manual tidak disentuh dan tetap di belakang; hasil Steam sebelumnya diganti.
   *   keep    : (Ubah) galeri tidak disentuh sama sekali.
   *   append  : (Ubah) media Steam ditambahkan di belakang; urutan dan gambar utama yang ada tidak berubah.
   *   replace : (Ubah) GAMBAR galeri diganti media Steam. Hanya bila ada gambar Steam yang berhasil disiapkan, supaya galeri tidak pernah dikosongkan.
   *             Video yang sudah ada (manual, atau salinan Steam dari penyimpanan sebelumnya) TIDAK dihapus: Steam yang tidak menyediakan
   *             trailer tidak boleh menghilangkan video admin, dan trailer Steam yang sama tidak digandakan (lihat loadVideos).
   *  Mengembalikan mode yang benar-benar dipakai. */
  function applyMedia(item, mode = 'fill') {
    const take = [...(item.image ? [item.image] : []), ...item.screenshots];
    if (mode === 'replace' && !take.length) mode = 'append';
    if (mode === 'keep') return 'keep';

    if (mode === 'append') {
      const have = new Set(media.items().map((m) => m.key));
      const fresh = take.filter((m) => !have.has(m.key));   // Search ulang memakai aset temp yang sama: jangan dobel
      for (const m of fresh) steamKeys.add(m.key);
      if (item.image) heroKey = item.image.key;
      if (fresh.length) media.set([...media.items(), ...fresh]);
    } else {
      const manual = media.items().filter((m) => !steamKeys.has(m.key) && (mode !== 'replace' || m.type === 'video'));
      steamKeys.clear(); heroKey = null;
      for (const m of take) steamKeys.add(m.key);
      if (item.image) heroKey = item.image.key;
      media.set([...take, ...manual]);
    }
    if (steamKeys.size) mark('media'); else unmark(labelOf.media());
    return mode;
  }

  /** Unduh SEMUA video Steam satu per satu (urutan Steam; trailer utama lebih dulu). Tiap video yang selesai langsung
   *  ditambahkan ke galeri, jadi admin melihat kemajuannya. Satu video gagal tidak menghentikan yang lain. */
  async function loadVideos(item, mySeq) {
    const total = item.video.count;
    videoLoading = true; view.videoMsg = ''; renderCard();
    for (let movie = 0; movie < total; movie++) {
      let res = null; let err = '';
      // `have`: video yang saat ini ada di galeri. Server mengenali salinan movie Steam yang sama (mis. produk sudah menyimpan trailer ini) dan tidak mengunduhnya lagi.
      const have = media.items().filter((m) => m.type === 'video').map((m) => m.key);
      try { res = await api.post(`/steam/${item.appId}/video`, { movie, have }); } catch (e) { err = e.message || ''; }
      if (mySeq !== seq) return;   // sudah ada pencarian baru: hasil ini dibuang (aset 'temp' dibersihkan sweeper)
      if (res?.duplicate) {
        // Trailer ini sudah ada di galeri: dihitung tersedia, tidak ditambahkan lagi
        if (res.existing && !view.videoKeys.includes(res.existing) && media.items().some((m) => m.key === res.existing)) view.videoKeys.push(res.existing);
        view.videoLoaded++;
      } else if (res?.video) {
        // Search ulang memakai aset 'temp' yang sama (key identik): jangan masukkan dua kali (server menolak key ganda)
        if (!media.items().some((m) => m.key === res.video.key)) media.set([...media.items(), res.video]);
        steamKeys.add(res.video.key);
        view.videoKeys.push(res.video.key);
        view.videoLoaded++;
        mark('media');
      } else {
        view.videoMissed++;
        view.videoReason ||= res?.message || err;
      }
      renderCard();
    }
    videoLoading = false;
    view.videoFailed = view.videoMissed > 0;
    view.videoMsg = !view.videoMissed ? ''
      : view.videoLoaded ? `${view.videoMissed} dari ${total} video Steam tidak dapat diambil (gagal diunduh atau terlalu besar). Unggah manual bila perlu.`
        : view.videoReason || MSG.noVideo;
    refreshStatus();
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
        view = { item, videoKeys: [], videoMsg: item.video.available ? '' : MSG.noVideo, videoFailed: false, videoLoaded: 0, videoMissed: 0, videoReason: '', mediaKept: false };
        const mode = await apply(item);
        if (mySeq !== seq) return;
        if (mode === false) { view = null; setStatus('warn', MSG.cancelled); renderCard(); return; }   // mode Ubah: dialog ditutup
        view.mediaKept = mode === 'keep';
        if (view.mediaKept) view.videoMsg = '';
        refreshStatus();
        renderCard();
        if (item.video.available && !view.mediaKept) loadVideos(item, mySeq);   // sengaja tanpa await: Search tidak menunggu unduhan video
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
