/**
 * Certificate-based digital signatures, like Acrobat's "Use a certificate" and Signature
 * panel: validate the signatures of a PDF, list its signature fields, create digital IDs, and
 * sign a PDF with an incremental update that leaves earlier signatures intact.
 *
 * Signing appends to the exact bytes it is given; it must run on the file as saved, after
 * every other edit, because any later full rewrite (pdf-lib's save) invalidates signatures.
 */
import {
  JpegEmbedder,
  ParseSpeeds,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PngEmbedder,
  StandardFontEmbedder,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';

import { OID, bytesEqual, bytesOfHex, decodeDer, hexOf } from './asn1.js';
import {
  createSignedData,
  parseSignedData,
  requestTimestamp,
  verifySigner,
  verifyTimestampToken,
} from './cms.js';
import { CryptoUnsupportedError, digest, signingHash, verifySignature } from './pki-crypto.js';
import {
  appendRevision,
  ascii,
  highestObjectNumber,
  lastCrossReference,
  objectBytes,
  onlyWhitespaceAfter,
  revisionEnds,
} from './pdf-incremental.js';
import { exportPkcs12, importPkcs12 } from './pkcs12.js';
import {
  buildChain,
  certificateSummary,
  chainTrust,
  createSelfSignedCertificate,
  parseCertificate,
  parseCertificateList,
} from './x509.js';
import { parsePdfDate } from './notes.js';
import { unlockPdf } from './security.js';

export { exportPkcs12, importPkcs12 };

const name = (text) => PDFName.of(text);
const toBytes = (input) =>
  input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : Uint8Array.from(input);
const loadPdf = (bytes) =>
  PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    parseSpeed: ParseSpeeds.Fastest,
  });

function textOf(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      return value.decodeText();
    } catch {
      return '';
    }
  }
  return '';
}
const nameOf = (value) => (value instanceof PDFName ? value.decodeText() : null);
const numberOf = (value) => (value instanceof PDFNumber ? value.asNumber() : null);

/* ---------- Digital IDs ---------- */
/**
 * Create a digital ID: a new key pair and a self-signed certificate for it.
 * Resolves to `{ privateKey, certificate (DER), chain: [] }`, the shape signPdf and
 * exportPkcs12 take.
 */
export async function createSelfSignedId({
  name: commonName,
  email = '',
  organization = '',
  unit = '',
  country = '',
  keyType = 'RSA-2048',
  validityYears = 5,
  notBefore = new Date(),
} = {}) {
  const { privateKey, certificate } = await createSelfSignedCertificate({
    notBefore,
    name: commonName,
    email,
    organization,
    unit,
    country,
    keyType,
    validityYears,
  });
  return { privateKey, certificate, chain: [], friendlyName: commonName };
}

/** The names and validity of a digital ID's certificate, for a picker. */
export function describeIdentity(identity) {
  return certificateSummary(parseCertificate(identity.certificate));
}

