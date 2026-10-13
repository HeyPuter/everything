// Provenance panel: the active document's record as a timeline with filters.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { recordOf, onRecordChange } from './recorder';
import { summaryHtml, timelineHtml, type TimelineFilter } from './timeline';
import './provenance.css';

let filter: TimelineFilter = 'all';
const FILTERS: [TimelineFilter, string][] = [
  ['all', 'All'],
  ['edits', 'Edits'],
  ['sources', 'Sources'],
  ['ai', 'AI'],
  ['exports', 'Exports'],
];
let version = 0;

export function mount(e: Editor, el: HTMLElement) {
  el.classList.add('provenance-panel');
  el.innerHTML = `<div class="prov-head"></div><div class="prov-filters" role="radiogroup" aria-label="Show">${FILTERS.map(([f, l]) => `<button type="button" role="radio" data-prov-filter="${f}" aria-checked="${f === filter}">${l}</button>`).join('')}</div><div class="prov-body" tabindex="0" aria-label="Provenance timeline"></div><div class="prov-foot muted">Attach the record to exports in Export As or Preferences → Export.</div>`;
  el.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-prov-filter]');
    if (!b) return;
    filter = b.dataset.provFilter as TimelineFilter;
    el.querySelectorAll('[data-prov-filter]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    version++;
    update(e, el);
  });
  onRecordChange(() => {
    version++;
    if (el.isConnected) update(e, el);
  });
}

export function update(e: Editor, el: HTMLElement) {
  const key = `${version}:${e.session.id}:${e.hasDocument}:${e.history.position}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const head = el.querySelector<HTMLElement>('.prov-head')!;
  const body = el.querySelector<HTMLElement>('.prov-body')!;
  if (!e.hasDocument) {
    head.innerHTML = '';
    body.innerHTML = '<p class="muted prov-empty">Open or create a document to see how it is made.</p>';
    return;
  }
  const r = recordOf(e.session);
  head.innerHTML = `<div class="prov-title">${escapeXML(e.doc.name)}</div>${summaryHtml(r)}`;
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  body.innerHTML = timelineHtml(r, filter);
  // Follow new entries unless the user scrolled back.
  if (atEnd) body.scrollTop = body.scrollHeight;
}
