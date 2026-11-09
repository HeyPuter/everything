/**
 * View, inquiry, block, layer and clipboard commands.
 */
import { opts } from '../input.js';
import { transformEntity, lengthOf, areaOf } from '../../core/geom/index.js';
import { formatLinear, formatDirection } from '../../core/units.js';
import { M, dist, angleOf, fresh } from './util.js';
import { tableKey } from '../../core/schema.js';

// View ----------------------------------------------------------------------

export const ZOOM = {
  name: 'ZOOM',
  aliases: ['Z'],
  label: 'Zoom',
  icon: 'zoom-window',
  transparent: true,
  noRepeat: false,
  async run(ed, args) {
    const how =
      args?.mode ??
      (await ed.getKeyword(
        'Zoom',
        [
          { key: 'E', label: 'Extents', value: 'extents' },
          { key: 'W', label: 'Window', value: 'window' },
          { key: 'P', label: 'Previous', value: 'previous' },
          { key: 'I', label: 'In', value: 'in' },
          { key: 'O', label: 'Out', value: 'out' },
          { key: 'A', label: 'All', value: 'extents' },
        ],
        'window',
      ));
    if (!how) return;
    if (how === 'extents') return ed.zoomExtents();
    if (how === 'in') return ed.zoomBy(2);
    if (how === 'out') return ed.zoomBy(0.5);
    if (how === 'previous') return ed.app?.zoomPrevious();
    const a = await ed.getPoint('First corner of zoom window', { noSnap: true });
    if (!a || a.option) return;
    const b = await ed.getPoint('Opposite corner', {
      noSnap: true,
      rubber: false,
      onMove: (p) => {
        const s1 = ed.camera.toScreen(a.x, a.y),
          s2 = ed.camera.toScreen(p.x, p.y);
        ed.window = { x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y };
      },
    });
    ed.window = null;
    if (!b || b.option || Math.abs(b.x - a.x) < 1e-12 || Math.abs(b.y - a.y) < 1e-12) return;
    ed.app?.pushView();
    ed.camera.fit(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), 8);
    ed.viewChanged();
  },
};

export const PAN = {
  name: 'PAN',
  aliases: ['P'],
  label: 'Pan',
  icon: 'pan',
  transparent: true,
  async run(ed) {
    ed.panTool = true;
    ed.el.classList.add('pan-tool');
    try {
      await ed.getPoint('Drag to pan. Press Esc or Enter to exit.', { noSnap: true, rubber: false });
    } finally {
      ed.panTool = false;
      ed.el.classList.remove('pan-tool');
    }
  },
};

export const ZOOMEXTENTS = { name: 'ZOOMEXTENTS', aliases: ['ZE'], label: 'Zoom extents', icon: 'zoom-extents', noRepeat: true, transparent: true, run: (ed) => ed.zoomExtents() };
export const REGEN = { name: 'REGEN', aliases: ['RE', 'REGENALL'], label: 'Regenerate', icon: 'regen', transparent: true, run: (ed) => ed.renderer.rebuildAll() };

// Inquiry ---------------------------------------------------------------------

export const DIST = {
  name: 'DIST',
  aliases: ['DI'],
  label: 'Measure distance',
  icon: 'measure-dist',
  async run(ed) {
    const a = await ed.getPoint('First point');
    if (!a || a.option) return;
    const b = await ed.getPoint('Second point', { base: a });
    if (!b || b.option) return;
    const h = ed.header;
    const msg = `Distance = ${formatLinear(dist(a, b), h)},  Angle = ${formatDirection(angleOf(a, b), h, { symbol: true })},  Delta X = ${formatLinear(b.x - a.x, h)},  Delta Y = ${formatLinear(b.y - a.y, h)}`;
    ed.ui.log(msg, 'result');
    ed.ui.toast?.(`Distance ${formatLinear(dist(a, b), h)}`);
  },
};

