import { describe, it, expect, beforeEach } from 'vitest';
import {
  emptyStats, mergeStats, recordGameStarted, recordGameWon,
  loadLocalStats, saveLocalStats, loadLocalSave, saveLocalSave, clearLocalSave,
  STATS_VERSION, modeStats, recordVegasResult, vegasBank, isVegasSettled, SETTLED_KEEP,
} from './stats.js';

// Minimal localStorage stand-in; vitest runs in the node environment.
beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
});

describe('mergeStats', () => {
  it('takes the higher played and won counts', () => {
    const a = { v: 1, played: 10, won: 3, bestMoves: 200, ts: 1 };
    const b = { v: 1, played: 4, won: 4, bestMoves: 180, ts: 2 };
    const m = mergeStats(a, b);
    expect(m.played).toBe(10);
    expect(m.won).toBe(4);
  });

  it('takes the lower best-move count', () => {
    const a = { v: 1, played: 1, won: 1, bestMoves: 200, ts: 1 };
    const b = { v: 1, played: 1, won: 1, bestMoves: 150, ts: 1 };
    expect(mergeStats(a, b).bestMoves).toBe(150);
  });

  it('ignores a null best-move count rather than treating it as zero', () => {
    const a = { v: 1, played: 1, won: 0, bestMoves: null, ts: 1 };
    const b = { v: 1, played: 1, won: 1, bestMoves: 180, ts: 1 };
    expect(mergeStats(a, b).bestMoves).toBe(180);
    expect(mergeStats(b, a).bestMoves).toBe(180);
  });

  it('is null when neither side has won a game', () => {
    expect(mergeStats(emptyStats(), emptyStats()).bestMoves).toBe(null);
  });

  it('tolerates null and undefined inputs', () => {
    expect(mergeStats(null, null)).toEqual(emptyStats());
    expect(mergeStats(undefined, { v: 1, played: 2, won: 0, bestMoves: null, ts: 9 }).played).toBe(2);
  });

  it('keeps the later timestamp', () => {
    const a = { v: 1, played: 0, won: 0, bestMoves: null, ts: 5 };
    const b = { v: 1, played: 0, won: 0, bestMoves: null, ts: 99 };
    expect(mergeStats(a, b).ts).toBe(99);
  });
});

describe('recordGameStarted / recordGameWon', () => {
  it('increments played without touching won', () => {
    const s = recordGameStarted(emptyStats(), 100);
    expect(s.played).toBe(1);
    expect(s.won).toBe(0);
    expect(s.ts).toBe(100);
  });

  it('increments won and sets the first best-move count', () => {
    const s = recordGameWon(recordGameStarted(emptyStats(), 1), 143, 200);
    expect(s.won).toBe(1);
    expect(s.bestMoves).toBe(143);
  });

  it('lowers best moves only on an improvement', () => {
    let s = recordGameWon(emptyStats(), 143, 1);
    s = recordGameWon(s, 190, 2);
    expect(s.bestMoves).toBe(143);
    s = recordGameWon(s, 120, 3);
    expect(s.bestMoves).toBe(120);
  });
});

describe('per-game stats', () => {
  it('keeps draw-one Klondike in the top-level fields older builds read', () => {
    const s = recordGameWon(recordGameStarted(emptyStats(), 1, 'klondike-1'), 90, 2, 'klondike-1');
    expect(s.played).toBe(1);
    expect(s.won).toBe(1);
    expect(s.bestMoves).toBe(90);
    expect(s.modes).toEqual({});
  });

  it('counts every other game separately', () => {
    let s = recordGameStarted(emptyStats(), 1, 'spider-2');
    s = recordGameWon(s, 300, 2, 'spider-2');
    s = recordGameStarted(s, 3, 'klondike-3');
    expect(modeStats(s, 'spider-2')).toEqual({ played: 1, won: 1, bestMoves: 300 });
    expect(modeStats(s, 'klondike-3')).toEqual({ played: 1, won: 0, bestMoves: null });
    expect(modeStats(s, 'klondike-1')).toEqual({ played: 0, won: 0, bestMoves: null });
    expect(s.played).toBe(0);
  });

  it('merges each game counter by counter', () => {
    const a = { ...emptyStats(), modes: { 'spider-1': { played: 5, won: 1, bestMoves: 400 } } };
    const b = { ...emptyStats(), modes: {
      'spider-1': { played: 3, won: 2, bestMoves: 350 },
      'vegas-3': { played: 1, won: 0, bestMoves: null },
    } };
    const m = mergeStats(a, b);
    expect(m.modes['spider-1']).toEqual({ played: 5, won: 2, bestMoves: 350 });
    expect(m.modes['vegas-3']).toEqual({ played: 1, won: 0, bestMoves: null });
  });

  it('survives a merge with stats from a build that has no modes', () => {
    const local = recordGameStarted(emptyStats(), 1, 'spider-4');
    const oldBuild = { v: 1, played: 7, won: 2, bestMoves: 120, ts: 5 };
    const m = mergeStats(local, oldBuild);
    expect(m.played).toBe(7);
    expect(modeStats(m, 'spider-4').played).toBe(1);
  });
});

