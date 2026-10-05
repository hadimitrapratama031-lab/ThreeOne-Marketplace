import { $, $$, html, raw, mount, icon, toast, toastError, busy, fieldErrors, dialog, dateTime, confirmDialog } from '../ui.js';
import { api } from '../api.js';

const EVENTS = [
  ['orderCreated', 'Pesanan dibuat', 'Dikirim begitu kode QRIS berhasil dibuat dan pesanan menunggu pembayaran.'],
  ['paymentSuccess', 'Pembayaran berhasil', 'Dikirim saat backend mengonfirmasi pembayaran SUCCESS/PAID dari KlikQRIS.'],
  ['paymentFailed', 'Pembayaran gagal', 'Dikirim bila transaksi tidak dapat dibuat di gateway.'],
  ['paymentExpired', 'Pembayaran kedaluwarsa', 'Dikirim saat batas waktu 10 menit habis atau KlikQRIS menyatakan EXPIRED.'],
];

/** Pengaturan Resend (email), Fonnte (WhatsApp), kejadian notifikasi, dan template. Rahasia tidak pernah dikembalikan server. */
export default {
  async mount(root) {
    let s = (await api.get('/integrations')).settings;
    let tab = 'email';
    let alive = true;

    const stateOf = (p) => (!p.configured ? ['Belum dikonfigurasi', 'pill--mute'] : !p.enabled ? ['Nonaktif', 'pill--warn'] : ['Aktif', 'pill--ok']);
    const testLine = (p) => (p.lastTest.status === 'untested' ? 'Belum pernah diuji.' : `${p.lastTest.status === 'success' ? 'Uji terakhir berhasil' : 'Uji terakhir gagal'} · ${dateTime(p.lastTest.at)}${p.lastTest.status === 'error' && p.lastTest.message ? ` — ${p.lastTest.message}` : ''}`);

    const statusStrip = () => html`
      <div class="status-grid" id="status-grid">
        ${[['Email', 'Resend', 'mail', s.resend], ['WhatsApp', 'Fonnte', 'chat', s.fonnte]].map(([label, name, ic, p]) => html`
          <div class="prov"><span class="prov__icon">${icon(ic)}</span><b>${label} · ${name}</b><span class="pill ${stateOf(p)[1]}">${stateOf(p)[0]}</span><small>${testLine(p)}</small></div>`)}
      </div>`;

    const switchRow = (name, checked, title, desc) => html`
      <div class="setting"><div class="setting__text"><b>${title}</b><small>${desc}</small></div>
        <label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><i></i><span class="sr-only">${title}</span></label></div>`;

    const resendPane = () => { const r = s.resend; return html`
      <form class="card" data-form="resend" novalidate>
        <div class="card__head"><h3>Koneksi Resend</h3></div><p class="card__intro">Provider email transaksional. Email dikirim dari backend; API key disimpan terenkripsi dan tidak pernah ditampilkan lagi.</p>
        <div class="card__body stack">
          ${switchRow('enabled', r.enabled, 'Aktifkan pengiriman email', 'Email ke pembeli hanya dikirim bila ini aktif.')}
          <label class="field"><span>API key</span><input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${r.apiKeySet ? (r.apiKeyReadable ? `Tersimpan ${r.apiKeyHint} — kosongkan bila tidak diganti` : 'Tidak terbaca — isi ulang') : r.fromEnv ? 'Memakai nilai dari environment server' : 're_…'}"><small>Buat di dashboard Resend → API Keys.</small></label>
          ${r.apiKeySet ? html`<label class="switch"><input type="checkbox" name="clearApiKey"><i></i>Hapus API key tersimpan</label>` : ''}
          <div class="grid-2">
            <label class="field"><span>Email pengirim</span><input name="fromEmail" type="email" value="${r.fromEmail}" placeholder="noreply@domaintoko.com" maxlength="120"><small>Wajib memakai domain toko yang sudah diverifikasi di Resend. Gmail/Yahoo/Outlook ditolak.</small></label>
            <label class="field"><span>Nama pengirim</span><input name="fromName" value="${r.fromName}" placeholder="Nama toko" maxlength="80"><small>Nama yang tampil di inbox pembeli.</small></label>
          </div>
          <label class="field"><span>Reply-To (opsional)</span><input name="replyTo" type="email" value="${r.replyTo}" placeholder="admin@domaintoko.com" maxlength="120"><small>Kosong = header Reply-To tidak dikirim.</small></label>
          <div class="testrow">
            <label class="field"><span>Kirim email uji ke</span><input name="testTo" type="email" value="${r.testTo}" placeholder="emailanda@contoh.com" maxlength="120"></label>
            <button class="btn" type="button" data-test="resend">Kirim email uji</button>
          </div>
          <p class="inline-result" id="resend-result" role="status"></p>
          <div class="form-actions"><button class="btn btn--primary" type="submit">Simpan Resend</button></div>
        </div>
        <input type="hidden" name="_" value="">
      </form>

      <section class="card">
        <div class="card__head"><h3>Status pengiriman (webhook)</h3></div><p class="card__intro">Opsional. Resend melaporkan apakah email benar-benar sampai (delivered), memantul, atau ditandai spam. Hasilnya tampil di Log Notifikasi.</p>
        <form class="card__body stack" data-form="resend-hook" novalidate>
          <div><span class="muted">URL webhook — daftarkan di Resend → Webhooks (event: delivered, bounced, complained, delivery_delayed)</span>
            <div class="copybox" style="margin-top:8px"><code id="hook-url">${r.webhookUrl}</code><button class="btn btn--sm" type="button" data-copy="#hook-url">${icon('copy')}Salin</button></div></div>
          <label class="field"><span>Signing secret</span><input name="webhookSecret" type="password" autocomplete="new-password" spellcheck="false" placeholder="${r.webhookSecretSet ? `Tersimpan ${r.webhookSecretHint || ''} — kosongkan bila tidak diganti` : 'whsec_…'}"><small>Dipakai memverifikasi signature. Webhook tanpa secret diabaikan.</small></label>
          ${r.webhookSecretSet ? html`<label class="switch"><input type="checkbox" name="clearWebhookSecret"><i></i>Hapus signing secret</label>` : ''}
          <div class="form-actions"><button class="btn" type="submit">Simpan secret</button></div>
        </form>
      </section>

      <section class="card">
        <div class="card__head"><h3>Verifikasi domain</h3><button class="btn btn--sm" type="button" data-domains>${icon('refresh')}Periksa domain</button></div>
        <p class="card__intro">Status SPF/DKIM/DMARC apa adanya dari Resend, untuk menjawab “kenapa email masuk Spam?”.</p>
        <div class="card__body"><div class="dns" id="domains"><span class="muted">Klik “Periksa domain” untuk memuat dari Resend.</span></div></div>
      </section>`; };

    const fonntePane = () => { const f = s.fonnte; return html`
      <form class="card" data-form="fonnte" novalidate>
        <div class="card__head"><h3>Koneksi Fonnte</h3></div><p class="card__intro">Provider WhatsApp untuk notifikasi ke pembeli. Token disimpan terenkripsi dan tidak pernah ditampilkan lagi.</p>
        <div class="card__body stack">
          ${switchRow('enabled', f.enabled, 'Aktifkan pengiriman WhatsApp', 'Pesan WhatsApp ke pembeli hanya dikirim bila ini aktif.')}
          <label class="field"><span>Token Fonnte</span><input name="token" type="password" autocomplete="new-password" spellcheck="false" placeholder="${f.tokenSet ? (f.tokenReadable ? `Tersimpan ${f.tokenHint} — kosongkan bila tidak diganti` : 'Tidak terbaca — isi ulang') : f.fromEnv ? 'Memakai nilai dari environment server' : 'Tempel token dari dashboard Fonnte'}"><small>Ambil dari dashboard Fonnte → Device. Pastikan device terhubung.</small></label>
          ${f.tokenSet ? html`<label class="switch"><input type="checkbox" name="clearToken"><i></i>Hapus token tersimpan</label>` : ''}
          <div class="testrow">
            <label class="field"><span>Nomor tujuan uji</span><input name="testTarget" type="tel" inputmode="tel" value="${f.testTarget ? '+' + f.testTarget : ''}" placeholder="0812 3456 7890" maxlength="25"><small>Nomor Anda sendiri untuk memastikan token berfungsi. 08… otomatis menjadi +62….</small></label>
            <button class="btn" type="button" data-test="fonnte">Kirim pesan uji</button>
          </div>
          <p class="inline-result" id="fonnte-result" role="status"></p>
          <div class="form-actions"><button class="btn btn--primary" type="submit">Simpan Fonnte</button></div>
        </div>
      </form>
      <section class="card"><div class="card__body"><p class="muted">Nomor tujuan notifikasi pesanan adalah nomor WhatsApp yang diisi pembeli di Checkout. Nomor WhatsApp Admin untuk tombol “Hubungi Admin” diatur di menu Penjualan → Pembayaran.</p></div></section>`; };

    const tplCard = ([key, title]) => { const wa = s.templates.whatsapp[key]; const em = s.templates.email[key]; const custom = Boolean(wa.trim() || em.subject.trim() || em.html.trim()); return html`
      <details class="tpl" data-tpl="${key}">
        <summary><span>${title}</span><span class="pill ${custom ? '' : 'pill--mute'}">${custom ? 'Kustom' : 'Bawaan'}</span></summary>
        <div class="tpl__body">
          <label class="field"><span>Pesan WhatsApp</span><textarea class="mono" name="wa" rows="6" maxlength="4000" placeholder="Kosong = template bawaan">${wa}</textarea></label>
          <label class="field"><span>Subject email</span><input name="subject" value="${em.subject}" maxlength="200" placeholder="Kosong = subject bawaan"></label>
          <label class="field"><span>HTML email</span><textarea class="mono" name="html" rows="8" maxlength="60000" placeholder="Kosong = desain email bawaan">${em.html}</textarea></label>
        </div>
      </details>`; };

    const notifPane = () => html`
      <form class="card" data-form="notifications" novalidate>
        <div class="card__head"><h3>Kanal & kejadian</h3></div><p class="card__intro">Pilih kanal dan momen yang memicu notifikasi otomatis. Setiap kejadian dikirim sekali per pesanan dan per kanal, walau webhook atau halaman dimuat ulang.</p>
        <div class="card__body stack">
          ${switchRow('whatsappEnabled', s.notifications.whatsappEnabled, 'Kanal WhatsApp', 'Saklar utama seluruh pesan WhatsApp keluar.')}
          ${switchRow('emailEnabled', s.notifications.emailEnabled, 'Kanal Email', 'Saklar utama seluruh email keluar.')}
          ${EVENTS.map(([k, title, desc]) => switchRow(`ev_${k}`, s.notifications.events[k], title, desc))}
          <div class="form-actions"><button class="btn btn--primary" type="submit">Simpan notifikasi</button></div>
        </div>
      </form>
      <form class="card" data-form="templates" novalidate>
        <div class="card__head"><h3>Template pesan</h3></div><p class="card__intro">Template bawaan dari Marketplace lama dipakai selama kolom kosong. Isi hanya bila ingin menggantinya. Placeholder: {{customer_name}} {{order_code}} {{product_name}} {{total}} {{payment_status}} {{payment_method}} {{store_name}} {{ordered_at}} {{paid_at}} {{expired_at}} {{pay_url}} {{wa_admin_url}}</p>
        <div class="card__body stack">
          ${EVENTS.map(tplCard)}
          <div class="form-actions">
            <button class="btn btn--primary" type="submit">Simpan template</button>
            <button class="btn" type="button" data-preview>Pratinjau</button>
            <button class="btn btn--danger" type="button" data-reset-tpl>Kembalikan ke bawaan</button>
          </div>
        </div>
      </form>`;

    function draw(keepScroll = true) {
      const y = scrollY;
      mount(root, html`
        <div class="page-head"><div><h2>Email & WhatsApp</h2><p>Atur Resend dan Fonnte untuk notifikasi otomatis pesanan. Perubahan langsung dipakai backend setelah disimpan.</p></div></div>
        <div class="integ">
          ${statusStrip()}
          <div class="tabs" role="tablist" aria-label="Integrasi">
            ${[['email', 'Email · Resend'], ['wa', 'WhatsApp · Fonnte'], ['notif', 'Notifikasi & template']].map(([id, label]) => html`<button type="button" role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}</button>`)}
          </div>
          <div class="pane" data-pane="email" ${tab === 'email' ? '' : 'hidden'}>${resendPane()}</div>
          <div class="pane" data-pane="wa" ${tab === 'wa' ? '' : 'hidden'}>${fonntePane()}</div>
          <div class="pane" data-pane="notif" ${tab === 'notif' ? '' : 'hidden'}>${notifPane()}</div>
        </div>`);
      if (keepScroll) scrollTo(0, y);
    }
    draw(false);

    const flash = (id, ok, msg) => { const el = $(id, root); if (el) { el.className = `inline-result ${ok ? 'is-ok' : 'is-err'}`; el.textContent = msg; } };
    const val = (form, n) => form.elements[n]?.value ?? '';
    const chk = (form, n) => Boolean(form.elements[n]?.checked);

    const BODY = {
      resend: (f) => ({ enabled: chk(f, 'enabled'), apiKey: val(f, 'apiKey').trim(), clearApiKey: chk(f, 'clearApiKey'), fromEmail: val(f, 'fromEmail').trim(), fromName: val(f, 'fromName').trim(), replyTo: val(f, 'replyTo').trim(), testTo: val(f, 'testTo').trim() }),
      'resend-hook': (f) => ({ ...BODY.resend($('[data-form="resend"]', root)), webhookSecret: val(f, 'webhookSecret').trim(), clearWebhookSecret: chk(f, 'clearWebhookSecret') }),
      fonnte: (f) => ({ enabled: chk(f, 'enabled'), token: val(f, 'token').trim(), clearToken: chk(f, 'clearToken'), testTarget: val(f, 'testTarget').trim() }),
      notifications: (f) => ({ whatsappEnabled: chk(f, 'whatsappEnabled'), emailEnabled: chk(f, 'emailEnabled'), events: Object.fromEntries(EVENTS.map(([k]) => [k, chk(f, `ev_${k}`)])) }),
      templates: (f) => ({
        whatsapp: Object.fromEntries($$('[data-tpl]', f).map((d) => [d.dataset.tpl, $('[name=wa]', d).value])),
        email: Object.fromEntries($$('[data-tpl]', f).map((d) => [d.dataset.tpl, { subject: $('[name=subject]', d).value, html: $('[name=html]', d).value }])),
      }),
    };
    const URL_OF = { resend: '/integrations/resend', 'resend-hook': '/integrations/resend', fonnte: '/integrations/fonnte', notifications: '/integrations/notifications', templates: '/integrations/templates' };

    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target.closest('form[data-form]');
      if (!form) return;
      const kind = form.dataset.form;
      try {
        const res = await busy($('button[type="submit"]', form), () => api.put(URL_OF[kind], BODY[kind](form)));
        s = res.settings; draw();
        toast('Pengaturan disimpan', { detail: 'Backend langsung memakai pengaturan terbaru.' });
      } catch (err) {
        const map = { token: 'token', apiKey: 'apiKey', fromEmail: 'fromEmail', replyTo: 'replyTo', testTo: 'testTo', testTarget: 'testTarget' };
        const fields = Object.fromEntries(Object.entries(err.fields || {}).map(([k, v]) => [map[k] || k, v]));
        if (!fieldErrors(form, fields)) toastError(err); else toast(err.message, { type: 'error' });
      }
    });

    root.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) { tab = t.dataset.tab; $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b === t))); $$('[data-pane]', root).forEach((p) => { p.hidden = p.dataset.pane !== tab; }); return; }

      const cp = e.target.closest('[data-copy]');
      if (cp) { try { await navigator.clipboard.writeText($(cp.dataset.copy, root).textContent); toast('URL webhook disalin'); } catch { toast('Salin manual dari kotak', { type: 'error' }); } return; }

      const test = e.target.closest('[data-test]');
      if (test) {
        const which = test.dataset.test;
        const form = $(`[data-form="${which}"]`, root);
        const id = `#${which}-result`;
        flash(id, true, '');
        try {
          const body = which === 'fonnte' ? { testTarget: val(form, 'testTarget').trim() } : { testTo: val(form, 'testTo').trim() };
          const r = await busy(test, () => api.post(`/integrations/${which}/test`, body));
          flash(id, true, r.message);
        } catch (err) { flash(id, false, err.message); }
        return;
      }

      const dom = e.target.closest('[data-domains]');
      if (dom) {
        const box = $('#domains', root);
        try {
          const r = await busy(dom, () => api.get('/integrations/resend/domain-status'));
          box.innerHTML = (r.domains.length ? r.domains.map((d) => html`
            <div><b>${d.name}</b> <span class="pill ${d.status === 'verified' ? 'pill--ok' : 'pill--warn'}">${d.status}</span> ${d.isSendingDomain ? html`<span class="pill">Domain pengirim</span>` : ''}
              <div class="table-wrap"><table><thead><tr><th>Record</th><th>Tipe</th><th>Nama</th><th>Nilai</th><th>Status</th></tr></thead>
              <tbody>${d.records.map((x) => html`<tr><td>${x.record}</td><td>${x.type}</td><td><code>${x.name}</code></td><td><code>${x.value}</code></td><td><span class="pill ${x.status === 'verified' ? 'pill--ok' : 'pill--warn'}">${x.status}</span></td></tr>`)}</tbody></table></div></div>`) : [html`<span class="muted">Belum ada domain terdaftar di akun Resend ini.</span>`]).map((h) => h.toString()).join('');
        } catch (err) { box.innerHTML = html`<span class="inline-result is-err">${err.message}</span>`.toString(); }
        return;
      }

      if (e.target.closest('[data-preview]')) {
        try {
          const p = await api.get('/integrations/preview');
          const d = dialog({ kind: 'drawer', title: 'Pratinjau template', body: html`<div class="preview">
            <p class="muted">${p.usingSample ? 'Memakai data contoh (bukan pesanan sungguhan). ' : ''}Pratinjau tidak mengirim apa pun.</p>
            ${p.events.map((ev) => html`<section class="stack"><h3>${(EVENTS.find((x) => x[0] === ev.event) || [])[1]} <span class="pill pill--mute">${ev.whatsapp.source === 'custom' ? 'WA kustom' : 'WA bawaan'}</span> <span class="pill pill--mute">${ev.email.source === 'custom' ? 'Email kustom' : 'Email bawaan'}</span></h3>
              <pre>${ev.whatsapp.text}</pre><b>${ev.email.subject}</b><iframe sandbox="" title="Pratinjau email ${ev.event}" srcdoc="${ev.email.html}"></iframe></section>`)}
          </div>`, foot: html`<button type="button" class="btn" data-close>Tutup</button>` });
          void d;
        } catch (err) { toastError(err); }
        return;
      }

      if (e.target.closest('[data-reset-tpl]')) {
        if (!(await confirmDialog({ title: 'Kembalikan template ke bawaan?', message: 'Semua template kustom WhatsApp dan Email dikosongkan. Pesan akan memakai template bawaan.', confirmLabel: 'Kembalikan', danger: true }))) return;
        const blank = { whatsapp: Object.fromEntries(EVENTS.map(([k]) => [k, ''])), email: Object.fromEntries(EVENTS.map(([k]) => [k, { subject: '', html: '' }])) };
        try { s = (await api.put('/integrations/templates', blank)).settings; draw(); toast('Template dikembalikan ke bawaan'); } catch (err) { toastError(err); }
      }
    });

    return {
      destroy() { alive = false; },
      // Sinkron antar admin: hanya strip status yang diperbarui supaya isian yang sedang diketik tidak hilang
      onLive(evt, payload) {
        if (!alive || evt !== 'integrations:update') return;
        s = payload;
        const grid = $('#status-grid', root);
        if (grid) grid.outerHTML = statusStrip().toString();
      },
    };
  },
};
