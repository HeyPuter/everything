/**
 * Blends: Object > Blend > Make / Release / Blend Options / Expand, the
 * Blend tool (W) and the live renderer hook. The key objects stay normal,
 * editable children of the blend group; the steps between them are drawn
 * from blend-math.js.
 */
import { h } from '../../lib/dom.js';
import { Tool, tol } from '../../tools/tool.js';
import { hitTest, hitNode } from '../../render/hit.js';
import { nodeBounds, transformPatches } from '../../model/geometry.js';
import { createGroup } from '../../model/nodes.js';
import { reverseAnchors } from '../../model/bezier.js';
import { pathSampler } from '../../model/path-sampler.js';
import { translate } from '../../lib/matrix.js';
import { numberField } from '../../ui/widgets.js';
import { blendSteps, virtualDoc, expandedSubtrees, blendSpine, blendKeys, DEFAULT_BLEND } from './blend-math.js';

/**
 * Hit test the generated steps of visible, unlocked blends (the key objects
 * are ordinary children and hit normally). Returns a key object of the blend
 * that was hit, so the Selection tool picks the blend group, or null.
 */
export function blendHit(doc, x, y, tolerance, { outline = false } = {}) {
  let found = null;
  doc.walk((n) => {
    if (found || n.hidden || n.locked) return false;
    if (n.type !== 'group' || !n.blend) return true;
    const b = nodeBounds(doc, n);
    if (!b || x < b.x - tolerance || x > b.x + b.w + tolerance || y < b.y - tolerance || y > b.y + b.h + tolerance) return false;
    const { runs, extra } = blendSteps(doc, n);
    const vdoc = virtualDoc(doc, extra);
    const leaves = (v, out = []) => {
      if (v.type === 'group') for (const c of v.children) leaves(vdoc.get(c), out);
      else out.push(v);
      return out;
    };
    for (const run of runs) {
      for (const step of run.nodes) {
        if (leaves(step).some((leaf) => hitNode(vdoc, leaf, x, y, tolerance, { outline }))) {
          found = doc.get(n.children[0]);
          return false;
        }
      }
    }
    return true;
  });
  return found;
}

export function blendOptionsFor(app) {
  return { ...DEFAULT_BLEND, ...(app.prefs.get('blendOptions') || {}) };
}

/** Make a blend from ids (inside a transaction). Returns the blend group id. */
export function makeBlend(doc, ids, blend = DEFAULT_BLEND) {
  const sorted = doc.sortByPaintOrder(ids);
  const top = doc.get(sorted[sorted.length - 1]);
  const parent = doc.get(top.parent);
  const index = parent.children.indexOf(top.id) + 1;
  const g = createGroup([], { blend: { ...DEFAULT_BLEND, ...blend } });
  doc.insert(g, parent.id, index);
  for (const id of sorted) doc.move(id, g.id);
  return g.id;
}

/** Release a blend: its key objects (and spine, painted again) go back to the parent (inside a transaction). */
export function releaseBlend(doc, id) {
  const g = doc.get(id);
  if (!g?.blend) return [];
  const parent = doc.get(g.parent);
  let index = parent.children.indexOf(id);
  const kids = g.children.slice();
  for (const c of kids) {
    const n = doc.get(c);
    if (n?.blendSpine) doc.update(c, { blendSpine: undefined, spineStyle: undefined, ...(n.spineStyle || { stroke: { type: 'solid', color: '#000000' }, strokeWidth: 1 }) });
    doc.move(c, parent.id, index++);
  }
  doc.remove(id);
  return kids;
}

/** Move every key object of a blend by its own matrix (key id -> matrix). */
function moveKeys(doc, moves) {
  for (const [id, m] of moves) {
    const n = doc.get(id);
    if (!n) continue;
    for (const [nid, patch] of transformPatches(doc, n, m, {})) doc.update(nid, patch);
  }
}

/** Where key k of K sits on a spine sampler. */
const keyPoint = (sampler, k, count) => sampler.at(count > 1 ? (k / (count - 1)) * sampler.length : 0);

