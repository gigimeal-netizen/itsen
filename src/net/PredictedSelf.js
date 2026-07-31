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
// Reconciliation is sequence-number-based, not state-guessing: NetArenaScene
// tags every input it sends with an incrementing seq and keeps a buffer of
// them (see its `_pendingInputs`); the server echoes back the seq of the
// last input it actually processed (PlayerState.lastInputSeq). reconcile()
// always adopts the server snapshot as ground truth, drops every buffered
// input the server has confirmed, and *replays* whatever's left (inputs the
// server hasn't caught up to yet) on top of that truth via the same step()
// used for live simulation. This replaced three successive heuristic
// attempts at guessing "is this snapshot stale" from state/category/time
// alone — under real internet latency (where a skill's own duration can be
// shorter than the round trip), none of those heuristics could reliably
// tell a late-arriving stale packet apart from a fresh one, causing
// rubber-banding and dropped-looking W/E presses. Replay sidesteps the
// guessing entirely: it's always correct by construction.
const MOVE_STEP_LIMIT = 4; // px per obstacle-collision substep, mirrors the server's dash substepping

// Open net.html?debugpredict to log reconcile()'s replay decisions.
const DEBUG = typeof window !== "undefined" && window.location.search.includes("debugpredict");

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
    this._lastLoggedState = null; // DEBUG-only, see reconcile()

    this._dash = null; // { dx, dy, remaining }
    this._stateTimer = 0;
  }

  // Seeds/replaces predicted state wholesale from an authoritative snapshot
  // — first snapshot after join/respawn only. Regular corrections go
  // through reconcile() instead, which replays unconfirmed inputs back on
  // top instead of freezing here.
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
        if (this.globalCooldown <= 0) this.state = STATES.IDLE;
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
    this.state = STATES.GCD;
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
      this.state = STATES.CHARGING;
      this.chargeTime = 0;
      this._dash = null;
      return;
    }
    if (input.wPressed) {
      this.state = STATES.PARRYING;
      this._stateTimer = W_PARRY.DURATION_MS;
      return;
    }
    if (input.ePressed) {
      this.state = STATES.KICKING;
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
      this.state = STATES.DASH;
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
        this.state = STATES.STUNNED;
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
  // NetArenaScene's onChange wiring). `pendingInputs` is NetArenaScene's
  // buffer of { seq, dtMs, input, canAct, hazards } entries sent but not
  // yet confirmed by the server — mutated in place here to drop whatever
  // this snapshot confirms.
  reconcile(snap, pendingInputs) {
    if (!this.ready) {
      this.adopt(snap);
      return;
    }

    const confirmedSeq = snap.lastInputSeq || 0;
    while (pendingInputs.length && pendingInputs[0].seq <= confirmedSeq) pendingInputs.shift();

    // Always start from the server's authoritative truth...
    const wasAlreadyInState = this.state === snap.state;
    this.x = snap.x;
    this.y = snap.y;
    this.angle = snap.angle;
    this.chargeTime = snap.chargeTime;
    this.stunTimer = snap.stunTimer;
    this.globalCooldown = snap.globalCooldown || 0;
    this.isAlive = snap.isAlive;
    this.score = snap.score;
    // PARRYING/KICKING/DASH's remaining duration (_stateTimer) and DASH's
    // direction/distance (_dash) are local-only bookkeeping the synced
    // schema doesn't carry — they're normally set by _tryStartSkills()/
    // _stepCharging() when we predict entering these states ourselves.
    // Landing in one of them straight from a snapshot (the input that
    // triggered it already got confirmed and trimmed out of the replay
    // queue, so that entry code never reran) left them stale — often
    // already <= 0 — so the very first replay step saw "time's up" and
    // collapsed straight back to GCD, which read as Q/W/E never firing.
    // Only re-seed on a fresh entry into the state (it wasn't what we were
    // already predicting) — resetting on every single reconcile call (this
    // fires up to ~30/s) would keep stomping the natural countdown that
    // ordinary per-frame step() calls are making between reconciles.
    if (snap.state === STATES.PARRYING && !wasAlreadyInState) this._stateTimer = W_PARRY.DURATION_MS;
    else if (snap.state === STATES.KICKING && !wasAlreadyInState) this._stateTimer = E_KICK.TOTAL_MS;
    if (snap.state === STATES.DASH) {
      if (!wasAlreadyInState || !this._dash) {
        this._dash = { dx: Math.cos(snap.angle), dy: Math.sin(snap.angle), remaining: Q_DASH.MAX_DISTANCE };
      }
    } else {
      this._dash = null;
    }
    this.state = snap.state;

    // ...then fast-forward through whatever we've sent that the server
    // hasn't processed yet, so our own more-recent input still shows up
    // immediately instead of getting wiped by this snapshot. Skipped for
    // STUNNED/DEAD (only ever externally caused, see file comment) and on
    // death/respawn — nothing of ours belongs layered on top of those.
    const externallyForced = this.state === STATES.STUNNED || this.state === STATES.DEAD || !this.isAlive;
    if (externallyForced) {
      if (DEBUG && snap.state !== this._lastLoggedState) {
        console.log(`[predict] reconcile: externally forced into ${snap.state}`);
        this._lastLoggedState = snap.state;
      }
      return;
    }

    for (const entry of pendingInputs) {
      this.step(entry.dtMs, entry.input, entry.canAct, entry.hazards);
    }

    // Only log when something actually changed — snap.state=IDLE, nothing
    // replayed, nothing to see is the common case while just moving, and
    // logging every reconcile call (30/s) drowns out the interesting ones.
    if (DEBUG && (snap.state !== this._lastLoggedState || this.state !== snap.state)) {
      console.log(
        `[predict] reconcile: snap.state=${snap.state} confirmedSeq=${confirmedSeq} ` +
          `replayed=${pendingInputs.length} -> predicted.state=${this.state}`
      );
      this._lastLoggedState = snap.state;
    }
  }
}
