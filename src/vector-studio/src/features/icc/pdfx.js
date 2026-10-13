/**
 * Basic PDF/X conformance checks of a written file (a preflight of the
 * structure, not a full validator): the identification, output intent and
 * profile, trapping key, page boxes, security, fonts, annotations, and
 * for PDF/X-1a the absence of RGB, ICC-based content colors and
 * transparency. Dictionaries are read as text; content streams are
 * inflated (where the platform can) to find RGB painting operators.
 *
 * checkPdfx(bytes, 'x1a' | 'x4') -> Promise<[problem, ...]> (empty when it passes)
 */

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};

/** Objects of a PDF as { num, dict (text without stream data), stream (raw text or null) }. */
export function pdfObjects(bytes) {
  const text = typeof bytes === 'string' ? bytes : latin1(bytes);
  const out = [];
  const re = /(\d+) 0 obj\b/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) break;
    let body = text.slice(start, end);
    let stream = null;
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const ds = body.indexOf('\n', si) + 1;
      const de = body.lastIndexOf('endstream');
      const len = /\/Length (\d+)(?! \d+ R)/.exec(body.slice(0, si))?.[1];
      stream = len != null ? body.slice(ds, ds + Number(len)) : body.slice(ds, de >= 0 ? de : body.length).replace(/\r?\n$/, '');
      body = body.slice(0, si);
    }
    out.push({ num: Number(m[1]), dict: body, stream });
    re.lastIndex = end;
  }
  return out;
}

const LABEL = { x1a: 'PDF/X-1a', x4: 'PDF/X-4' };

async function inflate(text) {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    return latin1(new Uint8Array(await new Response(ds.readable).arrayBuffer()));
  } catch {
    return null;
  }
}

/** Text of the page and form content streams (decoded when Flate-compressed). */
async function contentText(objects) {
  const out = [];
  for (const o of objects) {
    if (o.stream == null || /\/Subtype \/(Image|XML)|\/Type \/Metadata|\/N \d|\/FontFile|\/Length1/.test(o.dict)) continue;
    if (/\/Filter \/FlateDecode/.test(o.dict)) {
      const t = await inflate(o.stream);
      if (t) out.push(t);
    } else if (!/\/Filter/.test(o.dict)) out.push(o.stream);
  }
  return out.join('\n');
}

const tagValue = (xml, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1]?.trim() ?? null;

