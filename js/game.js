/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - game.js
 * ----------------------------------------------------------------------------
 *  Game state management + the requestAnimationFrame loop.
 *
 *  States:  menu -> countdown -> playing <-> paused -> crashing -> gameover
 *           (any running state can return to menu)
 *
 *  This module owns:
 *    - difficulty management (selecting a preset and applying it to the run)
 *    - scoring, combos and near-miss bonuses
 *    - crash resolution (shields, spin-outs, slow-motion wreck sequence)
 *    - effects orchestration (particles, screen shake, audio cues)
 *    - the attract-mode flyby that plays behind the main menu
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;
  const CFG = Racer.CONFIG;
  const DIFFS = Racer.DIFFICULTIES;
  const SC = CFG.SCORING;

  /* ------------------------------------------------------------------ *
   *  Difficulty management
   * ------------------------------------------------------------------ */
  const Difficulty = {
    ids: Racer.DIFFICULTY_ORDER.slice(),

    get: function (id) {
      return DIFFS[id] || DIFFS.medium;
    },

    /** Saved choice (falls back to medium). */
    load: function () {
      const saved = U.storage.get(CFG.STORAGE.DIFFICULTY, 'medium');
      return DIFFS[saved] ? saved : 'medium';
    },

    save: function (id) {
      U.storage.set(CFG.STORAGE.DIFFICULTY, id);
    },

    /** Human readable summary used by the menu + tests. */
    describe: function (id) {
      const d = Difficulty.get(id);
      return {
        id: d.id,
        label: d.label,
        cars: d.traffic.minCars + '-' + d.traffic.maxCars +
              ' (+' + d.ramp.extraCars + ' later)',
        trafficSpeed: Math.round(d.traffic.speedMin * CFG.UNITS.PX_TO_KMH) + '-' +
                      Math.round(d.traffic.speedMax * CFG.UNITS.PX_TO_KMH) + ' km/h',
        gap: d.traffic.gapMin + ' px',
        shields: d.shields,
        score: 'x' + d.scoreMultiplier
      };
    }
  };

  /* ------------------------------------------------------------------ *
   *  Game
   * ------------------------------------------------------------------ */

  function Game(canvas) {
    this.canvas = canvas;

    this.world = new Racer.World();
    this.renderer = new Racer.Renderer(canvas, this.world);
    this.input = new Racer.InputManager();
    this.audio = new Racer.AudioManager();
    this.particles = new Racer.ParticleSystem(CFG.FX.MAX_PARTICLES);
    this.player = new Racer.PlayerCar();
    this.traffic = new Racer.TrafficManager(this.world);

    this.touchMode = false;
    this.ui = new Racer.UI(this);

    this.state = 'menu';
    this.prevState = 'menu';
    this.difficulty = DIFFS.medium;

    this.time = 0;            // global clock (always advances, used by FX)
    this.raceTime = 0;        // seconds survived this run
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.timeScale = 1;
    this.crashed = false;
    this.crashTimer = 0;
    this.crashFlash = 0;
    this.countdownIndex = 0;
    this.countdownTimer = 0;

    this.fps = 60;
    this._lastTs = 0;
    this._rafId = 0;
    this._running = false;
    this._lastScoredDist = 0;

    this.stats = { nearMisses: 0, shieldsLost: 0, best: 0, bestDist: 0 };
    this.bestScore = U.storage.getNumber(CFG.STORAGE.BEST_SCORE, 0);
    this.bestDist = U.storage.getNumber(CFG.STORAGE.BEST_DIST, 0);
    this.stats.best = this.bestScore;
  }

  /* ------------------------------------------------------------------ init */

  Game.prototype.init = function () {
    if (!this.renderer.ctx) {
      if (this.ui.el.fatal) this.ui.el.fatal.removeAttribute('hidden');
      return this;
    }

    this.ui.init();
    this.touchMode = this.ui.detectTouch();

    const saved = Difficulty.load();
    this.setDifficulty(saved, false);
    this.ui.setMutedUI(this.audio.muted = U.storage.get(CFG.STORAGE.MUTED, '0') === '1');

    this.input.attach(this.ui.el.touch);
    this._wireInput();

    // attract mode camera for the menu
    this._resetRun(true);
    this.setState('menu');
    this.ui.showScreen('menu');

    if (global.addEventListener) {
      global.addEventListener('resize', this._onResize = this._handleResize.bind(this));
      global.addEventListener('orientationchange', this._onResize);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this._onVisibility = () => {
          if (document.hidden && (this.state === 'playing' || this.state === 'countdown')) {
            this.togglePause(true);
          }
        });
      }
    }

    this._handleResize();
    return this;
  };

  Game.prototype._handleResize = function () {
    // fitStage() also re-sizes the renderer to the stage's new CSS size
    this.ui.fitStage();
    this.ui._initSpeedo();
  };

  Game.prototype._wireInput = function () {
    const self = this;
    this.input.onPause = function () {
      if (self.state === 'playing' || self.state === 'countdown' || self.state === 'paused') {
        self.togglePause();
      }
    };
    this.input.onRestart = function () {
      if (self.state === 'gameover' || self.state === 'paused' || self.state === 'playing') {
        self.restart();
      }
    };
    this.input.onMute = function () {
      self.ui.toggleMute();
    };
    this.input.onConfirm = function () {
      if (self.state === 'menu') self.startRace();
      else if (self.state === 'gameover') self.restart();
      else if (self.state === 'paused') self.togglePause();
    };
    this.input.onAnyKey = function () {
      // Any interaction is a valid user gesture for unlocking WebAudio.
      self.audio.init();
    };
    // Auto-pause when the window loses focus mid-race.
    global.addEventListener('blur', function () {
      if (self.state === 'playing' || self.state === 'countdown') self.togglePause(true);
    });
  };

  /* ------------------------------------------------------------- difficulty */

  Game.prototype.setDifficulty = function (id, announce) {
    this.difficulty = Difficulty.get(id);
    Difficulty.save(this.difficulty.id);
    this.ui.syncDifficulty(this.difficulty.id);
    if (announce) {
      this.audio.playClick();
      this.ui.toast(this.difficulty.label.toUpperCase() + ' selected');
    }
    return this.difficulty;
  };

  /* ----------------------------------------------------------------- states */

  Game.prototype.setState = function (state) {
    if (this.state !== state) this.prevState = this.state;
    this.state = state;
  };

  /** Reset everything for a fresh run (or for the menu attract mode). */
  Game.prototype._resetRun = function (attract) {
    this.world.reset();
    this.particles.clear();
    this.player.reset(this.difficulty);
    this.traffic.reset(this.difficulty, 0);
    this.renderer.camera.snapTo(this.player);

    this.time = 0;
    this.raceTime = 0;
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.timeScale = 1;
    this.crashed = false;
    this.crashTimer = 0;
    this.crashFlash = 0;
    this.countdownIndex = 0;
    this.countdownTimer = 0;
    this._lastScoredDist = 0;
    this.stats.nearMisses = 0;
    this.stats.shieldsLost = 0;

    if (attract) {
      // start the menu flyby somewhere scenic, mid-highway
      this.player.dist = 3600;
      this.player.x = this.world.centerXAt(this.player.dist);
      this.player.speed = 250;
      this.world.updateCurveScale(this.player.meters());
      this.renderer.camera.snapTo(this.player);
      this.traffic.reset(this.difficulty, this.player.dist);
    }
    this.ui._last = {};
  };

  /** PLAY button / Enter on the menu. */
  Game.prototype.startRace = function () {
    this.audio.init();
    this._resetRun(false);
    this.setState('countdown');
    this.countdownIndex = 0;
    this.countdownTimer = CFG.COUNTDOWN.STEP_TIME;
    this.ui.showScreen('countdown');
    this.ui.setCountdown(CFG.COUNTDOWN.STEPS[0], 'Get ready');
    this.ui.setBest(this.bestScore);
    this.audio.startEngine();
    this.audio.playCountBeep(false);
    this.input.releaseAll();
  };

  Game.prototype.restart = function () {
    this.startRace();
  };

  Game.prototype.toMenu = function () {
    this.audio.stopEngine();
    this._resetRun(true);
    this.setState('menu');
    this.ui.showScreen('menu');
    this.ui.refreshMenuStats();
    this.input.releaseAll();
  };

  Game.prototype.togglePause = function (force) {
    if (this.state === 'playing' || this.state === 'countdown') {
      if (force === false) return;
      this.pausedFrom = this.state;
      this.setState('paused');
      this.ui.showPauseStats({
        score: this.score,
        meters: this.player.meters(),
        currentSpeed: this.player.kmh(),
        shields: this.player.shields
      });
      this.ui.showScreen('paused');
      this.audio.suspend();
      this.input.releaseAll();
    } else if (this.state === 'paused') {
      const back = this.pausedFrom === 'countdown' ? 'countdown' : 'playing';
      this.setState(back);
      if (back === 'countdown') this.countdownTimer = CFG.COUNTDOWN.STEP_TIME;
      this.ui.showScreen(back);
      this.audio.unsuspend();
      this._lastTs = 0;
    }
  };

  Game.prototype.toggleMute = function () {
    const muted = this.audio.toggleMute();
    U.storage.set(CFG.STORAGE.MUTED, muted ? '1' : '0');
    this.ui.setMutedUI(muted);
    if (!muted) {
      this.audio.init();
      this.audio.playClick();
    }
    this.ui.toast(muted ? 'Sound off' : 'Sound on');
    return muted;
  };

  /* ------------------------------------------------------------------- loop */

  Game.prototype.start = function () {
    if (this._running) return;
    this._running = true;
    const self = this;
    const step = function (ts) {
      self._rafId = global.requestAnimationFrame(step);
      self.frame(ts);
    };
    this._rafId = global.requestAnimationFrame(step);
  };

  Game.prototype.stop = function () {
    this._running = false;
    if (this._rafId && global.cancelAnimationFrame) global.cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  };

  /** One tick. Split out from rAF so the headless test harness can drive it. */
  Game.prototype.frame = function (ts) {
    const now = ts || (global.performance && global.performance.now ? global.performance.now() : Date.now());
    if (!this._lastTs) this._lastTs = now;
    let dtReal = (now - this._lastTs) / 1000;
    this._lastTs = now;
    if (!isFinite(dtReal) || dtReal < 0) dtReal = 0;
    dtReal = Math.min(dtReal, 0.05);          // never spiral after a stall

    this.fps = this.fps * 0.9 + (dtReal > 0 ? 1 / dtReal : 60) * 0.1;

    this.update(dtReal);
    this.render();

    if (this.state === 'playing' || this.state === 'countdown' || this.state === 'paused') {
      this.ui.updateHUD(this);
    }
  };

  Game.prototype.update = function (dtReal) {
    this.time += dtReal;
    this.world.time += dtReal;
    if (this.crashFlash > 0) this.crashFlash = Math.max(0, this.crashFlash - dtReal * 2.4);

    switch (this.state) {
      case 'menu':
        this._updateAttract(dtReal);
        break;
      case 'countdown':
        this._updateCountdown(dtReal);
        break;
      case 'playing':
        this._updatePlaying(dtReal);
        break;
      case 'crashing':
        this._updateCrash(dtReal);
        break;
      case 'gameover':
        this.particles.update(dtReal * 0.35);
        this.renderer.camera.update(dtReal * 0.25, this.player);
        break;
      case 'paused':
      default:
        break;
    }
  };

  /* ------------------------------------------------------------ attract mode */

  Game.prototype._updateAttract = function (dt) {
    const p = this.player;
    p.speed = U.damp(p.speed, 265, 1.2, dt);
    p.dist += p.speed * dt;
    // gentle autonomous weaving so the camera and road curves show off
    const weave = Math.sin(p.dist * 0.0016) * 96 + Math.sin(p.dist * 0.00061) * 40;
    p.x = this.world.centerXAt(p.dist) + weave;
    p.lateralVel = Math.cos(p.dist * 0.0016) * 96 * 0.0016 * p.speed;
    p.yaw = U.clamp(p.lateralVel * 0.0009, -0.24, 0.24);
    p.boostPower = 0;
    p.braking = 0;

    this.traffic.updateRamp(0);
    this.traffic.update(dt, p);
    this.world.updateCurveScale(0);
    this.particles.update(dt);
    this.renderer.camera.update(dt, p);
    this.audio.updateEngine(0.2, 0.2, 0, false);
  };

  /* --------------------------------------------------------------- countdown */

  Game.prototype._updateCountdown = function (dt) {
    const steps = CFG.COUNTDOWN.STEPS;
    this.countdownTimer -= dt;
    this.renderer.camera.update(dt, this.player);
    this.particles.update(dt);

    // rev the engine while waiting on the line
    this.player.speed = 0;
    this.audio.updateEngine(0.05 + Math.abs(Math.sin(this.time * 9)) * 0.22, 1, 0, false);

    if (this.countdownTimer > 0) return;

    this.countdownIndex++;

    if (this.countdownIndex >= steps.length - 1) {
      // "GO!" - hand control straight to the player
      this.ui.setCountdown(steps[steps.length - 1], 'GO GO GO!');
      this.audio.playCountBeep(true);
      this.setState('playing');
      this.ui.showScreen('playing');
      this._lastScoredDist = this.player.dist;
      this.particles.popup(this.player.x, this.player.dist + 130, 'GO!', '#3ddc97', 34);
    } else {
      this.countdownTimer = CFG.COUNTDOWN.STEP_TIME;
      const isLast = this.countdownIndex === steps.length - 2;
      this.ui.setCountdown(steps[this.countdownIndex], isLast ? 'Steady...' : 'Get ready');
      this.audio.playCountBeep(false);
    }
  };

  /* ------------------------------------------------------------------ racing */

  Game.prototype._updatePlaying = function (dtReal) {
    const dt = dtReal * this.timeScale;
    const p = this.player;
    const world = this.world;

    this.raceTime += dt;

    /* --- difficulty ramp with progress --- */
    const meters = p.meters();
    this.traffic.updateRamp(meters);
    world.updateCurveScale(meters);

    /* --- simulate (sub-stepped for reliable collision at low FPS) --- */
    const MAX_STEP = 1 / 120;
    let remaining = dt;
    let guard = 0;
    while (remaining > 0.0001 && guard++ < 8) {
      const step = Math.min(MAX_STEP, remaining);
      remaining -= step;

      const ev = p.update(step, this.input, world);
      this.traffic.update(step, p);

      /* --- collisions --- */
      const result = Racer.Collision.scan(p, this.traffic, step);
      if (result.hits.length) this._handleHit(result.hits[0]);
      if (result.nearMisses.length) this._handleNearMiss(result.nearMisses);

      /* --- barrier scrape --- */
      if (ev.barrier) this._handleBarrier(p);

      /* --- grass entry --- */
      if (ev.grassStart) {
        this.ui.toast('OFF ROAD!', 'warn');
        this.audio.playScrape();
        this.renderer.camera.addShake(5);
      }

      if (ev.boostStart) {
        this.audio.playBoost();
        this.ui.toast('BOOST!', 'good');
      }

      if (this.state !== 'playing') break;   // a crash may have ended the run
    }

    if (this.state !== 'playing') {
      // crash sequence takes over the rest of the frame
      this._updateCrash(dtReal);
      return;
    }

    /* --- scoring --- */
    this._updateScore(dt, p);

    /* --- particles & effects --- */
    this._updateEffects(p);
    this.particles.update(dt);

    /* --- camera --- */
    this.renderer.camera.update(dt, p);

    /* --- audio --- */
    this.audio.updateEngine(
      U.clamp(p.speed / CFG.PLAYER.MAX_SPEED, 0, 1.3),
      this.input.throttle(),
      p.slip,
      p.boosting
    );

    /* --- combo decay --- */
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.comboTimer = 0;
        this.combo = 1;
      }
    }
  };

  Game.prototype._updateScore = function (dt, p) {
    const offFactor = p.offRoad ? SC.OFFROAD_SCORE_FACTOR : 1;
    const gained = (p.dist - this._lastScoredDist) * CFG.UNITS.PX_TO_METERS;
    this._lastScoredDist = p.dist;

    this.score += gained * SC.DISTANCE_POINTS_PER_M * this.combo * this.difficulty.scoreMultiplier * offFactor;

    const kmh = p.kmh();
    if (kmh > SC.SPEED_BONUS_THRESHOLD) {
      const over = (kmh - SC.SPEED_BONUS_THRESHOLD) / 100;
      this.score += SC.SPEED_BONUS_PER_S * over * dt * this.combo * this.difficulty.scoreMultiplier;
    }
  };

  Game.prototype._updateEffects = function (p) {
    // tyre smoke when sliding
    if (p.slip > 0.42 && p.speed > 60) {
      const amount = Math.random() < p.slip * 0.9 ? 1 : 0;
      if (amount) {
        const rear = p.dist - p.hl * 0.85;
        this.particles.smoke(p.x - p.hw * 0.75, rear, 1);
        this.particles.smoke(p.x + p.hw * 0.75, rear, 1);
      }
    }

    // grass spray
    if (p.offRoad && p.speed > 40 && Math.random() < 0.75) {
      this.particles.dust(p.x + U.rand(-p.hw, p.hw), p.dist - p.hl * 0.8, 2);
      this.renderer.camera.addShake(0.6);
    }

    // boost flames
    if (p.boosting && p.boostPower > 0.2) {
      this.particles.flame(p.x - p.hw * 0.42, p.dist - p.hl * 1.02, p.boostPower);
      this.particles.flame(p.x + p.hw * 0.42, p.dist - p.hl * 1.02, p.boostPower);
    }

    // NOTE: no speed-based camera shake on purpose - the camera only reacts
    // to real events (crashes, barrier scrapes, leaving the tarmac).
  };

  /* ------------------------------------------------------------ crash logic */

  Game.prototype._handleHit = function (hit) {
    const p = this.player;
    const car = hit.car;
    const destroyed = p.damage(hit.severity);

    p.applyCrash(hit.severity);

    // shove the traffic car so the wreck reads physically
    car.dist += 26 + hit.severity * 40;
    car.speed *= 0.62;
    car.x += hit.sideSign * -10;
    car.brakeCheck = 0.8;

    // effects
    const cx = hit.contactX;
    const cd = hit.contactDist;
    this.particles.sparks(cx, cd, hit.sideSign * -1, 1, Math.round(14 + hit.severity * 26));
    this.particles.debris(cx, cd, p.palette.body, Math.round(8 + hit.severity * 16));
    this.particles.smoke(cx, cd, 6);
    this.particles.ring(cx, cd, '#ffd166', 14 + hit.severity * 18, 0.4);
    this.particles.popup(cx, cd + 40, destroyed ? 'WRECKED!' : 'SHIELD LOST', destroyed ? '#ff4d6d' : '#ffc857', 20);
    this.renderer.camera.addShake(9 + hit.severity * 17);
    this.crashFlash = 0.55;

    this.stats.shieldsLost++;

    if (destroyed) {
      this.audio.playCrash(U.clamp(hit.severity, 0.4, 1));
      this._beginCrashSequence();
    } else {
      this.audio.playShieldBreak();
      this.ui.toast('Shield lost - ' + p.shields + ' remaining', 'bad');
      this.combo = 1;
      this.comboTimer = 0;
    }
  };

  Game.prototype._handleBarrier = function (p) {
    this.particles.sparks(p.x, p.dist, Math.sign(p.x - this.world.centerXAt(p.dist)) * -1, 0.4, 16);
    this.particles.smoke(p.x, p.dist - p.hl * 0.5, 3);
    this.renderer.camera.addShake(9);
    this.crashFlash = Math.max(this.crashFlash, 0.2);
    this.audio.playScrape();
    this.ui.toast('Barrier!', 'warn');
    this.combo = 1;
  };

  Game.prototype._handleNearMiss = function (misses) {
    for (let i = 0; i < misses.length; i++) {
      const m = misses[i];
      this.combo = Math.min(SC.COMBO_MAX, this.combo + SC.COMBO_STEP);
      this.comboTimer = SC.COMBO_TIMEOUT;
      this.stats.nearMisses++;

      const points = SC.NEAR_MISS_BASE * this.combo * this.difficulty.scoreMultiplier;
      this.score += points;

      this.player.boostFuel = Math.min(CFG.PLAYER.BOOST_MAX, this.player.boostFuel + CFG.PLAYER.BOOST_NEAR_MISS);

      const tight = m.clearance < SC.NEAR_MISS_WINDOW * 0.45;
      this.particles.popup(
        m.car.x, m.car.dist - 30,
        '+' + Math.round(points) + (tight ? '  CLOSE!' : ''),
        tight ? '#8ee6ff' : '#ffe066',
        tight ? 20 : 17
      );
      this.audio.playNearMiss(this.combo);
      if (this.combo >= SC.COMBO_MAX) this.ui.toast('MAX COMBO x' + this.combo.toFixed(1), 'good');
    }
  };

  Game.prototype._beginCrashSequence = function () {
    this.crashed = true;
    this.setState('crashing');
    this.crashTimer = CFG.FX.CRASH_SLOWMO_TIME;
    this.timeScale = CFG.FX.CRASH_SLOWMO;
    this.renderer.camera.addShake(CFG.CAMERA.MAX_SHAKE);
    this.crashFlash = 1;
    this.input.releaseAll();

    // big wreck FX
    const p = this.player;
    this.particles.debris(p.x, p.dist, p.palette.body, 30);
    this.particles.sparks(p.x, p.dist, 0, 0, 42);
    this.particles.ring(p.x, p.dist, '#ff9f1c', 22, 0.6);
    this.particles.ring(p.x, p.dist, '#ffffff', 10, 0.35);
    this.particles.smoke(p.x, p.dist, 16);
  };

  Game.prototype._updateCrash = function (dtReal) {
    const dt = dtReal * this.timeScale;
    this.crashTimer -= dtReal;

    // wreck keeps drifting and smoking in slow motion
    const p = this.player;
    p.speed = U.approach(p.speed, 0, 120 * dt);
    p.dist += p.speed * dt;
    p.spin = Math.max(0, p.spin - dt);
    p.yaw += dt * 3.4 * (p.spin > 0 ? 1 : 0.2);
    p.x += p.lateralVel * dt * 0.4;
    p.lateralVel *= Math.exp(-2.4 * dt);

    this.traffic.update(dt, p);
    this.particles.update(dt);

    if (Math.random() < 0.6) {
      this.particles.smoke(p.x + U.rand(-12, 12), p.dist + U.rand(-14, 14), 2);
    }
    if (Math.random() < 0.18) {
      this.particles.sparks(p.x, p.dist, 0, 0, 2, '#ff9f1c');
    }

    this.renderer.camera.update(dtReal, p);
    this.audio.updateEngine(0.1, 0, 0.4, false);

    // ease back toward normal time so the wreck settles
    this.timeScale = U.lerp(this.timeScale, 0.55, dtReal * 1.4);

    if (this.crashTimer <= 0) {
      this.audio.stopEngine();
      this.gameOver();
    }
  };

  /* -------------------------------------------------------------- game over */

  Game.prototype.gameOver = function () {
    this.timeScale = 1;
    this.setState('gameover');

    const p = this.player;
    const finalScore = Math.floor(this.score);
    const meters = p.meters();
    const isRecord = finalScore > this.bestScore;

    if (isRecord) {
      this.bestScore = finalScore;
      U.storage.set(CFG.STORAGE.BEST_SCORE, finalScore);
    }
    if (meters > this.bestDist) {
      this.bestDist = meters;
      U.storage.set(CFG.STORAGE.BEST_DIST, Math.floor(meters));
    }
    this.stats.best = this.bestScore;

    const kickers = p.offRoad
      ? ['Lost it on the grass', 'Off-road ending']
      : ['Totalled', 'Run ended', 'That\'s a wreck', 'Barrier bait'];

    this.ui.showGameOver({
      score: finalScore,
      best: this.bestScore,
      isRecord: isRecord,
      meters: meters,
      topSpeed: p.topSpeed,
      nearMisses: this.stats.nearMisses,
      time: this.raceTime,
      difficulty: this.difficulty.label,
      kicker: isRecord ? 'New record!' : U.pick(kickers)
    });
    this.ui.refreshMenuStats();
  };

  /* ------------------------------------------------------------------ render */

  Game.prototype.render = function () {
    this.renderer.render(this);
  };

  Racer.Difficulty = Difficulty;
  Racer.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
