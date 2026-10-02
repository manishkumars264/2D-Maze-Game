/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - collision.js
 * ----------------------------------------------------------------------------
 *  Collision detection and "near miss" (risk bonus) detection.
 *
 *  Broad phase: only traffic inside a distance band around the player is
 *  tested. Narrow phase: axis-aligned boxes with a small inset so glancing
 *  contact reads as a near miss instead of a crash (arcade forgiveness).
 *
 *  Every hit is analysed into a severity (closing speed + impact face) which
 *  game.js turns into particles, screen shake, audio and shield loss.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;
  const CFG = Racer.CONFIG;
  const SC = CFG.SCORING;

  const Collision = {};

  /** Box inset (px). Keeps collisions honest but not pixel-punishing. */
  const HIT_INSET = 4;
  const NEAR_INSET = 1;

  /**
   * Test the player against nearby traffic.
   *
   * @param {PlayerCar} player
   * @param {TrafficManager} traffic
   * @param {number} [dt] simulation step (used by the invulnerable push-apart)
   * @returns {{hits: Array, nearMisses: Array}}
   */
  Collision.scan = function (player, traffic, dt) {
    const hits = [];
    const nearMisses = [];
    const pb = player.bbox();
    const candidates = traffic.near(player.dist, 620, 420);
    const step = dt || 1 / 60;

    for (let i = 0; i < candidates.length; i++) {
      const car = candidates[i];

      /* ------------------------- narrow phase ------------------------- */
      const hit = U.aabb(pb, car, HIT_INSET, HIT_INSET);
      if (hit) {
        if (player.invuln > 0) {
          // invulnerable: shove the traffic car aside so we don't stick to it
          Collision.separate(player, car, step);
          continue;
        }
        hits.push(Collision.analyse(player, car));
        continue;
      }

      /* ------------------------ near-miss tracking -------------------- */
      const dDist = car.dist - player.dist;
      const longWindow = player.hl + car.hl + SC.NEAR_MISS_LENGTH;

      if (Math.abs(dDist) < longWindow) {
        const clearance = Math.abs(player.x - car.x) - (player.hw + car.hw) + NEAR_INSET;
        if (car._minClear === undefined || clearance < car._minClear) {
          car._minClear = clearance;
        }
      } else if (dDist <= -longWindow) {
        // fully passed: score it once if it was genuinely close
        if (!car.nearMissScored && car._minClear !== undefined && car._minClear < SC.NEAR_MISS_WINDOW) {
          car.nearMissScored = true;
          nearMisses.push({ car: car, clearance: Math.max(0, car._minClear) });
        }
        if (dDist < -longWindow - 200) car._minClear = undefined;
      }
    }

    return { hits: hits, nearMisses: nearMisses };
  };

  /**
   * Classify an impact: which face was hit, closing speed and severity.
   * Severity drives shake, particles, sound and whether a shield is lost.
   */
  Collision.analyse = function (player, car) {
    const rel = player.speed - car.speed;              // +ve = we hit them
    const overlapX = (player.hw + car.hw) - Math.abs(player.x - car.x);
    const overlapD = (player.hl + car.hl) - Math.abs(player.dist - car.dist);

    let face;
    if (overlapX < overlapD) {
      face = player.x < car.x ? 'left' : 'right';
    } else {
      face = player.dist < car.dist ? 'front' : 'rear';
    }

    const speedFactor = U.clamp(Math.abs(rel) / 300, 0, 1);
    let severity = 0.35 + speedFactor * 0.65;
    if (face === 'front') severity += 0.22;             // rear-ending traffic hurts
    if (face === 'rear' && rel < 0) severity += 0.12;   // being rear-ended
    if (car.typeKey === 'truck' || car.typeKey === 'van') severity += 0.1;
    severity = U.clamp(severity, 0, 1.4);

    // contact point in world space for particle emission
    const cx = U.clamp(player.x, car.x - car.hw, car.x + car.hw);
    const cd = U.clamp(player.dist, car.dist - car.hl, car.dist + car.hl);

    return {
      car: car,
      face: face,
      severity: severity,
      relSpeed: rel,
      contactX: (cx + player.x) * 0.5,
      contactDist: (cd + player.dist) * 0.5,
      sideSign: Math.sign(player.x - car.x) || 1
    };
  };

  /**
   * Push an overlapping pair apart (used while invulnerable so the player
   * slides off the traffic car instead of grinding through it).
   */
  Collision.separate = function (player, car, dt) {
    const step = dt || 1 / 60;
    const dx = player.x - car.x;
    const dd = player.dist - car.dist;
    const overlapX = (player.hw + car.hw) - Math.abs(dx);
    const overlapD = (player.hl + car.hl) - Math.abs(dd);
    if (overlapX < overlapD) {
      const s = Math.sign(dx) || 1;
      player.x += s * overlapX * 0.55;
      car.x -= s * overlapX * 0.45;
      player.lateralVel = s * 120;
    } else {
      const s = Math.sign(dd) || 1;
      player.dist += s * overlapD * 0.35;
      car.dist -= s * overlapD * 0.65;
    }
    // grinding along a car while invulnerable scrubs off speed (time-based so
    // the penalty is identical at 30, 60 or 144 fps)
    player.speed *= Math.exp(-1.6 * step);
  };

  Racer.Collision = Collision;
})(typeof window !== 'undefined' ? window : globalThis);
