// Section line numbering (w:lnNumType, ECMA-376 §17.6.8) and its per-paragraph
// suppression (w:suppressLineNumbers, §17.3.1.34). This module validates the
// section setting and turns a finished body layout into margin labels. It does
// not paginate, paint or serialize.
import { paragraphFormat } from './model.js';
import { runFormat } from './formatting.js';
import { styleRun } from './styles.js';
import { AUTO_LINE_NUMBER_DISTANCE } from './line-number-settings.js';
export { LINE_NUMBER_RESTARTS, AUTO_LINE_NUMBER_DISTANCE, checkedLineNumbers } from './line-number-settings.js';


/** The character formatting of line numbers: the "Line Number" character style over the default paragraph style. */
export function lineNumberStyle(styles) {
  if (!styles?.definitions) return runFormat({});
  const base = styles.defaultParagraph ? styleRun(styles, styles.defaultParagraph) : styles.defaults.run;
  const id = Object.keys(styles.definitions).find(key => {
    const s = styles.definitions[key];
    return s?.type === 'character' && String(s.name || '').toLowerCase() === 'line number';
  });
  const run = id ? styleRun(styles, id, base, 'character') : base;
  const format = runFormat(run);
  return { ...format, fontFamily: format.fontAscii, underline: false, underlineStyle: 'none', strikethrough: 'none', highlight: 'none', shading: 'auto', verticalAlign: 'baseline', baselineShift: 0 };
}

/**
 * Margin labels for a body layout: [{ page, x, baseline, text, width, style }], x being
 * the label's left edge. Body lines of sections with line numbering count in reading
 * order (page, region, column, then position). Table cells, framed paragraphs, page
 * stories, virtual boundary lines and suppressed paragraphs are not counted.
 */
export function lineNumberLabels(layout, paragraphs, numbering, styles, measure) {
  if (!layout?.pageRegions?.some(regions => regions?.some(region => region.geometry?.lineNumbers))) return [];
  const byId = new Map(paragraphs.map(p => [p.id, p]));
  const suppressed = new Map();
  const isSuppressed = p => {
    if (!suppressed.has(p.id)) { let value = false; try { value = !!paragraphFormat(p, numbering).suppressLineNumbers; } catch { value = !!p.format?.suppressLineNumbers; } suppressed.set(p.id, value); }
    return suppressed.get(p.id);
  };
  const entries = [];
  for (const line of layout.lines) {
    if (line.virtual || line.frameId || line.pageStory || !line.paragraphId) continue;
    const region = layout.pageRegions[line.page]?.[line.region ?? 0];
    const settings = region?.geometry?.lineNumbers;
    if (!settings) continue;
    const p = byId.get(line.paragraphId);
    if (!p || p.cellId || isSuppressed(p)) continue;
    entries.push({ line, region, settings, section: region.section ?? 0 });
  }
  entries.sort((a, b) => a.line.page - b.line.page || (a.line.region ?? 0) - (b.line.region ?? 0) || (a.line.column ?? 0) - (b.line.column ?? 0) || a.line.y - b.line.y);
  const style = lineNumberStyle(styles), widths = new Map();
  const widthOf = text => { if (!widths.has(text)) widths.set(text, measure ? measure(text, style).width : text.length * (style.fontSize ?? 12) * 0.6); return widths.get(text); };
  const labels = [];
  let count = 0, previous = null;
  for (const entry of entries) {
    const { line, region, settings, section } = entry;
    const restart = !previous
      || settings.restart === 'newPage' && line.page !== previous.line.page
      || settings.restart === 'newSection' && section !== previous.section;
    if (restart) count = settings.start;
    count++;
    previous = entry;
    if (count % settings.countBy) continue;
    const geometry = region.geometry;
    const columns = geometry.columns?.count > 1;
    const automatic = columns ? Math.min(AUTO_LINE_NUMBER_DISTANCE, Math.max(90, (geometry.columns.space ?? 720) / 2)) : AUTO_LINE_NUMBER_DISTANCE;
    const distance = (settings.distance ?? automatic) / 15;
    const text = String(count), width = widthOf(text);
    const textLeft = line.columnLeft ?? geometry.left;
    labels.push({ page: line.page, x: textLeft - distance - width, baseline: line.baseline, text, width, style });
  }
  return labels;
}
