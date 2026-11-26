// Player profile, XP levels and daily missions. Local-first; online.js mirrors it to the cloud.
import { mulberry32, hashStr, dayKey } from './rng.js';

export const GUEST_KEY = 'coilrush.profile.v1';
let KEY = GUEST_KEY;   // which local slot the current player's progress lives in
export const keyFor = user => (user ? 'coilrush.profile.u.' + user.id : GUEST_KEY);
export function useKey(k) { KEY = k || GUEST_KEY; }
export const currentKey = () => KEY;
export const SETTINGS = ['sound', 'music', 'musicVol', 'sfxVol', 'controls', 'graphics'];

export const defaultProfile = () => ({
  xp: 0, games: 0, eaten: 0,
  best: { endless: 0, daily: 0, zen: 0 },
  dailyDay: '', dailyBest: 0,
  skin: 'ember', sound: true, music: true, musicVol: 70, sfxVol: 80, controls: 'dpad', graphics: 'auto',
  levels: { unlocked: 1, best: {}, stars: {} },
  streak: 0, lastDay: '',
  mission: { day: '', progress: {}, done: {} },
  updatedAt: 0,
});

export function loadLocal(key = KEY) {
  const p = defaultProfile();
  try {
    const d = JSON.parse(localStorage.getItem(key) || 'null');
    if (d && typeof d === 'object') return sanitize({ ...p, ...d, best: { ...p.best, ...(d.best || {}) } });
  } catch (e) {}
  return p;
}
export function saveLocal(p, key = KEY) {
  p.updatedAt = Date.now();
  try { localStorage.setItem(key, JSON.stringify(p)); } catch (e) {}
}
export function fromRemote(remote) {
  const d = defaultProfile();
  return sanitize({ ...d, ...remote, best: { ...d.best, ...(remote.best || {}) } });
}
export function sanitize(p) {
  const num = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  p.xp = num(p.xp); p.games = num(p.games); p.eaten = num(p.eaten); p.dailyBest = num(p.dailyBest);
  for (const k of ['endless', 'daily', 'zen']) p.best[k] = num(p.best[k]);
  if (!['dpad', 'stick', 'turn'].includes(p.controls)) p.controls = 'dpad';
  if (!['auto', 'high', 'smooth'].includes(p.graphics)) p.graphics = 'auto';
  p.streak = num(p.streak);
  if (typeof p.music !== 'boolean') p.music = true;
  const vol = (v, d) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : d);
  p.musicVol = vol(p.musicVol, 70); p.sfxVol = vol(p.sfxVol, 80);
  if (!p.levels || typeof p.levels !== 'object') p.levels = { unlocked: 1, best: {}, stars: {} };
  p.levels.unlocked = Math.max(1, Math.min(15, num(p.levels.unlocked) || 1));
  p.levels.best ||= {}; p.levels.stars ||= {};
  if (!p.mission || typeof p.mission !== 'object') p.mission = { day: '', progress: {}, done: {} };
  p.mission.progress ||= {}; p.mission.done ||= {};
  return p;
}

export function levelInfo(xp) {
  let level = 1, need = 150, rest = xp;
  while (rest >= need) { rest -= need; level++; need = 150 + (level - 1) * 75; }
  return { level, into: rest, need };
}

// Daily streak: call once per finished run. Returns bonus XP for the first run of a new day.
export function touchStreak(p, today, yesterday) {
  if (p.lastDay === today) return 0;
  p.streak = p.lastDay === yesterday ? p.streak + 1 : 1;
  p.lastDay = today;
  return Math.min(50, 10 * p.streak);
}

// kind "run": best single-run value counts. kind "day": summed across today's runs.
const POOL = [
  { id: 'eat40',    text: 'Eat 40 berries today',               target: 40,  xp: 80,  kind: 'day', stat: 'berries' },
  { id: 'combo5',   text: 'Reach a ×5 combo',                   target: 5,   xp: 100, kind: 'run', stat: 'maxCombo' },
  { id: 'score400', text: 'Score 400 in one run',               target: 400, xp: 120, kind: 'run', stat: 'score' },
  { id: 'gold3',    text: 'Catch 3 golden plums in one run',    target: 3,   xp: 100, kind: 'run', stat: 'goldens' },
  { id: 'live90',   text: 'Survive 90 seconds in one run',      target: 90,  xp: 90,  kind: 'run', stat: 'seconds' },
  { id: 'power2',   text: 'Use 2 power-ups in one run',         target: 2,   xp: 80,  kind: 'run', stat: 'powers' },
  { id: 'daily1',   text: 'Finish a Daily Run',                 target: 1,   xp: 60,  kind: 'day', stat: 'dailyRuns' },
  { id: 'speed6',   text: 'Reach speed 6',                      target: 6,   xp: 110, kind: 'run', stat: 'maxLevel' },
  { id: 'runs5',    text: 'Play 5 runs today',                  target: 5,   xp: 70,  kind: 'day', stat: 'runs' },
  { id: 'ghost1',   text: 'Slip through your own tail as a ghost', target: 1, xp: 90, kind: 'run', stat: 'ghostPasses' },
  { id: 'fever1',   text: 'Trigger Fever (hit a ×8 combo)',     target: 1,   xp: 140, kind: 'run', stat: 'fevers' },
  { id: 'close5',   text: 'Pull off 5 close calls near rocks',  target: 5,   xp: 100, kind: 'run', stat: 'closeCalls' },
  { id: 'len25',    text: 'Grow to length 25',                  target: 25,  xp: 100, kind: 'run', stat: 'length' },
];

export function todaysMissions(day = dayKey()) {
  const r = mulberry32(hashStr('missions:' + day)), pool = [...POOL], out = [];
  while (out.length < 3) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}

export function ensureDay(p) {
  const day = dayKey();
  if (p.mission.day !== day) p.mission = { day, progress: {}, done: {} };
  return todaysMissions(day);
}

export function missionValue(p, m, run) {
  const stored = p.mission.progress[m.id] || 0, v = run ? run[m.stat] || 0 : 0;
  return Math.min(m.target, m.kind === 'day' ? stored + v : Math.max(stored, v));
}

// Mark missions finished by the live run. Returns the ones newly completed (XP already added).
export function checkLive(p, missions, run) {
  const fresh = [];
  for (const m of missions) {
    if (p.mission.done[m.id]) continue;
    if (missionValue(p, m, run) >= m.target) { p.mission.done[m.id] = true; p.xp += m.xp; fresh.push(m); }
  }
  return fresh;
}

// Fold a finished run into stored progress.
export function commitRun(p, missions, run) {
  for (const m of missions) p.mission.progress[m.id] = missionValue(p, m, run);
  return checkLive(p, missions, null);
}
