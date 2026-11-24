import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const document = () => {
  const pkg = createDocx([paragraph('Body text')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  return new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
};
const named = (doc, name) => Object.values(doc.styles.definitions).filter(s => String(s.name).toLowerCase() === name.toLowerCase()).length;

it('gives no new or renamed style the name another style has', () => {
  const doc = document();
  doc.select(0, 4);
  const normal = Object.values(doc.styles.definitions).find(s => /^normal$/i.test(s.name)).name;
  expect(() => doc.createParagraphStyle(normal)).toThrow(`A style named “${normal}” already exists.`);
  expect(() => doc.createCharacterStyle(' HEADING 1 ')).toThrow('already exists');
  expect(named(doc, normal)).toBe(1); expect(named(doc, 'heading 1')).toBe(1);
  expect(doc.createParagraphStyle('Review body')).toBe(true);
  const id = doc.paragraphs[0].styleId;
  expect(() => doc.editParagraphStyle(id, { name: 'heading 2' })).toThrow('already exists');
  // Its own name, in other capitals, is no other style's.
  expect(doc.editParagraphStyle(id, { name: 'Review Body' })).toBe(true);
  expect(doc.styles.definitions[id].name).toBe('Review Body');
});
