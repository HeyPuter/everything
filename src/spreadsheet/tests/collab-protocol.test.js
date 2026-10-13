import { describe, expect, it } from 'vitest';
import { validateChange, mapLine, mapCellKey, mapGap, transformStructure, OpError } from '../src/collab/ops.js';
import { shareLink, parseLiveHash, PERSON_COLORS, colorFor, initials, packState, unpackState, keyPair, sign, verify, topology } from '../src/collab/protocol.js';
import { sanitizeState } from '../src/collab/server/service.js';
import { call } from '../src/collab/api.js';
import { RoomClient } from '../src/collab/client.js';
import { Workbook } from '../src/core/workbook.js';
import { environment, owner, editor, SERVER } from './collab-helpers.js';

const change = (ops) => ({ id: 'abcdefgh1234', label: 'Edit', ops });

describe('change validation', () => {
  it('accepts every kind of operation', () => {
    expect(() => validateChange(change([
      { t: 'cells', s: 's1', v: { '0,0': { v: 1, f: null }, '3,2': null }, st: { '0,0': { bold: true, fill: null } } },
      { t: 'props', s: 's1', v: { merges: [], frozenRows: 1 } },
      { t: 'lines', s: 's1', p: 'colWidths', v: { 3: 120, 4: null } },
      { t: 'lines', s: 's1', p: 'notes', v: { '2,2': 'hi' } },
      { t: 'book', v: { names: [] } },
      { t: 'insert', s: 's1', axis: 'row', at: 4, n: 2 },
      { t: 'delete', s: 's1', axis: 'col', runs: [{ from: 1, to: 3 }] },
      { t: 'move', s: 's1', axis: 'row', from: 1, count: 2, to: 9 },
      { t: 'rename', s: 's1', name: 'Data' },
      { t: 'order', s: 's1', to: 2 },
      { t: 'drop', s: 's1' },
      { t: 'put', s: 's2', at: 1, sheet: { name: 'New', cells: { '0,0': { v: 'x' } } } },
    ]))).not.toThrow();
  });

  it.each([
    ['an unknown operation', { t: 'eval', s: 's1' }],
    ['a cell outside the grid', { t: 'cells', s: 's1', v: { '1048576,0': { v: 1 } } }],
    ['a malformed cell key', { t: 'cells', s: 's1', v: { 'A1': { v: 1 } } }],
    ['a style inside content', { t: 'cells', s: 's1', v: { '0,0': { v: 1, s: { bold: true } } } }],
    ['an unshared sheet setting', { t: 'props', s: 's1', v: { viewSelection: {} } }],
    ['an unknown line setting', { t: 'lines', s: 's1', p: '__proto__', v: {} }],
    ['an unknown book setting', { t: 'book', v: { activeSheetId: 'x' } }],
    ['a negative insertion', { t: 'insert', s: 's1', axis: 'row', at: -1, n: 1 }],
    ['an inverted deletion run', { t: 'delete', s: 's1', axis: 'row', runs: [{ from: 5, to: 2 }] }],
    ['a bad axis', { t: 'insert', s: 's1', axis: 'diagonal', at: 1, n: 1 }],
    ['a long sheet name', { t: 'rename', s: 's1', name: 'x'.repeat(40) }],
  ])('refuses %s', (_, op) => {
    expect(() => validateChange(change([op]))).toThrow(OpError);
  });

  it('refuses a change without an id or operations', () => {
    expect(() => validateChange({ id: 'x', ops: [] })).toThrow(OpError);
    expect(() => validateChange({ id: 'abcdefgh1234', ops: [] })).toThrow(OpError);
  });
});

