import { locate } from './model.js';
import { revisionView, runRevisionDisplay } from './revisions.js';

/**
 * Text the view hides: a tracked deletion in Simple Markup or No Markup (or an insertion in Original), and hidden
 * text (w:vanish) while hidden text is not shown. It is laid out with no width, as layout.js decides from the
 * same view, so its caret stops all sit where the visible text around it meets. Caret movement and deletion
 * pass over it: an arrow press that only crossed it, or a Backspace that removed (or struck out again) text no
 * one can see, did nothing visible, and typing went into the middle of a hidden deletion.
 */
export function hiddenRun(run) {
  if (!run?.text) return false;
  if (run.vanish && !revisionView.showHidden) return true;
  return !!(run.revision && runRevisionDisplay(run)?.hidden);
}

/** The hidden stretch of a paragraph that `position` touches or lies in, as [start, end], or null. */
export function hiddenStretchAt(paragraphs, position) {
  if (!paragraphs.length) return null;
  const { index, offset } = locate(paragraphs, position), base = position - offset;
  let at = 0, start = null;
  for (const run of paragraphs[index].runs) {
    const end = at + run.text.length;
    if (hiddenRun(run)) { if (start === null) start = at; }
    else if (run.text) {
      if (start !== null && start <= offset && offset <= at) return [base + start, base + at];
      start = null;
    }
    at = end;
  }
  return start !== null && start <= offset && offset <= at ? [base + start, base + at] : null;
}

/** Whether every character between two positions of one paragraph is hidden (they show as one caret place). */
export function sameShownPlace(paragraphs, a, b) {
  if (a === b) return true;
  const stretch = hiddenStretchAt(paragraphs, Math.min(a, b));
  return !!stretch && stretch[0] <= Math.min(a, b) && Math.max(a, b) <= stretch[1];
}

/**
 * A caret step from `from` (by `step`, in `direction`) that a reader can see: hidden text is passed over whole,
 * and a step that crossed only hidden text goes on from its far side.
 */
export function pastHiddenText(paragraphs, from, direction, step) {
  let target = step(from);
  for (let i = 0; i < 16; i++) {
    const stretch = hiddenStretchAt(paragraphs, target);
    if (stretch && stretch[0] < target && target < stretch[1]) target = direction < 0 ? stretch[0] : stretch[1];
    if (target === from || !sameShownPlace(paragraphs, from, target)) return target;
    const crossed = hiddenStretchAt(paragraphs, target);
    const next = crossed ? (direction < 0 ? crossed[0] : crossed[1]) : target;
    if (next !== target) return next;
    from = target; target = step(from);
  }
  return target;
}

/** A position inside hidden text moved to where the caret shows: just past that text. */
export function outsideHiddenText(paragraphs, position) {
  const stretch = hiddenStretchAt(paragraphs, position);
  return stretch && stretch[0] < position && position < stretch[1] ? stretch[1] : position;
}
