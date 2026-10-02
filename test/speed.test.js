'use strict';
// Uji kecepatan & ketahanan pada SATU instance modul (cache/cooldown bertahan, seperti fungsi Vercel yang hangat).
const http = require('http'), assert = require('assert');

const wav = (() => { const sr = 16000, n = sr, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b; })();
const P = (component, label, d) => ({ label, parameter_name: label.toLowerCase(), component, parameter_has_default: true, parameter_default: d, type: {} });

const st = { uploads: 0, calls: 0, validPaths: new Set(), mode: 'ok', hits: 0 };
const gradio = http.createServer((req, res) => {
  st.hits++;
  const u = new URL(req.url, 'http://x'); const j = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/config') return j({ version: '6.0.0', api_prefix: '/gradio_api', components: [], dependencies: [] });
  if (u.pathname === '/gradio_api/info') return j({ named_endpoints: { '/tts': { parameters: [P('Textbox', 'Text', ''), P('Audio', 'Prompt audio', null)], returns: [{ component: 'Audio' }] } } });
  if (u.pathname === '/gradio_api/upload') { req.resume(); return req.on('end', () => { st.uploads++; const p = `/tmp/up${st.uploads}.mp3`; st.validPaths.add(p); j([p]); }); }
  if (u.pathname.startsWith('/gradio_api/file=')) { res.writeHead(200); return res.end(wav); }
  if (u.pathname === '/gradio_api/call/tts' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    return req.on('end', () => { st.calls++; st.lastData = JSON.parse(b).data; j({ event_id: 'e' }); });
  }
  if (u.pathname === '/gradio_api/call/tts/e') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (st.mode === 'down') return res.end('event: error\ndata: "boom"\n\n');
    if (st.mode === 'quota') return res.end('event: error\ndata: "You have exceeded your GPU quota"\n\n');
    if (!st.validPaths.has(st.lastData[1].path)) return res.end('event: error\ndata: "file not found"\n\n');
    res.write('event: complete\ndata: [{"path":"/tmp/o.wav"}]\n\n');
    if (st.mode === 'slowclose') return setTimeout(() => res.end(), 4000); // koneksi dibiarkan terbuka
    return res.end();
  }
  j({}, 404);
});

const realFetch = global.fetch; let youdaoHits = 0;
global.fetch = (url, o) => {
  if (String(url).includes('dict.youdao.com')) { youdaoHits++; return Promise.resolve(new Response(Buffer.alloc(2048, 7), { status: 200 })); }
  return realFetch(url, o);
};

const mk = () => { const r = { headers: {}, code: 200, body: null, setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, status(c) { r.code = c; return r; }, json(o) { r.body = o; return r; }, send(b) { r.body = b; return r; }, end() { return r; } }; return r; };
let handler;
const call = async (query, method = 'GET') => { const res = mk(); const t = Date.now(); await handler({ method, query, url: '/api/tts' }, res); res.ms = Date.now() - t; return res; };

gradio.listen(0, '127.0.0.1', async () => {
  process.env.VOXCPM_SPACES = `http://127.0.0.1:${gradio.address().port}`;
  handler = require('../lib/handler');
  try {
    let r = await call({ text: 'satu' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.headers['x-tts-engine'], 'voxcpm'); assert.strictEqual(r.headers['x-tts-cache'], 'miss');
    console.log(`✓ request dingin           ${String(r.ms).padStart(4)} ms  (upload=${st.uploads}, call=${st.calls})`);

    r = await call({ text: 'dua' });
    assert.strictEqual(st.uploads, 1, 'sample harus dipakai ulang dari cache upload');
    console.log(`✓ teks lain, upload di-cache ${String(r.ms).padStart(2)} ms  (upload=${st.uploads}, call=${st.calls})`);

    const hits0 = st.hits; r = await call({ text: 'satu' });
    assert.strictEqual(r.headers['x-tts-cache'], 'memory'); assert.strictEqual(st.hits, hits0, 'cache hit tidak boleh menyentuh upstream');
    console.log(`✓ teks sama → cache memori   ${String(r.ms).padStart(2)} ms  (0 request ke Space)`);

    const c0 = st.calls; const rs = await Promise.all([call({ text: 'ramai' }), call({ text: 'ramai' }), call({ text: 'ramai' })]);
    assert.strictEqual(st.calls - c0, 1); assert.ok(rs.every((x) => x.code === 200));
    console.log('✓ 3 request identik berbarengan → hanya 1 generate');

    st.mode = 'slowclose'; r = await call({ text: 'stream' });
    assert.strictEqual(r.code, 200); assert.ok(r.ms < 1500, `harus selesai sebelum koneksi SSE ditutup, tapi ${r.ms} ms`);
    console.log(`✓ SSE: jawaban dikirim begitu 'complete' tiba (${r.ms} ms, bukan 4000 ms)`);

    st.mode = 'ok'; st.validPaths.clear(); const up0 = st.uploads; r = await call({ text: 'restart' });
    assert.strictEqual(r.code, 200); assert.strictEqual(st.uploads, up0 + 1);
    console.log('✓ Space restart (path upload basi) → upload ulang otomatis, sukses');

    st.mode = 'down'; r = await call({ text: 'satu', nocache: '1' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.headers['x-tts-cache'], 'stale'); assert.strictEqual(r.headers['x-tts-engine'], 'voxcpm');
    console.log('✓ Space mati → hasil clone tersimpan disajikan (stale), bukan suara generik');

    r = await call({ text: 'belum pernah' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.headers['x-tts-engine'], 'youdao-fallback'); assert.match(r.headers['x-tts-note'], /gagal/);
    console.log('✓ Space mati + tak ada cache → suara cadangan, diberi catatan jelas');

    st.mode = 'quota'; await call({ text: 'kuota satu' });
    const h1 = st.hits; r = await call({ text: 'kuota dua' });
    assert.strictEqual(st.hits, h1, 'saat cooldown, Space tidak boleh dipukul lagi');
    assert.strictEqual(r.code, 200); assert.ok(r.ms < 200, `harus instan, tapi ${r.ms} ms`);
    console.log(`✓ kena kuota → circuit breaker, request berikutnya langsung cadangan (${r.ms} ms)`);

    const y0 = youdaoHits; r = await call({ text: 'cepat', fast: '1' });
    assert.strictEqual(r.headers['x-tts-engine'], 'youdao'); assert.strictEqual(youdaoHits, y0 + 1); assert.strictEqual(r.headers['x-tts-note'], undefined);
    console.log(`✓ fast=1 → langsung suara biasa (${r.ms} ms)`);

    const h2 = st.hits; r = await call({}, 'HEAD'); assert.strictEqual(r.code, 200); assert.strictEqual(st.hits, h2);
    console.log('✓ HEAD → 200 tanpa menyentuh Space');

    r = await call({ text: 'x', fallback: '0', nocache: '1' }); assert.ok(r.code >= 429 && r.body.status === false);
    console.log('✓ fallback=0 → error JSON jelas, bukan crash');
    console.log('\nTES KECEPATAN & KETAHANAN LULUS');
  } catch (e) { console.error('✗ GAGAL:', e); process.exitCode = 1; }
  gradio.close();
});
