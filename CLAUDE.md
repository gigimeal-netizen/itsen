# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Phase 1 (single-player) and a Phase 2 multiplayer MVP are implemented. No bundler/package manager is used on the client — Phaser 3 is loaded via CDN and the client is plain ES modules served as static files. There is no lint/test setup yet.

### Running it

- **Client static server** (serves both `index.html` and `net.html`): `python nocache_server.py` from the repo root — a custom no-cache static file server on port 8731 (plain `python -m http.server` was dropped; see git history/CLAUDE memory for why). Open `http://localhost:8731/index.html`.
- **Phase 1 (single-player)**: `index.html` — no server process beyond the static file server above. Title screen → 3-2-1 countdown → ROUND or DEATHMATCH mode vs. a training dummy, full hazard/round/effects feature set.
- **Phase 2 (multiplayer MVP)**: `net.html` — requires the Colyseus server running too:
  ```
  cd server
  npm install   # first time only
  npm start     # node index.js — listens on ws://localhost:2567
  ```
  Then open `http://localhost:8731/net.html` in two separate browser tabs/windows to get matched into the same 2-player room. `net.html` is intentionally a separate, minimal entry point (plain circle + facing line + state-color ring, no stick-figure rendering, no hazards/rounds) — it exists to prove out server-authoritative sync, not to duplicate Phase 1's polish. Server code lives in `server/` (plain CommonJS, not part of the client's ES module graph) — `server/rooms/ArenaRoom.js` is the authoritative FSM (a server-side port of `src/entities/Combatant.js`'s state machine, minus Phaser/Arcade physics), `server/schema/ArenaRoomState.js` defines the synced `@colyseus/schema` state, `server/constants.js` is a hand-kept-in-sync copy of the tuning values in `src/config/constants.js`.
  - **Version pin note**: the official browser client (`colyseus.js`) hasn't published past `0.16.x` even though the `colyseus`/`@colyseus/core` server packages are on `0.17.x`+ on npm. The server's `package.json` deliberately pins `colyseus@^0.16.0` + `@colyseus/schema@^3.0.61` to match what `colyseus.js`'s bundled decoder actually expects — don't bump the server past the 0.16 line without also checking whether a matching `colyseus.js` release exists, or the wire protocol may silently break. The client bundle is vendored at `vendor/colyseus.js` (copied from `server/node_modules/colyseus.js/dist/colyseus.js`) since there's no client-side package manager step.

### Deploying it

Nothing is deployed yet — this just documents what's in place so an actual deploy is a config/hosting choice, not a code change.

- **Server** (`server/`) reads its port from `process.env.PORT` (falls back to 2567 — see `server/index.js`), so it runs as-is on any Node PaaS. `server/Dockerfile` builds a plain `node index.js` container (pin the base image's Node version to whatever `colyseus@0.16` supports — see the version-pin note above before bumping it). `server/.env.example` documents the one env var that matters.
- **Client** (`index.html`, `net.html`, `src/`, `vendor/`, assets) is static — any static host works, `nocache_server.py` is purely a local-dev convenience, not something a real deploy needs.
- Since the client and server will usually end up on different hosts/ports in a real deploy, `net.html` sets `window.ARENA_SERVER_URL` (null by default = same-host `:2567`, matching local dev) right before loading `src/netMain.js` — point it at the deployed Colyseus server's `ws://`/`wss://` URL instead of editing `src/scenes/NetArenaScene.js`.
- No `.gitignore` existed before this repo was set up for deployment prep; one now excludes `node_modules/`, `.env`, and OS junk files.

## What this project is

A 4–6 player multiplayer top-down real-time action arena game for web/mobile browsers (FFA, 2v2, 3v3, 1v1). One hit from the "Q" skill kills; last player/team standing wins. Full spec: `game_design_spec.md`.

## Recommended stack (per spec §7)

- **Client:** Phaser 3 or PixiJS (2D canvas)
- **Server:** Node.js + Colyseus (or Socket.io)
- **Collision:** Server-authoritative sweep test / circle collision

## Core mechanics that drive the architecture

The entire game is built around a strict, server-authoritative **finite state machine** per player with states: `IDLE`, `CHARGING`, `DASH`, `PARRYING`, `KICKING`, `STUNNED`, `DEAD`. Any implementation (client prediction, server reconciliation, hit detection) must respect the state transition table in spec §4 — most notably:

- Only `IDLE`/`MOVE` accepts new skill input; every other state ignores or overrides input in specific ways.
- `STUNNED` completely locks movement and rotation for 2 seconds.
- A global cooldown (0.75s) applies after any skill use, **except** a successful `W` parry, which grants immediate cooldown exemption.

### The three skills (rock-paper-scissors triangle, spec §3)

- **Q (발도술 / Iaido dash):** Hold to charge (movement −95% while charging, range scales with hold time) → release to dash in facing direction. Pierces players, instakills on hit, stops immediately on wall/obstacle collision. Colliding with a `PARRYING` player stuns the Q user for 2s.
- **W (반격자세 / Parry stance):** Tap for 0.5s of 360° invincibility; if a dashing (`Q`) attacker touches the player during this window, the attacker is stunned 2s and the parrier skips the global cooldown. Does not counter `E`.
- **E (발차기 / Kick):** Tap for a 30°-arc, 100px-range melee attack; stuns target 2s and knocks back in the player's facing direction. Beats `W` (parry has no answer to kick) and loses to `Q` (too short-ranged to catch a dash).

This Q > E > W > Q triangle (spec diagram, §3) is the balance core — any new skill, arena hazard, or netcode change should be checked against it before implementation.

### Networking model (spec §6.2)

Player state is a flat schema synced server → client: `{ id, x, y, angle, state, chargeTime, stunTimer, globalCooldown, isAlive }`. The server is authoritative for state transitions and hit detection; clients render/interpolate from this schema.

### Arena hazards (spec §5.2)

Ring-out (fall to death off-arena), periodic pitfalls, slow zones, and obstacles/pillars that block `Q` dashes — each is designed to interact with specific skills (e.g., kicking someone into a ring-out, dashing over an open pitfall, using obstacles as `Q` cover). Keep these interactions in mind when implementing arena/level logic.

## Suggested build order (per spec §7 roadmap)

1. **Phase 1 (done):** Single-player FSM + Q/W/E skill mechanics (Phaser 3), plus bonus content beyond the original roadmap scope — ruins-themed art/arena shell, obstacle cover, quicksand/ring-out hazards, ROUND/DEATHMATCH modes, title screen, hit-stop/impact-burst juice. Entry point: `index.html`.
2. **Phase 2 (MVP done):** 2-player sync over a Colyseus server — Q dash / W parry / E kick hit detection and stun sync, server-authoritative. Deliberately minimal on the client side (no hazards, no walls, no stick-figure rendering) to keep the MVP focused on the netcode itself. Entry point: `net.html` + `server/`.
3. **Phase 3 (not started):** Bring Phase 1's arena (walls, ring-out, hazards) and full visual fidelity into the networked client, plus 6-player room matchmaking for FFA/2v2/3v3.
