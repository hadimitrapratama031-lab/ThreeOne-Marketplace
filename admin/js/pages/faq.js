import { html } from '../ui.js';
import { listPage } from './_list.js';

export default listPage({
  endpoint: '/faq',
  liveMatch: /^faq:/,
  heading: 'Pertanyaan umum',
  description: 'Tampil di bagian FAQ Marketplace sesuai urutan di bawah.',
  addLabel: 'Tambah pertanyaan',
  editTitle: 'Ubah pertanyaan',
  addedMessage: 'Pertanyaan ditambahkan',
  emptyTitle: 'Belum ada pertanyaan',
  emptyText: 'Bagian FAQ disembunyikan di Marketplace selama daftar ini kosong.',
  emptyIcon: 'help',
  rowMain: (f) => html`<b>${f.question}</b><p>${f.answer}</p>`,
  deleteTitle: 'Hapus pertanyaan?',
  deleteMessage: (f) => `“${f.question}” akan dihapus dari Marketplace.`,
  fields: (f) => html`
    <label class="field"><span>Pertanyaan</span><input name="question" value="${f?.question ?? ''}" maxlength="200" required></label>
    <label class="field"><span>Jawaban</span><textarea name="answer" rows="6" maxlength="2000" required>${f?.answer ?? ''}</textarea></label>`,
  read: (form) => ({ question: form.elements.question.value, answer: form.elements.answer.value }),
});