/* ---------- Signature fields ---------- */
function rectOf(dict) {
  const rect = dict?.lookup(name('Rect'));
  if (!(rect instanceof PDFArray) || rect.size() < 4) return null;
  const [a, b, c, d] = rect
    .asArray()
    .slice(0, 4)
    .map((v) => numberOf(v) ?? 0);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/**
 * Every signature field of a document with its widgets, value (the signature dictionary),
 * page and rectangle. Reads the AcroForm field tree and, for damaged files, page widgets.
 */
function collectFields(doc) {
  const { context, catalog } = doc;
  const pageOfAnnot = new Map();
  const pageOfRef = new Map();
  let pages = [];
  try {
    pages = doc.getPages();
  } catch {
    // A damaged page tree leaves fields without page numbers.
  }
  pages.forEach((page, index) => {
    pageOfRef.set(page.ref.objectNumber, index);
    const annots = context.lookup(page.node.get(name('Annots')));
    if (annots instanceof PDFArray)
      for (const a of annots.asArray())
        if (a instanceof PDFRef && !pageOfAnnot.has(a.objectNumber))
          pageOfAnnot.set(a.objectNumber, index);
  });
  const all = [];
  const seen = new Set();
  const widgetInfo = (ref, dict) => {
    let page = ref instanceof PDFRef ? pageOfAnnot.get(ref.objectNumber) : undefined;
    const p = dict.get(name('P'));
    if (page === undefined && p instanceof PDFRef) page = pageOfRef.get(p.objectNumber);
    return {
      ref: ref instanceof PDFRef ? ref : null,
      dict,
      page: page ?? null,
      rect: rectOf(dict),
    };
  };
  const visit = (ref, parentName, inheritedType, depth) => {
    if (depth > 32) return;
    const dict = context.lookup(ref);
    if (!(dict instanceof PDFDict)) return;
    const key = ref instanceof PDFRef ? ref.objectNumber : dict;
    if (seen.has(key)) return;
    seen.add(key);
    const partial = textOf(dict.get(name('T')));
    const fullName = partial ? (parentName ? `${parentName}.${partial}` : partial) : parentName;
    const type = nameOf(dict.get(name('FT'))) || inheritedType;
    const kids = context.lookup(dict.get(name('Kids')));
    const kidList = kids instanceof PDFArray ? kids.asArray() : [];
    const fieldKids = kidList.filter((kid) => {
      const kidDict = context.lookup(kid);
      return kidDict instanceof PDFDict && kidDict.has(name('T'));
    });
    if (fieldKids.length) {
      for (const kid of fieldKids) visit(kid, fullName, type, depth + 1);
      return;
    }
    const widgets = [];
    if (nameOf(dict.get(name('Subtype'))) === 'Widget') widgets.push(widgetInfo(ref, dict));
    for (const kid of kidList) {
      const kidDict = context.lookup(kid);
      if (kidDict instanceof PDFDict) widgets.push(widgetInfo(kid, kidDict));
    }
    const valueRef = dict.get(name('V'));
    all.push({
      name: fullName || '',
      type,
      ref: ref instanceof PDFRef ? ref : null,
      dict,
      widgets,
      value: context.lookup(valueRef),
      valueRef: valueRef instanceof PDFRef ? valueRef : null,
      lock: context.lookup(dict.get(name('Lock'))),
    });
  };
  const form = context.lookup(catalog.get(name('AcroForm')));
  const roots = form instanceof PDFDict ? context.lookup(form.get(name('Fields'))) : null;
  if (roots instanceof PDFArray) for (const ref of roots.asArray()) visit(ref, '', undefined, 0);
  // Widgets reached only from pages (fields missing from /Fields).
  for (const objectNumber of pageOfAnnot.keys()) {
    const ref = PDFRef.of(objectNumber);
    const dict = context.lookup(ref);
    if (!(dict instanceof PDFDict) || nameOf(dict.get(name('Subtype'))) !== 'Widget') continue;
    let top = ref;
    for (let i = 0, cur = dict; i < 32; i++) {
      const parent = cur.get(name('Parent'));
      const parentDict = context.lookup(parent);
      if (!(parentDict instanceof PDFDict)) break;
      top = parent;
      cur = parentDict;
    }
    visit(top, '', undefined, 0);
  }
  return all;
}

const isSignatureValue = (value) =>
  value instanceof PDFDict && (value.has(name('ByteRange')) || value.has(name('Contents')));

function fieldSummary(field) {
  const widget = field.widgets.find((w) => w.rect) || field.widgets[0];
  const rect = widget?.rect || null;
  return {
    name: field.name,
    page: widget?.page ?? null,
    rect,
    invisible: !rect || rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1,
    signed: isSignatureValue(field.value),
  };
}

/**
 * The signature fields of a PDF (bytes or a loaded pdf-lib document): `{ name, page (0-based
 * index or null), rect ([x1, y1, x2, y2] in PDF user space or null), invisible, signed }`.
 */
export async function listSignatureFields(input) {
  try {
    const doc = input instanceof PDFDocument ? input : await loadPdf(toBytes(input));
    return collectFields(doc)
      .filter((field) => field.type === 'Sig')
      .map(fieldSummary);
  } catch {
    return [];
  }
}

/* ---------- Text and dates ---------- */
const PRINTABLE = /^[\x20-\x7e]*$/;
/** A PDF text string: an escaped literal for plain ASCII, UTF-16BE hex otherwise. */
function pdfText(text) {
  const value = String(text ?? '');
  if (PRINTABLE.test(value)) return `(${value.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  return PDFHexString.fromText(value).toString();
}
const textObject = (text) =>
  PRINTABLE.test(text)
    ? PDFString.of(text.replace(/[\\()]/g, (c) => `\\${c}`))
    : PDFHexString.fromText(text);
const pad2 = (n) => String(n).padStart(2, '0');
/** D:YYYYMMDDHHmmSS+HH'mm' in the local time zone, as Acrobat writes /M. */
export function pdfDate(date) {
  const offset = -date.getTimezoneOffset();
  const zone =
    offset === 0
      ? 'Z'
      : `${offset > 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(offset) / 60))}'${pad2(Math.abs(offset) % 60)}'`;
  return `D:${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}${zone}`;
}
/** 2026.10.09 14:03:12 -07'00', the date format of Acrobat's signature appearances. */
function displayDate(date) {
  const offset = -date.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(offset) / 60))}'${pad2(Math.abs(offset) % 60)}'`;
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${zone}`;
}

/* ---------- Appearance ---------- */
let helveticaMetrics;
/** Helvetica's metrics and WinAnsi encoding, loaded on first use. */
const helvetica = () => (helveticaMetrics ||= StandardFontEmbedder.for(StandardFonts.Helvetica));
const encodable = new Map();
/** Replace characters Helvetica's WinAnsi encoding lacks with "?". */
function winAnsi(text) {
  let out = '';
  for (const ch of String(text)) {
    let ok = encodable.get(ch);
    if (ok === undefined) {
      try {
        helvetica().encodeText(ch);
        ok = true;
      } catch {
        ok = false;
      }
      encodable.set(ch, ok);
    }
    out += ok ? ch : '?';
  }
  return out;
}
const num = (n) => {
  const fixed = Number(n).toFixed(3);
  return fixed.replace(/\.?0+$/, '') || '0';
};
function textLine(text, size, x, y) {
  return `BT /Helv ${num(size)} Tf ${num(x)} ${num(y)} Td ${helvetica().encodeText(text).toString()} Tj ET`;
}
/** Fit lines into a box: one font size for all, top-aligned. */
function textBlock(lines, box, maxSize = 14) {
  if (!lines.length) return [];
  const widest = Math.max(...lines.map((line) => helvetica().widthOfTextAtSize(line, 1)), 0.01);
  const size = Math.max(2, Math.min(maxSize, box.w / widest, box.h / (lines.length * 1.18)));
  const ops = [];
  let y = box.y + box.h - size * 0.93;
  const blockHeight = lines.length * size * 1.18;
  if (blockHeight < box.h) y -= (box.h - blockHeight) / 2;
  for (const line of lines) {
    ops.push(textLine(line, size, box.x, y));
    y -= size * 1.18;
  }
  return ops;
}

/**
 * The content of a signature appearance: on the left the signer's name in large type (or an
 * image), on the right the detail lines (who, when, why), like Acrobat's default.
 */
function appearanceContent({ width, height, lines, bigName, image }) {
  const pad = Math.max(1, Math.min(width, height) * 0.05);
  const ops = ['0 g'];
  const twoColumns = (image || bigName) && width >= height * 1.6;
  let detail = { x: pad, y: pad, w: width - 2 * pad, h: height - 2 * pad };
  if (twoColumns) {
    const leftWidth = (width - 3 * pad) * 0.45;
    const left = { x: pad, y: pad, w: leftWidth, h: height - 2 * pad };
    detail = {
      x: 2 * pad + leftWidth,
      y: pad,
      w: width - 3 * pad - leftWidth,
      h: height - 2 * pad,
    };
    if (image) {
      const scale = Math.min(left.w / image.width, left.h / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      ops.push(
        `q ${num(w)} 0 0 ${num(h)} ${num(left.x + (left.w - w) / 2)} ${num(left.y + (left.h - h) / 2)} cm /Img Do Q`,
      );
    } else ops.push(...textBlock([bigName], left, 48));
  } else if (image) {
    // Narrow boxes: the image behind the text.
    const scale = Math.min(detail.w / image.width, detail.h / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ops.push(
      `q ${num(w)} 0 0 ${num(h)} ${num(detail.x + (detail.w - w) / 2)} ${num(detail.y + (detail.h - h) / 2)} cm /Img Do Q`,
    );
  } else if (bigName) lines = [bigName, ...lines];
  ops.push(...textBlock(lines, detail));
  return ops.join('\n');
}

async function embedAppearanceImage(context, bytes) {
  const data = toBytes(bytes);
  const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error('Signature images must be PNG or JPEG.');
  const embedder = isPng ? await PngEmbedder.for(data) : await JpegEmbedder.for(data);
  const ref = context.nextRef();
  await embedder.embedIntoContext(context, ref);
  return { ref, width: embedder.width, height: embedder.height };
}

/* ---------- Signing ---------- */
const BYTE_RANGE_WIDTH = 10;
const BYTE_RANGE_PLACEHOLDER = `[0 ${'0'.repeat(BYTE_RANGE_WIDTH)} ${'0'.repeat(BYTE_RANGE_WIDTH)} ${'0'.repeat(BYTE_RANGE_WIDTH)}]`;

function normalizeRect(rect) {
  if (!rect) return null;
  if (Array.isArray(rect)) {
    const [a, b, c, d] = rect.map(Number);
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  }
  const { x = 0, y = 0, width = 0, height = 0 } = rect;
  return [
    Math.min(x, x + width),
    Math.min(y, y + height),
    Math.max(x, x + width),
    Math.max(y, y + height),
  ];
}

function allFieldNames(doc) {
  const names = new Set();
  const { context } = doc;
  const visit = (ref, parent, depth) => {
    const dict = context.lookup(ref);
    if (!(dict instanceof PDFDict) || depth > 32) return;
    const t = textOf(dict.get(name('T')));
    const full = t ? (parent ? `${parent}.${t}` : t) : parent;
    if (full) names.add(full);
    const kids = context.lookup(dict.get(name('Kids')));
    if (kids instanceof PDFArray) for (const kid of kids.asArray()) visit(kid, full, depth + 1);
  };
  const form = context.lookup(doc.catalog.get(name('AcroForm')));
  const fields = form instanceof PDFDict ? context.lookup(form.get(name('Fields'))) : null;
  if (fields instanceof PDFArray) for (const ref of fields.asArray()) visit(ref, '', 0);
  return names;
}

/** The DocMDP permission level of a certified document (1, 2 or 3), or null. */
function certificationLevel(doc) {
  const { context } = doc;
  const perms = context.lookup(doc.catalog.get(name('Perms')));
  const sig = perms instanceof PDFDict ? context.lookup(perms.get(name('DocMDP'))) : null;
  if (!(sig instanceof PDFDict)) return null;
  return docMdpOf(context, sig) ?? 2;
}
function transformParams(context, sig, method) {
  const refs = context.lookup(sig.get(name('Reference')));
  if (!(refs instanceof PDFArray)) return null;
  for (const item of refs.asArray()) {
    const ref = context.lookup(item);
    if (!(ref instanceof PDFDict) || nameOf(ref.get(name('TransformMethod'))) !== method) continue;
    const params = context.lookup(ref.get(name('TransformParams')));
    return params instanceof PDFDict ? params : new Map();
  }
  return null;
}
function docMdpOf(context, sig) {
  const params = transformParams(context, sig, 'DocMDP');
  if (!params) return null;
  const p = params instanceof PDFDict ? numberOf(context.lookup(params.get(name('P')))) : null;
  return p === 1 || p === 3 ? p : 2;
}

/**
 * First half of signing: append an incremental update with the signature field, appearance
 * and a signature dictionary whose /Contents is a zero-filled placeholder. Returns the new
 * bytes, the /ByteRange and where the placeholder lies. Use with embedPdfSignature, or call
 * signPdf to do both with a digital ID.
 *
 * Options: fieldName, page (0-based), rect ({x, y, width, height} or [x1, y1, x2, y2] in PDF
 * user space; omit for an invisible signature), reason, location, contactInfo, signingTime,
 * appearance ({ lines, image, name }), certify (1, 2 or 3), subFilter
 * ('ETSI.CAdES.detached' default, or 'adbe.pkcs7.detached'), certificate (DER, for the
 * default appearance text), reserve (bytes reserved for the CMS), timestamp (a function that
 * sends an RFC 3161 TimeStampReq to a TSA and resolves to its response; signPdf only).
 */
export async function preparePdfSignature(input, options = {}) {
  const original = toBytes(input);
  const {
    fieldName,
    page: pageIndex = 0,
    reason = '',
    location = '',
    contactInfo = '',
    signingTime = new Date(),
    appearance = {},
    certify = null,
    subFilter = 'ETSI.CAdES.detached',
    certificate = null,
    signerName = '',
  } = options;
  if (!['ETSI.CAdES.detached', 'adbe.pkcs7.detached', 'ETSI.RFC3161'].includes(subFilter))
    throw new Error(`Unsupported signature format ${subFilter}.`);
  const docTimestamp = subFilter === 'ETSI.RFC3161';
  if (certify != null && ![1, 2, 3].includes(certify))
    throw new Error('Certification level must be 1, 2 or 3.');
  const xref = lastCrossReference(original);
  const doc = await loadPdf(original);
  const { context, catalog } = doc;
  if (context.trailerInfo.Encrypt)
    throw new Error(
      'Password-protected PDFs cannot be signed here. Remove the protection first, then sign.',
    );
  const level = certificationLevel(doc);
  if (level === 1 && !docTimestamp)
    throw new Error('This document is certified and allows no changes, so it cannot be signed.');
  const fields = collectFields(doc).filter((field) => field.type === 'Sig');
  if (certify != null && fields.some((field) => isSignatureValue(field.value)))
    throw new Error('A document can be certified only before anyone has signed it.');

  // New objects take numbers above everything the file has ever used.
  context.largestObjectNumber = Math.max(
    context.largestObjectNumber,
    xref.size - 1,
    highestObjectNumber(original),
  );
  const firstNew = context.largestObjectNumber + 1;
  const changed = new Map(); // objectNumber -> { ref, object }
  const markChanged = (ref, object) => changed.set(ref.objectNumber, { ref, object });

  const signer = certificate ? parseCertificate(certificate) : null;
  const displayName = signerName || signer?.subject.commonName || 'Unknown signer';

  // The field to sign: an existing empty signature field by name, or a new one.
  let field = fieldName ? fields.find((f) => f.name === fieldName) : null;
  if (fieldName && !field && allFieldNames(doc).has(fieldName))
    throw new Error(`"${fieldName}" is not a signature field.`);
  if (field && isSignatureValue(field.value)) throw new Error(`"${fieldName}" is already signed.`);
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    throw new Error('This PDF has a damaged page tree.');
  }

  const sigRef = context.nextRef();
  let widgetDict;
  let widgetRef;
  let pageNumber;
  let rect;
  if (field) {
    const widget = field.widgets[0];
    if (!widget) throw new Error(`"${fieldName}" has no widget to sign.`);
    widgetDict = widget.dict;
    widgetRef = widget.ref || field.ref;
    rect = widget.rect || [0, 0, 0, 0];
    pageNumber = widget.page ?? 0;
    field.dict.set(name('V'), sigRef);
    if (field.ref) markChanged(field.ref, field.dict);
  } else {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length)
      throw new Error('That page does not exist.');
    pageNumber = pageIndex;
    rect = (!docTimestamp && normalizeRect(options.rect)) || [0, 0, 0, 0];
    const taken = allFieldNames(doc);
    let fieldTitle = fieldName;
    for (let n = 1; !fieldTitle || taken.has(fieldTitle); n++) fieldTitle = `Signature${n}`;
    const page = pages[pageNumber];
    widgetRef = context.nextRef();
    widgetDict = context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      F: rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1 ? 132 : 4,
      Rect: rect,
      P: page.ref,
    });
    widgetDict.set(name('T'), textObject(fieldTitle));
    widgetDict.set(name('V'), sigRef);
    markChanged(widgetRef, widgetDict);
    // Page annotations.
    const annots = page.node.get(name('Annots'));
    const annotsArray = context.lookup(annots);
    if (annots instanceof PDFRef && annotsArray instanceof PDFArray) {
      annotsArray.push(widgetRef);
      markChanged(annots, annotsArray);
    } else {
      if (annotsArray instanceof PDFArray) annotsArray.push(widgetRef);
      else page.node.set(name('Annots'), context.obj([widgetRef]));
      markChanged(page.ref, page.node);
    }
    // Form fields.
    const rootRef = context.trailerInfo.Root;
    const formEntry = catalog.get(name('AcroForm'));
    let form = context.lookup(formEntry);
    if (!(form instanceof PDFDict)) {
      form = context.obj({ Fields: [] });
      const formRef = context.nextRef();
      catalog.set(name('AcroForm'), formRef);
      markChanged(formRef, form);
      markChanged(rootRef, catalog);
    } else if (formEntry instanceof PDFRef) markChanged(formEntry, form);
    else markChanged(rootRef, catalog);
    const fieldsEntry = form.get(name('Fields'));
    const fieldsArray = context.lookup(fieldsEntry);
    if (fieldsEntry instanceof PDFRef && fieldsArray instanceof PDFArray) {
      fieldsArray.push(widgetRef);
      markChanged(fieldsEntry, fieldsArray);
    } else if (fieldsArray instanceof PDFArray) fieldsArray.push(widgetRef);
    else form.set(name('Fields'), context.obj([widgetRef]));
  }
  // SigFlags 3: signatures exist; save incrementally.
  {
    const rootRef = context.trailerInfo.Root;
    const formEntry = catalog.get(name('AcroForm'));
    const form = context.lookup(formEntry);
    if (form instanceof PDFDict) {
      const flags = numberOf(context.lookup(form.get(name('SigFlags')))) || 0;
      if ((flags & 3) !== 3) {
        form.set(name('SigFlags'), PDFNumber.of(flags | 3));
        if (formEntry instanceof PDFRef) markChanged(formEntry, form);
        else markChanged(rootRef, catalog);
      }
    }
    if (certify != null) {
      catalog.set(name('Perms'), context.obj({ DocMDP: sigRef }));
      markChanged(rootRef, catalog);
    }
  }

  // Appearance.
  const width = rect[2] - rect[0];
  const height = rect[3] - rect[1];
  if (width >= 1 && height >= 1) {
    const rotation = (((pages[pageNumber]?.getRotation().angle || 0) % 360) + 360) % 360;
    const turned = rotation === 90 || rotation === 270;
    const boxWidth = turned ? height : width;
    const boxHeight = turned ? width : height;
    const lines = (
      appearance.lines || [
        `Digitally signed by ${displayName}`,
        `Date: ${displayDate(signingTime)}`,
        reason ? `Reason: ${reason}` : '',
        location ? `Location: ${location}` : '',
      ]
    )
      .filter((line) => line != null && line !== '')
      .map(winAnsi);
    const bigName =
      appearance.lines && !appearance.name ? '' : winAnsi(appearance.name ?? displayName);
    const image = appearance.image ? await embedAppearanceImage(context, appearance.image) : null;
    const fontRef = context.nextRef();
    markChanged(
      fontRef,
      context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        Encoding: 'WinAnsiEncoding',
      }),
    );
    const resources = { Font: { Helv: fontRef } };
    if (image) resources.XObject = { Img: image.ref };
    const radians = (rotation * Math.PI) / 180;
    const streamDict = {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, boxWidth, boxHeight],
      Resources: resources,
    };
    if (rotation)
      streamDict.Matrix = [
        Math.round(Math.cos(radians)),
        Math.round(Math.sin(radians)),
        -Math.round(Math.sin(radians)),
        Math.round(Math.cos(radians)),
        0,
        0,
      ];
    const content = appearanceContent({
      width: boxWidth,
      height: boxHeight,
      lines,
      bigName,
      image,
    });
    const apRef = context.nextRef();
    markChanged(apRef, context.stream(content, streamDict));
    widgetDict.set(name('AP'), context.obj({ N: apRef }));
    if (rotation) widgetDict.set(name('MK'), context.obj({ R: rotation }));
    if (widgetRef) markChanged(widgetRef, widgetDict);
  }

  // Objects the image embedder registered.
  for (const [ref, object] of context.enumerateIndirectObjects())
    if (ref.objectNumber >= firstNew && !changed.has(ref.objectNumber) && ref !== sigRef)
      markChanged(ref, object);

  // The signature dictionary, written by hand to place the placeholders.
  const certificateSize =
    (certificate?.length || 2048) +
    (options.timestamp ? 12288 : 0) +
    (options.chain || []).reduce((sum, c) => sum + c.length, 0);
  const reserve =
    options.reserve || Math.max(8192, Math.ceil((certificateSize + 4096) / 1024) * 1024);
  const references = [];
  if (certify != null)
    references.push(
      `<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P ${certify} /V /1.2 >> >>`,
    );
  if (field?.lock instanceof PDFDict) {
    const action = nameOf(field.lock.get(name('Action'))) || 'All';
    const lockedFields = context.lookup(field.lock.get(name('Fields')));
    const list =
      lockedFields instanceof PDFArray
        ? lockedFields
            .asArray()
            .map((f) => pdfText(textOf(context.lookup(f))))
            .join(' ')
        : '';
    references.push(
      `<< /Type /SigRef /TransformMethod /FieldMDP /TransformParams << /Type /TransformParams /Action /${action}${list ? ` /Fields [${list}]` : ''} /V /1.2 >> >>`,
    );
  }
  const head =
    `<< /Type /${docTimestamp ? 'DocTimeStamp' : 'Sig'} /Filter /Adobe.PPKLite /SubFilter /${subFilter}\n` +
    `/ByteRange ${BYTE_RANGE_PLACEHOLDER}\n/Contents <`;
  const tail = docTimestamp
    ? '>\n>>'
    : `>\n/M ${pdfText(pdfDate(signingTime))}` +
      (displayName ? `\n/Name ${pdfText(displayName)}` : '') +
      (reason ? `\n/Reason ${pdfText(reason)}` : '') +
      (location ? `\n/Location ${pdfText(location)}` : '') +
      (contactInfo ? `\n/ContactInfo ${pdfText(contactInfo)}` : '') +
      (references.length ? `\n/Reference [${references.join(' ')}]` : '') +
      `\n/Prop_Build << /Filter << /Name /Adobe.PPKLite >> /App << /Name /PDF#20Editor >> >>\n>>`;
  const sigBody = new Uint8Array(head.length + reserve * 2 + tail.length);
  sigBody.set(ascii(head));
  sigBody.fill(0x30, head.length, head.length + reserve * 2);
  sigBody.set(ascii(tail), head.length + reserve * 2);

  const objects = [...changed.values()].map(({ ref, object }) => ({
    ref,
    body: objectBytes(object),
  }));
  objects.push({ ref: sigRef, body: sigBody });

  const ids = context.lookup(context.trailerInfo.ID);
  const firstId = ids instanceof PDFArray && ids.size() ? context.lookup(ids.get(0)) : null;
  const idBytes =
    firstId instanceof PDFHexString || firstId instanceof PDFString ? firstId.asBytes() : null;
  const newId = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const size = context.largestObjectNumber + 1;
  const { bytes, offsets } = appendRevision(original, objects, {
    xref,
    size,
    trailer: {
      root: context.trailerInfo.Root,
      info: context.trailerInfo.Info instanceof PDFRef ? context.trailerInfo.Info : null,
      id: [idBytes || newId, newId],
    },
  });

  const sigOffset =
    offsets.get(sigRef.objectNumber) + ascii(`${sigRef.objectNumber} 0 obj\n`).length;
  const contentsStart = sigOffset + head.length - 1; // the "<"
  const contentsEnd = sigOffset + head.length + reserve * 2 + 1; // after the ">"
  const byteRange = [0, contentsStart, contentsEnd, bytes.length - contentsEnd];
  const rangeText = `[${byteRange.join(' ')}`;
  const placeholderAt = sigOffset + head.indexOf(BYTE_RANGE_PLACEHOLDER);
  const filled = (
    rangeText +
    ' '.repeat(BYTE_RANGE_PLACEHOLDER.length - rangeText.length - 1) +
    ']'
  ).slice(0, BYTE_RANGE_PLACEHOLDER.length);
  if (rangeText.length + 1 > BYTE_RANGE_PLACEHOLDER.length)
    throw new Error('This PDF is too large to sign.');
  bytes.set(ascii(filled), placeholderAt);
  return {
    bytes,
    byteRange,
    contentsStart,
    contentsEnd,
    reserve,
    subFilter,
    fieldName: field ? field.name : textOf(widgetDict.get(name('T'))),
    /** The bytes the signature covers, as two views. */
    signedParts: () => [bytes.subarray(0, contentsStart), bytes.subarray(contentsEnd)],
  };
}

