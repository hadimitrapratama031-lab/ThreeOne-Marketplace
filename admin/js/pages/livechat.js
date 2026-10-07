import { $, $$, html, mount, icon, toast, toastError, busy, dateTime, debounce, emptyState, confirmDialog } from '../ui.js';
import { api } from '../api.js';
import { chatCore } from '../chatCore.js';
import { EMOJI_GROUPS } from '/js/livechat-emoji.js';

/**
 * Live Chat — Admin Web. MongoDB = sumber kebenaran; halaman ini hanya menampilkan dan mengirim lewat API.
 * Realtime datang dari socket admin yang sudah ada (app.js meneruskan event ke onLive). Badge unread, suara, dan toast
 * ditangani chatCore (global), jadi di sini hanya mengurus tampilan daftar dan percakapan terbuka.
 * Pesan di-dedupe dengan kunci clientId (sama dengan kunci idempotensi di server): event ganda / resync tidak menggandakan pesan.
 */
const FILTERS = [['active', 'Aktif'], ['unread', 'Belum dibaca'], ['closed', 'Ditutup'], ['expired', 'Expired']];
const OK_IMG = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMG = 8 * 1024 * 1024;
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0, 32).padEnd(16, '0'));
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const hhmm = (iso) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const STATUS = { active: ['Aktif', 'pill--ok'], closed: ['Ditutup', 'pill--warn'], expired: ['Expired', 'pill--mute'] };

