import { registerDomainAdapter } from '../store/space.js';

/** Local effect of `costs.settleAll`, matching the worker op: one settlement per transfer. */
export function settleAllEffects(args) {
  const ids = args?.newIds?.settle ?? [];
  return (args?.transfers ?? []).map((transfer, index) => ({ t: 'settle', id: ids[index], put: structuredClone(transfer) }));
}

registerDomainAdapter('costs.settleAll', settleAllEffects);

/** The op that records `transfers` (`{from, to, amount, currency, rate?, date?, note?}`) at once. */
export function settleAllOp(space, transfers) {
  return space.ops.domain('costs.settleAll', { transfers }, { settle: transfers.length });
}