export const AREA = {
  name: 'AREA',
  aliases: ['AA'],
  label: 'Measure area',
  icon: 'measure-area',
  async run(ed) {
    const first = await ed.getPoint('First corner point', { options: opts('Object') });
    if (!first) return;
    const h = ed.header;
    if (first.option === 'object') {
      const pick = await ed.getEntity('Select object', { filter: (e) => ['circle', 'polyline', 'ellipse', 'spline', 'hatch', 'arc'].includes(e.type) });
      if (!pick || pick.option) return;
      let a = 0,
        p = 0;
      try {
        a = areaOf(pick.ent);
        p = lengthOf(pick.ent);
      } catch {
        /* unsupported */
      }
      ed.ui.log(`Area = ${formatArea(a, h)},  Perimeter = ${formatLinear(p, h)}`, 'result');
      ed.ui.toast?.(`Area ${formatArea(a, h)}`);
      return;
    }
    const pts = [first];
    const poly = (extra) => {
      const all = extra ? pts.concat([extra]) : pts;
      const flat = [];
      for (const q of all) flat.push(q.x, q.y, 0);
      return ed.make('polyline', { pts: flat, closed: true, width: 0, color: 3 });
    };
    for (;;) {
      const q = await ed.getPoint('Next point (Enter for total)', { base: pts.at(-1), preview: (c) => [poly(c)] });
      if (!q) break;
      if (q.option) return;
      pts.push(q);
    }
    if (pts.length < 3) return;
    let a = 0,
      per = 0;
    // Relative to the first point, so far from the origin stays precise.
    const o = pts[0];
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i],
        p2 = pts[(i + 1) % pts.length];
      a += (p1.x - o.x) * (p2.y - o.y) - (p2.x - o.x) * (p1.y - o.y);
      per += dist(p1, p2);
    }
    a = Math.abs(a) / 2;
    ed.ui.log(`Area = ${formatArea(a, h)},  Perimeter = ${formatLinear(per, h)}`, 'result');
    ed.ui.toast?.(`Area ${formatArea(a, h)}`);
  },
};

function formatArea(a, h) {
  const prec = Math.max(0, h.linearPrecision ?? 4);
  return `${a.toFixed(prec)} sq ${h.units === 'unitless' ? 'units' : h.units}`;
}

export const ID = {
  name: 'ID',
  label: 'Point coordinates',
  icon: 'id-point',
  async run(ed) {
    const p = await ed.getPoint('Point');
    if (!p || p.option) return;
    ed.ui.log(`X = ${formatLinear(p.x, ed.header)}   Y = ${formatLinear(p.y, ed.header)}`, 'result');
  },
};

export const LIST = {
  name: 'LIST',
  aliases: ['LI', 'LS'],
  label: 'List',
  icon: 'list',
  async run(ed) {
    const ids = await ed.getSelection();
    const h = ed.header;
    for (const id of ids.slice(0, 50)) {
      const e = ed.drawing.get(id);
      const parts = [`${e.type.toUpperCase()}  Layer: ${e.layer}`];
      if (e.type === 'line') parts.push(`from ${fmtP(e.x1, e.y1, h)} to ${fmtP(e.x2, e.y2, h)}, length ${formatLinear(Math.hypot(e.x2 - e.x1, e.y2 - e.y1), h)}`);
      else if (e.type === 'circle') parts.push(`center ${fmtP(e.cx, e.cy, h)}, radius ${formatLinear(e.r, h)}`);
      else if (e.type === 'arc') parts.push(`center ${fmtP(e.cx, e.cy, h)}, radius ${formatLinear(e.r, h)}`);
      else if (e.x !== undefined) parts.push(`at ${fmtP(e.x, e.y, h)}`);
      try {
        const L = lengthOf(e);
        if (L && e.type !== 'line') parts.push(`length ${formatLinear(L, h)}`);
      } catch {
        /* no length */
      }
      ed.ui.log(parts.join('  '), 'result');
    }
    if (ids.length > 50) ed.ui.log(`and ${ids.length - 50} more`, 'muted');
    ed.clearSelection();
  },
};

const fmtP = (x, y, h) => `(${formatLinear(x, h)}, ${formatLinear(y, h)})`;

// Blocks ----------------------------------------------------------------------

