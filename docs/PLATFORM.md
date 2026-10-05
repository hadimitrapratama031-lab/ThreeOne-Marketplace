# Dokumentasi platform

## 1. Hasil audit Marketplace (sebelum Admin dibuat)

Prototype awal: HTML/CSS/JS statis, **tanpa backend, database, R2, maupun realtime**. Semua data hardcoded di `js/script.js` dan `js/product.js`. Tema Marketplace sendiri **hitam + ungu** (dark); Admin Web memakai **putih + ungu** sesuai brief, dengan skala ungu yang sama.

Yang benar-benar ada dan dipakai: Home (hero, statistik, katalog + cari/urut/filter kategori, FAQ, kontak, footer) dan Product Detail (galeri tanpa batas jumlah (banyak gambar dan video), harga + harga coret/diskon, stok, terjual, deskripsi, persyaratan sistem, rating & ulasan berhalaman dengan foto, produk lainnya).
Yang **tidak ada**: banner/slider, checkout, pesanan, akun pelanggan, halaman Cek Pesanan. (Halaman Rating dan form kirim ulasan ditambahkan kemudian, lihat bagian 11.)

## 2. Feature inventory

`Fitur Marketplace → data → koleksi → API → halaman Admin → event Socket.IO → konsumen di Marketplace`

| Fitur | Data | Koleksi | API admin | Halaman Admin | Event | Konsumen |
|---|---|---|---|---|---|---|
| Katalog produk | nama, kategori, harga, stok, deskripsi singkat, gambar utama | `products` | `/products` | Produk | `product:create/update/delete` | Grid produk + filter |
| Detail produk | harga coret, terjual, deskripsi lengkap, persyaratan min/rec + sumber, galeri (jumlah gambar & video tidak dibatasi) | `products` | `/products` | Produk (drawer) | `product:*` | Product Detail |
| Kategori | nama, urutan, aktif | `categories` | `/categories` | Kategori | `category:create/update/delete/reorder` | Filter + grup produk |
| Hero | eyebrow, judul, deskripsi, 2 CTA, 2 label melayang, 3 cover | `settings` (`hero`) + R2 | `/settings/hero` | Hero | `hero:update` | Hero Home |
| Statistik beranda | pelanggan, total pesanan, support (Total Produk dihitung) | `settings` (`stats`) | `/settings/stats` | Pengaturan | `settings:update` | Strip statistik |
| FAQ | pertanyaan, jawaban, urutan, aktif | `faqs` | `/faq` | FAQ | `faq:create/update/delete/reorder` | Seksi FAQ |
| Kontak | label, teks, tautan, ikon, urutan, aktif | `contacts` | `/contacts` | Kontak | `contact:*` | Kartu kontak |
| Brand | nama, judul tab, logo | `settings` (`branding`) + R2 | `/settings/branding` | Pengaturan | `settings:update` | Header, footer, `<title>` |
| Judul seksi | judul/keterangan produk, FAQ, kontak | `settings` (`sections`) | `/settings/sections` | Pengaturan | `settings:update` | Judul seksi Home |
| Halaman produk | catatan "Tentang Produk", strip platform, "N+ pesanan selesai" | `settings` (`productPage`) | `/settings/productPage` | Pengaturan | `settings:update` | Product Detail |
| Rating & ulasan | `productId`, nama, bintang, teks, tanggal, foto (≤3, referensi R2) | `reviews` + R2 | `/reviews` (lihat & hapus) | Rating & Ulasan | `review:create/update/delete` | Halaman Rating (semua produk) + Product Detail (per produk) |
| Gambar/video | file | `assets` + R2 | `/media` | Aset Gambar | `media:error` (ke Admin) | semua gambar |

## 3. Fitur yang sengaja TIDAK punya kontrol Admin

