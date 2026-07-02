/* ============================================================
   main.ts — orchestration.

   Boots the engine + view, binds the sidebar controls, and
   implements JSON save/load using the File + Blob APIs.
   ============================================================ */

import { Engine } from "./engine.js";
import { View } from "./view.js";
import { History } from "./history.js";
import type { GateType } from "./engine.js";
import {
  parseCircuit,
  saveAutosave,
  loadAutosave,
  listCircuits,
  saveNamedCircuit,
  deleteNamedCircuit,
  buildShareUrl,
  decodeFromHash,
  type SavedCircuit,
} from "./persistence.js";

/* ---------- Boot ---------- */
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const engine = new Engine();
const view = new View(canvas, engine);
const history = new History(engine);

// Re-settle the circuit after every structural or state change.
view.onChange = () => settle();
// Record an undo point immediately before any mutation the view performs.
view.beforeChange = () => history.capture();
// Persist (debounced) after any user edit — structural OR positional; also
// refresh the accessible text outline.
view.onEdit = () => {
  scheduleAutosave();
  refreshOutline();
};
engine.evaluate(); // initial settle of the (empty) circuit

/* ---------- Accessibility helpers ---------- */
const a11yStatus = document.getElementById("a11y-status")!;
const a11yOutline = document.getElementById("a11y-outline")!;

/** Announce a short message to screen readers via the polite live region. */
function announce(message: string): void {
  a11yStatus.textContent = message;
}

/** Rebuild the hidden text outline of the whole circuit. */
function refreshOutline(): void {
  a11yOutline.textContent = view.outlineText();
}

/* ---------- Autosave (debounced) ---------- */
let autosaveTimer = 0;
function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => saveAutosave(engine.toSnapshot()), 800);
}

// Drive CLOCK sources: flip them on a fixed half-period and re-settle.
// Clock ticks are continuous, so they deliberately skip the undo history.
const CLOCK_PERIOD_MS = 600;
window.setInterval(() => {
  if (engine.tickClocks()) settle();
}, CLOCK_PERIOD_MS);

/* ---------- Small helpers ---------- */
const statusEl = document.getElementById("status-readout")!;
const toastHost = document.getElementById("toast-host")!;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

/**
 * Re-settle the circuit, warning once when it starts oscillating (and
 * clearing the warning once it stabilises again).
 */
let wasUnstable = false;
function settle(): void {
  const stable = engine.evaluate();
  if (!stable) {
    if (!wasUnstable) toast("Circuit is unstable — a feedback loop is oscillating", "bad");
    setStatus("Unstable: feedback loop never settles");
  } else if (wasUnstable) {
    setStatus("Ready");
  }
  wasUnstable = !stable;
  view.invalidate(); // engine state changed → force a redraw
  refreshOutline();
}

function toast(message: string, tone: "good" | "bad" | "info" = "info"): void {
  const el = document.createElement("div");
  el.className = "toast" + (tone === "good" ? " toast--good" : tone === "bad" ? " toast--bad" : "");
  el.textContent = message;
  toastHost.appendChild(el);
  window.setTimeout(() => el.remove(), 2800);
}

/* ---------- Component palette ---------- */
const chips = Array.from(document.querySelectorAll<HTMLButtonElement>(".chip"));

for (const chip of chips) {
  chip.addEventListener("click", () => {
    const type = chip.dataset.component as GateType;
    const alreadyArmed = chip.classList.contains("is-armed");

    // Toggle: clicking the armed chip again disarms it.
    for (const c of chips) c.classList.remove("is-armed");

    if (alreadyArmed) {
      view.arm(null);
      setStatus("Ready");
    } else {
      chip.classList.add("is-armed");
      view.arm(type);
      setStatus(`Placing: ${chip.querySelector(".chip__label")?.textContent ?? type} — click the canvas`);
    }
  });
}

