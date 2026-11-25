// App shell: state machine, game loop, input, HUD, panels. Wires engine + renderer + progress + online.
import { Game, autopilot } from './game.js';
import { Renderer } from './render.js';
import { sfx, unlockAudio, setSound, setMusic, setMood, suspendAudio, setVolumes } from './audio.js';
import { LEVELS, starsFor } from './levels.js';
import * as P from './progress.js';
import { initOnline, avatarFor } from './online.js';
import { SKINS, POWER_INFO, MODES, VERSION } from './config.js';
import { makeShareCard } from './sharecard.js';
import { dayKey, hashStr, msUntilReset } from './rng.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------- state ----------
// Progress lives in a separate local slot per signed-in account, so two people sharing a
// device never get each other's progress. Guests use the guest slot.
try { const a = JSON.parse(localStorage.getItem('coilrush.auth') || 'null'); if (a && a.user && a.user.id) P.useKey(P.keyFor(a.user)); } catch (e) {}
let profile = P.loadLocal();
let missions = P.ensureDay(profile);
setSound(profile.sound);
if (profile.music === undefined) profile.music = true;
setMusic(profile.music);
setVolumes(profile.musicVol / 100, profile.sfxVol / 100);
let online = null, onlineChecked = false;

const renderer = new Renderer($('board'));
let state = 'menu';          // menu | select | ready | playing | paused | dying | over
let curLevel = 1, selLevel = 1, levelResult = null;
let challenge = null;        // the challenge this run counts for: { id, target, opp, reach, doc }
let selMode = 'endless';
let game = null, mode = 'endless';
let demo = new Game('demo', (Math.random() * 2 ** 32) >>> 0);
let acc = 0, runTime = 0, readyT = 0, readyDur = 1050, dyingT = 0, overAt = 0, last = performance.now();
let runMissions = [];        // missions completed during this run
let xpBefore = 0, runStreakXp = 0;

// Coil Rush Plus is only active when the server has payments configured (Netlify + Stripe).
const FREE_LEVELS = 5;
const paywallOn = () => !!(online && online.payments && online.payments.enabled);
const isPlus = () => !!(online && online.isPlus);
const plusLocked = n => paywallOn() && !isPlus() && n > FREE_LEVELS;
const skin = () => {
  const s = SKINS.find(k => k.id === profile.skin);
  return s && !(s.plus && !isPlus()) ? s : SKINS[0];
};
const ranked = m => m === 'endless' || m === 'daily';       // leaderboard
const missionMode = m => m !== 'zen';                       // missions count
const fmtTime = s => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s` : `${Math.floor(s)}s`);
const haptic = ms => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} };
const yesterdayKey = () => dayKey(new Date(Date.now() - 864e5));
const dailyBest = () => (profile.dailyDay === dayKey() ? profile.dailyBest : 0);

// ---------- flow ----------
function show(id, on) { $(id).hidden = !on; }
function setState(s) {
  const prevState = state;
  state = s;
  if (s === 'over') overAt = performance.now();
  if (s === 'paused' && prevState === 'playing') sfx.pause();
  if (s === 'playing' && prevState === 'paused') sfx.resume();
  setMood(s === 'menu' || s === 'select' ? 'menu' : s === 'paused' ? 'paused' : s === 'over' || s === 'dying' ? 'over' : game && game.fever > 0 ? 'fever' : 'play', game ? game.level : 1);
  const pb = $('btnPlay');
  const pausing = s === 'playing' || s === 'ready';
  pb.dataset.mode = pausing ? 'pause' : 'play';
  pb.setAttribute('aria-label', pausing ? 'Pause' : s === 'paused' ? 'Resume' : s === 'over' ? 'Play again' : 'Play');
  if (s === 'paused' && game) $('pScore').textContent = game.score.toLocaleString();
  show('ovMenu', s === 'menu'); show('ovPause', s === 'paused'); show('ovOver', s === 'over'); show('ovLevels', s === 'select');
  show('count', s === 'ready');
  online?.setStatus(s === 'playing' || s === 'ready' || s === 'paused' ? 'playing' : 'menu', s === 'menu' ? null : mode);
}

function start(m, quick = false, level = curLevel, opts = {}) {
  unlockAudio();
  if (m === 'levels' && plusLocked(level)) { openPlus(`Level ${level} is part of Plus`); return; }
  mode = m; selMode = m;
  challenge = opts.challenge || null;
  const seed = opts.seed != null ? opts.seed : m === 'daily' ? hashStr('daily:' + dayKey()) : (Math.random() * 2 ** 32) >>> 0;
  if (m === 'levels') { curLevel = selLevel = level; game = new Game(m, seed, LEVELS[level - 1]); }
  else game = new Game(m, seed);
  levelResult = null;
  acc = 0; runTime = 0; readyT = 0; readyDur = quick ? 520 : 1050; runMissions = []; xpBefore = profile.xp;
  renderer.parts = []; renderer.floats = [];
  $('count').replaceChildren();
  setState('ready');
}

function runStats(final) {
  return {
    score: game.score, maxCombo: game.stats.maxCombo, goldens: game.stats.goldens, seconds: Math.floor(runTime),
    powers: game.stats.powers, maxLevel: game.stats.maxLevel, ghostPasses: game.stats.ghostPasses,
    length: game.snake.length, berries: game.stats.berries, fevers: game.stats.fevers, closeCalls: game.stats.closeCalls,
    runs: final ? 1 : 0, dailyRuns: final && mode === 'daily' ? 1 : 0,
  };
}

function liveMissions() {
  if (!missionMode(mode)) return;
  for (const m of P.checkLive(profile, missions, runStats(false))) missionDone(m);
}
function missionDone(m) {
  runMissions.push(m);
  sfx.mission();
  toast(`Mission complete · ${m.text} · +${m.xp} XP`, 'mint');
  renderMissions(); renderPlayer();
}

function endRun() {
  const s = runStats(true);
  if (missionMode(mode)) for (const m of P.commitRun(profile, missions, s)) { runMissions.push(m); }
  const scoreXp = Math.floor(game.score / (mode === 'zen' ? 10 : 4));
  profile.xp += scoreXp;
  const streakXp = P.touchStreak(profile, dayKey(), yesterdayKey());
  profile.xp += streakXp;
  runStreakXp = streakXp;
  profile.games++; profile.eaten += s.berries;
  let newBest = false;
  if (mode === 'daily') {
    if (profile.dailyDay !== dayKey()) { profile.dailyDay = dayKey(); profile.dailyBest = 0; }
    if (game.score > profile.dailyBest) { newBest = profile.dailyBest > 0 || game.score > 0; profile.dailyBest = game.score; }
  }
  if (mode === 'levels') {
    const L = LEVELS[curLevel - 1], lv = profile.levels, n = String(curLevel);
    const stars = starsFor(L, game.score, game.won), prevStars = lv.stars[n] || 0, prevBestL = lv.best[n] || 0;
    const firstClear = game.won && prevStars === 0;
    let bonus = 0;
    if (firstClear) bonus += 30 + curLevel * 10;
    if (stars > prevStars) { bonus += (stars - prevStars) * 15; lv.stars[n] = stars; }
    if (game.score > prevBestL) { lv.best[n] = game.score; newBest = prevBestL > 0; }
    const unlockedNext = game.won && curLevel < 15 && lv.unlocked <= curLevel;
    if (unlockedNext) lv.unlocked = curLevel + 1;
    profile.xp += bonus;
    levelResult = { stars, bonus, firstClear, unlockedNext, won: game.won };
  } else {
    const prevBest = profile.best[mode] || 0;
    if (game.score > prevBest) { profile.best[mode] = game.score; if (mode !== 'daily') newBest = prevBest > 0; }
  }
  P.saveLocal(profile);
  online?.saveProfile(profile);
  const rankNow = P.levelInfo(profile.xp).level;
  if (ranked(mode)) {
    const res = online?.submit(mode, game.score, rankNow, profile.skin, Math.floor(runTime));
    online?.announce(mode, game.score);
    if (res && res.then) res.then(r => { if (r && r.place && r.place <= 10) toast(`You're #${r.place} on the ${mode === 'daily' ? "today's" : 'all-time'} board!`, 'gold'); });
  }
  if (challenge && online?.challenges) {
    const ch = challenge;
    online.challenges.result(ch.id, game.score, Math.round(runTime * 10) / 10, ch.reach)
      .then(doc => { ch.doc = doc; if (challenge === ch) $('rChallenge').textContent = challengeStanding(doc); refreshChallenges(); })
      .catch(e => { if (challenge === ch) $('rChallenge').textContent = e.message || 'Could not send your result.'; });
  }
  if (mode === 'levels' && online?.submitLevels) {
    const lv = profile.levels;
    online.submitLevels({
      stars: Object.values(lv.stars).reduce((a, b) => a + b, 0), cleared: Object.values(lv.stars).filter(v => v > 0).length,
      rank: rankNow, skin: profile.skin, level: curLevel, won: game.won, levelStars: levelResult.stars,
    });
  }
  fillResults(s, newBest, profile.xp - xpBefore);
  renderAll();
  setState('over');
}

const CAUSES = { wall: 'You hit the wall.', self: 'You bit your own tail.', rock: 'You crashed into a rock.' };
function fillResults(s, newBest, xpGain) {
  const lvl = mode === 'levels' ? LEVELS[curLevel - 1] : null;
  $('rMode').textContent = challenge ? `Challenge · ${challenge.target.toLocaleString()} vs ${challenge.opp}`
    : lvl ? `Level ${curLevel} · ${lvl.name}` : MODES[mode].name + (mode === 'daily' ? ` · ${dayKey()}` : '');
  $('rChallenge').hidden = !challenge;
  if (challenge) $('rChallenge').textContent = 'Sending your result…';
  $('rScore').textContent = game.score.toLocaleString();
  $('rCause').textContent = challenge ? (challenge.reach != null ? `You hit ${challenge.target.toLocaleString()} in ${challenge.reach.toFixed(1)}s!` : `${game.score.toLocaleString()} of ${challenge.target.toLocaleString()}. ${CAUSES[game.cause] || ''}`)
    : lvl && game.won ? 'Level cleared!' : lvl ? `${CAUSES[game.cause] || ''} ${game.eaten} of ${lvl.target} berries eaten.` : CAUSES[game.cause] || '';
  const starsEl = $('rStars');
  starsEl.hidden = !lvl;
  if (lvl) [...starsEl.children].forEach((sp, i) => { sp.classList.toggle('on', i < levelResult.stars); });
  if (lvl && levelResult.stars) for (let i = 0; i < levelResult.stars; i++) setTimeout(() => sfx.star(i), 250 + i * 180);
  $('btnLevels').hidden = !lvl;
  $('btnAgain').firstChild.textContent = challenge ? 'Try again ' : lvl ? (game.won && curLevel < 15 ? (plusLocked(curLevel + 1) ? `Unlock level ${curLevel + 1} ` : 'Next level ') : 'Retry ') : 'Play again ';
  $('shareText').hidden = true; $('btnShare').hidden = mode === 'zen';
  $('rBest').hidden = !newBest;
  $('rLen').textContent = s.length; $('rCombo').textContent = '×' + s.maxCombo;
  $('rTime').textContent = fmtTime(s.seconds); $('rGold').textContent = s.goldens;
  const before = P.levelInfo(xpBefore), after = P.levelInfo(profile.xp);
  $('rXp').textContent = `+${xpGain} XP`;
  $('rLvl').textContent = after.level > before.level ? `Rank up! Rank ${after.level}` : `Rank ${after.level}`;
  const bar = $('rXpBar');
  bar.style.transition = 'none'; bar.style.width = (after.level > before.level ? 0 : (before.into / before.need) * 100) + '%';
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = ''; bar.style.width = (after.into / after.need) * 100 + '%'; }));
  const list = $('rMissions'); list.replaceChildren();
  for (const m of runMissions) { const li = el('li'); li.append(el('span', null, '✓ ' + m.text), el('b', null, `+${m.xp}`)); list.append(li); }
  if (levelResult && levelResult.bonus) { const li = el('li'); li.append(el('span', null, levelResult.firstClear ? `First clear of level ${curLevel}` : 'New stars'), el('b', null, `+${levelResult.bonus}`)); list.append(li); }
  if (levelResult && levelResult.unlockedNext) { const li = el('li'); li.append(el('span', null, `Level ${curLevel + 1} unlocked: ${LEVELS[curLevel].name}`), el('b', null, '→')); list.append(li); }
  if (levelResult && levelResult.won && curLevel === 15) { const li = el('li'); li.append(el('span', null, 'You beat all 15 levels!'), el('b', null, '★')); list.append(li); }
  if (runStreakXp) { const li = el('li'); li.append(el('span', null, `Day ${profile.streak} streak bonus`), el('b', null, `+${runStreakXp}`)); list.append(li); }
  const unlocked = SKINS.filter(k => k.unlock > before.level && k.unlock <= after.level);
  for (const k of unlocked) { const li = el('li'); li.append(el('span', null, `New skin unlocked: ${k.name}`), el('b', null, '★')); list.append(li); }
  $('rGuest').hidden = !(online?.auth && !online.auth.user && mode !== 'zen');
  $('coachText').textContent = '';
  $('btnCoach').hidden = false; $('btnCoach').disabled = false;
}

