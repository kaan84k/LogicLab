/* ============================================================
   engine.test.ts — unit tests for the simulation core.

   Uses Node's built-in test runner (no dependencies):
     npm test   →   tsc -p tsconfig.test.json && node --test
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, GateType, isGateType } from "../src/engine.js";

/* ---------- helpers ---------- */

const out = (id: string) => `${id}:out:0`;
const inp = (id: string, i = 0) => `${id}:in:${i}`;

/** Wire a switch (with the given state) into input `i` of `gate`. */
function feed(e: Engine, gateId: string, i: number, value: boolean): void {
  const sw = e.addGate("SWITCH", 0, 0);
  sw.state = value;
  e.connect(out(sw.id), inp(gateId, i));
}

/** Build `type`, drive its two inputs, settle, and read its output. */
function evalBinary(type: GateType, a: boolean, b: boolean): boolean {
  const e = new Engine();
  const g = e.addGate(type, 0, 0);
  feed(e, g.id, 0, a);
  feed(e, g.id, 1, b);
  e.evaluate();
  return e.getPin(out(g.id))!.value;
}

/* ---------- pin shapes ---------- */

test("addGate creates the right pin counts", () => {
  const e = new Engine();
  assert.equal(e.addGate("SWITCH", 0, 0).inputs.length, 0);
  assert.equal(e.addGate("SWITCH", 0, 0).outputs.length, 1);
  assert.equal(e.addGate("NOT", 0, 0).inputs.length, 1);
  assert.equal(e.addGate("AND", 0, 0).inputs.length, 2);
  assert.equal(e.addGate("LED", 0, 0).outputs.length, 0);
});

/* ---------- truth tables ---------- */

test("NOT inverts its input", () => {
  const e = new Engine();
  const g = e.addGate("NOT", 0, 0);
  feed(e, g.id, 0, false);
  e.evaluate();
  assert.equal(e.getPin(out(g.id))!.value, true);
});

test("binary gate truth tables", () => {
  const table: Record<string, boolean[]> = {
    // order of inputs: 00, 01, 10, 11
    AND: [false, false, false, true],
    OR: [false, true, true, true],
    NAND: [true, true, true, false],
    NOR: [true, false, false, false],
    XOR: [false, true, true, false],
    XNOR: [true, false, false, true],
  };
  const combos: Array<[boolean, boolean]> = [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ];
  for (const [type, expected] of Object.entries(table)) {
    combos.forEach(([a, b], i) => {
      assert.equal(evalBinary(type as GateType, a, b), expected[i], `${type}(${a},${b})`);
    });
  }
});

test("HIGH and LOW are constant sources", () => {
  const e = new Engine();
  const hi = e.addGate("HIGH", 0, 0);
  const lo = e.addGate("LOW", 0, 0);
  e.evaluate();
  assert.equal(e.getPin(out(hi.id))!.value, true);
  assert.equal(e.getPin(out(lo.id))!.value, false);
});

test("LED mirrors its input into state", () => {
  const e = new Engine();
  const led = e.addGate("LED", 0, 0);
  feed(e, led.id, 0, true);
  e.evaluate();
  assert.equal(led.state, true);
});

/* ---------- multi-input ---------- */

test("multi-input AND/OR/XOR reduce over all inputs", () => {
  const e = new Engine();
  const and = e.addGate("AND", 0, 0);
  e.addInput(and.id); // now 3 inputs
  assert.equal(and.inputs.length, 3);
  feed(e, and.id, 0, true);
  feed(e, and.id, 1, true);
  feed(e, and.id, 2, false);
  e.evaluate();
  assert.equal(e.getPin(out(and.id))!.value, false, "AND with a low input is low");

  const xor = e.addGate("XOR", 0, 0);
  e.addInput(xor.id);
  feed(e, xor.id, 0, true);
  feed(e, xor.id, 1, true);
  feed(e, xor.id, 2, true);
  e.evaluate();
  assert.equal(e.getPin(out(xor.id))!.value, true, "XOR is parity (odd = high)");
});

test("addInput/removeInput respect bounds", () => {
  const e = new Engine();
  const and = e.addGate("AND", 0, 0);
  // Grow to the max of 8.
  for (let i = 0; i < 20; i++) e.addInput(and.id);
  assert.equal(and.inputs.length, 8);
  // Shrink to the min of 2.
  for (let i = 0; i < 20; i++) e.removeInput(and.id);
  assert.equal(and.inputs.length, 2);
  // Fixed-arity gates reject both.
  const not = e.addGate("NOT", 0, 0);
  assert.equal(e.addInput(not.id), false);
  assert.equal(e.removeInput(not.id), false);
});

/* ---------- connect rules ---------- */

