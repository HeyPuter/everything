// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  appendOrders, bagTotals, dueReminders, groupLists, inMyList, isMineTodo, listAssignees, localToday, matchesTodoFilter, moveOrders,
  nextColor, packState, parseImport, parseQuantity, parseWeightText, planImport, progress, rowsFromTemplate, sortTodos, splitLine,
  templateFromGroups, todoFlags, ORDER_MAX,
} from '../../src/views/trip/lists/model.js';
import { isOrder, orderKeys } from '../../src/shared/order.js';
import { validateTemplate } from '../../src/views/settings/data/templates.js';

const me = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
let seq = 0;
const makeId = () => `b${String(++seq).padStart(15, '0')}`;

describe('grouping', () => {
  it('orders listMeta lists first, folds duplicate names and puts unnamed items last', () => {
    const metas = [
      { id: 'm2', kind: 'pack', name: 'Toiletries', order: 'b' },
      { id: 'm1', kind: 'pack', name: 'Clothes', order: 'a' },
      { id: 'm3', kind: 'pack', name: ' clothes ', order: 'c' },
      { id: 'm4', kind: 'todo', name: 'Clothes', order: 'd' },
    ];
    const items = [
      { id: 'i1', name: 'Socks', list: 'CLOTHES', order: 'b' },
      { id: 'i2', name: 'Shirt', list: 'Clothes', order: 'a' },
      { id: 'i3', name: 'Charger', list: 'Tech', order: 'a' },
      { id: 'i4', name: 'Snacks', order: 'a' },
      { id: 'i5', name: 'Book', list: 'Books', order: 'a' },
    ];
    const groups = groupLists(metas, items, 'pack');
    expect(groups.map((group) => group.name)).toEqual(['Clothes', 'Toiletries', 'Books', 'Tech', '']);
    expect(groups[0].dupes.map((meta) => meta.id)).toEqual(['m3']);
    expect(groups[0].items.map((item) => item.id)).toEqual(['i2', 'i1']);
  });

  it('merges assignees per list name and picks the least used color', () => {
    const metas = [{ kind: 'pack', name: 'Kitchen', assignees: [me] }, { kind: 'pack', name: 'kitchen', assignees: [bob, me] }, { kind: 'todo', name: 'Kitchen', assignees: [bob] }];
    expect(listAssignees(metas, 'pack').get('kitchen')).toEqual([me, bob]);
    expect(nextColor([1, 2, 2, 3])).toBe(4);
    expect(nextColor([1, 2, 3, 4, 5, 6, 7, 8, 1])).toBe(2);
  });
});

describe('packing state', () => {
  const shared = { id: 'a', name: 'Tent', done: true, doneBy: { [bob]: true } };
  const assigned = { id: 'b', name: 'Stove', vis: 'people', for: [bob], doneBy: { [bob]: true } };
  it('uses the shared check unless the trip checks per person', () => {
    expect(packState(shared, { uid: me })).toEqual({ relevant: true, done: true });
    expect(packState(shared, { uid: me, perPerson: true })).toEqual({ relevant: true, done: false });
    expect(packState({ ...shared, private: true, done: false }, { uid: me, perPerson: true })).toEqual({ relevant: true, done: false });
  });
  it('treats items assigned to others as theirs in per-person mode', () => {
    expect(packState(assigned, { uid: me, perPerson: true })).toEqual({ relevant: false, done: true });
    expect(packState(assigned, { uid: bob, perPerson: true })).toEqual({ relevant: true, done: true });
    expect(progress([shared, assigned], { uid: me, perPerson: true })).toEqual({ done: 0, total: 1 });
    expect(progress([shared, assigned], { uid: me })).toEqual({ done: 1, total: 2 });
  });
  it('puts private, assigned, pledged and list-assigned items in my list', () => {
    const assignees = new Map([['kitchen', [me]]]);
    expect(inMyList({ private: true }, me)).toBe(true);
    expect(inMyList({ vis: 'people', for: [me] }, me)).toBe(true);
    expect(inMyList({ bring: { [me]: 'maybe' } }, me)).toBe(true);
    expect(inMyList({ list: ' Kitchen' }, me, assignees)).toBe(true);
    expect(inMyList({ vis: 'people', for: [bob] }, me, assignees)).toBe(false);
  });
});

describe('bags', () => {
  it('sums per-unit weight times quantity and counts missing bags as unassigned', () => {
    const bags = [{ id: 'bag1' }, { id: 'bag2' }];
    const items = [
      { bagId: 'bag1', grams: 200, qty: 3 }, { bagId: 'bag1', grams: 50 }, { bagId: 'gone', grams: 10 }, { grams: 5 }, { bagId: 'bag2' },
    ];
    const totals = bagTotals(items, bags);
    expect(totals.bags.get('bag1')).toEqual({ grams: 650, count: 2 });
    expect(totals.bags.get('bag2')).toEqual({ grams: 0, count: 1 });
    expect(totals.none).toEqual({ grams: 15, count: 2 });
  });
});

