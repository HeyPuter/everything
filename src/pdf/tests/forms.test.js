import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PDFArray, PDFName, PDFString } from 'pdf-lib';
import {
  PdfSession,
  deletePage,
  deletePages,
  fillFields,
  listFields,
  radioButtonChoices,
} from '../src/core/document.js';
import { flattenCounts, flattenFields } from '../src/core/flatten.js';
import { damagedWidgetsPdf } from './fixtures/damaged-widgets.js';

afterEach(() => vi.restoreAllMocks());

async function formPdf() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const form = doc.getForm();
  for (const name of ['Edited', 'Unchanged']) {
    const field = form.createTextField(name);
    field.setText('Original text');
    field.addToPage(page);
  }
  form.updateFieldAppearances(await doc.embedFont(StandardFonts.TimesRomanItalic));
  return PDFDocument.load(await doc.save());
}

it('reports a damaged field tree instead of overflowing the stack', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  doc.addPage();
  const field = doc.getForm().createTextField('self');
  field.addToPage(page, { x: 40, y: 60, width: 200, height: 30 });
  // Some writers list a field among its own kids, which pdf-lib follows without end.
  field.acroField.dict.lookup(PDFName.of('Kids')).push(field.ref);
  // A save that updates field appearances would recurse without end, so skip that here.
  const bytes = await doc.save({ updateFieldAppearances: false });
  const damaged = await PDFDocument.load(bytes);
  expect(() => listFields(damaged)).toThrow(/damaged/);
  await expect(fillFields(damaged, { self: 'x' })).rejects.toThrow(/damaged/);
  expect(flattenFields(damaged)).toBe(0);
  expect(flattenCounts(damaged).fields).toBe(0);
  // A page operation breaks the loop and saves without overflowing the stack.
  const session = new PdfSession(bytes);
  await session.change((d) => deletePage(d, 1));
  const reopened = await PDFDocument.load(session.bytes);
  expect(reopened.getPageCount()).toBe(1);
  // The repaired form is now walkable, its field intact.
  expect(listFields(reopened).map((f) => f.name)).toEqual(['self']);
});
it('drops the rich-text copy of a field when its plain value is edited', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const field = doc.getForm().createTextField('Rich');
  field.setText('plain old');
  field.addToPage(page, { x: 20, y: 100, width: 200, height: 30 });
  const d = field.acroField.dict;
  d.set(PDFName.of('Ff'), doc.context.obj(1 << 25));
  d.set(PDFName.of('RV'), PDFString.of('<body><p style="font-weight:bold">plain old</p></body>'));
  const loaded = await PDFDocument.load(await doc.save());
  await fillFields(loaded, { Rich: 'new plain' });
  const rd = loaded.getForm().getField('Rich').acroField.dict;
  expect(rd.lookup(PDFName.of('V')).decodeText()).toBe('new plain');
  expect(rd.has(PDFName.of('RV'))).toBe(false);
});
it('preserves original appearances of fields whose values were not changed', async () => {
  const doc = await formPdf();
  const field = doc.getForm().getTextField('Unchanged');
  const before = field.acroField.getWidgets()[0].getNormalAppearance().toString();
  await fillFields(doc, { Edited: 'Revised text', Unchanged: 'Original text' });
  expect(field.acroField.getWidgets()[0].getNormalAppearance().toString()).toBe(before);
  expect(doc.getForm().getTextField('Edited').getText()).toBe('Revised text');
});

it('does not dirty the PDF or create undo history when a form is unchanged', async () => {
  const doc = await formPdf();
  const bytes = await doc.save();
  const session = new PdfSession(bytes);
  await session.change((d) =>
    fillFields(d, { Edited: 'Original text', Unchanged: 'Original text' }),
  );
  expect(session.dirty).toBe(false);
  expect(session.past).toHaveLength(0);
  expect(session.bytes).toEqual(bytes);
});

it('rejects unsupported new form text instead of exporting missing glyphs', async () => {
  const doc = await formPdf();
  const bytes = await doc.save();
  const session = new PdfSession(bytes);
  await expect(session.change((d) => fillFields(d, { Edited: '你好' }))).rejects.toThrow(
    'does not support',
  );
  expect(session.bytes).toEqual(bytes);
  expect(session.dirty).toBe(false);
  await session.change((d) => fillFields(d, { Edited: 'Alex · Αλέξης · Алекс' }));
  const reopened = await PDFDocument.load(session.bytes);
  expect(reopened.getForm().getTextField('Edited').getText()).toBe('Alex · Αλέξης · Алекс');
});

