import { announce } from '../ui/toast.js';
import { styleDisplayName } from '../lib/style-names.js';

/**
 * What a formatting key did, said to screen readers ("Bold on", "Centered", "Heading 1"): the document's text field
 * shows the text, not its formatting, so Cmd+B, Cmd+E or Cmd+Option+1 changed the document without a word.
 *
 * The words come from the changes the key's command made (the model notes each one in `formatChanges` while the
 * announcer listens), not from reading the selection's formatting before and after: over a Select All of a long
 * document that read took several milliseconds each time.
 */

const ALIGNMENTS = { left: 'Aligned left', center: 'Centered', right: 'Aligned right', both: 'Justified', distribute: 'Distributed', thaiDistribute: 'Distributed' };
const UNDERLINES = { none: 'Underline off', double: 'Double underline on', words: 'Words underline on' };
const MIXED = Symbol('mixed');

const points = value => `${Math.round(value * 10) / 10} point`;

/** The words for formatting changes ({ run }, { paragraph }, { style }, { list }), or '' when they say nothing. */
export function describeChanges(changes, styles = null) {
  if (!changes?.length) return '';
  const style = changes.findLast(change => 'style' in change);
  // A new paragraph style brings its own formatting along: its name says it all.
  if (style) return styleDisplayName(styles?.definitions?.[style.style]?.name || style.style || '');
  const values = {};
  for (const change of changes) for (const [key, value] of Object.entries(change.run || change.paragraph || {})) {
    values[key] = key in values && values[key] !== value ? MIXED : value;
  }
  const list = changes.findLast(change => 'list' in change);
  const has = key => key in values && values[key] !== MIXED && values[key] !== undefined;
  const parts = [];
  if (has('bold')) parts.push(`Bold ${values.bold ? 'on' : 'off'}`);
  if (has('italic')) parts.push(`Italic ${values.italic ? 'on' : 'off'}`);
  if (has('underlineStyle')) parts.push(UNDERLINES[values.underlineStyle] || 'Underline on');
  if (has('strikethrough')) parts.push(`Strikethrough ${values.strikethrough === 'none' ? 'off' : 'on'}`);
  if (has('capitalization')) parts.push(values.capitalization === 'caps' ? 'All caps on' : values.capitalization === 'smallCaps' ? 'Small caps on' : 'Caps off');
  if (has('verticalAlign')) parts.push(values.verticalAlign === 'superscript' ? 'Superscript on' : values.verticalAlign === 'subscript' ? 'Subscript on' : 'Superscript and subscript off');
  if (has('fontSize')) parts.push(points(values.fontSize));
  else if (values.fontSize === MIXED) parts.push('Font size changed');
  if (has('alignment')) parts.push(ALIGNMENTS[values.alignment] || values.alignment);
  if (list) parts.push(list.list === 'bullet' ? 'Bulleted list' : list.list === 'number' ? 'Numbered list' : 'List off');
  if (has('lineSpacing') && (values.lineRule ?? 'auto') === 'auto') parts.push(`Line spacing ${values.lineSpacing}`);
  if (has('spaceBefore')) parts.push(`Space before ${points(values.spaceBefore)}`);
  if (has('indentLeft') && !list) parts.push(`Indent ${Math.round(values.indentLeft / 1440 * 100) / 100} inch`);
  return parts.join(', ');
}

// Chords that move, select, copy or undo: what they do is not a formatting change to name.
// With Shift most letters are formatting (Cmd+Shift+X strikethrough, A all caps, K small caps); not redo or paste.
const NOT_FORMATTING = new Set(['KeyZ', 'KeyY', 'KeyV', 'Enter', 'Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const UNSHIFTED = new Set(['KeyA', 'KeyC', 'KeyX', 'KeyS', 'KeyF', 'KeyH', 'KeyG', 'KeyK', 'KeyP', 'KeyO', 'KeyN', 'KeyD', 'Slash', 'Comma']);
const MODIFIERS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS']);

/**
 * Listen on `root` for formatting chords typed in the document (`editor()`'s text field) and say what they changed,
 * once the keys' own handlers have run. A held key says nothing more, and a new announcement replaces the last.
 */
export function attachFormatAnnouncer(root, editor, { say = announce } = {}) {
  let spoken = null;
  const listener = e => {
    const engine = editor();
    if (!engine || e.target !== engine.input || !(e.ctrlKey || e.metaKey) || e.repeat || e.isComposing || NOT_FORMATTING.has(e.code) || !e.shiftKey && UNSHIFTED.has(e.code) || MODIFIERS.has(e.key)) return;
    const model = engine.model, changes = [];
    model.formatChanges = changes;
    setTimeout(() => {
      if (model.formatChanges === changes) delete model.formatChanges;
      if (engine !== editor() || engine.destroyed || engine.model !== model) return;
      const message = describeChanges(changes, model.styles);
      if (!message) return;
      spoken?.remove?.();
      spoken = say(message);
    });
  };
  root.addEventListener('keydown', listener, true);
  return () => root.removeEventListener('keydown', listener, true);
}
