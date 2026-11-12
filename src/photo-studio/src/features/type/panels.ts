// Character and Paragraph panels. They act on the selected range while
// editing, on the selected text layers otherwise, or set the defaults for
// new text. Mixed values show blank.

import type { Editor } from '../../editor';
import { registerPanel, type Panel } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { hexRgb, rgbHexString } from '../../model/text-layer';
import type { CharStyle, Kerning, ParagraphStyle } from '../../imaging/text/model';
import { applyChar, applyParagraph, focusInput, onSessionChange, session, styleContext } from './session';
import { familyPatch, familyStyles, openFontPicker, styleName } from './options';
import { typeUnit } from './units';

const LANGUAGES: [string, string][] = [
  ['en-US', 'English: USA'], ['en-GB', 'English: UK'], ['de-DE', 'German'], ['fr-FR', 'French'], ['es-ES', 'Spanish'], ['it-IT', 'Italian'],
  ['pt-BR', 'Portuguese: Brazil'], ['pt-PT', 'Portuguese'], ['nl-NL', 'Dutch'], ['sv-SE', 'Swedish'], ['da-DK', 'Danish'], ['nb-NO', 'Norwegian'],
  ['fi-FI', 'Finnish'], ['pl-PL', 'Polish'], ['cs-CZ', 'Czech'], ['tr-TR', 'Turkish'], ['el-GR', 'Greek'], ['ru-RU', 'Russian'], ['uk-UA', 'Ukrainian'],
  ['ja-JP', 'Japanese'], ['zh-CN', 'Chinese: Simplified'], ['zh-TW', 'Chinese: Traditional'], ['ko-KR', 'Korean'],
];
const TOGGLES: [keyof CharStyle, string, string][] = [
  ['fauxBold', 'bold', 'Faux Bold'], ['fauxItalic', 'italic', 'Faux Italic'], ['allCaps', 'all-caps', 'All Caps'], ['smallCaps', 'small-caps', 'Small Caps'],
  ['superscript', 'superscript', 'Superscript'], ['subscript', 'subscript', 'Subscript'], ['underline', 'underline', 'Underline'], ['strikethrough', 'strikethrough', 'Strikethrough'],
];
const fmt = (v: unknown) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : '');
const field = (key: string, icon: string, title: string, unit: string, attrs = '') =>
  `<label class="type-field" title="${title}">${svg(icon, 15)}<input data-char="${key}" aria-label="${title}" ${attrs}><span class="type-unit">${unit}</span></label>`;

function refocus(e: Editor) {
  if (session) setTimeout(() => focusInput(e), 0);
}

