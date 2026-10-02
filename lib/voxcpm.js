'use strict';
/**
 * VoxCPM (Hugging Face Space / Gradio) client — tanpa dependency, murni fetch bawaan Node 18+.
 *
 * Kenapa tidak hard-code `/call/predict`?
 * Space resmi sudah berganti beberapa versi (Gradio 4 → 5 → 6, VoxCPM 1.5 → 2) dan signature
 * fungsinya ikut berubah. Jadi di sini skema dibaca LANGSUNG dari Space (/config + /info),
 * lalu endpoint & urutan input dipetakan otomatis berdasarkan tipe + label komponen.
 */

const fs = require('fs');
const path = require('path');

/* ───────────────────────── util dasar ───────────────────────── */

class TtsError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const DEFAULT_SPACE = 'https://openbmb-voxcpm-demo.hf.space';
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const env = (k, d = '') => String(process.env[k] || d).trim();
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const randHash = () => Math.random().toString(36).slice(2, 12);
const host = (u) => { try { return new URL(u).host; } catch { return String(u); } };

function getSpaces() {
  const l = list(env('VOXCPM_SPACES') || env('VOXCPM_SPACE'));
  return (l.length ? l : [DEFAULT_SPACE]).map((s) => s.replace(/\/+$/, ''));
}
const getTokens = () => list(env('HF_TOKENS') || env('HF_TOKEN'));

/* ───────────────────────── state per-instance (cache, cooldown) ───────────────────────── */

const lastPrefix = new Map();   // space -> api_prefix terakhir yang terdeteksi
const uploadCache = new Map();  // key -> { obj, at }   (sample yang sudah ada di Space)
const cooldown = new Map();     // `${space}|${token}` -> timestamp boleh dicoba lagi
const resultCache = new Map();  // key -> { v, at, bytes }
const inflight = new Map();     // key -> Promise  (request identik berbarengan dijadikan satu)
const UPLOAD_TTL = 8 * 60 * 1000;
const RESULT_FRESH = 60 * 60 * 1000;        // dianggap segar
const RESULT_KEEP = 24 * 60 * 60 * 1000;    // disimpan untuk cadangan saat upstream mati
const RESULT_MAX_BYTES = 24 * 1024 * 1024;
let resultBytes = 0;
const ck = (space, token) => `${space}|${token ? token.slice(-6) : 'anon'}`;
const uploadKey = (d, s) => `${d.space}|${d.prefix}|${s.name}|${s.size}`;

