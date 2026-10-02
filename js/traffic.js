/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - traffic.js
 * ----------------------------------------------------------------------------
 *  AI traffic: spawning, cruising, car-following, lane changes and despawning.
 *
 *  Behaviour is driven entirely by the active difficulty preset plus a ramp
 *  factor that grows with the distance covered, so a run gets harder the
 *  longer you survive:
 *      target population  minCars -> maxCars + ramp.extraCars
 *      cruise speeds      speedMin/speedMax * (1 + ramp.speedBonus * t)
 *      lane changes       laneChangeRate per second
 *      unpredictability   weave amplitude + "block the player" aggression
 *
 *  Fairness rule: the spawner never fills every lane inside a safety window,
 *  so there is always an escape route.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});
  const U = Racer.utils;
  const CFG = Racer.CONFIG;
  const DIFFS = Racer.DIFFICULTIES;
  const TYPES = CFG.TRAFFIC_TYPES;
  const TYPE_KEYS = Object.keys(TYPES);
  const T = CFG.TRAFFIC;

  function TrafficManager(world) {
    this.world = world;
    this.cars = [];
    this.diff = DIFFS.medium;
    this.rampT = 0;
    this.time = 0;
    this.spawnCooldown = 0;
    this.stats = { spawned: 0 };
  }

  /* ---------------------------------------------------------------- lifecycle */

  TrafficManager.prototype.reset = function (difficulty, playerDist) {
    this.diff = difficulty || DIFFS.medium;
    this.cars.length = 0;
    this.rampT = 0;
    this.time = 0;
    this.spawnCooldown = 0.4;
    this.stats.spawned = 0;
    this._prefill(playerDist || 0);
    return this;
  };

  /** Seed the highway so the player meets traffic within a couple of seconds. */
  TrafficManager.prototype._prefill = function (playerDist) {
    const target = this.targetCount(0);
    const firstSafe = playerDist + 620;
    for (let i = 0; i < target; i++) {
      const dist = firstSafe + 260 + i * U.rand(220, 420);
      this._trySpawnAt(dist, true);
    }
  };

  /* ------------------------------------------------------------ difficulty */

  /** 0..1 progress through the difficulty ramp for a given distance (metres). */
  TrafficManager.prototype.updateRamp = function (meters) {
    const ramp = this.diff.ramp;
    this.rampT = U.clamp(meters / ramp.meters, 0, 1);
    return this.rampT;
  };

  /** How many cars we're aiming to keep alive right now. */
  TrafficManager.prototype.targetCount = function (rampT) {
    const tr = this.diff.traffic;
    const t = rampT === undefined ? this.rampT : rampT;
    const high = tr.maxCars + (this.diff.ramp.extraCars || 0);
    return Math.round(U.lerp(tr.minCars, high, U.easeOutCubic(t)));
  };

  TrafficManager.prototype.speedRange = function () {
    const tr = this.diff.traffic;
    const bonus = 1 + (this.diff.ramp.speedBonus || 0) * this.rampT;
    return [tr.speedMin * bonus, tr.speedMax * bonus];
  };

  TrafficManager.prototype.minGap = function () {
    const tr = this.diff.traffic;
    return tr.gapMin * U.lerp(1, 0.82, this.rampT);
  };

  /* ----------------------------------------------------------------- spawning */

  /** Distance just beyond the visible top edge of the screen. */
  TrafficManager.prototype.spawnDistance = function (playerDist) {
    const ahead = (CFG.VIEW.HEIGHT * CFG.VIEW.PLAYER_ANCHOR) / CFG.CAMERA.ZOOM_MIN;
    return playerDist + ahead + T.SPAWN_PAD + U.rand(0, 320);
  };

  TrafficManager.prototype.update = function (dt, player) {
    this.time += dt;
    const cars = this.cars;

    /* ---- despawn ---- */
    for (let i = cars.length - 1; i >= 0; i--) {
      const c = cars[i];
      if (c.dist < player.dist - T.DESPAWN_BEHIND || c.dist > player.dist + T.MAX_AHEAD) {
        cars.splice(i, 1);
      }
    }

    /* ---- spawn ---- */
    this.spawnCooldown -= dt;
    if (this.spawnCooldown <= 0 && cars.length < this.targetCount()) {
      const dist = this.spawnDistance(player.dist);
      if (this._trySpawnAt(dist, false)) {
        this.spawnCooldown = U.rand(0.12, 0.4) * U.lerp(1.5, 0.55, this.rampT);
      } else {
        this.spawnCooldown = 0.14;
      }
    }

    /* ---- simulate ---- */
    for (let i = 0; i < cars.length; i++) {
      this._updateCar(cars[i], dt, player, cars);
    }

    /* ---- fairness pass: never leave a wall blocking every lane ahead ---- */
    this._openGaps(player);
  };

  /**
   * If every lane is occupied inside a short window directly ahead of the
   * player, the slowest car in that cluster gets a brief speed push so the
   * pack stretches and an escape route opens up. Without this, dense traffic
   * could randomly align into an unavoidable wall.
   */
  TrafficManager.prototype._openGaps = function (player) {
    const cars = this.cars;
    const lanes = this.world.laneCount;
    const window = T.SAFE_BLOCK_WINDOW;
    const stopDist = (player.speed * player.speed) / (2 * CFG.PLAYER.BRAKE) + player.hl;

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      // only care about clusters the player is about to reach
      if (c.dist < player.dist - 40 || c.dist > player.dist + stopDist + window * 2) continue;

      let occupied = 0;
      let slowest = c;
      const seen = {};
      for (let j = 0; j < cars.length; j++) {
        const o = cars[j];
        if (Math.abs(o.dist - c.dist) > window) continue;
        if (!seen[o.lane]) { seen[o.lane] = true; occupied++; }
        if (o.speed < slowest.speed) slowest = o;
      }

      if (occupied >= lanes) {
        slowest.pushTimer = 1.5;
        slowest.pushSpeed = Math.max(slowest.speed, player.speed + 45);
        slowest.brakeCheck = 0;
      }
    }
  };

  /**
   * Attempt to place one car near `dist`.
   * @returns {object|null} the created car
   */
  TrafficManager.prototype._trySpawnAt = function (dist, isPrefill) {
    const tr = this.diff.traffic;
    const world = this.world;
    const lanes = world.laneCount;
    const gapMin = this.minGap();

    /* Safety: don't spawn into a wall that blocks every lane. */
    let blockedLanes = 0;
    for (let l = 0; l < lanes; l++) {
      if (this._laneOccupiedNear(l, dist, T.SAFE_BLOCK_WINDOW)) blockedLanes++;
    }
    if (blockedLanes >= lanes - 1) return null;

    /* Pick a lane with enough longitudinal space. */
    const candidates = [];
    for (let l = 0; l < lanes; l++) {
      if (this._laneOccupiedNear(l, dist, gapMin)) continue;
      candidates.push(l);
    }
    if (!candidates.length) return null;
    const lane = U.pick(candidates);

    /* Pick a vehicle archetype (trucks are rarer and slower). */
    const typeKey = this._pickType();
    const type = TYPES[typeKey];

    const range = this.speedRange();
    let cruise = U.rand(range[0], range[1]) * U.rand(type.speed[0], type.speed[1]);
    // absolute ceiling so a sports car can never outrun the whole difficulty band
    cruise = Math.min(cruise, tr.speedCap || Infinity);

    const car = {
      id: ++TrafficManager._id,
      typeKey: typeKey,
      shape: type.shape,
      w: type.width,
      l: type.length,
      hw: type.width / 2,
      hl: type.length / 2,
      agility: type.agility,
      lane: lane,
      fromLane: lane,
      toLane: lane,
      laneT: 1,
      laneChangeCd: U.rand(0.6, 2.4),
      x: world.laneCenterX(dist, lane),
      dist: dist,
      speed: cruise,
      cruise: cruise,
      baseCruise: cruise,
      palette: Racer.Vehicles.randomPalette(),
      yaw: 0,
      weavePhase: U.rand(0, U.TAU),
      weaveAmp: tr.weave * U.rand(6, 16) * type.agility,
      weaveRate: U.rand(0.5, 1.3),
      indicator: 0,
      passed: false,
      nearMissScored: false,
      aggression: tr.aggressive ? U.rand(0.35, 1) : 0,
      blocking: 0,
      brakeCheck: 0,
      pushTimer: 0,
      pushSpeed: 0
    };

    this.cars.push(car);
    this.stats.spawned++;
    void isPrefill;
    return car;
  };

  TrafficManager._id = 0;

  TrafficManager.prototype._pickType = function () {
    const tr = this.diff.traffic;
    if (Math.random() < tr.truckChance) {
      return Math.random() < 0.55 ? 'truck' : 'van';
    }
    // weighted pick among the car archetypes
    const weights = {};
    for (let i = 0; i < TYPE_KEYS.length; i++) {
      const k = TYPE_KEYS[i];
      if (k === 'truck' || k === 'van') continue;
      weights[k] = TYPES[k].weight;
    }
    return U.weightedKey(weights);
  };

  /** Is any car within `window` px of `dist` in lane `lane`? */
  TrafficManager.prototype._laneOccupiedNear = function (lane, dist, window) {
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.toLane !== lane && c.lane !== lane) continue;
      const reach = window + c.hl;
      if (Math.abs(c.dist - dist) < reach) return true;
    }
    return false;
  };

  /** Nearest car ahead of `car` in the same lane (returns null when clear). */
  TrafficManager.prototype._carAhead = function (car) {
    let best = null;
    let bestGap = Infinity;
    for (let i = 0; i < this.cars.length; i++) {
      const o = this.cars[i];
      if (o === car) continue;
      if (o.toLane !== car.toLane) continue;
      const gap = o.dist - car.dist;
      if (gap > 0 && gap < bestGap) {
        bestGap = gap;
        best = o;
      }
    }
    return best ? { car: best, gap: bestGap } : null;
  };

  /* ------------------------------------------------------------------- AI */

  TrafficManager.prototype._updateCar = function (car, dt, player, cars) {
    const tr = this.diff.traffic;
    const world = this.world;

    /* ---- longitudinal: simple car following ---- */
    let targetSpeed = car.cruise;
    const ahead = this._carAhead(car);
    if (ahead) {
      const gap = ahead.gap - car.hl - ahead.car.hl;
      const desired = T.FOLLOW_GAP * (0.7 + car.agility * 0.5);
      if (gap < desired) {
        // match the leader, easing harder the closer we get
        const t = U.clamp(gap / desired, 0, 1);
        targetSpeed = U.lerp(ahead.car.speed * 0.92, car.cruise, t);
        // confident drivers pull out to overtake instead of crawling
        if (car.aggression > 0.45 && gap < desired * 0.55 && car.laneChangeCd <= 0) {
          this._beginLaneChange(car, cars);
        }
      }
    }

    /* ---- aggression: speed up when the player is right behind ---- */
    if (tr.aggressive && car.aggression > 0.5) {
      const behind = player.dist - car.dist;
      if (behind < 0 && behind > -260 && Math.abs(player.x - car.x) < world.laneWidth * 0.8) {
        car.blocking = U.damp(car.blocking, 1, 2, dt);
        targetSpeed = Math.min(targetSpeed * (1 + 0.22 * car.aggression),
                               (tr.speedCap || Infinity) * 1.12);
      } else {
        car.blocking = U.damp(car.blocking, 0, 2, dt);
      }
    }

    /* ---- hard mode: occasional unpredictable brake-check ---- */
    if (tr.weave > 0.5 && car.brakeCheck <= 0 && Math.random() < 0.0012 * car.aggression) {
      car.brakeCheck = U.rand(0.5, 1.0);
    }
    if (car.brakeCheck > 0) {
      car.brakeCheck -= dt;
      targetSpeed *= 0.55;
    }

    /* ---- fairness push: temporarily match the player to open a gap ---- */
    if (car.pushTimer > 0) {
      car.pushTimer -= dt;
      targetSpeed = Math.max(targetSpeed, car.pushSpeed);
    }

    const response = T.FOLLOW_RESPONSE * (0.6 + car.agility * 0.6);
    car.speed = U.approach(car.speed, targetSpeed, Math.abs(targetSpeed - car.speed) * response * dt + 24 * dt);
    car.speed = Math.max(40, car.speed);
    car.dist += car.speed * dt;

    /* ---- lateral: lane keeping, lane changes, weave ---- */
    if (car.laneT < 1) {
      car.laneT = Math.min(1, car.laneT + dt / T.LANE_CHANGE_TIME);
      const e = U.easeInOutQuad(car.laneT);
      car.lane = car.laneT >= 1 ? car.toLane : car.fromLane;
      const x0 = world.laneCenterX(car.dist, car.fromLane);
      const x1 = world.laneCenterX(car.dist, car.toLane);
      car.x = U.lerp(x0, x1, e);
      car.yaw = U.damp(car.yaw, Math.sin(e * Math.PI) * (car.toLane > car.fromLane ? 0.22 : -0.22), 8, dt);
      car.indicator = 1;
      if (car.laneT >= 1) {
        car.laneChangeCd = U.rand(1.2, 4.0) / Math.max(0.2, tr.laneChangeRate * 6);
      }
    } else {
      car.indicator = U.damp(car.indicator, 0, 6, dt);
      car.laneChangeCd -= dt;
      const weave = car.weaveAmp
        ? Math.sin(this.time * car.weaveRate * 2 + car.weavePhase) * car.weaveAmp
        : 0;
      const laneX = world.laneCenterX(car.dist, car.lane) + weave;
      car.x = U.damp(car.x, laneX, 7, dt);
      car.yaw = U.damp(car.yaw, U.clamp((laneX - car.x) * 0.004, -0.2, 0.2), 6, dt);

      // laneChangeRate is a per-second probability (config), scaled by agility
      if (car.laneChangeCd <= 0 && Math.random() < tr.laneChangeRate * dt * car.agility) {
        this._beginLaneChange(car, cars);
      }
    }
  };

  /** Start a lane change into a free neighbouring lane. */
  TrafficManager.prototype._beginLaneChange = function (car, cars) {
    const lanes = this.world.laneCount;
    const dirOptions = [];
    if (car.lane > 0) dirOptions.push(-1);
    if (car.lane < lanes - 1) dirOptions.push(1);
    if (!dirOptions.length) {
      car.laneChangeCd = 1.5;
      return;
    }
    // shuffle so hard mode feels less predictable
    dirOptions.sort(function () { return Math.random() - 0.5; });

    for (let i = 0; i < dirOptions.length; i++) {
      const target = car.lane + dirOptions[i];
      if (this._laneFreeFor(car, target, cars)) {
        car.fromLane = car.lane;
        car.toLane = target;
        car.laneT = 0;
        car.laneChangeCd = 999;   // reset when the change completes
        return;
      }
    }
    car.laneChangeCd = U.rand(0.8, 2.0);
  };

  /** Is `lane` clear enough for `car` to move into? */
  TrafficManager.prototype._laneFreeFor = function (car, lane, cars) {
    const gapNeeded = T.FOLLOW_GAP * 1.15 + car.hl;
    for (let i = 0; i < cars.length; i++) {
      const o = cars[i];
      if (o === car) continue;
      if (o.lane !== lane && o.toLane !== lane) continue;
      const d = o.dist - car.dist;
      if (Math.abs(d) < gapNeeded + o.hl) {
        // allow the move if we're clearly faster than the car ahead
        if (d > 0 && car.speed > o.speed * 1.25) continue;
        return false;
      }
    }
    return true;
  };

  /* ---------------------------------------------------------------- queries */

  /** Cars within a distance band of the player (used by collision + scoring). */
  TrafficManager.prototype.near = function (playerDist, ahead, behind) {
    const out = [];
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.dist > playerDist - behind && c.dist < playerDist + ahead) out.push(c);
    }
    return out;
  };

  TrafficManager.prototype.count = function () {
    return this.cars.length;
  };

  Racer.TrafficManager = TrafficManager;
})(typeof window !== 'undefined' ? window : globalThis);
