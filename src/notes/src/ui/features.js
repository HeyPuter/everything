import { h, announce, escapeHtml, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { uid } from '../lib/ids.js';
import { shortcutLabel } from '../lib/platform.js';
import { toLocalInput } from '../lib/dates.js';
import { sanitizeHtml, safeUrl, htmlToText } from '../lib/sanitize.js';
import { htmlToMarkdown, markdownToHtml } from '../lib/markdown.js';
import { pageText, normalize } from '../data/store.js';
import { insertHtml, insertNode, setFontName } from '../editor/format.js';
import { mathSpan, renderMath, hydrate } from '../editor/embeds.js';
import { currentRange, selectRange, placeCaret } from '../editor/selection.js';
import { textToHtml } from '../editor/page-editor.js';
import { openDialog, confirmDialog } from './dialog.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { TEMPLATES } from './templates.js';

void setFontName;

// ------------------------------------------------------------ tables

export function tablePicker(onPick) {
  const ROWS = 8;
  const COLS = 10;
  const label = h('div.table-picker-label', { 'aria-live': 'polite' }, 'Insert Table');
  const grid = h('div.table-picker', { role: 'group', 'aria-label': 'Table size' });
  let cur = [1, 1];
  const cells = [];
  const paint = (r, c) => {
    cur = [r, c];
    label.textContent = `${c} x ${r} Table`;
    for (const cell of cells) cell.classList.toggle('on', Number(cell.dataset.r) <= r && Number(cell.dataset.c) <= c);
  };
  for (let r = 1; r <= ROWS; r++) {
    const row = h('div.table-picker-row');
    for (let c = 1; c <= COLS; c++) {
      const cell = h('button.table-picker-cell', { type: 'button', tabindex: r === 1 && c === 1 ? '0' : '-1', 'aria-label': `${c} by ${r} table`, dataset: { r, c } });
      cell.addEventListener('pointerenter', () => paint(r, c));
      cell.addEventListener('focus', () => paint(r, c));
      cell.addEventListener('click', () => onPick(r, c));
      cells.push(cell);
      row.append(cell);
    }
    grid.append(row);
  }
  grid.addEventListener('keydown', (e) => {
    let [r, c] = cur;
    if (e.key === 'ArrowRight') c = Math.min(COLS, c + 1);
    else if (e.key === 'ArrowLeft') c = Math.max(1, c - 1);
    else if (e.key === 'ArrowDown') r = Math.min(ROWS, r + 1);
    else if (e.key === 'ArrowUp') r = Math.max(1, r - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
    const target = cells.find((x) => Number(x.dataset.r) === r && Number(x.dataset.c) === c);
    cells.forEach((x) => (x.tabIndex = -1));
    target.tabIndex = 0;
    target.focus();
  });
  paint(1, 1);
  const wrap = h('div.table-picker-wrap', label, grid);
  setTimeout(() => cells[0].focus(), 0);
  return wrap;
}

export function insertTableDialog(app) {
  const rows = h('input.input', { type: 'number', min: '1', max: '100', value: '3', id: 'tbl-rows' });
  const cols = h('input.input', { type: 'number', min: '1', max: '30', value: '3', id: 'tbl-cols' });
  openDialog({
    title: 'Insert Table',
    width: 320,
    body: h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
      h('div.field', h('label.field-label', { for: 'tbl-cols' }, 'Columns'), cols),
      h('div.field', h('label.field-label', { for: 'tbl-rows' }, 'Rows'), rows),
    ),
    actions: [
      { label: 'Cancel' },
      { label: 'Insert', primary: true, run: () => {
        const r = Math.max(1, Math.min(100, Number(rows.value) || 1));
        const c = Math.max(1, Math.min(30, Number(cols.value) || 1));
        setTimeout(() => app.insertTable(r, c));
      } },
    ],
  });
}

// ------------------------------------------------------------ files, pictures, screenshots

export function pickFiles(app, { accept = '', attach = false } = {}) {
  app.editor.ensureCaret();
  const range = currentRange()?.cloneRange();
  const input = h('input', { type: 'file', multiple: true, accept, style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.remove();
    if (!files.length) return;
    if (range) {
      app.editor.lastRange = range;
      app.editor.restoreRange();
    }
    try {
      for (const f of files) {
        if (!attach && f.type.startsWith('image/')) await app.editor.insertImage(f);
        else await app.editor.insertAttachment(f);
      }
      announce(files.length === 1 ? `Inserted ${files[0].name}` : `Inserted ${files.length} files`);
    } catch (err) {
      app.reportError(err);
    }
  });
  document.body.append(input);
  input.click();
}

/**
 * Insert > Printout: attaches a PDF and puts a picture of each of its pages
 * on the page, like a printout. Rendering runs in pdf.js, loaded on demand.
 */
export function insertPrintout(app, file) {
  app.editor.ensureCaret();
  const range = currentRange()?.cloneRange();
  if (file) return printout(app, file, range);
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: { display: 'none' } });
  input.addEventListener('change', () => {
    const picked = input.files[0];
    input.remove();
    if (picked) printout(app, picked, range);
  });
  document.body.append(input);
  input.click();
}

async function printout(app, file, range) {
  const dismiss = toast(`Inserting printout of ${file.name}...`, { duration: 60000 });
  let task = null;
  try {
    const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const doc = await task.promise;
    const count = Math.min(doc.numPages, 60);
    if (range) app.editor.lastRange = range;
    app.editor.restoreRange();
    await app.editor.insertAttachment(file);
    const sectionId = app.store.findPage(app.editor.page.id)?.section.id;
    const images = [];
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const id = await app.store.saveAsset(blob, `printout-${i}.png`, { sectionId });
      images.push(`<p><img data-asset="${id}" alt="${escapeHtml(`Page ${i} of ${file.name}`)}" style="width: 640px"></p>`);
    }
    const el = app.editor.createOutlineAt(48, app.editor.nextFreeY(), '');
    const body = el.querySelector('.outline-body');
    body.innerHTML = sanitizeHtml(images.join(''));
    // Replacing the content dropped the caret to the top: put it after the last page.
    placeCaret(body);
    await hydrate(body, app.store);
    app.editor.dirty.add(el);
    app.editor.commit();
    app.editor.layout();
    dismiss();
    toast(doc.numPages > count ? `Inserted the first ${count} of ${doc.numPages} pages` : `Inserted ${count} ${count === 1 ? 'page' : 'pages'}`);
  } catch (err) {
    dismiss();
    toast(`Couldn't insert the printout: ${err?.message || 'the file could not be read'}`, { kind: 'error' });
  } finally {
    // Frees the parsed document and ends its pdf.js worker.
    task?.destroy().catch(() => {});
  }
}

/** Inserts pictures or attachments picked from the user's Puter files. */
export async function pickFromCloud(app, { accept = '*/*', attach = false } = {}) {
  const picker = app.cloudPicker();
  if (!picker) return;
  app.editor.ensureCaret();
  const range = currentRange()?.cloneRange();
  let picked;
  try {
    picked = await picker({ multiple: true, accept });
  } catch {
    return;
  }
  const items = [].concat(picked || []);
  for (const item of items) {
    try {
      const blob = await item.read();
      const file = new File([blob], item.name || 'file', { type: blob.type || '' });
      if (range) app.editor.lastRange = range;
      app.editor.restoreRange();
      if (!attach && (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name))) await app.editor.insertImage(file);
      else await app.editor.insertAttachment(file);
    } catch (err) {
      toast(`Couldn't insert ${item.name || 'the file'}: ${err?.message || 'read failed'}`, { kind: 'error' });
    }
  }
}

