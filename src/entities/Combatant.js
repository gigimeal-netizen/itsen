import {
  PLAYER,
  GLOBAL_COOLDOWN_MS,
  STUN_DURATION_MS,
  Q_DASH,
  W_PARRY,
  E_KICK,
  SLOW_ZONE_FACTOR,
  RESPAWN_DELAY_MS,
  WALL_STUN_MS,
  FAILED_PARRY_GCD_MULTIPLIER,
  STATES,
} from "../config/constants.js";
import Sfx from "../audio/Sfx.js";

// Shared FSM + skill logic for anything that can fight in the arena
// (the human-controlled Player and the training Dummy). Subclasses
// set wantsMove/aimAngle/qHeld/wPressed/ePressed each frame before
// calling super.update(); this class only owns state transitions and physics.
export default class Combatant extends Phaser.GameObjects.Container {
  constructor(scene, x, y, color) {
    super(scene, x, y);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.body.setCircle(PLAYER.RADIUS, -PLAYER.RADIUS, -PLAYER.RADIUS);
    this.body.setCollideWorldBounds(true);

    this.color = color;
    this.spawnX = x;
    this.spawnY = y;
    this._respawnClock = 0; // ms remaining until respawn(), only ticks while dead
    // Shadow lives OUTSIDE the container (it must not inherit facing rotation —
    // a rotating shadow reads as swinging around the character instead of
    // sitting fixed on the ground beneath them).
    this.shadow = scene.add.ellipse(x, y + PLAYER.RADIUS * 0.8, PLAYER.RADIUS * 1.6, PLAYER.RADIUS * 0.7, 0x000000, 0.32);
    this.shadow.setDepth(-0.5);
    this.kickCone = scene.add.graphics();
    this.auraRing = scene.add.graphics(); // charge / parry / stun rings
    this.figure = scene.add.graphics(); // stick-figure body, redrawn every frame per pose
    this.stateLabel = scene.add.text(0, -PLAYER.RADIUS - 16, STATES.IDLE, {
      font: "11px monospace",
      color: "#ffffff",
    }).setOrigin(0.5, 1);
    this.add([this.kickCone, this.auraRing, this.figure, this.stateLabel]);
    this._clock = 0; // free-running ms clock for pulse/sweep animations
    this._afterimageClock = 0;
    this._maxChargeSparkleClock = 0;
    this._chargeReadyPlayed = false; // one-shot "100% charged" cue, reset on each new charge
    this._dashScratchGfx = null; // ground scuff mark, grown during the current dash
    this._dashScratchPrevX = 0;
    this._dashScratchPrevY = 0;

    this.state = STATES.IDLE;
    this.stateTimer = 0; // ms remaining in current state (where applicable)
    this.facing = 0; // radians
    this.chargeTime = 0;
    this.isAlive = true;
    this.locked = false; // true during pre-round countdown: no input, holds still

    // input intent, refreshed each frame by subclass
    this.wantsMove = false;
    this.aimAngle = 0;
    this.qHeld = false;
    this.wPressed = false;
    this.ePressed = false;

    // set by the arena each frame from terrain zones (Q dash ignores this)
    this.inSlowZone = false;

    // per-state scratch data
    this._dash = null; // { dx, dy, remaining }
    this._dashKilled = false; // this dash landed a kill -> skip GCD on completion
    this._kickHitApplied = false;
    this._kickCounteredParry = false; // this kick hit a PARRYING target -> skip GCD
    this._parrySuccess = false;
    this._knockback = null; // { dx, dy, remainingMs, speed }
  }

  destroyEntity() {
    this.shadow.destroy();
    this.kickCone.destroy();
    this.auraRing.destroy();
    this.figure.destroy();
    this.stateLabel.destroy();
    this.destroy();
  }

  get radius() {
    return PLAYER.RADIUS;
  }

  setState(next) {
    if (this.state === STATES.CHARGING && next !== STATES.CHARGING) {
      Sfx.chargeLoopStop();
    }
    this.state = next;
    this.stateLabel.setText(next);
  }

