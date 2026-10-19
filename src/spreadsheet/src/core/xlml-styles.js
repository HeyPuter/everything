/**
 * Cell formatting in an Excel 2003 XML spreadsheet (SpreadsheetML 2003, the .xml "XML Spreadsheet" many
 * reporting tools and older exports still write): a <Style>'s Font, Interior, Alignment and Borders,
 * given as the table-cell properties an .ods style carries, so that odsCellStyle reads both alike.
 *
 * `chain` is the cell's style and then its ss:Parent styles, each as the reader parsed it: its attributes
 * without their ss: prefix, with Font, Interior and Alignment as the attributes of those elements and
 * Borders as the list of its <Border> elements. The nearest style's setting wins.
 */
const HEX = /^#[\da-f]{6}$/i;
// Excel's border weights (1 thin, 2 medium, 3 thick; 0 a hairline) as the widths LibreOffice writes for them.
const WIDTH = ['0.5pt', '0.74pt', '1.76pt', '2.49pt'];
const LINE = { Continuous: 'solid', Dash: 'dashed', DashDot: 'dashed', DashDotDot: 'dashed', SlantDashDot: 'dashed', Dot: 'dotted', Double: 'double' };
const SIDE = { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' };
const on = (value) => value === '1' || String(value).toLowerCase() === 'true';

function styleProps(style) {
  const props = {};
  const font = style.Font || {};
  if (on(font.Bold)) props['font-weight'] = 'bold';
  if (on(font.Italic)) props['font-style'] = 'italic';
  if (font.Underline && font.Underline !== 'None') {
    props['text-underline-style'] = 'solid';
    if (/^Double/.test(font.Underline)) props['text-underline-type'] = 'double';
  }
  if (on(font.StrikeThrough)) props['text-line-through-style'] = 'solid';
  if (HEX.test(font.Color || '')) props.color = font.Color;
  if (Number(font.Size) > 0) props['font-size'] = `${Number(font.Size)}pt`;
  if (font.FontName) props['font-family'] = font.FontName;
  const fill = style.Interior || {};
  if (HEX.test(fill.Color || '') && fill.Pattern && fill.Pattern !== 'None') props['background-color'] = fill.Color;
  const align = style.Alignment || {};
  const horizontal = { Left: 'start', Center: 'center', CenterAcrossSelection: 'center', Right: 'end' }[align.Horizontal];
  if (horizontal) props['text-align'] = horizontal;
  const vertical = { Top: 'top', Center: 'middle', Bottom: 'bottom' }[align.Vertical];
  if (vertical) props['vertical-align'] = vertical;
  if (on(align.WrapText)) props['wrap-option'] = 'wrap';
  if (on(align.ShrinkToFit)) props['shrink-to-fit'] = 'true';
  if (Number(align.Rotate)) props['rotation-angle'] = String((Number(align.Rotate) + 360) % 360);
  for (const border of style.Borders || []) {
    const side = SIDE[border.Position], line = LINE[border.LineStyle];
    if (!side || !line) continue;
    const weight = Math.max(0, Math.min(3, Math.round(Number(border.Weight ?? 1)) || 0));
    props[`border-${side}`] = `${line === 'double' ? '2.01pt' : WIDTH[weight]} ${line} ${HEX.test(border.Color || '') ? border.Color : '#000000'}`;
  }
  return props;
}

/**
 * The table-cell properties for a cell's style chain (nearest first), or null when they say nothing. What
 * the workbook's Default style says too (Excel repeats its font in every style) is left to the sheet's
 * defaults, so a styled cell differs from an unstyled one only where its style does.
 */
export function xlmlCellProps(chain, defaults = null) {
  const props = {}, base = defaults ? styleProps(defaults) : {};
  for (const style of chain) for (const [key, value] of Object.entries(styleProps(style))) if (!(key in props)) props[key] = value;
  for (const key of Object.keys(props)) if (base[key] === props[key]) delete props[key];
  return Object.keys(props).length ? props : null;
}
