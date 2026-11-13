/**
 * Small pointer-event gesture helpers for touch input: a two-pointer pinch
 * tracker and a long-press timer that gives up when the finger moves (so a
 * scroll never turns into a drag by accident).
 */

/**
 * Tracks touch pointers and reports pinch scale steps.
 *   const pinch = createPinch({ onStart, onChange, onEnd });
 *   el.addEventListener('pointerdown', pinch.down) ... move, up
 * onChange(step, total, center) receives the scale since the last call, the
 * scale since the pinch started, and the midpoint in client px.
 */
export function createPinch({ onStart, onChange, onEnd } = {}) {
  const pts = new Map();
  let startDist = 0;
  let lastDist = 0;
  let active = false;

  const pair = () => {
    const [a, b] = [...pts.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };

  return {
    get active() {
      return active;
    },
    get count() {
      return pts.size;
    },
    /** Returns true when this pointer started (or joined) a pinch. */
    down(e) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && !active) {
        active = true;
        startDist = lastDist = pair().dist;
        const p = pair();
        onStart?.({ x: p.cx, y: p.cy });
      }
      return active;
    },
    /** Returns true when the move belonged to an active pinch. */
    move(e) {
      const p = pts.get(e.pointerId);
      if (!p) return false;
      p.x = e.clientX;
      p.y = e.clientY;
      if (!active || pts.size < 2) return active;
      const now = pair();
      const step = now.dist / lastDist;
      lastDist = now.dist;
      onChange?.(step, now.dist / startDist, { x: now.cx, y: now.cy });
      return true;
    },
    up(e) {
      if (!pts.delete(e.pointerId)) return false;
      if (active && pts.size < 2) {
        active = false;
        onEnd?.();
        return true;
      }
      if (active) {
        // A third finger can replace one of the original pair. Rebase the
        // distance without changing the accumulated scale or creating a zoom step.
        const total = lastDist / startDist;
        lastDist = pair().dist;
        startDist = lastDist / total;
      }
      return active;
    },
    reset() {
      pts.clear();
      if (active) {
        active = false;
        onEnd?.();
      }
    },
  };
}

/**
 * Long press: calls onPress after delay ms unless the pointer moves more
 * than slop px or lifts first. Returns { move(e), cancel(), fired }.
 */
export function longPress(e, { delay = 350, slop = 10, onPress } = {}) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let fired = false;
  let timer = setTimeout(() => {
    timer = null;
    fired = true;
    onPress?.();
  }, delay);
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    get fired() {
      return fired;
    },
    get pending() {
      return timer !== null;
    },
    /** Returns false once the pointer has moved too far (the press is cancelled). */
    move(ev) {
      if (fired) return true;
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > slop) {
        cancel();
        return false;
      }
      return true;
    },
    cancel,
  };
}
