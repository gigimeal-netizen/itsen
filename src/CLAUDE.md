# CLAUDE.md — src/

Client code for both entry points (`../index.html` Phase 1/3 single-player, `../net.html` Phase 2
multiplayer). Plain ES modules, no bundler — Phaser 3 comes from a CDN `<script>` tag in the HTML files,
not an import here. See the root `../CLAUDE.md` for how to run/serve this.

## Directory map

- **`entities/Combatant.js`** — shared FSM base class (states: `IDLE`, `CHARGING`, `DASH`, `PARRYING`,
  `KICKING`, `STUNNED`, `GCD`, `DEAD`). Both `entities/Player.js` (human input via mouse/keyboard +
  `input/TouchControls.js`) and `entities/Dummy.js` (scripted training target) extend it.
  - `update(dtMs)` has a strict phase order — don't break it when adding new behavior: dash-afterimage
    capture (needs pre-move position) → state `switch` (may set velocity) → knockback motion (may
    override that velocity) → visual redraw (kick cone / aura ring / stick-figure pose, needs the final
    post-knockback position) → `rotation`/shadow sync.
  - Global cooldown is skipped (state goes straight to `IDLE`, not `GCD`) via one-shot flags set by the
    scene's collision code and consumed on completion: `_parrySuccess` (successful W), `_dashKilled`
    via `markDashKill()` (Q landed a kill), `_kickCounteredParry` via `markKickApplied(true)` (E hit a
    parrying target). Follow this mark-then-consume shape for any new "skip GCD" rule.
  - Two death paths: `kill(cutAngle)` (skill kill, spawns split-body + blood VFX) vs `dieFromHazard()`
    (ring-out/pit, no gore). Both share the `respawn()`/`_tickRespawn()` lifecycle on `Combatant` itself.
- **`net/NetFighter.js`** — networked-multiplayer analogue of `Combatant`: renders interpolated
  server-authoritative state instead of running its own FSM. Visual/pose logic should stay in sync with
  `Combatant`'s when they diverge visually.
- **`scenes/ArenaScene.js`** — Phase 1 single-player scene: hazards, ROUND/DEATHMATCH modes, title
  screen, full visual fidelity.
- **`scenes/NetArenaScene.js`** — Phase 2 multiplayer scene: connects to the Colyseus server via
  `../vendor/colyseus.js`, renders `NetFighter` instances from synced room state.
- **`config/constants.js`** — every tuning value (speeds, cooldowns, arena/layout sizing). Mirrored by
  `../server/constants.js` for server-authoritative multiplayer math — **edit both when changing a
  value that matters server-side** (see `../server/CLAUDE.md`).
- **`config/layoutGenerator.js`** — point-symmetric arena hazard layout generator. Mirrored by
  `../server/layoutGenerator.js` (CommonJS twin) — same edit-both rule.
- **`audio/Sfx.js`** — sound-effect playback wrapper around Phaser's sound manager; clips are loaded by
  the scenes' `preload()` from `../assets/audio/` (see `../assets/CLAUDE.md`).
- **`input/TouchControls.js`** — mobile joystick + skill-button input; merges with mouse/keyboard in
  `Player.js` (whichever the player is actually using wins each frame).
- **`main.js`** / **`netMain.js`** — `Phaser.Game` bootstrap for `index.html` / `net.html` respectively.

## Working here

- If a change affects both single- and multiplayer (a new skill nuance, a new hazard interaction),
  check whether `server/rooms/ArenaRoom.js` needs the equivalent change too — it's a server-side port of
  `Combatant`'s FSM minus Phaser/Arcade physics.
- No lint/test setup — verify by running the static server (root `CLAUDE.md`) and testing in-browser.
