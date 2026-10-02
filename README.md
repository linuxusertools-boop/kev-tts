# kev-tts

kev-tts — API teks → suara multi-suara (voice clone dari `storage/*.mp3`), dikembangkan oleh kevsoft-studio. Siap deploy ke Vercel. Cache permanen di Firebase Realtime Database (terpisah per suara); lihat `database.rules.json`.

## Pakai

```
GET  /animemoe?text=Halo                 → suara utama (storage/sample.mp3)
GET  /kawai?text=Halo                    → storage/kawai.mp3 (nama file = nama endpoint)
GET  /voices                             → daftar semua suara
GET  /home   /docs                       → coba langsung / dokumentasi
GET  /api/tts?text=Halo dunia            → audio
POST /api/tts  {"text":"Halo dunia"}     → audio
GET  /api/tts?text=Halo&format=json      → JSON + data URI base64
GET  /api/tts?text=Halo&fast=1           → suara biasa (tanpa clone), ~1 detik
GET  /api/status                         → diagnosa Space, endpoint terdeteksi, sample
GET  /api/health                         → cek hidup instan (tanpa menyentuh Hugging Face)
GET  /api/warm                           → panaskan fungsi + Space (untuk pinger)
```

`/tts` dan `/animemoe` (endpoint lama) memakai handler yang sama. Halaman utama `/` punya **Try it out**.
Parameter lengkap ada di halaman utama.

## Deploy

1. Push folder ini ke GitHub → import di Vercel (Framework: Other). Tidak perlu build command.
2. Buka `/api/status` setelah deploy. `ok: true` berarti Space terjangkau dan sample terbaca.
3. Tidak memakai HF token sama sekali; tidak ada env var wajib.

## Sample suara

Taruh file di `storage/`. Urutan yang dicari: `sample.mp4`, `sample.mp3`, `sample.wav`, `sample.m4a`, `sample.ogg`, `sample.flac`.
File lain bisa dipilih lewat `SAMPLE_PATH`. Pakai **file audio sungguhan** (mp3/wav, mono, 5–15 detik, bersih).
Berkas `.mp4` berisi video bisa gagal didekode oleh model.

## Kecepatan

- Discovery skema: `/config` dan `/info` ditembak paralel, di-cache 10 menit per instance.
- Sample suara di-upload sekali lalu dipakai ulang (upload pertama berjalan spekulatif bersamaan dengan discovery).
- Hasil dibaca dari stream SSE dan langsung dikirim begitu `complete` tiba, tanpa menunggu koneksi ditutup.
- Cache hasil di memori (`X-TTS-Cache: memory`), penggabungan request identik, dan cache CDN 24 jam untuk GET.
- `fast=1` untuk jawaban sekitar sedetik (suara biasa).
- Fungsi dipasang di `sin1` (Singapura), sedekat mungkin dengan Realtime DB `asia-southeast1` dan pengguna.
- **Pemanasan:** Vercel Hobby hanya mengizinkan cron harian, jadi pasang pinger gratis (cron-job.org / UptimeRobot) ke `/api/warm` tiap 5 menit agar fungsi dan Space tidak dingin.

Batas jujur: generate suara clone di GPU Space tetap butuh beberapa detik untuk teks yang belum pernah diminta. Yang bisa dihilangkan adalah semua waktu tunggu di luar itu.

## Anti-error

- Skema Space dibaca langsung saat runtime, jadi tahan terhadap perubahan versi Gradio/VoxCPM.
- Retry + backoff (429/5xx/timeout), menunggu Space yang tidur, Space cadangan lewat `VOXCPM_SPACES`.
- Sample basi setelah Space restart terdeteksi dan di-upload ulang otomatis.
- Circuit breaker 30 detik setelah kena kuota/rate limit: request berikutnya langsung beralih, tidak menunggu sia-sia.
- Urutan cadangan saat VoxCPM gagal: (1) hasil clone tersimpan untuk teks yang sama, (2) suara Youdao (bukan clone), (3) JSON error yang jelas. Semuanya ditandai di header `X-TTS-*`.
- Batas waktu internal 45 detik + sisa waktu untuk cadangan, sehingga selalu menjawab sebelum Vercel memutus di 60 detik.
- Audio > 4.2 MB (batas respons Vercel 4.5 MB) dialihkan 302 ke URL file di Space.

## Uji lokal

```
npm test    # mock Gradio + simulasi routing Vercel; tidak menyentuh internet
```
