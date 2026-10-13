/**
 * Document Info panel: what the document (or, with Selection Only, the
 * selection) contains: document settings, objects by kind, graphic styles,
 * brushes, global color, spot color, pattern and gradient objects, swatches, fonts (and
 * their details), and linked and embedded images. The category menu (also
 * in the panel menu) narrows the view; Save writes the report as a text
 * file. File > Document Info shows the same document summary as a dialog.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { formatLength, UNITS } from '../../lib/units.js';
import { graphicStylesOf } from '../paint/graphic-styles.js';
import { swatchesOf } from '../paint/swatch-model.js';
import { matchesStyle } from './select-commands.js';
import { fontsUsed } from './file-commands.js';
import { imageInfo } from './links.js';
import { documentStats } from '../files/document-stats.js';
import { docBrushes } from '../brushes/brush-model.js';

export const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Document' },
  { id: 'objects', label: 'Objects' },
  { id: 'styles', label: 'Graphic Styles' },
  { id: 'brushes', label: 'Brushes' },
  { id: 'globalColors', label: 'Global Color Objects' },
  { id: 'spotColors', label: 'Spot Color Objects' },
  { id: 'patterns', label: 'Pattern Objects' },
  { id: 'gradients', label: 'Gradient Objects' },
  { id: 'swatches', label: 'Swatches' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'fontDetails', label: 'Font Details' },
  { id: 'linked', label: 'Linked Images' },
  { id: 'embedded', label: 'Embedded Images' },
];

/** Nodes in scope: the whole document, or the selection and everything inside it. */
function scopeNodes(doc, ids) {
  const out = [];
  if (!ids) {
    doc.walk((n) => {
      out.push(n);
    });
    return out;
  }
  const seen = new Set();
  const visit = (id) => {
    const n = doc.get(id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    out.push(n);
    for (const c of n.children || []) visit(c);
  };
  for (const id of ids) visit(id);
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The report as sections [{ id, title, rows: [[label, value]] | items: [string] }]. */
export function documentReport(editor, { selectionOnly = false } = {}) {
  const doc = editor.doc;
  const root = doc.root;
  const units = UNITS[root.units] ? root.units : 'pt';
  const L = (v) => formatLength(v, units);
  const ids = selectionOnly ? editor.topSelection() : null;
  const nodes = scopeNodes(doc, ids);
  const st = documentStats(doc, { ids });
  const count = st.counts;
  const colors = st.colors;
  const swatchRefs = st.swatchRefs;
  const sections = [];
  sections.push({
    id: 'document',
    title: 'Document',
    rows: [
      ['Name', editor.name],
      ['Color Mode', root.colorMode === 'CMYK' ? 'CMYK Color' : 'RGB Color'],
      ['Units', UNITS[units].label],
      ['Artboards', `${root.artboards.length}: ${root.artboards.map((a) => `${L(a.w)} x ${L(a.h)}`).join(', ')}`],
      ['Raster Effects', `${root.rasterResolution || 72} ppi`],
      ...(root.info?.author ? [['Author', [].concat(root.info.author).join('; ')]] : []),
      ...(selectionOnly ? [['Scope', `Selection (${plural(editor.topSelection().length, 'object')})`]] : []),
    ],
  });
  sections.push({
    id: 'objects',
    title: 'Objects',
    rows: [
      ['Layers', count.layer],
      ['Paths', count.path],
      ['Compound Paths', count.compound],
      ['Groups', count.group],
      ['Clip Groups', count.clip],
      ['Type Objects', `${count.text} (${count.pointText} point, ${count.areaText} area, ${count.pathText} on a path)`],
      ['Images', count.image],
      ['Live Objects', count.live],
      ['With Effects', count.effects],
      ['Anchor Points', st.anchors],
      ['Colors Used', colors.size],
      ['Hidden', count.hidden],
      ['Locked', count.locked],
    ].filter(([, v]) => !selectionOnly || v !== 0),
  });
  const styles = graphicStylesOf(doc);
  const usedStyles = styles.filter((s) => nodes.some((n) => n.type !== 'layer' && n.type !== 'root' && (n.type === 'path' || n.type === 'compound' || n.type === 'text' || n.type === 'group') && matchesStyle(doc, n, s.style)));
  sections.push({ id: 'styles', title: 'Graphic Styles', items: (selectionOnly ? usedStyles : styles).map((s) => `${s.name}${!selectionOnly && usedStyles.includes(s) ? ' (in use)' : ''}`) });
  const brushes = docBrushes(doc);
  const brushUse = tally(nodes, (n) => n.brush?.id);
  const brushItems = (selectionOnly ? brushes.filter((b) => brushUse.has(b.id)) : brushes).map((b) => `${b.name}${brushUse.has(b.id) ? ` (${plural(brushUse.get(b.id), 'object')})` : ''}`);
  sections.push({ id: 'brushes', title: 'Brushes', items: brushItems });
  const swatchById = new Map(swatchesOf(doc).map((sw) => [sw.id, sw]));
  // Swatch ids a paint uses: its own, and its gradient stops'.
  const paintSwatchIds = (p) => (p ? [p.swatchId, ...((p.type === 'linear' || p.type === 'radial') && p.stops ? p.stops.map((st) => st.swatchId) : [])].filter(Boolean) : []);
  const swatchUse = (test, perObject) => tally(nodes, (n) => {
    const ids = [n.fill, n.stroke].flatMap(paintSwatchIds);
    return (perObject ? [...new Set(ids)] : ids).filter((id) => test(swatchById.get(id)));
  });
  const globalUse = swatchUse((sw) => sw?.global && !sw.spot);
  sections.push({ id: 'globalColors', title: 'Global Color Objects', items: [...globalUse].map(([id, k]) => `${swatchById.get(id).name}: ${plural(k, 'use')}`) });
  const spotUse = swatchUse((sw) => sw?.spot, true);
  sections.push({ id: 'spotColors', title: 'Spot Color Objects', items: [...spotUse].map(([id, k]) => `${swatchById.get(id).name}: ${plural(k, 'object')}`) });
  const patternNames = new Map((root.patterns || []).map((pt) => [pt.id, pt.name]));
  const patternUse = tally(nodes, (n) => [n.fill, n.stroke].filter((p) => p?.type === 'pattern').map((p) => p.id));
  sections.push({ id: 'patterns', title: 'Pattern Objects', items: [...patternUse].map(([id, k]) => `${patternNames.get(id) || 'Pattern'}: ${plural(k, 'use')}`) });
  const gradientUse = tally(nodes, (n) => [n.fill, n.stroke].filter((p) => p?.type === 'linear' || p?.type === 'radial').map((p) => `${p.type === 'linear' ? 'Linear' : 'Radial'}, ${p.stops?.length || 0} stops: ${(p.stops || []).map((st) => st.color.toUpperCase()).join(' > ')}`));
  sections.push({ id: 'gradients', title: 'Gradient Objects', items: [...gradientUse].map(([k, c]) => `${k} (${plural(c, 'use')})`) });
  const swatches = swatchesOf(doc);
  const usedSwatches = swatches.filter((s) => swatchRefs.has(s.id) || (s.paint?.type === 'solid' && colors.has(s.paint.color.toLowerCase())));
  sections.push({ id: 'swatches', title: 'Swatches', items: (selectionOnly ? usedSwatches : swatches).map((s) => `${s.name}${s.spot ? ' (spot)' : s.global ? ' (global)' : ''}${s.mode === 'cmyk' ? ' (CMYK)' : ''}`) });
  const fontDoc = { walk: (fn) => nodes.forEach((n) => fn(n)) };
  const fonts = fontsUsed(fontDoc);
  const styleName = (f) => `${f.weight === 700 ? 'Bold' : f.weight === 400 ? 'Regular' : f.weight}${f.style === 'italic' ? ' Italic' : ''}`;
  sections.push({ id: 'fonts', title: 'Fonts', items: fonts.map((f) => `${f.family} ${styleName(f)} (${plural(f.count, 'use')})`) });
  const chars = new Map();
  for (const n of nodes) {
    if (n.type !== 'text' || !n.char?.fontFamily) continue;
    const k = `${n.char.fontFamily}|${n.char.fontWeight || 400}|${n.char.fontStyle || 'normal'}`;
    chars.set(k, (chars.get(k) || 0) + (n.text || '').length);
  }
  sections.push({
    id: 'fontDetails',
    title: 'Font Details',
    items: fonts.map((f) => {
      const n = chars.get(`${f.family}|${f.weight}|${f.style}`) || 0;
      return `${f.family} ${styleName(f)}: weight ${f.weight}, ${f.style === 'italic' ? 'italic' : 'upright'}, ${plural(f.count, 'use')}${n ? `, ${plural(n, 'character')}` : ''}`;
    }),
  });
  const imgs = nodes.filter((n) => n.type === 'image').map((n) => ({ n, i: imageInfo(doc, n) }));
  const line = ({ i }) => `${i.name}: ${i.format}, ${i.pixels.w} x ${i.pixels.h} px, ${Math.round(i.ppi.x)} ppi${i.location ? `, ${i.location}` : ''}`;
  sections.push({ id: 'linked', title: 'Linked Images', items: imgs.filter((x) => x.i.linked).map(line) });
  sections.push({ id: 'embedded', title: 'Embedded Images', items: imgs.filter((x) => !x.i.linked).map(line) });
  return sections;
}

/** Counts of keys over nodes: fn(node) -> key | [keys] | null. */
function tally(nodes, fn) {
  const out = new Map();
  for (const n of nodes) {
    const v = fn(n);
    for (const k of [].concat(v ?? [])) if (k != null) out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
}

export function reportText(sections) {
  return sections
    .map((s) => [`${s.title}:`, ...(s.rows ? s.rows.map(([k, v]) => `  ${k}: ${v}`) : s.items.length ? s.items.map((x) => `  ${x}`) : ['  None'])].join('\n'))
    .join('\n\n');
}

export class DocumentInfoPanel extends Panel {
  static id = 'documentInfo';
  static title = 'Document Info';
  static icon = 'panel-document-info';
  static placement = 'strip';

  menu() {
    const ed = this.app.editor;
    return [
      { label: 'Selection Only', checked: this.selectionOnly, enabled: Boolean(ed), run: () => this.setSelectionOnly(!this.selectionOnly) },
      '-',
      ...CATEGORIES.map((c) => ({ label: c.label, checked: this.category === c.id, run: () => this.setCategory(c.id) })),
      '-',
      { label: 'Save...', enabled: Boolean(ed), run: () => this.save() },
      { label: 'Copy to Clipboard', enabled: Boolean(ed && navigator.clipboard?.writeText), run: () => navigator.clipboard.writeText(`${reportText(this.sections())}\n`) },
    ];
  }

  setCategory(id) {
    this.category = id;
    this.cat.value = id;
    this.app.prefs.set('docInfoCategory', id);
    this.key = null;
    this.update();
  }

  setSelectionOnly(on) {
    this.selectionOnly = on;
    this.selOnly.checked = on;
    this.key = null;
    this.update();
  }

  build() {
    this.category = this.app.prefs.get('docInfoCategory') || 'all';
    if (!CATEGORIES.some((c) => c.id === this.category)) this.category = 'all';
    this.selectionOnly = false;
    this.cat = h(
      'select#di-cat.select',
      { 'aria-label': 'Show', onchange: () => this.setCategory(this.cat.value) },
      CATEGORIES.map((c) => h('option', { value: c.id, selected: c.id === this.category }, c.label)),
    );
    this.selOnly = h('input#di-sel', { type: 'checkbox', onchange: () => this.setSelectionOnly(this.selOnly.checked) });
    // A scrolling report: focusable so it scrolls from the keyboard.
    this.body = h('div.di-body', { 'aria-live': 'off', role: 'region', 'aria-label': 'Document report', tabindex: '0' });
    this.empty = h('p.panel-empty', 'No document open.');
    this.head = h('div.di-head', this.cat, h('div.check-row.di-selonly', this.selOnly, h('label', { for: 'di-sel' }, 'Selection Only')), iconButton('download', 'Save Report as Text', () => this.save(), { className: 'small' }));
    this.el.append(this.empty, this.head, this.body);
  }

  sections() {
    const ed = this.app.editor;
    const all = documentReport(ed, { selectionOnly: this.selectionOnly && ed.selection.size > 0 });
    return this.category === 'all' ? all : all.filter((s) => s.id === this.category);
  }

  update() {
    const ed = this.app.editor;
    this.empty.hidden = Boolean(ed);
    this.head.hidden = this.body.hidden = !ed;
    if (!ed) return;
    const key = `${ed.doc.nodes.version}|${this.selectionOnly ? ed.selection.version : ''}|${this.category}|${ed.doc.id ?? ''}`;
    if (this.key === key && this.keyDoc === ed.doc) return;
    this.key = key;
    this.keyDoc = ed.doc;
    this.body.replaceChildren(
      ...this.sections().map((s) =>
        h(
          'section.di-sec',
          h('h3.section-title', s.title),
          s.rows ? h('dl.files-info-list', s.rows.flatMap(([k, v]) => [h('dt', k), h('dd', String(v))])) : s.items.length ? h('ul.di-items', s.items.map((x) => h('li', x))) : h('p.muted.di-none', 'None'),
        ),
      ),
    );
  }

  async save() {
    const ed = this.app.editor;
    if (!ed) return;
    const text = `${reportText(this.sections())}\n`;
    const { downloadBlob } = await import('../io/deliver.js');
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${ed.name.replace(/\.[^.]+$/, '')} Info.txt`);
  }
}
