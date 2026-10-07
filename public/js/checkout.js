/* ==========================================================================
   checkout.js — Checkout  (checkout.html?product=ID)
   Produk dari /api/public/products/:id (MongoDB, harga selalu dari server).
   Submit -> POST /api/orders -> payment.html?order=...&t=...
   Memakai api, esc, formatRupiah, artwork, stockInfo, $, $$ dari script.js.
   ========================================================================== */
(() => {
  const root = $('#pay-root');
  const pid = Number(new URLSearchParams(location.search).get('product'));
  const ORDERS = `${Live.apiBase}/api/orders`;
  const KEY_CK = `mp:ck:${pid}`;          // kunci idempotensi: klik ganda / kirim ulang = order yang sama
  const KEY_FORM = 'mp:buyer';            // isi form sementara (sessionStorage) bila pembeli kembali dari halaman berikutnya

  let view = 'loading';                   // loading | ready | missing | soldout | error
  let p = null;
  let cfg = { ready: true, mode: 'production' };
  let submitting = false;

  const ico = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const I = {
    back: ico('m15 6-6 6 6 6'),
    lock: ico('M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3'),
    check: ico('m5 12 5 5 9-10'),
    alert: ico('M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'),
    info: ico('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01'),
  };

  const stepper = (step) => `
    <ol class="stepper" aria-label="Langkah pembelian">
      ${['Data pembeli', 'Pembayaran', 'Selesai'].map((label, i) => {
        const n = i + 1;
        const cls = n < step ? ' class="is-done"' : '';
        const cur = n === step ? ' aria-current="step"' : '';
        return `<li${cls}${cur}><span class="stepper__dot">${n < step ? I.check : n}</span><span>${label}</span></li>`;
      }).join('')}
    </ol>`;

  /* Normalisasi nomor: sama dengan server (lib/phone.js) supaya pesan galat konsisten */
  function normWa(input) {
    const raw = String(input || '').trim();
    let d = raw.replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('0')) d = '62' + d.slice(1);
    else if (!raw.startsWith('+') && d.startsWith('8')) d = '62' + d;
    if (d.startsWith('620')) d = '62' + d.slice(3);
    if (!/^[1-9]\d{7,14}$/.test(d)) return '';
    if (d.startsWith('62') && (d.length < 10 || d.length > 15)) return '';
    return d;
  }

  const RULES = {
    name: (v) => (v.trim().length < 2 ? 'Nama minimal 2 karakter' : v.trim().length > 60 ? 'Nama maksimal 60 karakter' : ''),
    email: (v) => (!v.trim() ? 'Email wajib diisi' : /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Format email belum benar'),
    whatsapp: (v) => (!v.trim() ? 'Nomor WhatsApp wajib diisi' : normWa(v) ? '' : 'Nomor WhatsApp tidak valid (contoh: 0812 3456 7890)'),
  };

  /* Muat data
     -------------------------------------------------------------------------- */
  async function loadProduct() {
    try {
      const d = await api('/products/' + pid);
      p = d.product;
      view = p.stock > 0 ? 'ready' : 'soldout';
    } catch (err) {
      if (err.status === 404) { view = 'missing'; p = null; }
      else if (view !== 'ready') view = 'error';
    }
  }

  async function loadConfig() {
    try {
      const res = await fetch(`${ORDERS}/config`, { headers: { accept: 'application/json' } });
      if (res.ok) cfg = await res.json();
    } catch { /* biarkan: server tetap menolak bila belum siap */ }
  }

  /* Render
     -------------------------------------------------------------------------- */
  function stateHTML(kind) {
    const map = {
      loading: null,
      missing: { icon: 'alert', cls: 'warn', title: 'Produk tidak ditemukan', text: 'Produk yang ingin Anda beli tidak tersedia atau tautannya sudah berubah.', cta: '<a class="btn btn--primary" href="index.html#product">Lihat produk lain</a>' },
      soldout: { icon: 'alert', cls: 'warn', title: 'Stok produk habis', text: p ? `${esc(p.name)} sedang tidak tersedia. Stok diperbarui langsung, silakan cek lagi nanti atau pilih produk lain.` : '', cta: `<a class="btn btn--primary" href="index.html#product">Lihat produk lain</a>${p ? `<a class="btn btn--soft" href="product.html?id=${p.id}">Kembali ke produk</a>` : ''}` },
      error: { icon: 'alert', cls: 'danger', title: 'Checkout belum bisa dimuat', text: 'Periksa koneksi Anda, lalu coba lagi.', cta: '<button class="btn btn--primary" type="button" data-retry>Coba lagi</button>' },
    };
    if (kind === 'loading') {
      return `
        <header class="pay-head"><div class="pay-head__text"><h1 class="pay-title">Checkout</h1></div></header>
        <div class="pay-grid pay-grid--checkout" aria-busy="true">
          <section class="panel"><div class="sk"><i class="w40"></i><i class="lg"></i><i class="lg"></i><i class="lg"></i><i class="lg"></i></div></section>
          <aside class="pay-side"><section class="panel panel--compact"><div class="sk"><i class="w60"></i><i></i><i></i><i class="w40"></i></div></section></aside>
        </div>`;
    }
    const s = map[kind];
    return `
      <section class="panel state swap" role="status">
        <span class="result-icon result-icon--${s.cls}">${I[s.icon]}</span>
        <h1>${s.title}</h1>
        ${s.text ? `<p>${s.text}</p>` : ''}
        <div class="result-actions">${s.cta}</div>
      </section>`;
  }

  function thumb() {
    return p.imageUrl
      ? `<img src="${esc(p.imageUrl)}" alt="" decoding="async" data-seed="${p.id}">`
      : artwork(p.id);
  }

  function summaryHTML() {
    const [stockClass, stockLabel] = stockInfo(p.stock);
    const cls = stockClass === 'stock--low' ? ' is-low' : stockClass === 'stock--out' ? ' is-out' : '';
    return `
      <section class="panel panel--compact" aria-labelledby="sum-title">
        <h2 class="panel__title" id="sum-title">Ringkasan pesanan</h2>
        <div class="sum-product" style="margin-top:18px">
          <div class="sum-thumb">${thumb()}</div>
          <div>
            <p class="sum-name">${esc(p.name)}</p>
            <p class="sum-cat">${esc(p.category)}</p>
            <p class="sum-stock"><span class="stock-pill${cls}">${stockLabel}</span></p>
          </div>
        </div>
        <dl class="sum-rows">
          <div><dt>Harga produk</dt><dd>${formatRupiah(p.price)}</dd></div>
          <div><dt>Jumlah</dt><dd>1</dd></div>
          <div><dt>Metode pembayaran</dt><dd>QRIS</dd></div>
          <div class="is-total"><dt>Total</dt><dd>${formatRupiah(p.price)}</dd></div>
        </dl>
        <div class="notice">${I.info}<p>Nominal akhir ditampilkan di langkah berikutnya dan bisa memuat kode unik beberapa rupiah. Bayar sesuai nominal itu.</p></div>
      </section>`;
  }

  function renderSummary() {
    const host = $('#summary');
    if (host && p) host.innerHTML = summaryHTML();
    const btn = $('#submit');
    if (btn) btn.disabled = !cfg.ready || p?.stock < 1;
  }

  function fieldHTML({ id, label, type = 'text', autocomplete, inputmode, placeholder, hint, value = '' }) {
    return `
      <div class="field" data-field="${id}">
        <label for="f-${id}">${label}</label>
        <input class="field__input" id="f-${id}" name="${id}" type="${type}" value="${esc(value)}" autocomplete="${autocomplete}"${inputmode ? ` inputmode="${inputmode}"` : ''} placeholder="${esc(placeholder)}" aria-describedby="h-${id}" required>
        <p class="field__hint" id="h-${id}">${hint}</p>
      </div>`;
  }

  function renderForm() {
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(KEY_FORM) || '{}'); } catch { /* abaikan */ }
    document.title = `Checkout ${p.name} — ${DATA.brand}`;
    root.innerHTML = `
      <header class="pay-head enter" style="--d:.05s">
        <div class="pay-head__text">
          <a class="pay-back" href="product.html?id=${p.id}">${I.back}<span>Kembali ke produk</span></a>
          <h1 class="pay-title">Checkout</h1>
          <p class="pay-lead">Isi data pembeli. Admin akan menghubungi Anda lewat WhatsApp setelah pembayaran diterima.</p>
        </div>
        ${stepper(1)}
      </header>

      <div class="pay-grid pay-grid--checkout">
        <form class="panel enter" style="--d:.15s" id="checkout-form" novalidate aria-labelledby="form-title">
          <div class="panel__head">
            <h2 class="panel__title" id="form-title">Data pembeli</h2>
            <p class="panel__sub">Pastikan email dan nomor WhatsApp aktif, karena dipakai untuk memproses pesanan Anda.</p>
          </div>

          <div class="fields">
            ${fieldHTML({ id: 'name', label: 'Nama lengkap', autocomplete: 'name', placeholder: 'Nama sesuai identitas Anda', hint: 'Dipakai admin untuk memastikan pesanan atas nama Anda.', value: saved.name })}
            <div class="fields__row">
              ${fieldHTML({ id: 'email', label: 'Email', type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'nama@email.com', hint: 'Bukti pesanan dan informasi akun dikirim ke sini.', value: saved.email })}
              ${fieldHTML({ id: 'whatsapp', label: 'Nomor WhatsApp', type: 'tel', autocomplete: 'tel', inputmode: 'tel', placeholder: '0812 3456 7890', hint: 'Contoh: 0812 3456 7890 atau +62 812 3456 7890.', value: saved.whatsapp })}
            </div>
            <div class="trap" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
          </div>

          <div class="form-foot">
            <p class="form-error" id="form-error" role="alert" hidden></p>
            ${cfg.ready ? '' : `<p class="form-error" role="alert">Pembayaran belum tersedia saat ini. Silakan coba lagi nanti atau hubungi admin.</p>`}
            ${cfg.mode === 'sandbox' && cfg.ready ? `<div class="notice notice--warn" style="margin:0">${I.info}<p><b>Mode uji coba (Sandbox).</b> Pesanan ini tidak memakai uang asli.</p></div>` : ''}
            <button class="btn btn--primary btn--block" id="submit" type="submit"${cfg.ready ? '' : ' disabled'}>${I.lock}<span>Lanjut ke pembayaran</span></button>
            <small>Anda akan melihat kode QRIS di langkah berikutnya dan punya waktu 10 menit untuk membayar.</small>
          </div>
        </form>

        <aside class="pay-side enter" style="--d:.25s" id="summary" aria-label="Ringkasan pesanan">${summaryHTML()}</aside>
      </div>`;
  }

  function render() {
    if (view !== 'ready') {
      root.innerHTML = stateHTML(view);
      document.title = `Checkout — ${DATA.brand}`;
      return;
    }
    renderForm();
  }

  /* Validasi & kirim
     -------------------------------------------------------------------------- */
  function setError(name, message) {
    const field = $(`[data-field="${name}"]`, root);
    if (!field) return;
    const input = $('.field__input', field);
    $('.field__error', field)?.remove();
    field.classList.toggle('is-invalid', Boolean(message));
    input.toggleAttribute('aria-invalid', Boolean(message));
    if (message) {
      const el = document.createElement('p');
      el.className = 'field__error';
      el.id = `e-${name}`;
      el.textContent = message;
      field.append(el);
      input.setAttribute('aria-describedby', `h-${name} e-${name}`);
    } else input.setAttribute('aria-describedby', `h-${name}`);
    return message;
  }

  const formError = (msg) => { const el = $('#form-error'); el.hidden = !msg; el.textContent = msg || ''; };

  async function submit(form) {
    if (submitting) return;
    formError('');
    const values = { name: form.elements.name.value, email: form.elements.email.value, whatsapp: form.elements.whatsapp.value };
    let firstBad = null;
    for (const k of Object.keys(RULES)) {
      const msg = setError(k, RULES[k](values[k]));
      if (msg && !firstBad) firstBad = k;
    }
    if (firstBad) { form.elements[firstBad].focus(); return; }

    sessionStorage.setItem(KEY_FORM, JSON.stringify(values));
    let key = sessionStorage.getItem(KEY_CK);
    if (!key) {
      key = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/-/g, '');
      sessionStorage.setItem(KEY_CK, key);
    }

    submitting = true;
    const btn = $('#submit');
    btn.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(ORDERS, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ productId: pid, ...values, clientKey: key, website: form.elements.website.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const fields = data.error?.details?.fields || {};
        let shown = false;
        for (const [k, msg] of Object.entries(fields)) { if (RULES[k]) { setError(k, msg); shown = true; } }
        if (shown) form.elements[Object.keys(fields).find((k) => RULES[k])].focus();
        formError(shown ? '' : (data.error?.message || 'Checkout gagal. Silakan coba lagi.'));
        if (res.status === 404 || res.status === 409) loadProduct().then(render);   // produk berubah/stok habis
        return;
      }
      sessionStorage.removeItem(KEY_CK);          // pembelian berikutnya = order baru
      location.assign(`payment.html?order=${encodeURIComponent(data.orderNo)}&t=${encodeURIComponent(data.token)}`);
    } catch {
      formError('Tidak dapat terhubung ke server. Periksa koneksi Anda lalu coba lagi. Pesanan tidak akan terkirim dua kali.');
    } finally {
      submitting = false;
      btn.removeAttribute('aria-busy');
    }
  }

  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'checkout-form') return;
    e.preventDefault();
    submit(e.target);
  });
  root.addEventListener('focusout', (e) => {
    const input = e.target.closest?.('.field__input');
    if (!input || !RULES[input.name]) return;
    if (input.value.trim() || input.closest('.field').classList.contains('is-invalid')) setError(input.name, RULES[input.name](input.value));
  });
  root.addEventListener('input', (e) => {
    const input = e.target.closest?.('.field__input');
    if (input?.closest('.field').classList.contains('is-invalid') && !RULES[input.name]?.(input.value)) setError(input.name, '');
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) start();
  });
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.seed && img.closest('.sum-thumb')) img.outerHTML = artwork(+img.dataset.seed);
  }, true);

  /* Realtime: harga/stok produk berubah -> hanya ringkasan yang diperbarui (isi form tidak hilang) */
  document.addEventListener('mp:change', (e) => {
    const { entity, action, payload } = e.detail;
    if (view === 'loading') return;
    if (entity === 'sync' && payload?.initial) return;   // bootstrap pertama: produk sudah diambil segar oleh start()
    const relevant = (entity === 'product' && payload.id === pid) || entity === 'category' || entity === 'sync';
    if (!relevant) return;
    if (entity === 'product' && action === 'delete') { view = 'missing'; render(); return; }
    const before = view;
    loadProduct().then(() => {
      if (view !== before) render(); else if (view === 'ready') renderSummary();
    });
  });

  async function start() {
    if (!Number.isInteger(pid) || pid < 1) { view = 'missing'; render(); return; }
    view = 'loading';
    render();
    // Paralel (sebelumnya berurutan: bootstrap -> produk). Produk TETAP diambil segar dari server, bukan dari cache.
    await Promise.all([window.MP.ready, loadConfig(), loadProduct()]);
    render();
  }
  start();
})();
