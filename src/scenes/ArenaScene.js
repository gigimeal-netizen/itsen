import {
  ARENA,
  STATES,
  E_KICK,
  Q_DASH,
  GLOBAL_COOLDOWN_MS,
  RING_OUT_MARGIN,
  FLOOR_CORNER_CUT,
  ROUND_BANNER_MS,
} from "../config/constants.js";
import { generateSymmetricLayout } from "../config/layoutGenerator.js";
import Player from "../entities/Player.js";
import Dummy from "../entities/Dummy.js";
import Sfx from "../audio/Sfx.js";

export default class ArenaScene extends Phaser.Scene {
  constructor() {
    super("ArenaScene");
  }

  preload() {
    this.load.audio("qCharging", "q_charging.wav");
    this.load.audio("qActive", "q_active.mp3");
    this.load.audio("kick", "kicksound.mp3");
    this.load.audio("kill", "kill.mp3");
    this.load.audio("shieldOn", "shield_on.mp3");
    this.load.audio("parry", "parry.mp3");
    this.load.audio("wSuccess", "Wsucces.mp3");
    this.load.audio("terrainAppear", "sand_appear_sound.mp3");

    this.load.image("arenaVoid", "arena_void.png");
    this.load.image("arenaTile", "arena_tile.png");
    this.load.image("arenaObs", "arena_obs.png");
  }

  create() {
    this.cameras.main.setBackgroundColor("#0d0b08");
    this._buildArenaFloor();
    this.physics.world.setBounds(0, 0, ARENA.WIDTH, ARENA.HEIGHT);

    this.walls = this.physics.add.staticGroup();
    this._buildObstacles();
    this._buildHazards();

    this.player = new Player(this, ARENA.WIDTH * 0.25, ARENA.HEIGHT / 2);
    this.dummy = new Dummy(this, ARENA.WIDTH * 0.75, ARENA.HEIGHT / 2);
    this.combatants = [this.player, this.dummy];
    // Held locked behind the title screen until the player hits "시작하기" —
    // see the titleScreen wiring at the end of create().
    this.player.locked = true;
    this.dummy.locked = true;

    // The arena is much bigger than one screen on purpose — the camera
    // follows the local player instead of showing the whole map at once.
    this.cameras.main.setBounds(0, 0, ARENA.WIDTH, ARENA.HEIGHT);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);

    this.physics.add.collider(this.player, this.walls, (obj) => obj.stopDashOnWall());
    this.physics.add.collider(this.dummy, this.walls, (obj) => obj.stopDashOnWall());
    this.physics.add.collider(this.player, this.dummy, null, (a, b) => this._shouldBodyBlock(a, b));

    this.mode = "round"; // "round" | "deathmatch"
    this.score = { player: 0, dummy: 0 };
    this.roundOver = false;
    this.roundBannerEl = document.getElementById("roundBanner");
    this.scoreYouEl = document.getElementById("scoreYou");
    this.scoreDummyEl = document.getElementById("scoreDummy");
    this.modeRoundBtn = document.getElementById("modeRoundBtn");
    this.modeDeathmatchBtn = document.getElementById("modeDeathmatchBtn");
    this.modeRoundBtn.onclick = () => this._setMode("round");
    this.modeDeathmatchBtn.onclick = () => this._setMode("deathmatch");
    this._updateModeButtons();

    this.hud = document.getElementById("hud");
    this.skillFills = {
      Q: document.getElementById("fillQ"),
      W: document.getElementById("fillW"),
      E: document.getElementById("fillE"),
    };
    this.skillSlots = {
      Q: document.getElementById("slotQ"),
      W: document.getElementById("slotW"),
      E: document.getElementById("slotE"),
    };

    Sfx.attachScene(this);
    // AudioContext can't start until a user gesture; unlock on the first one.
    const unlockAudio = () => Sfx.init();
    this.input.once("pointerdown", unlockAudio);
    this.input.keyboard.once("keydown", unlockAudio);

