import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { RUN_FORMAT } from '../src/engine/formatting.js';
import { createSharedDoc, readState, unsupportedReason } from '../src/collab/shared-doc.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

function fixtures() {
  const out = [];
  const walk = dir => { for (const name of readdirSync(dir).sort()) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (name.endsWith('.docx')) out.push(p); } };
  walk('tests/fixtures');
  return out;
}
const SAMPLE = Number(process.env.COLLAB_FIXTURE_STEP || 61);

it('round-trips real documents through the shared document', async () => {
  const files = fixtures().filter((_, i) => i % SAMPLE === 0);
  let checked = 0;
  for (const file of files) {
    let pkg;
    try { pkg = await DocxPackage.open(readFileSync(file)); } catch { continue; }
    if (pkg.readOnly) continue;
    let model;
    try { model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { comments: pkg.comments, trackChanges: pkg.trackRevisions }); } catch { continue; }
    const state = { paragraphs: model.paragraphs, tables: model.tables, styles: model.styles, stylesEnabled: model.stylesEnabled, numbering: model.numbering, pageSettings: model.pageSettings, comments: model.comments, trackChanges: model.trackChanges, stories: {} };
    if (unsupportedReason(state)) continue;
    const back = readState(createSharedDoc(state));
    const strip = ps => JSON.parse(JSON.stringify(ps));
    // A missing run property reads as its default.
    // Empty runs carry nothing a reader sees, and neighbouring runs with the same properties are one run.
    const SEPARATE = ['image', 'math', 'field', 'noteMark', 'bodySymbol', 'noBreakHyphen', 'breakClear'];
    const merged = runs => runs.reduce((out, r) => {
      if (!r.text) return out;
      const last = out.at(-1), same = last && !SEPARATE.some(k => last[k] || r[k]) && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...r, text: '' });
      if (same) last.text += r.text; else out.push({ ...r });
      return out;
    }, []);
    const normal = ps => strip(ps).map(p => ({ ...p, runs: merged(p.runs.map(r => ({ ...RUN_FORMAT, ...r }))) }));
    const a = normal(back.paragraphs), b = normal(model.paragraphs);
    expect(a.length, file).toBe(b.length);
    for (let i = 0; i < a.length; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) expect(a[i], `${file} paragraph ${i}`).toEqual(b[i]);
    expect(back.tables, file).toEqual(strip(model.tables));
    expect(back.numbering, file).toEqual(strip(model.numbering));
    expect(back.styles, file).toEqual(strip(model.styles));
    expect(back.comments, file).toEqual(model.comments === null ? null : strip(model.comments));
    // The rebuilt model accepts the projection (tables and blocks validate).
    new TextDocument(back.paragraphs, back.pageSettings, back.numbering, back.stylesEnabled ? back.styles : undefined, back.tables, pkg.assets, { comments: back.comments });
    checked++;
  }
  expect(checked).toBeGreaterThan(8);
}, 600000);
