import { describe, expect, it } from 'vitest';
import {
  adjustPhoto,
  createCatalog,
  previewFilter,
  setFilter,
  setFlag,
  setRating,
  visiblePhotos,
} from '../src/engine/catalog.js';

describe('photo library catalog', () => {
  it('seeds photos', () => {
    expect(createCatalog().photos.length).toBeGreaterThanOrEqual(5);
  });

  it('sets ratings and flags', () => {
    let cat = createCatalog();
    cat = setRating(cat, 'p1', 5);
    cat = setFlag(cat, 'p1', 'pick');
    const p = cat.photos.find((x) => x.id === 'p1');
    expect(p.rating).toBe(5);
    expect(p.flag).toBe('pick');
  });

  it('applies non-destructive adjustments to preview filter', () => {
    let cat = createCatalog();
    cat = adjustPhoto(cat, 'p2', { exposure: 1, contrast: 1 });
    const p = cat.photos.find((x) => x.id === 'p2');
    expect(previewFilter(p.adjustments)).toContain('brightness');
  });

  it('filters by rating and tag', () => {
    let cat = createCatalog();
    cat = setFilter(cat, { minRating: 4, tag: 'travel' });
    const vis = visiblePhotos(cat);
    expect(vis.every((p) => p.rating >= 4)).toBe(true);
    expect(vis.every((p) => p.tags.includes('travel'))).toBe(true);
  });
});
