import { describe, expect, it } from 'vitest';
import { BUILTIN_CATEGORIES, CAT_ICONS, EXPLORE_CATEGORIES, categoryColor, categoryOf, categoryStyle, guessCategory, isBuiltin } from '../../src/lib/categories.js';
import { CAT_ICONS as WORKER_ICONS } from '../../worker/ops/trip/cat.js';

const space = (cats = {}) => ({ get: (type, id) => (type === 'cat' ? cats[id] ?? null : null) });

describe('place categories', () => {
  it('has the ten built-ins, and lodging places from bookings use one of them', () => {
    expect(BUILTIN_CATEGORIES.map((entry) => entry.id)).toEqual(['hotel', 'restaurant', 'attraction', 'shopping', 'transport', 'activity', 'bar', 'beach', 'nature', 'other']);
    expect(isBuiltin('hotel')).toBe(true);
    expect(categoryOf(space(), 'hotel')).toMatchObject({ id: 'hotel', name: 'Hotel', icon: 'bed-double', builtin: true });
    expect(categoryOf(space(), 'hotel')).not.toHaveProperty('missing');
    expect(Object.values(EXPLORE_CATEGORIES).every((entry) => isBuiltin(entry.cat))).toBe(true);
    expect(guessCategory({ key: 'tourism', value: 'hostel' })).toBe('hotel');
    expect(CAT_ICONS).toEqual(WORKER_ICONS);
  });

  it('reads older ids as their built-in and unknown ones as Other', () => {
    expect(categoryOf(space(), 'cafe')).toMatchObject({ id: 'bar', builtin: true });
    expect(categoryOf(space(), 'lodging').id).toBe('hotel');
    expect(categoryOf(space(), '0000000000000abc')).toMatchObject({ id: 'other', missing: true });
    expect(categoryOf(space(), undefined)).toMatchObject({ id: 'other' });
    expect(categoryOf(space(), undefined)).not.toHaveProperty('missing');
  });

  it('gives the map one style per category: built-ins, trip categories, hex colors and missing ones', () => {
    const cats = { c1: { id: 'c1', name: 'Viewpoints', color: 6, icon: 'camera' }, c2: { id: 'c2', name: 'Old', color: '#112233', icon: 'nope' }, c3: { id: 'c3', name: 'Gone', color: 2, icon: 'bus', deleted: true } };
    expect(categoryStyle('hotel', space(cats))).toEqual({ tone: 5, icon: 'bed-double', label: 'Hotel' });
    expect(categoryStyle('other', space(cats))).toEqual({ tone: 'ink-2', icon: 'map-pin', label: 'Other' });
    expect(categoryStyle('c1', space(cats))).toEqual({ tone: 6, icon: 'camera', label: 'Viewpoints' });
    expect(categoryStyle('c2', space(cats))).toEqual({ color: '#112233', icon: 'map-pin', label: 'Old' });
    expect(categoryStyle('c3', space(cats))).toEqual({ tone: 'ink-2', icon: 'map-pin', label: '' });
    expect(categoryColor(3)).toBe('var(--day-3)');
    expect(categoryColor('ink-2')).toBe('var(--ink-2, var(--ink-2))');
    expect(categoryColor('url(x)')).toBe('var(--ink-2)');
  });
});
