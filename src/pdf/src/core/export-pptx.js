/**
 * PresentationML (PPTX) from an export document model (see export-layout.js).
 *
 *   writePptx(model, { backgrounds, title, author, lang, signal }) -> Promise<Uint8Array>
 *
 * `lang` is the language tag the text is marked with, so PowerPoint spell-checks and reads it
 * aloud in the PDF's language (US English when the PDF names none).
 *
 * One slide per page. The slide size is the first page's size; other pages are scaled to fit
 * and centred. Every paragraph becomes a text box at its PDF position with its font, size and
 * colour; tables become PowerPoint tables; pictures and filled boxes are placed where they
 * were. `backgrounds` (page index -> PNG/JPEG bytes) optionally sets a slide background picture.
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
import { pictureSize } from './export-images.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`;
const E = 12700;
const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const clampSlide = (v) => Math.max(914400, Math.min(51206400, Math.round(v)));

function runXml(run, scale, lang) {
  const size = Math.max(100, Math.min(400000, Math.round(run.size * scale * 100)));
  const attrs = [`lang="${lang}"`, `sz="${size}"`];
  if (run.bold) attrs.push('b="1"');
  if (run.italic) attrs.push('i="1"');
  if (run.underline) attrs.push('u="sng"');
  if (run.strike) attrs.push('strike="sngStrike"');
  if (run.script) attrs.push(`baseline="${run.script === 'superscript' ? 30000 : -25000}"`);
  attrs.push('dirty="0"');
  const font = run.font
    ? `<a:latin typeface="${xml(run.font)}"/><a:cs typeface="${xml(run.font)}"/>`
    : '';
  const fill = `<a:solidFill><a:srgbClr val="${run.color || '000000'}"/></a:solidFill>`;
  return `<a:r><a:rPr ${attrs.join(' ')}>${fill}${font}</a:rPr><a:t>${xml(run.text)}</a:t></a:r>`;
}

function paragraphXml(
  runs,
  { align, scale, leading, bullet, indent = 0, hanging = 0, size, tabs = [], breaks = false, lang },
) {
  const algn = { center: 'ctr', right: 'r', justify: breaks ? 'l' : 'just' }[align] || 'l';
  let pPr = `<a:pPr algn="${algn}"${bullet ? ` marL="${Math.round(indent * E * scale)}" indent="${-Math.round(hanging * E * scale)}"` : ''}>`;
  if (leading > 0)
    pPr += `<a:lnSpc><a:spcPts val="${Math.max(0, Math.min(158400, Math.round(leading * scale * 100)))}"/></a:lnSpc>`;
  if (bullet) {
    if (bullet.kind === 'bullet') pPr += `<a:buFont typeface="Arial"/><a:buChar char="•"/>`;
    else {
      const scheme =
        {
          decimal: 'arabic',
          lowerLetter: 'alphaLc',
          upperLetter: 'alphaUc',
          lowerRoman: 'romanLc',
          upperRoman: 'romanUc',
        }[bullet.kind] || 'arabic';
      const suffix =
        bullet.pattern === '(%1)' ? 'ParenBoth' : bullet.pattern === '%1)' ? 'ParenR' : 'Period';
      pPr += `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="${scheme}${suffix}"${bullet.value > 1 ? ` startAt="${bullet.value}"` : ''}/>`;
    }
  } else pPr += '<a:buNone/>';
  const stops = tabs.filter((t) => t.pos > 0);
  if (stops.length)
    pPr += `<a:tabLst>${stops
      .map(
        (t) =>
          `<a:tab pos="${Math.round(t.pos * E * scale)}" algn="${{ right: 'r', center: 'ctr' }[t.kind] || 'l'}"/>`,
      )
      .join('')}</a:tabLst>`;
  pPr += '</a:pPr>';
  // Keep the PDF's own line breaks when asked, so lines end where they did on the page.
  const list = runs.filter((r) => r.text).map((r) => ({ ...r }));
  let body = '';
  list.forEach((run, k) => {
    if (breaks && run.brk && k > 0) {
      const previous = list[k - 1];
      void previous;
      body = body.replace(/ (<\/a:t><\/a:r>)$/, '$1');
      if (run.hyphen) body = body.replace(/(<\/a:t><\/a:r>)$/, '-$1');
      body += `<a:br><a:rPr lang="${lang}" sz="${Math.max(100, Math.round(run.size * scale * 100))}" dirty="0"/></a:br>`;
    }
    body += runXml(run.tab ? { ...run, text: '\t' } : run, scale, lang);
  });
  const end = `<a:endParaRPr lang="${lang}" sz="${Math.max(100, Math.round((size || 11) * scale * 100))}" dirty="0"/>`;
  return `<a:p>${pPr}${body}${end}</a:p>`;
}

class SlideWriter {
  constructor(page, slideSize, ids, lang) {
    const s = Math.min(slideSize.width / page.width, slideSize.height / page.height);
    this.scale = s;
    this.dx = (slideSize.width - page.width * s) / 2;
    this.dy = (slideSize.height - page.height * s) / 2;
    this.shapes = [];
    this.id = 2;
    this.rels = [
      {
        id: 'rId1',
        type: 'slideLayout',
        target: '../slideLayouts/slideLayout1.xml',
      },
    ];
    this.ids = ids;
    this.lang = lang;
  }
  box(x, y, w, h) {
    const s = this.scale;
    return `<a:xfrm><a:off x="${Math.round((this.dx + x * s) * E)}" y="${Math.round((this.dy + y * s) * E)}"/><a:ext cx="${Math.max(1, Math.round(w * s * E))}" cy="${Math.max(1, Math.round(h * s * E))}"/></a:xfrm>`;
  }
  image(picture, x, y, w, h, media) {
    const rid = media(picture, this);
    const id = this.id++;
    this.shapes.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr>${this.box(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
    );
  }
  rect(fill) {
    const id = this.id++;
    const fillXml = fill.color
      ? `<a:solidFill><a:srgbClr val="${fill.color}"/></a:solidFill>`
      : '<a:noFill/>';
    const line = fill.stroke
      ? `<a:ln w="${Math.round(0.75 * E)}"><a:solidFill><a:srgbClr val="${fill.stroke}"/></a:solidFill></a:ln>`
      : '<a:ln><a:noFill/></a:ln>';
    this.shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Rectangle ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>${this.box(fill.x, fill.y, fill.w, fill.h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml}${line}</p:spPr>` +
        `<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="${this.lang}" dirty="0"/></a:p></p:txBody></p:sp>`,
    );
  }
  text(block) {
    const id = this.id++;
    let x = block.x;
    if (block.list && block.list.markerX < x) x = block.list.markerX;
    // Room for fonts a little wider than the PDF's, growing away from the aligned edge.
    const natural = block.w + (block.x - x);
    const extra = natural * 0.1 + block.size;
    if (block.align === 'center') x -= extra / 2;
    else if (block.align === 'right') x -= extra;
    const w = Math.max(natural + extra, block.size);
    const leading = block.lineCount > 1 ? block.leading : 0;
    const column = block.column?.x0 ?? block.x;
    const paragraph = paragraphXml(block.runs, {
      align: block.align,
      scale: this.scale,
      leading,
      bullet: block.list,
      indent: block.list ? block.list.textX - x : 0,
      hanging: block.list ? block.list.textX - block.list.markerX : 0,
      size: block.size,
      tabs: (block.tabs || []).map((t) => ({ ...t, pos: column + t.pos - x })),
      breaks: true,
      lang: this.lang,
    });
    this.shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>${this.box(x, block.y, w, block.h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
        `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraph}</p:txBody></p:sp>`,
    );
  }
  table(block) {
    const id = this.id++;
    const s = this.scale;
    const widths = [];
    for (let k = 0; k < block.columns.length - 1; k++)
      widths.push(Math.max(1, Math.round((block.columns[k + 1] - block.columns[k]) * s * E)));
    const border = block.ruled
      ? `<a:solidFill><a:srgbClr val="000000"/></a:solidFill>`
      : '<a:noFill/>';
    const lines = ['lnL', 'lnR', 'lnT', 'lnB']
      .map((tag) => `<a:${tag} w="${block.ruled ? 9525 : 0}">${border}</a:${tag}>`)
      .join('');
    let rows = '';
    block.rows.forEach((row) => {
      rows += `<a:tr h="${Math.max(1, Math.round(row.h * s * E))}">`;
      const covered = new Array(widths.length).fill(null);
      for (const cell of row.cells)
        for (let k = 0; k < cell.span; k++) covered[cell.col + k] = { cell, first: k === 0 };
      for (let k = 0; k < widths.length; k++) {
        const slot = covered[k];
        const cell = slot?.cell;
        let attrs = '';
        if (slot && slot.first && cell.span > 1) attrs += ` gridSpan="${cell.span}"`;
        if (slot && !slot.first) attrs += ' hMerge="1"';
        if (cell?.rowSpan > 1 && slot.first) attrs += ` rowSpan="${cell.rowSpan}"`;
        if (cell?.merged) attrs += ' vMerge="1"';
        const paragraphs =
          slot?.first && cell.paragraphs.length
            ? cell.paragraphs
                .map((p) =>
                  paragraphXml(p.runs, {
                    align: p.align,
                    scale: s,
                    size: p.runs[0]?.size,
                    lang: this.lang,
                  }),
                )
                .join('')
            : `<a:p><a:endParaRPr lang="${this.lang}" dirty="0"/></a:p>`;
        const fill = cell?.fill
          ? `<a:solidFill><a:srgbClr val="${cell.fill}"/></a:solidFill>`
          : '<a:noFill/>';
        rows += `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</a:txBody><a:tcPr marL="${Math.round(2 * s * E)}" marR="${Math.round(2 * s * E)}" marT="0" marB="0" anchor="ctr">${lines}${fill}</a:tcPr></a:tc>`;
      }
      rows += '</a:tr>';
    });
    this.shapes.push(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="${Math.round((this.dx + block.columns[0] * s) * E)}" y="${Math.round((this.dy + block.y * s) * E)}"/><a:ext cx="${widths.reduce((a, b) => a + b, 0)}" cy="${Math.max(1, Math.round(block.h * s * E))}"/></p:xfrm>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${widths.map((w) => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    );
  }
  xml(backgroundRid) {
    const bg = backgroundRid
      ? `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${backgroundRid}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
      : '';
    return (
      XML_HEADER +
      `<p:sld ${NS}><p:cSld>${bg}<p:spTree>${GROUP}${this.shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    );
  }
}

export async function writePptx(model, options = {}) {
  const first = model.pages[0] || { width: 720, height: 540 };
  const slideSize = {
    width: clampSlide(first.width * E) / E,
    height: clampSlide(first.height * E) / E,
  };
  const parts = [];
  const media = new Map();
  const mediaFor = (picture, slide) => {
    let entry = media.get(picture.key);
    if (!entry) {
      entry = { name: `image${media.size + 1}.${picture.extension}`, picture };
      media.set(picture.key, entry);
    }
    let rel = slide.rels.find((r) => r.target === `../media/${entry.name}`);
    if (!rel) {
      rel = {
        id: `rId${slide.rels.length + 1}`,
        type: 'image',
        target: `../media/${entry.name}`,
      };
      slide.rels.push(rel);
    }
    return rel.id;
  };
  const lang = xml(options.lang || 'en-US');
  const slides = [];
  for (const page of model.pages) {
    options.signal?.throwIfAborted();
    const slide = new SlideWriter(page, slideSize, null, lang);
    let backgroundRid = null;
    const rendered = options.backgrounds?.get?.(page.index);
    if (rendered) {
      const size = pictureSize(rendered);
      const png = rendered[0] === 0x89;
      backgroundRid = mediaFor(
        {
          key: `page-${page.index}`,
          bytes: rendered,
          extension: png ? 'png' : 'jpeg',
          width: size?.width,
          height: size?.height,
        },
        slide,
      );
    }
    if (!rendered) {
      for (const fill of page.fills)
        if (fill.w * fill.h < page.width * page.height * 0.98) slide.rect(fill);
      for (const image of page.images)
        if (image.wrap !== 'ocr')
          slide.image(image.picture, image.x, image.y, image.w, image.h, mediaFor);
    }
    for (const block of [...page.header, ...page.blocks, ...page.footer]) {
      if (block.type === 'paragraph') slide.text(block);
      else if (block.type === 'table') slide.table(block);
    }
    slides.push({ slide, xml: slide.xml(backgroundRid) });
  }

  const presRels = [
    {
      id: 'rId1',
      type: 'slideMaster',
      target: 'slideMasters/slideMaster1.xml',
    },
  ];
  slides.forEach((_, k) =>
    presRels.push({
      id: `rId${k + 2}`,
      type: 'slide',
      target: `slides/slide${k + 1}.xml`,
    }),
  );
  const n = slides.length + 2;
  presRels.push({ id: `rId${n}`, type: 'presProps', target: 'presProps.xml' });
  presRels.push({
    id: `rId${n + 1}`,
    type: 'viewProps',
    target: 'viewProps.xml',
  });
  presRels.push({
    id: `rId${n + 2}`,
    type: 'theme',
    target: 'theme/theme1.xml',
  });
  presRels.push({
    id: `rId${n + 3}`,
    type: 'tableStyles',
    target: 'tableStyles.xml',
  });
  const cx = Math.round(slideSize.width * E),
    cy = Math.round(slideSize.height * E);
  const presentation =
    XML_HEADER +
    `<p:presentation ${NS} saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    (slides.length
      ? `<p:sldIdLst>${slides.map((_, k) => `<p:sldId id="${256 + k}" r:id="rId${k + 2}"/>`).join('')}</p:sldIdLst>`
      : '') +
    `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    `<p:defaultTextStyle>${levelStyles(lang)}</p:defaultTextStyle></p:presentation>`;
  const T = 'application/vnd.openxmlformats-officedocument.presentationml.';
  parts.push({
    name: 'ppt/presentation.xml',
    data: presentation,
    type: T + 'presentation.main+xml',
  });
  parts.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: relationships(presRels),
  });
  slides.forEach(({ slide, xml: slideXml }, k) => {
    parts.push({
      name: `ppt/slides/slide${k + 1}.xml`,
      data: slideXml,
      type: T + 'slide+xml',
    });
    parts.push({
      name: `ppt/slides/_rels/slide${k + 1}.xml.rels`,
      data: relationships(slide.rels),
    });
  });
  parts.push({
    name: 'ppt/slideMasters/slideMaster1.xml',
    data: masterXml(lang),
    type: T + 'slideMaster+xml',
  });
  parts.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: relationships([
      {
        id: 'rId1',
        type: 'slideLayout',
        target: '../slideLayouts/slideLayout1.xml',
      },
      { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' },
    ]),
  });
  parts.push({
    name: 'ppt/slideLayouts/slideLayout1.xml',
    data: layoutXml(),
    type: T + 'slideLayout+xml',
  });
  parts.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    data: relationships([
      {
        id: 'rId1',
        type: 'slideMaster',
        target: '../slideMasters/slideMaster1.xml',
      },
    ]),
  });
  parts.push({
    name: 'ppt/theme/theme1.xml',
    data: themeXml(),
    type: 'application/vnd.openxmlformats-officedocument.theme+xml',
  });
  parts.push({
    name: 'ppt/presProps.xml',
    data: XML_HEADER + `<p:presentationPr ${NS}/>`,
    type: T + 'presProps+xml',
  });
  parts.push({
    name: 'ppt/viewProps.xml',
    data:
      XML_HEADER +
      `<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    type: T + 'viewProps+xml',
  });
  parts.push({
    name: 'ppt/tableStyles.xml',
    data:
      XML_HEADER + `<a:tblStyleLst xmlns:a="${A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    type: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  });
  for (const entry of media.values())
    parts.push({
      name: `ppt/media/${entry.name}`,
      data: entry.picture.bytes,
      store: true,
    });
  const props = documentProperties({
    title: options.title,
    author: options.author,
    application: 'PDF Editor',
    extra: `<Slides>${slides.length}</Slides>`,
  });
  parts.push({ name: 'docProps/core.xml', data: props.core });
  parts.push({ name: 'docProps/app.xml', data: props.app });
  parts.push({
    name: '_rels/.rels',
    data: relationships([
      { id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' },
      { id: 'rId2', type: 'core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' },
    ]),
  });
  const overrides = { ...CORE_TYPES };
  for (const part of parts) if (part.type) overrides[part.name] = part.type;
  return zipPackage(
    [
      { name: '[Content_Types].xml', data: contentTypes(parts, overrides) },
      ...parts.map(({ name, data, store }) => ({ name, data, store })),
    ],
    { signal: options.signal },
  );
}

function levelStyles(lang, defaults = true) {
  let out = defaults ? `<a:defPPr><a:defRPr lang="${lang}"/></a:defPPr>` : '';
  for (let k = 1; k <= 9; k++)
    out += `<a:lvl${k}pPr marL="${(k - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${k}pPr>`;
  return out;
}

function masterXml(lang) {
  return (
    XML_HEADER +
    `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    `<p:txStyles><p:titleStyle>${levelStyles(lang, false)}</p:titleStyle><p:bodyStyle>${levelStyles(lang, false)}</p:bodyStyle><p:otherStyle>${levelStyles(lang)}</p:otherStyle></p:txStyles>` +
    `</p:sldMaster>`
  );
}

function layoutXml() {
  return (
    XML_HEADER +
    `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
  );
}

function themeXml() {
  const sys = (name, value) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
  const fontSet = (latin) => `<a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return (
    XML_HEADER +
    `<a:theme xmlns:a="${A}" name="Office Theme"><a:themeElements>` +
    `<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    sys('dk2', '44546A') +
    sys('lt2', 'E7E6E6') +
    sys('accent1', '4472C4') +
    sys('accent2', 'ED7D31') +
    sys('accent3', 'A5A5A5') +
    sys('accent4', 'FFC000') +
    sys('accent5', '5B9BD5') +
    sys('accent6', '70AD47') +
    sys('hlink', '0563C1') +
    sys('folHlink', '954F72') +
    `</a:clrScheme>` +
    `<a:fontScheme name="Office"><a:majorFont>${fontSet('Calibri Light')}</a:majorFont><a:minorFont>${fontSet('Calibri')}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Office"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>` +
    `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')}</a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
  );
}