| Fitur | Alasan |
|---|---|
| Orders, Customers, Notifications (menu Admin) | Marketplace belum punya data/logic pesanan, akun pelanggan, atau notifikasi (menunggu tahap Payment). Menu tidak dibuat karena tidak akan berfungsi. |
| Banner / slider | Tidak ada di Marketplace. |
| Cek Pesanan, Beli Sekarang, Tambah ke Keranjang, label "QRIS" | Placeholder tahap Payment. Tidak diubah. (Tautan Rating sekarang aktif.) |
| Persetujuan ulasan | Tidak ada. Ulasan pelanggan langsung tampil; Admin hanya melihat dan menghapus. Event pesanan/pelanggan baru belum ada sumbernya. |
| Total Produk, diskon (%), rata-rata & distribusi rating, urutan "Terbaru" | Dihitung otomatis dari data. |
| Pencarian, urutan, filter di Marketplace | Perilaku UI, bukan konfigurasi. |
| Warna, font, artwork latar | Desain tetap di CSS; tidak ada konsumen untuk pengaturan tersebut. |
| "Total Pesanan" / "Pelanggan" / "Terjual" / "N+ pesanan selesai" | Diisi manual (Pengaturan / form produk) sampai modul pesanan aktif. |

Satu-satunya arus Marketplace → Admin yang nyata saat ini: jumlah pengunjung online (`presence:update`) dan laporan gambar yang gagal dimuat (`media:error`).

## 4. Koleksi MongoDB

`counters` (id produk numerik berurutan agar `product.html?id=1` tetap bekerja), `admins`, `categories`, `products`, `reviews`, `faqs`, `contacts`, `settings` (satu dokumen per grup), `assets` (setiap objek R2: pemilik + status `temp|used|orphan`).

## 5. Indeks

| Koleksi | Indeks |
|---|---|
| products | `productId` (unik), `{active, category}`, `category`, `createdAt`, `updatedAt`, `name`, `price`, `stock` |
| reviews | `{product, status, date}`, `{status, date}`, `stars`, `productId` |
| categories | `nameKey` (unik, tanpa peduli huruf besar), `order` |
| faqs / contacts | `order` |
| settings | `key` (unik) |
| assets | `key` (unik), `{owner.type, owner.id}`, `{status, createdAt}`, `createdAt` |
| admins | `email` (unik) |

Pencarian teks admin memakai regex tak peka huruf besar (cocok sampai ribuan produk). Untuk katalog jauh lebih besar, ganti dengan Atlas Search.

## 6. Struktur R2

`{folder}/{YYYY}/{MM}/{uuid}.{ext}`, folder: `products` (gambar + video), `reviews`, `hero`, `branding`. Gambar: JPG, PNG, WebP, GIF, AVIF ≤ 8 MB. Video: MP4/WebM ≤ 30 MB (hanya produk). SVG ditolak. Tipe file ditentukan dari isi file, bukan dari nama/header.

Alur: `Admin → Backend (validasi) → R2 → verifikasi HEAD → catatan aset 'temp' → simpan entitas ke MongoDB → tandai 'used' → hapus objek lama yang tak dipakai lagi`. Upload yang tidak pernah disimpan dibuang setelah 6 jam. Bila R2 gagal menghapus, data tetap terhapus, objek ditandai `orphan`, dan dicoba lagi oleh pembersih tiap jam.

**Upload gagal? Baca log deploy.** Saat server hidup, log menampilkan variable R2 yang terbaca (hanya status/panjang, tanpa nilai rahasia) dan menjalankan uji nyata baca → tulis → verifikasi → hapus ke bucket (objek uji `_healthcheck/…` langsung dihapus). Baris `[r2] DIAGNOSA` menyebut penyebabnya. Setiap upload yang ditolak R2 dicatat sebagai `[r2] PutObject GAGAL status=… code=… bucket=… endpoint=… key=…` dan dijawab 503 dengan pesan yang jelas (bukan 500 generik):

| Log / pesan | Arti | Perbaikan |
|---|---|---|
| `AccessDenied` 403, `baca(list)=ok tulis(put)=AccessDenied` | Token hanya boleh membaca | Buat API Token R2 dengan izin **Object Read & Write** |
| `AccessDenied` 403 pada baca **dan** tulis | Token dibatasi ke bucket lain, atau `R2_BUCKET_NAME` / `R2_ACCOUNT_ID` tidak cocok dengan token | Cek "Specify bucket(s)" pada token dan nama bucket |
| `InvalidAccessKeyId` / `SignatureDoesNotMatch` | Access Key ID / Secret salah, terpotong, atau ada spasi/kutip | Salin ulang dari dialog token R2 (Secret hanya tampil sekali) |
| `NoSuchBucket` | Nama bucket salah, atau bucket jurisdiksi EU | Cek `R2_BUCKET_NAME`; EU memakai `R2_ENDPOINT=https://<account>.eu.r2.cloudflarestorage.com` |
| `ENOTFOUND` / timeout | Endpoint salah / jaringan | Cek `R2_ACCOUNT_ID` / `R2_ENDPOINT` |

