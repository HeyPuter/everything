// Expense type hook: re-checks payers (less than the amount only with a due date) and the split with the expense id,
// bounds paid-back shares, and requires the people an op adds to be members or guests of the trip.
import { DomainError, invariant } from '../../../src/shared/errors.js';
import { isId, isUuid } from '../../../src/shared/ids.js';
import { splitAmount, validatePayers } from '../../../src/shared/money.js';

const abs = (value) => (value < 0 ? -value : value);
const rethrow = (error, fallback) => new DomainError(error instanceof DomainError ? error.code : fallback, 400);
const MAX_PEOPLE = 150;

/** Every `who` in an expense or a patch value (payers, split parts and items). */
function people(value, out = new Set(), depth = 0) {
  if (depth > 6 || out.size > MAX_PEOPLE || value === null || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'who') { for (const who of [item].flat()) if (typeof who === 'string') out.add(who); }
    else people(item, out, depth + 1);
  }
  return out;
}
const personRef = (who) => (isUuid(who) ? { t: 'member', id: who } : isId(who) ? { t: 'guest', id: who } : null);

export default Object.freeze({
  /** Members and guests named by the op, so `check` can see them. */
  reads(op) {
    const found = people(op?.put);
    for (const [path, value] of Object.entries(op?.set && typeof op.set === 'object' ? op.set : {})) {
      if (path.split('.').at(-1) === 'who') { for (const who of [value].flat()) if (typeof who === 'string') found.add(who); }
      else people(value, found);
    }
    return [...found].map(personRef).filter(Boolean).slice(0, MAX_PEOPLE);
  },
  check({ before, after, get }) {
    if (!after) return;
    try { validatePayers(after.amount, after.payers, { partial: Boolean(after.due) }); } catch (error) { throw rethrow(error, 'invalid_payers'); }
    let shares;
    try { shares = splitAmount(after.amount, after.split, { expenseId: after.id }); } catch (error) { throw rethrow(error, 'invalid_split'); }
    invariant(after.split.mode === 'items' || after.split.items === undefined, 'invalid_split');
    after.split.parts.forEach((part, index) => {
      if (!part.paid) return;
      const share = shares[index].amount;
      // A share is paid back to the other payers, in the share's sign and at most in full.
      invariant(share !== 0 && (share < 0) === (part.paid < 0) && abs(part.paid) <= abs(share), 'invalid_paid');
      invariant(after.payers.some((payer) => payer.who !== part.who && payer.amount !== 0), 'invalid_paid');
    });
    // People already on the expense stay (a member who left keeps their history); new ones must be in the trip.
    const known = people(before);
    for (const who of people(after)) {
      if (known.has(who)) continue;
      const ref = personRef(who);
      invariant(ref && get(ref.t, ref.id), 'unknown_person');
    }
  },
});
