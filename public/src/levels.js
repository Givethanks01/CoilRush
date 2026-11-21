// Levels mode: 15 hand-built grids, each harder than the last. Clear a level by eating
// `target` berries; that unlocks the next one. Walls kill; portals teleport the head to
// their twin; from level 15 rocks also drop. Speed is a ms-per-tick base that drops
// a little with every berry.
const G = 21;
const key = (x, y) => y * G + x;

function maze(fn) {
  const w = new Set();
  const m = {
    add: (x, y) => { if (x >= 0 && y >= 0 && x < G && y < G) w.add(key(x, y)); },
    h: (y, a, b, skip = []) => { for (let x = a; x <= b; x++) if (!skip.includes(x)) m.add(x, y); },
    v: (x, a, b, skip = []) => { for (let y = a; y <= b; y++) if (!skip.includes(y)) m.add(x, y); },
    border: (gaps = []) => { m.h(0, 0, 20, gaps); m.h(20, 0, 20, gaps); m.v(0, 0, 20, gaps); m.v(20, 0, 20, gaps); },
    block: (x, y, bw, bh) => { for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) m.add(x + i, y + j); },
  };
  fn(m);
  return [...w];
}
const P = (x, y) => ({ x, y });

export const LEVELS = [
  { name: 'Open Field', target: 8, speed: 150, start: { x: 8, y: 10, dir: 'right' },
    hint: 'Warm up. The edges are deadly.', walls: [] },
  { name: 'Fence', target: 10, speed: 145, start: { x: 8, y: 10, dir: 'right' },
    hint: 'A wall all the way round.', walls: maze(m => m.border()) },
  { name: 'Pillars', target: 10, speed: 140, start: { x: 8, y: 10, dir: 'right' },
    hint: 'Four pillars to weave between.', walls: maze(m => { m.border(); m.block(5, 5, 2, 2); m.block(14, 5, 2, 2); m.block(5, 14, 2, 2); m.block(14, 14, 2, 2); }) },
  { name: 'Tunnel', target: 12, speed: 135, wrap: true, start: { x: 5, y: 3, dir: 'right' },
    hint: 'Gaps in the wall lead to the other side.', walls: maze(m => { m.border([9, 10, 11]); m.block(8, 8, 5, 5); }) },
  { name: 'Crossroads', target: 12, speed: 132, start: { x: 5, y: 2, dir: 'right' },
    hint: 'Four arms, one open centre.', walls: maze(m => { m.border(); m.h(10, 3, 7); m.h(10, 13, 17); m.v(10, 3, 7); m.v(10, 13, 17); }) },
  { name: 'The Divide', target: 12, speed: 128, start: { x: 5, y: 5, dir: 'down' },
    hint: 'Your first portal. Dive in to cross the wall.', walls: maze(m => { m.border(); m.v(10, 1, 19); }),
    portals: [[P(5, 10), P(15, 10)]] },
  { name: 'Windmill', target: 13, speed: 124, start: { x: 10, y: 10, dir: 'right' },
    hint: 'Four blades spin around the middle.', walls: maze(m => { m.border(); m.h(5, 2, 8); m.v(15, 2, 8); m.h(15, 12, 18); m.v(5, 12, 18); }) },
  { name: 'Four Rooms', target: 14, speed: 120, start: { x: 4, y: 7, dir: 'right' },
    hint: 'Narrow doors between four rooms.', walls: maze(m => { m.border(); m.v(10, 1, 19, [4, 5, 15, 16]); m.h(10, 1, 19, [4, 5, 15, 16]); }) },
  { name: 'Spiral', target: 14, speed: 116, start: { x: 5, y: 2, dir: 'right' },
    hint: 'Rings inside rings. Food hides in the core.', walls: maze(m => {
      m.border(); m.h(4, 4, 16, [9, 10, 11]); m.h(16, 4, 16); m.v(4, 4, 16); m.v(16, 4, 16);
      m.h(8, 8, 12); m.h(12, 8, 12, [10]); m.v(8, 8, 12); m.v(12, 8, 12);
    }) },
  { name: 'Zigzag', target: 15, speed: 112, start: { x: 5, y: 2, dir: 'right' },
    hint: 'Long corridors that switch back and forth.', walls: maze(m => { m.border(); m.h(4, 1, 15); m.h(8, 5, 19); m.h(12, 1, 15); m.h(16, 5, 19); }) },
  { name: 'Portal Maze', target: 15, speed: 108, start: { x: 4, y: 10, dir: 'up' },
    hint: 'Three sealed halls. Only portals connect them.', walls: maze(m => { m.border(); m.v(7, 1, 19); m.v(13, 1, 19); }),
    portals: [[P(3, 3), P(10, 17)], [P(10, 3), P(17, 17)]] },
  { name: 'Fortress', target: 16, speed: 104, start: { x: 5, y: 2, dir: 'right' },
    hint: 'One gate per side, and a keep in the middle.', walls: maze(m => {
      m.border(); m.h(5, 5, 15, [10]); m.h(15, 5, 15, [10]); m.v(5, 5, 15, [10]); m.v(15, 5, 15, [10]); m.block(9, 9, 3, 3);
    }) },
  { name: 'Checkerboard', target: 17, speed: 98, start: { x: 5, y: 1, dir: 'right' },
    hint: 'Twenty-five posts. Plan every turn.', walls: maze(m => { m.border(); for (const y of [2, 6, 10, 14, 18]) for (const x of [2, 6, 10, 14, 18]) m.add(x, y); }) },
  { name: 'Labyrinth', target: 18, speed: 92, start: { x: 4, y: 2, dir: 'right' },
    hint: 'Switchbacks, plus a shortcut across the corners.', walls: maze(m => { m.border(); m.h(5, 1, 15); m.h(10, 5, 19); m.h(15, 1, 15); }),
    portals: [[P(18, 2), P(2, 18)]] },
  { name: 'The Gauntlet', target: 20, speed: 84, rocks: true, start: { x: 7, y: 3, dir: 'right' },
    hint: 'Everything at once. Rocks fall every 3 berries.', walls: maze(m => {
      m.border(); m.h(5, 1, 16); m.h(10, 4, 19); m.h(15, 1, 16);
      m.add(10, 2); m.add(4, 7); m.add(16, 12); m.add(10, 17);
    }),
    portals: [[P(2, 2), P(18, 18)], [P(18, 7), P(2, 12)]] },
].map((l, i) => ({ portals: [], rocks: false, wrap: false, ...l, n: i + 1 }));

// Stars: 1 for clearing, 2 and 3 for score thresholds (combos and golden plums get you there).
export function starsFor(level, score, cleared) {
  if (!cleared) return 0;
  if (score >= level.target * 35) return 3;
  if (score >= level.target * 20) return 2;
  return 1;
}
