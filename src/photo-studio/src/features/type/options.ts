// Options bar for the type tools and the shared font picker.

import type { Editor } from '../../editor';
import type { ToolOptionsContext } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { rgbHexString, hexRgb } from '../../model/text-layer';
import { BUNDLED_FONTS, ensureFont, fontFamilies, localizedFamilies, type FontFamilyInfo } from '../../imaging/text/fonts';
import type { AntiAlias, CharStyle, TextLayerData } from '../../imaging/text/model';
import { applyChar, applyLayer, applyParagraph, editLayers, focusInput, onSessionChange, restoreInputFocus, selectedTextLayers, session, styleContext, typeDefaults } from './session';
import { fontPreviewSize } from './language';
import { typeUnit } from './units';
import { whenIdle } from '../../app/lazy';
import { StyleRequests } from './style-requests';

// ------------------------------------------------------------ fonts

let families: FontFamilyInfo[] = [];
let localGranted = false;
export function familyList(): FontFamilyInfo[] {
  if (families.length) return families;
  return BUNDLED_FONTS.map((f) => ({ family: f.family, source: 'bundled' as const, category: f.category, weights: [400, 700], italic: f.faces.some((x) => x.italic) }));
}
export async function refreshFamilies(local = localGranted, pause?: () => Promise<void>) {
  localGranted = local;
  families = await fontFamilies({ local, pause });
  return families;
}
export function familyInfo(family?: string): FontFamilyInfo | undefined {
  if (!family) return;
  return familyList().find((f) => f.family.toLowerCase() === family.toLowerCase());
}
export const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };
export function styleName(weight: number, italic: boolean) {
  const w = WEIGHT_NAMES[Math.round(weight / 100) * 100] ?? String(weight);
  return italic ? (w === 'Regular' ? 'Italic' : `${w} Italic`) : w;
}
// Weight/italic combinations offered for a family (synthetic styles cover the rest).
export function familyStyles(family?: string): { weight: number; italic: boolean }[] {
  const info = familyInfo(family);
  const weights = info?.weights?.length ? info.weights : [400, 700];
  const out: { weight: number; italic: boolean }[] = [];
  for (const italic of [false, true]) for (const weight of weights) out.push({ weight, italic });
  return out;
}
const fontCss = (family: string) => `"${family.replace(/"/g, '')}", sans-serif`;

