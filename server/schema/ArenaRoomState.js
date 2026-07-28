const { Schema, MapSchema, ArraySchema, defineTypes } = require("@colyseus/schema");

// Mirrors the flat per-player schema documented in CLAUDE.md §6.2:
// { id, x, y, angle, state, chargeTime, stunTimer, globalCooldown, isAlive }
// plus `score` (round wins / deathmatch kills — see ArenaRoom's match-flow
// section). Anything not in this list (dash vectors, one-shot hit flags,
// input intent) is server-only bookkeeping and lives in ArenaRoom's
// `scratch` map instead — it never needs to reach the client.
class PlayerState extends Schema {}
defineTypes(PlayerState, {
  id: "string",
  x: "number",
  y: "number",
  angle: "number",
  state: "string",
  chargeTime: "number",
  stunTimer: "number",
  globalCooldown: "number",
  isAlive: "boolean",
  score: "number",
  colorIndex: "number", // stable per-seat index (join order), 0..3 — client picks a color/label from it
});

// A plain axis-aligned rect — reused for obstacles, pits, AND quicksand
// (identical shape, just interpreted differently by hitsObstacle() /
// checkPitDeaths() / isInQuicksand()). Generated once per room (see
// layoutGenerator.js) and never changes after that — all three hazard
// types are permanent for the whole match, so late joiners get them for
// free as part of the normal state sync.
class RectState extends Schema {}
defineTypes(RectState, {
  x: "number",
  y: "number",
  w: "number",
  h: "number",
});

class ArenaRoomState extends Schema {
  constructor() {
    super();
    // Complex-type fields (map/array/child schema) aren't auto-instantiated
    // by defineTypes — without this, `this.state.players` is undefined
    // until explicitly assigned, which breaks the very first onJoin.
    this.players = new MapSchema();
    this.obstacles = new ArraySchema();
    this.pits = new ArraySchema();
    this.quicksand = new ArraySchema();

    // Match flow (ROUND/DEATHMATCH mode, 3-2-1-FIGHT! countdown, round-end/
    // match-end freeze) — see ArenaRoom's tick()/startCountdown()/_onPlayerDied().
    // DEATHMATCH is the current default: 1 point per kill, first to
    // DEATHMATCH_WIN_SCORE wins the whole match.
    this.mode = "deathmatch"; // "round" | "deathmatch"
    this.matchPhase = "waiting"; // waiting | countdown | live | roundEnd | matchEnd
    this.phaseTimer = 0; // ms remaining in the current phase
    this.winnerId = ""; // sessionId of the most recent round/kill/match winner, "" if draw/none

    // Read-only watchers past the 4 active seats — see ArenaRoom.onJoin().
    // Just a count for the scoreboard; spectators have no PlayerState.
    this.spectatorCount = 0;
  }
}
defineTypes(ArenaRoomState, {
  players: { map: PlayerState },
  obstacles: [RectState],
  pits: [RectState],
  quicksand: [RectState],
  mode: "string",
  matchPhase: "string",
  phaseTimer: "number",
  winnerId: "string",
  spectatorCount: "number",
});

module.exports = { PlayerState, ArenaRoomState, RectState };
