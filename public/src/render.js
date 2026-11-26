// Canvas renderer: smooth interpolated snake, glowing food, particles, floating score text.
import { GRID, DIRS } from './game.js';
import { skinColor, POWER_INFO } from './config.js';

// Older iOS Safari (< 16) and Android WebViews have no ctx.roundRect; without it the first
// rock drawn throws every frame and the game freezes. Polyfill the subset we use.
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.max(0, Math.min(typeof r === 'number' ? r : 0, w / 2, h / 2));
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}

const C = {
  cellA: '#141a33', cellB: '#171e3b', rock: '#343e70', rockHi: '#4a5694',
  berryA: '#ff9b7a', berryB: '#e8375f', leaf: '#7af0cf', gold: '#ffc94a', goldHi: '#fff3b0',
  warn: '#ff7a59', ink: '#0e1328', white: '#ffffff', tongue: '#ff5d8f',
};

export class Renderer {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.parts = []; this.floats = []; this.shake = 0; this.flash = 0; this.gulp = 0;
    this.size = 0; this.dpr = 1; this.cs = 1; this.bg = null; this.lowFx = false;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = this.lowFx ? 1 : Math.min(2, window.devicePixelRatio || 1), s = Math.max(60, Math.round(r.width));
    if (s === this.size && dpr === this.dpr) return;
    this.size = s; this.dpr = dpr; this.cs = s / GRID;
    this.c.width = Math.round(s * dpr); this.c.height = Math.round(s * dpr);
    this.bg = null;
  }

  buildBg() {
    const b = document.createElement('canvas'); b.width = this.c.width; b.height = this.c.height;
    const x = b.getContext('2d'); x.scale(this.dpr, this.dpr);
    const cs = this.cs;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      x.fillStyle = (i + j) % 2 ? C.cellB : C.cellA;
      x.fillRect(i * cs, j * cs, cs + 0.5, cs + 0.5);
    }
    this.bg = b;
  }

  center(x, y) { return [(x + 0.5) * this.cs, (y + 0.5) * this.cs]; }

  setLowFx(on) { if (this.lowFx === on) return; this.lowFx = on; this.size = 0; this.resize(); }

  burst(x, y, color, n = 14, speed = 1) {
    if (this.lowFx) n = Math.ceil(n / 2);
    const [cx, cy] = this.center(x, y);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = (0.04 + Math.random() * 0.12) * this.cs * speed;
      this.parts.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 0.0012 + Math.random() * 0.0016, r: this.cs * (0.06 + Math.random() * 0.1), color });
    }
  }
  float(x, y, text, color) { const [cx, cy] = this.center(x, y); this.floats.push({ x: cx, y: cy, text, color, life: 1 }); }
  explode(snake, skin, time) {
    snake.forEach((c, i) => this.burst(c.x, c.y, skinColor(skin, i / Math.max(1, snake.length - 1), time), 5, 1.6));
    this.shake = 1; this.flash = 0.55;
  }

  draw(g, alpha, skin, time, dt, { hideSnake = false } = {}) {
    const { ctx, cs } = this;
    if (!this.bg) this.buildBg();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.c.width, this.c.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.shake > 0) {
      const m = this.shake * cs * 0.35;
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      this.shake = Math.max(0, this.shake - dt / 450);
    }
    ctx.drawImage(this.bg, 0, 0, this.size, this.size);

    if (g.wrap) {
      ctx.save(); ctx.setLineDash([cs * 0.3, cs * 0.3]); ctx.strokeStyle = 'rgba(122,240,207,.25)'; ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, this.size - 2, this.size - 2); ctx.restore();
    }
    if (g.fever > 0) {
      ctx.save();
      const hue = (time / 6) % 360;
      ctx.strokeStyle = `hsla(${hue}, 95%, 65%, ${0.55 + 0.3 * Math.sin(time / 90)})`;
      ctx.lineWidth = cs * 0.22; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = this.lowFx ? 0 : cs;
      ctx.strokeRect(0, 0, this.size, this.size);
      ctx.restore();
    }
        if (g.fx.slow > 0) { ctx.fillStyle = 'rgba(108,184,255,.07)'; ctx.fillRect(0, 0, this.size, this.size); }

    if (g.walls.size) this.walls(g);
    g.portals.forEach((pair, i) => pair.forEach(p => this.portal(p.x, p.y, i, time)));
    for (const r of g.rocks) this.rock(r, time);
    if (g.berry) this.berry(g.berry.x, g.berry.y, time);
    if (g.golden) this.golden(g.golden, time);
    if (g.power) this.power(g.power, time);
    if (!hideSnake) this.snake(g, alpha, skin, time);

    // particles
    for (const p of this.parts) {
      p.x += p.vx * dt / 16; p.y += p.vy * dt / 16; p.vx *= 0.96; p.vy *= 0.96; p.life -= p.decay * dt;
      if (p.life <= 0) continue;
      ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.5 + p.life * 0.5), 0, 7); ctx.fill();
    }
    this.parts = this.parts.filter(p => p.life > 0);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      f.life -= dt / 900; f.y -= dt * 0.03;
      if (f.life <= 0) continue;
      ctx.globalAlpha = Math.min(1, f.life * 1.6);
      ctx.font = `700 ${Math.round(cs * 0.62)}px Fredoka, system-ui, sans-serif`;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(14,19,40,.8)'; ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
    }
    this.floats = this.floats.filter(f => f.life > 0);
    ctx.globalAlpha = 1;
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,120,140,${this.flash * 0.5})`; ctx.fillRect(-20, -20, this.size + 40, this.size + 40);
      this.flash = Math.max(0, this.flash - dt / 600);
    }
    this.gulp = Math.max(0, this.gulp - dt / 220);
  }

  snake(g, alpha, skin, time) {
    const { ctx, cs } = this, n = g.snake.length, pts = [];
    for (let i = 0; i < n; i++) {
      const c = g.snake[i], p = g.prev[i] || c;
      let x = p.x + (c.x - p.x) * alpha, y = p.y + (c.y - p.y) * alpha;
      if (Math.abs(c.x - p.x) > 1 || Math.abs(c.y - p.y) > 1) { x = c.x; y = c.y; }
      pts.push([(x + 0.5) * cs, (y + 0.5) * cs]);
    }
    const ghost = g.fx.ghost > 0;
    ctx.save();
    if (ghost) ctx.globalAlpha = 0.45 + 0.15 * Math.sin(time / 90);
    ctx.lineCap = 'round';
    for (let i = n - 1; i >= 1; i--) {
      const a = pts[i], b = pts[i - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > cs * 1.5) continue;
      const t = i / Math.max(1, n - 1);
      ctx.strokeStyle = skinColor(skin, t, time);
      ctx.lineWidth = cs * (0.72 - 0.32 * t);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (skin.sparkle && i % 3 === 0) {
        const s = 0.5 + 0.5 * Math.sin(time / 160 + i);
        ctx.fillStyle = `rgba(255,255,255,${0.35 + s * 0.5})`;
        ctx.beginPath(); ctx.arc(a[0], a[1], cs * 0.07 * (1 + s), 0, 7); ctx.fill();
      }
    }
    // head
    const [hx, hy] = pts[0], [dx, dy] = DIRS[g.dir];
    const hr = cs * (0.44 + this.gulp * 0.12);
    ctx.shadowColor = skinColor(skin, 0, time); ctx.shadowBlur = this.lowFx ? 0 : cs * 0.7;
    ctx.fillStyle = skinColor(skin, 0, time);
    ctx.beginPath(); ctx.arc(hx, hy, hr, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    // tongue when food is close
    if (g.berry && g.dist(g.head, g.berry) <= 3 && Math.sin(time / 70) > 0) {
      ctx.strokeStyle = C.tongue; ctx.lineWidth = cs * 0.07;
      const tx = hx + dx * hr * 1.5, ty = hy + dy * hr * 1.5;
      ctx.beginPath(); ctx.moveTo(hx + dx * hr * 0.8, hy + dy * hr * 0.8); ctx.lineTo(tx, ty);
      ctx.lineTo(tx + (dx - dy) * cs * 0.12, ty + (dy + dx) * cs * 0.12);
      ctx.moveTo(tx, ty); ctx.lineTo(tx + (dx + dy) * cs * 0.12, ty + (dy - dx) * cs * 0.12); ctx.stroke();
    }
    // eyes
    const px = -dy, py = dx, blink = (time % 3200) < 120;
    let lx = 0, ly = 0;
    if (g.berry) { const [bx, by] = this.center(g.berry.x, g.berry.y); const d = Math.hypot(bx - hx, by - hy) || 1; lx = (bx - hx) / d; ly = (by - hy) / d; }
    for (const s of [-1, 1]) {
      const ex = hx + dx * cs * 0.12 + px * s * cs * 0.18, ey = hy + dy * cs * 0.12 + py * s * cs * 0.18;
      if (blink) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = cs * 0.06;
        ctx.beginPath(); ctx.moveTo(ex - px * cs * 0.08, ey - py * cs * 0.08); ctx.lineTo(ex + px * cs * 0.08, ey + py * cs * 0.08); ctx.stroke();
      } else {
        ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(ex, ey, cs * 0.12, 0, 7); ctx.fill();
        ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(ex + lx * cs * 0.045, ey + ly * cs * 0.045, cs * 0.06, 0, 7); ctx.fill();
      }
    }
    ctx.restore();
    if (g.fx.magnet > 0) {
      ctx.save(); ctx.strokeStyle = 'rgba(198,162,255,.35)'; ctx.setLineDash([cs * 0.2, cs * 0.25]); ctx.lineWidth = 2;
      ctx.lineDashOffset = -time / 30;
      ctx.beginPath(); ctx.arc(hx, hy, cs * (5.5 + Math.sin(time / 200) * 0.3), 0, 7); ctx.stroke(); ctx.restore();
    }
  }

  berry(x, y, time) {
    const { ctx, cs } = this;
    const [cx, cy0] = this.center(x, y), cy = cy0 + Math.sin(time / 260 + x) * cs * 0.04, r = cs * 0.3;
    ctx.save();
    ctx.shadowColor = C.berryB; ctx.shadowBlur = this.lowFx ? 0 : cs * 0.6;
    const gr = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    gr.addColorStop(0, C.berryA); gr.addColorStop(1, C.berryB);
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = C.leaf; ctx.beginPath();
    ctx.ellipse(cx + r * 0.35, cy - r * 0.95, r * 0.42, r * 0.2, -0.6, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.18, 0, 7); ctx.fill();
    ctx.restore();
  }

  golden(o, time) {
    const { ctx, cs } = this;
    const [cx, cy] = this.center(o.x, o.y), pulse = 1 + Math.sin(time / 140) * 0.06, r = cs * 0.33 * pulse;
    ctx.save();
    ctx.shadowColor = C.gold; ctx.shadowBlur = this.lowFx ? 0 : cs;
    const gr = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    gr.addColorStop(0, C.goldHi); gr.addColorStop(1, C.gold);
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.translate(cx, cy); ctx.rotate(time / 500); ctx.fillStyle = C.white;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4, rr = i % 2 ? r * 0.18 : r * 0.55; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    ctx.fill(); ctx.restore();
    this.ring(cx, cy, o.ttl / o.max, C.gold, time);
  }

  power(o, time) {
    const { ctx, cs } = this, info = POWER_INFO[o.kind];
    const [cx, cy] = this.center(o.x, o.y), r = cs * 0.36;
    ctx.save();
    ctx.shadowColor = info.color; ctx.shadowBlur = this.lowFx ? 0 : cs * 0.8;
    ctx.fillStyle = info.color; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = C.ink; ctx.strokeStyle = C.ink; ctx.lineWidth = cs * 0.07; ctx.lineCap = 'round';
    const s = r * 0.55;
    if (o.kind === 'ghost') {
      ctx.beginPath(); ctx.arc(cx, cy - s * 0.15, s * 0.7, Math.PI, 0);
      ctx.lineTo(cx + s * 0.7, cy + s * 0.6);
      for (let i = 0; i < 3; i++) ctx.lineTo(cx + s * 0.7 - (i + 0.5) * s * 0.466, cy + s * (i % 2 ? 0.6 : 0.3));
      ctx.lineTo(cx - s * 0.7, cy + s * 0.6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = info.color;
      ctx.beginPath(); ctx.arc(cx - s * 0.25, cy - s * 0.15, s * 0.14, 0, 7); ctx.arc(cx + s * 0.25, cy - s * 0.15, s * 0.14, 0, 7); ctx.fill();
    } else if (o.kind === 'slow') {
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.75, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - s * 0.5); ctx.moveTo(cx, cy); ctx.lineTo(cx + s * 0.35, cy + s * 0.1); ctx.stroke();
    } else {
      ctx.lineWidth = cs * 0.1;
      ctx.beginPath(); ctx.arc(cx, cy - s * 0.05, s * 0.5, Math.PI, 0, true); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s * 0.5, cy - s * 0.05); ctx.lineTo(cx - s * 0.5, cy - s * 0.55);
      ctx.moveTo(cx + s * 0.5, cy - s * 0.05); ctx.lineTo(cx + s * 0.5, cy - s * 0.55); ctx.stroke();
    }
    ctx.restore();
    if (o.ttl > 15 || Math.floor(time / 120) % 2) this.ring(cx, cy, o.ttl / o.max, info.color, time);
  }

  ring(cx, cy, f, color) {
    const { ctx, cs } = this;
    ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha = 0.7; ctx.lineWidth = Math.max(1.5, cs * 0.06); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, cs * 0.5, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke(); ctx.restore();
  }

  walls(g) {
    const { ctx, cs } = this;
    ctx.save();
    for (const k of g.walls) {
      const x = (k % GRID), y = Math.floor(k / GRID), px = x * cs, py = y * cs;
      ctx.fillStyle = '#29326a';
      ctx.fillRect(px, py, cs + 0.5, cs + 0.5);
      if (!g.walls.has(k - GRID) || y === 0) { ctx.fillStyle = '#4855a0'; ctx.fillRect(px, py, cs + 0.5, cs * 0.18); }
      if (!g.walls.has(k + GRID) || y === GRID - 1) { ctx.fillStyle = '#1b2250'; ctx.fillRect(px, py + cs * 0.84, cs + 0.5, cs * 0.16); }
    }
    ctx.restore();
  }

  portal(x, y, i, time) {
    const { ctx, cs } = this, [cx, cy] = this.center(x, y), color = i % 2 ? '#6cb8ff' : '#c6a2ff';
    ctx.save();
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, cs * 0.5);
    gr.addColorStop(0, color); gr.addColorStop(0.55, 'rgba(15,20,40,.9)'); gr.addColorStop(1, 'rgba(15,20,40,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, cs * 0.5, 0, 7); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = cs * 0.08; ctx.shadowColor = color; ctx.shadowBlur = this.lowFx ? 0 : cs * 0.6;
    ctx.setLineDash([cs * 0.22, cs * 0.14]); ctx.lineDashOffset = (i % 2 ? -1 : 1) * time / 25;
    ctx.beginPath(); ctx.arc(cx, cy, cs * 0.4, 0, 7); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = cs * 0.05;
    ctx.beginPath(); ctx.arc(cx, cy, cs * (0.16 + 0.05 * Math.sin(time / 180 + i)), 0, 7); ctx.stroke();
    ctx.restore();
  }

  rock(r, time) {
    const { ctx, cs } = this, x = r.x * cs, y = r.y * cs, p = cs * 0.08;
    ctx.save();
    if (r.warn > 0) {
      ctx.globalAlpha = 0.4 + 0.4 * Math.sin(time / 70);
      ctx.strokeStyle = C.warn; ctx.lineWidth = 2; ctx.setLineDash([cs * 0.15, cs * 0.12]);
      ctx.beginPath(); ctx.roundRect(x + p, y + p, cs - 2 * p, cs - 2 * p, cs * 0.22); ctx.stroke();
      ctx.fillStyle = C.warn; ctx.globalAlpha *= 0.25; ctx.fill();
    } else {
      ctx.fillStyle = C.rock; ctx.beginPath(); ctx.roundRect(x + p, y + p, cs - 2 * p, cs - 2 * p, cs * 0.22); ctx.fill();
      ctx.fillStyle = C.rockHi; ctx.beginPath(); ctx.roundRect(x + p * 2, y + p * 1.6, cs - 4 * p, cs * 0.22, cs * 0.1); ctx.fill();
    }
    ctx.restore();
  }
}