export const BLOCK = {
  name: 'BLOCK',
  aliases: ['B'],
  label: 'Create block',
  icon: 'block-create',
  async run(ed) {
    const ids = await ed.getSelection('Select objects for the block');
    if (!ids.length) return;
    let name;
    for (;;) {
      name = (await ed.getString('Block name', { spaces: true })).trim();
      if (!name) return;
      if (/[<>/\\":;?*|=`]/.test(name)) {
        ed.ui.log('Block names cannot contain < > / \\ " : ; ? * | = or `.', 'error');
        continue;
      }
      // An existing block in another letter case is the same name.
      const same = tableKey(ed.drawing.blocks, name);
      if (same) {
        name = same;
        const r = await ed.getKeyword(`A block named "${name}" exists. Redefine it?`, opts('Yes', 'No'), 'no');
        if (r !== 'yes') continue;
      }
      break;
    }
    ed.setSelection(ids);
    const base = await ed.getPoint('Base point');
    if (!base || base.option) return;
    const ents = ids.map((id) => ed.drawing.get(id)).filter(Boolean);
    if (ents.some((e) => e.type === 'insert' && (e.name === name || refersTo(ed.drawing, e.name, name)))) {
      ed.ui.log('A block cannot contain a reference to itself.', 'error');
      return;
    }
    const local = ents.map((e, i) => ({ ...e, id: i + 1 }));
    ed.commit('Create block', () => {
      ed.drawing.setBlock(name, { name, bx: base.x, by: base.y, entities: local, description: '' });
      for (const id of ids) ed.drawing.remove(id);
      ed.drawing.add(ed.make('insert', { name, x: base.x, y: base.y, sx: 1, sy: 1, rot: 0 }));
    });
    ed.clearSelection();
    ed.ui.log(`Block "${name}" created from ${ids.length} object${ids.length === 1 ? '' : 's'}.`, 'muted');
  },
};

function refersTo(drawing, name, target, depth = 0) {
  const b = drawing.blocks.get(name);
  if (!b || depth > 16) return false;
  return b.entities.some((e) => e.type === 'insert' && (e.name === target || refersTo(drawing, e.name, target, depth + 1)));
}

export const INSERT = {
  name: 'INSERT',
  aliases: ['I'],
  label: 'Insert block',
  icon: 'block-insert',
  async run(ed, args) {
    let name = args?.name;
    if (!name) {
      const names = [...ed.drawing.blocks.keys()].filter((n) => !n.startsWith('*'));
      if (!names.length) {
        ed.ui.log('This drawing has no blocks yet. Use Create block first.', 'error');
        return;
      }
      if (ed.ui.chooseBlock) name = await ed.ui.chooseBlock();
      else name = await ed.getString(`Block name (${names.slice(0, 10).join(', ')})`, { spaces: true });
      if (!name) return;
    }
    const key = tableKey(ed.drawing.blocks, name);
    if (!key) {
      ed.ui.log(`There is no block named "${name}".`, 'error');
      return;
    }
    name = key;
    let sx = 1,
      rot = 0;
    for (;;) {
      const mk = (p) => ed.make('insert', { name, x: p.x, y: p.y, sx, sy: sx, rot });
      const p = await ed.getPoint('Insertion point', { options: opts('Scale', 'Rotate'), preview: (c) => [mk(c)] });
      if (!p) return;
      if (p.option === 'scale') {
        const k = await ed.getNumber('Scale factor', { default: sx });
        if (Number.isFinite(k) && k !== 0) sx = k;
        continue;
      }
      if (p.option === 'rotate') {
        const a = await ed.getAngle('Rotation angle', { default: rot });
        if (typeof a === 'number') rot = a;
        continue;
      }
      ed.commit('Insert block', () => ed.drawing.add(mk(p)));
      if (!args?.repeat) return;
    }
  },
};

// Layers ----------------------------------------------------------------------

async function pickLayerAction(ed, label, fn) {
  for (;;) {
    const pick = await ed.getEntity(`${label} (select an object on the layer, Enter to finish)`);
    if (!pick || pick.option) return;
    fn(pick.ent.layer);
  }
}

export const LAYMCUR = {
  name: 'LAYMCUR',
  label: 'Make object layer current',
  icon: 'layer-current',
  async run(ed) {
    const pick = ed.selection.size === 1 ? { ent: ed.drawing.get([...ed.selection][0]) } : await ed.getEntity('Select object whose layer will become current');
    if (!pick || pick.option) return;
    ed.commit('Set current layer', () => ed.drawing.setHeader({ clayer: pick.ent.layer }));
    ed.ui.log(`Current layer is now "${pick.ent.layer}".`, 'muted');
  },
};

export const LAYMATCH = {
  name: 'LAYMATCH',
  label: 'Match layer',
  icon: 'layer-match',
  async run(ed) {
    const ids = await ed.getSelection('Select objects to change');
    if (!ids.length) return;
    const t = await ed.getEntity('Select object on destination layer');
    if (!t || t.option) return;
    ed.commit('Match layer', () => ids.forEach((id) => ed.drawing.update(id, { layer: t.ent.layer })));
    ed.clearSelection();
  },
};

const setLayer = (ed, name, patch, label) => {
  const l = ed.drawing.layers.get(name);
  if (!l) return;
  if (patch.on === false && name === ed.header.clayer) ed.ui.log('The current layer was turned off.', 'muted');
  ed.commit(label, () => ed.drawing.setTable('layers', name, { ...l, ...patch }));
};

export const LAYOFF = { name: 'LAYOFF', label: 'Turn layer off', icon: 'layer-off', run: (ed) => pickLayerAction(ed, 'Turn off layer', (n) => setLayer(ed, n, { on: false }, 'Layer off')) };
export const LAYFRZ = {
  name: 'LAYFRZ',
  label: 'Freeze layer',
  icon: 'layer-freeze',
  run: (ed) =>
    pickLayerAction(ed, 'Freeze layer', (n) => {
      if (n === ed.header.clayer) return ed.ui.log('The current layer cannot be frozen.', 'error');
      setLayer(ed, n, { frozen: true }, 'Layer freeze');
    }),
};
export const LAYLCK = { name: 'LAYLCK', label: 'Lock layer', icon: 'layer-lock', run: (ed) => pickLayerAction(ed, 'Lock layer', (n) => setLayer(ed, n, { locked: true }, 'Layer lock')) };
export const LAYULK = {
  name: 'LAYULK',
  label: 'Unlock layer',
  icon: 'layer-unlock',
  async run(ed) {
    // Locked layers are not selectable, so pick by hovering any object on them.
    const locked = [...ed.drawing.layers.values()].filter((l) => l.locked).map((l) => l.name);
    if (!locked.length) return ed.ui.log('No layers are locked.', 'muted');
    const name = await ed.getString(`Layer to unlock (${locked.join(', ')})`, { default: locked[0], spaces: true });
    if (!name) return;
    const key = tableKey(ed.drawing.layers, name);
    if (key) setLayer(ed, key, { locked: false }, 'Layer unlock');
    else ed.ui.log(`There is no layer named "${name}".`, 'error');
  },
};
export const LAYON = {
  name: 'LAYON',
  label: 'Turn all layers on',
  icon: 'layers-on',
  run: (ed) =>
    ed.commit('All layers on', () => {
      for (const l of ed.drawing.layers.values()) if (!l.on) ed.drawing.setTable('layers', l.name, { ...l, on: true });
    }),
};
export const LAYTHW = {
  name: 'LAYTHW',
  label: 'Thaw all layers',
  icon: 'thaw',
  run: (ed) =>
    ed.commit('Thaw all layers', () => {
      for (const l of ed.drawing.layers.values()) if (l.frozen) ed.drawing.setTable('layers', l.name, { ...l, frozen: false });
    }),
};

export const LAYISO = {
  name: 'LAYISO',
  label: 'Isolate layers',
  icon: 'layer-iso',
  async run(ed) {
    const ids = await ed.getSelection('Select objects on the layers to isolate');
    if (!ids.length) return;
    const keep = new Set(ids.map((id) => ed.drawing.get(id).layer));
    // The layers turned off are kept in the drawing, in the same step, so
    // that undoing LAYISO also forgets them.
    ed.commit('Isolate layers', () => {
      const off = [...(ed.header.layiso ?? [])];
      for (const l of ed.drawing.layers.values()) {
        if (!keep.has(l.name) && l.on) {
          ed.drawing.setTable('layers', l.name, { ...l, on: false });
          off.push(l.name);
        }
      }
      if (!keep.has(ed.header.clayer)) ed.drawing.setHeader({ clayer: [...keep][0] });
      ed.drawing.setHeader({ layiso: off });
    });
    ed.clearSelection();
    ed.ui.log(`Isolated ${keep.size} layer${keep.size === 1 ? '' : 's'}. Use Unisolate to restore.`, 'muted');
  },
};

export const LAYUNISO = {
  name: 'LAYUNISO',
  label: 'Unisolate layers',
  icon: 'layer-uniso',
  run(ed) {
    const off = ed.header.layiso;
    if (!off?.length) return ed.ui.log('No layers are isolated.', 'muted');
    // Only the layers LAYISO turned off, if they are still off: other
    // changes made since are kept.
    ed.commit('Unisolate layers', () => {
      for (const name of off) {
        const l = ed.drawing.layers.get(name);
        if (l && !l.on) ed.drawing.setTable('layers', name, { ...l, on: true });
      }
      ed.drawing.setHeader({ layiso: undefined });
    });
  },
};

// Clipboard -------------------------------------------------------------------

const CLIP_PREFIX = 'web-cad-clipboard:';

function boundsOf(ed, ids) {
  let b = null;
  for (const id of ids) {
    const c = ed.doc.index.bounds(id);
    if (!c) continue;
    b = b ? [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[2]), Math.max(b[3], c[3])] : c.slice();
  }
  return b;
}

