/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - vehicles.js
 * ----------------------------------------------------------------------------
 *  Original, fully procedural top-down vehicle art drawn with canvas paths.
 *  No images, no external assets - every silhouette, livery and highlight is
 *  generated here so the game ships as pure source.
 *
 *  drawCar() is shared by the player and all traffic, driven by a small
 *  "spec" per archetype (nose taper, cabin position, spoiler, wheels...).
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;
  const CFG = Racer.CONFIG;
  const SHADOW = CFG.FX.SHADOW_DIR;

  /* ------------------------------------------------------------------ liveries */

  /** Original paint schemes: body / secondary / accent / glass. */
  const PALETTES = [
    { name: 'Inferno',   body: '#e63946', second: '#8d1d26', accent: '#ffd166', glass: '#22303f' },
    { name: 'Solar',     body: '#ffb703', second: '#a06a00', accent: '#ffffff', glass: '#2b2f36' },
    { name: 'Lagoon',    body: '#2ec4b6', second: '#137a70', accent: '#f7fff7', glass: '#1d3038' },
    { name: 'Cobalt',    body: '#3a86ff', second: '#1b4a94', accent: '#e0f0ff', glass: '#1b2836' },
    { name: 'Violet',    body: '#8338ec', second: '#4a1d8a', accent: '#ffbe0b', glass: '#241b36' },
    { name: 'Rose',      body: '#ff5d8f', second: '#a02a52', accent: '#fff0f5', glass: '#33202a' },
    { name: 'Slate',     body: '#6c7a89', second: '#3b4552', accent: '#dfe6ee', glass: '#22282f' },
    { name: 'Graphite',  body: '#343a40', second: '#1b1f23', accent: '#adb5bd', glass: '#14181c' },
    { name: 'Lime',      body: '#a7c957', second: '#5f7a2c', accent: '#ffffff', glass: '#25301a' },
    { name: 'Pearl',     body: '#f1faee', second: '#c2cfc2', accent: '#e63946', glass: '#2c3947' },
    { name: 'Tangerine', body: '#fb8500', second: '#9c4f00', accent: '#264653', glass: '#2b2118' },
    { name: 'Mint',      body: '#90e0ef', second: '#4a9fb5', accent: '#03045e', glass: '#1e3a44' },
    { name: 'Plum',      body: '#7b2cbf', second: '#431473', accent: '#ffd6ff', glass: '#251236' },
    { name: 'Sand',      body: '#e9c46a', second: '#a98331', accent: '#264653', glass: '#33291a' },
    { name: 'Forest',    body: '#2d6a4f', second: '#143d2b', accent: '#d8f3dc', glass: '#16281f' }
  ];

  /** The player's signature hero livery (distinct from traffic). */
  const HERO_PALETTE = {
    name: 'Apex',
    body: '#12b0ff',
    second: '#0a5f92',
    accent: '#ffffff',
    glass: '#16222e',
    stripe: '#ff2e63'
  };

  /* ------------------------------------------------------------------- specs */

  /**
   * Silhouette parameters per archetype:
   *   nose   : front width ratio (smaller = pointier)
   *   tail   : rear width ratio
   *   cabin  : [start, end] along the length, in -1..1 (front = -1)
   *   cabinW : cabin width ratio
   *   spoiler: 0 none / 1 lip / 2 wing
   *   wheels : wheel inset & size multipliers
   */
  const SPECS = {
    hatch:  { nose: 0.86, tail: 0.94, cabin: [-0.34, 0.44], cabinW: 0.86, spoiler: 1, hood: 0.0,  wheelW: 0.20, wheelL: 0.20 },
    sedan:  { nose: 0.78, tail: 0.90, cabin: [-0.26, 0.40], cabinW: 0.84, spoiler: 1, hood: 0.0,  wheelW: 0.20, wheelL: 0.22 },
    sports: { nose: 0.62, tail: 0.96, cabin: [-0.16, 0.32], cabinW: 0.80, spoiler: 2, hood: 0.16, wheelW: 0.22, wheelL: 0.20 },
    muscle: { nose: 0.74, tail: 0.98, cabin: [-0.12, 0.34], cabinW: 0.82, spoiler: 2, hood: 0.30, wheelW: 0.23, wheelL: 0.22 },
    van:    { nose: 0.92, tail: 0.98, cabin: [-0.62, 0.62], cabinW: 0.92, spoiler: 0, hood: 0.0,  wheelW: 0.19, wheelL: 0.18 },
    truck:  { nose: 0.90, tail: 1.00, cabin: [-0.72, -0.22], cabinW: 0.92, spoiler: 0, hood: 0.0, wheelW: 0.20, wheelL: 0.16, trailer: true },
    player: { nose: 0.66, tail: 0.97, cabin: [-0.20, 0.30], cabinW: 0.82, spoiler: 2, hood: 0.26, wheelW: 0.22, wheelL: 0.21 }
  };

  /* -------------------------------------------------------------- body path */

  function bodyPath(ctx, hw, hl, spec) {
    const nose = spec.nose;
    const tail = spec.tail;
    ctx.beginPath();
    ctx.moveTo(0, -hl);
    ctx.bezierCurveTo(hw * nose * 0.55, -hl, hw * nose, -hl * 0.86, hw * nose * 0.99, -hl * 0.6);
    ctx.bezierCurveTo(hw * 0.995, -hl * 0.3, hw, -hl * 0.05, hw, hl * 0.3);
    ctx.bezierCurveTo(hw, hl * 0.72, hw * tail, hl * 0.94, hw * tail * 0.86, hl);
    ctx.lineTo(-hw * tail * 0.86, hl);
    ctx.bezierCurveTo(-hw * tail, hl * 0.94, -hw, hl * 0.72, -hw, hl * 0.3);
    ctx.bezierCurveTo(-hw, -hl * 0.05, -hw * 0.995, -hl * 0.3, -hw * nose * 0.99, -hl * 0.6);
    ctx.bezierCurveTo(-hw * nose, -hl * 0.86, -hw * nose * 0.55, -hl, 0, -hl);
    ctx.closePath();
  }

  function glassPath(ctx, hw, hl, spec, shrink) {
    const s = shrink === undefined ? 1 : shrink;
    const y0 = hl * spec.cabin[0];
    const y1 = hl * spec.cabin[1];
    const w = hw * spec.cabinW * s;
    ctx.beginPath();
    ctx.moveTo(-w * 0.72, y0);
    ctx.lineTo(w * 0.72, y0);
    ctx.bezierCurveTo(w, y0 + (y1 - y0) * 0.22, w, y1 - (y1 - y0) * 0.25, w * 0.82, y1);
    ctx.lineTo(-w * 0.82, y1);
    ctx.bezierCurveTo(-w, y1 - (y1 - y0) * 0.25, -w, y0 + (y1 - y0) * 0.22, -w * 0.72, y0);
    ctx.closePath();
  }

  /* ------------------------------------------------------------------- wheels */

  function drawWheels(ctx, hw, hl, spec, steer, palette) {
    const ww = hw * 2 * spec.wheelW;
    const wl = hl * 2 * spec.wheelL;
    const positions = [
      { x: -hw - ww * 0.28, y: -hl * 0.56, steer: true },
      { x: hw + ww * 0.28, y: -hl * 0.56, steer: true },
      { x: -hw - ww * 0.28, y: hl * 0.58, steer: false },
      { x: hw + ww * 0.28, y: hl * 0.58, steer: false }
    ];
    ctx.fillStyle = '#15171b';
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.steer && steer) ctx.rotate(steer);
      U.roundRectPath(ctx, -ww / 2, -wl / 2, ww, wl, ww * 0.32);
      ctx.fill();
      // hub glint
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(-ww * 0.18, -wl * 0.3, ww * 0.36, wl * 0.6);
      ctx.fillStyle = '#15171b';
      ctx.restore();
    }
    // dark wheel arch shadow under the body
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(-hw * 1.02, -hl * 0.7, hw * 0.12, hl * 0.34);
    ctx.fillRect(hw * 0.9, -hl * 0.7, hw * 0.12, hl * 0.34);
    ctx.fillRect(-hw * 1.02, hl * 0.42, hw * 0.12, hl * 0.34);
    ctx.fillRect(hw * 0.9, hl * 0.42, hw * 0.12, hl * 0.34);
    void palette;
  }

  /* ----------------------------------------------------------------- drawCar */

  /**
   * Draw a top-down car centred on (0,0) in local space - the caller applies
   * translate/rotate/scale.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} o
   *   w, l          : footprint in world px
   *   shape         : key into SPECS
   *   palette       : { body, second, accent, glass, stripe? }
   *   angle         : body yaw (radians)
   *   steer         : front wheel angle (radians)
   *   braking       : 0..1 taillight intensity
   *   lights        : draw headlight beams
   *   hero          : player-only extras (livery, glow, boost)
   *   boost         : 0..1 boost intensity
   *   invuln        : 0..1 flicker for post-hit invulnerability
   *   shadow        : draw cast shadow (default true)
   *   speedNorm     : 0..1 used for motion streaks
   */
  function drawCar(ctx, o) {
    const spec = SPECS[o.shape] || SPECS.sedan;
    const w = o.w;
    const l = o.l;
    const hw = w / 2;
    const hl = l / 2;
    const pal = o.palette || PALETTES[0];
    const angle = o.angle || 0;
    const drawShadow = o.shadow !== false;

    ctx.save();
    if (angle) ctx.rotate(angle);

    /* ---- cast shadow (sun direction from config) ---- */
    if (drawShadow) {
      ctx.save();
      ctx.translate(SHADOW.x * hl * 0.5, SHADOW.y * hl * 0.5);
      ctx.fillStyle = 'rgba(12,20,16,0.34)';
      bodyPath(ctx, hw * 1.06, hl * 1.04, spec);
      ctx.fill();
      ctx.restore();
    }

    /* ---- wheels first so the body overlaps them ---- */
    drawWheels(ctx, hw, hl, spec, o.steer || 0, pal);

    /* ---- trailer for trucks ---- */
    if (spec.trailer) {
      const tw = hw * 1.02;
      ctx.fillStyle = pal.second;
      U.roundRectPath(ctx, -tw, -hl * 0.16, tw * 2, hl * 1.12, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(-tw, -hl * 0.1, tw * 2, 3);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(-tw, -hl * 0.16, tw * 2, hl * 1.12);
    }

    /* ---- body ---- */
    bodyPath(ctx, hw, hl, spec);
    const grad = ctx.createLinearGradient(-hw, 0, hw, 0);
    grad.addColorStop(0, U.shade(pal.body, -0.42));
    grad.addColorStop(0.18, U.shade(pal.body, -0.08));
    grad.addColorStop(0.44, U.shade(pal.body, 0.34));
    grad.addColorStop(0.62, pal.body);
    grad.addColorStop(1, U.shade(pal.body, -0.5));
    ctx.fillStyle = grad;
    ctx.fill();

    // panel outline
    ctx.strokeStyle = 'rgba(8,12,18,0.55)';
    ctx.lineWidth = Math.max(1, hw * 0.055);
    ctx.stroke();

    // clip everything else to the body silhouette
    ctx.save();
    bodyPath(ctx, hw, hl, spec);
    ctx.clip();

    /* hood scoop / bonnet lines */
    if (spec.hood > 0) {
      ctx.fillStyle = U.shade(pal.second, -0.1);
      const sw = hw * 0.42;
      U.roundRectPath(ctx, -sw / 2, -hl * 0.82, sw, hl * spec.hood * 1.5, 3);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      U.roundRectPath(ctx, -sw * 0.3, -hl * 0.8, sw * 0.6, hl * spec.hood * 0.5, 2);
      ctx.fill();
    }

    /* hero livery: twin stripes + side slashes */
    if (o.hero) {
      ctx.fillStyle = pal.stripe || '#ff2e63';
      const sw = hw * 0.19;
      ctx.fillRect(-sw * 1.35, -hl, sw, hl * 2);
      ctx.fillRect(sw * 0.35, -hl, sw, hl * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(-sw * 1.35, -hl, sw * 0.22, hl * 2);
      ctx.fillRect(sw * 0.35, -hl, sw * 0.22, hl * 2);
      // number roundel
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(0, hl * 0.55, hw * 0.34, 0, U.TAU);
      ctx.fill();
      ctx.fillStyle = pal.stripe || '#ff2e63';
      ctx.font = '900 ' + Math.round(hw * 0.44) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('7', 0, hl * 0.57);
    } else {
      // simple accent stripe for traffic variety
      if (pal.accent && o.shape !== 'truck') {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = pal.accent;
        ctx.fillRect(-hw * 0.1, -hl, hw * 0.2, hl * 2);
        ctx.globalAlpha = 1;
      }
    }

    /* glossy top highlight */
    const gloss = ctx.createLinearGradient(0, -hl, 0, hl * 0.2);
    gloss.addColorStop(0, 'rgba(255,255,255,0.30)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss;
    ctx.fillRect(-hw, -hl, hw * 2, hl * 1.2);

    ctx.restore(); // end body clip

    /* ---- glass / cabin ---- */
    glassPath(ctx, hw, hl, spec, 0.94);
    const gGrad = ctx.createLinearGradient(0, hl * spec.cabin[0], 0, hl * spec.cabin[1]);
    gGrad.addColorStop(0, U.shade(pal.glass, 0.28));
    gGrad.addColorStop(0.45, pal.glass);
    gGrad.addColorStop(1, U.shade(pal.glass, -0.3));
    ctx.fillStyle = gGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // windshield reflection slash
    ctx.save();
    glassPath(ctx, hw, hl, spec, 0.9);
    ctx.clip();
    ctx.fillStyle = 'rgba(190,225,255,0.20)';
    ctx.beginPath();
    const wy = hl * spec.cabin[0];
    ctx.moveTo(-hw, wy + hl * 0.1);
    ctx.lineTo(hw * 0.2, wy - hl * 0.05);
    ctx.lineTo(hw * 0.6, wy - hl * 0.05);
    ctx.lineTo(-hw * 0.2, wy + hl * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // roof panel between the glass
    if (!spec.trailer) {
      ctx.fillStyle = U.shade(pal.body, -0.16);
      const ry0 = hl * (spec.cabin[0] + 0.16);
      const ry1 = hl * (spec.cabin[1] - 0.2);
      const rw = hw * spec.cabinW * 0.72;
      if (ry1 > ry0) {
        U.roundRectPath(ctx, -rw / 2, ry0, rw, ry1 - ry0, 3);
        ctx.fill();
      }
    }

    /* ---- spoiler ---- */
    if (spec.spoiler === 2) {
      ctx.fillStyle = U.shade(pal.second, -0.2);
      U.roundRectPath(ctx, -hw * 0.94, hl * 0.86, hw * 1.88, hl * 0.2, 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(-hw * 0.72, hl * 0.78, hw * 0.16, hl * 0.12);
      ctx.fillRect(hw * 0.56, hl * 0.78, hw * 0.16, hl * 0.12);
    } else if (spec.spoiler === 1) {
      ctx.fillStyle = U.shade(pal.second, -0.15);
      U.roundRectPath(ctx, -hw * 0.8, hl * 0.9, hw * 1.6, hl * 0.1, 2);
      ctx.fill();
    }

    /* ---- mirrors ---- */
    ctx.fillStyle = U.shade(pal.body, -0.25);
    const my = hl * spec.cabin[0] + hl * 0.06;
    ctx.fillRect(-hw * 1.14, my, hw * 0.18, hl * 0.1);
    ctx.fillRect(hw * 0.96, my, hw * 0.18, hl * 0.1);

    /* ---- headlights ---- */
    const lampY = -hl * 0.9;
    ctx.fillStyle = o.lights ? '#fff8dc' : '#dfe6ee';
    U.roundRectPath(ctx, -hw * 0.74, lampY, hw * 0.36, hl * 0.12, 2);
    ctx.fill();
    U.roundRectPath(ctx, hw * 0.38, lampY, hw * 0.36, hl * 0.12, 2);
    ctx.fill();
    if (o.lights) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const beam = ctx.createLinearGradient(0, lampY, 0, lampY - hl * 1.5);
      beam.addColorStop(0, 'rgba(255,244,200,0.35)');
      beam.addColorStop(1, 'rgba(255,244,200,0)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(-hw * 0.78, lampY);
      ctx.lineTo(hw * 0.78, lampY);
      ctx.lineTo(hw * 1.5, lampY - hl * 1.6);
      ctx.lineTo(-hw * 1.5, lampY - hl * 1.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    /* ---- taillights ---- */
    const brake = o.braking || 0;
    const tlY = hl * 0.88;
    ctx.fillStyle = brake > 0.05 ? '#ff3b3b' : '#a4262c';
    U.roundRectPath(ctx, -hw * 0.8, tlY, hw * 0.42, hl * 0.12, 2);
    ctx.fill();
    U.roundRectPath(ctx, hw * 0.38, tlY, hw * 0.42, hl * 0.12, 2);
    ctx.fill();
    if (brake > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,40,40,' + (0.22 + brake * 0.4).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(-hw * 0.6, tlY + hl * 0.06, hw * 0.5, hl * 0.28, 0, 0, U.TAU);
      ctx.ellipse(hw * 0.6, tlY + hl * 0.06, hw * 0.5, hl * 0.28, 0, 0, U.TAU);
      ctx.fill();
      ctx.restore();
    }

    /* ---- boost glow ---- */
    if (o.boost > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const b = o.boost;
      const flameLen = hl * (0.6 + b * 1.5);
      for (let s = -1; s <= 1; s += 2) {
        const fx = s * hw * 0.45;
        const fg = ctx.createLinearGradient(fx, hl, fx, hl + flameLen);
        fg.addColorStop(0, 'rgba(180,240,255,' + (0.85 * b).toFixed(3) + ')');
        fg.addColorStop(0.35, 'rgba(80,180,255,' + (0.5 * b).toFixed(3) + ')');
        fg.addColorStop(1, 'rgba(30,90,255,0)');
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.moveTo(fx - hw * 0.22, hl * 0.98);
        ctx.lineTo(fx + hw * 0.22, hl * 0.98);
        ctx.lineTo(fx + hw * 0.08, hl + flameLen);
        ctx.lineTo(fx - hw * 0.08, hl + flameLen);
        ctx.closePath();
        ctx.fill();
      }
      // underglow
      ctx.fillStyle = 'rgba(90,190,255,' + (0.16 * b).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(0, 0, hw * 1.5, hl * 1.25, 0, 0, U.TAU);
      ctx.fill();
      ctx.restore();
    }

    /* ---- invulnerability flicker ---- */
    if (o.invuln > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(120,220,255,' + (0.35 + 0.5 * Math.abs(Math.sin(o.invuln * 22))).toFixed(3) + ')';
      ctx.lineWidth = 2.4;
      bodyPath(ctx, hw * 1.1, hl * 1.08, spec);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore(); // end car transform
  }

  Racer.Vehicles = {
    PALETTES: PALETTES,
    HERO_PALETTE: HERO_PALETTE,
    SPECS: SPECS,
    drawCar: drawCar,
    bodyPath: bodyPath,

    randomPalette: function () {
      return PALETTES[Math.floor(Math.random() * PALETTES.length)];
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