test("connect enforces output→input, distinct gates, single driver", () => {
  const e = new Engine();
  const a = e.addGate("SWITCH", 0, 0);
  const b = e.addGate("SWITCH", 0, 0);
  const g = e.addGate("AND", 0, 0);

  assert.equal(e.connect(out(a.id), out(b.id)), null, "output→output rejected");
  assert.equal(e.connect(inp(g.id, 0), inp(g.id, 1)), null, "input→input rejected");

  // Order independence: input→output works the same as output→input.
  const w1 = e.connect(inp(g.id, 0), out(a.id));
  assert.ok(w1, "input→output accepted (order independent)");

  // A second driver on the same input replaces the first.
  e.connect(out(b.id), inp(g.id, 0));
  const drivers = [...e.wires.values()].filter((w) => w.to === inp(g.id, 0));
  assert.equal(drivers.length, 1, "input keeps a single driver");
  assert.equal(drivers[0].from, out(b.id), "latest driver wins");
});

test("connect rejects self-loops on one gate", () => {
  const e = new Engine();
  const not = e.addGate("NOT", 0, 0);
  assert.equal(e.connect(out(not.id), inp(not.id, 0)), null);
});

/* ---------- removal ---------- */

test("removeWire drops just that wire", () => {
  const e = new Engine();
  const a = e.addGate("SWITCH", 0, 0);
  const g = e.addGate("NOT", 0, 0);
  const w = e.connect(out(a.id), inp(g.id, 0))!;
  e.removeWire(w.id);
  assert.equal(e.wires.size, 0);
});

test("removeGate deletes the gate, its pins, and touching wires", () => {
  const e = new Engine();
  const a = e.addGate("SWITCH", 0, 0);
  const g = e.addGate("NOT", 0, 0);
  const led = e.addGate("LED", 0, 0);
  e.connect(out(a.id), inp(g.id, 0));
  e.connect(out(g.id), inp(led.id, 0));
  assert.equal(e.wires.size, 2);

  e.removeGate(g.id);
  assert.equal(e.gates.has(g.id), false);
  assert.equal(e.getPin(out(g.id)), undefined, "pins are removed");
  assert.equal(e.wires.size, 0, "both wires touching the gate are gone");
});

/* ---------- stability ---------- */

test("evaluate reports instability for a feedback oscillator", () => {
  const e = new Engine();
  const not = e.addGate("NOT", 0, 0);
  // Feed the output back into the input via a second NOT to avoid the
  // self-loop guard, forming an unstable ring.
  const not2 = e.addGate("NOT", 0, 0);
  e.connect(out(not.id), inp(not2.id, 0));
  e.connect(out(not2.id), inp(not.id, 0));
  assert.equal(e.evaluate(), false, "ring oscillator never settles");
});

test("evaluate reports stability for a combinational circuit", () => {
  const e = new Engine();
  const g = e.addGate("AND", 0, 0);
  feed(e, g.id, 0, true);
  feed(e, g.id, 1, true);
  assert.equal(e.evaluate(), true);
});

test("tickClocks flips clock state and reports presence", () => {
  const e = new Engine();
  assert.equal(e.tickClocks(), false, "no clocks yet");
  const clk = e.addGate("CLOCK", 0, 0);
  const before = clk.state;
  assert.equal(e.tickClocks(), true);
  assert.equal(clk.state, !before);
});

/* ---------- labels ---------- */

test("setLabel sets and clears", () => {
  const e = new Engine();
  const g = e.addGate("SWITCH", 0, 0);
  e.setLabel(g.id, "  A  ");
  assert.equal(g.label, "A", "trimmed");
  e.setLabel(g.id, "   ");
  assert.equal(g.label, undefined, "blank clears");
});

/* ---------- serialisation ---------- */

test("snapshot round-trips gates, wires, labels, and input counts", () => {
  const src = new Engine();
  const a = src.addGate("SWITCH", 10, 20);
  a.state = true;
  a.label = "A";
  const and = src.addGate("AND", 100, 40);
  src.addInput(and.id); // 3 inputs
  const led = src.addGate("LED", 200, 60);
  src.connect(out(a.id), inp(and.id, 0));
  src.connect(out(and.id), inp(led.id, 0));

  const snap = src.toSnapshot();
  const dst = new Engine();
  dst.loadSnapshot(snap);

  assert.equal(dst.gates.size, 3);
  assert.equal(dst.wires.size, 2);
  assert.equal(dst.gates.get(and.id)!.inputs.length, 3, "input count preserved");
  assert.equal(dst.gates.get(a.id)!.label, "A", "label preserved");
  assert.equal(dst.gates.get(a.id)!.state, true, "state preserved");
});

test("loadSnapshot rejects an unsupported version", () => {
  const e = new Engine();
  assert.throws(() => e.loadSnapshot({ version: 99 } as never));
});

/* ---------- type guard ---------- */

test("isGateType recognises known/unknown types", () => {
  assert.equal(isGateType("AND"), true);
  assert.equal(isGateType("XOR"), true);
  assert.equal(isGateType("BOGUS"), false);
  assert.equal(isGateType(42), false);
});
