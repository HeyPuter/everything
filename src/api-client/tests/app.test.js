import { it, expect, beforeEach, vi } from 'vitest';
import { Workspace } from '../src/data/workspace.js';
import { MemoryDb } from './helpers/memory-db.js';
import { App } from '../src/ui/app.js';
import { fakeLoader } from './helpers/fake-loader.js';

if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
}

async function makeApp({ ws = null, session = { signedIn: false, puter: null }, onSignIn = async () => {} } = {}) {
  if (!ws) {
    ws = new Workspace(new MemoryDb());
    await ws.load();
  }
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root, { ws, sync: null, shared: null, session, onSignIn, onSignOut: async () => {} });
  await app.start();
  return app;
}

/** Waits for a view that loads on demand (WebSocket, runner) to be built. */
async function viewLoaded(app, tab) {
  for (let i = 0; i < 200 && !app.views.get(tab.id)?.inner; i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => document.body.replaceChildren());

it('lets AltGr type characters instead of running Ctrl+Alt shortcuts', async () => {
  const app = await makeApp();
  const before = app.tabs.length;
  const key = (init) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, altKey: true, ...init });
    document.body.dispatchEvent(e);
    return e;
  };
  const typed = key({ key: '}', code: 'KeyN', modifierAltGraph: true });
  expect(typed.defaultPrevented).toBe(false);
  expect(app.tabs.length).toBe(before);
  const shortcut = key({ key: 'n', code: 'KeyN' });
  expect(shortcut.defaultPrevented).toBe(true);
});

it('keeps the preview tab when a draft without a saved request opens', async () => {
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, (await import('../src/core/model.js')).request({ name: 'R' }));
  const preview = app.openTab('request', r.id, { preview: true });
  app.openTab('request', null, { draft: { name: 'From history' }, preview: true });
  expect(app.tabs).toContain(preview);
});

it('closes the connection of a WebSocket preview tab when it is replaced', async () => {
  const { websocketRequest } = await import('../src/core/websocket.js');
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const sock = await app.ws.addItem(c.id, c.id, websocketRequest({ name: 'S', url: 'ws://localhost:9' }));
  const other = await app.ws.addItem(c.id, c.id, request({ name: 'R' }));
  const tab = app.openTab('websocket', sock.id, { preview: true });
  await viewLoaded(app, tab);
  let disposed = 0;
  tab.session = { dispose: () => disposed++, off() {}, on() {} };
  app.openTab('request', other.id, { preview: true });
  expect(app.tabs).not.toContain(tab);
  expect(disposed).toBe(1);
});

it('keeps a WebSocket preview tab once it connects', async () => {
  const { websocketRequest } = await import('../src/core/websocket.js');
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const sock = await app.ws.addItem(c.id, c.id, websocketRequest({ name: 'S', url: 'ws://localhost:9' }));
  const other = await app.ws.addItem(c.id, c.id, request({ name: 'R' }));
  const tab = app.openTab('websocket', sock.id, { preview: true });
  await viewLoaded(app, tab);
  app.views.get(tab.id).connect();
  expect(tab.preview).toBe(false);
  app.openTab('request', other.id, { preview: true });
  expect(app.tabs).toContain(tab);
  tab.session?.dispose();
});

it('keeps focus in the WebSocket name while the request is saved or its collection changes', async () => {
  const { websocketRequest } = await import('../src/core/websocket.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const sock = await app.ws.addItem(c.id, c.id, websocketRequest({ name: 'S', url: 'ws://localhost:9' }));
  const tab = app.openTab('websocket', sock.id);
  await viewLoaded(app, tab);
  const name = document.querySelector('input[aria-label="WebSocket request name"]');
  name.focus();
  name.value = 'Socket';
  name.dispatchEvent(new Event('input'));
  await app.saveTab(tab);
  await app.ws.updateCollection(c.id, (x) => {
    x.name = 'Renamed';
  });
  expect(document.activeElement).toBe(name);
  expect(name.isConnected).toBe(true);
  expect(document.querySelector('.req-head .crumb').textContent).toBe('Renamed');
});

it('opens a history entry as a fresh draft, and again in the same tab', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const entry = await app.ws.addHistory({ request: request({ name: '', method: 'PUT', url: 'https://x.test/old' }), response: { status: 200 } });
  const before = app.tabs.length;
  const tab = app.openHistory(entry);
  expect(tab.draft).toMatchObject({ name: 'x.test/old', method: 'PUT' });
  expect(tab.draft.id).not.toBe(entry.request.id);
  expect(app.openHistory(entry)).toBe(tab);
  expect(app.tabs.length).toBe(before + 1);
});

it('keeps focus in the tab list when a tab is closed with Delete', async () => {
  const app = await makeApp();
  for (const t of [...app.tabs]) await app.closeTab(t.id);
  app.newRequest();
  app.newRequest();
  await new Promise((r) => setTimeout(r, 50)); // the new request focuses its URL once shown
  const del = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  document.querySelector('.doc-tabs [aria-selected="true"]').focus();
  del();
  await new Promise((r) => setTimeout(r, 0));
  expect(document.activeElement).toBe(document.querySelector('.doc-tabs [aria-selected="true"]'));
  expect(app.tabs.length).toBe(1);
  del();
  await new Promise((r) => setTimeout(r, 0));
  expect(app.tabs.length).toBe(0);
  expect(document.activeElement.textContent).toContain('New request');
});

it('writes edits still waiting to be saved when the page is hidden', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'R', url: 'https://a.test' }));
  const tab = app.openTab('request', r.id);
  const collTab = app.openTab('collection', c.id);
  app.views.get(tab.id).persist.flush();
  app.persistTabs.flush(); // everything before the last keystrokes is saved
  await new Promise((r) => setTimeout(r, 0));
  tab.draft.url = 'https://b.test';
  app.views.get(tab.id).persist();
  const collView = app.views.get(collTab.id);
  collView.pending.description = 'Typed just before closing';
  collView.save();
  window.dispatchEvent(new Event('pagehide'));
  await new Promise((r) => setTimeout(r, 0));
  const saved = await app.ws.getMeta('tabs');
  expect(saved.tabs.find((t) => t.id === tab.id).draft.url).toBe('https://b.test');
  expect(app.ws.getCollection(c.id).description).toBe('Typed just before closing');
});

