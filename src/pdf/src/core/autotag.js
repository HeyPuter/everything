/**
 * Autotag: give an untagged PDF a tag tree, as Acrobat's "Automatically tag PDF" does, without
 * changing how any page looks. Page content is wrapped in marked-content sequences (BDC/EMC
 * with MCIDs, or /Artifact) and a tree of structure elements points at them:
 *
 *   Document → H1–H3 (ranked by font size, plus short bold lines) · P · L → LI → Lbl/LBody ·
 *              Figure (pictures, with their bounds, left without alternate text for the check
 *              to flag) · Link/Form/Annot (annotations, through object references)
 *
 * Text runs are grouped into lines by baseline and into paragraphs by size, spacing, and
 * alignment; page numbers and running headers or footers repeated in the page margins become
 * pagination artifacts, as do vector graphics and full-page backgrounds. The reading order is
 * the content-stream order. All of this is heuristic: it gives assistive technology a usable
 * structure for ordinary documents, not a substitute for checking the result. Tables are not
 * recognized (their cells become paragraphs).
 *
 * Only operator boundaries move: marked-content operators are inserted between existing
 * operators, never inside one, and each sequence opens and closes within the same q/Q, BT/ET,
 * and marked-content nesting, so rendering is unchanged. A page whose nesting is malformed is
 * left untagged and reported.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { setPageSource } from './text-edit.js';
import {
  allAnnotations,
  boundsArea,
  describeLinks,
  isPageNumberText,
  joinText,
  needsTag,
  normalizeRect,
  overlapArea,
  pageRect,
  readNumberTree,
  readStructure,
  scanPage,
  unionBounds,
} from './accessibility.js';

const N = PDFName.of;
const ARTIFACT = { S: 'Artifact', artifact: true };
const clean = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
// Bullets (including the Symbol/Wingdings private-use codes), dashes, and numbering.
const BULLET = /^[•‣⁃∙▪▫●○■□◆◇◦–—·➢➔✓✔✗✘*-](?=\s|$|\S)/u;
const NUMBERED = /^\(?(\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,5})[.)](?=\s|$)/;
const listMarker = (text) => {
  const value = clean(text);
  const bullet = value.match(BULLET);
  if (bullet && !/^[-*]\S/.test(value)) return bullet[0];
  return value.match(NUMBERED)?.[0] ?? null;
};

/** Group a page's text items (in content order) into lines by baseline and spacing. */
function buildLines(items) {
  const lines = [];
  let line = null;
  for (const item of items) {
    const size = item.size || 1;
    if (line) {
      const scale = Math.max(size, line.size || size);
      const shift = Math.abs(item.y - line.y);
      // Superscripts and subscripts (footnote marks, exponents) sit off the baseline.
      const sameBaseline =
        shift <= 0.35 * scale ||
        (shift <= 0.6 * (line.size || scale) && size < 0.85 * (line.size || scale));
      const gap = item.x - line.x1;
      if (sameBaseline && (!clean(item.text) || (gap > -0.5 * scale && gap < 2.5 * scale))) {
        line.items.push(item);
        line.x1 = Math.max(line.x1, item.x1);
        line.bounds = unionBounds(line.bounds, item.bounds);
        if (clean(item.text) && (!line.size || clean(item.text).length > line.weight)) {
          line.size = item.size;
          line.weight = clean(item.text).length;
        }
        continue;
      }
    }
    line = {
      items: [item],
      y: item.y,
      x0: item.x,
      x1: item.x1,
      bounds: item.bounds,
      size: clean(item.text) ? item.size : 0,
      weight: clean(item.text).length,
    };
    lines.push(line);
  }
  for (const entry of lines) {
    entry.size ||= Math.max(...entry.items.map((item) => item.size || 0));
    entry.text = joinText(entry.items);
    const visible = entry.items.filter((item) => clean(item.text));
    entry.bold = visible.length > 0 && visible.every((item) => item.bold);
  }
  // A line is alone when nothing else sits on its baseline (it is not one cell of a row).
  if (lines.length < 2000)
    for (const entry of lines)
      entry.alone = !lines.some(
        (other) =>
          other !== entry &&
          clean(other.text) &&
          Math.abs(other.y - entry.y) <= 0.35 * Math.max(other.size, entry.size) &&
          (other.x1 < entry.x0 || other.x0 > entry.x1),
      );
  return lines;
}

