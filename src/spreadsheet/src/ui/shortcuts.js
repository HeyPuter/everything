import { el } from './dom.js';
import { openModal } from './modal.js';
import { MOD_KEY, IS_MAC } from './dom.js';
import { t, tSource } from '../i18n/index.js';

// macOS takes ⌘+Shift+3, 4, 5 and 6 for screenshots before the page sees them, so on a Mac the number-format and border chords go with Control.
const FMT_KEY = IS_MAC ? '⌃' : MOD_KEY;

// Each row: [keys, what it does]. The keys are written as the key caps show them, joined by " + " (pressed
// together), " / " and " or " (alternatives); a row whose keys hold words (a gesture, "Arrow keys") names a
// message instead: words({ key, values }). What it does is a message key, or words(…) for one with values.
// The table holds keys, not text: t() is called when the panel is drawn, in the language loaded by then.
const words = (key, values) => ({ key, values });
const mod = { mod: MOD_KEY };

const GROUPS = [
  ['shortcuts.group.navigate', [
    ['F6 / Shift + F6', 'shortcuts.what.nextArea'],
    ['Alt or F10', 'shortcuts.what.keyTips'],
    [`${MOD_KEY} + F1`, 'shortcuts.what.toggleRibbon'],
    [`${MOD_KEY} + Shift + U`, 'shortcuts.what.formulaBar'],
    [words('shortcuts.keys.arrowKeys'), 'shortcuts.what.moveActiveCell'],
    [words('shortcuts.keys.shiftArrow'), 'shortcuts.what.extendSelection'],
    [words('shortcuts.keys.modArrow', mod), 'shortcuts.what.jumpToEdge'],
    ['Tab / Shift + Tab', 'shortcuts.what.moveRightLeft'],
    ['Enter / Shift + Enter', 'shortcuts.what.moveDownUp'],
    [`${MOD_KEY} + Home`, 'shortcuts.what.goToA1'],
    [`${MOD_KEY} + G or F5`, 'shortcuts.what.goTo'],
    [`${MOD_KEY} + Backspace`, 'shortcuts.what.scrollToActiveCell'],
    [`${MOD_KEY} + Shift + P or Alt + /`, 'shortcuts.what.searchMenus'],
    [`${MOD_KEY} + J`, 'shortcuts.what.aiAssistant'],
    ['Page Up / Page Down', 'shortcuts.what.scrollUpDown'],
    ['Alt + Page Up / Alt + Page Down', 'shortcuts.what.scrollLeftRight'],
    // Browsers keep Ctrl+PgUp/PgDn for their own tabs on Windows and Linux, so the Alt chords come first.
    ['Alt + → / Alt + ←', IS_MAC ? 'shortcuts.what.nextSheetMac' : words('shortcuts.what.nextSheet', mod)],
    [words('shortcuts.keys.endThenArrow'), 'shortcuts.what.endMode'],
    ['F8 / Shift + F8', 'shortcuts.what.extendOrAdd'],
    ['Shift + Backspace', 'shortcuts.what.selectActiveCellOnly'],
    [`${MOD_KEY} + .`, 'shortcuts.what.nextCorner'],
    ['Alt + ;', 'shortcuts.what.selectVisibleCells'],
    [`${MOD_KEY} + \\ / ${MOD_KEY} + Shift + |`, 'shortcuts.what.selectDifferences'],
    [`${MOD_KEY} + Shift + { / }`, 'shortcuts.what.selectPrecedentsDependents'],
    [`${MOD_KEY} + A or ${MOD_KEY} + Shift + Space`, 'shortcuts.what.selectAll'],
    [words('shortcuts.keys.modClick', mod), 'shortcuts.what.addToSelection'],
    ['Shift + Space', 'shortcuts.what.selectRow'],
    [`${MOD_KEY} + Shift + 8`, 'shortcuts.what.selectCurrentRegion'],
    // macOS takes ⌘+Space (Spotlight) and ⌘+` (next window) before the page sees them, so there Control serves as well.
    [IS_MAC ? `${MOD_KEY} + Space or ⌃ + Space` : `${MOD_KEY} + Space`, 'shortcuts.what.selectColumn'],
    [words('shortcuts.keys.dragFreezeBar'), 'shortcuts.what.freezeByDragging'],
    // Floating objects: the grid selects and moves them from the keyboard.
    [`${MOD_KEY} + Alt + O`, 'shortcuts.what.selectNextObject'],
    [words('shortcuts.keys.arrowKeysOrShiftArrow'), words('shortcuts.what.nudgeObject', mod)],
    [`${MOD_KEY} + D`, 'shortcuts.what.duplicateObject'],
  ]],
  ['shortcuts.group.edit', [
    [words('shortcuts.keys.type'), 'shortcuts.what.replaceContents'],
    [IS_MAC ? 'F2 or ⌃ + U' : 'F2', 'shortcuts.what.editInPlace'],
    [words('shortcuts.keys.f2WhileTyping'), 'shortcuts.what.switchEnterEditMode'],
    ['Shift + F2', 'shortcuts.what.note'],
    [`${MOD_KEY} + K`, 'shortcuts.what.link'],
    [words('shortcuts.keys.modClick', mod), 'shortcuts.what.openLink'],
    ['Alt + Down', 'shortcuts.what.openDropdown'],
    ['Shift + F10 or Menu', 'shortcuts.what.openMenu'],
    [words('shortcuts.keys.doubleClickDateCell'), 'shortcuts.what.pickDate'],
    ['Space', 'shortcuts.what.toggleCheckbox'],
    ['Escape', 'shortcuts.what.cancelEdit'],
    ['Alt + Enter', 'shortcuts.what.newLine'],
    [words('shortcuts.keys.arrowsAfterOperator'), 'shortcuts.what.pickReference'],
    [words('shortcuts.keys.clickThenShiftClick'), words('shortcuts.what.pickRange', mod)],
    [words('shortcuts.keys.clickOtherSheetTab'), 'shortcuts.what.pickOnOtherSheet'],
    ['F4', 'shortcuts.what.cycleAnchors'],
    [`${MOD_KEY} + Shift + =`, 'shortcuts.what.insertRows'],
    [`${MOD_KEY} + -`, 'shortcuts.what.deleteRows'],
    [`${MOD_KEY} + 9 / ${MOD_KEY} + 0`, 'shortcuts.what.hideRowsColumns'],
    ['Alt + Shift + Right / Left', 'shortcuts.what.groupUngroup'],
    [`${MOD_KEY} + Shift + 9 / 0`, 'shortcuts.what.unhideRowsColumns'],
    ['Delete / Backspace', 'shortcuts.what.clearContents'],
    [`${MOD_KEY} + Z`, 'shortcuts.what.undo'],
    [`${MOD_KEY} + Shift + Z`, 'shortcuts.what.redo'],
    [`${MOD_KEY} + C / X / V`, 'shortcuts.what.copyCutPaste'],
    [`${MOD_KEY} + Shift + V`, 'shortcuts.what.pasteValues'],
    [`${MOD_KEY} + Alt + V`, 'shortcuts.what.pasteSpecial'],
    [`${MOD_KEY} + '`, 'shortcuts.what.copyFormulaAbove'],
    [`${MOD_KEY} + Shift + "`, 'shortcuts.what.copyValueAbove'],
    ['F9', 'shortcuts.what.recalculate'],
    [`${MOD_KEY} + [ / ${MOD_KEY} + ]`, 'shortcuts.what.highlightReferences'],
    ['Shift + F11', 'shortcuts.what.newSheet'],
    [`${MOD_KEY} + ;`, 'shortcuts.what.insertDate'],
    [`${MOD_KEY} + Shift + ;`, 'shortcuts.what.insertTime'],
    ['Alt + =', 'shortcuts.what.autoSum'],
    ['Shift + F3', 'shortcuts.what.insertFunction'],
    ['F3', 'shortcuts.what.pasteName'],
    [`${MOD_KEY} + F3 / ${MOD_KEY} + Shift + F3`, 'shortcuts.what.nameManager'],
    [`${MOD_KEY} + L`, 'shortcuts.what.createTable'],
    [words('shortcuts.keys.dragCornerHandle'), 'shortcuts.what.fillDownOrAcross'],
    [words('shortcuts.keys.modDragHandle', mod), 'shortcuts.what.countUpOrRepeat'],
    [words('shortcuts.keys.dragSelectionBorder'), 'shortcuts.what.moveCells'],
    [words('shortcuts.keys.dragHeader'), 'shortcuts.what.reorder'],
    [words('shortcuts.keys.doubleClickHandle'), 'shortcuts.what.fillAlongside'],
    [`${MOD_KEY} + D / ${MOD_KEY} + R`, 'shortcuts.what.fillDownRight'],
    [`${MOD_KEY} + Enter`, 'shortcuts.what.enterIntoSelection'],
  ]],
  ['shortcuts.group.format', [
    [`${MOD_KEY} + B`, 'shortcuts.what.bold'],
    [`${MOD_KEY} + I`, 'shortcuts.what.italic'],
    [`${MOD_KEY} + U`, 'shortcuts.what.underline'],
    [`${MOD_KEY} + 5`, 'shortcuts.what.strikethrough'],
    [`${MOD_KEY} + Shift + > / <`, 'shortcuts.what.fontSize'],
    [`${FMT_KEY} + Shift + 1 / 2 / 3 / 4 / 5 / 6`, 'shortcuts.what.numberFormats'],
    [`${FMT_KEY} + Shift + ~`, 'shortcuts.what.automaticFormat'],
    [`${FMT_KEY} + Shift + 7`, 'shortcuts.what.outlineBorder'],
    [`${FMT_KEY} + Shift + _`, 'shortcuts.what.removeBorders'],
    ['F4', 'shortcuts.what.repeat'],
    ['Shift + F4 / Shift + F5', 'shortcuts.what.findNext'],
    [`F11 or Alt + F1`, 'shortcuts.what.chartSelection'],
    [`${MOD_KEY} + 2 / 3 / 4`, 'shortcuts.what.boldItalicUnderline'],
    [`${MOD_KEY} + Shift + F`, 'shortcuts.what.formatCells'],
    [`${MOD_KEY} + Shift + L`, 'shortcuts.what.filter'],
    [`Alt + F5 / ${MOD_KEY} + Alt + F5`, 'shortcuts.what.refresh'],
    [words('shortcuts.keys.paintThenSelect'), 'shortcuts.what.paintFormat'],
    [IS_MAC ? `${MOD_KEY} + \` or ⌃ + \`` : `${MOD_KEY} + \``, 'shortcuts.what.showFormulas'],
  ]],
  ['shortcuts.group.file', [
    [`${MOD_KEY} + F`, 'shortcuts.what.find'],
    // macOS takes ⌘+H to hide the app before the page sees it; the Shift chord reaches the editor.
    [`${MOD_KEY} + ${IS_MAC ? 'Shift + ' : ''}H`, 'shortcuts.what.findReplace'],
    [`${MOD_KEY} + S`, 'shortcuts.what.save'],
    [`${MOD_KEY} + P`, 'shortcuts.what.print'],
    [`${MOD_KEY} + O`, 'shortcuts.what.openFromPuter'],
  ]],
];

