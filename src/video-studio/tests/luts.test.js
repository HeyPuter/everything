// Loading color lookup tables for the preview and the export.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ensureLuts, getLut, lutFailed, dropLut, lutIdsIn } from '../src/engine/luts.js';
import { createCompound } from '../src/model/compound.js';
import { createMulticam } from '../src/model/multicam-edit.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';

const CUBE = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const project = (id) => ({ tracks: [{ clips: [{ grade: { lut: { id, mix: 1 } } }] }] });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LUTs inside grouped and retained sources', () => {
  it.each(['compound', 'multicam'])('loads LUTs after reopening a nested %s', async (kind) => {
    const p = fixture();
    const id = `nested-${kind}`;
    const [a, b] = onMain(p, clip('video', 0, 1, { grade: { lut: { id, intensity: 100 } } }), clip('video', 1, 1, { grade: { lut: { id, intensity: 100 } } }));
    const group = kind === 'multicam' ? createMulticam(p, [a.id, b.id]) : createCompound(p, [a.id, b.id]);
    expect(group).toBeTruthy();
    createCompound(p, [group.id]);
    const reopened = normalizeProject(JSON.parse(JSON.stringify(p)));
    const library = { readLut: vi.fn(async () => ({ text: CUBE, name: 'Nested color' })) };
    try {
      expect([...lutIdsIn(reopened)]).toEqual([id]);
      expect(await ensureLuts(reopened, library)).toBe(true);
      expect(library.readLut).toHaveBeenCalledExactlyOnceWith(id);
      expect(getLut(id)?.size).toBe(2);
      await ensureLuts(reopened, library);
      expect(library.readLut).toHaveBeenCalledTimes(1);
    } finally {
      dropLut(id);
    }
  });

  it('includes retained transition partners and deduplicates their LUTs without loading other timelines', () => {
    const p = fixture();
    const [c] = onMain(p, clip('image', 0, 1, { grade: { lut: { id: 'main-grade' } } }));
    c.transitionSlices = [
      { partner: clip('image', 0, 1, { grade: { lut: { id: 'partner-grade' } } }) },
      { partner: clip('image', 0, 1, { grade: { lut: { id: 'main-grade' } } }) },
    ];
    p.timelineId = 'active';
    p.timelines = [{ id: 'inactive', tracks: [{ clips: [clip('image', 0, 1, { grade: { lut: { id: 'unused-grade' } } })] }] }];
    expect([...lutIdsIn(p)]).toEqual(['main-grade', 'partner-grade']);
    createCompound(p, [c.id]);
    expect([...lutIdsIn(p)]).toEqual(['main-grade', 'partner-grade']);
  });
});

describe('a LUT that could not be read', () => {
  it('is read again after a pause, so the grade comes back (and is exported)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reads = 0;
    const library = { readLut: async () => (++reads === 1 ? Promise.reject(new TypeError('Failed to fetch')) : { text: CUBE, name: 'Warm' }) };
    expect(await ensureLuts(project('net1'), library)).toBe(false);
    expect(lutFailed('net1')).toBe(false);
    // Not asked again on every change right away.
    await ensureLuts(project('net1'), library);
    expect(reads).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(await ensureLuts(project('net1'), library)).toBe(true);
    expect(getLut('net1')?.size).toBe(2);
    dropLut('net1');
  });

  it('gives up on a missing file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reads = 0;
    const library = { readLut: async () => (reads++, Promise.reject(new Error('LUT file missing'))) };
    await ensureLuts(project('gone1'), library);
    await ensureLuts(project('gone1'), library);
    expect(reads).toBe(1);
    expect(lutFailed('gone1')).toBe(true);
  });
});
