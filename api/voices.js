'use strict';
const { listVoices, MAIN_VOICE } = require('../lib/voxcpm');

// Daftar semua suara: setiap file audio di storage/ otomatis jadi satu suara + satu endpoint /<nama>?text=
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const base = `${proto}://${req.headers.host || 'localhost'}`;
    const voices = listVoices().map((v) => ({
      id: v.id,
      default: v.id === MAIN_VOICE,
      file: `/storage/${v.name}`,
      endpoint: v.id === MAIN_VOICE ? `${base}/animemoe?text=` : `${base}/${v.id}?text=`,
      endpoint_alt: `${base}/${v.id}?text=`,
    }));
    res.status(200).json({ status: true, count: voices.length, default: MAIN_VOICE, voices });
  } catch (e) {
    res.status(200).json({ status: true, count: 0, voices: [], note: String((e && e.message) || e) });
  }
};
