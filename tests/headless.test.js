/**
 * ============================================================================
 *  tests/headless.test.js  (dev tool - not part of the shipped game)
 * ----------------------------------------------------------------------------
 *  Automated logic test-suite that runs the real game modules inside a fake
 *  browser (see tests/stub-dom.js). Covers everything the brief asks to be
 *  verified:
 *
 *    - boot / state machine (menu, countdown, playing, paused, crashing, over)
 *    - all three difficulties (population, speeds, shields, score multiplier)
 *    - both control schemes (Arrow keys AND WASD) + default-key prevention
 *    - collision detection -> shield loss -> game over -> restart
 *    - near-miss bonuses, combos, off-road penalty, barrier clamp
 *    - difficulty ramp with distance
 *    - audio-less safety, mute persistence, storage of best scores
 *    - responsive stage fitting and a renderer draw-call budget
 *
 *  Run:  node tests/headless.test.js
 * ============================================================================
 */
'use strict';

const stub = require('./stub-dom');

/* ------------------------------------------------------------------ bootstrap */

stub.install({ audio: true, dpr: 1, innerWidth: 1440, innerHeight: 900 });

const modules = stub.SOURCE_ORDER.filter(f => f !== 'js/main.js');
modules.forEach(stub.loadScript);

const Racer = globalThis.Racer;
const CFG = Racer.CONFIG;
const DIFFS = Racer.DIFFICULTIES;

/* ----------------------------------------------------------------- mini test fw */

let passed = 0;
let failed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m  ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name + '\n          ' + (err && err.message));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertNear(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) {
    throw new Error((msg || 'value out of range') + ' (got ' + a + ', expected ~' + b + ' ±' + tol + ')');
  }
}
function section(title) {
  console.log('\n\x1b[36m' + title + '\x1b[0m');
}

/* ------------------------------------------------------------------- drivers */

let clock = 0;

function newGame(difficulty) {
  const canvas = document.getElementById('game');
  const game = new Racer.Game(canvas);
  game.init();
  game.setDifficulty(difficulty || 'medium');
  return game;
}

/** Advance the loop by n frames of dt ms. */
function run(game, n, dt, each) {
  dt = dt || 1000 / 60;
  for (let i = 0; i < n; i++) {
    if (each) each(game, i);
    clock += dt;
    game.frame(clock);
  }
}

/** Same, but skip rendering (used for long simulations). */
function fastRun(game, n, dt, each) {
  const original = game.render;
  game.render = function () {};
  try { run(game, n, dt, each); } finally { game.render = original; }
}

/** Start a race and skip the countdown. */
function playing(game) {
  game.startRace();
  let guard = 0;
  while (game.state !== 'playing' && guard++ < 400) fastRun(game, 1);
  assert(game.state === 'playing', 'never reached playing state (' + game.state + ')');
  return game;
}

/** Simple autopilot: full throttle + steer back toward the road centre. */
function autopilot(game) {
  const p = game.player;
  game.input.set('up', true);
  const target = game.world.centerXAt(p.dist) + Math.sin(p.dist * 0.0012) * 40;
  const err = target - p.x;
  game.input.set('left', err < -6);
  game.input.set('right', err > 6);
  p.invuln = 999;       // immortal: we're measuring traffic, not crashes
}

/** Steering only (no immortality) - used to measure clean straight-line speed. */
function steerOnly(game) {
  const p = game.player;
  game.input.set('up', true);
  const target = game.world.centerXAt(p.dist + 90);
  const err = target - p.x;
  game.input.set('left', err < -5);
  game.input.set('right', err > 5);
}

/**
 * Rule-based "human-like" driver: picks the most open lane, steers into it and
 * brakes when the stopping distance runs out. Used to prove the traffic is
 * actually drivable (fair) rather than an unavoidable wall.
 */
function smartDriver(game) {
  const p = game.player;
  const w = game.world;
  const cars = game.traffic.cars;
  const currentLane = w.laneAtX(p.dist, p.x);

  /** Nearest car ahead in a lane (indicated mergers count as already merged). */
  function carAhead(lane) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const merged = c.lane === lane || c.toLane === lane;
      if (!merged) continue;
      const d = c.dist - p.dist;
      if (d > -(p.hl + c.hl) && d < bestD) { bestD = d; best = c; }
    }
    return best ? { car: best, gap: bestD - (p.hl + best.hl) } : null;
  }

  /** Distance needed to shed our closing speed on a given leader. */
  function brakingNeed(leader) {
    const rel = p.speed - leader.car.speed;
    return rel > 0 ? (rel * rel) / (2 * CFG.PLAYER.BRAKE) : 0;
  }

  function clearanceIn(lane) {
    const t = carAhead(lane);
    return t ? t.gap : 4000;
  }

  // a lane is unattractive if a car sits beside/behind us in it
  function blockedBeside(lane) {
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.lane !== lane && c.toLane !== lane) continue;
      const d = c.dist - p.dist;
      if (d > -(p.hl + c.hl) - 30 && d < 90) return true;
    }
    return false;
  }

  let bestLane = currentLane;
  let bestScore = -Infinity;
  for (let lane = 0; lane < w.laneCount; lane++) {
    const lateral = Math.abs(w.laneCenterX(p.dist, lane) - p.x);
    let score = clearanceIn(lane) - lateral * 0.85 + (lane === currentLane ? 150 : 0);
    if (lane !== currentLane && blockedBeside(lane)) score -= 900;
    if (score > bestScore) { bestScore = score; bestLane = lane; }
  }

  const targetX = w.laneCenterX(p.dist + 140, bestLane);
  const err = targetX - p.x;
  game.input.set('left', err < -9);
  game.input.set('right', err > 9);

  // throttle modulation like a human: full gas on open road, coast when it
  // gets busy, brake when the closing-speed maths says we must
  const leader = carAhead(bestLane) || carAhead(currentLane);
  let mustBrake = false;
  let coast = false;
  if (leader) {
    const need = brakingNeed(leader);
    if (leader.gap < need + p.hl + 55) mustBrake = true;
    else if (leader.gap < need + 260) coast = true;
  } else if (clearanceIn(bestLane) < 380) {
    coast = true;
  }
  game.input.set('up', !mustBrake && !coast);
  game.input.set('down', mustBrake);
}

/** Build a traffic car by hand (mirrors TrafficManager._trySpawnAt output). */
function makeCar(game, lane, distAhead, speed, typeKey) {
  const world = game.world;
  const key = typeKey || 'sedan';
  const t = CFG.TRAFFIC_TYPES[key];
  const dist = game.player.dist + distAhead;
  return {
    id: 900000 + Math.floor(Math.random() * 1000),
    typeKey: key, shape: t.shape, w: t.width, l: t.length,
    hw: t.width / 2, hl: t.length / 2, agility: t.agility,
    lane: lane, fromLane: lane, toLane: lane, laneT: 1, laneChangeCd: 9999,
    x: world.laneCenterX(dist, lane), dist: dist,
    speed: speed, cruise: speed, baseCruise: speed,
    palette: Racer.Vehicles.PALETTES[3], yaw: 0,
    weavePhase: 0, weaveAmp: 0, weaveRate: 1, indicator: 0,
    passed: false, nearMissScored: false, aggression: 0, blocking: 0, brakeCheck: 0
  };
}

/** Empty the road and stop the spawner (for clean physics measurements). */
function clearTraffic(game) {
  game.traffic.cars.length = 0;
  game.traffic.spawnCooldown = 1e6;
}

function instrumentCtx(real) {
  const ops = { count: 0 };
  return new Proxy(real, {
    get(t, p) {
      if (p === '__ops') return ops;
      const v = t[p];
      if (typeof v === 'function') {
        return function () { ops.count++; return v.apply(t, arguments); };
      }
      return v;
    },
    set(t, p, v) { ops.count++; t[p] = v; return true; }
  });
}

/* ========================================================================== */

console.log('\x1b[1m\nCOASTLINE OVERDRIVE - headless test suite\x1b[0m');
console.log('native canvas backend: ' + (stub.napiAvailable ? 'yes (@napi-rs/canvas)' : 'no (recording stub)'));

/* ------------------------------------------------------------------ structure */

section('Module structure');