it('keeps the selected WebSocket message after Save As', async () => {
  const { websocketRequest } = await import('../src/core/websocket.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const sock = await app.ws.addItem(c.id, c.id, websocketRequest({ name: 'S', url: 'ws://localhost:9', messages: [{ name: 'One' }, { name: 'Two' }] }));
  const tab = app.openTab('websocket', sock.id);
  await viewLoaded(app, tab);
  tab.wsMessageId = tab.draft.messages[1].id;
  const saving = app.saveTabAs(tab);
  for (let i = 0; i < 100 && !document.querySelector('dialog[open]'); i++) await new Promise((r) => setTimeout(r, 10));
  [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Save').click();
  expect(await saving).toBe(true);
  const copy = app.ws.locate(tab.refId).item;
  expect(tab.refId).not.toBe(sock.id);
  expect(tab.wsMessageId).toBe(copy.messages[1].id);
});

it('saves an example from an HTML page with the charset the page declares', async () => {
  const app = await makeApp();
  const tab = app.newRequest();
  const view = app.views.get(tab.id);
  const body = Uint8Array.from('<meta charset="windows-1252"><p>caf\xe9</p>', (c) => c.charCodeAt(0));
  view.response.onSaveExample({ response: { status: 200, statusText: 'OK', headers: [['content-type', 'text/html']], body } });
  for (let i = 0; i < 100 && !document.querySelector('dialog[open]'); i++) await new Promise((r) => setTimeout(r, 10));
  [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Save example').click();
  await new Promise((r) => setTimeout(r, 0));
  expect(tab.draft.examples.at(-1).body).toBe('<meta charset="windows-1252"><p>café</p>');
});

it('finds WebSocket requests in the sidebar filter', async () => {
  const { websocketRequest } = await import('../src/core/websocket.js');
  const { folder } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const f = await app.ws.addItem(c.id, c.id, folder({ name: 'F' }));
  await app.ws.addItem(c.id, f.id, websocketRequest({ name: 'Chat stream', url: 'ws://localhost:9' }));
  const input = document.querySelector('.sidebar input[type="search"]');
  input.value = 'chat';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  expect([...document.querySelectorAll('[role="treeitem"]')].map((t) => t.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Chat stream')]));
});

it('undoes a collection or environment rename on Escape', async () => {
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'Original' });
  const env = await app.ws.addEnvironment({ name: 'Prod' });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const [kind, id, label, read] of [['collection', c.id, 'Collection name', () => app.ws.getCollection(c.id).name], ['environment', env.id, 'Environment name', () => app.ws.getEnvironment(env.id).name]]) {
    app.openTab(kind, id);
    await wait(50);
    const input = document.querySelector(`input[aria-label="${label}"]`);
    const before = read();
    input.focus();
    input.value = 'Typo name';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(400);
    expect(read()).toBe(before);
    // Also after the typed name was already saved.
    input.focus();
    input.value = 'Saved typo';
    input.dispatchEvent(new Event('input'));
    await wait(400);
    expect(read()).toBe('Saved typo');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(400);
    expect(read()).toBe(before);
    expect(input.value).toBe(before);
  }
});

it('keeps focus on an expanded empty folder when ArrowRight is pressed', async () => {
  const { folder, request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const empty = await app.ws.addItem(c.id, c.id, folder({ name: 'Empty' }));
  await app.ws.addItem(c.id, c.id, request({ name: 'After' }));
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  const row = (name) => [...document.querySelectorAll('[role="treeitem"]')].find((r) => r.querySelector('.tree-name').textContent === name);
  if (row('C').getAttribute('aria-expanded') === 'false') row('C').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await wait();
  row('Empty').focus();
  row('Empty').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await wait();
  row('Empty').focus();
  row('Empty').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await wait();
  expect(row('Empty').getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(row('Empty'));
  expect(empty.items).toEqual([]);
});

it('focuses the next row after deleting one with the Delete key', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  for (const n of ['a', 'b', 'c', 'd']) await app.ws.addItem(c.id, c.id, request({ name: n }));
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  const row = (name) => [...document.querySelectorAll('[role="treeitem"]')].find((r) => r.querySelector('.tree-name').textContent === name);
  if (row('C').getAttribute('aria-expanded') === 'false') {
    row('C').focus();
    row('C').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await wait();
  }
  row('c').focus();
  row('c').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await wait();
  [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Delete').click();
  await wait(100);
  expect(row('c')).toBeUndefined();
  expect(document.activeElement).toBe(row('d'));
});

it('keeps focus in the tree after a single click on a request', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  await app.ws.addItem(c.id, c.id, request({ name: 'a', url: 'https://x.test' }));
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  const row = (name) => [...document.querySelectorAll('[role="treeitem"]')].find((r) => r.querySelector('.tree-name').textContent === name);
  if (!row('a')) {
    row('C').click();
    await wait(100);
  }
  row('a').focus();
  row('a').click();
  await wait(100);
  expect(app.activeTab.refId).toBe(c.items[0].id);
  expect(document.activeElement).toBe(row('a'));
});

it('saves a preview tab pinned by double-clicking it', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'a' }));
  const tab = app.openTab('request', r.id, { preview: true });
  await new Promise((res) => setTimeout(res, 500));
  document.getElementById(`tab-${tab.id}`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 500));
  expect((await app.ws.getMeta('tabs')).tabs.find((t) => t.id === tab.id).preview).toBe(false);
});

it('drops a dragged tab after the last tab', async () => {
  const app = await makeApp();
  const [a, b, c] = [app.newRequest({ name: 'A' }), app.newRequest({ name: 'B' }), app.newRequest({ name: 'C' })];
  const drag = (type, target, clientX) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { clientX });
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['text/x-tab'], getData: () => a.id, setData() {} } });
    target.dispatchEvent(e);
  };
  const el = (t) => document.querySelector(`.doc-tab[data-id="${t.id}"]`);
  el(c).getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 20 });
  drag('drop', el(c), 90);
  expect(app.tabs.map((t) => t.draft.name)).toEqual(['B', 'C', 'A']);
  el(b).getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 20 });
  drag('drop', el(b), 10);
  expect(app.tabs.map((t) => t.draft.name)).toEqual(['A', 'B', 'C']);
});

it('moves between sidebar sections with the arrow keys', async () => {
  const app = await makeApp();
  const tabs = [...document.querySelectorAll('.sidebar-switch [role="tab"]')];
  expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  tabs[0].focus();
  tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(app.sidebar.section).toBe('environments');
  expect(document.activeElement).toBe(tabs[1]);
  expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  expect(document.getElementById(tabs[1].getAttribute('aria-controls')).getAttribute('aria-labelledby')).toBe(tabs[1].id);
});

it('turns Save on as soon as a saved request is edited', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'a', url: 'https://x.test' }));
  app.openTab('request', r.id);
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  await wait(50);
  const save = () => [...document.querySelectorAll('.req-head-actions button')].find((b) => b.textContent === 'Save');
  expect(save().disabled).toBe(true);
  const url = document.querySelector('input[aria-label="Request URL"]');
  url.value = 'https://x.test/edited';
  url.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(300);
  expect(save().disabled).toBe(false);
});

it('does not rebuild the params table for URL edits that leave the params alone', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'a', url: 'https://x.test/users/:id?q=1' }));
  app.openTab('request', r.id);
  await new Promise((res) => setTimeout(res, 50));
  const url = document.querySelector('input[aria-label="Request URL"]');
  url.dispatchEvent(new Event('input', { bubbles: true }));
  const firstCell = document.querySelector('table.kv input');
  const pathCell = document.querySelector('input[aria-label="Value of path variable id"]');
  url.value = 'https://x.test/userz/:id?q=1';
  url.dispatchEvent(new Event('input', { bubbles: true }));
  expect(firstCell.isConnected).toBe(true);
  expect(pathCell.isConnected).toBe(true);
  url.value = 'https://x.test/userz/:id?q=12';
  url.dispatchEvent(new Event('input', { bubbles: true }));
  expect(app.activeTab.draft.params[0].value).toBe('12');
});

