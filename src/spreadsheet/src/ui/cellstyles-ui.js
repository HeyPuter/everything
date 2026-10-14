/**
 * Cell styles, managed: the gallery (built-in presets, the workbook's own styles and the themed ones, with
 * New Cell Style… and Merge Styles… under them), each style's Modify…, Duplicate… and Delete (right-click a
 * sample, or the menu key on it), the Style dialog that names a style and chooses which parts of a format it
 * carries, and Merge Styles, which copies the styles of another spreadsheet into this one.
 */

import { el, fieldId } from './dom.js';
import { openMenu } from './menu.js';
import { openModal, fieldAlert, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { openFormatCellsDialog } from './formatcells.js';
import { themedCellStyleItems } from './themes.js';
import { CELL_STYLES, cellStyle } from '../core/cellstyles.js';
import { fontColorCss } from '../core/font-color.js';
import { fillColorCss } from '../core/fill-color.js';
import { borderCss } from '../core/format.js';
import {
  STYLE_PARTS, PART_KEYS, normalizeCustomStyle, styleNameProblem, styleFromCell, styleFromPreset, styleAsCell, foldFormat,
  partSummary, builtinOverride, customStyleNamed, restyleCells, unlinkCells, mergeStyleLists, clashingStyleNames, edgesOfStyle,
} from '../core/custom-cell-styles.js';

/** The sample's look for a definition: its ink, fill, weight, slant, size and lower edge. */
function sampleCss(def) {
  const s = styleAsCell(def);
  const bottom = def.borders.find((b) => b.side === 'bottom');
  const edge = bottom ? borderCss({ bs: bottom.style, bc: bottom.color }) : null;
  return {
    color: fontColorCss(s.color) || 'var(--ink)', background: fillColorCss(s.bg) || 'var(--surface)',
    fontWeight: s.bold ? '700' : '400', fontStyle: s.italic ? 'italic' : 'normal', textDecorationLine: [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ') || 'none',
    fontSize: s.size ? `${Math.min(s.size, 16)}px` : '13px', border: '1px solid var(--hairline)',
    borderBottom: edge ? `2px ${edge.style} ${edge.color || 'var(--ink)'}` : '1px solid var(--hairline)',
  };
}

/** A built-in preset's sample, as the gallery always drew it. */
const presetCss = (s) => ({
  color: s.patch.color || 'var(--ink)', background: s.patch.bg || 'var(--surface)', border: '1px solid var(--hairline)', fontWeight: s.patch.bold ? '700' : '400',
  fontSize: s.patch.size ? `${Math.min(s.patch.size, 16)}px` : '13px',
  borderBottom: (s.borders || []).some((b) => b.kind === 'bottom') ? `2px solid ${s.borders.find((b) => b.kind === 'bottom').color}` : 'none',
});

/** Who a style is, for the actions on it: a built-in by key, or a custom one by name. */
const builtinRef = (key) => ({ builtin: key });
const customRef = (name) => ({ custom: name });

/**
 * Home ▸ Cell Styles: the gallery. `arg` is the button it opens from, or a point. Picking a sample applies its
 * style; right-clicking one (or pressing the menu key on it) offers Modify…, Duplicate… and Delete.
 */
export function openCellStylesGallery(ctx, arg) {
  const { wb, run } = ctx;
  const anchor = arg instanceof HTMLElement ? arg : null;
  const pick = (cmdArg) => { menu.close(); run('cellStyle', cmdArg); };
  const sample = (label, css, onPick, ref) => {
    const node = el('button.menu-item.cell-style-item', {
      type: 'button', role: 'menuitem', tabindex: -1, 'aria-haspopup': 'menu', title: 'Apply. Right-click to modify, duplicate or delete', onclick: onPick,
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); menu.close(); openStyleActions(ctx, ref, null, e.clientX, e.clientY); },
      onkeydown: (e) => {
        if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
        e.preventDefault(); e.stopPropagation();
        const at = node.getBoundingClientRect();
        menu.close(); openStyleActions(ctx, ref, null, at.left + 12, at.bottom);
      },
    },
    // A sample shows the style on paper, whatever the app's theme, as the cell it makes will look.
    el('span.cell-style-sample.sheet-paper', { style: css }, label));
    return node;
  };
  // Samples sit in a grid, as the themed styles do: arrows move along it, and Down and Up a row at a time.
  const grid = (label, nodes) => ({ custom: el('div.cell-style-grid', { role: 'group', 'aria-label': label, 'data-cols': 4 }, ...nodes) });
  const custom = wb.cellStyles.filter((s) => !s.builtin);
  const items = [
    ...(custom.length ? [{ header: 'Custom' }, grid('Custom', custom.map((def) => sample(def.name, sampleCss(def), () => pick(customRef(def.name)), customRef(def.name))))] : []),
    { header: 'Built-in' },
    grid('Built-in', CELL_STYLES.map((s) => {
      const own = builtinOverride(wb, s.key);
      return sample(s.label, own ? sampleCss(own) : presetCss(s), () => pick(s.key), builtinRef(s.key));
    })),
    ...themedCellStyleItems(wb, (key) => pick(key)),
    { separator: true },
    { label: 'New Cell Style…', icon: 'plus', onSelect: () => run('newCellStyle') },
    { label: 'Merge Styles…', icon: 'paint', onSelect: () => run('mergeCellStyles') },
  ];
  const menu = openMenu({
    anchor, x: anchor ? null : (arg?.x ?? null), y: anchor ? null : (arg?.y ?? null), label: 'Cell styles', minWidth: 580, items,
    onClose: (reason) => { if (reason !== 'api') ctx.grid?.focus?.(); },
  });
  return menu;
}

