/* ============================================================
   engine.ts — strongly-typed logic-circuit simulation core.

   The engine is intentionally decoupled from any rendering: it
   owns the data model (Gates, Pins, Wires) and knows how to
   settle logic values across the graph via an iterative
   propagation loop.
   ============================================================ */

/** Every kind of component the simulator understands. */
export type GateType =
  "SWITCH" | "HIGH" | "LOW" | "CLOCK" | "NOT" | "AND" | "OR" | "NAND" | "NOR" | "XOR" | "XNOR" | "LED";

/** A pin is either a consumer (input) or a producer (output) of a signal. */
export type PinKind = "input" | "output";

/** A single connection point on a gate. */
export interface Pin {
  /** Stable id, unique within the whole circuit. */
  id: string;
  /** Owning gate id. */
  gateId: string;
  kind: PinKind;
  /** Position of this pin among its siblings of the same kind. */
  index: number;
  /** Current settled logic level. */
  value: boolean;
}

/** A component instance living on the canvas. */
export interface Gate {
  id: string;
  type: GateType;
  /** World-space top-left position. */
  x: number;
  y: number;
  inputs: Pin[];
  outputs: Pin[];
  /**
   * Interactive state used by SWITCH (on/off) and mirrored by LED
   * (lit/unlit). Ignored by pure logic gates.
   */
  state: boolean;
  /** Optional user-facing name (e.g. "A", "Sum") drawn above the gate. */
  label?: string;
}

/** A directed link from an output pin to an input pin. */
export interface Wire {
  id: string;
  from: string; // output pin id
  to: string; // input pin id
}

/** Plain, serialisable snapshot of a circuit (used for save/load). */
export interface CircuitSnapshot {
  version: 1;
  gates: Array<{
    id: string;
    type: GateType;
    x: number;
    y: number;
    state: boolean;
    /** Input-pin count; omitted for older files (defaults to the type's shape). */
    inputs?: number;
    /** Optional display label. */
    label?: string;
  }>;
  wires: Array<{ id: string; from: string; to: string }>;
}

/** How many pins each gate type exposes by default. */
const PIN_SHAPE: Record<GateType, { inputs: number; outputs: number }> = {
  SWITCH: { inputs: 0, outputs: 1 },
  HIGH: { inputs: 0, outputs: 1 },
  LOW: { inputs: 0, outputs: 1 },
  CLOCK: { inputs: 0, outputs: 1 },
  NOT: { inputs: 1, outputs: 1 },
  AND: { inputs: 2, outputs: 1 },
  OR: { inputs: 2, outputs: 1 },
  NAND: { inputs: 2, outputs: 1 },
  NOR: { inputs: 2, outputs: 1 },
  XOR: { inputs: 2, outputs: 1 },
  XNOR: { inputs: 2, outputs: 1 },
  LED: { inputs: 1, outputs: 0 },
};

/** Gate types whose input count can be grown/shrunk by the user. */
const MULTI_INPUT: ReadonlySet<GateType> = new Set<GateType>(["AND", "OR", "NAND", "NOR", "XOR", "XNOR"]);

export const MIN_INPUTS = 2;
export const MAX_INPUTS = 8;

/** Can this gate type have inputs added/removed? */
export function supportsVariableInputs(type: GateType): boolean {
  return MULTI_INPUT.has(type);
}

/** Runtime guard: is `t` a component type this build understands? */
export function isGateType(t: unknown): t is GateType {
  return typeof t === "string" && t in PIN_SHAPE;
}

