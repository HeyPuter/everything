// Properties for text layers: the layer's transform, then Character,
// Paragraph and Type Options sections that act like the Character and
// Paragraph panels (on the selected range while editing, else on the whole
// layer), and quick actions for the layer.

import type { Editor } from '../../editor';
import { findLayer, type Layer } from '../../model/document';
import { properties } from '../../ui/panels';
import { layerLocked } from '../../model/transform';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { hexRgb, rgbHexString } from '../../model/text-layer';
import type { AntiAlias, CharStyle, Kerning, ParagraphStyle } from '../../imaging/text/model';
import { propertiesEditors } from '../panels/properties';
import {
  applyChar,
  applyParagraph,
  onSessionChange,
  restoreInputFocus,
  session,
  styleContext,
} from './session';
import { familyPatch, familyStyles, openFontPicker, setAntiAlias, styleName } from './options';
import { typeUnit } from './units';

const fmt = (v: unknown) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : '');
const TOGGLES: [keyof CharStyle, string, string][] = [
  ['fauxBold', 'bold', 'Faux Bold'],
  ['fauxItalic', 'italic', 'Faux Italic'],
  ['allCaps', 'all-caps', 'All Caps'],
  ['smallCaps', 'small-caps', 'Small Caps'],
  ['superscript', 'superscript', 'Superscript'],
  ['subscript', 'subscript', 'Subscript'],
  ['underline', 'underline', 'Underline'],
  ['strikethrough', 'strikethrough', 'Strikethrough'],
];
const ALIGNS: [ParagraphStyle['align'], string, string][] = [
  ['left', 'align-left', 'Left align text'],
  ['center', 'align-center', 'Center text'],
  ['right', 'align-right', 'Right align text'],
  ['justify-left', 'justify-left', 'Justify last left'],
  ['justify-center', 'justify-center', 'Justify last centered'],
  ['justify-right', 'justify-right', 'Justify last right'],
  ['justify-all', 'justify-all', 'Justify all'],
];
const AA: [AntiAlias, string][] = [
  ['none', 'None'],
  ['sharp', 'Sharp'],
  ['crisp', 'Crisp'],
  ['strong', 'Strong'],
  ['smooth', 'Smooth'],
];

let mounted: { el: HTMLElement; layer: Layer } | undefined;

const num = (key: string, icon: string, label: string, value: string, unit: string, attrs = '') =>
  `<label class="tp-field" title="${label}">${svg(icon, 15)}<input data-tchar="${key}" aria-label="${label}" value="${value}" ${attrs}><span class="muted">${unit}</span></label>`;
const toggle = (
  attr: string,
  value: string,
  icon: string,
  label: string,
  pressed: boolean,
  mixed = false,
) =>
  `<button type="button" class="icon-button toggle${mixed ? ' mixed' : ''}" ${attr}="${value}" aria-pressed="${pressed}" title="${label}" aria-label="${label}">${svg(icon, 15)}</button>`;

