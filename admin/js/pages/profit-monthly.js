import { $, html, mount, icon, num, rp, pagerHTML, emptyState, debounce, toast, toastError, dialog, busy } from '../ui.js';
import { api } from '../api.js';

/**
 * Keuntungan Per Bulan. Semua angka dari MongoDB lewat /api/admin/reports/monthly (order production yang pembayarannya berhasil).
 * Pemisahan Production/Sandbox dan status bayar dilakukan di query backend, bukan di sini.
 * Product belum punya modal/HPP, jadi yang ditampilkan adalah PENDAPATAN; tidak ada angka keuntungan yang dikarang.
 * Realtime lewat Socket.IO admin yang sudah ada: order:update (production) dan report:update (rekap dihapus admin lain).
 */
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const monthLabel = (ym) => `${MONTHS[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
const monthShort = (ym) => MONTHS[+ym.slice(5) - 1].slice(0, 3);
const nextYm = (ym) => { const y = +ym.slice(0, 4); const m = +ym.slice(5); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const nowYm = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);   // bulan berjalan menurut WIB, sama dengan backend
const wib = (iso) => `${new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} WIB`;
const compact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
const dec1 = (n) => Number(n).toLocaleString('id-ID', { maximumFractionDigits: 1 });
const CHART_MONTHS = 24;

const FILTERS = { year: '', month: '', from: '', to: '', productId: '', category: '', payment: '' };
const PAYMENT = [['', 'Semua yang berhasil'], ['ontime', 'Dibayar tepat waktu'], ['late', 'Dibayar terlambat']];

/* ---------- Grafik (HTML/CSS murni: CSP hanya mengizinkan script 'self') ---------- */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Deret bulan berurutan (naik) tanpa lubang: bulan tanpa transaksi tampil sebagai 0. Tahun dipilih = Januari sampai bulan berjalan / Desember. */
function seriesOf(months, q) {
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const asc = [...months].reverse();
  let first = asc[0]?.month;
  let last = asc.at(-1)?.month;
  if (q.year && !q.month && !q.from && !q.to) {
    first = `${q.year}-01`;
    last = String(q.year) === nowYm().slice(0, 4) ? nowYm() : `${q.year}-12`;
  }
  if (!first) return [];
  const out = [];
  for (let ym = first; ym <= last && out.length < 240; ym = nextYm(ym)) out.push(byMonth.get(ym) ?? { month: ym, orders: 0, revenue: 0 });
  return out;
}

function barChart(series, key, fmt, title) {
  const max = niceMax(Math.max(...series.map((s) => s[key])));
  const cur = nowYm();
  const sparse = series.length > 12;
  return html`
    <div class="pm-chart" role="img" aria-label="${title}, ${monthLabel(series[0].month)} sampai ${monthLabel(series.at(-1).month)}. Data lengkap ada di tabel rekap per bulan.">
      <div class="pm-axis" aria-hidden="true">${[max, max / 2, 0].map((t) => html`<span>${key === 'revenue' ? compact.format(t) : dec1(t)}</span>`)}</div>
      <div class="pm-plot" aria-hidden="true">
        <i class="pm-grid" style="top:0"></i><i class="pm-grid" style="top:50%"></i><i class="pm-grid" style="top:100%"></i>
        <div class="pm-cols">${series.map((s) => html`<div class="pm-col${s.month === cur ? ' is-current' : ''}" title="${monthLabel(s.month)}: ${fmt(s[key])}"><i style="height:${s[key] ? `max(3px, ${(s[key] / max) * 100}%)` : '0'}"></i></div>`)}</div>
      </div>
      <div class="pm-labels" aria-hidden="true">${series.map((s, i) => html`<span>${!sparse || i % 2 === 0 ? monthShort(s.month) : ''}</span>`)}</div>
    </div>`;
}

const chartCard = (title, sub, body) => html`<article class="card"><div class="card__head"><h3>${title}</h3><small>${sub}</small></div><div class="card__body">${body}</div></article>`;

/* ---------- Bagian halaman ---------- */
function heroHTML(summary, scoped) {
  const { current: c, previous: p, comparable, change } = summary;
  const prev = monthLabel(p.month);
  let chip;
  if (!comparable) chip = html`<span class="pm-chip">Belum ada pembanding</span>`;
  else if (change.revenue > 0) chip = html`<span class="pm-chip pm-chip--up">${icon('up')}${dec1(change.revenue)}% dari ${prev}</span>`;
  else if (change.revenue < 0) chip = html`<span class="pm-chip pm-chip--down">${icon('down')}${dec1(Math.abs(change.revenue))}% dari ${prev}</span>`;
  else chip = html`<span class="pm-chip">Sama seperti ${prev}</span>`;
  const vs = (txt) => (comparable ? html`<small>${prev}: ${txt}</small>` : '');

  return html`
    <div class="pm-hero__top">
      <div class="pm-hero__label"><b>${monthLabel(c.month)}</b><span>Pendapatan bulan berjalan${scoped ? ', sesuai filter produk, kategori, dan status bayar' : ''}</span></div>
      <div class="pm-compare">${chip}<small>${comparable ? `${prev}: ${rp(p.revenue)}` : `Tidak ada transaksi production di ${prev}`}</small></div>
    </div>
    <div class="pm-hero__num">${rp(c.revenue)}</div>
    <div class="pm-stats">
      <div class="pm-stat"><span>Transaksi berhasil</span><b>${num(c.orders)}</b>${vs(num(p.orders))}</div>
      <div class="pm-stat"><span>Produk terjual</span><b>${num(c.items)}</b>${vs(num(p.items))}</div>
      <div class="pm-stat"><span>Rata-rata per transaksi</span><b>${rp(c.average)}</b>${vs(rp(p.average))}</div>
    </div>
    <p class="pm-note">${icon('info')}<span>Keuntungan belum bisa dihitung karena modal (HPP) produk belum tercatat di sistem, jadi halaman ini menampilkan pendapatan. Angkanya dari pembayaran production yang berhasil, sebesar nominal yang benar-benar dibayar pelanggan (termasuk kode unik QRIS bila ada).</span></p>`;
}

function chartsHTML(d, q) {
  const all = d.months.length ? seriesOf(d.months, q) : [];
  if (!all.length) {
    const none = emptyState('Belum ada data', 'Grafik muncul setelah ada pembayaran production yang berhasil.', 'trend');
    return html`${chartCard('Pendapatan per bulan', '', none)}${chartCard('Transaksi per bulan', '', none)}`;
  }
  const series = all.slice(-CHART_MONTHS);
  const sub = `${monthLabel(series[0].month)} sampai ${monthLabel(series.at(-1).month)}${all.length > CHART_MONTHS ? `, ${CHART_MONTHS} bulan terakhir` : ''}`;
  return html`
    ${chartCard('Pendapatan per bulan', sub, barChart(series, 'revenue', rp, 'Pendapatan per bulan'))}
    ${chartCard('Transaksi per bulan', sub, barChart(series, 'orders', (n) => `${num(n)} transaksi`, 'Jumlah transaksi per bulan'))}`;
}

function monthsHTML(d, hasFilter) {
  if (!d.months.length) {
    return hasFilter
      ? emptyState('Tidak ada transaksi yang cocok', 'Ubah atau atur ulang filter di atas.', 'receipt')
      : emptyState('Belum ada transaksi production yang berhasil', 'Rekap bulanan muncul otomatis setelah ada pembayaran production yang berhasil.', 'wallet');
  }
  const max = Math.max(1, ...d.months.map((m) => m.revenue));
  const cur = nowYm();
  return html`
    <table>
      <thead><tr><th>Bulan</th><th class="num">Transaksi</th><th class="num">Pendapatan</th><th><span class="sr-only">Aksi</span></th></tr></thead>
      <tbody>${d.months.map((m) => html`<tr data-month="${m.month}">
        <td class="pm-month"><b>${monthLabel(m.month)}</b>${m.month === cur ? html` <span class="pill">Bulan berjalan</span>` : ''}<span class="pm-meter" aria-hidden="true"><i style="width:${m.revenue ? `max(3px, ${(m.revenue / max) * 100}%)` : '0'}"></i></span></td>
        <td class="num">${num(m.orders)}</td>
        <td class="num"><b>${rp(m.revenue)}</b></td>
        <td><div class="row-actions">
          <button class="btn btn--sm" type="button" data-detail="${m.month}">Detail</button>
          <button class="btn btn--sm btn--danger" type="button" data-clear="${m.month}" aria-label="Hapus rekap ${monthLabel(m.month)}">${icon('trash')}Hapus rekap</button>
        </div></td>
      </tr>`)}</tbody>
      <tfoot><tr><th>${hasFilter ? 'Total sesuai filter' : 'Total semua bulan'}</th><th class="num">${num(d.totals.orders)}</th><th class="num">${rp(d.totals.revenue)}</th><th></th></tr></tfoot>
    </table>`;
}

function detailHTML(res, hasFilter) {
  const t = res.totals;
  return html`
    <p class="muted" style="margin:0">Hanya transaksi <b>Production</b> dengan pembayaran berhasil${hasFilter ? ', sesuai filter yang sedang dipilih' : ''}. Angka di bawah sama dengan baris bulan ini di daftar rekap.</p>
    <div class="pm-sum">
      <div><span>Transaksi berhasil</span><b>${num(t.orders)}</b></div>
      <div><span>Total pendapatan</span><b>${rp(t.revenue)}</b></div>
      <div><span>Rata-rata per transaksi</span><b>${rp(t.average)}</b></div>
    </div>
    <div class="card">
      ${res.items.length ? html`
      <div class="table-wrap"><table class="pm-tx">
        <thead><tr><th>ID order</th><th>Tanggal bayar</th><th>Customer</th><th>Produk</th><th class="num">Qty</th><th class="num">Harga</th><th class="num">Total bayar</th><th>Status</th><th>Environment</th></tr></thead>
        <tbody>${res.items.map((o) => html`<tr>
          <td><b>${o.orderNo}</b></td>
          <td class="muted">${wib(o.paidAt)}</td>
          <td>${o.customer.name}<small>${o.customer.email}</small></td>
          <td>${o.product.name}${o.product.category ? html`<small>${o.product.category}</small>` : ''}</td>
          <td class="num">${num(o.quantity)}</td>
          <td class="num">${rp(o.price)}</td>
          <td class="num"><b>${rp(o.total)}</b>${o.uniqueAmount > 0 ? html`<small>termasuk kode unik ${rp(o.uniqueAmount)}</small>` : ''}</td>
          <td><span class="pill pill--ok">Berhasil</span>${o.late ? html`<small>Dibayar terlambat</small>` : ''}</td>
          <td><span class="pill">${o.mode === 'production' ? 'Production' : o.mode}</span></td>
        </tr>`)}</tbody>
      </table></div>
      ${pagerHTML(res)}` : emptyState('Tidak ada transaksi', 'Rekap bulan ini kosong atau sudah dihapus.', 'receipt')}
    </div>`;
}

/** Laporan production, dihitung dari order SUCCESS + mode production; berubah realtime. */
export default {
  async mount(root) {
    const q = { ...FILTERS };
    let data = null;
    let alive = true;
    let reqId = 0;
    let detailReq = 0;
    let detail = null;   // { month, page, ctl } — drawer detail yang sedang terbuka

    const params = () => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== ''));
    const hasFilter = () => Object.values(q).some(Boolean);
    const scoped = () => Boolean(q.productId || q.category || q.payment);

    mount(root, html`
      <div class="page-head"><div><h2>Keuntungan Per Bulan</h2><p>Rekap pendapatan dari transaksi production yang pembayarannya sudah berhasil. Transaksi Sandbox tidak pernah dihitung. Berubah otomatis tanpa refresh.</p></div></div>

      <section class="card pm-filters" aria-label="Filter laporan">
        <label class="field"><span>Tahun</span><select id="f-year"><option value="">Semua tahun</option></select></label>
        <label class="field"><span>Bulan</span><select id="f-month"><option value="">Semua bulan</option>${MONTHS.map((m, i) => html`<option value="${i + 1}">${m}</option>`)}</select></label>
        <label class="field"><span>Dari tanggal</span><input id="f-from" type="date"></label>
        <label class="field"><span>Sampai tanggal</span><input id="f-to" type="date"></label>
        <label class="field"><span>Produk</span><select id="f-product"><option value="">Semua produk</option></select></label>
        <label class="field"><span>Kategori</span><select id="f-category"><option value="">Semua kategori</option></select></label>
        <label class="field"><span>Status pembayaran</span><select id="f-payment">${PAYMENT.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></label>
        <button class="btn" type="button" id="f-reset">Atur ulang</button>
        <p class="pm-filters__hint" id="f-hint"></p>
      </section>

      <section class="card pm-hero" id="hero" aria-live="polite"><i class="skel" style="width:26%"></i><i class="skel" style="height:54px;width:46%"></i><i class="skel" style="width:70%"></i></section>
      <section class="pm-charts" id="charts"></section>

      <section class="card">
        <div class="card__head"><h3>Rekap per bulan</h3><small id="months-note"></small></div>
        <div class="table-wrap" id="months" style="margin-top:14px"><div class="card__body"><i class="skel" style="width:100%"></i></div></div>
      </section>`);

    /* ---------- Filter ---------- */
    let optionsKey = '';
    function renderOptions(o) {
      const key = JSON.stringify(o);
      if (key === optionsKey) return syncControls();   // dropdown yang sedang dibuka tidak dibangun ulang saat refresh realtime
      optionsKey = key;
      const fill = (id, first, items) => {
        const el = $(id, root);
        el.innerHTML = html`<option value="">${first}</option>${items.map(([v, l]) => html`<option value="${v}">${l}</option>`)}`.s;
      };
      fill('#f-year', 'Semua tahun', o.years.map((y) => [y, y]));
      fill('#f-product', 'Semua produk', o.products.map((p) => [p.productId, p.name]));
      fill('#f-category', 'Semua kategori', o.categories.map((c) => [c, c]));
      syncControls();
    }
    function syncControls() {
      const ranged = Boolean(q.from || q.to);
      $('#f-year', root).value = q.year;
      $('#f-month', root).value = q.month;
      $('#f-from', root).value = q.from;
      $('#f-to', root).value = q.to;
      $('#f-product', root).value = q.productId;
      $('#f-category', root).value = q.category;
      $('#f-payment', root).value = q.payment;
      $('#f-year', root).disabled = ranged;
      $('#f-month', root).disabled = ranged || !q.year;
      $('#f-hint', root).textContent = ranged ? 'Rentang tanggal sedang dipakai, jadi pilihan tahun dan bulan tidak berlaku.' : '';
    }
    /** Pilihan yang sudah tidak punya transaksi (mis. rekapnya dihapus) dilepas dari filter supaya tidak menggantung. */
    function pruneFilters(o) {
      let changed = false;
      const drop = (key, ok) => { if (q[key] !== '' && !ok) { q[key] = ''; changed = true; } };
      drop('year', o.years.some((y) => String(y) === String(q.year)));
      if (!q.year && q.month) { q.month = ''; changed = true; }
      drop('productId', o.products.some((p) => String(p.productId) === String(q.productId)));
      drop('category', o.categories.includes(q.category));
      return changed;
    }

    /* ---------- Muat & tampilkan ---------- */
    function render() {
      mount($('#hero', root), heroHTML(data.summary, scoped()));
      mount($('#charts', root), chartsHTML(data, q));
      mount($('#months', root), monthsHTML(data, hasFilter()));
      $('#months-note', root).textContent = data.months.length ? `${num(data.months.length)} bulan, terbaru di atas` : '';
    }
    async function load() {
      const id = ++reqId;
      try {
        const res = await api.get('/reports/monthly', params());
        if (!alive || id !== reqId) return;
        data = res;
        renderOptions(res.options);
        if (pruneFilters(res.options)) { syncControls(); return load(); }
        render();
        if (detail) loadDetail();
      } catch (err) {
        if (!alive || id !== reqId) return;
        if (data) return toastError(err, 'Laporan gagal dimuat');
        mount($('#hero', root), html`<div class="empty">${icon('alert')}<b>Laporan gagal dimuat</b><span>${err.message}</span><button class="btn" type="button" data-retry>Coba lagi</button></div>`);
      }
    }
    const reloadSoon = debounce(load, 600);
    const refilter = () => { syncControls(); load(); };

    $('#f-year', root).addEventListener('change', (e) => { q.year = e.target.value; q.month = ''; refilter(); });
    $('#f-month', root).addEventListener('change', (e) => { q.month = e.target.value; refilter(); });
    for (const [id, key] of [['#f-from', 'from'], ['#f-to', 'to']]) {
      $(id, root).addEventListener('change', (e) => {
        q[key] = e.target.value;
        if (q.from || q.to) { q.year = ''; q.month = ''; }   // rentang tanggal menggantikan tahun/bulan
        refilter();
      });
    }
    for (const [id, key] of [['#f-product', 'productId'], ['#f-category', 'category'], ['#f-payment', 'payment']]) {
      $(id, root).addEventListener('change', (e) => { q[key] = e.target.value; refilter(); });
    }
    $('#f-reset', root).addEventListener('click', () => { Object.assign(q, FILTERS); refilter(); });

    /* ---------- Detail satu bulan ---------- */
    async function loadDetail() {
      if (!detail) return;
      const { month, ctl } = detail;
      const id = ++detailReq;
      try {
        const res = await api.get(`/reports/monthly/${month}`, { ...params(), page: detail.page, limit: 25 });
        if (!alive || detail?.ctl !== ctl || id !== detailReq) return;
        if (!res.items.length && detail.page > 1) { detail.page = res.totalPages; return loadDetail(); }
        mount($('#pm-detail', ctl.el), detailHTML(res, hasFilter()));
      } catch (err) { if (alive && detail?.ctl === ctl) toastError(err, 'Detail rekap gagal dimuat'); }
    }
    function openDetail(month) {
      const ctl = dialog({
        kind: 'drawer pm-drawer',
        title: `Rekap ${monthLabel(month)}`,
        body: html`<div id="pm-detail" class="pm-detail"><i class="skel" style="width:60%"></i><i class="skel" style="width:100%;height:120px"></i></div>`,
        foot: html`<button type="button" class="btn btn--danger" data-clear-here style="margin-right:auto">${icon('trash')}Hapus Rekap Bulan</button><button type="button" class="btn" data-close>Tutup</button>`,
      });
      detail = { month, page: 1, ctl };
      ctl.closed.then(() => { if (detail?.ctl === ctl) detail = null; });
      ctl.el.addEventListener('click', (e) => {
        const pg = e.target.closest('[data-page]');
        if (pg && !pg.disabled) { detail.page = +pg.dataset.page; return loadDetail(); }
        const clr = e.target.closest('[data-clear-here]');
        if (clr) clearMonth(month, clr);
      });
      loadDetail();
    }

    /* ---------- Hapus rekap bulan ---------- */
    async function clearMonth(month, btn) {
      let impact;
      try { impact = await busy(btn, () => api.get(`/reports/monthly/${month}/impact`)); }
      catch (err) { return toastError(err, 'Dampak penghapusan gagal dihitung'); }
      if (!impact.orders) { toast('Rekap bulan ini sudah kosong'); return load(); }

      const label = monthLabel(month);
      const d = dialog({
        title: 'Hapus Rekap Bulan',
        body: html`
          <p style="margin:0">Rekap <b>${label}</b> akan dihapus dari halaman Keuntungan Per Bulan.</p>
          <dl class="pm-impact">
            <div><dt>Transaksi terdampak</dt><dd>${num(impact.orders)}</dd></div>
            <div><dt>Total pendapatan</dt><dd>${rp(impact.revenue)}</dd></div>
          </dl>
          <p class="muted" style="margin:0">Yang dihapus hanya rekap di halaman ini. Pesanan dan pembayaran asli tidak diubah, jadi tetap ada di menu Pesanan dan Dashboard.</p>
          ${month === nowYm() ? html`<p class="muted" style="margin:0">Pembayaran production baru bulan ini tetap akan masuk ke rekap.</p>` : ''}
          ${hasFilter() ? html`<p class="muted" style="margin:0">Penghapusan berlaku untuk seluruh transaksi ${label}, tidak terbatas pada filter yang sedang dipilih.</p>` : ''}`,
        foot: html`<button type="button" class="btn" data-close>Batal</button><button type="button" class="btn btn--danger-solid" data-ok>Hapus rekap ${label}</button>`,
      });
      $('.dlg__foot [data-close]', d.el).focus();   // aksi merusak: fokus awal di Batal
      $('[data-ok]', d.el).addEventListener('click', async (e) => {
        try {
          const { cleared } = await busy(e.currentTarget, () => api.del(`/reports/monthly/${month}`, { asOf: impact.asOf }));
          d.close();
          if (detail?.month === month) detail.ctl.close();
          toast(`Rekap ${label} dihapus`, { detail: `${num(cleared.orders)} transaksi (${rp(cleared.revenue)}) disembunyikan dari laporan. Pesanan asli tidak berubah.` });
          load();
        } catch (err) {
          toastError(err, 'Rekap gagal dihapus');
          if (err.status === 404) { d.close(); load(); }
        }
      });
    }

    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-retry]')) return load();
      const det = e.target.closest('[data-detail]');
      if (det) return openDetail(det.dataset.detail);
      const clr = e.target.closest('[data-clear]');
      if (clr) clearMonth(clr.dataset.clear, clr);
    });

    await load();

    return {
      destroy() { alive = false; reloadSoon.cancel(); detail?.ctl.close(); },
      onLive(evt, payload) {
        if (!alive) return;
        if (evt === 'resync' || evt === 'report:update') return reloadSoon();
        // Sandbox tidak pernah masuk laporan, jadi hanya perubahan order production yang menyegarkan halaman.
        if (evt === 'order:update' && payload?.mode === 'production') reloadSoon();
      },
    };
  },
};
