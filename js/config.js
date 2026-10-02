/**
 * ============================================================================
 *  COASTLINE OVERDRIVE - config.js
 * ----------------------------------------------------------------------------
 *  Single source of truth for every tunable number in the game:
 *    - view / camera / unit conversions
 *    - road geometry
 *    - player car physics (arcade style)
 *    - traffic vehicle archetypes
 *    - scoring rules
 *    - the three difficulty presets (EASY / MEDIUM / HARD)
 *
 *  Everything the brief asks to be "easily adjustable later" lives here.
 *  Nothing in this file touches the DOM or the canvas.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const Racer = (global.Racer = global.Racer || {});

  const CONFIG = {
    /* ------------------------------------------------------------------ *
     * View / rendering surface
     * The game is authored in a fixed logical resolution and then scaled
     * (letterboxed) to whatever the viewport allows, so gameplay and the
     * playable aspect ratio stay identical on desktop / laptop / tablet.
     * ------------------------------------------------------------------ */
    VIEW: {
      WIDTH: 960,           // logical px
      HEIGHT: 640,          // logical px  (3:2)
      ASPECT: 960 / 640,
      MAX_DPR: 2,           // cap devicePixelRatio for performance
      PLAYER_ANCHOR: 0.78,  // player's vertical screen position (fraction of height)
      ROW_STEP: 8           // world px between road-surface sampling rows
    },

    /* Unit conversions used by the HUD.
     * 1 world px == 1/6 metre, so 420 px/s == 70 m/s == 252 km/h. */
    UNITS: {
      PX_TO_METERS: 1 / 6,
      PX_TO_KMH: 0.6
    },

    /* ------------------------------------------------------------------ *
     * Road geometry (all values in world px, measured from road centre)
     * ------------------------------------------------------------------ */
    ROAD: {
      LANES: 4,
      LANE_WIDTH: 84,
      RUMBLE_WIDTH: 10,     // red/white kerb strip just outside the lanes
      SHOULDER: 36,         // paved hard shoulder outside the rumble strip
      VERGE: 168,           // grass between paved edge and the barrier
      BARRIER_OFFSET: 380,  // armco barrier distance from road centre
      SCENERY_MIN: 232,     // nearest roadside prop offset
      SCENERY_MAX: 372,     // farthest roadside prop offset
      DASH_LEN: 46,         // lane marking dash length
      DASH_GAP: 46,         // lane marking dash gap
      RUMBLE_LEN: 34        // kerb segment length
    },

    /* ------------------------------------------------------------------ *
     * Road curvature - a sum of sine waves gives an endless, organic
     * highway that never repeats. Amplitude slowly grows with distance
     * ("increasing challenge as the player progresses").
     * ------------------------------------------------------------------ */
    CURVE: {
      WAVES: [
        { amp: 92, freq: 0.00090, phase: 0.0 },
        { amp: 46, freq: 0.00220, phase: 1.7 },
        { amp: 18, freq: 0.00480, phase: 4.2 }
      ],
      SCALE_START: 0.45,    // gentler at the very start of a run
      SCALE_MAX: 1.55,      // hardest curvature later on
      SCALE_RAMP_METERS: 5200,
      START_EASE_METERS: 260
    },

    /* ------------------------------------------------------------------ *
     * Biomes: scenery + ground palettes that cross-fade as you drive.
     * ------------------------------------------------------------------ */
    BIOME: {
      LENGTH: 4200,         // world px per biome
      CROSSFADE: 900        // world px of blending between two biomes
    },

    /* ------------------------------------------------------------------ *
     * Player car - simple arcade physics (NOT a simulation)
     * ------------------------------------------------------------------ */
    PLAYER: {
      WIDTH: 42,
      LENGTH: 76,

      MAX_SPEED: 420,             // px/s  -> 252 km/h
      BOOST_MAX_SPEED: 560,       // px/s  -> 336 km/h
      ACCEL: 205,                 // px/s^2 at standstill
      BOOST_ACCEL: 340,
      BRAKE: 560,
      REVERSE_ACCEL: 135,
      MAX_REVERSE: -110,
      ENGINE_BRAKE: 95,           // coasting deceleration
      DRAG: 0.00008,              // quadratic drag coefficient (fine-tunes top speed)
      STOP_THRESHOLD: 4,          // snap to zero below this

      STEER_RATE: 252,            // lateral px/s at full lock & grip
      STEER_SMOOTH: 9.5,          // how fast steering input eases in/out
      STEER_MIN_SPEED: 40,        // below this the car barely turns
      STEER_GRIP_REF: 165,        // speed at which full steering grip is reached
      STEER_HSFALLOFF: 0.34,      // grip lost at absolute top speed (feels weighty)
      MAX_YAW: 0.30,              // visual body angle at full lock (rad)

      OFFROAD_SPEED_FACTOR: 0.45, // max speed multiplier on grass
      OFFROAD_DRAG: 1.55,         // extra deceleration on grass
      OFFROAD_GRIP: 0.62,         // steering multiplier on grass

      BOOST_MAX: 100,
      BOOST_DRAIN: 30,            // per second
      BOOST_REGEN: 4.6,           // per second
      BOOST_MIN_USE: 6,           // below this the tank is "empty"
      BOOST_NEAR_MISS: 15,        // NOS granted per near miss

      INVULN_TIME: 2.2,           // seconds of grace after surviving a hit
      SPIN_TIME: 0.95,            // seconds of lost control after a hit
      BARRIER_MIN_SPEED: 250      // hitting the barrier faster than this costs a shield
    },

    /* ------------------------------------------------------------------ *
     * Camera
     * ------------------------------------------------------------------ */
    CAMERA: {
      ZOOM_MIN: 0.855,   // zoomed out at top speed (widens the view, adds drama)
      ZOOM_MAX: 1.0,
      ZOOM_LERP: 2.0,
      X_LERP: 5.0,
      ROAD_FOLLOW: 0.34,     // how much the camera tracks the road centreline
      LOOKAHEAD_STEER: 26,   // extra px of camera lead per unit of lateral velocity
      SHAKE_DECAY: 5.0,
      MAX_SHAKE: 26
    },

    /* ------------------------------------------------------------------ *
     * Traffic archetypes. `speed` is a multiplier applied to the difficulty's
     * traffic speed range, so one preset change rescales every vehicle.
     * ------------------------------------------------------------------ */
    TRAFFIC_TYPES: {
      hatch:  { label: 'Hatch',  width: 40, length: 68,  speed: [0.90, 1.10], agility: 1.00, weight: 16, shape: 'hatch'  },
      sedan:  { label: 'Sedan',  width: 44, length: 82,  speed: [0.95, 1.12], agility: 0.85, weight: 26, shape: 'sedan'  },
      sports: { label: 'Sports', width: 42, length: 76,  speed: [1.16, 1.42], agility: 1.35, weight: 14, shape: 'sports' },
      muscle: { label: 'Muscle', width: 47, length: 86,  speed: [1.08, 1.30], agility: 0.95, weight: 12, shape: 'muscle' },
      van:    { label: 'Van',    width: 48, length: 104, speed: [0.80, 0.95], agility: 0.55, weight: 12, shape: 'van'    },
      truck:  { label: 'Truck',  width: 52, length: 138, speed: [0.66, 0.84], agility: 0.35, weight: 8,  shape: 'truck'  }
    },

    /* Traffic spawning / AI (difficulty presets override the behavioural bits) */
    TRAFFIC: {
      SPAWN_PAD: 280,          // extra px beyond the visible top edge
      DESPAWN_BEHIND: 950,     // px behind the player before removal
      MAX_AHEAD: 2900,         // never simulate cars further ahead than this
      FOLLOW_GAP: 190,         // car-following headway (px)
      FOLLOW_RESPONSE: 1.6,
      LANE_CHANGE_TIME: 0.85,  // seconds to slide one lane across
      SAFE_BLOCK_WINDOW: 210,  // px: don't fill every lane inside this window
      MIN_LANE_GAP_FACTOR: 1.0 // gapMin is multiplied by vehicle length/80
    },

    /* ------------------------------------------------------------------ *
     * Scoring
     * ------------------------------------------------------------------ */
    SCORING: {
      DISTANCE_POINTS_PER_M: 1.0,
      SPEED_BONUS_PER_S: 12,      // awarded above SPEED_BONUS_THRESHOLD km/h
      SPEED_BONUS_THRESHOLD: 120,
      NEAR_MISS_BASE: 60,
      NEAR_MISS_WINDOW: 52,       // px of lateral clearance that counts as "close"
                                  // (an adjacent-lane pass leaves ~41px of gap)
      NEAR_MISS_LENGTH: 96,       // px of longitudinal overlap required
      COMBO_STEP: 0.25,           // multiplier gained per near miss
      COMBO_MAX: 4.0,
      COMBO_TIMEOUT: 3.2,         // seconds before the combo resets
      OFFROAD_SCORE_FACTOR: 0.35  // distance still scores, but slowly, off-road
    },

    /* ------------------------------------------------------------------ *
     * Visual effects tuning
     * ------------------------------------------------------------------ */
    FX: {
      MAX_PARTICLES: 340,
      SPEED_LINE_START: 0.42,     // fraction of max speed where speed lines appear
      SCREEN_TILT: 0.0,
      SHADOW_DIR: { x: 0.42, y: 0.55 },   // "sun" direction for cast shadows
      VIGNETTE: 0.42,
      CRASH_SLOWMO: 0.22,
      CRASH_SLOWMO_TIME: 1.35
    },

    /* Countdown before a race starts */
    COUNTDOWN: { STEPS: ['3', '2', '1', 'GO!'], STEP_TIME: 0.72 },

    /* localStorage keys (wrapped in try/catch at runtime) */
    STORAGE: {
      BEST_SCORE: 'co.bestScore.v1',
      BEST_DIST: 'co.bestDist.v1',
      DIFFICULTY: 'co.difficulty.v1',
      MUTED: 'co.muted.v1'
    },

    DEBUG: false
  };

  /* ==================================================================== *
   *  DIFFICULTY PRESETS
   *  Difficulty changes far more than the traffic count: vehicle speeds,
   *  spacing, lane-change aggression, shields ("lives"), player handling
   *  and the score multiplier are all tuned per preset.
   * ==================================================================== */
  const DIFFICULTIES = {
    easy: {
      id: 'easy',
      label: 'Easy',
      tagline: 'Sunday cruise',
      blurb: 'Light, slow and predictable traffic with big gaps. Three shields and a touch more grip.',
      color: '#3ddc97',
      /* target traffic population */
      traffic: {
        minCars: 2,
        maxCars: 3,
        speedMin: 112,        // px/s
        speedMax: 176,
        gapMin: 900,          // minimum spacing in a lane (world px)
        laneChangeRate: 0.03, // probability per second per car
        weave: 0.0,           // extra unpredictable lateral drift
        aggressive: false,    // traffic never speeds up to block you
        speedCap: 210,        // absolute traffic speed ceiling (px/s)
        truckChance: 0.10
      },
      shields: 3,
      handling: { accelBonus: 1.08, gripBonus: 1.06, offroadGrace: 1.15 },
      /* difficulty ramp as the run gets longer */
      ramp: { meters: 6200, extraCars: 2, speedBonus: 0.14, curveBonus: 0.18 },
      scoreMultiplier: 1.0
    },

    medium: {
      id: 'medium',
      label: 'Medium',
      tagline: 'Rush hour',
      blurb: 'A proper flow of traffic at realistic highway speeds. Two shields, normal spacing.',
      color: '#ffc857',
      traffic: {
        minCars: 4,
        maxCars: 6,
        speedMin: 142,
        speedMax: 216,
        gapMin: 640,
        laneChangeRate: 0.09,
        weave: 0.25,
        aggressive: true,
        speedCap: 265,
        truckChance: 0.14
      },
      shields: 2,
      handling: { accelBonus: 1.0, gripBonus: 1.0, offroadGrace: 1.0 },
      ramp: { meters: 5200, extraCars: 3, speedBonus: 0.20, curveBonus: 0.24 },
      scoreMultiplier: 1.5
    },

    hard: {
      id: 'hard',
      label: 'Hard',
      tagline: 'Full send',
      blurb: 'Dense, fast, unpredictable traffic with tiny gaps. One shield. No mistakes allowed.',
      color: '#ff5d73',
      traffic: {
        minCars: 7,
        maxCars: 10,
        speedMin: 172,
        speedMax: 278,
        gapMin: 430,
        laneChangeRate: 0.18,
        weave: 0.55,
        aggressive: true,
        speedCap: 330,
        truckChance: 0.16
      },
      shields: 1,
      handling: { accelBonus: 0.96, gripBonus: 0.97, offroadGrace: 0.9 },
      ramp: { meters: 4200, extraCars: 4, speedBonus: 0.28, curveBonus: 0.32 },
      scoreMultiplier: 2.2
    }
  };

  /** Ordered list used to build the menu cards. */
  const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

  Racer.CONFIG = CONFIG;
  Racer.DIFFICULTIES = DIFFICULTIES;
  Racer.DIFFICULTY_ORDER = DIFFICULTY_ORDER;
})(typeof window !== 'undefined' ? window : globalThis);
