/**
 * WordprocessingML (DOCX) from an export document model (see export-layout.js).
 *
 *   writeDocx(model, { title, author, signal }) -> Promise<Uint8Array>
 *
 * Each PDF page becomes a section with the page's size, orientation and margins (so pages break
 * where the PDF's did); two-column bands become continuous two-column sections. Headings use
 * Heading 1-6 styles, lists use numbering.xml, tables are w:tbl, and pictures are embedded
 * (JPEG as is, everything else as PNG) inline in the text flow or anchored behind it.
 */
import {
  xml,
  XML_HEADER,
  zipPackage,
  contentTypes,
  relationships,
  documentProperties,
  CORE_TYPES,
} from './ooxml-zip.js';
import { textOf } from './export-layout.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
const twips = (pt) => Math.max(0, Math.round(pt * 20));
const emu = (pt) => Math.max(1, Math.round(pt * 12700));
const halfPoints = (pt) => Math.max(2, Math.min(3276, Math.round(pt * 2)));
const lineUnit = (font) => (/calibri|cambria|open sans|segoe/i.test(font || '') ? 1.22 : 1.15);
const FORMATS = {
  bullet: 'bullet',
  decimal: 'decimal',
  lowerLetter: 'lowerLetter',
  upperLetter: 'upperLetter',
  lowerRoman: 'lowerRoman',
  upperRoman: 'upperRoman',
};
const BULLET_CHARS = ['•', 'o', '▪'];

// Word tags Chinese, Japanese, and Korean characters with the East Asian language, and the
// characters of complex scripts (right-to-left and Indic, Thai, and their kin) with the "bidi"
// one; the plain language covers the rest.
const EAST_ASIAN = new Set(['ja', 'zh', 'ko']);
const RIGHT_TO_LEFT = 'ar he iw fa ur yi ps sd ug dv ckb syr';
const COMPLEX = new Set(
  `${RIGHT_TO_LEFT} th lo km my hi mr ne sa bn as pa gu or ta te kn ml si bo`.split(' '),
);
/** The document's default languages, from the PDF's own (US English when it names none). */
function languageXml(lang) {
  lang ||= 'en-US';
  const primary = lang.split('-')[0].toLowerCase();
  const eastAsia = EAST_ASIAN.has(primary) ? lang : 'en-US';
  const bidi = COMPLEX.has(primary) ? lang : 'ar-SA';
  return `<w:lang w:val="${xml(lang)}" w:eastAsia="${xml(eastAsia)}" w:bidi="${xml(bidi)}"/>`;
}

class DocxWriter {
  constructor(model, options) {
    this.model = model;
    this.options = options;
    this.body = model.body;
    this.media = new Map(); // picture key -> { rid, name }
    this.rels = [];
    this.nextRel = 1;
    this.drawingId = 1;
    this.lists = new Map(); // instance -> { levels: [{ format, pattern, start }] }
  }

  rel(type, target) {
    const id = `rId${this.nextRel++}`;
    this.rels.push({ id, type, target });
    return id;
  }

  picture(picture) {
    let entry = this.media.get(picture.key);
    if (!entry) {
      const name = `image${this.media.size + 1}.${picture.extension}`;
      entry = { rid: this.rel('image', `media/${name}`), name, picture };
      this.media.set(picture.key, entry);
    }
    return entry;
  }

  runProps(run, { inHeading = false } = {}) {
    const parts = [];
    if (run.font && run.font !== this.body.font)
      parts.push(
        `<w:rFonts w:ascii="${xml(run.font)}" w:hAnsi="${xml(run.font)}" w:cs="${xml(run.font)}" w:eastAsia="${xml(run.font)}"/>`,
      );
    if (run.bold) parts.push('<w:b/><w:bCs/>');
    else if (inHeading) parts.push('<w:b w:val="0"/><w:bCs w:val="0"/>');
    if (run.italic) parts.push('<w:i/><w:iCs/>');
    if (run.strike) parts.push('<w:strike/>');
    if (run.color && run.color !== '000000') parts.push(`<w:color w:val="${run.color}"/>`);
    if (run.size && Math.abs(run.size - this.body.size) > 0.2)
      parts.push(
        `<w:sz w:val="${halfPoints(run.size)}"/><w:szCs w:val="${halfPoints(run.size)}"/>`,
      );
    if (run.underline) parts.push('<w:u w:val="single"/>');
    if (run.script)
      parts.push(
        `<w:vertAlign w:val="${run.script === 'superscript' ? 'superscript' : 'subscript'}"/>`,
      );
    return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
  }

