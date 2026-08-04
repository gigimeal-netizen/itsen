// Server-authoritative copy of the tuning values in
// ../src/config/constants.js. Phase 3 merge: the server is now also
// authoritative for arena hazards (ring-out, obstacle walls, quicksand),
// matching the single-player ArenaScene.
// Keep these numbers in sync with the client's constants.js by hand; there's
// no shared module between the CommonJS server and the client's ES modules.
const STUN_DURATION_MS = 2000;

// Per-class Q/W/E tuning — Stage 1 of the multi-class work only has the one
// existing class ("swordsman"), with its values unchanged from before this
// table existed. Every skill-logic read site (ArenaRoom, and the client's
// PredictedSelf.js/NetFighter.js) looks these up via classSkills(classId)
// instead of the bare Q_DASH/W_PARRY/E_KICK exports below, which now just
// alias this table's one entry so nothing else has to change in this pass.
const CLASSES = {
  swordsman: {
    id: "swordsman",
    // skillTypes tells ArenaRoom.js which *shape* of skill logic to run for
    // Q/W/E, so it can branch on skill shape instead of classId strings —
    // see the "knight" entry below for the first class with different shapes.
    skillTypes: { q: "chargeDash", w: "tapParry", e: "kickCone" },
    qDash: {
      MAX_CHARGE_MS: 1200,
      MIN_DISTANCE: 140,
      MAX_DISTANCE: 520,
      SPEED: 1500,
    },
    wParry: {
      DURATION_MS: 500,
    },
    eKick: {
      RANGE: 70,
      HALF_ANGLE_DEG: 60,
      STUN_MS: STUN_DURATION_MS,
      KNOCKBACK_DISTANCE: 90,
      KNOCKBACK_SPEED: 900,
      ACTIVE_MS: 120,
      TOTAL_MS: 260,
    },
  },
  // 기사/Knight — mirrors src/config/constants.js's CLASSES.knight exactly.
  // Q is a tap (not hold) fixed-distance dash, knockback not instakill,
  // opening a brief COMBO_WINDOW for a Q/W/E follow-up on landing (whiff or
  // hit alike, unless it killed via an empowered strike). W is HELD (not
  // tapped), still mobile at -65% speed, and a successful block grants an
  // empoweredQBuff that redirects the next Q tap into a stationary
  // instakill line-AOE (EMPOWERED_STRIKE) instead of a dash. E is a short
  // shield charge that beats a raised guard for bonus knockback+stun.
  knight: {
    id: "knight",
    skillTypes: { q: "comboDash", w: "heldGuard", e: "shieldCharge" },
    qDash: {
      DISTANCE: 200,
      SPEED: 1300,
      LETHAL: false,
      PIERCE: false,
      KNOCKBACK_DISTANCE: 110,
      KNOCKBACK_SPEED: 950,
    },
    empoweredStrike: {
      LENGTH: 340,
      WIDTH: 110,
      ACTIVE_MS: 90,
      TOTAL_MS: 300,
    },
    wParry: {
      MAX_HOLD_MS: 4000,
      MOVE_SPEED_MULTIPLIER: 0.35,
    },
    eShieldCharge: {
      DISTANCE: 220,
      SPEED: 1100,
      KNOCKBACK_DISTANCE: 130,
      KNOCKBACK_SPEED: 1000,
      VS_GUARD_KNOCKBACK_DISTANCE: 220,
      VS_GUARD_KNOCKBACK_SPEED: 1400,
      VS_GUARD_STUN_MS: STUN_DURATION_MS,
    },
    comboWindow: {
      WINDOW_MS: 550,
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
      DURATION_MS: 6000,
    },
  },
  // 전사/Warrior — mirrors src/config/constants.js's CLASSES.warrior exactly.
  // Q is an instant 360-degree hit around self (no travel/charge, instakill).
  // W is a 0.5s self-invincibility window (see isInvincible) followed by a
  // delayed one-shot AOE "shout" that disables Q/W/E on anyone it hits for a
  // second. E is a hold-to-charge diving slam — longer charge means a
  // further leap and a bigger landing-impact radius — that beats a raised
  // guard AND an active invincibility outright (stuns instead of countering
  // the attacker, unlike every other class's W-interaction so far).
  warrior: {
    id: "warrior",
    skillTypes: { q: "axeSwing", w: "battleCry", e: "divingSlam" },
    axeSwing: {
      RADIUS: 45,
      ACTIVE_MS: 90,
      TOTAL_MS: 260,
    },
    battleCry: {
      DURATION_MS: 500, // self-invincibility window — first phase
      DISABLE_DELAY_MS: 1000, // gap AFTER invincibility ends before the shout fires
      SHOUT_RADIUS: 40,
      DISABLE_MS: 1000, // how long an affected target can't use Q/W/E
      ACTIVE_MS: 60, // shout burst window — sits at the END of TOTAL_MS, not the start
      TOTAL_MS: 1500, // DURATION_MS + DISABLE_DELAY_MS
    },
    divingSlam: {
      MAX_CHARGE_MS: 1100,
      MIN_LEAP_DISTANCE: 0,
      MAX_LEAP_DISTANCE: 380,
      MIN_IMPACT_RADIUS: 35,
      MAX_IMPACT_RADIUS: 75,
      LEAP_SPEED: 1400,
      KNOCKBACK_DISTANCE: 140,
      KNOCKBACK_SPEED: 1100,
      VS_GUARD_STUN_MS: STUN_DURATION_MS,
      ACTIVE_MS: 90,
      TOTAL_MS: 280,
    },
  },
  // 법사/Mage — mirrors src/config/constants.js's CLASSES.mage exactly. Q is
  // a hold-to-charge laser that does nothing on an early release (must reach
  // MIN_CHARGE_MS to fire at all, then keeps scaling up to MAX_CHARGE_MS). W
  // is 0.5s unconditional invincibility (same isInvincible guard as
  // Warrior's battle cry) immediately followed by a 1s move-speed haste
  // window. E is an instant wide 180-degree cone: a plain hit slows the
  // target, but hitting a raised guard or an invincible target freezes them
  // instead, beating W outright like every other E. A successful W block or
  // E freeze grants fastCharge, dropping Q's charge threshold way down.
  mage: {
    id: "mage",
    skillTypes: { q: "laserBeam", w: "fluidState", e: "blizzard" },
    laserBeam: {
      MIN_CHARGE_MS: 1400,
      MAX_CHARGE_MS: 2400,
      MIN_LENGTH: 260,
      MAX_LENGTH: 620,
      MIN_WIDTH: 18,
      MAX_WIDTH: 46,
      ACTIVE_MS: 140,
      TOTAL_MS: 220,
    },
    fluidState: {
      DURATION_MS: 500,
      HASTE_MS: 1000,
      HASTE_MULTIPLIER: 1.6,
      TOTAL_MS: 1500,
    },
    blizzard: {
      RANGE: 120, // doubled from the original tuned-down 60 (was 25% of 240)
      HALF_ANGLE_DEG: 90,
      SLOW_MS: 1000,
      VS_GUARD_STUN_MS: STUN_DURATION_MS,
      ACTIVE_MS: 110,
      TOTAL_MS: 260,
    },
    fastCharge: {
      DURATION_MS: 6000,
      CHARGE_MS: 100,
    },
  },
};
const DEFAULT_CLASS_ID = "swordsman";
function classSkills(classId) {
  return CLASSES[classId] || CLASSES[DEFAULT_CLASS_ID];
}

