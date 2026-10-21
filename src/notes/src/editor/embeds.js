import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { decorateTags } from './tag-edit.js';

/*
 * Stored HTML keeps embeds as bare, data-only elements:
 *   <img data-asset="a1.png" alt="..." style="width: 320px">
 *   <span class="nt-file" data-asset="a2.pdf" data-name="Plan.pdf" data-size="1234" data-type="application/pdf" data-kind="file|audio|video" contenteditable="false"></span>
 *   <span class="nt-math" data-tex="x^2" contenteditable="false"></span>
 * hydrate() fills them in for display; serialize() strips that again.
 */

let temmlPromise = null;
function loadTemml() {
  temmlPromise ||= import('temml').then((m) => m.default || m);
  return temmlPromise;
}

export async function renderMath(tex, display = false) {
  const temml = await loadTemml();
  try {
    return temml.renderToString(tex || '', { displayMode: display, throwOnError: false, annotate: true, trust: false });
  } catch (err) {
    return `<span class="nt-math-error">${String(err.message || err).replace(/[<>&]/g, '')}</span>`;
  }
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fileIconName(type = '', name = '') {
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'picture';
  if (/pdf|text|document|msword|sheet|presentation/.test(type) || /\.(pdf|docx?|txt|md|xlsx?|pptx?)$/i.test(name)) return 'fileText';
  return 'fileGeneric';
}

/** Fills in display content for embeds inside root. */
export async function hydrate(root, store) {
  decorateTags(root);
  const jobs = [];
  for (const img of root.querySelectorAll('img[data-asset]')) {
    if (img.getAttribute('src')) continue;
    jobs.push(store.assetUrl(img.dataset.asset).then((url) => url && img.setAttribute('src', url)).catch(() => {}));
  }
  for (const span of root.querySelectorAll('span.nt-file')) {
    span.contentEditable = 'false';
    if (span.dataset.hydrated) continue;
    span.dataset.hydrated = '1';
    const kind = span.dataset.kind || 'file';
    const name = span.dataset.name || 'Attachment';
    span.replaceChildren();
    span.setAttribute('role', 'group');
    span.setAttribute('aria-label', `${kind === 'audio' ? 'Audio recording' : kind === 'video' ? 'Video recording' : 'Attached file'}: ${name}`);
    const head = h('span.nt-file-head',
      h('span.nt-file-icon', icon(fileIconName(span.dataset.type, name), 20, undefined, { plain: true })),
      h('span.nt-file-name', name),
      span.dataset.size ? h('span.nt-file-size', formatBytes(span.dataset.size)) : null,
    );
    if (kind === 'audio' || kind === 'video') {
      const media = h(kind, { controls: true, preload: 'metadata' });
      fixUnknownDuration(media);
      span.append(head, media);
      jobs.push(store.assetUrl(span.dataset.asset).then((url) => url && (media.src = url)).catch(() => {}));
    } else {
      span.tabIndex = 0;
      span.setAttribute('role', 'button');
      span.setAttribute('aria-label', `Open attachment ${name}`);
      span.append(head);
    }
  }
  for (const span of root.querySelectorAll('span.nt-math')) {
    span.contentEditable = 'false';
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', `Equation: ${span.dataset.tex || ''}`);
    span.tabIndex = -1;
    jobs.push(renderMath(span.dataset.tex).then((html) => (span.innerHTML = html)));
  }
  await Promise.all(jobs);
}

/**
 * Browsers record WebM without a duration, so a recording's player shows
 * no length and can't be scrubbed. Seeking past the end once makes the
 * browser scan the file and learn its real duration.
 */
function fixUnknownDuration(media) {
  media.addEventListener('loadedmetadata', () => {
    if (media.duration !== Infinity) return;
    const known = () => {
      if (!Number.isFinite(media.duration)) return;
      media.removeEventListener('durationchange', known);
      media.currentTime = 0;
    };
    media.addEventListener('durationchange', known);
    media.currentTime = Number.MAX_SAFE_INTEGER;
  }, { once: true });
}

/**
 * Stored HTML for an outline body element. keepSrc keeps pictures' current
 * URLs (for the clipboard, where other apps need them).
 */
export function serialize(body, { keepSrc = false } = {}) {
  const clone = body.cloneNode(true);
  for (const img of clone.querySelectorAll('img')) {
    if (img.dataset.asset && !keepSrc) img.removeAttribute('src');
    img.classList.remove('nt-selected');
    if (!img.getAttribute('class')) img.removeAttribute('class');
  }
  for (const span of clone.querySelectorAll('span.nt-file')) {
    span.replaceChildren();
    span.removeAttribute('role');
    span.removeAttribute('aria-label');
    span.removeAttribute('tabindex');
    delete span.dataset.hydrated;
  }
  for (const span of clone.querySelectorAll('span.nt-math')) {
    span.replaceChildren();
    span.removeAttribute('role');
    span.removeAttribute('aria-label');
    span.removeAttribute('tabindex');
  }
  for (const span of clone.querySelectorAll('span.nt-tag')) {
    span.replaceChildren();
    span.removeAttribute('role');
    span.removeAttribute('aria-label');
    span.removeAttribute('aria-checked');
    span.removeAttribute('tabindex');
  }
  for (const el of clone.querySelectorAll('.nt-cell-selected')) el.classList.remove('nt-cell-selected');
  for (const el of clone.querySelectorAll('[class=""]')) el.removeAttribute('class');
  // A lone placeholder paragraph is an empty outline.
  let html = clone.innerHTML;
  if (html === '<p><br></p>' || html === '<br>') html = '';
  return html;
}

export function fileSpan({ asset, name, size, type, kind = 'file' }) {
  const span = document.createElement('span');
  span.className = 'nt-file';
  span.dataset.asset = asset;
  span.dataset.name = name;
  if (size) span.dataset.size = String(size);
  if (type) span.dataset.type = type;
  span.dataset.kind = kind;
  span.contentEditable = 'false';
  return span;
}

export function mathSpan(tex) {
  const span = document.createElement('span');
  span.className = 'nt-math';
  span.dataset.tex = tex;
  span.contentEditable = 'false';
  return span;
}
