// Coil Rush API: one Netlify Function serving /api/*.
// Coil Rush Plus (optional): set STRIPE_PAYMENT_LINK and STRIPE_WEBHOOK_SECRET to turn the
// paywall on. Without them the game stays fully free and no Plus UI is shown. Storage is Netlify Blobs, so there's
// no external database to set up. Accounts are username + password only (scrypt-hashed);
// sessions are HMAC-signed tokens. Set SESSION_SECRET in Netlify's environment variables to
// pin the signing key; if it's missing, a random key is generated once and kept in Blobs.
import { getStore } from '@netlify/blobs';
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
  return json({ events: events || [], stats: { players: stats?.players || 0, runs: stats?.runs || 0, runsToday: todayStats?.runs || 0 } });
}

async function player(url) {
  const name = url.searchParams.get('name') || '';
  if (!NAME_RE.test(name)) return fail(404, 'No player with that name.');
  const user = await store('users').get('name/' + name.toLowerCase(), { type: 'json' });
  if (!user) return fail(404, 'No player with that name.');
  const d = (await store('scores').get(user.id, { type: 'json' })) || {};
  return json({
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
