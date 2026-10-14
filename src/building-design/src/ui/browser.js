/**
 * Project Browser: views, schedules, sheets and element types as a tree.
 * Full keyboard support (WAI-ARIA tree pattern), search filter, inline
 * rename (F2), context menus, and double-click (or Enter) to open a view or
 * place a type.
 */
import { h, clear } from './dom.js';
import { icon, KIND_ICON } from './icons.js';
import { showMenu } from './menu.js';
import { FAMILY_BY_KIND, CATEGORIES, TYPE_KIND } from '../core/catalog.js';

const TYPE_GROUPS = [
  { label: 'Walls', typeKind: 'wallType', kind: 'wall' },
  { label: 'Doors', typeKind: 'doorType', kind: 'door', byFamily: true },
  { label: 'Windows', typeKind: 'windowType', kind: 'window', byFamily: true },
  { label: 'Floors', typeKind: 'floorType', kind: 'floor' },
  { label: 'Roofs', typeKind: 'roofType', kind: 'roof' },
  { label: 'Ceilings', typeKind: 'ceilingType', kind: 'ceiling' },
  { label: 'Columns', typeKind: 'columnType', kind: 'column', byFamily: true },
  { label: 'Structural Framing', typeKind: 'beamType', kind: 'beam' },
  { label: 'Stairs', typeKind: 'stairType', kind: 'stair' },
  { label: 'Railings', typeKind: 'railingType', kind: 'railing' },
];

