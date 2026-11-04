/**
 * Text box dialog: the text, its size, weight, colors, and alignment. Used
 * to insert a new box at the active cell and to edit one (double-click,
 * Enter, or the Edit button on a selected box).
 */

import { el, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { TEXT_SIZES, TEXT_MAX_LENGTH, textBoxText } from '../core/charts.js';
import { EFFECT_LEVELS } from '../core/theme-effects.js';
import { t } from '../i18n/index.js';

/** Each colour and fill offered, with its name (a catalog key). */
const COLORS = [['', 'textboxdialog.color.automatic'], ['#1a1a1a', 'textboxdialog.color.black'], ['#6b6964', 'textboxdialog.color.gray'], ['#c22a2a', 'textboxdialog.color.red'], ['#eb6834', 'textboxdialog.color.orange'], ['#b8860b', 'textboxdialog.color.gold'], ['#1baf7a', 'textboxdialog.color.green'], ['#0a63f0', 'textboxdialog.color.blue'], ['#4a3aa7', 'textboxdialog.color.purple'], ['#ffffff', 'textboxdialog.color.white']];
const FILLS = [['', 'textboxdialog.color.none'], ['#ffffff', 'textboxdialog.color.white'], ['#fff7c2', 'textboxdialog.color.yellow'], ['#e3f0ff', 'textboxdialog.color.blue'], ['#e2f6ea', 'textboxdialog.color.green'], ['#fde8e8', 'textboxdialog.color.red'], ['#f2f1ee', 'textboxdialog.color.gray'], ['#1a1a1a', 'textboxdialog.color.black']];

/** `fit(text, style)`, with a box being edited, gives the size the box takes for the text saved (WordArt's). */
export function openTextBoxDialog(ctx, { textbox = null, fit = null } = {}) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return;
  const st = { size: 13, bold: false, italic: false, color: null, bg: null, align: 'left', valign: 'top', border: true, ...(textbox?.style || {}) };

  const initialText = textbox ? textBoxText(wb, sheetId, textbox) : '';
  const textArea = el('textarea.input.textbox-text', { rows: 4, placeholder: t('textboxdialog.placeholder'), 'aria-label': t('textboxdialog.text'), value: initialText });
  const sizes = [...new Set([...TEXT_SIZES, st.size])].sort((a, b) => a - b);
  const sizeSel = el('select.select', { 'aria-label': t('textboxdialog.fontSize') }, sizes.map((n) => el('option', { value: String(n), selected: n === st.size }, `${n}`)));
  const colorSelect = (label, palette, current) => {
    const options = (current && !palette.some(([value]) => value === current) ? [...palette, [current, null]] : palette)
      .map(([value, name]) => [value, name ? t(name) : t('textboxdialog.customColor', { color: value })]);
    return el('select.select', { 'aria-label': label }, options.map(([value, name]) =>
      el('option', { value, selected: (current || '') === value }, name)));
  };
  const colorSel = colorSelect(t('textboxdialog.textColor'), COLORS, st.color);
  const fillSel = colorSelect(t('textboxdialog.fillColor'), FILLS, st.bg);
  // A theme effect (Page Layout ▸ Effects decides how it looks).
  const effectSel = el('select.select', { 'aria-label': t('textboxdialog.themeEffect') }, [['0', t('common.none')], ...EFFECT_LEVELS.map((label, i) => [String(i + 1), label])]
    .map(([value, label]) => el('option', { value, selected: String(st.effectRef || 0) === value }, label)));
  const check = (key, label) => {
    const input = el('input', { type: 'checkbox', checked: !!st[key], onchange: () => { st[key] = input.checked; } });
    return el('label.check', {}, input, el('span', {}, label));
  };
  const seg = (key, options) => {
    const group = el('div.seg', { role: 'radiogroup', 'aria-label': key === 'align' ? t('textboxdialog.horizontalAlignment') : t('textboxdialog.verticalAlignment') });
    const choose = (val) => {
      st[key] = val;
      for (const b of group.children) {
        const selected = b.dataset.key === val;
        b.setAttribute('aria-checked', String(selected));
        b.tabIndex = selected ? 0 : -1;
      }
    };
    for (const [val, label] of options) {
      group.append(el('button.seg-btn', {
        type: 'button', role: 'radio', 'aria-checked': String(st[key] === val), dataset: { key: val }, tabindex: st[key] === val ? 0 : -1,
        onclick: () => choose(val),
      }, label));
    }
    group.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      const step = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 0;
      if (!step) return;
      const choices = [...group.children];
      const index = choices.indexOf(e.target.closest('[role="radio"]'));
      if (index < 0) return;
      e.preventDefault();
      const next = choices[(index + step + choices.length) % choices.length];
      choose(next.dataset.key);
      next.focus();
    });
    return group;
  };
  const { alert: error, refuse } = fieldAlert('textbox'); // a protected sheet is about no field

  function canChange() {
    if (!wb.isProtected(sheetId)) return true;
    return refuse(null, t('textboxdialog.protected'));
  }

  const submit = (e) => {
    e?.preventDefault();
    if (!canChange()) return;
    const text = textArea.value.replace(/\r\n/g, '\n');
    if (!text.trim()) return refuse(textArea, t('textboxdialog.typeText'));
    if (text.length > TEXT_MAX_LENGTH) return refuse(textArea, t('textboxdialog.tooLong', { max: TEXT_MAX_LENGTH }));
    const style = { ...st, size: Number(sizeSel.value), color: colorSel.value || null, bg: fillSel.value || null, effectRef: Number(effectSel.value) || undefined };
    if (textbox) {
      wb.updateChart(sheetId, textbox.id, { text, style, ...(text !== initialText ? { textRef: null, textPrefix: '', textSuffix: '' } : {}), ...(fit ? fit(text, style) : {}) }, t('textboxdialog.undoEdit'));
    } else {
      const a = ctx.active();
      const lines = text.split('\n');
      const longest = Math.max(...lines.map((l) => l.length));
      const w = Math.min(520, Math.max(120, Math.round(longest * style.size * 0.55) + 24));
      const h = Math.min(400, Math.max(48, Math.round(lines.length * style.size * 1.35) + 20));
      const id = wb.addChart(sheetId, { type: 'text', text, style, anchor: { r: a.r, c: a.c }, dx: 4, dy: 4, w, h });
      if (id) ctx.grid.selectChart(id);
    }
    modal.close();
  };

  const content = el('form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, t('textboxdialog.text')), textArea, error,
      textbox?.textRef && el('span.field-hint', {}, t('textboxdialog.linked', { ref: textbox.textRef })),
      el('span.field-hint', {}, t('textboxdialog.upTo', { max: TEXT_MAX_LENGTH }))),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('textboxdialog.size')), sizeSel),
      el('div.field', {}, el('span.field-label', {}, t('textboxdialog.style')), el('div.row.textbox-style-checks', {}, check('bold', t('textboxdialog.bold')), check('italic', t('textboxdialog.italic')), check('border', t('textboxdialog.border'))))),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('textboxdialog.textColor')), colorSel),
      el('label.field', {}, el('span.field-label', {}, t('textboxdialog.fill')), fillSel)),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('textboxdialog.themeEffect')), effectSel), el('span')),
    el('div.row.row-2', {},
      el('div.field', {}, el('span.field-label', {}, t('textboxdialog.align')), seg('align', [['left', t('textboxdialog.left')], ['center', t('textboxdialog.center')], ['right', t('textboxdialog.right')]])),
      el('div.field', {}, el('span.field-label', {}, t('textboxdialog.vertical')), seg('valign', [['top', t('textboxdialog.top')], ['middle', t('textboxdialog.middle')], ['bottom', t('textboxdialog.bottom')]]))),
    el('p.field-hint', {}, t('textboxdialog.hint')),
    el('div.row.row-end', {},
      textbox && el('button.btn.btn-ghost.btn-danger', { type: 'button', onclick: () => { if (!canChange()) return; modal.close(); ctx.run('deleteChart', { id: textbox.id, only: true }); } }, t('common.delete')),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, textbox ? t('common.save') : t('common.insert'))));
  const modal = openModal({ title: textbox ? t('textboxdialog.undoEdit') : t('textboxdialog.insertTitle'), content, initialFocus: textArea, onClose: () => ctx.grid.focus() });
  return modal;
}