it('keeps a path variable value when its name is typed past and backspaced in the URL', async () => {
  const { request, pair } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'a', url: 'https://api.test/users/:id', pathVars: [pair('id', '42')] }));
  app.openTab('request', r.id);
  await new Promise((res) => setTimeout(res, 50));
  const url = document.querySelector('input[aria-label="Request URL"]');
  for (const v of ['https://api.test/users/:idx', 'https://api.test/users/:id']) {
    url.value = v;
    url.dispatchEvent(new Event('input', { bubbles: true }));
  }
  expect(app.activeTab.draft.pathVars.map((p) => [p.key, p.value])).toEqual([['id', '42']]);
  expect(document.querySelector('input[aria-label="Value of path variable id"]').value).toBe('42');
});

it('keeps a query param\'s id and description when the query is cleared and typed again', async () => {
  const { request, pair } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'a', url: 'https://api.test/x?page=1', params: [pair('page', '1', { description: 'Page number' })] }));
  const tab = app.openTab('request', r.id);
  await new Promise((res) => setTimeout(res, 50));
  const before = tab.draft.params[0];
  const url = document.querySelector('input[aria-label="Request URL"]');
  for (const v of ['https://api.test/x?p', 'https://api.test/x?', 'https://api.test/x?p', 'https://api.test/x?page=1']) {
    url.value = v;
    url.dispatchEvent(new Event('input', { bubbles: true }));
  }
  expect(tab.draft.params).toEqual([before]);
  expect(app.isDirty(tab)).toBe(false);
  // Removing the "?" as well starts afresh.
  for (const v of ['https://api.test/x?', 'https://api.test/x', 'https://api.test/x?q=1']) {
    url.value = v;
    url.dispatchEvent(new Event('input', { bubbles: true }));
  }
  expect(tab.draft.params.map((p) => [p.key, p.description, p.id === before.id])).toEqual([['q', '', false]]);
});

it('uses the last enabled row of a duplicated variable for lookups, the list and secret masking', async () => {
  const app = await makeApp();
  const env = await app.ws.addEnvironment({
    name: 'E',
    variables: [
      { key: 'token', value: 'public' },
      { key: 'token', value: 'TOPSECRET', secret: true },
      { key: 'token', value: 'off', enabled: false },
    ],
  });
  await app.setEnvironment(env.id);
  const vars = app.varsFor(null);
  expect(vars.get('token')).toMatchObject({ value: 'TOPSECRET', secret: true });
  expect(vars.list().filter((v) => v.name === 'token')).toEqual([{ name: 'token', value: 'TOPSECRET', scope: 'environment', secret: true }]);
});

it('asks once when the close button of an edited tab is double-clicked', async () => {
  const app = await makeApp();
  const [a, b] = [app.newRequest({ name: 'A', url: 'https://a.test' }), app.newRequest({ name: 'B', url: 'https://b.test' })];
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  const first = app.closeTab(a.id);
  const second = app.closeTab(a.id);
  await wait(100);
  expect(document.querySelectorAll('dialog[open]').length).toBe(1);
  for (const dlg of document.querySelectorAll('dialog[open]')) [...dlg.querySelectorAll('button')].find((x) => x.textContent === "Don't save").click();
  await Promise.all([first, second]);
  expect(app.tabs).toEqual([b]);
  expect(app.views.has(a.id)).toBe(false);
  // Closed another way (the request was deleted) while the prompt is open.
  const c = app.newRequest({ name: 'C', url: 'https://c.test' });
  const asking = app.closeTab(b.id);
  await wait(50);
  await app.closeTab(b.id, { force: true });
  [...document.querySelector('dialog[open]').querySelectorAll('button')].find((x) => x.textContent === "Don't save").click();
  await asking;
  expect(app.tabs).toEqual([c]);
});

it('recolors variables in a background tab once it is shown again', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'a', url: '{{host}}/x', body: { mode: 'raw', raw: '{"h":"{{host}}"}', language: 'json' } }));
  const tab = app.openTab('request', r.id);
  await wait();
  const view = app.views.get(tab.id);
  [...view.el.querySelectorAll('[role="tab"]')].find((t) => /Body/.test(t.textContent)).click();
  await wait(300);
  const urlToken = () => view.el.querySelector('.var-token');
  const bodyToken = () => view.el.querySelector('.cm-var');
  expect(urlToken().classList.contains('missing')).toBe(true);
  expect(bodyToken()?.classList.contains('missing')).toBe(true);
  app.newRequest();
  await wait();
  const env = await app.ws.addEnvironment({ name: 'E', variables: [{ key: 'host', value: 'https://h.test', enabled: true }] });
  await app.setEnvironment(env.id);
  app.activate(tab.id);
  await wait();
  expect(urlToken().classList.contains('missing')).toBe(false);
  expect(bodyToken().classList.contains('missing')).toBe(false);
  // Still tracked: later changes repaint it while it is shown.
  await app.setEnvironment(null);
  expect(urlToken().classList.contains('missing')).toBe(true);
  expect(bodyToken().classList.contains('missing')).toBe(true);
  // Closed tabs are not kept, even before the next variable change.
  const { liveVarInputs } = await import('../src/ui/var-input.js');
  const before = liveVarInputs();
  for (let i = 0; i < 20; i++) {
    const t = app.newRequest({ url: '{{host}}' });
    await wait(10);
    await app.closeTab(t.id, { force: true });
  }
  expect(liveVarInputs()).toBe(before);
});

it('shows the response of a request that was saved under a new name while it ran', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  let respond;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => (respond = () => r(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))))));
  try {
    const c = await app.ws.addCollection({ name: 'C' });
    const r = await app.ws.addItem(c.id, c.id, request({ name: 'a', url: 'https://x.test/' }));
    const tab = app.openTab('request', r.id);
    await wait();
    const sent = app.sendTab(tab);
    await wait();
    const saving = app.saveTabAs(tab);
    await wait(200);
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Save').click();
    await saving;
    const sendBtn = () => app.views.get(tab.id).el.querySelector('.send-btn');
    expect(sendBtn().textContent).toBe('Cancel');
    respond();
    await sent;
    expect(sendBtn().textContent).toBe('Send');
    expect(app.views.get(tab.id).el.querySelector('.status-pill')?.textContent).toMatch(/200/);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps a sidebar rename of a request whose tab has unsaved edits', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'Old', url: 'https://x.test' }));
  const tab = app.openTab('request', r.id);
  await wait();
  const url = document.querySelector('input[aria-label="Request URL"]');
  url.value = 'https://x.test/edited';
  url.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(300);
  await app.ws.updateItem(r.id, (item) => {
    item.name = 'New';
  });
  expect(tab.draft.name).toBe('New');
  expect(document.querySelector('input[aria-label="Request name"]').value).toBe('New');
  expect(document.getElementById(`tab-${tab.id}`).textContent).toContain('New');
  await app.saveTab(tab);
  expect(app.ws.locate(r.id).item.name).toBe('New');
  expect(app.ws.locate(r.id).item.url).toBe('https://x.test/edited');
  // A name edited in the tab wins over a rename elsewhere.
  const name = document.querySelector('input[aria-label="Request name"]');
  name.value = 'Mine';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(300);
  await app.ws.updateItem(r.id, (item) => {
    item.name = 'Theirs';
  });
  expect(tab.draft.name).toBe('Mine');
});