  // Called by the arena when this combatant should die instantly (Q hit / ring-out).
  // `cutAngle` is the attacker's travel direction — the body splits along that
  // line and the two halves fly apart perpendicular to it.
  kill(cutAngle = this.facing) {
    if (!this.isAlive) return;
    this.isAlive = false;
    this._endDashScratch();
    this.setState(STATES.DEAD);
    this.body.setVelocity(0, 0);
    this.kickCone.clear();
    this.auraRing.clear();
    this.setAlpha(0); // the flying halves are the corpse now, hide the intact body
    this.shadow.setAlpha(0);
    this._spawnDeathBurst(cutAngle);
    this._spawnBloodEffect(cutAngle);
    Sfx.death();
    this.scene.cameras.main.shake(160, 0.008);
    this.scene.cameras.main.flash(120, 60, 0, 0);
    this._respawnClock = RESPAWN_DELAY_MS;
  }

  // Called by the arena when this combatant falls off the edge (ring-out)
  // or through an open pitfall. No attacker, so no slice/blood — just a
  // shrink-and-spin drop into the void.
  dieFromHazard() {
    if (!this.isAlive) return;
    this.isAlive = false;
    this._endDashScratch();
    this.setState(STATES.DEAD);
    this.body.setVelocity(0, 0);
    this.kickCone.clear();
    this.auraRing.clear();
    this.shadow.setAlpha(0);
    Sfx.death();
    this.scene.cameras.main.shake(120, 0.006);
    this.scene.tweens.add({
      targets: this,
      scale: 0,
      alpha: 0,
      rotation: this.rotation + Math.PI * 1.5,
      duration: 380,
      ease: "Cubic.easeIn",
    });
    this._respawnClock = RESPAWN_DELAY_MS;
  }

  // Generic auto-respawn: any Combatant (Player included) gets this for free.
  // Subclasses with extra reset needs (e.g. Dummy's parry timer) should
  // override respawn(), call super.respawn(), then do their own reset.
  respawn() {
    this.isAlive = true;
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.setAlpha(1);
    this.setScale(1);
    this.rotation = 0;
    this.figure.setAlpha(1);
    this.shadow.setAlpha(1);
    this.setState(STATES.IDLE);
  }

  _tickRespawn(dtMs) {
    this._respawnClock -= dtMs;
    if (this._respawnClock <= 0) this.respawn();
  }

  // Called when another player's successful skill stuns this one. Note W's
  // invincibility only ever counters Q (handled separately via parrySuccess()/
  // selfStunFromParry() — this method is never called on a parrying dasher
  // target for that path), so there's deliberately no PARRYING guard here:
  // per spec, E's kick beats W and always lands.
  applyStun(durationMs = STUN_DURATION_MS) {
    if (!this.isAlive) return;
    this._dash = null;
    this.body.setVelocity(0, 0);
    this.setState(STATES.STUNNED);
    this.stateTimer = durationMs;
    Sfx.stun(durationMs);
  }

  applyKnockback(fromAngle, distance, speed) {
    if (!this.isAlive) return;
    this._knockback = {
      dx: Math.cos(fromAngle),
      dy: Math.sin(fromAngle),
      remainingMs: (distance / speed) * 1000,
      speed,
    };
  }

  enterGCD(multiplier = 1) {
    this.setState(STATES.GCD);
    this._gcdTotalMs = GLOBAL_COOLDOWN_MS * multiplier;
    this.stateTimer = this._gcdTotalMs;
  }

  update(dtMs) {
    if (!this.isAlive) {
      this._tickRespawn(dtMs);
      return;
    }
    if (this.locked) {
      this.body.setVelocity(0, 0);
      this._clock += dtMs;
      this._drawKickCone();
      this._drawAuraRing();
      this._drawFigure();
      this.rotation = this.facing;
      this.shadow.setPosition(this.x, this.y + PLAYER.RADIUS * 0.8);
      this.stateLabel.setText(this.state);
      return;
    }
    this._clock += dtMs;

    if (this.state === STATES.DASH) {
      this._updateAfterimages(dtMs);
      this._updateDashScratch();
    }

    switch (this.state) {
      case STATES.IDLE:
        this._updateIdleLike(dtMs, PLAYER.BASE_SPEED);
        this._tryStartSkills();
        break;
      case STATES.GCD:
        this._updateIdleLike(dtMs, PLAYER.BASE_SPEED);
        this._tickTimer(dtMs, () => this.setState(STATES.IDLE));
        break;
      case STATES.CHARGING:
        this._updateCharging(dtMs);
        break;
      case STATES.DASH:
        this._updateDash(dtMs);
        break;
      case STATES.PARRYING:
        this._updateParrying(dtMs);
        break;
      case STATES.KICKING:
        this._updateKicking(dtMs);
        break;
      case STATES.STUNNED:
        this.body.setVelocity(0, 0);
        this.figure.setAlpha(0.55 + 0.45 * Math.abs(Math.sin(this._clock * 0.012)));
        this._tickTimer(dtMs, () => {
          this.figure.setAlpha(1);
          this.setState(STATES.IDLE);
        });
        break;
      default:
        break;
    }

    this._applyKnockbackMotion(dtMs);
    this._drawKickCone();
    this._drawAuraRing();
    this._drawFigure();
    this.rotation = this.facing;
    this.shadow.setPosition(this.x, this.y + PLAYER.RADIUS * 0.8);
    this.stateLabel.setText(
      this.state === STATES.CHARGING
        ? `${this.state} ${(this.chargeTime / 1000).toFixed(2)}s`
        : this.state
    );
  }

