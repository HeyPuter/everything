// Image Assets name grammar (File → Generate → Image Assets). A layer or
// group whose name looks like file names is written out as those files.
// Pure parsing; no DOM. User documentation: docs/image-assets.md.
//
//   name     := output ( sep output )*            sep := "," | "+"
//   output   := [ size " " ] path
//   size     := number "%"                         200%   (of the layer's size)
//             | number "x"                          2x, 0.5x
//             | dim "x" dim                         48x48, 48x?, ?x32, 2inx1in
//   dim      := number [ "px" | "in" | "cm" | "mm" ] | "?"   ("?" keeps the aspect ratio)
//   path     := { folder "/" } file                icons/close.png
//   file     := stem "." ext [ option ]
//   ext      := png | jpg | jpeg | webp | gif | svg
//   option   := png: 8 (palette PNG), 24 or 32 (plain PNG)
//               jpg, jpeg, webp: quality 1-100, optionally followed by "%"
//
// Exact sizes ("48x48") stretch the layer to that size; one "?" keeps the
// aspect ratio. Units other than px use the document resolution.
// A file name may contain spaces ("my icon.png"); the size prefix is the first
// word when it looks like a size. Names that contain no file-like output are
// ordinary layer names. An output that looks like a file but does not parse
// (unknown extension such as ".pngg", a quality above 100, a malformed size)
// is reported as an error, as is a plain word mixed into a list of outputs.
//
// Document defaults: a top-level layer whose name starts with "default"
// lists variants applied to every asset, separated by "," or "+":
//   default 2x hd/, 1x            every asset at twice its size in hd/ and at its size
//   default @2x, 1x               icon@2x.png at twice the size, and icon.png
//   default 50% lo/ + 100%        a half-size copy in lo/ and the original
// Each variant has any of: a scale ("2x", "50%"), a folder ending in "/" and
// a file-name suffix starting with "@" ("@2x" alone also means 2x).

export type AssetFormat = 'png' | 'png8' | 'jpeg' | 'webp' | 'gif' | 'svg';
export type AssetSize = { kind: 'scale'; factor: number } | { kind: 'box'; width?: number; height?: number };
export type AssetOutput = {
  // Sanitized relative path with folders ("icons/close.png").
  path: string;
  // Folder part ("icons/", or "") and the file name without extension.
  folder: string;
  stem: string;
  // Extension written ("png", "jpg", "jpeg", "webp", "gif", "svg").
  ext: string;
  format: AssetFormat;
  // JPEG and WebP quality 1-100 when given.
  quality?: number;
  size?: AssetSize;
};
export type ParsedName = { outputs: AssetOutput[]; errors: string[] };
export type AssetVariant = { scale: number; folder: string; suffix: string };
export type ParsedDefaults = { variants: AssetVariant[]; errors: string[] };

const KNOWN = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
export const MAX_SIDE = 8192;
const FILE_RE = /^(.*)\.([A-Za-z]+)([0-9]*)(%?)$/;
const NUM = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const PERCENT_RE = new RegExp(`^(${NUM})%$`);
const SCALE_RE = new RegExp(`^(${NUM})x$`, 'i');
const DIM = `(?:(${NUM})(px|in|cm|mm)?|(\\?))`;
const BOX_RE = new RegExp(`^${DIM}x${DIM}$`, 'i');

/** Whether a first word looks like a size (and so must parse as one). */
const sizeLike = (t: string) => /^[0-9.?]/.test(t) && /[%xX?]/.test(t) && !/\.[A-Za-z]{2,}/.test(t);

