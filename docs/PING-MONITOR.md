# Indikator ping HTML

Jalankan `npm run dev`, lalu buka [API Monitor](http://127.0.0.1:3001/monitor/). Alamat utama `http://127.0.0.1:3001/` mengarahkan ke halaman yang sama. Halaman ini disajikan oleh Fastify dan tersedia tanpa login.

## Cara memakai

1. Halaman melakukan satu ping awal. Klik **Ping sekarang** untuk memeriksa lagi.
2. Baca kartu **Server API** dan **Koneksi database** secara terpisah. `/ping` tidak mengakses database; `/health` memeriksa koneksi database.
3. Aktifkan **Ping otomatis** dan pilih interval 5, 10, 30, atau 60 detik. Siklus berikutnya dijadwalkan setelah siklus sebelumnya selesai, sehingga request tidak menumpuk.
4. Pilih **Batas tunggu** 3, 5, 10, atau 15 detik. Request yang melewati batas dibatalkan pada browser dan diberi status timeout.
5. Klik **Uji semua indikator** untuk memeriksa empat endpoint. **Lihat JSON** menampilkan respons yang sudah menyamarkan field token/password/secret.
6. Klik **Unduh JSON** untuk menyimpan hasil pemeriksaan pada perangkat. **Bersihkan** menghapus riwayat pada layar.

| Indikator | Makna |
|---|---|
| Hijau | API dan database merespons dengan status sehat. |
| Kuning: respons lambat | Koneksi berhasil, tetapi salah satu respons membutuhkan minimal 2 detik. |
| Kuning: database bermasalah | `/ping` berhasil, sementara `/health` gagal atau timeout. |
| Merah | Ping server gagal atau server tidak dapat dijangkau. |
| Biru: 401 perlu login | Endpoint sesi merespons dengan benar, tetapi browser belum memiliki sesi aktif. |

Grafik menyimpan maksimal 30 siklus selama halaman terbuka; log menampilkan 12 siklus terbaru. Persentase keberhasilan dihitung dari siklus yang masih berada dalam jendela 30 sampel. Latensi adalah waktu request dari browser ini, termasuk pembacaan respons. Batas waktu browser tidak mengubah konfigurasi transaksi database.

Semua pemeriksaan hanya memakai GET dan mengikuti origin halaman. Tidak ada login otomatis, password yang disisipkan ke HTML, atau perubahan data aplikasi. Endpoint bisnis seperti `/api/assets` tetap memerlukan autentikasi dan role. Jika server berhenti saat halaman masih terbuka, ping berikutnya menunjukkan merah. Untuk membuka halaman pertama kali, server harus sedang berjalan.

## File

- `public/monitor/index.html`: struktur HTML.
- `public/monitor/style.css`: tampilan responsif.
- `public/monitor/app.js`: ping, timeout, grafik, log dan ekspor JSON.
- `src/routes/monitor.ts`: route Fastify untuk halaman, aset, redirect dan `/ping`.
- `scripts/copy-public.mjs`: menyalin aset ke `dist/public` ketika build, sehingga `npm start` juga dapat menyajikan monitor.

Membuka file HTML langsung akan menampilkan petunjuk untuk membuka URL server. Jalur HTTP memastikan script dan API menggunakan origin yang sama.

## Verifikasi

Lint/build dan 25 pengujian backend lulus setelah penambahan monitor. Pengujian baru memastikan HTML, CSS, JS dan `/ping` tetap tersedia ketika database gagal, sedangkan endpoint data tetap terlindungi.

Pada browser, status normal dan empat indikator berhasil diperiksa. Server simulasi terpisah dengan respons database 6 detik digunakan untuk memverifikasi status lambat dan timeout 3 detik. Ping otomatis berjalan sesuai interval. Sesudah server simulasi dihentikan, indikator berubah merah. Unduhan JSON berhasil dan tidak memuat cookie sesi. Server simulasi kemudian dibersihkan; backend utama tetap tersedia pada port 3001.
