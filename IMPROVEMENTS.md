# LogicLab — Next Improvements

A prioritized backlog for the logic-circuit sandbox. Items are grouped by
theme and ordered roughly by value-to-effort within each group. Current
stack: vanilla TypeScript, `<canvas>` rendering, no framework, no bundler
(`tsc` only).

---

## 1. Core interaction gaps (highest impact) — ✅ DONE

These were missing capabilities users expect immediately. All implemented:

- **Delete gates & wires.** ✅ `Engine.removeWire(id)` added; `Delete`/
  `Backspace` removes the selection; wires are selectable by clicking their
  curve (`View.wireAt` hit-tests the bezier).
- **Selection model.** ✅ `view.ts` tracks selected gate ids + a selected
  wire, draws highlights (dashed ring on gates, halo on wires), and drives
  delete/copy/duplicate.
- **Undo / redo.** ✅ New `history.ts` keeps snapshot undo/redo stacks;
  `beforeChange` captures pre-mutation state. Bound to `Ctrl+Z` /
  `Ctrl+Y` / `Ctrl+Shift+Z`.
- **Multi-select + box-select + group move.** ✅ Marquee drag on empty
  canvas selects gates; `Shift`+click adds; selected gates move together.
- **Copy / paste / duplicate.** ✅ `Ctrl+C`/`V`/`D` with pin-id remapping so
  internal wiring is preserved; pastes cascade so copies don't stack.

## 2. More components — ✅ MOSTLY DONE

The engine is cleanly extensible via `PIN_SHAPE` + `computeGate`.

- **NAND, NOR, XOR, XNOR** gates. ✅
- **Multi-input gates.** ✅ AND/OR/NAND/NOR/XOR/XNOR grow to 8 inputs via
  `+`/`−` on the selection; gate bodies auto-size; input count is serialised.
- **CLOCK** source. ✅ Flips on a 600 ms timer (outside undo history).
- **Constant HIGH / LOW** sources. ✅
- **7-segment display / multi-LED bus.** ⏭️ Deferred (rendering-heavy).
- **Sub-circuits / custom chips.** ⏭️ Deferred — large architectural feature
  (nested engines, defined I/O boundaries, palette integration).

## 3. Simulation correctness & feedback — ✅ MOSTLY DONE

- **Oscillation warning.** ✅ `evaluate()` now returns whether it settled;
  `main.ts` toasts "circuit is unstable" (edge-triggered) and updates the
  status readout, clearing it once the circuit stabilises again.
- **Truth-table panel.** ✅ "Truth Table" button enumerates every SWITCH
  combination (≤ 8 inputs), settles per row, and tabulates the LED outputs
  in a modal. Live switch states are saved and restored.
- **Tri-state / unconnected distinction.** ✅ Undriven input pins render as
  a hollow amber ring ("floating — reads low"), rebuilt each frame from the
  wire set.
- **Sequential logic support.** ⏭️ Partially addressed: the fixed-point loop
  already carries output state across iterations (so a NAND latch can
  settle), and instability is now reported. A full interactive *stepped*
  mode (pause auto-settle + a Step button to watch feedback propagate) is
  deferred — it needs a simulation-mode toggle that reworks the always-on
  auto-settle model.

## 4. Persistence & sharing — ✅ DONE

All handled by the new `src/persistence.ts` module (validation, migration,
storage, URL codec), wired into `main.ts` + a "Saved Circuits" sidebar panel.

- **Autosave to `localStorage`.** ✅ Debounced (800 ms) after any user edit —
  structural, logical, or positional — via a new `View.onEdit` hook. Restored
  on boot.
- **Named circuits / gallery.** ✅ Name + Save field plus a list with
  load/delete, persisted under `logiclab:circuits` (overwrite-by-name,
  newest first).
- **Shareable URL.** ✅ "Copy Share Link" encodes the snapshot as base64url in
  the location hash (`#c=…`) and copies it to the clipboard; boot restores a
  shared circuit ahead of autosave.
- **Snapshot versioning.** ✅ `LATEST_VERSION` + a stepwise `migrate()` ladder;
  newer-than-supported files are rejected with a clear message.