  runs(runs, options = {}) {
    let out = '';
    for (const run of runs) {
      const props = this.runProps(run, options);
      if (run.tab) {
        out += `<w:r>${props}<w:tab/></w:r>`;
        continue;
      }
      if (run.field) {
        out +=
          `<w:r>${props}<w:fldChar w:fldCharType="begin"/></w:r>` +
          `<w:r>${props}<w:instrText xml:space="preserve"> ${run.field} </w:instrText></w:r>` +
          `<w:r>${props}<w:fldChar w:fldCharType="separate"/></w:r>` +
          `<w:r>${props}<w:t>${xml(run.text)}</w:t></w:r>` +
          `<w:r>${props}<w:fldChar w:fldCharType="end"/></w:r>`;
        continue;
      }
      if (!run.text) continue;
      out += `<w:r>${props}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
    }
    return out;
  }

  /** Paragraph properties; `extra` (section properties) goes last, as the schema requires. */
  paragraphProps({ style, numbering, tabs, spacing, ind, jc, sectPr = '', keepNext }) {
    let out = '';
    if (style) out += `<w:pStyle w:val="${style}"/>`;
    if (keepNext) out += '<w:keepNext/>';
    if (numbering)
      out += `<w:numPr><w:ilvl w:val="${numbering.level}"/><w:numId w:val="${numbering.id}"/></w:numPr>`;
    if (tabs?.length)
      out += `<w:tabs>${tabs.map((t) => `<w:tab w:val="${t.kind}"${t.leader ? ` w:leader="${t.leader}"` : ''} w:pos="${twips(t.pos)}"/>`).join('')}</w:tabs>`;
    if (spacing) out += spacing;
    if (ind) out += ind;
    if (jc) out += `<w:jc w:val="${jc}"/>`;
    out += sectPr;
    return out ? `<w:pPr>${out}</w:pPr>` : '';
  }

  paragraph(block, { prefix = '', sectPr = '', columnBreak = false } = {}) {
    const style = block.heading ? `Heading${block.heading}` : null;
    let numbering = null;
    if (block.list?.instance) {
      const list = this.lists.get(block.list.instance) || { levels: [] };
      this.lists.set(block.list.instance, list);
      list.levels[block.list.level] ??= {
        format: FORMATS[block.list.kind] || 'decimal',
        pattern: block.list.pattern || '%1.',
        start: block.list.start || 1,
        markerX: block.list.markerX,
        textX: block.list.textX,
        column: block.column,
      };
      numbering = { id: block.list.instance, level: block.list.level };
    }
    // Space above: the PDF's baseline distance less the line height Word will give the line.
    const unit = lineUnit(block.runs[0]?.font || this.body.font);
    let line = 240;
    if (block.lineCount > 1 && block.leading > 0)
      line = Math.max(180, Math.min(720, Math.round((240 * block.leading) / (block.size * unit))));
    const lineHeight = (block.size * unit * line) / 240;
    let before = 0;
    if (block.baselineGap != null) before = block.baselineGap - lineHeight;
    else if (block.gapAbove != null) before = block.gapAbove - block.size * 0.2;
    before = Math.max(0, Math.min(before, 360));
    const spacing = `<w:spacing w:before="${twips(before)}" w:after="0" w:line="${line}" w:lineRule="auto"/>`;
    let ind = '';
    const left = block.indent || 0;
    const first = block.firstLine || 0;
    if (left > 0.5 || Math.abs(first) > 0.5 || numbering)
      ind = `<w:ind w:left="${twips(left)}"${first < -0.5 ? ` w:hanging="${twips(-first)}"` : first > 0.5 ? ` w:firstLine="${twips(first)}"` : numbering ? ' w:hanging="0"' : ''}/>`;
    const jc = { center: 'center', right: 'right', justify: 'both' }[block.align] || null;
    const pPr = this.paragraphProps({
      style,
      numbering,
      tabs: block.tabs,
      spacing,
      ind,
      jc,
      sectPr,
    });
    const breakRun = columnBreak ? '<w:r><w:br w:type="column"/></w:r>' : '';
    return `<w:p>${pPr}${breakRun}${prefix}${this.runs(block.runs, { inHeading: !!block.heading })}</w:p>`;
  }

  drawing(picture, widthPt, heightPt, anchor = null, partRels = null) {
    const media = { ...this.picture(picture) };
    if (partRels) {
      // Headers and footers carry their own relationships.
      let rel = partRels.find((r) => r.target === `media/${media.name}`);
      if (!rel) {
        rel = { id: `rId${partRels.length + 1}`, type: 'image', target: `media/${media.name}` };
        partRels.push(rel);
      }
      media.rid = rel.id;
    }
    const id = this.drawingId++;
    const cx = emu(widthPt),
      cy = emu(heightPt);
    const graphic =
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="${media.name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${media.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic>`;
    const docPr = `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`;
    if (!anchor)
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${docPr}${graphic}</wp:inline></w:drawing></w:r>`;
    return (
      `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${anchor.z}" behindDoc="${anchor.behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">` +
      `<wp:simplePos x="0" y="0"/>` +
      `<wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(anchor.x * 12700)}</wp:posOffset></wp:positionH>` +
      `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(anchor.y * 12700)}</wp:posOffset></wp:positionV>` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>${docPr}${graphic}</wp:anchor></w:drawing></w:r>`
    );
  }

  imageParagraph(block, page, { sectPr = '', columnBreak = false } = {}) {
    const textWidth =
      (block.column
        ? block.column.x1 - block.column.x0
        : page.width - page.margins.left - page.margins.right) || block.w;
    const scale = Math.min(1, Math.max(36, textWidth) / block.w);
    const w = block.w * scale,
      h = block.h * scale;
    const before = block.gapAbove != null ? Math.max(0, Math.min(72, block.gapAbove)) : 0;
    const jc = block.align === 'center' ? 'center' : block.align === 'right' ? 'right' : null;
    const ind =
      !jc && block.indent > 0.5
        ? `<w:ind w:left="${twips(Math.min(block.indent, Math.max(0, textWidth - w)))}"/>`
        : '';
    const pPr = this.paragraphProps({
      spacing: `<w:spacing w:before="${twips(before)}" w:after="0" w:line="240" w:lineRule="auto"/>`,
      ind,
      jc,
      sectPr,
    });
    return `<w:p>${pPr}${columnBreak ? '<w:r><w:br w:type="column"/></w:r>' : ''}${this.drawing(block.picture, w, h)}</w:p>`;
  }

  table(block) {
    const columns = block.columns;
    const widths = [];
    for (let k = 0; k < columns.length - 1; k++)
      widths.push(Math.max(1, twips(columns[k + 1] - columns[k])));
    const total = widths.reduce((a, b) => a + b, 0);
    const indent = block.column ? Math.max(0, columns[0] - block.column.x0) : 0;
    const border = block.ruled ? 'single' : 'none';
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) =>
        block.ruled
          ? `<w:${side} w:val="${border}" w:sz="4" w:space="0" w:color="auto"/>`
          : `<w:${side} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`,
      )
      .join('');
    let out =
      `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblInd w:w="${twips(indent)}" w:type="dxa"/>` +
      `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
      `<w:tblCellMar><w:left w:w="43" w:type="dxa"/><w:right w:w="43" w:type="dxa"/></w:tblCellMar>` +
      `<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>` +
      `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    for (const row of block.rows) {
      out += `<w:tr><w:trPr>${row.header ? '<w:tblHeader/>' : ''}<w:trHeight w:val="${twips(Math.max(4, row.h))}" w:hRule="atLeast"/></w:trPr>`;
      for (const cell of row.cells) {
        const width = widths.slice(cell.col, cell.col + cell.span).reduce((a, b) => a + b, 0);
        let tcPr = `<w:tcW w:w="${width}" w:type="dxa"/>`;
        if (cell.span > 1) tcPr += `<w:gridSpan w:val="${cell.span}"/>`;
        if (cell.merged) tcPr += '<w:vMerge/>';
        else if (cell.rowSpan > 1) tcPr += '<w:vMerge w:val="restart"/>';
        if (cell.fill) tcPr += `<w:shd w:val="clear" w:color="auto" w:fill="${cell.fill}"/>`;
        if (block.ruled) tcPr += '<w:vAlign w:val="center"/>';
        const jcOf = (align) => ({ center: 'center', right: 'right' })[align];
        const paragraphs = cell.paragraphs.length
          ? cell.paragraphs
              .map((p) => {
                const jc = jcOf(p.align);
                return `<w:p>${this.paragraphProps({ spacing: '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>', jc })}${this.runs(p.runs)}</w:p>`;
              })
              .join('')
          : `<w:p>${this.paragraphProps({ spacing: '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' })}</w:p>`;
        out += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${paragraphs}</w:tc>`;
      }
      out += '</w:tr>';
    }
    return out + '</w:tbl>';
  }

