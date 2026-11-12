// On-canvas text editing session for the type tools.
//
// While editing, the session installs live drafts as the history's current
// document without recording them (so every panel, the layer list and the
// renderer show the text as it is typed), and commits one undo entry when
// editing ends. A hidden textarea receives keyboard, IME and clipboard input.

import type { Editor } from '../../editor';
import { findLayer, layer as newLayer, type Layer, type PhotoDocument, type Rect } from '../../model/document';
import { layerLock } from '../../model/locks';
import { fitTextFrame, syncLegacyFields, textLayerName, hexRgb } from '../../model/text-layer';
import {
  applyCharStyle,
  applyParagraphStyle,
  charStyleAt,
  charStyleOfRange,
  defaultCharStyle,
  defaultParagraphStyle,
  deleteRange,
  fromPlainText,
  insertContent,
  nextChar,
  nextWord,
  paragraphAt,
  paragraphStyleOfRange,
  plainText,
  prevChar,
  prevWord,
  replaceRange,
  sliceContent,
  textLength,
  wordAt,
  type CharStyle,
  type ParagraphStyle,
  type TextContent,
  type TextLayerData,
  type TypePath,
} from '../../imaging/text/model';
import { prepareFonts } from '../../imaging/text/fonts';
import { curlQuotes } from '../../imaging/text/quotes';
import { prefetchGlyphMaps, protectGlyphs } from './glyph-guard';
import type { TextLayout } from '../../imaging/text/layout';
import { commitSelectionMask } from '../selection';
import { editable, forgetLayout, insertLayer, layoutOf, localBounds, localScale, ppiOf, replaceLayer, textCoverage, toDoc, toLocal, unwarpLocal } from './text-utils';

// `place`: the layer's placement, which Mod-dragging the text changes.
// `caretStyle`: a style chosen at a collapsed caret, waiting for typing.
type Snapshot = { data: TextLayerData; anchor: number; focus: number; place: Placement; caretStyle?: CharStyle };
type Placement = Pick<Layer, 'transform' | 'textFrame'>;
export type Session = {
  layerId: string;
  mask: boolean;
  isNew: boolean;
  autoName: boolean;
  before: PhotoDocument;
  draft: PhotoDocument;
  original: string;
  originalPlace: string;
  data: TextLayerData;
  anchor: number;
  focus: number;
  caretStyle?: CharStyle;
  goal?: number;
  undo: Snapshot[];
  redo: Snapshot[];
  lastKind?: string;
  // IME composition in progress; `before` is the state it is undone to.
  composing?: { start: number; length: number; before: Snapshot };
};
export let session: Session | undefined;
// Unnarrowed accessor for code that awaits between checks.
export const currentSession = (): Session | undefined => session;

// Typography defaults for new text, edited from the options bar and panels
// when no text is selected.
export type TypeDefaults = { style: CharStyle; paragraph: ParagraphStyle; antiAlias: TextLayerData['antiAlias']; direction?: 'ltr' | 'rtl' };
export function typeDefaults(e: Editor): TypeDefaults {
  let d = e.settings.typeDefaults as TypeDefaults | undefined;
  if (!d) {
    d = { style: { ...defaultCharStyle(), color: hexRgb(e.color) }, paragraph: defaultParagraphStyle(), antiAlias: 'smooth' };
    e.settings.typeDefaults = d;
  }
  // New text starts in Preferences → Type → Default text direction, on its reading side.
  const dir = e.preferences.textDirection;
  if (d.direction !== dir) {
    d.direction = dir;
    const p = { ...d.paragraph };
    if (dir === 'rtl') {
      p.direction = 'rtl';
      if (p.align === 'left') p.align = 'right';
    } else {
      delete p.direction;
      if (p.align === 'right') p.align = 'left';
    }
    d.paragraph = p;
  }
  return d;
}

