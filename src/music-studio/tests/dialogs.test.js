import { describe, it, expect } from 'vitest';
import { applyProjectSettings, projectInfo, openProjectSettings } from '../src/dialogs/project-settings.js';
import { shortcutGroups } from '../src/dialogs/shortcuts.js';
import { historyEntries, tapBpm, purgeUnused } from '../src/dialogs/tools.js';
import { stemInserts } from '../src/dialogs/export.js';
import { formatWhen } from '../src/dialogs/open-local.js';
import { Store } from '../src/model/store.js';
import { Commands } from '../src/commands/registry.js';
import * as E from '../src/model/edits.js';
import { demoProject, newProject } from '../src/model/demo.js';
import { createChannel } from '../src/model/project.js';

describe('project settings', () => {
  it('applies every value in one undo step', () => {
    const store = new Store(demoProject());
    const before = store.project;
    store.apply('Project settings', (p) => applyProjectSettings(p, { name: ' Night Drive ', bpm: 98.5, sig: [7, 8], swing: 0.3, masterPitch: -50 }));
    expect(store.project).toMatchObject({ name: 'Night Drive', bpm: 98.5, sig: [7, 8], swing: 0.3, masterPitch: -50 });
    expect(store.undoStack).toHaveLength(1);
    store.undo();
    expect(store.project).toBe(before);
  });

  it('clamps values and records nothing when unchanged', () => {
    const p = demoProject();
    expect(applyProjectSettings(p, { name: p.name, bpm: p.bpm, sig: [...p.sig], swing: p.swing, masterPitch: p.masterPitch })).toBe(p);
    const q = applyProjectSettings(p, { bpm: 9999, sig: [40, 3], swing: 2, masterPitch: 5000, name: '   ' });
    expect(q).toMatchObject({ bpm: 522, sig: [16, 4], swing: 1, masterPitch: 1200, name: p.name });
  });

  it('reports project information', () => {
    const info = projectInfo(demoProject());
    expect(info).toMatchObject({ channels: 7, patterns: 4, samples: 0, bars: 8 });
    expect(info.notes).toBeGreaterThan(50);
  });

  it('applies the dialog form through the store', async () => {
    const store = new Store(newProject());
    const app = { store };
    const done = openProjectSettings(app);
    const dlg = document.querySelector('.dlg-project');
    const [name, bpm] = dlg.querySelectorAll('input.input');
    name.value = 'Tape';
    bpm.value = '87';
    dlg.querySelector('.btn.primary').click();
    expect(await done).toBe(true);
    expect(store.project).toMatchObject({ name: 'Tape', bpm: 87 });
    expect(store.undoStack).toHaveLength(1);
  });

  it('keeps the dialog open on invalid input', async () => {
    const store = new Store(newProject());
    const done = openProjectSettings({ store });
    const dlg = document.querySelector('.dlg-project');
    dlg.querySelectorAll('input.input')[1].value = '2';
    dlg.querySelector('.btn.primary').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.dlg-project')).not.toBe(null);
    expect(dlg.querySelector('.ps-error').textContent).toMatch(/Tempo/);
    dlg.querySelector('.dialog-head button').click();
    expect(await done).toBe(false);
    expect(store.undoStack).toHaveLength(0);
  });
});

describe('shortcuts list', () => {
  it('groups commands with keys by area and filters', () => {
    const c = new Commands({});
    c.register(
      { id: 'file.save', label: 'Save', keys: ['Mod+S'], run() {} },
      { id: 'transport.play', label: 'Play / pause', keys: ['Space'], run() {} },
      { id: 'tools.x', label: 'No keys', run() {} },
      { id: 'pianoRoll.quantize', label: 'Quantize', keys: ['Q'], scope: 'pianoRoll', run() {} },
    );
    const groups = shortcutGroups(c);
    expect(groups.map((g) => g.title)).toEqual(['File', 'Transport', 'Piano roll']);
    expect(shortcutGroups(c, 'quant')).toEqual([{ title: 'Piano roll', items: [{ id: 'pianoRoll.quantize', label: 'Quantize', keys: ['Q'] }] }]);
    expect(shortcutGroups(c, 'space')[0].items[0].id).toBe('transport.play');
  });
});

describe('tools', () => {
  it('lists undo history with current and redo steps', () => {
    const s = new Store(newProject());
    s.apply('A', (p) => E.setProjectProps(p, { bpm: 90 }));
    s.apply('B', (p) => E.setProjectProps(p, { bpm: 91 }));
    s.apply('C', (p) => E.setProjectProps(p, { bpm: 92 }));
    s.undo();
    const rows = historyEntries(s);
    expect(rows.map((r) => [r.index, r.label, r.state])).toEqual([
      [0, 'Opened project', 'past'],
      [1, 'A', 'past'],
      [2, 'B', 'current'],
      [3, 'C', 'future'],
    ]);
    s.jumpTo(rows[3].index);
    expect(s.project.bpm).toBe(92);
    s.jumpTo(0);
    expect(s.project.bpm).toBe(130);
  });

  it('computes tap tempo from recent taps', () => {
    expect(tapBpm([0])).toBe(null);
    expect(tapBpm([0, 500, 1000, 1500])).toBe(120);
    // A pause over 2 s starts over.
    expect(tapBpm([0, 300, 5000, 5600, 6200])).toBe(100);
  });

  it('purges unused channels, empty patterns and orphan samples', () => {
    let p = demoProject();
    const spare = createChannel({ type: 'synth', name: 'Spare' });
    p = E.addChannel(p, spare);
    p = E.addPattern(p).project;
    p = E.addSample(p, { id: 'orphan', name: 'x.wav' }).project;
    const r = purgeUnused(p);
    expect(r).toMatchObject({ channels: 1, patterns: 1, samples: 1 });
    expect(r.project.channels.some((c) => c.id === spare.id)).toBe(false);
    expect(r.project.patterns).toHaveLength(4);
    expect(r.project.samples).toEqual({});
    expect(purgeUnused(r.project)).toMatchObject({ channels: 0, patterns: 0, samples: 0 });
    // One pattern always stays.
    const empty = { ...newProject(), channels: [] };
    expect(purgeUnused(empty).project.patterns).toHaveLength(1);
  });

  it('finds stem inserts including buses fed by sends', () => {
    let p = demoProject();
    p = E.setRoute(p, 6, 9, 0.5);
    expect(stemInserts(p).map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 9]);
    expect(stemInserts({ ...newProject(), channels: [] })).toEqual([]);
  });

  it('formats save dates', () => {
    const now = new Date(2026, 9, 14, 15, 0).getTime();
    expect(formatWhen(new Date(2026, 9, 14, 9, 5).getTime(), now)).toMatch(/^Today /);
    expect(formatWhen(new Date(2026, 9, 13, 9, 5).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatWhen(new Date(2026, 8, 3).getTime(), now)).not.toMatch(/Today|Yesterday/);
  });
});
