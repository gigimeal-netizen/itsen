import {
  ARENA,
  STATES,
  GLOBAL_COOLDOWN_MS,
  RING_OUT_MARGIN,
  FLOOR_CORNER_CUT,
  ROUND_BANNER_MS,
  DEFAULT_CLASS_ID,
} from "../config/constants.js";
import { generateSymmetricLayout } from "../config/layoutGenerator.js";
import Player from "../entities/Player.js";
import Dummy from "../entities/Dummy.js";
import Sfx from "../audio/Sfx.js";

// Q/W/E display info for the title screen's skill panel (see
// _renderSkillPanel()) — hand-duplicated copy of NetArenaScene.js's
// identically-named table (src/CLAUDE.md's no-shared-base-class convention).
// icon/name/short description per skill, plus the pre-built "Q beats W, W
// beats E, E beats Q" triangle-hint sentence for that class.
const CLASS_SKILL_INFO = {
  swordsman: {
    q: { icon: "🗡️", name: "발도술", desc: "홀드해서 차지 → 떼면 돌진, 닿으면 즉사" },
    w: { icon: "🛡️", name: "반격자세", desc: "0.5초간 무적 — 돌진 공격을 받아치면 상대 기절" },
    e: { icon: "🦵", name: "발차기", desc: "근접 타격 — 넉백, 반격 자세를 뚫으면 기절까지" },
    triangleHtml:
      '<span class="c-q">발도술</span>은 <span class="c-w">반격자세</span>에 꺾이고 · ' +
      '<span class="c-w">반격자세</span>는 <span class="c-e">발차기</span>에 뚫리며 · ' +
      '<span class="c-e">발차기</span>는 <span class="c-q">발도술</span> 앞에 무너진다',
  },
  knight: {
    q: { icon: "⚔️", name: "연속돌진", desc: "탭 한 번에 고정 거리 돌진 — 명중하면 Q/W/E로 콤보 이어가기" },
    w: { icon: "🛡️", name: "방패방어", desc: "홀드하는 동안 방어, 이동속도 감소 — 막아내면 다음 Q 강화" },
    e: { icon: "🔰", name: "방패돌진", desc: "짧은 돌진 타격 — 넉백, 방어 자세를 뚫으면 기절까지" },
    triangleHtml:
      '<span class="c-q">연속돌진</span>은 <span class="c-w">방패방어</span>에 꺾이고 · ' +
      '<span class="c-w">방패방어</span>는 <span class="c-e">방패돌진</span>에 뚫리며 · ' +
      '<span class="c-e">방패돌진</span>은 <span class="c-q">연속돌진</span> 앞에 무너진다',
  },
  warrior: {
    q: { icon: "🪓", name: "도끼일격", desc: "제자리에서 360도 베기, 닿으면 즉사" },
    w: { icon: "📢", name: "전투함성", desc: "0.5초간 무적, 직후 주변 적의 스킬을 봉인" },
    e: { icon: "💥", name: "도약강타", desc: "홀드해서 차지 → 떼면 도약, 착지 충격 — 방어 자세를 뚫으면 기절" },
    triangleHtml:
      '<span class="c-q">도끼일격</span>은 <span class="c-w">전투함성</span>에 꺾이고 · ' +
      '<span class="c-w">전투함성</span>은 <span class="c-e">도약강타</span>에 뚫리며 · ' +
      '<span class="c-e">도약강타</span>는 <span class="c-q">도끼일격</span> 앞에 무너진다',
  },
  mage: {
    q: { icon: "⚡", name: "마력광선", desc: "홀드해서 차지 → 떼면 광선 발사, 닿으면 즉사" },
    w: { icon: "💧", name: "유체화", desc: "0.5초간 무적, 직후 1초간 이동속도 증가" },
    e: { icon: "❄️", name: "눈보라", desc: "부채꼴 범위 공격 — 둔화, 방어/무적 상대는 빙결" },
    triangleHtml:
      '<span class="c-q">마력광선</span>은 <span class="c-w">유체화</span>에 꺾이고 · ' +
      '<span class="c-w">유체화</span>는 <span class="c-e">눈보라</span>에 뚫리며 · ' +
      '<span class="c-e">눈보라</span>는 <span class="c-q">마력광선</span> 앞에 무너진다',
  },
};

export default class ArenaScene extends Phaser.Scene {
  constructor() {
    super("ArenaScene");
  }

