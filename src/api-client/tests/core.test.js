import { describe, it, expect, vi, afterEach } from 'vitest';
import { request, pair, collection, folder, environment, findItem, cloneWithNewIds, normalizeRequest } from '../src/core/model.js';
import {
  splitUrl, parseQueryString, paramsFromUrl, urlWithParams, pathVariableNames, syncPathVars, applyPathVars, withScheme, encodeUrlText, isPrivateHost,
} from '../src/core/url.js';
import { findVariables, interpolate, createResolver, DYNAMIC } from '../src/core/variables.js';
import { resolveRequest, effectiveAuth, authParts, autoHeaders, buildBody, graphqlJson, scriptChain } from '../src/core/prepare.js';
import { isSimpleRequest, canRetry, forbiddenHeaders, send, sendRelay, SendError, contentTypeOf } from '../src/core/send.js';
import { prettyJson, prettyJsonBody, prettyXml, prettyOrSame, languageFor, looksLikeText } from '../src/core/pretty.js';
import { tokenRequest } from '../src/core/oauth.js';

describe('url helpers', () => {
  it('splits base, query and hash', () => {
    expect(splitUrl('https://a.com/x?y=1&z#frag')).toEqual({ base: 'https://a.com/x', query: 'y=1&z', hash: '#frag' });
    expect(splitUrl('https://a.com/x')).toEqual({ base: 'https://a.com/x', query: null, hash: '' });
  });

  it('keeps query values as written', () => {
    expect(parseQueryString('a=1&b=%20x&c&d=')).toEqual([
      { key: 'a', value: '1', hasValue: true },
      { key: 'b', value: '%20x', hasValue: true },
      { key: 'c', value: '', hasValue: false },
      { key: 'd', value: '', hasValue: true },
    ]);
  });

  it('syncs params from the URL, reusing ids and keeping disabled rows', () => {
    const prev = [pair('a', '1'), pair('off', 'x', { enabled: false }), pair('b', '2')];
    const rows = paramsFromUrl('https://h/p?a=9&b=2&c=3', prev);
    expect(rows.map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['a', '9', true],
      ['off', 'x', false],
      ['b', '2', true],
      ['c', '3', true],
    ]);
    expect(rows[0].id).toBe(prev[0].id);
    expect(rows[2].id).toBe(prev[2].id);
  });

  it('rewrites the URL from enabled params', () => {
    const url = urlWithParams('https://h/p?old=1#top', [pair('a', '{{v}}'), pair('b', '2', { enabled: false }), pair('c', '')]);
    expect(url).toBe('https://h/p?a={{v}}&c=#top');
    expect(urlWithParams('https://h/p?x=1', [])).toBe('https://h/p');
    expect(urlWithParams('https://h/p', [pair('q', 'a&b=c#d'), pair('k=1', '{{v}}')])).toBe('https://h/p?q=a%26b=c%23d&k%3D1={{v}}');
    expect(urlWithParams('https://h/p?flag&b=1', [pair('flag', ''), pair('b', '2'), pair('c', '')])).toBe('https://h/p?flag&b=2&c=');
  });

  it('finds and applies path variables', () => {
    expect(pathVariableNames('https://h:8080/users/:id/posts/:postId?x=:no')).toEqual(['id', 'postId']);
    expect(pathVariableNames('{{base}}/a/:id')).toEqual(['id']);
    const vars = syncPathVars('https://h/u/:id', [pair('id', '7'), pair('gone', '1')]);
    expect(vars.map((v) => [v.key, v.value])).toEqual([['id', '7']]);
    // Typing past a name and backspacing keeps its value, as long as the old name is gone from the URL.
    const typed = syncPathVars('https://h/u/:idx', [pair('id', '42')], { renamed: true });
    expect(typed.map((v) => [v.key, v.value])).toEqual([['idx', '42']]);
    expect(syncPathVars('https://h/u/:id', typed, { renamed: true }).map((v) => [v.key, v.value, v.id])).toEqual([['id', '42', typed[0].id]]);
    expect(syncPathVars('https://h/u/:new/:id', [pair('id', '7')], { renamed: true }).map((v) => [v.key, v.value])).toEqual([['new', ''], ['id', '7']]);
    // A different URL pasted over it does not inherit the old value.
    expect(syncPathVars('https://h/orgs/:orgId', [pair('id', '5')], { renamed: true }).map((v) => [v.key, v.value])).toEqual([['orgId', '']]);
    expect(applyPathVars('https://h/u/:id/x?q=:id', new Map([['id', 'a b']]))).toBe('https://h/u/a%20b/x?q=:id');
  });

  it('adds a scheme and encodes unsafe characters only', () => {
    expect(withScheme('example.com/x')).toBe('https://example.com/x');
    expect(withScheme('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(withScheme('127.0.0.1/x')).toBe('http://127.0.0.1/x');
    // Private network addresses use http, as WebSocket URLs use ws.
    expect(withScheme('192.168.1.20:8080/api')).toBe('http://192.168.1.20:8080/api');
    expect(withScheme('10.0.0.5/x')).toBe('http://10.0.0.5/x');
    expect(withScheme('172.16.0.1?a=1')).toBe('http://172.16.0.1?a=1');
    expect(withScheme('[::1]:3000')).toBe('http://[::1]:3000');
    expect(withScheme('printer.local/status')).toBe('http://printer.local/status');
    expect(withScheme('172.32.0.1/x')).toBe('https://172.32.0.1/x');
    expect(withScheme('localhost.example.com/x')).toBe('https://localhost.example.com/x');
    expect(withScheme('http://a.com')).toBe('http://a.com');
    expect(encodeUrlText('https://a.com/a b?q=1 2&r=%20&s=100%')).toBe('https://a.com/a%20b?q=1%202&r=%20&s=100%25');
    expect(encodeUrlText('https://a.com/?q=😀')).toBe('https://a.com/?q=%F0%9F%98%80');
  });

  it('recognizes private hosts', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.1.1', 'printer.local', '[::1]']) expect(isPrivateHost(host)).toBe(true);
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', 'fda.gov', 'fcm.googleapis.com']) expect(isPrivateHost(host)).toBe(false);
    expect(isPrivateHost('[fd00::1]')).toBe(true);
  });
});