/** Longest token drawn as a key cap; a string with a longer one ("Drag the bar at the corner of the headers") is a gesture, shown as plain text. */
const KEY_CAP_MAX = 16;

const JOINERS = / \+ | \/ | or /;

/**
 * Whether keys written in English are a gesture described in words rather than keys to press. Read on the
 * English, so a gesture is drawn the same in every language (a Chinese sentence is short enough for a cap).
 */
const isGesture = (keys) => keys.split(JOINERS).some((part) => part.length > KEY_CAP_MAX);

/**
 * A shortcut string as nodes: each key in a cap, with the "+", "/", and "or"
 * between them as text ("Tab / Shift + Tab" is three caps and two joiners).
 * The keys pressed together are kept in one unbroken chord, so a narrow
 * column wraps between the alternatives and never leaves "Shift +" at the
 * end of one line with its key on the next. `gesture` says the string is a
 * gesture described in words, drawn as text; by default it is read from the
 * string itself, which is English.
 */
export function renderKeys(keys, { gesture = isGesture(keys) } = {}) {
  // A sentence ("Click, then Shift + click, while…") stays one piece of text rather than half caps, half words.
  if (gesture) return [el('span.shortcut-gesture', {}, keys)];
  const or = t('shortcuts.or');
  const parts = keys.split(or === 'or' ? /( \+ | \/ | or )/ : new RegExp(`( \\+ | / | or | ${or.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} )`));
  const out = [];
  let chord = null;
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      if (!chord) out.push(chord = el('span.shortcut-chord'));
      chord.append(el('span.kbd', {}, part));
    } else if (part.trim() === '+') chord.append(el('span.shortcut-join', {}, '+'));
    else { out.push(el('span.shortcut-join', {}, part.trim() === '/' ? '/' : or)); chord = null; }
  });
  return out;
}

/** A row's keys as nodes: written out, or a message (words(…)) whose English says whether it is a gesture. */
function keysOf(keys) {
  if (typeof keys === 'string') return renderKeys(keys);
  return renderKeys(t(keys.key, keys.values), { gesture: isGesture(tSource(keys.key, keys.values)) });
}

const textOf = (what) => (typeof what === 'string' ? t(what) : t(what.key, what.values));

export function openShortcuts() {
  const content = el('div.shortcuts', {},
    GROUPS.map(([title, rows]) => el('section.shortcut-group', {},
      el('h3', {}, t(title)),
      el('div.shortcut-list', {}, rows.map(([keys, what]) => el('div.shortcut-row', {},
        el('span.shortcut-what', {}, textOf(what)),
        el('span.shortcut-keys', {}, keysOf(keys))))))));
  openModal({ title: t('shortcuts.title'), content, wide: true });
}
