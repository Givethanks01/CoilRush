// Coil Rush API: one Netlify Function serving /api/*.
// Coil Rush Plus (optional): set STRIPE_PAYMENT_LINK and STRIPE_WEBHOOK_SECRET to turn the
// paywall on. Without them the game stays fully free and no Plus UI is shown. Storage is Netlify Blobs, so there's
// no external database to set up. Accounts are username + password only (scrypt-hashed);
// sessions are HMAC-signed tokens. Set SESSION_SECRET in Netlify's environment variables to
// pin the signing key; if it's missing, a random key is generated once and kept in Blobs.
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { scryptSync, randomBytes, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const config = { path: '/api/*' };

const store = name => getStore({ name, consistency: 'strong' });
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, error) => json({ error }, status);
const today = () => new Date().toISOString().slice(0, 10);
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const CID_RE = /^[A-Za-z0-9-]{8,40}$/;
const TOKEN_DAYS = 60;
const BOARD_SIZE = 50;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Read-modify-write that is safe when many players write at once: every write is
// conditional on the version we read (or on the key not existing yet), and we retry on conflict.
// fn gets a copy of the current value (or init) and returns the new value, or undefined for "no change".
async function mutate(name, key, fn, init = null) {
  const s = store(name);
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await s.getWithMetadata(key, { type: 'json' });
    const base = cur ? cur.data : (init === null ? null : JSON.parse(JSON.stringify(init)));
    const next = fn(base);
    if (next === undefined) return base;
    const res = cur && cur.etag
      ? await s.setJSON(key, next, { onlyIfMatch: cur.etag })
      : await s.setJSON(key, next, { onlyIfNew: true });
    if (res.modified) return next;
    await sleep(15 + Math.random() * 40 * (attempt + 1));
  }
  throw Object.assign(new Error('The server is busy right now. Try again in a moment.'), { status: 503 });
}
// Complimentary Plus ("pro") accounts, by username. Add more without code via the PRO_USERS
// environment variable (comma-separated usernames).
const COMPED = new Set(['slimzy169', 'givethanks', ...(process.env.PRO_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)]);
const isComped = name => COMPED.has(String(name || '').toLowerCase());
async function hasPlus(id, name) {
  if (isComped(name)) return true;
  const rec = await store('plus').get(id, { type: 'json' });
  return !!(rec && rec.active);
}
const CLAIM_RE = /^g-[A-Za-z0-9]{20,40}$/;
const int = (v, max) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0);

