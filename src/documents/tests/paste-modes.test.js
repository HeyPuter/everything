import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { copyFragment, fragmentHtml, htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';
import { mergedFragment, pastePayload, availablePasteModes } from '../src/engine/paste-modes.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
function documentWith(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return doc;
}

function sourceHtml() {
  const source = documentWith(['Big red bold heading']);
  source.select(0); source.setParagraphStyle('Heading1');
  source.select(0, source.text.length); source.setRunFormat({ color: 'FF0000', fontSize: 20 });
  source.select(4, 7); source.setRunFormat({ italic: true });
  source.select(0, source.text.length + 1);
  return fragmentHtml(copyFragment(source));
}

it('keeps only emphasis when merging formatting and nothing when pasting text only', () => {
  const html = sourceHtml();
  const keep = documentWith(['Target: ']);
  keep.select(keep.text.length); pasteFragment(keep, htmlFragment(pastePayload('keep', { text: 'x', html }, fragmentHtml).html));
  const kept = keep.paragraphs.find(p => p.runs.some(r => r.text.includes('red')));
  expect(kept.runs.find(r => r.text.includes('red')).color).toBe('FF0000');

  const merge = documentWith(['Target: ']);
  merge.select(merge.text.length);
  const payload = pastePayload('merge', { text: 'Big red bold heading', html }, fragmentHtml);
  expect(pasteFragment(merge, htmlFragment(payload.html))).toBe(true);
  expect(merge.paragraphs).toHaveLength(1);
  expect(merge.text).toBe('Target: Big red bold heading');
  const runs = merge.paragraphs[0].runs;
  expect(runs.every(r => r.color === 'auto' && r.fontSize === 12)).toBe(true);
  expect(runs.find(r => r.text === 'red').italic).toBe(true);
  expect(merge.paragraphs[0].styleId ?? 'Normal').toBe('Normal');

  expect(pastePayload('text', { text: 'plain', html }, fragmentHtml)).toEqual({ text: 'plain', html: '' });
  expect(mergedFragment(null)).toBeNull();
  expect(availablePasteModes(merge, { html })).toEqual(['keep', 'merge', 'text']);
  expect(availablePasteModes(merge, { html: '' })).toEqual(['text']);
});
