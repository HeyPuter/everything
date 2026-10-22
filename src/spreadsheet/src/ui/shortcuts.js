import { el } from './dom.js';
import { openModal } from './modal.js';
import { MOD_KEY, IS_MAC } from './dom.js';

// macOS takes ⌘+Shift+3, 4, 5 and 6 for screenshots before the page sees them, so on a Mac the number-format and border chords go with Control.
const FMT_KEY = IS_MAC ? '⌃' : MOD_KEY;

const GROUPS = [
  ['Navigate', [
    ['F6 / Shift + F6', 'Next / previous area: menus, toolbar, formula bar, grid, find bar and open panes, sheets, status, assistant'],
    ['Alt or F10', 'Show key tips on the ribbon: type a tab’s letter, then a command’s (Escape steps back)'],
    [`${MOD_KEY} + F1`, 'Show or hide the ribbon’s commands'],
    [`${MOD_KEY} + Shift + U`, 'Expand or collapse the formula bar'],
    ['Arrow keys', 'Move the active cell'],
    ['Shift + Arrow', 'Extend the selection'],
    [`${MOD_KEY} + Arrow`, 'Jump to the edge of the data'],
    ['Tab / Shift + Tab', 'Move right / left (Tab from the last cell of a table adds a row)'],
    ['Enter / Shift + Enter', 'Move down / up'],
    [`${MOD_KEY} + Home`, 'Go to A1'],
    [`${MOD_KEY} + G or F5`, 'Go to a cell, range, named range, table, or Sheet!A1 on another sheet (the name box; Alt + Down there lists the names)'],
    [`${MOD_KEY} + Backspace`, 'Scroll back to the active cell'],
    [`${MOD_KEY} + Shift + P or Alt + /`, 'Search the menus: every action by name'],
    [`${MOD_KEY} + J`, 'Open or close the AI assistant (Escape in it goes back to the sheet)'],
    ['Page Up / Page Down', 'Scroll a screen up / down'],
    ['Alt + Page Up / Alt + Page Down', 'Scroll a screen left / right'],
    // Browsers keep Ctrl+PgUp/PgDn for their own tabs on Windows and Linux, so the Alt chords come first.
    ['Alt + → / Alt + ←', `Next / previous sheet (also ${MOD_KEY} + Page Down / Page Up)`],
    ['End, then an arrow', 'Jump to the edge of the data (End Mode); End, then Home: the last cell'],
    ['F8 / Shift + F8', 'Extend the selection / add to the selection with the arrows and clicks'],
    ['Shift + Backspace', 'Select only the active cell'],
    [`${MOD_KEY} + .`, 'Move the active cell to the next corner of the selection'],
    ['Alt + ;', 'Select the visible cells only'],
    [`${MOD_KEY} + \\ / ${MOD_KEY} + Shift + |`, 'Select the row differences / column differences'],
    [`${MOD_KEY} + Shift + { / }`, 'Select the precedents / dependents of the active cell'],
    [`${MOD_KEY} + A or ${MOD_KEY} + Shift + Space`, 'Select all'],
    [`${MOD_KEY} + click`, 'Add another cell, range, row, or column to the selection'],
    ['Shift + Space', 'Select the row'],
    [`${MOD_KEY} + Shift + 8`, 'Select the current region: the block of data around the active cell'],
    // macOS takes ⌘+Space (Spotlight) and ⌘+` (next window) before the page sees them, so there Control serves as well.
    [IS_MAC ? `${MOD_KEY} + Space or ⌃ + Space` : `${MOD_KEY} + Space`, 'Select the column'],
    ['Drag the bar at the corner of the headers', 'Freeze rows or columns up to where it lands'],
    // Floating objects: the grid selects and moves them from the keyboard.
    [`${MOD_KEY} + Alt + O`, 'Select the next chart, image, or text box (Shift: the previous one)'],
    ['Arrow keys / Shift + Arrow', `Nudge the selected chart, image, or text box 8px, or a whole cell (${MOD_KEY} + C copies it as a picture, Enter edits it, Delete removes it, Escape deselects)`],
    [`${MOD_KEY} + D`, 'Duplicate the selected chart, image, or text box'],
  ]],
  ['Edit', [
    ['Type', 'Replace the cell contents (matching text from the column is suggested)'],
    [IS_MAC ? 'F2 or ⌃ + U' : 'F2', 'Edit in place (double-click a cell too)'],
    ['F2 while typing', 'Switch between Enter mode (arrows leave the cell) and Edit mode (arrows move the caret); the status bar shows which'],
    ['Shift + F2', 'Add or edit a note'],
    [`${MOD_KEY} + K`, 'Insert or edit a link'],
    [`${MOD_KEY} + click`, 'Open a link (a link to a sheet or range jumps there)'],
    ['Alt + Down', 'Open a dropdown list, a calendar on a date cell, or pick from the column’s entries'],
    ['Shift + F10 or Menu', 'Open the menu for the selected cells, or for the focused sheet tab'],
    ['Double-click a date cell', 'Pick a date from a calendar'],
    ['Space', 'Toggle a checkbox cell'],
    ['Escape', 'Cancel the edit'],
    ['Alt + Enter', 'New line inside a cell'],
    ['Arrow keys after = ( , or an operator', 'Pick a cell reference into the formula (Shift extends to a range)'],
    ['Click, then Shift + click, while a formula wants a reference', `Pick a cell, then stretch it into a range (dragging works too); ${MOD_KEY} + click adds another after a comma`],
    ['Click another sheet\'s tab while typing a formula', 'Pick references there (Sheet2!B3); Enter or Escape comes back'],
    ['F4', 'Cycle $ anchors on the reference at the caret'],
    [`${MOD_KEY} + Shift + =`, 'Insert rows (or columns)'],
    [`${MOD_KEY} + -`, 'Delete rows (or columns)'],
    [`${MOD_KEY} + 9 / ${MOD_KEY} + 0`, 'Hide rows / columns'],
    ['Alt + Shift + Right / Left', 'Group / ungroup the selected rows (or columns)'],
    [`${MOD_KEY} + Shift + 9 / 0`, 'Unhide rows / columns'],
    ['Delete / Backspace', 'Clear contents'],
    [`${MOD_KEY} + Z`, 'Undo'],
    [`${MOD_KEY} + Shift + Z`, 'Redo'],
    [`${MOD_KEY} + C / X / V`, 'Copy / cut / paste'],
    [`${MOD_KEY} + Shift + V`, 'Paste values only'],
    [`${MOD_KEY} + Alt + V`, 'Paste special menu'],
    [`${MOD_KEY} + '`, 'Copy the formula from the cell above'],
    [`${MOD_KEY} + Shift + "`, 'Copy the value from the cell above'],
    ['F9', 'Recalculate every formula (NOW(), TODAY(), and RAND() included)'],
    [`${MOD_KEY} + [ / ${MOD_KEY} + ]`, 'Highlight the cells a formula reads / the formulas that read this cell (Escape clears)'],
    ['Shift + F11', 'Insert a new sheet'],
    [`${MOD_KEY} + ;`, 'Insert today’s date'],
    [`${MOD_KEY} + Shift + ;`, 'Insert the current time'],
    ['Alt + =', 'AutoSum the numbers above or to the left'],
    ['Shift + F3', 'Insert function (search every function, or ask the AI for one)'],
    ['F3', 'Paste a defined name into the cell or the formula being typed'],
    [`${MOD_KEY} + F3 / ${MOD_KEY} + Shift + F3`, 'Name Manager / Create names from the selection'],
    [`${MOD_KEY} + L`, 'Create a table from the data around the active cell'],
    ['Drag the corner handle', 'Fill down or across'],
    [`${MOD_KEY} + drag the handle`, 'Count a single number up, or repeat a series instead of continuing it'],
    ['Drag the selection border', 'Move the cells (Alt to copy)'],
    ['Drag a selected row or column header', 'Reorder rows or columns'],
    ['Double-click the handle', 'Fill down alongside the data'],
    [`${MOD_KEY} + D / ${MOD_KEY} + R`, 'Fill down / fill right'],
    [`${MOD_KEY} + Enter`, 'Enter into every selected cell'],
  ]],
  ['Format', [
    [`${MOD_KEY} + B`, 'Bold'],
    [`${MOD_KEY} + I`, 'Italic'],
    [`${MOD_KEY} + U`, 'Underline'],
    [`${MOD_KEY} + 5`, 'Strikethrough'],
    [`${MOD_KEY} + Shift + > / <`, 'Larger / smaller font'],
    [`${FMT_KEY} + Shift + 1 / 2 / 3 / 4 / 5 / 6`, 'Number / time / date / currency / percent / scientific format'],
    [`${FMT_KEY} + Shift + ~`, 'Automatic format'],
    [`${FMT_KEY} + Shift + 7`, 'Outline border'],
    [`${FMT_KEY} + Shift + _`, 'Remove borders'],
    ['F4', 'Repeat the last action (in a formula: cycle $ anchors)'],
    ['Shift + F4 / Shift + F5', 'Find the next match / open Find'],
    [`F11 or Alt + F1`, 'Chart the selection'],
    [`${MOD_KEY} + 2 / 3 / 4`, 'Bold / italic / underline'],
    [`${MOD_KEY} + Shift + F`, 'Format cells dialog (number, alignment, font, border, fill)'],
    [`${MOD_KEY} + Shift + L`, 'Create or remove a filter'],
    ['Paint format, then select', 'Copy formatting onto other cells: select them with the pointer, or move there and press Enter (Escape cancels)'],
    [IS_MAC ? `${MOD_KEY} + \` or ⌃ + \`` : `${MOD_KEY} + \``, 'Show formulas instead of values'],
  ]],
  ['File', [
    [`${MOD_KEY} + F`, 'Find'],
    // macOS takes ⌘+H to hide the app before the page sees it; the Shift chord reaches the editor.
    [`${MOD_KEY} + ${IS_MAC ? 'Shift + ' : ''}H`, 'Find and replace'],
    [`${MOD_KEY} + S`, 'Save now'],
    [`${MOD_KEY} + P`, 'Print the sheet'],
    [`${MOD_KEY} + O`, 'Open from Puter'],
  ]],
];

