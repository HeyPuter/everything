// The built-in slide master and its set of layouts, sized to a slide.
//
// `buildBlankDeck` ships these so a new presentation has the layouts people
// expect to pick from (Title Slide, Title and Content, Section Header, Two
// Content, Comparison, Title Only, Blank, Content with Caption, Picture with
// Caption, Title and Vertical Text, Vertical Title and Text), each with real
// placeholders and the date, footer and slide-number placeholders that the
// master defines. "Insert Slide Master" builds a further master from the same
// set, and "Insert Layout" starts from `customLayoutXml`.
//
// Geometry is expressed as fractions of the slide so a 4:3 or a custom-size
// deck gets layouts that fit it. The XML is emitted as strings (the parts are
// boilerplate, not edited here); the result validates against the ECMA-376
// schemas in the tests.

export interface SlideCanvas {
  readonly cx: number;
  readonly cy: number;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS_DECL =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Text shown in master and layout placeholders (what master view edits). */
export const MASTER_PROMPTS = {
  title: "Master title style",
  subTitle: "Master subtitle style",
  body: [
    "Master text style",
    "Second level",
    "Third level",
    "Fourth level",
    "Fifth level",
  ],
  footer: "Footer",
} as const;

/** The ids of the date and slide-number fields a master and its layouts share. */
export interface FieldIds {
  readonly date: string;
  readonly number: string;
}

const guid = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`.toUpperCase();
};

/** Fresh field ids for a new master and its layouts. */
export const newFieldIds = (): FieldIds => ({ date: guid(), number: guid() });

// The field ids of the master being built. Layout and master builders run
// synchronously inside `withFieldIds`, so one module-level slot is enough.
let fields: FieldIds = { date: "", number: "" };
export const withFieldIds = <T>(ids: FieldIds, build: () => T): T => {
  const previous = fields;
  fields = ids;
  try {
    return build();
  } finally {
    fields = previous;
  }
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The master's standard placeholder rectangles for a slide size. */
export const masterGeometry = (size: SlideCanvas) => {
  const { cx: W, cy: H } = size;
  const r = Math.round;
  const mx = r(W * 0.06875);
  const inner = W - 2 * mx;
  const footerY = r(H * 0.9268);
  const footerH = r(H * 0.0533);
  const sideW = r(W * 0.225);
  const ftrW = r(W * 0.325);
  return {
    W,
    H,
    mx,
    inner,
    title: { x: mx, y: r(H * 0.0533), w: inner, h: r(H * 0.2118) },
    body: { x: mx, y: r(H * 0.2662), w: inner, h: r(H * 0.6345) },
    dt: { x: mx, y: footerY, w: sideW, h: footerH },
    ftr: { x: r((W - ftrW) / 2), y: footerY, w: ftrW, h: footerH },
    sldNum: { x: W - mx - sideW, y: footerY, w: sideW, h: footerH },
  };
};

const xfrm = (b: Box): string =>
  `<a:xfrm><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.max(1, Math.round(b.w))}" cy="${Math.max(1, Math.round(b.h))}"/></a:xfrm>`;

const spPr = (b: Box | null, geom = false): string =>
  b === null
    ? "<p:spPr/>"
    : `<p:spPr>${xfrm(b)}${geom ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : ""}</p:spPr>`;

interface PlaceholderSpec {
  /** `<p:ph type>`; null for the default (`obj`) content placeholder. */
  type: string | null;
  idx?: number;
  name: string;
  box?: Box | null;
  /** Extra `<a:bodyPr>` attributes. */
  bodyPr?: string;
  /** `<a:lstStyle>` contents. */
  lstStyle?: string;
  /** Paragraphs (already `<a:p>` XML). */
  paragraphs: string;
  /** `sz` attribute of the `<p:ph>` (`half`, `quarter`). */
  size?: string;
  orient?: string;
  /** Write `<a:prstGeom>` (master placeholders spell their geometry out). */
  geom?: boolean;
  /** Shrink text on overflow (`<a:normAutofit/>`). */
  autofit?: boolean;
}

