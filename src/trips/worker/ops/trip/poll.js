import { invariant } from '../../../src/shared/errors.js';
import { checkAuthor } from './msg.js';

const optionKey = (option) => option.trim().toLocaleLowerCase();

export default Object.freeze({
  check(context) {
    checkAuthor(context);
    const { op, before, after } = context;
    if (!after) return;
    if (!before || Object.hasOwn(op.set ?? {}, 'options')) {
      invariant(new Set(after.options.map(optionKey)).size === after.options.length, 'duplicate_options');
    }
    // `cr` is the commit time on create.
    if (!before && after.deadline != null) invariant(after.deadline > after.cr, 'invalid_deadline');
  },
});