it('keeps focus and typing in the request name across saves and collection changes', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'a', url: 'https://x.test' }));
  const tab = app.openTab('request', r.id);
  await wait();
  const name = document.querySelector('input[aria-label="Request name"]');
  name.focus();
  name.value = 'abc';
  name.setSelectionRange(1, 1);
  name.dispatchEvent(new Event('input', { bubbles: true }));
  await app.saveTab(tab); // Mod+S
  expect(app.ws.locate(r.id).item.name).toBe('abc');
  expect(document.activeElement).toBe(name);
  expect(name.selectionStart).toBe(1);
  const save = () => [...document.querySelectorAll('.req-head-actions button')].find((b) => b.textContent === 'Save');
  expect(save().disabled).toBe(true);
  // A script changing collection variables while the name is being typed.
  name.value = 'abcd';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  await app.ws.updateCollection(c.id, (col) => {
    col.variables = [{ key: 'k', value: 'v', enabled: true }];
  });
  expect(document.activeElement).toBe(name);
  expect(name.value).toBe('abcd');
  expect(tab.draft.name).toBe('abcd');
});

it('records the request in history as it was sent', async () => {
  const app = await makeApp();
  let respond;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => (respond = () => r(new Response('ok', { status: 200 }))))));
  try {
    const tab = app.newRequest({ url: 'https://x.test/sent' });
    const sent = app.sendTab(tab);
    await new Promise((r) => setTimeout(r, 50));
    tab.draft.url = 'https://x.test/edited';
    respond();
    await sent;
    expect(app.ws.history[0].request.url).toBe('https://x.test/sent');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps a preview tab once its request is sent', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  let respond;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => (respond = () => r(new Response('ok', { status: 200 }))))));
  try {
    const c = await app.ws.addCollection({ name: 'C' });
    const a = await app.ws.addItem(c.id, c.id, request({ name: 'a', url: 'https://x.test/a' }));
    const b = await app.ws.addItem(c.id, c.id, request({ name: 'b', url: 'https://x.test/b' }));
    const tab = app.openTab('request', a.id, { preview: true });
    const sent = app.sendTab(tab);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(`.doc-tab[data-id="${tab.id}"]`).classList.contains('preview')).toBe(false);
    app.openTab('request', b.id, { preview: true });
    expect(app.tabs).toContain(tab);
    respond();
    await sent;
    expect(tab.result.response.status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('opens one Save dialog when Save is pressed twice on a new request', async () => {
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const tab = app.newRequest({ url: 'https://x.test' });
  const first = app.saveTab(tab);
  const second = app.saveTab(tab);
  await new Promise((r) => setTimeout(r, 200));
  expect(document.querySelectorAll('dialog[open]').length).toBe(1);
  document.querySelector('dialog[open] [role="listbox"] [role="option"]')?.click();
  [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Save').click();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(c.items.length).toBe(1);
});

it('keeps the browser Save and Open dialogs away while an app dialog is open', async () => {
  const { openDialog } = await import('../src/ui/dialog.js');
  const app = await makeApp();
  const tab = app.newRequest({ url: 'https://x.test' });
  const dlg = openDialog({ title: 'Settings', body: document.createElement('input') });
  const key = (code) => {
    const e = new KeyboardEvent('keydown', { key: code.slice(3).toLowerCase(), code, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(e);
    return e;
  };
  expect(key('KeyS').defaultPrevented).toBe(true);
  expect(key('KeyO').defaultPrevented).toBe(true);
  await new Promise((r) => setTimeout(r, 100));
  // The shortcuts themselves do not run over the dialog.
  expect(document.querySelectorAll('dialog[open]').length).toBe(1);
  expect(tab.refId).toBe(null);
  dlg.close();
});

it('does not cancel a request when Send is double-clicked', async () => {
  const app = await makeApp();
  const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const aborted = () => new DOMException('Aborted', 'AbortError');
  vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((resolve, reject) => (init.signal.aborted ? reject(aborted()) : init.signal.addEventListener('abort', () => reject(aborted()))))));
  try {
    const tab = app.newRequest({ url: 'https://x.test' });
    await wait(20);
    const btn = document.querySelector('.send-btn');
    const click = (detail) => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
    const running = () => !!tab.abort && !tab.abort.signal.aborted;
    click(1);
    click(2);
    await wait(20);
    expect(running()).toBe(true);
    // A deliberate Cancel still works, from the pointer or the keyboard.
    await wait(350);
    click(1);
    await wait(20);
    expect(running()).toBe(false);
    click(1);
    click(0);
    expect(running()).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('Cancel stops a running script and the request it sent', async () => {
  const app = await makeApp();
  const aborted = () => new DOMException('Aborted', 'AbortError');
  const signals = [];
  vi.stubGlobal('fetch', vi.fn((url, init) => (signals.push(init.signal), new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(aborted()))))));
  try {
    const tab = app.newRequest({ url: 'https://x.test', scripts: { pre: "await send('https://slow.test');", post: '' } });
    const history = app.ws.history.length;
    app.sendTab(tab);
    await vi.waitFor(() => expect(document.querySelector('iframe[title="Script sandbox"]')).toBeTruthy());
    fakeLoader((d, port) => {
      if (d.type === 'run') port.postMessage({ type: 'send', id: d.id, sendId: 1, request: { method: 'GET', url: 'https://slow.test' } });
      else if (d.type === 'ping') port.postMessage({ type: 'pong', nonce: d.nonce });
    });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    app.sendTab(tab);
    await vi.waitFor(() => expect(tab.abort).toBe(null));
    expect(signals[0].aborted).toBe(true);
    expect(tab.result.error.code).toBe('aborted');
    // Like a cancelled request: not recorded in history.
    expect(app.ws.history.length).toBe(history);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('shows requests sent by scripts in the Console', async () => {
  const app = await makeApp();
  vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('down.test') ? Promise.reject(new TypeError('Failed to fetch')) : new Response('ok', { status: 201, headers: { 'X-Side': '1' } }))));
  try {
    const tab = app.newRequest({ url: 'https://x.test', scripts: { pre: "await send('https://side.test/a');", post: '' } });
    app.sendTab(tab);
    await vi.waitFor(() => expect(document.querySelector('iframe[title="Script sandbox"]')).toBeTruthy());
    fakeLoader((d, port) => {
      if (d.type === 'run') {
        port.postMessage({ type: 'send', id: d.id, sendId: 1, request: { method: 'POST', url: 'https://side.test/a', headers: [{ key: 'X-Mine', value: 'v' }], body: { mode: 'raw', raw: 'hi' } } });
        port.postMessage({ type: 'send', id: d.id, sendId: 2, request: { method: 'GET', url: 'https://down.test/' } });
      } else if (d.type === 'ping') port.postMessage({ type: 'pong', nonce: d.nonce });
    });
    const logged = () => app.console.entries.filter((e) => e.kind === 'request');
    await vi.waitFor(() => expect(logged()).toHaveLength(2));
    const [ok, failed] = [logged().find((e) => e.url === 'https://side.test/a'), logged().find((e) => e.url === 'https://down.test/')];
    expect(ok).toMatchObject({ method: 'POST', status: 201, level: 'info', source: 'script' });
    expect(ok.requestHeaders).toContainEqual(['X-Mine', 'v']);
    expect(ok.responseHeaders).toContainEqual(['x-side', '1']);
    expect(failed).toMatchObject({ method: 'GET', level: 'error', source: 'script' });
    expect(failed.error).toBeTruthy();
    app.sendTab(tab);
    await vi.waitFor(() => expect(tab.abort).toBe(null));
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps focus on the page after deleting an environment from its own tab', async () => {
  const app = await makeApp();
  const env = await app.ws.addEnvironment({ name: 'Prod' });
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  for (const id of [...app.tabs.map((t) => t.id)]) await app.closeTab(id, { force: true });
  app.openTab('environment', env.id);
  await wait(50);
  const more = document.querySelector('button[aria-label="More environment actions"]');
  more.focus();
  app.deleteEnvironment(env.id);
  await wait();
  [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Delete').click();
  await wait(100);
  expect(app.ws.getEnvironment(env.id)).toBeFalsy();
  expect(document.activeElement).not.toBe(document.body);
  expect(app.mainEl.contains(document.activeElement)).toBe(true);
});

it('keeps tabs open when their request or folder moves to another collection', async () => {
  const { request, folder } = await import('../src/core/model.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  const a = await app.ws.addCollection({ name: 'A' });
  const b = await app.ws.addCollection({ name: 'B' });
  const clean = await app.ws.addItem(a.id, a.id, request({ name: 'clean', url: 'https://x.test/1' }));
  const edited = await app.ws.addItem(a.id, a.id, request({ name: 'edited', url: 'https://x.test/2' }));
  const f = await app.ws.addItem(a.id, a.id, folder({ name: 'F' }));
  const cleanTab = app.openTab('request', clean.id);
  const editedTab = app.openTab('request', edited.id);
  await wait();
  editedTab.draft.url = 'https://x.test/2/changed';
  app.draftChanged(editedTab);
  const runTab = app.openTab('runner', f.id);
  await wait();
  for (const id of [clean.id, edited.id, f.id]) expect(await app.ws.moveItem(id, b.id, b.id)).toBe(true);
  await wait();
  expect(app.tabs).toEqual(expect.arrayContaining([cleanTab, editedTab, runTab]));
  expect(editedTab.refId).toBe(edited.id);
  await app.saveTab(editedTab);
  expect(app.ws.locate(edited.id).collection.id).toBe(b.id);
  expect(app.ws.locate(edited.id).item.url).toBe('https://x.test/2/changed');
  expect(app.ws.getCollection(b.id).items.length).toBe(3);
});

it('uses the new collection\'s variables in an open request or WebSocket tab after it moves', async () => {
  const { request, variable } = await import('../src/core/model.js');
  const { websocketRequest } = await import('../src/core/websocket.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  const a = await app.ws.addCollection({ name: 'A', variables: [variable('onlyA', '1')] });
  const b = await app.ws.addCollection({ name: 'B', variables: [variable('onlyB', '2')] });
  const url = 'https://api.test/{{onlyA}}/{{onlyB}}';
  for (const item of [request({ name: 'R', url }), websocketRequest({ name: 'S', url: 'wss://api.test/{{onlyA}}/{{onlyB}}' })]) {
    await app.ws.addItem(a.id, a.id, item);
    const tab = app.openTab(item.type === 'websocket' ? 'websocket' : 'request', item.id);
    await wait(); // the WebSocket view loads on demand
    const missing = () => [...app.views.get(tab.id).el.querySelectorAll('.url-row .var-token, .ws-url-row .var-token')].filter((t) => t.classList.contains('missing')).map((t) => t.dataset.name);
    expect(missing()).toEqual(['onlyB']);
    expect(await app.ws.moveItem(item.id, b.id, b.id)).toBe(true);
    await wait();
    expect(missing()).toEqual(['onlyA']);
    expect(app.views.get(tab.id).vars.list().map((v) => v.name)).toContain('onlyB');
  }
});

it('opens history entries as a preview tab and focuses the tab an entry already has', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  await app.ws.addHistory({ request: request({ name: 'A', url: 'https://x.test/a' }), response: { status: 200 } });
  await app.ws.addHistory({ request: request({ name: 'B', url: 'https://x.test/b' }), response: { status: 200 } });
  app.showSection('history');
  await wait();
  const entry = (name) => [...document.querySelectorAll('.history-main')].find((b) => b.title.endsWith(`/${name.toLowerCase()}`));
  for (const name of ['A', 'B', 'A']) entry(name).click();
  expect(app.tabs.length).toBe(1);
  expect(app.activeTab.preview).toBe(true);
  expect(app.activeTab.draft.url).toBe('https://x.test/a');
  // Closing an untouched preview does not ask to save it.
  expect(await app.closeTab(app.activeTab.id)).toBe(true);
  entry('A').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const pinned = app.activeTab;
  expect(pinned.preview).toBe(false);
  entry('B').click();
  entry('A').click();
  expect(app.tabs.length).toBe(2);
  expect(app.activeTab).toBe(pinned);
  entry('B').click();
  expect(app.tabs.length).toBe(2);
  expect(app.activeTab.draft.url).toBe('https://x.test/b');
});

it('shows what is in a folder or collection found by its name in the sidebar filter', async () => {
  const { request, folder } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'Billing' });
  const f = await app.ws.addItem(c.id, c.id, folder({ name: 'Invoices' }));
  await app.ws.addItem(c.id, f.id, request({ name: 'List', url: 'https://x.test/list' }));
  const sub = await app.ws.addItem(c.id, f.id, folder({ name: 'Drafts' }));
  await app.ws.addItem(c.id, sub.id, request({ name: 'Create', url: 'https://x.test/new' }));
  await app.ws.addItem(c.id, c.id, request({ name: 'Other', url: 'https://x.test/other' }));
  app.showSection('collections');
  const names = async (q) => {
    const input = document.querySelector('.sidebar input[type="search"]');
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return [...document.querySelectorAll('[role="treeitem"] .tree-name')].map((t) => t.textContent);
  };
  expect(await names('invoices')).toEqual(['Billing', 'Invoices', 'List', 'Drafts', 'Create']);
  expect(await names('billing')).toEqual(['Billing', 'Invoices', 'List', 'Drafts', 'Create', 'Other']);
  expect(await names('create')).toEqual(['Billing', 'Invoices', 'Drafts', 'Create']);
});

it('filters the sidebar once typing pauses, and at once on Enter, Escape or clearing', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  for (const n of ['alpha', 'beta', 'gamma']) await app.ws.addItem(c.id, c.id, request({ name: n }));
  app.sidebar.expand(c.id);
  app.showSection('collections');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const names = () => [...document.querySelectorAll('[role="treeitem"] .tree-name')].map((t) => t.textContent);
  const input = document.querySelector('.sidebar input[type="search"]');
  const type = (v) => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  let renders = 0;
  const render = app.sidebar.render.bind(app.sidebar);
  app.sidebar.render = () => (renders++, render());
  for (const v of ['b', 'be', 'bet']) type(v);
  expect(names()).toEqual(['C', 'alpha', 'beta', 'gamma']);
  await wait(200);
  expect(renders).toBe(1);
  expect(names()).toEqual(['C', 'beta']);
  type('gam');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(names()).toEqual(['C', 'gamma']);
  type('al');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(names()).toEqual(['C', 'alpha', 'beta', 'gamma']);
  type('al');
  type('');
  expect(names()).toEqual(['C', 'alpha', 'beta', 'gamma']);
  await wait(200);
  expect(names()).toEqual(['C', 'alpha', 'beta', 'gamma']);
});

it('opens and closes a folder in the sidebar without rebuilding the rest of the tree', async () => {
  const { request, folder } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const f = await app.ws.addItem(c.id, c.id, folder({ name: 'F' }));
  await app.ws.addItem(c.id, f.id, request({ name: 'in F' }));
  const g = await app.ws.addItem(c.id, f.id, folder({ name: 'G' }));
  await app.ws.addItem(c.id, g.id, request({ name: 'in G' }));
  await app.ws.addItem(c.id, c.id, request({ name: 'after' }));
  app.sidebar.expand(c.id);
  app.sidebar.expand(g.id);
  app.showSection('collections');
  await new Promise((r) => setTimeout(r, 100));
  const rows = () => [...document.querySelectorAll('[role="treeitem"]')];
  const row = (name) => rows().find((r) => r.querySelector('.tree-name').textContent === name);
  const snapshot = () => rows().map((r) => [r.querySelector('.tree-name').textContent, r.getAttribute('aria-level'), r.getAttribute('aria-expanded'), r.getAttribute('tabindex')]);
  const after = row('after');
  const tree = document.querySelector('[role="tree"]');
  row('F').focus();
  row('F').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(rows().map((r) => r.querySelector('.tree-name').textContent)).toEqual(['C', 'F', 'in F', 'G', 'in G', 'after']);
  expect(document.activeElement).toBe(row('F'));
  expect(row('after')).toBe(after);
  expect(document.querySelector('[role="tree"]')).toBe(tree);
  // The same rows a full rebuild draws.
  const inPlace = snapshot();
  app.sidebar.render();
  expect(snapshot()).toEqual(inPlace);
  const rebuilt = row('after');
  row('F').focus();
  row('F').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(snapshot()).toEqual([['C', '1', 'true', '-1'], ['F', '2', 'false', '0'], ['after', '2', null, '-1']]);
  expect(document.activeElement).toBe(row('F'));
  expect(row('after')).toBe(rebuilt);
});

it('offers only actions that work on requests in a view-only shared collection', async () => {
  const { request, folder } = await import('../src/core/model.js');
  const { closeMenu } = await import('../src/ui/menu.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  const r = request({ name: 'Get item', url: 'https://x.test/item' });
  const f = folder({ name: 'F', items: [] });
  const theirs = await app.ws.putCollection({ type: 'collection', name: 'Theirs', items: [r, f], shared: { path: '/x/y.json', owner: 'x', mode: 'read' } }, { quiet: true });
  app.showSection('collections');
  app.sidebar.expand(theirs.id);
  app.sidebar.render();
  const row = (name) => [...document.querySelectorAll('[role="treeitem"]')].find((x) => x.querySelector('.tree-name').textContent === name);
  expect(row('Get item').getAttribute('draggable')).toBe('false');
  expect(row('F').getAttribute('draggable')).toBe('false');
  row('Get item').focus();
  row('Get item').dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent.trim());
  closeMenu();
  expect(labels.some((l) => /Rename|Delete|^Duplicate(?! to)/.test(l))).toBe(false);
  expect(labels).toEqual(expect.arrayContaining([expect.stringContaining('Open in new tab'), expect.stringContaining('Copy as cURL'), expect.stringContaining('Duplicate to my collections')]));
  // The editing keys change nothing.
  for (const init of [{ key: 'F2' }, { key: 'Delete' }, { key: 'd', code: 'KeyD', ctrlKey: true, metaKey: true }]) {
    row('Get item').focus();
    row('Get item').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    await wait();
    expect(document.querySelector('dialog[open]')).toBe(null);
  }
  expect(app.ws.getCollection(theirs.id).items.map((x) => x.name)).toEqual(['Get item', 'F']);
  expect(app.ws.collections.length).toBe(1);
});

it('moves a request to another collection from its menu, without dragging', async () => {
  const { request, folder } = await import('../src/core/model.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  const a = await app.ws.addCollection({ name: 'A' });
  const b = await app.ws.addCollection({ name: 'B' });
  const f = await app.ws.addItem(b.id, b.id, folder({ name: 'Target' }));
  const r = await app.ws.addItem(a.id, a.id, request({ name: 'Mover', url: 'https://x.test' }));
  app.showSection('collections');
  app.sidebar.reveal(r.id);
  const row = (name) => [...document.querySelectorAll('[role="treeitem"]')].find((x) => x.querySelector('.tree-name').textContent === name);
  row('Mover').focus();
  row('Mover').dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
  [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.includes('Move to')).click();
  await wait(200);
  const dlg = document.querySelector('dialog[open]');
  const option = (name) => [...dlg.querySelectorAll('[role="option"]')].find((o) => o.querySelector('.save-opt-name').textContent === name);
  option('Back').click();
  option('B').click();
  option('Target').click();
  [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'Move').click();
  await wait();
  expect(app.ws.locate(r.id).parent.id).toBe(f.id);
  expect(document.activeElement).toBe(row('Mover'));
});

it('keeps the console size within the room the window leaves', async () => {
  const app = await makeApp();
  Object.defineProperty(app.mainEl, 'clientHeight', { configurable: true, value: 300 });
  app.console.toggle();
  const sep = app.console.resizer;
  const key = (k) => sep.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  for (let i = 0; i < 20; i++) key('ArrowUp');
  expect(sep.getAttribute('aria-valuemax')).toBe('210');
  expect(sep.getAttribute('aria-valuenow')).toBe('210');
  // Shrinking starts from the size it shows.
  key('ArrowDown');
  expect(sep.getAttribute('aria-valuenow')).toBe('200');
  app.console.toggle();
});

it('leaves focus where it is when Ctrl+` closes the console from outside it', async () => {
  const app = await makeApp();
  app.console.setOpen(false);
  app.newRequest();
  await new Promise((r) => setTimeout(r, 50));
  // What Ctrl+` runs (apps from earlier tests also listen on the document and would take the key first).
  const press = () => app.console.toggle();
  press();
  expect(app.console.open).toBe(true);
  const url = document.querySelector('input[aria-label="Request URL"]');
  url.focus();
  press();
  expect(app.console.open).toBe(false);
  expect(document.activeElement).toBe(url);
  // From inside the console, focus goes back to its button rather than being lost.
  press();
  expect(app.console.el.contains(document.activeElement)).toBe(true);
  press();
  expect(document.activeElement).toBe(app.consoleBtn);
});

it('renames the Today history heading once the day changes', async () => {
  const { request } = await import('../src/core/model.js');
  vi.useFakeTimers({ now: new Date(2026, 0, 1, 23, 58), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    const app = await makeApp();
    await app.ws.addHistory({ request: request({ name: 'A', url: 'https://x.test/a' }), response: { status: 200 } });
    app.showSection('history');
    const heading = () => document.querySelector('.history-day').textContent;
    expect(heading()).toBe('Today');
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(heading()).toBe('Yesterday');
    // A device that slept through midnight catches up when the app is shown again.
    vi.setSystemTime(new Date(2026, 0, 3, 9, 0));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(heading()).not.toBe('Yesterday');
  } finally {
    vi.useRealTimers();
  }
});

it('closes the tab Save to collection opened from history when the save is cancelled', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  await app.ws.addCollection({ name: 'C' });
  await app.ws.addHistory({ request: request({ name: 'A', url: 'https://x.test/a' }), response: { status: 200 } });
  app.showSection('history');
  await wait();
  document.querySelector('.history-row .tree-more').click();
  [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.includes('Save to collection')).click();
  await wait(200);
  expect(app.tabs.length).toBe(1);
  [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click();
  await wait();
  expect(app.tabs.length).toBe(0);
});

it('ties the open tabs to the editor area as tabs and their tab panel', async () => {
  const app = await makeApp();
  const a = app.newRequest({ name: 'A' });
  const b = app.newRequest({ name: 'B' });
  const panel = app.content;
  const tab = (t) => document.getElementById(`tab-${t.id}`);
  expect(panel.getAttribute('role')).toBe('tabpanel');
  expect(tab(b).getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.getAttribute('aria-labelledby')).toBe(tab(b).id);
  app.activate(a.id);
  expect(panel.getAttribute('aria-labelledby')).toBe(tab(a).id);
  expect(tab(a).getAttribute('aria-controls')).toBe(panel.id);
  for (const t of [a, b]) await app.closeTab(t.id, { force: true });
  expect(app.tabs.length).toBe(0);
  expect(panel.hasAttribute('role')).toBe(false);
  expect(panel.hasAttribute('aria-labelledby')).toBe(false);
});

it('names each breadcrumb in a tooltip, since narrow windows cut them short', async () => {
  const { request, folder } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'Sample API with a long name' });
  const f = await app.ws.addItem(c.id, c.id, folder({ name: 'Users' }));
  const r = await app.ws.addItem(c.id, f.id, request({ name: 'List users' }));
  app.openTab('request', r.id);
  const crumbs = [...document.querySelectorAll('.req-head .crumb')];
  expect(crumbs.map((b) => b.title)).toEqual(['Open Sample API with a long name', 'Open Users']);
  // The collection gives way first (editor.css); each keeps letters by its length.
  expect(crumbs.map((b) => b.classList.contains('crumb-root'))).toEqual([true, false]);
  expect(crumbs[1].style.getPropertyValue('--chars')).toBe('5');
});

it('keeps the sidebar tree and redraws the tabs once when scripts set collection variables', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'R', url: 'https://x.test/{{id}}' }));
  app.sidebar.expand(c.id);
  app.showSection('collections');
  app.openTab('collection', c.id);
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  await wait(60);
  const events = [];
  app.ws.on('change', (e) => events.push(e));
  const tree = document.querySelector('[role="tree"]');
  let tabRenders = 0;
  const render = app.tabbar.render.bind(app.tabbar);
  app.tabbar.render = () => (tabRenders++, render());
  await app.ws.applyVariableChanges({ collectionId: c.id, changes: { collection: { id: '7' } } });
  await wait(60);
  expect(events).toEqual([{ kind: 'collection', id: c.id, variablesOnly: true }]);
  expect(tabRenders).toBe(1);
  expect(document.querySelector('[role="tree"]')).toBe(tree);
  expect(app.ws.getCollection(c.id).variables.map((v) => [v.key, v.value])).toEqual([['id', '7']]);
  // Any other change to the collection still redraws the tree.
  await app.ws.updateItem(r.id, (x) => {
    x.name = 'Renamed';
  });
  await wait(60);
  expect(document.querySelector('[role="tree"]')).not.toBe(tree);
  expect([...document.querySelectorAll('[role="treeitem"] .tree-name')].map((t) => t.textContent)).toEqual(['C', 'Renamed']);
});

