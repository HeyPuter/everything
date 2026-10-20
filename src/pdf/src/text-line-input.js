import { paragraphLayout } from './paragraph-layout.js';
import { groupLineHeight } from './core/text-group.js';
import { koreanDraftFace } from './text-fonts.js';

/**
 * Pasted or dropped text as a draft takes it: one kind of line break, and tabs (copied tables
 * have them, the text fonts do not) as spaces, as text box comments draw them.
 */
export const draftText = (text) => text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');

/** A native editing surface whose spans retain the source font of each text fragment. */
export function textLineInput(group) {
  const input = document.createElement('div');
  input.contentEditable = 'true';
  input.className = 'page-text-input text-line-input';
  input.setAttribute('role', 'textbox');
  input.setAttribute('aria-label', 'Edit text');
  input.setAttribute('aria-multiline', 'true');
  input.spellcheck = true;
  for (const fragment of group.segments) {
    const span = document.createElement('span');
    span.dataset.part = fragment.part;
    if (fragment.gap) span.dataset.gap = JSON.stringify(fragment.gap);
    span.textContent = fragment.text;
    input.append(span);
  }
  // A terminal newline needs a spare BR for the browser to expose its final caret row.
  if (group.text.endsWith('\n')) input.append(document.createElement('br'));
  function segments(root = input, visit) {
    const output = [];
    const add = (text, part, gap, node) => {
      if (!text) return;
      visit?.({ text, part, gap, node });
      const last = output.at(-1);
      if (last && last.part === part && !last.gap && !gap) last.text += text;
      else output.push({ text, part, ...(gap ? { gap } : {}) });
    };
    // In pre and pre-wrap text the browser ends a break typed at the very end with a second
    // newline character that only holds the caret's empty row (elsewhere a spare BR does
    // that), so one trailing newline of the final text node is the browser's, not a break.
    let tail = root.lastChild;
    while (tail?.nodeType === Node.ELEMENT_NODE && tail.tagName !== 'BR' && tail.lastChild)
      tail = tail.lastChild;
    const placeholder = tail?.nodeType === Node.TEXT_NODE && tail.data.endsWith('\n') ? tail : null;
    const walk = (node, part = 0) => {
      if (node.nodeType === Node.TEXT_NODE) {
        add(node === placeholder ? node.data.slice(0, -1) : node.data, part, undefined, node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.dataset.part !== undefined && group.parts[Number(node.dataset.part)])
        part = Number(node.dataset.part);
      if (node.tagName === 'BR') {
        // Browsers append a spare BR to keep the caret on an otherwise empty final line.
        if (node.nextSibling) add('\n', part);
        return;
      }
      if (node.dataset.gap && node.textContent === ' ') {
        add(' ', part, JSON.parse(node.dataset.gap), node.firstChild);
        return;
      }
      const block = node !== root && ['DIV', 'P'].includes(node.tagName);
      const text = () => output.map((s) => s.text).join('');
      if (block && text() && !text().endsWith('\n')) add('\n', part);
      for (const child of node.childNodes) walk(child, part);
      if (block && node.nextSibling) add('\n', part);
    };
    walk(root);
    return output;
  }
  Object.defineProperty(input, 'value', {
    get: () =>
      segments()
        .map((s) => s.text)
        .join(''),
    set: (text) => {
      input.textContent = text;
      if (text.endsWith('\n')) input.append(document.createElement('br'));
    },
  });
  input.segments = () => segments();
  input.select = () => {
    const range = document.createRange();
    range.selectNodeContents(input);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  if (group.paragraph) {
    input.style.whiteSpace = 'pre-wrap';
    input.style.overflowWrap = 'anywhere';
    input.style.resize = 'none';
    input.style.minWidth = '0';
    input.exportLayout = () => paragraphLayout(input, segments, group);
  }
  input.updateStyle = (hex, size, face) => {
    if (group.paragraph) input.style.lineHeight = `${group.paragraph.leading * size}px`;
    for (const span of input.querySelectorAll('[data-part]')) {
      const run = group.parts[Number(span.dataset.part)];
      const ratio =
        Math.hypot(run.transform[2], run.transform[3]) /
        Math.hypot(group.transform[2], group.transform[3]);
      const fallback = face?.(run) || koreanDraftFace(run, span.textContent);
      Object.assign(span.style, {
        fontFamily: fallback?.family ? `${fallback.family}, sans-serif` : run.fontFamily,
        fontWeight: fallback?.weight || run.fontWeight,
        fontStyle: fallback?.style || run.fontStyle,
        fontVariantLigatures: fallback?.ligatures || run.fontVariantLigatures || 'normal',
        fontSize: `${ratio * size}px`,
        color: hex !== group.fillColor ? hex : run.fillColor,
        letterSpacing: `${(run.state.charSpacing / run.state.size) * ratio * size}px`,
        wordSpacing: `${!face && run.widths.get(' ')?.space ? (run.state.wordSpacing / run.state.size) * ratio * size : 0}px`,
      });
      const gap =
        span.dataset.gap && span.textContent === ' ' ? JSON.parse(span.dataset.gap) : null;
      const t = group.transform;
      Object.assign(span.style, {
        display: gap ? 'inline-block' : '',
        width: gap
          ? `${((gap[0] * t[0] + gap[1] * t[1]) / (t[0] * t[0] + t[1] * t[1])) * size}px`
          : '',
      });
    }
  };
  input.measureLayout = () => {
    if (group.paragraph) return input.exportLayout();
    // Measure an offscreen copy so the real selection and native undo history stay intact.
    // A zero-height inline box identifies the browser's baseline, including larger spans.
    const copy = input.cloneNode(true);
    copy.contentEditable = 'false';
    copy.setAttribute('aria-hidden', 'true');
    copy.removeAttribute('role');
    copy.removeAttribute('aria-label');
    Object.assign(copy.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      transform: 'none',
      visibility: 'hidden',
      pointerEvents: 'none',
      height: 'auto',
      overflow: 'visible',
      resize: 'none',
    });
    const markers = [];
    const marker = () => {
      const span = document.createElement('span');
      span.dataset.lineProbe = '';
      Object.assign(span.style, {
        display: 'inline-block',
        width: '0',
        height: '0',
        padding: '0',
        border: '0',
        verticalAlign: 'baseline',
      });
      markers.push(span);
      return span;
    };
    const start = (node) => {
      let first = node;
      while (
        first.firstChild?.nodeType === Node.ELEMENT_NODE &&
        first.firstChild.tagName !== 'BR' &&
        !first.firstChild.hasAttribute('data-line-probe')
      )
        first = first.firstChild;
      first.prepend(marker());
    };
    const markLines = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const replacement = document.createDocumentFragment();
          child.data.split('\n').forEach((text, index) => {
            if (index) replacement.append(document.createTextNode('\n'));
            if (text) replacement.append(marker(), document.createTextNode(text));
          });
          child.replaceWith(replacement);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName !== 'BR') markLines(child);
        }
      }
    };
    markLines(copy);
    start(copy);
    document.body.append(copy);
    try {
      const top = copy.getBoundingClientRect().top;
      const baselines = markers
        .map((marker) => marker.getBoundingClientRect().top - top)
        .sort((a, b) => a - b)
        .filter((value, index, array) => !index || value - array[index - 1] > 0.1);
      const lines = input.value.split('\n'),
        size = parseFloat(input.style.fontSize),
        leading = groupLineHeight(group, segments());
      const rows = lines.map((text, i) => (text || i === 0 ? i : null)).filter((i) => i !== null);
      let lineOffsets;
      if (rows.length === baselines.length) {
        lineOffsets = new Array(lines.length);
        rows.forEach((row, i) => {
          lineOffsets[row] = (baselines[i] - baselines[0]) / size;
        });
        // Empty rows have no glyphs to measure. Interpolate between their visible neighbors.
        // Probing an empty row can itself introduce the previous fragment's font metrics.
        for (let i = 1; i < rows.length; i++) {
          const first = rows[i - 1],
            last = rows[i];
          for (let row = first + 1; row < last; row++)
            lineOffsets[row] =
              lineOffsets[first] +
              ((lineOffsets[last] - lineOffsets[first]) * (row - first)) / (last - first);
        }
        for (let row = rows.at(-1) + 1; row < lines.length; row++)
          lineOffsets[row] = lineOffsets[row - 1] + leading;
        lineOffsets = lineOffsets.map((measured, i) => {
          const expected = leading * i;
          return Math.abs((measured - expected) * size) < 0.05 ? expected : measured;
        });
      }
      return {
        baseline: baselines[0],
        lineOffsets,
        width: copy.scrollWidth,
        height: copy.scrollHeight,
      };
    } finally {
      copy.remove();
    }
  };
  input.addEventListener('beforeinput', (e) => {
    // Limit rich editing to formatting represented by the PDF spans.
    if (e.inputType.startsWith('format')) e.preventDefault();
    // Native line breaks already have the desired shape. WebKit emits beforeinput
    // for execCommand too, so intercepting insertLineBreak would recursively reinsert it.
    if (e.inputType === 'insertParagraph') {
      e.preventDefault();
      document.execCommand('insertLineBreak');
    }
  });
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, draftText(e.clipboardData.getData('text/plain')));
  });
  let dragging = false;
  input.addEventListener('dragstart', (e) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!input.contains(range.startContainer) || !input.contains(range.endContainer)) return;
    // Native dragging serializes appearance but drops our source-font attributes. Supply
    // the selected DOM with its ancestors so a partial span keeps its PDF font and color.
    let fragment = range.cloneContents();
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    for (; node && node !== input; node = node.parentElement) {
      const copy = node.cloneNode(false);
      copy.append(fragment);
      fragment = copy;
    }
    const wrapper = document.createElement('span');
    // Root text inherits the first PDF run; keep it responsive to later style edits too.
    wrapper.dataset.part = '0';
    const style = getComputedStyle(input);
    Object.assign(wrapper.style, {
      font: style.font,
      color: style.color,
      whiteSpace: style.whiteSpace,
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
    });
    wrapper.append(fragment);
    e.dataTransfer.setData('text/html', wrapper.outerHTML);
    dragging = true;
  });
  input.addEventListener('dragend', () => {
    dragging = false;
  });
  input.addEventListener('drop', (e) => {
    // The browser moves/copies internal selections as one native undo operation.
    if (dragging) return;
    e.preventDefault();
    // Place plain text at the drop caret; never import arbitrary clipboard markup.
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!caret || !input.contains(caret.startContainer)) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(caret);
    // Match paste: Firefox and WebKit otherwise retain CR characters in the draft.
    document.execCommand('insertText', false, draftText(e.dataTransfer.getData('text/plain')));
  });
  return input;
}
