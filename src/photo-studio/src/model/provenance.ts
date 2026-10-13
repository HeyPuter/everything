// Provenance record: how a document was made. Source files opened or placed
// (with a SHA-256 of their bytes), the edit steps (history labels and the
// commands or tools that made them, consecutive repeats grouped), assisted
// (AI) commands and exports. It is kept per open document beside the
// history, saved in .photo projects and can be attached to exported files
// (see src/imaging/provenance). Pure data and helpers; no DOM.

export const PROVENANCE_VERSION = 1;
// Bounds that keep a long editing session's record small.
export const MAX_SOURCES = 500;
export const MAX_STEPS = 5000;
export const MAX_AI = 1000;
export const MAX_EXPORTS = 500;

export type ProvenanceSource = {
  name: string;
  // Lowercase format name ("png", "jpeg", "photo", "psd", ...), or "unknown".
  format: string;
  // Hex SHA-256 of the file bytes.
  sha256: string;
  size: number;
  // ISO 8601 time it entered the document.
  when: string;
  // How it entered: opened as the document, placed as an embedded object
  // (file, drop, linked file), or placed from a library.
  role: 'opened' | 'placed' | 'library' | 'captured';
};
export type ProvenanceStep = {
  // History label ("Brush Tool", "Gaussian Blur").
  label: string;
  // Command ID when a command made the step, tool ID for tool gestures.
  command?: string;
  tool?: string;
  // First and last time of the group.
  when: string;
  last?: string;
  // Consecutive steps with the same label, command and tool (default 1).
  count?: number;
  // Undone before a different edit replaced it (kept for an honest record).
  undone?: boolean;
};
export type ProvenanceAI = {
  // Command that produced the content ("edit.generate-image").
  command: string;
  kind: 'generate' | 'edit' | 'upscale' | 'fill' | 'expand' | 'other';
  when: string;
  // Only recorded when Preferences → Export → Record AI prompts is on.
  prompt?: string;
  model?: string;
  layer?: string;
};
export type ProvenanceExport = {
  name: string;
  format: string;
  when: string;
  // "sha256:<hex>" of the exported pixel data and how it was computed.
  pixelHash?: string;
  pixelHashMethod?: string;
  // Whether a signed C2PA-format manifest was attached.
  signed?: boolean;
};
export type ProvenanceRecord = {
  version: 1;
  // Stable ID of this record (one per document lineage).
  id: string;
  // ISO 8601 time the record started (document created or opened).
  created: string;
  // How the document began.
  origin: 'new' | 'opened' | 'captured' | 'unknown';
  sources: ProvenanceSource[];
  steps: ProvenanceStep[];
  ai: ProvenanceAI[];
  exports: ProvenanceExport[];
};

export function newProvenanceRecord(origin: ProvenanceRecord['origin'] = 'new', now = new Date()): ProvenanceRecord {
  return { version: 1, id: uuid(), created: now.toISOString(), origin, sources: [], steps: [], ai: [], exports: [] };
}
function uuid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