/** Whether `line` continues the paragraph that ends with `previous`. */
function continues(previous, line) {
  const size = Math.max(previous.size, line.size) || 1;
  if (Math.abs(previous.size - line.size) > 0.15 * size) return false;
  if (previous.bold !== line.bold) return false;
  const step = previous.y - line.y;
  if (!(step > 0.3 * size && step <= 2 * size)) return false;
  return line.x0 < previous.x1 + size && line.x1 > previous.x0 - size;
}

/** The text-size class most of the document's text uses. */
function bodySize(lines) {
  const weights = new Map();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weights.set(key, (weights.get(key) || 0) + clean(line.text).length);
  }
  let best = 0,
    weight = -1;
  for (const [key, value] of weights)
    if (value > weight || (value === weight && key < best)) {
      best = key;
      weight = value;
    }
  return best;
}

/** Whether bounds lie wholly in the top or bottom 8% of the page. */
const inMargin = (bounds, rect) => {
  if (!bounds) return false;
  const band = 0.08 * (rect[3] - rect[1]);
  return bounds[1] >= rect[3] - band || bounds[3] <= rect[1] + band;
};
const marginKey = (text) => clean(text).toLowerCase().replace(/\d+/g, '#');

/** The StructTreeRoot's reference, registering a direct root first. */
function rootReference(doc, root) {
  let ref = doc.catalog.get(N('StructTreeRoot'));
  if (!(ref instanceof PDFRef)) {
    ref = doc.context.register(root);
    doc.catalog.set(N('StructTreeRoot'), ref);
  }
  return ref;
}

/** Rewrite the parent tree as one flat number tree with `entries` (key → value). */
function writeParentTree(doc, root, entries) {
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  const nums = [];
  for (const [key, value] of sorted) nums.push(PDFNumber.of(key), value);
  root.set(N('ParentTree'), doc.context.register(doc.context.obj({ Nums: nums })));
  root.set(N('ParentTreeNextKey'), PDFNumber.of(sorted.length ? sorted.at(-1)[0] + 1 : 0));
}
const nextKey = (doc, root, entries) => {
  const declared = root.lookup(N('ParentTreeNextKey'));
  let key = declared instanceof PDFNumber ? declared.asNumber() : 0;
  for (const existing of entries.keys()) key = Math.max(key, existing + 1);
  return key;
};

const annotationRole = (subtype) =>
  subtype === 'Link' ? 'Link' : subtype === 'Widget' ? 'Form' : 'Annot';

/**
 * Tag annotations that are not yet in the tag tree of a tagged document: each gets a Link,
 * Form, or Annot element (appended to the document element) with an object reference, a
 * StructParent, and a parent-tree entry. Pages with annotations tab in structure order.
 */
export function tagAnnotations(doc) {
  const structure = readStructure(doc);
  if (!structure?.elements.length) throw new Error('Tag the document before tagging annotations.');
  const missing = allAnnotations(doc).filter(
    (a) => needsTag(a) && a.ref instanceof PDFRef && !structure.annotations.has(a.dict),
  );
  if (!missing.length) return false;
  const root = structure.root;
  const rootRef = rootReference(doc, root);
  const container =
    structure.top.children.length === 1 && structure.top.children[0].ref
      ? structure.top.children[0]
      : null;
  const parentRef = container ? container.ref : rootRef;
  const parentDict = container ? container.dict : root;
  const entries = readNumberTree(doc, root.get(N('ParentTree')));
  let key = nextKey(doc, root, entries);
  const pages = doc.getPages();
  const added = [];
  for (const annotation of missing) {
    const page = pages[annotation.page];
    const element = doc.context.obj({
      Type: 'StructElem',
      S: annotationRole(annotation.subtype),
      P: parentRef,
      Pg: page.ref,
      K: [doc.context.obj({ Type: 'OBJR', Obj: annotation.ref, Pg: page.ref })],
    });
    const ref = doc.context.register(element);
    annotation.dict.set(N('StructParent'), PDFNumber.of(key));
    entries.set(key++, ref);
    added.push(ref);
    page.node.set(N('Tabs'), N('S'));
  }
  appendKids(doc, parentDict, added);
  writeParentTree(doc, root, entries);
}

