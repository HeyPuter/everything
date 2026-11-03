import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { newId } from '../../src/shared/ids.js';
import {
  validateTemplate, parseItems, itemsText, templateFile, templateFileName, parseTemplateFile, createTemplateStore, TEMPLATE_LIMITS,
} from '../../src/views/settings/data/templates.js';
import { createCatalogStore, readCategories, readTags } from '../../src/views/settings/data/catalog.js';
import { createVaultStore, validateDoc, VAULT_KEY } from '../../src/views/settings/data/vault.js';

const alice = { username: 'alice', uuid: '11111111-1111-4111-8111-111111111111' };
const bob = { username: 'bob', uuid: '22222222-2222-4222-8222-222222222222' };
async function personalFor(world, user = alice) {
  const puter = world.client(user);
  return { puter, personal: createPersonalStore({ puter, db: await openDatabase(user.uuid, { indexedDB: new IDBFactory() }) }) };
}
const readBlob = (blob) => new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
const beach = { kind: 'pack', name: 'Beach weekend', lists: [{ name: 'Clothes', items: [{ name: 'Swimsuit' }, { name: 'Socks', qty: 3 }] }, { name: 'Gear', items: [{ name: 'Sunscreen', grams: 120 }] }] };

describe('template values', () => {
  it('normalizes and bounds templates', () => {
    expect(validateTemplate({ ...beach, name: '  Beach\u0000 weekend ', extra: true, lists: [{ name: ' Clothes ', items: ['Hat', { name: 'Towel', qty: 1, prio: 9, grams: -1 }] }] }))
      .toEqual({ kind: 'pack', name: 'Beach  weekend', lists: [{ name: 'Clothes', items: [{ name: 'Hat' }, { name: 'Towel' }] }] });
    expect(() => validateTemplate({ ...beach, kind: 'note' })).toThrow(expect.objectContaining({ code: 'invalid_template' }));
    expect(() => validateTemplate({ ...beach, name: ' ' })).toThrow(expect.objectContaining({ code: 'template_name_required' }));
    expect(() => validateTemplate({ ...beach, lists: [{ name: '', items: [] }] })).toThrow(expect.objectContaining({ code: 'list_name_required' }));
    expect(() => validateTemplate({ ...beach, lists: [] })).toThrow(expect.objectContaining({ code: 'invalid_template' }));
    expect(() => validateTemplate({ ...beach, lists: [{ name: 'All', items: Array.from({ length: TEMPLATE_LIMITS.items + 1 }, (_, i) => `Item ${i}`) }] }))
      .toThrow(expect.objectContaining({ code: 'template_too_large' }));
    expect(validateTemplate({ kind: 'todo', name: 'Before leaving', lists: [{ name: 'Home', items: [{ name: 'Water plants', prio: 1 }] }] }).lists[0].items[0]).toEqual({ name: 'Water plants', prio: 1 });
  });
  it('edits items as lines and keeps weight and priority of unchanged names', () => {
    const previous = [{ name: 'Socks', qty: 3, grams: 50 }, { name: 'Hat', prio: 2 }];
    expect(parseItems('3x Socks\n  \n Hat \n2 × Gloves\n2x4 lumber\n1000x Too many', previous)).toEqual([
      { name: 'Socks', qty: 3, grams: 50 }, { name: 'Hat', prio: 2 }, { name: 'Gloves', qty: 2 }, { name: '2x4 lumber' }, { name: '1000x Too many' },
    ]);
    expect(itemsText([{ name: 'Socks', qty: 3 }, { name: 'Hat' }])).toBe('3x Socks\nHat');
    expect(parseItems(itemsText(beach.lists[0].items), beach.lists[0].items)).toEqual(beach.lists[0].items);
  });
  it('round-trips a template file and refuses anything else', async () => {
    const text = await readBlob(templateFile(beach));
    expect(parseTemplateFile(text)).toEqual(validateTemplate(beach));
    expect(templateFileName('Beach / weekend: "2026"')).toBe('Beach - weekend- -2026-.trips-template.json');
    expect(templateFileName('')).toBe('template.trips-template.json');
    for (const bad of ['{', JSON.stringify({ format: 'other', version: 1, template: beach }), JSON.stringify({ format: 'trips-template', version: 2, template: beach }),
      JSON.stringify({ format: 'trips-template', version: 1, template: { ...beach, kind: 'x' } })]) {
      expect(() => parseTemplateFile(bad)).toThrow(expect.objectContaining({ code: 'invalid_template_file' }));
    }
    expect(() => parseTemplateFile('x'.repeat(TEMPLATE_LIMITS.fileBytes + 1))).toThrow(expect.objectContaining({ code: 'template_file_too_large' }));
  });
});