/** Parse a size prefix; a string is an error message. */
export function parseSize(token: string, ppi = 72): AssetSize | string {
  let m = PERCENT_RE.exec(token);
  if (m) {
    const p = Number(m[1]);
    if (!(p > 0) || p > 10000) return `The scale “${token}” must be between 0% and 10000%.`;
    return { kind: 'scale', factor: p / 100 };
  }
  m = SCALE_RE.exec(token);
  if (m) {
    const f = Number(m[1]);
    if (!(f > 0) || f > 100) return `The scale “${token}” must be between 0x and 100x.`;
    return { kind: 'scale', factor: f };
  }
  m = BOX_RE.exec(token);
  if (m) {
    const side = (v: string | undefined, unit: string | undefined): number | undefined | string => {
      if (v === undefined) return undefined;
      const k = { px: 1, in: ppi, cm: ppi / 2.54, mm: ppi / 25.4 }[(unit ?? 'px').toLowerCase() as 'px'];
      const px = Math.round(Number(v) * k);
      if (!(px >= 1) || px > MAX_SIDE) return `The size “${token}” must be 1 to ${MAX_SIDE} pixels per side.`;
      return px;
    };
    const w = side(m[1], m[2]),
      h = side(m[4], m[5]);
    if (typeof w === 'string') return w;
    if (typeof h === 'string') return h;
    if (w === undefined && h === undefined) return `The size “${token}” needs at least one number.`;
    return { kind: 'box', ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) };
  }
  return `“${token}” is not a size (use 200%, 2x, 48x48 or 48x?).`;
}

