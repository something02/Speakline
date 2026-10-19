'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const os = require('node:os'), path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'speakline-test-' + Date.now() + '.db');
process.env.PADDLE_WEBHOOK_SECRET = 'whsec_test';
process.env.DEV_ECHO_CODES = '1';
process.env.APP_ORIGIN = 'http://localhost:8080';
process.env.STATIC_DIR = path.join(__dirname, '..', '..');
process.env.PRICE_WEEK = 'pri_week'; process.env.PRICE_PACK = 'pri_pack'; process.env.PRICE_PRO = 'pri_pro';
const { server, db, trialReminders } = require('../server.js');

let base;
test.before(() => new Promise(r => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
test.after(() => server.close());

const call = (method, p, body, token, headers) => fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers || {}), body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
function signed(ev, secret = 'whsec_test', ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(ev);
  const h1 = crypto.createHmac('sha256', secret).update(ts + ':' + raw).digest('hex');
  return [raw, { 'Paddle-Signature': 'ts=' + ts + ';h1=' + h1 }];
}

let token, uid;
test('sign in with an email code', async () => {
  assert.equal((await call('POST', '/api/auth/start', { email: 'bad' })).status, 400);
  const s = await (await call('POST', '/api/auth/start', { email: 'Dakka@Example.com', lang: 'ru' })).json();
  assert.match(s.dev_code, /^\d{6}$/);
  assert.equal((await call('POST', '/api/auth/start', { email: 'dakka@example.com' })).status, 429, 'resend is throttled');
  assert.equal((await call('POST', '/api/auth/verify', { email: 'dakka@example.com', code: '000000' === s.dev_code ? '111111' : '000000' })).status, 400);
  const v = await (await call('POST', '/api/auth/verify', { email: 'dakka@example.com', code: s.dev_code })).json();
  assert.ok(v.token); assert.equal(v.me.premium, false); token = v.token;
  uid = db.prepare('SELECT id FROM users WHERE email = ?').get('dakka@example.com').id;
  assert.equal((await call('POST', '/api/auth/verify', { email: 'dakka@example.com', code: s.dev_code })).status, 400, 'code is single-use');
});

test('rejects unsigned or forged webhooks', async () => {
  const ev = { event_id: 'evt_x', event_type: 'subscription.created', data: { id: 'sub_x', status: 'active', items: [] } };
  assert.equal((await call('POST', '/webhooks/paddle', JSON.stringify(ev))).status, 401);
  const [raw, h] = signed(ev, 'wrong');
  assert.equal((await call('POST', '/webhooks/paddle', raw, null, h)).status, 401);
  const [raw2, h2] = signed(ev, 'whsec_test', Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await call('POST', '/webhooks/paddle', raw2, null, h2)).status, 401, 'old timestamp');
});

test('paid trial from Paddle turns Premium on', async () => {
  const trialEnd = new Date(Date.now() + 36 * 3600e3).toISOString();
  const txn = { event_id: 'evt_1', event_type: 'transaction.completed', data: { id: 'txn_1', status: 'completed', customer_id: 'ctm_1', subscription_id: 'sub_1', custom_data: { uid }, items: [{ price: { id: 'pri_week' } }], created_at: new Date().toISOString() } };
  const sub = { event_id: 'evt_2', event_type: 'subscription.created', data: { id: 'sub_1', status: 'trialing', customer_id: 'ctm_1', items: [{ price: { id: 'pri_week' }, trial_dates: { starts_at: new Date().toISOString(), ends_at: trialEnd } }], next_billed_at: trialEnd, current_billing_period: { ends_at: trialEnd } } };
  for (const ev of [txn, sub]) { const [raw, h] = signed(ev); assert.equal((await call('POST', '/webhooks/paddle', raw, null, h)).status, 200); }
  const [raw, h] = signed(sub); const dup = await (await call('POST', '/webhooks/paddle', raw, null, h)).json();
  assert.equal(dup.duplicate, true);
  const me = await (await call('GET', '/api/me', undefined, token)).json();
  assert.equal(me.premium, true); assert.equal(me.plan.id, 'week'); assert.equal(me.plan.status, 'trialing');
});

test('one-time pack purchase and refund', async () => {
  const ev = { event_id: 'evt_3', event_type: 'transaction.completed', data: { id: 'txn_2', status: 'completed', customer_id: 'ctm_1', items: [{ price: { id: 'pri_pack' } }] } };
  let [raw, h] = signed(ev); await call('POST', '/webhooks/paddle', raw, null, h);
  assert.equal((await (await call('GET', '/api/me', undefined, token)).json()).addons.pack, true);
  [raw, h] = signed({ event_id: 'evt_4', event_type: 'adjustment.created', data: { action: 'refund', status: 'approved', type: 'full', transaction_id: 'txn_2' } });
  await call('POST', '/webhooks/paddle', raw, null, h);
  assert.equal((await (await call('GET', '/api/me', undefined, token)).json()).addons.pack, false);
});

test('trial reminder is sent once', async () => {
  await trialReminders(); await trialReminders();
  assert.equal(db.prepare('SELECT reminder_sent FROM subscriptions WHERE id = ?').get('sub_1').reminder_sent, 1);
});

test('cancellation ends Premium', async () => {
  const [raw, h] = signed({ event_id: 'evt_5', event_type: 'subscription.canceled', data: { id: 'sub_1', status: 'canceled', customer_id: 'ctm_1', items: [{ price: { id: 'pri_week' } }], canceled_at: new Date().toISOString() } });
  await call('POST', '/webhooks/paddle', raw, null, h);
  assert.equal((await (await call('GET', '/api/me', undefined, token)).json()).premium, false);
});

test('funnel events and CORS', async () => {
  assert.equal((await call('POST', '/api/events', { anon_id: 'a1', name: 'paywall_view', props: { plan: 'week' } })).status, 204);
  assert.equal((await call('POST', '/api/events', { anon_id: 'a1', name: 'evil' })).status, 400);
  const r = await call('OPTIONS', '/api/me', undefined, null, { Origin: 'http://localhost:8080' });
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  const r2 = await call('OPTIONS', '/api/me', undefined, null, { Origin: 'https://evil.example' });
  assert.equal(r2.headers.get('access-control-allow-origin'), null);
});

test('delete account erases the user', async () => {
  assert.equal((await call('DELETE', '/api/account', undefined, token)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal((await call('GET', '/api/me', undefined, token)).status, 401);
});

test('serves the app but never server files or secrets', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/terms.html')).status, 200);
  for (const p of ['/server/server.js', '/server/.env.example', '/.git/config', '/server/package.json', '/%2e%2e/etc/passwd', '/..%2fserver%2fserver.js'])
    assert.notEqual((await fetch(base + p)).status, 200, p);
});
