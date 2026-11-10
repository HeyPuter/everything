/**
 * Quick Analysis: the button shown at the bottom-right corner of a selected block of data (and Ctrl+Q),
 * opening a panel of tabs — Formatting, Charts, Totals, Tables, Sparklines — whose tiles apply the common
 * choice for the selection in one click, through the editor's own commands.
 */
import { el } from './dom.js';
import { cellKey } from '../core/cell.js';
import { icon } from './icons.js';
import { ICON_SETS } from '../core/condformat.js';
import { QUICK_TOTALS } from '../core/quick-totals.js';
import { t } from '../i18n/index.js';

const TABS = ['Formatting', 'Charts', 'Totals', 'Tables', 'Sparklines'];
/** Each tab's name and hint in the interface; TABS keeps the ids. */
const TAB_LABELS = {
  Formatting: 'quickAnalysis.tabs.formatting', Charts: 'quickAnalysis.tabs.charts', Totals: 'quickAnalysis.tabs.totals',
  Tables: 'quickAnalysis.tabs.tables', Sparklines: 'quickAnalysis.tabs.sparklines',
};
const TAB_HINTS = {
  Formatting: 'quickAnalysis.hints.formatting', Charts: 'quickAnalysis.hints.charts', Totals: 'quickAnalysis.hints.totals',
  Tables: 'quickAnalysis.hints.tables', Sparklines: 'quickAnalysis.hints.sparklines',
};
/** A total's tile name by its kind (QUICK_TOTALS' own words are the header written into the sheet). */
const TOTAL_LABELS = {
  sum: 'quickAnalysis.totals.sum', average: 'quickAnalysis.totals.average', count: 'quickAnalysis.totals.count',
  percent: 'quickAnalysis.totals.percent', running: 'quickAnalysis.totals.running',
};
/** Where a total goes, as the tile's tooltip and accessible name say it. */
const TOTAL_PLACES = {
  rows: { title: 'quickAnalysis.tile.rowsTitle', label: 'quickAnalysis.tile.rowsLabel' },
  columns: { title: 'quickAnalysis.tile.columnsTitle', label: 'quickAnalysis.tile.columnsLabel' },
};

function tilesFor(tab) {
  const firstIcons = Object.keys(ICON_SETS)[0];
  switch (tab) {
    case 'Formatting': return [
      ['quickAnalysis.tiles.dataBars', 'chartBar', 'quickRule', { kind: 'databar', barColor: '#8fb8ff' }],
      ['quickAnalysis.tiles.colorScale', 'palette', 'quickRule', { kind: 'scale', from: '#63be7b', mid: '#ffeb84', to: '#f8696b' }],
      ['quickAnalysis.tiles.iconSet', 'sparkle', 'quickRule', { kind: 'icons', set: firstIcons }],
      ['quickAnalysis.tiles.greaterThan', 'highlighter', 'quickRule', 'gt'],
      ['quickAnalysis.tiles.top10', 'sortDesc', 'quickRule', 'topPercent'],
      ['quickAnalysis.tiles.clearFormat', 'eraser', 'clearRules', 'selection'],
    ];
    case 'Charts': return [
      ['quickAnalysis.tiles.clusteredColumn', 'chartColumn', 'chart', { action: 'insert', subtype: 'columnClustered' }],
      ['quickAnalysis.tiles.line', 'chartLine', 'chart', { action: 'insert', subtype: 'line' }],
      ['quickAnalysis.tiles.pie', 'chartPie', 'chart', { action: 'insert', subtype: 'pie' }],
      ['quickAnalysis.tiles.clusteredBar', 'chartBar', 'chart', { action: 'insert', subtype: 'barClustered' }],
      ['quickAnalysis.tiles.scatter', 'chartScatter', 'chart', { action: 'insert', subtype: 'scatter' }],
      ['quickAnalysis.tiles.moreCharts', 'chartCombo', 'chart', { action: 'recommended' }],
    ];
    case 'Totals': return [
      ...QUICK_TOTALS.map(([kind]) => [TOTAL_LABELS[kind], 'totalRow', 'quickTotal', { kind, direction: 'rows' }, TOTAL_PLACES.rows]),
      ...QUICK_TOTALS.map(([kind]) => [TOTAL_LABELS[kind], 'totalCol', 'quickTotal', { kind, direction: 'columns' }, TOTAL_PLACES.columns]),
    ];
    case 'Tables': return [
      ['quickAnalysis.tiles.table', 'table', 'insertTable', null],
      ['quickAnalysis.tiles.pivotTable', 'pivotRecommend', 'recommendedPivots', null],
      ['quickAnalysis.tiles.blankPivotTable', 'pivot', 'pivot', null],
    ];
    case 'Sparklines': return [
      ['quickAnalysis.tiles.sparkLine', 'sparkLine', 'insertSparklines', 'line'],
      ['quickAnalysis.tiles.sparkColumn', 'sparkColumn', 'insertSparklines', 'column'],
      ['quickAnalysis.tiles.winLoss', 'sparkWinLoss', 'insertSparklines', 'stacked'],
    ];
    default: return [];
  }
}

