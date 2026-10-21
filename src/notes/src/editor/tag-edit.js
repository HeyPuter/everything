import { TAG_BY_ID, TAGS } from '../data/tags.js';
import { iconMarkup } from '../lib/icons.js';
import { blocksInRange, currentRange, editableRoot, ensureBlocks, selectRange } from './selection.js';

/** Builds the tag span stored at the start of a tagged block. */
export function tagSpan(id, done = false) {
  const span = document.createElement('span');
  span.className = 'nt-tag';
  span.dataset.tag = id;
  if (TAG_BY_ID.get(id)?.kind === 'check') span.dataset.done = String(done);
  span.contentEditable = 'false';
  decorateTag(span);
  return span;
}

/** Adds the accessible role and name a tag span carries while on screen. */
export function decorateTag(span) {
  const def = TAG_BY_ID.get(span.dataset.tag);
  const label = def?.label || span.dataset.tag;
  if (def?.kind === 'check') {
    span.setAttribute('role', 'checkbox');
    span.setAttribute('aria-checked', String(span.dataset.done === 'true'));
    span.setAttribute('aria-label', label);
    span.tabIndex = -1;
  } else {
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', `${label} tag`);
  }
}

export function decorateTags(root) {
  root.querySelectorAll('span.nt-tag').forEach(decorateTag);
}

/** Leading tag spans of a block. */
function tagsOf(block) {
  const out = [];
  for (const child of block.childNodes) {
    if (child.nodeType === 1 && child.classList.contains('nt-tag')) out.push(child);
    else if (child.nodeType === 3 && !child.nodeValue.trim()) continue;
    else break;
  }
  return out;
}

function targetBlocks() {
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  if (!root || !root.classList.contains('outline-body')) return { root: null, blocks: [] };
  ensureBlocks(root);
  const r = currentRange();
  return { root, blocks: blocksInRange(r, root) };
}

/**
 * Applies a tag to the selected paragraphs. For check tags the shortcut
 * cycles through three steps: add, then mark done, then remove.
 * Returns what happened ('added' | 'done' | 'removed').
 */
export function toggleTag(id, { cycle = false } = {}) {
  const def = TAG_BY_ID.get(id);
  const { root, blocks } = targetBlocks();
  if (!def || !root || !blocks.length) return null;
  const existing = blocks.map((b) => tagsOf(b).find((t) => t.dataset.tag === id));
  let result;
  if (existing.every(Boolean)) {
    if (cycle && def.kind === 'check' && existing.some((t) => t.dataset.done !== 'true')) {
      existing.forEach((t) => setDone(t, true));
      result = 'done';
    } else {
      existing.forEach((t) => t.remove());
      result = 'removed';
    }
  } else {
    blocks.forEach((b, i) => {
      if (existing[i]) return;
      const tags = tagsOf(b);
      const span = tagSpan(id);
      if (tags.length) tags[tags.length - 1].after(span);
      else b.prepend(span);
    });
    // A caret at the very start of the line (always so on an empty one)
    // stays in front of the new tag, and typing would go before it: put
    // it after the line's tags.
    const range = currentRange();
    if (range?.collapsed) {
      const block = blocks.find((b) => b.contains(range.startContainer));
      const last = block && tagsOf(block).at(-1);
      if (last) {
        const after = document.createRange();
        after.setStartAfter(last);
        if (range.compareBoundaryPoints(Range.START_TO_START, after) < 0) selectRange(after);
      }
    }
    result = 'added';
  }
  root.dispatchEvent(new Event('input', { bubbles: true }));
  return result;
}

export function removeAllTags() {
  const { root, blocks } = targetBlocks();
  if (!root) return;
  for (const b of blocks) tagsOf(b).forEach((t) => t.remove());
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setDone(span, done) {
  span.dataset.done = String(done);
  span.setAttribute('aria-checked', String(done));
}

/** Ids of tags on the blocks at the caret, for ribbon state. */
export function activeTags() {
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  if (!root || !root.classList.contains('outline-body')) return new Set();
  const ids = new Set();
  for (const b of blocksInRange(range, root)) for (const t of tagsOf(b)) ids.add(t.dataset.tag);
  return ids;
}

/**
 * A stylesheet that draws every tag's icon with CSS masks, so stored HTML
 * stays a bare <span data-tag>.
 */
export function tagStylesheet() {
  const css = [];
  const url = (name, color = '#000') => `url("data:image/svg+xml,${encodeURIComponent(iconMarkup(name, 24, color, 2))}")`;
  for (const t of TAGS) {
    css.push(`.nt-tag[data-tag="${t.id}"]{--tag-color:${t.color};--tag-icon:${url(t.icon)}}`);
    css.push(`:root{--tagicon-${t.id}:${url(t.icon)}}`);
    if (t.kind === 'check') css.push(`.nt-tag[data-tag="${t.id}"][data-done="true"]{--tag-icon:${url(t.icon === 'todo' ? 'todoDone' : t.icon)}}`);
    if (t.kind === 'highlight') {
      css.push(`:is(p,li,h1,h2,h3,h4,h5,h6,div,td,th,blockquote,pre):has(> .nt-tag[data-tag="${t.id}"]){background-color:var(--tag-shade-${t.id})}`);
      css.push(`:root{--tag-shade-${t.id}:${t.shade}}`);
      css.push(`.surface-dark{--tag-shade-${t.id}:${t.shadeDark}}`);
    }
  }
  css.push(`.nt-tag[data-done="true"]{--tag-done-icon:${url('check')}}`);
  return css.join('\n');
}