async function copyToClipboard(ed, ids, base) {
  const d = ed.drawing;
  const ents = ids.map((id) => d.get(id)).filter(Boolean);
  // Carry the block definitions and layers the objects depend on.
  const blocks = {};
  const collect = (list, depth = 0) => {
    for (const e of list) {
      if (e.type === 'insert' && !blocks[e.name] && depth < 16) {
        const b = d.blocks.get(e.name);
        if (b) {
          blocks[e.name] = b;
          collect(b.entities, depth + 1);
        }
      }
    }
  };
  collect(ents);
  // And the layers, linetypes and styles they use (inside those blocks too).
  const all = ents.concat(...Object.values(blocks).map((b) => b.entities));
  const pick = (table, list, key) =>
    [...new Set(list.map(key))].map((n) => d[table].get(n)).filter(Boolean);
  const layers = pick('layers', all, (e) => e.layer);
  const linetypes = pick('linetypes', [...all, ...layers], (e) => e.linetype);
  const dimmed = all.filter((e) => e.type === 'dimension' || e.type === 'leader');
  const dimStyles = pick('dimStyles', dimmed, (e) => e.style);
  const texts = all.filter((e) => e.type === 'text' || e.type === 'mtext');
  const textStyles = pick('textStyles', [...texts, ...dimStyles], (e) => e.style ?? e.textStyle);
  const tables = { layers, linetypes, textStyles, dimStyles };
  const data = { base, entities: ents, blocks: Object.values(blocks), ...tables };
  ed.app.clipboard = data;
  try {
    await navigator.clipboard?.writeText(CLIP_PREFIX + JSON.stringify(data));
  } catch {
    /* the in-app clipboard still works */
  }
}

