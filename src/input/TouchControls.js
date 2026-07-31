// Mobile virtual controls per game_design_spec.md 2.1: left-side drag =
// joystick (movement + facing), right-side Q hold/release + W/E tap.
// Pure DOM/touch-event handling — independent of Phaser's own input so it
// coexists cleanly with the PC mouse/keyboard path in Player.js.
const JOYSTICK_MAX_RADIUS = 48;

export default class TouchControls {
  constructor() {
    this.joystick = { active: false, angle: 0, magnitude: 0 };
    this.qHeld = false;
    this.wHeld = false;
    this._qTap = false;
    this._wTap = false;
    this._eTap = false;

    this._setupJoystick();
    this._setupButton("btnQ", {
      onDown: () => {
        this.qHeld = true;
        this._qTap = true;
      },
      onUp: () => {
        this.qHeld = false;
      },
    });
    this._setupButton("btnW", {
      onDown: () => {
        this._wTap = true;
        this.wHeld = true;
      },
      onUp: () => {
        this.wHeld = false;
      },
    });
    this._setupButton("btnE", { onDown: () => (this._eTap = true) });
  }

  consumeQTap() {
    const v = this._qTap;
    this._qTap = false;
    return v;
  }

  consumeWTap() {
    const v = this._wTap;
    this._wTap = false;
    return v;
  }

  consumeETap() {
    const v = this._eTap;
    this._eTap = false;
    return v;
  }

  _setupJoystick() {
    const zone = document.getElementById("joystickZone");
    const base = document.getElementById("joystickBase");
    const thumb = document.getElementById("joystickThumb");
    if (!zone || !base || !thumb) return;

    let activeId = null;
    let originX = 0;
    let originY = 0;

    const show = (x, y) => {
      originX = x;
      originY = y;
      base.style.left = `${x}px`;
      base.style.top = `${y}px`;
      base.style.display = "block";
      thumb.style.left = `${x}px`;
      thumb.style.top = `${y}px`;
      thumb.style.display = "block";
    };

    const move = (x, y) => {
      const dx = x - originX;
      const dy = y - originY;
      const dist = Math.min(Math.hypot(dx, dy), JOYSTICK_MAX_RADIUS);
      const angle = Math.atan2(dy, dx);
      thumb.style.left = `${originX + Math.cos(angle) * dist}px`;
      thumb.style.top = `${originY + Math.sin(angle) * dist}px`;
      this.joystick.angle = angle;
      this.joystick.magnitude = dist / JOYSTICK_MAX_RADIUS;
    };

    const end = () => {
      activeId = null;
      this.joystick.active = false;
      this.joystick.magnitude = 0;
      base.style.display = "none";
      thumb.style.display = "none";
    };

    zone.addEventListener(
      "touchstart",
      (e) => {
        if (activeId !== null) return;
        const t = e.changedTouches[0];
        activeId = t.identifier;
        this.joystick.active = true;
        show(t.clientX, t.clientY);
        e.preventDefault();
      },
      { passive: false }
    );
    zone.addEventListener(
      "touchmove",
      (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === activeId) move(t.clientX, t.clientY);
        }
        e.preventDefault();
      },
      { passive: false }
    );
    const onTouchEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === activeId) end();
      }
    };
    zone.addEventListener("touchend", onTouchEnd, { passive: true });
    zone.addEventListener("touchcancel", onTouchEnd, { passive: true });
  }

  _setupButton(id, { onDown, onUp }) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(
      "touchstart",
      (e) => {
        el.classList.add("pressed");
        onDown?.();
        e.preventDefault();
      },
      { passive: false }
    );
    const release = () => {
      el.classList.remove("pressed");
      onUp?.();
    };
    el.addEventListener("touchend", release, { passive: true });
    el.addEventListener("touchcancel", release, { passive: true });
  }
}