  _tickTimer(dtMs, onExpire) {
    this.stateTimer -= dtMs;
    if (this.stateTimer <= 0) onExpire();
  }

  _updateIdleLike(dtMs, speedScale) {
    this.facing = this.aimAngle;
    if (this.wantsMove) {
      const speed = this.inSlowZone ? speedScale * SLOW_ZONE_FACTOR : speedScale;
      const vx = Math.cos(this.facing) * speed;
      const vy = Math.sin(this.facing) * speed;
      this.body.setVelocity(vx, vy);
    } else {
      this.body.setVelocity(0, 0);
    }
  }

  _tryStartSkills() {
    if (this.qHeld) {
      this.chargeTime = 0;
      this._dash = null;
      this._chargeReadyPlayed = false;
      this.setState(STATES.CHARGING);
      Sfx.chargeLoopStart();
      return;
    }
    if (this.wPressed) {
      this.setState(STATES.PARRYING);
      this.stateTimer = W_PARRY.DURATION_MS;
      this._parrySuccess = false;
      this.body.setVelocity(0, 0);
      Sfx.parryStance();
      return;
    }
    if (this.ePressed) {
      this.setState(STATES.KICKING);
      this.stateTimer = E_KICK.TOTAL_MS;
      this._kickHitApplied = false;
      this._kickCounteredParry = false;
      this.body.setVelocity(0, 0);
      Sfx.kickSwing();
    }
  }

  _updateCharging(dtMs) {
    this.facing = this.aimAngle;
    let speed = PLAYER.BASE_SPEED * PLAYER.CHARGE_SPEED_FACTOR;
    if (this.inSlowZone) speed *= SLOW_ZONE_FACTOR;
    if (this.wantsMove) {
      this.body.setVelocity(Math.cos(this.facing) * speed, Math.sin(this.facing) * speed);
    } else {
      this.body.setVelocity(0, 0);
    }

    this.chargeTime = Math.min(this.chargeTime + dtMs, Q_DASH.MAX_CHARGE_MS);
    Sfx.chargeLoopUpdate(this.chargeTime / Q_DASH.MAX_CHARGE_MS);

    // Charge maxed out (holding past the point it can go any further) —
    // a one-shot "ready" sound plus a sparkle glint every ~70ms around the
    // character telegraphs "fully charged, ready to release" beyond just
    // the aura ring filling.
    if (this.chargeTime >= Q_DASH.MAX_CHARGE_MS) {
      if (!this._chargeReadyPlayed) {
        this._chargeReadyPlayed = true;
        Sfx.chargeReady();
      }
      this._maxChargeSparkleClock -= dtMs;
      if (this._maxChargeSparkleClock <= 0) {
        this._maxChargeSparkleClock = 70;
        this._spawnChargeSparkle();
      }
    } else {
      this._maxChargeSparkleClock = 0;
    }

    if (!this.qHeld) {
      this._releaseDash();
    }
  }

