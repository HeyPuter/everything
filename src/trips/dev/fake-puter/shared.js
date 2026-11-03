export const MAX_KEY_SIZE = 1024;
export const MAX_VALUE_SIZE = 399 * 1024;
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value ?? null)).length;
export const jsonBytes = value => bytes(JSON.stringify(value ?? null));
export const error = (code, status = 400, message = code) => Object.assign(new Error(message), { code, status, statusCode: status });
export function keyString(key) {
  if (key === undefined || key === null) throw error('key_undefined');
  const value = String(key);
  if (!value) throw error('bad_request');
  if (bytes(value) > MAX_KEY_SIZE) throw error('key_too_large');
  return value;
}
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
export function validateValue(value, depth = 1) {
  if (depth > 32) throw error('bad_request', 400, 'Value nested too deeply');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (unsafe.has(key)) throw error('bad_request', 400, 'Unsafe value key');
      validateValue(child, depth + 1);
    }
  }
  if (depth === 1 && jsonBytes(value) > MAX_VALUE_SIZE) throw error('value_too_large');
}
export function number(value, code = 'bad_request') {
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw error(code);
  return n;
}
export function parsePath(path) {
  if (typeof path !== 'string') throw error('invalid_path');
  const result = [];
  let i = 0;
  let segment = true;
  const push = token => {
    if (result.length === 31) throw error('bad_request', 400, 'Path nested too deeply');
    if (typeof token === 'string' && (!token || unsafe.has(token))) throw error('bad_request');
    result.push(token);
  };
  while (i < path.length) {
    if (path[i] === '.') { while (path[i] === '.') i++; segment = true; continue; }
    if (!segment && path[i] !== '[') throw error('invalid_path');
    if (path[i] === '[') {
      i++;
      if (path[i] === '"' || path[i] === "'") {
        const quote = path[i++];
        let value = '';
        while (i < path.length && path[i] !== quote) {
          if (path[i] === '\\') { i++; if (i === path.length) throw error('invalid_path'); }
          value += path[i++];
        }
        if (path[i++] !== quote || path[i++] !== ']') throw error('invalid_path');
        push(value);
      } else {
        const match = /^\d+\]/.exec(path.slice(i));
        if (!match) throw error('invalid_path');
        const index = Number(match[0].slice(0, -1));
        if (!Number.isSafeInteger(index)) throw error('invalid_path');
        i += match[0].length;
        push(index);
      }
    } else {
      const start = i;
      while (i < path.length && path[i] !== '.' && path[i] !== '[') i++;
      push(path.slice(start, i));
    }
    segment = false;
  }
  return result;
}
export function pathEntries(map) {
  if (!isObject(map) || !Object.keys(map).length) throw error('path_map_invalid');
  const entries = Object.entries(map).map(([path, value]) => [parsePath(path), value]);
  if (entries.reduce((n, [path]) => n + path.length, 0) > 1500) throw error('bad_request');
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i][0]; const b = entries[j][0];
      if (a.slice(0, Math.min(a.length, b.length)).every((part, n) => part === b[n])) throw error('bad_request', 400, 'Overlapping paths');
    }
  }
  return entries;
}
export function changePath(root, parts, transform, remove = false) {
  if (!parts.length) return transform(root);
  if (root === undefined) root = {};
  let parent = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part === 'number' ? !Array.isArray(parent) || part >= parent.length : !isObject(parent)) throw error('invalid_path');
    if (i === parts.length - 1) {
      if (remove) {
        if (Array.isArray(parent)) parent.splice(part, 1);
        else delete parent[part];
      } else parent[part] = transform(Object.hasOwn(parent, part) ? parent[part] : undefined);
    } else {
      if (!Object.hasOwn(parent, part)) {
        if (remove) return root;
        if (typeof parts[i + 1] === 'number') throw error('invalid_path');
        parent[part] = {};
      }
      parent = parent[part];
    }
  }
  return root;
}
export function trailing(rest) {
  if (rest[0] === undefined) rest.shift();
  const optConfig = isObject(rest[0]) ? rest.shift() : undefined;
  const success = typeof rest[0] === 'function' ? rest.shift() : undefined;
  const failure = typeof rest[0] === 'function' ? rest.shift() : undefined;
  return { optConfig, success, error: failure };
}
export function optCallbacks(rest) {
  return isObject(rest[0]) ? { optConfig: rest[0], success: rest[1], error: rest[2] } : { success: rest[0], error: rest[1] };
}
/** The SDK's `{appUuid}` shorthand never selects a handle; only an explicit `optConfig.handle` does. */
export function shorthandConfig(value) {
  const { handle: _handle, ...config } = value;
  return config;
}
export function counterArgs(key, amount, optConfig) {
  if (isObject(key) && amount === undefined && optConfig === undefined) return { ...key };
  if (key === undefined && amount === undefined && optConfig === undefined) throw error('arguments_required');
  if (isObject(amount) && Object.hasOwn(amount, 'appUuid') && optConfig === undefined) { optConfig = shorthandConfig(amount); amount = undefined; }
  return { key, pathAndAmountMap: amount == null ? { '': 1 } : typeof amount === 'number' ? { '': amount } : amount, optConfig };
}
