import { PLAYER, SLOW_ZONE_FACTOR, STATES, classSkills } from "../config/constants.js";

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
    this.classId = null; // set from the first snapshot in adopt() — NetFighter reads this like any other snapshot field
    this._lastLoggedState = null; // DEBUG-only, see reconcile()

    this._dash = null; // { dx, dy, remaining }
    this._shieldCharge = null; // Knight E: { dx, dy, remaining }
    this._slam = null; // Warrior E: { dx, dy, remaining }
    // Time since this.state last changed — nothing ported before Mage
    // needed "elapsed time in state" client-side (NetFighter has its own
    // _sinceStateMs for this exact reason), but fluidState's own-movement
    // haste-phase switch genuinely needs one. Updated once per step() call,
    // detected the same way NetFighter detects its own state transitions.
    this._prevPredState = null;
    this._stateElapsedMs = 0;
    // Resolved once from the first snapshot's classId (join-time-fixed, no
    // mid-match class change to worry about this stage) — every skill-tuning
    // read below goes through this instead of a bare constant, so a future
    // second class only needs a new CLASSES entry, not new read sites.
    this._skills = classSkills(undefined);
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
    this.classId = snap.classId;
    this._dash = null;
    this._shieldCharge = null;
    this._slam = null;
    this._prevPredState = snap.state;
    this._stateElapsedMs = 0;
    this._skills = classSkills(snap.classId);
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

    if (this.state !== this._prevPredState) {
      this._prevPredState = this.state;
      this._stateElapsedMs = 0;
    } else {
      this._stateElapsedMs += dtMs;
    }

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
        // heldGuard (Knight) classes are still mobile while blocking —
        // predict that movement same as any other state. Non-heldGuard
        // classes fall through to the same "entry only" no-op as KICKING
        // below (a tap-parry roots you in place, nothing left to predict).
        if (this._skills.skillTypes.w === "heldGuard") this._stepHeldGuard(dtMs, input, hazards);
        break;
      case STATES.SHIELD_CHARGE:
        this._stepShieldCharge(dtMs, hazards);
        break;
      case STATES.BATTLE_CRY:
        // Warrior W: mobile at full speed for the whole cast, unlike
        // Knight's heldGuard (-65%) — see _stepBattleCry.
        this._stepBattleCry(dtMs, input, hazards);
        break;
      case STATES.SLAM_CHARGE:
        this._stepSlamCharge(dtMs, input);
        break;
      case STATES.SLAMMING:
        this._stepSlamming(dtMs, hazards);
        break;
      case STATES.FLUID:
        // Mage W: mobile for the whole cast, two speed phases (invincible
        // then hasted) — see _stepFluidState.
        this._stepFluidState(dtMs, input, hazards);
        break;
      case STATES.LASER_CHARGE:
        this._stepLaserCharge(dtMs, input, hazards);
        break;
      case STATES.KICKING:
      case STATES.COMBO_WINDOW:
      case STATES.COMBO_ATTACK:
      case STATES.EMPOWERED_STRIKE:
      case STATES.AXE_SWING:
      case STATES.SLAM_IMPACT:
      case STATES.LASER_FIRE:
      case STATES.BLIZZARD:
        // Deliberately NOT self-timed out here (previously via a local
        // _stateTimer counting down to _enterGCD()) — that duration isn't
        // part of the synced schema, so every reconcile() had to guess a
        // fresh countdown, and replaying a bigger-than-usual backlog (a
        // network hiccup) could overshoot it before the server's own
        // confirmation caught up. The server then re-showing PARRYING
        // read as "entering fresh", re-guessed another countdown, and
        // could overshoot again — a real ping-pong that fired the entry
        // SFX/pose repeatedly for one press. The server's own state flip
        // (see reconcile()) is what ends these now; entry is still
        // predicted instantly above, just not the exit. COMBO_WINDOW/
        // COMBO_ATTACK/EMPOWERED_STRIKE extend the same policy — none of
        // them are even locally enterable from raw input (they're outcomes
        // of a landed/blocked hit only the server resolves), so there's
        // nothing to predict but holding still until the next snapshot.
        break;
      default:
        break;
    }
  }

  // Knight W (heldGuard): mobile at -65% speed while the shield is up,
  // mirrors _moveLike's obstacle-blocked movement shape.
  _stepHeldGuard(dtMs, input, hazards) {
    this.angle = input.aimAngle;
    if (!input.wantsMove) return;
    const wParry = this._skills.wParry;
    let speed = PLAYER.BASE_SPEED * wParry.MOVE_SPEED_MULTIPLIER;
    if (this._inQuicksand(hazards)) speed *= SLOW_ZONE_FACTOR;
    this._moveTowards(this.angle, (speed * dtMs) / 1000, hazards);
  }

  // Knight E: mirrors _stepDash's exact obstacle-substepping shape, against
  // _shieldCharge instead of _dash. Same "stop advancing, hold the pose
  // until the next snapshot" policy on a wall hit — the exact stun/GCD
  // outcome (a wall hit vs. a landed vs-guard bonus) is left to the server.
  _stepShieldCharge(dtMs, hazards) {
    if (!this._shieldCharge) return;
    const eCharge = this._skills.eShieldCharge;
    const totalStep = Math.min((eCharge.SPEED * dtMs) / 1000, this._shieldCharge.remaining);
    const subSteps = Math.max(1, Math.ceil(totalStep / MOVE_STEP_LIMIT));
    const perStep = totalStep / subSteps;

    for (let i = 0; i < subSteps; i++) {
      const nx = this.x + this._shieldCharge.dx * perStep;
      const ny = this.y + this._shieldCharge.dy * perStep;
      if (this._hitsObstacle(nx, ny, hazards)) {
        this._shieldCharge = null;
        this.state = STATES.STUNNED;
        return;
      }
      this.x = nx;
      this.y = ny;
      this._shieldCharge.remaining -= perStep;
    }
  }

  // Warrior W: mobile at full BASE_SPEED for the whole cast (unlike
  // Knight's heldGuard, no speed multiplier) — mirrors _moveLike exactly.
  // The invincibility-block/debuff resolution itself is never predicted
  // (a hit outcome, server-only), just the movement.
  _stepBattleCry(dtMs, input, hazards) {
    this._moveLike(dtMs, input, PLAYER.BASE_SPEED, hazards);
  }

  // Warrior E, phase 1/2: hold to charge — mirrors _stepCharging's shape but
  // for E/divingSlam. Deliberately does NOT reset chargeTime here so it
  // stays valid for _drawSlamPreview/_drawSlamImpactRing through the whole
  // sequence, matching the server (see ArenaRoom.stepSlamCharge).
  _stepSlamCharge(dtMs, input) {
    // Rooted in place while charging (mirrors _updateSlamCharge — only the
    // facing angle tracks live input, no movement).
    this.angle = input.aimAngle;

    const slam = this._skills.divingSlam;
    this.chargeTime = Math.min(this.chargeTime + dtMs, slam.MAX_CHARGE_MS);
    if (!input.eHeld) {
      const ratio = this.chargeTime / slam.MAX_CHARGE_MS;
      const distance = slam.MIN_LEAP_DISTANCE + (slam.MAX_LEAP_DISTANCE - slam.MIN_LEAP_DISTANCE) * ratio;
      this._slam = { dx: Math.cos(this.angle), dy: Math.sin(this.angle), remaining: distance };
      this.state = STATES.SLAMMING;
    }
  }

  // Warrior E, phase 2/2: mirrors _stepShieldCharge's exact obstacle-
  // substepping shape, against _slam instead of _shieldCharge.
  _stepSlamming(dtMs, hazards) {
    if (!this._slam) return;
    const slam = this._skills.divingSlam;
    const totalStep = Math.min((slam.LEAP_SPEED * dtMs) / 1000, this._slam.remaining);
    const subSteps = Math.max(1, Math.ceil(totalStep / MOVE_STEP_LIMIT));
    const perStep = totalStep / subSteps;

    for (let i = 0; i < subSteps; i++) {
      const nx = this.x + this._slam.dx * perStep;
      const ny = this.y + this._slam.dy * perStep;
      if (this._hitsObstacle(nx, ny, hazards)) {
        this._slam = null;
        this.state = STATES.STUNNED;
        return;
      }
      this.x = nx;
      this.y = ny;
      this._slam.remaining -= perStep;
    }
  }

  // Mage W: mobile for the whole cast — invincible phase then a haste
  // phase, picked from _stateElapsedMs (mirrors ArenaRoom.stepFluidState's
  // stateTimer check, just measured forward instead of counting down). The
  // invincibility-block resolution itself is never predicted (a hit
  // outcome, server-only), just the movement.
  _stepFluidState(dtMs, input, hazards) {
    const cfg = this._skills.fluidState;
    const hasted = this._stateElapsedMs >= cfg.DURATION_MS;
    this._moveLike(dtMs, input, PLAYER.BASE_SPEED * (hasted ? cfg.HASTE_MULTIPLIER : 1), hazards);
  }

  // Mage Q: hold to charge — mirrors _stepCharging's movement shape, but
  // release before the effective threshold just cancels (no beam) instead
  // of firing a scaled-down one. Predicts the *default* (non-fastCharge)
  // MIN_CHARGE_MS threshold locally, matching the established policy of not
  // predicting buff-driven redirects client-side (e.g. Knight's
  // empoweredQMs) — reconcile() corrects from the next snapshot on the rare
  // occasion the real fast-charge threshold applied. Deliberately does NOT
  // reset chargeTime on release, same as Warrior's slam charge, so it stays
  // valid for NetFighter's laser-preview through the fire window.
  _stepLaserCharge(dtMs, input, hazards) {
    this.angle = input.aimAngle;
    const speed = this._inQuicksand(hazards)
      ? PLAYER.BASE_SPEED * PLAYER.CHARGE_SPEED_FACTOR * SLOW_ZONE_FACTOR
      : PLAYER.BASE_SPEED * PLAYER.CHARGE_SPEED_FACTOR;
    if (input.wantsMove) this._moveTowards(this.angle, (speed * dtMs) / 1000, hazards);

    const laser = this._skills.laserBeam;
    this.chargeTime = Math.min(this.chargeTime + dtMs, laser.MAX_CHARGE_MS);
    if (!input.qHeld) {
      this.state = this.chargeTime >= laser.MIN_CHARGE_MS ? STATES.LASER_FIRE : STATES.GCD;
    }
  }

  _moveLike(dtMs, input, baseSpeed, hazards) {
    this.angle = input.aimAngle;
    if (!input.wantsMove) return;
    const speed = this._inQuicksand(hazards) ? baseSpeed * SLOW_ZONE_FACTOR : baseSpeed;
    this._moveTowards(this.angle, (speed * dtMs) / 1000, hazards);
  }

  // Mirrors ArenaRoom.tryStartSkills' shape: Q/W/E each dispatched
  // independently, branching on skillTypes instead of assuming swordsman's
  // shapes. comboDash's empoweredQMs-buff redirect (-> a stationary strike
  // instead of a dash) isn't predicted here — that buff isn't part of the
  // synced schema PredictedSelf tracks, so a tap always predicts a plain
  // dash locally; reconcile() corrects to EMPOWERED_STRIKE from the next
  // snapshot on the rare occasion the buff was actually active.
  _tryStartSkills(input) {
    const skillTypes = this._skills.skillTypes;

    if (skillTypes.q === "comboDash") {
      if (input.qPressed) {
        const qDash = this._skills.qDash;
        this._dash = { dx: Math.cos(this.angle), dy: Math.sin(this.angle), remaining: qDash.DISTANCE };
        this.state = STATES.DASH;
        return;
      }
    } else if (skillTypes.q === "axeSwing") {
      // No hold-to-charge, no travel — enter directly, hit outcome is
      // never predicted locally (see the KICKING/etc. no-op group in step()).
      if (input.qPressed) {
        this.state = STATES.AXE_SWING;
        return;
      }
    } else if (skillTypes.q === "laserBeam") {
      if (input.qHeld) {
        this.state = STATES.LASER_CHARGE;
        this.chargeTime = 0;
        return;
      }
    } else if (input.qHeld) {
      this.state = STATES.CHARGING;
      this.chargeTime = 0;
      this._dash = null;
      return;
    }

    if (skillTypes.w === "heldGuard") {
      if (input.wHeld) {
        this.state = STATES.PARRYING;
        return;
      }
    } else if (skillTypes.w === "battleCry") {
      if (input.wPressed) {
        this.state = STATES.BATTLE_CRY;
        return;
      }
    } else if (skillTypes.w === "fluidState") {
      if (input.wPressed) {
        this.state = STATES.FLUID;
        return;
      }
    } else if (input.wPressed) {
      this.state = STATES.PARRYING;
      return;
    }

    if (skillTypes.e === "shieldCharge") {
      if (input.ePressed) {
        const eCharge = this._skills.eShieldCharge;
        this._shieldCharge = { dx: Math.cos(this.angle), dy: Math.sin(this.angle), remaining: eCharge.DISTANCE };
        this.state = STATES.SHIELD_CHARGE;
      }
    } else if (skillTypes.e === "divingSlam") {
      if (input.eHeld) {
        this.state = STATES.SLAM_CHARGE;
        this.chargeTime = 0;
      }
    } else if (skillTypes.e === "blizzard") {
      if (input.ePressed) {
        this.state = STATES.BLIZZARD;
      }
    } else if (input.ePressed) {
      this.state = STATES.KICKING;
    }
  }

  _stepCharging(dtMs, input, hazards) {
    this.angle = input.aimAngle;
    let speed = PLAYER.BASE_SPEED * PLAYER.CHARGE_SPEED_FACTOR;
    if (this._inQuicksand(hazards)) speed *= SLOW_ZONE_FACTOR;
    if (input.wantsMove) this._moveTowards(this.angle, (speed * dtMs) / 1000, hazards);

    const qDash = this._skills.qDash;
    this.chargeTime = Math.min(this.chargeTime + dtMs, qDash.MAX_CHARGE_MS);
    if (!input.qHeld) {
      const ratio = this.chargeTime / qDash.MAX_CHARGE_MS;
      const distance = qDash.MIN_DISTANCE + (qDash.MAX_DISTANCE - qDash.MIN_DISTANCE) * ratio;
      this._dash = { dx: Math.cos(this.angle), dy: Math.sin(this.angle), remaining: distance };
      this.state = STATES.DASH;
    }
  }

  // Q dash ignores quicksand entirely (matches the server/single-player
  // rule) — only walls can stop it. A wall hit freezes into STUNNED
  // immediately (the dash-stop itself is fully our own doing and safe to
  // predict); the exact stun duration/recovery is left to the server's next
  // snapshot rather than guessed here. Running out of distance deliberately
  // does NOT self-transition to GCD here (see the PARRYING/KICKING comment
  // in step() — same class of bug: distance is a client-only guess when
  // reconstructed mid-flight from a snapshot, and letting replay decide
  // "done" from a guessed value could overshoot and ping-pong against the
  // server's own state). It just stops advancing and holds the dash pose
  // until reconcile()'s next snapshot says otherwise.
  _stepDash(dtMs, hazards) {
    if (!this._dash) return;
    const totalStep = Math.min((this._skills.qDash.SPEED * dtMs) / 1000, this._dash.remaining);
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
    this.x = snap.x;
    this.y = snap.y;
    this.angle = snap.angle;
    this.chargeTime = snap.chargeTime;
    this.stunTimer = snap.stunTimer;
    this.globalCooldown = snap.globalCooldown || 0;
    this.isAlive = snap.isAlive;
    this.score = snap.score;
    this.classId = snap.classId;
    // DASH's direction/distance (_dash) is local-only bookkeeping the
    // synced schema doesn't carry. Landing in DASH straight from a
    // snapshot (the input that triggered it already got confirmed and
    // trimmed out of the replay queue, so _stepCharging() never reran) has
    // no real value to reconstruct from — guess a full-range dash along
    // the synced angle; precision doesn't matter since _stepDash() no
    // longer self-ends on distance (see its comment), only reconcile()
    // moves us out of DASH now, same as PARRYING/KICKING.
    if (snap.state === STATES.DASH) {
      this._dash = this._dash || {
        dx: Math.cos(snap.angle),
        dy: Math.sin(snap.angle),
        // comboDash (Knight) has a flat DISTANCE, not a charge-scaled
        // MAX_DISTANCE — guess whichever this class actually has.
        remaining: this._skills.qDash.DISTANCE ?? this._skills.qDash.MAX_DISTANCE,
      };
    } else {
      this._dash = null;
    }
    // Knight E: same "no real value to reconstruct, precision doesn't
    // matter" guess as DASH above — _stepShieldCharge doesn't self-end on
    // distance either, only reconcile() moves us out of SHIELD_CHARGE.
    if (snap.state === STATES.SHIELD_CHARGE) {
      this._shieldCharge = this._shieldCharge || {
        dx: Math.cos(snap.angle),
        dy: Math.sin(snap.angle),
        remaining: this._skills.eShieldCharge.DISTANCE,
      };
    } else {
      this._shieldCharge = null;
    }
    // Warrior E: same "no real value to reconstruct, precision doesn't
    // matter" guess as DASH/SHIELD_CHARGE above, derived from the still-
    // valid synced chargeTime (the server never resets it through the slam
    // sequence — see ArenaRoom.stepSlamCharge).
    if (snap.state === STATES.SLAMMING) {
      if (!this._slam) {
        const slam = this._skills.divingSlam;
        const ratio = snap.chargeTime / slam.MAX_CHARGE_MS;
        this._slam = {
          dx: Math.cos(snap.angle),
          dy: Math.sin(snap.angle),
          remaining: slam.MIN_LEAP_DISTANCE + (slam.MAX_LEAP_DISTANCE - slam.MIN_LEAP_DISTANCE) * ratio,
        };
      }
    } else {
      this._slam = null;
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
