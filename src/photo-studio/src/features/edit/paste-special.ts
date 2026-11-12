// Edit → Paste Special (Paste Into, Paste Outside, Paste without Formatting)
// and Edit → Purge (Clipboard, All).
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { newPixelLayer } from '../../model/pixel-layer';
import { emptyGrid, gridFromImage, readMask, writeRect } from '../../model/tiles';
import { applySelection, canvasRect, selectionBounds, selectionGrid } from '../../model/selection';
import { pasteMask } from '../../model/housekeeping';
import type { RGBA8 } from '../../imaging/types';
import { insertAboveSelection } from '../layers/insert';
import { nextLayerName } from '../pixels';
import { internalClipboard, purgeClipboard } from '../core';

/** The clipboard image: the editor's own copy, else an image on the system clipboard. */
async function clipboardImage(): Promise<{ image: RGBA8; x: number; y: number } | undefined> {
  const own = internalClipboard();
  if (own) return own;
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const { decodeBrowserImage } = await import('../files/open');
      return { image: await decodeBrowserImage(await item.getType(type)), x: 0, y: 0 };
    }
  } catch {
    /* Reading the system clipboard needs permission. */
  }
}

/** Paste into a new layer masked by the selection (or its inverse). The mask
 * is unlinked, so the pasted pixels can be repositioned behind it. */
async function pasteMasked(e: Editor, outside: boolean) {
  const doc = e.doc;
  const store = e.assets.tiles;
  const sel = selectionGrid(doc, store);
  const b = sel ? selectionBounds(doc, sel) : null;
  if (!sel || !b) {
    e.message('Make a selection to paste into.');
    return;
  }
  const item = await clipboardImage();
  if (!item) {
    e.message('Nothing to paste.');
    return;
  }
  const { image } = item;
  // Paste Into centers on the selection; Paste Outside centers on the canvas.
  const box = outside ? canvasRect(doc) : b;
  const x = Math.round(box.x + (box.width - image.width) / 2),
    y = Math.round(box.y + (box.height - image.height) / 2);
  const l = newPixelLayer(nextLayerName(doc), doc, gridFromImage(store, image, x, y));
  const area = canvasRect(doc);
  const mask = pasteMask(readMask(store, sel, area), outside);
  // Beyond the canvas the mask hides (Into) or reveals (Outside).
  l.maskGrid = writeRect(store, { ...emptyGrid(1), fill: outside ? 255 : 0 }, 0, 0, mask);
  l.maskUnlinked = true;
  insertAboveSelection(e, l, outside ? 'Paste Outside' : 'Paste Into', (d) => applySelection(d, null));
  e.message(outside ? 'Pasted outside the selection' : 'Pasted into the selection');
}

/** Paste clipboard text without its styling: into the text being edited, or
 * as a new point text layer at the center of the canvas. */
async function pastePlain(e: Editor) {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    e.message('Allow clipboard access to paste text.');
    return;
  }
  if (!text) {
    e.message('There is no text on the clipboard.');
    return;
  }
  const type = await import('../type/session');
  if (!type.sessionLayer()) {
    if (!e.hasDocument) {
      e.message('Open or create a document first.');
      return;
    }
    // A text session lives with the type tools.
    if (!e.tool.startsWith('type')) e.setTool('type');
    await type.startNew(e, { x: e.doc.width / 2, y: e.doc.height / 2, vertical: e.tool.includes('vertical'), mask: false });
  }
  if (!type.sessionLayer()) return;
  type.insert(e, text, 'paste');
  type.focusInput(e);
}

export function installPasteSpecial(_e: Editor) {
  const hasSelection = (e: Editor) => e.hasDocument && !!e.doc.selection;
  registerCommand(
    { id: 'edit.paste-into', label: 'Paste Into', shortcut: 'Mod+Alt+Shift+V', description: 'Paste into a new layer masked by the selection', enabled: hasSelection, run: (e) => pasteMasked(e, false) },
    { id: 'edit.paste-outside', label: 'Paste Outside', description: 'Paste into a new layer masked outside the selection', enabled: hasSelection, run: (e) => pasteMasked(e, true) },
    { id: 'edit.paste-plain', label: 'Paste without Formatting', description: 'Paste clipboard text as plain text', run: (e) => pastePlain(e), recordable: false },
    {
      id: 'edit.purge-clipboard',
      label: 'Clipboard',
      description: 'Free the memory held by copied pixels',
      enabled: () => !!internalClipboard(),
      run: (e) => {
        purgeClipboard();
        e.message('Clipboard purged.');
      },
      recordable: false,
    },
    {
      id: 'edit.purge-all',
      label: 'All',
      description: 'Purge the clipboard and the undo history of every open document',
      run: (e) => {
        purgeClipboard();
        for (const s of e.sessions) {
          s.history.reset(s.doc);
          s.lastSelection = undefined;
          s.collectTiles();
        }
        e.update();
        e.message('Clipboard and histories purged.');
      },
      recordable: false,
    },
  );
}