/** What PDF/X-4 needs in the XMP metadata, and its agreement with the information dictionary. */
export function xmpProblems(xml, info = '') {
  const out = [];
  if (tagValue(xml, 'pdfxid:GTS_PDFXVersion') !== 'PDF/X-4') out.push('The XMP metadata does not name the PDF/X-4 version.');
  for (const tag of ['xmpMM:DocumentID', 'xmpMM:InstanceID']) if (!/^uuid:[0-9a-f-]{36}$/i.test(tagValue(xml, tag) || '')) out.push(`The XMP metadata has no ${tag.split(':')[1]}.`);
  if (!tagValue(xml, 'xmpMM:VersionID')) out.push('The XMP metadata has no VersionID.');
  if (!tagValue(xml, 'xmpMM:RenditionClass')) out.push('The XMP metadata has no RenditionClass.');
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?(Z|[+-]\d\d:\d\d)$/;
  for (const tag of ['xmp:CreateDate', 'xmp:ModifyDate', 'xmp:MetadataDate']) if (!iso.test(tagValue(xml, tag) || '')) out.push(`The XMP metadata has no valid ${tag.split(':')[1]}.`);
  if (!tagValue(xml, 'xmp:CreatorTool')) out.push('The XMP metadata has no CreatorTool.');
  if (!tagValue(xml, 'pdf:Producer')) out.push('The XMP metadata has no Producer.');
  const trapped = tagValue(xml, 'pdf:Trapped');
  if (trapped !== 'True' && trapped !== 'False') out.push('The XMP metadata has no trapping state.');
  else if (info && !new RegExp(`/Trapped /${trapped}\\b`).test(info)) out.push('The trapping state differs between the XMP metadata and the document information.');
  // Dates in the information dictionary must match the XMP ones.
  const created = tagValue(xml, 'xmp:CreateDate');
  const infoDate = /\/CreationDate \(D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(info);
  if (created && infoDate && !created.startsWith(`${infoDate[1]}-${infoDate[2]}-${infoDate[3]}T${infoDate[4]}:${infoDate[5]}:${infoDate[6]}`)) out.push('The creation date differs between the XMP metadata and the document information.');
  return out;
}

export async function checkPdfx(bytes, standard) {
  const text = latin1(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const objects = pdfObjects(text);
  const dicts = objects.map((o) => o.dict);
  const all = dicts.join('\n');
  const problems = [];
  const name = LABEL[standard] || 'PDF/X';
  const header = /^%PDF-(\d\.\d)/.exec(text)?.[1];
  if (standard === 'x1a' && header !== '1.3' && header !== '1.4') problems.push(`${name} files are PDF 1.3 or 1.4 (this one is ${header}).`);
  if (standard === 'x4' && Number(header) < 1.6) problems.push(`${name} files are PDF 1.6 or later (this one is ${header}).`);
  // Identification.
  const trailer = text.slice(text.lastIndexOf('trailer'));
  const infoNum = /\/Info (\d+) 0 R/.exec(trailer)?.[1];
  const info = objects.find((o) => String(o.num) === infoNum)?.dict || '';
  if (standard === 'x1a' && !/\/GTS_PDFXVersion \(PDF\/X-1/.test(info)) problems.push('The document information does not name the PDF/X version.');
  if (standard === 'x1a' && !/\/GTS_PDFXConformance \(PDF\/X-1a/.test(info)) problems.push('The document information does not name the PDF/X-1a conformance level.');
  if (standard === 'x4') {
    const cat = objects.find((o) => /\/Type \/Catalog/.test(o.dict))?.dict || '';
    const metaNum = /\/Metadata (\d+) 0 R/.exec(cat)?.[1];
    const metaObj = objects.find((o) => String(o.num) === metaNum);
    const meta = metaObj && !/\/Filter/.test(metaObj.dict) ? metaObj.stream || '' : '';
    if (!meta) problems.push('The document has no readable XMP metadata.');
    else problems.push(...xmpProblems(meta, info));
  }
  if (!/\/Trapped \/(True|False)/.test(info)) problems.push('The trapping state (Trapped) is missing.');
  if (!/\/Title /.test(info)) problems.push('The document has no title.');
  if (!/\/ID \[</.test(trailer)) problems.push('The file has no identifier.');
  if (/\/Encrypt /.test(trailer)) problems.push(`${name} files cannot be encrypted.`);
  // Output intent with its profile.
  const intent = /\/OutputIntents \[<<([^]*?)>>\]/.exec(all)?.[1];
  if (!intent || !/\/S \/GTS_PDFX/.test(intent)) problems.push('There is no PDF/X output intent.');
  else {
    const prof = /\/DestOutputProfile (\d+) 0 R/.exec(intent)?.[1];
    if (!prof && /OutputConditionIdentifier \(Custom\)/.test(intent)) problems.push('The custom output intent has no profile.');
    const p = objects.find((o) => String(o.num) === prof);
    if (prof && (!p || !/\/N 4\b/.test(p.dict))) problems.push('The output intent profile is not a CMYK profile.');
  }
  // Pages: trimmed size, no annotations.
  const pages = dicts.filter((d) => /\/Type \/Page\b(?!s)/.test(d));
  if (!pages.length) problems.push('The file has no pages.');
  if (pages.some((d) => !/\/(TrimBox|ArtBox) \[/.test(d))) problems.push('Some pages have no trim box.');
  if (pages.some((d) => /\/Annots \[/.test(d))) problems.push('Pages carry annotations (links), which PDF/X does not allow on the page.');
  // Fonts must be embedded.
  const fonts = objects.filter((o) => /\/Type \/Font\b/.test(o.dict) && !/\/Subtype \/Type0/.test(o.dict));
  if (fonts.some((o) => !/\/FontDescriptor/.test(o.dict))) problems.push('Some fonts are not embedded.');
  const ops = await contentText(objects);
  if (standard === 'x1a') {
    if (/\/DeviceRGB\b/.test(all) || /(^|\s)[-\d.]+ [-\d.]+ [-\d.]+ (rg|RG)\b/m.test(ops)) problems.push('RGB colors are used; PDF/X-1a allows only CMYK, gray and spot colors.');
    if (/\/ICCBased\b/.test(all)) problems.push('ICC-based colors are used; PDF/X-1a allows only device CMYK, gray and spot colors.');
    if (/\/SMask \d+ 0 R|\/SMask <</.test(all)) problems.push('Soft masks (transparency) are used.');
    if (/\/S \/Transparency/.test(all)) problems.push('Transparency groups are used.');
    if (/\/ca (0(\.\d+)?|\.\d+)\b|\/CA (0(\.\d+)?|\.\d+)\b/.test(all.replace(/\/c[aA] 1\b/g, ''))) problems.push('Transparent opacity is used.');
    if (/\/BM \/(?!Normal|Compatible)/.test(all)) problems.push('Blending modes are used.');
    if (/\/OCProperties/.test(all)) problems.push('Layers (optional content) are used.');
  }
  const rgb = /\/DeviceRGB\b/.test(all) || /(^|\s)[-\d.]+ [-\d.]+ [-\d.]+ (rg|RG)\b/m.test(ops);
  if (standard === 'x4' && rgb && !/\/DefaultRGB\b/.test(all)) problems.push('RGB colors are used without a profile describing them.');
  return problems;
}
