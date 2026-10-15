// Add-on metadata (pure): an add-on is one Python or JavaScript file with an optional
// `bl_info` dictionary / object and `register()` / `unregister()` functions.

export interface AddonInfo {
  name: string;
  author: string;
  version: string;
  description: string;
  category: string;
}

export type AddonLang = 'python' | 'javascript';

export interface AddonRecord {
  id: string;
  filename: string;
  lang: AddonLang;
  source: string;
  installed: number;
}

export function addonLang(filename: string, source: string): AddonLang {
  if (/\.py$/i.test(filename)) return 'python';
  if (/\.(js|mjs)$/i.test(filename)) return 'javascript';
  return /^\s*(import |from |def |class \w+\(|bl_info\s*=\s*\{\s*["'])/m.test(source) ? 'python' : 'javascript';
}

/** The text of the bl_info literal (balanced braces), or ''. */
function infoBlock(source: string): string {
  const m = /\bbl_info\s*=\s*\{/.exec(source);
  if (!m) return '';
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(m.index, i + 1);
  }
  return '';
}

function field(block: string, key: string): string {
  const s = new RegExp(`["']?${key}["']?\\s*:\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`).exec(block);
  if (s) return s[2].replace(/\\(.)/g, '$1');
  const t = new RegExp(`["']?${key}["']?\\s*:\\s*[\\[(]([^\\])]*)[\\])]`).exec(block);
  if (t) return t[1].split(',').map((x) => x.trim()).filter(Boolean).join('.');
  return '';
}

/** Read bl_info without running the file. */
export function parseAddonInfo(source: string, filename: string): AddonInfo {
  const b = infoBlock(source);
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  return {
    name: field(b, 'name') || base || 'Add-on',
    author: field(b, 'author'),
    version: field(b, 'version'),
    description: field(b, 'description'),
    category: field(b, 'category') || 'User',
  };
}

/** Stable id from the file name (the "module" name). */
export function addonId(filename: string): string {
  return (
    filename
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'addon'
  );
}