it('stores collection variables set by scripts at once when the page is hidden or closed', async () => {
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const stored = async () => (await app.ws.db.get('collections', c.id)).variables.map((v) => [v.key, v.value]);
  await app.ws.applyVariableChanges({ collectionId: c.id, changes: { collection: { token: 'a' } } });
  expect(await stored()).toEqual([]);
  window.dispatchEvent(new Event('pagehide'));
  await new Promise((r) => setTimeout(r, 0));
  expect(await stored()).toEqual([['token', 'a']]);
  await app.ws.applyVariableChanges({ collectionId: c.id, changes: { collection: { token: 'b' } } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  try {
    document.dispatchEvent(new Event('visibilitychange'));
  } finally {
    delete document.visibilityState;
  }
  await new Promise((r) => setTimeout(r, 0));
  expect(await stored()).toEqual([['token', 'b']]);
});

it('draws only the tree rows that cannot be on screen lazily', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  await app.ws.updateCollection(c.id, (x) => {
    for (let i = 0; i < 300; i++) x.items.push(request({ name: `r${i}` }));
  });
  app.sidebar.expand(c.id);
  app.showSection('collections');
  const body = app.sidebar.body;
  let scrollTop = 0;
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v) => (scrollTop = v) });
  const lazy = () => [...document.querySelectorAll('[role="treeitem"]')].map((r) => r.classList.contains('lazy'));
  const nearby = (from, to) => lazy().slice(from, to).every((x) => !x);
  // 20 rows fit in view: the rows a screen up and down are drawn at once, the rest lazily.
  app.sidebar.render();
  expect(nearby(0, 60)).toBe(true);
  expect(lazy().slice(80).every(Boolean)).toBe(true);
  scrollTop = 150 * 30;
  app.sidebar.render();
  expect(nearby(120, 200)).toBe(true);
  expect(lazy()[100]).toBe(true);
  expect(lazy()[250]).toBe(true);
  // Scrolled past the end of a shorter list: its end is in view.
  scrollTop = 100000;
  app.sidebar.render();
  expect(nearby(270, 301)).toBe(true);
  // A row revealed far from where the list is scrolled.
  scrollTop = 0;
  const far = app.ws.getCollection(c.id).items[200];
  app.sidebar.reveal(far.id);
  expect(nearby(170, 230)).toBe(true);
  expect(lazy()[120]).toBe(true);
  // The focused and selected rows never are.
  app.sidebar.highlight(app.ws.getCollection(c.id).items[260].id);
  app.sidebar.focusedId = app.ws.getCollection(c.id).items[280].id;
  app.sidebar.render();
  expect(lazy()[261]).toBe(false);
  expect(lazy()[281]).toBe(false);
  expect(lazy()[270]).toBe(true);
});