/* ---------- Save: circuit → downloadable .json ---------- */
const btnSave = document.getElementById("btn-save")!;
btnSave.addEventListener("click", () => {
  const snapshot = engine.toSnapshot();
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `circuit-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  toast("Circuit saved", "good");
});

/* ---------- Open: .json → circuit (hidden file picker) ---------- */
const btnOpen = document.getElementById("btn-open")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;

btnOpen.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const snapshot = parseCircuit(text); // validates + migrates, throws friendly errors
    history.capture();
    engine.loadSnapshot(snapshot);
    view.clearSelection();
    settle();
    scheduleAutosave();
    toast(`Loaded ${file.name}`, "good");
    setStatus(`Loaded ${file.name}`);
  } catch (err) {
    console.error(err);
    toast(err instanceof Error ? err.message : "Could not read that file", "bad");
  } finally {
    fileInput.value = ""; // allow re-opening the same file later
  }
});

/* ---------- Clear ---------- */
const btnClear = document.getElementById("btn-clear")!;
btnClear.addEventListener("click", () => {
  history.capture();
  engine.clear();
  view.clearSelection();
  settle();
  scheduleAutosave();
  toast("Canvas cleared", "info");
  setStatus("Ready");
});

/* ---------- Share via URL hash ---------- */
document.getElementById("btn-share")!.addEventListener("click", async () => {
  const url = buildShareUrl(engine.toSnapshot());
  try {
    await navigator.clipboard.writeText(url);
    toast("Share link copied to clipboard", "good");
  } catch {
    // Clipboard access denied — drop the circuit into the address bar instead.
    window.location.hash = url.slice(url.indexOf("#"));
    toast("Share link is now in the address bar", "info");
  }
});

/* ---------- Saved-circuit gallery ---------- */
const galleryEl = document.getElementById("gallery")!;
const nameInput = document.getElementById("circuit-name") as HTMLInputElement;

document.getElementById("btn-save-named")!.addEventListener("click", saveNamed);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveNamed();
});

function saveNamed(): void {
  const name = nameInput.value.trim();
  if (!name) {
    toast("Type a name first", "info");
    return;
  }
  saveNamedCircuit(name, engine.toSnapshot());
  nameInput.value = "";
  renderGallery();
  toast(`Saved "${name}"`, "good");
}

function loadNamed(circuit: SavedCircuit): void {
  history.capture();
  engine.loadSnapshot(circuit.snapshot);
  view.clearSelection();
  settle();
  scheduleAutosave();
  toast(`Loaded "${circuit.name}"`, "good");
  setStatus(`Loaded "${circuit.name}"`);
}

function renderGallery(): void {
  galleryEl.replaceChildren();
  const items = listCircuits();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "gallery__empty";
    empty.textContent = "No saved circuits yet.";
    galleryEl.appendChild(empty);
    return;
  }
  for (const circuit of items) {
    const li = document.createElement("li");
    li.className = "gallery__item";

    const load = document.createElement("button");
    load.className = "gallery__load";
    load.textContent = circuit.name;
    load.title = `Load "${circuit.name}"`;
    load.addEventListener("click", () => loadNamed(circuit));

    const del = document.createElement("button");
    del.className = "gallery__del";
    del.textContent = "✕";
    del.title = `Delete "${circuit.name}"`;
    del.addEventListener("click", () => {
      deleteNamedCircuit(circuit.name);
      renderGallery();
      toast(`Deleted "${circuit.name}"`, "info");
    });

    li.append(load, del);
    galleryEl.appendChild(li);
  }
}

/* ---------- Truth table ---------- */
const truthModal = document.getElementById("truth-modal")!;
const truthBody = document.getElementById("truth-body")!;

document.getElementById("btn-truth")!.addEventListener("click", openTruthTable);
document.getElementById("truth-close")!.addEventListener("click", closeTruthTable);
truthModal.addEventListener("click", (e) => {
  if (e.target === truthModal) closeTruthTable(); // click the backdrop to dismiss
});

function closeTruthTable(): void {
  truthModal.classList.remove("is-open");
}

interface TruthRow {
  inputs: boolean[];
  outputs: boolean[];
}

/**
 * Enumerate every combination of the circuit's SWITCH inputs, settle the
 * circuit for each, and tabulate the resulting LED outputs.
 */
function openTruthTable(): void {
  const gates = [...engine.gates.values()];
  const switches = gates.filter((g) => g.type === "SWITCH");
  const leds = gates.filter((g) => g.type === "LED");

  if (!switches.length || !leds.length) {
    toast("Add at least one Switch and one LED first", "info");
    return;
  }
  if (switches.length > 8) {
    toast("Too many switches for a truth table (max 8)", "bad");
    return;
  }

  const n = switches.length;
  const saved = switches.map((s) => s.state);
  const rows: TruthRow[] = [];

  for (let combo = 0; combo < 1 << n; combo++) {
    // S1 is the most-significant bit so the table reads top-to-bottom.
    switches.forEach((s, i) => (s.state = ((combo >> (n - 1 - i)) & 1) === 1));
    engine.evaluate();
    rows.push({ inputs: switches.map((s) => s.state), outputs: leds.map((l) => l.state) });
  }

  // Restore the user's live switch states.
  switches.forEach((s, i) => (s.state = saved[i]));
  settle();

  renderTruthTable(n, leds.length, rows);
}

function renderTruthTable(nIn: number, nOut: number, rows: TruthRow[]): void {
  const cell = (v: boolean, sep: boolean): string =>
    `<td class="${v ? "one" : "zero"}${sep ? " sep" : ""}">${v ? 1 : 0}</td>`;

  const head =
    Array.from({ length: nIn }, (_, i) => `<th>S${i + 1}</th>`).join("") +
    Array.from({ length: nOut }, (_, i) => `<th class="${i === 0 ? "sep" : ""}">L${i + 1}</th>`).join("");

  const body = rows
    .map((r) => {
      const cells =
        r.inputs.map((v) => cell(v, false)).join("") + r.outputs.map((v, i) => cell(v, i === 0)).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  truthBody.innerHTML =
    `<p class="modal__note">${nIn} switch input(s) → ${nOut} LED output(s), ${rows.length} rows. ` +
    `Inputs (S1…) and outputs (L1…) are numbered in placement order.</p>` +
    `<table class="ttable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

  truthModal.classList.add("is-open");
}

/* ---------- View controls ---------- */
document.getElementById("btn-fit")!.addEventListener("click", () => view.fitView());

const snapToggle = document.getElementById("toggle-snap") as HTMLInputElement;
snapToggle.addEventListener("change", () => view.setSnap(snapToggle.checked));

const minimapToggle = document.getElementById("toggle-minimap") as HTMLInputElement;
minimapToggle.addEventListener("change", () => view.setMinimap(minimapToggle.checked));

const colorblindToggle = document.getElementById("toggle-colorblind") as HTMLInputElement;
colorblindToggle.addEventListener("change", () => view.setColorblind(colorblindToggle.checked));

/* ---------- Right-click context menu ---------- */
const contextMenu = document.getElementById("context-menu")!;
const viewport = document.querySelector(".viewport") as HTMLElement;

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const kind = view.pickForContext(e.clientX, e.clientY);
  if (kind === "empty") {
    hideContextMenu();
    return;
  }
  buildContextMenu(kind, e.clientX, e.clientY);
});

