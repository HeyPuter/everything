import { describe, expect, it } from 'vitest';
import { constrainColor, modeEnabled } from '../src/features/color/modes';
import { newDocument, type ColorMode, type PhotoDocument } from '../src/model/document';

const doc = (mode?: ColorMode, modeData?: PhotoDocument['modeData']): PhotoDocument => ({ ...newDocument(4, 4), mode, modeData });

describe('mode rules', () => {
  it('allows only the supported mode conversions', () => {
    expect(modeEnabled(doc(), 'bitmap')).toBe(false);
    expect(modeEnabled(doc(), 'duotone')).toBe(false);
    expect(modeEnabled(doc('grayscale'), 'bitmap')).toBe(true);
    expect(modeEnabled(doc('grayscale'), 'duotone')).toBe(true);
    expect(modeEnabled(doc('bitmap'), 'rgb')).toBe(false);
    expect(modeEnabled(doc('bitmap'), 'grayscale')).toBe(true);
    expect(modeEnabled(doc('cmyk'), 'indexed')).toBe(false);
    expect(modeEnabled(doc('duotone'), 'duotone')).toBe(true);
    expect(modeEnabled(doc('cmyk'), 'cmyk')).toBe(false);
    expect(modeEnabled(doc('lab'), 'cmyk')).toBe(true);
  });

  it('keeps painting colors inside the mode', () => {
    expect(constrainColor(doc(), '#ff0000')).toBe('#ff0000');
    expect(constrainColor(doc('cmyk'), '#ff0000')).toBe('#ff0000');
    const g = constrainColor(doc('grayscale', { profile: 'builtin:gray-gamma-22' }), '#ff0000');
    expect(g.slice(1, 3)).toBe(g.slice(3, 5));
    expect(g.slice(3, 5)).toBe(g.slice(5, 7));
    expect(constrainColor(doc('bitmap'), '#202020')).toBe('#000000');
    expect(constrainColor(doc('bitmap'), '#e0e0e0')).toBe('#ffffff');
    expect(constrainColor(doc('indexed', { palette: ['#000000', '#00ff00', '#ffffff'] }), '#22dd22')).toBe('#00ff00');
  });
});

describe('mode profiles', () => {
  it('uses the gray profile a duotone was made with, not the working gray', async () => {
    const { docGrayProfile } = await import('../src/features/color/profiles');
    const { builtinProfile } = await import('../src/color/color-management');
    const inks = [{ name: 'Black', color: '#000000' }, { name: 'Red', color: '#c03020', curve: [[0, 0], [50, 30], [100, 70]] as [number, number][] }];
    expect(docGrayProfile(doc('duotone', { profile: 'builtin:gray-gamma-18', inks })).key).toBe(builtinProfile('gray-gamma-18').key);
    expect(docGrayProfile(doc('grayscale', { profile: 'builtin:gray-gamma-18' })).key).toBe(builtinProfile('gray-gamma-18').key);
  });
});