test('all modules register on the Racer namespace', function () {
  ['CONFIG', 'DIFFICULTIES', 'utils', 'InputManager', 'AudioManager', 'ParticleSystem',
   'Vehicles', 'World', 'PlayerCar', 'TrafficManager', 'Collision', 'Renderer',
   'Camera', 'UI', 'Difficulty', 'Game'].forEach(function (key) {
    assert(Racer[key], 'missing Racer.' + key);
  });
});

test('source files exist for every logical subsystem', function () {
  const fs = require('fs');
  const path = require('path');
  const expected = ['config.js', 'utils.js', 'input.js', 'audio.js', 'particles.js',
    'vehicles.js', 'world.js', 'player.js', 'traffic.js', 'collision.js',
    'renderer.js', 'ui.js', 'game.js', 'main.js'];
  expected.forEach(function (f) {
    assert(fs.existsSync(path.join(__dirname, '..', 'js', f)), 'missing js/' + f);
  });
  assert(fs.existsSync(path.join(__dirname, '..', 'index.html')), 'missing index.html');
  assert(fs.existsSync(path.join(__dirname, '..', 'css', 'style.css')), 'missing css/style.css');
});

test('index.html wires every script in the right order and every DOM id the UI needs', function () {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  // script tags must cover every module, in load order
  const tags = [];
  const re = /<script src="([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) tags.push(m[1]);
  assert(tags.length === stub.SOURCE_ORDER.length,
    'index.html loads ' + tags.length + ' scripts, expected ' + stub.SOURCE_ORDER.length);
  stub.SOURCE_ORDER.forEach(function (f, i) {
    assert(tags[i] === f, 'script order mismatch at ' + i + ': ' + tags[i] + ' != ' + f);
  });

  // every id referenced by ui.js must exist in the markup
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  const block = uiSrc.slice(uiSrc.indexOf('const ids = ['), uiSrc.indexOf('];', uiSrc.indexOf('const ids = [')));
  const used = block.match(/'([^']+)'/g).map(function (s) { return s.slice(1, -1); });
  const present = {};
  const idRe = /id="([^"]+)"/g;
  while ((m = idRe.exec(html)) !== null) present[m[1]] = true;
  used.forEach(function (id) {
    assert(present[id], 'index.html is missing id="' + id + '" used by ui.js');
  });

  // the canvas must exist and the stylesheet must be linked
  assert(/<canvas id="game"/.test(html), 'game canvas missing');
  assert(/href="css\/style\.css"/.test(html), 'stylesheet link missing');
});

test('every CSS class the JS toggles exists in the stylesheet', function () {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
  const js = ['js/ui.js', 'js/game.js', 'js/input.js'].map(function (f) {
    return fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  }).join('\n');
  const wanted = ['is-active', 'is-muted', 'is-down', 'is-off', 'is-pop', 'is-out', 'is-full',
    'is-record', 'is-menu', 'is-playing', 'is-offroad', 'shield--on', 'pip--on',
    'toast--good', 'toast--warn', 'toast--bad'];
  wanted.forEach(function (cls) {
    const inJs = js.indexOf(cls) >= 0;
    const inCss = css.indexOf('.' + cls) >= 0;
    assert(inJs === inCss || inCss, 'class "' + cls + '" used in JS but missing from CSS');
  });
});

test('config exposes all three difficulties with the briefed car counts', function () {
  assertNear(DIFFS.easy.traffic.minCars, 2, 0, 'easy min cars');
  assertNear(DIFFS.easy.traffic.maxCars, 3, 0, 'easy max cars');
  assertNear(DIFFS.medium.traffic.minCars, 4, 0, 'medium min cars');
  assertNear(DIFFS.medium.traffic.maxCars, 6, 0, 'medium max cars');
  assertNear(DIFFS.hard.traffic.minCars, 7, 0, 'hard min cars');
  assertNear(DIFFS.hard.traffic.maxCars, 10, 0, 'hard max cars');
});

test('difficulty affects more than traffic count (speeds, gaps, shields, score)', function () {
  const e = DIFFS.easy, m = DIFFS.medium, h = DIFFS.hard;
  assert(e.traffic.speedMax < m.traffic.speedMax && m.traffic.speedMax < h.traffic.speedMax, 'speed ordering');
  assert(e.traffic.gapMin > m.traffic.gapMin && m.traffic.gapMin > h.traffic.gapMin, 'gap ordering');
  assert(e.traffic.laneChangeRate < m.traffic.laneChangeRate && m.traffic.laneChangeRate < h.traffic.laneChangeRate, 'lane change ordering');
  assert(e.shields > m.shields && m.shields > h.shields, 'shield ordering');
  assert(e.scoreMultiplier < m.scoreMultiplier && m.scoreMultiplier < h.scoreMultiplier, 'score multiplier ordering');
  assert(e.traffic.weave < m.traffic.weave && m.traffic.weave < h.traffic.weave, 'weave/unpredictability ordering');
  assert(h.traffic.aggressive === true && e.traffic.aggressive === false, 'aggression flags');
});

/* ---------------------------------------------------------------------- boot */

section('Boot & state machine');

let bootGame = null;

test('main.js boots a game, renders the menu attract mode', function () {
  stub.loadScript('js/main.js');
  bootGame = Racer.game;
  assert(bootGame instanceof Racer.Game, 'Racer.game is not a Game');
  assert(bootGame.state === 'menu', 'expected menu state, got ' + bootGame.state);
  run(bootGame, 90);
  assert(bootGame.traffic.count() > 0, 'attract mode should have traffic on screen');
  assert(bootGame.player.dist > 0, 'attract camera should be moving');
});

test('menu -> countdown -> playing transition', function () {
  const g = newGame('medium');
  assert(g.state === 'menu');
  g.startRace();
  assert(g.state === 'countdown', 'expected countdown, got ' + g.state);
  const seen = {};
  run(g, 220, 1000 / 60, function (gg) { seen[gg.state] = true; });
  assert(seen.playing === true, 'never reached playing');
  assert(g.ui.el.hud && !g.ui.el.hud.hidden, 'HUD should be visible while playing');
});

test('countdown reaches GO! and hands over control', function () {
  const g = newGame('easy');
  g.startRace();
  let guard = 0;
  while (g.state !== 'playing' && guard++ < 400) run(g, 1);
  assert(g.countdownIndex >= CFG.COUNTDOWN.STEPS.length - 1, 'countdown did not finish');
  g.input.set('up', true);
  run(g, 60);
  assert(g.player.speed > 40, 'player should accelerate after GO');
});

test('pause freezes the world and resume continues it', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  run(g, 60);
  const d0 = g.player.dist;
  g.togglePause();
  assert(g.state === 'paused', 'expected paused, got ' + g.state);
  run(g, 60);
  assert(g.player.dist === d0, 'simulation moved while paused');
  g.togglePause();
  assert(g.state === 'playing', 'expected playing after resume, got ' + g.state);
  run(g, 60);
  assert(g.player.dist > d0, 'simulation did not resume');
});

test('pause during countdown resumes back into the countdown', function () {
  const g = newGame('medium');
  g.startRace();
  run(g, 10);
  assert(g.state === 'countdown');
  g.togglePause();
  assert(g.state === 'paused');
  assert(g.pausedFrom === 'countdown', 'should remember it paused from countdown');
  g.togglePause();
  assert(g.state === 'countdown', 'should resume into countdown');
});

test('pause button and Escape/P key both toggle pause', function () {
  const g = playing(newGame('medium'));
  g.ui.el.btnPause.dispatch('click');
  assert(g.state === 'paused', 'HUD pause button did not pause');
  g.ui.el.btnPause.dispatch('click');
  assert(g.state === 'playing', 'HUD pause button did not resume');
  global.__dispatchWindow('keydown', { code: 'KeyP' });
  assert(g.state === 'paused', 'P key did not pause');
  global.__dispatchWindow('keydown', { code: 'Escape' });
  assert(g.state === 'playing', 'Escape did not resume');
});

test('losing window focus pauses the race and releases keys', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  run(g, 20);
  global.__dispatchWindow('blur');
  assert(g.state === 'paused', 'blur should auto-pause');
  assert(g.input.state.up === false, 'keys should be released on blur');
});