function sections(e: Editor, l: Layer): string {
  const c = styleContext(e);
  const ch = c.char;
  const p = c.paragraph;
  const unit = typeUnit(e);
  const styleValue =
    ch.weight !== undefined && ch.italic !== undefined ? `${ch.weight}|${ch.italic ? 1 : 0}` : '';
  const styles = familyStyles(ch.family).map((s) => [
    `${s.weight}|${s.italic ? 1 : 0}`,
    styleName(s.weight, s.italic),
  ]);
  if (styleValue && !styles.some(([k]) => k === styleValue))
    styles.unshift([styleValue, styleName(ch.weight!, !!ch.italic)]);
  const aa = c.data?.antiAlias;
  const vertical = (session ? session.data.orientation : l.textData?.orientation) === 'vertical';
  const dir = p.direction ?? (Object.keys(p).length ? 'ltr' : undefined);
  const kerning: [Kerning, string][] = [
    ['metrics', 'Metrics'],
    ['optical', 'Optical'],
    ['none', 'None'],
  ];
  const scope = c.editing ? 'Applies to the selected text' : 'Applies to the whole layer';
  return `<section class="type-props" aria-label="Character">
<h3>Character <button type="button" class="icon-button" data-command="window.panel.character" title="Open the Character panel" aria-label="Open the Character panel">${svg('ellipsis', 14)}</button></h3>
<p class="muted vec-hint">${scope}</p>
<button type="button" class="type-font-button wide" data-tfamily aria-label="Font family" aria-haspopup="dialog" style="font-family:${ch.family ? escapeXML(`"${ch.family}", sans-serif`) : 'inherit'}"><span>${escapeXML(ch.family ?? '')}</span>${svg('chevron-down', 12)}</button>
<select data-tstyle aria-label="Font style">${styleValue ? '' : '<option value="" selected></option>'}${styles.map(([k, n]) => `<option value="${k}" ${k === styleValue ? 'selected' : ''}>${n}</option>`).join('')}</select>
<div class="tp-grid">
${num('size', 'baseline', 'Font size', fmt(typeof ch.size === 'number' ? ch.size * unit.k : undefined), unit.suffix, 'type="number" min="0.5" step="0.5"')}
${num('leading', 'leading', 'Leading', ch.leading === 'auto' ? 'Auto' : fmt(typeof ch.leading === 'number' ? ch.leading * unit.k : undefined), unit.suffix, 'type="text" inputmode="decimal" placeholder="Auto"')}
${num('tracking', 'tracking', 'Tracking', fmt(ch.tracking), '', 'type="number" step="10" min="-1000" max="10000"')}
<label class="tp-field" title="Kerning">${svg('kerning', 15)}<select data-tchar="kerning" aria-label="Kerning">${ch.kerning ? '' : '<option value="" selected></option>'}${kerning.map(([v, n]) => `<option value="${v}" ${ch.kerning === v ? 'selected' : ''}>${n}</option>`).join('')}</select><span class="muted"></span></label>
<label class="tp-field" title="Text color">Color <input type="color" data-tcolor aria-label="Text color" class="${ch.color ? '' : 'mixed'}" value="${ch.color ? rgbHexString(ch.color) : '#000000'}"></label>
</div>
<div class="type-toggles" role="group" aria-label="Type styles">${TOGGLES.map(([k, icon, label]) => toggle('data-ttoggle', k, icon, label, ch[k] === true, ch[k] === undefined)).join('')}</div>
</section>
<section class="type-props" aria-label="Paragraph">
<h3>Paragraph <button type="button" class="icon-button" data-command="window.panel.paragraph" title="Open the Paragraph panel" aria-label="Open the Paragraph panel">${svg('ellipsis', 14)}</button></h3>
<div class="type-toggles" role="group" aria-label="Alignment">${ALIGNS.map(([a, icon, label]) => toggle('data-talign', a, icon, label, p.align === a)).join('')}</div>
<div class="type-toggles" role="group" aria-label="Text direction">${toggle('data-tdir', 'ltr', 'text-ltr', 'Left-to-right text', dir === 'ltr')}${toggle('data-tdir', 'rtl', 'text-rtl', 'Right-to-left text', dir === 'rtl')}</div>
</section>
<section class="type-props" aria-label="Type options">
<h3>Type Options</h3>
<div class="tp-row"><div class="type-toggles" role="group" aria-label="Orientation">${toggle('data-command', 'type.horizontal', 'type', 'Horizontal text', !vertical)}${toggle('data-command', 'type.vertical', 'type-vertical', 'Vertical text', vertical)}</div>
<label class="tp-field" title="Anti-aliasing method">aa <select data-taa aria-label="Anti-aliasing method">${aa ? '' : '<option value="" selected></option>'}${AA.map(([v, n]) => `<option value="${v}" ${aa === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
</section>
<section class="type-props type-quick" aria-label="Quick actions">
<h3>Quick Actions</h3>
<div class="tp-actions">
<button data-command="type.edit">${svg('type', 14)} Edit text</button>
<button data-command="type.warp">${svg('waves', 14)} Warp text</button>
<button data-command="type.convert-to-shape">${svg('shapes', 14)} Convert to shape</button>
<button data-command="type.create-work-path">${svg('spline', 14)} Work path</button>
<button data-command="type.rasterize">${svg('image', 14)} Rasterize</button>
</div>
</section>`;
}

function render(e: Editor, el: HTMLElement, l: Layer) {
  const locked = layerLocked(e.doc.layers, l.id);
  const generic = properties(e.displayDoc, l, 1, locked)
    // The text buttons are replaced by the sections and quick actions below.
    .replace(
      /<button data-command="type\.edit"[\s\S]*?<button data-command="type\.warp"[^>]*>[\s\S]*?<\/button>/,
      '',
    );
  const at = generic.indexOf('<h3>Adjustments');
  const ours = `<fieldset class="type-props-fields" ${locked ? 'disabled' : ''}>${sections(e, l)}</fieldset>`;
  el.innerHTML = at >= 0 ? generic.slice(0, at) + ours + generic.slice(at) : generic + ours;
  bind(e, el);
}

function bind(e: Editor, el: HTMLElement) {
  const root = el.querySelector<HTMLElement>('.type-props-fields');
  if (!root) return;
  const done = (p: Promise<void> | undefined) => void p?.then(restoreInputFocus(e));
  const family = root.querySelector<HTMLButtonElement>('[data-tfamily]')!;
  family.addEventListener('click', () => {
    const cur = styleContext(e).char;
    openFontPicker(e, family, (f) => done(applyChar(e, familyPatch(f, cur))), cur.family);
  });
  root.addEventListener('change', (ev) => {
    ev.stopPropagation();
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    const raw = t.value.trim();
    delete t.dataset.dirty;
    if (t.matches('[data-tstyle]')) {
      const [w, i] = raw.split('|');
      if (w) done(applyChar(e, { weight: Number(w), italic: i === '1' }));
    } else if (t.matches('[data-tcolor]')) done(applyChar(e, { color: hexRgb(raw) }));
    else if (t.matches('[data-taa]')) {
      if (raw) done(setAntiAlias(e, raw as AntiAlias));
    } else if (t.dataset.tchar) {
      const key = t.dataset.tchar;
      const k = typeUnit(e).k;
      if (key === 'kerning') {
        if (raw) done(applyChar(e, { kerning: raw as Kerning }));
      } else if (key === 'leading') {
        if (/^auto$/i.test(raw) || raw === '') done(applyChar(e, { leading: 'auto' }));
        else if (Number(raw) > 0) done(applyChar(e, { leading: Math.min(5000, Number(raw) / k) }));
      } else if (raw !== '' && Number.isFinite(Number(raw))) {
        const v = Number(raw);
        if (key === 'size') done(applyChar(e, { size: Math.max(0.5, Math.min(1296, v / k)) }));
        else if (key === 'tracking')
          done(applyChar(e, { tracking: Math.max(-1000, Math.min(10000, Math.round(v))) }));
      }
    }
  });
  // Typed but not yet applied: refreshes leave the field alone.
  root.addEventListener('input', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches('input[data-tchar]')) t.dataset.dirty = '1';
  });
  root.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    if (ev.key === 'Enter' && t.matches('input[data-tchar]')) {
      ev.preventDefault();
      t.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  root.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>(
      '[data-ttoggle],[data-talign],[data-tdir]',
    );
    if (!b) return;
    if (b.dataset.ttoggle) {
      const key = b.dataset.ttoggle as keyof CharStyle;
      done(applyChar(e, { [key]: b.getAttribute('aria-pressed') !== 'true' }));
    } else if (b.dataset.talign)
      done(applyParagraph(e, { align: b.dataset.talign as ParagraphStyle['align'] }));
    else if (b.dataset.tdir) {
      const dir = b.dataset.tdir as 'ltr' | 'rtl';
      const align = styleContext(e).paragraph.align;
      // A start-aligned paragraph keeps starting on the reading side.
      const flip =
        dir === 'rtl' && align === 'left'
          ? 'right'
          : dir === 'ltr' && align === 'right'
            ? 'left'
            : undefined;
      done(applyParagraph(e, { direction: dir, ...(flip ? { align: flip } : {}) }));
    }
  });
}

function refresh(e: Editor) {
  const m = mounted;
  if (!m || !m.el.isConnected) return;
  const l = findLayer(e.displayDoc.layers, m.layer.id);
  if (!l || l.kind !== 'text' || e.selected !== l.id || e.selectedIds.size !== 1) return;
  // Keep an open drop-down or a field being typed in.
  const focused = m.el.contains(document.activeElement)
    ? (document.activeElement as HTMLElement)
    : null;
  if (focused?.matches('select') || focused?.dataset.dirty) return;
  const key = focused
    ? (focused.getAttribute('aria-label') ?? focused.getAttribute('data-property'))
    : null;
  mounted = { el: m.el, layer: l };
  render(e, m.el, l);
  if (key)
    [...m.el.querySelectorAll<HTMLElement>('input,select,button')]
      .find((x) => (x.getAttribute('aria-label') ?? x.getAttribute('data-property')) === key)
      ?.focus({ preventScroll: true });
}

export function installTypeProperties(e: Editor) {
  propertiesEditors.set('text', {
    mount: (e, el, l) => {
      mounted = { el, layer: l };
      render(e, el, l);
    },
  });
  let last: Layer | undefined;
  e.onUpdate((e) => {
    const l = mounted && findLayer(e.displayDoc.layers, mounted.layer.id);
    if (l === last) return;
    last = l;
    if (l !== mounted?.layer) refresh(e);
  });
  // The selected range changes the values shown while editing.
  onSessionChange(() => refresh(e));
}
