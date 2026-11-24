import { popGraphicsState } from 'pdf-lib';
import { pageSource, parseContent } from './text-edit.js';

/**
 * Close the graphics states a page's content leaves open, so what is drawn after it (a picture,
 * signature or stamp placed on the page) is drawn in the page's own coordinates. The content is
 * already drawn between a save and a restore of its own, but a state it saves and never restores
 * after changing the coordinates (as some PDF writers leave it) outlives that one restore, and a
 * placed signature came out shrunk, stretched or moved.
 */
export function closeOpenStates(page) {
  let depth = 0;
  try {
    for (const { op } of parseContent(pageSource(page), { inlineImages: true }))
      if (op === 'q') depth++;
      else if (op === 'Q' && depth) depth--;
  } catch {
    return;
  }
  if (depth) page.pushOperators(...Array.from({ length: depth }, () => popGraphicsState()));
}
