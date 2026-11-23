/** The collapsed range under a point, in browsers with either caret lookup. */
export function caretAt(x, y) {
  const caret = document.caretPositionFromPoint?.(x, y);
  if (caret) {
    const range = document.createRange();
    range.setStart(caret.offsetNode, caret.offset);
    range.collapse(true);
    return range;
  }
  return document.caretRangeFromPoint?.(x, y);
}

/** Place the caret where a click opened an editing surface, without selecting its words. */
export function placeTextCaret(input, { clientX, clientY }) {
  if (input.tagName === 'TEXTAREA') {
    // Textareas hide their text nodes from the caret APIs. A temporary, identically
    // styled text layer lets the browser resolve the glyph, including rotated text.
    const mirror = document.createElement('div');
    mirror.className = input.className;
    mirror.style.cssText = input.style.cssText;
    Object.assign(mirror.style, {
      whiteSpace: 'pre',
      overflow: 'hidden',
      zIndex: '8',
      pointerEvents: 'auto',
    });
    mirror.setAttribute('aria-hidden', 'true');
    mirror.dir = input.dir;
    mirror.textContent = input.value + '\u200b';
    input.after(mirror);
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
    let offset = input.value.length;
    try {
      const range = caretAt(clientX, clientY);
      if (range?.startContainer === mirror.firstChild)
        offset = Math.min(range.startOffset, input.value.length);
    } finally {
      mirror.remove();
    }
    input.setSelectionRange(offset, offset);
    return;
  }
  // A clipped selection handle can still win hit testing at a rounded edge in Firefox.
  // Like the textarea mirror, measure above the handles, then restore the editing layer.
  const zIndex = input.style.zIndex;
  let range;
  try {
    input.style.zIndex = '8';
    range = caretAt(clientX, clientY);
  } finally {
    input.style.zIndex = zIndex;
  }
  if (!range || !input.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A soft-wrapping textarea's value with its wrapped rows as line breaks, read from an
 * identically styled copy: a space the text wrapped at becomes the break.
 */
export function wrappedTextareaValue(input) {
  const style = getComputedStyle(input);
  const mirror = document.createElement('div');
  // Longhands: turning kerning off can leave the computed `font` shorthand empty.
  for (const name of [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'fontStretch',
    'fontKerning',
    'fontVariantLigatures',
    'letterSpacing',
    'wordSpacing',
    'lineHeight',
    'whiteSpace',
    'overflowWrap',
    'wordBreak',
    'tabSize',
    'direction',
  ])
    mirror.style[name] = style[name];
  Object.assign(mirror.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${input.clientWidth}px`,
    padding: style.padding,
    boxSizing: 'content-box',
    visibility: 'hidden',
  });
  mirror.setAttribute('aria-hidden', 'true');
  const node = document.createTextNode(input.value);
  mirror.append(node);
  document.body.append(mirror);
  try {
    const range = document.createRange();
    const value = input.value;
    let output = '',
      top = null;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '\n') {
        output += char;
        top = null;
        continue;
      }
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getClientRects()[0];
      if (rect && top !== null && rect.top - top > rect.height / 2) {
        // A space hanging at the end of the wrapped row is the break itself.
        if (output.endsWith(' ')) output = output.trimEnd();
        output += '\n';
      }
      if (rect) top = rect.top;
      output += char;
    }
    return output;
  } finally {
    mirror.remove();
  }
}