function appendKids(doc, dict, refs) {
  const existing = dict.get(N('K'));
  const resolved = existing instanceof PDFRef ? doc.context.lookup(existing) : existing;
  const list =
    resolved instanceof PDFArray ? resolved.asArray() : existing !== undefined ? [existing] : [];
  dict.set(N('K'), doc.context.obj([...list, ...refs]));
}

/**
 * Tag the document. Untagged documents get a full tag tree; a tagged document whose pages have
 * content outside tags (added later, for instance) gets that content tagged as paragraphs and
 * figures appended to the document element. Returns what was done:
 * `{ pages, skipped: [page indices left untagged], elements: { P: n, H1: n, … } }`, or false
 * when there was nothing to tag. `lang` sets the document language when given.
 */
export function autotagDocument(doc, { lang } = {}) {
  const pages = doc.getPages();
  const structure = readStructure(doc);
  const incremental = !!structure?.elements.length;
  const counts = {};
  const count = (type) => (counts[type] = (counts[type] || 0) + 1);

  // -- Read every page --------------------------------------------------------------------
  const skipped = [];
  const pageData = pages.map((page, index) => {
    const scan = scanPage(doc, page);
    if (scan.error || scan.irregular) {
      if (scan.error || scan.items.length) skipped.push(index);
      return null;
    }
    const candidates = scan.items.filter(
      (item) => item.mcid === undefined && !item.artifact && !item.tagged,
    );
    if (!candidates.length) return { scan, owners: new Map(), units: [], lines: [] };
    const rect = pageRect(page);
    const texts = candidates.filter((item) => item.kind === 'text');
    const lines = buildLines(texts);
    const height = rect[3] - rect[1];
    for (const line of lines)
      line.margin =
        line.y > rect[3] - 0.08 * height
          ? 'top'
          : line.y < rect[1] + 0.08 * height
            ? 'bottom'
            : null;
    return { scan, candidates, rect, lines, owners: new Map(), units: [] };
  });

  // Running headers and footers: margin lines that repeat across pages, and page numbers.
  const repeats = new Map();
  pageData.forEach((data, index) => {
    for (const line of data?.lines || [])
      if (line.margin && clean(line.text)) {
        const key = `${line.margin}:${marginKey(line.text)}`;
        if (!repeats.has(key)) repeats.set(key, new Set());
        repeats.get(key).add(index);
      }
  });
  const repeatThreshold = Math.max(2, Math.ceil(0.3 * pages.length));
  // Forms drawn in the margins of many pages (letterheads, banners) are running content too.
  const formPages = new Map();
  pageData.forEach((data, index) => {
    for (const item of data?.candidates || [])
      if (item.kind === 'form' && inMargin(item.bounds, data.rect)) {
        if (!formPages.has(item.object)) formPages.set(item.object, new Set());
        formPages.get(item.object).add(index);
      }
  });
  for (const data of pageData)
    for (const line of data?.lines || [])
      line.artifact =
        !!line.margin &&
        (isPageNumberText(line.text) ||
          (repeats.get(`${line.margin}:${marginKey(line.text)}`)?.size ?? 0) >= repeatThreshold);
  const body = bodySize(
    pageData.flatMap((data) => (data?.lines || []).filter((line) => !line.artifact)),
  );

  // -- Paragraphs, headings, list items, figures ------------------------------------------
  for (const data of pageData) {
    if (!data?.candidates) continue;
    const { lines, owners, rect, candidates } = data;
    const order = new Map(data.scan.items.map((item, index) => [item, index]));
    const blocks = [];
    let current = null;
    for (const line of lines) {
      if (line.artifact) {
        for (const item of line.items) owners.set(item, ARTIFACT);
        current = null;
        continue;
      }
      const marker = listMarker(line.text);
      if (current && !marker && continues(current.lines.at(-1), line)) current.lines.push(line);
      else blocks.push((current = { lines: [line], marker }));
    }
    for (const block of blocks) {
      block.items = block.lines.flatMap((line) => line.items);
      block.text = joinText(block.items);
      block.size = block.lines[0].size;
      block.bold = block.lines.every((line) => line.bold);
      block.bounds = block.lines.reduce((b, line) => unionBounds(b, line.bounds), null);
      block.first = Math.min(...block.items.map((item) => order.get(item)));
      if (!clean(block.text)) block.kind = 'blank';
      else if (incremental) block.kind = 'P';
      else {
        const short =
          block.lines.length <= 3 && block.text.length <= 200 && /\p{L}/u.test(block.text);
        const big = body > 0 && block.size >= body * 1.15;
        const strong =
          block.bold &&
          body > 0 &&
          block.size >= body * 0.95 &&
          block.lines.length <= 2 &&
          block.text.length <= 120 &&
          block.lines.every((line) => line.alone) &&
          !/[.,;]$/.test(block.text);
        block.kind = short && (big || strong) ? 'heading' : block.marker ? 'item' : 'P';
        block.rank = Math.round(block.size * 2) / 2 + (block.bold ? 0.25 : 0);
      }
      data.units.push(block);
    }
    const pageArea = (rect[2] - rect[0]) * (rect[3] - rect[1]);
    const hasText = candidates.some((item) => item.kind === 'text' && clean(item.text));
    for (const item of candidates) {
      if (item.kind === 'text') continue;
      let kind = 'artifact';
      if (item.kind === 'image') {
        const visible = item.bounds ? overlapArea(item.bounds, rect) : 0;
        const width = item.bounds ? item.bounds[2] - item.bounds[0] : 0;
        const height = item.bounds ? item.bounds[3] - item.bounds[1] : 0;
        const background = hasText && visible >= 0.85 * pageArea;
        kind = background || width < 6 || height < 6 || !visible ? 'artifact' : 'figure';
      } else if (item.kind === 'form') {
        const running = (formPages.get(item.object)?.size ?? 0) >= repeatThreshold;
        kind = running
          ? 'artifact'
          : item.summary.hasText
            ? 'P'
            : item.summary.hasImage
              ? 'figure'
              : 'artifact';
      }
      if (kind === 'artifact') owners.set(item, ARTIFACT);
      else
        data.units.push({
          kind,
          items: [item],
          first: order.get(item),
          bounds: item.bounds,
          text: item.summary?.text ?? '',
        });
    }
    data.units.sort((a, b) => a.first - b.first);
    for (const unit of data.units)
      if (unit.kind === 'blank') for (const item of unit.items) owners.set(item, ARTIFACT);
    data.units = data.units.filter((unit) => unit.kind !== 'blank');
  }

  // Heading levels: the largest heading style is H1, the next H2, the rest H3; then no level
  // may go more than one deeper than the heading before it.
  const ranks = [
    ...new Set(
      pageData.flatMap((data) =>
        (data?.units || []).filter((u) => u.kind === 'heading').map((u) => u.rank),
      ),
    ),
  ].sort((a, b) => b - a);
  let previousLevel = 0;
  for (const data of pageData)
    for (const unit of data?.units || [])
      if (unit.kind === 'heading') {
        unit.level = Math.min(3, ranks.indexOf(unit.rank) + 1, previousLevel + 1);
        previousLevel = unit.level;
      }

  // -- Structure elements -----------------------------------------------------------------
  const elements = [];
  const element = (S, parent, page, extra = {}) => {
    const record = { S, parent, page, kids: [], attached: false, ...extra };
    elements.push(record);
    return record;
  };
  const attach = (record) => {
    if (record.attached || !record.parent) return;
    attach(record.parent);
    record.parent.kids.push(record);
    record.attached = true;
  };
  const top = element(incremental ? null : 'Document', null, null);
  top.attached = true;
  const annotations = allAnnotations(doc);
  const annotationElements = new Map();
  pages.forEach((page, index) => {
    const data = pageData[index];
    const units = data?.units || [];
    const owners = data?.owners;
    for (let u = 0; u < units.length; u++) {
      const unit = units[u];
      if (unit.kind === 'item') {
        // Two or more consecutive items make a list; a lone numbered line stays a paragraph.
        let end = u;
        while (end + 1 < units.length && units[end + 1].kind === 'item') end++;
        if (end > u || BULLET.test(clean(unit.text))) {
          const list = element('L', top, page);
          attach(list);
          for (let k = u; k <= end; k++) {
            const block = units[k];
            const item = element('LI', list, page);
            attach(item);
            const [first, ...rest] = block.items.filter((entry) => clean(entry.text));
            const bodyEl = element('LBody', item, page);
            if (first && clean(first.text) === block.marker && rest.length) {
              const label = element('Lbl', item, page);
              attach(label);
              owners.set(first, label);
            }
            for (const entry of block.items) if (!owners.has(entry)) owners.set(entry, bodyEl);
            block.leaf = bodyEl;
            count('LI');
          }
          count('L');
          u = end;
          continue;
        }
        unit.kind = 'P';
      }
      const S =
        unit.kind === 'heading' ? `H${unit.level}` : unit.kind === 'figure' ? 'Figure' : 'P';
      const record = element(S, top, page);
      if (S === 'Figure' && unit.bounds)
        record.attributes = {
          O: 'Layout',
          BBox: unit.bounds.map((v) => Math.round(v * 100) / 100),
        };
      attach(record);
      for (const item of unit.items) owners.set(item, record);
      unit.leaf = record;
      count(S);
    }
    // Annotations of a tagged document are left to tagAnnotations below.
    if (incremental) return;
    for (const annotation of annotations) {
      if (annotation.page !== index || !needsTag(annotation)) continue;
      if (!(annotation.ref instanceof PDFRef)) continue;
      const role = annotationRole(annotation.subtype);
      if (role !== 'Link') {
        // Fields and comments follow their page's content.
        const record = element(role, top, page, { annotation });
        attach(record);
        annotationElements.set(annotation.dict, record);
        count(role);
        continue;
      }
      // Text under a link moves into a Link element inside its paragraph.
      const rect = annotation.dict
        .lookup(N('Rect'))
        ?.asArray?.()
        .map((n) => n.asNumber?.());
      const area = rect?.length === 4 && rect.every(Number.isFinite) ? normalizeRect(rect) : null;
      let link = null;
      for (const [item, owner] of owners || []) {
        if (!area || item.kind !== 'text' || owner === ARTIFACT || owner.S === 'Lbl') continue;
        if (owner.S === 'Link' || (link && link.parent !== owner)) continue;
        if (overlapArea(item.bounds, area) < 0.5 * boundsArea(item.bounds)) continue;
        link ??= element('Link', owner, page, { annotation });
        owners.set(item, link);
      }
      if (!link) {
        // No text under it: the Link joins the unit it overlaps most, else follows the page.
        let best = null,
          bestArea = 0;
        for (const unit of units) {
          const overlap = area ? overlapArea(unit.bounds, area) : 0;
          if (unit.leaf && overlap > bestArea) {
            best = unit.leaf;
            bestArea = overlap;
          }
        }
        link = element('Link', best ?? top, page, { annotation, late: !!best });
        if (!best) attach(link);
      }
      annotationElements.set(annotation.dict, link);
      count('Link');
    }
  });

  // -- Marked content ---------------------------------------------------------------------
  const parentEntries = incremental
    ? readNumberTree(doc, structure.root.get(N('ParentTree')))
    : new Map();
  const pageKeys = new Map();
  // MCIDs the tag tree still gives to a page whose content has since lost them (a text layer
  // recognized again) are not handed out again, or their old elements would read the new text.
  const claimedEnd = new Map();
  for (const element of structure?.elements || [])
    for (const { page, mcid, stream } of element.mcids)
      if (!stream && page !== undefined)
        claimedEnd.set(page, Math.max(claimedEnd.get(page) ?? 0, mcid + 1));
  const parentArrayLength = (page) => {
    const key = page.node.lookup(N('StructParents'));
    const value =
      key instanceof PDFNumber ? doc.context.lookup(parentEntries.get(key.asNumber())) : null;
    return value instanceof PDFArray ? value.size() : 0;
  };
  let changedPages = 0;
  pages.forEach((page, index) => {
    const data = pageData[index];
    if (!data?.candidates || !data.owners.size) return;
    const { scan, owners } = data;
    const items = scan.items;
    // A sequence may span the items of one owner that share their marked-content frame. Its
    // operators go just around those items; when that also keeps it balanced with q/Q and
    // BT/ET, the operators move out to enclose whole groups, which readers handle best.
    const hoist = !scan.crossed;
    const startAnchors = (k) => {
      let group = items[k].group;
      const anchors = [{ group, offset: items[k].start }];
      while (hoist && group.parent && group.first === k && group.opened === items[k].marked) {
        anchors.push({ group: group.parent, offset: group.start });
        group = group.parent;
      }
      return anchors;
    };
    const endAnchors = (k) => {
      let group = items[k].group;
      const anchors = [{ group, offset: items[k].end }];
      while (
        hoist &&
        group.parent &&
        group.last === k &&
        group.end !== null &&
        group.closed === items[k].marked
      ) {
        anchors.push({ group: group.parent, offset: group.end });
        group = group.parent;
      }
      return anchors;
    };
    const sequences = [];
    let open = null;
    const close = () => {
      if (!open) return;
      const starts = startAnchors(open.first),
        ends = endAnchors(open.last);
      let start = starts[0],
        end = ends[0];
      for (const candidate of starts) {
        const match = ends.find((anchor) => anchor.group === candidate.group);
        if (match) {
          [start, end] = [candidate, match];
          break;
        }
      }
      sequences.push({
        owner: open.owner,
        start: start.offset,
        end: end.offset,
      });
      open = null;
    };
    for (let k = 0; k < items.length; k++) {
      const owner = owners.get(items[k]);
      if (!owner) {
        close();
        continue;
      }
      if (open && open.owner === owner && items[open.first].marked === items[k].marked) {
        open.last = k;
        continue;
      }
      close();
      open = { owner, first: k, last: k };
    }
    close();
    if (!sequences.length) return;
    let mcid = incremental
      ? Math.max(scan.maxMcid + 1, claimedEnd.get(index) ?? 0, parentArrayLength(page))
      : 0;
    const parents = [];
    const edits = [];
    for (const sequence of sequences) {
      if (sequence.owner === ARTIFACT) {
        edits.push({
          at: sequence.start,
          text: '\n/Artifact BMC\n',
          open: true,
        });
        count('Artifact');
      } else {
        const owner = sequence.owner;
        attach(owner);
        owner.kids.push(mcid);
        parents[mcid] = owner;
        edits.push({
          at: sequence.start,
          text: `\n/${owner.S} <</MCID ${mcid}>> BDC\n`,
          open: true,
        });
        mcid++;
      }
      edits.push({ at: sequence.end, text: '\nEMC\n', open: false });
    }
    // Apply from the end; at one offset a sequence closes before the next one opens.
    edits.sort((a, b) => b.at - a.at || (a.open === b.open ? 0 : a.open ? -1 : 1));
    let source = scan.source;
    for (const edit of edits) source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
    setPageSource(doc, page, source);
    pageKeys.set(index, parents);
    changedPages++;
  });

  if (incremental && !changedPages) {
    const tagged = tagAnnotations(doc);
    return tagged === false ? false : { pages: 0, skipped, elements: counts };
  }

  // -- Write the tree ---------------------------------------------------------------------
  const context = doc.context;
  let root = structure?.root;
  if (!root) {
    root = context.obj({ Type: 'StructTreeRoot' });
    doc.catalog.set(N('StructTreeRoot'), context.register(root));
  }
  const rootRef = rootReference(doc, root);
  const container = incremental
    ? structure.top.children.length === 1 && structure.top.children[0].ref
      ? structure.top.children[0]
      : null
    : null;
  const topRef = incremental ? (container ? container.ref : rootRef) : null;

  // Links with no text under them close the paragraph they overlap.
  for (const record of annotationElements.values()) if (record.late) attach(record);

  // Drop elements left without content (a list body whose only text was its label).
  const keep = (record) => {
    record.kids = record.kids.filter((kid) => typeof kid === 'number' || keep(kid));
    return record.kids.length > 0 || !!record.annotation;
  };
  keep(top);
  const live = [];
  const collect = (record) => {
    for (const kid of record.kids)
      if (typeof kid !== 'number') {
        live.push(kid);
        collect(kid);
      }
  };
  collect(top);
  if (!incremental) {
    top.dict = context.obj({ Type: 'StructElem', S: 'Document', P: rootRef });
    top.ref = context.register(top.dict);
  }
  for (const record of live) {
    record.dict = context.obj({ Type: 'StructElem', S: record.S });
    if (record.page) record.dict.set(N('Pg'), record.page.ref);
    record.ref = context.register(record.dict);
  }
  for (const record of live) {
    record.dict.set(
      N('P'),
      record.parent === top ? (incremental ? topRef : top.ref) : record.parent.ref,
    );
    const kids = record.kids.map((kid) => (typeof kid === 'number' ? PDFNumber.of(kid) : kid.ref));
    if (record.annotation)
      kids.push(
        context.obj({
          Type: 'OBJR',
          Obj: record.annotation.ref,
          Pg: pages[record.annotation.page].ref,
        }),
      );
    record.dict.set(N('K'), context.obj(kids));
    if (record.attributes) record.dict.set(N('A'), context.obj(record.attributes));
  }
  const topKids = top.kids.map((kid) => kid.ref);
  if (incremental) appendKids(doc, container ? container.dict : root, topKids);
  else {
    top.dict.set(N('K'), context.obj(topKids));
    root.set(N('K'), context.obj([top.ref]));
  }

  // Parent tree: one array per page (MCID → element), one entry per annotation.
  let key = nextKey(doc, root, parentEntries);
  for (const [index, parents] of pageKeys) {
    const page = pages[index];
    const existing = page.node.lookup(N('StructParents'));
    let pageKey = existing instanceof PDFNumber ? existing.asNumber() : null;
    let array = [];
    if (pageKey !== null) {
      const value = context.lookup(parentEntries.get(pageKey));
      if (value instanceof PDFArray) array = value.asArray();
    } else {
      pageKey = key++;
      page.node.set(N('StructParents'), PDFNumber.of(pageKey));
    }
    const merged = [...array];
    parents.forEach((owner, mcid) => {
      while (merged.length < mcid) merged.push(PDFNull);
      merged[mcid] = owner.ref;
    });
    parentEntries.set(pageKey, context.obj(merged.map((entry) => entry ?? PDFNull)));
  }
  for (const [dict, record] of annotationElements) {
    if (!record.ref) continue;
    dict.set(N('StructParent'), PDFNumber.of(key));
    parentEntries.set(key++, record.ref);
  }
  writeParentTree(doc, root, parentEntries);

  let markInfo = doc.catalog.lookup(N('MarkInfo'));
  if (!(markInfo instanceof PDFDict)) {
    markInfo = context.obj({});
    doc.catalog.set(N('MarkInfo'), markInfo);
  }
  markInfo.set(N('Marked'), PDFBool.True);
  if (lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang))
    doc.catalog.set(N('Lang'), PDFString.of(lang));
  for (const page of pages) if (hasAnnotations(page)) page.node.set(N('Tabs'), N('S'));
  if (incremental) tagAnnotations(doc);
  describeLinks(doc);
  return { pages: changedPages, skipped, elements: counts };
}

function hasAnnotations(page) {
  const value = page.node.lookup(N('Annots'));
  return value instanceof PDFArray && value.size() > 0;
}