const characterPanel: Panel = {
  id: 'character',
  title: 'Character',
  icon: 'case-upper',
  location: 'strip',
  mount: (e, el) => {
    el.classList.add('type-panel');
    el.innerHTML = `<div class="type-row"><button type="button" class="type-font-button wide" data-family aria-label="Font family" aria-haspopup="dialog"><span></span>${svg('chevron-down', 12)}</button></div>
<div class="type-row"><select data-style aria-label="Font style"></select></div>
<div class="type-grid">
${field('size', 'baseline', 'Font size', 'pt', 'type="number" min="0.5" max="1296" step="0.5"')}
${field('leading', 'leading', 'Leading (Auto or points)', 'pt', 'type="text" list="type-leading-list" inputmode="decimal"')}
<label class="type-field" title="Kerning">${svg('kerning', 15)}<select data-char="kerning" aria-label="Kerning"><option value="metrics">Metrics</option><option value="optical">Optical</option><option value="none">None</option></select></label>
${field('tracking', 'tracking', 'Tracking (1/1000 em)', '', 'type="number" step="10" min="-1000" max="10000"')}
${field('scaleY', 'scale-vertical', 'Vertical scale', '%', 'type="number" min="1" max="1000" step="1"')}
${field('scaleX', 'scale-horizontal', 'Horizontal scale', '%', 'type="number" min="1" max="1000" step="1"')}
${field('baselineShift', 'baseline-shift', 'Baseline shift', 'pt', 'type="number" step="0.5"')}
<label class="type-field" title="Text color">Color <input type="color" data-color aria-label="Text color"></label>
</div>
<datalist id="type-leading-list"><option value="Auto"></option>${[6, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72].map((v) => `<option value="${v}"></option>`).join('')}</datalist>
<div class="type-toggles" role="group" aria-label="Type styles">${TOGGLES.map(([k, icon, label]) => `<button type="button" class="icon-button toggle" data-toggle="${k}" aria-pressed="false" title="${label}" aria-label="${label}">${svg(icon, 15)}</button>`).join('')}</div>
<div class="type-row"><label class="type-check"><input type="checkbox" data-check="ligatures"> Ligatures</label></div>
<div class="type-row"><label class="type-field wide" title="Language">Language <select data-char="language" aria-label="Language">${LANGUAGES.map(([v, l]) => `<option value="${v}">${escapeXML(l)}</option>`).join('')}</select></label></div>`;
    const familyButton = el.querySelector<HTMLButtonElement>('[data-family]')!;
    familyButton.addEventListener('click', () => {
      const cur = styleContext(e).char;
      openFontPicker(e, familyButton, (f) => void applyChar(e, familyPatch(f, cur)).then(() => refocus(e)), cur.family);
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement | HTMLSelectElement;
      let p: Promise<void> | undefined;
      if (t.matches('[data-style]')) {
        const [w, i] = t.value.split('|');
        if (w) p = applyChar(e, { weight: Number(w), italic: i === '1' });
      } else if (t.matches('[data-color]')) p = applyChar(e, { color: hexRgb(t.value) });
      else if (t.matches('[data-check]')) p = applyChar(e, { [(t as HTMLInputElement).dataset.check!]: (t as HTMLInputElement).checked });
      else if (t.dataset.char) {
        const key = t.dataset.char as keyof CharStyle;
        const raw = t.value.trim();
        if (key === 'kerning') p = applyChar(e, { kerning: raw as Kerning });
        else if (key === 'language') p = applyChar(e, { language: raw });
        else if (key === 'leading') {
          if (/^auto$/i.test(raw)) p = applyChar(e, { leading: 'auto' });
          else if (Number(raw) > 0) p = applyChar(e, { leading: Math.min(5000, Number(raw) / typeUnit(e).k) });
        } else if (raw !== '' && Number.isFinite(Number(raw))) {
          // Sizes are entered in the type unit and stored in points.
          const v = Number(raw) / (key === 'size' || key === 'baselineShift' ? typeUnit(e).k : 1);
          const clamp: Partial<Record<keyof CharStyle, [number, number]>> = { size: [0.5, 1296], tracking: [-1000, 10000], scaleX: [1, 1000], scaleY: [1, 1000], baselineShift: [-5000, 5000] };
          const [lo, hi] = clamp[key] ?? [-1e5, 1e5];
          p = applyChar(e, { [key]: Math.max(lo, Math.min(hi, v)) });
        }
      }
      void p?.then(() => refocus(e));
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('input')) (ev.target as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
    });
    el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-toggle]');
      if (!b) return;
      const key = b.dataset.toggle as keyof CharStyle;
      void applyChar(e, { [key]: b.getAttribute('aria-pressed') !== 'true' }).then(() => refocus(e));
    });
  },
  update: (e, el) => syncCharacter(e, el),
};

// Field limits given in points, shown in the type unit (factor k), on the
// fields' 0.5 step grid (the minimum is where the stepper counts from).
function limits(input: HTMLInputElement, lo: number, hi: number, k: number) {
  input.min = String(Math.ceil(lo * k * 2) / 2);
  input.max = String(Math.floor(hi * k * 2) / 2);
}
function setValue(el: HTMLInputElement | HTMLSelectElement | null, v: string) {
  if (el && document.activeElement !== el) el.value = v;
}
function syncCharacter(e: Editor, el: HTMLElement) {
  const c = styleContext(e).char;
  const fam = el.querySelector<HTMLElement>('[data-family]')!;
  fam.querySelector('span')!.textContent = c.family ?? '';
  fam.style.fontFamily = c.family ? `"${c.family}", sans-serif` : '';
  const st = el.querySelector<HTMLSelectElement>('[data-style]')!;
  if (document.activeElement !== st) {
    const v = c.weight !== undefined && c.italic !== undefined ? `${c.weight}|${c.italic ? 1 : 0}` : '';
    const styles = familyStyles(c.family);
    const opts = styles.map((s) => [`${s.weight}|${s.italic ? 1 : 0}`, styleName(s.weight, s.italic)]);
    if (v && !opts.some(([k]) => k === v)) opts.unshift([v, styleName(c.weight!, !!c.italic)]);
    st.innerHTML = (v ? '' : '<option value="" selected></option>') + opts.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  }
  const unit = typeUnit(e);
  for (const k of ['tracking', 'scaleX', 'scaleY'] as const) setValue(el.querySelector(`[data-char="${k}"]`), fmt(c[k]));
  for (const k of ['size', 'baselineShift'] as const) setValue(el.querySelector(`[data-char="${k}"]`), fmt(typeof c[k] === 'number' ? c[k] * unit.k : undefined));
  setValue(el.querySelector('[data-char="leading"]'), c.leading === 'auto' ? 'Auto' : fmt(typeof c.leading === 'number' ? c.leading * unit.k : undefined));
  for (const k of ['size', 'leading', 'baselineShift']) {
    const span = el.querySelector(`[data-char="${k}"] + .type-unit`);
    if (span) span.textContent = unit.suffix;
  }
  // The limits are in points; the field shows the type unit.
  limits(el.querySelector<HTMLInputElement>('[data-char="size"]')!, 0.5, 1296, unit.k);
  setValue(el.querySelector('[data-char="kerning"]'), c.kerning ?? '');
  setValue(el.querySelector('[data-char="language"]'), c.language ?? '');
  const color = el.querySelector<HTMLInputElement>('[data-color]')!;
  setValue(color, c.color ? rgbHexString(c.color) : '#000000');
  color.classList.toggle('mixed', !c.color);
  for (const b of el.querySelectorAll<HTMLElement>('[data-toggle]')) {
    const v = c[b.dataset.toggle as keyof CharStyle];
    b.setAttribute('aria-pressed', String(v === true));
    b.classList.toggle('mixed', v === undefined);
  }
  const lig = el.querySelector<HTMLInputElement>('[data-check="ligatures"]')!;
  lig.checked = c.ligatures === true;
  lig.indeterminate = c.ligatures === undefined;
}