/** Check a relative path; returns its segments or an error message. */
export function cleanPath(path: string): string[] | string {
  if (path.includes('\\')) return `Use “/” between folders in “${path}”.`;
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return `“${path}” must be a relative path.`;
  const parts = path.split('/').map((s) => s.trim());
  if (parts.some((s) => !s)) return `“${path}” has an empty folder name.`;
  if (parts.some((s) => s === '.' || s === '..')) return `“${path}” cannot use “.” or “..” folders.`;
  // eslint-disable-next-line no-control-regex
  if (parts.some((s) => /[:*?"<>|\u0000-\u001f]/.test(s))) return `“${path}” contains a character file names cannot use (: * ? " < > |).`;
  if (parts.length > 8) return `“${path}” is nested too deeply (at most 8 folders).`;
  if (path.length > 240) return `“${path}” is too long.`;
  return parts;
}

type Classified = { kind: 'output'; output: AssetOutput } | { kind: 'error'; message: string } | { kind: 'plain' };
function classify(raw: string, ppi: number): Classified {
  const item = raw.trim().replace(/\s+/g, ' ');
  if (!item) return { kind: 'plain' };
  const space = item.indexOf(' ');
  const first = space < 0 ? item : item.slice(0, space);
  const hasPrefix = space > 0 && sizeLike(first);
  const pathText = hasPrefix ? item.slice(space + 1).trim() : item;
  const last = pathText.split('/').pop()!;
  const m = FILE_RE.exec(last);
  if (!m) return { kind: 'plain' };
  const letters = m[2].toLowerCase(),
    digits = m[3],
    percent = m[4];
  if (!KNOWN.includes(letters)) {
    // ".pngg" and ".jpgx" are typos of an extension; ".final" is not a file.
    if (KNOWN.some((k) => letters.startsWith(k))) return { kind: 'error', message: `“.${m[2]}” is not a supported extension (use png, jpg, webp, gif or svg).` };
    return { kind: 'plain' };
  }
  if (!m[1].trim()) return { kind: 'error', message: `“${last}” has no file name before the extension.` };
  let format: AssetFormat;
  let quality: number | undefined;
  if (letters === 'png') {
    if (percent || (digits && !['8', '24', '32'].includes(digits))) return { kind: 'error', message: `“.png${digits}${percent}” is not valid (use .png, .png8, .png24 or .png32).` };
    format = digits === '8' ? 'png8' : 'png';
  } else if (letters === 'jpg' || letters === 'jpeg' || letters === 'webp') {
    format = letters === 'webp' ? 'webp' : 'jpeg';
    if (percent && !digits) return { kind: 'error', message: `“${last}” has a % without a quality.` };
    if (digits) {
      quality = Number(digits);
      if (!(quality >= 1 && quality <= 100) || digits.length > 3) return { kind: 'error', message: `The quality in “${last}” must be 1 to 100.` };
    }
  } else {
    if (digits || percent) return { kind: 'error', message: `“.${letters}” takes no quality or option (in “${last}”).` };
    format = letters as 'gif' | 'svg';
  }
  let size: AssetSize | undefined;
  if (hasPrefix) {
    const s = parseSize(first, ppi);
    if (typeof s === 'string') return { kind: 'error', message: s };
    size = s;
  }
  const ext = letters;
  const pathNoOption = pathText.slice(0, pathText.length - last.length) + `${m[1]}.${ext}`;
  const parts = cleanPath(pathNoOption);
  if (typeof parts === 'string') return { kind: 'error', message: parts };
  const file = parts.pop()!;
  const folder = parts.length ? `${parts.join('/')}/` : '';
  const stem = file.slice(0, file.length - ext.length - 1);
  if (!stem.trim() || /^\.+$/.test(stem)) return { kind: 'error', message: `“${last}” has no file name before the extension.` };
  return { kind: 'output', output: { path: folder + file, folder, stem, ext, format, ...(quality !== undefined ? { quality } : {}), ...(size ? { size } : {}) } };
}

/** Whether a (top-level) layer name declares document defaults. */
export const isDefaultsName = (name: string) => /^default(\s|$)/i.test(name.trim());

/** Parse a layer name; null when it is an ordinary name (no outputs). */
export function parseAssetName(name: string, ppi = 72): ParsedName | null {
  if (isDefaultsName(name)) return null;
  const items = name.split(/[,+]/);
  const parsed = items.map((i) => ({ raw: i.trim(), c: classify(i, ppi) }));
  if (!parsed.some((p) => p.c.kind !== 'plain')) return null;
  const outputs: AssetOutput[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const { raw, c } of parsed) {
    if (c.kind === 'error') errors.push(c.message);
    else if (c.kind === 'plain') {
      if (raw) errors.push(`“${raw}” is not a file name (add an extension such as .png).`);
    } else {
      const key = c.output.path.toLowerCase();
      if (seen.has(key)) errors.push(`“${c.output.path}” is listed twice.`);
      else {
        seen.add(key);
        outputs.push(c.output);
      }
    }
  }
  return { outputs, errors };
}

/** Parse a defaults layer name; null when the name is not one. */
export function parseDefaults(name: string): ParsedDefaults | null {
  if (!isDefaultsName(name)) return null;
  const body = name.trim().slice('default'.length);
  const variants: AssetVariant[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.split(/[,+]/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    let scale: number | undefined;
    let folder = '';
    let suffix = '';
    let bad = false;
    for (const t of tokens) {
      if (t.endsWith('/')) {
        const parts = cleanPath(t.slice(0, -1));
        if (typeof parts === 'string') {
          errors.push(parts);
          bad = true;
        } else folder += `${parts.join('/')}/`;
      } else if (t.startsWith('@')) {
        if (!/^@[A-Za-z0-9._-]{1,32}$/.test(t)) {
          errors.push(`The suffix “${t}” may use letters, digits, “.”, “_” and “-”.`);
          bad = true;
        } else suffix = t;
      } else {
        const s = PERCENT_RE.test(t) || SCALE_RE.test(t) ? parseSize(t) : `“${t}” is not a scale, folder or suffix (use 2x, 50%, hd/ or @2x).`;
        if (typeof s === 'string') {
          errors.push(s);
          bad = true;
        } else if (s.kind === 'scale') scale = s.factor;
      }
    }
    if (bad) continue;
    if (scale === undefined) {
      const m = /^@(\d+(?:\.\d+)?)x$/i.exec(suffix);
      scale = m && Number(m[1]) > 0 && Number(m[1]) <= 100 ? Number(m[1]) : 1;
    }
    const key = `${folder.toLowerCase()}|${suffix.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push(`Two default variants would write the same files (${folder || 'no folder'}${suffix ? `, ${suffix}` : ''}).`);
      continue;
    }
    seen.add(key);
    variants.push({ scale, folder, suffix });
  }
  return { variants, errors };
}

/** Output pixel size for a layer of `w` × `h` pixels. */
export function outputDims(w: number, h: number, size: AssetSize | undefined, scale = 1): [number, number] {
  let nw = w,
    nh = h;
  if (size?.kind === 'scale') {
    nw = w * size.factor;
    nh = h * size.factor;
  } else if (size?.kind === 'box') {
    if (size.width !== undefined && size.height !== undefined) {
      nw = size.width;
      nh = size.height;
    } else if (size.width !== undefined) {
      nw = size.width;
      nh = (h * size.width) / w;
    } else if (size.height !== undefined) {
      nh = size.height;
      nw = (w * size.height) / h;
    }
  }
  const clamp = (v: number) => Math.max(1, Math.min(MAX_SIDE, Math.round(v * scale)));
  return [clamp(nw), clamp(nh)];
}