function baseHeaders(space, token) {
  const h = {
    'User-Agent': pick(USER_AGENTS),
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: space,
    Referer: `${space}/`,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function wrapNetwork(e) {
  if (e instanceof TtsError) return e;
  const n = e && e.name;
  if (n === 'TimeoutError' || n === 'AbortError') return new TtsError('TIMEOUT', 'Upstream terlalu lama merespons', 504);
  return new TtsError('UPSTREAM_UNREACHABLE', `Upstream tidak bisa dijangkau (${(e && (e.cause?.code || e.message)) || 'network'})`, 502);
}

function httpError(res, what) {
  const s = res.status;
  if (s === 401 || s === 403) return new TtsError('UPSTREAM_AUTH', `${what}: ditolak upstream (HTTP ${s})`, 502, { authFail: true });
  if (s === 429) return new TtsError('RATE_LIMITED', `${what}: kena rate limit upstream (HTTP 429)`, 429);
  if (s === 404) return new TtsError('SCHEMA_MISMATCH', `${what}: endpoint tidak ditemukan (HTTP 404)`, 502);
  if (s === 422) return new TtsError('SCHEMA_MISMATCH', `${what}: input ditolak upstream (HTTP 422)`, 502);
  if (s >= 500) return new TtsError('SPACE_UNAVAILABLE', `${what}: Space sedang bermasalah (HTTP ${s})`, 503);
  return new TtsError('UPSTREAM_ERROR', `${what}: HTTP ${s}`, 502);
}

/** fetch + timeout yang menghormati deadline global + retry/backoff untuk error sementara */
async function request(url, o) {
  const { method = 'GET', headers = {}, body, timeout = 15000, retries = 2, ctx, space, token } = o;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const left = ctx.deadline - Date.now();
    if (left < 800) throw new TtsError('TIMEOUT', 'Waktu habis sebelum upstream selesai', 504);
    try {
      const res = await fetch(url, {
        method,
        headers: { ...baseHeaders(space, token), ...headers },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(timeout, left)),
      });
      if (RETRY_STATUS.has(res.status) && i < retries) {
        const ra = Number(res.headers.get('retry-after'));
        await res.arrayBuffer().catch(() => {});
        lastErr = httpError(res, 'request');
        await sleep(Math.min(ra > 0 ? ra * 1000 : 400 * 2 ** i + Math.random() * 300, 3000, left / 4));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = wrapNetwork(e);
      if (lastErr.code === 'TIMEOUT' && ctx.deadline - Date.now() < 1500) throw lastErr;
      if (i < retries) await sleep(400 * 2 ** i + Math.random() * 300);
    }
  }
  throw lastErr || new TtsError('UPSTREAM_UNREACHABLE', 'Upstream tidak bisa dijangkau', 502);
}

async function readText(res) {
  try { return await res.text(); } catch (e) { throw wrapNetwork(e); }
}

async function getJson(url, o, what) {
  const res = await request(url, o);
  if (!res.ok) throw httpError(res, what);
  const text = await readText(res);
  try { return JSON.parse(text); } catch {
    // Space tidur / sedang build biasanya membalas halaman HTML, bukan JSON
    throw new TtsError('SPACE_SLEEPING', `${what}: Space sedang bangun / belum siap`, 503);
  }
}

/* ───────────────────────── sample audio ───────────────────────── */

const SAMPLE_NAMES = ['sample.mp4', 'sample.mp3', 'sample.wav', 'sample.m4a', 'sample.ogg', 'sample.flac', 'sample.webm'];
const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'audio/mp4', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm',
};

