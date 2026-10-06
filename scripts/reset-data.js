/**
 * Hapus data Marketplace (MongoDB + gambar di Cloudflare R2) sebelum migrasi dari project lama.
 *
 *   node scripts/reset-data.js                    → DRY-RUN: hanya menampilkan apa yang akan dihapus
 *   node scripts/reset-data.js --apply            → hapus (harus mengetik nama database untuk konfirmasi)
 *
 * Yang DIHAPUS (default): produk, kategori, rating/ulasan, pesanan, log notifikasi, penghitung ID produk,
 * dan SEMUA gambar/video yang terdaftar (produk, ulasan, dan file sementara/yatim).
 * Yang DIPERTAHANKAN (default): akun admin, pengaturan (branding, hero, pembayaran KlikQRIS, Resend, Fonnte, dst.)
 * beserta gambar milik pengaturan itu (logo & cover), FAQ, dan kontak.
 *
 * Opsi: --include-content (hapus juga FAQ & kontak) · --include-settings (hapus pengaturan + logo/cover)
 *       --include-admins (hapus akun admin; dibuat ulang dari ADMIN_EMAIL/ADMIN_PASSWORD saat server start)
 *       --keep-images (jangan sentuh R2) · --yes=<nama-database> (konfirmasi tanpa prompt)
 * JANGAN dijalankan saat server hidup. Buat backup (mongodump) terlebih dahulu.
 */
import mongoose from 'mongoose';
import { config, r2Configured } from '../server/config/env.js';
import { Product, Category, Review, Order, NotificationLog, Counter, Asset, Faq, Contact, Setting, Admin } from '../server/models/index.js';
import { deleteObjects } from '../server/lib/r2.js';
import { parseArgs, ask, line, rowOut, hostOf } from './_common.js';

const { flags, values } = parseArgs();
const APPLY = flags.has('apply');
const wipe = [
  ['Produk', Product], ['Kategori', Category], ['Rating / ulasan', Review], ['Pesanan', Order],
  ['Log notifikasi', NotificationLog], ['Penghitung ID (produk)', Counter],
];
if (flags.has('include-content')) wipe.push(['FAQ', Faq], ['Kontak', Contact]);
if (flags.has('include-settings')) wipe.push(['Pengaturan (termasuk kredensial pembayaran/Resend/Fonnte)', Setting]);
if (flags.has('include-admins')) wipe.push(['Akun admin', Admin]);

if (!config.mongoUri) { console.error('MONGODB_URI belum diisi di .env'); process.exit(1); }
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
const dbName = mongoose.connection.name;

const assetFilter = flags.has('include-settings') ? {} : { 'owner.type': { $ne: 'settings' } };
const keepImages = flags.has('keep-images');
const keys = keepImages ? [] : (await Asset.find(assetFilter).select('key').lean()).map((a) => a.key);

line('='); console.log(APPLY ? 'RESET DATA — MODE HAPUS' : 'RESET DATA — DRY-RUN (tidak ada yang dihapus)'); line('=');
rowOut('MongoDB host', hostOf(config.mongoUri)); rowOut('Nama database', dbName);
rowOut('R2 bucket', keepImages ? '(dilewati: --keep-images)' : r2Configured() ? config.r2.bucket : '(R2 belum dikonfigurasi)');
console.log('\nAkan dihapus:');
for (const [label, M] of wipe) rowOut(label, `${await M.countDocuments({})} dokumen`);
rowOut('Gambar/video di R2', `${keys.length} file`);
console.log('\nDipertahankan:');
for (const [label, M, flag] of [['Akun admin', Admin, 'include-admins'], ['Pengaturan', Setting, 'include-settings'], ['FAQ', Faq, 'include-content'], ['Kontak', Contact, 'include-content']]) {
  if (!flags.has(flag)) rowOut(label, `${await M.countDocuments({})} dokumen`);
}
if (!flags.has('include-settings') && !keepImages) rowOut('Gambar logo/cover pengaturan', `${await Asset.countDocuments({ 'owner.type': 'settings' })} file`);
line();

if (!keepImages && keys.length && !r2Configured()) { console.error('R2 belum dikonfigurasi di .env sehingga gambar tidak bisa dihapus. Lengkapi R2_*, atau jalankan dengan --keep-images.'); await mongoose.disconnect(); process.exit(1); }
if (!APPLY) { console.log('Dry-run selesai. Tambahkan --apply untuk benar-benar menghapus.'); await mongoose.disconnect(); process.exit(0); }

console.log('PERINGATAN: penghapusan TIDAK BISA dibatalkan. Pastikan server berhenti dan backup sudah dibuat.');
const typed = values.yes ?? (await ask(`Ketik nama database "${dbName}" untuk melanjutkan: `));
if (typed !== dbName) { console.error('Konfirmasi tidak cocok. Dibatalkan, tidak ada yang dihapus.'); await mongoose.disconnect(); process.exit(1); }

let failedKeys = [];
if (keys.length) {
  const { deleted, failed } = await deleteObjects(keys);
  failedKeys = failed;
  await Asset.deleteMany({ key: { $in: deleted } });
  rowOut('Gambar dihapus dari R2', `${deleted.length} dari ${keys.length}`);
  if (failed.length) console.warn(`  ${failed.length} file gagal dihapus (tetap tercatat; jalankan ulang script ini untuk mencoba lagi).`);
}
for (const [label, M] of wipe) { const r = await M.deleteMany({}); rowOut(label, `${r.deletedCount} dihapus`); }
line();
console.log(failedKeys.length ? 'Selesai dengan peringatan di atas.' : 'Selesai. Data bersih; lanjutkan dengan: npm run migrate:old');
await mongoose.disconnect();