describe('template store', () => {
  it('creates, lists, edits, renames and deletes through an index without listing KV', async () => {
    const world = createFakePuter({ users: [alice] });
    const { puter, personal } = await personalFor(world);
    const store = createTemplateStore({ personal, puter });
    const changed = vi.fn(); const off = store.subscribe(changed);
    const id = await store.create(beach);
    const second = await store.create({ kind: 'todo', name: 'Admin', lists: [{ name: 'Docs', items: ['Visa'] }] });
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: second, kind: 'todo', name: 'Admin', items: 1 }), expect.objectContaining({ id, kind: 'pack', name: 'Beach weekend', items: 3 }),
    ]);
    expect(changed).toHaveBeenCalled();
    await store.save(id, { ...beach, lists: [{ name: 'Only', items: ['Towel'] }] });
    await store.rename(id, 'Lake weekend');
    expect(await store.get(id)).toEqual({ id, kind: 'pack', name: 'Lake weekend', lists: [{ name: 'Only', items: [{ name: 'Towel' }] }] });
    expect(world.inspectKv('alice')['me:tpls'][id]).toMatchObject({ kind: 'pack', name: 'Lake weekend', items: 1 });
    await store.remove(id);
    expect(await store.get(id)).toBeNull();
    expect((await store.list()).map((entry) => entry.id)).toEqual([second]);
    expect(world.counters().calls['kv.list']).toBeUndefined();
    await expect(store.rename(id, 'Gone')).rejects.toMatchObject({ code: 'gone' });
    off();
  });
  it('ignores malformed index entries and forgets entries whose template is gone', async () => {
    const world = createFakePuter({ users: [alice] });
    const { puter, personal } = await personalFor(world);
    const ghost = newId();
    await puter.kv.set('me:tpls', { [ghost]: { kind: 'pack', name: 'Ghost', items: 2, upd: 1 }, bad: { kind: 'pack', name: 'x' }, [newId()]: { kind: 'nope', name: 'y' } });
    const store = createTemplateStore({ personal, puter });
    expect((await store.list()).map((entry) => entry.name)).toEqual(['Ghost']);
    expect(await store.get(ghost)).toBeNull();
    await store.forget(ghost);
    expect(await store.list({ fresh: true })).toEqual([]);
  });
  it('deletes a new template whose index write failed and deletes templates before their index entry', async () => {
    const world = createFakePuter({ users: [alice] });
    const { puter, personal } = await personalFor(world);
    const store = createTemplateStore({ personal, puter });
    const templates = () => Object.keys(world.inspectKv('alice')).filter((key) => key.startsWith('me:tpl:'));
    world.failNext({ method: 'kv.update', status: 500 });
    await expect(store.create(beach)).rejects.toMatchObject({ status: 500 });
    expect(templates()).toEqual([]);
    const id = await store.create(beach);
    world.failNext({ method: 'kv.remove', status: 500 });
    await expect(store.remove(id)).rejects.toMatchObject({ status: 500 });
    expect(templates()).toEqual([]);
    expect(await store.get(id)).toBeNull();
    await store.forget(id);
    expect(await store.list({ fresh: true })).toEqual([]);
  });
  it('refuses direct KV writes once the session changes', async () => {
    const world = createFakePuter({ users: [alice] });
    const { puter, personal } = await personalFor(world);
    const store = createTemplateStore({ personal, puter });
    const id = await store.create(beach);
    puter.authToken = 'another-session';
    await expect(store.remove(id)).rejects.toMatchObject({ code: 'account_changed' });
    await expect(store.forget(id)).rejects.toMatchObject({ code: 'account_changed' });
    expect(world.inspectKv('alice')[`me:tpl:${id}`]).toBeDefined();
  });
  it('shares a template between users only as a file', async () => {
    const world = createFakePuter({ users: [alice, bob] });
    const a = await personalFor(world, alice); const b = await personalFor(world, bob);
    const id = await createTemplateStore(a).create(beach);
    const file = await readBlob(templateFile(await createTemplateStore(a).get(id)));
    expect(await createTemplateStore(b).list()).toEqual([]);
    const imported = await createTemplateStore(b).create(parseTemplateFile(file));
    expect(await createTemplateStore(b).get(imported)).toMatchObject({ name: 'Beach weekend', lists: validateTemplate(beach).lists });
  });
});

