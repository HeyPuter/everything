// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { aliasId, maskEmails, project, shareView } from '../../worker/engine/projection.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const CAROL = '00000000-0000-4000-8000-000000000003';
const GONE = '00000000-0000-4000-8000-000000000009';
const REAL_UUIDS = [ALICE, BOB, CAROL, GONE];
const id = (n) => `000000000000${String(n).padStart(4, '0')}`;
const stamps = (n, by = ALICE) => ({ v: `0000000000001:0000:node${n}`, rev: n, upd: 1000 + n, by, cr: 100 + n });

const IDS = {
  day: id(1), visit: id(2), place: id(3), note: id(4), cat: id(5), res: id(6), exp: id(7), settle: id(8), costCat: id(9),
  pack: id(10), bag: id(11), packList: id(12), todoList: id(13), msg: id(14), deletedMsg: id(15), guest: id(16), todo: id(17),
  collabNote: id(18), link: id(19), poll: id(20), preset: id(21), resNoPlace: id(22),
  coverFile: id(30), placeImg: id(31), resPdf: id(32), expReceipt: id(33), msgPhoto: id(34), trashedImg: id(35), trackFile: id(36),
  noteFile: id(37), svgCover: id(38), placeImgPdf: id(39), visitPhoto: id(40),
};

