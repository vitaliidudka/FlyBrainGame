# fly-brain — full FlyWire connectome (production)

Pixel-art desktop fly whose behavior is driven by the real FlyWire FAFB
v783 connectome (139,255 neurons, 2.7M synapses, 63 functional groups),
simulated as a LIF network in a Web Worker — not `Math.random()`.
Single game file (`fly-pixel-game.html`), no build step.

- **Live on Vercel**: pushes to `main` auto-deploy (GitHub → Vercel).
  `vercel.json` rewrites `/` to `fly-pixel-game.html`.
- **GitHub**: `vitaliidudka/FlyBrainGame`, branch `main`.

## Running locally

`file://` does NOT work (browser blocks `fetch('data/connectome.bin.gz')`
and `new Worker('js/sim-worker.js')`); the game silently falls back to
a small legacy fallback model. Serve over HTTP:

```bash
python3 -m http.server 8791   # → http://localhost:8791/fly-pixel-game.html
```

## Layout

- `fly-pixel-game.html` — game, UI, behavior logic, stimuli, drives.
- `js/sim-worker.js` — LIF simulation over the CSR connectome.
- `js/brain-worker-bridge.js` — bridge: stimulation in, firing/motor
  outputs out (`synthesizeMotorOutputs`, `stimulateIndices`).
- `data/` — `connectome.bin.gz` (12 MB), `neuron_meta.json`,
  `neuron_positions.bin.gz`.
- `HANDOFF.md` — detailed handoff and per-fix history (start with its
  "Full-connectome experiment" section; some of its top-of-file
  "you are in a worktree/experiment" wording is now outdated).
- `CHANGELOG.md`, `README.md`.

## Working rules of thumb

- Prefer real neuron groups over virtual ones. Many groups have 0 real
  neurons in this dataset (e.g. `NOCI`, `DRIVE_FEAR`, `DRIVE_CURIOSITY`,
  `VIS_LC`, `DN_*`, `MN_LEG_*`) and silently do nothing when stimulated
  by index — route through real groups instead (fear goes via
  `GNG_DESC`, vision via `VIS_LO` ray subsets).
- One-shot stimulation of specific neurons: `BRAIN.stimulateIndices`
  (same pattern as kcHot/kcWire/kcRoach, fear, vision fan).
- The UI bars and the "thought" line are read-outs of real drives
  (`brain.fear`, `brain.curiosity`, ...), not controls — don't add
  sliders that write to internal state; interaction should be through
  stimuli (roach, wire, food, coffee, shake, click).
- When testing, reset state between scenarios (mode, zone, position,
  `lastSwitch`, `stateUntil`, `brain.groomAccum`); the AI logic
  overrides hand-forced state otherwise.
- `read_console_messages` can return stale errors from earlier page
  loads — confirm a problem is live before chasing it.
