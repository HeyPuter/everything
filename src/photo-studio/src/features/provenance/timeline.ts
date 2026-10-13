// A provenance record as a readable timeline (Provenance panel and Inspect
// Provenance): a summary, then sources, edits, AI use and exports in time order.
import { escapeXML } from '../../model/assets';
import { keptSteps, type ProvenanceRecord } from '../../model/provenance';

export type TimelineFilter = 'all' | 'edits' | 'sources' | 'ai' | 'exports';
type Entry = { when: string; kind: Exclude<TimelineFilter, 'all'>; html: string; undone?: boolean };

const ORIGIN: Record<ProvenanceRecord['origin'], string> = { new: 'Started as a new document', opened: 'Started from an opened file', captured: 'Started from a camera capture', unknown: 'Origin not recorded' };
const ROLE: Record<string, string> = { opened: 'Opened', placed: 'Placed', library: 'Placed from a library', captured: 'Captured' };
const AI_KIND: Record<string, string> = { generate: 'Generated content', edit: 'Edited with a prompt', upscale: 'AI detail layer', fill: 'AI Fill', expand: 'AI Expand', other: 'AI-assisted change' };

export function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function formatTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
const short = (hash: string) => `${hash.slice(0, 10)}…`;

export function summaryHtml(r: ProvenanceRecord) {
  const ai = r.ai.length;
  const parts = [
    `${keptSteps(r)} edit step${keptSteps(r) === 1 ? '' : 's'}`,
    `${r.sources.length} source file${r.sources.length === 1 ? '' : 's'}`,
    ai ? `AI used ${ai} time${ai === 1 ? '' : 's'}` : 'no AI use recorded',
    `${r.exports.length} export${r.exports.length === 1 ? '' : 's'}`,
  ];
  return `<div class="prov-summary"><div class="prov-origin">${escapeXML(ORIGIN[r.origin])} · ${escapeXML(formatTime(r.created))}</div><div class="prov-counts">${parts.map((x) => `<span>${escapeXML(x)}</span>`).join(' · ')}</div></div>`;
}

function entries(r: ProvenanceRecord): Entry[] {
  const out: Entry[] = [];
  for (const s of r.sources)
    out.push({ when: s.when, kind: 'sources', html: `<b>${escapeXML(ROLE[s.role] ?? 'Source')}</b> ${escapeXML(s.name)} <span class="prov-meta">${escapeXML(s.format.toUpperCase())}, ${formatSize(s.size)}, SHA-256 <code title="${escapeXML(s.sha256)}">${escapeXML(short(s.sha256))}</code></span>` });
  for (const s of r.steps)
    out.push({
      when: s.when,
      kind: 'edits',
      undone: s.undone,
      html: `${escapeXML(s.label)}${(s.count ?? 1) > 1 ? ` <span class="prov-count">×${s.count}</span>` : ''}${s.command || s.tool ? ` <span class="prov-meta">${escapeXML(s.command ?? s.tool!)}</span>` : ''}${s.undone ? ' <span class="prov-meta">(undone)</span>' : ''}`,
    });
  for (const a of r.ai)
    out.push({ when: a.when, kind: 'ai', html: `<b>${escapeXML(AI_KIND[a.kind] ?? 'AI')}</b>${a.layer ? ` on “${escapeXML(a.layer)}”` : ''} <span class="prov-meta">${escapeXML(a.command)}${a.model ? `, ${escapeXML(a.model)}` : ''}</span>${a.prompt ? `<div class="prov-prompt">“${escapeXML(a.prompt)}”</div>` : ''}` });
  for (const x of r.exports)
    out.push({ when: x.when, kind: 'exports', html: `<b>Exported</b> ${escapeXML(x.name)} <span class="prov-meta">${escapeXML(x.format.toUpperCase())}${x.pixelHash ? `, pixels <code title="${escapeXML(x.pixelHash)}">${escapeXML(short(x.pixelHash.replace(/^sha256:/, '')))}</code>` : ''}${x.signed ? ', signed' : ''}</span>` });
  return out.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));
}

const KIND_LABEL: Record<Entry['kind'], string> = { edits: 'Edit', sources: 'Source', ai: 'AI', exports: 'Export' };
/** The timeline, newest last; `limit` keeps the most recent entries. */
export function timelineHtml(r: ProvenanceRecord, filter: TimelineFilter = 'all', limit = 400) {
  const list = entries(r).filter((x) => filter === 'all' || x.kind === filter);
  if (!list.length) return `<p class="muted prov-empty">${filter === 'all' ? 'Nothing recorded yet.' : 'Nothing of this kind recorded.'}</p>`;
  const shown = list.slice(-limit);
  return `${list.length > shown.length ? `<p class="muted prov-more">${list.length - shown.length} earlier entries not shown.</p>` : ''}<ol class="prov-timeline">${shown
    .map((x) => `<li class="prov-entry prov-${x.kind}${x.undone ? ' prov-undone' : ''}"><span class="prov-kind">${KIND_LABEL[x.kind]}</span><span class="prov-text">${x.html}</span><time datetime="${escapeXML(x.when)}">${escapeXML(formatTime(x.when))}</time></li>`)
    .join('')}</ol>`;
}
