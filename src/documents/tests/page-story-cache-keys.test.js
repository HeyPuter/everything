// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { layoutSerializer } from '../src/engine/page-story-measure.js';
import { DEFAULT_PAGE_SETTINGS, pageGeometry } from '../src/engine/page-settings.js';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';
import { emptyNumbering, newList } from '../src/engine/numbering.js';

const settings = { ...DEFAULT_PAGE_SETTINGS };
const metrics = text => ({ width: [...text].length * 6, ascent: 12, descent: 4 });
function remembering() {
  const cache = new ParagraphMeasureCache(), measure = text => metrics(text);
  measure.paragraphCache = () => cache;
  return { measure, cache };
}
const plainMeasure = text => metrics(text);
// Five pages of body text, each starting a new page.
const body = () => Array.from({ length: 5 }, (_, i) => paragraph(`Page ${i + 1} text`, i ? { format: { pageBreakBefore: true } } : {}));
const definition = header => ({ evenAndOdd: false, sections: [{ header: { default: 'header' }, footer: {} }], stories: { header } });
function layout(measure, paragraphs, def, numbering, serialize = layoutSerializer()) {
  measure.paragraphCache?.().nextGeneration();
  const placed = layoutDocument(paragraphs, measure, pageGeometry(settings), numbering, [], def, { serialize });
  return { body: placed, stories: layoutPageStories(placed, def, [settings], measure, numbering, { serialize }) };
}
const shown = stories => JSON.parse(JSON.stringify(stories.lines.map(line => ({ page: line.page, y: line.y, text: line.fragments.map(f => f.text).join(''), marker: line.listMarker ?? line.marker ?? null }))));

it('measures a header without page fields once for all its pages, and one with a page number once a page', () => {
  const { measure, cache } = remembering();
  const plain = layout(measure, body(), definition({ paragraphs: [paragraph('Running head')] }), emptyNumbering());
  expect(plain.body.pageCount).toBe(5);
  expect(plain.stories.lines.filter(line => line.pageStory === 'header')).toHaveLength(5);
  expect(cache.stories.size).toBe(1);

  const numbered = remembering();
  const field = { paragraphs: [paragraph('', { runs: [{ text: '￼', field: { type: 'PAGE', cachedText: '1' } }] })] };
  const { stories } = layout(numbered.measure, body(), definition(field), emptyNumbering());
  expect(stories.lines.map(line => line.fragments[0].text)).toEqual(['1', '2', '3', '4', '5']);
  // The body's header clearance and the painted header each measure it on every page.
  expect(numbered.cache.stories.size).toBeGreaterThanOrEqual(5);
});

it('lays a listed header out again when its list definition changes in place', () => {
  const numbering = emptyNumbering(), numId = newList(numbering, 'bullet');
  const header = { paragraphs: [paragraph('Listed head', { list: { numId, level: 0 } })] };
  const { measure } = remembering();
  layout(measure, body(), definition(header), numbering);
  // Commands change list definitions in place (newList, the list library); the remembered measurement must not survive it.
  const abstract = numbering.abstracts[numbering.instances[numId].abstractId];
  abstract.levels[0] = { ...abstract.levels[0], format: 'decimal', text: '%1)', geometry: { ...abstract.levels[0].geometry, indentLeft: 2880 } };
  const remembered = layout(measure, body(), definition(header), numbering);
  const fresh = layout(plainMeasure, body(), definition(header), numbering);
  expect(shown(remembered.stories)).toEqual(shown(fresh.stories));
  expect(JSON.stringify(remembered.stories.lines.map(line => line.fragments.map(f => [f.x, f.text])))).toBe(JSON.stringify(fresh.stories.lines.map(line => line.fragments.map(f => [f.x, f.text]))));
});

it('serializes each object once per layout and again for the next one', () => {
  const serialize = layoutSerializer(), value = { a: [1, 2] };
  const first = serialize(value);
  expect(serialize(value)).toBe(first);
  expect(serialize(null)).toBe('null');
  expect(serialize(undefined)).toBe('null');
  value.a.push(3);
  expect(layoutSerializer()(value)).toBe('{"a":[1,2,3]}');
});
