/* ==========================================================================
   rating.js — halaman Rating  (rating.html)
   Satu sistem ulasan untuk seluruh Marketplace: data dari /api/public/reviews
   (MongoDB), foto dikirim ke server lalu disimpan di Cloudflare R2, dan daftar
   diperbarui realtime lewat Socket.IO (event "review:*" dari live.js/script.js).
   Memakai API, PRODUCTS, DATA, esc, $, $$ dari script.js.
   Daftar isi:
   1. Konstanta & helper
   2. Muat data (daftar + ringkasan)
   3. Render (ringkasan, filter, daftar, halaman)
   4. Form: bintang, validasi, foto, kirim
   5. Interaksi
   6. Realtime
   ========================================================================== */
(() => {
  /* 1. Konstanta & helper
     -------------------------------------------------------------------------- */
  const PER_PAGE = 8;
  const MAX_PHOTOS = 3;
  const MAX_BYTES = 8 * 1024 * 1024;           // sama dengan batas server (config.limits.imageBytes)
  const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
  const IMG_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
  const RATE_LABELS = ['Buruk', 'Kurang', 'Cukup', 'Bagus', 'Sangat bagus'];
  const desktop = matchMedia('(min-width: 901px)');

  const STAR = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4L2.8 9.3l6.4-.8z"/></svg>';
  const CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  const EMPTY_ICON = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4L2.8 9.3l6.4-.8z"/></svg>';

  const starsHTML = (n) => `<span class="stars" role="img" aria-label="Rating ${n} dari 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>`;
  const dateId = (iso) => new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  const el = {
    summary: $('#rv-summary'), bar: $('#rv-bar'), list: $('#rv-list'), pager: $('#rv-pager'),
    fProduct: $('#rv-filter-product'), fSort: $('#rv-sort'), fStars: $('#rv-stars-filter'),
    card: $('#rv-form-card'), open: $('#rv-open'), form: $('#rv-form'),
    product: $('#rv-product'), name: $('#rv-name'), text: $('#rv-text'), count: $('#rv-count'),
    rate: $('#rv-rate'), rateLabel: $('#rv-rate-label'),
    file: $('#rv-file'), drop: $('#rv-drop'), previews: $('#rv-previews'),
    note: $('#rv-note'), submit: $('#rv-submit'),
  };

  const q = { page: 1, productId: '', stars: '', sort: 'newest' };
  let view = 'loading';                       // loading | ready | error
  let data = { items: [], summary: { avg: null, total: 0, dist: {} }, total: 0, totalPages: 1 };
  let lastSig = '';
  let reqId = 0;
  let highlightId = null;
  let started = false;


  /* 2. Muat data
     -------------------------------------------------------------------------- */
  async function load() {
    const id = ++reqId;
    const params = new URLSearchParams({ page: q.page, limit: PER_PAGE, sort: q.sort });
    if (q.productId) params.set('productId', q.productId);
    if (q.stars) params.set('stars', q.stars);
    try {
      let res = await api('/reviews?' + params);
      if (id !== reqId) return;
      // Halaman sudah tidak ada (mis. ulasan terakhir di halaman ini baru dihapus admin)
      if (!res.items.length && q.page > 1) {
        q.page = res.totalPages;
        params.set('page', q.page);
        res = await api('/reviews?' + params);
        if (id !== reqId) return;
      }
      const sig = JSON.stringify([q.productId, q.stars, q.sort, res.items, res.summary, res.page, res.totalPages]);   // filter ikut dihitung: tampilan filter harus selalu mengikuti
      if (view === 'ready' && sig === lastSig) return;       // tidak ada perubahan: jangan render ulang
      lastSig = sig;
      data = res;
      view = 'ready';
    } catch {
      if (id !== reqId) return;
      if (view !== 'ready') view = 'error';                  // gagal sementara: tetap tampilkan data terakhir
      else return;
    }
    render();
  }

  let loadTimer;
  const loadSoon = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 150); };


  /* 3. Render
     -------------------------------------------------------------------------- */
  const productName = (id) => PRODUCTS.find((p) => String(p.id) === String(id))?.name || 'Produk ini';

  function renderSummary() {
    const s = data.summary;
    if (view !== 'ready' || !s.total) { el.summary.hidden = true; el.summary.innerHTML = ''; return; }
    el.summary.hidden = false;
    el.summary.innerHTML = `
      <p class="rv-summary__scope">${q.productId ? esc(productName(q.productId)) : 'Semua produk'}</p>
      <div class="rv-summary__body">
        <div class="rv-score">
          <b>${s.avg.toFixed(1)}</b>
          ${starsHTML(Math.round(s.avg))}
          <small>${s.total.toLocaleString('id-ID')} ulasan</small>
        </div>
        <div class="rv-dist" role="group" aria-label="Distribusi rating. Pilih untuk menyaring ulasan">
          ${[5, 4, 3, 2, 1].map((k) => {
            const n = s.dist[k] || 0;
            const on = String(q.stars) === String(k);
            return `<button type="button" class="rv-dist__row${on ? ' on' : ''}" data-stars="${k}" aria-pressed="${on}" aria-label="${k} bintang, ${n} ulasan">
              <span>${k} ★</span><i><b style="width:${(n / s.total * 100).toFixed(1)}%"></b></i><span>${n}</span>
            </button>`;
          }).join('')}
        </div>
      </div>`;
  }

  function renderBar() {
    // Bar filter disembunyikan selama memang belum ada satu pun ulasan
    el.bar.hidden = view === 'ready' && data.total === 0 && !q.productId && !q.stars;
    el.fStars.innerHTML = ['', 5, 4, 3, 2, 1].map((k) => {
      const on = String(q.stars) === String(k);
      return `<button class="filter${on ? ' on' : ''}" type="button" data-stars="${k}" aria-pressed="${on}">${k === '' ? 'Semua' : k + ' ★'}</button>`;
    }).join('');
    el.fProduct.value = q.productId;
    el.fSort.value = q.sort;
  }

  function itemHTML(r) {
    const p = r.product;
    const thumb = p?.imageUrl
      ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy" decoding="async" data-rv="thumb">`
      : `<span class="rv-product__ph" aria-hidden="true">${esc((p?.name || '?')[0])}</span>`;
    return `
      <article class="rv-item${r.id === highlightId ? ' is-new' : ''}" data-id="${esc(r.id)}">
        <header class="rv-item__head">
          <span class="rv-av" aria-hidden="true">${esc((r.name[0] || '?').toUpperCase())}</span>
          <div class="rv-who"><b>${esc(r.name)}</b><time datetime="${esc(r.date)}">${dateId(r.date)}</time></div>
          ${starsHTML(r.stars)}
        </header>
        <p class="rv-text">${esc(r.text)}</p>
        ${r.images.length ? `<div class="rv-shots">${r.images.map((m, k) => `
          <button class="pd-shot" type="button" data-r="${esc(r.id)}" data-k="${k}" aria-label="Perbesar foto ${k + 1} dari ${esc(r.name)}">
            <img src="${esc(m.url)}" alt="Foto ulasan dari ${esc(r.name)}" loading="lazy" decoding="async" data-rv="shot">
          </button>`).join('')}</div>` : ''}
        ${p ? `<a class="rv-product" href="product.html?id=${p.id}">${thumb}<span><small>Produk yang diulas</small><b>${esc(p.name)}</b></span>${CHEVRON}</a>` : ''}
      </article>`;
  }

  function emptyHTML() {
    const byProduct = q.productId && !q.stars;
    const filtered = q.productId || q.stars;
    const title = byProduct ? 'Belum ada ulasan untuk produk ini' : filtered ? 'Tidak ada ulasan yang cocok' : 'Belum ada ulasan';
    const text = byProduct ? 'Jadilah yang pertama membagikan pengalaman Anda dengan produk ini.'
      : filtered ? 'Coba ubah filter produk atau bintang.'
        : 'Jadilah yang pertama membagikan pengalaman Anda. Ulasan langsung tampil setelah dikirim.';
    const action = filtered && !byProduct
      ? '<button class="btn btn--soft" type="button" data-reset>Reset filter</button>'
      : '<button class="btn btn--primary" type="button" data-open-form>Tulis ulasan</button>';
    return `<div class="rv-empty"><span class="rv-empty__icon">${EMPTY_ICON}</span><h2>${title}</h2><p>${text}</p>${action}</div>`;
  }

  function pageList(page, total) {
    const nums = [];
    for (let i = 1; i <= total; i++) if (i === 1 || i === total || Math.abs(i - page) <= 1) nums.push(i);
    return nums.flatMap((n, i) => (i && n - nums[i - 1] > 1 ? ['…', n] : [n]));
  }

  function renderList() {
    if (view === 'loading') {
      el.list.innerHTML = Array.from({ length: 3 }, () => '<div class="rv-skel" aria-hidden="true"></div>').join('');
    } else if (view === 'error') {
      el.list.innerHTML = '<div class="rv-empty"><h2>Ulasan belum bisa dimuat</h2><p>Periksa koneksi Anda, lalu coba lagi.</p><button class="btn btn--primary" type="button" data-retry>Coba lagi</button></div>';
    } else {
      el.list.innerHTML = data.items.length ? data.items.map(itemHTML).join('') : emptyHTML();
    }
    const pages = view === 'ready' ? data.totalPages : 1;
    const page = data.page || 1;
    el.pager.innerHTML = pages > 1
      ? pageList(page, pages).map((n) => (n === '…'
        ? '<span class="pager__gap" aria-hidden="true">…</span>'
        : `<button class="filter${n === page ? ' on' : ''}" type="button" data-page="${n}"${n === page ? ' aria-current="page"' : ''}>${n}</button>`)).join('')
        + `<button class="filter" type="button" data-page="${page + 1}"${page === pages ? ' disabled' : ''}>Next</button>`
      : '';
  }

  function render() {
    renderSummary();
    renderBar();
    renderList();
    if (highlightId) {
      const id = highlightId;
      setTimeout(() => { if (highlightId === id) highlightId = null; }, 2600);
    }
  }

  // Opsi produk (form + filter) dari daftar produk Marketplace yang sedang tampil
  function populateProducts() {
    const list = [...PRODUCTS].sort((a, b) => a.name.localeCompare(b.name, 'id'));
    const options = (first) => `<option value="">${first}</option>` + list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const has = (v) => list.some((p) => String(p.id) === String(v));
    const chosen = el.product.value;
    el.product.innerHTML = options('Pilih produk yang diulas');
    el.product.value = has(chosen) ? chosen : '';
    if (q.productId && !has(q.productId)) q.productId = '';
    el.fProduct.innerHTML = options('Semua produk');
    el.fProduct.value = q.productId;
  }

  function scrollToList() {
    $('.rv-main').scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
  }


  /* 4. Form
     -------------------------------------------------------------------------- */
  // Bintang: radio asli (aman untuk keyboard & pembaca layar), tampilan diatur CSS + sedikit JS untuk pratinjau hover
  el.rate.innerHTML = [1, 2, 3, 4, 5].map((n) => `
    <input class="sr-only" type="radio" name="stars" id="rv-star-${n}" value="${n}">
    <label for="rv-star-${n}" title="${n} bintang, ${RATE_LABELS[n - 1]}"><span class="sr-only">${n} bintang, ${RATE_LABELS[n - 1]}</span>${STAR}</label>`).join('');
  const rateLabels = $$('label', el.rate);
  const checkedStars = () => Number(el.form.elements.stars.value) || 0;
  const paint = (n) => rateLabels.forEach((l, i) => l.classList.toggle('on', i < n));

  const CONTROLS = { productId: el.product, name: el.name, text: el.text };
  function setError(field, msg) {
    const wrap = $(`[data-field="${field}"]`, el.form);
    const out = $(`#err-${field}`);
    if (!wrap || !out) return;
    out.textContent = msg || '';
    wrap.classList.toggle('is-invalid', Boolean(msg));
    const ctrl = CONTROLS[field];
    if (ctrl) { if (msg) ctrl.setAttribute('aria-invalid', 'true'); else ctrl.removeAttribute('aria-invalid'); }
  }
  const clearErrors = () => ['productId', 'stars', 'name', 'text', 'images'].forEach((f) => setError(f, ''));

  function validate() {
    const e = {};
    if (!el.product.value) e.productId = 'Pilih produk yang diulas';
    if (!checkedStars()) e.stars = 'Pilih rating 1 sampai 5 bintang';
    const name = el.name.value.trim();
    if (name.length < 2) e.name = name ? 'Nama minimal 2 karakter' : 'Nama wajib diisi';
    const text = el.text.value.trim();
    if (text.length < 5) e.text = text ? 'Ulasan minimal 5 karakter' : 'Ulasan wajib diisi';
    return e;
  }

  function focusFirst(errors) {
    const order = ['productId', 'stars', 'name', 'text', 'images'];
    const first = order.find((k) => errors[k]);
    const target = first === 'stars' ? $('#rv-star-1') : first === 'images' ? el.file : CONTROLS[first];
    target?.focus();
  }

  // Koreksi langsung: pesan hilang begitu isian sudah benar
  el.product.addEventListener('change', () => { if (el.product.value) setError('productId', ''); });
  el.name.addEventListener('input', () => { if (el.name.value.trim().length >= 2) setError('name', ''); });
  el.text.addEventListener('input', () => {
    el.count.textContent = `${el.text.value.length} / 1000`;
    if (el.text.value.trim().length >= 5) setError('text', '');
  });

  el.rate.addEventListener('mouseover', (e) => { const l = e.target.closest('label'); if (l) paint(Number(l.htmlFor.slice(-1))); });
  el.rate.addEventListener('mouseleave', () => paint(checkedStars()));
  el.rate.addEventListener('change', () => {
    const n = checkedStars();
    paint(n);
    el.rateLabel.textContent = `${n} dari 5, ${RATE_LABELS[n - 1]}`;
    setError('stars', '');
  });

  /* Foto: pratinjau lokal (blob) sebelum dikirim; file baru diunggah ke R2 oleh server saat ulasan dikirim */
  let photos = [];                              // { id, file, url }
  let photoSeq = 0;

  function renderPhotos() {
    el.previews.innerHTML = photos.map((p) => `
      <li class="rv-preview" title="${esc(p.file.name)} (${fmtSize(p.file.size)})">
        <img src="${esc(p.url)}" alt="Pratinjau ${esc(p.file.name)}">
        <button type="button" class="rv-preview__x" data-remove="${p.id}" aria-label="Hapus foto ${esc(p.file.name)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </li>`).join('');
    const full = photos.length >= MAX_PHOTOS;
    el.drop.classList.toggle('is-full', full);
    el.file.disabled = full;
  }

  function addPhotos(fileList) {
    const problems = [];
    for (const file of fileList) {
      const okType = IMG_TYPES.includes(file.type) || (!file.type && IMG_EXT.test(file.name));
      if (!okType) { problems.push(`${file.name}: format tidak didukung (gunakan JPG, PNG, WebP, GIF atau AVIF)`); continue; }
      if (file.size > MAX_BYTES) { problems.push(`${file.name}: lebih dari ${MAX_BYTES / 1048576} MB`); continue; }
      if (photos.some((p) => p.file.name === file.name && p.file.size === file.size && p.file.lastModified === file.lastModified)) continue;
      if (photos.length >= MAX_PHOTOS) { problems.push(`Maksimal ${MAX_PHOTOS} foto per ulasan`); break; }
      photos.push({ id: ++photoSeq, file, url: URL.createObjectURL(file) });
    }
    setError('images', problems.join('. '));
    renderPhotos();
  }

  function removePhoto(id) {
    const i = photos.findIndex((p) => p.id === id);
    if (i < 0) return;
    URL.revokeObjectURL(photos[i].url);
    photos.splice(i, 1);
    setError('images', '');
    renderPhotos();
  }

  el.file.addEventListener('change', () => { addPhotos([...el.file.files]); el.file.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('is-over'); }));
  el.drop.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addPhotos([...e.dataTransfer.files]); });

  function resetForm() {
    el.form.reset();
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    photos = [];
    renderPhotos();
    clearErrors();
    paint(0);
    el.rateLabel.textContent = 'Pilih bintang';
    el.count.textContent = '0 / 1000';
  }

  /* Kirim: XMLHttpRequest supaya progres unggah foto nyata bisa ditampilkan */
  function send(fd, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fail = (message, status = 0, fields = {}) => reject(Object.assign(new Error(message), { status, fields }));
      xhr.open('POST', API + '/reviews');
      xhr.responseType = 'json';
      xhr.timeout = 120000;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        const body = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300 && body.item) resolve(body);
        else fail(body.error?.message || 'Ulasan gagal dikirim. Coba lagi.', xhr.status, body.error?.details?.fields || {});
      };
      xhr.onerror = () => fail('Tidak dapat terhubung ke server. Periksa koneksi Anda lalu coba lagi.');
      xhr.ontimeout = () => fail('Pengiriman terlalu lama. Periksa koneksi Anda lalu coba lagi.');
      xhr.send(fd);
    });
  }

  let sending = false;
  const label = $('.rv-submit__label', el.submit);
  function setBusy(on) {
    sending = on;
    el.submit.disabled = on;
    el.submit.classList.toggle('is-busy', on);
    el.submit.style.setProperty('--p', '0%');
    label.textContent = on ? 'Mengirim…' : 'Kirim ulasan';
  }
  function setProgress(f) {
    el.submit.style.setProperty('--p', Math.round(f * 100) + '%');
    label.textContent = f >= 1 ? 'Menyimpan…' : photos.length ? `Mengunggah ${Math.round(f * 100)}%` : 'Mengirim…';
  }

  function showNote(text) { el.note.textContent = text; el.note.hidden = !text; }

  let toastTimer;
  function toast(text) {
    let t = $('.rv-toast');
    if (!t) { t = document.createElement('div'); t.className = 'rv-toast'; t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = text;
    t.classList.add('is-in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-in'), 4200);
  }

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    showNote('');
    const errors = validate();
    clearErrors();
    Object.entries(errors).forEach(([k, v]) => setError(k, v));
    if (Object.keys(errors).length) { focusFirst(errors); return; }

    const fd = new FormData();
    fd.append('productId', el.product.value);
    fd.append('stars', String(checkedStars()));
    fd.append('name', el.name.value.trim());
    fd.append('text', el.text.value.trim());
    fd.append('website', el.form.elements.website.value);
    photos.forEach((p) => fd.append('images', p.file, p.file.name));

    setBusy(true);
    try {
      const { item } = await send(fd, setProgress);
      resetForm();
      toast('Ulasan terkirim dan sudah tampil.');
      // Pastikan ulasan baru terlihat: kembali ke semua produk, urutan terbaru, halaman 1
      Object.assign(q, { page: 1, productId: '', stars: '', sort: 'newest' });
      highlightId = item.id;
      if (!desktop.matches) closeForm();
      lastSig = '';                                // paksa gambar ulang agar sorotan ulasan baru muncul
      await load();
      scrollToList();
    } catch (err) {
      const fields = err.fields || {};
      const known = ['productId', 'stars', 'name', 'text', 'images'].filter((k) => fields[k]);
      known.forEach((k) => setError(k, fields[k]));
      if (known.length) focusFirst(fields); else showNote(err.message);
    } finally {
      setBusy(false);
    }
  });

  // Panel form (di mobile berupa panel yang dibuka lewat tombol "Tulis ulasan")
  function openForm({ product } = {}) {
    if (product && [...el.product.options].some((o) => o.value === String(product))) el.product.value = String(product);
    el.card.classList.add('is-open');
    el.open.setAttribute('aria-expanded', 'true');
    el.card.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: desktop.matches ? 'nearest' : 'start' });
    (el.product.value ? el.name : el.product).focus({ preventScroll: true });
  }
  function closeForm() {
    el.card.classList.remove('is-open');
    el.open.setAttribute('aria-expanded', 'false');
  }


  /* 5. Interaksi
     -------------------------------------------------------------------------- */
  const box = $('#pd-lightbox');
  const closeBox = () => {
    box.classList.remove('is-in');
    setTimeout(() => box.open && box.close(), prefersReducedMotion ? 0 : 250);
  };
  $('#pd-close').addEventListener('click', closeBox);
  box.addEventListener('click', (e) => { if (e.target === box) closeBox(); });
  box.addEventListener('close', () => box.classList.remove('is-in'));

  function openShot(reviewId, k) {
    const img = data.items.find((r) => r.id === reviewId)?.images[k];
    if (!img) return;
    $('#pd-lightbox-img').innerHTML = `<img src="${esc(img.url)}" alt="Foto ulasan">`;
    box.showModal();
    requestAnimationFrame(() => box.classList.add('is-in'));
  }

  function applyFilters() {
    q.page = 1;
    load();
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    const stars = t.closest('[data-stars]');
    if (stars) {
      q.stars = String(q.stars) === stars.dataset.stars ? '' : stars.dataset.stars;
      return applyFilters();
    }
    const pg = t.closest('[data-page]');
    if (pg && !pg.disabled) { q.page = Number(pg.dataset.page); load().then(scrollToList); return; }
    if (t.closest('[data-reset]')) { Object.assign(q, { productId: '', stars: '' }); return applyFilters(); }
    if (t.closest('[data-retry]')) { view = 'loading'; render(); return load(); }
    if (t.closest('[data-open-form]')) return openForm({ product: q.productId });
    const x = t.closest('[data-remove]');
    if (x) return removePhoto(Number(x.dataset.remove));
    const shot = t.closest('.pd-shot');
    if (shot) openShot(shot.dataset.r, Number(shot.dataset.k));
  });

  el.fProduct.addEventListener('change', () => { q.productId = el.fProduct.value; applyFilters(); });
  el.fSort.addEventListener('change', () => { q.sort = el.fSort.value; applyFilters(); });
  el.open.addEventListener('click', () => (el.card.classList.contains('is-open') ? closeForm() : openForm()));

  // Foto yang gagal dimuat (script.js sudah melaporkannya ke server): tampilkan pengganti yang rapi
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.rv) return;
    if (img.dataset.rv === 'shot') img.replaceWith(Object.assign(document.createElement('span'), { className: 'rv-broken', textContent: 'Foto tidak tersedia' }));
    else img.remove();
  }, true);


  /* 6. Realtime
     -------------------------------------------------------------------------- */
  // Daftar & ringkasan selalu diambil dari server (diindeks per id), jadi event ganda atau terlambat
  // tidak pernah menghasilkan ulasan duplikat. Perubahan identik tidak menggambar ulang (lihat load()).
  document.addEventListener('mp:change', (e) => {
    if (!started) return;
    const { entity } = e.detail;
    if (entity === 'review') loadSoon();
    else if (entity === 'product' || entity === 'category' || entity === 'sync') { populateProducts(); renderBar(); loadSoon(); }
    else if (entity === 'settings') document.title = `Rating & ulasan — ${DATA.brand}`;
  });


  /* Mulai
     -------------------------------------------------------------------------- */
  render();                                      // kerangka pemuatan
  renderPhotos();
  window.MP.ready.then(() => {
    document.title = `Rating & ulasan — ${DATA.brand}`;
    populateProducts();
    const params = new URLSearchParams(location.search);
    const wanted = params.get('product');
    if (wanted && [...el.product.options].some((o) => o.value === wanted)) el.product.value = wanted;
    if (location.hash === '#tulis' || wanted) openForm({ product: wanted });
  }).catch(() => {}).then(load).then(() => { started = true; });
})();
