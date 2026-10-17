import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import * as D from '../src/data/database.js';

function setup() {
  const doc = new Y.Doc();
  D.initDatabase(doc, { props: [{ name: 'Status', type: 'status' }, { name: 'Points', type: 'number' }, { name: 'Tags', type: 'multi' }, { name: 'Due', type: 'date' }, { name: 'Done', type: 'checkbox' }] });
  const props = Object.fromEntries(D.listProps(doc).map((p) => [p.name, p]));
  const pages = new Map();
  const row = (title, values = {}) => {
    const id = D.addRow(doc, { values });
    pages.set(id, { id, title, created: pages.size, updated: pages.size });
    return id;
  };
  return { doc, props, pages, row, pageOf: (id) => pages.get(id) };
}

describe('databases', () => {
  it('starts with a title property and a view', () => {
    const { doc } = setup();
    expect(D.listProps(doc)[0]).toMatchObject({ id: D.TITLE, type: 'title' });
    expect(D.listViews(doc)).toHaveLength(1);
  });

  it('creates select options once, case-insensitively', () => {
    const { doc, props } = setup();
    const a = D.ensureOption(doc, props.Tags.id, 'Urgent');
    const b = D.ensureOption(doc, props.Tags.id, 'urgent');
    expect(a).toBe(b);
    expect(D.getProp(doc, props.Tags.id).options).toHaveLength(1);
  });

  it('filters by text, number, select, multi-select, date and checkbox', () => {
    const { doc, props, row, pageOf } = setup();
    const done = props.Status.options[2].id;
    const urgent = D.ensureOption(doc, props.Tags.id, 'Urgent');
    row('Write docs', { [props.Points.id]: 3, [props.Status.id]: done, [props.Due.id]: '2026-10-01' });
    row('Fix login', { [props.Points.id]: 8, [props.Tags.id]: [urgent], [props.Done.id]: true, [props.Due.id]: '2026-11-01' });
    row('Plan offsite', {});
    const titles = (filters) => D.queryRows(doc, { filters }, pageOf).map((r) => r.page.title);
    expect(titles([{ prop: D.TITLE, op: 'contains', value: 'fix' }])).toEqual(['Fix login']);
    expect(titles([{ prop: props.Points.id, op: 'gte', value: '3' }])).toEqual(['Write docs', 'Fix login']);
    expect(titles([{ prop: props.Status.id, op: 'is', value: done }])).toEqual(['Write docs']);
    expect(titles([{ prop: props.Tags.id, op: 'has', value: urgent }])).toEqual(['Fix login']);
    expect(titles([{ prop: props.Due.id, op: 'before', value: '2026-10-15' }])).toEqual(['Write docs']);
    expect(titles([{ prop: props.Done.id, op: 'checked' }])).toEqual(['Fix login']);
    expect(titles([{ prop: props.Points.id, op: 'empty' }])).toEqual(['Plan offsite']);
    // An unfinished filter (no value yet) shows everything.
    expect(titles([{ prop: props.Status.id, op: 'is', value: '' }])).toHaveLength(3);
  });

  it('sorts with empty values last in both directions', () => {
    const { doc, props, row, pageOf } = setup();
    row('b', { [props.Points.id]: 2 });
    row('none');
    row('a', { [props.Points.id]: 10 });
    const sorted = (dir) => D.queryRows(doc, { sorts: [{ prop: props.Points.id, dir }] }, pageOf).map((r) => r.page.title);
    expect(sorted('asc')).toEqual(['b', 'a', 'none']);
    expect(sorted('desc')).toEqual(['a', 'b', 'none']);
  });

  it('searches every visible value', () => {
    const { doc, props, row, pageOf } = setup();
    const urgent = D.ensureOption(doc, props.Tags.id, 'Urgent');
    row('One', { [props.Tags.id]: [urgent] });
    row('Two');
    expect(D.queryRows(doc, {}, pageOf, { search: 'urg' }).map((r) => r.page.title)).toEqual(['One']);
  });

  it('groups rows into board columns', () => {
    const { doc, props, row } = setup();
    const [todo, doing] = props.Status.options;
    row('a', { [props.Status.id]: todo.id });
    row('b', { [props.Status.id]: doing.id });
    row('c');
    const groups = D.groupRows(D.listRows(doc), props.Status);
    expect(groups.map((g) => [g.name, g.rows.length])).toEqual([['No Status', 1], ['Not started', 1], ['In progress', 1], ['Done', 0]]);
  });

  it('gives new rows the values their view and column imply', () => {
    const { doc, props } = setup();
    const done = props.Status.options[2].id;
    const view = { filters: [{ prop: props.Done.id, op: 'checked' }], groupBy: props.Status.id };
    expect(D.defaultsFor(doc, view, done)).toEqual({ [props.Done.id]: true, [props.Status.id]: done });
  });

  it('clears values when a property is deleted', () => {
    const { doc, props, row } = setup();
    const id = row('a', { [props.Points.id]: 4 });
    D.deleteProp(doc, props.Points.id);
    expect(D.listRows(doc).find((r) => r.id === id).values).toEqual({});
    // The title cannot be deleted.
    D.deleteProp(doc, D.TITLE);
    expect(D.getProp(doc, D.TITLE)).toBeTruthy();
  });

  it('keeps at least one view', () => {
    const { doc } = setup();
    const [only] = D.listViews(doc);
    expect(D.deleteView(doc, only.id)).toBe(false);
    const board = D.addView(doc, { type: 'board' });
    expect(D.getView(doc, board).groupBy).toBeTruthy();
    expect(D.deleteView(doc, only.id)).toBe(true);
  });

  it('reorders rows by hand', () => {
    const { doc, row } = setup();
    const a = row('a');
    const b = row('b');
    const c = row('c');
    D.moveRow(doc, c, { before: a });
    expect(D.listRows(doc).map((r) => r.id)).toEqual([c, a, b]);
  });

  it('formats values for display', () => {
    const { props } = setup();
    expect(D.formatValue(props.Points, 1234.5)).toBe((1234.5).toLocaleString());
    expect(D.formatValue(props.Done, true)).toBe('Yes');
    expect(D.formatValue(props.Due, '2026-10-11')).toMatch(/2026/);
  });

  describe('two people editing at once', () => {
    const pair = () => {
      const { doc, props } = setup();
      const other = new Y.Doc();
      Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
      const merge = () => {
        Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
      };
      return { doc, other, props, merge };
    };

    it('keeps both new select options', () => {
      const { doc, other, props, merge } = pair();
      const a = D.ensureOption(doc, props.Tags.id, 'Urgent');
      const b = D.ensureOption(other, props.Tags.id, 'Backend');
      merge();
      expect(D.getProp(doc, props.Tags.id).options.map((o) => o.id).sort()).toEqual([a, b].sort());
      expect(D.getProp(other, props.Tags.id).options).toEqual(D.getProp(doc, props.Tags.id).options);
    });

    it('keeps a renamed option and a recolored one', () => {
      const { doc, other, props, merge } = pair();
      const [first, second] = props.Status.options;
      D.updateProp(doc, props.Status.id, { options: props.Status.options.map((o) => (o.id === first.id ? { ...o, name: 'Todo' } : o)) });
      D.updateProp(other, props.Status.id, { options: props.Status.options.map((o) => (o.id === second.id ? { ...o, color: 'red' } : o)) });
      merge();
      const options = D.getProp(doc, props.Status.id).options;
      expect(options.map((o) => o.name)).toEqual(['Todo', 'In progress', 'Done']);
      expect(options[1].color).toBe('red');
    });

    it('keeps a renamed property and its changed type', () => {
      const { doc, other, props, merge } = pair();
      D.updateProp(doc, props.Points.id, { name: 'Estimate' });
      D.updateProp(other, props.Points.id, { type: 'text' });
      merge();
      expect(D.getProp(doc, props.Points.id)).toMatchObject({ name: 'Estimate', type: 'text' });
    });

    it('keeps a column width and a filter set on the same view', () => {
      const { doc, other, props, merge } = pair();
      const view = D.listViews(doc)[0].id;
      D.updateView(doc, view, { widths: { title: 300 } });
      D.updateView(other, view, { filters: [{ prop: props.Done.id, op: 'checked' }] });
      merge();
      expect(D.getView(doc, view)).toMatchObject({ widths: { title: 300 }, filters: [{ prop: props.Done.id, op: 'checked' }] });
    });
  });

  it('reads databases saved with plain props and views, and converts them on change', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const db = doc.getMap('db');
      const props = new Y.Map();
      const views = new Y.Map();
      db.set('props', props);
      db.set('views', views);
      db.set('rows', new Y.Map());
      props.set('title', { name: 'Name', type: 'title', order: 'a' });
      props.set('tags', { name: 'Tags', type: 'multi', order: 'b', options: [{ id: 'o1', name: 'One', color: 'blue' }, { id: 'o2', name: 'Two', color: 'green' }] });
      views.set('v1', { name: 'Table', type: 'table', order: 'a', sorts: [], filters: [], groupBy: null, hidden: [], widths: {} });
    });
    expect(D.getProp(doc, 'tags').options.map((o) => o.name)).toEqual(['One', 'Two']);
    expect(D.getView(doc, 'v1')).toMatchObject({ name: 'Table', type: 'table' });
    D.ensureOption(doc, 'tags', 'Three');
    D.updateView(doc, 'v1', { hidden: ['tags'] });
    expect(doc.getMap('db').get('props').get('tags')).toBeInstanceOf(Y.Map);
    expect(D.getProp(doc, 'tags')).toMatchObject({ name: 'Tags', type: 'multi', order: 'b' });
    expect(D.getProp(doc, 'tags').options.map((o) => o.name)).toEqual(['One', 'Two', 'Three']);
    expect(D.getView(doc, 'v1')).toMatchObject({ name: 'Table', hidden: ['tags'], widths: {} });
  });

  it('reorders and deletes options', () => {
    const { doc, props } = setup();
    const [a, b, c] = props.Status.options;
    D.updateProp(doc, props.Status.id, { options: [c, a, b] });
    expect(D.getProp(doc, props.Status.id).options.map((o) => o.id)).toEqual([c.id, a.id, b.id]);
    D.updateProp(doc, props.Status.id, { options: [c, b] });
    expect(D.getProp(doc, props.Status.id).options.map((o) => o.id)).toEqual([c.id, b.id]);
  });
});