export default {
  async mount(root) {
    let filter = 'active';
    let q = '';
    let page = 1;
    let totalPages = 1;
    let items = [];
    let listLoading = true;
    let listToken = 0;
    let activeId = new URLSearchParams(location.hash.split('?')[1] || '').get('c') || '';
    let conv = null;                // percakapan terbuka (adminView)
    const msgs = new Map();         // key (clientId || id) -> pesan
    const pending = new Map();      // clientId -> { m, text?, file? }
    let skew = 0;
    let pane = activeId ? 'chat' : 'list';
    let infoOpen = false;
    let file = null;
    let filePreview = '';
    let alive = true;
    let loadingConv = false;
    let emojiOpen = false;
    let stick = true;
    const now = () => Date.now() + skew;
    const keyOf = (m) => m.clientId || m.id;

    mount(root, html`
      <div class="page-head"><div><h2>Percakapan</h2><p>Balas pelanggan secara realtime. Percakapan aktif 24 jam sejak dimulai, lalu otomatis hilang dari daftar aktif.</p></div></div>
      <div class="lcx" id="lcx" data-pane="${pane}" data-info="closed">
        <aside class="lcx-list" aria-label="Daftar percakapan">
          <div class="lcx-list__head">
            <label class="lcx-search">${icon('search')}<input id="q" type="search" placeholder="Cari nama, nomor, atau ID" aria-label="Cari percakapan" autocomplete="off"></label>
            <div class="lcx-filters" role="group" aria-label="Filter percakapan">
              ${FILTERS.map(([k, label]) => html`<button type="button" data-filter="${k}" aria-pressed="${k === filter}">${label}${k === 'unread' ? html`<b class="lcx-count" id="unread-count" hidden></b>` : ''}</button>`)}
            </div>
          </div>
          <div class="lcx-items" id="items" role="list"></div>
          <div class="lcx-more" id="more" hidden><button class="btn btn--sm" type="button" id="more-btn">Muat lebih banyak</button></div>
        </aside>

        <section class="lcx-main" id="main" aria-label="Percakapan"></section>
        <aside class="lcx-info" id="info" aria-label="Informasi pelanggan"></aside>
      </div>
      <div class="lcx-lightbox" id="lightbox" hidden><img alt="Gambar diperbesar"></div>`);

    const host = $('#lcx', root);
    const itemsEl = $('#items', root);

    /* =================================================== daftar */
    const shortTime = (iso) => { const d = new Date(iso); return sameDay(d, new Date(now())) ? hhmm(iso) : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }); };
    const previewOf = (c) => (c.lastMessage ? `${c.lastMessage.sender === 'admin' ? 'Anda: ' : ''}${c.lastMessage.type === 'image' ? 'Mengirim gambar' : c.lastMessage.text}` : 'Belum ada pesan');

    function renderList() {
      $('#unread-count', root).hidden = chatCore.unread <= 0;
      $('#unread-count', root).textContent = chatCore.unread > 99 ? '99+' : chatCore.unread;
      $$('[data-filter]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
      if (listLoading && !items.length) { mount(itemsEl, html`${[1, 2, 3, 4, 5].map(() => html`<div class="lcx-item lcx-item--skel"><i></i><span><b></b><em></em></span></div>`)}`); $('#more', root).hidden = true; return; }
      if (!items.length) {
        const text = q ? 'Tidak ada percakapan yang cocok dengan pencarian.' : filter === 'unread' ? 'Semua pesan sudah dibaca.' : filter === 'expired' ? 'Belum ada percakapan yang berakhir.' : filter === 'closed' ? 'Tidak ada percakapan yang ditutup.' : 'Belum ada percakapan aktif. Pelanggan yang membuka Live Chat di Marketplace akan muncul di sini.';
        mount(itemsEl, emptyState(q ? 'Tidak ditemukan' : 'Belum ada percakapan', text, 'chat'));
      } else {
        mount(itemsEl, html`${items.map((c) => html`
          <button type="button" class="lcx-item" role="listitem" data-id="${c.id}" aria-current="${c.id === activeId}">
            <span class="lcx-av" aria-hidden="true">${(c.name || '?')[0].toUpperCase()}</span>
            <span class="lcx-item__body">
              <span class="lcx-item__top"><b>${c.name}</b><time datetime="${c.lastMessageAt}">${shortTime(c.lastMessageAt)}</time></span>
              <span class="lcx-item__bot"><span class="lcx-item__prev ${c.unread ? 'is-unread' : ''}">${previewOf(c)}</span>${c.unread ? html`<b class="lcx-badge" aria-label="${c.unread} belum dibaca">${c.unread > 99 ? '99+' : c.unread}</b>` : c.status === 'closed' ? html`<span class="pill pill--warn lcx-mini">Ditutup</span>` : ''}</span>
            </span>
          </button>`)}`);
      }
      $('#more', root).hidden = page >= totalPages;
    }

    async function loadList({ reset = true } = {}) {
      const token = ++listToken;
      if (reset) { page = 1; }
      listLoading = true;
      if (reset && !items.length) renderList();
      try {
        const res = await api.get('/livechat/conversations', { filter, q, page, limit: 30 });
        if (token !== listToken || !alive) return;
        totalPages = res.totalPages;
        items = reset ? res.items : [...items, ...res.items.filter((n) => !items.some((o) => o.id === n.id))];
        chatCore.setUnread(res.totalUnread);
      } catch (err) { if (token === listToken) toastError(err); }
      listLoading = false;
      if (alive) renderList();
    }
    const matches = (c) => {
      const f = { active: c.status === 'active', unread: c.status !== 'expired' && c.unread > 0, closed: c.status === 'closed', expired: c.status === 'expired' }[filter];
      if (!f) return false;
      if (!q) return true;
      const needle = q.toLowerCase();
      return c.name.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle) || (c.whatsapp || '').includes(needle.replace(/\D/g, '') || '\u0000');
    };
    function applyConvToList(c) {
      const i = items.findIndex((x) => x.id === c.id);
      if (!matches(c)) { if (i >= 0) items.splice(i, 1); }
      else if (i >= 0) items[i] = c;
      else items.push(c);
      items.sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
      renderList();
    }

    /* =================================================== percakapan terbuka */
    const remain = (ms) => {
      if (ms <= 0) return 'Berakhir';
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h} jam ${m} menit` : m > 0 ? `${m} menit` : `${s} detik`;
    };
    const isOpenConv = () => conv && conv.status === 'active' && Date.parse(conv.expiresAt) > now();

    function renderMain() {
      const main = $('#main', root);
      if (!activeId) { mount(main, html`<div class="lcx-blank">${emptyState('Pilih percakapan', 'Pilih pelanggan di daftar untuk melihat dan membalas pesannya.', 'chat')}</div>`); host.dataset.pane = pane; return; }
      if (loadingConv && !conv) { mount(main, html`<div class="lcx-blank"><div class="empty"><b>Memuat percakapan…</b></div></div>`); return; }
      if (!conv) { mount(main, html`<div class="lcx-blank">${emptyState('Percakapan tidak ditemukan', 'Percakapan ini sudah dihapus atau tidak tersedia.', 'chat')}</div>`); return; }
      const [stLabel, stCls] = STATUS[conv.status] || STATUS.active;
      const draft = ta()?.value || '';   // draft balasan tidak hilang saat tampilan dirender ulang
      mount(main, html`
        <header class="lcx-head">
          <button class="icon-btn lcx-back" type="button" id="back" aria-label="Kembali ke daftar">${icon('left')}</button>
          <span class="lcx-av lcx-av--lg" aria-hidden="true">${conv.name[0].toUpperCase()}</span>
          <div class="lcx-head__who"><b>${conv.name}</b><small><span class="pill ${stCls}">${stLabel}</span> <span id="head-remain"></span></small></div>
          <div class="lcx-head__act">
            <button class="icon-btn" type="button" id="sound" aria-label="Suara notifikasi"></button>
            <button class="icon-btn lcx-infobtn" type="button" id="info-btn" aria-label="Informasi pelanggan">${icon('info')}</button>
            ${conv.status === 'active' ? html`<button class="btn btn--sm" type="button" id="close-conv">${icon('lock')}Tutup</button>` : ''}
            ${conv.status === 'closed' ? html`<button class="btn btn--sm btn--primary" type="button" id="reopen-conv">${icon('unlock')}Buka kembali</button>` : ''}
          </div>
        </header>
        <div class="lcx-sw"><div class="lcx-msgs" id="msgs" role="log" aria-live="polite" aria-label="Pesan"></div><button type="button" class="lcx-newpill" id="newpill" hidden>${icon('down')}Pesan baru</button></div>
        <footer class="lcx-dock">
          <div class="lcx-emoji" id="emoji" hidden></div>
          ${isOpenConv() ? html`
            <div class="lcx-preview" id="preview" hidden><img alt="Pratinjau"><div><b id="pname"></b><small id="psub"></small></div><button class="icon-btn" type="button" id="premove" aria-label="Batalkan gambar">${icon('x')}</button></div>
            <div class="lcx-compose">
              <button class="icon-btn" type="button" id="attach" aria-label="Lampirkan gambar">${icon('clip')}</button>
              <textarea id="ta" rows="1" maxlength="1000" placeholder="Tulis balasan" aria-label="Tulis balasan"></textarea>
              <button class="icon-btn" type="button" id="emoji-btn" aria-label="Pilih emoji" aria-pressed="false">${icon('smile')}</button>
              <button class="btn btn--primary lcx-send" type="button" id="send" disabled>${icon('send')}<span>Kirim</span></button>
              <input type="file" id="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
            </div>`
            : html`<div class="lcx-note">${conv.status === 'closed' ? 'Percakapan ditutup. Buka kembali untuk membalas.' : conv.status === 'expired' ? 'Percakapan sudah berakhir (24 jam) dan hanya bisa dibaca. Riwayat dihapus otomatis setelah masa simpan.' : 'Percakapan sudah berakhir.'}</div>`}
        </footer>`);
      renderMsgs();
      renderSound();
      tickRemain();
      bindMain();
      if (draft && ta()) { ta().value = draft; autosize(); syncSend(); }
    }

    /* ---------- pesan ---------- */
    function msgHTML(m) {
      const mine = m.sender === 'admin';
      const read = mine && !m.local && conv && m.seq <= (conv.customerReadSeq || 0);
      return html`
        <div class="lcx-msg lcx-msg--${mine ? 'me' : 'them'} ${m.status === 'sending' ? 'is-sending' : ''} ${m.status === 'failed' ? 'is-failed' : ''}" data-key="${keyOf(m)}" data-seq="${m.seq || ''}" data-at="${m.at}">
          ${m.type === 'image'
            ? html`<div class="lcx-bubble lcx-bubble--img"><img src="${m.image?.url || m.localUrl || ''}" alt="${mine ? 'Gambar yang Anda kirim' : 'Gambar dari pelanggan'}" data-zoom>${m.status === 'sending' ? html`<div class="lcx-up"><div class="lcx-bar"><i style="width:${Math.round((m.progress || 0) * 100)}%"></i></div></div>` : ''}</div>`
            : html`<div class="lcx-bubble">${m.text}</div>`}
          ${m.status === 'failed'
            ? html`<button type="button" class="lcx-retry" data-retry="${keyOf(m)}" title="${m.error || ''}">Gagal terkirim. Coba lagi</button>`
            : html`<div class="lcx-meta">${mine && m.senderName ? html`<span>${m.senderName}</span>` : ''}<time datetime="${m.at}">${hhmm(m.at)}</time>${read ? html`<span class="lcx-read">Dibaca</span>` : ''}</div>`}
        </div>`;
    }
    const dayLabel = (iso) => { const d = new Date(iso); const n = new Date(now()); return sameDay(d, n) ? 'Hari ini' : sameDay(d, new Date(n.getTime() - 86_400_000)) ? 'Kemarin' : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }); };
    const sorted = () => [...msgs.values()].sort((a, b) => (a.local ? 1 : 0) - (b.local ? 1 : 0) || (a.seq || 0) - (b.seq || 0) || Date.parse(a.at) - Date.parse(b.at));
    const msgsEl = () => $('#msgs', root);
    const toBottom = () => { const e = msgsEl(); if (e) { e.scrollTop = e.scrollHeight; stick = true; const p = $('#newpill', root); if (p) p.hidden = true; } };

    function renderMsgs() {
      const e = msgsEl();
      if (!e) return;
      const list = sorted();
      if (!list.length) { mount(e, html`<div class="lcx-empty">Belum ada pesan. Pesan pelanggan akan muncul di sini.</div>`); return; }
      let day = '';
      mount(e, html`${list.map((m) => { const d = dayLabel(m.at); const sep = d !== day ? html`<div class="lcx-day">${d}</div>` : ''; day = d; return html`${sep}${msgHTML(m)}`; })}`);
      toBottom();
    }
    function upsert(m) {
      const key = keyOf(m);
      const prev = msgs.get(key);
      if (prev && !prev.local && m.local) return;
      const next = { ...prev, ...m };
      if (!m.local) { next.local = false; next.status = undefined; }
      msgs.set(key, next);
      const e = msgsEl();
      if (!e) return;
      const old = e.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (old) {
        const maxSeq = Math.max(0, ...[...msgs.values()].map((x) => x.seq || 0));
        if (prev?.local && !next.local && next.seq < maxSeq) { renderMsgs(); return; }
        old.outerHTML = String(msgHTML(next));
        return;
      }
      if (!next.local && next.seq && [...e.querySelectorAll('.lcx-msg')].some((n) => Number(n.dataset.seq) > next.seq)) { renderMsgs(); return; }
      e.querySelector('.lcx-empty')?.remove();
      const last = [...e.querySelectorAll('.lcx-msg')].at(-1);
      if (!last || dayLabel(last.dataset.at) !== dayLabel(next.at)) e.insertAdjacentHTML('beforeend', String(html`<div class="lcx-day">${dayLabel(next.at)}</div>`));
      e.insertAdjacentHTML('beforeend', String(msgHTML(next)));
      if (stick || next.sender === 'admin') toBottom(); else { const p = $('#newpill', root); if (p) p.hidden = false; }
    }
    function refreshReceipts() {
      const e = msgsEl();
      if (!e) return;
      for (const m of msgs.values()) {
        if (m.sender !== 'admin' || m.local) continue;
        const node = e.querySelector(`[data-key="${CSS.escape(keyOf(m))}"]`);
        if (node) node.outerHTML = String(msgHTML(m));
      }
    }

    /* ---------- info pelanggan ---------- */
    function renderInfo() {
      const el = $('#info', root);
      if (!conv) { mount(el, html`<div class="lcx-info__empty">Informasi pelanggan tampil di sini setelah Anda memilih percakapan.</div>`); return; }
      const [stLabel, stCls] = STATUS[conv.status] || STATUS.active;
      const wa = conv.whatsapp;
      mount(el, html`
        <div class="lcx-info__head">
          <span class="lcx-av lcx-av--xl" aria-hidden="true">${conv.name[0].toUpperCase()}</span>
          <b>${conv.name}</b>
          <span class="pill ${stCls}">${stLabel}</span>
          <button class="icon-btn lcx-infoclose" type="button" id="info-close" aria-label="Tutup informasi">${icon('x')}</button>
        </div>
        <dl class="lcx-dl">
          <div><dt>WhatsApp</dt><dd>${wa ? html`<a href="https://wa.me/${wa}" target="_blank" rel="noopener">${conv.whatsappFormatted || '+' + wa}</a>` : html`<span class="faint">Tidak diisi pelanggan</span>`}</dd></div>
          <div><dt>Conversation ID</dt><dd><span class="lcx-id">${conv.id}</span><button class="icon-btn" type="button" id="copy-id" aria-label="Salin ID">${icon('copy')}</button></dd></div>
          <div><dt>Dibuat</dt><dd>${dateTime(conv.createdAt)}</dd></div>
          <div><dt>${conv.status === 'expired' ? 'Berakhir pada' : 'Berakhir otomatis'}</dt><dd>${dateTime(conv.expiresAt)}</dd></div>
          ${conv.status !== 'expired' ? html`<div><dt>Sisa waktu aktif</dt><dd><span id="info-remain"></span><span class="lcx-life" aria-hidden="true"><i id="info-life"></i></span></dd></div>` : ''}
          <div><dt>Jumlah pesan</dt><dd>${conv.messageCount}</dd></div>
        </dl>
        ${conv.status === 'expired' ? html`<p class="lcx-info__note">Riwayat percakapan ini dihapus otomatis ${conv.retentionDays === 0 ? 'segera setelah berakhir' : `${conv.retentionDays} hari setelah berakhir`}.</p>` : ''}`);
      tickRemain();
    }
    function tickRemain() {
      if (!conv) return;
      const left = Date.parse(conv.expiresAt) - now();
      const a = $('#head-remain', root);
      if (a) a.textContent = conv.status === 'expired' ? '' : conv.status === 'closed' ? `Sisa ${remain(left)}` : `Sisa ${remain(left)}`;
      const b = $('#info-remain', root);
      if (b) b.textContent = remain(left);
      const l = $('#info-life', root);
      if (l) l.style.transform = `scaleX(${Math.max(0, Math.min(1, left / (Date.parse(conv.expiresAt) - Date.parse(conv.createdAt))))})`;
    }
    const timer = setInterval(tickRemain, 15_000);

    function renderSound() {
      const b = $('#sound', root);
      if (!b) return;
      b.innerHTML = String(icon(chatCore.soundOn ? 'volume' : 'mute'));
      b.title = chatCore.soundOn ? (chatCore.unlocked ? 'Suara notifikasi aktif' : 'Suara aktif. Klik di mana saja untuk mengaktifkannya di browser ini') : 'Suara notifikasi mati';
      b.setAttribute('aria-pressed', String(chatCore.soundOn));
    }
    const unsub = chatCore.subscribe(() => { if (!alive) return; renderSound(); const c = $('#unread-count', root); if (c) { c.hidden = chatCore.unread <= 0; c.textContent = chatCore.unread > 99 ? '99+' : chatCore.unread; } });

    /* ---------- buka percakapan ---------- */
    async function openConv(id, { fromEvent = false } = {}) {
      activeId = id;
      pane = 'chat';
      host.dataset.pane = pane;
      chatCore.setViewing(id);
      try { history.replaceState(null, '', `#/livechat?c=${encodeURIComponent(id)}`); } catch { /* abaikan */ }
      renderList();
      if (!fromEvent) { conv = null; msgs.clear(); pending.clear(); clearFile(); loadingConv = true; renderMain(); renderInfo(); }
      try {
        const snap = await api.get(`/livechat/conversations/${encodeURIComponent(id)}`);
        if (!alive || activeId !== id) return;
        skew = Date.parse(snap.serverTime) - Date.now();
        conv = snap.conversation;
        for (const m of snap.messages) upsertQuiet(m);
        for (const [k] of pending) if (msgs.get(k) && !msgs.get(k).local) pending.delete(k);
        loadingConv = false;
        renderMain(); renderInfo();
        markRead();
      } catch (err) {
        if (!alive || activeId !== id) return;
        loadingConv = false; conv = null;
        renderMain(); renderInfo();
        if (err.status !== 404) toastError(err);
      }
    }
    function upsertQuiet(m) { const key = keyOf(m); const prev = msgs.get(key); msgs.set(key, { ...prev, ...m, local: false, status: undefined }); }

    let readT;
    function markRead() {
      if (!conv || conv.status === 'expired' || document.visibilityState !== 'visible') return;
      const seq = Math.max(0, ...[...msgs.values()].filter((m) => !m.local).map((m) => m.seq || 0));
      if (!seq || (conv.unread === 0 && seq <= (conv.adminReadSeq || 0))) return;
      clearTimeout(readT);
      readT = setTimeout(async () => {
        const id = activeId;
        try { await api.post(`/livechat/conversations/${encodeURIComponent(id)}/read`, { upToSeq: seq }); if (conv?.id === id) { conv.unread = 0; conv.adminReadSeq = seq; const it = items.find((x) => x.id === id); if (it) { it.unread = 0; renderList(); } } } catch { /* percobaan berikutnya */ }
      }, 300);
    }
    const onVis = () => { if (document.visibilityState === 'visible') markRead(); };
    document.addEventListener('visibilitychange', onVis);

    /* ---------- kirim ---------- */
    const ta = () => $('#ta', root);
    function syncSend() { const s = $('#send', root); if (s) s.disabled = !(ta()?.value.trim() || file); }
    function autosize() { const t = ta(); if (t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 140)}px`; } }
    function clearFile() { if (filePreview) URL.revokeObjectURL(filePreview); file = null; filePreview = ''; const p = $('#preview', root); if (p) p.hidden = true; const f = $('#file', root); if (f) f.value = ''; }
    const newLocal = (extra) => ({ id: `local:${uid()}`, clientId: uid(), sender: 'admin', at: new Date(now()).toISOString(), local: true, status: 'sending', progress: 0, ...extra });

    function submit() {
      if (!isOpenConv()) return;
      const text = ta().value.trim();
      const f = file;
      if (!text && !f) return;
      if (text) { const m = newLocal({ type: 'text', text }); pending.set(m.clientId, { m, text }); upsert(m); deliver(m.clientId); }
      if (f) { const m = newLocal({ type: 'image', localUrl: filePreview }); pending.set(m.clientId, { m, file: f }); filePreview = ''; upsert(m); deliver(m.clientId); }
      ta().value = ''; autosize(); clearFile(); syncSend(); toBottom();
    }
    function xhrUpload(url, form, onProgress) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', url); x.withCredentials = true; x.timeout = 90_000;
        x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch { /* bukan JSON */ } if (x.status >= 200 && x.status < 300) resolve(d); else reject(Object.assign(new Error(d.error?.message || 'Gagal mengirim gambar.'), { status: x.status, code: d.error?.details?.code })); };
        x.onerror = () => reject(Object.assign(new Error('Koneksi terputus saat mengirim gambar.'), { status: 0 }));
        x.ontimeout = () => reject(Object.assign(new Error('Pengiriman gambar terlalu lama.'), { status: 0 }));
        x.send(form);
      });
    }
    async function deliver(key) {
      const rec = pending.get(key);
      if (!rec || !conv) return;
      const id = conv.id;
      const cur0 = msgs.get(key);
      if (cur0?.status === 'failed') upsert({ ...cur0, status: 'sending', progress: 0 });
      try {
        let data;
        if (rec.file) {
          const fd = new FormData();
          fd.append('clientId', rec.m.clientId); fd.append('type', 'image'); fd.append('image', rec.file, rec.file.name);
          data = await xhrUpload(`/api/admin/livechat/conversations/${encodeURIComponent(id)}/messages`, fd, (p) => {
            const m = msgs.get(key); if (m) m.progress = p;
            const bar = msgsEl()?.querySelector(`[data-key="${CSS.escape(key)}"] .lcx-bar i`); if (bar) bar.style.width = `${Math.round(p * 100)}%`;
          });
        } else {
          data = await api.post(`/livechat/conversations/${encodeURIComponent(id)}/messages`, { clientId: rec.m.clientId, type: 'text', text: rec.text });
        }
        pending.delete(key);
        const c = msgs.get(key);
        if (c?.localUrl) URL.revokeObjectURL(c.localUrl);
        if (conv?.id === id) { upsert({ ...data.message, local: false, localUrl: undefined }); conv = { ...conv, ...data.conversation }; applyConvToList(conv); }
      } catch (err) {
        if (err.status === 410 || err.code === 'closed') {   // sudah expired / ditutup di server: sinkronkan tampilan
          pending.delete(key); msgs.delete(key);
          toast(err.message, { type: 'error' });
          openConv(id, { fromEvent: true });
          return;
        }
        const m = msgs.get(key) || rec.m;
        upsert({ ...m, status: 'failed', error: err.message });
      }
    }

    function buildEmoji() {
      const box = $('#emoji', root);
      if (!box || box.dataset.built) return;
      box.dataset.built = '1';
      const show = (g) => {
        $$('.lcx-emoji__tabs button', box).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === g.id)));
        mount($('.lcx-emoji__grid', box), html`${g.items.map((ch) => html`<button type="button" data-emoji="${ch}" aria-label="${ch}">${ch}</button>`)}`);
      };
      mount(box, html`<div class="lcx-emoji__tabs" role="tablist">${EMOJI_GROUPS.map((g) => html`<button type="button" role="tab" data-id="${g.id}" aria-label="${g.label}">${g.icon}</button>`)}</div><div class="lcx-emoji__grid"></div>`);
      box.addEventListener('click', (e) => {
        const t = e.target.closest('.lcx-emoji__tabs button');
        if (t) return show(EMOJI_GROUPS.find((g) => g.id === t.dataset.id));
        const b = e.target.closest('[data-emoji]');
        if (b) { const t2 = ta(); if (t2.value.length + b.dataset.emoji.length > 1000) return; t2.setRangeText(b.dataset.emoji, t2.selectionStart, t2.selectionEnd, 'end'); t2.dispatchEvent(new Event('input')); t2.focus(); }
      });
      show(EMOJI_GROUPS[0]);
    }
    function toggleEmoji(force) {
      const box = $('#emoji', root);
      if (!box) return;
      emojiOpen = force ?? !emojiOpen;
      if (emojiOpen) buildEmoji();
      box.hidden = !emojiOpen;
      $('#emoji-btn', root)?.setAttribute('aria-pressed', String(emojiOpen));
    }

    function bindMain() {
      const t = ta();
      t?.addEventListener('input', () => { autosize(); syncSend(); });
      t?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
      msgsEl()?.addEventListener('scroll', () => { const e = msgsEl(); stick = e.scrollHeight - e.scrollTop - e.clientHeight < 90; if (stick) { const p = $('#newpill', root); if (p) p.hidden = true; markRead(); } }, { passive: true });
      if (t && !matchMedia('(pointer: coarse)').matches) t.focus({ preventScroll: true });
    }

    /* =================================================== event DOM (didaftarkan SEKALI pada root; root dibuang saat pindah halaman) */
    root.addEventListener('click', async (e) => {
      const item = e.target.closest('.lcx-item[data-id]');
      if (item) return openConv(item.dataset.id);
      const fl = e.target.closest('[data-filter]');
      if (fl) { filter = fl.dataset.filter; items = []; listLoading = true; renderList(); return loadList(); }
      if (e.target.closest('#more-btn')) { page += 1; return loadList({ reset: false }); }
      if (e.target.closest('#back')) { pane = 'list'; host.dataset.pane = pane; chatCore.setViewing(null); return; }
      if (e.target.closest('#info-btn')) { infoOpen = true; host.dataset.info = 'open'; return; }
      if (e.target.closest('#info-close')) { infoOpen = false; host.dataset.info = 'closed'; return; }
      if (e.target.closest('#sound')) { chatCore.setSound(!chatCore.soundOn); return; }
      if (e.target.closest('#attach')) return $('#file', root).click();
      if (e.target.closest('#premove')) { clearFile(); syncSend(); return; }
      if (e.target.closest('#send')) return submit();
      if (e.target.closest('#emoji-btn')) return toggleEmoji();
      if (e.target.closest('#newpill')) return toBottom();
      const retry = e.target.closest('[data-retry]');
      if (retry) return deliver(retry.dataset.retry);
      const zoom = e.target.closest('[data-zoom]');
      if (zoom) { const lb = $('#lightbox', root); $('img', lb).src = zoom.src; lb.hidden = false; return; }
      if (e.target.closest('#lightbox')) { $('#lightbox', root).hidden = true; return; }
      if (e.target.closest('#copy-id')) { try { await navigator.clipboard.writeText(conv.id); toast('Conversation ID disalin'); } catch { toast('Salin manual dari kolom ID', { type: 'error' }); } return; }
      const closeBtn = e.target.closest('#close-conv');
      if (closeBtn) {
        const ok = await confirmDialog({ title: 'Tutup percakapan?', message: 'Pelanggan tidak bisa mengirim pesan lagi. Anda bisa membukanya kembali selama belum melewati 24 jam.', confirmLabel: 'Tutup percakapan' });
        if (!ok) return;
        try { const r = await busy(closeBtn, () => api.post(`/livechat/conversations/${encodeURIComponent(conv.id)}/close`)); conv = { ...conv, ...r.conversation }; applyConvToList(conv); renderMain(); renderInfo(); toast('Percakapan ditutup'); } catch (err) { toastError(err); if (err.status === 410) openConv(conv.id, { fromEvent: true }); }
        return;
      }
      const reopenBtn = e.target.closest('#reopen-conv');
      if (reopenBtn) {
        try { const r = await busy(reopenBtn, () => api.post(`/livechat/conversations/${encodeURIComponent(conv.id)}/reopen`)); conv = { ...conv, ...r.conversation }; applyConvToList(conv); renderMain(); renderInfo(); toast('Percakapan dibuka kembali'); } catch (err) { toastError(err); if (err.status === 410) openConv(conv.id, { fromEvent: true }); }
      }
    });
    root.addEventListener('change', (e) => {
      if (e.target.id !== 'file') return;
      const f = e.target.files?.[0];
      if (!f) return;
      if (!OK_IMG.includes(f.type)) { toast('Format tidak didukung. Gunakan JPG, PNG, WebP, atau GIF.', { type: 'error' }); e.target.value = ''; return; }
      if (f.size > MAX_IMG) { toast(`Ukuran gambar terlalu besar (maksimal ${kb(MAX_IMG)}).`, { type: 'error' }); e.target.value = ''; return; }
      clearFile();
      file = f; filePreview = URL.createObjectURL(f);
      const p = $('#preview', root);
      $('img', p).src = filePreview; $('#pname', p).textContent = f.name; $('#psub', p).textContent = `${kb(f.size)}, siap dikirim`;
      p.hidden = false;
      syncSend();
    });
    const onKey = (e) => { if (e.key !== 'Escape') return; const lb = $('#lightbox', root); if (lb && !lb.hidden) lb.hidden = true; else if (emojiOpen) toggleEmoji(false); };
    document.addEventListener('keydown', onKey);
    const search = debounce(() => { q = $('#q', root).value.trim(); items = []; listLoading = true; renderList(); loadList(); }, 300);
    $('#q', root).addEventListener('input', search);

    /* =================================================== mulai */
    renderList(); renderMain(); renderInfo();
    loadList();
    if (activeId) openConv(activeId);

    return {
      destroy() {
        alive = false;
        clearInterval(timer); clearTimeout(readT); search.cancel?.();
        unsub(); chatCore.setViewing(null);
        document.removeEventListener('visibilitychange', onVis);
        document.removeEventListener('keydown', onKey);
        if (filePreview) URL.revokeObjectURL(filePreview);
        for (const m of msgs.values()) if (m.localUrl) URL.revokeObjectURL(m.localUrl);
      },

      onLive(evt, p) {
        if (!alive) return;
        if (evt === 'resync') { loadList(); if (activeId) openConv(activeId, { fromEvent: true }); return; }
        if (evt === 'livechat:conversation:created') { applyConvToList(p.conversation); return; }
        if (evt === 'livechat:message:new') {
          applyConvToList(p.conversation);
          if (p.conversationId === activeId) {
            conv = { ...conv, ...p.conversation };
            upsert({ ...p.message, local: false });
            renderInfo();
            if (p.message.sender === 'customer') markRead();
          }
          return;
        }
        if (evt === 'livechat:unread') {
          const it = items.find((x) => x.id === p.conversationId);
          if (it) { it.unread = p.unreadAdmin; if (filter === 'unread' && !p.unreadAdmin) items.splice(items.indexOf(it), 1); renderList(); }
          return;
        }
        if (evt === 'livechat:conversation:updated') {
          applyConvToList(p.conversation);
          if (p.conversation.id === activeId) { conv = { ...conv, ...p.conversation }; renderMain(); renderInfo(); }
          return;
        }
        if (evt === 'livechat:conversation:expired') {
          applyConvToList(p.conversation);   // hilang dari daftar aktif; muncul hanya di filter Expired
          if (p.conversationId === activeId) { conv = { ...conv, ...p.conversation }; clearFile(); renderMain(); renderInfo(); toast('Percakapan berakhir', { detail: `${p.conversation.name} — batas 24 jam tercapai.` }); }
          return;
        }
        if (evt === 'livechat:read' && p.by === 'customer' && p.conversationId === activeId && conv) { conv.customerReadSeq = Math.max(conv.customerReadSeq || 0, p.upToSeq); refreshReceipts(); }
      },
    };
  },
};
