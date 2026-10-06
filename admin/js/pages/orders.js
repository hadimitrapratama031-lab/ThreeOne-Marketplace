import { $, html, mount, icon, rp, dateTime, pagerHTML, emptyState, skeletonRows, debounce, toastError, dialog } from '../ui.js';
import { api } from '../api.js';

const STATUS = { PENDING: ['Menunggu bayar', 'pill--warn'], SUCCESS: ['Berhasil', 'pill--ok'], EXPIRED: ['Kedaluwarsa', 'pill--mute'], FAILED: ['Gagal dibuat', 'pill--danger'] };
const pill = (s) => html`<span class="pill ${(STATUS[s] || ['', ''])[1]}">${(STATUS[s] || [s])[0]}</span>`;

/** Daftar pesanan; berubah realtime lewat event order:update (Socket.IO admin). */
export default {
  async mount(root) {
    const q = { page: 1, limit: 25, q: '', status: '' };
    let alive = true; let reqId = 0;
    mount(root, html`
      <div class="page-head"><div><h2>Pesanan</h2><p>Semua checkout dan status pembayarannya. Status dikelola backend dari KlikQRIS.</p></div></div>
      <section class="card">
        <div class="toolbar">
          <label class="search"><span class="sr-only">Cari pesanan</span>${icon('search')}<input id="f-q" type="search" placeholder="Order ID, nama, email, WhatsApp" autocomplete="off"></label>
          <select id="f-status" aria-label="Filter status"><option value="">Semua status</option>${Object.entries(STATUS).map(([k, v]) => html`<option value="${k}">${v[0]}</option>`)}</select>
        </div>
        <div class="table-wrap" id="table">${skeletonRows(7)}</div><div id="pager"></div>
      </section>`);

    async function load() {
      const id = ++reqId;
      try {
        const res = await api.get('/orders', q);
        if (!alive || id !== reqId) return;
        if (!res.items.length && q.page > 1) { q.page = res.totalPages; return load(); }
        $('#table', root).innerHTML = (res.items.length ? html`
          <table><thead><tr><th>Order ID</th><th>Pembeli</th><th>Produk</th><th class="num">Total</th><th>Status</th><th>Dibuat</th><th></th></tr></thead>
          <tbody>${res.items.map((o) => html`<tr>
            <td><b>${o.orderNo}</b>${o.mode === 'sandbox' ? html`<br><small class="faint">Sandbox</small>` : ''}</td>
            <td>${o.customer.name}<br><small class="faint">${o.customer.email} · +${o.customer.whatsapp}</small></td>
            <td>${o.product.name}${o.product.kind === 'code' ? html`<br><small class="faint">Sistem Code${o.codeState === 'assigned' ? ' · code diberikan' : ''}</small>` : ''}</td>
            <td class="num">${rp(o.totalAmount ?? o.amount)}</td>
            <td>${pill(o.status)}${o.latePayment ? html`<br><small class="faint">Dibayar terlambat</small>` : ''}${o.codeState === 'waiting' ? html`<br><small class="faint">Menunggu code (stok habis)</small>` : o.stockNote === 'short' ? html`<br><small class="faint">Stok habis saat dibayar</small>` : ''}</td>
            <td class="muted">${dateTime(o.createdAt)}</td>
            <td><div class="row-actions"><button class="btn btn--sm" type="button" data-open="${o.id}">Detail</button></div></td>
          </tr>`)}</tbody></table>` : emptyState(q.q || q.status ? 'Tidak ada pesanan yang cocok' : 'Belum ada pesanan', q.q || q.status ? 'Ubah kata kunci atau filter.' : 'Pesanan muncul di sini begitu pelanggan checkout.', 'receipt')).s;
        $('#pager', root).innerHTML = pagerHTML(res).s;
        root.__items = new Map(res.items.map((o) => [o.id, o]));
      } catch (err) { if (alive) toastError(err, 'Pesanan gagal dimuat'); }
    }
    const loadSoon = debounce(load, 250);
    $('#f-q', root).addEventListener('input', (e) => { q.q = e.target.value.trim(); q.page = 1; loadSoon(); });
    $('#f-status', root).addEventListener('change', (e) => { q.status = e.target.value; q.page = 1; load(); });
    root.addEventListener('click', (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { q.page = +pg.dataset.page; return load(); }
      const open = e.target.closest('[data-open]');
      const o = open && root.__items.get(open.dataset.open);
      if (!o) return;
      dialog({ title: `Pesanan ${o.orderNo}`, body: html`
        <dl class="stack" style="margin:0">
          <div>${pill(o.status)} <span class="muted">KlikQRIS: ${o.gatewayStatus || '—'}${o.source ? ` · via ${o.source}` : ''}</span></div>
          <div><b>${o.customer.name}</b><br>${o.customer.email}<br>+${o.customer.whatsapp}</div>
          <div>${o.product.name} · ${rp(o.amount)} → total ${rp(o.totalAmount ?? o.amount)}</div>
          <div class="muted">Dibayar: ${dateTime(o.paidAt)} · Batas: ${dateTime(o.expiresAt)} · Webhook diterima: ${o.webhookCount}×</div>
          ${o.failureReason ? html`<p class="form-error">${o.failureReason}</p>` : ''}
          ${o.reportUrl ? html`<a href="${o.reportUrl}" target="_blank" rel="noopener">Laporan KlikQRIS ${icon('external')}</a>` : ''}
          <ul class="timeline">${[...o.events].reverse().map((ev) => html`<li><time>${dateTime(ev.at)}</time><span>${ev.type}${ev.detail ? ` — ${ev.detail}` : ''}</span></li>`)}</ul>
        </dl>`, foot: html`<button type="button" class="btn" data-close>Tutup</button>` });
    });
    await load();
    return { destroy() { alive = false; loadSoon.cancel(); }, onLive(evt) { if (evt === 'order:update' || evt === 'resync') loadSoon(); } };
  },
};
