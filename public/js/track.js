/* ==========================================================================
   track.js — Cek Pesanan  (track.html)
   Satu form, dua metode (ID Transaksi | Email); cukup isi salah satu.
   - Data SELALU dari backend/MongoDB: POST /api/orders/track. Status memakai status Order yang sudah ada
     (PENDING | SUCCESS | EXPIRED | FAILED); halaman ini tidak menentukan status sendiri.
   - Data pribadi pembeli sudah disamarkan oleh server. Tidak ada QRIS/token pembayaran di sini.
   - Realtime: Socket.IO yang sudah ada (live.js). Tiap pesanan bergabung ke room track:<orderNo> dengan token pantau,
     lalu menerima track:update. Event usang/ganda diabaikan lewat `rev`. Tanpa socket: polling pelan.
   - Nomor WhatsApp Admin dari Admin Web (Pengaturan Payment), tidak ada yang di-hardcode.
   Memakai esc, $, $$, Live, DATA, prefersReducedMotion dari script.js / live.js.
   ========================================================================== */
(() => {
  const root = $('#trk-root');
  const liveMsg = $('#pay-live');
  const API = `${Live.apiBase}/api/orders`;
  const POLL_SOCKET_MS = 60_000;   // socket tersambung: polling hanya penyembuh event yang terlewat
  const POLL_FALLBACK_MS = 15_000; // socket putus / tidak ada

  const S = {
    mode: 'order',                       // order | email
    values: { order: '', email: '' },    // isi tiap metode dipertahankan saat berpindah tab
    view: 'idle',                        // idle | loading | found | notfound | error
    orders: [],                          // urutan dari server (terbaru dulu)
    selected: '',
    message: '',
    lastQuery: null,
    waAdmin: '',
    submitting: false,
    flash: '',                           // orderNo yang statusnya baru berubah (animasi ringan sekali)
  };
  const watch = new Map();               // orderNo -> token pantau
  const joined = new Set();              // orderNo yang sudah bergabung pada koneksi socket saat ini
  let pollTimer;
  let reqId = 0;
  let wired = false;
  let first = true;

  /* Helper
     -------------------------------------------------------------------------- */
  const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
  const when = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB' : '—');
  const whenShort = (iso) => (iso ? new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }) : '—');
  const waDigits = (n) => (/^\d{8,15}$/.test(n || '') ? n : '');
  const waLink = (text) => (waDigits(S.waAdmin) ? `https://wa.me/${S.waAdmin}?text=${encodeURIComponent(text)}` : '');
  const announce = (t) => { liveMsg.textContent = ''; setTimeout(() => { liveMsg.textContent = t; }, 50); };

  const ico = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const I = {
    check: ico('m5 12 5 5 9-10'),
    clock: ico('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2'),
    alert: ico('M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'),
    x: ico('M6 6l12 12M18 6 6 18'),
    info: ico('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01'),
    wa: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2a9.9 9.9 0 0 0-8.5 14.9L2 22l5.25-1.38A9.9 9.9 0 1 0 12.04 2zm0 1.8a8.1 8.1 0 1 1-4.3 14.96l-.31-.19-3.1.82.83-3.02-.2-.32A8.1 8.1 0 0 1 12.04 3.8zM8.6 7.6c-.17 0-.45.06-.69.32-.24.26-.9.88-.9 2.15s.92 2.5 1.05 2.67c.13.17 1.79 2.86 4.4 3.9 2.17.85 2.6.68 3.07.64.47-.04 1.52-.62 1.73-1.22.21-.6.21-1.11.15-1.22-.06-.11-.23-.17-.49-.3-.26-.13-1.52-.75-1.75-.84-.24-.09-.4-.13-.58.13-.17.26-.67.84-.82 1.01-.15.17-.3.2-.56.07-.26-.13-1.1-.4-2.1-1.29-.78-.69-1.3-1.55-1.45-1.81-.15-.26-.02-.4.11-.53.12-.12.26-.3.39-.45.13-.15.17-.26.26-.43.09-.17.04-.32-.02-.45-.06-.13-.58-1.4-.8-1.92-.21-.5-.42-.43-.58-.44z"/></svg>',
  };

  /* Status: memakai status Order yang sudah ada. Satu tempat untuk semua label. */
  const ST = {
    PENDING: { tone: 'wait', icon: I.clock, title: 'Menunggu pembayaran', order: 'Menunggu Pembayaran', pay: 'Belum dibayar', chip: 'chip chip--wait' },
    SUCCESS: { tone: 'ok', icon: I.check, title: 'Pembayaran berhasil', order: 'Pembayaran Berhasil', pay: 'Lunas', chip: 'chip chip--ok' },
    EXPIRED: { tone: 'warn', icon: I.clock, title: 'Pesanan expired', order: 'Pesanan Expired', pay: 'Kedaluwarsa', chip: 'chip chip--warn' },
    FAILED: { tone: 'danger', icon: I.x, title: 'Pembayaran gagal', order: 'Pembayaran Gagal', pay: 'Gagal dibuat', chip: 'chip chip--danger' },
  };
  const stOf = (o) => ST[o.status] || ST.PENDING;
  const OPEN = ['PENDING', 'EXPIRED'];   // EXPIRED: pembayaran terlambat masih bisa terkonfirmasi

  /* Validasi: aturan sama dengan server (lib/schemas.js) supaya pesan galat konsisten */
  const ORDER_RE = /^MP-\d{6}-[A-Z0-9]{6}$/;
  function normalizeOrderNo(v) {
    const t = String(v || '').toUpperCase().replace(/[\s_]+/g, '');
    const m = /^MP-?(\d{6})-?([A-Z0-9]{6})$/.exec(t);
    return m ? `MP-${m[1]}-${m[2]}` : t;
  }
  const RULES = {
    order: (v) => (!v.trim() ? 'ID transaksi wajib diisi' : ORDER_RE.test(normalizeOrderNo(v)) ? '' : 'Format ID transaksi belum benar (contoh: MP-260506-AB3CD4)'),
    email: (v) => (!v.trim() ? 'Email wajib diisi' : /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Format email belum benar'),
  };
  const MODES = {
    order: { tab: 'ID Transaksi', label: 'ID Transaksi', placeholder: 'MP-260506-AB3CD4', type: 'text', inputmode: 'text', autocomplete: 'off', maxlength: 30,
      hint: 'Ada di email dan WhatsApp konfirmasi, serta di halaman pembayaran. Huruf besar atau kecil sama saja.', other: 'email' },
    email: { tab: 'Email', label: 'Email', placeholder: 'nama@email.com', type: 'email', inputmode: 'email', autocomplete: 'email', maxlength: 120,
      hint: 'Gunakan email yang sama saat checkout. Kami tampilkan hingga 10 pesanan terbaru.', other: 'order' },
  };

  /* Bantuan: nomor dari Admin Web, ID Transaksi ikut otomatis di pesan */
  function helpLink(o) {
    const q = S.lastQuery;
    const typedId = !o && q?.by === 'order' ? q.q : '';
    const text = o
      ? `Halo Admin, saya butuh bantuan untuk pesanan ${o.orderNo} (${o.product.name}). Status di halaman Cek Pesanan: ${stOf(o).order}.`
      : typedId
        ? `Halo Admin, saya tidak menemukan pesanan dengan ID transaksi ${typedId}. Mohon dibantu cek.`
        : 'Halo Admin, saya butuh bantuan untuk mengecek pesanan saya.';
    return waLink(text);
  }
  const helpBtn = (link, label = 'Butuh bantuan? Hubungi Admin') => (link
    ? `<a class="btn btn--wa" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${I.wa}<span>${label}</span></a>`
    : '<a class="btn btn--soft" href="index.html#contact"><span>Lihat kontak admin</span></a>');

  /* Kerangka halaman: dirender SEKALI (agar isi form & fokus tidak hilang saat hasil berubah)
     -------------------------------------------------------------------------- */
  function shell() {
    root.innerHTML = `
      <header class="pay-head enter" style="--d:.05s">
        <div class="pay-head__text">
          <h1 class="pay-title">Cek pesanan</h1>
          <p class="pay-lead">Masukkan ID transaksi atau email yang Anda pakai saat checkout. Cukup salah satu. Status pesanan dan pembayaran diambil langsung dari sistem kami.</p>
        </div>
      </header>

      <section class="panel trk-search enter" style="--d:.15s" id="trk-search" data-mode="order">
        <form id="trk-form" novalidate>
          <div class="trk-tabs" role="tablist" aria-label="Cari pesanan dengan">
            ${Object.entries(MODES).map(([m, c], i) => `<button class="trk-tab" type="button" role="tab" id="tab-${m}" data-mode="${m}" aria-selected="${i === 0}" aria-controls="trk-field"${i ? ' tabindex="-1"' : ''}>${c.tab}</button>`).join('')}
          </div>
          <div class="field" id="trk-field" role="tabpanel" aria-labelledby="tab-order" data-field="q">
            <label for="f-q" id="trk-label"></label>
            <div class="trk-row">
              <input class="field__input" id="f-q" name="q" aria-describedby="h-q" autocapitalize="off" spellcheck="false" required>
              <button class="btn btn--primary" type="submit" id="trk-submit"><span>Cek pesanan</span></button>
            </div>
            <p class="field__hint" id="h-q"></p>
          </div>
          <div class="trap" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
        </form>
      </section>

      <div class="trk-out" id="trk-out"></div>`;
    first = false;
    applyMode('order');
  }

  const form = () => $('#trk-form', root);
  const input = () => $('#f-q', root);

  function applyMode(mode, { focus = false } = {}) {
    const c = MODES[mode];
    S.mode = mode;
    $('#trk-search', root).dataset.mode = mode;
    $$('.trk-tab', root).forEach((t) => {
      const on = t.dataset.mode === mode;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    $('#trk-field', root).setAttribute('aria-labelledby', `tab-${mode}`);
    $('#trk-label', root).textContent = c.label;
    const el = input();
    el.type = c.type;
    el.setAttribute('inputmode', c.inputmode);
    el.setAttribute('autocomplete', c.autocomplete);
    el.maxLength = c.maxlength;
    el.placeholder = c.placeholder;
    el.value = S.values[mode];
    $('#h-q', root).textContent = c.hint;
    setFieldError('');
    if (focus) el.focus();
  }

  function setFieldError(message) {
    const field = $('#trk-field', root);
    const el = input();
    $('.field__error', field)?.remove();
    field.classList.toggle('is-invalid', Boolean(message));
    el.toggleAttribute('aria-invalid', Boolean(message));
    if (message) {
      const p = document.createElement('p');
      p.className = 'field__error';
      p.id = 'e-q';
      p.textContent = message;
      field.append(p);
      el.setAttribute('aria-describedby', 'h-q e-q');
    } else el.setAttribute('aria-describedby', 'h-q');
  }

  function setBusy(on) {
    const b = $('#trk-submit', root);
    if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
    $('span', b).textContent = on ? 'Mencari…' : 'Cek pesanan';
  }

  /* Tampilan hasil
     -------------------------------------------------------------------------- */
  const copyBtn = (v) => `<button class="copy-inline" type="button" data-copy="${esc(v)}" aria-label="Salin ${esc(v)}">Salin</button>`;
  const thumb = (o) => (o.product.imageUrl ? `<img src="${esc(o.product.imageUrl)}" alt="" decoding="async" data-seed="${o.product.id}">` : artwork(o.product.id));

  function say(o) {
    if (o.status === 'PENDING') {
      return o.expiresAt
        ? `Kami menunggu pembayaran QRIS Anda. Batas bayar <b>${when(o.expiresAt)}</b>. Buka tautan pembayaran yang dikirim ke email atau WhatsApp Anda untuk melihat kode QRIS.`
        : 'Kode pembayaran sedang disiapkan. Halaman ini berubah otomatis begitu siap.';
    }
    if (o.status === 'SUCCESS') return `Pembayaran sudah kami terima${o.paidAt ? ` pada <b>${when(o.paidAt)}</b>` : ''}. Hubungi Admin lewat WhatsApp agar produk segera diproses.`;
    if (o.status === 'EXPIRED') return 'Batas pembayaran 10 menit sudah lewat, jadi kode QRIS tidak berlaku lagi. <b>Jangan membayar dengan kode lama.</b> Sudah terlanjur membayar? Hubungi Admin; status ini berubah otomatis bila pembayaran terkonfirmasi.';
    return `${esc(o.failureReason || 'Transaksi pembayaran tidak dapat dibuat.')} Buat pesanan baru, atau hubungi Admin bila masih gagal.`;
  }

  const liveOn = () => Boolean(Live.socket?.connected);

  function detailHTML(o, swap) {
    const st = stOf(o);
    const total = o.totalAmount ?? o.amount;
    const unique = o.uniqueAmount > 0;
    const again = o.status === 'EXPIRED' || o.status === 'FAILED';
    const open = OPEN.includes(o.status);
    return `
      <article class="panel trk-order${swap ? ' swap' : ''}" id="trk-detail" aria-labelledby="trk-st">
        <header class="trk-hero">
          <span class="result-icon result-icon--${st.tone}">${st.icon}</span>
          <div>
            <p class="trk-id"><span>${esc(o.orderNo)}</span>${copyBtn(o.orderNo)}</p>
            <h2 class="trk-st" id="trk-st">${st.title}</h2>
            <p class="trk-say">${say(o)}</p>
          </div>
          ${open ? `<p class="trk-live" data-on="${liveOn()}"><i></i><span>${liveOn() ? 'Diperbarui otomatis' : 'Diperiksa berkala'}</span></p>` : ''}
        </header>

        <div class="trk-body">
          <div class="trk-prod">
            <div class="sum-thumb">${thumb(o)}</div>
            <div>
              <p class="sum-name">${esc(o.product.name)}</p>
              ${o.product.category ? `<p class="sum-cat">${esc(o.product.category)}</p>` : ''}
            </div>
          </div>
          <div class="trk-total">
            <span>Total pembayaran</span>
            <strong>${rp(total)}</strong>
            ${unique ? `<small>Termasuk kode unik ${rp(o.uniqueAmount)}</small>` : ''}
          </div>
        </div>

        <div class="trk-cols">
          <section aria-labelledby="trk-pay-h">
            <h3 class="sum-group__title" id="trk-pay-h">Pembayaran</h3>
            <dl class="sum-rows">
              <div><dt>Status pesanan</dt><dd class="is-strong">${st.order}</dd></div>
              <div><dt>Status pembayaran</dt><dd class="is-strong"><span class="${st.chip}"><i></i>${st.pay}</span></dd></div>
              <div><dt>Metode</dt><dd>${esc(o.method)}</dd></div>
              <div><dt>Jumlah</dt><dd>${o.quantity}</dd></div>
              <div><dt>Harga produk</dt><dd>${rp(o.amount)}</dd></div>
              <div><dt>Tanggal transaksi</dt><dd>${when(o.createdAt)}</dd></div>
              ${o.paidAt ? `<div><dt>Waktu pembayaran</dt><dd>${when(o.paidAt)}</dd></div>` : ''}
              ${o.status === 'PENDING' && o.expiresAt ? `<div><dt>Batas pembayaran</dt><dd>${when(o.expiresAt)}</dd></div>` : ''}
            </dl>
          </section>
          <section aria-labelledby="trk-buyer-h">
            <h3 class="sum-group__title" id="trk-buyer-h">Pembeli</h3>
            <dl class="sum-rows">
              <div><dt>Nama</dt><dd>${esc(o.customer.name)}</dd></div>
              <div><dt>Email</dt><dd>${esc(o.customer.email)}</dd></div>
              <div><dt>WhatsApp</dt><dd>${esc(o.customer.whatsapp)}</dd></div>
            </dl>
            <p class="field__hint trk-note">Data pribadi disamarkan demi keamanan pembeli.</p>
          </section>
        </div>

        ${o.mode === 'sandbox' ? `<div class="notice notice--warn">${I.info}<p><b>Mode uji coba (Sandbox).</b> Pesanan ini tidak memakai uang asli.</p></div>` : ''}

        <div class="result-actions">
          ${again ? `<a class="btn btn--primary" href="checkout.html?product=${o.product.id}">Buat pesanan baru</a>` : ''}
          ${helpBtn(helpLink(o))}
        </div>
      </article>`;
  }

  const listHTML = () => `
    <div class="trk-listwrap">
      <p class="trk-count">${S.orders.length} pesanan memakai email ini</p>
      <ul class="trk-list" aria-label="Pesanan ditemukan">
        ${S.orders.map((o) => {
          const st = stOf(o);
          return `<li><button class="trk-item" type="button" data-pick="${esc(o.orderNo)}" aria-current="${o.orderNo === S.selected}">
            <span class="trk-item__name">${esc(o.product.name)}</span>
            <span class="trk-item__meta"><span>${esc(o.orderNo)}</span><span>${whenShort(o.createdAt)}</span></span>
            <span class="trk-item__foot"><span class="${st.chip}"><i></i>${st.order}</span><span class="trk-item__total">${rp(o.totalAmount ?? o.amount)}</span></span>
          </button></li>`;
        }).join('')}
      </ul>
    </div>`;

  const idleHTML = () => `
    <section class="panel panel--compact" aria-labelledby="tips-h">
      <h2 class="panel__title" id="tips-h">Di mana saya menemukan ID transaksi?</h2>
      <dl class="trk-tips__list">
        <div><dt>Email konfirmasi</dt><dd>Dikirim saat pesanan dibuat dan setelah pembayaran diterima. Cari baris Order ID.</dd></div>
        <div><dt>WhatsApp</dt><dd>Pesan notifikasi dari kami memuat Order ID yang diawali MP-.</dd></div>
        <div><dt>Halaman pembayaran</dt><dd>Tertera sebagai Order ID pada ringkasan pesanan.</dd></div>
      </dl>
      <div class="trk-help">
        <p>Tidak menemukan ID-nya? Cari pakai email, atau hubungi Admin dan kami bantu cek.</p>
        ${helpBtn(helpLink(null), 'Butuh bantuan?')}
      </div>
    </section>`;

  const loadingHTML = () => `
    <div class="trk-layout" aria-busy="true">
      <section class="panel"><div class="sk"><i class="w40"></i><i class="lg"></i><i></i><i></i><i class="w60"></i></div></section>
    </div>`;

  const notFoundHTML = () => `
    <section class="panel state swap" role="alert">
      <span class="result-icon result-icon--warn">${I.alert}</span>
      <h2>Pesanan tidak ditemukan</h2>
      <p>${esc(S.message || 'Periksa kembali data yang Anda masukkan.')}</p>
      <div class="result-actions">
        <button class="btn btn--soft" type="button" data-switch="${MODES[S.mode].other}">Coba dengan ${MODES[MODES[S.mode].other].tab}</button>
        ${helpBtn(helpLink(null), 'Butuh bantuan?')}
      </div>
    </section>`;

  const errorHTML = () => `
    <section class="panel state swap" role="alert">
      <span class="result-icon result-icon--danger">${I.alert}</span>
      <h2>Pesanan belum bisa dimuat</h2>
      <p>${esc(S.message || 'Periksa koneksi Anda, lalu coba lagi. Pesanan Anda aman dan tidak berubah.')}</p>
      <div class="result-actions"><button class="btn btn--primary" type="button" data-retry>Coba lagi</button></div>
    </section>`;

  function renderOut() {
    const out = $('#trk-out', root);
    if (S.view === 'found') {
      const o = S.orders.find((x) => x.orderNo === S.selected) || S.orders[0];
      const multi = S.orders.length > 1;
      const swap = S.flash === o.orderNo;
      S.flash = '';
      out.innerHTML = `<div class="trk-layout${multi ? ' has-list' : ''}">${multi ? listHTML() : ''}${detailHTML(o, swap)}</div>`;
    } else {
      out.innerHTML = ({ idle: idleHTML, loading: loadingHTML, notfound: notFoundHTML, error: errorHTML }[S.view] || idleHTML)();
    }
  }

  /* Pencarian
     -------------------------------------------------------------------------- */
  function leaveAll() {
    const s = Live.socket;
    if (s?.connected) joined.forEach((orderNo) => s.emit('track:leave', { orderNo }));
    joined.clear();
    watch.clear();
  }

  async function search(query) {
    const id = ++reqId;
    leaveAll();
    clearTimeout(pollTimer);
    S.submitting = true;
    S.view = 'loading';
    S.orders = [];
    S.selected = '';
    S.lastQuery = query;
    setBusy(true);
    renderOut();
    try {
      const res = await fetch(`${API}/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...query, website: form().elements.website.value }),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (id !== reqId) return;
      if (res.ok && Array.isArray(data.orders) && data.orders.length) {
        S.waAdmin = data.waAdmin || S.waAdmin;
        S.orders = data.orders.map(({ watch: token, ...o }) => { watch.set(o.orderNo, token); return o; });
        S.selected = S.orders[0].orderNo;
        S.view = 'found';
        announce(S.orders.length > 1 ? `${S.orders.length} pesanan ditemukan.` : `Pesanan ditemukan: ${stOf(S.orders[0]).title}.`);
      } else if (res.status === 422) {
        S.view = 'idle';
        setFieldError(data.error?.details?.fields?.q || data.error?.message || 'Data tidak valid');
      } else if (res.status === 404) {
        S.view = 'notfound';
        S.message = data.error?.message || '';
      } else {
        S.view = 'error';
        S.message = res.status === 429 ? (data.error?.message || '') : '';
      }
    } catch {
      if (id !== reqId) return;
      S.view = 'error';
      S.message = '';
    } finally {
      if (id === reqId) {
        S.submitting = false;
        setBusy(false);
        renderOut();
        if (S.view === 'found') { joinAll(); schedulePoll(); }
      }
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    if (S.submitting) return;
    const el = input();
    const err = RULES[S.mode](el.value);
    if (err) { setFieldError(err); el.focus(); return; }
    const q = S.mode === 'order' ? normalizeOrderNo(el.value) : el.value.trim().toLowerCase();
    el.value = q;
    S.values[S.mode] = q;
    setFieldError('');
    search({ by: S.mode, q });
  }

  /* Terapkan data order (dari hasil, ack join, event, atau polling): usang & ganda diabaikan lewat rev
     -------------------------------------------------------------------------- */
  function applyOrder(next) {
    const i = S.orders.findIndex((o) => o.orderNo === next?.orderNo);
    if (i < 0) return;
    const cur = S.orders[i];
    if (!(next.rev > cur.rev)) return;
    S.orders[i] = next;
    const changed = next.status !== cur.status;
    if (changed && S.selected === next.orderNo) S.flash = next.orderNo;
    if (S.view === 'found') renderOut();
    if (changed) announce(`Status ${next.orderNo} berubah: ${stOf(next).title}.`);
    schedulePoll();
  }

  /* Realtime: Socket.IO yang sudah ada
     -------------------------------------------------------------------------- */
  function joinAll() {
    const s = Live.socket;
    if (!s || !s.connected) return;
    for (const o of S.orders) {
      const token = watch.get(o.orderNo);
      if (!token || joined.has(o.orderNo)) continue;
      joined.add(o.orderNo);   // ditandai dulu: pemanggilan beruntun tidak mengirim join ganda
      s.emit('track:join', { orderNo: o.orderNo, watch: token }, (ack) => {
        if (!ack?.ok) { joined.delete(o.orderNo); return; }
        applyOrder(ack.order);
        refreshLiveBadge();
        schedulePoll();
      });
    }
  }

  function refreshLiveBadge() {
    const badge = $('.trk-live', root);
    if (!badge) return;
    badge.dataset.on = String(liveOn());
    $('span', badge).textContent = liveOn() ? 'Diperbarui otomatis' : 'Diperiksa berkala';
  }

  function wireSocket() {
    const s = Live.socket;
    if (!s || wired) return;   // listener didaftarkan SEKALI
    wired = true;
    s.on('track:update', applyOrder);
    s.on('payment:settings', ({ waAdmin }) => {      // Admin mengganti nomor WhatsApp: tombol bantuan ikut berubah
      if ((waAdmin || '') === S.waAdmin) return;
      S.waAdmin = waAdmin || '';
      renderOut();
    });
    s.on('connect', () => { joined.clear(); joinAll(); refreshLiveBadge(); schedulePoll(); });   // room hilang saat reconnect: gabung ulang
    s.on('disconnect', () => { joined.clear(); refreshLiveBadge(); schedulePoll(); });
  }

  /* Polling cadangan: hanya untuk pesanan yang masih bisa berubah */
  async function refreshOpen() {
    await Promise.all(S.orders.filter((o) => OPEN.includes(o.status)).map(async (o) => {
      try {
        const res = await fetch(`${API}/track/${encodeURIComponent(o.orderNo)}`, { headers: { accept: 'application/json', 'x-watch-token': watch.get(o.orderNo) || '' }, cache: 'no-store' });
        if (res.ok) applyOrder((await res.json()).order);
      } catch { /* jaringan putus: coba lagi di putaran berikutnya */ }
    }));
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (S.view !== 'found' || !S.orders.some((o) => OPEN.includes(o.status))) return;
    pollTimer = setTimeout(async () => { await refreshOpen(); schedulePoll(); }, liveOn() ? POLL_SOCKET_MS : POLL_FALLBACK_MS);
  }

  /* Interaksi
     -------------------------------------------------------------------------- */
  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* abaikan */ }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = 'Tersalin';
    setTimeout(() => { btn.textContent = old; }, 1600);
  }

  root.addEventListener('click', (e) => {
    const tab = e.target.closest('.trk-tab');
    if (tab) { S.values[S.mode] = input().value; applyMode(tab.dataset.mode, { focus: true }); return; }

    const sw = e.target.closest('[data-switch]');
    if (sw) {
      S.values[S.mode] = input().value;
      S.view = 'idle';
      renderOut();
      applyMode(sw.dataset.switch, { focus: true });
      window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
      return;
    }

    const copy = e.target.closest('[data-copy]');
    if (copy) { copyText(copy.dataset.copy, copy); return; }

    if (e.target.closest('[data-retry]')) { if (S.lastQuery) search(S.lastQuery); return; }

    const pick = e.target.closest('[data-pick]');
    if (pick && pick.dataset.pick !== S.selected) {
      S.selected = pick.dataset.pick;
      renderOut();
      $('[data-pick][aria-current="true"]', root)?.focus({ preventScroll: true });
      if (matchMedia('(max-width: 920px)').matches) $('#trk-detail', root)?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    }
  });

  root.addEventListener('keydown', (e) => {   // tab: panah kiri/kanan berpindah metode
    const tab = e.target.closest?.('.trk-tab');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    S.values[S.mode] = input().value;
    const next = tab.dataset.mode === 'order' ? 'email' : 'order';
    applyMode(next);
    $(`#tab-${next}`, root).focus();
  });

  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'f-q') return;
    S.values[S.mode] = e.target.value;
    if ($('#trk-field', root).classList.contains('is-invalid') && !RULES[S.mode](e.target.value)) setFieldError('');
  });
  root.addEventListener('focusout', (e) => {   // galat muncul saat keluar dari kolom, bukan saat mengetik
    if (e.target.id !== 'f-q' || !e.target.value.trim()) return;
    setFieldError(RULES[S.mode](e.target.value));
  });

  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.seed && img.closest('.sum-thumb')) img.outerHTML = artwork(+img.dataset.seed);
  }, true);

  const refreshNow = () => { if (S.view === 'found') refreshOpen(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNow(); });
  addEventListener('online', refreshNow);

  /* Mulai
     -------------------------------------------------------------------------- */
  shell();
  renderOut();
  wireSocket();
  fetch(`${API}/config`, { headers: { accept: 'application/json' }, cache: 'no-store' })   // nomor WhatsApp Admin (dari Admin Web) untuk tombol bantuan
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => { if (c && (c.waAdmin || '') !== S.waAdmin) { S.waAdmin = c.waAdmin || ''; renderOut(); } })
    .catch(() => {});
})();
