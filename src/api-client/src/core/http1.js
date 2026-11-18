/**
 * A small HTTP/1.1 client that speaks over a raw socket (Puter's relayed TCP
 * and TLS sockets in the browser). Unlike fetch it can send any header (Cookie,
 * Host, Origin...), never follows redirects on its own and reports response
 * headers exactly as received, in order and with duplicates.
 *
 * Socket contract (what openSocket(host, port, tls) must return):
 *   on('open' | 'data' | 'close' | 'error', fn), write(bytes), close()
 *   'data' gives a Uint8Array, 'close' gives hadError.
 */

const CR = 13;
const LF = 10;
const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;
const MAX_HEAD_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
// 1xx responses before the final one; each may carry up to MAX_HEAD_BYTES of headers.
const MAX_INTERIM_RESPONSES = 100;
const WRITE_SLICE_BYTES = 64 * 1024;
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// setTimeout fires at once for longer delays, so timeouts are capped at this (about 24 days).
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Headers that describe the body; dropped when a redirect turns the request into a bodiless GET.
const BODY_HEADERS = new Set(['content-length', 'content-type', 'content-encoding', 'content-language', 'content-location', 'transfer-encoding']);

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

const clock = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

function namedError(name, message, extra) {
  const err = new Error(message);
  err.name = name;
  if (extra) Object.assign(err, extra);
  return err;
}

function bodyTooLarge(limit) {
  return namedError('BodyTooLargeError', `Response body is larger than the ${limit} byte limit`, { limit });
}

function protocolError(message) {
  return namedError('ProtocolError', message);
}

