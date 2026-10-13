import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { objectsNamed, parseSetsData, exportSetsData, stepDetail } from '../src/features/panels/actions-model.js';
import { snapshotsOf, ensureOpenSnapshot } from '../src/features/panels/history.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

function setup() {
  const ed = app.newDocument({ name: 'Actions', width: 400, height: 300 });
  const doc = ed.doc;
  const p = createPath(rectangle(0, 0, 20, 20), true, { name: 'Badge' });
  doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
  const set = { id: `set-${Math.random()}`, name: 'Test', actions: [{ id: `act-${Math.random()}`, name: 'Test Action', steps: [] }] };
  app.actions.sets.push(set);
  const panel = app.dock.panels.get('actions');
  panel.ensureBuilt();
  panel.select({ kind: 'action', id: set.actions[0].id });
  return { ed, doc, p, panel, action: set.actions[0] };
}

const item = (panel, label) => panel.menu().find((x) => x.label === label);

describe('Actions panel menu', () => {
  it('inserts Select Object and Insert Selected Path steps that play back', async () => {
    const { ed, doc, p, panel, action } = setup();
    ed.select([p.id]);
    item(panel, 'Insert Selected Path').run();
    app.dialogs.form = async () => ({ name: 'Badge' });
    await item(panel, 'Select Object...').run();
    expect(action.steps.map((s) => s.kind)).toEqual(['path', 'select']);
    expect(stepDetail(action.steps[0])).toBe('1 path');
    expect(stepDetail(action.steps[1])).toBe('Badge');
    ed.clearSelection();
    const res = await app.actions.play(action.id);
    expect(res.ok).toBe(true);
    // The path step added a copy (also named Badge); Select Object selects both.
    expect(doc.layers()[0].children.length).toBe(2);
    expect(ed.topSelection().length).toBe(2);
    expect(objectsNamed(doc, 'Badge').length).toBe(2);
    // The new step kinds survive saving and loading.
    const back = parseSetsData(exportSetsData([{ name: 'x', actions: [action] }]));
    expect(back[0].actions[0].steps.map((s) => s.kind)).toEqual(['path', 'select']);
  });

  it('saves playback options and pauses between steps', async () => {
    const { panel } = setup();
    app.dialogs.form = async () => ({ mode: 'pause', pause: 0 });
    await item(panel, 'Playback Options...').run();
    expect(app.prefs.get('actionPlayback')).toEqual({ mode: 'pause', pause: 0 });
    app.prefs.set('actionPlayback', null);
  });

  it('clears actions after confirming', async () => {
    const { panel } = setup();
    app.dialogs.confirm = async () => true;
    await item(panel, 'Clear Actions').run();
    expect(app.actions.sets).toEqual([]);
    expect(panel.menu().find((x) => x.label === 'Reset Actions')).toBeTruthy();
    await item(panel, 'Reset Actions').run();
    expect(app.actions.sets.length).toBeGreaterThan(0);
  });
});

describe('History panel menu', () => {
  it('steps, takes named snapshots and restores them', async () => {
    const ed = app.newDocument({ name: 'History' });
    const doc = ed.doc;
    const panel = app.dock.panels.get('history');
    panel.ensureBuilt();
    const p = createPath(rectangle(0, 0, 20, 20), true);
    doc.transact('Add', () => doc.insert(p, doc.layers()[0].id));
    app.dialogs.form = async () => ({ name: 'Before Delete' });
    await item(panel, 'New Snapshot...').run();
    expect(snapshotsOf(doc).map((s) => s.name)).toContain('Before Delete');
    doc.transact('Delete', () => doc.remove(p.id));
    item(panel, 'Step Backward').run();
    expect(doc.has(p.id)).toBe(true);
    item(panel, 'Step Forward').run();
    expect(doc.has(p.id)).toBe(false);
    item(panel, 'Restore Snapshot').submenu.find((x) => x.label === 'Before Delete').run();
    expect(doc.has(p.id)).toBe(true);
    item(panel, 'Delete All Snapshots').run();
    expect(snapshotsOf(doc).filter((s) => !s.opened)).toEqual([]);
  });

  it('turns off the automatic first snapshot and step times', async () => {
    const panel = app.dock.panels.get('history');
    panel.ensureBuilt();
    app.dialogs.form = async () => ({ firstSnapshot: false, snapshotDialog: true, showTimes: false });
    await item(panel, 'History Options...').run();
    const ed = app.newDocument({ name: 'No snapshot' });
    ensureOpenSnapshot(ed, app.prefs);
    expect(snapshotsOf(ed.doc)).toEqual([]);
    ed.doc.transact('Add', () => ed.doc.insert(createPath(rectangle(0, 0, 5, 5), true), ed.doc.layers()[0].id));
    panel.visible = true;
    panel.key = null;
    panel.update();
    expect(panel.list.querySelector('.hp-row:not(.hp-base) .hp-time')).toBeNull();
    // Snapshots ask for a name now.
    app.dialogs.form = async () => ({ name: 'Named' });
    const snap = await panel.newSnapshot();
    expect(snap.name).toBe('Named');
    app.prefs.set('historyOptions', null);
  });
});
