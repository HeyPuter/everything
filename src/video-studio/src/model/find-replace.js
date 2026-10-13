/**
 * Find and replace in text clips (captions and titles), on every track of
 * the open timeline, including inside compound clips. Highlighted words
 * (clip.marks, word indexes) follow their words through a replacement.
 */
import { wordsOf, bareWord } from './text-marks.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regular expression for a search, or null for an empty one.
 * opts: { matchCase, wholeWord }
 */
export function searchPattern(query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return null;
  const body = escape(query);
  // Whole words: not touching a letter, digit or apostrophe on either side.
  const src = wholeWord ? `(?<![\\p{L}\\p{N}'])${body}(?![\\p{L}\\p{N}'])` : body;
  return new RegExp(src, `gu${matchCase ? '' : 'i'}`);
}

/** Text clips in time order: { clip, track, path } (path: compound clip ids around it). */
export function textClips(project, { captionsOnly = false } = {}) {
  const out = [];
  const walk = (tracks, path, offset) => {
    for (const t of tracks) for (const c of t.clips) {
      if (c.type === 'text' && (!captionsOnly || c.caption)) out.push({ clip: c, track: t, path, at: offset + c.start });
      if (c.type === 'compound') walk(c.sequence.tracks, [...path, c.id], offset + c.start - (c.in || 0));
    }
  };
  walk(project.tracks, [], 0);
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Every match: [{ clipId, at, text, index, length, locked }] where index is
 * the character offset in the clip's text and at the time the clip starts
 * on the open timeline.
 */
export function findMatches(project, query, opts = {}) {
  const re = searchPattern(query, opts);
  if (!re) return [];
  const out = [];
  for (const { clip, track, at } of textClips(project, opts)) {
    re.lastIndex = 0;
    for (const m of clip.text.matchAll(re)) {
      if (!m[0].length) continue;
      out.push({ clipId: clip.id, at, text: clip.text, index: m.index, length: m[0].length, locked: Boolean(track.locked) });
    }
  }
  return out;
}

/** Keep the same words highlighted after a text changed (by matching the words themselves). */
export function remapMarks(marks, before, after) {
  if (!marks?.length) return marks;
  const oldWords = wordsOf(before);
  const newWords = wordsOf(after);
  if (oldWords.length === newWords.length) return marks.filter((i) => i < newWords.length);
  const bare = newWords.map(bareWord);
  const used = new Set();
  const out = [];
  for (const i of marks) {
    const w = bareWord(oldWords[i] || '');
    if (!w) continue;
    // The nearest unused occurrence, so repeated words stay in place.
    let best = -1;
    for (let j = 0; j < bare.length; j++) if (bare[j] === w && !used.has(j) && (best < 0 || Math.abs(j - i) < Math.abs(best - i))) best = j;
    if (best >= 0) {
      used.add(best);
      out.push(best);
    }
  }
  return out.sort((a, b) => a - b);
}

/** Replace one match (as returned by findMatches) in a clip's text. Returns true when it applied. */
export function replaceOne(clip, match, replacement) {
  if (!clip || clip.text !== match.text) return false;
  const next = clip.text.slice(0, match.index) + replacement + clip.text.slice(match.index + match.length);
  return setText(clip, next);
}

/**
 * Replace every match in the open timeline's unlocked text clips. Returns
 * how many matches were replaced.
 */
export function replaceAll(project, query, replacement, opts = {}) {
  const re = searchPattern(query, opts);
  if (!re) return 0;
  let n = 0;
  for (const { clip, track } of textClips(project, opts)) {
    if (track.locked) continue;
    re.lastIndex = 0;
    let count = 0;
    const next = clip.text.replace(re, (m) => {
      count++;
      return replacement;
    });
    if (count && setText(clip, next)) n += count;
  }
  return n;
}

function setText(clip, text) {
  const clean = text.slice(0, 5000);
  // A text clip can't be emptied this way; delete the clip instead.
  if (clean === clip.text || !clean.trim()) return false;
  if (clip.marks?.length) {
    const marks = remapMarks(clip.marks, clip.text, clean);
    if (marks.length) clip.marks = marks;
    else delete clip.marks;
  }
  clip.text = clean;
  return true;
}
