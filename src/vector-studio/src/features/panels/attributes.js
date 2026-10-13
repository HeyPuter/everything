/**
 * Attributes panel: per-object settings that are not appearance.
 *
 *   overprintFill / overprintStroke   print the fill or stroke over the inks below
 *                                     (PDF overprint; SVG data attributes)
 *   showCenter                        draw the object's center point while selected
 *   fillRule                          'nonzero' | 'evenodd' for paths and compound paths
 *   (path direction)                  Reverse Path Direction shown as on/off buttons
 *   imageMap, url                     a link for web output: SVG <a href>, PDF link
 *   notes                             free text kept with the object (SVG data-notes)
 *
 * Overprint and fill rule apply to the paintable objects of the selection
 * (groups pass them to their contents); the other settings to the selected
 * objects themselves. Checkboxes show mixed values as indeterminate.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { signedArea, reverseAnchors } from '../../model/bezier.js';
import { nodeBounds } from '../../model/geometry.js';
import { paintTargets } from '../../ops/paint-ops.js';
import { overlayHooks } from '../../render/overlay.js';
import { svgNodeHooks } from '../io/hooks.js';

const escapeXml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** One value for a key across nodes: the value, 'mixed', or undefined for none. */
function common(nodes, get) {
  if (!nodes.length) return undefined;
  const first = get(nodes[0]);
  return nodes.every((n) => get(n) === first) ? first : 'mixed';
}

/** Direction of a closed path: 'cw' or 'ccw' on screen (y down), null when it has no area. */
export function pathDirection(node) {
  if (node?.type !== 'path' || node.anchors.length < 3) return null;
  const a = signedArea(node.anchors, true);
  if (Math.abs(a) < 1e-9) return null;
  return a > 0 ? 'cw' : 'ccw';
}

export function setPathDirection(doc, nodes, dir) {
  let n = 0;
  for (const node of nodes) {
    const paths = node.type === 'compound' ? node.children.map((c) => doc.get(c)) : [node];
    for (const p of paths) {
      const d = pathDirection(p);
      if (d && d !== dir) {
        doc.update(p.id, { anchors: reverseAnchors(p.anchors) });
        n++;
      }
    }
  }
  return n;
}

function shapes(editor) {
  return paintTargets(editor).filter((n) => n.type === 'path' || n.type === 'compound');
}

export function setAttribute(editor, key, value, label = 'Attributes') {
  const doc = editor.doc;
  const deep = key === 'overprintFill' || key === 'overprintStroke';
  const nodes = key === 'fillRule' ? shapes(editor) : deep ? paintTargets(editor) : editor.topSelection().map((id) => doc.get(id));
  const targets = nodes.filter((n) => n && (n[key] ?? defaultFor(key)) !== value);
  if (!targets.length) return 0;
  doc.transact(label, () => targets.forEach((n) => doc.update(n.id, { [key]: value === defaultFor(key) ? undefined : value })), { coalesce: key === 'notes' || key === 'url' ? `attr-${key}` : null });
  return targets.length;
}

function defaultFor(key) {
  if (key === 'fillRule') return 'nonzero';
  if (key === 'imageMap') return 'none';
  if (key === 'url' || key === 'notes') return '';
  return false;
}