/** Second half of signing: write a DER CMS signature into the prepared placeholder. */
export function embedPdfSignature(prepared, cms) {
  const hex = hexOf(cms);
  if (hex.length > prepared.reserve * 2)
    throw new Error('The signature is larger than the space reserved for it.');
  const bytes = prepared.bytes.slice();
  bytes.set(ascii(hex), prepared.contentsStart + 1);
  return bytes;
}

/**
 * Sign a PDF with a digital ID (`{ privateKey, certificate, chain }`) by appending an
 * incremental update. See preparePdfSignature for the options. Resolves to the signed bytes.
 */
export async function signPdf(input, identity, options = {}) {
  if (!identity?.privateKey || !identity?.certificate)
    throw new Error('Choose a digital ID to sign with.');
  const cert = parseCertificate(identity.certificate);
  const signingTime = options.signingTime || new Date();
  if (signingTime < cert.notBefore || signingTime > cert.notAfter)
    throw new Error('The digital ID has expired or is not yet valid.');
  let reserve = options.reserve;
  for (let attempt = 0; ; attempt++) {
    const prepared = await preparePdfSignature(input, {
      ...options,
      reserve,
      signingTime,
      certificate: identity.certificate,
      chain: identity.chain || [],
    });
    const hash = signingHash(identity.privateKey);
    const contentDigest = await digest(hash, prepared.signedParts());
    const cms = await createSignedData({
      privateKey: identity.privateKey,
      certificate: identity.certificate,
      chain: identity.chain || [],
      contentDigest,
      signingTime,
      cades: prepared.subFilter === 'ETSI.CAdES.detached',
      timestamp: options.timestamp || null,
    });
    // A long timestamp chain can outgrow the estimate: prepare again with room for it.
    if (cms.length > prepared.reserve && attempt === 0) {
      reserve = cms.length + 4096;
      continue;
    }
    return embedPdfSignature(prepared, cms);
  }
}

