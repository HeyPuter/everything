// Editor shortcuts while typing in a field or with a dialog open.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Editor } from '../src/ui/editor.js';
import { isMac } from '../src/lib/platform.js';
import { fixture, clip, onMain } from './helpers.js';

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('shortcuts while typing', () => {
  let editor;
  let root;
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root, Object.assign(document.createElement('div'), { id: 'live-region' }));
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    editor = new Editor(root, { library: lib, project: p, account: {}, onExit() {}, onNewProject() {} });
    await settle();
  });
  afterEach(() => {
    editor?.dispose();
    editor = null;
    document.querySelectorAll('dialog').forEach((d) => d.remove());
    vi.restoreAllMocks();
  });
  const press = (target, init) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  const mod = (key, code = `Key${key.toUpperCase()}`) => ({ key, code, metaKey: isMac, ctrlKey: !isMac });

  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves composition keys with the text field (%j)', (composition) => {
    const input = document.createElement('input');
    root.append(input);
    input.focus();
    const save = vi.spyOn(editor.ctx.commands.get('save'), 'run');
    expect(press(input, { ...mod('s'), ...composition }).defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
    press(input, { key: 'Escape', ...composition });
    expect(document.activeElement).toBe(input);
    press(input, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
  });

  it('opens the color picker with Space on a color swatch instead of playing', () => {
    const toggle = vi.spyOn(editor.ctx.player, 'toggle').mockImplementation(() => {});
    const swatch = Object.assign(document.createElement('input'), { type: 'color' });
    root.querySelector('.inspector, .workspace').append(swatch);
    swatch.focus();
    expect(press(swatch, { key: ' ', code: 'Space' }).defaultPrevented).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
  });

  it('leaves Copy and Cut to the browser while text of an assistant reply is selected', () => {
    const log = document.createElement('div');
    log.className = 'ai-log';
    log.textContent = 'Trim the first clip to four seconds.';
    root.append(log);
    const [c] = editor.ctx.store.project.tracks.flatMap((t) => t.clips);
    editor.ctx.store.select(c.id);
    const copy = vi.spyOn(editor.ctx.actions, 'copy');
    const cut = vi.spyOn(editor.ctx.actions, 'cut');
    const range = document.createRange();
    range.selectNodeContents(log);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.activeElement?.blur?.();
    expect(press(document.body, mod('c')).defaultPrevented).toBe(false);
    expect(press(document.body, mod('x')).defaultPrevented).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(cut).not.toHaveBeenCalled();
    expect(editor.ctx.store.project.tracks.flatMap((t) => t.clips)).toHaveLength(1);
    // Without selected text the clip commands work as before.
    getSelection().removeAllRanges();
    expect(press(document.body, mod('c')).defaultPrevented).toBe(true);
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it('saves with Mod+S in a text field instead of letting the browser save the page', () => {
    const save = vi.spyOn(editor.ctx.commands.get('save'), 'run');
    const input = Object.assign(document.createElement('input'), { type: 'text' });
    root.querySelector('.inspector, .workspace').append(input);
    input.focus();
    const e = press(input, mod('s'));
    expect(save).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    // Editing keys stay with the field.
    const undo = vi.spyOn(editor.ctx.commands.get('undo'), 'run');
    const split = vi.spyOn(editor.ctx.commands.get('split'), 'run');
    expect(press(input, mod('z')).defaultPrevented).toBe(false);
    expect(press(input, mod('b')).defaultPrevented).toBe(false);
    expect(press(input, { key: 's', code: 'KeyS' }).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    expect(split).not.toHaveBeenCalled();
    input.remove();
  });

  it('saves from a field that keeps its keys to itself, such as the project name', () => {
    const save = vi.spyOn(editor.ctx.commands.get('save'), 'run');
    const input = Object.assign(document.createElement('input'), { type: 'text' });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    root.append(input);
    input.focus();
    expect(press(input, mod('s')).defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('a rebinding without the command key never takes typed letters', () => {
    editor.ctx.commands.setKeys('save', ['S']);
    const save = vi.spyOn(editor.ctx.commands.get('save'), 'run');
    const input = Object.assign(document.createElement('input'), { type: 'text' });
    root.append(input);
    input.focus();
    expect(press(input, { key: 's', code: 'KeyS' }).defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
    editor.ctx.commands.setKeys('save', null);
    input.remove();
  });

  it('saves with Mod+S while a dialog is open, and runs nothing else', () => {
    const save = vi.spyOn(editor.ctx.commands.get('save'), 'run');
    const prefs = vi.spyOn(editor.ctx.commands.get('preferences'), 'run');
    const dialog = document.createElement('dialog');
    const btn = document.createElement('button');
    dialog.append(btn);
    document.body.append(dialog);
    dialog.setAttribute('open', '');
    btn.focus();
    expect(press(btn, mod('s')).defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(press(btn, mod(',', 'Comma')).defaultPrevented).toBe(false);
    expect(press(btn, { key: ' ', code: 'Space' }).defaultPrevented).toBe(false);
    expect(prefs).not.toHaveBeenCalled();
  });
});
