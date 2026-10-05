/* ==========================================================================
   payment.js — Payment  (payment.html?order=MP-...&t=TOKEN)
   Satu halaman, beberapa keadaan: menunggu pembayaran -> sukses | kedaluwarsa | gagal.
   - Status, nominal (total_amount KlikQRIS) dan batas waktu SELALU dari backend/MongoDB.
     Countdown = expiresAt (jam server) dikurangi jam server; refresh tidak mereset hitungan.
   - Perubahan datang lewat Socket.IO yang sudah ada (room order:<id>); tanpa socket,
     halaman polling pelan. Halaman ini tidak pernah menentukan status sendiri.
   Memakai esc, artwork, $, $$, Live, DATA dari script.js / live.js.
   ========================================================================== */
(() => {
  const root = $('#pay-root');
  const liveMsg = $('#pay-live');
  const qs = new URLSearchParams(location.search);
  const orderNo = qs.get('order') || '';
  const token = qs.get('t') || '';
  const API = `${Live.apiBase}/api/orders`;
  const WINDOW_MS = 10 * 60 * 1000;

  let view = 'loading';                 // loading | ready | notfound | error
  let order = null;
  let offset = 0;                       // selisih jam server - jam perangkat
  let renderedKey = '';
  let first = true;
  let joined = false;
  let pollTimer;

  /* Helper
     -------------------------------------------------------------------------- */
  const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
  const when = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB' : '—');
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const serverNow = () => Date.now() + offset;
  const remaining = () => (order?.expiresAt ? Date.parse(order.expiresAt) - serverNow() : 0);
  const safeHttps = (u) => (/^https:\/\//i.test(u || '') ? u : '');
  const waDigits = (n) => (/^\d{8,15}$/.test(n || '') ? n : '');
  const waLink = (text) => (waDigits(order?.waAdmin) ? `https://wa.me/${order.waAdmin}?text=${encodeURIComponent(text)}` : '');
  const announce = (t) => { liveMsg.textContent = ''; setTimeout(() => { liveMsg.textContent = t; }, 50); };

  const ico = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const I = {
    back: ico('m15 6-6 6 6 6'),
    check: ico('m5 12 5 5 9-10'),
    clock: ico('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2'),
    alert: ico('M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'),
    x: ico('M6 6l12 12M18 6 6 18'),
    info: ico('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01'),
    copy: ico('M9 9h10v10H9zM5 15V5h10'),
    external: ico('M14 4h6v6M20 4 10 14M18 14v6H4V6h6'),
    wa: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2a9.9 9.9 0 0 0-8.5 14.9L2 22l5.25-1.38A9.9 9.9 0 1 0 12.04 2zm0 1.8a8.1 8.1 0 1 1-4.3 14.96l-.31-.19-3.1.82.83-3.02-.2-.32A8.1 8.1 0 0 1 12.04 3.8zM8.6 7.6c-.17 0-.45.06-.69.32-.24.26-.9.88-.9 2.15s.92 2.5 1.05 2.67c.13.17 1.79 2.86 4.4 3.9 2.17.85 2.6.68 3.07.64.47-.04 1.52-.62 1.73-1.22.21-.6.21-1.11.15-1.22-.06-.11-.23-.17-.49-.3-.26-.13-1.52-.75-1.75-.84-.24-.09-.4-.13-.58.13-.17.26-.67.84-.82 1.01-.15.17-.3.2-.56.07-.26-.13-1.1-.4-2.1-1.29-.78-.69-1.3-1.55-1.45-1.81-.15-.26-.02-.4.11-.53.12-.12.26-.3.39-.45.13-.15.17-.26.26-.43.09-.17.04-.32-.02-.45-.06-.13-.58-1.4-.8-1.92-.21-.5-.42-.43-.58-.44z"/></svg>',
  };

  const STEPS = ['Data pembeli', 'Pembayaran', 'Selesai'];
  const stepper = (step) => `
    <ol class="stepper" aria-label="Langkah pembelian">
      ${STEPS.map((label, i) => {
        const n = i + 1;
        const cls = n < step || (step === 3 && n === 3) ? ' class="is-done"' : '';
        const cur = n === step && step !== 3 ? ' aria-current="step"' : '';
        return `<li${cls}${cur}><span class="stepper__dot">${n < step || (step === 3 && n === 3) ? I.check : n}</span><span>${label}</span></li>`;
      }).join('')}
    </ol>`;

  const head = ({ title, lead, step, back = true }) => `
    <header class="pay-head${first ? ' enter' : ''}"${first ? ' style="--d:.05s"' : ''}>
      <div class="pay-head__text">
        ${back && order ? `<a class="pay-back" href="product.html?id=${order.product.id}">${I.back}<span>Kembali ke produk</span></a>` : ''}
        <h1 class="pay-title" id="pay-h">${title}</h1>
        ${lead ? `<p class="pay-lead">${lead}</p>` : ''}
      </div>
      ${stepper(step)}
    </header>`;

  const thumb = (o) => (o.product.imageUrl ? `<img src="${esc(o.product.imageUrl)}" alt="" decoding="async" data-seed="${o.product.id}">` : artwork(o.product.id));

  const copyBtn = (value, label = 'Salin') => `<button class="copy-inline" type="button" data-copy="${esc(value)}" aria-label="${label} ${esc(value)}">${label}</button>`;

  /* Panel ringkasan (dipakai semua keadaan) */
  function summaryPanel(o, { paid = false } = {}) {
    const unique = o.uniqueAmount > 0;
    const total = o.totalAmount ?? o.amount;
    return `
      <section class="panel panel--compact" aria-labelledby="sum-h">
        <h2 class="panel__title" id="sum-h">${paid ? 'Rincian pesanan' : 'Ringkasan pesanan'}</h2>
        <div class="sum-product" style="margin-top:18px">
          <div class="sum-thumb">${thumb(o)}</div>
          <div>
            <p class="sum-name">${esc(o.product.name)}</p>
            ${o.product.category ? `<p class="sum-cat">${esc(o.product.category)}</p>` : ''}
          </div>
        </div>
        <dl class="sum-rows">
          <div class="is-mono"><dt>Order ID</dt><dd>${esc(o.orderNo)}${copyBtn(o.orderNo)}</dd></div>
          <div><dt>Harga produk</dt><dd>${rp(o.amount)}</dd></div>
          ${unique ? `<div><dt>Kode unik</dt><dd>${rp(o.uniqueAmount)}</dd></div>` : ''}
          <div><dt>Metode pembayaran</dt><dd>QRIS</dd></div>
          ${paid ? `<div><dt>Dibayar pada</dt><dd>${when(o.paidAt)}</dd></div>` : ''}
          <div class="is-total"><dt>${paid ? 'Total dibayar' : 'Total bayar'}</dt><dd>${rp(total)}</dd></div>
        </dl>
        <div class="sum-group">
          <p class="sum-group__title">Pembeli</p>
          <dl class="sum-rows">
            <div><dt>Nama</dt><dd>${esc(o.customer.name)}</dd></div>
            <div><dt>Email</dt><dd>${esc(o.customer.email)}</dd></div>
            <div><dt>WhatsApp</dt><dd>+${esc(o.customer.whatsapp)}</dd></div>
          </dl>
        </div>
      </section>`;
  }

  const sandboxNotice = (o) => (o.mode === 'sandbox'
    ? `<div class="notice notice--warn">${I.info}<p><b>Mode uji coba (Sandbox).</b> Pesanan ini tidak memakai uang asli dan tidak untuk pembelian sungguhan.</p></div>` : '');

  /* Keadaan: menunggu pembayaran
     -------------------------------------------------------------------------- */
  function pendingHTML(o) {
    const unique = o.uniqueAmount > 0;
    const qr = safeHttps(o.qrisUrl);
    return `
      ${head({ title: 'Selesaikan pembayaran', lead: 'Scan kode QRIS di bawah sebelum waktu habis. Halaman ini otomatis berganti begitu pembayaran kami terima.', step: 2 })}
      <div class="pay-grid">
        <section class="panel${first ? ' enter' : ''}"${first ? ' style="--d:.15s"' : ''} aria-labelledby="pay-h">
          <div class="pay-main__top">
            <span class="chip chip--wait"><i></i>Menunggu pembayaran</span>
            <div class="timer" id="timer" role="timer" data-urgency="ok"><span>Sisa waktu</span><b id="cd-text">${mmss(remaining())}</b></div>
          </div>

          <div class="pay-main__body">
            <figure class="qr">
              <div class="qr__plate">
                <div class="qr__bar" id="cd-bar" data-urgency="ok"><i style="width:100%"></i></div>
                <div class="qr__frame" id="qr-frame">
                  ${qr ? `<img id="qr-img" src="${esc(qr)}" alt="Kode QRIS pembayaran ${esc(o.orderNo)}" width="300" height="300" decoding="async" referrerpolicy="no-referrer">` : ''}
                </div>
                <p class="qr__mark">QRIS</p>
              </div>
              <figcaption>Scan dengan e-wallet atau mobile banking apa pun yang mendukung QRIS.</figcaption>
            </figure>

            <div class="pay-amount">
              <span class="pay-amount__label">Total pembayaran</span>
              <strong class="pay-amount__value" id="amount">${rp(o.totalAmount)}</strong>
              <p class="pay-amount__note">${unique
                ? `Nominal sudah termasuk kode unik <b>${rp(o.uniqueAmount)}</b>. Bayar <b>tepat sesuai angka ini</b>, sampai digit terakhir.`
                : 'Bayar sesuai nominal di atas.'}</p>
              <div class="pay-amount__actions">
                <button class="btn btn--soft btn--sm" type="button" data-copy="${esc(o.totalAmount)}">${I.copy}<span>Salin nominal</span></button>
                ${qr ? `<a class="btn btn--soft btn--sm" href="${esc(qr)}" target="_blank" rel="noopener noreferrer">${I.external}<span>Buka QR</span></a>` : ''}
              </div>
            </div>
          </div>

          ${sandboxNotice(o)}
          <div class="notice">${I.info}<p>Menutup halaman ini tidak membatalkan pesanan. Buka kembali tautan ini selama waktu belum habis; sisa waktu tetap mengikuti jam server.</p></div>
        </section>

        <aside class="pay-side${first ? ' enter' : ''}"${first ? ' style="--d:.25s"' : ''}>
          ${summaryPanel(o)}
          <section class="panel panel--compact" aria-labelledby="how-h">
            <h2 class="panel__title" id="how-h">Cara membayar</h2>
            <ol class="howto">
              <li>Buka aplikasi <b>e-wallet atau mobile banking</b> yang mendukung QRIS.</li>
              <li>Pilih <b>Scan</b>, arahkan ke kode QR, lalu pastikan nominalnya sama persis.</li>
              <li>Konfirmasi pembayaran. Anda akan melihat halaman sukses di sini tanpa perlu refresh.</li>
            </ol>
          </section>
        </aside>
      </div>`;
  }

  /* Keadaan: waktu habis, memeriksa pembayaran terakhir ke KlikQRIS */
  function checkingHTML(o, preparing = false) {
    return `
      ${head({ title: preparing ? 'Menyiapkan pembayaran' : 'Memeriksa pembayaran', lead: preparing ? 'Kode QRIS sedang dibuat. Sebentar saja.' : 'Waktu pembayaran sudah habis. Kami memastikan dulu apakah pembayaran Anda sudah masuk.', step: 2 })}
      <div class="pay-grid">
        <section class="panel state" role="status">
          <span class="spinner" aria-hidden="true"></span>
          <h2 class="panel__title">${preparing ? 'Membuat kode QRIS…' : 'Mengecek status ke KlikQRIS…'}</h2>
          <p>${preparing ? 'Halaman akan menampilkan kode QRIS otomatis.' : 'Jika Anda baru saja membayar, tunggu beberapa detik. Jangan tutup halaman ini.'}</p>
        </section>
        <aside class="pay-side">${summaryPanel(o)}</aside>
      </div>`;
  }

  /* Keadaan: sukses */
  function successHTML(o) {
    const msg = `Halo Admin, saya sudah membayar pesanan ${o.orderNo} (${o.product.name}) sebesar ${rp(o.totalAmount ?? o.amount)}. Mohon diproses. Terima kasih.`;
    const link = waLink(msg);
    return `
      ${head({ title: 'Pembayaran berhasil', lead: '', step: 3, back: false })}
      <div class="pay-grid">
        <section class="panel swap" aria-labelledby="pay-h" style="padding-block:clamp(28px,4vw,48px)">
          <span class="result-icon result-icon--ok"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg></span>
          <h2 class="result-title">Terima kasih, ${esc(o.customer.name.split(' ')[0])}. Pembayaran Anda sudah kami terima.</h2>
          <p class="result-text">Langkah terakhir: <b>hubungi Admin lewat WhatsApp</b> agar pesanan Anda segera diproses. Sebutkan Order ID <b>${esc(o.orderNo)}</b>; pesan di tombol sudah terisi otomatis.</p>

          <div class="result-actions">
            ${link
              ? `<a class="btn btn--wa" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${I.wa}<span>Hubungi Admin via WhatsApp</span></a>`
              : `<a class="btn btn--primary" href="index.html#contact">Lihat kontak admin</a>`}
            <a class="btn btn--soft" href="index.html">Kembali ke beranda</a>
          </div>
          ${link ? '' : `<div class="notice notice--warn">${I.info}<p>Nomor WhatsApp admin belum diatur. Simpan Order ID <b>${esc(o.orderNo)}</b> dan hubungi admin lewat kontak di beranda.</p></div>`}
          ${sandboxNotice(o)}

          <div class="next">
            <h2>Setelah ini</h2>
            <ol class="howto">
              <li>Klik <b>Hubungi Admin via WhatsApp</b>, lalu kirim pesan yang sudah terisi.</li>
              <li>Admin memeriksa pesanan Anda dan menyiapkan produk.</li>
              <li>Ikuti arahan admin sampai produk Anda diterima.</li>
            </ol>
          </div>
        </section>
        <aside class="pay-side">${summaryPanel(o, { paid: true })}</aside>
      </div>`;
  }

  /* Keadaan: kedaluwarsa */
  function expiredHTML(o) {
    const link = waLink(`Halo Admin, saya butuh bantuan untuk pesanan ${o.orderNo} (${o.product.name}). Waktu pembayaran di halaman sudah habis.`);
    return `
      ${head({ title: 'Waktu pembayaran habis', lead: '', step: 2 })}
      <div class="pay-grid">
        <section class="panel swap" aria-labelledby="pay-h" style="padding-block:clamp(28px,4vw,48px)">
          <span class="result-icon result-icon--warn">${I.clock}</span>
          <h2 class="result-title">Pesanan ini kedaluwarsa karena belum dibayar</h2>
          <p class="result-text">Pembayaran untuk pesanan <b>${esc(o.orderNo)}</b> tidak kami terima dalam 10 menit, jadi kode QRIS tidak berlaku lagi. <b>Jangan membayar dengan kode lama.</b> Buat pesanan baru untuk mendapat kode QRIS yang baru.</p>
          <div class="result-actions">
            <a class="btn btn--primary" href="checkout.html?product=${o.product.id}">Buat pesanan baru</a>
            ${link ? `<a class="btn btn--wa" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${I.wa}<span>Hubungi admin</span></a>` : `<a class="btn btn--soft" href="index.html#contact">Hubungi admin</a>`}
          </div>
          <div class="notice">${I.info}<p>Sudah terlanjur membayar? Hubungi admin dan sertakan Order ID. Pembayaran yang masuk tetap kami periksa, dan halaman ini berubah otomatis bila terkonfirmasi.</p></div>
        </section>
        <aside class="pay-side">${summaryPanel(o)}</aside>
      </div>`;
  }

  /* Keadaan: gagal dibuat */
  function failedHTML(o) {
    const link = waLink(`Halo Admin, pembayaran untuk pesanan ${o.orderNo} (${o.product.name}) gagal diproses. Mohon bantuannya.`);
    return `
      ${head({ title: 'Pembayaran tidak dapat diproses', lead: '', step: 2 })}
      <div class="pay-grid">
        <section class="panel swap" aria-labelledby="pay-h" style="padding-block:clamp(28px,4vw,48px)">
          <span class="result-icon result-icon--danger">${I.x}</span>
          <h2 class="result-title">Kami belum bisa membuat kode pembayaran</h2>
          <p class="result-text">${esc(o.failureReason || 'Transaksi pembayaran tidak dapat dibuat.')} Ini bukan salah Anda; coba buat pesanan lagi. Bila masih gagal, hubungi admin dan sertakan Order ID <b>${esc(o.orderNo)}</b>.</p>
          <div class="result-actions">
            <a class="btn btn--primary" href="checkout.html?product=${o.product.id}">Coba lagi</a>
            ${link ? `<a class="btn btn--wa" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${I.wa}<span>Hubungi admin</span></a>` : `<a class="btn btn--soft" href="index.html#contact">Hubungi admin</a>`}
          </div>
        </section>
        <aside class="pay-side">${summaryPanel(o)}</aside>
      </div>`;
  }

  function stateHTML() {
    if (view === 'loading') {
      return `
        ${head({ title: 'Memuat pembayaran', lead: '', step: 2, back: false })}
        <div class="pay-grid" aria-busy="true">
          <section class="panel"><div class="sk"><i class="w40"></i><i class="sq"></i><i class="lg"></i></div></section>
          <aside class="pay-side"><section class="panel panel--compact"><div class="sk"><i class="w60"></i><i></i><i></i><i></i></div></section></aside>
        </div>`;
    }
    const nf = view === 'notfound';
    return `
      <section class="panel state swap" role="alert">
        <span class="result-icon result-icon--${nf ? 'warn' : 'danger'}">${I.alert}</span>
        <h1>${nf ? 'Pesanan tidak ditemukan' : 'Pembayaran belum bisa dimuat'}</h1>
        <p>${nf ? 'Tautan pembayaran tidak valid atau sudah salah ketik. Gunakan tautan lengkap yang muncul setelah checkout.' : 'Periksa koneksi Anda, lalu coba lagi. Pesanan Anda aman dan tidak berubah.'}</p>
        <div class="result-actions">
          ${nf ? '<a class="btn btn--primary" href="index.html#product">Lihat produk</a>' : '<button class="btn btn--primary" type="button" data-retry>Coba lagi</button>'}
        </div>
      </section>`;
  }

  /* Render (hanya saat keadaan berubah; hitungan mundur diperbarui terpisah)
     -------------------------------------------------------------------------- */
  const phase = () => {
    if (view !== 'ready') return view;
    if (order.status === 'PENDING') return !order.qrisUrl ? 'preparing' : remaining() <= 0 ? 'checking' : 'pending';
    return order.status.toLowerCase();
  };

  const TITLES = { pending: 'Menunggu pembayaran', checking: 'Memeriksa pembayaran', preparing: 'Menyiapkan pembayaran', success: 'Pembayaran berhasil', expired: 'Waktu pembayaran habis', failed: 'Pembayaran gagal' };
  const SAY = { success: 'Pembayaran berhasil diterima.', expired: 'Waktu pembayaran habis.', failed: 'Pembayaran tidak dapat diproses.', checking: 'Waktu habis. Memeriksa pembayaran terakhir.' };

  function render() {
    const ph = phase();
    const key = `${ph}|${order?.waAdmin || ''}`;
    if (key === renderedKey) return;
    const prev = renderedKey.split('|')[0];
    renderedKey = key;

    const o = order;
    root.innerHTML = ({
      loading: stateHTML, notfound: stateHTML, error: stateHTML,
      pending: () => pendingHTML(o), checking: () => checkingHTML(o), preparing: () => checkingHTML(o, true),
      success: () => successHTML(o), expired: () => expiredHTML(o), failed: () => failedHTML(o),
    }[ph])();
    first = false;
    document.title = `${TITLES[ph] || 'Pembayaran'} — ${DATA.brand}`;
    if (prev !== ph && SAY[ph]) announce(SAY[ph]);
    if (ph === 'success' || ph === 'expired' || ph === 'failed') window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    if (ph === 'checking') schedulePoll();        // rapatkan pengecekan begitu waktu habis
    tick();
  }

  /* Hitungan mundur: jam server, tanpa render ulang */
  function tick() {
    if (view !== 'ready' || order.status !== 'PENDING' || !order.expiresAt) return;
    const rem = remaining();
    const timer = $('#timer');
    if (timer) {
      const urgency = rem <= 30_000 ? 'now' : rem <= 120_000 ? 'soon' : 'ok';
      timer.dataset.urgency = urgency;
      $('#cd-text').textContent = mmss(rem);
      const bar = $('#cd-bar');
      bar.dataset.urgency = urgency;
      $('i', bar).style.width = `${Math.max(0, Math.min(100, (rem / WINDOW_MS) * 100))}%`;
    }
    if (rem <= 0) render();           // waktu habis: tampilkan "memeriksa pembayaran" (render() mengabaikan pemanggilan ulang)
  }
  setInterval(tick, 250);

  /* Terapkan data order (dari GET, ack join, atau event) — usang & ganda diabaikan
     -------------------------------------------------------------------------- */
  function applyOrder(next, sentAt) {
    if (!next || next.orderNo !== orderNo) return;
    if (order && next.rev < order.rev) return;
    const same = order && next.rev === order.rev && next.waAdmin === order.waAdmin;
    const t = next.serverTime ? Date.parse(next.serverTime) : NaN;
    if (Number.isFinite(t)) offset = t - (sentAt ? (sentAt + Date.now()) / 2 : Date.now());
    if (same) return;
    order = next;
    view = 'ready';
    render();
    schedulePoll();
  }

  async function fetchOrder() {
    const sentAt = Date.now();
    try {
      const res = await fetch(`${API}/${encodeURIComponent(orderNo)}`, { headers: { accept: 'application/json', 'x-order-token': token }, cache: 'no-store' });
      if (res.status === 404) { if (!order) { view = 'notfound'; renderedKey = ''; render(); } return; }
      if (!res.ok) throw new Error(String(res.status));
      applyOrder((await res.json()).order, sentAt);
    } catch {
      if (!order && view !== 'error') { view = 'error'; renderedKey = ''; render(); }
    }
  }

  /* Polling cadangan: lambat saat socket tersambung (hanya penyembuh event yang terlewat), rapat saat tidak */
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!order || !['PENDING', 'EXPIRED'].includes(order.status)) return;   // EXPIRED: pembayaran terlambat masih bisa terkonfirmasi
    const socketOk = Live.socket?.connected && joined;
    const delay = order.status === 'EXPIRED' ? (socketOk ? 60_000 : 30_000) : phase() === 'checking' ? 1500 : socketOk ? 20_000 : 4000;
    pollTimer = setTimeout(async () => { await fetchOrder(); schedulePoll(); }, delay);
  }

  /* Realtime: Socket.IO yang sudah ada */
  function joinRoom() {
    const s = Live.socket;
    if (!s || !s.connected) return;
    s.emit('order:join', { orderNo, token }, (ack) => {
      joined = Boolean(ack?.ok);
      if (joined) applyOrder(ack.order);
      schedulePoll();
    });
  }

  function wireSocket() {
    const s = Live.socket;
    if (!s) return;
    s.on('order:update', (o) => applyOrder(o));
    s.on('payment:settings', ({ waAdmin }) => {            // admin mengganti nomor WhatsApp: tombol ikut berubah
      if (!order || order.waAdmin === waAdmin) return;
      order.waAdmin = waAdmin;
      render();
    });
    s.on('connect', () => { joined = false; joinRoom(); });
    s.on('disconnect', () => { joined = false; schedulePoll(); });
    if (s.connected) joinRoom();
  }

  /* Interaksi */
  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* abaikan */ }
      ta.remove();
    }
    const label = $('span', btn) || btn;
    const old = label.textContent;
    label.textContent = 'Tersalin';
    setTimeout(() => { label.textContent = old; }, 1600);
  }

  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copyText(c.dataset.copy, c);
    if (e.target.closest('[data-retry]')) { view = 'loading'; renderedKey = ''; render(); fetchOrder(); return; }
    const retryQr = e.target.closest('[data-qr-retry]');
    if (retryQr) {
      const frame = $('#qr-frame');
      const url = safeHttps(order?.qrisUrl);
      if (frame && url) frame.innerHTML = `<img id="qr-img" src="${esc(url)}${url.includes('?') ? '&' : '?'}r=${Date.now()}" alt="Kode QRIS pembayaran ${esc(order.orderNo)}" width="300" height="300" referrerpolicy="no-referrer">`;
    }
  });

  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG') return;
    if (img.id === 'qr-img') {
      $('#qr-frame').innerHTML = `<div class="qr__fail"><p>Kode QR belum bisa dimuat.</p><button type="button" data-qr-retry>Muat ulang</button></div>`;
    } else if (img.dataset.seed && img.closest('.sum-thumb')) img.outerHTML = artwork(+img.dataset.seed);
  }, true);

  const watching = () => !order || ['PENDING', 'EXPIRED'].includes(order.status);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && watching()) fetchOrder(); });
  addEventListener('online', () => { if (watching()) fetchOrder(); });

  /* Mulai */
  if (!/^MP-\d{6}-[A-Z0-9]{6}$/.test(orderNo) || !token) { view = 'notfound'; render(); return; }
  render();
  fetchOrder().then(() => { wireSocket(); schedulePoll(); });
})();
