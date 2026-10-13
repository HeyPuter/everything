/**
 * Custom toolbars (Window > Toolbars): New Toolbar makes a named floating
 * tool strip that you fill from its Add menu or by dropping tools on it;
 * Manage Toolbars renames, shows, duplicates and deletes them. Toolbars, their
 * tools, position and orientation persist in preferences. The Toolbars
 * submenu lists them to show or hide each one.
 */
import { h } from '../../lib/dom.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { createToolStrip } from '../../ui/tool-strip.js';
import { TOOL_LAYOUT } from '../../ui/toolbar.js';

const KEY = 'customToolbars';

/** Saved custom toolbars: [{ id, name, tools, visible, x, y, vertical }]. */
export function customToolbars(app) {
  const v = app.prefs.get(KEY);
  return Array.isArray(v) ? v : [];
}

export function install(app) {
  const strips = new Map(); // toolbar id -> strip
  const save = (list) => app.prefs.set(KEY, list);
  const find = (id) => customToolbars(app).find((t) => t.id === id);
  const patch = (id, p) => save(customToolbars(app).map((t) => (t.id === id ? { ...t, ...p } : t)));

  const sections = () => {
    const out = TOOL_LAYOUT.map((s) => ({ label: s.label, ids: s.groups.flat() }));
    const listed = new Set(out.flatMap((s) => s.ids));
    const others = [...app.toolClasses.keys()].filter((id) => !listed.has(id));
    if (others.length) out.push({ label: 'More', ids: others });
    return out;
  };

  const show = (t) => {
    if (strips.has(t.id)) return;
    const strip = createToolStrip(app, {
      ids: t.tools || [],
      label: t.name,
      x: t.x ?? 120,
      y: t.y ?? 120,
      vertical: Boolean(t.vertical),
      editable: true,
      sections: sections(),
      onClose: () => setVisible(t.id, false),
      onChange: (p) => patch(t.id, p.ids ? { tools: p.ids } : p),
    });
    strips.set(t.id, strip);
  };

  const hide = (id) => {
    strips.get(id)?.remove();
    strips.delete(id);
  };

  const setVisible = (id, visible) => {
    patch(id, { visible });
    sync();
  };

  /** Show and hide strips to match the saved toolbars. */
  const sync = () => {
    const list = customToolbars(app);
    for (const id of [...strips.keys()]) if (!list.some((t) => t.id === id && t.visible !== false)) hide(id);
    for (const t of list) {
      if (t.visible === false) continue;
      if (strips.has(t.id) && strips.get(t.id).el.getAttribute('aria-label') !== t.name) hide(t.id);
      show(t);
    }
  };

  const uniqueName = (base, list = customToolbars(app)) => {
    let n = base;
    for (let i = 2; list.some((t) => t.name === n); i++) n = `${base} ${i}`;
    return n;
  };

  async function newToolbar() {
    const v = await app.dialogs.form({ title: 'New Toolbar', fields: [{ key: 'name', label: 'Name', type: 'text', value: uniqueName('Toolbar') }], okLabel: 'Create' });
    if (!v) return null;
    const list = customToolbars(app);
    const name = uniqueName(String(v.name || '').trim() || 'Toolbar', list);
    const n = list.length;
    const t = { id: `tb-${Date.now().toString(36)}-${n}`, name, tools: [], visible: true, x: 120 + n * 24, y: 120 + n * 24, vertical: false };
    save([...list, t]);
    sync();
    // An empty toolbar invites its first tool.
    strips.get(t.id)?.el.querySelector('.tearoff-add')?.focus();
    return t.id;
  }

  async function manageToolbars() {
    let list = customToolbars(app).map((t) => ({ ...t }));
    let sel = list[0]?.id || null;
    const ul = h('ul.ev-list', { role: 'listbox', 'aria-label': 'Toolbars' });
    const name = h('input#mt-name', { type: 'text', autocomplete: 'off', spellcheck: false });
    const visible = h('input#mt-visible', { type: 'checkbox' });
    const current = () => list.find((t) => t.id === sel);
    const del = h('button.btn.small', { type: 'button', onclick: () => ((list = list.filter((t) => t.id !== sel)), (sel = list[0]?.id || null), render()) }, 'Delete');
    const dup = h('button.btn.small', {
      type: 'button',
      onclick: () => {
        const cur = current();
        if (!cur) return;
        const copy = { ...cur, id: `tb-${Date.now().toString(36)}-${list.length}`, name: uniqueName(`${cur.name} copy`, list), x: (cur.x ?? 120) + 24, y: (cur.y ?? 120) + 24 };
        list.push(copy);
        sel = copy.id;
        render();
      },
    }, 'Duplicate');
    function render() {
      ul.replaceChildren(...list.map((t) => h('li.ev-item', { role: 'option', tabindex: t.id === sel ? '0' : '-1', 'aria-selected': String(t.id === sel), onclick: () => ((sel = t.id), render()) }, h('span.ev-name', t.name), h('span.ev-meta', ` ${t.tools?.length || 0} tools`))));
      if (!list.length) ul.append(h('li.panel-empty', 'No toolbars yet. Use New Toolbar to make one.'));
      const cur = current();
      name.value = cur?.name || '';
      visible.checked = cur ? cur.visible !== false : false;
      name.disabled = visible.disabled = del.disabled = dup.disabled = !cur;
    }
    ul.addEventListener('keydown', (e) => {
      const i = list.findIndex((t) => t.id === sel);
      const next = { ArrowDown: i + 1, ArrowUp: i - 1 }[e.key];
      if (next == null || !list[next]) return;
      e.preventDefault();
      sel = list[next].id;
      render();
      ul.querySelector('[aria-selected="true"]')?.focus();
    });
    name.addEventListener('input', () => {
      const cur = current();
      if (cur) cur.name = name.value;
      const row = ul.querySelector('[aria-selected="true"] .ev-name');
      if (row) row.textContent = name.value;
    });
    visible.addEventListener('change', () => {
      const cur = current();
      if (cur) cur.visible = visible.checked;
    });
    render();
    const ok = await openDialog({
      title: 'Manage Toolbars',
      body: h(
        'div.form.edit-views',
        ul,
        h('div.form-row', h('label', { for: 'mt-name' }, 'Name'), name),
        h('div.form-row.check', visible, h('label', { for: 'mt-visible' }, 'Show toolbar')),
        h('div.ev-actions', dup, del),
      ),
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'OK', value: true, primary: true },
      ],
    });
    if (!ok) return false;
    const seen = [];
    const out = list.map((t) => {
      const n = uniqueName(t.name.trim() || 'Toolbar', seen);
      const done = { ...t, name: n };
      seen.push(done);
      return done;
    });
    save(out);
    sync();
    return true;
  }

  app.commands.register({ id: 'window.toolbar.new', label: 'New Toolbar...', run: () => newToolbar() });
  app.commands.register({ id: 'window.toolbar.manage', label: 'Manage Toolbars...', enabled: (a) => customToolbars(a).length > 0, run: () => manageToolbars() });
  app.menuSources.set('toolbars', (a) => [
    'window.toolbar.advanced',
    'window.toolbar.basic',
    '-',
    ...customToolbars(a).map((t) => ({ label: t.name, checked: t.visible !== false, run: () => setVisible(t.id, t.visible === false) })),
    '-',
    'window.toolbar.new',
    'window.toolbar.manage',
    '-',
    'window.toolbar.edit',
  ]);
  app.customToolbars = { sync, strips, setVisible };
  sync();
}
