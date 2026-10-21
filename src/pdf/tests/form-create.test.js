import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  addFormField,
  deleteFormField,
  detectFormFields,
  listFormFields,
  moveFormWidget,
  setFieldTabOrder,
  updateFormField,
} from '../src/core/form-create.js';
import { PdfSession, fillFields, listFields } from '../src/core/document.js';
import { flattenDocument } from '../src/core/flatten.js';

afterEach(() => vi.restoreAllMocks());

const name = PDFName.of;
const fontDir = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;

async function mockTextFont() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
}
async function blank(rotation = 0) {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).setRotation(degrees(rotation));
  return doc;
}
async function withPdfjs(bytes, callback) {
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: fontDir });
  try {
    return await callback(await (await task.promise).getPage(1));
  } finally {
    await task.destroy();
  }
}
const annotations = (bytes) => withPdfjs(bytes, (page) => page.getAnnotations());
/** Render page 1 (rotation applied) and return a pixel reader in viewport space. */
function rendered(bytes, scale = 2) {
  return withPdfjs(bytes, async (page) => {
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    /** Ink pixels in a user-space rectangle, and their bounding box in device space. */
    const ink = ({ x, y, width: w, height: h }, inset = 0) => {
      const corners = [
        [x + inset, y + inset],
        [x + w - inset, y + h - inset],
      ].map(([px, py]) => viewport.convertToViewportPoint(px, py));
      const [x0, x1] = [corners[0][0], corners[1][0]].sort((a, b) => a - b);
      const [y0, y1] = [corners[0][1], corners[1][1]].sort((a, b) => a - b);
      let count = 0,
        box = null;
      for (let py = Math.ceil(y0); py < Math.min(height, y1); py++)
        for (let px = Math.ceil(x0); px < Math.min(width, x1); px++) {
          const i = (py * width + px) * 4;
          if (data[i] + data[i + 1] + data[i + 2] < 384) {
            count++;
            box = box
              ? [
                  Math.min(box[0], px),
                  Math.min(box[1], py),
                  Math.max(box[2], px),
                  Math.max(box[3], py),
                ]
              : [px, py, px, py];
          }
        }
      return { count, box };
    };
    return { ink };
  });
}
const rect = (x, y, width, height) => ({ x, y, width, height });

/** One field of every type, as the Prepare Form toolbar adds them. */
async function everyField(doc) {
  return [
    await addFormField(doc, 0, {
      type: 'text',
      name: 'First name',
      rect: rect(50, 700, 200, 22),
      defaultValue: 'Ada',
      tooltip: 'Your first name',
      required: true,
    }),
    await addFormField(doc, 0, {
      type: 'text',
      name: 'Notes',
      rect: rect(300, 640, 200, 60),
      multiline: true,
      alignment: 'center',
      defaultValue: 'Line one\nLine two',
    }),
    await addFormField(doc, 0, {
      type: 'text',
      name: 'PIN',
      rect: rect(300, 600, 100, 22),
      comb: true,
      maxLength: 4,
      defaultValue: '1234',
      readOnly: true,
    }),
    await addFormField(doc, 0, {
      type: 'text',
      name: 'Secret',
      rect: rect(420, 600, 100, 22),
      password: true,
      defaultValue: 'hidden',
    }),
    await addFormField(doc, 0, {
      type: 'checkbox',
      name: 'Agree',
      rect: rect(50, 660, 14, 14),
      checked: true,
      exportValue: 'On',
      style: 'cross',
    }),
    await addFormField(doc, 0, {
      type: 'radio',
      name: 'Color',
      rect: rect(50, 630, 14, 14),
      exportValue: 'Red',
    }),
    await addFormField(doc, 0, {
      type: 'radio',
      name: 'Color',
      rect: rect(80, 630, 14, 14),
      exportValue: 'Blue',
      checked: true,
    }),
    await addFormField(doc, 0, {
      type: 'dropdown',
      name: 'Size',
      rect: rect(50, 590, 120, 22),
      options: ['Small', 'Medium', { value: 'L', label: 'Large' }],
      defaultValue: 'L',
      editable: true,
    }),
    await addFormField(doc, 0, {
      type: 'listbox',
      name: 'Toppings',
      rect: rect(50, 500, 120, 70),
      options: ['Olives', 'Cheese', 'Ham'],
      sorted: true,
      multiSelect: true,
      defaultValue: ['Ham', 'Olives'],
    }),
    await addFormField(doc, 0, {
      type: 'button',
      name: 'Reset',
      rect: rect(50, 460, 80, 24),
      label: 'Reset',
      action: 'reset',
    }),
    await addFormField(doc, 0, { type: 'signature', rect: rect(50, 400, 200, 40) }),
    await addFormField(doc, 0, { type: 'date', rect: rect(300, 700, 100, 22) }),
  ];
}

