/**
 * Accessibility checks over the document model. Each rule returns issues
 * { rule, severity: 'error'|'warning'|'tip', title, detail, start, end, fix? } where start/end are
 * document positions for Go To and `fix` names a quick fix the pane can apply. Original rules,
 * informed by WCAG 2.1 (contrast ratios per §1.4.3, relative luminance per its definition).
 */

export const RULES = {
  altText: { severity: 'error', title: 'Missing alternative text', why: 'Screen readers announce a picture by its description. Without one, its meaning is lost.' },
  tableHeader: { severity: 'error', title: 'Table has no header row', why: 'A header row tells assistive technology what each column holds.' },
  lowContrast: { severity: 'error', title: 'Low text contrast', why: 'Text that barely stands out from its background is hard to read for many people.' },
  hardColors: { severity: 'warning', title: 'Hard-to-read highlight', why: 'The highlight or shading makes the text color hard to distinguish.' },
  headingOrder: { severity: 'warning', title: 'Skipped heading level', why: 'Headings that skip levels make the outline hard to follow.' },
  mergedCells: { severity: 'warning', title: 'Merged or split table cells', why: 'Merged cells change the grid that screen readers use to announce position.' },
  blankRows: { severity: 'warning', title: 'Blank table row', why: 'Empty rows used for spacing read as missing data.' },
  emptyParagraphs: { severity: 'tip', title: 'Empty paragraphs used for spacing', why: 'Use paragraph spacing instead of blank lines; screen readers announce each one.' },
  repeatedBlanks: { severity: 'tip', title: 'Repeated spaces or tabs', why: 'Runs of blank characters used to position text read as noise.' },
  unclearLinks: { severity: 'warning', title: 'Unclear link text', why: 'Link text should say where the link goes, not "click here" or a bare address.' },
};

/* ---- Colors ---- */

