# Marketplace + Admin Web

Satu server Node.js yang melayani **Marketplace** (`/`) dan **Admin Web** (`/admin`), memakai **MongoDB** sebagai sumber kebenaran, **Cloudflare R2** untuk semua gambar/video, dan **Socket.IO** agar perubahan di Admin langsung tampil di Marketplace tanpa refresh. Siap deploy ke **Railway**. Payment belum dikerjakan (tahap berikutnya).

```
MARKETPLACE  ⇄  SOCKET.IO  ⇄  ADMIN WEB
                    ⇅
                 BACKEND (Express)  ──►  CLOUDFLARE R2  ──►  URL publik gambar
                    ⇅
                 MONGODB
```

## Jalankan lokal

Butuh Node.js ≥ 22 dan MongoDB (lokal atau Atlas) dan bucket R2 (untuk upload gambar).

```bash
npm install
cp .env.example .env        # isi MONGODB_URI, APP_SECRET, ADMIN_*, R2_*
SEED_DEMO=true npm run dev  # SEED_DEMO mengisi 12 produk contoh dari prototype (hanya bila DB kosong)
```

- Marketplace: http://localhost:3000
- Admin Web: http://localhost:3000/admin (login dengan `ADMIN_EMAIL` / `ADMIN_PASSWORD`)

Tanpa kredensial R2, server tetap jalan dan semua fitur selain upload gambar berfungsi (upload mengembalikan pesan jelas bahwa R2 belum dikonfigurasi).

## Deploy ke Railway

1. Push repo ini ke GitHub, di Railway pilih **New Project → Deploy from GitHub repo**.
2. Tambahkan database: Railway MongoDB (atau Atlas), lalu isi `MONGODB_URI` pada service ini.
3. Isi Variables: `NODE_ENV=production`, `APP_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`. Untuk deploy pertama boleh tambah `SEED_DEMO=true`, hapus setelahnya.
4. `railway.json` sudah mengatur start command (`npm start`) dan health check (`/healthz`). Aktifkan **Generate Domain**.
5. Jalankan **satu instance** saja. Socket.IO versi ini menyimpan koneksi di memori proses; untuk lebih dari satu replika perlu adapter Redis (belum dibuat).

Server menolak start di production bila `APP_SECRET` kurang dari 32 karakter, `MONGODB_URI` kosong, R2 belum lengkap, atau `R2_PUBLIC_URL` berupa localhost / URL internal / endpoint S3 privat.

### Cloudflare R2
1. Buat bucket, lalu **Manage API Tokens** → token dengan izin *Object Read & Write* pada bucket tersebut.
2. Aktifkan akses publik. **Production: sambungkan custom domain** ke bucket (mis. `cdn.domainmu.com`) dan isi `R2_PUBLIC_URL` dengan domain itu. Domain `r2.dev` hanya untuk uji coba karena dibatasi laju oleh Cloudflare.
3. Tidak perlu CORS khusus untuk menampilkan gambar lewat `<img>` / `<video>`.
4. MongoDB hanya menyimpan `key` dan URL; URL publik dibentuk ulang dari `key` + `R2_PUBLIC_URL` saat dikirim, jadi pindah ke custom domain nanti tidak merusak data lama.

## Tes

```bash
npm test                    # 24 tes: auth, validasi, alur gambar R2, paginasi, publik, Socket.IO, persistensi, indeks
python test/e2e/browser.py  # opsional, 30 pemeriksaan di browser nyata (butuh: pip install playwright && playwright install chromium)
```
`npm test` memakai R2 tiruan lokal dan membuat/menghapus database sementara sendiri (`TEST_MONGODB_URI` opsional).

## Clean URL (tanpa .html)

| URL | File |
|---|---|
| `/` | `public/index.html` |
| `/rating` | `public/rating.html` |
| `/product/<id>` | `public/product.html` |
| `/checkout?product=<id>` | `public/checkout.html` |
| `/payment?order=<no>&t=<token>` | `public/payment.html` (sukses / gagal / kedaluwarsa = keadaan di halaman ini) |
| `/cek-pesanan` | `public/track.html` |

