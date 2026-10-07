/* ==========================================================================
   livechat.js — Live Chat Marketplace (pelanggan)
   - Sumber kebenaran = MongoDB lewat API /api/livechat. localStorage hanya menyimpan penunjuk sesi {id, token}
     (seperti cookie): setiap buka halaman, sesi divalidasi ulang ke server; expired -> penunjuk dibuang.
   - Realtime memakai Socket.IO yang sudah ada (Live.socket dari live.js). TIDAK membuat koneksi baru.
     Listener didaftarkan SEKALI; room percakapan di-join ulang di setiap 'connect' dan snapshot dari server
     dipakai untuk sinkron ulang (reconnect / refresh / tab lama aman).
   - Pesan di-dedupe lewat clientId (kunci yang sama dipakai server untuk idempotensi), jadi retry, event ganda,
     dan multi-tab tidak pernah menampilkan pesan dua kali.
   - Semua teks pengguna dipasang lewat textContent (tidak pernah innerHTML).
   ========================================================================== */
(() => {
  'use strict';
  if (window.__mpLivechat) return;   // anti dobel bila script termuat dua kali
  window.__mpLivechat = true;

  const API = `${typeof Live !== 'undefined' ? Live.apiBase : ''}/api/livechat`;
  const KEY = 'mp_livechat_session';
  const PROFILE = 'mp_livechat_profile';
  const OK_IMG = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const MAX_IMG = 8 * 1024 * 1024;
  const compact = /^\/(checkout|payment)\/?$/.test(location.pathname);

  /* ---------- util ---------- */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* mode privat */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* abaikan */ } },
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0, 32).padEnd(16, '0'));
  const mkErr = (status, message, details) => Object.assign(new Error(message), { status, code: details?.code, fields: details?.fields || {} });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const isTouch = () => matchMedia('(pointer: coarse)').matches;
  const isMobile = () => matchMedia('(max-width: 520px)').matches;

  const S = {
    enabled: false, open: false, view: 'form', session: null, conv: null,
    byKey: new Map(), pending: new Map(), file: null, filePreview: '', unread: 0,
    skew: 0, lastSeq: 0, clientKey: null, joined: false, joining: false, stick: true, teaserReady: false,
  };
  const now = () => Date.now() + S.skew;
  const sock = () => (typeof Live !== 'undefined' ? Live.socket : null);
  const keyOf = (m) => m.clientId || m.id;

  /* ---------- request ---------- */
  async function req(path, { method = 'GET', body, form, token } = {}) {
    const headers = {};
    if (token) headers['x-livechat-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try { res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : form, cache: 'no-store' }); } catch { throw mkErr(0, 'Tidak dapat terhubung. Periksa koneksi Anda.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw mkErr(res.status, data.error?.message || 'Permintaan gagal. Coba lagi.', data.error?.details);
    return data;
  }
  function xhrSend(path, form, token, onProgress) {   // XHR agar progres upload gambar nyata
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', API + path);
      x.setRequestHeader('x-livechat-token', token);
      x.timeout = 90_000;
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch { /* bukan JSON */ }
        if (x.status >= 200 && x.status < 300) resolve(d); else reject(mkErr(x.status, d.error?.message || 'Gagal mengirim gambar. Coba lagi.', d.error?.details));
      };
      x.onerror = () => reject(mkErr(0, 'Koneksi terputus saat mengirim gambar. Coba lagi.'));
      x.ontimeout = () => reject(mkErr(0, 'Pengiriman gambar terlalu lama. Coba lagi.'));
      x.send(form);
    });
  }

  /* ---------- DOM (dibuat sekali; isi dinamis lewat textContent) ---------- */
  const I = {
    chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    clip: '<svg viewBox="0 0 24 24"><path d="m21 11.5-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8"/></svg>',
    smile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M5 12 20 4l-5 16-3-6.5Z"/><path d="m12 13.5 8-9.5"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  };
  const root = document.createElement('div');
  root.className = 'lc';
  root.hidden = true;
  root.dataset.open = 'false';
  root.dataset.view = 'form';
  root.dataset.teaser = 'false';
  root.dataset.compact = String(compact);
  root.innerHTML = `
    <button type="button" class="lc-teaser" data-r="teaser">Butuh bantuan? Chat disini</button>
    <section class="lc-panel" id="lc-panel" role="dialog" aria-label="Live Chat">
      <header class="lc-head">
        <div class="lc-head__text"><h2>Bantuan pelanggan</h2><p data-r="sub">Tim kami siap membantu</p></div>
        <button type="button" class="lc-x" data-r="close" aria-label="Tutup Live Chat">${I.x}</button>
        <div class="lc-life" aria-hidden="true" data-r="lifebox" hidden><i data-r="life"></i></div>
      </header>
      <div class="lc-body">
        <div class="lc-view lc-view--form">
          <p class="lc-endnote" data-r="endnote" role="status" hidden></p>
          <div class="lc-intro"><h3>Mulai percakapan</h3><p>Isi nama Anda agar tim kami bisa menyapa dengan tepat.</p></div>
          <form class="lc-form" data-r="form" novalidate>
            <label class="lc-field" data-f="name"><span>Nama</span><input type="text" name="name" maxlength="60" autocomplete="name" placeholder="Nama Anda"></label>
            <label class="lc-field" data-f="whatsapp"><span>Nomor WhatsApp (opsional)</span><input type="tel" name="whatsapp" inputmode="tel" maxlength="25" autocomplete="tel" placeholder="0812 3456 7890"><small>Dipakai bila tim perlu menghubungi Anda di luar chat.</small></label>
            <input class="lc-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
            <p class="lc-formerr" data-r="formerr" role="alert" hidden></p>
            <button class="lc-primary" type="submit" data-r="start">Mulai chat</button>
          </form>
        </div>
        <div class="lc-view lc-view--chat">
          <div class="lc-sw">
            <div class="lc-scroll" data-r="scroll" role="log" aria-live="polite" aria-label="Pesan"></div>
            <button type="button" class="lc-newpill" data-r="newpill" hidden>${I.down}<span>Pesan baru</span></button>
          </div>
          <div class="lc-dock">
            <div class="lc-emoji" data-r="emoji" hidden></div>
            <div class="lc-note" data-r="note" hidden></div>
            <div data-r="composewrap">
              <div class="lc-preview" data-r="preview" hidden>
                <img alt="Pratinjau gambar"><div style="min-width:0"><div class="lc-preview__name" data-r="pname"></div><div class="lc-preview__sub" data-r="psub"></div></div>
                <button type="button" class="lc-ibtn" data-r="premove" aria-label="Batalkan gambar">${I.x}</button>
              </div>
              <div class="lc-compose">
                <button type="button" class="lc-ibtn" data-r="attach" aria-label="Lampirkan gambar">${I.clip}</button>
                <textarea rows="1" data-r="ta" maxlength="1000" placeholder="Tulis pesan" aria-label="Tulis pesan"></textarea>
                <button type="button" class="lc-ibtn" data-r="emojibtn" aria-label="Pilih emoji" aria-pressed="false">${I.smile}</button>
                <button type="button" class="lc-send" data-r="send" aria-label="Kirim pesan" disabled>${I.send}</button>
              </div>
              <input type="file" data-r="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
            </div>
          </div>
        </div>
        <div class="lc-lightbox" data-r="lightbox" hidden><img alt="Gambar diperbesar"></div>
      </div>
    </section>
    <button type="button" class="lc-fab" data-r="fab" aria-expanded="false" aria-controls="lc-panel" aria-label="Buka Live Chat">
      <span class="lc-ico-chat">${I.chat}</span><span class="lc-ico-close">${I.down}</span>
      <span class="lc-badge" data-r="badge" hidden></span>
    </button>`;
  document.body.appendChild(root);
  if (compact) document.body.classList.add('lc-pad');
  const $ = (n) => root.querySelector(`[data-r="${n}"]`);
  const el = Object.fromEntries(['teaser', 'sub', 'close', 'lifebox', 'life', 'endnote', 'form', 'formerr', 'start', 'scroll', 'newpill', 'emoji', 'note', 'composewrap', 'preview', 'pname', 'psub', 'premove', 'attach', 'ta', 'emojibtn', 'send', 'file', 'lightbox', 'fab', 'badge'].map((n) => [n, $(n)]));
  const previewImg = el.preview.querySelector('img');
  const lightboxImg = el.lightbox.querySelector('img');
  const els = new Map();   // key -> elemen pesan

  /* ---------- tampilan: header, badge, composer ---------- */
  function expiryLabel(iso) {
    const d = new Date(iso);
    const n = new Date(now());
    const t = fmtTime(iso);
    if (sameDay(d, n)) return `hari ini ${t}`;
    if (sameDay(d, new Date(n.getTime() + 86_400_000))) return `besok ${t}`;
    return `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} ${t}`;
  }
  function renderHead() {
    const c = S.conv;
    const live = S.view === 'chat' && c;
    el.lifebox.hidden = !live || c.status !== 'active';
    if (!live) { el.sub.textContent = 'Tim kami siap membantu'; return; }
    el.sub.textContent = c.status === 'closed' ? 'Percakapan ditutup' : `Aktif hingga ${expiryLabel(c.expiresAt)}`;
    const total = Date.parse(c.expiresAt) - Date.parse(c.createdAt);
    const left = Math.max(0, Math.min(1, (Date.parse(c.expiresAt) - now()) / total));
    el.life.style.transform = `scaleX(${left})`;
  }
  function renderBadge() {
    const n = S.open ? 0 : S.unread;
    el.badge.hidden = n <= 0;
    el.badge.textContent = n > 9 ? '9+' : String(n);
    el.fab.setAttribute('aria-label', S.open ? 'Tutup Live Chat' : n > 0 ? `Buka Live Chat, ${n} pesan baru` : 'Buka Live Chat');
  }
  function renderComposer() {
    const closed = S.conv?.status === 'closed';
    el.composewrap.hidden = closed;
    el.note.hidden = !closed;
    if (closed) {
      el.note.replaceChildren();
      const t = document.createElement('span');
      t.innerHTML = '<b>Percakapan ditutup.</b> Mulai percakapan baru bila Anda masih butuh bantuan.';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lc-ghost'; b.textContent = 'Percakapan baru';
      b.addEventListener('click', () => endSession('new'));
      el.note.append(t, b);
    }
    el.send.disabled = !(el.ta.value.trim() || S.file);
  }
  function setView(v) {
    S.view = v;
    root.dataset.view = v;
    renderHead();
    renderComposer();
  }

  /* ---------- daftar pesan ---------- */
  const nearBottom = () => el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight < 90;
  const toBottom = () => { el.scroll.scrollTop = el.scroll.scrollHeight; S.stick = true; el.newpill.hidden = true; };
  function dayLabel(iso) {
    const d = new Date(iso);
    const n = new Date(now());
    if (sameDay(d, n)) return 'Hari ini';
    if (sameDay(d, new Date(n.getTime() - 86_400_000))) return 'Kemarin';
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long' });
  }
  function metaText(m) {
    const meta = document.createElement('div');
    meta.className = 'lc-meta';
    const t = document.createElement('time');
    t.dateTime = m.at; t.textContent = fmtTime(m.at);
    meta.append(t);
    if (m.sender === 'customer' && !m.local && S.conv && m.seq <= (S.conv.adminReadSeq || 0)) {
      const r = document.createElement('span');
      r.textContent = 'Dibaca';
      meta.append(r);
    }
    return meta;
  }
  function buildMsg(m) {
    const mine = m.sender === 'customer';
    const wrap = document.createElement('div');
    wrap.className = `lc-msg lc-msg--${mine ? 'me' : 'them'}${m.status === 'sending' ? ' is-sending' : ''}${m.status === 'failed' ? ' is-failed' : ''}`;
    wrap.dataset.key = keyOf(m);
    wrap.dataset.seq = m.seq || '';
    wrap.dataset.at = m.at;
    const b = document.createElement('div');
    if (m.type === 'image') {
      b.className = 'lc-bubble lc-bubble--img';
      const img = document.createElement('img');
      img.alt = mine ? 'Gambar yang Anda kirim' : 'Gambar dari tim kami';
      img.decoding = 'async';
      img.src = m.image?.url || m.localUrl || '';
      img.addEventListener('load', () => { if (S.stick) toBottom(); });
      img.addEventListener('click', () => { lightboxImg.src = img.src; el.lightbox.hidden = false; });
      b.append(img);
      if (m.status === 'sending') {
        const up = document.createElement('div'); up.className = 'lc-up';
        const bar = document.createElement('div'); bar.className = 'lc-bar';
        const fill = document.createElement('i'); fill.style.width = `${Math.round((m.progress || 0) * 100)}%`;
        bar.append(fill); up.append(bar); b.append(up);
        wrap._fill = fill;
      }
    } else {
      b.className = 'lc-bubble';
      b.textContent = m.text;
    }
    wrap.append(b);
    if (m.status === 'failed') {
      const r = document.createElement('button');
      r.type = 'button'; r.className = 'lc-retry'; r.textContent = 'Gagal terkirim. Coba lagi';
      r.title = m.error || '';
      r.addEventListener('click', () => retry(keyOf(m)));
      wrap.append(r);
    } else {
      wrap.append(metaText(m));
    }
    return wrap;
  }
  function renderAll() {
    const list = [...S.byKey.values()].sort((a, b) => (a.local ? 1 : 0) - (b.local ? 1 : 0) || (a.seq || 0) - (b.seq || 0) || Date.parse(a.at) - Date.parse(b.at));
    els.clear();
    el.scroll.replaceChildren();
    if (!list.length) { appendEmpty(); return; }
    let day = '';
    for (const m of list) {
      const dl = dayLabel(m.at);
      if (dl !== day) { day = dl; el.scroll.append(daySep(dl)); }
      const node = buildMsg(m);
      els.set(keyOf(m), node);
      el.scroll.append(node);
    }
    toBottom();
  }
  function appendEmpty() {
    const e = document.createElement('div');
    e.className = 'lc-empty'; e.dataset.empty = '1';
    e.textContent = 'Tulis pesan pertama Anda. Tim kami akan membalas di sini.';
    el.scroll.append(e);
  }
  function daySep(label) { const d = document.createElement('div'); d.className = 'lc-day'; d.textContent = label; return d; }

  /** Tambah / perbarui pesan. Kunci = clientId (sama untuk pesan lokal dan versi server) sehingga tidak pernah dobel. */
  function upsert(m) {
    const key = keyOf(m);
    const prev = S.byKey.get(key);
    if (prev && !prev.local && m.local) return;   // jangan menurunkan pesan server menjadi "mengirim"
    const next = { ...prev, ...m };
    if (!m.local) { next.local = false; next.status = undefined; if (m.seq && m.seq > S.lastSeq) S.lastSeq = m.seq; }
    S.byKey.set(key, next);
    const old = els.get(key);
    if (old) {
      const maxSeq = Math.max(0, ...[...S.byKey.values()].map((x) => x.seq || 0));
      if (prev?.local && !next.local && next.seq < maxSeq) { renderAll(); return; }   // urutan berubah: susun ulang
      const node = buildMsg(next);
      old.replaceWith(node);
      els.set(key, node);
      return;
    }
    const outOfOrder = !next.local && next.seq && [...els.values()].some((n) => Number(n.dataset.seq) > next.seq);
    if (outOfOrder) { renderAll(); return; }
    const stick = S.stick || next.sender === 'customer';
    el.scroll.querySelector('[data-empty]')?.remove();
    const lastTime = [...els.values()].at(-1)?.dataset.at;
    if (!lastTime || dayLabel(lastTime) !== dayLabel(next.at)) el.scroll.append(daySep(dayLabel(next.at)));
    const node = buildMsg(next);
    els.set(key, node);
    el.scroll.append(node);
    if (stick) toBottom(); else el.newpill.hidden = false;
  }
  function refreshReceipts() {
    for (const [key, node] of els) {
      const m = S.byKey.get(key);
      if (!m || m.sender !== 'customer' || m.local) continue;
      const old = node.querySelector('.lc-meta');
      if (old) old.replaceWith(metaText(m));
    }
  }

  /* ---------- sesi ---------- */
  function resetMessages() {
    for (const m of S.byKey.values()) if (m.localUrl) URL.revokeObjectURL(m.localUrl);
    S.byKey.clear(); S.pending.clear(); els.clear(); S.lastSeq = 0;
    el.scroll.replaceChildren();
    clearFile();
  }
  let expiryTimer; let tickTimer;
  function armTimers() {
    clearTimeout(expiryTimer); clearInterval(tickTimer);
    if (!S.conv || S.conv.status === 'expired') return;
    // Cadangan UI saja: server yang menentukan. Sedikit setelah expiresAt, tanyakan ke server (bukan memutuskan sendiri).
    const wait = Date.parse(S.conv.expiresAt) - now() + 1500;
    expiryTimer = setTimeout(verify, Math.max(1000, Math.min(wait, 2 ** 31 - 1)));
    tickTimer = setInterval(renderHead, 30_000);
  }
  async function verify() {
    if (!S.session) return;
    try { applySnapshot(await req(`/conversations/${S.session.id}`, { token: S.session.token })); } catch (err) { if (err.status === 404 || err.status === 410) endSession(S.open ? 'expired' : 'silent'); }
  }
  function applySnapshot(snap) {
    if (typeof snap.serverTime === 'string') S.skew = Date.parse(snap.serverTime) - Date.now();
    S.conv = { ...S.conv, ...snap.conversation };
    S.unread = S.conv.unread || 0;
    const first = S.view !== 'chat' || !els.size;
    for (const m of snap.messages) upsert({ ...m, local: false });
    if (first) renderAll();
    for (const [k] of S.pending) if (S.byKey.get(k) && !S.byKey.get(k).local) S.pending.delete(k);   // sudah ada di server
    setView('chat');
    renderBadge();
    armTimers();
    maybeMarkRead();
  }
  function endSession(reason) {
    clearTimeout(expiryTimer); clearInterval(tickTimer);
    if (S.session && sock()?.connected) sock().emit('livechat:leave', { conversationId: S.session.id });
    store.del(KEY);
    S.session = null; S.conv = null; S.joined = false; S.unread = 0; S.clientKey = null;
    resetMessages();
    el.endnote.hidden = reason !== 'expired';
    if (reason === 'expired') el.endnote.textContent = 'Percakapan sebelumnya sudah berakhir. Live Chat aktif selama 24 jam sejak dimulai, silakan mulai percakapan baru.';
    const p = store.get(PROFILE);
    if (p) { el.form.elements.name.value = p.name || ''; el.form.elements.whatsapp.value = p.whatsapp || ''; }
    setView('form');
    renderBadge();
    if (S.open) setTimeout(() => el.form.elements.name.focus(), 50);
  }

  /* ---------- mulai percakapan ---------- */
  const fieldErr = (name, msg) => {
    const f = el.form.querySelector(`[data-f="${name}"]`);
    f.classList.toggle('invalid', Boolean(msg));
    f.querySelector('.lc-err')?.remove();
    if (msg) { const s = document.createElement('span'); s.className = 'lc-err'; s.setAttribute('role', 'alert'); s.textContent = msg; f.append(s); }
  };
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.form.elements.name.value.replace(/\s+/g, ' ').trim();
    const whatsapp = el.form.elements.whatsapp.value.trim();
    fieldErr('name', ''); fieldErr('whatsapp', ''); el.formerr.hidden = true;
    if (name.length < 2) { fieldErr('name', 'Nama wajib diisi (minimal 2 karakter)'); el.form.elements.name.focus(); return; }
    S.clientKey ||= uid();   // dipertahankan saat retry: server mengembalikan percakapan yang sama, bukan membuat baru
    el.start.disabled = true; el.start.textContent = 'Menyiapkan chat…';
    try {
      const data = await req('/conversations', { method: 'POST', body: { name, whatsapp, clientKey: S.clientKey, website: el.form.elements.website.value } });
      S.clientKey = null;
      S.session = { id: data.conversation.id, token: data.token };
      store.set(KEY, S.session);
      store.set(PROFILE, { name, whatsapp });
      el.endnote.hidden = true;
      applySnapshot(data);
      join();
      el.ta.focus();
    } catch (err) {
      if (err.code === 'disabled') { setEnabled(false); return; }
      if (err.status === 410) S.clientKey = null;
      const f = err.fields || {};
      if (f.name || f.whatsapp) { fieldErr('name', f.name || ''); fieldErr('whatsapp', f.whatsapp || ''); } else { el.formerr.textContent = err.message; el.formerr.hidden = false; }
    } finally { el.start.disabled = false; el.start.textContent = 'Mulai chat'; }
  });

  /* ---------- kirim pesan ---------- */
  function newLocal(extra) { return { id: `local:${uid()}`, clientId: uid(), sender: 'customer', at: new Date(now()).toISOString(), local: true, status: 'sending', progress: 0, ...extra }; }
  function submit() {
    if (!S.session || S.conv?.status !== 'active') return;
    const text = el.ta.value.trim();
    const file = S.file;
    if (!text && !file) return;
    if (text) { const m = newLocal({ type: 'text', text }); S.pending.set(m.clientId, { m, text }); upsert(m); deliver(m.clientId); }
    if (file) { const m = newLocal({ type: 'image', localUrl: S.filePreview }); S.pending.set(m.clientId, { m, file }); S.filePreview = ''; upsert(m); deliver(m.clientId); }
    el.ta.value = ''; autosize(); clearFile(true); renderComposer();
    toBottom();
  }
  async function deliver(key) {
    const rec = S.pending.get(key);
    if (!rec || !S.session) return;
    const { id, token } = S.session;
    const m = S.byKey.get(key);
    if (m?.status === 'failed') { upsert({ ...m, status: 'sending', progress: 0 }); }
    try {
      let data;
      if (rec.file) {
        const fd = new FormData();
        fd.append('clientId', rec.m.clientId); fd.append('type', 'image'); fd.append('image', rec.file, rec.file.name);
        data = await xhrSend(`/conversations/${id}/messages`, fd, token, (p) => { const cur = S.byKey.get(key); if (cur) cur.progress = p; const n = els.get(key); if (n?._fill) n._fill.style.width = `${Math.round(p * 100)}%`; });
      } else {
        data = await req(`/conversations/${id}/messages`, { method: 'POST', token, body: { clientId: rec.m.clientId, type: 'text', text: rec.text } });
      }
      S.pending.delete(key);
      const cur = S.byKey.get(key);
      if (cur?.localUrl) URL.revokeObjectURL(cur.localUrl);
      S.conv = { ...S.conv, ...data.conversation };
      upsert({ ...data.message, local: false, localUrl: undefined });
    } catch (err) {
      if (err.code === 'closed') { S.conv.status = 'closed'; S.pending.delete(key); S.byKey.delete(key); els.get(key)?.remove(); els.delete(key); renderHead(); renderComposer(); return; }
      if (err.status === 404 || err.status === 410) { endSession('expired'); return; }
      if (err.code === 'disabled') { setEnabled(false); return; }
      const cur = S.byKey.get(key) || rec.m;
      upsert({ ...cur, status: 'failed', error: err.message });
    }
  }
  const retry = (key) => deliver(key);

  /* ---------- composer ---------- */
  function autosize() { el.ta.style.height = 'auto'; el.ta.style.height = `${Math.min(el.ta.scrollHeight, 120)}px`; }
  el.ta.addEventListener('input', () => { autosize(); renderComposer(); });
  el.ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) { e.preventDefault(); submit(); }
  });
  el.send.addEventListener('click', submit);
  el.attach.addEventListener('click', () => el.file.click());
  function clearFile(keepUrl) {
    if (S.filePreview && !keepUrl) URL.revokeObjectURL(S.filePreview);
    S.file = null; S.filePreview = ''; el.preview.hidden = true; previewImg.removeAttribute('src'); el.file.value = '';
  }
  el.premove.addEventListener('click', () => { clearFile(); renderComposer(); });
  el.file.addEventListener('change', () => {
    const f = el.file.files?.[0];
    if (!f) return;
    if (!OK_IMG.includes(f.type)) { flash('Format tidak didukung. Gunakan JPG, PNG, WebP, atau GIF.'); el.file.value = ''; return; }
    if (f.size > MAX_IMG) { flash(`Ukuran gambar terlalu besar (maksimal ${kb(MAX_IMG)}).`); el.file.value = ''; return; }
    clearFile();
    S.file = f; S.filePreview = URL.createObjectURL(f);
    previewImg.src = S.filePreview; el.pname.textContent = f.name; el.psub.textContent = `${kb(f.size)}, siap dikirim`;
    el.preview.hidden = false;
    renderComposer();
  });
  let flashT;
  function flash(msg) {   // pesan galat singkat di area catatan
    el.note.hidden = false; el.note.textContent = msg; el.note.style.color = 'var(--lc-danger)';
    clearTimeout(flashT);
    flashT = setTimeout(() => { el.note.style.color = ''; renderComposer(); if (S.conv?.status !== 'closed') el.note.hidden = true; }, 4000);
  }

  /* emoji picker: modul dimuat saat pertama dibuka */
  let emojiBuilt = false;
  async function toggleEmoji() {
    const open = el.emoji.hidden;
    if (open && !emojiBuilt) {
      try {
        const { EMOJI_GROUPS } = await import(new URL('js/livechat-emoji.js', document.baseURI).href);
        const tabs = document.createElement('div'); tabs.className = 'lc-emoji__tabs'; tabs.setAttribute('role', 'tablist');
        const grid = document.createElement('div'); grid.className = 'lc-emoji__grid';
        const show = (g) => {
          [...tabs.children].forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === g.id)));
          grid.replaceChildren(...g.items.map((ch) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = ch; b.setAttribute('aria-label', ch); b.addEventListener('click', () => insertEmoji(ch)); return b; }));
        };
        EMOJI_GROUPS.forEach((g, i) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.id = g.id; b.textContent = g.icon; b.setAttribute('role', 'tab'); b.setAttribute('aria-label', g.label); b.addEventListener('click', () => show(g)); tabs.append(b); if (i === 0) setTimeout(() => show(g)); });
        el.emoji.append(tabs, grid);
        emojiBuilt = true;
      } catch { flash('Emoji tidak dapat dimuat. Coba lagi.'); return; }
    }
    el.emoji.hidden = !open;
    el.emojibtn.setAttribute('aria-pressed', String(open));
  }
  function insertEmoji(ch) {
    const { selectionStart: a, selectionEnd: b } = el.ta;
    if (el.ta.value.length + ch.length > 1000) return;
    el.ta.setRangeText(ch, a, b, 'end');
    el.ta.dispatchEvent(new Event('input'));
    el.ta.focus();
  }
  el.emojibtn.addEventListener('click', toggleEmoji);
  document.addEventListener('click', (e) => { if (!el.emoji.hidden && !e.target.closest('.lc-emoji') && !e.target.closest('[data-r="emojibtn"]')) { el.emoji.hidden = true; el.emojibtn.setAttribute('aria-pressed', 'false'); } });

  /* ---------- scroll, lightbox, buka/tutup ---------- */
  el.scroll.addEventListener('scroll', () => { S.stick = nearBottom(); if (S.stick) { el.newpill.hidden = true; maybeMarkRead(); } }, { passive: true });
  el.newpill.addEventListener('click', toBottom);
  el.lightbox.addEventListener('click', () => { el.lightbox.hidden = true; lightboxImg.removeAttribute('src'); });

  function setOpen(open) {
    if (open && !S.enabled) return;
    S.open = open;
    root.dataset.open = String(open);
    el.fab.setAttribute('aria-expanded', String(open));
    updateTeaser();
    document.documentElement.classList.toggle('lc-lock', open && isMobile());
    if (open) {
      setTimeout(() => { (S.view === 'chat' ? el.ta : el.form.elements.name).focus({ preventScroll: true }); if (S.view === 'chat') toBottom(); }, 60);
      maybeMarkRead();
      if (S.session && !S.joined) join();
    } else {
      el.emoji.hidden = true; el.emojibtn.setAttribute('aria-pressed', 'false'); el.lightbox.hidden = true;
    }
    renderBadge();
  }
  const updateTeaser = () => { root.dataset.teaser = String(S.enabled && !S.open && !compact && S.teaserReady); };
  el.fab.addEventListener('click', () => setOpen(!S.open));
  el.teaser.addEventListener('click', () => setOpen(true));
  el.close.addEventListener('click', () => { setOpen(false); el.fab.focus(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !S.open) return;
    if (!el.lightbox.hidden) { el.lightbox.click(); return; }
    if (!el.emoji.hidden) { toggleEmoji(); return; }
    setOpen(false); el.fab.focus();
  });
  if (window.visualViewport) {   // keyboard mobile: tinggi panel mengikuti area yang benar-benar terlihat
    const fit = () => root.style.setProperty('--lc-vh', `${window.visualViewport.height}px`);
    window.visualViewport.addEventListener('resize', fit); fit();
  }

  /* ---------- tanda baca ---------- */
  let readT;
  function maybeMarkRead() {
    if (!S.open || S.view !== 'chat' || !S.session || document.visibilityState !== 'visible') return;
    const hasUnread = S.unread > 0 || S.lastSeq > (S.conv?.customerReadSeq || 0);
    if (!hasUnread || !S.stick) return;
    clearTimeout(readT);
    readT = setTimeout(async () => {
      if (!S.session) return;
      const upToSeq = S.lastSeq;
      try { await req(`/conversations/${S.session.id}/read`, { method: 'POST', token: S.session.token, body: { upToSeq } }); if (S.conv) { S.conv.customerReadSeq = Math.max(S.conv.customerReadSeq || 0, upToSeq); } S.unread = 0; renderBadge(); } catch { /* percobaan berikutnya */ }
    }, 350);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { maybeMarkRead(); if (S.session && !S.joined) join(); } });

  /* ---------- realtime (Socket.IO yang sudah ada) ---------- */
  const mine = (p) => S.session && p?.conversationId === S.session.id;
  function join() {
    const s = sock();
    if (!s?.connected || !S.session || S.joined || S.joining) return;
    S.joining = true;
    s.emit('livechat:join', { conversationId: S.session.id, token: S.session.token }, (ack) => {
      S.joining = false;
      if (ack?.ok) { S.joined = true; applySnapshot(ack.snapshot); return; }
      if (ack?.reason === 'expired' || ack?.reason === 'invalid') endSession(S.open ? 'expired' : 'silent');
      else if (ack?.reason === 'disabled') setEnabled(false);
    });
  }
  let wired = false;
  function wire() {
    const s = sock();
    if (!s || wired) return;   // listener didaftarkan SEKALI
    wired = true;
    s.on('livechat:message:new', (p) => {
      if (!mine(p)) return;
      S.conv = { ...S.conv, ...p.conversation };
      upsert({ ...p.message, local: false });
      S.unread = p.message.sender === 'admin' && (!S.open || document.visibilityState !== 'visible') ? (p.conversation.unread || 0) : 0;
      renderHead(); renderBadge(); maybeMarkRead();
    });
    s.on('livechat:read', (p) => { if (mine(p) && p.by === 'admin' && S.conv) { S.conv.adminReadSeq = Math.max(S.conv.adminReadSeq || 0, p.upToSeq); refreshReceipts(); } });
    s.on('livechat:unread', (p) => { if (mine(p)) { S.unread = p.unread || 0; renderBadge(); } });
    s.on('livechat:status', (p) => { if (mine(p) && S.conv) { S.conv.status = p.status; if (p.expiresAt) S.conv.expiresAt = p.expiresAt; renderHead(); renderComposer(); } });
    s.on('livechat:expired', (p) => { if (mine(p)) endSession(S.open ? 'expired' : 'silent'); });
    s.on('livechat:settings', (p) => setEnabled(Boolean(p?.enabled)));
    s.on('connect', () => { S.joined = false; S.joining = false; join(); if (!S.enabled) loadConfig(); });
    s.on('disconnect', () => { S.joined = false; S.joining = false; });
    if (s.connected) join();
  }

  /* Tanpa socket tersambung: polling pelan hanya saat panel terbuka (cadangan, bukan jalur utama) */
  setInterval(() => { if (S.open && S.session && !sock()?.connected) verify(); }, 8000);

  /* ---------- multi-tab: penunjuk sesi dibagi lewat localStorage ---------- */
  addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const p = store.get(KEY);
    if (!p) { if (S.session) endSession(S.open ? 'expired' : 'silent'); return; }
    if (!S.session || S.session.id !== p.id) { S.session = p; S.joined = false; restore(); }
  });

  /* ---------- aktif / nonaktif dari Admin Web ---------- */
  function setEnabled(v) {
    const was = S.enabled;
    S.enabled = v;
    root.hidden = !v;
    if (!v && S.open) setOpen(false);
    updateTeaser();
    if (v && !was && !S.conv) restore();
  }
  let configInflight = null;
  function loadConfig() {
    // Satu request bersama: pemanggilan awal + event 'connect' socket tidak lagi menghasilkan request ganda
    configInflight ||= (async () => {
      try {
        const c = await req('/config');
        if (typeof c.serverTime === 'string') S.skew = Date.parse(c.serverTime) - Date.now();
        setEnabled(Boolean(c.enabled));
      } catch { /* coba lagi saat socket tersambung */ }
    })().finally(() => { configInflight = null; });
    return configInflight;
  }

  /* ---------- pulihkan sesi (refresh / tab baru) ---------- */
  async function restore() {
    const p = store.get(KEY);
    if (!p?.id || !p?.token) { setView('form'); return; }
    S.session = p;
    try {
      applySnapshot(await req(`/conversations/${p.id}`, { token: p.token }));
      join();
    } catch (err) {
      if (err.status === 404 || err.status === 410) { store.del(KEY); S.session = null; setView('form'); } else if (err.code === 'disabled') setEnabled(false);
      else setTimeout(restore, 6000);   // jaringan putus: penunjuk dipertahankan, coba lagi
    }
  }

  /* ---------- mulai ---------- */
  wire();
  // Widget chat bukan konten utama: cek konfigurasinya saat browser senggang (event 'connect' socket juga memicunya bila lebih dulu)
  (window.requestIdleCallback ? (fn) => requestIdleCallback(fn, { timeout: 1200 }) : (fn) => setTimeout(fn, 200))(loadConfig);
  setTimeout(() => { S.teaserReady = true; updateTeaser(); }, 1400);   // satu kemunculan halus setelah halaman tenang
})();
