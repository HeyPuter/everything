// `costs.settleAll`: records every suggested transfer as settlements in one change, so a partial
// "settle all" never lands. Ids come from the client in `newIds.settle`, one per transfer.
import { invariant } from '../../../src/shared/errors.js';
import { isId } from '../../../src/shared/ids.js';
import { plainObject } from '../../../src/shared/schema/dsl.js';
import { validateEntity } from '../../../src/shared/schema/index.js';

const MAX_TRANSFERS = 100;
const FIELDS = new Set(['from', 'to', 'amount', 'currency', 'rate', 'date', 'note']);

export default Object.freeze({
  kinds: ['trip'],
  validate(args) {
    invariant(Object.keys(args).every((key) => key === 'transfers' || key === 'newIds'), 'invalid_args');
    const { transfers, newIds } = args;
    invariant(Array.isArray(transfers) && transfers.length >= 1 && transfers.length <= MAX_TRANSFERS, 'invalid_args');
    invariant(plainObject(newIds) && Object.keys(newIds).length === 1 && Array.isArray(newIds.settle), 'invalid_args');
    invariant(newIds.settle.length === transfers.length && newIds.settle.every(isId) && new Set(newIds.settle).size === transfers.length, 'invalid_args');
    for (const transfer of transfers) {
      invariant(plainObject(transfer) && Object.keys(transfer).every((key) => FIELDS.has(key)), 'invalid_args');
      validateEntity('trip', 'settle', transfer);
    }
  },
  reads: (args) => args.newIds.settle.map((id) => ({ t: 'settle', id })),
  plan({ args, can }) {
    invariant(can('costs.edit'), 'forbidden', 403);
    return args.transfers.map((transfer, index) => ({ t: 'settle', id: args.newIds.settle[index], put: structuredClone(transfer) }));
  },
});
