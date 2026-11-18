import { describe, it, expect, vi } from 'vitest';
import { ResponseView, filenameFrom } from '../src/ui/response-view.js';

if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
}

const enc = new TextEncoder();
const app = { session: { signedIn: false }, console: { setOpen() {} } };
const result = (body, ct) => ({ response: { status: 200, statusText: 'OK', headers: [['Content-Type', ct]], body, timeMs: 10, transport: 'browser', url: 'https://x.test/a' }, tests: [], warnings: [], error: null });
const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const view = () => {
  const v = new ResponseView(app, {});
  document.body.append(v.el);
  return v;
};
const filterTo = async (v, path) => {
  v.el.querySelector('[aria-label="Filter with a JSON path"]').click();
  const input = v.el.querySelector('.resp-filter input');
  input.value = path;
  input.dispatchEvent(new Event('input'));
};
const mode = (v, name) => [...v.el.querySelectorAll('[role=radio]')].find((b) => b.textContent === name);

describe('response view', () => {
  it('toggles the Timing popover from its button and closes it with Escape', async () => {
    const v = view();
    v.show(result(enc.encode('ok'), 'text/plain'));
    await wait();
    const btn = v.el.querySelector('button[title="Timing details"]');
    const open = () => document.querySelector('.popover[aria-label="Timing"]');
    btn.focus();
    btn.click();
    expect(open()).not.toBeNull();
    btn.click();
    expect(open()).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(open()).toBeNull();
    expect(document.activeElement).toBe(btn);
    v.el.remove();
  });

  it('decodes text with the charset the server names', async () => {
    const v = view();
    v.show(result(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset=iso-8859-1'));
    await wait();
    expect(v.editor.getValue()).toBe('café');
  });

  it('keeps large numbers exact in filter results', async () => {
    const v = view();
    v.show(result(enc.encode('{"id":12345678901234567890}'), 'application/json'));
    await wait();
    await filterTo(v, '$.id');
    // The filter is debounced and its module loads on first use, which can take a while on a busy machine.
    await vi.waitFor(() => expect(v.editor.getValue()).toBe('12345678901234567890'), { timeout: 5000 });
  });

  it('does not write a pending filter result into the Raw view', async () => {
    const v = view();
    v.show(result(enc.encode('{"a":{"b":1},"c":2}'), 'application/json'));
    await wait();
    await filterTo(v, '$.a');
    mode(v, 'Raw').click();
    await wait(300);
    expect(v.editor.getValue()).toBe('{"a":{"b":1},"c":2}');
  });

  it('copies what a filter shows and offers no copy for images', async () => {
    let copied = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } }, configurable: true });
    const v = view();
    v.show(result(enc.encode('{"a":1}'), 'application/json'));
    await wait();
    await filterTo(v, '$.nope');
    await wait(300);
    v.el.querySelector('[aria-label="Copy response body"]').click();
    await wait();
    expect(copied).toBeNull();
    v.show(result(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'image/png'));
    await wait();
    expect(v.el.querySelector('[aria-label="Copy response body"]')).toBeNull();
    v.el.querySelector('[aria-label="Response actions"]').click();
    [...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.includes('Copy body')).click();
    await wait();
    expect(copied).toBeNull();
  });

  it('does not let a binary response change the view for later ones', async () => {
    const v = view();
    const checked = () => [...v.el.querySelectorAll('[role=radio][aria-checked=true]')].map((b) => b.textContent);
    v.show(result(enc.encode('<html><body>a</body></html>'), 'text/html'));
    await wait();
    expect(checked()).toEqual(['Pretty']);
    v.show(result(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'image/png'));
    await wait();
    v.show(result(enc.encode('<html><body>b</body></html>'), 'text/html'));
    await wait();
    expect(checked()).toEqual(['Pretty']);
  });

  it('falls back to all tests when the Skipped filter has nothing to show', async () => {
    const v = view();
    const withTests = (tests) => ({ ...result(enc.encode('{}'), 'application/json'), tests });
    v.section = 'tests';
    v.testFilter = 'skipped';
    v.show(withTests([{ name: 'c', passed: true }, { name: 'd', passed: false, error: 'x' }]));
    await wait();
    expect(v.el.querySelectorAll('.test-list li')).toHaveLength(2);
    expect(v.el.querySelector('[aria-label="Show tests"] [aria-checked=true]').textContent).toBe('All 2');
  });

  it('forgets the stored response when cleared', async () => {
    const removed = [];
    const ws = { saveResponse: async (id, r) => removed.push([id, r]) };
    const v = new ResponseView({ ...app, ws }, { refId: 'r1' });
    document.body.append(v.el);
    v.tab.result = result(enc.encode('{}'), 'application/json');
    v.show(v.tab.result);
    v.el.querySelector('[aria-label="Response actions"]').click();
    [...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.includes('Clear response')).click();
    expect(removed).toEqual([['r1', null]]);
    expect(v.tab.result).toBeNull();
  });

  it('keeps counting from when a send started after the view is rebuilt', () => {
    const v = new ResponseView(app, { sendStarted: performance.now() - 5000 });
    v.setSending(true);
    expect(v.el.querySelector('.resp-elapsed').textContent).toMatch(/^5\.\d\d s$/);
    v.setSending(false);
  });

  it('resolves relative links in the HTML preview against the response URL', async () => {
    const v = view();
    v.show(result(enc.encode('<img src="/logo.png">'), 'text/html'));
    mode(v, 'Preview').click();
    expect(v.el.querySelector('iframe').getAttribute('srcdoc')).toBe('<base href="https://x.test/a"><img src="/logo.png">');
    v.show(result(enc.encode('<!DOCTYPE html>\n<html><body>x</body></html>'), 'text/html'));
    mode(v, 'Preview').click();
    expect(v.el.querySelector('iframe').getAttribute('srcdoc')).toBe('<!DOCTYPE html><base href="https://x.test/a">\n<html><body>x</body></html>');
  });

  it('does not offer the relay for a request that could not be prepared', async () => {
    // Signing fails before anything is sent, so the relay would fail the same way.
    const { execute } = await import('../src/core/execute.js');
    const { request } = await import('../src/core/model.js');
    const ws = { getCollection: () => null, getEnvironment: () => null, globals: { variables: [] }, filesFor: async () => new Map() };
    const req = request({ url: 'https://sqs.us-east-1.amazonaws.com/', auth: { type: 'awsv4', awsv4: { accessKey: '', secretKey: '', region: 'us-east-1' } } });
    const out = await execute(req, [], { ws, sendOptions: {} });
    expect(out.error).toMatchObject({ code: 'prepare', message: expect.stringMatching(/access key/) });
    const v = new ResponseView({ ...app, session: { signedIn: true } }, {});
    v.show({ ...out, tests: [] });
    expect(v.el.textContent).toMatch(/access key/);
    expect(v.el.textContent).not.toMatch(/relay/i);
    expect(v.el.textContent).toContain('Try again');
  });

  it('offers to sign in and send when the request needs the Puter relay', () => {
    const onSignInSend = vi.fn();
    const signedOut = { ...app, session: { signedIn: false, puter: {} } };
    const failed = (error) => ({ response: null, tests: [], warnings: [], error, resolved: { method: 'GET', url: 'https://example.com/' } });
    const button = (v) => [...v.el.querySelectorAll('button')].find((b) => b.textContent === 'Sign in and send');
    const blocked = new ResponseView(signedOut, {}, { onSignInSend });
    blocked.show(failed({ code: 'cors', transport: 'browser', message: 'Could not get a response.' }));
    button(blocked).click();
    expect(onSignInSend).toHaveBeenLastCalledWith('relay');
    // An expired session in Automatic mode resends as Automatic, which uses the relay once signed in.
    const expired = new ResponseView({ ...app, session: { signedIn: true, puter: {} } }, {}, { onSignInSend });
    expired.show(failed({ code: 'signed-out', transport: 'relay', message: 'Your Puter session has expired.' }));
    button(expired).click();
    expect(onSignInSend).toHaveBeenLastCalledWith('relay');
    // Without Puter.js there is nobody to sign in to.
    const offline = new ResponseView({ ...app, session: { signedIn: false, puter: null } }, {}, { onSignInSend });
    offline.show(failed({ code: 'cors', transport: 'browser', message: 'Could not get a response.' }));
    expect(button(offline)).toBeUndefined();
  });

  it('decodes HTML and XML with the charset they declare when the server names none', async () => {
    const latin1 = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    const v = view();
    v.show(result(latin1('<html><head><meta charset="windows-1252"></head><body>caf\xe9</body></html>'), 'text/html'));
    await wait();
    expect(v.editor.getValue()).toContain('café');
    mode(v, 'Raw').click();
    await wait();
    expect(v.editor.getValue()).toContain('café');
    mode(v, 'Preview').click();
    expect(v.el.querySelector('iframe').getAttribute('srcdoc')).toContain('café');
    v.mode = 'pretty';
    v.show(result(latin1('<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"></head>caf\xe9</html>'), 'text/html'));
    await wait();
    expect(v.editor.getValue()).toContain('café');
    v.show(result(latin1('<?xml version="1.0" encoding="ISO-8859-1"?><a>caf\xe9</a>'), 'application/xml'));
    await wait();
    expect(v.editor.getValue()).toContain('<a>café</a>');
    v.show(result(new Uint8Array([0xff, 0xfe, ...[...'<p>café</p>'].flatMap((c) => [c.charCodeAt(0), 0])]), 'text/html'));
    await wait();
    expect(v.editor.getValue()).toBe('<p>café</p>');
    // The charset the server names wins, and JSON is always UTF-8 whatever its strings hold.
    v.show(result(enc.encode('<meta charset="windows-1252">café'), 'text/html; charset=utf-8'));
    await wait();
    expect(v.editor.getValue()).toBe('<meta charset="windows-1252">café');
    v.show(result(enc.encode('{"html":"<meta charset=\\"windows-1252\\">café"}'), 'application/json'));
    await wait();
    expect(v.editor.getValue()).toContain('café');
    v.el.remove();
  });

  it('shows a CSS response as Text in Format as, so JSON can be picked', async () => {
    const v = view();
    v.show(result(enc.encode('{"a":1}'), 'text/css'));
    await wait();
    const select = v.el.querySelector('select[aria-label="Format as"]');
    expect(select.value).toBe('text');
    select.value = 'json';
    select.dispatchEvent(new Event('change'));
    await wait();
    expect(v.editor.getValue()).toBe('{\n  "a": 1\n}');
    v.el.remove();
  });

  it('prefers the filename* form of Content-Disposition', () => {
    expect(filenameFrom(`attachment; filename="plain.txt"; filename*=UTF-8''na%C3%AFve%20file.txt`)).toBe('naïve file.txt');
    expect(filenameFrom(`attachment; filename*=utf-8'en'x.txt`)).toBe('x.txt');
    expect(filenameFrom('attachment; filename=report%20x.csv')).toBe('report x.csv');
    expect(filenameFrom('attachment')).toBe('');
  });
});
