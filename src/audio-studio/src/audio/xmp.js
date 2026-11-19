// XMP metadata: an RDF/XML packet with the Dublin Core properties (title,
// creator, description, rights, subject keywords, publisher, contributor,
// language, date, identifier, source, relation), mapped to state.meta fields;
// shared ones like title and artist are one value with the other tag formats.
// Only the Dublin Core schema is written: it is what general XMP readers
// show, and the music fields (album, genre, composer...) already travel in
// each format's own tags.
//
// Where it is stored follows the XMP specification's file-format rules:
//   WAV        a "_PMX" RIFF chunk holding the packet (UTF-8);
//   MP3, AIFF  an ID3v2 PRIV frame owned by "XMP" (AIFF keeps ID3 in its "ID3 " chunk).
// FLAC, Ogg and M4A have no standard XMP location; their own tags carry the
// shared fields, so XMP-only fields are not written there.
//
// The reader is a small tolerant scanner (no DOMParser, so it also runs in
// workers): it reads simple values, rdf:Alt / rdf:Seq / rdf:Bag lists and
// attribute-form properties for the names below.

const DC = 'http://purl.org/dc/elements/1.1/';
/** Audio Studio's own properties: the session a mixdown came from (for Edit > Edit Original). */
const AS = 'https://github.com/HeyPuter/everything/ns/audio-studio/1.0/';

/**
 * Field id -> [property, form]. form: 'alt' (language alternative), 'seq'
 * (ordered list, ";"-separated), 'bag' (unordered, ","-separated) or 'text'.
 */
export const XMP_PROPS = {
  title: ['dc:title', 'alt'],
  artist: ['dc:creator', 'seq'],
  description: ['dc:description', 'alt'],
  copyright: ['dc:rights', 'alt'],
  keywords: ['dc:subject', 'bag'],
  publisher: ['dc:publisher', 'bag'],
  contributor: ['dc:contributor', 'bag'],
  language: ['dc:language', 'bag'],
  xmpDate: ['dc:date', 'seq'],
  identifier: ['dc:identifier', 'text'],
  source: ['dc:source', 'text'],
  relation: ['dc:relation', 'bag'],
  editOriginal: ['asx:editOriginal', 'text'],
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const splitList = (v, form) =>
  String(v)
    .split(form === 'bag' ? /\s*[,;]\s*|\n/ : /\s*;\s*|\n/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The XMP packet for the mapped fields of `meta`, or null when none is set. */
export function buildXmp(meta = {}) {
  const props = [];
  for (const [field, [name, form]] of Object.entries(XMP_PROPS)) {
    const v = meta[field] != null ? String(meta[field]).trim() : '';
    if (!v) continue;
    if (form === 'alt') props.push(`  <${name}><rdf:Alt><rdf:li xml:lang="x-default">${esc(v)}</rdf:li></rdf:Alt></${name}>`);
    else if (form === 'seq' || form === 'bag') {
      const tag = form === 'seq' ? 'rdf:Seq' : 'rdf:Bag';
      props.push(`  <${name}><${tag}>${splitList(v, form).map((x) => `<rdf:li>${esc(x)}</rdf:li>`).join('')}</${tag}></${name}>`);
    } else props.push(`  <${name}>${esc(v)}</${name}>`);
  }
  if (!props.length) return null;
  // The packet wrapper id is the fixed value the XMP specification defines.
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    ` <rdf:Description rdf:about="" xmlns:dc="${DC}"${meta.editOriginal ? ` xmlns:asx="${AS}"` : ''}>`,
    ...props,
    ' </rdf:Description>',
    '</rdf:RDF>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

/** Mapped fields read from an XMP packet (unknown properties are ignored). */
export function parseXmp(text) {
  const out = {};
  const src = String(text || '');
  for (const [field, [name, form]] of Object.entries(XMP_PROPS)) {
    const q = name.replace(':', '\\:');
    const el = new RegExp(`<${q}(?:\\s[^>]*)?>([\\s\\S]*?)</${q}>`).exec(src);
    let value = '';
    if (el) {
      const lis = [...el[1].matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((m) => unesc(m[1]).trim());
      if (lis.length) {
        // Language alternatives: x-default (or the first) only.
        const def = /<rdf:li[^>]*xml:lang="x-default"[^>]*>([\s\S]*?)<\/rdf:li>/.exec(el[1]);
        value = form === 'alt' ? (def ? unesc(def[1]).trim() : lis[0]) : lis.join(form === 'bag' ? ', ' : '; ');
      } else value = unesc(el[1].replace(/<[^>]+>/g, '')).trim();
    } else {
      const attr = new RegExp(`\\s${q}="([^"]*)"`).exec(src);
      if (attr) value = unesc(attr[1]).trim();
    }
    if (value) out[field] = value;
  }
  if (out.xmpDate) out.xmpDate = out.xmpDate.split(/;\s*/)[0].slice(0, 10);
  return out;
}

const enc = new TextEncoder();

/** WAV "_PMX" chunk (header included, padded to even length), or null. */
export function wavXmpChunk(meta) {
  const x = buildXmp(meta);
  if (!x) return null;
  const body = enc.encode(x);
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  out.set([0x5f, 0x50, 0x4d, 0x58]); // "_PMX"
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/** Body of an ID3v2 PRIV frame carrying the packet ("XMP" owner, NUL, packet), or null. */
export function id3XmpPriv(meta) {
  const x = buildXmp(meta);
  if (!x) return null;
  const body = enc.encode(x);
  const out = new Uint8Array(4 + body.length);
  out.set([0x58, 0x4d, 0x50, 0]); // "XMP\0"
  out.set(body, 4);
  return out;
}
