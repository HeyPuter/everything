import { describe, expect, it } from 'vitest';
import { FormDraft, formWidgets, formWidgetLayout } from '../src/core/form-draft.js';

for (const [allowCustom, multiple] of [
  [true, false],
  [false, false],
  [true, true],
])
  for (const readOnly of [false, true])
    it(`keeps editable widget labels distinct without changing exports (editable=${allowCustom}, multiple=${multiple}, readOnly=${readOnly})`, () => {
      const annotation = {
        id: '1R',
        fieldName: 'Choice',
        fieldType: 'Ch',
        rect: [0, 0, 200, 30],
        combo: true,
        multiSelect: multiple,
        fieldFlags: allowCustom ? 1 << 18 : 0,
        readOnly,
        fieldValue: ['B'],
        options: [
          { exportValue: 'A', displayValue: 'Shared' },
          { exportValue: 'B', displayValue: 'Shared' },
          { exportValue: 'NZ', displayValue: 'New\nZealand' },
          { exportValue: '', displayValue: '' },
        ],
      };
      const before = structuredClone(annotation);
      const [widget] = formWidgets([annotation]);
      expect(widget).toMatchObject({
        value: ['B'],
        readOnly,
        multiple,
        editableChoice: allowCustom && !multiple,
      });
      expect(widget.options).toEqual(
        allowCustom && !multiple
          ? [
              { value: 'A', label: 'Shared (A)' },
              { value: 'B', label: 'Shared (B)' },
              { value: 'NZ', label: 'New Zealand' },
              { value: '', label: '(Empty option)' },
            ]
          : annotation.options.map(({ exportValue, displayValue }) => ({
              value: exportValue,
              label: displayValue,
            })),
      );
      expect(annotation).toEqual(before);
    });

it('shares values by field name, preserves empty options, and supports draft undo/redo', () => {
  const draft = new FormDraft();
  draft.register([
    { name: 'Shared', value: '' },
    { name: 'Shared', value: '' },
    { name: 'Choice', value: [''] },
  ]);
  expect(draft.set('Shared', '')).toBe(false);
  draft.set('Shared', 'Typed');
  draft.set('Choice', []);
  expect(draft.values).toEqual({ Shared: 'Typed', Choice: [] });
  draft.undo();
  expect(draft.value('Choice')).toEqual(['']);
  draft.undo();
  expect(draft.dirty).toBe(false);
  draft.redo();
  expect(draft.value('Shared')).toBe('Typed');
  draft.set('Shared', 'Branch');
  expect(draft.future).toHaveLength(0);
});

it('keeps form drafts intact after failed transactions and protects snapshots from later edits', () => {
  const draft = new FormDraft();
  draft.register([
    { name: '__proto__', value: '' },
    { name: 'Options', value: ['A', 'B'] },
  ]);
  draft.set('__proto__', 'safe');
  expect(Object.keys(draft.values)).toEqual(['__proto__']);
  expect(draft.set('Options', ['B', 'A'])).toBe(false);
  draft.set('Options', ['C']);
  const snapshot = draft.snapshot();
  draft.reset();
  draft.restore(snapshot);
  // Edits after a restore belong to the draft, not to the snapshot it came from.
  draft.set('Options', ['D']);
  expect(snapshot.changes.get('Options')).toEqual(['C']);
  expect(snapshot.past).toHaveLength(2);
  draft.restore(snapshot);
  const value = draft.value('Options');
  value.push('A');
  expect(draft.value('Options')).toEqual(['C']);
  expect(draft.values.__proto__).toBe('safe');
  draft.undo();
  expect(draft.value('Options')).toEqual(['A', 'B']);
});

it('bounds form history and ignores unknown fields', () => {
  const draft = new FormDraft();
  draft.register([{ name: 'Name', value: '' }]);
  expect(draft.set('missing', 'no')).toBe(false);
  for (let i = 0; i < 30; i++) draft.set('Name', String(i));
  expect(draft.past).toHaveLength(25);
});

it('uses export values for choices and radio groups and excludes hidden or unsupported widgets', () => {
  const base = { fieldName: 'Field', id: '1R', rect: [10, 20, 110, 50] };
  const widgets = formWidgets([
    {
      ...base,
      fieldType: 'Ch',
      fieldValue: ['code', 'custom'],
      options: [{ exportValue: 'code', displayValue: 'Label' }],
      combo: true,
      multiSelect: true,
      fieldFlags: 1 << 18,
    },
    {
      ...base,
      id: '2R',
      fieldType: 'Btn',
      radioButton: true,
      buttonValue: '同意',
      fieldValue: '同意',
    },
    { ...base, fieldType: 'Btn', checkBox: true, exportValue: 'Yes', fieldValue: 'Off' },
    { ...base, fieldType: 'Tx', hidden: true },
    { ...base, fieldType: 'Tx', annotationFlags: 32 },
    { ...base, fieldType: 'Btn', pushButton: true, actions: { A: 'anything' } },
    { ...base, fieldType: 'Sig' },
  ]);
  expect(widgets).toHaveLength(3);
  expect(widgets[0]).toMatchObject({
    value: ['code', 'custom'],
    options: [
      { value: 'code', label: 'Label' },
      { value: 'custom', label: 'custom' },
    ],
    multiple: true,
    editableChoice: false,
  });
  expect(widgets[1]).toMatchObject({ type: 'radio', value: ['同意'], buttonValue: '同意' });
  expect(widgets[2].value).toEqual([]);
});

