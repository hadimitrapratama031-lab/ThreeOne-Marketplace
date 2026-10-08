import { $, html, mount, icon, toast, toastError, busy, fieldErrors, dateTime } from '../ui.js';
import { api } from '../api.js';

// Izin minimum bot: View Channel (1024) + Send Messages (2048) + Embed Links (16384)
const INVITE_PERMISSIONS = 19456;

/**
 * Pengaturan Discord. Semua nilai disimpan lewat backend (MongoDB); token bot dienkripsi di server dan tidak pernah dikirim
 * balik ke browser — yang tampil hanya 4 karakter terakhir. Status koneksi diperiksa backend ke Discord dan disiarkan
 * realtime lewat Socket.IO admin yang sudah ada (event integrations:update).
 */
export default {
  async mount(root) {
    let s = (await api.get('/integrations')).settings;
    let dirty = false;
    let alive = true;

    const stateOf = (d) => {
      if (!d.configured) return ['Belum dikonfigurasi', 'pill--mute'];
      if (d.connection.status === 'error') return ['Gagal terhubung', 'pill--danger'];
      if (!d.enabled) return ['Nonaktif', 'pill--warn'];
      if (d.connection.status === 'connected') return ['Terhubung', 'pill--ok'];
      return ['Belum diperiksa', 'pill--mute'];
    };
    const connLine = (d) => {
      const c = d.connection;
      if (c.status === 'connected') return `${c.message || 'Terhubung.'} · diperiksa ${dateTime(c.at)}`;
      if (c.status === 'error') return `${c.message || 'Gagal terhubung.'} · ${dateTime(c.at)}`;
      return d.configured ? 'Klik “Periksa koneksi” untuk memastikan bot bisa masuk ke channel.' : 'Isi token bot dan Channel ID, lalu simpan.';
    };
    const testLine = (d) => (d.lastTest.status === 'untested'
      ? 'Belum pernah diuji.'
      : `${d.lastTest.status === 'success' ? 'Uji terakhir berhasil' : 'Uji terakhir gagal'} · ${dateTime(d.lastTest.at)}${d.lastTest.status === 'error' && d.lastTest.message ? ` — ${d.lastTest.message}` : ''}`);

    const statusStrip = () => { const d = s.discord; const [label, cls] = stateOf(d); return html`
      <div class="status-grid" id="dc-status">
        <div class="prov"><span class="prov__icon">${icon('plug')}</span><b>Bot Discord</b><span class="pill ${cls}">${label}</span><small>${connLine(d)}</small></div>
        <div class="prov"><span class="prov__icon">${icon('bell')}</span><b>Notifikasi uji</b><span class="pill ${d.lastTest.status === 'success' ? 'pill--ok' : d.lastTest.status === 'error' ? 'pill--danger' : 'pill--mute'}">${d.lastTest.status === 'success' ? 'Berhasil' : d.lastTest.status === 'error' ? 'Gagal' : 'Belum diuji'}</span><small>${testLine(d)}</small></div>
      </div>`; };

    const inviteLink = () => { const id = s.discord.connection.botId; return id ? html`<a class="btn btn--sm" id="dc-invite" href="https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${INVITE_PERMISSIONS}" target="_blank" rel="noopener noreferrer">Undang bot ke server</a>` : ''; };

    const switchRow = (name, checked, title, desc) => html`
      <div class="setting"><div class="setting__text"><b>${title}</b><small>${desc}</small></div>
        <label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><i></i><span class="sr-only">${title}</span></label></div>`;

    function draw(keepScroll = true) {
      const y = scrollY; const d = s.discord;
      mount(root, html`
        <div class="page-head"><div><h2>Discord</h2><p>Kirim notifikasi pembayaran ke channel toko dan pesan Live Chat baru ke DM admin. Perubahan langsung dipakai backend setelah disimpan.</p></div></div>
        <div class="integ">
          ${statusStrip()}
          <form data-form="discord" class="integ" novalidate>
            <section class="card">
              <div class="card__head"><h3>Koneksi bot</h3></div>
              <p class="card__intro">Bot memakai REST API Discord, jadi tidak ada proses yang perlu dijaga tetap menyala. Token disimpan terenkripsi di server dan tidak pernah ditampilkan lagi.</p>
              <div class="card__body stack">
                ${switchRow('enabled', d.enabled, 'Aktifkan notifikasi Discord', 'Bila mati, tidak ada pesan yang dikirim ke Discord. Pesanan dan pembayaran tetap berjalan normal.')}
                <label class="field"><span>Token bot</span><input name="token" type="password" autocomplete="new-password" spellcheck="false" placeholder="${d.tokenSet ? (d.tokenReadable ? `Tersimpan ${d.tokenHint} — kosongkan bila tidak diganti` : 'Tidak terbaca — isi ulang') : d.fromEnv ? 'Memakai nilai dari environment server' : 'Tempel token dari Discord Developer Portal'}"><small>Developer Portal → aplikasi Anda → Bot → Reset Token.</small></label>
                ${d.tokenSet ? html`<label class="switch"><input type="checkbox" name="clearToken"><i></i>Hapus token tersimpan</label>` : ''}
                <div class="grid-2">
                  <label class="field"><span>Guild ID (server)</span><input name="guildId" inputmode="numeric" autocomplete="off" value="${d.guildId}" placeholder="123456789012345678" maxlength="25"><small>Dipakai memastikan channel memang milik server ini.</small></label>
                  <label class="field"><span>Channel ID</span><input name="channelId" inputmode="numeric" autocomplete="off" value="${d.channelId}" placeholder="123456789012345678" maxlength="25"><small>Tujuan notifikasi pembayaran berhasil.</small></label>
                </div>
                <p class="muted">Ambil ID dengan mengaktifkan Developer Mode di Discord (Pengaturan → Lanjutan), lalu klik kanan server atau channel → Salin ID.</p>
              </div>
            </section>

            <section class="card">
              <div class="card__head"><h3>Notifikasi</h3></div>
              <p class="card__intro">Setiap kejadian dikirim sekali, walau webhook pembayaran masuk berulang atau halaman dimuat ulang.</p>
              <div class="card__body stack">
                <div class="setting"><div class="setting__text"><b>Pembayaran berhasil</b><small>Dikirim ke channel di atas saat backend mengonfirmasi pembayaran. Pesanan dibuat, gagal, dan kedaluwarsa tidak dikirim ke Discord.</small></div><span class="pill pill--ok">Otomatis</span></div>
                ${switchRow('liveChatDm', d.liveChatDm, 'DM pesan Live Chat', 'Setiap pesan baru dari pelanggan dikirim sebagai pesan langsung ke akun Discord admin di bawah.')}
                <label class="field"><span>User ID admin</span><input name="adminUserId" inputmode="numeric" autocomplete="off" value="${d.adminUserId}" placeholder="123456789012345678" maxlength="25"><small>Admin harus satu server dengan bot dan mengizinkan pesan langsung dari anggota server.</small></label>
                <div class="form-actions"><button class="btn btn--primary" type="submit">Simpan pengaturan</button></div>
              </div>
            </section>
          </form>

          <section class="card">
            <div class="card__head"><h3>Uji koneksi</h3></div>
            <p class="card__intro">Pengujian memakai pengaturan yang sudah tersimpan dan mengirim pesan sungguhan ke Discord.</p>
            <div class="card__body stack">
              <div class="testrow">
                <div class="setting__text"><b>Notifikasi ke channel</b><small>Mengirim pesan uji ke Channel ID tersimpan.</small></div>
                <button class="btn btn--primary" type="button" data-test="test">Kirim notifikasi uji</button>
              </div>
              <div class="testrow">
                <div class="setting__text"><b>DM ke admin</b><small>Mengirim pesan uji ke User ID admin tersimpan.</small></div>
                <button class="btn" type="button" data-test="test-dm">Kirim DM uji</button>
              </div>
              <p class="inline-result" id="dc-result" role="status"></p>
              <div class="form-actions"><button class="btn" type="button" data-check>${icon('refresh')}Periksa koneksi</button>${inviteLink()}</div>
            </div>
          </section>
        </div>`);
      dirty = false;
      if (keepScroll) scrollTo(0, y);
    }
    draw(false);

    const flash = (ok, msg) => { const el = $('#dc-result', root); if (el) { el.className = `inline-result ${ok ? 'is-ok' : 'is-err'}`; el.textContent = msg; } };
    const refreshStrip = () => { const grid = $('#dc-status', root); if (grid) grid.outerHTML = statusStrip().toString(); const inv = $('#dc-invite', root); if (inv && !s.discord.connection.botId) inv.remove(); };
    const val = (form, n) => form.elements[n]?.value ?? '';
    const chk = (form, n) => Boolean(form.elements[n]?.checked);

    root.addEventListener('input', (e) => { if (e.target.closest('form[data-form]')) dirty = true; });
    root.addEventListener('change', (e) => { if (e.target.closest('form[data-form]')) dirty = true; });

    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target.closest('form[data-form]');
      if (!form) return;
      const body = { enabled: chk(form, 'enabled'), token: val(form, 'token').trim(), clearToken: chk(form, 'clearToken'), guildId: val(form, 'guildId').trim(), channelId: val(form, 'channelId').trim(), adminUserId: val(form, 'adminUserId').trim(), liveChatDm: chk(form, 'liveChatDm') };
      try {
        const res = await busy($('button[type="submit"]', form), () => api.put('/integrations/discord', body));
        s = res.settings; draw();
        toast('Pengaturan Discord disimpan', { detail: 'Backend langsung memakai pengaturan terbaru.' });
      } catch (err) {
        if (!fieldErrors(form, err.fields || {})) toastError(err); else toast(err.message, { type: 'error' });
      }
    });

    root.addEventListener('click', async (e) => {
      const test = e.target.closest('[data-test]');
      const check = e.target.closest('[data-check]');
      if (!test && !check) return;
      if (dirty) { toast('Simpan perubahan terlebih dahulu', { type: 'error', detail: 'Pengujian memakai pengaturan yang sudah tersimpan.' }); return; }
      flash(true, '');
      try {
        if (check) {
          const r = await busy(check, () => api.post('/integrations/discord/check'));
          s = r.settings; refreshStrip(); flash(true, r.message); toast('Bot terhubung', { detail: r.message });
        } else {
          const r = await busy(test, () => api.post(`/integrations/discord/${test.dataset.test}`));
          flash(true, r.message); toast('Terkirim ke Discord', { detail: r.message });
        }
      } catch (err) {
        flash(false, err.message); toast(err.message, { type: 'error' });
        try { s = (await api.get('/integrations')).settings; refreshStrip(); } catch { /* status akan menyusul lewat realtime */ }
      }
    });

    return {
      destroy() { alive = false; },
      // Realtime: status selalu diperbarui; isian hanya digambar ulang bila tidak ada perubahan yang sedang diketik
      onLive(evt, payload) {
        if (!alive || evt !== 'integrations:update') return;
        s = payload; refreshStrip();
        if (!dirty && (!root.contains(document.activeElement) || document.activeElement === document.body)) draw();
      },
    };
  },
};