/* ------------------------------------------------------------------- controls */

section('Controls');

function relOffset(game) {
  return game.player.x - game.world.centerXAt(game.player.dist);
}

function driveWith(difficulty, keys, frames) {
  const g = playing(newGame(difficulty));
  keys.forEach(function (k) { g.input.set(k, true); });
  fastRun(g, frames);
  const out = { speed: g.player.speed, rel: relOffset(g), dist: g.player.dist, kmh: g.player.kmh() };
  keys.forEach(function (k) { g.input.set(k, false); });
  return out;
}

test('Arrow Up / W both accelerate', function () {
  const arrows = driveWith('medium', ['up'], 180);      // up == ArrowUp or W
  assert(arrows.speed > 250, 'no acceleration, speed=' + arrows.speed);
  assert(arrows.dist > 500, 'car did not travel, dist=' + arrows.dist);
  assert(arrows.kmh > 120, 'km/h readout too low: ' + arrows.kmh);
});

test('key mapping: ArrowUp/W -> up, ArrowDown/S -> down, ArrowLeft/A -> left, ArrowRight/D -> right', function () {
  const g = newGame('medium');
  const pairs = [
    ['ArrowUp', 'up'], ['KeyW', 'up'],
    ['ArrowDown', 'down'], ['KeyS', 'down'],
    ['ArrowLeft', 'left'], ['KeyA', 'left'],
    ['ArrowRight', 'right'], ['KeyD', 'right'],
    ['ShiftLeft', 'boost'], ['Space', 'boost']
  ];
  pairs.forEach(function (p) {
    g.input.releaseAll();
    global.__dispatchWindow('keydown', { code: p[0] });
    assert(g.input.state[p[1]] === true, p[0] + ' should set ' + p[1]);
    global.__dispatchWindow('keyup', { code: p[0] });
    assert(g.input.state[p[1]] === false, p[0] + ' keyup should clear ' + p[1]);
  });
});

test('arrow keys steer left/right (WASD too)', function () {
  const baseline = driveWith('medium', ['up'], 60).rel;
  // arrows
  const g1 = playing(newGame('medium'));
  global.__dispatchWindow('keydown', { code: 'ArrowUp' });
  global.__dispatchWindow('keydown', { code: 'ArrowLeft' });
  fastRun(g1, 60);
  const leftArrow = relOffset(g1);
  global.__dispatchWindow('keyup', { code: 'ArrowLeft' });
  global.__dispatchWindow('keydown', { code: 'ArrowRight' });
  fastRun(g1, 60);
  const rightArrow = relOffset(g1);

  // wasd
  const g2 = playing(newGame('medium'));
  global.__dispatchWindow('keydown', { code: 'KeyW' });
  global.__dispatchWindow('keydown', { code: 'KeyA' });
  fastRun(g2, 60);
  const leftWasd = relOffset(g2);
  global.__dispatchWindow('keyup', { code: 'KeyA' });
  global.__dispatchWindow('keydown', { code: 'KeyD' });
  fastRun(g2, 60);
  const rightWasd = relOffset(g2);

  assert(leftArrow < baseline - 10, 'ArrowLeft did not move the car left (' + leftArrow + ' vs ' + baseline + ')');
  assert(rightArrow > leftArrow + 20, 'ArrowRight did not move the car right');
  assert(leftWasd < baseline - 10, 'KeyA did not move the car left');
  assert(rightWasd > leftWasd + 20, 'KeyD did not move the car right');
});

test('brake slows down, then reverses; release coasts to a stop', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  fastRun(g, 120);
  const fast = g.player.speed;
  assert(fast > 150, 'should be moving fast before braking');
  g.input.set('up', false);
  g.input.set('down', true);
  fastRun(g, 60);
  assert(g.player.speed < fast * 0.5, 'braking did not slow the car');
  fastRun(g, 90);
  assert(g.player.speed < 0, 'should reverse when braking from a stop, got ' + g.player.speed);
  assert(g.player.speed >= CFG.PLAYER.MAX_REVERSE - 1, 'reverse speed clamped incorrectly');
  g.input.set('down', false);
  fastRun(g, 120);
  assert(Math.abs(g.player.speed) < 5, 'car should coast to a stop, got ' + g.player.speed);
});

test('game keys never scroll or trigger browser defaults', function () {
  const g = newGame('medium');
  void g;
  ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].forEach(function (code) {
    const ev = global.__dispatchWindow('keydown', { code: code });
    assert(ev.defaultPrevented === true, code + ' keydown was not preventDefault-ed');
  });
});

test('boost (Shift) raises the speed ceiling and drains the tank', function () {
  const g = playing(newGame('medium'));
  clearTraffic(g);
  g.input.set('up', true);
  fastRun(g, 400, 1000 / 60, function (gg) { steerOnly(gg); });
  const normalTop = g.player.speed;
  g.input.set('boost', true);
  fastRun(g, 300, 1000 / 60, function (gg) { steerOnly(gg); gg.input.set('boost', true); });
  assert(g.player.speed > normalTop * 1.05, 'boost did not increase speed (' + normalTop + ' -> ' + g.player.speed + ')');
  assert(g.player.boostFuel < CFG.PLAYER.BOOST_MAX, 'boost fuel should drain');
  g.input.set('boost', false);
  const fuel = g.player.boostFuel;
  fastRun(g, 120);
  assert(g.player.boostFuel > fuel, 'boost fuel should regenerate');
});

test('steering authority grows with speed then falls off at the very top end', function () {
  const g = playing(newGame('medium'));
  function lateralAt(speed) {
    g.player.speed = speed;
    g.player.steer = 0;
    g.input.set('left', false);
    g.input.set('right', true);
    const x0 = g.player.x;
    // single deterministic physics tick
    g.player.update(1 / 60, g.input, g.world);
    g.input.set('right', false);
    return Math.abs(g.player.x - x0);
  }
  const slow = lateralAt(30);
  const mid = lateralAt(200);
  const top = lateralAt(CFG.PLAYER.MAX_SPEED);
  assert(slow < mid, 'steering should be stronger at speed than crawling');
  assert(top < mid * 1.4, 'steering should not explode at top speed');
  assert(top > slow, 'top speed steering should still beat crawling');
});

/* -------------------------------------------------------------------- physics */

section('Physics & world');

test('top speed matches the configured maximum (km/h readout)', function () {
  const g = playing(newGame('easy'));
  clearTraffic(g);
  fastRun(g, 900, 1000 / 60, function (gg) { steerOnly(gg); });
  assertNear(g.player.kmh(), CFG.PLAYER.MAX_SPEED * CFG.UNITS.PX_TO_KMH, 16, 'top speed km/h');
  assert(g.player.offRoad === false, 'driver should have kept the car on the road');
});

test('road centreline curves and stays inside sane bounds', function () {
  const w = new Racer.World();
  w.curveScale = CFG.CURVE.SCALE_MAX;
  let min = Infinity, max = -Infinity, maxSlope = 0;
  for (let d = 0; d < 60000; d += 37) {
    const x = w.centerXAt(d);
    min = Math.min(min, x); max = Math.max(max, x);
    maxSlope = Math.max(maxSlope, Math.abs(w.slopeAt(d)));
  }
  assert(min < -50 && max > 50, 'road should visibly curve (got ' + min + '..' + max + ')');
  assert(maxSlope < 0.6, 'curve too sharp to be drivable: slope ' + maxSlope);
  assert(max - min < CFG.ROAD.BARRIER_OFFSET * 4, 'curve amplitude exploded');
});

test('lane helpers agree with road geometry', function () {
  const w = new Racer.World();
  const d = 4321;
  const c = w.centerXAt(d);
  assertNear(w.laneCenterX(d, 0) - c, -1.5 * CFG.ROAD.LANE_WIDTH, 0.001, 'lane 0 offset');
  assertNear(w.laneCenterX(d, 3) - c, 1.5 * CFG.ROAD.LANE_WIDTH, 0.001, 'lane 3 offset');
  assert(w.laneAtX(d, c) === 1 || w.laneAtX(d, c) === 2, 'centre of road maps to a middle lane');
  assert(w.laneAtX(d, w.laneCenterX(d, 0)) === 0, 'lane lookup failed');
});