it('creates every field type, read back by pdf-lib and PDF.js', async () => {
  const doc = await blank();
  const names = await everyField(doc);
  expect(names).toEqual([
    'First name',
    'Notes',
    'PIN',
    'Secret',
    'Agree',
    'Color',
    'Color',
    'Size',
    'Toppings',
    'Reset',
    'Signature1',
    'Date1',
  ]);
  const bytes = await doc.save();
  const form = (await PDFDocument.load(bytes)).getForm();
  expect(form.getFields().map((f) => [f.getName(), f.constructor.name])).toEqual([
    ['First name', 'PDFTextField'],
    ['Notes', 'PDFTextField'],
    ['PIN', 'PDFTextField'],
    ['Secret', 'PDFTextField'],
    ['Agree', 'PDFCheckBox'],
    ['Color', 'PDFRadioGroup'],
    ['Size', 'PDFDropdown'],
    ['Toppings', 'PDFOptionList'],
    ['Reset', 'PDFButton'],
    ['Signature1', 'PDFSignature'],
    ['Date1', 'PDFTextField'],
  ]);
  expect(form.getTextField('First name').getText()).toBe('Ada');
  expect(form.getTextField('PIN').isCombed()).toBe(true);
  expect(form.getTextField('PIN').getMaxLength()).toBe(4);
  expect(form.getCheckBox('Agree').isChecked()).toBe(true);
  expect(form.getRadioGroup('Color').getSelected()).toBe('Blue');
  expect(form.getDropdown('Size').isEditable()).toBe(true);
  expect(form.getOptionList('Toppings').getOptions()).toEqual(['Cheese', 'Ham', 'Olives']);

  const byName = new Map();
  for (const a of await annotations(bytes)) byName.set(`${a.fieldName}/${a.buttonValue ?? ''}`, a);
  const first = byName.get('First name/');
  expect(first).toMatchObject({
    fieldType: 'Tx',
    fieldValue: 'Ada',
    required: true,
    alternativeText: 'Your first name',
    rect: [50, 700, 250, 722],
    hasAppearance: true,
  });
  expect(first.defaultAppearanceData.fontName).toBe('Helv');
  expect(byName.get('Notes/')).toMatchObject({ multiLine: true, textAlignment: 1 });
  expect(byName.get('PIN/')).toMatchObject({ comb: true, maxLen: 4, readOnly: true });
  expect(byName.get('Secret/')).toMatchObject({ password: true });
  expect(byName.get('Agree/')).toMatchObject({
    checkBox: true,
    exportValue: 'On',
    fieldValue: 'On',
  });
  expect(byName.get('Color/Red')).toMatchObject({ radioButton: true, fieldValue: 'Blue' });
  expect(byName.get('Color/Blue')).toMatchObject({ radioButton: true });
  expect(byName.get('Size/')).toMatchObject({
    fieldType: 'Ch',
    combo: true,
    fieldValue: ['L'],
    options: [
      { exportValue: 'Small', displayValue: 'Small' },
      { exportValue: 'Medium', displayValue: 'Medium' },
      { exportValue: 'L', displayValue: 'Large' },
    ],
  });
  expect(byName.get('Toppings/')).toMatchObject({
    multiSelect: true,
    fieldValue: ['Ham', 'Olives'],
  });
  expect(byName.get('Reset/')).toMatchObject({ pushButton: true });
  expect(byName.get('Reset/').resetForm).toBeTruthy();
  expect(byName.get('Signature1/')).toMatchObject({ fieldType: 'Sig' });
  expect(byName.get('Date1/')).toMatchObject({
    datetimeType: 'date',
    datetimeFormat: 'mm/dd/yyyy',
  });

  // The same fields as the Prepare Form panel lists them.
  const listed = listFormFields(await PDFDocument.load(bytes));
  expect(listed.map((f) => [f.name, f.type, f.widgetIndex])).toEqual([
    ['First name', 'text', 0],
    ['Notes', 'text', 0],
    ['PIN', 'text', 0],
    ['Secret', 'text', 0],
    ['Agree', 'checkbox', 0],
    ['Color', 'radio', 0],
    ['Color', 'radio', 1],
    ['Size', 'dropdown', 0],
    ['Toppings', 'listbox', 0],
    ['Reset', 'button', 0],
    ['Signature1', 'signature', 0],
    ['Date1', 'date', 0],
  ]);
  expect(listed[0]).toMatchObject({
    page: 0,
    rect: rect(50, 700, 200, 22),
    props: { tooltip: 'Your first name', required: true, fontSize: 12, font: 'Helvetica' },
  });
  expect(listed[2].props).toMatchObject({ comb: true, maxLength: 4, readOnly: true });
  expect(listed[4].props).toMatchObject({ exportValue: 'On', checked: true, style: 'cross' });
  expect(listed[6].props).toMatchObject({ exportValue: 'Blue', checkedByDefault: true });
  expect(listed[8].props).toMatchObject({ sorted: true, defaultValue: ['Ham', 'Olives'] });
  expect(listed[9].props).toMatchObject({
    label: 'Reset',
    action: 'reset',
    backgroundColor: '#bfbfbf',
  });
  expect(listed[11].props).toMatchObject({ format: 'date', dateFormat: 'mm/dd/yyyy' });
});

it('draws visible appearances for every new field', async () => {
  const doc = await blank();
  await everyField(doc);
  // An unchecked twin shows how much of a widget's ink is the mark itself.
  await addFormField(doc, 0, { type: 'checkbox', name: 'Off box', rect: rect(100, 660, 14, 14) });
  const bytes = await doc.save();
  const { ink } = await rendered(bytes);
  for (const field of listFormFields(await PDFDocument.load(bytes)))
    expect(ink(field.rect).count, field.name).toBeGreaterThan(20);
  // Marks and values, not just borders: look inside the border.
  expect(ink(rect(50, 660, 14, 14), 2).count).toBeGreaterThan(
    ink(rect(100, 660, 14, 14), 2).count + 20,
  );
  expect(ink(rect(80, 630, 14, 14), 3).count).toBeGreaterThan(
    ink(rect(50, 630, 14, 14), 3).count + 10,
  );
  expect(ink(rect(50, 700, 200, 22), 2).count).toBeGreaterThan(50);
  expect(ink(rect(300, 600, 100, 22), 2).count).toBeGreaterThan(50);
});