/** The actions on one style, at a point or an anchor. */
export function openStyleActions(ctx, ref, anchor = null, x = null, y = null) {
  const { wb, run } = ctx;
  const builtin = ref.builtin ? cellStyle(ref.builtin) : null;
  const modified = builtin && builtinOverride(wb, ref.builtin);
  const name = builtin ? builtin.label : ref.custom;
  return openMenu({
    anchor, x, y, label: `${name} style`,
    items: [
      { label: 'Apply', icon: 'paint', onSelect: () => run('cellStyle', builtin ? ref.builtin : ref) },
      { label: 'Modify…', icon: 'pencil', onSelect: () => run('modifyCellStyle', ref) },
      { label: 'Duplicate…', icon: 'duplicate', onSelect: () => run('duplicateCellStyle', ref) },
      builtin
        ? { label: 'Reset to Built-in', icon: 'reset', disabled: !modified, hint: modified ? null : 'This style is as built in', onSelect: () => run('deleteCellStyle', ref) }
        : { label: 'Delete', icon: 'trash', danger: true, onSelect: () => run('deleteCellStyle', ref) },
    ],
    onClose: (reason) => { if (reason !== 'api' && reason !== 'select') ctx.grid?.focus?.(); },
  });
}

/** The definition an action starts from: a custom style, or a built-in as the workbook has it. */
function definitionOf(wb, ref) {
  if (ref?.builtin) {
    const preset = cellStyle(ref.builtin);
    return preset ? builtinOverride(wb, ref.builtin) || { ...styleFromPreset(preset), builtin: ref.builtin } : null;
  }
  return ref?.custom ? customStyleNamed(wb, ref.custom) : null;
}

/** A name not yet taken, from `base`: "Base 2", "Base 3", … */
function freeName(wb, base, first = 2) {
  for (let n = first; ; n++) if (!styleNameProblem(wb, `${base} ${n}`)) return `${base} ${n}`;
}

/**
 * The Style dialog. `mode` is 'new' (a style by example, from the active cell's format), 'modify' or
 * 'duplicate' (`ref` names the style). OK saves the definition as one undo step; a modified style
 * reformats the cells linked to it in that same step.
 */
