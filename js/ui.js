/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - ui.js
 * ----------------------------------------------------------------------------
 *  All DOM work: main menu, difficulty cards, HUD, speedometer gauge,
 *  countdown, pause card, game-over card, toasts and responsive stage sizing.
 *
 *  The UI never mutates game state directly - it calls methods on the Game
 *  instance, and the Game pushes fresh values in through updateHUD().
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;
  const CFG = Racer.CONFIG;
  const DIFFS = Racer.DIFFICULTIES;
  const ORDER = Racer.DIFFICULTY_ORDER;

  const doc = typeof document !== 'undefined' ? document : null;

  function $(id) {
    return doc ? doc.getElementById(id) : null;
  }

  function UI(game) {
    this.game = game;
    this.el = {};
    this.difficulty = 'medium';
    this.currentScreen = 'menu';
    this._last = {};
    this.speedoCtx = null;
    this.speedoSize = 176;
    this.toasts = [];
  }

  /* ------------------------------------------------------------------- init */

  UI.prototype.init = function () {
    if (!doc) return this;
    const ids = [
      'stage', 'game', 'hud', 'menu', 'pause', 'gameover', 'countdown', 'fatal', 'touch',
      'hudScore', 'hudDistance', 'hudBest', 'hudDifficulty', 'hudShields', 'hudCombo',
      'hudComboMult', 'hudComboBar', 'hudSpeed', 'hudBoostBar', 'hudBoostWrap',
      'btnMute', 'btnPause', 'btnPlay', 'btnSound', 'soundState', 'soundDot',
      'difficultyList', 'diffNote', 'menuBest', 'menuBestDist',
      'countText', 'countSub', 'btnResume', 'btnRestartPause', 'btnQuit',
      'overScore', 'overBest', 'overStats', 'overTitle', 'overKicker',
      'btnRestart', 'btnMenu', 'toasts', 'speedo', 'speedoWrap', 'pauseStats'
    ];
    for (let i = 0; i < ids.length; i++) this.el[ids[i]] = $(ids[i]);

    this._buildDifficultyCards();
    this._wireButtons();
    this._initSpeedo();
    this.refreshMenuStats();
    this.fitStage();
    return this;
  };

  /* ------------------------------------------------------- difficulty cards */

  UI.prototype._buildDifficultyCards = function () {
    const list = this.el.difficultyList;
    if (!list) return;
    list.innerHTML = '';

    for (let i = 0; i < ORDER.length; i++) {
      const d = DIFFS[ORDER[i]];
      const card = doc.createElement('button');
      card.type = 'button';
      card.className = 'diff';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', 'false');
      card.dataset.diff = d.id;
      card.style.setProperty('--diff-color', d.color);

      card.innerHTML =
        '<span class="diff__head">' +
          '<span class="diff__name">' + d.label + '</span>' +
          '<span class="diff__tag">' + d.tagline + '</span>' +
        '</span>' +
        '<span class="diff__meters">' +
          meter('Traffic', (d.traffic.maxCars - 1) / 13) +
          meter('Speed', (d.traffic.speedMax - 100) / 200) +
          meter('Aggression', d.traffic.laneChangeRate / 0.26) +
        '</span>' +
        '<span class="diff__foot">' +
          '<span class="diff__cars">' + d.traffic.minCars + '&ndash;' + d.traffic.maxCars + ' cars</span>' +
          '<span class="diff__shields" title="Shields">' + shieldPips(d.shields) + '</span>' +
          '<span class="diff__mult">x' + d.scoreMultiplier.toFixed(1) + ' score</span>' +
        '</span>' +
        '<span class="diff__blurb">' + d.blurb + '</span>';

      const self = this;
      card.addEventListener('click', function () {
        // the Game owns the authoritative difficulty; UI just asks it to change
        self.game.setDifficulty(d.id, true);
      });
      card.addEventListener('mouseenter', function () {
        self.game.audio.playHover();
      });
      list.appendChild(card);
    }

    function meter(label, value) {
      const v = Math.round(U.clamp(value, 0.06, 1) * 100);
      return '<span class="meter"><span class="meter__label">' + label + '</span>' +
        '<span class="meter__bar"><i style="width:' + v + '%"></i></span></span>';
    }

    function shieldPips(n) {
      let s = '';
      for (let k = 0; k < 3; k++) {
        s += '<i class="pip' + (k < n ? ' pip--on' : '') + '"></i>';
      }
      return s;
    }
  };

  /**
   * Visual-only sync of the difficulty picker (called by Game.setDifficulty,
   * which is the single source of truth).
   */
  UI.prototype.syncDifficulty = function (id) {
    if (!DIFFS[id]) return;
    this.difficulty = id;
    const list = this.el.difficultyList;
    if (list) {
      const cards = list.querySelectorAll('.diff');
      for (let i = 0; i < cards.length; i++) {
        const on = cards[i].dataset.diff === id;
        cards[i].classList.toggle('is-active', on);
        cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
    if (this.el.diffNote) {
      this.el.diffNote.textContent = DIFFS[id].blurb;
    }
    U.storage.set(CFG.STORAGE.DIFFICULTY, id);
  };

  /** Kept for readability at call sites that only care about the picker. */
  UI.prototype.setDifficulty = function (id, userAction) {
    if (userAction && this.game) this.game.setDifficulty(id, true);
    else this.syncDifficulty(id);
  };

  UI.prototype.getDifficulty = function () {
    return this.difficulty;
  };

  /* --------------------------------------------------------------- buttons */

  UI.prototype._wireButtons = function () {
    const g = this.game;
    const self = this;

    const click = function (el, fn) {
      if (!el) return;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        self.game.audio.init();
        self.game.audio.playClick();
        fn();
      });
    };

    click(this.el.btnPlay, function () { g.startRace(); });
    click(this.el.btnResume, function () { g.togglePause(); });
    click(this.el.btnRestartPause, function () { g.restart(); });
    click(this.el.btnQuit, function () { g.toMenu(); });
    click(this.el.btnRestart, function () { g.restart(); });
    click(this.el.btnMenu, function () { g.toMenu(); });
    click(this.el.btnPause, function () { g.togglePause(); });
    click(this.el.btnMute, function () { self.toggleMute(); });
    click(this.el.btnSound, function () { self.toggleMute(); });

    // Touch pad buttons are handled by InputManager (pointer events).
    if (this.el.touch) {
      const buttons = this.el.touch.querySelectorAll('.tbtn');
      for (let i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('pointerdown', function () {
          self.game.audio.init();
        });
      }
    }
  };

  UI.prototype.toggleMute = function () {
    const muted = this.game.toggleMute();
    this.setMutedUI(muted);
    return muted;
  };

  UI.prototype.setMutedUI = function (muted) {
    if (this.el.btnMute) this.el.btnMute.classList.toggle('is-muted', !!muted);
    if (this.el.soundState) this.el.soundState.textContent = muted ? 'Off' : 'On';
    if (this.el.soundDot) this.el.soundDot.classList.toggle('is-off', !!muted);
    if (this.el.btnSound) this.el.btnSound.setAttribute('aria-pressed', muted ? 'true' : 'false');
  };

  /* -------------------------------------------------------------- screens */

  UI.prototype.showScreen = function (name) {
    this.currentScreen = name;
    const set = function (el, visible) {
      if (!el) return;
      if (visible) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    };
    set(this.el.menu, name === 'menu');
    set(this.el.pause, name === 'paused');
    set(this.el.gameover, name === 'gameover');
    set(this.el.countdown, name === 'countdown');
    set(this.el.hud, name === 'playing' || name === 'countdown' || name === 'paused');
    set(this.el.touch, (name === 'playing' || name === 'countdown') && this.game.touchMode);

    if (this.el.stage) {
      this.el.stage.classList.toggle('is-menu', name === 'menu');
      this.el.stage.classList.toggle('is-playing', name !== 'menu');
    }
  };

  UI.prototype.refreshMenuStats = function () {
    const best = U.storage.getNumber(CFG.STORAGE.BEST_SCORE, 0);
    const bestDist = U.storage.getNumber(CFG.STORAGE.BEST_DIST, 0);
    if (this.el.menuBest) this.el.menuBest.textContent = U.formatNumber(best);
    if (this.el.menuBestDist) this.el.menuBestDist.textContent = U.formatDistance(bestDist);
  };

  /* ------------------------------------------------------------- countdown */

  UI.prototype.setCountdown = function (text, sub) {
    if (!this.el.countText) return;
    if (this.el.countText.textContent !== text) {
      this.el.countText.textContent = text;
      // retrigger the pop animation
      this.el.countText.classList.remove('is-pop');
      void this.el.countText.offsetWidth;
      this.el.countText.classList.add('is-pop');
    }
    if (this.el.countSub && sub !== undefined) this.el.countSub.textContent = sub;
  };

  /* ------------------------------------------------------------------- HUD */

  UI.prototype.updateHUD = function (g) {
    const p = g.player;
    const el = this.el;
    const last = this._last;

    const score = Math.floor(g.score);
    if (last.score !== score && el.hudScore) {
      el.hudScore.textContent = U.formatNumber(score);
      last.score = score;
    }

    const meters = p.meters();
    const distText = U.formatDistance(meters);
    if (last.distText !== distText && el.hudDistance) {
      el.hudDistance.textContent = distText;
      last.distText = distText;
    }

    const kmh = Math.round(p.kmh());
    if (last.kmh !== kmh && el.hudSpeed) {
      el.hudSpeed.textContent = kmh;
      last.kmh = kmh;
    }

    if (el.hudDifficulty && last.diff !== g.difficulty.id) {
      el.hudDifficulty.textContent = g.difficulty.label.toUpperCase();
      el.hudDifficulty.style.setProperty('--diff-color', g.difficulty.color);
      last.diff = g.difficulty.id;
    }

    if (el.hudShields && last.shields !== p.shields) {
      let html = '';
      for (let i = 0; i < g.difficulty.shields; i++) {
        html += '<i class="shield' + (i < p.shields ? ' shield--on' : '') + '"></i>';
      }
      el.hudShields.innerHTML = html;
      last.shields = p.shields;
    }

    const boostPct = Math.round(p.boostFuel);
    if (last.boost !== boostPct && el.hudBoostBar) {
      el.hudBoostBar.style.width = boostPct + '%';
      el.hudBoostBar.classList.toggle('is-full', boostPct >= 99);
      last.boost = boostPct;
    }
    if (el.hudBoostWrap) {
      const active = p.boosting;
      if (last.boosting !== active) {
        el.hudBoostWrap.classList.toggle('is-active', active);
        last.boosting = active;
      }
    }

    const combo = g.combo;
    if (el.hudCombo) {
      const show = combo > 1.01 && g.comboTimer > 0;
      if (last.comboShow !== show) {
        if (show) el.hudCombo.removeAttribute('hidden');
        else el.hudCombo.setAttribute('hidden', '');
        last.comboShow = show;
      }
      if (show) {
        const mult = 'x' + combo.toFixed(2).replace(/0$/, '');
        if (last.comboMult !== mult && el.hudComboMult) {
          el.hudComboMult.textContent = mult;
          last.comboMult = mult;
        }
        if (el.hudComboBar) {
          el.hudComboBar.style.width = U.clamp(g.comboTimer / CFG.SCORING.COMBO_TIMEOUT, 0, 1) * 100 + '%';
        }
      }
    }

    if (last.offRoad !== p.offRoad && el.stage) {
      el.stage.classList.toggle('is-offroad', p.offRoad && g.state === 'playing');
      last.offRoad = p.offRoad;
    }

    this.drawSpeedo(kmh, p.speedNorm(), p.boostPower, p.boosting);
  };

  UI.prototype.setBest = function (value) {
    if (this.el.hudBest) this.el.hudBest.textContent = U.formatNumber(value);
    this._last.best = value;
  };

  /* ----------------------------------------------------------- speedometer */

  UI.prototype._initSpeedo = function () {
    const c = this.el.speedo;
    if (!c) return;
    const dpr = U.clamp(global.devicePixelRatio || 1, 1, CFG.VIEW.MAX_DPR);
    c.width = Math.round(this.speedoSize * dpr);
    c.height = Math.round(this.speedoSize * dpr);
    this.speedoCtx = c.getContext('2d');
    if (this.speedoCtx) this.speedoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  UI.prototype.drawSpeedo = function (kmh, norm, boostPower, boosting) {
    const ctx = this.speedoCtx;
    if (!ctx) return;
    const S = this.speedoSize;
    const cx = S / 2;
    const cy = S / 2;
    const r = S * 0.40;

    ctx.clearRect(0, 0, S, S);

    const startA = Math.PI * 0.75;
    const endA = Math.PI * 2.25;
    const sweep = endA - startA;

    // dial background
    ctx.beginPath();
    ctx.arc(cx, cy, r + 12, 0, U.TAU);
    const bg = ctx.createRadialGradient(cx, cy - 10, r * 0.2, cx, cy, r + 14);
    bg.addColorStop(0, 'rgba(22,32,48,0.92)');
    bg.addColorStop(1, 'rgba(8,12,20,0.92)');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.stroke();

    // track
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, endA);
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.stroke();

    // progress
    const t = U.clamp(norm, 0, 1.34) / 1.34;
    if (t > 0.001) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, startA, startA + sweep * t);
      const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
      grad.addColorStop(0, '#3ddc97');
      grad.addColorStop(0.55, '#ffc857');
      grad.addColorStop(1, '#ff4d6d');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 9;
      ctx.stroke();
    }

    // boost ring
    if (boostPower > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.arc(cx, cy, r + 8, startA, startA + sweep * U.clamp(boostPower, 0, 1));
      ctx.strokeStyle = 'rgba(90,190,255,' + (0.35 + boostPower * 0.5).toFixed(3) + ')';
      ctx.lineWidth = boosting ? 5 : 3;
      ctx.stroke();
      ctx.restore();
    }

    // ticks
    const maxKmh = Math.round(CFG.PLAYER.BOOST_MAX_SPEED * CFG.UNITS.PX_TO_KMH / 10) * 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.fillStyle = 'rgba(230,240,255,0.65)';
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= maxKmh; v += 20) {
      const a = startA + sweep * (v / maxKmh);
      const major = v % 60 === 0;
      const r0 = r - 12;
      const r1 = r - (major ? 20 : 16);
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
      if (major) {
        ctx.fillText(String(v), cx + Math.cos(a) * (r1 - 11), cy + Math.sin(a) * (r1 - 11));
      }
    }

    // needle
    const na = startA + sweep * t;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(na);
    ctx.beginPath();
    ctx.moveTo(-6, -3.4);
    ctx.lineTo(r - 8, -1.2);
    ctx.lineTo(r - 8, 1.2);
    ctx.lineTo(-6, 3.4);
    ctx.closePath();
    ctx.fillStyle = boosting ? '#8ee6ff' : '#ff4d6d';
    ctx.shadowColor = boosting ? 'rgba(120,220,255,0.9)' : 'rgba(255,80,110,0.7)';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.restore();

    // hub
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, U.TAU);
    ctx.fillStyle = '#e8eef6';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, U.TAU);
    ctx.fillStyle = '#20304a';
    ctx.fill();
  };

  /* ---------------------------------------------------------------- toasts */

  UI.prototype.toast = function (text, kind) {
    const wrap = this.el.toasts;
    if (!wrap) return;
    const el = doc.createElement('div');
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.textContent = text;
    wrap.appendChild(el);
    const remove = function () {
      el.classList.add('is-out');
      global.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 260);
    };
    global.setTimeout(remove, 1050);
  };

  /* ------------------------------------------------------------ game over */

  UI.prototype.showGameOver = function (stats) {
    if (this.el.overScore) this.el.overScore.textContent = U.formatNumber(stats.score);
    if (this.el.overKicker) this.el.overKicker.textContent = stats.kicker || 'Totalled';

    if (this.el.overBest) {
      this.el.overBest.textContent = stats.isRecord
        ? 'NEW PERSONAL BEST!'
        : 'Best: ' + U.formatNumber(stats.best);
      this.el.overBest.classList.toggle('is-record', !!stats.isRecord);
    }

    if (this.el.overStats) {
      this.el.overStats.innerHTML =
        row('Distance', U.formatDistance(stats.meters)) +
        row('Top speed', Math.round(stats.topSpeed) + ' km/h') +
        row('Near misses', String(stats.nearMisses)) +
        row('Time survived', stats.time.toFixed(1) + ' s') +
        row('Difficulty', stats.difficulty);
    }

    if (this.el.pauseStats) {
      this.el.pauseStats.innerHTML =
        row('Score', U.formatNumber(stats.score)) +
        row('Distance', U.formatDistance(stats.meters)) +
        row('Speed', Math.round(stats.topSpeed === undefined ? 0 : stats.currentSpeed) + ' km/h');
    }
    this.showScreen('gameover');

    function row(label, value) {
      return '<li><span>' + label + '</span><b>' + value + '</b></li>';
    }
  };

  UI.prototype.showPauseStats = function (stats) {
    if (!this.el.pauseStats) return;
    this.el.pauseStats.innerHTML =
      '<li><span>Score</span><b>' + U.formatNumber(stats.score) + '</b></li>' +
      '<li><span>Distance</span><b>' + U.formatDistance(stats.meters) + '</b></li>' +
      '<li><span>Speed</span><b>' + Math.round(stats.currentSpeed) + ' km/h</b></li>' +
      '<li><span>Shields</span><b>' + stats.shields + '</b></li>';
  };

  /* ------------------------------------------------------- responsive fit */

  /**
   * Scale the stage to the viewport while preserving the playable aspect
   * ratio (letterboxing when needed). The canvas keeps its logical size, so
   * gameplay is identical at any window size.
   */
  UI.prototype.fitStage = function () {
    const stage = this.el.stage;
    if (!stage || !global.getComputedStyle) return;

    const pad = global.innerWidth < 700 ? 8 : 24;
    const availW = Math.max(240, global.innerWidth - pad * 2);
    const availH = Math.max(200, global.innerHeight - pad * 2);
    const aspect = CFG.VIEW.ASPECT;
    const MAX_W = 1600;             // sensible ceiling on very large monitors

    let w = Math.min(availW, MAX_W);
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    w = Math.round(w);
    h = Math.round(w / aspect);
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    this.stageWidth = w;
    this.stageHeight = h;

    // scale HUD typography with the stage, but keep it readable / non-bulky
    stage.style.setProperty('--ui-scale', U.clamp(w / CFG.VIEW.WIDTH, 0.62, 1.3).toFixed(4));

    if (this.game && this.game.renderer) this.game.renderer.resize(w, h);
    this._initSpeedo();
  };

  UI.prototype.detectTouch = function () {
    if (!global.matchMedia) return false;
    return global.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in global;
  };

  Racer.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
