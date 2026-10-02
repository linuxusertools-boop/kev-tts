'use strict';
const { diagnose } = require('../lib/voxcpm');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const report = await diagnose();
    return res.status(report.ok ? 200 : 503).json(report);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
