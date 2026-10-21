import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { phaseStatus, phaseLook, phasesInOrder } from '../src/core/phases.js';
import { paramDescriptors, paramFields } from '../src/core/params.js';
import { modelWarnings } from '../src/core/warnings.js';
import { Scene } from '../src/core/scene.js';
import { scheduleRows } from '../src/core/schedule.js';
import { viewGraphics } from '../src/core/graphics.js';

describe('phases', () => {
  it('new projects have existing and new construction phases', () => {
    const { doc } = project();
    expect(phasesInOrder(doc).map((p) => p.name)).toEqual(['Existing', 'New Construction']);
  });

  it('status and look follow the view phase and filter', () => {
    const { doc, wall } = project();
    const [existing, newPhase] = phasesInOrder(doc);
    const old = wall([0, 0], [4000, 0], { phaseId: existing.id });
    const gone = wall([0, 0], [0, 4000], { phaseId: existing.id, demolishedId: newPhase.id });
    const added = wall([4000, 0], [4000, 4000]);
    const inNew = { phaseId: newPhase.id, phaseFilter: 'all' };
    const inExisting = { phaseId: existing.id, phaseFilter: 'all' };
    expect(phaseStatus(doc, inNew, doc.get(old.id))).toBe('existing');
    expect(phaseStatus(doc, inNew, doc.get(gone.id))).toBe('demolished');
    expect(phaseStatus(doc, inNew, doc.get(added.id))).toBe('new');
    expect(phaseStatus(doc, inExisting, doc.get(added.id))).toBeNull();
    expect(phaseStatus(doc, inExisting, doc.get(gone.id))).toBe('new');
    expect(phaseLook(doc, inNew, doc.get(old.id))).toBe('halftone');
    expect(phaseLook(doc, inNew, doc.get(gone.id))).toBe('dashed');
    expect(phaseLook(doc, { ...inNew, phaseFilter: 'complete' }, doc.get(gone.id))).toBe('hidden');
    expect(phaseLook(doc, { ...inNew, phaseFilter: 'new' }, doc.get(old.id))).toBe('hidden');
  });

  it('plans leave out what does not exist in their phase', () => {
    const { doc, wall } = project();
    const [existing] = phasesInOrder(doc);
    const added = wall([4000, 0], [4000, 4000]);
    const plan = doc.all('plan')[0];
    doc.transact('p', () => doc.update(plan.id, { phaseId: existing.id }));
    const scene = new Scene(doc);
    expect(scene.planCandidates(doc.get(plan.id)).some((el) => el.id === added.id)).toBe(false);
  });
});

describe('project parameters', () => {
  it('appear on elements of their categories and in schedules', () => {
    const { doc, wall, add } = project();
    const p = add({ kind: 'projectParam', name: 'Fire Rating', type: 'text', categories: ['walls'], group: 'Identity Data' });
    const w = wall([0, 0], [4000, 0]);
    const [desc] = paramDescriptors(doc, doc.get(w.id));
    expect(desc.label).toBe('Fire Rating');
    doc.transact('set', () => doc.update(w.id, desc.set(doc.get(w.id), '1 h')));
    expect(doc.get(w.id).params[p.id]).toBe('1 h');
    expect(paramFields(doc, ['door'], () => 'doors')).toHaveLength(0);
    const rows = scheduleRows({ doc, scene: new Scene(doc) }, { kind: 'schedule', category: 'wall', fields: ['type', `param:${p.id}`] });
    expect(rows[0].values[`param:${p.id}`]).toBe('1 h');
  });
});

describe('object styles', () => {
  it('set the default look that view overrides replace', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0]);
    doc.setInfo({ objectStyles: { walls: { color: '#112233', weight: 2 } } });
    expect(viewGraphics(doc, { kind: 'plan' }, doc.get(w.id))).toMatchObject({ color: '#112233', weight: 2 });
    expect(viewGraphics(doc, { kind: 'plan', overrides: { walls: { color: '#ff0000' } } }, doc.get(w.id))).toMatchObject({ color: '#ff0000', weight: 2 });
  });
});

describe('warnings', () => {
  it('report overlapping walls, duplicate marks and unenclosed rooms', () => {
    const { doc, wall, add, L1 } = project();
    const a = wall([0, 0], [4000, 0]);
    const b = wall([2000, 0], [6000, 0]);
    const w = wall([0, 3000], [6000, 3000]);
    add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 1000, mark: '1' });
    add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 4000, mark: '1' });
    add({ kind: 'room', levelId: L1.id, at: [50000, 50000], name: 'Lost' });
    const ws = modelWarnings(doc, new Scene(doc));
    const msgs = ws.map((x) => x.message);
    expect(ws.find((x) => x.message.startsWith('Walls overlap')).ids.sort()).toEqual([a.id, b.id].sort());
    expect(msgs.some((m) => m.includes('same Mark'))).toBe(true);
    expect(msgs.some((m) => m.includes('not in a properly enclosed region'))).toBe(true);
  });
});
