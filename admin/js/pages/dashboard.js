import { $, html, mount, icon, num, rp, dateShort, starsHTML, debounce, stockPill, emptyState, toastError } from '../ui.js';
import { api } from '../api.js';

const thumb = (p) => (p.media.find((m) => m.type === 'image')
  ? html`<span class="thumb"><img src="${p.media.find((m) => m.type === 'image').url}" alt="" loading="lazy"></span>`
  : html`<span class="thumb">${icon('image')}</span>`);

const hbars = (rows, max) => html`<div class="hbars">${rows.map((r) => html`
  <div class="hbar"><span class="hbar__label" title="${r.label}">${r.label}</span><span class="hbar__track"><i style="width:${r.n ? `max(4px, ${(r.n / max) * 100}%)` : 0}"></i></span><span class="hbar__n">${num(r.n)}</span></div>`)}</div>`;

function view(d) {
  const p = d.products;
  const attention = p.out + p.low;
  const seg = (n, color, label) => ({ n, color, label });
  const segs = [seg(p.healthy, 'var(--purple)', 'Tersedia'), seg(p.low, '#e0a21b', 'Stok terbatas'), seg(p.out, '#d9485a', 'Habis')];
  const catMax = Math.max(1, ...d.categories.map((c) => c.count));
  const ratingMax = Math.max(1, ...Object.values(d.reviews.distribution));

  return html`
  <section class="kpis" aria-label="Ringkasan">
    <article class="card kpi"><div class="kpi__top"><span>Produk aktif</span>${icon('box')}</div>
      <div class="kpi__num">${num(p.active)} <small>/ ${num(p.total)}</small></div>
      <div class="kpi__sub">${p.inactive ? `${num(p.inactive)} produk dinonaktifkan` : 'Semua produk tampil di Marketplace'}</div></article>
    <article class="card kpi"><div class="kpi__top"><span>Perlu perhatian</span>${icon('alert')}</div>
      <div class="kpi__num">${num(attention)}</div>
      <div class="kpi__sub">${num(p.out)} habis · ${num(p.low)} stok terbatas</div></article>
    <article class="card kpi"><div class="kpi__top"><span>Rating rata-rata</span>${icon('star')}</div>
      <div class="kpi__num">${d.reviews.average == null ? '—' : d.reviews.average.toFixed(1)} <small>${d.reviews.average == null ? '' : '/ 5'}</small></div>
      <div class="kpi__sub">${num(d.reviews.published)} ulasan tampil${d.reviews.hidden ? ` · ${num(d.reviews.hidden)} disembunyikan` : ''}</div></article>
    <article class="card kpi"><div class="kpi__top"><span>Pengunjung online</span>${icon('eye')}</div>
      <div class="kpi__num" id="kpi-online">${num(d.online)}</div>
      <div class="kpi__sub">Sedang membuka Marketplace</div></article>
  </section>

  <section class="dash-grid">
    <article class="card"><div class="card__head"><h3>Kesehatan stok</h3><small>${num(p.total)} produk</small></div>
      <div class="card__body">
        ${p.total ? html`
        <div class="stackbar" role="img" aria-label="Tersedia ${p.healthy}, stok terbatas ${p.low}, habis ${p.out}">${segs.filter((s) => s.n).map((s) => html`<i style="flex:${s.n};background:${s.color}"></i>`)}</div>
        <div class="legend">${segs.map((s) => html`<span><i class="dot" style="background:${s.color}"></i>${s.label} <b>${num(s.n)}</b></span>`)}</div>` : emptyState('Belum ada produk', 'Tambahkan produk pertama dari menu Produk.')}
        <h3 class="section-title" style="margin:26px 0 12px">Produk per kategori</h3>
        ${d.categories.length ? hbars(d.categories.map((c) => ({ label: c.name + (c.active ? '' : ' (nonaktif)'), n: c.count })), catMax) : html`<p class="muted">Belum ada kategori.</p>`}
      </div></article>

    <article class="card"><div class="card__head"><h3>Distribusi rating</h3><small>${num(d.reviews.published)} ulasan</small></div>
      <div class="card__body">
        ${d.reviews.published ? hbars([5, 4, 3, 2, 1].map((s) => ({ label: `${s} bintang`, n: d.reviews.distribution[s] || 0 })), ratingMax) : emptyState('Belum ada ulasan', 'Ulasan yang tampil akan dihitung di sini.', 'star')}
      </div></article>
  </section>

  <section class="dash-grid">
    <article class="card"><div class="card__head"><h3>Perlu perhatian</h3><a href="#/products">Semua produk</a></div>
      <div class="card__body">
        ${d.attention.length ? html`<div class="list">${d.attention.map((x) => html`
          <div class="list__row">${thumb(x)}<div class="list__main"><b>${x.name}</b><small>${x.category.name} · ${rp(x.price)}</small></div>${stockPill(x.stock)}<a class="btn btn--sm" href="#/products?edit=${x.id}">Atur stok</a></div>`)}</div>`
          : emptyState('Stok aman', 'Tidak ada produk yang habis atau hampir habis.', 'check')}
      </div></article>

    <article class="card"><div class="card__head"><h3>Ulasan terbaru</h3><a href="#/reviews">Semua ulasan</a></div>
      <div class="card__body">
        ${d.recentReviews.length ? html`<div class="list">${d.recentReviews.map((r) => html`
          <div class="list__row"><div class="list__main"><b>${r.name} ${starsHTML(r.stars)}</b><small>${r.productName} · ${dateShort(r.date)}${r.status === 'hidden' ? ' · disembunyikan' : ''}</small></div></div>`)}</div>`
          : emptyState('Belum ada ulasan', 'Tambahkan ulasan dari menu Rating & Ulasan.', 'star')}
      </div></article>
  </section>`;
}

export default {
  async mount(root) {
    let alive = true;
    const load = async () => {
      try {
        const d = await api.get('/dashboard');
        if (alive) mount(root, view(d));
      } catch (err) { if (alive) toastError(err, 'Dashboard gagal dimuat'); }
    };
    mount(root, html`<div class="kpis">${[1, 2, 3, 4].map(() => html`<div class="card kpi"><i class="skel" style="width:60%"></i><i class="skel" style="height:34px;width:40%"></i></div>`)}</div>`);
    await load();
    const reload = debounce(load, 400);
    return {
      destroy() { alive = false; reload.cancel(); },
      onLive(evt, payload) {
        if (evt === 'presence:update') { const el = $('#kpi-online'); if (el) el.textContent = num(payload.online); return; }
        if (/^(product|category|review):/.test(evt) || evt === 'resync') reload();
      },
    };
  },
};
