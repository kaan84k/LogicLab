/* ============================================================
   view.ts — canvas rendering + pointer interaction.

   Owns the viewport transform (panX, panY, scale), draws the
   circuit each animation frame, and translates raw pointer /
   wheel events into engine mutations (place, move, wire, toggle,
   select, delete, duplicate).
   ============================================================ */

import { Engine, Gate, GateType, Pin, supportsVariableInputs, MIN_INPUTS, MAX_INPUTS } from "./engine.js";

/* ---------- Layout constants (world units) ---------- */
const GATE_W = 96;
const GATE_H = 64;
const PIN_R = 6;
const HIT_PAD = 10; // extra hit-radius so pins are easy to grab
const WIRE_HIT = 8; // world-unit tolerance when clicking a wire
const GRID = 16; // world-unit spacing used by snap-to-grid
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;

/** Light-theme canvas colors (the "live"/power hue is a separate field). */
const PALETTE = {
  grid: "rgba(60, 90, 150, 0.1)",
  accent: "#3765f0",
  wireOff: "#aab6cc",
  wireHighlight: "rgba(79, 125, 255, 0.35)",
  gateFill: "#ffffff",
  gateStroke: "#cbd5e6",
  labelLive: "#0e9f6e",
  labelIdle: "#4a5568",
  offText: "#94a0b5",
  ledOff: "#cdd6e6",
  pinOff: "#9aa7bd",
  pinOutline: "#8a94a8",
  floatFill: "#ffffff",
  floatRing: "#e59313",
  marqueeFill: "rgba(79, 125, 255, 0.14)",
  marqueeStroke: "rgba(79, 125, 255, 0.9)",
  mmBg: "rgba(255, 255, 255, 0.92)",
  mmStroke: "#cbd5e6",
  mmGateOff: "#b7c2d6",
  userLabel: "#3765f0",
} as const;

/** Human-facing labels drawn inside each gate body. */
const GATE_LABEL: Record<GateType, string> = {
  SWITCH: "SWITCH",
  HIGH: "HIGH",
  LOW: "LOW",
  CLOCK: "CLOCK",
  NOT: "NOT",
  AND: "AND",
  OR: "OR",
  NAND: "NAND",
  NOR: "NOR",
  XOR: "XOR",
  XNOR: "XNOR",
  LED: "LED",
};

interface Point {
  x: number;
  y: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A self-contained, id-remappable fragment of a circuit. */
interface Clip {
  gates: Array<{ oldId: string; type: GateType; x: number; y: number; state: boolean; label?: string }>;
  wires: Array<{ from: string; to: string }>;
}

type Drag =
  | { kind: "none" }
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "move"; gateId: string; prevX: number; prevY: number; moved: boolean }
  | { kind: "wire"; fromPin: string; cursor: Point }
  | { kind: "marquee"; startX: number; startY: number; curX: number; curY: number; additive: boolean };

export class View {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly engine: Engine;

  /* Viewport transform: screen = world * scale + pan. */
  panX = 0;
  panY = 0;
  scale = 1;

  private drag: Drag = { kind: "none" };
  /** Component type armed from the sidebar, ready to be dropped. */
  private armed: GateType | null = null;
  private hoverPin: Pin | null = null;
  private dpr = 1;
  /** Input pin ids that have a wire feeding them, rebuilt each frame. */
  private readonly drivenInputs = new Set<string>();

  /* ---------- View options ---------- */
  private snapEnabled = false;
  private minimapOn = true;
  /** Held-space enables drag-to-pan without Ctrl. */
  private spaceHeld = false;

  /* ---------- Theme (colorblind + reduced motion) ---------- */
  /** The "live"/logic-high accent; swapped for a colorblind-safe hue on demand. */
  private powerColor = "#10b981";
  private powerGlow = "rgba(16, 185, 129, 0.4)";
  /** When true, skip decorative glow (respects prefers-reduced-motion). */
  private reducedMotion =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Multi-touch (pinch zoom/pan) ---------- */
  private readonly pointers = new Map<number, Point>(); // id → screen pos
  private pinch: { startDist: number; startScale: number; anchor: Point } | null = null;

  /* ---------- Selection ---------- */
  private selection = new Set<string>(); // selected gate ids
  private selectedWire: string | null = null;
  private clipboard: Clip | null = null;
  private pasteSerial = 0;
  /** Pending source pin id while wiring via the keyboard (null = not wiring). */
  private kbWireFrom: string | null = null;
  /** Transient highlight on an input whose driver was just replaced. */
  private flashPin: string | null = null;
  private flashUntil = 0;
  /** Redraw only when something changed (or an animation is in flight). */
  private dirty = true;

  /** Called whenever the circuit is mutated (so callers can re-evaluate). */
  onChange: () => void = () => {};
  /** Called immediately BEFORE a mutation (so callers can snapshot for undo). */
  beforeChange: () => void = () => {};
  /**
   * Called after any user edit completes — structural, logical, OR purely
   * positional (a move). Distinct from `onChange`, which only fires for edits
   * that need a re-evaluation. Used for autosave.
   */
  onEdit: () => void = () => {};

