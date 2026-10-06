# Script data

Urutan yang disarankan: backup → reset → migrasi.

```bash
# 0) Backup database baru (dan hentikan server)
mongodump --uri="$MONGODB_URI" --out=backup-sebelum-reset

# 1) Hapus data & gambar project baru (dry-run dulu)
npm run reset:data                 # hanya laporan
npm run reset:data -- --apply      # hapus (ketik nama database untuk konfirmasi)

# 2) Migrasi dari database lama (dry-run dulu)
OLD_MONGODB_URI="mongodb+srv://user:pass@host/NAMA_DB_LAMA" npm run migrate:old
OLD_MONGODB_URI="…" npm run migrate:old -- --apply
```

Reset menghapus produk, kategori, rating, pesanan, log notifikasi, penghitung ID, dan semua gambar terdaftar.
Akun admin, pengaturan (pembayaran/Resend/Fonnte/branding/hero) beserta logo/cover, FAQ, dan kontak dipertahankan.
Opsi: `--include-content`, `--include-settings`, `--include-admins`, `--keep-images`, `--yes=<nama-db>`.

Migrasi: kategori, produk (nama, harga, stok, terjual, status), pesanan + data pembeli, rating. Deskripsi/gambar produk tidak diambil dari project lama.
Opsi: `--skip-orders`, `--skip-reviews`, `--verbose`. Aman dijalankan berulang.
