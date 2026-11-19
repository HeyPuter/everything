// Spring-loaded tool keys: holding a tool's letter switches to that tool only
// while the key is down. A quick tap switches for good; a key held longer than
// HOLD_MS, or used to paint, select or drag while held, returns to the previous
// tool when it is released. Kept free of DOM code so it can be tested.

export const HOLD_MS = 300;

export class SpringTools {
  private held?: { code: string; previous: string; at: number; used: boolean };

  /** A tool key went down and switched from `previous` (no switch: no spring). */
  press(code: string, previous: string, switchedTo: string, now: number) {
    this.held =
      previous && previous !== switchedTo ? { code, previous, at: now, used: false } : undefined;
  }
  /** Auto-repeat of the held key: true when it belongs to the held tool key and should be swallowed. */
  repeat(code: string) {
    return this.held?.code === code;
  }
  /** The temporary tool was used (a pointer gesture) while its key was held. */
  use() {
    if (this.held) this.held.used = true;
  }
  /** Another key, a dialog or a focus loss ends the hold without a return. */
  cancel() {
    this.held = undefined;
  }
  get holding() {
    return !!this.held;
  }
  /** The key came up: the tool to return to, if the press was a hold. */
  release(code: string, now: number): string | undefined {
    const h = this.held;
    if (!h || h.code !== code) return undefined;
    this.held = undefined;
    return h.used || now - h.at >= HOLD_MS ? h.previous : undefined;
  }
}