export function openStyleDialog(ctx, { mode = 'new', ref = null } = {}) {
  const { wb } = ctx;
  const source = mode === 'new' ? null : definitionOf(wb, ref);
  if (mode !== 'new' && !source) return null;
  const builtin = mode === 'modify' && source.builtin ? source.builtin : null;
  const oldName = mode === 'modify' ? source.name : null;
  let initial;
  if (mode === 'new') {
    const st = ctx.style?.() || {};
    const r = ctx.active?.();
    // The cell's own edges, as the grid draws them, so a style made by example keeps its borders.
    const edges = r ? wb.styleAt?.(ctx.sheetId(), r.r, r.c) : st;
    initial = styleFromCell(freeName(wb, 'Style', 1), { ...st, ...Object.fromEntries(['bt', 'bb', 'bl', 'br', 'btBorder', 'bbBorder', 'blBorder', 'brBorder', 'bs', 'bc'].map((k) => [k, edges?.[k]])) });
    delete initial.style.cellStyle;
  } else initial = { ...source, name: mode === 'duplicate' ? freeName(wb, source.name) : source.name, style: { ...source.style }, borders: source.borders.map((b) => ({ ...b })) };
  // The draft keeps every part's settings, included or not, so a part switched off and on again keeps them.
  const draft = { parts: { ...initial.parts }, cell: styleAsCell(initial) };
  const defOf = (name) => normalizeCustomStyle({
    name, parts: draft.parts, borders: edgesOfStyle(draft.cell), ...(builtin ? { builtin } : {}),
    style: Object.fromEntries(Object.entries(draft.cell).filter(([k]) => STYLE_PARTS.some(([p]) => PART_KEYS[p].includes(k)))),
  });

  const nameInput = el('input.input', { type: 'text', value: initial.name, 'aria-label': 'Style name', autocomplete: 'off', spellcheck: false, maxlength: 255, disabled: !!builtin });
  const { alert, refuse } = fieldAlert('style');
  const summaries = new Map();
  const checks = new Map();
  const rows = STYLE_PARTS.map(([key, label]) => {
    const id = fieldId('style-part');
    const summary = el('span.style-part-summary', { id: `${id}-summary` });
    const box = el('input', { type: 'checkbox', id, checked: draft.parts[key], 'aria-describedby': `${id}-summary`, onchange: () => { draft.parts[key] = box.checked; refresh(); } });
    summaries.set(key, summary);
    checks.set(key, box);
    return el('div.style-part', {}, box, el('label.style-part-name', { for: id }, label), summary);
  });
  function refresh() {
    const def = defOf(nameInput.value.trim() || initial.name);
    for (const [key, node] of summaries) {
      node.textContent = partSummary({ ...def, style: { ...draft.cell }, borders: edgesOfStyle(draft.cell) }, key);
      node.classList.toggle('muted', !draft.parts[key]);
    }
    preview.replaceChildren(el('span.cell-style-sample.sheet-paper', { style: sampleCss({ ...def, borders: def.parts.border ? def.borders : [] }) }, nameInput.value.trim() || 'Sample'));
  }
  const preview = el('div.style-preview', { 'aria-hidden': 'true' });
  nameInput.addEventListener('input', refresh);

  const format = () => {
    openFormatCellsDialog(ctx, {
      style: { ...draft.cell }, title: `Format Style: ${nameInput.value.trim() || initial.name}`,
      onApply: (out) => {
        const before = draft.cell;
        draft.cell = foldFormat(draft.cell, out);
        // A part the Format Cells dialog changed is one the style now carries.
        for (const [key] of STYLE_PARTS) {
          const keys = key === 'border' ? ['bt', 'bb', 'bl', 'br', 'btBorder', 'bbBorder', 'blBorder', 'brBorder'] : PART_KEYS[key];
          if (keys.some((k) => JSON.stringify(before[k]) !== JSON.stringify(draft.cell[k]))) { draft.parts[key] = true; checks.get(key).checked = true; }
        }
        refresh();
      },
    });
  };

  const submit = (e) => {
    e?.preventDefault();
    const name = builtin ? initial.name : nameInput.value.trim();
    const problem = builtin ? null : styleNameProblem(wb, name, oldName);
    if (problem) return refuse(nameInput, problem);
    if (!Object.values(draft.parts).some(Boolean)) return refuse(null, 'Choose at least one part of the format for the style to hold');
    const def = defOf(name);
    modal.close();
    ctx.run('saveCellStyle', { def, oldName, builtin });
  };
  const title = mode === 'modify' ? 'Modify Cell Style' : mode === 'duplicate' ? 'Duplicate Cell Style' : 'New Cell Style';
  const content = el('form.style-dialog', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, 'Style name'), nameInput),
    builtin && el('p.field-hint', {}, 'A built-in style keeps its name; your changes apply to this spreadsheet.'),
    el('fieldset.style-parts', {}, el('legend', {}, mode === 'new' ? 'Style includes (taken from the active cell)' : 'Style includes'), ...rows),
    preview,
    alert,
    el('div.row.style-dialog-actions', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: format }, 'Format…'),
      el('span.spacer'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title, content, initialFocus: builtin ? checks.get('number') : nameInput, onClose: () => ctx.grid?.focus?.() });
  refresh();
  if (!builtin) nameInput.select?.();
  return modal;
}