export async function insertScreenshot(app) {
  app.editor.ensureCaret();
  const range = currentRange()?.cloneRange();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return;
  }
  try {
    const video = h('video', { muted: true, playsInline: true });
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 250));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (range) app.editor.lastRange = range;
    app.editor.restoreRange();
    await app.editor.insertImage(new File([blob], `Screenshot ${new Date().toLocaleString()}.png`, { type: 'image/png' }), { alt: 'Screenshot' });
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export async function openAttachment(app, data) {
  try {
    const blob = await app.store.assetBlob(data.asset);
    if (!blob) {
      toast("This attachment couldn't be found.", { kind: 'error' });
      return;
    }
    const file = new Blob([blob], { type: data.type || blob.type || 'application/octet-stream' });
    const url = URL.createObjectURL(file);
    const previewable = /^(image|audio|video|text)\/|application\/pdf/.test(file.type);
    const a = h('a', { href: url, download: previewable ? null : data.name || 'attachment', target: '_blank', rel: 'noopener' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    app.reportError(err);
  }
}

// ------------------------------------------------------------ recording

export async function record(app, kind) {
  if (app.recorder) {
    app.recorder.stop();
    return;
  }
  app.editor.ensureCaret();
  const range = currentRange()?.cloneRange();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { audio: true, video: true } : { audio: true });
  } catch {
    toast(`Allow ${kind === 'video' ? 'camera and microphone' : 'microphone'} access to record.`, { kind: 'error' });
    return;
  }
  const types = kind === 'video' ? ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  let started = Date.now();
  let elapsed = 0;
  const time = h('span.rec-time', '0:00');
  const pauseBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Pause recording' }, icon('pause', 16));
  const stopBtn = h('button.btn.small', { type: 'button' }, icon('stop', 14), 'Stop');
  const preview = kind === 'video' ? h('video', { muted: true, autoplay: true, playsInline: true, style: { width: '120px', borderRadius: '6px' } }) : null;
  if (preview) preview.srcObject = stream;
  const bar = h('div.recording-bar', { role: 'region', 'aria-label': `${kind === 'video' ? 'Video' : 'Audio'} recording` }, preview, h('span.rec-dot'), h('span', kind === 'video' ? 'Recording video' : 'Recording audio'), time, pauseBtn, stopBtn);
  app.canvasCol.append(bar);
  const tick = setInterval(() => {
    const ms = elapsed + (rec.state === 'recording' ? Date.now() - started : 0);
    const s = Math.floor(ms / 1000);
    time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  pauseBtn.addEventListener('click', () => {
    if (rec.state === 'recording') {
      rec.pause();
      elapsed += Date.now() - started;
      bar.classList.add('paused');
      pauseBtn.replaceChildren(icon('play', 16));
      pauseBtn.setAttribute('aria-label', 'Resume recording');
    } else {
      rec.resume();
      started = Date.now();
      bar.classList.remove('paused');
      pauseBtn.replaceChildren(icon('pause', 16));
      pauseBtn.setAttribute('aria-label', 'Pause recording');
    }
  });
  stopBtn.addEventListener('click', () => app.recorder.stop());
  app.recorder = {
    kind,
    stop: () => {
      if (rec.state !== 'inactive') rec.stop();
    },
  };
  rec.onstop = async () => {
    clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    bar.remove();
    app.recorder = null;
    app.ribbon.refresh();
    const type = rec.mimeType || mimeType || (kind === 'video' ? 'video/webm' : 'audio/webm');
    const blob = new Blob(chunks, { type });
    if (!blob.size) return;
    const ext = type.includes('mp4') ? (kind === 'video' ? 'mp4' : 'm4a') : type.includes('ogg') ? 'ogg' : 'webm';
    const name = `${kind === 'video' ? 'Video' : 'Audio'} recording ${new Date().toLocaleString().replace(/[/:]/g, '-')}.${ext}`;
    if (range) app.editor.lastRange = range;
    app.editor.restoreRange();
    try {
      await app.editor.insertAttachment(new File([blob], name, { type }), kind);
      toast('Recording added to the page');
    } catch (err) {
      app.reportError(err);
    }
  };
  rec.start(1000);
  app.ribbon.refresh();
  stopBtn.focus();
  announce('Recording started');
}

// ------------------------------------------------------------ links

export function linkDialog(app) {
  app.editor.ensureCaret();
  const range = currentRange()?.cloneRange();
  const startEl = range && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
  const existing = startEl?.closest('a[href]');
  const selectedText = existing ? existing.textContent : range?.toString() || '';
  const text = h('input.input', { id: 'link-text', type: 'text', value: selectedText, autocomplete: 'off' });
  const address = h('input.input', { id: 'link-address', type: 'text', value: existing?.getAttribute('href') || '', placeholder: 'https://', autocomplete: 'off', spellcheck: 'false' });
  const error = h('p.field-error', { role: 'alert' });
  const filter = h('input.input', { type: 'search', placeholder: 'Find a page or section', 'aria-label': 'Find a page or section', autocomplete: 'off' });
  const list = h('div.link-targets', { role: 'listbox', 'aria-label': 'Pages and sections' });
  const renderTargets = () => {
    const q = normalize(filter.value.trim());
    const rows = [];
    for (const { notebook, section } of app.store.allSections()) {
      const secMatch = !q || normalize(section.name).includes(q);
      const pages = section.pages.filter((p) => !q || normalize(p.title || 'Untitled Page').includes(q));
      if (!secMatch && !pages.length) continue;
      rows.push(targetRow(`#section=${section.id}`, icon('folder', 14, undefined, { plain: true }), `${section.name}`, notebook.name));
      for (const p of pages.slice(0, 30)) rows.push(targetRow(`#page=${p.id}`, icon('fileText', 14, undefined, { plain: true }), p.title || 'Untitled Page', section.name, p.level));
      if (rows.length > 120) break;
    }
    list.replaceChildren(...(rows.length ? rows : [h('div.pane-empty', 'Nothing matches.')]));
  };
  const targetRow = (href, ic, label, sub, level = 0) => {
    const b = h('button.link-target', { type: 'button', role: 'option', 'aria-selected': String(address.value === href), style: { paddingLeft: `${10 + level * 14}px` } }, ic, h('span', label), h('span.link-target-sub', sub));
    b.addEventListener('click', () => {
      address.value = href;
      if (!text.value.trim()) text.value = label;
      for (const x of list.children) x.setAttribute?.('aria-selected', String(x === b));
    });
    return b;
  };
  filter.addEventListener('input', debounce(renderTargets, 100));
  renderTargets();
  const actions = [{ label: 'Cancel' }];
  if (existing) actions.unshift({ label: 'Remove Link', run: () => {
    const outline = existing.closest('.outline');
    existing.replaceWith(document.createTextNode(existing.textContent));
    if (outline) app.editor.dirty.add(outline);
    app.editor.commit();
  } });
  actions.push({
    label: 'OK',
    primary: true,
    run: () => {
      let href = address.value.trim();
      if (!href) {
        error.textContent = 'Enter an address or pick a page.';
        address.focus();
        return false;
      }
      if (!href.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(href)) href = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(href) ? `mailto:${href}` : `https://${href}`;
      if (!safeUrl(href)) {
        error.textContent = "That address can't be used as a link.";
        address.focus();
        return false;
      }
      const label = text.value.trim() || href;
      if (existing) {
        existing.setAttribute('href', href);
        if (existing.textContent !== label) existing.textContent = label;
        const outline = existing.closest('.outline');
        if (outline) app.editor.dirty.add(outline);
        app.editor.commit();
        return true;
      }
      return () => {
        if (range) app.editor.lastRange = range;
        if (!app.editor.restoreRange()) app.editor.ensureCaret();
        const external = !href.startsWith('#');
        insertHtml(`<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>&nbsp;`);
        app.editor.markActiveDirty();
      };
    },
  });
  openDialog({
    title: existing ? 'Edit Link' : 'Link',
    width: 520,
    body: h('div',
      h('div.field', h('label.field-label', { for: 'link-text' }, 'Text to display'), text),
      h('div.field', h('label.field-label', { for: 'link-address' }, 'Address'), address, error),
      h('div.field', h('span.field-label', 'Or pick a location in your notebooks'), filter, list),
    ),
    actions,
    initialFocus: selectedText ? address : text,
  });
}

// ------------------------------------------------------------ equations

const SNIPPETS = [
  ['x^{2}', 'Superscript'], ['x_{i}', 'Subscript'], ['\\frac{a}{b}', 'Fraction'], ['\\sqrt{x}', 'Square root'], ['\\sqrt[n]{x}', 'Root'],
  ['\\sum_{i=1}^{n}', 'Sum'], ['\\int_{a}^{b}', 'Integral'], ['\\lim_{x \\to \\infty}', 'Limit'], ['\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', 'Matrix'],
  ['\\alpha', 'Alpha'], ['\\beta', 'Beta'], ['\\pi', 'Pi'], ['\\theta', 'Theta'], ['\\infty', 'Infinity'], ['\\pm', 'Plus or minus'], ['\\neq', 'Not equal'], ['\\leq', 'Less or equal'], ['\\geq', 'Greater or equal'], ['\\times', 'Times'], ['\\rightarrow', 'Arrow'],
];

export function equationDialog(app, span) {
  if (!span) app.editor.ensureCaret();
  const range = currentRange()?.cloneRange();
  const input = h('textarea.input.mono', { id: 'eq-input', rows: 3, spellcheck: 'false', 'aria-describedby': 'eq-hint' });
  input.value = span?.dataset.tex || '';
  const error = h('p.field-error', { role: 'alert' });
  const preview = h('div.eq-preview', { 'aria-live': 'polite', 'aria-label': 'Preview' });
  const update = debounce(async () => {
    preview.innerHTML = input.value.trim() ? await renderMath(input.value, true) : '<span class="field-hint">The preview appears here.</span>';
  }, 120);
  input.addEventListener('input', update);
  input.addEventListener('input', () => {
    error.textContent = '';
    input.removeAttribute('aria-invalid');
  });
  update();
  const snippets = h('div.eq-snippets', { role: 'group', 'aria-label': 'Insert structure or symbol' }, SNIPPETS.map(([tex, label]) => {
    const b = h('button.btn.small', { type: 'button', title: label, 'aria-label': label });
    renderMath(tex).then((html) => (b.innerHTML = html));
    b.addEventListener('click', () => {
      const s = input.selectionStart;
      input.setRangeText(tex, s, input.selectionEnd, 'end');
      input.focus();
      update();
    });
    return b;
  }));
  openDialog({
    title: span ? 'Edit Equation' : 'Insert Equation',
    width: 560,
    body: h('div',
      h('div.field', h('label.field-label', { for: 'eq-input' }, 'Equation (LaTeX)'), input, error, h('p.field-hint', { id: 'eq-hint' }, 'For example: E = mc^2 or \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}')),
      snippets,
      h('div.field', h('span.field-label', 'Preview'), preview),
    ),
    actions: [
      { label: 'Cancel' },
      { label: span ? 'Update' : 'Insert', primary: true, run: async () => {
        const tex = input.value.trim();
        if (!tex) {
          // Like the Link dialog: say what's missing and keep the dialog open.
          error.textContent = 'Enter an equation.';
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return false;
        }
        if (span) {
          span.dataset.tex = tex;
          span.setAttribute('aria-label', `Equation: ${tex}`);
          span.innerHTML = await renderMath(tex);
          const outline = span.closest('.outline');
          if (outline) app.editor.dirty.add(outline);
          app.editor.commit();
          return;
        }
        return async () => {
          if (range) app.editor.lastRange = range;
          if (!app.editor.restoreRange()) app.editor.ensureCaret();
          insertNode(mathSpan(tex));
          const body = app.editor.activeOutline?.querySelector('.outline-body');
          if (body) await hydrate(body, app.store);
          app.editor.markActiveDirty();
        };
      } },
    ],
  });
}

// ------------------------------------------------------------ templates

export function templatesDialog(app) {
  const categories = [...new Set(TEMPLATES.map((t) => t.category))];
  let dlg = null;
  const body = h('div.templates', categories.map((cat) => h('section',
    h('h3.templates-cat', cat),
    h('div.templates-grid', TEMPLATES.filter((t) => t.category === cat).map((t) => {
      const b = h('button.template-card', { type: 'button' }, h('span.template-thumb', icon(t.id === 'blank' ? 'newPage' : 'template', 22)), h('span.template-name', t.label), h('span.template-desc', t.desc));
      b.addEventListener('click', () => {
        dlg.close();
        const built = t.build();
        app.newPage({ title: built.title, outlines: built.outlines.map((o) => ({ id: uid('o'), w: null, ...o, html: sanitizeHtml(o.html) })) });
        announce(`${t.label} page added`);
      });
      return b;
    })),
  )));
  dlg = openDialog({ title: 'Page Templates', width: 640, body, actions: [{ label: 'Close' }] });
}

// ------------------------------------------------------------ move or copy

export function moveDialog(app, kind, id) {
  const store = app.store;
  const filter = h('input.input', { type: 'search', placeholder: 'Search', 'aria-label': 'Filter locations', autocomplete: 'off' });
  const list = h('div.move-targets', { role: 'listbox', 'aria-label': kind === 'page' ? 'Sections' : 'Notebooks and section groups' });
  let target = null;
  const choose = (btn, t) => {
    target = t;
    for (const b of list.querySelectorAll('[role="option"]')) b.setAttribute('aria-selected', String(b === btn));
  };
  const option = (label, depth, t, ic, color) => {
    const b = h('button.link-target', { type: 'button', role: 'option', 'aria-selected': 'false', style: { paddingLeft: `${10 + depth * 16}px` } }, color ? h('span.section-tab', { style: { '--sec-color': color, height: '16px', margin: 0 } }) : icon(ic, 14, undefined, { plain: true }), h('span', label));
    b.addEventListener('click', () => choose(b, t));
    b.addEventListener('dblclick', () => {
      choose(b, t);
      dlg.dialog.querySelector('.dialog-actions .primary')?.click();
    });
    return b;
  };
  const render = () => {
    const q = normalize(filter.value.trim());
    const rows = [];
    for (const nb of store.notebooks) {
      const nbRow = option(nb.name, 0, kind === 'page' ? null : { notebookId: nb.id, parentId: null }, 'notebook');
      if (kind === 'page') nbRow.disabled = true;
      const sub = [];
      const walk = (nodes, depth) => {
        for (const n of nodes) {
          if (n.id === id) continue;
          if (n.type === 'group') {
            if (kind !== 'page' && (!q || normalize(n.name).includes(q))) sub.push(option(n.name, depth, { notebookId: nb.id, parentId: n.id }, 'sectionGroup'));
            else if (kind === 'page') sub.push(Object.assign(option(n.name, depth, null, 'sectionGroup'), { disabled: true }));
            walk(n.children, depth + 1);
          } else if (kind === 'page' && (!q || normalize(n.name).includes(q) || normalize(nb.name).includes(q))) {
            if (n.locked && !app.isUnlocked(n.id)) continue;
            sub.push(option(n.name, depth, { sectionId: n.id }, null, app.nav.colorOf(n.color)));
          }
        }
      };
      walk(nb.sections, 1);
      if (kind !== 'page' && q && !normalize(nb.name).includes(q) && !sub.length) continue;
      if (kind === 'page' && !sub.some((s) => !s.disabled)) continue;
      rows.push(nbRow, ...sub);
    }
    list.replaceChildren(...(rows.length ? rows : [h('div.pane-empty', 'No locations match.')]));
  };
  filter.addEventListener('input', debounce(render, 100));
  render();
  const name = kind === 'page' ? store.findPage(id)?.meta.title || 'Untitled Page' : store.findNode(id)?.node.name;
  const copyFailed = (err) => {
    console.error(err);
    toast(`Couldn't copy "${name}". Check your connection and try again.`, { kind: 'error' });
    return 'failed';
  };
  const act = async (copy) => {
    if (!target) {
      toast(kind === 'page' ? 'Pick a section.' : 'Pick a notebook or section group.');
      return false;
    }
    if (kind === 'page') {
      if (copy) {
        if ((await store.copyPage(id, { sectionId: target.sectionId }).catch(copyFailed)) === 'failed') return false;
        toast(`Copied "${name}"`);
      } else {
        store.movePage(id, { sectionId: target.sectionId, level: 0 });
        app.openPage(id);
        toast(`Moved "${name}"`);
      }
    } else if (copy) {
      const done = await store.copySection(id, target).catch(copyFailed);
      if (done === 'failed') return false;
      if (!done) {
        toast("Couldn't copy that section.", { kind: 'error' });
        return false;
      }
      toast(`Copied "${name}"`);
    } else {
      if (!store.moveNode(id, target)) {
        toast("Can't move a section group into itself.");
        return false;
      }
      app.state.notebookId = target.notebookId;
      app.ensureSelection();
      toast(`Moved "${name}"`);
    }
    return true;
  };
  const dlg = openDialog({
    title: kind === 'page' ? 'Move or Copy Page' : 'Move or Copy Section',
    width: 460,
    body: h('div', h('p.dialog-message', `Pick where "${name}" should go.`), filter, list),
    actions: [{ label: 'Cancel' }, kind === 'group' ? null : { label: 'Copy', run: () => act(true) }, { label: 'Move', primary: true, run: () => act(false) }].filter(Boolean),
  });
}

// ------------------------------------------------------------ page date

export function pageDateDialog(app) {
  const page = app.editor.page;
  if (!page || app.editor.readOnly) return;
  const input = h('input.input', { id: 'page-date', type: 'datetime-local', value: toLocalInput(page.created) });
  openDialog({
    title: 'Change Page Date and Time',
    width: 360,
    body: h('div.field', h('label.field-label', { for: 'page-date' }, 'Date and time'), input),
    actions: [
      { label: 'Cancel' },
      { label: 'OK', primary: true, run: () => {
        const d = new Date(input.value);
        if (Number.isNaN(d.getTime())) return false;
        page.created = d.toISOString();
        const f = app.store.findPage(page.id);
        if (f) f.meta.created = page.created;
        app.editor.updateDate();
        app.editor.changed();
      } },
    ],
  });
}

// ------------------------------------------------------------ deleted notes

export function deletedNotesDialog(app) {
  const store = app.store;
  const list = h('div.trash-list');
  const purgeFailed = (what) => (err) => {
    console.error(err);
    toast(`Couldn't ${what}. Check your connection and try again.`, { kind: 'error' });
  };
  let dlg = null;
  const render = () => {
    list.setAttribute('role', store.trash.length ? 'list' : 'presentation');
    if (!store.trash.length) {
      list.replaceChildren(h('div.empty-state', icon('trash', 28), h('p', 'Deleted Notes is empty.'), h('p.field-hint', 'Deleted pages, sections and notebooks stay here for 60 days.')));
      return;
    }
    list.replaceChildren(...store.trash.map((t) => {
      const name = t.kind === 'page' ? t.pages[0]?.title || (t.sealedPages ? 'Page in a protected section' : 'Untitled Page') : t.kind === 'notebook' ? t.notebook.name : t.node.name;
      const where = t.kind === 'page' ? `Page${t.pages.length > 1 ? ` and ${t.pages.length - 1} subpage${t.pages.length > 2 ? 's' : ''}` : ''} from ${t.sectionName || 'a section'}` : t.kind === 'notebook' ? 'Notebook' : t.kind === 'group' ? 'Section group' : `Section with ${t.node.pages.length} page${t.node.pages.length === 1 ? '' : 's'}`;
      const days = Math.max(0, 60 - Math.floor((Date.now() - Date.parse(t.deletedAt)) / 86400000));
      return h('div.trash-item', { role: 'listitem' },
        icon(t.kind === 'page' ? 'fileText' : t.kind === 'notebook' ? 'notebook' : 'folder', 18),
        h('div.trash-text', h('div.result-title', name), h('div.result-path', `${where} · deleted ${new Date(t.deletedAt).toLocaleDateString()} · ${days} days left`)),
        h('button.btn.small', { type: 'button', onclick: async () => { if (await app.restoreTrash(t.id)) { render(); toast(`Restored "${name}"`); } } }, 'Restore'),
        h('button.btn.small.danger', { type: 'button', 'aria-label': `Delete "${name}" permanently`, onclick: async () => {
          if (!(await confirmDialog({ title: 'Delete permanently?', message: `"${name}" will be deleted for good. This can't be undone.`, okLabel: 'Delete', danger: true }))) return;
          await store.purge(t.id).catch(purgeFailed(`delete "${name}" permanently`));
          render();
        } }, 'Delete'),
      );
    }));
  };
  render();
  dlg = openDialog({
    title: 'Deleted Notes',
    width: 620,
    body: list,
    actions: [
      { label: 'Empty Deleted Notes', danger: true, run: async () => {
        if (!store.trash.length) return false;
        if (!(await confirmDialog({ title: 'Empty Deleted Notes?', message: 'Everything in Deleted Notes will be deleted for good.', okLabel: 'Empty', danger: true }))) return false;
        await store.emptyTrash().catch(purgeFailed('empty Deleted Notes'));
        render();
        return false;
      } },
      { label: 'Close', primary: true },
    ],
  });
  void dlg;
}

// ------------------------------------------------------------ immersive reader

export function openReader(app) {
  const page = app.editor.page;
  if (!page) return;
  app.editor.flush();
  const settings = { size: 26, spacing: false, font: 'sans', theme: 'light', focus: 0, rate: 1 };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem('notes:reader') || '{}'));
  } catch {
    /* defaults */
  }
  const save = () => {
    try {
      localStorage.setItem('notes:reader', JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  };
  const content = h('article.reader-content', { tabindex: '0', 'aria-label': 'Page text' });
  content.append(h('h1', page.title || 'Untitled Page'));
  const ordered = [...page.outlines].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const o of ordered) {
    for (const para of htmlToText(o.html).split('\n')) if (para.trim()) content.append(h('p', para));
  }
  const overlay = h('div.reader', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Immersive Reader' });
  const apply = () => {
    overlay.dataset.theme = settings.theme;
    overlay.dataset.font = settings.font;
    overlay.classList.toggle('wide-spacing', settings.spacing);
    overlay.style.setProperty('--reader-size', `${settings.size}px`);
    overlay.dataset.focus = String(settings.focus);
    save();
  };
  const synth = window.speechSynthesis;
  let speaking = false;
  const playBtn = h('button.reader-play', { type: 'button', 'aria-label': 'Read aloud' }, icon('play', 26));
  const stopSpeech = () => {
    synth?.cancel();
    speaking = false;
    playBtn.replaceChildren(icon('play', 26));
    playBtn.setAttribute('aria-label', 'Read aloud');
    if (globalThis.CSS?.highlights) CSS.highlights.delete('nt-read');
  };
  const speak = () => {
    if (!synth) {
      toast('Read aloud is not available in this browser.');
      return;
    }
    if (speaking) {
      if (synth.paused) {
        synth.resume();
        playBtn.replaceChildren(icon('pause', 26));
      } else {
        synth.pause();
        playBtn.replaceChildren(icon('play', 26));
      }
      return;
    }
    const paras = [...content.children];
    let i = 0;
    speaking = true;
    playBtn.replaceChildren(icon('pause', 26));
    playBtn.setAttribute('aria-label', 'Pause reading');
    const next = () => {
      if (!speaking || i >= paras.length) return stopSpeech();
      const el = paras[i++];
      const text = el.textContent;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = settings.rate;
      u.onboundary = (e) => {
        if (e.name !== 'word' || !globalThis.CSS?.highlights || !el.firstChild) return;
        const len = e.charLength || (text.slice(e.charIndex).match(/^\S+/)?.[0].length ?? 1);
        const r = document.createRange();
        r.setStart(el.firstChild, Math.min(e.charIndex, text.length));
        r.setEnd(el.firstChild, Math.min(e.charIndex + len, text.length));
        CSS.highlights.set('nt-read', new Highlight(r));
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      };
      u.onend = next;
      synth.speak(u);
    };
    next();
  };
  playBtn.addEventListener('click', speak);
  const close = () => {
    stopSpeech();
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    app.editor.restoreRange() || app.editor.scroller.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === ' ' && e.target === content) {
      e.preventDefault();
      speak();
    } else if (e.key === 'Tab') {
      const f = [...overlay.querySelectorAll('button, select, input, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f.at(-1).focus();
      } else if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        f[0].focus();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  const sizeInput = h('input', { type: 'range', min: '16', max: '56', step: '2', value: String(settings.size), 'aria-label': 'Text size' });
  sizeInput.addEventListener('input', () => {
    settings.size = Number(sizeInput.value);
    apply();
  });
  const fontSel = h('select.select', { 'aria-label': 'Font' }, [['sans', 'Sans serif'], ['serif', 'Serif'], ['mono', 'Monospace']].map(([v, l]) => h('option', { value: v, selected: settings.font === v }, l)));
  fontSel.addEventListener('change', () => {
    settings.font = fontSel.value;
    apply();
  });
  const themeSel = h('select.select', { 'aria-label': 'Page theme' }, [['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: settings.theme === v }, l)));
  themeSel.addEventListener('change', () => {
    settings.theme = themeSel.value;
    apply();
  });
  const spacing = h('input', { type: 'checkbox', checked: settings.spacing });
  spacing.addEventListener('change', () => {
    settings.spacing = spacing.checked;
    apply();
  });
  const rateSel = h('select.select', { 'aria-label': 'Voice speed' }, [[0.75, 'Slow'], [1, 'Normal'], [1.25, 'Fast'], [1.5, 'Faster']].map(([v, l]) => h('option', { value: String(v), selected: settings.rate === v }, l)));
  rateSel.addEventListener('change', () => {
    settings.rate = Number(rateSel.value);
    if (speaking) {
      stopSpeech();
      speak();
    }
    apply();
  });
  const toolbar = h('div.reader-bar',
    h('span.reader-title', 'Immersive Reader'),
    h('label.reader-opt', icon('fontSize', 16), sizeInput),
    h('label.reader-opt', fontSel),
    h('label.reader-opt', themeSel),
    h('label.reader-opt.check-row', spacing, 'Wide spacing'),
    h('label.reader-opt', 'Voice speed', rateSel),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Close Immersive Reader', onclick: close }, icon('x', 20)),
  );
  overlay.append(toolbar, h('div.reader-scroll', content), h('div.reader-foot', playBtn));
  document.body.append(overlay);
  apply();
  content.focus();
}

// ------------------------------------------------------------ email, export, import

export function emailPage(app) {
  const page = app.editor.page;
  if (!page) return;
  app.editor.flush();
  const body = pageText(page).replace(page.title || '', '').trim();
  const url = `mailto:?subject=${encodeURIComponent(page.title || 'Notes page')}&body=${encodeURIComponent(body.slice(0, 1800))}`;
  window.location.href = url;
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function safeName(s) {
  return (s || 'Untitled Page').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim() || 'Untitled Page';
}

async function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

/** A page's outlines with images inlined as data URLs, for export and sharing. */
async function inlineOutlines(app, page, { maxImage = 8 * 1024 * 1024, keepTags = false } = {}) {
  const out = [];
  for (const o of [...page.outlines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const div = document.createElement('div');
    div.innerHTML = sanitizeHtml(o.html);
    for (const img of div.querySelectorAll('img[data-asset]')) {
      const blob = await app.store.assetBlob(img.dataset.asset).catch(() => null);
      if (blob && blob.size <= maxImage) {
        const url = await blobToDataUrl(blob instanceof Blob ? blob : new Blob([blob]));
        if (url) img.setAttribute('src', url);
      }
      img.removeAttribute('data-asset');
    }
    for (const f of div.querySelectorAll('.nt-file')) f.replaceWith(document.createTextNode(`[${f.dataset.name || 'attachment'}]`));
    for (const m of div.querySelectorAll('.nt-math')) {
      if (keepTags) continue;
      m.innerHTML = await renderMath(m.dataset.tex);
    }
    if (!keepTags) {
      for (const t of div.querySelectorAll('.nt-tag')) {
        const label = t.dataset.done !== undefined ? (t.dataset.done === 'true' ? '[x] ' : '[ ] ') : '';
        t.replaceWith(document.createTextNode(label));
      }
    }
    out.push({ x: o.x, y: o.y, w: o.w, html: div.innerHTML });
  }
  return out;
}

async function inlinePageHtml(app, page, opts) {
  return (await inlineOutlines(app, page, opts)).map((o) => `<div class="outline">${o.html}</div>`).join('\n');
}

const EXPORT_CSS = 'body{font:11pt/1.4 -apple-system,"Segoe UI",system-ui,sans-serif;color:#1b1b1b;max-width:820px;margin:40px auto;padding:0 24px}h1.page-title{font-weight:300;font-size:22pt;border-bottom:1px solid #aaa;padding-bottom:4px;margin-bottom:4px}.meta{color:#666;font-size:9.5pt;margin-bottom:24px}.outline{margin:0 0 18px}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:2px 6px;vertical-align:top}img{max-width:100%;height:auto}blockquote{border-left:3px solid #bbb;margin:0;padding-left:10px;color:#555;font-style:italic}pre{background:#f4f4f4;padding:4px 6px;white-space:pre-wrap}hr.page-break{border:0;border-top:2px solid #ddd;margin:40px 0}';

async function pageHtmlDocument(app, pages) {
  const sections = [];
  for (const page of pages) {
    sections.push(`<article><h1 class="page-title">${escapeHtml(page.title || 'Untitled Page')}</h1><div class="meta">${escapeHtml(new Date(page.created).toLocaleString())}</div>${await inlinePageHtml(app, page)}</article>`);
  }
  const title = pages.length === 1 ? pages[0].title || 'Untitled Page' : 'Notes export';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${EXPORT_CSS}</style></head><body>${sections.join('<hr class="page-break">')}</body></html>`;
}

export async function exportPage(app, format) {
  const page = app.editor.page;
  if (!page) return;
  app.editor.flush();
  const name = safeName(page.title);
  if (format === 'txt') return download(`${name}.txt`, new Blob([pageText(page)], { type: 'text/plain' }));
  if (format === 'md') {
    const md = [`# ${page.title || 'Untitled Page'}`, ...[...page.outlines].sort((a, b) => a.y - b.y || a.x - b.x).map((o) => htmlToMarkdown(o.html)).filter((md) => md.trim())].join('\n\n');
    return download(`${name}.md`, new Blob([md + '\n'], { type: 'text/markdown' }));
  }
  const html = await pageHtmlDocument(app, [page]);
  download(`${name}.html`, new Blob([html], { type: 'text/html' }));
}

export async function exportSection(app, sectionId) {
  const section = app.store.section(sectionId);
  if (!section) return;
  // A locked section's page list is sealed: unlock it rather than export
  // an empty file.
  if (section.locked && !app.store.keys.has(section.id) && !(await unlockSection(app, section))) return;
  app.editor.flush();
  const pages = [];
  for (const m of section.pages) pages.push(await app.store.loadPage(m.id));
  const html = await pageHtmlDocument(app, pages);
  download(`${safeName(section.name)}.html`, new Blob([html], { type: 'text/html' }));
}

export async function exportNotebook(app, notebookId) {
  const nb = app.store.notebook(notebookId);
  if (!nb) return;
  const protectedSections = [...app.store.sectionsOf(nb)].filter((s) => s.locked);
  const locked = protectedSections.filter((s) => !app.store.keys.has(s.id));
  const open = protectedSections.filter((s) => app.store.keys.has(s.id));
  if (protectedSections.length) {
    const parts = [];
    if (locked.length) parts.push(`Locked sections are left out: ${locked.map((s) => `"${s.name}"`).join(', ')}. Unlock them first to include them.`);
    if (open.length) parts.push(`Unlocked protected sections (${open.map((s) => `"${s.name}"`).join(', ')}) are saved without encryption in the backup file.`);
    if (!(await confirmDialog({ title: 'Export notebook backup?', message: parts.join(' '), okLabel: 'Export' }))) return;
  }
  app.editor.flush();
  toast('Preparing the backup...');
  const pages = {};
  const assets = {};
  for (const section of app.store.sectionsOf(nb)) {
    for (const m of section.pages) {
      const page = await app.store.loadPage(m.id);
      pages[m.id] = page;
      for (const o of page.outlines) {
        for (const match of o.html.matchAll(/data-asset="([^"]+)"/g)) {
          if (assets[match[1]]) continue;
          const blob = await app.store.assetBlob(match[1]).catch(() => null);
          if (blob) assets[match[1]] = await blobToDataUrl(blob instanceof Blob ? blob : new Blob([blob]));
        }
      }
    }
  }
  // Locked sections stay out; unlocked protected ones go in as plain sections.
  const strip = (nodes) => nodes.flatMap((n) => {
    if (n.type === 'group') return [{ ...n, children: strip(n.children) }];
    if (n.locked && !app.store.keys.has(n.id)) return [];
    const { locked, sealed, ...rest } = n;
    void locked;
    void sealed;
    return [rest];
  });
  const backup = { format: 'notes-backup', v: 1, exported: new Date().toISOString(), notebook: { ...nb, sections: strip(nb.sections) }, pages, assets };
  download(`${safeName(nb.name)}.notes.json`, new Blob([JSON.stringify(backup)], { type: 'application/json' }));
}

/** Rebuilds a notebook from a backup with fresh ids so it never collides. */
export async function importBackup(app, backup) {
  const store = app.store;
  const idMap = new Map();
  const fresh = (old, prefix) => {
    if (!idMap.has(old)) idMap.set(old, uid(prefix));
    return idMap.get(old);
  };
  const assetMap = new Map();
  let failed = 0;
  for (const [oldId, dataUrl] of Object.entries(backup.assets || {})) {
    let blob;
    try {
      blob = await (await fetch(dataUrl)).blob();
    } catch {
      continue; // a broken entry in the file
    }
    try {
      const ext = oldId.replace(/\.sealed$/, '').split('.').pop();
      assetMap.set(oldId, await store.saveAsset(blob, `asset.${ext}`));
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  if (failed) toast(`${failed} ${failed === 1 ? 'picture or file' : 'pictures or files'} couldn't be imported. Check your connection and import the backup again.`, { kind: 'error' });
  const nb = store.createNotebook(store.notebooks.some((n) => n.name === backup.notebook.name) ? `${backup.notebook.name} (imported)` : backup.notebook.name, { color: backup.notebook.color, silent: true });
  const cloneNodes = (nodes) => nodes.map((n) => (n.type === 'group'
    ? { ...n, id: fresh(n.id, 'g'), children: cloneNodes(n.children || []) }
    : { ...n, id: fresh(n.id, 's'), locked: undefined, pages: (n.pages || []).map((p) => ({ ...p, id: fresh(p.id, 'p') })) }));
  nb.sections = cloneNodes(backup.notebook.sections || []);
  for (const [oldId, page] of Object.entries(backup.pages || {})) {
    const id = fresh(oldId, 'p');
    const copy = { ...page, id, outlines: (page.outlines || []).map((o) => ({ ...o, html: sanitizeHtml(String(o.html || '').replace(/data-asset="([^"]+)"/g, (m, a) => `data-asset="${assetMap.get(a) || a}"`).replace(/#page=([\w-]+)/g, (m, p) => `#page=${idMap.get(p) || p}`)) })) };
    store.pages.set(id, copy);
    store.schedule(`pages/${id}.json`, () => store.pages.get(id), 0);
  }
  store.touchNotebook(nb);
  store.emit('change', { type: 'notebook', id: nb.id });
  return nb;
}

export function importFiles(app) {
  const input = h('input', { type: 'file', multiple: true, accept: '.md,.markdown,.txt,.html,.htm,.json,text/markdown,text/plain,text/html,application/json', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.remove();
    let firstPage = null;
    let count = 0;
    for (const file of files) {
      try {
        const text = await file.text();
        if (/\.json$/i.test(file.name)) {
          const data = JSON.parse(text);
          if (data?.format !== 'notes-backup') throw new Error(`${file.name} is not a notebook backup`);
          const nb = await importBackup(app, data);
          app.selectNotebook(nb.id);
          count++;
          continue;
        }
        let html;
        let title = file.name.replace(/\.[^.]+$/, '');
        if (/\.html?$/i.test(file.name)) {
          const doc = new DOMParser().parseFromString(text, 'text/html');
          title = doc.querySelector('title')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || title;
          html = sanitizeHtml(doc.body?.innerHTML || '');
        } else if (/\.(md|markdown)$/i.test(file.name)) {
          const m = text.match(/^#\s+(.+)$/m);
          if (m && text.trimStart().startsWith('#')) {
            title = m[1].trim();
            html = markdownToHtml(text.replace(/^\s*#\s+.+\n?/, ''));
          } else html = markdownToHtml(text);
        } else html = sanitizeHtml(textToHtml(text));
        if (!app.store.section(app.state.sectionId)) app.newSection();
        const meta = app.store.createPage(app.state.sectionId, { title, outlines: [{ id: uid('o'), x: 48, y: 140, w: 720, html }] });
        firstPage ||= meta.id;
        count++;
      } catch (err) {
        toast(`Couldn't import ${file.name}: ${err.message}`, { kind: 'error' });
      }
    }
    if (firstPage) app.openPage(firstPage);
    if (count) toast(`Imported ${count} ${count === 1 ? 'file' : 'files'}`);
  });
  document.body.append(input);
  input.click();
}

// ------------------------------------------------------------ share

export function shareDialog(app) {
  const page = app.editor.page;
  if (!page) return;
  app.editor.flush();
  const status = h('p.field-hint', { role: 'status' });
  const linkInput = h('input.input', { type: 'text', readonly: true, 'aria-label': 'Read-only link', placeholder: 'Publish to create a link' });
  const copyBtn = h('button.btn', { type: 'button', disabled: true, onclick: () => navigator.clipboard?.writeText(linkInput.value).then(() => toast('Link copied')) }, icon('copy', 14), 'Copy');
  const expiry = h('select.select', { 'aria-label': 'Link expires after' }, [['1d', '1 day'], ['7d', '7 days'], ['30d', '30 days'], ['365d', '1 year']].map(([v, l]) => h('option', { value: v, selected: v === '30d' }, l)));
  const publishBtn = h('button.btn.primary', { type: 'button' }, icon('globe', 14), 'Create Link');
  const stopBtn = h('button.btn', { type: 'button', hidden: !page.published }, 'Stop Sharing');
  publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    status.textContent = 'Publishing...';
    try {
      const outlines = await inlineOutlines(app, page, { maxImage: 3 * 1024 * 1024, keepTags: true });
      const snapshot = { format: 'notes-shared-page', v: 2, title: page.title, created: page.created, color: page.color, rules: page.rules, outlines, ink: page.ink || [], published: new Date().toISOString() };
      const path = `published/${page.id}.json`;
      await app.store.backend.writeJSON(path, snapshot);
      const url = await app.store.backend.readURL(path, expiry.value);
      linkInput.value = `${location.origin}${location.pathname}#view=${encodeURIComponent(url)}`;
      copyBtn.disabled = false;
      stopBtn.hidden = false;
      page.published = { at: snapshot.published, expires: expiry.value };
      app.store.pageChanged(page);
      status.textContent = `Anyone with the link can read a copy of this page as it is now, for ${expiry.selectedOptions[0].textContent}. Publish again after editing to update it.`;
      linkInput.select();
    } catch (err) {
      status.textContent = `Couldn't create the link: ${err?.message || 'request failed'}`;
    } finally {
      publishBtn.disabled = false;
    }
  });
  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    try {
      await app.store.backend.remove(`published/${page.id}.json`);
    } catch (err) {
      // The snapshot is still there, so the link still opens it.
      status.textContent = `Couldn't stop sharing: ${err?.message || 'request failed'}. The link still works. Try again.`;
      return;
    } finally {
      stopBtn.disabled = false;
    }
    delete page.published;
    app.store.pageChanged(page);
    linkInput.value = '';
    copyBtn.disabled = true;
    stopBtn.hidden = true;
    status.textContent = 'Sharing stopped. Existing links no longer open the page.';
  });
  const pageLink = `${location.origin}${location.pathname}#page=${page.id}`;
  openDialog({
    title: `Share "${page.title || 'Untitled Page'}"`,
    width: 520,
    body: h('div',
      h('h3.share-head', 'Read-only link'),
      h('p.dialog-message', 'Create a link anyone can open to read this page, without signing in.'),
      h('div.share-row', expiry, publishBtn, stopBtn),
      h('div.share-row', linkInput, copyBtn),
      status,
      h('h3.share-head', 'Other ways to share'),
      h('div.share-row',
        h('button.btn', { type: 'button', onclick: () => navigator.clipboard?.writeText(pageLink).then(() => toast('Link copied')) }, icon('link', 14), 'Copy Link to Page'),
        h('button.btn', { type: 'button', onclick: () => emailPage(app) }, icon('mail', 14), 'Email Page'),
        h('button.btn', { type: 'button', onclick: (e) => openMenu(e.currentTarget, app.commands.get('export').menu(app), { label: 'Export' }) }, icon('download', 14), 'Export'),
      ),
      h('p.field-hint', '"Copy Link to Page" opens the page in Notes for you (signed in to your account).'),
    ),
    actions: [{ label: 'Done', primary: true }],
  });
}

// ------------------------------------------------------------ help, shortcuts, about

const EDITING_KEYS = [
  ['Tab', 'Indent paragraph, or move to the next table cell'],
  ['Shift+Tab', 'Outdent paragraph, or move to the previous table cell'],
  ['Escape', 'Stop typing and select the note container'],
  ['Delete', 'Delete the selected container or ink'],
  ['Enter', 'In the page title, move to the notes'],
  ['* then Space', 'Start a bulleted list'],
  ['1. then Space', 'Start a numbered list'],
  ['Mod+A', 'Select the container text; press again for all containers'],
  ['Mod+Wheel', 'Zoom the page'],
  ['F6', 'Move between the ribbon, panes and the page'],
  ['Alt+Shift+ArrowUp', 'In the panes: move the page or section up'],
];

export function shortcutsDialog(app) {
  const groups = [
    ['Notebooks and pages', ['newPage', 'newSubpage', 'newSection', 'makeSubpage', 'promoteSubpage', 'nextPage', 'prevPage', 'search', 'findOnPage', 'syncNow', 'print']],
    ['Formatting', ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript', 'highlight', 'clearFormat', 'growFont', 'shrinkFont', 'bullets', 'numbering', 'indent', 'outdent', 'alignLeft', 'alignCenter', 'alignRight', 'moveUp', 'moveDown', 'formatPainter', 'insertLink']],
    ['Styles', ['style:h1', 'style:h2', 'style:h3', 'style:h4', 'style:h5', 'style:h6', 'style:normal']],
    ['Tags', ['tag:todo', 'tag:important', 'tag:question', 'tag:remember', 'tag:definition', 'tag:highlight', 'tag:contact', 'tag:address', 'tag:phone', 'removeTags']],
    ['Insert', ['insertDate', 'insertTime', 'insertDateTime']],
    ['View', ['zoomIn', 'zoomOut', 'fullPage', 'toggleNav', 'collapseRibbon', 'tellMe', 'undo', 'redo', 'shortcuts', 'help']],
  ];
  const filter = h('input.input', { type: 'search', placeholder: 'Search shortcuts', 'aria-label': 'Search shortcuts' });
  const body = h('div.shortcuts', { tabindex: '0', role: 'region', 'aria-label': 'Shortcut list' });
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    const sections = [];
    for (const [title, ids] of groups) {
      const rows = ids.map((id) => app.commands.get(id)).filter((c) => c?.key && (!q || c.label.toLowerCase().includes(q)));
      if (!rows.length) continue;
      sections.push(h('section', h('h3', title), h('table.shortcut-table', h('tbody', rows.map((c) => h('tr', h('td', c.label), h('td', h('kbd.kbd', shortcutLabel(c.key)))))))));
    }
    const edit = EDITING_KEYS.filter(([, d]) => !q || d.toLowerCase().includes(q));
    if (edit.length) sections.push(h('section', h('h3', 'Editing'), h('table.shortcut-table', h('tbody', edit.map(([k, d]) => h('tr', h('td', d), h('td', h('kbd.kbd', shortcutLabel(k.includes('then') || k === 'Mod+Wheel' ? k : k).replace('Wheel', ' + scroll')))))))));
    body.replaceChildren(...(sections.length ? sections : [h('p.field-hint', 'No shortcuts match.')]));
  };
  filter.addEventListener('input', render);
  render();
  openDialog({ title: 'Keyboard Shortcuts', width: 620, body: h('div', filter, body), actions: [{ label: 'Close', primary: true }] });
}

export function helpDialog(app) {
  const tip = (ic, title, text) => h('div.help-tip', icon(ic, 20, undefined, { plain: true }), h('div', h('strong', title), h('p', text)));
  openDialog({
    title: 'Help',
    width: 560,
    body: h('div.help',
      tip('container', 'Click anywhere to write', 'Notes are free-form. Click on the page to start a note container, drag its top bar to move it and its right edge to resize it.'),
      tip('notebooks', 'Notebooks, sections and pages', 'Use the panes on the left. Drag pages to reorder them or to the right to make subpages, and drag sections into section groups.'),
      tip('todo', 'Tags', `Mark paragraphs with tags such as To Do (${shortcutLabel('Mod+1')}) and Important (${shortcutLabel('Mod+2')}). Find Tags lists them all.`),
      tip('pen', 'Draw', 'On the Draw tab, pick a pen or highlighter to write by hand. Use Lasso Select to move ink and Insert Space to make room.'),
      tip('search', 'Search', `Press ${shortcutLabel('Mod+E')} to search every notebook, or ${shortcutLabel('Mod+F')} to find on the current page.`),
      tip('cloud', 'Saved to your cloud', 'Everything saves automatically to your Puter account. Deleted items stay in Deleted Notes for 60 days.'),
    ),
    actions: [{ label: 'Keyboard Shortcuts', run: () => setTimeout(() => app.shortcutsDialog()) }, { label: 'Close', primary: true }],
  });
}

export function aboutDialog() {
  openDialog({
    title: 'About Notes',
    width: 440,
    body: h('div.about',
      h('img', { src: './favicon.svg', alt: '', width: 56, height: 56 }),
      h('p', h('strong', 'Notes'), ' is a free-form digital notebook. Your notebooks are stored as files in your own Puter cloud storage.'),
      h('p.field-hint', 'Built with Puter.js. Icons from Lucide (ISC license). Ink smoothing by perfect-freehand (MIT license). Equations by Temml (MIT license). PDF printouts by pdf.js (Apache-2.0 license).'),
    ),
    actions: [{ label: 'Close', primary: true }],
  });
}

// ------------------------------------------------------------ password-protected sections

function passwordField(id, label, autocomplete) {
  const input = h('input.input', { id, type: 'password', autocomplete, spellcheck: 'false' });
  return { input, field: h('div.field', h('label.field-label', { for: id }, label), input) };
}

/** Asks for a protected section's password. Resolves true once it is unlocked. */
export function unlockSection(app, section) {
  return new Promise((resolve) => {
    const pw = passwordField('unlock-pw', 'Password', 'current-password');
    const error = h('p.field-error', { role: 'alert' });
    let ok = false;
    openDialog({
      title: 'Protected Section',
      width: 380,
      body: h('div', h('p.dialog-message', `"${section.name}" is password protected. Enter its password to see its pages.`), pw.field, error),
      actions: [
        { label: 'Cancel' },
        { label: 'Unlock', primary: true, run: async (btn) => {
          if (!pw.input.value) {
            error.textContent = 'Enter the password.';
            return false;
          }
          btn.disabled = true;
          let damaged = null;
          const unlocked = await app.store.unlockSection(section.id, pw.input.value).catch((err) => {
            if (err?.damaged) damaged = err.message;
            return false;
          });
          btn.disabled = false;
          if (damaged) {
            error.textContent = damaged;
            return false;
          }
          if (!unlocked) {
            error.textContent = 'That password is not correct. Passwords are case-sensitive.';
            pw.input.select();
            return false;
          }
          ok = true;
          app.unlocked.add(section.id);
          app.touchProtected();
          return true;
        } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

export function passwordDialog(app, section) {
  const store = app.store;
  if (section.locked && !store.keys.has(section.id)) {
    unlockSection(app, section).then((ok) => ok && passwordDialog(app, section));
    return;
  }
  const isNew = !section.locked;
  const first = passwordField('pw-new', isNew ? 'Enter password' : 'New password', 'new-password');
  const second = passwordField('pw-confirm', 'Confirm password', 'new-password');
  const error = h('p.field-error', { role: 'alert' });
  const actions = [{ label: 'Cancel' }];
  if (!isNew) {
    actions.push({ label: 'Remove Password', run: async () => {
      if (!(await confirmDialog({ title: 'Remove password?', message: `"${section.name}" will no longer be encrypted. Anyone signed in to your account will be able to read it.`, okLabel: 'Remove' }))) return false;
      try {
        await store.unprotectSection(section.id);
      } catch (err) {
        error.textContent = `Couldn't remove the password: ${err.message}`;
        return false;
      }
      app.unlocked.delete(section.id);
      toast('Password removed');
      app.renderNav();
      return true;
    } });
  }
  actions.push({
    label: isNew ? 'Protect' : 'Change Password',
    primary: true,
    run: async (btn) => {
      const a = first.input.value;
      if (a.length < 4) {
        error.textContent = 'Use at least 4 characters.';
        first.input.focus();
        return false;
      }
      if (a !== second.input.value) {
        error.textContent = "The passwords don't match.";
        second.input.select();
        return false;
      }
      btn.disabled = true;
      app.editor.flush();
      try {
        await store.protectSection(section.id, a);
      } catch (err) {
        error.textContent = `Couldn't protect the section: ${err.message}`;
        btn.disabled = false;
        return false;
      }
      app.unlocked.add(section.id);
      app.touchProtected();
      toast(isNew ? `"${section.name}" is now password protected` : 'Password changed');
      app.renderNav();
      return true;
    },
  });
  openDialog({
    title: isNew ? 'Password Protection' : 'Change Password',
    width: 420,
    body: h('div',
      h('p.dialog-message', isNew ? `Pages in "${section.name}" will be encrypted with this password. They lock again after 10 minutes without use, or with Lock All.` : `Change the password for "${section.name}", or remove it.`),
      first.field,
      second.field,
      error,
      h('p.field-hint', { role: 'note' }, 'Keep the password safe. If you forget it, nobody can recover these notes.'),
    ),
    actions,
  });
}

// ------------------------------------------------------------ canvas context menu

export function canvasContextMenu(app, e) {
  const ed = app.editor;
  if (!ed.page || ed.readOnly) return;
  const img = e.target.closest('.outline-body img');
  const file = e.target.closest('.nt-file');
  const bar = e.target.closest('.outline-bar');
  const outline = e.target.closest('.outline');
  const point = { x: e.clientX, y: e.clientY };
  if (img) {
    e.preventDefault();
    openMenu(point, [
      { label: 'Alt Text...', icon: 'accessibility', run: () => altTextDialog(app, img) },
      { label: 'Save As...', icon: 'download', run: async () => {
        const blob = img.dataset.asset ? await app.store.assetBlob(img.dataset.asset) : null;
        if (blob) download(img.getAttribute('alt') || img.dataset.asset, blob instanceof Blob ? blob : new Blob([blob]));
      } },
      { label: 'Reset Size', icon: 'pageWidth', run: () => { img.style.removeProperty('width'); img.style.removeProperty('height'); ed.dirty.add(outline); ed.commit(); } },
      { type: 'sep' },
      { label: 'Delete', icon: 'trash', danger: true, run: () => { img.remove(); ed.clearImageSelection(); ed.dirty.add(outline); ed.commit(); } },
    ], { label: 'Picture' });
    return;
  }
  if (file) {
    e.preventDefault();
    openMenu(point, [
      { label: 'Open', icon: 'external', run: () => openAttachment(app, file.dataset) },
      { label: 'Save As...', icon: 'download', run: async () => {
        const blob = await app.store.assetBlob(file.dataset.asset);
        if (blob) download(file.dataset.name || 'attachment', blob instanceof Blob ? blob : new Blob([blob]));
      } },
      { type: 'sep' },
      { label: 'Delete', icon: 'trash', danger: true, run: () => { file.remove(); ed.dirty.add(outline); ed.commit(); } },
    ], { label: 'Attachment' });
    return;
  }
  if (bar && outline) {
    e.preventDefault();
    ed.selectOutlines([outline]);
    openMenu(point, [
      { label: 'Copy', icon: 'copy', run: () => {
        const body = outline.querySelector('.outline-body');
        const html = body.innerHTML;
        navigator.clipboard?.write?.([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([body.innerText], { type: 'text/plain' }) })]).then(() => toast('Copied'), () => toast("Couldn't copy."));
      } },
      { label: 'Fit Width to Content', icon: 'pageWidth', run: () => { const m = ed.outlineModel(outline); m.w = null; ed.place(outline, m); ed.layout(); ed.changed(); } },
      { label: 'Bring to Front', icon: 'up', run: () => {
        const m = ed.outlineModel(outline);
        ed.page.outlines = [...ed.page.outlines.filter((o) => o !== m), m];
        ed.outlinesEl.append(outline);
        ed.changed();
      } },
      { label: 'Send to Back', icon: 'down', run: () => {
        const m = ed.outlineModel(outline);
        ed.page.outlines = [m, ...ed.page.outlines.filter((o) => o !== m)];
        ed.outlinesEl.prepend(outline);
        ed.changed();
      } },
      { type: 'sep' },
      { label: 'Delete', icon: 'trash', danger: true, shortcut: 'Delete', run: () => ed.deleteSelectedOutlines() },
    ], { label: 'Note container' });
    return;
  }
  if (!outline && !e.target.closest('.page-header')) {
    e.preventDefault();
    const p = ed.pagePoint(e);
    if (ed.ink.selected.size) {
      openMenu(point, [{ label: 'Delete', icon: 'trash', danger: true, run: () => ed.deleteSelectedOutlines() }], { label: 'Ink' });
      return;
    }
    openMenu(point, [
      { label: 'Paste', icon: 'paste', run: () => { ed.createOutlineAt(p.x, p.y); app.paste(); } },
      { type: 'sep' },
      { label: 'Insert Table', icon: 'table', run: () => { ed.createOutlineAt(p.x, p.y); app.insertTableDialog(); } },
      { label: 'Insert Picture', icon: 'picture', run: () => { ed.createOutlineAt(p.x, p.y); app.pickFiles({ accept: 'image/*' }); } },
      { label: 'Attach File', icon: 'file', run: () => { ed.createOutlineAt(p.x, p.y); app.pickFiles({ attach: true }); } },
      { type: 'sep' },
      { label: 'Page Color', icon: 'pageColor', submenu: () => app.commands.get('pageColor').menu(app) },
      { label: 'Rule Lines', icon: 'ruleLines', submenu: () => app.commands.get('ruleLines').menu(app) },
      { label: 'Select All', icon: 'pointer', run: () => ed.selectAllOutlines() },
    ], { label: 'Page' });
  }
}

function altTextDialog(app, img) {
  const input = h('textarea.input', { id: 'alt-text', rows: 3 });
  input.value = img.getAttribute('alt') || '';
  openDialog({
    title: 'Alt Text',
    width: 420,
    body: h('div.field', h('label.field-label', { for: 'alt-text' }, 'Describe this picture for people who use screen readers'), input),
    actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, run: () => {
      img.setAttribute('alt', input.value.trim());
      const outline = img.closest('.outline');
      app.editor.dirty.add(outline);
      app.editor.commit();
    } }],
  });
}

export { selectRange };