const ALIGNS: [ParagraphStyle['align'], string, string][] = [
  ['left', 'align-left', 'Left align text'], ['center', 'align-center', 'Center text'], ['right', 'align-right', 'Right align text'],
  ['justify-left', 'justify-left', 'Justify last left'], ['justify-center', 'justify-center', 'Justify last centered'], ['justify-right', 'justify-right', 'Justify last right'], ['justify-all', 'justify-all', 'Justify all'],
];
const paragraphPanel: Panel = {
  id: 'paragraph',
  title: 'Paragraph',
  icon: 'align-justify',
  location: 'strip',
  mount: (e, el) => {
    el.classList.add('type-panel');
    const pfield = (key: keyof ParagraphStyle, icon: string, title: string) =>
      `<label class="type-field" title="${title}">${svg(icon, 15)}<input type="number" step="0.5" min="-5000" max="5000" data-para="${key}" aria-label="${title}"><span class="type-unit">pt</span></label>`;
    el.innerHTML = `<div class="type-toggles" role="group" aria-label="Alignment">${ALIGNS.map(([a, icon, label]) => `<button type="button" class="icon-button toggle" data-align="${a}" aria-pressed="false" title="${label}" aria-label="${label}">${svg(icon, 15)}</button>`).join('')}</div>
<div class="type-grid">
${pfield('indentLeft', 'indent-left', 'Indent left margin')}
${pfield('indentRight', 'indent-right', 'Indent right margin')}
${pfield('indentFirst', 'indent-first', 'Indent first line')}
<span></span>
${pfield('spaceBefore', 'space-before', 'Add space before paragraph')}
${pfield('spaceAfter', 'space-after', 'Add space after paragraph')}
</div>
<div class="type-row"><label class="type-check"><input type="checkbox" data-hyphenate> Hyphenate</label></div>
<p class="hint">Justification and hyphenation apply to paragraph text (drag with a type tool to create a text frame).</p>`;
    el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-align]');
      if (b) void applyParagraph(e, { align: b.dataset.align as ParagraphStyle['align'] }).then(() => refocus(e));
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      let p: Promise<void> | undefined;
      if (t.matches('[data-hyphenate]')) p = applyParagraph(e, { hyphenate: t.checked });
      else if (t.dataset.para && t.value.trim() !== '' && Number.isFinite(Number(t.value)))
        // Entered in the type unit, stored in points.
        p = applyParagraph(e, { [t.dataset.para]: Math.max(-5000, Math.min(5000, Number(t.value) / typeUnit(e).k)) });
      void p?.then(() => refocus(e));
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('input')) (ev.target as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
    });
  },
  update: (e, el) => {
    const p = styleContext(e).paragraph;
    for (const b of el.querySelectorAll<HTMLElement>('[data-align]')) b.setAttribute('aria-pressed', String(p.align === b.dataset.align));
    const unit = typeUnit(e);
    for (const k of ['indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'spaceAfter'] as const) {
      const input = el.querySelector<HTMLInputElement>(`[data-para="${k}"]`)!;
      setValue(input, fmt(typeof p[k] === 'number' ? p[k] * unit.k : undefined));
      limits(input, -5000, 5000, unit.k);
      input.nextElementSibling!.textContent = unit.suffix;
    }
    const h = el.querySelector<HTMLInputElement>('[data-hyphenate]')!;
    h.checked = p.hyphenate === true;
    h.indeterminate = p.hyphenate === undefined;
  },
};

export function installTypePanels(e: Editor) {
  registerPanel(characterPanel, paragraphPanel);
  onSessionChange(() => {
    for (const p of [characterPanel, paragraphPanel]) {
      const el = document.getElementById(`panel-${p.id}`);
      if (el?.isConnected) p.update!(e, el);
    }
  });
}
