// Geometry Nodes modifier panel (Properties ▸ Modifiers): node group selector, the group's
// interface inputs (value or attribute), output attributes and node warnings.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { modifierExtraUI } from '../editors/properties/stack';
import { dataBlockSelector } from '../editors/properties/tabs';
import { num, bool, vecProp, colorProp, textProp, splitRow } from '../ui/props';
import { enumMenu, textField, panel, checkbox } from '../ui/widgets';
import { interfaceSocketType } from '../nodes/registry';
import { newNodeGroup, uid } from '../data/defaults';
import { uniqueGroupName } from '../nodes/tree';
import type { ModifierBase, NodeGroupData, ObjectData } from '../data/types';
import { gnResults } from './results';
import { syncModifierInputs, setActiveModifier } from './editor';
import { FIELD_TYPES } from './evaluator';
import { unitOf } from '../nodes/editor/nodeui';
import { groupInputMenuItems } from './nodes/switches';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

function attrToggle(m: ModifierBase, id: string): Child {
  const on = !!m[`${id}_use_attribute`];
  return h(
    'button',
    {
      class: { 'gn-attr-toggle': true, on },
      'data-tip': 'Input Attribute Toggle\nSwitch between an attribute and a single value to define the data for every element',
      'aria-pressed': on ? 'true' : 'false',
      onclick: () =>
        app.run('object.geometry_nodes_input_attribute_toggle', {
          modifier_name: m.name,
          input_name: id,
        }),
    },
    icon('gn_attribute'),
  );
}

function inputRow(ob: ObjectData, m: ModifierBase, it: NonNullable<NodeGroupData['tree']['interface']>[number]): Child {
  const { type, subtype } = interfaceSocketType(it.socket_type);
  const id = it.identifier;
  const label = it.name;
  const field = FIELD_TYPES.has(type);
  if (field && m[`${id}_use_attribute`]) {
    const key = `${id}_attribute_name`;
    if (typeof m[key] !== 'string') m[key] = '';
    return splitRow(
      label,
      textField(`gnmod-${m.id}-${id}-attr`, String(m[key] ?? ''), (v) => ((m[key] = v), changed('Set Attribute Name')), { placeholder: 'Attribute', icon: 'spreadsheet' }),
      attrToggle(m, id),
    );
  }
  const deco = field ? attrToggle(m, id) : undefined;
  const opts = {
    unit: unitOf(subtype),
    min: it.min_value,
    max: it.max_value,
    undo: `Change ${label}`,
  };
  let w: Child;
  switch (type) {
    case 'FLOAT':
      w = num(m, id, label, { ...opts, slider: subtype === 'FACTOR' });
      break;
    case 'INT':
      w = num(m, id, label, { ...opts, int: true });
      break;
    case 'BOOLEAN':
      w = bool(m, id, label);
      break;
    case 'VECTOR':
    case 'ROTATION':
      if (!Array.isArray(m[id])) m[id] = [0, 0, 0];
      w = vecProp(m, id, label, {
        unit: type === 'ROTATION' ? 'angle' : unitOf(subtype),
      });
      break;
    case 'RGBA':
      if (!Array.isArray(m[id])) m[id] = [0.8, 0.8, 0.8, 1];
      w = colorProp(m, id, label, { alpha: true });
      break;
    case 'STRING':
      w = textProp(m, id, label);
      break;
    case 'OBJECT':
    case 'COLLECTION':
    case 'MATERIAL': {
      const doc = app.doc;
      const list: { id: string; name: string }[] =
        type === 'OBJECT'
          ? Object.values(doc.objects).filter((o) => o.id !== ob.id)
          : type === 'COLLECTION'
            ? Object.values(doc.collections).filter((c) => c.id !== doc.scene.collection)
            : Object.values(doc.materials);
      const ic = type === 'OBJECT' ? 'object' : type === 'COLLECTION' ? 'collection' : 'material';
      w = splitRow(
        label,
        enumMenu(
          `gnmod-${m.id}-${id}`,
          [{ value: '', label: '—' }, ...list.map((o) => ({ value: o.id, label: o.name, icon: ic }))],
          String(m[id] ?? ''),
          (v) => ((m[id] = v || null), changed(`Set ${label}`)),
          { title: label },
        ),
      );
      break;
    }
    case 'MENU': {
      const g = typeof m.node_group === 'string' ? app.doc.node_groups[m.node_group] : undefined;
      const items = g ? groupInputMenuItems(app.doc, g.tree, id) : [];
      const cur = typeof m[id] === 'string' && items.includes(m[id] as string) ? (m[id] as string) : String(it.default_value ?? items[0] ?? '');
      w = splitRow(
        label,
        enumMenu(
          `gnmod-${m.id}-${id}`,
          items.map((v) => ({ value: v, label: v })),
          cur,
          (v) => ((m[id] = v), changed(`Set ${label}`)),
          { title: label, disabled: !items.length },
        ),
      );
      break;
    }
    default:
      w = splitRow(label, h('span', { class: 'prop-note' }, '—'));
  }
  if (!deco) return w;
  // put the attribute toggle in the decorator column of the (first) row
  return h('div', { class: 'gn-input-row' }, w, h('div', { class: 'gn-input-toggle' }, deco));
}