describe('order keys', () => {
  const entries = (keys) => keys.map((order, index) => ({ id: `e${index}`, order }));
  it('appends after the last key and rebalances before keys get long', () => {
    const list = entries(['a', 'b']);
    const { keys, moves } = appendOrders(list, 3);
    expect(moves).toEqual([]);
    expect(keys.every((key) => key > 'b' && isOrder(key))).toBe(true);
    const long = entries(['a', 'z'.repeat(ORDER_MAX)]);
    const result = appendOrders(long, 2);
    expect(result.keys.every((key) => key.length <= ORDER_MAX)).toBe(true);
    const final = [...long.map((item) => ({ ...item, order: result.moves.find((move) => move.item.id === item.id)?.order ?? item.order })), ...result.keys.map((order) => ({ order }))];
    const sorted = final.map((item) => item.order);
    expect([...sorted].sort()).toEqual(sorted);
  });
  it('moves between visible neighbours and rebalances equal keys', () => {
    const full = entries(orderKeys(4));
    expect(moveOrders(full, full, 3, 0)).toEqual([{ item: full[3], order: expect.any(String) }]);
    expect(moveOrders(full, full, 3, 0)[0].order < full[0].order).toBe(true);
    const tied = [{ id: 'a', order: 'm' }, { id: 'b', order: 'm' }, { id: 'c', order: 'm' }];
    const moves = moveOrders(tied, tied, 0, 1);
    const result = tied.map((item) => ({ ...item, order: moves.find((move) => move.item.id === item.id)?.order ?? item.order })).sort((x, y) => (x.order < y.order ? -1 : 1));
    expect(result.map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });
  it('keeps hidden entries in place when moving among visible ones', () => {
    const full = entries(orderKeys(5));
    const visible = [full[0], full[2], full[4]];
    const [move] = moveOrders(full, visible, 2, 1);
    expect(move.item).toBe(full[4]);
    expect(move.order > full[0].order && move.order < full[2].order).toBe(true);
  });
});

describe('import parsing', () => {
  it('reads list, name, weight, bag and checked with any delimiter and quotes', () => {
    const text = 'List;Name;Weight;Bag;Checked\nClothes;3x Socks;50 g;Carry-on;yes\n"Tech; cables";Charger;0,2kg;;\n\nToiletries;Toothbrush;;;x';
    const { rows, skipped } = parseImport(text);
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      { list: 'Clothes', name: 'Socks', qty: 3, grams: 50, bag: 'Carry-on', done: true },
      { list: 'Tech; cables', name: 'Charger', grams: 200 },
      { list: 'Toiletries', name: 'Toothbrush', done: true },
    ]);
  });
  it('prefers tabs, then the more frequent of semicolon and comma', () => {
    expect(parseImport('Clothes\tShirt\t1.5 lb').rows).toEqual([{ list: 'Clothes', name: 'Shirt', grams: 680 }]);
    expect(parseImport('Clothes,Shirt, 2 oz').rows).toEqual([{ list: 'Clothes', name: 'Shirt', grams: 57 }]);
    expect(parseImport('Passport\n2x Shirt').rows).toEqual([{ list: '', name: 'Passport' }, { list: '', name: 'Shirt', qty: 2 }]);
    expect(parseImport('Clothes;;100').skipped).toBe(1);
  });
  it('parses weights, quantities and quoted fields', () => {
    expect(parseWeightText('250')).toBe(250);
    expect(parseWeightText('1.2kg')).toBe(1200);
    expect(parseWeightText('1,5 KG')).toBe(1500);
    expect(parseWeightText('2 lbs')).toBe(907);
    expect(parseWeightText('heavy')).toBeNull();
    expect(parseWeightText('5 stone')).toBeNull();
    expect(parseQuantity('12 x  Socks')).toEqual({ name: 'Socks', qty: 12 });
    expect(parseQuantity('1x Hat')).toEqual({ name: 'Hat' });
    expect(parseQuantity('Socks x3')).toEqual({ name: 'Socks x3' });
    expect(splitLine('"a ""b""",c', ',')).toEqual(['a "b"', 'c']);
  });
  it('caps one import and reports the rest', () => {
    const result = parseImport(Array.from({ length: 1005 }, (_, index) => `Item ${index}`).join('\n'));
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });
});