let picker: HTMLElement | undefined;
// The open picker's outside-click listener, removed however the picker closes
// (a stale one would close the next picker on its first click).
let outsideListener: ((ev: PointerEvent) => void) | undefined;
function closePicker() {
  picker?.remove();
  picker = undefined;
  if (outsideListener) document.removeEventListener('pointerdown', outsideListener, true);
  outsideListener = undefined;
}
export function openFontPicker(e: Editor, anchor: HTMLElement, onPick: (family: string) => void, current?: string) {
  if (picker) return closePicker();
  for (const f of BUNDLED_FONTS) void ensureFont(f.family, 400, false);
  // Type > Font Preview Size: names in their own font at that size, or plain.
  const preview = fontPreviewSize();
  const pop = document.createElement('div');
  pop.className = 'popover type-font-picker';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Fonts');
  const groups: [string, FontFamilyInfo[]][] = [
    ['Included', familyList().filter((f) => f.source === 'bundled')],
    ['Local', familyList().filter((f) => f.source === 'local')],
    ['System', familyList().filter((f) => f.source === 'system')],
  ];
  // Preferences → Type → Show font names in English off: local fonts show
  // their localized names once read.
  const native = !e.preferences.fontNamesEnglish && groups[1][1].length > 0;
  if (native)
    void localizedFamilies(navigator.language).then((names) => {
      for (const b of pop.querySelectorAll<HTMLElement>('[data-family]')) {
        const n = names.get(b.dataset.family!);
        if (n) {
          b.textContent = n;
          b.title = b.dataset.family!;
          b.dataset.label = n;
        }
      }
    });
  pop.innerHTML = `<input type="search" class="type-font-search" placeholder="Search fonts" aria-label="Search fonts"><div class="type-font-list" role="listbox">${groups
    .filter(([, list]) => list.length)
    .map(([title, list]) => `<div class="type-font-group">${title}</div>${list.map((f) => `<button type="button" role="option" data-family="${escapeXML(f.family)}" aria-selected="${f.family === current}" ${preview ? `style="font-family:${escapeXML(fontCss(f.family))};font-size:${preview}px"` : ''}>${escapeXML(f.family)}</button>`).join('')}`)
    .join('')}</div>`;
  document.body.append(pop);
  picker = pop;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(innerWidth - 270, r.left))}px`;
  pop.style.top = `${r.bottom + 4}px`;
  const search = pop.querySelector<HTMLInputElement>('input')!;
  search.focus();
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const b of pop.querySelectorAll<HTMLElement>('[data-family]')) b.hidden = !!q && !b.dataset.family!.toLowerCase().includes(q) && !(b.dataset.label ?? '').toLowerCase().includes(q);
  });
  const shown = () => [...pop.querySelectorAll<HTMLElement>('[data-family]')].filter((b) => !b.hidden);
  // Keys stay in the picker (no tool shortcuts, no committing the text):
  // arrows move through the list, Enter picks, Escape closes.
  pop.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    const list = shown();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closePicker();
      if (session) focusInput(e);
      else anchor.focus();
    } else if (ev.key === 'Enter' && ev.target === search) {
      ev.preventDefault();
      list[0]?.click();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const next = ev.key === 'ArrowDown' ? Math.min(list.length - 1, at + 1) : at - 1;
      if (next < 0) search.focus();
      else list[next]?.focus();
    }
  });
  pop.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-family]');
    if (!b) return;
    closePicker();
    onPick(b.dataset.family!);
  });
  pop.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
  outsideListener = (ev: PointerEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) closePicker();
  };
  document.addEventListener('pointerdown', outsideListener, true);
}

// Picks a family keeping the closest available weight and italic.
export function familyPatch(family: string, cur: Partial<CharStyle>): Partial<CharStyle> {
  const styles = familyStyles(family);
  const want = cur.weight ?? 400;
  const italic = !!cur.italic && styles.some((s) => s.italic);
  const weight = styles.filter((s) => s.italic === italic).reduce((best, s) => (Math.abs(s.weight - want) < Math.abs(best - want) ? s.weight : best), styles[0]?.weight ?? 400);
  return { family, weight, italic };
}

// ------------------------------------------------------------ options bar

const SIZES = [6, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72];
const AA: [AntiAlias, string][] = [['none', 'None'], ['sharp', 'Sharp'], ['crisp', 'Crisp'], ['strong', 'Strong'], ['smooth', 'Smooth']];
const fmt = (v: number | undefined) => (v === undefined ? '' : String(Math.round(v * 100) / 100));

function layerAntiAlias(e: Editor): AntiAlias | undefined {
  const c = styleContext(e);
  if (c.editing) return c.data?.antiAlias;
  if (c.layers.length) return c.data?.antiAlias;
  return typeDefaults(e).antiAlias;
}

export function typeOptions(e: Editor): string {
  const c = styleContext(e);
  const ch = c.char;
  const align = c.paragraph.align;
  const styles = familyStyles(ch.family);
  const styleValue = ch.weight !== undefined && ch.italic !== undefined ? `${ch.weight}|${ch.italic ? 1 : 0}` : '';
  const aa = layerAntiAlias(e);
  const editing = !!session;
  const unit = typeUnit(e);
  const color = ch.color ? rgbHexString(ch.color) : '#000000';
  return `<button type="button" class="icon-button" data-command="type.toggle-orientation" title="Toggle text orientation" aria-label="Toggle text orientation">${svg('type-vertical', 16)}</button>