/**
 * Replace Spine (inside a transaction): `pathId` becomes the blend's
 * spine (unpainted; its paint returns on Release) and the keys move onto
 * it, spread evenly by length. A previous spine is deleted.
 */
export function replaceSpine(doc, blendId, pathId) {
  const g = doc.get(blendId);
  const path = doc.get(pathId);
  if (!g?.blend || path?.type !== 'path' || path.anchors.length < 2) return false;
  const old = blendSpine(doc, g);
  if (old && old.id !== pathId) doc.remove(old.id);
  doc.update(pathId, { blendSpine: true, spineStyle: { fill: path.fill ?? null, stroke: path.stroke ?? null, strokeWidth: path.strokeWidth ?? 0 }, fill: null, stroke: null, shape: undefined });
  doc.move(pathId, blendId, 0);
  const keys = blendKeys(doc, doc.get(blendId));
  const sampler = pathSampler(path.anchors, path.closed);
  const moves = new Map();
  keys.forEach((k, i) => {
    const b = nodeBounds(doc, k);
    if (!b) return;
    const p = keyPoint(sampler, i, keys.length);
    moves.set(k.id, translate(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2)));
  });
  moveKeys(doc, moves);
  return true;
}

/**
 * Reverse Spine (inside a transaction): the keys trade places along the
 * spine (front key to the start, back key to the end, and so on); a spine
 * path is reversed with them.
 */
export function reverseSpine(doc, blendId) {
  const g = doc.get(blendId);
  if (!g?.blend) return false;
  const keys = blendKeys(doc, g);
  if (keys.length < 2) return false;
  const spine = blendSpine(doc, g);
  const moves = new Map();
  if (spine) {
    const before = pathSampler(spine.anchors, spine.closed);
    const anchors = reverseAnchors(spine.anchors);
    const after = pathSampler(anchors, spine.closed);
    doc.update(spine.id, { anchors });
    keys.forEach((k, i) => {
      const p = keyPoint(before, i, keys.length);
      const q = keyPoint(after, i, keys.length);
      moves.set(k.id, translate(q.x - p.x, q.y - p.y));
    });
  } else {
    const centers = keys.map((k) => {
      const b = nodeBounds(doc, k);
      return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
    });
    keys.forEach((k, i) => {
      const from = centers[i];
      const to = centers[keys.length - 1 - i];
      if (from && to) moves.set(k.id, translate(to.x - from.x, to.y - from.y));
    });
  }
  moveKeys(doc, moves);
  return true;
}

/** Reverse Front to Back (inside a transaction): the keys' stacking order flips, positions stay. */
export function reverseFrontToBack(doc, blendId) {
  const g = doc.get(blendId);
  if (!g?.blend) return false;
  const spines = g.children.filter((c) => doc.get(c)?.blendSpine);
  const keys = g.children.filter((c) => !doc.get(c)?.blendSpine);
  doc.update(blendId, { children: [...spines, ...keys.reverse()] });
  return true;
}

/** Expand a blend into a plain group of keys and real step objects (inside a transaction). */
export function expandBlend(doc, id) {
  const g = doc.get(id);
  if (!g?.blend) return null;
  const spine = blendSpine(doc, g);
  const subs = expandedSubtrees(doc, g);
  if (spine) doc.remove(spine.id);
  let i = 0;
  for (const s of subs) {
    if (s.key) {
      doc.move(s.id, id, i++);
    } else {
      doc.importSubtree(s.sub, id, i++);
    }
  }
  doc.update(id, { blend: undefined });
  return id;
}

/** Blend groups in or above the selection. */
export function selectedBlends(editor) {
  const out = new Set();
  for (const id of editor.selection) {
    let n = editor.doc.get(id);
    while (n && !n.blend) n = n.parent ? editor.doc.get(n.parent) : null;
    if (n) out.add(n.id);
  }
  return [...out];
}

/** Replace Spine operands: one selected blend and one selected path outside it, or null. */
export function spineOperands(editor) {
  const top = editor.topSelection().map((id) => editor.doc.get(id)).filter(Boolean);
  const blends = top.filter((n) => n.type === 'group' && n.blend);
  const paths = top.filter((n) => n.type === 'path' && n.anchors.length >= 2);
  if (blends.length !== 1 || paths.length !== 1 || top.length !== 2) return null;
  return { blend: blends[0].id, path: paths[0].id };
}

