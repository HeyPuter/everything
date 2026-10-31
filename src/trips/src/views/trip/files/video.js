// Whether this trip takes videos (direct file mode: the owner, or a member with an inbox), re-checked when the trip's
// access may have changed.
import { ACCEPT, VIDEO_ACCEPT, directAvailable, isVideoFile } from '../../../lib/files/index.js';

const RECHECK = 10_000;

export function createVideoSupport(space, { onChange, now = Date.now } = {}) {
  let available = false;
  let checked = -Infinity;
  let destroyed = false;
  async function check() {
    if (destroyed || now() - checked < RECHECK) return;
    checked = now();
    const next = await directAvailable(space).catch(() => false);
    if (destroyed || next === available) return;
    available = next;
    onChange?.(available);
  }
  void check();
  const off = typeof space.onState === 'function' ? space.onState(() => void check()) : null;
  return {
    get available() { return available; },
    accept: () => (available ? `${ACCEPT},${VIDEO_ACCEPT}` : ACCEPT),
    /** Splits picked files into those to queue and videos this trip cannot take. */
    split(files) {
      const refused = available ? [] : files.filter((file) => isVideoFile(file));
      return { ok: files.filter((file) => !refused.includes(file)), refused };
    },
    destroy() { destroyed = true; off?.(); },
  };
}
