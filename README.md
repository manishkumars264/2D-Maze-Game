# Coastline Overdrive 🏁

A complete, original **2D browser arcade racing game** in the spirit of fast-paced
open-world racers (bright daytime highways, dense traffic, risk/reward scoring) —
built 100% from source with **HTML5 + CSS3 + vanilla JavaScript + Canvas 2D**.

No frameworks, no build step, no backend, no image/audio assets: every car, tree,
billboard, biome and sound effect is generated procedurally at runtime.

---

## ▶ Running the game

### Option 1 — just open it
Double-click **`index.html`** (or open it with your browser's *File → Open*).
The game is plain ES5-style scripts, so it runs straight from `file://`.

### Option 2 — local web server (recommended)
```bash
# from this folder
python3 -m http.server 8080
# then visit  http://localhost:8080
```
or with Node:
```bash
npx serve .          # or: npx http-server -p 8080
```

### Supported devices
| Device  | Experience                                              |
|---------|---------------------------------------------------------|
| Desktop / laptop | Full experience, keyboard controls (primary target) |
| Tablet  | Letterboxed 3:2 stage + on-screen touch pads            |
| Phone   | Playable via touch pads (keyboard-first design)         |

The play area keeps a fixed **3:2 aspect ratio** at any window size, and the HUD
scales with it. Hi-DPI screens get a sharper backing store automatically.

---

## 🎮 Controls

| Action            | Keys                          |
|-------------------|-------------------------------|
| Accelerate        | `↑` or `W`                    |
| Brake / reverse   | `↓` or `S`                    |
| Steer left        | `←` or `A`                    |
| Steer right       | `→` or `D`                    |
| NOS boost         | `Shift` (or `Space`)          |
| Pause / resume    | `P` or `Esc`                  |
| Mute / unmute     | `M`                           |
| Restart (after a crash / from pause) | `R`       |
| Confirm / start   | `Enter` or `Space`            |

All game keys call `preventDefault()`, so the page never scrolls or re-triggers
focused buttons while you play. Losing window focus auto-pauses the race.

Touch devices get left/right pads plus GAS / BRK / NOS buttons.

---

## 🕹 Gameplay

- **Three difficulties** chosen in the main menu (persisted between sessions):

  |            | Traffic on screen | Traffic speed | Lane changes | Shields | Score |
  |------------|-------------------|---------------|--------------|---------|-------|
  | **Easy**   | 2–3               | slow          | rare         | 3       | ×1.0  |
  | **Medium** | 4–6               | normal        | occasional   | 2       | ×1.5  |
  | **Hard**   | 7–10              | fast          | frequent     | 1       | ×2.2  |

  Difficulty also changes traffic gaps, car-following aggression, unpredictable
  weaving/brake-checks, player handling and how fast the run ramps up.

- **Endless curving highway** across five cross-fading biomes
  (coast → forest → city → farmland → canyon), each with its own scenery set:
  palms, pines, billboards, barns, mesas, sailboats, hay bales, light poles…
- **Risk/reward scoring** — distance is the base score; threading past traffic
  awards *near-miss* bonuses that build a combo (up to ×4) and refill your NOS.
- **Shields instead of instant death** (except hard mode): a crash costs a
  shield, spins you out and grants brief invulnerability. Lose them all → wreck.
- **Arcade physics**: acceleration, drag, engine braking, reverse, speed-sensitive
  steering, grass slowdown, barrier scrapes, NOS with drain/refill.
- **Juice**: slow-motion crash sequence, screen shake, sparks, debris, tyre
  smoke, boost flames, cloud shadows, speed streaks, sun glare, vignette.
- **Synthesised audio** (WebAudio, zero files): engine note that tracks rpm,
  wind, tyre screech, crash slams, UI blips, countdown beeps. Mute with `M`.
- Best score / longest run are stored in `localStorage`.

---

## 🗂 Project structure

```
index.html              markup: stage, canvas, HUD, menu/pause/game-over overlays
css/style.css           all styling + responsive rules (UI scales with the stage)
js/
  config.js             ★ every tunable number: view, road, physics, traffic
                        ★ archetypes, scoring, FX and the 3 DIFFICULTY presets
  utils.js              math / random / colour / storage helpers, roundRect polyfill
  input.js              keyboard (arrows + WASD), touch pads, key-prevention, blur handling
  audio.js              WebAudio synth: engine, wind, screech, crashes, UI, mute
  particles.js          pooled particles: smoke, sparks, debris, flames, rings, popups
  vehicles.js           procedural top-down car art (7 archetypes + hero livery)
  world.js              road centreline curves, biomes, chunked scenery cache, road events
  player.js             player physics: throttle/brake/steer/boost/shields/spin
  traffic.js            AI traffic: spawning, car-following, lane changes, fairness pass
  collision.js          AABB collision + near-miss detection + impact analysis
  renderer.js           camera + the whole layered canvas painter + prop art
  ui.js                 DOM: menu, difficulty cards, HUD, speedometer, toasts, stage fit
  game.js               state machine (menu/countdown/playing/paused/crashing/gameover),
                        rAF loop, scoring, crash orchestration, difficulty management
  main.js               bootstrap, feature detection, audio unlock, browser guards
tests/
  stub-dom.js           fake browser (DOM + real canvas via @napi-rs/canvas)
  headless.test.js      70+ automated checks (run: node tests/headless.test.js)
  screenshots.js        renders PNG frames for visual inspection
```

Everything hangs off a single `window.Racer` namespace; scripts are plain
`<script>` tags (no modules), so the game also works from `file://`.

---

## 🔧 Tuning the game

All balance lives in **`js/config.js`**:

```js
Racer.DIFFICULTIES.easy.traffic.minCars   = 2;   // target traffic population
Racer.DIFFICULTIES.easy.traffic.maxCars   = 3;
Racer.DIFFICULTIES.easy.traffic.gapMin    = 900; // min spacing inside a lane (px)
Racer.DIFFICULTIES.easy.traffic.laneChangeRate = 0.03;
Racer.CONFIG.PLAYER.MAX_SPEED             = 420; // px/s (×0.6 = km/h shown)
Racer.CONFIG.PLAYER.STEER_RATE            = 252;
Racer.CONFIG.SCORING.NEAR_MISS_BASE       = 60;
```

The difficulty ramp (extra cars / faster traffic / tighter curves the longer you
survive) is in each preset's `ramp` block. Road geometry, biome lengths, FX
strengths and the countdown timings are all in the same file too.

---

## ✅ Testing

```bash
node tests/headless.test.js     # logic suite: states, difficulties, controls,
                                # collisions, scoring, pause/restart, UI, perf
node tests/screenshots.js       # writes PNG frames to .shots/ (needs @napi-rs/canvas)
```

The suite drives the **real game code** in a stubbed browser (with a genuine
software canvas), including a rule-based AI driver that must *survive* hard-mode
traffic — which is how fairness of the traffic spawner is verified.

---

## 📜 Credits & licensing notes

All graphics, UI and sounds are **original and procedurally generated**.
The game is *inspired by* the feel of modern open-world arcade racers but copies
no assets, artwork, audio, logos or code from any commercial title. Fictional
in-game brands ("NOS COLA", "APEX TYRES", …) are original.
