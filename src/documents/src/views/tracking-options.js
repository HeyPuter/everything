/**
 * Tracking display choices: the Show Markup menu and the Tracking Options dialog (marks and colors
 * for insertions, deletions, moves and formatting, change bars, balloons, reviewer colors), with a
 * live preview. View choices are remembered per reader; the document-level ones (what markup is
 * shown, whether moves and formatting are tracked) are saved in the file's settings.
 */
import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { revisionView, revisionColor, INSERT_MARKS, DELETE_MARKS, FORMAT_MARKS, MOVE_COLOR } from '../engine/revisions.js';
import { preference, hint } from './review-ui.js';

const STORED = preference('documents:tracking-options', {});
const VIEW_KEYS = ['balloons', 'insertMark', 'deleteMark', 'insertColor', 'deleteColor', 'formatMark', 'formatColor', 'moveFromMark', 'moveToMark', 'moveColor', 'changeBars', 'changeBarColor', 'authorColors', 'paneOrientation'];
export const BALLOONS = [['balloons', 'Show Revisions in Balloons'], ['inline', 'Show All Revisions Inline'], ['commentsFormatting', 'Show Only Comments and Formatting in Balloons']];
const MARK_NAMES = { underline: 'Underline', doubleUnderline: 'Double underline', strikethrough: 'Strikethrough', doubleStrikethrough: 'Double strikethrough', bold: 'Bold', italic: 'Italic', colorOnly: 'Color only', hidden: 'Hidden', none: '(none)' };
export const COLORS = [['author', 'By author'], ['000000', 'Black'], ['2E6EB5', 'Blue'], ['00838F', 'Teal'], ['2F8A3A', 'Green'], ['2E7D32', 'Dark green'], ['B5082E', 'Red'], ['C25E00', 'Orange'], ['8A3FB0', 'Violet'], ['A0306E', 'Pink'], ['5B6B00', 'Olive'], ['7A7A7A', 'Gray']];
const BAR_SIDES = [['none', 'None'], ['left', 'Left border'], ['right', 'Right border'], ['outside', 'Outside border']];

/** Apply remembered view choices at startup. */
export function restoreTrackingOptions() {
  const stored = STORED.get();
  for (const key of VIEW_KEYS) if (stored[key] !== undefined) revisionView.options[key] = stored[key];
}
export function rememberTrackingOptions() {
  STORED.set(Object.fromEntries(VIEW_KEYS.map(key => [key, revisionView.options[key]])));
}

const select = (label, value, options, onchange) => {
  const node = el('select.input', { 'aria-label': label, onchange: () => onchange(node.value) }, ...options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)));
  return node;
};
const markOptions = list => list.map(v => [v, MARK_NAMES[v] || v]);

/**
 * The Tracking Options dialog. ctx: { authors(), doc: { trackMoves, trackFormatting }, apply(options, doc) }.
 */
