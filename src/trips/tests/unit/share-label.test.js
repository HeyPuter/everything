// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { shareLabel } from '../../src/shared/share-label.js';
import { parseLabel } from '../../dev/fake-puter/shares.js';

describe('shareLabel', () => {
  it('keeps ordinary labels and trims them', () => {
    expect(shareLabel('  Lisbon · from alice ')).toBe('Lisbon · from alice');
    expect(shareLabel('')).toBeNull();
    expect(shareLabel(undefined)).toBeNull();
  });
  it('drops what Puter refuses and caps the length', () => {
    expect(shareLabel('Family 👨‍👩‍👧 trip')).toBe('Family 👨👩👧 trip');
    expect(shareLabel('line\nbreak here')).toBe('line break here');
    expect(shareLabel('‮evil')).toBe('evil');
    expect(shareLabel('é́́́́')).toBe('é́́');
    expect([...shareLabel('x'.repeat(300))]).toHaveLength(128);
    expect(new TextEncoder().encode(shareLabel('😀'.repeat(200))).length).toBeLessThanOrEqual(512);
  });
  it('always produces a label the platform accepts', () => {
    for (const text of ['Trip 🇵🇹 2027', 'a​‌b', 'ok\u0000\u001f', 'ü'.repeat(200), ' \t ', 'שלום · from dan', 'Z͓͔͕͑͒'.repeat(30)]) {
      expect(() => parseLabel(shareLabel(text))).not.toThrow();
    }
  });
});