let listeners: (() => void)[] = [];
// UI that mirrors the caret's style (options bar, panels) subscribes here.
export function onSessionChange(fn: () => void) {
  listeners.push(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

// ------------------------------------------------------------ geometry

export function sessionLayer(): (Layer & { textData: TextLayerData }) | undefined {
  if (!session) return;
  const l = findLayer(session.draft.layers, session.layerId);
  return l ? { ...l, textData: session.data } : undefined;
}
export function sessionLayout(e: Editor): TextLayout | undefined {
  return session ? layoutOf(session.data, ppiOf(e)) : undefined;
}
export const ordered = (s: Session): [number, number] => (s.anchor <= s.focus ? [s.anchor, s.focus] : [s.focus, s.anchor]);

// Caret index under a document point.
export function indexAt(e: Editor, x: number, y: number): number {
  const l = sessionLayer();
  const layout = sessionLayout(e);
  if (!l || !layout || !session) return 0;
  const [lx, ly] = toLocal(l, x, y);
  const [ux, uy] = unwarpLocal(session.data, layout, lx, ly);
  return layout.hitTest(ux, uy);
}
// True when a document point lies on the session's text (or its frame).
export function insideSession(e: Editor, x: number, y: number, slop = 6): boolean {
  const l = sessionLayer();
  const layout = sessionLayout(e);
  if (!l || !layout || !session) return false;
  const [lx, ly] = toLocal(l, x, y);
  const b = localBounds(session.data, layout);
  const k = slop / (e.zoom * localScale(l));
  return lx >= b.x - k && lx <= b.x + b.width + k && ly >= b.y - k && ly <= b.y + b.height + k;
}

// ------------------------------------------------------------ lifecycle

function placement(s: Session): Placement {
  const l = findLayer(s.draft.layers, s.layerId);
  return { transform: l?.transform ?? { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, textFrame: l?.textFrame };
}
const snapshot = (s: Session): Snapshot => ({ data: s.data, anchor: s.anchor, focus: s.focus, place: placement(s), caretStyle: s.caretStyle });
// Records an undo step unless this edit continues the previous one of the same kind.
function remember(s: Session, kind?: string) {
  if (kind === undefined || kind !== s.lastKind) {
    s.undo.push(snapshot(s));
    if (s.undo.length > 200) s.undo.shift();
    s.redo = [];
  }
  s.lastKind = kind;
}

function install(e: Editor, data: TextLayerData, opts: { kind?: string; snapshot?: boolean; keepGoal?: boolean } = {}) {
  const s = session!;
  if (opts.snapshot !== false) remember(s, opts.kind);
  else s.lastKind = opts.kind;
  s.data = data;
  if (!opts.keepGoal) s.goal = undefined;
  render(e);
}

// Rebuilds the draft document from the session data and shows it.
function render(e: Editor) {
  const s = session!;
  const ppi = ppiOf(e);
  const shown = s.mask ? maskPreview(s.data) : s.data;
  const layout = layoutOf(shown, ppi);
  const bounds = localBounds(shown, layout);
  const draft = replaceLayer(s.draft, s.layerId, (l) => {
    const n: Layer = { ...l, textData: shown };
    delete n.asset;
    delete n.assetColorSpace;
    fitTextFrame(n, bounds);
    syncLegacyFields(n);
    if (s.autoName && !s.mask) n.name = textLayerName(s.data.content);
    return n;
  });
  s.draft = draft;
  e.history.document = draft;
  e.preview(draft);
  e.overlay();
  positionInput(e);
  notify();
  scheduleUpdate(e);
}
// Type masks preview as translucent red text, like a quick-mask overlay.
function maskPreview(d: TextLayerData): TextLayerData {
  return { ...d, content: { paragraphs: d.content.paragraphs.map((p) => ({ style: p.style, runs: p.runs.map((r) => ({ text: r.text, style: { ...r.style, color: [255, 0, 0] } })) })) } };
}

let updateTimer = 0;
function scheduleUpdate(e: Editor) {
  clearTimeout(updateTimer);
  updateTimer = window.setTimeout(() => {
    if (session) {
      e.update();
      focusInput(e, true);
    }
  }, 300);
}

// Editing waits for the text's fonts, but not for a stalled download: after
// a moment the caret follows a fallback face, and the text is measured
// again once the font arrives.
const FONT_WAIT_MS = 3000;
async function fontsReady(e: Editor, data: TextLayerData): Promise<void> {
  const ready = prepareFonts(data);
  let timer = 0;
  const late = await Promise.race([ready.then(() => false), new Promise<boolean>((r) => (timer = window.setTimeout(() => r(true), FONT_WAIT_MS)))]);
  clearTimeout(timer);
  if (late)
    void ready.then(() => {
      forgetLayout();
      if (session) render(e);
    });
}

export type StartNew = { x: number; y: number; box?: Rect; vertical: boolean; mask: boolean; path?: TypePath };
// Starting is asynchronous (fonts load first); overlapping requests, such
// as a double-click that also reaches the layer list, start only once.
let starting = false;
export async function startNew(e: Editor, opt: StartNew) {
  if (starting) return;
  starting = true;
  try {
    await beginNew(e, opt);
  } finally {
    starting = false;
  }
}
async function beginNew(e: Editor, opt: StartNew) {
  if (session) await commit(e);
  const d = typeDefaults(e);
  const style: CharStyle = { ...d.style, color: opt.mask ? d.style.color : hexRgb(e.color) };
  const data: TextLayerData = {
    content: fromPlainText('', style, d.paragraph),
    mode: opt.box ? 'paragraph' : 'point',
    box: opt.box ? { width: opt.box.width, height: opt.box.height } : undefined,
    origin: opt.box ? { x: opt.box.x, y: opt.box.y } : { x: opt.x, y: opt.y },
    orientation: opt.vertical ? 'vertical' : 'horizontal',
    antiAlias: d.antiAlias,
  };
  if (opt.path) {
    // Path and area text are horizontal; area text uses the shape as its frame.
    data.path = opt.path;
    data.orientation = 'horizontal';
    if (opt.path.kind === 'area') {
      const xs = opt.path.knots.map((k) => k[2]), ys = opt.path.knots.map((k) => k[3]);
      data.mode = 'paragraph';
      data.origin = { x: Math.min(...xs), y: Math.min(...ys) };
      data.box = { width: Math.max(1, Math.max(...xs) - data.origin.x), height: Math.max(1, Math.max(...ys) - data.origin.y) };
    }
  }
  await fontsReady(e, data);
  const l = newLayer('text', 'Text', 1, 1);
  l.textData = data;
  l.color = e.color;
  if (opt.mask) {
    l.opacity = 0.5;
    l.name = 'Type Mask';
  }
  const ppi = ppiOf(e);
  // New text lives in document coordinates: identity placement.
  const b = localBounds(data, layoutOf(data, ppi));
  l.textFrame = { ...b, width: Math.max(1, b.width), height: Math.max(1, b.height) };
  l.transform = { ...l.textFrame, rotation: 0 };
  const before = e.doc;
  const draft = insertLayer(before, l, e.selected || undefined);
  if (e.preferences.missingGlyphProtection) prefetchGlyphMaps();
  session = {
    layerId: l.id, mask: opt.mask, isNew: true, autoName: true, before, draft, original: '', originalPlace: '', data,
    anchor: 0, focus: 0, undo: [], redo: [],
  };
  if (!opt.mask) e.selectLayers([l.id]);
  render(e);
  e.update();
  focusInput(e);
}

export async function startEdit(e: Editor, id: string, at?: { x: number; y: number } | 'all' | 'end') {
  if (starting) return;
  starting = true;
  try {
    await beginEdit(e, id, at);
  } finally {
    starting = false;
  }
}
async function beginEdit(e: Editor, id: string, at?: { x: number; y: number } | 'all' | 'end') {
  if (session) await commit(e);
  const l0 = findLayer(e.doc.layers, id);
  if (!l0 || l0.kind !== 'text') return;
  if (layerLock(e.doc.layers, id, 'all')) {
    e.message('Unlock this layer to edit its text.');
    return;
  }
  const ppi = ppiOf(e);
  const l = editable(l0, ppi);
  await fontsReady(e, l.textData);
  const before = e.doc;
  // Legacy layers get engine data in place (their placement is unchanged).
  const draft = replaceLayer(before, id, () => l);
  if (e.preferences.missingGlyphProtection) prefetchGlyphMaps();
  const autoName = l0.name === textLayerName(l.textData.content) || l0.name === 'Text' || l0.name === (l0.text.replace(/\s+/g, ' ').trim() || 'Text');
  session = {
    layerId: id, mask: false, isNew: false, autoName, before, draft, original: JSON.stringify(l0.textData ?? null), originalPlace: '', data: l.textData,
    anchor: 0, focus: 0, undo: [], redo: [],
  };
  session.originalPlace = JSON.stringify(placement(session));
  const len = textLength(l.textData.content);
  if (at === 'all') session.focus = len;
  else if (at === 'end' || !at) session.anchor = session.focus = len;
  else session.anchor = session.focus = indexAt(e, at.x, at.y);
  e.selectLayers([id]);
  render(e);
  e.update();
  focusInput(e);
}

function endSession(e: Editor) {
  session = undefined;
  clearTimeout(updateTimer);
  if (input) {
    input.value = '';
    input.blur();
  }
  e.el('#viewport').focus({ preventScroll: true });
}

export async function commit(e: Editor) {
  const s = session;
  if (!s) return;
  endSession(e);
  if (e.history.document !== s.draft) {
    // The document moved on while editing (another edit absorbed the draft).
    e.update();
    notify();
    return;
  }
  e.history.document = s.before;
  const empty = textLength(s.data.content) === 0;
  if (s.mask) {
    e.update();
    if (empty) return;
    const l = findLayer(s.draft.layers, s.layerId);
    if (!l) return;
    // The selection goes to this document even if another one is shown
    // before the text has rendered.
    const owner = e.session;
    const cov = await textCoverage({ ...l, textData: s.data }, s.before);
    commitSelectionMask(e, cov, 'replace', 'Type Mask', owner);
    notify();
    return;
  }
  if (empty) {
    if (!s.isNew)
      e.command('Delete Type Layer', (d) => {
        const walk = (layers: Layer[]) => {
          const i = layers.findIndex((x) => x.id === s.layerId);
          if (i >= 0) layers.splice(i, 1);
          else layers.forEach((x) => walk(x.children));
        };
        walk(d.layers);
      });
    else e.update();
    notify();
    return;
  }
  // Unchanged text that was not moved either needs no history step.
  if (!s.isNew && JSON.stringify(s.data) === s.original && JSON.stringify(placement(s)) === s.originalPlace) {
    e.update();
    notify();
    return;
  }
  const final = s.draft;
  e.command(s.isNew ? 'Type Tool' : 'Edit Type Layer', (d) => {
    Object.assign(d, structuredClone(final));
  });
  e.selectLayers([s.layerId]);
  e.update();
  notify();
}

export function cancel(e: Editor) {
  const s = session;
  if (!s) return;
  endSession(e);
  if (e.history.document === s.draft) e.history.document = s.before;
  e.update();
  notify();
}

// ------------------------------------------------------------ editing ops

const text = () => plainText(session!.data.content);

export function setSelection(e: Editor, anchor: number, focus: number, keepGoal = false) {
  const s = session!;
  const len = textLength(s.data.content);
  s.anchor = Math.max(0, Math.min(len, anchor));
  s.focus = Math.max(0, Math.min(len, focus));
  s.caretStyle = undefined;
  s.lastKind = undefined;
  if (!keepGoal) s.goal = undefined;
  e.overlay();
  positionInput(e);
  notify();
}

// `forced`: the style the inserted text takes (a glyph from another font).
export function insert(e: Editor, str: string, kind = 'type', forced?: CharStyle) {
  const s = session!;
  const [a, b] = ordered(s);
  const clean = str.replace(/\r\n?/g, '\n');
  const style = forced ?? (a === b && s.caretStyle ? s.caretStyle : undefined);
  let content = replaceRange(s.data.content, a, b, clean, style);
  // Preferences → Type → Missing glyph protection: characters the font lacks
  // are typed in a bundled font that has them.
  if (kind === 'type' && e.preferences.missingGlyphProtection) {
    const base = style ?? charStyleAt(s.data.content, a);
    const runs = protectGlyphs(clean, base.family);
    if (runs.some(([, family]) => family)) {
      content = deleteRange(s.data.content, a, b);
      let at = a;
      for (const [text, family] of runs) {
        content = replaceRange(content, at, at, text, family ? { ...base, family } : base);
        at += text.length;
      }
    }
  }
  const data = { ...s.data, content };
  const caret = a + clean.length;
  // Typing groups into word-sized undo steps; every paste is a step of its own.
  install(e, data, { kind: kind === 'paste' ? undefined : /\s/.test(clean) ? kind + '-space' : kind });
  s.anchor = s.focus = caret;
  if (style) s.caretStyle = style;
  e.overlay();
  positionInput(e);
}
export function insertStyled(e: Editor, piece: TextContent) {
  const s = session!;
  const [a, b] = ordered(s);
  const base = deleteRange(s.data.content, a, b);
  const content = insertContent(base, a, piece);
  install(e, { ...s.data, content });
  s.anchor = s.focus = a + textLength(piece);
  e.overlay();
}
function removeRange(e: Editor, a: number, b: number) {
  const s = session!;
  if (a === b) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  install(e, { ...s.data, content: deleteRange(s.data.content, lo, hi) }, { kind: 'delete' });
  s.anchor = s.focus = lo;
  e.overlay();
  positionInput(e);
}
export function deleteSelection(e: Editor) {
  const [a, b] = ordered(session!);
  removeRange(e, a, b);
}

export function selectedContent(): TextContent | undefined {
  const s = session;
  if (!s) return;
  const [a, b] = ordered(s);
  return a === b ? undefined : sliceContent(s.data.content, a, b);
}

export function undoEdit(e: Editor, redo = false) {
  const s = session!;
  const from = redo ? s.redo : s.undo,
    to = redo ? s.undo : s.redo;
  const snap = from.pop();
  if (!snap) return;
  to.push(snapshot(s));
  s.draft = replaceLayer(s.draft, s.layerId, (l) => ({ ...l, ...snap.place }));
  s.data = snap.data;
  s.anchor = snap.anchor;
  s.focus = snap.focus;
  s.caretStyle = snap.caretStyle;
  s.lastKind = undefined;
  render(e);
}

// A dialog's live preview while editing that may be cancelled: `editMark`
// before previewing, `revertToMark` to drop the preview and its undo step.
export type EditMark = { s: Session; undo: number; redo: Snapshot[]; data: TextLayerData; lastKind?: string };
export function editMark(): EditMark | undefined {
  const s = session;
  return s && { s, undo: s.undo.length, redo: s.redo, data: s.data, lastKind: s.lastKind };
}
export function revertToMark(e: Editor, m: EditMark) {
  const s = session;
  if (!s || s !== m.s) return;
  s.undo.length = Math.min(s.undo.length, m.undo);
  s.redo = m.redo;
  s.data = m.data;
  s.lastKind = m.lastKind;
  render(e);
}

// Mod-drag: moves the layer being edited (one undo step per drag).
export function moveBy(e: Editor, dx: number, dy: number, kind: string) {
  const s = session!;
  remember(s, kind);
  s.draft = replaceLayer(s.draft, s.layerId, (l) => ({ ...l, transform: { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy } }));
  render(e);
}

// Applies a whole-layer change (orientation, anti-aliasing, warp, mode).
export function updateData(e: Editor, fn: (d: TextLayerData) => TextLayerData, kind = 'layer') {
  install(e, fn(session!.data), { kind });
}

export function selectWordAt(e: Editor, index: number) {
  const w = wordAt(text(), index);
  setSelection(e, w.start, w.end);
}
export function selectParagraphAt(e: Editor, index: number) {
  const p = paragraphAt(session!.data.content, index);
  setSelection(e, p.start, p.end);
}

// Caret movement. `unit`: char, word, line (Home/End), doc, vline (up/down).
// `visual`: Left/Right arrows on horizontal text, where `dir` 1 means rightwards.
export function move(e: Editor, dir: -1 | 1, unit: 'char' | 'word' | 'line' | 'doc' | 'vline', extend: boolean, visual = false) {
  const s = session!;
  const t = text();
  const layout = sessionLayout(e)!;
  const [a, b] = ordered(s);
  let to = s.focus;
  if (!extend && a !== b && (unit === 'char' || unit === 'word')) {
    to = dir < 0 ? a : b;
    // On screen, the end of a right-to-left selection is on its left.
    if (visual && unit === 'char' && layout.lineIndexAt(a) === layout.lineIndexAt(b, 'up')) {
      const xa = layout.caretRect(a).x, xb = layout.caretRect(b, 'up').x;
      if (xa !== xb) to = (xb - xa) * dir > 0 ? b : a;
    }
    setSelection(e, to, to);
    return;
  }
  let keepGoal = false;
  if (unit === 'char' && visual) {
    // Left/Right move on screen, so they step the right way through right-to-left text.
    const v = layout.moveVisual(s.focus, dir);
    to = 'index' in v ? v.index : v.logical < 0 ? prevChar(t, s.focus) : nextChar(t, s.focus);
  } else if (unit === 'char') to = dir < 0 ? prevChar(t, s.focus) : nextChar(t, s.focus);
  else if (unit === 'word') to = dir < 0 ? prevWord(t, s.focus) : nextWord(t, s.focus);
  else if (unit === 'doc') to = dir < 0 ? 0 : t.length;
  else if (unit === 'line') {
    const line = layout.lines[layout.lineIndexAt(s.focus, 'up')];
    to = dir < 0 ? line.start : line.lastInParagraph ? line.end : line.stops[Math.max(0, line.stops.length - 1 - line.hang)];
  } else {
    const r = layout.caretRect(s.focus);
    if (s.goal === undefined) s.goal = layout.vertical ? r.y : r.x;
    to = layout.moveLine(s.focus, dir, s.goal);
    keepGoal = true;
  }
  setSelection(e, extend ? s.anchor : to, to, keepGoal);
}

export function backspace(e: Editor, word: boolean, line: boolean) {
  const s = session!;
  const [a, b] = ordered(s);
  if (a !== b) return removeRange(e, a, b);
  const t = text();
  const layout = sessionLayout(e)!;
  const from = line ? layout.lines[layout.lineIndexAt(s.focus, 'up')].start : word ? prevWord(t, s.focus) : prevChar(t, s.focus);
  removeRange(e, from, s.focus);
}
export function forwardDelete(e: Editor, word: boolean) {
  const s = session!;
  const [a, b] = ordered(s);
  if (a !== b) return removeRange(e, a, b);
  const t = text();
  removeRange(e, s.focus, word ? nextWord(t, s.focus) : nextChar(t, s.focus));
}

// ------------------------------------------------------------ styles

export type StyleContext = {
  editing: boolean;
  char: Partial<CharStyle>;
  paragraph: Partial<ParagraphStyle>;
  data?: TextLayerData;
  layers: Layer[];
};
export function selectedTextLayers(e: Editor): Layer[] {
  return e.selectedLayers.filter((l) => l.kind === 'text');
}
// Common style of what the type controls act on: the selected range while
// editing, else the selected text layers, else the defaults for new text.
export function styleContext(e: Editor): StyleContext {
  const s = session;
  if (s) {
    const [a, b] = ordered(s);
    const char = a === b && s.caretStyle ? s.caretStyle : charStyleOfRange(s.data.content, a, b);
    return { editing: true, char, paragraph: paragraphStyleOfRange(s.data.content, a, b), data: s.data, layers: [] };
  }
  const layers = selectedTextLayers(e);
  if (layers.length) {
    const ppi = ppiOf(e);
    const datas = layers.map((l) => editable(l, ppi).textData);
    const merge = <T extends object>(list: Partial<T>[]): Partial<T> => {
      const out: Partial<T> = { ...list[0] };
      for (const o of list.slice(1))
        for (const k of Object.keys(out) as (keyof T)[]) if (JSON.stringify(out[k]) !== JSON.stringify(o[k])) delete out[k];
      return out;
    };
    const char = merge<CharStyle>(datas.map((d) => charStyleOfRange(d.content, 0, textLength(d.content))));
    const paragraph = merge<ParagraphStyle>(datas.map((d) => paragraphStyleOfRange(d.content, 0, textLength(d.content))));
    return { editing: false, char, paragraph, data: datas[0], layers };
  }
  const d = typeDefaults(e);
  return { editing: false, char: d.style, paragraph: d.paragraph, layers: [] };
}

export async function applyChar(e: Editor, patch: Partial<CharStyle>) {
  const s = session;
  if (s) {
    if (patch.family || patch.weight || patch.italic !== undefined) {
      const probe = { ...charStyleAt(s.data.content, s.focus), ...patch };
      await fontsReady(e, { ...s.data, content: fromPlainText('x', probe) });
      if (session !== s) return;
    }
    const [a, b] = ordered(s);
    if (a === b) {
      const base = s.caretStyle ?? charStyleAt(s.data.content, a);
      const next = { ...base, ...patch, color: patch.color ?? base.color } as CharStyle;
      if (patch.superscript) next.subscript = false;
      if (patch.subscript) next.superscript = false;
      // An empty paragraph carries the style itself; elsewhere it waits for typing.
      install(e, { ...s.data, content: applyCharStyle(s.data.content, a, a, patch) }, { kind: 'style' });
      s.caretStyle = next;
      notify();
      return;
    }
    install(e, { ...s.data, content: applyCharStyle(s.data.content, a, b, patch) }, { kind: 'style' });
    return;
  }
  const layers = selectedTextLayers(e);
  if (layers.length) return editLayers(e, 'Change Character Style', (d) => ({ ...d, content: applyCharStyle(d.content, 0, textLength(d.content), patch) }));
  const d = typeDefaults(e);
  d.style = { ...d.style, ...patch };
  if (patch.color) e.setForeground(rgbHex(patch.color));
  notify();
}
export async function applyParagraph(e: Editor, patch: Partial<ParagraphStyle>) {
  const s = session;
  if (s) {
    const [a, b] = ordered(s);
    install(e, { ...s.data, content: applyParagraphStyle(s.data.content, a, b, patch) }, { kind: 'paragraph' });
    return;
  }
  if (selectedTextLayers(e).length) return editLayers(e, 'Change Paragraph Style', (d) => ({ ...d, content: applyParagraphStyle(d.content, 0, textLength(d.content), patch) }));
  const d = typeDefaults(e);
  d.paragraph = { ...d.paragraph, ...patch };
  notify();
}
// Layer-wide properties (anti-aliasing, orientation, warp, point/paragraph).
export async function applyLayer(e: Editor, label: string, fn: (d: TextLayerData, l: Layer) => TextLayerData) {
  const s = session;
  if (s) {
    const l = sessionLayer()!;
    updateData(e, (d) => fn(d, l));
    return;
  }
  return editLayers(e, label, fn);
}

const rgbHex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// One undo step that rewrites every selected text layer.
// `patchDoc` changes the document in the same step (text styles).
export async function editLayers(e: Editor, label: string, fn: (d: TextLayerData, l: Layer) => TextLayerData, ids?: string[], patchDoc?: (d: PhotoDocument) => void) {
  const ppi = ppiOf(e);
  const targets = (ids ? ids.map((id) => findLayer(e.doc.layers, id)).filter((l): l is Layer => !!l) : selectedTextLayers(e)).filter((l) => l.kind === 'text');
  if (!targets.length) {
    if (patchDoc) e.command(label, patchDoc);
    return;
  }
  if (targets.some((l) => layerLock(e.doc.layers, l.id, 'all'))) {
    e.message('Unlock the text layers to change them.');
    return;
  }
  const next = new Map<string, Layer>();
  for (const l of targets) {
    const t = editable(l, ppi);
    const data = fn(t.textData, t);
    await prepareFonts(data);
    const n: Layer = { ...t, textData: data };
    delete n.asset;
    delete n.assetColorSpace;
    fitTextFrame(n, localBounds(data, layoutOf(data, ppi)));
    syncLegacyFields(n);
    next.set(l.id, n);
  }
  e.command(label, (d) => {
    const walk = (layers: Layer[]) => {
      for (let i = 0; i < layers.length; i++) {
        const n = next.get(layers[i].id);
        if (n) layers[i] = structuredClone(n);
        else walk(layers[i].children);
      }
    };
    walk(d.layers);
    patchDoc?.(d);
  });
  notify();
}

// ------------------------------------------------------------ input element

let input: HTMLTextAreaElement | undefined;
export const CLIPBOARD_TYPE = 'application/x-photo-studio-text';

// `soft` leaves focus alone while another field (a panel input) is in use.
export function focusInput(e: Editor, soft = false) {
  if (!session) return;
  const el = inputElement(e);
  const active = document.activeElement as HTMLElement | null;
  if (soft && active && active !== el && active.matches('input,select,textarea,[contenteditable="true"]')) return;
  positionInput(e);
  if (document.activeElement !== el) el.focus({ preventScroll: true });
}
export function inputFocused() {
  return !!input && document.activeElement === input;
}

function positionInput(e: Editor) {
  if (!input || !session) return;
  const l = sessionLayer();
  const layout = sessionLayout(e);
  if (!l || !layout) return;
  const r = layout.caretRect(session.focus);
  const [x, y] = toDoc(l, r.x, r.y + r.height);
  const [cx, cy] = e.clientPoint(x, y);
  input.style.left = `${Math.round(cx)}px`;
  input.style.top = `${Math.round(cy)}px`;
}

type KeyHandler = (e: Editor, ev: KeyboardEvent) => boolean;
let keyHandler: KeyHandler | undefined;
export function setKeyHandler(fn: KeyHandler) {
  keyHandler = fn;
}

function inputElement(e: Editor): HTMLTextAreaElement {
  if (input) return input;
  const el = document.createElement('textarea');
  el.className = 'type-input';
  el.setAttribute('aria-label', 'Text input');
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('autocorrect', 'off');
  el.setAttribute('autocapitalize', 'off');
  el.spellcheck = false;
  el.tabIndex = -1;
  e.root.append(el);
  el.addEventListener('keydown', (ev) => {
    if (!session || ev.isComposing || ev.keyCode === 229) return;
    if (keyHandler?.(e, ev)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  });
  el.addEventListener('input', (ev) => {
    if (!session) return;
    const ie = ev as InputEvent;
    if (ie.isComposing || session.composing) return;
    const v = el.value;
    el.value = '';
    if (!v) return;
    // Preferences → Type → Use smart quotes.
    if (e.preferences.smartQuotes && /["']/.test(v)) {
      const [a] = ordered(session);
      insert(e, curlQuotes(v, plainText(session.data.content).slice(Math.max(0, a - 1), a)));
    } else insert(e, v);
  });
  el.addEventListener('compositionstart', () => {
    const s = session;
    if (!s) return;
    const before = snapshot(s);
    // Composing over a selection replaces it; the whole replacement is one undo step.
    const [a, b] = ordered(s);
    if (a !== b) {
      s.data = { ...s.data, content: deleteRange(s.data.content, a, b) };
      s.anchor = s.focus = a;
      render(e);
    }
    s.composing = { start: s.focus, length: 0, before };
  });
  el.addEventListener('compositionupdate', (ev) => {
    const s = session;
    if (!s?.composing) return;
    const data = (ev as CompositionEvent).data ?? '';
    const { start, length } = s.composing;
    s.data = { ...s.data, content: replaceRange(s.data.content, start, start + length, data, s.caretStyle) };
    s.composing.length = data.length;
    s.anchor = s.focus = start + data.length;
    render(e);
  });
  el.addEventListener('compositionend', (ev) => {
    const s = session;
    if (!s?.composing) return;
    const data = (ev as CompositionEvent).data ?? '';
    const { start, length, before } = s.composing;
    s.composing = undefined;
    // Record the composed text as one undoable insertion (a new edit, so redo ends).
    if (data || before.anchor !== before.focus) {
      s.undo.push(before);
      if (s.undo.length > 200) s.undo.shift();
      s.redo = [];
    }
    s.lastKind = undefined;
    s.data = { ...s.data, content: replaceRange(s.data.content, start, start + length, data, s.caretStyle) };
    s.anchor = s.focus = start + data.length;
    el.value = '';
    render(e);
  });
  el.addEventListener('copy', (ev) => clip(ev, false));
  el.addEventListener('cut', (ev) => {
    clip(ev, true);
    if (session) deleteSelection(e);
  });
  el.addEventListener('paste', (ev) => {
    if (!session) return;
    ev.preventDefault();
    const dt = ev.clipboardData;
    const styled = dt?.getData(CLIPBOARD_TYPE);
    if (styled) {
      try {
        const piece = JSON.parse(styled) as TextContent;
        if (piece?.paragraphs?.length) return insertStyled(e, piece);
      } catch {
        /* fall back to plain text */
      }
    }
    const t = dt?.getData('text/plain');
    if (t) insert(e, t, 'paste');
  });
  input = el;
  return el;
}

function clip(ev: ClipboardEvent, _cut: boolean) {
  const piece = selectedContent();
  if (!piece || !ev.clipboardData) return;
  ev.preventDefault();
  ev.clipboardData.setData('text/plain', plainText(piece));
  ev.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify(piece));
}
