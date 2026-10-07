# Script data

Urutan yang disarankan: backup → reset → migrasi.

```bash
# 0) Backup database baru (dan hentikan server)
mongodump --uri="$MONGODB_URI" --out=backup-sebelum-reset

# 1) Hapus data & gambar project baru (dry-run dulu)
npm run reset:data                 # hanya laporan
npm run reset:data -- --apply      # hapus (ketik nama database untuk konfirmasi)

# 2) Migrasi dari project lama (dry-run dulu)
npm run migrate:old                # hanya laporan (juga memeriksa gambar lama ada)
npm run migrate:old -- --apply     # tulis ke MongoDB + R2 baru
```

## Isi .env untuk migrasi (sumber LAMA)

```
OLD_MONGODB_URI=mongodb+srv://user:pass@host/?appName=...
OLD_MONGODB_DB=test                      # project lama yang URI-nya tanpa nama database memakai "test"
OLD_R2_ACCOUNT_ID=...                    # salin dari R2_* di .env project lama
OLD_R2_ACCESS_KEY_ID=...
OLD_R2_SECRET_ACCESS_KEY=...
OLD_R2_BUCKET_NAME=...
OLD_R2_PUBLIC_URL=...                    # opsional (cadangan unduh lewat URL)
```
`MONGODB_URI` dan `R2_*` biasa = tujuan BARU. Tanpa `OLD_R2_*`, gambar diunduh lewat URL publik lama (lebih lambat).

## Reset

Menghapus produk, kategori, rating, pesanan, log notifikasi, penghitung ID, dan semua gambar terdaftar.
Akun admin, pengaturan, FAQ, dan kontak dipertahankan.
Opsi: `--include-content`, `--include-settings`, `--include-admins`, `--keep-images`, `--yes=<nama-db>`.

## Migrasi

- **Kategori**: nama, urutan, aktif/nonaktif.
- **Produk**: nama, harga, stok, status, kategori, deskripsi singkat + "Tentang produk", dan **semua gambar** (utama + tambahan) disalin dari R2 lama ke R2 baru.
- **Pesanan**: **semua status** (sukses / gagal / kedaluwarsa; PENDING lama → kedaluwarsa) beserta data pembeli. Tidak ada yang dilewati: data kosong diberi nilai pengganti, dan pesanan yang gagal ditulis disebut satu per satu di laporan. Tidak mengubah stok, tidak mengirim notifikasi. (`--success-only` = hanya yang sukses.)
- **Terjual per produk**: sama dengan project lama. Project baru menghitung Terjual dari jumlah pesanan sukses, jadi selisihnya (pesanan dengan jumlah > 1, atau pesanan yang sudah dihapus admin di sistem lama) disimpan di `Product.soldAdjust`, dihitung ulang dari database baru setiap kali dijalankan.
- **Rating**: semua; approved → tayang, hidden/pending → tersembunyi. Produknya tak ditemukan → jadi ulasan umum (tidak dibuang).
- **Diagnosa**: laporan juga memindai semua database di cluster lama dan jejak pesanan yatim. Bila jumlah pesanan/rating di laporan lebih sedikit dari yang Anda harapkan, lihat bagian "Database di cluster lama": datanya mungkin ada di database lain → `OLD_MONGODB_DB=<nama>`.

Opsi: `--apply`, `--verbose`, `--skip-orders`, `--skip-reviews`, `--skip-images`, `--success-only`, `--old-uri=…`, `--old-db=…`.
Aman dijalankan berulang (tidak ada data atau gambar dobel). Produk bernama sama hanya diperbarui harga/stok/status/kategori; deskripsi diisi bila kosong; gambar tidak menimpa gambar yang sudah diatur manual.
