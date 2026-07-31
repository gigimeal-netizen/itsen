import Combatant from "./Combatant.js";
import { STATES } from "../config/constants.js";

// Scripted training target: stands still, periodically flashes a W parry
// stance and periodically winds up + dashes at the player (aimed live at
// the player's position) — the dash is what lets W actually be tested
// end-to-end (raise shield, get hit, see the counter/empowered-buff fire),
// not just the shield-raise animation in isolation. Respawn timing/position
// itself is handled by Combatant's shared auto-respawn (see
// kill()/dieFromHazard()/respawn()); this only adds the clock resets on top.
const PARRY_INTERVAL_MS = 2200;
const DASH_INTERVAL_MS = 3600;
const DASH_HOLD_MS = 350; // how long it "charges" before releasing its practice dash

export default class Dummy extends Combatant {
  constructor(scene, x, y) {
    super(scene, x, y, 0xff5c5c);
    this._parryClock = PARRY_INTERVAL_MS;
    this._dashClock = DASH_INTERVAL_MS;
    this._dashHoldMs = 0;
  }

  update(dtMs) {
    if (this.isAlive) {
      this.wantsMove = false;
      this.ePressed = false;
      this.wPressed = false;

      if (this._dashHoldMs > 0) {
        // Mid-charge for a practice dash — keep aiming at the player's
        // current position and hold Q until the timer runs out, then let
        // Combatant's own release-on-!qHeld logic fire it naturally.
        this._dashHoldMs -= dtMs;
        const player = this.scene.player;
        if (player) this.aimAngle = Phaser.Math.Angle.Between(this.x, this.y, player.x, player.y);
        this.qHeld = this._dashHoldMs > 0;
      } else {
        this.qHeld = false;
        this.aimAngle = this.facing;

        if (this.state === STATES.IDLE || this.state === STATES.GCD) {
          this._parryClock -= dtMs;
          this._dashClock -= dtMs;
          if (this._dashClock <= 0) {
            this._dashClock = DASH_INTERVAL_MS;
            this._dashHoldMs = DASH_HOLD_MS;
          } else if (this._parryClock <= 0) {
            this._parryClock = PARRY_INTERVAL_MS;
            this.wPressed = true;
          }
        }
      }
    }

    super.update(dtMs);
  }

  respawn() {
    super.respawn();
    this._parryClock = PARRY_INTERVAL_MS;
    this._dashClock = DASH_INTERVAL_MS;
    this._dashHoldMs = 0;
  }
}