// Double-click a gate to rename it.
canvas.addEventListener("dblclick", (e) => {
  if (view.pickForContext(e.clientX, e.clientY) === "gate") renameSelected();
});

// Dismiss on any outside click, scroll, or window blur.
window.addEventListener("pointerdown", (e) => {
  if (!contextMenu.contains(e.target as Node)) hideContextMenu();
});
window.addEventListener("blur", hideContextMenu);

function hideContextMenu(): void {
  contextMenu.classList.remove("is-open");
}

function buildContextMenu(kind: "gate" | "wire", clientX: number, clientY: number): void {
  contextMenu.replaceChildren();

  const item = (label: string, run: () => void, danger = false): void => {
    const b = document.createElement("button");
    b.textContent = label;
    if (danger) b.className = "danger";
    b.addEventListener("click", () => {
      hideContextMenu();
      run();
    });
    contextMenu.appendChild(b);
  };
  const separator = (): void => {
    contextMenu.appendChild(document.createElement("hr"));
  };

  if (kind === "gate") {
    if (view.soleSelectedGate()) item("Rename…", renameSelected);
    item("Duplicate", () => view.duplicate());
    if (view.hasVariableInputSelection()) {
      separator();
      item("Add input", () => view.addInputToSelection());
      item("Remove input", () => view.removeInputFromSelection());
    }
    separator();
    item("Delete", () => view.deleteSelection(), true);
  } else {
    item("Delete wire", () => view.deleteSelection(), true);
  }

  // Show, then position within the viewport (clamped to its bounds).
  contextMenu.classList.add("is-open");
  const rect = viewport.getBoundingClientRect();
  const left = Math.min(clientX - rect.left, rect.width - contextMenu.offsetWidth - 6);
  const top = Math.min(clientY - rect.top, rect.height - contextMenu.offsetHeight - 6);
  contextMenu.style.left = `${Math.max(6, left)}px`;
  contextMenu.style.top = `${Math.max(6, top)}px`;
}

