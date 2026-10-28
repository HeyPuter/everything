import { readContextualFlag } from './docx-contextual-spacing.js';
import { UnsupportedDocumentError } from './errors.js';
export function readStrike(rPr) {
  const single = readContextualFlag(rPr, 'strike'), double = readContextualFlag(rPr, 'dstrike');
  if (single !== undefined && double !== undefined) {
    // Both off, or one form on with the other off, state one appearance. Both on would need a choice.
    if (single && double) throw new UnsupportedDocumentError('strike and dstrike both on in the same property set');
    return { strikethrough: single ? 'singleStrikeDoubleOff' : double ? 'doubleStrikeSingleOff' : 'bothStrikeOff' };
  }
  return single !== undefined ? { strikethrough: single ? 'single' : 'singleOff' } : double !== undefined ? { strikethrough: double ? 'double' : 'doubleOff' } : {};
}