function sampleCandidates() {
  const dirs = [...new Set([
    path.join(process.cwd(), 'storage'),
    path.join(__dirname, '..', 'storage'),
    '/var/task/storage',
  ])];
  const custom = env('SAMPLE_PATH');
  const files = [];
  if (custom) {
    if (path.isAbsolute(custom)) files.push(custom);
    else dirs.forEach((d) => files.push(path.join(d, '..', custom), path.join(d, custom)));
  }
  dirs.forEach((d) => SAMPLE_NAMES.forEach((n) => files.push(path.join(d, n))));

  const seen = new Set();
  const out = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (!st.isFile() || st.size < 1024 || st.size > 10 * 1024 * 1024) continue;
      const key = `${path.basename(f)}:${st.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: f, name: path.basename(f), size: st.size, mime: MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    } catch { /* tidak ada, lanjut */ }
  }
  return out;
}

/* ───────────────────────── discovery skema Gradio ───────────────────────── */

const discoveryCache = new Map(); // space -> { at, d }
const DISCOVERY_TTL = 10 * 60 * 1000;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const SKIP_TYPES = new Set(['state', 'button', 'markdown', 'html', 'row', 'column', 'tab', 'tabs', 'group', 'accordion', 'label']);

function endpointsFromConfig(cfg) {
  const comps = new Map((cfg.components || []).map((c) => [c.id, c]));
  const out = {};
  for (const dep of cfg.dependencies || []) {
    if (!dep.api_name || dep.show_api === false) continue;
    const mapIn = (id) => comps.get(id);
    const parameters = (dep.inputs || []).map(mapIn).filter((c) => c && !SKIP_TYPES.has(c.type)).map((c) => ({
      label: c.props?.label || '',
      parameter_name: String(c.props?.label || c.type).toLowerCase().replace(/\W+/g, '_'),
      component: cap(c.type),
      parameter_has_default: true,
      parameter_default: c.props?.value ?? null,
      type: { enum: Array.isArray(c.props?.choices) ? c.props.choices.map((x) => (Array.isArray(x) ? x[1] : x)) : undefined },
    }));
    const returns = (dep.outputs || []).map(mapIn).filter(Boolean).map((c) => ({ label: c.props?.label || '', component: cap(c.type) }));
    out[`/${dep.api_name}`] = { parameters, returns, fn_index: dep.id };
  }
  return out;
}

async function discover(space, token, ctx, { force = false } = {}) {
  const c = discoveryCache.get(space);
  if (!force && c && Date.now() - c.at < DISCOVERY_TTL) return c.d;

  // Space yang tidur butuh beberapa detik untuk bangun → tunggu secukupnya, sisakan waktu untuk generate
  const wakeUntil = Math.max(Date.now() + 4000, Math.min(ctx.deadline - 18000, Date.now() + 25000));
  const opt = { ctx, space, token, timeout: 12000, retries: 1 };
  const infoTry = (pfx) => getJson(`${space}${pfx}/info`, opt, 'info').catch(() => null);
  let cfg, infoA, infoB;
  for (;;) {
    // config + info (kedua kemungkinan prefix) ditembak PARALEL → 1 round-trip, bukan 2
    const [rc, ra, rb] = await Promise.allSettled([
      getJson(`${space}/config`, opt, 'config'), infoTry('/gradio_api'), infoTry(''),
    ]);
    if (rc.status === 'fulfilled') { cfg = rc.value; infoA = ra.value; infoB = rb.value; break; }
    const e = rc.reason;
    if (e.code !== 'SPACE_SLEEPING' || Date.now() + 3500 > wakeUntil) throw e;
    await sleep(3000);
  }

  const prefix = String(cfg.api_prefix || '').replace(/\/+$/, '');
  let info = prefix === '/gradio_api' ? infoA : prefix === '' ? infoB : null;
  if (!info) info = await infoTry(prefix);
  let endpoints = info && info.named_endpoints;
  if (!endpoints || !Object.keys(endpoints).length) endpoints = endpointsFromConfig(cfg);

  const named = {};
  for (const [name, ep] of Object.entries(endpoints)) {
    const dep = (cfg.dependencies || []).find((x) => `/${x.api_name}` === name);
    named[name] = { ...ep, name, fn_index: ep.fn_index ?? dep?.id };
  }
  lastPrefix.set(space, prefix);
  const d = { space, prefix, cfg, version: cfg.version || null, endpoints: named };
  discoveryCache.set(space, { at: Date.now(), d });
  return d;
}

const compName = (x) => String(x?.component || x?.type || '').toLowerCase();
const isAudioIn = (p) => /^(audio|file|uploadbutton)$/.test(compName(p));
const isText = (p) => /^(textbox|textarea)$/.test(compName(p));
const labelOf = (p) => `${p.label || ''} ${p.parameter_name || ''}`.toLowerCase();
const RE_PROMPT = /prompt|reference|ref[_ ]|transcript|参考|参考文本/;
const RE_CONTROL = /control|instruction|style|控制|指令/;

function chooseEndpoint(endpoints, wantClone, forced) {
  if (forced) {
    const key = forced.startsWith('/') ? forced : `/${forced}`;
    if (endpoints[key]) return decorate(endpoints[key]);
  }
  let best = null;
  for (const ep of Object.values(endpoints)) {
    const params = ep.parameters || [];
    const returnsAudio = (ep.returns || []).some((r) => compName(r) === 'audio');
    if (!returnsAudio) continue;
    let s = 0;
    if (params.some(isText)) s += 10;
    const hasAudio = params.some(isAudioIn);
    if (wantClone) s += hasAudio ? 6 : -4;
    else s += hasAudio ? -2 : 2;
    if (/generate|tts|synth|clone|speech|predict/i.test(ep.name)) s += 3;
    if (/asr|recogni|transcri/i.test(ep.name)) s -= 20;
    if (!best || s > best.s) best = { s, ep };
  }
  return best ? decorate(best.ep) : null;
}
const decorate = (ep) => ({ ...ep, hasAudioIn: (ep.parameters || []).some(isAudioIn) });

function choicesOf(p) {
  if (Array.isArray(p.type?.enum)) return p.type.enum;
  const m = /Literal\[(.*)\]/.exec(p.python_type?.type || '');
  if (m) return [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
  return [];
}

function pickChoice(p, o) {
  const ch = choicesOf(p).map(String);
  if (!ch.length) return p.parameter_has_default ? p.parameter_default : null;
  const find = (re) => ch.find((c) => re.test(c));
  let v;
  if (o.cloning && o.promptText) v = find(/ultimate|极致/i);
  if (!v && o.cloning) v = find(/controllable|clon|克隆|可控/i);
  if (!v && !o.cloning) v = find(/design|设计/i);
  return v ?? (p.parameter_has_default && ch.includes(String(p.parameter_default)) ? p.parameter_default : ch[0]);
}

/** Petakan input kita → urutan parameter endpoint Gradio */
function buildData(ep, o, fileObj) {
  const params = ep.parameters || [];
  const texts = params.map((p, i) => ({ p, i })).filter((x) => isText(x.p));
  const mainCandidates = texts.filter((x) => !RE_PROMPT.test(labelOf(x.p)) && !RE_CONTROL.test(labelOf(x.p)));
  const main = mainCandidates.find((x) => /target|synth|generate|text/.test(labelOf(x.p))) || mainCandidates[0] || texts[0];
  if (!main) throw new TtsError('SCHEMA_MISMATCH', 'Space tidak punya input teks yang dikenali', 502);

  let audioUsed = false;
  const def = (p) => (p.parameter_has_default ? p.parameter_default : null);

  return params.map((p, i) => {
    const comp = compName(p);
    const label = labelOf(p);
    if (isAudioIn(p)) {
      if (!audioUsed && fileObj) { audioUsed = true; return fileObj; }
      return def(p);
    }
    if (isText(p)) {
      if (i === main.i) return o.text;
      if (RE_PROMPT.test(label)) return o.promptText || '';
      if (RE_CONTROL.test(label)) return o.control || '';
      return def(p) ?? '';
    }
    if (comp === 'slider' || comp === 'number') {
      if (/cfg|guidance/.test(label) && o.cfg != null) return o.cfg;
      if (/timestep|steps?\b/.test(label) && o.steps != null) return o.steps;
      return def(p);
    }
    if (comp === 'checkbox' || comp === 'checkboxgroup' || comp === 'switch') {
      if (/normaliz|规范|归一/.test(label)) return o.normalize ?? def(p) ?? true;
      if (/denois|降噪/.test(label)) return o.denoise ?? false;
      if (/asr|recogni|识别/.test(label)) return !o.promptText && !!fileObj;
      return def(p) ?? false;
    }
    if (comp === 'radio' || comp === 'dropdown') return pickChoice(p, { cloning: !!fileObj, promptText: o.promptText });
    return def(p);
  });
}

/* ───────────────────────── upload / call / download ───────────────────────── */

async function uploadSample(d, sample, token, ctx) {
  const buf = fs.readFileSync(sample.file);
  const form = new FormData();
  form.append('files', new Blob([buf], { type: sample.mime }), sample.name);
  const res = await request(`${d.space}${d.prefix}/upload`, { method: 'POST', body: form, ctx, space: d.space, token, timeout: 20000, retries: 2 });
  if (!res.ok) throw httpError(res, 'upload sample');
  let json;
  try { json = JSON.parse(await readText(res)); } catch { throw new TtsError('UPSTREAM_ERROR', 'Respons upload sample tidak valid', 502); }
  const first = Array.isArray(json) ? json[0] : null;
  const serverPath = typeof first === 'string' ? first : first?.path;
  if (!serverPath) throw new TtsError('UPSTREAM_ERROR', 'Upload sample ke Space gagal (path kosong)', 502);
  return {
    path: serverPath,
    url: `${d.space}${d.prefix}/file=${serverPath}`,
    orig_name: sample.name,
    size: sample.size,
    mime_type: sample.mime,
    is_stream: false,
    meta: { _type: 'gradio.FileData' },
  };
}

function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length || event !== 'message') events.push({ event, data: data.join('\n') });
  }
  return events;
}

function upstreamFailure(raw) {
  let msg = '';
  try { const j = JSON.parse(raw); msg = typeof j === 'string' ? j : (j && (j.error || j.message)) || ''; } catch { msg = raw; }
  msg = String(msg || '').slice(0, 300);
  if (/quota|exceed|zerogpu|too many|rate/i.test(msg)) return new TtsError('GPU_QUOTA', `Kuota GPU/rate limit Space habis${msg ? `: ${msg}` : ''}`, 429);
  return new TtsError('UPSTREAM_ERROR', msg ? `Space menolak: ${msg}` : 'Space mengembalikan error saat generate', 502, { modelError: true });
}

/** Baca SSE bertahap dan BERHENTI begitu handler mengembalikan true (tidak menunggu koneksi ditutup) */
async function streamSse(res, onEvent) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    for (const ev of parseSse(await readText(res))) if (onEvent(ev) === true) return true;
    return false;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = (final) => {
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const ev = parseSse(`${block}\n\n`)[0];
      if (ev && onEvent(ev) === true) return true;
    }
    if (final && buf.trim()) { const ev = parseSse(`${buf}\n\n`)[0]; buf = ''; if (ev && onEvent(ev) === true) return true; }
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
      if (flush(done)) return true;
      if (done) return false;
    }
  } catch (e) {
    throw wrapNetwork(e);
  } finally {
    reader.cancel().catch(() => {});
  }
}

const streamTimeout = (ctx) => Math.max(1500, ctx.deadline - Date.now() - 500);

async function callApi(d, ep, data, token, ctx) {
  const name = ep.name.replace(/^\//, '');
  const base = `${d.space}${d.prefix}`;
  const res = await request(`${base}/call/${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
    ctx, space: d.space, token, timeout: 20000, retries: 2,
  });
  if (res.status === 404 || res.status === 405) return queueCall(d, ep, data, token, ctx);
  if (!res.ok) throw httpError(res, 'submit job');
  let eventId;
  try { eventId = JSON.parse(await readText(res)).event_id; } catch { /* ditangani di bawah */ }
  if (!eventId) throw new TtsError('UPSTREAM_ERROR', 'Space tidak memberi event_id', 502);

  const sres = await request(`${base}/call/${encodeURIComponent(name)}/${eventId}`, {
    ctx, space: d.space, token, timeout: streamTimeout(ctx), retries: 0,
  });
  if (!sres.ok) throw httpError(sres, 'baca hasil');
  let out; let failure;
  await streamSse(sres, (e) => {
    if (e.event === 'complete') {
      try { out = JSON.parse(e.data); } catch { failure = new TtsError('UPSTREAM_ERROR', 'Hasil Space tidak bisa dibaca', 502); }
      return true;
    }
    if (e.event === 'error') { failure = upstreamFailure(e.data); return true; }
    return false;
  });
  if (out !== undefined && !failure) return out;
  throw failure || new TtsError('UPSTREAM_ERROR', 'Stream Space berakhir tanpa hasil', 502);
}