it('joins radio buttons into their group, which the fill tool then selects', async () => {
  await mockTextFont();
  const doc = await blank();
  await addFormField(doc, 0, {
    type: 'radio',
    name: 'Pet',
    rect: rect(50, 700, 14, 14),
    exportValue: 'Cat',
  });
  await addFormField(doc, 0, {
    type: 'radio',
    name: 'Pet',
    rect: rect(80, 700, 14, 14),
    exportValue: 'Dog',
  });
  // An export value that is not a plain PDF name goes through Opt.
  await addFormField(doc, 0, {
    type: 'radio',
    name: 'Pet',
    rect: rect(110, 700, 14, 14),
    exportValue: 'Pájaro',
  });
  const field = listFields(doc).find((f) => f.name === 'Pet');
  expect(field.options).toEqual(['Cat', 'Dog', 'Pájaro']);
  await fillFields(doc, { Pet: 'Pájaro' });
  const reopened = await PDFDocument.load(await doc.save());
  expect(listFields(reopened).find((f) => f.name === 'Pet').value).toBe('Pájaro');
  const kids = reopened.getForm().getRadioGroup('Pet').acroField.getWidgets();
  expect(kids.map((w) => w.getAppearanceState()?.decodeText())).toEqual(['Off', 'Off', '2']);
  expect(listFormFields(reopened).map((f) => f.props.exportValue)).toEqual([
    'Cat',
    'Dog',
    'Pájaro',
  ]);
});

it('joins a radio button to the group it is named after, as placed buttons are grouped', async () => {
  await mockTextFont();
  const doc = await blank();
  // Each button placed with the radio tool starts its own group, with the first choice.
  const place = (x) =>
    addFormField(doc, 0, { type: 'radio', rect: rect(x, 700, 14, 14), exportValue: 'Choice 1' });
  const first = await place(50);
  const second = await place(80);
  const third = await place(110);
  expect(await updateFormField(doc, second, { name: first, widgetIndex: 0 })).toBe(first);
  // An export value asked for at the same time is kept. A button on in its own group is off
  // in a group that has another value.
  await updateFormField(doc, third, { checked: true, widgetIndex: 0 });
  expect(
    await updateFormField(doc, third, { name: first, widgetIndex: 0, exportValue: 'Other' }),
  ).toBe(first);
  const states = () =>
    doc
      .getForm()
      .getRadioGroup(first)
      .acroField.getWidgets()
      .map((w) => w.getAppearanceState()?.decodeText());
  expect(states()).toEqual(['Off', 'Off', 'Off']);
  expect(listFormFields(doc).map((f) => [f.name, f.props.exportValue])).toEqual([
    [first, 'Choice 1'],
    [first, 'Choice 2'],
    [first, 'Other'],
  ]);
  await fillFields(doc, { [first]: 'Choice 2' });
  const bytes = await doc.save();
  const reopened = await PDFDocument.load(bytes);
  expect(listFields(reopened).map((f) => f.name)).toEqual([first]);
  const widgets = reopened.getForm().getRadioGroup(first).acroField.getWidgets();
  expect(widgets.map((w) => w.getAppearanceState()?.decodeText())).toEqual([
    'Off',
    'Choice 2',
    'Off',
  ]);
  const buttons = (await annotations(bytes)).filter((a) => a.radioButton);
  expect(buttons.map((a) => [a.fieldName, a.buttonValue])).toEqual([
    [first, 'Choice 1'],
    [first, 'Choice 2'],
    [first, 'Other'],
  ]);
  // Fields of other kinds still take a free name.
  const text = await addFormField(doc, 0, { type: 'text', rect: rect(50, 600, 100, 20) });
  expect(await updateFormField(doc, text, { name: first })).toBe(`${first}_2`);
});

it('checks by default the box of a check box group whose properties say so', async () => {
  const source = await blank();
  const box = source.getForm().createCheckBox('Pick');
  box.addToPage(source.getPage(0), { x: 40, y: 600, width: 16, height: 16 });
  box.addToPage(source.getPage(0), { x: 80, y: 600, width: 16, height: 16 });
  // The second box gets its own on state, as the boxes of Acrobat's check box groups have.
  const states = box.acroField.getWidgets()[1].dict.lookup(name('AP'));
  for (const kind of ['N', 'D']) {
    const drawings = states.lookup(name(kind));
    drawings.set(name('Two'), drawings.get(name('Yes')));
    drawings.delete(name('Yes'));
  }
  const doc = await PDFDocument.load(await source.save());
  await updateFormField(doc, 'Pick', { checked: true, widgetIndex: 1 });
  const listed = listFormFields(await PDFDocument.load(await doc.save()));
  expect(
    listed.map(({ props }) => [props.exportValue, props.checked, props.checkedByDefault]),
  ).toEqual([
    ['Yes', false, false],
    ['Two', true, true],
  ]);
});

