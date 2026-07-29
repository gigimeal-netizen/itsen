import { VIEWPORT } from "./config/constants.js";
import NetArenaScene from "./scenes/NetArenaScene.js";

new Phaser.Game({
  type: Phaser.AUTO,
  width: VIEWPORT.WIDTH,
  height: VIEWPORT.HEIGHT,
  parent: "game-root",
  backgroundColor: "#0d0b08",
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
  scene: [NetArenaScene],
});