## 7. Endpoint

Publik (tanpa login, data publik saja): `GET /api/public/bootstrap`, `GET /api/public/products/:id`, `GET /api/public/products/:id/reviews?page&limit`, `GET /api/public/reviews?page&limit&productId&stars&sort` (semua ulasan + ringkasan), `POST /api/public/reviews` (kirim ulasan, multipart), `POST /api/public/image-error`, `GET /healthz`.

Admin (wajib sesi; mutasi memeriksa header Origin):

| Grup | Endpoint |
|---|---|
| Auth | `POST /api/admin/auth/login` · `POST /logout` · `GET /me` · `PATCH /me` · `POST /me/password` |
| Umum | `GET /api/admin/meta` · `GET /api/admin/dashboard` |
| Produk | `GET /products?page&limit&q&category&status&stock&sort` → `{items,page,limit,total,totalPages}` · `GET /:id` · `POST` · `PUT /:id` · `PATCH /:id/status` · `DELETE /:id` |
| Kategori | `GET` · `POST` · `PUT /reorder` · `PUT /:id` · `PATCH /:id/status` · `DELETE /:id?moveTo=<id>` |
| FAQ, Kontak | pola yang sama dengan Kategori: `/faq`, `/contacts` |
| Ulasan | `GET /reviews?page&limit&q&productId&stars&status&sort` · `DELETE /:id` (juga menghapus foto di R2). `POST`, `PUT /:id`, `PATCH /:id/status` masih tersedia di API tetapi tidak dipakai UI Admin. |
| Pengaturan | `GET /settings` · `PUT /settings/:key` (`branding`, `hero`, `stats`, `sections`, `productPage`) |
| Media | `POST /media` (multipart `file`, `folder`) · `GET /media` · `DELETE /media/:id` (hanya yang tak dipakai) · `GET/DELETE /media/errors` |

Default `limit` = 25 (maks 100). Filter/cari/urut mengembalikan ke halaman 1; refresh realtime memuat ulang halaman yang sama.

## 8. Event Socket.IO

Namespace `/` (Marketplace, hanya data publik): `product:create|update|delete|bulk`, `category:create|update|delete|reorder`, `hero:update`, `settings:update`, `faq:create|update|delete|reorder`, `contact:create|update|delete|reorder`, `review:create|update|delete`.
Item yang dinonaktifkan dikirim sebagai `:delete`, diaktifkan lagi sebagai `:create` (kategori nonaktif ikut menyembunyikan produknya).

Namespace `/admin` (wajib cookie sesi): semua event di atas dengan data lengkap, ditambah `presence:update` (jumlah pengunjung online) dan `media:error`.

Klien Marketplace (`public/js/live.js`) mendaftarkan semua listener **sekali**; setelah reconnect hanya memanggil sinkron ulang dari `/api/public/bootstrap`. Selama terputus UI tetap memakai data terakhir. Tanpa Socket.IO, Marketplace polling tiap 30 detik.

## 9. Keamanan

Sesi JWT di cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` di production); password bcrypt (cost 12); ganti password mencabut semua sesi lain; rate limit login/upload/API; pemeriksaan Origin untuk mutasi; Helmet + CSP ketat (`script-src 'self'`); semua teks dari Admin di-escape di Marketplace dan Admin; tautan hanya `https:`, `mailto:`, `tel:`, `#`, `/`; kredensial R2/MongoDB hanya di server dan terbukti tidak muncul di respons API (diuji).

## 10. Hasil pengujian (dijalankan di lingkungan pengembangan saya)

