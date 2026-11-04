// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { clipText } from '../src/core/text.js';
import { lookupTarget } from '../src/views/smart-lookup.js';
import { sanitizeName } from '../src/lib/puter.js';
import { fileNameForPrompt } from '../src/lib/imagegen.js';
import { LiveSession } from '../src/collab/live.js';
import { openFontDialog } from '../src/views/font-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';

// Text cut to a length is never left with half a character a reader sees: no lone surrogate, no accent without its
// letter, no part of a joined emoji or flag.
const whole = text => text.isWellFormed() && ![...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].some(s => /^[\p{M}‍\u{1f3fb}-\u{1f3ff}\u{1f1e6}-\u{1f1ff}]$/u.test(s.segment));
const family = '👨‍👩‍👧‍👦', flag = '🇯🇵', accented = 'é';

describe('clipText', () => {
  it('cuts at most to the length, between characters, keeping text within it as it is', () => {
    expect(clipText('short', 10)).toBe('short');
    expect(clipText('abcdef', 5)).toBe('abcde');
    expect(clipText('abcd😀', 5)).toBe('abcd');
    expect(clipText(`ab${family}cd`, 5)).toBe('ab');
    expect(clipText(`ab${flag}`, 4)).toBe('ab');
    expect(clipText(`caf${accented}s`, 4)).toBe('caf');
    expect(clipText(`caf${accented}s`, 5)).toBe(`caf${accented}`);
    // A character longer than the limit on its own stays whole rather than vanish.
    expect(clipText(`${family}x`, 3)).toBe(family);
    expect(clipText(null, 3)).toBe('');
    // A long text is cut without reading all of it.
    expect(clipText('a'.repeat(5e6) + '😀', 10)).toBe('a'.repeat(10));
  });
});

describe('labels cut from user text keep whole characters', () => {
  afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); });
  it('in Smart Lookup\'s phrase and sentence', () => {
    for (const at of [119, 118]) {
      const text = 'x'.repeat(at) + family + ' more words';
      const { phrase } = lookupTarget(text, 0, text.length);
      expect(phrase.length).toBeLessThanOrEqual(120);
      expect(whole(phrase)).toBe(true);
    }
    // The sentence reaches 200 code units each way from the term: an emoji at either edge is taken in whole.
    const text = `${'😀'.repeat(150)}term${'😀'.repeat(150)}`, start = 300;
    expect(whole(lookupTarget(text, start, start + 4).sentence)).toBe(true);
    const odd = `a${text}`;
    expect(whole(lookupTarget(odd, start + 1, start + 5).sentence)).toBe(true);
  });
  it('in file names', () => {
    expect(sanitizeName(`${'a'.repeat(199)}${accented}.docx`)).toBe('a'.repeat(199));
    expect(sanitizeName(`${'a'.repeat(196)}${family}`)).toBe('a'.repeat(196));
    expect(whole(fileNameForPrompt(`${'a'.repeat(39)}𝒜𝒜 fox`))).toBe(true);
  });
  it('in a collaborator\'s name on their caret', () => {
    const drawn = [];
    const ctx = { save() {}, restore() {}, fillRect() {}, measureText: t => ({ width: t.length }), fillText: t => drawn.push(t) };
    const session = { engine: { zoom: 1, positionGeometry: () => ({ page: 0, left: 0, top: 0, pageLeft: 0, pageTop: 0, height: 10 }) },
      remoteSelections: () => [{ name: `${'n'.repeat(23)}😀`, focus: 0 }, { name: `${'m'.repeat(22)}${flag}`, focus: 0 }] };
    LiveSession.prototype.drawCarets.call(session, ctx, 0);
    expect(drawn).toEqual(['n'.repeat(23), 'm'.repeat(22)]);
  });
  it('in the Font dialog\'s preview', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const modal = openFontDialog({ format: { fontAscii: 'Noto Sans', fontHAnsi: 'Noto Sans' }, sample: `${'x'.repeat(47)}😀 and more`, apply: () => true });
    const preview = modal.panel.querySelector('.ed-font-preview span');
    expect(preview.textContent).toBe('x'.repeat(47));
  });
});
