import {
  PLAYER,
  GLOBAL_COOLDOWN_MS,
  STUN_DURATION_MS,
  SLOW_ZONE_FACTOR,
  SLOW_DEBUFF_FACTOR,
  RESPAWN_DELAY_MS,
  WALL_STUN_MS,
  FAILED_PARRY_GCD_MULTIPLIER,
  STATES,
  DEFAULT_CLASS_ID,
  classSkills,
} from "../config/constants.js";
import Sfx from "../audio/Sfx.js";

// Shared FSM + skill logic for anything that can fight in the arena
// (the human-controlled Player and the training Dummy). Subclasses
// set wantsMove/aimAngle/qHeld/wPressed/ePressed each frame before
// calling super.update(); this class only owns state transitions and physics.
export default class Combatant extends Phaser.GameObjects.Container {
  constructor(scene, x, y, color, classId = DEFAULT_CLASS_ID) {
    super(scene, x, y);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.body.setCircle(PLAYER.RADIUS, -PLAYER.RADIUS, -PLAYER.RADIUS);
    this.body.setCollideWorldBounds(true);

    this.color = color;
    this.spawnX = x;
    this.spawnY = y;
    // Fixed for this Combatant's lifetime. Every skill-tuning read below
    // goes through this.skills instead of a bare constant, and every
    // skill-shape branch checks this.skills.skillTypes.{q,w,e} instead of
    // this.classId directly, so a new class only needs a new CLASSES entry.
    this.classId = classId;
    this.skills = classSkills(this.classId);
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
    this.qPressed = false; // tap edge — read by non-charging Q skills (e.g. Knight's comboDash)
    this.wHeld = false; // held-guard classes (e.g. Knight) read this instead of wPressed
    this.wPressed = false;
    this.eHeld = false; // hold-to-charge E classes (e.g. Warrior's divingSlam) read this instead of ePressed
    this.ePressed = false;

    // set by the arena each frame from terrain zones (Q dash ignores this)
    this.inSlowZone = false;

    // per-state scratch data
    this._dash = null; // { dx, dy, remaining, lethal, pierce, widthMultiplier, knockbackDistance, knockbackSpeed }
    this._dashKilled = false; // this dash landed a kill -> skip GCD on completion
    this._kickHitApplied = false;
    this._kickCounteredParry = false; // this kick hit a PARRYING target -> skip GCD
    this._comboHitApplied = false; // Knight combo follow-up: one-shot per COMBO_ATTACK instance
    this._empoweredStrikeHitApplied = false; // Knight empowered Q: one-shot per EMPOWERED_STRIKE instance
    this._parrySuccess = false;
    this._knockback = null; // { dx, dy, remainingMs, speed }
    this._empoweredQMs = 0; // Knight: time left on the empowered-Q buff, granted by a successful block
    this._shieldCharge = null; // Knight E: { dx, dy, remaining }
    this._shieldChargeCounteredGuard = false; // this shield charge hit a PARRYING/guarding target -> skip GCD
    this._axeSwingHitApplied = false; // Warrior Q: one-shot per AXE_SWING instance
    this._battleCryShoutApplied = false; // Warrior W: one-shot per BATTLE_CRY instance
    this._skillsDisabledMs = 0; // time left unable to start Q/W/E (hit by a Warrior's battle cry)
    this._slam = null; // Warrior E: { dx, dy, remaining, impactRadius }
    this._slamImpactHitApplied = false; // Warrior E: one-shot per SLAM_IMPACT instance
    this._laserFireHitApplied = false; // Mage Q: one-shot per LASER_FIRE instance
    this._laser = null; // Mage Q: { length, width }, resolved at release from charge ratio
    this._blizzardHitApplied = false; // Mage E: one-shot per BLIZZARD instance
    this._slowedMs = 0; // time left at reduced move speed (hit by a Mage's blizzard) — see _moveSpeed()
    this._fastChargeMs = 0; // Mage: time left on the fast-charge Q buff, granted by a W block or E freeze
    this._blizzardCounteredGuard = false; // this blizzard hit froze a PARRYING/fluid target -> skip GCD
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

  // Any state whose charge loop (chargeLoopStart/Update) might be running —
  // covers every hold-to-charge skill across all classes so the shared loop
  // sound is guaranteed to stop the instant that state is left for ANY
  // reason (a clean release, a cancel, getting stunned/killed mid-charge,
  // hitting a wall), not just the specific release path each skill happens
  // to code. Individual skills may still call chargeLoopStop() themselves on
  // their own release path too — it's idempotent, so that's harmless, but
  // this is what actually guarantees it can never keep looping.
  static CHARGING_STATES = [STATES.CHARGING, STATES.SLAM_CHARGE, STATES.LASER_CHARGE];

  setState(next) {
    const wasCharging = Combatant.CHARGING_STATES.includes(this.state);
    const isCharging = Combatant.CHARGING_STATES.includes(next);
    if (wasCharging && !isCharging) {
      Sfx.chargeLoopStop();
    }
    this.state = next;
    this.stateLabel.setText(next);
  }

  // Both Warrior's battle cry and Mage's fluid state share this shape: only
  // the first DURATION_MS of the state is invincible; whatever follows (the
  // AOE windup / the haste window) is not. Centralized here rather than
  // special-cased in every ArenaScene hit-test: kill()/applyStun()/
  // applyKnockback() all guard on this, so any current or future skill's
  // hit-application automatically respects it for free. Does NOT protect
  // against dieFromHazard() (ring-out/pit) — that's positional, not a "hit."
  get isInvincible() {
    if (this.state === STATES.BATTLE_CRY) {
      const cfg = this.skills.battleCry;
      return this.stateTimer > cfg.TOTAL_MS - cfg.DURATION_MS;
    }
    if (this.state === STATES.FLUID) {
      const cfg = this.skills.fluidState;
      return this.stateTimer > cfg.TOTAL_MS - cfg.DURATION_MS;
    }
    return false;
  }

  // Called by the arena when this combatant should die instantly (Q hit / ring-out).
  // `cutAngle` is the attacker's travel direction — the body splits along that
  // line and the two halves fly apart perpendicular to it. Returns whether it
  // actually killed (false if already dead or invincible) — callers that grant
  // a GCD exemption/celebratory VFX for "landed a kill" must check this.
  // `attacker`, if given, gets stunned when the kill is blocked by
  // invincibility — attacking a battle-cry Warrior in range is punished,
  // same shape as failing a Q-vs-parry check (only Q-family skills call
  // kill(), so this never fires for E, which is meant to beat W outright).
  kill(cutAngle = this.facing, attacker = null) {
    if (!this.isAlive) return false;
    if (this.isInvincible) {
      if (attacker) attacker.applyStun();
      this._grantFastCharge(); // Mage: a successful W block speeds up the next Q
      // End the cast right now instead of waiting out the rest of its
      // duration — same immediate-response shape as a normal tap-parry's
      // parrySuccess(), and skips GCD entirely (goes straight to IDLE).
      this.setState(STATES.IDLE);
      return false;
    }
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
    this.scene.cameras.main.shake(180, 0.011);
    this.scene.cameras.main.flash(140, 90, 0, 0);
    this._respawnClock = RESPAWN_DELAY_MS;
    return true;
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
    this._displayPose = null;
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
  //
  // `attacker`/`bypassInvincible` mirror kill()'s battle-cry handling: by
  // default a hit blocked by invincibility stuns the attacker instead (Q-
  // family and Knight's shieldCharge-vs-plain-hit path); E-family callers
  // (kickCone, shieldCharge's vs-guard branch, divingSlam) pass
  // bypassInvincible: true instead, since E is designed to beat W/invincibility
  // outright rather than be punished for touching it — hitting a battle-cry
  // Warrior with E stuns THEM, "failing" the battle cry.
  applyStun(durationMs = STUN_DURATION_MS, { attacker = null, bypassInvincible = false } = {}) {
    if (!this.isAlive) return;
    if (this.isInvincible && !bypassInvincible) {
      if (attacker) attacker.applyStun();
      this._grantFastCharge(); // Mage: a successful W block speeds up the next Q
      // End the cast right now instead of waiting out the rest of its
      // duration — same immediate-response shape as a normal tap-parry's
      // parrySuccess(), and skips GCD entirely (goes straight to IDLE).
      this.setState(STATES.IDLE);
      return;
    }
    this._dash = null;
    this.body.setVelocity(0, 0);
    this.setState(STATES.STUNNED);
    this.stateTimer = durationMs;
    Sfx.stun(durationMs);
  }

  // See applyStun() above for the attacker/bypassInvincible contract.
  applyKnockback(fromAngle, distance, speed, { attacker = null, bypassInvincible = false } = {}) {
    if (!this.isAlive) return;
    if (this.isInvincible && !bypassInvincible) {
      if (attacker) attacker.applyStun();
      this._grantFastCharge(); // Mage: a successful W block speeds up the next Q
      // End the cast right now instead of waiting out the rest of its
      // duration — same immediate-response shape as a normal tap-parry's
      // parrySuccess(), and skips GCD entirely (goes straight to IDLE).
      this.setState(STATES.IDLE);
      return;
    }
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
      this._drawFigure(dtMs);
      this.rotation = this.facing;
      this.shadow.setPosition(this.x, this.y + PLAYER.RADIUS * 0.8);
      this.stateLabel.setText(this.state);
      return;
    }
    this._clock += dtMs;
    if (this._empoweredQMs > 0) this._empoweredQMs = Math.max(0, this._empoweredQMs - dtMs);
    if (this._skillsDisabledMs > 0) this._skillsDisabledMs = Math.max(0, this._skillsDisabledMs - dtMs);
    if (this._slowedMs > 0) this._slowedMs = Math.max(0, this._slowedMs - dtMs);
    if (this._fastChargeMs > 0) this._fastChargeMs = Math.max(0, this._fastChargeMs - dtMs);

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
      case STATES.SHIELD_CHARGE:
        this._updateShieldCharge(dtMs);
        break;
      case STATES.COMBO_WINDOW:
        this._updateComboWindow(dtMs);
        break;
      case STATES.COMBO_ATTACK:
        this._updateComboAttack(dtMs);
        break;
      case STATES.EMPOWERED_STRIKE:
        this._updateEmpoweredStrike(dtMs);
        break;
      case STATES.AXE_SWING:
        this._updateAxeSwing(dtMs);
        break;
      case STATES.BATTLE_CRY:
        this._updateBattleCry(dtMs);
        break;
      case STATES.SLAM_CHARGE:
        this._updateSlamCharge(dtMs);
        break;
      case STATES.SLAMMING:
        this._updateSlamming(dtMs);
        break;
      case STATES.SLAM_IMPACT:
        this._updateSlamImpact(dtMs);
        break;
      case STATES.LASER_CHARGE:
        this._updateLaserCharge(dtMs);
        break;
      case STATES.LASER_FIRE:
        this._updateLaserFire(dtMs);
        break;
      case STATES.FLUID:
        this._updateFluidState(dtMs);
        break;
      case STATES.BLIZZARD:
        this._updateBlizzard(dtMs);
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
    this._drawFigure(dtMs);
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

  // Central place every movement speed calculation should route through, so
  // a new externally-inflicted movement debuff (currently just Mage's
  // blizzard slow) only needs to be taught here once instead of at every
  // individual movement-capable state's own velocity calc.
  _moveSpeed(base) {
    let speed = base;
    if (this.inSlowZone) speed *= SLOW_ZONE_FACTOR;
    if (this._slowedMs > 0) speed *= SLOW_DEBUFF_FACTOR;
    return speed;
  }

  _updateIdleLike(dtMs, speedScale) {
    this.facing = this.aimAngle;
    if (this.wantsMove) {
      const speed = this._moveSpeed(speedScale);
      const vx = Math.cos(this.facing) * speed;
      const vy = Math.sin(this.facing) * speed;
      this.body.setVelocity(vx, vy);
    } else {
      this.body.setVelocity(0, 0);
    }
  }

  _tryStartSkills() {
    // Hit by a Warrior's battle cry — can't start any skill (movement/GCD
    // are unaffected) until the debuff timer runs out.
    if (this._skillsDisabledMs > 0) return;

    const skillTypes = this.skills.skillTypes;
    if (skillTypes.q === "comboDash") {
      // No hold-to-charge — a tap fires a fixed-distance dash immediately.
      if (this.qPressed) {
        this._startComboDash();
        return;
      }
    } else if (skillTypes.q === "axeSwing") {
      // No hold-to-charge either — an instant 360-degree hit around self.
      if (this.qPressed) {
        this._startAxeSwing();
        return;
      }
    } else if (skillTypes.q === "laserBeam") {
      // Hold-to-charge like the default below, but the charge/release shape
      // is different enough (must-complete-to-fire, no early-release scaling)
      // that it gets its own state/methods — see _startLaserCharge.
      if (this.qHeld) {
        this._startLaserCharge();
        return;
      }
    } else if (this.qHeld) {
      this.chargeTime = 0;
      this._dash = null;
      this._chargeReadyPlayed = false;
      this.setState(STATES.CHARGING);
      Sfx.chargeLoopStart();
      return;
    }
    if (skillTypes.w === "heldGuard") {
      if (this.wHeld) {
        this._startHeldGuard();
        return;
      }
    } else if (skillTypes.w === "battleCry") {
      if (this.wPressed) {
        this._startBattleCry();
        return;
      }
    } else if (skillTypes.w === "fluidState") {
      if (this.wPressed) {
        this._startFluidState();
        return;
      }
    } else if (this.wPressed) {
      this.setState(STATES.PARRYING);
      this.stateTimer = this.skills.wParry.DURATION_MS;
      this._parrySuccess = false;
      this.body.setVelocity(0, 0);
      Sfx.parryStance();
      return;
    }
    if (skillTypes.e === "shieldCharge") {
      if (this.ePressed) {
        this._startShieldCharge();
        return;
      }
    } else if (skillTypes.e === "divingSlam") {
      // Hold-to-charge, mirrors Q's CHARGING shape but for E — see
      // _startSlamCharge/_updateSlamCharge/_releaseSlam.
      if (this.eHeld) {
        this._startSlamCharge();
        return;
      }
    } else if (skillTypes.e === "blizzard") {
      // Instant tap, no charge — a wide cone burst in the facing direction.
      if (this.ePressed) {
        this._startBlizzard();
        return;
      }
    } else if (this.ePressed) {
      this.setState(STATES.KICKING);
      this.stateTimer = this.skills.eKick.TOTAL_MS;
      this._kickHitApplied = false;
      this._kickCounteredParry = false;
      this.body.setVelocity(0, 0);
      Sfx.kickSwing();
    }
  }

  // Knight W: held while the key/button is down, instead of a fixed-duration
  // tap. See _updateParrying() for the hold-ceiling/early-release exit.
  _startHeldGuard() {
    this.setState(STATES.PARRYING);
    this.stateTimer = this.skills.wParry.MAX_HOLD_MS;
    this._parrySuccess = false;
    this.body.setVelocity(0, 0);
    Sfx.shieldRaise();
  }

  _updateCharging(dtMs) {
    this.facing = this.aimAngle;
    const speed = this._moveSpeed(PLAYER.BASE_SPEED * PLAYER.CHARGE_SPEED_FACTOR);
    if (this.wantsMove) {
      this.body.setVelocity(Math.cos(this.facing) * speed, Math.sin(this.facing) * speed);
    } else {
      this.body.setVelocity(0, 0);
    }

    const qDash = this.skills.qDash;
    this.chargeTime = Math.min(this.chargeTime + dtMs, qDash.MAX_CHARGE_MS);
    Sfx.chargeLoopUpdate(this.chargeTime / qDash.MAX_CHARGE_MS);

    // Charge maxed out (holding past the point it can go any further) —
    // a one-shot "ready" sound plus a sparkle glint every ~70ms around the
    // character telegraphs "fully charged, ready to release" beyond just
    // the aura ring filling.
    if (this.chargeTime >= qDash.MAX_CHARGE_MS) {
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
    const qDash = this.skills.qDash;
    const ratio = this.chargeTime / qDash.MAX_CHARGE_MS;
    const distance = qDash.MIN_DISTANCE + (qDash.MAX_DISTANCE - qDash.MIN_DISTANCE) * ratio;
    this._beginDash(distance);
  }

  // Knight: no hold-to-charge — a tap fires a fixed-distance dash straight
  // from IDLE (see _tryStartSkills), skipping CHARGING entirely. A pending
  // empowered-Q buff redirects this to the stationary line-AOE instead.
  _startComboDash() {
    if (this._empoweredQMs > 0) {
      this._startEmpoweredStrike();
      return;
    }
    this._beginDash(this.skills.qDash.DISTANCE);
  }

  // Shared by both Q shapes: assembles the actual _dash object.
  _beginDash(baseDistance) {
    const qDash = this.skills.qDash;
    this._dash = {
      dx: Math.cos(this.facing),
      dy: Math.sin(this.facing),
      remaining: baseDistance,
      lethal: qDash.LETHAL !== false,
      pierce: qDash.PIERCE !== false,
      widthMultiplier: 1,
      knockbackDistance: qDash.KNOCKBACK_DISTANCE,
      knockbackSpeed: qDash.KNOCKBACK_SPEED,
    };
    this._dashKilled = false;
    this.setState(STATES.DASH);
    if (this.skills.skillTypes.q === "comboDash") Sfx.comboDashRelease();
    else Sfx.dashRelease();
    this._startDashScratch();
  }

  // Empowered Q (Knight, granted by a successful shield block): a stationary
  // wide straight-line AOE in front of the character, not a dash — the
  // character doesn't move. See ArenaScene._checkEmpoweredStrike for the
  // actual rectangle hit-test.
  _startEmpoweredStrike() {
    this._empoweredQMs = 0;
    this._empoweredStrikeHitApplied = false;
    this.body.setVelocity(0, 0);
    this.setState(STATES.EMPOWERED_STRIKE);
    this.stateTimer = this.skills.empoweredStrike.TOTAL_MS;
    Sfx.empoweredQRelease();
  }

  _updateEmpoweredStrike(dtMs) {
    this.body.setVelocity(0, 0);
    this._tickTimer(dtMs, () => this.enterGCD());
  }

  get isEmpoweredStrikeActive() {
    const cfg = this.skills.empoweredStrike;
    return (
      this.state === STATES.EMPOWERED_STRIKE &&
      !this._empoweredStrikeHitApplied &&
      this.stateTimer <= cfg.TOTAL_MS &&
      this.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS
    );
  }

  markEmpoweredStrikeApplied() {
    this._empoweredStrikeHitApplied = true;
  }

  // Warrior Q: instant 360-degree hit around self, no travel, no charge.
  _startAxeSwing() {
    this.setState(STATES.AXE_SWING);
    this.stateTimer = this.skills.axeSwing.TOTAL_MS;
    this._axeSwingHitApplied = false;
    this.body.setVelocity(0, 0);
    Sfx.axeSwing();
  }

  _updateAxeSwing(dtMs) {
    this.body.setVelocity(0, 0);
    this._tickTimer(dtMs, () => this.enterGCD());
  }

  get isAxeSwingActive() {
    const cfg = this.skills.axeSwing;
    return (
      this.state === STATES.AXE_SWING &&
      !this._axeSwingHitApplied &&
      this.stateTimer <= cfg.TOTAL_MS &&
      this.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS
    );
  }

  markAxeSwingApplied() {
    this._axeSwingHitApplied = true;
  }

  // Warrior W: 0.5s self-invincibility (see isInvincible) plus a one-shot
  // AOE debuff burst — see ArenaScene._checkBattleCryShout for the actual
  // AOE application, this only owns the caster's own state/timer.
  _startBattleCry() {
    this.setState(STATES.BATTLE_CRY);
    this.stateTimer = this.skills.battleCry.TOTAL_MS;
    this._battleCryShoutApplied = false;
    this.body.setVelocity(0, 0);
    Sfx.battleCryShout();
  }

  // Unlike every other cast-a-skill window in this game, battle cry doesn't
  // root the Warrior in place — it's mobile for its whole duration (both the
  // invincible phase and the AOE windup), same movement shape as heldGuard.
  _updateBattleCry(dtMs) {
    this.facing = this.aimAngle;
    if (this.wantsMove) {
      const speed = this._moveSpeed(PLAYER.BASE_SPEED);
      this.body.setVelocity(Math.cos(this.facing) * speed, Math.sin(this.facing) * speed);
    } else {
      this.body.setVelocity(0, 0);
    }
    // A successful invincibility block ends the cast immediately (see
    // kill()/applyStun()/applyKnockback()'s isInvincible guard) rather than
    // waiting for this timer, so reaching here always means "no block."
    this._tickTimer(dtMs, () => this.enterGCD());
  }

  // Unlike every other is<X>Active getter, this window sits at the END of
  // the state's duration, not the start — the AOE fires DISABLE_DELAY_MS
  // after invincibility ends, not simultaneously with it (see isInvincible).
  get isBattleCryShoutActive() {
    const cfg = this.skills.battleCry;
    return (
      this.state === STATES.BATTLE_CRY &&
      !this._battleCryShoutApplied &&
      this.stateTimer <= cfg.ACTIVE_MS
    );
  }

  markBattleCryShoutApplied() {
    this._battleCryShoutApplied = true;
  }

  // Warrior E, phase 1/3: hold to charge (mirrors Q's CHARGING shape, but
  // owned by E instead — see _tryStartSkills' divingSlam branch).
  _startSlamCharge() {
    this.chargeTime = 0;
    this.setState(STATES.SLAM_CHARGE);
    Sfx.chargeLoopStart();
  }

  _updateSlamCharge(dtMs) {
    this.facing = this.aimAngle;
    this.body.setVelocity(0, 0);
    const slam = this.skills.divingSlam;
    this.chargeTime = Math.min(this.chargeTime + dtMs, slam.MAX_CHARGE_MS);
    Sfx.chargeLoopUpdate(this.chargeTime / slam.MAX_CHARGE_MS);
    if (!this.eHeld) this._releaseSlam();
  }

  // Warrior E, phase 2/3: the leap itself. Distance/impact radius are both
  // resolved once here from the charge ratio, then carried on this._slam.
  _releaseSlam() {
    const slam = this.skills.divingSlam;
    const ratio = this.chargeTime / slam.MAX_CHARGE_MS;
    this._slam = {
      dx: Math.cos(this.facing),
      dy: Math.sin(this.facing),
      remaining: Phaser.Math.Linear(slam.MIN_LEAP_DISTANCE, slam.MAX_LEAP_DISTANCE, ratio),
      impactRadius: Phaser.Math.Linear(slam.MIN_IMPACT_RADIUS, slam.MAX_IMPACT_RADIUS, ratio),
    };
    this.setState(STATES.SLAMMING);
    Sfx.chargeLoopStop();
    Sfx.slamLeap();
    this.setScale(0.7); // airborne suggestion — flat fast travel, no real z-axis
  }

  _updateSlamming(dtMs) {
    if (!this._slam) {
      this.enterGCD();
      return;
    }
    const slam = this.skills.divingSlam;
    const step = (slam.LEAP_SPEED * dtMs) / 1000;
    const travel = Math.min(step, this._slam.remaining);
    this.body.setVelocity(this._slam.dx * slam.LEAP_SPEED, this._slam.dy * slam.LEAP_SPEED);
    this._slam.remaining -= travel;
    if (this._slam.remaining <= 0) {
      this.body.setVelocity(0, 0);
      this._finishSlamLanding();
    }
  }

  // Warrior E, phase 3/3: landed — brief stationary impact window, hit-test
  // centered on the actual landing position (see
  // ArenaScene._checkSlamImpact), not where the leap started.
  _finishSlamLanding() {
    this.setScale(1);
    this.setState(STATES.SLAM_IMPACT);
    this.stateTimer = this.skills.divingSlam.TOTAL_MS;
    this._slamImpactHitApplied = false;
    Sfx.slamImpact();
  }

  _updateSlamImpact(dtMs) {
    this.body.setVelocity(0, 0);
    this._tickTimer(dtMs, () => this.enterGCD());
  }

  get isSlamImpactActive() {
    const cfg = this.skills.divingSlam;
    return (
      this.state === STATES.SLAM_IMPACT &&
      !this._slamImpactHitApplied &&
      this.stateTimer <= cfg.TOTAL_MS &&
      this.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS
    );
  }

  markSlamImpactApplied() {
    this._slamImpactHitApplied = true;
  }

  // A botched leap crashing into a wall mid-SLAMMING — self-stun, same
  // failure-penalty shape as stopDashOnWall()/stopShieldChargeOnWall().
  stopSlammingOnWall() {
    if (this.state !== STATES.SLAMMING) return;
    this._slam = null;
    this.setScale(1);
    this.body.setVelocity(0, 0);
    Sfx.wallBump();
    this.applyStun(WALL_STUN_MS);
  }

  // Effective charge-completion threshold — normally laserBeam.MIN_CHARGE_MS,
  // but a successful W block or E freeze (see _grantFastCharge) temporarily
  // drops it to fastCharge.CHARGE_MS. Used as the ratio's zero-point too, so
  // length/width scaling stays smooth regardless of which threshold is live.
  get laserMinChargeMs() {
    const laser = this.skills.laserBeam;
    if (this._fastChargeMs > 0 && this.skills.fastCharge) return this.skills.fastCharge.CHARGE_MS;
    return laser.MIN_CHARGE_MS;
  }

  // Reward for a successful W block (an attacker punished by fluid
  // invincibility — see kill()/applyStun()/applyKnockback()) or a successful
  // E freeze (see ArenaScene._checkBlizzard): Q's charge-completion
  // threshold drops until it's used or the buff silently expires. No-op for
  // classes without a fastCharge config (everyone but Mage, so far).
  _grantFastCharge() {
    const cfg = this.skills.fastCharge;
    if (!cfg) return;
    this._fastChargeMs = cfg.DURATION_MS;
  }

  // Mage Q, phase 1/2: hold to charge. Unlike every other charge-based skill
  // in this game, releasing before laserMinChargeMs does nothing at all —
  // the laser must "complete" charging before it can fire; holding further
  // (up to MAX_CHARGE_MS) keeps scaling length/width, resolved at release.
  _startLaserCharge() {
    this.chargeTime = 0;
    this.setState(STATES.LASER_CHARGE);
    Sfx.chargeLoopStart("magiQCharging");
  }

  _updateLaserCharge(dtMs) {
    this.facing = this.aimAngle;
    const laser = this.skills.laserBeam;
    const speed = this._moveSpeed(PLAYER.BASE_SPEED * PLAYER.CHARGE_SPEED_FACTOR);
    if (this.wantsMove) {
      this.body.setVelocity(Math.cos(this.facing) * speed, Math.sin(this.facing) * speed);
    } else {
      this.body.setVelocity(0, 0);
    }
    this.chargeTime = Math.min(this.chargeTime + dtMs, laser.MAX_CHARGE_MS);
    Sfx.chargeLoopUpdate(this.chargeTime / laser.MAX_CHARGE_MS);
    if (!this.qHeld) {
      if (this.chargeTime >= this.laserMinChargeMs) this._releaseLaser();
      else {
        // Released too early — cancelled, no beam, just the standard GCD.
        Sfx.chargeLoopStop();
        this.enterGCD();
      }
    }
  }

  // Mage Q, phase 2/2: length/width are both resolved once here from the
  // charge ratio (0 at laserMinChargeMs, 1 at MAX_CHARGE_MS), then carried
  // on this._laser for ArenaScene._checkLaserFire's rectangle hit-test.
  _releaseLaser() {
    const laser = this.skills.laserBeam;
    const minChargeMs = this.laserMinChargeMs;
    this._fastChargeMs = 0; // consumed on use, same as Knight's empoweredQBuff
    const ratio = Phaser.Math.Clamp(
      (this.chargeTime - minChargeMs) / (laser.MAX_CHARGE_MS - minChargeMs),
      0,
      1
    );
    this._laser = {
      length: Phaser.Math.Linear(laser.MIN_LENGTH, laser.MAX_LENGTH, ratio),
      width: Phaser.Math.Linear(laser.MIN_WIDTH, laser.MAX_WIDTH, ratio),
    };
    this.setState(STATES.LASER_FIRE);
    this.stateTimer = laser.TOTAL_MS;
    this._laserFireHitApplied = false;
    this.body.setVelocity(0, 0);
    Sfx.chargeLoopStop();
    Sfx.laserFire();
  }

  _updateLaserFire(dtMs) {
    this.body.setVelocity(0, 0);
    this._tickTimer(dtMs, () => this.enterGCD());
  }

  get isLaserFireActive() {
    const cfg = this.skills.laserBeam;
    return (
      this.state === STATES.LASER_FIRE &&
      !this._laserFireHitApplied &&
      this.stateTimer <= cfg.TOTAL_MS &&
      this.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS
    );
  }

  markLaserFireApplied() {
    this._laserFireHitApplied = true;
  }

  // Mage W: 0.5s self-invincibility (see isInvincible) immediately followed
  // by a 1s move-speed haste window — both phases are mobile, same movement
  // shape as Warrior's battle cry (see _updateFluidState).
  _startFluidState() {
    this.setState(STATES.FLUID);
    this.stateTimer = this.skills.fluidState.TOTAL_MS;
    this.body.setVelocity(0, 0);
    Sfx.fluidStateStart();
  }

  _updateFluidState(dtMs) {
    this.facing = this.aimAngle;
    const cfg = this.skills.fluidState;
    const hasted = this.stateTimer <= cfg.TOTAL_MS - cfg.DURATION_MS;
    if (this.wantsMove) {
      const speed = this._moveSpeed(PLAYER.BASE_SPEED * (hasted ? cfg.HASTE_MULTIPLIER : 1));
      this.body.setVelocity(Math.cos(this.facing) * speed, Math.sin(this.facing) * speed);
    } else {
      this.body.setVelocity(0, 0);
    }
    // A successful invincibility block ends the cast immediately (see
    // kill()/applyStun()/applyKnockback()'s isInvincible guard) rather than
    // waiting for this timer, so reaching here always means "no block."
    this._tickTimer(dtMs, () => this.enterGCD());
  }

  // Mage E: instant wide cone, no charge — see ArenaScene._checkBlizzard for
  // the actual hit-test/slow-or-freeze application, this only owns the
  // caster's own state/timer (same split as Warrior's axeSwing/battleCry).
  _startBlizzard() {
    this.setState(STATES.BLIZZARD);
    this.stateTimer = this.skills.blizzard.TOTAL_MS;
    this._blizzardHitApplied = false;
    this._blizzardCounteredGuard = false;
    this.body.setVelocity(0, 0);
    Sfx.blizzardCast();
  }

  _updateBlizzard(dtMs) {
    this.body.setVelocity(0, 0);
    this._tickTimer(dtMs, () => {
      // Freezing a PARRYING/fluid target (E beating W) exempts the global
      // cooldown, same as Knight's kick-counters-parry / shield-charge-vs-
      // guard — previously blizzard always paid the full GCD either way.
      if (this._blizzardCounteredGuard) this.setState(STATES.IDLE);
      else this.enterGCD();
    });
  }

  get isBlizzardActive() {
    const cfg = this.skills.blizzard;
    return (
      this.state === STATES.BLIZZARD &&
      !this._blizzardHitApplied &&
      this.stateTimer <= cfg.TOTAL_MS &&
      this.stateTimer > cfg.TOTAL_MS - cfg.ACTIVE_MS
    );
  }

  markBlizzardApplied(counteredGuard = false) {
    this._blizzardHitApplied = true;
    this._blizzardCounteredGuard = counteredGuard;
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
    const step = (this.skills.qDash.SPEED * dtMs) / 1000;
    const travel = Math.min(step, this._dash.remaining);
    this.body.setVelocity(this._dash.dx * this.skills.qDash.SPEED, this._dash.dy * this.skills.qDash.SPEED);
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
  // exemption a successful parry gets. A comboDash always opens a brief
  // follow-up window on completion (whiff or hit alike) unless it killed.
  _finishDash() {
    this._endDashScratch();
    const killed = this._dashKilled;
    this._dashKilled = false;
    if (killed) {
      this.setState(STATES.IDLE);
      return;
    }
    if (this.skills.skillTypes.q === "comboDash") {
      this.setState(STATES.COMBO_WINDOW);
      this.stateTimer = this.skills.comboWindow.WINDOW_MS;
      this.body.setVelocity(0, 0);
      return;
    }
    this.enterGCD();
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

  // Dispatches a wall-collision stop to whichever movement skill is
  // currently active — a future movement skill only needs a branch here,
  // not a re-wire of the arena's wall collider callback.
  handleWallStop() {
    if (this.state === STATES.DASH) this.stopDashOnWall();
    else if (this.state === STATES.SHIELD_CHARGE) this.stopShieldChargeOnWall();
    else if (this.state === STATES.SLAMMING) this.stopSlammingOnWall();
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
    if (this.skills.skillTypes.w === "heldGuard") {
      // Held guard: still mobile, just slowed — the shield goes up but
      // doesn't root the player in place like a tap-parry does.
      this.facing = this.aimAngle;
      if (this.wantsMove) {
        const speed = this._moveSpeed(PLAYER.BASE_SPEED * this.skills.wParry.MOVE_SPEED_MULTIPLIER);
        this.body.setVelocity(Math.cos(this.facing) * speed, Math.sin(this.facing) * speed);
      } else {
        this.body.setVelocity(0, 0);
      }
      // Lowering the shield (voluntary release or hitting the hold-ceiling)
      // pays the standard global cooldown, same as any other skill use — a
      // successful block (parrySuccess()) is the one path that's exempt.
      this.stateTimer -= dtMs;
      if (this.stateTimer <= 0 || !this.wHeld) {
        Sfx.shieldLower();
        this.enterGCD();
      }
      return;
    }
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
    if (this.skills.skillTypes.w === "heldGuard") {
      this._empoweredQMs = this.skills.empoweredQBuff.DURATION_MS;
      Sfx.empoweredQCharge();
    }
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
    const eKick = this.skills.eKick;
    return (
      this.state === STATES.KICKING &&
      !this._kickHitApplied &&
      this.stateTimer <= eKick.TOTAL_MS &&
      this.stateTimer > eKick.TOTAL_MS - eKick.ACTIVE_MS
    );
  }

  markKickApplied(counteredParry = false) {
    this._kickHitApplied = true;
    this._kickCounteredParry = counteredParry;
    Sfx.kickHit();
    this.scene.cameras.main.shake(80, 0.0035);
  }

  // Knight: brief window after a landed comboDash hit to press Q/W/E again
  // for a follow-up swing. Times out into GCD with no extra penalty (the
  // base hit already succeeded) if nothing is pressed in time.
  // Which key is pressed during the window picks a different follow-up:
  // Q -> another hammer swing (COMBO_ATTACK), E -> chain straight into the
  // shield charge, W -> chain straight into raising the shield.
  _updateComboWindow(dtMs) {
    this.body.setVelocity(0, 0);
    // Track the current mouse aim while waiting, so whichever follow-up
    // fires uses where the player is aiming *now* — not the original dash's
    // stale travel direction from before the window opened.
    this.facing = this.aimAngle;
    const skillTypes = this.skills.skillTypes;
    if (this.qHeld) {
      this.setState(STATES.COMBO_ATTACK);
      this.stateTimer = this.skills.comboAttack.TOTAL_MS;
      this._comboHitApplied = false;
      Sfx.comboSwing();
      return;
    }
    if (this.ePressed && skillTypes.e === "shieldCharge") {
      this._startShieldCharge();
      return;
    }
    const wantsW = skillTypes.w === "heldGuard" ? this.wHeld : this.wPressed;
    if (wantsW) {
      if (skillTypes.w === "heldGuard") this._startHeldGuard();
      else {
        this.setState(STATES.PARRYING);
        this.stateTimer = this.skills.wParry.DURATION_MS;
        this._parrySuccess = false;
        Sfx.parryStance();
      }
      return;
    }
    this._tickTimer(dtMs, () => this.enterGCD());
  }

  _updateComboAttack(dtMs) {
    this.body.setVelocity(0, 0);
    this._tickTimer(dtMs, () => this.enterGCD());
  }

  get isComboAttackActive() {
    const combo = this.skills.comboAttack;
    return (
      this.state === STATES.COMBO_ATTACK &&
      !this._comboHitApplied &&
      this.stateTimer <= combo.TOTAL_MS &&
      this.stateTimer > combo.TOTAL_MS - combo.ACTIVE_MS
    );
  }

  markComboHitApplied() {
    this._comboHitApplied = true;
    Sfx.comboHit();
    this.scene.cameras.main.shake(80, 0.0035);
  }

  // Knight E: a short forward shield charge. Mirrors the Q-dash trio
  // (_updateDash/markDashKill/_finishDash) but with its own distance/speed
  // and a different counter-a-guard exemption instead of a counter-a-parry one.
  _startShieldCharge() {
    const eCharge = this.skills.eShieldCharge;
    this._shieldCharge = {
      dx: Math.cos(this.facing),
      dy: Math.sin(this.facing),
      remaining: eCharge.DISTANCE,
    };
    this._shieldChargeCounteredGuard = false;
    this.setState(STATES.SHIELD_CHARGE);
    Sfx.shieldChargeRelease();
  }

  _updateShieldCharge(dtMs) {
    if (!this._shieldCharge) {
      this.enterGCD();
      return;
    }
    const eCharge = this.skills.eShieldCharge;
    const step = (eCharge.SPEED * dtMs) / 1000;
    const travel = Math.min(step, this._shieldCharge.remaining);
    this.body.setVelocity(this._shieldCharge.dx * eCharge.SPEED, this._shieldCharge.dy * eCharge.SPEED);
    this._shieldCharge.remaining -= travel;

    if (this._shieldCharge.remaining <= 0) {
      this._shieldCharge = null;
      this.body.setVelocity(0, 0);
      this._finishShieldCharge();
    }
  }

  // Called by the arena when this shield charge lands a hit — vsGuard=true
  // means it beat a raised (PARRYING) target, which skips the global cooldown
  // same as E beating W does for the swordsman's kick.
  markShieldChargeApplied(vsGuard = false) {
    this._shieldChargeCounteredGuard = vsGuard;
    Sfx.shieldBash();
    this.scene.cameras.main.shake(vsGuard ? 90 : 70, vsGuard ? 0.005 : 0.0035);
  }

  _finishShieldCharge() {
    const counteredGuard = this._shieldChargeCounteredGuard;
    this._shieldChargeCounteredGuard = false;
    if (counteredGuard) this.setState(STATES.IDLE);
    else this.enterGCD();
  }

  stopShieldChargeOnWall() {
    if (this.state !== STATES.SHIELD_CHARGE) return;
    this._shieldCharge = null;
    this.body.setVelocity(0, 0);
    Sfx.wallBump();
    if (this._shieldChargeCounteredGuard) {
      this._shieldChargeCounteredGuard = false;
      this.setState(STATES.IDLE);
    } else {
      this.applyStun(WALL_STUN_MS);
    }
  }

  // Shared cone-sweep melee visual — used by the swordsman's E kick and
  // Knight's combo follow-up swing (only one of KICKING/COMBO_ATTACK is ever
  // active at once, so both can safely share the one kickCone graphics
  // object and draw method).
  _drawKickCone() {
    this.kickCone.clear();
    if (this.state === STATES.EMPOWERED_STRIKE) {
      this._drawEmpoweredStrikeRect();
      return;
    }
    if (this.state === STATES.AXE_SWING) {
      this._drawAxeSwingRing();
      return;
    }
    if (this.state === STATES.BATTLE_CRY) {
      this._drawBattleCryTelegraph();
      return;
    }
    if (this.state === STATES.SLAM_CHARGE || this.state === STATES.SLAMMING) {
      this._drawSlamPreview();
      return;
    }
    if (this.state === STATES.SLAM_IMPACT) {
      this._drawSlamImpactRing();
      return;
    }
    if (this.state === STATES.LASER_CHARGE || this.state === STATES.LASER_FIRE) {
      this._drawLaserPreview();
      return;
    }
    let cfg;
    let fillColor = 0xfff3b0;
    let edgeColor = 0xffcc33;
    if (this.state === STATES.KICKING) {
      cfg = this.skills.eKick;
    } else if (this.state === STATES.COMBO_ATTACK) {
      cfg = this.skills.comboAttack;
      fillColor = 0xffe8c2;
      edgeColor = 0xd98c3a;
    } else if (this.state === STATES.BLIZZARD) {
      // Same cone-sweep shape as the melee cones above (RANGE/HALF_ANGLE_DEG
      // line up), just icy-colored instead of a strike swipe.
      cfg = this.skills.blizzard;
      fillColor = 0xdff6ff;
      edgeColor = 0x7fd0ff;
    } else {
      return;
    }

    const halfAngle = Phaser.Math.DegToRad(cfg.HALF_ANGLE_DEG);
    const elapsed = cfg.TOTAL_MS - this.stateTimer;

    if (elapsed <= cfg.ACTIVE_MS) {
      // Swipe: the cone sweeps left-to-right across the active window instead
      // of just appearing, so the hit reads as a strike rather than a stamp.
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      const sweepEnd = Phaser.Math.Linear(-halfAngle, halfAngle, t);
      this.kickCone.fillStyle(fillColor, 0.75);
      this.kickCone.slice(0, 0, cfg.RANGE, -halfAngle, sweepEnd, false);
      this.kickCone.fillPath();
      this.kickCone.lineStyle(3, edgeColor, 0.9);
      this.kickCone.beginPath();
      this.kickCone.arc(0, 0, cfg.RANGE, -halfAngle, sweepEnd, false);
      this.kickCone.strokePath();
    } else {
      // Recovery: cone fades out from full brightness.
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(edgeColor, 0.35 * (1 - t));
      this.kickCone.slice(0, 0, cfg.RANGE, -halfAngle, halfAngle, false);
      this.kickCone.fillPath();
    }
  }

  // Empowered Q's wide straight-line AOE, drawn in the combatant's own
  // rotated local space (0,0 = character, +x = facing) so it always reads
  // as "in front of me" regardless of current facing.
  _drawEmpoweredStrikeRect() {
    const cfg = this.skills.empoweredStrike;
    const halfW = cfg.WIDTH / 2;
    const elapsed = cfg.TOTAL_MS - this.stateTimer;

    if (elapsed <= cfg.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      this.kickCone.fillStyle(0xffe066, 0.6 * (1 - t * 0.3));
      this.kickCone.fillRect(0, -halfW, cfg.LENGTH, cfg.WIDTH);
      this.kickCone.lineStyle(3, 0xfff3b0, 0.9);
      this.kickCone.strokeRect(0, -halfW, cfg.LENGTH, cfg.WIDTH);
    } else {
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(0xffe066, 0.35 * (1 - t));
      this.kickCone.fillRect(0, -halfW, cfg.LENGTH, cfg.WIDTH);
    }
  }

  // Warrior Q's 360-degree hit radius, drawn as a plain circle around self
  // (no facing dependency, unlike every other range indicator here) so its
  // "everywhere around me" shape reads at a glance.
  _drawAxeSwingRing() {
    const cfg = this.skills.axeSwing;
    const elapsed = cfg.TOTAL_MS - this.stateTimer;
    if (elapsed <= cfg.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      this.kickCone.fillStyle(0xd9c9a3, 0.22 * (1 - t * 0.4));
      this.kickCone.fillCircle(0, 0, cfg.RADIUS);
      this.kickCone.lineStyle(3, 0xd9c9a3, 0.9);
      this.kickCone.strokeCircle(0, 0, cfg.RADIUS);
    } else {
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(0xd9c9a3, 0.12 * (1 - t));
      this.kickCone.fillCircle(0, 0, cfg.RADIUS);
    }
  }

  // Warrior W's AOE shout radius, telegraphed for the entire windup so the
  // "1s after invincibility ends" delay actually reads as a warning instead
  // of a surprise — the ring brightens as the burst approaches, then flashes
  // and fades once the AOE actually fires (see isBattleCryShoutActive).
  _drawBattleCryTelegraph() {
    const cfg = this.skills.battleCry;
    const elapsed = cfg.TOTAL_MS - this.stateTimer;
    const burstStart = cfg.TOTAL_MS - cfg.ACTIVE_MS;
    if (elapsed <= burstStart) {
      const ratio = Phaser.Math.Clamp(elapsed / burstStart, 0, 1);
      const pulse = 0.3 + 0.4 * ratio + 0.15 * Math.sin(this._clock * 0.03);
      this.kickCone.lineStyle(2, 0x8a8f99, pulse);
      this.kickCone.strokeCircle(0, 0, cfg.SHOUT_RADIUS);
    } else {
      const t = Phaser.Math.Clamp((elapsed - burstStart) / cfg.ACTIVE_MS, 0, 1);
      this.kickCone.fillStyle(0x8a8f99, 0.4 * (1 - t));
      this.kickCone.fillCircle(0, 0, cfg.SHOUT_RADIUS);
      this.kickCone.lineStyle(4, 0xffffff, 0.9 * (1 - t));
      this.kickCone.strokeCircle(0, 0, cfg.SHOUT_RADIUS);
    }
  }

  // Warrior E's projected landing spot — a line out to the leap distance
  // plus a circle at the impact radius, both scaling live with charge ratio
  // during SLAM_CHARGE and simply carried over (unchanged) during the leap
  // itself, so the player can see exactly where/how big the slam will land
  // before committing. Local +x is always "facing", which stays fixed for
  // the whole leap once released, so a single dirAngle=0 line covers both
  // states.
  _drawSlamPreview() {
    const slam = this.skills.divingSlam;
    let leapDistance;
    let impactRadius;
    if (this.state === STATES.SLAM_CHARGE) {
      const ratio = this.chargeTime / slam.MAX_CHARGE_MS;
      leapDistance = Phaser.Math.Linear(slam.MIN_LEAP_DISTANCE, slam.MAX_LEAP_DISTANCE, ratio);
      impactRadius = Phaser.Math.Linear(slam.MIN_IMPACT_RADIUS, slam.MAX_IMPACT_RADIUS, ratio);
    } else if (this._slam) {
      leapDistance = this._slam.remaining;
      impactRadius = this._slam.impactRadius;
    } else {
      return;
    }
    this.kickCone.lineStyle(2, 0xc97b3a, 0.55);
    this.kickCone.beginPath();
    this.kickCone.moveTo(0, 0);
    this.kickCone.lineTo(leapDistance, 0);
    this.kickCone.strokePath();
    this.kickCone.fillStyle(0xc97b3a, 0.18);
    this.kickCone.fillCircle(leapDistance, 0, impactRadius);
    this.kickCone.lineStyle(3, 0xc97b3a, 0.85);
    this.kickCone.strokeCircle(leapDistance, 0, impactRadius);
  }

  // Warrior E's actual impact radius at the landing spot, same fade shape as
  // every other fixed-duration attack window.
  _drawSlamImpactRing() {
    const cfg = this.skills.divingSlam;
    const elapsed = cfg.TOTAL_MS - this.stateTimer;
    const radius = this._slam ? this._slam.impactRadius : cfg.MIN_IMPACT_RADIUS;
    if (elapsed <= cfg.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      this.kickCone.fillStyle(0xc97b3a, 0.35 * (1 - t * 0.4));
      this.kickCone.fillCircle(0, 0, radius);
      this.kickCone.lineStyle(3, 0xc97b3a, 0.9);
      this.kickCone.strokeCircle(0, 0, radius);
    } else {
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(0xc97b3a, 0.18 * (1 - t));
      this.kickCone.fillCircle(0, 0, radius);
    }
  }

  // Mage Q's projected beam — a thin preview rectangle that grows in length
  // and width live with charge ratio (mirrors _drawSlamPreview's live-scaling
  // idea), then the actual full-brightness beam rectangle once fired (same
  // fade shape as _drawEmpoweredStrikeRect).
  _drawLaserPreview() {
    const laser = this.skills.laserBeam;
    if (this.state === STATES.LASER_CHARGE) {
      const minChargeMs = this.laserMinChargeMs;
      if (this.chargeTime < minChargeMs) return; // not "complete" yet — nothing to preview
      const ratio = Phaser.Math.Clamp(
        (this.chargeTime - minChargeMs) / (laser.MAX_CHARGE_MS - minChargeMs),
        0,
        1
      );
      const length = Phaser.Math.Linear(laser.MIN_LENGTH, laser.MAX_LENGTH, ratio);
      const halfW = Phaser.Math.Linear(laser.MIN_WIDTH, laser.MAX_WIDTH, ratio) / 2;
      const pulse = 0.35 + 0.15 * Math.sin(this._clock * 0.03);
      this.kickCone.fillStyle(0xb98cff, 0.22 * pulse);
      this.kickCone.fillRect(0, -halfW, length, halfW * 2);
      this.kickCone.lineStyle(2, 0xd9bfff, 0.7);
      this.kickCone.strokeRect(0, -halfW, length, halfW * 2);
      return;
    }
    const cfg = this.skills.laserBeam;
    const halfW = (this._laser ? this._laser.width : cfg.MIN_WIDTH) / 2;
    const length = this._laser ? this._laser.length : cfg.MIN_LENGTH;
    const elapsed = cfg.TOTAL_MS - this.stateTimer;
    if (elapsed <= cfg.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      this.kickCone.fillStyle(0xd9bfff, 0.75 * (1 - t * 0.3));
      this.kickCone.fillRect(0, -halfW, length, halfW * 2);
      this.kickCone.lineStyle(3, 0xf3e8ff, 0.95);
      this.kickCone.strokeRect(0, -halfW, length, halfW * 2);
    } else {
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(0xd9bfff, 0.35 * (1 - t));
      this.kickCone.fillRect(0, -halfW, length, halfW * 2);
    }
  }

  _drawAuraRing() {
    this.auraRing.clear();
    const r = PLAYER.RADIUS;

    if (this.state === STATES.CHARGING) {
      const ratio = this.chargeTime / this.skills.qDash.MAX_CHARGE_MS;
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
    } else if (this.state === STATES.FLUID) {
      // Two-phase read: violet/translucent while actually invincible, then a
      // brighter cyan-white ring once the haste phase kicks in — same idea
      // as the isInvincible/isHasted split in _updateFluidState.
      const pulse = r + 9 + 4 * Math.sin(this._clock * 0.03);
      if (this.isInvincible) {
        this.auraRing.lineStyle(3, 0xb98cff, 0.8);
        this.auraRing.strokeCircle(0, 0, pulse);
        this.auraRing.fillStyle(0xb98cff, 0.15);
        this.auraRing.fillCircle(0, 0, pulse);
      } else {
        this.auraRing.lineStyle(3, 0x8ff0ff, 0.75 + 0.25 * Math.sin(this._clock * 0.04));
        this.auraRing.strokeCircle(0, 0, pulse);
      }
    }

    // Knight empowered-Q glow: persists through IDLE/movement (not tied to
    // any one state), so it's checked independently of the block above —
    // a small pulsing glow at the weapon tip, flickering faster as it nears
    // expiry to telegraph "use it or lose it."
    if (this._empoweredQMs > 0) {
      const tip = this._displayPose?.tip || { x: 0, y: 0 };
      const flicker = this._empoweredQMs < 1000 ? 0.5 + 0.5 * Math.sin(this._clock * 0.05) : 0.85;
      this.auraRing.fillStyle(0xffe066, 0.55 * flicker);
      this.auraRing.fillCircle(tip.x, tip.y, r * 0.28);
    }

    // Mage fast-charge buff (granted by a W block or E freeze): same
    // "use it or lose it" glow shape as the empowered-Q one above, at the
    // staff tip instead of the weapon tip.
    if (this._fastChargeMs > 0) {
      const tip = this._displayPose?.tip || { x: 0, y: 0 };
      const flicker = this._fastChargeMs < 1000 ? 0.5 + 0.5 * Math.sin(this._clock * 0.05) : 0.85;
      this.auraRing.fillStyle(0xd9bfff, 0.55 * flicker);
      this.auraRing.fillCircle(tip.x, tip.y, r * 0.28);
    }

    // Warrior battle-cry debuff: shown on whoever's *affected*, regardless
    // of their own current state — a dull grey pulsing ring, same
    // always-checked pattern as the empowered-Q glow above.
    if (this._skillsDisabledMs > 0) {
      const pulse = r + 8 + 3 * Math.sin(this._clock * 0.025);
      this.auraRing.lineStyle(3, 0x8a8f99, 0.6 + 0.25 * Math.sin(this._clock * 0.02));
      this.auraRing.strokeCircle(0, 0, pulse);
    }

    // Mage blizzard slow: shown on whoever's *affected*, regardless of their
    // own current state — a pale icy pulsing ring, same always-checked
    // pattern as the two debuff glows above.
    if (this._slowedMs > 0) {
      const pulse = r + 7 + 3 * Math.sin(this._clock * 0.02);
      this.auraRing.lineStyle(3, 0x7fd0ff, 0.55 + 0.25 * Math.sin(this._clock * 0.03));
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
    let bob = 0; // forward/back torso bounce, only used by the walk cycle
    let swayRot = 0; // hip-sway rotation, only used by the walk cycle
    // weaponStyle/shield are optional pose descriptors — default values keep
    // the swordsman's silhouette byte-identical; Knight (comboDash/heldGuard)
    // overrides them below.
    const weaponStyle = this.skills.visual?.weaponStyle || "blade";
    let shield = null;

    switch (this.state) {
      case STATES.CHARGING: {
        // Unreachable for comboDash classes (Knight) — they skip CHARGING
        // entirely, see _tryStartSkills/_startComboDash. Only chargeDash
        // (swordsman) ever renders this pose.
        const ratio = this.chargeTime / this.skills.qDash.MAX_CHARGE_MS;
        grip = { x: lerp(-r * 0.1, r * 0.55, ratio), y: lerp(-r * 0.3, -r * 0.1, ratio) };
        tip = { x: lerp(-r * 1.1, r * 1.9, ratio), y: lerp(-r * 0.6, -r * 0.2, ratio) };
        footL = { x: -r * 0.85, y: -r * 0.7 };
        footR = { x: -r * 0.6, y: r * 0.65 };
        headX = r * 0.15;
        break;
      }
      case STATES.DASH:
        if (weaponStyle === "hammer") {
          // Forward swing follow-through — the same strike silhouette as
          // E's cone swing, instead of a blade-point lunge.
          grip = { x: r * 0.4, y: r * 0.5 };
          tip = { x: r * 1.5, y: r * 1.1 };
          footL = { x: r * 0.5, y: -r * 0.3 };
          footR = { x: -r * 1.1, y: r * 0.15 };
          headX = r * 0.35;
        } else {
          grip = { x: r * 0.7, y: -r * 0.05 };
          tip = { x: r * 2.3, y: -r * 0.35 };
          footL = { x: r * 0.75, y: r * 0.3 };
          footR = { x: -r * 1.35, y: -r * 0.35 };
          headX = r * 0.45;
        }
        break;
      case STATES.PARRYING:
        grip = { x: r * 0.35, y: -r * 0.4 };
        tip = { x: r * 0.35, y: r * 0.65 };
        footL = { x: -r * 0.5, y: -r * 0.55 };
        footR = { x: -r * 0.5, y: r * 0.55 };
        if (this.skills.skillTypes.w === "heldGuard") {
          shield = { x: r * 0.15, y: -r * 0.65, w: r * 0.22, h: r * 1.3 };
        }
        break;
      case STATES.SHIELD_CHARGE:
        grip = { x: r * 0.55, y: -r * 0.05 };
        tip = { x: r * 1.1, y: -r * 0.1 };
        footL = { x: r * 0.6, y: r * 0.25 };
        footR = { x: -r * 1.1, y: -r * 0.3 };
        headX = r * 0.4;
        shield = { x: r * 0.5, y: -r * 0.55, w: r * 0.24, h: r * 1.1 };
        break;
      case STATES.COMBO_WINDOW:
        grip = { x: r * 0.1, y: r * 0.1 };
        tip = { x: r * 0.5, y: r * 0.3 };
        footL = { x: -r * 0.4, y: -r * 0.3 };
        footR = { x: -r * 0.4, y: r * 0.3 };
        break;
      case STATES.COMBO_ATTACK: {
        grip = { x: -r * 0.2, y: -r * 0.3 };
        footL = { x: -r * 0.3, y: -r * 0.3 };
        footR = { x: -r * 0.4, y: r * 0.3 };
        const combo = this.skills.comboAttack;
        const comboElapsed = combo.TOTAL_MS - this.stateTimer;
        if (comboElapsed <= combo.ACTIVE_MS) {
          const t = Phaser.Math.Clamp(comboElapsed / combo.ACTIVE_MS, 0, 1);
          tip = { x: lerp(-r * 0.9, r * 1.6, t), y: lerp(-r * 0.5, r * 0.4, t) };
        } else {
          const t = Phaser.Math.Clamp(
            (comboElapsed - combo.ACTIVE_MS) / (combo.TOTAL_MS - combo.ACTIVE_MS),
            0,
            1
          );
          tip = { x: lerp(r * 1.6, r * 0.2, t), y: lerp(r * 0.4, r * 0.6, t) };
        }
        break;
      }
      case STATES.EMPOWERED_STRIKE: {
        // Big rooted overhead-to-forward smash — the character doesn't
        // travel anywhere, only the hammer arcs down across the line AOE.
        const cfg = this.skills.empoweredStrike;
        const elapsed = cfg.TOTAL_MS - this.stateTimer;
        footL = { x: r * 0.3, y: -r * 0.4 };
        footR = { x: -r * 0.5, y: r * 0.4 };
        headX = r * 0.3;
        if (elapsed <= cfg.ACTIVE_MS) {
          const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
          grip = { x: lerp(-r * 0.3, r * 0.6, t), y: lerp(-r * 0.9, r * 0.5, t) };
          tip = { x: lerp(-r * 1.0, r * 2.4, t), y: lerp(-r * 1.3, r * 0.85, t) };
        } else {
          grip = { x: r * 0.6, y: r * 0.5 };
          tip = { x: r * 2.4, y: r * 0.85 };
        }
        break;
      }
      case STATES.AXE_SWING: {
        // Self-centered spin: grip/tip sweep a full circle around the body
        // over the swing's active window, reading as a wide 360-degree cut.
        const cfg = this.skills.axeSwing;
        const elapsed = cfg.TOTAL_MS - this.stateTimer;
        const t = Phaser.Math.Clamp(elapsed / cfg.TOTAL_MS, 0, 1);
        const ang = t * Math.PI * 2.4;
        grip = { x: Math.cos(ang) * r * 0.3, y: Math.sin(ang) * r * 0.3 };
        tip = { x: Math.cos(ang) * r * 1.9, y: Math.sin(ang) * r * 1.9 };
        footL = { x: -r * 0.35, y: -r * 0.4 };
        footR = { x: -r * 0.35, y: r * 0.4 };
        break;
      }
      case STATES.BATTLE_CRY:
        // Raised fists / roaring stance — both weapons pulled in and up.
        grip = { x: r * 0.1, y: -r * 0.15 };
        tip = { x: r * 0.2, y: -r * 0.75 };
        footL = { x: -r * 0.4, y: -r * 0.35 };
        footR = { x: -r * 0.4, y: r * 0.35 };
        headX = r * 0.3;
        break;
      case STATES.SLAM_CHARGE: {
        // Crouched wind-up, ratio-driven like CHARGING.
        const ratio = this.chargeTime / this.skills.divingSlam.MAX_CHARGE_MS;
        grip = { x: lerp(-r * 0.15, r * 0.3, ratio), y: lerp(r * 0.2, -r * 0.5, ratio) };
        tip = { x: lerp(-r * 0.5, r * 0.5, ratio), y: lerp(r * 0.5, -r * 1.1, ratio) };
        footL = { x: -r * 0.55, y: -r * 0.5 };
        footR = { x: -r * 0.55, y: r * 0.5 };
        headX = r * 0.1;
        break;
      }
      case STATES.SLAMMING:
        // Tucked-forward leap — flat fast travel, sold by the scale-down
        // applied in _releaseSlam() rather than a real z-axis.
        grip = { x: r * 0.3, y: -r * 0.3 };
        tip = { x: r * 0.9, y: -r * 0.55 };
        footL = { x: r * 0.2, y: -r * 0.2 };
        footR = { x: r * 0.2, y: r * 0.2 };
        headX = r * 0.3;
        break;
      case STATES.SLAM_IMPACT: {
        // Driven-down double-axe pose at the landing spot.
        const cfg = this.skills.divingSlam;
        const elapsed = cfg.TOTAL_MS - this.stateTimer;
        const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
        grip = { x: lerp(r * 0.3, r * 0.1, t), y: lerp(-r * 0.9, r * 0.4, t) };
        tip = { x: lerp(r * 0.9, r * 0.4, t), y: lerp(-r * 1.3, r * 0.8, t) };
        footL = { x: -r * 0.3, y: -r * 0.4 };
        footR = { x: -r * 0.3, y: r * 0.4 };
        break;
      }
      case STATES.KICKING: {
        grip = { x: -r * 0.25, y: r * 0.25 };
        tip = { x: -r * 1.0, y: r * 0.55 };
        footL = { x: -r * 0.4, y: -r * 0.3 };
        const eKickPose = this.skills.eKick;
        const elapsed = eKickPose.TOTAL_MS - this.stateTimer;
        if (elapsed <= eKickPose.ACTIVE_MS) {
          const t = Phaser.Math.Clamp(elapsed / eKickPose.ACTIVE_MS, 0, 1);
          footR = { x: lerp(-r * 0.15, r * 1.5, t), y: lerp(r * 0.55, 0, t) };
        } else {
          const t = Phaser.Math.Clamp((elapsed - eKickPose.ACTIVE_MS) / (eKickPose.TOTAL_MS - eKickPose.ACTIVE_MS), 0, 1);
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
      case STATES.LASER_CHARGE: {
        // Staff raised and leveled forward, ratio-driven like Q's CHARGING —
        // only reaches full extension once laserMinChargeMs is actually met.
        const ratio = Phaser.Math.Clamp(this.chargeTime / this.laserMinChargeMs, 0, 1);
        grip = { x: lerp(-r * 0.1, r * 0.35, ratio), y: lerp(r * 0.2, -r * 0.15, ratio) };
        tip = { x: lerp(-r * 0.6, r * 1.3, ratio), y: lerp(r * 0.35, -r * 0.2, ratio) };
        footL = { x: -r * 0.55, y: -r * 0.5 };
        footR = { x: -r * 0.55, y: r * 0.5 };
        headX = r * 0.1;
        break;
      }
      case STATES.LASER_FIRE:
        // Staff leveled and held steady along the beam for the whole window
        // — no swing, the beam itself (drawn separately) sells the attack.
        grip = { x: r * 0.35, y: -r * 0.15 };
        tip = { x: r * 1.3, y: -r * 0.2 };
        footL = { x: -r * 0.55, y: -r * 0.5 };
        footR = { x: -r * 0.55, y: r * 0.5 };
        headX = r * 0.1;
        break;
      case STATES.FLUID:
        // Staff pulled in close, arms loose — reads as an insubstantial,
        // unguarded stance rather than a combat pose.
        grip = { x: r * 0.05, y: r * 0.1 };
        tip = { x: r * 0.1, y: r * 0.55 };
        footL = { x: -r * 0.3, y: -r * 0.35 };
        footR = { x: -r * 0.3, y: r * 0.35 };
        break;
      case STATES.BLIZZARD: {
        // Staff swept across the cone's arc over the active window, mirrors
        // COMBO_ATTACK's swipe shape but symmetric (starts+ends wide since
        // the cone itself is 180 degrees).
        const cfg = this.skills.blizzard;
        const elapsed = cfg.TOTAL_MS - this.stateTimer;
        footL = { x: -r * 0.35, y: -r * 0.4 };
        footR = { x: -r * 0.35, y: r * 0.4 };
        if (elapsed <= cfg.ACTIVE_MS) {
          const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
          const ang = lerp(-Math.PI * 0.4, Math.PI * 0.4, t);
          grip = { x: r * 0.15, y: 0 };
          tip = { x: Math.cos(ang) * r * 1.4, y: Math.sin(ang) * r * 1.4 };
        } else {
          grip = { x: r * 0.15, y: 0 };
          tip = { x: r * 1.4, y: 0 };
        }
        break;
      }
      default: {
        // IDLE / GCD — alternate the feet fore/aft while actually moving.
        // Stride cadence follows actual movement speed (slower in a slow
        // zone) so the legs never appear to slide relative to the ground.
        if (this.wantsMove) {
          const speedFactor = this.inSlowZone ? SLOW_ZONE_FACTOR : 1;
          const phase = this._clock * 0.014 * speedFactor;
          const swing = Math.sin(phase) * r * 0.42;
          footL = { x: -r * 0.3 + swing, y: -r * 0.3 };
          footR = { x: -r * 0.3 - swing, y: r * 0.3 };
          // Torso bounces forward twice per stride (once per footfall) and
          // the hips sway with the same phase as the legs — small amounts,
          // just enough to read as a gait instead of a gliding pose.
          bob = Math.abs(Math.sin(phase)) * r * 0.06;
          swayRot = Math.sin(phase) * 0.05;
        }
        break;
      }
    }

    return { grip, tip, footL, footR, headX, bob, swayRot, weaponStyle, shield };
  }

  // Smooths the raw per-state target pose toward what's actually drawn each
  // frame, so switching states (e.g. IDLE walk -> CHARGING) blends the limbs
  // instead of teleporting them; the states that already animate themselves
  // via lerp (CHARGING ratio, KICKING elapsed-time) barely notice this on
  // top since the time constant is short relative to their own durations.
  _drawFigure(dtMs = 16) {
    const g = this.figure;
    g.clear();
    if (!this.isAlive) {
      this._displayPose = null;
      return;
    }

    const r = PLAYER.RADIUS;
    const target = this._computePose();
    if (!this._displayPose) this._displayPose = target;
    const k = 1 - Math.exp(-dtMs / 40);
    const p = this._displayPose;
    const lerpPt = (a, b) => ({
      x: Phaser.Math.Linear(a.x, b.x, k),
      y: Phaser.Math.Linear(a.y, b.y, k),
    });
    p.grip = lerpPt(p.grip, target.grip);
    p.tip = lerpPt(p.tip, target.tip);
    p.footL = lerpPt(p.footL, target.footL);
    p.footR = lerpPt(p.footR, target.footR);
    p.headX = Phaser.Math.Linear(p.headX, target.headX, k);
    p.bob = Phaser.Math.Linear(p.bob || 0, target.bob || 0, k);
    p.swayRot = Phaser.Math.Linear(p.swayRot || 0, target.swayRot || 0, k);
    // Categorical/rect fields — no lerp, just adopt this frame's target.
    p.weaponStyle = target.weaponStyle;
    p.shield = target.shield;
    const { grip, tip, footL, footR, headX, bob, swayRot, weaponStyle, shield } = p;

    const hip = { x: -r * 0.2 + bob, y: 0 };
    const neck = { x: r * 0.05 + bob, y: 0 };

    g.setRotation(
      this.state === STATES.STUNNED ? Math.sin(this._clock * 0.02) * 0.12 : swayRot
    );

    const armored = weaponStyle === "hammer";
    const isAxes = weaponStyle === "axes";
    const isStaff = weaponStyle === "staff";
    // Knight reads heavier/metallic (thicker, steel-grey strokes); Warrior
    // reads leather-tan; Mage reads robe-purple (lighter than plate, still
    // distinct from the swordsman's plain off-white cloth).
    const limbColor = armored ? 0xb0b6c2 : isAxes ? 0xd9c9a3 : isStaff ? 0xb39ddb : 0xe8e8f0;
    const limbWidth = armored ? 5 : isAxes ? 4.5 : isStaff ? 4.5 : 4;

    g.lineStyle(limbWidth, limbColor, 0.95);
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
    g.lineStyle(armored ? 4.5 : 3.5, limbColor, 0.95);
    g.beginPath();
    g.moveTo(neck.x, -r * 0.3);
    g.lineTo(neck.x, r * 0.3);
    g.strokePath();

    if (armored) {
      // Chest plate: a small diamond straddling the shoulder line, reading
      // as breastplate bulk instead of a bare torso line.
      g.fillStyle(0x8a909c, 0.9);
      g.fillPoints(
        [
          { x: neck.x + r * 0.16, y: 0 },
          { x: neck.x, y: -r * 0.22 },
          { x: neck.x - r * 0.1, y: 0 },
          { x: neck.x, y: r * 0.22 },
        ],
        true
      );
    }

    g.lineStyle(3, limbColor, 0.95);
    g.beginPath();
    g.moveTo(neck.x, neck.y);
    g.lineTo(grip.x, grip.y);
    g.strokePath();

    if (armored) {
      // Wooden haft (grip -> tip), metal head drawn separately below at tip —
      // two-tone reads as a hammer, not a uniform blade.
      g.lineStyle(4, 0x6b4a2b, 1);
      g.beginPath();
      g.moveTo(grip.x, grip.y);
      g.lineTo(tip.x, tip.y);
      g.strokePath();
      g.fillStyle(0x4a3320, 0.9);
      g.fillCircle(grip.x, grip.y, 2.8);
    } else if (isAxes) {
      // Short dark leather-wrapped handle — the axe head is drawn separately
      // at the tip end (see drawAxeHead below).
      g.lineStyle(3, 0x4a3320, 1);
      g.beginPath();
      g.moveTo(grip.x, grip.y);
      g.lineTo(tip.x, tip.y);
      g.strokePath();
      g.fillStyle(0x2c2018, 0.9);
      g.fillCircle(grip.x, grip.y, 2.4);
    } else if (isStaff) {
      // Dark wooden shaft — the glowing orb is drawn separately at the tip
      // (see the isStaff block below), same split as the axe head above.
      g.lineStyle(3, 0x4a3b2e, 1);
      g.beginPath();
      g.moveTo(grip.x, grip.y);
      g.lineTo(tip.x, tip.y);
      g.strokePath();
      g.fillStyle(0x2c2018, 0.9);
      g.fillCircle(grip.x, grip.y, 2.6);
    } else {
      g.lineStyle(3, 0xd7dcec, 1);
      g.beginPath();
      g.moveTo(grip.x, grip.y);
      g.lineTo(tip.x, tip.y);
      g.strokePath();
      g.fillStyle(0xd4af37, 0.9);
      g.fillCircle(grip.x, grip.y, 2.6);
    }

    if (armored) {
      // A short rectangle perpendicular to the haft at the tip end, reading
      // as a hammer head rather than a blade point. Glows yellow while the
      // empowered-Q buff is active (or during the empowered strike itself).
      const angle = Math.atan2(tip.y - grip.y, tip.x - grip.x);
      const fx = Math.cos(angle);
      const fy = Math.sin(angle);
      const px = -fy;
      const py = fx;
      const halfLen = 8;
      const halfW = 6;
      const empowered = this._empoweredQMs > 0 || this.state === STATES.EMPOWERED_STRIKE;
      g.fillStyle(empowered ? 0xffe066 : 0x74777f, 1);
      g.fillPoints(
        [
          { x: tip.x + fx * halfLen + px * halfW, y: tip.y + fy * halfLen + py * halfW },
          { x: tip.x + fx * halfLen - px * halfW, y: tip.y + fy * halfLen - py * halfW },
          { x: tip.x - fx * halfLen - px * halfW, y: tip.y - fy * halfLen - py * halfW },
          { x: tip.x - fx * halfLen + px * halfW, y: tip.y - fy * halfLen + py * halfW },
        ],
        true
      );
      g.lineStyle(1, empowered ? 0xfff3b0 : 0x3f4147, 0.9);
      g.strokePoints(
        [
          { x: tip.x + fx * halfLen + px * halfW, y: tip.y + fy * halfLen + py * halfW },
          { x: tip.x + fx * halfLen - px * halfW, y: tip.y + fy * halfLen - py * halfW },
          { x: tip.x - fx * halfLen - px * halfW, y: tip.y - fy * halfLen - py * halfW },
          { x: tip.x - fx * halfLen + px * halfW, y: tip.y - fy * halfLen + py * halfW },
        ],
        true
      );
    }

    if (isAxes) {
      // Small single-bladed hatchet head at the tip, drawn for both the
      // primary hand and a mirrored off-hand axe — computed generically here
      // rather than threading a second grip/tip pair through every pose
      // case. The blade bulges out on one side of the handle line only (not
      // mirrored both sides) so it reads as a hand axe, not a double-bit.
      const drawAxeHead = (gx, gy, tx, ty) => {
        const angle = Math.atan2(ty - gy, tx - gx);
        const fx = Math.cos(angle);
        const fy = Math.sin(angle);
        const px = -fy;
        const py = fx;
        g.fillStyle(0x9aa2ad, 1);
        g.fillPoints(
          [
            { x: tx - fx * 3.5, y: ty - fy * 3.5 },
            { x: tx + fx * 1.5 + px * 6, y: ty + fy * 1.5 + py * 6 },
            { x: tx + fx * 3.5 + px * 2, y: ty + fy * 3.5 + py * 2 },
            { x: tx + fx * 2, y: ty + fy * 2 },
          ],
          true
        );
      };
      drawAxeHead(grip.x, grip.y, tip.x, tip.y);

      const offGrip = { x: grip.x, y: -grip.y };
      const offTip = { x: tip.x, y: -tip.y };
      g.lineStyle(3, limbColor, 0.95);
      g.beginPath();
      g.moveTo(neck.x, neck.y);
      g.lineTo(offGrip.x, offGrip.y);
      g.strokePath();
      g.lineStyle(3, 0x4a3320, 1);
      g.beginPath();
      g.moveTo(offGrip.x, offGrip.y);
      g.lineTo(offTip.x, offTip.y);
      g.strokePath();
      g.fillStyle(0x2c2018, 0.9);
      g.fillCircle(offGrip.x, offGrip.y, 2.4);
      drawAxeHead(offGrip.x, offGrip.y, offTip.x, offTip.y);
    }

    if (isStaff) {
      // Glowing orb at the staff tip — pulses faster/brighter while actively
      // charging or firing the laser, dim idle otherwise.
      const active =
        this.state === STATES.LASER_CHARGE || this.state === STATES.LASER_FIRE;
      const glow = active ? 0.7 + 0.3 * Math.sin(this._clock * 0.06) : 0.55 + 0.15 * Math.sin(this._clock * 0.015);
      g.fillStyle(0xd9bfff, glow);
      g.fillCircle(tip.x, tip.y, active ? 6 : 4.5);
      g.lineStyle(1.5, 0xf3e8ff, 0.8);
      g.strokeCircle(tip.x, tip.y, active ? 6 : 4.5);
    }

    // Head shape is a per-class visual pick (CLASSES[classId].visual.headShape),
    // independent of weapon/skillTypes — e.g. Knight reads "square" (a
    // helmet silhouette); future classes can pick their own so every class
    // is tellable apart at a glance without reading the HUD.
    const headShape = this.skills.visual?.headShape || "circle";
    const headR = r * 0.32;
    g.fillStyle(this.color, 1);
    g.lineStyle(2, 0xffffff, 0.6);
    if (headShape === "square") {
      g.fillRect(headX - headR, -headR, headR * 2, headR * 2);
      g.strokeRect(headX - headR, -headR, headR * 2, headR * 2);
    } else {
      g.fillCircle(headX, 0, headR);
      g.strokeCircle(headX, 0, headR);
    }
    if (armored) {
      // Helmet brow line — a bar across the upper head reads as a
      // visor/helm rim instead of a bare head.
      g.lineStyle(2, 0xb0b6c2, 0.85);
      g.beginPath();
      if (headShape === "square") {
        g.moveTo(headX - headR, -headR * 0.15);
        g.lineTo(headX + headR, -headR * 0.15);
      } else {
        g.arc(headX, 0, headR, Math.PI * 1.15, Math.PI * 1.85, false);
      }
      g.strokePath();
    }
    if (headShape === "horned") {
      // Two small triangular horns angled up-and-out from the sides of the
      // head, reading as a viking helmet.
      g.fillStyle(0xe8e2d0, 0.95);
      for (const side of [1, -1]) {
        const bx = headX - headR * 0.15;
        const by = side * headR * 0.75;
        g.fillPoints(
          [
            { x: bx, y: by },
            { x: bx - headR * 0.85, y: by + side * headR * 1.4 },
            { x: bx + headR * 0.45, y: by + side * headR * 0.5 },
          ],
          true
        );
      }
    }
    if (headShape === "cone") {
      // Pointed wizard hat: a wide brim ellipse at the head's base plus a
      // tall triangle rising off-center, reading as a cone hat rather than a
      // bare head — a robe/staff class needs a silhouette as distinct from
      // the helmets as the horns are.
      g.fillStyle(0x4a3b6e, 0.95);
      g.fillEllipse(headX, 0, headR * 2.3, headR * 0.9);
      g.fillPoints(
        [
          { x: headX - headR * 0.6, y: -headR * 0.15 },
          { x: headX + headR * 0.9, y: headR * 0.15 },
          { x: headX + headR * 0.15, y: -headR * 2.1 },
        ],
        true
      );
    }
    if (this.isInvincible) {
      // Invincibility tint — a pulsing overlay on the head, shown only during
      // the actual invincible phase (not whatever windup/haste follows it).
      // Simplest way to read "different" without reworking every part's own
      // fillStyle call. Color reads per-class: red for Warrior's battle cry,
      // violet for Mage's fluid state.
      const flash = 0.35 + 0.25 * Math.sin(this._clock * 0.05);
      const tintColor = this.state === STATES.FLUID ? 0xb98cff : 0xff4040;
      g.fillStyle(tintColor, flash);
      if (headShape === "square") {
        g.fillRect(headX - headR, -headR, headR * 2, headR * 2);
      } else {
        g.fillCircle(headX, 0, headR);
      }
    }

    if (shield) {
      // Tower shield, off-hand-front. A metal boss + rivet line reads as a
      // real shield face, and a pulsing yellow-outline "light" effect reads
      // as active blocking, per the design doc.
      const glow = 0.5 + 0.5 * Math.sin(this._clock * 0.02);
      g.fillStyle(0x8fa8c8, 0.92);
      g.fillRoundedRect(shield.x, shield.y, shield.w, shield.h, 3);
      const cx = shield.x + shield.w / 2;
      const cy = shield.y + shield.h / 2;
      g.lineStyle(1.5, 0x5c6a80, 0.7);
      g.beginPath();
      g.moveTo(cx, shield.y);
      g.lineTo(cx, shield.y + shield.h);
      g.strokePath();
      g.fillStyle(0xd8dee8, 0.95);
      g.fillCircle(cx, cy, Math.min(shield.w, shield.h) * 0.16);
      g.lineStyle(2, 0xffe066, 0.35 + 0.35 * glow);
      g.strokeRoundedRect(shield.x, shield.y, shield.w, shield.h, 3);
    }
  }

  // A streaked silhouette left behind every ~22ms during the dash — an
  // elongated body blob plus a bright accent line, both oriented along the
  // dash direction, reads as a motion afterimage rather than a plain dot.
  // The accent line is a thin blade streak for the swordsman, but a chunkier
  // dull-metal smear for Knight — a hammer has no blade edge to catch light.
  _updateAfterimages(dtMs) {
    this._afterimageClock -= dtMs;
    if (this._afterimageClock > 0) return;
    this._afterimageClock = 22;

    const r = PLAYER.RADIUS;
    const armored = this.skills.visual?.weaponStyle === "hammer";
    const ghost = this.scene.add.container(this.x, this.y).setRotation(this.rotation).setDepth(1);
    const body = this.scene.add.ellipse(0, 0, r * 1.9, r * 1.1, this.color, 0.32);
    const accent = armored
      ? this.scene.add.rectangle(r * 0.9, 0, r * 1.5, 5, 0x8a909c, 0.4)
      : this.scene.add.rectangle(r * 1.1, 0, r * 2.2, 2, 0xd7dcec, 0.45);
    ghost.add([body, accent]);
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

    // More chunks than before, and a third of them elongated streaks
    // (rotated along their flight angle) rather than plain dots, so the
    // burst reads as flying tissue/shrapnel instead of a firework of dots.
    for (let i = 0; i < 10; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const spread = cutAngle + (Math.PI / 2) * side + (Math.random() - 0.5) * 0.7;
      const dist = 34 + Math.random() * 55;
      const elongated = i % 3 === 0;
      const bit = elongated
        ? scene.add
            .rectangle(this.x, this.y, 6 + Math.random() * 5, 2, this.color, 0.85)
            .setRotation(spread)
        : scene.add.circle(this.x, this.y, 2 + Math.random() * 2.5, this.color, 0.85);
      scene.tweens.add({
        targets: bit,
        x: this.x + Math.cos(spread) * dist,
        y: this.y + Math.sin(spread) * dist,
        alpha: 0,
        scale: elongated ? 0.4 : 1,
        duration: 340 + Math.random() * 160,
        ease: "Cubic.easeOut",
        onComplete: () => bit.destroy(),
      });
    }

    // Double shockwave: a tight white flash ring plus a slower, wider,
    // blood-red one trailing behind it, instead of a single ring — gives
    // the burst more weight without changing its basic "ring" language.
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

    const bloodRing = scene.add.circle(this.x, this.y, PLAYER.RADIUS * 0.6, 0xff2b2b, 0);
    bloodRing.setStrokeStyle(4, 0xb3121f, 0.75);
    scene.tweens.add({
      targets: bloodRing,
      radius: PLAYER.RADIUS + 70,
      alpha: 0,
      delay: 40,
      duration: 460,
      ease: "Quad.easeOut",
      onComplete: () => bloodRing.destroy(),
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
    half.setScale(1.12); // starts slightly oversized and settles fast, reading as the halves popping apart under force
    half.fillStyle(this.color, 1);
    half.slice(0, 0, r, start, start + Math.PI, false);
    half.fillPath();
    half.lineStyle(2, 0xffffff, 0.85);
    half.beginPath();
    half.moveTo(Math.cos(start) * r, Math.sin(start) * r);
    half.lineTo(Math.cos(start + Math.PI) * r, Math.sin(start + Math.PI) * r);
    half.strokePath();
    // Wet inner edge just inside the cut line, so the exposed cross-section
    // reads as fresh gore instead of a flat colored silhouette edge.
    half.lineStyle(4, 0x8a0f0f, 0.8);
    half.beginPath();
    half.moveTo(Math.cos(start) * r * 0.94, Math.sin(start) * r * 0.94);
    half.lineTo(Math.cos(start + Math.PI) * r * 0.94, Math.sin(start + Math.PI) * r * 0.94);
    half.strokePath();

    const flyAngle = cutAngle + (Math.PI / 2) * side;
    const flyDist = 85 + Math.random() * 40;
    const forwardDrift = 18;
    const spin = side * (1.6 + Math.random() * 1.2);

    scene.tweens.add({ targets: half, scaleX: 1, scaleY: 1, duration: 90, ease: "Quad.easeOut" });
    scene.tweens.add({
      targets: half,
      x: this.x + Math.cos(flyAngle) * flyDist + Math.cos(cutAngle) * forwardDrift,
      y: this.y + Math.sin(flyAngle) * flyDist + Math.sin(cutAngle) * forwardDrift,
      rotation: spin,
      duration: 520,
      ease: "Cubic.easeOut",
    });
    // Fade/shrink is held off until the tail end of the flight rather than
    // running the whole time, so the halves feel like they lose momentum
    // and slump instead of just dissolving mid-air.
    scene.tweens.add({
      targets: half,
      alpha: 0,
      scaleX: 0.7,
      scaleY: 0.7,
      delay: 260,
      duration: 260,
      ease: "Cubic.easeIn",
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

    // Directional spray fan on each side of the cut — a wide translucent
    // wedge instead of just an even circular pool — reads as a gush along
    // the slice rather than a puddle appearing from nowhere.
    for (const side of [1, -1]) {
      const fan = scene.add.graphics().setDepth(-1).setAlpha(0);
      const centerAngle = cutAngle + (Math.PI / 2) * side;
      const halfSpread = 0.75;
      fan.fillStyle(Phaser.Utils.Array.GetRandom(bloodColors), 0.35);
      fan.beginPath();
      fan.moveTo(cx, cy);
      fan.arc(cx, cy, 60 + Math.random() * 40, centerAngle - halfSpread, centerAngle + halfSpread, false);
      fan.closePath();
      fan.fillPath();
      scene.tweens.add({ targets: fan, alpha: 1, duration: 90 });
      scene.tweens.add({
        targets: fan,
        alpha: 0,
        delay: 4500,
        duration: 1500,
        onComplete: () => fan.destroy(),
      });
    }

    const pool = scene.add.graphics().setDepth(-1).setAlpha(0);
    for (let i = 0; i < 20; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * 30;
      const rad = 6 + Math.random() * 18;
      pool.fillStyle(Phaser.Utils.Array.GetRandom(bloodColors), 0.5 + Math.random() * 0.3);
      pool.fillCircle(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, rad);
    }
    scene.tweens.add({ targets: pool, alpha: 1, duration: 120 });
    scene.tweens.add({
      targets: pool,
      alpha: 0,
      delay: 7000,
      duration: 1500,
      onComplete: () => pool.destroy(),
    });

    const dropletCount = 34;
    for (let i = 0; i < dropletCount; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const spreadAngle = cutAngle + (Math.PI / 2) * side + (Math.random() - 0.5) * 2.2;
      const dist = 18 + Math.random() * 110;
      const size = 2 + Math.random() * 3.5;
      const landX = cx + Math.cos(spreadAngle) * dist;
      const landY = cy + Math.sin(spreadAngle) * dist;

      // Elongated along its travel direction, and rotated to match, so it
      // reads as a flung droplet mid-flight rather than a dot sliding
      // sideways.
      const droplet = scene.add
        .ellipse(cx, cy, size * 2.2, size, Phaser.Utils.Array.GetRandom(bloodColors), 0.9)
        .setRotation(spreadAngle);
      droplet.setDepth(-1);
      scene.tweens.add({
        targets: droplet,
        x: landX,
        y: landY,
        duration: 160 + Math.random() * 160,
        ease: "Cubic.easeOut",
        onComplete: () => {
          droplet.destroy();
          const stain = scene.add.circle(landX, landY, size * 1.1, 0x7a0f0f, 0.65);
          stain.setDepth(-1);
          scene.tweens.add({
            targets: stain,
            alpha: 0,
            delay: 6000,
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
