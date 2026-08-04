import { PLAYER, STATES, classSkills } from "../config/constants.js";
import Sfx from "../audio/Sfx.js";

// Visual-only counterpart to Combatant.js for the Phase 2/3 networked
// client: the server is authoritative for everything (position, state,
// chargeTime, stunTimer, globalCooldown, isAlive), so this class owns no
// physics/input/FSM at all — it just renders whatever snapshot sync() is
// given each frame, using the exact same stick-figure pose/draw logic as
// Combatant.js (kept in sync by hand; there's no shared base class since
// Combatant is tightly coupled to Phaser Arcade physics the server doesn't
// use).
//
// KICKING/PARRYING don't have a synced countdown field (only chargeTime,
// stunTimer, and globalCooldown are in the documented network schema), so
// this tracks its own "time since state last changed" locally to drive the
// kick-cone sweep — a close-enough visual approximation since the shared
// E_KICK constants give it the same timing the server judges hits with.
export default class NetFighter {
  constructor(scene, color, nickname) {
    this.scene = scene;
    this.color = color;

    this.container = scene.add.container(0, 0);
    this.shadow = scene.add.ellipse(0, 0, PLAYER.RADIUS * 1.6, PLAYER.RADIUS * 0.7, 0x000000, 0.32).setDepth(-0.5);
    this.kickCone = scene.add.graphics();
    this.auraRing = scene.add.graphics();
    this.figure = scene.add.graphics();
    // Nickname above the fighter's head, always upright regardless of the
    // container's rotation (set on a Phaser container, text would otherwise
    // spin with the facing angle) — see the counter-rotation in sync().
    this.nicknameLabel = scene.add
      .text(0, -PLAYER.RADIUS - 30, nickname || "", {
        font: "bold 12px monospace",
        color: "#ffe9c4",
        stroke: "#1a1206",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);
    this.container.add([this.kickCone, this.auraRing, this.figure, this.nicknameLabel]);

    this._clock = 0;
    this._skills = classSkills(undefined); // re-resolved per snapshot's classId in sync()
    this._prevState = null;
    this._sinceStateMs = 0;
    this._lastX = 0;
    this._lastY = 0;

    // Render-side position/angle smoothing: `snapshot` here is already an
    // interpolated point in time (see NetArenaScene's snapshot buffer /
    // _getInterpolatedSnapshot), not a raw server patch, but we still ease
    // toward it rather than snapping straight there — a further cheap layer
    // of smoothing against any residual per-frame jitter in that stream.
    this._renderX = null;
    this._renderY = null;
    this._renderAngle = null;
    this._prevAlive = null;

    // Single-player-parity Q feedback (Combatant.js): max-charge sparkles +
    // one-shot "ready" cue, a streaked dash afterimage, and a ground scratch
    // mark grown along the actual dash path.
    this._maxChargeSparkleClock = 0;
    this._chargeReadyPlayed = false;
    this._afterimageClock = 0;
    this._dashScratchGfx = null;
    this._dashScratchPrevX = 0;
    this._dashScratchPrevY = 0;
  }

  destroy() {
    this.shadow.destroy();
    this.container.destroy();
    if (this._dashScratchGfx) {
      this._dashScratchGfx.destroy();
      this._dashScratchGfx = null;
    }
  }

  sync(snapshot, dtMs) {
    const { x, y, angle, state, chargeTime, stunTimer, isAlive } = snapshot;
    this._clock += dtMs;
    this._skills = classSkills(snapshot.classId);
    this._empoweredQActive = snapshot.empoweredQActive; // read by _drawFigure's hammer-head glow

    const prevState = this._prevState;
    if (state !== prevState) {
      this._sinceStateMs = 0;
      this._prevState = state;
    } else {
      this._sinceStateMs += dtMs;
    }
    const moving = Math.hypot(x - this._lastX, y - this._lastY) > 0.1;
    this._lastX = x;
    this._lastY = y;

    // isAlive going true -> false, once — the schema has no cutAngle field
    // so `angle` (facing at the moment of death) stands in for it, same
    // fallback Combatant.kill() uses (cutAngle = this.facing).
    const justDied = this._prevAlive === true && !isAlive;

    if (state === STATES.CHARGING && prevState !== STATES.CHARGING) {
      this._chargeReadyPlayed = false;
      this._maxChargeSparkleClock = 0;
    }
    if (state === STATES.DASH && prevState !== STATES.DASH) {
      this._startDashScratch();
    } else if (prevState === STATES.DASH && state !== STATES.DASH) {
      this._endDashScratch();
    }

    // Snap instantly on first sync and on respawn (a server-side teleport
    // back to the spawn point) — smoothing across either would draw a
    // visible slide from the old spot to the new one.
    const justRespawned = isAlive && this._prevAlive === false;
    if (this._renderX === null || justRespawned) {
      this._renderX = x;
      this._renderY = y;
      this._renderAngle = angle;
    } else {
      const t = 1 - Math.exp(-22 * (dtMs / 1000));
      this._renderX = Phaser.Math.Linear(this._renderX, x, t);
      this._renderY = Phaser.Math.Linear(this._renderY, y, t);
      this._renderAngle = Phaser.Math.Angle.Wrap(
        this._renderAngle + Phaser.Math.Angle.Wrap(angle - this._renderAngle) * t
      );
    }
    this._prevAlive = isAlive;

    if (justDied) this._die(x, y, angle);

    this.container.setPosition(this._renderX, this._renderY);
    this.container.setRotation(this._renderAngle);
    // Counter-rotate the text label so it stays upright/readable instead
    // of spinning with the container's facing angle.
    this.nicknameLabel.setRotation(-this._renderAngle);
    this.shadow.setPosition(this._renderX, this._renderY + PLAYER.RADIUS * 0.8);
    this.shadow.setAlpha(isAlive ? 1 : 0);
    this.container.setAlpha(isAlive ? 1 : 0);

    if (!isAlive) {
      this.figure.clear();
      this.kickCone.clear();
      this.auraRing.clear();
      return;
    }

    if (state === STATES.CHARGING && chargeTime >= this._skills.qDash.MAX_CHARGE_MS) {
      if (!this._chargeReadyPlayed) {
        this._chargeReadyPlayed = true;
        Sfx.chargeReady();
      }
      this._maxChargeSparkleClock -= dtMs;
      if (this._maxChargeSparkleClock <= 0) {
        this._maxChargeSparkleClock = 70;
        this._spawnChargeSparkle();
      }
    }
    if (state === STATES.DASH) {
      this._afterimageClock -= dtMs;
      if (this._afterimageClock <= 0) {
        this._afterimageClock = 22;
        this._spawnAfterimage();
      }
      this._updateDashScratch();
    }

    const pose = this._computePose(state, chargeTime, moving, snapshot.fastChargeActive);
    this._drawFigure(state, pose);
    this._drawKickCone(state, chargeTime, snapshot.fastChargeActive);
    this._drawAuraRing(
      state,
      chargeTime,
      stunTimer,
      pose,
      snapshot.empoweredQActive,
      snapshot.skillsDisabled,
      snapshot.fastChargeActive,
      snapshot.slowed
    );
  }

  // Activation SFX for state transitions live in NetArenaScene's
  // _detectFighterEvents (matching Combatant.js's call sites one-for-one),
  // not here — that function already runs for every fighter including the
  // local player, so duplicating it in this purely-visual class would just
  // double-fire every sound.

  // ---- Q feedback FX (ported from Combatant.js) ------------------------

  _spawnChargeSparkle() {
    const r = PLAYER.RADIUS;
    const ang = Math.random() * Math.PI * 2;
    const dist = r * (0.55 + Math.random() * 0.75);
    const sx = this._renderX + Math.cos(ang) * dist;
    const sy = this._renderY + Math.sin(ang) * dist;
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

  _spawnAfterimage() {
    const r = PLAYER.RADIUS;
    const ghost = this.scene.add.container(this._renderX, this._renderY).setRotation(this._renderAngle).setDepth(1);
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

  _startDashScratch() {
    this._dashScratchGfx = this.scene.add.graphics().setDepth(-2);
    this._dashScratchPrevX = this._renderX;
    this._dashScratchPrevY = this._renderY;
  }

  _updateDashScratch() {
    if (!this._dashScratchGfx) return;
    const dx = this._renderX - this._dashScratchPrevX;
    const dy = this._renderY - this._dashScratchPrevY;
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
        this._renderX + Math.cos(perp) * offset * side + jitter(),
        this._renderY + Math.sin(perp) * offset * side + jitter()
      );
      this._dashScratchGfx.strokePath();
    }

    this._dashScratchPrevX = this._renderX;
    this._dashScratchPrevY = this._renderY;
  }

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

  // ---- Death VFX (ported from Combatant.js's kill()) --------------------
  // The server owns the FSM/kill decision here — this only reacts to
  // isAlive flipping false (see the justDied check in sync()) and plays
  // the same split-body + blood-spray visuals as single-player, at the
  // position/facing the server reported at the moment of death.

  _die(x, y, cutAngle) {
    Sfx.death();
    this.scene.cameras.main.shake(180, 0.011);
    this.scene.cameras.main.flash(140, 90, 0, 0);
    this._spawnDeathBurst(x, y, cutAngle);
    this._spawnBloodEffect(x, y, cutAngle);
  }

  _spawnDeathBurst(x, y, cutAngle) {
    const scene = this.scene;

    this._spawnHalf(x, y, cutAngle, 1);
    this._spawnHalf(x, y, cutAngle, -1);

    // More chunks than before, and a third of them elongated streaks
    // (rotated along their flight angle) rather than plain dots, so the
    // burst reads as flying tissue/shrapnel instead of a firework of dots.
    for (let i = 0; i < 10; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const spread = cutAngle + (Math.PI / 2) * side + (Math.random() - 0.5) * 0.7;
      const dist = 34 + Math.random() * 55;
      const elongated = i % 3 === 0;
      const bit = elongated
        ? scene.add.rectangle(x, y, 6 + Math.random() * 5, 2, this.color, 0.85).setRotation(spread)
        : scene.add.circle(x, y, 2 + Math.random() * 2.5, this.color, 0.85);
      scene.tweens.add({
        targets: bit,
        x: x + Math.cos(spread) * dist,
        y: y + Math.sin(spread) * dist,
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
    const ring = scene.add.circle(x, y, PLAYER.RADIUS, 0xffffff, 0);
    ring.setStrokeStyle(3, 0xffffff, 0.9);
    scene.tweens.add({
      targets: ring,
      radius: PLAYER.RADIUS + 46,
      alpha: 0,
      duration: 320,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });

    const bloodRing = scene.add.circle(x, y, PLAYER.RADIUS * 0.6, 0xff2b2b, 0);
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
  _spawnHalf(x, y, cutAngle, side) {
    const scene = this.scene;
    const r = PLAYER.RADIUS;
    const start = side > 0 ? cutAngle : cutAngle + Math.PI;

    const half = scene.add.graphics();
    half.setPosition(x, y);
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
      x: x + Math.cos(flyAngle) * flyDist + Math.cos(cutAngle) * forwardDrift,
      y: y + Math.sin(flyAngle) * flyDist + Math.sin(cutAngle) * forwardDrift,
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
  _spawnBloodEffect(x, y, cutAngle) {
    const scene = this.scene;
    const cx = x;
    const cy = y;
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

  _computePose(state, chargeTime, moving, fastChargeActive) {
    const r = PLAYER.RADIUS;
    const lerp = Phaser.Math.Linear;
    let grip = { x: -r * 0.05, y: r * 0.25 };
    let tip = { x: r * 0.15, y: r * 0.65 };
    let footL = { x: -r * 0.3, y: -r * 0.3 };
    let footR = { x: -r * 0.3, y: r * 0.3 };
    let headX = r * 0.25;
    let shield = null;
    const weaponStyle = this._skills.visual?.weaponStyle || "blade";

    switch (state) {
      case STATES.CHARGING: {
        const ratio = chargeTime / this._skills.qDash.MAX_CHARGE_MS;
        grip = { x: lerp(-r * 0.1, r * 0.55, ratio), y: lerp(-r * 0.3, -r * 0.1, ratio) };
        tip = { x: lerp(-r * 1.1, r * 1.9, ratio), y: lerp(-r * 0.6, -r * 0.2, ratio) };
        footL = { x: -r * 0.85, y: -r * 0.7 };
        footR = { x: -r * 0.6, y: r * 0.65 };
        headX = r * 0.15;
        break;
      }
      case STATES.DASH:
        if (weaponStyle === "hammer") {
          // Forward swing follow-through — same strike silhouette as the
          // combo cone swing, instead of a blade-point lunge.
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
        if (this._skills.skillTypes.w === "heldGuard") {
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
        const combo = this._skills.comboAttack;
        const comboElapsed = this._sinceStateMs;
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
        const cfg = this._skills.empoweredStrike;
        const elapsed = this._sinceStateMs;
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
      case STATES.KICKING: {
        grip = { x: -r * 0.25, y: r * 0.25 };
        tip = { x: -r * 1.0, y: r * 0.55 };
        footL = { x: -r * 0.4, y: -r * 0.3 };
        const elapsed = this._sinceStateMs;
        const eKickPose = this._skills.eKick;
        if (elapsed <= eKickPose.ACTIVE_MS) {
          const t = Phaser.Math.Clamp(elapsed / eKickPose.ACTIVE_MS, 0, 1);
          footR = { x: lerp(-r * 0.15, r * 1.5, t), y: lerp(r * 0.55, 0, t) };
        } else {
          const t = Phaser.Math.Clamp(
            (elapsed - eKickPose.ACTIVE_MS) / (eKickPose.TOTAL_MS - eKickPose.ACTIVE_MS),
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
      case STATES.AXE_SWING: {
        // Self-centered spin: grip/tip sweep a full circle around the body
        // over the swing's active window, reading as a wide 360-degree cut.
        const cfg = this._skills.axeSwing;
        const t = Phaser.Math.Clamp(this._sinceStateMs / cfg.TOTAL_MS, 0, 1);
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
        // Crouched wind-up, ratio-driven like CHARGING — off the real
        // synced chargeTime, so this stays in sync for remote players too.
        const ratio = chargeTime / this._skills.divingSlam.MAX_CHARGE_MS;
        grip = { x: lerp(-r * 0.15, r * 0.3, ratio), y: lerp(r * 0.2, -r * 0.5, ratio) };
        tip = { x: lerp(-r * 0.5, r * 0.5, ratio), y: lerp(r * 0.5, -r * 1.1, ratio) };
        footL = { x: -r * 0.55, y: -r * 0.5 };
        footR = { x: -r * 0.55, y: r * 0.5 };
        headX = r * 0.1;
        break;
      }
      case STATES.SLAMMING:
        // Tucked-forward leap — flat fast travel.
        grip = { x: r * 0.3, y: -r * 0.3 };
        tip = { x: r * 0.9, y: -r * 0.55 };
        footL = { x: r * 0.2, y: -r * 0.2 };
        footR = { x: r * 0.2, y: r * 0.2 };
        headX = r * 0.3;
        break;
      case STATES.SLAM_IMPACT: {
        // Driven-down double-axe pose at the landing spot.
        const cfg = this._skills.divingSlam;
        const t = Phaser.Math.Clamp(this._sinceStateMs / cfg.ACTIVE_MS, 0, 1);
        grip = { x: lerp(r * 0.3, r * 0.1, t), y: lerp(-r * 0.9, r * 0.4, t) };
        tip = { x: lerp(r * 0.9, r * 0.4, t), y: lerp(-r * 1.3, r * 0.8, t) };
        footL = { x: -r * 0.3, y: -r * 0.4 };
        footR = { x: -r * 0.3, y: r * 0.4 };
        break;
      }
      case STATES.LASER_CHARGE: {
        // Staff raised and leveled forward, ratio-driven like Q's CHARGING
        // — only reaches full extension once the effective charge threshold
        // (fastCharge-aware, same as the server) is actually met.
        const laser = this._skills.laserBeam;
        const minChargeMs =
          fastChargeActive && this._skills.fastCharge ? this._skills.fastCharge.CHARGE_MS : laser.MIN_CHARGE_MS;
        const ratio = Phaser.Math.Clamp(chargeTime / minChargeMs, 0, 1);
        grip = { x: lerp(-r * 0.1, r * 0.35, ratio), y: lerp(r * 0.2, -r * 0.15, ratio) };
        tip = { x: lerp(-r * 0.6, r * 1.3, ratio), y: lerp(r * 0.35, -r * 0.2, ratio) };
        footL = { x: -r * 0.55, y: -r * 0.5 };
        footR = { x: -r * 0.55, y: r * 0.5 };
        headX = r * 0.1;
        break;
      }
      case STATES.LASER_FIRE:
        // Staff leveled and held steady along the beam for the whole window
        // — the beam itself (drawn separately) sells the attack.
        grip = { x: r * 0.35, y: -r * 0.15 };
        tip = { x: r * 1.3, y: -r * 0.2 };
        footL = { x: -r * 0.55, y: -r * 0.5 };
        footR = { x: -r * 0.55, y: r * 0.5 };
        headX = r * 0.1;
        break;
      case STATES.FLUID:
        // Staff pulled in close, arms loose — reads as insubstantial rather
        // than a combat pose.
        grip = { x: r * 0.05, y: r * 0.1 };
        tip = { x: r * 0.1, y: r * 0.55 };
        footL = { x: -r * 0.3, y: -r * 0.35 };
        footR = { x: -r * 0.3, y: r * 0.35 };
        break;
      case STATES.BLIZZARD: {
        // Staff swept across the cone's arc over the active window —
        // symmetric since the cone itself is 180 degrees.
        const cfg = this._skills.blizzard;
        footL = { x: -r * 0.35, y: -r * 0.4 };
        footR = { x: -r * 0.35, y: r * 0.4 };
        if (this._sinceStateMs <= cfg.ACTIVE_MS) {
          const t = Phaser.Math.Clamp(this._sinceStateMs / cfg.ACTIVE_MS, 0, 1);
          const ang = lerp(-Math.PI * 0.4, Math.PI * 0.4, t);
          grip = { x: r * 0.15, y: 0 };
          tip = { x: Math.cos(ang) * r * 1.4, y: Math.sin(ang) * r * 1.4 };
        } else {
          grip = { x: r * 0.15, y: 0 };
          tip = { x: r * 1.4, y: 0 };
        }
        break;
      }
      default:
        if (moving) {
          const swing = Math.sin(this._clock * 0.014) * r * 0.42;
          footL = { x: -r * 0.3 + swing, y: -r * 0.3 };
          footR = { x: -r * 0.3 - swing, y: r * 0.3 };
        }
        break;
    }

    // Elapsed-time approximation of Combatant.isInvincible (battle-cry and
    // fluid-state branches) — NetFighter has no synced countdown to check
    // exactly (same imprecision already accepted for COMBO_ATTACK/
    // EMPOWERED_STRIKE's active-window poses above), close enough for a
    // visual tint.
    const invincible =
      (state === STATES.BATTLE_CRY && this._sinceStateMs < this._skills.battleCry.DURATION_MS) ||
      (state === STATES.FLUID && this._sinceStateMs < this._skills.fluidState.DURATION_MS);

    return { grip, tip, footL, footR, headX, weaponStyle, shield, invincible };
  }

  _drawFigure(state, pose) {
    const g = this.figure;
    g.clear();

    const r = PLAYER.RADIUS;
    const { grip, tip, footL, footR, headX, weaponStyle, shield, invincible } = pose;
    const hip = { x: -r * 0.2, y: 0 };
    const neck = { x: r * 0.05, y: 0 };
    const armored = weaponStyle === "hammer";
    const isAxes = weaponStyle === "axes";
    const isStaff = weaponStyle === "staff";
    // Knight reads heavier/metallic; Warrior reads leather-tan; Mage reads
    // robe-purple.
    const limbColor = armored ? 0xb0b6c2 : isAxes ? 0xd9c9a3 : isStaff ? 0xb39ddb : 0xe8e8f0;
    const limbWidth = armored ? 5 : isAxes ? 4.5 : isStaff ? 4.5 : 4;

    g.setRotation(state === STATES.STUNNED ? Math.sin(this._clock * 0.02) * 0.12 : 0);

    g.lineStyle(limbWidth, limbColor, 0.95);
    g.beginPath();
    g.moveTo(hip.x, hip.y);
    g.lineTo(footL.x, footL.y);
    g.moveTo(hip.x, hip.y);
    g.lineTo(footR.x, footR.y);
    g.moveTo(neck.x, neck.y);
    g.lineTo(hip.x, hip.y);
    g.strokePath();

    g.lineStyle(armored ? 4.5 : isAxes ? 4.5 : 3.5, limbColor, 0.95);
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
      // Wooden haft (grip -> tip), metal head drawn separately below at tip
      // — two-tone reads as a hammer, not a uniform blade.
      g.lineStyle(4, 0x6b4a2b, 1);
      g.beginPath();
      g.moveTo(grip.x, grip.y);
      g.lineTo(tip.x, tip.y);
      g.strokePath();
      g.fillStyle(0x4a3320, 0.9);
      g.fillCircle(grip.x, grip.y, 2.8);
    } else if (isAxes) {
      // Short dark leather-wrapped handle — the axe head is drawn
      // separately at the tip end below.
      g.lineStyle(3, 0x4a3320, 1);
      g.beginPath();
      g.moveTo(grip.x, grip.y);
      g.lineTo(tip.x, tip.y);
      g.strokePath();
      g.fillStyle(0x2c2018, 0.9);
      g.fillCircle(grip.x, grip.y, 2.4);
    } else if (isStaff) {
      // Dark wooden shaft — the glowing orb is drawn separately at the tip
      // below.
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
      const empowered = this._empoweredQActive || state === STATES.EMPOWERED_STRIKE;
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
      // primary hand and a mirrored off-hand axe.
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
      // Glowing orb at the staff tip — pulses faster/brighter while
      // actively charging or firing the laser, dim idle otherwise.
      const active = state === STATES.LASER_CHARGE || state === STATES.LASER_FIRE;
      const glow = active ? 0.7 + 0.3 * Math.sin(this._clock * 0.06) : 0.55 + 0.15 * Math.sin(this._clock * 0.015);
      g.fillStyle(0xd9bfff, glow);
      g.fillCircle(tip.x, tip.y, active ? 6 : 4.5);
      g.lineStyle(1.5, 0xf3e8ff, 0.8);
      g.strokeCircle(tip.x, tip.y, active ? 6 : 4.5);
    }

    // Head shape is a per-class visual pick (this._skills.visual.headShape)
    // — square reads as a helmet, distinct from the swordsman's bare head.
    const headShape = this._skills.visual?.headShape || "circle";
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
      // tall triangle rising off-center, reading as a cone hat rather than
      // a bare head.
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
    if (invincible) {
      // Invincibility tint — a pulsing overlay on the head, shown only
      // during the actual invincible phase. Color reads per-class: red for
      // Warrior's battle cry, violet for Mage's fluid state.
      const flash = 0.35 + 0.25 * Math.sin(this._clock * 0.05);
      const tintColor = state === STATES.FLUID ? 0xb98cff : 0xff4040;
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
      // as active blocking.
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

  // Shared "soft glow" fill+stroke for range/shape skill indicators — hand
  // kept in sync with Combatant.js's identically-named helpers (see
  // src/CLAUDE.md's "no shared base class" rule). Fakes a radial-gradient
  // falloff (Phaser's Graphics object has no native gradient fill) by
  // layering a dim full-size shape under a brighter ~60-65%-size core, plus
  // a two-pass stroke (wide/faint outer glow + a slim/crisp inner edge)
  // instead of one flat fill + one flat line. `fillAlpha`/`strokeAlpha` are
  // independent, matching how every original call site already balanced a
  // dim fill against a much stronger edge stroke.
  _fillGlowCone(startAngle, endAngle, range, fillColor, edgeColor, fillAlpha, strokeAlpha) {
    this.kickCone.fillStyle(fillColor, fillAlpha * 0.6);
    this.kickCone.slice(0, 0, range, startAngle, endAngle, false);
    this.kickCone.fillPath();
    this.kickCone.fillStyle(fillColor, fillAlpha);
    this.kickCone.slice(0, 0, range * 0.62, startAngle, endAngle, false);
    this.kickCone.fillPath();
    this.kickCone.lineStyle(7, edgeColor, strokeAlpha * 0.3);
    this.kickCone.beginPath();
    this.kickCone.arc(0, 0, range, startAngle, endAngle, false);
    this.kickCone.strokePath();
    this.kickCone.lineStyle(2.5, edgeColor, strokeAlpha);
    this.kickCone.beginPath();
    this.kickCone.arc(0, 0, range, startAngle, endAngle, false);
    this.kickCone.strokePath();
  }

  _fillGlowRect(length, halfW, fillColor, edgeColor, fillAlpha, strokeAlpha) {
    this.kickCone.fillStyle(fillColor, fillAlpha * 0.6);
    this.kickCone.fillRect(0, -halfW, length, halfW * 2);
    const inset = halfW * 0.35;
    this.kickCone.fillStyle(fillColor, fillAlpha);
    this.kickCone.fillRect(0, -halfW + inset, length, (halfW - inset) * 2);
    this.kickCone.lineStyle(6, edgeColor, strokeAlpha * 0.3);
    this.kickCone.strokeRect(0, -halfW, length, halfW * 2);
    this.kickCone.lineStyle(2.5, edgeColor, strokeAlpha);
    this.kickCone.strokeRect(0, -halfW, length, halfW * 2);
  }

  _fillGlowCircle(cx, cy, radius, fillColor, edgeColor, fillAlpha, strokeAlpha) {
    this.kickCone.fillStyle(fillColor, fillAlpha * 0.6);
    this.kickCone.fillCircle(cx, cy, radius);
    this.kickCone.fillStyle(fillColor, fillAlpha);
    this.kickCone.fillCircle(cx, cy, radius * 0.65);
    this.kickCone.lineStyle(6, edgeColor, strokeAlpha * 0.3);
    this.kickCone.strokeCircle(cx, cy, radius);
    this.kickCone.lineStyle(2.5, edgeColor, strokeAlpha);
    this.kickCone.strokeCircle(cx, cy, radius);
  }

  _drawKickCone(state, chargeTime, fastChargeActive) {
    this.kickCone.clear();
    if (state === STATES.EMPOWERED_STRIKE) {
      this._drawEmpoweredStrikeRect();
      return;
    }
    if (state === STATES.AXE_SWING) {
      this._drawAxeSwingRing();
      return;
    }
    if (state === STATES.BATTLE_CRY) {
      this._drawBattleCryTelegraph();
      return;
    }
    if (state === STATES.SLAM_CHARGE) {
      this._drawSlamPreview(chargeTime);
      return;
    }
    if (state === STATES.SLAM_IMPACT) {
      this._drawSlamImpactRing(chargeTime);
      return;
    }
    if (state === STATES.LASER_CHARGE || state === STATES.LASER_FIRE) {
      this._drawLaserPreview(state, chargeTime, fastChargeActive);
      return;
    }
    let cfg;
    let fillColor = 0xfff3b0;
    let edgeColor = 0xffcc33;
    if (state === STATES.KICKING) {
      cfg = this._skills.eKick;
    } else if (state === STATES.COMBO_ATTACK) {
      cfg = this._skills.comboAttack;
      fillColor = 0xffe8c2;
      edgeColor = 0xd98c3a;
    } else if (state === STATES.BLIZZARD) {
      // Same cone-sweep shape as the melee cones above (RANGE/
      // HALF_ANGLE_DEG line up), just icy-colored instead of a strike swipe.
      cfg = this._skills.blizzard;
      fillColor = 0xdff6ff;
      edgeColor = 0x7fd0ff;
    } else {
      return;
    }

    const halfAngle = Phaser.Math.DegToRad(cfg.HALF_ANGLE_DEG);
    const elapsed = this._sinceStateMs;

    if (elapsed <= cfg.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      const sweepEnd = Phaser.Math.Linear(-halfAngle, halfAngle, t);
      this._fillGlowCone(-halfAngle, sweepEnd, cfg.RANGE, fillColor, edgeColor, 0.75, 0.9);
    } else {
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(edgeColor, 0.35 * (1 - t));
      this.kickCone.slice(0, 0, cfg.RANGE, -halfAngle, halfAngle, false);
      this.kickCone.fillPath();
    }
  }

  // Knight empowered Q's wide straight-line AOE, drawn in local rotated
  // space (0,0 = character, +x = facing) — mirrors Combatant.js's
  // _drawEmpoweredStrikeRect.
  _drawEmpoweredStrikeRect() {
    const cfg = this._skills.empoweredStrike;
    const halfW = cfg.WIDTH / 2;
    const elapsed = this._sinceStateMs;

    if (elapsed <= cfg.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      this._fillGlowRect(cfg.LENGTH, halfW, 0xffe066, 0xfff3b0, 0.6 * (1 - t * 0.3), 0.9);
    } else {
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(0xffe066, 0.35 * (1 - t));
      this.kickCone.fillRect(0, -halfW, cfg.LENGTH, cfg.WIDTH);
    }
  }

  // Mage Q's projected beam — a thin preview rectangle that grows in length
  // and width live with the (fastCharge-aware) charge ratio while charging,
  // then the actual full-brightness beam rectangle once fired (same fade
  // shape as _drawEmpoweredStrikeRect). Both length/width are derived from
  // chargeTime alone — the server never resets it through the fire window,
  // same trick as Warrior's slam radius — so no extra state is needed here.
  _drawLaserPreview(state, chargeTime, fastChargeActive) {
    const laser = this._skills.laserBeam;
    if (state === STATES.LASER_CHARGE) {
      const minChargeMs =
        fastChargeActive && this._skills.fastCharge ? this._skills.fastCharge.CHARGE_MS : laser.MIN_CHARGE_MS;
      if (chargeTime < minChargeMs) return; // not "complete" yet — nothing to preview
      const ratio = Phaser.Math.Clamp((chargeTime - minChargeMs) / (laser.MAX_CHARGE_MS - minChargeMs), 0, 1);
      const length = Phaser.Math.Linear(laser.MIN_LENGTH, laser.MAX_LENGTH, ratio);
      const halfW = Phaser.Math.Linear(laser.MIN_WIDTH, laser.MAX_WIDTH, ratio) / 2;
      const pulse = 0.35 + 0.15 * Math.sin(this._clock * 0.03);
      this._fillGlowRect(length, halfW, 0xb98cff, 0xd9bfff, 0.22 * pulse, 0.7);
      return;
    }
    // LASER_FIRE: uses the plain (non-fastCharge) floor, since by the time
    // this state is observed the buff has already been consumed and
    // `fastChargeActive` correctly reads false — there's no way to know in
    // retrospect which threshold a given release actually used. This only
    // under-scales the preview in the rare case a fastCharge-boosted shot
    // was held well past its (much lower) threshold; the server's own hit-
    // test is unaffected either way, this is a rendering-only approximation.
    const minChargeMs = laser.MIN_CHARGE_MS;
    const ratio = Phaser.Math.Clamp((chargeTime - minChargeMs) / (laser.MAX_CHARGE_MS - minChargeMs), 0, 1);
    const length = Phaser.Math.Linear(laser.MIN_LENGTH, laser.MAX_LENGTH, ratio);
    const halfW = Phaser.Math.Linear(laser.MIN_WIDTH, laser.MAX_WIDTH, ratio) / 2;
    const elapsed = this._sinceStateMs;
    if (elapsed <= laser.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / laser.ACTIVE_MS, 0, 1);
      this._fillGlowRect(length, halfW, 0xd9bfff, 0xf3e8ff, 0.75 * (1 - t * 0.3), 0.95);
    } else {
      const t = Phaser.Math.Clamp((elapsed - laser.ACTIVE_MS) / (laser.TOTAL_MS - laser.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(0xd9bfff, 0.35 * (1 - t));
      this.kickCone.fillRect(0, -halfW, length, halfW * 2);
    }
  }

  // Warrior Q's 360-degree hit radius, drawn as a plain circle around self
  // (no facing dependency) so its "everywhere around me" shape reads at a
  // glance.
  _drawAxeSwingRing() {
    const cfg = this._skills.axeSwing;
    const elapsed = this._sinceStateMs;
    if (elapsed <= cfg.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      this._fillGlowCircle(0, 0, cfg.RADIUS, 0xd9c9a3, 0xd9c9a3, 0.22 * (1 - t * 0.4), 0.9);
    } else {
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(0xd9c9a3, 0.12 * (1 - t));
      this.kickCone.fillCircle(0, 0, cfg.RADIUS);
    }
  }

  // Warrior W's AOE shout radius, telegraphed for the entire windup — the
  // ring brightens as the burst approaches, then flashes and fades once the
  // AOE actually fires.
  _drawBattleCryTelegraph() {
    const cfg = this._skills.battleCry;
    const elapsed = this._sinceStateMs;
    const burstStart = cfg.TOTAL_MS - cfg.ACTIVE_MS;
    if (elapsed <= burstStart) {
      const ratio = Phaser.Math.Clamp(elapsed / burstStart, 0, 1);
      const pulse = 0.3 + 0.4 * ratio + 0.15 * Math.sin(this._clock * 0.03);
      this.kickCone.lineStyle(2, 0x8a8f99, pulse);
      this.kickCone.strokeCircle(0, 0, cfg.SHOUT_RADIUS);
    } else {
      const t = Phaser.Math.Clamp((elapsed - burstStart) / cfg.ACTIVE_MS, 0, 1);
      this._fillGlowCircle(0, 0, cfg.SHOUT_RADIUS, 0x8a8f99, 0xffffff, 0.4 * (1 - t), 0.9 * (1 - t));
    }
  }

  // Warrior E's projected landing spot during the charge — a line out to
  // the leap distance plus a circle at the impact radius, both scaling live
  // with the real synced chargeTime ratio. No SLAMMING-specific preview is
  // drawn (no synced "remaining distance" to draw it from for a remote
  // player) — the tucked-leap pose alone reads as motion during that state.
  _drawSlamPreview(chargeTime) {
    const slam = this._skills.divingSlam;
    const ratio = chargeTime / slam.MAX_CHARGE_MS;
    const leapDistance = Phaser.Math.Linear(slam.MIN_LEAP_DISTANCE, slam.MAX_LEAP_DISTANCE, ratio);
    const impactRadius = Phaser.Math.Linear(slam.MIN_IMPACT_RADIUS, slam.MAX_IMPACT_RADIUS, ratio);
    this.kickCone.lineStyle(2, 0xc97b3a, 0.55);
    this.kickCone.beginPath();
    this.kickCone.moveTo(0, 0);
    this.kickCone.lineTo(leapDistance, 0);
    this.kickCone.strokePath();
    // Same "breathing" pulse as _drawLaserPreview's charge phase and
    // _drawBattleCryTelegraph's windup.
    const pulse = 0.06 * Math.sin(this._clock * 0.03);
    this._fillGlowCircle(leapDistance, 0, impactRadius, 0xc97b3a, 0xc97b3a, 0.18 + pulse, 0.85 + pulse);
  }

  // Warrior E's actual impact radius at the landing spot — chargeTime is
  // still valid here (the server never resets it through the slam
  // sequence), so this derives the same radius the server used at release.
  _drawSlamImpactRing(chargeTime) {
    const cfg = this._skills.divingSlam;
    const ratio = chargeTime / cfg.MAX_CHARGE_MS;
    const radius = Phaser.Math.Linear(cfg.MIN_IMPACT_RADIUS, cfg.MAX_IMPACT_RADIUS, ratio);
    const elapsed = this._sinceStateMs;
    if (elapsed <= cfg.ACTIVE_MS) {
      const t = Phaser.Math.Clamp(elapsed / cfg.ACTIVE_MS, 0, 1);
      this._fillGlowCircle(0, 0, radius, 0xc97b3a, 0xc97b3a, 0.35 * (1 - t * 0.4), 0.9);
    } else {
      const t = Phaser.Math.Clamp((elapsed - cfg.ACTIVE_MS) / (cfg.TOTAL_MS - cfg.ACTIVE_MS), 0, 1);
      this.kickCone.fillStyle(0xc97b3a, 0.18 * (1 - t));
      this.kickCone.fillCircle(0, 0, radius);
    }
  }

  _drawAuraRing(state, chargeTime, stunTimer, pose, empoweredQActive, skillsDisabled, fastChargeActive, slowed) {
    this.auraRing.clear();
    const r = PLAYER.RADIUS;

    if (state === STATES.CHARGING) {
      const ratio = chargeTime / this._skills.qDash.MAX_CHARGE_MS;
      const pulse = 1 + 0.08 * Math.sin(this._clock * 0.02);
      this.auraRing.lineStyle(4, 0xff9f43, 0.9);
      this.auraRing.beginPath();
      this.auraRing.arc(0, 0, (r + 7) * pulse, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2, false);
      this.auraRing.strokePath();
    } else if (state === STATES.PARRYING) {
      const pulse = r + 10 + 4 * Math.sin(this._clock * 0.03);
      this.auraRing.lineStyle(3, 0x7ff0ff, 0.85);
      this.auraRing.strokeCircle(0, 0, pulse);
      this.auraRing.fillStyle(0x7ff0ff, 0.12);
      this.auraRing.fillCircle(0, 0, pulse);
    } else if (state === STATES.STUNNED) {
      const pulse = r + 6 + 2 * Math.sin(this._clock * 0.015);
      this.auraRing.lineStyle(3, 0xff5c5c, 0.7 + 0.3 * Math.sin(this._clock * 0.02));
      this.auraRing.strokeCircle(0, 0, pulse);
    } else if (state === STATES.FLUID) {
      // Two-phase read: violet/translucent while actually invincible, then
      // a brighter cyan-white ring once the haste phase kicks in — reuses
      // pose.invincible (same elapsed-time approximation _computePose
      // already made) instead of recomputing it.
      const pulse = r + 9 + 4 * Math.sin(this._clock * 0.03);
      if (pose?.invincible) {
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
    // any one state), same always-checked pattern as Combatant.js's — a
    // small pulsing glow at the weapon tip telegraphing "ready to use."
    if (empoweredQActive) {
      const tip = pose?.tip || { x: 0, y: 0 };
      this.auraRing.fillStyle(0xffe066, 0.55 * (0.5 + 0.5 * Math.sin(this._clock * 0.05)));
      this.auraRing.fillCircle(tip.x, tip.y, r * 0.28);
    }

    // Warrior battle-cry debuff: shown on whoever's *affected*, regardless
    // of their own current state — a dull grey pulsing ring, same
    // always-checked pattern as the empowered-Q glow above.
    if (skillsDisabled) {
      const pulse = r + 8 + 3 * Math.sin(this._clock * 0.025);
      this.auraRing.lineStyle(3, 0x8a8f99, 0.6 + 0.25 * Math.sin(this._clock * 0.02));
      this.auraRing.strokeCircle(0, 0, pulse);
    }

    // Mage fast-charge buff (granted by a W block or E freeze): same
    // "use it or lose it" glow shape as the empowered-Q one above, at the
    // staff tip instead of the weapon tip.
    if (fastChargeActive) {
      const tip = pose?.tip || { x: 0, y: 0 };
      this.auraRing.fillStyle(0xd9bfff, 0.55 * (0.5 + 0.5 * Math.sin(this._clock * 0.05)));
      this.auraRing.fillCircle(tip.x, tip.y, r * 0.28);
    }

    // Mage blizzard slow: shown on whoever's *affected*, regardless of
    // their own class/state — a pale icy pulsing ring, same always-checked
    // pattern as the two debuff glows above.
    if (slowed) {
      const pulse = r + 7 + 3 * Math.sin(this._clock * 0.02);
      this.auraRing.lineStyle(3, 0x7fd0ff, 0.55 + 0.25 * Math.sin(this._clock * 0.03));
      this.auraRing.strokeCircle(0, 0, pulse);
    }
  }
}
