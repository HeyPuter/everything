// The Regions section of a country's detail: status per admin-1 region and manual marks.
import { el, uid } from '../../ui/dom.js';
import { button, spinner } from '../../ui/bits.js';
import { locale, t } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { searchText } from '../../lib/atlas/countries.js';
import { icon } from './icons.js';

const FILTER_FROM = 15;

/**
 * `entry`: `{status: 'error'|'none'|'ready'|other (loading), result}` where `result` is `aggregateRegions` output.
 * `filter` is the remembered filter text; `onFilter(text)` stores it without a re-render.
 */
export function regionsSection({ entry, filter = '', busy, selected = null, showPlanned = true, onToggle, onRetry, onFilter }) {
  const result = entry?.status === 'ready' ? entry.result : null;
  const head = el('h3.atlas-subhead', {}, el('span', {}, t('atlas.regions.heading')),
    result ? el('span.atlas-count', {}, t('atlas.regions.count', { visited: formatNumber(result.visited), total: formatNumber(result.total) })) : null);
  if (!entry || !['error', 'none', 'ready'].includes(entry.status)) return [head, el('p.atlas-hint.atlas-regions-state', { role: 'status' }, spinner(), t('atlas.regions.loading'))];
  if (entry.status === 'error') return [head, el('div.atlas-note', {}, el('p', {}, t('atlas.regions.failed')), button(t('atlas.retry'), { size: 'sm', variant: 'outline', dataset: { focus: 'regions-retry' }, onclick: onRetry }))];
  if (entry.status === 'none' || !result?.total) return [head, el('p.atlas-hint', {}, t('atlas.regions.none'))];

  const regions = result.regions.slice().sort((a, b) => a.name.localeCompare(b.name, locale));
  const rows = regions.map((region) => {
    const status = region.status === 'planned' && !showPlanned ? null : region.status;
    const note = region.auto ? t('atlas.regions.fromTrips') : status === 'planned' ? t('atlas.regions.planned') : null;
    const toggle = !region.auto || region.manual
      ? button(t('atlas.regions.visited'), { size: 'sm', variant: region.manual ? 'outline' : 'ghost', busy, 'aria-pressed': String(region.manual),
        'aria-label': t('atlas.regions.markLabel', { region: region.name }), dataset: { focus: `region:${region.code}` }, onclick: () => onToggle(region, !region.manual) })
      : null;
    const node = el('li.atlas-region', { dataset: { status: status ?? 'none', code: region.code }, 'aria-current': region.code === selected ? 'true' : null },
      el('span.atlas-region-mark', {}, status === 'visited' ? icon('visited', 16) : null),
      el('span.atlas-row-text', {}, el('span.atlas-region-name', {}, region.name),
        region.local || note ? el('span.atlas-row-sub', {}, [region.local, note].filter(Boolean).join(' · ')) : null),
      toggle);
    return { node, text: searchText(`${region.name} ${region.local ?? ''} ${region.code}`, locale) };
  });
  const list = el('ul.atlas-regions', {}, rows.map((row) => row.node));
  const empty = el('p.atlas-hint', { hidden: true });
  const apply = (text) => {
    const needle = searchText(text.trim(), locale);
    let shown = 0;
    for (const { node, text: haystack } of rows) { node.hidden = Boolean(needle) && !haystack.includes(needle); if (!node.hidden) shown += 1; }
    empty.hidden = shown > 0;
    empty.textContent = shown ? '' : t('atlas.regions.noMatch', { query: text.trim() });
  };
  const nodes = [head];
  if (regions.length >= FILTER_FROM) {
    const id = uid('atlas-region-filter');
    const input = el('input.input', { id, type: 'search', value: filter, autocomplete: 'off', spellcheck: false, dataset: { focus: 'region-filter' } });
    input.addEventListener('input', () => { onFilter(input.value); apply(input.value); });
    nodes.push(el('div.field.atlas-region-filter', {}, el('label.field-label', { htmlFor: id }, t('atlas.regions.filter')), input));
  }
  nodes.push(list, empty);
  if (filter) apply(filter);
  return nodes;
}