- **Import validation.** ✅ `parseCircuit`/`validateSnapshot` type-check every
  gate/wire and throw human-readable errors, surfaced as toasts on file open.

## 5. UX & discoverability — ✅ DONE

- **Grid snapping.** ✅ Toggle in a new "View" panel; snaps on place and on
  move-release to a 16-unit world grid.
- **Labels / naming.** ✅ `Gate.label` (serialised, copy/paste-aware) drawn
  above the body; set via right-click → Rename or double-click.
- **Right-click context menu.** ✅ Rename / Duplicate / Add·Remove input /
  Delete for gates, Delete for wires; positioned + clamped to the viewport.
- **Zoom/pan without Ctrl.** ✅ Pan via middle-mouse, held `Space`, or
  two-finger scroll; zoom via pinch or `Ctrl`+scroll. Ctrl-drag still pans.
- **Fit-to-content / reset view.** ✅ "Fit to Content" button + `F` key frames
  all gates (or resets to origin when empty).
- **Minimap.** ✅ Toggleable bottom-right overview with gate dots and a live
  viewport rectangle.
- **Touch support.** ✅ Two-pointer pinch zoom+pan; single-touch place/move/
  wire already worked through pointer events (`touch-action: none`).

## 6. Accessibility — ✅ DONE

- **Screen-reader representation.** ✅ A visually-hidden `aria-live` status
  region announces actions, plus a hidden `#a11y-outline` region that lists
  every component and connection (`View.outlineText`), refreshed on each edit.
- **Full keyboard operation.** ✅ Canvas is focusable (`role="application"`,
  `tabindex`). Arrows navigate between gates, `Shift`+arrows reposition,
  `Enter` toggles a switch or drops the armed component, and `W` does two-step
  wiring — all with spoken announcements.
- **Colorblind palette + contrast.** ✅ Toggle swaps the logic-high accent from
  green to a colorblind-safe amber (`View.setColorblind`); on/off is already
  reinforced with ON/OFF, 1/0, and filled-vs-hollow pins.
- **`prefers-reduced-motion`.** ✅ CSS media query neutralises transitions/
  animations; the canvas also drops decorative glow via `View.glow()`.

## 7. Code quality & tooling — ✅ DONE

- **Unit tests.** ✅ 18 tests in `test/engine.test.ts` cover pin shapes, every
  gate truth table, multi-input reduction, `connect` rules + single-driver
  replacement, `removeWire`/`removeGate` cleanup, oscillation detection,
  clocks, labels, and snapshot round-tripping. Uses Node's built-in
  `node:test` (zero runtime deps) via `npm test`.
- **`removeGate` wire cleanup.** ✅ Rewritten to collect the gate's pin ids and
  drop any wire touching them directly (no reliance on deletion order).
- **`connect` replacement cue.** ✅ When a new wire displaces an input's
  existing driver, that pin flashes a fading red ring (mouse + keyboard paths).
- **Linting / formatting + CI.** ✅ ESLint (flat config, typescript-eslint) and
  Prettier with `lint`/`format`/`format:check` scripts, plus a GitHub Actions
  workflow running typecheck + lint + format + test + build.
- **Render loop.** ✅ Dirty-flag rendering — the canvas only redraws when
  something changed or an animation is in flight (`View.invalidate`).
- **`README.md`.** ✅ Added: features, setup, controls table, architecture, and
  dev scripts.

## 8. Performance (only if circuits grow large)

- `pinAt`/`gateAt` are O(n) linear scans per pointer move; fine for small
  circuits, but a spatial index (grid bucket) would help at scale.
- `evaluate()` re-scans every pin/wire each iteration. An event-driven or
  topologically-ordered propagation would scale better for big designs.

---

### Suggested first milestone

A tight, high-value first pass:

1. Delete + selection (§1)
2. Undo/redo via existing snapshot APIs (§1)
3. NAND/NOR/XOR/XNOR gates (§2)
4. Autosave to `localStorage` (§4)
5. Engine unit tests (§7)

These are mostly additive, leverage existing engine APIs, and dramatically
improve day-to-day usability.