export function createQuickAnalysis(ctx) {
  let tab = 'Formatting';
  let panel = null;
  const button = el('button.quick-analysis-btn', { type: 'button', hidden: true, html: icon('quickAnalysis', 16), 'aria-label': t('quickAnalysis.title'), title: t('quickAnalysis.buttonTitle'), 'aria-haspopup': 'dialog', tabindex: -1,
    onclick: () => (panel ? close() : open()) });

  /** The block the button belongs to: one range of several cells holding something. */
  let known = { key: null, holds: false }; // whether the range last asked about holds data, while nothing changes
  function target() {
    const g = ctx.grid;
    // A selected chart, picture or shape is what the keys act on, not the cells left selected under it (as
    // after Insert ▸ Chart): the button would only sit over the object.
    if (!g || g.editing || g.selectedChart || (g.ranges?.length || 1) !== 1) return null;
    const rg = g.range;
    if (!rg || (rg.r1 === rg.r2 && rg.c1 === rg.c2)) return null;
    const sheet = ctx.wb.sheet(g.sheetId);
    if (!sheet || sheet.kind === 'chart') return null;
    // The answer is asked again on every scroll event and selection change; it changes only with the
    // range or the workbook, so it is kept rather than looking through the sheet each frame.
    const key = `${ctx.wb.version}|${g.sheetId}|${rg.r1},${rg.c1},${rg.r2},${rg.c2}`;
    if (known.key !== key) known = { key, holds: holdsData(sheet, g.sheetId, rg) };
    return known.holds ? rg : null;
  }

  /** Does the range hold anything: looked up cell by cell when it is smaller than the stored cells, so a whole column costs what it holds. */
  function holdsData(sheet, sheetId, rg) {
    const has = (r, c) => ctx.wb.getValue(sheetId, r, c) != null;
    if ((rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1) < sheet.cells.size) {
      for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) if (sheet.cells.has(cellKey(r, c)) && has(r, c)) return true;
      return false;
    }
    for (const key of sheet.cells.keys()) {
      const i = key.indexOf(','), r = +key.slice(0, i), c = +key.slice(i + 1);
      if (r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2 && has(r, c)) return true;
    }
    return false;
  }

  function place() {
    const rg = target();
    if (!rg) { button.hidden = true; if (panel) close(); return; }
    // The Paste Options or Auto Fill Options button at the same corner is the one shown, as in Excel.
    if (ctx.optionButton?.visible && !panel) { button.hidden = true; return; }
    const g = ctx.grid;
    const rect = g.cellRect(Math.min(rg.r2, g.lastVisibleRow?.() ?? rg.r2), Math.min(rg.c2, g.lastVisibleCol?.() ?? rg.c2));
    const vp = g.viewport.getBoundingClientRect();
    // A block scrolled up or left out of sight, past the window's edge or under its frozen panes, takes the
    // button with it: held at the edge it stood over the formula bar and the ribbon, or over the frozen cells.
    if (vp.width > 0 || vp.height > 0) {
      const pane = g.paneRect?.(rg.r2, rg.c2) || vp;
      if (rect.bottom <= pane.top || rect.right <= pane.left) { button.hidden = true; if (panel) close(); return; }
    }
    const left = Math.min(rect.right + 2, (vp.right || rect.right + 2) - 24), top = Math.min(rect.bottom + 2, (vp.bottom || rect.bottom + 2) - 24);
    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.round(top)}px`;
    button.hidden = false;
    if (panel) positionPanel();
  }

  function positionPanel() {
    const b = button.getBoundingClientRect();
    const w = panel.offsetWidth || 420, h = panel.offsetHeight || 170;
    panel.style.left = `${Math.round(Math.max(8, Math.min(b.left, window.innerWidth - w - 8)))}px`;
    panel.style.top = `${Math.round(b.bottom + h + 8 > window.innerHeight ? Math.max(8, b.top - h - 4) : b.bottom + 4)}px`;
  }

  function render() {
    const tabs = el('div.qa-tabs', { role: 'tablist', 'aria-label': t('quickAnalysis.title') }, ...TABS.map((name) => el('button.qa-tab', {
      type: 'button', role: 'tab', 'aria-selected': String(name === tab), onclick: () => { tab = name; render(); panel.querySelector('.qa-tab[aria-selected="true"]')?.focus(); },
    }, t(TAB_LABELS[name]))));
    const tiles = tilesFor(tab);
    const grid = el('div.qa-tiles', { role: 'group', 'aria-label': t(TAB_LABELS[tab]) },
      ...tiles.map(([labelKey, glyph, cmd, arg, place]) => {
        const label = t(labelKey);
        return el('button.qa-tile', { type: 'button', title: place ? t(place.title, { label }) : label,
          'aria-label': place ? t(place.label, { label }) : label, dataset: { direction: arg?.direction || '' },
          onclick: () => { close(); ctx.run(cmd, arg); } },
        el('span.qa-tile-icon', { html: icon(glyph, 24) }), el('span.qa-tile-label', {}, label));
      }));
    const hint = el('p.qa-hint', {}, t(TAB_HINTS[tab]));
    panel.replaceChildren(tabs, grid, hint);
  }

  function open() {
    if (!target()) return;
    panel = el('div.quick-analysis', { role: 'dialog', 'aria-label': t('quickAnalysis.title') });
    document.body.append(panel);
    render();
    positionPanel();
    panel.querySelector('.qa-tab[aria-selected="true"]')?.focus();
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); ctx.grid.focus(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const at = TABS.indexOf(tab);
        if (e.target.classList.contains('qa-tab')) { e.preventDefault(); tab = TABS[(at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]; render(); panel.querySelector('.qa-tab[aria-selected="true"]').focus(); }
      }
    });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }
  function outside(e) { if (panel && !panel.contains(e.target) && e.target !== button && !button.contains(e.target)) close(); }
  function close() {
    document.removeEventListener('pointerdown', outside, true);
    panel?.remove();
    panel = null;
  }

  // Ctrl+Q (Cmd+Q stays the browser's).
  const onKey = (e) => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === 'q' || e.key === 'Q') && ctx.grid?.viewport?.contains(document.activeElement)) {
      e.preventDefault();
      place();
      if (!button.hidden) (panel ? close() : open());
    }
  };
  document.addEventListener('keydown', onKey);
  const onScroll = () => place();
  ctx.grid?.viewport?.addEventListener('scroll', onScroll, { passive: true });
  const unsubscribe = ctx.subscribe(place);
  return {
    el: button, place, open, close, get openPanel() { return panel; },
    destroy() { unsubscribe(); close(); document.removeEventListener('keydown', onKey); ctx.grid?.viewport?.removeEventListener('scroll', onScroll); button.remove(); },
  };
}
