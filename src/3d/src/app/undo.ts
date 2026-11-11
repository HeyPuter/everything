import type { DocumentData } from '../data/types';
import { cloneShared, sealArrays } from '../data/cow';

interface Step {
  label: string;
  doc: DocumentData;
}

/** Typed-array buffers each snapshot holds, collected while it is cloned (snapshots never change). */
const stepBuffers = new WeakMap<Step, Set<ArrayBufferLike>>();

/**
 * Buffers smaller than this are not counted: the memory cap is about dense meshes, and counting the
 * many small arrays of a scene with thousands of objects would slow every undo push.
 */
export const UNDO_TRACKED_BYTES = 64 * 1024;

/** `cloneShared` that also collects the large typed-array buffers it shares into `out`. */
function cloneCollect<T>(value: T, out: Set<ArrayBufferLike>): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength >= UNDO_TRACKED_BYTES) out.add(value.buffer);
    return value;
  }
  if (Array.isArray(value)) {
    const arr = new Array(value.length);
    for (let i = 0; i < value.length; i++) arr[i] = cloneCollect(value[i], out);
    return arr as T;
  }
  const obj: Record<string, unknown> = {};
  for (const k in value as Record<string, unknown>) obj[k] = cloneCollect((value as Record<string, unknown>)[k], out);
  return obj as T;
}

/** Global undo history of whole-document snapshots with shared immutable buffers. */
export class UndoStack {
  private steps: Step[] = [];
  private index = -1;
  limit = 64;
  /**
   * Most bytes of mesh/array data the history may hold. Every Edit Mode change to a large mesh
   * stores new arrays (~23 MB per step at 200k vertices), so 64 steps of a dense mesh could exhaust
   * the tab's memory; the oldest steps are dropped beyond this (the last two always stay).
   */
  memoryLimit = 1024 * 2 ** 20;

  /** Bytes of the distinct buffers the steps hold, and how many steps hold each buffer. */
  private bytes = 0;
  private refs = new Map<ArrayBufferLike, number>();

  private make(label: string, doc: DocumentData): Step {
    const set = new Set<ArrayBufferLike>();
    const step = { label, doc: cloneCollect(doc, set) };
    stepBuffers.set(step, set);
    return step;
  }

  private hold(step: Step) {
    for (const b of stepBuffers.get(step) ?? []) {
      const n = this.refs.get(b) ?? 0;
      if (!n) this.bytes += b.byteLength;
      this.refs.set(b, n + 1);
    }
  }

  private release(steps: Step[]) {
    for (const step of steps)
      for (const b of stepBuffers.get(step) ?? []) {
        const n = this.refs.get(b) ?? 0;
        if (n > 1) this.refs.set(b, n - 1);
        else if (n === 1) {
          this.refs.delete(b);
          this.bytes -= b.byteLength;
        }
      }
  }

  private trimMemory() {
    while (this.index > 1 && this.bytes > this.memoryLimit) {
      this.release(this.steps.splice(0, 1));
      this.index--;
    }
  }

  reset(doc: DocumentData, label = 'Original') {
    this.refs.clear();
    this.bytes = 0;
    this.steps = [this.make(label, doc)];
    this.hold(this.steps[0]);
    this.index = 0;
    sealArrays();
  }

  push(doc: DocumentData, label: string) {
    this.release(this.steps.splice(this.index + 1));
    const step = this.make(label, doc);
    this.steps.push(step);
    this.hold(step);
    if (this.steps.length > this.limit + 1) this.release(this.steps.splice(0, this.steps.length - this.limit - 1));
    this.index = this.steps.length - 1;
    this.trimMemory();
    sealArrays();
  }

  /** Replace the latest step (used by "Adjust Last Operation"). */
  replaceTop(doc: DocumentData, label: string) {
    if (this.index < 0) return this.push(doc, label);
    const step = this.make(label, doc);
    this.hold(step);
    this.release([this.steps[this.index]]);
    this.steps[this.index] = step;
    sealArrays();
  }

  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.steps.length - 1;
  }

  undo(): DocumentData | null {
    if (!this.canUndo) return null;
    this.index--;
    sealArrays();
    return cloneShared(this.steps[this.index].doc);
  }

  redo(): DocumentData | null {
    if (!this.canRedo) return null;
    this.index++;
    sealArrays();
    return cloneShared(this.steps[this.index].doc);
  }

  /** Restore the state before the current step (without moving), for redo-last. */
  previous(): DocumentData | null {
    if (this.index < 1) return null;
    return cloneShared(this.steps[this.index - 1].doc);
  }

  current(): DocumentData | null {
    return this.index >= 0 ? cloneShared(this.steps[this.index].doc) : null;
  }

  jump(i: number): DocumentData | null {
    if (i < 0 || i >= this.steps.length) return null;
    this.index = i;
    sealArrays();
    return cloneShared(this.steps[i].doc);
  }

  /** A handle on the current step, to return to or merge from later (it survives steps trimmed off the start). */
  mark(): object | null {
    return this.steps[this.index] ?? null;
  }

  /** Whether `mark` is the current step. */
  isCurrent(mark: object | null) {
    return !!mark && this.steps[this.index] === mark;
  }

  /** Make `mark` current again and drop the steps after it; its document, or null when it is gone. */
  revertTo(mark: object | null): DocumentData | null {
    const i = this.steps.indexOf(mark as Step);
    if (i < 0) return null;
    this.release(this.steps.splice(i + 1));
    this.index = i;
    sealArrays();
    return cloneShared(this.steps[i].doc);
  }

  /** Merge the steps after `mark` up to the current one into a single step named `label`. */
  squash(mark: object | null, label: string): boolean {
    const i = this.steps.indexOf(mark as Step);
    if (i < 0 || i >= this.index) return false;
    const top = this.steps[this.index];
    const merged = { label, doc: top.doc };
    stepBuffers.set(merged, stepBuffers.get(top) ?? new Set());
    this.hold(merged);
    this.release(this.steps.splice(i + 1, this.index - i, merged));
    this.index = i + 1;
    return true;
  }

  get history() {
    return this.steps.map((s, i) => ({ label: s.label, active: i === this.index }));
  }

  get topLabel() {
    return this.steps[this.index]?.label ?? '';
  }
}
