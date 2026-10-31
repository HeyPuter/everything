import { afterEach, describe, expect, it } from 'vitest';
import { openImport, importEntry } from '../../src/views/trip/bookings/import/index.js';
import { clearJob, getJob } from '../../src/lib/ai/import/job.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { can } from '../../src/shared/perms.js';
import { fakeAiPuter, memoryDb } from './helpers/fake-ai.js';

const SPACE = 'sp00000000000009';
const KEY = `:trips-abcdefghij:${SPACE}`;
const ALICE = '00000000-0000-4000-8000-000000000001';
let seq = 0;
const makeId = () => `5${String(++seq).padStart(15, '0')}`;
const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });
const dialog = () => [...document.querySelectorAll('[role=dialog]')].at(-1);
const byText = (root, text) => [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text);

function stubSpace({ role = 'editor', reservations = [] } = {}) {
  const res = new Map(reservations.map((item) => [item.id, item]));
  const applied = [];
  const list = (items) => ({ all: () => items });
  return {
    applied, ref: { w: 'trips-abcdefghij', s: SPACE, k: 'trip' }, state: { sync: 'synced' },
    select: { res: { all: () => [...res.values()] }, day: list([]), guest: list([]), file: list([]) },
    members: () => [{ uid: ALICE, name: 'Alice' }],
    get: (type, id) => (type === 'res' ? res.get(id) : type === 'meta' ? { title: 'NYC', start: '2026-05-03', end: '2026-05-06' } : undefined),
    can: (action) => can(role, action, {}),
    ops: { create: (t, put) => ({ opId: makeId(), t, id: makeId(), put: structuredClone(put) }) },
    async apply(ops) { for (const op of ops) { validateEntity('trip', op.t, op.put); res.set(op.id, { id: op.id, ...op.put }); } applied.push(ops); },
  };
}

afterEach(async () => {
  for (const node of document.querySelectorAll('.modal-root')) node.remove();
  await clearJob({ spaceId: KEY });
});

describe('booking import dialog', () => {
  it('reads pasted text, shows a review card and adds the approved booking', async () => {
    const fake = fakeAiPuter({ replies: [{ bookings: [{ type: 'lodging', title: 'Hotel Sol', code: 'HS-4471', start: { date: '2026-05-04' }, end: { date: '2026-05-06' } }] }] });
    const space = stubSpace();
    const entry = importEntry({ space, session: { db: memoryDb() }, puter: fake.puter });
    document.body.append(entry.element);
    openImport({ space, session: { db: memoryDb() }, puter: fake.puter, account: { username: 'alice' } });
    const root = dialog();
    expect(root.textContent).toContain('alice@puter.email');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Hotel Sol, 4–6 May, booking HS-4471';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    byText(root, 'Read 1').click();
    for (let i = 0; i < 50 && getJob(KEY)?.status !== 'review'; i++) await tick(10);
    expect(getJob(KEY).status).toBe('review');
    expect(entry.element.textContent).toContain('1 booking to review');
    const card = root.querySelector('.bi-card');
    expect(card.querySelector('.bi-card-title').textContent).toBe('Hotel Sol');
    expect(card.textContent).toContain('Will be added');
    byText(root, 'Add 1 booking').click();
    await tick(0);
    expect(space.applied).toHaveLength(1);
    expect(space.applied[0][0].put).toMatchObject({ type: 'lodging', title: 'Hotel Sol', review: true });
    expect(document.querySelector('[role=dialog]')).toBeNull();
    entry.destroy();
    entry.element.remove();
  });

  it('explains a 402 and lets the user start over', async () => {
    const fake = fakeAiPuter({ replies: [{ reject: { error: { code: 'insufficient_funds', status: 402 } } }] });
    const space = stubSpace();
    openImport({ space, session: {}, puter: fake.puter });
    const root = dialog();
    const textarea = root.querySelector('textarea');
    textarea.value = 'x';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    byText(root, 'Read 1').click();
    for (let i = 0; i < 50 && getJob(KEY)?.status === 'running'; i++) await tick(10);
    expect(root.querySelector('[role=alert]').textContent).toContain('doesn’t have enough credit');
    byText(root, 'Start over').click();
    await tick(0);
    expect(root.querySelector('textarea')).not.toBeNull();
  });

  it('hides the entry from viewers', () => {
    const entry = importEntry({ space: stubSpace({ role: 'viewer' }), session: {}, puter: {} });
    expect(entry.element.hidden).toBe(true);
    entry.destroy();
  });
});
