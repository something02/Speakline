/* Speakline API — accounts by email code, subscriptions from Paddle webhooks, funnel events.
   One small Node process with a SQLite file. Meant to run on a VPS in Kazakhstan next to the
   personal data it stores (see README). Node 22.13+ (uses the built-in node:sqlite). */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------- config (environment variables, see .env.example) ---------- */
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CFG = {
  port: +env('PORT', 8787),
  db: env('DB_PATH', path.join(__dirname, 'speakline.db')),
  origins: env('APP_ORIGIN', 'http://localhost:8080').split(',').map(s => s.trim()),
  staticDir: env('STATIC_DIR', ''),                       // serve the web app from here too (one server, one domain)
  paddleEnv: env('PADDLE_ENV', 'sandbox'),
  paddleKey: env('PADDLE_API_KEY', ''),                   // secret — server only
  paddleSecret: env('PADDLE_WEBHOOK_SECRET', ''),         // secret — server only
  prices: {
    week: env('PRICE_WEEK', ''), month: env('PRICE_MONTH', ''), quarter: env('PRICE_QUARTER', ''),
    pack: env('PRICE_PACK', ''), pro: env('PRICE_PRO', '')
  },
  smtp: env('SMTP_URL', ''),                              // smtps://user:pass@smtp.example.com:465
  mailFrom: env('MAIL_FROM', 'Speakline <no-reply@example.com>'),
  appUrl: env('APP_URL', 'http://localhost:8080/'),
  adminKey: env('ADMIN_KEY', ''),
  aiKey: env('ANTHROPIC_API_KEY', ''),                    // secret — server only; powers the AI coach
  aiModel: env('AI_MODEL', 'claude-sonnet-5-5'),
  aiDaily: +env('AI_DAILY_LIMIT', 40),                    // AI reviews per user per day
  devEcho: env('DEV_ECHO_CODES', '0') === '1'             // return login codes in the response (local testing only)
};
const PADDLE_API = CFG.paddleEnv === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
const PLAN_OF = {};
for (const k of ['week', 'month', 'quarter']) if (CFG.prices[k]) PLAN_OF[CFG.prices[k]] = k;

/* ---------- database ---------- */
const db = new DatabaseSync(CFG.db);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, lang TEXT DEFAULT 'ru', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires_at INTEGER NOT NULL, tries INTEGER DEFAULT 0, sent_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS customers (customer_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, user_id TEXT, customer_id TEXT, status TEXT, price_ids TEXT,
  trial_ends_at INTEGER, next_billed_at INTEGER, period_ends_at INTEGER, scheduled_change TEXT, canceled_at INTEGER,
  reminder_sent INTEGER DEFAULT 0, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS purchases (txn_id TEXT PRIMARY KEY, user_id TEXT, customer_id TEXT, price_ids TEXT, subscription_id TEXT, status TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, type TEXT, received_at INTEGER);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, anon_id TEXT, user_id TEXT, name TEXT, props TEXT);