describe('Vegas bank', () => {
  const settle = (stats, gameId, score, deviceId = 'dev-a', now = 1) =>
    recordVegasResult(stats, { gameId, score, deviceId, now });

  it('starts at zero and adds each settled game', () => {
    let s = emptyStats();
    expect(vegasBank(s)).toBe(0);
    s = settle(s, 'g1', -52);
    s = settle(s, 'g2', 208);
    expect(vegasBank(s)).toBe(156);
  });

  it('pays a game in only once', () => {
    let s = settle(emptyStats(), 'g1', -52);
    s = settle(s, 'g1', -52);
    expect(vegasBank(s)).toBe(-52);
    expect(isVegasSettled(s, 'g1')).toBe(true);
    expect(isVegasSettled(s, 'g2')).toBe(false);
  });

  it('keeps games settled on two devices when they merge', () => {
    const a = settle(emptyStats(), 'g1', -52, 'dev-a', 10);
    const b = settle(emptyStats(), 'g2', 100, 'dev-b', 20);
    expect(vegasBank(mergeStats(a, b))).toBe(48);
    expect(vegasBank(mergeStats(b, a))).toBe(48);
  });

  it('takes the newer entry for the same device', () => {
    const older = settle(emptyStats(), 'g1', -52, 'dev-a', 10);
    const newer = settle(older, 'g2', 30, 'dev-a', 20);
    expect(vegasBank(mergeStats(older, newer))).toBe(-22);
    expect(vegasBank(mergeStats(newer, older))).toBe(-22);
  });

  it('does not pay in a game another device already settled', () => {
    const a = settle(emptyStats(), 'g1', 60, 'dev-a', 10);
    let b = mergeStats(emptyStats(), a);
    b = settle(b, 'g1', 60, 'dev-b', 20);
    expect(vegasBank(mergeStats(a, b))).toBe(60);
  });

  it('remembers only the most recent settled games', () => {
    let s = emptyStats();
    for (let i = 0; i < SETTLED_KEEP + 10; i++) s = settle(s, `g${i}`, 0);
    expect(s.vegas.settled).toHaveLength(SETTLED_KEEP);
    expect(isVegasSettled(s, `g${SETTLED_KEEP + 9}`)).toBe(true);
  });

  it('is kept when the other side has no bank at all', () => {
    const a = settle(emptyStats(), 'g1', -104);
    expect(vegasBank(mergeStats(a, { v: 1, played: 1, won: 0, bestMoves: null, ts: 50 }))).toBe(-104);
  });
});

describe('local persistence', () => {
  it('returns empty stats when nothing is stored', () => {
    expect(loadLocalStats()).toEqual(emptyStats());
  });

  it('round-trips stats', () => {
    const s = recordGameWon(recordGameStarted(emptyStats(), 1), 99, 2);
    saveLocalStats(s);
    expect(loadLocalStats()).toEqual(s);
  });

  it('returns empty stats for corrupt or wrong-version data', () => {
    localStorage.setItem('solitaire.stats.v1', 'not json');
    expect(loadLocalStats()).toEqual(emptyStats());
    localStorage.setItem('solitaire.stats.v1', JSON.stringify({ v: 99 }));
    expect(loadLocalStats()).toEqual(emptyStats());
  });

  it('round-trips and clears a save', () => {
    const save = { v: 1, t: ['', '', '', '', '', '', ''], f: ['', '', '', ''], s: '', w: '', m: 0, ts: 7 };
    expect(loadLocalSave()).toBe(null);
    saveLocalSave(save);
    expect(loadLocalSave()).toEqual(save);
    clearLocalSave();
    expect(loadLocalSave()).toBe(null);
  });

  it('returns null for a corrupt save', () => {
    localStorage.setItem('solitaire.save.v1', '{{{');
    expect(loadLocalSave()).toBe(null);
  });

  it('does not throw when localStorage is unavailable', () => {
    globalThis.localStorage = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
      removeItem() { throw new Error('denied'); },
    };
    expect(() => saveLocalStats(emptyStats())).not.toThrow();
    expect(loadLocalStats()).toEqual(emptyStats());
    expect(loadLocalSave()).toBe(null);
  });
});

describe('STATS_VERSION', () => {
  it('is 1', () => expect(STATS_VERSION).toBe(1));
});