  /** Mark the canvas as needing a redraw on the next animation frame. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Re-evaluate + mark edited: the usual "something logical changed" path. */
  private commit(): void {
    this.dirty = true;
    this.onChange();
    this.onEdit();
  }

  constructor(canvas: HTMLCanvasElement, engine: Engine) {
    this.canvas = canvas;
    this.engine = engine;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable.");
    this.ctx = ctx;

    this.resize();
    window.addEventListener("resize", () => this.resize());

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.endPointer(e));
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

    // Space acts as a transient "pan" modifier (like most canvas editors).
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !this.isTextTarget(e.target)) {
        this.spaceHeld = true;
        e.preventDefault(); // don't scroll / activate a focused button while panning
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spaceHeld = false;
    });

    requestAnimationFrame(() => this.frame());
  }

  private isTextTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }

  /** Arm a component type; the next empty-canvas click drops it. */
  arm(type: GateType | null): void {
    this.armed = type;
  }

  /* --------------------------------------------------------
     Coordinate helpers
     -------------------------------------------------------- */

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.dirty = true;
  }

  /** Screen (CSS px, relative to canvas) → world coordinates. */
  private toWorld(sx: number, sy: number): Point {
    return { x: (sx - this.panX) / this.scale, y: (sy - this.panY) / this.scale };
  }

  /** Absolute client coords → world coordinates (for DOM-level events). */
  private clientToWorld(clientX: number, clientY: number): Point {
    const rect = this.canvas.getBoundingClientRect();
    return this.toWorld(clientX - rect.left, clientY - rect.top);
  }

  private eventPos(e: PointerEvent | WheelEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Round a world coordinate to the grid when snapping is on. */
  private snap(v: number): number {
    return this.snapEnabled ? Math.round(v / GRID) * GRID : v;
  }

  /** Gate body height grows to fit its busiest side (many-input gates). */
  private gateH(gate: Gate): number {
    const pins = Math.max(gate.inputs.length, gate.outputs.length, 1);
    return Math.max(GATE_H, 20 + pins * 18);
  }

  /** World position of a pin, derived from its owning gate + index. */
  private pinPos(pin: Pin): Point {
    const gate = this.engine.gates.get(pin.gateId)!;
    const h = this.gateH(gate);
    if (pin.kind === "input") {
      const n = gate.inputs.length;
      return { x: gate.x, y: gate.y + (h * (pin.index + 1)) / (n + 1) };
    }
    const n = gate.outputs.length;
    return { x: gate.x + GATE_W, y: gate.y + (h * (pin.index + 1)) / (n + 1) };
  }

  /* --------------------------------------------------------
     Hit testing
     -------------------------------------------------------- */

  /** Does any wire currently feed this input pin? */
  private isDriven(pinId: string): boolean {
    for (const w of this.engine.wires.values()) {
      if (w.to === pinId) return true;
    }
    return false;
  }

  /** Briefly highlight an input whose incoming wire was just replaced. */
  private flashInput(pinId: string): void {
    this.flashPin = pinId;
    this.flashUntil = performance.now() + 500;
  }

  private pinAt(world: Point): Pin | null {
    const r = PIN_R + HIT_PAD;
    for (const gate of this.engine.gates.values()) {
      for (const pin of [...gate.inputs, ...gate.outputs]) {
        const p = this.pinPos(pin);
        if ((p.x - world.x) ** 2 + (p.y - world.y) ** 2 <= r * r) return pin;
      }
    }
    return null;
  }

  private gateAt(world: Point): Gate | null {
    // Iterate in reverse insertion order so topmost gate wins.
    const gates = [...this.engine.gates.values()];
    for (let i = gates.length - 1; i >= 0; i--) {
      const g = gates[i];
      if (world.x >= g.x && world.x <= g.x + GATE_W && world.y >= g.y && world.y <= g.y + this.gateH(g)) {
        return g;
      }
    }
    return null;
  }

  /** Id of the wire whose curve passes closest to `world`, within tolerance. */
  private wireAt(world: Point): string | null {
    const tol = WIRE_HIT + 2 / this.scale;
    let best: string | null = null;
    let bestD = tol;
    for (const wire of this.engine.wires.values()) {
      const from = this.engine.getPin(wire.from);
      const to = this.engine.getPin(wire.to);
      if (!from || !to) continue;
      const d = this.distanceToWire(world, this.pinPos(from), this.pinPos(to));
      if (d < bestD) {
        bestD = d;
        best = wire.id;
      }
    }
    return best;
  }

  /** Gates whose body overlaps the given world-space rectangle. */
  private gatesInRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
    const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
    const hits: string[] = [];
    for (const g of this.engine.gates.values()) {
      const overlaps = g.x <= hi.x && g.x + GATE_W >= lo.x && g.y <= hi.y && g.y + this.gateH(g) >= lo.y;
      if (overlaps) hits.push(g.id);
    }
    return hits;
  }

  /* --------------------------------------------------------
     Pointer interaction
     -------------------------------------------------------- */

  private onPointerDown(e: PointerEvent): void {
    // Right-click is reserved for the context menu (handled in the DOM).
    if (e.button === 2) return;

    this.dirty = true;
    this.canvas.setPointerCapture(e.pointerId);
    const screen = this.eventPos(e);
    this.pointers.set(e.pointerId, screen);

    // Two fingers down → start a pinch (zoom + pan); ignore other gestures.
    if (this.pointers.size === 2) {
      this.beginPinch();
      return;
    }

    const world = this.toWorld(screen.x, screen.y);

    // Pan without Ctrl: middle mouse, held Space, or (still) Ctrl.
    if (e.button === 1 || this.spaceHeld || e.ctrlKey) {
      this.drag = { kind: "pan", startX: screen.x, startY: screen.y, panX: this.panX, panY: this.panY };
      return;
    }

    // Grabbing a pin starts a wire.
    const pin = this.pinAt(world);
    if (pin) {
      this.drag = { kind: "wire", fromPin: pin.id, cursor: world };
      return;
    }

    // Grabbing a gate body: select it, then start a (group) move.
    const gate = this.gateAt(world);
    if (gate) {
      this.selectedWire = null;
      if (e.shiftKey) {
        // Shift toggles membership without starting a move.
        if (this.selection.has(gate.id)) this.selection.delete(gate.id);
        else this.selection.add(gate.id);
        this.drag = { kind: "none" };
        return;
      }
      // Non-shift click on an unselected gate collapses selection to it.
      if (!this.selection.has(gate.id)) {
        this.selection.clear();
        this.selection.add(gate.id);
      }
      this.drag = { kind: "move", gateId: gate.id, prevX: world.x, prevY: world.y, moved: false };
      return;
    }

    // Empty canvas + armed component → drop a new gate, centred on cursor.
    if (this.armed) {
      this.beforeChange();
      const g = this.engine.addGate(
        this.armed,
        this.snap(world.x - GATE_W / 2),
        this.snap(world.y - GATE_H / 2),
      );
      this.selection.clear();
      this.selection.add(g.id);
      this.selectedWire = null;
      this.commit();
      this.drag = { kind: "none" };
      return;
    }

    // A wire under the cursor → select it.
    const wid = this.wireAt(world);
    if (wid) {
      this.selectedWire = wid;
      this.selection.clear();
      this.drag = { kind: "none" };
      return;
    }

    // Otherwise begin a marquee box-selection on the empty canvas.
    if (!e.shiftKey) {
      this.selection.clear();
      this.selectedWire = null;
    }
    this.drag = {
      kind: "marquee",
      startX: world.x,
      startY: world.y,
      curX: world.x,
      curY: world.y,
      additive: e.shiftKey,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    this.dirty = true; // hover/drag/pan/marquee visuals may all change
    const screen = this.eventPos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, screen);

    // A live pinch owns the gesture: update zoom + pan and bail.
    if (this.pinch && this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }

    const world = this.toWorld(screen.x, screen.y);
    this.hoverPin = this.pinAt(world);

    switch (this.drag.kind) {
      case "pan":
        this.panX = this.drag.panX + (screen.x - this.drag.startX);
        this.panY = this.drag.panY + (screen.y - this.drag.startY);
        break;
      case "move": {
        const dx = world.x - this.drag.prevX;
        const dy = world.y - this.drag.prevY;
        if (dx === 0 && dy === 0) break;
        // Snapshot once, on the first actual movement of this drag.
        if (!this.drag.moved) {
          this.beforeChange();
          this.drag.moved = true;
        }
        for (const id of this.selection) {
          const g = this.engine.gates.get(id);
          if (g) {
            g.x += dx;
            g.y += dy;
          }
        }
        this.drag.prevX = world.x;
        this.drag.prevY = world.y;
        break;
      }
      case "wire":
        this.drag.cursor = world;
        break;
      case "marquee":
        this.drag.curX = world.x;
        this.drag.curY = world.y;
        break;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.dirty = true;
    const screen = this.eventPos(e);
    const world = this.toWorld(screen.x, screen.y);

    if (this.drag.kind === "wire") {
      const target = this.pinAt(world);
      if (target && target.id !== this.drag.fromPin) {
        const a = this.engine.getPin(this.drag.fromPin);
        const b = this.engine.getPin(target.id);
        // Pre-validate so we only record history for a real connection.
        if (a && b && a.kind !== b.kind && a.gateId !== b.gateId) {
          const inputId = a.kind === "input" ? a.id : b.id;
          const replaced = this.isDriven(inputId);
          this.beforeChange();
          const wire = this.engine.connect(this.drag.fromPin, target.id);
          if (wire) {
            if (replaced) this.flashInput(inputId);
            this.commit();
          }
        }
      }
    } else if (this.drag.kind === "move") {
      if (this.drag.moved) {
        // Snap the moved gates to the grid on release (keeps drag itself smooth).
        if (this.snapEnabled) {
          for (const id of this.selection) {
            const g = this.engine.gates.get(id);
            if (g) {
              g.x = this.snap(g.x);
              g.y = this.snap(g.y);
            }
          }
        }
        // A real drag repositioned gates: nothing to re-evaluate, but persist.
        this.onEdit();
      } else {
        // A click (no drag) on a SWITCH body toggles it.
        const gate = this.engine.gates.get(this.drag.gateId);
        if (gate && gate.type === "SWITCH") {
          this.beforeChange();
          this.engine.toggleSwitch(gate.id);
          this.commit();
        }
      }
    } else if (this.drag.kind === "marquee") {
      const hits = this.gatesInRect(this.drag.startX, this.drag.startY, this.drag.curX, this.drag.curY);
      if (!this.drag.additive) this.selection.clear();
      for (const id of hits) this.selection.add(id);
      if (hits.length) this.selectedWire = null;
    }

    this.endPointer(e);
  }

  /** Release a pointer and tear down any pinch that can no longer continue. */
  private endPointer(e: PointerEvent): void {
    this.dirty = true;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.drag = { kind: "none" };
  }

  /* ---------- Pinch zoom/pan (two pointers) ---------- */

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: this.scale,
      anchor: this.toWorld(mid.x, mid.y),
    };
    this.drag = { kind: "none" }; // cancel any single-pointer gesture
  }

  private updatePinch(): void {
    if (!this.pinch) return;
    const [a, b] = [...this.pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;

    this.scale = clamp(this.pinch.startScale * (dist / this.pinch.startDist), MIN_SCALE, MAX_SCALE);
    // Keep the anchor world-point under the moving finger midpoint.
    this.panX = mid.x - this.pinch.anchor.x * this.scale;
    this.panY = mid.y - this.pinch.anchor.y * this.scale;
  }

  /**
   * Wheel handling (no Ctrl required for panning):
   *   • Ctrl / trackpad-pinch → zoom around the cursor.
   *   • plain wheel / two-finger scroll → pan.
   */
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.dirty = true;
    const screen = this.eventPos(e);

    if (e.ctrlKey) {
      const before = this.toWorld(screen.x, screen.y);
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
      // Re-anchor pan so `before` stays under the cursor after zooming.
      this.panX = screen.x - before.x * this.scale;
      this.panY = screen.y - before.y * this.scale;
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
    }
  }

  /* --------------------------------------------------------
     Public selection / editing API (driven by keyboard in main)
     -------------------------------------------------------- */

  /** True when something (gate(s) or a wire) is selected. */
  get hasSelection(): boolean {
    return this.selection.size > 0 || this.selectedWire !== null;
  }

  clearSelection(): void {
    this.selection.clear();
    this.selectedWire = null;
    this.dirty = true;
  }

  selectAll(): void {
    this.selection = new Set(this.engine.gates.keys());
    this.selectedWire = null;
    this.dirty = true;
  }

  /* ---------- View options ---------- */

  setSnap(on: boolean): void {
    this.snapEnabled = on;
  }

  setMinimap(on: boolean): void {
    this.minimapOn = on;
    this.dirty = true;
  }

  /** Swap the logic-high accent to a colorblind-safe amber (vs. green). */
  setColorblind(on: boolean): void {
    this.powerColor = on ? "#f0a020" : "#10b981";
    this.powerGlow = on ? "rgba(240, 160, 32, 0.45)" : "rgba(16, 185, 129, 0.4)";
    this.dirty = true;
  }

  /** Blur radius for decorative glow, or 0 under prefers-reduced-motion. */
  private glow(blur: number): number {
    return this.reducedMotion ? 0 : blur;
  }

  /** Reset the camera to frame all content (or reset to origin when empty). */
  fitView(): void {
    const gates = [...this.engine.gates.values()];
    this.dirty = true;
    if (!gates.length) {
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const g of gates) {
      minX = Math.min(minX, g.x);
      minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + GATE_W);
      maxY = Math.max(maxY, g.y + this.gateH(g));
    }

    const pad = 60;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;

    this.scale = clamp(Math.min(w / contentW, h / contentH), MIN_SCALE, MAX_SCALE);
    // Centre the content bounding box in the viewport.
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.panX = w / 2 - cx * this.scale;
    this.panY = h / 2 - cy * this.scale;
    this.dirty = true;
  }

  /* ---------- Context-menu support ---------- */

  /**
   * Select whatever is under the given client point for a context menu, and
   * report what kind of target it is. A gate/wire click updates the selection
   * (unless the gate is already part of a multi-selection).
   */
  pickForContext(clientX: number, clientY: number): "gate" | "wire" | "empty" {
    this.dirty = true;
    const world = this.clientToWorld(clientX, clientY);
    const gate = this.gateAt(world);
    if (gate) {
      this.selectedWire = null;
      if (!this.selection.has(gate.id)) {
        this.selection.clear();
        this.selection.add(gate.id);
      }
      return "gate";
    }
    const wid = this.wireAt(world);
    if (wid) {
      this.selection.clear();
      this.selectedWire = wid;
      return "wire";
    }
    return "empty";
  }

  /** The single selected gate, or null if zero/many are selected. */
  soleSelectedGate(): Gate | null {
    if (this.selection.size !== 1) return null;
    const [id] = this.selection;
    return this.engine.gates.get(id) ?? null;
  }

  /** Any selected gate supports a variable number of inputs. */
  hasVariableInputSelection(): boolean {
    for (const id of this.selection) {
      const g = this.engine.gates.get(id);
      if (g && supportsVariableInputs(g.type)) return true;
    }
    return false;
  }

  /** Apply a label to every selected gate (blank clears it). */
  renameSelection(label: string): void {
    if (!this.selection.size) return;
    this.beforeChange();
    for (const id of this.selection) this.engine.setLabel(id, label);
    this.dirty = true;
    this.onEdit();
  }

  /* --------------------------------------------------------
     Keyboard operation & accessibility
     -------------------------------------------------------- */

  private gateCenter(g: Gate): Point {
    return { x: g.x + GATE_W / 2, y: g.y + this.gateH(g) / 2 };
  }

  /**
   * Move the selection to the nearest gate in a compass direction (or the
   * first gate when nothing is selected). Returns the newly selected gate.
   */
  navigate(dir: "left" | "right" | "up" | "down"): Gate | null {
    const gates = [...this.engine.gates.values()];
    if (!gates.length) return null;

    const current = this.soleSelectedGate();
    let target: Gate | null = current;

    if (!current) {
      target = gates[0];
    } else {
      const c = this.gateCenter(current);
      let best = Infinity;
      for (const g of gates) {
        if (g.id === current.id) continue;
        const gc = this.gateCenter(g);
        const dx = gc.x - c.x;
        const dy = gc.y - c.y;
        const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
        if (along <= 0) continue; // not in the requested direction
        const cross = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
        const score = along + cross * 2; // prefer straight-ahead over diagonal
        if (score < best) {
          best = score;
          target = g;
        }
      }
    }

    if (target) {
      this.selection.clear();
      this.selection.add(target.id);
      this.selectedWire = null;
      this.dirty = true;
    }
    return target;
  }

  /** Nudge the selected gates one grid step in a direction (keyboard move). */
  nudgeSelection(dir: "left" | "right" | "up" | "down"): void {
    if (!this.selection.size) return;
    this.dirty = true;
    const step = this.snapEnabled ? GRID : 8;
    const dx = dir === "left" ? -step : dir === "right" ? step : 0;
    const dy = dir === "up" ? -step : dir === "down" ? step : 0;
    this.beforeChange();
    for (const id of this.selection) {
      const g = this.engine.gates.get(id);
      if (g) {
        g.x += dx;
        g.y += dy;
      }
    }
    this.onEdit();
  }

  /** Drop the armed component at the viewport centre (keyboard placement). */
  placeArmedAtCenter(): Gate | null {
    if (!this.armed) return null;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const world = this.toWorld(w / 2, h / 2);
    this.beforeChange();
    const g = this.engine.addGate(
      this.armed,
      this.snap(world.x - GATE_W / 2),
      this.snap(world.y - GATE_H / 2),
    );
    this.selection.clear();
    this.selection.add(g.id);
    this.selectedWire = null;
    this.commit();
    return g;
  }

  /** Toggle the selected SWITCH via keyboard. Returns true if it toggled. */
  toggleSelectedSwitch(): boolean {
    const g = this.soleSelectedGate();
    if (g && g.type === "SWITCH") {
      this.beforeChange();
      this.engine.toggleSwitch(g.id);
      this.commit();
      return true;
    }
    return false;
  }

  isKeyboardWiring(): boolean {
    return this.kbWireFrom !== null;
  }

  cancelKeyboardWire(): void {
    this.kbWireFrom = null;
    this.dirty = true;
  }

  /**
   * Two-step keyboard wiring: the first call arms the selected gate's output;
   * the second connects it to the newly selected gate's first free input.
   */
  keyboardWireStep(): "started" | "connected" | "invalid" | "none" {
    this.dirty = true;
    const g = this.soleSelectedGate();
    if (!g) return "none";

    if (this.kbWireFrom === null) {
      if (!g.outputs.length) return "invalid";
      this.kbWireFrom = g.outputs[0].id;
      return "started";
    }

    const fromPin = this.engine.getPin(this.kbWireFrom);
    this.kbWireFrom = null;
    if (!fromPin || fromPin.gateId === g.id || !g.inputs.length) return "invalid";

    const driven = new Set<string>();
    for (const w of this.engine.wires.values()) driven.add(w.to);
    const target = g.inputs.find((p) => !driven.has(p.id)) ?? g.inputs[0];
    const replaced = driven.has(target.id);

    this.beforeChange();
    const wire = this.engine.connect(fromPin.id, target.id);
    if (wire) {
      if (replaced) this.flashInput(target.id);
      this.commit();
      return "connected";
    }
    return "invalid";
  }

  /** One-line, screen-reader-friendly description of a gate. */
  describeGate(g: Gate): string {
    const kind = GATE_LABEL[g.type];
    const name = g.label ? `${g.label}: ` : "";
    let state: string;
    if (g.type === "SWITCH" || g.type === "CLOCK") state = g.state ? ", on" : ", off";
    else if (g.type === "LED") state = g.state ? ", lit" : ", unlit";
    else if (g.type === "HIGH") state = ", high";
    else if (g.type === "LOW") state = ", low";
    else state = g.outputs.some((o) => o.value) ? ", output high" : ", output low";
    return `${name}${kind}${state}`;
  }

  /** A full text outline of the circuit — the accessible alternative view. */
  outlineText(): string {
    const gates = [...this.engine.gates.values()];
    if (!gates.length) return "The canvas is empty.";

    const num = new Map<string, number>();
    gates.forEach((g, i) => num.set(g.id, i + 1));

    const lines: string[] = [`${gates.length} component(s):`];
    for (const g of gates) lines.push(`${num.get(g.id)}. ${this.describeGate(g)}`);

    const wires = [...this.engine.wires.values()];
    if (wires.length) {
      lines.push(`${wires.length} connection(s):`);
      for (const w of wires) {
        const from = this.engine.getPin(w.from);
        const to = this.engine.getPin(w.to);
        if (!from || !to) continue;
        const fg = this.engine.gates.get(from.gateId);
        const tg = this.engine.gates.get(to.gateId);
        if (!fg || !tg) continue;
        lines.push(
          `  #${num.get(fg.id)} ${GATE_LABEL[fg.type]} → #${num.get(tg.id)} ${GATE_LABEL[tg.type]} input ${to.index + 1}`,
        );
      }
    }
    return lines.join("\n");
  }

  /** Delete the current selection (gates and/or the selected wire). */
  deleteSelection(): void {
    if (!this.hasSelection) return;
    this.beforeChange();
    if (this.selectedWire) {
      this.engine.removeWire(this.selectedWire);
      this.selectedWire = null;
    }
    for (const id of this.selection) this.engine.removeGate(id);
    this.selection.clear();
    this.commit();
  }

  /** Copy selected gates (and internal wiring) to the clipboard. */
  copy(): void {
    if (!this.selection.size) return;
    this.clipboard = this.buildClip(this.selection);
    this.pasteSerial = 0;
  }

  /** Paste the clipboard, cascading each paste slightly so copies don't stack. */
  paste(): void {
    if (!this.clipboard || !this.clipboard.gates.length) return;
    this.beforeChange();
    this.pasteSerial += 1;
    const off = 24 * this.pasteSerial;
    this.instantiate(this.clipboard, off, off);
    this.commit();
  }

  /** Duplicate the current selection in place (independent of the clipboard). */
  duplicate(): void {
    if (!this.selection.size) return;
    const clip = this.buildClip(this.selection);
    this.beforeChange();
    this.instantiate(clip, 24, 24);
    this.commit();
  }

  /** Add an input pin to every selected variable-arity gate. */
  addInputToSelection(): void {
    const targets = this.variableInputTargets((g) => g.inputs.length < MAX_INPUTS);
    if (!targets.length) return;
    this.beforeChange();
    let changed = false;
    for (const id of targets) changed = this.engine.addInput(id) || changed;
    if (changed) this.commit();
  }

  /** Remove an input pin from every selected variable-arity gate. */
  removeInputFromSelection(): void {
    const targets = this.variableInputTargets((g) => g.inputs.length > MIN_INPUTS);
    if (!targets.length) return;
    this.beforeChange();
    let changed = false;
    for (const id of targets) changed = this.engine.removeInput(id) || changed;
    if (changed) this.commit();
  }

  /** Selected gates that support variable inputs and pass `roomFor`. */
  private variableInputTargets(roomFor: (g: Gate) => boolean): string[] {
    return [...this.selection].filter((id) => {
      const g = this.engine.gates.get(id);
      return !!g && supportsVariableInputs(g.type) && roomFor(g);
    });
  }

  /** Snapshot a set of gates plus any wires wholly contained within them. */
  private buildClip(ids: Set<string>): Clip {
    const gates: Clip["gates"] = [];
    for (const id of ids) {
      const g = this.engine.gates.get(id);
      if (g) gates.push({ oldId: id, type: g.type, x: g.x, y: g.y, state: g.state, label: g.label });
    }
    const wires: Clip["wires"] = [];
    for (const w of this.engine.wires.values()) {
      const from = this.engine.getPin(w.from);
      const to = this.engine.getPin(w.to);
      if (from && to && ids.has(from.gateId) && ids.has(to.gateId)) {
        wires.push({ from: w.from, to: w.to });
      }
    }
    return { gates, wires };
  }

  /** Materialise a clip into the engine at an offset, selecting the copies. */
  private instantiate(clip: Clip, dx: number, dy: number): void {
    const idMap = new Map<string, string>(); // old gate id → new gate id
    const created = new Set<string>();

    for (const g of clip.gates) {
      const ng = this.engine.addGate(g.type, g.x + dx, g.y + dy);
      ng.state = g.state;
      ng.label = g.label;
      idMap.set(g.oldId, ng.id);
      created.add(ng.id);
    }
    for (const w of clip.wires) {
      const from = this.remapPin(w.from, idMap);
      const to = this.remapPin(w.to, idMap);
      if (from && to) this.engine.connect(from, to);
    }

    this.selection = created;
    this.selectedWire = null;
  }

  /** Rewrite a pin id (`gate:kind:index`) to point at the remapped gate. */
  private remapPin(pinId: string, idMap: Map<string, string>): string | null {
    const [oldGate, kind, index] = pinId.split(":");
    const newGate = idMap.get(oldGate);
    return newGate ? `${newGate}:${kind}:${index}` : null;
  }

  /* --------------------------------------------------------
     Rendering (one requestAnimationFrame cycle)
     -------------------------------------------------------- */

  /** True while something is visibly moving and needs continuous redraws. */
  private isAnimating(): boolean {
    return this.drag.kind !== "none" || this.pinch !== null || this.flashUntil > performance.now();
  }

  /** The rAF loop: draw only when dirty or animating, to spare CPU when idle. */
  private frame(): void {
    if (this.dirty || this.isAnimating()) {
      this.dirty = false;
      this.render();
    }
    requestAnimationFrame(() => this.frame());
  }

  private render(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.drawGrid();

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    // An input with no incoming wire is "floating" (reads low) — drawn amber.
    this.drivenInputs.clear();
    for (const w of this.engine.wires.values()) this.drivenInputs.add(w.to);

    this.drawWires();
    this.drawActiveWire();
    for (const gate of this.engine.gates.values()) this.drawGate(gate);
    this.drawMarquee();

    ctx.restore();

    // Minimap is drawn in screen space, on top of everything.
    this.drawMinimap();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const step = 28 * this.scale;
    if (step < 6) return;

    const ox = ((this.panX % step) + step) % step;
    const oy = ((this.panY % step) + step) % step;

    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox; x < w; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = oy; y < h; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }

  private drawWires(): void {
    for (const wire of this.engine.wires.values()) {
      const from = this.engine.getPin(wire.from);
      const to = this.engine.getPin(wire.to);
      if (!from || !to) continue;
      const a = this.pinPos(from);
      const b = this.pinPos(to);
      if (this.selectedWire === wire.id) this.wireHighlight(a, b);
      this.bezier(a, b, from.value ? "var" : "off");
    }
  }

  private drawActiveWire(): void {
    if (this.drag.kind !== "wire") return;
    const pin = this.engine.getPin(this.drag.fromPin);
    if (!pin) return;
    const a = this.pinPos(pin);
    this.bezier(a, this.drag.cursor, "drag");
  }

  /** Bezier control offset shared by drawing + hit-testing. */
  private wireCtrl(a: Point, b: Point): number {
    return Math.max(40, Math.abs(b.x - a.x) * 0.5);
  }

  /** Bezier-curved link between two points. */
  private bezier(a: Point, b: Point, style: "var" | "off" | "drag"): void {
    const ctx = this.ctx;
    const dx = this.wireCtrl(a, b);

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(a.x + dx, a.y, b.x - dx, b.y, b.x, b.y);

    if (style === "var") {
      ctx.strokeStyle = this.powerColor;
      ctx.lineWidth = 3;
      ctx.shadowColor = this.powerGlow;
      ctx.shadowBlur = this.glow(8);
    } else if (style === "drag") {
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 5]);
    } else {
      ctx.strokeStyle = PALETTE.wireOff;
      ctx.lineWidth = 2.5;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
  }

  /** A translucent halo drawn under a selected wire. */
  private wireHighlight(a: Point, b: Point): void {
    const ctx = this.ctx;
    const dx = this.wireCtrl(a, b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(a.x + dx, a.y, b.x - dx, b.y, b.x, b.y);
    ctx.strokeStyle = PALETTE.wireHighlight;
    ctx.lineWidth = 8;
    ctx.stroke();
  }

  private drawGate(gate: Gate): void {
    const ctx = this.ctx;
    const powered = this.isGateLive(gate);
    const h = this.gateH(gate);
    const cx = gate.x + GATE_W / 2;
    const cy = gate.y + h / 2;

    // Selection ring (drawn behind the body).
    if (this.selection.has(gate.id)) {
      ctx.beginPath();
      ctx.roundRect(gate.x - 4, gate.y - 4, GATE_W + 8, h + 8, 14);
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Body
    ctx.beginPath();
    ctx.roundRect(gate.x, gate.y, GATE_W, h, 12);
    ctx.fillStyle = PALETTE.gateFill;
    ctx.fill();

    if (powered) {
      ctx.strokeStyle = this.powerColor;
      ctx.lineWidth = 2;
      ctx.shadowColor = this.powerGlow;
      ctx.shadowBlur = this.glow(14);
    } else {
      ctx.strokeStyle = PALETTE.gateStroke;
      ctx.lineWidth = 1.5;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Label
    ctx.fillStyle = powered ? PALETTE.labelLive : PALETTE.labelIdle;
    ctx.font = "600 13px Poppins, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(GATE_LABEL[gate.type], cx, cy - 8);

    // Per-type embellishment
    if (gate.type === "SWITCH" || gate.type === "CLOCK") {
      ctx.fillStyle = gate.state ? this.powerColor : PALETTE.offText;
      ctx.font = "700 12px Poppins, system-ui, sans-serif";
      ctx.fillText(gate.state ? "ON" : "OFF", cx, cy + 12);
    } else if (gate.type === "HIGH" || gate.type === "LOW") {
      const on = gate.type === "HIGH";
      ctx.fillStyle = on ? this.powerColor : PALETTE.offText;
      ctx.font = "700 13px Poppins, system-ui, sans-serif";
      ctx.fillText(on ? "1" : "0", cx, cy + 12);
    } else if (gate.type === "LED") {
      ctx.beginPath();
      ctx.arc(cx, cy + 12, 6, 0, Math.PI * 2);
      ctx.fillStyle = gate.state ? this.powerColor : PALETTE.ledOff;
      if (gate.state) {
        ctx.shadowColor = this.powerGlow;
        ctx.shadowBlur = this.glow(12);
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // User label (drawn above the gate body)
    if (gate.label) {
      ctx.fillStyle = PALETTE.userLabel;
      ctx.font = "600 12px Poppins, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(gate.label, cx, gate.y - 8);
    }

    // Pins
    for (const pin of [...gate.inputs, ...gate.outputs]) this.drawPin(pin);
  }

  private drawPin(pin: Pin): void {
    const ctx = this.ctx;
    const p = this.pinPos(pin);
    const hovered = this.hoverPin?.id === pin.id;
    const floating = pin.kind === "input" && !this.drivenInputs.has(pin.id);

    // Pending keyboard-wire source: a steady accent halo.
    if (this.kbWireFrom === pin.id) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, PIN_R + 5, 0, Math.PI * 2);
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Replaced-connection flash: a fading red ring for ~half a second.
    if (this.flashPin === pin.id) {
      const remaining = this.flashUntil - performance.now();
      if (remaining > 0) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, PIN_R + 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239, 71, 87, ${(remaining / 500).toFixed(3)})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, hovered ? PIN_R + 2 : PIN_R, 0, Math.PI * 2);
    if (floating) {
      // Undriven input: hollow amber ring, signalling "not connected".
      ctx.fillStyle = PALETTE.floatFill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = hovered ? PALETTE.accent : PALETTE.floatRing;
      ctx.stroke();
      return;
    }
    ctx.fillStyle = pin.value ? this.powerColor : PALETTE.pinOff;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hovered ? PALETTE.accent : PALETTE.pinOutline;
    ctx.stroke();
  }

  private drawMarquee(): void {
    if (this.drag.kind !== "marquee") return;
    const ctx = this.ctx;
    const x = Math.min(this.drag.startX, this.drag.curX);
    const y = Math.min(this.drag.startY, this.drag.curY);
    const w = Math.abs(this.drag.curX - this.drag.startX);
    const h = Math.abs(this.drag.curY - this.drag.startY);
    ctx.fillStyle = PALETTE.marqueeFill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = PALETTE.marqueeStroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  /** A gate is "live" when it is emitting a high signal (or lit LED). */
  private isGateLive(gate: Gate): boolean {
    if (gate.type === "LED") return gate.state;
    return gate.outputs.some((o) => o.value);
  }

  /**
   * A small overview in the bottom-right corner: every gate as a dot plus the
   * current viewport rectangle. Drawn in screen space (after the world
   * transform is restored). Non-interactive.
   */
  private drawMinimap(): void {
    if (!this.minimapOn || this.engine.gates.size === 0) return;
    const ctx = this.ctx;

    // Content bounds in world space.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const g of this.engine.gates.values()) {
      minX = Math.min(minX, g.x);
      minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + GATE_W);
      maxY = Math.max(maxY, g.y + this.gateH(g));
    }

    const screenW = this.canvas.width / this.dpr;
    const screenH = this.canvas.height / this.dpr;
    // Include the current viewport so the indicator stays in view when panned away.
    const viewMin = this.toWorld(0, 0);
    const viewMax = this.toWorld(screenW, screenH);
    minX = Math.min(minX, viewMin.x);
    minY = Math.min(minY, viewMin.y);
    maxX = Math.max(maxX, viewMax.x);
    maxY = Math.max(maxY, viewMax.y);

    const mmW = 168;
    const mmH = 112;
    const margin = 16;
    const box = { x: screenW - mmW - margin, y: screenH - mmH - margin };
    const pad = 8;

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const s = Math.min((mmW - pad * 2) / spanX, (mmH - pad * 2) / spanY);
    const toMM = (wx: number, wy: number): Point => ({
      x: box.x + pad + (wx - minX) * s,
      y: box.y + pad + (wy - minY) * s,
    });

    // Panel background.
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, mmW, mmH, 10);
    ctx.fillStyle = PALETTE.mmBg;
    ctx.fill();
    ctx.strokeStyle = PALETTE.mmStroke;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Gates.
    for (const g of this.engine.gates.values()) {
      const p = toMM(g.x, g.y);
      const w = GATE_W * s;
      const hgt = this.gateH(g) * s;
      ctx.fillStyle = this.isGateLive(g) ? this.powerColor : PALETTE.mmGateOff;
      ctx.fillRect(p.x, p.y, Math.max(2, w), Math.max(2, hgt));
    }

    // Current viewport rectangle.
    const a = toMM(viewMin.x, viewMin.y);
    const b = toMM(viewMax.x, viewMax.y);
    ctx.strokeStyle = PALETTE.marqueeStroke;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }

  /* --------------------------------------------------------
     Geometry: distance from a point to a wire's bezier curve
     -------------------------------------------------------- */

  private distanceToWire(p: Point, a: Point, b: Point): number {
    const dx = this.wireCtrl(a, b);
    const c1 = { x: a.x + dx, y: a.y };
    const c2 = { x: b.x - dx, y: b.y };
    const N = 24;
    let prev = a;
    let best = Infinity;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const cur = this.cubic(a, c1, c2, b, t);
      best = Math.min(best, this.pointToSegment(p, prev, cur));
      prev = cur;
    }
    return best;
  }

  private cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
  }

  private pointToSegment(p: Point, a: Point, b: Point): number {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * vx;
    const cy = a.y + t * vy;
    return Math.hypot(p.x - cx, p.y - cy);
  }
}
