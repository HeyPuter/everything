/**
 * Threaded text in the document: area type frames linked with
 * threadNext/threadPrev. The first frame of a thread (the head) holds the
 * story (text, runs, paras and the default styles); the other frames hold
 * none and show what flows into them (model/text-layout.js lays the story
 * out across every frame).
 *
 * The operations here run inside a document transaction and keep the
 * story intact: linking appends stories, releasing a head hands its story
 * to the next frame, and removing threading leaves every frame with the
 * text it showed.
 */
import { layoutText } from '../../model/text-layout.js';
import { styledRuns, normalizeRuns, paraAt, paragraphRanges, paragraphIndexAt, RUN_KEYS, PARA_KEYS } from '../../model/text-runs.js';

/** Fields that make up a story (everything the text and its styling need). */
const STORY_KEYS = ['text', 'runs', 'paras', 'char', 'para', 'fill', 'stroke', 'strokeWidth'];

export const isThreaded = (n) => Boolean(n && n.type === 'text' && (n.threadNext || n.threadPrev));

/** First frame of the thread a node belongs to (the node itself when not threaded). */
export function headOf(doc, node) {
  if (!node) return null;
  let n = node;
  const seen = new Set([n.id]);
  // Links count only when both frames agree (copies of frames keep stale links).
  while (n.threadPrev && !seen.has(n.threadPrev)) {
    const prev = doc.get(n.threadPrev);
    if (!prev || prev.type !== 'text' || prev.threadNext !== n.id) break;
    n = prev;
    seen.add(n.id);
  }
  return n;
}