export class ProjectBrowser {
  constructor(app, body, search) {
    this.app = app;
    this.body = body;
    this.search = search;
    this.expanded = new Set(load() ?? ['views', 'views/plan', 'views/view3d', 'views/elevation']);
    this.focusKey = null;
    this.query = '';
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.render();
    });
    search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.body.querySelector('.tnode')?.focus();
      }
    });
  }

  tree() {
    const doc = this.app.doc;
    if (!doc) return [];
    const levelElev = (v) => doc.get(v.levelId)?.elevation ?? 0;
    const viewNode = (v) => ({ key: v.id, label: v.kind === 'sheet' ? `${v.number || ''} - ${v.name}` : v.name, icon: KIND_ICON[v.kind], itemId: v.id, item: v, type: 'view' });
    const sortByName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
    const views = [
      { key: 'views/plan', label: 'Floor Plans', children: doc.all('plan').sort((a, b) => levelElev(a) - levelElev(b) || sortByName(a, b)).map(viewNode) },
      { key: 'views/ceilingPlan', label: 'Ceiling Plans', children: doc.all('ceilingPlan').sort((a, b) => levelElev(a) - levelElev(b)).map(viewNode) },
      { key: 'views/view3d', label: '3D Views', children: doc.all('view3d').sort(sortByName).map(viewNode) },
      { key: 'views/elevation', label: 'Elevations', children: doc.all('elevation').map(viewNode) },
      { key: 'views/section', label: 'Sections', children: doc.all('section').sort(sortByName).map(viewNode) },
    ].filter((g) => g.children.length);
    const fam = [];
    for (const g of TYPE_GROUPS) {
      const types = doc.all(g.typeKind);
      if (!types.length) continue;
      const typeNode = (t) => ({ key: t.id, label: t.name, icon: KIND_ICON[g.kind], itemId: t.id, item: t, type: 'type', kind: g.kind });
      if (g.byFamily) {
        const byF = new Map();
        for (const t of types) {
          const f = t.familyName || FAMILY_BY_KIND[t.kind];
          if (!byF.has(f)) byF.set(f, []);
          byF.get(f).push(t);
        }
        fam.push({ key: `fam/${g.typeKind}`, label: g.label, children: [...byF].map(([f, list]) => ({ key: `fam/${g.typeKind}/${f}`, label: f, children: list.map(typeNode) })) });
      } else fam.push({ key: `fam/${g.typeKind}`, label: g.label, children: types.map(typeNode) });
    }
    // Components grouped by category, then family.
    const comps = doc.all('componentType');
    for (const cat of CATEGORIES) {
      const list = comps.filter((t) => t.category === cat.id);
      if (!list.length) continue;
      const byF = new Map();
      for (const t of list) {
        if (!byF.has(t.familyName)) byF.set(t.familyName, []);
        byF.get(t.familyName).push(t);
      }
      fam.push({
        key: `fam/cat/${cat.id}`,
        label: cat.label,
        children: [...byF].map(([f, ts]) => ({ key: `fam/cat/${cat.id}/${f}`, label: f, children: ts.map((t) => ({ key: t.id, label: t.name, icon: 'component', itemId: t.id, item: t, type: 'type', kind: 'component' })) })),
      });
    }
    return [
      { key: 'views', label: 'Views (all)', icon: 'layers', children: views },
      { key: 'schedules', label: 'Schedules/Quantities', icon: 'schedule', children: doc.all('schedule').sort(sortByName).map(viewNode) },
      { key: 'sheets', label: 'Sheets (all)', icon: 'sheet', children: doc.all('sheet').sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true })).map(viewNode) },
      { key: 'families', label: 'Families', icon: 'types', children: fam },
    ];
  }

  /** Visible rows in order: { node, depth, parent }. */
  rows() {
    const out = [];
    const q = this.query;
    const matches = (n) => !q || n.label.toLowerCase().includes(q) || (n.children || []).some(matches);
    const walk = (nodes, depth, parent) => {
      for (const n of nodes) {
        if (!matches(n)) continue;
        out.push({ node: n, depth, parent });
        const open = q ? true : this.expanded.has(n.key);
        if (n.children && open) walk(n.children, depth + 1, n);
      }
    };
    walk(this.tree(), 0, null);
    return out;
  }

  render() {
    const app = this.app;
    clear(this.body);
    const rows = this.rows();
    const ul = h('ul.tree', { role: 'tree', 'aria-label': 'Project Browser' });
    const activeId = app.activeViewId;
    let focusable = rows.find((r) => r.node.key === this.focusKey) ? this.focusKey : rows[0]?.node.key;
    for (const r of rows) {
      const n = r.node;
      const hasKids = !!n.children;
      const open = this.query ? true : this.expanded.has(n.key);
      const btn = h(
        `li.tnode${n.itemId === activeId ? '.current' : ''}`,
        {
          role: 'treeitem',
          tabindex: n.key === focusable ? '0' : '-1',
          'aria-level': String(r.depth + 1),
          'aria-expanded': hasKids ? String(open) : null,
          'aria-selected': String(n.itemId != null && n.itemId === activeId),
          'aria-current': n.itemId === activeId ? 'page' : null,
          style: { '--depth': r.depth },
          dataset: { key: n.key },
          onClick: () => {
            this.focusKey = n.key;
            if (hasKids) this.toggle(n.key);
            else if (n.type === 'view') app.selectViewInBrowser(n.item);
            else if (n.type === 'type') app.showTypeProperties(n.item, n.kind);
          },
          onDblclick: () => this.activate(n),
          onContextmenu: (e) => {
            e.preventDefault();
            this.menu(n, { x: e.clientX, y: e.clientY });
          },
          onKeydown: (e) => this.key(e, r, rows),
        },
        h('span.tnode-twisty' + (hasKids ? '' : '.leaf'), icon('chevron-down', 13)),
        n.icon ? h('span.tnode-ico', icon(n.icon, 15)) : null,
        h('span.tnode-name', n.label),
        hasKids && r.depth === 0 ? h('span.tnode-count', String(countLeaves(n))) : null,
      );
      ul.append(btn);
    }
    if (!rows.length) ul.append(h('li.props-empty', { role: 'none' }, 'Nothing matches the search.'));
    this.body.append(ul);
  }

  toggle(key) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    save([...this.expanded]);
    this.render();
    this.body.querySelector(`[data-key="${cssEscape(key)}"]`)?.focus();
  }

  activate(n) {
    const app = this.app;
    if (n.children) return this.toggle(n.key);
    if (n.type === 'view') app.openView(n.itemId);
    else if (n.type === 'type') app.placeType(n.item, n.kind);
  }

  key(e, r, rows) {
    const n = r.node;
    const i = rows.indexOf(r);
    const focus = (row) => {
      if (!row) return;
      this.focusKey = row.node.key;
      const el = this.body.querySelector(`[data-key="${cssEscape(row.node.key)}"]`);
      for (const b of this.body.querySelectorAll('.tnode')) b.tabIndex = -1;
      if (el) {
        el.tabIndex = 0;
        el.focus();
      }
    };
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focus(rows[i + 1]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (i === 0) this.search.focus();
        else focus(rows[i - 1]);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (n.children && !this.expanded.has(n.key)) this.toggle(n.key);
        else if (n.children) focus(rows[i + 1]);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (n.children && this.expanded.has(n.key)) this.toggle(n.key);
        else if (r.parent) focus(rows.find((x) => x.node === r.parent));
        break;
      case 'Home':
        e.preventDefault();
        focus(rows[0]);
        break;
      case 'End':
        e.preventDefault();
        focus(rows.at(-1));
        break;
      case 'Enter':
        e.preventDefault();
        this.activate(n);
        break;
      case 'F2':
        e.preventDefault();
        if (n.itemId) this.app.renameItem(n.itemId);
        break;
      case 'Delete':
        e.preventDefault();
        if (n.itemId) this.app.deleteItem(n.itemId);
        break;
      case 'ContextMenu':
        e.preventDefault();
        this.menu(n, e.currentTarget);
        break;
      default:
        if (e.shiftKey && e.key === 'F10') {
          e.preventDefault();
          this.menu(n, e.currentTarget);
        }
    }
  }

  menu(n, at) {
    const app = this.app;
    if (!n.itemId) return;
    const it = n.item;
    let items;
    if (n.type === 'view') {
      const graphical = !['schedule', 'sheet'].includes(it.kind);
      items = [
        { label: 'Open', icon: 'external', action: () => app.openView(it.id) },
        graphical && it.kind !== 'elevation' ? { label: 'Duplicate View', icon: 'duplicate', action: () => app.duplicateView(it.id) } : null,
        graphical && app.doc.count('sheet') ? { label: 'Place on Sheet', icon: 'sheet', action: () => app.placeViewDialog(it.id) } : null,
        it.kind === 'schedule' ? { label: 'Export to CSV', icon: 'download', action: () => app.exportSchedule(it.id) } : null,
        { separator: true },
        { label: 'Rename', icon: 'pencil', shortcut: 'F2', action: () => app.renameItem(it.id) },
        { label: 'Delete', icon: 'trash', shortcut: 'Delete', action: () => app.deleteItem(it.id) },
      ];
    } else {
      items = [
        { label: 'Place', icon: n.icon || 'component', action: () => app.placeType(it, n.kind) },
        { label: 'Edit Type', icon: 'types', action: () => app.editTypeDialog(it) },
        { label: 'Duplicate', icon: 'duplicate', action: () => app.duplicateType(it) },
        { label: 'Rename', icon: 'pencil', shortcut: 'F2', action: () => app.renameItem(it.id) },
        { label: 'Select All Instances', icon: 'pointer', action: () => app.selectInstancesOfType(it.id) },
        { separator: true },
        { label: 'Delete', icon: 'trash', action: () => app.deleteItem(it.id) },
      ];
    }
    showMenu(at, items.filter(Boolean), { label: `${n.label} actions` });
  }
}

function countLeaves(n) {
  if (!n.children) return 1;
  return n.children.reduce((s, c) => s + countLeaves(c), 0);
}

function cssEscape(s) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function load() {
  try {
    return JSON.parse(localStorage.getItem('bd.browserExpanded') || 'null');
  } catch {
    return null;
  }
}

function save(v) {
  try {
    localStorage.setItem('bd.browserExpanded', JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export { TYPE_KIND };