describe('import plan', () => {
  it('creates missing lists and bags, matches existing ones by name and appends per list', () => {
    const metas = [{ id: 'm1', kind: 'pack', name: 'Clothes', order: 'a', color: 1 }];
    const items = [{ id: 'i1', name: 'Shirt', list: 'Clothes', order: 'a' }];
    const bags = [{ id: 'bag0000000000001', name: 'Carry-on', order: 'a', color: 1 }];
    const rows = [
      { list: 'clothes', name: 'Socks', qty: 3, bag: 'carry-on', done: true },
      { list: 'Tech', name: 'Charger', grams: 200, bag: 'Backpack' },
      { list: 'Tech', name: 'Cable', bag: 'backpack' },
    ];
    const plan = planImport(rows, { kind: 'pack', metas, items, bags, makeId });
    expect(plan.lists).toEqual([{ kind: 'pack', name: 'Tech', color: 2, order: expect.any(String) }]);
    expect(plan.lists[0].order > 'a').toBe(true);
    expect(plan.bags).toEqual([{ id: expect.any(String), name: 'Backpack', color: 2, order: expect.any(String) }]);
    const backpack = plan.bags[0].id;
    expect(plan.items).toEqual([
      { name: 'Socks', list: 'Clothes', qty: 3, bagId: 'bag0000000000001', done: true, order: expect.any(String) },
      { name: 'Charger', list: 'Tech', grams: 200, bagId: backpack, order: expect.any(String) },
      { name: 'Cable', list: 'Tech', bagId: backpack, order: expect.any(String) },
    ]);
    expect(plan.items[0].order > 'a').toBe(true);
    expect(plan.items[1].order < plan.items[2].order).toBe(true);
    expect(plan.moves).toEqual([]);
  });
  it('keeps priorities for to-dos and skips bags when tracking is off', () => {
    const plan = planImport([{ list: 'Before', name: 'Visa', prio: 1, bag: 'x', grams: 3 }], { kind: 'todo', makeId });
    expect(plan.items).toEqual([{ name: 'Visa', list: 'Before', prio: 1, order: expect.any(String) }]);
    expect(planImport([{ list: '', name: 'Hat', bag: 'Duffel' }], { kind: 'pack', makeId, withBags: false }).bags).toEqual([]);
  });
  it('round-trips through templates', () => {
    const groups = groupLists([], [
      { id: 'a', name: 'Socks', list: 'Clothes', qty: 3, grams: 40.4, order: 'a' },
      { id: 'b', name: 'Passport', order: 'a', bring: { [me]: 'yes' } },
    ], 'pack');
    const template = validateTemplate(templateFromGroups(groups, { kind: 'pack', name: 'Weekend', fallbackList: 'Other' }));
    expect(template.lists).toEqual([{ name: 'Clothes', items: [{ name: 'Socks', qty: 3, grams: 40 }] }, { name: 'Other', items: [{ name: 'Passport' }] }]);
    expect(rowsFromTemplate(template)).toEqual([{ list: 'Clothes', name: 'Socks', qty: 3, grams: 40 }, { list: 'Other', name: 'Passport' }]);
  });
});

describe('to-dos', () => {
  const today = '2027-05-10';
  const assignees = new Map([['before', [me]]]);
  const todos = [
    { id: 'a', name: 'Visa', due: '2027-05-01', order: 'a', list: 'Before' },
    { id: 'b', name: 'Tickets', due: today, order: 'b', who: bob, prio: 1 },
    { id: 'c', name: 'Pack', due: '2027-05-11', order: 'c', prio: 2 },
    { id: 'd', name: 'Insurance', order: 'd', prio: 1, who: me },
    { id: 'e', name: 'Done', due: '2027-04-01', done: true, order: 'e' },
    { id: 'f', name: 'Nobody', due: '2027-05-09', order: 'f' },
  ];
  it('flags overdue and due-today open to-dos', () => {
    expect(todoFlags(todos[0], today)).toEqual({ overdue: true, dueToday: false });
    expect(todoFlags(todos[1], today)).toEqual({ overdue: false, dueToday: true });
    expect(todoFlags(todos[4], today)).toEqual({ overdue: false, dueToday: false });
  });
  it('filters mine, overdue and done', () => {
    const ids = (filter) => todos.filter((todo) => matchesTodoFilter(todo, filter, { uid: me, today, assignees })).map((todo) => todo.id);
    expect(ids('mine')).toEqual(['a', 'd']);
    expect(ids('overdue')).toEqual(['a', 'f']);
    expect(ids('done')).toEqual(['e']);
    expect(ids('all')).toHaveLength(6);
    expect(isMineTodo({ who: bob, list: 'Before' }, me, assignees)).toBe(false);
  });
  it('sorts by priority or due date and keeps manual order otherwise', () => {
    expect(sortTodos(todos, 'prio').map((todo) => todo.id)).toEqual(['b', 'd', 'c', 'a', 'e', 'f']);
    expect(sortTodos(todos, 'due').map((todo) => todo.id)).toEqual(['e', 'a', 'f', 'b', 'c', 'd']);
    expect(sortTodos([...todos].reverse()).map((todo) => todo.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
  it('reminds about my open due to-dos and unassigned ones', () => {
    expect(dueReminders(todos, { uid: me, today, assignees }).map((todo) => todo.id)).toEqual(['a', 'f']);
    expect(dueReminders(todos, { uid: bob, today, assignees }).map((todo) => todo.id)).toEqual(['b', 'f']);
  });
  it('formats the local date', () => {
    expect(localToday(new Date(2027, 0, 5, 23, 30))).toBe('2027-01-05');
  });
});