// ---------- events from the engine ----------
function handle(events) {
  const sk = skin(), t = performance.now();
  for (const e of events) {
    switch (e.type) {
      case 'eat':
        sfx.eat(e.mult); renderer.gulp = 1; haptic(8);
        renderer.burst(e.x, e.y, '#ff7a8c', 10 + e.mult * 2);
        renderer.float(e.x, e.y, `+${e.pts}`, e.mult > 1 ? '#ffc94a' : '#ffffff');
        bumpCombo();
        break;
      case 'golden':
        sfx.golden(); renderer.gulp = 1;
        renderer.burst(e.x, e.y, '#ffc94a', 26, 1.4);
        renderer.float(e.x, e.y, `+${e.pts}`, '#ffc94a');
        break;
      case 'goldenSpawn': sfx.goldenSpawn(); toast('A golden plum appeared. Grab it before it fades!', 'gold'); break;
      case 'powerSpawn': sfx.powerSpawn(); break;
      case 'fxEnd': sfx.fxEnd(); break;
      case 'rockLand': sfx.rockLand(); renderer.shake = Math.max(renderer.shake, 0.15); break;
      case 'power': {
        const info = POWER_INFO[e.kind];
        sfx.power(); renderer.burst(e.x, e.y, info.color, 22, 1.3); haptic(20);
        toast(`${info.name}: ${info.desc}`, 'mint');
        break;
      }
      case 'level': sfx.level(); toast(`Speed ${e.level}`); setMood(game.fever > 0 ? 'fever' : 'play', e.level); break;
      case 'fever':
        sfx.fever(); setMood('fever', game.level); haptic([20, 40, 20]); renderer.flash = 0.25;
        toast('FEVER! Double points while it lasts', 'gold');
        break;
      case 'feverEnd': sfx.feverEnd(); setMood('play', game.level); toast('Fever over. Build it again!'); break;
      case 'close':
        sfx.close(); renderer.float(e.x, e.y, 'Close call +5', '#7af0cf');
        break;
      case 'grace': sfx.grace(); haptic(15); renderer.shake = 0.25; break;
      case 'rock': sfx.rock(); break;
      case 'comboLost': sfx.lost(); break;
      case 'phase': sfx.phase(); renderer.burst(e.x, e.y, '#7af0cf', 4, 0.6); break;
      case 'portal':
        sfx.portal(); haptic(10);
        renderer.burst(e.x, e.y, '#c6a2ff', 10, 0.8); renderer.burst(e.tx, e.ty, '#6cb8ff', 10, 0.8);
        break;
      case 'clear':
        sfx.clear(); haptic([30, 50, 30]); renderer.flash = 0;
        game.snake.forEach((c, i) => { if (i % 2 === 0) renderer.burst(c.x, c.y, i % 4 ? '#ffc94a' : '#7af0cf', 6, 1.4); });
        toast(`Level ${curLevel} cleared!`, 'gold');
        dyingT = 0; state = 'dying';
        break;
      case 'die':
        sfx.die(); renderer.explode(game.snake, sk, t); haptic(90);
        dyingT = 0; state = 'dying';
        break;
    }
  }
}
function bumpCombo() { const c = $('hCombo'); c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); }

// ---------- loop ----------
// One bad frame must never stop the loop: catch, report, pause the run, keep drawing.
let frameErrors = 0;
function frame(now) {
  try { tick(now); frameErrors = 0; }
  catch (e) {
    reportError(e, 'frame');
    if (++frameErrors > 3 && state !== 'menu') { game = null; setState('menu'); renderBests(); toast('Something went wrong, so the run was ended. Your progress is saved.'); frameErrors = 0; }
    else if (state === 'playing') { setState('paused'); toast('Something went wrong. Press play to keep going.'); }
  }
  requestAnimationFrame(frame);
}
function tick(now) {
  const dt = Math.min(100, now - last); last = now;
  let g = demo, alpha = 0;
  if (state === 'menu' || state === 'select') {
    acc += dt;
    while (acc >= demo.interval()) { acc -= demo.interval(); autopilot(demo); demo.step(); if (!demo.alive) { demo = new Game('demo', (Math.random() * 2 ** 32) >>> 0); acc = 0; } }
    alpha = acc / demo.interval();
  } else if (game) {
    g = game;
    if (state === 'ready') {
      const step = readyDur > 600 ? 350 : readyDur;
      const before = Math.ceil((readyDur - readyT) / step);
      readyT += dt;
      const n = Math.ceil((readyDur - readyT) / step);
      if (n !== before || !$('count').firstChild) {
        if (n > 0) { $('count').replaceChildren(el('span', null, readyDur > 600 ? String(n) : 'Go!')); sfx.tick(); }
      }
      if (readyT >= readyDur) { sfx.go(); acc = 0; setState('playing'); }
    } else if (state === 'playing') {
      runTime += dt / 1000; acc += dt;
      let iv = game.interval();
      while (acc >= iv && state === 'playing') { acc -= iv; handle(game.step()); iv = game.interval(); }
      if (state === 'playing' && challenge && challenge.reach == null && game.score >= challenge.target) challengeHit();
      if (state === 'playing') liveMissions();
      alpha = state === 'playing' ? Math.min(1, acc / iv) : 1;
    } else if (state === 'dying') {
      dyingT += dt; alpha = 1;
      if (dyingT > (game.won ? 1300 : 950)) endRun();
    } else alpha = state === 'paused' ? Math.min(1, acc / game.interval()) : 1;
  }
  renderer.draw(g, alpha, skin(), now, dt, { hideSnake: game && g === game && !game.alive && !game.won });
  updateHud();
}

// ---------- crash reporting ----------
let reported = 0;
function reportError(e, where) {
  console.error(e);
  if (reported >= 5 || !online || online.kind !== 'netlify') return;
  reported++;
  fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    message: String(e && e.message || e), stack: String(e && e.stack || ''), where, state, mode,
  }) }).catch(() => {});
}
addEventListener('error', ev => reportError(ev.error || ev.message, 'window'));
addEventListener('unhandledrejection', ev => reportError(ev.reason, 'promise'));

// ---------- HUD ----------
const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function updateHud() {
  const live = state !== 'menu' && state !== 'select' && game;
  setText('hScore', live ? game.score.toLocaleString() : '0');
  const lvMode = live && mode === 'levels', chMode = live && challenge;
  setText('hSpeedLabel', chMode ? 'Target' : lvMode ? `Level ${curLevel}` : 'Speed');
  setText('hSpeed', chMode ? `${Math.min(game.score, challenge.target).toLocaleString()}/${challenge.target.toLocaleString()}` : lvMode ? `${game.eaten}/${game.target}` : live ? String(game.level) : '1');
  const bm = live ? mode : selMode;
  setText('hBest', (bm === 'levels' ? profile.levels.best[String(live ? curLevel : selLevel)] || 0 : bm === 'daily' ? dailyBest() : profile.best[bm] || 0).toLocaleString());
  const mult = live ? game.mult : 1;
  setText('hMult', '×' + mult);
  const p = live ? Math.max(0, 1 - game.comboT / game.comboWin) : 0;
  $('hRing').style.setProperty('--p', p.toFixed(3));
  $('hCombo').dataset.hot = String(mult >= 3);
  // power-up chips
  const chips = live ? Object.entries(game.fx).filter(([, v]) => v > 0) : [];
  const key = chips.map(([k]) => k).join();
  const box = $('fxChips');
  if (box.dataset.key !== key) {
    box.dataset.key = key; box.replaceChildren();
    for (const [k] of chips) { const c = el('span', 'chip', POWER_INFO[k].name); c.dataset.k = k; c.style.setProperty('--c', POWER_INFO[k].color); box.append(c); }
  }
  for (const c of box.children) { const k = c.dataset.k; c.style.setProperty('--p', (game.fx[k] / (k === 'slow' ? 32 : 45)).toFixed(3)); }
}

// ---------- toasts ----------
function toast(text, kind = '') {
  const box = $('toasts');
  const t = el('div', 'toast ' + kind, text);
  box.prepend(t);
  while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2600);
}

// ---------- side panels ----------
function renderPlayer() {
  const li = P.levelInfo(profile.xp);
  const live = profile.lastDay === dayKey() || profile.lastDay === yesterdayKey();
  $('streak').hidden = !(live && profile.streak > 0);
  $('streakN').textContent = profile.streak;
  $('streak').title = `${profile.streak} day streak. Play every day to keep it.`;
  $('pLevel').textContent = 'Rank ' + li.level;
  $('pXp').style.width = (li.into / li.need) * 100 + '%';
  $('pXp').parentElement.title = `${li.into} / ${li.need} XP to rank ${li.level + 1}`;
}
function renderMissions() {
  const list = $('missionList'); list.replaceChildren();
  const run = (state === 'playing' || state === 'dying') && game && missionMode(mode) ? runStats(false) : null;
  for (const m of missions) {
    const done = !!profile.mission.done[m.id], v = done ? m.target : P.missionValue(profile, m, run);
    const li = el('li', done ? 'done' : '');
    const bar = el('div', 'bar'), track = el('span'), fill = el('i');
    fill.style.width = (v / m.target) * 100 + '%'; track.append(fill);
    bar.append(track, el('small', null, `${v} / ${m.target}`));
    li.append(el('span', 'check', done ? '✓' : ''), el('span', 'mtext', m.text), el('span', 'reward', `+${m.xp} XP`), bar);
    list.append(li);
  }
  $('sGames').textContent = profile.games.toLocaleString();
  $('sEaten').textContent = profile.eaten.toLocaleString();
  $('sBest').textContent = profile.best.endless.toLocaleString();
}
function renderReset() {
  const ms = msUntilReset(), h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  $('resetIn').textContent = `Resets in ${h}h ${m}m`;
  if (profile.mission.day !== dayKey() && state !== 'playing') { missions = P.ensureDay(profile); renderMissions(); }
}
function renderSkins() {
  const lvl = P.levelInfo(profile.xp).level, grid = $('skinGrid'); grid.replaceChildren();
  const equipped = skin().id;
  for (const k of SKINS) {
    if (k.plus && !paywallOn()) continue;                  // Plus skins only exist where Plus can be bought
    const lockedPlus = k.plus && !isPlus();
    const b = el('button', 'skin' + (k.id === equipped ? ' on' : '') + (k.plus ? ' plus-skin' : ''));
    const sw = el('span', 'sw');
    sw.style.background = `linear-gradient(90deg, ${k.stops.join(', ')})`;
    const note = lockedPlus ? 'Plus exclusive' : lvl >= k.unlock ? (k.id === equipped ? 'Equipped' : 'Tap to equip') : `Unlocks at Rank ${k.unlock}`;
    b.append(sw, el('span', null, k.name), el('small', null, note));
    b.dataset.locked = String(lockedPlus);
    b.disabled = !k.plus && lvl < k.unlock;
    b.setAttribute('aria-pressed', String(k.id === equipped));
    b.onclick = () => {
      if (lockedPlus) { openPlus(`${k.name} is a Plus skin`); return; }
      profile.skin = k.id; P.saveLocal(profile); online?.saveProfile(profile); sfx.click(); renderSkins();
    };
    grid.append(b);
  }
  const next = SKINS.find(k => !k.plus && k.unlock > lvl);
  $('skinNext').textContent = next ? `Next: ${next.name} at Rank ${next.unlock}` : 'All skins unlocked';
}
function renderBests() {
  document.querySelectorAll('[data-best]').forEach(i => {
    const m = i.dataset.best;
    i.textContent = m === 'levels' ? `${Object.values(profile.levels.stars).filter(v => v > 0).length}/15`
      : (m === 'daily' ? dailyBest() : profile.best[m] || 0).toLocaleString();
  });
  document.querySelectorAll('.mode').forEach(b => b.classList.toggle('sel', b.dataset.mode === selMode));
  $('selName').textContent = MODES[selMode].name;
}
function renderAll() { renderPlayer(); renderMissions(); renderSkins(); renderBests(); renderBoard(); }

