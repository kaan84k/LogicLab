/* ============================================================
   persistence.ts — save / load / share plumbing.

   One place for everything that turns a circuit into bytes and
   back: schema validation, version migration, localStorage
   autosave, the named-circuit gallery, and URL-hash sharing.
   The engine stays oblivious to all of this.
   ============================================================ */

import { CircuitSnapshot, isGateType } from "./engine.js";

/** The format version this build writes. Bump when the shape changes. */
export const LATEST_VERSION = 1;

/* Storage keys (namespaced so we don't collide with other apps). */
const AUTOSAVE_KEY = "logiclab:autosave";
const GALLERY_KEY = "logiclab:circuits";
/** URL-hash prefix for a shared circuit, e.g. `#c=<base64url>`. */
const HASH_PREFIX = "c=";

/** A circuit saved under a user-chosen name. */
export interface SavedCircuit {
  name: string;
  snapshot: CircuitSnapshot;
  savedAt: number;
}

/* --------------------------------------------------------
   Validation + migration
   -------------------------------------------------------- */

/**
 * Bring an arbitrary parsed object up to the latest schema version,
 * or throw a friendly Error if it's from an unknown/newer format.
 * Structured as a stepwise ladder so future versions slot in cleanly.
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const version = raw["version"];
  if (typeof version !== "number") {
    throw new Error("This doesn't look like a LogicLab circuit (no version).");
  }
  if (version > LATEST_VERSION) {
    throw new Error(`This circuit was made with a newer LogicLab (v${version}).`);
  }
  // v1 is current; older versions would be upgraded here, e.g.:
  //   if (version < 1) { /* raw = upgrade0to1(raw); */ }
  return raw;
}

/**
 * Validate + migrate an arbitrary value into a clean CircuitSnapshot.
 * Throws an Error with a human-readable message on any problem, so
 * callers can surface it directly to the user.
 */
export function validateSnapshot(data: unknown): CircuitSnapshot {
  if (!data || typeof data !== "object") {
    throw new Error("Circuit file is empty or not valid JSON.");
  }
  const raw = migrate(data as Record<string, unknown>);

  const rawGates = raw["gates"];
  const rawWires = raw["wires"];
  if (!Array.isArray(rawGates) || !Array.isArray(rawWires)) {
    throw new Error("Circuit file is missing its gates or wires.");
  }

  const gates = rawGates.map((g: unknown, i: number) => {
    const o = g as Record<string, unknown>;
    if (
      typeof o?.["id"] !== "string" ||
      !isGateType(o["type"]) ||
      typeof o["x"] !== "number" ||
      typeof o["y"] !== "number"
    ) {
      throw new Error(`Circuit file has an invalid component (#${i + 1}).`);
    }
    return {
      id: o["id"],
      type: o["type"],
      x: o["x"],
      y: o["y"],
      state: Boolean(o["state"]),
      inputs: typeof o["inputs"] === "number" ? o["inputs"] : undefined,
      label: typeof o["label"] === "string" ? o["label"] : undefined,
    };
  });

  const wires = rawWires.map((w: unknown, i: number) => {
    const o = w as Record<string, unknown>;
    if (typeof o?.["id"] !== "string" || typeof o["from"] !== "string" || typeof o["to"] !== "string") {
      throw new Error(`Circuit file has an invalid wire (#${i + 1}).`);
    }
    return { id: o["id"], from: o["from"], to: o["to"] };
  });

  return { version: LATEST_VERSION, gates, wires };
}

/** Parse raw JSON text into a validated snapshot (throws on any issue). */
export function parseCircuit(text: string): CircuitSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return validateSnapshot(parsed);
}

/* --------------------------------------------------------
   localStorage — autosave
   -------------------------------------------------------- */

function readJSON(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null; // storage blocked (private mode) or corrupt — degrade quietly
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — nothing we can do, so ignore */
  }
}

export function saveAutosave(snapshot: CircuitSnapshot): void {
  writeJSON(AUTOSAVE_KEY, snapshot);
}

/** The last autosaved circuit, or null if none/invalid. */
export function loadAutosave(): CircuitSnapshot | null {
  const data = readJSON(AUTOSAVE_KEY);
  if (!data) return null;
  try {
    return validateSnapshot(data);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------
   localStorage — named circuit gallery
   -------------------------------------------------------- */

/** All saved circuits, newest first, skipping any corrupt entries. */
export function listCircuits(): SavedCircuit[] {
  const data = readJSON(GALLERY_KEY);
  if (!Array.isArray(data)) return [];
  const out: SavedCircuit[] = [];
  for (const entry of data) {
    const e = entry as Record<string, unknown>;
    if (typeof e?.["name"] !== "string") continue;
    try {
      out.push({
        name: e["name"],
        snapshot: validateSnapshot(e["snapshot"]),
        savedAt: typeof e["savedAt"] === "number" ? e["savedAt"] : 0,
      });
    } catch {
      /* skip unreadable saved circuit */
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Save (or overwrite by name) a circuit in the gallery. */
export function saveNamedCircuit(name: string, snapshot: CircuitSnapshot): void {
  const items = listCircuits().filter((c) => c.name !== name);
  items.unshift({ name, snapshot, savedAt: Date.now() });
  writeJSON(GALLERY_KEY, items);
}

export function deleteNamedCircuit(name: string): void {
  const items = listCircuits().filter((c) => c.name !== name);
  writeJSON(GALLERY_KEY, items);
}

/* --------------------------------------------------------
   URL-hash sharing (base64url so it's copy-paste safe)
   -------------------------------------------------------- */

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Absolute URL that reloads this page with the circuit embedded in the hash. */
export function buildShareUrl(snapshot: CircuitSnapshot): string {
  const encoded = toBase64Url(JSON.stringify(snapshot));
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#${HASH_PREFIX}${encoded}`;
}

/**
 * Decode a circuit from a URL hash (e.g. `#c=...`), or null if the hash
 * carries no circuit or the payload is unreadable.
 */
export function decodeFromHash(hash: string): CircuitSnapshot | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith(HASH_PREFIX)) return null;
  try {
    const json = fromBase64Url(raw.slice(HASH_PREFIX.length));
    return validateSnapshot(JSON.parse(json));
  } catch {
    return null;
  }
}