  sectionProps(page, { type, columns, first, headers, change }) {
    const landscape = page.width > page.height;
    const m = page.margins;
    let refs = '';
    if (first && headers) {
      if (headers.header) refs += `<w:headerReference w:type="default" r:id="${headers.header}"/>`;
      if (headers.headerFirst)
        refs += `<w:headerReference w:type="first" r:id="${headers.headerFirst}"/>`;
      if (headers.footer) refs += `<w:footerReference w:type="default" r:id="${headers.footer}"/>`;
      if (headers.footerFirst)
        refs += `<w:footerReference w:type="first" r:id="${headers.footerFirst}"/>`;
    } else if (change) {
      // A later page whose running head reads differently starts using its own.
      if (change.header) refs += `<w:headerReference w:type="default" r:id="${change.header}"/>`;
      if (change.footer) refs += `<w:footerReference w:type="default" r:id="${change.footer}"/>`;
    }
    const headerDistance =
      page.headerTop != null
        ? Math.max(9, Math.min(page.headerTop, m.top - 6))
        : Math.min(36, m.top / 2);
    const footerDistance =
      page.footerBottom != null
        ? Math.max(9, Math.min(page.height - page.footerBottom, m.bottom - 6))
        : Math.min(36, m.bottom / 2);
    let cols = '<w:cols w:space="720"/>';
    if (columns) {
      const left = columns.left.x1 - columns.left.x0,
        right = columns.right.x1 - columns.right.x0;
      cols = `<w:cols w:num="2" w:space="${twips(columns.gap)}" w:equalWidth="0"><w:col w:w="${twips(left)}" w:space="${twips(columns.gap)}"/><w:col w:w="${twips(right)}"/></w:cols>`;
    }
    return (
      `<w:sectPr>${refs}<w:type w:val="${type}"/>` +
      `<w:pgSz w:w="${twips(page.width)}" w:h="${twips(page.height)}"${landscape ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${twips(m.top)}" w:right="${twips(m.right)}" w:bottom="${twips(m.bottom)}" w:left="${twips(m.left)}" w:header="${twips(headerDistance)}" w:footer="${twips(footerDistance)}" w:gutter="0"/>` +
      cols +
      (first && headers?.titlePg ? '<w:titlePg/>' : '') +
      `</w:sectPr>`
    );
  }

