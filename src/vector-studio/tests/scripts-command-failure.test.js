import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { ActionEngine } from '../src/features/panels/actions-model.js';
import { scriptAPI } from '../src/features/scripts/runner.js';
import { UserError } from '../src/lib/errors.js';

let app;
beforeAll(() => {
  app = bootApp();
  new ActionEngine(app); // scripts use the same wrapped registry as the full app
  app.notify = vi.fn();
  app.commands.register([
    { id: 'test.throw', label: 'Fail', run: () => { throw new UserError('Invalid geometry.'); } },
    { id: 'test.disabled', label: 'Disabled', enabled: () => false, run: vi.fn() },
    { id: 'test.rename', label: 'Rename', run: (a) => a.editor.doc.transact('Rename', () => a.editor.doc.updateRoot({ name: 'Renamed' })) },
  ]);
});

describe('script command failures', () => {
  it('rejects failed commands so script try/catch can recover', async () => {
    const ed = app.newDocument();
    const { api, changes } = scriptAPI(app, ed, 'Script');
    await expect(api.command('test.throw')).rejects.toThrow('Invalid geometry.');
    expect(changes()).toBe(0);
    expect(ed.doc.undoStack).toHaveLength(0);
  });

  it('rejects disabled commands instead of reporting a successful edit', async () => {
    const ed = app.newDocument();
    const { api, changes } = scriptAPI(app, ed, 'Script');
    await expect(api.command('test.disabled')).rejects.toThrow(/current selection/);
    expect(app.commands.get('test.disabled').run).not.toHaveBeenCalled();
    expect(changes()).toBe(0);
  });

  it('still runs successful commands on the script document and keeps one undo step', async () => {
    const ed = app.newDocument();
    const original = ed.doc.root.name;
    const { api, changes } = scriptAPI(app, ed, 'Script');
    const other = app.newDocument();
    const otherName = other.doc.root.name;
    await expect(api.command('test.rename')).resolves.toBe(true);
    expect(ed.doc.root.name).toBe('Renamed');
    expect(other.doc.root.name).toBe(otherName);
    expect(changes()).toBe(1);
    expect(ed.doc.undoLabel).toBe('Script');
    ed.doc.undo();
    expect(ed.doc.root.name).toBe(original);
  });
});