describe('categories and tags', () => {
  it('validates stored values', () => {
    const id = newId();
    expect(readCategories([{ id, name: ' Food ', color: 3, icon: 'utensils' }, { id: 'x', name: 'Bad', color: 3, icon: 'utensils' }, { id: newId(), name: 'Bad', color: 9, icon: 'utensils' }, { id: newId(), name: 'Bad', color: 1, icon: 'rocket' }]))
      .toEqual([{ id, name: 'Food', color: 3, icon: 'utensils' }]);
    expect(readTags(['museum', 'Museum', ' kid  friendly ', '', 7])).toEqual(['museum', 'kid friendly']);
  });
  it('saves categories and tags, re-reading the account value before each write', async () => {
    const world = createFakePuter({ users: [alice] });
    const { personal } = await personalFor(world);
    const other = await personalFor(world);
    const store = createCatalogStore({ personal });
    await store.saveCategory({ name: 'Food', color: 2, icon: 'utensils' });
    await createCatalogStore({ personal: other.personal }).saveCategory({ name: 'Views', color: 5, icon: 'mountain' });
    const [food] = await store.categories();
    await store.saveCategory({ ...food, name: 'Eat' });
    expect((await store.categories()).map((entry) => entry.name)).toEqual(['Eat', 'Views']);
    await store.removeCategory(food.id);
    expect((await store.categories()).map((entry) => entry.name)).toEqual(['Views']);
    await store.addTag('museum'); await store.addTag('night');
    await expect(store.addTag('MUSEUM')).rejects.toMatchObject({ code: 'tag_exists' });
    await expect(store.addTag('  ')).rejects.toMatchObject({ code: 'tag_name_required' });
    await store.renameTag('night', 'late');
    await expect(store.renameTag('late', 'Museum')).rejects.toMatchObject({ code: 'tag_exists' });
    await store.removeTag('museum');
    expect(await store.tags()).toEqual(['late']);
    expect(world.inspectKv('alice')['me:tags']).toEqual(['late']);
    await expect(store.saveCategory({ name: '', color: 1, icon: 'map-pin' })).rejects.toMatchObject({ code: 'category_name_required' });
  });
  it('keeps entries this build cannot read, and fields it does not know', async () => {
    const world = createFakePuter({ users: [alice] });
    const { puter, personal } = await personalFor(world);
    const food = { id: newId(), name: 'Food', color: 2, icon: 'utensils', emoji: 'noodles' };
    const rocket = { id: newId(), name: 'Space', color: 12, icon: 'rocket' };
    const views = { id: newId(), name: 'Views', color: 5, icon: 'mountain' };
    await puter.kv.set('me:cats', [food, rocket, views]);
    await puter.kv.set('me:tags', ['museum', { name: 'night', color: 3 }, 'late']);
    const store = createCatalogStore({ personal });
    expect((await store.categories()).map((entry) => entry.name)).toEqual(['Food', 'Views']);
    await store.saveCategory({ ...food, name: 'Eat' });
    await store.removeCategory(views.id);
    await store.saveCategory({ name: 'Beach', color: 3, icon: 'waves' });
    expect(world.inspectKv('alice')['me:cats']).toEqual([{ ...food, name: 'Eat' }, rocket, expect.objectContaining({ name: 'Beach' })]);
    await store.renameTag('late', 'evening'); await store.removeTag('museum'); await store.addTag('kids');
    expect(world.inspectKv('alice')['me:tags']).toEqual([{ name: 'night', color: 3 }, 'evening', 'kids']);
  });
  it('never overwrites a catalog stored in another shape', async () => {
    const world = createFakePuter({ users: [alice] });
    const { puter, personal } = await personalFor(world);
    const stored = { [newId()]: { name: 'Food', color: 2, icon: 'utensils' } };
    await puter.kv.set('me:cats', stored);
    const store = createCatalogStore({ personal });
    expect(await store.categories()).toEqual([]);
    await expect(store.saveCategory({ name: 'Views', color: 5, icon: 'mountain' })).rejects.toMatchObject({ code: 'catalog_unreadable', status: 409 });
    expect(world.inspectKv('alice')['me:cats']).toEqual(stored);
  });
  it('serializes writes from two tabs through Web Locks', async () => {
    const world = createFakePuter({ users: [alice] });
    const tails = new Map();
    const locks = { request: vi.fn((name, task) => { const run = (tails.get(name) ?? Promise.resolve()).then(task); tails.set(name, run.catch(() => {})); return run; }) };
    const first = createCatalogStore({ ...(await personalFor(world)), locks });
    const second = createCatalogStore({ ...(await personalFor(world)), locks });
    await Promise.all([first.addTag('one'), second.addTag('two'), first.saveCategory({ name: 'A', color: 1, icon: 'map-pin' }), second.saveCategory({ name: 'B', color: 2, icon: 'map-pin' })]);
    expect(world.inspectKv('alice')['me:tags']).toEqual(['one', 'two']);
    expect(world.inspectKv('alice')['me:cats'].map((entry) => entry.name)).toEqual(['A', 'B']);
    expect(new Set(locks.request.mock.calls.map(([name]) => name))).toEqual(new Set(['trips-personal:me:tags', 'trips-personal:me:cats']));
  });
  it('keeps both of two quick edits', async () => {
    const world = createFakePuter({ users: [alice] });
    const store = createCatalogStore(await personalFor(world));
    await Promise.all([store.addTag('one'), store.addTag('two'), store.saveCategory({ name: 'A', color: 1, icon: 'map-pin' }), store.saveCategory({ name: 'B', color: 2, icon: 'map-pin' })]);
    expect(await store.tags()).toEqual(['one', 'two']);
    expect((await store.categories()).map((entry) => entry.name)).toEqual(['A', 'B']);
  });
});