export function openTrackingOptions({ authors = () => [], doc = {}, apply, onClose }) {
  const o = structuredClone(revisionView.options);
  const d = { trackMoves: doc.trackMoves !== false, trackFormatting: doc.trackFormatting !== false };
  const preview = el('div.rv-preview', { 'aria-hidden': 'true' });
  const swatch = color => color && color !== 'author' ? `#${color}` : `#${revisionColor(authors()[0] || 'Reviewer', authors())}`;
  const style = (mark, color) => {
    const c = swatch(color);
    return { underline: `text-decoration: underline; text-decoration-color: ${c}`, doubleUnderline: `text-decoration: underline double; text-decoration-color: ${c}`, strikethrough: `text-decoration: line-through; text-decoration-color: ${c}`, doubleStrikethrough: `text-decoration: line-through double; text-decoration-color: ${c}`, bold: 'font-weight: 700', italic: 'font-style: italic', colorOnly: '', hidden: 'display: none', none: '' }[mark] + `; color: ${c}`;
  };
  function renderPreview() {
    const bar = o.changeBars === 'none' ? '' : `border-${o.changeBars === 'right' ? 'right' : 'left'}: 2px solid ${o.changeBarColor && o.changeBarColor !== 'auto' && o.changeBarColor !== 'author' ? `#${o.changeBarColor}` : '#7a7a7a'}`;
    preview.innerHTML = '';
    preview.append(el('p', { style: bar ? `${bar}; padding-inline: 6px` : '' },
      'Plain text, ', el('span', { style: style(o.insertMark, o.insertColor) }, 'inserted text'), ', ', el('span', { style: style(o.deleteMark, o.deleteColor) }, 'deleted text'), ', ',
      d.trackMoves ? el('span', { style: style(o.moveFromMark, o.moveColor || MOVE_COLOR) }, 'moved from') : 'moved from', ', ',
      d.trackMoves ? el('span', { style: style(o.moveToMark, o.moveColor || MOVE_COLOR) }, 'moved to') : 'moved to', ' and ',
      el('span', { style: o.formatMark === 'none' ? '' : style(o.formatMark, o.formatColor) }, 'reformatted'), ' text.'));
  }
  const field = (label, control) => el('label.field.rv-field', {}, el('span.field-label', {}, label), control);
  const check = (label, checked, onchange) => { const input = el('input', { type: 'checkbox', checked, onchange: () => { onchange(input.checked); renderPreview(); } }); return el('label.rv-check', {}, input, label); };
  const set = key => value => { o[key] = value; renderPreview(); };
  const authorRows = authors().map(name => field(name, select(`${name} color`, o.authorColors?.[name] || 'author', [['author', 'Automatic'], ...COLORS.slice(1)], value => { o.authorColors = { ...o.authorColors }; if (value === 'author') delete o.authorColors[name]; else o.authorColors[name] = value; renderPreview(); })));
  const content = el('form.ed-dialog-body.rv-tracking-options', { onsubmit: e => { e.preventDefault(); modal.close(); apply(o, d); } },
    el('fieldset.rv-fieldset', {}, el('legend', {}, 'Markup'),
      el('div.rv-grid', {},
        field('Insertions', select('Insertion mark', o.insertMark, markOptions(INSERT_MARKS), set('insertMark'))), field('Color', select('Insertion color', o.insertColor, COLORS, set('insertColor'))),
        field('Deletions', select('Deletion mark', o.deleteMark, markOptions(DELETE_MARKS), set('deleteMark'))), field('Color', select('Deletion color', o.deleteColor, COLORS, set('deleteColor'))),
        field('Changed lines', select('Change bar position', o.changeBars, BAR_SIDES, set('changeBars'))), field('Color', select('Change bar color', o.changeBarColor === 'auto' ? 'author' : o.changeBarColor, [['author', 'Automatic'], ...COLORS.slice(1)], value => { o.changeBarColor = value === 'author' ? 'auto' : value; renderPreview(); })))),
    el('fieldset.rv-fieldset', {}, el('legend', {}, 'Moves'),
      check('Track moves', d.trackMoves, value => { d.trackMoves = value; }),
      el('div.rv-grid', {},
        field('Moved from', select('Moved from mark', o.moveFromMark, markOptions(DELETE_MARKS.filter(m => m !== 'hidden')), set('moveFromMark'))), field('Color', select('Move color', o.moveColor || MOVE_COLOR, COLORS.slice(1), set('moveColor'))),
        field('Moved to', select('Moved to mark', o.moveToMark, markOptions(INSERT_MARKS), set('moveToMark'))))),
    el('fieldset.rv-fieldset', {}, el('legend', {}, 'Formatting'),
      check('Track formatting', d.trackFormatting, value => { d.trackFormatting = value; }),
      el('div.rv-grid', {}, field('Formatting', select('Formatting mark', o.formatMark, markOptions(FORMAT_MARKS), set('formatMark'))), field('Color', select('Formatting color', o.formatColor, COLORS, set('formatColor'))))),
    el('fieldset.rv-fieldset', {}, el('legend', {}, 'Balloons and pane'),
      field('Balloons', select('Balloons', o.balloons, BALLOONS, set('balloons'))),
      field('Reviewing Pane', select('Reviewing Pane orientation', o.paneOrientation || 'vertical', [['vertical', 'Vertical (beside the pages)'], ['horizontal', 'Horizontal (below the pages)']], set('paneOrientation')))),
    authorRows.length ? el('fieldset.rv-fieldset', {}, el('legend', {}, 'Reviewer colors'), ...authorRows) : null,
    el('div.rv-preview-wrap', {}, el('span.field-label', {}, 'Preview'), preview),
    hint('Marks and colors apply to how changes look on your screen. Tracking moves and formatting is saved with the document.'),
    el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  renderPreview();
  const modal = openModal({ title: 'Tracking Options', content, onClose, wide: true });
  return modal;
}

/**
 * Show Markup menu items. ctx: { authors(), ink?: { shown, toggle }, comments: { shown, toggle }, update(options) }.
 */
export function showMarkupItems({ authors, ink, comments, update }) {
  const o = revisionView.options;
  const toggle = key => () => update({ [key]: !o[key] });
  const people = authors();
  return [
    { label: 'Comments', checked: comments.shown, onSelect: () => comments.toggle() },
    ...(ink ? [{ label: 'Ink', checked: ink.shown, onSelect: () => ink.toggle() }] : []),
    { label: 'Insertions and Deletions', checked: o.showInsDel, onSelect: toggle('showInsDel') },
    { label: 'Formatting', checked: o.showFormatting, onSelect: toggle('showFormatting') },
    { separator: true },
    { label: 'Balloons', items: BALLOONS.map(([value, label]) => ({ label, radio: true, checked: o.balloons === value, onSelect: () => update({ balloons: value }) })) },
    { label: 'Specific People', disabled: !people.length, items: [
      { label: 'All Reviewers', checked: !o.hiddenAuthors.length, onSelect: () => update({ hiddenAuthors: [] }) },
      { separator: true },
      ...people.map(name => ({ label: name, checked: !o.hiddenAuthors.includes(name), onSelect: () => update({ hiddenAuthors: o.hiddenAuthors.includes(name) ? o.hiddenAuthors.filter(n => n !== name) : [...o.hiddenAuthors, name] }) })),
    ] },
  ];
}
