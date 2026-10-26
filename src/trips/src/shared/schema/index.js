import { invariant } from '../errors.js';
import { s, validate } from './dsl.js';
import { tripSchemas } from './trip.js';
import { collectionSchemas } from './collection.js';
import { journeySchemas } from './journey.js';
import { vacaySchemas } from './vacay.js';
import { id, uid } from './fields.js';
import { isHlc } from '../hlc.js';
import { LIMITS } from '../limits.js';

export { s, validate, schemaAt } from './dsl.js';
export { vacaySchemas } from './vacay.js';
export const schemas = Object.freeze({ trip: tripSchemas, collection: collectionSchemas, journey: journeySchemas });
export const SERVER_FIELDS = Object.freeze(['id', 'v', 'rev', 'upd', 'by', 'cr']);
const stamps = {
  id, v: s.custom(isHlc, 'version'), rev: s.integer(0), upd: s.integer(0), by: uid, cr: s.integer(0),
};

export function entitySchema(kind, type) {
  invariant(Object.hasOwn(schemas, kind) && Object.hasOwn(schemas[kind], type), 'unknown_type');
  return schemas[kind][type];
}

const serverSchemas = new Map();
const encoder = new TextEncoder();
export function validateEntity(kind, type, value, { server = false } = {}) {
  const schema = entitySchema(kind, type);
  invariant(encoder.encode(JSON.stringify(value)).length <= LIMITS.kvBytes, 'entity_too_large', 413);
  if (!server) return validate(schema, value);
  let full = serverSchemas.get(`${kind}:${type}`);
  if (!full) {
    const idSchema = type === 'meta' ? s.literal('meta') : type === 'member' ? uid : id;
    serverSchemas.set(`${kind}:${type}`, full = s.object({ ...schema.fields, ...stamps, id: idSchema }, { refine: schema.refine }));
  }
  return validate(full, value);
}

const tombstone = s.object({ id: s.union(id, uid, s.literal('meta')), t: s.string(32), deleted: s.literal(true), rev: s.integer(0), v: s.custom(isHlc, 'version') });
export function validateTombstone(value) {
  return validate(tombstone, value);
}

export function validateVacay(type, value) {
  invariant(Object.hasOwn(vacaySchemas, type), 'unknown_type');
  return validate(vacaySchemas[type], value);
}
