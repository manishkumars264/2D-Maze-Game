/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - particles.js
 * ----------------------------------------------------------------------------
 *  Pooled particle system for smoke, sparks, debris, dust, boost flames,
 *  shockwave rings and floating score popups.
 *
 *  Particles live in WORLD space (x, dist) so they scroll with the road and
 *  stay glued to where the action happened.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;

  function Particle() {
    this.alive = false;
    this.type = 'smoke';
    this.x = 0;
    this.dist = 0;
    this.vx = 0;
    this.vd = 0;
    this.life = 0;
    this.maxLife = 1;
    this.size = 4;
    this.growth = 0;
    this.rot = 0;
    this.vr = 0;
    this.drag = 1.2;
    this.color = '#ffffff';
    this.alpha = 1;
    this.text = '';
    this.gravity = 0;
  }

  Particle.prototype.reset = function (o) {
    this.alive = true;
    this.type = o.type || 'smoke';
    this.x = o.x || 0;
    this.dist = o.dist || 0;
    this.vx = o.vx || 0;
    this.vd = o.vd || 0;
    this.life = 0;
    this.maxLife = o.life || 0.6;
    this.size = o.size || 6;
    this.growth = o.growth === undefined ? 14 : o.growth;
    this.rot = o.rot || 0;
    this.vr = o.vr || 0;
    this.drag = o.drag === undefined ? 1.4 : o.drag;
    this.color = o.color || '#ffffff';
    this.alpha = o.alpha === undefined ? 1 : o.alpha;
    this.text = o.text || '';
    this.gravity = o.gravity || 0;
    return this;
  };

  function ParticleSystem(max) {
    this.max = max || 340;
    this.pool = [];
    this.live = [];
    for (let i = 0; i < this.max; i++) this.pool.push(new Particle());
    this._cursor = 0;
  }

  ParticleSystem.prototype.count = function () {
    return this.live.length;
  };

  ParticleSystem.prototype.clear = function () {
    for (let i = 0; i < this.live.length; i++) this.live[i].alive = false;
    this.live.length = 0;
  };

  /** Grab a free particle (recycles the oldest when saturated). */
  ParticleSystem.prototype._spawn = function () {
    for (let i = 0; i < this.pool.length; i++) {
      const idx = (this._cursor + i) % this.pool.length;
      if (!this.pool[idx].alive) {
        this._cursor = (idx + 1) % this.pool.length;
        this.live.push(this.pool[idx]);
        return this.pool[idx];
      }
    }
    // saturated: recycle oldest live particle
    const p = this.live.shift();
    this.live.push(p);
    return p;
  };

  ParticleSystem.prototype.emit = function (o) {
    if (this.live.length >= this.max && !o.force) return null;
    return this._spawn().reset(o);
  };

  /* ------------------------------------------------------------- emitters */

  /** Grey tyre smoke puff behind a wheel. */
  ParticleSystem.prototype.smoke = function (x, dist, amount) {
    const n = amount || 1;
    for (let i = 0; i < n; i++) {
      this.emit({
        type: 'smoke',
        x: x + U.rand(-7, 7),
        dist: dist + U.rand(-6, 6),
        vx: U.rand(-26, 26),
        vd: U.rand(-70, -14),
        life: U.rand(0.4, 0.85),
        size: U.rand(5, 10),
        growth: U.rand(16, 34),
        drag: 1.9,
        color: i % 3 === 0 ? '#e9edf2' : '#c3ccd6',
        alpha: U.rand(0.34, 0.6)
      });
    }
  };

  /** Dirt/grass spray when off-road. */
  ParticleSystem.prototype.dust = function (x, dist, amount) {
    const n = amount || 1;
    for (let i = 0; i < n; i++) {
      this.emit({
        type: 'dust',
        x: x + U.rand(-12, 12),
        dist: dist + U.rand(-8, 8),
        vx: U.rand(-40, 40),
        vd: U.rand(-90, -25),
        life: U.rand(0.3, 0.6),
        size: U.rand(3, 7),
        growth: U.rand(10, 22),
        drag: 2.2,
        color: U.pick(['#8a7a4f', '#a4935f', '#6f8f4a', '#c2b280']),
        alpha: U.rand(0.4, 0.75)
      });
    }
  };

  /** Bright metal sparks flying from an impact point. */
  ParticleSystem.prototype.sparks = function (x, dist, dirX, dirD, amount, tint) {
    const n = amount || 14;
    for (let i = 0; i < n; i++) {
      const a = U.rand(0, U.TAU);
      const sp = U.rand(70, 380);
      this.emit({
        type: 'spark',
        x: x,
        dist: dist,
        vx: Math.cos(a) * sp * 0.6 + dirX * 90,
        vd: Math.sin(a) * sp * 0.4 + dirD * 90,
        life: U.rand(0.18, 0.5),
        size: U.rand(1.6, 3.4),
        growth: -2,
        drag: 3.2,
        color: tint || U.pick(['#fff3b0', '#ffd166', '#ff9f1c', '#ffffff']),
        alpha: 1
      });
    }
  };

  /** Car body fragments after a wreck. */
  ParticleSystem.prototype.debris = function (x, dist, color, amount) {
    const n = amount || 16;
    for (let i = 0; i < n; i++) {
      const a = U.rand(0, U.TAU);
      const sp = U.rand(60, 330);
      this.emit({
        type: 'debris',
        x: x,
        dist: dist,
        vx: Math.cos(a) * sp * 0.7,
        vd: Math.sin(a) * sp * 0.5,
        life: U.rand(0.6, 1.4),
        size: U.rand(3, 9),
        growth: -1.5,
        rot: U.rand(0, U.TAU),
        vr: U.rand(-9, 9),
        drag: 1.5,
        color: i % 4 === 0 ? '#2b2f36' : color,
        alpha: 1
      });
    }
  };

  /** Expanding ring shockwave. */
  ParticleSystem.prototype.ring = function (x, dist, color, size, life) {
    this.emit({
      type: 'ring',
      x: x, dist: dist, vx: 0, vd: 0,
      life: life || 0.45,
      size: size || 18,
      growth: 260,
      drag: 0,
      color: color || '#ffd166',
      alpha: 0.9,
      force: true
    });
  };

  /** Boost flame from the exhaust. */
  ParticleSystem.prototype.flame = function (x, dist, boostPower) {
    this.emit({
      type: 'flame',
      x: x + U.rand(-4, 4),
      dist: dist + U.rand(-4, 2),
      vx: U.rand(-24, 24),
      vd: U.rand(-160, -90) * (0.6 + boostPower * 0.6),
      life: U.rand(0.14, 0.3),
      size: U.rand(4, 8),
      growth: -8,
      drag: 2.4,
      color: U.pick(['#7ad7ff', '#ffffff', '#9be7ff', '#4fc3f7']),
      alpha: U.rand(0.5, 0.9)
    });
  };

  /** Floating score/combo text. */
  ParticleSystem.prototype.popup = function (x, dist, text, color, size) {
    this.emit({
      type: 'text',
      x: x, dist: dist,
      vx: 0, vd: 78,
      life: 1.1,
      size: size || 18,
      growth: 0,
      drag: 0.9,
      color: color || '#ffffff',
      alpha: 1,
      text: text,
      force: true
    });
  };

  /* ---------------------------------------------------------------- update */

  ParticleSystem.prototype.update = function (dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        this.live.splice(i, 1);
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vd *= d;
      p.x += p.vx * dt;
      p.dist += p.vd * dt;
      p.vd += p.gravity * dt;
      p.rot += p.vr * dt;
      p.size += p.growth * dt;
      if (p.size < 0.4) p.size = 0.4;
    }
  };

  /* ---------------------------------------------------------------- render */

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} cam  camera with toScreenX(worldX) / toScreenY(dist) / zoom
   */
  ParticleSystem.prototype.render = function (ctx, cam) {
    const zoom = cam.zoom;
    ctx.save();
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      const t = p.life / p.maxLife;
      const fade = p.type === 'text' ? (t < 0.15 ? t / 0.15 : 1 - U.smoothstep((t - 0.15) / 0.85))
                                     : 1 - t * t;
      const sx = cam.toScreenX(p.x);
      const sy = cam.toScreenY(p.dist);
      if (sx < -80 || sx > cam.viewWidth + 80 || sy < -120 || sy > cam.viewHeight + 120) continue;
      const size = p.size * zoom;
      ctx.globalAlpha = U.clamp(p.alpha * fade, 0, 1);

      switch (p.type) {
        case 'smoke':
        case 'dust':
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(sx, sy, size, 0, U.TAU);
          ctx.fill();
          break;

        case 'flame':
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.ellipse(sx, sy, size * 0.62, size * 1.5, 0, 0, U.TAU);
          ctx.fill();
          break;

        case 'spark': {
          const len = Math.min(20, Math.hypot(p.vx, p.vd) * 0.045) * zoom;
          const ang = Math.atan2(-p.vd, p.vx);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, size * 0.8);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
          ctx.stroke();
          break;
        }

        case 'debris':
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-size * 0.5, -size * 0.35, size, size * 0.7);
          ctx.restore();
          break;

        case 'ring':
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1.5, 7 * zoom * (1 - t));
          ctx.beginPath();
          ctx.arc(sx, sy, size * zoom, 0, U.TAU);
          ctx.stroke();
          break;

        case 'text':
          ctx.font = '900 ' + Math.round(size * zoom) + 'px "Segoe UI", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 4 * zoom;
          ctx.strokeStyle = 'rgba(10,14,22,0.75)';
          ctx.strokeText(p.text, sx, sy);
          ctx.fillStyle = p.color;
          ctx.fillText(p.text, sx, sy);
          break;

        default:
          break;
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  };

  Racer.ParticleSystem = ParticleSystem;
})(typeof window !== 'undefined' ? window : globalThis);