/**
 * Add a document timestamp (PAdES, SubFilter ETSI.RFC3161): an RFC 3161 token from a TSA
 * over the whole document. `timestamp` sends a TimeStampReq and resolves to the TimeStampResp.
 */
export async function timestampPdf(input, { timestamp, fieldName, reserve } = {}) {
  if (typeof timestamp !== 'function') throw new Error('A timestamp server is required.');
  const prepared = await preparePdfSignature(input, {
    subFilter: 'ETSI.RFC3161',
    fieldName,
    reserve: reserve || 12288,
  });
  const token = await requestTimestamp(timestamp, prepared.signedParts());
  return embedPdfSignature(prepared, token);
}

/* ---------- Validation ---------- */
const STATUS_TEXT = {
  valid: 'Signature is valid.',
  'valid-unknown-identity':
    "Signature validity is unknown: the signer's identity has not been verified.",
  modified: 'Signature is invalid: the document was changed in ways the signer did not allow.',
  invalid: 'Signature is invalid: the document was altered or corrupted since it was signed.',
  unsupported: 'Signature cannot be checked.',
};

/** Check /ByteRange against the file; returns the covered parts and the /Contents bytes. */
function readByteRange(data, sig, context) {
  const array = context.lookup(sig.get(name('ByteRange')));
  if (!(array instanceof PDFArray)) return { error: 'The signature has no byte range.' };
  const values = array.asArray().map((v) => numberOf(context.lookup(v)));
  if (
    values.length < 4 ||
    values.length % 2 ||
    values.some((v) => v == null || v < 0 || !Number.isInteger(v))
  )
    return { error: 'The signature byte range is malformed.' };
  if (values[0] !== 0)
    return {
      error: 'The signature byte range does not start at the beginning of the file.',
    };
  const parts = [];
  let previousEnd = 0;
  for (let i = 0; i < values.length; i += 2) {
    const start = values[i];
    const end = start + values[i + 1];
    if (start < previousEnd || end > data.length)
      return { error: 'The signature byte range is outside the file.' };
    // Only the signature value may be left out; bytes in any other gap could change unseen.
    if (i > 2 && start !== previousEnd)
      return { error: 'The signature byte range leaves part of the file unsigned.' };
    parts.push(data.subarray(start, end));
    previousEnd = end;
  }
  const gapStart = values[0] + values[1];
  const gapEnd = values[2];
  if (data[gapStart] !== 0x3c || data[gapEnd - 1] !== 0x3e)
    return {
      error: 'The signature byte range does not exclude exactly the signature value.',
    };
  const hex = data.subarray(gapStart + 1, gapEnd - 1);
  for (const byte of hex)
    if (!(
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x46) ||
      (byte >= 0x61 && byte <= 0x66) ||
      byte <= 0x20
    ))
      return { error: 'The signature value is not a hex string.' };
  let text = '';
  for (let i = 0; i < hex.length; i += 0x8000)
    text += String.fromCharCode(...hex.subarray(i, i + 0x8000));
  const contents = bytesOfHex(text);
  // The gap must hold this dictionary's /Contents (not another string).
  const own = sig.get(name('Contents'));
  if (own instanceof PDFHexString || own instanceof PDFString) {
    const ownBytes = own.asBytes();
    const length = Math.min(ownBytes.length, contents.length);
    if (!bytesEqual(ownBytes.subarray(0, length), contents.subarray(0, length)))
      return {
        error: "The signature byte range does not match the signature's value.",
      };
  }
  return {
    values,
    parts,
    contents,
    end: values[values.length - 2] + values[values.length - 1],
  };
}

