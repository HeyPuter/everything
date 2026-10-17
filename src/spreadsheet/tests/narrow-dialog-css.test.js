import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out and applies no stylesheet, so the rules that keep dialogs inside a phone-width window,
// and their lists readable and visibly focused, are checked as text.
const read = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first `@media` block whose query starts with `query`. */
const media = (css, query) => {
  const at = css.indexOf(`@media ${query}`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', at) + 1, i);
  }
  return null;
};

/** The declarations of every rule whose selector list contains `selector`, in order. */
const rules = (css, selector) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, selectors]) => selectors.split(',').some((s) => s.trim() === selector))
  .map(([, , declarations]) => declarations);
/** The declarations of the first rule whose selector list contains `selector`. */
const rule = (css, selector) => rules(css, selector)[0] ?? null;

describe('dialogs at phone width', () => {
  it('lets the Options dialog shrink to the window, with the section bar scrolling inside it', () => {
    const narrow = media(read('options.css'), '(max-width: 720px)');
    // A bare 1fr track grows to the widest child, here the row of section names.
    expect(rule(narrow, '.opt-dialog')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule(narrow, '.opt-nav-list')).toMatch(/overflow-x:\s*auto/);
  });

  it('wraps the Sheet View Options buttons onto a second row instead of pushing Delete off screen', () => {
    const narrow = media(read('layout-views.css'), '(max-width: 560px)');
    expect(rule(narrow, '.cv-buttons')).toMatch(/flex-direction:\s*row/);
    expect(rule(narrow, '.cv-buttons')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('wraps the Share dialog footer so Done stays inside the window', () => {
    const foot = rule(read('components.css'), '.share-foot');
    expect(foot).toMatch(/flex-wrap:\s*wrap/);
    expect(foot).toMatch(/row-gap:\s*\d+px/);
  });

  it('wraps the text box Bold, Italic and Border checks once the dialog narrows', () => {
    const css = read('components.css');
    expect(rule(css, '.textbox-style-checks')).toMatch(/gap:\s*14px/);
    expect(rule(media(css, '(max-width: 480px) { .textbox-style-checks'), '.textbox-style-checks')).toMatch(/flex-wrap:\s*wrap/);
    const js = readFileSync(new URL('../src/ui/textboxdialog.js', import.meta.url), 'utf8');
    expect(js).toContain("el('div.row.textbox-style-checks'");
  });

  it('lets the Print dialog stack into one column no wider than the window', () => {
    const narrow = media(read('components.css'), '(max-width: 799px)');
    expect(rule(narrow, '.print-layout')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('keeps the Power Query preview open on a short, narrow window and scrolls the stacked editor instead', () => {
    const narrow = media(read('queries.css'), '(max-width: 760px)');
    const body = rule(narrow, '.pq-body');
    expect(body).toMatch(/grid-template-rows:\s*auto minmax\(160px,\s*1fr\) auto/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    // The panes above and below the preview hold their content rather than shrinking to nothing.
    expect(rule(narrow, '.pq-settings')).toMatch(/min-height:\s*auto/);
    expect(rule(narrow, '.pq-settings')).not.toMatch(/max-height/);
  });

  it('breaks a dialog title that is one long file name or URL, keeping the close button on screen', () => {
    // A flex item is no narrower than its longest word unless the word may break; `anywhere` lets it.
    expect(rule(read('components.css'), '.modal-title')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('wraps Cancel and OK under Blank PivotTable in Recommended PivotTables, together at the right', () => {
    const css = read('chrome.css');
    expect(rule(css, '.rec-pivot-foot')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(css, '.rec-pivot-actions')).toMatch(/margin-left:\s*auto/);
    const js = readFileSync(new URL('../src/ui/recommended-pivots.js', import.meta.url), 'utf8');
    expect(js).toContain("el('div.row.rec-pivot-foot'");
    expect(js).toContain("el('div.row.rec-pivot-actions'");
  });

  it('wraps Cancel and OK under Hidden and Empty Cells in Select Data Source, instead of pushing that button off the left edge', () => {
    const css = read('chart-ui.css');
    expect(rule(css, '.select-data-foot')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(css, '.select-data-actions')).toMatch(/margin-left:\s*auto/);
    const js = readFileSync(new URL('../src/ui/chart-select-data.js', import.meta.url), 'utf8');
    expect(js).toContain("el('div.row.row-end.select-data-foot'");
    expect(js).toContain("el('div.row.select-data-actions'");
  });
});

describe('dialog lists for the keyboard and the eye', () => {
  it('rings a query row in Queries & Connections when the keyboard focuses it', () => {
    // The row drops the outline for the mouse; the keyboard needs the accent ring the other lists draw.
    expect(rules(read('queries.css'), '.qc-item:focus-visible').join(';')).toMatch(/outline:\s*2px solid var\(--accent\)/);
  });

  it('keeps the detail line of a selected Options list row at the second ink', () => {
    // --ink-3 on --accent-wash is 3.98:1 in the dark theme; --ink-2 is above 7:1 in both.
    expect(rule(read('options.css'), '.opt-option[aria-selected="true"] .opt-option-detail')).toMatch(/color:\s*var\(--ink-2\)/);
  });
});
