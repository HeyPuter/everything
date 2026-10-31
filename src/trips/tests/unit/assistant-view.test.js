import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { createCommandRegistry } from '../../src/views/registry/commands.js';
import { openAssistant, closeAssistant, registerAssistantCommand } from '../../src/views/trip/assistant/index.js';

const ME = '00000000-0000-4000-8000-000000000001';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let seq = 0;
const makeId = () => `5${String(++seq).padStart(15, '0')}`;
const clock = createClock({ node: '0000000000000009', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: ME, cr: 1000 });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const opened = [];

async function setup(rounds, { role = 'owner' } = {}) {
  const world = createFakePuter({ users: [{ uuid: ME, username: 'me' }] });
  const puter = world.client(ME);
  const db = await openDatabase(ME, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
  const space = await openSpace({ ref, db, api, puter, personal: createPersonalStore({ puter, db }), role, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false, autoStart: false });
  await space.store.replace({ rev: 1, ents: [
    server('meta', 'meta', { title: 'Lisbon', currency: 'EUR', start: '2027-05-01', end: '2027-05-02' }),
    server('day', 'd000000000000001', { order: 'a1', date: '2027-05-01' }),
    server('day', 'd000000000000002', { order: 'a2', date: '2027-05-02' }),
  ] });
  opened.push({ db, space });
  let round = 0;
  const assistantChat = vi.fn(() => {
    const parts = rounds[round++] ?? [{ type: 'text', text: 'Done.' }];
    return (async function* replies() { for (const part of parts) { if (part instanceof Error) throw part; yield part; } })();
  });
  const commands = createCommandRegistry([]);
  return { space, context: { space, account: { uuid: ME }, puter, app: { navigate: vi.fn(), commands }, assistantChat }, commands };
}
afterEach(() => {
  closeAssistant();
  for (const { db, space } of opened.splice(0)) { space.close(); db.close(); }
  document.body.replaceChildren();
});

describe('assistant panel', () => {
  it('chats, shows a proposal as a diff and applies it only after approval', async () => {
    const { space, context } = await setup([
      [{ type: 'text', text: 'Here is a plan.' }, { type: 'tool', id: 'c1', name: 'propose_add_todos', input: { items: [{ name: 'Book <b>museum</b>', due: '2027-04-20' }] } }],
      [{ type: 'text', text: 'Added.' }],
    ]);
    openAssistant(context);
    const panel = document.querySelector('.as-panel');
    expect(panel.querySelector('.as-empty')).not.toBeNull();
    panel.querySelector('.as-input').value = 'Add a to-do';
    panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const card = panel.querySelector('.as-card');
    expect(card.dataset.status).toBe('waiting');
    expect(card.querySelector('.as-row').textContent).toContain('Book <b>museum</b>');
    expect(card.querySelector('b')).toBeNull();
    expect(space.select.todo.all()).toHaveLength(0);
    card.querySelector('[data-action="approve"]').click();
    await settle();
    expect(space.select.todo.all().map((todo) => todo.name)).toEqual(['Book <b>museum</b>']);
    expect(panel.querySelector('.as-card').dataset.status).toBe('applied');
    expect(panel.textContent).toContain('Added.');
    panel.querySelector('[data-action="undo"]').click();
    await settle();
    expect(space.select.todo.all()).toHaveLength(0);
    expect(panel.querySelector('.as-card').textContent).toContain('Undone');
  });

  it('explains running out of credit and offers no retry for it', async () => {
    const { context } = await setup([[Object.assign(new Error('insufficient funds'), { status: 402 })]]);
    openAssistant(context);
    const panel = document.querySelector('.as-panel');
    panel.querySelector('.as-input').value = 'Hi';
    panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(panel.querySelector('.as-error').textContent).toContain('out of Puter credit');
    expect(panel.querySelector('.as-error button')).toBeNull();
  });

  it('registers the palette command once per registry and stops a waiting proposal on close', async () => {
    const { space, context, commands } = await setup([[{ type: 'tool', id: 'c1', name: 'propose_add_todos', input: { items: [{ name: 'Pack' }] } }]]);
    const off1 = registerAssistantCommand(context);
    const off2 = registerAssistantCommand(context);
    expect(commands.list().filter((command) => command.id === 'trip-assistant')).toHaveLength(1);
    await commands.get('trip-assistant').run();
    const panel = document.querySelector('.as-panel');
    expect(panel).not.toBeNull();
    panel.querySelector('.as-input').value = 'Add';
    panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(document.querySelector('.as-panel')).toBeNull();
    expect(space.select.todo.all()).toHaveLength(0);
    off1(); off2();
    expect(commands.get('trip-assistant')).toBeUndefined();
  });
});