/* ----- What changed after a signature ----- */
const SKIP_KEYS = new Set([
  'Parent',
  'P',
  'Prev',
  'Next',
  'First',
  'Last',
  'Dest',
  'A',
  'StructParent',
  'StructParents',
]);
function reachable(context, start, into, role, stopAt) {
  const stack = [start];
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    let value = stack.pop();
    if (value instanceof PDFRef) {
      if (stopAt.has(value.objectNumber)) continue;
      const roles = into.get(value.objectNumber) || new Set();
      if (roles.has(role)) continue;
      roles.add(role);
      into.set(value.objectNumber, roles);
      value = context.lookup(value);
    }
    if (value instanceof PDFStream) value = value.dict;
    if (value instanceof PDFDict) {
      for (const [key, child] of value.entries())
        if (!SKIP_KEYS.has(key.decodeText())) stack.push(child);
    } else if (value instanceof PDFArray) for (const child of value.asArray()) stack.push(child);
  }
}

/** What each object of a document is: page, content, annotation, field, signature... */
function objectRoles(doc) {
  const { context, catalog } = doc;
  const roles = new Map();
  const fieldNames = new Map();
  const add = (ref, role) => {
    if (!(ref instanceof PDFRef)) return;
    const set = roles.get(ref.objectNumber) || new Set();
    set.add(role);
    roles.set(ref.objectNumber, set);
  };
  add(context.trailerInfo.Root, 'catalog');
  add(context.trailerInfo.Info, 'info');
  add(catalog.get(name('Metadata')), 'metadata');
  const pageRefs = new Set();
  const nodes = [catalog.get(name('Pages'))];
  for (let guard = 0; nodes.length && guard < 100000; guard++) {
    const ref = nodes.pop();
    const node = context.lookup(ref);
    if (!(node instanceof PDFDict)) continue;
    if (ref instanceof PDFRef && roles.get(ref.objectNumber)?.has('pages')) continue;
    const kids = context.lookup(node.get(name('Kids')));
    if (kids instanceof PDFArray && nameOf(node.get(name('Type'))) !== 'Page') {
      add(ref, 'pages');
      add(node.get(name('Kids')), 'pages');
      nodes.push(...kids.asArray());
    } else {
      add(ref, 'page');
      if (ref instanceof PDFRef) pageRefs.add(ref.objectNumber);
    }
  }
  const stop = new Set(pageRefs);
  for (const objectNumber of pageRefs) {
    const page = context.lookup(PDFRef.of(objectNumber));
    reachable(context, page.get(name('Contents')), roles, 'content', stop);
    reachable(context, page.get(name('Resources')), roles, 'content', stop);
    const annotsEntry = page.get(name('Annots'));
    add(annotsEntry, 'annots-array');
    const annots = context.lookup(annotsEntry);
    if (annots instanceof PDFArray)
      for (const annot of annots.asArray()) {
        const dict = context.lookup(annot);
        if (!(dict instanceof PDFDict)) continue;
        add(annot, nameOf(dict.get(name('Subtype'))) === 'Widget' ? 'field' : 'annotation');
        reachable(context, dict.get(name('AP')), roles, 'appearance', stop);
        const popup = dict.get(name('Popup'));
        add(popup, 'annotation');
      }
  }
  const form = catalog.get(name('AcroForm'));
  add(form, 'acroform');
  const formDict = context.lookup(form);
  if (formDict instanceof PDFDict) {
    add(formDict.get(name('Fields')), 'fields-array');
    reachable(context, formDict.get(name('DR')), roles, 'form-resources', stop);
    // The resource dictionaries themselves: entries may be added to them (formChanges).
    const resources = formDict.get(name('DR'));
    add(resources, 'form-resources-dict');
    const resourceDict = context.lookup(resources);
    if (resourceDict instanceof PDFDict)
      for (const [, value] of resourceDict.entries()) add(value, 'form-resources-dict');
    reachable(context, formDict.get(name('XFA')), roles, 'xfa', stop);
    const visit = (ref, parent, depth) => {
      const dict = context.lookup(ref);
      if (!(dict instanceof PDFDict) || depth > 32) return;
      const t = textOf(dict.get(name('T')));
      const full = t ? (parent ? `${parent}.${t}` : t) : parent;
      add(ref, 'field');
      if (ref instanceof PDFRef) fieldNames.set(ref.objectNumber, full);
      const value = dict.get(name('V'));
      const valueDict = context.lookup(value);
      if (valueDict instanceof PDFDict && isSignatureValue(valueDict)) {
        const type = nameOf(valueDict.get(name('Type')));
        reachable(context, value, roles, type === 'DocTimeStamp' ? 'timestamp' : 'sig', stop);
      }
      reachable(context, dict.get(name('AP')), roles, 'appearance', stop);
      const kidsEntry = dict.get(name('Kids'));
      add(kidsEntry, 'fields-array');
      const kids = context.lookup(kidsEntry);
      if (kids instanceof PDFArray) for (const kid of kids.asArray()) visit(kid, full, depth + 1);
    };
    const fields = context.lookup(formDict.get(name('Fields')));
    if (fields instanceof PDFArray) for (const f of fields.asArray()) visit(f, '', 0);
  }
  reachable(context, catalog.get(name('DSS')), roles, 'dss', stop);
  return { roles, fieldNames };
}

function sameObject(a, b) {
  if (a instanceof PDFRawStream || b instanceof PDFRawStream)
    return (
      a instanceof PDFRawStream &&
      b instanceof PDFRawStream &&
      bytesEqual(a.contents, b.contents) &&
      serialized(a.dict) === serialized(b.dict)
    );
  return a.constructor === b.constructor && serialized(a) === serialized(b);
}
function serialized(object) {
  try {
    const bytes = objectBytes(object);
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return text;
  } catch {
    return String(object);
  }
}
function changedKeys(before, after) {
  const keys = new Set();
  const a = new Map([...before.entries()].map(([k, v]) => [k.decodeText(), v]));
  const b = new Map([...after.entries()].map(([k, v]) => [k.decodeText(), v]));
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (!x || !y || serialized(x) !== serialized(y)) keys.add(key);
  }
  return keys;
}

const diffCache = new WeakMap();
/** The objects added or changed after `end`, with their roles in the old and new revision. */
async function revisionChanges(data, finalDoc, end) {
  let perFile = diffCache.get(data);
  if (!perFile) diffCache.set(data, (perFile = new Map()));
  if (perFile.has(end)) return perFile.get(end);
  const promise = (async () => {
    const oldDoc = await loadPdf(data.subarray(0, end));
    const oldObjects = new Map(
      oldDoc.context.enumerateIndirectObjects().map(([ref, obj]) => [ref.objectNumber, obj]),
    );
    const oldRoles = objectRoles(oldDoc);
    const newRoles = objectRoles(finalDoc);
    const changes = [];
    for (const [ref, object] of finalDoc.context.enumerateIndirectObjects()) {
      const before = oldObjects.get(ref.objectNumber);
      if (before && sameObject(before, object)) continue;
      const roles = new Set([
        ...(oldRoles.roles.get(ref.objectNumber) || []),
        ...(newRoles.roles.get(ref.objectNumber) || []),
      ]);
      changes.push({
        objectNumber: ref.objectNumber,
        added: !before,
        before,
        after: object,
        roles,
        fieldName:
          newRoles.fieldNames.get(ref.objectNumber) ?? oldRoles.fieldNames.get(ref.objectNumber),
      });
    }
    let oldPages = [];
    let newPages = [];
    try {
      oldPages = oldDoc.getPages().map((p) => p.ref.objectNumber);
      newPages = finalDoc.getPages().map((p) => p.ref.objectNumber);
    } catch {
      // A damaged page tree is reported through the page objects' changes.
    }
    const root = (doc) => String(doc.context.trailerInfo.Root);
    return {
      changes,
      oldDoc,
      pagesChanged: oldPages.join() !== newPages.join(),
      // Pointing the trailer at another catalog swaps every document setting at once.
      rootChanged: root(oldDoc) !== root(finalDoc),
    };
  })();
  perFile.set(end, promise);
  return promise;
}

