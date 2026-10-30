/**
 * Personal best times per difficulty, persisted in localStorage.
 * Times are whole seconds (matching the on-screen timer).
 */

import { DIFFICULTY_IDS } from './difficulties.js';

export const BEST_TIMES_KEY = 'minesweeper.bestTimes.v1';
export const BEST_TIMES_VERSION = 1;

/** @returns {Record<string, number | null>} */
export function emptyBestTimes() {
  /** @type {Record<string, number | null>} */
  const out = {};
  for (const id of DIFFICULTY_IDS) out[id] = null;
  return out;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, number | null>}
 */
export function normalizeBestTimes(raw) {
  const base = emptyBestTimes();
  if (!raw || typeof raw !== 'object' || /** @type {{v?: unknown}} */ (raw).v !== BEST_TIMES_VERSION) {
    return base;
  }
  const times = /** @type {{ times?: Record<string, unknown> }} */ (raw).times;
  if (!times || typeof times !== 'object') return base;
  for (const id of DIFFICULTY_IDS) {
    const value = times[id];
    if (Number.isFinite(value) && /** @type {number} */ (value) > 0) {
      base[id] = Math.min(999, Math.floor(/** @type {number} */ (value)));
    }
  }
  return base;
}

/**
 * @param {Record<string, number | null>} times
 * @param {string} difficultyId
 * @param {number} seconds
 * @returns {{ times: Record<string, number | null>, improved: boolean }}
 */
export function recordBestTime(times, difficultyId, seconds) {
  const next = { ...times };
  if (!Object.prototype.hasOwnProperty.call(next, difficultyId)) {
    return { times: next, improved: false };
  }
  const sec = Math.floor(seconds);
  if (!Number.isFinite(sec) || sec <= 0) return { times: next, improved: false };
  const capped = Math.min(999, sec);
  const prev = next[difficultyId];
  if (prev === null || capped < prev) {
    next[difficultyId] = capped;
    return { times: next, improved: true };
  }
  return { times: next, improved: false };
}

/**
 * @param {Record<string, number | null>} times
 * @returns {{ v: number, times: Record<string, number | null> }}
 */
export function serializeBestTimes(times) {
  return { v: BEST_TIMES_VERSION, times: normalizeBestTimes({ v: BEST_TIMES_VERSION, times }) };
}

/**
 * @param {Storage} [storage]
 * @returns {Record<string, number | null>}
 */
export function loadBestTimes(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(BEST_TIMES_KEY);
    if (!raw) return emptyBestTimes();
    return normalizeBestTimes(JSON.parse(raw));
  } catch {
    return emptyBestTimes();
  }
}

/**
 * @param {Record<string, number | null>} times
 * @param {Storage} [storage]
 */
export function saveBestTimes(times, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(BEST_TIMES_KEY, JSON.stringify(serializeBestTimes(times)));
  } catch {
    /* quota / private mode: ignore */
  }
}
