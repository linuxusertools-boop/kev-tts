'use strict';
/**
 * Cache hasil suara di Firebase Realtime Database (REST, tanpa SDK).
 * Struktur:  /tts_cache/<suara>/<hash>  → { b: base64, m: mime, e: ext, c: cloned, s: sample, t: teks, n: bytes, at: ms }
 * Setiap suara punya "folder" sendiri, jadi cache antar suara tidak pernah tercampur.
 *
 * Auth (pilih salah satu, opsional):
 *   FIREBASE_SERVICE_ACCOUNT = isi JSON service account  → rules boleh dikunci penuh (disarankan)
 *   FIREBASE_DB_SECRET       = database secret lama
 *   (kosong)                  → rules harus mengizinkan tulis ke /tts_cache (lihat database.rules.json)
 */
const crypto = require('crypto');

const DEFAULT_URL = 'https://cache-tts-default-rtdb.asia-southeast1.firebasedatabase.app';
const ROOT = 'tts_cache';
const MAX_BYTES = 6 * 1024 * 1024;

const baseUrl = () => {
  const u = String(process.env.FIREBASE_DB_URL || DEFAULT_URL).trim();
  return u.toLowerCase() === 'off' ? null : u.replace(/\/+$/, '');
};
const enabled = () => !!baseUrl();

let downUntil = 0; // circuit breaker: saat DB bermasalah, jangan menunda request
const down = (ms = 30000) => { downUntil = Date.now() + ms; };
const usable = () => enabled() && Date.now() >= downUntil;

/* ── token service account (JWT RS256 → access token Google) ── */
let sa; let tok = { v: null, exp: 0 };
function account() {
  if (sa !== undefined) return sa;
  try { sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null; } catch { sa = null; }
  return sa;
}
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
async function accessToken() {
  const a = account();
  if (!a) return null;
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: a.client_email, sub: a.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(a.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}`,
    signal: AbortSignal.timeout(4000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token Firebase gagal');
  tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000 };
  return tok.v;
}

async function url(path, extra = '') {
  let q = extra;
  const t = await accessToken();
  if (t) q += `${q ? '&' : ''}access_token=${encodeURIComponent(t)}`;
  else if (process.env.FIREBASE_DB_SECRET) q += `${q ? '&' : ''}auth=${encodeURIComponent(process.env.FIREBASE_DB_SECRET)}`;
  return `${baseUrl()}/${path}.json${q ? `?${q}` : ''}`;
}

const safe = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'sample';
/** hash kunci cache (tanpa suara; suara jadi folder terpisah) */
const hash = (parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex');

async function get(voice, h, timeoutMs = 1200) {
  if (!usable()) return null;
  try {
    const r = await fetch(await url(`${ROOT}/${safe(voice)}/${h}`), { signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 401 || r.status === 403) { down(300000); return null; }
    if (!r.ok) { down(); return null; }
    const d = await r.json();
    if (!d || typeof d.b !== 'string' || !d.m) return null;
    const buffer = Buffer.from(d.b, 'base64');
    if (!buffer.length) return null;
    return { buffer, mime: d.m, ext: d.e || 'bin', engine: 'voxcpm', cloned: !!d.c, sample: d.s || null, endpoint: 'db' };
  } catch { down(10000); return null; }
}

async function put(voice, h, v, text) {
  if (!usable() || !v || !v.buffer || v.buffer.length > MAX_BYTES || v.engine !== 'voxcpm') return false;
  try {
    const r = await fetch(await url(`${ROOT}/${safe(voice)}/${h}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ b: v.buffer.toString('base64'), m: v.mime, e: v.ext, c: !!v.cloned, s: v.sample || null, t: String(text || '').slice(0, 300), n: v.buffer.length, at: Date.now() }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 401 || r.status === 403) { down(300000); return false; }
    if (!r.ok) { down(); return false; }
    return true;
  } catch { down(10000); return false; }
}

/** Ringkasan untuk /status */
async function ping() {
  if (!enabled()) return { enabled: false };
  const t0 = Date.now();
  try {
    const r = await fetch(await url(ROOT, 'shallow=true'), { signal: AbortSignal.timeout(3000) });
    const body = r.ok ? await r.json() : null;
    if (r.ok) { downUntil = 0; }
    return { enabled: true, ok: r.ok, http: r.status, ms: Date.now() - t0, voices: body ? Object.keys(body) : [], hint: r.ok ? undefined : 'periksa Rules / FIREBASE_SERVICE_ACCOUNT' };
  } catch (e) { return { enabled: true, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) }; }
}

/** Jaga fungsi serverless tetap hidup sampai tugas latar selesai (Vercel waitUntil), jika tersedia */
let wu;
function keepAlive(p) {
  if (wu === undefined) { try { wu = require('@vercel/functions').waitUntil; } catch { wu = null; } }
  if (typeof wu === 'function') { try { wu(p); return true; } catch { /* abaikan */ } }
  return false;
}

module.exports = { enabled, get, put, ping, hash, safe, keepAlive };