function blendOptionsDialog(app) {
  const ed = app.editor;
  const blends = ed ? selectedBlends(ed) : [];
  const cur = blends.length ? { ...DEFAULT_BLEND, ...ed.doc.get(blends[0]).blend } : blendOptionsFor(app);
  const unit = ed?.doc.root.units || 'pt';
  const spacingId = 'blend-spacing';
  const spacingSel = h(
    'select.select',
    { id: spacingId },
    [
      ['smooth', 'Smooth Color'],
      ['steps', 'Specified Steps'],
      ['distance', 'Specified Distance'],
    ].map(([v, l]) => h('option', { value: v, selected: v === cur.spacing }, l)),
  );
  const state = { ...cur };
  const steps = numberField({ label: 'Steps', kind: 'number', value: cur.steps, min: 1, max: 1000, onCommit: (v) => ((state.steps = Math.round(v)), preview()) });
  const dist = numberField({ label: 'Distance', value: cur.distance, unit, min: 0.01, onCommit: (v) => ((state.distance = v), preview()) });
  const sync = () => {
    state.spacing = spacingSel.value;
    steps.el.hidden = state.spacing !== 'steps';
    dist.el.hidden = state.spacing !== 'distance';
  };
  spacingSel.addEventListener('change', () => (sync(), preview()));
  const orientName = 'blend-orient';
  const orient = h(
    'div.radio-group',
    { role: 'radiogroup', 'aria-label': 'Orientation' },
    [
      ['page', 'Align to Page'],
      ['path', 'Align to Path'],
    ].map(([v, l]) => h('label.radio', h('input', { type: 'radio', name: orientName, value: v, checked: v === cur.orientation, onchange: () => ((state.orientation = v), preview()) }), l)),
  );
  const prevId = 'blend-preview';
  const prevChk = h('input', { type: 'checkbox', id: prevId, onchange: () => preview() });
  let tx = null;
  const preview = () => {
    if (!blends.length) return;
    if (tx) {
      tx.cancel();
      tx = null;
    }
    if (!prevChk.checked) return;
    tx = ed.doc.begin('Blend Options');
    for (const id of blends) ed.doc.update(id, { blend: { ...state } });
  };
  sync();
  const body = h(
    'div.form.blend-options',
    h('div.form-row', h('label', { for: spacingId }, 'Spacing'), spacingSel),
    steps.el,
    dist.el,
    h('div.form-row', h('span.form-label', 'Orientation'), orient),
    blends.length ? h('div.form-row.check', prevChk, h('label', { for: prevId }, 'Preview')) : h('p.form-help', 'No blend is selected: these options apply to new blends.'),
  );
  return app.dialogs
    .open({
      title: 'Blend Options',
      body,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'OK', primary: true, value: () => (steps.input.dispatchEvent(new Event('blur')), dist.input.dispatchEvent(new Event('blur')), true) },
      ],
    })
    .then((ok) => {
      if (tx) {
        tx.cancel();
        tx = null;
      }
      if (!ok) return;
      app.prefs.set('blendOptions', { ...state });
      // Blends that already have these options are left alone (an unchanged OK adds no undo step).
      const changed = blends.filter((id) => {
        const o = { ...DEFAULT_BLEND, ...ed.doc.get(id)?.blend };
        return Object.keys(state).some((k) => o[k] !== state[k]);
      });
      if (changed.length) {
        ed.doc.transact('Blend Options', () =>
          changed.forEach((id) => ed.doc.update(id, { blend: { ...state } })),
        );
      }
    });
}

