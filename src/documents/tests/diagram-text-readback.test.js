import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readDrawingFragment } from '../src/engine/inserted-drawings.js';
import { DIAGRAM_LAYOUTS, DEFAULT_OUTLINE, parseOutline, outlineText, diagramDrawingXml, diagramDescription, parseDiagramDescription, diagramItemsFromTexts, diagramDescriptionAfterTextEdit } from '../src/engine/diagram-builder.js';

// A diagram keeps the outline it was made from as its description (wp:docPr descr), which Edit Diagram reads
// back. Text typed into its shapes (Edit drawing text) is read back into that outline, so the description and
// Edit Diagram say what the shapes show instead of bringing the old text back.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
// The drawing as the document holds it: its whole w:drawing (the shell) and its description.
const drawn = async (layout, items) => (await readDrawingFragment(diagramDrawingXml({ layout, items, id: 1 }))).image;
const frames = xml => [...new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS(WPS, 'txbx')]
  .map(box => [...box.getElementsByTagNameNS(W, 'p')].map(p => [...p.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join('')).join('\n'));

it('every layout reads its own shapes back to the outline it was made from', async () => {
  const items = parseOutline('CEO\n  Sales\n    East\n  Support\nBoard\n  Audit\nAdvisors');
  for (const layout of DIAGRAM_LAYOUTS) {
    const image = await drawn(layout.id, items);
    expect(diagramItemsFromTexts(layout.id, items, frames(image.shell)), layout.id).toEqual(items);
    expect(diagramDescriptionAfterTextEdit(image.alt, image.shell), layout.id).toBeNull();
  }
});

it('a word changed in any shape of any layout changes that item only', async () => {
  const items = parseOutline(DEFAULT_OUTLINE);
  for (const layout of DIAGRAM_LAYOUTS) {
    const image = await drawn(layout.id, items);
    const edited = image.shell.replace('>Build<', '>Build and test<');
    if (edited === image.shell) continue; // A layout that does not show this item.
    const alt = diagramDescriptionAfterTextEdit(image.alt, edited);
    expect(alt, layout.id).toBe(diagramDescription(layout.id, parseOutline(DEFAULT_OUTLINE.replace('Build', 'Build and test'))));
  }
});

it('lines added to or removed from a shape that lists sub-items become or stop being sub-items', async () => {
  const items = parseOutline(DEFAULT_OUTLINE);
  // Basic Process: "Plan", "• Goals", "• Budget" in one shape.
  const texts = frames((await drawn('basicProcess', items)).shell);
  expect(texts[0]).toBe('Plan\n• Goals\n• Budget');
  expect(outlineText(diagramItemsFromTexts('basicProcess', items, ['Planning', ...texts.slice(1)]))).toBe('Planning\nBuild\n  Prototype\nReview\nLaunch');
  expect(outlineText(diagramItemsFromTexts('basicProcess', items, ['Plan\n• Goals\n• Budget\n• Risks', ...texts.slice(1)]))).toBe('Plan\n  Goals\n  Budget\n  Risks\nBuild\n  Prototype\nReview\nLaunch');
  // A sub-item keeps its own sub-items (which this layout does not show) when its text changes.
  const deep = parseOutline('Plan\n  Goals\n    Revenue\nBuild');
  const deepTexts = frames((await drawn('basicProcess', deep)).shell);
  expect(outlineText(diagramItemsFromTexts('basicProcess', deep, ['Plan\n• Targets', ...deepTexts.slice(1)]))).toBe('Plan\n  Targets\n    Revenue\nBuild');
  // A shape emptied keeps its item; a shape the drawing no longer has leaves the outline as it was.
  expect(diagramItemsFromTexts('basicProcess', items, ['', ...texts.slice(1)])).toEqual(items);
  expect(diagramItemsFromTexts('basicProcess', items, texts.slice(1))).toBeNull();
});

it('leaves descriptions that are not a diagram outline alone', async () => {
  const image = await drawn('basicProcess', parseOutline(DEFAULT_OUTLINE)), edited = image.shell.replace('>Plan<', '>Plans<');
  expect(diagramDescriptionAfterTextEdit('A photo of the team', edited)).toBeNull();
  expect(parseDiagramDescription(diagramDescriptionAfterTextEdit(image.alt, edited)).items[0].text).toBe('Plans');
});
