// Manual-testing helper: connects to a running Colyseus server as a real
// client (not a special server-side concept — the server treats it like any
// other player) so a solo dev can test hit-interactions without needing two
// browser tabs.
//
// Usage (with the server already running via `npm start` in another shell):
//   node bot.js [classId] [nickname]
// classId defaults to a random pick from CLASS_IDS; nickname defaults to
// "Bot-<classId>". Set ARENA_SERVER_URL to point at a non-local server.
//
// Behavior mirrors ../src/entities/Dummy.js, the single-player training
// dummy: stands still (no movement), periodically raises W, periodically
// charges/fires Q aimed at whichever other player is nearest — no random
// mashing. Tap vs hold-to-charge is picked per the bot's own class shape
// (classSkills(classId).skillTypes) so the same script "feels" right
// whichever class it's testing; E is left unused, same as the real dummy.

const { Client } = require("colyseus.js");
const { classSkills } = require("./constants");

const SERVER_URL = process.env.ARENA_SERVER_URL || "ws://localhost:2567";
const CLASS_IDS = ["swordsman", "knight", "warrior", "mage"];
const classId = process.argv[2] || CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)];
const nickname = process.argv[3] || `Bot-${classId}`;
const TICK_MS = 50;

// Mirrors Dummy.js's PARRY_INTERVAL_MS/DASH_INTERVAL_MS/DASH_HOLD_MS exactly.
const PARRY_INTERVAL_MS = 2200;
const DASH_INTERVAL_MS = 3600;
const DASH_HOLD_MS = 350;
// Not in the single-player dummy (its W is always a tap) — heldGuard classes
// need to actually hold wHeld for a bit to get a real block window at all.
const HELD_W_HOLD_MS = 500;

function findNearestOther(room) {
  const me = room.state.players.get(room.sessionId);
  if (!me) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [id, p] of room.state.players.entries()) {
    if (id === room.sessionId || !p.isAlive) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best ? { me, target: best } : null;
}

async function main() {
  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate("arena", {
    nickname,
    colorIndex: Math.floor(Math.random() * 6),
    classId,
    spectate: false,
  });
  console.log(`[bot] joined as "${nickname}" (${classId}), sessionId=${room.sessionId}`);

  const skillTypes = classSkills(classId).skillTypes;
  let seq = 0;
  let angle = 0;
  let parryClock = PARRY_INTERVAL_MS;
  let dashClock = DASH_INTERVAL_MS;
  let qHoldMsLeft = 0;
  let wHoldMsLeft = 0;

  const timer = setInterval(() => {
    const pair = findNearestOther(room);
    if (pair) angle = Math.atan2(pair.target.y - pair.me.y, pair.target.x - pair.me.x);

    let qPressed = false;
    let wPressed = false;

    // Same shape as Dummy.update(): mid Q-charge takes priority and just
    // ticks down (re-aiming every frame) until release; only once neither
    // hold is active do the periodic clocks get to fire a fresh one.
    if (qHoldMsLeft > 0) {
      qHoldMsLeft -= TICK_MS;
    } else if (wHoldMsLeft > 0) {
      wHoldMsLeft -= TICK_MS;
    } else if (room.state.matchPhase === "live") {
      dashClock -= TICK_MS;
      parryClock -= TICK_MS;
      if (dashClock <= 0) {
        dashClock = DASH_INTERVAL_MS;
        if (skillTypes.q === "chargeDash" || skillTypes.q === "laserBeam") qHoldMsLeft = DASH_HOLD_MS;
        else qPressed = true; // tap classes (comboDash/axeSwing) fire instantly
      } else if (parryClock <= 0) {
        parryClock = PARRY_INTERVAL_MS;
        if (skillTypes.w === "heldGuard") wHoldMsLeft = HELD_W_HOLD_MS;
        else wPressed = true; // tap classes (tapParry/battleCry) fire instantly
      }
    }

    seq += 1;
    room.send("input", {
      seq,
      wantsMove: false,
      aimAngle: angle,
      qHeld: qHoldMsLeft > 0,
      qPressed,
      wHeld: wHoldMsLeft > 0,
      wPressed,
      ePressed: false,
      eHeld: false,
    });
  }, TICK_MS);

  room.onLeave((code) => {
    clearInterval(timer);
    console.log(`[bot] left room (code ${code})`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[bot] failed to connect:", err);
  process.exit(1);
});
