// Generated audio: no files. Two buses (sfx, music) into a compressor.
// Music is a 4-bar loop (Am - F - C - G) sequenced in 16ths. Its mood follows the game:
// menu = soft pads + arpeggio, play = + bass and drums (tempo rises with speed),
// fever = brighter and busier, paused / over = muffled and quiet.
let ctx = null, master, comp, sfxBus, musicBus, musicTone, noise;
let sfxOn = true, musicOn = true;
let timer = null, step = 0, nextTime = 0;
let mood = 'menu', bpm = 96;
let musicLevel = 0.7, sfxLevel = 0.8;   // 0..1, set from the volume sliders

const MUSIC_VOL = 0.48;
const musicGain = () => MUSIC_VOL * musicLevel * musicLevel; // squared: sliders feel even

export function setVolumes(music, effects) {
  musicLevel = Math.max(0, Math.min(1, music));
  sfxLevel = Math.max(0, Math.min(1, effects));
  if (!ctx) return;
  sfxBus.gain.setTargetAtTime(0.75 * sfxLevel * sfxLevel, ctx.currentTime, 0.05);
  if (timer) musicBus.gain.setTargetAtTime(musicGain() * (mood === 'paused' || mood === 'over' ? 0.55 : 1), ctx.currentTime, 0.08);
}
const midi = n => 440 * Math.pow(2, (n - 69) / 12);

export const setSound = v => { sfxOn = v; };
export function setMusic(v) {
  musicOn = v;
  if (!ctx) return;
  if (v) startMusic(); else stopMusic();
}

export function unlockAudio() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master = ctx.createGain(); master.gain.value = 0.8;
    master.connect(comp).connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.75 * sfxLevel * sfxLevel; sfxBus.connect(master);
    musicTone = ctx.createBiquadFilter(); musicTone.type = 'lowpass'; musicTone.frequency.value = 9000;
    musicBus = ctx.createGain(); musicBus.gain.value = 0;
    musicBus.connect(musicTone).connect(master);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (musicOn) startMusic();
}

export function suspendAudio(on) {
  if (!ctx) return;
  if (on) ctx.suspend().catch(() => {}); else ctx.resume().catch(() => {});
}

// ---------- voices ----------
function tone(freq, { t = 0, at = null, dur = 0.15, type = 'triangle', vol = 0.2, slide = 0, attack = 0.008, bus = 'sfx', detune = 0, cutoff = 0, q = 1 } = {}) {
  if (!ctx) return;
  if (bus === 'sfx' && !sfxOn) return;
  const now = at ?? ctx.currentTime + t;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, now); o.detune.value = detune;
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), now + dur);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(vol, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  let node = o;
  if (cutoff) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = q; node.connect(f); node = f; }
  node.connect(g).connect(bus === 'sfx' ? sfxBus : musicBus);
  o.start(now); o.stop(now + dur + 0.05);
}

function hiss({ t = 0, at = null, dur = 0.1, vol = 0.2, type = 'highpass', freq = 6000, q = 0.8, bus = 'sfx', sweep = 0 } = {}) {
  if (!ctx || (bus === 'sfx' && !sfxOn)) return;
  const now = at ?? ctx.currentTime + t;
  const s = ctx.createBufferSource(); s.buffer = noise;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, now); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, now + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  s.connect(f).connect(g).connect(bus === 'sfx' ? sfxBus : musicBus);
  s.start(now, Math.random() * 0.5); s.stop(now + dur + 0.02);
}