export function registerBlendCommands(app) {
  const ed = () => app.editor;
  app.commands.register([
    {
      id: 'blend.make',
      label: 'Make',
      shortcut: 'Alt+Mod+B',
      enabled: (a) => (a.editor?.topSelection().length || 0) >= 2,
      run: () => {
        const e = ed();
        let gid;
        e.doc.transact('Make Blend', () => {
          gid = makeBlend(e.doc, e.topSelection(), blendOptionsFor(app));
        });
        e.select([gid]);
      },
    },
    {
      id: 'blend.release',
      label: 'Release',
      shortcut: 'Alt+Shift+Mod+B',
      enabled: (a) => Boolean(a.editor && selectedBlends(a.editor).length),
      run: () => {
        const e = ed();
        const out = [];
        e.doc.transact('Release Blend', () => {
          for (const id of selectedBlends(e)) out.push(...releaseBlend(e.doc, id));
        });
        e.select(out);
      },
    },
    { id: 'blend.options', label: 'Blend Options...', run: () => blendOptionsDialog(app) },
    {
      id: 'blend.replaceSpine',
      label: 'Replace Spine',
      enabled: (a) => Boolean(a.editor && spineOperands(a.editor)),
      run: () => {
        const e = ed();
        const ops = spineOperands(e);
        if (!ops) return;
        e.doc.transact('Replace Spine', () => replaceSpine(e.doc, ops.blend, ops.path));
        e.select([ops.blend]);
      },
    },
    {
      id: 'blend.reverseSpine',
      label: 'Reverse Spine',
      enabled: (a) => Boolean(a.editor && selectedBlends(a.editor).length),
      run: () => {
        const e = ed();
        e.doc.transact('Reverse Spine', () => selectedBlends(e).forEach((id) => reverseSpine(e.doc, id)));
      },
    },
    {
      id: 'blend.reverseFrontToBack',
      label: 'Reverse Front to Back',
      enabled: (a) => Boolean(a.editor && selectedBlends(a.editor).length),
      run: () => {
        const e = ed();
        e.doc.transact('Reverse Front to Back', () => selectedBlends(e).forEach((id) => reverseFrontToBack(e.doc, id)));
      },
    },
    {
      id: 'blend.expand',
      label: 'Expand',
      enabled: (a) => Boolean(a.editor && selectedBlends(a.editor).length),
      run: () => {
        const e = ed();
        const ids = selectedBlends(e);
        e.doc.transact('Expand Blend', () => ids.forEach((id) => expandBlend(e.doc, id)));
        e.select(ids);
      },
    },
  ]);
}

/**
 * Blend tool: click one object, then another, to blend them. Alt-click or
 * double-clicking the tool opens Blend Options.
 */
export class BlendTool extends Tool {
  static id = 'blend';
  static label = 'Blend Tool';
  static shortcut = 'W';
  static icon = 'tool-blend';
  static hint = 'Click an object, then click another object to blend them | Option+Click for Blend Options';

  constructor(app) {
    super(app);
    this.first = null;
  }

  activate() {
    this.first = null;
    this.setCursor('crosshair');
    this.status();
  }

  deactivate() {
    this.first = null;
  }

  hitAt(e) {
    const editor = this.editor;
    return hitTest(editor.doc, e.x, e.y, tol(editor, 3), { outline: editor.viewOptions.mode === 'outline' });
  }

  onHover(e) {
    const hit = this.hitAt(e);
    this.setCursor(hit ? 'pointer' : 'crosshair');
    const id = hit ? this.editor.selectionTarget(hit.id).id : null;
    if (this.editor.hover !== id) {
      this.editor.hover = id;
      this.overlay();
    }
  }

  onPointerDown(e) {
    const ed = this.editor;
    if (e.alt) {
      this.app.commands.run('blend.options');
      return;
    }
    const hit = this.hitAt(e);
    if (!hit) {
      this.first = null;
      this.overlay();
      return;
    }
    const target = ed.selectionTarget(hit.id);
    if (!this.first || !ed.doc.has(this.first) || this.first === target.id) {
      this.first = target.id;
      ed.select([target.id]);
      this.status('Click another object to blend with it');
      return;
    }
    const ids = [this.first, target.id];
    this.first = null;
    let gid;
    ed.doc.transact('Make Blend', () => {
      gid = makeBlend(ed.doc, ids, blendOptionsFor(this.app));
    });
    ed.select([gid]);
    this.status();
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' && this.first) {
      this.first = null;
      this.status();
      return true;
    }
    return false;
  }

  cancel() {
    this.first = null;
  }

  openOptions() {
    this.app.commands.run('blend.options');
  }
}
