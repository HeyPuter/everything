import { textFillColor } from './text-fill.js';
import { UnsupportedDocumentError } from './errors.js';

// A property set can declare both forms when at most one is on (§17.3.2.37 strike, §17.3.2.9 dstrike):
// both off, or one on with the other off. Each pair resolves its two declarations independently.
const combined = { bothStrikeOff: ['singleOff', 'doubleOff'], singleStrikeDoubleOff: ['single', 'doubleOff'], doubleStrikeSingleOff: ['singleOff', 'double'] };
export const strikeDeclarations = value => combined[value] || [value];
export function checkedStrike(value, declaration = false) {
  if (!(declaration ? ['single', 'double', 'singleOff', 'doubleOff', ...Object.keys(combined)] : ['none', 'single', 'double']).includes(value)) throw new UnsupportedDocumentError('invalid strikethrough value');
  return value;
}

// Single strike is a toggle in character styles; double strike is an ordinary
// boolean. Positive declarations choose one visual form. Explicit false clears
// only its own form. A direct editor override of "none" clears either form.
export function resolveStrike(inherited = 'none', declaration, toggle = false, defaultStrike = 'none') {
  if (declaration === undefined) return inherited;
  if (declaration === 'none') return 'none';
  if (combined[declaration]) {
    const [single, double] = combined[declaration].map(value => resolveStrike(inherited, value, toggle, defaultStrike));
    return double === 'double' ? 'double' : single === 'single' ? 'single' : 'none';
  }
  checkedStrike(declaration, true);
  const single = declaration.startsWith('single'), enabled = !declaration.endsWith('Off');
  const kind = single ? 'single' : 'double';
  const on = single && toggle ? (inherited === 'single') !== (enabled !== (defaultStrike === 'single')) : enabled;
  return on ? kind : inherited === kind ? 'none' : inherited;
}

export function strikeSpans(style, metrics, x, width) {
  if (style.textFill === 'none' || !style.strikethrough || style.strikethrough === 'none') return [];
  const thickness = metrics.strikeThickness, top = metrics.strikeOffset;
  const offsets = style.strikethrough === 'double' ? [top - thickness, top + thickness] : [top];
  return offsets.map(offset => ({ x, width, color: textFillColor(style), highlight: style.highlight, shading: style.shading, offset, thickness }));
}
