import {
  PLAYER,
  Q_DASH,
  W_PARRY,
  E_KICK,
  GLOBAL_COOLDOWN_MS,
  FAILED_PARRY_GCD_MULTIPLIER,
  SLOW_ZONE_FACTOR,
  STATES,
} from "../config/constants.js";

// Client-side prediction for the LOCAL player only — a physics/rendering-free
// mirror of server/rooms/ArenaRoom.js's stepPlayer()/tryStartSkills() (which
// is itself a server port of Combatant.js's FSM). NetArenaScene feeds it the
// same input object it's about to send to the server and renders the local
// NetFighter from this instead of the last authoritative snapshot, so your
// own actions show up immediately instead of after a network round trip.
//
// What this predicts: movement, wall/quicksand interaction, and the four
// states you can only ever enter through your OWN input (CHARGING, DASH,
// PARRYING, KICKING) plus their default (no-counter-hit) resolution.
// What it never predicts, deliberately: anything caused by another player
// (being kicked/stunned, a dash actually landing a kill, a parry actually
// countering someone) — those states/outcomes only ever arrive from the
// server and are adopted wholesale via reconcile(), same as a correction.
const MOVE_STEP_LIMIT = 4; // px per obstacle-collision substep, mirrors the server's dash substepping

// Our own duration-based transitions (charge release, parry/kick timeout,
// dash end) run off an independently-accumulated local dt clock, so they
// land a handful of ms off the server's own clock for the same transition
// — not a real desync, just two clocks measuring the same fixed duration.
// Without this grace window, reconcile() would see e.g. predicted already
// in GCD while a snapshot still mid-flight (taken just before the server's
// own timer fired) says KICKING, "correct" back into KICKING, and then the
// very next frame's re-entry into GCD would re-fire KICKING's start SFX —
// an audible double-trigger for something that only ever happened once.
const SELF_TRANSITION_GRACE_MS = 250;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export default class PredictedSelf {
  constructor() {
    this.ready = false;
    this.x = 0;
    this.y = 0;
    this.angle = 0;
    this.state = STATES.IDLE;
    this.chargeTime = 0;
    this.stunTimer = 0;
    this.globalCooldown = 0;
    this.isAlive = true;
    this.score = 0;

    this._dash = null; // { dx, dy, remaining }
    this._stateTimer = 0;
    this._prevState = STATES.IDLE;
    this._selfTransitionAt = -Infinity;
    this._selfTransitionConsumed = true;
  }

  _setState(next) {
    this._prevState = this.state;
    this.state = next;
    this._selfTransitionAt = now();
    this._selfTransitionConsumed = false;
  }

  // Seeds/replaces predicted state wholesale from an authoritative snapshot
  // — first snapshot after join/respawn, and every "can't predict this"
  // correction in reconcile(). Deliberately does NOT count as a self
  // transition — it's server-driven, so it shouldn't buy the next
  // reconcile() call any extra trust in what's about to be predicted.
  adopt(snap) {
    this.x = snap.x;
    this.y = snap.y;
    this.angle = snap.angle;
    this.state = snap.state;
    this.chargeTime = snap.chargeTime;
    this.stunTimer = snap.stunTimer;
    this.globalCooldown = snap.globalCooldown || 0;
    this.isAlive = snap.isAlive;
    this.score = snap.score;
    this._dash = null;
    this._prevState = snap.state;
    this._selfTransitionAt = -Infinity;
    this._selfTransitionConsumed = true;
    this.ready = true;
  }

  // hazards: { obstacles, quicksand } — plain arrays of {x,y,w,h}, read from
  // room.state each call (they never change after room creation, but this
  // keeps PredictedSelf from needing its own reference/lifecycle for them).
  step(dtMs, input, canAct, hazards) {
    if (!this.ready || !this.isAlive || !canAct) return;
    // STUNNED/DEAD are never self-entered from our own input (see file
    // comment) — hold still and wait for the server's next word on it.
    if (this.state === STATES.STUNNED || this.state === STATES.DEAD) return;

    switch (this.state) {
      case STATES.IDLE:
        this._moveLike(dtMs, input, PLAYER.BASE_SPEED, hazards);
        this._tryStartSkills(input);
        break;
      case STATES.GCD:
        this._moveLike(dtMs, input, PLAYER.BASE_SPEED, hazards);
        this.globalCooldown = Math.max(0, this.globalCooldown - dtMs);
        if (this.globalCooldown <= 0) this._setState(STATES.IDLE);
        break;
      case STATES.CHARGING:
        this._stepCharging(dtMs, input, hazards);
        break;
      case STATES.DASH:
        this._stepDash(dtMs, hazards);
        break;
      case STATES.PARRYING:
        this._stateTimer -= dtMs;
        if (this._stateTimer <= 0) this._enterGCD(FAILED_PARRY_GCD_MULTIPLIER);
        break;
      case STATES.KICKING:
        this._stateTimer -= dtMs;
        if (this._stateTimer <= 0) this._enterGCD(1);
        break;
      default:
        break;
    }
  }

  _enterGCD(multiplier) {
    this._setState(STATES.GCD);
    this.globalCooldown = GLOBAL_COOLDOWN_MS * multiplier;
  }

  _moveLike(dtMs, input, baseSpeed, hazards) {
    this.angle = input.aimAngle;
    if (!input.wantsMove) return;
    const speed = this._inQuicksand(hazards) ? baseSpeed * SLOW_ZONE_FACTOR : baseSpeed;
    this._moveTowards(this.angle, (speed * dtMs) / 1000, hazards);
  }

  _tryStartSkills(input) {
    if (input.qHeld) {
      this._setState(STATES.CHARGING);
      this.chargeTime = 0;
      this._dash = null;
      return;
    }
    if (input.wPressed) {
      this._setState(STATES.PARRYING);
      this._stateTimer = W_PARRY.DURATION_MS;
      return;
    }
    if (input.ePressed) {
      this._setState(STATES.KICKING);
      this._stateTimer = E_KICK.TOTAL_MS;
    }
  }

  _stepCharging(dtMs, input, hazards) {
    this.angle = input.aimAngle;
    let speed = PLAYER.BASE_SPEED * PLAYER.CHARGE_SPEED_FACTOR;
    if (this._inQuicksand(hazards)) speed *= SLOW_ZONE_FACTOR;
    if (input.wantsMove) this._moveTowards(this.angle, (speed * dtMs) / 1000, hazards);

    this.chargeTime = Math.min(this.chargeTime + dtMs, Q_DASH.MAX_CHARGE_MS);
    if (!input.qHeld) {
      const ratio = this.chargeTime / Q_DASH.MAX_CHARGE_MS;
      const distance = Q_DASH.MIN_DISTANCE + (Q_DASH.MAX_DISTANCE - Q_DASH.MIN_DISTANCE) * ratio;
      this._dash = { dx: Math.cos(this.angle), dy: Math.sin(this.angle), remaining: distance };
      this._setState(STATES.DASH);
    }
  }

  // Q dash ignores quicksand entirely (matches the server/single-player
  // rule) — only walls can stop it. A wall hit freezes into STUNNED
  // immediately (the dash-stop itself is fully our own doing and safe to
  // predict); the exact stun duration/recovery is left to the server's next
  // snapshot rather than guessed here.
  _stepDash(dtMs, hazards) {
    if (!this._dash) {
      this._enterGCD(1);
      return;
    }
    const totalStep = Math.min((Q_DASH.SPEED * dtMs) / 1000, this._dash.remaining);
    const subSteps = Math.max(1, Math.ceil(totalStep / MOVE_STEP_LIMIT));
    const perStep = totalStep / subSteps;

    for (let i = 0; i < subSteps; i++) {
      const nx = this.x + this._dash.dx * perStep;
      const ny = this.y + this._dash.dy * perStep;
      if (this._hitsObstacle(nx, ny, hazards)) {
        this._dash = null;
        this._setState(STATES.STUNNED);
        return;
      }
      this.x = nx;
      this.y = ny;
      this._dash.remaining -= perStep;
    }

    if (this._dash.remaining <= 0.01) {
      this._dash = null;
      this._enterGCD(1);
    }
  }

  _moveTowards(angle, dist, hazards) {
    const nx = this.x + Math.cos(angle) * dist;
    const ny = this.y + Math.sin(angle) * dist;
    if (!this._hitsObstacle(nx, ny, hazards)) {
      this.x = nx;
      this.y = ny;
    }
  }

  _hitsObstacle(x, y, hazards) {
    if (!hazards || !hazards.obstacles) return false;
    for (const o of hazards.obstacles) {
      const halfW = o.w / 2;
      const halfH = o.h / 2;
      const closestX = Math.max(o.x - halfW, Math.min(x, o.x + halfW));
      const closestY = Math.max(o.y - halfH, Math.min(y, o.y + halfH));
      const dx = x - closestX;
      const dy = y - closestY;
      if (dx * dx + dy * dy < PLAYER.RADIUS * PLAYER.RADIUS) return true;
    }
    return false;
  }

  _inQuicksand(hazards) {
    if (!hazards || !hazards.quicksand) return false;
    for (const q of hazards.quicksand) {
      if (Math.abs(this.x - q.x) <= q.w / 2 && Math.abs(this.y - q.y) <= q.h / 2) return true;
    }
    return false;
  }

  // Called whenever a fresh server snapshot for this player arrives (see
  // NetArenaScene's onChange wiring) — corrects drift without necessarily
  // discarding everything predicted since the last one.
  reconcile(snap) {
    if (!this.ready) {
      this.adopt(snap);
      return;
    }

    const diedOrRespawned = Boolean(snap.isAlive) !== Boolean(this.isAlive);
    // STUNNED/DEAD are only ever caused by another player's action (see the
    // file comment) — always trust the server outright, self-prediction
    // never claims these states on its own initiative.
    const externallyCaused = snap.state === STATES.STUNNED || snap.state === STATES.DEAD;
    const farAway = Math.hypot(snap.x - this.x, snap.y - this.y) > PLAYER.RADIUS * 4;
    const categoryMismatch = this._category(snap.state) !== this._category(this.state);

    // Only the ONE patch that was already in flight when we transitioned
    // (still showing exactly the state we were in right before) gets this
    // pass — bounds it to the single stale packet this is meant to cover
    // instead of a whole time window, which would also swallow a genuine
    // fast event (e.g. an opponent's dash landing on us within the first
    // moment of our own PARRYING) that happens to resolve to that same
    // state value.
    const recentSelfTransition = !this._selfTransitionConsumed && now() - this._selfTransitionAt < SELF_TRANSITION_GRACE_MS;
    const serverStillOnPreviousStage = snap.state === this._prevState;
    const trustPrediction =
      recentSelfTransition && serverStillOnPreviousStage && !externallyCaused && !diedOrRespawned;
    if (trustPrediction) this._selfTransitionConsumed = true;

    if (diedOrRespawned || externallyCaused || farAway || (categoryMismatch && !trustPrediction)) {
      this.adopt(snap);
      return;
    }

    // Minor drift: ease position toward the authoritative value instead of
    // popping.
    this.x = Phaser.Math.Linear(this.x, snap.x, 0.5);
    this.y = Phaser.Math.Linear(this.y, snap.y, 0.5);
    if (!trustPrediction) {
      // State/timers aren't rendered as motion, so there's no harm in just
      // taking the server's numbers directly — except while trusting our
      // own more-recent prediction above, where taking a stale timer back
      // would just re-desync it from the state we're keeping.
      this.state = snap.state;
      this.chargeTime = snap.chargeTime;
      this.stunTimer = snap.stunTimer;
      this.globalCooldown = snap.globalCooldown || 0;
    }
    this.isAlive = snap.isAlive;
    this.score = snap.score;
  }

  _category(state) {
    if (state === STATES.DASH) return "dash";
    if (state === STATES.CHARGING) return "charging";
    if (state === STATES.PARRYING) return "parrying";
    if (state === STATES.KICKING) return "kicking";
    return "free"; // IDLE/GCD — interchangeable for reconciliation purposes
  }
}