// ---------- sessions ----------
let secretCache = null;
async function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (secretCache) return secretCache;
  const meta = store('meta');
  let s = await meta.get('secret', { type: 'json' });
  if (!s) {
    // Only the first writer wins; everyone (including a racing instance) then uses the stored key.
    await meta.setJSON('secret', { key: randomBytes(32).toString('hex') }, { onlyIfNew: true });
    s = await meta.get('secret', { type: 'json' });
  }
  return (secretCache = s.key);
}
async function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + createHmac('sha256', await secret()).update(body).digest('base64url');
}
async function verify(token) {
  if (!token || token.split('.').length !== 2) return null;
  const [body, mac] = token.split('.');
  const want = createHmac('sha256', await secret()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
async function session(req) {
  const p = await verify((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  return p ? { id: p.id, name: p.name } : null;
}
const hashPw = (pw, salt) => scryptSync(pw, salt, 64).toString('hex');
async function issue(user) {
  const token = await sign({ id: user.id, name: user.name, exp: Date.now() + TOKEN_DAYS * 864e5 });
  return { token, user: { id: user.id, name: user.name } };
}

async function body(req, limit = 100_000) {
  const text = await req.text();
  if (text.length > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
  try { const v = JSON.parse(text || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
  throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 });
}

async function bump(key, fields) {
  return mutate('meta', key, cur => {
    for (const [k, v] of Object.entries(fields)) cur[k] = (cur[k] || 0) + v;
    return cur;
  }, {});
}

// ---------- accounts ----------
async function register(req) {
  const { username = '', password = '' } = await body(req, 2000);
  if (!NAME_RE.test(username)) return fail(400, 'Usernames are 3–16 letters, numbers or underscores.');
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) return fail(400, 'Passwords need at least 6 characters.');
  const users = store('users'), key = 'name/' + username.toLowerCase();
  if (await users.get(key, { type: 'json' })) return fail(409, 'That username is taken. Try another one.');
  const salt = randomBytes(16).toString('hex');
  const user = { id: randomUUID(), name: username, salt, hash: hashPw(password, salt), createdAt: new Date().toISOString() };
  const res = await users.setJSON(key, user, { onlyIfNew: true });   // two people racing for one name: only one gets it
  if (!res.modified) return fail(409, 'That username is taken. Try another one.');
  await bump('stats', { players: 1 });
  return json(await issue(user), 201);
}

async function login(req) {
  const { username = '', password = '' } = await body(req, 2000);
  if (!NAME_RE.test(username) || typeof password !== 'string') return fail(401, 'Wrong username or password.');
  const lower = username.toLowerCase(), meta = store('meta'), failKey = 'fail/' + lower;
  const f = (await meta.get(failKey, { type: 'json' })) || { n: 0, until: 0 };
  if (f.until > Date.now()) return fail(429, 'Too many wrong attempts. Wait a few minutes and try again.');
  const user = await store('users').get('name/' + lower, { type: 'json' });
  const ok = user && timingSafeEqual(Buffer.from(hashPw(password, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
  if (!ok) {
    f.n += 1;
    if (f.n >= 5) { f.n = 0; f.until = Date.now() + 10 * 60e3; }
    await meta.setJSON(failKey, f);
    return fail(401, 'Wrong username or password.');
  }
  if (f.n) await meta.delete(failKey);
  return json(await issue(user));
}

async function me(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in again.');
  const [profile, scores, plus] = await Promise.all([
    store('profiles').get(s.id, { type: 'json' }),
    store('scores').get(s.id, { type: 'json' }),
    hasPlus(s.id, s.name),
  ]);
  return json({ user: s, profile: profile || null, scores: scores || null, plus, pro: isComped(s.name) });
}

async function saveProfile(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in again.');
  const p = await body(req);
  await store('profiles').setJSON(s.id, { ...p, savedAt: Date.now() });
  return json({ ok: true });
}

// ---------- scores, boards, feed ----------
async function upsertBoard(key, entry, better) {
  const rows = await mutate('boards', key, rows => {
    const i = rows.findIndex(r => r.id === entry.id);
    if (i >= 0 && !better(entry, rows[i])) return undefined;
    if (i >= 0) rows.splice(i, 1);
    rows.push(entry);
    rows.sort((a, b) => b.score - a.score || (b.cleared || 0) - (a.cleared || 0) || a.at - b.at);
    rows.length = Math.min(rows.length, BOARD_SIZE);
    return rows;
  }, []);
  const place = rows.findIndex(r => r.id === entry.id);
  return place >= 0 ? place + 1 : null;
}

async function pushFeed(event) {
  await mutate('meta', 'feed', feed => {
    feed.unshift(event);
    feed.length = Math.min(feed.length, 40);
    return feed;
  }, []);
}

async function submitScore(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in to save scores.');
  const b = await body(req, 4000);
  const mode = b.mode;
  if (!['endless', 'daily', 'levels'].includes(mode)) return fail(400, 'Unknown mode.');
  const now = Date.now();
  const rank = int(b.rank, 999), skin = typeof b.skin === 'string' ? b.skin.slice(0, 16) : 'ember';
  const day = today();
  const score = int(b.score, 5_000_000), seconds = int(b.seconds, 86_400);
  // Plausibility: even a perfect Fever run can't earn more than this per second.
  if (mode !== 'levels' && score > 80 + seconds * 400) return fail(422, 'That score could not be verified.');

  const plus = await hasPlus(s.id, s.name);
  let tooFast = false;
  const doc = await mutate('scores', s.id, d => {
    if (now - (d.lastAt || 0) < 2500) { tooFast = true; return undefined; }
    tooFast = false;
    if (mode === 'levels') { d.stars = Math.max(d.stars || 0, int(b.stars, 45)); d.cleared = Math.max(d.cleared || 0, int(b.cleared, 15)); }
    else if (mode === 'endless') d.endless = Math.max(d.endless || 0, score);
    else { if (d.dailyDay !== day) { d.dailyDay = day; d.daily = 0; } d.daily = Math.max(d.daily || 0, score); }
    d.runs = (d.runs || 0) + 1; d.lastAt = now; d.rank = rank; d.skin = skin; d.name = s.name; d.plus = plus;
    return d;
  }, { id: s.id, name: s.name, endless: 0, daily: 0, dailyDay: '', stars: 0, cleared: 0, runs: 0, lastAt: 0 });
  if (tooFast) return fail(429, 'Scores are coming in too fast.');

  let place = null, best = 0;
  if (mode === 'levels') {
    best = doc.stars;
    place = await upsertBoard('levels', { id: s.id, name: s.name, score: doc.stars, cleared: doc.cleared, rank, skin, plus, at: now },
      (n, o) => n.score > o.score || (n.score === o.score && n.cleared > o.cleared));
    if (b.won && Number.isFinite(b.level)) await pushFeed({ id: s.id, name: s.name, mode, level: int(b.level, 15), stars: int(b.levelStars, 3), at: now });
  } else {
    best = mode === 'endless' ? doc.endless : doc.daily;
    const key = mode === 'endless' ? 'endless' : 'daily-' + day;
    place = await upsertBoard(key, { id: s.id, name: s.name, score: best, rank, skin, plus, at: now }, (n, o) => n.score > o.score);
    if (score > 0) await pushFeed({ id: s.id, name: s.name, mode, score, at: now });
  }
  await Promise.all([bump('stats', { runs: 1 }), bump('day-' + day, { runs: 1 })]);
  return json({ ok: true, best, place });
}

async function leaderboard(url) {
  const board = url.searchParams.get('board') || 'endless';
  const day = today();
  const key = board === 'daily' ? 'daily-' + day : board === 'levels' ? 'levels' : 'endless';
  const rows = (await store('boards').get(key, { type: 'json' })) || [];
  return json({ board, day, rows: rows.map(({ id, name, score, cleared, rank, skin, plus }) => ({ id, name, score, cleared: cleared || 0, rank, skin, plus: !!plus })) });
}

async function feed() {
  const meta = store('meta');
  const [events, stats, todayStats] = await Promise.all([
    meta.get('feed', { type: 'json' }), meta.get('stats', { type: 'json' }), meta.get('day-' + today(), { type: 'json' }),
  ]);
  return json({ events: events || [], champions: await champions(), stats: { players: stats?.players || 0, runs: stats?.runs || 0, runsToday: todayStats?.runs || 0 } });
}

async function player(url) {
  const name = url.searchParams.get('name') || '';
  if (!NAME_RE.test(name)) return fail(404, 'No player with that name.');
  const user = await store('users').get('name/' + name.toLowerCase(), { type: 'json' });
  if (!user) return fail(404, 'No player with that name.');
  const d = (await store('scores').get(user.id, { type: 'json' })) || {};
  const champ = await champions();
  const crowns = Object.entries(champ).filter(([, id]) => id === user.id).map(([k]) => k);
  return json({
    crowns, challengeWins: d.challengeWins || 0, id: user.id,
    name: user.name, joined: user.createdAt, rank: d.rank || 1, skin: d.skin || 'ember', runs: d.runs || 0,
    endless: d.endless || 0, daily: d.dailyDay === today() ? d.daily || 0 : 0, stars: d.stars || 0, cleared: d.cleared || 0,
    plus: !!d.plus || isComped(user.name),
  });
}

// ---------- presence ----------
// Each heartbeat writes "<minute>/<clientId>~<status>". Online = distinct clients seen in
// this minute or the last one.
async function presence(req) {
  const { cid = '', status = 'menu' } = await body(req, 500);
  if (!CID_RE.test(cid)) return fail(400, 'Bad client id.');
  const st = status === 'playing' ? 'playing' : 'menu';
  const pres = store('presence'), bucket = Math.floor(Date.now() / 60e3);
  await pres.setJSON(`${bucket}/${cid}~${st}`, { t: Date.now() });
  const [cur, prev] = await Promise.all([pres.list({ prefix: `${bucket}/` }), pres.list({ prefix: `${bucket - 1}/` })]);
  const seen = new Map();
  for (const { key } of [...prev.blobs, ...cur.blobs]) {
    const [id, s] = key.split('/')[1].split('~');
    seen.set(id, s);
  }
  if (Math.random() < 0.05) {
    for (let b = bucket - 6; b <= bucket - 2; b++) {
      const old = await pres.list({ prefix: `${b}/` });
      await Promise.all(old.blobs.map(x => pres.delete(x.key)));
    }
  }
  const playing = [...seen.values()].filter(s => s === 'playing').length;
  return json({ online: seen.size, playing });
}

// ---------- Coil Rush Plus (Stripe Payment Links) ----------
function paymentConfig() {
  const link = process.env.STRIPE_PAYMENT_LINK || '';
  return { enabled: /^https:\/\/(buy|checkout)\.stripe\.com\//.test(link) && !!process.env.STRIPE_WEBHOOK_SECRET, link, price: process.env.PLUS_PRICE || '$2.99' };
}
async function publicConfig() {
  const p = paymentConfig();
  return json({ plus: p.enabled ? { enabled: true, link: p.link, price: p.price } : { enabled: false } });
}

// Stripe signs every webhook: header "t=<unix>,v1=<hex hmac of `${t}.${rawBody}`>".
function verifyStripe(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = header.split(',').map(x => x.split('='));
  const t = (parts.find(([k]) => k === 't') || [])[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'));
  return sigs.some(v => { const got = Buffer.from(v); return got.length === want.length && timingSafeEqual(got, want); });
}
async function setPlus(userId, active, extra) {
  await mutate('plus', userId, cur => ({ ...cur, ...extra, active, updatedAt: new Date().toISOString() }), {});
  await mutate('scores', userId, d => (d.id ? { ...d, plus: active } : undefined), {});
}
async function stripeWebhook(req) {
  const raw = await req.text();
  if (!verifyStripe(raw, req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) return fail(400, 'Bad signature.');
  let event; try { event = JSON.parse(raw); } catch { return fail(400, 'Bad JSON.'); }
  const obj = event.data && event.data.object || {};
  const plusStore = store('plus');
  if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && obj.payment_status === 'paid') {
    const uid = obj.client_reference_id;
    if (typeof uid === 'string' && CLAIM_RE.test(uid)) {
      // A guest paid before making an account: park the purchase until they sign in and claim it.
      await mutate('plus', 'claim/' + uid, cur => (cur.paid ? undefined : { ...cur, paid: true, session: obj.id, paidAt: new Date().toISOString() }), {});
      if (obj.payment_intent) await plusStore.setJSON('pi/' + obj.payment_intent, { claim: uid });
      console.log('[plus] guest purchase waiting to be claimed', uid);
    } else if (typeof uid === 'string' && /^[0-9a-f-]{36}$/i.test(uid)) {
      await setPlus(uid, true, { since: new Date().toISOString(), session: obj.id, paymentIntent: obj.payment_intent || null });
      if (obj.payment_intent) await plusStore.setJSON('pi/' + obj.payment_intent, { uid });
      console.log('[plus] granted', uid);
    } else console.warn('[plus] paid checkout without a valid client_reference_id', obj.id);
  } else if (event.type === 'charge.refunded' && obj.payment_intent) {
    const link = await plusStore.get('pi/' + obj.payment_intent, { type: 'json' });
    let uid = link && link.uid;
    if (link && link.claim) {
      const c = await mutate('plus', 'claim/' + link.claim, cur => ({ ...cur, refunded: true }), {});
      uid = c.uid;
    }
    if (uid) { await setPlus(uid, false, { refundedAt: new Date().toISOString() }); console.log('[plus] revoked after refund', uid); }
  }
  return json({ received: true });
}

async function claimStatus(url) {
  const c = url.searchParams.get('c') || '';
  if (!CLAIM_RE.test(c)) return fail(400, 'Bad claim code.');
  const rec = await store('plus').get('claim/' + c, { type: 'json' });
  return json({ paid: !!(rec && rec.paid && !rec.refunded), claimed: !!(rec && rec.uid) });
}
async function claim(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in to claim Plus.');
  const { claim: c = '' } = await body(req, 500);
  if (!CLAIM_RE.test(c)) return fail(400, 'Bad claim code.');
  let result = 'none';
  await mutate('plus', 'claim/' + c, cur => {
    if (!cur.paid || cur.refunded) { result = 'unpaid'; return undefined; }
    if (cur.uid) { result = cur.uid === s.id ? 'ok' : 'taken'; return undefined; }
    result = 'ok'; return { ...cur, uid: s.id, claimedAt: new Date().toISOString() };
  }, {});
  if (result === 'ok') { await setPlus(s.id, true, { since: new Date().toISOString(), viaClaim: c }); return json({ ok: true, plus: true }); }
  if (result === 'taken') return fail(409, 'This purchase is already linked to another account.');
  return json({ ok: false, plus: await hasPlus(s.id, s.name) });
}

// ---------- push notifications ----------
// Keys are generated once and kept in Blobs, so notifications work with no setup. To use your
// own keys instead, set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (and optionally VAPID_SUBJECT).
let vapidCache = null;
async function vapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  if (vapidCache) return vapidCache;
  const meta = store('meta');
  let v = await meta.get('vapid', { type: 'json' });
  if (!v) { await meta.setJSON('vapid', webpush.generateVAPIDKeys(), { onlyIfNew: true }); v = await meta.get('vapid', { type: 'json' }); }
  return (vapidCache = v);
}
const pushSubject = () => process.env.VAPID_SUBJECT || (process.env.URL && process.env.URL.startsWith('https://') ? process.env.URL : 'mailto:notifications@coilrush.app');
const validSub = sub => sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000
  && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string' && sub.keys.p256dh.length < 200 && sub.keys.auth.length < 100;

// Send a notification to every device a player has turned notifications on for. Never throws.
async function notify(userId, payload) {
  try {
    const subs = (await store('push').get('u/' + userId, { type: 'json' })) || [];
    if (!subs.length) return;
    const keys = await vapid();
    const dead = [];
    await Promise.allSettled(subs.map(sub => webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 24 * 3600, urgency: 'high', timeout: 5000,
      vapidDetails: { subject: pushSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
    }).catch(e => { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(sub.endpoint); else console.warn('[push] send failed', e && e.statusCode, e && e.body); })));
    if (dead.length) await mutate('push', 'u/' + userId, list => list.filter(x => !dead.includes(x.endpoint)), []);
  } catch (e) { console.warn('[push] notify error', e && e.message); }
}
async function pushKey() { return json({ publicKey: (await vapid()).publicKey }); }
async function pushSubscribe(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in to turn on notifications.');
  const { subscription } = await body(req, 3000);
  if (!validSub(subscription)) return fail(400, 'That notification subscription is not valid.');
  const clean = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
  await mutate('push', 'u/' + s.id, list => [clean, ...list.filter(x => x.endpoint !== clean.endpoint)].slice(0, 6), []);
  return json({ ok: true });
}
async function pushUnsubscribe(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in first.');
  const { endpoint = '' } = await body(req, 2000);
  await mutate('push', 'u/' + s.id, list => (list.some(x => x.endpoint === endpoint) ? list.filter(x => x.endpoint !== endpoint) : undefined), []);
  return json({ ok: true });
}
async function pushTest(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in first.');
  await notify(s.id, { title: 'Notifications are on', body: "You'll hear about it here when someone challenges you.", url: '/#challenges', tag: 'test' });
  return json({ ok: true });
}
const fmt = n => Number(n).toLocaleString('en-US');

// ---------- challenges ----------
// A challenge: reach `target` points in one Endless run on a shared seed. Fastest time to the
// target wins; it ends when both players have hit it or 24h after it was accepted (then the
// one who hit it wins, or the higher score if nobody did). Pending invites expire after 48h.
const TARGETS = [500, 1000, 2000, 3000];
const CH_PLAY_MS = 24 * 3600e3, CH_PENDING_MS = 48 * 3600e3;
const CHID_RE = /^[A-Za-z0-9_-]{8,24}$/;
const chView = c => ({ id: c.id, target: c.target, status: c.status, from: c.from, to: c.to || null, createdAt: c.createdAt,
  expiresAt: c.expiresAt, deadline: c.deadline || null, results: c.results || {}, winner: c.winner || null, endedAt: c.endedAt || null });

function settle(c, now = Date.now()) {
  if (c.status === 'pending' && now > c.expiresAt) { c.status = 'expired'; return true; }
  if (c.status !== 'active') return false;
  const a = c.results[c.from.id] || {}, b = c.results[c.to.id] || {};
  if (now < c.deadline && !(a.reach != null && b.reach != null)) return false;
  let winner = null;
  if (a.reach != null && b.reach != null) winner = a.reach < b.reach ? c.from.id : b.reach < a.reach ? c.to.id : null;
  else if (a.reach != null || b.reach != null) winner = a.reach != null ? c.from.id : c.to.id;
  else if ((a.best || 0) !== (b.best || 0)) winner = (a.best || 0) > (b.best || 0) ? c.from.id : c.to.id;
  c.status = 'done'; c.winner = winner; c.endedAt = now;
  return true;
}
// Apply fn to a challenge atomically, settle it, and run the one-time "finished" side effects.
async function updateChallenge(id, fn) {
  let finished = false, error = null;
  const doc = await mutate('challenges', 'c/' + id, cur => {
    if (!cur.id) { error = [404, 'That challenge no longer exists.']; return undefined; }
    const before = cur.status;
    if (fn) { const r = fn(cur); if (typeof r === 'object' && r && r.error) { error = r.error; return undefined; } }
    settle(cur);
    finished = before !== 'done' && cur.status === 'done';
    return cur;
  }, {});
  if (error) throw Object.assign(new Error(error[1]), { status: error[0] });
  if (finished) {
    const w = doc.winner, names = { [doc.from.id]: doc.from.name, [doc.to.id]: doc.to.name };
    const loser = w ? (w === doc.from.id ? doc.to.id : doc.from.id) : null;
    await pushFeed(w
      ? { id: w, name: names[w], mode: 'challenge', vs: names[loser], target: doc.target, reach: doc.results[w]?.reach ?? null, at: Date.now() }
      : { id: doc.from.id, name: doc.from.name, mode: 'challenge', vs: doc.to.name, target: doc.target, draw: true, at: Date.now() });
    const t = fmt(doc.target);
    if (w) {
      const wr = doc.results[w]?.reach;
      await Promise.all([
        notify(w, { title: 'You won the challenge! 👑', body: `You beat ${names[loser]} to ${t}${wr != null ? ` in ${wr}s` : ''}.`, url: '/#challenges', tag: 'ch-' + doc.id }),
        notify(loser, { title: `${names[w]} won the challenge`, body: `${names[w]} beat you to ${t}. Fancy a rematch?`, url: '/#challenges', tag: 'ch-' + doc.id }),
      ]);
    } else {
      await Promise.all([doc.from.id, doc.to.id].map(id => notify(id, { title: 'Challenge ended in a draw', body: `Your ${t} challenge was a draw. Go again?`, url: '/#challenges', tag: 'ch-' + doc.id })));
    }
    if (w) await mutate('scores', w, d => ({ endless: 0, daily: 0, dailyDay: '', stars: 0, cleared: 0, runs: 0, lastAt: 0, ...d, id: w, name: names[w], challengeWins: (d.challengeWins || 0) + 1 }), {});
  }
  return doc;
}
async function indexChallenge(userId, id) {
  await mutate('challenges', 'u/' + userId, list => { if (list.includes(id)) return undefined; list.unshift(id); list.length = Math.min(list.length, 40); return list; }, []);
}

async function createChallenge(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in to challenge players.');
  const { to = '', target } = await body(req, 1000);
  if (!TARGETS.includes(target)) return fail(400, 'Pick a target of 500, 1,000, 2,000 or 3,000.');
  let toUser = null;
  if (to) {
    if (!NAME_RE.test(to)) return fail(404, 'No player with that name.');
    const u = await store('users').get('name/' + to.toLowerCase(), { type: 'json' });
    if (!u) return fail(404, 'No player with that name.');
    if (u.id === s.id) return fail(400, "You can't challenge yourself.");
    toUser = { id: u.id, name: u.name };
  }
  const mine = (await store('challenges').get('u/' + s.id, { type: 'json' })) || [];
  const docs = await Promise.all(mine.slice(0, 20).map(id => store('challenges').get('c/' + id, { type: 'json' })));
  const open = docs.filter(c => c && c.from.id === s.id && (c.status === 'pending' || c.status === 'active') && !(c.status === 'pending' && Date.now() > c.expiresAt));
  if (open.length >= 5) return fail(429, 'You already have 5 open challenges. Finish or cancel one first.');
  const now = Date.now(), id = randomBytes(9).toString('base64url');
  const doc = { id, target, status: 'pending', from: { id: s.id, name: s.name }, to: toUser, createdAt: now, expiresAt: now + CH_PENDING_MS, results: {} };
  await store('challenges').setJSON('c/' + id, doc, { onlyIfNew: true });
  await indexChallenge(s.id, id);
  if (toUser) {
    await indexChallenge(toUser.id, id);
    await notify(toUser.id, { title: "You've been challenged! ⚔️", body: `${s.name} challenged you to hit ${fmt(target)} points. Fastest time wins. Tap to accept.`, url: '/#challenges', tag: 'ch-' + id });
  }
  return json({ challenge: chView(doc) }, 201);
}

async function challengeAction(req, action) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in first.');
  const { id = '' } = await body(req, 500);
  if (!CHID_RE.test(id)) return fail(404, 'That challenge no longer exists.');
  let wasOpen = false;
  const doc = await updateChallenge(id, c => {
    settle(c);
    if (action === 'accept') {
      if (c.status !== 'pending') return { error: [409, c.status === 'expired' ? 'This challenge has expired.' : 'This challenge was already taken or closed.'] };
      if (c.from.id === s.id) return { error: [400, "You can't accept your own challenge."] };
      if (c.to && c.to.id !== s.id) return { error: [403, 'This challenge is for someone else.'] };
      if (!c.to) { c.to = { id: s.id, name: s.name }; wasOpen = true; }
      c.status = 'active'; c.deadline = Date.now() + CH_PLAY_MS;
    } else if (action === 'decline') {
      if (c.status !== 'pending' || !c.to || c.to.id !== s.id) return { error: [409, 'You can only decline a challenge sent to you.'] };
      c.status = 'declined';
    } else if (action === 'cancel') {
      if (c.status !== 'pending' || c.from.id !== s.id) return { error: [409, 'Only waiting challenges you sent can be cancelled.'] };
      c.status = 'cancelled';
    }
  });
  if (wasOpen) await indexChallenge(s.id, id);
  if (action === 'accept' && doc.status === 'active')
    await notify(doc.from.id, { title: 'Challenge accepted', body: `${s.name} accepted your ${fmt(doc.target)} challenge. Game on!`, url: '/#challenges', tag: 'ch-' + id });
  return json({ challenge: chView(doc) });
}

async function challengeResult(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in first.');
  const b = await body(req, 1000);
  if (!CHID_RE.test(b.id || '')) return fail(404, 'That challenge no longer exists.');
  const score = int(b.score, 5_000_000), seconds = Number.isFinite(b.seconds) ? Math.max(0, b.seconds) : 0;
  const reach = b.reach == null ? null : Number(b.reach);
  if (score > 80 + seconds * 400) return fail(422, 'That score could not be verified.');
  let improved = null;
  const doc = await updateChallenge(b.id, c => {
    improved = null;
    if (c.status !== 'active' || !c.to || ![c.from.id, c.to.id].includes(s.id)) return { error: [409, 'This challenge is not running.'] };
    if (Date.now() > c.deadline + 120e3) return { error: [409, 'This challenge has ended.'] };
    let r = reach;
    if (r != null && !(Number.isFinite(r) && r > 0 && r <= seconds + 0.5 && r >= (c.target - 80) / 400 && score >= c.target)) r = null;
    const cur = c.results[s.id] || { best: 0, reach: null, tries: 0 };
    if (r != null && (cur.reach == null || r < cur.reach)) improved = Math.round(r * 10) / 10;
    c.results[s.id] = { best: Math.max(cur.best || 0, score), reach: r == null ? cur.reach : cur.reach == null ? Math.round(r * 10) / 10 : Math.min(cur.reach, Math.round(r * 10) / 10), tries: (cur.tries || 0) + 1 };
  });
  if (improved != null && doc.status === 'active') {
    const opp = doc.from.id === s.id ? doc.to : doc.from;
    await notify(opp.id, { title: `${s.name} set a time: ${improved}s`, body: `${s.name} hit ${fmt(doc.target)} in ${improved}s. Can you beat it?`, url: '/#challenges', tag: 'ch-' + doc.id });
  }
  return json({ challenge: chView(doc) });
}

async function listChallenges(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in first.');
  const ids = (await store('challenges').get('u/' + s.id, { type: 'json' })) || [];
  const docs = [];
  for (const id of ids) {
    let c = await store('challenges').get('c/' + id, { type: 'json' });
    if (!c) continue;
    if (settle({ ...c, results: { ...c.results } })) c = await updateChallenge(id);   // write the settled state once
    docs.push(chView(c));
  }
  return json({ challenges: docs, now: Date.now() });
}

async function getChallenge(url) {
  const id = url.searchParams.get('id') || '';
  if (!CHID_RE.test(id)) return fail(404, 'That challenge no longer exists.');
  const c = await store('challenges').get('c/' + id, { type: 'json' });
  if (!c) return fail(404, 'That challenge no longer exists.');
  const v = { ...c, results: { ...c.results } }; settle(v);
  return json({ challenge: chView(v) });
}

// ---------- direct messages ----------
// One document per pair of players (last 200 messages) plus a small inbox per player.
// Clients check every few seconds while a chat is open; push notifications cover the rest.
const convId = (a, b) => [a, b].sort().join('~');
const MAX_MSG = 500;
async function userByName(name) {
  if (!NAME_RE.test(name || '')) return null;
  const u = await store('users').get('name/' + String(name).toLowerCase(), { type: 'json' });
  return u ? { id: u.id, name: u.name } : null;
}
async function blockedBy(userId) { return (await store('chat').get('block/' + userId, { type: 'json' })) || []; }

async function chatSend(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in to send messages.');
  const b = await body(req, 4000);
  const text = String(b.text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return fail(400, 'Type a message first.');
  if (text.length > MAX_MSG) return fail(400, `Messages can be up to ${MAX_MSG} characters.`);
  const to = await userByName(b.to);
  if (!to) return fail(404, 'No player with that name.');
  if (to.id === s.id) return fail(400, "You can't message yourself.");
  const [theirBlocks, myBlocks] = await Promise.all([blockedBy(to.id), blockedBy(s.id)]);
  if (myBlocks.includes(to.id)) return fail(403, `You blocked ${to.name}. Unblock them to send messages.`);
  if (theirBlocks.includes(s.id)) return fail(403, "You can't message this player.");
  const cid = convId(s.id, to.id), now = Date.now();
  const msg = { id: randomBytes(6).toString('base64url'), from: s.id, text, at: now };
  let limited = null;
  await mutate('chat', 't/' + cid, c => {
    const mine = (c.m || []).filter(m => m.from === s.id);
    const last = mine[mine.length - 1];
    if (last && now - last.at < 600) { limited = 'Slow down a little.'; return undefined; }
    if (mine.filter(m => now - m.at < 60e3).length >= 20) { limited = 'You are sending messages too fast. Wait a minute.'; return undefined; }
    limited = null;
    return { p: { [s.id]: s.name, [to.id]: to.name }, m: [...(c.m || []), msg].slice(-200), updatedAt: now };
  }, {});
  if (limited) return fail(429, limited);
  const preview = text.length > 90 ? text.slice(0, 89) + '…' : text;
  await mutate('chat', 'inbox/' + s.id, ib => ({ ...ib, [cid]: { ...(ib[cid] || {}), with: to, last: { text: preview, from: s.id, at: now }, unread: 0, seenAt: now, updatedAt: now } }), {});
  let shouldPush = false;
  await mutate('chat', 'inbox/' + to.id, ib => {
    const e = ib[cid] || {};
    const watching = e.seenAt && now - e.seenAt < 8000;          // they have this chat open right now
    shouldPush = !watching && !(e.lastPushAt && now - e.lastPushAt < 45e3);
    return { ...ib, [cid]: { ...e, with: { id: s.id, name: s.name }, last: { text: preview, from: s.id, at: now }, unread: (e.unread || 0) + 1, updatedAt: now, ...(shouldPush ? { lastPushAt: now } : {}) } };
  }, {});
  if (shouldPush) await notify(to.id, { title: s.name, body: preview, url: '/#chat-' + s.name, tag: 'chat-' + cid });
  return json({ message: msg });
}

async function chatThread(req, url) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in to read messages.');
  const other = await userByName(url.searchParams.get('with'));
  if (!other) return fail(404, 'No player with that name.');
  const cid = convId(s.id, other.id), since = Number(url.searchParams.get('since')) || 0, now = Date.now();
  const chat = store('chat');
  const [conv, mine, theirs, myBlocks, theirBlocks] = await Promise.all([
    chat.get('t/' + cid, { type: 'json' }), chat.get('inbox/' + s.id, { type: 'json' }), chat.get('inbox/' + other.id, { type: 'json' }),
    blockedBy(s.id), blockedBy(other.id),
  ]);
  const all = (conv && conv.m) || [];
  const messages = since ? all.filter(m => m.at > since) : all.slice(-60);
  const e = (mine || {})[cid];
  if (e && (e.unread || !e.seenAt || now - e.seenAt > 6000))   // mark read / "I'm watching" without writing on every check
    await mutate('chat', 'inbox/' + s.id, ib => (ib[cid] ? { ...ib, [cid]: { ...ib[cid], unread: 0, seenAt: now } } : undefined), {});
  else if (!e && all.length) await mutate('chat', 'inbox/' + s.id, ib => ({ ...ib, [cid]: { with: other, unread: 0, seenAt: now, updatedAt: all[all.length - 1].at, last: null } }), {});
  return json({ with: other, messages, otherSeenAt: ((theirs || {})[cid] || {}).seenAt || 0,
    blocked: { byMe: myBlocks.includes(other.id), byThem: theirBlocks.includes(s.id) }, now });
}

async function chatInbox(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in to see messages.');
  const ib = (await store('chat').get('inbox/' + s.id, { type: 'json' })) || {};
  const convs = Object.values(ib).filter(c => c.last).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50)
    .map(c => ({ with: c.with, last: c.last, unread: c.unread || 0, updatedAt: c.updatedAt }));
  return json({ conversations: convs, unread: convs.reduce((n, c) => n + c.unread, 0) });
}

async function chatBlock(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in first.');
  const { name = '', block = true } = await body(req, 500);
  const other = await userByName(name);
  if (!other || other.id === s.id) return fail(404, 'No player with that name.');
  await mutate('chat', 'block/' + s.id, list => {
    const has = list.includes(other.id);
    if (block && !has) return [...list, other.id].slice(-500);
    if (!block && has) return list.filter(x => x !== other.id);
    return undefined;
  }, []);
  return json({ ok: true, blocked: !!block });
}

async function chatReport(req) {
  const s = await session(req);
  if (!s) return fail(401, 'Sign in first.');
  const { name = '', reason = '' } = await body(req, 2000);
  const other = await userByName(name);
  if (!other) return fail(404, 'No player with that name.');
  const conv = await store('chat').get('t/' + convId(s.id, other.id), { type: 'json' });
  const recent = ((conv && conv.m) || []).filter(m => m.from === other.id).slice(-10);
  const report = { at: new Date().toISOString(), by: s.name, about: other.name, reason: String(reason).slice(0, 300), recent };
  await mutate('meta', 'reports', list => [report, ...list].slice(0, 200), []);
  console.warn('[report]', JSON.stringify(report));
  return json({ ok: true });
}

// Current #1s, for crowns.
async function champions() {
  const b = store('boards');
  const [e, l, d] = await Promise.all([b.get('endless', { type: 'json' }), b.get('levels', { type: 'json' }), b.get('daily-' + today(), { type: 'json' })]);
  const top = rows => (rows && rows[0] ? rows[0].id : null);
  return { endless: top(e), levels: top(l), daily: top(d) };
}

// Crash reports from players' browsers. They show up in Netlify → Logs → Functions → api.
async function clientLog(req) {
  const b = await body(req, 6000);
  const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  console.error('[client error]', JSON.stringify({
    message: clip(b.message, 300), stack: clip(b.stack, 1500), where: clip(b.where, 60),
    state: clip(b.state, 20), mode: clip(b.mode, 20), ua: clip(req.headers.get('user-agent'), 200), at: new Date().toISOString(),
  }));
  return json({ ok: true });
}

// ---------- router ----------
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const route = `${req.method} ${path}`;
  try {
    switch (route) {
      case 'GET health': return json({ ok: true, app: 'coil-rush' });
      case 'POST register': return await register(req);
      case 'POST login': return await login(req);
      case 'GET me': return await me(req);
      case 'PUT profile': return await saveProfile(req);
      case 'POST score': return await submitScore(req);
      case 'GET leaderboard': return await leaderboard(url);
      case 'GET feed': return await feed();
      case 'GET player': return await player(url);
      case 'POST presence': return await presence(req);
      case 'POST log': return await clientLog(req);
      case 'GET config': return await publicConfig();
      case 'GET claim': return await claimStatus(url);
      case 'POST chat/send': return await chatSend(req);
      case 'GET chat/thread': return await chatThread(req, url);
      case 'GET chat/inbox': return await chatInbox(req);
      case 'POST chat/block': return await chatBlock(req);
      case 'POST chat/report': return await chatReport(req);
      case 'GET push/key': return await pushKey();
      case 'POST push/subscribe': return await pushSubscribe(req);
      case 'POST push/unsubscribe': return await pushUnsubscribe(req);
      case 'POST push/test': return await pushTest(req);
      case 'GET challenges': return await listChallenges(req);
      case 'POST challenges': return await createChallenge(req);
      case 'GET challenge': return await getChallenge(url);
      case 'POST challenge/accept': return await challengeAction(req, 'accept');
      case 'POST challenge/decline': return await challengeAction(req, 'decline');
      case 'POST challenge/cancel': return await challengeAction(req, 'cancel');
      case 'POST challenge/result': return await challengeResult(req);
      case 'POST claim': return await claim(req);
      case 'POST stripe-webhook': return await stripeWebhook(req);
      default: return fail(404, 'Not found.');
    }
  } catch (e) {
    if (e && e.status) return fail(e.status, e.message);
    console.error(e);
    return fail(500, 'Something went wrong on the server.');
  }
};
