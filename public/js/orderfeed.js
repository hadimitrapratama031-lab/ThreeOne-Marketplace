/* ==========================================================================
   orderfeed.js — Floating Order Notification (Marketplace)
   Sumber data:
   - Awal / setelah reconnect : GET /api/public/recent-orders  (semua order SUCCESS dari MongoDB, terbaru dulu, email sudah ber-masking di server)
   - Order baru               : event Socket.IO `sale:create` (lewat live.js -> script.js -> event DOM "mp:change")
   Aturan:
   - Antrean berisi semua order SUCCESS, terbaru di depan. Order baru masuk ke posisi pertama.
   - Satu order tampil 3 detik, hilang 1 detik, lalu order berikutnya. Setelah yang terakhir kembali ke yang terbaru.
   - Kunci unik = `id` (ID opaque dari server). Event ganda / reconnect / refresh data tidak pernah menambah order yang sama dua kali.
   - Semua teks dipasang lewat textContent (nama pelanggan berasal dari input pengguna).
   ========================================================================== */
(() => {
  const LIMIT = 500;          // maksimal order dalam antrean (samakan dengan FEED_LIMIT di server)
  const SHOW_MS = 3000;       // lama tampil
  const GAP_MS = 1000;        // jeda sebelum order berikutnya (animasi keluar terjadi di dalam jeda ini)
  const FIRST_DELAY_MS = 1200;// notifikasi pertama muncul sesudah halaman tenang
  const KNOWN_MAX = 2000;     // batas memori id yang pernah dilihat (harus lebih besar dari LIMIT)
  const REFETCH_GUARD_MS = 2000;

  const base = (typeof Live !== 'undefined' ? Live.apiBase : '') + '/api/public';

  /* ---------- State ---------- */
  let queue = [];             // terbaru -> terlama, maksimal LIMIT
  const known = new Set();    // semua id yang pernah masuk (termasuk yang sudah keluar dari antrean) -> idempoten
  let lastId = null;          // order yang terakhir ditampilkan (penunjuk posisi, dicari lewat id agar aman saat antrean berubah)
  let restart = false;        // true = putaran berikutnya mulai dari order terbaru
  let timer = null;           // satu-satunya timer mesin; null = mesin diam
  let firstShown = false;
  let skew = 0;               // selisih jam server - jam klien, untuk "x menit lalu"
  let lastFetch = 0;
  let inflight = null;

  /* ---------- DOM (dibuat sekali) ---------- */
  const el = document.createElement('div');
  el.className = 'order-feed';
  el.setAttribute('aria-hidden', 'true');   // sekadar social proof visual; tidak perlu dibacakan setiap 4 detik
  el.innerHTML = `
    <span class="order-feed__thumb">
      <img alt="" decoding="async" referrerpolicy="no-referrer">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12l-1 11H7L6 8Z"/><path d="M9 8V7a3 3 0 0 1 6 0v1"/></svg>
    </span>
    <span class="order-feed__body">
      <span class="order-feed__line"><strong class="of-name"></strong> membeli <span class="of-product"></span></span>
      <span class="order-feed__meta"><span class="of-email"></span><time class="of-time"></time></span>
    </span>`;
  document.body.appendChild(el);

  const $name = el.querySelector('.of-name');
  const $product = el.querySelector('.of-product');
  const $email = el.querySelector('.of-email');
  const $time = el.querySelector('.of-time');
  const $thumb = el.querySelector('.order-feed__thumb');
  const $img = el.querySelector('img');
  $img.addEventListener('load', () => $thumb.classList.add('has-img'));
  $img.addEventListener('error', () => { $thumb.classList.remove('has-img'); $img.removeAttribute('src'); });

  /* ---------- Util ---------- */
  const ts = (item) => Date.parse(item.at) || 0;

  const valid = (x) => x && typeof x.id === 'string' && x.id && typeof x.name === 'string' && typeof x.product === 'string' && x.product;

  function ago(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() + skew - t) / 1000));
    if (s < 60) return 'baru saja';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} menit lalu`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} jam lalu`;
    return `${Math.floor(h / 24)} hari lalu`;
  }

  function remember(id) {
    known.add(id);
    if (known.size > KNOWN_MAX) known.delete(known.values().next().value);   // buang yang paling lama dicatat
  }

  /* ---------- Antrean ---------- */
  /** Masukkan order. Idempoten: id yang sudah pernah dilihat diabaikan, apa pun sumbernya (event, snapshot, reconnect). */
  function ingest(items) {
    const fresh = [];
    for (const x of items) {
      if (!valid(x) || known.has(x.id) || fresh.some((f) => f.id === x.id)) continue;
      fresh.push({ id: x.id, name: x.name, email: x.email || '', product: x.product, imageUrl: x.imageUrl || null, at: x.at || null });
    }
    if (!fresh.length) return;
    fresh.forEach((x) => remember(x.id));

    const prevTop = queue[0]?.id;
    // fresh didahulukan agar saat waktu sama order baru tetap di depan; sort bersifat stabil
    queue = [...fresh, ...queue].sort((a, b) => ts(b) - ts(a)).slice(0, LIMIT);
    if (queue[0]?.id !== prevTop) restart = true;   // ada order terbaru -> putaran berikutnya mulai dari sana
    wake(firstShown ? 0 : FIRST_DELAY_MS);
  }

  function pickNext() {
    let i = 0;
    if (!restart) {
      const at = queue.findIndex((x) => x.id === lastId);
      i = at < 0 ? 0 : (at + 1) % queue.length;   // setelah yang terakhir -> kembali ke yang terbaru
    }
    restart = false;
    return queue[i];
  }

  /* ---------- Mesin tampil/hilang ---------- */
  function schedule(fn, ms) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  }

  function render(item) {
    $name.textContent = item.name;
    $product.textContent = item.product;
    $email.textContent = item.email;
    $email.hidden = !item.email;
    const when = ago(item.at);
    $time.textContent = when;
    $time.hidden = !when;
    if (item.at) $time.dateTime = item.at; else $time.removeAttribute('datetime');
    $thumb.classList.remove('has-img');
    if (item.imageUrl) $img.src = item.imageUrl; else $img.removeAttribute('src');
  }

  function cycle() {
    if (document.hidden || !queue.length) { el.classList.remove('is-in'); return; }   // mesin diam; wake() menyalakannya lagi
    const item = pickNext();
    lastId = item.id;
    firstShown = true;
    render(item);
    el.classList.add('is-in');
    schedule(() => {
      el.classList.remove('is-in');
      schedule(cycle, GAP_MS);
    }, SHOW_MS);
  }

  /** Nyalakan mesin bila sedang diam. Tidak pernah membuat timer kedua, dan tidak menyela notifikasi yang sedang berjalan. */
  function wake(delay = 0) {
    if (timer || document.hidden || !queue.length) return;
    schedule(cycle, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      timer = null;
      el.classList.remove('is-in');
    } else {
      wake(600);
      if (Date.now() - lastFetch > 30_000) load();   // kembali dari tab lain: pastikan tidak ada order yang terlewat
    }
  });

  /* ---------- Data ---------- */
  function load() {
    inflight ||= (async () => {
      lastFetch = Date.now();
      try {
        const res = await fetch(`${base}/recent-orders`, { headers: { accept: 'application/json' }, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (d.serverTime) skew = Date.parse(d.serverTime) - Date.now() || 0;
        ingest(Array.isArray(d.items) ? d.items : []);
      } catch {
        lastFetch = 0;   // gagal: coba lagi pada sinkron berikutnya. Notifikasi bersifat tambahan, tidak boleh mengganggu halaman.
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  document.addEventListener('mp:change', (e) => {
    const { entity, action, payload } = e.detail || {};
    if (entity === 'sale' && action === 'create') ingest([payload]);
    else if (entity === 'sync' && action === 'done' && Date.now() - lastFetch > REFETCH_GUARD_MS) load();   // reconnect / sinkron ulang
  });

  load();
})();
