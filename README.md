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

## Cek Pesanan

Halaman `/track.html` (tombol **Cek Pesanan** di header). Satu form, dua metode: **ID Transaksi** atau **Email** (cukup salah satu). Memakai Order, Payment, MongoDB, dan Socket.IO yang sudah ada; tidak ada koleksi atau status baru.

| Bagian | Detail |
|---|---|
| `POST /api/orders/track` | Body `{ by: "order" \| "email", q }`. Rate limit `trackLimiter`. 404 bila tidak ada, 422 bila format salah. |
| `GET /api/orders/track/:orderNo` | Satu pesanan (polling cadangan), header `x-watch-token`. |
| Socket.IO | Klien emit `track:join { orderNo, watch }` (ack = keadaan terkini) dan `track:leave`; server emit `track:update` ke room `track:<orderNo>` dari `emitOrder` yang sama dengan `order:update`. Dedup di klien lewat `rev`. |
| Keamanan | Data pembeli disamarkan (nama, email, WhatsApp). Tidak ada QRIS, token pembayaran, signature, URL laporan, status gateway, atau catatan internal. Token pantau (`watchTokenFor`) berbeda dari token pembayaran dan hanya membuka tampilan ber-masking. |
| WhatsApp Admin | Dari Admin Web → Pengaturan Payment (`waAdmin`), dikirim lewat `/api/orders/config`, hasil pencarian, dan event `payment:settings`. |

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
