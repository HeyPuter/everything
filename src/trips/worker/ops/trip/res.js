// Reservation shape rules the shared schema cannot express: legs belong to transports, `stay` to lodging,
// and `stayId` points at another reservation. Referential checks would need extra reads; readers tolerate
// links to missing entities instead.
import { DomainError } from '../../../src/shared/errors.js';

const TRANSPORT = new Set(['flight', 'train', 'bus', 'car', 'taxi', 'bike', 'cruise', 'ferry', 'transit', 'transport']);
const reject = (path, rule) => { throw new DomainError('invalid_reservation', 400, [{ path, rule }]); };

export default Object.freeze({
  check({ after }) {
    if (!after) return;
    if (after.legs && !TRANSPORT.has(after.type)) reject(['legs'], 'transport_only');
    if (after.stay && after.type !== 'lodging') reject(['stay'], 'lodging_only');
    if (after.stay?.toDayId && !after.stay.fromDayId) reject(['stay', 'toDayId'], 'needs_from_day');
    if (after.stayId && (after.stayId === after.id || after.type === 'lodging')) reject(['stayId'], 'invalid_link');
  },
});