- Pemetaan ada di satu tempat: `PAGES` di `server/lib/urls.js` (dipakai `server/index.js` untuk routing **dan** oleh pembuat tautan Email/WhatsApp).
- URL lama dialihkan 301 dengan query utuh: `/payment.html?order=X&t=Y` → `/payment?order=X&t=Y`, `/product.html?id=5` dan `/product?id=5` → `/product/5`, `/track(.html)` → `/cek-pesanan`, `/faq` → `/#faq`, `/contact` → `/#contact`, `/rating/` → `/rating`.
- Aset di HTML memakai path root-absolute (`/css/…`, `/js/…`) supaya tetap benar di `/product/5`. Tautan antarhalaman di JS/HTML juga clean (`/rating`, `/cek-pesanan`, `/product/<id>`).
- Tautan notifikasi dibuat lewat `pageUrl()` + `resolvePublicOrigin()` (`server/lib/urls.js`): alamat dari Admin Web / `PUBLIC_BASE_URL`, lalu origin request hanya bila domain publik asli (bukan localhost / `*.up.railway.app` / preview), lalu cadangan production `https://www.31store.site` (`DEFAULT_PUBLIC_ORIGIN`).

## Cek Pesanan

Halaman `/cek-pesanan` (tombol **Cek Pesanan** di header). Satu form, dua metode: **ID Transaksi** atau **Email** (cukup salah satu). Memakai Order, Payment, MongoDB, dan Socket.IO yang sudah ada; tidak ada koleksi atau status baru.

| Bagian | Detail |
|---|---|
| `POST /api/orders/track` | Body `{ by: "order" \| "email", q }`. Rate limit `trackLimiter`. 404 bila tidak ada, 422 bila format salah. |
| `GET /api/orders/track/:orderNo` | Satu pesanan (polling cadangan), header `x-watch-token`. |
| Socket.IO | Klien emit `track:join { orderNo, watch }` (ack = keadaan terkini) dan `track:leave`; server emit `track:update` ke room `track:<orderNo>` dari `emitOrder` yang sama dengan `order:update`. Dedup di klien lewat `rev`. |
| Keamanan | Data pembeli disamarkan (nama, email, WhatsApp). Tidak ada QRIS, token pembayaran, signature, URL laporan, status gateway, atau catatan internal. Token pantau (`watchTokenFor`) berbeda dari token pembayaran dan hanya membuka tampilan ber-masking. |
| WhatsApp Admin | Dari Admin Web → Pengaturan Payment (`waAdmin`), dikirim lewat `/api/orders/config`, hasil pencarian, dan event `payment:settings`. |

## Sistem Code (Order Code Redeem)

Produk berjenis **Sistem Code**: setelah pembayaran SUCCESS, pembeli otomatis menerima 1 code unik di halaman Payment Success. Memakai Order, Payment (KlikQRIS), notifikasi, MongoDB, dan Socket.IO yang sudah ada.

| Bagian | Detail |
|---|---|
| Koleksi | `redeemcodes` (status `available → sold`, hanya maju; redeem terjadi di aplikasi lain sehingga tidak dilacak). `codeKey` unik global; index unik parsial pada `order` = satu order tidak bisa memegang dua code. Field baru: `Product.kind/redeemTutorial`, `Order.product.kind/codeState`. |
| Pemberian code | `assignCode()` di `services/codes.js`, dipanggil `markPaid()` setelah status SUCCESS tersimpan. Satu `findOneAndUpdate` atomic; idempoten terhadap webhook ganda, refresh, reconnect. Dipulihkan otomatis oleh halaman Payment dan worker bila proses mati di tengah jalan. |
| Stok habis saat dibayar | Order ditandai `codeState: waiting`; diberi code otomatis (FIFO) begitu Admin menambah stok. |
| Admin API | `POST /api/admin/code-products`, `PUT /:id`, `POST /:id/codes`; `GET /api/admin/codes` (+ `/stats`, `/:id/reveal`). Semua di belakang `requireAdmin`. Code `available` disamarkan di daftar. |
| Socket.IO | admin: `code:update`, `code:stats`, `code:refresh`; pelanggan: `order:update` (room per-order, butuh token) membawa `redeem`; stok Marketplace lewat `product:update` yang sudah ada. |
| Keamanan | Code tidak ada di API publik, Cek Pesanan, atau log. Hanya pemilik order (token pelanggan) dan Admin yang bisa membacanya. |
| Notifikasi | Code ikut di WhatsApp/Email `paymentSuccess` (slot `NotificationLog` mencegah kirim ganda); placeholder `{{redeem_code}}` untuk template custom. |

## Keuntungan Per Bulan

