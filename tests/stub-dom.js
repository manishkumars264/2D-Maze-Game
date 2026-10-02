/**
 * ============================================================================
 *  tests/stub-dom.js  (dev tool - not part of the shipped game)
 * ----------------------------------------------------------------------------
 *  A tiny fake browser so the game's modules can be exercised in Node:
 *    - DOM elements (classList / style / dataset / events / queries)
 *    - a REAL canvas backend via @napi-rs/canvas (so rendering actually runs
 *      and can be written out as PNG for visual inspection)
 *    - localStorage, requestAnimationFrame, matchMedia, performance
 *    - an optional fake AudioContext so audio.js code paths are covered
 *
 *  Usage:  require('./stub-dom').install({ audio: true, canvas: true })
 * ============================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

let napi = null;
try {
  napi = require('/tmp/cv/node_modules/@napi-rs/canvas');
} catch (e) {
  try { napi = require('@napi-rs/canvas'); } catch (e2) { napi = null; }
}

/* ------------------------------------------------------------------ element */

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  _sync() { this.el.className = Array.from(this.set).join(' '); }
  add(...c) { c.forEach(x => this.set.add(x)); this._sync(); }
  remove(...c) { c.forEach(x => this.set.delete(x)); this._sync(); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    this._sync();
    return on;
  }
}

class StyleStub {
  constructor() { this.props = {}; }
  setProperty(k, v) { this.props[k] = String(v); }
  getPropertyValue(k) { return this.props[k] || ''; }
  removeProperty(k) { delete this.props[k]; }
}

