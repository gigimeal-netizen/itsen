# CLAUDE.md — server/

Colyseus authoritative server for Phase 2 multiplayer (`../net.html`). Separate CommonJS npm project —
**not** part of the client's ES module graph in `../src/`; don't `import`/`require` across that boundary.

## Running it

```
npm install   # first time only
npm start     # node index.js — listens on ws://localhost:2567 (or $PORT)
```

## Directory map

- **`index.js`** — Express + Colyseus bootstrap, registers `ArenaRoom`.
- **`rooms/ArenaRoom.js`** — the authoritative FSM. It's a server-side port of
  `../src/entities/Combatant.js`'s state machine (states, skill resolution, GCD-skip rules) minus
  Phaser/Arcade physics — **any FSM behavior change in `Combatant.js` must be mirrored here**, and vice
  versa. Also owns hit detection (`checkDashHits`, `checkKicks`), hazard checks (`checkPitDeaths`,
  `checkRingOuts`), and the match/countdown flow (`startCountdown`, `_respawnAllAndCountdown`).
- **`schema/ArenaRoomState.js`** — the `@colyseus/schema` state synced to clients (flat per-player
  schema; see the file's own comment for the current field list, it drifts from spec §6.2's original
  list as features get added — most recently `classId`, see below).
- **`constants.js`** — hand-kept-in-sync copy of `../src/config/constants.js`'s tuning values (CommonJS,
  can't `import` the client's ES module version). Edit both when changing a shared value. Q/W/E tuning
  (`Q_DASH`/`W_PARRY`/`E_KICK`) now lives per-class in a `CLASSES` table, looked up via `classSkills(classId)`
  — today there's only one class ("swordsman"), and the bare `Q_DASH`/`W_PARRY`/`E_KICK` exports just alias
  its entry so most call sites are unaffected; skill-logic code (`ArenaRoom.js`,
  `../src/net/PredictedSelf.js`, `../src/net/NetFighter.js`, `../src/entities/Combatant.js`) reads through
  `classSkills(player.classId)` instead of the bare constants so a second class only needs a new table entry.
- **`layoutGenerator.js`** — hand-kept-in-sync CommonJS twin of `../src/config/layoutGenerator.js`
  (symmetric arena hazard layout).
- **`Dockerfile`** / **`.dockerignore`** / **`.env.example`** — deploy scaffolding; port comes from
  `process.env.PORT` (falls back to 2567).

## Version pin — do not casually bump

`package.json` pins `colyseus@^0.16.5` + `@colyseus/schema@^3.0.76`. The official browser client
`colyseus.js` hasn't published past the `0.16.x` line even though server-side `colyseus`/`@colyseus/core`
are on `0.17.x`+ on npm. `../vendor/colyseus.js` is a **manually vendored** copy of
`node_modules/colyseus.js/dist/colyseus.js` (no client package manager step exists to automate this).
Before bumping past 0.16 here, confirm a matching `colyseus.js` release exists and re-copy the vendor
bundle, or the wire protocol may silently break.

## Working here

- `node_modules/` is local-only (gitignored) — always `npm install` after a fresh clone.
- No lint/test setup — verify by running this alongside the static client server and playing a match
  across two browser tabs (see root `../CLAUDE.md`).