<button type="button" id="type-family" class="type-font-button" title="Font family" aria-label="Font family" aria-haspopup="dialog" style="font-family:${escapeXML(fontCss(ch.family ?? 'Inter'))}"><span>${escapeXML(ch.family ?? '')}</span>${svg('chevron-down', 12)}</button>
<select id="type-style" aria-label="Font style" title="Font style">${styleValue ? '' : '<option value="" selected></option>'}${styles.map((s) => `<option value="${s.weight}|${s.italic ? 1 : 0}" ${styleValue === `${s.weight}|${s.italic ? 1 : 0}` ? 'selected' : ''}>${styleName(s.weight, s.italic)}</option>`).join('')}</select>
<label title="Font size">${svg('baseline', 14)}<input id="type-size" type="number" min="0.01" max="${Math.round(1296 * unit.k)}" step="0.5" list="type-size-list" value="${fmt(ch.size === undefined ? undefined : ch.size * unit.k)}" aria-label="Font size in ${unit.name}"> ${unit.suffix}</label><datalist id="type-size-list">${SIZES.map((s) => `<option value="${s}"></option>`).join('')}</datalist>
<label title="Anti-aliasing method">aa<select id="type-aa" aria-label="Anti-aliasing method">${aa ? '' : '<option value="" selected></option>'}${AA.map(([v, l]) => `<option value="${v}" ${aa === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
<span class="segmented" role="group" aria-label="Alignment">${(['left', 'center', 'right'] as const).map((a) => `<button type="button" class="type-align" data-align="${a}" aria-pressed="${align === a}" title="Align ${a}" aria-label="Align ${a}">${svg(`align-${a}`, 15)}</button>`).join('')}</span>
<input id="type-color" type="color" value="${color}" class="type-color ${ch.color ? '' : 'mixed'}" title="Text color" aria-label="Text color">
${c.data?.path ? `<button type="button" class="icon-button" data-command="type.path-options" title="${c.data.path.kind === 'area' ? 'Area type options' : 'Path type options'}" aria-label="${c.data.path.kind === 'area' ? 'Area type options' : 'Path type options'}">${svg('spline', 16)}</button>` : `<button type="button" class="icon-button" data-command="type.warp" title="Create warped text" aria-label="Create warped text">${svg('waves', 16)}</button>`}
<button type="button" class="icon-button" data-command="type.toggle-panels" title="Toggle the Character and Paragraph panels" aria-label="Toggle the Character and Paragraph panels">${svg('case-upper', 16)}</button>
${editing ? `<span class="type-edit-actions"><span class="divider"></span><button type="button" data-command="type.cancel" class="icon-button" title="Cancel editing (discard changes)" aria-label="Cancel editing">${svg('ban', 16)}</button><button type="button" data-command="type.commit" class="icon-button transform-apply" title="Commit text (Escape or ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Enter)" aria-label="Commit text">${svg('check', 16)}</button></span>` : ''}`;
}

export function bindTypeOptions({ e, el }: ToolOptionsContext) {
  const family = el.querySelector<HTMLButtonElement>('#type-family');
  family?.addEventListener('click', () => {
    const cur = styleContext(e).char;
    openFontPicker(e, family, (f) => void applyChar(e, familyPatch(f, cur)).then(restoreInputFocus(e)), cur.family);
  });
  el.querySelector<HTMLSelectElement>('#type-style')?.addEventListener('change', (ev) => {
    const [w, i] = (ev.target as HTMLSelectElement).value.split('|');
    if (w) void applyChar(e, { weight: Number(w), italic: i === '1' }).then(restoreInputFocus(e));
  });
  const size = el.querySelector<HTMLInputElement>('#type-size');
  size?.addEventListener('change', () => {
    const v = Number(size.value) / typeUnit(e).k;
    if (Number.isFinite(v) && v > 0) void applyChar(e, { size: Math.min(1296, Math.max(0.5, v)) }).then(restoreInputFocus(e));
  });
  size?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      size.dispatchEvent(new Event('change'));
      restoreInputFocus(e)();
    }
  });
  el.querySelector<HTMLSelectElement>('#type-aa')?.addEventListener('change', (ev) => {
    const v = (ev.target as HTMLSelectElement).value as AntiAlias;
    if (v) void setAntiAlias(e, v).then(restoreInputFocus(e));
  });
  for (const b of el.querySelectorAll<HTMLButtonElement>('.type-align'))
    b.addEventListener('click', () => void applyParagraph(e, { align: b.dataset.align as 'left' }).then(restoreInputFocus(e)));
  const color = el.querySelector<HTMLInputElement>('#type-color');
  // Applied when the picker closes, as one change.
  color?.addEventListener('change', () => void applyChar(e, { color: hexRgb(color.value) }).then(restoreInputFocus(e)));
}

