'use strict';
// Uji cache Realtime DB: tersimpan per suara, terbaca lagi setelah "server baru", DB mati tidak merusak apa pun.
const http = require('http'), assert = require('assert');
const store = new Map(); let dbMode = 'ok', dbGets = 0, dbPuts = 0;
const db = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const key = u.pathname.replace(/\.json$/, '');
  if (dbMode === 'deny') { res.writeHead(401); return res.end('{"error":"Permission denied"}'); }
  if (req.method === 'PUT') { let b = ''; req.on('data', (c) => (b += c)); return req.on('end', () => { dbPuts++; store.set(key, JSON.parse(b)); res.writeHead(200); res.end(b); }); }
  dbGets++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(store.get(key) || null));
});
const wav = Buffer.alloc(4096, 3); wav.write('RIFF', 0); wav.write('WAVE', 8);
const gr = { calls: 0 };
const space = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const j = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const P = (component, label, d) => ({ label, parameter_name: label.toLowerCase(), component, parameter_has_default: true, parameter_default: d, type: {} });
  if (u.pathname === '/config') return j({ version: '6.0.0', api_prefix: '/gradio_api', components: [], dependencies: [] });
  if (u.pathname === '/gradio_api/info') return j({ named_endpoints: { '/tts': { parameters: [P('Textbox', 'Text', ''), P('Audio', 'Prompt audio', null)], returns: [{ component: 'Audio' }] } } });
  if (u.pathname === '/gradio_api/upload') { req.resume(); return req.on('end', () => j(['/tmp/u.mp3'])); }
  if (u.pathname.startsWith('/gradio_api/file=')) { res.writeHead(200); return res.end(wav); }
  if (u.pathname === '/gradio_api/call/tts' && req.method === 'POST') { req.resume(); return req.on('end', () => { gr.calls++; j({ event_id: 'e' }); }); }
  if (u.pathname === '/gradio_api/call/tts/e') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('event: complete\ndata: [{"path":"/tmp/o.wav"}]\n\n'); }
  j({}, 404);
});
const call = (handler, q) => new Promise((ok) => {
  const h = {}; const res = { statusCode: 200, setHeader: (k, v) => (h[k.toLowerCase()] = v), status(c) { this.statusCode = c; return this; }, json(o) { ok({ code: this.statusCode, h, body: o }); }, end(b) { ok({ code: this.statusCode, h, body: b }); }, send(b) { ok({ code: this.statusCode, h, body: b }); } };
  handler({ method: 'GET', query: q, headers: { host: 'x' }, url: '/' }, res);
});
const fresh = () => { for (const k of Object.keys(require.cache)) if (k.includes('/lib/')) delete require.cache[k]; return require('../lib/handler'); };
const fs = require('fs'), path = require('path');
const KAWAI = path.join(__dirname, '..', 'storage', 'kawai.mp3'); fs.copyFileSync(path.join(__dirname, '..', 'storage', 'sample.mp3'), KAWAI);
process.on('exit', () => { try { fs.unlinkSync(KAWAI); } catch {} });

db.listen(0, () => space.listen(0, async () => {
  process.env.FIREBASE_DB_URL = `http://127.0.0.1:${db.address().port}`;
  process.env.VOXCPM_SPACES = `http://127.0.0.1:${space.address().port}`;
  try {
    let h = fresh(), r = await call(h, { text: 'halo dunia', voice: 'sample' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.h['x-tts-cache'], 'miss'); assert.strictEqual(gr.calls, 1);
    await new Promise((ok) => setTimeout(ok, 100));
    assert.strictEqual(dbPuts, 1); assert.ok([...store.keys()][0].startsWith('/tts_cache/sample/'));
    console.log('✓ hasil clone disimpan di /tts_cache/sample/<hash>');

    h = fresh(); // "server baru": memori kosong
    r = await call(h, { text: 'halo dunia', voice: 'sample' });
    assert.strictEqual(r.h['x-tts-cache'], 'db'); assert.strictEqual(r.h['x-tts-engine'], 'kev-tts'); assert.strictEqual(gr.calls, 1);
    console.log('✓ server baru → dilayani dari Realtime DB, 0 request ke model');

    r = await call(h, { text: 'halo dunia', voice: 'kawai' });
    assert.strictEqual(r.h['x-tts-cache'], 'miss'); assert.strictEqual(gr.calls, 2);
    assert.ok([...store.keys()].some((k) => k.startsWith('/tts_cache/kawai/')));
    console.log('✓ suara lain, teks sama → cache terpisah (/tts_cache/kawai/…)');

    dbMode = 'deny'; h = fresh();
    r = await call(h, { text: 'teks baru', voice: 'sample' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.h['x-tts-engine'], 'kev-tts');
    console.log('✓ DB menolak (rules) → tetap menjawab normal, tanpa error');
    console.log('\nTES RTDB LULUS');
  } catch (e) { console.error('✗ GAGAL:', e); process.exitCode = 1; }
  db.close(); space.close(); process.exit(process.exitCode || 0);
}));