const same = (a: ProvenanceStep, b: Omit<ProvenanceStep, 'when'>) => a.label === b.label && a.command === b.command && a.tool === b.tool && !a.undone;
/** Append a step, grouping it with the previous one when it repeats it. */
export function addStep(r: ProvenanceRecord, step: Omit<ProvenanceStep, 'count' | 'last'>): void {
  const prev = r.steps.at(-1);
  if (prev && same(prev, step)) {
    prev.count = (prev.count ?? 1) + 1;
    prev.last = step.when;
    return;
  }
  r.steps.push({ ...step });
  if (r.steps.length > MAX_STEPS) r.steps.splice(0, r.steps.length - MAX_STEPS);
}
/** Mark the latest `n` single steps (counting grouped ones) as undone. */
export function markUndone(r: ProvenanceRecord, n: number): void {
  for (let i = r.steps.length - 1; i >= 0 && n > 0; i--) {
    const s = r.steps[i];
    if (s.undone) continue;
    const count = s.count ?? 1;
    if (count <= n) {
      s.undone = true;
      n -= count;
    } else {
      // Split the group: the earlier part stays, the undone tail follows it.
      s.count = count - n;
      if (s.count === 1) delete s.count;
      const tail: ProvenanceStep = { label: s.label, ...(s.command ? { command: s.command } : {}), ...(s.tool ? { tool: s.tool } : {}), when: s.last ?? s.when, ...(n > 1 ? { count: n } : {}), undone: true };
      r.steps.splice(i + 1, 0, tail);
      n = 0;
    }
  }
}
export function addSource(r: ProvenanceRecord, s: ProvenanceSource): void {
  // The same bytes placed twice are one source.
  if (r.sources.some((x) => x.sha256 === s.sha256 && x.role === s.role && x.name === s.name)) return;
  r.sources.push(s);
  if (r.sources.length > MAX_SOURCES) r.sources.splice(0, r.sources.length - MAX_SOURCES);
}
export function addAI(r: ProvenanceRecord, a: ProvenanceAI): void {
  r.ai.push(a);
  if (r.ai.length > MAX_AI) r.ai.splice(0, r.ai.length - MAX_AI);
}
export function addExport(r: ProvenanceRecord, x: ProvenanceExport): void {
  r.exports.push(x);
  if (r.exports.length > MAX_EXPORTS) r.exports.splice(0, r.exports.length - MAX_EXPORTS);
}
/** Number of edit steps that were kept (not undone). */
export const keptSteps = (r: ProvenanceRecord) => r.steps.reduce((n, s) => n + (s.undone ? 0 : (s.count ?? 1)), 0);

/** A copy without AI prompts (privacy setting off). */
export function withoutPrompts(r: ProvenanceRecord): ProvenanceRecord {
  return { ...r, ai: r.ai.map(({ prompt: _prompt, ...rest }) => rest) };
}

const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const opt = (v: unknown, max: number) => v === undefined || str(v, max);
const time = (v: unknown) => str(v, 64);
const count = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1e9);
/** Validate a record read from a project or a file; throws on bad input. */
export function validateProvenance(v: unknown): ProvenanceRecord {
  const bad = (what: string) => new Error(`Invalid provenance record (${what}).`);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('not an object');
  const r = v as ProvenanceRecord;
  if (r.version !== 1 || !str(r.id, 128) || !time(r.created) || !['new', 'opened', 'captured', 'unknown'].includes(r.origin)) throw bad('header');
  if (!Array.isArray(r.sources) || r.sources.length > MAX_SOURCES) throw bad('sources');
  for (const s of r.sources)
    if (!s || !str(s.name, 1024) || !str(s.format, 32) || !/^[0-9a-f]{64}$/.test(s.sha256) || !Number.isFinite(s.size) || s.size < 0 || !time(s.when) || !['opened', 'placed', 'library', 'captured'].includes(s.role))
      throw bad('source');
  if (!Array.isArray(r.steps) || r.steps.length > MAX_STEPS) throw bad('steps');
  for (const s of r.steps)
    if (!s || !str(s.label, 256) || !opt(s.command, 128) || !opt(s.tool, 128) || !time(s.when) || !(s.last === undefined || time(s.last)) || !count(s.count) || !(s.undone === undefined || typeof s.undone === 'boolean'))
      throw bad('step');
  if (!Array.isArray(r.ai) || r.ai.length > MAX_AI) throw bad('ai');
  for (const a of r.ai)
    if (!a || !str(a.command, 128) || !['generate', 'edit', 'upscale', 'fill', 'expand', 'other'].includes(a.kind) || !time(a.when) || !opt(a.prompt, 10_000) || !opt(a.model, 256) || !opt(a.layer, 256))
      throw bad('ai entry');
  if (!Array.isArray(r.exports) || r.exports.length > MAX_EXPORTS) throw bad('exports');
  for (const x of r.exports)
    if (!x || !str(x.name, 1024) || !str(x.format, 32) || !time(x.when) || !opt(x.pixelHash, 80) || !opt(x.pixelHashMethod, 64) || !(x.signed === undefined || typeof x.signed === 'boolean'))
      throw bad('export');
  return r;
}

/** Hex SHA-256 of bytes (WebCrypto; works in browsers, workers and Node). */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const buf = bytes instanceof Blob ? await bytes.arrayBuffer() : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
