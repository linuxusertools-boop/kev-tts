'use strict';
const { warm } = require('../lib/voxcpm');

// Panaskan fungsi + Space: baca skema & upload sample ke cache. Panggil dari pinger eksternal tiap ~5 menit.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const r = await warm();
    return res.status(r.ok ? 200 : 503).json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