describe('positions through structure', () => {
  const ins = { t: 'insert', s: 'a', axis: 'row', at: 3, n: 2 };
  const del = { t: 'delete', s: 'a', axis: 'row', runs: [{ from: 2, to: 4 }] };
  const mov = { t: 'move', s: 'a', axis: 'row', from: 1, count: 2, to: 6 };
  it('maps lines and cells', () => {
    expect([0, 2, 3, 9].map((i) => mapLine(ins, 'a', 'row', i))).toEqual([0, 2, 5, 11]);
    expect([1, 2, 4, 5, 9].map((i) => mapLine(del, 'a', 'row', i))).toEqual([1, -1, -1, 2, 6]);
    expect([0, 1, 2, 3, 5, 6].map((i) => mapLine(mov, 'a', 'row', i))).toEqual([0, 4, 5, 1, 3, 6]);
    expect(mapLine(ins, 'b', 'row', 5)).toBe(5);
    expect(mapLine(ins, 'a', 'col', 5)).toBe(5);
    expect(mapCellKey(ins, 'a', '3,1')).toBe('5,1');
    expect(mapCellKey(del, 'a', '3,1')).toBe(null);
    expect(mapCellKey({ t: 'drop', s: 'a' }, 'a', '0,0')).toBe(null);
    expect(mapGap(del, 'a', 'row', 3)).toBe(2);
  });

  it('transforms insertions and deletions against each other', () => {
    const [a, b] = transformStructure({ t: 'insert', s: 'a', axis: 'row', at: 5, n: 1 }, { t: 'insert', s: 'a', axis: 'row', at: 2, n: 3 });
    expect(a).toEqual([{ t: 'insert', s: 'a', axis: 'row', at: 8, n: 1 }]);
    expect(b).toEqual([{ t: 'insert', s: 'a', axis: 'row', at: 2, n: 3 }]);
    const [d, i] = transformStructure({ t: 'delete', s: 'a', axis: 'row', runs: [{ from: 2, to: 6 }] }, { t: 'insert', s: 'a', axis: 'row', at: 4, n: 2 });
    expect(d).toEqual([{ t: 'delete', s: 'a', axis: 'row', runs: [{ from: 2, to: 3 }, { from: 6, to: 8 }] }]);
    expect(i).toEqual([{ t: 'insert', s: 'a', axis: 'row', at: 2, n: 2 }]);
    const [x, y] = transformStructure({ t: 'delete', s: 'a', axis: 'row', runs: [{ from: 1, to: 3 }] }, { t: 'delete', s: 'a', axis: 'row', runs: [{ from: 2, to: 5 }] });
    expect(x).toEqual([{ t: 'delete', s: 'a', axis: 'row', runs: [{ from: 1, to: 1 }] }]);
    expect(y).toEqual([{ t: 'delete', s: 'a', axis: 'row', runs: [{ from: 1, to: 2 }] }]);
  });

  it('drops operations on a sheet someone deleted', () => {
    expect(transformStructure({ t: 'insert', s: 'a', axis: 'row', at: 1, n: 1 }, { t: 'drop', s: 'a' })).toEqual([[], [{ t: 'drop', s: 'a' }]]);
  });
});

