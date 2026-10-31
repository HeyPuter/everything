const fail = () => Object.assign(new Error('Invalid bridge value'), { code: 'bridge_invalid_value', status: 400 });
const abort = () => new DOMException('Aborted', 'AbortError');
const bytesToBase64 = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const plain = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Tagged values keep user objects separate from transport control records. */
export function createBridgeCodec({ maxBytes = 8 * 1024 * 1024, maxNodes = 100_000 } = {}) {
  const check = (state, depth, bytes = 0) => {
    state.nodes++; state.bytes += bytes;
    if (depth > 40 || state.nodes > maxNodes || state.bytes > maxBytes) throw fail();
  };
  const size = value => new TextEncoder().encode(value).length;
  const collect = async (value, signal) => {
    if (signal?.aborted) throw abort();
    if (value.body === null) return null;
    const reader = value.body.getReader();
    const chunks = []; let length = 0;
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        if (signal?.aborted) throw abort();
        const { value: chunk, done } = await reader.read(); if (done) break;
        length += chunk.byteLength;
        if (length > maxBytes) { cancel(); throw fail(); }
        chunks.push(chunk);
      }
      if (signal?.aborted) throw abort();
      const output = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
      return output;
    } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
  };
  async function encode(value, signal) {
    const state = { bytes: 0, nodes: 0 };
    const visit = async (value, depth) => {
      if (signal?.aborted) throw abort();
      check(state, depth);
      if (value === undefined) return { t: 'undefined' };
      if (value === null || typeof value === 'boolean') return { t: 'scalar', v: value };
      if (typeof value === 'number') { if (!Number.isFinite(value)) throw fail(); return { t: 'scalar', v: value }; }
      if (typeof value === 'string') { check(state, depth, size(value)); return { t: 'scalar', v: value }; }
      if (Array.isArray(value)) return { t: 'array', v: await Promise.all(value.map(item => visit(item, depth + 1))) };
      if (value instanceof Blob) {
        if (value.size > maxBytes) throw fail();
        const data = new Uint8Array(await value.arrayBuffer()); check(state, depth, data.length);
        return { t: 'blob', data: bytesToBase64(data), mime: value.type };
      }
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const data = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        check(state, depth, data.length); return { t: 'bytes', data: bytesToBase64(data) };
      }
      if (value instanceof Request || value instanceof Response) {
        const request = value instanceof Request;
        const body = await collect(value.clone(), signal); check(state, depth, body?.length ?? 0);
        const headers = [...value.headers];
        for (const [key, val] of headers) check(state, depth, size(key) + size(val));
        return request ? { t: 'request', url: value.url, method: value.method, headers, data: body === null ? null : bytesToBase64(body) } : { t: 'response', status: value.status, statusText: value.statusText, headers, data: body === null ? null : bytesToBase64(body) };
      }
      if (!plain(value)) throw fail();
      const entries = [];
      for (const [key, item] of Object.entries(value)) { check(state, depth, size(key)); entries.push([key, await visit(item, depth + 1)]); }
      return { t: 'object', v: entries };
    };
    return visit(value, 0);
  }
  function decode(value) {
    const state = { bytes: 0, nodes: 0 };
    const binary = data => {
      if (typeof data !== 'string' || data.length > Math.ceil(maxBytes / 3) * 4 || (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) throw fail();
      const decoded = atob(data); check(state, 0, decoded.length);
      return Uint8Array.from(decoded, char => char.charCodeAt(0));
    };
    const headerPairs = headers => {
      if (!Array.isArray(headers) || headers.length > 200) throw fail();
      for (const pair of headers) {
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string')) throw fail();
        check(state, 0, size(pair[0]) + size(pair[1]));
      }
      return headers;
    };
    const visit = (node, depth) => {
      check(state, depth);
      if (!plain(node) || typeof node.t !== 'string') throw fail();
      switch (node.t) {
        case 'undefined': return undefined;
        case 'scalar':
          if (node.v !== null && !['boolean', 'number', 'string'].includes(typeof node.v)) throw fail();
          if (typeof node.v === 'number' && !Number.isFinite(node.v)) throw fail();
          if (typeof node.v === 'string') check(state, depth, size(node.v));
          return node.v;
        case 'array':
          if (!Array.isArray(node.v)) throw fail();
          return node.v.map(item => visit(item, depth + 1));
        case 'object': {
          if (!Array.isArray(node.v)) throw fail();
          const entries = []; const keys = new Set();
          for (const pair of node.v) {
            if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || keys.has(pair[0])) throw fail();
            keys.add(pair[0]); check(state, depth, size(pair[0])); entries.push([pair[0], visit(pair[1], depth + 1)]);
          }
          return Object.fromEntries(entries);
        }
        case 'bytes': return binary(node.data);
        case 'blob':
          if (typeof node.mime !== 'string' || node.mime.length > 200) throw fail();
          return new Blob([binary(node.data)], { type: node.mime });
        case 'request': {
          if (typeof node.url !== 'string' || node.url.length > 2048 || typeof node.method !== 'string') throw fail();
          const headers = headerPairs(node.headers); const body = node.data === null ? undefined : binary(node.data);
          return new Request(node.url, { method: node.method, headers, ...(body === undefined ? {} : { body }) });
        }
        case 'response': {
          if (!Number.isInteger(node.status) || typeof node.statusText !== 'string' || node.statusText.length > 200) throw fail();
          const body = node.data === null ? null : binary(node.data);
          return new Response(body, { status: node.status, statusText: node.statusText, headers: headerPairs(node.headers) });
        }
        default: throw fail();
      }
    };
    return visit(value, 0);
  }
  return { encode, decode };
}
