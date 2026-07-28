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
  constructor(scene, color) {
    this.scene = scene;
    this.color = color;

    this.container = scene.add.container(0, 0);
    this.shadow = scene.add.ellipse(0, 0, PLAYER.RADIUS * 1.6, PLAYER.RADIUS * 0.7, 0x000000, 0.32).setDepth(-0.5);
    this.kickCone = scene.add.graphics();
    this.auraRing = scene.add.graphics();
    this.figure = scene.add.graphics();
    this.stateLabel = scene.add
      .text(0, -PLAYER.RADIUS - 16, STATES.IDLE, { font: "11px monospace", color: "#ffffff" })
      .setOrigin(0.5, 1);
    this.container.add([this.kickCone, this.auraRing, this.figure, this.stateLabel]);

    this._clock = 0;
    this._prevState = null;
    this._sinceStateMs = 0;
    this._lastX = 0;
    this._lastY = 0;

    // Render-side position/angle smoothing: the server only updates the
    // schema at ~30Hz (SIMULATION_INTERVAL_MS), but we render at whatever
    // the display refreshes at, so snapping straight to each new snapshot
    // looks stepped next to single-player's every-frame Arcade physics.
    // These ease toward the latest snapshot instead of jumping to it.
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

    this.container.setPosition(this._renderX, this._renderY);
    this.container.setRotation(this._renderAngle);
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
