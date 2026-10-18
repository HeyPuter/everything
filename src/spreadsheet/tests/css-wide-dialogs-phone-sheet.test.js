import { expect, it } from 'vitest';
import { stylesheet, rulesFor, declarations } from './helpers/css.js';

// On a phone every dialog is a bottom sheet the width of the screen. The large dialogs (Options, Print, All
// Scripts, Script Reference, Text to Columns, Paste Special, SmartArt, Equation) capped themselves at the
// window less 32px whatever its size, so on a phone they rose as a narrower sheet with a strip of the sheet
// showing either side, and their content had 32px less to fit in. Their desktop width now applies from the
// width dialogs stop being bottom sheets.
const WIDE = [
  ['automate.css', '.modal-panel.sg-modal'],
  ['automate.css', '.modal-panel.sr-modal'],
  ['components.css', '.modal-panel.ttc-dialog'],
  ['components.css', '.modal-panel.print-dialog'],
  ['equation.css', '.modal-panel.wide.equation-modal'],
  ['options.css', '.modal-panel.options-modal'],
  ['paste-fill.css', '.paste-special-panel'],
  ['smartart.css', '.modal-panel.wide.sa-gallery-modal'],
];

it('leaves the large dialogs the full width of a phone, and sizes them only on a wider screen', () => {
  for (const [file, selector] of WIDE) {
    const css = stylesheet(file);
    for (const rule of rulesFor(css, selector, false)) {
      const decls = declarations(rule.body);
      expect(decls['width'], `${selector} width`).toBeUndefined();
      expect(decls['max-width'], `${selector} max-width`).toBeUndefined();
    }
    const wide = rulesFor(css, selector, 'min-width: 640px');
    expect(wide.length, selector).toBeGreaterThan(0);
    expect(wide.map((r) => r.body).join(';'), selector).toMatch(/calc\(100vw - 32px\)/);
  }
});
