// Central tuning values, all pulled from game_design_spec.md sections 2, 4, 5.
// ARENA is the full world/map size — much bigger than one screen on purpose
// (see VIEWPORT) so players have room to maneuver and can't see the
// opponent's spawn from their own. The camera follows the local player
// (see ArenaScene/NetArenaScene _setupCamera()).
export const ARENA = {
  WIDTH: 2400,
  HEIGHT: 1500,
};

// The visible game canvas — deliberately smaller than ARENA. This is what
// Phaser's game config width/height and the camera viewport actually use;
// ARENA is the scrollable world within it.
export const VIEWPORT = {
  WIDTH: 960,
  HEIGHT: 640,
};

// How far the void (ring-out death zone) extends beyond the playable floor.
export const RING_OUT_MARGIN = 130;
export const FLOOR_CORNER_CUT = 170; // octagon chamfer size, see ArenaScene._buildArenaFloor

// Symmetric random layout generation (obstacles + ring-out pits) — see
// src/config/layoutGenerator.js (and server/layoutGenerator.js, its
// hand-kept-in-sync CommonJS twin). Every match gets a fresh point-symmetric
// arrangement so neither spawn has an inherent positional advantage.
export const LAYOUT = {
  OBSTACLE_PAIR_COUNT: 3, // -> 6 obstacles total
  PIT_PAIR_COUNT: 2, // -> 4 pits total
  QUICKSAND_PAIR_COUNT: 3, // -> 6 quicksand patches total
  OBSTACLE_MIN_W: 32,
  OBSTACLE_MAX_W: 46,
  OBSTACLE_MIN_H: 90,
  OBSTACLE_MAX_H: 170,
  MIN_SPACING: 160, // between any two placed hazards' centers
  SPAWN_CLEARANCE: 260, // keep clear of both player spawn points
  CORNER_CLEARANCE: 40, // extra margin around the octagon's chamfered corners
  PLACEMENT_ATTEMPTS: 40,
};

// 낙사 구멍 (ring-out pit): an irregular, organic-looking sinkhole — NOT a
// mechanical trapdoor. Permanent for the whole match, generated once as
// part of the symmetric layout, same as obstacles. Always lethal; a Q dash
// still passes safely over it (see ArenaScene._checkHazardDeaths /
// ArenaRoom.checkPitDeaths).
export const PIT = {
  W: 130,
  H: 110,
};

// 모래늪지 (quicksand): a non-lethal slow zone. Permanent for the whole
// match, generated once (several patches, symmetric) as part of the layout
// rather than appearing/vanishing on a timer.
export const QUICKSAND = {
  W: 130,
  H: 105,
};

export const SLOW_ZONE_FACTOR = 0.3; // quicksand: -70% movement speed while inside

export const RESPAWN_DELAY_MS = 1500;

// How long the WIN/LOSE/DRAW banner holds before both combatants reset for
// the next round.
export const ROUND_BANNER_MS = 1800;

// Multiplayer-only (server-authoritative) match flow constants — see
// server/rooms/ArenaRoom.js. The 3-2-1-FIGHT! countdown is split into 4
// equal buckets of this total, mirroring the single-player countdown's feel
// but driven by a single server timer (room.state.phaseTimer) instead of
// separate client-side timers per combatant.
export const NET_COUNTDOWN_MS = 3000;
export const NET_MAX_PLAYERS = 4; // 4-player FFA — see server/rooms/ArenaRoom.js

// FFA spawn points as arena-fraction coordinates (multiply by ARENA.WIDTH/
// HEIGHT for world coords) — a diamond arrangement where each opposite pair
// (0&1, 2&3) is already 180°-symmetric about the arena center, so the
// point-symmetric hazard layout (layoutGenerator.js) stays fair for all
// four seats without needing a different placement algorithm.
export const NET_SPAWN_POINTS = [
  { x: 0.25, y: 0.5 },
  { x: 0.75, y: 0.5 },
  { x: 0.5, y: 0.2 },
  { x: 0.5, y: 0.8 },
];

export const PLAYER = {
  RADIUS: 18,
  BASE_SPEED: 240, // px/s while IDLE/MOVE
  CHARGE_SPEED_FACTOR: 0.05, // Q charging: -95% move speed
};

export const GLOBAL_COOLDOWN_MS = 750;
export const STUN_DURATION_MS = 2000;

// Failure penalties (per skill, on top of the baseline global cooldown):
export const WALL_STUN_MS = 400; // Q crashing into a wall mid-dash
export const FAILED_PARRY_GCD_MULTIPLIER = 1.6; // W timing out with no counter