// leaderboard
const boards = { daily: { state: 'idle', rows: [] }, all: { state: 'idle', rows: [] }, levels: { state: 'idle', rows: [] } };
let boardTab = 'daily', boardRender = 0;
async function renderBoard() {
  const token = ++boardRender;
  const list = $('leaderList'), note = $('leaderNote'), b = boards[boardTab];
  if (!online || !online.hasBoard) {
    list.replaceChildren(el('li', 'empty', !onlineChecked
      ? 'Connecting to the leaderboard…'
      : window.claude ? 'The shared leaderboard needs you signed in to claude.ai. Your scores are still saved on this device.'
        : 'The leaderboard is offline right now. Your scores are still saved on this device.'));
    note.textContent = '';
    return;
  }
  if (b.state === 'loading' || b.state === 'idle') { list.replaceChildren(el('li', 'empty', 'Loading scores…')); return; }
  if (b.state === 'error') { list.replaceChildren(el('li', 'empty', 'Scores could not be loaded. Reload the page to try again.')); return; }
  if (!b.rows || !b.rows.length) {
    list.replaceChildren(el('li', 'empty', boardTab === 'daily' ? 'No Daily Run scores yet today. Finish one to take #1.' : boardTab === 'levels' ? 'Nobody has cleared a level yet. Be the first.' : 'No Endless scores yet. Finish a run to take #1.'));
  } else {
    const ps = await online.profiles(b.rows.map(r => r.id));
    if (token !== boardRender) return;
    list.replaceChildren(...b.rows.map((r, i) => {
      const p = ps[r.id] || {}, me = r.id === online.uid;
      const li = el('li', me ? 'me' : '');
      const img = el('img'); img.alt = ''; if (p.avatarUrl) img.src = p.avatarUrl;
      const who = el('span', 'who', p.name || (me ? 'You' : 'Player'));
      if (r.plus) who.append(el('span', 'plus-tag', 'PLUS'));
      if (me) who.append(el('small', null, 'you'));
      const pts = el('span', 'pts', boardTab === 'levels' ? `★ ${r.score}` : r.score.toLocaleString());
      if (boardTab === 'levels') pts.append(el('small', null, `${r.cleared}/15`));
      const rankCell = el('span', 'rank');
      if (i === 0) { li.classList.add('champ'); const c = el('span', 'crown-ic'); c.innerHTML = CROWN_SVG; c.title = '#1'; rankCell.append(c); rankCell.setAttribute('aria-label', 'Number 1'); }
      else rankCell.textContent = String(i + 1);
      li.append(rankCell, img, who, pts);
      const pname = p.name || r.name;
      if (online.player && pname) {
        li.classList.add('clickable'); li.tabIndex = 0;
        li.onclick = () => openPlayer(pname);
        li.onkeydown = e => { if (e.key === 'Enter') openPlayer(pname); };
      }
      return li;
    }));
  }
  const mine = online.myBest(boardTab);
  note.textContent = b.state === 'slow' ? 'Still waiting for the scoreboard. It may be out of date.'
    : boardTab === 'levels' ? `Most level stars collected (out of 45). ${mine ? 'You have ' + mine + '.' : ''}`
    : boardTab === 'daily' ? `Everyone plays the same seed today. ${mine ? 'Your best today: ' + mine.toLocaleString() + '.' : ''}`
      : `Best Endless runs of all time. ${mine ? 'Your best: ' + mine.toLocaleString() + '.' : ''}`;
  if (online.auth && !online.auth.user) note.textContent += ' Sign in to post your own scores.';
}

// ---------- level select ----------
const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
function openLevels() {
  selLevel = Math.min(Math.max(1, curLevel), profile.levels.unlocked, plusLocked(FREE_LEVELS + 1) ? FREE_LEVELS : 15);
  renderLevels(); setState('select');
}
function renderLevels() {
  const lv = profile.levels, grid = $('levelGrid');
  grid.replaceChildren(...LEVELS.map(L => {
    const n = L.n, pl = plusLocked(n), locked = !pl && n > lv.unlocked, stars = lv.stars[String(n)] || 0;
    const b = el('button', 'lvl-tile' + (n === selLevel ? ' sel' : '') + (stars ? ' done' : '') + (pl ? ' plus-lock' : ''));
    b.disabled = locked;
    b.setAttribute('aria-label', pl ? `Level ${n}, part of Coil Rush Plus` : locked ? `Level ${n}, locked` : `Level ${n}, ${L.name}, ${stars} stars`);
    if (pl) { b.append(String(n)); b.append(el('span', 'plus-tag', 'PLUS')); b.onclick = () => openPlus(`Level ${n} is part of Plus`); return b; }
    if (locked) b.innerHTML = LOCK;
    else {
      b.append(String(n));
      const st = el('small');
      for (let i = 0; i < 3; i++) { const s = el(i < stars ? 'span' : 'i', null, '★'); st.append(s); }
      b.append(st);
    }
    b.onclick = () => { if (selLevel === n) start('levels', false, n); else { selLevel = n; sfx.click(); renderLevels(); } };
    return b;
  }));
  const L = LEVELS[selLevel - 1], best = lv.best[String(selLevel)] || 0;
  $('liName').textContent = `${selLevel} · ${L.name}`;
  $('liHint').textContent = L.hint;
  $('liMeta').textContent = `Eat ${L.target} · ★★ ${L.target * 20} · ★★★ ${L.target * 35}${best ? ' · Best ' + best.toLocaleString() : ''}`;
  $('btnLevelGo').firstChild.textContent = `Play level ${selLevel} `;
  const total = Object.values(lv.stars).reduce((a, b) => a + b, 0);
  $('starTotal').textContent = `${total} / 45 ★`;
}
function moveLevel(d) {
  const delta = { left: -1, right: 1, up: -5, down: 5 }[d];
  const max = Math.min(profile.levels.unlocked, plusLocked(FREE_LEVELS + 1) ? FREE_LEVELS : 15);
  const n = Math.max(1, Math.min(max, selLevel + delta));
  if (n !== selLevel) { selLevel = n; sfx.click(); renderLevels(); }
}
$('btnLevelGo').onclick = () => start('levels', false, selLevel);
$('btnLevelsBack').onclick = () => { setState('menu'); renderBests(); };
$('btnLevels').onclick = () => openLevels();

function again() {
  if (challenge) {
    const doc = challenge.doc;
    if (doc && doc.status === 'active') { startChallenge(doc, true); return; }
    challenge = null; start('endless', true); return;
  }
  if (mode === 'levels') {
    const next = game && game.won && curLevel < 15 ? curLevel + 1 : curLevel;
    if (plusLocked(next)) { openPlus(`Level ${next} is part of Plus`); return; }
    start('levels', true, next);
  }
  else start(mode, true);
}

// ---------- input ----------
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
function steer(d) {
  if (state === 'over' && performance.now() - overAt > 650) { again(); game.enqueue(d); return; }
  if (state === 'select') { moveLevel(d); return; }
  if (state === 'playing' || state === 'ready') game.enqueue(d);
  else if (state === 'menu') {
    const order = ['endless', 'daily', 'levels', 'zen'];
    if (d === 'left' || d === 'up') selMode = order[(order.indexOf(selMode) + 3) % 4];
    else selMode = order[(order.indexOf(selMode) + 1) % 4];
    sfx.click(); renderBests();
  }
}
function primary() {
  if (state === 'menu') { if (selMode === 'levels') openLevels(); else start(selMode); }
  else if (state === 'select') start('levels', false, selLevel);
  else if (state === 'playing') { setState('paused'); sfx.click(); }
  else if (state === 'paused') setState('playing');
  else if (state === 'over') again();
}
function turn(side) {
  if (state === 'playing' || state === 'ready') game.turn(side);
  else steer(side);
}
function back() {
  if (state === 'playing') setState('paused');
  else if (state === 'paused' || state === 'over' || state === 'select') {
    if (mode === 'levels' && state !== 'select') openLevels(); else { setState('menu'); renderBests(); }
  }
}
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches && e.target.matches('input:not([type="range"]), textarea')) return;
  if (openModal) { if (e.code === 'Escape') closeModal(); return; }
  if (e.target.closest && e.target.closest('button') && (e.code === 'Enter' || e.code === 'Space') && state !== 'playing') return;
  if (e.target.matches && e.target.matches('input[type="range"]')) return;
  unlockAudio();
  const d = KEYS[e.code];
  if (d) { e.preventDefault(); steer(d); return; }
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); if (state === 'playing') return; primary(); }
  else if (e.code === 'Space' || e.code === 'KeyP') { e.preventDefault(); primary(); }
  else if (e.code === 'Escape') { e.preventDefault(); back(); }
  else if (e.code === 'KeyM') toggleSound();
  else if (e.code === 'KeyN') toggleMusic();
});

// swipe on the board
let sw = null;
const wrap = $('boardWrap');
wrap.addEventListener('pointerdown', e => {
  if (e.target.closest('.overlay')) return;
  sw = { x: e.clientX, y: e.clientY };
});
wrap.addEventListener('pointermove', e => {
  if (!sw) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
  steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  sw = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => { sw = null; });
addEventListener('pointercancel', () => { sw = null; });
// ---------- on-screen controls ----------
const press = b => { b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 110); };
document.querySelectorAll('.ctl-dpad button').forEach(b => b.addEventListener('pointerdown', e => {
  e.preventDefault(); unlockAudio(); press(b); haptic(6); steer(b.dataset.dir);
}));
document.querySelectorAll('.ctl-turn button').forEach(b => b.addEventListener('pointerdown', e => {
  e.preventDefault(); unlockAudio(); press(b); haptic(6); turn(b.dataset.turn);
}));
// Floating joystick: the touch point becomes the centre, direction follows the drag.
const stickZone = $('stickZone'), stickBase = $('stickBase'), knob = $('stickKnob');
let stick = null;
function moveStick(e) {
  const dx = e.clientX - stick.x, dy = e.clientY - stick.y, len = Math.hypot(dx, dy);
  const R = stickBase.offsetWidth * 0.32, k = len > R ? R / len : 1;
  knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  if (len < 16) return;
  if (len > R * 1.6) { stick.x = e.clientX - (dx / len) * R; stick.y = e.clientY - (dy / len) * R; } // origin follows a long drag
  const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  if (d !== stick.dir) { stick.dir = d; stickBase.dataset.dir = d; haptic(6); steer(d); }
}
stickZone.addEventListener('pointerdown', e => {
  e.preventDefault(); unlockAudio();
  try { stickZone.setPointerCapture(e.pointerId); } catch (_) {}
  stick = { id: e.pointerId, x: e.clientX, y: e.clientY, dir: null };
  stickZone.classList.add('active');
});
stickZone.addEventListener('pointermove', e => { if (stick && e.pointerId === stick.id) moveStick(e); });
const endStick = e => {
  if (!stick || e.pointerId !== stick.id) return;
  stick = null; stickZone.classList.remove('active'); knob.style.transform = ''; stickBase.dataset.dir = '';
};
stickZone.addEventListener('pointerup', endStick);
stickZone.addEventListener('pointercancel', endStick);

