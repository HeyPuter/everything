// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { describeChanges, attachFormatAnnouncer } from '../src/views/format-announcer.js';
import { TextDocument, paragraph } from '../src/engine/model.js';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

it('names what a formatting key changed in a few words', () => {
  expect(describeChanges([{ run: { bold: true, boldCs: true } }])).toBe('Bold on');
  expect(describeChanges([{ run: { italic: false } }])).toBe('Italic off');
  expect(describeChanges([{ paragraph: { alignment: 'center' } }])).toBe('Centered');
  expect(describeChanges([{ list: 'number' }, { paragraph: { indentLeft: 720 } }])).toBe('Numbered list');
  expect(describeChanges([{ style: 'Heading1' }, { run: { bold: true } }], { definitions: { Heading1: { name: 'heading 1' } } })).toBe('Heading 1');
  expect(describeChanges([{ run: { verticalAlign: 'baseline' } }])).toBe('Superscript and subscript off');
  expect(describeChanges([{ run: { fontSize: 14, fontSizeCs: 14 } }])).toBe('14 point');
  // A mixed selection stepped size by size.
  expect(describeChanges([{ run: { fontSize: 14 } }, { run: { fontSize: 24 } }])).toBe('Font size changed');
  expect(describeChanges([{ paragraph: { lineSpacing: 2, lineRule: 'auto' } }])).toBe('Line spacing 2');
  expect(describeChanges([])).toBe('');
});

it('says what a chord did once its handlers have run, from the changes the document notes, not for held keys or undo', () => {
  vi.useFakeTimers();
  const input = document.createElement('textarea'), root = document.createElement('div');
  root.append(input); document.body.append(root);
  const model = new TextDocument([paragraph('Hello world')]);
  model.select(0, 11);
  const engine = { input, model };
  input.addEventListener('keydown', e => { if (e.key === 'b') model.toggleBold(); if (e.key === 'z') model.undo(); });
  const spoken = [];
  attachFormatAnnouncer(root, () => engine, { say: message => { const node = { message, remove: () => spoken.splice(spoken.indexOf(node), 1) }; spoken.push(node); return node; } });
  const press = (key, extra = {}) => input.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, metaKey: true, bubbles: true, ...extra }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true, bubbles: true }));
  press('b'); vi.runAllTimers();
  expect(spoken.map(n => n.message)).toEqual(['Bold on']);
  expect('formatChanges' in model).toBe(false);
  press('b'); vi.runAllTimers();
  expect(spoken.map(n => n.message)).toEqual(['Bold off']);
  press('b', { repeat: true }); vi.runAllTimers();
  expect(spoken.map(n => n.message)).toEqual(['Bold off']);
  press('z'); vi.runAllTimers();
  expect(spoken.map(n => n.message)).toEqual(['Bold off']);
  // Without the announcer listening, the document notes nothing.
  model.toggleBold(); expect('formatChanges' in model).toBe(false);
});