export const COPYCLIP = {
  name: 'COPYCLIP',
  label: 'Copy to clipboard',
  icon: 'copy-clip',
  noRepeat: true,
  async run(ed) {
    const ids = await ed.getSelection();
    if (!ids.length) return;
    const b = boundsOf(ed, ids);
    await copyToClipboard(ed, ids, b ? { x: b[0], y: b[1] } : { x: 0, y: 0 });
    ed.ui.log(`${ids.length} object${ids.length === 1 ? '' : 's'} copied`, 'muted');
  },
};

export const CUTCLIP = {
  name: 'CUTCLIP',
  label: 'Cut',
  icon: 'cut',
  noRepeat: true,
  async run(ed) {
    const ids = await ed.getSelection();
    if (!ids.length) return;
    const b = boundsOf(ed, ids);
    await copyToClipboard(ed, ids, b ? { x: b[0], y: b[1] } : { x: 0, y: 0 });
    ed.commit('Cut', () => ids.forEach((id) => ed.drawing.remove(id)));
    ed.clearSelection();
  },
};

export const COPYBASE = {
  name: 'COPYBASE',
  label: 'Copy with base point',
  icon: 'copy-base',
  noRepeat: true,
  async run(ed) {
    const ids = await ed.getSelection();
    if (!ids.length) return;
    ed.renderer.setSelection(new Set(ids));
    const base = await ed.getPoint('Base point');
    if (!base || base.option) return;
    await copyToClipboard(ed, ids, base);
    ed.clearSelection();
  },
};

/**
 * Map clipboard objects and definitions onto names the drawing already has
 * in another letter case ('holes' onto 'Holes'), which DWG and DXF treat as
 * the same name.
 */