module.exports = {
  ARENA_WIDTH: 2400,
  ARENA_HEIGHT: 1500,

  PLAYER_RADIUS: 18,
  BASE_SPEED: 240,
  CHARGE_SPEED_FACTOR: 0.05,

  GLOBAL_COOLDOWN_MS: 750,
  STUN_DURATION_MS,
  FAILED_PARRY_GCD_MULTIPLIER: 1.6,
  RESPAWN_DELAY_MS: 1500,
  // How long after being knocked back a player's death still counts as a
  // kill for whoever pushed them (ring-out/pit only need this — a direct
  // skill-kill like Q already knows its own killer with no window needed).
  KNOCKBACK_ATTRIBUTION_MS: 3000,

  CLASSES,
  DEFAULT_CLASS_ID,
  classSkills,
  Q_DASH: CLASSES.swordsman.qDash,
  W_PARRY: CLASSES.swordsman.wParry,
  E_KICK: CLASSES.swordsman.eKick,

  STATES: {
    IDLE: "IDLE",
    CHARGING: "CHARGING",
    DASH: "DASH",
    PARRYING: "PARRYING",
    KICKING: "KICKING",
    STUNNED: "STUNNED",
    GCD: "GCD",
    DEAD: "DEAD",
    // Knight additions — mirrors src/config/constants.js's STATES.
    SHIELD_CHARGE: "SHIELD_CHARGE",
    COMBO_WINDOW: "COMBO_WINDOW",
    COMBO_ATTACK: "COMBO_ATTACK",
    EMPOWERED_STRIKE: "EMPOWERED_STRIKE",
    // Warrior additions.
    AXE_SWING: "AXE_SWING",
    BATTLE_CRY: "BATTLE_CRY",
    SLAM_CHARGE: "SLAM_CHARGE",
    SLAMMING: "SLAMMING",
    SLAM_IMPACT: "SLAM_IMPACT",
    // Mage additions.
    LASER_CHARGE: "LASER_CHARGE",
    LASER_FIRE: "LASER_FIRE",
    FLUID: "FLUID",
    BLIZZARD: "BLIZZARD",
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
    // Sized against adjacent-spawn spacing (~283px on the 10-point ring,
    // down from the old 4-point diamond's ~750px) — left at the old 260,
    // adjacent spawns' clearance circles would overlap heavily and starve
    // the hazard placer (tryPlacePair() soft-fails on exhausted attempts).
    SPAWN_CLEARANCE: 150,
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
  SLOW_DEBUFF_FACTOR: 0.5, // Mage's blizzard (E): -50% movement speed while slowed

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

  // 10-player FFA (no lobby/ready-check UI): once 2+ players are in, a join
  // grace window opens — every new joiner (up to MAX_PLAYERS) resets it —
  // so people trickling in over a few seconds still get folded into the
  // same match instead of each needing to be the 10th to ever start a game.
  MAX_PLAYERS: 10,
  JOIN_GRACE_MS: 5000,

  // Solo auto-fill: if a room stays at exactly 1 real player for this long
  // with nobody else joining, ArenaRoom.spawnBot() adds one AI opponent so
  // the match starts anyway (see ArenaRoom.js's botSpawnMs/spawnBot()) —
  // server-only, no client-side equivalent needed.
  BOT_SPAWN_DELAY_MS: 8000,

  // The room's real socket cap, well above MAX_PLAYERS — once the 10 active
  // seats are full (or a client explicitly asks to spectate), further
  // joiners are read-only spectators (no PlayerState, no input applied)
  // instead of Colyseus spinning up a second room. See ArenaRoom.onJoin().
  MAX_CLIENTS: 24,

  // Grace window for an unexpected disconnect (dropped wifi, mobile screen
  // lock, etc.) to reconnect and reclaim the same seat/schema entry before
  // the player is actually removed from the match — see ArenaRoom.onLeave().
  RECONNECT_GRACE_SEC: 20,

  // FFA spawn points as arena-fraction coordinates — mirrors the client's
  // NET_SPAWN_POINTS exactly. A 10-point ring around the arena center, each
  // point's antipodal partner (i and i+5) exactly 180°-symmetric about the
  // center, so the point-symmetric hazard layout (layoutGenerator.js) stays
  // fair for every seat without needing a different placement algorithm.
  NET_SPAWN_POINTS: [
    { x: 0.800, y: 0.500 },
    { x: 0.743, y: 0.665 },
    { x: 0.593, y: 0.766 },
    { x: 0.407, y: 0.766 },
    { x: 0.257, y: 0.665 },
    { x: 0.200, y: 0.500 },
    { x: 0.257, y: 0.335 },
    { x: 0.407, y: 0.234 },
    { x: 0.593, y: 0.234 },
    { x: 0.743, y: 0.335 },
  ],
};