  _spawnChargeSparkle() {
    const r = PLAYER.RADIUS;
    const ang = Math.random() * Math.PI * 2;
    const dist = r * (0.55 + Math.random() * 0.75);
    const sx = this.x + Math.cos(ang) * dist;
    const sy = this.y + Math.sin(ang) * dist;
    const size = 2 + Math.random() * 2.5;
    const spark = this.scene.add
      .star(sx, sy, 4, size * 0.35, size, 0xfff3b0, 0.95)
      .setDepth(3)
      .setRotation(Math.random() * Math.PI);
    this.scene.tweens.add({
      targets: spark,
      alpha: 0,
      scale: 0.15,
      rotation: spark.rotation + 0.6,
      duration: 260 + Math.random() * 160,
      ease: "Quad.easeOut",
      onComplete: () => spark.destroy(),
    });
  }

  _releaseDash() {
    const ratio = this.chargeTime / Q_DASH.MAX_CHARGE_MS;
    const distance = Q_DASH.MIN_DISTANCE + (Q_DASH.MAX_DISTANCE - Q_DASH.MIN_DISTANCE) * ratio;
    this._dash = {
      dx: Math.cos(this.facing),
      dy: Math.sin(this.facing),
      remaining: distance,
    };
    this._dashKilled = false;
    this.setState(STATES.DASH);
    Sfx.dashRelease();
    this._startDashScratch();
  }

  // A scuffed groove in the ground tracing exactly how far the dash actually
  // travels (not the intended max distance) — grown incrementally in
  // _updateDashScratch() each frame so it naturally stops wherever the dash
  // itself stops (wall, kill, or full distance), rather than pre-drawing the
  // whole line up front.
  _startDashScratch() {
    this._dashScratchGfx = this.scene.add.graphics().setDepth(-2);
    this._dashScratchPrevX = this.x;
    this._dashScratchPrevY = this.y;
  }

  _updateDashScratch() {
    if (!this._dashScratchGfx) return;
    const dx = this.x - this._dashScratchPrevX;
    const dy = this.y - this._dashScratchPrevY;
    if (dx === 0 && dy === 0) return;

    const perp = Math.atan2(dy, dx) + Math.PI / 2;
    const offset = 5;
    const jitter = () => (Math.random() - 0.5) * 2;

    for (const side of [1, -1]) {
      this._dashScratchGfx.lineStyle(2, 0x2a2016, 0.45);
      this._dashScratchGfx.beginPath();
      this._dashScratchGfx.moveTo(
        this._dashScratchPrevX + Math.cos(perp) * offset * side,
        this._dashScratchPrevY + Math.sin(perp) * offset * side
      );
      this._dashScratchGfx.lineTo(
        this.x + Math.cos(perp) * offset * side + jitter(),
        this.y + Math.sin(perp) * offset * side + jitter()
      );
      this._dashScratchGfx.strokePath();
    }

    this._dashScratchPrevX = this.x;
    this._dashScratchPrevY = this.y;
  }

  // Fades and clears the current dash's scratch marks — called from every
  // path that ends a DASH (full distance, wall stop, or a kill/hazard death
  // mid-dash) so no orphaned groove is left behind.
  _endDashScratch() {
    if (!this._dashScratchGfx) return;
    const gfx = this._dashScratchGfx;
    this._dashScratchGfx = null;
    this.scene.tweens.add({
      targets: gfx,
      alpha: 0,
      delay: 2200,
      duration: 900,
      onComplete: () => gfx.destroy(),
    });
  }

  _updateDash(dtMs) {
    if (!this._dash) {
      this.enterGCD();
      return;
    }
    const step = (Q_DASH.SPEED * dtMs) / 1000;
    const travel = Math.min(step, this._dash.remaining);
    this.body.setVelocity(this._dash.dx * Q_DASH.SPEED, this._dash.dy * Q_DASH.SPEED);
    this._dash.remaining -= travel;

    if (this._dash.remaining <= 0) {
      this._dash = null;
      this.body.setVelocity(0, 0);
      this._finishDash();
    }
  }

  // Called by the arena when this dash lands a kill (it may pierce and kill
  // more than one target before the dash itself ends).
  markDashKill() {
    this._dashKilled = true;
  }

  // A dash that killed someone skips the global cooldown entirely, same
  // exemption a successful parry gets.
  _finishDash() {
    this._endDashScratch();
    const killed = this._dashKilled;
    this._dashKilled = false;
    if (killed) this.setState(STATES.IDLE);
    else this.enterGCD();
  }

