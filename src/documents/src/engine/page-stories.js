import { parseXml } from './docx-xml.js';
import { UnsupportedDocumentError } from './errors.js';
import { readPageNumbering } from './page-numbering.js';
import { contentTypeOverride, packagePartName } from './package-part-paths.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
const fail = detail => { throw new UnsupportedDocumentError(detail); };
const children = (node, name) => [...(node?.children || [])].filter(n => n.namespaceURI === W && n.localName === name);

function flag(parent, name) {
  const nodes = children(parent, name);
  if (nodes.length > 1) fail(`duplicate ${name}`);
  if (!nodes.length) return false;
  const value = nodes[0].getAttributeNS(W, 'val');
  if (value === null || ['1', 'true', 'on'].includes(value)) return true;
  if (['0', 'false', 'off'].includes(value)) return false;
  fail(`invalid ${name}`);
}

function targetPath(target) {
  if (!target || /[\\?#:\s]/.test(target) || target.startsWith('//') || /%(?![0-9a-f]{2})|%2f|%5c/i.test(target)) fail('an invalid header/footer target');
  const path = target.startsWith('/') ? [] : ['word'];
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (segment === '..') { if (!path.length) fail('a header/footer target outside the package'); path.pop(); }
    else if (segment !== '.') { if (!segment) fail('an invalid header/footer target'); path.push(segment); }
  }
  return path.join('/');
}

// Section references inherit independently for each first/even/default story.
// Missing first/even stories remain blank; they do not fall back to default.
export function readPageStories(parts, sectionNodes, settings, onUnsupported = null) {
  const rels = parts['word/_rels/document.xml.rels'] ? parseXml(parts['word/_rels/document.xml.rels']).documentElement : null;
  const types = parseXml(parts['[Content_Types].xml']).documentElement;
  const stories = {}, sections = [];
  let inherited = { header: {}, footer: {} };
  for (const section of sectionNodes) {
    const current = { header: { ...inherited.header }, footer: { ...inherited.footer }, firstPageDifferent: flag(section, 'titlePg') };
    const pageNumbering = readPageNumbering(section);
    if (pageNumbering) current.pageNumbering = pageNumbering;
    for (const kind of ['header', 'footer']) {
      const references = children(section, kind + 'Reference'), counts = new Map();
      for (const ref of references) {
        const variant = ref.getAttributeNS(W, 'type');
        counts.set(variant, (counts.get(variant) || 0) + 1);
      }
      for (const ref of references) {
        const variant = ref.getAttributeNS(W, 'type'), id = ref.getAttributeNS(R, 'id');
        try {
          if (!['default', 'first', 'even'].includes(variant) || counts.get(variant) > 1 || !id) fail(`invalid or duplicate ${kind} reference`);
          const links = [...(rels?.children || [])].filter(n => n.namespaceURI === REL && n.localName === 'Relationship' && n.getAttribute('Id') === id);
          if (links.length !== 1 || links[0].getAttribute('Type') !== R + '/' + kind || ![null, 'Internal'].includes(links[0].getAttribute('TargetMode'))) fail(`invalid or external ${kind} relationship`);
          const path = packagePartName(parts, targetPath(links[0].getAttribute('Target')));
          if (!path) fail(`a missing ${kind} part`);
          const override = contentTypeOverride(types, path);
          const type = override || [...types.children].find(n => n.localName === 'Default' && n.getAttribute('Extension')?.toLowerCase() === path.split('.').at(-1).toLowerCase());
          if (type?.getAttribute('ContentType') !== TYPE + kind + '+xml') fail(`incorrect ${kind} content type`);
          const root = parseXml(parts[path]).documentElement;
          if (root.namespaceURI !== W || root.localName !== (kind === 'header' ? 'hdr' : 'ftr')) fail(`invalid ${kind} root`);
          stories[path] = { kind };
          current[kind][variant] = path;
        } catch (error) {
          if (!onUnsupported || !(error instanceof UnsupportedDocumentError)) throw error;
          // An explicit failed replacement is blank, not an instruction to
          // inherit the previous section's story. Duplicate variants are all
          // rejected rather than selecting an arbitrary first declaration.
          if (['default', 'first', 'even'].includes(variant)) delete current[kind][variant];
          onUnsupported(error);
        }
      }
    }
    sections.push(current); inherited = current;
  }
  return { sections, stories, evenAndOdd: flag(settings, 'evenAndOddHeaders') };
}

export function pageStoryPath(definition, sectionIndex, kind, pageNumber, firstPageInSection) {
  const section = definition.sections[sectionIndex];
  if (!section || !['header', 'footer'].includes(kind) || !Number.isInteger(pageNumber) || pageNumber < 0) throw new Error('Invalid page story selection.');
  const variant = firstPageInSection && section.firstPageDifferent ? 'first' : definition.evenAndOdd && pageNumber % 2 === 0 ? 'even' : 'default';
  return section[kind][variant] || null;
}

// Include every story that can become visible as body edits change pagination.
// Disabled first/even references still inherit and retain their package parts.
export function activePageStoryPaths(definition) {
  const paths = new Set();
  for (const section of definition.sections) for (const kind of ['header', 'footer']) {
    for (const variant of ['default', ...(section.firstPageDifferent ? ['first'] : []), ...(definition.evenAndOdd ? ['even'] : [])]) {
      if (section[kind][variant]) paths.add(section[kind][variant]);
    }
  }
  return paths;
}