const placeholder = (id: number, spec: PlaceholderSpec): string => {
  const phAttrs = [
    spec.type !== null ? `type="${spec.type}"` : "",
    spec.orient ? `orient="${spec.orient}"` : "",
    spec.size ? `sz="${spec.size}"` : "",
    spec.idx !== undefined ? `idx="${spec.idx}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(spec.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${phAttrs ? " " + phAttrs : ""}/></p:nvPr></p:nvSpPr>${spPr(spec.box ?? null, spec.geom)}<p:txBody><a:bodyPr${spec.bodyPr ? " " + spec.bodyPr : ""}${spec.autofit ? "><a:normAutofit/></a:bodyPr>" : "/>"}${spec.lstStyle ? `<a:lstStyle>${spec.lstStyle}</a:lstStyle>` : "<a:lstStyle/>"}${spec.paragraphs}</p:txBody></p:sp>`;
};

const para = (text: string, lvl = 0): string =>
  `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:rPr lang="en-US"/><a:t>${esc(text)}</a:t></a:r></a:p>`;

const bodyLevels = (count = 5): string =>
  MASTER_PROMPTS.body
    .slice(0, count)
    .map((t, i) => para(t, i))
    .join("");

const dateParagraph = (algn?: string): string =>
  `<a:p>${algn ? `<a:pPr algn="${algn}"/>` : ""}<a:fld id="${fields.date}" type="datetimeFigureOut"><a:rPr lang="en-US"/><a:t>1/1/2026</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>`;
const footerParagraph = (algn?: string): string =>
  `<a:p>${algn ? `<a:pPr algn="${algn}"/>` : ""}<a:endParaRPr lang="en-US"/></a:p>`;
const numberParagraph = (algn?: string): string =>
  `<a:p>${algn ? `<a:pPr algn="${algn}"/>` : ""}<a:fld id="${fields.number}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>`;

const lvl1 = (pPr: string, defRPr = ""): string =>
  `<a:lvl1pPr${pPr ? " " + pPr : ""}>${defRPr}</a:lvl1pPr>`;
const solid = (inner: string): string => `<a:solidFill>${inner}</a:solidFill>`;
const muted = solid(
  '<a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr>',
);

/** The footer-row placeholders a layout carries (they inherit their place). */
const footerPlaceholders = (firstId: number): string =>
  [
    placeholder(firstId, {
      type: "dt",
      idx: 10,
      size: "half",
      name: `Date Placeholder ${firstId - 1}`,
      paragraphs: dateParagraph(),
    }),
    placeholder(firstId + 1, {
      type: "ftr",
      idx: 11,
      size: "quarter",
      name: `Footer Placeholder ${firstId}`,
      paragraphs: footerParagraph(),
    }),
    placeholder(firstId + 2, {
      type: "sldNum",
      idx: 12,
      size: "quarter",
      name: `Slide Number Placeholder ${firstId + 1}`,
      paragraphs: numberParagraph(),
    }),
  ].join("");

const TREE_START =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const layoutXml = (type: string | null, name: string, shapes: string): string =>
  `${XML_DECL}<p:sldLayout ${NS_DECL}${type ? ` type="${type}"` : ""} preserve="1"><p:cSld name="${esc(name)}">${TREE_START}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const titlePh = (id: number, extra: Partial<PlaceholderSpec> = {}): string =>
  placeholder(id, {
    type: "title",
    name: `Title ${id - 1}`,
    paragraphs: para(MASTER_PROMPTS.title),
    ...extra,
  });

const contentPh = (
  id: number,
  idx: number,
  extra: Partial<PlaceholderSpec> = {},
): string =>
  placeholder(id, {
    type: null,
    idx,
    name: `Content Placeholder ${id - 1}`,
    paragraphs: bodyLevels(),
    ...extra,
  });

const textPh = (
  id: number,
  idx: number,
  extra: Partial<PlaceholderSpec> = {},
): string =>
  placeholder(id, {
    type: "body",
    idx,
    name: `Text Placeholder ${id - 1}`,
    paragraphs: para(MASTER_PROMPTS.body[0]),
    ...extra,
  });

// Child levels of a caption or heading text: no bullets, sized down.
const plainLevels = (sizes: number[], extra = ""): string =>
  sizes
    .map(
      (sz, i) =>
        `<a:lvl${i + 1}pPr marL="${i * 457200}" indent="0"><a:buNone/><a:defRPr sz="${sz}"${extra}/></a:lvl${i + 1}pPr>`,
    )
    .join("");

export interface BuiltinLayout {
  /** `/ppt/slideLayouts/slideLayout{file}.xml` in a new deck. */
  readonly file: number;
  readonly type: string;
  readonly name: string;
  readonly xml: (size: SlideCanvas) => string;
}

/**
 * Every built-in layout in the order a gallery offers them. `file` keeps
 * the long-standing part numbering of earlier blank decks (Blank is
 * `slideLayout1`, Title Slide `slideLayout2`, Title and Content
 * `slideLayout3`).
 */
export const BUILTIN_LAYOUTS: ReadonlyArray<BuiltinLayout> = [
  {
    file: 2,
    type: "title",
    name: "Title Slide",
    xml: (size) => {
      const g = masterGeometry(size);
      const x = Math.round(g.W * 0.125);
      const w = g.W - 2 * x;
      return layoutXml(
        "title",
        "Title Slide",
        placeholder(2, {
          type: "ctrTitle",
          name: "Title 1",
          box: { x, y: g.H * 0.1636, w, h: g.H * 0.3481 },
          bodyPr: 'anchor="b"',
          lstStyle: lvl1('algn="ctr"', '<a:defRPr sz="6000"/>'),
          paragraphs: para(MASTER_PROMPTS.title),
        }) +
          placeholder(3, {
            type: "subTitle",
            idx: 1,
            name: "Subtitle 2",
            box: { x, y: g.H * 0.5251, w, h: g.H * 0.2414 },
            lstStyle: plainLevels([2400, 2000, 1800, 1600, 1600]).replace(
              /<a:lvl(\d)pPr marL="\d+"/g,
              '<a:lvl$1pPr marL="0" algn="ctr"',
            ),
            paragraphs: para(MASTER_PROMPTS.subTitle),
          }) +
          footerPlaceholders(4),
      );
    },
  },
  {
    file: 3,
    type: "obj",
    name: "Title and Content",
    xml: () =>
      layoutXml(
        "obj",
        "Title and Content",
        titlePh(2) + contentPh(3, 1) + footerPlaceholders(4),
      ),
  },
  {
    file: 4,
    type: "secHead",
    name: "Section Header",
    xml: (size) => {
      const g = masterGeometry(size);
      const x = Math.round(g.W * 0.0703);
      const w = g.W - 2 * x;
      return layoutXml(
        "secHead",
        "Section Header",
        titlePh(2, {
          box: { x, y: g.H * 0.25, w, h: g.H * 0.4171 },
          bodyPr: 'anchor="b"',
          lstStyle: lvl1("", '<a:defRPr sz="6000"/>'),
        }) +
          textPh(3, 1, {
            box: { x, y: g.H * 0.671, w, h: g.H * 0.2194 },
            lstStyle: plainLevels([2400, 2000, 1800, 1600, 1600], "").replace(
              /<a:defRPr sz="(\d+)"\/>/g,
              `<a:defRPr sz="$1">${muted}</a:defRPr>`,
            ),
          }) +
          footerPlaceholders(4),
      );
    },
  },
  {
    file: 5,
    type: "twoObj",
    name: "Two Content",
    xml: (size) => {
      const g = masterGeometry(size);
      const gap = Math.round(g.W * 0.025);
      const half = (g.inner - gap) / 2;
      return layoutXml(
        "twoObj",
        "Two Content",
        titlePh(2) +
          contentPh(3, 1, {
            size: "half",
            box: { x: g.mx, y: g.body.y, w: half, h: g.body.h },
          }) +
          contentPh(4, 2, {
            size: "half",
            box: { x: g.mx + half + gap, y: g.body.y, w: half, h: g.body.h },
          }) +
          footerPlaceholders(5),
      );
    },
  },
  {
    file: 6,
    type: "twoTxTwoObj",
    name: "Comparison",
    xml: (size) => {
      const g = masterGeometry(size);
      const gap = Math.round(g.W * 0.025);
      const half = (g.inner - gap) / 2;
      const headY = g.H * 0.2509,
        headH = g.H * 0.1227;
      const bodyY = headY + headH,
        bodyH = g.H * 0.9 - bodyY;
      const heading = plainLevels([2400, 2000, 1800, 1600, 1600], ' b="1"');
      return layoutXml(
        "twoTxTwoObj",
        "Comparison",
        titlePh(2, {
          box: { x: g.mx, y: g.H * 0.0533, w: g.inner, h: g.H * 0.1767 },
        }) +
          textPh(3, 1, {
            box: { x: g.mx, y: headY, w: half, h: headH },
            bodyPr: 'anchor="b"',
            lstStyle: heading,
          }) +
          contentPh(4, 2, {
            size: "half",
            box: { x: g.mx, y: bodyY, w: half, h: bodyH },
          }) +
          textPh(5, 3, {
            size: "quarter",
            box: { x: g.mx + half + gap, y: headY, w: half, h: headH },
            bodyPr: 'anchor="b"',
            lstStyle: heading,
          }) +
          contentPh(6, 4, {
            size: "quarter",
            box: { x: g.mx + half + gap, y: bodyY, w: half, h: bodyH },
          }) +
          footerPlaceholders(7),
      );
    },
  },
  {
    file: 7,
    type: "titleOnly",
    name: "Title Only",
    xml: () =>
      layoutXml("titleOnly", "Title Only", titlePh(2) + footerPlaceholders(3)),
  },
  {
    file: 1,
    type: "blank",
    name: "Blank",
    xml: () => layoutXml("blank", "Blank", footerPlaceholders(2)),
  },
  {
    file: 8,
    type: "objTx",
    name: "Content with Caption",
    xml: (size) => captionLayout(size, "objTx", "Content with Caption", false),
  },
  {
    file: 9,
    type: "picTx",
    name: "Picture with Caption",
    xml: (size) => captionLayout(size, "picTx", "Picture with Caption", true),
  },
  {
    file: 10,
    type: "vertTx",
    name: "Title and Vertical Text",
    xml: () =>
      layoutXml(
        "vertTx",
        "Title and Vertical Text",
        titlePh(2) +
          placeholder(3, {
            type: "body",
            orient: "vert",
            idx: 1,
            name: "Vertical Text Placeholder 2",
            bodyPr: 'vert="eaVert"',
            paragraphs: bodyLevels(),
          }) +
          footerPlaceholders(4),
      ),
  },
  {
    file: 11,
    type: "vertTitleAndTx",
    name: "Vertical Title and Text",
    xml: (size) => {
      const g = masterGeometry(size);
      const titleW = Math.round(g.W * 0.1969);
      const gap = Math.round(g.W * 0.025);
      const top = g.title.y,
        h = g.body.y + g.body.h - top;
      return layoutXml(
        "vertTitleAndTx",
        "Vertical Title and Text",
        titlePh(2, {
          orient: "vert",
          box: { x: g.W - g.mx - titleW, y: top, w: titleW, h },
          bodyPr: 'vert="eaVert"',
        }) +
          placeholder(3, {
            type: "body",
            orient: "vert",
            idx: 1,
            name: "Vertical Text Placeholder 2",
            box: { x: g.mx, y: top, w: g.inner - titleW - gap, h },
            bodyPr: 'vert="eaVert"',
            paragraphs: bodyLevels(),
          }) +
          footerPlaceholders(4),
      );
    },
  },
];

function captionLayout(
  size: SlideCanvas,
  type: string,
  name: string,
  picture: boolean,
): string {
  const g = masterGeometry(size);
  const leftW = Math.round(g.W * 0.3216);
  const gap = Math.round(g.W * 0.0313);
  const titleY = g.H * 0.0667,
    titleH = g.H * 0.2333;
  const top = g.H * 0.1333,
    bottom = g.H * 0.8667;
  const rightX = g.mx + leftW + gap;
  const rightW = g.W - g.mx - rightX;
  const captionY = titleY + titleH + g.H * 0.0333;
  const caption = plainLevels([1600, 1400, 1200, 1000, 1000]);
  const main = picture
    ? placeholder(3, {
        type: "pic",
        idx: 1,
        name: "Picture Placeholder 2",
        box: { x: rightX, y: top, w: rightW, h: bottom - top },
        lstStyle: plainLevels([3200, 2800, 2400, 2000, 2000]),
        paragraphs: `<a:p><a:endParaRPr lang="en-US"/></a:p>`,
      })
    : contentPh(3, 1, {
        box: { x: rightX, y: top, w: rightW, h: bottom - top },
        lstStyle: [3200, 2800, 2400, 2000, 2000]
          .map(
            (sz, i) =>
              `<a:lvl${i + 1}pPr><a:defRPr sz="${sz}"/></a:lvl${i + 1}pPr>`,
          )
          .join(""),
      });
  return layoutXml(
    type,
    name,
    titlePh(2, {
      box: { x: g.mx, y: titleY, w: leftW, h: titleH },
      bodyPr: 'anchor="b"',
      lstStyle: lvl1("", '<a:defRPr sz="3200"/>'),
    }) +
      main +
      textPh(4, 2, {
        size: "half",
        box: { x: g.mx, y: captionY, w: leftW, h: bottom - captionY },
        lstStyle: caption,
      }) +
      footerPlaceholders(5),
  );
}

/**
 * A new custom layout as "Insert Layout" makes it: a title and the footer
 * row, named by the caller.
 */
export const customLayoutXml = (name: string): string =>
  layoutXml(null, name, titlePh(2) + footerPlaceholders(3));

const bodyStyle = (): string => {
  const sizes = [2800, 2400, 2000, 1800, 1800];
  return sizes
    .map((sz, i) => {
      const marL = 228600 + i * 457200;
      return `<a:lvl${i + 1}pPr marL="${marL}" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${i === 0 ? 1000 : 500}"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`;
    })
    .join("");
};

