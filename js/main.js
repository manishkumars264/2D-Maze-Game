/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - main.js
 * ----------------------------------------------------------------------------
 *  Bootstrap: feature detection, game construction, first-gesture audio
 *  unlock, and a few browser-behaviour guards (no pinch zoom / context menu /
 *  touch scrolling on the play surface).
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const CFG = Racer.CONFIG;

  function boot() {
    const doc = global.document;
    if (!doc) return;

    const canvas = doc.getElementById('game');
    if (!canvas || !canvas.getContext) {
      const fatal = doc.getElementById('fatal');
      if (fatal) fatal.removeAttribute('hidden');
      return;
    }

    // Feature check: some very old browsers expose getContext but not 2d.
    const testCtx = canvas.getContext('2d');
    if (!testCtx) {
      const fatal = doc.getElementById('fatal');
      if (fatal) fatal.removeAttribute('hidden');
      return;
    }

    const game = new Racer.Game(canvas);
    game.init();
    game.start();

    // Expose for debugging / automated tests (harmless in production).
    global.Racer.game = game;
    if (CFG.DEBUG) global.game = game;

    /* ---- unlock WebAudio on the first gesture of any kind ---- */
    const unlock = function () {
      game.audio.init();
      global.removeEventListener('pointerdown', unlock);
      global.removeEventListener('keydown', unlock);
      global.removeEventListener('touchstart', unlock);
    };
    global.addEventListener('pointerdown', unlock, { once: false });
    global.addEventListener('keydown', unlock, { once: false });
    global.addEventListener('touchstart', unlock, { once: false, passive: true });

    /* ---- keep the play surface from hijacking the page ---- */
    const stage = doc.getElementById('stage');
    if (stage) {
      stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      stage.addEventListener('touchmove', function (e) {
        if (e.cancelable) e.preventDefault();
      }, { passive: false });
      stage.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    }

    // Keep the canvas crisp if the user moves the window to another monitor.
    if (global.matchMedia) {
      const mq = global.matchMedia('(resolution: 1dppx)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', function () { game._handleResize(); });
      }
    }

    // Double-tap zoom on iOS can interrupt play.
    doc.addEventListener('dblclick', function (e) {
      if (stage && stage.contains(e.target)) e.preventDefault();
    }, { passive: false });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  Racer.boot = boot;
})(typeof window !== 'undefined' ? window : globalThis);
