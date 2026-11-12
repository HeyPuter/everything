/**
 * Placeholder text for new type objects and Type > Fill with Placeholder
 * Text. Area type gets as many words as fit its frame.
 */
import { layoutText } from '../../model/text-layout.js';

export const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';

const WORDS = LOREM.split(' ');

export function loremWords(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(WORDS[i % WORDS.length]);
  let s = out.join(' ');
  if (!/[.!?]$/.test(s)) s = s.replace(/[,;:]$/, '') + '.';
  return s;
}

/** Whether a layout's text overflows: for a threaded frame, whether the story overflows its last frame. */
export function overflows(lay) {
  return lay.story ? lay.story.overflow : lay.overflow;
}

/** Placeholder text that fills an area (or path) without overflowing; point type gets a short phrase. */
export function fillPlaceholder(node) {
  if (node.kind !== 'area' && node.kind !== 'path') return 'Lorem ipsum';
  const fits = (n) => !overflows(layoutText({ ...node, text: loremWords(n), runs: undefined, paras: undefined }));
  if (!fits(1)) return loremWords(1);
  let lo = 1;
  let hi = 2;
  while (hi < 4000 && fits(hi)) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return loremWords(lo);
}
