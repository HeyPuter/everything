/**
 * Chinese, Japanese, and Korean text without downloading a whole 10 MB face.
 *
 * scripts/cjk-fonts.py cuts the four regional Noto Sans CJK faces into small slices of glyphs,
 * ordered by how common their characters are. A CjkFace fetches only the slices its text needs
 * and builds a TrueType font from those glyphs, which pdf-lib embeds like any other face. Each
 * character takes the glyph of the first region in the face's chain that covers it, so a
 * Chinese sentence with a Korean name draws both, each in its own design.
 */

export const CJK_REGIONS = ['sc', 'tc', 'jp', 'kr'];
const REGION_NAMES = { sc: 'SC', tc: 'TC', jp: 'JP', kr: 'KR' };
const CJK_TEXT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}　-〿㈀-㏿＀-￯]/u;
/** Whether text needs a CJK face: any Han, kana, Hangul, or CJK punctuation and symbols. */
export const hasCjkText = (text) => CJK_TEXT.test(text);
export const hasKoreanText = (text) => /\p{Script=Hangul}/u.test(text);
const hasJapaneseText = (text) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);

/** The language a person reads, for the regional forms of shared Han characters. */
const browserLanguage = () => globalThis.navigator?.language || '';
/**
 * The regions to draw text from, preferred first. Hangul or kana in the text decide it;
 * otherwise the reader's language picks the regional forms of the Han characters.
 */
export function cjkRegions(text, language = browserLanguage()) {
  const first = hasKoreanText(text)
    ? 'kr'
    : hasJapaneseText(text)
      ? 'jp'
      : /^ja\b/i.test(language)
        ? 'jp'
        : /^ko\b/i.test(language)
          ? 'kr'
          : /^zh[-_](tw|hk|mo|hant)\b/i.test(language)
            ? 'tc'
            : 'sc';
  return [first, ...CJK_REGIONS.filter((region) => region !== first)];
}
/** Name the script in messages about the text. */
export function cjkScriptName(text) {
  return hasKoreanText(text) ? 'Korean' : hasJapaneseText(text) ? 'Japanese' : 'Chinese';
}

// Digits, Latin letters, and CJK punctuation are always present, so labels a face is built
// for, such as page numbers, can change those without another download.
const BASE_TEXT =
  Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') +
  Array.from({ length: 18 }, (_, i) => String.fromCharCode(0x3000 + i)).join('') +
  Array.from({ length: 94 }, (_, i) => String.fromCharCode(0xff01 + i)).join('');

