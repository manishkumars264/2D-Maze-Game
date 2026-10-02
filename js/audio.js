/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - audio.js
 * ----------------------------------------------------------------------------
 *  100% synthesised sound effects via the WebAudio API - no audio files, no
 *  copyright concerns, and instant loading.
 *
 *  Layers:
 *    engine   : 2 detuned saw oscillators + filtered noise, pitch tracks rpm
 *    wind     : broadband noise that opens up with speed
 *    screech  : band-passed noise for tyre slip / hard braking / grass
 *    one-shots: crash, shield break, near-miss whoosh, UI clicks, countdown
 *
 *  The whole module degrades gracefully: if WebAudio is missing, blocked or
 *  throws, every method becomes a no-op and the game keeps running.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});

  const AudioCtor =
    global.AudioContext ||
    global.webkitAudioContext ||
    null;

  function AudioManager() {
    this.supported = !!AudioCtor;
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.engineRunning = false;

    this.master = null;
    this.engineGain = null;
    this.windGain = null;
    this.screechGain = null;
    this._noiseBuffer = null;
    this._nodes = {};
  }

  /* ---------------------------------------------------------------- lifecycle */

  /**
   * Create/resume the AudioContext. Must be called from (or after) a user
   * gesture, otherwise browsers keep the context suspended.
   */
  AudioManager.prototype.init = function () {
    if (!this.supported) return false;
    try {
      if (!this.ctx) {
        this.ctx = new AudioCtor();
        this._buildGraph();
      }
      if (this.ctx.state === 'suspended' && this.ctx.resume) {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
      this.ready = true;
      this._applyMute(true);
      return true;
    } catch (e) {
      this.supported = false;
      return false;
    }
  };

  AudioManager.prototype._buildGraph = function () {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(ctx.destination);

    // --- shared noise buffer (1s of white noise, looped where needed) ---
    const len = Math.floor(ctx.sampleRate * 1.0);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buf;

    // --- engine ---
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 900;
    engineFilter.Q.value = 6;
    engineGain.connect(engineFilter);
    engineFilter.connect(this.master);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 60;
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 90;
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.35;
    osc1.connect(engineGain);
    osc2.connect(osc2Gain);
    osc2Gain.connect(engineGain);

    const rumble = ctx.createBufferSource();
    rumble.buffer = buf;
    rumble.loop = true;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'bandpass';
    rumbleFilter.frequency.value = 180;
    rumbleFilter.Q.value = 0.9;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.5;
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(engineGain);

    // subtle rpm wobble
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 3.2;
    lfo.connect(lfoGain);
    lfoGain.connect(osc1.frequency);

    osc1.start();
    osc2.start();
    rumble.start();
    lfo.start();

    this.engineGain = engineGain;
    this._nodes.osc1 = osc1;
    this._nodes.osc2 = osc2;
    this._nodes.engineFilter = engineFilter;
    this._nodes.rumbleFilter = rumbleFilter;

    // --- wind ---
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 620;
    windFilter.Q.value = 0.6;
    const wind = ctx.createBufferSource();
    wind.buffer = buf;
    wind.loop = true;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.master);
    wind.start();
    this.windGain = windGain;

    // --- tyre screech ---
    const screechGain = ctx.createGain();
    screechGain.gain.value = 0;
    const screechFilter = ctx.createBiquadFilter();
    screechFilter.type = 'bandpass';
    screechFilter.frequency.value = 2300;
    screechFilter.Q.value = 9;
    const screech = ctx.createBufferSource();
    screech.buffer = buf;
    screech.loop = true;
    screech.connect(screechFilter);
    screechFilter.connect(screechGain);
    screechGain.connect(this.master);
    screech.start();
    this.screechGain = screechGain;
    this._nodes.screechFilter = screechFilter;
  };

  /* ------------------------------------------------------------------- muting */

  AudioManager.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    this._applyMute(false);
    return this.muted;
  };

  AudioManager.prototype.toggleMute = function () {
    return this.setMuted(!this.muted);
  };

  AudioManager.prototype._applyMute = function (instant) {
    if (!this.master) return;
    const target = this.muted ? 0 : 0.9;
    try {
      if (instant) {
        this.master.gain.value = target;
      } else {
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(this.master.gain.value, now);
        this.master.gain.linearRampToValueAtTime(target, now + 0.12);
      }
    } catch (e) {
      this.master.gain.value = target;
    }
  };

  /** Suspend audio when the tab is hidden / game paused. */
  AudioManager.prototype.suspend = function () {
    if (this.ctx && this.ctx.state === 'running' && this.ctx.suspend) {
      const p = this.ctx.suspend();
      if (p && p.catch) p.catch(function () {});
    }
  };

  AudioManager.prototype.unsuspend = function () {
    if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
  };

  /* ------------------------------------------------------------------ engine */

  AudioManager.prototype.startEngine = function () {
    if (!this.init()) return;
    this.engineRunning = true;
  };

  AudioManager.prototype.stopEngine = function () {
    this.engineRunning = false;
    if (!this.ready) return;
    this._ramp(this.engineGain.gain, 0, 0.18);
    this._ramp(this.windGain.gain, 0, 0.25);
    this._ramp(this.screechGain.gain, 0, 0.1);
  };

  /**
   * Per-frame engine update.
   * @param {number} speedNorm 0..1 of player max speed
   * @param {number} throttle  0..1
   * @param {number} slip      0..1 tyre slip (steer at speed / braking / grass)
   * @param {boolean} boosting
   */
  AudioManager.prototype.updateEngine = function (speedNorm, throttle, slip, boosting) {
    if (!this.ready || !this.engineRunning) return;

    const rpm = 46 + speedNorm * 132 + throttle * 26 + (boosting ? 34 : 0);
    const now = this.ctx.currentTime;

    try {
      this._nodes.osc1.frequency.setTargetAtTime(rpm, now, 0.06);
      this._nodes.osc2.frequency.setTargetAtTime(rpm * 1.503, now, 0.06);
      this._nodes.engineFilter.frequency.setTargetAtTime(
        420 + speedNorm * 1500 + throttle * 500, now, 0.09
      );
      this._nodes.rumbleFilter.frequency.setTargetAtTime(120 + speedNorm * 260, now, 0.12);

      const engineLevel = 0.055 + throttle * 0.05 + speedNorm * 0.05;
      this._ramp(this.engineGain.gain, engineLevel, 0.12);

      const windLevel = Math.pow(speedNorm, 2.1) * 0.085;
      this._ramp(this.windGain.gain, windLevel, 0.2);

      const screechLevel = Math.min(1, slip) * 0.075;
      this._ramp(this.screechGain.gain, screechLevel, 0.07);
      if (this._nodes.screechFilter) {
        this._nodes.screechFilter.frequency.setTargetAtTime(1900 + slip * 1400, now, 0.08);
      }
    } catch (e) {
      /* ignore - audio must never break the game loop */
    }
  };

  AudioManager.prototype._ramp = function (param, value, time) {
    try {
      const now = this.ctx.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(value, now + time);
    } catch (e) {
      try { param.value = value; } catch (e2) { /* noop */ }
    }
  };

  /* ---------------------------------------------------------------- one-shots */

  /** Generic short blip used by the UI. */
  AudioManager.prototype.blip = function (freq, dur, type, vol, slideTo) {
    if (!this.ready) { this.init(); }
    if (!this.ready) return;
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + dur);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(vol || 0.16, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    } catch (e) { /* noop */ }
  };

  AudioManager.prototype.playClick = function () { this.blip(520, 0.07, 'square', 0.10, 700); };
  AudioManager.prototype.playHover = function () { this.blip(880, 0.045, 'sine', 0.045); };

  AudioManager.prototype.playCountBeep = function (final) {
    if (final) {
      this.blip(660, 0.28, 'sawtooth', 0.14, 990);
      this.blip(990, 0.3, 'triangle', 0.1, 1320);
    } else {
      this.blip(420, 0.14, 'square', 0.1, 380);
    }
  };

  AudioManager.prototype.playNearMiss = function (combo) {
    const base = 620 + Math.min(6, combo) * 90;
    this.blip(base, 0.13, 'sine', 0.11, base * 1.9);
    // whoosh of air
    this._noiseBurst(0.22, 1500, 0.09, 'bandpass', 500);
  };

  AudioManager.prototype.playShieldBreak = function () {
    this._noiseBurst(0.35, 900, 0.3, 'bandpass', 260);
    this.blip(180, 0.25, 'square', 0.14, 70);
  };

  AudioManager.prototype.playScrape = function () {
    this._noiseBurst(0.3, 2600, 0.16, 'bandpass', 900);
  };

  AudioManager.prototype.playBoost = function () {
    this.blip(220, 0.35, 'sawtooth', 0.13, 880);
    this._noiseBurst(0.35, 700, 0.12, 'lowpass', 300);
  };

  /** Big crash: noise slam + sub thud + metallic ring. */
  AudioManager.prototype.playCrash = function (intensity) {
    const i = Math.max(0.35, Math.min(1, intensity || 1));
    if (!this.ready) { this.init(); }
    if (!this.ready) return;
    this._noiseBurst(0.55 * i + 0.2, 1200, 0.5 * i, 'lowpass', 180);
    this.blip(90 * i + 40, 0.5, 'sine', 0.34 * i, 28);
    this.blip(320, 0.34, 'square', 0.1 * i, 60);
    // metallic debris ring
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;
      for (let k = 0; k < 3; k++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        const f = 700 + Math.random() * 1600;
        osc.frequency.setValueAtTime(f, now);
        osc.frequency.exponentialRampToValueAtTime(f * 0.4, now + 0.4);
        gain.gain.setValueAtTime(0.0001, now + k * 0.03);
        gain.gain.exponentialRampToValueAtTime(0.06 * i, now + 0.02 + k * 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5 + k * 0.05);
        osc.connect(gain);
        gain.connect(this.master);
        osc.start(now + k * 0.03);
        osc.stop(now + 0.7);
      }
    } catch (e) { /* noop */ }
  };

  AudioManager.prototype._noiseBurst = function (dur, freq, vol, type, sweepTo) {
    if (!this.ready) { this.init(); }
    if (!this.ready) return;
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = type || 'lowpass';
      filter.frequency.setValueAtTime(freq, now);
      if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), now + dur);
      filter.Q.value = 1.1;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(vol, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      src.start(now);
      src.stop(now + dur + 0.05);
    } catch (e) { /* noop */ }
  };

  Racer.AudioManager = AudioManager;
})(typeof window !== 'undefined' ? window : globalThis);