/**
 * Save a definition from the Style dialog: a new style is added; a modified one replaces its old self (a
 * built-in's modified copy is kept beside the presets), and the cells linked to it are formatted again, all
 * in one undo step. Returns how many cells were reformatted.
 */
export function saveCellStyle(wb, { def, oldName = null, builtin = null }) {
  let restyled = 0;
  const label = oldName ? `Modify style: ${def.name}` : `New cell style: ${def.name}`;
  wb.transaction(label, () => {
    const list = wb.cellStyles.filter((s) => (builtin ? s.builtin !== builtin : !oldName || s.builtin || s.name.toLowerCase() !== oldName.toLowerCase()));
    const at = oldName ? wb.cellStyles.findIndex((s) => (builtin ? s.builtin === builtin : !s.builtin && s.name.toLowerCase() === oldName.toLowerCase())) : -1;
    list.splice(at < 0 ? list.length : at, 0, def);
    wb.setCellStyles(list, label);
    if (oldName) restyled = restyleCells(wb, oldName, def);
  });
  return restyled;
}

/**
 * Delete a custom style (its cells keep their look, without the link), or put a modified built-in back as
 * built in (its cells take the preset's look again). One undo step.
 */
export function deleteCellStyle(wb, ref) {
  if (ref?.builtin) {
    const own = builtinOverride(wb, ref.builtin);
    const preset = cellStyle(ref.builtin);
    if (!own || !preset) return false;
    wb.transaction(`Reset style: ${preset.label}`, () => {
      wb.setCellStyles(wb.cellStyles.filter((s) => s !== own), `Reset style: ${preset.label}`);
      restyleCells(wb, preset.label, { ...styleFromPreset(preset), builtin: ref.builtin });
    });
    return true;
  }
  const def = customStyleNamed(wb, ref?.custom);
  if (!def) return false;
  wb.transaction(`Delete style: ${def.name}`, () => {
    wb.setCellStyles(wb.cellStyles.filter((s) => s !== def), `Delete style: ${def.name}`);
    unlinkCells(wb, def.name);
  });
  return true;
}

/**
 * Merge the styles of `other` (a workbook) into `wb`. Styles with names this book already has are replaced
 * when `replace` is set (and the cells linked to them formatted again), else this book's are kept. One undo
 * step. Returns the counts mergeStyleLists gives.
 */
export function mergeCellStyles(wb, other, { replace = false } = {}) {
  const result = mergeStyleLists(wb.cellStyles, other.cellStyles || [], { replace });
  if (!result.added && !result.replaced) return result;
  wb.transaction('Merge styles', () => {
    wb.setCellStyles(result.list, 'Merge styles');
    if (replace) for (const def of result.list) if (other.cellStyles.some((s) => s.name.toLowerCase() === def.name.toLowerCase())) restyleCells(wb, def.name, def);
  });
  return result;
}

/**
 * Merge Styles…: pick a spreadsheet (from the app's folder, Puter's file picker, or this device), then its
 * styles are merged in, asking first whether same-named styles should be replaced.
 * `io` carries the host's file access: { listFiles, pickFile, readFile, displayName, open(bytes, name), currentPath }.
 */