function applyControls() {
  document.querySelectorAll('.ctl-pick button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.ctl === profile.controls)));
  document.querySelectorAll('.ctl').forEach(c => { c.hidden = c.dataset.for !== profile.controls; });
}
document.querySelectorAll('.ctl-pick button').forEach(b => b.addEventListener('click', () => {
  profile.controls = b.dataset.ctl; applyControls(); sfx.click();
  P.saveLocal(profile); online?.saveProfile(profile);
}));
applyControls();

document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => { if (b.dataset.mode === 'levels') { selMode = 'levels'; openLevels(); } else start(b.dataset.mode); }));
$('btnResume').onclick = () => setState('playing');
$('btnQuit').onclick = () => { if (mode === 'levels') openLevels(); else { setState('menu'); renderBests(); } };
$('btnAgain').onclick = () => again();
$('btnMenu').onclick = () => { setState('menu'); renderBests(); };

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  for (const t of ['missions', 'leaders', 'challenges', 'skins', 'live']) $('tab-' + t).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === 'challenges') refreshChallenges();
  try { localStorage.setItem('coilrush.tab', b.dataset.tab); } catch (e) {}
});
function pickBoard(which) {
  boardTab = which;
  for (const [id, w] of [['lbDaily', 'daily'], ['lbAll', 'all'], ['lbLevels', 'levels']]) $(id).setAttribute('aria-pressed', String(w === which));
  renderBoard();
}
$('lbDaily').onclick = () => pickBoard('daily');
$('lbAll').onclick = () => pickBoard('all');
$('lbLevels').onclick = () => pickBoard('levels');

function toggleSound() {
  profile.sound = !profile.sound; setSound(profile.sound);
  $('soundBtn').setAttribute('aria-pressed', String(!profile.sound));
  $('soundBtn').setAttribute('aria-label', profile.sound ? 'Turn sound effects off' : 'Turn sound effects on');
  P.saveLocal(profile);
  if (profile.sound) { unlockAudio(); sfx.click(); }
}
$('soundBtn').onclick = toggleSound;
function toggleMusic() {
  profile.music = !profile.music;
  unlockAudio(); setMusic(profile.music);
  $('musicBtn').setAttribute('aria-pressed', String(!profile.music));
  $('musicBtn').setAttribute('aria-label', profile.music ? 'Turn music off' : 'Turn music on');
  P.saveLocal(profile); online?.saveProfile(profile);
  toast(profile.music ? 'Music on' : 'Music off');
}
$('musicBtn').onclick = toggleMusic;

// sound settings popover
const panel = $('audioPanel'), audioBtn = $('audioBtn');
function setPanel(open) { panel.hidden = !open; audioBtn.setAttribute('aria-expanded', String(open)); }
audioBtn.onclick = e => { e.stopPropagation(); unlockAudio(); setPanel(panel.hidden); };
document.addEventListener('pointerdown', e => { if (!panel.hidden && !e.target.closest('.audio-wrap')) setPanel(false); });
addEventListener('keydown', e => { if (e.code === 'Escape' && !panel.hidden) { setPanel(false); e.stopImmediatePropagation(); } }, true);
function syncVolumeUI() {
  $('musicVol').value = profile.musicVol; $('musicVolOut').textContent = profile.musicVol;
  $('sfxVol').value = profile.sfxVol; $('sfxVolOut').textContent = profile.sfxVol;
}
let volSave = null;
function onVolume() {
  profile.musicVol = +$('musicVol').value; profile.sfxVol = +$('sfxVol').value;
  $('musicVolOut').textContent = profile.musicVol; $('sfxVolOut').textContent = profile.sfxVol;
  setVolumes(profile.musicVol / 100, profile.sfxVol / 100);
  clearTimeout(volSave); volSave = setTimeout(() => { P.saveLocal(profile); online?.saveProfile(profile); }, 600);
}
$('musicVol').addEventListener('input', () => { unlockAudio(); if (!profile.music && +$('musicVol').value > 0) toggleMusic(); onVolume(); });
$('sfxVol').addEventListener('input', () => { unlockAudio(); if (!profile.sound && +$('sfxVol').value > 0) toggleSound(); onVolume(); });
$('sfxVol').addEventListener('change', () => sfx.eat(3));
syncVolumeUI();
$('musicBtn').setAttribute('aria-pressed', String(!profile.music));
$('btnPlay').addEventListener('click', () => {
  unlockAudio();
  if (state === 'ready') { setState('menu'); renderBests(); return; }
  if (state === 'dying') return;
  primary();
});
$('soundBtn').setAttribute('aria-pressed', String(!profile.sound));

const autoPause = () => { if (state === 'playing') setState('paused'); };
addEventListener('blur', autoPause);
document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); suspendAudio(document.hidden); });
// Browsers only allow audio after a gesture: start the music on the first touch or click anywhere.
addEventListener('pointerdown', () => unlockAudio(), { once: true });

// ---------- accounts, player cards, live feed (Netlify build) ----------
let openModal = null, acctMode = 'login';
function showModal(id) {
  if (state === 'playing') setState('paused');
  if (openModal && openModal !== id) $(openModal).hidden = true;
  openModal = id; $(id).hidden = false;
  if (id === 'chatModal') return;
  const first = $(id).querySelector('input, button:not(.sheet-x)'); if (first) setTimeout(() => first.focus(), 30);
}
function closeModal() { if (openModal) { $(openModal).hidden = true; openModal = null; } }
for (const id of ['acctModal', 'playerModal']) {
  $(id).addEventListener('pointerdown', e => { if (e.target === $(id)) closeModal(); });
}
$('acctClose').onclick = closeModal; $('pmClose').onclick = closeModal;

function setAcctMode(m) {
  acctMode = m;
  $('amLogin').setAttribute('aria-pressed', String(m === 'login'));
  $('amRegister').setAttribute('aria-pressed', String(m === 'register'));
  $('acctTitle').textContent = m === 'login' ? 'Welcome back' : 'Create your account';
  $('acctSub').textContent = m === 'login' ? 'Sign in to sync your progress across devices and post scores.' : 'Just a username and a password. Your current progress moves into the new account.';
  $('acctSubmit').textContent = m === 'login' ? 'Sign in' : 'Create account';
  $('acctPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('acctHelp').hidden = m === 'login';
  $('acctErr').textContent = '';
}
$('amLogin').onclick = () => setAcctMode('login');
$('amRegister').onclick = () => setAcctMode('register');

function renderAcct() {
  const a = online?.auth; if (!a) return;
  const u = a.user;
  $('acctBtn').hidden = false;
  $('acctBtn').classList.toggle('guest', !u);
  $('acctName').textContent = u ? u.name : 'Sign in';
  $('acctPlus').hidden = !(u && isPlus());
  $('acctCrown').hidden = !(u && isChampion(u.id));
  $('acctBtn').setAttribute('aria-label', u ? `Account: ${u.name}` : 'Sign in or create an account');
  $('acctAva').style.backgroundImage = u ? `url("${avatarFor(u.name)}")` : '';
  $('acctOut').hidden = !!u; $('acctIn').hidden = !u;
  if (u) {
    $('acctMe').textContent = u.name;
    const li = P.levelInfo(profile.xp), stars = Object.values(profile.levels.stars).reduce((x, y) => x + y, 0);
    const rows = [['Rank', li.level], ['Runs', profile.games], ['Endless best', profile.best.endless], ['Level stars', `${stars} / 45`]];
    $('acctStats').replaceChildren(...rows.map(([k, v]) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, typeof v === 'number' ? v.toLocaleString() : v)); return d; }));
  }
}
$('acctBtn').onclick = () => { renderAcct(); if (!online.auth.user) setAcctMode(acctMode); showModal('acctModal'); };
$('btnGuestSignIn').onclick = () => { setAcctMode('register'); renderAcct(); showModal('acctModal'); };
$('acctLogout').onclick = async () => { await online.auth.logout(); closeModal(); toast('Signed out. Progress stays on this device.'); };
$('acctProfile').onclick = () => { const u = online.auth.user; closeModal(); if (u) openPlayer(u.name); };
$('acctForm').addEventListener('submit', async e => {
  e.preventDefault();
  const user = $('acctUser').value.trim(), pass = $('acctPass').value, err = $('acctErr'), btn = $('acctSubmit');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(user)) { err.textContent = 'Usernames are 3–16 letters, numbers or underscores.'; $('acctUser').focus(); return; }
  if (pass.length < 6) { err.textContent = 'Passwords need at least 6 characters.'; $('acctPass').focus(); return; }
  err.textContent = ''; btn.disabled = true; btn.textContent = acctMode === 'login' ? 'Signing in…' : 'Creating account…';
  try {
    authKind = acctMode;
    const u = acctMode === 'login' ? await online.auth.login(user, pass) : await online.auth.register(user, pass);
    $('acctPass').value = '';
    closeModal();
    toast(acctMode === 'login' ? `Signed in as ${u.name}` : `Welcome, ${u.name}! Your progress is now saved.`, 'mint');
  } catch (ex) {
    err.textContent = ex.message || 'That did not work. Try again.';
  } finally {
    btn.disabled = false; btn.textContent = acctMode === 'login' ? 'Sign in' : 'Create account';
  }
});

// Swap the in-memory profile (sign-in / sign-out), keeping this device's sound and control settings.
function applyProfile(next) {
  for (const k of P.SETTINGS) next[k] = profile[k];
  profile = next; missions = P.ensureDay(profile);
  P.saveLocal(profile);
  renderAll(); renderAcct();
}
let authKind = null;   // 'login' | 'register', set just before the request
async function onAuthChange(user) {
  const kind = authKind; authKind = null;
  if (state === 'playing' || state === 'paused' || state === 'ready') { game = null; setState('menu'); }
  if (user) {
    const guest = profile;
    P.useKey(P.keyFor(user));
    const cached = P.loadLocal();                     // this account's copy on this device, if any
    const remote = await online.loadProfile();        // the account's copy on the server
    let next = remote && (remote.xp || 0) >= (cached.xp || 0) ? P.fromRemote(remote) : cached;
    if (kind === 'register' && !remote) {
      // A brand-new account takes over the guest's progress; the guest slot starts fresh.
      next = guest;
      const fresh = P.defaultProfile(); for (const k of P.SETTINGS) fresh[k] = guest[k];
      P.saveLocal(fresh, P.GUEST_KEY);
    }
    applyProfile(next);
    online.saveProfile(profile);
    await online.loadMine();
    if (online.pendingClaim && await online.redeemClaim()) {
      buyAfterLogin = false; sfx.clear();
      toast('Plus unlocked on your account: levels 6 to 15 and the exclusive skins are yours', 'gold');
    }
    renderPlusUI();
    if (online.push) { await online.push.adopt(); renderNotif(); }
    if (online.hasChat) { chatLastNotified = Date.now(); refreshInbox(); }
    if (acceptAfterLogin) { const id = acceptAfterLogin; acceptAfterLogin = null; chAct('accept', id, doc => { chInvite = null; startChallenge(doc); }); }
    else refreshChallenges();
    if (buyAfterLogin && !isPlus()) { buyAfterLogin = false; openPlus('Your account is ready'); }
  } else {
    P.useKey(P.GUEST_KEY);
    applyProfile(P.loadLocal());
    renderPlusUI();
    renderNotif(); chWaiting = 0; chatUnread = 0; $('chatBadge').hidden = true; setTitle();
  }
  renderBoard();
}

