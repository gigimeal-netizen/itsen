# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Folder guides

Each major folder has its own `CLAUDE.md` with directory-scoped architecture/conventions — read this
root file first, then the relevant one(s) below for anything that goes deeper than a one-line change:

- [`src/CLAUDE.md`](src/CLAUDE.md) — client code map (FSM update order, GCD-skip pattern, entities/scenes/config/audio/input layout).
- [`server/CLAUDE.md`](server/CLAUDE.md) — Colyseus server map, the colyseus.js version pin, running/deploying it.
- [`assets/CLAUDE.md`](assets/CLAUDE.md) — audio/image assets and how to register a new one in `preload()`.
- [`vendor/CLAUDE.md`](vendor/CLAUDE.md) — the vendored `colyseus.js` bundle and how to update it.

## Keeping this file accurate

This file is living documentation, not a point-in-time snapshot — it previously described `net.html` as
a bare-bones 2-player proof-of-concept long after it had grown a lobby, nicknames, customization, synced
hazards, and full stick-figure rendering, which cost real time to notice and unwind. Treat correcting
this file as part of the task, not a follow-up:

- If a change alters what `index.html`/`net.html` supports, the deployment setup, a version pin, or an
  architecture description below, update the relevant section (here or in the folder-scoped
  `CLAUDE.md` it belongs to) in the same session.
- Prefer pointing at the source of truth over hardcoding a value that will silently drift — e.g. "check
  `net.html`'s `window.ARENA_SERVER_URL`" instead of naming today's live server URL, which will outlive
  this sentence's accuracy the next time the deployment moves.

## Project status