  // Called by the arena when Arcade physics reports this combatant hit a wall mid-dash.
  // Failure penalty: crashing into a wall is worse than a clean whiff in open
  // air, so — unless this dash already scored a kill — it self-stuns instead
  // of just paying the standard global cooldown.
  stopDashOnWall() {
    if (this.state !== STATES.DASH) return;
    this._dash = null;
    this._endDashScratch();
    this.body.setVelocity(0, 0);
    Sfx.wallBump();
    if (this._dashKilled) {
      this._dashKilled = false;
      this.setState(STATES.IDLE);
    } else {
      this.applyStun(WALL_STUN_MS);
    }
  }

  // Called by the arena when this dashing combatant rams a PARRYING opponent.
  selfStunFromParry() {
    if (this.state !== STATES.DASH) return;
    this._dash = null;
    this._endDashScratch();
    this.body.setVelocity(0, 0);
    this.applyStun();
  }

  _updateParrying(dtMs) {
    this.body.setVelocity(0, 0);
    this._tickTimer(dtMs, () => {
      // Timed out without a counter: failure penalty is an extended cooldown
      // (overcommitted to a guard that never paid off).
      this.enterGCD(FAILED_PARRY_GCD_MULTIPLIER);
    });
  }

  // Called by the arena the instant this parrying combatant is touched by a dasher.
  parrySuccess() {
    if (this.state !== STATES.PARRYING || this._parrySuccess) return false;
    this._parrySuccess = true;
    this.setState(STATES.IDLE); // exempt from global cooldown
    Sfx.parrySuccess();
    return true;
  }

  _updateKicking(dtMs) {
    this.body.setVelocity(0, 0);
    this._tickTimer(dtMs, () => {
      // Only kicking through a PARRYING target's guard (E beating W) is a
      // true counter and skips the global cooldown; a plain hit still pays it.
      if (this._kickCounteredParry) this.setState(STATES.IDLE);
      else this.enterGCD();
    });
  }

  get isKickActive() {
    return (
      this.state === STATES.KICKING &&
      !this._kickHitApplied &&
      this.stateTimer <= E_KICK.TOTAL_MS &&
      this.stateTimer > E_KICK.TOTAL_MS - E_KICK.ACTIVE_MS
    );
  }

  markKickApplied(counteredParry = false) {
    this._kickHitApplied = true;
    this._kickCounteredParry = counteredParry;
    Sfx.kickHit();
    this.scene.cameras.main.shake(80, 0.0035);
  }

  _drawKickCone() {
    this.kickCone.clear();
    if (this.state !== STATES.KICKING) return;

    const halfAngle = Phaser.Math.DegToRad(E_KICK.HALF_ANGLE_DEG);
    const elapsed = E_KICK.TOTAL_MS - this.stateTimer;

    if (elapsed <= E_KICK.ACTIVE_MS) {
      // Swipe: the cone sweeps left-to-right across the active window instead
      // of just appearing, so the kick reads as a strike rather than a stamp.
      const t = Phaser.Math.Clamp(elapsed / E_KICK.ACTIVE_MS, 0, 1);
      const sweepEnd = Phaser.Math.Linear(-halfAngle, halfAngle, t);
      this.kickCone.fillStyle(0xfff3b0, 0.75);
      this.kickCone.slice(0, 0, E_KICK.RANGE, -halfAngle, sweepEnd, false);
      this.kickCone.fillPath();
      this.kickCone.lineStyle(3, 0xffcc33, 0.9);
      this.kickCone.beginPath();
      this.kickCone.arc(0, 0, E_KICK.RANGE, -halfAngle, sweepEnd, false);
      this.kickCone.strokePath();
    } else {
      // Recovery: cone fades out from full brightness.
      const t = Phaser.Math.Clamp(
        (elapsed - E_KICK.ACTIVE_MS) / (E_KICK.TOTAL_MS - E_KICK.ACTIVE_MS),
        0,
        1
      );
      this.kickCone.fillStyle(0xffcc33, 0.35 * (1 - t));
      this.kickCone.slice(0, 0, E_KICK.RANGE, -halfAngle, halfAngle, false);
      this.kickCone.fillPath();
    }
  }

