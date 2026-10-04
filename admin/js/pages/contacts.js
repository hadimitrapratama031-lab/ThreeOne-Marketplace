import { html, icon, raw } from '../ui.js';
import { listPage } from './_list.js';

const ICONS = { whatsapp: 'WhatsApp', discord: 'Discord', email: 'Email', telegram: 'Telegram', phone: 'Telepon', link: 'Tautan lain' };
const PATHS = {
  whatsapp: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z', discord: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  email: 'M3 7l9 6 9-6M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', telegram: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
};

export default listPage({
  endpoint: '/contacts',
  liveMatch: /^contact:/,
  heading: 'Kontak',
  description: 'Kartu kontak di bagian “Hubungi Kami”. Tautan membuat kartunya bisa diklik.',
  addLabel: 'Tambah kontak',
  editTitle: 'Ubah kontak',
  addedMessage: 'Kontak ditambahkan',
  emptyTitle: 'Belum ada kontak',
  emptyText: 'Bagian kontak disembunyikan di Marketplace selama daftar ini kosong.',
  emptyIcon: 'chat',
  rowIcon: (c) => raw(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${PATHS[c.icon] || PATHS.link}"/></svg>`),
  rowMain: (c) => html`<b>${c.label}</b><p>${c.value}${c.href ? ` · ${c.href}` : ' · tanpa tautan'}</p>`,
  deleteTitle: 'Hapus kontak?',
  deleteMessage: (c) => `Kontak “${c.label}” akan dihapus dari Marketplace.`,
  fields: (c) => html`
    <div class="grid-2">
      <label class="field"><span>Nama</span><input name="label" value="${c?.label ?? ''}" maxlength="40" placeholder="WhatsApp" required></label>
      <label class="field"><span>Ikon</span><select name="icon">${Object.entries(ICONS).map(([k, v]) => html`<option value="${k}" ${(c?.icon ?? 'link') === k ? 'selected' : ''}>${v}</option>`)}</select></label>
    </div>
    <label class="field"><span>Teks yang ditampilkan</span><input name="value" value="${c?.value ?? ''}" maxlength="120" placeholder="+62 812-0000-0000" required></label>
    <label class="field"><span>Tautan</span><input name="href" value="${c?.href ?? ''}" maxlength="300" placeholder="https://wa.me/628120000000"><small>Boleh https://, mailto:, atau tel:. Kosongkan bila kartu tidak perlu diklik.</small></label>`,
  read: (form) => ({ label: form.elements.label.value, value: form.elements.value.value, href: form.elements.href.value, icon: form.elements.icon.value }),
});
