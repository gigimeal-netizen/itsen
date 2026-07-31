// Phase 2/3 merge: the server (server/rooms/ArenaRoom.js) remains fully
// authoritative for movement, the Q/W/E state machine, and arena hazards
// (obstacle walls, octagon ring-out, permanent pits/quicksand) — nothing
// here can decide a hit, a kill, or a state transition caused by another
// player. This scene sends input intent and renders whatever state comes
// back for everyone EXCEPT the local player, who is instead rendered from
// PredictedSelf — a client-side mirror of the server's own-input-only FSM
// logic, corrected against each authoritative snapshot as it arrives — so
// your own actions show up immediately instead of after a network round
// trip (see PredictedSelf.js for exactly what is/isn't predicted and why).
// Reuses the same ruins art/arena shell as the single-player ArenaScene so
// both feel like the same game. Player rendering is NetFighter (a
// visual-only, server/prediction-driven twin of Combatant.js's stick-figure
// renderer).
//
// Rather than wiring change-callbacks for the static hazard state
// (obstacles/pits/quicksand — all generated once per room and never
// change), this just re-reads `this.room.state.*` once, the first time
// each list shows up — far simpler than Colyseus's callback API and avoids
// a callback-ordering footgun already hit once here (see the comment in
// _connect()).
import {
  ARENA,
  RING_OUT_MARGIN,
  FLOOR_CORNER_CUT,
  PLAYER,
  STATES,
  E_KICK,
  Q_DASH,
  NET_COUNTDOWN_MS,
} from "../config/constants.js";
import NetFighter from "../net/NetFighter.js";
import PredictedSelf from "../net/PredictedSelf.js";
import Sfx from "../audio/Sfx.js";
import TouchControls from "../input/TouchControls.js";

// Color swatch palette — the player picks one in the lobby, synced as
// PlayerState.colorIndex (validated server-side, see ArenaRoom's
// sanitizeColorIndex/COLOR_COUNT). Not tied to join order anymore.
const PLAYER_COLORS = [0x4fd1ff, 0xff8a5c, 0x8aff6b, 0xd88aff, 0xff5c5c, 0xffe066];

// Renders players slightly in the past, interpolating between two buffered
// server snapshots instead of chasing whatever the latest one happens to be
// (see _getInterpolatedSnapshot). The server only broadcasts state ~30x/sec
// (ArenaRoom's patchRate); without this buffer, a late patch under real
// network jitter freezes the render target until the next one arrives,
// which is what reads as stutter/pushing next to single-player's every-
// frame physics. ~2 patch intervals of buffer is enough to always have two
// real samples to interpolate between even when a patch is a bit late.
const RENDER_DELAY_MS = 100;

// Same flag as PredictedSelf.js's — open net.html?debugpredict to log every
// real (frame-to-frame) local state transition _detectFighterEvents fires
// SFX from, for tracking down the "skill triggers multiple times" report.
const DEBUG = typeof window !== "undefined" && window.location.search.includes("debugpredict");

export default class NetArenaScene extends Phaser.Scene {
  constructor() {
    super("NetArenaScene");
  }

  preload() {
    this.load.audio("qCharging", "assets/audio/q_charging.wav");
    this.load.audio("qActive", "assets/audio/q_active.mp3");
    this.load.audio("kick", "assets/audio/kicksound.mp3");
    this.load.audio("kill", "assets/audio/kill.mp3");
    this.load.audio("shieldOn", "assets/audio/shield_on.mp3");
    this.load.audio("parry", "assets/audio/parry.mp3");
    this.load.audio("wSuccess", "assets/audio/Wsucces.mp3");

    this.load.image("arenaVoid", "assets/images/arena_void.png");
    this.load.image("arenaTile", "assets/images/arena_tile.png");
    this.load.image("arenaObs", "assets/images/arena_obs.png");
  }

  create() {
    this.cameras.main.setBackgroundColor("#0d0b08");
    this.cameras.main.setBounds(0, 0, ARENA.WIDTH, ARENA.HEIGHT);
    this._buildArenaFloor();
    this._buildQuicksandGfx();
    this._buildPitGfx();

    this.hud = document.getElementById("hud");
    this.fighters = new Map(); // sessionId -> NetFighter
    this.predictedSelf = new PredictedSelf(); // see _wireRoom()/update() and PredictedSelf.js
    this._inputSeq = 0; // incrementing id tagged on every "input" send, for PredictedSelf's replay reconciliation
    this._pendingInputs = []; // [{ seq, dtMs, input, hazards }, ...] sent but not yet confirmed by the server
    this.room = null;
    this.mySessionId = null;
    this.isSpectator = false;
    this.pointerDown = false;
    this.wPressedFlag = false;
    this.ePressedFlag = false;
    this.connectionError = null;

    this.obstaclesBuilt = false;
    this.pitsBuilt = false;
    this.quicksandBuilt = false;
    // Previous frame's array length, for _syncHazardsFromRoom()'s
    // steady-for-two-frames check before building hazard art.
    this._lastObstacleCount = 0;
    this._lastPitCount = 0;
    this._lastQuicksandCount = 0;

    // Single-player-parity impact FX: blood/death-burst on kill, shrink-spin
    // on hazard death, impact-burst rings on big stuns, camera shake/flash,
    // and a brief hit-stop freeze — all detected client-side by diffing each
    // player's snapshot frame to frame (isAlive/state transitions), since
    // the server only syncs the flat state, not "cause of death" events.
    this._prevSnap = new Map(); // sessionId -> { isAlive, state, stunTimer, score }
    this._kickHitFlags = new Map(); // sessionId -> already played kickHit() for this kick
    this.hitstopMs = 0;

    // Match-flow UI (3-2-1-FIGHT! countdown, round banner, scoreboard) —
    // server-authoritative (room.state.mode/matchPhase/phaseTimer/winnerId),
    // this scene just renders it. Mode is fixed per room (no in-match
    // switch — it used to reset everyone's score/countdown on every click,
    // which read as an accidental full reset far more often than an
    // intentional mode change). See _updateMatchUI().
    this.roundBannerEl = document.getElementById("roundBanner");
    this.scoreListEl = document.getElementById("scoreList");
    this._killFlashUntil = 0;
    this._killFlashText = "";

    Sfx.attachScene(this);
    const unlockAudio = () => Sfx.init();
    this.input.once("pointerdown", unlockAudio);
    this.input.keyboard.once("keydown", unlockAudio);

    this.titleScreenEl = document.getElementById("titleScreen");
    this.lobbyScreenEl = document.getElementById("lobbyScreen");
    this.lobbyRoomListEl = document.getElementById("lobbyRoomList");
    this.lobbyErrorEl = document.getElementById("lobbyError");
    this.lobbyNameInputEl = document.getElementById("lobbyNameInput");
    this._lobbyRefreshTimer = null;

    // Player profile (nickname + color swatch), persisted across visits so
    // returning players don't have to re-pick every time. Sent as join
    // options (see _quickMatch/_createRoom/_joinRoom) — the server validates
    // and stores both on PlayerState (ArenaRoom.onJoin()).
    this.lobbyNickInputEl = document.getElementById("lobbyNickInput");
    this.lobbyColorRowEl = document.getElementById("lobbyColorRow");
    this.myNickname = localStorage.getItem("itsen_nickname") || "";
    this.myColorIndex = Number(localStorage.getItem("itsen_colorIndex"));
    if (!Number.isInteger(this.myColorIndex) || this.myColorIndex < 0 || this.myColorIndex >= PLAYER_COLORS.length) {
      this.myColorIndex = 0;
    }
    this.lobbyNickInputEl.value = this.myNickname;
    this.lobbyNickInputEl.oninput = () => {
      this.myNickname = this.lobbyNickInputEl.value;
      localStorage.setItem("itsen_nickname", this.myNickname);
    };
    this._renderColorSwatches();

    document.getElementById("startBtn").onclick = () => {
      unlockAudio();
      this.titleScreenEl.classList.add("hidden");
      this._openLobby();
    };
    document.getElementById("lobbyBackBtn").onclick = () => {
      this._closeLobby();
      this.titleScreenEl.classList.remove("hidden");
    };
    document.getElementById("lobbyRefreshBtn").onclick = () => this._refreshRoomList();
    document.getElementById("lobbyQuickBtn").onclick = () => this._quickMatch();
    document.getElementById("lobbyCreateBtn").onclick = () => this._createRoom();
    document.getElementById("leaveBtn").onclick = () => this._leaveMatch();

    this.input.on("pointerdown", (p) => {
      if (p.leftButtonDown()) this.pointerDown = true;
    });
    this.input.on("pointerup", (p) => {
      if (!p.leftButtonDown()) this.pointerDown = false;
    });
    this.qKey = this.input.keyboard.addKey("Q");
    // event.repeat guards against OS keyboard auto-repeat — holding W/E
    // even slightly past a quick tap fires native keydown repeatedly
    // (every ~30-50ms after an initial ~500ms delay), and without this
    // check each repeat re-armed the flag. Since PARRYING's own duration
    // plus its GCD happens to land in a similar few-hundred-ms range, a
    // held key kept re-triggering the whole skill 2-3 times per press —
    // read as the sound/animation firing multiple times per single press.
    this.input.keyboard.on("keydown-W", (event) => {
      if (event.repeat) return;
      this.wPressedFlag = true;
    });
    this.input.keyboard.on("keydown-E", (event) => {
      if (event.repeat) return;
      this.ePressedFlag = true;
    });

    this.touch = new TouchControls();
  }