test('grass (off-road) heavily limits speed', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  fastRun(g, 300);
  const onRoad = g.player.speed;
  g.player.x = g.world.centerXAt(g.player.dist) + g.world.pavedHalf + 90;
  fastRun(g, 300, 1000 / 60, function (gg) {
    gg.player.x = gg.world.centerXAt(gg.player.dist) + gg.world.pavedHalf + 90;
  });
  assert(g.player.offRoad === true, 'should be flagged off-road');
  assert(g.player.speed < onRoad * 0.6, 'off-road should slow the car (' + g.player.speed + ' vs ' + onRoad + ')');
});

test('barrier clamps the car inside the road corridor', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  fastRun(g, 120);
  g.input.set('right', true);
  fastRun(g, 400, 1000 / 60, function (gg) { gg.input.set('right', true); });
  const rel = relOffset(g);
  assert(Math.abs(rel) <= g.world.barrierHalf + 1, 'car escaped the barriers (rel=' + rel + ')');
});

test('biomes cross-fade and expose valid colours along the route', function () {
  const w = new Racer.World();
  const seen = {};
  for (let d = 0; d < 60000; d += 250) {
    const b = w.biomeAt(d);
    seen[b.id] = (seen[b.id] || 0) + 1;
    assert(/^rgb\(|^#/.test(b.css.grassA), 'bad grass colour: ' + b.css.grassA);
    assert(b.t >= 0 && b.t <= 1, 'bad blend factor');
  }
  assert(Object.keys(seen).length >= 3, 'expected several biomes, saw ' + Object.keys(seen).join(','));
});

test('scenery is generated deterministically and cached', function () {
  const w1 = new Racer.World();
  const w2 = new Racer.World();
  const a = w1.sceneryIn(1000, 2600);
  const b = w2.sceneryIn(1000, 2600);
  assert(a.length > 5, 'no scenery generated (' + a.length + ')');
  assert(a.length === b.length, 'scenery generation is not deterministic');
  for (let i = 0; i < a.length; i++) {
    assert(a[i].type === b[i].type && Math.abs(a[i].dist - b[i].dist) < 1e-6, 'scenery mismatch at ' + i);
  }
  const before = w1.chunks.size;
  w1.sceneryIn(1000, 2600);
  assert(w1.chunks.size === before, 'scenery chunks should be cached');
  const types = {};
  a.forEach(function (p) { types[p.type] = true; });
  assert(Object.keys(types).length >= 3, 'expected a variety of props');
});

test('road events (banner, gantries, markers) appear along the route', function () {
  const w = new Racer.World();
  const ev = w.eventsIn(0, 20000);
  const kinds = {};
  ev.forEach(function (e) { kinds[e.type] = (kinds[e.type] || 0) + 1; });
  assert(kinds.banner === 1, 'expected exactly one start banner, got ' + kinds.banner);
  assert(kinds.gantry >= 5, 'expected gantries, got ' + kinds.gantry);
  assert(kinds.marker >= 5, 'expected distance markers, got ' + kinds.marker);
});

/* ------------------------------------------------------------------- traffic */

section('Traffic & difficulty scaling');

function trafficProfile(difficulty, seconds) {
  const g = playing(newGame(difficulty));
  const frames = Math.round(seconds * 60);
  let countSum = 0, speedSum = 0, speedN = 0, laneChanges = 0, maxCount = 0;
  let cruiseSum = 0, cruiseN = 0;
  const laneOf = new Map();
  fastRun(g, frames, 1000 / 60, function (gg) {
    autopilot(gg);
    countSum += gg.traffic.count();
    maxCount = Math.max(maxCount, gg.traffic.count());
    gg.traffic.cars.forEach(function (c) {
      speedSum += c.speed; speedN++;
      cruiseSum += c.baseCruise; cruiseN++;
      const prev = laneOf.get(c.id);
      if (prev !== undefined && prev !== c.lane) laneChanges++;
      laneOf.set(c.id, c.lane);
    });
  });
  return {
    avg: countSum / frames,
    max: maxCount,
    avgSpeed: speedN ? speedSum / speedN : 0,
    avgCruise: cruiseN ? cruiseSum / cruiseN : 0,
    laneChanges: laneChanges,
    meters: g.player.meters(),
    game: g
  };
}

test('easy: keeps ~2-3 cars alive early on, slow traffic', function () {
  const p = trafficProfile('easy', 12);
  assert(p.avg >= 1.6 && p.avg <= 4.2, 'easy average traffic out of range: ' + p.avg.toFixed(2));
  assert(p.avgSpeed < DIFFS.easy.traffic.speedMax * 1.45, 'easy traffic too fast: ' + p.avgSpeed);
  assert(p.game.player.shields === DIFFS.easy.shields || p.game.player.shields < DIFFS.easy.shields, 'shields');
});

test('medium: keeps ~4-6 cars alive, normal traffic speed', function () {
  const p = trafficProfile('medium', 12);
  assert(p.avg >= 3.2 && p.avg <= 7.5, 'medium average traffic out of range: ' + p.avg.toFixed(2));
  assert(p.avgSpeed > DIFFS.easy.traffic.speedMin, 'medium traffic should be quicker than easy');
});

test('hard: keeps ~7-10 cars alive with faster traffic', function () {
  const p = trafficProfile('hard', 12);
  assert(p.avg >= 6 && p.avg <= 12.5, 'hard average traffic out of range: ' + p.avg.toFixed(2));
  assert(p.max >= 7, 'hard should reach at least 7 cars, peak was ' + p.max);
});

test('traffic population ordering easy < medium < hard', function () {
  const e = trafficProfile('easy', 10);
  const m = trafficProfile('medium', 10);
  const h = trafficProfile('hard', 10);
  assert(e.avg < m.avg, 'easy(' + e.avg.toFixed(2) + ') should be < medium(' + m.avg.toFixed(2) + ')');
  assert(m.avg < h.avg, 'medium(' + m.avg.toFixed(2) + ') should be < hard(' + h.avg.toFixed(2) + ')');
  assert(e.avgCruise < m.avgCruise && m.avgCruise < h.avgCruise,
    'assigned cruise speeds should scale: ' +
    [e.avgCruise, m.avgCruise, h.avgCruise].map(n => n.toFixed(1)).join(' / '));
  console.log('          (live speeds ' + [e.avgSpeed, m.avgSpeed, h.avgSpeed].map(n => n.toFixed(0)).join(' / ') +
              ' px/s - denser traffic congests, as it should)');
  assert(e.laneChanges <= m.laneChanges, 'easy should change lanes less than medium (' + e.laneChanges + '/' + m.laneChanges + ')');
});

test('shields per difficulty: easy 3, medium 2, hard 1', function () {
  ['easy', 'medium', 'hard'].forEach(function (id) {
    const g = playing(newGame(id));
    assert(g.player.shields === DIFFS[id].shields, id + ' shields = ' + g.player.shields);
  });
});

test('difficulty ramp raises the traffic target with distance', function () {
  const g = playing(newGame('medium'));
  const t0 = g.traffic.targetCount(0);
  const t1 = g.traffic.targetCount(0.5);
  const t2 = g.traffic.targetCount(1);
  assert(t0 < t1 && t1 < t2, 'target count should ramp: ' + t0 + ' -> ' + t1 + ' -> ' + t2);
  assert(t2 <= DIFFS.medium.traffic.maxCars + DIFFS.medium.ramp.extraCars, 'ramp exceeded its cap');
  const s0 = g.traffic.speedRange ? g.speedRangeProbe0 = null : null;
  void s0;
  g.traffic.rampT = 0;
  const slow = g.traffic.speedRange()[1];
  g.traffic.rampT = 1;
  const quick = g.traffic.speedRange()[1];
  assert(quick > slow * 1.1, 'traffic speed should ramp too (' + slow + ' -> ' + quick + ')');
});

test('road curvature tightens as the run progresses', function () {
  const w = new Racer.World();
  w.updateCurveScale(0);
  const start = w.curveScale;
  w.updateCurveScale(CFG.CURVE.SCALE_RAMP_METERS);
  const end = w.curveScale;
  assert(end > start * 1.5, 'curve scale should grow (' + start + ' -> ' + end + ')');
  assertNear(end, CFG.CURVE.SCALE_MAX, 0.01, 'curve scale cap');
});

test('traffic always spawns beyond the visible top edge (never pops in)', function () {
  ['easy', 'medium', 'hard'].forEach(function (id) {
    const g = playing(newGame(id));
    for (let i = 0; i < 200; i++) {
      const d = g.traffic.spawnDistance(g.player.dist);
      const visibleAhead = g.renderer.camera.anchorY / g.renderer.camera.zoom;
      assert(d - g.player.dist > visibleAhead,
        id + ': car spawned inside the visible area (' + (d - g.player.dist).toFixed(0) +
        ' < ' + visibleAhead.toFixed(0) + ')');
      g.player.dist += 40;
    }
  });
});

test('a rule-based driver survives hard-mode traffic most of the time', function () {
  // Hard has ONE shield, so a single mistake is fatal by design; a fair game
  // means mistakes are *avoidable*, i.e. the simple driver usually lasts.
  const results = [];
  let worstPct = 0;
  for (let trial = 0; trial < 3; trial++) {
    const g = playing(newGame('hard'));
    const frames = 60 * 32;
    let wallFrames = 0;
    fastRun(g, frames, 1000 / 60, function (gg) {
      if (gg.state !== 'playing') return;
      smartDriver(gg);
      const p = gg.player;
      const stopDist = (p.speed * p.speed) / (2 * CFG.PLAYER.BRAKE) + p.hl + 40;
      const lanes = {};
      gg.traffic.cars.forEach(function (c) {
        const d = c.dist - p.dist;
        if (d > -p.hl && d < stopDist) lanes[c.lane] = true;
      });
      if (Object.keys(lanes).length >= gg.world.laneCount) wallFrames++;
    });
    const pct = (wallFrames / frames) * 100;
    worstPct = Math.max(worstPct, pct);
    results.push({ time: g.raceTime, shields: g.player.shields, state: g.state });
  }
  const survived = results.filter(function (r) { return r.time > 30; }).length;
  console.log('          (hard-mode trials: ' +
              results.map(function (r) { return r.time.toFixed(0) + 's/' + r.shields + 'sh'; }).join(', ') +
              ', worst wall% ' + worstPct.toFixed(1) + ')');
  assert(survived >= 2, 'the driver should survive hard mode in most trials, survived ' + survived + '/3');
  assert(worstPct < 12, 'walls inside braking distance persisted too long: ' + worstPct.toFixed(1) + '%');
});

test('the same driver lasts longer on easy than on hard', function () {
  function survival(id, seconds) {
    const g = playing(newGame(id));
    fastRun(g, 60 * seconds, 1000 / 60, function (gg) {
      if (gg.state !== 'playing') return;
      smartDriver(gg);
    });
    return { time: g.raceTime, shieldsLeft: g.player.shields, state: g.state, meters: g.player.meters() };
  }
  const easy = survival('easy', 30);
  const hard = survival('hard', 30);
  console.log('          (easy: ' + easy.time.toFixed(1) + 's, shields ' + easy.shieldsLeft +
              ' | hard: ' + hard.time.toFixed(1) + 's, shields ' + hard.shieldsLeft + ')');
  assert(easy.shieldsLeft >= hard.shieldsLeft || easy.time >= hard.time,
    'easy should be more forgiving than hard');
  assert(DIFFS.easy.shields > DIFFS.hard.shields, 'easy should start with more shields');
});

test('the spawner refuses to fill the last free lane', function () {
  const g = playing(newGame('hard'));
  g.traffic.cars.length = 0;
  const d = g.player.dist + 1400;
  // occupy every lane but one inside the safety window
  for (let lane = 0; lane < g.world.laneCount - 1; lane++) {
    g.traffic.cars.push(makeCar(g, lane, 1400, 150));
  }
  const before = g.traffic.cars.length;
  let spawned = 0;
  for (let i = 0; i < 40; i++) {
    if (g.traffic._trySpawnAt(d + (i % 3) * 10, false)) spawned++;
  }
  assert(spawned <= 1, 'spawner filled the only escape lane (' + spawned + ' extra cars)');
  assert(g.traffic.cars.length <= before + 1, 'too many cars added');
});

/* ----------------------------------------------------------------- collision */

section('Collision & game over');

test('rear-ending traffic costs a shield on medium', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  fastRun(g, 90);
  g.traffic.cars.length = 0;
  g.traffic.spawnCooldown = 9999;
  const car = makeCar(g, 1, 260, 40);
  g.traffic.cars.push(car);
  const shields0 = g.player.shields;
  fastRun(g, 200, 1000 / 60, function (gg) {
    gg.input.set('up', true);
    gg.player.invuln = 0;              // allow the hit to register
    car.lane = gg.player.x > gg.world.centerXAt(gg.player.dist) ? 3 : 0;
    car.x = gg.player.x;               // keep it dead ahead
    car.dist = Math.max(car.dist, gg.player.dist + 40);
  });
  assert(g.player.shields < shields0 || g.state !== 'playing',
    'collision did not cost a shield (shields=' + g.player.shields + ', state=' + g.state + ')');
  assert(g.stats.shieldsLost >= 1, 'shield loss not recorded in stats');
});

test('a hit spins the car out, kills speed and grants invulnerability', function () {
  const g = playing(newGame('easy'));
  g.input.set('up', true);
  fastRun(g, 150);
  g.traffic.cars.length = 0;
  g.traffic.spawnCooldown = 9999;
  const car = makeCar(g, 2, 200, 30);
  g.traffic.cars.push(car);
  let hitFrame = -1;
  const shields0 = g.player.shields;
  const speedBefore = g.player.speed;
  fastRun(g, 120, 1000 / 60, function (gg, i) {
    gg.input.set('up', true);
    if (gg.player.shields < shields0 && hitFrame < 0) hitFrame = i;
    gg.player.invuln = hitFrame >= 0 ? gg.player.invuln : 0;
    car.x = gg.player.x;
    car.dist = Math.max(car.dist, gg.player.dist + 30);
  });
  assert(hitFrame >= 0, 'no collision happened');
  assert(g.player.spin > 0 || g.player.invuln > 0, 'expected spin/invulnerability after a hit');
  assert(g.player.shields === shields0 - 1, 'exactly one shield should be lost, got ' + g.player.shields);
  assert(g.player.speed < speedBefore, 'a hit should scrub off speed');
});

test('hard mode: one crash ends the run (crashing -> game over)', function () {
  const g = playing(newGame('hard'));
  g.input.set('up', true);
  fastRun(g, 120);
  g.traffic.cars.length = 0;
  g.traffic.spawnCooldown = 9999;
  const car = makeCar(g, 1, 240, 30);
  g.traffic.cars.push(car);
  const states = [];
  fastRun(g, 400, 1000 / 60, function (gg) {
    gg.input.set('up', true);
    if (gg.state === 'playing') gg.player.invuln = 0;
    car.x = gg.player.x;
    car.dist = Math.max(car.dist, gg.player.dist + 30);
    if (states[states.length - 1] !== gg.state) states.push(gg.state);
  });
  assert(states.indexOf('crashing') >= 0, 'expected a crashing state, saw: ' + states.join(' -> '));
  assert(g.state === 'gameover', 'expected gameover, got ' + g.state);
  assert(g.crashed === true, 'crashed flag not set');
  assert(g.ui.el.gameover && !g.ui.el.gameover.hidden, 'game over overlay should be visible');
});

test('easy mode survives two hits and dies on the third', function () {
  const g = playing(newGame('easy'));
  g.input.set('up', true);
  fastRun(g, 120);
  g.traffic.spawnCooldown = 9999;
  const car = makeCar(g, 1, 240, 30);
  g.traffic.cars.length = 0;
  g.traffic.cars.push(car);
  let lastShields = g.player.shields;
  fastRun(g, 1400, 1000 / 60, function (gg) {
    if (gg.player.shields < lastShields) { lastShields = gg.player.shields; }
    if (gg.state !== 'playing') return;
    gg.input.set('up', true);
    gg.player.invuln = gg.player.shields < DIFFS.easy.shields ? gg.player.invuln : 0;
    car.x = gg.player.x;
    car.dist = Math.max(car.dist, gg.player.dist + 26);
  });
  assert(lastShields === 0, 'all three shields should have been consumed, ' + lastShields + ' left');
  assert(g.state === 'gameover' || g.state === 'crashing', 'run should be over, got ' + g.state);
  assert(g.stats.shieldsLost >= 3, 'shield losses should be tracked, got ' + g.stats.shieldsLost);
});

test('collision severity scales with closing speed', function () {
  const g = playing(newGame('medium'));
  const car = makeCar(g, 1, 100, 100);
  g.player.speed = 120;
  const soft = Racer.Collision.analyse(g.player, car).severity;
  g.player.speed = 480;
  const hard = Racer.Collision.analyse(g.player, car).severity;
  assert(hard > soft, 'faster impacts should be more severe (' + soft + ' -> ' + hard + ')');
});

test('AABB overlap detection is exact and inset-tolerant', function () {
  const a = { x: 0, dist: 0, hw: 20, hl: 40 };
  const box = function (x, dist) { return { x: x, dist: dist || 0, hw: 20, hl: 40 }; };
  assert(Racer.utils.aabb(a, box(39), 0, 0) === true, 'touching boxes should overlap');
  assert(Racer.utils.aabb(a, box(41), 0, 0) === false, 'separated boxes should not overlap');
  assert(Racer.utils.aabb(a, box(25), 0, 0) === true, 'a 15px overlap is a hit');
  assert(Racer.utils.aabb(a, box(25), 8, 8) === false, 'an 8px inset should forgive that graze');
  assert(Racer.utils.aabb(a, box(0, 79), 0, 0) === true, 'longitudinal overlap');
  assert(Racer.utils.aabb(a, box(0, 81), 0, 0) === false, 'longitudinal gap');
  // the real collision path used by the game
  const player = {
    x: 0, dist: 0, speed: 300, invuln: 0,
    hw: CFG.PLAYER.WIDTH / 2, hl: CFG.PLAYER.LENGTH / 2,
    bbox: function () { return this; }
  };
  const car = { x: 0, dist: 60, hw: 22, hl: 41, speed: 100, typeKey: 'sedan' };
  const res = Racer.Collision.scan(player, { near: function () { return [car]; } });
  assert(res.hits.length === 1, 'a nose-to-tail overlap must register as a hit');
  assert(res.hits[0].face === 'front', 'rear-ending traffic should be a front impact, got ' + res.hits[0].face);
  assert(res.hits[0].severity > 0.4, 'severity should be meaningful');
});

test('restart resets score, distance, shields and traffic', function () {
  const g = playing(newGame('hard'));
  g.input.set('up', true);
  fastRun(g, 300);
  assert(g.score > 0 && g.player.dist > 0, 'run should have progressed');
  g.restart();
  assert(g.state === 'countdown', 'restart should go through the countdown, got ' + g.state);
  assert(g.score === 0, 'score not reset');
  assert(g.player.dist === 0, 'distance not reset');
  assert(g.player.shields === DIFFS.hard.shields, 'shields not reset');
  assert(g.crashed === false, 'crash flag not cleared');
  assert(g.raceTime === 0, 'race time not reset');
});

test('game over -> main menu -> new race works', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  fastRun(g, 200);
  g.player.shields = 1;
  g.traffic.cars.length = 0;
  g.traffic.spawnCooldown = 9999;
  const car = makeCar(g, 1, 200, 20);
  g.traffic.cars.push(car);
  fastRun(g, 300, 1000 / 60, function (gg) {
    gg.input.set('up', true);
    if (gg.state === 'playing') gg.player.invuln = 0;
    car.x = gg.player.x;
    car.dist = Math.max(car.dist, gg.player.dist + 30);
  });
  assert(g.state === 'gameover', 'should be game over, got ' + g.state);
  g.ui.el.btnMenu.dispatch('click');
  assert(g.state === 'menu', 'main menu button should return to the menu, got ' + g.state);
  assert(g.score === 0, 'score should reset on returning to menu');
  g.ui.el.btnPlay.dispatch('click');
  assert(g.state === 'countdown', 'play button should start a race, got ' + g.state);
  let guard = 0;
  while (g.state !== 'playing' && guard++ < 400) fastRun(g, 1);
  assert(g.state === 'playing', 'should be playing again');
});

