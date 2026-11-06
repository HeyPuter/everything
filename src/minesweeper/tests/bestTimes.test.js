import { describe, expect, it } from 'vitest';
import {
  BEST_TIMES_KEY,
  emptyBestTimes,
  loadBestTimes,
  normalizeBestTimes,
  recordBestTime,
  saveBestTimes,
  serializeBestTimes,
} from '../src/game/bestTimes.js';

function memoryStorage() {
  /** @type {Record<string, string>} */
  const data = {};
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

describe('best times', () => {
  it('starts empty for every difficulty', () => {
    expect(emptyBestTimes()).toEqual({
      beginner: null,
      intermediate: null,
      expert: null,
    });
  });

  it('records an improvement and ignores worse times', () => {
    let times = emptyBestTimes();
    let result = recordBestTime(times, 'beginner', 42);
    expect(result.improved).toBe(true);
    expect(result.times.beginner).toBe(42);

    result = recordBestTime(result.times, 'beginner', 50);
    expect(result.improved).toBe(false);
    expect(result.times.beginner).toBe(42);

    result = recordBestTime(result.times, 'beginner', 30);
    expect(result.improved).toBe(true);
    expect(result.times.beginner).toBe(30);
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const times = emptyBestTimes();
    times.beginner = 12;
    times.expert = 200;
    saveBestTimes(times, storage);
    expect(JSON.parse(storage.getItem(BEST_TIMES_KEY)).v).toBe(1);
    expect(loadBestTimes(storage)).toEqual({
      beginner: 12,
      intermediate: null,
      expert: 200,
    });
  });

  it('rejects corrupt or version-mismatched blobs', () => {
    expect(normalizeBestTimes(null)).toEqual(emptyBestTimes());
    expect(normalizeBestTimes({ v: 99, times: { beginner: 1 } })).toEqual(emptyBestTimes());
    expect(normalizeBestTimes({ v: 1, times: { beginner: -3, intermediate: 'fast' } })).toEqual(
      emptyBestTimes(),
    );
  });

  it('serializes a stable envelope', () => {
    expect(serializeBestTimes({ beginner: 5, intermediate: null, expert: null })).toEqual({
      v: 1,
      times: { beginner: 5, intermediate: null, expert: null },
    });
  });
});
