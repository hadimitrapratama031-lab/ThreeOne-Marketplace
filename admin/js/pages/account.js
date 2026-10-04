import { $, html, mount, dateTime, toast, toastError, busy, fieldErrors } from '../ui.js';
import { auth } from '../api.js';

export default {
  async mount(root, ctx) {
    const a = ctx.admin;
    mount(root, html`
      <div class="page-head"><div><h2>Akun admin</h2><p>Terakhir masuk ${dateTime(a.lastLoginAt)}.</p></div></div>
      <div class="stack" style="max-width:620px">
        <form class="card" id="profile" novalidate>
          <div class="card__head"><h3>Profil</h3></div>
          <div class="card__body stack">
            <label class="field"><span>Nama</span><input name="name" value="${a.name}" maxlength="60" required></label>
            <label class="field"><span>Email (untuk login)</span><input name="email" type="email" value="${a.email}" maxlength="120" required autocomplete="username"></label>
            <div class="actions"><button class="btn btn--primary" type="submit">Simpan profil</button></div>
          </div>
        </form>
        <form class="card" id="password" novalidate>
          <div class="card__head"><h3>Ganti password</h3></div>
          <div class="card__body stack">
            <label class="field"><span>Password saat ini</span><input name="currentPassword" type="password" autocomplete="current-password" required></label>
            <label class="field"><span>Password baru</span><input name="newPassword" type="password" autocomplete="new-password" minlength="10" required><small>Minimal 10 karakter. Perangkat lain akan otomatis keluar.</small></label>
            <div class="actions"><button class="btn btn--primary" type="submit">Ganti password</button></div>
          </div>
        </form>
      </div>`);

    $('#profile', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const { admin } = await busy($('button', f), () => auth.updateProfile({ name: f.elements.name.value, email: f.elements.email.value }));
        Object.assign(ctx.admin, admin);
        $('#account-name').textContent = admin.name; $('#account-email').textContent = admin.email; $('#account-avatar').textContent = admin.name[0].toUpperCase();
        toast('Profil disimpan');
      } catch (err) { if (!fieldErrors(f, err.fields)) toastError(err); }
    });
    $('#password', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await busy($('button', f), () => auth.changePassword({ currentPassword: f.elements.currentPassword.value, newPassword: f.elements.newPassword.value }));
        f.reset(); toast('Password diganti', { detail: 'Sesi di perangkat lain telah dikeluarkan.' });
      } catch (err) { if (!fieldErrors(f, err.fields)) toastError(err); }
    });
    return { destroy() {}, onLive() {} };
  },
};
