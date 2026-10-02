'use strict';
const { synthesize, peekStale, TtsError } = require('./voxcpm');
const { youdao } = require('./fallback');

const DEFAULT_TEXT = 'Konnichiwa! Silakan masukkan teks yang ingin diubah menjadi suara.';
const MAX_INLINE_BYTES = 4.2 * 1024 * 1024; // batas respons serverless Vercel = 4.5 MB
const MAX_JSON_B64_BYTES = 3 * 1024 * 1024;
const FALLBACK_RESERVE_MS = 9000;           // waktu yang selalu disisakan agar suara cadangan sempat jalan

const first = (v) => (Array.isArray(v) ? v[0] : v);
const bool = (v, d) => {
  v = first(v);
  if (v === undefined || v === null || v === '') return d;
  return !/^(0|false|no|off)$/i.test(String(v));
};
const num = (v, min, max) => {
  v = first(v);
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

function readParams(req) {
  let q = req.query;
  if (!q) { try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch { q = {}; } }
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  if (!b || typeof b !== 'object' || Buffer.isBuffer(b)) b = {};
  return { ...q, ...b };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-TTS-Engine, X-TTS-Cloned, X-TTS-Cache, X-TTS-Elapsed-Ms, X-TTS-Truncated, X-TTS-Note');
}

function fail(res, err, extra = {}) {
  const status = err.status && err.status >= 400 ? err.status : 502;
  res.setHeader('Cache-Control', 'no-store');
  if (status === 429 || status === 503) res.setHeader('Retry-After', '15');
  return res.status(status).json({
    status: false,
    code: err.code || 'ERROR',
    message: err.message,
    attempts: err.errors,
    ...extra,
  });
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, HEAD, OPTIONS');
    return fail(res, new TtsError('METHOD_NOT_ALLOWED', 'Gunakan GET atau POST', 405));
  }
  // HEAD = cek hidup yang murah (tidak memicu generate, tidak memakai kuota GPU)
  if (req.method === 'HEAD') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Note', 'HEAD tidak men-generate audio');
    return res.status(200).end();
  }

  const started = Date.now();
  try {
    const p = readParams(req);
    let text = String(first(p.text ?? p.q) ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || DEFAULT_TEXT;
    const max = Math.min(Math.max(parseInt(process.env.MAX_CHARS, 10) || 300, 20), 1000);
    const chars = [...text];
    const truncated = chars.length > max;
    if (truncated) text = chars.slice(0, max).join('');

    // waktu total fungsi 60 dtk (maxDuration); VoxCPM dibatasi supaya cadangan selalu sempat jalan
    const totalMs = (num(p.timeout, 5, 50) || Number(process.env.BUDGET_MS) / 1000 || 45) * 1000;
    const o = {
      text,
      promptText: String(first(p.prompt_text) ?? process.env.SAMPLE_TRANSCRIPT ?? '').trim(),
      control: String(first(p.control) ?? '').trim(),
      cfg: num(p.cfg, 0.5, 5),
      steps: num(p.steps, 4, 30),
      normalize: bool(p.normalize, undefined),
      denoise: bool(p.denoise, undefined),
      clone: bool(p.clone, true),
      nocache: bool(p.nocache, false),
      budgetMs: Math.max(4000, Math.min(totalMs, 50000)),
    };
    const allowFallback = bool(p.fallback, true);
    const fast = bool(p.fast, false);

    let result;
    let primaryError;
    if (fast) {
      // mode cepat: suara biasa (bukan clone) ~sub-detik; bila gagal, jatuh ke VoxCPM
      try { result = await youdao(text, first(p.lang), 'youdao'); } catch (e) { primaryError = e; }
    }
    if (!result) {
      try {
        result = await synthesize(o);
      } catch (e) {
        primaryError = e;
        const stale = peekStale(o);
        if (stale) {
          result = stale; // hasil clone lama untuk teks yang sama > suara generik
        } else if (!allowFallback) {
          return fail(res, e);
        } else {
          try {
            result = await youdao(text, first(p.lang));
          } catch (e2) {
            return fail(res, e, { fallback_error: e2.message });
          }
        }
      }
    }

    const elapsed = Date.now() - started;
    const isVox = result.engine === 'voxcpm';
    const degraded = !!primaryError && !fast; // suara cadangan karena kegagalan, bukan pilihan
    res.setHeader('X-TTS-Engine', result.engine);
    res.setHeader('X-TTS-Cloned', String(!!result.cloned));
    res.setHeader('X-TTS-Cache', result.cache || 'none');
    res.setHeader('X-TTS-Elapsed-Ms', String(elapsed));
    if (truncated) res.setHeader('X-TTS-Truncated', String(max));
    if (degraded) {
      res.setHeader('X-TTS-Note', result.cache === 'stale'
        ? `VoxCPM gagal (${primaryError.code || 'ERROR'}); memakai hasil clone tersimpan`
        : `VoxCPM gagal (${primaryError.code || 'ERROR'}); memakai suara cadangan`);
    }

    // hasil darurat tidak boleh "menempel" lama di CDN
    const cacheable = !bool(p.nocache, false);
    res.setHeader(
      'Cache-Control',
      !cacheable ? 'no-store' : degraded ? 'public, max-age=30, s-maxage=30' : isVox ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800' : 'public, max-age=3600, s-maxage=86400',
    );

    const format = String(first(p.format) || 'audio').toLowerCase();
    if (format === 'json') {
      return res.status(200).json({
        status: true,
        engine: result.engine,
        cloned: !!result.cloned,
        cache: result.cache || 'none',
        mime: result.mime,
        bytes: result.buffer.length,
        elapsed_ms: elapsed,
        truncated,
        text,
        url: result.upstreamUrl || null,
        audio: result.buffer.length <= MAX_JSON_B64_BYTES ? `data:${result.mime};base64,${result.buffer.toString('base64')}` : null,
      });
    }

    if (result.buffer.length > MAX_INLINE_BYTES && result.upstreamUrl) {
      res.setHeader('Location', result.upstreamUrl);
      return res.status(302).end();
    }

    const disp = bool(p.download, false) ? 'attachment' : 'inline';
    res.setHeader('Content-Type', result.mime);
    res.setHeader('Content-Disposition', `${disp}; filename="tts.${result.ext}"`);
    res.setHeader('Content-Length', String(result.buffer.length));
    return res.status(200).send(result.buffer);
  } catch (e) {
    console.error('[tts] fatal:', e && e.message);
    return fail(res, e instanceof TtsError ? e : new TtsError('INTERNAL', 'Kesalahan internal tak terduga', 500));
  }
};
