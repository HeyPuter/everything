import { DomainError } from '../errors.js';

export const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export const safeKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 256
  && !UNSAFE_KEYS.has(key) && !/[.\u0000-\u001f]/.test(key);
export const plainObject = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const descriptor = (kind, options = {}) => Object.freeze({ kind, ...options });
export const s = Object.freeze({
  string: (max = 500, options = {}) => descriptor('string', { max, ...options }),
  number: (min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => descriptor('number', { min, max }),
  integer: (min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => descriptor('number', { min, max, integer: true }),
  boolean: () => descriptor('boolean'),
  literal: (value) => descriptor('literal', { value }),
  enum: (...values) => descriptor('enum', { values: Object.freeze(values) }),
  array: (item, max = 1000, min = 0) => descriptor('array', { item, max, min }),
  object: (fields, options = {}) => descriptor('object', { fields: Object.freeze(fields), ...options }),
  record: (item, key, max = 50) => descriptor('record', { item, key, max }),
  union: (...variants) => descriptor('union', { variants: Object.freeze(variants) }),
  optional: (value) => descriptor(value.kind, { ...value, optional: true }),
  nullable: (value) => descriptor('union', { variants: Object.freeze([value, descriptor('literal', { value: null })]) }),
  custom: (check, name) => descriptor('custom', { check, name }),
});

function inspect(schema, value, path, issues, depth = 0) {
  if (issues.length >= 100) return;
  const fail = (rule) => issues.push({ path, rule });
  if (depth > 31) { fail('depth'); return; }
  if (value === undefined) { if (!schema.optional) fail('required'); return; }
  switch (schema.kind) {
    case 'string':
      if (typeof value !== 'string' || value.length > schema.max || (schema.nonempty && !value.trim())
        || (schema.pattern && !schema.pattern.test(value))) fail('string');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < schema.min || value > schema.max
        || (schema.integer && !Number.isSafeInteger(value))) fail('number');
      break;
    case 'boolean': if (typeof value !== 'boolean') fail('boolean'); break;
    case 'literal': if (value !== schema.value) fail('literal'); break;
    case 'enum': if (!schema.values.includes(value)) fail('enum'); break;
    case 'custom': if (!schema.check(value)) fail(schema.name); break;
    case 'union':
      if (!schema.variants.some((variant) => { const errors = []; inspect(variant, value, path, errors, depth + 1); return errors.length === 0; })) fail('union');
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < schema.min || value.length > schema.max) { fail('array'); break; }
      for (let index = 0; index < value.length; index++) inspect(schema.item, value[index], `${path}.${index}`, issues, depth + 1);
      break;
    case 'object':
      if (!plainObject(value)) { fail('object'); break; }
      for (const key of Object.keys(value)) {
        if (!safeKey(key) || !Object.hasOwn(schema.fields, key)) { issues.push({ path: `${path}.${key}`, rule: 'unknown_field' }); continue; }
      }
      for (const [key, field] of Object.entries(schema.fields)) inspect(field, Object.hasOwn(value, key) ? value[key] : undefined, `${path}.${key}`, issues, depth + 1);
      if (issues.length === 0 && schema.refine && !schema.refine(value)) fail('inconsistent');
      break;
    case 'record':
      if (!plainObject(value) || Object.keys(value).length > schema.max) { fail('record'); break; }
      for (const [key, item] of Object.entries(value)) {
        if (!safeKey(key) || !schema.key(key)) { issues.push({ path: `${path}.${key}`, rule: 'key' }); continue; }
        inspect(schema.item, item, `${path}.${key}`, issues, depth + 1);
      }
      break;
    default: fail('schema');
  }
}

export function validate(schema, value) {
  const issues = [];
  inspect(schema, value, '$', issues);
  if (issues.length) throw new DomainError('invalid', 400, issues.slice(0, 100));
  return value;
}

export function schemaAt(schema, path) {
  let current = schema;
  for (const key of path) {
    if (!safeKey(key)) return null;
    if (current.kind === 'object' && Object.hasOwn(current.fields, key)) current = current.fields[key];
    else if (current.kind === 'record' && current.key(key)) current = current.item;
    else return null;
  }
  return current;
}