  // ---- Arena shell (shared look with ArenaScene) -----------------------

  _buildArenaFloor() {
    this.floorBounds = {
      x: RING_OUT_MARGIN,
      y: RING_OUT_MARGIN,
      w: ARENA.WIDTH - RING_OUT_MARGIN * 2,
      h: ARENA.HEIGHT - RING_OUT_MARGIN * 2,
    };
    const f = this.floorBounds;
    const cut = FLOOR_CORNER_CUT;

    this.floorPolyPoints = [
      { x: f.x + cut, y: f.y },
      { x: f.x + f.w - cut, y: f.y },
      { x: f.x + f.w, y: f.y + cut },
      { x: f.x + f.w, y: f.y + f.h - cut },
      { x: f.x + f.w - cut, y: f.y + f.h },
      { x: f.x + cut, y: f.y + f.h },
      { x: f.x, y: f.y + f.h - cut },
      { x: f.x, y: f.y + cut },
    ];

    this.add.tileSprite(ARENA.WIDTH / 2, ARENA.HEIGHT / 2, ARENA.WIDTH, ARENA.HEIGHT, "arenaVoid").setDepth(-13);

    const floorTile = this.add.tileSprite(f.x + f.w / 2, f.y + f.h / 2, f.w, f.h, "arenaTile").setDepth(-10);
    const maskShape = this.make.graphics({ x: 0, y: 0 });
    maskShape.fillStyle(0xffffff);
    maskShape.fillPoints(this.floorPolyPoints, true);
    floorTile.setMask(maskShape.createGeometryMask());

    const border = this.add.graphics().setDepth(-8);
    border.lineStyle(3, 0xc98a3a, 0.75);
    border.strokePoints(this.floorPolyPoints, true);
    border.lineStyle(1, 0x2a1f14, 0.6);
    const innerPts = this.floorPolyPoints.map((p) => ({
      x: p.x + (p.x > f.x + f.w / 2 ? -4 : p.x < f.x + f.w / 2 ? 4 : 0),
      y: p.y + (p.y > f.y + f.h / 2 ? -4 : p.y < f.y + f.h / 2 ? 4 : 0),
    }));
    border.strokePoints(innerPts, true);

    this.tweens.add({
      targets: border,
      alpha: { from: 0.55, to: 0.9 },
      duration: 1800,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  // Builds the pillar art the first time the server's obstacle list shows
  // up (it's static for the room's lifetime, generated once server-side).
  _buildObstacleArt(obstacles) {
    const OBS_ASPECT = 326 / 968;
    for (const o of obstacles) {
      const artH = o.h * 1.05;
      const artW = artH * OBS_ASPECT;
      this.add.image(o.x, o.y, "arenaObs").setDisplaySize(artW, artH).setDepth(0);
    }
    this.obstaclesBuilt = true;
  }

  _buildQuicksandGfx() {
    this.quicksandGfx = this.add.graphics().setDepth(-7);
    this.quicksandPatches = [];
  }

  _buildPitGfx() {
    this.pitGfx = this.add.graphics().setDepth(-6);
    this.pits = [];
    this.pitDecor = [];
  }

  _buildCrackPattern() {
    const lines = [];
    const count = 5 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const theta = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      const bend = (Math.random() - 0.5) * 0.5;
      lines.push({ theta, bend });
    }
    return lines;
  }

  _blobPoints(cx, cy, rx, ry, harmonics) {
    const pts = [];
    const segments = 28;
    for (let i = 0; i < segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      let mod = 1;
      for (const h of harmonics) mod += h.amp * Math.sin(theta * h.freq + h.phase);
      pts.push(new Phaser.Geom.Point(cx + Math.cos(theta) * rx * mod, cy + Math.sin(theta) * ry * mod));
    }
    return pts;
  }

  // Quicksand patches are permanent for the room's whole lifetime — built
  // once, the first time the server's list shows up, then drawn once.
  _buildQuicksandPatches(rects) {
    this.quicksandPatches = rects.map((q) => this._makeQuicksandPatch(q));
    this._drawQuicksand();
    this.quicksandBuilt = true;
  }

  _makeQuicksandPatch(q) {
    const harmonics = [
      { amp: 0.14, freq: 2, phase: Math.random() * Math.PI * 2 },
      { amp: 0.09, freq: 3, phase: Math.random() * Math.PI * 2 },
      { amp: 0.06, freq: 5, phase: Math.random() * Math.PI * 2 },
    ];
    const mudColors = [0x6b4a2b, 0x8a6a3a, 0x5c3f24];
    const blotches = [];
    for (let i = 0; i < 9; i++) {
      const theta = Math.random() * Math.PI * 2;
      const rr = Math.random() * 0.7;
      blotches.push({
        dx: Math.cos(theta) * (q.w / 2) * rr,
        dy: Math.sin(theta) * (q.h / 2) * rr,
        r: 7 + Math.random() * 12,
        color: Phaser.Utils.Array.GetRandom(mudColors),
        extraAlpha: Math.random() * 0.25,
      });
    }
    const patch = { x: q.x, y: q.y, w: q.w, h: q.h, harmonics, blotches, bubbles: [] };
    this._spawnQuicksandBubbles(patch);
    return patch;
  }

  _spawnQuicksandBubbles(patch) {
    const cx = patch.x;
    const cy = patch.y;
    for (let i = 0; i < 4; i++) {
      const theta = Math.random() * Math.PI * 2;
      const rr = Math.random() * 0.55;
      const bx = cx + Math.cos(theta) * (patch.w / 2) * rr;
      const by = cy + Math.sin(theta) * (patch.h / 2) * rr;
      const bubble = this.add.circle(bx, by, 4, 0x4a3320, 0.5).setDepth(-6).setAlpha(0.5);
      this.tweens.add({
        targets: bubble,
        scale: 1.8,
        alpha: 0,
        duration: 1800 + Math.random() * 1200,
        repeat: -1,
        delay: Math.random() * 1500,
        ease: "Sine.easeOut",
      });
      patch.bubbles.push(bubble);
    }
  }

  _drawQuicksand() {
    this.quicksandGfx.clear();
    for (const q of this.quicksandPatches) {
      const cx = q.x;
      const cy = q.y;
      const rx = q.w / 2;
      const ry = q.h / 2;

      for (let i = 4; i >= 1; i--) {
        const scale = 1 + i * 0.09;
        this.quicksandGfx.fillStyle(0x7a5a30, 0.06);
        this.quicksandGfx.fillPoints(this._blobPoints(cx, cy, rx * scale, ry * scale, q.harmonics), true);
      }

      this.quicksandGfx.fillStyle(0xa8834a, 0.6);
      this.quicksandGfx.fillPoints(this._blobPoints(cx, cy, rx, ry, q.harmonics), true);

      for (const blot of q.blotches) {
        this.quicksandGfx.fillStyle(blot.color, 0.28 + blot.extraAlpha);
        this.quicksandGfx.fillCircle(cx + blot.dx, cy + blot.dy, blot.r);
      }

      this.quicksandGfx.lineStyle(2, 0x5c3f24, 0.55);
      this.quicksandGfx.strokePoints(this._blobPoints(cx, cy, rx, ry, q.harmonics), true);
    }
  }

  // Pits are permanent for the room's whole lifetime — built once, the
  // first time the server's list shows up. The hole shows the actual void
  // art through it (masked tileSprite aligned to the same world coords as
  // the backdrop) instead of a flat black fill, plus a dark rim + radiating
  // cracks to sell the depth — matches ArenaScene._buildPits().
  _buildPits(rects) {
    this.pits = rects;
    this.pitDecor = rects.map((p) => this._makePitDecor(p));
    this._drawPitDecor();
    this.pitsBuilt = true;
  }

  _makePitDecor(p) {
    const cx = p.x;
    const cy = p.y;
    const rx = (p.w / 2) * 1.1;
    const ry = (p.h / 2) * 1.1;
    const harmonics = [
      { amp: 0.16, freq: 3, phase: Math.random() * Math.PI * 2 },
      { amp: 0.1, freq: 5, phase: Math.random() * Math.PI * 2 },
    ];
    const blob = this._blobPoints(cx, cy, rx, ry, harmonics);

    const voidW = p.w * 2.2;
    const voidH = p.h * 2.2;
    const tile = this.add.tileSprite(cx, cy, voidW, voidH, "arenaVoid").setDepth(-9);
    tile.setTilePosition(cx - voidW / 2, cy - voidH / 2);
    const maskShape = this.make.graphics({ x: 0, y: 0 });
    maskShape.fillStyle(0xffffff);
    maskShape.fillPoints(blob, true);
    tile.setMask(maskShape.createGeometryMask());

    return { cx, cy, rx, ry, blob, cracks: this._buildCrackPattern() };
  }

  _drawPitDecor() {
    this.pitGfx.clear();
    for (const p of this.pitDecor) {
      this.pitGfx.lineStyle(9, 0x000000, 0.3);
      this.pitGfx.strokePoints(p.blob, true);
      this.pitGfx.lineStyle(2, 0x2a2118, 0.75);
      this.pitGfx.strokePoints(p.blob, true);

      for (const crack of p.cracks) {
        const innerR = Math.max(p.rx, p.ry) * 0.5;
        const outerR = Math.max(p.rx, p.ry) * 0.95;
        const midTheta = crack.theta + crack.bend;
        this.pitGfx.lineStyle(2, 0x140f0a, 0.55);
        this.pitGfx.beginPath();
        this.pitGfx.moveTo(p.cx + Math.cos(crack.theta) * innerR, p.cy + Math.sin(crack.theta) * innerR);
        this.pitGfx.lineTo(
          p.cx + Math.cos(midTheta) * (innerR + outerR) * 0.5,
          p.cy + Math.sin(midTheta) * (innerR + outerR) * 0.5
        );
        this.pitGfx.lineTo(p.cx + Math.cos(crack.theta) * outerR, p.cy + Math.sin(crack.theta) * outerR);
        this.pitGfx.strokePath();
      }
    }
  }

  // ---- Impact FX (ported from Combatant.js / ArenaScene.js) ------------

  // A sword-kill: the body splits along cutAngle and the two halves fly
  // apart perpendicular to it, plus a scatter of colored bits and a white
  // shockwave ring. Matches Combatant.kill()'s _spawnDeathBurst/_spawnHalf.
  _spawnDeathBurst(x, y, color, cutAngle) {
    this._spawnHalf(x, y, color, cutAngle, 1);
    this._spawnHalf(x, y, color, cutAngle, -1);

    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const spread = cutAngle + (Math.PI / 2) * side + (Math.random() - 0.5) * 0.6;
      const dist = 30 + Math.random() * 40;
      const bit = this.add.circle(x, y, 2 + Math.random() * 2, color, 0.85);
      this.tweens.add({
        targets: bit,
        x: x + Math.cos(spread) * dist,
        y: y + Math.sin(spread) * dist,
        alpha: 0,
        duration: 320 + Math.random() * 120,
        ease: "Cubic.easeOut",
        onComplete: () => bit.destroy(),
      });
    }

    const ring = this.add.circle(x, y, PLAYER.RADIUS, 0xffffff, 0);
    ring.setStrokeStyle(3, 0xffffff, 0.9);
    this.tweens.add({
      targets: ring,
      radius: PLAYER.RADIUS + 46,
      alpha: 0,
      duration: 320,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  _spawnHalf(x, y, color, cutAngle, side) {
    const r = PLAYER.RADIUS;
    const start = side > 0 ? cutAngle : cutAngle + Math.PI;

    const half = this.add.graphics();
    half.setPosition(x, y);
    half.fillStyle(color, 1);
    half.slice(0, 0, r, start, start + Math.PI, false);
    half.fillPath();
    half.lineStyle(2, 0xffffff, 0.85);
    half.beginPath();
    half.moveTo(Math.cos(start) * r, Math.sin(start) * r);
    half.lineTo(Math.cos(start + Math.PI) * r, Math.sin(start + Math.PI) * r);
    half.strokePath();

    const flyAngle = cutAngle + (Math.PI / 2) * side;
    const flyDist = 70 + Math.random() * 30;
    const forwardDrift = 18;

    this.tweens.add({
      targets: half,
      x: x + Math.cos(flyAngle) * flyDist + Math.cos(cutAngle) * forwardDrift,
      y: y + Math.sin(flyAngle) * flyDist + Math.sin(cutAngle) * forwardDrift,
      rotation: side * (1.2 + Math.random() * 0.8),
      alpha: 0,
      duration: 480,
      ease: "Cubic.easeOut",
      onComplete: () => half.destroy(),
    });
  }

  // Ground-decal blood: a pool at the kill spot plus a spray of droplets
  // that leave their own stains where they land. Matches
  // Combatant._spawnBloodEffect() (blood is always red-toned, independent
  // of the victim's player color).
  _spawnBloodEffect(x, y, cutAngle) {
    const bloodColors = [0x8a0f0f, 0x6b0a0a, 0xa11616];

    const pool = this.add.graphics().setDepth(-1).setAlpha(0);
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * 26;
      const rad = 6 + Math.random() * 15;
      pool.fillStyle(Phaser.Utils.Array.GetRandom(bloodColors), 0.5 + Math.random() * 0.3);
      pool.fillCircle(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, rad);
    }
    this.tweens.add({ targets: pool, alpha: 1, duration: 120 });
    this.tweens.add({
      targets: pool,
      alpha: 0,
      delay: 6000,
      duration: 1500,
      onComplete: () => pool.destroy(),
    });

    const dropletCount = 22;
    for (let i = 0; i < dropletCount; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const spreadAngle = cutAngle + (Math.PI / 2) * side + (Math.random() - 0.5) * 2.2;
      const dist = 18 + Math.random() * 95;
      const size = 2 + Math.random() * 3;
      const landX = x + Math.cos(spreadAngle) * dist;
      const landY = y + Math.sin(spreadAngle) * dist;

      const droplet = this.add.circle(x, y, size, Phaser.Utils.Array.GetRandom(bloodColors), 0.9).setDepth(-1);
      this.tweens.add({
        targets: droplet,
        x: landX,
        y: landY,
        duration: 180 + Math.random() * 160,
        ease: "Cubic.easeOut",
        onComplete: () => {
          droplet.destroy();
          const stain = this.add.circle(landX, landY, size * 0.9, 0x7a0f0f, 0.65).setDepth(-1);
          this.tweens.add({
            targets: stain,
            alpha: 0,
            delay: 5000,
            duration: 1200,
            onComplete: () => stain.destroy(),
          });
        },
      });
    }
  }

  // Hazard death (ring-out / pit): no attacker, so no slice/blood — just a
  // standalone shrink-and-spin drop into the void, matching
  // Combatant.dieFromHazard(). A standalone clone (not the real NetFighter
  // container) so it isn't fought over by the next sync() call, which keeps
  // repositioning the real fighter from server snapshots every frame.
  _spawnHazardDeathEffect(x, y, color, angle) {
    const clone = this.add.container(x, y);
    clone.setRotation(angle);
    clone.add(this.add.circle(0, 0, PLAYER.RADIUS, color, 1));
    clone.add(this.add.circle(0, 0, PLAYER.RADIUS, 0xffffff, 0).setStrokeStyle(2, 0xffffff, 0.6));
    this.tweens.add({
      targets: clone,
      scale: 0,
      alpha: 0,
      rotation: angle + Math.PI * 1.5,
      duration: 380,
      ease: "Cubic.easeIn",
      onComplete: () => clone.destroy(),
    });
  }

  // Brief hard freeze on big impacts (kill, successful parry-stun, or a
  // counter-kick) — matches ArenaScene._spawnImpactBurst()/hitstopMs.
  _spawnImpactBurst(x, y, color, { ringR = 26, bits = 5, dist = 30 } = {}) {
    const ring = this.add.circle(x, y, 6, color, 0);
    ring.setStrokeStyle(3, color, 0.9);
    this.tweens.add({
      targets: ring,
      radius: ringR,
      alpha: 0,
      duration: 260,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });
    for (let i = 0; i < bits; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = dist * 0.5 + Math.random() * dist * 0.5;
      const spark = this.add.circle(x, y, 2 + Math.random() * 2, color, 0.9);
      this.tweens.add({
        targets: spark,
        x: x + Math.cos(ang) * d,
        y: y + Math.sin(ang) * d,
        alpha: 0,
        duration: 200 + Math.random() * 120,
        ease: "Cubic.easeOut",
        onComplete: () => spark.destroy(),
      });
    }
  }

  // Diffs each player's snapshot frame-to-frame to detect events the schema
  // doesn't carry directly (isAlive flipping true->false, a fresh STUNNED
  // entry, entering/leaving a skill state) since the server only syncs flat
  // state, not "cause of death", "this was a big hit", or "this kick landed"
  // flags — also drives all the per-event SFX (Sfx.js), matching
  // Combatant.js's call sites one-for-one.
  _detectFighterEvents(sessionId, snap) {
    const fighter = this.fighters.get(sessionId);
    const prev = this._prevSnap.get(sessionId);
    this._prevSnap.set(sessionId, { isAlive: snap.isAlive, state: snap.state, stunTimer: snap.stunTimer, score: snap.score });
    if (!prev || !fighter) return;

    // Q charging pitch-rising loop: only for the LOCAL player's own charge —
    // the Sfx singleton can only run one such loop at a time, and with up
    // to 4 FFA players potentially charging simultaneously, looping every
    // remote charge would just fight over that one shared audio resource.
    // (The one-shot 100%-ready ding + sparkles, in NetFighter.sync(), still
    // fire for everyone — that's useful "someone's about to dash" info.)
    if (sessionId === this.mySessionId) {
      if (snap.state === STATES.CHARGING) {
        if (prev.state !== STATES.CHARGING) Sfx.chargeLoopStart();
        Sfx.chargeLoopUpdate(snap.chargeTime / Q_DASH.MAX_CHARGE_MS);
      } else if (prev.state === STATES.CHARGING) {
        Sfx.chargeLoopStop();
      }
    }

    // DEATHMATCH mode has no round-end freeze/banner (see ArenaRoom's
    // _onPlayerDied) — score just quietly increments, so flash a brief
    // "+1" here instead, matching the single-player ArenaScene's
    // _checkDeathmatchScoring/_flashKillText.
    if (this.room && this.room.state.mode === "deathmatch" && prev.score !== undefined && snap.score > prev.score) {
      this._killFlashText = `${this._playerLabel(sessionId)} +1`;
      this._killFlashUntil = this.time.now + 700;
    }

    if (prev.isAlive && !snap.isAlive) {
      Sfx.death();
      const killerAngle = this._findNearbyDasherAngle(sessionId, snap);
      if (killerAngle !== null) {
        this._spawnDeathBurst(snap.x, snap.y, fighter.color, killerAngle);
        this._spawnBloodEffect(snap.x, snap.y, killerAngle);
        this.cameras.main.shake(160, 0.008);
        this.cameras.main.flash(120, 60, 0, 0);
        this.hitstopMs = 90;
      } else {
        this._spawnHazardDeathEffect(snap.x, snap.y, fighter.color, snap.angle);
        this.cameras.main.shake(120, 0.006);
        this.hitstopMs = 60;
      }
      return;
    }

    if (prev.state !== STATES.DASH && snap.state === STATES.DASH) {
      if (DEBUG && sessionId === this.mySessionId) {
        console.log(`[sfx] dashRelease() fired — prev.state=${prev.state} -> snap.state=${snap.state} t=${Math.round(performance.now())}`);
      }
      Sfx.dashRelease();
    }
    if (prev.state !== STATES.PARRYING && snap.state === STATES.PARRYING) {
      if (DEBUG && sessionId === this.mySessionId) {
        console.log(`[sfx] parryStance() fired — prev.state=${prev.state} -> snap.state=${snap.state} t=${Math.round(performance.now())}`);
      }
      Sfx.parryStance();
    }
    if (prev.state !== STATES.KICKING && snap.state === STATES.KICKING) {
      if (DEBUG && sessionId === this.mySessionId) {
        console.log(`[sfx] kickSwing() fired — prev.state=${prev.state} -> snap.state=${snap.state} t=${Math.round(performance.now())}`);
      }
      Sfx.kickSwing();
      this._kickHitFlags.set(sessionId, false);
    }
    // PARRYING only ever resolves to GCD (timed out) or IDLE (successful
    // counter, exempt from GCD) — so PARRYING->IDLE uniquely means success.
    if (prev.state === STATES.PARRYING && snap.state === STATES.IDLE) {
      Sfx.parrySuccess();
    }

    if (prev.state !== STATES.STUNNED && snap.state === STATES.STUNNED) {
      const big = snap.stunTimer >= 1500; // STUN_DURATION_MS (parry/kick counter) vs WALL_STUN_MS
      if (!big) Sfx.wallBump();
      Sfx.stun(snap.stunTimer);
      this._spawnImpactBurst(
        snap.x,
        snap.y,
        big ? 0x7ff0ff : 0xffcc33,
        big ? { ringR: 42, bits: 8, dist: 42 } : { ringR: 22, bits: 4, dist: 20 }
      );
      this.hitstopMs = big ? 70 : 40;
    }

    if (snap.state === STATES.KICKING && !this._kickHitFlags.get(sessionId)) {
      this._checkKickHit(sessionId, snap);
    }
  }

  // The server doesn't sync a "this kick just landed" flag (a plain,
  // non-counter hit only applies knockback — no state change on the
  // target), so this replicates the server's own range+cone hit test
  // (ArenaRoom.checkKicks) purely client-side, just for the SFX/impact-burst
  // cue. Fires at most once per KICKING instance via _kickHitFlags.
  _checkKickHit(kickerId, kicker) {
    if (!this._latestSnapshots) return;
    const halfAngle = Phaser.Math.DegToRad(E_KICK.HALF_ANGLE_DEG);
    for (const [otherId, other] of this._latestSnapshots.entries()) {
      if (otherId === kickerId || !other.isAlive) continue;
      const dist = Math.hypot(kicker.x - other.x, kicker.y - other.y);
      if (dist > E_KICK.RANGE + PLAYER.RADIUS) continue;
      const angleToTarget = Math.atan2(other.y - kicker.y, other.x - kicker.x);
      const diff = Phaser.Math.Angle.Wrap(angleToTarget - kicker.angle);
      if (Math.abs(diff) > halfAngle) continue;

      this._kickHitFlags.set(kickerId, true);
      Sfx.kickHit();
      this.cameras.main.shake(80, 0.0035);
      this._spawnImpactBurst(other.x, other.y, 0xffcc33, { ringR: 22, bits: 4, dist: 20 });
      return;
    }
  }

  // A dash-kill's victim doesn't know who hit it (the schema has no
  // attacker id) — approximate it by finding another player still mid-DASH
  // right next to the death spot (the killer's DASH state persists for a
  // moment after the hit lands, until stepDash resolves the distance/wall).
  _findNearbyDasherAngle(sessionId, snap) {
    if (!this._latestSnapshots) return null;
    for (const [otherId, other] of this._latestSnapshots.entries()) {
      if (otherId === sessionId) continue;
      if (other.state !== STATES.DASH) continue;
      if (Math.hypot(other.x - snap.x, other.y - snap.y) < 90) return other.angle;
    }
    return null;
  }

  // ---- Networking --------------------------------------------------

  // Local dev default: same host as the static page, port 2567 (see
  // nocache_server.py + server/index.js). A real deployment usually puts
  // the Colyseus server on its own host/port (or behind a path on the
  // same domain) — override by setting window.ARENA_SERVER_URL in net.html
  // rather than editing this file. Shared by the lobby's room-list fetch
  // and every join/create path below, so the client only gets created once.
  _ensureClient() {
    if (!this._client) {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const serverUrl = window.ARENA_SERVER_URL || `${proto}://${location.hostname}:2567`;
      this._client = new Colyseus.Client(serverUrl);
      // The vendored colyseus.js build (0.16.x) predates the official SDK's
      // getAvailableRooms() helper, so the lobby's room list is fetched from
      // the server's own plain "/rooms" JSON endpoint (see server/index.js)
      // instead — same ws(s):// URL, just swapped to http(s)://.
      this._serverHttpUrl = serverUrl.replace(/^ws/, "http");
    }
    return this._client;
  }

  // ---- Lobby (room list / create / join) --------------------------

  _openLobby() {
    this.lobbyScreenEl.classList.remove("hidden");
    this._refreshRoomList();
    // Rooms fill up / new ones appear while someone's just sitting on the
    // list — poll rather than requiring a manual refresh every time.
    this._lobbyRefreshTimer = setInterval(() => this._refreshRoomList(), 3000);
  }

  _closeLobby() {
    this.lobbyScreenEl.classList.add("hidden");
    if (this._lobbyRefreshTimer) {
      clearInterval(this._lobbyRefreshTimer);
      this._lobbyRefreshTimer = null;
    }
  }

  async _refreshRoomList() {
    this._ensureClient();
    try {
      const res = await fetch(`${this._serverHttpUrl}/rooms`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rooms = await res.json();
      this.lobbyErrorEl.textContent = "";
      this._renderRoomList(rooms);
    } catch (err) {
      this.lobbyErrorEl.textContent = `방 목록을 불러오지 못했습니다: ${err.message || err}`;
    }
  }

  _renderRoomList(rooms) {
    if (!rooms.length) {
      this.lobbyRoomListEl.innerHTML = '<div class="empty">열린 방이 없습니다. 새로 만들어보세요!</div>';
      return;
    }
    this.lobbyRoomListEl.innerHTML = "";
    for (const room of rooms) {
      const meta = room.metadata || {};
      const name = meta.name || "이름없는 방";
      const mode = meta.mode === "round" ? "ROUND" : "DEATHMATCH";
      const playerCount = meta.playerCount ?? 0;
      const maxPlayers = meta.maxPlayers ?? 4;
      const spectatorCount = meta.spectatorCount ?? 0;
      const full = playerCount >= maxPlayers;

      const row = document.createElement("div");
      row.className = "lobby-room-row";
      row.innerHTML =
        `<div class="info">` +
        `<span class="name">${this._escapeHtml(name)}</span>` +
        `<span class="meta">${mode} · 플레이어 ${playerCount}/${maxPlayers}` +
        `${spectatorCount > 0 ? ` · 관전 ${spectatorCount}` : ""}</span>` +
        `</div>` +
        `<div class="actions">` +
        `<button class="joinBtn primary" ${full ? "disabled" : ""}>${full ? "가득 참" : "입장"}</button>` +
        `<button class="spectateBtn">관전</button>` +
        `</div>`;
      row.querySelector(".joinBtn").onclick = () => this._joinRoom(room.roomId, false);
      row.querySelector(".spectateBtn").onclick = () => this._joinRoom(room.roomId, true);
      this.lobbyRoomListEl.appendChild(row);
    }
  }

  _renderColorSwatches() {
    this.lobbyColorRowEl.innerHTML = "";
    PLAYER_COLORS.forEach((color, i) => {
      const btn = document.createElement("button");
      btn.className = "color-swatch" + (i === this.myColorIndex ? " selected" : "");
      btn.style.background = `#${color.toString(16).padStart(6, "0")}`;
      btn.onclick = () => {
        this.myColorIndex = i;
        localStorage.setItem("itsen_colorIndex", String(i));
        this._renderColorSwatches();
      };
      this.lobbyColorRowEl.appendChild(btn);
    });
  }

  _joinOptions(extra) {
    return { nickname: this.myNickname, colorIndex: this.myColorIndex, ...extra };
  }

  _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  async _quickMatch() {
    try {
      const room = await this._ensureClient().joinOrCreate("arena", this._joinOptions({ spectate: false }));
      this._closeLobby();
      this._wireRoom(room);
    } catch (err) {
      this.lobbyErrorEl.textContent = `입장 실패: ${err.message || err}`;
    }
  }

  async _createRoom() {
    try {
      const name = this.lobbyNameInputEl.value.trim();
      const room = await this._ensureClient().create("arena", this._joinOptions(name ? { name } : {}));
      this._closeLobby();
      this._wireRoom(room);
    } catch (err) {
      this.lobbyErrorEl.textContent = `방 생성 실패: ${err.message || err}`;
    }
  }

  async _joinRoom(roomId, spectate) {
    try {
      const room = await this._ensureClient().joinById(roomId, this._joinOptions({ spectate }));
      this._closeLobby();
      this._wireRoom(room);
    } catch (err) {
      this.lobbyErrorEl.textContent = `입장 실패: ${err.message || err}`;
    }
  }

  // Leaves the current room (consented=true — server skips the reconnect
  // grace and cleans up immediately) and returns to the title screen so the
  // player can rejoin fresh, either as a player or a spectator.
  _leaveMatch() {
    // A consented client.leave() closes with Colyseus's own WS_CLOSE_CONSENTED
    // code (4000), not the plain WS 1000 — room.onLeave still fires
    // asynchronously afterwards, so this flag (rather than trying to
    // recognize that code) is what tells _onRoomLeave() to do nothing.
    this._intentionalLeave = true;
    Sfx.chargeLoopStop();
    if (this.room) this.room.leave(true);
    this.room = null;
    this.mySessionId = null;
    this.isSpectator = false;
    this.connectionError = null;
    for (const fighter of this.fighters.values()) fighter.destroy();
    this.fighters.clear();
    this.predictedSelf = new PredictedSelf();
    this._inputSeq = 0;
    this._pendingInputs = [];
    this._latestSnapshots = new Map();
    this._snapshotBuffers = new Map();
    this._prevSnap.clear();
    this._kickHitFlags.clear();
    this.cameras.main.stopFollow();
    this.cameras.main.setZoom(1);
    document.body.classList.remove("spectating");
    this._openLobby();
  }

  // Attaches schema/lifecycle callbacks to a (re)connected room. Shared by
  // the initial join and every successful reconnect — Colyseus replays
  // onAdd for the whole current player list on reconnect too, so the local
  // render state (fighters, snapshot maps) is wiped first to avoid dupes.
  _wireRoom(room) {
    this.room = room;
    this.mySessionId = room.sessionId;
    this._reconnectionToken = room.reconnectionToken;
    this.connectionError = null;
    // room.state's nested schema fields (players, obstacles, ...) aren't
    // necessarily hydrated the instant joinOrCreate()/reconnect() resolves
    // over a real (non-localhost) connection — the initial full-state patch
    // is a separate, slightly-later message. Reading room.state.players
    // synchronously here crashed on exactly that gap. Default to the
    // spectator look (safe, self-corrects the moment our own PlayerState
    // actually shows up below) instead of inspecting state before it exists.
    this.isSpectator = true;
    document.body.classList.add("spectating");
    this.cameras.main.stopFollow();
    this.cameras.main.setZoom(0.55);
    this.cameras.main.centerOn(ARENA.WIDTH / 2, ARENA.HEIGHT / 2);

    for (const fighter of this.fighters.values()) fighter.destroy();
    this.fighters.clear();
    this.predictedSelf = new PredictedSelf();
    this._inputSeq = 0;
    this._pendingInputs = [];
    // `this._latestSnapshots` MUST exist before any Colyseus callback can
    // fire — onAdd() fires immediately/synchronously for entries that
    // already exist in the state (e.g. our own player, present in the very
    // first state snapshot), so registering callbacks before this map is
    // created threw inside Colyseus's internal callback dispatch.
    this._latestSnapshots = new Map();
    this._snapshotBuffers = new Map(); // sessionId -> [{t, x, y, angle, chargeTime, stunTimer, state, isAlive, score}, ...]
    this._prevSnap.clear();
    this._kickHitFlags.clear();

    const $ = Colyseus.getStateCallbacks(room);
    $(room.state).players.onAdd((player, sessionId) => {
      const fighter = new NetFighter(this, PLAYER_COLORS[player.colorIndex % PLAYER_COLORS.length], player.nickname);
      this.fighters.set(sessionId, fighter);
      this._latestSnapshots.set(sessionId, { ...player });
      this._snapshotBuffers.set(sessionId, []);
      this._pushSnapshot(sessionId, player);
      if (sessionId === this.mySessionId) this.predictedSelf.adopt(player);
      $(player).onChange(() => {
        this._latestSnapshots.set(sessionId, { ...player });
        this._pushSnapshot(sessionId, player);
        if (sessionId === this.mySessionId) this.predictedSelf.reconcile(player, this._pendingInputs);
      });

      if (sessionId === this.mySessionId) {
        // A real PlayerState for our own sessionId means we're an actual
        // player, not a spectator — corrects the safe default set in
        // _wireRoom() the moment the state confirms it either way.
        this.isSpectator = false;
        document.body.classList.remove("spectating");
        // The arena is much bigger than one screen — follow the local
        // player instead of showing the whole map at once.
        this.cameras.main.setZoom(1);
        this.cameras.main.startFollow(fighter.container, true, 0.12, 0.12);
      }
    });
    $(room.state).players.onRemove((player, sessionId) => {
      const fighter = this.fighters.get(sessionId);
      if (fighter) fighter.destroy();
      this.fighters.delete(sessionId);
      this._latestSnapshots.delete(sessionId);
      this._snapshotBuffers.delete(sessionId);
      this._prevSnap.delete(sessionId);
      this._kickHitFlags.delete(sessionId);
    });

    room.onLeave((code) => this._onRoomLeave(code));
  }

  // A leave the player asked for (the "나가기" button) needs no reconnect —
  // see the _intentionalLeave flag set in _leaveMatch(). Anything else is an
  // unexpected drop — dead wifi, a mobile browser backgrounding the tab,
  // etc. — worth retrying against the server's own RECONNECT_GRACE_SEC
  // window (20s).
  async _onRoomLeave(code) {
    if (this._intentionalLeave) {
      this._intentionalLeave = false;
      return;
    }

    // If the drop happens mid-charge, the frozen last snapshot never shows
    // a state transition again while disconnected, so nothing would
    // otherwise stop the continuous charge-loop sound — cut it immediately
    // rather than leaving it looping through the whole retry window (or
    // forever, if reconnection ultimately fails).
    Sfx.chargeLoopStop();

    const token = this._reconnectionToken;
    if (!token) {
      this.connectionError = "서버와 연결이 끊어졌습니다.";
      return;
    }

    const delaysMs = [500, 2500, 3000, 3000, 3000, 3000];
    for (const delay of delaysMs) {
      this.connectionError = "연결이 끊어졌습니다. 재접속 중...";
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const room = await this._client.reconnect(token);
        this._wireRoom(room);
        return;
      } catch (e) {
        // keep retrying until the delay budget above runs out
      }
    }
    this.connectionError = "재접속에 실패했습니다. 새로고침 해주세요.";
  }

  // Appends a timestamped sample to sessionId's interpolation buffer (see
  // RENDER_DELAY_MS / _getInterpolatedSnapshot) and trims anything older
  // than the render window needs — otherwise these would grow for the
  // entire match.
  _pushSnapshot(sessionId, player) {
    const buf = this._snapshotBuffers.get(sessionId);
    if (!buf) return;
    const entry = {
      t: performance.now(),
      x: player.x,
      y: player.y,
      angle: player.angle,
      chargeTime: player.chargeTime,
      stunTimer: player.stunTimer,
      state: player.state,
      isAlive: player.isAlive,
      score: player.score,
    };
    buf.push(entry);
    const cutoff = entry.t - 1000;
    while (buf.length > 2 && buf[0].t < cutoff) buf.shift();
  }

  // Reconstructs what sessionId's state looked like at renderTime by
  // interpolating between the two buffered snapshots straddling it (falling
  // back to the nearest edge sample if renderTime is outside the buffered
  // range, e.g. right after joining or during a connection hiccup). Position/
  // angle/charge/stun are numeric-lerped; state/isAlive/score are step
  // values so they're taken from the earlier of the two samples — a state
  // transition should appear to happen exactly when its sample says it did,
  // not partway through.
  _getInterpolatedSnapshot(sessionId, renderTime) {
    const buf = this._snapshotBuffers.get(sessionId);
    if (!buf || buf.length === 0) return null;
    if (buf.length === 1 || renderTime <= buf[0].t) return buf[0];
    const last = buf[buf.length - 1];
    if (renderTime >= last.t) return last;

    for (let i = 0; i < buf.length - 1; i++) {
      const a = buf[i];
      const b = buf[i + 1];
      if (renderTime > b.t) continue;
      const span = b.t - a.t;
      const t = span > 0 ? (renderTime - a.t) / span : 1;
      return {
        x: Phaser.Math.Linear(a.x, b.x, t),
        y: Phaser.Math.Linear(a.y, b.y, t),
        angle: a.angle + Phaser.Math.Angle.Wrap(b.angle - a.angle) * t,
        chargeTime: Phaser.Math.Linear(a.chargeTime, b.chargeTime, t),
        stunTimer: Phaser.Math.Linear(a.stunTimer, b.stunTimer, t),
        state: a.state,
        isAlive: a.isAlive,
        score: a.score,
      };
    }
    return last;
  }

  // Obstacles/pits/quicksand are all fixed for the room's whole lifetime
  // (generated once, server-side) — each is built exactly once, the first
  // time its list shows up in room.state, then never touched again.
  _syncHazardsFromRoom() {
    const st = this.room.state;
    // Right after join, over a real (non-localhost) connection, a frame or
    // two can tick before the initial full-state patch finishes decoding —
    // these ArraySchema fields exist from the very first synced state, but
    // guard the gap anyway rather than crashing the whole update() loop
    // (which would otherwise also block per-frame fighter sync/HUD/input).
    if (!st.obstacles || !st.pits || !st.quicksand) return;

    // A non-zero length isn't proof the array has fully arrived — on some
    // connections the initial sync's ArraySchema entries were observed
    // trickling in across a couple of frames rather than landing atomically,
    // which built a room's hazard art from a partial list (some players'
    // pits/obstacles were missing or in the wrong place vs. the always-full
    // list the server actually checks collision against). Requiring the
    // count to hold steady across two consecutive frames before building is
    // cheap insurance against that — these lists never change once complete,
    // so waiting one extra frame is invisible either way.
    const obstacleCount = st.obstacles.length;
    const pitCount = st.pits.length;
    const quicksandCount = st.quicksand.length;

    if (!this.obstaclesBuilt && obstacleCount > 0 && obstacleCount === this._lastObstacleCount) {
      this._buildObstacleArt(st.obstacles);
    }
    if (!this.pitsBuilt && pitCount > 0 && pitCount === this._lastPitCount) {
      this._buildPits(st.pits.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })));
    }
    if (!this.quicksandBuilt && quicksandCount > 0 && quicksandCount === this._lastQuicksandCount) {
      this._buildQuicksandPatches(st.quicksand.map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h })));
    }

    this._lastObstacleCount = obstacleCount;
    this._lastPitCount = pitCount;
    this._lastQuicksandCount = quicksandCount;
  }

  update(time, delta) {
    // Brief full-freeze on big impacts (kill, successful parry-stun,
    // counter-kick) — matches ArenaScene's hitstopMs.
    if (this.hitstopMs > 0) {
      this.hitstopMs -= delta;
      this._updateHud();
      this._updateMatchUI();
      return;
    }

    if (this.room) this._syncHazardsFromRoom();

    // Local input + client-side prediction, computed and stepped BEFORE the
    // render loop below so this frame's own action is reflected immediately
    // instead of a frame late. See PredictedSelf.js for what's predicted.
    if (this.room && !this.isSpectator) {
      const lx = this.predictedSelf.ready ? this.predictedSelf.x : ARENA.WIDTH / 2;
      const ly = this.predictedSelf.ready ? this.predictedSelf.y : ARENA.HEIGHT / 2;

      let aimAngle;
      let wantsMove;
      if (this.touch.joystick.active) {
        aimAngle = this.touch.joystick.angle;
        wantsMove = this.touch.joystick.magnitude > 0.15; // deadzone
      } else {
        const pointer = this.input.activePointer;
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        aimAngle = Phaser.Math.Angle.Between(lx, ly, worldPoint.x, worldPoint.y);
        wantsMove = this.pointerDown;
      }

      const touchW = this.touch.consumeWTap();
      const touchE = this.touch.consumeETap();

      this._inputSeq += 1;
      const localInput = {
        seq: this._inputSeq,
        wantsMove,
        aimAngle,
        qHeld: this.qKey.isDown || this.touch.qHeld,
        wPressed: this.wPressedFlag || touchW,
        ePressed: this.ePressedFlag || touchE,
      };

      const canAct = this.room.state.matchPhase === "live";
      const hazards = { obstacles: this.room.state.obstacles, quicksand: this.room.state.quicksand };
      this.predictedSelf.step(delta, localInput, canAct, hazards);
      // Kept until reconcile() sees a snapshot confirming the server has
      // processed this seq — see PredictedSelf.reconcile()'s replay. Capped
      // as a safety net against unbounded growth if the connection stalls.
      this._pendingInputs.push({ seq: this._inputSeq, dtMs: delta, input: localInput, canAct, hazards });
      if (this._pendingInputs.length > 600) this._pendingInputs.shift();

      this.room.send("input", localInput);
      this.wPressedFlag = false;
      this.ePressedFlag = false;
    }

    if (this._latestSnapshots) {
      const renderTime = performance.now() - RENDER_DELAY_MS;
      for (const [sessionId, fighter] of this.fighters.entries()) {
        // The interpolation buffer trades latency for smoothness — worth it
        // for *other* players (their input timing isn't ours to control
        // anyway). The local player instead renders from PredictedSelf,
        // stepped above from this very frame's input rather than waiting a
        // network round trip to see anything happen.
        const snap =
          sessionId === this.mySessionId && this.predictedSelf.ready
            ? this.predictedSelf
            : this._getInterpolatedSnapshot(sessionId, renderTime);
        if (!snap) continue;
        this._detectFighterEvents(sessionId, snap);
        fighter.sync(snap, delta);
      }
    }

    this._updateHud();
    this._updateMatchUI();
  }

  _updateHud() {
    if (!this.hud) return;
    if (this.connectionError) {
      this.hud.textContent = this.connectionError;
      return;
    }
    if (!this.room) {
      this.hud.textContent = "서버에 연결하는 중...";
      return;
    }

    if (!this.room.state.players) return; // initial state patch hasn't arrived yet

    if (this.isSpectator) {
      const playerCount = this.room.state.players.size;
      this.hud.textContent =
        `👁 관전 중 (전투에 관여하지 않음)\n` +
        `방: ${this.room.roomId}\n` +
        `플레이어: ${playerCount}/4   관전자: ${this.room.state.spectatorCount}`;
      return;
    }

    const local = this._latestSnapshots && this._latestSnapshots.get(this.mySessionId);
    const others = this._latestSnapshots
      ? [...this._latestSnapshots.entries()].filter(([id]) => id !== this.mySessionId)
      : [];
    const oppText = others.length
      ? others.map(([, p]) => p.state).join(", ")
      : "상대 대기 중... (다른 브라우저 탭/창에서 net.html을 열어보세요)";

    this.hud.textContent =
      `L-Click Hold: 이동 (마우스 방향)   Q: 발도술   W: 반격자세   E: 발차기\n` +
      `방: ${this.room.roomId}\n` +
      `나: ${local ? local.state : "-"}\n` +
      `상대: ${oppText}`;
  }

  // "YOU" for the local player, "P1".."P4" (by seat/colorIndex) for anyone
  // else — used for the deathmatch "+1" flash and the scoreboard list.
  _playerLabel(sessionId) {
    if (sessionId === this.mySessionId) return "YOU";
    const p = this.room && this.room.state.players && this.room.state.players.get(sessionId);
    return p ? p.nickname || `P${p.colorIndex + 1}` : "?";
  }

  // Renders the shared, server-authoritative match state (room.state.mode/
  // matchPhase/phaseTimer/winnerId) — scoreboard and the 3-2-1-FIGHT!/
  // WIN-LOSE-DRAW banner. Mirrors the single-player ArenaScene's
  // _checkRoundEnd/_flashKillText, just driven by room state instead of
  // local combatant bookkeeping.
  _updateMatchUI() {
    if (!this.room) return;
    const st = this.room.state;
    if (!st.players) return; // initial state patch hasn't arrived yet

    // Local player's own entry first, then the rest sorted by seat index —
    // stable ordering so the list doesn't reshuffle every frame.
    const entries = [...st.players.entries()].sort(([idA, a], [idB, b]) => {
      if (idA === this.mySessionId) return -1;
      if (idB === this.mySessionId) return 1;
      return a.colorIndex - b.colorIndex;
    });
    this.scoreListEl.innerHTML = entries
      .map(
        ([id, p], i) =>
          (i > 0 ? '<span class="sep">·</span>' : "") +
          `<span class="entry${id === this.mySessionId ? " me" : ""}">` +
          `<span class="label">${this._playerLabel(id)}</span>` +
          `<span class="score">${p.score}</span></span>`
      )
      .join("");

    if (this._killFlashUntil > this.time.now) {
      this._showRoundBanner(this._killFlashText);
      return;
    }

    if (st.matchPhase === "waiting") {
      this._showRoundBanner(`다른 플레이어를 기다리는 중... (${st.players.size}/4)`);
    } else if (st.matchPhase === "countdown") {
      const elapsed = NET_COUNTDOWN_MS - st.phaseTimer;
      const step = NET_COUNTDOWN_MS / 4;
      const idx = Phaser.Math.Clamp(Math.floor(elapsed / step), 0, 3);
      this._showRoundBanner(["3", "2", "1", "FIGHT!"][idx]);
    } else if (st.matchPhase === "roundEnd") {
      const text = !st.winnerId ? "DRAW" : st.winnerId === this.mySessionId ? "YOU WIN" : "YOU LOSE";
      this._showRoundBanner(text);
    } else if (st.matchPhase === "matchEnd") {
      this._showRoundBanner(`🏆 ${this._playerLabel(st.winnerId)} WINS THE MATCH!`);
    } else {
      this._hideRoundBanner();
    }
  }

  _showRoundBanner(text) {
    if (!this.roundBannerEl) return;
    this.roundBannerEl.textContent = text;
    this.roundBannerEl.classList.add("show");
  }

  _hideRoundBanner() {
    if (!this.roundBannerEl) return;
    this.roundBannerEl.classList.remove("show");
  }
}
