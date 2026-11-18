/**
 * Sends a ResolvedRequest with one of two transports:
 *
 * - browser: window.fetch. Fast and needs no account, but the target server
 *   must allow cross-origin requests (CORS), some headers (Cookie, Host,
 *   Origin...) cannot be set, and only CORS-exposed response headers are
 *   visible.
 * - relay: a raw HTTP/1.1 client over puter.net sockets, Puter's socket
 *   relay (TLS runs in the browser). Works with any server, sends every
 *   header as written and shows every response header, but needs a
 *   signed-in Puter account.
 *
 * 'auto' sends through the relay when signed in, and from the browser for
 * local servers (the relay cannot reach them) and when signed out. When the
 * relay cannot open a connection, nothing has been sent, so the browser
 * tries instead.
 */
import { buildBody, graphqlJson, USER_AGENT } from './prepare.js';
import { http1Request, followRedirects, toBytes, MAX_TIMEOUT_MS } from './http1.js';
import { isPrivateHost } from './url.js';

/** Request headers a page cannot set with fetch; the browser drops or overrides them. */
const FORBIDDEN = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);

export function forbiddenHeaders(headers) {
  return headers.filter((h) => FORBIDDEN.has(h.key.toLowerCase()) || /^(proxy-|sec-)/i.test(h.key)).map((h) => h.key);
}

const SAFE_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const SAFELISTED = new Set(['accept', 'accept-language', 'content-language', 'content-type']);

/**
 * True when the browser sends this request without asking the server first
 * (no CORS preflight). Such a request reaches the server even when the
 * response is then blocked, so it must not be retried automatically unless
 * it is also safe to repeat.
 */
export function isSimpleRequest(resolved) {
  if (!['GET', 'HEAD', 'POST'].includes(resolved.method)) return false;
  for (const h of resolved.headers) {
    const k = h.key.toLowerCase();
    if (!SAFELISTED.has(k)) return false;
    if (k === 'content-type' && !SAFE_CONTENT_TYPES.includes(h.value.split(';')[0].trim().toLowerCase())) return false;
  }
  return true;
}

/**
 * Requests that are safe to send again after the browser failed. A failed
 * browser request may still have reached the server (no preflight, or a
 * response that was only blocked on the way back), so only safe methods
 * qualify.
 */
export function canRetry(resolved) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(resolved.method);
}

export class SendError extends Error {
  /** beforeConnect: no connection was opened, so nothing reached the server. */
  constructor(message, { code = 'network', hint = '', transport = 'browser', beforeConnect = false, cause } = {}) {
    super(message);
    this.name = 'SendError';
    this.code = code;
    this.hint = hint;
    this.transport = transport;
    if (beforeConnect) this.beforeConnect = true;
    if (cause) this.cause = cause;
  }
}

/** True when puter.net refused to open a socket because the Puter session is missing or expired. */
function isAuthFailure(err) {
  return /relay token[^]*\b40[13]\b|\b(unauthori[sz]ed|not signed in|authentication)\b/i.test(err?.message || '');
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason?.name === 'TimeoutError') return new SendError(reason.message || 'The request timed out.', { code: 'timeout' });
  return new SendError('The request was cancelled.', { code: 'aborted' });
}

/** Combines a caller's signal with an optional timeout. */
function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return { signal, done() {} };
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    const err = new Error(`No response after ${formatSeconds(timeoutMs)}.`);
    err.name = 'TimeoutError';
    ctl.abort(err);
  }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
  const onAbort = () => ctl.abort(signal.reason);
  if (signal?.aborted) onAbort(); // Cancelled before we got here: never send.
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

