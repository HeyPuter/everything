import { describe, expect, it } from 'vitest';
import { chordFromEvent, parseShortcut, formatChord, chordProblem, chordConflicts, chordsFor, normalizeKeymap } from '../src/core/keymap.js';

const press = (key, code, mods = {}) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('chords from key presses', () => {
  it('names the command key Mod on either platform', () => {
    expect(chordFromEvent(press('k', 'KeyK', { metaKey: true }), true)).toBe('Mod+K');
    expect(chordFromEvent(press('k', 'KeyK', { ctrlKey: true }), false)).toBe('Mod+K');
    expect(chordFromEvent(press('k', 'KeyK', { ctrlKey: true }), true)).toBe('Ctrl+K');
  });

  it('reads the physical key, so Shift and Option do not change it', () => {
    expect(chordFromEvent(press('˚', 'KeyK', { altKey: true, metaKey: true }), true)).toBe('Mod+Alt+K');
    expect(chordFromEvent(press('!', 'Digit1', { shiftKey: true, ctrlKey: true }), false)).toBe('Mod+Shift+1');
    expect(chordFromEvent(press('F8', 'F8', { shiftKey: true }), false)).toBe('Shift+F8');
    expect(chordFromEvent(press(',', 'Comma', { ctrlKey: true }), false)).toBe('Mod+,');
  });

  it('a modifier alone is not a chord', () => {
    expect(chordFromEvent(press('Shift', 'ShiftLeft', { shiftKey: true }), false)).toBeNull();
    expect(chordFromEvent(press('Meta', 'MetaLeft', { metaKey: true }), true)).toBeNull();
  });
});

describe('shortcuts as the menus write them', () => {
  it('parse into chords', () => {
    expect(parseShortcut('⌘+Shift+Z', true)).toBe('Mod+Shift+Z');
    expect(parseShortcut('Ctrl+Shift+Z', false)).toBe('Mod+Shift+Z');
    expect(parseShortcut('⌃+`', true)).toBe('Ctrl+`');
    expect(parseShortcut('Alt+Shift+Right', false)).toBe('Alt+Shift+ArrowRight');
    expect(parseShortcut('F7', false)).toBe('F7');
    expect(parseShortcut('Shift+F7', true)).toBe('Shift+F7');
    expect(parseShortcut('Ctrl++', false)).toBe('Mod++');
    expect(parseShortcut('Delete', false)).toBe('Delete');
    expect(parseShortcut('Drag the handle', false)).toBeNull();
    expect(parseShortcut('Ctrl+Space or ⌃+Space', true)).toBeNull();
  });

  it('format back for people', () => {
    expect(formatChord('Mod+Shift+K', true)).toBe('⌘+Shift+K');
    expect(formatChord('Mod+Shift+K', false)).toBe('Ctrl+Shift+K');
    expect(formatChord('Alt+ArrowDown', false)).toBe('Alt+Down');
    expect(parseShortcut(formatChord('Mod+Alt+K', true), true)).toBe('Mod+Alt+K');
    expect(parseShortcut(formatChord('Ctrl+F9', true), true)).toBe('Ctrl+F9');
  });
});

describe('which chords can be assigned', () => {
  it('needs a modifier that is not Shift, or a function key', () => {
    expect(chordProblem('K')).toMatch(/typing/);
    expect(chordProblem('Shift+K')).toMatch(/typing/);
    expect(chordProblem('Mod+K')).toBeNull();
    expect(chordProblem('Alt+K')).toBeNull();
    expect(chordProblem('F8')).toBeNull();
    expect(chordProblem('Shift+F8')).toBeNull();
  });

  it('leaves the clipboard and the browser’s own chords alone', () => {
    expect(chordProblem('Mod+C')).toMatch(/Copy/);
    expect(chordProblem('Mod+W')).toMatch(/browser/);
    expect(chordProblem('Alt+F4')).toMatch(/system/);
    expect(chordProblem('Mod+Tab')).toMatch(/Tab/);
  });

  it('finds the commands a chord would be taken from', () => {
    const builtins = { 'Mod+B': ['bold'], 'Mod+K': ['link'] };
    expect(chordConflicts('Mod+B', 'italic', {}, builtins)).toEqual(['bold']);
    expect(chordConflicts('Mod+B', 'bold', {}, builtins)).toEqual([]);
    expect(chordConflicts('Mod+B', 'italic', { 'Mod+B': null }, builtins)).toEqual([]);
    expect(chordConflicts('Mod+J', 'italic', { 'Mod+J': 'filter' }, builtins)).toEqual(['filter']);
  });
});

describe('the chords that run a command', () => {
  it('keeps its own unless they are taken or turned off, then adds custom ones', () => {
    expect(chordsFor('bold', ['Mod+B'], {})).toEqual(['Mod+B']);
    expect(chordsFor('bold', ['Mod+B'], { 'Mod+B': null })).toEqual([]);
    expect(chordsFor('bold', ['Mod+B'], { 'Mod+B': 'italic' })).toEqual([]);
    expect(chordsFor('bold', ['Mod+B'], { 'Alt+B': 'bold' })).toEqual(['Mod+B', 'Alt+B']);
    expect(chordsFor('italic', ['Mod+I'], { 'Mod+B': 'italic' })).toEqual(['Mod+I', 'Mod+B']);
  });

  it('a stored table keeps only chords naming a command or turned off', () => {
    expect(normalizeKeymap({ 'Mod+B': 'bold', 'Mod+J': null, 'F9': 3, '': 'x' })).toEqual({ 'Mod+B': 'bold', 'Mod+J': null });
    expect(normalizeKeymap(['nope'])).toEqual({});
  });
});
