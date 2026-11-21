// Online layer, all optional: shared leaderboard (db), identity (user), live presence (room),
// AI coach (sample). Every feature degrades to "offline" when a capability is missing.
import { dayKey } from './rng.js';

const safeNum = v => (Number.isFinite(v) && v >= 0 && v < 1e7 ? Math.floor(v) : 0);

// Picks the backend: claude.ai capabilities when hosted as an artifact, otherwise the
// Netlify API (/api/*) when deployed there, otherwise offline (null).
export async function initOnline() {
  const c = window.claude;
  if (c && typeof c.use === 'function') return initClaude(c);
  return initNetlify();
}

async function initClaude(c) {
  const get = n => c.use(n).catch(() => null);
  const [db, user, room, sample] = await Promise.all([get('db'), get('user'), get('room'), get('sample')]);
  const uid = user ? await user.id() : null;
  let chain = Promise.resolve();
  const queue = fn => (chain = chain.then(fn).catch(() => {}));
  let mine = null; // my scores/<uid> doc body

  const api = {
    uid, sample, hasBoard: !!db, hasRoom: !!room,

    async loadProfile() {
      if (!db || !uid) return null;
      try { const s = await db.doc(`data/users/${uid}/profile`).get(); return s.exists ? s.data() : null; }
      catch (e) { return null; }
    },
    saveProfile(p) {
      if (!db || !uid) return;
      const body = JSON.parse(JSON.stringify(p));
      queue(() => db.doc(`data/users/${uid}/profile`).set(body));
    },

    async loadMine() {
      if (!db || !uid) return;
      try { const s = await db.doc(`scores/${uid}`).get(); mine = s.exists ? { ...s.data() } : null; } catch (e) {}
    },
    // One write per finished run, only when something improved.
    submit(mode, score, level, skin) {
      if (!db || !uid || mode === 'zen' || score <= 0) return;
      const today = dayKey();
      const body = { endless: 0, endlessAt: '', dailyDay: '', daily: 0, ...(mine || {}) };
      let changed = !mine || body.level !== level || body.skin !== skin;
      if (mode === 'endless' && score > safeNum(body.endless)) { body.endless = score; body.endlessAt = new Date().toISOString(); changed = true; }
      if (mode === 'daily') {
        if (body.dailyDay !== today) { body.dailyDay = today; body.daily = score; changed = true; }
        else if (score > safeNum(body.daily)) { body.daily = score; changed = true; }
      }
      body.level = level; body.skin = skin;
      if (!changed) return;
      mine = body;
      queue(() => db.doc(`scores/${uid}`).set(body));
    },
    myBest(which) {
      if (!mine) return 0;
      if (which === 'daily') return mine.dailyDay === dayKey() ? safeNum(mine.daily) : 0;
      return safeNum(mine.endless);
    },

    // cb(which, {state: 'loading'|'ready'|'slow'|'error', rows})
    watchBoards(cb) {
      if (!db) return;
      const col = db.collection('scores');
      const defs = {
        daily: col.where('dailyDay', '==', dayKey()).orderBy('daily', 'desc').limit(10),
        all: col.orderBy('endless', 'desc').limit(10),
      };
      for (const [which, q] of Object.entries(defs)) {
        const field = which === 'daily' ? 'daily' : 'endless';
        let timer = setTimeout(() => cb(which, { state: 'slow', rows: null }), 10000);
        q.onSnapshot(snap => {
          if (!snap.metadata.fromCache) { clearTimeout(timer); timer = null; }
          const rows = snap.docs.map(d => ({ id: d.id, score: safeNum(d.data()[field]), level: safeNum(d.data().level) }))
            .filter(r => r.score > 0);
          cb(which, { state: 'ready', rows });
        }, () => { clearTimeout(timer); cb(which, { state: 'error', rows: null }); });
      }
    },

    async profiles(ids) {
      if (!user || !ids.length) return {};
      try { return await user.profiles(ids); } catch (e) { return {}; }
    },

    // Presence: who is here and who is mid-run.
    setStatus(status, mode) { if (room) room.presence({ status, mode: mode || null }).catch(() => {}); },
    online() {
      if (!room) return null;
      const peers = room.peers().filter(p => p.kind === 'viewer');
      return { here: peers.length, playing: peers.filter(p => p.presence && p.presence.status === 'playing').length };
    },
    announce(mode, score) { if (room && score > 0 && mode !== 'zen') room.emit('run', { mode, score }).catch(() => {}); },
    onRun(fn) {
      if (!room) return;
      room.on('run', msg => {
        if (msg.isMe || !msg.data || typeof msg.data !== 'object') return;
        const score = safeNum(msg.data.score), mode = msg.data.mode === 'daily' ? 'daily' : 'endless';
        if (score > 0) fn({ by: msg.by, score, mode });
      }, () => {});
    },
  };
  return api;
}

