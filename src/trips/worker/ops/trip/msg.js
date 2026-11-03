// Chat rules beyond the shared authorizer: the visible author and single-emoji reaction keys.
import { invariant } from '../../../src/shared/errors.js';

const PART = '\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?';
const EMOJI = new RegExp(`^(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|${PART}(?:\\u200D${PART})*[\\u{E0020}-\\u{E007F}]*)$`, 'u');
export const isEmoji = (value) => typeof value === 'string' && value.length <= 32 && EMOJI.test(value);

/** `author` is the creator's own uuid on create (or absent) and never changes afterwards. */
export function checkAuthor({ before, after, uid }) {
  if (!after) return;
  if (!before) invariant(after.author === undefined || after.author === uid, 'invalid_author', 403);
  else invariant(after.author === before.author, 'invalid_author', 403);
}

export default Object.freeze({
  check(context) {
    checkAuthor(context);
    const { op, after } = context;
    if (!after) return;
    const added = op.put ? Object.keys(op.put.react ?? {})
      : Object.keys(op.set ?? {}).filter((path) => path.startsWith('react.')).map((path) => path.split('.')[1]);
    invariant(added.every(isEmoji), 'invalid_reaction');
    invariant(after.reply !== op.id, 'invalid_reply');
  },
});