/** Longest token drawn as a key cap; a string with a longer one ("Drag the bar at the corner of the headers") is a gesture, shown as plain text. */
const KEY_CAP_MAX = 16;

/**
 * A shortcut string as nodes: each key in a cap, with the "+", "/", and "or"
 * between them as text ("Tab / Shift + Tab" is three caps and two joiners).
 * The keys pressed together are kept in one unbroken chord, so a narrow
 * column wraps between the alternatives and never leaves "Shift +" at the
 * end of one line with its key on the next.
 */
export function renderKeys(keys) {
  const parts = keys.split(/( \+ | \/ | or )/);
  // A sentence ("Click, then Shift + click, while…") stays one piece of text rather than half caps, half words.
  if (parts.some((part, i) => i % 2 === 0 && part.length > KEY_CAP_MAX)) return [el('span.shortcut-gesture', {}, keys)];
  const out = [];
  let chord = null;
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      if (!chord) out.push(chord = el('span.shortcut-chord'));
      chord.append(el('span.kbd', {}, part));
    } else if (part.trim() === '+') chord.append(el('span.shortcut-join', {}, '+'));
    else { out.push(el('span.shortcut-join', {}, part.trim())); chord = null; }
  });
  return out;
}

export function openShortcuts() {
  const content = el('div.shortcuts', {},
    GROUPS.map(([title, rows]) => el('section.shortcut-group', {},
      el('h3', {}, title),
      el('div.shortcut-list', {}, rows.map(([keys, what]) => el('div.shortcut-row', {},
        el('span.shortcut-what', {}, what),
        el('span.shortcut-keys', {}, renderKeys(keys))))))));
  openModal({ title: 'Keyboard shortcuts', content, wide: true });
}