Halaman Admin Web (menu **Penjualan → Keuntungan Per Bulan**) berisi rekap pendapatan bulanan, grafik, filter, detail transaksi, dan hapus rekap. Memakai Order, Payment (KlikQRIS), MongoDB, dan Socket.IO yang sudah ada; tidak ada sistem transaksi baru.

| Bagian | Detail |
|---|---|
| Sumber data | Koleksi `orders` saja (sumber kebenaran tunggal, tidak ada koleksi rekap berisi angka). Dihitung hanya bila `status = SUCCESS` **dan** `payment.mode = production`; filter ini dipaksa di query MongoDB (`services/reports.js`), bukan di frontend. Sandbox, PENDING, EXPIRED, dan FAILED tidak pernah masuk total, grafik, rekap, maupun detail. |
| Nominal & waktu | Nominal = `totalAmount` (yang benar-benar dibayar, memuat kode unik QRIS) bila ada, selain itu `amount`. Waktu = `payment.paidAt` (cadangan `createdAt`). Bulan dikelompokkan menurut WIB (Asia/Jakarta). Satu order = satu produk terjual. |
| Anti hitung ganda | Satu order = satu dokumen (`orderNo` unik) dan `markPaid()` hanya memenangkan transisi SUCCESS sekali, jadi webhook ganda, polling, dan reconnect tidak menambah baris. Laporan hanya membaca. |
| Keuntungan vs pendapatan | `Product` belum punya modal/HPP, jadi halaman menampilkan **pendapatan** dan memberi catatan di layar. Tidak ada angka keuntungan yang dikarang. |
| Filter | Tahun, bulan (butuh tahun), rentang tanggal (menggantikan tahun/bulan), produk, kategori, status pembayaran (semua yang berhasil / tepat waktu / terlambat `latePayment`). Pilihan produk, kategori, dan tahun diambil dari transaksi production yang benar-benar ada. Ringkasan "bulan berjalan" mengikuti filter produk/kategori/status, bukan filter tanggal. |
| Admin API | `GET /api/admin/reports/monthly` (ringkasan, daftar bulan, opsi filter); `GET /monthly/:month` (detail transaksi, filter sama, pakai `totals` dari pipeline yang sama dengan daftar bulan); `GET /monthly/:month/impact`; `DELETE /monthly/:month?asOf=`. Semua di belakang `requireAdmin`. |
| Hapus rekap | Tidak menghapus Order/Payment. Menulis penanda di koleksi `reportresets` (`month`, `cutoff`, jejak audit): order production bulan itu yang dibayar sampai `cutoff` disembunyikan dari laporan ini. `cutoff` = waktu yang ditampilkan di dialog konfirmasi (`asOf`), jadi yang terhapus persis yang dilihat admin; pembayaran baru sesudahnya tetap terhitung. Dashboard, Pesanan, dan "Terjual" produk tidak berubah. |
| Socket.IO | Memakai socket `/admin` yang sudah ada: halaman menyegarkan diri pada `order:update` bertanda `mode = production` (sandbox diabaikan) dan pada `report:update` (event baru, dikirim saat admin lain menghapus rekap). Listener ikut dibuang saat berpindah halaman. |
| Grafik | HTML/CSS murni (CSP hanya mengizinkan script `'self'`): pendapatan per bulan dan transaksi per bulan, mengikuti filter, maksimal 24 bulan terakhir. |

## Floating Order Notification

Toast kecil di kiri bawah Marketplace (`/`) yang menampilkan order sukses terbaru sebagai social proof. Memakai Order, Payment, MongoDB, dan Socket.IO yang sudah ada; tidak ada koleksi, status, atau server Socket.IO baru.

| Bagian | Detail |
|---|---|
| Sumber data | Order berstatus `SUCCESS` saja (definisi yang sama dengan "Terjual"), diurutkan menurut waktu bayar. PENDING / EXPIRED / FAILED tidak pernah ikut. |
| `GET /api/public/recent-orders` | Semua order SUCCESS (terbaru dulu, pengaman `FEED_LIMIT` = 500), dipakai saat halaman dibuka dan untuk sinkron ulang setelah reconnect. |
| Socket.IO | Event publik `sale:create`, disiarkan dari `markPaid()` oleh pemenang transisi ke SUCCESS (callback ganda tidak menyiarkan ulang). |
| Payload | `id`, nama depan, email ber-masking (`rizk*****@gmail.com`), nama produk, gambar produk, waktu bayar. Masking dilakukan di server; email utuh tidak pernah dikirim. `id` adalah HMAC opaque, **bukan** `orderNo` (orderNo membuka Cek Pesanan). |
| Klien (`public/js/orderfeed.js`) | Antrean maksimal 5, terbaru di depan. Tampil 3 detik, hilang 1 detik, lalu order berikutnya; setelah yang terakhir kembali ke yang terbaru. Order baru masuk ke posisi pertama dan menjadi yang berikutnya tampil (notifikasi yang sedang tampil tidak disela). Dedup lewat `id`. Berhenti saat tab tersembunyi dan lanjut saat kembali. |
| Indeks | `orders: { status: 1, 'payment.paidAt': -1 }`. |

