import { isComposing, MOD_KEY, shortcutCode } from '../ui/dom.js';
import { moveParagraphs } from '../engine/home-editing.js';
import { openGoTo } from './go-to.js';

const MAC = MOD_KEY === 'Cmd';
const INCH = 1440;

/**
 * Conventional paragraph and navigation chords that the ribbon has no button for. A chord whose Cmd form the
 * browser or the system reserves on a Mac (Cmd+Q, M, T, N, W) uses Control there.
 */
export function keyboardShortcuts({ editor, pkg, applyStyleLevel, focusFont, focusSize }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  let goTo = null;
  const paragraph = action => () => { const engine = ready(); if (!engine) return; engine.finishComposition(); action(engine); engine.focus(); };
  const format = () => editor()?.model.paragraphFormatting || {};
  const toggleUnderline = style => paragraph(engine => engine.setRunFormat({ underlineStyle: engine.model.runFormatting.underlineStyle === style ? 'none' : style }));
  const setGeometry = patch => paragraph(engine => engine.setParagraphGeometry(patch));

  function action(e) {
    const ctrl = e.ctrlKey && !e.metaKey, mod = e.ctrlKey || e.metaKey, code = shortcutCode(e);
    // Chords typed with Control everywhere; on Windows and Linux that is also the modifier.
    const control = MAC ? ctrl : e.ctrlKey;
    if (e.key === 'F5' && !mod && !e.altKey && !e.shiftKey || !MAC && mod && !e.altKey && !e.shiftKey && code === 'KeyG') return () => {
      const engine = editor(); if (!engine || goTo) return;
      engine.finishComposition();
      goTo = openGoTo(engine, { onClose: () => { goTo = null; queueMicrotask(() => editor()?.focus()); } });
    };
    // Move paragraphs: Alt+Shift+Up/Down, and Control+Shift+Up/Down on a Mac, where Option+Shift+Up/Down
    // extends the selection by paragraph as in every Mac text field.
    const moveChord = MAC ? e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey : e.altKey && e.shiftKey && !mod;
    if (moveChord && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      return paragraph(engine => engine.execute(() => moveParagraphs(engine.model, e.key === 'ArrowUp' ? -1 : 1)));
    }
    if (mod && !e.altKey && !e.shiftKey && ['Digit1', 'Digit2', 'Digit5'].includes(code)) {
      const lines = { Digit1: 1, Digit2: 2, Digit5: 1.5 }[code];
      return paragraph(engine => engine.setParagraphFormat({ lineSpacing: lines, lineRule: 'auto' }));
    }
    if (mod && !e.altKey && !e.shiftKey && code === 'Digit0') {
      // Ctrl+0 adds or removes 12 pt of space before the paragraph.
      return paragraph(engine => engine.setParagraphFormat({ spaceBefore: (format().spaceBefore ?? 0) > 0 ? 0 : 12 }));
    }
    if (!control || e.altKey) return null;
    if (!e.shiftKey && code === 'KeyQ') return paragraph(engine => engine.clearDirectParagraphFormatting());
    if (code === 'KeyM') {
      const left = format().indentLeft;
      if (left === null || left === undefined) return null;
      // Ctrl+M and Ctrl+Shift+M step the left indent to the next or previous half inch.
      const next = e.shiftKey ? Math.max(0, Math.ceil(left / (INCH / 2)) * (INCH / 2) - INCH / 2) : Math.floor(left / (INCH / 2)) * (INCH / 2) + INCH / 2;
      return setGeometry({ indentLeft: next });
    }
    if (code === 'KeyT') {
      const { indentLeft: left, firstLine } = format();
      if (left === null || left === undefined || firstLine === null || firstLine === undefined) return null;
      // Ctrl+T makes or deepens a hanging indent by half an inch, keeping the first line in place; Ctrl+Shift+T reverses it.
      const step = e.shiftKey ? -INCH / 2 : INCH / 2;
      if (e.shiftKey && firstLine >= 0) return null;
      return setGeometry({ indentLeft: Math.max(0, left + step), firstLine: Math.min(0, firstLine - step) });
    }
    if (e.shiftKey && code === 'KeyN') return () => applyStyleLevel(0);
    if (e.shiftKey && code === 'KeyD') return toggleUnderline('double');
    if (e.shiftKey && code === 'KeyW') return toggleUnderline('words');
    if (e.shiftKey && code === 'KeyF') return focusFont;
    if (e.shiftKey && code === 'KeyP') return focusSize;
    return null;
  }

  return function onKeydown(e) {
    if (e.defaultPrevented || isComposing(e) || !e.target?.matches?.('.canvas-input')) return;
    const run = action(e);
    if (!run) return;
    e.preventDefault(); e.stopPropagation();
    run();
  };
}