function decodeText(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

export function concatBytes(parts, total) {
  if (parts.length === 1) return parts[0];
  const size = total ?? parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return encoder.encode(data);
  return new Uint8Array(0);
}

/** FIFO of received chunks. Reads hand out subarrays, so bytes are copied at most once. */
class ByteQueue {
  constructor() {
    this.chunks = [];
    this.head = 0; // index of the first live chunk
    this.offset = 0; // read offset inside chunks[head]
    this.length = 0;
  }

  push(chunk) {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  chunkLength(i) {
    return this.chunks[i].length - (i === this.head ? this.offset : 0);
  }

  /** Logical index of the first `byte` at or after `from`, or -1. Starts from the tail so new data is cheap to scan. */
  indexOfByte(byte, from = 0) {
    if (from >= this.length) return -1;
    let i = this.chunks.length - 1;
    let start = this.length - this.chunkLength(i);
    while (start > from) {
      i -= 1;
      start -= this.chunkLength(i);
    }
    for (; i < this.chunks.length; i++) {
      const base = i === this.head ? this.offset : 0;
      const chunk = this.chunks[i];
      const idx = chunk.indexOf(byte, base + Math.max(0, from - start));
      if (idx >= 0) return start + idx - base;
      start += chunk.length - base;
    }
    return -1;
  }

  /** Removes n bytes from the front as a list of subarrays. */
  takeParts(n) {
    const parts = [];
    while (n > 0) {
      const chunk = this.chunks[this.head];
      const avail = chunk.length - this.offset;
      if (avail <= n) {
        parts.push(this.offset ? chunk.subarray(this.offset) : chunk);
        this.chunks[this.head] = null;
        this.head += 1;
        this.offset = 0;
        n -= avail;
        this.length -= avail;
      } else {
        parts.push(chunk.subarray(this.offset, this.offset + n));
        this.offset += n;
        this.length -= n;
        n = 0;
      }
    }
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return parts;
  }

  take(n) {
    return concatBytes(this.takeParts(n), n);
  }
}

function headerValues(headers, name) {
  const lower = name.toLowerCase();
  return headers.filter(([k]) => k.toLowerCase() === lower).map(([, v]) => v);
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === lower);
}

function parseHeaderLines(lines) {
  const headers = [];
  for (const bytes of lines) {
    const line = decodeText(bytes);
    if ((line[0] === ' ' || line[0] === '\t') && headers.length) {
      // obs-fold: a continuation of the previous header value
      const last = headers[headers.length - 1];
      const more = line.trim();
      if (more) last[1] = last[1] ? `${last[1]} ${more}` : more;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return headers;
}

function parseHead(lines) {
  const statusLine = decodeText(lines[0]);
  const m = /^HTTP\/(\d+(?:\.\d+)?)[ \t]+(\d{3})(?:[ \t]+(.*))?$/.exec(statusLine);
  if (!m) {
    const shown = statusLine.length > 80 ? `${statusLine.slice(0, 80)}...` : statusLine;
    throw protocolError(`The server did not send a valid HTTP response (got "${shown}")`);
  }
  return { httpVersion: m[1], status: Number(m[2]), statusText: m[3] ?? '', headers: parseHeaderLines(lines.slice(1)) };
}

/** Incremental response parser: feed it chunks, it reports when the message is complete. */
class ResponseParser {
  constructor({ noBody, maxBodyBytes }) {
    this.noBody = noBody;
    this.maxBodyBytes = maxBodyBytes;
    this.queue = new ByteQueue();
    this.state = 'head';
    this.scanned = 0; // bytes at the front of the queue known to hold no LF
    this.lines = [];
    this.headBytes = 0;
    this.received = 0;
    this.head = null;
    this.informational = [];
    this.bodyParts = [];
    this.bodySize = 0;
    this.wireBodyBytes = 0;
    this.remaining = 0;
    this.trailerLines = [];
  }

  get done() {
    return this.state === 'done';
  }

  /** Returns true once a complete response has been parsed. */
  push(chunk) {
    this.received += chunk.length;
    this.queue.push(chunk);
    return this.run();
  }

  /** Called when the socket closes; returns true if that completes the response, throws if it was cut short. */
  end() {
    if (this.state === 'close') this.state = 'done';
    if (this.state === 'done') return true;
    if (this.state === 'head') {
      if (this.received === 0) throw protocolError('The server closed the connection without sending a response');
      throw protocolError('The server closed the connection while sending response headers');
    }
    throw protocolError('The server closed the connection before the response body was complete');
  }

  readLine(limit) {
    const idx = this.queue.indexOfByte(LF, this.scanned);
    if (idx < 0) {
      this.scanned = this.queue.length;
      if (this.scanned > limit) throw protocolError('Response line is too long');
      return null;
    }
    this.scanned = 0;
    const raw = this.queue.take(idx + 1);
    let end = raw.length - 1;
    if (end > 0 && raw[end - 1] === CR) end -= 1;
    return { bytes: raw.subarray(0, end), size: raw.length };
  }

  addBody(n) {
    for (const part of this.queue.takeParts(n)) {
      this.bodyParts.push(part);
      this.bodySize += part.length;
    }
    this.wireBodyBytes += n;
    if (this.bodySize > this.maxBodyBytes) throw bodyTooLarge(this.maxBodyBytes);
  }

  run() {
    for (;;) {
      switch (this.state) {
        case 'head': {
          const line = this.readLine(MAX_HEAD_BYTES - this.headBytes);
          if (!line) return false;
          this.headBytes += line.size;
          if (line.bytes.length) this.lines.push(line.bytes);
          else if (this.lines.length) this.finishHead();
          break;
        }
        case 'length':
        case 'chunk-data': {
          const n = Math.min(this.remaining, this.queue.length);
          if (n) this.addBody(n);
          this.remaining -= n;
          if (this.remaining > 0) return false;
          this.state = this.state === 'length' ? 'done' : 'chunk-end';
          break;
        }
        case 'close':
          if (this.queue.length) this.addBody(this.queue.length);
          return false;
        case 'chunk-size': {
          const line = this.readLine(MAX_LINE_BYTES);
          if (!line) return false;
          this.wireBodyBytes += line.size;
          const sizeText = latin1.decode(line.bytes).split(';')[0].trim();
          if (!/^[0-9a-fA-F]{1,13}$/.test(sizeText)) throw protocolError(`Invalid chunk size "${sizeText.slice(0, 20)}"`);
          this.remaining = parseInt(sizeText, 16);
          this.state = this.remaining ? 'chunk-data' : 'trailers';
          break;
        }
        case 'chunk-end': {
          const line = this.readLine(MAX_LINE_BYTES);
          if (!line) return false;
          this.wireBodyBytes += line.size;
          if (line.bytes.length) throw protocolError('Malformed chunked encoding: missing CRLF after chunk data');
          this.state = 'chunk-size';
          break;
        }
        case 'trailers': {
          const line = this.readLine(MAX_LINE_BYTES);
          if (!line) return false;
          this.wireBodyBytes += line.size;
          this.trailerBytes = (this.trailerBytes || 0) + line.size;
          if (this.trailerBytes > MAX_HEAD_BYTES) throw protocolError('Response trailers are too large');
          if (line.bytes.length) this.trailerLines.push(line.bytes);
          else this.state = 'done';
          break;
        }
        default:
          return true;
      }
    }
  }

  finishHead() {
    const head = parseHead(this.lines);
    head.headerBytes = this.headBytes;
    this.lines = [];
    this.headBytes = 0;
    const { status, headers } = head;
    if (status >= 100 && status < 200 && status !== 101) {
      // 100 Continue, 103 Early Hints...: keep reading for the real response
      if (this.informational.length >= MAX_INTERIM_RESPONSES) throw protocolError(`Too many interim (1xx) responses: more than ${MAX_INTERIM_RESPONSES} before the final one`);
      this.informational.push(head);
      return;
    }
    this.head = head;
    if (this.noBody || status === 204 || status === 304 || status === 101) {
      this.state = 'done';
      return;
    }
    const te = headerValues(headers, 'transfer-encoding').join(',').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (te.length) {
      this.state = te[te.length - 1] === 'chunked' ? 'chunk-size' : 'close';
      return;
    }
    const cl = headerValues(headers, 'content-length');
    if (cl.length) {
      const values = new Set(cl.join(',').split(',').map((s) => s.trim()));
      const [value] = values;
      if (values.size !== 1 || !/^\d+$/.test(value)) throw protocolError(`Invalid Content-Length "${cl.join(', ')}"`);
      this.remaining = Number(value);
      if (this.remaining > this.maxBodyBytes) throw bodyTooLarge(this.maxBodyBytes);
      this.state = this.remaining ? 'length' : 'done';
      return;
    }
    this.state = 'close';
  }
}

function buildRequest({ url, method, headers: given, body }) {
  if (!TOKEN_RE.test(method)) throw new TypeError(`Invalid HTTP method "${method}"`);
  // Like fetch, drop whitespace around values (a value read from a response often ends in a newline).
  const headers = given.map(([name, value]) => [name, String(value).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')]);
  for (const [name, value] of headers) {
    if (!TOKEN_RE.test(name)) throw new TypeError(`Invalid header name "${name}"`);
    if (/[\r\n\0]/.test(String(value))) throw new TypeError(`Header "${name}" contains a line break`);
  }
  const lines = [`${method} ${url.pathname || '/'}${url.search} HTTP/1.1`];
  if (!hasHeader(headers, 'host')) lines.push(`Host: ${url.host}`);
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);

  const te = headerValues(headers, 'transfer-encoding').join(',').toLowerCase();
  const chunked = /(^|,)\s*chunked\s*$/.test(te);
  const needsLength = body != null || ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
  if (needsLength && !te && !hasHeader(headers, 'content-length')) lines.push(`Content-Length: ${body ? body.length : 0}`);
  if (!hasHeader(headers, 'connection')) lines.push('Connection: close');

  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`);
  let payload = body && body.length ? [body] : [];
  if (chunked) {
    // The caller asked for chunked framing, so frame the body as a single chunk.
    const end = encoder.encode('0\r\n\r\n');
    payload = body && body.length ? [encoder.encode(`${body.length.toString(16)}\r\n`), body, encoder.encode('\r\n'), end] : [end];
  }
  return [head, ...payload];
}

function connectError(host, port, reason) {
  const detail = reason ? `: ${reason}` : '';
  return namedError('NetworkError', `Could not connect to ${host}:${port}${detail}`, { beforeConnect: true });
}

function errorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || err.reason || (typeof err.toString === 'function' && err.toString() !== '[object Object]' ? err.toString() : '');
}

/** Opens the socket, writes the request and parses the raw response. No decoding here. */
function exchange({ url, method, parts, openSocket, signal, timeoutMs, maxBodyBytes, onProgress }) {
  return new Promise((resolve, reject) => {
    const tls = url.protocol === 'https:';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port) || (tls ? 443 : 80);
    const parser = new ResponseParser({ noBody: method.toUpperCase() === 'HEAD', maxBodyBytes });
    const t = { start: clock(), open: 0, sent: 0, first: 0, end: 0 };
    let socket = null;
    let opened = false;
    let settled = false;
    let timer = null;

    const progress = (phase) => {
      if (!onProgress) return;
      try {
        onProgress({ phase, received: parser.wireBodyBytes });
      } catch {
        // a broken progress callback must not break the request
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        socket?.close();
      } catch {
        // already closed
      }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      t.end = clock();
      cleanup();
      resolve({ parser, t });
    };
    function onAbort() {
      const reason = signal.reason;
      if (reason?.name === 'TimeoutError') fail(namedError('TimeoutError', reason.message || 'The request timed out'));
      else fail(namedError('AbortError', 'The request was aborted'));
    }

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    if (timeoutMs > 0) timer = setTimeout(() => fail(namedError('TimeoutError', `The request timed out after ${timeoutMs} ms`)), Math.min(timeoutMs, MAX_TIMEOUT_MS));

    progress('connecting');
    try {
      socket = openSocket(host, port, tls);
    } catch (err) {
      return fail(connectError(host, port, errorMessage(err)));
    }

    socket.on('open', () => {
      if (settled || opened) return;
      opened = true;
      t.open = clock();
      progress('sending');
      try {
        for (const part of parts) {
          for (let at = 0; at < part.length; at += WRITE_SLICE_BYTES) {
            socket.write(part.length <= WRITE_SLICE_BYTES ? part : part.subarray(at, at + WRITE_SLICE_BYTES));
          }
        }
      } catch (err) {
        return fail(namedError('NetworkError', `Could not send the request: ${errorMessage(err) || 'write failed'}`));
      }
      t.sent = clock();
      progress('waiting');
    });

    socket.on('data', (data) => {
      if (settled) return;
      const chunk = toUint8(data);
      if (!chunk.length) return;
      if (!t.first) t.first = clock();
      const hadHead = parser.head;
      let done;
      try {
        done = parser.push(chunk);
      } catch (err) {
        return fail(err);
      }
      if (!hadHead && parser.head) progress('headers');
      if (done) finish();
      else if (parser.head) progress('body');
    });

    socket.on('error', (err) => {
      if (settled) return;
      const reason = errorMessage(err);
      if (!opened) fail(connectError(host, port, reason));
      else fail(namedError('NetworkError', `Connection to ${host}:${port} failed${reason ? `: ${reason}` : ''}`));
    });

    socket.on('close', (hadError) => {
      if (settled) return;
      if (!opened) return fail(connectError(host, port, 'connection closed'));
      if (hadError && !parser.done) return fail(namedError('NetworkError', `Connection to ${host}:${port} was closed with an error`));
      try {
        if (parser.end()) finish();
      } catch (err) {
        fail(err);
      }
    });
  });
}

function supportsFormat(format) {
  try {
    new DecompressionStream(format); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

/** The Compression Streams standard calls it "brotli"; some engines may only know "br". */
function brotliFormat() {
  if (supportsFormat('brotli')) return 'brotli';
  return supportsFormat('br') ? 'br' : null;
}

// Engines word decode errors differently (Node 22 gives none); some name trailing junk.
const isJunk = (err) => /junk/i.test(err?.message || '');
// How many bytes of junk are looked past without the engine naming it: enough for a stray newline.
const SHORT_JUNK = 16;

/**
 * Decompresses bytes. Bytes after the end of the stream (a stray newline, a
 * second gzip member) are ignored, as browsers do. Some engines drop output not
 * yet read when they find them, so the stream's real end is looked for and the
 * bytes up to it decoded on their own. Only the real end decodes cleanly (cut
 * shorter the stream ends too early, cut longer there is junk again), so what
 * comes back is never a cut-off body. Bodies that decode are decoded once.
 */
async function inflate(bytes, format, limit) {
  try {
    return await inflateAll(bytes, format, limit);
  } catch (err) {
    if (err.name === 'BodyTooLargeError') throw err;
    const attempt = async (end) => {
      try {
        return { body: await inflateAll(bytes.subarray(0, end), format, limit) };
      } catch (e) {
        if (e.name === 'BodyTooLargeError') throw e;
        return { junk: isJunk(e) };
      }
    };
    // A few bytes of junk: try each end just before the end of the data.
    let junkAt = bytes.length;
    for (; junkAt > Math.max(1, bytes.length - SHORT_JUNK); ) {
      const r = await attempt(junkAt - 1);
      if (r.body) return r.body;
      // Too short already (when the engine tells the two apart): there is no clean end.
      if (!r.junk && isJunk(err)) throw err;
      junkAt--;
    }
    // Longer junk can only be searched for when the engine says which side of the end a cut is on.
    if (!isJunk(err)) throw err;
    let shortAt = 0;
    for (let step = 1; ; step *= 2) {
      const end = junkAt - step;
      if (end <= shortAt) break;
      const r = await attempt(end);
      if (r.body) return r.body;
      if (!r.junk) {
        shortAt = end;
        break;
      }
      junkAt = end;
    }
    while (junkAt - shortAt > 1) {
      const mid = Math.floor((junkAt + shortAt) / 2);
      const r = await attempt(mid);
      if (r.body) return r.body;
      if (r.junk) junkAt = mid;
      else shortAt = mid;
    }
    throw err;
  }
}

async function inflateAll(bytes, format, limit) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw bodyTooLarge(limit);
    }
    parts.push(value);
  }
  return concatBytes(parts, size);
}

function looksLikeZlib(bytes) {
  return bytes.length >= 2 && (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0;
}

/**
 * Undoes Content-Encoding. Never throws for bad data: the raw body comes back with
 * decodeError set, or undecodedEncoding when the coding is not supported here.
 */
export async function decodeContent(body, encodings, limit = DEFAULT_MAX_BODY_BYTES) {
  const codings = encodings.join(',').toLowerCase().split(',').map((s) => s.trim()).filter((c) => c && c !== 'identity');
  if (!codings.length || !body.length) return { body, decoded: false, undecodedEncoding: null, decodeError: null };
  const raw = (undecodedEncoding, decodeError = null) => ({ body, decoded: false, undecodedEncoding, decodeError });
  if (typeof DecompressionStream !== 'function') return raw(codings.join(', '));
  let data = body;
  try {
    for (const coding of codings.reverse()) {
      if (coding === 'gzip' || coding === 'x-gzip') {
        data = await inflate(data, 'gzip', limit);
      } else if (coding === 'deflate') {
        // "deflate" is meant to be zlib-wrapped, but some servers send raw deflate.
        if (looksLikeZlib(data)) {
          try {
            data = await inflate(data, 'deflate', limit);
          } catch (err) {
            if (err.name === 'BodyTooLargeError') throw err;
            data = await inflate(data, 'deflate-raw', limit);
          }
        } else {
          data = await inflate(data, 'deflate-raw', limit);
        }
      } else if (coding === 'br' && brotliFormat()) {
        data = await inflate(data, brotliFormat(), limit);
      } else {
        return raw(coding);
      }
    }
  } catch (err) {
    if (err.name === 'BodyTooLargeError') throw err;
    return raw(null, `Could not decode ${codings.join(', ')} body: ${err.message || err}`);
  }
  return { body: data, decoded: true, undecodedEncoding: null, decodeError: null };
}

/**
 * Sends one HTTP/1.1 request over a fresh connection and reads the full response.
 * headers: [[name, value]] sent as given (order, case and duplicates kept).
 * Resolves { status, statusText, httpVersion, headers, trailers, informational, body, encodedSize,
 *   decodedSize, headerBytes, contentEncoding, decoded, undecodedEncoding, decodeError, timings }.
 * encodedSize counts every byte after the response head (chunk framing and trailers included).
 */
export async function http1Request({
  url,
  method = 'GET',
  headers = [],
  body = null,
  openSocket,
  signal,
  timeoutMs = 0,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  onProgress,
}) {
  const target = url instanceof URL ? url : new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new TypeError(`Unsupported protocol "${target.protocol}"`);
  if (typeof openSocket !== 'function') throw new TypeError('openSocket is required');
  const bodyBytes = body == null ? null : toUint8(body);
  const parts = buildRequest({ url: target, method, headers, body: bodyBytes });

  const { parser, t } = await exchange({ url: target, method, parts, openSocket, signal, timeoutMs, maxBodyBytes, onProgress });
  const { head } = parser;
  const encoded = concatBytes(parser.bodyParts, parser.bodySize);
  // Transfer codings other than chunked (rare, e.g. "gzip, chunked") were applied after the content codings.
  const transferCodings = headerValues(head.headers, 'transfer-encoding').join(',').split(',').map((c) => c.trim()).filter((c) => c && c.toLowerCase() !== 'chunked');
  const contentEncoding = [...headerValues(head.headers, 'content-encoding'), ...transferCodings];
  if (contentEncoding.length && encoded.length && onProgress) onProgress({ phase: 'decoding', received: parser.wireBodyBytes });
  const decoded = await decodeContent(encoded, contentEncoding, maxBodyBytes);
  if (signal?.aborted) throw namedError('AbortError', 'The request was aborted');
  const total = clock() - t.start;
  if (onProgress) onProgress({ phase: 'done', received: parser.wireBodyBytes });

  return {
    status: head.status,
    statusText: head.statusText,
    httpVersion: head.httpVersion,
    headers: head.headers,
    trailers: parseHeaderLines(parser.trailerLines),
    informational: parser.informational.map(({ status, statusText, headers: h }) => ({ status, statusText, headers: h })),
    body: decoded.body,
    encodedSize: parser.wireBodyBytes,
    decodedSize: decoded.body.length,
    headerBytes: head.headerBytes,
    contentEncoding: contentEncoding.length ? contentEncoding.join(', ') : null,
    decoded: decoded.decoded,
    undecodedEncoding: decoded.undecodedEncoding,
    decodeError: decoded.decodeError,
    timings: {
      connect: t.open - t.start,
      firstByte: t.first ? t.first - t.sent : 0,
      download: t.first ? t.end - t.first : 0,
      total,
    },
  };
}

function redirectHeaders(headers, { dropBody, crossOrigin, credentials }) {
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    if (dropBody && BODY_HEADERS.has(lower)) return false;
    if (crossOrigin && (lower === 'authorization' || lower === 'proxy-authorization' || lower === 'cookie' || lower === 'host' || credentials.has(lower))) return false;
    return true;
  });
}

/**
 * Wraps sendOnce({ url, method, headers, body }) with browser-style redirect handling.
 * 303 (and 301/302 after POST) become GET without a body, 307/308 resend as-is.
 * Credentials (Authorization, Proxy-Authorization, Cookie, and the headers named
 * in credentialHeaders, such as an API key) and a custom Host are dropped when the origin changes.
 * Resolves the final response plus { url, redirects: [{ url, status, location }] }.
 */
export async function followRedirects(sendOnce, { url, method = 'GET', headers = [], body = null, maxRedirects = 10, follow = true, credentialHeaders = [] }) {
  const credentials = new Set(credentialHeaders.map((name) => name.toLowerCase()));
  let current = { url: String(url), method, headers, body };
  const redirects = [];
  for (;;) {
    const res = await sendOnce(current);
    const location = follow && REDIRECT_STATUSES.has(res.status) ? headerValues(res.headers, 'location')[0] : undefined;
    let next = null;
    if (location) {
      try {
        next = new URL(location, current.url);
      } catch {
        next = null;
      }
      if (next && next.protocol !== 'http:' && next.protocol !== 'https:') next = null;
    }
    if (!next) return { ...res, url: current.url, redirects };
    if (redirects.length >= maxRedirects) {
      throw namedError('TooManyRedirectsError', `Stopped after ${maxRedirects} redirects (last one went to ${next.href})`, { redirects });
    }
    redirects.push({ url: current.url, status: res.status, location });

    const upper = current.method.toUpperCase();
    const toGet = (res.status === 303 && upper !== 'GET' && upper !== 'HEAD') || ((res.status === 301 || res.status === 302) && upper === 'POST');
    const crossOrigin = new URL(current.url).origin !== next.origin;
    current = {
      url: next.href,
      method: toGet ? 'GET' : current.method,
      headers: redirectHeaders(current.headers, { dropBody: toGet, crossOrigin, credentials }),
      body: toGet ? null : current.body,
    };
  }
}

const isType = (value, tag) => Object.prototype.toString.call(value) === `[object ${tag}]`;

/**
 * Converts a request body into bytes plus the content type fetch would have
 * implied (null when none). null/undefined give { bytes: null, contentType: null }.
 */
export async function toBytes(input) {
  if (input == null) return { bytes: null, contentType: null };
  if (typeof input === 'string') return { bytes: encoder.encode(input), contentType: 'text/plain;charset=UTF-8' };
  if (input instanceof ArrayBuffer || isType(input, 'ArrayBuffer')) return { bytes: new Uint8Array(input), contentType: null };
  if (ArrayBuffer.isView(input)) return { bytes: new Uint8Array(input.buffer, input.byteOffset, input.byteLength), contentType: null };
  if (isType(input, 'FormData') || isType(input, 'URLSearchParams')) {
    const req = new Request('http://x', { method: 'POST', body: input });
    return { bytes: new Uint8Array(await req.arrayBuffer()), contentType: req.headers.get('content-type') };
  }
  if (typeof input.arrayBuffer === 'function' && typeof input.size === 'number') {
    return { bytes: new Uint8Array(await input.arrayBuffer()), contentType: input.type || null };
  }
  if (typeof input.size === 'number' && typeof FileReader === 'function') {
    const buf = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(input);
    });
    return { bytes: new Uint8Array(buf), contentType: input.type || null };
  }
  throw new TypeError('Unsupported body type');
}