  /**
   * Header and footer parts from the running heads of the first page that has them, and, in
   * `changes`, parts for later pages whose heads read differently (other than in page numbers),
   * such as Bates numbers, which their sections then use.
   */
  headersAndFooters(parts) {
    const pages = this.model.pages;
    const hasHead = (p, key) => p[key].length || p[`${key}Images`]?.length;
    const pick = (key) => pages.find((p) => hasHead(p, key));
    const signature = (kind, page) =>
      JSON.stringify([
        page[kind].map((block) =>
          withPageFields(block.runs, page.index + 1, pages.length).map((r) => r.field || r.text),
        ),
        (page[`${kind}Images`] || []).map((image) => image.picture.key),
      ]);
    const make = (kind, page, partRels) => {
      const tag = kind === 'header' ? 'hdr' : 'ftr';
      let body = '';
      let pictures = '';
      for (const image of page?.[`${kind}Images`] || [])
        pictures += this.drawing(
          image.picture,
          image.w,
          image.h,
          { x: image.x, y: image.y, behind: true, z: 0 },
          partRels,
        );
      if (page) {
        for (const block of page[kind]) {
          const runs = withPageFields(block.runs, page.index + 1, pages.length);
          body += this.paragraph({
            ...block,
            runs,
            baselineGap: null,
            gapAbove: null,
            heading: 0,
            list: null,
            indent: Math.max(0, block.x - page.margins.left),
            firstLine: 0,
            tabs: block.tabs?.map((t) => ({
              ...t,
              pos: Math.max(0, t.pos + (block.column?.x0 ?? 0) - page.margins.left),
            })),
          });
        }
      }
      if (pictures)
        body = body
          ? body.replace(/^<w:p>(<w:pPr>.*?<\/w:pPr>)?/, (m) => m + pictures)
          : `<w:p>${pictures}</w:p>`;
      if (!body) body = '<w:p/>';
      return XML_HEADER + `<w:${tag} ${NS}>${body}</w:${tag}>`;
    };
    const result = { changes: new Map() };
    let index = 1;
    const part = (kind, page) => {
      const name = `${kind}${index++}.xml`;
      const partRels = [];
      parts.push({
        name: `word/${name}`,
        data: make(kind, page, partRels),
        type: `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`,
      });
      if (partRels.length)
        parts.push({ name: `word/_rels/${name}.rels`, data: relationships(partRels) });
      return this.rel(kind, name);
    };
    for (const kind of ['header', 'footer']) {
      const page = pick(kind);
      if (!page) continue;
      result[kind] = part(kind, page);
      let shown = signature(kind, page);
      for (const later of pages.slice(pages.indexOf(page) + 1)) {
        if (!hasHead(later, kind)) continue;
        const own = signature(kind, later);
        if (own === shown) continue;
        shown = own;
        if (!result.changes.has(later)) result.changes.set(later, {});
        result.changes.get(later)[kind] = part(kind, later);
      }
      if (pages[0][kind].length === 0 && page !== pages[0]) {
        const blank = `${kind}${index++}.xml`;
        parts.push({
          name: `word/${blank}`,
          data: make(kind, null),
          type: `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`,
        });
        result[`${kind}First`] = this.rel(kind, blank);
        result.titlePg = true;
      }
    }
    return result;
  }

