import { expect, it } from 'vitest';
import {
  PDFName,
  PDFString,
  defaultTextFieldAppearanceProvider,
  defaultDropdownAppearanceProvider,
  defaultCheckBoxAppearanceProvider,
  defaultRadioGroupAppearanceProvider,
  defaultButtonAppearanceProvider,
} from 'pdf-lib';
import * as safe from '../src/core/appearance-providers.js';
import { readAppearanceDefaults } from '../src/core/form-style.js';
import { parseContent } from '../src/core/text-edit.js';
import { malformedAppearancePdf } from './fixtures/malformed-appearance.js';

const providers = {
  text: ['defaultTextFieldAppearanceProvider', defaultTextFieldAppearanceProvider],
  multiline: ['defaultTextFieldAppearanceProvider', defaultTextFieldAppearanceProvider],
  comb: ['defaultTextFieldAppearanceProvider', defaultTextFieldAppearanceProvider],
  dropdown: ['defaultDropdownAppearanceProvider', defaultDropdownAppearanceProvider],
  checkbox: ['defaultCheckBoxAppearanceProvider', defaultCheckBoxAppearanceProvider],
  radio: ['defaultRadioGroupAppearanceProvider', defaultRadioGroupAppearanceProvider],
  button: ['defaultButtonAppearanceProvider', defaultButtonAppearanceProvider],
};
const drawing = (value) =>
  Array.isArray(value)
    ? value.map((operator) => operator.toString())
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, drawing(entry)]));
for (const kind of Object.keys(providers))
  for (const rotation of [0, 90, 180, 270])
    for (const [location, appearance] of [
      ['field', '0.2 g /Helvetica 0 Tf'],
      ['widget', '0.7 .1 .2 rg /Helvetica 12 Tf'],
      ['field', '0.1 0.4 0.2 0.1 k /Helvetica 8 Tf'],
      ['widget', '0 g /Helvetica 10 Tf 0 0 1 rg /Helvetica 14 Tf'],
    ])
      // An automatic size draws multi-line text at 12 pt at most, where pdf-lib grows it
      // (multiline-wrap-appearance.test.js).
      (kind === 'multiline' && / 0 Tf/.test(appearance) ? it.skip : it)(
        `keeps upstream drawing for ${kind} (${rotation}, ${location}, ${appearance})`,
        async () => {
          const { doc, field } = await malformedAppearancePdf({
            kind,
            rotation,
            location,
            appearance,
          });
          const widget = field.acroField.getWidgets()[0],
            font = doc.getForm().getDefaultFont();
          if (kind === 'button')
            widget
              .getAppearanceCharacteristics()
              .setCaptions({ normal: 'Submit', down: 'Sending' });
          const saved = [field.acroField.dict, widget.dict].map((dict) => [
            dict,
            dict.get(PDFName.of('DA')),
          ]);
          const [name, original] = providers[kind];
          const expected = drawing(original(field, widget, font));
          for (const [dict, value] of saved)
            value === undefined ? dict.delete(PDFName.of('DA')) : dict.set(PDFName.of('DA'), value);
          expect(drawing(safe[name](field, widget, font))).toEqual(expected);
        },
      );

it('ignores operators inside comments and strings and refreshes changed defaults', async () => {
  const { field } = await malformedAppearancePdf({
    appearance: '/Helvetica 12 Tf 0 0 1 rg % /Wrong 99 Tf 1 0 0 rg\n(0 g /Wrong 48 Tf) Tj',
  });
  expect(readAppearanceDefaults(field.acroField)).toMatchObject({
    fontSize: 12,
    color: { type: 'RGB', red: 0, green: 0, blue: 1 },
  });
  field.acroField.dict.set(PDFName.of('DA'), PDFString.of('/Helvetica 9 Tf 0.3 g'));
  expect(readAppearanceDefaults(field.acroField)).toMatchObject({
    fontSize: 9,
    color: { type: 'Grayscale', gray: 0.3 },
  });
});

it.each(['0', '12', '12.', '12.5', '.5', '+12', '-12', '-.5', '+.5'])(
  'keeps PDF numeric token syntax for %s',
  (value) => {
    expect(parseContent(value + ' w')[0].args).toMatchObject([
      { type: 'number', value: Number(value) },
    ]);
  },
);
