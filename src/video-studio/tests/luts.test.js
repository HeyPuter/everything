// Loading color lookup tables for the preview and the export.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ensureLuts, getLut, lutFailed, dropLut } from '../src/engine/luts.js';

const CUBE = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const project = (id) => ({ tracks: [{ clips: [{ grade: { lut: { id, mix: 1 } } }] }] });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