/** What filling in a field (or signing a signature field) may change in its dictionaries. */
const FILL_KEYS = new Set(['V', 'AS', 'AP', 'RV', 'I', 'TI', 'DA', 'M', 'Kids']);
function fieldTypeOf(context, dict) {
  for (let node = dict, depth = 0; node instanceof PDFDict && depth < 32; depth++) {
    const type = nameOf(node.get(name('FT')));
    if (type) return type;
    node = context.lookup(node.get(name('Parent')));
  }
  return null;
}
const annotRefs = (context, page) => {
  const annots = context.lookup(page?.get?.(name('Annots')));
  return annots instanceof PDFArray
    ? annots
        .asArray()
        .filter((a) => a instanceof PDFRef)
        .map((a) => a.objectNumber)
    : [];
};

/** What may change in the AcroForm dictionary itself (its fields are classified one by one). */
const FORM_KEYS_SIGNING = new Set(['Fields', 'SigFlags', 'DR']);
/**
 * Changes to the form dictionary: removed fields, replaced resources, and new settings such
 * as XFA or a default appearance, which change how fields show without filling them in.
 * Filling may set NeedAppearances and add resources (a font for the text typed).
 */
function formChanges(oldDoc, finalDoc, note, { formOk, otherOk }) {
  const formOf = (doc) => doc.context.lookup(doc.catalog.get(name('AcroForm')));
  const before = formOf(oldDoc),
    after = formOf(finalDoc);
  if (!(before instanceof PDFDict)) {
    // A first signature creates the form; only what signing writes is expected.
    if (!(after instanceof PDFDict)) return;
    const other = after
      .keys()
      .map((key) => key.decodeText())
      .filter((key) => !FORM_KEYS_SIGNING.has(key) && key !== 'DA');
    if (other.length) note(otherOk, `The form's settings were changed (${other.join(', ')}).`);
    return;
  }
  if (!(after instanceof PDFDict)) {
    note(otherOk, 'The form was removed.');
    return;
  }
  const fieldNumbers = (doc, form) => {
    const fields = doc.context.lookup(form.get(name('Fields')));
    return fields instanceof PDFArray
      ? fields
          .asArray()
          .filter((ref) => ref instanceof PDFRef)
          .map((ref) => ref.objectNumber)
      : [];
  };
  const kept = new Set(fieldNumbers(finalDoc, after));
  if (fieldNumbers(oldDoc, before).some((number) => !kept.has(number)))
    note(otherOk, 'A form field was removed.');
  // Resources by category and name, as references or serialized values.
  const resourceEntries = (doc, form) => {
    const entries = new Map();
    const resources = doc.context.lookup(form.get(name('DR')));
    if (!(resources instanceof PDFDict)) return entries;
    for (const [category, value] of resources.entries()) {
      const group = doc.context.lookup(value);
      if (group instanceof PDFDict)
        for (const [key, entry] of group.entries())
          entries.set(
            `${category.decodeText()}/${key.decodeText()}`,
            entry instanceof PDFRef ? `ref ${entry.objectNumber}` : serialized(entry),
          );
      else entries.set(category.decodeText(), serialized(group));
    }
    return entries;
  };
  const resourcesNow = resourceEntries(finalDoc, after);
  for (const [key, value] of resourceEntries(oldDoc, before))
    if (resourcesNow.get(key) !== value) {
      note(otherOk, "The form's fonts or other resources were changed.");
      break;
    }
  const settings = [];
  for (const key of changedKeys(before, after)) {
    if (FORM_KEYS_SIGNING.has(key)) continue;
    if (key === 'NeedAppearances') note(formOk, 'The form asks viewers to redraw its fields.');
    else if (key === 'XFA' && before.has(name('XFA')) && after.has(name('XFA')))
      note(formOk, "The form's XFA data was updated.");
    else settings.push(key);
  }
  if (settings.length) note(otherOk, `The form's settings were changed (${settings.join(', ')}).`);
}

/**
 * Classify the changes made after a signature. `level` is the DocMDP permission (1: none,
 * 2: form filling and signing, 3: also annotations) or 'approval' for a signature with no
 * restrictions of its own (form filling, signing and annotations allowed, as in Acrobat).
 */
function classifyChanges(
  { changes, oldDoc, pagesChanged, rootChanged },
  finalDoc,
  { level, locks, ownSigNumber },
) {
  const allowed = [];
  const disallowed = [];
  const formOk = level !== 1;
  const annotsOk = level === 3 || level === 'approval';
  const note = (ok, text) => {
    const list = ok ? allowed : disallowed;
    if (!list.includes(text)) list.push(text);
  };
  if (pagesChanged) note(false, 'Pages were added, removed or reordered.');
  if (rootChanged) note(false, 'The document catalog was replaced.');
  const fieldLocked = (fieldName) => {
    if (!fieldName) return false;
    for (const lock of locks) {
      const listed = lock.fields.some((f) => fieldName === f || fieldName.startsWith(`${f}.`));
      if (
        lock.action === 'All' ||
        (lock.action === 'Include' && listed) ||
        (lock.action === 'Exclude' && !listed)
      )
        return true;
    }
    return false;
  };
  formChanges(oldDoc, finalDoc, note, { formOk, otherOk: level === 'approval' });
  for (const change of changes) {
    const { roles, after, before, added } = change;
    const dict = after instanceof PDFDict ? after : after instanceof PDFStream ? after.dict : null;
    if (change.objectNumber === ownSigNumber) {
      note(false, 'The signature itself was changed.');
      continue;
    }
    if (roles.has('content')) {
      if (!added) note(false, 'Page content was changed.');
      continue;
    }
    if (roles.has('pages')) {
      if (!added) note(false, 'Pages were added, removed or reordered.');
      continue;
    }
    if (roles.has('page')) {
      if (added) continue;
      const keys =
        before instanceof PDFDict && after instanceof PDFDict
          ? changedKeys(before, after)
          : new Set(['?']);
      const other = [...keys].filter((k) => k !== 'Annots');
      if (other.length) note(false, `Page properties were changed (${other.join(', ')}).`);
      const removed = annotRefs(oldDoc.context, before).filter(
        (n) => !annotRefs(finalDoc.context, after).includes(n),
      );
      if (removed.length) note(annotsOk, 'Annotations were deleted.');
      continue;
    }
    if (roles.has('catalog')) {
      if (rootChanged) continue;
      const keys =
        before instanceof PDFDict && after instanceof PDFDict
          ? changedKeys(before, after)
          : new Set(['?']);
      const harmless = new Set(['AcroForm', 'DSS', 'Metadata']);
      const other = [...keys].filter((k) => !harmless.has(k));
      if (other.length) note(false, `Document settings were changed (${other.join(', ')}).`);
      continue;
    }
    if (roles.has('timestamp') || roles.has('dss')) {
      note(
        true,
        roles.has('timestamp') ? 'A document timestamp was added.' : 'Validation data was added.',
      );
      continue;
    }
    if (roles.has('sig')) {
      if (added || !(before instanceof PDFDict)) note(formOk, 'The document was signed.');
      else note(false, 'An earlier signature was changed.');
      continue;
    }
    if (roles.has('field')) {
      const type = nameOf(dict?.get(name('FT')));
      const value = finalDoc.context.lookup(dict?.get(name('V')));
      if (added) {
        if (isSignatureValue(value) && nameOf(value.get(name('Type'))) === 'DocTimeStamp')
          note(true, 'A document timestamp was added.');
        else if (type === 'Sig' || isSignatureValue(value))
          note(formOk, 'A signature field was added.');
        else if (dict && !dict.has(name('T')) && nameOf(dict.get(name('Subtype'))) === 'Widget')
          note(formOk, 'A form field widget was added.');
        else note(level === 'approval', 'A form field was added.');
        continue;
      }
      if (fieldLocked(change.fieldName)) {
        note(false, `The locked field "${change.fieldName}" was changed.`);
        continue;
      }
      // Filling in changes a field's value and its drawing. Moving, hiding, or redefining a
      // field changes what the signer saw, which only annotation rights cover.
      const keys =
        before instanceof PDFDict && after instanceof PDFDict
          ? changedKeys(before, after)
          : new Set(['?']);
      const signatureField = fieldTypeOf(finalDoc.context, dict) === 'Sig';
      const other = [...keys].filter(
        (key) => !FILL_KEYS.has(key) && !(signatureField && key === 'MK'),
      );
      if (other.length) {
        note(
          annotsOk,
          `${change.fieldName ? `The form field "${change.fieldName}"` : 'A form field'} was changed (${other.join(', ')}).`,
        );
        continue;
      }
      note(
        formOk,
        change.fieldName
          ? `The form field "${change.fieldName}" was filled in.`
          : 'A form field was filled in.',
      );
      continue;
    }
    if (roles.has('annotation')) {
      note(annotsOk, added ? 'An annotation was added.' : 'An annotation was changed.');
      continue;
    }
    if (roles.has('form-resources-dict')) continue;
    if (roles.has('form-resources')) {
      // Fonts the fields' drawings share: changing one changes text already drawn.
      if (!added) note(level === 'approval', "The form's fonts or other resources were changed.");
      continue;
    }
    if (roles.has('xfa')) {
      // Filling in a form that also has XFA updates its XFA data.
      if (!added) note(formOk, "The form's XFA data was updated.");
      continue;
    }
    if (roles.has('appearance')) {
      if (!added) note(formOk, 'An appearance was updated.');
      continue;
    }
    if (roles.has('acroform') || roles.has('fields-array') || roles.has('annots-array')) {
      if (roles.has('annots-array') && before instanceof PDFArray && after instanceof PDFArray) {
        const now = after.asArray().map((a) => (a instanceof PDFRef ? a.objectNumber : -1));
        const removed = before
          .asArray()
          .some((a) => a instanceof PDFRef && !now.includes(a.objectNumber));
        if (removed) note(annotsOk, 'Annotations were deleted.');
      }
      continue;
    }
    if (roles.has('info') || roles.has('metadata')) {
      note(true, 'Document properties were updated.');
      continue;
    }
    if (added || !roles.size) continue; // unreferenced or reached only through the changes above
    note(level === 'approval' || level === 3, 'Other parts of the document were changed.');
  }
  return { allowed, disallowed };
}

