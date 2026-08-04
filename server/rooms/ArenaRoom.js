const { Room } = require("@colyseus/core");
const { ArenaRoomState, PlayerState, RectState } = require("../schema/ArenaRoomState");
const { generateSymmetricLayout } = require("../layoutGenerator");
const C = require("../constants");

// Phase 3 merge: server-authoritative movement, the Q/W/E state machine,
// hit detection, AND arena hazards (obstacle walls, octagon ring-out,
// permanent pits/quicksand) — a server-side port of both Combatant.js and
// ArenaScene's hazard logic, minus Phaser/Arcade physics. 10-player FFA: no
// lobby/ready-check UI — see startCountdown()/JOIN_GRACE_MS below for how
// a match actually kicks off.
const SPAWN_POINTS = C.NET_SPAWN_POINTS.map((s) => ({
  x: C.ARENA_WIDTH * s.x,
  y: C.ARENA_HEIGHT * s.y,
}));

// Must match the swatch count in NetArenaScene's PLAYER_COLORS palette —
// a client-picked colorIndex outside this range is rejected in favor of a
// seat-based fallback (see onJoin() below).
const COLOR_COUNT = 10;
const DEFAULT_NICKNAME = "전사";

// Solo auto-fill bot (see spawnBot()/_stepBotAI()) — same class roster and
// AI-tick pacing as server/bot.js's own CLASS_IDS/PARRY_INTERVAL_MS/
// DASH_INTERVAL_MS/DASH_HOLD_MS/HELD_W_HOLD_MS constants, ported here to run
// directly in the room's own tick instead of over a socket.
const BOT_CLASS_IDS = ["swordsman", "knight", "warrior", "mage"];
const BOT_PARRY_INTERVAL_MS = 2200;
const BOT_DASH_INTERVAL_MS = 3600;
const BOT_DASH_HOLD_MS = 350;
const BOT_HELD_W_HOLD_MS = 500;

function sanitizeNickname(raw) {
  if (typeof raw !== "string") return DEFAULT_NICKNAME;
  const trimmed = raw.trim().slice(0, 12);
  return trimmed || DEFAULT_NICKNAME;
}

function sanitizeColorIndex(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < COLOR_COUNT ? n : fallback;
}

// Stage 1 of the multi-class work: only "swordsman" exists, so this always
// falls back to it — no client UI sends a classId option yet. Mirrors
// sanitizeColorIndex()'s shape so a future class-select screen slots in the
// same way the color picker did.
const CLASS_IDS = Object.keys(C.CLASSES);
function sanitizeClassId(raw, fallback) {
  return typeof raw === "string" && CLASS_IDS.includes(raw) ? raw : fallback;
}

// Two players picking the same nickname would make the scoreboard/kill-flash
// text ambiguous (e.g. "철수 5 · 철수 3") even though their color still tells
// them apart in-game — so a joiner whose nickname collides with someone
// already seated gets "#2", "#3", ... appended (trimming the base to make
// room, since PlayerState.nickname is capped at 12 chars total).
function dedupeNickname(nickname, existingNicknames) {
  if (!existingNicknames.has(nickname)) return nickname;
  for (let n = 2; ; n++) {
    const suffix = `#${n}`;
    const candidate = nickname.slice(0, 12 - suffix.length) + suffix;
    if (!existingNicknames.has(candidate)) return candidate;
  }
}

const FLOOR_BOUNDS = {
  x: C.RING_OUT_MARGIN,
  y: C.RING_OUT_MARGIN,
  w: C.ARENA_WIDTH - C.RING_OUT_MARGIN * 2,
  h: C.ARENA_HEIGHT - C.RING_OUT_MARGIN * 2,
};

// Chamfered-corner octagon, same shape as ArenaScene._buildArenaFloor().
const FLOOR_POLYGON = (() => {
  const f = FLOOR_BOUNDS;
  const cut = C.FLOOR_CORNER_CUT;
  return [
    { x: f.x + cut, y: f.y },
    { x: f.x + f.w - cut, y: f.y },
    { x: f.x + f.w, y: f.y + cut },
    { x: f.x + f.w, y: f.y + f.h - cut },
    { x: f.x + f.w - cut, y: f.y + f.h },
    { x: f.x + cut, y: f.y + f.h },
    { x: f.x, y: f.y + f.h - cut },
    { x: f.x, y: f.y + cut },
  ];
})();

function pointInPolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function angleWrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function circleHitsRect(x, y, radius, rect) {
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const closestX = Math.max(rect.x - halfW, Math.min(x, rect.x + halfW));
  const closestY = Math.max(rect.y - halfH, Math.min(y, rect.y + halfH));
  const dx = x - closestX;
  const dy = y - closestY;
  return dx * dx + dy * dy < radius * radius;
}

class ArenaRoom extends Room {
  onCreate(options) {
    this.maxClients = C.MAX_CLIENTS;
    this.setState(new ArenaRoomState());
    // Lobby display name — chosen by whoever creates the room (see
    // net.html's lobby screen / client.create() call), not synced into the
    // schema since it's only needed pre-join (client.getAvailableRooms()
    // reads room metadata, not schema state). Kept in `this._roomName` and
    // re-applied by _updateMetadata() so mode changes don't clobber it.
    this._roomName =
      options && typeof options.name === "string" && options.name.trim()
        ? options.name.trim().slice(0, 24)
        : "이름없는 방";
    this._updateMetadata();
    // Everything NOT in the synced schema (dash vectors, one-shot hit
    // flags, raw input intent) lives here, keyed by sessionId — it never
    // needs to reach the client.
    this.scratch = new Map();
    // sessionIds watching without a seat (room full past MAX_PLAYERS, or
    // explicitly asked to spectate) — see onJoin()/onLeave().
    this.spectatorIds = new Set();
    // ms remaining in the "2+ players in, waiting for maybe more" grace
    // window before the match auto-starts anyway — null while not counting
    // down (nobody's joined yet, or the room's already full/live).
    this.joinGraceMs = null;
    // Solo auto-fill: sessionIds of AI-controlled bots currently seated (at
    // most 1, see spawnBot()) — state.players.size alone can't tell a real
    // player apart from a bot, so "real player count" is always
    // state.players.size - botSessionIds.size. botSpawnMs mirrors
    // joinGraceMs's null-while-not-counting-down convention; botAI holds
    // each bot's own AI decision timers (see spawnBot()/_stepBotAI()).
    this.botSessionIds = new Set();
    this.botSpawnMs = null;
    this.botAI = new Map();

    // Fresh point-symmetric layout for this room — obstacles, pits, AND
    // quicksand are all permanent for the whole match, synced to clients as
    // part of the normal state (ArraySchema), so late joiners get them too.
    const layout = generateSymmetricLayout();
    const pushRects = (list, target) => {
      for (const r of list) {
        const rect = new RectState();
        rect.x = r.x;
        rect.y = r.y;
        rect.w = r.w;
        rect.h = r.h;
        target.push(rect);
      }
    };
    pushRects(layout.obstacles, this.state.obstacles);
    pushRects(layout.pits, this.state.pits);
    pushRects(layout.quicksand, this.state.quicksand);

    this.onMessage("input", (client, msg) => {
      const s = this.scratch.get(client.sessionId);
      if (!s) return;
      const player = this.state.players.get(client.sessionId);
      if (typeof msg.wantsMove === "boolean") s.wantsMove = msg.wantsMove;
      if (typeof msg.aimAngle === "number") s.aimAngle = msg.aimAngle;
      if (typeof msg.qHeld === "boolean") s.qHeld = msg.qHeld;
      // Continuous, not edge-latched — Knight's heldGuard W reads this the
      // same way qHeld is read for hold-to-charge, no IDLE gate needed since
      // it's just a live key-state mirror, not a one-shot trigger.
      if (typeof msg.wHeld === "boolean") s.wHeld = msg.wHeld;
      // Same shape, for Warrior's divingSlam hold-to-charge E.
      if (typeof msg.eHeld === "boolean") s.eHeld = msg.eHeld;
      // Only latch W/E while actually IDLE — tryStartSkills() is the sole
      // consumer and only runs from that state. Without this guard, a
      // press during GCD/CHARGING/DASH/PARRYING/KICKING/STUNNED sat on the
      // flag until the player next reached IDLE and fired there completely
      // unprompted (often well after the key was released), which is what
      // read as "input eaten, then stutters" under key-mashing — the client
      // predicts nothing here (PredictedSelf only calls _tryStartSkills
      // from IDLE, non-latching), so this also removes a client/server
      // prediction mismatch, not just the surprise fire.
      // Also latch from COMBO_WINDOW — stepComboWindow() consumes and clears
      // both flags itself the instant it reads them (lines below), so unlike
      // qPressed there's no risk of a stale flag leaking into the next IDLE
      // cycle; without this, Knight's Q>E (shield charge) and a tap-W
      // class's Q>W follow-up could never fire from that state.
      const wantsSkillGate =
        player && (player.state === C.STATES.IDLE || player.state === C.STATES.COMBO_WINDOW);
      if (msg.wPressed && wantsSkillGate) s.wPressed = true;
      if (msg.ePressed && wantsSkillGate) s.ePressed = true;
      // Q>Q also needs an explicit fresh press, not a hold-through read of
      // qHeld — over the network there's no guarantee the "key up" message
      // from the original tap has been processed by the time the (short)
      // dash finishes and COMBO_WINDOW opens, so reading qHeld there could
      // spuriously fire a second attack the player never asked for. qPressed
      // is a one-shot edge the client only sets on an actual new keydown, so
      // it can't falsely read true this way. Gated + consumed the same as
      // W/E above.
      if (msg.qPressed && wantsSkillGate) s.qPressed = true;
      // Staged here, NOT written to player.lastInputSeq yet — this message
      // is received mid-frame, before tick()/stepPlayer() next runs and
      // actually applies its effects (wantsMove/qHeld/wPressed/ePressed
      // above) to `player`. Publishing the seq to the synced field
      // immediately would tell the client "this input's effects are
      // already reflected in the state you're about to receive" while
      // they're really still one tick away — a race PredictedSelf.reconcile()
      // hit constantly, trimming its replay queue's triggering input just
      // before the snapshot actually showed the resulting state, making a
      // just-started PARRYING/KICKING vanish and then immediately
      // re-enter once the server caught up (read as "ends too fast" plus
      // a doubled entry SFX). tick() copies this into player.lastInputSeq
      // right after stepPlayer() applies it, so the two always move together.
      if (typeof msg.seq === "number" && msg.seq > s.pendingInputSeq) s.pendingInputSeq = msg.seq;
    });

    this.setSimulationInterval((dtMs) => this.tick(dtMs), C.SIMULATION_INTERVAL_MS);
    // Colyseus defaults to broadcasting schema patches at 20Hz (50ms), well
    // below the 60Hz simulation tick above — the client only has a fresh
    // target to move towards this often, which is the main source of the
    // "stutter/pushed" feeling multiplayer has vs. single-player's every-
    // frame Arcade physics. Doubling it to ~30Hz halves the gap the client's
    // interpolation buffer (NetArenaScene._getInterpolatedSnapshot) has to
    // smooth over, at a modest bandwidth cost for a 4-16 client room.
    this.setPatchRate(1000 / 30);
  }

