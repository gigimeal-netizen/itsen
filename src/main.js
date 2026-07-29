import { VIEWPORT } from "./config/constants.js";
import ArenaScene from "./scenes/ArenaScene.js";

new Phaser.Game({
  type: Phaser.AUTO,
  width: VIEWPORT.WIDTH,
  height: VIEWPORT.HEIGHT,
  parent: "game-root",
  backgroundColor: "#000000",
  scale: {
    // ENVELOP crops to fill the screen edge-to-edge instead of FIT's
    // letterbox bars — VIEWPORT's 3:2 aspect never matches a phone's
    // screen exactly, so FIT left visible black bars on the sides.
    mode: Phaser.Scale.ENVELOP,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  input: {
    activePointers: 3, // multi-touch: joystick + a skill button at once
  },
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
    },
  },
  scene: [ArenaScene],
});