// Per-class Q/W/E tuning — Stage 1 of the multi-class work only has the one
// existing class ("swordsman"), with its values unchanged from before this
// table existed. Every skill-logic read site (Combatant.js, PredictedSelf.js,
// NetFighter.js, NetArenaScene.js) looks these up via classSkills(classId)
// instead of the bare Q_DASH/W_PARRY/E_KICK exports below, which now just
// alias this table's one entry so nothing else has to change in this pass.
// Mirrored by hand in server/constants.js (CommonJS, same shape).
export const CLASSES = {
  swordsman: {
    id: "swordsman",
    // skillTypes tells shared FSM code (Combatant.js) which *shape* of
    // skill logic to run for Q/W/E, so it can branch on skill shape instead
    // of classId strings — see the "knight" entry below for the first class
    // with different shapes.
    skillTypes: { q: "chargeDash", w: "tapParry", e: "kickCone" },
    // Per-class look, independent of skillTypes — headShape lets each class
    // read as visually distinct at a glance (see Combatant._drawFigure).
    // "circle" is the default/original look.
    visual: { headShape: "circle" },
    qDash: {
      MAX_CHARGE_MS: 1200, // charge cap
      MIN_DISTANCE: 140,
      MAX_DISTANCE: 520,
      SPEED: 1500, // px/s while dashing (distance / speed = dash duration)
    },
    wParry: {
      DURATION_MS: 500,
    },
    eKick: {
      RANGE: 70,
      HALF_ANGLE_DEG: 60, // total cone = 120 deg
      STUN_MS: STUN_DURATION_MS,
      KNOCKBACK_DISTANCE: 90,
      KNOCKBACK_SPEED: 900,
      ACTIVE_MS: 120, // how long the kick hitbox is active (startup->active window)
      TOTAL_MS: 260, // total animation lock before returning to IDLE/GCD
    },
  },
  // Stage 2a (single-player only so far — see src/CLAUDE.md's note on
  // mirroring server-side once this is ported to multiplayer): 기사/Knight.
  // Q is a short combo dash (knockback, not instakill) with a follow-up
  // swing window; W is a HELD guard (not a tap) that empowers the next Q
  // into an instakill on a successful block; E is a shield charge that
  // stuns instead of just knocking back if it lands on a W-active target.
  knight: {
    id: "knight",
    skillTypes: { q: "comboDash", w: "heldGuard", e: "shieldCharge" },
    visual: { headShape: "square" }, // reads as a helmet, distinct from swordsman's bare head
    qDash: {
      // No hold-to-charge — a single tap fires a fixed-distance dash (see
      // Combatant._startComboDash). Unlike the swordsman's Q, this one is
      // never hold-and-release. A pending empowered-Q buff (see
      // empoweredQBuff below) redirects this tap to empoweredStrike instead.
      DISTANCE: 200,
      SPEED: 1300,
      LETHAL: false,
      PIERCE: false,
      KNOCKBACK_DISTANCE: 110,
      KNOCKBACK_SPEED: 950,
    },
    // Empowered Q (consumed by a successful W block): a stationary wide
    // straight-line AOE in front of the Knight — not a dash, doesn't move
    // the character. See Combatant._startEmpoweredStrike/_checkEmpoweredStrike.
    empoweredStrike: {
      LENGTH: 340, // reach along the facing direction
      WIDTH: 110, // full width of the line
      ACTIVE_MS: 90, // hit window — brief, since it's a burst, not a sweep
      TOTAL_MS: 300, // total animation lock before GCD
    },
    wParry: {
      HOLD: true, // held-while-key-down, not a fixed-duration tap
      MAX_HOLD_MS: 4000, // ceiling so a raised shield can't be held forever
      MOVE_SPEED_MULTIPLIER: 0.35, // -65% move speed while the shield is up
    },
    eShieldCharge: {
      DISTANCE: 220,
      SPEED: 1100,
      KNOCKBACK_DISTANCE: 130,
      KNOCKBACK_SPEED: 1000,
      // landing on a W-active (guarding) target: still beats it, same
      // triangle edge as the swordsman's kick-beats-parry.
      VS_GUARD_KNOCKBACK_DISTANCE: 220,
      VS_GUARD_KNOCKBACK_SPEED: 1400,
      VS_GUARD_STUN_MS: STUN_DURATION_MS,
    },
    comboWindow: {
      WINDOW_MS: 550, // time after a landed Q hit to press Q/W/E for a follow-up
    },
    comboAttack: {
      RANGE: 80,
      HALF_ANGLE_DEG: 55,
      ACTIVE_MS: 110,
      TOTAL_MS: 240,
      KNOCKBACK_DISTANCE: 130,
      KNOCKBACK_SPEED: 1000,
    },
    empoweredQBuff: {
      DURATION_MS: 6000, // expires silently if unused — no infinite banking
    },
  },
};
export const DEFAULT_CLASS_ID = "swordsman";
export function classSkills(classId) {
  return CLASSES[classId] || CLASSES[DEFAULT_CLASS_ID];
}

export const Q_DASH = CLASSES.swordsman.qDash;
export const W_PARRY = CLASSES.swordsman.wParry;
export const E_KICK = CLASSES.swordsman.eKick;

export const STATES = {
  IDLE: "IDLE",
  CHARGING: "CHARGING",
  DASH: "DASH",
  PARRYING: "PARRYING",
  KICKING: "KICKING",
  STUNNED: "STUNNED",
  GCD: "GCD", // global cooldown lockout, movement allowed, skills blocked
  DEAD: "DEAD",
  // Stage 2a (Knight, single-player only) additions:
  SHIELD_CHARGE: "SHIELD_CHARGE", // Knight's E
  COMBO_WINDOW: "COMBO_WINDOW", // waiting for a Q/W/E follow-up after a landed Knight Q hit
  COMBO_ATTACK: "COMBO_ATTACK", // the follow-up hammer swing itself
  EMPOWERED_STRIKE: "EMPOWERED_STRIKE", // Knight's empowered Q — stationary wide line-AOE, not a dash
};
