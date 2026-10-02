/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - player.js
 * ----------------------------------------------------------------------------
 *  The player car: arcade physics only (no tyre model, no simulation).
 *
 *    - throttle / brake / reverse with drag and engine braking
 *    - speed-sensitive steering (slow = sluggish, very fast = heavier)
 *    - NOS boost with a drain/refill tank
 *    - grass (off-road) penalty, barrier impacts
 *    - shields ("lives"), post-hit invulnerability and spin-out
 *
 *  The car stores its position as (x = world lateral, dist = distance driven).
 *  The road centreline moves underneath it, which is what makes the curves
 *  demand actual steering input.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;
  const CFG = Racer.CONFIG;
  const DIFFS = Racer.DIFFICULTIES;

  function PlayerCar() {
    this.w = CFG.PLAYER.WIDTH;
    this.l = CFG.PLAYER.LENGTH;
    this.hw = this.w / 2;
    this.hl = this.l / 2;
    this.palette = Racer.Vehicles.HERO_PALETTE;
    this.shape = 'player';

    this.diff = DIFFS.medium;
    this.reset(DIFFS.medium);
  }

  /** Full state reset - used at race start and on restart. */
  PlayerCar.prototype.reset = function (difficulty) {
    const P = CFG.PLAYER;
    this.diff = difficulty || DIFFS.medium;

    this.dist = 0;
    this.x = 0;                     // starts on the road centre
    this.speed = 0;
    this.steer = 0;                 // smoothed -1..1
    this.steerTarget = 0;
    this.yaw = 0;
    this.lateralVel = 0;
    this.braking = 0;               // 0..1 for taillights
    this.slip = 0;                  // 0..1 tyre slip (audio + smoke)

    this.boostFuel = P.BOOST_MAX;
    this.boosting = false;
    this.boostPower = 0;            // smoothed 0..1 for visuals

    this.shields = this.diff.shields;
    this.invuln = 0;
    this.spin = 0;

    this.offRoad = false;
    this.offRoadAmount = 0;
    this.onGrass = 0;               // smoothed 0..1

    this.topSpeed = 0;
    this.distanceMeters = 0;
    this.airTime = 0;

    this.lastEvents = { barrier: false, boostStart: false, crash: false, grassStart: false };
    return this;
  };

  /* ------------------------------------------------------------------ helpers */

  PlayerCar.prototype.kmh = function () {
    return Math.abs(this.speed) * CFG.UNITS.PX_TO_KMH;
  };

  PlayerCar.prototype.meters = function () {
    return Math.max(0, this.dist) * CFG.UNITS.PX_TO_METERS;
  };

  PlayerCar.prototype.speedNorm = function () {
    return U.clamp(this.speed / CFG.PLAYER.MAX_SPEED, 0, 1.35);
  };

  /** Collision box consumed by collision.js. */
  PlayerCar.prototype.bbox = function () {
    return { x: this.x, dist: this.dist, hw: this.hw, hl: this.hl };
  };

  /** Take a hit: consume a shield if available. Returns true if destroyed. */
  PlayerCar.prototype.damage = function (severity) {
    if (this.invuln > 0) return false;
    this.shields -= 1;
    this.spin = CFG.PLAYER.SPIN_TIME * (severity > 0.7 ? 1.25 : 0.8);
    this.invuln = CFG.PLAYER.INVULN_TIME;
    this.boosting = false;
    this.boostPower = 0;
    if (this.shields <= 0) {
      this.shields = 0;
      this.lastEvents.crash = true;
      return true;
    }
    return false;
  };

  /* ------------------------------------------------------------------ update */

  /**
   * @param {number} dt         seconds (already scaled by time-scale)
   * @param {object} input      InputManager
   * @param {World}  world      road geometry provider
   */
  PlayerCar.prototype.update = function (dt, input, world) {
    const P = CFG.PLAYER;
    const ev = this.lastEvents;
    ev.barrier = false;
    ev.boostStart = false;
    ev.crash = false;
    ev.grassStart = false;

    const handling = this.diff.handling;

    /* ---- timers ---- */
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
    if (this.spin > 0) this.spin = Math.max(0, this.spin - dt);
    const control = this.spin > 0 ? 0.3 : 1;   // reduced authority while spinning

    /* ---- off-road state ---- */
    const off = world.offRoadAmount(this.dist, this.x);
    const wasOff = this.offRoad;
    this.offRoad = off > 0.5;
    this.offRoadAmount = off;
    if (this.offRoad && !wasOff) ev.grassStart = true;
    this.onGrass = U.damp(this.onGrass, this.offRoad ? U.clamp(off / 90, 0.35, 1) : 0, 8, dt);

    /* ---- boost ---- */
    const wantsBoost = input.boostHeld() && this.boostFuel > P.BOOST_MIN_USE && this.speed > 25;
    if (wantsBoost && !this.boosting) ev.boostStart = true;
    this.boosting = wantsBoost;
    if (this.boosting) {
      this.boostFuel = Math.max(0, this.boostFuel - P.BOOST_DRAIN * dt);
      if (this.boostFuel <= 0) this.boosting = false;
    } else {
      this.boostFuel = Math.min(P.BOOST_MAX, this.boostFuel + P.BOOST_REGEN * dt);
    }
    this.boostPower = U.damp(this.boostPower, this.boosting ? 1 : 0, 7, dt);

    /* ---- longitudinal physics ---- */
    const grassCap = this.offRoad
      ? P.MAX_SPEED * P.OFFROAD_SPEED_FACTOR * (handling.offroadGrace || 1)
      : Infinity;
    const targetMax = Math.min(
      (this.boosting ? P.BOOST_MAX_SPEED : P.MAX_SPEED),
      grassCap
    );

    const throttle = input.throttle();
    const brake = input.brake();

    if (throttle > 0) {
      if (this.speed < 0) {
        // pressing gas while reversing brings us back through neutral
        this.speed += P.BRAKE * 0.8 * dt;
      } else {
        const accel = (this.boosting ? P.BOOST_ACCEL : P.ACCEL) * (handling.accelBonus || 1);
        // pull drops off quadratically so the car settles just under MAX_SPEED
        const falloff = 1 - Math.pow(U.clamp(this.speed / targetMax, 0, 1), 2);
        this.speed += accel * Math.max(0, falloff) * dt;
      }
    } else if (brake > 0) {
      if (this.speed > P.STOP_THRESHOLD) {
        this.speed -= P.BRAKE * dt;
      } else {
        this.speed -= P.REVERSE_ACCEL * dt;
        if (this.speed < P.MAX_REVERSE) this.speed = P.MAX_REVERSE;
      }
    } else {
      this.speed = U.approach(this.speed, 0, P.ENGINE_BRAKE * dt);
    }

    // aerodynamic drag + rolling resistance
    this.speed -= P.DRAG * this.speed * Math.abs(this.speed) * dt;

    // grass scrub
    if (this.offRoad && this.speed > 0) {
      this.speed -= P.OFFROAD_DRAG * this.speed * this.onGrass * dt;
      if (this.speed > grassCap) {
        this.speed = U.approach(this.speed, grassCap, 260 * dt);
      }
    }

    this.speed = U.clamp(this.speed, P.MAX_REVERSE, P.BOOST_MAX_SPEED * 1.05);
    if (Math.abs(this.speed) < P.STOP_THRESHOLD && !throttle && !brake) this.speed = 0;

    /* ---- steering ---- */
    this.steerTarget = input.steerAxis() * control;
    // a spin-out kicks the wheel around a little for drama
    if (this.spin > 0) {
      this.steerTarget += Math.sin(this.spin * 22) * 0.5 * U.clamp(this.spin, 0, 1);
    }
    this.steer = U.damp(this.steer, this.steerTarget, P.STEER_SMOOTH, dt);

    const speedAbs = Math.abs(this.speed);
    const grip = U.clamp(speedAbs / P.STEER_GRIP_REF, 0, 1);
    const speedNorm = U.clamp(speedAbs / P.MAX_SPEED, 0, 1.4);
    const highSpeedFalloff = 1 - P.STEER_HSFALLOFF * Math.pow(U.clamp(speedNorm, 0, 1), 2);
    const grassGrip = this.offRoad ? U.lerp(1, P.OFFROAD_GRIP, this.onGrass) : 1;
    const direction = this.speed < 0 ? -1 : 1;

    const lateral =
      this.steer * P.STEER_RATE * grip * highSpeedFalloff * grassGrip *
      (handling.gripBonus || 1) * direction;

    this.lateralVel = lateral;
    this.x += lateral * dt;

    // visual body yaw (plus a slide angle when spinning)
    const targetYaw = this.steer * P.MAX_YAW * grip + (this.spin > 0 ? this.spin * 1.6 : 0);
    this.yaw = U.damp(this.yaw, targetYaw, 10, dt);

    /* ---- forward motion ---- */
    this.dist += this.speed * dt;
    if (this.dist < 0) this.dist = 0;
    this.distanceMeters = this.dist * CFG.UNITS.PX_TO_METERS;
    if (this.kmh() > this.topSpeed) this.topSpeed = this.kmh();

    /* ---- barrier clamp ---- */
    const center = world.centerXAt(this.dist);
    const rel = this.x - center;
    const limit = world.barrierHalf - this.hw * 0.4;
    if (Math.abs(rel) > limit) {
      const side = Math.sign(rel);
      this.x = center + side * limit;
      const impactSpeed = this.speed;
      if (impactSpeed > P.BARRIER_MIN_SPEED && Math.abs(lateral) > 40) {
        ev.barrier = true;
        this.speed *= 0.42;
        this.spin = Math.max(this.spin, 0.5);
        this.lateralVel = -side * impactSpeed * 0.35;   // bounce back inward
      } else {
        this.speed *= 0.9;
      }
      this.steer = -side * 0.35;
    }

    /* ---- tyre slip (drives audio + smoke) ---- */
    const steerSlip = Math.abs(this.steer) * U.clamp(speedNorm, 0, 1) * 0.85;
    const brakeSlip = brake > 0 && this.speed > 120 ? 0.75 : 0;
    const grassSlip = this.offRoad ? this.onGrass * 0.55 : 0;
    const spinSlip = this.spin > 0 ? 0.6 : 0;
    this.slip = U.clamp(Math.max(steerSlip, brakeSlip, spinSlip) + grassSlip * 0.5, 0, 1);
    this.braking = U.damp(this.braking, brake > 0 && this.speed > 0 ? 1 : 0, 14, dt);

    return ev;
  };

  /**
   * Post-collision resolution handled by game.js: kills most of the speed and
   * throws the car into a spin.
   */
  PlayerCar.prototype.applyCrash = function (severity) {
    this.speed *= U.clamp(1 - severity * 0.72, 0.12, 0.7);
    this.spin = CFG.PLAYER.SPIN_TIME * (0.6 + severity);
    this.invuln = Math.max(this.invuln, CFG.PLAYER.INVULN_TIME);
    this.boosting = false;
  };

  Racer.PlayerCar = PlayerCar;
})(typeof window !== 'undefined' ? window : globalThis);
