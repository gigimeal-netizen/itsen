const { Room } = require("@colyseus/core");
const { ArenaRoomState, PlayerState, RectState } = require("../schema/ArenaRoomState");
const { generateSymmetricLayout } = require("../layoutGenerator");
const C = require("../constants");

// Phase 3 merge: server-authoritative movement, the Q/W/E state machine,
// hit detection, AND arena hazards (obstacle walls, octagon ring-out,
// permanent pits/quicksand) — a server-side port of both Combatant.js and
// ArenaScene's hazard logic, minus Phaser/Arcade physics. 4-player FFA: no
// lobby/ready-check UI — see startCountdown()/JOIN_GRACE_MS below for how
// a match actually kicks off.
const SPAWN_POINTS = C.NET_SPAWN_POINTS.map((s) => ({
  x: C.ARENA_WIDTH * s.x,
  y: C.ARENA_HEIGHT * s.y,
}));

// Must match the swatch count in NetArenaScene's PLAYER_COLORS palette —
// a client-picked colorIndex outside this range is rejected in favor of a
// seat-based fallback (see onJoin() below).
const COLOR_COUNT = 6;
const DEFAULT_NICKNAME = "전사";

function sanitizeNickname(raw) {
  if (typeof raw !== "string") return DEFAULT_NICKNAME;
  const trimmed = raw.trim().slice(0, 12);
  return trimmed || DEFAULT_NICKNAME;
}

