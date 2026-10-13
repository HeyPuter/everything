/**
 * Insert Chart (Recommended Charts and All Charts tabs) and Change Chart Type:
 * the chart families down the left, the family's subtypes across the top, and a preview of the chosen
 * one drawn from the real data below them.
 */
import { el, isComposing } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { renderChartSvg } from './chartsvg.js';
import { insertChart, themeChartFont } from './chart-actions.js';
import { chartData } from '../core/charts.js';
import { normalizeRange } from '../core/cell.js';
import { CHART_FAMILIES, DEFAULT_SUBTYPE, changeSubtypePatch, chartSubtype, newExcelChart, subtypeOf } from '../core/chart-subtypes.js';
import { recommendedSubtypes } from '../core/chart-design.js';

const familyOf = id => CHART_FAMILIES.find(f => f.subtypes.includes(id)) || CHART_FAMILIES[0];

/**
 * mode 'recommended' and 'insert' insert a new chart over the selection (opening on the Recommended or
 * All Charts tab, `family` choosing the All Charts family); 'change' changes `chart` to the chosen subtype.
 */
export function openChartTypeDialog(ctx, { mode = 'recommended', family = null, chart = null } = {}) {
  const { wb } = ctx, sheetId = ctx.sheetId();
  const changing = mode === 'change' && chart;
  const range = changing ? chart.range : normalizeRange(ctx.dataRange?.(ctx.range()) || ctx.range());
  const font = themeChartFont(wb);
  const baseData = chartData(wb, sheetId, changing ? chart : newExcelChart(wb, sheetId, range, DEFAULT_SUBTYPE, { font }));
  // A treemap's reading of the range tells whether its label columns nest.
  const levels = changing ? 0 : Math.max(0, ...(chartData(wb, sheetId, { ...newExcelChart(wb, sheetId, range, 'treemap', { font }) }).levels || []).map(path => path.length));
  const recommended = changing ? [] : recommendedSubtypes(baseData, { levels });
  let tab = changing || mode === 'insert' ? 'all' : 'recommended';
  let chosen = changing ? subtypeOf(chart) : family ? CHART_FAMILIES.find(f => f.id === family)?.subtypes[0] || DEFAULT_SUBTYPE : recommended[0] || DEFAULT_SUBTYPE;
  if (!chartSubtype(chosen)) chosen = DEFAULT_SUBTYPE;

  const draft = id => (changing ? { ...chart, ...changeSubtypePatch(chart, id, { font }) } : newExcelChart(wb, sheetId, range, id, { font }));
  const picture = (id, w, h) => {
    const c = draft(id);
    try { return renderChartSvg(chartData(wb, sheetId, c), c, w, h); } catch { return ''; }
  };

  const tabs = el('div.chart-type-tabs', { role: 'tablist', 'aria-label': 'Chart types' });
  const body = el('div.chart-type-content');
  const tabButton = (id, label) => el('button.chart-type-tab', { type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; render(); } }, label);
  if (!changing) tabs.append(tabButton('recommended', 'Recommended Charts'), tabButton('all', 'All Charts'));

  const preview = el('div.chart-type-preview', { 'aria-hidden': 'true' });
  const name = el('p.chart-type-name');
  function showPreview() {
    name.textContent = chartSubtype(chosen)?.label || '';
    preview.innerHTML = picture(chosen, 480, 288);
  }

  function renderRecommended() {
    const list = el('div.chart-type-list', { role: 'listbox', 'aria-label': 'Recommended Charts' }, ...recommended.map(id => {
      const s = chartSubtype(id);
      return el('button.chart-type-item', { type: 'button', role: 'option', 'aria-selected': String(id === chosen), title: s.label,
        ondblclick: () => submit(), onclick: () => { chosen = id; render(); } },
      el('span', { html: icon(s.icon, 28) }), el('span', {}, s.label));
    }));
    return el('div.chart-type-body', {}, list, el('div.chart-type-main', {}, name, preview));
  }

  function renderAll() {
    const fam = familyOf(chosen);
    const list = el('div.chart-type-list', { role: 'listbox', 'aria-label': 'Chart families' }, ...CHART_FAMILIES.map(f => el('button.chart-type-item', {
      type: 'button', role: 'option', 'aria-selected': String(f === fam), onclick: () => { chosen = f.subtypes.includes(chosen) ? chosen : f.subtypes[0]; if (f !== fam) chosen = f.subtypes[0]; render(); },
    }, el('span', { html: icon(f.icon, 20) }), el('span', {}, f.label))));
    const row = el('div.chart-subtype-row', { role: 'radiogroup', 'aria-label': `${fam.label} subtypes` }, ...fam.subtypes.map(id => {
      const s = chartSubtype(id);
      return el('button.chart-gallery-tile', { type: 'button', role: 'radio', 'aria-checked': String(id === chosen), title: s.label, 'aria-label': s.label,
        ondblclick: () => submit(), onclick: () => { chosen = id; render(); } }, el('span.chart-gallery-picture', { html: icon(s.icon, 32) }));
    }));
    return el('div.chart-type-body', {}, list, el('div.chart-type-main', {}, row, name, preview));
  }

  function render() {
    for (const b of tabs.children) b.setAttribute('aria-selected', String((b.textContent === 'All Charts') === (tab === 'all')));
    const focusLabel = document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.textContent;
    body.replaceChildren(tab === 'all' ? renderAll() : renderRecommended());
    showPreview();
    const again = [...body.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent) === focusLabel);
    again?.focus();
  }

  body.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    const items = [...e.target.parentElement?.children || []].filter(n => n.tagName === 'BUTTON');
    const at = items.indexOf(e.target), step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (at < 0 || !step) return;
    e.preventDefault();
    const next = items[(at + step + items.length) % items.length];
    next.click();
    requestAnimationFrame(() => [...body.querySelectorAll('button')].find(b => b.textContent === next.textContent && b.getAttribute('aria-label') === next.getAttribute('aria-label'))?.focus());
  });

  function submit(e) {
    e?.preventDefault?.();
    modal.close();
    if (changing) ctx.run('chart', { action: 'changeType', subtype: chosen, id: chart.id });
    else insertChart(ctx, chosen, range);
  }
  const content = el('form.chart-type-dialog', { onsubmit: submit }, tabs, body,
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  render();
  const modal = openModal({ title: changing ? 'Change Chart Type' : 'Insert Chart', content, wide: true, onClose: () => ctx.grid.focus() });
  return modal;
}