  _drawAuraRing() {
    this.auraRing.clear();
    const r = PLAYER.RADIUS;

    if (this.state === STATES.CHARGING) {
      const ratio = this.chargeTime / Q_DASH.MAX_CHARGE_MS;
      const pulse = 1 + 0.08 * Math.sin(this._clock * 0.02);
      this.auraRing.lineStyle(4, 0xff9f43, 0.9);
      this.auraRing.beginPath();
      this.auraRing.arc(0, 0, (r + 7) * pulse, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2, false);
      this.auraRing.strokePath();
    } else if (this.state === STATES.PARRYING) {
      const pulse = r + 10 + 4 * Math.sin(this._clock * 0.03);
      this.auraRing.lineStyle(3, 0x7ff0ff, 0.85);
      this.auraRing.strokeCircle(0, 0, pulse);
      this.auraRing.fillStyle(0x7ff0ff, 0.12);
      this.auraRing.fillCircle(0, 0, pulse);
    } else if (this.state === STATES.STUNNED) {
      const pulse = r + 6 + 2 * Math.sin(this._clock * 0.015);
      this.auraRing.lineStyle(3, 0xff5c5c, 0.7 + 0.3 * Math.sin(this._clock * 0.02));
      this.auraRing.strokeCircle(0, 0, pulse);
    }
  }

  // Pose for the katana-wielding stick figure: grip/tip define the sword line,
  // footL/footR the legs, headX how far the head leads the spine. All in local
  // space with +x = facing direction. At rest everything stays close to the
  // hip/spine (a compact top-down silhouette, not a sprawled side-view stick
  // figure); actions push limbs out much further for an exaggerated, readable
  // strike/lunge/guard silhouette.
  _computePose() {
    const r = PLAYER.RADIUS;
    const lerp = Phaser.Math.Linear;
    let grip = { x: -r * 0.05, y: r * 0.25 };
    let tip = { x: r * 0.15, y: r * 0.65 };
    let footL = { x: -r * 0.3, y: -r * 0.3 };
    let footR = { x: -r * 0.3, y: r * 0.3 };
    let headX = r * 0.25;

    switch (this.state) {
      case STATES.CHARGING: {
        const ratio = this.chargeTime / Q_DASH.MAX_CHARGE_MS;
        grip = { x: lerp(-r * 0.1, r * 0.55, ratio), y: lerp(-r * 0.3, -r * 0.1, ratio) };
        tip = { x: lerp(-r * 1.1, r * 1.9, ratio), y: lerp(-r * 0.6, -r * 0.2, ratio) };
        footL = { x: -r * 0.85, y: -r * 0.7 };
        footR = { x: -r * 0.6, y: r * 0.65 };
        headX = r * 0.15;
        break;
      }
      case STATES.DASH:
        grip = { x: r * 0.7, y: -r * 0.05 };
        tip = { x: r * 2.3, y: -r * 0.35 };
        footL = { x: r * 0.75, y: r * 0.3 };
        footR = { x: -r * 1.35, y: -r * 0.35 };
        headX = r * 0.45;
        break;
      case STATES.PARRYING:
        grip = { x: r * 0.35, y: -r * 0.4 };
        tip = { x: r * 0.35, y: r * 0.65 };
        footL = { x: -r * 0.5, y: -r * 0.55 };
        footR = { x: -r * 0.5, y: r * 0.55 };
        break;
      case STATES.KICKING: {
        grip = { x: -r * 0.25, y: r * 0.25 };
        tip = { x: -r * 1.0, y: r * 0.55 };
        footL = { x: -r * 0.4, y: -r * 0.3 };
        const elapsed = E_KICK.TOTAL_MS - this.stateTimer;
        if (elapsed <= E_KICK.ACTIVE_MS) {
          const t = Phaser.Math.Clamp(elapsed / E_KICK.ACTIVE_MS, 0, 1);
          footR = { x: lerp(-r * 0.15, r * 1.5, t), y: lerp(r * 0.55, 0, t) };
        } else {
          const t = Phaser.Math.Clamp(
            (elapsed - E_KICK.ACTIVE_MS) / (E_KICK.TOTAL_MS - E_KICK.ACTIVE_MS),
            0,
            1
          );
          footR = { x: lerp(r * 1.5, -r * 0.3, t), y: lerp(0, r * 0.3, t) };
        }
        break;
      }
      case STATES.STUNNED:
        headX = r * 0.1;
        grip = { x: -r * 0.15, y: r * 0.35 };
        tip = { x: -r * 0.35, y: r * 0.6 };
        footL = { x: -r * 0.35, y: -r * 0.25 };
        footR = { x: -r * 0.35, y: r * 0.25 };
        break;
      default:
        // IDLE / GCD — alternate the feet fore/aft while actually moving.
        if (this.wantsMove) {
          const swing = Math.sin(this._clock * 0.014) * r * 0.42;
          footL = { x: -r * 0.3 + swing, y: -r * 0.3 };
          footR = { x: -r * 0.3 - swing, y: r * 0.3 };
        }
        break;
    }

    return { grip, tip, footL, footR, headX };
  }

