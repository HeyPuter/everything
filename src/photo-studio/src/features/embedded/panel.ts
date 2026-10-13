// Embedded objects in the Layers panel (thumbnail badge, note under the name)
// and their Properties section (content, link and stack status, actions).
import type { Editor } from '../../editor';
import type { Layer } from '../../model/document';
import { contentsOf, instancesOf, stackModes } from '../../model/embedded';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { linkStatus, linkStatusText } from './link-state';
import { stackLabel } from './stack-mode';
import { ownerOf } from './owners';

/** Small badge over the thumbnail: embedded, linked, or linked and changed. */
export function badge(e: Editor, l: Layer) {
  if (l.kind !== 'image') return '';
  const c = contentsOf(e.doc, l);
  if (c?.link) {
    const s = linkStatus(c);
    const warn = s === 'modified' || s === 'unavailable';
    return `<span class="embed-badge linked ${warn ? 'warn' : ''}" title="Linked to ${escapeXML(c.link.name)}: ${escapeXML(linkStatusText(s, c))}">${svg('link', 10)}</span>`;
  }
  return `<span class="embed-badge" title="Embedded object">${svg('embedded-object', 10)}</span>`;
}
/** Note under the layer name. */
export function note(e: Editor, l: Layer): string | undefined {
  if (l.kind !== 'image') return undefined;
  const c = contentsOf(e.doc, l);
  const parts = [c?.link ? 'linked' : 'embedded'];
  if (c?.stack && c.stack !== 'none') parts.push(stackLabel(c.stack).toLowerCase());
  if (l.embed?.frame) parts.push(l.embed.frame.pins ? 'pin warped' : l.embed.frame.mesh ? 'warped' : 'distorted');
  return parts.join(' · ');
}

const button = (command: string, icon: string, label: string) => `<button class="embed-action" data-command="${command}" title="${escapeXML(label)}">${svg(icon, 14)}<span>${escapeXML(label)}</span></button>`;

/** Properties section for the selected embedded object. */
export function section(e: Editor, l: Layer) {
  if (l.kind !== 'image' || (!l.asset && !l.embed)) return '';
  const c = contentsOf(e.doc, l);
  const count = c ? instancesOf(e.doc, c.id).length : 1;
  const width = c?.width ?? Math.round(l.sourceWidth),
    height = c?.height ?? Math.round(l.sourceHeight);
  const kind = c?.project ? 'Layers' : 'Placed image';
  const rows: [string, string][] = [
    ['Contents', `${kind} · ${width} × ${height} px`],
    ...(c?.sourceName && !c.link ? [['Source', c.sourceName] as [string, string]] : []),
    ['Instances', count === 1 ? 'This layer only' : `${count} layers share it`],
  ];
  if (l.embed?.frame) rows.push(['Placement', l.embed.frame.pins ? `Pin warped, ${l.embed.frame.pins.pins.length} ${l.embed.frame.pins.pins.length === 1 ? 'pin' : 'pins'} (kept editable)` : l.embed.frame.mesh ? 'Warped (kept editable)' : 'Distorted (kept editable)']);
  const link = c?.link;
  const status = c && link ? linkStatus(c) : undefined;
  if (c && link) rows.push([link.kind === 'library' ? 'Library item' : 'Linked file', `${link.kind === 'puter' ? (link.path ?? link.name) : link.name}`], ['Status', linkStatusText(status, c)]);
  const open = e.sessions.some((s) => ownerOf(s)?.parent === e.session && ownerOf(s)?.contents === c?.id);
  const stack = c?.project
    ? `<label class="embed-stack">Stack mode<select data-embed-stack aria-label="Stack mode">${stackModes.map(([m, label]) => `<option value="${m}" ${(c.stack ?? 'none') === m ? 'selected' : ''}>${escapeXML(label)}</option>`).join('')}</select></label>`
    : '';
  return `<section class="embed-properties" aria-label="Embedded object">
<h3>${svg(link ? 'link' : 'embedded-object', 14)} ${link ? 'Linked object' : 'Embedded object'}</h3>
<div class="property-grid">${rows.map(([k, v]) => `<span>${escapeXML(k)}</span><strong class="${k === 'Status' && status && status !== 'current' ? 'embed-warn' : ''}">${escapeXML(v)}</strong>`).join('')}</div>
${stack}
<div class="embed-actions">
${button('layer.embed-edit', 'pen-line', open ? 'Show Contents' : 'Edit Contents')}
${button('layer.embed-to-layers', 'layers', 'Convert to Layers')}
${button('layer.embed-replace', 'repeat', 'Replace…')}
${button('layer.embed-export', 'download', 'Export…')}
${l.embed?.frame || l.transform.rotation || Math.abs(l.transform.width - width) > 0.5 || Math.abs(l.transform.height - height) > 0.5 ? button('layer.embed-reset', 'rotate-ccw', 'Reset Transform') : ''}
${link ? `${button('layer.embed-update', 'refresh-cw', 'Update')}${button('layer.embed-relink', 'link', 'Relink…')}${button('layer.embed-embed-linked', 'embedded-object', 'Embed')}` : ''}
</div></section>`;
}

/** Stack mode picker in the Properties section. */
export function bindPanel(e: Editor) {
  e.root.addEventListener('change', (ev) => {
    const t = ev.target as HTMLSelectElement;
    if (!t.matches('[data-embed-stack]') || e.busy) return;
    void e.runCommand(`layer.embed-stack-${t.value}`);
  });
}
