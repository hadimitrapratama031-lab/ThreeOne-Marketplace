/* ==========================================================================
   product.js — Product Detail  (product.html?id=ID)
   Data dari /api/public/products/:id (MongoDB) dan diperbarui realtime.
   Halaman TIDAK menunggu jaringan untuk tampil: struktur langsung digambar dari data yang sudah ada (hasil prefetch / kunjungan
   sebelumnya / kartu produk dari cache daftar), lalu detail lengkap + ulasan halaman 1 (SATU request) melengkapi di belakang layar.
   Memakai DATA, PRODUCTS, api, esc, formatRupiah, artwork, productCard,
   observeReveals, settleIn, stockInfo, LOGO_SVG, $, $$ dari script.js.
   Daftar isi:
   1. Helper tampilan
   2. Muat data
   3. Render halaman
   4. Galeri (slider + video)
   5. Ulasan (pagination + lightbox)
   6. Realtime
   ========================================================================== */
(() => {
  const root = $('#pd-root');
  const pid = Number(new URLSearchParams(location.search).get('id'));
  const REVIEWS_PER_PAGE = 3;

  let view = 'loading';            // loading | ready | missing | error
  let partial = false;             // true = baru data kartu (galeri/spesifikasi/ulasan menyusul)
  let shownSig = '';               // pengaturan yang dipakai render terakhir
  const settingsSig = () => JSON.stringify([DATA.settings.productPage, DATA.settings.branding.name, DATA.settings.branding.logoUrl]);
  let p = null;                    // produk
  let summary = { avg: null, total: 0, dist: {} };
  let reviews = { items: [], page: 1, totalPages: 1 };
  let page = 1;
  let current = 0;                 // indeks galeri
  let slideTimer;

  /* 1. Helper tampilan
     -------------------------------------------------------------------------- */
  const ico = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const I = {
    prev: ico('m15 6-6 6 6 6'),
    next: ico('m9 6 6 6-6 6'),
    share: ico('M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14'),
  };
  const PLAY = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';

  // Logo kecil untuk strip platform di dasar panel pembelian
  const LOGO = {
    windows: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 2.3 6.5 1.4v6H0zM7.5 1.25 16 0v7.4H7.5zM0 8.4h6.5v6L0 13.7zM7.5 8.4H16V16l-8.5-1.2z"/></svg>',
    steam: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="7"/><circle cx="10" cy="6" r="2"/><path d="M2.4 9.6 6.2 11.2"/><circle cx="6.4" cy="11.3" r="1.3" fill="currentColor" stroke="none"/></svg>',
    store: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="4.5" fill="#a78bfa"/><text x="8" y="11.6" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="9.5" font-weight="700" fill="#140d2b">31</text></svg>',
  };

  // Ikon "store" di strip platform memakai Store logo dari Admin (Pengaturan). Badge "31" hanya cadangan bila logo belum diatur atau gagal dimuat.
  const platformLogo = (icon) => {
    if (icon !== 'store') return LOGO[icon] || '';
    const url = DATA.settings.branding.logoUrl;
    return url ? `<img class="pd-store-logo" src="${esc(url)}" alt="" height="16">` : LOGO.store;
  };
  document.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement && e.target.classList.contains('pd-store-logo')) e.target.outerHTML = LOGO.store;
  }, true);

  const stars = (n) => `<span class="stars" role="img" aria-label="Rating ${n} dari 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>`;
  const dateId = (iso) => new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

  // Media: gambar asli bila ada, kalau tidak (atau gagal dimuat) artwork placeholder
  const art = (m) => `<div class="pd-art" role="img" aria-label="${esc(m.alt)}">${artwork(m.seed)}</div>`;
  const pic = (m, lazy, high) => m.src
    ? `<img src="${esc(m.src)}" alt="${esc(m.alt)}"${lazy ? ' loading="lazy"' : ''}${high ? ' fetchpriority="high"' : ''} decoding="async" data-seed="${m.seed}">`
    : art(m);

  // Pratinjau video: frame dari file video itu sendiri (bukan aset poster terpisah), tampil di atas artwork.
  // Bila file gagal dimuat, elemen ini dibuang dan artwork di bawahnya tetap terlihat.
  // Video Steam membawa thumbnail resmi Steam (poster): dipakai langsung sebagai pratinjau, file video tidak dimuat sebelum diputar.
  const vframe = (m) => (m.poster
    ? `<img class="pd-vframe" src="${esc(m.poster)}" alt="" loading="lazy" decoding="async" aria-hidden="true">`
    : m.src ? `<video class="pd-vframe" src="${esc(m.src)}#t=0.5" muted playsinline preload="metadata" tabindex="-1" aria-hidden="true"></video>` : '');

  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.seed && !img.closest('.card__media')) {
      img.outerHTML = art({ seed: +img.dataset.seed, alt: img.alt });
    } else if ((img.tagName === 'VIDEO' || img.tagName === 'IMG') && img.classList.contains('pd-vframe')) {
      img.remove();
    }
  }, true);

  // Panggung & thumbnail berrasio tetap 16:9, jadi layout tidak bergeser apa pun ukuran medianya.
  // Gambar yang rasionya mendekati 16:9 (selisih <= 8%) diisi penuh (cover, pemotongan tipis). Rasio lain (header Steam 2,1:1,
  // banner sangat lebar, gambar portrait) tampil UTUH (contain) di atas salinan gambar yang sama yang diburamkan, tanpa bar kosong dan tanpa gepeng.
  const FIT_RATIO = 16 / 9;
  const FIT_TOLERANCE = 0.08;
  document.addEventListener('load', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.naturalWidth || !img.naturalHeight || !img.closest('.pd-slide, .pd-thumb')) return;
    img.dataset.fit = Math.abs(img.naturalWidth / img.naturalHeight / FIT_RATIO - 1) <= FIT_TOLERANCE ? 'cover' : 'contain';
  }, true);
  // Sumber latar buram: gambar itu sendiri, atau poster untuk video. Dipasang sebagai custom property pada wadah.
  const backdrop = (m) => {
    const src = m && (m.type === 'video' ? m.poster : m.src);
    return src && /^https?:\/\//i.test(src) ? `--bd:url('${encodeURI(src).replace(/'/g, '%27')}')` : '';
  };

  // Source video Steam (MP4/WebM/HLS) -> [{ url, type }] untuk <source>; browser memilih yang bisa diputar. Video upload manual: kosong (pakai src).
  const VIDEO_MIME = { mp4: 'video/mp4', webm: 'video/webm', hls: 'application/vnd.apple.mpegurl' };
  const VIDEO_RANK = { mp4: 0, webm: 1, hls: 2 };
  const playableSources = (m) => (Array.isArray(m.sources) ? m.sources : [])
    .filter((s) => s && VIDEO_MIME[s.format] && /^https:\/\//i.test(s.url))
    .sort((a, b) => VIDEO_RANK[a.format] - VIDEO_RANK[b.format])   // sort stabil: kualitas dari server dipertahankan di dalam satu format
    .map((s) => ({ url: s.url, type: VIDEO_MIME[s.format] }));

  const gallery = () => {
    const base = 1000 + p.id * 10;
    const items = p.media.map((m, i) => (m.type === 'video'
      ? { type: 'video', seed: base + i, src: m.url, poster: m.poster || null, sources: playableSources(m), alt: `Video ${p.name}` }
      : { type: 'image', seed: base + i, src: m.url, alt: `${p.name}, tampilan ${i + 1}` }));
    return items.length ? items : [{ type: 'image', seed: base, src: null, alt: p.name }];
  };

  const specBlock = (title, rows, cls) => `
    <div class="spec ${cls}">
      <h3>${title}</h3>
      <dl>${rows.map((r) => `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd></div>`).join('')}</dl>
    </div>`;

  function slideHTML(m) {
    if (m.type !== 'video') return pic(m, false, true);   // gambar utama: prioritas tertinggi
    return art(m) + vframe(m) + (m.src
      ? `<button class="pd-play" type="button" aria-label="Putar video">${PLAY}</button>`
      : '<p class="pd-note">Pratinjau video belum tersedia.</p>');
  }

  const flash = (el, text) => {
    const old = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = old; }, 1800);
  };


  /* 2. Muat data
     -------------------------------------------------------------------------- */
  // Terapkan respons detail (produk + ringkasan rating + ulasan halaman 1)
  function applyDetail(d) {
    p = d.product;
    summary = d.reviews;
    if (d.reviewPage && page === 1) reviews = d.reviewPage;
    partial = false;
    view = 'ready';
  }

  async function loadDetail() {
    try {
      const d = await loadProductDetail(pid);   // satu request bersama (hover/klik/halaman tidak pernah dobel)
      applyDetail(d);
      return d;
    } catch (err) {
      if (err.status === 404) { view = 'missing'; p = null; partial = false; }
      else if (view !== 'ready' || partial) { view = 'error'; partial = false; }   // kegagalan sementara: data lengkap terakhir tetap tampil
    }
    return null;
  }

  async function loadReviews() {
    if (view !== 'ready' || partial) return;
    try {
      reviews = await api(`/products/${pid}/reviews?page=${page}&limit=${REVIEWS_PER_PAGE}`);
      if (page > reviews.totalPages) { page = reviews.totalPages; reviews = await api(`/products/${pid}/reviews?page=${page}&limit=${REVIEWS_PER_PAGE}`); }
    } catch { /* biarkan daftar terakhir */ }
  }

  async function refresh({ settle = true } = {}) {
    const d = await loadDetail();
    // Ulasan halaman 1 sudah ikut di respons detail; request tambahan hanya bila sedang di halaman ulasan lain
    if (view === 'ready' && !(d?.reviewPage && page === 1)) await loadReviews();
    render({ settle });
  }

  // Produk dari kartu (daftar / cache): cukup untuk menggambar judul, harga, stok, kategori, gambar utama
  const fromCard = (c) => ({
    ...c, oldPrice: null, discount: 0, about: [], specs: { min: [], rec: [], source: '' },
    media: c.imageUrl ? [{ type: 'image', url: c.imageUrl }] : [],
  });


  /* 3. Render halaman
     -------------------------------------------------------------------------- */
  const skeletonHTML = () => `
      <div class="pd-top" role="status" aria-busy="true" aria-label="Memuat produk">
        <div class="pd-media"><div class="pd-stage"><span class="pd-skel pd-skel--fill"></span></div></div>
        <aside class="pd-buy" aria-hidden="true">
          <span class="pd-skel pd-skel--title"></span>
          <span class="pd-skel pd-skel--line"></span>
          <span class="pd-skel pd-skel--price"></span>
          <span class="pd-skel pd-skel--btn"></span>
          <span class="pd-skel pd-skel--btn"></span>
        </aside>
      </div>`;

  function renderState() {
    if (view === 'loading') {
      root.innerHTML = skeletonHTML();
      document.title = `Memuat produk… — ${DATA.brand}`;
      return;
    }
    const title = view === 'loading' ? 'Memuat produk…' : view === 'error' ? 'Produk belum bisa dimuat' : 'Produk tidak ditemukan';
    const text = view === 'loading' ? '' : view === 'error'
      ? 'Periksa koneksi Anda, lalu coba lagi.'
      : 'Produk yang Anda cari tidak tersedia atau tautannya sudah berubah.';
    root.innerHTML = `
      <div class="pd-empty enter">
        <h1 class="pd-title">${title}</h1>
        ${text ? `<p>${text}</p>` : ''}
        ${view === 'error' ? '<button class="btn btn--primary" type="button" data-retry>Coba lagi</button>' : view === 'missing' ? '<a class="btn btn--primary" href="index.html#product">Kembali ke Produk</a>' : ''}
      </div>`;
    document.title = `${title} — ${DATA.brand}`;
  }

  function summaryHTML() {
    if (!summary.total) return '';
    return `
      <div class="rsum">
        <div class="rsum__score">
          <b>${summary.avg.toFixed(1)}</b>${stars(Math.round(summary.avg))}
          <small>${summary.total} ulasan</small>
        </div>
        <div class="dist" role="group" aria-label="Distribusi rating">
          ${[5, 4, 3, 2, 1].map((k) => `
            <div><span>${k} ★</span><i><b style="width:${((summary.dist[k] || 0) / summary.total * 100).toFixed(1)}%"></b></i><span>${summary.dist[k] || 0}</span></div>`).join('')}
        </div>
      </div>`;
  }

  const relatedList = () => [
    ...PRODUCTS.filter((x) => x.id !== p.id && x.categoryId === p.categoryId),
    ...PRODUCTS.filter((x) => x.id !== p.id && x.categoryId !== p.categoryId),
  ].slice(0, 4);

  function updateRelated() {
    if (view !== 'ready') return;
    const list = $('#related .product-grid');
    const items = relatedList();
    if (!list || !items.length) { render({ settle: true }); return; }   // seksi muncul/hilang -> render penuh
    list.innerHTML = items.map(productCard).join('');
    settleIn($('#related'));
  }

  function render({ settle = false } = {}) {
    if (view !== 'ready') { renderState(); return; }

    const items = gallery();
    if (current >= items.length) current = 0;
    const [stockClass, stockLabel] = stockInfo(p.stock);
    const off = p.stock ? '' : ' disabled';
    const pp = DATA.settings.productPage;
    const related = relatedList();
    const about = [...(p.about.length ? p.about : (p.description ? [p.description] : [])), ...pp.notes];
    const hasSpecs = p.specs.min.length || p.specs.rec.length;
    const meta = [
      summary.total ? `<span><span class="pd-star" aria-hidden="true">★</span> <b>${summary.avg.toFixed(1)}</b></span>` : '',
      `<span>${esc(p.category)}</span>`,
      p.sold > 0 ? `<span>${p.sold.toLocaleString('id-ID')}+ terjual</span>` : '',
    ].join('');
    const trustTitle = pp.completedOrders > 0 ? `${pp.completedOrders.toLocaleString('id-ID')} pesanan selesai` : summary.total ? `${summary.avg.toFixed(1)} dari 5` : '';

    document.title = `${p.name} — ${DATA.brand}`;
    // Slide yang sama (mis. render ulang karena data lengkap tiba): pakai ulang node-nya agar gambar tidak berkedip
    const slideKey = `${items[current].type}|${items[current].src || ''}`;
    const prev = $('#pd-slide');
    const keep = prev && prev.dataset.key === slideKey && !$('video:not(.pd-vframe)', prev) ? [...prev.childNodes] : null;
    root.innerHTML = `
      <nav class="pd-crumb enter" aria-label="Breadcrumb" style="--d:.05s">
        <ol>
          <li><a href="index.html#home">Home</a></li>
          <li><a href="index.html#product">Catalogue</a></li>
          <li><span aria-current="page">${esc(p.name)}</span></li>
        </ol>
      </nav>

      <div class="pd-top">
        <div class="pd-media enter" style="--d:.15s">
          <div class="pd-stage" id="pd-stage" tabindex="0" role="group" aria-roledescription="carousel" aria-label="Galeri ${esc(p.name)}">
            <div class="pd-slide" id="pd-slide" data-key="${esc(slideKey)}" style="${esc(backdrop(items[current]))}">${slideHTML(items[current])}</div>
            ${items.length > 1 ? `
            <button class="pd-nav pd-nav--prev" id="pd-prev" type="button" aria-label="Media sebelumnya">${I.prev}</button>
            <button class="pd-nav pd-nav--next" id="pd-next" type="button" aria-label="Media berikutnya">${I.next}</button>
            <span class="pd-count" id="pd-count" aria-live="polite">${current + 1} / ${items.length}</span>` : ''}
          </div>
          ${items.length > 1 ? `
          <div class="pd-thumbs" id="pd-thumbs">
            ${items.map((m, i) => `
              <button class="pd-thumb${i === current ? ' on' : ''}" type="button" data-i="${i}"
                      aria-label="${m.type === 'video' ? 'Video produk' : 'Gambar ' + (i + 1)}"${i === current ? ' aria-current="true"' : ''} style="${esc(backdrop(m))}">
                ${m.type === 'video' ? art(m) + vframe(m) : pic(m, i > 0)}${m.type === 'video' ? `<span class="pd-thumb__play">${PLAY}</span>` : ''}
              </button>`).join('')}
          </div>` : ''}
        </div>

        <aside class="pd-buy enter" style="--d:.25s" aria-label="Pembelian">
          <h1 class="pd-title">${esc(p.name)}</h1>
          <div class="pd-meta">${meta}</div>

          <div class="pd-price">
            ${p.oldPrice ? `<div class="pd-price__old"><s>${formatRupiah(p.oldPrice)}</s><span class="pd-off">-${p.discount}%</span></div>` : ''}
            <strong class="pd-price__now">${formatRupiah(p.price)}</strong>
          </div>
          <p class="stock ${stockClass}">${stockLabel}</p>

          <div class="pd-payrow"><span>Pembayaran</span><b>QRIS</b></div>

          <div class="pd-actions">
            <button class="btn btn--primary" id="pd-buy" type="button"${off}>Beli Sekarang</button>
            <button class="btn btn--soft" id="pd-cart" type="button"${off}>Tambah ke Keranjang</button>
            <button class="pd-share" id="pd-share" type="button">${I.share}<span>Bagikan</span></button>
          </div>

          ${trustTitle ? `
          <a class="pd-trust" href="#reviews">
            <span><b>${trustTitle}</b>${summary.total ? `<small>${summary.avg.toFixed(1)} dari ${summary.total} ulasan pembeli</small>` : ''}</span>
            ${I.next}
          </a>` : ''}

          ${pp.platforms.length ? `
          <ul class="pd-methods" aria-label="Platform dan toko">
            ${pp.platforms.map((x) => `<li>${platformLogo(x.icon)}<span>${esc(x.label)}</span></li>`).join('')}
          </ul>` : ''}
        </aside>
      </div>

      ${about.length ? `
      <section class="pd-section reveal" id="about">
        <h2>Tentang Produk</h2>
        <div class="pd-prose">${about.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
      </section>` : ''}

      ${hasSpecs ? `
      <section class="pd-section reveal" id="specs">
        <h2>Persyaratan Sistem</h2>
        <div>
          <div class="pd-specs">
            ${p.specs.min.length ? specBlock('Minimum', p.specs.min, '') : ''}
            ${p.specs.rec.length ? specBlock('Disarankan', p.specs.rec, 'spec--rec') : ''}
          </div>
          ${p.specs.source ? `<p class="pd-source">${esc(p.specs.source)}</p>` : ''}
        </div>
      </section>` : ''}

      <section class="pd-section reveal" id="reviews">
        <h2>Rating &amp; Ulasan</h2>
        <div>
          <div id="pd-summary">${summaryHTML()}</div>
          <div id="pd-reviews"></div>
          <nav class="pager" id="pd-pager" aria-label="Halaman ulasan"></nav>
          <p class="pd-reviewcta">
            <a class="btn btn--soft" href="rating.html?product=${p.id}#tulis">Tulis ulasan</a>
            <a href="rating.html">Lihat semua rating</a>
          </p>
        </div>
      </section>

      ${related.length ? `
      <section class="pd-section pd-section--wide reveal" id="related">
        <h2>Produk Lainnya</h2>
        <ul class="product-grid" data-stagger>${related.map(productCard).join('')}</ul>
      </section>` : ''}`;

    if (keep) $('#pd-slide').replaceChildren(...keep);
    renderReviews();
    shownSig = settingsSig();
    if (settle) { $$('.enter', root).forEach((el) => el.classList.remove('enter')); settleIn(root); } else observeReveals();   // pembaruan: tanpa animasi masuk ulang
  }


  /* Interaksi (satu set listener pada root, tidak ikut hilang saat render ulang)
     -------------------------------------------------------------------------- */
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-retry]')) { view = 'loading'; render(); refresh({ settle: false }); return; }
    if (t.closest('#pd-prev')) return go(current - 1);
    if (t.closest('#pd-next')) return go(current + 1);
    const thumb = t.closest('.pd-thumb');
    if (thumb) return go(+thumb.dataset.i);
    if (t.closest('.pd-play')) return playVideo();
    if (t.closest('#pd-buy')) { if (p && p.stock > 0) location.href = 'checkout.html?product=' + p.id; return; }
    if (t.closest('#pd-cart')) return flash(t.closest('#pd-cart'), 'Ditambahkan ke keranjang');
    if (t.closest('#pd-share')) return share(t.closest('#pd-share'));
    const pg = t.closest('[data-page]');
    if (pg && !pg.disabled) { page = +pg.dataset.page; loadReviews().then(renderReviews); return; }
    const shot = t.closest('.pd-shot');
    if (shot) openShot(+shot.dataset.r, +shot.dataset.k);
  });

  root.addEventListener('keydown', (e) => {
    if (!e.target.closest('#pd-stage') || e.target.closest('video')) return;   // panah dipakai kontrol video
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(current + 1); }
  });

  async function share(button) {
    const label = $('span', button);
    try {
      if (navigator.share) await navigator.share({ title: p.name, url: location.href });
      else { await navigator.clipboard.writeText(location.href); flash(label, 'Tautan disalin'); }
    } catch { /* dibatalkan / tidak didukung */ }
  }


  /* 4. Galeri (slider + video)
     -------------------------------------------------------------------------- */
  function go(n) {
    const items = gallery();
    const next = (n + items.length) % items.length;
    if (next === current) return;
    current = next;

    const strip = $('#pd-thumbs');
    const thumbs = $$('.pd-thumb', strip);
    thumbs.forEach((t, i) => {
      t.classList.toggle('on', i === current);
      i === current ? t.setAttribute('aria-current', 'true') : t.removeAttribute('aria-current');
    });
    // Geser strip thumbnail saja (bukan halaman) agar thumbnail aktif terlihat
    const t = thumbs[current];
    strip.scrollTo({ left: t.offsetLeft - (strip.clientWidth - t.offsetWidth) / 2, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    $('#pd-count').textContent = `${current + 1} / ${items.length}`;

    // Fade + scale halus; konten diganti saat transparan
    const slide = $('#pd-slide');
    clearTimeout(slideTimer);
    slide.classList.add('is-out');
    slideTimer = setTimeout(() => {
      slide.innerHTML = slideHTML(items[current]);
      slide.style.cssText = backdrop(items[current]);
      slide.dataset.key = `${items[current].type}|${items[current].src || ''}`;
      slide.classList.remove('is-out');
    }, prefersReducedMotion ? 0 : 200);
  }

  // Video: poster + tombol putar; player dimuat hanya setelah diklik (tanpa autoplay agresif)
  function playVideo() {
    const m = gallery()[current];
    const slide = $('#pd-slide');
    const srcs = m.sources || [];
    const poster = m.poster ? ` poster="${esc(m.poster)}"` : '';
    // Video Steam: beberapa <source> (MP4/WebM/HLS) langsung dari CDN Steam; video upload manual: satu src (R2).
    slide.innerHTML = srcs.length
      ? `<video controls autoplay playsinline preload="metadata"${poster}>${srcs.map((s) => `<source src="${esc(s.url)}" type="${esc(s.type)}">`).join('')}</video>`
      : `<video controls autoplay playsinline preload="metadata"${poster} src="${esc(m.src)}"></video>`;
    // Dengan <source>, kegagalan dilaporkan di elemen <source> terakhir (setelah semua source dicoba), bukan di <video>.
    const target = srcs.length ? $('source:last-of-type', slide) : $('video', slide);
    target.addEventListener('error', () => {
      reportImageError(m.src);
      slide.innerHTML = `${art(m)}${vframe(m)}<p class="pd-note">Video tidak dapat dimuat. Menampilkan poster.</p>`;
    }, { once: true });
  }


  /* 5. Ulasan (pagination dari server + lightbox)
     -------------------------------------------------------------------------- */
  function renderReviews() {
    const list = $('#pd-reviews');
    if (!list) return;
    $('#pd-summary').innerHTML = summaryHTML();
    if (partial) {   // ulasan belum dimuat: skeleton, bukan "belum ada ulasan"
      list.innerHTML = '<div role="status" aria-busy="true" aria-label="Memuat ulasan"><span class="pd-skel pd-skel--line"></span><span class="pd-skel pd-skel--line"></span><span class="pd-skel pd-skel--line pd-skel--short"></span></div>';
      $('#pd-pager').innerHTML = '';
      return;
    }
    list.innerHTML = reviews.items.length ? reviews.items.map((r, n) => `
      <article class="review">
        <span class="review__av" aria-hidden="true">${esc(r.name[0] || '?')}</span>
        <div>
          <header><b>${esc(r.name)}</b><time datetime="${esc(r.date)}">${dateId(r.date)}</time></header>
          ${stars(r.stars)}
          <p>${esc(r.text)}</p>
          ${r.images.length ? `<div class="review__imgs">${r.images.map((m, k) => `
            <button class="pd-shot" type="button" data-r="${n}" data-k="${k}" aria-label="Perbesar foto ulasan dari ${esc(r.name)}">
              ${pic({ src: m.url, seed: 500 + n * 3 + k, alt: `Foto ulasan dari ${r.name}` }, true)}
            </button>`).join('')}</div>` : ''}
          <small>Produk: ${esc(p.name)}</small>
        </div>
      </article>`).join('') : '<p class="section__sub">Belum ada ulasan untuk produk ini.</p>';

    const pageBtn = (label, to, on, disabled) =>
      `<button class="filter${on ? ' on' : ''}" type="button" data-page="${to}"${on ? ' aria-current="page"' : ''}${disabled ? ' disabled' : ''}>${label}</button>`;
    $('#pd-pager').innerHTML = reviews.totalPages > 1
      ? Array.from({ length: reviews.totalPages }, (_, i) => pageBtn(i + 1, i + 1, i + 1 === page)).join('') +
        pageBtn('Next', page + 1, false, page === reviews.totalPages)
      : '';
  }

  // Lightbox (<dialog>: fokus terkunci + tombol Esc bawaan)
  const box = $('#pd-lightbox');
  const closeBox = () => {
    box.classList.remove('is-in');
    setTimeout(() => box.open && box.close(), prefersReducedMotion ? 0 : 250);
  };

  function openShot(r, k) {
    const review = reviews.items[r];
    const img = review && review.images[k];
    if (!img) return;
    $('#pd-lightbox-img').innerHTML = pic({ src: img.url, seed: 500 + r * 3 + k, alt: `Foto ulasan dari ${review.name}` });
    box.showModal();
    requestAnimationFrame(() => box.classList.add('is-in'));
  }
  $('#pd-close').addEventListener('click', closeBox);
  box.addEventListener('click', (e) => { if (e.target === box) closeBox(); });
  box.addEventListener('close', () => box.classList.remove('is-in'));


  /* 6. Realtime
     -------------------------------------------------------------------------- */
  let started = false;
  let refreshTimer;
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh(), 120); };

  document.addEventListener('mp:change', (e) => {
    if (!started) return;
    const { entity, action, payload } = e.detail;
    if (entity === 'product') {
      if (payload.id !== pid) { updateRelated(); return; }   // hanya daftar "Produk Lainnya" yang ikut berubah (video tidak terputus)
      if (action === 'delete') { view = 'missing'; render(); } else refreshSoon();
    } else if (entity === 'review') {
      if (payload.productId === pid) refreshSoon();
    } else if (entity === 'category') {
      refreshSoon();
    } else if (entity === 'sync') {
      // Bootstrap pertama (cuma melengkapi pengaturan & "Produk Lainnya") tidak perlu mengambil ulang detail
      if (!payload?.initial) refreshSoon();
      else if (view === 'ready') { if (settingsSig() !== shownSig) render({ settle: true }); else updateRelated(); }
    } else if (entity === 'settings') {
      if (view === 'ready' && settingsSig() !== shownSig) render({ settle: true });
    }
  });

  /* Mulai: gambar dulu, jaringan menyusul */
  if (!Number.isInteger(pid) || pid < 1) { view = 'missing'; renderState(); }
  else {
    const cached = pdStore.get(pid);                       // hasil prefetch / kunjungan sebelumnya dalam sesi
    const card = PRODUCTS.find((x) => x.id === pid);       // kartu dari cache daftar produk
    let drawn = true;
    if (cached) applyDetail(cached.d);
    else if (card) { p = fromCard(card); partial = true; view = 'ready'; }
    else drawn = false;                                    // tanpa data apa pun: skeleton ringan

    render();
    if (cached && Date.now() - cached.t < 4000) started = true;   // baru diambil (mis. prefetch hover): tidak perlu request ulang
    else refresh({ settle: drawn }).then(() => { started = true; });
  }
})();
