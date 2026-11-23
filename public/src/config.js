export const VERSION = '0.5.0';

// Static game content: skins and their unlock levels, power-up metadata.
export const SKINS = [
  { id: 'ember',  name: 'Ember',      unlock: 1,  stops: ['#ffb36b', '#ff5d8f'] },
  { id: 'lagoon', name: 'Lagoon',     unlock: 2,  stops: ['#7af0cf', '#4f8dff'] },
  { id: 'grape',  name: 'Grape Soda', unlock: 3,  stops: ['#c6a2ff', '#ff5fa8'] },
  { id: 'citrus', name: 'Citrus',     unlock: 5,  stops: ['#fff07a', '#ff7a3d'] },
  { id: 'aurora', name: 'Aurora',     unlock: 8,  aurora: true, stops: ['#7af0cf', '#c6a2ff', '#ff8fb0'] },
  { id: 'frost',  name: 'Frost',      unlock: 12, stops: ['#ffffff', '#9fb4ff'], sparkle: true },
  // Coil Rush Plus exclusives (only shown when the paywall is switched on)
  { id: 'midnight', name: 'Midnight', unlock: 1, plus: true, stops: ['#7cc4ff', '#5b5bff', '#b84dff'], sparkle: true },
  { id: 'molten',   name: 'Molten',   unlock: 1, plus: true, stops: ['#fff3a0', '#ff9a1f', '#e0204a'] },
  { id: 'prism',    name: 'Prism',    unlock: 1, plus: true, aurora: true, stops: ['#ff6b8a', '#ffd36b', '#6bffb0', '#6bc8ff', '#c46bff'] },
];

export const POWER_INFO = {
  ghost:  { name: 'Ghost',  color: '#7af0cf', desc: 'Pass through your tail and rocks' },
  slow:   { name: 'Slow-mo', color: '#6cb8ff', desc: 'Time slows down' },
  magnet: { name: 'Magnet', color: '#c6a2ff', desc: 'Food drifts toward you' },
};

export const MODES = {
  endless: { name: 'Endless', ranked: true },
  daily:   { name: 'Daily Run', ranked: true },
  levels:  { name: 'Levels', ranked: false },
  zen:     { name: 'Zen', ranked: false },
};

export function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Colour along the skin's gradient. t: 0 = head, 1 = tail.
export function skinColor(skin, t, time) {
  let stops = skin.stops;
  if (skin.aurora) t = (t + time / 2400) % 1;
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}