function fixture({ cover = IDS.coverFile } = {}) {
  const file = (n, fileId, extra) => ({ t: 'file', id: fileId, name: `f${n}`, mime: 'image/png', size: 100, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied', uid: CAROL }, ...stamps(n), ...extra });
  return {
    rev: 42, at: 5000, kind: 'trip',
    ents: [
      { t: 'meta', id: 'meta', title: 'Lisbon', description: 'Hi', start: '2027-05-01', end: '2027-05-04', currency: 'EUR', cover, tags: ['sun'],
        archived: false, reminderDays: [1], settings: { splitCosts: true }, perms: { 'share.manage': 'editor' }, share: { on: true, plan: true }, ...stamps(1) },
      { t: 'member', id: ALICE, name: 'alice', role: 'owner', color: 1, avatar: 'https://example.com/a.png', ...stamps(2), cr: 10 },
      { t: 'member', id: BOB, name: 'bob@example.com', role: 'editor', color: 2, ...stamps(3), cr: 20 },
      { t: 'member', id: CAROL, name: 'carol', role: 'viewer', ...stamps(4), cr: 30 },
      { t: 'member', id: GONE, deleted: true, rev: 5, v: 'x' },
      { t: 'day', id: IDS.day, order: 'a0', date: '2027-05-01', title: 'Arrive', notes: 'walk', ...stamps(5, BOB) },
      { t: 'visit', id: IDS.visit, dayId: IDS.day, placeId: IDS.place, order: 'a0', people: [BOB, IDS.guest], notes: 'go early', ...stamps(6) },
      { t: 'place', id: IDS.place, name: 'Belém', lat: 38.69, lng: -9.21, address: 'Av. Brasília', ids: { osm: 'n1' }, src: 'photon', tz: 'Europe/Lisbon',
        track: { fileId: IDS.trackFile }, img: { fileId: IDS.placeImg }, rating: { [BOB]: 5 }, tags: { [BOB]: ['secret'] }, visited: { [ALICE]: true }, ...stamps(7) },
      { t: 'place', id: id(23), name: 'PDF image', img: { fileId: IDS.placeImgPdf }, ...stamps(8) },
      { t: 'dayNote', id: IDS.note, dayId: IDS.day, order: 'a1', title: 'Lunch', ...stamps(9) },
      { t: 'cat', id: IDS.cat, name: 'Food', color: 2, icon: 'utensils', ...stamps(10) },
      { t: 'res', id: IDS.res, type: 'flight', title: 'TP1', status: 'confirmed', code: 'ABC123', notes: 'PIN 4321', url: 'https://air.example/manage?pnr=ABC123',
        people: [ALICE, BOB], location: { name: 'LIS', address: 'Airport road', lat: 38.7, lng: -9.1 }, src: { kind: 'ai', hash: 'h' }, review: true,
        legs: [{ from: { code: 'LIS', name: 'Lisbon', lat: 38.7, lng: -9.1 }, to: { code: 'OPO', lat: 41.2, lng: -8.6 }, dep: { date: '2027-05-01' }, arr: { date: '2027-05-01' }, code: 'SEAT9', seat: '9A', shape: 'abc' }],
        ...stamps(11) },
      { t: 'exp', id: IDS.exp, name: 'Taxi', amount: 1500, currency: 'EUR', payers: [{ who: BOB, amount: 1500 }],
        split: { mode: 'items', parts: [{ who: BOB }, { who: GONE }], items: [{ label: 'x', amount: 1500, who: [BOB, IDS.guest] }] },
        links: [{ t: 'res', id: IDS.res }, { t: 'note', id: IDS.collabNote }], ...stamps(12) },
      { t: 'settle', id: IDS.settle, from: BOB, to: ALICE, amount: 500, currency: 'EUR', ...stamps(13) },
      { t: 'costCat', id: IDS.costCat, cat: 'food', order: 'a0', ...stamps(14) },
      { t: 'splitPreset', id: IDS.preset, name: 'Even', weights: { [ALICE]: 1 }, ...stamps(15) },
      { t: 'pack', id: IDS.pack, name: 'Socks', order: 'a0', list: 'Clothes', vis: 'people', for: [CAROL], owner: CAROL, doneBy: { [CAROL]: true }, bring: { [BOB]: 'yes' }, ...stamps(16) },
      { t: 'bag', id: IDS.bag, name: 'Blue', order: 'a0', people: [ALICE], ...stamps(17) },
      { t: 'listMeta', id: IDS.packList, kind: 'pack', name: 'Clothes', order: 'a0', assignees: [BOB], ...stamps(18) },
      { t: 'listMeta', id: IDS.todoList, kind: 'todo', name: 'Admin', order: 'a1', ...stamps(19) },
      { t: 'todo', id: IDS.todo, name: 'Visa', order: 'a0', who: ALICE, ...stamps(20) },
      { t: 'note', id: IDS.collabNote, title: 'Secret note', author: ALICE, ...stamps(21) },
      { t: 'link', id: IDS.link, title: 'Doc', url: 'https://example.com', author: ALICE, ...stamps(22) },
      { t: 'poll', id: IDS.poll, question: 'Where?', options: ['a', 'b'], votes: { [BOB]: [0] }, ...stamps(23) },
      { t: 'guest', id: IDS.guest, name: 'Mum (mum@example.org)', color: 3, ...stamps(24) },
      { t: 'msg', id: IDS.msg, text: 'see you', react: { '👍': { [ALICE]: 1 } }, ...stamps(25, CAROL) },
      { t: 'msg', id: IDS.deletedMsg, text: '', deleted: true, author: BOB, ...stamps(26, BOB) },
      { t: 'place', id: id(24), name: 'Old', deleted: true, rev: 27, v: 'y' },
      { t: 'pack', id: id(25), name: 'Diary', order: 'a1', private: true, ...stamps(28) },
      file(30, IDS.coverFile, { links: [{ t: 'meta', id: 'meta' }] }),
      file(31, IDS.placeImg, { links: [{ t: 'place', id: IDS.place }] }),
      file(32, IDS.resPdf, { mime: 'application/pdf', linked: { [`res_${IDS.res}`]: true } }),
      file(33, IDS.expReceipt, { links: [{ t: 'exp', id: IDS.exp }] }),
      file(34, IDS.msgPhoto, { links: [{ t: 'msg', id: IDS.msg }] }),
      file(35, IDS.trashedImg, { trashed: 1, links: [{ t: 'place', id: IDS.place }] }),
      file(36, IDS.trackFile, { kind: 'track', mime: 'application/gzip', links: [{ t: 'place', id: IDS.place }] }),
      file(37, IDS.noteFile, { links: [{ t: 'note', id: IDS.collabNote }] }),
      file(38, IDS.svgCover, { mime: 'image/svg+xml' }),
      file(39, IDS.placeImgPdf, { mime: 'application/pdf' }),
      file(40, IDS.visitPhoto, { links: [{ t: 'visit', id: IDS.visit }], linked: { [`exp_${IDS.exp}`]: true } }),
    ],
  };
}

const ALL = { on: true, plan: true, map: true, bookings: true, codes: true, packing: true, costs: true, chat: true, files: true };
const NONE = { on: true };
const types = (view) => [...new Set(view.ents.map((entity) => entity.t))].sort();
const find = (view, entityId) => view.ents.find((entity) => entity.id === entityId);
const alias = (view, name) => view.members.find((member) => member.name === name)?.id;

describe('public projection: sections', () => {
  it('shows only meta, people and guests with every section off', () => {
    const view = project(fixture(), 'trip', NONE);
    expect(types(view)).toEqual(['file', 'guest']);
    expect(view.files).toEqual([IDS.coverFile]);
    expect(view.share).toEqual({ plan: false, map: false, bookings: false, codes: false, packing: false, costs: false, chat: false, files: false, road: false, cur: null, exp: null });
    expect(view.members.map((member) => member.name)).toEqual(['A.', 'B.', 'C.']);
  });

  it.each([
    ['plan', ['cat', 'day', 'dayNote', 'file', 'guest', 'place', 'visit']],
    ['bookings', ['file', 'guest', 'res']],
    ['packing', ['bag', 'file', 'guest', 'listMeta', 'pack']],
    ['costs', ['costCat', 'exp', 'file', 'guest', 'settle']],
    ['chat', ['file', 'guest', 'msg']],
  ])('section %s adds exactly its types', (toggle, expected) => {
    expect(types(project(fixture(), 'trip', { on: true, [toggle]: true }))).toEqual(expected);
  });

  it('never projects todos, collab notes, links, polls, split presets, todo lists, tombstones or private items', () => {
    const view = project(fixture(), 'trip', ALL);
    for (const type of ['todo', 'note', 'link', 'poll', 'splitPreset', 'member', 'meta']) expect(types(view)).not.toContain(type);
    expect(find(view, IDS.todoList)).toBeUndefined();
    expect(find(view, id(24))).toBeUndefined();
    expect(find(view, id(25))).toBeUndefined();
    expect(find(view, IDS.deletedMsg)).toBeUndefined();
    expect(JSON.stringify(view)).not.toMatch(/Secret note|Visa|Where\?|Diary/);
  });

  it('only keeps public meta fields and prefers the fresh meta', () => {
    const view = project(fixture(), 'trip', ALL, { meta: { title: 'Fresh', currency: 'USD', perms: {}, share: { on: true } } });
    expect(view.meta).toEqual({ title: 'Fresh', currency: 'USD' });
    const fromSnapshot = project(fixture(), 'trip', ALL);
    expect(fromSnapshot.meta).toEqual({ title: 'Lisbon', description: 'Hi', start: '2027-05-01', end: '2027-05-04', currency: 'EUR', cover: IDS.coverFile, tags: ['sun'] });
  });

  it('passes the effective expiry and a valid display currency', () => {
    expect(project(fixture(), 'trip', { ...NONE, costs: true, cur: 'USD' }, { exp: 99 }).share).toMatchObject({ costs: true, cur: 'USD', exp: 99 });
    expect(shareView('trip', { cur: 'not money' }).cur).toBeNull();
    expect(shareView('trip', { codes: true }).codes).toBe(false);
    expect(shareView('trip', { plan: true }).map).toBe(true);
    expect(shareView('trip', { plan: true, map: false }).map).toBe(false);
    expect(shareView('trip', { map: true }).map).toBe(false);
  });
});

describe('public projection: private fields', () => {
  it('strips worker stamps from every entity', () => {
    for (const entity of project(fixture(), 'trip', ALL).ents) {
      for (const key of ['by', 'v', 'rev', 'upd']) expect(entity, `${entity.t}.${key}`).not.toHaveProperty(key);
    }
  });

  it.each([
    ['place', IDS.place, ['rating', 'tags', 'visited']],
    ['pack', IDS.pack, ['doneBy', 'bring']],
    ['msg', IDS.msg, ['react']],
  ])('strips per-user fields from %s', (_type, entityId, fields) => {
    const entity = find(project(fixture(), 'trip', ALL), entityId);
    expect(entity).toBeDefined();
    for (const field of fields) expect(entity).not.toHaveProperty(field);
  });

  it('strips provenance and review flags, and place tracks even with the map on', () => {
    const view = project(fixture(), 'trip', ALL);
    expect(find(view, IDS.res)).not.toHaveProperty('src');
    expect(find(view, IDS.res)).not.toHaveProperty('review');
    expect(find(view, IDS.place)).not.toHaveProperty('src');
    expect(find(view, IDS.place)).not.toHaveProperty('track');
    expect(view.files).not.toContain(IDS.trackFile);
  });

  it('hides confirmation codes, booking notes and links unless codes are on', () => {
    const hidden = find(project(fixture(), 'trip', { ...ALL, codes: false }), IDS.res);
    for (const field of ['code', 'notes', 'url']) expect(hidden).not.toHaveProperty(field);
    expect(hidden.legs[0]).not.toHaveProperty('code');
    expect(hidden.legs[0].seat).toBe('9A');
    expect(JSON.stringify(project(fixture(), 'trip', { ...ALL, codes: false }))).not.toMatch(/ABC123|SEAT9|4321/);
    const shown = find(project(fixture(), 'trip', ALL), IDS.res);
    expect(shown).toMatchObject({ code: 'ABC123', notes: 'PIN 4321', url: 'https://air.example/manage?pnr=ABC123' });
    expect(shown.legs[0].code).toBe('SEAT9');
  });

  it('removes coordinates, addresses, provider ids and leg shapes without the map', () => {
    const view = project(fixture(), 'trip', { ...ALL, map: false });
    const place = find(view, IDS.place);
    for (const field of ['lat', 'lng', 'address', 'ids']) expect(place).not.toHaveProperty(field);
    expect(place).toMatchObject({ name: 'Belém', tz: 'Europe/Lisbon' });
    const res = find(view, IDS.res);
    expect(res.location).toEqual({ name: 'LIS' });
    expect(res.legs[0].from).toEqual({ code: 'LIS', name: 'Lisbon' });
    expect(res.legs[0].to).toEqual({ code: 'OPO' });
    expect(res.legs[0]).not.toHaveProperty('shape');
    const mapped = project(fixture(), 'trip', ALL);
    expect(find(mapped, IDS.place)).toMatchObject({ lat: 38.69, lng: -9.21, address: 'Av. Brasília', ids: { osm: 'n1' } });
    expect(find(mapped, IDS.res).legs[0]).toMatchObject({ shape: 'abc', from: { lat: 38.7 } });
  });

  it('keeps the map on for shares made before the toggle existed', () => {
    expect(find(project(fixture(), 'trip', { on: true, plan: true }), IDS.place).lat).toBe(38.69);
  });
});

describe('public projection: files', () => {
  it('serves raster cover and place images without the files toggle, nothing else', () => {
    const view = project(fixture(), 'trip', { on: true, plan: true, bookings: true, costs: true, chat: true });
    expect(view.files.sort()).toEqual([IDS.coverFile, IDS.placeImg].sort());
    expect(find(view, id(23))).not.toHaveProperty('img');
  });

  it('drops a cover that is not a raster image or is trashed', () => {
    expect(project(fixture({ cover: IDS.svgCover }), 'trip', NONE)).toMatchObject({ files: [], meta: expect.not.objectContaining({ cover: expect.anything() }) });
    expect(project(fixture({ cover: IDS.trashedImg }), 'trip', NONE).files).toEqual([]);
    expect(project(fixture({ cover: { url: 'https://images.example/x.jpg', credit: 'A' } }), 'trip', NONE).meta.cover).toEqual({ url: 'https://images.example/x.jpg', credit: 'A' });
  });

  it('adds user files linked to projected entities with the files toggle', () => {
    const view = project(fixture(), 'trip', ALL);
    expect(view.files.sort()).toEqual([IDS.coverFile, IDS.placeImg, IDS.resPdf, IDS.expReceipt, IDS.msgPhoto, IDS.visitPhoto].sort());
    for (const hidden of [IDS.trashedImg, IDS.trackFile, IDS.noteFile, IDS.svgCover, IDS.placeImgPdf]) expect(view.files).not.toContain(hidden);
  });

  it('only links files to sections that are shared', () => {
    const view = project(fixture(), 'trip', { on: true, plan: true, files: true });
    expect(view.files).not.toContain(IDS.resPdf);
    expect(view.files).not.toContain(IDS.expReceipt);
    expect(view.files).not.toContain(IDS.msgPhoto);
    expect(find(view, IDS.visitPhoto).links).toEqual([{ t: 'visit', id: IDS.visit }]);
  });

  it('describes files by name, type and size only', () => {
    const file = find(project(fixture(), 'trip', ALL), IDS.resPdf);
    expect(file).toEqual({ t: 'file', id: IDS.resPdf, name: 'f32', mime: 'application/pdf', size: 100, links: [{ t: 'res', id: IDS.res }] });
  });

  it('filters expense links to projected entities', () => {
    expect(find(project(fixture(), 'trip', ALL), IDS.exp).links).toEqual([{ t: 'res', id: IDS.res }]);
    expect(find(project(fixture(), 'trip', { on: true, costs: true }), IDS.exp).links).toEqual([]);
  });
});

describe('public projection: people', () => {
  it('replaces every member uuid with a stable alias', () => {
    const view = project(fixture(), 'trip', ALL);
    const text = JSON.stringify(view);
    for (const uuid of REAL_UUIDS) expect(text).not.toContain(uuid);
    expect(view.members).toEqual([{ id: aliasId(1), name: 'A.', color: 1 }, { id: aliasId(2), name: 'B.', color: 2 }, { id: aliasId(3), name: 'C.' }]);
    const [a, b, c] = [alias(view, 'A.'), alias(view, 'B.'), alias(view, 'C.')];
    expect(find(view, IDS.visit).people).toEqual([b, IDS.guest]);
    expect(find(view, IDS.res).people).toEqual([a, b]);
    const exp = find(view, IDS.exp);
    expect(exp.payers).toEqual([{ who: b, amount: 1500 }]);
    expect(exp.split.items[0].who).toEqual([b, IDS.guest]);
    expect(find(view, IDS.settle)).toMatchObject({ from: b, to: a });
    expect(find(view, IDS.pack)).toMatchObject({ for: [c], owner: c });
    expect(find(view, IDS.bag).people).toEqual([a]);
    expect(find(view, IDS.packList).assignees).toEqual([b]);
  });

  it('gives former members an alias without a name', () => {
    const view = project(fixture(), 'trip', ALL);
    const former = find(view, IDS.exp).split.parts[1].who;
    expect(former).toBe(aliasId(4));
    expect(view.members.some((member) => member.id === former)).toBe(false);
  });

  it('attributes messages without an author field and aliases them', () => {
    const view = project(fixture(), 'trip', { on: true, chat: true });
    expect(find(view, IDS.msg).author).toBe(alias(view, 'C.'));
  });

  it('masks email-shaped names and drops member avatars', () => {
    const view = project(fixture(), 'trip', ALL);
    expect(JSON.stringify(view)).not.toMatch(/example\.(com|org)\b(?!\/)/);
    expect(find(view, IDS.guest).name).toBe('Mum (m…)');
    expect(view.members.every((member) => !('avatar' in member))).toBe(true);
    expect(maskEmails('reach a.b@c.io now')).toBe('reach a… now');
  });

  it('aliases the same uuid the same way across sections and stays deterministic', () => {
    const first = project(fixture(), 'trip', ALL);
    const second = project(fixture(), 'trip', ALL);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