  // Refreshes the metadata net.html's lobby fetches (see server/index.js's
  // "/rooms" endpoint, currently unused by the client — the lobby/room-list
  // screen that read it was removed in favor of joinOrCreate matchmaking,
  // but the endpoint itself is left in place, harmless if unused) — name
  // (chosen once, at creation), current mode, and active-seat counts.
  // Player counts need to be here explicitly (rather than relying on
  // Colyseus's own live `clients` count) because `clients` includes
  // spectators, up to MAX_CLIENTS (24) — not the 10-seat cap this exists to
  // report.
  _updateMetadata() {
    this.setMetadata({
      name: this._roomName,
      mode: this.state.mode,
      playerCount: this.state.players.size,
      maxPlayers: C.MAX_PLAYERS,
      spectatorCount: this.state.spectatorCount,
    });
  }

  onJoin(client, options) {
    // Past the 10 active seats (or an explicit "관전하기" request), a joiner
    // just watches: no PlayerState, no scratch entry, no effect on
    // countdown/match logic. They still receive the full room.state sync
    // for free — Colyseus broadcasts state to every connected client
    // regardless of whether that client owns an entry in it.
    if (this.state.players.size >= C.MAX_PLAYERS || options?.spectate === true) {
      this.spectatorIds.add(client.sessionId);
      this.state.spectatorCount++;
      console.log(`[arena] ${client.sessionId} joined as spectator (${this.state.spectatorCount} watching)`);
      this._updateMetadata();
      return;
    }

    const index = this.state.players.size;
    const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];

    const player = this._makePlayerState(options, index);
    player.id = client.sessionId;
    this.state.players.set(client.sessionId, player);
    this.scratch.set(client.sessionId, this._makeScratchEntry(spawn));

    console.log(`[arena] ${client.sessionId} joined (${this.state.players.size}/${C.MAX_PLAYERS})`);