function renameSelected(): void {
  const gate = view.soleSelectedGate();
  const next = window.prompt("Label for this component:", gate?.label ?? "");
  if (next !== null) view.renameSelection(next);
}

/* ---------- Undo / redo ---------- */
function undo(): void {
  if (history.undo()) {
    view.clearSelection();
    settle();
    scheduleAutosave();
    setStatus("Undo");
  }
}

function redo(): void {
  if (history.redo()) {
    view.clearSelection();
    settle();
    scheduleAutosave();
    setStatus("Redo");
  }
}

/* ---------- Keyboard shortcuts ---------- */
const ARROW_DIR: Record<string, "left" | "right" | "up" | "down" | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

document.addEventListener("keydown", (e) => {
  // Ignore keystrokes aimed at text fields (none today, but future-proof).
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const canvasFocused = document.activeElement === canvas;
  const arrow = ARROW_DIR[e.key];

  if (canvasFocused && !mod && arrow) {
    // Arrow = navigate between components; Shift+Arrow = reposition.
    e.preventDefault();
    if (e.shiftKey) {
      view.nudgeSelection(arrow);
      const g = view.soleSelectedGate();
      if (g) announce(`Moved ${view.describeGate(g)}`);
    } else {
      const g = view.navigate(arrow);
      announce(g ? `Selected ${view.describeGate(g)}` : "No component in that direction");
    }
  } else if (canvasFocused && !mod && e.key === "Enter") {
    // Enter toggles a selected switch, or drops the armed component.
    e.preventDefault();
    if (view.toggleSelectedSwitch()) {
      const g = view.soleSelectedGate();
      if (g) announce(view.describeGate(g));
    } else {
      const g = view.placeArmedAtCenter();
      if (g) announce(`Placed ${view.describeGate(g)}`);
    }
  } else if (canvasFocused && !mod && key === "w") {
    // Two-step keyboard wiring.
    e.preventDefault();
    switch (view.keyboardWireStep()) {
      case "started":
        announce("Wiring from this component. Select a target and press W again.");
        break;
      case "connected":
        announce("Connected.");
        break;
      case "invalid":
        announce("Can't wire those two.");
        break;
      default:
        announce("Select a component first.");
    }
  } else if (mod && key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if (mod && key === "a") {
    e.preventDefault();
    view.selectAll();
  } else if (mod && key === "c") {
    e.preventDefault();
    view.copy();
  } else if (mod && key === "v") {
    e.preventDefault();
    view.paste();
  } else if (mod && key === "d") {
    e.preventDefault();
    view.duplicate();
  } else if (!mod && key === "f") {
    view.fitView();
  } else if (!mod && (e.key === "+" || e.key === "=")) {
    view.addInputToSelection();
  } else if (!mod && (e.key === "-" || e.key === "_")) {
    view.removeInputFromSelection();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (view.hasSelection) {
      e.preventDefault();
      view.deleteSelection();
    }
  } else if (e.key === "Escape") {
    // Escape peels back one layer: menu → wiring → truth table → selection.
    if (contextMenu.classList.contains("is-open")) {
      hideContextMenu();
    } else if (view.isKeyboardWiring()) {
      view.cancelKeyboardWire();
      announce("Wiring cancelled");
    } else if (truthModal.classList.contains("is-open")) {
      closeTruthTable();
    } else {
      view.clearSelection();
      view.arm(null);
      for (const c of chips) c.classList.remove("is-armed");
      setStatus("Ready");
    }
  }
});

/* ---------- Onboarding overlay ---------- */
const onboarding = document.getElementById("onboarding")!;
document.getElementById("onboarding-close")!.addEventListener("click", () => {
  onboarding.classList.add("is-hidden");
});

/* ---------- Boot restore: shared URL first, else last autosave ---------- */
function restoreOnBoot(): void {
  try {
    const shared = decodeFromHash(window.location.hash);
    if (shared) {
      engine.loadSnapshot(shared);
      settle();
      toast("Loaded shared circuit", "good");
      setStatus("Loaded shared circuit");
      return;
    }
    const saved = loadAutosave();
    if (saved) {
      engine.loadSnapshot(saved);
      settle();
      setStatus("Restored your last session");
    }
  } catch (err) {
    console.error("Restore failed", err);
  }
}

restoreOnBoot();
renderGallery();
refreshOutline();
