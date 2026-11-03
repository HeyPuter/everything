// Test-only domain op (not registered): renames a place and adds a guest in one change.
import { invariant } from '../../../src/shared/errors.js';
import { isId } from '../../../src/shared/ids.js';
import { plainObject } from '../../../src/shared/schema/dsl.js';

export default Object.freeze({
  kinds: ['trip'],
  validate(args) {
    invariant(Object.keys(args).every((key) => ['placeId', 'name', 'newIds'].includes(key)), 'invalid_args');
    invariant(isId(args.placeId) && typeof args.name === 'string' && args.name.trim() && args.name.length <= 500, 'invalid_args');
    invariant(plainObject(args.newIds) && isId(args.newIds.guest), 'invalid_args');
  },
  reads: (args) => [{ t: 'place', id: args.placeId }, { t: 'guest', id: args.newIds.guest }],
  plan({ args, can, get }) {
    invariant(can('plan.edit'), 'forbidden', 403);
    invariant(get('place', args.placeId), 'gone', 409);
    return [
      { t: 'place', id: args.placeId, set: { name: args.name } },
      { t: 'guest', id: args.newIds.guest, put: { name: args.name } },
    ];
  },
});
