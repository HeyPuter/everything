import { parseXml } from './docx-xml.js';
import { partPathForUrl, relationshipPartPath } from './package-part-paths.js';

const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml', 'image/emf', 'image/wmf', 'image/x-emf', 'image/x-wmf']);

// Only referenced internal image parts are compared. Length/type buckets narrow
// candidates; byte-for-byte equality establishes identity without hash collisions.
// The returned tokens are comparison keys, never replacement relationship IDs.
export function drawingImageCorrespondence(parts, sourcePart) {
  let relationships, declarations;
  const keys = new Map(), buckets = new Map();
  let next = 0;
  return id => {
    if (keys.has(id)) return keys.get(id);
    let key;
    try {
      if (!relationships) {
        relationships = new Map();
        const path = relationshipPartPath(sourcePart), document = parts[path] ? parseXml(parts[path]) : null;
        for (const n of document?.documentElement.children || []) if (n.namespaceURI === REL && n.localName === 'Relationship') {
          const key = n.getAttribute('Id'), entries = relationships.get(key) || [];
          entries.push(n); relationships.set(key, entries);
        }
      }
      const matches = relationships.get(id) || [];
      if (matches.length !== 1) return undefined;
      const rel = matches[0], target = rel.getAttribute('Target');
      if (rel.getAttribute('Type') !== `${R}/image` || ![null, 'Internal'].includes(rel.getAttribute('TargetMode')) || !target) return undefined;
      const url = new URL(target, `https://docx.invalid/${sourcePart}`);
      if (url.origin !== 'https://docx.invalid' || url.search || url.hash) return undefined;
      const path = partPathForUrl(parts, url);
      if (!declarations) {
        declarations = { overrides: new Map(), defaults: new Map() };
        const types = parseXml(parts['[Content_Types].xml']);
        for (const n of types.documentElement.children) if (n.namespaceURI === CT && ['Override', 'Default'].includes(n.localName)) {
          const map = n.localName === 'Override' ? declarations.overrides : declarations.defaults;
          const name = n.localName === 'Override' ? n.getAttribute('PartName') : n.getAttribute('Extension')?.toLowerCase();
          const entries = map.get(name) || []; entries.push(n.getAttribute('ContentType')); map.set(name, entries);
        }
      }
      const declared = declarations.overrides.get(`/${path}`) || declarations.defaults.get(path.split('.').at(-1).toLowerCase()) || [];
      if (declared.length !== 1) return undefined;
      const mime = declared[0];
      if (!imageTypes.has(mime)) return undefined;
      const bytes = parts[path];
      if (!(bytes instanceof Uint8Array) || !bytes.length) return undefined;
      const bucketId = `${mime}:${bytes.length}`, bucket = buckets.get(bucketId) || [];
      const equal = bucket.find(candidate => candidate.bytes.every((value, i) => value === bytes[i]));
      if (equal) key = equal.key;
      else { key = `image-resource:${++next}`; bucket.push({ bytes, key }); buckets.set(bucketId, bucket); }
    } catch { /* Unresolved/invalid resources must keep their original identity. */ }
    keys.set(id, key);
    return key;
  };
}

export function drawingTextSourcePart(scene) {
  if (scene?.text?.paragraphs?.[0]?.pageStory) return scene.text.paragraphs[0].pageStory;
  for (const child of scene?.children || []) {
    const part = drawingTextSourcePart(child);
    if (part) return part;
  }
  return null;
}