it('keeps the drawing of a signed signature field when it is moved or changed', async () => {
  const doc = await blank();
  await addFormField(doc, 0, { type: 'signature', name: 'Sig', rect: rect(50, 50, 150, 40) });
  const field = doc.getForm().getSignature('Sig');
  const widget = field.acroField.getWidgets()[0];
  const drawing = doc.context.register(
    doc.context.formXObject([], { BBox: doc.context.obj([0, 0, 150, 40]) }),
  );
  widget.dict.set(name('AP'), doc.context.obj({ N: drawing }));
  field.acroField.dict.set(name('V'), doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite' }));
  await updateFormField(doc, 'Sig', { tooltip: 'Signed by Ada' });
  await moveFormWidget(doc, 'Sig', 0, rect(60, 50, 150, 40));
  expect(widget.dict.lookup(name('AP')).get(name('N'))).toBe(drawing);
  expect(listFormFields(doc)[0].props).toMatchObject({ signed: true, tooltip: 'Signed by Ada' });
});

it('keeps the picture of a button when it is renamed, retitled, or moved', async () => {
  await mockTextFont();
  const source = await blank();
  const logo = await source.embedPng(await readFile(new URL('../icon.png', import.meta.url)));
  const button = source.getForm().createButton('Logo');
  button.addToPage('', source.getPage(0), { x: 50, y: 600, width: 64, height: 64 });
  button.setImage(logo);
  const doc = await PDFDocument.load(await source.save());
  const widget = () => doc.getForm().getFields()[0].acroField.getWidgets()[0];
  const drawing = () => widget().dict.lookup(name('AP')).get(name('N'));
  const original = drawing();
  await updateFormField(doc, 'Logo', { tooltip: 'Company logo', required: true, name: 'Brand' });
  await moveFormWidget(doc, 'Brand', 0, rect(80, 500, 64, 64));
  expect(drawing()).toBe(original);
  // A new size is drawn anew.
  await moveFormWidget(doc, 'Brand', 0, rect(80, 500, 96, 64));
  expect(drawing()).not.toBe(original);
});

it('keeps the first of several selections when a list stops taking several', async () => {
  await mockTextFont();
  const doc = await blank();
  await addFormField(doc, 0, {
    type: 'listbox',
    name: 'Toppings',
    rect: rect(50, 600, 120, 60),
    options: ['Olives', 'Cheese', 'Ham'],
    multiSelect: true,
    defaultValue: ['Cheese', 'Ham'],
  });
  await fillFields(doc, { Toppings: ['Olives', 'Ham'] });
  await updateFormField(doc, 'Toppings', { multiSelect: false });
  const bytes = await doc.save();
  const reopened = await PDFDocument.load(bytes);
  const [field] = listFormFields(reopened);
  expect(field.props).toMatchObject({
    multiSelect: false,
    value: ['Olives'],
    defaultValue: ['Cheese'],
  });
  expect(reopened.getForm().getOptionList('Toppings').acroField.dict.has(name('I'))).toBe(false);
  expect(listFields(reopened)[0]).toMatchObject({ multiple: false, value: ['Olives'] });
  // Only the row still chosen is painted as selected.
  const widget = reopened.getForm().getOptionList('Toppings').acroField.getWidgets()[0];
  const drawing = reopened.context.lookup(widget.getNormalAppearance());
  const operators = new TextDecoder().decode(decodePDFRawStream(drawing).decode());
  expect(operators.match(/0\.6 0\.7\d* 0\.8\d* rg/g)).toHaveLength(1);
});

it('takes only numbers in number and percent fields', async () => {
  await mockTextFont();
  const doc = await blank();
  await addFormField(doc, 0, {
    type: 'text',
    name: 'Amount',
    rect: rect(50, 600, 200, 24),
    format: 'number',
    tooltip: 'Amount due',
  });
  await addFormField(doc, 0, { type: 'text', name: 'Rate', rect: rect(50, 500, 200, 24) });
  await updateFormField(doc, 'Rate', { format: 'percent', decimals: 1 });
  await addFormField(doc, 0, { type: 'text', name: 'Note', rect: rect(50, 400, 200, 24) });
  await expect(fillFields(doc, { Amount: '12 apples' })).rejects.toThrow(
    'Enter a number in Amount due, such as 1234.5.',
  );
  await expect(fillFields(doc, { Rate: '5%' })).rejects.toThrow('Enter a number in Rate');
  await fillFields(doc, { Amount: '-1234.5', Rate: '0,25', Note: 'twelve' });
  await fillFields(doc, { Amount: '' });
  expect(listFields(doc).map((field) => field.value)).toEqual(['', '0,25', 'twelve']);
});

it('shows number and percent fields as their formats do, keeping the value typed', async () => {
  await mockTextFont();
  const doc = await blank();
  const formats = {
    Amount: { format: 'number', decimals: 2 },
    Count: { format: 'number', decimals: 0 },
    Rate: { format: 'percent', decimals: 1 },
  };
  for (const [i, [fieldName, props]] of Object.entries(formats).entries())
    await addFormField(doc, 0, {
      type: 'text',
      name: fieldName,
      rect: rect(50, 600 - 60 * i, 200, 24),
      ...props,
    });
  // Another tool's currency format, with negative amounts in parentheses.
  await addFormField(doc, 0, { type: 'text', name: 'Price', rect: rect(50, 400, 200, 24) });
  const actions = doc.getForm().getTextField('Price').acroField.dict;
  actions.set(
    name('AA'),
    doc.context.obj({
      F: {
        S: 'JavaScript',
        JS: PDFHexString.fromText('AFNumber_Format(2, 2, 2, 0, " \\u20AC", false);'),
      },
    }),
  );
  await fillFields(doc, { Amount: '1234567.5', Count: '-42', Rate: '0.125', Price: '-1234,5' });
  expect(listFields(doc).map((field) => field.value)).toEqual([
    '1234567.5',
    '-42',
    '0.125',
    '-1234,5',
  ]);
  flattenDocument(doc);
  const text = await withPdfjs(await doc.save(), async (page) =>
    (await page.getTextContent()).items.map((item) => item.str).join(' '),
  );
  for (const shown of ['1,234,567.50', '-42', '12.5%', '(1.234,50 €)'])
    expect(text).toContain(shown);
});

it('gives taken names a numbered suffix, also for names nested under a field', async () => {
  const doc = await blank();
  const add = (type, fieldName, y) =>
    addFormField(doc, 0, { type, name: fieldName, rect: rect(50, y, 100, 20) });
  expect(await add('text', 'Name', 700)).toBe('Name');
  expect(await add('text', 'Name', 670)).toBe('Name_2');
  expect(await add('checkbox', ' Name ', 640)).toBe('Name_3');
  expect(await add('text', 'Name.first', 610)).toBe('Name_4.first');
  expect(await add('text', 'person.first', 580)).toBe('person.first');
  expect(await add('text', 'person', 550)).toBe('person_2');
  // A group of radios is joined instead, but another type with its name is renamed.
  expect(await add('radio', 'Choice', 520)).toBe('Choice');
  expect(await add('radio', 'Choice', 490)).toBe('Choice');
  expect(await add('text', 'Choice', 460)).toBe('Choice_2');
  expect(await add('text', '', 430)).toBe('Text1');
  const reopened = await PDFDocument.load(await doc.save());
  expect(
    reopened
      .getForm()
      .getFields()
      .map((f) => f.getName()),
  ).toEqual([
    'Name',
    'Name_2',
    'Name_3',
    'Name_4.first',
    'person.first',
    'person_2',
    'Choice',
    'Choice_2',
    'Text1',
  ]);
});

it('renames fields between groups without leaving empty groups', async () => {
  const doc = await blank();
  await addFormField(doc, 0, {
    type: 'text',
    name: 'First name',
    rect: rect(50, 700, 100, 20),
    defaultValue: 'Ada',
  });
  await addFormField(doc, 0, { type: 'text', name: 'Other', rect: rect(50, 670, 100, 20) });
  expect(await updateFormField(doc, 'First name', { name: 'person.first' })).toBe('person.first');
  expect(await updateFormField(doc, 'person.first', { name: 'Other' })).toBe('Other_2');
  const fields = doc.catalog.lookup(name('AcroForm')).lookup(name('Fields'));
  // The emptied "person" group is gone; both fields sit at the top level.
  expect(fields.size()).toBe(2);
  expect(await updateFormField(doc, 'Other_2', { name: 'Given name' })).toBe('Given name');
  const bytes = await doc.save();
  expect((await annotations(bytes)).map((a) => [a.fieldName, a.fieldValue])).toEqual([
    ['Given name', 'Ada'],
    ['Other', ''],
  ]);
});

it('updates properties and redraws the fields', async () => {
  const doc = await blank();
  await addFormField(doc, 0, {
    type: 'text',
    name: 'Code',
    rect: rect(50, 700, 120, 22),
    defaultValue: 'AB',
  });
  await addFormField(doc, 0, {
    type: 'checkbox',
    name: 'Box',
    rect: rect(50, 660, 14, 14),
    checked: true,
  });
  await addFormField(doc, 0, {
    type: 'dropdown',
    name: 'Pick',
    rect: rect(50, 620, 120, 22),
    options: ['b', 'a'],
    defaultValue: 'b',
  });
  await updateFormField(doc, 'Code', {
    maxLength: 5,
    comb: true,
    alignment: 'center',
    tooltip: 'Postal code',
    borderColor: '#ff0000',
    backgroundColor: '#eeeeff',
    textColor: '#0000ff',
    fontSize: 'auto',
    font: 'Courier',
    required: true,
    format: 'number',
    decimals: 0,
  });
  await updateFormField(doc, 'Box', { exportValue: 'Accepted', style: 'star' });
  await updateFormField(doc, 'Pick', { options: ['c', 'b', 'a'], sorted: true });
  const bytes = await doc.save();
  const listed = listFormFields(await PDFDocument.load(bytes));
  expect(listed[0].props).toMatchObject({
    maxLength: 5,
    comb: true,
    alignment: 'center',
    tooltip: 'Postal code',
    borderColor: '#ff0000',
    backgroundColor: '#eeeeff',
    textColor: '#0000ff',
    fontSize: 0,
    font: 'Courier',
    required: true,
    format: 'number',
    decimals: 0,
    value: 'AB',
  });
  expect(listed[1].props).toMatchObject({ exportValue: 'Accepted', checked: true, style: 'star' });
  expect(listed[2].props.options.map((o) => o.value)).toEqual(['a', 'b', 'c']);
  expect(listed[2].props.value).toEqual(['b']);
  const [code, box] = await annotations(bytes);
  expect(code).toMatchObject({ comb: true, maxLen: 5, required: true, textAlignment: 1 });
  expect(code.defaultAppearanceData.fontName).toBe('Cour');
  expect(box).toMatchObject({ exportValue: 'Accepted', fieldValue: 'Accepted' });
  const { ink } = await rendered(bytes);
  expect(ink(rect(50, 660, 14, 14), 2).count).toBeGreaterThan(20);
  await expect(updateFormField(doc, 'Code', { comb: true, maxLength: null })).rejects.toThrow(
    /character limit/,
  );
  await expect(updateFormField(doc, 'Missing', { required: true })).rejects.toThrow(
    /no form field/,
  );
});

it('refuses a character limit shorter than the value the field holds', async () => {
  await mockTextFont();
  const doc = await blank();
  await addFormField(doc, 0, { type: 'text', name: 'Code', rect: rect(50, 700, 120, 22) });
  await fillFields(doc, { Code: 'ABCDEFG' });
  for (const props of [{ maxLength: 3 }, { maxLength: 3, comb: true }])
    await expect(updateFormField(doc, 'Code', props)).rejects.toThrow(
      'The field holds 7 characters. Choose a limit of at least 7, or shorten its value first.',
    );
  await updateFormField(doc, 'Code', { maxLength: 7, comb: true });
  // A new default value replaces the old one, so it is checked on its own.
  await updateFormField(doc, 'Code', { maxLength: 3, defaultValue: 'XYZ' });
  expect(listFormFields(doc)[0].props).toMatchObject({ maxLength: 3, value: 'XYZ' });
});

it('keeps a list’s default value and its filled value apart when its options change', async () => {
  await mockTextFont();
  const doc = await blank();
  for (const [field, y] of [
    ['Size', 700],
    ['Color', 650],
  ])
    await addFormField(doc, 0, {
      type: 'dropdown',
      name: field,
      rect: rect(50, y, 120, 22),
      options: ['A', 'B', 'C'],
      defaultValue: 'A',
    });
  await fillFields(doc, { Size: ['B'] });
  // Other tools can leave a list its default alone, which viewers show as its value.
  doc.getForm().getDropdown('Color').acroField.dict.delete(name('V'));
  for (const field of ['Size', 'Color'])
    await updateFormField(doc, field, { options: ['A', 'B', 'C', 'D'] });
  const [size, color] = listFormFields(await PDFDocument.load(await doc.save()));
  expect(size.props).toMatchObject({ value: ['B'], defaultValue: ['A'] });
  expect(color.props).toMatchObject({ value: ['A'], defaultValue: ['A'] });
});

it('moves widgets and deletes one widget or the whole field', async () => {
  const doc = await blank();
  for (const [i, value] of ['A', 'B', 'C'].entries())
    await addFormField(doc, 0, {
      type: 'radio',
      name: 'Grade',
      rect: rect(50 + 30 * i, 700, 14, 14),
      exportValue: value,
      checked: value === 'B',
    });
  await addFormField(doc, 0, { type: 'text', name: 'Group.Inner', rect: rect(50, 600, 100, 20) });
  await moveFormWidget(doc, 'Grade', 2, rect(200, 650, 20, 20));
  expect(listFormFields(doc)[2].rect).toEqual(rect(200, 650, 20, 20));
  const moved = doc.getForm().getRadioGroup('Grade').acroField.getWidgets()[2];
  const stream = moved.getAppearances().normal.lookup(name('C'));
  expect(stream.dict.lookup(name('BBox')).toString()).toBe('[ 0 0 20 20 ]');

  // Deleting the selected button clears the group's value.
  deleteFormField(doc, 'Grade', 1);
  expect(listFields(doc).find((f) => f.name === 'Grade')).toMatchObject({
    options: ['A', 'C'],
    value: undefined,
  });
  const page = doc.getPage(0);
  const widgets = () =>
    page.node
      .lookup(name('Annots'))
      .asArray()
      .map((ref) => doc.context.lookup(ref));
  expect(widgets()).toHaveLength(3);
  deleteFormField(doc, 'Grade');
  deleteFormField(doc, 'Group.Inner');
  expect(widgets()).toHaveLength(0);
  expect(doc.catalog.lookup(name('AcroForm')).lookup(name('Fields')).size()).toBe(0);
  const reopened = await PDFDocument.load(await doc.save());
  expect(reopened.getForm().getFields()).toHaveLength(0);
});

it('removes a deleted widget from the logical structure', async () => {
  const doc = await blank();
  await addFormField(doc, 0, { type: 'text', name: 'Tagged', rect: rect(50, 700, 100, 20) });
  const widgetRef = doc.getPage(0).node.lookup(name('Annots')).get(0);
  doc.context.lookup(widgetRef).set(name('StructParent'), doc.context.obj(0));
  const objr = doc.context.obj({ Type: 'OBJR', Obj: widgetRef });
  const element = doc.context.register(
    doc.context.obj({ Type: 'StructElem', S: 'Form', K: [objr] }),
  );
  const paragraph = doc.context.register(doc.context.obj({ Type: 'StructElem', S: 'P', K: [0] }));
  const root = doc.context.obj({
    Type: 'StructTreeRoot',
    K: [element, paragraph],
    ParentTree: { Nums: [0, element] },
  });
  doc.catalog.set(name('StructTreeRoot'), doc.context.register(root));
  deleteFormField(doc, 'Tagged');
  expect(root.lookup(name('K')).asArray()).toEqual([paragraph]);
  expect(root.lookup(name('ParentTree')).lookup(name('Nums')).size()).toBe(0);
});

it('turns fields upright on rotated pages', async () => {
  const doc = await blank(90);
  // In unrotated user space the field is tall; on screen it reads as a wide box.
  await addFormField(doc, 0, {
    type: 'text',
    name: 'Turned',
    rect: rect(300, 100, 30, 300),
    defaultValue: 'MMMMMMMMMMMM',
    borderColor: null,
  });
  await addFormField(doc, 0, {
    type: 'checkbox',
    name: 'Turned box',
    rect: rect(300, 500, 20, 20),
    checked: true,
  });
  const [text, box] = listFormFields(doc);
  expect(text.props.rotation).toBe(90);
  expect(box.props.rotation).toBe(90);
  const bytes = await doc.save();
  const [annotation] = await annotations(bytes);
  expect(annotation.rotation).toBe(90);
  const { ink } = await rendered(bytes);
  const { box: bounds } = ink(text.rect, 1);
  expect(bounds[2] - bounds[0]).toBeGreaterThan(3 * (bounds[3] - bounds[1]));
});

it('sets the tab order of a page', async () => {
  const doc = await blank();
  for (const [i, fieldName] of ['A', 'B', 'C'].entries())
    await addFormField(doc, 0, {
      type: 'text',
      name: fieldName,
      rect: rect(50, 700 - 30 * i, 100, 20),
    });
  setFieldTabOrder(doc, 0, 'row');
  expect(doc.getPage(0).node.lookup(name('Tabs'))).toBe(name('R'));
  expect(setFieldTabOrder(doc, 0, 'row')).toBe(false);
  setFieldTabOrder(doc, 0, ['C', 'A']);
  expect(doc.getPage(0).node.has(name('Tabs'))).toBe(false);
  const bytes = await doc.save();
  expect((await annotations(bytes)).map((a) => a.fieldName)).toEqual(['C', 'A', 'B']);
  expect(() => setFieldTabOrder(doc, 0, 'diagonal')).toThrow();
});

it('puts the widgets in row or column order, which viewers without /Tabs follow', async () => {
  const doc = await blank();
  // Added out of order: a two-by-two grid, bottom right first.
  for (const [fieldName, x, y] of [
    ['D', 300, 600],
    ['B', 300, 700],
    ['C', 50, 602],
    ['A', 50, 698],
  ])
    await addFormField(doc, 0, { type: 'text', name: fieldName, rect: rect(x, y, 100, 20) });
  const order = async () => (await annotations(await doc.save())).map((a) => a.fieldName);
  setFieldTabOrder(doc, 0, 'row');
  expect(await order()).toEqual(['A', 'B', 'C', 'D']);
  expect(setFieldTabOrder(doc, 0, 'row')).toBe(false);
  setFieldTabOrder(doc, 0, 'column');
  expect(doc.getPage(0).node.lookup(name('Tabs'))).toBe(name('C'));
  expect(await order()).toEqual(['A', 'C', 'B', 'D']);
  // Rows run across the page as it is shown: turned a quarter, the left edge is the top.
  doc.getPage(0).setRotation(degrees(90));
  setFieldTabOrder(doc, 0, 'row');
  expect(await order()).toEqual(['C', 'A', 'D', 'B']);
});

/** A printed form: underscore blanks, ruled lines, boxes, check squares and a table. */
async function flatForm() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = (value, x, y, size = 11) => page.drawText(value, { x, y, size, font });
  text('Application form', 50, 740, 18);
  page.drawLine({ start: { x: 50, y: 730 }, end: { x: 560, y: 730 }, thickness: 1 });
  text('First name: ____________________', 50, 690);
  text('Last name', 320, 690);
  page.drawLine({ start: { x: 380, y: 688 }, end: { x: 560, y: 688 }, thickness: 0.75 });
  text('Address', 50, 646);
  page.drawRectangle({
    x: 110,
    y: 640,
    width: 300,
    height: 22,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  page.drawRectangle({
    x: 50,
    y: 600,
    width: 10,
    height: 10,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  text('Subscribe to news', 66, 601);
  page.drawRectangle({
    x: 250,
    y: 600,
    width: 10,
    height: 10,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  text('Member', 266, 601);
  // A ruled table: a heading row, then labeled rows with an empty value column.
  const ys = [560, 540, 520, 500];
  for (const y of ys) page.drawLine({ start: { x: 50, y }, end: { x: 350, y }, thickness: 1 });
  for (const x of [50, 200, 350])
    page.drawLine({ start: { x, y: 500 }, end: { x, y: 560 }, thickness: 1 });
  text('Item', 55, 546);
  text('Quantity', 205, 546);
  text('Apples', 55, 526);
  text('Pears', 55, 506);
  page.drawLine({ start: { x: 50, y: 300 }, end: { x: 250, y: 300 }, thickness: 1 });
  text('Signature', 50, 288, 9);
  return doc;
}

it('detects the fields of a flat form, with or without PDF.js text', async () => {
  const doc = await flatForm();
  const bytes = await doc.save();
  const textContent = await withPdfjs(bytes, (page) => page.getTextContent());
  for (const options of [{}, { textContent }]) {
    const found = detectFormFields(await PDFDocument.load(bytes), 0, options);
    const summary = found.map((f) => [f.type, f.name]);
    expect(summary).toEqual([
      ['text', 'First name'],
      ['text', 'Last name'],
      ['text', 'Address'],
      ['checkbox', 'Subscribe to news'],
      ['checkbox', 'Member'],
      ['text', 'Apples'],
      ['text', 'Pears'],
      ['text', 'Signature'],
    ]);
    const byName = Object.fromEntries(found.map((f) => [f.name, f]));
    // The blank sits over the underscores, after the label.
    expect(byName['First name'].rect.x).toBeGreaterThan(100);
    expect(byName['First name'].rect.y).toBeLessThan(690);
    expect(byName['Last name'].rect).toMatchObject({ x: 380, width: 180 });
    expect(byName.Address.rect).toMatchObject({ x: 111, y: 641, width: 298, height: 20 });
    expect(byName.Member.rect).toMatchObject({ x: 250, y: 600, width: 10, height: 10 });
    expect(byName.Apples.rect).toMatchObject({ x: 201, y: 521, width: 148, height: 18 });
    expect(byName.Signature.rect).toMatchObject({ x: 50, width: 200 });
    for (const f of found) expect(f.confidence).toBeGreaterThan(0.3);
  }
  // Accepting the candidates creates fields; detection then finds nothing new.
  const target = await PDFDocument.load(bytes);
  for (const candidate of detectFormFields(target, 0))
    await addFormField(target, 0, {
      type: candidate.type,
      name: candidate.name,
      rect: candidate.rect,
    });
  expect(listFields(target).map((f) => f.name)).toContain('Subscribe to news');
  expect(detectFormFields(target, 0)).toEqual([]);
});

it('takes dark banners for decoration, not for fields, and shaded boxes for fields', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 50, y: 680, width: 512, height: 40, color: rgb(0.1, 0.2, 0.5) });
  page.drawText('Comments', { x: 50, y: 606, size: 11, font });
  page.drawRectangle({ x: 120, y: 600, width: 300, height: 22, color: rgb(0.92, 0.92, 0.95) });
  expect(detectFormFields(doc, 0).map(({ type, name }) => [type, name])).toEqual([
    ['text', 'Comments'],
  ]);
});

it('fills created fields with the existing fill tool', async () => {
  await mockTextFont();
  const doc = await blank();
  await everyField(doc);
  await fillFields(doc, {
    'First name': 'Grace',
    Agree: false,
    Color: 'Red',
    Size: 'Medium',
    Toppings: ['Cheese'],
    Date1: '10/09/2026',
  });
  const bytes = await doc.save();
  const values = Object.fromEntries(
    listFields(await PDFDocument.load(bytes)).map((f) => [f.name, f.value]),
  );
  expect(values).toMatchObject({
    'First name': 'Grace',
    Agree: false,
    Color: 'Red',
    Size: ['Medium'],
    Toppings: ['Cheese'],
    Date1: '10/09/2026',
  });
  const byName = Object.fromEntries((await annotations(bytes)).map((a) => [a.fieldName, a]));
  expect(byName['First name'].fieldValue).toBe('Grace');
  expect(byName.Agree.fieldValue).toBe('Off');
  expect(byName.Size.fieldValue).toEqual(['Medium']);
});

it('flattens created fields into page content', async () => {
  const doc = await blank();
  await everyField(doc);
  const counts = flattenDocument(doc);
  expect(counts.fields).toBe(11);
  expect(counts.unflattened).toBeUndefined();
  const bytes = await doc.save();
  expect(await annotations(bytes)).toEqual([]);
  const { ink } = await rendered(bytes);
  expect(ink(rect(50, 700, 200, 22), 2).count).toBeGreaterThan(50);
  expect(ink(rect(50, 660, 14, 14), 2).count).toBeGreaterThan(20);
});

it('runs as editor operations and draws text a standard font cannot', async () => {
  await mockTextFont();
  const session = new PdfSession(await (await blank()).save());
  let created;
  await session.change(async (doc) => {
    created = await addFormField(doc, 0, {
      type: 'text',
      name: 'Город',
      rect: rect(50, 700, 200, 22),
      defaultValue: 'Привет',
    });
  });
  expect(created).toBe('Город');
  await session.change((doc) => updateFormField(doc, 'Город', { required: true }));
  await session.change((doc) => setFieldTabOrder(doc, 0, 'column'));
  const doc = await PDFDocument.load(session.bytes);
  const [field] = listFormFields(doc);
  expect(field).toMatchObject({ name: 'Город', props: { value: 'Привет', required: true } });
  const fonts = doc.catalog.lookup(name('AcroForm')).lookup(name('DR')).lookup(name('Font'));
  expect(fonts.keys().length).toBeGreaterThan(1);
  const { ink } = await rendered(session.bytes);
  expect(ink(rect(50, 700, 200, 22), 2).count).toBeGreaterThan(50);
  await session.change((d) => deleteFormField(d, 'Город'));
  expect((await PDFDocument.load(session.bytes)).getForm().getFields()).toHaveLength(0);
});

it('keeps the font of a field made by another tool when it is moved or changed', async () => {
  await mockTextFont();
  const source = await blank();
  const form = source.getForm();
  const arial = source.context.register(
    source.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Arial' }),
  );
  form.acroForm.dict.set(name('DR'), source.context.obj({ Font: { Arial: arial } }));
  const field = form.createTextField('Name');
  field.setText('Hello');
  field.addToPage(source.getPage(0), { x: 50, y: 600, width: 200, height: 24 });
  field.acroField.setDefaultAppearance('/Arial 11 Tf 0 0 1 rg');
  const doc = await PDFDocument.load(await source.save({ updateFieldAppearances: false }));
  await updateFormField(doc, 'Name', { tooltip: 'Your name' });
  await moveFormWidget(doc, 'Name', 0, rect(60, 600, 200, 24));
  const saved = await PDFDocument.load(await doc.save());
  expect(saved.getForm().getTextField('Name').acroField.getDefaultAppearance()).toBe(
    '/Arial 11 Tf 0 0 1 rg',
  );
  // The drawing stands in for the font, which the PDF does not carry.
  const { ink } = await rendered(await doc.save());
  expect(ink(rect(60, 600, 200, 24), 2).count).toBeGreaterThan(50);
});

it('lists fields made by other tools', async () => {
  const doc = await blank();
  const form = doc.getForm();
  const page = doc.getPage(0);
  const text = form.createTextField('legacy.text');
  text.setText('old');
  text.addToPage(page, { x: 50, y: 700, width: 100, height: 20, borderColor: rgb(0, 0, 1) });
  form.createCheckBox('legacy.box').addToPage(page, { x: 50, y: 660, width: 12, height: 12 });
  const listed = listFormFields(doc);
  expect(listed.map((f) => [f.name, f.type, f.page])).toEqual([
    ['legacy.text', 'text', 0],
    ['legacy.box', 'checkbox', 0],
  ]);
  expect(listed[0].props).toMatchObject({ value: 'old', borderColor: '#0000ff' });
  await updateFormField(doc, 'legacy.box', { checked: true, style: 'square' });
  const bytes = await doc.save();
  expect((await PDFDocument.load(bytes)).getForm().getCheckBox('legacy.box').isChecked()).toBe(
    true,
  );
  expect(doc.getForm().acroForm.dict.lookup(name('DR')) instanceof PDFDict).toBe(true);
  expect(page.node.lookup(name('Annots')) instanceof PDFArray).toBe(true);
});
