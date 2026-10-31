// Photo-book rules beyond the shared schema: a known format (custom needs both sides), title length, font and color.
import { DomainError } from '../../../src/shared/errors.js';
import { touchedFields } from '../trip/place.js';
import { COLORS, FONTS } from './bookPage.js';

// Match src/lib/book/constants.js (tests/worker/book.test.js checks them).
export const FORMAT_IDS = Object.freeze(['sq21', 'sq30', 'a4l', 'a4p', 'a5l', 'custom']);
export const BOOK_TITLE_MAX = 200;
const reject = (code) => { throw new DomainError(code, 400); };

export default Object.freeze({
  check({ op, after }) {
    if (!after) return;
    const touched = touchedFields(op);
    if (['fmt', 'w', 'h'].some((field) => touched.has(field)) && after.fmt !== undefined) {
      if (!FORMAT_IDS.includes(after.fmt)) reject('invalid_format');
      if (after.fmt === 'custom' && !(after.w && after.h)) reject('invalid_format');
    }
    if (touched.has('title') && (after.title ?? '').trim().length > BOOK_TITLE_MAX) reject('title_too_long');
    if (touched.has('font') && after.font !== undefined && !FONTS.includes(after.font)) reject('invalid_font');
    if (touched.has('bg') && after.bg !== undefined && !COLORS.includes(after.bg)) reject('invalid_color');
  },
});