describe('variables', () => {
  it('stops self-referencing values from growing without bound', () => {
    const a = '{{a}}'.repeat(45);
    expect(() => interpolate('{{a}}', (n) => (n === 'a' ? a : null))).not.toThrow();
  });

  it('ignores disabled array entries and reads plain objects', () => {
    const r = createResolver([{ name: 'environment', vars: [{ key: 'a', value: '1' }, { key: 'b', value: '2', enabled: false }] }, { name: 'x', vars: { x: 'X' } }]);
    expect(r.resolve('{{0}}|{{1}}|{{b}}|{{x}}')).toBe('{{0}}|{{1}}|{{b}}|X');
  });

  it('finds variables with positions', () => {
    expect(findVariables('a {{x}} b {{ y.z }}')).toEqual([
      { name: 'x', start: 2, end: 7 },
      { name: 'y.z', start: 10, end: 19 },
    ]);
    expect(findVariables('no vars')).toEqual([]);
  });

  it('interpolates nested values and stops on cycles', () => {
    const vals = { a: '{{b}}!', b: 'B', loop: '{{loop}}' };
    expect(interpolate('{{a}} {{missing}}', (n) => vals[n])).toBe('B! {{missing}}');
    expect(interpolate('{{loop}}', (n) => vals[n])).toBe('{{loop}}');
  });

  it('resolves narrowest scope first and generates dynamic values once', () => {
    const r = createResolver([
      { name: 'local', vars: new Map([['x', 'local']]) },
      { name: 'environment', vars: [{ key: 'x', value: 'env', enabled: true }, { key: 'y', value: 'env-y', enabled: true }, { key: 'off', value: 'z', enabled: false }] },
      { name: 'globals', vars: [{ key: 'z', value: 'g', enabled: true }] },
    ]);
    expect(r.get('x')).toEqual({ value: 'local', scope: 'local' });
    expect(r.get('y').scope).toBe('environment');
    expect(r.get('off')).toBeNull();
    expect(r.resolve('{{x}}-{{z}}')).toBe('local-g');
    const id = r.resolve('{{$uuid}}');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.resolve('{{$uuid}}')).toBe(id);
    for (const [name, d] of Object.entries(DYNAMIC)) expect(typeof d.generate(), name).toBe('string');
  });
});

describe('model', () => {
  it('normalizes partial data into complete requests', () => {
    const r = normalizeRequest({ method: 'post', body: { mode: 'raw', raw: '{}', rawType: 'nope' }, headers: [{ key: 'A', value: 1 }] });
    expect(r.method).toBe('POST');
    expect(r.body.rawType).toBe('json');
    expect(r.headers[0]).toMatchObject({ key: 'A', value: '1', enabled: true });
    expect(r.auth.type).toBe('inherit');
  });

  it('finds items and clones with new ids', () => {
    const req = request({ name: 'R' });
    const f = folder({ name: 'F', items: [req] });
    const c = collection({ items: [f] });
    const found = findItem(c, req.id);
    expect(found.parent.id).toBe(f.id);
    expect(found.parents.map((p) => p.id)).toEqual([c.id, f.id]);
    const copy = cloneWithNewIds(f);
    expect(copy.id).not.toBe(f.id);
    expect(copy.items[0].id).not.toBe(req.id);
    expect(copy.items[0].name).toBe('R');
  });
});