class ElementStub {
  constructor(tag, id) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this.classList = new ClassList(this);
    // className <-> classList stay in sync, like a real browser
    let _className = '';
    Object.defineProperty(this, 'className', {
      get: () => _className,
      set: (v) => {
        _className = String(v);
        this.classList.set = new Set(_className.split(/\s+/).filter(Boolean));
      },
      configurable: true,
      enumerable: true
    });
    this.style = new StyleStub();
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.handlers = {};
    let _html = '';
    // assigning innerHTML replaces the subtree, like a real browser
    Object.defineProperty(this, 'innerHTML', {
      get: () => _html,
      set: (v) => {
        _html = String(v);
        if (_html === '') {
          this.children.forEach(c => { c.parentNode = null; });
          this.children.length = 0;
        }
      },
      configurable: true,
      enumerable: true
    });
    this.textContent = '';
    this.type = '';
    this.offsetWidth = 100;
    this.hidden = false;
    this.value = '';
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'hidden') this.hidden = true;
    if (k === 'class') {
      this.className = String(v);
      this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
    }
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) {
    delete this.attributes[k];
    if (k === 'hidden') this.hidden = false;
  }
  hasAttribute(k) { return k in this.attributes; }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }

  querySelectorAll(selector) {
    const out = [];
    const match = (el) => {
      if (selector[0] === '.') return el.classList.contains(selector.slice(1));
      if (selector[0] === '#') return el.id === selector.slice(1);
      return el.tagName === selector.toUpperCase();
    };
    const walk = (el) => {
      el.children.forEach(c => { if (match(c)) out.push(c); walk(c); });
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  addEventListener(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.handlers[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  /** Test helper: fire an event at this element. */
  dispatch(type, event) {
    const ev = Object.assign({ type, target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, event || {});
    (this.handlers[type] || []).forEach(fn => fn.call(this, ev));
    return ev;
  }
  focus() {}
  blur() {}
  getBoundingClientRect() { return { x: 0, y: 0, width: 960, height: 640, top: 0, left: 0 }; }
}

/* ------------------------------------------------------------------- canvas */

function makeCanvasElement(id, w, h) {
  if (!napi) {
    // No native canvas available: return a recording-only stub context.
    const el = new ElementStub('canvas', id);
    el.width = w; el.height = h;
    el.getContext = () => makeRecordingContext();
    el.toBuffer = () => Buffer.alloc(0);
    return el;
  }
  const c = napi.createCanvas(w, h);
  // graft DOM-ish properties onto the real canvas object
  const el = new ElementStub('canvas', id);
  const ctx = c.getContext('2d');
  // accept our DOM stubs wherever a real canvas/image is expected
  const rawPattern = ctx.createPattern.bind(ctx);
  ctx.createPattern = (img, rep) => rawPattern(img && img._napiCanvas ? img._napiCanvas : img, rep);
  Object.defineProperty(el, 'width', {
    get: () => c.width,
    set: (v) => { c.width = v; },
    configurable: true
  });
  Object.defineProperty(el, 'height', {
    get: () => c.height,
    set: (v) => { c.height = v; },
    configurable: true
  });
  el.getContext = () => ctx;
  el._napiCanvas = c;
  el._ctx = ctx;
  el.toBuffer = (type) => c.toBuffer(type || 'image/png');
  return el;
}

/** Fallback context that just counts operations (used if napi is missing). */
function makeRecordingContext() {
  const ops = { count: 0 };
  const grad = { addColorStop() { ops.count++; } };
  const handler = {
    get(t, prop) {
      if (prop === '__ops') return ops;
      if (prop in t) return t[prop];
      return function () { ops.count++; };
    },
    set(t, prop, v) { t[prop] = v; ops.count++; return true; }
  };
  const target = {
    canvas: null,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({}),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    measureText: () => ({ width: 10 })
  };
  return new Proxy(target, handler);
}

/* -------------------------------------------------------------- audio stub */

function makeFakeAudioContext() {
  function param(v) {
    return {
      value: v,
      setValueAtTime(x) { this.value = x; return this; },
      linearRampToValueAtTime(x) { this.value = x; return this; },
      exponentialRampToValueAtTime(x) { this.value = x; return this; },
      setTargetAtTime(x) { this.value = x; return this; },
      cancelScheduledValues() { return this; }
    };
  }
  function node(extra) {
    return Object.assign({
      connect(n) { return n; },
      disconnect() {},
      start() {},
      stop() {}
    }, extra || {});
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this._t = 0;
      this.destination = node();
      this.created = 0;
    }
    get currentTime() { return this._t += 0.001; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { this.created++; return node({ gain: param(1) }); }
    createOscillator() {
      this.created++;
      return node({ frequency: param(440), detune: param(0), type: 'sine' });
    }
    createBiquadFilter() {
      this.created++;
      return node({ frequency: param(350), Q: param(1), gain: param(0), type: 'lowpass' });
    }
    createBufferSource() { this.created++; return node({ buffer: null, loop: false, playbackRate: param(1) }); }
    createBuffer(ch, len, rate) {
      const data = new Float32Array(len);
      return { length: len, sampleRate: rate, numberOfChannels: ch, getChannelData: () => data };
    }
    createDynamicsCompressor() {
      this.created++;
      return node({ threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) });
    }
  }
  return FakeAudioContext;
}

/* ------------------------------------------------------------------ install */

function install(opts) {
  opts = opts || {};
  const g = globalThis;

  const elements = new Map();
  const wantedIds = opts.ids || [];
  const ensure = (id) => {
    if (!elements.has(id)) {
      const isCanvas = id === 'game' || id === 'speedo';
      elements.set(id, isCanvas ? makeCanvasElement(id, 300, 150) : new ElementStub('div', id));
    }
    return elements.get(id);
  };
  wantedIds.forEach(ensure);

  const documentStub = {
    readyState: 'complete',
    hidden: false,
    documentElement: new ElementStub('html'),
    body: new ElementStub('body'),
    _handlers: {},
    getElementById: (id) => ensure(id),
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? makeCanvasElement('', 96, 96) : new ElementStub(tag)),
    querySelector: (s) => (documentStub.body.querySelector(s)),
    querySelectorAll: (s) => documentStub.body.querySelectorAll(s),
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const l = this._handlers[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    dispatch(t, ev) {
      const e = Object.assign({ type: t, preventDefault() { this.defaultPrevented = true; } }, ev || {});
      (this._handlers[t] || []).forEach(fn => fn(e));
      return e;
    }
  };

  const rafQueue = [];
  let now = 0;

  const store = new Map();
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _store: store
  };

  g.window = g;
  g.document = documentStub;
  g.localStorage = localStorageStub;
  g.devicePixelRatio = opts.dpr || 1;
  g.innerWidth = opts.innerWidth || 1440;
  g.innerHeight = opts.innerHeight || 900;
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  g.matchMedia = (q) => ({ matches: !!opts.coarsePointer && /coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  g.performance = { now: () => now };
  g.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  g.cancelAnimationFrame = () => {};
  g.__rafQueue = rafQueue;
  g.__advanceTime = (ms) => { now += ms; };
  g.__setTime = (ms) => { now = ms; };
  g.__elements = elements;
  g.__ensureElement = ensure;

  const evHandlers = {};
  g.addEventListener = (t, fn) => { (evHandlers[t] = evHandlers[t] || []).push(fn); };
  g.removeEventListener = (t, fn) => {
    const l = evHandlers[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  };
  g.__dispatchWindow = (t, ev) => {
    const e = Object.assign({ type: t, preventDefault() { this.defaultPrevented = true; } }, ev || {});
    (evHandlers[t] || []).forEach(fn => fn(e));
    return e;
  };
  g.__windowHandlers = evHandlers;

  if (opts.audio) g.AudioContext = makeFakeAudioContext();
  else delete g.AudioContext;

  return { document: documentStub, localStorage: localStorageStub, elements };
}

/** Load a game source file into the current (stubbed) global context. */
function loadScript(relPath) {
  const file = path.resolve(__dirname, '..', relPath);
  const code = fs.readFileSync(file, 'utf8');
  vm.runInThisContext(code, { filename: file });
  return file;
}

const SOURCE_ORDER = [
  'js/config.js', 'js/utils.js', 'js/input.js', 'js/audio.js', 'js/particles.js',
  'js/vehicles.js', 'js/world.js', 'js/player.js', 'js/traffic.js',
  'js/collision.js', 'js/renderer.js', 'js/ui.js', 'js/game.js', 'js/main.js'
];

module.exports = {
  install, loadScript, SOURCE_ORDER, ElementStub, makeCanvasElement,
  napiAvailable: !!napi, napi
};
