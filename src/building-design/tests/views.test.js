import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { filterMatches, viewGraphics, hiddenByFilters, restyle, templateSettings, applyTemplatePatch, propagateTemplate } from '../src/core/graphics.js';
import { clipSegment, clipPolygon, cropGraphics } from '../src/core/crop.js';
import { PlanBuilder } from '../src/core/plan.js';
import { scheduleRows, scheduleGroups } from '../src/core/schedule.js';
import { Scene } from '../src/core/scene.js';

describe('filters', () => {
  it('match by category and rules', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0], { comments: 'Fire rated 1 h' });
    const f = { categories: ['walls'], rules: [{ param: 'comments', op: 'contains', value: 'fire' }] };
    expect(filterMatches(doc, f, doc.get(w.id))).toBe(true);
    expect(filterMatches(doc, { ...f, rules: [{ param: 'comments', op: 'beginsWith', value: 'Smoke' }] }, doc.get(w.id))).toBe(false);
    expect(filterMatches(doc, { categories: ['doors'], rules: [] }, doc.get(w.id))).toBe(false);
    expect(filterMatches(doc, { categories: [], rules: [{ param: 'typeName', op: 'contains', value: 'Generic' }] }, doc.get(w.id))).toBe(true);
    expect(filterMatches(doc, { categories: [], rules: [{ param: 'mark', op: 'hasNoValue' }] }, doc.get(w.id))).toBe(true);
  });

  it('hide, restyle and halftone what they match', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [4000, 0], { comments: 'demo' });
    const f = add({ kind: 'viewFilter', name: 'Demo', categories: ['walls'], rules: [{ param: 'comments', op: 'equals', value: 'demo' }] });
    const view = { kind: 'plan', overrides: { walls: { color: '#00ff00' } }, filters: [{ id: f.id, visible: true, override: { color: '#ff0000', weight: 5, halftone: true } }] };
    const g = viewGraphics(doc, view, doc.get(w.id));
    expect(g).toEqual({ hidden: false, color: '#ff0000', weight: 5, halftone: true, transparency: 0 });
    expect(hiddenByFilters(doc, { filters: [{ id: f.id, visible: false }] }, doc.get(w.id))).toBe(true);
    const b = new PlanBuilder();
    b.line([0, 0], [1, 0], 1);
    const r = restyle(b, g);
    expect(r.lines[0].c.slice(0, 3)).toEqual([255, 0, 0]);
    expect(r.lines[0].w).toBe(5);
  });

  it('hidden filters remove elements from plan views', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [4000, 0], { comments: 'demo' });
    const f = add({ kind: 'viewFilter', name: 'Demo', categories: ['walls'], rules: [] });
    const view = doc.all('plan')[0];
    doc.transact('f', () => doc.update(view.id, { filters: [{ id: f.id, visible: false }] }));
    const scene = new Scene(doc);
    expect(scene.planCandidates(doc.get(view.id)).some((el) => el.id === w.id)).toBe(false);
  });
});

describe('view templates', () => {
  it('copy settings to the views that use them, and follow edits', () => {
    const { doc } = project();
    const [a, b] = doc.all('plan');
    doc.transact('s', () => doc.update(a.id, { scale: 50, detail: 'fine', hiddenCats: ['furniture'] }));
    let tpl;
    doc.transact('t', () => (tpl = doc.add({ kind: 'viewTemplate', name: 'T', viewKind: 'plan', settings: templateSettings(doc.get(a.id)) })));
    doc.transact('a', () => doc.update(b.id, applyTemplatePatch(tpl)));
    expect(doc.get(b.id).scale).toBe(50);
    expect(doc.get(b.id).hiddenCats).toEqual(['furniture']);
    doc.transact('e', () => {
      doc.update(tpl.id, { settings: { ...tpl.settings, detail: 'coarse' } });
      propagateTemplate(doc, tpl.id);
    });
    expect(doc.get(b.id).detail).toBe('coarse');
    expect(doc.get(a.id).detail).toBe('fine');
  });
});

describe('crop regions', () => {
  const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
  it('clip segments and polygons', () => {
    expect(clipSegment([-5, 5], [15, 5], r)).toEqual([
      [0, 5],
      [10, 5],
    ]);
    expect(clipSegment([-5, -5], [-1, 20], r)).toBeNull();
    const p = clipPolygon(
      [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      r,
    );
    expect(p.length).toBe(4);
    expect(Math.min(...p.map((q) => q[0]))).toBe(0);
  });

  it('drop graphics entirely outside', () => {
    const b = new PlanBuilder();
    b.line([20, 20], [30, 30], 1);
    expect(cropGraphics(b, r)).toBeNull();
    const c = new PlanBuilder();
    c.line([5, 5], [20, 5], 1);
    c.text([50, 50], 'x', { size: 1 });
    const cropped = cropGraphics(c, r);
    expect(cropped.lines[0].b).toEqual([10, 5]);
    expect(cropped.texts.length).toBe(0);
  });
});

describe('schedules', () => {
  const app = (doc) => ({ doc, scene: new Scene(doc) });

  it('take off materials layer by layer', () => {
    const { doc, wall } = project();
    wall([0, 0], [4000, 0], { typeId: 'wt-int-partition' });
    const view = { kind: 'schedule', category: 'materialTakeoff', fields: ['material', 'area', 'volume', 'count'], itemize: false };
    const rows = scheduleRows(app(doc), view);
    const gyp = rows.find((r) => r.values.material === 'Gypsum Wall Board');
    // Two gypsum layers over a 4 m x 3 m wall.
    expect(gyp.values.count).toBe(2);
    expect(Math.round(gyp.values.area / 1e6)).toBe(24);
  });

  it('filter and group rows', () => {
    const { doc, add } = project();
    add({ kind: 'sheet', number: 'A101', name: 'Plans', drawnBy: 'AB' });
    add({ kind: 'sheet', number: 'A201', name: 'Sections', drawnBy: 'CD' });
    add({ kind: 'sheet', number: 'S101', name: 'Framing', drawnBy: 'AB' });
    const view = { kind: 'schedule', category: 'sheetList', fields: ['number', 'name', 'drawnBy'], filter: [{ field: 'number', op: 'beginsWith', value: 'A' }] };
    expect(scheduleRows(app(doc), view).map((r) => r.values.number)).toEqual(['A101', 'A201']);
    const grouped = { ...view, filter: [], groupBy: 'drawnBy' };
    const groups = scheduleGroups(grouped, scheduleRows(app(doc), grouped));
    expect(groups.map((g) => [g.value, g.rows.length])).toEqual([
      ['AB', 2],
      ['CD', 1],
    ]);
  });
});