// ---------- Netlify backend ----------
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
function clientId() {
  let id = LS.get('coilrush.cid');
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); LS.set('coilrush.cid', id); }
  return id;
}
export function avatarFor(name) {
  const hue = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="hsl(${hue} 70% 62%)"/><text x="20" y="26" font-family="system-ui,sans-serif" font-size="17" font-weight="700" text-anchor="middle" fill="#0f1428">${name.slice(0, 2).toUpperCase().replace(/[^A-Z0-9_]/g, '')}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

async function initNetlify() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok || !(await r.json()).ok) return null;
  } catch (e) { return null; }

  let auth = LS.get('coilrush.auth');           // { token, user: { id, name } }
  let mine = null, counts = null, status = 'menu', lastBeat = 0, feedData = null;
  const names = new Map(), authFns = new Set(), feedFns = new Set(), boardFns = [];
  const cid = clientId();

  async function call(path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = 'Bearer ' + auth.token;
    let res;
    try { res = await fetch('/api/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
    catch (e) { throw Object.assign(new Error('Could not reach the server. Check your connection.'), { status: 0 }); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && auth && !path.startsWith('login')) setAuth(null);
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: res.status });
    return data;
  }
  function setAuth(a) {
    auth = a; LS.set('coilrush.auth', a); mine = null;
    authFns.forEach(fn => { try { fn(a ? a.user : null); } catch (e) {} });
  }

  let chain = Promise.resolve(), saveTimer = null, pending = null;
  const api = {
    kind: 'netlify', sample: null, hasBoard: true, hasLevelsBoard: true, hasLive: true, hasRoom: true,
    get uid() { return auth ? auth.user.id : null; },

    auth: {
      get user() { return auth ? auth.user : null; },
      async login(username, password) { const r = await call('login', { method: 'POST', body: { username, password } }); setAuth(r); return r.user; },
      async register(username, password) { const r = await call('register', { method: 'POST', body: { username, password } }); setAuth(r); return r.user; },
      logout() { setAuth(null); },
      onChange(fn) { authFns.add(fn); },
    },

    async loadProfile() {
      if (!auth) return null;
      try { const r = await call('me'); mine = r.scores; return r.profile; } catch (e) { return null; }
    },
    saveProfile(p) {
      if (!auth) return;
      pending = JSON.parse(JSON.stringify(p));
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const body = pending; pending = null;
        chain = chain.then(() => call('profile', { method: 'PUT', body })).catch(() => {});
      }, 1200);
    },
    async loadMine() {
      if (!auth) return;
      try { mine = (await call('me')).scores; } catch (e) {}
    },
    async submit(mode, score, rank, skin, seconds) {
      if (!auth || mode === 'zen') return null;
      try { const r = await call('score', { method: 'POST', body: { mode, score, seconds, rank, skin } }); await api.loadMine(); refreshBoards(); refreshFeed(); return r; }
      catch (e) { return { error: e.message }; }
    },
    async submitLevels({ stars, cleared, rank, skin, level, won, levelStars }) {
      if (!auth) return null;
      try { const r = await call('score', { method: 'POST', body: { mode: 'levels', stars, cleared, rank, skin, level, won, levelStars } }); await api.loadMine(); refreshBoards(); refreshFeed(); return r; }
      catch (e) { return { error: e.message }; }
    },
    myBest(which) {
      if (!mine) return 0;
      if (which === 'daily') return mine.dailyDay === dayKey() ? safeNum(mine.daily) : 0;
      if (which === 'levels') return safeNum(mine.stars);
      return safeNum(mine.endless);
    },

    watchBoards(cb) { boardFns.push(cb); refreshBoards(); setInterval(refreshBoards, 20000); },
    async profiles(ids) {
      const out = {};
      for (const id of ids) { const n = names.get(id) || ''; out[id] = { id, name: n, avatarUrl: n ? avatarFor(n) : '' }; }
      return out;
    },
    async player(name) { return call('player?name=' + encodeURIComponent(name)); },

    setStatus(s) { if (s !== status) { status = s; beat(); } },
    online() { return counts ? { here: counts.online, playing: counts.playing, label: 'online' } : null; },
    announce() {},                       // the server records runs in the feed on submit
    onRun(fn) {
      let seen = null;
      feedFns.add(data => {
        const keys = data.events.map(e => e.id + e.at);
        if (seen) for (const e of data.events) {
          if (seen.has(e.id + e.at) || (auth && e.id === auth.user.id) || e.mode === 'levels') continue;
          fn({ by: e.id, score: safeNum(e.score), mode: e.mode === 'daily' ? 'daily' : 'endless' });
        }
        seen = new Set(keys);
      });
    },
    onFeed(fn) { feedFns.add(fn); if (feedData) fn(feedData); },
  };

  async function refreshBoards() {
    for (const [which, board] of [['daily', 'daily'], ['all', 'endless'], ['levels', 'levels']]) {
      try {
        const r = await call('leaderboard?board=' + board);
        const rows = r.rows.map(x => { names.set(x.id, x.name); return { id: x.id, score: safeNum(x.score), level: safeNum(x.rank), cleared: safeNum(x.cleared), name: x.name }; });
        boardFns.forEach(fn => fn(which, { state: 'ready', rows }));
      } catch (e) { boardFns.forEach(fn => fn(which, { state: 'error', rows: null })); }
    }
  }
  async function refreshFeed() {
    try {
      feedData = await call('feed');
      for (const e of feedData.events) names.set(e.id, e.name);
      feedData.online = counts;
      feedFns.forEach(fn => fn(feedData));
    } catch (e) {}
  }
  async function beat() {
    const now = Date.now();
    if (now - lastBeat < 1500) return;
    lastBeat = now;
    try { counts = await call('presence', { method: 'POST', body: { cid, status } }); } catch (e) {}
  }
  beat(); setInterval(beat, 30000);
  refreshFeed(); setInterval(refreshFeed, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { beat(); refreshFeed(); } });
  return api;
}