/* ----- One signature ----- */
function lockOf(context, sig) {
  const params = transformParams(context, sig, 'FieldMDP');
  if (!(params instanceof PDFDict)) return null;
  const fields = context.lookup(params.get(name('Fields')));
  return {
    action: nameOf(params.get(name('Action'))) || 'All',
    fields:
      fields instanceof PDFArray ? fields.asArray().map((f) => textOf(context.lookup(f))) : [],
  };
}

function isValidAt(cert, time) {
  return !!time && time >= cert.notBefore && time <= cert.notAfter;
}

async function checkCms({ subFilter, contents, parts }) {
  const cms = parseSignedData(contents);
  const signer = cms.signerInfos[0];
  let content = parts;
  let digestNote = null;
  if (subFilter === 'adbe.pkcs7.sha1') {
    const sha1 = await digest('SHA-1', parts);
    if (!cms.eContent || !bytesEqual(cms.eContent, sha1))
      digestNote = 'The signed SHA-1 digest does not match the document.';
    content = cms.eContent || new Uint8Array(0);
  }
  const check = await verifySigner(cms, signer, content);
  if (digestNote) check.digestMatches = false;
  let timestamp = null;
  const token = signer.unsignedAttrs.get(OID.timeStampToken)?.[0];
  if (token) timestamp = await verifyTimestampToken(token.der, signer.signature);
  return { cms, signer, check, timestamp };
}

