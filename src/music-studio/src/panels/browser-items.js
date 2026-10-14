// The browser's tree model, kept free of DOM so filtering and keyboard
// navigation are testable.
//
// Node = { id, label, kind, icon?, detail?, children?, lazy?, data?, keywords? }
//   kind: 'section' | 'group' | 'instrument' | 'preset' | 'effect' | 'pattern'
//         | 'channel' | 'sample' | 'automation' | 'folder' | 'file' | 'project'
//         | 'action' | 'note'
// A node with `children` (or `lazy`, children loaded on expand) is expandable.

import { INSTRUMENTS } from '../instruments/catalog.js';
import { SYNTH_PRESETS, DRUM_PRESETS } from '../instruments/presets.js';
import { EFFECTS, effectsByCategory } from '../effects/catalog.js';
import { patternColor } from '../model/project.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Instruments: the three types, then every preset by category. */
export function instrumentNodes() {
  const types = ['synth', 'drum', 'sampler'].map((type) => ({
    id: `inst:${type}`,
    label: INSTRUMENTS[type].label,
    kind: 'instrument',
    icon: INSTRUMENTS[type].icon,
    detail: INSTRUMENTS[type].description,
    data: { type, name: INSTRUMENTS[type].label, params: {} },
  }));
  const byCategory = (list, type, prefix) => {
    const groups = new Map();
    for (const p of list) {
      if (p.name === 'Init') continue;
      if (!groups.has(p.category)) groups.set(p.category, []);
      groups.get(p.category).push({ id: `preset:${type}:${p.name}`, label: p.name, kind: 'preset', icon: type, keywords: `${p.category} ${INSTRUMENTS[type].label}`, data: { type, name: p.name, params: p.params } });
    }
    return [...groups].map(([cat, children]) => ({ id: `${prefix}:${cat}`, label: cat, kind: 'group', children }));
  };
  return [
    ...types,
    { id: 'grp:synth', label: 'Synth presets', kind: 'group', icon: 'synth', children: byCategory(SYNTH_PRESETS, 'synth', 'cat:synth') },
    { id: 'grp:drum', label: 'Drum presets', kind: 'group', icon: 'drum', children: byCategory(DRUM_PRESETS, 'drum', 'cat:drum') },
  ];
}

/** Effects by category. */
export function effectNodes() {
  return [...effectsByCategory()].map(([cat, types]) => ({
    id: `fxcat:${cat}`,
    label: cat,
    kind: 'group',
    children: types.map((type) => ({ id: `fx:${type}`, label: EFFECTS[type].label, kind: 'effect', icon: 'fx', detail: EFFECTS[type].description, keywords: cat, data: { type } })),
  }));
}

/** The open project's parts, with counts. */
export function projectNodes(project) {
  const patterns = project.patterns.map((p) => {
    const notes = Object.values(p.notes).reduce((s, l) => s + l.length, 0);
    return { id: `pat:${p.id}`, label: p.name, kind: 'pattern', icon: 'pattern', color: patternColor(project, p), detail: notes ? plural(notes, 'note') : 'Empty', data: { id: p.id } };
  });
  const channels = project.channels.map((c) => ({ id: `ch:${c.id}`, label: c.name, kind: 'channel', icon: INSTRUMENTS[c.type]?.icon || 'synth', color: c.color, detail: INSTRUMENTS[c.type]?.label, keywords: INSTRUMENTS[c.type]?.label, data: { id: c.id } }));
  const samples = Object.values(project.samples).map((s) => ({ id: `smp:${s.id}`, label: s.name, kind: 'sample', icon: 'audio', detail: s.duration ? `${s.duration.toFixed(1)} s` : '', data: { id: s.id } }));
  const automation = Object.values(project.automation).map((a) => ({ id: `auto:${a.id}`, label: a.name, kind: 'automation', icon: 'automation', detail: plural(a.points.length, 'point'), data: { id: a.id } }));
  const group = (id, label, icon, children, emptyText) => ({ id, label, kind: 'group', icon, count: children.length, children: children.length ? children : [{ id: `${id}:empty`, label: emptyText, kind: 'note' }] });
  return [
    group('prj:patterns', 'Patterns', 'pattern', patterns, 'No patterns'),
    group('prj:channels', 'Channels', 'win-rack', channels, 'The rack is empty'),
    group('prj:samples', 'Samples', 'audio', samples, 'Import audio to add samples'),
    group('prj:automation', 'Automation', 'automation', automation, 'No automation clips'),
  ];
}

/** A short signature of what the project section shows (rebuild only when it changes). */
export function projectSignature(project) {
  const parts = [];
  for (const p of project.patterns) parts.push(p.id, p.name, p.color || '', Object.values(p.notes).reduce((s, l) => s + l.length, 0));
  parts.push('|');
  for (const c of project.channels) parts.push(c.id, c.name, c.color, c.type);
  parts.push('|');
  for (const s of Object.values(project.samples)) parts.push(s.id, s.name);
  parts.push('|');
  for (const a of Object.values(project.automation)) parts.push(a.id, a.name, a.points.length);
  return parts.join('\u0001');
}

const norm = (s) => String(s || '').toLowerCase();

/**
 * Filters a tree by a query: a node matches when every word is in its label,
 * its keywords or a parent's label. Matching groups keep all their children;
 * groups with matching descendants keep only those. Notes and actions are
 * dropped while searching. Returns a new tree (unchanged nodes when no query).
 */
export function filterNodes(nodes, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return nodes;
  const walk = (list, context) => {
    const out = [];
    for (const n of list) {
      if (n.kind === 'note' || n.kind === 'action') continue;
      const hay = `${context} ${norm(n.label)} ${norm(n.keywords)}`;
      const self = words.every((w) => hay.includes(w));
      const kids = n.children ? walk(n.children, `${context} ${norm(n.label)}`) : [];
      if (self && n.kind !== 'section' && n.kind !== 'group') out.push(n);
      else if (self && n.children && !kids.length) out.push({ ...n, children: n.children.filter((c) => c.kind !== 'note' && c.kind !== 'action') });
      else if (kids.length) out.push({ ...n, children: kids });
    }
    return out;
  };
  return walk(nodes, '');
}

/**
 * Visible rows in display order for the expanded set (every group is open
 * while `expandAll`). Rows carry level (1-based), parent, position in set
 * and size of set for ARIA.
 */
export function flattenNodes(nodes, expanded, { expandAll = false } = {}) {
  const rows = [];
  const walk = (list, level, parent) => {
    list.forEach((node, i) => {
      const expandable = Boolean(node.children?.length || node.lazy);
      const open = expandable && (expandAll || expanded.has(node.id));
      rows.push({ node, level, parent, expandable, open, pos: i + 1, size: list.length });
      if (open && node.children) walk(node.children, level + 1, node.id);
    });
  };
  walk(nodes, 1, null);
  return rows;
}

/** Type-ahead: the next row (after `from`) whose label starts with `prefix`, or -1. */
export function typeahead(rows, from, prefix) {
  const p = norm(prefix);
  if (!p) return -1;
  const n = rows.length;
  const start = p.length === 1 ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (norm(rows[i].node.label).startsWith(p)) return i;
  }
  return -1;
}

/** Counts every leaf (non-group) node in a tree, for result announcements. */
export function countLeaves(nodes) {
  let n = 0;
  for (const x of nodes) {
    if (x.children) n += countLeaves(x.children);
    else if (x.kind !== 'note' && x.kind !== 'action') n++;
  }
  return n;
}
