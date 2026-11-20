/**
 * Game clock. Starts on first click (caller responsibility), stops on
 * win/lose. Classic Minesweeper displays whole seconds and caps at 999.
 */

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.elapsedMs]
 */
export function createTimer({ now = () => Date.now(), elapsedMs = 0 } = {}) {
  let banked = Math.max(0, elapsedMs);
  let startedAt = null;

  return {
    start() {
      if (startedAt === null) startedAt = now();
      return this;
    },
    pause() {
      if (startedAt !== null) {
        banked += Math.max(0, now() - startedAt);
        startedAt = null;
      }
      return this;
    },
    reset(to = 0) {
      banked = Math.max(0, to);
      startedAt = null;
      return this;
    },
    get running() {
      return startedAt !== null;
    },
    get elapsedMs() {
      return banked + (startedAt === null ? 0 : Math.max(0, now() - startedAt));
    },
  };
}

/** Whole seconds, capped at 999 like the classic three-digit display. */
export function formatSeconds(ms) {
  const total = Math.min(999, Math.max(0, Math.floor((Number(ms) || 0) / 1000)));
  return String(total).padStart(3, '0');
}

export function elapsedSeconds(ms) {
  return Math.min(999, Math.max(0, Math.floor((Number(ms) || 0) / 1000)));
}
