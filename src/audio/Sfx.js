// Synthesized sound effects via the Web Audio API — no external audio
// assets to manage. Sound design follows sound.txt (per-skill mood +
// layering notes). init() must run after a user gesture (browser
// autoplay policy blocks AudioContext until then); ArenaScene calls it
// on the first pointerdown/keydown.
class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.scene = null; // Phaser scene, once real audio clips are loaded
    this._chargeClip = null;
    this._chargeOsc = null;
    this._chargeGain = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);
  }

  // Real recorded clips (loaded by ArenaScene.preload) take priority; the
  // synthesized generators above stay as a fallback for events with no
  // matching file (wallBump, kick impact detail, the stun bell sequence).
  attachScene(scene) {
    this.scene = scene;
  }

  _hasClip(key) {
    return !!(this.scene && this.scene.cache.audio.exists(key));
  }

  // Plays a loaded clip if present. Returns true if it played, so callers
  // can fall back to the synthesized version when it didn't.
  _playClip(key, config) {
    if (!this._hasClip(key)) return false;
    this.scene.sound.play(key, config);
    return true;
  }

  _env(gainNode, now, { attack = 0.005, hold = 0, decay = 0.15, peak = 0.5 }) {
    const g = gainNode.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(peak, now + attack);
    g.setValueAtTime(peak, now + attack + hold);
    g.exponentialRampToValueAtTime(0.001, now + attack + hold + decay);
  }

  _tone({ freqStart, freqEnd = freqStart, duration = 0.15, type = "sine", peak = 0.4, delay = 0 }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), now + duration);
    osc.connect(gain);
    gain.connect(this.master);
    this._env(gain, now, { attack: 0.005, decay: duration, peak });
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  // Punchy low-end hit — used for the "sub-bass emphasized" impacts sound.txt
  // calls for on kicks and kills.
  _thump({ freq = 80, duration = 0.15, peak = 0.5, delay = 0 }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * 2.2, now);
    osc.frequency.exponentialRampToValueAtTime(freq, now + duration);
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.master);
    this._env(gain, now, { attack: 0.002, decay: duration, peak });
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  // Ringing metallic "chang-" — a few near-unison/octave triangle oscillators
  // for the blade-slice moments (Q dash, kill).
  _metalSlice({ freqStart, freqEnd, duration, peak, delay = 0 }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime + delay;
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    this._env(gain, now, { attack: 0.003, decay: duration, peak });
    [1, 1.01, 2.005].forEach((mult) => {
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freqStart * mult, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd * mult, 1), now + duration);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + duration + 0.05);
    });
  }

  _noise({ duration = 0.2, peak = 0.4, filterFreq = 1200, filterType = "bandpass", delay = 0 }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime + delay;
    const sampleCount = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, sampleCount, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const gain = this.ctx.createGain();

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    this._env(gain, now, { attack: 0.005, decay: duration, peak });
    src.start(now);
    src.stop(now + duration + 0.02);
  }

  // 1a. Q charging: a held, rising-pitch drone for as long as Q is down —
  // reuses the qCharging clip itself (played on loop, sped up with
  // progress) rather than a separate asset. Start on CHARGING entry, feed
  // it live progress via chargeLoopUpdate(), self-stops on any exit from
  // CHARGING (see Combatant.setState).
  chargeLoopStart() {
    if (this._hasClip("qCharging")) {
      this._chargeClip = this.scene.sound.add("qCharging", { loop: true, volume: 0.45, rate: 0.7 });
      this._chargeClip.play();
      return;
    }
    if (!this.ctx) return;
    this.chargeLoopStop();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(140, now);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.05);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    this._chargeOsc = osc;
    this._chargeGain = gain;
  }

  chargeLoopUpdate(ratio) {
    if (this._chargeClip) {
      this._chargeClip.setRate(0.7 + ratio * 0.9); // pitch climbs toward the dash-release threshold
      return;
    }
    if (!this.ctx || !this._chargeOsc) return;
    const freq = 140 + ratio * 620;
    this._chargeOsc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.05);
  }

  chargeLoopStop() {
    if (this._chargeClip) {
      this._chargeClip.stop();
      this._chargeClip.destroy();
      this._chargeClip = null;
      return;
    }
    if (!this.ctx || !this._chargeOsc) return;
    const now = this.ctx.currentTime;
    const osc = this._chargeOsc;
    const gain = this._chargeGain;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.08);
    osc.stop(now + 0.1);
    this._chargeOsc = null;
    this._chargeGain = null;
  }

  // 1b. Q charging reaching 100%: a separate one-shot cue (also the
  // qCharging clip, but a plain non-looping play at normal rate) layered on
  // top of the still-running loop above, fired the instant chargeTime
  // first hits Q_DASH.MAX_CHARGE_MS, alongside the sparkle particles — see
  // Combatant._updateCharging.
  chargeReady() {
    if (this._playClip("qCharging", { volume: 0.6 })) return;
    this._tone({ freqStart: 500, freqEnd: 950, duration: 0.18, type: "sine", peak: 0.4 });
  }

  // 2. Q dash release: whoosh (air burst) layered with a metallic slice.
  dashRelease() {
    if (this._playClip("qActive", { volume: 0.6 })) return;
    this._noise({ duration: 0.2, peak: 0.5, filterFreq: 2000, filterType: "highpass" });
    this._metalSlice({ freqStart: 2200, freqEnd: 900, duration: 0.14, peak: 0.35, delay: 0.02 });
  }

  // 3. Wall collision: low-passed dull thud — the dash getting cut short.
  // (No matching clip supplied; stays synthesized.)
  wallBump() {
    this._tone({ freqStart: 90, freqEnd: 35, duration: 0.12, type: "square", peak: 0.4 });
    this._noise({ duration: 0.1, peak: 0.3, filterFreq: 250, filterType: "lowpass" });
  }

  // 4. W parry stance: shield turning on.
  parryStance() {
    if (this._playClip("shieldOn", { volume: 0.5 })) return;
    this._noise({ duration: 0.16, peak: 0.25, filterFreq: 2600, filterType: "bandpass" });
    this._tone({ freqStart: 700, freqEnd: 1500, duration: 0.16, type: "sine", peak: 0.18 });
  }

  // 5. W parry success: the block impact and the success jingle layered together.
  parrySuccess() {
    const playedParry = this._playClip("parry", { volume: 0.55 });
    const playedSuccess = this._playClip("wSuccess", { volume: 0.55, delay: 0.03 });
    if (playedParry || playedSuccess) return;
    this._tone({ freqStart: 600, freqEnd: 1600, duration: 0.22, type: "triangle", peak: 0.3 });
    this._tone({ freqStart: 1200, freqEnd: 2000, duration: 0.3, type: "sine", peak: 0.18, delay: 0.02 });
    this._noise({ duration: 0.15, peak: 0.18, filterFreq: 4000, filterType: "highpass", delay: 0.03 });
  }

  // 6. E kick swing: heavy cloth/wind whoosh, deliberately no metallic edge
  // so it contrasts with Q.
  kickSwing() {
    if (this._playClip("kick", { volume: 0.6 })) return;
    this._noise({ duration: 0.16, peak: 0.32, filterFreq: 1400, filterType: "bandpass" });
  }

  // 7. E kick hit: bone/flesh thump + trailing knockback wind.
  // (No separate impact clip supplied; the swing clip already covers the
  // action, so this stays synthesized to keep whiff vs. hit distinguishable.)
  kickHit() {
    this._thump({ freq: 90, duration: 0.16, peak: 0.5 });
    this._noise({ duration: 0.12, peak: 0.35, filterFreq: 700, filterType: "lowpass" });
    this._noise({ duration: 0.15, peak: 0.15, filterFreq: 1600, filterType: "highpass", delay: 0.05 });
  }

  // 8. Stun: an arcade "ding~ ding-ling~" bell pattern spaced out across the
  // stun's actual duration so being dazed reads for its whole length, not
  // just a blip — scales down for short penalty-stuns (e.g. a wall crash)
  // instead of always assuming the full 2s combat stun.
  // (No matching clip supplied; stays synthesized.)
  stun(durationMs = 2000) {
    const steps = durationMs >= 1200 ? 6 : 3;
    for (let i = 0; i < steps; i++) {
      const ms = (durationMs * i) / steps;
      const freq = i % 2 === 0 ? 1200 : 900;
      const peak = Math.max(0.22 - i * (0.18 / steps), 0.05);
      this._tone({ freqStart: freq, freqEnd: freq * 0.8, duration: 0.3, type: "sine", peak, delay: ms / 1000 });
    }
  }

  // 9. Kill: cold slice + heavy sub-bass critical burst.
  death() {
    if (this._playClip("kill", { volume: 0.7 })) return;
    this._metalSlice({ freqStart: 2600, freqEnd: 700, duration: 0.16, peak: 0.4 });
    this._thump({ freq: 55, duration: 0.35, peak: 0.6, delay: 0.02 });
    this._noise({ duration: 0.3, peak: 0.4, filterFreq: 500, filterType: "lowpass", delay: 0.02 });
  }

  // 12. Knight W held-guard raising — knightW clip, distinct from the
  // swordsman's shieldOn/parryStance (a held guard vs. a tap parry).
  shieldRaise() {
    if (this._playClip("knightW", { volume: 0.55 })) return;
    this._noise({ duration: 0.16, peak: 0.25, filterFreq: 2600, filterType: "bandpass" });
    this._tone({ freqStart: 700, freqEnd: 1500, duration: 0.16, type: "sine", peak: 0.18 });
  }

  // 12b. Knight W held-guard lowering (voluntary release or hold-ceiling
  // timeout) — the powering-down counterpart to shieldRaise(). No dedicated
  // clip supplied; stays synthesized.
  shieldLower() {
    this._noise({ duration: 0.14, peak: 0.2, filterFreq: 1800, filterType: "bandpass" });
    this._tone({ freqStart: 1200, freqEnd: 500, duration: 0.14, type: "sine", peak: 0.14 });
  }

  // 13. Knight empowered-Q buff granted (successful shield block) — a bright
  // rising sparkle layered on top of parrySuccess(). No dedicated clip
  // supplied (distinct from the powerdQ release clip below); stays synthesized.
  empoweredQCharge() {
    this._tone({ freqStart: 900, freqEnd: 2200, duration: 0.25, type: "triangle", peak: 0.22, delay: 0.05 });
    this._tone({ freqStart: 1800, freqEnd: 3200, duration: 0.2, type: "sine", peak: 0.14, delay: 0.09 });
  }

  // 13b. Knight base Q release (comboDash, non-empowered): knightQ1 clip.
  comboDashRelease() {
    if (this._playClip("knightQ1", { volume: 0.6 })) return;
    this._noise({ duration: 0.2, peak: 0.5, filterFreq: 2000, filterType: "highpass" });
    this._metalSlice({ freqStart: 2200, freqEnd: 900, duration: 0.14, peak: 0.35, delay: 0.02 });
  }

  // 14. Knight empowered-Q release — knightPowerdQ clip, for the instakill
  // wide-sweep variant.
  empoweredQRelease() {
    // knightPowerdQ.mp3 has some lead-in silence/windup baked into the file
    // before the actual hit lands, so `seek` skips ahead into it. (A seek of
    // 1s landed past the clip's actual length and produced no sound at all.)
    // An instant synthesized transient also fires at t=0 on top, so the hit
    // reads as immediate the moment the strike activates either way.
    this._metalSlice({ freqStart: 3200, freqEnd: 1000, duration: 0.1, peak: 0.5 });
    this._thump({ freq: 75, duration: 0.14, peak: 0.45 });
    this._playClip("knightPowerdQ", { volume: 0.5, seek: 0.5 });
  }

  // 15. Knight combo follow-up (Q>Q) swing: knightQSwoosh clip.
  comboSwing() {
    if (this._playClip("knightQSwoosh", { volume: 0.55 })) return;
    this._noise({ duration: 0.18, peak: 0.36, filterFreq: 900, filterType: "bandpass" });
  }

  // 16. Knight combo follow-up (Q>Q) hit: knightQ2 clip.
  comboHit() {
    if (this._playClip("knightQ2", { volume: 0.6 })) return;
    this._thump({ freq: 65, duration: 0.2, peak: 0.55 });
    this._noise({ duration: 0.14, peak: 0.38, filterFreq: 500, filterType: "lowpass" });
  }

  // 17. Knight shield-charge (E) release: knightE clip.
  shieldChargeRelease() {
    if (this._playClip("knightE", { volume: 0.6 })) return;
    this._noise({ duration: 0.2, peak: 0.4, filterFreq: 700, filterType: "lowpass" });
    this._thump({ freq: 60, duration: 0.16, peak: 0.3, delay: 0.02 });
  }

  // 18. Knight shield-charge hit: metal-vs-body clang, used for both the
  // plain and vs-guard cases (the vs-guard case is differentiated visually
  // via impact-burst size/color, not a second sound). No separate impact
  // clip supplied — the E release clip already covers the action, so this
  // stays synthesized to keep whiff vs. hit distinguishable (same reasoning
  // as kickHit()).
  shieldBash() {
    this._metalSlice({ freqStart: 1600, freqEnd: 500, duration: 0.14, peak: 0.35 });
    this._thump({ freq: 85, duration: 0.16, peak: 0.45, delay: 0.01 });
  }

  // 10. Quicksand appearing: a wet shifting-ground rumble as the patch forms.
  terrainAppear() {
    if (this._playClip("terrainAppear", { volume: 0.6 })) return;
    this._noise({ duration: 0.3, peak: 0.3, filterFreq: 500, filterType: "lowpass" });
    this._tone({ freqStart: 80, freqEnd: 140, duration: 0.3, type: "sawtooth", peak: 0.15 });
  }

  // 11. Quicksand vanishing: reverse rumble settling into a soft thud.
  terrainVanish() {
    this._noise({ duration: 0.25, peak: 0.35, filterFreq: 400, filterType: "lowpass" });
    this._thump({ freq: 70, duration: 0.18, peak: 0.4, delay: 0.15 });
  }
}

export default new Sfx();
