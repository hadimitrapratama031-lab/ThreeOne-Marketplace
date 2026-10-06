/**
 * Data awal = isi yang sebelumnya hardcoded di Marketplace (js/script.js & js/product.js),
 * dipindahkan apa adanya supaya tampilan pertama setelah deploy sama dengan prototype.
 * Semuanya bisa diubah/dihapus dari Admin Web.
 */
const seeded = (n) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

export const categories = ['Games', 'Accounts', 'Tools'];

const products = [
  ['Top Up Diamond 300', 'Games', 75000, 120, 'Isi ulang diamond instan, cukup masukkan ID akun.'],
  ['Voucher Game 100K', 'Games', 100000, 48, 'Voucher serbaguna untuk berbagai platform game.'],
  ['Gift Card Platform 250K', 'Games', 250000, 6, 'Kode gift card digital, dikirim setelah pembayaran.'],
  ['Battle Pass Season', 'Games', 129000, 0, 'Aktivasi battle pass musim berjalan langsung ke akun.'],
  ['Akun Starter Ready', 'Accounts', 89000, 35, 'Akun baru siap main, akses penuh dan garansi login.'],
  ['Akun Mid Tier Full Skin', 'Accounts', 350000, 12, 'Koleksi skin lengkap dengan level menengah.'],
  ['Akun Veteran Rare Item', 'Accounts', 780000, 3, 'Akun lama dengan item langka, diverifikasi admin.'],
  ['Akun Premium Collector', 'Accounts', 1450000, 1, 'Koleksi eksklusif, rank tinggi, garansi 7 hari.'],
  ['Lisensi Streaming Suite', 'Tools', 149000, 60, 'Software live streaming dengan overlay dan alert siap pakai.'],
  ['VPN Gaming 1 Bulan', 'Tools', 45000, 200, 'Koneksi stabil dan ping rendah untuk sesi bermain.'],
  ['Voice Changer Lifetime', 'Tools', 199000, 22, 'Lisensi sekali bayar untuk voice chat dan streaming.'],
  ['Clip Editor Pro', 'Tools', 99000, 0, 'Edit highlight gameplay cepat dengan template siap pakai.'],
];

const SPECS = {
  min: [
    ['OS', 'Windows 10 64-bit'], ['Processor', 'Intel Core i5-6600K atau AMD Ryzen 5 1600'], ['Memory', '8 GB RAM'],
    ['Graphics', 'NVIDIA GTX 1050 Ti atau AMD RX 570'], ['DirectX', 'Versi 12'], ['Storage', '100 GB ruang kosong'],
  ],
  rec: [
    ['OS', 'Windows 11 64-bit'], ['Processor', 'Intel Core i7-8700 atau AMD Ryzen 5 3600'], ['Memory', '16 GB RAM'],
    ['Graphics', 'NVIDIA RTX 2060 atau AMD RX 5600 XT'], ['DirectX', 'Versi 12'], ['Storage', '100 GB ruang kosong (SSD)'],
  ],
};
const rows = (list) => list.map(([label, value]) => ({ label, value }));

export const productFixtures = products.map(([name, category, price, stock, description], i) => {
  const id = i + 1;
  // Rumus yang sama dengan product.js lama: harga coret & jumlah terjual
  const oldPrice = Math.round(price / (1 - (10 + Math.floor(seeded(id) * 40)) / 100) / 1000) * 1000;
  const sold = Math.round((150 + seeded(id + 3) * 1850) / 10) * 10;
  return { name, category, price, oldPrice: oldPrice > price ? oldPrice : null, stock, sold, description, about: '', specs: { min: rows(SPECS.min), rec: rows(SPECS.rec), source: '' } };
});

export const faq = [
  ['Bagaimana cara membeli produk?', 'Pilih produk, klik Beli, isi data yang diminta, lalu selesaikan pembayaran. Pesanan diproses setelah pembayaran terkonfirmasi.'],
  ['Metode pembayaran apa saja yang tersedia?', 'Tersedia berbagai metode pembayaran digital. Daftar lengkapnya tampil saat checkout.'],
  ['Berapa lama proses pesanan?', 'Produk instan diproses otomatis dalam hitungan menit. Produk manual diproses admin pada jam operasional.'],
  ['Bagaimana cara mengecek status pesanan?', 'Klik Cek Pesanan di bagian atas halaman, lalu masukkan nomor pesanan Anda.'],
  ['Apa yang harus dilakukan jika ada kendala?', 'Hubungi kami lewat WhatsApp atau Discord dan sertakan nomor pesanan agar cepat ditangani.'],
].map(([question, answer]) => ({ question, answer }));

export const contacts = [
  { label: 'WhatsApp', value: '+62 812-0000-0000', href: 'https://wa.me/6281200000000', icon: 'whatsapp' },
  { label: 'Discord', value: 'discord.gg/marketplace', href: 'https://discord.gg/marketplace', icon: 'discord' },
  { label: 'Email', value: 'halo@marketplace.id', href: 'mailto:halo@marketplace.id', icon: 'email' },
];

export const settings = {
  stats: { support: '24/7' },
  productPage: {
    notes: [
      'Pesanan diproses otomatis setelah pembayaran terkonfirmasi. Detail produk dikirim lewat halaman pesanan dan email, biasanya dalam hitungan menit.',
      'Simpan nomor pesanan Anda. Jika ada kendala, hubungi kami lewat WhatsApp atau Discord agar cepat ditangani.',
    ],
    platforms: [{ icon: 'windows', label: 'Windows' }, { icon: 'steam', label: 'Steam' }, { icon: 'store', label: '31 Store' }],
    
  },
};

// Ulasan contoh (sebelumnya satu daftar yang sama tampil di semua produk). Kini milik produk #1.
export const reviews = [
  ['Rizky', 5, '2026-10-02', 'Prosesnya cepat dan game langsung bisa dimainkan.'],
  ['Dewi', 5, '2026-09-30', 'Produk sesuai deskripsi. Admin cepat membalas saat saya tanya soal aktivasi.'],
  ['Andi', 4, '2026-09-28', 'Proses pembelian cukup mudah. Pembayaran lewat QRIS langsung terkonfirmasi.'],
  ['Salsa', 5, '2026-09-25', 'Setup di PC saya lancar. Terima kasih, nanti beli lagi.'],
  ['Fajar', 5, '2026-09-22', 'Dikirim kurang dari lima menit setelah bayar. Aman dan terpercaya.'],
  ['Nadia', 4, '2026-09-19', 'Sesuai harapan. Sempat bingung di langkah aktivasi, tapi panduannya jelas.'],
  ['Bima', 5, '2026-09-15', 'Harga paling murah yang saya temukan, dan semuanya berjalan normal.'],
  ['Citra', 5, '2026-09-11', 'Pengiriman cepat, tidak ada kendala sama sekali.'],
].map(([name, stars, date, text]) => ({ name, stars, date: new Date(date), text }));
