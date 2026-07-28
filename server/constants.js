// Server-authoritative copy of the tuning values in
// ../src/config/constants.js. Phase 3 merge: the server is now also
// authoritative for arena hazards (ring-out, obstacle walls, quicksand),
// matching the single-player ArenaScene.
// Keep these numbers in sync with the client's constants.js by hand; there's
// no shared module between the CommonJS server and the client's ES modules.
module.exports = {
  ARENA_WIDTH: 2400,
  ARENA_HEIGHT: 1500,

  PLAYER_RADIUS: 18,
  BASE_SPEED: 240,
  CHARGE_SPEED_FACTOR: 0.05,

  GLOBAL_COOLDOWN_MS: 750,
  STUN_DURATION_MS: 2000,
  FAILED_PARRY_GCD_MULTIPLIER: 1.6,
  RESPAWN_DELAY_MS: 1500,

  Q_DASH: {
    MAX_CHARGE_MS: 1200,
    MIN_DISTANCE: 140,
    MAX_DISTANCE: 520,
    SPEED: 1500,
  },

  W_PARRY: {
    DURATION_MS: 500,
  },

  E_KICK: {
    RANGE: 70,
    HALF_ANGLE_DEG: 60,
    STUN_MS: 2000,
    KNOCKBACK_DISTANCE: 90,
    KNOCKBACK_SPEED: 900,
    ACTIVE_MS: 120,
    TOTAL_MS: 260,
  },

  STATES: {
    IDLE: "IDLE",
    CHARGING: "CHARGING",
    DASH: "DASH",
    PARRYING: "PARRYING",
    KICKING: "KICKING",
    STUNNED: "STUNNED",
    GCD: "GCD",
    DEAD: "DEAD",
  },

  // Arena hazards — mirrors the client's constants.js. Wall stop + wall-stun
  // on Q dash, octagon ring-out boundary, and pits/quicksand are all judged
  // here. Obstacles, pits, AND quicksand are all permanent for the match and
  // generated once as part of the symmetric layout — see layoutGenerator.js.
  RING_OUT_MARGIN: 130,
  FLOOR_CORNER_CUT: 170,
  WALL_STUN_MS: 400,

  LAYOUT: {
    OBSTACLE_PAIR_COUNT: 3,
    PIT_PAIR_COUNT: 2,
    QUICKSAND_PAIR_COUNT: 3,
    OBSTACLE_MIN_W: 32,
    OBSTACLE_MAX_W: 46,
    OBSTACLE_MIN_H: 90,
    OBSTACLE_MAX_H: 170,
    MIN_SPACING: 160,
    SPAWN_CLEARANCE: 260,
    CORNER_CLEARANCE: 40,
    PLACEMENT_ATTEMPTS: 40,
  },

  PIT: {
    W: 130,
    H: 110,
  },

  QUICKSAND: {
    W: 130,
    H: 105,
  },
  SLOW_ZONE_FACTOR: 0.3,

  SIMULATION_INTERVAL_MS: 16, // ~60Hz authoritative tick

  // Server-authoritative match flow (ROUND/DEATHMATCH modes, 3-2-1-FIGHT!
  // countdown, round-end freeze) — mirrors the single-player ArenaScene's
  // client-only version, but coordinated centrally since all players must
  // see the same countdown/round-end freeze at the same time.
  NET_COUNTDOWN_MS: 3000,
  ROUND_BANNER_MS: 1800,

  // DEATHMATCH is currently the primary FFA mode: 1 point per kill, first
  // to DEATHMATCH_WIN_SCORE wins the whole match — see ArenaRoom's
  // _onPlayerDied()/tick()'s "matchEnd" phase.
  DEATHMATCH_WIN_SCORE: 20,
  MATCH_END_BANNER_MS: 4000,

  // 4-player FFA (no lobby/ready-check UI): once 2+ players are in, a join
  // grace window opens — every new joiner (up to MAX_PLAYERS) resets it —
  // so people trickling in over a few seconds still get folded into the
  // same match instead of each needing to be the 4th to ever start a game.
  MAX_PLAYERS: 4,
  JOIN_GRACE_MS: 5000,

  // The room's real socket cap, well above MAX_PLAYERS — once the 4 active
  // seats are full (or a client explicitly asks to spectate), further
  // joiners are read-only spectators (no PlayerState, no input applied)
  // instead of Colyseus spinning up a second room. See ArenaRoom.onJoin().
  MAX_CLIENTS: 16,

  // Grace window for an unexpected disconnect (dropped wifi, mobile screen
  // lock, etc.) to reconnect and reclaim the same seat/schema entry before
  // the player is actually removed from the match — see ArenaRoom.onLeave().
  RECONNECT_GRACE_SEC: 20,

  // FFA spawn points as arena-fraction coordinates — mirrors the client's
  // NET_SPAWN_POINTS exactly (a diamond arrangement where each opposite
  // pair is already 180°-symmetric about the arena center, matching the
  // point-symmetric hazard layout in layoutGenerator.js).
  NET_SPAWN_POINTS: [
    { x: 0.25, y: 0.5 },
    { x: 0.75, y: 0.5 },
    { x: 0.5, y: 0.2 },
    { x: 0.5, y: 0.8 },
  ],
};