describe('protocol', () => {
  it('builds and reads invitation links, and refuses other servers', () => {
    const link = shareLink('https://sheets.example/app/', { server: 'https://spreadsheet-abc.puter.work', room: 'r00m', token: 'a'.repeat(72) });
    expect(link).toMatch(/#\/live\/r00m\?server=/);
    expect(parseLiveHash(new URL(link).hash)).toEqual({ server: 'https://spreadsheet-abc.puter.work', room: 'r00m', token: 'a'.repeat(72) });
    expect(parseLiveHash('#/edit/x.xlsx')).toBe(null);
    expect(() => parseLiveHash('#/live/r00m?server=https://evil.example')).toThrow();
    expect(() => parseLiveHash('#/live/r00m?server=https://x.puter.work&invite=%3Cscript%3E')).toThrow();
  });

  it('gives people colors white text reads on, and initials', () => {
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const c of PERSON_COLORS) expect(1.05 / (lum(c) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(colorFor('x')).toBe(colorFor('x'));
    expect(initials('ana maria')).toBe('AM');
    expect(initials('bob')).toBe('B');
    expect(initials('')).toBe('?');
  });

  it('packs workbook states and signs values', async () => {
    const state = { sheets: [{ name: 'A', cells: { '0,0': { v: 1 } } }] };
    expect(await unpackState(await packState(state))).toEqual(state);
    const keys = await keyPair();
    const sig = await sign(keys.privateKey, { a: 1 });
    expect(await verify(keys.publicKey, { a: 1 }, sig)).toBe(true);
    expect(await verify(keys.publicKey, { a: 2 }, sig)).toBe(false);
  });

  it('links small rooms fully and large ones through relays', () => {
    const small = topology(Array.from({ length: 5 }, (_, i) => ({ session: `s${i}` })));
    expect(small.edges.get('s0').size).toBe(4);
    const big = topology(Array.from({ length: 40 }, (_, i) => ({ session: `s${String(i).padStart(2, '0')}` })));
    expect(big.relays.size).toBe(4);
    expect(big.edges.get('s10').size).toBe(2);
  });

  it('keeps only well-formed presence', () => {
    expect(sanitizeState({ sheet: 's1', sel: { r1: 1, c1: 1, r2: 3, c2: 2 }, active: { r: 1, c: 1 }, editing: true, extra: 'x' }))
      .toEqual({ sheet: 's1', sel: { r1: 1, c1: 1, r2: 3, c2: 2 }, active: { r: 1, c: 1 }, editing: true });
    expect(sanitizeState({ sheet: 's1', sel: { r1: 3, c1: 1, r2: 1, c2: 2 } }).sel).toBe(null);
    expect(sanitizeState({ sel: {} })).toBe(null);
  });
});

describe('worker permission checks', () => {
  async function room() {
    const env = environment();
    const wb = new Workbook({ sheets: [{ name: 'S' }] });
    const id = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'S' });
    return { env, id };
  }

  it('lets only its owner create rooms on a worker', async () => {
    const { env } = await room();
    await expect(RoomClient.create({ puter: env.sdk(editor), server: SERVER, wb: new Workbook(), name: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses expired and revoked invitations, but not to existing members', async () => {
    const { env, id } = await room();
    const { token } = await call(env.sdk(owner), SERVER, { op: 'invite', room: id, role: 'editor', days: 1 });
    env.now += 2 * 86_400_000;
    await expect(call(env.sdk(editor), SERVER, { op: 'join', room: id, token })).rejects.toMatchObject({ status: 403 });
    const fresh = (await call(env.sdk(owner), SERVER, { op: 'invite', room: id, role: 'editor' })).token;
    await call(env.sdk(editor), SERVER, { op: 'join', room: id, token: fresh });
    await call(env.sdk(owner), SERVER, { op: 'revoke-invites', room: id });
    // Revoking links stops new joins, not a member.
    await expect(call(env.sdk(editor), SERVER, { op: 'join', room: id, token: fresh })).resolves.toMatchObject({ role: 'editor' });
  });

  it('admits someone invited by username, with that role', async () => {
    const { env, id } = await room();
    await call(env.sdk(owner), SERVER, { op: 'invite-user', room: id, username: '@bob', role: 'viewer' });
    await expect(call(env.sdk(editor), SERVER, { op: 'join', room: id })).resolves.toMatchObject({ role: 'viewer' });
  });

  it('refuses malformed changes and stale bases, and orders commits', async () => {
    const { env, id } = await room();
    const sheet = (await call(env.sdk(owner), SERVER, { op: 'load', room: id })).state && 's';
    await expect(call(env.sdk(owner), SERVER, { op: 'commit', room: id, base: 0, changes: [change([{ t: 'eval' }])] })).rejects.toMatchObject({ status: 400 });
    const ok = await call(env.sdk(owner), SERVER, { op: 'commit', room: id, base: 0, changes: [change([{ t: 'cells', s: sheet, v: { '0,0': { v: 1, f: null } } }])] });
    expect(ok).toMatchObject({ accepted: true, rev: 1 });
    const late = await call(env.sdk(owner), SERVER, { op: 'commit', room: id, base: 0, changes: [{ ...change([{ t: 'cells', s: sheet, v: { '0,1': { v: 2, f: null } } }]), id: 'zzzzzzzz9999' }] });
    expect(late).toMatchObject({ accepted: false, head: 1 });
    expect(late.records.map((r) => r.rev)).toEqual([1]);
    await expect(call(env.sdk(owner), SERVER, { op: 'commit', room: id, base: 7, changes: [change([{ t: 'drop', s: sheet }])] })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a request whose signature does not match its body', async () => {
    const { env, id } = await room();
    const sdk = env.sdk(owner);
    const exec = sdk.workers.exec;
    sdk.workers.exec = (url, options) => exec(url, { ...options, body: options.body.replace('"sync"', '"members"') });
    await expect(call(sdk, SERVER, { op: 'sync', room: id, since: 0 })).rejects.toMatchObject({ status: 401 });
  });
});

describe('colors for people present together', () => {
  it('gives everyone in the room a different color while the palette lasts, the same in every browser', async () => {
    const { colorsFor, PERSON_COLORS } = await import('../src/collab/protocol.js');
    const ids = Array.from({ length: PERSON_COLORS.length }, (_, i) => `user-${i}`);
    const colors = colorsFor(ids);
    expect(new Set(colors.values()).size).toBe(PERSON_COLORS.length);
    expect(colorsFor([...ids].reverse())).toEqual(colors);
  });
});