function sanitizeColorIndex(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < COLOR_COUNT ? n : fallback;
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
      // Only latch W/E while actually IDLE — tryStartSkills() is the sole
      // consumer and only runs from that state. Without this guard, a
      // press during GCD/CHARGING/DASH/PARRYING/KICKING/STUNNED sat on the
      // flag until the player next reached IDLE and fired there completely
      // unprompted (often well after the key was released), which is what
      // read as "input eaten, then stutters" under key-mashing — the client
      // predicts nothing here (PredictedSelf only calls _tryStartSkills
      // from IDLE, non-latching), so this also removes a client/server
      // prediction mismatch, not just the surprise fire.
      if (msg.wPressed && player && player.state === C.STATES.IDLE) s.wPressed = true;
      if (msg.ePressed && player && player.state === C.STATES.IDLE) s.ePressed = true;
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
  // "/rooms" endpoint) — name (chosen once, at creation), current mode, and
  // active-seat counts. Player counts need to be here explicitly (rather
  // than relying on Colyseus's own live `clients` count) because `clients`
  // includes spectators, up to MAX_CLIENTS (16) — not the 4-seat cap the
  // lobby actually needs to know about to grey out "입장" on a full match.
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
    // Past the 4 active seats (or an explicit "관전하기" request), a joiner
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

    const player = new PlayerState();
    player.id = client.sessionId;
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
    player.colorIndex = sanitizeColorIndex(options?.colorIndex, index % COLOR_COUNT);
    const existingNicknames = new Set([...this.state.players.values()].map((p) => p.nickname));
    player.nickname = dedupeNickname(sanitizeNickname(options?.nickname), existingNicknames);
    this.state.players.set(client.sessionId, player);

    this.scratch.set(client.sessionId, {
      spawnX: spawn.x,
      spawnY: spawn.y,
      wantsMove: false,
      aimAngle: 0,
      qHeld: false,
      wPressed: false,
      ePressed: false,
      pendingInputSeq: 0, // see onMessage("input")/tick() — published to player.lastInputSeq only after stepPlayer() applies it
      dash: null,
      dashKilled: false,
      kickHitApplied: false,
      kickCounteredParry: false,
      parrySuccess: false,
      knockback: null,
      stateTimer: 0,
      respawnClock: 0,
    });

    console.log(`[arena] ${client.sessionId} joined (${this.state.players.size}/${C.MAX_PLAYERS})`);

    // No lobby/ready-check: full room starts immediately; 2+ opens a join
    // grace window (reset by every new joiner) so people trickling in over
    // a few seconds still land in the same match instead of each having to
    // be the one that fills the last seat.
    if (this.state.players.size === C.MAX_PLAYERS) {
      this.joinGraceMs = null;
      this.startCountdown();
    } else if (this.state.players.size >= 2 && this.state.matchPhase === "waiting") {
      this.joinGraceMs = C.JOIN_GRACE_MS;
    }
    this._updateMetadata();
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

    if (this.state.players.size < 2) {
      // Can't run a match solo — back to waiting for someone else.
      this.state.matchPhase = "waiting";
      this.state.phaseTimer = 0;
      this.joinGraceMs = null;
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
    // A W/E press latched in onMessage("input") right before death (or any
    // time while dead — the client keeps sending input, tryStartSkills()
    // just never runs for a dead player to consume it) would otherwise
    // survive in the scratch record and fire the instant this player
    // becomes IDLE again, as a "phantom" skill use they never intended
    // post-respawn.
    s.wPressed = false;
    s.ePressed = false;
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

  checkRingOuts() {
    for (const [sessionId, player] of this.state.players.entries()) {
      if (!player.isAlive) continue;
      if (!this.isInsideFloor(player.x, player.y)) {
        this.kill(player, this.scratch.get(sessionId));
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
          this.kill(player, this.scratch.get(sessionId));
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
        s.stateTimer -= dtMs;
        if (s.stateTimer <= 0) this.enterGCD(player, C.FAILED_PARRY_GCD_MULTIPLIER);
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
      default:
        break;
    }
  }

  // Blocked by obstacle walls; quicksand slows this movement (Q dash ignores
  // the slow zone entirely, matching the single-player rule).
  moveIdleLike(player, s, dtMs, baseSpeed) {
    player.angle = s.aimAngle;
    if (!s.wantsMove) return;
    const speed = this.isInQuicksand(player.x, player.y) ? baseSpeed * C.SLOW_ZONE_FACTOR : baseSpeed;
    const nx = player.x + Math.cos(player.angle) * speed * (dtMs / 1000);
    const ny = player.y + Math.sin(player.angle) * speed * (dtMs / 1000);
    if (!this.hitsObstacle(nx, ny)) {
      player.x = nx;
      player.y = ny;
    }
  }

  tryStartSkills(player, s) {
    if (s.qHeld) {
      player.chargeTime = 0;
      s.dash = null;
      player.state = C.STATES.CHARGING;
      return;
    }
    if (s.wPressed) {
      s.wPressed = false;
      player.state = C.STATES.PARRYING;
      s.stateTimer = C.W_PARRY.DURATION_MS;
      s.parrySuccess = false;
      return;
    }
    if (s.ePressed) {
      s.ePressed = false;
      player.state = C.STATES.KICKING;
      s.stateTimer = C.E_KICK.TOTAL_MS;
      s.kickHitApplied = false;
      s.kickCounteredParry = false;
    }
  }

  stepCharging(player, s, dtMs) {
    player.angle = s.aimAngle;
    let speed = C.BASE_SPEED * C.CHARGE_SPEED_FACTOR;
    if (this.isInQuicksand(player.x, player.y)) speed *= C.SLOW_ZONE_FACTOR;
    if (s.wantsMove) {
      const nx = player.x + Math.cos(player.angle) * speed * (dtMs / 1000);
      const ny = player.y + Math.sin(player.angle) * speed * (dtMs / 1000);
      if (!this.hitsObstacle(nx, ny)) {
        player.x = nx;
        player.y = ny;
      }
    }
    player.chargeTime = Math.min(player.chargeTime + dtMs, C.Q_DASH.MAX_CHARGE_MS);

    if (!s.qHeld) {
      const ratio = player.chargeTime / C.Q_DASH.MAX_CHARGE_MS;
      const distance = C.Q_DASH.MIN_DISTANCE + (C.Q_DASH.MAX_DISTANCE - C.Q_DASH.MIN_DISTANCE) * ratio;
      s.dash = { dx: Math.cos(player.angle), dy: Math.sin(player.angle), remaining: distance };
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
    const totalStep = Math.min((C.Q_DASH.SPEED * dtMs) / 1000, s.dash.remaining);
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
      if (killed) player.state = C.STATES.IDLE;
      else this.enterGCD(player, 1);
    }
  }

  enterGCD(player, multiplier) {
    player.state = C.STATES.GCD;
    player.globalCooldown = C.GLOBAL_COOLDOWN_MS * multiplier;
  }

  applyStun(player, s, durationMs) {
    if (!player.isAlive) return;
    s.dash = null;
    player.state = C.STATES.STUNNED;
    player.stunTimer = durationMs;
  }

  applyKnockback(player, s, fromAngle, distance, speed) {
    if (!player.isAlive) return;
    s.knockback = {
      dx: Math.cos(fromAngle),
      dy: Math.sin(fromAngle),
      remainingMs: (distance / speed) * 1000,
      speed,
    };
  }

  kill(target, ts, killerSessionId = null) {
    if (!target.isAlive) return;
    target.isAlive = false;
    target.state = C.STATES.DEAD;
    ts.dash = null;
    ts.knockback = null;
    ts.respawnClock = C.RESPAWN_DELAY_MS;
    // See respawn()'s matching reset: a pending W/E latch shouldn't survive
    // death even before we get there.
    ts.wPressed = false;
    ts.ePressed = false;
    this._onPlayerDied(killerSessionId);
  }

  // Q beats nothing but a raw hit; W (parrying) beats Q by stunning the
  // dasher instead and skipping the parrier's own GCD — same triangle as
  // the single-player Combatant.js.
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
          if (!os.parrySuccess) {
            os.parrySuccess = true;
            other.state = C.STATES.IDLE; // exempt from GCD
            this.applyStun(dasher, ds, C.STUN_DURATION_MS);
          }
        } else if (other.state === C.STATES.DASH) {
          // Both mid-dash and overlapping: a same-tick clash (the two
          // presses were close enough to land in one 16ms server tick, see
          // C.SIMULATION_INTERVAL_MS) used to resolve in favor of whichever
          // player iterates first in this.state.players (~join order) —
          // an unintended side effect of the loop order, not real timing.
          // Both dashes connect: no killer credited, it's a draw.
          this.kill(other, os, null);
          this.kill(dasher, ds, null);
          break; // dasher is dead now; stop it piercing further targets
        } else {
          this.kill(other, os, dasherId);
          ds.dashKilled = true;
        }
      }
    }
  }

  // E only stuns when it counters a parry (beats W); a plain hit on anyone
  // else is knockback-only, matching the single-player balance change.
  checkKicks() {
    const halfAngle = (C.E_KICK.HALF_ANGLE_DEG * Math.PI) / 180;
    const entries = [...this.state.players.entries()];
    for (const [kickerId, kicker] of entries) {
      const ks = this.scratch.get(kickerId);
      const active =
        kicker.state === C.STATES.KICKING &&
        !ks.kickHitApplied &&
        ks.stateTimer <= C.E_KICK.TOTAL_MS &&
        ks.stateTimer > C.E_KICK.TOTAL_MS - C.E_KICK.ACTIVE_MS;
      if (!active) continue;

      for (const [targetId, target] of entries) {
        if (targetId === kickerId || !target.isAlive) continue;
        const dist = Math.hypot(kicker.x - target.x, kicker.y - target.y);
        if (dist > C.E_KICK.RANGE + C.PLAYER_RADIUS) continue;
        const angleToTarget = Math.atan2(target.y - kicker.y, target.x - kicker.x);
        const diff = angleWrap(angleToTarget - kicker.angle);
        if (Math.abs(diff) > halfAngle) continue;

        const ts = this.scratch.get(targetId);
        const counteredParry = target.state === C.STATES.PARRYING;
        if (counteredParry) this.applyStun(target, ts, C.E_KICK.STUN_MS);
        this.applyKnockback(target, ts, kicker.angle, C.E_KICK.KNOCKBACK_DISTANCE, C.E_KICK.KNOCKBACK_SPEED);
        ks.kickHitApplied = true;
        ks.kickCounteredParry = counteredParry;
      }
    }
  }
}

module.exports = ArenaRoom;
