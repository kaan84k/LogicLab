/* ============================================================
   history.ts — snapshot-based undo/redo.

   Cheap because the engine already knows how to serialise and
   restore itself. We keep two stacks of `CircuitSnapshot`s: the
   past (undo) and the future (redo). A mutation calls `capture()`
   *before* changing the engine, recording the pre-mutation state
   so `undo()` can return to it.
   ============================================================ */

import { Engine, CircuitSnapshot } from "./engine.js";

export class History {
  private readonly undoStack: CircuitSnapshot[] = [];
  private readonly redoStack: CircuitSnapshot[] = [];
  /** Cap the history depth to keep memory bounded. */
  private readonly limit = 200;

  constructor(private readonly engine: Engine) {}

  /**
   * Record the current state as an undo point. Call this immediately
   * before mutating the engine. Any pending redo history is discarded,
   * since a fresh edit forks a new timeline.
   */
  capture(): void {
    this.undoStack.push(this.engine.toSnapshot());
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Restore the previous state. Returns false if there's nothing to undo. */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.engine.toSnapshot());
    this.engine.loadSnapshot(prev);
    return true;
  }

  /** Re-apply an undone state. Returns false if there's nothing to redo. */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.engine.toSnapshot());
    this.engine.loadSnapshot(next);
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Wipe all history (e.g. after loading a brand-new circuit). */
  reset(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