  preload() {
    this.load.audio("qCharging", "assets/audio/q_charging.wav");
    this.load.audio("qActive", "assets/audio/q_active.mp3");
    this.load.audio("kick", "assets/audio/kicksound.mp3");
    this.load.audio("kill", "assets/audio/kill.mp3");
    this.load.audio("shieldOn", "assets/audio/shield_on.mp3");
    this.load.audio("parry", "assets/audio/parry.mp3");
    this.load.audio("wSuccess", "assets/audio/Wsucces.mp3");
    this.load.audio("terrainAppear", "assets/audio/sand_appear_sound.mp3");

    // Knight (기사) — see Sfx.js's comboDashRelease/shieldRaise/shieldChargeRelease/
    // comboSwing/comboHit/empoweredQRelease.
    this.load.audio("knightQ1", "assets/audio/knight_Q1.mp3");
    this.load.audio("knightQ2", "assets/audio/knight_Q2.mp3");
    this.load.audio("knightQSwoosh", "assets/audio/knight_Q_swoosh.mp3");
    this.load.audio("knightPowerdQ", "assets/audio/knight_powerdQ.mp3");
    this.load.audio("knightE", "assets/audio/knight_E.mp3");
    this.load.audio("knightW", "assets/audio/knight_W.mp3");

    // Warrior (전사) — see Sfx.js's axeSwing/battleCryShout/battleCryDebuffHit/
    // slamLeap/slamImpact.
    this.load.audio("vikingQ", "assets/audio/viking_Q.mp3");
    this.load.audio("vikingW1", "assets/audio/viking_W1.mp3");
    this.load.audio("vikingW2", "assets/audio/viking_W2.mp3");
    this.load.audio("vikingE1", "assets/audio/viking_E1.mp3");
    this.load.audio("vikingEImpact", "assets/audio/viking_E_impact.mp3");

    // Mage (법사) — see Sfx.js's laserFire/fluidStateStart/blizzardCast/
    // blizzardFreeze (charge loop reuses magiQCharging via chargeLoopStart).
    this.load.audio("magiQ", "assets/audio/magi_Q.mp3");
    this.load.audio("magiQCharging", "assets/audio/magi_Q_charging.mp3");
    this.load.audio("magiW", "assets/audio/magi_W.mp3");
    this.load.audio("magiE", "assets/audio/magi_E.mp3");
    this.load.audio("magiEFrozen", "assets/audio/magi_E_frozen.mp3");

    this.load.image("arenaVoid", "assets/images/arena_void.png");
    this.load.image("arenaTile", "assets/images/arena_tile.png");
    this.load.image("arenaObs", "assets/images/arena_obs.png");
  }

  create() {
    this.cameras.main.setBackgroundColor("#0d0b08");
    this._buildArenaFloor();
    this.physics.world.setBounds(0, 0, ARENA.WIDTH, ARENA.HEIGHT);

    this.walls = this.physics.add.staticGroup();
    this._buildObstacles();
    this._buildHazards();

    // Bare test class-select (see _selectClass) — no persistence, resets to
    // the default on every scene reload, same lifecycle as everything else.
    this.selectedClassId = DEFAULT_CLASS_ID;
    this.player = new Player(this, ARENA.WIDTH * 0.25, ARENA.HEIGHT / 2, this.selectedClassId);
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

    this.physics.add.collider(this.player, this.walls, (obj) => obj.handleWallStop());
    this.physics.add.collider(this.dummy, this.walls, (obj) => obj.handleWallStop());
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

    this.classSwordsmanBtn = document.getElementById("classSwordsmanBtn");
    this.classKnightBtn = document.getElementById("classKnightBtn");
    this.classWarriorBtn = document.getElementById("classWarriorBtn");
    this.classMageBtn = document.getElementById("classMageBtn");
    this.classSwordsmanBtn.onclick = () => this._selectClass("swordsman");
    this.classKnightBtn.onclick = () => this._selectClass("knight");
    this.classWarriorBtn.onclick = () => this._selectClass("warrior");
    this.classMageBtn.onclick = () => this._selectClass("mage");
    this.classSwordsmanBtn.classList.toggle("active", this.selectedClassId === "swordsman");
    this.classKnightBtn.classList.toggle("active", this.selectedClassId === "knight");
    this.classWarriorBtn.classList.toggle("active", this.selectedClassId === "warrior");
    this.classMageBtn.classList.toggle("active", this.selectedClassId === "mage");
    this.skillRowsEl = document.getElementById("skillRows");
    this.triangleHintEl = document.getElementById("triangleHint");
    this._renderSkillPanel();

    const titleScreen = document.getElementById("titleScreen");
    document.getElementById("startBtn").onclick = () => {
      titleScreen.classList.add("hidden");
      unlockAudio();
      this._startCountdown();
    };
  }

