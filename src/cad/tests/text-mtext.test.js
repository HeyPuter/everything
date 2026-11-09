import { describe, expect, it } from 'vitest';
import { LINE_PITCH, layoutMText, measureText, textBounds, mtextLines } from '../src/core/text/layout.js';

function mtext(props) {
  return { type: 'mtext', x: 0, y: 0, h: 1, rot: 0, value: '', width: 0, attach: 'tl', lineSpacing: 1, ...props };
}

describe('layoutMText', () => {
  it('splits paragraphs at newlines', () => {
    expect(layoutMText(mtext({ value: 'one\ntwo\nthree' })).lines).toBe(3);
    expect(layoutMText(mtext({ value: 'one' })).lines).toBe(1);
    // A backslash in the value is a real one (as in a path), not a break.
    expect(layoutMText(mtext({ value: 'See C:\\Projects\\Plans' })).lines).toBe(1);
  });

  it('wraps words at the width', () => {
    const w = measureText('aaa bbb', 1) + 0.01;
    expect(layoutMText(mtext({ value: 'aaa bbb ccc', width: w })).lines).toBe(2);
    expect(layoutMText(mtext({ value: 'aaa bbb ccc ddd eee', width: w })).lines).toBe(3);
    expect(layoutMText(mtext({ value: 'aaa bbb ccc', width: 0 })).lines).toBe(1);
    const narrow = measureText('aaa', 1) + 0.01;
    expect(layoutMText(mtext({ value: 'aaa bbb ccc', width: narrow })).lines).toBe(3);
  });

  it('drops spaces at a wrap instead of starting a line with them', () => {
    const w = measureText('Verify on site.', 1) + 0.01;
    const lines = (value) => mtextLines(mtext({ value, width: w })).map((l) => l.value);
    expect(lines('Verify on site.  All dimensions in mm.')).toEqual(['Verify on site.', 'All dimensions', 'in mm.']);
    // A trailing space that does not fit adds no empty line, so bottom-attached text stays put.
    const exact = measureText('GENERAL NOTES', 1) + 0.01;
    const a = layoutMText(mtext({ value: 'GENERAL NOTES ', width: exact, attach: 'bl' }));
    const b = layoutMText(mtext({ value: 'GENERAL NOTES', width: exact, attach: 'bl' }));
    expect(a.lines).toBe(1);
    expect(a.box).toEqual(b.box);
  });

  it('breaks overlong words', () => {
    const w = measureText('WWW', 1) + 0.01;
    expect(layoutMText(mtext({ value: 'WWWWWWWWWW', width: w })).lines).toBe(4);
  });

  it('wraps each paragraph separately', () => {
    const w = measureText('aaa', 1) + 0.01;
    expect(layoutMText(mtext({ value: 'aaa bbb\nccc', width: w })).lines).toBe(3);
  });

  it('sizes the box from line pitch and height', () => {
    const { box } = layoutMText(mtext({ value: 'one\ntwo', h: 2, lineSpacing: 1.5 }));
    const height = box[5] - box[1];
    expect(height).toBeCloseTo(LINE_PITCH * 2 * 1.5 + 2 * 1.3, 6);
    expect(LINE_PITCH).toBeCloseTo(1.6667, 4);
  });

  it('places the box by the attachment point', () => {
    const ent = mtext({ value: 'Hello\nWorld', x: 10, y: 20, width: 30 });
    const tl = layoutMText({ ...ent, attach: 'tl' }).box;
    expect(tl[6]).toBeCloseTo(10, 6);
    expect(tl[7]).toBeCloseTo(20, 6);
    expect(tl[2] - tl[0]).toBeCloseTo(30, 6);
    const br = layoutMText({ ...ent, attach: 'br' }).box;
    expect(br[2]).toBeCloseTo(10, 6);
    expect(br[3]).toBeCloseTo(20, 6);
    const mc = layoutMText({ ...ent, attach: 'mc' }).box;
    expect((mc[0] + mc[4]) / 2).toBeCloseTo(10, 6);
    expect((mc[1] + mc[5]) / 2).toBeCloseTo(20, 6);
  });

  it('puts the first cap line at the top for top attachment', () => {
    const { strokes } = layoutMText(mtext({ value: 'H', x: 0, y: 0, h: 2 }));
    let top = -Infinity,
      bottom = Infinity;
    for (const s of strokes) for (let i = 1; i < s.length; i += 2) {
      top = Math.max(top, s[i]);
      bottom = Math.min(bottom, s[i]);
    }
    expect(top).toBeCloseTo(0, 4);
    expect(bottom).toBeCloseTo(-2, 4);
  });

  it('aligns lines within the frame', () => {
    const ent = mtext({ value: 'I\nIIIIII', attach: 'tr' });
    const { strokes } = layoutMText(ent);
    let maxX = -Infinity;
    for (const s of strokes) for (let i = 0; i < s.length; i += 2) maxX = Math.max(maxX, s[i]);
    expect(maxX).toBeLessThanOrEqual(1e-9);
    expect(maxX).toBeGreaterThan(-0.2);
  });

  it('rotates the frame', () => {
    const { box } = layoutMText(mtext({ value: 'AB', x: 0, y: 0, width: 10, rot: Math.PI / 2 }));
    // Top-left corner stays at the insertion point; the top edge runs up +Y.
    expect(box[6]).toBeCloseTo(0, 6);
    expect(box[7]).toBeCloseTo(0, 6);
    expect(box[5]).toBeCloseTo(10, 6);
    expect(box[0]).toBeCloseTo(1.3, 6);
  });

  it('has bounds without strokes', () => {
    const ent = mtext({ value: 'one two three four', width: 5, x: 1, y: 1, attach: 'mc' });
    const { box } = layoutMText(ent);
    const b = textBounds(ent);
    expect(b[0]).toBeCloseTo(Math.min(box[0], box[6]), 6);
    expect(b[3]).toBeCloseTo(Math.max(box[5], box[7]), 6);
  });
});
