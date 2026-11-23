// Draws a 1080×1350 score card (4:5, which works for Instagram, TikTok, X, WhatsApp and
// Facebook) and returns it as a PNG blob for sharing or saving.
import { skinColor } from './config.js';

const W = 1080, H = 1350;
const C = { night: '#0f1428', surface: '#1a2142', line: '#2c3561', text: '#eef0ff', muted: '#9aa3cf', coral: '#ff7a59', rose: '#ff5d8f', gold: '#ffc94a', mint: '#7af0cf', berry: '#e8375f', ink: '#0e1328' };
const DISPLAY = 'Fredoka, "Nunito", system-ui, sans-serif';
const BODY = 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif';

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function spaced(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }

async function fontsReady() {
  try {
    await Promise.race([
      Promise.all(['700 200px Fredoka', '600 48px Fredoka', '600 36px Figtree', '700 30px Figtree'].map(f => document.fonts.load(f))),
      new Promise(r => setTimeout(r, 1500)),
    ]);
  } catch (e) {}
}

function drawSnake(ctx, skin, time) {
  const pts = [];
  for (let x = 120; x <= 860; x += 12) pts.push([x, 1000 + Math.sin(x / 85) * 46]);
  ctx.lineCap = 'round';
  for (let i = 0; i < pts.length - 1; i++) {
    const t = 1 - i / (pts.length - 1);                       // tail → head
    ctx.strokeStyle = skinColor(skin, t, time);
    ctx.lineWidth = 34 + 26 * (1 - t);
    ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
  }
  const [hx, hy] = pts[pts.length - 1];
  ctx.save();
  ctx.shadowColor = skinColor(skin, 0, time); ctx.shadowBlur = 40;
  ctx.fillStyle = skinColor(skin, 0, time); ctx.beginPath(); ctx.arc(hx, hy, 40, 0, 7); ctx.fill();
  ctx.restore();
  for (const s of [-1, 1]) {
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx + 10, hy + s * 15, 11, 0, 7); ctx.fill();
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(hx + 14, hy + s * 15, 6, 0, 7); ctx.fill();
  }
  // a berry just ahead of the snake, and a golden plum further on
  const bx = 950, by = 1000;
  ctx.save(); ctx.shadowColor = C.berry; ctx.shadowBlur = 36;
  const g = ctx.createRadialGradient(bx - 10, by - 10, 4, bx, by, 32); g.addColorStop(0, '#ff9b7a'); g.addColorStop(1, C.berry);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, 30, 0, 7); ctx.fill(); ctx.restore();
  ctx.fillStyle = C.mint; ctx.beginPath(); ctx.ellipse(bx + 12, by - 30, 15, 7, -0.6, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.beginPath(); ctx.arc(bx - 10, by - 10, 6, 0, 7); ctx.fill();
}

