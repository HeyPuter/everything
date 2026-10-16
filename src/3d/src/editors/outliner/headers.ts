// Outliner pieces of the newer display modes: the value column of the Data API mode and the
// filter popovers of the Data Blocks / Unused Data and Library Overrides modes.
import { h, type Child } from '../../ui/h';
import { app } from '../../app/app';
import { checkbox, enumMenu, numberField } from '../../ui/widgets';
import type { Outliner } from '../outliner';
import { ID_GROUPS, type Row } from './tree';

/** Editable value of a Data API row. */
export function valueCell(r: Row): Child {
  const v = r.value!;
  const cur = v.get();
  const commit = (x: unknown, final = true) => {
    try {
      v.set?.(x);
    } catch (e) {
      app.report('ERROR', e instanceof Error ? e.message : String(e));
      return;
    }
    app.changed('doc');
    if (final) app.pushUndo(`Change ${r.label}`);
  };
  const stop = (e: Event) => e.stopPropagation();
  let field: Child;
  switch (v.kind) {
    case 'number':
    case 'int':
      field = numberField({ id: `ol-api:${r.ekey}`, value: Number(cur), int: v.kind === 'int', precision: 3, set: (x, final) => commit(x, final) });
      break;
    case 'bool':
      field = checkbox(`ol-api:${r.ekey}`, '', !!cur, (x) => commit(x));
      break;
    case 'string':
      field = h('input', {
        class: 'ol-api-text',
        value: String(cur ?? ''),
        spellcheck: 'false',
        onkeydown: (e: KeyboardEvent) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        },
        onchange: (e: Event) => commit((e.target as HTMLInputElement).value),
      });
      break;
    default:
      field = h('span', { class: 'ol-api-ro', 'data-tip': String(cur ?? '') }, String(cur ?? ''));
  }
  return h('span', { class: 'ol-api-value', key: 'value', onpointerdown: stop, ondblclick: stop }, field);
}

function set(ol: Outliner, key: string, v: unknown) {
  (ol.filter as unknown as Record<string, unknown>)[key] = v;
  ol.redraw();
  app.changed('ui');
}

/** Data Blocks / Unused Data: only list one data-block type. */
export function idTypeFilterPopover(ol: Outliner): Child {
  const f = ol.filter;
  const types = [...ID_GROUPS.map(([label, table, icon]) => ({ value: table as string, label, icon })), { value: 'scenes', label: 'Scenes', icon: 'scene_data' }].sort((a, b) => a.label.localeCompare(b.label));
  return h(
    'div',
    { class: 'olf' },
    h('div', { class: 'olf-head' }, 'Filter'),
    h('div', { class: 'olf-check' }, checkbox('olf-idtype', 'Filter by Type', f.use_filter_id_type, (v) => set(ol, 'use_filter_id_type', v))),
    h('div', { class: 'olf-indent' }, enumMenu('olf-idtype-v', types, f.filter_id_type, (v) => set(ol, 'filter_id_type', v), { disabled: !f.use_filter_id_type, tip: 'Data-block type to list' })),
  );
}

/** Library Overrides: properties or hierarchies, and whether system overrides are listed. */
export function overridesFilterPopover(ol: Outliner): Child {
  const f = ol.filter;
  return h(
    'div',
    { class: 'olf' },
    h('div', { class: 'olf-head' }, 'View'),
    h(
      'div',
      { class: 'olf-indent' },
      enumMenu(
        'olf-ovview',
        [
          { value: 'PROPERTIES', label: 'Properties', description: 'Each override with the properties it changes' },
          { value: 'HIERARCHIES', label: 'Hierarchies', description: 'The collections and objects of each override hierarchy' },
        ],
        f.lib_override_view_mode,
        (v) => set(ol, 'lib_override_view_mode', v),
      ),
    ),
    h('div', { class: 'olf-head' }, 'Filter'),
    h('div', { class: 'olf-check' }, checkbox('olf-ovsys', 'System Overrides', f.use_filter_lib_override_system, (v) => set(ol, 'use_filter_lib_override_system', v), { tip: 'Also list overrides made only because the hierarchy needs them' })),
  );
}