it('drafts a checkbox group as one selection keyed by each widget export value', () => {
  const base = { fieldName: 'gender', fieldType: 'Btn', checkBox: true, rect: [10, 20, 30, 40] };
  const widgets = formWidgets([
    { ...base, id: '1R', exportValue: 'M', fieldValue: 'Off' },
    { ...base, id: '2R', exportValue: 'F', fieldValue: 'F' },
    // A lone widget keeps its export value: other choices may live on another page.
    { ...base, id: '3R', fieldName: 'agree', exportValue: 'Yes', fieldValue: 'Yes' },
  ]);
  expect(widgets.map((w) => [w.type, w.buttonValue, w.value])).toEqual([
    ['checkbox', 'M', ['F']],
    ['checkbox', 'F', ['F']],
    ['checkbox', undefined, ['Yes']],
  ]);
  const draft = new FormDraft();
  draft.register(widgets);
  expect(draft.value('gender')).toEqual(['F']);
  expect(draft.set('gender', ['M'])).toBe(true);
  expect(draft.value('gender')).toEqual(['M']);
  expect(draft.set('gender', [])).toBe(true);
  expect(draft.values).toEqual({ gender: [] });
});

it('preserves checkbox export values when another option belongs to a hidden layer', () => {
  const base = { fieldName: 'choice', fieldType: 'Btn', checkBox: true, rect: [10, 20, 30, 40] };
  const hidden = { type: 'OCG', id: 'layer' };
  const widgets = formWidgets(
    [
      { ...base, id: '1R', exportValue: 'A', fieldValue: 'Off' },
      { ...base, id: '2R', exportValue: 'B', fieldValue: 'B', oc: hidden },
    ],
    { isVisible: (group) => group !== hidden },
  );
  expect(widgets).toHaveLength(1);
  expect(widgets[0]).toMatchObject({ buttonValue: 'A', value: ['B'] });
  const draft = new FormDraft();
  draft.register(widgets);
  draft.set('choice', ['A']);
  expect(draft.values).toEqual({ choice: ['A'] });
});

describe('widget geometry', () => {
  for (const angle of [0, 90, 180, 270])
    it(`fits all four corners of a widget rotated ${angle} degrees`, () => {
      const rect = [40, 60, 140, 90];
      const viewport = [0, 2, 2, 0, -20, -40];
      const layout = formWidgetLayout({ rect, rotation: angle }, viewport);
      const [a, b, c, d, e, f] = layout.transform;
      const corners = [
        [0, 0],
        [layout.width, 0],
        [0, layout.height],
        [layout.width, layout.height],
      ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      expect(corners.map(([x]) => x).sort((a, b) => a - b)).toEqual([100, 100, 160, 160]);
      expect(corners.map(([, y]) => y).sort((a, b) => a - b)).toEqual([40, 40, 240, 240]);
      expect(layout.width).toBe(angle % 180 ? 30 : 100);
    });
});

it('treats repeated selections as a change and ignores option order', () => {
  const draft = new FormDraft();
  draft.register([{ name: 'Options', value: ['A', 'B'] }]);
  expect(draft.set('Options', ['B', 'A'])).toBe(false);
  expect(draft.set('Options', ['A', 'A'])).toBe(true);
  expect(draft.value('Options')).toEqual(['A', 'A']);
  expect(draft.set('Options', ['A', 'B'])).toBe(true);
  expect(draft.dirty).toBe(false);
});

for (const selected of [false, true])
  for (const exportValue of ['Yes', 'Courier', 'Pickup', ''])
    it(`retains a lone checkbox export value ${exportValue} (selected=${selected})`, () => {
      const [widget] = formWidgets([
        {
          fieldName: 'Delivery',
          fieldType: 'Btn',
          checkBox: true,
          id: '1R',
          rect: [10, 20, 30, 40],
          exportValue,
          fieldValue: selected ? exportValue : 'Off',
        },
      ]);
      expect(widget.exportValue).toBe(exportValue);
      expect(widget.value).toEqual(selected ? [exportValue] : []);
      const draft = new FormDraft();
      draft.register([widget]);
      expect(draft.set(widget.name, selected ? [] : [exportValue])).toBe(true);
      expect(draft.values).toEqual({ Delivery: selected ? [] : [exportValue] });
      draft.undo();
      expect(draft.dirty).toBe(false);
      draft.redo();
      expect(draft.value(widget.name)).toEqual(selected ? [] : [exportValue]);
    });

it('describes widgets by their own tooltip, or by their field’s', () => {
  const text = (fieldName, alternativeText) => ({
    id: fieldName,
    fieldName,
    fieldType: 'Tx',
    rect: [0, 0, 100, 20],
    fieldValue: '',
    alternativeText,
  });
  const tooltips = new Map([
    ['Above', 'From the field'],
    ['Own', 'Not used'],
  ]);
  const widgets = formWidgets(
    [text('Own', ' Your name '), text('Above', ''), text('None', '')],
    undefined,
    undefined,
    tooltips,
  );
  expect(widgets.map((w) => w.tooltip)).toEqual(['Your name', 'From the field', '']);
});