CREATE TABLE IF NOT EXISTS hits (k TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS hits_k ON hits(k, ts);
CREATE INDEX IF NOT EXISTS events_name ON events(name, ts);
`);
const q = (sql) => db.prepare(sql);
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (s) => (s ? Date.parse(s) || null : null);

/* ---------- small helpers ---------- */
function send(res, code, body, headers) {
  const b = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(b);
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(raw) { try { return JSON.parse(raw || '{}'); } catch { return null; } }
function cors(req, res) {
  const o = req.headers.origin;
  if (o && CFG.origins.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
}
/* sliding-window rate limit kept in SQLite so it survives restarts */
function limited(key, max, windowMs) {
  const t = now();
  q('DELETE FROM hits WHERE ts < ?').run(t - 24 * 3600e3);
  const n = q('SELECT COUNT(*) AS n FROM hits WHERE k = ? AND ts > ?').get(key, t - windowMs).n;
  if (n >= max) return true;
  q('INSERT INTO hits (k, ts) VALUES (?, ?)').run(key, t);
  return false;
}
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

/* ---------- mail ---------- */
let transport = null;
function mailer() {
  if (transport || !CFG.smtp) return transport;
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport(CFG.smtp);
  return transport;
}
const MAIL = {
  code: {
    ru: (c) => ['Код входа в Speakline: ' + c, 'Твой код входа: ' + c + '\n\nОн действует 10 минут. Если ты не запрашивал код, просто проигнорируй письмо.\n\nSpeakline'],
    en: (c) => ['Your Speakline sign-in code: ' + c, 'Your sign-in code: ' + c + '\n\nIt is valid for 10 minutes. If you didn’t request it, ignore this email.\n\nSpeakline'],
    kk: (c) => ['Speakline-ға кіру коды: ' + c, 'Кіру кодың: ' + c + '\n\nОл 10 минут жарамды. Егер кодты сұрамаған болсаң, хатты елеме.\n\nSpeakline']
  },
  trial: {
    ru: (d, url) => ['Пробная неделя Speakline заканчивается ' + d, 'Привет! Пробная неделя заканчивается ' + d + '. После этого подписка продлится на месяц за $17.99.\n\nЕсли не хочешь продолжать, отмени её в приложении: Настройки → Подписка → Управлять подпиской.\n' + url + '\n\nSpeakline'],
    en: (d, url) => ['Your Speakline trial ends on ' + d, 'Hi! Your trial week ends on ' + d + '. After that the subscription renews monthly at $17.99.\n\nIf you don’t want to continue, cancel in the app: Settings → Subscription → Manage subscription.\n' + url + '\n\nSpeakline'],
    kk: (d, url) => ['Speakline сынақ аптасы ' + d + ' аяқталады', 'Сәлем! Сынақ аптасы ' + d + ' аяқталады. Одан кейін жазылым айына $17.99-ға ұзартылады.\n\nЖалғастырғың келмесе, қосымшада тоқтат: Баптаулар → Жазылым → Жазылымды басқару.\n' + url + '\n\nSpeakline']
  }
};
async function sendMail(to, subject, text) {
  const t = mailer();
  if (!t) { console.log('[mail:dry-run]', to, '|', subject); return; }
  await t.sendMail({ from: CFG.mailFrom, to, subject, text });
}

/* ---------- auth ---------- */
function userByToken(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok) return null;
  const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(sha(tok));
  if (!s) return null;
  if (now() - s.last_seen > 180 * 864e5) { q('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash); return null; }
  q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), s.token_hash);
  return q('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}
async function authStart(req, res) {
  const b = json(await readBody(req)); if (!b) return send(res, 400, { error: 'bad_json' });
  const email = String(b.email || '').trim().toLowerCase();
  const lang = ['ru', 'en', 'kk'].includes(b.lang) ? b.lang : 'ru';
  if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'bad_email' });
  if (limited('start:' + email, 5, 3600e3) || limited('start-ip:' + ipOf(req), 20, 3600e3)) return send(res, 429, { error: 'too_many' });
  const prev = q('SELECT sent_at FROM codes WHERE email = ?').get(email);
  if (prev && now() - prev.sent_at < 30e3) return send(res, 429, { error: 'wait', retry_in: 30 });
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  q('INSERT INTO codes (email, hash, expires_at, tries, sent_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET hash=excluded.hash, expires_at=excluded.expires_at, tries=0, sent_at=excluded.sent_at')
    .run(email, sha(email + ':' + code), now() + 10 * 60e3, now());
  const [subj, text] = MAIL.code[lang](code);
  try { await sendMail(email, subj, text); } catch (e) { console.error('mail failed', e.message); return send(res, 502, { error: 'mail_failed' }); }
  send(res, 200, CFG.devEcho ? { ok: true, dev_code: code } : { ok: true });
}
async function authVerify(req, res) {
  const b = json(await readBody(req)); if (!b) return send(res, 400, { error: 'bad_json' });
  const email = String(b.email || '').trim().toLowerCase(), code = String(b.code || '').replace(/\D/g, '');
  const row = q('SELECT * FROM codes WHERE email = ?').get(email);
  if (!row || row.expires_at < now()) return send(res, 400, { error: 'expired' });
  if (row.tries >= 5) return send(res, 429, { error: 'too_many' });
  const ok = crypto.timingSafeEqual(Buffer.from(row.hash), Buffer.from(sha(email + ':' + code)));
  if (!ok) { q('UPDATE codes SET tries = tries + 1 WHERE email = ?').run(email); return send(res, 400, { error: 'wrong_code' }); }
  q('DELETE FROM codes WHERE email = ?').run(email);
  let u = q('SELECT * FROM users WHERE email = ?').get(email);
  if (!u) {
    u = { id: 'u_' + crypto.randomBytes(9).toString('hex'), email, lang: ['ru', 'en', 'kk'].includes(b.lang) ? b.lang : 'ru', created_at: now() };
    q('INSERT INTO users (id, email, lang, created_at) VALUES (?, ?, ?, ?)').run(u.id, u.email, u.lang, u.created_at);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(sha(token), u.id, now(), now());
  if (b.anon_id) q('UPDATE events SET user_id = ? WHERE anon_id = ? AND user_id IS NULL').run(u.id, String(b.anon_id).slice(0, 64));
  send(res, 200, { token, me: me(u) });
}

/* ---------- entitlements ---------- */
const LIVE = new Set(['active', 'trialing', 'past_due']);
function me(u) {
  const subs = q('SELECT * FROM subscriptions WHERE user_id = ?').all(u.id);
  let plan = null, pro = false;
  for (const s of subs) {
    if (!LIVE.has(s.status)) continue;
    const ids = JSON.parse(s.price_ids || '[]');
    for (const id of ids) {
      if (PLAN_OF[id] && (!plan || (s.status !== 'past_due'))) plan = { id: PLAN_OF[id], status: s.status, sub: s.id, trial_ends_at: s.trial_ends_at, next_billed_at: s.next_billed_at, period_ends_at: s.period_ends_at, cancel_scheduled: !!(s.scheduled_change && JSON.parse(s.scheduled_change).action === 'cancel') };
      if (id === CFG.prices.pro) pro = true;
    }
  }
  const pack = !!q("SELECT 1 FROM purchases WHERE user_id = ? AND status = 'completed' AND price_ids LIKE ?").get(u.id, '%"' + (CFG.prices.pack || '__none__') + '"%');
  return { uid: u.id, email: u.email, premium: !!plan, plan, addons: { pack, pro } };
}

/* ---------- Paddle webhooks ---------- */
function verifyPaddle(raw, header) {
  if (!CFG.paddleSecret || !header) return false;
  const parts = Object.fromEntries(String(header).split(';').map(p => p.split('=')));
  const ts = parts.ts, h1 = parts.h1;
  if (!ts || !h1) return false;
  if (Math.abs(now() / 1000 - +ts) > 300) return false;           // replay window: 5 minutes
  const mac = crypto.createHmac('sha256', CFG.paddleSecret).update(ts + ':' + raw).digest('hex');
  return mac.length === h1.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(h1));
}
function uidFor(data) {
  const cd = data.custom_data || {};
  if (cd.uid && q('SELECT 1 FROM users WHERE id = ?').get(cd.uid)) return cd.uid;
  const c = data.customer_id && q('SELECT user_id FROM customers WHERE customer_id = ?').get(data.customer_id);
  if (c) return c.user_id;
  if (data.id && data.id.startsWith('sub_')) { const s = q('SELECT user_id FROM subscriptions WHERE id = ?').get(data.id); if (s && s.user_id) return s.user_id; }
  return null;
}
function applyEvent(ev) {
  const d = ev.data || {}, type = ev.event_type || '';
  const uid = uidFor(d);
  if (uid && d.customer_id) q('INSERT OR IGNORE INTO customers (customer_id, user_id) VALUES (?, ?)').run(d.customer_id, uid);
  if (type.startsWith('subscription.')) {
    const ids = (d.items || []).map(i => (i.price && i.price.id) || i.price_id).filter(Boolean);
    const trialEnds = (d.items || []).map(i => i.trial_dates && i.trial_dates.ends_at).filter(Boolean)[0];
    q(`INSERT INTO subscriptions (id, user_id, customer_id, status, price_ids, trial_ends_at, next_billed_at, period_ends_at, scheduled_change, canceled_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = COALESCE(excluded.user_id, subscriptions.user_id), customer_id = excluded.customer_id, status = excluded.status,
         price_ids = excluded.price_ids, trial_ends_at = excluded.trial_ends_at, next_billed_at = excluded.next_billed_at, period_ends_at = excluded.period_ends_at,
         scheduled_change = excluded.scheduled_change, canceled_at = excluded.canceled_at, updated_at = excluded.updated_at`)
      .run(d.id, uid, d.customer_id || null, d.status || null, JSON.stringify(ids), iso(trialEnds), iso(d.next_billed_at),
        iso(d.current_billing_period && d.current_billing_period.ends_at), d.scheduled_change ? JSON.stringify(d.scheduled_change) : null, iso(d.canceled_at), now());
  }
  if (type.startsWith('transaction.')) {
    const ids = (d.items || []).map(i => (i.price && i.price.id) || i.price_id).filter(Boolean);
    q(`INSERT INTO purchases (txn_id, user_id, customer_id, price_ids, subscription_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(txn_id) DO UPDATE SET user_id = COALESCE(excluded.user_id, purchases.user_id), status = excluded.status, subscription_id = COALESCE(excluded.subscription_id, purchases.subscription_id)`)
      .run(d.id, uid, d.customer_id || null, JSON.stringify(ids), d.subscription_id || null, d.status || null, iso(d.created_at) || now());
    if (uid && d.subscription_id) q('UPDATE subscriptions SET user_id = COALESCE(user_id, ?) WHERE id = ?').run(uid, d.subscription_id);
    if (uid && d.status === 'completed') q("INSERT INTO events (ts, anon_id, user_id, name, props) VALUES (?, NULL, ?, 'paid', ?)").run(now(), uid, JSON.stringify({ price_ids: ids, txn: d.id }));
  }
  if (type === 'adjustment.created' || type === 'adjustment.updated') {
    // refunds: a fully approved refund on a one-time purchase removes it
    if (d.action === 'refund' && d.status === 'approved' && d.transaction_id && d.type === 'full') q("UPDATE purchases SET status = 'refunded' WHERE txn_id = ?").run(d.transaction_id);
  }
}
async function paddleWebhook(req, res) {
  const raw = await readBody(req, 1024 * 1024);
  if (!verifyPaddle(raw, req.headers['paddle-signature'])) return send(res, 401, { error: 'bad_signature' });
  const ev = json(raw); if (!ev || !ev.event_id) return send(res, 400, { error: 'bad_json' });
  const seen = q('SELECT 1 FROM webhook_events WHERE event_id = ?').get(ev.event_id);
  if (seen) return send(res, 200, { ok: true, duplicate: true });
  try {
    db.exec('BEGIN');
    applyEvent(ev);
    q('INSERT INTO webhook_events (event_id, type, received_at) VALUES (?, ?, ?)').run(ev.event_id, ev.event_type || '', now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error('webhook failed', e); return send(res, 500, { error: 'failed' }); }
  send(res, 200, { ok: true });
}

/* ---------- Paddle API (server-side, secret key) ---------- */
async function paddle(method, p, body) {
  if (!CFG.paddleKey) throw new Error('no_api_key');
  const r = await fetch(PADDLE_API + p, { method, headers: { Authorization: 'Bearer ' + CFG.paddleKey, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('paddle_' + r.status + ':' + ((j.error && j.error.code) || ''));
  return j.data;
}
async function portal(req, res, u) {
  const c = q('SELECT customer_id FROM customers WHERE user_id = ?').get(u.id);
  if (!c) return send(res, 404, { error: 'no_customer' });
  const subs = q("SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing','past_due','paused')").all(u.id).map(s => s.id);
  try {
    const d = await paddle('POST', '/customers/' + c.customer_id + '/portal-sessions', subs.length ? { subscription_ids: subs.slice(0, 25) } : {});
    send(res, 200, { url: d.urls.general.overview, subscriptions: d.urls.subscriptions || [] });
  } catch (e) { send(res, 502, { error: e.message }); }
}
async function deleteAccount(req, res, u) {
  // stop future charges first, then erase personal data; payment records stay with Paddle for tax law
  const subs = q("SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing','past_due','paused')").all(u.id);
  for (const s of subs) {
    try { await paddle('POST', '/subscriptions/' + s.id + '/cancel', { effective_from: 'immediately' }); }
    catch (e) { if (e.message !== 'no_api_key') return send(res, 502, { error: 'cancel_failed' }); }
  }
  db.exec('BEGIN');
  for (const t of ['sessions', 'customers']) q('DELETE FROM ' + t + ' WHERE user_id = ?').run(u.id);
  q('UPDATE subscriptions SET user_id = NULL WHERE user_id = ?').run(u.id);
  q('UPDATE purchases SET user_id = NULL WHERE user_id = ?').run(u.id);
  q('UPDATE events SET user_id = NULL WHERE user_id = ?').run(u.id);
  q('DELETE FROM codes WHERE email = ?').run(u.email);
  q('DELETE FROM users WHERE id = ?').run(u.id);
  db.exec('COMMIT');
  send(res, 200, { ok: true });
}

/* ---------- funnel events (no personal data in props) ---------- */
const EVENT_NAMES = new Set(['app_open', 'intro_done', 'onboarding_done', 'session_start', 'session_done', 'mission_done', 'paywall_view', 'plan_select', 'account_start', 'account_done', 'checkout_open', 'checkout_done', 'upsell_add', 'meeting_add']);
async function events(req, res) {
  const b = json(await readBody(req, 32 * 1024)); if (!b) return send(res, 400, { error: 'bad_json' });
  const anon = String(b.anon_id || '').slice(0, 64), name = String(b.name || '');
  if (!EVENT_NAMES.has(name) || !anon) return send(res, 400, { error: 'bad_event' });
  if (limited('ev:' + anon, 300, 3600e3)) return send(res, 429, { error: 'too_many' });
  const u = userByToken(req);
  const props = b.props && typeof b.props === 'object' ? JSON.stringify(b.props).slice(0, 2000) : null;
  q('INSERT INTO events (ts, anon_id, user_id, name, props) VALUES (?, ?, ?, ?, ?)').run(now(), anon, u ? u.id : null, name, props);
  send(res, 204);
}
function stats(req, res, url) {
  if (!CFG.adminKey || url.searchParams.get('key') !== CFG.adminKey) return send(res, 401, { error: 'no' });
  const since = now() - (+url.searchParams.get('days') || 30) * 864e5;
  const steps = ['app_open', 'onboarding_done', 'session_done', 'paywall_view', 'account_done', 'checkout_done'];
  const funnel = steps.map(n => ({ step: n, people: q('SELECT COUNT(DISTINCT anon_id) AS n FROM events WHERE name = ? AND ts > ?').get(n, since).n }));
  const subs = q('SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status').all();
  send(res, 200, { since: new Date(since).toISOString(), funnel, subscriptions: subs, users: q('SELECT COUNT(*) AS n FROM users').get().n });
}

/* ---------- AI coach: the server builds the prompt from validated numbers and calls Claude ----------
   The key never reaches the browser. Premium only, rate-limited per user. */
const LANGS = { ru: 'Russian', en: 'English', kk: 'Kazakh' };
const METRIC_KEYS = ['words', 'seconds', 'wpm', 'fillers', 'hesitation_sounds', 'fillers_per_min', 'pauses', 'avg_pause_s', 'long_pauses', 'pitch_sd_semitones', 'read_accuracy', 'score'];
function coachPrompt(b) {
  const m = {};
  for (const k of METRIC_KEYS) { const v = b.metrics && b.metrics[k]; if (typeof v === 'number' && isFinite(v)) m[k] = Math.round(v * 100) / 100; }
  if (Array.isArray(b.metrics && b.metrics.target_wpm)) m.target_wpm = b.metrics.target_wpm.slice(0, 2).map(Number);
  const tr = LANGS[b.lang], ui = LANGS[b.ui];
  const words = String(b.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const task = String(b.task || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return 'You are Speakline\'s speaking coach. The user ' + (b.mode === 'read' ? 'read this text out loud' : 'answered this prompt out loud') + ': """' + task + '""". They spoke in ' + tr + '.\n' +
    'Transcript from speech recognition (filler sounds like "um" are often dropped by the recogniser, the metrics count them from audio): """' + words + '"""\n' +
    'Measured metrics: ' + JSON.stringify(m) + '\n' +
    'Reply in ' + ui + ', plain text, no markdown, under 170 words. Give: 1) one sentence on what already works; 2) three specific, actionable tips tied to these metrics and the words actually used; ' +
    (b.mode === 'read' ? '3) one sentence on how to deliver the hardest part of the text.' : '3) a rewritten version of what they said — clearer, no fillers, same meaning, in ' + tr + '.') +
    ' Do not invent metrics that are not listed.';
}
async function coach(req, res, u) {
  if (!CFG.aiKey) return send(res, 503, { error: 'ai_off' });
  if (!me(u).premium) return send(res, 402, { error: 'premium' });
  if (limited('coach:' + u.id, CFG.aiDaily, 24 * 3600e3)) return send(res, 429, { error: 'limit' });
  const b = json(await readBody(req, 16 * 1024));
  if (!b || !LANGS[b.lang] || !LANGS[b.ui] || !['read', 'free'].includes(b.mode) || !String(b.transcript || '').trim()) return send(res, 400, { error: 'bad_request' });
  const r = await fetch(process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CFG.aiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CFG.aiModel, max_tokens: 700, messages: [{ role: 'user', content: coachPrompt(b) }] }),
    signal: AbortSignal.timeout(30000)
  }).catch(() => null);
  if (!r || !r.ok) { console.error('coach upstream', r && r.status); return send(res, 502, { error: 'ai_upstream' }); }
  const j = await r.json().catch(() => ({}));
  const text = (j.content || []).map(c => c.text || '').join('').trim();
  if (!text) return send(res, 502, { error: 'ai_empty' });
  q('INSERT INTO events (ts, anon_id, user_id, name, props) VALUES (?, ?, ?, ?, ?)').run(now(), '', u.id, 'ai_coach', JSON.stringify({ lang: b.lang, mode: b.mode }));
  send(res, 200, { text });
}

/* ---------- trial reminders: hourly, ~2 days before the trial ends ---------- */
async function trialReminders() {
  const t = now();
  const rows = q(`SELECT s.id, s.trial_ends_at, u.email, u.lang FROM subscriptions s JOIN users u ON u.id = s.user_id
                  WHERE s.status = 'trialing' AND s.reminder_sent = 0 AND s.trial_ends_at BETWEEN ? AND ?`).all(t, t + 50 * 3600e3);
  for (const r of rows) {
    const d = new Date(r.trial_ends_at).toLocaleDateString({ ru: 'ru-RU', en: 'en-GB', kk: 'kk-KZ' }[r.lang] || 'ru-RU', { day: 'numeric', month: 'long' });
    const [subj, text] = MAIL.trial[r.lang || 'ru'](d, CFG.appUrl);
    try { await sendMail(r.email, subj, text); q('UPDATE subscriptions SET reminder_sent = 1 WHERE id = ?').run(r.id); }
    catch (e) { console.error('reminder failed', r.id, e.message); }
  }
}

/* ---------- static files (optional) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, url) {
  if (!CFG.staticDir) return false;
  let p; try { p = decodeURIComponent(url.pathname); } catch { return false; }
  if (p.endsWith('/')) p += 'index.html';
  // public files only: known web types, no dotfiles (.env, .git), nothing from the server folder
  const segs = p.split('/').filter(Boolean);
  if (segs.some(x => x.startsWith('.')) || ['server', 'node_modules'].includes(segs[0]) || !MIME[path.extname(p)]) return false;
  const root = path.resolve(CFG.staticDir), f = path.normalize(path.join(root, p));
  if (!f.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': p.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(f).pipe(res);
  return true;
}

/* ---------- router ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  cors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204);
  try {
    const r = req.method + ' ' + url.pathname;
    if (r === 'GET /api/health') return send(res, 200, { ok: true, env: CFG.paddleEnv });
    if (r === 'POST /api/auth/start') return await authStart(req, res);
    if (r === 'POST /api/auth/verify') return await authVerify(req, res);
    if (r === 'POST /api/events') return await events(req, res);
    if (r === 'POST /webhooks/paddle') return await paddleWebhook(req, res);
    if (r === 'GET /api/stats') return stats(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      const u = userByToken(req);
      if (!u) return send(res, 401, { error: 'auth' });
      if (r === 'GET /api/me') return send(res, 200, me(u));
      if (r === 'POST /api/portal') return await portal(req, res, u);
      if (r === 'POST /api/coach') return await coach(req, res, u);
      if (r === 'POST /api/logout') { q('DELETE FROM sessions WHERE token_hash = ?').run(sha(String(req.headers.authorization).slice(7).trim())); return send(res, 200, { ok: true }); }
      if (r === 'DELETE /api/account') return await deleteAccount(req, res, u);
      return send(res, 404, { error: 'not_found' });
    }
    if (req.method === 'GET' && serveStatic(req, res, url)) return;
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.message === 'too_large' ? 413 : 500, { error: 'server' });
  }
});

if (require.main === module) {
  server.listen(CFG.port, () => console.log(`Speakline API on :${CFG.port} (${CFG.paddleEnv})`));
  setInterval(() => trialReminders().catch(e => console.error(e)), 3600e3);
  trialReminders().catch(() => {});
}
module.exports = { server, db, CFG, trialReminders, verifyPaddle, coachPrompt };