const formatSeconds = (ms) => (ms % 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms / 1000} s`);

async function readBody(res, signal, maxBytes) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) {
      reader.cancel().catch(() => {});
      throw abortError(signal);
    }
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      throw new SendError('The connection closed before the response finished.', { code: 'network', cause: err });
    }
    const { done, value } = chunk;
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new SendError(`The response is larger than ${Math.round(maxBytes / 1048576)} MB.`, { code: 'too-large' });
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function headerBytes(list) {
  let n = 0;
  for (const [k, v] of list) n += k.length + v.length + 4;
  return n;
}

export async function sendBrowser(resolved, { files, signal, timeoutMs = 0, followRedirects: follow = true, maxBytes = 100 * 1048576 } = {}) {
  const t = withTimeout(signal, timeoutMs);
  const headers = new Headers();
  for (const h of resolved.headers) {
    if (FORBIDDEN.has(h.key.toLowerCase())) continue;
    try {
      headers.append(h.key, h.value);
    } catch {
      t.done();
      throw new SendError(`Header "${h.key}" has a name or value the browser does not accept.`, { code: 'bad-header' });
    }
  }
  let body;
  try {
    body = buildBody(resolved.body, files);
  } catch (err) {
    t.done();
    throw new SendError(err.message, { code: 'body' });
  }
  if (body instanceof FormData) headers.delete('content-type');
  const start = performance.now();
  let res;
  try {
    res = await fetch(resolved.url, {
      method: resolved.method,
      headers,
      body,
      redirect: follow ? 'follow' : 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: t.signal,
    });
  } catch (err) {
    t.done();
    if (t.signal?.aborted) throw abortError(t.signal);
    throw classifyFetchError(resolved, err);
  }
  const firstByte = performance.now() - start;
  try {
    if (res.type === 'opaqueredirect') {
      return {
        status: 0,
        statusText: 'Redirect not followed',
        headers: [],
        body: new Uint8Array(),
        size: { body: 0, headers: 0 },
        timings: { total: performance.now() - start, firstByte },
        transport: 'browser',
        url: resolved.url,
        redirects: [],
        warnings: ['The server sent a redirect. Browsers hide redirect details from pages; turn on following redirects or use the Puter relay to see it.'],
      };
    }
    const bytes = await readBody(res, t.signal, maxBytes);
    const list = [...res.headers];
    return {
      status: res.status,
      statusText: res.statusText,
      headers: list,
      body: bytes,
      size: { body: bytes.length, headers: headerBytes(list) },
      timings: { total: performance.now() - start, firstByte, download: performance.now() - start - firstByte },
      transport: 'browser',
      url: res.url || resolved.url,
      redirects: res.redirected ? [{ url: resolved.url, status: 0 }] : [],
      warnings: [],
    };
  } finally {
    t.done();
  }
}

function classifyFetchError(resolved, err) {
  let target;
  try {
    target = new URL(resolved.url);
  } catch {
    return new SendError('The URL is not valid.', { code: 'bad-url', cause: err });
  }
  if (!/^https?:$/.test(target.protocol)) return new SendError(`${target.protocol.replace(':', '')} URLs are not supported.`, { code: 'bad-url' });
  if (typeof location !== 'undefined' && location.protocol === 'https:' && target.protocol === 'http:' && !isPrivateHost(target.hostname)) {
    return new SendError('The browser blocked a plain http:// request from this secure page.', {
      code: 'mixed-content',
      hint: 'Use https://, or send it through the Puter relay.',
      cause: err,
    });
  }
  return new SendError('Could not get a response.', {
    code: 'network',
    hint: isPrivateHost(target.hostname)
      ? 'Check that the server is running and allows cross-origin requests (CORS) from this page.'
      : 'The server may not allow requests from web pages (CORS), or it may be unreachable. Sending through the Puter relay avoids CORS.',
    cause: err,
  });
}

/** Socket opener backed by Puter's network relay. */
export function puterSockets(puter) {
  return (host, port, tls) => (tls ? new puter.net.tls.TLSSocket(host, port) : new puter.net.Socket(host, port));
}

export async function sendRelay(resolved, { files, signal, timeoutMs = 0, followRedirects: follow = true, openSocket, cookieJar, maxBytes = 100 * 1048576 } = {}) {
  if (!openSocket) throw new SendError('Sign in to Puter to send requests through the Puter relay.', { code: 'signed-out', transport: 'relay', beforeConnect: true });
  let payload = null;
  let contentType = null;
  try {
    const built = buildBody(resolved.body, files);
    if (built != null) ({ bytes: payload, contentType } = await toBytes(built));
  } catch (err) {
    throw new SendError(err.message, { code: 'body', transport: 'relay' });
  }
  const headers = [];
  const has = (name) => headers.some(([k]) => k.toLowerCase() === name);
  for (const h of resolved.headers) {
    // The body is built with its own boundary, so a typed or imported multipart Content-Type would not match it.
    if (resolved.body?.mode === 'form' && h.key.toLowerCase() === 'content-type' && /multipart\/form-data/i.test(h.value)) continue;
    headers.push([h.key, h.value]);
  }
  if (contentType && !has('content-type')) headers.push(['Content-Type', contentType]);
  if (!has('user-agent')) headers.push(['User-Agent', USER_AGENT]);
  if (!has('accept-encoding')) headers.push(['Accept-Encoding', 'gzip, deflate']);

  const start = performance.now();
  // One timeout for the whole exchange, redirects included, as in the browser.
  const t = withTimeout(signal, timeoutMs);
  let answered = 0; // hops that got a response; after one, the request has reached a server
  const sendOnce = async ({ url, method, headers: hs, body }) => {
    const list = [...hs];
    if (cookieJar && !list.some(([k]) => k.toLowerCase() === 'cookie')) {
      const cookie = cookieJar.cookieHeader(url);
      if (cookie) list.push(['Cookie', cookie]);
    }
    const res = await http1Request({ url, method, headers: list, body, openSocket, signal: t.signal, maxBodyBytes: maxBytes });
    answered++;
    if (cookieJar) {
      const set = res.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
      if (set.length) cookieJar.setFromResponse(url, set);
    }
    return { ...res, sentHeaders: list };
  };
  let res;
  try {
    const credentialHeaders = resolved.headers.filter((h) => h.credential).map((h) => h.key);
    res = await followRedirects(sendOnce, { url: resolved.url, method: resolved.method, headers, body: payload, follow, credentialHeaders });
  } catch (err) {
    if (t.signal?.reason?.name === 'TimeoutError') throw new SendError(t.signal.reason.message, { code: 'timeout', transport: 'relay' });
    if (err?.name === 'AbortError') throw new SendError('The request was cancelled.', { code: 'aborted', transport: 'relay' });
    if (err?.name === 'TimeoutError') throw new SendError(err.message || 'The request timed out.', { code: 'timeout', transport: 'relay' });
    if (err instanceof SendError) throw err;
    const beforeConnect = !!err?.beforeConnect && !answered;
    if (beforeConnect && isAuthFailure(err)) {
      throw new SendError('Your Puter session has expired.', { code: 'signed-out', hint: 'Sign in again to send requests through the Puter relay.', transport: 'relay', beforeConnect: true, cause: err });
    }
    throw new SendError(err?.message || 'Could not get a response through the relay.', { code: 'network', transport: 'relay', beforeConnect, cause: err });
  } finally {
    t.done();
  }
  const warnings = [];
  if (res.undecodedEncoding) warnings.push(`The response is ${res.undecodedEncoding}-encoded and this browser cannot decode it.`);
  if (res.decodeError) warnings.push(`The response is marked ${res.contentEncoding}-encoded but could not be decoded, so it is shown as received.`);
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body: res.body,
    size: { body: res.decodedSize ?? res.body.length, encoded: res.encodedSize, headers: res.headerBytes ?? headerBytes(res.headers) },
    // The hop timings are for the last response; the total includes any redirects before it.
    timings: { ...res.timings, total: performance.now() - start },
    transport: 'relay',
    url: res.url || resolved.url,
    redirects: res.redirects || [],
    httpVersion: res.httpVersion,
    sentHeaders: res.sentHeaders,
    warnings,
  };
}

/**
 * Picks a transport and sends. options.mode: 'auto' | 'browser' | 'relay'.
 * options.relay: { openSocket, cookieJar } or null when signed out.
 */
export async function send(resolved, options = {}) {
  const { mode = 'auto', relay = null } = options;
  let target;
  try {
    target = new URL(resolved.url);
  } catch {
    throw new SendError('Enter a valid URL, for example https://api.example.com/items.', { code: 'bad-url' });
  }
  const relayOpts = { ...options, openSocket: relay?.openSocket, cookieJar: relay?.cookieJar };
  if (mode === 'relay') return sendRelay(resolved, relayOpts);
  const local = isPrivateHost(target.hostname);
  let relayError = null;
  if (mode === 'auto' && relay && !local) {
    try {
      return await sendRelay(resolved, relayOpts);
    } catch (err) {
      // Only a relay that never connected leaves the request unsent; anything later must not be repeated.
      if (!(err instanceof SendError) || !err.beforeConnect) throw err;
      relayError = err;
    }
  }
  const warnings = [];
  const dropped = forbiddenHeaders(resolved.headers);
  if (dropped.length) {
    warnings.push(
      mode === 'browser' || local
        ? `The browser does not let pages set ${dropped.join(', ')}; ${dropped.length > 1 ? 'they were' : 'it was'} not sent.`
        : `The browser does not let pages set ${dropped.join(', ')}. Send through the Puter relay to include ${dropped.length > 1 ? 'them' : 'it'}.`,
    );
  }
  if (relayError) warnings.unshift(relayError.code === 'signed-out' ? 'Your Puter session has expired, so this was sent from the browser. Sign in again to use the Puter relay.' : `The Puter relay could not connect (${relayError.message}), so this was sent from the browser.`);
  try {
    const res = await sendBrowser(resolved, options);
    res.warnings.unshift(...warnings);
    return res;
  } catch (err) {
    if (mode !== 'auto' || !(err instanceof SendError) || !['network', 'mixed-content'].includes(err.code) || local) throw err;
    // The relay already failed to connect; its reason says more than the browser's.
    if (relayError) throw relayError;
    if (!relay) {
      const again = err.code === 'mixed-content' || canRetry(resolved) ? '' : ' The request may already have reached the server, so check before sending it again.';
      err.hint = `${err.hint} Sign in to Puter to send it through the Puter relay.${again}`.trim();
      if (err.code !== 'mixed-content') err.code = 'cors';
    }
    throw err;
  }
}

/** The charset parameter of a response's Content-Type, lowercased, or ''. */
export function charsetOf(headers) {
  const h = headers.find(([k]) => k.toLowerCase() === 'content-type');
  return h?.[1].match(/;\s*charset\s*=\s*"?([^";\s]+)/i)?.[1].toLowerCase() || '';
}

/** Content type of a response without parameters, lowercased. */
export function contentTypeOf(headers) {
  const h = headers.find(([k]) => k.toLowerCase() === 'content-type');
  return h ? h[1].split(';')[0].trim().toLowerCase() : '';
}

export { graphqlJson };
