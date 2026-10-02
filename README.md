# kev-tts

API teks → suara dengan voice clone, men-scrape Space Hugging Face
[openbmb-voxcpm-demo](https://openbmb-voxcpm-demo.hf.space/). Siap deploy ke Vercel, tanpa dependency.

## Pakai

```
GET  /api/tts?text=Halo dunia            → audio
POST /api/tts  {"text":"Halo dunia"}     → audio
GET  /api/tts?text=Halo&format=json      → JSON + data URI base64
GET  /api/status                         → diagnosa Space, endpoint terdeteksi, sample
```

`/tts` dan `/animemoe` (endpoint lama) memakai handler yang sama. Halaman utama `/` punya **Try it out**.
Parameter lengkap ada di halaman utama.

## Deploy

1. Push folder ini ke GitHub → import di Vercel (Framework: Other). Tidak perlu build command.
2. Buka `/api/status` setelah deploy. `ok: true` berarti Space terjangkau dan sample terbaca.
3. (Disarankan) isi `HF_TOKEN` di Environment Variables supaya kuota GPU tidak cepat habis.

## Sample suara

Taruh file di `storage/`. Urutan yang dicari: `sample.mp4`, `sample.mp3`, `sample.wav`, `sample.m4a`, `sample.ogg`, `sample.flac`.
File lain bisa dipilih lewat `SAMPLE_PATH`. Pakai **file audio sungguhan** (mp3/wav, mono, 5–15 detik, bersih).
Berkas `.mp4` berisi video bisa gagal didekode oleh model.

## Cara kerja anti-error

- Skema Space dibaca langsung dari `/config` dan `/info`, jadi tahan terhadap perubahan versi Gradio/VoxCPM.
- Retry + backoff untuk 429/5xx/timeout, menunggu Space yang sedang tidur, rotasi `HF_TOKENS`, daftar Space cadangan di `VOXCPM_SPACES`.
- Respons GET di-cache CDN (`s-maxage` 24 jam), sehingga teks yang sama tidak memukul Space lagi.
- Audio > 4.2 MB (batas respons Vercel 4.5 MB) dialihkan 302 ke URL file di Space.
- Bila VoxCPM gagal total: suara cadangan Youdao (bukan clone, ditandai `X-TTS-Engine: youdao-fallback`). Matikan dengan `fallback=0`.

## Uji lokal

```
npm test    # mock Gradio + simulasi routing Vercel; tidak menyentuh internet
```
