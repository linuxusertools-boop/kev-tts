'use strict';
// Simulasi routing Vercel (rewrites + public/) di atas handler asli, memakai mock Gradio dari mock.test.js.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
assert.ok(vercel.functions['api/*.js'].maxDuration >= 10 && vercel.functions['api/*.js'].includeFiles === 'storage/**');

// mock Gradio minimal (ringkas)
const wavBuf = (() => { const sr = 16000, n = sr, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b; })();
const P = (component, label, d) => ({ label, parameter_name: label.toLowerCase(), component, parameter_has_default: true, parameter_default: d, type: {} });
const gradio = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/config') return j({ version: '5.0.0', api_prefix: '/gradio_api', components: [], dependencies: [] });
  if (u.pathname === '/gradio_api/info') return j({ named_endpoints: { '/tts': { parameters: [P('Textbox', 'Text', ''), P('Audio', 'Prompt audio', null)], returns: [{ component: 'Audio' }] } } });
  if (u.pathname === '/gradio_api/upload') { req.resume(); return req.on('end', () => j(['/tmp/s.mp3'])); }
  if (u.pathname.startsWith('/gradio_api/file=')) { res.writeHead(200); return res.end(wavBuf); }
  if (u.pathname === '/gradio_api/call/tts' && req.method === 'POST') { req.resume(); return req.on('end', () => j({ event_id: 'e' })); }
  if (u.pathname === '/gradio_api/call/tts/e') { res.writeHead(200); return res.end('event: complete\ndata: [{"path":"/tmp/o.wav"}]\n\n'); }
  res.writeHead(404); res.end('{}');
});

gradio.listen(0, '127.0.0.1', async () => {
  process.env.VOXCPM_SPACES = `http://127.0.0.1:${gradio.address().port}`;
  const routes = { '/api/tts': require('../api/tts'), '/api/animemoe': require('../api/animemoe'), '/api/status': require('../api/status') };
  const rewrite = Object.fromEntries(vercel.rewrites.map((r) => [r.source, r.destination]));

  const app = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); let p = rewrite[u.pathname] || u.pathname;
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    res.send = (b) => { res.end(b); return res; };
    if (routes[p]) { req.query = Object.fromEntries(u.searchParams); return routes[p](req, res); }
    if (p === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'))); }
    res.statusCode = 404; res.end('nf');
  });
  app.listen(0, async () => {
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      let r = await fetch(`${base}/`); assert.strictEqual(r.status, 200); assert.match(await r.text(), /Try it out/);
      console.log('✓ GET /  → halaman utama + "Try it out"');
      for (const route of ['/animemoe', '/tts', '/api/tts']) {
        r = await fetch(`${base}${route}?text=halo`); const b = Buffer.from(await r.arrayBuffer());
        assert.strictEqual(r.status, 200, route); assert.strictEqual(r.headers.get('content-type'), 'audio/wav'); assert.strictEqual(b.subarray(0, 4).toString(), 'RIFF');
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        assert.match(r.headers.get('cache-control'), /s-maxage=86400/);
        console.log(`✓ GET ${route}?text=halo → ${b.length} byte WAV, engine=${r.headers.get('x-tts-engine')}`);
      }
      r = await fetch(`${base}/status`); const s = await r.json();
      assert.strictEqual(s.ok, true); assert.ok(s.sample.length >= 1); assert.strictEqual(s.spaces[0].selected_endpoint, '/tts');
      console.log('✓ /status → ok, sample terdeteksi:', s.sample.map((x) => `${x.name} (${x.bytes} B)`).join(', '));
      console.log('\nTES HTTP LULUS');
    } catch (e) { console.error('✗', e); process.exitCode = 1; }
    app.close(); gradio.close();
  });
});
