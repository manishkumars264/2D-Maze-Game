/**
 * ============================================================================
 *  tests/screenshots.js  (dev tool - not part of the shipped game)
 * ----------------------------------------------------------------------------
 *  Renders real frames of the game with @napi-rs/canvas and writes PNGs so the
 *  visuals can be inspected without a browser.
 *
 *  Run:  node tests/screenshots.js [outDir]
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const stub = require('./stub-dom');

if (!stub.napiAvailable) {
  console.error('This script needs @napi-rs/canvas. Skipping.');
  process.exit(0);
}

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', '.shots'));
fs.mkdirSync(OUT, { recursive: true });

stub.install({ audio: false, dpr: 1, innerWidth: 1440, innerHeight: 900 });
stub.SOURCE_ORDER.filter(f => f !== 'js/main.js').forEach(stub.loadScript);

const Racer = globalThis.Racer;
const CFG = Racer.CONFIG;

let clock = 0;
function step(g, n, each) {
  for (let i = 0; i < (n || 1); i++) {
    if (each) each(g, i);
    clock += 1000 / 60;
    g.frame(clock);
  }
}

function newGame(difficulty) {
  const g = new Racer.Game(document.getElementById('game'));
  g.init();
  g.setDifficulty(difficulty || 'medium');
  return g;
}

function save(g, name) {
  const buf = g.ui.el.game.toBuffer('image/png');
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, buf);
  console.log('  wrote ' + file + '  (' + (buf.length / 1024).toFixed(0) + ' KB)');
}

function playing(g) {
  g.startRace();
  let guard = 0;
  while (g.state !== 'playing' && guard++ < 400) step(g, 1);
}

function steerOnly(g) {
  const target = g.world.centerXAt(g.player.dist + 90);
  const err = target - g.player.x;
  g.input.set('up', true);
  g.input.set('left', err < -5);
  g.input.set('right', err > 5);
}

console.log('\nRendering screenshots into ' + OUT + '\n');

/* ---------------------------------------------------------------- menu backdrop */
{
  const g = newGame('medium');
  step(g, 220);
  save(g, '01-menu-attract');
}

/* ---------------------------------------------------------------- countdown */
{
  const g = newGame('medium');
  g.startRace();
  step(g, 40);
  save(g, '02-countdown');
}

/* ---------------------------------------------------------------- racing */
{
  const g = newGame('medium');
  playing(g);
  step(g, 240, steerOnly);
  save(g, '03-racing-medium');
}

/* ---------------------------------------------------------------- hard + dense */
{
  const g = newGame('hard');
  playing(g);
  g.player.invuln = 999;
  step(g, 520, function (gg) { steerOnly(gg); gg.player.invuln = 999; });
  save(g, '04-racing-hard-dense');
}

/* ---------------------------------------------------------------- boost */
{
  const g = newGame('hard');
  playing(g);
  g.player.invuln = 999;
  step(g, 400, function (gg) { steerOnly(gg); gg.player.invuln = 999; });
  g.player.boostFuel = 100;
  step(g, 90, function (gg) { steerOnly(gg); gg.input.set('boost', true); gg.player.invuln = 999; });
  save(g, '05-boost');
}

/* ---------------------------------------------------------------- off road */
{
  const g = newGame('medium');
  playing(g);
  step(g, 200, steerOnly);
  g.player.invuln = 999;
  step(g, 70, function (gg) {
    gg.input.set('up', true);
    gg.input.set('right', true);
    gg.player.invuln = 999;
  });
  save(g, '06-offroad');
}

/* ---------------------------------------------------------------- crash */
{
  const g = newGame('hard');
  playing(g);
  step(g, 260, steerOnly);
  g.traffic.cars.length = 0;
  g.traffic.spawnCooldown = 1e6;
  const wall = {
    id: 1, typeKey: 'truck', shape: 'truck', w: 52, l: 138, hw: 26, hl: 69, agility: 0.35,
    lane: 1, fromLane: 1, toLane: 1, laneT: 1, laneChangeCd: 1e6,
    x: g.player.x, dist: g.player.dist + 300, speed: 60, cruise: 60, baseCruise: 60,
    palette: Racer.Vehicles.PALETTES[7], yaw: 0, weavePhase: 0, weaveAmp: 0, weaveRate: 1,
    indicator: 0, passed: false, nearMissScored: false, aggression: 0, blocking: 0,
    brakeCheck: 0, pushTimer: 0, pushSpeed: 0
  };
  g.traffic.cars.push(wall);
  let saved = false;
  step(g, 200, function (gg) {
    gg.input.set('up', true);
    if (gg.state === 'playing') {
      gg.player.invuln = 0;
      wall.x = gg.player.x;
      wall.dist = Math.max(wall.dist, gg.player.dist + 40);
    }
    if (!saved && gg.state === 'crashing' && gg.crashTimer < CFG.FX.CRASH_SLOWMO_TIME * 0.55) {
      saved = true;
      save(gg, '07-crash');
    }
  });
  if (gg_state(g) === 'gameover') save(g, '08-gameover-scene');
}
function gg_state(g) { return g.state; }

/* ---------------------------------------------------------------- biomes */
{
  const wanted = ['coast', 'forest', 'city', 'farm', 'canyon'];
  const found = {};
  const probe = new Racer.World();
  for (let d = 0; d < 400000 && Object.keys(found).length < wanted.length; d += 40) {
    const b = probe.biomeAt(d);
    if (b.t < 0.02 && wanted.indexOf(b.id) >= 0 && !found[b.id]) found[b.id] = d;
  }
  wanted.forEach(function (id, i) {
    const d = found[id];
    if (d === undefined) { console.log('  (no ' + id + ' biome found)'); return; }
    const g = newGame('medium');
    playing(g);
    g.player.dist = d;
    g.player.x = g.world.centerXAt(d);
    g.world.updateCurveScale(g.player.meters());
    g.traffic.reset(g.difficulty, d);
    g.renderer.camera.snapTo(g.player);
    g.player.invuln = 999;
    step(g, 150, function (gg) { steerOnly(gg); gg.player.invuln = 999; });
    save(g, '0' + (9 + i) + '-biome-' + id);
  });
}

console.log('\nDone.');