let idCounter = 0;
/** Monotonic id generator, prefixed for readability while debugging. */
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}`;
}

export class Engine {
  readonly gates = new Map<string, Gate>();
  readonly wires = new Map<string, Wire>();
  /** Fast pin lookup by id, rebuilt as gates are added/removed. */
  private readonly pins = new Map<string, Pin>();

  /** Create a gate of the given type at a world position. */
  addGate(type: GateType, x: number, y: number): Gate {
    const shape = PIN_SHAPE[type];
    const id = nextId("g");
    const gate: Gate = { id, type, x, y, inputs: [], outputs: [], state: false };

    for (let i = 0; i < shape.inputs; i++) {
      const pin: Pin = { id: `${id}:in:${i}`, gateId: id, kind: "input", index: i, value: false };
      gate.inputs.push(pin);
      this.pins.set(pin.id, pin);
    }
    for (let i = 0; i < shape.outputs; i++) {
      const pin: Pin = { id: `${id}:out:${i}`, gateId: id, kind: "output", index: i, value: false };
      gate.outputs.push(pin);
      this.pins.set(pin.id, pin);
    }

    this.gates.set(id, gate);
    return gate;
  }

  /** Remove a gate and any wires touching it. */
  removeGate(gateId: string): void {
    const gate = this.gates.get(gateId);
    if (!gate) return;

    // Collect this gate's pins, then drop any wire touching one of them.
    const pinIds = new Set<string>();
    for (const pin of [...gate.inputs, ...gate.outputs]) pinIds.add(pin.id);

    for (const [wid, w] of this.wires) {
      if (pinIds.has(w.from) || pinIds.has(w.to)) this.wires.delete(wid);
    }
    for (const id of pinIds) this.pins.delete(id);
    this.gates.delete(gateId);
  }

  /** Remove a single wire by id (no-op if it doesn't exist). */
  removeWire(wireId: string): void {
    this.wires.delete(wireId);
  }

  getPin(pinId: string): Pin | undefined {
    return this.pins.get(pinId);
  }

  /**
   * Try to connect two pins. Order-independent: one must be an
   * output and the other an input. Returns the new wire, or null
   * if the connection is invalid or a duplicate.
   */
  connect(pinA: string, pinB: string): Wire | null {
    const a = this.pins.get(pinA);
    const b = this.pins.get(pinB);
    if (!a || !b) return null;
    if (a.kind === b.kind) return null; // must be output → input
    if (a.gateId === b.gateId) return null; // no self-loops on one gate

    const from = a.kind === "output" ? a : b;
    const to = a.kind === "input" ? a : b;

    // An input pin only accepts a single driver; replace any existing wire.
    for (const [wid, w] of this.wires) {
      if (w.to === to.id) this.wires.delete(wid);
    }

    const wire: Wire = { id: nextId("w"), from: from.id, to: to.id };
    this.wires.set(wire.id, wire);
    return wire;
  }

  /** Toggle a SWITCH's on/off state (no-op for other gates). */
  toggleSwitch(gateId: string): void {
    const gate = this.gates.get(gateId);
    if (gate && gate.type === "SWITCH") gate.state = !gate.state;
  }

  /** Set (or clear, when blank) a gate's display label. */
  setLabel(gateId: string, label: string): void {
    const gate = this.gates.get(gateId);
    if (!gate) return;
    const trimmed = label.trim();
    gate.label = trimmed ? trimmed : undefined;
  }

  /**
   * Append an input pin to a variable-arity gate. Returns true if a pin
   * was added (false if the type is fixed or already at the maximum).
   */
  addInput(gateId: string): boolean {
    const gate = this.gates.get(gateId);
    if (!gate || !MULTI_INPUT.has(gate.type)) return false;
    if (gate.inputs.length >= MAX_INPUTS) return false;

    const i = gate.inputs.length;
    const pin: Pin = { id: `${gateId}:in:${i}`, gateId, kind: "input", index: i, value: false };
    gate.inputs.push(pin);
    this.pins.set(pin.id, pin);
    return true;
  }

  /**
   * Remove the last input pin from a variable-arity gate, dropping any
   * wire feeding it. Returns true if a pin was removed.
   */
  removeInput(gateId: string): boolean {
    const gate = this.gates.get(gateId);
    if (!gate || !MULTI_INPUT.has(gate.type)) return false;
    if (gate.inputs.length <= MIN_INPUTS) return false;

    const pin = gate.inputs.pop()!;
    this.pins.delete(pin.id);
    for (const [wid, w] of this.wires) {
      if (w.to === pin.id) this.wires.delete(wid);
    }
    return true;
  }

  /**
   * Advance every CLOCK by one half-period (flip its state). Returns true
   * if at least one clock exists, so callers know a re-evaluation is due.
   */
  tickClocks(): boolean {
    let any = false;
    for (const gate of this.gates.values()) {
      if (gate.type === "CLOCK") {
        gate.state = !gate.state;
        any = true;
      }
    }
    return any;
  }

  clear(): void {
    this.gates.clear();
    this.wires.clear();
    this.pins.clear();
  }

  /* --------------------------------------------------------
     Simulation
     -------------------------------------------------------- */

  /**
   * Settle the whole circuit. We repeatedly (1) reset input pins,
   * (2) push driver values along wires, then (3) recompute each
   * gate's outputs — looping until nothing changes or we hit the
   * iteration ceiling (which guards against oscillating loops).
   *
   * Returns `true` if the circuit reached a stable fixed point, or
   * `false` if it was still changing at the iteration ceiling
   * (i.e. it is oscillating / unstable — e.g. a bare inverter loop).
   */
  evaluate(maxIterations = 64): boolean {
    for (let iter = 0; iter < maxIterations; iter++) {
      // (1) Clear inputs — an unconnected input reads as logic-low.
      for (const pin of this.pins.values()) {
        if (pin.kind === "input") pin.value = false;
      }

      // (2) Propagate: an input becomes high if any driver is high.
      for (const wire of this.wires.values()) {
        const src = this.pins.get(wire.from);
        const dst = this.pins.get(wire.to);
        if (src && dst) dst.value = dst.value || src.value;
      }

      // (3) Recompute outputs from the freshly propagated inputs.
      let changed = false;
      for (const gate of this.gates.values()) {
        changed = this.computeGate(gate) || changed;
      }

      if (!changed) return true; // reached a stable fixed point
    }
    return false; // never settled within the ceiling → unstable
  }

  /** Apply a gate's truth logic. Returns true if any output flipped. */
  private computeGate(gate: Gate): boolean {
    // LEDs have no output; they mirror their input into `state`.
    if (gate.type === "LED") {
      const next = gate.inputs[0].value;
      const changed = gate.state !== next;
      gate.state = next;
      return changed;
    }

    const out = gate.outputs[0];
    const highCount = gate.inputs.reduce((n, p) => n + (p.value ? 1 : 0), 0);
    let next: boolean;

    switch (gate.type) {
      case "SWITCH":
      case "CLOCK":
        next = gate.state;
        break;
      case "HIGH":
        next = true;
        break;
      case "LOW":
        next = false;
        break;
      case "NOT":
        next = !gate.inputs[0].value;
        break;
      case "AND":
        next = highCount === gate.inputs.length;
        break;
      case "OR":
        next = highCount > 0;
        break;
      case "NAND":
        next = highCount !== gate.inputs.length;
        break;
      case "NOR":
        next = highCount === 0;
        break;
      case "XOR":
        next = highCount % 2 === 1;
        break;
      case "XNOR":
        next = highCount % 2 === 0;
        break;
    }

    const changed = out.value !== next;
    out.value = next;
    return changed;
  }

  /* --------------------------------------------------------
     Serialisation
     -------------------------------------------------------- */

  toSnapshot(): CircuitSnapshot {
    return {
      version: 1,
      gates: [...this.gates.values()].map((g) => ({
        id: g.id,
        type: g.type,
        x: g.x,
        y: g.y,
        state: g.state,
        inputs: g.inputs.length,
        label: g.label,
      })),
      wires: [...this.wires.values()].map((w) => ({ id: w.id, from: w.from, to: w.to })),
    };
  }

  /** Replace the current circuit with a loaded snapshot. */
  loadSnapshot(snap: CircuitSnapshot): void {
    this.clear();
    if (!snap || snap.version !== 1) throw new Error("Unsupported circuit file.");

    for (const g of snap.gates) {
      const shape = PIN_SHAPE[g.type];
      if (!shape) continue; // skip unknown component types defensively
      const gate: Gate = {
        id: g.id,
        type: g.type,
        x: g.x,
        y: g.y,
        inputs: [],
        outputs: [],
        state: g.state,
        label: g.label,
      };
      // Variable-arity gates honour the saved count (clamped); others use the shape.
      const inputCount = MULTI_INPUT.has(g.type)
        ? Math.min(MAX_INPUTS, Math.max(MIN_INPUTS, g.inputs ?? shape.inputs))
        : shape.inputs;
      for (let i = 0; i < inputCount; i++) {
        const pin: Pin = { id: `${g.id}:in:${i}`, gateId: g.id, kind: "input", index: i, value: false };
        gate.inputs.push(pin);
        this.pins.set(pin.id, pin);
      }
      for (let i = 0; i < shape.outputs; i++) {
        const pin: Pin = { id: `${g.id}:out:${i}`, gateId: g.id, kind: "output", index: i, value: false };
        gate.outputs.push(pin);
        this.pins.set(pin.id, pin);
      }
      this.gates.set(g.id, gate);
    }

    for (const w of snap.wires) {
      if (this.pins.has(w.from) && this.pins.has(w.to)) {
        this.wires.set(w.id, { id: w.id, from: w.from, to: w.to });
      }
    }
  }
}
