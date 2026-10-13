import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { documentReport, CATEGORIES } from '../src/features/panels/document-info-panel.js';
import { paintInfo } from '../src/features/artboards/info-panel.js';

let app;
beforeEach(async () => {
  app = await bootAppWithFeatures();
});

function build() {
  const ed = app.newDocument({ name: 'Spots' });
  const doc = ed.doc;
  const layer = doc.layers()[0];
  const ids = [];
  doc.transact('Build', () => {
    doc.updateRoot({
      swatches: [
        { id: 'sp1', name: 'Signal Orange', global: true, spot: true, paint: { type: 'solid', color: '#ff6600' } },
        { id: 'g1', name: 'Brand Blue', global: true, paint: { type: 'solid', color: '#0033cc' } },
      ],
    });
    const add = (style) => {
      const n = createPath(rectangle(0, 0, 10, 10), true, style);
      doc.insert(n, layer.id);
      ids.push(n.id);
    };
    add({ fill: { type: 'solid', color: '#ff6600', swatchId: 'sp1' }, stroke: { type: 'solid', color: '#ff6600', swatchId: 'sp1' } });
    add({ fill: { type: 'solid', color: '#ffb380', swatchId: 'sp1', tint: 0.5 } });
    add({ fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff6600', swatchId: 'sp1' }, { offset: 1, color: '#ffffff' }] } });
    add({ fill: { type: 'solid', color: '#0033cc', swatchId: 'g1' } });
  });
  return { ed, ids };
}

describe('Document Info: spot color objects', () => {
  it('lists the spot colors objects use, apart from global process colors', () => {
    const { ed } = build();
    expect(CATEGORIES.some((c) => c.id === 'spotColors' && c.label === 'Spot Color Objects')).toBe(true);
    const r = Object.fromEntries(documentReport(ed).map((s) => [s.id, s]));
    expect(r.spotColors.items).toEqual(['Signal Orange: 3 objects']);
    expect(r.globalColors.items).toEqual(['Brand Blue: 1 use']);
    expect(r.swatches.items).toContain('Signal Orange (spot)');
  });

  it('respects Selection Only', () => {
    const { ed, ids } = build();
    ed.select([ids[3]]);
    const r = Object.fromEntries(documentReport(ed, { selectionOnly: true }).map((s) => [s.id, s]));
    expect(r.spotColors.items).toEqual([]);
  });
});

describe('Info panel: spot color names', () => {
  it('names a spot color and its tint', () => {
    const { ed } = build();
    expect(paintInfo({ type: 'solid', color: '#ff6600', swatchId: 'sp1' }, 'RGB', ed.doc)).toBe('Signal Orange 100%');
    expect(paintInfo({ type: 'solid', color: '#ffb380', swatchId: 'sp1', tint: 0.5 }, 'CMYK', ed.doc)).toBe('Signal Orange 50%');
    expect(paintInfo({ type: 'solid', color: '#0033cc', swatchId: 'g1' }, 'RGB', ed.doc)).toMatch(/^R 0 {2}G 51/);
  });

  it('shows in the panel for the selection', () => {
    const { ed, ids } = build();
    ed.select([ids[0]]);
    app.openPanel('info');
    const panel = app.dock.panels.get('info');
    panel.ensureBuilt?.();
    panel.update();
    expect(panel.fillTxt.textContent).toBe('Signal Orange 100%');
    expect(panel.strokeTxt.textContent).toMatch(/^Signal Orange 100%/);
  });
});
