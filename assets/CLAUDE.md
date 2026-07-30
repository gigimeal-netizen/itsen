# CLAUDE.md — assets/

Static game assets, loaded via Phaser's `preload()` in the scene files — not referenced from HTML.

## Directory map

- **`audio/`** — sound effect clips (`.mp3`/`.wav`) played through `../src/audio/Sfx.js`. `sound.txt` is
  the developer's Korean design notes on what each cue should sound/feel like (mood, search keywords) —
  keep it as the reference when sourcing or replacing a clip; it's documentation, not code.
- **`images/`** — arena sprite tiles (`arena_tile.png` floor, `arena_void.png` ring-out void,
  `arena_obs.png` obstacle pillar) used by `ArenaScene`/`NetArenaScene` for terrain and obstacle
  rendering.

## Adding a new asset

Register it in `preload()` with a Phaser load key:

```js
this.load.audio("myClip", "assets/audio/myClip.mp3");
this.load.image("myImage", "assets/images/myImage.png");
```

Both `../src/scenes/ArenaScene.js` (single-player) and `../src/scenes/NetArenaScene.js` (multiplayer)
have their own `preload()` — add the load call to both if the asset should work in both modes (this is
why several clips/images are currently listed in each file).
