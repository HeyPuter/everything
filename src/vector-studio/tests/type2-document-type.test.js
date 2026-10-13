// Document Setup > Type: superscript, subscript and small caps sizes and
// positions, used by layout, drawing and export.
import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { layoutText, glyphPlacements, riseOf, TYPE_METRICS } from '../src/model/text-layout.js';
import { nodeBounds } from '../src/model/geometry.js';
import { documentSetupPatch } from '../src/features/files/document-setup.js';
import { typeMetricsOf, DEFAULT_TYPE_OPTIONS } from '../src/features/files/type-setup.js';
import { textPieces } from '../src/features/io/text-segments.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const dlg = () => document.querySelector('dialog[open]');
const button = (label) => [...dlg().querySelectorAll('button')].find((b) => b.textContent === label);

function addText(app, extra = {}) {
  const doc = app.editor.doc;
  const t = createText('H2O x2 Caps', 10, 50, { runs: [{ len: 1 }, { len: 1, position: 'sub' }, { len: 3 }, { len: 1, position: 'super' }, { len: 1 }, { len: 4, caps: 'small' }], ...extra });
  t.char = { ...t.char, fontSize: 20 };
  doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
  return doc.get(t.id);
}

describe('superscript, subscript and small caps settings', () => {
  it('converts document options to layout metrics, sharing one object per setting', () => {
    expect(typeMetricsOf({})).toBe(null);
    expect(typeMetricsOf({ typeOptions: { ...DEFAULT_TYPE_OPTIONS } })).toBe(null);
    const root = { typeOptions: { superSize: 50, superPos: 40, subSize: 60, subPos: 20, smallCaps: 80 } };
    const m = typeMetricsOf(root);
    expect(m).toEqual({ superSize: 0.5, superPos: 0.4, subSize: 0.6, subPos: 0.2, smallCaps: 0.8 });
    expect(typeMetricsOf(root)).toBe(m);
    expect(riseOf({ fontSize: 10, position: 'super' }, m)).toBeCloseTo(4);
    expect(riseOf({ fontSize: 10, position: 'sub' }, m)).toBeCloseTo(-2);
    expect(riseOf({ fontSize: 10, position: 'super' })).toBeCloseTo(10 * TYPE_METRICS.superPos);
  });

  it('documentSetupPatch stores changed script settings', () => {
    const root = { units: 'pt', bleed: 0, artboards: [{ w: 10, h: 10 }] };
    const p = documentSetupPatch(root, { typeOptions: { superSize: 50 } });
    expect(p.typeOptions).toMatchObject({ superSize: 50, subSize: 58.3, language: 'en' });
    expect(documentSetupPatch(root, { typeOptions: { superSize: 58.3 } })).toEqual({});
  });

  it('lays out with the document settings, and relays out on undo', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    const n = addText(app);
    const before = layoutText(n);
    expect(before.chars.size[1]).toBeCloseTo(20 * 0.583);
    expect(before.chars.size[5]).toBeCloseTo(20 * 0.583);
    expect(before.chars.size[8]).toBeCloseTo(20 * 0.7);
    const b0 = nodeBounds(doc, n);
    doc.transact('Document Setup', () => doc.updateRoot({ typeOptions: { ...DEFAULT_TYPE_OPTIONS, superSize: 80, superPos: 50, subSize: 40, subPos: 25, smallCaps: 90 } }));
    const after = layoutText(doc.get(n.id));
    expect(after).not.toBe(before);
    expect(after.chars.size[1]).toBeCloseTo(8);
    expect(after.chars.size[5]).toBeCloseTo(16);
    expect(after.chars.size[8]).toBeCloseTo(18);
    // The superscript sits half the type size above the baseline.
    const sup = glyphPlacements(after).find((g) => g.i === 5);
    const base = glyphPlacements(after).find((g) => g.i === 0);
    expect(base.m[5] - sup.m[5]).toBeCloseTo(10);
    // Export pieces follow the same rise.
    const piece = textPieces(doc.get(n.id)).items.find((it) => it.style.position === 'super');
    if (piece.y !== undefined && piece.base !== undefined) expect(piece.base - piece.y).toBeCloseTo(10);
    expect(nodeBounds(doc, doc.get(n.id))).not.toEqual(b0);
    doc.undo();
    expect(layoutText(doc.get(n.id)).chars.size[1]).toBeCloseTo(20 * 0.583);
    expect(nodeBounds(doc, doc.get(n.id))).toEqual(b0);
  });

  it('Document Setup edits and validates the settings', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    let done = app.commands.run('file.documentSetup');
    await tick();
    const d = dlg();
    expect(d.querySelector('#ds-superSize').value).toBe('58.3%');
    d.querySelector('#ds-smallCaps').value = '0';
    button('OK').click();
    await tick();
    expect(d.querySelector('.form-error').textContent).toMatch(/Small caps size must be between 1% and 200%/);
    d.querySelector('#ds-smallCaps').value = '75%';
    d.querySelector('#ds-subPos').value = '20';
    button('OK').click();
    await done;
    expect(app.editor.doc.root.typeOptions).toMatchObject({ smallCaps: 75, subPos: 20, superSize: 58.3 });
    done = app.commands.run('file.documentSetup');
    await tick();
    expect(dlg().querySelector('#ds-smallCaps').value).toBe('75%');
    button('Cancel').click();
    await done;
  });
});
