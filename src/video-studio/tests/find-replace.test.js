import { describe, it, expect, beforeEach } from 'vitest';
import { findMatches, replaceAll, replaceOne, remapMarks, searchPattern, textClips } from '../src/model/find-replace.js';
import { addClip, findClip } from '../src/model/timeline.js';
import { createCompound } from '../src/model/compound.js';
import { EditorStore } from '../src/model/store.js';
import { openFindReplace } from '../src/ui/find-replace.js';
import { fixture, clip, s } from './helpers.js';

const FREE = { ripple: false, linkOverlays: false };

function withTexts(...lines) {
  const p = fixture();
  const clips = lines.map((text, i) => {
    const c = clip('text', i * 2, 2, { text, caption: i % 2 === 0 });
    addClip(p, c, FREE);
    return c;
  });
  return { p, clips };
}

describe('find and replace model', () => {
  it('builds case and whole-word patterns, escaping the query', () => {
    expect(searchPattern('')).toBeNull();
    expect('A.b a.b'.match(searchPattern('a.b')).length).toBe(2);
    expect('A.b a.b'.match(searchPattern('a.b', { matchCase: true })).length).toBe(1);
    expect('cat catalog cat.'.match(searchPattern('cat', { wholeWord: true })).length).toBe(2);
    expect("don't do".match(searchPattern('do', { wholeWord: true })).length).toBe(1);
  });

  it('finds matches in time order with their offsets', () => {
    const { p, clips } = withTexts('the cat sat', 'no match', 'Cat and cat');
    const m = findMatches(p, 'cat');
    expect(m.map((x) => [x.clipId, x.index])).toEqual([[clips[0].id, 4], [clips[2].id, 0], [clips[2].id, 8]]);
    expect(m[1].at).toBe(s(4));
    expect(findMatches(p, 'cat', { captionsOnly: true })).toHaveLength(3);
    expect(findMatches(p, 'match', { captionsOnly: true })).toHaveLength(0);
  });

  it('looks inside compound clips, timing matches on the open timeline', () => {
    const { p, clips } = withTexts('hello world');
    const comp = createCompound(p, [clips[0].id], FREE);
    expect(textClips(p)).toHaveLength(1);
    const [m] = findMatches(p, 'world');
    expect(m.clipId).toBe(clips[0].id);
    expect(m.at).toBe(comp.start);
  });

  it('replaces all in unlocked clips and reports the count', () => {
    const { p, clips } = withTexts('gonna go', 'gonna stay', 'Gonna');
    const lockedTrack = p.tracks.find((t) => t.clips.includes(clips[1]));
    // Put the second line on a locked track of its own.
    lockedTrack.clips = lockedTrack.clips.filter((c) => c !== clips[1]);
    p.tracks.unshift({ id: 'lk', kind: 'text', locked: true, hidden: false, muted: false, clips: [clips[1]] });
    expect(replaceAll(p, 'gonna', 'going to')).toBe(2);
    expect(clips.map((c) => c.text)).toEqual(['going to go', 'gonna stay', 'going to']);
    expect(replaceAll(p, '', 'x')).toBe(0);
  });

  it('never empties a text clip', () => {
    const { p, clips } = withTexts('um', 'um okay');
    expect(replaceAll(p, 'um', '', { wholeWord: true })).toBe(1);
    expect(clips.map((c) => c.text)).toEqual(['um', ' okay']);
  });

  it('keeps highlighted words on their words', () => {
    expect(remapMarks([1], 'a big dog', 'a huge dog')).toEqual([1]);
    expect(remapMarks([2], 'a big dog', 'a very big dog')).toEqual([3]);
    expect(remapMarks([1, 3], 'go big go home', 'go home')).toEqual([1]);
    const { p, clips } = withTexts('we won the cup');
    clips[0].marks = [3];
    replaceAll(p, 'won', 'finally won');
    expect(clips[0].marks).toEqual([4]);
    // A highlighted word swapped for another stays highlighted.
    replaceAll(p, 'cup', 'trophy');
    expect(clips[0].marks).toEqual([4]);
    // When the word goes away, so does its highlight.
    replaceAll(p, 'the trophy', 'it');
    expect(clips[0].marks).toBeUndefined();
  });

  it('replaces one match only when the text is unchanged since it was found', () => {
    const { p, clips } = withTexts('a cat and a cat');
    const [, second] = findMatches(p, 'cat');
    expect(replaceOne(clips[0], second, 'dog')).toBe(true);
    expect(clips[0].text).toBe('a cat and a dog');
    expect(replaceOne(clips[0], second, 'dog')).toBe(false);
  });
});

describe('find and replace dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('lists matches, jumps to one and replaces all in one undo step', () => {
    const { p, clips } = withTexts('red apple', 'green apple', 'pear');
    const store = new EditorStore(p);
    const d = openFindReplace({ store }, { query: 'apple' });
    const el = d.el;
    expect(el.querySelector('.fr-count').textContent).toBe('2 matches in 2 clips');
    const rows = el.querySelectorAll('.fr-go');
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('mark').textContent).toBe('apple');
    rows[1].click();
    expect(store.time).toBe(s(2));
    expect([...store.selection]).toEqual([clips[1].id]);
    el.querySelector('input[aria-label="Replace with"]').value = 'plum';
    [...el.querySelectorAll('button')].find((b) => b.textContent === 'Replace all').click();
    expect(clips.map((c) => findClip(store.project, c.id).clip.text)).toEqual(['red plum', 'green plum', 'pear']);
    expect(el.querySelector('.fr-count').textContent).toBe('No matches');
    store.undo();
    expect(findClip(store.project, clips[0].id).clip.text).toBe('red apple');
    expect(store.history.canUndo()).toBe(false);
    d.close();
  });

  it('replaces a single match and remembers its options', () => {
    const { p, clips } = withTexts('Hi hi');
    const store = new EditorStore(p);
    const d = openFindReplace({ store }, { query: 'hi' });
    const caseBtn = d.el.querySelector('[aria-label="Match case"]');
    caseBtn.click();
    expect(caseBtn.getAttribute('aria-pressed')).toBe('true');
    expect(d.el.querySelectorAll('.fr-item')).toHaveLength(1);
    d.el.querySelector('input[aria-label="Replace with"]').value = 'yo';
    d.el.querySelector('.fr-one').click();
    expect(findClip(store.project, clips[0].id).clip.text).toBe('Hi yo');
    d.close();
    const again = openFindReplace({ store });
    expect(again.el.querySelector('[aria-label="Match case"]').getAttribute('aria-pressed')).toBe('true');
    again.close();
  });
});
