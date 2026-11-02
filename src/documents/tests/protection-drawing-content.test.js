import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { protectionGuard } from '../src/engine/protection.js';

// Locked tracking (documentProtection w:edit="trackedChanges", §17.15.1.29): text in a text box, a shape, a chart or
// a diagram is document content like any other, and changing it here cannot be recorded as a tracked change.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

async function locked(file) {
  const pkg = await DocxPackage.open(readFileSync(file));
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  model.trackChanges = true; model.revisionAuthor = 'Reviewer';
  const session = new StorySession(model);
  session.guard = protectionGuard({ enforcement: true, edit: 'trackedChanges' });
  return { pkg, model, session };
}
const drawings = model => model.paragraphs.flatMap(p => p.runs).filter(r => r.image).map(r => r.image);
const selectDrawing = (model, image) => {
  let at = 0;
  for (const p of model.paragraphs) {
    for (const r of p.runs) { if (r.image === image) return model.select(at, at + 1); at += r.text.length; }
    at += 1;
  }
};
const refusal = (session, action) => { try { session.run(action); } catch (e) { return e.message; } return null; };

async function editedFrame(pkg, model, image, from, to) {
  const frame = pkg.drawingTextFrames(image)[0];
  const draft = new TextDocument(frame.paragraphs, undefined, pkg.numbering, pkg.styles, frame.tables, pkg.assets);
  const at = draft.text.indexOf(from); draft.select(at, at + from.length); draft.replace(to);
  return pkg.prepareDrawingTextEdit(image, 0, draft.paragraphs, model.assets, model.styles, model.numbering, draft.tables);
}

it('refuses a text box’s or shape’s new text while tracking is locked', async () => {
  const { pkg, model, session } = await locked('tests/fixtures/drawing-text-pictures/control.docx');
  const image = drawings(model)[0];
  const prepared = await editedFrame(pkg, model, image, 'Before', 'Rewritten');
  model.assets.edited = prepared.asset;
  selectDrawing(model, image);
  expect(refusal(session, m => m.replaceDrawingText(image, 'edited', prepared.shell))).toBe('This change can’t be tracked, and tracking is locked. Unlock tracking to make it.');
  expect(drawings(model)[0].assetId).toBe(image.assetId);
  const saved = strFromU8(unzipSync(new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer()))['word/document.xml']);
  expect(saved).not.toContain('Rewritten');
});

it('still lets a drawing be deleted as a tracked change, and the text of a drawing the reviewer inserted be written', async () => {
  const { pkg, model, session } = await locked('tests/fixtures/drawing-text-pictures/control.docx');
  // Text in a drawing this reviewer inserted is part of their tracked insertion.
  const inserted = drawings(model)[0];
  model.paragraphs.flatMap(p => p.runs).find(r => r.image === inserted).revision = { type: 'ins', author: 'Reviewer', date: '2026-11-02T00:00:00Z' };
  const prepared = await editedFrame(pkg, model, inserted, 'Before', 'Their own words');
  model.assets.own = prepared.asset;
  selectDrawing(model, inserted);
  expect(refusal(session, m => m.replaceDrawingText(inserted, 'own', prepared.shell))).toBeNull();
  // Deleting a drawing is tracked.
  const fresh = await locked('tests/fixtures/drawing-text-pictures/control.docx'), [first] = drawings(fresh.model);
  selectDrawing(fresh.model, first);
  expect(refusal(fresh.session, m => m.replace(''))).toBeNull();
  expect(fresh.model.paragraphs.flatMap(p => p.runs).find(r => r.image === first).revision.type).toBe('del');
});

it('refuses a chart’s new data while tracking is locked', async () => {
  const { model, session } = await locked('public/fixtures/chart-direct-colors.docx');
  const chart = drawings(model).find(i => i.kind === 'chart'), asset = model.assets[chart.assetId];
  model.assets.changed = { ...asset, chart: { ...asset.chart, series: asset.chart.series.map((s, i) => i ? s : { ...s, values: [9, 9, 9, 9] }) } };
  // As Edit Data replaces a chart: the same frame, a new chart part.
  const replace = (m, assetId) => { m.checkpoint(); for (const p of m.paragraphs) for (const r of p.runs) if (r.image?.assetId === chart.assetId) r.image = { ...r.image, assetId }; m.didChange(); };
  expect(refusal(session, m => replace(m, 'changed'))).toMatch(/can’t be tracked/);
  expect(drawings(model)[0].assetId).toBe(chart.assetId);
  // A chart restyled with the same data is a formatting change, as resizing is.
  model.assets.restyled = { ...asset, chart: { ...asset.chart, series: asset.chart.series.map(s => ({ ...s, fill: '#123456' })) } };
  expect(refusal(session, m => replace(m, 'restyled'))).toBeNull();
  expect(drawings(model)[0].assetId).toBe('restyled');
});
