import { strToU8 } from 'fflate';
import { parseXml } from './docx-xml.js';

/**
 * The editor reads and writes the main document part at word/document.xml. OPC locates that part
 * through the package relationship of type …/officeDocument (ECMA-376 Part 2, §8.3 and Part 1,
 * §11.3.10), not by its name, and part names compare without regard to ASCII case (Part 2, §9.1.1.1).
 * Packages written by the Open XML SDK can name it word/document2.xml, and other producers write
 * the target as ./word/document.xml or with different capitals.
 *
 * A main part stored elsewhere in the word folder is renamed to word/document.xml together with its
 * relationships part, and the package relationship and content type entry are pointed at the new
 * name. Relationship targets of the part are relative to its folder, which stays the same, so they
 * resolve exactly as before. Packages that already name it word/document.xml are left untouched.
 */
const MAIN_RELATIONSHIP = /\/officeDocument$/;
const MAIN = 'word/document.xml';

const findPart = (parts, name) => Object.keys(parts).find(key => key.toLowerCase() === name.toLowerCase());

function mainTarget(rels) {
  const links = [...rels.documentElement.children].filter(n => n.localName === 'Relationship' && MAIN_RELATIONSHIP.test(n.getAttribute('Type') || '') && n.getAttribute('TargetMode') !== 'External');
  if (links.length !== 1) return null;
  const target = links[0].getAttribute('Target');
  if (!target || /[\\?#:]/.test(target)) return null;
  // The package relationships part belongs to the package root, so targets resolve from there.
  const path = [];
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (segment === '.') continue;
    if (!segment || segment === '..') return null;
    try { path.push(decodeURIComponent(segment)); } catch { return null; }
  }
  return { link: links[0], path: path.join('/') };
}

/** Rename the main document part to word/document.xml when it is stored under another name in word/. */
export function canonicalMainPart(parts) {
  if (!parts['_rels/.rels'] || !parts['[Content_Types].xml']) return parts;
  let rels;
  try { rels = parseXml(parts['_rels/.rels']); } catch { return parts; }
  const main = mainTarget(rels);
  if (!main) return parts;
  const source = findPart(parts, main.path) ?? findPart(parts, encodeURI(main.path));
  if (!source) return parts;
  const folder = source.slice(0, source.lastIndexOf('/') + 1);
  // Only a rename within word/ keeps every relative target the part and its relationships hold.
  if (source !== MAIN && (folder.toLowerCase() !== 'word/' || Object.hasOwn(parts, MAIN))) return parts;
  let types;
  try { types = parseXml(parts['[Content_Types].xml']); } catch { return parts; }
  const result = { ...parts };
  if (source !== MAIN) {
    result[MAIN] = parts[source]; delete result[source];
    const file = source.slice(folder.length), relsPart = findPart(parts, `${folder}_rels/${file}.rels`);
    delete result['word/_rels/document.xml.rels'];
    if (relsPart) { const bytes = parts[relsPart]; delete result[relsPart]; result['word/_rels/document.xml.rels'] = bytes; }
  }
  let changed = false;
  const names = new Set([source, main.path, encodeURI(main.path)].map(name => `/${name}`.toLowerCase()));
  for (const override of [...types.documentElement.children].filter(n => n.localName === 'Override')) {
    if (names.has((override.getAttribute('PartName') || '').toLowerCase()) && override.getAttribute('PartName') !== `/${MAIN}`) { override.setAttribute('PartName', `/${MAIN}`); changed = true; }
  }
  if (changed) result['[Content_Types].xml'] = strToU8(new XMLSerializer().serializeToString(types));
  if (!/^\/?word\/document\.xml$/.test(main.link.getAttribute('Target'))) {
    main.link.setAttribute('Target', MAIN);
    result['_rels/.rels'] = strToU8(new XMLSerializer().serializeToString(rels));
    changed = true;
  }
  return changed || source !== MAIN ? result : parts;
}