const loadFailed = (cause) => new Error('Could not load the text font. Please retry.', { cause });
const cache = new Map();
/** Fetch and parse one data file once; a failed request is forgotten so it can be retried. */
function load(path, parse) {
  if (!cache.has(path)) {
    const pending = fetch(`${import.meta.env.BASE_URL}fonts/cjk/${path}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return path.endsWith('.json') ? response.json() : response.arrayBuffer();
      })
      .then(parse)
      .catch((error) => {
        cache.delete(path);
        throw loadFailed(error);
      });
    cache.set(path, pending);
  }
  return cache.get(path);
}

function loadMeta() {
  return load('meta.json', (meta) => {
    if (meta?.format !== 1 || !meta.weights?.regular || !meta.weights?.bold)
      throw new Error('Unsupported font data');
    const tables = {};
    for (const [weight, entries] of Object.entries(meta.weights))
      tables[weight] = Object.fromEntries(
        Object.entries(entries).map(([tag, base64]) => [
          tag,
          Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
        ]),
      );
    return { ...meta, tables };
  });
}

/** Which slice holds each character a region covers. */
function loadIndex(region) {
  return load(`${region}.bin`, (buffer) => {
    const bytes = new Uint8Array(buffer);
    let at = 0;
    const leb = () => {
      let value = 0,
        shift = 0,
        byte;
      do {
        if (at >= bytes.length) throw new Error('Truncated font index');
        byte = bytes[at++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      } while (byte & 0x80);
      return value;
    };
    const ranges = [];
    let end = 0,
      count = 0;
    for (let n = leb(); n > 0; n--) {
      const start = end + leb(),
        length = leb();
      ranges.push([start, length]);
      end = start + length;
      count += length;
    }
    if (at + count * 2 !== bytes.length) throw new Error('Truncated font index');
    const view = new DataView(buffer, at);
    const slices = new Map();
    let i = 0;
    for (const [start, length] of ranges)
      for (let cp = start; cp < start + length; cp++) slices.set(cp, view.getUint16(2 * i++));
    return slices;
  });
}

/** The glyphs of one slice, and which characters of each region use them. */
function loadSlice(weight, number) {
  return load(`${weight}/${number}.bin`, (buffer) => {
    const view = new DataView(buffer);
    const count = view.getUint16(0);
    const glyphs = [];
    let data = 2 + count * 6;
    for (let i = 0; i < count; i++) {
      const at = 2 + i * 6,
        length = view.getUint16(at + 4);
      if (data + length > buffer.byteLength) throw new Error('Truncated font slice');
      glyphs.push({
        advance: view.getUint16(at),
        bearing: view.getInt16(at + 2),
        data: new Uint8Array(buffer, data, length),
      });
      data += length;
    }
    const maps = new Map();
    for (const region of CJK_REGIONS) {
      const map = new Map();
      const entries = view.getUint16(data);
      data += 2;
      if (data + entries * 6 > buffer.byteLength) throw new Error('Truncated font slice');
      for (let k = 0; k < entries; k++, data += 6) {
        const index = view.getUint16(data + 4);
        if (index >= count) throw new Error('Invalid font slice');
        map.set(view.getUint32(data), index);
      }
      maps.set(region, map);
    }
    return { glyphs, maps };
  });
}

/**
 * A face that grows as text needs it. Glyphs keep their number once added, so a font built
 * later still draws every string encoded with an earlier build.
 */
export class CjkFace {
  constructor(regions, weight = 'regular') {
    if (!['regular', 'bold'].includes(weight)) throw new Error('Choose a supported text style.');
    this.regions = regions;
    this.weight = weight;
    const region = REGION_NAMES[regions[0]];
    const style = weight === 'bold' ? 'Bold' : 'Regular';
    this.family = `Noto Sans ${region}`;
    this.style = style;
    this.postscriptName = `NotoSans${region}-${style}`;
    this.glyphs = [];
    this.characters = new Map();
    this.keys = new Map();
    this.missing = new Set();
  }
  /** Whether every character of the text that the regions cover is already in the face. */
  covers(text) {
    return [...text].every((char) => {
      const cp = char.codePointAt(0);
      return this.characters.has(cp) || this.missing.has(cp);
    });
  }
  /** Add the glyphs the text needs. Resolves true when the face changed. */
  async include(text) {
    const wanted = new Set();
    // Text is drawn composed where the face can, else decomposed (see assertSupportedText),
    // so take both forms.
    const forms = text + text.normalize('NFC') + text.normalize('NFD');
    for (const char of (this.glyphs.length ? '' : BASE_TEXT) + forms) {
      const cp = char.codePointAt(0);
      if (cp > 31 && !this.characters.has(cp) && !this.missing.has(cp)) wanted.add(cp);
    }
    if (!wanted.size) return false;
    const meta = await loadMeta();
    const found = new Map();
    let pending = [...wanted];
    for (const region of this.regions) {
      if (!pending.length) break;
      const index = await loadIndex(region);
      const next = [];
      for (const cp of pending) {
        const slice = index.get(cp);
        if (slice === undefined || slice >= meta.slices) next.push(cp);
        else found.set(cp, { region, slice });
      }
      pending = next;
    }
    const slices = new Map();
    await Promise.all(
      [...new Set([...found.values()].map(({ slice }) => slice))].map(async (number) =>
        slices.set(number, await loadSlice(this.weight, number)),
      ),
    );
    let changed = false;
    for (const [cp, { region, slice }] of found) {
      const index = slices.get(slice).maps.get(region).get(cp);
      if (index === undefined) {
        this.missing.add(cp);
        continue;
      }
      const key = `${slice}:${index}`;
      if (!this.keys.has(key)) {
        this.glyphs.push(slices.get(slice).glyphs[index]);
        this.keys.set(key, this.glyphs.length);
      }
      this.characters.set(cp, this.keys.get(key));
      changed = true;
    }
    for (const cp of pending) this.missing.add(cp);
    this.tables = meta.tables[this.weight];
    return changed;
  }
  /** A TrueType font of every glyph added so far. */
  bytes() {
    if (!this.tables) throw new Error('No glyphs have been added to this face.');
    return trueType({
      tables: this.tables,
      glyphs: this.glyphs,
      characters: this.characters,
      names: {
        1: this.family,
        2: this.style,
        4: `${this.family}${this.style === 'Regular' ? '' : ` ${this.style}`}`,
        6: this.postscriptName,
      },
    });
  }
}

// ---- TrueType writer ----

const u16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value) => [
  (value >>> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];

function cmapTable(characters) {
  const entries = [...characters].sort((a, b) => a[0] - b[0]);
  // Consecutive characters with consecutive glyphs share one range.
  const groups = [];
  for (const [cp, gid] of entries) {
    const last = groups.at(-1);
    if (last && cp === last.end + 1 && gid === last.gid + (cp - last.start)) last.end = cp;
    else groups.push({ start: cp, end: cp, gid });
  }
  const format12 = [...u16(12), ...u16(0), ...u32(16 + groups.length * 12), ...u32(0)];
  format12.push(...u32(groups.length));
  for (const { start, end, gid } of groups) format12.push(...u32(start), ...u32(end), ...u32(gid));
  // Format 4 too, for readers that only know the Basic Multilingual Plane table.
  const bmp = groups.filter(({ end }) => end < 0xffff);
  const segments = [...bmp, { start: 0xffff, end: 0xffff, gid: 0 }];
  const tables = [[10, format12]];
  if (16 + segments.length * 8 <= 0xffff) {
    const count = segments.length;
    const power = 2 ** Math.floor(Math.log2(count));
    const format4 = [...u16(4), ...u16(16 + count * 8), ...u16(0), ...u16(count * 2)];
    format4.push(...u16(power * 2), ...u16(Math.log2(power)), ...u16(count * 2 - power * 2));
    for (const { end } of segments) format4.push(...u16(end));
    format4.push(...u16(0));
    for (const { start } of segments) format4.push(...u16(start));
    for (const { start, gid } of segments) format4.push(...u16((gid - start + 0x10000) & 0xffff));
    for (let i = 0; i < count; i++) format4.push(...u16(0));
    tables.unshift([1, format4]);
  }
  const out = [...u16(0), ...u16(tables.length)];
  let offset = 4 + tables.length * 8;
  for (const [encoding, table] of tables) {
    out.push(...u16(3), ...u16(encoding), ...u32(offset));
    offset += table.length;
  }
  for (const [, table] of tables) out.push(...table);
  return new Uint8Array(out);
}

function nameTable(names) {
  const records = Object.entries(names).map(([id, text]) => {
    const bytes = [];
    for (const char of text) bytes.push(...u16(char.charCodeAt(0)));
    return { id: Number(id), bytes };
  });
  const out = [...u16(0), ...u16(records.length), ...u16(6 + records.length * 12)];
  let offset = 0;
  for (const { id, bytes } of records) {
    out.push(...u16(3), ...u16(1), ...u16(0x409), ...u16(id), ...u16(bytes.length), ...u16(offset));
    offset += bytes.length;
  }
  for (const { bytes } of records) out.push(...bytes);
  return new Uint8Array(out);
}

function checksum(bytes) {
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

/** Assemble a TrueType font: glyph 0 is an empty .notdef; glyph n is glyphs[n - 1]. */
export function trueType({ tables, glyphs, characters, names }) {
  const count = glyphs.length + 1;
  const glyfLength = glyphs.reduce((sum, glyph) => sum + glyph.data.length, 0);
  const glyf = new Uint8Array(glyfLength);
  const loca = new DataView(new ArrayBuffer(count * 4 + 4));
  const hmtx = new DataView(new ArrayBuffer(count * 4));
  hmtx.setUint16(0, 1000);
  let offset = 0;
  glyphs.forEach((glyph, i) => {
    glyf.set(glyph.data, offset);
    loca.setUint32((i + 1) * 4, offset);
    offset += glyph.data.length;
    hmtx.setUint16((i + 1) * 4, glyph.advance);
    hmtx.setInt16((i + 1) * 4 + 2, glyph.bearing);
  });
  loca.setUint32(count * 4, offset);
  const head = tables.head.slice();
  const headView = new DataView(head.buffer);
  headView.setUint32(8, 0);
  headView.setInt16(50, 1);
  const hhea = tables.hhea.slice();
  new DataView(hhea.buffer).setUint16(34, count);
  const maxp = tables.maxp.slice();
  new DataView(maxp.buffer).setUint16(4, count);
  const entries = [
    ['OS/2', tables['OS/2']],
    ['cmap', cmapTable(characters)],
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', new Uint8Array(hmtx.buffer)],
    ['loca', new Uint8Array(loca.buffer)],
    ['maxp', maxp],
    ['name', nameTable(names)],
    ['post', tables.post],
  ];
  const directory = 12 + entries.length * 16;
  const size = entries.reduce((sum, [, data]) => sum + Math.ceil(data.length / 4) * 4, directory);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const power = 2 ** Math.floor(Math.log2(entries.length));
  view.setUint32(0, 0x00010000);
  view.setUint16(4, entries.length);
  view.setUint16(6, power * 16);
  view.setUint16(8, Math.log2(power));
  view.setUint16(10, entries.length * 16 - power * 16);
  let at = directory,
    headOffset = 0;
  entries.forEach(([tag, data], i) => {
    const record = 12 + i * 16;
    for (let k = 0; k < 4; k++) view.setUint8(record + k, tag.charCodeAt(k));
    view.setUint32(record + 4, checksum(data));
    view.setUint32(record + 8, at);
    view.setUint32(record + 12, data.length);
    out.set(data, at);
    if (tag === 'head') headOffset = at;
    at += Math.ceil(data.length / 4) * 4;
  });
  view.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}
