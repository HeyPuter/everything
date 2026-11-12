import type { Tool } from '../../app/registry';
import { commitsSettled } from './masks';

/** Serialize a path tool's input behind queued commits. Vector mask commits
 * rasterize asynchronously; until they land, pointer events wait in order so
 * no gesture reads stale path state or loses its release. */
export function guardTool(t: Tool): Tool {
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const run = <A extends unknown[]>(f: ((...a: A) => unknown) | undefined, ...args: A) => {
    if (!f) return;
    if (!queued && !commitsSettled()) {
      const r = f(...args);
      // An async handler (a commit) also holds back later events until it finishes.
      if (r instanceof Promise) {
        queued++;
        queue = r.catch(() => undefined).finally(() => queued--);
      }
      return r;
    }
    queued++;
    const next = queue.then(async () => {
      await commitsSettled();
      await f(...args);
    });
    queue = next.catch(() => undefined).finally(() => queued--);
    return next;
  };
  return {
    ...t,
    pointerDown: (e, p) => run(t.pointerDown, e, p) as Promise<void> | void,
    pointerMove: (e, p) => void run(t.pointerMove, e, p),
    pointerUp: (e, p) => run(t.pointerUp, e, p) as Promise<void> | void,
    doubleClick: (e, p) => void run(t.doubleClick, e, p),
    keyDown: (e, ev) => {
      if (queued || commitsSettled()) {
        // Nudges wait their turn, so fast or repeated arrow presses all land
        // (a vector mask commit rasterizes asynchronously).
        if (ev.key.startsWith('Arrow') && !ev.metaKey && !ev.ctrlKey && t.keyDown) {
          void run((ev: KeyboardEvent) => t.keyDown!(e, ev), ev);
          return true;
        }
        // Other editing keys need settled state; drop them while commits are pending.
        if (/^(Backspace|Delete|Enter|Escape)/.test(ev.key)) return true;
      }
      return t.keyDown?.(e, ev) ?? false;
    },
  };
}