/** Every frame of a node's thread, head first ([node] when not threaded). */
export function threadFrames(doc, node) {
  const head = headOf(doc, node);
  if (!head) return [];
  const out = [head];
  const seen = new Set([head.id]);
  let n = head;
  while (n.threadNext && !seen.has(n.threadNext)) {
    const next = doc.get(n.threadNext);
    if (!next || next.type !== 'text' || next.threadPrev !== n.id) break;
    n = next;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

/** The story fields of a node, for moving a story to another frame. */
export function storyOf(node) {
  const out = {};
  for (const k of STORY_KEYS) out[k] = node[k];
  return out;
}

/** An empty story (what a frame keeps when its text moves away; its default styles stay). */
function emptyStory() {
  return { text: '', runs: undefined, paras: undefined };
}

/**
 * Story fields for `a` followed by `b` (a paragraph break between them).
 * b's characters keep their look: their full styles become runs relative
 * to a's defaults.
 */
export function appendStory(a, b) {
  const at = String(a.text ?? '');
  const bt = String(b.text ?? '');
  if (!bt.length) return storyOf(a);
  if (!at.length) {
    // An empty first frame takes the other story as it is.
    return storyOf(b);
  }
  const text = `${at}\n${bt}`;
  const runs = [];
  for (const r of styledRuns(a)) {
    const o = {};
    for (const k of RUN_KEYS) o[k] = r.style[k];
    runs.push({ ...o, len: r.end - r.start });
  }
  // The joining break takes the style of a's last character.
  runs.push({ ...runs[runs.length - 1], len: 1 });
  for (const r of styledRuns(b)) {
    const o = {};
    for (const k of RUN_KEYS) o[k] = r.style[k];
    runs.push({ ...o, len: r.end - r.start });
  }
  const pa = paragraphRanges(at).length;
  const pb = paragraphRanges(bt).length;
  const paras = [];
  for (let i = 0; i < pa; i++) paras.push(a.paras?.[i] || null);
  for (let i = 0; i < pb; i++) {
    const p = paraAt(b, i);
    const o = {};
    for (const k of PARA_KEYS) o[k] = p[k];
    paras.push(o);
  }
  const base = { ...a, text };
  const normRuns = normalizeRuns(runs, base);
  const baseP = paraAt(a, 0);
  const cleanParas = paras.map((p) => {
    if (!p) return null;
    const c = {};
    for (const k in p) if (JSON.stringify(p[k]) !== JSON.stringify(a.para?.[k] ?? baseP[k])) c[k] = p[k];
    return Object.keys(c).length ? c : null;
  });
  return { ...storyOf(a), text, runs: normRuns, paras: cleanParas.some(Boolean) ? cleanParas : undefined };
}

/** Story fields for the characters [s, e) of a story (whole paragraphs keep their styles). */
export function sliceStory(node, s, e) {
  const text = String(node.text ?? '');
  s = Math.max(0, Math.min(text.length, s));
  e = Math.max(s, Math.min(text.length, e));
  const runs = [];
  for (const r of styledRuns(node)) {
    const a = Math.max(s, r.start);
    const b = Math.min(e, r.end);
    if (b <= a) continue;
    const o = {};
    for (const k of RUN_KEYS) o[k] = r.style[k];
    runs.push({ ...o, len: b - a });
  }
  const p0 = paragraphIndexAt(text, s);
  const p1 = paragraphIndexAt(text, e);
  const paras = node.paras ? node.paras.slice(p0, p1 + 1) : undefined;
  const sub = text.slice(s, e);
  return { ...storyOf(node), text: sub, runs: normalizeRuns(runs, { ...node, text: sub }), paras: paras && paras.some(Boolean) ? paras : undefined };
}

/**
 * Link frames into one thread in the given order. Each entry is an area
 * type node (already in the document); their stories are appended in order
 * into the first frame. Frames that were in other threads join with their
 * whole thread.
 */
export function linkFrames(doc, nodes) {
  const order = [];
  const seen = new Set();
  for (const n of nodes) {
    for (const f of threadFrames(doc, doc.get(n.id))) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      order.push(f.id);
    }
  }
  if (order.length < 2) return order;
  // Collect the stories of the heads in order.
  let story = null;
  for (const id of order) {
    const f = doc.get(id);
    if (f.threadPrev && seen.has(f.threadPrev)) continue; // a follower: no story of its own
    story = story ? appendStory({ ...doc.get(order[0]), ...story }, f) : storyOf(f);
  }
  order.forEach((id, i) => {
    const patch = { threadPrev: i ? order[i - 1] : undefined, threadNext: i < order.length - 1 ? order[i + 1] : undefined };
    if (i === 0) Object.assign(patch, story);
    else Object.assign(patch, emptyStory());
    doc.update(id, patch);
  });
  return order;
}

/** Insert `id` into a thread right after `afterId` (or before the head when `before` is set). */
export function insertFrame(doc, refId, id, { before = false } = {}) {
  const ref = doc.get(refId);
  const node = doc.get(id);
  if (!ref || !node) return;
  // A frame joining a thread brings its own story along (appended).
  const frames = threadFrames(doc, ref).map((f) => f.id);
  const at = frames.indexOf(refId);
  const own = threadFrames(doc, node).map((f) => f.id).filter((x) => !frames.includes(x));
  const next = before ? [...frames.slice(0, at), ...own, ...frames.slice(at)] : [...frames.slice(0, at + 1), ...own, ...frames.slice(at + 1)];
  // Stories in reading order: the thread's story, then the joining frame's.
  const head = doc.get(frames[0]);
  const joinHead = own.length ? doc.get(own[0]) : null;
  let story = storyOf(head);
  if (joinHead && String(joinHead.text ?? '').length) story = before ? appendStory(joinHead, head) : appendStory(head, joinHead);
  else if (before && joinHead) story = { ...storyOf(head) };
  next.forEach((fid, i) => {
    const patch = { threadPrev: i ? next[i - 1] : undefined, threadNext: i < next.length - 1 ? next[i + 1] : undefined };
    if (i === 0) Object.assign(patch, story);
    else Object.assign(patch, emptyStory());
    doc.update(fid, patch);
  });
}

/**
 * Take frames out of their threads. The story stays with the remaining
 * frames (a released head hands it to the next frame); released frames
 * become empty, unthreaded area type.
 */
export function releaseFrames(doc, ids) {
  const release = new Set(ids);
  const threads = new Map();
  for (const id of ids) {
    const n = doc.get(id);
    if (!isThreaded(n)) continue;
    const frames = threadFrames(doc, n);
    threads.set(frames[0].id, frames);
  }
  for (const frames of threads.values()) {
    const story = storyOf(frames[0]);
    const keep = frames.filter((f) => !release.has(f.id)).map((f) => f.id);
    for (const f of frames) {
      if (!release.has(f.id)) continue;
      const patch = { threadPrev: undefined, threadNext: undefined };
      if (f.id === frames[0].id) Object.assign(patch, emptyStory());
      doc.update(f.id, patch);
    }
    keep.forEach((id, i) => {
      const patch = { threadPrev: i ? keep[i - 1] : undefined, threadNext: i < keep.length - 1 ? keep[i + 1] : undefined };
      if (i === 0) Object.assign(patch, story);
      doc.update(id, patch);
    });
  }
}

/** Break every link of the threads of `ids`; each frame keeps the text it shows (the last also the overflow). */
export function removeThreading(doc, ids) {
  const threads = new Map();
  for (const id of ids) {
    const n = doc.get(id);
    if (!isThreaded(n)) continue;
    const frames = threadFrames(doc, n);
    threads.set(frames[0].id, frames);
  }
  for (const frames of threads.values()) {
    const starts = storyStarts(frames);
    frames.forEach((f, i) => doc.update(f.id, { ...shownStory(frames, starts, i, i), threadPrev: undefined, threadNext: undefined }));
  }
}

/** Where each frame's text starts in its thread's story. */
function storyStarts(frames) {
  return frames.map((f) => layoutText(f).story?.start ?? 0);
}

/** Story fields for the text frames i0..i1 of a thread show (the last frame also the overflow). */
function shownStory(frames, starts, i0, i1) {
  const head = frames[0];
  const len = String(head.text ?? '').length;
  const s = i0 === 0 ? 0 : starts[i0];
  const e = i1 === frames.length - 1 ? len : Math.max(s, starts[i1 + 1]);
  // A break that ended the previous frame's last paragraph does not start this one.
  const s2 = i0 > 0 && head.text[s - 1] !== '\n' && head.text[s] === '\n' ? s + 1 : s;
  let e2 = e;
  if (i1 < frames.length - 1 && head.text[e - 1] === '\n') e2 = e - 1;
  return sliceStory(head, s2, Math.max(s2, e2));
}

/**
 * How copies of the threaded frames among `ids` (and their contents) are
 * linked: id -> { threadPrev, threadNext, story fields }. The copied frames
 * of a thread link to each other in thread order, and the first holds the
 * text they showed (the whole story when every frame is copied); a single
 * copied frame becomes plain area type with its text.
 */
export function copiedThreads(doc, ids) {
  const copied = new Set();
  const visit = (id) => {
    const n = doc.get(id);
    if (!n || copied.has(id)) return;
    copied.add(id);
    if (n.children) for (const c of n.children) visit(c);
  };
  for (const id of ids) visit(id);
  const threads = new Map();
  for (const id of copied) {
    const n = doc.get(id);
    if (!isThreaded(n)) continue;
    const frames = threadFrames(doc, n);
    if (!threads.has(frames[0].id)) threads.set(frames[0].id, frames);
  }
  const out = new Map();
  for (const frames of threads.values()) {
    const keep = frames.filter((f) => copied.has(f.id));
    const story = keep.length === frames.length ? storyOf(frames[0]) : shownStory(frames, storyStarts(frames), frames.indexOf(keep[0]), frames.indexOf(keep[keep.length - 1]));
    keep.forEach((f, i) => {
      out.set(f.id, { threadPrev: i ? keep[i - 1].id : undefined, threadNext: i < keep.length - 1 ? keep[i + 1].id : undefined, ...(i ? emptyStory() : story) });
    });
  }
  return out;
}

/**
 * After pasting copies (idMap: copied id -> new id): links between copied
 * frames point at the new frames; links to frames that were not copied go.
 */
export function relinkPasted(doc, idMap) {
  for (const id of idMap.values()) {
    const n = doc.get(id);
    if (n?.type !== 'text' || !(n.threadPrev || n.threadNext)) continue;
    doc.update(id, { threadPrev: (n.threadPrev && idMap.get(n.threadPrev)) || undefined, threadNext: (n.threadNext && idMap.get(n.threadNext)) || undefined });
  }
}

/**
 * Before frames are deleted: a deleted head hands its story to the first
 * surviving frame of its thread, and the survivors relink. Call inside the
 * deleting transaction.
 */
export function prepareFrameRemoval(doc, ids) {
  const gone = new Set();
  const visit = (id) => {
    const n = doc.get(id);
    if (!n) return;
    gone.add(id);
    if (n.children) for (const c of n.children) visit(c);
  };
  for (const id of ids) visit(id);
  const threads = new Map();
  for (const id of gone) {
    const n = doc.get(id);
    if (isThreaded(n)) {
      const frames = threadFrames(doc, n);
      threads.set(frames[0].id, frames);
    }
  }
  for (const frames of threads.values()) {
    const keep = frames.filter((f) => !gone.has(f.id)).map((f) => f.id);
    if (!keep.length) continue;
    const story = storyOf(frames[0]);
    keep.forEach((id, i) => {
      const patch = { threadPrev: i ? keep[i - 1] : undefined, threadNext: i < keep.length - 1 ? keep[i + 1] : undefined };
      if (i === 0) Object.assign(patch, story);
      doc.update(id, patch);
    });
  }
}