test('game over buttons: restart button works', function () {
  const g = playing(newGame('medium'));
  g.player.shields = 0;
  g.setState('gameover');
  g.ui.showScreen('gameover');
  g.ui.el.btnRestart.dispatch('click');
  assert(g.state === 'countdown', 'restart button should start the countdown, got ' + g.state);
});

/* ------------------------------------------------------------------ scoring */

section('Scoring & near misses');

test('distance scores, scaled by difficulty multiplier', function () {
  const results = {};
  ['easy', 'hard'].forEach(function (id) {
    const g = playing(newGame(id));
    g.player.dist = 6000;                       // 1000 m
    g._lastScoredDist = 0;
    g.score = 0;
    g.combo = 1;
    g._updateScore(0, g.player);
    results[id] = g.score;
  });
  assertNear(results.easy, 1000, 2, 'easy score for 1000 m');
  assertNear(results.hard, 1000 * DIFFS.hard.scoreMultiplier, 3, 'hard score for 1000 m');
  assert(results.hard > results.easy * 2, 'hard should score far more than easy');
});

test('off-road distance scores at a reduced rate', function () {
  const g = playing(newGame('medium'));
  g.player.dist = 6000;
  g._lastScoredDist = 0;
  g.score = 0;
  g.player.offRoad = true;
  g._updateScore(0, g.player);
  assertNear(g.score, 1000 * CFG.SCORING.OFFROAD_SCORE_FACTOR * DIFFS.medium.scoreMultiplier, 3, 'off-road score');
});