## Live Chat

Floating Live Chat di Marketplace (kanan-bawah) + halaman **Live Chat** di Admin Web, seluruhnya memakai sistem yang sudah ada:
MongoDB (sumber kebenaran), Socket.IO (namespace `/` untuk pelanggan, `/admin` untuk admin), Cloudflare R2 (gambar), Fonnte (WhatsApp admin).

- **Pelanggan** mengisi nama (wajib) + WhatsApp (opsional, tidak pernah dikarang) -> percakapan baru dengan `conversationId` unik (`LC-XXXXXXXXXX`).
  Akses dijaga token HMAC per percakapan (header `x-livechat-token`); `localStorage` hanya menyimpan penunjuk sesi dan selalu divalidasi ke server.
- **Expired 24 jam**: `expiresAt = createdAt + 24 jam` (waktu server, tidak bergeser). Worker backend (5 detik) menandai `expired` lewat transisi atomic,
  menyiarkan `livechat:expired` ke Marketplace + Admin, lalu menghapus pesan + gambar R2 setelah `LIVECHAT_RETENTION_DAYS` (default 7).
  Setiap query juga memfilter `expiresAt > sekarang`, jadi percakapan lewat batas tidak pernah dilayani walau worker belum jalan.
  Sengaja bukan TTL index: TTL menghapus diam-diam dan meninggalkan gambar yatim di R2.
- **Anti dobel**: pesan idempoten lewat `(conversation, clientId)`; listener socket didaftarkan sekali, room di-join ulang di setiap `connect` dengan snapshot dari server;
  suara admin dideduplikasi per id pesan (dan antar tab lewat Web Locks); WhatsApp admin di-claim atomic per pesan sebelum Fonnte dipanggil.
- **Event Socket.IO**: `livechat:conversation:created|updated|expired`, `livechat:message:new`, `livechat:read`, `livechat:unread`, `livechat:status`, `livechat:expired`, `livechat:settings`.
- **Admin**: Live Chat -> Percakapan (daftar, filter Aktif/Belum dibaca/Ditutup/Expired, balas, emoji, gambar, tutup/buka kembali) dan Pengaturan Live Chat.
- **Endpoint**: pelanggan `/api/livechat/*`; admin `/api/admin/livechat/*` (login Admin Web wajib).
- Gambar chat bisa dibuka lewat URL publik R2 yang tidak bisa ditebak (UUID), sama seperti foto ulasan.

## Logo, Favicon, dan Ikon Kontak

Admin Web → **Pengaturan** punya empat bagian gambar yang disimpan terpisah: **Store logo**, **Footer logo**, **Favicon**, dan **Ikon kontak**. Memakai sistem yang sudah ada: upload `POST /api/admin/media` → R2, pelacak aset `assets.js`, koleksi `settings`/`contacts` di MongoDB, dan event Socket.IO `settings:update` / `contact:*`. Tidak ada tabel, koneksi, atau listener baru.