const PLAYER_FIELDS = [['Rank', 'rank'], ['Runs', 'runs'], ['Endless best', 'endless'], ['Daily best today', 'daily'], ['Level stars', 'stars'], ['Levels cleared', 'cleared'], ['Challenge wins', 'challengeWins']];
const CROWN_NAMES = { endless: '#1 All-time', daily: '#1 Today', levels: '#1 Levels' };
async function openPlayer(name) {
  if (!online?.player) return;
  $('pmName').textContent = name; $('pmSince').textContent = 'Loading…'; $('pmErr').textContent = '';
  $('pmStats').replaceChildren(); $('pmAvatar').src = avatarFor(name); $('pmCrowns').replaceChildren(); $('pmActions').hidden = true;
  showModal('playerModal');
  try {
    const p = await online.player(name);
    $('pmName').textContent = p.name;
    $('pmAvatar').src = avatarFor(p.name);
    $('pmSince').textContent = (p.plus ? 'Plus member · ' : '') + 'Playing since ' + new Date(p.joined).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    $('pmCrowns').replaceChildren(...(p.crowns || []).map(k => { const c = el('span', 'crown-chip'); c.innerHTML = CROWN_SVG; c.append(CROWN_NAMES[k] || '#1'); return c; }));
    const me = online.auth && online.auth.user;
    $('pmActions').hidden = !(online.hasChallenges && (!me || me.id !== p.id));
    $('pmChallenge').onclick = () => { closeModal(); openChallengeForm(p.name); };
    $('pmMessage').hidden = !online.hasChat;
    $('pmMessage').onclick = () => { closeModal(); openChat(p.name); };
    $('pmStats').replaceChildren(...PLAYER_FIELDS.map(([k, f]) => {
      const d = el('div'); d.append(el('dt', null, k), el('dd', null, f === 'stars' ? `${p.stars} / 45` : f === 'cleared' ? `${p.cleared} / 15` : Number(p[f] || 0).toLocaleString())); return d;
    }));
  } catch (e) {
    $('pmSince').textContent = ''; $('pmErr').textContent = e.message || 'Could not load that player.';
  }
}
$('findForm').addEventListener('submit', e => {
  e.preventDefault();
  const n = $('findName').value.trim();
  if (n) openPlayer(n);
});

