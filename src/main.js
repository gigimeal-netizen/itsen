import { VIEWPORT } from "./config/constants.js";
import ArenaScene from "./scenes/ArenaScene.js";

new Phaser.Game({
  type: Phaser.AUTO,
  width: VIEWPORT.WIDTH,
  height: VIEWPORT.HEIGHT,
  parent: "game-root",
  backgroundColor: "#000000",
  scale: {
    mode: Phaser.Scale.FIT,
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