describe('prepare', () => {
  const resolverFor = (vars) => createResolver([{ name: 'environment', vars: Object.entries(vars).map(([key, value]) => ({ key, value, enabled: true })) }]);

  it('resolves variables, path variables, auth and default headers', () => {
    const r = request({
      method: 'post',
      url: '{{base}}/users/:id?verbose={{flag}}',
      pathVars: [pair('id', '{{uid}}')],
      headers: [pair('X-Trace', '{{trace}}'), pair('Off', 'x', { enabled: false })],
      body: { mode: 'raw', raw: '{"name":"{{name}}"}', rawType: 'json' },
      auth: { type: 'bearer', bearer: { token: '{{token}}' } },
    });
    const { resolved, warnings } = resolveRequest(r, { resolver: resolverFor({ base: 'api.example.com', uid: '42', flag: 'true', trace: 't1', name: 'Ada', token: 'abc' }) });
    expect(resolved.url).toBe('https://api.example.com/users/42?verbose=true');
    expect(resolved.method).toBe('POST');
    expect(resolved.headers).toEqual([
      { key: 'X-Trace', value: 't1' },
      { key: 'Authorization', value: 'Bearer abc', auto: true, credential: true },
      { key: 'Content-Type', value: 'application/json', auto: true },
      { key: 'Accept', value: '*/*', auto: true },
    ]);
    expect(resolved.body).toEqual({ mode: 'raw', text: '{"name":"Ada"}', contentType: 'application/json' });
    expect(warnings).toEqual([]);
  });

  it('inherits auth from the nearest parent and lets explicit headers win', () => {
    const req = request({ url: 'https://h/x', headers: [pair('authorization', 'Custom 1')] });
    const f = folder({ auth: { type: 'inherit' } });
    const c = collection({ auth: { type: 'basic', basic: { username: 'ü', password: 'p' } } });
    expect(effectiveAuth(req, [c, f]).source).toBe(c);
    const { resolved } = resolveRequest(req, { parents: [c, f] });
    expect(resolved.headers.filter((h) => h.key.toLowerCase() === 'authorization')).toEqual([{ key: 'authorization', value: 'Custom 1' }]);
    expect(authParts(c.auth).headers[0].value).toBe(`Basic ${btoa(String.fromCharCode(...new TextEncoder().encode('ü:p')))}`);
  });

  it('puts API keys in the query when asked and warns about unresolved variables', () => {
    const req = request({ url: 'https://h/x?a=1', headers: [pair('X', '{{nope}}')], auth: { type: 'apikey', apikey: { key: 'k', value: 'v w', in: 'query' } } });
    const { resolved, warnings } = resolveRequest(req, {});
    expect(resolved.url).toBe('https://h/x?a=1&k=v%20w');
    expect(warnings[0]).toMatch(/Unresolved variable: nope/);
  });

  it('warns about unresolved variables that end up encoded in the URL or auth', () => {
    const warned = (r) => resolveRequest(request(r), {}).warnings.join(' ');
    expect(warned({ url: 'https://h/{{version}}/items' })).toMatch(/Unresolved variable: version/);
    expect(warned({ url: 'https://h/users/:id', pathVars: [pair('id', '{{userId}}')] })).toMatch(/Unresolved variable: userId/);
    expect(warned({ url: 'https://h', auth: { type: 'basic', basic: { username: '{{user}}', password: '{{pass}}' } } })).toMatch(/Unresolved variables: user, pass/);
    expect(warned({ url: 'https://h', auth: { type: 'apikey', apikey: { key: 'api_key', value: '{{apiKey}}', in: 'query' } } })).toMatch(/Unresolved variable: apiKey/);
    // Only what is sent counts: the fragment never leaves the browser.
    expect(warned({ url: 'https://h/x#{{section}}' })).toBe('');
  });

  it('keeps a # from a variable value in the path or query instead of starting a fragment', () => {
    const url = (u, vars) => resolveRequest(request({ url: u }), { resolver: resolverFor(vars) }).resolved.url;
    expect(url('https://api.test/items?color={{c}}&page=2', { c: '#ff0000' })).toBe('https://api.test/items?color=%23ff0000&page=2');
    expect(url('https://api.test/tags/{{tag}}/items', { tag: 'c#' })).toBe('https://api.test/tags/c%23/items');
    expect(url('https://api.test/{{p}}', { p: '{{tag}}', tag: '#x' })).toBe('https://api.test/%23x');
    // A # typed in the URL still starts the fragment, which is not sent.
    expect(url('https://api.test/x?a={{a}}#{{frag}}', { a: '1', frag: 'top' })).toBe('https://api.test/x?a=1');
    // A variable that starts the URL may hold a whole URL, fragment and all.
    expect(url('{{link}}', { link: 'https://api.test/page?a=1#section' })).toBe('https://api.test/page?a=1');
    // Code snippets pass a resolver with only resolve().
    const { resolve } = resolverFor({ c: '#ff0000' });
    expect(resolveRequest(request({ url: 'https://api.test/items?color={{c}}&page=2&x={{none}}' }), { resolver: { resolve } }).resolved.url).toBe('https://api.test/items?color=%23ff0000&page=2&x=%7B%7Bnone%7D%7D');
  });

  it('sends user:password in the URL as Basic auth, since fetch refuses such URLs', () => {
    const auth = (r) => resolveRequest(request(r), {}).resolved;
    const plain = auth({ url: 'https://user:p%40ss@example.com/private?x=1' });
    expect(plain.url).toBe('https://example.com/private?x=1');
    expect(plain.headers.find((h) => h.key === 'Authorization').value).toBe(`Basic ${btoa('user:p@ss')}`);
    // The auth tab and a typed header win over the URL.
    const bearer = auth({ url: 'https://u:p@example.com', auth: { type: 'bearer', bearer: { token: 't' } } });
    expect(bearer.url).toBe('https://example.com');
    expect(bearer.headers.filter((h) => h.key.toLowerCase() === 'authorization')).toEqual([{ key: 'Authorization', value: 'Bearer t', auto: true, credential: true }]);
    const typed = auth({ url: 'https://u:p@example.com', headers: [pair('authorization', 'Custom 1')] });
    expect(typed.headers.filter((h) => h.key.toLowerCase() === 'authorization')).toEqual([{ key: 'authorization', value: 'Custom 1' }]);
    // An @ in the query is not userinfo.
    expect(auth({ url: 'https://example.com/a?email=a@b.c' }).url).toBe('https://example.com/a?email=a@b.c');
  });

  it('drops bodies on GET and HEAD with a warning', () => {
    const req = request({ method: 'GET', url: 'https://h', body: { mode: 'raw', raw: 'x', rawType: 'text' } });
    const { resolved, warnings } = resolveRequest(req, {});
    expect(resolved.body).toBeNull();
    expect(warnings[0]).toMatch(/without a body/);
  });

  it('does not warn about a GET body that is empty', () => {
    const warned = (body) => resolveRequest(request({ method: 'GET', url: 'https://h', body }), {}).warnings;
    expect(warned({ mode: 'urlencoded', urlencoded: [] })).toEqual([]);
    expect(warned({ mode: 'form', form: [pair('a', '1', { enabled: false })] })).toEqual([]);
    expect(warned({ mode: 'graphql', graphql: { query: '  ', variables: '' } })).toEqual([]);
    expect(warned({ mode: 'urlencoded', urlencoded: [pair('a', '1')] })[0]).toMatch(/without a body/);
  });

  it('lists automatic headers for display', () => {
    const req = request({ method: 'POST', body: { mode: 'urlencoded', urlencoded: [pair('a', '1')] }, auth: { type: 'bearer', bearer: { token: 't' } } });
    expect(autoHeaders(req).map((h) => h.key)).toEqual(['Authorization', 'Content-Type', 'Accept', 'User-Agent']);
    const get = request({ method: 'GET', body: { mode: 'raw', raw: '{}', rawType: 'json' } });
    expect(autoHeaders(get).map((h) => h.key)).toEqual(['Accept', 'User-Agent']);
    const empty = request({ method: 'POST', body: { mode: 'raw', raw: '', rawType: 'json' } });
    expect(autoHeaders(empty).map((h) => h.key)).toEqual(['Accept', 'User-Agent']);
  });

  it('builds fetch bodies', async () => {
    expect(buildBody({ mode: 'urlencoded', fields: [{ key: 'a b', value: 'c&d' }] }).toString()).toBe('a+b=c%26d');
    const fd = buildBody({ mode: 'form', fields: [{ key: 't', value: 'v', kind: 'text' }, { key: 'f', kind: 'file', fileRef: 'r1', fileName: 'x.txt' }] }, new Map([['r1', new Blob(['hi'])]]));
    expect(fd.get('t')).toBe('v');
    expect(fd.get('f').name).toBe('x.txt');
    expect(() => buildBody({ mode: 'binary', fileRef: 'missing' })).toThrow(/Choose the file/);
    expect(graphqlJson({ query: 'q', variables: '{"a":1}' })).toBe('{"query":"q","variables":{"a":1}}');
    expect(() => graphqlJson({ query: 'q', variables: '{' })).toThrow(/not valid JSON/);
  });

  it('orders scripts from the outside in', () => {
    const req = request({ name: 'R', scripts: { pre: 'r', post: '' } });
    const c = collection({ name: 'C', scripts: { pre: 'c', post: 'cp' } });
    const f = folder({ name: 'F', scripts: { pre: '  ', post: 'fp' } });
    expect(scriptChain(req, [c, f], 'pre').map((s) => s.code)).toEqual(['c', 'r']);
    expect(scriptChain(req, [c, f], 'post').map((s) => s.source)).toEqual(['C', 'F']);
  });
});

