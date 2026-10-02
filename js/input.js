/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - input.js
 * ----------------------------------------------------------------------------
 *  Keyboard + touch input handling.
 *
 *  Responsibilities:
 *    - map both control schemes (Arrow keys AND WASD) onto logical actions
 *    - preventDefault() on every game key so the page never scrolls/zooms
 *    - expose a snapshot of held actions to the simulation
 *    - surface "edge" events (pause, restart, mute, confirm) as callbacks
 *    - drive on-screen touch buttons on coarse-pointer devices
 *    - auto-release everything when the window loses focus
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});

  /** e.code -> logical action. Using `code` makes WASD layout independent. */
  const KEY_MAP = {
    ArrowUp: 'up',
    KeyW: 'up',
    ArrowDown: 'down',
    KeyS: 'down',
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    ShiftLeft: 'boost',
    ShiftRight: 'boost',
    Space: 'boost',
    ControlLeft: 'boost',
    KeyJ: 'boost'
  };

  /** Keys whose browser default (scroll / zoom / activate button) must die. */
  const PREVENT_CODES = new Set(
    Object.keys(KEY_MAP).concat([
      'KeyP', 'Escape', 'KeyM', 'KeyR', 'Enter', 'Space', 'Tab',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'PageUp', 'PageDown', 'Home', 'End'
    ])
  );

  function InputManager() {
    /** Currently held logical actions. */
    this.state = { up: false, down: false, left: false, right: false, boost: false };

    /** Edge-triggered callbacks, assigned by game.js. */
    this.onPause = null;
    this.onRestart = null;
    this.onMute = null;
    this.onConfirm = null;
    this.onAnyKey = null;

    /** Master switch: when false, held actions read as released. */
    this.enabled = true;

    this._attached = false;
    this._touchButtons = [];
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onBlur = this._handleBlur.bind(this);
    this._onVisibility = this._handleBlur.bind(this);
  }

  /* ------------------------------------------------------------------ setup */

  InputManager.prototype.attach = function (touchRoot) {
    if (this._attached) return;
    this._attached = true;

    global.addEventListener('keydown', this._onKeyDown, { passive: false });
    global.addEventListener('keyup', this._onKeyUp, { passive: false });
    global.addEventListener('blur', this._onBlur);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', this._onVisibility);
    }

    if (touchRoot) this._attachTouch(touchRoot);
  };

  InputManager.prototype.detach = function () {
    if (!this._attached) return;
    this._attached = false;
    global.removeEventListener('keydown', this._onKeyDown);
    global.removeEventListener('keyup', this._onKeyUp);
    global.removeEventListener('blur', this._onBlur);
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
  };

  /* --------------------------------------------------------------- keyboard */

  InputManager.prototype._handleKeyDown = function (e) {
    const code = e.code;

    // Never let the page scroll, repeat-fire or activate a focused button.
    if (PREVENT_CODES.has(code) || e.key === ' ' || e.key.indexOf('Arrow') === 0) {
      e.preventDefault();
    }

    const action = KEY_MAP[code];
    if (action) {
      if (!e.repeat) this.state[action] = true;
      else this.state[action] = true;
      if (this.onAnyKey) this.onAnyKey(action);
      return;
    }

    if (e.repeat) return; // edge actions fire once per press

    switch (code) {
      case 'KeyP':
      case 'Escape':
        if (this.onPause) this.onPause();
        break;
      case 'KeyR':
        if (this.onRestart) this.onRestart();
        break;
      case 'KeyM':
        if (this.onMute) this.onMute();
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        if (this.onConfirm) this.onConfirm();
        break;
      default:
        break;
    }
    if (this.onAnyKey) this.onAnyKey(code);
  };

  InputManager.prototype._handleKeyUp = function (e) {
    const action = KEY_MAP[e.code];
    if (action) {
      this.state[action] = false;
      if (PREVENT_CODES.has(e.code)) e.preventDefault();
    }
  };

  /** Losing focus must not leave the car stuck at full throttle. */
  InputManager.prototype._handleBlur = function () {
    this.releaseAll();
  };

  InputManager.prototype.releaseAll = function () {
    this.state.up = false;
    this.state.down = false;
    this.state.left = false;
    this.state.right = false;
    this.state.boost = false;
  };

  /* ------------------------------------------------------------------ touch */

  InputManager.prototype._attachTouch = function (root) {
    const buttons = root.querySelectorAll ? root.querySelectorAll('.tbtn') : [];
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const key = btn.getAttribute('data-key');
      if (!key) continue;

      const press = function (e) {
        if (e.cancelable) e.preventDefault();
        btn.classList.add('is-down');
        if (key === 'boost') this.state.boost = true;
        else this.state[key] = true;
        if (this.onAnyKey) this.onAnyKey(key);
      }.bind(this);

      const release = function (e) {
        if (e && e.cancelable) e.preventDefault();
        btn.classList.remove('is-down');
        if (key === 'boost') this.state.boost = false;
        else this.state[key] = false;
      }.bind(this);

      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      this._touchButtons.push(btn);
    }
  };

  /* ---------------------------------------------------------------- reading */

  /** Steering axis: -1 (left) .. +1 (right). */
  InputManager.prototype.steerAxis = function () {
    if (!this.enabled) return 0;
    let v = 0;
    if (this.state.left) v -= 1;
    if (this.state.right) v += 1;
    return v;
  };

  InputManager.prototype.throttle = function () {
    return this.enabled && this.state.up ? 1 : 0;
  };

  InputManager.prototype.brake = function () {
    return this.enabled && this.state.down ? 1 : 0;
  };

  InputManager.prototype.boostHeld = function () {
    return this.enabled && this.state.boost;
  };

  /** Snapshot copy (handy for the headless test harness). */
  InputManager.prototype.snapshot = function () {
    return {
      up: this.enabled && this.state.up,
      down: this.enabled && this.state.down,
      left: this.enabled && this.state.left,
      right: this.enabled && this.state.right,
      boost: this.enabled && this.state.boost,
      steer: this.steerAxis()
    };
  };

  /** Programmatic press/release used by the automated tests. */
  InputManager.prototype.set = function (action, down) {
    if (action in this.state) this.state[action] = !!down;
  };

  Racer.InputManager = InputManager;
})(typeof window !== 'undefined' ? window : globalThis);