it('selects radio options whose export values do not use the annotation font', async () => {
  const doc = await formPdf();
  const radio = doc.getForm().createRadioGroup('Consent');
  radio.addOptionToPage('同意', doc.getPage(0), { y: 100 });
  radio.addOptionToPage('不同意', doc.getPage(0), { y: 150 });
  const bytes = await doc.save();
  const session = new PdfSession(bytes);
  await session.change((d) => fillFields(d, { Consent: ['同意'] }));
  const reopened = await PDFDocument.load(session.bytes);
  const selected = reopened.getForm().getRadioGroup('Consent');
  expect(selected.getSelected()).toBe('同意');
  const widgets = selected.acroField.getWidgets();
  expect(widgets[0].getAppearanceState()).toBe(widgets[0].getOnValue());
  expect(widgets[1].getAppearanceState().toString()).toBe('/Off');
  session.undo();
  expect(session.bytes).toEqual(bytes);
});

it('preserves choice export values and flags while rendering display labels', async () => {
  const { PDFHexString, PDFName } = await import('pdf-lib');
  const { listFields } = await import('../src/core/document.js');
  const doc = await formPdf();
  const choice = doc.getForm().createDropdown('Country');
  choice.acroField.setOptions([
    { value: PDFHexString.fromText('日本'), display: PDFHexString.fromText('Japan') },
    { value: PDFHexString.fromText('fr'), display: PDFHexString.fromText('France') },
  ]);
  choice.addToPage(doc.getPage(0), { y: 300 });
  const flags = choice.acroField.getFlags();
  await fillFields(doc, { Country: ['日本'] });
  const bytes = await doc.save();
  const reopened = await PDFDocument.load(bytes);
  const result = reopened.getForm().getDropdown('Country');
  expect(result.getSelected()).toEqual(['日本']);
  expect(result.acroField.getFlags()).toBe(flags);
  expect(listFields(reopened).find((f) => f.name === 'Country')).toMatchObject({
    options: ['日本', 'fr'],
    choices: [
      { value: '日本', label: 'Japan' },
      { value: 'fr', label: 'France' },
    ],
  });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const page = await (await task.promise).getPage(1);
    const list = await page.getOperatorList();
    const shown = list.fnArray
      .flatMap((op, i) =>
        op === pdfjs.OPS.showText
          ? list.argsArray[i][0].filter((g) => typeof g !== 'number').map((g) => g.unicode)
          : [],
      )
      .join('');
    expect(shown).toContain('Japan');
    expect(shown).not.toContain('日本');
  } finally {
    await task.destroy();
  }
  expect(result.acroField.dict.has(PDFName.of('I'))).toBe(false);
});

it('writes correct multi-selection indices for choices whose labels differ from exports', async () => {
  const { PDFHexString, PDFName } = await import('pdf-lib');
  const doc = await formPdf();
  const field = doc.getForm().createOptionList('List');
  field.enableMultiselect();
  field.acroField.setOptions(
    Array.from({ length: 12 }, (_, i) => ({
      value: PDFHexString.fromText(`v${i}`),
      display: PDFHexString.fromText(`Label ${i}`),
    })),
  );
  field.addToPage(doc.getPage(0), { y: 200, height: 200 });
  await fillFields(doc, { List: ['v10', 'v2'] });
  const result = (await PDFDocument.load(await doc.save())).getForm().getOptionList('List');
  expect(result.getSelected()).toEqual(['v10', 'v2']);
  expect(
    result.acroField.dict
      .lookup(PDFName.of('I'))
      .asArray()
      .map((n) => n.asNumber()),
  ).toEqual([2, 10]);
});

it('rejects invalid choice selections without modifying the document or enabling custom input', async () => {
  const doc = await formPdf();
  const field = doc.getForm().createDropdown('Restricted');
  field.setOptions(['A', 'B']);
  field.addToPage(doc.getPage(0), { y: 100 });
  const session = new PdfSession(await doc.save());
  const original = session.bytes.slice();
  await expect(session.change((d) => fillFields(d, { Restricted: ['missing'] }))).rejects.toThrow(
    'available form options',
  );
  await expect(session.change((d) => fillFields(d, { Restricted: ['A', 'B'] }))).rejects.toThrow(
    'one selection',
  );
  expect(session.bytes).toEqual(original);
  expect(session.past).toHaveLength(0);
});