// ---------- sound effects ----------
const PENTA = [0, 2, 4, 7, 9];
export const sfx = {
  eat(mult) {
    const i = Math.min(mult - 1, 11), n = 69 + PENTA[i % 5] + 12 * Math.floor(i / 5);
    tone(midi(n), { dur: 0.16, vol: 0.22 });
    tone(midi(n + 12), { t: 0.025, dur: 0.1, type: 'sine', vol: 0.09 });
    hiss({ dur: 0.03, vol: 0.05, freq: 5000 });
  },
  golden() {
    [76, 79, 83, 88, 91].forEach((n, i) => tone(midi(n), { t: i * 0.05, dur: 0.24, vol: 0.14 }));
    tone(midi(100), { t: 0.25, dur: 0.4, type: 'sine', vol: 0.05 });
  },
  goldenSpawn: () => { tone(midi(88), { dur: 0.25, type: 'sine', vol: 0.07 }); tone(midi(95), { t: 0.09, dur: 0.3, type: 'sine', vol: 0.05 }); },
  power() {
    tone(220, { dur: 0.35, type: 'sawtooth', vol: 0.05, slide: 4, cutoff: 2500 });
    [84, 88, 91].forEach((n, i) => tone(midi(n), { t: 0.1 + i * 0.05, dur: 0.22, vol: 0.1 }));
    hiss({ dur: 0.35, vol: 0.06, type: 'bandpass', freq: 1200, sweep: 6 });
  },
  powerSpawn: () => tone(midi(81), { dur: 0.12, type: 'square', vol: 0.04, cutoff: 2000 }),
  fxEnd: () => tone(midi(76), { dur: 0.3, type: 'triangle', vol: 0.08, slide: 0.5 }),
  phase: () => hiss({ dur: 0.18, vol: 0.06, type: 'bandpass', freq: 3000, sweep: 0.3, q: 3 }),
  level() {
    [67, 71, 74, 79].forEach((n, i) => tone(midi(n), { t: i * 0.05, dur: 0.34, type: 'sine', vol: 0.12 }));
    hiss({ t: 0.0, dur: 0.4, vol: 0.04, type: 'highpass', freq: 3000, sweep: 3 });
  },
  lost: () => tone(midi(62), { dur: 0.16, type: 'sine', vol: 0.07, slide: 0.7 }),
  rock: () => { tone(midi(43), { dur: 0.14, type: 'square', vol: 0.035, cutoff: 900 }); tone(midi(43), { t: 0.18, dur: 0.14, type: 'square', vol: 0.03, cutoff: 900 }); },
  rockLand: () => { tone(90, { dur: 0.22, type: 'sine', vol: 0.18, slide: 0.5 }); hiss({ dur: 0.12, vol: 0.08, type: 'lowpass', freq: 900 }); },
  close: () => { tone(midi(93), { dur: 0.07, type: 'sine', vol: 0.06 }); tone(midi(98), { t: 0.05, dur: 0.09, type: 'sine', vol: 0.06 }); },
  grace: () => tone(110, { dur: 0.12, type: 'sine', vol: 0.12, slide: 0.8 }),
  fever() {
    hiss({ dur: 0.7, vol: 0.08, type: 'bandpass', freq: 400, sweep: 12, q: 2 });
    [69, 73, 76, 81, 85, 88].forEach((n, i) => tone(midi(n), { t: 0.08 + i * 0.045, dur: 0.3, vol: 0.1, type: 'square', cutoff: 3500 }));
  },
  feverEnd: () => [81, 76, 72].forEach((n, i) => tone(midi(n), { t: i * 0.07, dur: 0.2, type: 'sine', vol: 0.07 })),
  die() {
    tone(240, { dur: 0.6, type: 'sawtooth', vol: 0.1, slide: 0.25, cutoff: 1800 });
    tone(120, { t: 0.05, dur: 0.7, type: 'square', vol: 0.04, slide: 0.3, cutoff: 900 });
    hiss({ dur: 0.5, vol: 0.12, type: 'lowpass', freq: 1500, sweep: 0.2 });
  },
  mission: () => [72, 76, 79, 84, 88].forEach((n, i) => tone(midi(n), { t: i * 0.07, dur: 0.28, vol: 0.12 })),
  portal() {
    tone(320, { dur: 0.28, type: 'sine', vol: 0.12, slide: 3.2 });
    hiss({ dur: 0.25, vol: 0.06, type: 'bandpass', freq: 600, sweep: 8, q: 4 });
  },
  clear() {
    [72, 76, 79, 84].forEach((n, i) => tone(midi(n), { t: i * 0.09, dur: 0.3, vol: 0.13 }));
    [84, 88, 91, 96].forEach((n, i) => tone(midi(n), { t: 0.4 + i * 0.06, dur: 0.5, type: 'sine', vol: 0.08 }));
  },
  star: (i = 0) => { tone(midi(88 + i * 4), { dur: 0.3, vol: 0.12 }); tone(midi(100 + i * 4), { t: 0.03, dur: 0.25, type: 'sine', vol: 0.05 }); },
  click: () => tone(midi(84), { dur: 0.05, type: 'sine', vol: 0.05 }),
  pause: () => tone(midi(76), { dur: 0.12, type: 'sine', vol: 0.07, slide: 0.75 }),
  resume: () => tone(midi(72), { dur: 0.12, type: 'sine', vol: 0.07, slide: 1.33 }),
  tick: () => tone(midi(69), { dur: 0.09, type: 'sine', vol: 0.07 }),
  go: () => { tone(midi(81), { dur: 0.22, type: 'sine', vol: 0.1 }); tone(midi(88), { t: 0.02, dur: 0.22, type: 'sine', vol: 0.05 }); },
};

