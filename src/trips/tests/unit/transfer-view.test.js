import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transferSection, watchTransfer } from '../../src/views/trip/transfer/index.js';
import { resetJobs } from '../../src/views/trip/transfer/deps.js';
import { resetNotices } from '../../src/views/trip/transfer/notice.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const CAROL = '00000000-0000-4000-8000-000000000003';
const ref = { w: 'trips-aaaaaaaaaa', s: '0000000000000001', k: 'trip' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

function memoryDb() {
  const map = new Map();
  return {
    get: async (key) => map.get(key), put: async (key, value) => { map.set(key, value); }, remove: async (key) => { map.delete(key); },
    update: async (key, change) => { const value = change(map.get(key)); if (value === undefined) map.delete(key); else map.set(key, value); return value; },
  };
}

function stubSpace(meta) {
  const listeners = new Set();
  let current = meta;
  return {
    ref,
    members: () => [{ uid: ALICE, name: 'alice', role: 'owner' }, { uid: BOB, name: 'bob', role: 'editor' }, { uid: CAROL, name: 'carol', role: 'viewer' }],
    get: (t) => (t === 'meta' ? current : null),
    subscribe: (_, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    conflicts: () => [], resolveConflict: vi.fn(async () => null), sync: vi.fn(async () => {}),
    setMeta(next) { current = next; for (const fn of listeners) fn({}); },
  };
}

function context(uid, meta, { request = vi.fn(), call = vi.fn(async () => ({})) } = {}) {
  const space = stubSpace(meta);
  const personal = { spaces: { upsert: vi.fn(async () => {}), remove: vi.fn(async () => {}) } };
  return {
    space, account: { uuid: uid }, app: { navigate: vi.fn(), commands: null },
    session: { api: { call, request }, db: memoryDb(), personal, deployer: { ensure: vi.fn(async () => ({ worker: { name: 'trips-bbbbbbbbbb' } })) } },
  };
}

beforeEach(() => { document.body.replaceChildren(); resetJobs(); resetNotices(); });
afterEach(() => { document.body.replaceChildren(); });

describe('transfer UI', () => {
  it('lets the owner offer the trip to a member', async () => {
    const ctx = context(ALICE, { title: 'Lisbon', currency: 'EUR' });
    const section = transferSection(ctx);
    document.body.append(section.element);
    await settle();
    expect(section.element.hidden).toBe(false);
    [...section.element.querySelectorAll('button')].find((node) => node.textContent === 'Transfer ownership…').click();
    const options = [...document.querySelectorAll('.transfer-option-name')].map((node) => node.textContent);
    expect(options).toEqual(['bob', 'carol']);
    document.querySelectorAll('.transfer-option input')[1].click();
    const offer = [...document.querySelectorAll('.modal-actions button')].find((node) => node.textContent === 'Offer to carol');
    offer.click();
    await settle();
    expect(ctx.session.api.call).toHaveBeenCalledWith(ref, 'transfer.offer', { to: CAROL });
    section.destroy();
  });

  it('shows the offered member the offer, and other members nothing to act on', async () => {
    const meta = { title: 'Lisbon', currency: 'EUR', transfer: { to: BOB, name: 'bob', by: ALICE, at: 1, exp: Date.now() + 86_400_000, state: 'offered' } };
    const bob = watchTransfer(context(BOB, meta));
    expect(bob.element.hidden).toBe(false);
    expect(bob.element.textContent).toContain('alice offered you ownership');
    const carol = watchTransfer(context(CAROL, meta));
    expect(carol.element.hidden).toBe(true);
    const moving = watchTransfer(context(CAROL, { ...meta, transfer: { ...meta.transfer, state: 'moving' } }));
    expect(moving.element.dataset.tone).toBe('warn');
    expect(moving.element.textContent).toContain('read-only');
  });

  it('follows a moved trip: rejoins, swaps the trip index and opens the new trip', async () => {
    const request = vi.fn(async () => ({ ok: true, space: ref.s, kind: 'trip', role: 'viewer', rev: 3, files: { mode: 'proxied' } }));
    const ctx = context(CAROL, { title: 'Lisbon', currency: 'EUR', movedTo: { w: 'trips-bbbbbbbbbb', s: ref.s, at: 1, name: 'bob' } }, { request });
    const notice = watchTransfer(ctx);
    document.body.append(notice.element);
    await settle();
    expect(JSON.parse(request.mock.calls[0][1])).toEqual({ space: ref.s, op: 'transfer.join' });
    expect(request.mock.calls[0][0]).toBe('trips-bbbbbbbbbb');
    expect(ctx.session.personal.spaces.upsert).toHaveBeenCalledWith(expect.objectContaining({ ref: { w: 'trips-bbbbbbbbbb', s: ref.s, k: 'trip' }, role: 'viewer', title: 'Lisbon' }));
    expect(ctx.session.personal.spaces.remove).toHaveBeenCalledWith(ref);
    expect(ctx.app.navigate).toHaveBeenCalledWith(`#/t/trips-bbbbbbbbbb/${ref.s}/plan`, { replace: true });
  });

  it('tells a member without a seat whom to ask', async () => {
    const request = vi.fn(async () => { throw Object.assign(new Error('seat_invalid'), { status: 404, code: 'seat_invalid', reason: 'invalid' }); });
    const notice = watchTransfer(context(CAROL, { title: 'Lisbon', currency: 'EUR', movedTo: { w: 'trips-bbbbbbbbbb', s: ref.s, at: 1, name: 'bob' } }, { request }));
    await settle();
    expect(notice.element.textContent).toContain('Ask bob to invite you');
  });

  it('stops when the offer was withdrawn before the new owner accepted', async () => {
    const meta = { title: 'Lisbon', currency: 'EUR', transfer: { to: BOB, name: 'bob', by: ALICE, at: 1, exp: Date.now() + 86_400_000, state: 'offered' } };
    const request = vi.fn(async () => { throw Object.assign(new Error('no_offer'), { status: 404, code: 'no_offer' }); });
    const ctx = context(BOB, meta, { request });
    const notice = watchTransfer(ctx);
    document.body.append(notice.element);
    [...notice.element.querySelectorAll('button')].find((node) => node.textContent === 'Review offer').click();
    expect(document.querySelector('.transfer-bring').textContent).toContain('alice (current owner, becomes an editor)');
    [...document.querySelectorAll('.modal-actions button')].find((node) => node.textContent === 'Accept and move').click();
    await settle();
    expect(document.querySelector('.transfer-status').textContent).toContain('withdrew the offer');
    expect(await ctx.session.db.get(`transfer:${ref.s}`)).toBeUndefined();
  });
});
