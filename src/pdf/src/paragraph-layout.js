/** Read the browser's soft wrapping without changing the editable DOM or its undo history. */
// A nondefault kerning/ligature setting can make the computed `font` shorthand empty.
const canvasFont = (style) =>
  `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

export function paragraphLayout(input, read, group) {
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
    height: 'auto',
    visibility: 'hidden',
    pointerEvents: 'none',
    overflow: 'visible',
    resize: 'none',
  });
  document.body.append(copy);
  try {
    const chunks = [];
    read(copy, (chunk) => chunks.push(chunk));
    const top = copy.getBoundingClientRect().top,
      size = parseFloat(copy.style.fontSize),
      measure = document.createElement('canvas').getContext('2d');
    const fragments = [],
      baselines = [];
    const softBreaks = [];
    let length = 0,
      row = 0,
      font = '';
    const add = (text, part, gap) => {
      length += text.length;
      const last = fragments.at(-1);
      if (last && last.part === part && !last.gap && !gap) last.text += text;
      else fragments.push({ text, part, ...(gap ? { gap } : {}) });
    };
    for (const chunk of chunks) {
      const node = chunk.node;
      let ascent, range;
      if (node) {
        const style = getComputedStyle(
          node.nodeType === Node.TEXT_NODE ? node.parentElement : node,
        );
        const nextFont = canvasFont(style);
        if (font !== nextFont) {
          font = nextFont;
          measure.font = font;
        }
        // A raised or lowered span (a superscript) is measured from the line's own baseline.
        ascent =
          (measure.measureText('Mg').fontBoundingBoxAscent ?? parseFloat(style.fontSize) * 0.9) +
          (parseFloat(style.verticalAlign) || 0);
        range = document.createRange();
      }
      let offset = 0;
      for (const char of chunk.text) {
        if (char === '\n') {
          add(char, chunk.part);
          row++;
          offset++;
          continue;
        }
        if (!node) throw new Error('The paragraph layout could not be read. Select it again.');
        if (node.nodeType === Node.TEXT_NODE) {
          range.setStart(node, offset);
          range.setEnd(node, offset + char.length);
        } else range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        const baseline = rect.top - top + ascent;
        if (baselines[row] !== undefined && baseline - baselines[row] > size * 0.5) {
          softBreaks.push(length);
          add('\n', chunk.part);
          row++;
        }
        baselines[row] ??= baseline;
        add(char, chunk.part, chunk.gap);
        offset += char.length;
      }
    }
    measure.font = canvasFont(getComputedStyle(copy));
    const metrics = measure.measureText('Mg'),
      leading = group.paragraph.leading * size;
    const first =
      baselines[0] ??
      metrics.fontBoundingBoxAscent +
        (leading - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
    const lineOffsets = Array.from(
      { length: row + 1 },
      (_, i) => (baselines[i] ?? first + i * leading) - first,
    ).map((y) => y / size);
    const text = fragments.map((s) => s.text).join('');
    return {
      text,
      softBreaks,
      segments: fragments,
      lineOffsets,
      baseline: first,
      width: copy.scrollWidth,
      height: copy.scrollHeight,
    };
  } finally {
    copy.remove();
  }
}
