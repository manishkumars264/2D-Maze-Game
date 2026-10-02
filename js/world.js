/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - world.js
 * ----------------------------------------------------------------------------
 *  Procedural world generation:
 *    - the endless curving road centreline (sum of sine waves)
 *    - biome system (coast / forest / city / farmland / canyon) that smoothly
 *      cross-fades ground colours and roadside props as you drive
 *    - chunked, deterministic, cached scenery generation (trees, palms, signs,
 *      billboards, buildings, light poles, rocks, hay bales, cacti ...)
 *    - road "events": start banner, overhead gantries, distance markers
 *
 *  Everything is derived from distance, so the world is infinite, stable across
 *  frames and costs nothing to rewind/restart.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;
  const CFG = Racer.CONFIG;

  const CHUNK = 220;              // world px per scenery chunk
  const CHUNK_CACHE_MAX = 90;

  /* ------------------------------------------------------------------ biomes */

  /**
   * Each biome defines ground colours, the treatment of the area beyond the
   * barrier ("edge") and a weighted prop mix for both the grass verge and the
   * far background.
   */
  const BIOMES = [
    {
      id: 'coast',
      grassA: '#63c46a', grassB: '#4bab58',
      vergeA: '#7ed07f', vergeB: '#57b45f',
      edge: 'water', edgeA: '#f4e2b0', edgeB: '#2ea3d8',
      haze: '#bff0ff',
      props: { palm: 26, tree: 12, bush: 16, rock: 10, sign: 5, light: 8, hut: 4, boardwalk: 3 },
      bgProps: { rock: 8, palm: 10, sail: 5, dune: 12 },
      treeColors: ['#2f8f4e', '#3aa35c', '#27794a'],
      accent: '#ffd166'
    },
    {
      id: 'forest',
      grassA: '#3f9b52', grassB: '#2e7c41',
      vergeA: '#4fae60', vergeB: '#337f45',
      edge: 'trees', edgeA: '#2a6b3c', edgeB: '#1d4d2c',
      haze: '#d7ffe4',
      props: { pine: 34, tree: 18, bush: 12, rock: 9, log: 6, sign: 4, light: 6 },
      bgProps: { pine: 22, tree: 10, rock: 5 },
      treeColors: ['#1f6b3a', '#2a7d45', '#17552f'],
      accent: '#a7c957'
    },
    {
      id: 'city',
      grassA: '#7ba05b', grassB: '#688f4c',
      vergeA: '#8aae68', vergeB: '#6f9450',
      edge: 'concrete', edgeA: '#9aa4ad', edgeB: '#77818b',
      haze: '#e8f2ff',
      props: { building: 20, billboard: 12, light: 16, tree: 10, bush: 6, sign: 8, fence: 8 },
      bgProps: { building: 26, billboard: 6, tree: 4 },
      treeColors: ['#3f7f45', '#4c8f4f', '#356d3c'],
      accent: '#ff5d8f'
    },
    {
      id: 'farm',
      grassA: '#a8c256', grassB: '#94ad44',
      vergeA: '#bcd167', vergeB: '#9cb84a',
      edge: 'field', edgeA: '#d9b64a', edgeB: '#c19a34',
      haze: '#fff6d8',
      props: { tree: 14, hay: 16, fence: 14, barn: 6, bush: 10, sign: 5, light: 5, silo: 4 },
      bgProps: { field: 18, barn: 6, hay: 8, tree: 8 },
      treeColors: ['#5f8f3a', '#6fa043', '#4f7a31'],
      accent: '#ffb703'
    },
    {
      id: 'canyon',
      grassA: '#c6a674', grassB: '#b08f5c',
      vergeA: '#d3b583', vergeB: '#bb9a66',
      edge: 'rock', edgeA: '#b56b45', edgeB: '#8e4f32',
      haze: '#ffe6cc',
      props: { cactus: 22, rock: 20, bush: 10, mesa: 8, sign: 6, light: 5, tree: 4 },
      bgProps: { mesa: 18, rock: 14, cactus: 6 },
      treeColors: ['#6d8f4a', '#7d9a52', '#5c7a3e'],
      accent: '#fb8500'
    }
  ];

  /* ------------------------------------------------------------------- world */

  function World() {
    this.road = CFG.ROAD;
    this.chunks = new Map();
    this.time = 0;
    this.curveScale = CFG.CURVE.SCALE_START;
    this.laneCount = this.road.LANES;
    this.laneWidth = this.road.LANE_WIDTH;
    this.carriagewayHalf = (this.laneCount * this.laneWidth) / 2;
    this.pavedHalf = this.carriagewayHalf + this.road.RUMBLE_WIDTH + this.road.SHOULDER;
    this.barrierHalf = this.road.BARRIER_OFFSET;
  }

  /** Called on restart / difficulty change. */
  World.prototype.reset = function () {
    this.chunks.clear();
    this.time = 0;
    this.curveScale = CFG.CURVE.SCALE_START;
  };

  /* ------------------------------------------------------------ road shape */

  /** Road centreline x (world) at a given distance. */
  World.prototype.centerXAt = function (dist) {
    let x = 0;
    const waves = CFG.CURVE.WAVES;
    const s = this.curveScale;
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      x += w.amp * Math.sin(dist * w.freq + w.phase);
    }
    return x * s;
  };

  /** Slope of the centreline (px of lateral shift per px travelled). */
  World.prototype.slopeAt = function (dist) {
    let d = 0;
    const waves = CFG.CURVE.WAVES;
    const s = this.curveScale;
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      d += w.amp * w.freq * Math.cos(dist * w.freq + w.phase);
    }
    return d * s;
  };

  /** Centre x of a lane (0-based, left to right). */
  World.prototype.laneCenterX = function (dist, lane) {
    const offset = (lane - (this.laneCount - 1) / 2) * this.laneWidth;
    return this.centerXAt(dist) + offset;
  };

  /** Lane index nearest to a world x at a given distance. */
  World.prototype.laneAtX = function (dist, x) {
    const rel = x - this.centerXAt(dist);
    const lane = Math.round(rel / this.laneWidth + (this.laneCount - 1) / 2);
    return U.clamp(lane, 0, this.laneCount - 1);
  };

  /** How far outside the paved surface a world x is (0 == on the asphalt). */
  World.prototype.offRoadAmount = function (dist, x) {
    return Math.max(0, Math.abs(x - this.centerXAt(dist)) - this.pavedHalf);
  };

  World.prototype.hitBarrier = function (dist, x) {
    return Math.abs(x - this.centerXAt(dist)) >= this.barrierHalf;
  };

  /** Difficulty ramp: curvature grows from SCALE_START to SCALE_MAX. */
  World.prototype.updateCurveScale = function (meters) {
    const c = CFG.CURVE;
    const t = U.clamp(meters / c.SCALE_RAMP_METERS, 0, 1);
    this.curveScale = U.lerp(c.SCALE_START, c.SCALE_MAX, U.smoothstep(t));
  };

  /* --------------------------------------------------------------- biomes */

  World.prototype._biomeDef = function (index) {
    return BIOMES[U.hash(index) % BIOMES.length];
  };

  /**
   * Blended biome at a distance. Returns a palette object with css colours
   * plus the current/next biome definitions (for prop mixing).
   */
  World.prototype.biomeAt = function (dist) {
    const L = CFG.BIOME.LENGTH;
    const F = CFG.BIOME.CROSSFADE;
    const i = Math.floor(dist / L);
    const local = dist - i * L;
    const a = this._biomeDef(i);
    const b = this._biomeDef(i + 1);
    const t = local > L - F ? U.smoothstep((local - (L - F)) / F) : 0;

    if (t === 0) {
      if (a._plain !== true) {
        a._plain = true;
        a._css = {
          grassA: a.grassA, grassB: a.grassB,
          vergeA: a.vergeA, vergeB: a.vergeB,
          edgeA: a.edgeA, edgeB: a.edgeB, haze: a.haze
        };
      }
      return { t: 0, a: a, b: a, css: a._css, id: a.id };
    }

    return {
      t: t,
      a: a,
      b: b,
      id: t < 0.5 ? a.id : b.id,
      css: {
        grassA: U.mixHex(a.grassA, b.grassA, t),
        grassB: U.mixHex(a.grassB, b.grassB, t),
        vergeA: U.mixHex(a.vergeA, b.vergeA, t),
        vergeB: U.mixHex(a.vergeB, b.vergeB, t),
        edgeA: U.mixHex(a.edgeA, b.edgeA, t),
        edgeB: U.mixHex(a.edgeB, b.edgeB, t),
        haze: U.mixHex(a.haze, b.haze, t)
      }
    };
  };

  /* -------------------------------------------------------------- scenery */

  /** Weighted prop mix for a chunk, blending two biomes across a crossfade. */
  World.prototype._propTable = function (biomeInfo, key) {
    const a = biomeInfo.a[key] || {};
    if (biomeInfo.t <= 0.01) return a;
    const b = biomeInfo.b[key] || {};
    const t = biomeInfo.t;
    const out = {};
    const keys = {};
    for (const k in a) keys[k] = true;
    for (const k in b) keys[k] = true;
    for (const k in keys) {
      const w = U.lerp(a[k] || 0, b[k] || 0, t);
      if (w > 0.05) out[k] = w;
    }
    return out;
  };

  World.prototype._chunk = function (index) {
    const cached = this.chunks.get(index);
    if (cached) return cached;

    const startDist = index * CHUNK;
    const rnd = U.mulberry32(U.hash(index * 7919 + 13));
    const biome = this.biomeAt(startDist + CHUNK * 0.5);
    const items = [];

    const vergeTable = this._propTable(biome, 'props');
    const bgTable = this._propTable(biome, 'bgProps');
    const density = 1.5 + rnd() * 1.9;
    const treeColors = biome.t < 0.5 ? biome.a.treeColors : biome.b.treeColors;

    for (let side = -1; side <= 1; side += 2) {
      const count = Math.round(rnd() * 2.4 * density);
      for (let n = 0; n < count; n++) {
        const type = this._weighted(vergeTable, rnd);
        const dist = startDist + rnd() * CHUNK;
        let off = CFG.ROAD.SCENERY_MIN + rnd() * (CFG.ROAD.SCENERY_MAX - CFG.ROAD.SCENERY_MIN);
        // tall/building props sit further back so they never crowd the road
        if (type === 'building' || type === 'mesa' || type === 'billboard') {
          off = CFG.ROAD.SCENERY_MAX - 10 + rnd() * 40;
        }
        if (type === 'light') off = CFG.ROAD.SCENERY_MIN - 12 + rnd() * 10;
        items.push({
          type: type,
          dist: dist,
          off: side * off,
          size: 0.75 + rnd() * 0.7,
          color: treeColors[Math.floor(rnd() * treeColors.length)],
          accent: biome.t < 0.5 ? biome.a.accent : biome.b.accent,
          variant: Math.floor(rnd() * 3),
          seed: Math.floor(rnd() * 1e6),
          bg: false
        });
      }

      // background layer beyond the barrier
      const bgCount = Math.round(rnd() * 1.8);
      for (let n = 0; n < bgCount; n++) {
        const type = this._weighted(bgTable, rnd);
        items.push({
          type: type,
          dist: startDist + rnd() * CHUNK,
          off: side * (CFG.ROAD.BARRIER_OFFSET + 40 + rnd() * 210),
          size: 0.8 + rnd() * 1.3,
          color: treeColors[Math.floor(rnd() * treeColors.length)],
          accent: biome.t < 0.5 ? biome.a.accent : biome.b.accent,
          variant: Math.floor(rnd() * 4),
          seed: Math.floor(rnd() * 1e6),
          bg: true
        });
      }
    }

    // drifting cloud shadows (over everything, purely atmospheric)
    if (rnd() < 0.34) {
      items.push({
        type: 'cloud',
        dist: startDist + rnd() * CHUNK,
        off: (rnd() * 2 - 1) * 340,
        size: 1.4 + rnd() * 2.2,
        drift: 12 + rnd() * 26,
        alpha: 0.07 + rnd() * 0.07,
        seed: Math.floor(rnd() * 1e6),
        bg: true
      });
    }

    if (this.chunks.size > CHUNK_CACHE_MAX) this.chunks.clear();
    this.chunks.set(index, items);
    return items;
  };

  World.prototype._weighted = function (table, rnd) {
    let total = 0;
    for (const k in table) total += table[k];
    if (total <= 0) return 'bush';
    let r = rnd() * total;
    for (const k in table) {
      r -= table[k];
      if (r <= 0) return k;
    }
    return 'bush';
  };

  /** All scenery props between two distances (inclusive). */
  World.prototype.sceneryIn = function (d0, d1) {
    const i0 = Math.floor(d0 / CHUNK);
    const i1 = Math.floor(d1 / CHUNK);
    const out = [];
    for (let i = i0; i <= i1; i++) {
      const items = this._chunk(i);
      for (let n = 0; n < items.length; n++) {
        const it = items[n];
        if (it.dist >= d0 && it.dist <= d1) out.push(it);
      }
    }
    return out;
  };

  /* ---------------------------------------------------------------- events */

  /**
   * Deterministic road furniture that spans the carriageway:
   * start banner, overhead gantries and kilometre markers.
   */
  World.prototype.eventsIn = function (d0, d1) {
    const out = [];
    const GANTRY_FIRST = 2100;
    const GANTRY_EVERY = 2700;
    const MARKER_EVERY = 3000; // == 500 m

    if (d0 <= 260 && d1 >= 0) out.push({ type: 'banner', dist: 0, text: 'START' });

    let k = Math.max(0, Math.ceil((d0 - GANTRY_FIRST) / GANTRY_EVERY));
    for (let dist = GANTRY_FIRST + k * GANTRY_EVERY; dist <= d1; dist += GANTRY_EVERY) {
      out.push({ type: 'gantry', dist: dist, text: GANTRY_TEXTS[k % GANTRY_TEXTS.length] });
      k++;
    }

    let m = Math.max(1, Math.ceil(d0 / MARKER_EVERY));
    for (let dist = m * MARKER_EVERY; dist <= d1; dist += MARKER_EVERY) {
      out.push({ type: 'marker', dist: dist, meters: Math.round(dist * CFG.UNITS.PX_TO_METERS) });
    }
    return out;
  };

  const GANTRY_TEXTS = ['COASTLINE OVERDRIVE', 'KEEP LEFT', 'APEX RUN', 'FULL THROTTLE', 'SUNSET STRAIGHT'];

  Racer.World = World;
  Racer.BIOMES = BIOMES;
})(typeof window !== 'undefined' ? window : globalThis);
