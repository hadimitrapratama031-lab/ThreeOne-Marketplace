import { $, html, mount, icon, toast, toastError, busy, fieldErrors, dateTime } from '../ui.js';
import { api } from '../api.js';
import { chatCore } from '../chatCore.js';

/**
 * Pengaturan Live Chat. Disimpan di MongoDB dan dibaca backend pada setiap pesan (tanpa cache), jadi perubahan langsung berlaku.
 * WhatsApp memakai integrasi Fonnte yang sama dengan notifikasi pesanan: token diatur di menu Email & WhatsApp, bukan di sini.
 */
const COOLDOWNS = [[0, 'Kirim untuk setiap pesan'], [30, 'Maksimal satu per 30 detik'], [60, 'Maksimal satu per menit'], [300, 'Maksimal satu per 5 menit']];

export default {
  async mount(root) {
    let s = (await api.get('/livechat/settings')).settings;
    let alive = true;

    const fonnteState = () => (!s.fonnte.configured ? ['Belum dikonfigurasi', 'pill--mute'] : !s.fonnte.enabled ? ['Nonaktif', 'pill--warn'] : ['Aktif', 'pill--ok']);
    const testLine = () => (s.lastTest.status === 'untested' ? 'Pesan uji belum pernah dikirim.' : `${s.lastTest.status === 'success' ? 'Uji terakhir berhasil' : 'Uji terakhir gagal'}, ${dateTime(s.lastTest.at)}${s.lastTest.status === 'error' && s.lastTest.message ? `. ${s.lastTest.message}` : ''}`);
    const row = (name, checked, title, desc) => html`
      <div class="setting"><div class="setting__text"><b>${title}</b><small>${desc}</small></div>
        <label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><i></i><span class="sr-only">${title}</span></label></div>`;

    function draw() {
      const [fl, fc] = fonnteState();
      mount(root, html`
        <div class="page-head"><div><h2>Pengaturan Live Chat</h2><p>Atur ketersediaan Live Chat di Marketplace dan notifikasi WhatsApp untuk admin. Perubahan langsung dipakai setelah disimpan.</p></div></div>

        <div class="status-grid" style="margin-bottom:18px">
          <div class="prov"><span class="prov__icon">${icon('chat')}</span><b>Live Chat Marketplace</b><span class="pill ${s.enabled ? 'pill--ok' : 'pill--mute'}">${s.enabled ? 'Aktif' : 'Nonaktif'}</span><small>${s.enabled ? 'Ikon Live Chat tampil di semua halaman Marketplace.' : 'Ikon Live Chat disembunyikan dari pelanggan.'}</small></div>
          <div class="prov"><span class="prov__icon">${icon('plug')}</span><b>WhatsApp · Fonnte</b><span class="pill ${fc}">${fl}</span><small>${testLine()}</small></div>
        </div>

        <form class="stack" id="lc-form" style="max-width:820px" novalidate>
          <section class="card"><div class="card__head"><h3>Ketersediaan</h3></div>
            <div class="card__body">
              ${row('enabled', s.enabled, 'Aktifkan Live Chat', 'Bila dimatikan, ikon hilang dari Marketplace dan pelanggan tidak bisa memulai atau melanjutkan percakapan. Percakapan yang sudah ada tetap tersimpan sampai berakhir.')}
            </div></section>

          <section class="card"><div class="card__head"><h3>Notifikasi WhatsApp admin</h3></div>
            <p class="card__intro">Admin menerima WhatsApp saat ada percakapan atau pesan pelanggan baru, berisi nama, nomor pelanggan (bila diisi), cuplikan pesan, ID percakapan, dan tautan ke Live Chat Admin. Kegagalan kirim tidak memengaruhi percakapan.</p>
            <div class="card__body stack">
              ${!s.fonnte.configured ? html`<p class="form-error" role="status">Token Fonnte belum diisi. <a href="#/integrations">Isi di menu Email & WhatsApp</a> agar notifikasi bisa terkirim.</p>` : !s.fonnte.enabled ? html`<p class="form-error" role="status">Fonnte belum diaktifkan. <a href="#/integrations">Aktifkan di menu Email & WhatsApp</a>.</p>` : ''}
              <label class="field"><span>Nomor WhatsApp admin</span><input name="waNumber" inputmode="tel" maxlength="25" value="${s.waNumber ? `+${s.waNumber}` : ''}" placeholder="0812 3456 7890" autocomplete="off"><small>Nomor tujuan notifikasi Live Chat. Format 08… otomatis menjadi +62…. Kosong = tidak ada notifikasi WhatsApp.</small></label>
              ${row('notifyNewConversation', s.notifyNewConversation, 'Percakapan baru', 'Kirim saat pelanggan mengisi nama dan memulai Live Chat.')}
              ${row('notifyNewMessage', s.notifyNewMessage, 'Pesan pelanggan baru', 'Kirim saat pelanggan mengirim teks atau gambar.')}
              <label class="field"><span>Frekuensi notifikasi pesan</span>
                <select name="messageCooldownSec">${COOLDOWNS.map(([v, l]) => html`<option value="${v}" ${v === s.messageCooldownSec ? 'selected' : ''}>${l}</option>`)}</select>
                <small>Per percakapan. Berguna bila pelanggan mengirim banyak pesan beruntun agar WhatsApp admin tidak penuh.</small></label>
              <div class="testrow">
                <div class="field"><span>Uji notifikasi</span><small>Mengirim pesan uji ke nomor admin yang sudah tersimpan.</small></div>
                <button class="btn" type="button" id="test">Kirim pesan uji</button>
              </div>
              <p class="inline-result" id="test-out" role="status"></p>
            </div></section>

          <section class="card"><div class="card__head"><h3>Suara notifikasi</h3></div>
            <div class="card__body">
              <div class="setting"><div class="setting__text"><b>Bunyikan suara saat ada pesan atau percakapan baru</b><small id="sound-hint"></small></div>
                <label class="switch"><input type="checkbox" id="sound" ${chatCore.soundOn ? 'checked' : ''}><i></i><span class="sr-only">Suara notifikasi</span></label></div>
            </div></section>

          <section class="card"><div class="card__head"><h3>Masa aktif percakapan</h3></div>
            <div class="card__body"><p class="muted">Setiap percakapan aktif <b>${s.ttlHours} jam</b> sejak waktu server saat dimulai, tidak bergeser oleh aktivitas atau pergantian tanggal. Setelah itu percakapan berstatus expired, hilang dari daftar aktif, dan riwayatnya dihapus (termasuk gambar) ${s.retentionDays === 0 ? 'segera' : `${s.retentionDays} hari kemudian`}. Masa simpan diatur lewat <code>LIVECHAT_RETENTION_DAYS</code> di server.</p></div></section>

          <div class="actions"><button class="btn btn--primary" type="submit">Simpan pengaturan</button></div>
        </form>`);
      paintSound();
    }
    function paintSound() {
      const h = $('#sound-hint', root);
      if (h) h.textContent = !chatCore.soundOn ? 'Mati di browser ini.' : chatCore.unlocked ? 'Aktif di browser ini. Pengaturan ini hanya berlaku di perangkat yang sedang dipakai.' : 'Aktif. Browser baru mengizinkan suara setelah Anda mengeklik halaman ini sekali.';
    }
    draw();
    const unsub = chatCore.subscribe(() => alive && paintSound());

    root.addEventListener('change', (e) => { if (e.target.id === 'sound') chatCore.setSound(e.target.checked); });

    root.addEventListener('click', async (e) => {
      const t = e.target.closest('#test');
      if (!t) return;
      const out = $('#test-out', root);
      out.className = 'inline-result';
      const typed = $('#lc-form', root).elements.waNumber.value.replace(/\D/g, '');
      const saved = s.waNumber;
      if (!saved || (typed && typed.replace(/^0/, '62') !== saved)) { out.textContent = 'Simpan nomor WhatsApp admin terlebih dahulu, lalu kirim pesan uji.'; out.classList.add('is-err'); return; }
      try { const r = await busy(t, () => api.post('/livechat/settings/test')); out.textContent = r.message; out.classList.add('is-ok'); } catch (err) { out.textContent = err.message; out.classList.add('is-err'); }
    });

    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const body = { enabled: f.enabled.checked, waNumber: f.waNumber.value.trim(), notifyNewConversation: f.notifyNewConversation.checked, notifyNewMessage: f.notifyNewMessage.checked, messageCooldownSec: Number(f.messageCooldownSec.value) };
      try {
        s = (await busy($('button[type="submit"]', e.target), () => api.put('/livechat/settings', body))).settings;
        draw();
        toast('Pengaturan Live Chat disimpan', { detail: s.enabled ? 'Live Chat aktif di Marketplace.' : 'Live Chat dinonaktifkan di Marketplace.' });
      } catch (err) { if (!fieldErrors(e.target, err.fields)) toastError(err); else toast(err.message, { type: 'error' }); }
    });

    return {
      destroy() { alive = false; unsub(); },
      async onLive(evt, payload) {
        if (evt === 'livechat:settings') { s = payload; if (!root.contains(document.activeElement) || document.activeElement === document.body) draw(); }
        else if (evt === 'integrations:update') { try { s = (await api.get('/livechat/settings')).settings; if (alive && !root.contains(document.activeElement)) draw(); } catch { /* abaikan */ } }
      },
    };
  },
};
