'use strict';
process.env.FIREBASE_DB_URL = 'off';
// Uji logika end-to-end terhadap MOCK server Gradio (bukan Space asli).
const http = require('http');
const assert = require('assert');

function wav(seconds = 1) {
  const sr = 16000, n = sr * seconds, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return b;
}

function makeServer(mode) {
  const state = { uploads: 0, lastData: null, port: 0 };
  const comps = [
    { id: 1, type: 'textbox', props: { label: 'Target Text', value: '' } },
    { id: 2, type: 'audio', props: { label: 'Reference Audio' } },
    { id: 3, type: 'textbox', props: { label: 'Prompt Text (transcript)', value: '' } },
    { id: 4, type: 'textbox', props: { label: 'Control Instruction', value: '' } },
    { id: 5, type: 'slider', props: { label: 'CFG', value: 2 } },
    { id: 6, type: 'slider', props: { label: 'Inference Timesteps', value: 10 } },
    { id: 7, type: 'checkbox', props: { label: 'Text Normalization', value: true } },
    { id: 8, type: 'checkbox', props: { label: 'Reference Denoising', value: false } },
    { id: 9, type: 'radio', props: { label: 'Mode', choices: [['Voice Design', 'Voice Design'], ['Controllable Cloning', 'Controllable Cloning'], ['Ultimate Cloning', 'Ultimate Cloning']], value: 'Voice Design' } },
    { id: 10, type: 'audio', props: { label: 'Output' } },
    { id: 11, type: 'textbox', props: { label: 'ASR out' } },
  ];
  const params = [
    ['Textbox', 'Target Text', ''], ['Audio', 'Reference Audio', null], ['Textbox', 'Prompt Text (transcript)', ''],
    ['Textbox', 'Control Instruction', ''], ['Slider', 'CFG', 2], ['Slider', 'Inference Timesteps', 10],
    ['Checkbox', 'Text Normalization', true], ['Checkbox', 'Reference Denoising', false],
    ['Radio', 'Mode', 'Voice Design'],
  ].map(([component, label, d]) => ({
    label, parameter_name: label.toLowerCase().replace(/\W+/g, '_'), component, parameter_has_default: true, parameter_default: d,
    type: component === 'Radio' ? { enum: ['Voice Design', 'Controllable Cloning', 'Ultimate Cloning'] } : {},
  }));
  const cfg = {
    version: '6.0.0', api_prefix: '/gradio_api', components: comps,
    dependencies: [
      { id: 0, api_name: 'asr', inputs: [2], outputs: [11] },
      { id: 1, api_name: 'generate', inputs: [1, 2, 3, 4, 5, 6, 7, 8, 9], outputs: [10] },
    ],
  };
  const info = { named_endpoints: {
    '/asr': { parameters: [params[1]], returns: [{ label: 'ASR out', component: 'Textbox' }] },
    '/generate': { parameters: params, returns: [{ label: 'Output', component: 'Audio' }] },
  } };
  let awake = mode !== 'sleeping';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/config') {
      if (!awake) { awake = true; res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Space is sleeping</html>'); }
      return json(cfg);
    }
    if (url.pathname === '/gradio_api/info') return json(info);
    if (url.pathname === '/gradio_api/upload' && req.method === 'POST') {
      state.uploads++; req.resume();
      return req.on('end', () => json(['/tmp/gradio/abc/sample.mp3']));
    }
    if (url.pathname.startsWith('/gradio_api/file=')) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(wav(1)); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.pathname === '/gradio_api/call/generate' && req.method === 'POST') {
        if (mode === 'queue') return json({ detail: 'Not Found' }, 404);
        state.lastData = JSON.parse(body).data;
        return json({ event_id: 'evt1' });
      }
      if (url.pathname === '/gradio_api/call/generate/evt1') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (mode === 'error') return res.end('event: error\ndata: null\n\n');
        if (mode === 'quota') return res.end('event: error\ndata: "You have exceeded your GPU quota"\n\n');
        return res.end(`event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"path":"/tmp/o.wav","url":"http://internal-host/gradio_api/file=/tmp/o.wav","meta":{"_type":"gradio.FileData"}}]\n\n`);
      }
      if (url.pathname === '/gradio_api/queue/join') { state.lastData = JSON.parse(body).data; return json({ event_id: 'q1' }); }
      if (url.pathname === '/gradio_api/queue/data') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`data: {"msg":"estimation"}\n\ndata: {"msg":"process_completed","success":true,"output":{"data":[{"path":"/tmp/o.wav","url":"/gradio_api/file=/tmp/o.wav"}]}}\n\n`);
      }
      json({ detail: 'nope' }, 404);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { state.port = server.address().port; r({ server, state }); }));
}

