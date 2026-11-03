// Place rules beyond the shared schema. Only the fields an op touches are checked, so older data stays editable.
import { DomainError } from '../../../src/shared/errors.js';

const reject = (code) => { throw new DomainError(code, 400); };

export function touchedFields(op) {
  if (op.put) return new Set(Object.keys(op.put));
  return new Set([...Object.keys(op.set ?? {}), ...(op.unset ?? [])].map((path) => path.split('.')[0]));
}

export default Object.freeze({
  check({ op, after }) {
    if (!after) return;
    const touched = touchedFields(op);
    if (touched.has('price') && after.price && after.price.amount < 0) reject('invalid_price');
    if (touched.has('tags')) {
      for (const tags of Object.values(after.tags ?? {})) {
        const seen = new Set();
        for (const tag of tags) {
          const key = tag.trim().toLocaleLowerCase();
          if (seen.has(key)) reject('duplicate_tag');
          seen.add(key);
        }
      }
    }
  },
});
