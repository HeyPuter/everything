// Outliner ▸ Video Sequencer display mode: the strips of the scene's sequencer (meta strips open
// to show what they hold), selection synced with the sequencer, and the strip operations of the
// row menu (outliner.data_operation).
import { app, registerOperators } from '../../app/app';
import type { DocumentData } from '../../data/types';
import type { Strip } from '../../sequencer/types';
import { findStrip, allStrips } from '../../sequencer/strips';
import { removeStrips } from '../../sequencer/ops';
import { stripIcon } from '../../sequencer/theme';
import { modeBuilders, type Row, type TreeNode } from './tree';
import { rowSync, currentOutlinerRows } from './sync';

function stripNode(s: Strip, depth: number): TreeNode {
  const kids = s.type === 'META' && s.strips?.length && depth < 32 ? s.strips : [];
  return {
    ekey: `st:${s.name}`,
    kind: 'strip',
    label: s.name,
    icon: s.type === 'META' ? 'seq_meta' : stripIcon(s.type),
    path: s.name,
    defaultOpen: false,
    searchable: true,
    children: () => [...kids].sort(order).map((k) => stripNode(k, depth + 1)),
  };
}

/** Channels from the top, then by start frame (the order the strips appear in the timeline). */
const order = (a: Strip, b: Strip) => b.channel - a.channel || a.frame_start - b.frame_start || a.name.localeCompare(b.name);

modeBuilders.SEQUENCE = (doc: DocumentData) => {
  const ed = doc.scene.sequence_editor;
  if (!ed?.strips.length) return [];
  return [...ed.strips].sort(order).map((s) => stripNode(s, 0));
};

const stripOf = (r: Row) => {
  const ed = app.doc.scene.sequence_editor;
  return ed && r.path ? findStrip(ed.strips, r.path) : null;
};

rowSync.strip = {
  get: (r) => !!stripOf(r)?.select,
  set: (r, v) => {
    const s = stripOf(r);
    if (s) s.select = v;
  },
  activate: (r) => {
    const ed = app.doc.scene.sequence_editor;
    const s = stripOf(r);
    if (ed && s) ed.active_strip = s.name;
  },
};

/** Strips of the selected rows (or the given names). */
function targetStrips(names: string): Strip[] {
  const ed = app.doc.scene.sequence_editor;
  if (!ed) return [];
  const list = names
    ? names.split('|')
    : currentOutlinerRows()
        .filter((r) => r.kind === 'strip' && r.path && stripOf(r)?.select)
        .map((r) => r.path!);
  return [...new Set(list)].map((n) => findStrip(ed.strips, n)).filter((s): s is Strip => !!s);
}

/** The list (top level or a meta strip's) that holds a strip. */
function holderOf(strips: Strip[], s: Strip): Strip[] | null {
  if (strips.includes(s)) return strips;
  for (const m of strips) if (m.strips?.length) {
    const h = holderOf(m.strips, s);
    if (h) return h;
  }
  return null;
}

registerOperators([
  {
    idname: 'outliner.data_operation',
    label: 'Outliner Data Operation',
    description: 'Operations on the selected non data-block elements (strips)',
    props: [
      {
        id: 'type',
        label: 'Data Operation',
        type: 'enum',
        default: 'SELECT',
        items: [
          ['SELECT', 'Select', 'Select the elements'],
          ['DESELECT', 'Deselect', 'Deselect the elements'],
          ['SELECT_LINKED', 'Select Strips Using the Same Data', 'Select every strip that shows the same file'],
          ['DELETE', 'Delete', 'Delete the elements'],
        ],
      },
      { id: 'names', label: 'Strips', type: 'string', default: '', hidden: true },
    ],
    poll: (ctx) => !!ctx.doc.scene.sequence_editor?.strips.length,
    invoke: (ctx, p) => {
      p.names = p.names || targetStrips('').map((s) => s.name).join('|');
      return operatorsExec(ctx.doc, p);
    },
    exec: (ctx, p) => operatorsExec(ctx.doc, p),
  },
]);

function operatorsExec(doc: DocumentData, p: Record<string, unknown>) {
  const ed = doc.scene.sequence_editor;
  const strips = targetStrips(String(p.names ?? ''));
  if (!ed || !strips.length) return 'CANCELLED' as const;
  switch (p.type) {
    case 'SELECT':
    case 'DESELECT':
      for (const s of strips) s.select = p.type === 'SELECT';
      break;
    case 'SELECT_LINKED': {
      const srcs = new Set(strips.map((s) => s.media?.filepath ?? s.scene ?? '').filter(Boolean));
      for (const s of allStrips(ed.strips)) if (srcs.has(s.media?.filepath ?? s.scene ?? '')) s.select = true;
      break;
    }
    case 'DELETE': {
      let n = 0;
      for (const s of strips) {
        const list = holderOf(ed.strips, s);
        if (list) n += removeStrips(list, [s]);
      }
      if (ed.active_strip && !findStrip(ed.strips, ed.active_strip)) ed.active_strip = null;
      app.report('INFO', `Deleted ${n} strip${n === 1 ? '' : 's'}`);
      break;
    }
    default:
      return 'CANCELLED' as const;
  }
  app.changed('doc', 'select');
  return 'FINISHED' as const;
}
