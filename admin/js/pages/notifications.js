import { $, html, mount, icon, dateTime, pagerHTML, emptyState, skeletonRows, debounce, toast, toastError, busy } from '../ui.js';
import { api } from '../api.js';

const EVENT = { orderCreated: 'Pesanan dibuat', paymentSuccess: 'Pembayaran berhasil', paymentFailed: 'Pembayaran gagal', paymentExpired: 'Pembayaran kedaluwarsa' };
const CHANNEL = { whatsapp: 'WhatsApp', email: 'Email' };
const STATUS = { sent: ['Terkirim', 'pill--ok'], failed: ['Gagal', 'pill--danger'], sending: ['Mengirim', 'pill--warn'], pending: ['Antre', 'pill--mute'] };
const DELIVERY = { delivered: ['Sampai di inbox', 'pill--ok'], bounced: ['Memantul', 'pill--danger'], complained: ['Ditandai spam', 'pill--danger'], delayed: ['Tertunda', 'pill--warn'] };

/** Log pengiriman WhatsApp & Email. Baris diperbarui realtime lewat event notification:log (Socket.IO admin yang sudah ada). */
export default {
  async mount(root) {
    const q = { page: 1, limit: 25, orderNo: '', event: '', channel: '', status: '' };
    let alive = true; let reqId = 0; let rows = new Map();

    const opts = (map) => Object.entries(map).map(([k, v]) => html`<option value="${k}">${Array.isArray(v) ? v[0] : v}</option>`);
    mount(root, html`
      <div class="page-head"><div><h2>Log Notifikasi</h2><p>Riwayat WhatsApp (Fonnte) dan Email (Resend) per pesanan. Satu kejadian hanya dikirim sekali per kanal.</p></div></div>
      <section class="card">
        <div class="toolbar">
          <label class="search"><span class="sr-only">Cari Order ID</span>${icon('search')}<input id="f-q" type="search" placeholder="Order ID (mis. MP-261005-…)" autocomplete="off"></label>
          <select id="f-event" aria-label="Kejadian"><option value="">Semua kejadian</option>${opts(EVENT)}</select>
          <select id="f-channel" aria-label="Kanal"><option value="">Semua kanal</option>${opts(CHANNEL)}</select>
          <select id="f-status" aria-label="Status"><option value="">Semua status</option>${opts(STATUS)}</select>
        </div>
        <div class="table-wrap" id="table">${skeletonRows(7)}</div><div id="pager"></div>
      </section>`);

    const rowHTML = (l) => html`<tr data-id="${l.id}">
      <td><b>${l.orderCode}</b></td>
      <td>${EVENT[l.event] || l.event}</td>
      <td>${CHANNEL[l.channel] || l.channel}<br><small class="faint">${l.recipient || '—'}</small></td>
      <td><span class="pill ${(STATUS[l.status] || [, 'pill--mute'])[1]}">${(STATUS[l.status] || [l.status])[0]}</span>
        ${l.channel === 'email' && l.status === 'sent' && DELIVERY[l.deliveryStatus] ? html`<br><span class="pill ${DELIVERY[l.deliveryStatus][1]}">${DELIVERY[l.deliveryStatus][0]}</span>` : ''}
        ${l.error ? html`<br><small class="faint">${l.error}</small>` : ''}</td>
      <td class="num">${l.attempts}</td>
      <td class="muted">${dateTime(l.sentAt || l.failedAt || l.createdAt)}</td>
      <td>${l.status === 'failed' ? html`<div class="row-actions"><button class="btn btn--sm" type="button" data-retry="${l.id}">Kirim ulang</button></div>` : ''}</td>
    </tr>`;

    async function load() {
      const id = ++reqId;
      try {
        const res = await api.get('/notifications', q);
        if (!alive || id !== reqId) return;
        if (!res.items.length && q.page > 1) { q.page = res.totalPages; return load(); }
        rows = new Map(res.items.map((l) => [l.id, l]));
        $('#table', root).innerHTML = (res.items.length ? html`<table><thead><tr><th>Order ID</th><th>Kejadian</th><th>Tujuan</th><th>Status</th><th class="num">Percobaan</th><th>Waktu</th><th></th></tr></thead><tbody id="rows">${res.items.map(rowHTML)}</tbody></table>`
          : emptyState('Belum ada notifikasi', q.orderNo || q.event || q.channel || q.status ? 'Tidak ada log yang cocok dengan filter.' : 'Log muncul begitu pesanan pertama dibuat.', 'bell')).s;
        $('#pager', root).innerHTML = pagerHTML(res).s;
      } catch (err) { if (alive) toastError(err, 'Log gagal dimuat'); }
    }
    const loadSoon = debounce(load, 250);
    $('#f-q', root).addEventListener('input', (e) => { q.orderNo = e.target.value.trim(); q.page = 1; loadSoon(); });
    for (const [id, key] of [['#f-event', 'event'], ['#f-channel', 'channel'], ['#f-status', 'status']]) $(id, root).addEventListener('change', (e) => { q[key] = e.target.value; q.page = 1; load(); });

    root.addEventListener('click', async (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { q.page = +pg.dataset.page; return load(); }
      const retry = e.target.closest('[data-retry]');
      if (!retry) return;
      try {
        const r = await busy(retry, () => api.post(`/notifications/${retry.dataset.retry}/retry`));
        toast(r.message);
      } catch (err) { toastError(err); }
    });

    await load();
    return {
      destroy() { alive = false; loadSoon.cancel(); },
      onLive(evt, l) {
        if (!alive) return;
        if (evt === 'resync') return loadSoon();
        if (evt !== 'notification:log') return;
        const tr = $(`tr[data-id="${l.id}"]`, root);
        const matches = (!q.orderNo || l.orderCode === q.orderNo.toUpperCase()) && (!q.event || l.event === q.event) && (!q.channel || l.channel === q.channel) && (!q.status || l.status === q.status);
        if (tr) { rows.set(l.id, l); tr.outerHTML = rowHTML(l).s; }   // baris yang sudah ada: perbarui di tempat (tanpa duplikat)
        else if (q.page === 1 && matches) loadSoon();
      },
    };
  },
};
