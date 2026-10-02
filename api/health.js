'use strict';
// Cek hidup instan: tidak menyentuh Hugging Face. Aman dipanggil pinger tiap menit.
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ts: Date.now(), node: process.version });
};
