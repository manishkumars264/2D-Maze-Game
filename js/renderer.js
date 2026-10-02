/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - renderer.js
 * ----------------------------------------------------------------------------
 *  All canvas drawing lives here:
 *
 *    Camera   - smooth follow, speed-based zoom-out, screen shake, and the
 *               world <-> screen projection used by every other module.
 *    Renderer - layered painter:
 *                 1. ground gradients (biome colours blended by distance)
 *                 2. mown grass stripes + terrain beyond the barrier
 *                 3. road: shoulder, rumble kerbs, asphalt, lane markings,
 *                    painted arrows, gantries, start banner, markers
 *                 4. armco barriers
 *                 5. roadside props (trees, palms, signs, buildings, ...)
 *                 6. cloud shadows
 *                 7. traffic + player cars
 *                 8. particles
 *                 9. speed FX, boost glow, vignette, sun glare
 *
 *  Everything is procedural - there are no image assets in this project.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;
  const CFG = Racer.CONFIG;
  const ROAD = CFG.ROAD;
  const SHADOW = CFG.FX.SHADOW_DIR;

  /* ==================================================================== *
   *  CAMERA
   * ==================================================================== */

  function Camera(world) {
    this.world = world;
    this.viewWidth = CFG.VIEW.WIDTH;
    this.viewHeight = CFG.VIEW.HEIGHT;
    this.anchorY = CFG.VIEW.HEIGHT * CFG.VIEW.PLAYER_ANCHOR;
    this.x = 0;
    this.dist = 0;
    this.zoom = CFG.CAMERA.ZOOM_MAX;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.roll = 0;
    this.time = 0;
  }

  Camera.prototype.snapTo = function (player) {
    const C = CFG.CAMERA;
    this.dist = player.dist;
    this.x = player.x * (1 - C.ROAD_FOLLOW) + this.world.centerXAt(player.dist) * C.ROAD_FOLLOW;
    this.zoom = C.ZOOM_MAX;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    return this;
  };

  Camera.prototype.update = function (dt, player) {
    const C = CFG.CAMERA;
    this.time += dt;
    this.dist = player.dist;

    const speedNorm = U.clamp(player.speed / CFG.PLAYER.MAX_SPEED, 0, 1);
    const targetZoom = U.lerp(C.ZOOM_MAX, C.ZOOM_MIN, U.smoothstep(speedNorm));
    this.zoom = U.damp(this.zoom, targetZoom, C.ZOOM_LERP, dt);

    const targetX =
      player.x * (1 - C.ROAD_FOLLOW) +
      this.world.centerXAt(player.dist) * C.ROAD_FOLLOW +
      player.lateralVel * 0.13;
    this.x = U.damp(this.x, targetX, C.X_LERP, dt);

    // decaying screen shake
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - (C.SHAKE_DECAY * this.shake + 6) * dt);
      this.shakeX = U.rand(-1, 1) * this.shake;
      this.shakeY = U.rand(-1, 1) * this.shake * 0.7;
      this.roll = U.rand(-1, 1) * this.shake * 0.0012;
    } else {
      this.shakeX = this.shakeY = this.roll = 0;
    }
  };

  Camera.prototype.addShake = function (amount) {
    this.shake = Math.min(CFG.CAMERA.MAX_SHAKE, this.shake + amount);
  };

  /** world lateral x -> screen x */
  Camera.prototype.toScreenX = function (worldX) {
    return (worldX - this.x) * this.zoom + this.viewWidth * 0.5 + this.shakeX;
  };

  /** world distance -> screen y (forward is up the screen) */
  Camera.prototype.toScreenY = function (dist) {
    return this.anchorY - (dist - this.dist) * this.zoom + this.shakeY;
  };

  Camera.prototype.toWorldX = function (screenX) {
    return (screenX - this.viewWidth * 0.5 - this.shakeX) / this.zoom + this.x;
  };

  Camera.prototype.toWorldDist = function (screenY) {
    return this.dist + (this.anchorY + this.shakeY - screenY) / this.zoom;
  };

  /** Visible distance band (with a margin so nothing pops in on screen). */
  Camera.prototype.visibleRange = function (margin) {
    const m = margin === undefined ? 140 : margin;
    return {
      d0: this.toWorldDist(this.viewHeight) - m,
      d1: this.toWorldDist(0) + m
    };
  };

  Camera.prototype.worldHalfWidth = function () {
    return this.viewWidth * 0.5 / this.zoom + 120;
  };

  /* ==================================================================== *
   *  RENDERER
   * ==================================================================== */

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.camera = new Camera(world);
    this.dpr = 1;
    this.width = CFG.VIEW.WIDTH;
    this.height = CFG.VIEW.HEIGHT;
    this.noisePattern = null;
    this.vignette = null;
    this._buildTextures();
    this.resize();
  }

  Renderer.prototype._buildTextures = function () {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.createElement) return;

    // subtle asphalt grain
    const tile = doc.createElement('canvas');
    tile.width = tile.height = 96;
    const tctx = tile.getContext('2d');
    if (!tctx) return;
    const img = tctx.createImageData(96, 96);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 120 + Math.random() * 90;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 26;
    }
    tctx.putImageData(img, 0, 0);
    try {
      this.noisePattern = this.ctx.createPattern(tile, 'repeat');
    } catch (e) {
      this.noisePattern = null;
    }
  };

  /**
   * Size the backing store for the stage's current CSS size.
   *
   * All game logic and drawing happens in a fixed logical space
   * (CFG.VIEW.WIDTH x HEIGHT); this only changes how many device pixels that
   * space is rasterised into, so the play area stays crisp at any window size
   * while gameplay remains identical everywhere.
   *
   * @param {number} [cssWidth]  displayed width of the stage in CSS px
   * @param {number} [cssHeight] displayed height of the stage in CSS px
   */
  Renderer.prototype.resize = function (cssWidth, cssHeight) {
    const dpr = U.clamp(global.devicePixelRatio || 1, 1, CFG.VIEW.MAX_DPR);
    const cssScale = cssWidth ? cssWidth / CFG.VIEW.WIDTH : 1;
    // never render below 1x, never above ~2.6x (diminishing returns, big cost)
    const scale = U.clamp(cssScale * dpr, 1, 2.6);
    this.renderScale = scale;
    this.dpr = dpr;

    this.canvas.width = Math.round(CFG.VIEW.WIDTH * scale);
    this.canvas.height = Math.round(CFG.VIEW.HEIGHT * scale);
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    void cssHeight;

    // vignette is resolution dependent - rebuild it
    const g = this.ctx.createRadialGradient(
      this.width * 0.5, this.height * 0.52, this.height * 0.34,
      this.width * 0.5, this.height * 0.52, this.height * 0.92
    );
    g.addColorStop(0, 'rgba(6,10,18,0)');
    g.addColorStop(1, 'rgba(6,10,18,' + CFG.FX.VIGNETTE + ')');
    this.vignette = g;
  };

  /* ------------------------------------------------------------- gradients */

  /**
   * Vertical gradient whose stops are sampled from the world at different
   * distances - this is what makes biome cross-fades perfectly smooth.
   */
  Renderer.prototype._distanceGradient = function (d0, d1, colorFn, stops) {
    const ctx = this.ctx;
    const cam = this.camera;
    const y0 = cam.toScreenY(d0);
    const y1 = cam.toScreenY(d1);
    const g = ctx.createLinearGradient(0, y0, 0, y1 === y0 ? y0 + 1 : y1);
    const n = stops || 7;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      g.addColorStop(t, colorFn(U.lerp(d0, d1, t)));
    }
    return g;
  };

  /** Build a screen-space polygon for a strip of road-relative offsets. */
  Renderer.prototype._stripPath = function (d0, d1, offA, offB, steps) {
    const ctx = this.ctx;
    const cam = this.camera;
    const world = this.world;
    const span = d1 - d0;
    const n = steps || U.clamp(Math.ceil(span / 70), 2, 14);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const d = d0 + (span * i) / n;
      const off = typeof offA === 'function' ? offA(d) : offA;
      const x = cam.toScreenX(world.centerXAt(d) + off);
      const y = cam.toScreenY(d);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = n; i >= 0; i--) {
      const d = d0 + (span * i) / n;
      const off = typeof offB === 'function' ? offB(d) : offB;
      ctx.lineTo(cam.toScreenX(world.centerXAt(d) + off), cam.toScreenY(d));
    }
    ctx.closePath();
  };

  Renderer.prototype._fillStrip = function (d0, d1, offA, offB, style, steps) {
    this._stripPath(d0, d1, offA, offB, steps);
    if (style) this.ctx.fillStyle = style;   // null => keep the caller's style
    this.ctx.fill();
  };

  /* ================================================================== *
   *  MAIN ENTRY
   * ================================================================== */

  /**
   * @param {object} g the Game instance (player, traffic, particles, state)
   */
  Renderer.prototype.render = function (g) {
    const ctx = this.ctx;
    const cam = this.camera;
    const range = cam.visibleRange(180);

    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);

    if (cam.roll) {
      ctx.translate(this.width / 2, this.height / 2);
      ctx.rotate(cam.roll);
      ctx.translate(-this.width / 2, -this.height / 2);
    }

    this.drawGround(range);
    this.drawBeyondBarrier(range);
    this.drawGrassStripes(range);
    this.drawRoad(range);
    this.drawRoadEvents(range);
    this.drawBarriers(range);
    this.drawScenery(range, g);
    this.drawCloudShadows(range, g);
    this.drawTraffic(g);
    this.drawPlayer(g);
    g.particles.render(ctx, cam);
    this.drawSpeedFX(g);
    this.drawAtmosphere(g);

    ctx.restore();

    if (CFG.DEBUG) this.drawDebug(g);
  };

  /* --------------------------------------------------------------- ground */

  Renderer.prototype.drawGround = function (range) {
    const ctx = this.ctx;
    const world = this.world;
    ctx.fillStyle = this._distanceGradient(range.d0, range.d1, function (d) {
      return world.biomeAt(d).css.grassA;
    });
    ctx.fillRect(0, 0, this.width, this.height);
  };

  /** Mown-grass stripes scrolling with the road. */
  Renderer.prototype.drawGrassStripes = function (range) {
    const ctx = this.ctx;
    const world = this.world;
    const period = 150;
    const half = 75;
    const start = Math.floor(range.d0 / period) * period;

    for (let d = start; d < range.d1; d += period) {
      const biome = world.biomeAt(d + half * 0.5);
      ctx.fillStyle = biome.css.grassB;
      ctx.globalAlpha = 0.55;
      for (let side = -1; side <= 1; side += 2) {
        this._fillStrip(d, d + half, side * world.pavedHalf, side * (world.barrierHalf + 6), null, 3);
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1;
  };

  /** Terrain outside the barriers: water / fields / concrete / rock / forest. */
  Renderer.prototype.drawBeyondBarrier = function (range) {
    const ctx = this.ctx;
    const world = this.world;
    const far = world.barrierHalf + 900;

    for (let side = -1; side <= 1; side += 2) {
      // base terrain beyond the barrier
      const grad = this._distanceGradient(range.d0, range.d1, function (d) {
        return world.biomeAt(d).css.edgeA;
      });
      this._fillStrip(range.d0, range.d1, side * (world.barrierHalf - 2), side * far, grad, 6);

      // darker far band for depth
      const grad2 = this._distanceGradient(range.d0, range.d1, function (d) {
        return world.biomeAt(d).css.edgeB;
      });
      ctx.globalAlpha = 0.8;
      this._fillStrip(range.d0, range.d1, side * (world.barrierHalf + 170), side * far, grad2, 6);
      ctx.globalAlpha = 1;
    }

    // water shimmer in coast biomes
    const centerBiome = world.biomeAt(this.camera.dist + 200);
    if (centerBiome.a.edge === 'water' || centerBiome.b.edge === 'water') {
      const alpha = centerBiome.a.edge === 'water' ? 1 - centerBiome.t : centerBiome.t;
      if (alpha > 0.05) {
        ctx.save();
        ctx.globalAlpha = 0.35 * alpha;
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        const period = 190;
        const start = Math.floor(range.d0 / period) * period;
        for (let d = start; d < range.d1; d += period) {
          const off = ((d + world.time * 26) % period) / period;
          ctx.globalAlpha = 0.28 * alpha * (1 - off);
          for (let side = -1; side <= 1; side += 2) {
            const y = this.camera.toScreenY(d + off * period);
            const x0 = this.camera.toScreenX(this.world.centerXAt(d) + side * (world.barrierHalf + 180));
            const x1 = this.camera.toScreenX(this.world.centerXAt(d) + side * (world.barrierHalf + 560));
            ctx.beginPath();
            ctx.moveTo(Math.min(x0, x1), y);
            ctx.lineTo(Math.max(x0, x1), y);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }
  };

  /* ----------------------------------------------------------------- road */

  Renderer.prototype.drawRoad = function (range) {
    const ctx = this.ctx;
    const world = this.world;
    const d0 = range.d0;
    const d1 = range.d1;
    const cw = world.carriagewayHalf;
    const paved = world.pavedHalf;

    /* gravel verge between the paved shoulder and the grass */
    for (let side = -1; side <= 1; side += 2) {
      this._fillStrip(d0, d1, side * paved, side * (paved + 20), '#a4916f', 6);
      this._fillStrip(d0, d1, side * (paved + 20), side * (paved + 28), '#8a7a5e', 6);
    }

    /* hard shoulder (slightly lighter/duller than the lanes) */
    for (let side = -1; side <= 1; side += 2) {
      this._fillStrip(d0, d1, side * (cw + ROAD.RUMBLE_WIDTH), side * paved, '#5c6169', 6);
    }

    /* asphalt */
    const asphalt = ctx.createLinearGradient(0, this.camera.toScreenY(d0), 0, this.camera.toScreenY(d1));
    asphalt.addColorStop(0, '#3e434b');
    asphalt.addColorStop(0.5, '#4a505a');
    asphalt.addColorStop(1, '#3d424a');
    this._stripPath(d0, d1, -cw, cw, 8);
    ctx.fillStyle = asphalt;
    ctx.fill();

    /* grain */
    if (this.noisePattern) {
      ctx.save();
      this._stripPath(d0, d1, -cw, cw, 8);
      ctx.clip();
      ctx.translate(0, (this.camera.dist * this.camera.zoom) % 96);
      ctx.fillStyle = this.noisePattern;
      ctx.fillRect(-40, -this.height, this.width + 80, this.height * 3);
      ctx.restore();
    }

    /* soft camber highlight down the middle of the carriageway */
    ctx.globalAlpha = 0.07;
    this._fillStrip(d0, d1, -cw * 0.34, cw * 0.34, '#ffffff', 6);
    ctx.globalAlpha = 1;

    /* rumble kerbs (red/white) */
    const rumblePeriod = ROAD.RUMBLE_LEN * 2;
    const rStart = Math.floor(d0 / rumblePeriod) * rumblePeriod;
    for (let d = rStart; d < d1; d += ROAD.RUMBLE_LEN) {
      const idx = Math.round(d / ROAD.RUMBLE_LEN);
      const red = idx % 2 === 0;
      ctx.fillStyle = red ? '#e2453c' : '#f2f4f6';
      for (let side = -1; side <= 1; side += 2) {
        this._stripPath(d, d + ROAD.RUMBLE_LEN, side * cw, side * (cw + ROAD.RUMBLE_WIDTH), 2);
        ctx.fill();
      }
    }

    /* solid edge lines */
    for (let side = -1; side <= 1; side += 2) {
      this._fillStrip(d0, d1, side * (cw - 9), side * (cw - 3), 'rgba(246,248,250,0.9)', 6);
    }

    /* dashed lane dividers */
    const dashPeriod = ROAD.DASH_LEN + ROAD.DASH_GAP;
    const dashStart = Math.floor(d0 / dashPeriod) * dashPeriod;
    ctx.fillStyle = 'rgba(250,250,250,0.88)';
    for (let l = 1; l < world.laneCount; l++) {
      const off = (l - world.laneCount / 2) * world.laneWidth;
      for (let d = dashStart; d < d1; d += dashPeriod) {
        this._stripPath(d, d + ROAD.DASH_LEN, off - 3, off + 3, 2);
        ctx.fill();
      }
    }

    /* painted direction arrows every ~1100px */
    this._drawRoadArrows(d0, d1, cw);

    /* tyre rubber in the racing lines (subtle darkening) */
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#14161a';
    for (let l = 0; l < world.laneCount; l++) {
      const c = (l - (world.laneCount - 1) / 2) * world.laneWidth;
      this._fillStrip(d0, d1, c - 14, c - 6, '#14161a', 6);
      this._fillStrip(d0, d1, c + 6, c + 14, '#14161a', 6);
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawRoadArrows = function (d0, d1) {
    const ctx = this.ctx;
    const world = this.world;
    const every = 1150;
    const start = Math.floor(d0 / every) * every;
    ctx.save();
    ctx.fillStyle = 'rgba(240,244,248,0.5)';
    for (let d = start; d < d1; d += every) {
      const lane = Math.floor((d / every)) % world.laneCount;
      const cx = world.laneCenterX(d, lane);
      const x = this.camera.toScreenX(cx);
      const z = this.camera.zoom;
      for (let k = 0; k < 2; k++) {
        const y = this.camera.toScreenY(d + k * 46);
        ctx.beginPath();
        ctx.moveTo(x - 15 * z, y + 12 * z);
        ctx.lineTo(x, y - 12 * z);
        ctx.lineTo(x + 15 * z, y + 12 * z);
        ctx.lineTo(x + 7 * z, y + 12 * z);
        ctx.lineTo(x, y - 1 * z);
        ctx.lineTo(x - 7 * z, y + 12 * z);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  };

  /* ---------------------------------------------------------- road events */

  Renderer.prototype.drawRoadEvents = function (range) {
    const ctx = this.ctx;
    const world = this.world;
    const events = world.eventsIn(range.d0, range.d1);
    const cw = world.carriagewayHalf;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const d = e.dist;
      const center = world.centerXAt(d);

      if (e.type === 'gantry') {
        // shadow of the overhead structure falls across the road
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = '#0d1117';
        this._stripPath(d + 26, d + 64, -cw - 40, cw + 40, 3);
        ctx.fill();
        ctx.restore();

        // the gantry beam itself (viewed from above)
        ctx.save();
        const y = this.camera.toScreenY(d);
        const x0 = this.camera.toScreenX(center - cw - 46);
        const x1 = this.camera.toScreenX(center + cw + 46);
        const z = this.camera.zoom;
        const grad = ctx.createLinearGradient(x0, y - 12 * z, x0, y + 12 * z);
        grad.addColorStop(0, '#8d97a3');
        grad.addColorStop(0.45, '#dfe6ee');
        grad.addColorStop(1, '#5d666f');
        ctx.fillStyle = grad;
        U.roundRectPath(ctx, x0, y - 13 * z, x1 - x0, 26 * z, 4 * z);
        ctx.fill();
        ctx.strokeStyle = 'rgba(20,26,34,0.6)';
        ctx.lineWidth = 1.4;
        ctx.stroke();

        // sign board
        const bw = 210 * z;
        const bx = (x0 + x1) / 2 - bw / 2;
        U.roundRectPath(ctx, bx, y - 22 * z, bw, 30 * z, 5 * z);
        ctx.fillStyle = '#12325c';
        ctx.fill();
        ctx.strokeStyle = '#e8eef6';
        ctx.lineWidth = 2 * z;
        ctx.stroke();
        ctx.fillStyle = '#eaf2ff';
        ctx.font = '700 ' + Math.round(13 * z) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(e.text, bx + bw / 2, y - 7 * z);
        ctx.restore();
      } else if (e.type === 'banner') {
        // checkered start line
        const cells = 12;
        const cellW = (cw * 2) / cells;
        for (let r = 0; r < 2; r++) {
          for (let c = 0; c < cells; c++) {
            const on = (r + c) % 2 === 0;
            ctx.fillStyle = on ? '#f5f7fa' : '#1d222a';
            const offA = -cw + c * cellW;
            this._stripPath(d + r * 22, d + r * 22 + 22, offA, offA + cellW, 2);
            ctx.fill();
          }
        }
      } else if (e.type === 'marker') {
        // small distance marker board on the right verge
        const z = this.camera.zoom;
        const x = this.camera.toScreenX(center + world.pavedHalf + 46);
        const y = this.camera.toScreenY(d);
        ctx.save();
        ctx.fillStyle = 'rgba(10,16,12,0.3)';
        U.roundRectPath(ctx, x + SHADOW.x * 8, y + SHADOW.y * 8, 26 * z, 18 * z, 3 * z);
        ctx.fill();
        U.roundRectPath(ctx, x - 13 * z, y - 9 * z, 26 * z, 18 * z, 3 * z);
        ctx.fillStyle = '#f4f7fb';
        ctx.fill();
        ctx.strokeStyle = '#2b3440';
        ctx.lineWidth = 1.6 * z;
        ctx.stroke();
        ctx.fillStyle = '#1c2530';
        ctx.font = '800 ' + Math.round(9 * z) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(e.meters + 'm', x, y);
        ctx.restore();
      }
    }
  };

  /* ------------------------------------------------------------- barriers */

  Renderer.prototype.drawBarriers = function (range) {
    const ctx = this.ctx;
    const world = this.world;
    const d0 = range.d0;
    const d1 = range.d1;

    for (let side = -1; side <= 1; side += 2) {
      const off = side * world.barrierHalf;
      // shadow
      ctx.globalAlpha = 0.28;
      this._fillStrip(d0, d1, off + side * 8, off + side * 22, '#0f1a12', 6);
      ctx.globalAlpha = 1;
      // rail
      const grad = this._distanceGradient(d0, d1, function () { return '#c9d2dc'; });
      this._fillStrip(d0, d1, off - side * 2, off + side * 8, grad, 6);
      // rail stripe
      ctx.globalAlpha = 0.5;
      this._fillStrip(d0, d1, off + side * 1, off + side * 4, '#7c8794', 6);
      ctx.globalAlpha = 1;

      // posts
      const every = 84;
      const start = Math.floor(d0 / every) * every;
      ctx.fillStyle = '#6f7a86';
      for (let d = start; d < d1; d += every) {
        const x = this.camera.toScreenX(world.centerXAt(d) + off + side * 10);
        const y = this.camera.toScreenY(d);
        const z = this.camera.zoom;
        ctx.fillRect(x - 3 * z, y - 7 * z, 6 * z, 14 * z);
      }
    }
  };

  /* ------------------------------------------------------------- scenery */

  Renderer.prototype.drawScenery = function (range, g) {
    const world = this.world;
    const items = world.sceneryIn(range.d0, range.d1);
    // far to near so closer props overlap correctly
    items.sort(function (a, b) { return b.dist - a.dist; });

    const ctx = this.ctx;
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      if (p.type === 'cloud') continue;
      const wx = world.centerXAt(p.dist) + p.off;
      const sx = this.camera.toScreenX(wx);
      const sy = this.camera.toScreenY(p.dist);
      if (sx < -260 || sx > this.width + 260) continue;
      const scale = this.camera.zoom * p.size;
      this.drawProp(p, sx, sy, scale, g);
    }
    void ctx;
  };

  /** Dispatch to a prop painter. All coordinates are screen space. */
  Renderer.prototype.drawProp = function (p, x, y, s, g) {
    const fn = PROPS[p.type];
    if (fn) fn(this.ctx, p, x, y, s, g, this);
    else PROPS.bush(this.ctx, p, x, y, s, g, this);
  };

  /** Large soft cloud shadows drifting over the terrain. */
  Renderer.prototype.drawCloudShadows = function (range, g) {
    const world = this.world;
    const items = world.sceneryIn(range.d0 - 300, range.d1 + 300);
    const ctx = this.ctx;
    ctx.save();
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      if (p.type !== 'cloud') continue;
      const drift = (world.time * p.drift) % 2400;
      const wx = world.centerXAt(p.dist) + p.off + drift - 600;
      const sx = this.camera.toScreenX(wx);
      const sy = this.camera.toScreenY(p.dist);
      const r = 190 * this.camera.zoom * p.size;
      if (sx < -r || sx > this.width + r) continue;
      const grad = ctx.createRadialGradient(sx, sy, r * 0.15, sx, sy, r);
      grad.addColorStop(0, 'rgba(20,40,60,' + p.alpha + ')');
      grad.addColorStop(0.55, 'rgba(20,40,60,' + p.alpha * 0.55 + ')');
      grad.addColorStop(1, 'rgba(20,40,60,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(sx, sy, r, r * 0.62, 0.2, 0, U.TAU);
      ctx.fill();
    }
    ctx.restore();
    void g;
  };

  /* ------------------------------------------------------------ vehicles */

  Renderer.prototype.drawTraffic = function (g) {
    const ctx = this.ctx;
    const cam = this.camera;
    const cars = g.traffic.cars;
    const playerSpeed = g.player.speed;

    // far to near
    const sorted = cars.slice().sort(function (a, b) { return b.dist - a.dist; });

    for (let i = 0; i < sorted.length; i++) {
      const car = sorted[i];
      const sx = cam.toScreenX(car.x);
      const sy = cam.toScreenY(car.dist);
      if (sy < -220 || sy > this.height + 220 || sx < -160 || sx > this.width + 160) continue;

      const relSpeed = playerSpeed - car.speed;
      const z = cam.zoom;

      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(z, z);

      // motion ghosts when the player is closing fast
      if (relSpeed > 170) {
        const ghosts = relSpeed > 300 ? 2 : 1;
        for (let k = 1; k <= ghosts; k++) {
          ctx.save();
          ctx.globalAlpha = 0.13 / k;
          ctx.translate(0, k * 16);
          Racer.Vehicles.drawCar(ctx, {
            w: car.w, l: car.l, shape: car.shape, palette: car.palette,
            angle: car.yaw, shadow: false, lights: false
          });
          ctx.restore();
        }
      }

      Racer.Vehicles.drawCar(ctx, {
        w: car.w,
        l: car.l,
        shape: car.shape,
        palette: car.palette,
        angle: car.yaw,
        steer: car.yaw * 0.6,
        braking: car.brakeCheck > 0 ? 1 : 0,
        lights: false,
        shadow: true,
        speedNorm: car.speed / CFG.PLAYER.MAX_SPEED
      });

      // lane-change indicator
      if (car.indicator > 0.15 && Math.floor(world_time(g) * 7) % 2 === 0) {
        const dir = car.toLane > car.fromLane ? 1 : -1;
        ctx.fillStyle = 'rgba(255,176,32,0.95)';
        ctx.beginPath();
        const bx = dir * (car.hw + 10);
        ctx.moveTo(bx, 0);
        ctx.lineTo(bx - dir * 9, -7);
        ctx.lineTo(bx - dir * 9, 7);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    }
  };

  Renderer.prototype.drawPlayer = function (g) {
    // the menu runs an attract-mode flyby with no visible hero car
    if (g.state === 'menu') return;

    const ctx = this.ctx;
    const cam = this.camera;
    const p = g.player;
    const sx = cam.toScreenX(p.x);
    const sy = cam.toScreenY(p.dist);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(cam.zoom, cam.zoom);

    // flicker while invulnerable, but never fully disappear
    if (p.invuln > 0 && !g.crashed) {
      ctx.globalAlpha = Math.floor(p.invuln * 14) % 2 === 1 ? 0.4 : 1;
    }

    {
      Racer.Vehicles.drawCar(ctx, {
        w: p.w,
        l: p.l,
        shape: p.shape,
        palette: p.palette,
        angle: p.yaw,
        steer: p.steer * 0.42,
        braking: p.braking,
        lights: true,
        hero: true,
        boost: p.boostPower * (p.boosting ? 1 : 0.4),
        invuln: p.invuln > 0 ? p.invuln : 0,
        shadow: true,
        speedNorm: p.speedNorm()
      });
    }

    if (g.crashed) {
      // wreck: scorch + smoke column base
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.ellipse(0, 0, p.w * 0.9, p.l * 0.7, 0, 0, U.TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  };

  /* ------------------------------------------------------------- speed FX */

  Renderer.prototype.drawSpeedFX = function (g) {
    const ctx = this.ctx;
    const p = g.player;
    const norm = U.clamp(p.speed / CFG.PLAYER.MAX_SPEED, 0, 1.3);
    const t = g.time;

    // motion streaks hugging the outer edges of the frame (subtle!)
    if (norm > CFG.FX.SPEED_LINE_START && g.state === 'playing') {
      const strength = U.clamp((norm - CFG.FX.SPEED_LINE_START) / (1 - CFG.FX.SPEED_LINE_START), 0, 1);
      const count = Math.round(8 + strength * 18);
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < count; i++) {
        const seed = U.hash(i * 977 + Math.floor(t * 22));
        const rnd = (seed % 1000) / 1000;
        const rnd2 = ((seed >> 10) % 1000) / 1000;
        const side = rnd2 > 0.5 ? 1 : -1;
        const x = this.width * 0.5 + side * this.width * (0.33 + rnd * 0.16);
        const len = 26 + strength * 110 * (0.4 + rnd);
        const y = ((rnd2 * 900 + t * (1000 + strength * 2400)) % (this.height + 300)) - 150;
        // fade the streak at both ends
        const grad = ctx.createLinearGradient(x, y, x, y + len);
        const a = (0.05 + strength * 0.10) * (0.5 + rnd * 0.5);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, 'rgba(255,255,255,' + a.toFixed(3) + ')');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + len);
        ctx.stroke();
      }
      ctx.restore();
    }

    // boost: converging light streaks + cool tint
    if (p.boostPower > 0.02 && g.state === 'playing') {
      const b = p.boostPower;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(120,200,255,' + (0.10 * b).toFixed(3) + ')';
      ctx.lineWidth = 2;
      const cx = this.width * 0.5;
      const cy = this.camera.anchorY;
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * U.TAU + t * 0.6;
        const r0 = 150 + ((i * 37 + t * 420) % 220);
        const r1 = r0 + 120 * b;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.7);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.7);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(60,150,255,' + (0.07 * b).toFixed(3) + ')';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }

    // off-road: warm dust haze at the bottom of the screen
    if (p.onGrass > 0.05) {
      ctx.save();
      const hz = ctx.createLinearGradient(0, this.height, 0, this.height * 0.45);
      hz.addColorStop(0, 'rgba(190,170,110,' + (0.34 * p.onGrass).toFixed(3) + ')');
      hz.addColorStop(1, 'rgba(190,170,110,0)');
      ctx.fillStyle = hz;
      ctx.fillRect(0, this.height * 0.4, this.width, this.height * 0.6);
      ctx.restore();
    }
  };

  /** Sun glare, vignette, and a red pulse when the run is on its last shield. */
  Renderer.prototype.drawAtmosphere = function (g) {
    const ctx = this.ctx;

    // sun glare from the top-left
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sun = ctx.createRadialGradient(
      this.width * 0.12, -this.height * 0.1, 20,
      this.width * 0.12, -this.height * 0.1, this.height * 1.1
    );
    sun.addColorStop(0, 'rgba(255,242,190,0.36)');
    sun.addColorStop(0.35, 'rgba(255,232,170,0.13)');
    sun.addColorStop(1, 'rgba(255,230,170,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();

    // heat shimmer band near the horizon (top of the screen) - fully faded so
    // there is never a visible seam
    ctx.save();
    const biome = this.world.biomeAt(this.camera.toWorldDist(0));
    // white aerial haze, fading out smoothly (no seam)
    const haze = ctx.createLinearGradient(0, 0, 0, this.height * 0.32);
    haze.addColorStop(0, 'rgba(255,255,255,0.30)');
    haze.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, this.width, this.height * 0.32);
    // biome-tinted distance fog on top of it
    const fog = ctx.createLinearGradient(0, 0, 0, this.height * 0.22);
    fog.addColorStop(0, biome.css.haze);
    fog.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, this.width, this.height * 0.22);
    ctx.restore();

    if (this.vignette) {
      ctx.save();
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }

    // last-shield danger pulse
    if (g.state === 'playing' && g.player.shields <= 1 && !g.crashed) {
      const pulse = (Math.sin(g.time * 4.2) * 0.5 + 0.5) * 0.16;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const dg = ctx.createRadialGradient(
        this.width / 2, this.height / 2, this.height * 0.3,
        this.width / 2, this.height / 2, this.height * 0.85
      );
      dg.addColorStop(0, 'rgba(255,40,60,0)');
      dg.addColorStop(1, 'rgba(255,40,60,' + pulse.toFixed(3) + ')');
      ctx.fillStyle = dg;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }

    // crash flash
    if (g.crashFlash > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,220,160,' + (g.crashFlash * 0.55).toFixed(3) + ')';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }
  };

  Renderer.prototype.drawDebug = function (g) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, 8, 250, 74);
    ctx.fillStyle = '#7CFC00';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('fps ' + Math.round(g.fps) + '  state ' + g.state, 16, 16);
    ctx.fillText('cars ' + g.traffic.count() + '  target ' + g.traffic.targetCount(), 16, 32);
    ctx.fillText('parts ' + g.particles.count() + '  zoom ' + this.camera.zoom.toFixed(3), 16, 48);
    ctx.fillText('dist ' + g.player.meters().toFixed(0) + 'm  kmh ' + g.player.kmh().toFixed(0), 16, 64);
    ctx.restore();
  };

  /* ==================================================================== *
   *  ROADSIDE PROP PAINTERS
   *  Each receives (ctx, prop, screenX, screenY, scale, game, renderer).
   *  Props are drawn with a cast shadow in the shared sun direction.
   * ==================================================================== */

  function shadowBlob(ctx, x, y, rx, ry, alpha) {
    ctx.save();
    ctx.fillStyle = 'rgba(14,32,20,' + (alpha === undefined ? 0.3 : alpha) + ')';
    ctx.beginPath();
    ctx.ellipse(x + SHADOW.x * rx * 1.1, y + SHADOW.y * ry * 1.1, rx, ry * 0.8, 0, 0, U.TAU);
    ctx.fill();
    ctx.restore();
  }

  function leafColor(p, amount) {
    return U.shade(p.color || '#3aa35c', amount);
  }

  const PROPS = {
    tree: function (ctx, p, x, y, s) {
      const r = 26 * s;
      shadowBlob(ctx, x, y, r * 1.05, r * 0.8);
      ctx.fillStyle = '#6b4a2b';
      ctx.fillRect(x - 3 * s, y - 4 * s, 6 * s, 14 * s);
      const blobs = [
        [0, -10, 1.0], [-14, 2, 0.72], [13, 1, 0.68], [2, 6, 0.6]
      ];
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];
        ctx.fillStyle = leafColor(p, i === 0 ? 0.14 : -0.1 - i * 0.04);
        ctx.beginPath();
        ctx.arc(x + b[0] * s, y + b[1] * s, r * b[2], 0, U.TAU);
        ctx.fill();
      }
      // sun-kissed top
      ctx.fillStyle = 'rgba(255,255,220,0.20)';
      ctx.beginPath();
      ctx.arc(x - r * 0.28, y - r * 0.5, r * 0.52, 0, U.TAU);
      ctx.fill();
    },

    pine: function (ctx, p, x, y, s) {
      const h = 46 * s;
      shadowBlob(ctx, x, y, 16 * s, 12 * s);
      ctx.fillStyle = '#5d4327';
      ctx.fillRect(x - 2.5 * s, y - 2 * s, 5 * s, 12 * s);
      for (let i = 0; i < 3; i++) {
        const w = (20 - i * 4.5) * s;
        const yy = y - i * h * 0.26;
        ctx.fillStyle = leafColor(p, -0.06 + i * 0.1);
        ctx.beginPath();
        ctx.moveTo(x, yy - h * 0.42);
        ctx.lineTo(x + w, yy);
        ctx.lineTo(x - w, yy);
        ctx.closePath();
        ctx.fill();
      }
    },

    palm: function (ctx, p, x, y, s) {
      shadowBlob(ctx, x, y, 20 * s, 10 * s, 0.26);
      ctx.strokeStyle = '#a3814f';
      ctx.lineWidth = 5 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y + 6 * s);
      ctx.quadraticCurveTo(x + 5 * s, y - 18 * s, x + 2 * s, y - 34 * s);
      ctx.stroke();
      const cx = x + 2 * s;
      const cy = y - 34 * s;
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * U.TAU + p.seed * 0.001;
        ctx.strokeStyle = i % 2 ? leafColor(p, 0.16) : leafColor(p, -0.1);
        ctx.lineWidth = 4.2 * s;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(
          cx + Math.cos(a) * 16 * s, cy + Math.sin(a) * 12 * s - 6 * s,
          cx + Math.cos(a) * 26 * s, cy + Math.sin(a) * 20 * s + 4 * s
        );
        ctx.stroke();
      }
      ctx.fillStyle = '#8a6a3a';
      ctx.beginPath();
      ctx.arc(cx, cy, 3.4 * s, 0, U.TAU);
      ctx.fill();
    },

    bush: function (ctx, p, x, y, s) {
      const r = 12 * s;
      shadowBlob(ctx, x, y, r, r * 0.6, 0.24);
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = leafColor(p, 0.06 - i * 0.08);
        ctx.beginPath();
        ctx.arc(x + (i - 1) * r * 0.72, y + (i % 2 ? 2 : -2) * s, r * (1 - i * 0.16), 0, U.TAU);
        ctx.fill();
      }
    },

    rock: function (ctx, p, x, y, s) {
      const r = 15 * s;
      shadowBlob(ctx, x, y, r, r * 0.6, 0.3);
      ctx.fillStyle = '#8b8f96';
      ctx.beginPath();
      const pts = 7;
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * U.TAU;
        const rr = r * (0.72 + ((U.hash(p.seed + i * 31) % 40) / 100));
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr * 0.72;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.ellipse(x - r * 0.28, y - r * 0.28, r * 0.42, r * 0.26, -0.4, 0, U.TAU);
      ctx.fill();
    },

    log: function (ctx, p, x, y, s) {
      shadowBlob(ctx, x, y, 20 * s, 7 * s, 0.26);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((p.seed % 100) / 100 * 0.9 - 0.45);
      ctx.fillStyle = '#7a5a34';
      U.roundRectPath(ctx, -20 * s, -6 * s, 40 * s, 12 * s, 6 * s);
      ctx.fill();
      ctx.fillStyle = '#a07a48';
      ctx.beginPath();
      ctx.ellipse(20 * s, 0, 4 * s, 6 * s, 0, 0, U.TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,48,26,0.7)';
      ctx.lineWidth = 1.2 * s;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(-16 * s, i * 3 * s);
        ctx.lineTo(16 * s, i * 3 * s);
        ctx.stroke();
      }
      ctx.restore();
    },

    light: function (ctx, p, x, y, s) {
      shadowBlob(ctx, x, y, 6 * s, 4 * s, 0.28);
      ctx.strokeStyle = '#9aa4ad';
      ctx.lineWidth = 3.4 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (p.off > 0 ? -10 : 10) * s, y - 34 * s);
      ctx.stroke();
      const hx = x + (p.off > 0 ? -10 : 10) * s;
      const hy = y - 34 * s;
      ctx.fillStyle = '#dfe6ee';
      U.roundRectPath(ctx, hx - 8 * s, hy - 4 * s, 16 * s, 8 * s, 3 * s);
      ctx.fill();
      ctx.fillStyle = '#fff6d0';
      ctx.beginPath();
      ctx.ellipse(hx, hy, 4.6 * s, 2.6 * s, 0, 0, U.TAU);
      ctx.fill();
    },

    sign: function (ctx, p, x, y, s) {
      shadowBlob(ctx, x, y, 10 * s, 6 * s, 0.28);
      ctx.fillStyle = '#9aa4ad';
      ctx.fillRect(x - 1.6 * s, y - 20 * s, 3.2 * s, 22 * s);
      const w = 24 * s;
      const h = 17 * s;
      ctx.save();
      ctx.translate(x, y - 20 * s - h * 0.5);
      U.roundRectPath(ctx, -w / 2, -h / 2, w, h, 3 * s);
      const colors = ['#1f7a4d', '#12325c', '#8c2f39', '#2f3a46'];
      ctx.fillStyle = colors[p.variant % colors.length];
      ctx.fill();
      ctx.strokeStyle = '#f2f5f8';
      ctx.lineWidth = 1.6 * s;
      ctx.stroke();
      ctx.fillStyle = '#f7fafc';
      ctx.fillRect(-w * 0.32, -h * 0.1, w * 0.64, h * 0.16);
      ctx.fillRect(-w * 0.32, h * 0.14, w * 0.4, h * 0.12);
      ctx.restore();
    },

    billboard: function (ctx, p, x, y, s) {
      shadowBlob(ctx, x, y, 46 * s, 12 * s, 0.3);
      const w = 96 * s;
      const h = 44 * s;
      ctx.fillStyle = '#6f7a86';
      ctx.fillRect(x - w * 0.32, y - h * 0.9, 5 * s, h * 0.9);
      ctx.fillRect(x + w * 0.28, y - h * 0.9, 5 * s, h * 0.9);
      ctx.save();
      ctx.translate(x, y - h * 1.25);
      U.roundRectPath(ctx, -w / 2, -h / 2, w, h, 4 * s);
      const bg = ['#12b0ff', '#ff5d8f', '#ffb703', '#2ec4b6'][p.variant % 4];
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = '#f4f7fa';
      ctx.lineWidth = 3 * s;
      ctx.stroke();
      // original fictional advertising
      const copy = [
        ['NOS COLA', 'drink the speed'],
        ['APEX TYRES', 'grip for days'],
        ['SUNSET DINER', 'exit 42 - open 24h'],
        ['TURBO WASH', 'shine like a winner']
      ][p.variant % 4];
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 ' + Math.round(13 * s) + 'px system-ui, sans-serif';
      ctx.fillText(copy[0], 0, -h * 0.12);
      ctx.font = '600 ' + Math.round(7.5 * s) + 'px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(copy[1], 0, h * 0.2);
      ctx.restore();
    },

    building: function (ctx, p, x, y, s) {
      const w = (46 + p.variant * 16) * s;
      const h = (60 + ((p.seed % 5) * 14)) * s;
      shadowBlob(ctx, x, y, w * 0.62, h * 0.4, 0.3);
      ctx.save();
      ctx.translate(x, y - h * 0.18);
      const roof = ['#c7ccd4', '#b6a89a', '#9fb0c0', '#cbb79c', '#a9b3ad'][p.variant % 5];
      ctx.fillStyle = roof;
      U.roundRectPath(ctx, -w / 2, -h / 2, w, h, 4 * s);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,48,58,0.55)';
      ctx.lineWidth = 2 * s;
      ctx.stroke();
      // roof furniture
      ctx.fillStyle = 'rgba(70,80,92,0.6)';
      ctx.fillRect(-w * 0.3, -h * 0.34, w * 0.26, h * 0.2);
      ctx.fillRect(w * 0.06, h * 0.06, w * 0.3, h * 0.18);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-w * 0.44, -h * 0.06, w * 0.88, 3 * s);
      // shadowed side wall hint
      ctx.fillStyle = 'rgba(30,38,48,0.35)';
      ctx.fillRect(w * 0.36, -h / 2, w * 0.14, h);
      ctx.restore();
    },

    hut: function (ctx, p, x, y, s) {
      const w = 40 * s;
      const h = 34 * s;
      shadowBlob(ctx, x, y, w * 0.55, h * 0.4, 0.28);
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = ['#e7d7b6', '#dcc7a3', '#e0cfa8'][p.variant % 3];
      U.roundRectPath(ctx, -w / 2, -h / 2, w, h, 3 * s);
      ctx.fill();
      ctx.strokeStyle = 'rgba(90,70,40,0.5)';
      ctx.lineWidth = 1.6 * s;
      ctx.stroke();
      ctx.fillStyle = '#c2603f';
      ctx.beginPath();
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(0, -h * 0.5);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(0, h * 0.5);
      ctx.closePath();
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    },

    barn: function (ctx, p, x, y, s) {
      const w = 66 * s;
      const h = 46 * s;
      shadowBlob(ctx, x, y, w * 0.6, h * 0.42, 0.3);
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = '#a63a2e';
      U.roundRectPath(ctx, -w / 2, -h / 2, w, h, 3 * s);
      ctx.fill();
      ctx.strokeStyle = '#f3ece1';
      ctx.lineWidth = 2.4 * s;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(0, h / 2);
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      ctx.stroke();
      ctx.restore();
    },

    silo: function (ctx, p, x, y, s) {
      const r = 15 * s;
      shadowBlob(ctx, x, y, r, r * 0.8, 0.3);
      ctx.fillStyle = '#c8ccd2';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, U.TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(60,66,74,0.6)';
      ctx.lineWidth = 1.6 * s;
      ctx.stroke();
      ctx.fillStyle = '#9aa0a8';
      ctx.beginPath();
      ctx.arc(x, y, r * 0.55, 0, U.TAU);
      ctx.fill();
      void p;
    },

    hay: function (ctx, p, x, y, s) {
      const r = 14 * s;
      shadowBlob(ctx, x, y, r, r * 0.66, 0.28);
      ctx.fillStyle = '#dcb35c';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, U.TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,110,45,0.75)';
      ctx.lineWidth = 1.6 * s;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(x, y, r * (i / 3.4), 0, U.TAU);
        ctx.stroke();
      }
      void p;
    },

    fence: function (ctx, p, x, y, s) {
      const len = 150 * s;
      const dir = p.off > 0 ? 1 : -1;
      ctx.save();
      ctx.strokeStyle = 'rgba(20,30,20,0.22)';
      ctx.lineWidth = 3 * s;
      ctx.beginPath();
      ctx.moveTo(x - len * 0.5 + SHADOW.x * 6, y + SHADOW.y * 6);
      ctx.lineTo(x + len * 0.5 + SHADOW.x * 6, y + SHADOW.y * 6);
      ctx.stroke();
      ctx.strokeStyle = '#8b6b45';
      ctx.lineWidth = 3 * s;
      ctx.beginPath();
      ctx.moveTo(x - len * 0.5, y);
      ctx.lineTo(x + len * 0.5, y);
      ctx.stroke();
      ctx.fillStyle = '#a3814f';
      for (let i = -2; i <= 2; i++) {
        ctx.fillRect(x + i * len * 0.25 - 1.6 * s, y - 5 * s, 3.2 * s, 10 * s);
      }
      void dir;
      ctx.restore();
    },

    cactus: function (ctx, p, x, y, s) {
      shadowBlob(ctx, x, y, 12 * s, 7 * s, 0.28);
      ctx.strokeStyle = '#4b8f4a';
      ctx.lineCap = 'round';
      ctx.lineWidth = 9 * s;
      ctx.beginPath();
      ctx.moveTo(x, y + 6 * s);
      ctx.lineTo(x, y - 24 * s);
      ctx.stroke();
      ctx.lineWidth = 6 * s;
      ctx.beginPath();
      ctx.moveTo(x, y - 8 * s);
      ctx.lineTo(x - 11 * s, y - 12 * s);
      ctx.lineTo(x - 11 * s, y - 22 * s);
      ctx.moveTo(x, y - 14 * s);
      ctx.lineTo(x + 10 * s, y - 17 * s);
      ctx.lineTo(x + 10 * s, y - 27 * s);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.moveTo(x - 2 * s, y + 2 * s);
      ctx.lineTo(x - 2 * s, y - 22 * s);
      ctx.stroke();
      void p;
    },

    mesa: function (ctx, p, x, y, s) {
      const w = 150 * s;
      const h = 70 * s;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = ['#b0603f', '#a2573a', '#c0714c'][p.variant % 3];
      ctx.beginPath();
      ctx.moveTo(x - w * 0.5, y + h * 0.2);
      ctx.lineTo(x - w * 0.32, y - h * 0.42);
      ctx.lineTo(x + w * 0.28, y - h * 0.5);
      ctx.lineTo(x + w * 0.5, y + h * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,220,180,0.25)';
      ctx.beginPath();
      ctx.moveTo(x - w * 0.32, y - h * 0.42);
      ctx.lineTo(x + w * 0.28, y - h * 0.5);
      ctx.lineTo(x + w * 0.2, y - h * 0.3);
      ctx.lineTo(x - w * 0.26, y - h * 0.24);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },

    dune: function (ctx, p, x, y, s) {
      ctx.save();
      ctx.fillStyle = 'rgba(244,226,176,0.75)';
      ctx.beginPath();
      ctx.ellipse(x, y, 130 * s, 34 * s, 0, 0, U.TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.ellipse(x - 20 * s, y - 6 * s, 80 * s, 16 * s, 0, 0, U.TAU);
      ctx.fill();
      ctx.restore();
      void p;
    },

    field: function (ctx, p, x, y, s) {
      const w = 190 * s;
      const h = 120 * s;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(((p.seed % 60) - 30) / 180);
      const base = ['#c9a227', '#a7c957', '#d9b64a', '#8fae4a'][p.variant % 4];
      ctx.fillStyle = base;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#5f4a17';
      for (let i = 0; i < 8; i++) {
        ctx.fillRect(-w / 2, -h / 2 + i * (h / 8), w, h / 22);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(70,60,25,0.4)';
      ctx.lineWidth = 2 * s;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    },

    sail: function (ctx, p, x, y, s) {
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(0, -14 * s);
      ctx.lineTo(9 * s, 6 * s);
      ctx.lineTo(-6 * s, 6 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#e6eef5';
      ctx.fillRect(-8 * s, 6 * s, 16 * s, 4 * s);
      ctx.restore();
      void p;
    },

    boardwalk: function (ctx, p, x, y, s) {
      ctx.save();
      ctx.fillStyle = '#b98d5a';
      ctx.fillRect(x - 12 * s, y - 90 * s, 24 * s, 180 * s);
      ctx.strokeStyle = 'rgba(90,64,36,0.6)';
      ctx.lineWidth = 1.4 * s;
      for (let i = -8; i <= 8; i++) {
        ctx.beginPath();
        ctx.moveTo(x - 12 * s, y + i * 11 * s);
        ctx.lineTo(x + 12 * s, y + i * 11 * s);
        ctx.stroke();
      }
      ctx.restore();
      void p;
    }
  };

  function world_time(g) {
    return g ? g.time : 0;
  }

  Racer.Camera = Camera;
  Racer.Renderer = Renderer;
  Racer.PROPS = PROPS;
})(typeof window !== 'undefined' ? window : globalThis);