| Bagian | Detail |
|---|---|
| Penyimpanan | MongoDB hanya menyimpan `{ key }` R2. URL publik dibentuk dari `key` + `R2_PUBLIC_URL` saat dikirim (sama seperti logo Store sebelumnya). |
| `settings.branding` | Field baru `footerLogo` dan `favicon` di dokumen yang sama dengan `logo`. `PUT /api/admin/settings/branding` kini parsial: hanya field yang dikirim yang berubah (`null` = hapus), jadi tiap kartu tidak menimpa kartu lain. Dokumen lama tanpa field baru tetap valid. |
| Footer | Memakai Footer logo bila ada. Bila kosong, footer tetap memakai Store logo (perilaku lama). Bila gambar Footer logo gagal dimuat, footer jatuh ke Store logo, lalu ke ikon bawaan. |
| Favicon | Format: PNG, ICO, WebP, JPG, GIF (maks. 5 MB). SVG tetap ditolak (risiko XSS) dan AVIF tidak dipakai. Semua halaman memuat `<link rel="icon" href="/favicon.ico">`; server mengarahkan `/favicon.ico` (302) ke favicon pilihan Admin, dan `script.js` mengganti `<link rel="icon">` saat event `settings:update` datang, tanpa refresh. Tanpa favicon, `/favicon.ico` menjawab 204. |
| Ikon kontak | Field baru `Contact.iconImage { key }`. Ikon bawaan (`icon`) tetap ada sebagai cadangan, jadi kontak lama tidak berubah. `PUT /api/admin/contacts/:id/icon` mengubah ikon satu kontak tanpa menyentuh teks/tautan. Format JPG/PNG/WebP/GIF/AVIF, maks. 2 MB. Ikon dilepas dari R2 saat diganti, dihapus, atau kontaknya dihapus. |
| Folder upload | Folder baru `contacts`. Format ICO hanya diterima di folder `branding` (Favicon). |

## Struktur

```
server/
  index.js                 boot Express + Socket.IO + Mongoose, header keamanan, static
  config/env.js            semua ENV + pemeriksaan konfigurasi
  models/index.js          skema Mongoose + indeks
  lib/                     r2.js (klien S3/R2), sniff.js (validasi isi file), realtime.js, schemas.js (zod), serialize.js
  services/                assets.js (upload→verifikasi→simpan→hapus lama), settings.js, imageErrors.js
  routes/                  public, auth, products, reviews, content (kategori/FAQ/kontak), settings, media, dashboard
  middleware/              security (sesi, origin guard, rate limit), errors
  seed/                    data awal dari prototype
public/                    Marketplace (index.html, product.html, css/, js/ — js/live.js = klien Socket.IO)
admin/                     Admin Web (vanilla JS ES modules: app.js, ui.js, api.js, pages/*)
test/                      tes otomatis + e2e browser
docs/PLATFORM.md           feature inventory, koleksi, indeks, endpoint, event, hasil tes, batasan
```

Detail lengkap (koleksi, indeks, seluruh endpoint, event Socket.IO, struktur R2, fitur yang sengaja tidak punya kontrol Admin): **[docs/PLATFORM.md](docs/PLATFORM.md)**.


## Performa
Ringkasan audit dan perubahan optimasi: lihat `PERFORMANCE.md`.


## Filter Kategori & Urutan Produk

| Bagian | Detail |
|---|---|
| Filter kategori (Marketplace) | Tombol filter dibangun dari `categories` di database (`/api/public/bootstrap`), bukan hardcode. Tambah/hapus/ubah/urutkan kategori di Admin langsung mengubah filter lewat event Socket.IO `category:*` yang sudah ada. Kategori terpilih disimpan di URL (`?kategori=<id>`), jadi tetap sama setelah refresh dan bisa dibagikan; id yang sudah tidak ada kembali ke "Semua". |
| Field urutan | Satu field: `Product.order` (kecil = tampil lebih dulu). Urutan berlaku **per kategori**. Logika di `services/productOrder.js`. |
| Produk baru | Ditaruh paling atas (`order` = terkecil − 1); posisi produk lain tidak berubah. Produk dihapus: urutan relatif produk lain tetap. |
| Data lama | Saat server start, produk tanpa `order` diberi posisi sesuai tampilan sebelumnya (terbaru dulu). Aman dijalankan berulang. |
| Admin | Produk → urutan "Urutan Marketplace": tombol ke paling atas / naik / turun per produk (`PATCH /api/admin/products/:id/move` body `{ to: up\|down\|top\|bottom }`). Hanya menukar nilai `order` di antara produk sekategori. |
| Marketplace | Urutan default "Rekomendasi" = urutan Admin. Opsi Terbaru / Harga / Nama tetap ada. |
| Socket.IO | `product:reorder` (admin: `{ items:[{id,productId,order}] }`, publik: `{ items:[{id,order}] }`, hanya produk yang tampil). Marketplace menerapkan posisi baru tanpa refresh. |
| Gambar utama | Form Ubah Produk (dan Produk Code) punya bagian **Gambar utama**: tombol "Ganti Gambar Utama" mengunggah ke R2 lewat jalur upload yang sama dan menggantikan item gambar utama di posisinya; galeri lain tidak bergeser. Berkas lama dibersihkan oleh `assets.attach()` saat produk disimpan. |