    // No lobby/ready-check: full room starts immediately; 2+ opens a join
    // grace window (reset by every new joiner) so people trickling in over
    // a few seconds still land in the same match instead of each having to
    // be the one that fills the last seat. Solo (nobody else in yet) opens
    // its own, longer botSpawnMs window instead — see spawnBot()/tick().
    if (this.state.players.size === C.MAX_PLAYERS) {
      this.joinGraceMs = null;
      this.botSpawnMs = null;
      this.startCountdown();
    } else if (this.state.players.size >= 2 && this.state.matchPhase === "waiting") {
      this.joinGraceMs = C.JOIN_GRACE_MS;
      this.botSpawnMs = null; // a real player showed up — no bot needed
    } else if (this.state.players.size === 1 && this.botSessionIds.size === 0) {
      this.botSpawnMs = C.BOT_SPAWN_DELAY_MS;
    }
    this._updateMetadata();
  }

  // Builds a configured PlayerState for a real join (onJoin) or an
  // auto-fill bot (spawnBot) — same shape either way, `id` is set by the
  // caller since a bot has no real client.sessionId to read.
  _makePlayerState(options, index) {
    const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
    const player = new PlayerState();
    player.x = spawn.x;
    player.y = spawn.y;
    player.angle = 0;
    player.state = C.STATES.IDLE;
    player.chargeTime = 0;
    player.stunTimer = 0;
    player.globalCooldown = 0;
    player.isAlive = true;
    player.score = 0;
    player.lastInputSeq = 0;
    player.classId = sanitizeClassId(options?.classId, C.DEFAULT_CLASS_ID);
    player.colorIndex = sanitizeColorIndex(options?.colorIndex, index % COLOR_COUNT);
    const existingNicknames = new Set([...this.state.players.values()].map((p) => p.nickname));
    player.nickname = dedupeNickname(sanitizeNickname(options?.nickname), existingNicknames);
    return player;
  }

  // Builds the scratch entry (everything NOT in the synced schema) for a
  // real join or an auto-fill bot — same shape either way.
  _makeScratchEntry(spawn) {
    return {
      spawnX: spawn.x,
      spawnY: spawn.y,
      wantsMove: false,
      aimAngle: 0,
      qHeld: false,
      qPressed: false,
      wHeld: false,
      wPressed: false,
      ePressed: false,
      eHeld: false,
      pendingInputSeq: 0, // see onMessage("input")/tick() — published to player.lastInputSeq only after stepPlayer() applies it
      dash: null,
      dashKilled: false,
      kickHitApplied: false,
      kickCounteredParry: false,
      parrySuccess: false,
      knockback: null,
      stateTimer: 0,
      respawnClock: 0,
      // Knight-only scratch (harmless/unused for every other class):
      comboHitApplied: false,
      empoweredStrikeHitApplied: false,
      empoweredQMs: 0, // time left on the empowered-Q buff, granted by a successful heldGuard block
      shieldCharge: null, // { dx, dy, remaining }
      shieldChargeCounteredGuard: false,
      // Warrior-only scratch (harmless/unused for every other class):
      skillsDisabledMs: 0, // time left unable to start Q/W/E, from a battle-cry shout
      axeSwingHitApplied: false,
      battleCryShoutApplied: false,
      slam: null, // { dx, dy, remaining, impactRadius }
      slamImpactHitApplied: false,
      // Mage-only scratch (harmless/unused for every other class):
      fastChargeMs: 0, // time left on the fast-charge Q buff, granted by a blocked W or a landed E freeze
      slowedMs: 0, // time left at reduced move speed, from a plain blizzard hit
      laserFireHitApplied: false,
      blizzardHitApplied: false,
      blizzardCounteredGuard: false,
    };
  }

  // Solo auto-fill: adds one AI-controlled opponent so a lone real player
  // doesn't just sit on "waiting for players" forever — see botSpawnMs
  // (onJoin/onLeave/tick's "waiting" branch). Goes through the exact same
  // construction path a real join uses (_makePlayerState/_makeScratchEntry),
  // just with a made-up sessionId instead of a real client's — state.players
  // is a plain MapSchema with no dependency on an actual connection.
  spawnBot() {
    const botId = `bot-${Date.now()}`;
    const index = this.state.players.size;
    const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
    const classId = BOT_CLASS_IDS[Math.floor(Math.random() * BOT_CLASS_IDS.length)];

    const player = this._makePlayerState({ classId, colorIndex: Math.floor(Math.random() * COLOR_COUNT), nickname: "봇" }, index);
    player.id = botId;
    this.state.players.set(botId, player);
    this.scratch.set(botId, this._makeScratchEntry(spawn));
    this.botSessionIds.add(botId);
    this.botAI.set(botId, {
      dashClock: BOT_DASH_INTERVAL_MS,
      parryClock: BOT_PARRY_INTERVAL_MS,
      qHoldMsLeft: 0,
      wHoldMsLeft: 0,
    });

    console.log(`[arena] spawned auto-fill bot ${botId} (${classId})`);
    this._updateMetadata();
    // Skip joinGraceMs entirely — the solo player already waited
    // BOT_SPAWN_DELAY_MS; no reason to make them wait through a second
    // grace window on top of it.
    this.startCountdown();
  }

  // Ports server/bot.js's AI decision logic (a real-client dev tool) to run
  // directly against this bot's own scratch entry each tick instead of over
  // a socket — same behavior, no network round-trip. Mirrors
  // src/entities/Dummy.js's single-player training-dummy feel: stands
  // still, periodically raises W, periodically charges/fires Q aimed at the
  // nearest other player, never uses E.
  _stepBotAI(botId, player, s, dtMs) {
    const ai = this.botAI.get(botId);
    if (!ai) return;

    let nearest = null;
    let nearestDist = Infinity;
    for (const [otherId, other] of this.state.players.entries()) {
      if (otherId === botId || !other.isAlive) continue;
      const d = Math.hypot(other.x - player.x, other.y - player.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = other;
      }
    }
    if (nearest) s.aimAngle = Math.atan2(nearest.y - player.y, nearest.x - player.x);
    s.wantsMove = false;
    s.ePressed = false;
    s.eHeld = false;

    const wantsSkillGate = player.state === C.STATES.IDLE || player.state === C.STATES.COMBO_WINDOW;
    const skillTypes = C.classSkills(player.classId).skillTypes;
    let qPressed = false;
    let wPressed = false;

    if (ai.qHoldMsLeft > 0) {
      ai.qHoldMsLeft -= dtMs;
    } else if (ai.wHoldMsLeft > 0) {
      ai.wHoldMsLeft -= dtMs;
    } else if (this.state.matchPhase === "live") {
      ai.dashClock -= dtMs;
      ai.parryClock -= dtMs;
      if (ai.dashClock <= 0) {
        ai.dashClock = BOT_DASH_INTERVAL_MS;
        if (skillTypes.q === "chargeDash" || skillTypes.q === "laserBeam") ai.qHoldMsLeft = BOT_DASH_HOLD_MS;
        else qPressed = true;
      } else if (ai.parryClock <= 0) {
        ai.parryClock = BOT_PARRY_INTERVAL_MS;
        if (skillTypes.w === "heldGuard") ai.wHoldMsLeft = BOT_HELD_W_HOLD_MS;
        else wPressed = true;
      }
    }

    s.qHeld = ai.qHoldMsLeft > 0;
    s.wHeld = ai.wHoldMsLeft > 0;
    // Same IDLE/COMBO_WINDOW gate onMessage("input") applies to a real
    // client's press — bypassing that handler means a bot has to respect it
    // explicitly, or it could queue a press mid-animation a real client
    // never could.
    if (qPressed && wantsSkillGate) s.qPressed = true;
    if (wPressed && wantsSkillGate) s.wPressed = true;
  }

  // consented === true means the client called room.leave() itself (or the
  // server kicked it); consented === false is an abrupt drop (dead wifi,
  // mobile tab backgrounded/killed, etc.) — those get a grace window to
  // reconnect via client.reconnect(token) and reclaim the same schema entry
  // before we actually tear down the seat.
  async onLeave(client, consented) {
    if (this.spectatorIds.has(client.sessionId)) {
      // Same reconnect grace as active players — otherwise an unexpected
      // drop instantly evicts the spectator server-side while the client
      // (which can't tell player and spectator drops apart) still spends
      // the full retry budget in _onRoomLeave() trying a reconnect that
      // the server would immediately refuse.
      if (!consented) {
        try {
          await this.allowReconnection(client, C.RECONNECT_GRACE_SEC);
          console.log(`[arena] ${client.sessionId} (spectator) reconnected`);
          return;
        } catch (e) {
          // Grace window expired without a reconnect — fall through.
        }
      }
      this.spectatorIds.delete(client.sessionId);
      this.state.spectatorCount--;
      console.log(`[arena] ${client.sessionId} (spectator) left`);
      this._updateMetadata();
      return;
    }

    if (!consented && this.state.players.has(client.sessionId)) {
      try {
        await this.allowReconnection(client, C.RECONNECT_GRACE_SEC);
        console.log(`[arena] ${client.sessionId} reconnected`);
        return;
      } catch (e) {
        // Grace window expired without a reconnect — fall through to
        // normal cleanup below.
      }
    }

    this.state.players.delete(client.sessionId);
    this.scratch.delete(client.sessionId);

    // If that was the last real player, drop the auto-fill bot too —
    // nothing left for it to fight, and a fresh solo joiner later should
    // get a brand new spawn timer, not inherit a stale bot.
    if (this.state.players.size - this.botSessionIds.size <= 0) {
      for (const botId of this.botSessionIds) {
        this.state.players.delete(botId);
        this.scratch.delete(botId);
        this.botAI.delete(botId);
      }
      this.botSessionIds.clear();
      this.botSpawnMs = null;
    }

    if (this.state.players.size < 2) {
      // Can't run a match solo — back to waiting for someone else.
      this.state.matchPhase = "waiting";
      this.state.phaseTimer = 0;
      this.joinGraceMs = null;
      // Exactly 1 real player left with no bot (e.g. dropped from 2 real
      // players to 1) — same solo-fill window a first joiner gets.
      if (this.state.players.size === 1 && this.botSessionIds.size === 0) {
        this.botSpawnMs = C.BOT_SPAWN_DELAY_MS;
      } else {
        this.botSpawnMs = null;
      }
    } else if (this.state.matchPhase === "live") {
      // Match continues with whoever's left; re-run the same
      // last-man-standing check a kill uses, in case this departure
      // happens to leave exactly one player alive.
      this._onPlayerDied(null);
    }
    console.log(`[arena] ${client.sessionId} left`);
    this._updateMetadata();
  }

  // ---- Match flow (ROUND/DEATHMATCH mode, countdown, round-end) --------

  startCountdown() {
    this.state.matchPhase = "countdown";
    this.state.phaseTimer = C.NET_COUNTDOWN_MS;
  }

  // Called from kill() (and onLeave(), for a departure that happens to
  // leave someone the last one standing) — figures out the round winner
  // (last player alive) and, for DEATHMATCH, credits the actual killer (if
  // any — hazard/self-deaths credit nobody) with an immediate kill point.
  // DEATHMATCH's a running FFA: 1 point per kill, first to
  // DEATHMATCH_WIN_SCORE wins the whole match (a distinct "matchEnd" freeze,
  // separate from ROUND mode's per-round WIN/LOSE/DRAW freeze).
  _onPlayerDied(killerSessionId) {
    if (this.state.mode === "deathmatch" && killerSessionId) {
      const killer = this.state.players.get(killerSessionId);
      if (killer) {
        killer.score += 1;
        this.state.winnerId = killerSessionId; // last-kill reference for the client's "+1" flash
        if (killer.score >= C.DEATHMATCH_WIN_SCORE) {
          this.state.matchPhase = "matchEnd";
          this.state.phaseTimer = C.MATCH_END_BANNER_MS;
          return;
        }
      }
    }

    const aliveIds = [...this.state.players.entries()].filter(([, p]) => p.isAlive).map(([id]) => id);
    if (aliveIds.length > 1 || this.state.players.size <= 1) return; // FFA still has 2+ standing — round isn't over

    if (this.state.mode === "round") {
      const survivorId = aliveIds[0] || "";
      this.state.winnerId = survivorId;
      if (survivorId) this.state.players.get(survivorId).score += 1;
      this.state.matchPhase = "roundEnd";
      this.state.phaseTimer = C.ROUND_BANNER_MS;
    }
  }

  _respawnAllAndCountdown() {
    for (const [sessionId, player] of this.state.players.entries()) {
      this.respawn(player, this.scratch.get(sessionId));
    }
    this.startCountdown();
  }

  // After the match-end banner holds, everyone's score resets and a fresh
  // match begins — same "no lobby" philosophy as the rest of match flow.
  _resetScoresRespawnAllAndCountdown() {
    for (const [sessionId, player] of this.state.players.entries()) {
      player.score = 0;
      this.respawn(player, this.scratch.get(sessionId));
    }
    this.startCountdown();
  }

  tick(dtMs) {
    if (this.state.matchPhase === "waiting") {
      if (this.joinGraceMs !== null) {
        this.joinGraceMs -= dtMs;
        if (this.joinGraceMs <= 0) {
          this.joinGraceMs = null;
          this.startCountdown();
        }
      } else if (this.botSpawnMs !== null) {
        this.botSpawnMs -= dtMs;
        if (this.botSpawnMs <= 0) {
          this.botSpawnMs = null;
          this.spawnBot();
        }
      }
      return;
    }

    if (this.state.matchPhase === "countdown") {
      this.state.phaseTimer -= dtMs;
      if (this.state.phaseTimer <= 0) this.state.matchPhase = "live";
      return;
    }

    if (this.state.matchPhase === "roundEnd") {
      this.state.phaseTimer -= dtMs;
      if (this.state.phaseTimer <= 0) this._respawnAllAndCountdown();
      return;
    }

    if (this.state.matchPhase === "matchEnd") {
      this.state.phaseTimer -= dtMs;
      if (this.state.phaseTimer <= 0) this._resetScoresRespawnAllAndCountdown();
      return;
    }

    // matchPhase === "live"
    // Bots have no real client sending onMessage("input", ...) — decide
    // their move here, writing straight into their own scratch entry, so
    // it's already staged by the time the per-player loop below runs their
    // own stepPlayer() this same tick (same as a real client's input would
    // be, had it arrived a moment earlier).
    for (const botId of this.botSessionIds) {
      const player = this.state.players.get(botId);
      if (player && player.isAlive) this._stepBotAI(botId, player, this.scratch.get(botId), dtMs);
    }
    for (const [sessionId, player] of this.state.players.entries()) {
      const s = this.scratch.get(sessionId);
      if (!player.isAlive) {
        // DEATHMATCH: respawn and keep fighting. ROUND: stay dead — this
        // only converges to a "last one standing" winner in _onPlayerDied()
        // if eliminated players actually stay eliminated for the rest of
        // the round (with 2 players a single kill always ended the round
        // before this timer could fire; 3-4 player FFA needs it explicit).
        if (this.state.mode === "deathmatch") {
          s.respawnClock -= dtMs;
          if (s.respawnClock <= 0) this.respawn(player, s);
        }
        continue;
      }
      this.stepPlayer(player, s, dtMs);
      // Now safe to publish — this tick just applied everything staged up
      // to this seq (see onMessage("input")'s comment).
      player.lastInputSeq = s.pendingInputSeq;
    }
    this.checkDashHits();
    this.checkKicks();
    this.checkComboAttack();
    this.checkEmpoweredStrike();
    this.checkShieldCharge();
    this.checkAxeSwing();
    this.checkBattleCryShout();
    this.checkSlamImpact();
    this.checkLaserFire();
    this.checkBlizzard();
    this.checkRingOuts();
    this.checkPitDeaths();
  }

  respawn(player, s) {
    player.isAlive = true;
    player.x = s.spawnX;
    player.y = s.spawnY;
    player.angle = 0;
    player.state = C.STATES.IDLE;
    player.chargeTime = 0;
    player.stunTimer = 0;
    player.globalCooldown = 0;
    s.dash = null;
    s.knockback = null;
    s.lastKnockedBackBy = null;
    // A W/E press latched in onMessage("input") right before death (or any
    // time while dead — the client keeps sending input, tryStartSkills()
    // just never runs for a dead player to consume it) would otherwise
    // survive in the scratch record and fire the instant this player
    // becomes IDLE again, as a "phantom" skill use they never intended
    // post-respawn.
    s.wPressed = false;
    s.ePressed = false;
    s.qPressed = false;
    s.shieldCharge = null;
    s.shieldChargeCounteredGuard = false;
    s.empoweredQMs = 0;
    player.empoweredQActive = false;
    s.skillsDisabledMs = 0;
    player.skillsDisabled = false;
    s.slam = null;
    s.fastChargeMs = 0;
    player.fastChargeActive = false;
    s.slowedMs = 0;
    player.slowed = false;
  }

  // ---- Arena hazards -------------------------------------------------

  hitsObstacle(x, y) {
    for (const o of this.state.obstacles) {
      if (circleHitsRect(x, y, C.PLAYER_RADIUS, o)) return true;
    }
    return false;
  }

  isInsideFloor(x, y) {
    return pointInPolygon(FLOOR_POLYGON, x, y);
  }

  // layoutGenerator.js's {x, y, w, h} rects are CENTER-based (x,y is the
  // rect's center, matching circleHitsRect's convention below) — pits and
  // quicksand used to check this as a top-left corner instead, silently
  // shifting the real hit region by (w/2, h/2) away from wherever it was
  // actually drawn/verified-clear-of-spawns.
  isInQuicksand(x, y) {
    for (const q of this.state.quicksand) {
      const halfW = q.w / 2;
      const halfH = q.h / 2;
      if (x >= q.x - halfW && x <= q.x + halfW && y >= q.y - halfH && y <= q.y + halfH) return true;
    }
    return false;
  }

  // If this player was knocked back recently enough, credit the pusher for
  // whatever kills them next (ring-out/pit) instead of crediting no one —
  // bounded to a short window so an old, unrelated knockback doesn't wrongly
  // credit a much-later death the player caused themselves.
  _recentKnockbackAttacker(s) {
    if (s.lastKnockedBackBy && Date.now() - s.lastKnockedBackAt <= C.KNOCKBACK_ATTRIBUTION_MS) {
      return s.lastKnockedBackBy;
    }
    return null;
  }

  checkRingOuts() {
    for (const [sessionId, player] of this.state.players.entries()) {
      if (!player.isAlive) continue;
      if (!this.isInsideFloor(player.x, player.y)) {
        const s = this.scratch.get(sessionId);
        this.kill(player, s, this._recentKnockbackAttacker(s));
      }
    }
  }

  // Pits are permanent for the whole match — always lethal; a Q dash still
  // passes safely over one, same exception the single-player version has.
  checkPitDeaths() {
    for (const [sessionId, player] of this.state.players.entries()) {
      if (!player.isAlive || player.state === C.STATES.DASH) continue;
      for (const p of this.state.pits) {
        const halfW = p.w / 2;
        const halfH = p.h / 2;
        if (player.x >= p.x - halfW && player.x <= p.x + halfW && player.y >= p.y - halfH && player.y <= p.y + halfH) {
          const s = this.scratch.get(sessionId);
          this.kill(player, s, this._recentKnockbackAttacker(s));
          break;
        }
      }
    }
  }

  // ---- Per-player step -------------------------------------------------

  stepPlayer(player, s, dtMs) {
    // Knockback overrides normal movement while active, same as the client.
    if (s.knockback) {
      const nx = player.x + s.knockback.dx * s.knockback.speed * (dtMs / 1000);
      const ny = player.y + s.knockback.dy * s.knockback.speed * (dtMs / 1000);
      if (!this.hitsObstacle(nx, ny)) {
        player.x = nx;
        player.y = ny;
      }
      s.knockback.remainingMs -= dtMs;
      if (s.knockback.remainingMs <= 0) s.knockback = null;
    }
    // Knight empowered-Q buff: decays every tick regardless of state (same
    // "expires silently if unused" shape as Combatant.js's _empoweredQMs),
    // mirrored onto the synced flag so other clients can render the glow.
    if (s.empoweredQMs > 0) {
      s.empoweredQMs = Math.max(0, s.empoweredQMs - dtMs);
      player.empoweredQActive = s.empoweredQMs > 0;
    }
    // Warrior battle-cry debuff: same "expires silently, mirrored onto a
    // synced flag" shape as the empowered-Q buff above.
    if (s.skillsDisabledMs > 0) {
      s.skillsDisabledMs = Math.max(0, s.skillsDisabledMs - dtMs);
      player.skillsDisabled = s.skillsDisabledMs > 0;
    }
    // Mage fast-charge buff and blizzard slow debuff: same shape again.
    if (s.fastChargeMs > 0) {
      s.fastChargeMs = Math.max(0, s.fastChargeMs - dtMs);
      player.fastChargeActive = s.fastChargeMs > 0;
    }
    if (s.slowedMs > 0) {
      s.slowedMs = Math.max(0, s.slowedMs - dtMs);
      player.slowed = s.slowedMs > 0;
    }

    switch (player.state) {
      case C.STATES.IDLE:
        this.moveIdleLike(player, s, dtMs, C.BASE_SPEED);
        this.tryStartSkills(player, s);
        break;
      case C.STATES.GCD:
        this.moveIdleLike(player, s, dtMs, C.BASE_SPEED);
        player.globalCooldown = Math.max(0, player.globalCooldown - dtMs);
        if (player.globalCooldown <= 0) player.state = C.STATES.IDLE;
        break;
      case C.STATES.CHARGING:
        this.stepCharging(player, s, dtMs);
        break;
      case C.STATES.DASH:
        this.stepDash(player, s, dtMs);
        break;
      case C.STATES.PARRYING:
        if (C.classSkills(player.classId).skillTypes.w === "heldGuard") {
          // Held guard: still mobile, just slowed — the shield goes up but
          // doesn't root the player in place like a tap-parry does.
          const wParry = C.classSkills(player.classId).wParry;
          this.moveIdleLike(player, s, dtMs, C.BASE_SPEED * wParry.MOVE_SPEED_MULTIPLIER);
          // Lowering the shield (voluntary release or hitting the hold
          // ceiling) pays the standard GCD, same as any other skill use —
          // a successful block (see checkDashHits' parrySuccess handling)
          // is the one path that's exempt.
          s.stateTimer -= dtMs;
          if (s.stateTimer <= 0 || !s.wHeld) this.enterGCD(player, 1);
        } else {
          s.stateTimer -= dtMs;
          if (s.stateTimer <= 0) this.enterGCD(player, C.FAILED_PARRY_GCD_MULTIPLIER);
        }
        break;
      case C.STATES.KICKING:
        s.stateTimer -= dtMs;
        if (s.stateTimer <= 0) {
          if (s.kickCounteredParry) player.state = C.STATES.IDLE;
          else this.enterGCD(player, 1);
        }
        break;
      case C.STATES.STUNNED:
        player.stunTimer = Math.max(0, player.stunTimer - dtMs);
        if (player.stunTimer <= 0) player.state = C.STATES.IDLE;
        break;
      case C.STATES.SHIELD_CHARGE:
        this.stepShieldCharge(player, s, dtMs);
        break;
      case C.STATES.COMBO_WINDOW:
        this.stepComboWindow(player, s, dtMs);
        break;
      case C.STATES.COMBO_ATTACK:
        s.stateTimer -= dtMs;
        if (s.stateTimer <= 0) this.enterGCD(player, 1);
        break;
      case C.STATES.EMPOWERED_STRIKE:
        s.stateTimer -= dtMs;
        if (s.stateTimer <= 0) this.enterGCD(player, 1);
        break;
      case C.STATES.AXE_SWING:
        s.stateTimer -= dtMs;
        if (s.stateTimer <= 0) this.enterGCD(player, 1);
        break;
      case C.STATES.BATTLE_CRY:
        this.stepBattleCry(player, s, dtMs);
        break;
      case C.STATES.SLAM_CHARGE:
        this.stepSlamCharge(player, s, dtMs);
        break;
      case C.STATES.SLAMMING:
        this.stepSlamming(player, s, dtMs);
        break;
      case C.STATES.SLAM_IMPACT:
        s.stateTimer -= dtMs;
        if (s.stateTimer <= 0) this.enterGCD(player, 1);
        break;
      case C.STATES.LASER_CHARGE:
        this.stepLaserCharge(player, s, dtMs);
        break;
      case C.STATES.LASER_FIRE:
        s.stateTimer -= dtMs;
        if (s.stateTimer <= 0) this.enterGCD(player, 1);
        break;
      case C.STATES.FLUID:
        this.stepFluidState(player, s, dtMs);
        break;
      case C.STATES.BLIZZARD:
        s.stateTimer -= dtMs;
        if (s.stateTimer <= 0) {
          if (s.blizzardCounteredGuard) player.state = C.STATES.IDLE;
          else this.enterGCD(player, 1);
        }
        break;
      default:
        break;
    }
  }

  // Mage W: mobile for the whole cast (invincible phase then a haste
  // phase) — a successful invincibility block ends this early via
  // kill()/applyStun()/applyKnockback()'s isInvincible guard forcing
  // player.state straight to IDLE, so reaching this timer expiring always
  // means "no block" (mirrors Combatant._updateFluidState).
  stepFluidState(player, s, dtMs) {
    const cfg = C.classSkills(player.classId).fluidState;
    const hasted = s.stateTimer <= cfg.TOTAL_MS - cfg.DURATION_MS;
    this.moveIdleLike(player, s, dtMs, C.BASE_SPEED * (hasted ? cfg.HASTE_MULTIPLIER : 1));
    s.stateTimer -= dtMs;
    if (s.stateTimer <= 0) this.enterGCD(player, 1);
  }

  // Mage Q, phase 1/2: hold to charge — mirrors stepCharging's shape, but
  // release before laserMinChargeMs is reached just cancels (no beam,
  // standard GCD) instead of firing a scaled-down beam. Deliberately does
  // NOT reset player.chargeTime on a successful release (see stepPlayer's
  // LASER_FIRE case) so it stays readable through the fire window — the
  // client derives the same length/width from that same synced field, no
  // extra schema needed (same trick as Warrior's slam).
  stepLaserCharge(player, s, dtMs) {
    player.angle = s.aimAngle;
    const laser = C.classSkills(player.classId).laserBeam;
    const speed = this.moveSpeed(player, s, C.BASE_SPEED * C.CHARGE_SPEED_FACTOR);
    if (s.wantsMove) {
      const nx = player.x + Math.cos(player.angle) * speed * (dtMs / 1000);
      const ny = player.y + Math.sin(player.angle) * speed * (dtMs / 1000);
      if (!this.hitsObstacle(nx, ny)) {
        player.x = nx;
        player.y = ny;
      }
    }
    player.chargeTime = Math.min(player.chargeTime + dtMs, laser.MAX_CHARGE_MS);
    if (!s.qHeld) {
      if (player.chargeTime >= this.laserMinChargeMs(player, s)) {
        s.fastChargeMs = 0; // consumed on use, same as Knight's empoweredQBuff
        player.fastChargeActive = false;
        player.state = C.STATES.LASER_FIRE;
        s.stateTimer = laser.TOTAL_MS;
        s.laserFireHitApplied = false;
      } else {
        this.enterGCD(player, 1);
      }
    }
  }

  // Warrior W: mobile at full speed for the whole cast (invincible phase +
  // AOE windup) — a successful invincibility block ends this early via
  // kill()/applyStun()/applyKnockback()'s isInvincible guard forcing
  // player.state straight to IDLE, so reaching this timer expiring always
  // means "no block" (mirrors Combatant._updateBattleCry).
  stepBattleCry(player, s, dtMs) {
    this.moveIdleLike(player, s, dtMs, C.BASE_SPEED);
    s.stateTimer -= dtMs;
    if (s.stateTimer <= 0) this.enterGCD(player, 1);
  }

  // Warrior E, phase 1/3: hold to charge — mirrors stepCharging's shape but
  // for E/divingSlam. Deliberately does NOT reset player.chargeTime on
  // release (see startSlamming below) so it stays readable through
  // SLAMMING/SLAM_IMPACT — the client derives the same leap distance/impact
  // radius from that same synced field, no extra schema needed.
  stepSlamCharge(player, s, dtMs) {
    player.angle = s.aimAngle;
    if (s.wantsMove) {
      const speed = this.isInQuicksand(player.x, player.y) ? C.BASE_SPEED * C.SLOW_ZONE_FACTOR : C.BASE_SPEED;
      const nx = player.x + Math.cos(player.angle) * speed * (dtMs / 1000);
      const ny = player.y + Math.sin(player.angle) * speed * (dtMs / 1000);
      if (!this.hitsObstacle(nx, ny)) {
        player.x = nx;
        player.y = ny;
      }
    }
    const slam = C.classSkills(player.classId).divingSlam;
    player.chargeTime = Math.min(player.chargeTime + dtMs, slam.MAX_CHARGE_MS);
    if (!s.eHeld) this.startSlamming(player, s);
  }

  // Warrior E, phase 2/3: the leap itself. Distance/impact radius are both
  // resolved once here from the charge ratio, then carried on s.slam.
  startSlamming(player, s) {
    const slam = C.classSkills(player.classId).divingSlam;
    const ratio = player.chargeTime / slam.MAX_CHARGE_MS;
    s.slam = {
      dx: Math.cos(player.angle),
      dy: Math.sin(player.angle),
      remaining: slam.MIN_LEAP_DISTANCE + (slam.MAX_LEAP_DISTANCE - slam.MIN_LEAP_DISTANCE) * ratio,
      impactRadius: slam.MIN_IMPACT_RADIUS + (slam.MAX_IMPACT_RADIUS - slam.MIN_IMPACT_RADIUS) * ratio,
    };
    player.state = C.STATES.SLAMMING;
  }

  // Warrior E, phase 2/3 continued: mirrors stepDash's exact sub-stepping/
  // wall-stop shape, against s.slam instead of s.dash. A wall hit always
  // self-stuns (no killed/counteredGuard branching — mirrors
  // stopSlammingOnWall's unconditional shape). On natural completion,
  // s.slam is deliberately NOT nulled — checkSlamImpact still needs
  // s.slam.impactRadius during SLAM_IMPACT.
  stepSlamming(player, s, dtMs) {
    if (!s.slam) {
      this.enterGCD(player, 1);
      return;
    }
    const slam = C.classSkills(player.classId).divingSlam;
    const totalStep = Math.min((slam.LEAP_SPEED * dtMs) / 1000, s.slam.remaining);
    const subSteps = Math.max(1, Math.ceil(totalStep / 8));
    const perStep = totalStep / subSteps;
    let stoppedByWall = false;

    for (let i = 0; i < subSteps; i++) {
      const nx = player.x + s.slam.dx * perStep;
      const ny = player.y + s.slam.dy * perStep;
      if (this.hitsObstacle(nx, ny)) {
        stoppedByWall = true;
        break;
      }
      player.x = nx;
      player.y = ny;
      s.slam.remaining -= perStep;
    }

    if (stoppedByWall) {
      s.slam = null;
      this.applyStun(player, s, C.WALL_STUN_MS);
      return;
    }

    if (s.slam.remaining <= 0.01) {
      player.state = C.STATES.SLAM_IMPACT;
      s.stateTimer = slam.TOTAL_MS;
      s.slamImpactHitApplied = false;
    }
  }

  // Blocked by obstacle walls; quicksand slows this movement (Q dash ignores
  // the slow zone entirely, matching the single-player rule).
  // Central place every movement-speed calculation should route through
  // (mirrors Combatant._moveSpeed) — today: quicksand, and Mage's blizzard
  // slow debuff (a *foreign*-inflicted speed reduction, unlike every other
  // speed modifier so far which was self-cast).
  moveSpeed(player, s, baseSpeed) {
    let speed = baseSpeed;
    if (this.isInQuicksand(player.x, player.y)) speed *= C.SLOW_ZONE_FACTOR;
    if (s.slowedMs > 0) speed *= C.SLOW_DEBUFF_FACTOR;
    return speed;
  }

  moveIdleLike(player, s, dtMs, baseSpeed) {
    player.angle = s.aimAngle;
    if (!s.wantsMove) return;
    const speed = this.moveSpeed(player, s, baseSpeed);
    const nx = player.x + Math.cos(player.angle) * speed * (dtMs / 1000);
    const ny = player.y + Math.sin(player.angle) * speed * (dtMs / 1000);
    if (!this.hitsObstacle(nx, ny)) {
      player.x = nx;
      player.y = ny;
    }
  }

  // Q/W/E are each dispatched independently (three separate if/else-if
  // chains, not one big switch) — mirrors Combatant._tryStartSkills exactly,
  // branching on skillTypes.{q,w,e} instead of assuming swordsman's shapes.
  tryStartSkills(player, s) {
    // Hit by a Warrior's battle cry — can't start any skill (movement/GCD
    // are unaffected, already applied via moveIdleLike before this runs)
    // until the debuff timer runs out.
    if (s.skillsDisabledMs > 0) return;

    const skillTypes = C.classSkills(player.classId).skillTypes;

    if (skillTypes.q === "comboDash") {
      // No hold-to-charge — a tap fires a fixed-distance dash immediately.
      if (s.qPressed) {
        s.qPressed = false;
        this.startComboDash(player, s);
        return;
      }
    } else if (skillTypes.q === "axeSwing") {
      // No hold-to-charge either — an instant 360-degree hit around self.
      if (s.qPressed) {
        s.qPressed = false;
        const axeSwing = C.classSkills(player.classId).axeSwing;
        player.state = C.STATES.AXE_SWING;
        s.stateTimer = axeSwing.TOTAL_MS;
        s.axeSwingHitApplied = false;
        return;
      }
    } else if (skillTypes.q === "laserBeam") {
      // Hold-to-charge like the default below, but release-before-threshold
      // just cancels instead of firing a scaled-down beam — see
      // stepLaserCharge.
      if (s.qHeld) {
        player.chargeTime = 0;
        player.state = C.STATES.LASER_CHARGE;
        return;
      }
    } else if (s.qHeld) {
      player.chargeTime = 0;
      s.dash = null;
      player.state = C.STATES.CHARGING;
      return;
    }

    if (skillTypes.w === "heldGuard") {
      if (s.wHeld) {
        player.state = C.STATES.PARRYING;
        s.stateTimer = C.classSkills(player.classId).wParry.MAX_HOLD_MS;
        s.parrySuccess = false;
        return;
      }
    } else if (skillTypes.w === "battleCry") {
      if (s.wPressed) {
        s.wPressed = false;
        const battleCry = C.classSkills(player.classId).battleCry;
        player.state = C.STATES.BATTLE_CRY;
        s.stateTimer = battleCry.TOTAL_MS;
        s.battleCryShoutApplied = false;
        return;
      }
    } else if (skillTypes.w === "fluidState") {
      if (s.wPressed) {
        s.wPressed = false;
        player.state = C.STATES.FLUID;
        s.stateTimer = C.classSkills(player.classId).fluidState.TOTAL_MS;
        return;
      }
    } else if (s.wPressed) {
      s.wPressed = false;
      player.state = C.STATES.PARRYING;
      s.stateTimer = C.classSkills(player.classId).wParry.DURATION_MS;
      s.parrySuccess = false;
      return;
    }

    if (skillTypes.e === "shieldCharge") {
      if (s.ePressed) {
        s.ePressed = false;
        this.startShieldCharge(player, s);
      }
    } else if (skillTypes.e === "divingSlam") {
      // Hold-to-charge, mirrors Q's CHARGING shape but for E.
      if (s.eHeld) {
        player.chargeTime = 0;
        player.state = C.STATES.SLAM_CHARGE;
      }
    } else if (skillTypes.e === "blizzard") {
      // Instant tap, no charge — a wide cone burst in the facing direction.
      if (s.ePressed) {
        s.ePressed = false;
        player.state = C.STATES.BLIZZARD;
        s.stateTimer = C.classSkills(player.classId).blizzard.TOTAL_MS;
        s.blizzardHitApplied = false;
        s.blizzardCounteredGuard = false;
      }
    } else if (s.ePressed) {
      s.ePressed = false;
      player.state = C.STATES.KICKING;
      s.stateTimer = C.classSkills(player.classId).eKick.TOTAL_MS;
      s.kickHitApplied = false;
      s.kickCounteredParry = false;
    }
  }

  // Knight Q, tap-fire: a pending empowered-Q buff (granted by a successful
  // heldGuard block) redirects this to the stationary line-AOE instead of a
  // dash — same shape as Combatant._startComboDash.
  startComboDash(player, s) {
    if (s.empoweredQMs > 0) {
      this.startEmpoweredStrike(player, s);
      return;
    }
    const qDash = C.classSkills(player.classId).qDash;
    s.dash = {
      dx: Math.cos(player.angle),
      dy: Math.sin(player.angle),
      remaining: qDash.DISTANCE,
      lethal: qDash.LETHAL !== false,
      pierce: qDash.PIERCE !== false,
      knockbackDistance: qDash.KNOCKBACK_DISTANCE,
      knockbackSpeed: qDash.KNOCKBACK_SPEED,
    };
    s.dashKilled = false;
    player.state = C.STATES.DASH;
  }

  // Knight empowered Q: a stationary wide line-AOE, not a dash — the
  // character doesn't move. See checkEmpoweredStrike() for the hit-test.
  startEmpoweredStrike(player, s) {
    s.empoweredQMs = 0;
    player.empoweredQActive = false;
    s.empoweredStrikeHitApplied = false;
    player.state = C.STATES.EMPOWERED_STRIKE;
    s.stateTimer = C.classSkills(player.classId).empoweredStrike.TOTAL_MS;
  }

  // Knight E: a short forward shield charge — mirrors startComboDash's dash
  // object shape but resolved via stepShieldCharge()/checkShieldCharge().
  startShieldCharge(player, s) {
    const eCharge = C.classSkills(player.classId).eShieldCharge;
    s.shieldCharge = {
      dx: Math.cos(player.angle),
      dy: Math.sin(player.angle),
      remaining: eCharge.DISTANCE,
    };
    s.shieldChargeCounteredGuard = false;
    player.state = C.STATES.SHIELD_CHARGE;
  }

  // Knight: brief window after a landed comboDash hit (whiff or hit alike)
  // to press Q/W/E again for a follow-up — mirrors _updateComboWindow
  // exactly. Re-aims to the live input angle each tick so whichever
  // follow-up fires uses where the player is aiming *now*, not the dash's
  // stale travel direction.
  stepComboWindow(player, s, dtMs) {
    player.angle = s.aimAngle;
    const skillTypes = C.classSkills(player.classId).skillTypes;

    if (s.qPressed) {
      s.qPressed = false;
      player.state = C.STATES.COMBO_ATTACK;
      s.stateTimer = C.classSkills(player.classId).comboAttack.TOTAL_MS;
      s.comboHitApplied = false;
      return;
    }
    if (s.ePressed && skillTypes.e === "shieldCharge") {
      s.ePressed = false;
      this.startShieldCharge(player, s);
      return;
    }
    const wantsW = skillTypes.w === "heldGuard" ? s.wHeld : s.wPressed;
    if (wantsW) {
      if (skillTypes.w === "heldGuard") {
        player.state = C.STATES.PARRYING;
        s.stateTimer = C.classSkills(player.classId).wParry.MAX_HOLD_MS;
        s.parrySuccess = false;
      } else {
        s.wPressed = false;
        player.state = C.STATES.PARRYING;
        s.stateTimer = C.classSkills(player.classId).wParry.DURATION_MS;
        s.parrySuccess = false;
      }
      return;
    }
    s.stateTimer -= dtMs;
    if (s.stateTimer <= 0) this.enterGCD(player, 1);
  }

  // Mirrors stepDash's exact sub-stepping/wall-stop shape, against
  // s.shieldCharge instead of s.dash.
  stepShieldCharge(player, s, dtMs) {
    if (!s.shieldCharge) {
      this.enterGCD(player, 1);
      return;
    }
    const eCharge = C.classSkills(player.classId).eShieldCharge;
    const totalStep = Math.min((eCharge.SPEED * dtMs) / 1000, s.shieldCharge.remaining);
    const subSteps = Math.max(1, Math.ceil(totalStep / 8));
    const perStep = totalStep / subSteps;
    let stoppedByWall = false;

    for (let i = 0; i < subSteps; i++) {
      const nx = player.x + s.shieldCharge.dx * perStep;
      const ny = player.y + s.shieldCharge.dy * perStep;
      if (this.hitsObstacle(nx, ny)) {
        stoppedByWall = true;
        break;
      }
      player.x = nx;
      player.y = ny;
      s.shieldCharge.remaining -= perStep;
    }

    if (stoppedByWall) {
      s.shieldCharge = null;
      const counteredGuard = s.shieldChargeCounteredGuard;
      s.shieldChargeCounteredGuard = false;
      if (counteredGuard) player.state = C.STATES.IDLE;
      else this.applyStun(player, s, C.WALL_STUN_MS);
      return;
    }

    if (s.shieldCharge.remaining <= 0.01) {
      s.shieldCharge = null;
      const counteredGuard = s.shieldChargeCounteredGuard;
      s.shieldChargeCounteredGuard = false;
      if (counteredGuard) player.state = C.STATES.IDLE;
      else this.enterGCD(player, 1);
    }
  }

  stepCharging(player, s, dtMs) {
    player.angle = s.aimAngle;
    const speed = this.moveSpeed(player, s, C.BASE_SPEED * C.CHARGE_SPEED_FACTOR);
    if (s.wantsMove) {
      const nx = player.x + Math.cos(player.angle) * speed * (dtMs / 1000);
      const ny = player.y + Math.sin(player.angle) * speed * (dtMs / 1000);
      if (!this.hitsObstacle(nx, ny)) {
        player.x = nx;
        player.y = ny;
      }
    }
    const qDash = C.classSkills(player.classId).qDash;
    player.chargeTime = Math.min(player.chargeTime + dtMs, qDash.MAX_CHARGE_MS);

    if (!s.qHeld) {
      const ratio = player.chargeTime / qDash.MAX_CHARGE_MS;
      const distance = qDash.MIN_DISTANCE + (qDash.MAX_DISTANCE - qDash.MIN_DISTANCE) * ratio;
      s.dash = {
        dx: Math.cos(player.angle),
        dy: Math.sin(player.angle),
        remaining: distance,
        lethal: qDash.LETHAL !== false,
        pierce: qDash.PIERCE !== false,
        knockbackDistance: qDash.KNOCKBACK_DISTANCE,
        knockbackSpeed: qDash.KNOCKBACK_SPEED,
      };
      s.dashKilled = false;
      player.state = C.STATES.DASH;
    }
  }

  // Sub-steps the dash in small increments so it stops right at an
  // obstacle's edge instead of overshooting into (or short of) it —
  // a single full-tick step at dash speed would otherwise move too far at a
  // time, too coarse to resolve wall contact precisely.
  stepDash(player, s, dtMs) {
    if (!s.dash) {
      this.enterGCD(player, 1);
      return;
    }
    const totalStep = Math.min((C.classSkills(player.classId).qDash.SPEED * dtMs) / 1000, s.dash.remaining);
    const subSteps = Math.max(1, Math.ceil(totalStep / 8));
    const perStep = totalStep / subSteps;
    let stoppedByWall = false;

    for (let i = 0; i < subSteps; i++) {
      const nx = player.x + s.dash.dx * perStep;
      const ny = player.y + s.dash.dy * perStep;
      if (this.hitsObstacle(nx, ny)) {
        stoppedByWall = true;
        break;
      }
      player.x = nx;
      player.y = ny;
      s.dash.remaining -= perStep;
    }

    if (stoppedByWall) {
      s.dash = null;
      const killed = s.dashKilled;
      s.dashKilled = false;
      if (killed) player.state = C.STATES.IDLE;
      else this.applyStun(player, s, C.WALL_STUN_MS);
      return;
    }

    if (s.dash.remaining <= 0.01) {
      s.dash = null;
      const killed = s.dashKilled;
      s.dashKilled = false;
      if (killed) {
        player.state = C.STATES.IDLE;
      } else if (C.classSkills(player.classId).skillTypes.q === "comboDash") {
        // comboDash always opens a brief follow-up window on completion
        // (whiff or a landed knockback hit alike), unless it killed — see
        // stepComboWindow(). Not reachable via the wall-stop branch above
        // since a wall interrupt is always a "failure", never a landed hit.
        player.state = C.STATES.COMBO_WINDOW;
        s.stateTimer = C.classSkills(player.classId).comboWindow.WINDOW_MS;
      } else {
        this.enterGCD(player, 1);
      }
    }
  }

  enterGCD(player, multiplier) {
    player.state = C.STATES.GCD;
    player.globalCooldown = C.GLOBAL_COOLDOWN_MS * multiplier;
  }

  // Warrior's battle cry / Mage's fluid state, both first-phase — server-side
  // port of Combatant.isInvincible. kill()/applyStun()/applyKnockback() all
  // guard on this, so any current or future skill's hit-application respects
  // it for free. Does NOT protect against ring-out/pit deaths — those are
  // positional, not a "hit" (matches Combatant.isInvincible).
  isInvincible(player, s) {
    if (player.state === C.STATES.BATTLE_CRY) {
      const cfg = C.classSkills(player.classId).battleCry;
      return s.stateTimer > cfg.TOTAL_MS - cfg.DURATION_MS;
    }
    if (player.state === C.STATES.FLUID) {
      const cfg = C.classSkills(player.classId).fluidState;
      return s.stateTimer > cfg.TOTAL_MS - cfg.DURATION_MS;
    }
    return false;
  }

  // Reward for a successful W block (an attacker punished by invincibility)
  // or a successful E freeze (see checkBlizzard): Q's charge-completion
  // threshold drops until it's used or the buff silently expires. No-op for
  // classes without a fastCharge config (everyone but Mage, so far) — mirrors
  // Combatant._grantFastCharge exactly, granted to the blocked/invincible
  // party (or the E-freeze's caster), never the attacker being punished.
  grantFastCharge(player, s) {
    const cfg = C.classSkills(player.classId).fastCharge;
    if (!cfg) return;
    s.fastChargeMs = cfg.DURATION_MS;
    player.fastChargeActive = true;
  }

  // Mirrors Combatant.laserMinChargeMs — normally laserBeam.MIN_CHARGE_MS,
  // but a live fastCharge buff temporarily drops it to fastCharge.CHARGE_MS.
  laserMinChargeMs(player, s) {
    const laser = C.classSkills(player.classId).laserBeam;
    const fastCharge = C.classSkills(player.classId).fastCharge;
    if (s.fastChargeMs > 0 && fastCharge) return fastCharge.CHARGE_MS;
    return laser.MIN_CHARGE_MS;
  }

  // `bypassInvincible`: by default a hit blocked by invincibility stuns the
  // attacker instead (Q-family and a plain, non-guard-beating hit); E-family
  // callers that are designed to beat W/invincibility outright pass `true`.
  // See Combatant.applyStun's matching comment for the full contract.
  applyStun(player, s, durationMs, bypassInvincible = false) {
    if (!player.isAlive) return;
    if (this.isInvincible(player, s) && !bypassInvincible) {
      // End the cast right now instead of waiting out the rest of its
      // duration — same immediate-response shape as a normal tap-parry's
      // block, and skips GCD entirely (goes straight to IDLE).
      player.state = C.STATES.IDLE;
      this.grantFastCharge(player, s);
      return;
    }
    s.dash = null;
    player.state = C.STATES.STUNNED;
    player.stunTimer = durationMs;
  }

  // sourceSessionId: who caused this knockback, if anyone — stamped onto the
  // target's scratch so a later ring-out/pit death (checkRingOuts/
  // checkPitDeaths) can credit the pusher instead of crediting no one, the
  // same way a direct dash kill already credits the dasher. Also doubles as
  // "who to stun back" if this knockback is blocked by invincibility (see
  // applyStun's bypassInvincible comment above — same contract).
  applyKnockback(player, s, fromAngle, distance, speed, sourceSessionId = null, bypassInvincible = false) {
    if (!player.isAlive) return;
    if (this.isInvincible(player, s) && !bypassInvincible) {
      if (sourceSessionId) {
        const attacker = this.state.players.get(sourceSessionId);
        const as = this.scratch.get(sourceSessionId);
        if (attacker) this.applyStun(attacker, as, C.STUN_DURATION_MS);
      }
      player.state = C.STATES.IDLE;
      this.grantFastCharge(player, s);
      return;
    }
    s.knockback = {
      dx: Math.cos(fromAngle),
      dy: Math.sin(fromAngle),
      remainingMs: (distance / speed) * 1000,
      speed,
    };
    s.lastKnockedBackBy = sourceSessionId;
    s.lastKnockedBackAt = Date.now();
  }

  // `attacker`, if given, gets stunned when the kill is blocked by
  // invincibility — attacking a battle-cry Warrior in range is punished,
  // same shape as failing a Q-vs-parry check. Only Q-family skills call
  // kill(), so bypassInvincible has no equivalent here (mirrors Combatant.kill()).
  kill(target, ts, killerSessionId = null) {
    if (!target.isAlive) return;
    if (this.isInvincible(target, ts)) {
      if (killerSessionId) {
        const attacker = this.state.players.get(killerSessionId);
        const as = this.scratch.get(killerSessionId);
        if (attacker) this.applyStun(attacker, as, C.STUN_DURATION_MS);
      }
      target.state = C.STATES.IDLE;
      this.grantFastCharge(target, ts);
      return;
    }
    target.isAlive = false;
    target.state = C.STATES.DEAD;
    ts.dash = null;
    ts.knockback = null;
    ts.respawnClock = C.RESPAWN_DELAY_MS;
    // See respawn()'s matching reset: a pending W/E latch shouldn't survive
    // death even before we get there.
    ts.wPressed = false;
    ts.ePressed = false;
    ts.qPressed = false;
    ts.shieldCharge = null;
    ts.empoweredQMs = 0;
    target.empoweredQActive = false;
    ts.skillsDisabledMs = 0;
    target.skillsDisabled = false;
    ts.slam = null;
    ts.fastChargeMs = 0;
    target.fastChargeActive = false;
    ts.slowedMs = 0;
    target.slowed = false;
    this._onPlayerDied(killerSessionId);
  }

  // Shared by every Q-family hit-check (checkDashHits/checkComboAttack/
  // checkEmpoweredStrike) for the "attack lands on a PARRYING target"
  // outcome: stuns the attacker, exempts the defender's own GCD, and (for
  // heldGuard classes) grants the empowered-Q buff — mirrors Combatant.
  // parrySuccess() being the single call site every single-player attack-
  // vs-guard check routes through. Keep new Q-family attack types calling
  // this instead of re-inlining the four lines, so the buff grant can't
  // silently go missing from just one of them again (as checkComboAttack/
  // checkEmpoweredStrike previously did before this helper existed).
  _grantParryCounter(attacker, as, defender, ds) {
    ds.parrySuccess = true;
    defender.state = C.STATES.IDLE; // exempt from GCD
    this.applyStun(attacker, as, C.STUN_DURATION_MS);
    if (C.classSkills(defender.classId).skillTypes.w === "heldGuard") {
      ds.empoweredQMs = C.classSkills(defender.classId).empoweredQBuff.DURATION_MS;
      defender.empoweredQActive = true;
    }
  }

  // Class-agnostic: reads the outcome fields resolved onto ds.dash at
  // release time (see stepCharging/startComboDash) instead of assuming
  // every Q dash is an instakill piercing hit — swordsman's dash is
  // (lethal, pierce), Knight's comboDash is (knockback, non-piercing)
  // unless empowered. W (parrying) beats Q by stunning the dasher instead
  // and skipping the parrier's own GCD — same triangle as Combatant.js.
  checkDashHits() {
    const entries = [...this.state.players.entries()];
    for (const [dasherId, dasher] of entries) {
      if (dasher.state !== C.STATES.DASH) continue;
      const ds = this.scratch.get(dasherId);
      for (const [otherId, other] of entries) {
        if (otherId === dasherId || !other.isAlive) continue;
        const dist = Math.hypot(dasher.x - other.x, dasher.y - other.y);
        if (dist > C.PLAYER_RADIUS * 2) continue;

        const os = this.scratch.get(otherId);
        if (other.state === C.STATES.PARRYING) {
          if (!os.parrySuccess) this._grantParryCounter(dasher, ds, other, os);
          break; // dasher is stunned now (ds.dash is null); stop it piercing further targets
        } else if (other.state === C.STATES.DASH && ds.dash.lethal && os.dash.lethal) {
          // Both mid-dash, overlapping, and both lethal: a same-tick clash
          // (the two presses were close enough to land in one 16ms server
          // tick, see C.SIMULATION_INTERVAL_MS) used to resolve in favor of
          // whichever player iterates first in this.state.players (~join
          // order) — an unintended side effect of the loop order, not real
          // timing. Both dashes connect: no killer credited, it's a draw.
          // (A non-lethal comboDash colliding with another dasher just falls
          // through to the plain-hit branch below instead of this mutual-
          // kill shape — knockback has no equivalent "draw" concept.)
          this.kill(other, os, null);
          this.kill(dasher, ds, null);
          break; // dasher is dead now; stop it piercing further targets
        } else if (ds.dash.lethal) {
          this.kill(other, os, dasherId);
          ds.dashKilled = true;
        } else {
          this.applyKnockback(other, os, dasher.angle, ds.dash.knockbackDistance, ds.dash.knockbackSpeed, dasherId);
          if (!ds.dash.pierce) ds.dash.remaining = 0; // stop right at the hit
        }
      }
    }
  }

  // E only stuns when it counters a parry (beats W); a plain hit on anyone
  // else is knockback-only, matching the single-player balance change.
  checkKicks() {
    const entries = [...this.state.players.entries()];
    for (const [kickerId, kicker] of entries) {
      const ks = this.scratch.get(kickerId);
      const eKick = C.classSkills(kicker.classId).eKick;
      const active =
        kicker.state === C.STATES.KICKING &&
        !ks.kickHitApplied &&
        ks.stateTimer <= eKick.TOTAL_MS &&
        ks.stateTimer > eKick.TOTAL_MS - eKick.ACTIVE_MS;
      if (!active) continue;
      const halfAngle = (eKick.HALF_ANGLE_DEG * Math.PI) / 180;

      for (const [targetId, target] of entries) {
        if (targetId === kickerId || !target.isAlive) continue;
        const dist = Math.hypot(kicker.x - target.x, kicker.y - target.y);
        if (dist > eKick.RANGE + C.PLAYER_RADIUS) continue;
        const angleToTarget = Math.atan2(target.y - kicker.y, target.x - kicker.x);
        const diff = angleWrap(angleToTarget - kicker.angle);
        if (Math.abs(diff) > halfAngle) continue;

        const ts = this.scratch.get(targetId);
        const counteredParry = target.state === C.STATES.PARRYING;
        if (counteredParry) this.applyStun(target, ts, eKick.STUN_MS);
        // E beats W/invincibility outright — always bypasses.
        this.applyKnockback(target, ts, kicker.angle, eKick.KNOCKBACK_DISTANCE, eKick.KNOCKBACK_SPEED, kickerId, true);
        ks.kickHitApplied = true;
        ks.kickCounteredParry = counteredParry;
      }
    }
  }

  // Knight combo follow-up swing — same cone hit-test shape as checkKicks,
  // over the comboAttack tuning instead of eKick. It's a Q-family strike, so
  // it still loses to a raised shield (same triangle edge as the base Q
  // dash) — but a clean hit on anyone else is an instakill, not knockback.
  checkComboAttack() {
    const entries = [...this.state.players.entries()];
    for (const [attackerId, attacker] of entries) {
      const as = this.scratch.get(attackerId);
      const combo = C.classSkills(attacker.classId).comboAttack;
      const active =
        attacker.state === C.STATES.COMBO_ATTACK &&
        !as.comboHitApplied &&
        as.stateTimer <= combo.TOTAL_MS &&
        as.stateTimer > combo.TOTAL_MS - combo.ACTIVE_MS;
      if (!active) continue;
      const halfAngle = (combo.HALF_ANGLE_DEG * Math.PI) / 180;

      for (const [targetId, target] of entries) {
        if (targetId === attackerId || !target.isAlive) continue;
        const dist = Math.hypot(attacker.x - target.x, attacker.y - target.y);
        if (dist > combo.RANGE + C.PLAYER_RADIUS) continue;
        const angleToTarget = Math.atan2(target.y - attacker.y, target.x - attacker.x);
        const diff = angleWrap(angleToTarget - attacker.angle);
        if (Math.abs(diff) > halfAngle) continue;

        const ts = this.scratch.get(targetId);
        if (target.state === C.STATES.PARRYING) {
          if (!ts.parrySuccess) this._grantParryCounter(attacker, as, target, ts);
          continue;
        }

        as.comboHitApplied = true;
        this.kill(target, ts, attackerId);
      }
    }
  }

  // Knight empowered Q: a stationary rectangle hit-test along the
  // attacker's facing direction — projects each target's offset onto the
  // facing axis (along) and its perpendicular (perp) instead of a circle/
  // cone check, since this is a straight-line AOE. Still loses to a raised
  // shield (same triangle edge as the base Q dash); a clean hit on anyone
  // else is an instakill.
  checkEmpoweredStrike() {
    const entries = [...this.state.players.entries()];
    for (const [attackerId, attacker] of entries) {
      const as = this.scratch.get(attackerId);
      const cfg = C.classSkills(attacker.classId).empoweredStrike;
      const active =
        attacker.state === C.STATES.EMPOWERED_STRIKE &&
        !as.empoweredStrikeHitApplied &&
        as.stateTimer <= cfg.TOTAL_MS &&
        as.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS;
      if (!active) continue;
      const halfW = cfg.WIDTH / 2;
      const cos = Math.cos(attacker.angle);
      const sin = Math.sin(attacker.angle);

      for (const [targetId, target] of entries) {
        if (targetId === attackerId || !target.isAlive) continue;
        const relX = target.x - attacker.x;
        const relY = target.y - attacker.y;
        const along = relX * cos + relY * sin;
        const perp = -relX * sin + relY * cos;
        if (along < -C.PLAYER_RADIUS || along > cfg.LENGTH + C.PLAYER_RADIUS) continue;
        if (Math.abs(perp) > halfW + C.PLAYER_RADIUS) continue;

        const ts = this.scratch.get(targetId);
        if (target.state === C.STATES.PARRYING) {
          if (!ts.parrySuccess) this._grantParryCounter(attacker, as, target, ts);
          as.empoweredStrikeHitApplied = true;
          continue;
        }

        as.empoweredStrikeHitApplied = true;
        this.kill(target, ts, attackerId);
      }
    }
  }

  // Knight shield charge (E) — a short forward dash-charge; hitting a
  // guarding (PARRYING) target beats it outright for stronger knockback +
  // a stun, GCD-exempt (same triangle edge as E-beats-W everywhere else).
  // No parrySuccess()-style counter here — the charger is never punished,
  // matching the single-player design (see Combatant._checkShieldCharge).
  checkShieldCharge() {
    const entries = [...this.state.players.entries()];
    for (const [chargerId, charger] of entries) {
      if (charger.state !== C.STATES.SHIELD_CHARGE) continue;
      const cs = this.scratch.get(chargerId);
      if (!cs.shieldCharge) continue;
      const cfg = C.classSkills(charger.classId).eShieldCharge;

      for (const [targetId, target] of entries) {
        if (targetId === chargerId || !target.isAlive) continue;
        const dist = Math.hypot(charger.x - target.x, charger.y - target.y);
        if (dist > C.PLAYER_RADIUS * 2) continue;

        const ts = this.scratch.get(targetId);
        const vsGuard = target.state === C.STATES.PARRYING;
        if (vsGuard) {
          // Beats a raised guard outright — always bypasses.
          this.applyStun(target, ts, cfg.VS_GUARD_STUN_MS, true);
          this.applyKnockback(
            target,
            ts,
            charger.angle,
            cfg.VS_GUARD_KNOCKBACK_DISTANCE,
            cfg.VS_GUARD_KNOCKBACK_SPEED,
            chargerId,
            true
          );
        } else {
          // Plain hit — respects invincibility, same as any other Q-family
          // interaction (a battle cry blocks this and punishes the charger).
          this.applyKnockback(target, ts, charger.angle, cfg.KNOCKBACK_DISTANCE, cfg.KNOCKBACK_SPEED, chargerId);
        }
        cs.shieldChargeCounteredGuard = vsGuard;
        cs.shieldCharge.remaining = 0; // stop right at the hit, non-piercing
      }
    }
  }

  // Warrior Q: instant 360-degree hit around self — plain distance test, no
  // angle check (simplest correct shape for "everywhere around me"). Still
  // loses to a raised shield/invincibility, same triangle edge as every
  // other Q (handled for free by kill()'s isInvincible guard).
  checkAxeSwing() {
    const entries = [...this.state.players.entries()];
    for (const [attackerId, attacker] of entries) {
      const as = this.scratch.get(attackerId);
      const cfg = C.classSkills(attacker.classId).axeSwing;
      const active =
        attacker.state === C.STATES.AXE_SWING &&
        !as.axeSwingHitApplied &&
        as.stateTimer <= cfg.TOTAL_MS &&
        as.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS;
      if (!active) continue;

      for (const [targetId, target] of entries) {
        if (targetId === attackerId || !target.isAlive) continue;
        const dist = Math.hypot(attacker.x - target.x, attacker.y - target.y);
        if (dist > cfg.RADIUS + C.PLAYER_RADIUS) continue;

        const ts = this.scratch.get(targetId);
        if (target.state === C.STATES.PARRYING) {
          if (!ts.parrySuccess) {
            ts.parrySuccess = true;
            target.state = C.STATES.IDLE;
            this.applyStun(attacker, as, C.STUN_DURATION_MS);
          }
          as.axeSwingHitApplied = true;
          continue;
        }

        as.axeSwingHitApplied = true;
        this.kill(target, ts, attackerId);
      }
    }
  }

  // Warrior W: a one-shot AOE debuff burst that fires DISABLE_DELAY_MS after
  // invincibility ends — not a kill/stun/knockback call, so it's unaffected
  // by the isInvincible guard on those. A raised shield blocks it outright
  // with no punishment to the attacker (pure block, not a Q-vs-W counter).
  checkBattleCryShout() {
    const entries = [...this.state.players.entries()];
    for (const [attackerId, attacker] of entries) {
      const as = this.scratch.get(attackerId);
      const cfg = C.classSkills(attacker.classId).battleCry;
      const active =
        attacker.state === C.STATES.BATTLE_CRY && !as.battleCryShoutApplied && as.stateTimer <= cfg.ACTIVE_MS;
      if (!active) continue;

      for (const [targetId, target] of entries) {
        if (targetId === attackerId || !target.isAlive) continue;
        const dist = Math.hypot(attacker.x - target.x, attacker.y - target.y);
        if (dist > cfg.SHOUT_RADIUS + C.PLAYER_RADIUS) continue;

        const ts = this.scratch.get(targetId);
        if (target.state === C.STATES.PARRYING) {
          if (!ts.parrySuccess) {
            ts.parrySuccess = true;
            target.state = C.STATES.IDLE;
          }
          continue;
        }

        ts.skillsDisabledMs = cfg.DISABLE_MS;
        target.skillsDisabled = true;
      }
      as.battleCryShoutApplied = true;
    }
  }

  // Warrior E, landing: a stationary circle hit-test centered on wherever
  // the leap actually ended up, radius resolved at release time from the
  // charge ratio (s.slam.impactRadius). Landing on a guarding OR invincible
  // target just stuns them instead of a counter — E beats both outright,
  // unlike every other class's W-interaction so far.
  checkSlamImpact() {
    const entries = [...this.state.players.entries()];
    for (const [attackerId, attacker] of entries) {
      const as = this.scratch.get(attackerId);
      const cfg = C.classSkills(attacker.classId).divingSlam;
      const active =
        attacker.state === C.STATES.SLAM_IMPACT &&
        !as.slamImpactHitApplied &&
        as.stateTimer <= cfg.TOTAL_MS &&
        as.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS;
      if (!active) continue;
      const radius = as.slam ? as.slam.impactRadius : cfg.MIN_IMPACT_RADIUS;

      for (const [targetId, target] of entries) {
        if (targetId === attackerId || !target.isAlive) continue;
        const dist = Math.hypot(attacker.x - target.x, attacker.y - target.y);
        if (dist > radius + C.PLAYER_RADIUS) continue;

        const ts = this.scratch.get(targetId);
        const vsGuard = target.state === C.STATES.PARRYING;
        const invincibleBroken = this.isInvincible(target, ts); // checked before any mutation below
        if (vsGuard || invincibleBroken) {
          this.applyStun(target, ts, cfg.VS_GUARD_STUN_MS, true);
        } else {
          this.applyKnockback(target, ts, attacker.angle, cfg.KNOCKBACK_DISTANCE, cfg.KNOCKBACK_SPEED, attackerId);
        }
        as.slamImpactHitApplied = true;
      }
    }
  }

  // Mage Q: a stationary rectangle hit-test along the attacker's facing
  // direction — same along/perp projection as checkEmpoweredStrike, since
  // this is also a straight-line AOE. length/width are re-derived here from
  // the still-valid player.chargeTime (server never resets it through the
  // fire window — see stepLaserCharge) via the same fastCharge-aware ratio
  // stepLaserCharge used at release, instead of caching a separate object.
  // Still loses to a raised shield/invincibility (Q-family, via kill()'s
  // centralized guard); a clean hit is an instakill.
  checkLaserFire() {
    const entries = [...this.state.players.entries()];
    for (const [attackerId, attacker] of entries) {
      const as = this.scratch.get(attackerId);
      const cfg = C.classSkills(attacker.classId).laserBeam;
      const active =
        attacker.state === C.STATES.LASER_FIRE &&
        !as.laserFireHitApplied &&
        as.stateTimer <= cfg.TOTAL_MS &&
        as.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS;
      if (!active) continue;
      const minChargeMs = this.laserMinChargeMs(attacker, as);
      const ratio = Math.max(0, Math.min(1, (attacker.chargeTime - minChargeMs) / (cfg.MAX_CHARGE_MS - minChargeMs)));
      const length = cfg.MIN_LENGTH + (cfg.MAX_LENGTH - cfg.MIN_LENGTH) * ratio;
      const halfW = (cfg.MIN_WIDTH + (cfg.MAX_WIDTH - cfg.MIN_WIDTH) * ratio) / 2;
      const cos = Math.cos(attacker.angle);
      const sin = Math.sin(attacker.angle);

      for (const [targetId, target] of entries) {
        if (targetId === attackerId || !target.isAlive) continue;
        const relX = target.x - attacker.x;
        const relY = target.y - attacker.y;
        const along = relX * cos + relY * sin;
        const perp = -relX * sin + relY * cos;
        if (along < -C.PLAYER_RADIUS || along > length + C.PLAYER_RADIUS) continue;
        if (Math.abs(perp) > halfW + C.PLAYER_RADIUS) continue;

        const ts = this.scratch.get(targetId);
        if (target.state === C.STATES.PARRYING) {
          if (!ts.parrySuccess) {
            ts.parrySuccess = true;
            target.state = C.STATES.IDLE;
            this.applyStun(attacker, as, C.STUN_DURATION_MS);
          }
          as.laserFireHitApplied = true;
          continue;
        }

        as.laserFireHitApplied = true;
        this.kill(target, ts, attackerId);
      }
    }
  }

  // Mage E: a wide instant 180-degree cone (RANGE/HALF_ANGLE_DEG, same shape
  // as checkKicks) fired once per activation. A plain hit slows the target
  // for a second; like every other class's E, it beats W outright — landing
  // on a PARRYING *or* currently-invincible target freezes (stuns) them
  // instead, "failing" their W/invincibility the same way E beats Warrior's
  // battle cry, and grants the caster a fastCharge buff for the free next Q.
  checkBlizzard() {
    const entries = [...this.state.players.entries()];
    for (const [attackerId, attacker] of entries) {
      const as = this.scratch.get(attackerId);
      const cfg = C.classSkills(attacker.classId).blizzard;
      const active =
        attacker.state === C.STATES.BLIZZARD &&
        !as.blizzardHitApplied &&
        as.stateTimer <= cfg.TOTAL_MS &&
        as.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS;
      if (!active) continue;
      const halfAngle = (cfg.HALF_ANGLE_DEG * Math.PI) / 180;
      let counteredGuard = false; // froze at least one PARRYING/invincible target -> skip GCD

      for (const [targetId, target] of entries) {
        if (targetId === attackerId || !target.isAlive) continue;
        const dist = Math.hypot(attacker.x - target.x, attacker.y - target.y);
        if (dist > cfg.RANGE + C.PLAYER_RADIUS) continue;
        const angleToTarget = Math.atan2(target.y - attacker.y, target.x - attacker.x);
        const diff = angleWrap(angleToTarget - attacker.angle);
        if (Math.abs(diff) > halfAngle) continue;

        const ts = this.scratch.get(targetId);
        const vsGuard = target.state === C.STATES.PARRYING;
        const invincibleBroken = this.isInvincible(target, ts); // checked before any mutation below
        if (vsGuard || invincibleBroken) {
          this.applyStun(target, ts, cfg.VS_GUARD_STUN_MS, true);
          this.grantFastCharge(attacker, as);
          counteredGuard = true;
        } else {
          ts.slowedMs = cfg.SLOW_MS;
          target.slowed = true;
        }
      }
      as.blizzardHitApplied = true;
      as.blizzardCounteredGuard = counteredGuard;
    }
  }
}

module.exports = ArenaRoom;
