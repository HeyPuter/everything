import { describe, expect, it } from 'vitest';
import { StyleRequests } from '../src/features/type/style-requests';

type Style = { size: number; color: string; superscript: boolean; subscript: boolean };

describe('pending text formatting', () => {
  it('retains independent properties after a newer overlapping request completes', () => {
    const pending = new StyleRequests<Style>();
    const owner = {};
    const older = pending.begin(owner, ['a', 'b'], { size: 48, color: 'red' });
    const revision = older.revision('a');
    const newer = pending.begin(owner, ['a'], { size: 72 });
    newer.finish();
    expect(older.patch('a')).toEqual({ color: 'red' });
    expect(older.patch('b')).toEqual({ size: 48, color: 'red' });
    expect(older.revision('a')).not.toBe(revision);
    expect(older.isCurrent('a')).toBe(true);
  });

  it('keeps matching layer IDs in different documents independent', () => {
    const pending = new StyleRequests<Style>();
    const first = pending.begin({}, ['a'], { size: 48 });
    const second = pending.begin({}, ['a'], { size: 72 });
    second.finish();
    expect(first.patch('a')).toEqual({ size: 48 });
  });

  it('does not let an older completion release a newer request', () => {
    const pending = new StyleRequests<Style>();
    const owner = {};
    const older = pending.begin(owner, ['a'], { size: 48 });
    const newer = pending.begin(owner, ['a'], { size: 48 });
    older.finish();
    expect(newer.patch('a')).toEqual({ size: 48 });
    expect(older.isCurrent('a')).toBe(false);
  });

  it('cancels the implicit effects of a superseded mutually exclusive control', () => {
    const pending = new StyleRequests<Style>([['superscript', 'subscript']]);
    const owner = {};
    const older = pending.begin(owner, ['a'], { superscript: true, color: 'red' });
    const newer = pending.begin(owner, ['a'], { subscript: false });
    expect(older.patch('a')).toEqual({ color: 'red' });
    expect(newer.patch('a')).toEqual({ subscript: false });
    newer.finish();
    expect(older.patch('a')).toEqual({ color: 'red' });
  });

  it('does not treat an undefined property as a later choice', () => {
    const pending = new StyleRequests<Style>();
    const owner = {};
    const older = pending.begin(owner, ['a'], { size: 48 });
    const newer = pending.begin(owner, ['a'], { size: undefined });
    expect(newer.isCurrent('a')).toBe(false);
    newer.finish();
    expect(older.patch('a')).toEqual({ size: 48 });
  });
});
