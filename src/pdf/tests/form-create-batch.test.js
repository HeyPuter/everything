import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { addFormField, addFormFields, listFormFields } from '../src/core/form-create.js';

// Creating the fields Detect form fields found read the whole form again for each one, so a
// long form's 3,600 fields took over a minute with the page frozen. They are made in one go.
it('creates many fields at once as one by one, names and all', async () => {
  const entries = [];
  for (let page = 0; page < 3; page++)
    for (let row = 0; row < 6; row++)
      entries.push(
        {
          page,
          type: 'text',
          name: row % 2 ? 'Name' : undefined,
          rect: { x: 50, y: 700 - row * 40, width: 200, height: 20 },
        },
        { page, type: 'checkbox', rect: { x: 300, y: 700 - row * 40, width: 14, height: 14 } },
      );
  entries.push({
    page: 0,
    type: 'text',
    name: 'Name.First',
    rect: { x: 50, y: 100, width: 80, height: 20 },
  });
  const make = async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([612, 792]);
    doc
      .getForm()
      .createTextField('Text1')
      .addToPage(doc.getPage(0), { x: 400, y: 50, width: 80, height: 20 });
    return doc;
  };
  const single = await make();
  const names = [];
  for (const { page, ...options } of entries) names.push(await addFormField(single, page, options));
  const batch = await make();
  expect(await addFormFields(batch, entries)).toEqual(names);
  const summary = (doc) =>
    listFormFields(doc).map(({ name, type, page, rect }) => ({ name, type, page, rect }));
  expect(summary(batch)).toEqual(summary(single));
  expect(new Set(names).size).toBe(names.length);
});