| Uji | Hasil | Catatan |
|---|---|---|
| `npm test` | 24/24 lulus (dua kali berturut-turut) | auth, validasi, alur gambar, paginasi, kategori, visibilitas publik, konten, keamanan, Socket.IO, reconnect, restart, indeks, sweeper |
| `test/e2e/browser.py` | 30/30 lulus | Chromium nyata: Admin UI → backend → DB → R2 → Socket.IO → Marketplace tanpa refresh |
| Responsif 390 px | Admin dan Marketplace tanpa scroll horizontal | |

Bug yang ditemukan dan diperbaiki lewat pengujian: validator `oldPrice` menolak produk tanpa harga coret; listener halaman Admin menumpuk antar navigasi; scroll horizontal di mobile (sudah ada di prototype asli).

**Belum teruji, karena tidak tersedia di lingkungan saya:**
- **Cloudflare R2 asli.** Memakai server S3 tiruan lokal yang meniru PUT/HEAD/GET/DELETE. Jalur SDK sama (`@aws-sdk/client-s3`), tetapi URL publik/custom domain, izin token, dan perilaku R2 sebenarnya belum diuji.
- **MongoDB asli.** Diuji dengan FerretDB (kompatibel MongoDB, backend SQLite) lewat Mongoose. Tidak diuji: Atlas, replica set, dan versi MongoDB tertentu.
- **Deploy Railway.** `railway.json` mengikuti dokumentasi resmi tetapi belum dijalankan di Railway.
- Windows, Safari/Firefox, dan perangkat sungguhan. Uji visual hanya di Chromium headless; font Google dimuat dari fallback sistem di lingkungan saya.

## 11. Batasan yang diketahui

- Satu instance server (Socket.IO tanpa adapter Redis).
- Logout menghapus cookie tetapi token yang sudah dicuri tetap berlaku sampai kedaluwarsa atau password diganti.
- Tidak ada multi-admin / peran; satu jenis admin.
- Foto ulasan dan produk tidak diubah ukuran di server (disimpan apa adanya, maks 8 MB). Pertimbangkan Cloudflare Image Resizing.
- Jumlah terjual, pelanggan, dan total pesanan diisi manual sampai modul pesanan ada.

## 12. Tambah produk otomatis dari Steam App ID

Admin Web -> Produk -> Tambah produk -> **Sumber produk**: `Manual` (form biasa) atau `Otomatis (Steam App ID)`.

