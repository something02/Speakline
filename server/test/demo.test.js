'use strict';
/* DEMO_MODE (no Paddle contract) + OpenAI-format AI provider (e.g. DeepSeek). The provider is mocked. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os'), path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'speakline-demo-' + Date.now() + '.db');
process.env.DEMO_MODE = '1';                 // no SMTP_URL → sign-in code is echoed
process.env.APP_ORIGIN = 'http://localhost:8080';
process.env.AI_API_KEY = 'sk-deepseek-test';
process.env.AI_MODEL = 'deepseek-flash';
const { server } = require('../server.js');

let base, mock, seen = [];
test.before(() => new Promise(r => {
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers['x-api-key'], body: JSON.parse(b) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Good pace. Replace “um” with a pause.' } }] }));
    });
  }).listen(0, () => {
    process.env.AI_API_URL = 'http://127.0.0.1:' + mock.address().port + '/chat/completions';
    server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); });
  });
}));
test.after(() => { server.close(); mock.close(); });
const call = (method, p, body, token) => fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
const REQ = { lang: 'en', ui: 'en', mode: 'free', task: 'Tell us about yourself', transcript: 'so um I build products', metrics: { wpm: 150, fillers: 1, score: 70 } };

let token;
test('demo: code is shown, no premium before the demo payment', async () => {
  const s = await (await call('POST', '/api/auth/start', { email: 'demo@example.com' })).json();
  assert.match(String(s.dev_code), /^\d{6}$/);
  token = (await (await call('POST', '/api/auth/verify', { email: 'demo@example.com', code: s.dev_code })).json()).token;
  assert.equal((await (await call('GET', '/api/me', undefined, token)).json()).premium, false);
  assert.equal((await call('POST', '/api/coach', REQ, token)).status, 402);
});

test('demo payment records the plan and the pack', async () => {
  assert.equal((await call('POST', '/api/demo/subscribe', { plan: 'quarter' })).status, 401);
  assert.equal((await call('POST', '/api/demo/subscribe', { plan: 'lifetime' }, token)).status, 400);
  const m = await (await call('POST', '/api/demo/subscribe', { plan: 'quarter' }, token)).json();
  assert.equal(m.premium, true); assert.equal(m.plan.id, 'quarter'); assert.equal(m.addons.pack, false);
  const m2 = await (await call('POST', '/api/demo/subscribe', { pack: true }, token)).json();
  assert.equal(m2.plan.id, 'quarter'); assert.equal(m2.addons.pack, true);
});

test('AI coach uses the OpenAI wire format with a Bearer key', async () => {
  const r = await call('POST', '/api/coach', REQ, token);
  assert.equal(r.status, 200);
  assert.match((await r.json()).text, /pause/);
  const s = seen.at(-1);
  assert.equal(s.url, '/chat/completions');
  assert.equal(s.auth, 'Bearer sk-deepseek-test');
  assert.equal(s.xkey, undefined);
  assert.equal(s.body.model, 'deepseek-flash');
  assert.equal(s.body.messages[0].role, 'user');
  assert.deepEqual(s.body.thinking, { type: 'disabled' });
});
