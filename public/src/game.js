// Pure game simulation: no DOM, no canvas. One call to step() = one tick.
// step() returns a list of events the UI turns into sound, particles and toasts.
import { mulberry32 } from './rng.js';

export const GRID = 21;
export const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
export const POWERS = ['ghost', 'slow', 'magnet'];

export class Game {
  // opts (Levels mode): { walls: [cellKey], portals: [[{x,y},{x,y}]], wrap, rocks, target, speed, start, n }
  constructor(mode, seed, opts = {}) {
    this.mode = mode;
    this.rng = mulberry32(seed);
    this.wrap = opts.wrap ?? (mode === 'zen' || mode === 'demo');
    this.rocksOn = opts.rocks ?? (mode === 'endless' || mode === 'daily');
    this.walls = new Set(opts.walls || []);
    this.portals = opts.portals || [];
    this.portalMap = new Map();
    for (const [a, b] of this.portals) { this.portalMap.set(a.y * GRID + a.x, b); this.portalMap.set(b.y * GRID + b.x, a); }
    this.target = opts.target || 0; this.baseSpeed = opts.speed || 0; this.stage = opts.n || 0;
    this.won = false;
    const m = GRID >> 1, st = opts.start || { x: m, y: m, dir: 'right' }, [sdx, sdy] = DIRS[st.dir];
    this.snake = [0, 1, 2, 3].map(i => ({ x: st.x - sdx * i, y: st.y - sdy * i }));
    this.prev = this.snake.map(c => ({ ...c }));
    this.dir = st.dir; this.queue = []; this.grow = 0;
    this.rocks = []; this.berry = null; this.golden = null; this.power = null;
    this.fx = { ghost: 0, slow: 0, magnet: 0 };
    this.score = 0; this.combo = 0; this.comboT = 0; this.comboWin = 1;
    this.level = this.stage || 1; this.eaten = 0; this.ticks = 0; this.alive = true; this.cause = '';
    this.fever = 0; this.graceUsed = false; this.closeCd = 0;
    this.stats = { berries: 0, goldens: 0, powers: 0, maxCombo: 1, ghostPasses: 0, maxLevel: 1, fevers: 0, closeCalls: 0 };
    this.spawnBerry();
  }

  get head() { return this.snake[0]; }
  get mult() { return 1 + this.combo; }

  interval() {
    if (this.mode === 'levels') return Math.max(60, this.baseSpeed - this.eaten * 1.2) * (this.fx.slow > 0 ? 1.6 : 1);
    const base = this.mode === 'zen' ? 150 : this.mode === 'demo' ? 105 : Math.max(64, 136 - (this.level - 1) * 8);
    return this.fx.slow > 0 ? base * 1.6 : base;
  }

