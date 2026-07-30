import { PLAYER, Q_DASH, E_KICK, STATES } from "../config/constants.js";
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
    this.stateLabel = scene.add
      .text(0, -PLAYER.RADIUS - 16, STATES.IDLE, { font: "11px monospace", color: "#ffffff" })
      .setOrigin(0.5, 1);
    this.container.add([this.kickCone, this.auraRing, this.figure, this.nicknameLabel, this.stateLabel]);

    this._clock = 0;
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
    // Counter-rotate the text labels so they stay upright/readable instead
    // of spinning with the container's facing angle.
    this.nicknameLabel.setRotation(-this._renderAngle);
    this.stateLabel.setRotation(-this._renderAngle);
    this.shadow.setPosition(this._renderX, this._renderY + PLAYER.RADIUS * 0.8);
    this.shadow.setAlpha(isAlive ? 1 : 0);
    this.container.setAlpha(isAlive ? 1 : 0);
    this.stateLabel.setText(
      state === STATES.CHARGING ? `${state} ${(chargeTime / 1000).toFixed(2)}s` : state
    );

    if (!isAlive) {
      this.figure.clear();
      this.kickCone.clear();
      this.auraRing.clear();
      return;
    }

    if (state === STATES.CHARGING && chargeTime >= Q_DASH.MAX_CHARGE_MS) {
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

    this._drawFigure(state, chargeTime, moving);
    this._drawKickCone(state);
    this._drawAuraRing(state, chargeTime, stunTimer);
  }

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

  _computePose(state, chargeTime, moving) {
    const r = PLAYER.RADIUS;
    const lerp = Phaser.Math.Linear;
    let grip = { x: -r * 0.05, y: r * 0.25 };
    let tip = { x: r * 0.15, y: r * 0.65 };
    let footL = { x: -r * 0.3, y: -r * 0.3 };
    let footR = { x: -r * 0.3, y: r * 0.3 };
    let headX = r * 0.25;

    switch (state) {
      case STATES.CHARGING: {
        const ratio = chargeTime / Q_DASH.MAX_CHARGE_MS;
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
        const elapsed = this._sinceStateMs;
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
        if (moving) {
          const swing = Math.sin(this._clock * 0.014) * r * 0.42;
          footL = { x: -r * 0.3 + swing, y: -r * 0.3 };
          footR = { x: -r * 0.3 - swing, y: r * 0.3 };
        }
        break;
    }

    return { grip, tip, footL, footR, headX };
  }

  _drawFigure(state, chargeTime, moving) {
    const g = this.figure;
    g.clear();

    const r = PLAYER.RADIUS;
    const { grip, tip, footL, footR, headX } = this._computePose(state, chargeTime, moving);
    const hip = { x: -r * 0.2, y: 0 };
    const neck = { x: r * 0.05, y: 0 };

    g.setRotation(state === STATES.STUNNED ? Math.sin(this._clock * 0.02) * 0.12 : 0);

    g.lineStyle(4, 0xe8e8f0, 0.95);
    g.beginPath();
    g.moveTo(hip.x, hip.y);
    g.lineTo(footL.x, footL.y);
    g.moveTo(hip.x, hip.y);
    g.lineTo(footR.x, footR.y);
    g.moveTo(neck.x, neck.y);
    g.lineTo(hip.x, hip.y);
    g.strokePath();

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

  _drawKickCone(state) {
    this.kickCone.clear();
    if (state !== STATES.KICKING) return;

    const halfAngle = Phaser.Math.DegToRad(E_KICK.HALF_ANGLE_DEG);
    const elapsed = this._sinceStateMs;

    if (elapsed <= E_KICK.ACTIVE_MS) {
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

  _drawAuraRing(state, chargeTime, stunTimer) {
    this.auraRing.clear();
    const r = PLAYER.RADIUS;

    if (state === STATES.CHARGING) {
      const ratio = chargeTime / Q_DASH.MAX_CHARGE_MS;
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
    }
  }
}