it('edits a raw body past 3 MB without highlighting or folding, and gets them back when it shrinks', async () => {
  const { request } = await import('../src/core/model.js');
  const { LARGE_DOCUMENT } = await import('../src/ui/code-editor.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const big = JSON.stringify({ data: 'x'.repeat(LARGE_DOCUMENT) });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'R', method: 'POST', body: { mode: 'raw', rawType: 'json', raw: big } }));
  const tab = app.openTab('request', r.id);
  const view = app.views.get(tab.id);
  view.showSection('body');
  const ed = view.bodyEditors[0];
  await ed.ready;
  const folding = () => !!view.el.querySelector('.cm-foldGutter');
  expect(folding()).toBe(false);
  ed.setValue('{"a": 1}');
  await Promise.resolve();
  expect(folding()).toBe(true);
  expect(tab.draft.body.raw).toBe('{"a": 1}');
  ed.setValue(big);
  await Promise.resolve();
  expect(folding()).toBe(false);
  expect(tab.draft.body.raw).toBe(big);
  // A small body starts with them.
  ed.setValue('{}');
  await Promise.resolve();
  view.reload();
  view.showSection('body');
  await view.bodyEditors[0].ready;
  expect(folding()).toBe(true);
});

it('tracks unsaved changes to a large body exactly', async () => {
  const { request } = await import('../src/core/model.js');
  const app = await makeApp();
  const c = await app.ws.addCollection({ name: 'C' });
  const raw = JSON.stringify({ data: 'x'.repeat(200000) });
  const r = await app.ws.addItem(c.id, c.id, request({ name: 'R', method: 'POST', body: { mode: 'raw', rawType: 'json', raw } }));
  const tab = app.openTab('request', r.id);
  expect(app.isDirty(tab)).toBe(false);
  // Same length, one character different.
  tab.draft.body.raw = raw.replace('xx"', 'xy"');
  expect(tab.draft.body.raw.length).toBe(raw.length);
  expect(app.isDirty(tab)).toBe(true);
  // Typed back: clean again, without a save.
  tab.draft.body.raw = raw.slice(0, -1) + '}';
  expect(app.isDirty(tab)).toBe(false);
  tab.draft.body.raw += ' ';
  expect(app.isDirty(tab)).toBe(true);
  // A short body against the long one, and a body that reads like how long ones are set aside.
  tab.draft.body.raw = '\0' + '0';
  expect(app.isDirty(tab)).toBe(true);
  tab.draft.body.raw = raw;
  tab.draft.scripts.pre = raw;
  expect(app.isDirty(tab)).toBe(true);
  tab.draft.scripts.pre = '';
  expect(app.isDirty(tab)).toBe(false);
  // Saved: clean, and the next edit is unsaved again.
  tab.draft.body.raw = `${raw} `;
  await app.saveTab(tab);
  expect(app.isDirty(tab)).toBe(false);
  tab.draft.body.raw = raw;
  expect(app.isDirty(tab)).toBe(true);
  tab.draft.body.raw = `${raw} `;
  expect(app.isDirty(tab)).toBe(false);
  // Changed elsewhere while clean: the tab follows it and stays clean.
  await app.ws.updateItem(r.id, (item) => {
    item.body.raw = `${raw}\n`;
  });
  expect(tab.draft.body.raw).toBe(`${raw}\n`);
  expect(app.isDirty(tab)).toBe(false);
  // Changed elsewhere while edited: the edit is kept and still unsaved.
  tab.draft.body.raw = 'mine';
  await app.ws.updateItem(r.id, (item) => {
    item.body.raw = `${raw}\n\n`;
  });
  expect(tab.draft.body.raw).toBe('mine');
  expect(app.isDirty(tab)).toBe(true);
  // Deleted elsewhere while edited: the tab keeps the edit as an unsaved request.
  await app.ws.removeItem(r.id);
  expect(app.tabs).toContain(tab);
  expect(tab.refId).toBe(null);
  expect(app.isDirty(tab)).toBe(true);
});

it('sends the request once signing in from its error has reloaded the app', async () => {
  const { request } = await import('../src/core/model.js');
  const KEY = 'api-client:send-after-sign-in';
  localStorage.removeItem(KEY);
  // A cancelled sign-in forgets the request.
  const cancelled = await makeApp({ session: { signedIn: false, puter: {} }, onSignIn: async () => { throw { error: 'auth_window_closed' }; } });
  const draft = cancelled.openTab('request', null, { draft: request({ url: 'https://example.com/' }) });
  await cancelled.signInAndSend(draft, 'relay');
  expect(localStorage.getItem(KEY)).toBeNull();

  const before = await makeApp({ session: { signedIn: false, puter: {} } });
  const tab = before.openTab('request', null, { draft: request({ url: 'https://example.com/' }) });
  await before.signInAndSend(tab, 'relay');
  expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({ tabId: tab.id, transport: 'relay' });

  // The reload: the same tabs, now signed in.
  const sendTab = vi.spyOn(App.prototype, 'sendTab').mockResolvedValue();
  try {
    await makeApp({ ws: before.ws, session: { signedIn: true, puter: {}, user: { username: 'u' } } });
    expect(sendTab).toHaveBeenCalledTimes(1);
    expect(sendTab.mock.calls[0][0].id).toBe(tab.id);
    expect(sendTab.mock.calls[0][1]).toEqual({ transport: 'relay' });
    expect(localStorage.getItem(KEY)).toBeNull();
    // Only once.
    await makeApp({ ws: before.ws, session: { signedIn: true, puter: {}, user: { username: 'u' } } });
    expect(sendTab).toHaveBeenCalledTimes(1);
  } finally {
    sendTab.mockRestore();
  }
});
