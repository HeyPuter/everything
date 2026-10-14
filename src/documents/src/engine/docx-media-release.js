import { strToU8 } from 'fflate';
import { parseXml } from './docx-xml.js';

/**
 * Compress Pictures replaces pictures with smaller copies. Saving keeps every package part it did not
 * change, so the media a compressed picture no longer uses would otherwise stay in the file. For the
 * parts Compress released (and only those), drop relationships nothing references any more and then
 * the part itself, with its content-type override. A part still used anywhere is kept.
 */
const decode = bytes => typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sourceOf(relsPath) {
  const match = /^(.*?)_rels\/([^/]+)\.rels$/.exec(relsPath);
  return match ? `${match[1]}${match[2]}` : null;
}
function resolve(sourcePart, target) {
  try { return decodeURIComponent(new URL(target, `https://docx.invalid/${sourcePart}`).pathname).slice(1); } catch { return null; }
}

export function pruneReleasedMedia(parts, released) {
  if (!released?.size) return;
  for (const path of released) {
    if (!parts[path]) continue;
    let used = false;
    for (const relsPath of Object.keys(parts).filter(p => p.endsWith('.rels'))) {
      const source = sourceOf(relsPath);
      if (source === null) continue;
      const rels = parseXml(parts[relsPath]);
      let changed = false;
      for (const rel of [...rels.documentElement.children].filter(n => n.localName === 'Relationship')) {
        if (rel.getAttribute('TargetMode') === 'External' || resolve(source || '', rel.getAttribute('Target')) !== path) continue;
        const xml = parts[source] ? decode(parts[source]) : '';
        if (new RegExp(`="${escape(rel.getAttribute('Id'))}"`).test(xml)) { used = true; continue; }
        rel.remove(); changed = true;
      }
      if (changed) parts[relsPath] = strToU8(new XMLSerializer().serializeToString(rels));
    }
    if (used) continue;
    delete parts[path];
    const types = parseXml(parts['[Content_Types].xml']);
    for (const node of [...types.documentElement.children]) if (node.localName === 'Override' && node.getAttribute('PartName') === `/${path}`) node.remove();
    parts['[Content_Types].xml'] = strToU8(new XMLSerializer().serializeToString(types));
  }
}