  _drawFigure() {
    const g = this.figure;
    g.clear();
    if (!this.isAlive) return;

    const r = PLAYER.RADIUS;
    const { grip, tip, footL, footR, headX } = this._computePose();
    const hip = { x: -r * 0.2, y: 0 };
    const neck = { x: r * 0.05, y: 0 };

    g.setRotation(this.state === STATES.STUNNED ? Math.sin(this._clock * 0.02) * 0.12 : 0);

    g.lineStyle(4, 0xe8e8f0, 0.95);
    g.beginPath();
    g.moveTo(hip.x, hip.y);
    g.lineTo(footL.x, footL.y);
    g.moveTo(hip.x, hip.y);
    g.lineTo(footR.x, footR.y);
    g.moveTo(neck.x, neck.y);
    g.lineTo(hip.x, hip.y);
    g.strokePath();

    // Shoulder crossbar, perpendicular to facing — reads as a torso viewed
    // from above instead of a single front-to-back line (which looks like a
    // creature crawling rather than a person seen from overhead).
    g.lineStyle(3.5, 0xe8e8f0, 0.95);
    g.beginPath();
    g.moveTo(neck.x, -r * 0.3);
    g.lineTo(neck.x, r * 0.3);
    g.strokePath();

    g.lineStyle(3, 0xe8e8f0, 0.95);
    g.beginPath();
    g.moveTo(neck.x, neck.y);
    g.lineTo(grip.x, grip.y);
    g.strokePath();

    g.lineStyle(3, 0xd7dcec, 1);
    g.beginPath();
    g.moveTo(grip.x, grip.y);
    g.lineTo(tip.x, tip.y);
    g.strokePath();
    g.fillStyle(0xd4af37, 0.9);
    g.fillCircle(grip.x, grip.y, 2.6);

    g.fillStyle(this.color, 1);
    g.fillCircle(headX, 0, r * 0.32);
    g.lineStyle(2, 0xffffff, 0.6);
    g.strokeCircle(headX, 0, r * 0.32);
  }

  // A streaked silhouette left behind every ~22ms during the dash — an
  // elongated body blob plus a bright blade-line, both oriented along the
  // dash direction, reads as a motion afterimage rather than a plain dot.
  _updateAfterimages(dtMs) {
    this._afterimageClock -= dtMs;
    if (this._afterimageClock > 0) return;
    this._afterimageClock = 22;

    const r = PLAYER.RADIUS;
    const ghost = this.scene.add.container(this.x, this.y).setRotation(this.rotation).setDepth(1);
    const body = this.scene.add.ellipse(0, 0, r * 1.9, r * 1.1, this.color, 0.32);
    const blade = this.scene.add.rectangle(r * 1.1, 0, r * 2.2, 2, 0xd7dcec, 0.45);
    ghost.add([body, blade]);
    this.scene.tweens.add({
      targets: ghost,
      alpha: 0,
      scaleX: 0.75,
      scaleY: 0.55,
      duration: 220,
      ease: "Quad.easeOut",
      onComplete: () => ghost.destroy(),
    });
  }

  _spawnDeathBurst(cutAngle) {
    const scene = this.scene;

    this._spawnHalf(cutAngle, 1);
    this._spawnHalf(cutAngle, -1);

    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const spread = cutAngle + (Math.PI / 2) * side + (Math.random() - 0.5) * 0.6;
      const dist = 30 + Math.random() * 40;
      const bit = scene.add.circle(this.x, this.y, 2 + Math.random() * 2, this.color, 0.85);
      scene.tweens.add({
        targets: bit,
        x: this.x + Math.cos(spread) * dist,
        y: this.y + Math.sin(spread) * dist,
        alpha: 0,
        duration: 320 + Math.random() * 120,
        ease: "Cubic.easeOut",
        onComplete: () => bit.destroy(),
      });
    }