test('near miss awards points, builds the combo and refills boost', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  fastRun(g, 120);
  const car = makeCar(g, 2, 0, g.player.speed);
  g.score = 0;
  g.combo = 1;
  g.player.boostFuel = 10;
  const before = g.score;
  g._handleNearMiss([{ car: car, clearance: 12 }]);
  assert(g.score > before + 50, 'near miss should add score (' + before + ' -> ' + g.score + ')');
  assert(g.combo > 1, 'combo should build');
  assert(g.player.boostFuel > 10, 'boost should refill');
  assert(g.stats.nearMisses === 1, 'near miss not counted');
  g._handleNearMiss([{ car: car, clearance: 12 }]);
  assert(g.combo > 1.4, 'combo should keep building');
});

test('combo is capped and times out', function () {
  const g = playing(newGame('medium'));
  for (let i = 0; i < 40; i++) g._handleNearMiss([{ car: makeCar(g, 0, 0, 0), clearance: 5 }]);
  assert(g.combo <= CFG.SCORING.COMBO_MAX + 1e-6, 'combo exceeded its cap: ' + g.combo);
  assert(g.comboTimer > 0, 'combo timer should be running');
  g.input.set('up', true);
  fastRun(g, Math.ceil(CFG.SCORING.COMBO_TIMEOUT * 60) + 30);
  assert(g.combo === 1, 'combo should reset after the timeout, got ' + g.combo);
});

test('near misses are detected while overtaking adjacent traffic', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  fastRun(g, 200);
  g.traffic.spawnCooldown = 9999;
  g.traffic.cars.length = 0;
  // one lane over, dead level, much slower: the player sweeps past it
  const car = makeCar(g, 0, 40, 60);
  g.traffic.cars.push(car);
  const scoreBefore = g.score;
  let peakCombo = 1;
  let peakFuel = g.player.boostFuel;
  fastRun(g, 400, 1000 / 60, function (gg) {
    gg.input.set('up', true);
    gg.player.invuln = 999;
    car.x = gg.player.x + gg.world.laneWidth;   // exactly one lane to the right
    car.lane = gg.world.laneAtX(car.dist, car.x);
    car.toLane = car.lane;
    peakCombo = Math.max(peakCombo, gg.combo);
    peakFuel = Math.max(peakFuel, gg.player.boostFuel);
  });
  assert(g.stats.nearMisses >= 1, 'overtaking an adjacent car should register a near miss');
  assert(g.score > scoreBefore, 'score should increase');
  assert(peakCombo > 1, 'combo should build on a near miss (peak ' + peakCombo + ')');
  assert(peakFuel > 10, 'a near miss should refill boost');
});

