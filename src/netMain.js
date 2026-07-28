import { VIEWPORT } from "./config/constants.js";
import NetArenaScene from "./scenes/NetArenaScene.js";

new Phaser.Game({
  type: Phaser.AUTO,
  width: VIEWPORT.WIDTH,
  height: VIEWPORT.HEIGHT,
  parent: "game-root",
  backgroundColor: "#0d0b08",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [NetArenaScene],
});
