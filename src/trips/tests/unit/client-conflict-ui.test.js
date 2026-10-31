import { afterEach, describe, expect, it, vi } from 'vitest';
import { conflictFields, conflictList, mergeChoice, openConflictDialog } from '../../src/ui/conflict.js';

const conflict = (overrides = {}) => ({
  op: { opId: '0000000000000001', t: 'place', id: '0000000000000002', set: { name: 'Mine', 'rating.x': 4 }, base: 'v' },
  code: 'stale', at: Date.UTC(2026, 9, 24, 10),
  local: { id: '0000000000000002', name: 'Mine', notes: 'Same', rating: { x: 4 }, v: 'local' },
  server: { t: 'place', id: '0000000000000002', name: 'Theirs', notes: 'Same', rating: { x: 2 }, phone: '+1', v: 'server' },
  ...overrides,
});
afterEach(() => { document.body.replaceChildren(); });

describe('conflict fields', () => {
  it('lists only fields the parked patch changed that now differ', () => {
    expect(conflictFields(conflict()).map((field) => field.name)).toEqual(['name', 'rating']);
    expect(conflictFields(conflict({ op: { opId: '1', do: 'day.remove', args: {} } }))).toEqual([]);
    expect(conflictFields(conflict({ server: { t: 'place', id: 'x', deleted: true } }))).toEqual([]);
  });
  it('resends the parked op’s own paths for fields kept as mine, or theirs when none are', () => {
    const op = { ...conflict().op, unset: ['notes'] };
    expect(mergeChoice(op, { name: 'theirs', rating: 'mine', notes: 'mine' })).toEqual({ keep: 'merge', set: { 'rating.x': 4 }, unset: ['notes'] });
    expect(mergeChoice(op, { name: 'theirs', rating: 'theirs', notes: 'theirs' })).toEqual({ keep: 'theirs' });
  });
});

describe('conflict dialog', () => {
  it('offers keep mine, keep theirs and merge with per-field choices and closes on success', async () => {
    const onResolve = vi.fn(async () => {});
    const dialog = openConflictDialog({ conflict: conflict(), typeLabel: () => 'place', fieldLabel: (type, name) => `Field ${name}`, onResolve });
    const panel = dialog.panel;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.textContent).toContain('Someone else changed this place');
    expect([...panel.querySelectorAll('.conflict-field-name')].map((node) => node.textContent)).toEqual(['Field name', 'Field rating']);
    const name = panel.querySelectorAll('.conflict-field')[0];
    [...name.querySelectorAll('button')].find((node) => node.textContent === 'Theirs').click();
    [...panel.querySelectorAll('footer button')].find((node) => node.textContent === 'Merge fields').click();
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith({ keep: 'merge', set: { 'rating.x': 4 }, unset: [] }));
    expect(await dialog.closed).toBe('resolved');
  });
  it('keeps the dialog open with an error when resolving fails', async () => {
    const onResolve = vi.fn(async () => { throw new Error('offline'); });
    const dialog = openConflictDialog({ conflict: conflict(), typeLabel: () => 'place', fieldLabel: (type, name) => name, onResolve });
    const theirs = [...dialog.panel.querySelectorAll('footer button')].find((node) => node.textContent === 'Keep theirs');
    theirs.click();
    await vi.waitFor(() => expect(dialog.panel.querySelector('[role=alert]').hidden).toBe(false));
    expect(onResolve).toHaveBeenCalledWith({ keep: 'theirs' });
    expect(theirs.disabled).toBe(false);
    dialog.close();
  });
  it('offers a copy for a deleted entity and no merge', () => {
    const labels = { typeLabel: () => 'place', fieldLabel: (type, name) => name };
    const dialog = openConflictDialog({ conflict: conflict({ code: 'gone', server: { t: 'place', id: 'x', deleted: true, v: 'v' } }), ...labels, onResolve: async () => {} });
    expect([...dialog.panel.querySelectorAll('footer button')].map((node) => node.textContent)).toEqual(['Keep theirs', 'Save mine as a copy']);
    dialog.close();
    const removed = openConflictDialog({ conflict: conflict({ code: 'gone', op: { opId: '1', t: 'place', id: 'x', del: true }, server: { t: 'place', id: 'x', deleted: true } }), ...labels, onResolve: async () => {} });
    expect([...removed.panel.querySelectorAll('footer button')].map((node) => node.textContent)).toEqual(['Keep theirs']);
    removed.close();
  });
  it('renders untrusted values as text', () => {
    const dialog = openConflictDialog({ conflict: conflict({ server: { t: 'place', id: 'x', name: '<img src=x onerror=alert(1)>', v: 's' } }), typeLabel: () => 'place', fieldLabel: (type, name) => name, onResolve: async () => {} });
    expect(() => openConflictDialog({ conflict: conflict(), onResolve: async () => {} })).toThrow(TypeError);
    expect(dialog.panel.querySelector('img')).toBeNull();
    expect(dialog.panel.textContent).toContain('<img src=x onerror=alert(1)>');
    dialog.close();
  });
});

describe('conflict list', () => {
  it('lists parked conflicts with a review action, or an empty state', () => {
    const onOpen = vi.fn();
    const list = conflictList({ conflicts: [conflict()], describe: () => ({ type: 'Place', name: 'Museum' }), onOpen, formatTime: () => 'today' });
    document.body.append(list);
    expect(list.getAttribute('aria-label')).toBe('Unsaved conflicting changes');
    expect(list.textContent).toContain('Place: Museum');
    expect(list.textContent).toContain('today');
    list.querySelector('button').click();
    expect(onOpen).toHaveBeenCalledWith(conflict());
    expect(conflictList({ conflicts: [], describe: () => ({}) }).textContent).toContain('No conflicts');
    expect(() => conflictList({ conflicts: [conflict()] })).toThrow(TypeError);
  });
});
