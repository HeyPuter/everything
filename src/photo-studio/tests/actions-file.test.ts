import { describe, expect, it } from 'vitest';
import { installActions, playAction, readActionSets } from '../src/features/actions';
import { registerCommand, renamedCommands } from '../src/app/registry';
import type { Editor } from '../src/editor';

describe('action sets from stored data and files', () => {
  it('rebuilds sets from checked fields and gives imported ones new identifiers', () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const data = [
      { id: hostile, name: 'Evil', open: true, actions: [{ id: hostile, name: 'A', steps: [{ command: 'layer.duplicate', arg: { amount: 2 } }, { command: 5 }, null, { command: 'image.trim', enabled: false, dialog: 'yes' }] }, 'junk'] },
      { name: 'No actions' },
      null,
      'text',
    ];
    const sets = readActionSets(data, true);
    expect(sets.map((s) => s.name)).toEqual(['Evil', 'No actions']);
    expect(sets[1].actions).toEqual([]);
    const [a] = sets[0].actions;
    expect(a.name).toBe('A');
    expect(a.steps).toEqual([
      { command: 'layer.duplicate', arg: { amount: 2 }, enabled: true, dialog: false },
      { command: 'image.trim', enabled: false, dialog: false },
    ]);
    for (const id of [sets[0].id, a.id, sets[1].id]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Importing the same file twice makes separate copies.
    expect(readActionSets(data, true)[0].actions[0].id).not.toBe(a.id);
  });
  it('keeps the identifiers of stored sets that are safe, so event rules still find them', () => {
    const stored = [{ id: 'defaults', name: 'Default Actions', actions: [{ id: 'a-trim', name: 'Trim', steps: [] }, { id: 'bad:id', name: 'Colon', steps: [] }] }];
    const sets = readActionSets(stored, false);
    expect(sets[0].id).toBe('defaults');
    expect(sets[0].actions[0].id).toBe('a-trim');
    expect(sets[0].actions[1].id).not.toBe('bad:id');
    expect(readActionSets({ not: 'a list' }, false)).toEqual([]);
  });
});

describe('playing actions', () => {
  const editor = () => {
    const messages: string[] = [];
    return { messages, e: { message: (m: string) => messages.push(m), update() {} } as unknown as Editor };
  };
  it('replays steps recorded under a command id that was renamed since', async () => {
    const ran: unknown[] = [];
    registerCommand({ id: 'test.renamed-to', label: 'Renamed', run: (_e, arg) => void ran.push(arg) });
    renamedCommands.set('test.renamed-from', 'test.renamed-to');
    const { e, messages } = editor();
    const ok = await playAction(e, { id: 'a', name: 'Old', steps: [{ command: 'test.renamed-from', arg: { params: { radius: 2 } }, enabled: true, dialog: false }] });
    expect(messages).toEqual([]);
    expect(ok).toBe(true);
    expect(ran).toEqual([{ params: { radius: 2 } }]);
  });
  it('a batch that runs an action reports why the action stopped on a file', async () => {
    installActions({ dock: { update() {} } } as unknown as Editor);
    const { batchSteps } = await import('../src/features/files/automate-steps');
    const step = batchSteps.get('action:a-dup-desat')!;
    const { e } = editor();
    // Duplicate Layer is not registered here, so the action cannot run.
    await expect(step.document!(e)).rejects.toThrow('The action “Desaturated Copy” stopped: The command “layer.duplicate” is not available.');
  });
});