    const ring = scene.add.circle(this.x, this.y, PLAYER.RADIUS, 0xffffff, 0);
    ring.setStrokeStyle(3, 0xffffff, 0.9);
    scene.tweens.add({
      targets: ring,
      radius: PLAYER.RADIUS + 46,
      alpha: 0,
      duration: 320,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  // Draws one half-disc (flat edge along cutAngle) and flies it away
  // perpendicular to that line: side=1 goes one way, side=-1 the other.
  _spawnHalf(cutAngle, side) {
    const scene = this.scene;
    const r = PLAYER.RADIUS;
    const start = side > 0 ? cutAngle : cutAngle + Math.PI;

    const half = scene.add.graphics();
    half.setPosition(this.x, this.y);
    half.fillStyle(this.color, 1);
    half.slice(0, 0, r, start, start + Math.PI, false);
    half.fillPath();
    half.lineStyle(2, 0xffffff, 0.85);
    half.beginPath();
    half.moveTo(Math.cos(start) * r, Math.sin(start) * r);
    half.lineTo(Math.cos(start + Math.PI) * r, Math.sin(start + Math.PI) * r);
    half.strokePath();

    const flyAngle = cutAngle + (Math.PI / 2) * side;
    const flyDist = 70 + Math.random() * 30;
    const forwardDrift = 18;

    scene.tweens.add({
      targets: half,
      x: this.x + Math.cos(flyAngle) * flyDist + Math.cos(cutAngle) * forwardDrift,
      y: this.y + Math.sin(flyAngle) * flyDist + Math.sin(cutAngle) * forwardDrift,
      rotation: side * (1.2 + Math.random() * 0.8),
      alpha: 0,
      duration: 480,
      ease: "Cubic.easeOut",
      onComplete: () => half.destroy(),
    });
  }

  // Ground-decal blood: an irregular pool at the kill spot plus a wide spray
  // of droplets that fly out from the cut and leave their own small stains
  // where they land. Everything renders below combatants (depth -1) but
  // above the arena floor (depth -10, see ArenaScene).
  _spawnBloodEffect(cutAngle) {
    const scene = this.scene;
    const cx = this.x;
    const cy = this.y;
    const bloodColors = [0x8a0f0f, 0x6b0a0a, 0xa11616];

    const pool = scene.add.graphics().setDepth(-1).setAlpha(0);
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * 26;
      const rad = 6 + Math.random() * 15;
      pool.fillStyle(Phaser.Utils.Array.GetRandom(bloodColors), 0.5 + Math.random() * 0.3);
      pool.fillCircle(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, rad);
    }
    scene.tweens.add({ targets: pool, alpha: 1, duration: 120 });
    scene.tweens.add({
      targets: pool,
      alpha: 0,
      delay: 6000,
      duration: 1500,
      onComplete: () => pool.destroy(),
    });

    const dropletCount = 22;
    for (let i = 0; i < dropletCount; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const spreadAngle = cutAngle + (Math.PI / 2) * side + (Math.random() - 0.5) * 2.2;
      const dist = 18 + Math.random() * 95;
      const size = 2 + Math.random() * 3;
      const landX = cx + Math.cos(spreadAngle) * dist;
      const landY = cy + Math.sin(spreadAngle) * dist;

      const droplet = scene.add.circle(cx, cy, size, Phaser.Utils.Array.GetRandom(bloodColors), 0.9);
      droplet.setDepth(-1);
      scene.tweens.add({
        targets: droplet,
        x: landX,
        y: landY,
        duration: 180 + Math.random() * 160,
        ease: "Cubic.easeOut",
        onComplete: () => {
          droplet.destroy();
          const stain = scene.add.circle(landX, landY, size * 0.9, 0x7a0f0f, 0.65);
          stain.setDepth(-1);
          scene.tweens.add({
            targets: stain,
            alpha: 0,
            delay: 5000,
            duration: 1200,
            onComplete: () => stain.destroy(),
          });
        },
      });
    }
  }

  _applyKnockbackMotion(dtMs) {
    if (!this._knockback) return;
    this.body.setVelocity(
      this._knockback.dx * this._knockback.speed,
      this._knockback.dy * this._knockback.speed
    );
    this._knockback.remainingMs -= dtMs;
    if (this._knockback.remainingMs <= 0) {
      this._knockback = null;
      this.body.setVelocity(0, 0);
    }
  }
}