  async write() {
    const { model, options } = this;
    const extraParts = [];
    this.rel('styles', 'styles.xml');
    this.rel('settings', 'settings.xml');
    this.rel('fontTable', 'fontTable.xml');
    const numberingRel = this.rel('numbering', 'numbering.xml');
    const headers = this.headersAndFooters(extraParts);
    let body = '';
    let z = 1;
    model.pages.forEach((page, pageIndex) => {
      options.signal?.throwIfAborted();
      // Sections: runs of blocks sharing a column band.
      const sections = [];
      for (const block of page.blocks) {
        const band = block.band || null;
        const last = sections.at(-1);
        if (last && (last.band?.id ?? null) === (band?.id ?? null)) last.blocks.push(block);
        else sections.push({ band, blocks: [block] });
      }
      if (!sections.length) sections.push({ band: null, blocks: [] });
      // Pictures behind the text, and scanned pages without text, anchor to the page.
      let anchors = '';
      for (const image of page.images) {
        if (
          image.wrap === 'behind' ||
          (image.wrap !== 'ocr' && page.background === image && !image.inFlow)
        )
          anchors += this.drawing(image.picture, image.w, image.h, {
            x: image.x,
            y: image.y,
            behind: true,
            z: z++,
          });
      }
      sections.forEach((section, s) => {
        const isLastSection = pageIndex === model.pages.length - 1 && s === sections.length - 1;
        const props = this.sectionProps(page, {
          type: s === 0 ? 'nextPage' : 'continuous',
          columns: section.band?.count === 2 ? section.band : null,
          first: pageIndex === 0 && s === 0,
          headers,
          change: s === 0 ? headers.changes.get(page) : null,
        });
        // A section ends with the paragraph holding its properties; the last one lives in body.
        const holder = isLastSection ? '' : props;
        const blocks = section.blocks;
        let previousTable = false;
        let columnBroken = false;
        blocks.forEach((block, b) => {
          const lastBlock = b === blocks.length - 1;
          const sectPr = lastBlock && block.type !== 'table' ? holder : '';
          const columnBreak = !!(section.band && block.band?.index === 1 && !columnBroken && b > 0);
          if (columnBreak) columnBroken = true;
          const prefix = anchors;
          if (block.type === 'paragraph') {
            body += this.paragraph(block, { prefix, sectPr, columnBreak });
            anchors = '';
            previousTable = false;
          } else if (block.type === 'image') {
            if (anchors) {
              body += `<w:p>${this.paragraphProps({ spacing: '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>' })}${anchors}</w:p>`;
              anchors = '';
            }
            body += this.imageParagraph(block, page, { sectPr, columnBreak });
            previousTable = false;
          } else if (block.type === 'table') {
            if (anchors || previousTable || columnBreak) {
              body += `<w:p>${this.paragraphProps({ spacing: '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>' })}${columnBreak ? '<w:r><w:br w:type="column"/></w:r>' : ''}${anchors}</w:p>`;
              anchors = '';
            }
            body += this.table(block);
            previousTable = true;
            if (lastBlock && holder)
              body += `<w:p>${this.paragraphProps({ spacing: '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>', sectPr: holder })}</w:p>`;
          }
        });
        if (!blocks.length)
          body += `<w:p>${this.paragraphProps({ sectPr: holder })}${anchors}</w:p>`;
        else if (anchors) body += `<w:p>${anchors}</w:p>`;
        anchors = '';
        if (isLastSection) body += props;
      });
    });
    const document = XML_HEADER + `<w:document ${NS}><w:body>${body}</w:body></w:document>`;

    const parts = [];
    parts.push({
      name: 'word/document.xml',
      data: document,
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    });
    parts.push({
      name: 'word/styles.xml',
      data: this.styles(),
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    });
    parts.push({
      name: 'word/settings.xml',
      data: settingsXml(),
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
    });
    parts.push({
      name: 'word/fontTable.xml',
      data: this.fontTable(),
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
    });
    parts.push({
      name: 'word/numbering.xml',
      data: this.numbering(),
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    });
    void numberingRel;
    parts.push(...extraParts);
    for (const entry of this.media.values())
      parts.push({
        name: `word/media/${entry.name}`,
        data: entry.picture.bytes,
        store: true,
      });
    parts.push({
      name: 'word/_rels/document.xml.rels',
      data: relationships(this.rels),
    });
    const props = documentProperties({
      title: options.title,
      author: options.author,
      application: 'PDF Editor',
    });
    parts.push({ name: 'docProps/core.xml', data: props.core });
    parts.push({ name: 'docProps/app.xml', data: props.app });
    parts.push({
      name: '_rels/.rels',
      data: relationships([
        { id: 'rId1', type: 'officeDocument', target: 'word/document.xml' },
        { id: 'rId2', type: 'core-properties', target: 'docProps/core.xml' },
        { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' },
      ]),
    });
    const overrides = { ...CORE_TYPES };
    for (const part of parts) if (part.type) overrides[part.name] = part.type;
    const files = [
      { name: '[Content_Types].xml', data: contentTypes(parts, overrides) },
      ...parts.map(({ name, data, store }) => ({ name, data, store })),
    ];
    return zipPackage(files, { signal: options.signal });
  }

  styles() {
    const { font, size } = this.body;
    const sz = halfPoints(size);
    const rFonts = `<w:rFonts w:ascii="${xml(font)}" w:hAnsi="${xml(font)}" w:eastAsia="${xml(font)}" w:cs="${xml(font)}"/>`;
    let headings = '';
    for (let level = 1; level <= 6; level++)
      headings +=
        `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/></w:rPr></w:style>`;
    return (
      XML_HEADER +
      `<w:styles xmlns:w="${W}">` +
      `<w:docDefaults><w:rPrDefault><w:rPr>${rFonts}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>${languageXml(this.options.lang)}</w:rPr></w:rPrDefault>` +
      `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr>${rFonts}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>` +
      headings +
      `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
      `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
      `<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
      `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>` +
      `</w:styles>`
    );
  }

  fontTable() {
    const fonts = new Set([this.body.font]);
    for (const page of this.model.pages)
      for (const block of [...page.blocks, ...page.header, ...page.footer]) {
        if (block.runs) for (const run of block.runs) if (run.font) fonts.add(run.font);
        if (block.rows)
          for (const row of block.rows)
            for (const cell of row.cells)
              for (const p of cell.paragraphs)
                for (const run of p.runs) if (run.font) fonts.add(run.font);
      }
    return (
      XML_HEADER +
      `<w:fonts xmlns:w="${W}">` +
      [...fonts]
        .map((name) => {
          const family = /times|georgia|garamond|cambria|book|palatino|serif|constantia/i.test(name)
            ? 'roman'
            : /courier|consolas|mono/i.test(name)
              ? 'modern'
              : 'swiss';
          return `<w:font w:name="${xml(name)}"><w:family w:val="${family}"/><w:pitch w:val="${family === 'modern' ? 'fixed' : 'variable'}"/></w:font>`;
        })
        .join('') +
      `</w:fonts>`
    );
  }

  numbering() {
    let abstracts = '',
      nums = '';
    for (const [id, list] of this.lists) {
      let levels = '';
      for (let level = 0; level < 9; level++) {
        const info = list.levels[level] ||
          list.levels.findLast?.((l) => l) || {
            format: 'bullet',
            pattern: '%1.',
            start: 1,
          };
        const format = info.format;
        const bullet = format === 'bullet';
        const text = bullet
          ? BULLET_CHARS[level % 3]
          : (info.pattern || '%1.').replace('%1', `%${level + 1}`);
        const known = list.levels[level];
        const left =
          known && known.column ? Math.max(0, known.textX - known.column.x0) : 18 * (level + 1);
        const hanging = known ? Math.max(0, known.textX - known.markerX) : 18;
        const font =
          bullet && level % 3 === 1
            ? '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New" w:hint="default"/></w:rPr>'
            : '';
        levels +=
          `<w:lvl w:ilvl="${level}"><w:start w:val="${Math.max(0, info.start ?? 1)}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${xml(text)}"/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${twips(left || 18 * (level + 1))}" w:hanging="${twips(hanging || 18)}"/></w:pPr>${font}</w:lvl>`;
      }
      abstracts += `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
      nums += `<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`;
    }
    return XML_HEADER + `<w:numbering xmlns:w="${W}">${abstracts}${nums}</w:numbering>`;
  }
}

function settingsXml() {
  return (
    XML_HEADER +
    `<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>` +
    `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`
  );
}

/** Page numbers in running heads become PAGE / NUMPAGES fields. */
function withPageFields(runs, pageNumber, pageCount) {
  const out = [];
  for (const run of runs) {
    if (run.tab || run.field) {
      out.push(run);
      continue;
    }
    const pattern = /\d+/g;
    let last = 0,
      match;
    const pieces = [];
    while ((match = pattern.exec(run.text))) {
      const value = +match[0];
      const before = run.text.slice(0, match.index);
      const field =
        value === pageNumber && pageNumber !== pageCount
          ? 'PAGE'
          : value === pageCount && /of\s*$/i.test(before)
            ? 'NUMPAGES'
            : value === pageNumber
              ? 'PAGE'
              : null;
      if (!field) continue;
      if (match.index > last) pieces.push({ ...run, text: run.text.slice(last, match.index) });
      pieces.push({ ...run, text: match[0], field });
      last = match.index + match[0].length;
    }
    if (!pieces.length) out.push(run);
    else {
      if (last < run.text.length) pieces.push({ ...run, text: run.text.slice(last) });
      out.push(...pieces);
    }
  }
  return out;
}

export function writeDocx(model, options = {}) {
  return new DocxWriter(model, options).write();
}

export { textOf };
