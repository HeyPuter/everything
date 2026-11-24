import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';

const LABELS = PDFName.of('PageLabels');

/** The page label ranges as [first page index, label dictionary] pairs, from any number tree. */
function labelRanges(doc, tree) {
  const ranges = [];
  const seen = new Set();
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!(node instanceof PDFDict) || seen.has(node)) continue;
    seen.add(node);
    const nums = node.lookup(PDFName.of('Nums'));
    if (nums instanceof PDFArray)
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const key = nums.lookup(i);
        if (key instanceof PDFNumber && Number.isInteger(key.asNumber()))
          ranges.push([key.asNumber(), nums.get(i + 1)]);
      }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray)
      for (const kid of kids.asArray()) pending.push(doc.context.lookup(kid));
  }
  return ranges;
}

/**
 * Keep page labels (front matter in roman numerals, then 1, 2, 3, and so on) with their pages
 * when `count` pages are inserted at index `at` (positive) or removed from it (negative). Label
 * ranges begin at page indices, so without this they slid onto other pages. Inserted pages
 * continue the range before them.
 */
export function shiftPageLabels(doc, at, count) {
  const tree = doc.catalog.lookup(LABELS);
  if (!(tree instanceof PDFDict) || !count) return;
  const pages = doc.getPageCount();
  const total = count < 0 ? pages + count : pages;
  const starts = new Map();
  for (const [start, label] of labelRanges(doc, tree).sort((a, b) => a[0] - b[0])) {
    let next = start;
    if (count > 0 && start >= at && start > 0) next = start + count;
    // A range that began on a removed page now begins where its first remaining page lands,
    // unless the range after it starts there too; then that page belongs to the later range.
    if (count < 0 && start > at) next = Math.max(at, start + count);
    if (next < total) starts.set(next, label);
  }
  if (!starts.size) return;
  const nums = [...starts]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([start, label]) => [PDFNumber.of(start), label]);
  doc.catalog.set(LABELS, doc.context.obj({ Nums: nums }));
}

const STYLES = new Set(['D', 'R', 'r', 'A', 'a']);
/**
 * Each page's label as { style, prefix, value } (style one of D R r A a or null for a prefix
 * alone, prefix a string, value the number shown), or null for a page no range covers. Null
 * when the PDF has no page labels.
 */
export function pageLabelSpecs(doc) {
  const tree = doc.catalog.lookup(LABELS);
  if (!(tree instanceof PDFDict)) return null;
  const ranges = labelRanges(doc, tree)
    .filter(([start]) => start >= 0)
    .sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return null;
  const specs = [];
  let r = -1;
  for (let i = 0; i < doc.getPageCount(); i++) {
    while (r + 1 < ranges.length && ranges[r + 1][0] <= i) r++;
    const label = r >= 0 ? doc.context.lookup(ranges[r][1]) : null;
    if (!(label instanceof PDFDict)) {
      specs.push(null);
      continue;
    }
    const style = label.lookup(PDFName.of('S'));
    const prefix = label.lookup(PDFName.of('P'));
    const first = label.lookup(PDFName.of('St'));
    const name = style instanceof PDFName ? style.decodeText() : null;
    specs.push({
      style: STYLES.has(name) ? name : null,
      prefix:
        prefix instanceof PDFString || prefix instanceof PDFHexString ? prefix.decodeText() : '',
      value:
        (first instanceof PDFNumber && first.asNumber() >= 1 ? Math.floor(first.asNumber()) : 1) +
        i -
        ranges[r][0],
    });
  }
  return specs;
}

/**
 * Give the pages these labels (see pageLabelSpecs), one range per run of pages that count on
 * from each other. A page without a label shows its page number.
 */
export function setPageLabels(doc, specs) {
  const nums = [];
  let previous = null;
  specs.forEach((spec, i) => {
    const label = spec || { style: 'D', prefix: '', value: i + 1 };
    const continues =
      previous &&
      previous.style === label.style &&
      previous.prefix === label.prefix &&
      (label.style ? label.value === previous.value + 1 : true);
    previous = label;
    if (continues) return;
    const dict = {};
    if (label.style) dict.S = PDFName.of(label.style);
    if (label.prefix) dict.P = PDFHexString.fromText(label.prefix);
    if (label.style && label.value !== 1) dict.St = label.value;
    nums.push(PDFNumber.of(i), doc.context.obj(dict));
  });
  // Labels that are just the page numbers need no tree.
  const plain = specs.every(
    (spec, i) => !spec || (spec.style === 'D' && !spec.prefix && spec.value === i + 1),
  );
  if (plain) doc.catalog.delete(LABELS);
  else doc.catalog.set(LABELS, doc.context.obj({ Nums: nums }));
}