- Endpoint (admin saja): `GET /api/admin/steam/:appId` dan `POST /api/admin/steam/:appId/video`. Kode: `server/services/steam.js`, parser: `server/lib/steamParse.js`, UI: `admin/js/pages/_steam.js`.
- Sumber data: Steam Store `appdetails` (publik, tanpa API key). Dipanggil hanya dari backend; frontend hanya menerima hasilnya.
- Terisi otomatis: nama, deskripsi singkat (maks 300), deskripsi lengkap (maks 4000), **gambar utama + SEMUA screenshot** (`screenshots[]`), **SEMUA video** (`movies[]`, bila Steam menyediakan MP4/WebM), persyaratan minimum & disarankan (diparse menjadi baris `label/nilai`, bukan HTML mentah), kolom Sumber, dan **Info game** (Steam App ID, developer, publisher, tanggal rilis, genre, Metacritic). Kategori toko dipilih otomatis bila nama kategori aktif sama dengan genre/kategori Steam (tidak pernah membuat kategori baru).
- Galeri: **tidak ada batas jumlah** gambar maupun video (server, validasi, schema, dan Admin Web); yang dibatasi hanya ukuran per file (gambar 8 MB, video 30 MB). Urutan: gambar utama Steam, semua screenshot (urutan Steam), file manual, lalu semua video Steam. Server mengunduh seluruh `screenshots[]` (paralel 6; `path_thumbnail` dipakai bila `path_full` gagal; satu gambar gagal hanya dilewati dan dilaporkan sebagai warning). Video diunduh satu per satu: `GET /steam/:appId` melaporkan `video.count` + `video.items`, lalu Admin Web memanggil `POST /steam/:appId/video` dengan body `{ "movie": <0..count-1> }` untuk tiap video (tanpa body = video pertama); tiap video yang selesai langsung masuk galeri. Urutan video: trailer `highlight` dulu, lalu urutan Steam; tiap video memakai MP4 480 → WebM 480 → MP4 max → WebM max (yang pertama berhasil & ≤ batas ukuran). Aset yang akhirnya tidak disimpan dibersihkan sweeper.
- Struktur data Steam yang dipakai: `screenshots[]` = `{ id, path_thumbnail, path_full }`; `movies[]` = `{ id, name, thumbnail, highlight, webm: { 480, max }, mp4: { 480, max } }`. Sebagian URL `movies[]` dikirim Steam sebagai `http://`; host tetap harus CDN Steam dan dinaikkan ke `https://` (bukan dibuang).
- Rate limit: pencarian `GET /steam/:appId` 20/menit; unduhan video `POST /steam/:appId/video` 120/menit (satu permintaan per video).
- Admin bisa menghapus, mengganti (tombol unggah pada tile), menggeser, dan menambah media sebelum Simpan. Pratinjau Steam di form selalu mengikuti isi galeri.
- Data manual tidak ditimpa diam-diam: bila kolom sudah berisi nilai berbeda, muncul dialog "Timpa isian yang sudah ada?"; pilihan "Isi yang kosong saja" mengisi hanya kolom kosong.
- Info game disimpan di `product.gameInfo` (string/angka/array kecil di MongoDB). Saat ini hanya tampil di Admin Web; Marketplace belum menampilkannya.
- Gambar/video diunduh server dari CDN Steam (hanya host `*.steamstatic.com` / `*.akamaihd.net`, selalu diunduh lewat HTTPS, redirect divalidasi) ke R2 sebagai aset `temp`; baru menjadi milik produk saat Simpan. Biner tidak masuk MongoDB. Aset yang tidak jadi dipakai dibersihkan sweeper (6 jam).
- App ID valid tetapi metadata/media sebagian -> sukses dengan `warnings` ("Game ditemukan, beberapa media tidak tersedia."); hanya ID yang tidak dikenal Steam yang mengembalikan "Steam App ID tidak valid." Steam mati/lambat -> pesan terpisah (502), isian form tidak disentuh.
- Cache memori 10 menit (ID tidak ditemukan 2 menit), permintaan bersamaan digabung, batas 20 pencarian/menit/IP.
- Batasan: Steam tidak membedakan "ID tidak ada" dari "game tidak tersedia di Steam Store/wilayah"; trailer yang hanya tersedia sebagai HLS/DASH, atau lebih besar dari batas video, dilaporkan "Video tidak tersedia".

## 11. Rating & ulasan dari pelanggan

Satu sistem ulasan untuk seluruh Marketplace: koleksi `reviews` (MongoDB) dengan `productId`, `name`, `stars`, `text`, `images[{key,url}]` (hanya referensi R2, bukan biner), `createdAt`, `updatedAt`. Logika bersama ada di `server/services/reviews.js`.

| Halaman | Sumber data |
|---|---|
| Rating (`rating.html`) | `GET /api/public/reviews`: ulasan semua produk yang tampil + ringkasan (rata-rata, jumlah, distribusi) |
| Product Detail | `GET /api/public/products/:id` (ringkasan) dan `/products/:id/reviews`, hanya ulasan ber-`productId` produk itu |
| Admin Web | `GET /api/admin/reviews`, `DELETE /api/admin/reviews/:id` |

Alur kirim: form di halaman Rating → `POST /api/public/reviews` (multipart `productId`, `name`, `stars`, `text`, `images` ≤ 3) → validasi → foto diunggah ke R2 lewat `services/assets.js` (sniff tipe file, ≤ 8 MB, verifikasi HEAD) → ulasan disimpan `published` → foto ditandai `used` → `review:create` lewat Socket.IO. Bila langkah mana pun gagal, ulasan dibatalkan dan foto yang terlanjur terunggah dihapus dari R2. Pembatas: 8 pengiriman / 10 menit / IP di production, kolom jebakan bot, pemeriksaan Origin.

Alur hapus (Admin): hapus dokumen → hapus foto di R2 (gagal → ditandai `orphan`, dicoba lagi pembersih) → `review:delete` (membawa `productId`). Halaman Rating dan Product Detail produk terkait mengambil ulang daftar + ringkasan dari server, sehingga daftar, rata-rata, dan jumlah selalu sinkron dan event ganda tidak membuat ulasan duplikat.