export function openMergeStylesDialog(ctx, io) {
  const { wb } = ctx;
  const status = el('p.small.muted', { role: 'status' }, 'Loading spreadsheets…');
  const list = el('div.merge-styles-list', { role: 'listbox', 'aria-label': 'Spreadsheets', tabindex: 0 });
  let files = [];
  let chosen = -1;
  const { alert, refuse } = fieldAlert('merge-styles');
  const choose = (i) => {
    chosen = i;
    [...list.children].forEach((node, k) => { node.setAttribute('aria-selected', String(k === i)); node.classList.toggle('selected', k === i); });
    list.setAttribute('aria-activedescendant', list.children[i]?.id || '');
    list.children[i]?.scrollIntoView?.({ block: 'nearest' });
  };
  list.addEventListener('keydown', (e) => {
    if (!files.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); choose(Math.min(files.length - 1, chosen + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); choose(Math.max(0, chosen - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); choose(0); }
    else if (e.key === 'End') { e.preventDefault(); choose(files.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (chosen >= 0) mergeFrom(files[chosen]); }
  });
  const listId = fieldId('merge-file');
  Promise.resolve().then(() => io.listFiles?.() || []).then((found) => {
    files = found.filter((f) => f.path !== io.currentPath && /\.(xlsx|xlsm|ods)$/i.test(f.name));
    list.replaceChildren(...files.map((f, i) => el('div.merge-styles-file', {
      id: `${listId}-${i}`, role: 'option', 'aria-selected': 'false', onclick: () => choose(i), ondblclick: () => mergeFrom(f),
    }, f.name)));
    status.textContent = files.length ? 'Choose the spreadsheet whose styles to copy into this one.' : 'No other spreadsheets in your Spreadsheets folder. Browse for one instead.';
    if (files.length) choose(0);
  }).catch(() => { status.textContent = 'Your spreadsheets could not be listed. Browse for one instead.'; });

  async function mergeFrom(file) {
    let other;
    try {
      other = file.bytes ? await io.open(file.bytes, file.name) : await io.open(await io.readFile(file.path), file.name);
    } catch (e) {
      return refuse(null, `${file.name} could not be read${e?.message ? `: ${e.message}` : ''}`);
    }
    if (!other?.cellStyles?.length) return refuse(null, `${file.name} has no cell styles of its own to merge`);
    const clashes = clashingStyleNames(wb.cellStyles, other.cellStyles);
    let replace = false;
    if (clashes.length) {
      const named = clashes.length > 3 ? `${clashes.slice(0, 3).join(', ')} and ${clashes.length - 3} more` : clashes.join(', ');
      const answer = await confirmDialog({
        title: 'Merge Styles', message: `This spreadsheet already has styles named ${named}. Replace them with the ones from ${file.name}?`,
        confirmLabel: 'Replace', cancelLabel: 'Keep mine', danger: false, dismissValue: null,
      });
      if (answer === null) return; // closed without an answer: nothing is merged
      replace = answer;
    }
    modal.close();
    const result = mergeCellStyles(wb, other, { replace });
    const parts = [result.added && `${result.added} added`, result.replaced && `${result.replaced} replaced`, result.kept && `${result.kept} kept as they were`].filter(Boolean);
    toast(parts.length ? `Styles from ${file.name}: ${parts.join(', ')}` : `Nothing new to merge from ${file.name}`, { icon: 'paint', duration: 3500 });
  }

  const browse = io.pickFile && el('button.btn.btn-ghost', { type: 'button', onclick: async () => {
    const picked = await io.pickFile();
    if (picked) mergeFrom({ path: picked.path, name: picked.name });
  } }, 'Browse Puter…');
  const deviceInput = el('input', { type: 'file', accept: '.xlsx,.xlsm,.ods', hidden: true, onchange: async () => {
    const file = deviceInput.files?.[0];
    if (file) mergeFrom({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  } });
  const content = el('form', { onsubmit: (e) => { e.preventDefault(); if (chosen < 0) return refuse(list, 'Choose a spreadsheet, or browse for one'); mergeFrom(files[chosen]); } },
    status, list, alert, deviceInput,
    el('div.row.style-dialog-actions', {},
      browse,
      el('button.btn.btn-ghost', { type: 'button', onclick: () => deviceInput.click() }, 'From this device…'),
      el('span.spacer'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Merge')));
  const modal = openModal({ title: 'Merge Styles', content, initialFocus: list, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