async function checkRsaSha1({ sig, context, contents, parts }) {
  const certEntry = context.lookup(sig.get(name('Cert')));
  const certStrings =
    certEntry instanceof PDFArray ? certEntry.asArray().map((c) => context.lookup(c)) : [certEntry];
  const certificates = certStrings
    .filter((c) => c instanceof PDFString || c instanceof PDFHexString)
    .map((c) => {
      try {
        return parseCertificate(c.asBytes());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const signature = decodeDer(contents).octets();
  const check = {
    certificate: certificates[0] || null,
    digestMatches: true,
    signatureValid: false,
    digestAlgorithm: 'SHA-1',
    signingTime: null,
  };
  if (!check.certificate) {
    check.error = "The signer's certificate is not in the signature.";
    return { cms: { certificates }, check, timestamp: null };
  }
  for (const hash of ['SHA-1', 'SHA-256']) {
    try {
      if (
        await verifySignature({
          spki: check.certificate.spki,
          scheme: { kind: 'rsa', hash },
          data: concatParts(parts),
          signature,
        })
      ) {
        check.signatureValid = true;
        check.digestAlgorithm = hash;
        break;
      }
    } catch (error) {
      check.error = error.message;
    }
  }
  return { cms: { certificates }, check, timestamp: null };
}
function concatParts(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function dssCertificates(doc) {
  const { context } = doc;
  const dss = context.lookup(doc.catalog.get(name('DSS')));
  const certs = dss instanceof PDFDict ? context.lookup(dss.get(name('Certs'))) : null;
  if (!(certs instanceof PDFArray)) return [];
  const out = [];
  for (const ref of certs.asArray()) {
    const stream = context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    try {
      out.push(parseCertificate(decodePDFRawStream(stream).decode()));
    } catch {
      // Not a certificate.
    }
  }
  return out;
}

/**
 * Validate every signature in a PDF. Never throws for malformed input; problems are reported
 * per signature. Options: `trustedCertificates` (DER bytes or PEM text; signers chaining to one
 * of them count as trusted), `password` (for encrypted files' text fields), `now`.
 *
 * Each result has a `status` of 'valid', 'valid-unknown-identity', 'modified', 'invalid' or
 * 'unsupported', a `summary` sentence, and the details Acrobat's Signature panel shows.
 */
export async function verifySignatures(
  input,
  { trustedCertificates = [], password = '', now = new Date() } = {},
) {
  let data;
  let doc;
  try {
    data = toBytes(input);
    doc = await loadPdf(data);
  } catch {
    return [];
  }
  const trusted = parseCertificateList(trustedCertificates);
  let fields;
  try {
    fields = collectFields(doc).filter((field) => isSignatureValue(field.value));
  } catch {
    return [];
  }
  // Encrypted files: read the text fields from a decrypted copy (signature values are never encrypted).
  let plain = null;
  if (doc.context.trailerInfo.Encrypt) {
    try {
      plain = await loadPdf((await unlockPdf(data, password)).bytes);
    } catch {
      plain = null;
    }
  }
  const plainNames = new Map();
  if (plain)
    try {
      for (const f of collectFields(plain)) if (f.ref) plainNames.set(f.ref.objectNumber, f.name);
    } catch {
      // Keep the encrypted names.
    }
  const plainText = (ref, key, fallback) => {
    if (!plain || !ref) return fallback;
    const dict = plain.context.lookup(ref);
    return dict instanceof PDFDict ? textOf(dict.get(name(key))) : fallback;
  };
  const ends = revisionEnds(data);
  const dss = dssCertificates(doc);
  const perms = doc.context.lookup(doc.catalog.get(name('Perms')));
  const certSigRef = perms instanceof PDFDict ? perms.get(name('DocMDP')) : null;
  const certification = certSigRef ? doc.context.lookup(certSigRef) : null;
  const docLevel =
    certification instanceof PDFDict ? (docMdpOf(doc.context, certification) ?? 2) : null;

  const results = [];
  for (const field of fields) {
    const fieldName = (field.ref && plainNames.get(field.ref.objectNumber)) ?? field.name;
    results.push(
      await verifyOne({
        data,
        doc,
        field,
        fieldName,
        trusted,
        dss,
        ends,
        docLevel,
        certSigRef,
        plainText,
        now,
      }),
    );
  }
  results.sort(
    (a, b) =>
      (a.byteRange?.[2] ?? 0) +
      (a.byteRange?.[3] ?? 0) -
      ((b.byteRange?.[2] ?? 0) + (b.byteRange?.[3] ?? 0)),
  );
  return results;
}

async function verifyOne({
  data,
  doc,
  field,
  fieldName,
  trusted,
  dss,
  ends,
  docLevel,
  certSigRef,
  plainText,
  now,
}) {
  const { context } = doc;
  const sig = field.value;
  const summary = fieldSummary(field);
  const ref = field.valueRef;
  const report = {
    fieldName,
    page: summary.page,
    rect: summary.rect,
    invisible: summary.invisible,
    status: 'unsupported',
    summary: '',
    kind: 'approval',
    filter: nameOf(sig.get(name('Filter'))),
    subFilter: nameOf(sig.get(name('SubFilter'))),
    signer: null,
    signingTime: null,
    signingTimeSource: null,
    reason: plainText(ref, 'Reason', textOf(sig.get(name('Reason')))),
    location: plainText(ref, 'Location', textOf(sig.get(name('Location')))),
    contactInfo: plainText(ref, 'ContactInfo', textOf(sig.get(name('ContactInfo')))),
    nameInSignature: plainText(ref, 'Name', textOf(sig.get(name('Name')))),
    byteRange: null,
    coversWholeDocument: false,
    revision: null,
    totalRevisions: ends.length,
    laterRevisions: false,
    modifications: { allowed: [], disallowed: [] },
    integrity: {
      digestMatches: false,
      signatureValid: false,
      digestAlgorithm: null,
      signatureAlgorithm: null,
    },
    certificate: null,
    chain: [],
    chainComplete: false,
    selfSigned: false,
    trusted: false,
    certificateValidAtSigningTime: false,
    certificateExpired: false,
    timestamp: null,
    certification: null,
    fieldLock: lockOf(context, sig),
    revocation: 'not checked',
    errors: [],
    warnings: [],
  };
  const fail = (status, message) => {
    report.status = status;
    if (message) report.errors.push(message);
    report.summary = `${STATUS_TEXT[status]}${message ? ` ${message}` : ''}`;
    return report;
  };
  try {
    const type = nameOf(sig.get(name('Type')));
    const mText = plainText(ref, 'M', textOf(sig.get(name('M'))));
    const claimedTime = mText ? parsePdfDate(mText) : null;
    if (type === 'DocTimeStamp' || report.subFilter === 'ETSI.RFC3161') report.kind = 'timestamp';
    if (ref && certSigRef instanceof PDFRef && ref.objectNumber === certSigRef.objectNumber)
      report.kind = 'certification';
    const mdp = docMdpOf(context, sig);
    if (mdp) {
      report.kind = 'certification';
      report.certification = { level: mdp };
    }
    const range = readByteRange(data, sig, context);
    if (range.error) return fail('invalid', range.error);
    report.byteRange = range.values;
    report.coversWholeDocument = range.end === data.length || onlyWhitespaceAfter(data, range.end);
    report.revision = ends.filter((end) => end <= range.end + 2).length || 1;
    report.laterRevisions = !report.coversWholeDocument;

    // Cryptographic check.
    let outcome;
    if (report.kind === 'timestamp') {
      const ts = await verifyTimestampToken(range.contents, range.parts);
      report.timestamp = {
        time: ts.time,
        valid: ts.imprintMatches && ts.signatureValid,
        tsa: ts.tsa,
        imprintMatches: ts.imprintMatches,
      };
      outcome = {
        cms: { certificates: ts.certificates || [] },
        check: {
          certificate: ts.certificate,
          digestMatches: ts.imprintMatches,
          signatureValid: ts.signatureValid,
          digestAlgorithm: null,
          signingTime: ts.time,
          error: ts.error,
        },
        timestamp: null,
      };
    } else if (report.subFilter === 'adbe.x509.rsa_sha1') {
      outcome = await checkRsaSha1({
        sig,
        context,
        contents: range.contents,
        parts: range.parts,
      });
    } else if (
      ['adbe.pkcs7.detached', 'ETSI.CAdES.detached', 'adbe.pkcs7.sha1'].includes(report.subFilter)
    ) {
      outcome = await checkCms({
        subFilter: report.subFilter,
        contents: range.contents,
        parts: range.parts,
      });
    } else {
      return fail(
        'unsupported',
        `The signature format ${report.subFilter || '(none)'} is not supported.`,
      );
    }
    const { check } = outcome;
    report.integrity = {
      digestMatches: !!check.digestMatches,
      signatureValid: !!check.signatureValid,
      digestAlgorithm: check.digestAlgorithm || null,
      signatureAlgorithm: check.scheme
        ? `${check.scheme.kind.toUpperCase()} with ${check.scheme.hash}`
        : null,
    };
    if (outcome.timestamp) {
      const ts = outcome.timestamp;
      report.timestamp = {
        time: ts.time,
        valid: ts.imprintMatches && ts.signatureValid,
        tsa: ts.tsa,
        imprintMatches: ts.imprintMatches,
      };
      if (!report.timestamp.valid) report.warnings.push('The signature timestamp is invalid.');
    }
    const cert = check.certificate;
    if (cert) {
      report.certificate = certificateSummary(cert);
      report.signer = {
        name: cert.subject.commonName || report.nameInSignature,
        email: cert.email,
        organization: cert.subject.organization,
        organizationalUnit: cert.subject.organizationalUnit,
        country: cert.subject.country,
        subject: cert.subject.text,
        issuer: cert.issuer.text,
      };
    } else if (report.nameInSignature) report.signer = { name: report.nameInSignature };
    // When.
    const tsTime =
      report.kind === 'timestamp'
        ? check.signingTime
        : report.timestamp?.valid
          ? report.timestamp.time
          : null;
    if (tsTime) {
      report.signingTime = tsTime;
      report.signingTimeSource = 'timestamp';
    } else if (check.signingTime) {
      report.signingTime = check.signingTime;
      report.signingTimeSource = 'signed-attribute';
    } else if (claimedTime) {
      report.signingTime = claimedTime;
      report.signingTimeSource = 'signature-dictionary';
    }
    if (check.unsupported) return fail('unsupported', check.unsupported);
    if (!check.digestMatches)
      return fail('invalid', 'The document digest does not match the signed digest.');
    if (!check.signatureValid)
      return fail(
        'invalid',
        check.error || 'The signature does not match the signer’s certificate.',
      );

    // Identity.
    if (cert) {
      const pool = [...(outcome.cms.certificates || []), ...dss, ...trusted];
      const built = await buildChain(cert, pool);
      report.chain = built.chain.map(certificateSummary);
      report.selfSigned = built.selfSigned;
      report.chainComplete = built.selfSigned;
      if (built.brokenLink)
        report.warnings.push('A certificate in the chain has an invalid signature.');
      const trust = await chainTrust(built.chain, trusted);
      report.trusted = trust.trusted && !built.brokenLink;
      const when = report.signingTime || now;
      report.certificateValidAtSigningTime = built.chain.every((c) => isValidAt(c, when));
      report.certificateExpired = now > cert.notAfter;
      if (!report.certificateValidAtSigningTime)
        report.warnings.push("The signer's certificate was not valid at the signing time.");
      const usage = cert.extensions.keyUsage;
      if (usage && !usage.includes('digitalSignature') && !usage.includes('nonRepudiation'))
        report.warnings.push("The signer's certificate is not meant for signing.");
    }

    // Later revisions.
    if (report.laterRevisions) {
      const diff = await revisionChanges(data, doc, range.end);
      const level =
        report.kind === 'timestamp'
          ? (docLevel ?? 'approval')
          : (report.certification?.level ?? docLevel ?? 'approval');
      const locks = report.fieldLock ? [report.fieldLock] : [];
      report.modifications = classifyChanges(diff, doc, {
        level,
        locks,
        ownSigNumber: ref?.objectNumber,
      });
    }
    if (report.modifications.disallowed.length)
      return fail('modified', report.modifications.disallowed.join(' '));
    report.status =
      report.trusted && report.certificateValidAtSigningTime ? 'valid' : 'valid-unknown-identity';
    const who = report.signer?.name ? ` Signed by ${report.signer.name}.` : '';
    const changes = report.laterRevisions
      ? ' This revision has not been altered; the document has later changes that the signature allows.'
      : ' The document has not been modified since it was signed.';
    report.summary = `${STATUS_TEXT[report.status]}${who}${changes}`;
    return report;
  } catch (error) {
    if (error instanceof CryptoUnsupportedError) return fail('unsupported', error.message);
    return fail('invalid', `The signature could not be read: ${error.message || error}`);
  }
}
