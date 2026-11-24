import { $, html, mount, icon, toast, toastError, busy, fieldErrors, dateTime, dialog } from '../ui.js';
import { api } from '../api.js';

/**
 * Pengaturan 31 QRIS. API Key dan Webhook Secret hanya dikirim ke server saat diisi/diganti dan tidak pernah dikembalikan
 * (server hanya menyebut "tersimpan" + 4 karakter terakhir). Backend membaca pengaturan dari MongoDB di setiap transaksi.
 * Riwayat webhook diambil dari server dan dimuat ulang otomatis lewat event Socket.IO admin `payment-webhook`.
 */
const OUTCOME = {
  applied: ['Diterapkan', 'pill--ok'], duplicate: ['Ganda / tanpa perubahan', 'pill--mute'], ignored: ['Diabaikan', 'pill--mute'],
  rejected: ['Ditolak', 'pill--danger'], error: ['Error (akan diulang)', 'pill--warn'], processing: ['Diproses', 'pill--warn'],
};

export default {
  async mount(root) {
    let s = (await api.get('/payment-settings')).settings;
    let conn = { state: 'checking', text: 'Memeriksa koneksi…' };   // checking | ok | warn | fail | none
    let hooks = { items: [], total: 0, page: 1, totalPages: 1 };
    let alive = true;

    const secretField = ({ name, label, set, readable, hint, fromEnv, placeholder, clearName }) => html`
      <label class="field"><span>${label}</span><input name="${name}" type="password" maxlength="400" autocomplete="new-password" spellcheck="false" placeholder="${set ? (readable ? `Tersimpan ${hint} — kosongkan jika tidak diganti` : 'Tidak terbaca — isi ulang') : (fromEnv ? `Memakai variabel server (${hint})` : placeholder)}">
        <small>Disimpan terenkripsi di server dan tidak pernah ditampilkan kembali.</small></label>
      ${set ? html`<label class="switch"><input type="checkbox" name="${clearName}"><i></i>Hapus ${label} tersimpan</label>` : ''}`;

    const connPill = () => ({
      checking: html`<span class="pill pill--warn">Memeriksa…</span>`,
      ok: html`<span class="pill pill--ok">Terhubung</span>`,
      warn: html`<span class="pill pill--warn">Terhubung (izin terbatas)</span>`,
      fail: html`<span class="pill pill--danger">Tidak terhubung</span>`,
      none: html`<span class="pill pill--mute">Belum diatur</span>`,
    })[conn.state];

    const hookTable = () => (hooks.items.length ? html`
      <table><thead><tr><th>Waktu</th><th>Order / Transaksi</th><th>Status gateway</th><th>Hasil</th><th></th></tr></thead>
      <tbody>${hooks.items.map((w) => html`<tr>
        <td class="muted">${dateTime(w.at)}${w.deliveries > 1 ? html`<br><small class="faint">dikirim ${w.deliveries}×</small>` : ''}</td>
        <td>${w.orderNo ? html`<b>${w.orderNo}</b>` : '—'}${w.txId ? html`<br><small class="faint">${w.txId}</small>` : ''}</td>
        <td>${w.gatewayStatus || '—'}${w.event ? html`<br><small class="faint">${w.event}</small>` : ''}</td>
        <td><span class="pill ${(OUTCOME[w.outcome] || ['', ''])[1]}">${(OUTCOME[w.outcome] || [w.outcome])[0]}</span> <small class="faint">HTTP ${w.httpCode || '—'}${w.signatureValid ? '' : ' · signature salah'}</small>${w.note ? html`<br><small class="faint">${w.note}</small>` : ''}</td>
        <td><button class="btn btn--sm" type="button" data-hook="${w.id}">Payload</button></td>
      </tr>`)}</tbody></table>` : html`<p class="muted" style="padding:16px">Belum ada webhook yang masuk.</p>`);

    const hookPager = () => (hooks.totalPages > 1 ? html`<div class="actions" style="padding:12px"><button class="btn btn--sm" type="button" id="hooks-prev" ${hooks.page <= 1 ? 'disabled' : ''}>Sebelumnya</button><span class="muted">Halaman ${hooks.page} / ${hooks.totalPages}</span><button class="btn btn--sm" type="button" id="hooks-next" ${hooks.page >= hooks.totalPages ? 'disabled' : ''}>Berikutnya</button></div>` : '');

    function draw() {
      mount(root, html`
        <div class="page-head"><div><h2>Pembayaran</h2><p>Integrasi 31 QRIS untuk checkout QRIS. Perubahan langsung dipakai backend setelah disimpan.</p></div></div>
        <form class="stack" id="pay-form" style="max-width:820px" novalidate>
          <section class="card"><div class="card__head"><h3>31 QRIS Gateway</h3><span id="conn">${connPill()}</span></div>
            <div class="card__body stack">
              <label class="field"><span>API Gateway URL</span><input value="${s.gateway.baseUrl}" readonly><small>Diatur di server (variabel <code>QRIS31_BASE_URL</code>), bukan dari browser.</small></label>
              ${secretField({ name: 'apiKey', label: 'API Key', set: s.apiKeySet, readable: s.apiKeyReadable, hint: s.apiKeyHint, fromEnv: s.apiKeyFromEnv, placeholder: 'Tempel API Key dari dashboard 31 QRIS', clearName: 'clearApiKey' })}
              <p class="muted">API Key hanya dipakai backend (header <code>Authorization: Bearer</code>) dan tidak pernah dikirim ke browser. Izin yang dibutuhkan: <code>transactions:create</code>, <code>transactions:read</code>, <code>transactions:cancel</code>, <code>qris:read</code>. Kunci tanpa izin dibalas 403 <code>INSUFFICIENT_SCOPE</code>.</p>
              <div class="actions"><button class="btn" type="button" id="test">Uji koneksi</button><span class="muted" id="test-out" role="status">${conn.text}</span></div>
            </div></section>

          <section class="card"><div class="card__head"><h3>Webhook 31 QRIS</h3>${s.webhookReady ? html`<span class="pill pill--ok">Secret terpasang</span>` : html`<span class="pill pill--warn">Secret belum diisi</span>`}</div>
            <div class="card__body stack">
              <p class="muted">Isi <b>URL webhook</b> berikut di dashboard 31 QRIS, lalu tempel <b>Webhook secret</b> (<code>whsec_…</code>) di bawah. Setiap webhook diverifikasi lewat tanda tangan HMAC pada header <code>X-Signature</code>, dicatat, dan status transaksi dibaca ulang dari gateway sebelum pesanan diaktifkan. Tanpa webhook, status tetap dicek berkala ke gateway. Bila secret diganti/dibuat ulang di dashboard, perbarui di sini.</p>
              <div class="copybox"><code id="wh">${s.webhookUrl}</code><button class="btn btn--sm" type="button" id="copy-wh">${icon('copy')}Salin</button></div>
              ${secretField({ name: 'webhookSecret', label: 'Webhook Secret', set: s.webhookSecretSet, readable: s.webhookSecretReadable, hint: s.webhookSecretHint, fromEnv: s.webhookSecretFromEnv, placeholder: 'whsec_…', clearName: 'clearWebhookSecret' })}
              <label class="field"><span>URL publik toko (opsional)</span><input name="publicBaseUrl" value="${s.publicBaseUrl}" maxlength="200" placeholder="https://toko.domainmu.com"><small>Isi bila backend berada di belakang proxy/domain lain; dipakai untuk URL webhook di atas dan tautan notifikasi. Kosong = alamat server ini.</small></label>
            </div></section>

          <section class="card"><div class="card__head"><h3>WhatsApp Admin</h3></div>
            <div class="card__body stack">
              <label class="field"><span>Nomor WhatsApp Admin</span><input name="waAdmin" inputmode="tel" value="${s.waAdmin ? '+' + s.waAdmin : ''}" maxlength="25" placeholder="0812 3456 7890"><small>Dipakai tombol “Hubungi Admin via WhatsApp” di halaman Payment dan tombol “Butuh bantuan?” di halaman Cek Pesanan (ID Transaksi ikut terisi otomatis). Format 08… otomatis menjadi +62….</small></label>
              <div class="actions"><button class="btn btn--primary" type="submit">Simpan pengaturan</button></div>
            </div></section>
        </form>

        <section class="card" style="max-width:820px;margin-top:16px"><div class="card__head"><h3>Riwayat webhook</h3><button class="btn btn--sm" type="button" id="hooks-reload">Muat ulang</button></div>
          <div class="table-wrap" id="hooks">${hookTable()}</div>
          <div id="hooks-pager">${hookPager()}</div>
        </section>`);
    }

    async function loadHooks(page = hooks.page) {
      try {
        const r = await api.get('/payment-settings/webhooks', { page });
        if (!alive) return;
        hooks = { items: r.items, total: r.total, page: r.page ?? page, totalPages: r.totalPages ?? 1 };
        const box = $('#hooks', root);
        if (box) { box.innerHTML = hookTable().s; $('#hooks-pager', root).innerHTML = hookPager().s; }   // hanya riwayat: isian form tidak ter-reset
      } catch (err) { if (alive) toastError(err, 'Riwayat webhook gagal dimuat'); }
    }

    async function testConn(btn) {
      conn = { state: 'checking', text: 'Memeriksa koneksi…' };
      const pillEl = $('#conn', root); if (pillEl) pillEl.innerHTML = connPill().s;
      try {
        const r = await (btn ? busy(btn, () => api.post('/payment-settings/test')) : api.post('/payment-settings/test'));
        conn = r.warning ? { state: 'warn', text: r.warning } : { state: 'ok', text: 'Terhubung ke 31 QRIS.' };
      } catch (err) {
        conn = { state: err.status === 422 ? 'none' : 'fail', text: err.message };
      }
      if (!alive) return;
      const p = $('#conn', root); if (p) p.innerHTML = connPill().s;
      const o = $('#test-out', root); if (o) o.textContent = conn.text;
    }

    draw();
    await loadHooks(1);
    testConn();

    root.addEventListener('click', async (e) => {
      if (e.target.closest('#copy-wh')) {
        try { await navigator.clipboard.writeText($('#wh', root).textContent); toast('URL webhook disalin'); } catch { toast('Salin manual dari kotak', { type: 'error' }); }
      }
      const t = e.target.closest('#test');
      if (t) return testConn(t);
      if (e.target.closest('#hooks-reload')) return loadHooks(hooks.page);
      if (e.target.closest('#hooks-prev')) return loadHooks(hooks.page - 1);
      if (e.target.closest('#hooks-next')) return loadHooks(hooks.page + 1);
      const h = e.target.closest('[data-hook]');
      if (h) {
        const w = hooks.items.find((x) => x.id === h.dataset.hook);
        if (!w) return;
        dialog({ title: `Webhook ${w.orderNo || ''}`.trim(), body: html`<p class="muted">${dateTime(w.at)} · IP ${w.ip || '—'} · signature ${w.signatureValid ? 'valid' : 'TIDAK valid'}</p><pre style="white-space:pre-wrap;word-break:break-all;max-height:50vh;overflow:auto">${w.payload || '(kosong)'}</pre>`, foot: html`<button type="button" class="btn" data-close>Tutup</button>` });
      }
    });

    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const body = {
        apiKey: f.apiKey.value.trim(), clearApiKey: Boolean(f.clearApiKey?.checked),
        webhookSecret: f.webhookSecret.value.trim(), clearWebhookSecret: Boolean(f.clearWebhookSecret?.checked),
        waAdmin: f.waAdmin.value, publicBaseUrl: f.publicBaseUrl.value,
      };
      try {
        const res = await busy($('button[type="submit"]', e.target), () => api.put('/payment-settings', body));
        s = res.settings;
        draw();
        toast('Pengaturan pembayaran disimpan', { detail: '31 QRIS aktif sebagai gateway pembayaran.' });
        testConn();
      } catch (err) {
        if (!fieldErrors(e.target, err.fields)) toastError(err);
        else toast(err.message, { type: 'error' });
      }
    });

    return {
      destroy() { alive = false; },
      onLive(evt, payload) {
        if (evt === 'payment-settings:update') { s = payload; }
        if (evt === 'payment-webhook') loadHooks(1);
      },
    };
  },
};