  // Bare test class-select: the Player is already constructed by the time
  // the title screen renders, so switching classes here destroys and
  // recreates it (only ever happens pre-match, while locked) rather than
  // threading a mid-life class change through Combatant itself — Stage 2a is
  // single-player-only scaffolding for testing, not the real Stage-3 UI.
  _selectClass(classId) {
    if (this.selectedClassId === classId) return;
    this.selectedClassId = classId;
    this.classSwordsmanBtn.classList.toggle("active", classId === "swordsman");
    this.classKnightBtn.classList.toggle("active", classId === "knight");
    this.classWarriorBtn.classList.toggle("active", classId === "warrior");
    this.classMageBtn.classList.toggle("active", classId === "mage");
    this._renderSkillPanel();

    const wasLocked = this.player.locked;
    this.player.destroyEntity();
    this.player = new Player(this, ARENA.WIDTH * 0.25, ARENA.HEIGHT / 2, classId);
    this.player.locked = wasLocked;
    this.combatants[0] = this.player;
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.physics.add.collider(this.player, this.walls, (obj) => obj.handleWallStop());
    this.physics.add.collider(this.player, this.dummy, null, (a, b) => this._shouldBodyBlock(a, b));
  }

  // Rewrites the title screen's Q/W/E skill panel + triangle-hint sentence
  // for the currently-selected class (see CLASS_SKILL_INFO) — called once
  // on init and again every time a different class button is clicked, so
  // the panel never shows a class other than the one actually selected
  // (previously hardcoded to swordsman's skills regardless of pick).
  _renderSkillPanel() {
    const info = CLASS_SKILL_INFO[this.selectedClassId] || CLASS_SKILL_INFO[DEFAULT_CLASS_ID];
    const row = (key, cssVar) => `
      <div class="skill-row" style="--c:${cssVar}">
        <span class="skill-key">${key.toUpperCase()}</span><span class="skill-icon">${info[key].icon}</span>
        <div class="skill-text">
          <b>${info[key].name}</b>
          <span>${info[key].desc}</span>
        </div>
      </div>`;
    this.skillRowsEl.innerHTML = row("q", "#ff9f43") + row("w", "#7ff0ff") + row("e", "#ffcc33");
    this.triangleHintEl.innerHTML = info.triangleHtml;
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
    const cx = p.x;
    const cy = p.y;
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

  // Spawns a permanent set of looping bubble particles for one quicksand
  // patch (called once, at patch creation).
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

  // layoutGenerator.js's {x, y, w, h} rects are CENTER-based (x,y is the
  // rect's center) — this used to check it as a top-left corner, silently
  // shifting the real pit/quicksand hit region by (w/2, h/2) away from
  // wherever it was actually drawn/verified-clear-of-spawns.
  _inZone(c, zone) {
    const halfW = zone.w / 2;
    const halfH = zone.h / 2;
    return c.x >= zone.x - halfW && c.x <= zone.x + halfW && c.y >= zone.y - halfH && c.y <= zone.y + halfH;
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
    if (a.state === STATES.SHIELD_CHARGE || b.state === STATES.SHIELD_CHARGE) return false;
    if (a.state === STATES.SLAMMING || b.state === STATES.SLAMMING) return false;
    // A fluid Mage is meant to read as insubstantial for their whole cast
    // (invincible phase and haste phase alike), not just immune to Q hits —
    // walking through the other body while "liquid" fits the theme.
    if (a.state === STATES.FLUID || b.state === STATES.FLUID) return false;
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
    this._checkComboAttack();
    this._checkShieldCharge();
    this._checkEmpoweredStrike();
    this._checkAxeSwing();
    this._checkBattleCryShout();
    this._checkSlamImpact();
    this._checkLaserFire();
    this._checkBlizzard();
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

  // Class-agnostic: reads the outcome fields resolved onto dasher._dash at
  // release time (see Combatant._releaseDash) instead of assuming every Q
  // dash is an instakill piercing hit — the swordsman's dash is (lethal,
  // pierce), Knight's comboDash is (knockback, non-piercing) unless empowered.
  _checkDashHits() {
    for (const dasher of this.combatants) {
      if (dasher.state !== STATES.DASH || !dasher._dash) continue;
      for (const other of this.combatants) {
        if (other === dasher || !other.isAlive) continue;
        const hitRadius = (dasher.radius + other.radius) * (dasher._dash.widthMultiplier || 1);
        const dist = Phaser.Math.Distance.Between(dasher.x, dasher.y, other.x, other.y);
        if (dist > hitRadius) continue;

        if (other.state === STATES.PARRYING) {
          if (other.parrySuccess()) {
            dasher.selfStunFromParry();
            this._spawnImpactBurst(other.x, other.y, 0x7ff0ff, { ringR: 42, bits: 8, dist: 42 });
            this.cameras.main.shake(90, 0.005);
            this.hitstopMs = 70;
          }
        } else if (dasher._dash.lethal) {
          // kill() no-ops (returns false) against an invincible target
          // (e.g. a Warrior mid-battle-cry) and stuns the dasher instead —
          // only grant the kill-GCD-exemption/impact feedback if it landed.
          if (other.kill(dasher.facing, dasher)) {
            dasher.markDashKill();
            this.hitstopMs = 90;
          }
        } else {
          other.applyKnockback(dasher.facing, dasher._dash.knockbackDistance, dasher._dash.knockbackSpeed, {
            attacker: dasher,
          });
          this._spawnImpactBurst(other.x, other.y, 0xff9f43, { ringR: 28, bits: 5, dist: 26 });
          this.hitstopMs = 55;
          if (!dasher._dash.pierce) dasher._dash.remaining = 0; // stop right at the hit
        }
      }
    }
  }

  _checkKicks() {
    for (const kicker of this.combatants) {
      if (!kicker.isKickActive) continue;
      const eKick = kicker.skills.eKick;
      const halfAngle = Phaser.Math.DegToRad(eKick.HALF_ANGLE_DEG);
      for (const target of this.combatants) {
        if (target === kicker || !target.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(kicker.x, kicker.y, target.x, target.y);
        if (dist > eKick.RANGE + target.radius) continue;
        const angleToTarget = Phaser.Math.Angle.Between(kicker.x, kicker.y, target.x, target.y);
        const diff = Phaser.Math.Angle.Wrap(angleToTarget - kicker.facing);
        if (Math.abs(diff) > halfAngle) continue;

        // Only kicking through a parry (E beating W) stuns; a plain hit on
        // anyone else is knockback-only per the requested balance change.
        // E beats invincibility too (battle cry doesn't answer a kick any
        // more than a parry does) — bypassInvincible so it always connects,
        // and hitting an invincible target stuns them same as a countered
        // parry ("failing" their battle cry), checked before any state
        // mutation below can flip isInvincible off.
        const counteredParry = target.state === STATES.PARRYING;
        const invincibleBroken = target.isInvincible;
        if (counteredParry || invincibleBroken) {
          target.applyStun(eKick.STUN_MS, { bypassInvincible: true });
        }
        target.applyKnockback(kicker.facing, eKick.KNOCKBACK_DISTANCE, eKick.KNOCKBACK_SPEED, {
          bypassInvincible: true,
        });
        kicker.markKickApplied(counteredParry || invincibleBroken);

        if (counteredParry || invincibleBroken) {
          this._spawnImpactBurst(target.x, target.y, 0xff5c5c, { ringR: 36, bits: 8, dist: 36 });
          this.hitstopMs = 80;
        } else {
          this._spawnImpactBurst(target.x, target.y, 0xffcc33, { ringR: 22, bits: 4, dist: 20 });
          this.hitstopMs = 40;
        }
      }
    }
  }

  // Empowered Q: a stationary rectangle hit-test along the attacker's facing
  // direction — projects each target's offset onto the facing axis (along)
  // and its perpendicular (perp) instead of a circle/cone check, since this
  // is a straight-line AOE, not a point or an arc. Still loses to a raised
  // shield (same triangle edge as the base Q dash and the combo follow-up);
  // a clean hit on anyone else is an instakill.
  _checkEmpoweredStrike() {
    for (const attacker of this.combatants) {
      if (!attacker.isEmpoweredStrikeActive) continue;
      const cfg = attacker.skills.empoweredStrike;
      const halfW = cfg.WIDTH / 2;
      const cos = Math.cos(attacker.facing);
      const sin = Math.sin(attacker.facing);
      for (const target of this.combatants) {
        if (target === attacker || !target.isAlive) continue;
        const relX = target.x - attacker.x;
        const relY = target.y - attacker.y;
        const along = relX * cos + relY * sin;
        const perp = -relX * sin + relY * cos;
        if (along < -target.radius || along > cfg.LENGTH + target.radius) continue;
        if (Math.abs(perp) > halfW + target.radius) continue;

        if (target.state === STATES.PARRYING) {
          if (target.parrySuccess()) {
            attacker.applyStun();
            this._spawnImpactBurst(target.x, target.y, 0x7ff0ff, { ringR: 42, bits: 8, dist: 42 });
            this.cameras.main.shake(90, 0.005);
            this.hitstopMs = 70;
          }
          attacker.markEmpoweredStrikeApplied();
          continue;
        }

        attacker.markEmpoweredStrikeApplied();
        if (target.kill(attacker.facing, attacker)) {
          this._spawnImpactBurst(target.x, target.y, 0xffe066, { ringR: 40, bits: 8, dist: 40 });
          this.hitstopMs = 100;
        }
      }
    }
  }

  // Knight combo follow-up swing — same cone hit-test shape as _checkKicks,
  // over the comboAttack tuning instead of eKick. It's a Q-family strike, so
  // it still loses to a raised shield (same triangle edge as the base Q
  // dash) — but a clean hit on anyone else is an instakill, not knockback.
  _checkComboAttack() {
    for (const attacker of this.combatants) {
      if (!attacker.isComboAttackActive) continue;
      const combo = attacker.skills.comboAttack;
      const halfAngle = Phaser.Math.DegToRad(combo.HALF_ANGLE_DEG);
      for (const target of this.combatants) {
        if (target === attacker || !target.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(attacker.x, attacker.y, target.x, target.y);
        if (dist > combo.RANGE + target.radius) continue;
        const angleToTarget = Phaser.Math.Angle.Between(attacker.x, attacker.y, target.x, target.y);
        const diff = Phaser.Math.Angle.Wrap(angleToTarget - attacker.facing);
        if (Math.abs(diff) > halfAngle) continue;

        if (target.state === STATES.PARRYING) {
          if (target.parrySuccess()) {
            attacker.applyStun();
            this._spawnImpactBurst(target.x, target.y, 0x7ff0ff, { ringR: 42, bits: 8, dist: 42 });
            this.cameras.main.shake(90, 0.005);
            this.hitstopMs = 70;
          }
          continue;
        }

        attacker.markComboHitApplied();
        if (target.kill(attacker.facing, attacker)) {
          this._spawnImpactBurst(target.x, target.y, 0xd98c3a, { ringR: 32, bits: 6, dist: 32 });
          this.hitstopMs = 90;
        }
      }
    }
  }

  // Knight shield charge (E) — a short forward dash-charge; hitting a
  // W-active (guarding) target beats it (same triangle edge as E-beats-W
  // elsewhere) for stronger knockback + a stun, GCD-exempt. Also beats
  // battle-cry invincibility the same way — E ignores W outright, so a
  // battle-cry Warrior caught by this gets stunned instead of blocking it.
  _checkShieldCharge() {
    for (const charger of this.combatants) {
      if (charger.state !== STATES.SHIELD_CHARGE || !charger._shieldCharge) continue;
      const cfg = charger.skills.eShieldCharge;
      for (const target of this.combatants) {
        if (target === charger || !target.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(charger.x, charger.y, target.x, target.y);
        if (dist > charger.radius + target.radius) continue;

        const vsGuard = target.state === STATES.PARRYING;
        const invincibleBroken = target.isInvincible; // checked before any mutation below
        if (vsGuard || invincibleBroken) {
          target.applyStun(cfg.VS_GUARD_STUN_MS, { bypassInvincible: true });
          target.applyKnockback(charger.facing, cfg.VS_GUARD_KNOCKBACK_DISTANCE, cfg.VS_GUARD_KNOCKBACK_SPEED, {
            bypassInvincible: true,
          });
          this._spawnImpactBurst(target.x, target.y, 0xff5c5c, { ringR: 40, bits: 8, dist: 38 });
          this.hitstopMs = 85;
        } else {
          target.applyKnockback(charger.facing, cfg.KNOCKBACK_DISTANCE, cfg.KNOCKBACK_SPEED);
          this._spawnImpactBurst(target.x, target.y, 0x8fa8c8, { ringR: 26, bits: 5, dist: 26 });
          this.hitstopMs = 50;
        }
        charger.markShieldChargeApplied(vsGuard || invincibleBroken);
        charger._shieldCharge.remaining = 0; // stop right at the hit, non-piercing
      }
    }
  }

  // Warrior Q: instant 360-degree hit around self — plain circle distance
  // test, no angle check (simplest correct shape for "everywhere around me").
  // Still loses to a raised shield, same triangle edge as every other Q.
  _checkAxeSwing() {
    for (const attacker of this.combatants) {
      if (!attacker.isAxeSwingActive) continue;
      const cfg = attacker.skills.axeSwing;
      for (const target of this.combatants) {
        if (target === attacker || !target.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(attacker.x, attacker.y, target.x, target.y);
        if (dist > cfg.RADIUS + target.radius) continue;

        if (target.state === STATES.PARRYING) {
          if (target.parrySuccess()) {
            attacker.applyStun();
            this._spawnImpactBurst(target.x, target.y, 0x7ff0ff, { ringR: 42, bits: 8, dist: 42 });
            this.cameras.main.shake(90, 0.005);
            this.hitstopMs = 70;
          }
          attacker.markAxeSwingApplied();
          continue;
        }

        attacker.markAxeSwingApplied();
        if (target.kill(attacker.facing, attacker)) {
          this._spawnImpactBurst(target.x, target.y, 0xd9c9a3, { ringR: 34, bits: 6, dist: 32 });
          this.hitstopMs = 90;
        }
      }
    }
  }

  // Warrior W: a one-shot AOE debuff burst that fires DISABLE_DELAY_MS after
  // invincibility ends (not a hit — no damage, so it's unaffected by the
  // invincibility guard on kill/applyStun/applyKnockback) — anyone in range
  // can't start Q/W/E for a bit. A raised shield blocks it outright: a
  // PARRYING target takes no debuff (parrySuccess(), no punishment to the
  // attacker — this is a pure block, not a Q-vs-W counter).
  _checkBattleCryShout() {
    for (const attacker of this.combatants) {
      if (!attacker.isBattleCryShoutActive) continue;
      const cfg = attacker.skills.battleCry;
      for (const target of this.combatants) {
        if (target === attacker || !target.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(attacker.x, attacker.y, target.x, target.y);
        if (dist > cfg.SHOUT_RADIUS + target.radius) continue;

        if (target.state === STATES.PARRYING) {
          if (target.parrySuccess()) {
            this._spawnImpactBurst(target.x, target.y, 0x7ff0ff, { ringR: 30, bits: 5, dist: 28 });
          }
          continue;
        }

        target._skillsDisabledMs = cfg.DISABLE_MS;
        Sfx.battleCryDebuffHit();
        this._spawnImpactBurst(target.x, target.y, 0x8a8f99, { ringR: 30, bits: 5, dist: 28 });
      }
      attacker.markBattleCryShoutApplied();
    }
  }

  // Warrior E, landing: a stationary circle hit-test centered on wherever
  // the leap actually ended up (attacker.x/y at this point), radius resolved
  // at release time from the charge ratio. Landing on a PARRYING target just
  // stuns them instead of a counter — the attacker is NOT punished here,
  // unlike every other class's W-interaction so far (see the design doc).
  // Also beats battle-cry invincibility the same way (E ignores W outright):
  // landing on an invincible target stuns them too, same as the vs-guard case.
  _checkSlamImpact() {
    for (const attacker of this.combatants) {
      if (!attacker.isSlamImpactActive) continue;
      const cfg = attacker.skills.divingSlam;
      const radius = attacker._slam ? attacker._slam.impactRadius : cfg.MIN_IMPACT_RADIUS;
      for (const target of this.combatants) {
        if (target === attacker || !target.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(attacker.x, attacker.y, target.x, target.y);
        if (dist > radius + target.radius) continue;

        const vsGuard = target.state === STATES.PARRYING;
        const invincibleBroken = target.isInvincible; // checked before any mutation below
        if (vsGuard || invincibleBroken) {
          target.applyStun(cfg.VS_GUARD_STUN_MS, { bypassInvincible: true });
          this._spawnImpactBurst(target.x, target.y, 0x7ff0ff, { ringR: 36, bits: 7, dist: 34 });
        } else {
          target.applyKnockback(attacker.facing, cfg.KNOCKBACK_DISTANCE, cfg.KNOCKBACK_SPEED);
          this._spawnImpactBurst(target.x, target.y, 0x6b5636, { ringR: 40, bits: 8, dist: 38 });
        }
        this.hitstopMs = 80;
        attacker.markSlamImpactApplied();
      }
    }
  }

  // Mage Q: a stationary rectangle hit-test along the attacker's facing
  // direction — same along/perp projection as _checkEmpoweredStrike, since
  // this is also a straight-line AOE. Still loses to a raised shield (same
  // triangle edge as every other Q) and to any invincible target (fluid
  // Mage), both via kill()'s centralized guard; a clean hit is an instakill.
  _checkLaserFire() {
    for (const attacker of this.combatants) {
      if (!attacker.isLaserFireActive) continue;
      const cfg = attacker.skills.laserBeam;
      const length = attacker._laser ? attacker._laser.length : cfg.MIN_LENGTH;
      const halfW = (attacker._laser ? attacker._laser.width : cfg.MIN_WIDTH) / 2;
      const cos = Math.cos(attacker.facing);
      const sin = Math.sin(attacker.facing);
      for (const target of this.combatants) {
        if (target === attacker || !target.isAlive) continue;
        const relX = target.x - attacker.x;
        const relY = target.y - attacker.y;
        const along = relX * cos + relY * sin;
        const perp = -relX * sin + relY * cos;
        if (along < -target.radius || along > length + target.radius) continue;
        if (Math.abs(perp) > halfW + target.radius) continue;

        if (target.state === STATES.PARRYING) {
          if (target.parrySuccess()) {
            attacker.applyStun();
            this._spawnImpactBurst(target.x, target.y, 0x7ff0ff, { ringR: 42, bits: 8, dist: 42 });
            this.cameras.main.shake(90, 0.005);
            this.hitstopMs = 70;
          }
          attacker.markLaserFireApplied();
          continue;
        }

        attacker.markLaserFireApplied();
        if (target.kill(attacker.facing, attacker)) {
          this._spawnImpactBurst(target.x, target.y, 0xd9bfff, { ringR: 38, bits: 8, dist: 38 });
          this.hitstopMs = 100;
        }
      }
    }
  }

  // Mage E: a wide instant 180-degree cone (RANGE/HALF_ANGLE_DEG, same shape
  // as _checkKicks) fired once per activation. A plain hit slows the target
  // for a second; like every other class's E, it beats W outright — landing
  // on a PARRYING *or* currently-fluid target freezes (stuns) them instead,
  // "failing" their W the same way E beats Warrior's battle cry.
  _checkBlizzard() {
    for (const attacker of this.combatants) {
      if (!attacker.isBlizzardActive) continue;
      const cfg = attacker.skills.blizzard;
      const halfAngle = Phaser.Math.DegToRad(cfg.HALF_ANGLE_DEG);
      let counteredGuard = false; // froze at least one PARRYING/fluid target -> skip GCD
      for (const target of this.combatants) {
        if (target === attacker || !target.isAlive) continue;
        const dist = Phaser.Math.Distance.Between(attacker.x, attacker.y, target.x, target.y);
        if (dist > cfg.RANGE + target.radius) continue;
        const angleToTarget = Phaser.Math.Angle.Between(attacker.x, attacker.y, target.x, target.y);
        const diff = Phaser.Math.Angle.Wrap(angleToTarget - attacker.facing);
        if (Math.abs(diff) > halfAngle) continue;

        const vsGuard = target.state === STATES.PARRYING;
        const invincibleBroken = target.isInvincible; // checked before any mutation below
        if (vsGuard || invincibleBroken) {
          target.applyStun(cfg.VS_GUARD_STUN_MS, { bypassInvincible: true });
          attacker._grantFastCharge(); // a successful freeze speeds up the caster's next Q
          counteredGuard = true;
          Sfx.blizzardFreeze();
          this._spawnImpactBurst(target.x, target.y, 0x7fd0ff, { ringR: 34, bits: 7, dist: 32 });
        } else {
          target._slowedMs = cfg.SLOW_MS;
          Sfx.blizzardSlow();
          this._spawnImpactBurst(target.x, target.y, 0xdff6ff, { ringR: 24, bits: 5, dist: 22 });
        }
        this.hitstopMs = 45;
      }
      attacker.markBlizzardApplied(counteredGuard);
    }
  }

  // Keyed by skills.skillTypes.{q,w,e} values so a future class only needs
  // an entry here, not a new branch.
  static SKILL_LABELS = {
    chargeDash: "발도술",
    comboDash: "해머 돌진",
    tapParry: "반격자세",
    heldGuard: "방패 들기",
    kickCone: "발차기",
    shieldCharge: "방패 돌진",
    axeSwing: "도끼 휘두르기",
    battleCry: "전투 함성",
    divingSlam: "강하 슬램",
    laserBeam: "레이저",
    fluidState: "유체화",
    blizzard: "눈보라",
  };

  _updateHud() {
    if (!this.hud) return;
    const p = this.player;
    const labels = ArenaScene.SKILL_LABELS;
    const t = p.skills.skillTypes;
    this.hud.textContent =
      `L-Click Hold: 이동 (커서 방향)   Q: ${labels[t.q]}   W: ${labels[t.w]}   E: ${labels[t.e]}\n` +
      `Player: ${p.state}${p.state === STATES.CHARGING || p.state === STATES.SLAM_CHARGE || p.state === STATES.LASER_CHARGE ? ` (${(p.chargeTime / 1000).toFixed(2)}s)` : ""}  alive=${p.isAlive}\n` +
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
        ? { pct: (p.chargeTime / p.skills.qDash.MAX_CHARGE_MS) * 100, color: "#ff9f43", active: true }
        : p.state === STATES.LASER_CHARGE
        ? {
            pct: Math.min(100, (p.chargeTime / p.laserMinChargeMs) * 100),
            color: p.chargeTime >= p.laserMinChargeMs ? "#d9bfff" : "#6a5a8a",
            active: true,
          }
        : p.state === STATES.DASH ||
          p.state === STATES.COMBO_WINDOW ||
          p.state === STATES.COMBO_ATTACK ||
          p.state === STATES.EMPOWERED_STRIKE ||
          p.state === STATES.AXE_SWING ||
          p.state === STATES.LASER_FIRE
        ? { pct: 100, color: p.state === STATES.EMPOWERED_STRIKE ? "#ffe066" : "#ff9f43", active: true }
        : p.state === STATES.GCD
        ? GCD_FILL
        : READY,
      W: stunned
        ? STUN_FILL
        : p.state === STATES.PARRYING
        ? p.skills.skillTypes.w === "heldGuard"
          ? { pct: (p.stateTimer / p.skills.wParry.MAX_HOLD_MS) * 100, color: "#7ff0ff", active: true }
          : { pct: 100, color: "#7ff0ff", active: true }
        : p.state === STATES.BATTLE_CRY
        ? {
            pct: 100 - (p.stateTimer / p.skills.battleCry.TOTAL_MS) * 100,
            color: p.isInvincible ? "#ff4040" : "#8a8f99",
            active: true,
          }
        : p.state === STATES.FLUID
        ? {
            pct: 100 - (p.stateTimer / p.skills.fluidState.TOTAL_MS) * 100,
            color: p.isInvincible ? "#b98cff" : "#8ff0ff",
            active: true,
          }
        : p.state === STATES.GCD
        ? GCD_FILL
        : READY,
      E: stunned
        ? STUN_FILL
        : p.state === STATES.KICKING || p.state === STATES.SHIELD_CHARGE
        ? { pct: 100, color: p.state === STATES.SHIELD_CHARGE ? "#8fa8c8" : "#ffcc33", active: true }
        : p.state === STATES.SLAM_CHARGE
        ? { pct: (p.chargeTime / p.skills.divingSlam.MAX_CHARGE_MS) * 100, color: "#c97b3a", active: true }
        : p.state === STATES.SLAMMING || p.state === STATES.SLAM_IMPACT
        ? { pct: 100, color: "#c97b3a", active: true }
        : p.state === STATES.BLIZZARD
        ? { pct: 100, color: "#7fd0ff", active: true }
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
    this.skillSlots.Q.classList.toggle("empowered", p._empoweredQMs > 0);
  }
}
