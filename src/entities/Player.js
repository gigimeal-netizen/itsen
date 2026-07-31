import Combatant from "./Combatant.js";
import TouchControls from "../input/TouchControls.js";

// Human-controlled combatant. Input mapping follows game_design_spec.md 2.1:
// PC — left-click hold = move toward cursor, Q = hold&release dash, W/E = tap.
// Mobile — left-side drag joystick sets both move direction and facing,
// right-side Q hold&release + W/E tap buttons. Both input paths run
// concurrently; whichever the player is actually using wins each frame.
export default class Player extends Combatant {
  constructor(scene, x, y, classId) {
    super(scene, x, y, 0x4da3ff, classId);
    this.keys = scene.input.keyboard.addKeys({
      q: Phaser.Input.Keyboard.KeyCodes.Q,
      w: Phaser.Input.Keyboard.KeyCodes.W,
      e: Phaser.Input.Keyboard.KeyCodes.E,
    });
    this.pointerDown = false;
    scene.input.on("pointerdown", (p) => {
      if (p.leftButtonDown()) this.pointerDown = true;
    });
    scene.input.on("pointerup", (p) => {
      if (!p.leftButtonDown()) this.pointerDown = false;
    });

    this.touch = new TouchControls();
  }

  update(dtMs) {
    if (this.touch.joystick.active) {
      this.aimAngle = this.touch.joystick.angle;
      this.wantsMove = this.touch.joystick.magnitude > 0.15; // deadzone
    } else {
      const pointer = this.scene.input.activePointer;
      this.aimAngle = Phaser.Math.Angle.Between(this.x, this.y, pointer.worldX, pointer.worldY);
      this.wantsMove = this.pointerDown;
    }

    const keyQ = Phaser.Input.Keyboard.JustDown(this.keys.q);
    const keyW = Phaser.Input.Keyboard.JustDown(this.keys.w);
    const keyE = Phaser.Input.Keyboard.JustDown(this.keys.e);
    const touchQ = this.touch.consumeQTap();
    const touchW = this.touch.consumeWTap();
    const touchE = this.touch.consumeETap();

    this.qHeld = this.keys.q.isDown || this.touch.qHeld;
    this.qPressed = keyQ || touchQ; // tap edge — used by non-charging Q skills (e.g. Knight's comboDash)
    this.wHeld = this.keys.w.isDown || this.touch.wHeld;
    this.wPressed = keyW || touchW;
    this.ePressed = keyE || touchE;

    super.update(dtMs);
  }
}