function sameNames(d, data) {
  const map = {};
  let any = false;
  for (const t of ['linetypes', 'textStyles', 'dimStyles', 'layers', 'blocks']) {
    map[t] = new Map();
    for (const v of data[t] || []) {
      const key = tableKey(d[t], v.name);
      if (key && key !== v.name) {
        map[t].set(v.name, key);
        any = true;
      }
    }
  }
  if (!any) return (e) => e;
  const ren = (t, n) => map[t].get(n) ?? n;
  const textual = (e) => e.type === 'text' || e.type === 'mtext';
  return (e) => {
    const out = { ...e };
    if (e.linetype !== undefined) out.linetype = ren('linetypes', e.linetype);
    if (e.textStyle !== undefined) out.textStyle = ren('textStyles', e.textStyle);
    // A layer or style record.
    if (!e.type) return out;
    out.layer = ren('layers', e.layer);
    if (e.type === 'insert') out.name = ren('blocks', e.name);
    if (e.style !== undefined) out.style = ren(textual(e) ? 'textStyles' : 'dimStyles', e.style);
    return out;
  };
}

export const PASTECLIP = {
  name: 'PASTECLIP',
  label: 'Paste',
  icon: 'paste',
  noRepeat: true,
  async run(ed) {
    let data = null;
    try {
      const text = await navigator.clipboard?.readText();
      if (text && text.startsWith(CLIP_PREFIX)) data = JSON.parse(text.slice(CLIP_PREFIX.length));
    } catch {
      /* fall back to the in-app clipboard */
    }
    data = data || ed.app.clipboard;
    if (!data || !data.entities?.length) {
      ed.ui.log('The clipboard has no drawing objects.', 'error');
      return;
    }
    const base = data.base || { x: 0, y: 0 };
    const at = (p) => data.entities.map((e) => transformEntity(e, M.translate(p.x - base.x, p.y - base.y)));
    const p = await ed.getPoint('Insertion point', { preview: (c) => at(c) });
    if (!p || p.option) return;
    const d = ed.drawing;
    const fix = sameNames(d, data);
    ed.commit('Paste', () => {
      // Definitions the drawing already has keep their own settings.
      for (const t of ['linetypes', 'textStyles', 'dimStyles', 'layers']) {
        for (const v of data[t] || []) if (!tableKey(d[t], v.name)) d.setTable(t, v.name, fix(v));
      }
      for (const b of data.blocks || []) {
        if (tableKey(d.blocks, b.name)) continue;
        d.setBlock(b.name, { ...b, entities: b.entities.map(fix) });
      }
      const ids = [];
      for (const e of at(p)) ids.push(d.add(fresh(fix(e))).id);
      return ids;
    });
  },
};

export const SELECTALL = {
  name: 'SELECTALL',
  aliases: ['AI_SELALL'],
  label: 'Select all',
  icon: 'select-all',
  noRepeat: true,
  run(ed) {
    ed.setSelection(ed._allEditable());
  },
};

export const SELECTSIMILAR = {
  name: 'SELECTSIMILAR',
  label: 'Select similar',
  icon: 'select-similar',
  async run(ed) {
    const ids = await ed.getSelection('Select example objects');
    if (!ids.length) return;
    // Same type, layer and name (block, style or hatch pattern), like
    // AutoCAD's default SELECTSIMILARMODE.
    const name = (e) => (e.type === 'insert' ? e.name : e.type === 'hatch' ? e.pattern : e.style);
    const key = (e) => `${e.type}|${e.layer}|${name(e) ?? ''}`;
    const keys = new Set(ids.map((id) => key(ed.drawing.get(id))));
    const out = [];
    for (const [id, e] of ed.drawing.entities) {
      if (keys.has(key(e)) && ed.drawing.layerEditable(e.layer)) out.push(id);
    }
    ed.setSelection(out);
  },
};

export const UNDO = { name: 'U', aliases: ['UNDO'], label: 'Undo', icon: 'undo', noRepeat: true, immediate: true, needsDoc: false, run: (ed) => ed.app.undo() };
export const REDO = { name: 'REDO', aliases: ['MREDO'], label: 'Redo', icon: 'redo', noRepeat: true, immediate: true, needsDoc: false, run: (ed) => ed.app.redo() };
