import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app.js';
import * as rack from '../src/panels/channel-rack.js';
import { newProject } from '../src/model/demo.js';
import { createNote } from '../src/model/project.js';
import { getWindow } from '../src/ui/windows.js';
import { STEP } from '../src/model/time.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

let app;
let view;

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  // jsdom has no canvas: keep preview drawing quiet.
  HTMLCanvasElement.prototype.getContext = () => null;
  app = new App(document.getElementById('app'), { project: newProject(), storage: memoryStorage() });
  app.start([rack]);
  app.shell.show('rack');
  view = app.panel('rack').view;
});

afterEach(() => {
  cancelAnimationFrame(app.raf);
  document.querySelectorAll('.float-win .win-head > button').forEach((b) => b.click());
});

const rowEl = (i) => view.grid.querySelectorAll('.rack-row')[i];
const cell = (row, s) => rowEl(row).querySelectorAll('.step')[s];
const kickId = () => app.store.project.channels[0].id;
const notes = (id = kickId()) => app.store.pattern.notes[id] || [];
const pointer = (type, el, opts = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, ...opts }));

describe('channel rack panel', () => {
  it('renders a row per channel with 16 steps', () => {
    expect(view.grid.querySelectorAll('.rack-row')).toHaveLength(4);
    expect(rowEl(0).querySelectorAll('.step')).toHaveLength(16);
    expect(rowEl(0).querySelector('.rack-name').textContent).toBe('Kick');
    expect(view.grid.getAttribute('role')).toBe('grid');
  });

  it('toggles a step on click as one undo step', () => {
    const c = cell(0, 4);
    pointer('pointerdown', c);
    pointer('pointerup', view.grid);
    expect(notes().map((n) => n.pos)).toEqual([4 * STEP]);
    expect(cell(0, 4).classList.contains('on')).toBe(true);
    expect(cell(0, 4).getAttribute('aria-label')).toMatch(/on/);
    expect(app.store.undoLabel).toBe('Step on');
    app.store.undo();
    expect(notes()).toHaveLength(0);
    expect(cell(0, 4).classList.contains('on')).toBe(false);
  });

  it('right-click erases a step', () => {
    app.store.apply('x', (p) => ({ ...p, patterns: [{ ...p.patterns[0], notes: { [kickId()]: [createNote({ key: 60, pos: 0, len: STEP })] } }] }));
    pointer('pointerdown', cell(0, 0), { button: 2 });
    pointer('pointerup', view.grid, { button: 2 });
    expect(notes()).toHaveLength(0);
  });

  it('patches rows instead of rebuilding them', () => {
    const before = [...view.grid.querySelectorAll('.rack-row')];
    const kickCells = [...rowEl(0).querySelectorAll('.step')];
    pointer('pointerdown', cell(1, 2));
    pointer('pointerup', view.grid);
    const after = [...view.grid.querySelectorAll('.rack-row')];
    expect(after).toEqual(before);
    expect([...rowEl(0).querySelectorAll('.step')]).toEqual(kickCells);
    // A rename touches only that row's label.
    const label = rowEl(2).querySelector('.rack-name-text');
    app.store.apply('Rename', (p) => ({ ...p, channels: p.channels.map((c, i) => (i === 2 ? { ...c, name: 'Hats' } : c)) }));
    expect(rowEl(2).querySelector('.rack-name-text')).toBe(label);
    expect(label.textContent).toBe('Hats');
  });

  it('changes volume from the keyboard on the knob and records one undo step', async () => {
    vi.useFakeTimers();
    const knob = rowEl(0).querySelector('.c-vol [role="slider"]');
    const v0 = app.store.project.channels[0].volume;
    for (let i = 0; i < 3; i++) knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(app.store.project.channels[0].volume).toBeGreaterThan(v0);
    expect(app.lastTweaked.target).toEqual({ kind: 'channel', id: kickId(), param: 'volume' });
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    expect(app.store.undoStack).toHaveLength(1);
    app.store.undo();
    expect(app.store.project.channels[0].volume).toBe(v0);
  });

  it('mutes on LED click and solos with Ctrl+click', () => {
    const led = rowEl(1).querySelector('.rack-mute');
    led.click();
    expect(app.store.project.channels[1].mute).toBe(true);
    expect(led.getAttribute('aria-pressed')).toBe('false');
    led.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, metaKey: true }));
    expect(app.store.project.channels[1].solo).toBe(true);
    expect(rowEl(0).classList.contains('inaudible')).toBe(true);
  });

  it('navigates the grid with arrows and toggles with Enter', () => {
    const c = cell(0, 0);
    c.focus();
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(cell(0, 1));
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(cell(1, 1));
    expect(cell(1, 1).tabIndex).toBe(0);
    expect(cell(0, 1).tabIndex).toBe(-1);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(notes(app.store.project.channels[1].id).map((n) => n.pos)).toEqual([STEP]);
  });

  it('shows a preview instead of steps when notes do not fit', () => {
    app.store.apply('x', (p) => ({ ...p, patterns: [{ ...p.patterns[0], notes: { [kickId()]: [createNote({ key: 67, pos: 0, len: STEP * 3 })] } }] }));
    expect(rowEl(0).querySelector('.rack-steps').hidden).toBe(true);
    expect(rowEl(0).querySelector('.rack-preview').hidden).toBe(false);
  });

  it('adds a bar of steps from the toolbar', () => {
    view.resize(1);
    expect(rowEl(0).querySelectorAll('.step')).toHaveLength(32);
    expect(view.stepsLabel.textContent).toBe('32 steps');
    app.store.undo();
    expect(rowEl(0).querySelectorAll('.step')).toHaveLength(16);
  });

  it('copies and pastes steps between channels', () => {
    view.actions.fill([kickId()], 4);
    app.store.selectChannels([kickId()]);
    app.panel('rack').actions.copy();
    const clap = app.store.project.channels[1];
    app.store.selectChannels([clap.id]);
    app.panel('rack').actions.paste();
    expect(notes(clap.id).map((n) => n.pos / STEP)).toEqual([0, 4, 8, 12]);
    expect(notes(clap.id).every((n) => n.key === clap.root)).toBe(true);
  });

  it('opens one editor window per channel and closes it when the channel goes', async () => {
    const id = kickId();
    app.openChannelEditor(id);
    const win = getWindow(`channel:${id}`);
    expect(win).toBeTruthy();
    app.openChannelEditor(id);
    expect(document.querySelectorAll('.float-win')).toHaveLength(1);
    // Editing the store re-syncs the editor.
    app.store.apply('Rename', (p) => ({ ...p, channels: p.channels.map((c) => (c.id === id ? { ...c, name: 'Boom' } : c)) }));
    expect(win.el.querySelector('.ed-name').value).toBe('Boom');
    app.store.apply('Delete', (p) => ({ ...p, channels: p.channels.filter((c) => c.id !== id) }));
    expect(getWindow(`channel:${id}`)).toBe(null);
  });

  it('editor knobs change instrument params as undoable gestures', () => {
    vi.useFakeTimers();
    const id = kickId();
    app.openChannelEditor(id);
    const win = getWindow(`channel:${id}`);
    const knob = win.el.querySelector('.ed-knob[role="slider"]');
    const before = app.store.project.channels[0].params;
    knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    expect(app.store.project.channels[0].params).not.toBe(before);
    expect(app.lastTweaked.target.kind).toBe('channel');
    app.store.undo();
    expect(app.store.project.channels[0].params).toBe(before);
  });

  it('adds a dropped preset at the drop position', () => {
    const before = app.store.project.channels.length;
    app.addChannel({ type: 'synth', name: 'Pad', index: 1 });
    expect(app.store.project.channels).toHaveLength(before + 1);
    expect(app.store.project.channels[1].name).toBe('Pad');
    expect(rowEl(1).querySelector('.rack-name-text').textContent).toBe('Pad');
  });
});
