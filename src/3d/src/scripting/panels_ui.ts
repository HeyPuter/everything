// Draws script-registered panels (bpy.types.Panel subclasses) into the 3D viewport sidebar.
// Categories become sidebar tabs; panels for an existing tab (Item / Tool / View) are
// appended to it.
import { openScriptMenu, scriptMenus } from './menus';
import { h, type Child } from '../ui/h';
import { icon, iconNames } from '../ui/icons';
import { app, operators } from '../app/app';
import { numberField, checkbox, textField, colorSwatch, panel } from '../ui/widgets';
import { sidebarTabs } from '../editors/view3d/sidebar';
import { scriptPanels, panelListeners, UILayout, type LayoutItem, type ScriptPanelSpec } from './registry';
import { VecBase, Color, Euler } from './mathutils';
import { isIntKey, isIdWrapper } from './rna';
import { output } from './runner';

type Tab = (typeof sidebarTabs)[number];

const wrapped = new Map<string, Tab['draw']>();
const scriptTabs = new Set<string>();
const lastErrors = new Map<string, string>();

const pretty = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function panelsFor(category: string): ScriptPanelSpec[] {
  return [...scriptPanels.values()]
    .filter((p) => p.category === category)
    .filter((p) => {
      try {
        return !p.poll || p.poll();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.order - b.order);
}

function drawPanel(p: ScriptPanelSpec): Child {
  const body = () => {
    const layout = new UILayout();
    try {
      p.draw(layout);
      lastErrors.delete(p.idname);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (lastErrors.get(p.idname) !== msg) {
        lastErrors.set(p.idname, msg);
        output.push(`Error drawing panel ${p.idname}: ${msg}`, 'ERROR');
      }
      return [...renderItems(layout, p.idname), h('div', { class: 'sp-error' }, icon('error'), msg)];
    }
    return renderItems(layout, p.idname);
  };
  if (p.hideHeader) return h('div', { key: `sp-${p.idname}`, class: 'sp-headerless' }, body());
  return panel(`sp-${p.idname}`, p.label, body, { closed: p.defaultClosed });
}

function renderItems(layout: UILayout, pid: string, path = '0'): Child[] {
  return layout.items.map((it, i) => renderItem(it, pid, `${path}.${i}`, layout));
}

function renderItem(it: LayoutItem, pid: string, key: string, parent: UILayout): Child {
  const disabled = !parent.enabled;
  switch (it.t) {
    case 'label':
      return h('div', { key, class: 'sp-label' }, it.icon && iconNames.includes(it.icon.toLowerCase()) ? icon(it.icon.toLowerCase()) : null, it.text);
    case 'separator':
      return h('div', { key, class: 'ui-sep' });
    case 'operator': {
      const op = operators.get(it.idname);
      const props = Object.fromEntries(Object.entries(it.props).filter(([k]) => k !== '__kind'));
      const label = it.text ?? op?.label ?? it.idname;
      const enabled = !!op && !disabled && app.poll(it.idname);
      return h(
        'button',
        {
          key,
          class: 'btn sp-op',
          disabled: !enabled,
          'data-tip': op ? `${op.label}\n${op.description ?? ''}\nPython: bpy.ops.${it.idname}()` : `Unknown operator: ${it.idname}`,
          onclick: (e: MouseEvent) => app.run(it.idname, props, { event: { x: e.clientX, y: e.clientY } }),
        },
        it.icon && iconNames.includes(it.icon.toLowerCase()) ? icon(it.icon.toLowerCase()) : null,
        label,
      );
    }
    case 'menu': {
      const m = scriptMenus.get(it.idname);
      return h(
        'button',
        { key, class: 'btn sp-op', disabled: !m || disabled, 'data-tip': m ? `Open the "${m.label}" menu` : `Unknown menu: ${it.idname}`, onclick: (e: MouseEvent) => openScriptMenu(it.idname, e.currentTarget as HTMLElement) },
        it.icon && iconNames.includes(it.icon.toLowerCase()) ? icon(it.icon.toLowerCase()) : null,
        it.text ?? m?.label ?? it.idname,
        icon('down_arrow_hlt'),
      );
    }
    case 'layout': {
      const cls = { row: 'sp-row', column: 'sp-col', box: 'sp-box', split: 'sp-row sp-split' }[it.kind];
      return h('div', { key, class: `${cls}${it.align ? ' align' : ''}${it.layout.enabled ? '' : ' disabled'}${it.layout.alert ? ' alert' : ''}` }, renderItems(it.layout, pid, key));
    }
    case 'prop':
      return propWidget(it, pid, key, parent);
  }
}

function propWidget(it: Extract<LayoutItem, { t: 'prop' }>, pid: string, key: string, parent: UILayout): Child {
  const data = it.data as Record<string, unknown>;
  let value: unknown;
  try {
    value = data[it.prop];
  } catch (e) {
    return h('div', { key, class: 'sp-error' }, icon('error'), String((e as Error).message));
  }
  const label = it.text ?? pretty(it.prop);
  const id = `sp:${pid}:${key}:${it.prop}`;
  const set = (v: unknown, final: boolean) => {
    try {
      data[it.prop] = v;
    } catch (e) {
      app.report('ERROR', String((e as Error).message));
      return;
    }
    app.changed('doc');
    if (final) app.pushUndo(`Change ${label}`);
  };
  if (value === undefined) return h('div', { key, class: 'sp-error' }, icon('error'), `property not found: ${it.prop}`);
  const disabled = !parent.enabled;
  if (value instanceof VecBase) {
    const n = value.size;
    if (value instanceof Color) return h('div', { key, class: 'sp-prop' }, label ? h('span', { class: 'sp-plabel' }, label) : null, colorSwatch(id, value.toArray(), (v, f) => set(v.slice(0, n), f)));
    const names = value instanceof Euler ? ['X', 'Y', 'Z'] : n === 4 && /quaternion/.test(it.prop) ? ['W', 'X', 'Y', 'Z'] : ['X', 'Y', 'Z', 'W'];
    const unit = value instanceof Euler ? 'angle' : /location|translation|offset|size|dimensions/.test(it.prop) ? 'distance' : 'none';
    const fields = ((it.index ?? -1) >= 0 ? [it.index as number] : [...Array(n).keys()]).map((i: number) =>
      numberField({
        id: `${id}.${i}`,
        label: names[i],
        value: value.get(i),
        unit,
        disabled,
        set: (v, final) => {
          const arr = value.toArray();
          arr[i] = v;
          set(arr, final);
        },
      }),
    );
    return h('div', { key, class: 'sp-vec' }, label ? h('div', { class: 'sp-plabel' }, `${label}:`) : null, h('div', { class: 'col' }, fields));
  }
  if (typeof value === 'boolean') return h('div', { key, class: 'sp-prop check' }, checkbox(id, label, value, (v) => set(v, true), { disabled }));
  if (typeof value === 'number') {
    const int = Number.isInteger(value) && isIntKey(it.prop);
    return h('div', { key, class: 'sp-prop' }, numberField({ id, label, value, int, slider: it.slider, disabled, unit: /angle|rotation/.test(it.prop) ? 'angle' : 'none', set: (v, f) => set(int ? Math.round(v) : v, f) }));
  }
  if (typeof value === 'string') return h('div', { key, class: 'sp-prop' }, label ? h('span', { class: 'sp-plabel' }, label) : null, textField(id, value, (v) => set(v, true)));
  if (isIdWrapper(value)) return h('div', { key, class: 'sp-prop' }, label ? h('span', { class: 'sp-plabel' }, label) : null, h('span', { class: 'sp-idref' }, (value as unknown as { name: string }).name));
  if (value === null) return h('div', { key, class: 'sp-prop' }, label ? h('span', { class: 'sp-plabel' }, label) : null, h('span', { class: 'sp-idref none' }, 'None'));
  return h('div', { key, class: 'sp-prop' }, h('span', { class: 'sp-plabel' }, label), h('span', { class: 'sp-idref' }, String(value)));
}

/** Keep sidebar tabs in sync with the registered panels. */
function sync() {
  const cats = new Set([...scriptPanels.values()].map((p) => p.category));
  for (const cat of cats) {
    const existing = sidebarTabs.find((t) => t.id === cat);
    if (existing && !scriptTabs.has(cat)) {
      if (!wrapped.has(cat)) {
        const orig = existing.draw;
        wrapped.set(cat, orig);
        existing.draw = (v) => [orig(v), panelsFor(cat).map(drawPanel)];
      }
    } else if (!existing) {
      sidebarTabs.push({ id: cat, label: cat, draw: () => panelsFor(cat).map(drawPanel), poll: () => panelsFor(cat).length > 0 });
      scriptTabs.add(cat);
    }
  }
  // drop tabs whose panels are gone, restore wrapped built-in tabs
  for (const cat of [...scriptTabs]) {
    if (cats.has(cat)) continue;
    const i = sidebarTabs.findIndex((t) => t.id === cat);
    if (i >= 0) sidebarTabs.splice(i, 1);
    scriptTabs.delete(cat);
  }
  for (const [cat, orig] of [...wrapped]) {
    if (cats.has(cat)) continue;
    const t = sidebarTabs.find((x) => x.id === cat);
    if (t) t.draw = orig;
    wrapped.delete(cat);
  }
  app.changed('ui');
}

panelListeners.add(sync);
