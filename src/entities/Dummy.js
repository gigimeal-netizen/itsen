import Combatant from "./Combatant.js";
import { STATES } from "../config/constants.js";

// Scripted training target: stands still, periodically flashes a W parry
// stance so a solo player can rehearse Q-vs-W and E-vs-W without a second
// human. Respawn timing/position itself is handled by Combatant's shared
// auto-respawn (see kill()/dieFromHazard()/respawn()); this only adds the
// parry-clock reset on top.
const PARRY_INTERVAL_MS = 2200;

export default class Dummy extends Combatant {
  constructor(scene, x, y) {
    super(scene, x, y, 0xff5c5c);
    this._parryClock = PARRY_INTERVAL_MS;
  }

  update(dtMs) {
    if (this.isAlive) {
      this.wantsMove = false;
      this.aimAngle = this.facing;
      this.qHeld = false;
      this.ePressed = false;
      this.wPressed = false;

      if (this.state === STATES.IDLE || this.state === STATES.GCD) {
        this._parryClock -= dtMs;
        if (this._parryClock <= 0) {
          this._parryClock = PARRY_INTERVAL_MS;
          this.wPressed = true;
        }
      }
    }

    super.update(dtMs);
  }

  respawn() {
    super.respawn();
    this._parryClock = PARRY_INTERVAL_MS;
  }
}