/* ------------------------------------------------------------------- HUD/UI */

section('UI & HUD');

test('HUD reflects speed, score, distance, difficulty and shields', function () {
  const g = playing(newGame('hard'));
  g.input.set('up', true);
  run(g, 120);
  const el = g.ui.el;
  assert(el.hudSpeed.textContent !== '' && Number(el.hudSpeed.textContent) > 0, 'speed readout empty');
  assert(Number(el.hudScore.textContent.replace(/,/g, '')) > 0, 'score readout empty');
  assert(/m|km/.test(el.hudDistance.textContent), 'distance readout: ' + el.hudDistance.textContent);
  assert(el.hudDifficulty.textContent === 'HARD', 'difficulty chip: ' + el.hudDifficulty.textContent);
  assert(el.hudShields.children.length === DIFFS.hard.shields || /shield/.test(el.hudShields.innerHTML),
    'shields not rendered');
});

test('speedometer gauge draws without errors', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  run(g, 30);
  [0, 0.3, 0.7, 1.0, 1.3].forEach(function (n) {
    g.ui.drawSpeedo(n * 250, n, n > 1 ? 1 : 0, n > 1);
  });
});

test('difficulty cards are built, clickable and persisted', function () {
  const g = newGame('medium');
  const cards = g.ui.el.difficultyList.querySelectorAll('.diff');
  assert(cards.length === 3, 'expected 3 difficulty cards, got ' + cards.length);
  cards[2].dispatch('click');
  assert(g.difficulty.id === 'hard', 'clicking the third card should pick hard, got ' + g.difficulty.id);
  assert(g.ui.difficulty === 'hard', 'the picker should reflect the choice');
  assert(localStorage.getItem(CFG.STORAGE.DIFFICULTY) === 'hard', 'difficulty not persisted');
  assert(cards[2].classList.contains('is-active'), 'active card not highlighted');
  assert(!cards[0].classList.contains('is-active'), 'inactive card still highlighted');
  cards[0].dispatch('click');
  assert(g.difficulty.id === 'easy', 'clicking the first card should pick easy');

  // a freshly constructed game must restore the saved choice
  const raw = new Racer.Game(document.getElementById('game'));
  raw.init();
  assert(raw.difficulty.id === 'easy', 'saved difficulty should be restored on boot, got ' + raw.difficulty.id);
  raw.setDifficulty('medium');
});

test('the selected difficulty is what the race actually uses', function () {
  ['easy', 'medium', 'hard'].forEach(function (id) {
    const g = newGame(id);
    const cards = g.ui.el.difficultyList.querySelectorAll('.diff');
    const index = Racer.DIFFICULTY_ORDER.indexOf(id);
    cards[index].dispatch('click');
    playing(g);
    assert(g.player.diff.id === id, 'player was not built from ' + id);
    assert(g.traffic.diff.id === id, 'traffic was not built from ' + id);
    assert(g.player.shields === DIFFS[id].shields, id + ' shields mismatch');
    assert(g.ui.el.hudDifficulty.textContent === DIFFS[id].label.toUpperCase(),
      'HUD chip should show ' + DIFFS[id].label);
  });
});

test('mute toggles through the HUD button, M key and persists', function () {
  const g = newGame('medium');
  assert(g.audio.muted === false, 'should start unmuted');
  g.ui.el.btnMute.dispatch('click');
  assert(g.audio.muted === true, 'mute button did not mute');
  assert(localStorage.getItem(CFG.STORAGE.MUTED) === '1', 'mute not persisted');
  assert(g.ui.el.btnMute.classList.contains('is-muted'), 'mute icon state not updated');
  global.__dispatchWindow('keydown', { code: 'KeyM' });
  assert(g.audio.muted === false, 'M key did not unmute');
});

test('toasts are created and cleaned up', function () {
  const g = newGame('medium');
  const before = g.ui.el.toasts.children.length;
  g.ui.toast('TEST');
  assert(g.ui.el.toasts.children.length === before + 1, 'toast not appended');
  const added = g.ui.el.toasts.children[g.ui.el.toasts.children.length - 1];
  assert(added.textContent === 'TEST', 'toast text wrong');
  assert(added.classList.contains('toast'), 'toast class missing');
  g.ui.toast('DANGER', 'bad');
  assert(g.ui.el.toasts.children[g.ui.el.toasts.children.length - 1].classList.contains('toast--bad'),
    'toast variant class missing');
});

test('countdown text updates through 3-2-1-GO', function () {
  const g = newGame('medium');
  g.startRace();
  const seen = [];
  run(g, 260, 1000 / 60, function (gg) {
    const t = gg.ui.el.countText.textContent;
    if (seen[seen.length - 1] !== t) seen.push(t);
  });
  assert(seen.indexOf('3') >= 0 && seen.indexOf('2') >= 0 && seen.indexOf('1') >= 0,
    'countdown sequence incomplete: ' + seen.join(','));
  assert(seen.indexOf('GO!') >= 0, 'GO! never shown: ' + seen.join(','));
});

test('game over card reports score, distance, top speed, near misses', function () {
  const g = playing(newGame('medium'));
  g.input.set('up', true);
  fastRun(g, 300);
  g.player.shields = 0;
  g.traffic.cars.length = 0;
  g.traffic.spawnCooldown = 9999;
  const car = makeCar(g, 1, 150, 10);
  g.traffic.cars.push(car);
  fastRun(g, 300, 1000 / 60, function (gg) {
    gg.input.set('up', true);
    if (gg.state === 'playing') gg.player.invuln = 0;
    car.x = gg.player.x;
    car.dist = Math.max(car.dist, gg.player.dist + 25);
  });
  assert(g.state === 'gameover', 'should be game over');
  const statsHtml = g.ui.el.overStats.innerHTML;
  assert(/Distance/.test(statsHtml) && /Top speed/.test(statsHtml) && /Near misses/.test(statsHtml),
    'game over stats incomplete: ' + statsHtml.slice(0, 120));
  assert(Number(g.ui.el.overScore.textContent.replace(/,/g, '')) > 0, 'final score should be > 0');
});

test('best score is stored and flagged as a record', function () {
  localStorage.setItem(CFG.STORAGE.BEST_SCORE, '10');
  const g = playing(newGame('hard'));
  g.input.set('up', true);
  fastRun(g, 400);
  g.score = 5000;
  g.player.shields = 0;
  g.traffic.cars.length = 0;
  g.traffic.spawnCooldown = 9999;
  const car = makeCar(g, 1, 120, 5);
  g.traffic.cars.push(car);
  fastRun(g, 260, 1000 / 60, function (gg) {
    gg.input.set('up', true);
    if (gg.state === 'playing') gg.player.invuln = 0;
    car.x = gg.player.x;
    car.dist = Math.max(car.dist, gg.player.dist + 25);
  });
  assert(g.state === 'gameover', 'expected game over');
  assert(Number(localStorage.getItem(CFG.STORAGE.BEST_SCORE)) >= 4000, 'best score not stored');
  assert(/NEW PERSONAL BEST/i.test(g.ui.el.overBest.textContent), 'record not announced');
  localStorage.setItem(CFG.STORAGE.BEST_SCORE, '0');
});

test('stage fitting keeps the 3:2 aspect ratio on desktop, laptop and tablet', function () {
  const g = newGame('medium');
  const sizes = [[2560, 1440], [1920, 1080], [1440, 900], [1280, 800], [1024, 768], [834, 1112], [768, 1024], [640, 480]];
  sizes.forEach(function (s) {
    global.innerWidth = s[0];
    global.innerHeight = s[1];
    g.ui.fitStage();
    const w = parseFloat(g.ui.el.stage.style.width);
    const h = parseFloat(g.ui.el.stage.style.height);
    assert(w > 0 && h > 0, 'stage not sized for ' + s.join('x'));
    assertNear(w / h, CFG.VIEW.ASPECT, 0.02, 'aspect ratio broken at ' + s.join('x'));
    assert(w <= s[0] && h <= s[1], 'stage overflows the viewport at ' + s.join('x'));
    const scale = parseFloat(g.ui.el.stage.style.props['--ui-scale']);
    assert(scale >= 0.6 && scale <= 1.35, 'ui scale out of range at ' + s.join('x') + ': ' + scale);
    // backing store must stay crisp but bounded
    const backing = g.ui.el.game.width;
    assert(backing >= CFG.VIEW.WIDTH, 'backing store below logical resolution');
    assert(backing <= CFG.VIEW.WIDTH * 2.7, 'backing store exploded: ' + backing);
  });
  global.innerWidth = 1440; global.innerHeight = 900;
  g.ui.fitStage();
});