export async function makeShareCard(d) {
  await fontsReady();
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const time = 900;

  // background
  ctx.fillStyle = C.night; ctx.fillRect(0, 0, W, H);
  for (const [x, y, r, col] of [[120, 120, 620, 'rgba(255,93,143,.22)'], [1000, 380, 560, 'rgba(108,184,255,.16)'], [560, 1300, 700, 'rgba(255,201,74,.12)']]) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col); g.addColorStop(1, 'rgba(15,20,40,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  ctx.fillStyle = 'rgba(255,255,255,.045)';
  for (let y = 30; y < H; y += 54) for (let x = 30; x < W; x += 54) { ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill(); }

  // header: logo + wordmark, version on the right
  ctx.save(); ctx.translate(80, 76); ctx.scale(2.6, 2.6);
  const lg = ctx.createLinearGradient(0, 0, 32, 32); lg.addColorStop(0, '#ffb36b'); lg.addColorStop(1, C.rose);
  ctx.strokeStyle = lg; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.stroke(new Path2D('M8 22c-3-5-1-13 7-14s10 6 8 10-7 4-8 1 2-5 4-3'));
  ctx.fillStyle = '#ff7a8c'; ctx.beginPath(); ctx.arc(25, 25, 3, 0, 7); ctx.fill();
  ctx.restore();
  ctx.fillStyle = C.text; ctx.font = `700 64px ${DISPLAY}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText('Coil Rush', 190, 118);

  // mode pill
  ctx.font = `700 30px ${BODY}`; spaced(ctx, 3);
  const label = d.modeLabel.toUpperCase(), pw = ctx.measureText(label).width + 64;
  rrect(ctx, (W - pw) / 2, 228, pw, 64, 32); ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fill();
  ctx.strokeStyle = d.accent || C.coral; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = d.accent || C.coral; ctx.textAlign = 'center'; ctx.fillText(label, W / 2, 262);
  spaced(ctx, 0);

  // big score
  const scoreText = d.score.toLocaleString();
  let size = 230; ctx.font = `700 ${size}px ${DISPLAY}`;
  while (ctx.measureText(scoreText).width > W - 160 && size > 100) { size -= 10; ctx.font = `700 ${size}px ${DISPLAY}`; }
  const sg = ctx.createLinearGradient(200, 330, 880, 560); sg.addColorStop(0, C.gold); sg.addColorStop(.55, C.coral); sg.addColorStop(1, C.rose);
  ctx.save(); ctx.shadowColor = 'rgba(255,93,143,.45)'; ctx.shadowBlur = 50;
  ctx.fillStyle = sg; ctx.fillText(scoreText, W / 2, 440); ctx.restore();
  ctx.fillStyle = C.muted; ctx.font = `600 40px ${BODY}`; ctx.fillText(d.scoreLabel || 'points', W / 2, 580);

  // stars (levels) or headline
  let statsY = 660;
  if (d.stars != null) {
    for (let i = 0; i < 3; i++) {
      const cx = W / 2 + (i - 1) * 110, cy = 680, on = i < d.stars;
      ctx.save(); ctx.translate(cx, cy); ctx.beginPath();
      for (let k = 0; k < 10; k++) { const r = k % 2 ? 20 : 46, a = -Math.PI / 2 + k * Math.PI / 5; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      ctx.closePath(); ctx.fillStyle = on ? C.gold : 'rgba(255,255,255,.12)';
      if (on) { ctx.shadowColor = C.gold; ctx.shadowBlur = 30; }
      ctx.fill(); ctx.restore();
    }
    statsY = 760;
  }

  // stat cards
  const stats = d.stats.slice(0, 4), gap = 24, cw = (W - 160 - gap * (stats.length - 1)) / stats.length, ch = 150;
  stats.forEach(([k, v], i) => {
    const x = 80 + i * (cw + gap);
    rrect(ctx, x, statsY, cw, ch, 28); ctx.fillStyle = 'rgba(31,39,72,.88)'; ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = C.muted; ctx.font = `700 24px ${BODY}`; spaced(ctx, 2); ctx.fillText(k.toUpperCase(), x + cw / 2, statsY + 48); spaced(ctx, 0);
    ctx.fillStyle = C.text; ctx.font = `600 50px ${DISPLAY}`; ctx.fillText(String(v), x + cw / 2, statsY + 104);
  });

  // the player's snake, in their skin
  if (d.stars == null) drawSnake(ctx, d.skin, time);
  else { ctx.save(); ctx.translate(0, 40); drawSnake(ctx, d.skin, time); ctx.restore(); }

  // player row
  const py = 1150;
  if (d.player) {
    const hue = [...d.player].reduce((h, ch2) => (h * 31 + ch2.charCodeAt(0)) % 360, 7);
    ctx.fillStyle = `hsl(${hue} 70% 62%)`; ctx.beginPath(); ctx.arc(120, py, 40, 0, 7); ctx.fill();
    ctx.fillStyle = C.ink; ctx.font = `700 32px ${BODY}`; ctx.textAlign = 'center'; ctx.fillText(d.player.slice(0, 2).toUpperCase(), 120, py + 2);
    ctx.textAlign = 'left'; ctx.fillStyle = C.text; ctx.font = `600 44px ${DISPLAY}`; ctx.fillText(d.player, 182, py - 4);
    let nx = 182 + ctx.measureText(d.player).width + 18;
    if (d.badge) {
      ctx.font = `800 22px ${BODY}`; spaced(ctx, 2);
      const bw = ctx.measureText(d.badge).width + 26;
      rrect(ctx, nx, py - 24, bw, 40, 10);
      const bg = ctx.createLinearGradient(nx, 0, nx + bw, 0); bg.addColorStop(0, C.gold); bg.addColorStop(1, C.coral);
      ctx.fillStyle = bg; ctx.fill(); ctx.fillStyle = C.ink; ctx.fillText(d.badge, nx + 13, py - 3); spaced(ctx, 0);
    }
    ctx.fillStyle = C.muted; ctx.font = `500 28px ${BODY}`; ctx.fillText(d.playerSub || '', 182, py + 40);
  }

  // footer call to action
  ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(80, 1222); ctx.lineTo(W - 80, 1222); ctx.stroke();
  ctx.textAlign = 'left'; ctx.fillStyle = C.text; ctx.font = `700 46px ${DISPLAY}`; ctx.fillText(d.cta || 'Can you beat me?', 80, 1282);
  if (d.url) {
    ctx.textAlign = 'right'; ctx.fillStyle = C.mint; ctx.font = `600 30px ${BODY}`;
    let u = d.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    while (ctx.measureText(u).width > 520 && u.length > 12) u = u.slice(0, -2);
    ctx.fillText(u, W - 80, 1284);
  }

  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  return { canvas: cv, blob };
}
