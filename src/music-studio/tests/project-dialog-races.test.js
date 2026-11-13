import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/model/store.js';
import { demoProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { renameSource, deleteSource, trackMenu } from '../src/playlist/menus.js';
import { openMenu } from '../src/ui/menu.js';
import { channelActions } from '../src/rack/actions.js';
import { registerCoreCommands } from '../src/commands/core.js';
import { quantizeDialog, chordsDialog, riffDialog, transposeDialog } from '../src/pianoroll/dialogs.js';

vi.mock('../src/ui/menu.js', async (original) => ({ ...await original(), openMenu: vi.fn() }));

function setup() {
  const store = new Store(demoProject());
  const commands = new Map();
  const app = { store, notify: vi.fn(), commands: { register: (...items) => items.forEach((item) => commands.set(item.id, item)) } };
  registerCoreCommands(app);
  const rack = channelActions(app);
  const ed = {
    app, store, prefs: {}, sig: [4, 4], cursor: { tick: 0 }, patLen: 384, snapId: 'step',
    get channel() { return store.channel; },
    get pattern() { return store.pattern; },
    get notes() { return store.pattern.notes[store.channel.id] || []; },
    selIds() { return this.notes.map((note) => note.id); },
    setPref: vi.fn(), runTool: vi.fn(), applyNotes: vi.fn(), select: vi.fn(), revealNotes: vi.fn(), revealTick: vi.fn(),
  };
  return { store, app, rack, commands, ed };
}

const scenarios = [
  ['source rename', (x) => renameSource({ store: x.store }, { kind: 'pattern', id: x.store.pattern.id }), 'Rename'],
  ['source delete', (x) => deleteSource({ store: x.store, app: x.app }, { kind: 'pattern', id: x.store.pattern.id }), 'Delete'],
  ['channel rename', (x) => x.rack.rename(x.store.channel.id), 'Rename'],
  ['channel delete', (x) => x.rack.remove([x.store.channel.id]), 'Delete'],
  ['track delete', (x) => {
    trackMenu({ store: x.store }, 0, {});
    return openMenu.mock.calls.at(-1)[0].find((item) => item.label === 'Delete track').run();
  }, 'Delete'],
  ...['rename', 'delete', 'transpose'].map((action) => [`pattern ${action}`, (x) => x.commands.get(`patterns.${action}`).run(), action[0].toUpperCase() + action.slice(1)]),
  ['note transpose', (x) => transposeDialog(x.ed), 'Transpose'],
  ['quantize', (x) => quantizeDialog(x.ed), 'Quantize'],
  ['chordize', (x) => chordsDialog(x.ed), 'Chordize selection'],
  ['riff', (x) => riffDialog(x.ed), 'Generate'],
];

afterEach(() => {
  document.querySelectorAll('.dialog-head button').forEach((button) => button.click());
  document.body.replaceChildren();
});

for (const timing of ['before confirmation', 'immediately after confirmation']) {
  describe(`project replacement ${timing}`, () => {
    it.each(scenarios)('cancels %s without touching the replacement', async (_name, run, label) => {
      const ctx = setup();
      const action = run(ctx);
      const dialog = document.querySelector('.dialog');
      expect(Boolean(dialog)).toBe(true);
      const input = dialog.querySelector('input[type=text]');
      if (input && label === 'Rename') input.value = 'Stale rename';
      const submit = [...dialog.querySelectorAll('.dialog-foot button')].find((button) => button.textContent === label);
      expect(Boolean(submit)).toBe(true);
      const replacement = { ...structuredClone(ctx.store.project), name: 'Replacement', bpm: 150 };
      if (timing === 'immediately after confirmation') submit.click();
      ctx.store.load(replacement);
      if (timing === 'before confirmation') {
        expect(document.querySelector('.dialog')).toBeNull();
        submit.click();
      }
      await action;
      expect(ctx.store.project === replacement).toBe(true);
      expect(ctx.store.canUndo).toBe(false);
      expect(ctx.ed.runTool).not.toHaveBeenCalled();
      expect(ctx.ed.applyNotes).not.toHaveBeenCalled();
      expect(document.querySelector('.dialog')).toBeNull();
    });
  });
}

it('keeps a pending rename usable across ordinary edits and undo', async () => {
  const ctx = setup();
  const id = ctx.store.channel.id;
  const action = ctx.rack.rename(id);
  ctx.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 151 }));
  ctx.store.undo();
  const dialog = document.querySelector('.dialog');
  dialog.querySelector('input').value = 'New name';
  dialog.querySelector('.btn.primary').click();
  await action;
  expect(ctx.store.project.channels.find((c) => c.id === id).name).toBe('New name');
});

const noteActions = scenarios.filter(([name]) => ['pattern transpose', 'note transpose', 'quantize', 'chordize', 'riff'].includes(name));
it.each(noteActions.flatMap(([name, run, label]) => (name === 'pattern transpose' ? ['pattern'] : ['pattern', 'channel']).map((target) => [name, target, run, label])))('cancels %s when the selected %s changes in the same project', async (_name, target, run, label) => {
  const ctx = setup();
  const action = run(ctx);
  const dialog = document.querySelector('.dialog');
  const submit = [...dialog.querySelectorAll('.dialog-foot button')].find((button) => button.textContent === label);
  if (target === 'pattern') ctx.store.setPattern(ctx.store.project.patterns[1].id);
  else ctx.store.selectChannels([ctx.store.project.channels[1].id]);
  const project = ctx.store.project;
  submit.click();
  await action;
  expect(ctx.store.project === project).toBe(true);
  expect(ctx.ed.runTool).not.toHaveBeenCalled();
  expect(ctx.ed.applyNotes).not.toHaveBeenCalled();
  expect(ctx.store.canUndo).toBe(false);
});

it.each(noteActions)('keeps %s usable across an unrelated tempo edit', async (name, run, label) => {
  const ctx = setup();
  const action = run(ctx);
  ctx.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 151 }));
  const before = ctx.store.project;
  const dialog = document.querySelector('.dialog');
  expect(Boolean(dialog)).toBe(true);
  [...dialog.querySelectorAll('.dialog-foot button')].find((button) => button.textContent === label).click();
  await action;
  expect(ctx.store.project.bpm).toBe(151);
  if (name === 'pattern transpose') expect(ctx.store.project === before).toBe(false);
  else expect(ctx.ed.runTool.mock.calls.length + ctx.ed.applyNotes.mock.calls.length).toBe(1);
});