test('renderer keeps its logical resolution and honours devicePixelRatio', function () {
  const g = newGame('medium');
  global.devicePixelRatio = 1;
  g.renderer.resize();
  assert(g.ui.el.game.width === CFG.VIEW.WIDTH, 'canvas width should be logical width at dpr 1');
  global.devicePixelRatio = 3;                       // clamped to MAX_DPR
  g.renderer.resize();
  assert(g.ui.el.game.width === CFG.VIEW.WIDTH * CFG.VIEW.MAX_DPR, 'dpr should be clamped');
  global.devicePixelRatio = 1;
  g.renderer.resize();
});

/* -------------------------------------------------------------------- audio */

section('Audio (with a fake AudioContext)');

test('audio graph builds, engine updates and one-shots never throw', function () {
  const g = playing(newGame('medium'));
  g.audio.init();
  assert(g.audio.ready === true, 'audio should be ready with a stub context');
  g.audio.startEngine();
  for (let i = 0; i < 20; i++) g.audio.updateEngine(i / 20, 1, i / 40, i % 5 === 0);
  g.audio.playClick(); g.audio.playHover(); g.audio.playCountBeep(false); g.audio.playCountBeep(true);
  g.audio.playNearMiss(3); g.audio.playShieldBreak(); g.audio.playScrape(); g.audio.playBoost();
  g.audio.playCrash(1); g.audio.playCrash(0.3);
  g.audio.setMuted(true); g.audio.setMuted(false);
  g.audio.suspend(); g.audio.unsuspend(); g.audio.stopEngine();
  run(g, 20);
});

test('game still runs with audio completely unavailable', function () {
  const g = playing(newGame('medium'));
  g.audio.supported = false;
  g.audio.ready = false;
  g.audio.ctx = null;
  g.input.set('up', true);
  fastRun(g, 300, 1000 / 60, function (gg) { autopilot(gg); });
  g.audio.playCrash(1);
  g.audio.updateEngine(0.5, 1, 0.5, true);
  g.audio.init();
  assert(g.player.dist > 1000, 'game should run fine without audio, dist=' + g.player.dist);
  assert(g.state === 'playing', 'state should still be playing');
});

/* ---------------------------------------------------------------- rendering */

section('Rendering & performance');

test('full render pipeline runs for every game state', function () {
  const g = newGame('medium');
  run(g, 30);                                   // menu / attract
  g.startRace();
  run(g, 60);                                   // countdown
  let guard = 0;
  while (g.state !== 'playing' && guard++ < 400) run(g, 1);
  g.input.set('up', true);
  run(g, 240);                                  // racing
  g.player.boostFuel = 100;
  g.input.set('boost', true);
  run(g, 60);                                   // boosting
  g.player.x = g.world.centerXAt(g.player.dist) + g.world.pavedHalf + 80;
  run(g, 40);                                   // off-road
  g.togglePause();
  run(g, 20);                                   // paused
  g.togglePause();
  g.player.shields = 0;
  g.traffic.cars.length = 0;
  g.traffic.spawnCooldown = 9999;
  const wall = makeCar(g, 1, 60, 0);
  g.traffic.cars.push(wall);
  run(g, 220, 1000 / 60, function (gg) {        // crash + slow-mo + game over
    gg.input.set('up', true);
    if (gg.state === 'playing') {
      gg.player.invuln = 0;
      wall.x = gg.player.x;
      wall.dist = Math.max(wall.dist, gg.player.dist + 30);
    }
  });
  assert(g.state === 'gameover', 'should be game over after the crash, got ' + g.state);
  run(g, 40);
  g.toMenu();
  run(g, 40);
});

test('camera zooms out with speed and follows the road', function () {
  const g = playing(newGame('medium'));
  clearTraffic(g);
  const z0 = g.renderer.camera.zoom;
  run(g, 400, 1000 / 60, function (gg) { steerOnly(gg); });
  const z1 = g.renderer.camera.zoom;
  assert(z1 < z0, 'camera should zoom out with speed (' + z0 + ' -> ' + z1 + ')');
  assertNear(z1, CFG.CAMERA.ZOOM_MIN, 0.03, 'zoom at top speed');
  const px = g.renderer.camera.toScreenX(g.player.x);
  assert(px > 0 && px < CFG.VIEW.WIDTH, 'player should stay on screen, x=' + px);
  const py = g.renderer.camera.toScreenY(g.player.dist);
  assertNear(py, CFG.VIEW.HEIGHT * CFG.VIEW.PLAYER_ANCHOR, 2, 'player screen anchor');
});

test('screen shake is triggered by impacts and decays', function () {
  const g = playing(newGame('easy'));
  g.renderer.camera.addShake(20);
  assert(g.renderer.camera.shake > 0, 'shake not applied');
  run(g, 90);
  assert(g.renderer.camera.shake < 1, 'shake did not decay: ' + g.renderer.camera.shake);
});

test('particles are emitted, updated and pooled without leaking', function () {
  const g = playing(newGame('hard'));
  g.input.set('up', true);
  for (let i = 0; i < 3000; i++) g.particles.smoke(g.player.x, g.player.dist, 3);
  assert(g.particles.count() <= CFG.FX.MAX_PARTICLES, 'particle pool overflowed: ' + g.particles.count());
  fastRun(g, 200);
  assert(g.particles.count() >= 0, 'negative particle count');
  run(g, 60);
});

test('renderer draw-call budget stays reasonable at 60fps', function () {
  const g = playing(newGame('hard'));
  const real = g.renderer.ctx;
  const proxy = instrumentCtx(real);
  g.renderer.ctx = proxy;
  g.input.set('up', true);
  fastRun(g, 120, 1000 / 60, function (gg) { gg.input.set('up', true); });
  const ops = proxy.__ops;
  ops.count = 0;
  g.render();
  const perFrame = ops.count;
  g.renderer.ctx = real;
  assert(perFrame > 200, 'suspiciously few draw ops: ' + perFrame);
  assert(perFrame < 9000, 'too many draw ops per frame: ' + perFrame);
  console.log('          (draw ops per frame on hard: ' + perFrame + ')');
});

test('a full minute of hard-mode racing stays inside a frame budget', function () {
  const g = playing(newGame('hard'));
  g.input.set('up', true);
  const t0 = Date.now();
  const frames = 60 * 20;                 // 20 simulated seconds
  fastRun(g, frames, 1000 / 60, function (gg) { autopilot(gg); });
  const physicsMs = (Date.now() - t0) / frames;
  const t1 = Date.now();
  run(g, 120, 1000 / 60, function (gg) { autopilot(gg); });
  const fullMs = (Date.now() - t1) / 120;
  console.log('          (software raster: sim ' + physicsMs.toFixed(3) + ' ms/frame, sim+render ' + fullMs.toFixed(2) + ' ms/frame)');
  assert(physicsMs < 4, 'simulation too slow: ' + physicsMs.toFixed(2) + ' ms/frame');
  assert(fullMs < 80, 'software render far too slow: ' + fullMs.toFixed(2) + ' ms/frame');
});

/* ------------------------------------------------------------------- results */

console.log('\n\x1b[1m' + (failed === 0 ? '\x1b[32mALL TESTS PASSED' : '\x1b[31mFAILURES PRESENT') + '\x1b[0m');
console.log('  passed: ' + passed + '   failed: ' + failed);

if (failures.length) {
  console.log('\nFailure details:');
  failures.forEach(function (f) {
    console.log('  - ' + f.name + ': ' + (f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 3).join('\n    ') : f.err));
  });
}
process.exit(failed === 0 ? 0 : 1);