  dist(a, b) {
    let dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    if (this.wrap) { dx = Math.min(dx, GRID - dx); dy = Math.min(dy, GRID - dy); }
    return dx + dy;
  }
  wallAt(x, y) { return this.walls.has(y * GRID + x); }
  portalAt(x, y) { return this.portalMap.has(y * GRID + x); }
  rockAt(x, y) { return this.rocks.find(r => r.x === x && r.y === y); }
  snakeAt(x, y, skipTail = false) {
    const n = this.snake.length - (skipTail ? 1 : 0);
    for (let i = 0; i < n; i++) { const c = this.snake[i]; if (c.x === x && c.y === y) return true; }
    return false;
  }
  itemAt(x, y) { return [this.berry, this.golden, this.power].some(o => o && o.x === x && o.y === y); }
  freeCell(filter) {
    const out = [];
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      if (this.wallAt(x, y) || this.portalAt(x, y) || this.snakeAt(x, y) || this.rockAt(x, y) || this.itemAt(x, y)) continue;
      if (filter && !filter(x, y)) continue;
      out.push({ x, y });
    }
    return out.length ? out[Math.floor(this.rng() * out.length)] : null;
  }

  spawnBerry() {
    this.berry = this.freeCell();
    if (this.berry) { this.comboT = 0; this.comboWin = this.dist(this.head, this.berry) + 8; }
  }
  spawnGolden() {
    const c = this.freeCell((x, y) => this.dist(this.head, { x, y }) >= 4);
    if (c) this.golden = { ...c, ttl: 48, max: 48 };
  }
  spawnPower() {
    const c = this.freeCell((x, y) => this.dist(this.head, { x, y }) >= 3);
    if (c) this.power = { ...c, kind: POWERS[Math.floor(this.rng() * POWERS.length)], ttl: 70, max: 70 };
  }
  spawnRock() {
    const h = this.head, [dx, dy] = DIRS[this.dir];
    const c = this.freeCell((x, y) => {
      if (this.dist(h, { x, y }) < 5) return false;
      for (let s = 1; s <= 7; s++) if (x === h.x + dx * s && y === h.y + dy * s) return false;
      return true;
    });
    if (c) this.rocks.push({ ...c, warn: 14 });
    return c;
  }

  // Relative steering for the turn-button controls.
  turn(side) {
    const base = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
    const L = { up: 'left', left: 'down', down: 'right', right: 'up' };
    const R = { up: 'right', right: 'down', down: 'left', left: 'up' };
    this.enqueue(side === 'left' ? L[base] : R[base]);
  }

  enqueue(d) {
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
    if (d === last || d === OPP[last]) return;
    if (this.queue.length < 3) this.queue.push(d);
  }

  blocked(x, y) {
    if (this.wallAt(x, y) || this.snakeAt(x, y, true)) return true;
    const r = this.rockAt(x, y);
    return !!(r && r.warn <= 0);
  }
  flood(sx, sy, limit) {
    const seen = new Set([sy * GRID + sx]), q = [[sx, sy]];
    while (q.length && seen.size < limit) {
      const [x, y] = q.shift();
      for (const [dx, dy] of Object.values(DIRS)) {
        let nx = x + dx, ny = y + dy;
        if (this.wrap) { nx = (nx + GRID) % GRID; ny = (ny + GRID) % GRID; }
        else if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const k = ny * GRID + nx;
        if (seen.has(k) || this.blocked(nx, ny)) continue;
        seen.add(k); q.push([nx, ny]);
      }
    }
    return seen.size;
  }

  step() {
    const ev = [];
    if (!this.alive) return ev;
    this.prev = this.snake.map(c => ({ x: c.x, y: c.y }));
    this.ticks++;
    if (this.queue.length) this.dir = this.queue.shift();
    const [dx, dy] = DIRS[this.dir];
    let nx = this.head.x + dx, ny = this.head.y + dy;
    if (this.wrap) { nx = (nx + GRID) % GRID; ny = (ny + GRID) % GRID; }
    let warp = null;
    if (this.portalMap.has(ny * GRID + nx)) { const to = this.portalMap.get(ny * GRID + nx); warp = { x: nx, y: ny, tx: to.x, ty: to.y }; nx = to.x; ny = to.y; }

    const eatB = this.berry && this.berry.x === nx && this.berry.y === ny;
    const eatG = this.golden && this.golden.x === nx && this.golden.y === ny;
    const pop = !eatB && !eatG && this.grow === 0;
    const ghost = this.fx.ghost > 0;
    const out = nx < 0 || ny < 0 || nx >= GRID || ny >= GRID;
    const rock = out ? null : this.rockAt(nx, ny);
    const hitSelf = !out && this.snakeAt(nx, ny, pop), hitRock = !!(rock && rock.warn <= 0);
    const cause = out || this.wallAt(nx, ny) ? 'wall' : (hitSelf && !ghost) ? 'self' : (hitRock && !ghost) ? 'rock' : '';
    if (cause) {
      // Grace tick: hold still for one beat so a late turn can still save the run.
      if (!this.graceUsed) { this.graceUsed = true; ev.push({ type: 'grace', cause }); return ev; }
      return this.die(cause, ev);
    }
    this.graceUsed = false;
    if (warp) ev.push({ type: 'portal', ...warp });
    if (hitSelf) { this.stats.ghostPasses++; ev.push({ type: 'phase', x: nx, y: ny }); }
    if (hitRock) ev.push({ type: 'phase', x: nx, y: ny });

    this.snake.unshift({ x: nx, y: ny });
    if (pop) this.snake.pop(); else if (!eatB && !eatG) this.grow--;

    for (const k in this.fx) if (this.fx[k] > 0 && --this.fx[k] === 0) ev.push({ type: 'fxEnd', kind: k });
    this.comboT++;
    if (this.fever > 0 && --this.fever === 0) ev.push({ type: 'feverEnd' });
    if (this.combo > 0 && this.comboT > this.comboWin && this.fever === 0) { this.combo = 0; ev.push({ type: 'comboLost' }); }
    if (this.closeCd > 0) this.closeCd--;
    if (this.rocksOn && this.closeCd === 0) {
      for (const [ax, ay] of Object.values(DIRS)) {
        const r = this.rockAt(nx + ax, ny + ay);
        if (r && r.warn <= 0) { this.closeCd = 8; this.score += 5; this.stats.closeCalls++; ev.push({ type: 'close', x: nx, y: ny, pts: 5 }); break; }
      }
    }

    if (eatB) {
      this.combo = this.comboT <= this.comboWin || this.fever > 0 ? Math.min(7, this.combo + 1) : 0;
      if (this.combo === 7 && this.fever === 0) { this.fever = 45; this.stats.fevers++; ev.push({ type: 'fever' }); }
      const pts = 10 * this.mult * (this.fever > 0 ? 2 : 1);
      this.score += pts; this.eaten++; this.stats.berries++;
      this.stats.maxCombo = Math.max(this.stats.maxCombo, this.mult);
      ev.push({ type: 'eat', x: nx, y: ny, pts, mult: this.mult });
      if (this.target && this.eaten >= this.target) { this.won = true; this.alive = false; ev.push({ type: 'clear' }); return ev; }
      this.spawnBerry();
      if (this.mode === 'levels' && this.rocksOn && this.eaten % 3 === 0 && this.rocks.length < 10) {
        const r = this.spawnRock();
        if (r) ev.push({ type: 'rock', x: r.x, y: r.y });
      }
      if (this.mode !== 'zen' && this.mode !== 'demo' && this.mode !== 'levels') {
        const lvl = 1 + Math.floor(this.eaten / 6);
        if (lvl > this.level) {
          this.level = lvl; this.stats.maxLevel = lvl;
          ev.push({ type: 'level', level: lvl });
          if (this.rocksOn && lvl >= 3) {
            const n = lvl >= 7 ? 2 : 1;
            for (let i = 0; i < n && this.rocks.length < 18; i++) {
              const r = this.spawnRock();
              if (r) ev.push({ type: 'rock', x: r.x, y: r.y });
            }
          }
        }
      }
      if (!this.golden && (this.eaten % 7 === 0 || this.rng() < 0.07)) { this.spawnGolden(); if (this.golden) ev.push({ type: 'goldenSpawn' }); }
      if (!this.power && this.mode !== 'demo' && this.eaten % 9 === 4) { this.spawnPower(); if (this.power) ev.push({ type: 'powerSpawn', kind: this.power.kind }); }
    }
    if (eatG) {
      this.grow += 1;
      const pts = 50 * this.mult * (this.fever > 0 ? 2 : 1);
      this.score += pts; this.stats.goldens++;
      ev.push({ type: 'golden', x: nx, y: ny, pts });
      this.golden = null;
    }
    if (this.power && this.power.x === nx && this.power.y === ny) {
      const k = this.power.kind;
      this.fx[k] = k === 'slow' ? 32 : 45;
      this.stats.powers++; this.score += 25;
      ev.push({ type: 'power', kind: k, x: nx, y: ny, pts: 25 });
      this.power = null;
    }
    if (this.golden && --this.golden.ttl <= 0) { this.golden = null; ev.push({ type: 'expire' }); }
    if (this.power && --this.power.ttl <= 0) { this.power = null; ev.push({ type: 'expire' }); }
    for (const r of this.rocks) {
      if (r.warn <= 0) continue;
      if (r.warn === 1 && this.snakeAt(r.x, r.y)) continue; // wait until the snake has moved off
      if (--r.warn === 0) ev.push({ type: 'rockLand', x: r.x, y: r.y });
    }
    if (this.fx.magnet > 0) { this.pull('berry'); this.pull('golden'); }
    return ev;
  }

  pull(key) {
    const o = this[key], h = this.head;
    if (!o) return;
    const d = this.dist(h, o);
    if (d > 6 || d <= 1) return;
    let dx = h.x - o.x, dy = h.y - o.y;
    if (this.wrap) {
      if (Math.abs(dx) > GRID / 2) dx = -Math.sign(dx);
      if (Math.abs(dy) > GRID / 2) dy = -Math.sign(dy);
    }
    const opts = Math.abs(dx) >= Math.abs(dy) ? [[Math.sign(dx), 0], [0, Math.sign(dy)]] : [[0, Math.sign(dy)], [Math.sign(dx), 0]];
    for (const [sx, sy] of opts) {
      if (!sx && !sy) continue;
      let x = o.x + sx, y = o.y + sy;
      if (this.wrap) { x = (x + GRID) % GRID; y = (y + GRID) % GRID; }
      if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
      if (this.wallAt(x, y) || this.portalAt(x, y) || this.snakeAt(x, y) || this.rockAt(x, y) || this.itemAt(x, y)) continue;
      o.x = x; o.y = y; return;
    }
  }

  die(cause, ev) {
    this.alive = false; this.cause = cause;
    ev.push({ type: 'die', cause });
    return ev;
  }
}

// Attract-mode driver for the menu background: greedy toward food, avoids small pockets.
export function autopilot(g) {
  const h = g.head, target = g.golden || g.berry;
  let best = null, bestScore = -Infinity;
  for (const d of Object.keys(DIRS)) {
    if (d === OPP[g.dir]) continue;
    const [dx, dy] = DIRS[d];
    let x = h.x + dx, y = h.y + dy;
    if (g.wrap) { x = (x + GRID) % GRID; y = (y + GRID) % GRID; }
    else if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
    if (g.blocked(x, y)) continue;
    const space = g.flood(x, y, 60);
    let s = space < g.snake.length + 4 ? -500 + space : 0;
    if (target) s -= g.dist({ x, y }, target) * 2;
    s += g.rng() * 0.5;
    if (s > bestScore) { bestScore = s; best = d; }
  }
  if (best) g.queue = [best];
}
