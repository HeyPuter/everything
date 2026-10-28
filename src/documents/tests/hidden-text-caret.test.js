import { afterEach, it, expect } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { revisionView } from '../src/engine/revisions.js';
import { hiddenRun, hiddenStretchAt, sameShownPlace } from '../src/engine/hidden-text.js';

const view = { ...revisionView, options: { ...revisionView.options } };
afterEach(() => { Object.assign(revisionView, { ...view, options: { ...view.options } }); });

// "Alpha beta gamma." with "beta " deleted and "new " inserted by a reviewer, then a second paragraph.
const del = { type: 'del', author: 'Ada', date: '2026-10-27T00:00:00Z', id: 1 };
const ins = { type: 'ins', author: 'Ada', date: '2026-10-27T00:00:00Z', id: 2 };
const doc = () => {
  const p = paragraph('');
  p.runs = [{ ...p.runs[0], text: 'Alpha ' }, { ...p.runs[0], text: 'beta ', revision: del }, { ...p.runs[0], text: 'new ', revision: ins }, { ...p.runs[0], text: 'gamma.' }];
  return [p, paragraph('Next')];
};

it('finds deleted text only in the views that hide it', () => {
  const paragraphs = doc();
  revisionView.mode = 'all';
  expect(hiddenStretchAt(paragraphs, 8)).toBeNull();
  for (const mode of ['simple', 'none']) {
    revisionView.mode = mode;
    expect(hiddenStretchAt(paragraphs, 8)).toEqual([6, 11]);
    // Touching it from either side counts; the visible text beyond does not.
    expect(hiddenStretchAt(paragraphs, 6)).toEqual([6, 11]);
    expect(hiddenStretchAt(paragraphs, 11)).toEqual([6, 11]);
    expect(hiddenStretchAt(paragraphs, 5)).toBeNull();
    expect(hiddenStretchAt(paragraphs, 16)).toBeNull();
    expect(sameShownPlace(paragraphs, 6, 11)).toBe(true);
    expect(sameShownPlace(paragraphs, 5, 11)).toBe(false);
  }
  // Original hides the insertion instead.
  revisionView.mode = 'original';
  expect(hiddenStretchAt(paragraphs, 13)).toEqual([11, 15]);
  expect(hiddenStretchAt(paragraphs, 8)).toBeNull();
  // A reviewer's changes hidden in All Markup read as accepted: the deletion is hidden.
  revisionView.mode = 'all'; revisionView.options.hiddenAuthors = ['Ada'];
  expect(hiddenStretchAt(paragraphs, 8)).toEqual([6, 11]);
});

it('treats hidden text as hidden only while hidden text is not shown', () => {
  const p = paragraph('');
  p.runs = [{ ...p.runs[0], text: 'Visible ' }, { ...p.runs[0], text: 'secret', vanish: true }, { ...p.runs[0], text: ' end' }];
  revisionView.showHidden = false;
  expect(hiddenRun(p.runs[1])).toBe(true);
  expect(hiddenStretchAt([p], 10)).toEqual([8, 14]);
  revisionView.showHidden = true;
  expect(hiddenRun(p.runs[1])).toBe(false);
  expect(hiddenStretchAt([p], 10)).toBeNull();
});
