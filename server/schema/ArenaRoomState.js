const { Schema, MapSchema, ArraySchema, defineTypes } = require("@colyseus/schema");

// Mirrors the flat per-player schema documented in CLAUDE.md §6.2:
// { id, x, y, angle, state, chargeTime, stunTimer, globalCooldown, isAlive }
// plus `score` (round wins / deathmatch kills — see ArenaRoom's match-flow
// section), `lastInputSeq` (echoes the client's own input sequence numbers
// back for PredictedSelf's replay-based reconciliation), and `classId`
// (which class's Q/W/E tuning this player uses — see constants.js's
// CLASSES/classSkills()), `empoweredQActive` (Knight only — lets other
// clients render the buff glow), `skillsDisabled` (Warrior only — a
// battle-cry debuff whose lifetime can't be inferred from `state` alone,
// since a debuffed player keeps acting normally), `fastChargeActive` (Mage
// only — a blocked W or a landed E freeze queues a cheap next Q, same
// "can't infer from state" shape), and `slowed` (Mage's blizzard slow
// debuff — can land on any class, same shape again). Anything not in this
// list (dash vectors, one-shot hit flags, input intent) is server-only
// bookkeeping and lives in ArenaRoom's `scratch` map instead — it never
// needs to reach the client.
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
  colorIndex: "number", // chosen color swatch, 0..COLOR_COUNT-1 (see ArenaRoom.COLOR_COUNT) — client renders from it
  nickname: "string", // display name chosen in the lobby, shown above the fighter in-game
  lastInputSeq: "number", // most recent client input seq this player's state reflects — see src/net/PredictedSelf.js's reconcile()
  classId: "string", // which class's Q/W/E tuning applies — see constants.js's CLASSES/classSkills()
  empoweredQActive: "boolean", // Knight only: a blocked W has queued an instakill empowered Q — see ArenaRoom's empoweredQMs
  skillsDisabled: "boolean", // Warrior only: hit by a battle-cry shout, can't start Q/W/E — see ArenaRoom's skillsDisabledMs
  fastChargeActive: "boolean", // Mage only: a blocked W or landed E freeze queued a cheap next Q — see ArenaRoom's fastChargeMs
  slowed: "boolean", // Mage only: hit by a blizzard (plain hit) — see ArenaRoom's slowedMs
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

    // Read-only watchers past the 10 active seats — see ArenaRoom.onJoin().
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