Phase 1 (single-player) is feature-complete. Phase 2's multiplayer has grown well past its original MVP
scope — see below — and Phase 3's "bring Phase 1's polish into the networked client" goal is done, including
raising the room cap to 10 players (well past the spec's original 4–6 target). What's left is matchmaking
for team modes (2v2/3v3), not just FFA. No bundler/package manager is used on the client — Phaser 3 is
loaded via CDN and the client is plain ES modules served as static files. There is no lint/test setup.

### Running it

- **Client static server** (serves both `index.html` and `net.html`): `python nocache_server.py` from the repo root — a custom no-cache static file server on port 8731 (plain `python -m http.server` was dropped; see git history/CLAUDE memory for why). Open `http://localhost:8731/index.html`.
- **Phase 1 (single-player)**: `index.html` — no server process beyond the static file server above. Title screen → 3-2-1 countdown → ROUND or DEATHMATCH mode vs. a training dummy, full hazard/round/effects feature set.
- **Phase 2/3 (multiplayer)**: `net.html` — requires the Colyseus server running too:
  ```
  cd server
  npm install   # first time only
  npm start     # node index.js — listens on ws://localhost:2567
  ```
  Then open `http://localhost:8731/net.html` — the title screen itself now has an inline nickname +
  color-swatch + class picker (persisted in `localStorage`, sent as join options and validated
  server-side), and "시작하기" joins straight into a match via Colyseus's own `joinOrCreate` matchmaking —
  there is no separate lobby/room-browsing screen (removed; `GET /rooms` still exists server-side but is
  currently unused by the client). Full parity with Phase 1's rendering (stick-figure `NetFighter`, synced arena hazards — obstacle walls,
  octagon ring-out, permanent pits/quicksand — round/deathmatch modes, death VFX). Up to 10 players per
  room today (`server/constants.js`'s `MAX_PLAYERS`) — see "Project status" above; this exceeds the
  spec's original 4–6 target. Server code lives in `server/` (plain CommonJS, not part of the client's ES module graph) —
  `server/rooms/ArenaRoom.js` is the authoritative FSM (a server-side port of
  `src/entities/Combatant.js`'s state machine, minus Phaser/Arcade physics), `server/schema/ArenaRoomState.js`
  defines the synced `@colyseus/schema` state, `server/constants.js` is a hand-kept-in-sync copy of the
  tuning values in `src/config/constants.js`.
  - **Version pin note**: the official browser client (`colyseus.js`) hasn't published past `0.16.x` even though the `colyseus`/`@colyseus/core` server packages are on `0.17.x`+ on npm. Check `server/package.json` for the exact pinned versions currently in use (deliberately kept on the `0.16.x` line) — don't bump the server past that line without also checking whether a matching `colyseus.js` release exists, or the wire protocol may silently break. The client bundle is vendored at `vendor/colyseus.js` (copied from `server/node_modules/colyseus.js/dist/colyseus.js`) since there's no client-side package manager step.

### Deploying it

Deployed on Render: a static site for the client (`index.html`/`net.html`/`src/`/`vendor/`/`assets/`) and
a separate Docker web service for `server/`. Check `net.html`'s `window.ARENA_SERVER_URL` for the
server endpoint the deployed client currently points at — don't rely on this file for that, it changes
independently of the code (e.g. swapping regions).

- **Server** (`server/`) reads its port from `process.env.PORT` (falls back to 2567 — see `server/index.js`), so it runs as-is on any Node PaaS. `server/Dockerfile` builds a plain `node index.js` container (pin the base image's Node version to whatever the pinned `colyseus` version supports — see the version-pin note above before bumping it). `server/.env.example` documents the one env var that matters.
- **Client** (`index.html`, `net.html`, `src/`, `vendor/`, `assets/`) is static — any static host works, `nocache_server.py` is purely a local-dev convenience, not something a real deploy needs.
- Since the client and server live on different Render services, `net.html` sets `window.ARENA_SERVER_URL` right before loading `src/netMain.js` — point it at the deployed Colyseus server's `ws://`/`wss://` URL instead of editing `src/scenes/NetArenaScene.js`.
- `.gitignore` excludes `node_modules/`, `.env`, OS junk files, and local Claude Code/Serena tooling config (`.mcp.json`, `.serena/`, `run_serena.bat`).

## What this project is

A multiplayer top-down real-time action arena game for web/mobile browsers (FFA, 2v2, 3v3, 1v1) — the spec's
original target was 4–6 players; the live room cap is now 10 (see Project status). One hit from the "Q"
skill kills; last player/team standing wins. Full spec: `game_design_spec.md`.

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

Player state is a flat schema synced server → client: `{ id, x, y, angle, state, chargeTime, stunTimer, globalCooldown, isAlive }` per spec, plus `score`, `colorIndex`, and `nickname` added since (see `server/schema/ArenaRoomState.js`, the actual source of truth for this list). The server is authoritative for state transitions and hit detection; clients render/interpolate from this schema.

### Arena hazards (spec §5.2)

Ring-out (fall to death off-arena), periodic pitfalls, slow zones, and obstacles/pillars that block `Q` dashes — each is designed to interact with specific skills (e.g., kicking someone into a ring-out, dashing over an open pitfall, using obstacles as `Q` cover). Keep these interactions in mind when implementing arena/level logic.

## Suggested build order (per spec §7 roadmap)

1. **Phase 1 (done):** Single-player FSM + Q/W/E skill mechanics (Phaser 3), plus bonus content beyond the original roadmap scope — ruins-themed art/arena shell, obstacle cover, quicksand/ring-out hazards, ROUND/DEATHMATCH modes, title screen, hit-stop/impact-burst juice. Entry point: `index.html`.
2. **Phase 2 (done, grown past MVP):** started as a minimal 2-player sync proof-of-concept, since extended with a lobby/room list, nickname + color customization, and reconnect handling. Entry point: `net.html` + `server/`.
3. **Phase 3 (done):** Phase 1's arena (walls, ring-out, hazards), full visual fidelity (stick-figure rendering, death VFX), movement-smoothing (client-side interpolation, a raised server patch rate), and a 10-player room cap (past the spec's original 4–6 range) are all in the networked client. Remaining: matchmaking for 2v2/3v3, not just FFA.