const ago = t => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
async function renderFeed(data) {
  renderAcct();
  const o = online.online();
  $('lvOnline').textContent = o ? o.here : '–';
  $('lvPlaying').textContent = o ? o.playing : '–';
  $('lvPlayers').textContent = data.stats.players.toLocaleString();
  $('lvRunsToday').textContent = data.stats.runsToday.toLocaleString();
  $('liveUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const list = $('feedList');
  if (!data.events.length) { list.replaceChildren(el('li', 'empty', 'No runs yet. Yours could be the first.')); return; }
  const ps = await online.profiles(data.events.map(e => e.id));
  list.replaceChildren(...data.events.slice(0, 25).map(e => {
    const li = el('li'), img = el('img'); img.alt = ''; img.src = ps[e.id]?.avatarUrl || '';
    const what = el('span', 'what'), who = el('b', null, e.name);
    who.onclick = () => openPlayer(e.name);
    if (isChampion(e.id)) { const c = el('span', 'crown-ic'); c.innerHTML = CROWN_SVG; what.append(c); }
    const txt = e.mode === 'levels' ? ` cleared level ${e.level} ${'★'.repeat(e.stars || 1)}`
      : e.mode === 'challenge' ? (e.draw ? ` and ${e.vs} drew a ${Number(e.target).toLocaleString()} challenge` : ` beat ${e.vs} to ${Number(e.target).toLocaleString()}${e.reach != null ? ` in ${Number(e.reach).toFixed(1)}s` : ''}`)
      : ` scored ${Number(e.score).toLocaleString()} in ${MODES[e.mode]?.name || 'Endless'}`;
    what.append(who, document.createTextNode(txt));
    li.append(img, what, el('time', null, ago(e.at)));
    return li;
  }));
}

// ---------- Coil Rush Plus ----------
let buyAfterLogin = false;
function renderPlusUI() {
  const on = paywallOn();
  $('plusLine').hidden = !on || isPlus();
  $('acctPlus').hidden = !(online?.auth?.user && isPlus());
  if (on && online.payments.price) for (const id of ['plusPrice', 'plusPrice2']) { const e = $(id); if (e) e.textContent = online.payments.price; }
  renderSkins();
  if (state === 'select') renderLevels();
}
function openPlus(reason = 'Get the whole game') {
  if (!paywallOn()) return;
  $('plusReason').textContent = reason;
  const owned = isPlus();
  $('plusBuyBox').hidden = owned; $('plusOwned').hidden = !owned; $('plusWaiting').hidden = true; $('plusClaim').hidden = true;
  $('plusErr').textContent = '';
  const guest = !online.auth.user;
  $('plusGuestNote').hidden = !guest; $('plusDirectBox').hidden = !guest;
  $('plusBuy').replaceChildren(...(guest ? [document.createTextNode('Create a FREE account')]
    : [document.createTextNode('Get Plus for '), Object.assign(el('span', null, online.payments.price || '$2.99'), { id: 'plusPrice' })]));
  showModal('plusModal');
}
$('plusClose').onclick = closeModal;
$('plusModal').addEventListener('pointerdown', e => { if (e.target === $('plusModal')) closeModal(); });
$('plusLine').onclick = () => openPlus();
function goCheckout() {
  const url = online.buyUrl();
  if (!url) { $('plusErr').textContent = 'Checkout is not available right now. Try again later.'; return; }
  P.saveLocal(profile);
  location.href = url;
}
function openRegister(sub, thenBuy) {
  buyAfterLogin = thenBuy; closeModal(); setAcctMode('register');
  if (sub) $('acctSub').textContent = sub;
  renderAcct(); showModal('acctModal');
}
$('plusBuy').onclick = () => {
  if (!online.auth.user) { openRegister('A FREE account saves your progress and scores, and lets you add Plus any time.', true); return; }
  goCheckout();
};
$('plusDirect').onclick = goCheckout;   // guest pays first; the purchase is claimed by their next sign-in
$('plusClaimBtn').onclick = () => openRegister('Create your FREE account and the Plus you just bought is added to it.', false);
// Back from Stripe: the webhook can take a few seconds, so poll until the account shows Plus.
async function confirmPurchase() {
  history.replaceState(null, '', location.pathname + location.search);
  if (!online?.auth?.user) {
    // Guest checkout: wait for Stripe's confirmation, then ask them to make (or sign in to) an account.
    if (!online?.pendingClaim) { toast('Sign in to the account you bought Plus with.'); return; }
    openPlus('Thanks for your purchase');
    $('plusBuyBox').hidden = true; $('plusWaiting').hidden = false;
    for (let i = 0; i < 20; i++) {
      if (await online.claimPaid()) { $('plusWaiting').hidden = true; $('plusClaim').hidden = false; $('plusReason').textContent = 'One last step'; sfx.clear(); return; }
      await new Promise(r => setTimeout(r, 2000));
    }
    $('plusWaiting').hidden = true;
    $('plusErr').textContent = 'Your payment is still being confirmed. Create your FREE account and Plus will be added as soon as it arrives.';
    $('plusClaim').hidden = false;
    return;
  }
  if (online.pendingClaim && await online.redeemClaim()) { renderPlusUI(); renderAcct(); }
  openPlus('Thanks for your purchase');
  $('plusBuyBox').hidden = true; $('plusWaiting').hidden = false;
  for (let i = 0; i < 20; i++) {
    if (await online.refreshMe()) {
      $('plusWaiting').hidden = true; $('plusOwned').hidden = false; $('plusReason').textContent = 'Welcome to Plus';
      sfx.clear(); renderPlusUI(); renderAcct(); renderBoard();
      toast('Plus unlocked: levels 6 to 15 and the exclusive skins are yours', 'gold');
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  $('plusWaiting').hidden = true;
  $('plusErr').textContent = 'Your payment went through, but Plus has not appeared yet. Reload the page in a minute. If it still is not there, contact us with your username.';
}

// ---------- share ----------
function shareUrl() {
  const tag = mode === 'levels' ? '#levels' : mode === 'daily' ? '#daily' : '';
  if (online && online.kind === 'netlify') return location.origin + '/' + tag;
  if (window.claude) return 'https://claude.ai/artifact/UoUdpSsFiEfQnEK31YAeuF' + tag;
  return location.protocol.startsWith('http') ? location.origin + location.pathname : '';
}
function shareMessage() {
  const s = runStats(true), time = fmtTime(s.seconds), url = shareUrl();
  let lines;
  if (mode === 'levels') {
    const L = LEVELS[curLevel - 1], st = levelResult ? levelResult.stars : 0;
    lines = game.won
      ? [`🐍 Coil Rush · Level ${curLevel}: ${L.name}`, `Cleared ${'★'.repeat(st)}${'☆'.repeat(3 - st)} · ${game.score.toLocaleString()} pts · ${time}`]
      : [`🐍 Coil Rush · Level ${curLevel}: ${L.name}`, `${game.eaten}/${L.target} berries before I crashed. Can you clear it?`];
  } else {
    const title = mode === 'daily' ? `Daily Run ${dayKey()}` : 'Endless';
    const extras = [`🍓 ${s.berries}`, s.goldens ? `⭐ ${s.goldens}` : '', s.fevers ? `🔥 Fever ×${s.fevers}` : ''].filter(Boolean).join('  ');
    lines = [`🐍 Coil Rush · ${title}`, `${game.score.toLocaleString()} pts · ×${s.maxCombo} combo · ${time}`, extras];
  }
  lines.push(url ? `Beat me: ${url}` : 'Beat my score!');
  return lines.filter(Boolean).join('\n');
}
let shareFile = null, shareObjUrl = null;
function cardData() {
  const st = runStats(true), u = online?.auth?.user;
  const L = mode === 'levels' ? LEVELS[curLevel - 1] : null;
  const base = {
    score: game.score, skin: skin(), url: shareUrl(),
    player: u ? u.name : null, badge: u && isPlus() ? 'PLUS' : null,
    playerSub: `Rank ${P.levelInfo(profile.xp).level}` + (profile.streak > 1 ? ` · ${profile.streak}-day streak` : ''),
    crown: !!(u && isChampion(u.id)),
  };
  if (L) return { ...base, modeLabel: `Level ${curLevel} · ${L.name}`, accent: '#7af0cf', stars: game.won ? (levelResult ? levelResult.stars : 1) : 0,
    scoreLabel: game.won ? 'points · level cleared' : `points · ${game.eaten} of ${L.target} berries`,
    stats: [['Berries', `${game.eaten}/${L.target}`], ['Combo', '×' + st.maxCombo], ['Time', fmtTime(st.seconds)]],
    cta: game.won ? 'Can you clear it?' : 'Can you do better?' };
  if (challenge) return { ...base, modeLabel: `Challenge · ${challenge.target.toLocaleString()}`, accent: '#c6a2ff',
    scoreLabel: challenge.reach != null ? `points · hit ${challenge.target.toLocaleString()} in ${challenge.reach.toFixed(1)}s` : 'points',
    stats: [['Target', challenge.target.toLocaleString()], ['Time', challenge.reach != null ? challenge.reach.toFixed(1) + 's' : fmtTime(st.seconds)], ['Combo', '×' + st.maxCombo], ['Versus', challenge.opp.slice(0, 9)]],
    cta: 'Think you are faster?' };
  return { ...base, modeLabel: mode === 'daily' ? `Daily Run · ${dayKey()}` : 'Endless', accent: mode === 'daily' ? '#ffc94a' : '#ff7a59',
    stats: [['Combo', '×' + st.maxCombo], ['Length', st.length], ['Time', fmtTime(st.seconds)], ['Golden', st.goldens]] };
}
async function openShare() {
  const text = shareMessage(), url = shareUrl();
  const enc = encodeURIComponent;
  $('shareX').href = 'https://x.com/intent/post?text=' + enc(text);
  $('shareWa').href = 'https://wa.me/?text=' + enc(text);
  $('shareTg').href = 'https://t.me/share/url?url=' + enc(url) + '&text=' + enc(text.replace(/\n?Beat me:.*$/, ''));
  $('shareRd').href = 'https://www.reddit.com/submit?url=' + enc(url) + '&title=' + enc(text.split('\n').slice(0, 2).join(' · '));
  $('shareFb').href = 'https://www.facebook.com/sharer/sharer.php?u=' + enc(url);
  for (const id of ['shareFb', 'shareTg', 'shareRd']) $(id).hidden = !url;
  $('shareText').hidden = true; $('shareImg').hidden = true; $('shareMaking').hidden = false;
  for (const id of ['shareNative', 'shareSave', 'shareCopyImg']) $(id).hidden = true;
  showModal('shareModal');
  try {
    const { blob } = await makeShareCard(cardData());
    if (shareObjUrl) URL.revokeObjectURL(shareObjUrl);
    shareObjUrl = URL.createObjectURL(blob);
    shareFile = new File([blob], `coil-rush-${mode}-${game.score}.png`, { type: 'image/png' });
    $('shareImg').src = shareObjUrl; $('shareImg').hidden = false; $('shareMaking').hidden = true;
    const canFiles = !!(navigator.canShare && navigator.canShare({ files: [shareFile] }));
    $('shareNative').hidden = !canFiles;
    $('shareSave').hidden = !!window.claude;              // downloads are blocked inside claude.ai
    $('shareCopyImg').hidden = !(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write);
    $('shareHint').textContent = window.claude
      ? 'Right-click or long-press the image to save it, then post it anywhere.'
      : canFiles ? 'Share image opens Instagram, TikTok, WhatsApp and more.' : 'Save the image, then post it on Instagram, TikTok or anywhere else.';
  } catch (e) {
    reportError(e, 'sharecard');
    $('shareMaking').textContent = 'Could not draw the picture, but you can still copy the text.';
  }
}
$('btnShare').onclick = () => openShare();
$('shareClose').onclick = closeModal;
$('shareModal').addEventListener('pointerdown', e => { if (e.target === $('shareModal')) closeModal(); });
$('shareNative').onclick = async () => {
  try { await navigator.share({ files: [shareFile], text: shareMessage(), title: 'Coil Rush' }); }
  catch (e) { if (!e || e.name !== 'AbortError') toast('Sharing did not work here. Save the image instead.'); }
};
$('shareSave').onclick = () => {
  const a = document.createElement('a'); a.href = shareObjUrl; a.download = shareFile.name;
  document.body.append(a); a.click(); a.remove(); toast('Image saved', 'mint');
};
$('shareCopyImg').onclick = async () => {
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': shareFile })]); toast('Image copied. Paste it into any post.', 'mint'); }
  catch (e) { toast('Copying images is not supported here. Save it instead.'); }
};
$('shareCopy').onclick = async () => {
  const text = shareMessage();
  try { await navigator.clipboard.writeText(text); toast('Copied! Paste it anywhere to challenge your friends.', 'mint'); return; } catch (e) {}
  const box = $('shareText'); box.value = text; box.hidden = false; box.focus(); box.select();
};

// ---------- crowns ----------
const CROWN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5l4.6 4 4.4-6.5 4.4 6.5 4.6-4-1.8 11H4.8z" fill="currentColor"/><rect x="4.8" y="19.6" width="14.4" height="2" rx="1" fill="currentColor"/></svg>';
function isChampion(id) {
  if (!id) return false;
  const ch = (online && online.champions) || {};
  return Object.values(ch).includes(id) || ['daily', 'all', 'levels'].some(k => boards[k].rows && boards[k].rows[0] && boards[k].rows[0].id === id);
}

// ---------- challenges ----------
let chWaiting = 0;
function setTitle() { const n = chWaiting + (typeof chatUnread === 'number' ? chatUnread : 0); document.title = n ? `(${n}) Coil Rush` : 'Coil Rush'; }
let chList = [], chKnown = null, chTarget = 1000, chInvite = null, acceptAfterLogin = null;
const fmtLeft = ms => { if (ms <= 0) return 'ending now'; const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4); return h ? `${h}h ${m}m` : `${Math.max(1, m)}m`; };
const fmtRes = r => (!r ? 'no runs yet' : r.reach != null ? `${r.reach.toFixed(1)}s` : `best ${Number(r.best || 0).toLocaleString()}`);
const myId = () => (online && online.auth && online.auth.user ? online.auth.user.id : null);
const chLink = id => location.origin + '/#ch-' + id;

function startChallenge(doc, quick = false) {
  const me = myId(), opp = doc.from.id === me ? doc.to : doc.from;
  start('endless', quick, curLevel, { seed: hashStr('ch:' + doc.id), challenge: { id: doc.id, target: doc.target, opp: opp ? opp.name : 'someone', reach: null, doc } });
  toast(`Reach ${doc.target.toLocaleString()} as fast as you can`, 'gold');
}
function challengeHit() {
  challenge.reach = Math.round(runTime * 10) / 10;
  game.won = true; game.alive = false;
  sfx.clear(); haptic([30, 50, 30]);
  game.snake.forEach((c, i) => { if (i % 2 === 0) renderer.burst(c.x, c.y, i % 4 ? '#ffc94a' : '#c6a2ff', 6, 1.4); });
  toast(`${challenge.target.toLocaleString()} in ${challenge.reach.toFixed(1)}s!`, 'gold');
  dyingT = 0; state = 'dying';
}
function challengeStanding(doc) {
  const me = myId(), opp = doc.from.id === me ? doc.to : doc.from, mine = doc.results[me], theirs = opp ? doc.results[opp.id] : null;
  if (doc.status === 'done') return doc.winner === me ? `You won the challenge against ${opp.name}!` : doc.winner ? `${opp.name} won this one. Rematch?` : 'It was a draw.';
  const t = `You: ${fmtRes(mine)} · ${opp ? opp.name : 'Them'}: ${fmtRes(theirs)}`;
  return `${t} · ends in ${fmtLeft(doc.deadline - Date.now())}`;
}

function openChallengeForm(name = '') {
  document.querySelector('.tabs [data-tab="challenges"]').click();
  $('chName').value = name; updateChButton();
  $('tab-challenges').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (online.auth.user) setTimeout(() => $('chName').focus(), 300);
}
function updateChButton() {
  const n = $('chName').value.trim();
  $('chCreate').textContent = n ? `Challenge ${n} to ${chTarget.toLocaleString()}` : `Create a ${chTarget.toLocaleString()} challenge link`;
}
document.querySelectorAll('.ch-targets button').forEach(b => b.onclick = () => {
  chTarget = +b.dataset.target;
  document.querySelectorAll('.ch-targets button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  updateChButton(); sfx.click();
});
$('chName').addEventListener('input', updateChButton);
$('chSignup').onclick = () => openRegister('A FREE account lets you challenge players and saves your progress.', false);
$('chForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('chName').value.trim(), btn = $('chCreate'), err = $('chErr');
  if (name && !/^[A-Za-z0-9_]{3,16}$/.test(name)) { err.textContent = 'Usernames are 3–16 letters, numbers or underscores.'; return; }
  err.textContent = ''; btn.disabled = true;
  try {
    const c = await online.challenges.create(name, chTarget);
    $('chName').value = ''; updateChButton();
    if (!c.to) await shareChallengeLink(c); else toast(`Challenge sent to ${c.to.name}`, 'mint');
    await refreshChallenges();
  } catch (ex) { err.textContent = ex.message || 'Could not create the challenge.'; }
  finally { btn.disabled = false; }
});
async function shareChallengeLink(c) {
  const text = `I challenge you to hit ${c.target.toLocaleString()} points in Coil Rush. Same board, fastest time wins. ${chLink(c.id)}`;
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Challenge link copied. Send it to anyone!', 'mint'); }
  catch (e) { toast('Copy this link: ' + chLink(c.id)); }
}
async function chAct(fn, id, ok) {
  try { const c = await online.challenges[fn](id); if (ok) ok(c); await refreshChallenges(); }
  catch (e) { toast(e.message || 'That did not work.'); await refreshChallenges(); }
}

function chItem(c) {
  const me = myId(), fromMe = c.from.id === me, opp = fromMe ? c.to : c.from;
  const box = el('div', 'ch-item'), top = el('div', 'ch-top'), btns = el('div', 'ch-btns');
  const who = el('b', null, opp ? `vs ${opp.name}` : 'Open challenge link');
  if (opp && isChampion(opp.id)) { const cr = el('span', 'crown-ic'); cr.innerHTML = CROWN_SVG; who.prepend(cr); }
  top.append(who, el('span', 'ch-target', c.target.toLocaleString()));
  box.append(top);
  const line = t => { const p = el('div', 'ch-line'); p.textContent = t; box.append(p); return p; };
  const btn = (label, cls, fn) => { const b = el('button', 'btn ' + cls, label); b.onclick = fn; btns.append(b); };
  if (c.status === 'pending' && !fromMe) {
    box.classList.add('incoming');
    line(`${c.from.name} wants to race you to ${c.target.toLocaleString()} points · expires in ${fmtLeft(c.expiresAt - Date.now())}`);
    btn('Accept and play', 'primary', () => chAct('accept', c.id, doc => startChallenge(doc)));
    btn('Decline', '', () => chAct('decline', c.id));
  } else if (c.status === 'pending') {
    line(c.to ? `Waiting for ${c.to.name} to accept · expires in ${fmtLeft(c.expiresAt - Date.now())}` : `Anyone with the link can accept · expires in ${fmtLeft(c.expiresAt - Date.now())}`);
    if (!c.to) btn('Share link', 'primary', () => shareChallengeLink(c));
    btn('Cancel', '', () => chAct('cancel', c.id));
  } else if (c.status === 'active') {
    const p = line(''); p.append('You: ', el('strong', null, fmtRes(c.results[me])), ` · ${opp.name}: `, el('strong', null, fmtRes(c.results[opp.id])));
    line(`Ends in ${fmtLeft(c.deadline - Date.now())}, or as soon as you both hit ${c.target.toLocaleString()}`);
    btn(c.results[me] && c.results[me].reach != null ? 'Beat your time' : 'Play', 'primary', () => startChallenge(c));
    if (online.hasChat) btn('Message', '', () => openChat(opp.name));
  } else {
    const r = el('div', 'ch-line ch-result');
    if (c.status === 'done') {
      r.classList.add(c.winner === me ? 'win' : c.winner ? 'loss' : '');
      r.textContent = c.winner === me ? 'You won' : c.winner ? `${opp.name} won` : 'Draw';
      box.append(r);
      line(`You: ${fmtRes(c.results[me])} · ${opp.name}: ${fmtRes(c.results[opp.id])}`);
      if (opp) btn('Rematch', '', () => openChallengeForm(opp.name));
      if (opp && online.hasChat) btn('Message', '', () => openChat(opp.name));
    } else {
      r.textContent = c.status === 'declined' ? (fromMe ? `${opp.name} declined` : 'You declined') : c.status === 'cancelled' ? 'Cancelled' : 'Expired';
      box.append(r);
    }
  }
  if (btns.children.length) box.append(btns);
  return box;
}
function renderChallenges() {
  if (!online || !online.hasChallenges) return;
  const signedIn = !!myId();
  $('chGuest').hidden = signedIn; $('chForm').hidden = !signedIn;
  const lists = $('chLists'); lists.replaceChildren();
  renderInvite();
  if (!signedIn && chInvite && chInvite.status === 'pending') $('chGuest').hidden = true;   // the invite already has a sign-up button
  if (!signedIn) { $('chBadge').hidden = true; return; }
  const me = myId();
  const groups = [
    ['Waiting for you', chList.filter(c => c.status === 'pending' && c.from.id !== me)],
    ['In progress', chList.filter(c => c.status === 'active')],
    ['Sent', chList.filter(c => c.status === 'pending' && c.from.id === me)],
    ['Finished', chList.filter(c => !['pending', 'active'].includes(c.status)).slice(0, 8)],
  ];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    lists.append(el('h3', null, title), ...items.map(chItem));
  }
  if (!chList.length) lists.append(el('p', 'ch-empty', 'No challenges yet. Pick a target above and challenge someone from the leaderboard, or send a link to a friend.'));
  const waiting = groups[0][1].length + chList.filter(c => c.status === 'active' && !(c.results[me] && c.results[me].reach != null)).length;
  $('chBadge').hidden = !waiting; $('chBadge').textContent = waiting;
  chWaiting = waiting; setTitle();
  $('chUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
async function refreshChallenges() {
  if (!online || !online.hasChallenges || !myId()) { renderChallenges(); return; }
  try {
    const list = await online.challenges.list();
    const me = myId();
    if (chKnown) {
      for (const c of list) {
        const prev = chKnown.get(c.id);
        if (!prev && c.status === 'pending' && c.from.id !== me) {
          toast(`${c.from.name} challenged you to ${c.target.toLocaleString()}!`, 'gold'); sfx.goldenSpawn();
          // Tab in the background and push isn't set up on this device: show a notification from the page.
          if (document.hidden && notifState !== 'on' && online.push) online.push.showLocal("You've been challenged!", `${c.from.name} challenged you to hit ${c.target.toLocaleString()} points.`);
        }
        if (prev && prev !== 'done' && c.status === 'done') {
          const opp = c.from.id === me ? c.to : c.from;
          toast(c.winner === me ? `You beat ${opp.name} to ${c.target.toLocaleString()}!` : c.winner ? `${opp.name} beat you to ${c.target.toLocaleString()}` : `Your challenge with ${opp.name} was a draw`, c.winner === me ? 'gold' : '');
        }
        if (prev === 'pending' && c.status === 'active' && c.from.id === me) toast(`${c.to.name} accepted your ${c.target.toLocaleString()} challenge!`, 'mint');
      }
    }
    chKnown = new Map(list.map(c => [c.id, c.status]));
    chList = list;
  } catch (e) {}
  renderChallenges();
}

// Invite links: #ch-<id>
function renderInvite() {
  const box = $('chInvite');
  if (!chInvite) { box.hidden = true; return; }
  const c = chInvite, me = myId();
  box.hidden = false; box.replaceChildren();
  const p = el('p');
  if (c.status !== 'pending' || (c.to && c.to.id !== me) || c.from.id === me) {
    p.textContent = c.from.id === me ? 'This is your own challenge link. Send it to a friend!' : 'This challenge is no longer open.';
    box.append(p); return;
  }
  p.append(el('b', null, c.from.name), ` challenges you to hit ${c.target.toLocaleString()} points. Same board, fastest time wins.`);
  const b = el('button', 'btn primary', me ? 'Accept and play' : 'Create a FREE account to accept');
  b.onclick = () => {
    if (!me) { acceptAfterLogin = c.id; openRegister(`${c.from.name} challenged you. Create a FREE account to accept.`, false); return; }
    chAct('accept', c.id, doc => { chInvite = null; startChallenge(doc); });
  };
  box.append(p, b);
}

function openChallengeHash() {
  const cm = location.hash.match(/^#chat-([A-Za-z0-9_]{3,16})$/);
  if (cm && online && online.hasChat) { history.replaceState(null, '', location.pathname + location.search); openChat(cm[1]); return; }
  if (location.hash === '#challenges' && online && online.challenges) {
    history.replaceState(null, '', location.pathname + location.search);
    document.querySelector('.tabs [data-tab="challenges"]').click();
    $('tab-challenges').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const m = location.hash.match(/^#ch-([A-Za-z0-9_-]{8,24})$/);
  if (!m || !online || !online.challenges) return;
  history.replaceState(null, '', location.pathname + location.search);
  online.challenges.get(m[1]).then(c => {
    chInvite = c; document.querySelector('.tabs [data-tab="challenges"]').click();
    if (c.status === 'pending' && c.from.id !== myId()) toast(`${c.from.name} challenged you! See Challenges.`, 'gold');
    renderInvite();
    $('chInvite').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }).catch(() => toast('That challenge link no longer works.'));
}

// ---------- notifications ----------
let notifState = 'unsupported';
const NOTIF_TEXT = {
  on: ['On for this device', "You'll get a notification when someone challenges you, accepts, sets a time or wins."],
  off: ['Off', 'Get a notification when someone challenges you, even when the game is closed.'],
  'ios-install': ['Needs one step on iPhone', 'Tap the Share button, then "Add to Home Screen". Open Coil Rush from your Home Screen and turn notifications on there.'],
  denied: ['Blocked', 'Notifications are blocked for this site. Allow them in your browser or phone settings, then come back here.'],
  guest: ['Off', 'Create a FREE account to get a notification when someone challenges you.'],
};
async function renderNotif() {
  if (!online || !online.push) return;
  const signedIn = !!myId();
  notifState = signedIn ? await online.push.state() : 'guest';
  $('notifSection').hidden = notifState === 'unsupported';
  const [label, hint] = NOTIF_TEXT[notifState] || NOTIF_TEXT.off;
  $('notifState').textContent = label;
  $('notifState').className = 'notif-state' + (notifState === 'on' ? ' on' : notifState === 'denied' ? ' blocked' : '');
  $('notifHint').textContent = hint;
  $('notifToggle').hidden = notifState === 'ios-install' || notifState === 'denied';
  $('notifToggle').textContent = notifState === 'on' ? 'Turn off' : notifState === 'guest' ? 'Create account' : 'Turn on';
  $('notifTest').hidden = notifState !== 'on';
  // banner in the Challenges tab
  let dismissed = false; try { dismissed = localStorage.getItem('coilrush.notifBannerHidden') === '1'; } catch (e) {}
  const showBanner = signedIn && !dismissed && (notifState === 'off' || notifState === 'ios-install');
  $('notifBanner').hidden = !showBanner;
  $('notifBanner').classList.toggle('no-btn', notifState === 'ios-install');
  $('notifBannerBtn').hidden = notifState === 'ios-install';
  $('notifBannerText').textContent = notifState === 'ios-install' ? 'On iPhone: tap Share, then "Add to Home Screen". Open Coil Rush from there and turn notifications on.' : 'Get a notification on this device when someone challenges you.';
}
async function turnOnNotif() {
  if (!myId()) { openRegister('Create a FREE account to get challenge notifications.', false); return; }
  try { await online.push.enable(); toast('Notifications are on. We will let you know when you are challenged.', 'mint'); sfx.click(); }
  catch (e) { toast(e.message || 'Could not turn on notifications.'); }
  renderNotif();
}
$('notifToggle').onclick = async () => {
  if (notifState === 'on') { await online.push.disable(); toast('Notifications turned off for this device.'); renderNotif(); }
  else turnOnNotif();
};
$('notifBannerBtn').onclick = turnOnNotif;
$('notifBannerX').onclick = () => { try { localStorage.setItem('coilrush.notifBannerHidden', '1'); } catch (e) {} $('notifBanner').hidden = true; };
$('notifTest').onclick = async () => {
  try { await online.push.test(); toast('Test sent. It should pop up in a moment.', 'mint'); } catch (e) { toast(e.message || 'Could not send a test.'); }
};
// A tapped notification focuses an open game tab: jump to Challenges.
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', ev => {
  if (!ev.data || ev.data.type !== 'open') return;
  const hash = new URL(ev.data.url, location.origin).hash, cm = hash.match(/^#chat-([A-Za-z0-9_]{3,16})$/);
  if (cm) openChat(cm[1]);
  else { document.querySelector('.tabs [data-tab="challenges"]')?.click(); refreshChallenges(); }
});

// ---------- direct messages ----------
// While a chat is open it checks for new messages every 2.5s; otherwise the inbox is checked every
// 20s (once a minute in a background tab) and push notifications cover the rest.
let chatWith = null, chatMsgs = [], chatSince = 0, chatSeenAt = 0, chatBlockedState = { byMe: false, byThem: false };
let chatUnread = 0, chatLastNotified = Date.now(), chatTimer = null, chatBusy = false;
function slowWhenHidden(fn, ms) { let n = 0; return setInterval(() => { n++; if (!document.hidden || n % 3 === 0) fn(); }, ms); }
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago2 = t => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };

function openChat(name) {
  if (!online || !online.hasChat) return;
  showModal('chatModal');
  if (!myId()) { showInboxView(); return; }
  if (name) openThread(name); else showInboxView();
}
function showInboxView() {
  chatWith = null; clearInterval(chatTimer);
  $('chatInboxView').hidden = false; $('chatThreadView').hidden = true;
  const signedIn = !!myId();
  $('chatGuest').hidden = signedIn; $('chatNewForm').hidden = !signedIn; $('chatList').hidden = !signedIn; $('chatNewErr').textContent = '';
  if (signedIn) refreshInbox();
}
async function refreshInbox() {
  if (!online || !online.hasChat || !myId()) { chatUnread = 0; $('chatBadge').hidden = true; setTitle(); return; }
  let data; try { data = await online.chat.inbox(); } catch (e) { return; }
  chatUnread = data.unread; $('chatBadge').hidden = !chatUnread; $('chatBadge').textContent = chatUnread > 99 ? '99+' : chatUnread; setTitle();
  // pop-up for new messages that arrived while you weren't looking at that chat
  for (const c of data.conversations) {
    if (c.unread && c.last && c.last.at > chatLastNotified && c.last.from !== myId() && !(openModal === 'chatModal' && chatWith && chatWith.toLowerCase() === c.with.name.toLowerCase())) {
      toast(`${c.with.name}: ${c.last.text}`, 'mint'); sfx.click();
      if (document.hidden && notifState !== 'on' && online.push) online.push.showLocal(c.with.name, c.last.text);
    }
  }
  chatLastNotified = Math.max(chatLastNotified, ...data.conversations.map(c => (c.last ? c.last.at : 0)));
  const list = $('chatList'); if (list.hidden) return;
  if (!data.conversations.length) { list.replaceChildren(el('li', 'empty', 'No messages yet. Type a username above, or tap Message on any player profile.')); return; }
  list.replaceChildren(...data.conversations.map(c => {
    const li = el('li', c.unread ? 'unread' : ''), b = el('button'), img = el('img'); img.alt = ''; img.src = avatarFor(c.with.name);
    const main = el('span', 'cl-main'), nm = el('span', 'cl-name', c.with.name);
    if (isChampion(c.with.id)) { const cr = el('span', 'crown-ic'); cr.innerHTML = CROWN_SVG; nm.prepend(cr); }
    main.append(nm, el('span', 'cl-last', (c.last.from === myId() ? 'You: ' : '') + c.last.text));
    const side = el('span', 'cl-side'); side.append(el('span', null, ago2(c.updatedAt)));
    if (c.unread) side.append(el('span', 'cl-dot', String(c.unread)));
    b.append(img, main, side); b.onclick = () => openThread(c.with.name); li.append(b); return li;
  }));
}
$('chatNewForm').addEventListener('submit', e => {
  e.preventDefault();
  const n = $('chatNewName').value.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(n)) { $('chatNewErr').textContent = 'Usernames are 3–16 letters, numbers or underscores.'; return; }
  if (n.toLowerCase() === (online.auth.user.name || '').toLowerCase()) { $('chatNewErr').textContent = "That's you!"; return; }
  $('chatNewName').value = ''; openThread(n);
});

async function openThread(name) {
  chatWith = name; chatMsgs = []; chatSince = 0; chatSeenAt = 0;
  $('chatInboxView').hidden = true; $('chatThreadView').hidden = false; $('chatMenu').hidden = true;
  $('chatName').textContent = name; $('chatAva').src = avatarFor(name); $('chatSub').textContent = 'Loading…';
  $('chatMsgs').replaceChildren(); $('chatBlocked').hidden = true; $('chatInput').value = '';
  try {
    const t = await online.chat.thread(name, 0);
    if (chatWith !== name) return;
    chatWith = t.with.name; $('chatName').textContent = t.with.name;
    if (isChampion(t.with.id)) { const cr = el('span', 'crown-ic'); cr.innerHTML = CROWN_SVG; $('chatName').prepend(cr); }
    $('chatSub').textContent = 'Tap for profile';
    applyThread(t);
    refreshInbox();
  } catch (e) {
    $('chatSub').textContent = '';
    $('chatMsgs').replaceChildren(el('p', 'msg-hint', e.message || 'Could not open this chat.'));
    return;
  }
  clearInterval(chatTimer);
  chatTimer = setInterval(pollThread, 2500);
  if (matchMedia('(pointer: fine)').matches) $('chatInput').focus();
}
function applyThread(t) {
  for (const m of t.messages) if (!chatMsgs.some(x => x.id === m.id)) chatMsgs.push(m);
  chatMsgs.sort((a, b) => a.at - b.at);
  if (chatMsgs.length) chatSince = Math.max(chatSince, ...chatMsgs.filter(m => !m.pending).map(m => m.at));
  chatSeenAt = t.otherSeenAt || chatSeenAt;
  chatBlockedState = t.blocked || chatBlockedState;
  renderMsgs();
}
async function pollThread() {
  if (!chatWith || openModal !== 'chatModal' || document.hidden || chatBusy) return;
  chatBusy = true;
  try { const name = chatWith, t = await online.chat.thread(name, chatSince); if (chatWith === name) applyThread(t); } catch (e) {}
  chatBusy = false;
}
function renderMsgs() {
  const box = $('chatMsgs'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60, me = myId();
  const nodes = []; let prev = 0;
  if (!chatMsgs.length) nodes.push(el('p', 'msg-hint', `Say hi to ${chatWith}! Messages are visible only to the two of you.`));
  for (const m of chatMsgs) {
    if (m.at - prev > 5 * 60e3) nodes.push(el('div', 'msg-time', clock(m.at)));
    prev = m.at;
    const b = el('div', 'msg' + (m.from === me ? ' mine' : '') + (m.pending ? ' pending' : '') + (m.failed ? ' failed' : ''), m.text);
    if (m.failed) { b.title = 'Not sent. Tap to try again.'; b.onclick = () => { chatMsgs = chatMsgs.filter(x => x !== m); sendChat(m.text); }; }
    nodes.push(b);
  }
  const lastMine = [...chatMsgs].reverse().find(m => m.from === me && !m.pending && !m.failed);
  if (lastMine && chatSeenAt >= lastMine.at && chatMsgs[chatMsgs.length - 1] === lastMine) nodes.push(el('div', 'msg-seen', 'Seen'));
  if (chatMsgs.some(m => m.failed)) nodes.push(el('div', 'msg-seen', 'Not sent. Tap the message to retry.'));
  box.replaceChildren(...nodes);
  if (atBottom || chatMsgs[chatMsgs.length - 1]?.from === me) box.scrollTop = box.scrollHeight;
  const { byMe, byThem } = chatBlockedState;
  $('chatBlocked').hidden = !(byMe || byThem);
  $('chatBlocked').textContent = byMe ? `You blocked ${chatWith}. Unblock them from the ⋯ menu to chat.` : byThem ? "You can't message this player." : '';
  $('chatForm').hidden = byMe || byThem; $('chatQuick').hidden = byMe || byThem;
  $('chatBlock').textContent = byMe ? 'Unblock' : 'Block';
}
async function sendChat(text) {
  text = text.trim(); if (!text || !chatWith) return;
  const temp = { id: 'tmp' + Math.random(), from: myId(), text, at: Date.now(), pending: true };
  chatMsgs.push(temp); renderMsgs();
  try {
    const m = await online.chat.send(chatWith, text);
    chatMsgs = chatMsgs.filter(x => x !== temp);
    if (!chatMsgs.some(x => x.id === m.id)) chatMsgs.push(m);
    chatMsgs.sort((a, b) => a.at - b.at); chatSince = Math.max(chatSince, m.at);
  } catch (e) {
    temp.pending = false; temp.failed = true; toast(e.message || 'Message not sent.');
  }
  renderMsgs();
}
$('chatForm').addEventListener('submit', e => { e.preventDefault(); const v = $('chatInput').value; $('chatInput').value = ''; sendChat(v); });
$('chatQuick').querySelectorAll('button').forEach(b => b.onclick = () => sendChat(b.textContent));
$('chatClose').onclick = closeModal;
$('chatBack').onclick = showInboxView;
$('chatBtn').onclick = () => openChat();
$('chatSignup').onclick = () => openRegister('Create a FREE account to chat with other players.', false);
$('chatWho').onclick = () => { const n = chatWith; closeModal(); openPlayer(n); };
$('chatChallenge').onclick = () => { const n = chatWith; closeModal(); openChallengeForm(n); };
$('chatMore').onclick = () => { const open = $('chatMenu').hidden; $('chatMenu').hidden = !open; $('chatMore').setAttribute('aria-expanded', String(open)); };
$('chatBlock').onclick = async () => {
  $('chatMenu').hidden = true;
  const block = !chatBlockedState.byMe, n = chatWith;
  try { await online.chat.block(n, block); chatBlockedState = { ...chatBlockedState, byMe: block }; renderMsgs(); toast(block ? `${n} is blocked. They can't message you.` : `${n} is unblocked.`); }
  catch (e) { toast(e.message || 'That did not work.'); }
};
$('chatReport').onclick = async () => {
  $('chatMenu').hidden = true;
  try { await online.chat.report(chatWith, 'Reported from chat'); toast('Thanks for reporting. We will review it. You can also block this player from the ⋯ menu.'); }
  catch (e) { toast(e.message || 'Could not send the report.'); }
};

// ---------- coach (Claude) ----------
$('btnCoach').onclick = async () => {
  const sample = online?.sample; if (!sample) return;
  const btn = $('btnCoach'), out = $('coachText');
  btn.disabled = true; out.textContent = 'Thinking…';
  const prompt = `You coach players of Coil Rush, a snake arcade game on a 21x21 grid. Rules: berries give 10 points times the combo multiplier; eating the next berry quickly raises the combo up to x8, being slow resets it. Golden plums are worth 50 times the multiplier and fade after a few seconds. Power-ups: Ghost (pass through your tail and rocks), Slow-mo, Magnet (pulls food toward you). Speed rises every 6 berries, and in Endless and Daily Run rocks start dropping from speed 3 with a blinking warning first. Walls kill except in Zen.

Give this player ONE specific, encouraging tip for their next run, in at most two short sentences. No greeting, no lists.

Their run: mode ${MODES[mode].name}, score ${game.score}, final length ${game.snake.length}, max combo x${game.stats.maxCombo}, golden plums ${game.stats.goldens}, power-ups used ${game.stats.powers}, reached speed ${game.stats.maxLevel}, survived ${Math.floor(runTime)} seconds, died because: ${CAUSES[game.cause] || 'unknown'}. Their best in this mode is ${profile.best[mode] || 0}.`;
  try {
    const { text } = await sample(prompt, { modelTier: 'quick', onText: ({ text }) => { out.textContent = text; } });
    out.textContent = text.trim(); btn.hidden = true;
  } catch (e) {
    if (e && e.code === 'not_granted') { $('coach').hidden = true; return; }
    out.textContent = e && e.code === 'rate_limited' ? 'The coach is busy. Try again in a minute.' : 'The coach could not answer this time.';
    btn.disabled = false;
  }
};

// ---------- boot ----------
try { const t = localStorage.getItem('coilrush.tab'); if (t) document.querySelector(`.tabs [data-tab="${t}"]`)?.click(); } catch (e) {}
renderAll(); renderReset();
setInterval(renderReset, 30000);
setInterval(() => {
  if (!online) return;
  const o = online.online();
  if (!o) return;
  $('online').hidden = false;
  const label = o.label || 'here';
  $('onlineText').textContent = o.playing > 0 ? `${o.here} ${label} · ${o.playing} playing` : `${o.here} ${label} now`;
}, 1500);
setInterval(() => { if (state === 'playing') renderMissions(); }, 1000);
$('appVersion').textContent = `Coil Rush v${VERSION}`;

// Deep links from shared results: #daily or #levels open that mode's card.
if (location.hash === '#daily' || location.hash === '#levels') { selMode = location.hash.slice(1); renderBests(); }
setState('menu');
requestAnimationFrame(frame);

initOnline().then(async api => {
  onlineChecked = true;
  online = api;
  if (!api) { renderBoard(); return; }
  // Cloud profile: keep whichever copy has more progress.
  const remote = await api.loadProfile();
  if (remote && typeof remote === 'object' && (remote.xp || 0) > profile.xp) {
    profile = P.fromRemote(remote);
    missions = P.ensureDay(profile); setSound(profile.sound); setMusic(profile.music); setVolumes(profile.musicVol / 100, profile.sfxVol / 100); syncVolumeUI(); P.saveLocal(profile); applyControls();
    $('musicBtn').setAttribute('aria-pressed', String(!profile.music)); $('soundBtn').setAttribute('aria-pressed', String(!profile.sound));
  } else if (api.uid && profile.games > 0) api.saveProfile(profile);
  await api.loadMine();
  if (api.sample) $('coach').hidden = false;
  if (api.payments) renderPlusUI();
  if (location.hash === '#plus-thanks') confirmPurchase();
  else if (api.pendingClaim && !(api.auth && api.auth.user)) api.claimPaid().then(paid => { if (paid) toast('You have Plus waiting. Create your FREE account to claim it.', 'gold'); });
  if (api.auth) {
    $('tabBtn-live').hidden = false; $('lbLevels').hidden = false; $('tabBtn-challenges').hidden = false;
    refreshChallenges(); slowWhenHidden(refreshChallenges, 20000);
    $('chatBtn').hidden = false; refreshInbox(); slowWhenHidden(refreshInbox, 20000);
    renderNotif();
    openChallengeHash();
    addEventListener('hashchange', openChallengeHash);   // link opened in a tab that already has the game
    renderAcct();
    api.auth.onChange(user => { onAuthChange(user).catch(e => reportError(e, 'auth')); });
    // A saved session that has expired: fall back to the guest slot.
    if (!api.auth.user && P.currentKey() !== P.GUEST_KEY) await onAuthChange(null);
    api.onFeed(renderFeed);
    try { const t = localStorage.getItem('coilrush.tab'); if (t === 'live') document.querySelector('.tabs [data-tab="live"]')?.click(); } catch (e) {}
  }
  if (api.hasBoard) {
    boards.daily.state = boards.all.state = 'loading';
    api.watchBoards((which, b) => { boards[which] = b; if (which === boardTab) renderBoard(); renderAcct(); });
  }
  api.onRun(async ({ by, score, mode: m }) => {
    const ps = by ? await api.profiles([by]) : {};
    const name = (by && ps[by] && ps[by].name) || 'Someone';
    toast(`${name} just scored ${score.toLocaleString()} in ${MODES[m].name}`);
  });
  setState(state);
  renderAll();
});