function fakeRes() {
  const r = { headers: {}, code: 200, body: null,
    setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, status(c) { r.code = c; return r; },
    json(o) { r.body = o; r.headers['content-type'] = 'application/json'; return r; },
    send(b) { r.body = b; return r; }, end() { return r; } };
  return r;
}

async function run(mode, query = {}, envx = {}) {
  const { server, state } = await makeServer(mode);
  process.env.VOXCPM_SPACES = `http://127.0.0.1:${state.port}`;
  Object.assign(process.env, envx);
  // modul baru tiap skenario → cache discovery bersih
  Object.keys(require.cache).filter((k) => /\/lib\//.test(k)).forEach((k) => delete require.cache[k]);
  const handler = require('../lib/handler');
  const res = fakeRes();
  await handler({ method: 'GET', query, url: '/api/tts' }, res);
  server.close();
  return { res, state };
}

(async () => {
  let t = Date.now();
  let { res, state } = await run('ok', { text: 'Halo dunia', steps: '8' }, { SAMPLE_TRANSCRIPT: '' });
  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  assert.strictEqual(res.headers['content-type'], 'audio/wav');
  assert.strictEqual(res.headers['x-tts-engine'], 'kev-tts');
  assert.strictEqual(res.headers['x-tts-cloned'], 'true');
  assert.ok(Buffer.isBuffer(res.body) && res.body.length > 1000);
  const d = state.lastData;
  assert.strictEqual(state.uploads, 1);
  assert.strictEqual(d[0], 'Halo dunia');                       // teks utama
  assert.strictEqual(d[1].path, '/tmp/gradio/abc/sample.mp3');   // audio referensi
  assert.strictEqual(d[1].meta._type, 'gradio.FileData');
  assert.strictEqual(d[2], '');                                  // prompt text
  assert.strictEqual(d[3], '');                                  // control
  assert.strictEqual(d[5], 8);                                   // steps dari query
  assert.strictEqual(d[6], true);
  assert.strictEqual(d[8], 'Controllable Cloning');              // tanpa transkrip → bukan Ultimate
  console.log('✓ alur normal (Gradio 6, /call)            ', Date.now() - t, 'ms');

  ({ res, state } = await run('ok', { text: 'x', prompt_text: 'halo ini transkrip' }));
  assert.strictEqual(state.lastData[2], 'halo ini transkrip');
  assert.strictEqual(state.lastData[8], 'Ultimate Cloning');
  console.log('✓ dengan transkrip → Ultimate Cloning');

  ({ res, state } = await run('queue', { text: 'fallback antrean' }));
  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  assert.strictEqual(state.lastData[0], 'fallback antrean');
  console.log('✓ /call 404 → protokol /queue/join');

  t = Date.now();
  ({ res } = await run('sleeping', { text: 'bangun' }));
  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  console.log('✓ Space tidur (HTML) → menunggu & berhasil  ', Date.now() - t, 'ms');

  ({ res } = await run('ok', { text: 'tanpa clone', clone: '0' }));
  assert.strictEqual(res.headers['x-tts-cloned'], 'false');
  console.log('✓ clone=0 → tidak upload sample');

  ({ res } = await run('quota', { text: 'x', fallback: '0' }));
  assert.strictEqual(res.code, 429);
  assert.strictEqual(res.body.code, 'ALL_ENGINES_FAILED');
  console.log('✓ kuota GPU → HTTP 429 JSON jelas');

  ({ res } = await run('error', { text: 'x', fallback: '0' }));
  assert.ok(res.code >= 500 && res.body.status === false);
  console.log('✓ error event Space → JSON error, tidak crash');

  ({ res } = await run('ok', { text: 'x', format: 'json' }));
  assert.strictEqual(res.body.status, true);
  assert.ok(res.body.audio.startsWith('data:audio/wav;base64,'));
  console.log('✓ format=json');

  ({ res } = await run('ok', { text: 'a'.repeat(900) }, { MAX_CHARS: '300' }));
  assert.strictEqual(res.headers['x-tts-truncated'], '300');
  console.log('✓ teks panjang dipotong aman');
  console.log('\nSEMUA TES MOCK LULUS');
})().catch((e) => { console.error('✗ GAGAL:', e); process.exit(1); });