function nodesPanel(ob: ObjectData, m: ModifierBase): Child {
  const doc = app.doc;
  const g = typeof m.node_group === 'string' ? doc.node_groups[m.node_group] : undefined;
  if (g) syncModifierInputs(m, g);
  const groups = Object.values(doc.node_groups).filter((x) => x.tree.type === 'GEOMETRY');
  const users = g ? Object.values(doc.objects).reduce((s, o) => s + o.modifiers.filter((x) => x.type === 'NODES' && x.node_group === g.id).length, 0) : 0;
  const inputs = (g?.tree.interface ?? []).filter((i) => i.in_out === 'INPUT');
  const firstGeo = inputs.find((i) => interfaceSocketType(i.socket_type).type === 'GEOMETRY');
  const outputs = (g?.tree.interface ?? []).filter((i) => i.in_out === 'OUTPUT' && FIELD_TYPES.has(interfaceSocketType(i.socket_type).type));
  const res = gnResults.get(ob.id);
  // messages with their severity (errors first, then warnings, then info), each listed once
  const warnings: { text: string; kind: string }[] = [];
  if (res && res.modifierId === m.id)
    for (const [key, list] of res.warnings) for (const text of list) if (!warnings.some((w) => w.text === text)) warnings.push({ text, kind: res.warningKinds?.get(`${key}\n${text}`) ?? 'WARNING' });
  const rank: Record<string, number> = { ERROR: 0, WARNING: 1, INFO: 2 };
  warnings.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return h(
    'div',
    {
      class: 'gn-mod',
      onpointerdown: () => {
        if (!m.is_active) {
          setActiveModifier(ob, m);
          app.changed('ui');
        }
      },
    },
    dataBlockSelector(
      `gnmod-${m.id}-ng`,
      'node_tree',
      groups,
      g?.id ?? null,
      (id) => {
        m.node_group = id;
        if (id) syncModifierInputs(m, doc.node_groups[id]);
        changed('Assign Node Group');
      },
      () => {
        const ng = newNodeGroup(uniqueGroupName(doc, 'Geometry Nodes'));
        doc.node_groups[ng.id] = ng;
        m.node_group = ng.id;
        setActiveModifier(ob, m);
        changed('New Node Group');
      },
      {
        users,
        duplicate: g
          ? () => {
              const d = structuredClone(g);
              d.id = uid('ng');
              d.name = uniqueGroupName(doc, g.name);
              doc.node_groups[d.id] = d;
              m.node_group = d.id;
              changed('Copy Node Group');
            }
          : undefined,
      },
    ),
    warnings.length
      ? h(
          'div',
          { class: 'gn-warnings' },
          warnings.slice(0, 8).map((w, i) => h('div', { key: String(i), class: `mod-error gn-${w.kind.toLowerCase()}` }, icon(w.kind === 'INFO' ? 'info' : 'error'), w.text)),
        )
      : null,
    ...(() => {
      // inputs outside interface panels, then one collapsible section per panel
      const shown = inputs.filter((i) => i !== firstGeo && interfaceSocketType(i.socket_type).type !== 'GEOMETRY');
      const panels = g?.tree.interface_panels ?? [];
      const row = (it: (typeof shown)[number]) => h('div', { key: it.identifier, class: 'gn-input' }, inputRow(ob, m, it));
      return [
        shown.filter((i) => !i.panel || !panels.some((p) => p.identifier === i.panel)).map(row),
        panels.map((p) => {
          const toggle = p.toggle ? shown.find((i) => i.identifier === p.toggle) : undefined;
          const members = shown.filter((i) => i.panel === p.identifier && i !== toggle);
          // a panel toggle is a checkbox in the panel header
          const header = toggle
            ? h(
                'span',
                { class: 'gn-panel-toggle' },
                checkbox(`gnmod-${m.id}-pt-${toggle.identifier}`, '', m[toggle.identifier] === undefined ? toggle.default_value !== false : !!m[toggle.identifier], (v) => {
                  m[toggle.identifier] = v;
                  changed('Toggle Panel');
                }),
              )
            : undefined;
          return members.length || toggle ? panel(`gnmod-${m.id}-p-${p.identifier}`, p.name, () => members.map(row), { sub: true, closed: !!p.default_closed, header }) : null;
        }),
      ];
    })(),
    outputs.length
      ? panel(
          `gnmod-${m.id}-outattrs`,
          'Output Attributes',
          () =>
            outputs.map((it) => {
              const key = `${it.identifier}_attribute_name`;
              if (typeof m[key] !== 'string') m[key] = '';
              return textProp(m, key, it.name);
            }),
          { sub: true, closed: true },
        )
      : null,
  );
}

modifierExtraUI.NODES = (ob, m) => nodesPanel(ob, m);
