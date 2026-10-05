import { $, html, mount, icon, toast, toastError, busy, fieldErrors } from '../ui.js';
import { api } from '../api.js';

/**
 * Pengaturan KlikQRIS. API Key hanya dikirim ke server saat diisi/diganti dan tidak pernah dikembalikan
 * (server hanya menyebut "tersimpan" + 4 karakter terakhir). Backend membaca pengaturan dari MongoDB di setiap transaksi.
 */
export default {
  async mount(root) {
    let s = (await api.get('/payment-settings')).settings;

    const credCard = (mode, label) => {
      const c = s[mode];
      return html`
        <div class="cred ${s.mode === mode ? 'is-active' : ''}" data-cred="${mode}">
          <div class="cred__head"><h3>${label}</h3>${s.mode === mode ? html`<span class="pill">Mode aktif</span>` : ''}${c.ready ? html`<span class="pill pill--ok">Lengkap</span>` : html`<span class="pill pill--mute">Belum lengkap</span>`}</div>
          <label class="field"><span>Merchant ID</span><input name="${mode}MerchantId" value="${c.merchantId}" maxlength="120" autocomplete="off" spellcheck="false"></label>
          <label class="field"><span>API Key</span><input name="${mode}ApiKey" type="password" maxlength="400" autocomplete="new-password" spellcheck="false" placeholder="${c.apiKeySet ? (c.apiKeyReadable ? `Tersimpan ${c.apiKeyHint} — kosongkan jika tidak diganti` : 'Tidak terbaca — isi ulang') : 'Tempel API Key dari dashboard KlikQRIS'}">
            <small>Disimpan terenkripsi di server dan tidak pernah ditampilkan kembali.</small></label>
          ${c.apiKeySet ? html`<label class="switch"><input type="checkbox" name="${mode}Clear"><i></i>Hapus API Key tersimpan</label>` : ''}
        </div>`;
    };

    function draw() {
      mount(root, html`
        <div class="page-head"><div><h2>Pembayaran</h2><p>Integrasi KlikQRIS untuk checkout QRIS. Perubahan langsung dipakai backend setelah disimpan.</p></div></div>
        <form class="stack" id="pay-form" style="max-width:820px" novalidate>
          <section class="card"><div class="card__head"><h3>Mode & kredensial</h3></div>
            <div class="card__body stack">
              <div class="field" data-field="mode"><span>Mode transaksi</span>
                <div class="seg" role="radiogroup" aria-label="Mode transaksi">
                  <label><input type="radio" name="mode" value="sandbox" ${s.mode === 'sandbox' ? 'checked' : ''}><span>Sandbox (uji coba)</span></label>
                  <label><input type="radio" name="mode" value="production" ${s.mode === 'production' ? 'checked' : ''}><span>Production (uang asli)</span></label>
                </div>
                <small>Sandbox memakai endpoint /api/sandbox KlikQRIS; Production memakai /api. Setiap mode punya API Key dan Merchant ID sendiri.</small></div>
              <div class="grid-2">${credCard('sandbox', 'Sandbox')}${credCard('production', 'Production')}</div>
              <div class="actions"><button class="btn" type="button" id="test">Uji koneksi mode aktif</button><span class="muted" id="test-out" role="status"></span></div>
            </div></section>

          <section class="card"><div class="card__head"><h3>Webhook / Callback</h3></div>
            <div class="card__body stack">
              <p class="muted">Backend mengirim URL ini sebagai <code>callback_url</code> pada setiap transaksi. Isi juga sebagai URL Webhook global di menu Pengaturan KlikQRIS sebagai cadangan. Signature divalidasi otomatis.</p>
              <div class="copybox"><code id="wh">${s.webhookUrl}</code><button class="btn btn--sm" type="button" id="copy-wh">${icon('copy')}Salin</button></div>
              <label class="field"><span>URL publik toko (opsional)</span><input name="publicBaseUrl" value="${s.publicBaseUrl}" maxlength="200" placeholder="https://toko.domainmu.com"><small>Isi bila backend berada di belakang proxy/domain lain. Kosong = alamat server ini. Alamat localhost tidak dikirim ke KlikQRIS; status tetap dicek berkala sebagai cadangan.</small></label>
            </div></section>

          <section class="card"><div class="card__head"><h3>WhatsApp Admin</h3></div>
            <div class="card__body stack">
              <label class="field"><span>Nomor WhatsApp Admin</span><input name="waAdmin" inputmode="tel" value="${s.waAdmin ? '+' + s.waAdmin : ''}" maxlength="25" placeholder="0812 3456 7890"><small>Dipakai tombol “Hubungi Admin via WhatsApp” di halaman Payment Success. Format 08… otomatis menjadi +62….</small></label>
              <div class="actions"><button class="btn btn--primary" type="submit">Simpan pengaturan</button></div>
            </div></section>
        </form>`);
    }
    draw();

    root.addEventListener('click', async (e) => {
      if (e.target.closest('#copy-wh')) {
        try { await navigator.clipboard.writeText($('#wh', root).textContent); toast('URL webhook disalin'); } catch { toast('Salin manual dari kotak', { type: 'error' }); }
      }
      const t = e.target.closest('#test');
      if (t) {
        const out = $('#test-out', root);
        out.textContent = '';
        try { const r = await busy(t, () => api.post('/payment-settings/test')); out.textContent = `Terhubung ke KlikQRIS (${r.mode}).`; } catch (err) { out.textContent = err.message; }
      }
    });
    root.addEventListener('change', (e) => { if (e.target.name === 'mode') { s = { ...s, mode: e.target.value }; document.querySelectorAll('[data-cred]').forEach((c) => c.classList.toggle('is-active', c.dataset.cred === s.mode)); } });

    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const set = (m) => ({ merchantId: f[`${m}MerchantId`].value.trim(), apiKey: f[`${m}ApiKey`].value.trim(), clearApiKey: Boolean(f[`${m}Clear`]?.checked) });
      const body = { mode: f.mode.value, sandbox: set('sandbox'), production: set('production'), waAdmin: f.waAdmin.value, publicBaseUrl: f.publicBaseUrl.value };
      try {
        const res = await busy($('button[type="submit"]', e.target), () => api.put('/payment-settings', body));
        s = res.settings;
        draw();
        toast('Pengaturan pembayaran disimpan', { detail: `Mode aktif: ${s.mode === 'production' ? 'Production' : 'Sandbox'}.` });
      } catch (err) {
        if (!fieldErrors(e.target, err.fields)) toastError(err);
        else toast(err.message, { type: 'error' });
      }
    });

    return { destroy() {}, onLive(evt, payload) { if (evt === 'payment-settings:update') { s = payload; } } };
  },
};