describe('travel documents vault', () => {
  const passport = { type: 'passport', label: 'Passport', number: 'X1234567', holder: 'Alice', expires: '2030-01-31' };
  function vaultFor(world, user = alice) {
    const puter = world.client(user);
    const set = vi.spyOn(puter.kv, 'set');
    return { puter, set, store: createVaultStore({ puter, iterations: 2000 }) };
  }
  it('validates documents', () => {
    const id = newId();
    expect(validateDoc({ id, type: 'loyalty', label: ' Miles ', number: ' 123 ', notes: '', expires: '' })).toEqual({ id, type: 'loyalty', label: 'Miles', number: '123' });
    expect(() => validateDoc({ id, type: 'passport', label: '' })).toThrow(expect.objectContaining({ code: 'document_label_required' }));
    expect(() => validateDoc({ id, type: 'spaceship', label: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_document' }));
    expect(() => validateDoc({ id, type: 'visa', label: 'x', expires: '31/01/2030' })).toThrow(expect.objectContaining({ code: 'invalid_document' }));
  });
  it('stores plain documents privately with disableSharing', async () => {
    const world = createFakePuter({ users: [alice] });
    const { store, set } = vaultFor(world);
    expect(await store.load()).toEqual({ state: 'empty', docs: [] });
    const snapshot = await store.saveDoc(passport);
    expect(snapshot.state).toBe('plain');
    expect(set).toHaveBeenLastCalledWith(VAULT_KEY, { v: 1, docs: [expect.objectContaining({ number: 'X1234567' })] }, { disableSharing: true });
    const doc = snapshot.docs[0];
    expect((await store.saveDoc({ ...doc, label: 'Main passport' })).docs).toEqual([{ ...doc, label: 'Main passport' }]);
    expect((await store.removeDoc(doc.id)).state).toBe('empty');
  });
  it('encrypts with a passphrase that is never stored and needs it to read again', async () => {
    const world = createFakePuter({ users: [alice] });
    const { store, set } = vaultFor(world);
    await store.load(); await store.saveDoc(passport);
    const protectedSnapshot = await store.setPassphrase('correct horse');
    expect(protectedSnapshot.state).toBe('unlocked');
    const stored = world.inspectKv('alice')[VAULT_KEY];
    expect(stored).toEqual({ v: 1, enc: { alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: 2000, salt: expect.any(String), iv: expect.any(String), data: expect.any(String) } });
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain('X1234567'); expect(raw).not.toContain('correct horse');
    expect(set).toHaveBeenLastCalledWith(VAULT_KEY, stored, { disableSharing: true });
    // A second device sees it locked.
    const second = vaultFor(world).store;
    expect(await second.load()).toEqual({ state: 'locked', docs: [] });
    await expect(second.unlock('wrong passphrase')).rejects.toMatchObject({ code: 'wrong_passphrase' });
    expect((await second.unlock('correct horse')).docs[0]).toMatchObject({ number: 'X1234567' });
    await second.saveDoc({ type: 'loyalty', label: 'Miles', number: 'M-1' });
    expect(JSON.stringify(world.inspectKv('alice')[VAULT_KEY])).not.toContain('M-1');
    expect(world.inspectKv('alice')[VAULT_KEY].enc.salt).toBe(stored.enc.salt);
    expect(world.inspectKv('alice')[VAULT_KEY].enc.iv).not.toBe(stored.enc.iv);
    // The first device reloads with its key still in memory.
    expect((await store.load()).docs.map((doc) => doc.label)).toEqual(['Passport', 'Miles']);
    expect(store.lock()).toEqual({ state: 'locked', docs: [] });
    await expect(store.saveDoc(passport)).rejects.toMatchObject({ code: 'vault_locked' });
  });
  it('changes and removes the passphrase, and clears a vault whose passphrase is lost', async () => {
    const world = createFakePuter({ users: [alice] });
    const { store } = vaultFor(world);
    await store.load(); await store.saveDoc(passport);
    await expect(store.setPassphrase('short')).rejects.toMatchObject({ code: 'passphrase_too_short' });
    await store.setPassphrase('first passphrase');
    const salt = world.inspectKv('alice')[VAULT_KEY].enc.salt;
    await store.setPassphrase('second passphrase');
    expect(world.inspectKv('alice')[VAULT_KEY].enc.salt).not.toBe(salt);
    const other = vaultFor(world).store; await other.load();
    await expect(other.unlock('first passphrase')).rejects.toMatchObject({ code: 'wrong_passphrase' });
    await other.unlock('second passphrase');
    expect((await other.removePassphrase()).state).toBe('plain');
    expect(world.inspectKv('alice')[VAULT_KEY].docs[0].number).toBe('X1234567');
    // The first device still holds the old envelope, so it reloads instead of encrypting over the change.
    await expect(store.setPassphrase('third passphrase')).rejects.toMatchObject({ code: 'vault_changed', status: 409 });
    expect(store.state).toBe('plain');
    await store.setPassphrase('third passphrase');
    const lost = vaultFor(world).store; await lost.load();
    expect((await lost.clear())).toEqual({ state: 'empty', docs: [] });
    expect(world.inspectKv('alice')[VAULT_KEY]).toBeUndefined();
  });
  it('applies quick successive changes in order', async () => {
    const world = createFakePuter({ users: [alice] });
    const { store } = vaultFor(world);
    await store.load();
    await Promise.all([store.saveDoc(passport), store.saveDoc({ type: 'visa', label: 'Visa' }), store.saveDoc({ type: 'loyalty', label: 'Miles' })]);
    expect(world.inspectKv('alice')[VAULT_KEY].docs.map((doc) => doc.label)).toEqual(['Passport', 'Visa', 'Miles']);
  });
  it('refuses to overwrite a vault another session encrypted', async () => {
    const world = createFakePuter({ users: [alice] });
    const tab = vaultFor(world).store; const other = vaultFor(world).store;
    await tab.load(); await tab.saveDoc(passport);
    await other.load(); await other.saveDoc({ type: 'visa', label: 'Visa' }); await other.setPassphrase('correct horse');
    await expect(tab.saveDoc({ type: 'loyalty', label: 'Miles' })).rejects.toMatchObject({ code: 'vault_changed', status: 409 });
    expect(tab.state).toBe('locked');
    expect(world.inspectKv('alice')[VAULT_KEY].enc).toBeDefined();
    expect((await tab.unlock('correct horse')).docs.map((doc) => doc.label)).toEqual(['Passport', 'Visa']);
  });
  it('refuses to re-encrypt with a passphrase changed in another session', async () => {
    const world = createFakePuter({ users: [alice] });
    const tab = vaultFor(world).store; const other = vaultFor(world).store;
    await tab.load(); await tab.saveDoc(passport); await tab.setPassphrase('first passphrase');
    await other.load(); await other.unlock('first passphrase');
    await other.setPassphrase('second passphrase'); await other.saveDoc({ type: 'visa', label: 'Visa' });
    await expect(tab.removeDoc((await other.load()).docs[0].id)).rejects.toMatchObject({ code: 'vault_changed' });
    expect(tab.state).toBe('locked');
    await expect(tab.unlock('first passphrase')).rejects.toMatchObject({ code: 'wrong_passphrase' });
    expect((await tab.unlock('second passphrase')).docs).toHaveLength(2);
    // A save made elsewhere with the same passphrase is taken in without locking.
    await other.saveDoc({ type: 'other', label: 'Card' });
    await expect(tab.saveDoc({ type: 'loyalty', label: 'Miles' })).rejects.toMatchObject({ code: 'vault_changed' });
    expect(tab.snapshot()).toMatchObject({ state: 'unlocked', docs: [expect.anything(), expect.anything(), expect.objectContaining({ label: 'Card' })] });
  });
  it.each([
    ['an unknown cipher', { v: 1, enc: { alg: 'XChaCha20', kdf: 'PBKDF2-SHA256', iter: 600000, salt: 'c2FsdA==', iv: 'aXY=', data: 'ZGF0YQ==' } }],
    ['too many iterations', { v: 1, enc: { alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: 50_000_000, salt: 'c2FsdA==', iv: 'aXY=', data: 'ZGF0YQ==' } }],
    ['a newer version', { v: 2, docs: [] }],
    ['another shape', ['passport']],
  ])('treats %s as unreadable and only clears it', async (_, stored) => {
    const world = createFakePuter({ users: [alice] });
    const { puter, store } = vaultFor(world);
    await puter.kv.set(VAULT_KEY, stored);
    expect(await store.load()).toEqual({ state: 'unreadable', docs: [] });
    await expect(store.saveDoc(passport)).rejects.toMatchObject({ code: 'vault_unreadable', status: 409 });
    await expect(store.setPassphrase('correct horse')).rejects.toMatchObject({ code: 'vault_unreadable' });
    expect(world.inspectKv('alice')[VAULT_KEY]).toEqual(stored);
    expect(await store.clear()).toEqual({ state: 'empty', docs: [] });
    expect(world.inspectKv('alice')[VAULT_KEY]).toBeUndefined();
  });
  it('keeps documents this build cannot read, plain and encrypted', async () => {
    const world = createFakePuter({ users: [alice] });
    const { puter, store } = vaultFor(world);
    const known = { id: newId(), type: 'passport', label: 'Passport', number: 'X1', issuer: 'Office' };
    const future = { id: newId(), type: 'boardingpass', label: 'BA 117' };
    const badDate = { id: newId(), type: 'visa', label: 'Visa', expires: '31/01/2030' };
    await puter.kv.set(VAULT_KEY, { v: 1, docs: [known, future, badDate] });
    expect((await store.load()).docs.map((doc) => doc.label)).toEqual(['Passport']);
    await store.saveDoc({ ...validateDoc(known), label: 'Main passport', holder: 'Alice' });
    await store.saveDoc({ type: 'loyalty', label: 'Miles' });
    expect(world.inspectKv('alice')[VAULT_KEY].docs).toEqual([{ ...known, label: 'Main passport', holder: 'Alice' }, future, badDate, expect.objectContaining({ label: 'Miles' })]);
    await store.setPassphrase('correct horse');
    const other = vaultFor(world).store; await other.load(); await other.unlock('correct horse');
    await other.removeDoc(known.id); await other.removePassphrase();
    expect(world.inspectKv('alice')[VAULT_KEY].docs).toEqual([future, badDate, expect.objectContaining({ label: 'Miles' })]);
  });
  it('normalizes the passphrase so another keyboard can unlock', async () => {
    const world = createFakePuter({ users: [alice] });
    const { store } = vaultFor(world);
    await store.load(); await store.saveDoc(passport);
    await store.setPassphrase('caf\u00e9 au lait');
    const other = vaultFor(world).store; await other.load();
    expect((await other.unlock('cafe\u0301 au lait')).state).toBe('unlocked');
  });
  it('raises an older iteration count when unlocking', async () => {
    const world = createFakePuter({ users: [alice] });
    const old = createVaultStore({ puter: world.client(alice), iterations: 1000 });
    await old.load(); await old.saveDoc(passport); await old.setPassphrase('correct horse');
    const salt = world.inspectKv('alice')[VAULT_KEY].enc.salt;
    const { store } = vaultFor(world); await store.load();
    expect((await store.unlock('correct horse')).docs).toHaveLength(1);
    expect(world.inspectKv('alice')[VAULT_KEY].enc).toMatchObject({ iter: 2000 });
    expect(world.inspectKv('alice')[VAULT_KEY].enc.salt).not.toBe(salt);
    const later = vaultFor(world).store; await later.load();
    expect((await later.unlock('correct horse')).docs).toHaveLength(1);
  });
  it('refuses writes once the session changes and runs clear after earlier changes', async () => {
    const world = createFakePuter({ users: [alice] });
    const { puter, store } = vaultFor(world);
    await store.load();
    await Promise.all([store.saveDoc(passport), store.clear()]);
    expect(world.inspectKv('alice')[VAULT_KEY]).toBeUndefined();
    await store.saveDoc(passport);
    puter.authToken = 'another-session';
    await expect(store.saveDoc({ type: 'visa', label: 'Visa' })).rejects.toMatchObject({ code: 'account_changed' });
    await expect(store.clear()).rejects.toMatchObject({ code: 'account_changed' });
    expect(world.inspectKv('alice')[VAULT_KEY].docs).toHaveLength(1);
  });
  it('keeps the previous protection when a write fails', async () => {
    const world = createFakePuter({ users: [alice] });
    const { store } = vaultFor(world);
    await store.load(); await store.saveDoc(passport);
    world.failNext({ method: 'kv.set', status: 402 });
    await expect(store.setPassphrase('correct horse')).rejects.toMatchObject({ status: 402 });
    expect(store.state).toBe('plain');
    expect(world.inspectKv('alice')[VAULT_KEY].docs).toHaveLength(1);
  });
});
