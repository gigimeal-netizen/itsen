const C = require("./constants");

// CommonJS twin of ../src/config/layoutGenerator.js — keep the algorithm
// identical by hand (server can't import the client's ES module directly).
// Generates a fresh, point-symmetric arrangement of obstacles, pits, and
// quicksand once per room, kept clear of all NET_SPAWN_POINTS (4-player FFA)
// so no spawn gets an inherent positional edge.
function generateSymmetricLayout() {
  const f = {
    x: C.RING_OUT_MARGIN,
    y: C.RING_OUT_MARGIN,
    w: C.ARENA_WIDTH - C.RING_OUT_MARGIN * 2,
    h: C.ARENA_HEIGHT - C.RING_OUT_MARGIN * 2,
  };
  const spawns = C.NET_SPAWN_POINTS.map((s) => ({ x: C.ARENA_WIDTH * s.x, y: C.ARENA_HEIGHT * s.y }));
  const corners = [
    [f.x, f.y],
    [f.x + f.w, f.y],
    [f.x, f.y + f.h],
    [f.x + f.w, f.y + f.h],
  ];
  const L = C.LAYOUT;

  const placed = [];

  function farEnoughFromSpawnsAndPlaced(x, y, r) {
    for (const sp of spawns) {
      if (Math.hypot(x - sp.x, y - sp.y) < L.SPAWN_CLEARANCE + r) return false;
    }
    for (const p of placed) {
      if (Math.hypot(x - p.x, y - p.y) < L.MIN_SPACING + r + p.r) return false;
    }
    return true;
  }

  function insideFloor(x, y, halfW, halfH) {
    if (x - halfW < f.x + 20 || x + halfW > f.x + f.w - 20) return false;
    if (y - halfH < f.y + 20 || y + halfH > f.y + f.h - 20) return false;
    for (const [cx, cy] of corners) {
      if (Math.hypot(x - cx, y - cy) < C.FLOOR_CORNER_CUT + L.CORNER_CLEARANCE) return false;
    }
    return true;
  }

  function tryPlacePair(w, h) {
    const halfW = w / 2;
    const halfH = h / 2;
    const r = Math.max(halfW, halfH);
    for (let attempt = 0; attempt < L.PLACEMENT_ATTEMPTS; attempt++) {
      const x = f.x + halfW + 20 + Math.random() * (f.w - w - 40);
      const y = f.y + halfH + 20 + Math.random() * (f.h - h - 40);
      const mx = C.ARENA_WIDTH - x;
      const my = C.ARENA_HEIGHT - y;

      if (!insideFloor(x, y, halfW, halfH)) continue;
      if (!insideFloor(mx, my, halfW, halfH)) continue;
      if (!farEnoughFromSpawnsAndPlaced(x, y, r)) continue;
      if (!farEnoughFromSpawnsAndPlaced(mx, my, r)) continue;
      if (Math.hypot(x - mx, y - my) < r * 2 + 60) continue;

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
  for (let i = 0; i < L.OBSTACLE_PAIR_COUNT; i++) {
    const w = L.OBSTACLE_MIN_W + Math.random() * (L.OBSTACLE_MAX_W - L.OBSTACLE_MIN_W);
    const h = L.OBSTACLE_MIN_H + Math.random() * (L.OBSTACLE_MAX_H - L.OBSTACLE_MIN_H);
    const pair = tryPlacePair(w, h);
    if (pair) obstacles.push(...pair);
  }

  const pits = [];
  for (let i = 0; i < L.PIT_PAIR_COUNT; i++) {
    const pair = tryPlacePair(C.PIT.W, C.PIT.H);
    if (pair) pits.push(...pair);
  }

  const quicksand = [];
  for (let i = 0; i < L.QUICKSAND_PAIR_COUNT; i++) {
    const pair = tryPlacePair(C.QUICKSAND.W, C.QUICKSAND.H);
    if (pair) quicksand.push(...pair);
  }

  return { obstacles, pits, quicksand };
}

module.exports = { generateSymmetricLayout };
