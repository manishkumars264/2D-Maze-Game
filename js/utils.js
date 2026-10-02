/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - utils.js
 * ----------------------------------------------------------------------------
 *  Tiny dependency-free math / random / formatting helpers shared by every
 *  other module. Also contains a safe localStorage wrapper (private browsing
 *  and file:// contexts can throw) and a roundRect polyfill.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = {};

  U.TAU = Math.PI * 2;

  /** Clamp v into [min, max]. */
  U.clamp = function (v, min, max) {
    return v < min ? min : v > max ? max : v;
  };

  /** Linear interpolation. */
  U.lerp = function (a, b, t) {
    return a + (b - a) * t;
  };

  /** Normalised inverse lerp, clamped to 0..1. */
  U.invLerp = function (a, b, v) {
    return a === b ? 0 : U.clamp((v - a) / (b - a), 0, 1);
  };

  /** Frame-rate independent exponential smoothing. */
  U.damp = function (current, target, lambda, dt) {
    return U.lerp(current, target, 1 - Math.exp(-lambda * dt));
  };

  /** Move `current` toward `target` by at most `maxDelta`. */
  U.approach = function (current, target, maxDelta) {
    const d = target - current;
    if (Math.abs(d) <= maxDelta) return target;
    return current + Math.sign(d) * maxDelta;
  };

  U.smoothstep = function (t) {
    t = U.clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  };

  U.easeOutCubic = function (t) {
    t = U.clamp(t, 0, 1);
    const f = 1 - t;
    return 1 - f * f * f;
  };

  U.easeInOutQuad = function (t) {
    t = U.clamp(t, 0, 1);
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  };

  /* ----------------------------- randomness ----------------------------- */

  U.rand = function (min, max) {
    return min + Math.random() * (max - min);
  };

  U.randInt = function (min, max) {
    return Math.floor(U.rand(min, max + 1));
  };

  U.pick = function (arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  };

  U.chance = function (p) {
    return Math.random() < p;
  };

  /** Weighted pick over an object map { key: weight }. */
  U.weightedKey = function (weights) {
    let total = 0;
    for (const k in weights) total += weights[k];
    let r = Math.random() * total;
    for (const k in weights) {
      r -= weights[k];
      if (r <= 0) return k;
    }
    return Object.keys(weights)[0];
  };

  /** Deterministic 32-bit PRNG (mulberry32) - used for procedural scenery. */
  U.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** Integer hash - stable across reloads, unlike Math.random(). */
  U.hash = function (n) {
    let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  };

  /* ------------------------------- geometry ------------------------------ */

  /** Axis-aligned overlap test with an optional inset (px) on both boxes. */
  U.aabb = function (a, b, insetA, insetB) {
    const ia = insetA || 0;
    const ib = insetB || 0;
    const aLeft = a.x - a.hw + ia;
    const aRight = a.x + a.hw - ia;
    const aTop = a.dist - a.hl + ia;
    const aBot = a.dist + a.hl - ia;
    const bLeft = b.x - b.hw + ib;
    const bRight = b.x + b.hw - ib;
    const bTop = b.dist - b.hl + ib;
    const bBot = b.dist + b.hl - ib;
    return aLeft < bRight && aRight > bLeft && aTop < bBot && aBot > bTop;
  };

  /* ------------------------------- colours ------------------------------- */

  /** Mix two "#rrggbb" strings, returning an "rgb()" string. */
  U.mixHex = function (hexA, hexB, t) {
    const a = U.hexToRgb(hexA);
    const b = U.hexToRgb(hexB);
    const r = Math.round(U.lerp(a[0], b[0], t));
    const g = Math.round(U.lerp(a[1], b[1], t));
    const bl = Math.round(U.lerp(a[2], b[2], t));
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  };

  U.hexToRgb = function (hex) {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  /** rgba() string from a hex colour + alpha. */
  U.rgba = function (hex, alpha) {
    const c = U.hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  };

  /** Lighten (amt > 0) or darken (amt < 0) a hex colour, amt in -1..1. */
  U.shade = function (hex, amt) {
    const c = U.hexToRgb(hex);
    const f = function (v) {
      return Math.round(amt >= 0 ? U.lerp(v, 255, amt) : U.lerp(v, 0, -amt));
    };
    return 'rgb(' + f(c[0]) + ',' + f(c[1]) + ',' + f(c[2]) + ')';
  };

  /* ------------------------------ formatting ----------------------------- */

  U.formatNumber = function (n) {
    return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  /** 0..999 -> "842 m", 1000+ -> "1.24 km" */
  U.formatDistance = function (meters) {
    if (meters < 1000) return Math.floor(meters) + ' m';
    return (meters / 1000).toFixed(2) + ' km';
  };

  /* ------------------------------- storage ------------------------------- */

  U.storage = {
    get: function (key, fallback) {
      try {
        const raw = global.localStorage.getItem(key);
        return raw === null ? fallback : raw;
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        global.localStorage.setItem(key, String(value));
        return true;
      } catch (e) {
        return false;
      }
    },
    getNumber: function (key, fallback) {
      const v = parseFloat(U.storage.get(key, ''));
      return isFinite(v) ? v : fallback;
    }
  };

  /* -------------------------- canvas round-rect -------------------------- */

  /** roundRect path (polyfilled because older Safari lacks ctx.roundRect). */
  U.roundRectPath = function (ctx, x, y, w, h, r) {
    const rad = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  };

  /** Cache for generated value-noise tables (used by scenery + road texture). */
  U.valueNoise1D = function (seed, size) {
    size = size || 256;
    const rnd = U.mulberry32(seed);
    const table = new Float32Array(size);
    for (let i = 0; i < size; i++) table[i] = rnd();
    return function (x) {
      const i = Math.floor(x);
      const f = x - i;
      const a = table[((i % size) + size) % size];
      const b = table[(((i + 1) % size) + size) % size];
      const t = f * f * (3 - 2 * f);
      return a + (b - a) * t;
    };
  };

  Racer.utils = U;
})(typeof window !== 'undefined' ? window : globalThis);