it('clears text and choices explicitly so default values cannot reappear after export', async () => {
  const { PDFHexString, PDFName } = await import('pdf-lib');
  const doc = await formPdf();
  const text = doc.getForm().getTextField('Edited');
  text.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('Default name'));
  const choice = doc.getForm().createDropdown('Default choice');
  choice.setOptions(['A', 'B']);
  choice.select('B');
  choice.addToPage(doc.getPage(0), { y: 150 });
  choice.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('A'));
  await fillFields(doc, { Edited: '', 'Default choice': [] });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: await doc.save() });
  try {
    const page = await (await task.promise).getPage(1);
    const annotations = await page.getAnnotations();
    expect(annotations.find((a) => a.fieldName === 'Edited').fieldValue).toBe('');
    expect(annotations.find((a) => a.fieldName === 'Default choice').fieldValue).toEqual([]);
  } finally {
    await task.destroy();
  }
});

it('reads and clears default-only fields without losing undo history', async () => {
  const { PDFHexString, PDFName } = await import('pdf-lib');
  const { listFields } = await import('../src/core/document.js');
  const doc = await formPdf();
  const form = doc.getForm();
  const text = form.getTextField('Edited');
  text.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('Default name'));
  text.acroField.dict.delete(PDFName.of('V'));
  const choice = form.createDropdown('Choice');
  choice.setOptions(['A', 'B']);
  choice.addToPage(doc.getPage(0), { y: 200 });
  choice.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText('A'));
  const check = form.createCheckBox('Check');
  check.addToPage(doc.getPage(0), { y: 250 });
  check.acroField.dict.set(PDFName.of('DV'), check.acroField.getOnValue());
  check.acroField.dict.delete(PDFName.of('V'));
  const radio = form.createRadioGroup('Radio');
  radio.addOptionToPage('Yes', doc.getPage(0), { y: 300 });
  radio.acroField.dict.set(PDFName.of('DV'), radio.acroField.getOnValues()[0]);
  radio.acroField.dict.delete(PDFName.of('V'));
  const before = await doc.save();
  const values = (doc) => Object.fromEntries(listFields(doc).map((f) => [f.name, f.value]));
  expect(values(doc)).toMatchObject({
    Edited: 'Default name',
    Choice: ['A'],
    Check: true,
    Radio: 'Yes',
  });
  const session = new PdfSession(before);
  await session.change((d) => fillFields(d, { Edited: '', Choice: [], Check: false, Radio: [] }));
  expect(session.past).toHaveLength(1);
  const reopened = await PDFDocument.load(session.bytes);
  expect(values(reopened)).toMatchObject({
    Edited: '',
    Choice: [],
    Check: false,
    Radio: undefined,
  });
  session.undo();
  expect(session.bytes).toEqual(before);
  expect(values(await PDFDocument.load(session.bytes))).toMatchObject({
    Edited: 'Default name',
    Choice: ['A'],
    Check: true,
    Radio: 'Yes',
  });
});

/** A checkbox field with two widgets whose on states differ, as Acrobat's checkbox groups have. */
async function checkBoxGroupPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const box = doc.getForm().createCheckBox('gender');
  box.addToPage(page, { x: 20, y: 200, width: 20, height: 20 });
  box.addToPage(page, { x: 120, y: 200, width: 20, height: 20 });
  box.acroField.getWidgets().forEach((widget, i) => {
    const normal = widget.getAppearances().normal;
    const on = normal.get(PDFName.of('Yes'));
    normal.delete(PDFName.of('Yes'));
    normal.set(PDFName.of(i ? 'F' : 'M'), on);
    widget.setAppearanceState(PDFName.of('Off'));
  });
  box.acroField.dict.set(PDFName.of('V'), PDFName.of('Off'));
  return PDFDocument.load(await doc.save());
}
const states = (doc) =>
  doc
    .getForm()
    .getCheckBox('gender')
    .acroField.getWidgets()
    .map((widget) => widget.getAppearanceState()?.decodeText());

