// File → Inspect Provenance: read any image file's provenance (XMP record and
// C2PA-format manifests), check its signature and hashes, and show whether
// the pixels still match the recorded hash.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { inspectProvenance, type C2paManifestReport } from '../../imaging/provenance';
import { modal } from '../files/ui';
import { formatSize, formatTime, summaryHtml, timelineHtml } from './timeline';
import './provenance.css';

type Check = [ok: boolean | undefined, label: string, text: string];
const checks = (list: Check[]) =>
  `<ul class="prov-checks">${list.map(([ok, label, text]) => `<li class="prov-check ${ok === true ? 'prov-ok' : ok === false ? 'prov-bad' : ''}"><b>${escapeXML(label)}</b><span>${escapeXML(text)}</span></li>`).join('')}</ul>`;

// No trust list or certificate chain is checked, so a matching signature
// never shows who signed: any key can sign with a certificate naming anyone.
const TRUST_CAVEAT = 'No trust list is checked: the certificate is not vouched for by a trusted authority, so this shows only that the manifest is unchanged since that certificate’s key signed it, not who signed it.';

function manifestHtml(m: C2paManifestReport, active: boolean) {
  const sig = m.signature;
  const list: Check[] = [
    !sig.checked
      ? [undefined, 'Not checked', `The signature uses ${sig.algorithm ?? 'an algorithm'} that cannot be checked here.`]
      : sig.valid
        ? [true, 'Matches', `The signature matches the certificate embedded in the file. ${TRUST_CAVEAT}`]
        : [false, 'Invalid', 'The signature does not match the manifest.'],
    m.unlisted.length
      ? [false, 'Unsigned', `The manifest holds assertions its claim does not list (${[...new Set(m.unlisted)].join(', ')}): they were added after signing and are ignored.`]
      : [m.assertionHashesValid, m.assertionHashesValid ? 'Intact' : 'Altered', m.assertionHashesValid ? 'Every assertion matches its hash in the claim.' : 'An assertion was changed after signing.'],
  ];
  if (m.binding === 'bound') list.push([true, 'Bound', 'The file’s bytes are exactly the ones that were signed.']);
  else if (m.binding === 'changed') list.push([false, 'Changed', 'The file was changed after signing (its bytes no longer match the signed hash).']);
  else if (m.binding === 'missing') list.push([false, 'Unbound', 'The manifest has no signed hash of this file, so it may describe a different file.']);
  else if (m.binding === 'unchecked') list.push([undefined, 'Not checked', 'The manifest is bound to the file in a way that cannot be checked here.']);
  const who = [sig.subject && `certificate names ${sig.subject}${sig.selfSigned ? ' (self-signed)' : sig.issuer ? `, issued by ${sig.issuer}` : ''}`, sig.notBefore && `certificate valid ${formatTime(sig.notBefore)} – ${formatTime(sig.notAfter ?? '')}`].filter(Boolean).join('; ');
  const actions = m.actions.slice(0, 200).map((a) => `<li>${escapeXML(a.description ?? a.action)}${(a.count ?? 1) > 1 ? ` ×${a.count}` : ''} <span class="prov-meta">${escapeXML(a.action)}${a.digitalSourceType ? ', AI-generated content' : ''}${a.when ? `, ${escapeXML(formatTime(a.when))}` : ''}</span></li>`);
  const ingredients = m.ingredients.map((i) => `<li>${escapeXML(i.title)} <span class="prov-meta">${escapeXML([i.relationship, i.format, i.sha256 && `SHA-256 ${i.sha256.slice(0, 12)}…`].filter(Boolean).join(', '))}</span></li>`);
  return `<section><h3>C2PA manifest${active ? ' (active)' : ''}</h3><p class="prov-note">${escapeXML([m.claimGenerator, m.title, m.format, who].filter(Boolean).join(' · '))}</p>${checks(list)}${m.errors.length ? `<p class="prov-note">${m.errors.map(escapeXML).join('<br>')}</p>` : ''}${ingredients.length ? `<h3>Ingredients</h3><ul class="prov-actions-list">${ingredients.join('')}</ul>` : ''}${actions.length ? `<h3>Actions</h3><ul class="prov-actions-list">${actions.join('')}</ul>` : ''}</section>`;
}

/** Report for file bytes, as HTML. */
export async function reportHtml(name: string, bytes: Uint8Array): Promise<{ html: string; found: boolean }> {
  const r = await inspectProvenance(bytes);
  const parts: string[] = [`<p class="prov-note">${escapeXML(name)} · ${escapeXML((r.format ?? 'unknown format').toUpperCase())} · ${formatSize(bytes.length)}</p>`];
  const found = !!(r.xmp || r.c2pa?.manifests.length);
  if (!found) parts.push(`<p>No provenance record or manifest was found in this file.</p>`);
  if (r.xmp) {
    const x = r.xmp;
    const pixel: Check = x.pixelHashMatches === undefined ? [undefined, 'No hash', 'The record has no pixel hash to compare.'] : x.pixelHashMatches ? [true, 'Match', 'The pixels are the ones that were exported.'] : [false, 'Differ', 'The pixels changed after the record was attached.'];
    parts.push(`<section><h3>Recorded history${x.title ? `: ${escapeXML(x.title)}` : ''}</h3>${checks([pixel])}${x.record ? `${summaryHtml(x.record)}${timelineHtml(x.record, 'all', 300)}` : '<p class="prov-note">Only a summary manifest is present (the full record did not fit).</p>'}</section>`);
  }
  r.c2pa?.manifests.forEach((m) => parts.push(manifestHtml(m, m.label === r.c2pa?.active)));
  if (r.c2pa?.errors.length) parts.push(`<p class="prov-note">${r.c2pa.errors.map(escapeXML).join('<br>')}</p>`);
  if (r.errors.length) parts.push(`<p class="prov-note">${r.errors.map(escapeXML).join('<br>')}</p>`);
  return { html: parts.join(''), found };
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,.webp,.tif,.tiff,image/png,image/jpeg,image/webp,image/tiff';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** File → Inspect Provenance…: pick a file and show its report. */
export async function inspectFile(e: Editor, file?: File | null) {
  file ??= await pickFile();
  if (!file) return;
  if (file.size > 512 * 1024 * 1024) throw new Error('The file is larger than 512 MB.');
  const { html } = await reportHtml(file.name, new Uint8Array(await file.arrayBuffer()));
  const done = await modal({ title: 'Provenance', className: 'inspect-provenance', body: `<div class="prov-report">${html}</div>`, submit: 'Done', extra: [{ id: 'another', label: 'Inspect Another…' }] });
  done?.close();
  if (done?.action === 'another') await inspectFile(e);
}