describe('transport choice', () => {
  const resolved = (method, headers = [], url = 'https://api.example.com/x') => ({ method, url, headers: headers.map(([key, value]) => ({ key, value })), body: null });

  afterEach(() => vi.unstubAllGlobals());

  it('knows which requests skip the CORS preflight', () => {
    expect(isSimpleRequest(resolved('GET', [['Accept', '*/*']]))).toBe(true);
    expect(isSimpleRequest(resolved('POST', [['Content-Type', 'text/plain;charset=utf-8']]))).toBe(true);
    expect(isSimpleRequest(resolved('POST', [['Content-Type', 'application/json']]))).toBe(false);
    expect(isSimpleRequest(resolved('PUT'))).toBe(false);
    expect(isSimpleRequest(resolved('GET', [['Authorization', 'x']]))).toBe(false);
    expect(canRetry(resolved('POST', [['Content-Type', 'text/plain']]))).toBe(false);
    expect(canRetry(resolved('POST', [['Content-Type', 'application/json']]))).toBe(false);
    expect(canRetry(resolved('GET'))).toBe(true);
    expect(forbiddenHeaders([{ key: 'Cookie' }, { key: 'X-Ok' }, { key: 'Sec-Fetch-Mode' }])).toEqual(['Cookie', 'Sec-Fetch-Mode']);
  });

  it('sends with fetch and reports the response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json' } })));
    const res = await send(resolved('GET'), { mode: 'browser' });
    expect(res.status).toBe(201);
    expect(res.transport).toBe('browser');
    expect(new TextDecoder().decode(res.body)).toBe('{"ok":true}');
    expect(contentTypeOf(res.headers)).toBe('application/json');
  });

  /** A socket that answers each request with `reply`, or fails with `error` before opening. */
  const fakeSocket = ({ reply = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok', error = null } = {}) =>
    vi.fn(() => {
      const handlers = {};
      setTimeout(() => (error ? handlers.error?.(new Error(error)) : handlers.open?.()), 0);
      return {
        on: (e, fn) => (handlers[e] = fn),
        write: () => setTimeout(() => handlers.data?.(new TextEncoder().encode(reply)), 0),
        close() {},
      };
    });

  it('sends through the relay first when signed in', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const openSocket = fakeSocket();
    const res = await send(resolved('POST', [['Content-Type', 'application/json']]), { mode: 'auto', relay: { openSocket } });
    expect(res.transport).toBe('relay');
    expect(res.status).toBe(200);
    expect(openSocket).toHaveBeenCalledWith('api.example.com', 443, true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends from the browser when the relay could not connect, since nothing was sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    const res = await send(resolved('POST'), { mode: 'auto', relay: { openSocket: fakeSocket({ error: 'relay is down' }) } });
    expect(res.transport).toBe('browser');
    expect(res.warnings[0]).toMatch(/could not connect.*relay is down/);
  });

  it('does not repeat a request through the browser once the relay connected', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const openSocket = fakeSocket({ reply: 'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort' });
    // The socket closes before the body ends.
    const broken = vi.fn((...a) => {
      const s = openSocket(...a);
      const on = s.on;
      let close;
      s.on = (e, fn) => (e === 'close' ? (close = fn) : on(e, e === 'data' ? (d) => (fn(d), setTimeout(() => close?.(true), 0)) : fn));
      return s;
    });
    await expect(send(resolved('POST'), { mode: 'auto', relay: { openSocket: broken } })).rejects.toMatchObject({ transport: 'relay', code: 'network' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks to sign in again when the Puter session expired', async () => {
    const openSocket = fakeSocket({ error: 'Failed to create relay token (HTTP 401 Unauthorized).' });
    await expect(send(resolved('GET'), { mode: 'relay', relay: { openSocket } })).rejects.toMatchObject({ code: 'signed-out', message: 'Your Puter session has expired.' });
    // Automatic mode still tries the browser, and reports the expired session when that fails too.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(send(resolved('GET'), { mode: 'auto', relay: { openSocket } })).rejects.toMatchObject({ code: 'signed-out' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    const res = await send(resolved('GET'), { mode: 'auto', relay: { openSocket } });
    expect(res.transport).toBe('browser');
    expect(res.warnings[0]).toMatch(/session has expired/);
  });

  it('asks to sign in when signed out and the browser is blocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const get = send(resolved('GET'), { mode: 'auto', relay: null });
    await expect(get).rejects.toMatchObject({ code: 'cors', hint: expect.stringMatching(/Sign in to Puter/) });
    await expect(get).rejects.not.toMatchObject({ hint: expect.stringMatching(/already have reached/) });
    // A POST may have reached the server even though its response was blocked.
    await expect(send(resolved('POST'), { mode: 'auto', relay: null })).rejects.toMatchObject({ hint: expect.stringMatching(/already have reached the server/) });
    await expect(send(resolved('GET'), { mode: 'relay', relay: null })).rejects.toMatchObject({ code: 'signed-out', transport: 'relay' });
  });

  it('does not use the relay for local servers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const relay = { openSocket: vi.fn() };
    await expect(send(resolved('GET', [], 'http://localhost:3000/x'), { mode: 'auto', relay })).rejects.toMatchObject({ code: 'network' });
    expect(relay.openSocket).not.toHaveBeenCalled();
  });

  it('does not time out at once when the timeout is too long for a timer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      await new Promise((r) => setTimeout(r, 20));
      if (opts.signal?.aborted) throw opts.signal.reason;
      return new Response('ok');
    }));
    for (const timeoutMs of [2 ** 31, 1e12, Infinity]) expect((await send(resolved('GET'), { mode: 'browser', timeoutMs })).status).toBe(200);
  });

  it('never sends a request cancelled before it started, even with a timeout', async () => {
    const fetch = vi.fn(async (url, opts) => {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetch);
    const ctl = new AbortController();
    ctl.abort();
    await expect(send(resolved('POST'), { mode: 'browser', signal: ctl.signal, timeoutMs: 5000 })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('counts redirects in the total time of a relay request', async () => {
    let hop = 0;
    const openSocket = () => {
      const handlers = {};
      const n = hop++;
      setTimeout(() => handlers.open?.(), 0);
      return {
        on: (e, fn) => (handlers[e] = fn),
        write() {
          const reply = n === 0 ? 'HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n' : 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n';
          setTimeout(() => handlers.data?.(new TextEncoder().encode(reply)), n === 0 ? 80 : 0);
        },
        close() {},
      };
    };
    const res = await sendRelay({ method: 'GET', url: 'http://example.com/start', headers: [], body: null }, { openSocket });
    expect(res.status).toBe(200);
    expect(res.redirects).toHaveLength(1);
    expect(res.timings.total).toBeGreaterThanOrEqual(70);
  });

  it('keeps API key and AWS signature headers from auth on the same origin but not across a relay redirect', async () => {
    const { signResolved } = await import('../src/core/prepare.js');
    const sendThrough = async (r) => {
      const sent = [];
      const openSocket = (host) => {
        const handlers = {};
        setTimeout(() => handlers.open?.(), 0);
        return {
          on: (e, fn) => (handlers[e] = fn),
          write(data) {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const path = text.split(' ')[1];
            sent.push({ url: `${host}${path}`, headers: text.split('\r\n\r\n')[0].toLowerCase() });
            const location = { '/a': '/b', '/b': 'http://evil.test/c' }[path];
            const reply = location ? `HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n` : 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n';
            setTimeout(() => handlers.data?.(new TextEncoder().encode(reply)), 0);
          },
          close() {},
        };
      };
      const { resolved } = resolveRequest(r);
      await sendRelay(await signResolved(resolved, new Map()), { openSocket });
      return sent;
    };
    const apikey = await sendThrough(request({ url: 'http://api.test/a', headers: [pair('X-Trace', '1')], auth: { type: 'apikey', apikey: { key: 'X-Api-Key', value: 'k1', in: 'header' } } }));
    expect(apikey.map((s) => s.url)).toEqual(['api.test/a', 'api.test/b', 'evil.test/c']);
    expect(apikey[1].headers).toContain('x-api-key: k1');
    expect(apikey[2].headers).not.toContain('x-api-key');
    expect(apikey[2].headers).toContain('x-trace: 1');
    const aws = await sendThrough(request({ url: 'http://api.test/a', auth: { type: 'awsv4', awsv4: { accessKey: 'AK', secretKey: 'SK', sessionToken: 'TOKEN', region: 'us-east-1', service: 's3' } } }));
    expect(aws[1].headers).toContain('x-amz-security-token: token');
    expect(aws[2].headers).not.toMatch(/x-amz-|authorization/);
  });

  it('sends multipart through the relay with the boundary of the body it built', async () => {
    let sent = '';
    const openSocket = () => {
      const handlers = {};
      setTimeout(() => handlers.open?.(), 0);
      return {
        on: (e, fn) => (handlers[e] = fn),
        write(data) {
          sent += typeof data === 'string' ? data : new TextDecoder().decode(data);
          if (sent.includes('--\r\n')) setTimeout(() => {
            handlers.data?.(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
          }, 0);
        },
        close() {},
      };
    };
    const r = { method: 'POST', url: 'http://example.com/up', headers: [{ key: 'Content-Type', value: 'multipart/form-data; boundary=OLD' }], body: { mode: 'form', fields: [{ key: 'a', value: '1' }] } };
    await sendRelay(r, { openSocket, files: new Map() });
    const boundary = sent.match(/content-type: multipart\/form-data; boundary=(\S+)/i)[1];
    expect(boundary).not.toBe('OLD');
    expect(sent).toContain(`--${boundary}`);
  });

  it('warns when a relay response body cannot be decoded', async () => {
    const openSocket = () => {
      const handlers = {};
      setTimeout(() => handlers.open?.(), 0);
      return {
        on: (e, fn) => (handlers[e] = fn),
        write() {
          setTimeout(() => handlers.data?.(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 8\r\n\r\nnot gzip')), 0);
        },
        close() {},
      };
    };
    const res = await sendRelay({ method: 'GET', url: 'http://example.com/', headers: [], body: null }, { openSocket });
    expect(new TextDecoder().decode(res.body)).toBe('not gzip');
    expect(res.warnings).toEqual(['The response is marked gzip-encoded but could not be decoded, so it is shown as received.']);
  });

  it('applies one relay timeout across redirects', async () => {
    let n = 0;
    const openSocket = () => {
      const handlers = {};
      const hop = n++;
      setTimeout(() => handlers.open?.(), 0);
      return {
        on: (e, fn) => (handlers[e] = fn),
        write() {
          setTimeout(() => handlers.data?.(new TextEncoder().encode(`HTTP/1.1 302 Found\r\nLocation: /r${hop}\r\nContent-Length: 0\r\n\r\n`)), 40);
        },
        close() {},
      };
    };
    const started = Date.now();
    await expect(sendRelay({ method: 'GET', url: 'http://example.com/', headers: [], body: null }, { openSocket, timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('rejects invalid URLs clearly', async () => {
    await expect(send(resolved('GET', [], 'not a url'), {})).rejects.toMatchObject({ code: 'bad-url' });
  });
});

describe('pretty printers', () => {
  it('re-indents JSON without losing number precision', () => {
    const text = '{"big":12345678901234567890,"a":[1,{"b":"x,y:{z}"}],"e":{},"f":[]}';
    expect(prettyJson(text)).toBe(['{', '  "big": 12345678901234567890,', '  "a": [', '    1,', '    {', '      "b": "x,y:{z}"', '    }', '  ],', '  "e": {},', '  "f": []', '}'].join('\n'));
    expect(prettyJson('plain text')).toBe('plain text');
    expect(prettyJson('{"s":"quote \\" inside"}')).toBe('{\n  "s": "quote \\" inside"\n}');
  });

  it('keeps each record of newline-delimited JSON on its own lines', () => {
    expect(prettyOrSame('{"a":1}\n{"b":2}\n', 'json')).toBe('{\n  "a": 1\n}\n{\n  "b": 2\n}');
    expect(prettyJson('[1] {"big":12345678901234567890} {} "s" 5 [2]')).toBe('[\n  1\n]\n{\n  "big": 12345678901234567890\n}\n{}\n"s"\n5\n[\n  2\n]');
    expect(prettyJson('{"a":1},{"b":2}')).toBe('{\n  "a": 1\n},\n{\n  "b": 2\n}');
  });

  it('leaves text with bare words alone instead of stripping its spaces', () => {
    expect(prettyJson('[INFO] server started on port 80, ready: yes')).toBe('[INFO] server started on port 80, ready: yes');
    expect(prettyJson('{"a": tru e}')).toBe('{"a": tru e}');
    expect(prettyJson('{"a": {{num}}}')).toBe('{"a": {{num}}}');
    expect(prettyJson('[true,null,-1.5e+3,NaN]')).toBe('[\n  true,\n  null,\n  -1.5e+3,\n  NaN\n]');
  });

  it('formats JSON bodies with {{variables}} and rejects invalid ones', () => {
    expect(prettyJsonBody('{"a": {{num}}, "t":"Bearer {{token}}"}')).toBe('{\n  "a": {{num}},\n  "t": "Bearer {{token}}"\n}');
    expect(() => prettyJsonBody('{"a": tru e, "b": {{v}}}')).toThrow(SyntaxError);
  });

  it('shows JSON nested too deep to format as it is', () => {
    const deep = `${'['.repeat(20000)}1${']'.repeat(20000)}`;
    expect(prettyOrSame(deep, 'json')).toBe(deep);
  });

  it('shows deeply nested JSON and XML as they are when indenting would blow up their size', () => {
    // 6 KB of nesting would indent to about 18 MB; a deeper one would run out of memory.
    const json = `${'['.repeat(3000)}1${']'.repeat(3000)}`;
    expect(prettyJson(json)).toBe(json);
    const xml = '<a>'.repeat(3000);
    expect(prettyXml(xml)).toBe(xml);
    // Ordinary nesting is still indented.
    expect(prettyJson(`${'['.repeat(50)}1${']'.repeat(50)}`).split('\n')).toHaveLength(101);
    expect(prettyXml('<a>'.repeat(50)).split('\n')).toHaveLength(50);
  });

  it('keeps whitespace inside CDATA when indenting XML', () => {
    expect(prettyXml('<r><![CDATA[x  <b> </b> y]]></r>')).toBe('<r>\n  <![CDATA[x  <b> </b> y]]>\n</r>');
  });

  it('indents XML with unclosed comments and CDATA sections in linear time', () => {
    expect(prettyXml('<r><!-- a <b> --><![CDATA[<c>]]></r>')).toBe('<r>\n  <!-- a <b> -->\n  <![CDATA[<c>]]>\n</r>');
    expect(prettyXml('<r><!--a><b>x</b>')).toBe('<r>\n  <!--a>\n  <b>x</b>');
    expect(prettyXml('<r><![CDATA[a><b/>')).toBe('<r>\n  <![CDATA[a>\n  <b/>');
    for (const unit of ['<!--a>', '<![CDATA[a>']) {
      const text = unit.repeat(128000);
      const started = Date.now();
      prettyXml(text);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('keeps a ">" inside an attribute value', () => {
    expect(prettyXml('<r><a t="1>2"><b/></a></r>')).toBe('<r>\n  <a t="1>2">\n    <b/>\n  </a>\n</r>');
  });

  it('indents XML and keeps simple elements on one line', () => {
    expect(prettyXml('<a><b>text</b><c/><d x="1"><e>1</e></d></a>')).toBe(['<a>', '  <b>text</b>', '  <c/>', '  <d x="1">', '    <e>1</e>', '  </d>', '</a>'].join('\n'));
  });

  it('guesses languages and binary content', () => {
    expect(languageFor('application/problem+json')).toBe('json');
    expect(languageFor('', '<!DOCTYPE html><html>')).toBe('html');
    expect(languageFor('', ' [1]')).toBe('json');
    expect(looksLikeText(new TextEncoder().encode('hello'))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x89, 0x50, 0, 1]))).toBe(false);
  });
});

describe('oauth token request', () => {
  it('builds client credentials and password requests', () => {
    const cc = tokenRequest({ grantType: 'client_credentials', tokenUrl: 'https://a/t', clientId: 'id', clientSecret: 's', scope: 'r w', clientAuth: 'header' });
    expect(cc.body.fields).toEqual([{ key: 'grant_type', value: 'client_credentials' }, { key: 'scope', value: 'r w' }]);
    expect(cc.headers.find((h) => h.key === 'Authorization').value).toBe(`Basic ${btoa('id:s')}`);
    const pw = tokenRequest({ grantType: 'password', tokenUrl: 'https://a/t', clientId: 'id', clientSecret: '', username: 'u', password: 'p', clientAuth: 'body' });
    expect(pw.body.fields.map((f) => f.key)).toEqual(['grant_type', 'username', 'password', 'client_id']);
  });
});

describe('environment factory', () => {
  it('creates environments with timestamps', () => {
    const e = environment({ name: 'Dev' });
    expect(e.name).toBe('Dev');
    expect(e.createdAt).toBeGreaterThan(0);
  });
});

describe('display formatting', async () => {
  const { formatBytes, formatMs } = await import('../src/lib/format.js');
  it('rounds before picking a unit', () => {
    expect(formatBytes(1048575)).toBe('1.00 MB');
    expect(formatMs(999.6)).toBe('1.00 s');
    expect(formatMs(59999.6)).toBe('1 m 0 s');
    expect(formatMs(119600)).toBe('2 m 0 s');
    expect(formatMs(125000)).toBe('2 m 5 s');
  });
});

describe('response charsets', async () => {
  const { charsetOf } = await import('../src/core/send.js');
  const { decodeText } = await import('../src/core/pretty.js');
  it('decodes with the charset the server names', () => {
    const headers = [['Content-Type', 'text/plain; charset="ISO-8859-1"']];
    expect(charsetOf(headers)).toBe('iso-8859-1');
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), charsetOf(headers))).toBe('café');
    expect(decodeText(new TextEncoder().encode('café'), 'not-a-charset')).toBe('café');
  });
});

describe('draftKey', async () => {
  const { draftKey, sameDraft, normalizeDraft } = await import('../src/core/model.js');
  const big = (c, n = 5000) => c.repeat(n);
  const base = () => request({ id: 'r1', name: 'R', url: 'https://x.test', body: { mode: 'raw', rawType: 'json', raw: big('a') }, scripts: { pre: big('p'), post: 'short' } });

  it('tells drafts apart exactly when their JSON differs', () => {
    const variants = [
      (d) => d,
      (d) => { d.body.raw = big('a', 4999) + 'b'; },
      (d) => { d.body.raw += 'x'; },
      (d) => { d.body.raw = 'short'; },
      (d) => { d.scripts.pre = big('a'); d.body.raw = big('p'); }, // the two long strings swapped
      (d) => { d.scripts.post = big('p'); d.scripts.pre = 'short'; },
      (d) => { d.name = '\0' + '0'; },
      (d) => { d.name = '\0\0' + '0'; },
      (d) => { d.url = '\0' + '0'; d.body.raw = 'x'; }, // a short string that reads like a marker
      (d) => { d.url = '\0' + '1'; },
      (d) => { d.headers = [{ key: 'X', value: big('a') }]; },
      (d) => { d.headers = [{ key: 'X', value: '\0' + '0' }]; d.body.raw = big('a'); },
      (d) => { d.examples = [{ name: 'E', status: 200, body: big('a') }]; },
      (d) => { d.name = big('n'); },
    ];
    const drafts = variants.map((v) => {
      const d = base();
      v(d);
      return d;
    });
    for (const a of drafts) {
      for (const b of drafts) {
        const json = JSON.stringify(normalizeDraft(a)) === JSON.stringify(normalizeDraft(b));
        expect(sameDraft(draftKey(a), draftKey(b))).toBe(json);
      }
    }
  });

  it('keeps the normalized name', () => {
    expect(draftKey({ ...base(), name: 'Orders' }).name).toBe('Orders');
    expect(draftKey({ ...base(), name: big('n') }).name).toBe(big('n'));
  });

  it('works for WebSocket requests', async () => {
    const { websocketRequest } = await import('../src/core/websocket.js');
    const a = websocketRequest({ id: 'w', name: 'S', url: 'ws://x', messages: [{ id: 'm', name: 'M', body: big('m') }] });
    const b = structuredClone(a);
    expect(sameDraft(draftKey(a), draftKey(b))).toBe(true);
    b.messages[0].body += '!';
    expect(sameDraft(draftKey(a), draftKey(b))).toBe(false);
  });
});