const otherStyle = (): string =>
  `<a:defPPr><a:defRPr lang="en-US"/></a:defPPr>` +
  [0]
    .map(
      (i) =>
        `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`,
    )
    .join("");

const footerStyle = (algn: string): string =>
  lvl1(`algn="${algn}"`, `<a:defRPr sz="1200">${muted}</a:defRPr>`);

/**
 * The slide master: title, body, date, footer and slide-number
 * placeholders, the standard color map, a `<p:sldLayoutIdLst>` naming each
 * layout relationship, and the text styles every slide inherits.
 */
export const masterXml = (
  size: SlideCanvas,
  layouts: ReadonlyArray<{ id: number; rId: string }>,
): string => {
  const g = masterGeometry(size);
  const shapes =
    placeholder(2, {
      type: "title",
      name: "Title Placeholder 1",
      box: g.title,
      geom: true,
      bodyPr:
        'vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"',
      autofit: true,
      paragraphs: para(MASTER_PROMPTS.title),
    }) +
    placeholder(3, {
      type: "body",
      idx: 1,
      name: "Text Placeholder 2",
      box: g.body,
      geom: true,
      bodyPr:
        'vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"',
      autofit: true,
      paragraphs: bodyLevels(),
    }) +
    placeholder(4, {
      type: "dt",
      idx: 2,
      size: "half",
      name: "Date Placeholder 3",
      box: g.dt,
      geom: true,
      bodyPr:
        'vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"',
      lstStyle: footerStyle("l"),
      paragraphs: dateParagraph(),
    }) +
    placeholder(5, {
      type: "ftr",
      idx: 3,
      size: "quarter",
      name: "Footer Placeholder 4",
      box: g.ftr,
      geom: true,
      bodyPr:
        'vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"',
      lstStyle: footerStyle("ctr"),
      paragraphs: footerParagraph(),
    }) +
    placeholder(6, {
      type: "sldNum",
      idx: 4,
      size: "quarter",
      name: "Slide Number Placeholder 5",
      box: g.sldNum,
      geom: true,
      bodyPr:
        'vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"',
      lstStyle: footerStyle("r"),
      paragraphs: numberParagraph(),
    });
  const ids = layouts
    .map((l) => `<p:sldLayoutId id="${l.id}" r:id="${l.rId}"/>`)
    .join("");
  return `${XML_DECL}<p:sldMaster ${NS_DECL}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${TREE_START}${shapes}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${ids}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${bodyStyle()}</p:bodyStyle><p:otherStyle>${otherStyle()}</p:otherStyle></p:txStyles></p:sldMaster>`;
};