const HIGHLIGHT_HEX = { black: '000000', blue: '0000FF', cyan: '00FFFF', green: '00FF00', magenta: 'FF00FF', red: 'FF0000', yellow: 'FFFF00', white: 'FFFFFF', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0' };
const hex = value => /^[0-9a-f]{6}$/i.test(value || '') ? value.toUpperCase() : null;
/** Relative luminance of a 6-digit hex color. */
export function luminance(color) {
  const value = hex(color); if (!value) return null;
  const channel = i => { const c = parseInt(value.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
/** Contrast ratio (1–21) between two hex colors. */
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const runBackground = (run, page) => hex(HIGHLIGHT_HEX[run.highlight]) || (run.shading && run.shading !== 'auto' && run.shading !== 'foreground' ? hex(run.shading) : null) || page;
/** "Automatic" text color is black, or white on a dark background, as word processors draw it. */
const textColor = (run, background) => hex(run.color) || (luminance(background) < 0.18 ? 'FFFFFF' : '000000');

/* ---- Helpers over the model ---- */

const UNCLEAR = /^(?:click here|here|click|link|this link|more|read more|learn more|this|go|details|info|page|website|url)$/i;
const ADDRESS = /^(?:https?:\/\/|www\.)\S+$/i;
const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);
const text = p => p.runs.map(r => r.text).join('');

/**
 * Run every rule. model: { paragraphs, tables, pageSettings }; options.outline gives each
 * paragraph's heading level (1–9) or null; options.styleName names a paragraph's style.
 */
export function checkAccessibility({ paragraphs, tables = [], pageSettings = {} }, { headingLevel = () => null, enabled = Object.keys(RULES) } = {}) {
  const issues = [];
  const on = rule => enabled.includes(rule);
  const add = (rule, start, end, detail, fix) => issues.push({ rule, severity: RULES[rule].severity, title: RULES[rule].title, why: RULES[rule].why, detail, start, end, ...(fix ? { fix } : {}) });
  const page = hex(pageSettings.background) || 'FFFFFF';
  const starts = []; { let at = 0; for (const p of paragraphs) { starts.push(at); at += length(p) + 1; } }
  const cellOf = new Map();
  for (const table of tables) for (const row of table.rows) for (const cell of row.cells) cellOf.set(cell.id, { table, row, cell });

  let lastLevel = 0, emptyRun = [];
  const flushEmpty = () => {
    if (emptyRun.length >= 2) add('emptyParagraphs', starts[emptyRun[0]], starts[emptyRun.at(-1)] + 1, `${emptyRun.length} empty paragraphs in a row`, { kind: 'removeEmpty', paragraphs: emptyRun.map(i => paragraphs[i].id) });
    emptyRun = [];
  };
  paragraphs.forEach((p, index) => {
    const start = starts[index], body = text(p);
    // Empty paragraphs used as spacing (body text only; a cell may legitimately be empty).
    if (!p.cellId && !body.trim() && !p.runs.some(r => r.image) && !p.sectionEnd && index < paragraphs.length - 1) emptyRun.push(index);
    else flushEmpty();
    // Heading levels that skip.
    const level = headingLevel(p);
    if (level && on('headingOrder')) {
      if (lastLevel && level > lastLevel + 1) add('headingOrder', start, start + length(p), `Heading ${level} follows heading ${lastLevel}`);
      lastLevel = level;
    }
    let at = start;
    for (const run of p.runs) {
      const end = at + run.text.length;
      if (run.image && !run.image.alt?.trim() && !run.image.decorative && on('altText')) add('altText', at, end, run.image.name || 'Picture', run.image.retainedDrawing ? null : { kind: 'altText' });
      if (run.text.trim() && !run.image && !run.revision?.type?.startsWith?.('del')) {
        const background = runBackground(run, page), color = textColor(run, background);
        const ratio = contrastRatio(color, background);
        const large = (run.fontSize || 12) >= 18 || run.bold && (run.fontSize || 12) >= 14;
        if (ratio !== null && ratio < (large ? 3 : 4.5)) {
          const highlighted = background !== page;
          if (highlighted ? on('hardColors') : on('lowContrast')) add(highlighted ? 'hardColors' : 'lowContrast', at, end, `Contrast ${ratio.toFixed(1)}:1 (needs ${large ? 3 : 4.5}:1)`, highlighted ? { kind: 'clearHighlight' } : { kind: 'autoColor' });
        }
      }
      at = end;
    }
    if (on('repeatedBlanks')) for (const match of body.matchAll(/ {3,}|\t{2,}/g)) add('repeatedBlanks', start + match.index, start + match.index + match[0].length, match[0][0] === '\t' ? `${match[0].length} tabs in a row` : `${match[0].length} spaces in a row`, { kind: 'collapseBlanks' });
    if (on('unclearLinks')) {
      // Contiguous runs of one link form its text.
      let linkAt = start, current = null, from = start;
      for (const run of [...p.runs, null]) {
        const id = run?.link ? run.link.id ?? run.link.target ?? run.link.anchor : null;
        if (id !== current) {
          if (current !== null) {
            const label = body.slice(from - start, linkAt - start).trim();
            if (UNCLEAR.test(label) || ADDRESS.test(label)) add('unclearLinks', from, linkAt, `“${label}”`);
          }
          current = id; from = linkAt;
        }
        if (run) linkAt += run.text.length;
      }
    }
  });
  flushEmpty();

  for (const table of tables) {
    const first = paragraphs.findIndex(p => p.cellId && cellOf.get(p.cellId)?.table === table);
    if (first < 0) continue;
    const tableStart = starts[first];
    if (!table.rows.some(row => row.header) && table.rows.length > 1 && on('tableHeader')) add('tableHeader', tableStart, tableStart, `Table with ${table.rows.length} rows`, { kind: 'headerRow', cellId: paragraphs[first].cellId });
    if (on('mergedCells') && table.rows.some(row => row.cells.some(cell => (cell.span || 1) > 1 || cell.vMerge))) add('mergedCells', tableStart, tableStart, 'Merged cells');
    if (on('blankRows')) for (const row of table.rows) {
      const ids = new Set(row.cells.map(c => c.id));
      const own = paragraphs.map((p, i) => [p, i]).filter(([p]) => ids.has(p.cellId));
      if (own.length && own.every(([p]) => !text(p).trim() && !p.runs.some(r => r.image))) add('blankRows', starts[own[0][1]], starts[own[0][1]], 'All cells in this row are empty', { kind: 'deleteRow', cellId: own[0][0].cellId });
    }
  }
  return issues.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Counts for the status bar: { errors, warnings, tips }. */
export function summarize(issues) {
  return { errors: issues.filter(i => i.severity === 'error').length, warnings: issues.filter(i => i.severity === 'warning').length, tips: issues.filter(i => i.severity === 'tip').length };
}