it('offers a checkbox group as one choice and turns on the chosen box alone', async () => {
  const doc = await checkBoxGroupPdf();
  expect(listFields(doc)).toEqual([
    {
      name: 'gender',
      readOnly: false,
      type: 'select',
      options: ['M', 'F'],
      value: [],
      multiple: false,
    },
  ]);
  expect(await fillFields(doc, { gender: ['F'] })).toBeUndefined();
  expect(doc.getForm().getCheckBox('gender').acroField.getValue().decodeText()).toBe('F');
  expect(states(doc)).toEqual(['Off', 'F']);
  expect(listFields(doc)[0].value).toEqual(['F']);
  // The same choice again changes nothing; another box moves the state over.
  expect(await fillFields(doc, { gender: ['F'] })).toBe(false);
  await fillFields(doc, { gender: 'M' });
  expect(states(doc)).toEqual(['M', 'Off']);
  await fillFields(doc, { gender: [] });
  expect(doc.getForm().getCheckBox('gender').acroField.getValue().decodeText()).toBe('Off');
  expect(states(doc)).toEqual(['Off', 'Off']);
  await expect(fillFields(doc, { gender: ['X'] })).rejects.toThrow('available form options');
  await expect(fillFields(doc, { gender: ['M', 'F'] })).rejects.toThrow('one selection');
  // A reopened copy reads the same way.
  await fillFields(doc, { gender: ['M'] });
  const reopened = await PDFDocument.load(await doc.save());
  expect(listFields(reopened)[0].value).toEqual(['M']);
  expect(states(reopened)).toEqual(['M', 'Off']);
});

it('accepts an inline checkbox export value without creating redundant edits', async () => {
  const doc = await PDFDocument.create();
  const field = doc.getForm().createCheckBox('Agree');
  field.addToPage(doc.addPage(), { x: 40, y: 50 });
  expect(await fillFields(doc, { Agree: ['Yes'] })).toBeUndefined();
  expect(field.isChecked()).toBe(true);
  expect(await fillFields(doc, { Agree: ['Yes'] })).toBe(false);
  expect(await fillFields(doc, { Agree: true })).toBe(false);
  expect(await fillFields(doc, { Agree: [] })).toBeUndefined();
  expect(field.isChecked()).toBe(false);
  expect(await fillFields(doc, { Agree: false })).toBe(false);
});

it('lists a radio choice once when several buttons share its export value', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const size = doc.getForm().createRadioGroup('Size');
  for (const [value, x] of [
    ['Small', 40],
    ['Small', 80],
    ['Large', 120],
  ])
    size.addOptionToPage(value, page, { x, y: 340, width: 16, height: 16 });
  const loaded = await PDFDocument.load(await doc.save());
  expect(listFields(loaded)[0].options).toEqual(['Small', 'Large']);
  await fillFields(loaded, { Size: ['Small'] });
  expect(listFields(loaded)[0].value).toBe('Small');
});

it('deletes many pages of a form at once as one by one, reading the fields once', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const build = async () => {
    const doc = await PDFDocument.create();
    const pages = Array.from({ length: 6 }, () => doc.addPage([300, 300]));
    const form = doc.getForm();
    pages.forEach((page, i) => {
      const field = form.createTextField(`name${i}`);
      field.setText(`Name ${i}`);
      field.addToPage(page, { x: 20, y: 20, width: 150, height: 24 });
    });
    // Fields with widgets on several pages, some of them deleted.
    const shared = form.createTextField('shared');
    shared.setText('Shared');
    for (const i of [1, 2, 4]) shared.addToPage(pages[i], { x: 20, y: 60, width: 150, height: 24 });
    const radio = form.createRadioGroup('choice');
    ['A', 'B', 'C'].forEach((option, i) =>
      radio.addOptionToPage(option, pages[i * 2], { x: 20, y: 100, width: 20, height: 20 }),
    );
    radio.select('C');
    const box = form.createCheckBox('agree');
    box.addToPage(pages[3], { x: 20, y: 140, width: 20, height: 20 });
    box.check();
    // Writers often leave out a widget's page, which deletion then matches by reference.
    for (const field of form.getFields())
      for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of('P'));
    return PDFDocument.load(await doc.save());
  };
  const summary = async (doc) => {
    const saved = await PDFDocument.load(await doc.save());
    return { pages: saved.getPageCount(), fields: listFields(saved) };
  };
  const oneByOne = await build();
  for (const index of [5, 4, 2, 1]) deletePage(oneByOne, index);
  const together = await build();
  const fields = together.catalog.lookup(PDFName.of('AcroForm')).lookup(PDFName.of('Fields'));
  const size = vi.spyOn(PDFArray.prototype, 'size');
  deletePages(together, [1, 2, 4, 5]);
  const walks = size.mock.contexts.filter((array) => array === fields).length;
  size.mockRestore();
  expect(await summary(together)).toEqual(await summary(oneByOne));
  expect((await summary(together)).fields.map((field) => field.name)).toEqual([
    'name0',
    'name3',
    'choice',
    'agree',
  ]);
  // Reading every field once per deleted page made deleting many pages of a long form slow.
  const single = await build();
  const singleFields = single.catalog.lookup(PDFName.of('AcroForm')).lookup(PDFName.of('Fields'));
  const sizeOne = vi.spyOn(PDFArray.prototype, 'size');
  deletePages(single, [1]);
  const one = sizeOne.mock.contexts.filter((array) => array === singleFields).length;
  sizeOne.mockRestore();
  expect(walks).toBeLessThan(2 * one);
});