/** Fallback protokol antrean klasik (/queue/join) bila /call tidak tersedia */
async function queueCall(d, ep, data, token, ctx) {
  if (ep.fn_index == null) throw new TtsError('SCHEMA_MISMATCH', 'fn_index endpoint tidak diketahui', 502);
  const base = `${d.space}${d.prefix}`;
  const session_hash = randHash();
  const join = await request(`${base}/queue/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, fn_index: ep.fn_index, session_hash, event_data: null, trigger_id: null }),
    ctx, space: d.space, token, timeout: 20000, retries: 2,
  });
  if (!join.ok) throw httpError(join, 'queue/join');
  await join.arrayBuffer().catch(() => {});
  const sres = await request(`${base}/queue/data?session_hash=${session_hash}`, {
    ctx, space: d.space, token, timeout: streamTimeout(ctx), retries: 0,
  });
  if (!sres.ok) throw httpError(sres, 'queue/data');
  let out; let failure;
  await streamSse(sres, (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return false; }
    if (m.msg === 'queue_full') { failure = new TtsError('RATE_LIMITED', 'Antrean Space penuh', 429); return true; }
    if (m.msg === 'process_completed') {
      if (m.success === false) failure = upstreamFailure(JSON.stringify(m.output?.error || m.output || ''));
      else out = m.output?.data || [];
      return true;
    }
    return false;
  });
  if (out !== undefined && !failure) return out;
  throw failure || new TtsError('UPSTREAM_ERROR', 'Antrean Space berakhir tanpa hasil', 502);
}

function extractAudioRef(d, result) {
  const items = Array.isArray(result) ? result : [result];
  for (const it of items) {
    let u = null;
    if (it && typeof it === 'object') u = it.url || (it.path ? `${d.space}${d.prefix}/file=${it.path}` : null);
    else if (typeof it === 'string' && /\.(wav|mp3|ogg|flac|m4a)(\?|$)/i.test(it)) u = it.startsWith('http') ? it : `${d.space}${d.prefix}/file=${it}`;
    if (!u) continue;
    if (u.startsWith('/')) u = d.space + u;
    try {
      // Space kadang mengembalikan http:// atau host internal → paksa ke origin Space
      const parsed = new URL(u);
      if (/\/file=/.test(parsed.pathname)) u = d.space + parsed.pathname + parsed.search;
    } catch { /* biarkan apa adanya */ }
    return u;
  }
  throw new TtsError('NO_AUDIO', 'Space tidak mengembalikan file audio', 502);
}

function sniff(buf) {
  const s = (a, b) => buf.subarray(a, b).toString('latin1');
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3' };
  if (s(0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (s(0, 4) === 'fLaC') return { mime: 'audio/flac', ext: 'flac' };
  if (s(4, 8) === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  return { mime: 'application/octet-stream', ext: 'bin' };
}

async function download(url, d, token, ctx) {
  const res = await request(url, { ctx, space: d.space, token, timeout: 25000, retries: 2 });
  if (!res.ok) throw httpError(res, 'download audio');
  let buffer;
  try { buffer = Buffer.from(await res.arrayBuffer()); } catch (e) { throw wrapNetwork(e); }
  if (buffer.length < 512) throw new TtsError('NO_AUDIO', 'File audio dari Space kosong / terlalu kecil', 502);
  return { buffer, ...sniff(buffer) };
}

/* ───────────────────────── orkestrasi ───────────────────────── */

/** Sample yang sudah ter-upload dipakai ulang → hemat 1 request per generate */
async function getFileObj(d, sample, token, ctx, { fresh = false, pre = null } = {}) {
  const key = uploadKey(d, sample);
  const c = uploadCache.get(key);
  if (!fresh && c && Date.now() - c.at < UPLOAD_TTL) return { obj: c.obj, cached: true, key };
  const obj = pre || (await uploadSample(d, sample, token, ctx));
  uploadCache.set(key, { obj, at: Date.now() });
  return { obj, cached: false, key };
}

const STALE_UPLOAD_CODES = new Set(['SCHEMA_MISMATCH', 'UPSTREAM_ERROR', 'NO_AUDIO']);

async function runOnSpace(space, token, o, ctx) {
  const wantClone = o.clone !== false;
  const dc = discoveryCache.get(space);
  const cold = !dc || Date.now() - dc.at >= DISCOVERY_TTL;
  const samples0 = wantClone ? sampleCandidates() : [];

  // Space "dingin": upload sample dimulai SPEKULATIF berbarengan dengan discovery (hemat 1 round-trip)
  let pre = null;
  if (cold && samples0.length) {
    const guess = { space, prefix: lastPrefix.has(space) ? lastPrefix.get(space) : '/gradio_api' };
    const c = uploadCache.get(uploadKey(guess, samples0[0]));
    if (!(c && Date.now() - c.at < UPLOAD_TTL)) {
      pre = { prefix: guess.prefix, name: samples0[0].name, p: uploadSample(guess, samples0[0], token, ctx).catch(() => null) };
    }
  }

  const d = await discover(space, token, ctx);
  const forced = env('VOXCPM_API_NAME');

  let samples = [];
  let ep = chooseEndpoint(d.endpoints, wantClone, forced);
  if (!ep) throw new TtsError('SCHEMA_MISMATCH', 'Tidak ada endpoint TTS (output audio) di Space', 502);
  if (wantClone && ep.hasAudioIn) samples = samples0;
  if (wantClone && ep.hasAudioIn && !samples.length) {
    // sample tidak ada → coba endpoint tanpa input audio (voice default)
    const alt = chooseEndpoint(d.endpoints, false, forced);
    if (alt && !alt.hasAudioIn) ep = alt;
    else throw new TtsError('SAMPLE_MISSING', 'File storage/sample.* tidak ditemukan di deployment', 500);
  }

  let preObj = null;
  if (pre && samples.length && pre.prefix === d.prefix) preObj = await pre.p;

  const attempts = samples.length ? samples.slice(0, 2) : [null];
  let lastErr;
  for (const s of attempts) {
    for (let pass = 0; pass < 2; pass++) {
      let used = null;
      try {
        let fileObj = null;
        if (s) {
          used = await getFileObj(d, s, token, ctx, { fresh: pass === 1, pre: s.name === pre?.name ? preObj : null });
          fileObj = used.obj;
        }
        const data = buildData(ep, o, fileObj);
        const result = await callApi(d, ep, data, token, ctx);
        const url = extractAudioRef(d, result);
        const audio = await download(url, d, token, ctx);
        return { ...audio, upstreamUrl: url, engine: 'voxcpm', cloned: !!s, sample: s ? s.name : null, endpoint: ep.name };
      } catch (e) {
        lastErr = e;
        // sample di cache bisa kedaluwarsa (Space restart) → upload ulang sekali
        if (used && used.cached && pass === 0 && STALE_UPLOAD_CODES.has(e.code)) { uploadCache.delete(used.key); continue; }
        if (!e.modelError) throw e; // hanya error dari model (mis. sample tak terbaca) yang layak coba sample lain
        break;
      }
    }
  }
  throw lastErr;
}

function summarize(errors) {
  const codes = errors.map((e) => e.code);
  if (codes.includes('GPU_QUOTA') || codes.includes('RATE_LIMITED')) return 429;
  if (codes.every((c) => c === 'TIMEOUT')) return 504;
  return 502;
}

async function synthesizeRaw(o) {
  const ctx = { deadline: Date.now() + (o.budgetMs || Number(env('BUDGET_MS')) || 45000) };
  const tokens = getTokens();
  let plan = [];
  for (const s of shuffle(getSpaces())) {
    shuffle(tokens).slice(0, 2).forEach((t) => plan.push([s, t]));
    plan.push([s, null]); // terakhir selalu anonim, kalau-kalau token invalid
  }
  plan = plan.slice(0, 4);

  // circuit breaker: lewati space/token yang baru saja kena limit, supaya tidak menunggu sia-sia
  const now = Date.now();
  const live = plan.filter(([s, t]) => (cooldown.get(ck(s, t)) || 0) <= now);
  if (!live.length) {
    throw new TtsError('GPU_QUOTA', 'Space masih dalam masa tunggu setelah kena limit', 429, { errors: [] });
  }

  const errors = [];
  for (const [space, token] of live) {
    if (ctx.deadline - Date.now() < 3000) break;
    try {
      return await runOnSpace(space, token, o, ctx);
    } catch (e) {
      const err = wrapNetwork(e);
      errors.push({ space: host(space), code: err.code || 'ERROR', message: err.message, status: err.status });
      if (err.code === 'SCHEMA_MISMATCH' || err.code === 'SPACE_SLEEPING') discoveryCache.delete(space);
      if (err.code === 'GPU_QUOTA' || err.code === 'RATE_LIMITED') cooldown.set(ck(space, token), Date.now() + 30000);
      if (err.code === 'UPSTREAM_AUTH' && token) cooldown.set(ck(space, token), Date.now() + 10 * 60000);
      if (err.code === 'SAMPLE_MISSING') break; // percuma dicoba lagi
      await sleep(150 + Math.random() * 250);
    }
  }
  const last = errors[errors.length - 1];
  throw new TtsError(
    errors.length && errors.every((e) => e.code === 'SAMPLE_MISSING') ? 'SAMPLE_MISSING' : 'ALL_ENGINES_FAILED',
    last ? `Semua percobaan ke VoxCPM gagal: ${last.message}` : 'Waktu habis sebelum sempat menghubungi VoxCPM',
    last?.code === 'SAMPLE_MISSING' ? 500 : summarize(errors),
    { errors },
  );
}

/* ── cache hasil + penggabungan request identik ── */
const cacheKey = (o) => JSON.stringify([o.text, o.promptText || '', o.control || '', o.cfg ?? null, o.steps ?? null, o.normalize ?? null, o.denoise ?? null, o.clone !== false]);

function cacheGet(k, maxAge) {
  const e = resultCache.get(k);
  if (!e || Date.now() - e.at > maxAge) return null;
  resultCache.delete(k); resultCache.set(k, e); // segarkan urutan LRU
  return e.v;
}
function cachePut(k, v) {
  const bytes = v.buffer.length;
  if (bytes > RESULT_MAX_BYTES / 2) return;
  const old = resultCache.get(k);
  if (old) { resultBytes -= old.bytes; resultCache.delete(k); }
  resultCache.set(k, { v, at: Date.now(), bytes });
  resultBytes += bytes;
  for (const [key, e] of resultCache) {
    if (resultBytes <= RESULT_MAX_BYTES && Date.now() - e.at <= RESULT_KEEP) break;
    resultCache.delete(key); resultBytes -= e.bytes;
  }
}

/** Hasil basi (≤24 jam) — dipakai handler sebagai cadangan terbaik saat VoxCPM sedang mati */
function peekStale(o) {
  const v = cacheGet(cacheKey(o), RESULT_KEEP);
  return v ? { ...v, cache: 'stale' } : null;
}

/**
 * @param {{text:string, promptText?:string, control?:string, cfg?:number, steps?:number,
 *          normalize?:boolean, denoise?:boolean, clone?:boolean, budgetMs?:number, nocache?:boolean}} o
 */
async function synthesize(o) {
  const k = cacheKey(o);
  if (!o.nocache) {
    const hit = cacheGet(k, RESULT_FRESH);
    if (hit) return { ...hit, cache: 'memory' };
  }
  if (inflight.has(k)) return { ...(await inflight.get(k)), cache: 'coalesced' };
  const p = synthesizeRaw(o).then((v) => { cachePut(k, v); return { ...v, cache: 'miss' }; });
  inflight.set(k, p);
  p.then(() => inflight.delete(k), () => inflight.delete(k));
  return p;
}

/** Untuk /api/status: cek Space & endpoint yang akan dipakai, tanpa generate audio */
async function diagnose() {
  const ctx = { deadline: Date.now() + 40000 };
  const tokens = getTokens();
  const spaces = [];
  for (const space of getSpaces()) {
    const row = { host: host(space), reachable: false };
    try {
      const d = await discover(space, pick(tokens.length ? tokens : [null]), ctx, { force: true });
      const ep = chooseEndpoint(d.endpoints, true, env('VOXCPM_API_NAME'));
      row.reachable = true;
      row.gradio_version = d.version;
      row.api_prefix = d.prefix || '(none)';
      row.endpoints = Object.keys(d.endpoints);
      row.selected_endpoint = ep ? ep.name : null;
      row.parameters = ep ? ep.parameters.map((p) => `${p.component}: ${p.label || p.parameter_name}`) : [];
      if (!ep) row.error = 'Tidak ada endpoint dengan output audio';
    } catch (e) {
      row.error = `${e.code || 'ERROR'}: ${e.message}`;
    }
    spaces.push(row);
  }
  return {
    ok: spaces.some((s) => s.reachable && s.selected_endpoint),
    spaces,
    sample: sampleCandidates().map((s) => ({ name: s.name, bytes: s.size, mime: s.mime })),
    config: { hf_tokens: tokens.length, max_chars: Number(env('MAX_CHARS', '300')), node: process.version },
  };
}

/** Pemanasan: discovery + upload sample ke cache, supaya request pertama pengguna cepat */
async function warm() {
  const t0 = Date.now();
  const ctx = { deadline: t0 + 40000 };
  const tokens = getTokens();
  const spaces = [];
  for (const space of getSpaces()) {
    const row = { host: host(space), ready: false };
    try {
      const token = pick(tokens.length ? tokens : [null]);
      const d = await discover(space, token, ctx);
      const ep = chooseEndpoint(d.endpoints, true, env('VOXCPM_API_NAME'));
      const sample = sampleCandidates()[0];
      row.ready = !!ep;
      row.endpoint = ep ? ep.name : null;
      if (ep && ep.hasAudioIn && sample) { await getFileObj(d, sample, token, ctx); row.sample_cached = sample.name; }
    } catch (e) {
      row.error = `${e.code || 'ERROR'}: ${e.message}`;
    }
    spaces.push(row);
  }
  return { ok: spaces.some((r) => r.ready), ms: Date.now() - t0, spaces };
}

module.exports = { synthesize, peekStale, warm, diagnose, sampleCandidates, TtsError, _internal: { parseSse, buildData, chooseEndpoint, sniff } };
