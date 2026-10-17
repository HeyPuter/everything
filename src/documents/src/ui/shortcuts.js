import { el, MOD_KEY, IS_MAC } from './dom.js';
import { openModal } from './modal.js';

/**
 * What the keyboard does in the editor. Each row names a result and the
 * chord (or chords) for it; every entry here is handled by the editor or
 * the engine, so the list is a promise rather than a wish.
 */
const ALT = IS_MAC ? 'Option' : 'Alt';

const GROUPS = [
  ['Text', [
    [`${MOD_KEY} + B`, 'Bold'],
    [`${MOD_KEY} + I`, 'Italic'],
    [`${MOD_KEY} + U`, 'Underline'],
    [`${MOD_KEY} + Shift + X`, 'Strikethrough'],
    [[`${MOD_KEY} + Shift + =`, `${MOD_KEY} + .`], 'Superscript'],
    [`${MOD_KEY} + =`, 'Subscript'],
    [`${MOD_KEY} + Shift + A`, 'All caps'],
    [`${MOD_KEY} + Shift + K`, 'Small caps'],
    [`${MOD_KEY} + Shift + .`, 'Increase font size'],
    [`${MOD_KEY} + Shift + ,`, 'Decrease font size'],
    [`${MOD_KEY} + K`, 'Insert or edit link'],
    [`${MOD_KEY} + Shift + V`, 'Paste without formatting (or paste copied formatting)'],
    [`${MOD_KEY} + ${ALT} + Shift + V`, 'Paste and match formatting'],
    [`${MOD_KEY} + Shift + C`, 'Copy formatting'],
    [[`${MOD_KEY} + Space`, `${MOD_KEY} + \\`], 'Clear direct text formatting'],
    ['Ctrl + Shift + D', 'Double underline'],
    ['Ctrl + Shift + W', 'Underline words only'],
    [`${MOD_KEY} + D`, 'Font dialog'],
    ['Ctrl + Shift + F', 'Choose a font'],
    ['Ctrl + Shift + P', 'Font size'],
    ['Shift + F3', 'Change case'],
  ]],
  ['Paragraph', [
    [[`${MOD_KEY} + L`, `${MOD_KEY} + Shift + L`], 'Align left'],
    // Cmd/Ctrl+Shift+E is Track Changes, so only the plain chord centers.
    [`${MOD_KEY} + E`, 'Align center'],
    [[`${MOD_KEY} + R`, `${MOD_KEY} + Shift + R`], 'Align right'],
    [[`${MOD_KEY} + J`, `${MOD_KEY} + Shift + J`], 'Justify'],
    [`${MOD_KEY} + Shift + 8`, 'Bulleted list'],
    [`${MOD_KEY} + Shift + 7`, 'Numbered list'],
    [`${ALT} + Shift + Right / Left`, 'Change list level'],
    [`${MOD_KEY} + ${ALT} + 0`, 'Normal style'],
    [`${MOD_KEY} + ${ALT} + 1 … 6`, 'Heading 1 to 6'],
    ['Shift + Enter', 'Line break'],
    [`${MOD_KEY} + Enter`, 'Page break'],
    [`${MOD_KEY} + Shift + Enter`, 'Column break'],
    ['Ctrl + 1 / 2 / 5', 'Single, double or 1.5 line spacing'],
    ['Ctrl + 0', 'Add or remove space before'],
    [['Ctrl + M', 'Ctrl + Shift + M'], 'Increase or decrease the left indent'],
    [['Ctrl + T', 'Ctrl + Shift + T'], 'Hanging indent, or reduce it'],
    ['Ctrl + Q', 'Clear direct paragraph formatting'],
    ['Ctrl + Shift + N', 'Normal style'],
    [IS_MAC ? 'Ctrl + Shift + Up / Down' : 'Alt + Shift + Up / Down', 'Move paragraphs up or down'],
    [`${MOD_KEY} + 8`, 'Show or hide formatting marks'],
  ]],
  ['Document', [
    [`${MOD_KEY} + S`, 'Save now'],
    [[`${MOD_KEY} + F`, MOD_KEY === 'Cmd' ? 'Cmd + Shift + H' : 'Ctrl + H'], 'Find and replace'],
    [`${MOD_KEY} + Z`, 'Undo'],
    [[`${MOD_KEY} + Shift + Z`, `${MOD_KEY} + Y`], 'Redo'],
    [['F4', `${MOD_KEY} + Y`], 'Repeat the last command (when there is nothing to redo)'],
    [IS_MAC ? 'Cmd + Shift + S' : 'Ctrl + Shift + S', 'Save as'],
    [`${MOD_KEY} + O`, 'Open a document'],
    [IS_MAC ? ['Cmd + G', 'Cmd + Shift + G', 'Shift + F4', 'Cmd + Shift + F4'] : ['Shift + F4', 'Ctrl + Shift + F4'], 'Find next or previous'],
    [IS_MAC ? 'Cmd + Option + K' : 'Alt + Q', 'Search for a command'],
    [`${MOD_KEY} + ,`, 'Preferences'],
    [`${MOD_KEY} + A`, 'Select all'],
    [`${MOD_KEY} + P`, 'Print or save as PDF'],
    ['F9', 'Update page references'],
    ['F7', 'Check spelling'],
    [[IS_MAC ? 'Cmd + Option + G' : 'Ctrl + G', 'F5'], 'Go to a page, line, heading, bookmark, table or graphic'],
    [`${MOD_KEY} + click`, 'Open a link'],
    [`${MOD_KEY} + /`, 'Show keyboard shortcuts'],
  ]],
  ['Navigation', [
    [MOD_KEY === 'Cmd' ? 'Option + Left / Right' : 'Ctrl + Left / Right', 'Previous or next word'],
    [MOD_KEY === 'Cmd' ? 'Option + Up / Down' : 'Ctrl + Up / Down', 'Previous or next paragraph'],
    [MOD_KEY === 'Cmd' ? ['Cmd + Up / Down', 'Cmd + Home / End'] : 'Ctrl + Home / End', 'Start or end of the document'],
    ['Page Up / Page Down', 'Up or down a screen'],
    ['Shift + any movement key', 'Extend the selection'],
    ['Double-click / triple-click', 'Select a word / a paragraph'],
    [`${MOD_KEY} + ${ALT} + O`, 'Show or hide the outline'],
    [IS_MAC ? 'Option' : ['Alt', 'F10'], 'Show KeyTips: letters for the ribbon tabs and commands'],
    [IS_MAC ? 'Cmd + Option + R' : 'Ctrl + F1', 'Collapse or expand the ribbon'],
    [IS_MAC ? 'Ctrl + F2' : 'Alt + F10', 'Go to the menu bar'],
    ...(IS_MAC ? [['Cmd + Option + M', 'Paragraph settings'], ['Cmd + Ctrl + Shift + F', 'Focus']] : []),
    [['Tab', 'Shift + Tab'], 'Next or previous table cell'],
    ['Escape', 'Close a panel or menu; in the document, Tab then moves to the toolbar'],
  ]],
];

export function openShortcuts({ custom = [] } = {}) {
  const groups = custom.length ? [...GROUPS, ['Your shortcuts', custom]] : GROUPS;
  const content = el('div.shortcuts', {},
    groups.map(([title, rows]) => el('section.shortcut-group', {},
      el('h3', {}, title),
      el('dl', {}, rows.map(([keys, what]) => [
        el('dt', {}, [keys].flat().map((chord, n) => [n > 0 && ' or ', chord.split(' + ').map((k, i) => [i > 0 && ' + ', el('span.kbd', {}, k)])])),
        el('dd', {}, what),
      ])))));
  const modal = openModal({ title: 'Keyboard shortcuts', content, wide: true });
  // Two columns of chords with alternatives need more room than the wide dialog gives a form.
  modal.panel.classList.add('shortcuts-panel');
  return modal;
}
