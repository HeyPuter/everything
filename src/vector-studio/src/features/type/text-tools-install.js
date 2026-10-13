/**
 * Type menu and Edit menu text services: spelling, smart punctuation, Find
 * Next, Paste Without Formatting, special characters, recent fonts, Find
 * Font, Resolve Missing Fonts and Select > Same text attributes.
 */
import './text-services.css';
import { createText } from '../../model/nodes.js';
import { installSpelling } from './spelling.js';
import { openSmartPunctuation } from './smart-punctuation.js';
import { installSpecialChars } from './special-chars.js';
import { installFontTools } from './font-tools.js';
import { installSelectText } from './select-text.js';
import { pastedText } from './session.js';
import { session, typeDefaults } from './type-ops.js';

/** Edit > Paste Without Formatting: clipboard text in the insertion-point style, or as new point type. */
export async function pastePlain(app) {
  const s = session(app);
  if (s) return s.clipboardPaste({ plain: true });
  const ed = app.editor;
  if (!ed) return;
  let t;
  try {
    t = pastedText(await navigator.clipboard.readText());
  } catch {
    app.notify('The browser blocked clipboard access.', { error: true });
    return;
  }
  t = String(t || '').replace(/\r\n?/g, '\n');
  if (!t) {
    app.notify('The clipboard has no text.');
    return;
  }
  pastePlainText(app, t);
}

/** Put text on the canvas as a new point type object at the center of the view. */
export function pastePlainText(app, text) {
  const ed = app.editor;
  if (!ed.canDrawInTarget()) {
    app.notify('The target layer is locked or hidden.');
    return null;
  }
  const r = ed.view.visibleRect(0);
  const d = typeDefaults(app);
  const node = createText(text, r.x + r.w / 2, r.y + r.h / 2, { char: { ...d.char }, para: { ...d.para, align: 'center' }, fill: d.fill, stroke: d.stroke, strokeWidth: d.strokeWidth });
  ed.doc.transact('Paste', () => ed.insertDrawn(node));
  ed.select([node.id]);
  return node.id;
}

export function installTextServices(app) {
  installSpelling(app);
  installSpecialChars(app);
  installFontTools(app);
  installSelectText(app);
  app.commands.register([
    { id: 'type.smartPunctuation', label: 'Smart Punctuation...', enabled: (a) => Boolean(a.editor), run: openSmartPunctuation },
    {
      id: 'edit.findNext',
      label: 'Find Next',
      enabled: (a) => Boolean(a.editor),
      run: async (a) => {
        const { findNext, lastFind, openFindReplace } = await import('./find.js');
        if (!lastFind.query) return openFindReplace(a);
        const r = findNext(a);
        if (r === 'none') a.notify(`No more matches for \u201c${lastFind.query}\u201d.`, { polite: true });
        return undefined;
      },
    },
    { id: 'edit.pastePlain', label: 'Paste Without Formatting', shortcut: 'Alt+Mod+V', enabled: (a) => Boolean(a.editor), run: pastePlain },
  ]);
}
