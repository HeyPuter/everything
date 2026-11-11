// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { getMovie, movieCacheStats, releaseUnusedMedia } from '../../src/sequencer/media';

describe('movie resources', () => {
  it('releases movies no strip uses any more (after the grace period), revoking their URLs', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      created.push(`blob:${created.length}`);
      return created[created.length - 1];
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    const kept = new Uint8Array(4);
    const dropped = new Uint8Array(4);
    const a = getMovie(kept, 'video/webm');
    const b = getMovie(dropped, 'video/webm');
    expect(movieCacheStats().movies).toBe(2);
    // within the grace period nothing is freed (a movie being added is not in the document yet)
    expect(releaseUnusedMedia(new Set([kept]))).toBe(true);
    expect(movieCacheStats().movies).toBe(2);
    expect(releaseUnusedMedia(new Set([kept]), 0)).toBe(false);
    expect(movieCacheStats().movies).toBe(1);
    expect(revoked).toEqual([b.url]);
    // the kept movie is still the cached one; the dropped one is recreated on demand
    expect(getMovie(kept, 'video/webm')).toBe(a);
    expect(getMovie(dropped, 'video/webm')).not.toBe(b);
    releaseUnusedMedia(new Set(), 0);
    expect(movieCacheStats().movies).toBe(0);
    vi.restoreAllMocks();
  });
});
