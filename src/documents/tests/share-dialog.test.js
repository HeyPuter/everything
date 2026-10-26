// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { openShareDialog } from '../src/views/share-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { el } from '../src/ui/dom.js';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: false })); document.body.replaceChildren(el('div', { id: 'app' })); });
afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); });

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const member = (uuid, username, role) => ({ uuid, username, role });

it('shows who has access as of the latest change when two role changes overlap', async () => {
  const lists = [], roles = [];
  const session = {
    local: false, canManage: true,
    people: () => [],
    members: () => { const d = deferred(); lists.push(d); return d.promise; },
    setRole: () => { const d = deferred(); roles.push(d); return d.promise; },
  };
  openShareDialog({ local: false, live: () => session, documentName: () => 'Plan', ensureShared: async () => {} });
  lists[0].resolve({ members: [member('o', 'owner', 'owner'), member('a', 'ada', 'editor'), member('b', 'bob', 'editor')] });
  await settle();
  const list = document.querySelector('[aria-label="People with access"]');
  const role = name => list.querySelector(`select[aria-label="Access for ${name}"]`);
  const change = (name, value) => { const select = role(name); select.value = value; select.dispatchEvent(new Event('change')); };
  // Ada becomes a viewer and, before the server confirms it, Bob a commenter. Both changes reload the
  // list, and the server answers the second reload first.
  change('ada', 'viewer'); change('bob', 'commenter');
  roles[0].resolve(); await settle();
  roles[1].resolve(); await settle();
  expect(lists).toHaveLength(3);
  lists[2].resolve({ members: [member('o', 'owner', 'owner'), member('a', 'ada', 'viewer'), member('b', 'bob', 'commenter')] });
  await settle();
  lists[1].resolve({ members: [member('o', 'owner', 'owner'), member('a', 'ada', 'viewer'), member('b', 'bob', 'editor')] });
  await settle();
  expect(role('ada').value).toBe('viewer');
  expect(role('bob').value).toBe('commenter');
});