const antiAliasRequests = new StyleRequests<Pick<TextLayerData, 'antiAlias'>>();

export async function setAntiAlias(e: Editor, aa: AntiAlias) {
  if (session) {
    antiAliasRequests.cancel(e.session, session.layerId, ['antiAlias']);
    await applyLayer(e, 'Change Anti-Aliasing', (d) => ({ ...d, antiAlias: aa }));
    return;
  }
  const layers = selectedTextLayers(e);
  if (!layers.length) {
    typeDefaults(e).antiAlias = aa;
    syncTypeOptions(e);
    return;
  }
  const request = antiAliasRequests.begin(e.session, layers.map((l) => l.id), { antiAlias: aa });
  try {
    await editLayers(e, 'Change Anti-Aliasing', (d, l) => ({ ...d, ...request.patch(l.id) }), undefined, undefined,
      { rebase: true, isCurrent: request.isCurrent, revision: request.revision });
  } finally {
    request.finish();
  }
}

// Refreshes control values in place (rebuilding would close open popups).
export function syncTypeOptions(e: Editor) {
  const el = e.root.querySelector<HTMLElement>('#tool-options');
  if (!el || !el.querySelector('#type-family')) return;
  const hasButtons = !!el.querySelector('[data-command="type.commit"]');
  if (hasButtons !== !!session) {
    e.options();
    return;
  }
  const c = styleContext(e);
  const ch = c.char;
  const fam = el.querySelector<HTMLElement>('#type-family');
  if (fam) {
    fam.querySelector('span')!.textContent = ch.family ?? '';
    fam.style.fontFamily = fontCss(ch.family ?? 'Inter');
  }
  const st = el.querySelector<HTMLSelectElement>('#type-style');
  if (st && document.activeElement !== st) {
    const styles = familyStyles(ch.family);
    const v = ch.weight !== undefined && ch.italic !== undefined ? `${ch.weight}|${ch.italic ? 1 : 0}` : '';
    st.innerHTML = `${v ? '' : '<option value="" selected></option>'}${styles.map((s) => `<option value="${s.weight}|${s.italic ? 1 : 0}" ${v === `${s.weight}|${s.italic ? 1 : 0}` ? 'selected' : ''}>${styleName(s.weight, s.italic)}</option>`).join('')}`;
    if (v && !styles.some((s) => `${s.weight}|${s.italic ? 1 : 0}` === v)) st.insertAdjacentHTML('afterbegin', `<option value="${v}" selected>${styleName(ch.weight!, !!ch.italic)}</option>`);
  }
  const size = el.querySelector<HTMLInputElement>('#type-size');
  if (size && document.activeElement !== size) size.value = fmt(ch.size === undefined ? undefined : ch.size * typeUnit(e).k);
  const aa = el.querySelector<HTMLSelectElement>('#type-aa');
  if (aa && document.activeElement !== aa) aa.value = layerAntiAlias(e) ?? '';
  for (const b of el.querySelectorAll<HTMLElement>('.type-align')) b.setAttribute('aria-pressed', String(c.paragraph.align === b.dataset.align));
  const color = el.querySelector<HTMLInputElement>('#type-color');
  if (color && document.activeElement !== color) {
    color.value = ch.color ? rgbHexString(ch.color) : '#000000';
    color.classList.toggle('mixed', !ch.color);
  }
}

export function installTypeOptions(e: Editor) {
  onSessionChange(() => syncTypeOptions(e));
  // Detecting installed fonts measures text in every candidate family; it
  // runs when the workspace is idle rather than during startup.
  whenIdle(() => void refreshFamilies(false, () => new Promise<void>((r) => whenIdle(r))).then(() => syncTypeOptions(e)));
}
