import { ARENA, RING_OUT_MARGIN, FLOOR_CORNER_CUT, LAYOUT, PIT, QUICKSAND, NET_SPAWN_POINTS } from "./constants.js";

// Generates a fresh, point-symmetric (180°-rotated about the arena center)
// arrangement of obstacles, ring-out pits, and quicksand patches every time
// it's called — used once per match so neither player/spawn gets an
// inherent positional edge. All three are permanent for the whole match.
// Pure JS (no Phaser dependency) so the server's CommonJS twin
// (server/layoutGenerator.js) can mirror the exact same algorithm.
export function generateSymmetricLayout() {
  const f = {
    x: RING_OUT_MARGIN,
    y: RING_OUT_MARGIN,
    w: ARENA.WIDTH - RING_OUT_MARGIN * 2,
    h: ARENA.HEIGHT - RING_OUT_MARGIN * 2,
  };
  const spawns = NET_SPAWN_POINTS.map((s) => ({ x: ARENA.WIDTH * s.x, y: ARENA.HEIGHT * s.y }));
  const corners = [
    [f.x, f.y],
    [f.x + f.w, f.y],
    [f.x, f.y + f.h],
    [f.x + f.w, f.y + f.h],
  ];

  const placed = []; // { x, y, r }

  function farEnoughFromSpawnsAndPlaced(x, y, r) {
    for (const sp of spawns) {
      if (Math.hypot(x - sp.x, y - sp.y) < LAYOUT.SPAWN_CLEARANCE + r) return false;
    }
    for (const p of placed) {
      if (Math.hypot(x - p.x, y - p.y) < LAYOUT.MIN_SPACING + r + p.r) return false;
    }
    return true;
  }

  function insideFloor(x, y, halfW, halfH) {
    if (x - halfW < f.x + 20 || x + halfW > f.x + f.w - 20) return false;
    if (y - halfH < f.y + 20 || y + halfH > f.y + f.h - 20) return false;
    for (const [cx, cy] of corners) {
      if (Math.hypot(x - cx, y - cy) < FLOOR_CORNER_CUT + LAYOUT.CORNER_CLEARANCE) return false;
    }
    return true;
  }

  function tryPlacePair(w, h) {
    const halfW = w / 2;
    const halfH = h / 2;
    const r = Math.max(halfW, halfH);
    for (let attempt = 0; attempt < LAYOUT.PLACEMENT_ATTEMPTS; attempt++) {
      const x = f.x + halfW + 20 + Math.random() * (f.w - w - 40);
      const y = f.y + halfH + 20 + Math.random() * (f.h - h - 40);
      const mx = ARENA.WIDTH - x;
      const my = ARENA.HEIGHT - y;

      if (!insideFloor(x, y, halfW, halfH)) continue;
      if (!insideFloor(mx, my, halfW, halfH)) continue;
      if (!farEnoughFromSpawnsAndPlaced(x, y, r)) continue;
      if (!farEnoughFromSpawnsAndPlaced(mx, my, r)) continue;
      if (Math.hypot(x - mx, y - my) < r * 2 + 60) continue; // don't let a pair collide with its own mirror

      placed.push({ x, y, r });
      placed.push({ x: mx, y: my, r });
      return [
        { x, y, w, h },
        { x: mx, y: my, w, h },
      ];
    }
    return null;
  }

  const obstacles = [];
  for (let i = 0; i < LAYOUT.OBSTACLE_PAIR_COUNT; i++) {
    const w = LAYOUT.OBSTACLE_MIN_W + Math.random() * (LAYOUT.OBSTACLE_MAX_W - LAYOUT.OBSTACLE_MIN_W);
    const h = LAYOUT.OBSTACLE_MIN_H + Math.random() * (LAYOUT.OBSTACLE_MAX_H - LAYOUT.OBSTACLE_MIN_H);
    const pair = tryPlacePair(w, h);
    if (pair) obstacles.push(...pair);
  }

  const pits = [];
  for (let i = 0; i < LAYOUT.PIT_PAIR_COUNT; i++) {
    const pair = tryPlacePair(PIT.W, PIT.H);
    if (pair) pits.push(...pair);
  }

  const quicksand = [];
  for (let i = 0; i < LAYOUT.QUICKSAND_PAIR_COUNT; i++) {
    const pair = tryPlacePair(QUICKSAND.W, QUICKSAND.H);
    if (pair) quicksand.push(...pair);
  }

  return { obstacles, pits, quicksand };
}
