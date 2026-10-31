import { invariant } from '../../../../src/shared/errors.js';
import { isId } from '../../../../src/shared/ids.js';
import { isOrder } from '../../../../src/shared/order.js';

/** `{visit, day, order}`: moves a visit to a live day. Moving it onto its own end day makes it a one-day visit. */
export default Object.freeze({
  kinds: ['trip'],
  validate(args) {
    invariant(Object.keys(args).every((key) => ['visit', 'day', 'order'].includes(key)), 'invalid_args');
    invariant(isId(args.visit) && isId(args.day) && isOrder(args.order), 'invalid_args');
  },
  reads: (args) => [{ t: 'visit', id: args.visit }, { t: 'day', id: args.day }],
  plan({ args, can, get }) {
    invariant(can('plan.edit'), 'forbidden', 403);
    const visit = get('visit', args.visit);
    invariant(visit, 'gone', 409);
    invariant(get('day', args.day), 'gone', 409);
    return [{
      t: 'visit', id: args.visit, set: { dayId: args.day, order: args.order },
      ...(visit.endDayId === args.day ? { unset: ['endDayId'] } : {}),
    }];
  },
});
