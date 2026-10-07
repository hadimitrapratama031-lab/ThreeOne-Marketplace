# Optimasi Performa Marketplace

Hanya performa. Desain, layout, fitur, skema database, R2, dan Socket.IO tidak diubah.

## Hasil audit (penyebab nyata, bukan sekadar menyembunyikan loading)

| # | Temuan | Dampak |
|---|--------|--------|
| 1 | `product.js` menunggu `MP.ready` (bootstrap SELURUH katalog + FAQ + kontak + statistik) baru memanggil `/products/:id`, lalu `/reviews` setelahnya. `checkout.js` dan `rating.js` punya pola serupa. | Detail Product = 3 request berurutan (waterfall) sebelum ada isi. |
| 2 | Setiap pindah halaman (multi-page) mengulang bootstrap penuh + `recent-orders` (hingga 500 order) + config Live Chat, semuanya `no-store`. | Tiap halaman mulai dari nol. |
| 3 | `/bootstrap` menghitung statistik hidup DUA kali, berurutan (`withLiveProductPage` + `withLiveStats`), plus rantai query serial. Tidak ada cache server. | Puluhan ms - ratusan ms per halaman, berlipat saat ramai. |
| 4 | Thumbnail galeri untuk item video memakai `<img src="video.mp4">`, jadi browser mengunduh video penuh sebagai gambar lalu gagal. | Bandwidth terbuang dan berebut dengan gambar utama. |
| 5 | CSS/JS disajikan `no-cache`: 10+ request validasi (304) di setiap halaman. Skrip (termasuk `socket.io.js`) sinkron di akhir body. CSS Google Fonts memblokir render. | Round-trip berulang di setiap navigasi. |
| 6 | `livechat.js` memanggil `/config` dua kali (awal + event `connect`). `orderfeed.js` mengambil data lagi pada sync pertama. | Request ganda. |

## Perubahan

**Server**
- `server/lib/memo.js` (baru): cache memori 3 dtk, request bersamaan berbagi satu perhitungan. Dibuang SEBELUM setiap event publik Socket.IO dikirim (hook di `emitPublic`) dan saat server start/stop. Hasil yang dihitung saat ada perubahan tidak disimpan. Realtime tetap segar.
- `routes/public.js`: bootstrap dihitung paralel dan statistik hanya sekali; ETag + `no-cache` (klien yang datanya sama menerima 304). `GET /products/:id?reviews=1&limit=3` membawa ulasan halaman 1 dalam SATU respons (tanpa parameter: respons lama persis). `recent-orders` memakai memo.
- `server/index.js`: HTML menautkan `css/x.css?v=<hash isi file>`; URL ber-versi di-cache 1 tahun (immutable). HTML tetap `no-cache` (ETag), jadi deploy baru langsung terpakai. Tanpa `?v=` perilaku lama.
- Index baru `reviews {status, productId, stars}` untuk agregasi ringkasan rating (dibuat otomatis oleh `syncIndexes` saat start).

**Klien**
- `script.js`: data bootstrap terakhir disimpan di localStorage dan langsung dipakai untuk tampilan pertama, lalu divalidasi ulang ke server (render ulang hanya jika datanya berbeda). `MP.ready` tetap berarti data SEGAR dari server; Checkout/Payment tidak pernah memutuskan dari cache.
- `product.js`: halaman langsung tergambar dari detail hasil prefetch/kunjungan sebelumnya, atau dari kartu produk (cache); jika tidak ada sama sekali, skeleton ringan. Detail + ulasan = 1 request, tidak menunggu bootstrap. Galeri: hanya gambar utama yang diprioritaskan, thumbnail video tidak lagi mengunduh video.
- Prefetch detail produk saat hover (jeda 65 ms), sentuh, atau fokus pada kartu produk. Request terpadu: hover, klik, dan halaman tidak pernah menembak dua kali.
- `checkout.js`: produk, config, dan bootstrap paralel (produk tetap diambil segar). `rating.js`: daftar ulasan tidak menunggu bootstrap.
- `orderfeed.js` dan `livechat.js`: dijalankan saat browser senggang; request ganda dihilangkan.
- Semua halaman: skrip `defer` di `<head>`, CSS font tidak memblokir render, prefetch aset halaman berikutnya (`product.css/js` dari Home, `checkout` dari Detail).

## Catatan
- Arsitektur tetap multi-page (tiap halaman = file HTML sendiri), bukan SPA. Navigasi terasa cepat lewat cache + prefetch + aset immutable, tanpa mengganti arsitektur.
- Animasi masuk `.enter` (`style.css`, 1 dtk + jeda) tidak saya ubah karena itu bagian desain. Ini yang paling terasa "lambat" di Detail Product walau data sudah ada; jika ingin lebih instan, kurangi durasi atau jeda `--d` di sana.
- Font Inter sekarang memuat tanpa memblokir render, sehingga teks bisa tampil sesaat dengan font cadangan lalu berganti (`display=swap`).
- Gambar R2 tidak diubah (sudah `immutable`). Resize/thumbnail butuh Cloudflare Image Resizing atau thumbnail saat upload, dan itu di luar lingkup ini.