    this.hitstopMs = 0; // brief full-freeze on big impacts (kill/parry/counter-kick)

    const titleScreen = document.getElementById("titleScreen");
    document.getElementById("startBtn").onclick = () => {
      titleScreen.classList.add("hidden");
      unlockAudio();
      this._startCountdown();
    };
  }

  // Switches between ROUND (freeze + banner + reset-both after each death)
  // and DEATHMATCH (continuous — the loser respawns solo, no freeze) modes.
  // Always resets the score and gives both combatants a clean restart.
  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.score = { player: 0, dummy: 0 };
    this.scoreYouEl.textContent = 0;
    this.scoreDummyEl.textContent = 0;
    this.roundOver = false;
    this._hideRoundBanner();
    this._updateModeButtons();
    this.player.respawn();
    this.dummy.respawn();
    this._startCountdown();
  }

  _updateModeButtons() {
    this.modeRoundBtn.classList.toggle("active", this.mode === "round");
    this.modeDeathmatchBtn.classList.toggle("active", this.mode === "deathmatch");
  }

  // Locks both combatants, plays a 3-2-1-FIGHT banner sequence, then unlocks.
  // Runs at the very first game start, before every ROUND-mode round, and
  // right after a mode switch.
  _startCountdown() {
    this.player.locked = true;
    this.dummy.locked = true;
    const steps = ["3", "2", "1", "FIGHT!"];
    let i = 0;
    const showNext = () => {
      this._showRoundBanner(steps[i]);
      i++;
      if (i < steps.length) {
        this.time.delayedCall(650, showNext);
      } else {
        this.time.delayedCall(450, () => {
          this._hideRoundBanner();
          this.player.locked = false;
          this.dummy.locked = false;
        });
      }
    };
    showNext();
  }

  // The playable floor is inset from the full canvas by RING_OUT_MARGIN —
  // that margin is the void. Physics world bounds stay at the FULL canvas so
  // knockback/dash can carry a combatant out past the floor edge before the
  // ring-out check (see _checkHazardDeaths) kills them.
  //
  // Ruins arena shell: the floor is an octagon (chamfered-corner rectangle),
  // not a plain box — the four cut corners read as collapsed-away chunks of
  // the ruin. Real art for the void (rubble debris field) and the playable
  // floor (cracked, moss-grown stone), masked to that octagon, with a worn
  // amber warning line traced along the actual ring-out edge.
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
    this.floorPolygon = new Phaser.Geom.Polygon(this.floorPolyPoints);

    this.add
      .tileSprite(ARENA.WIDTH / 2, ARENA.HEIGHT / 2, ARENA.WIDTH, ARENA.HEIGHT, "arenaVoid")
      .setDepth(-13);

    const floorTile = this.add
      .tileSprite(f.x + f.w / 2, f.y + f.h / 2, f.w, f.h, "arenaTile")
      .setDepth(-10);
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

  // Pits and quicksand are both permanent for the whole match (generated
  // once, symmetrically, as part of the layout — see _buildObstacles) —
  // drawn once here and never cycled.
  _buildHazards() {
    this.quicksandGfx = this.add.graphics().setDepth(-7);
    this.quicksandPatches = this.quicksandRects.map((q) => this._makeQuicksandPatch(q));
    this._drawQuicksand();

    this._buildPits();
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

  // 낙사 구멍: permanent for the whole match, generated symmetrically as
  // part of the layout (see _buildObstacles). The hole shows the actual
  // void art through it (masked tileSprite aligned to the same world
  // coords as the backdrop) instead of a flat black fill, plus a dark rim
  // + radiating cracks to sell the depth — so it reads as "the floor gave
  // way to the abyss below", not a smudge or a mechanical trapdoor.
  _buildPits() {
    this.pitGfx = this.add.graphics().setDepth(-6);
    this.pitDecor = this.pits.map((p) => this._makePitDecor(p));
    this._drawPitDecor();
  }

  _makePitDecor(p) {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    const rx = (p.w / 2) * 1.1;
    const ry = (p.h / 2) * 1.1;
    const harmonics = [
      { amp: 0.16, freq: 3, phase: Math.random() * Math.PI * 2 },
      { amp: 0.1, freq: 5, phase: Math.random() * Math.PI * 2 },
    ];
    const blob = this._blobPoints(cx, cy, rx, ry, harmonics);

    // A window straight through to the void art already tiled at world
    // scale — tilePosition is set to this pit's own world coords so the
    // pattern lines up seamlessly with the big backdrop tileSprite.
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

  // A handful of jagged lines radiating from center to the rim, reused every
  // frame for one pit so the crack pattern doesn't reshuffle mid-animation.
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

  // Smooth organic blob outline (sum of a few sine harmonics at random phase/
  // amplitude, not per-point jitter) so terrain reads as a puddle/swamp
  // edge instead of a jagged blob or a bare rectangle.
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

  // Redrawn once (called from _buildHazards): draws every permanent
  // quicksand patch — no fade in/out, always fully visible.
  _drawQuicksand() {
    this.quicksandGfx.clear();
    for (const q of this.quicksandPatches) {
      const cx = q.x + q.w / 2;
      const cy = q.y + q.h / 2;
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

  // Spawns a permanent set of looping bubble particles for one quicksand
  // patch (called once, at patch creation).
  _spawnQuicksandBubbles(patch) {
    const cx = patch.x + patch.w / 2;
    const cy = patch.y + patch.h / 2;
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

  _inZone(c, zone) {
    return c.x >= zone.x && c.x <= zone.x + zone.w && c.y >= zone.y && c.y <= zone.y + zone.h;
  }

  // Pits are permanent and always lethal (a Q dash still passes safely
  // over one, same as before).
  _checkHazardDeaths() {
    for (const c of this.combatants) {
      if (!c.isAlive) continue;
      if (!Phaser.Geom.Polygon.Contains(this.floorPolygon, c.x, c.y)) {
        c.dieFromHazard();
        continue;
      }
      if (c.state !== STATES.DASH) {
        for (const p of this.pits) {
          if (this._inZone(c, p)) {
            c.dieFromHazard();
            break;
          }
        }
      }
    }
  }

  // A fresh point-symmetric layout every game (see layoutGenerator.js) —
  // whatever cover/hazard sits near one spawn, its mirror sits near the
  // other, so neither side gets a positional edge even though the exact
  // shapes are randomized each match.
  _buildObstacles() {
    const layout = generateSymmetricLayout();
    this.obstacles = layout.obstacles;
    this.pits = layout.pits;
    this.quicksandRects = layout.quicksand;
    for (const o of this.obstacles) this._addObstacle(o.x, o.y, o.w, o.h);
  }

  _addObstacle(x, y, w, h) {
    const rect = this.add.rectangle(x, y, w, h, 0x000000, 0);
    this.physics.add.existing(rect, true); // static body
    this.walls.add(rect);

    // arena_obs.png is a clean, tightly-cropped standalone pillar sprite
    // (326x968 native). Scale by height so it always covers the collider's
    // full height; the resulting width comes out wider than the hitbox,
    // which reads fine as rubble/base overhang rather than a gap.
    const OBS_ASPECT = 326 / 968;
    const artH = h * 1.05;
    const artW = artH * OBS_ASPECT;
    this.add.image(x, y, "arenaObs").setDisplaySize(artW, artH).setDepth(0);
  }

  _shouldBodyBlock(a, b) {
    if (!a.isAlive || !b.isAlive) return false;
    if (a.state === STATES.DASH || b.state === STATES.DASH) return false;
    return true;
  }

  // Brief hard freeze on big impacts (kill, successful parry, counter-kick)
  // reads as much punchier than a shake alone — everything (physics, poses,
  // hazards) holds for a beat before the hit's motion actually resolves.
  _spawnImpactBurst(x, y, color = 0xffffff, { ringR = 26, bits = 5, dist = 30 } = {}) {
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

  update(time, delta) {
    if (this.hitstopMs > 0) {
      this.hitstopMs -= delta;
      this._updateHud();
      return;
    }

    // Quicksand/pits are permanent — only the slow-zone check needs to run
    // each frame, and only once a round is actually live (not behind the
    // title screen, the 3-2-1 countdown, or the round-end freeze, all of
    // which hold both combatants `locked`).
    const isLive = !this.player.locked && !this.dummy.locked;
    for (const c of this.combatants) {
      c.inSlowZone = c.isAlive && isLive && this.quicksandPatches.some((q) => this._inZone(c, q));
    }

    const prevPAlive = this.player.isAlive;
    const prevDAlive = this.dummy.isAlive;
    for (const c of this.combatants) c.update(delta);

    this._checkDashHits();
    this._checkKicks();
    this._checkHazardDeaths();

    if (this.mode === "round") this._checkRoundEnd();
    else this._checkDeathmatchScoring(prevPAlive, prevDAlive);

    this._updateHud();
  }

  // ROUND mode: a round ends the instant either side dies (sword kill or
  // hazard death). The loser's own auto-respawn is put on hold so it can't
  // quietly pop back in mid-banner; both combatants are reset together and
  // a fresh 3-2-1 countdown runs before the next round opens up.
  _checkRoundEnd() {
    if (this.roundOver) return;
    const pAlive = this.player.isAlive;
    const dAlive = this.dummy.isAlive;
    if (pAlive && dAlive) return;

    this.roundOver = true;
    this.player.locked = true;
    this.dummy.locked = true;
    if (!pAlive) this.player._respawnClock = Infinity;
    if (!dAlive) this.dummy._respawnClock = Infinity;

    let text;
    if (pAlive && !dAlive) {
      this.score.player++;
      text = "YOU WIN";
    } else if (dAlive && !pAlive) {
      this.score.dummy++;
      text = "YOU LOSE";
    } else {
      text = "DRAW";
    }
    this._showRoundBanner(text);
    this.scoreYouEl.textContent = this.score.player;
    this.scoreDummyEl.textContent = this.score.dummy;

    this.time.delayedCall(ROUND_BANNER_MS, () => {
      this.player.respawn();
      this.dummy.respawn();
      this.roundOver = false;
      this._startCountdown();
    });
  }

  // DEATHMATCH mode: no freeze, no reset-both — the loser respawns solo via
  // Combatant's own auto-respawn timer while the winner keeps playing.
  // Score is tallied by watching for an alive->dead transition each frame.
  _checkDeathmatchScoring(prevPAlive, prevDAlive) {
    if (prevPAlive && !this.player.isAlive && this.dummy.isAlive) {
      this.score.dummy++;
      this._flashKillText("DUMMY +1");
    } else if (prevDAlive && !this.dummy.isAlive && this.player.isAlive) {
      this.score.player++;
      this._flashKillText("YOU +1");
    } else {
      return;
    }
    this.scoreYouEl.textContent = this.score.player;
    this.scoreDummyEl.textContent = this.score.dummy;
  }

  _flashKillText(text) {
    this._showRoundBanner(text);
    this.time.delayedCall(700, () => this._hideRoundBanner());
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

  _checkDashHits() {
    for (const dasher of this.combatants) {
      if (dasher.state !== STATES.DASH) continue;
      for (const other of this.combatants) {
        if (other === dasher || !other.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(dasher.x, dasher.y, other.x, other.y);
        if (dist > dasher.radius + other.radius) continue;

        if (other.state === STATES.PARRYING) {
          if (other.parrySuccess()) {
            dasher.selfStunFromParry();
            this._spawnImpactBurst(other.x, other.y, 0x7ff0ff, { ringR: 42, bits: 8, dist: 42 });
            this.cameras.main.shake(90, 0.005);
            this.hitstopMs = 70;
          }
        } else {
          other.kill(dasher.facing);
          dasher.markDashKill();
          this.hitstopMs = 90;
        }
      }
    }
  }

  _checkKicks() {
    const halfAngle = Phaser.Math.DegToRad(E_KICK.HALF_ANGLE_DEG);
    for (const kicker of this.combatants) {
      if (!kicker.isKickActive) continue;
      for (const target of this.combatants) {
        if (target === kicker || !target.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(kicker.x, kicker.y, target.x, target.y);
        if (dist > E_KICK.RANGE + target.radius) continue;
        const angleToTarget = Phaser.Math.Angle.Between(kicker.x, kicker.y, target.x, target.y);
        const diff = Phaser.Math.Angle.Wrap(angleToTarget - kicker.facing);
        if (Math.abs(diff) > halfAngle) continue;

        // Only kicking through a parry (E beating W) stuns; a plain hit on
        // anyone else is knockback-only per the requested balance change.
        const counteredParry = target.state === STATES.PARRYING;
        if (counteredParry) target.applyStun(E_KICK.STUN_MS);
        target.applyKnockback(kicker.facing, E_KICK.KNOCKBACK_DISTANCE, E_KICK.KNOCKBACK_SPEED);
        kicker.markKickApplied(counteredParry);

        if (counteredParry) {
          this._spawnImpactBurst(target.x, target.y, 0xff5c5c, { ringR: 36, bits: 8, dist: 36 });
          this.hitstopMs = 80;
        } else {
          this._spawnImpactBurst(target.x, target.y, 0xffcc33, { ringR: 22, bits: 4, dist: 20 });
          this.hitstopMs = 40;
        }
      }
    }
  }

  _updateHud() {
    if (!this.hud) return;
    const p = this.player;
    this.hud.textContent =
      `L-Click Hold: 이동 (커서 방향)   Q: 발도술(홀드/릴리즈)   W: 반격자세   E: 발차기\n` +
      `Player: ${p.state}${p.state === STATES.CHARGING ? ` (${(p.chargeTime / 1000).toFixed(2)}s)` : ""}  alive=${p.isAlive}\n` +
      `Dummy:  ${this.dummy.state}  alive=${this.dummy.isAlive}`;

    this._updateSkillBar(p);
  }

  _updateSkillBar(p) {
    if (!this.skillFills) return;
    const gcdTotal = p._gcdTotalMs || GLOBAL_COOLDOWN_MS;
    const gcdPct = p.state === STATES.GCD ? 100 - (p.stateTimer / gcdTotal) * 100 : 100;
    const stunned = p.state === STATES.STUNNED;
    const READY = { pct: 100, color: "#3ddc84", active: false };
    const GCD_FILL = { pct: gcdPct, color: "#5a6478", active: false };
    const STUN_FILL = { pct: 100, color: "#ff5c5c", active: true };

    const specs = {
      Q: stunned
        ? STUN_FILL
        : p.state === STATES.CHARGING
        ? { pct: (p.chargeTime / Q_DASH.MAX_CHARGE_MS) * 100, color: "#ff9f43", active: true }
        : p.state === STATES.DASH
        ? { pct: 100, color: "#ff9f43", active: true }
        : p.state === STATES.GCD
        ? GCD_FILL
        : READY,
      W: stunned
        ? STUN_FILL
        : p.state === STATES.PARRYING
        ? { pct: 100, color: "#7ff0ff", active: true }
        : p.state === STATES.GCD
        ? GCD_FILL
        : READY,
      E: stunned
        ? STUN_FILL
        : p.state === STATES.KICKING
        ? { pct: 100, color: "#ffcc33", active: true }
        : p.state === STATES.GCD
        ? GCD_FILL
        : READY,
    };

    for (const key of ["Q", "W", "E"]) {
      const { pct, color, active } = specs[key];
      this.skillFills[key].style.height = `${pct}%`;
      this.skillFills[key].style.backgroundColor = color;
      this.skillSlots[key].style.color = color;
      this.skillSlots[key].classList.toggle("active", active);
    }
  }
}
