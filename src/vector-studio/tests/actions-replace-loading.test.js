import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/features/files/service.js', () => ({ pickWithInput: vi.fn() }));
import { pickWithInput } from '../src/features/files/service.js';
import { bootApp } from './helpers.js';
import { ActionEngine, exportSetsData } from '../src/features/panels/actions-model.js';
import { ActionsPanel, syncActionCommands } from '../src/features/panels/actions-panel.js';

let app, panel, engine, original;
beforeAll(() => {
  app = bootApp();
  engine = app.actions = new ActionEngine(app);
  app.notify = vi.fn();
  panel = new ActionsPanel(app);
  panel.ensureBuilt();
});
beforeEach(() => {
  original = [{ id: 'old', name: 'Original', actions: [{ id: 'old-action', name: 'Original action', shortcut: 'Mod+F9', steps: [] }] }];
  engine.sets = original;
  panel.sel = { kind: 'action', id: 'old-action' };
  syncActionCommands(app, engine);
  app.notify.mockClear();
});
function pendingChoice() {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  pickWithInput.mockReturnValueOnce(pending);
  return resolve;
}
const file = (sets) => ({ text: async () => JSON.stringify(exportSetsData(sets)) });

describe('loading replacement action sets', () => {
  it('keeps existing actions available while the picker is open and after cancel', async () => {
    const resolve = pendingChoice();
    const pending = panel.replaceActions();
    expect(engine.sets).toBe(original);
    resolve([]);
    await pending;
    expect(engine.sets).toBe(original);
    expect(panel.sel).toEqual({ kind: 'action', id: 'old-action' });
  });

  it('does not lose edits made while reading a damaged replacement file', async () => {
    let resolve;
    const reading = new Promise((done) => { resolve = done; });
    pickWithInput.mockResolvedValueOnce([{ text: () => reading }]);
    const pending = panel.replaceActions();
    await Promise.resolve();
    engine.sets.push({ id: 'new', name: 'New set', actions: [] });
    resolve('invalid JSON');
    await pending;
    expect(engine.sets.map((set) => set.id)).toEqual(['old', 'new']);
  });

  it('replaces a valid file atomically and removes the old action shortcuts', async () => {
    const resolve = pendingChoice();
    const pending = panel.replaceActions();
    resolve([file([{ id: 'imported', name: 'Replacement', actions: [] }])]);
    await pending;
    expect(engine.sets.map((set) => set.name)).toEqual(['Replacement']);
    expect(app.commands.get('actions.run.old-action')).toBeUndefined();
    expect(panel.sel).toBeNull();
  });

  it('still appends sets for Load Actions', async () => {
    pickWithInput.mockResolvedValueOnce([file([{ id: 'extra', name: 'Extra', actions: [] }])]);
    await panel.loadActions();
    expect(engine.sets.map((set) => set.name)).toEqual(['Original', 'Extra']);
  });
});