/** Markup decoration for SVG export: data attributes and links. */
export function decorateSvg(node, xml, { nl, minify }) {
  const attrs = [];
  if (node.overprintFill) attrs.push('data-overprint-fill="true"');
  if (node.overprintStroke) attrs.push('data-overprint-stroke="true"');
  if (node.notes && !minify) attrs.push(`data-notes="${escapeXml(node.notes)}"`);
  if (node.imageMap && node.imageMap !== 'none' && node.url) attrs.push(`data-image-map="${node.imageMap}"`);
  let out = xml;
  if (attrs.length) out = out.replace(/<([a-zA-Z][\w:-]*)/, (m) => `${m} ${attrs.join(' ')}`);
  if (node.url && /^(https?:|mailto:|#|\/)/i.test(node.url)) out = `${nl}<a href="${escapeXml(node.url)}">${out}${nl}</a>`;
  return out;
}

/** Center marks for selected objects with Show Center. */
export function drawCenters(ctx, editor) {
  const doc = editor.doc;
  for (const id of editor.selection) {
    const n = doc.get(id);
    if (!n?.showCenter) continue;
    const b = nodeBounds(doc, n);
    if (!b) continue;
    const s = editor.view.toScreen(b.x + b.w / 2, b.y + b.h / 2);
    ctx.save();
    ctx.strokeStyle = '#4f80ff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x - 4, s.y);
    ctx.lineTo(s.x + 4, s.y);
    ctx.moveTo(s.x, s.y - 4);
    ctx.lineTo(s.x, s.y + 4);
    ctx.stroke();
    ctx.restore();
  }
}

export function installAttributeHooks() {
  if (!svgNodeHooks.includes(decorateSvg)) svgNodeHooks.push(decorateSvg);
  overlayHooks.add(drawCenters);
}

export class AttributesPanel extends Panel {
  static id = 'attributes';
  static title = 'Attributes';
  static icon = 'panel-attributes';
  static placement = 'strip';
  static shortcut = 'Mod+F11';

  menu() {
    const on = this.showOptions;
    return [{ label: on ? 'Hide Options' : 'Show Options', run: () => (this.app.prefs.set('attributesShowOptions', !on), this.update()) }, '-', 'color.overprintBlack'];
  }

  get showOptions() {
    return this.app.prefs.get('attributesShowOptions') !== false;
  }

  build() {
    const check = (key, label) => {
      const id = `attr-${key}`;
      const input = h('input', { type: 'checkbox', id, onchange: () => this.set(key, input.checked, label) });
      return { input, el: h('div.check-row', input, h('label', { for: id }, label)) };
    };
    this.opFill = check('overprintFill', 'Overprint Fill');
    this.opStroke = check('overprintStroke', 'Overprint Stroke');
    const toggle = (icn, label, onclick) => iconButton(icn, label, onclick, { pressed: false });
    this.centerOff = toggle('square', "Don't Show Center", () => this.set('showCenter', false, 'Show Center'));
    this.centerOn = toggle('center-point', 'Show Center', () => this.set('showCenter', true, 'Show Center'));
    this.dirCw = toggle('path-cw', 'Clockwise Path Direction', () => this.direction('cw'));
    this.dirCcw = toggle('path-ccw', 'Counterclockwise Path Direction', () => this.direction('ccw'));
    this.ruleNz = toggle('fill-nonzero', 'Use Non-Zero Winding Fill Rule', () => this.set('fillRule', 'nonzero', 'Fill Rule'));
    this.ruleEo = toggle('fill-evenodd', 'Use Even-Odd Fill Rule', () => this.set('fillRule', 'evenodd', 'Fill Rule'));
    this.imageMap = h(
      'select#attr-map.select',
      { onchange: () => this.set('imageMap', this.imageMap.value, 'Image Map') },
      h('option', { value: 'none' }, 'None'),
      h('option', { value: 'rect' }, 'Rectangle'),
      h('option', { value: 'polygon' }, 'Polygon'),
    );
    this.url = h('input#attr-url', { type: 'url', placeholder: 'https://', spellcheck: false, autocomplete: 'off' });
    this.url.addEventListener('change', () => this.set('url', this.url.value.trim(), 'URL'));
    this.url.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.url.blur();
    });
    this.openUrl = iconButton('external-link', 'Open URL in a new tab', () => {
      const u = this.url.value.trim();
      if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener');
    });
    this.notes = h('textarea#attr-notes', { rows: 3, spellcheck: true, placeholder: 'Notes about this object' });
    this.notes.addEventListener('change', () => this.set('notes', this.notes.value, 'Notes'));
    this.notes.addEventListener('keydown', (e) => e.stopPropagation());
    this.empty = h('p.panel-empty', 'Select objects to see their attributes.');
    this.body = h(
      'div.attr',
      h('div.attr-op', this.opFill.el, this.opStroke.el),
      h(
        'div.attr-toggles',
        h('div.segmented.attr-seg', { role: 'group', 'aria-label': 'Center point' }, this.centerOff, this.centerOn),
        h('div.segmented.attr-seg', { role: 'group', 'aria-label': 'Path direction' }, this.dirCw, this.dirCcw),
        h('div.segmented.attr-seg', { role: 'group', 'aria-label': 'Fill rule' }, this.ruleNz, this.ruleEo),
      ),
      (this.options = h(
        'div.attr-options',
        h('div.form-row.attr-row', h('label', { for: 'attr-map' }, 'Image Map'), this.imageMap),
        h('div.form-row.attr-row', h('label', { for: 'attr-url' }, 'URL'), h('div.attr-url', this.url, this.openUrl)),
        h('div.form-row.attr-row.attr-notes', h('label', { for: 'attr-notes' }, 'Notes'), this.notes),
      )),
    );
    this.el.append(this.empty, this.body);
  }

  set(key, value, label) {
    const ed = this.app.editor;
    if (!ed) return;
    setAttribute(ed, key, value, label);
    this.update();
  }

  direction(dir) {
    const ed = this.app.editor;
    if (!ed) return;
    const nodes = shapes(ed);
    ed.doc.transact('Reverse Path Direction', () => setPathDirection(ed.doc, nodes, dir));
    this.update();
  }

  update() {
    const ed = this.app.editor;
    const top = ed ? ed.topSelection().map((id) => ed.doc.get(id)).filter(Boolean) : [];
    this.empty.hidden = top.length > 0;
    this.body.hidden = !top.length;
    if (!top.length) return;
    this.options.hidden = !this.showOptions;
    const paints = paintTargets(ed);
    const shp = shapes(ed);
    const setCheck = (c, v, disabled) => {
      c.input.checked = v === true;
      c.input.indeterminate = v === 'mixed';
      c.input.disabled = disabled;
    };
    setCheck(this.opFill, common(paints, (n) => Boolean(n.overprintFill)), !paints.some((n) => n.fill));
    setCheck(this.opStroke, common(paints, (n) => Boolean(n.overprintStroke)), !paints.some((n) => n.stroke));
    const press = (b, on) => b.setAttribute('aria-pressed', String(on));
    const center = common(top, (n) => Boolean(n.showCenter));
    press(this.centerOff, center === false);
    press(this.centerOn, center === true);
    const dirs = shp.flatMap((n) => (n.type === 'compound' ? n.children.map((c) => pathDirection(ed.doc.get(c))) : [pathDirection(n)])).filter(Boolean);
    const dir = dirs.length ? (dirs.every((d) => d === dirs[0]) ? dirs[0] : 'mixed') : null;
    press(this.dirCw, dir === 'cw');
    press(this.dirCcw, dir === 'ccw');
    this.dirCw.disabled = this.dirCcw.disabled = !dirs.length;
    const rule = common(shp, (n) => n.fillRule || 'nonzero');
    press(this.ruleNz, rule === 'nonzero');
    press(this.ruleEo, rule === 'evenodd');
    this.ruleNz.disabled = this.ruleEo.disabled = !shp.length;
    const map = common(top, (n) => n.imageMap || 'none');
    this.imageMap.value = map === 'mixed' ? 'none' : map;
    const url = common(top, (n) => n.url || '');
    if (document.activeElement !== this.url) {
      this.url.value = url === 'mixed' ? '' : url;
      this.url.placeholder = url === 'mixed' ? 'Mixed' : 'https://';
    }
    this.openUrl.disabled = !/^https?:\/\//i.test(this.url.value.trim());
    const notes = common(top, (n) => n.notes || '');
    if (document.activeElement !== this.notes) {
      this.notes.value = notes === 'mixed' ? '' : notes;
      this.notes.placeholder = notes === 'mixed' ? 'Mixed' : 'Notes about this object';
    }
  }
}
