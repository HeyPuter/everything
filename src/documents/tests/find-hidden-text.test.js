// @vitest-environment jsdom
import { afterEach, it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { revisionView } from '../src/engine/revisions.js';
import { findReplacePanel } from '../src/views/find-replace.js';

const view = { ...revisionView, options: { ...revisionView.options } };
afterEach(() => { Object.assign(revisionView, { ...view, options: { ...view.options } }); });

// "Alpha [beta ]gamma beta secret", with the first "beta " deleted by a reviewer and "secret" hidden text.
const doc = () => {
  const p = paragraph(''), base = p.runs[0];
  p.runs = [{ ...base, text: 'Alpha ' }, { ...base, text: 'beta ', revision: { type: 'del', author: 'Ada', date: '2026-10-27T00:00:00Z' } }, { ...base, text: 'gamma beta ' }, { ...base, text: 'secret', vanish: true }];
  return new TextDocument([p]);
};
// The paragraph's text in stretches of one kind: shown, deleted or hidden.
const runs = d => d.paragraphs[0].runs.reduce((out, r) => {
  const kind = r.revision?.type || (r.vanish ? 'hidden' : '');
  if (out.at(-1)?.[1] === kind) out.at(-1)[0] += r.text; else out.push([r.text, kind]);
  return out;
}, []);

it.each([[false], [true]])('Find and replace (advanced: %s) passes over what the view hides', advanced => {
  revisionView.mode = 'simple';
  const d = doc(), options = { visibleOnly: true, ...(advanced ? { advanced: true } : {}) };
  expect(d.findMatches('beta', options).map(m => m.start)).toEqual([17]);
  expect(d.findMatches('secret', options)).toEqual([]);
  // Replacing every match leaves the deletion no one sees deleted, rather than making it visible new text.
  expect(d.replaceMatches('beta', 'BETA', options, true)).toBe(1);
  expect(runs(d)).toEqual([['Alpha ', ''], ['beta ', 'del'], ['gamma BETA ', ''], ['secret', 'hidden']]);
  // Shown, they are found again; and searches for other purposes (Mark All for an index) still find every one.
  revisionView.mode = 'all'; revisionView.showHidden = true;
  expect(d.findMatches('secret', options).length).toBe(1);
  expect(d.findMatches('beta', options).map(m => m.start)).toEqual([6, 17]);
  revisionView.mode = 'simple'; revisionView.showHidden = false;
  expect(doc().findMatches('beta', {}).map(m => m.start)).toEqual([6, 17]);
});

it('the Find and Replace panel searches only what the view shows', () => {
  const calls = [];
  const panel = findReplacePanel({ matches: (q, o) => { calls.push(o); return []; }, range: () => [0, 0], select() {}, replace: () => 0, close() {} });
  panel.open('beta');
  expect(calls.at(-1)).toMatchObject({ visibleOnly: true });
});