it('keeps naming the field’s own font after filling, for viewers that redraw it', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const source = await PDFDocument.create();
  const page = source.addPage();
  const form = source.getForm();
  const courier = source.context.register(
    source.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' }),
  );
  form.acroForm.dict.set(PDFName.of('DR'), source.context.obj({ Font: { Cour: courier } }));
  const text = form.createTextField('Code');
  text.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
  text.acroField.setDefaultAppearance('/Cour 10 Tf 0 0 1 rg');
  const choice = form.createDropdown('Pick');
  choice.addOptions(['One', 'Two']);
  choice.addToPage(page, { x: 50, y: 500, width: 200, height: 24 });
  choice.acroField.setDefaultAppearance('/Cour 0 Tf 0 g');
  const doc = await PDFDocument.load(await source.save());
  await fillFields(doc, { Code: 'ABC-123', Pick: ['Two'] });
  const saved = (await PDFDocument.load(await doc.save())).getForm();
  expect(saved.getTextField('Code').acroField.getDefaultAppearance()).toBe('/Cour 10 Tf 0 0 1 rg');
  expect(saved.getDropdown('Pick').acroField.getDefaultAppearance()).toBe('/Cour 0 Tf 0 g');
  expect(saved.getTextField('Code').getText()).toBe('ABC-123');
});

it('tells apart radio buttons that share an export value, unless they are in unison', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();
  const size = form.createRadioGroup('Size');
  for (const [value, x] of [
    ['Small', 40],
    ['Small', 80],
    ['Large', 120],
  ])
    size.addOptionToPage(value, page, { x, y: 340, width: 16, height: 16 });
  const plain = form.createRadioGroup('Plain');
  for (const [value, x] of [
    ['Yes', 40],
    ['No', 80],
  ])
    plain.addOptionToPage(value, page, { x, y: 300, width: 16, height: 16 });
  const loaded = await PDFDocument.load(await doc.save());
  const choices = radioButtonChoices(loaded);
  // Only the field with a shared value needs choices; "Large" stays its export value.
  expect([...choices.keys()]).toEqual(['Size']);
  const { choices: byWidget, selected } = choices.get('Size');
  const [first, second, large] = [...byWidget.values()];
  expect(large).toBe('Large');
  expect(first).not.toBe(second);
  expect(selected).toBeNull();
  await fillFields(loaded, { Size: [first] });
  const states = () =>
    loaded
      .getForm()
      .getRadioGroup('Size')
      .acroField.getWidgets()
      .map((widget) => widget.dict.lookup(PDFName.of('AS')).decodeText());
  expect(states()).toEqual(['0', 'Off', 'Off']);
  expect(radioButtonChoices(loaded).get('Size').selected).toBe(first);
  // The export value alone still works, as the Fill forms dialog gives it.
  await fillFields(loaded, { Size: ['Large'] });
  expect(states()).toEqual(['Off', 'Off', '2']);
  expect(listFields(loaded)[0].value).toBe('Large');
  loaded
    .getForm()
    .getRadioGroup('Size')
    .acroField.setFlagTo(1 << 25, true);
  expect(radioButtonChoices(loaded).has('Size')).toBe(false);
  await fillFields(loaded, { Size: ['Small'] });
  expect(states()).toEqual(['0', '1', 'Off']);
});
it('leaves a radio group whose widgets cannot be read to its export values', async () => {
  // A damaged widget entry must not stop the page's form controls from being drawn.
  const doc = await PDFDocument.load(await damagedWidgetsPdf('radio'), { updateMetadata: false });
  expect(() => radioButtonChoices(doc)).not.toThrow();
});
