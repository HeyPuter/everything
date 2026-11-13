import { PDFDocument, PDFName, PDFBool, PDFString } from 'pdf-lib';
import { addNote } from '../../src/core/notes.js';

export async function partialFlattenPdf(kind = 'text', stale = false) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  const field =
    kind === 'dropdown'
      ? form.createDropdown('Keep value')
      : kind === 'list'
        ? form.createOptionList('Keep value')
        : form.createTextField('Keep value');
  if (kind === 'dropdown' || kind === 'list') {
    field.setOptions(['Old']);
    field.select('Old');
  } else field.setText('Old');
  field.addToPage(page, { x: 30, y: 300, width: 280, height: 30 });
  if (kind === 'widget-layout' || kind === 'rectangle')
    field.addToPage(page, { x: 30, y: 240, width: 280, height: 30 });
  const safe = form.createTextField('Flatten me');
  safe.setText('Visible value');
  safe.addToPage(page, { x: 30, y: 160, width: 280, height: 30 });
  form.updateFieldAppearances();
  addNote(doc, 0, { x: 320, y: 100, text: 'Flatten this note' });
  if (kind === 'widgets') field.acroField.Kids().push(PDFString.of('invalid'));
  else if (kind === 'widget-layout' || kind === 'rectangle') {
    field.setText('Updated retained');
    const second = field.acroField.getWidgets()[1];
    if (kind === 'widget-layout') second.dict.set(PDFName.of('Rect'), PDFString.of('invalid'));
    else second.dict.set(PDFName.of('Rect'), doc.context.obj([30, 240, 30, 270]));
    form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  } else {
    if (kind === 'dropdown' || kind === 'list') {
      field.setOptions(['🦄', 'Old']);
      field.select('🦄');
    } else field.setText('🦄');
    if (stale) form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    else field.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
  }
  return doc.save({ updateFieldAppearances: false });
}