// ---------- music ----------
// [root (MIDI), third offset] per bar: Am, F, C, G
const BARS = [[45, 3], [41, 4], [48, 4], [43, 4]];
const ARP = [0, 2, 1, 2, 0, 3, 1, 2, 0, 2, 1, 3, 2, 1, 0, 2];

export function setMood(next, level = 1) {
  mood = next;
  bpm = next === 'menu' ? 96 : next === 'fever' ? Math.min(150, 112 + level * 3 + 8) : Math.min(144, 104 + level * 3);
  if (!ctx) return;
  const now = ctx.currentTime;
  const muffled = next === 'paused' || next === 'over';
  musicTone.frequency.setTargetAtTime(muffled ? 700 : next === 'menu' ? 5000 : 12000, now, 0.12);
  if (musicOn) musicBus.gain.setTargetAtTime(musicGain() * (muffled ? 0.55 : 1), now, 0.15);
}

function startMusic() {
  if (!ctx || timer) return;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setTargetAtTime(musicGain() * (mood === 'paused' || mood === 'over' ? 0.55 : 1), ctx.currentTime, 0.4);
  nextTime = ctx.currentTime + 0.06; step = 0;
  timer = setInterval(schedule, 25);
}
function stopMusic() {
  if (!ctx) return;
  musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
  clearInterval(timer); timer = null;
}
function schedule() {
  if (ctx.state !== 'running') return;
  if (nextTime < ctx.currentTime - 0.2) nextTime = ctx.currentTime + 0.02; // recover after a stall
  while (nextTime < ctx.currentTime + 0.12) {
    playStep(step, nextTime);
    nextTime += 60 / bpm / 4;
    step = (step + 1) % 64;
  }
}

function playStep(s, t) {
  const [root, third] = BARS[Math.floor(s / 16)], st = s % 16, sixteenth = 60 / bpm / 4;
  const chord = [root, root + third, root + 7, root + 12];
  const playing = mood === 'play' || mood === 'fever', fever = mood === 'fever';
  const opt = { at: t, bus: 'music' };

  // pad: soft detuned saws, one per bar
  if (st === 0) {
    for (const n of [chord[0] + 12, chord[1] + 12, chord[2] + 12]) {
      for (const dt of [-7, 7]) tone(midi(n), { ...opt, dur: sixteenth * 16, type: 'sawtooth', vol: 0.022, attack: 0.35, detune: dt, cutoff: fever ? 2200 : 1100 });
    }
  }
  // arpeggio
  const arpEvery = playing ? 1 : 2;
  if (st % arpEvery === 0) {
    const n = chord[ARP[st]] + (fever && st % 4 === 3 ? 36 : 24);
    tone(midi(n), { ...opt, dur: sixteenth * 1.6, type: fever ? 'square' : 'triangle', vol: playing ? 0.045 : 0.035, cutoff: fever ? 4200 : 2600 });
  }
  if (!playing) return;
  // bass
  if ([0, 3, 6, 8, 11, 14].includes(st)) {
    const n = st === 8 || st === 14 ? root + 12 : root;
    tone(midi(n), { ...opt, dur: sixteenth * 1.8, type: 'triangle', vol: 0.16, cutoff: 700 });
  }
  // drums
  if (st % 8 === 0 || (fever && st % 4 === 0)) {
    tone(150, { ...opt, dur: 0.26, type: 'sine', vol: 0.5, slide: 0.3, attack: 0.002 });
  }
  if (st === 4 || st === 12) {
    hiss({ ...opt, dur: 0.14, vol: 0.12, type: 'bandpass', freq: 1800, q: 0.7 });
    tone(190, { ...opt, dur: 0.08, type: 'triangle', vol: 0.06 });
  }
  if (st % 2 === 0 || fever) hiss({ ...opt, dur: st % 4 === 2 ? 0.06 : 0.03, vol: st % 4 === 2 ? 0.05 : 0.025, type: 'highpass', freq: 7500 });
}
