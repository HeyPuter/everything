// Tool arguments are declared once with the shared schema DSL: the same descriptor validates what the model sends
// and becomes the JSON Schema the model is shown.
import { s, validate, plainObject } from '../../../shared/schema/dsl.js';
import { isId } from '../../../shared/ids.js';
import { isDate, isTime } from '../../../shared/dates.js';

const JSON_TYPES = {
  id: { type: 'string', pattern: '^[0-9a-hjkmnp-tv-z]{16}$' },
  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  time: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
  dayRef: { type: 'string' },
};

/** Adds a description shown to the model; validation ignores it. */
export const describe = (descriptor, description) => Object.freeze({ ...descriptor, description });
export const a = Object.freeze({
  ...s,
  id: (text) => describe(s.custom(isId, 'id'), text),
  date: (text) => describe(s.custom(isDate, 'date'), text),
  time: (text) => describe(s.custom(isTime, 'time'), text),
  dayRef: (text = 'A day: its id, or its date as YYYY-MM-DD on a dated trip.') => describe(s.custom((value) => isId(value) || isDate(value), 'dayRef'), text),
  text: (max, text, options = {}) => describe(s.string(max, { nonempty: true, ...options }), text),
});

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** JSON Schema for a DSL descriptor (the subset tools use). */
export function jsonSchema(descriptor) {
  const extra = descriptor.description ? { description: descriptor.description } : {};
  switch (descriptor.kind) {
    case 'string': return { type: 'string', maxLength: descriptor.max, ...(descriptor.nonempty ? { minLength: 1 } : {}), ...extra };
    case 'number': return {
      type: descriptor.integer ? 'integer' : 'number',
      ...(descriptor.min > -MAX_SAFE ? { minimum: descriptor.min } : {}), ...(descriptor.max < MAX_SAFE ? { maximum: descriptor.max } : {}), ...extra,
    };
    case 'boolean': return { type: 'boolean', ...extra };
    case 'enum': return { type: 'string', enum: [...descriptor.values], ...extra };
    case 'literal': return { const: descriptor.value, ...extra };
    case 'array': return { type: 'array', items: jsonSchema(descriptor.item), maxItems: descriptor.max, ...(descriptor.min ? { minItems: descriptor.min } : {}), ...extra };
    case 'union': return { anyOf: descriptor.variants.map(jsonSchema), ...extra };
    case 'custom': return { ...(JSON_TYPES[descriptor.name] ?? { type: 'string' }), ...extra };
    case 'object': {
      const properties = Object.fromEntries(Object.entries(descriptor.fields).map(([key, field]) => [key, jsonSchema(field)]));
      const required = Object.entries(descriptor.fields).filter(([, field]) => !field.optional).map(([key]) => key);
      return { type: 'object', properties, required, additionalProperties: false, ...extra };
    }
    default: throw new TypeError(`Unsupported schema kind ${descriptor.kind}`);
  }
}

// Models often send null for an optional argument they mean to leave out.
function dropNulls(value, depth = 0) {
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => dropNulls(item, depth + 1));
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, dropNulls(item, depth + 1)]));
}

/** `{ok: true, value}` or `{ok: false, issues: ['items.0.name: string', …]}` for the model to correct. */
export function checkArgs(descriptor, input) {
  const value = dropNulls(input ?? {});
  try {
    validate(descriptor, value);
    return { ok: true, value };
  } catch (error) {
    const issues = (error.issues ?? []).slice(0, 12).map((issue) => `${issue.path.replace(/^\$\.?/, '') || 'arguments'}: ${issue.rule}`);
    return { ok: false, issues: issues.length ? issues : ['arguments: invalid'] };
  }
}
