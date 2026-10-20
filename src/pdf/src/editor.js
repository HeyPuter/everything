import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'virtual:pdf-worker-url';
import { PDFDocument } from 'pdf-lib';
import { savePdf } from './core/version.js';
import { indexPageText, searchQuery } from './core/search.js';
import { inspectText, matrix, textColor } from './core/text-edit.js';
import { groupTextRuns, replaceTextGroup } from './core/text-group.js';
import { draftText, textLineInput } from './text-line-input.js';
import { groupTextParagraphs } from './core/text-paragraph.js';
import { textPositionControls } from './text-position.js';
import { placeTextCaret } from './text-caret.js';
import { textWidthControls } from './text-width.js';
import { createFormLayer } from './form-layer.js';
import { choiceInputOptions } from './core/form-draft.js';
import { createImageLayer } from './image-layer.js';
import { createPropertiesPanel } from './properties-panel.js';
import { createToolsPanel } from './shell/tools-panel.js';
import { toolIcon } from './shell/icons.js';
import { createPageStack } from './page-stack.js';
import { createOrganizeView } from './organize-view.js';
import { inspectImages, editImage, imagePreview, replaceImage } from './core/image-edit.js';
import { inspectPaths, editPath, pathPreview } from './core/path-edit.js';
import { selectedTextQuads, alignTextLayer, pageTextRange } from './text-selection.js';
import { addHighlight, listHighlights, editHighlight, MARKUP_KINDS } from './core/highlight.js';
import { openMenu as showMenu, createMenubar, closeMenu } from './lib/menu.js';
import { parsePageRange, formatPageRange, extractPages } from './core/pages.js';
import { printPages, pageImage } from './print.js';
import { signatureDialog } from './signature-dialog.js';
import { drawSignature } from './core/signature.js';
import { enableThumbnailReorder } from './page-organizer.js';
import { addNote, listNotes, editNote, NOTE_SIZE } from './core/notes.js';
import { createOutlinePanel, destinationPage } from './outline.js';
import { createCommentsPanel } from './comments.js';
import { createAttachmentsPanel, createLayersPanel } from './side-panels.js';
import { createSignaturesPanel, createSignatureBar } from './signatures-panel.js';
import { chooseDigitalId, signatureDetailsDialog } from './digital-id-dialog.js';
import { addAttachment, attachmentBytes, removeAttachment } from './core/attachments.js';
import {
  listFonts,
  readInitialView,
  readPdfaClaim,
  writeInitialView,
} from './core/initial-view.js';
import { createAccessibilityReport } from './accessibility-report.js';
import { createFormDesigner, fieldTypeLabel } from './form-designer.js';
import { createAnnotationLayer, ANNOTATION_KINDS } from './annotation-layer.js';
import { measureLabel, MEASURE_UNITS } from './core/measure.js';
import {
  addTextBox,
  addCallout,
  addShapeAnnotation,
  addInkAnnotation,
  listAnnotations,
  editAnnotation,
  deleteAnnotation,
  addReply,
  setReviewState,
  exportXfdf,
  importXfdf,
  exportCommentSummary,
  annotationAccepts,
  REVIEW_STATES,
} from './core/annotations.js';
import { ensureStyledFontFaces, ensureKoreanFontFaces, koreanDraftFace } from './text-fonts.js';
import {
  documentAccess,
  requireDocumentAccess,
  passwordsSupported,
  protectPdf,
} from './core/security.js';
import { compressPdf, COMPRESSION_LEVELS } from './core/compress.js';
import { createImageCodec, normalizeImageFiles } from './image-codec.js';
import { addImagePages, defaultPaper } from './core/image-pages.js';
import { cropMargins, cropPages, resetCrop } from './core/crop.js';
import { drawStamp } from './core/stamp.js';
import { addLink, normalizeUrl, removeLink, safeLinkUrl, updateLink } from './core/links.js';
import { annotationLayerVisible } from './core/optional-content.js';
import { flattenCounts, flattenDocument } from './core/flatten.js';
import {
  MAX_SPLIT_FILES,
  parseSplitPoints,
  splitPdf,
  splitRanges,
  zipParts,
} from './core/split.js';
import { addBookmark, removeBookmark, renameBookmark } from './core/outline-edit.js';
import { stampDialog } from './stamp-dialog.js';
import {
  addWatermark,
  addPageNumbers,
  addHeaderFooter,
  HEADER_SLOTS,
  WATERMARK_SIZES,
  NUMBER_FORMATS,
  NUMBER_POSITIONS,
} from './core/page-marks.js';
import { protectDialog } from './protect-dialog.js';
import { promptUnlock, promptOwner } from './unlock-dialog.js';
import {
  el,
  icon,
  appIcon,
  button,
  iconButton,
  formatShortcut,
  modal as showModal,
  dialogVersion,
  beginDialogRequest,
  confirmAction as askConfirmation,
  promptText as askText,
  toast,
  download,
  copyText,
  formatBytes,
  contrastInk,
} from './lib/ui.js';
import * as P from './lib/puter.js';
import { waitFor } from './lib/abort.js';
import {
  safeName,
  validatePdf,
  rotatePage,
  rotateAllPages,
  deletePage,
  deletePages as deleteDocumentPages,
  movePage,
  reorderPages,
  insertBlankPage,
  insertPdfPages,
  duplicatePage,
  addText,
  textVariant,
  hasKoreanText,
  addImage,
  drawMark,
  arrowHead,
  normalizeRect,
  listFields,
  formButtonSelections,
  formFieldTooltips,
  fillFields,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  MAX_PAGES,
} from './core/document.js';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// Tools used now and then load on first use, keeping the editor itself quick to start.
const loadRedaction = () => import('./core/redact.js');
const loadSanitize = () => import('./core/sanitize.js');
const loadForms = () => import('./core/form-create.js');
// One worker serves every document and preview. Left to itself, getDocument starts a new
// worker per call and destroying the document terminates it, so each edit (which reloads the
// document) and each draft preview paid for a worker start before any parsing began.
let sharedWorker = null;
const pdfWorker = () => {
  if (!sharedWorker || sharedWorker.destroyed) {
    const worker = (sharedWorker = new pdfjs.PDFWorker({ name: 'pdf-editor' }));
    // A worker that failed to start is not kept, so the next open can try again.
    worker.promise.catch(() => {
      if (sharedWorker === worker) sharedWorker = null;
    });
  }
  return sharedWorker;
};
const loadPdf = (bytes) =>
  pdfjs.getDocument({
    data: bytes,
    worker: pdfWorker(),
    isEvalSupported: false,
    enableXfa: false,
    cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
    wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
    iccUrl: `${import.meta.env.BASE_URL}pdfjs/iccs/`,
  });

/** Publish a completed bitmap in one task, so clearing/resizing never reaches the screen. */
function paintCanvas(canvas, rendered, viewport) {
  if (canvas.width !== rendered.width) canvas.width = rendered.width;
  if (canvas.height !== rendered.height) canvas.height = rendered.height;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvas.getContext('2d').drawImage(rendered, 0, 0);
}

export function createEditor({
  root,
  session,
  name,
  path,
  remote: initialRemote = null,
  settings,
  getUser,
  signedOut = () => false,
  signIn,
  goHome,
  onOpen,
  onOpenCloud,
  onNew,
  onOpenBytes = null,
  shortcuts,
  protection: initialProtection = null,
  encryptedOriginal = null,
}) {
  // Dialogs belong to this document, including ones opened after an asynchronous file read.
  // Replacing the editor cancels their choices and leaves the new document interactive.
  const dialogController = new AbortController();
  const dialogOptions = { signal: dialogController.signal };
  const modal = (title, content, actions) => showModal(title, content, actions, dialogOptions);
  const confirmAction = (title, message, label) =>
    askConfirmation(title, message, label, dialogOptions);
  const promptText = (title, label, value) => askText(title, label, value, dialogOptions);
  let pdf,
    loadingTask,
    currentPage,
    pageIndex = 0,
    pageCount = 0,
    pendingNavigation = null,
    navigationGeneration = 0,
    viewport,
    pageReady = false,
    renderedWorkspaceWidth = 0,
    renderedWorkspaceHeight = 0,
    tool = 'select',
    destroyed = false,
    busy = true,
    initializing = true,
    saving = false,
    generation = 0,
    renderTask,
    textLayer,
    pageTextIndex,
    scaleMode = 'fit',
    pendingZoom = null,
    zoom = 1;
  let pagePixelRatio = 1;
  let toolsBusy = null; // the busy state the tools pane last showed
  let shownTitle = null; // the document's own title, when it asks to be shown by it
  let pdfaClaim = null; // the PDF/A level the file claims, read when it opens or is converted
  let thumbnailObserver,
    searchGeneration = 0,
    pendingSearch = null,
    matchedQuery = '',
    searchResults = [], // pages with matches, in order: { page, count }
    activeMatch = -1; // index of the current match across the document
  // The cloud file as it was last read or written here: saving checks it is still that file.
  let remote = initialRemote;
  let cloudRevision = path ? session.revision : null,
    downloadedRevision = null,
    downloading = false,
    saveController = null,
    saveGeneration = 0;
  // Keep the decrypted working copy private; the authenticated role gates editor actions
  // and the original encryption follows every exported PDF until its owner changes it.
  let protection = initialProtection,
    protectionDirty = false,
    activity = null;
  const access = () => documentAccess(protection);
  const requireAccess = (...actions) => requireDocumentAccess(protection, ...actions);
  const toolPermission = (id) =>
    id === 'select' || id === 'hand'
      ? null
      : ['highlight', 'note', 'link', 'textbox', 'callout', 'cshape', 'pencil', 'measure'].includes(
            id,
          )
        ? 'annotate'
        : id === 'certsign'
          ? 'fill'
          : 'edit';
  let color = '#111111',
    stroke = 2,
    textSize = 16,
    textBold = false,
    textItalic = false,
    textUnderline = false,
    textStrikethrough = false;
  // Night reading: the page and its drafts are shown with inverted colors, remembered on
  // this device like the theme.
  const DARK_PAGES_KEY = 'pdf-editor:page-colors';
  let darkPages = (() => {
    try {
      return localStorage.getItem(DARK_PAGES_KEY) === 'dark';
    } catch {
      return false;
    }
  })();
  function setDarkPages(on) {
    darkPages = on;
    editorRoot.classList.toggle('dark-pages', on);
    try {
      if (on) localStorage.setItem(DARK_PAGES_KEY, 'dark');
      else localStorage.removeItem(DARK_PAGES_KEY);
    } catch {
      /* The preference is optional. */
    }
  }
  // Text and drawings share a color; highlights and notes keep their own.
  const toolColors = {
    mark: '#111111',
    highlight: '#f2c438',
    note: '#f2c438',
    comment: '#e5322d',
  };
  // Comments drawn as annotations: text boxes, callouts, shapes, and the pencil.
  const COMMENT_TOOLS = ['textbox', 'callout', 'cshape', 'pencil', 'measure'];
  // Freehand strokes, crops, and measurements have nothing to place at the page center.
  const UNPLACEABLE = ['ink', 'crop', 'pencil', 'measure'];
  let commentSize = 12;
  const colorGroup = () =>
    tool === 'highlight'
      ? 'highlight'
      : tool === 'note'
        ? 'note'
        : COMMENT_TOOLS.includes(tool)
          ? 'comment'
          : 'mark';
  let gesture = null;
  let committingDrawing = false;
  let editDocument,
    textEdit = null,
    finishingText = null,
    textCheckpoint = null,
    textPointer = null,
    textSelectionVersion = 0,
    textRuns = [];
  const textRunCache = new Map();
  const imageRunCache = new Map();
  /** Folded page text for find, extracted once per page and document revision. */
  const searchTextCache = new Map();
  let notes = [],
    noteEdit = null;
  let selectedHighlight = null,
    highlights = [],
    highlightSelection = null;
  const safe =
    (fn) =>
    async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        if (destroyed || P.isSignInCancelled(e)) return;
        toast(e.message || 'This action could not be completed.', { error: true });
      }
    };
  function permissionMenu(items) {
    return items.map((item) => {
      if (!item) return item;
      const permissions = item.permission ? [item.permission].flat() : [];
      return {
        ...item,
        disabled: item.disabled || permissions.some((key) => !access()[key]),
        ...(item.items && { items: permissionMenu(item.items) }),
        ...(permissions.length &&
          item.onSelect && {
            onSelect: safe(async (...args) => {
              requireAccess(...permissions);
              await item.onSelect(...args);
            }),
          }),
      };
    });
  }
  const openMenu = (options) => showMenu({ ...options, items: permissionMenu(options.items) });
  const nameButton = button(
    name.replace(/\.pdf$/i, ''),
    null,
    safe(async () => {
      if (saving || busy) return;
      const next = await promptText('Name this PDF', 'File name', name.replace(/\.pdf$/i, ''));
      const nextName = next && safeName(next);
      if (!nextName || nextName === name || destroyed) return;
      // A PDF in Puter belongs to the signed-in account; settle a pending account check first.
      // Its path is cleared if that account ended, and the PDF is then renamed here alone.
      if (path && !getUser()) await signIn();
      if (destroyed) return;
      if (path) {
        if (saving || busy || !getUser())
          throw new Error('The file could not be renamed right now. Try again in a moment.');
        // A PDF saved in Puter is renamed where it is, as the file manager would: saving it
        // under a new name used to leave the old file behind beside a second copy.
        saveGeneration++;
        saving = true;
        activity = 'Renaming…';
        updateStatus();
        const renaming = path;
        try {
          const item = P.fileInfo(await P.renameFile(renaming, nextName));
          if (destroyed || path !== renaming) return;
          path = item?.path || `${renaming.slice(0, renaming.lastIndexOf('/') + 1)}${nextName}`;
          name = item?.name || nextName;
          // A rename can stamp the file anew; its contents are still the ones this PDF knows.
          if (remote) {
            const renamed = item?.modified
              ? item
              : P.canStat() && (await P.statFile(path).catch(() => null));
            if (destroyed) return;
            remote = renamed ? { ...renamed, size: remote.size } : null;
          }
          toast(`Renamed to ${name}.`);
        } catch (error) {
          if (destroyed) return;
          const reason = error?.message || error?.error?.message;
          throw new Error(
            /exist/i.test(reason || '') || error?.code === 'item_with_same_name_exists'
              ? `A file named ${nextName} is already in that folder. Choose another name.`
              : `The file could not be renamed${reason ? `: ${reason.replace(/\.$/, '')}` : ''}.`,
          );
        } finally {
          activity = null;
          saving = false;
          if (!destroyed) updateStatus();
        }
        return;
      }
      saveGeneration++;
      name = nextName;
      path = null;
      remote = null;
      session.savedRevision = -1;
      updateStatus();
    }),
    'document-name',
    { title: name },
  );
  const saveStatus = el('span', { class: 'save-status' });
  const protectionBadge = button(
    'Protected',
    'Lock',
    safe(() => (access().owner ? securityDialog() : unlockOwner())),
    'protection-badge',
    { title: 'Protected. Change or remove the password and restrictions.', hidden: true },
  );
  /** A tooltip naming a command and its shortcut, as this platform writes it. */
  const withShortcut = (label, spec) => `${label} (${formatShortcut(spec)})`;
  const saveButton = button(
    'Save to Puter',
    'Cloud',
    safe(() => save()),
    'btn primary',
  );
  const undoButton = iconButton(
    'Undo',
    'Undo2',
    safe(() => history('undo')),
    {
      title: withShortcut('Undo', 'Mod+Z'),
    },
  );
  const redoButton = iconButton(
    'Redo',
    'Redo2',
    safe(() => history('redo')),
    {
      title: withShortcut('Redo', 'Mod+Shift+Z'),
    },
  );
  // Discard a pending object edit before a pointer click can blur its numeric
  // field and turn that draft into an unintended PDF transaction.
  undoButton.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && pageImages.dirty) e.preventDefault();
  });
  let pageInputDirty = false;
  const pageInput = el('input', {
    type: 'number',
    min: 1,
    value: 1,
    class: 'page-input',
    'aria-label': 'Page number',
    oninput: () => {
      pageInputDirty = true;
    },
    onchange: () => {
      if (pageInputDirty) commitPageInput();
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        // Enter is a choice even when the value matches the displayed page: it may
        // supersede a pending navigation. Native change only covers different values.
        e.preventDefault();
        commitPageInput();
      }
    },
    onblur: () => {
      if (pageInputDirty) commitPageInput();
      pageInput.value = String(pageIndex + 1);
    },
  });
  function commitPageInput() {
    pageInputDirty = false;
    // An emptied or unparsable field keeps the current page instead of jumping to page 1.
    const value = Number(pageInput.value);
    if (!pageInput.value.trim() || !Number.isFinite(value)) {
      pageInput.value = String(pageIndex + 1);
      return;
    }
    navigate(value - 1);
  }
  const pageTotal = el('span', { class: 'muted' });
  const prevButton = iconButton('Previous page', 'ChevronLeft', () => navigateBy(-1));
  const nextButton = iconButton('Next page', 'ChevronRight', () => navigateBy(1));
  /** The steps the zoom buttons, shortcuts, and wheel move through. */
  const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const zoomSelect = el(
    'select',
    {
      class: 'zoom-select',
      'aria-label': 'Zoom',
      onchange: safe((e) => setZoom(e.target.value)),
    },
    ...[
      ['fit', 'Fit width'],
      ['page', 'Fit page'],
      ['0.5', '50%'],
      ['0.75', '75%'],
      ['1', '100%'],
      ['1.25', '125%'],
      ['1.5', '150%'],
      ['2', '200%'],
      ['3', '300%'],
      ['4', '400%'],
    ].map(([value, label]) => el('option', { value }, label)),
  );
  /** Names a zoom reached with the buttons or the wheel that has no fixed menu entry. */
  const customZoomOption = el('option', { value: '', 'data-custom': 'true' });
  // The status bar keeps its compact line icons; the glass drawings are for commands.
  const zoomOutButton = iconButton(
    'Zoom out',
    icon('ZoomOut', 18, { plain: true }),
    safe(() => setZoom(zoomStep(-1))),
    { title: withShortcut('Zoom out', 'Mod+Minus') },
  );
  const zoomInButton = iconButton(
    'Zoom in',
    icon('ZoomIn', 18, { plain: true }),
    safe(() => setZoom(zoomStep(1))),
    { title: withShortcut('Zoom in', 'Mod+Plus') },
  );
  /** The zoom for the current scale mode, from the page's natural size and the workspace. */
  function computeZoom(natural, mode = scaleMode) {
    if (mode === 'fit' && (stack.continuous || stack.twoUp)) natural = stack.widest(natural);
    else if (mode === 'page' && stack.continuous) natural = stack.largest(natural);
    else if (mode === 'page' && stack.twoUp)
      natural = { width: natural.width * 2, height: natural.height };
    const width = workspace.clientWidth,
      height = workspace.clientHeight;
    // Room on both sides for the floating quick tools, so they never cover a fitted page; on
    // phones the tools sit in a row above the page instead.
    const gutter = window.matchMedia('(max-width: 760px)').matches || width < 400 ? 28 : 120;
    // Side by side, the 12px gap between the pages is not zoomed, and each page is sized in
    // whole pixels: an even width keeps two rounded halves from overflowing it.
    const room = stack.twoUp ? 2 * Math.floor((width - gutter - 12) / 2) : width - gutter;
    if (mode === 'fit') return Math.min(1.5, Math.max(0.15, room / natural.width));
    if (mode === 'page') {
      // The sheet shares the workspace height with its padding and the caption beneath it.
      const vertical = width < 600 ? 70 : 92;
      return Math.max(
        0.15,
        Math.min(3, room / natural.width, (height - vertical) / natural.height),
      );
    }
    return Number(mode);
  }
  /** Step from the requested zoom, including commands received while an edit settles. */
  function zoomStep(direction) {
    const requested = pendingZoom
      ? computeZoom(viewport.clone({ scale: 1 }), pendingZoom.mode)
      : zoom;
    const levels =
      direction > 0
        ? ZOOM_LEVELS.filter((level) => level > requested * 1.01)
        : ZOOM_LEVELS.filter((level) => level < requested / 1.01).reverse();
    return String(levels[0] ?? (direction > 0 ? ZOOM_LEVELS.at(-1) : ZOOM_LEVELS[0]));
  }
  /** Show the current scale mode in the menu, adding an entry for an unlisted zoom. */
  function syncZoomSelect() {
    const listed = [...zoomSelect.options].some(
      (option) => !option.dataset.custom && option.value === scaleMode,
    );
    if (listed) customZoomOption.remove();
    else {
      customZoomOption.value = scaleMode;
      customZoomOption.textContent = `${Math.round(Number(scaleMode) * 100)}%`;
      const larger = [...zoomSelect.options].find(
        (option) => !option.dataset.custom && Number(option.value) > Number(scaleMode),
      );
      zoomSelect.insertBefore(customZoomOption, larger || null);
    }
    zoomSelect.value = scaleMode;
  }
  /**
   * Change the zoom while keeping the page point under `anchor` (client coordinates; the
   * middle of the view by default) where it is, so zooming in on a spot keeps it in sight.
   */
  async function setZoom(mode, anchor = null) {
    if (!viewport || destroyed || mode === (pendingZoom?.mode ?? scaleMode)) return;
    // Claim the target before yielding. New commands supersede this request, even when
    // they return to the rendered scale while a draft or document reload is still pending.
    const request = (pendingZoom = { mode });
    try {
      // A display-only zoom can redraw the current PDF while an isolated edit is saving.
      // Wait only when the renderer is absent, history is queued, or a draft needs saving.
      if (
        !pdf ||
        pendingHistory ||
        textEdit ||
        noteEdit ||
        pageForms.draft.dirty ||
        pageImages.dirty
      )
        await idle();
      if (destroyed || pendingZoom !== request) return;
      await finishDrafts();
      if (destroyed || pendingZoom !== request) return;
      const view = workspace.getBoundingClientRect();
      const point = anchor || { x: view.left + view.width / 2, y: view.top + view.height / 2 };
      const before = paper.getBoundingClientRect();
      const fraction = [
        (point.x - before.left) / (before.width || 1),
        (point.y - before.top) / (before.height || 1),
      ];
      scaleMode = mode;
      await renderPage();
      if (destroyed || pendingZoom !== request || paper.hidden) return;
      const after = paper.getBoundingClientRect();
      workspace.scrollLeft += after.left + fraction[0] * after.width - point.x;
      workspace.scrollTop += after.top + fraction[1] * after.height - point.y;
      stack.quiet();
    } catch (error) {
      // A draft that cannot be committed keeps the current zoom, so the control must too.
      if (pendingZoom === request) syncZoomSelect();
      throw error;
    } finally {
      if (pendingZoom === request) pendingZoom = null;
    }
  }
  const thumbnails = el('div', {
    class: 'thumbnails',
    id: 'sidebar-panel-pages',
    role: 'tabpanel',
    'aria-labelledby': 'sidebar-tab-pages',
  });
  // The outline (bookmarks) shares the panel with the pages when the PDF has one.
  const outline = createOutlinePanel({
    onNavigate: (index) => {
      if (window.matchMedia('(max-width: 760px)').matches) hideSidebar();
      navigate(index);
    },
    onMenu: (entry, e) =>
      openMenu({
        anchor: entry.button,
        x: e.clientX,
        y: e.clientY,
        label: 'Bookmark',
        items: [
          {
            permission: 'assemble',
            label: 'Rename bookmark…',
            icon: 'Pencil',
            disabled: busy,
            onSelect: pageDialog(async () => {
              const title = await promptText('Rename bookmark', 'Bookmark name', entry.title);
              if (title == null || destroyed) return;
              await mutate(
                (doc) => renameBookmark(doc, entry.path, title),
                'Bookmark renamed.',
                'assemble',
              );
            }),
          },
          {
            permission: 'assemble',
            label: 'Remove bookmark',
            icon: 'Trash2',
            disabled: busy,
            onSelect: pageAction(() =>
              mutate((doc) => removeBookmark(doc, entry.path), 'Bookmark removed.', 'assemble'),
            ),
          },
        ],
      }),
  });
  outline.el.id = 'sidebar-panel-outline';
  outline.el.setAttribute('role', 'tabpanel');
  outline.el.setAttribute('aria-labelledby', 'sidebar-tab-outline');
  outline.el.hidden = true;
  // Every note and markup in the PDF, listed by page; choosing one opens or selects it.
  let revealComment = null;
  const comments = createCommentsPanel({
    onSelect: safe(async (comment) => {
      if (busy) return;
      // A narrow panel hides first, handing focus to the page that the comment opens on.
      if (window.matchMedia('(max-width: 760px)').matches) hideSidebar();
      const focusFrom = document.activeElement;
      // Saving the selected shared note detaches it from other pages and gives it a
      // new ID. Its position in this page's note list remains the same.
      const noteOrdinal =
        comment.page === pageIndex &&
        comment.reveal === 'note' &&
        noteEdit?.entry?.id === editorAnnotationId(comment.id)
          ? notes.indexOf(noteEdit.entry)
          : -1;
      await navigate(comment.page, {
        id: comment.id,
        // Text boxes, shapes, and other drawn comments are selected in their own layer.
        kind: comment.reveal || 'annotation',
        page: comment.page,
        rect: comment.rect,
        focusFrom,
        noteOrdinal,
      });
    }),
  });
  comments.el.id = 'sidebar-panel-comments';
  comments.el.setAttribute('role', 'tabpanel');
  comments.el.setAttribute('aria-labelledby', 'sidebar-tab-comments');
  comments.el.hidden = true;
  // Files carried in the PDF, with Save and Remove, and a way to attach another.
  const attachments = createAttachmentsPanel({
    canEdit: () => !!access().edit,
    onAdd: safe(() => attachFile()),
    onSave: safe(async (key, fileName) => {
      const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
      const bytes = attachmentBytes(doc, key);
      if (!bytes) throw new Error('This attachment could not be read.');
      download(bytes, fileName, 'application/octet-stream');
    }),
    onRemove: safe(async (key, fileName) => {
      requireAccess('edit');
      if (
        !(await confirmAction(
          'Remove attachment?',
          `Remove ${fileName} from this PDF? You can undo this while the PDF is open.`,
          'Remove',
        ))
      )
        return;
      await mutate((doc) => removeAttachment(doc, key) || false, `${fileName} removed.`);
    }),
  });
  attachments.el.id = 'sidebar-panel-attachments';
  attachments.el.setAttribute('role', 'tabpanel');
  attachments.el.setAttribute('aria-labelledby', 'sidebar-tab-attachments');
  attachments.el.hidden = true;
  function attachFile() {
    requireAccess('edit');
    const input = el('input', { type: 'file' });
    input.onchange = safe(async () => {
      const file = input.files?.[0];
      if (!file || destroyed) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await mutate(
        (doc) => addAttachment(doc, { name: file.name, bytes, mimeType: file.type || undefined }),
        `${file.name} attached.`,
      );
      if (!destroyed) showSidebarTab('attachments');
    });
    input.click();
  }
  // The PDF's layers; switching one changes the view of every page, not the file.
  let documentLayers = null;
  // The reader's own switches, by layer, carried over to the configuration each reload
  // of the PDF (after every edit) starts afresh from the file's defaults.
  const layerChoices = new Map();
  const layers = createLayersPanel({
    onToggle: safe(async (id, visible) => {
      layerChoices.set(id, visible);
      const config = await documentLayers;
      config?.setVisibility(id, visible);
      if (destroyed) return;
      await renderPage();
      stack.invalidate();
      renderThumbnails();
    }),
  });
  layers.el.id = 'sidebar-panel-layers';
  layers.el.setAttribute('role', 'tabpanel');
  layers.el.setAttribute('aria-labelledby', 'sidebar-tab-layers');
  layers.el.hidden = true;
  // Certificate signatures: their validity in a panel and in a bar above the pages.
  let signatureReports = [],
    signatureCheck = 0,
    signedEditAccepted = false;
  const digitalIds = []; // IDs opened or created in this tab, offered again when signing
  const signaturesPanel = createSignaturesPanel({
    onGoTo: (report) => navigate(report.page),
    onValidate: safe(() => validateSignatures(true)),
  });
  signaturesPanel.el.id = 'sidebar-panel-signatures';
  signaturesPanel.el.setAttribute('role', 'tabpanel');
  signaturesPanel.el.setAttribute('aria-labelledby', 'sidebar-tab-signatures');
  signaturesPanel.el.hidden = true;
  const signatureBar = createSignatureBar({
    onOpenPanel: safe(async () => {
      showSidebarTab('signatures');
      if (editorRoot.classList.contains('hide-pages')) await toggleSidebar(true);
    }),
  });
  // The accessibility check's report, in its own panel once a check has run.
  const accessibilityReport = createAccessibilityReport({
    onFix: (fix) => safe(() => fixAccessibility(fix))(),
    onGoTo: (page) => navigate(page),
  });
  accessibilityReport.el.id = 'sidebar-panel-accessibility';
  accessibilityReport.el.setAttribute('role', 'tabpanel');
  accessibilityReport.el.setAttribute('aria-labelledby', 'sidebar-tab-accessibility');
  accessibilityReport.el.hidden = true;
  // A file that claims PDF/A says so in a bar above the pages, as desktop editors do.
  const standardsText = el('span', { class: 'signature-bar-text' });
  const standardsBar = el(
    'div',
    { class: 'standards-bar tone-unknown', role: 'status', hidden: true },
    el('span', { class: 'signature-bar-icon', 'aria-hidden': 'true' }, icon('Info', 15)),
    standardsText,
    button('Check compliance', null, () => pageDialog(() => pdfaDialog('check'))(), 'text-btn'),
  );
  /** The bytes signatures cover: an encrypted file's own bytes until it is edited. */
  const signedBytes = () =>
    encryptedOriginal && session.revision === 0 ? encryptedOriginal : session.bytes;
  /**
   * Whether the file holds a signature value. Signature dictionaries are never compressed (their
   * byte ranges point into the file itself), so the key shows up in the raw bytes.
   */
  function hasSignatureValue(bytes) {
    const key = [47, 66, 121, 116, 101, 82, 97, 110, 103, 101]; // "/ByteRange"
    outer: for (let i = bytes.indexOf(47); i !== -1; i = bytes.indexOf(47, i + 1)) {
      for (let k = 1; k < key.length; k++) if (bytes[i + k] !== key[k]) continue outer;
      return true;
    }
    return false;
  }
  async function validateSignatures(announce = false) {
    const token = ++signatureCheck;
    const hasFields = hasSignatureValue(signedBytes());
    let reports = [];
    if (hasFields) {
      const { verifySignatures } = await import('./core/digital-signature.js');
      reports = await verifySignatures(signedBytes());
      if (token !== signatureCheck || destroyed) return;
    }
    signatureReports = reports;
    signaturesPanel.show(reports);
    signatureBar.show(reports);
    const tab = sidebarTabs.querySelector('[data-tab="signatures"]');
    tab.hidden = !hasFields;
    if (!hasFields && sidebarTab === 'signatures') showSidebarTab('pages');
    if (announce)
      toast(
        reports.length
          ? `${reports.length} ${reports.length === 1 ? 'signature' : 'signatures'} checked.`
          : 'This PDF has no certificate signatures.',
      );
  }
  /** Editing a signed PDF rewrites it, which invalidates its signatures; ask once first. */
  async function confirmSignedEdit() {
    if (signedEditAccepted || !signatureReports.some((report) => report.byteRange)) return true;
    const count = signatureReports.length;
    const ok = await confirmAction(
      'Edit a signed PDF?',
      `This PDF has ${count === 1 ? 'a certificate signature' : `${count} certificate signatures`}. Editing it here saves a new copy of the file, and every signature in it will show as invalid. Sign again after editing if the document needs a valid signature.`,
      'Edit anyway',
    );
    if (ok) signedEditAccepted = true;
    return ok;
  }
  let sidebarTab = 'pages';
  // The panel is narrow: the tabs are icons and the heading names the one that is open.
  const SIDEBAR_TABS = [
    ['pages', 'Pages', 'LayoutGrid'],
    ['outline', 'Outline', 'ListTree'],
    ['comments', 'Comments', 'MessageSquareText'],
    ['attachments', 'Attachments', 'Paperclip'],
    ['layers', 'Layers', 'Layers'],
    ['signatures', 'Signatures', 'signatures'],
    ['accessibility', 'Accessibility check', 'Accessibility'],
  ];
  const sidebarTitle = el('h2', {}, 'Pages');
  const commentsBadge = el('span', { class: 'tab-count', hidden: true });
  const visibleTabs = () =>
    [...sidebarTabs.querySelectorAll('[role="tab"]')].filter((tab) => !tab.hidden);
  const sidebarTabs = el(
    'div',
    {
      class: 'sidebar-tabs',
      role: 'tablist',
      'aria-label': 'Side panel',
      'aria-orientation': 'vertical',
    },
    ...SIDEBAR_TABS.map(([id, label, glyph]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'sidebar-tab',
          id: `sidebar-tab-${id}`,
          'data-tab': id,
          'aria-label': label,
          title: label,
          'aria-selected': String(id === sidebarTab),
          'aria-controls': `sidebar-panel-${id}`,
          tabindex: id === sidebarTab ? 0 : -1,
          // A tab in the rail opens its panel; the panel's own Close button hides it again.
          onclick: safe(async () => {
            showSidebarTab(id);
            if (editorRoot.classList.contains('hide-pages')) await toggleSidebar(true);
          }),
          // Up/Down (and Left/Right) step through the tabs, Home and End jump to the ends, as
          // the tabs pattern expects; the panel follows the focused tab.
          onkeydown: (e) => {
            const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
            if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
            // Home and End belong to the tabs, not to the document's first and last page.
            e.preventDefault();
            e.stopPropagation();
            const tabs = visibleTabs(),
              at = tabs.findIndex((tab) => tab.dataset.tab === id);
            const next =
              e.key === 'Home'
                ? tabs[0]
                : e.key === 'End'
                  ? tabs.at(-1)
                  : tabs[
                      (at +
                        (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) +
                        tabs.length) %
                        tabs.length
                    ];
            if (!next) return;
            showSidebarTab(next.dataset.tab);
            next.focus();
          },
        },
        icon(glyph, 16),
        id === 'comments' ? commentsBadge : null,
      ),
    ),
  );
  function showSidebarTab(id) {
    sidebarTab = id;
    thumbnails.hidden = id !== 'pages';
    outline.el.hidden = id !== 'outline';
    comments.el.hidden = id !== 'comments';
    attachments.el.hidden = id !== 'attachments';
    layers.el.hidden = id !== 'layers';
    signaturesPanel.el.hidden = id !== 'signatures';
    accessibilityReport.el.hidden = id !== 'accessibility';
    const title = SIDEBAR_TABS.find(([tab]) => tab === id)[1];
    sidebarTitle.textContent = title;
    // One landmark holds all three panels, so its name follows the tab that is open.
    sidebar.setAttribute('aria-label', `${title} panel`);
    sidebarTabs.querySelectorAll('[role="tab"]').forEach((tab) => {
      const on = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    if (id === 'pages') revealThumbnail();
    else if (id === 'outline') outline.setCurrent(pageIndex, { reveal: true });
  }
  // PDF.js names annotations "12R"; the editors use pdf-lib's "12 0 R".
  function editorAnnotationId(id) {
    const m = /^(\d+)R(\d*)$/.exec(id);
    return m ? `${m[1]} ${m[2] || 0} R` : id;
  }
  /** Open the note or select the markup a comment points to, once its page is rendered. */
  async function applyRevealComment() {
    const pending = revealComment;
    revealComment = null;
    if (!pending || pending.page !== pageIndex || tool !== 'select') return;
    await selectComment(pending);
    // The page opens at its top, or stays where it was scrolled; the comment itself can be
    // further down, or out to the side at a high zoom.
    if (pending.rect && !destroyed && pageIndex === pending.page && viewport) {
      const [x1, y1] = viewport.convertToViewportPoint(pending.rect[0], pending.rect[1]);
      const [x2, y2] = viewport.convertToViewportPoint(pending.rect[2], pending.rect[3]);
      const sheet = paper.getBoundingClientRect();
      revealBox({
        left: sheet.left + Math.min(x1, x2),
        right: sheet.left + Math.max(x1, x2),
        top: sheet.top + Math.min(y1, y2),
        bottom: sheet.top + Math.max(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
      stack.quiet();
    }
  }
  async function selectComment(pending) {
    const id = editorAnnotationId(pending.id);
    if (pending.kind === 'annotation') return annotationLayer.focus(id);
    const entry =
      pending.kind === 'note'
        ? notes.find((note) => note.id === id) || notes[pending.noteOrdinal]
        : highlights.find((highlight) => highlight.id === id);
    // A read-only markup has no edit controls on its page, so it is shown there, not selected.
    if (!entry || (pending.kind !== 'note' && entry.readOnly)) return;
    // Navigation or an earlier draft can take time. Keep a newer focus choice while
    // still selecting the requested comment. A draft may focus the overlay or rebuild
    // the comments list, restoring focus to the same comment's replacement button.
    const canFocus = () => {
      const active = document.activeElement;
      return (
        active === document.body ||
        active === overlay ||
        active === pending.focusFrom ||
        (comments.el.contains(active) &&
          editorAnnotationId(active.dataset.commentId || '') === entry.id &&
          active.dataset.commentPage === String(pending.page))
      );
    };
    if (pending.kind === 'note') {
      await openNoteEditor({ entry, canFocus });
    } else {
      pageImages.close();
      annotationLayer.clear();
      selectedHighlight = entry;
      renderHighlightTargets();
      if (canFocus())
        properties.root
          .querySelector('.highlight-edit-panel input')
          ?.focus({ preventScroll: true });
    }
  }
  // The navigation panels open beside the right-hand rail, as in desktop PDF editors.
  const sidebar = el(
    'aside',
    { id: 'page-sidebar', class: 'page-sidebar', 'aria-label': 'Pages panel' },
    el(
      'div',
      { class: 'sidebar-head' },
      sidebarTitle,
      iconButton('Close pages panel', 'X', () => toggleSidebar(false)),
    ),
    thumbnails,
    outline.el,
    comments.el,
    attachments.el,
    layers.el,
    signaturesPanel.el,
    accessibilityReport.el,
  );
  const canvas = el('canvas', { 'aria-hidden': 'true' });
  const textContainer = el('div', { class: 'textLayer' });
  const overlay = el('canvas', {
    class: 'drawing-overlay',
    tabindex: '0',
    'aria-label': 'PDF annotation surface. Use Place at page center for keyboard annotation.',
  });
  const textTargets = el('div', { class: 'text-targets', hidden: true });
  const highlightTargets = el('div', { class: 'highlight-targets' });
  const noteTargets = el('div', { class: 'note-targets' });
  // Links found on the page, as PDF.js reports them, shown as anchors in Select.
  const linkTargets = el('div', { class: 'link-targets' });
  let links = [];
  // The area drawn in crop mode stays until it is applied, redrawn, or dropped.
  let cropDraft = null;
  const pageForms = createFormLayer({
    onChange: () => updateStatus(),
    onCommit: safe(() => finishDrafts()),
  });
  const properties = createPropertiesPanel();
  // Comments drawn as annotations, selectable in Select.
  const annotationLayer = createAnnotationLayer({
    onSelect: (entry, { refresh = false } = {}) => {
      if (!entry || refresh) return showAnnotationProperties(entry);
      // Choosing a comment finishes drafts and lets go of a picture, shape, or markup, as
      // choosing any other object does. A draft that cannot be saved keeps the selection.
      safe(() =>
        selectionProperties(async () => {
          cancelTextSelection();
          try {
            await finishDrafts();
          } catch (error) {
            annotationLayer.clear();
            throw error;
          }
          pageImages.close();
          if (selectedHighlight) {
            selectedHighlight = null;
            renderHighlightTargets();
          }
          const chosen = annotationLayer.selected;
          if (chosen) showAnnotationProperties(chosen);
        }),
      )();
    },
    onMove: (entry, rect) =>
      safe(() =>
        mutate((doc) => editAnnotation(doc, pageIndex, entry.id, { rect }), null, 'annotate', {
          retainScale: true,
        }),
      )(),
    onDelete: (entry) => safe(() => removeAnnotation(entry))(),
  });
  // Prepare a form: the fields of the page as boxes to place, move, size, and open.
  let preparing = false,
    fieldType = 'text',
    formFields = [];
  const designer = createFormDesigner({
    onMove: (field, rect) =>
      safe(() =>
        mutate(
          async (doc) =>
            (await loadForms()).moveFormWidget(doc, field.name, field.widgetIndex, rect),
          null,
          'edit',
          {
            retainScale: true,
          },
        ),
      )(),
    onOpen: (field) => pageDialog(() => fieldPropertiesDialog(field))(),
    onDelete: (field) => safe(() => removeFormField(field))(),
  });
  function canFocusSelection(previous) {
    const active = document.activeElement;
    return active === document.body || active === overlay || active === previous;
  }
  function preserveSelectionLayout() {
    const release = properties.preserveLayout();
    return () => {
      release();
      syncStyleButtons();
      refitPage();
    };
  }
  async function selectionProperties(action) {
    const release = preserveSelectionLayout();
    try {
      return await action();
    } finally {
      release();
    }
  }
  const pageImages = createImageLayer({
    beginSelection: preserveSelectionLayout,
    canFocusSelection,
    onProperties: (panel, title) =>
      panel ? properties.show('object', title, panel) : properties.clear('object'),
    beforeSelect: async () => {
      cancelTextSelection();
      // A chosen picture or shape lets go of a selected comment, as other objects do.
      annotationLayer.clear();
      await finishDrafts(true);
      selectedHighlight = null;
      renderHighlightTargets();
    },
    onChange: () => updateStatus(),
    onCommit: (entry, change) =>
      mutate(
        (doc) =>
          change.replacement
            ? replaceImage(doc, pageIndex, entry, change.replacement, change.transform)
            : (entry.kind && entry.kind !== 'image' ? editPath : editImage)(
                doc,
                pageIndex,
                entry,
                change,
              ),
        null,
        'edit',
        { retainScale: !change.remove },
      ),
    preparePreview: prepareImagePreview,
  });
  // Hidden until the first page has its size: an unsized canvas would show as a small blank
  // rectangle while the document loads.
  const paper = el(
    'div',
    { class: 'paper', hidden: true },
    canvas,
    pageImages.preview,
    pageImages.targets,
    textContainer,
    overlay,
    textTargets,
    linkTargets,
    highlightTargets,
    noteTargets,
    annotationLayer.root,
    pageForms.root,
    designer.root,
    pageImages.controls,
  );
  const pageCaption = el('div', { class: 'page-caption' });
  const pageStackElement = el('div', { class: 'paper-wrap page-stack' }, paper, pageCaption);
  const workspace = el(
    'div',
    { class: 'workspace', role: 'region', tabindex: '0', 'aria-label': 'PDF page view' },
    pageStackElement,
  );
  // Every page in one scrolling column; the page being worked on holds the editing layers.
  const stack = createPageStack({
    workspace,
    container: pageStackElement,
    getPdf: () => pdf,
    getZoom: () => zoom,
    getRevision: () => session.revision,
    getLayers: () => documentLayers || undefined,
    currentIndex: () => pageIndex,
    canFollowScroll: () =>
      !busy &&
      !destroyed &&
      pageReady &&
      !pendingNavigation &&
      !textEdit &&
      !textPointer &&
      !noteEdit &&
      !gesture &&
      !cropDraft &&
      !selectedHighlight &&
      !pageImages.active &&
      !pageImages.dirty &&
      !pageImages.selected &&
      !pageForms.draft.dirty &&
      !paper.contains(document.activeElement),
    onScrollPage: (index) => navigate(index, null, { scroll: false }),
  });
  // Organize pages: a grid of every page that stands in for the document while it is open.
  const organizeActions = {
    rotate: (indices, delta) =>
      mutate((doc) => indices.forEach((i) => rotatePage(doc, i, delta)), null, 'assemble'),
    remove: (indices) => deletePages(indices),
    extract: (indices) => extractToDownload(indices),
    duplicate: (indices) =>
      mutate(
        async (doc) => {
          for (const i of [...indices].sort((a, b) => b - a)) {
            await duplicatePage(doc, i);
            if (i < pageIndex) pageIndex++;
          }
        },
        indices.length === 1 ? 'Page duplicated.' : `${indices.length} pages duplicated.`,
        'assemble',
      ),
    insertBlank: (after) =>
      mutate(
        (doc) => {
          insertBlankPage(doc, after);
          if (after < pageIndex) pageIndex++;
        },
        'Blank page inserted.',
        'assemble',
      ),
    insertFile: (after) => pageDialog((version) => mergeDialog(after, version))(),
    insertPictures: (after) => pageAction(() => insertPicturePages(after))(),
    move: (indices, to) => movePages(indices, to),
    open: (index) => {
      closeOrganizer();
      navigate(index);
    },
    close: () => closeOrganizer(),
  };
  const organizer = createOrganizeView({
    getPdf: () => pdf,
    getRevision: () => session.revision,
    currentIndex: () => pageIndex,
    can: (permission) => !!access()[permission],
    isBusy: () => busy,
    actions: organizeActions,
  });
  function openOrganizer() {
    if (!pdf) return;
    safe(async () => {
      await finishDrafts();
      editorRoot.classList.add('organizing');
      organizer.show();
    })();
  }
  function closeOrganizer() {
    if (!organizer.visible) return;
    const hadFocus = organizer.root.contains(document.activeElement);
    organizer.hide();
    editorRoot.classList.remove('organizing');
    if (toolsPanel.current === 'organize') toolsPanel.showAll();
    stack.scrollTo(pageIndex);
    stack.refresh();
    if (hadFocus) workspace.focus({ preventScroll: true });
    setTimeout(refitPage, 0);
  }
  // A press on another page makes it the current page before anything is done there.
  pageStackElement.addEventListener(
    'pointerdown',
    (e) => {
      const slot = e.target.closest?.('.page-slot');
      if (!slot || slot.contains(paper) || busy) return;
      const index = Number(slot.dataset.page);
      if (Number.isInteger(index) && index !== pageIndex) navigate(index, null, { scroll: false });
    },
    true,
  );
  const accessibleText = el('div', { class: 'sr-only', role: 'region', 'aria-label': 'Page text' });
  const hint = el(
    'span',
    { class: 'tool-hint' },
    'Click to select, drag to move, or double-click text to edit.',
  );
  const colorInput = el('input', {
    type: 'color',
    value: color,
    'aria-label': 'Annotation color',
    oninput: (e) => {
      color = e.target.value;
      toolColors[colorGroup()] = color;
      if (textEdit) {
        textEdit.hex = color;
        layoutTextEdit();
        updateStatus();
      }
    },
  });
  const widthInput = el(
    'select',
    {
      'aria-label': 'Stroke width',
      onchange: (e) => {
        stroke = Number(e.target.value);
      },
    },
    ...[1, 2, 4, 8].map((n) => el('option', { value: n, selected: n === 2 }, `${n} pt`)),
  );
  const sizeInput = el(
    'select',
    {
      'aria-label': 'Text size',
      onchange: (e) => {
        // Text comments keep their own size; the Text tool keeps its own.
        if (['textbox', 'callout'].includes(tool)) {
          commentSize = Number(e.target.value);
          return;
        }
        textSize = Number(e.target.value);
        if (textEdit) {
          textEdit.size = textSize / textEdit.physicalScale;
          layoutTextEdit();
          updateStatus();
        }
      },
    },
    ...[10, 12, 16, 20, 24, 32, 48].map((n) =>
      el('option', { value: n, selected: n === 16 }, `${n} pt`),
    ),
  );
  // PDF.js reports a face's weight and slant when the descriptor says so; the name is a
  // second witness, since embedded subsets often carry it in their base font name only.
  const isBoldRun = (run) =>
    /bold|[6-9]00/.test(String(run.fontWeight ?? '')) ||
    /bold|black|heavy|semibold/i.test(run.fontName || '');
  const isItalicRun = (run) =>
    run.fontStyle === 'italic' || /italic|oblique/i.test(run.fontName || '');
  const runStyle = (run, check) => {
    const parts = (run.parts || [run]).filter((part) => part.text);
    return parts.every(check) ? true : parts.some(check) ? null : false;
  };
  const decorationChanged = (edit) =>
    edit.underline !== Boolean(edit.run?.underline) ||
    edit.strikethrough !== Boolean(edit.run?.strikethrough);
  /** Whether a draft's bold or italic differs from what its text had. */
  const styleChanged = (edit) =>
    edit.run
      ? edit.bold !== edit.original.bold || edit.italic !== edit.original.italic
      : edit.bold || edit.italic;
  /** The face a draft is previewed and measured with; the text's own unless the style changed. */
  function draftFace(edit, run = edit.run) {
    const bold = edit.run && edit.bold === edit.original.bold ? isBoldRun(run) : edit.bold;
    const italic =
      edit.run && edit.italic === edit.original.italic ? isItalicRun(run) : edit.italic;
    const korean = koreanDraftFace(
      run,
      edit.input.value,
      !edit.run || styleChanged(edit) ? textVariant(bold, italic) : undefined,
    );
    if (korean) return korean;
    if (edit.run && !styleChanged(edit))
      return {
        weight: edit.run?.fontWeight || 'normal',
        style: edit.run?.fontStyle || 'normal',
        family: edit.run?.fontFamily || null,
        ligatures: edit.run?.fontVariantLigatures || 'normal',
      };
    return {
      weight: bold ? 'bold' : 'normal',
      style: italic ? 'italic' : 'normal',
      family: "'Noto Sans Styled'",
      ligatures: 'normal',
    };
  }
  function applyDraftStyle(edit) {
    if (hasKoreanText(edit.input.value))
      ensureKoreanFontFaces(edit.input.value).then(() => {
        if (textEdit === edit) layoutTextEdit();
      });
    const face = draftFace(edit);
    if (!edit.run || styleChanged(edit))
      Promise.all(
        (edit.run?.parts || [edit.run]).map((run) => {
          const face = draftFace(edit, run);
          return ensureStyledFontFaces(
            textVariant(face.weight === 'bold', face.style === 'italic'),
            edit.input.value,
          );
        }),
      ).then(() => {
        if (textEdit === edit) layoutTextEdit();
      });
    Object.assign(edit.input.style, {
      fontWeight: face.weight,
      fontStyle: face.style,
      fontVariantLigatures: face.ligatures,
      fontFamily: face.family ? `${face.family}, sans-serif` : 'Noto Sans, sans-serif',
    });
  }
  function syncStyleButtons() {
    // A selection handoff must not briefly hide and reopen the text toolbar;
    // even a one-pixel height change can clamp a workspace scrolled to the bottom.
    if (properties.switching && !textEdit) return;
    const edit = textEdit;
    boldButton.setAttribute(
      'aria-pressed',
      edit?.bold === null ? 'mixed' : String(edit ? edit.bold : textBold),
    );
    italicButton.setAttribute(
      'aria-pressed',
      edit?.italic === null ? 'mixed' : String(edit ? edit.italic : textItalic),
    );
    underlineButton.setAttribute('aria-pressed', String(edit ? edit.underline : textUnderline));
    strikethroughButton.setAttribute(
      'aria-pressed',
      String(edit ? edit.strikethrough : textStrikethrough),
    );
    const textOptions = tool === 'text' || !!edit;
    sizeInput.hidden =
      boldButton.hidden =
      italicButton.hidden =
      underlineButton.hidden =
      strikethroughButton.hidden =
        !textOptions;
    widthInput.hidden = !['shape', 'ink'].includes(tool);
    toolOptions.hidden = (tool === 'select' || tool === 'hand') && !edit;
    centerButton.hidden = !!edit || UNPLACEABLE.includes(tool);
    if (tool === 'select') colorInput.hidden = !edit;
  }
  function toggleTextStyle(key) {
    if (textEdit) textEdit[key] = !textEdit[key];
    // New text remembers the style for the next draft; an edited line keeps its own.
    if (!textEdit?.run) {
      if (key === 'bold') textBold = textEdit ? textEdit.bold : !textBold;
      else if (key === 'italic') textItalic = textEdit ? textEdit.italic : !textItalic;
      else if (key === 'underline') textUnderline = textEdit ? textEdit.underline : !textUnderline;
      else textStrikethrough = textEdit ? textEdit.strikethrough : !textStrikethrough;
    }
    syncStyleButtons();
    if (textEdit) {
      applyDraftStyle(textEdit);
      layoutTextEdit();
      updateStatus();
    }
  }
  const boldButton = iconButton('Bold', 'Bold', () => toggleTextStyle('bold'), {
    class: 'icon-btn style-toggle',
    'aria-pressed': 'false',
    hidden: true,
  });
  const italicButton = iconButton('Italic', 'Italic', () => toggleTextStyle('italic'), {
    class: 'icon-btn style-toggle',
    'aria-pressed': 'false',
    hidden: true,
  });
  const underlineButton = iconButton('Underline', 'Underline', () => toggleTextStyle('underline'), {
    class: 'icon-btn style-toggle',
    'aria-pressed': 'false',
    hidden: true,
  });
  const strikethroughButton = iconButton(
    'Strikethrough',
    'Strikethrough',
    () => toggleTextStyle('strikethrough'),
    {
      class: 'icon-btn style-toggle',
      'aria-pressed': 'false',
      hidden: true,
    },
  );
  const SHAPE_HINTS = {
    rectangle: 'Drag to draw a rectangle. Hold Shift for a square.',
    ellipse: 'Drag to draw an ellipse. Hold Shift for a circle.',
    line: 'Drag to draw a line. Hold Shift to snap to 45 degrees.',
    arrow: 'Drag from the tail to the tip of the arrow. Hold Shift to snap to 45 degrees.',
    check: 'Click to place a check mark, or drag to size it. Hold Shift for a square box.',
    cross: 'Click to place a cross, or drag to size it. Hold Shift for a square box.',
  };
  /** Marks placed with a click, in points. */
  const MARK_SIZE = 14;
  const shapeSelect = el(
    'select',
    {
      'aria-label': 'Shape type',
      hidden: true,
      onchange: () => {
        gesture = null;
        clearOverlay();
        if (tool === 'shape') hint.textContent = SHAPE_HINTS[shapeSelect.value];
      },
    },
    el('option', { value: 'rectangle' }, 'Rectangle'),
    el('option', { value: 'ellipse' }, 'Ellipse'),
    el('option', { value: 'line' }, 'Line'),
    el('option', { value: 'arrow' }, 'Arrow'),
    el('option', { value: 'check' }, 'Check mark'),
    el('option', { value: 'cross' }, 'Cross'),
  );
  const centerButton = button(
    'Place at page center',
    'Plus',
    safe(() => placeCentered()),
    'text-btn',
  );
  const cropMarginsButton = button(
    'Margins…',
    'Crop',
    safe(() => cropDialog()),
    'text-btn',
    {
      hidden: true,
    },
  );
  const cropDoneButton = button(
    'Done',
    'Check',
    safe(() => setTool('select')),
    'text-btn',
    {
      hidden: true,
    },
  );
  const highlightMode = el(
    'select',
    {
      'aria-label': 'Highlight mode',
      hidden: true,
      onchange: () => {
        gesture = null;
        clearOverlay();
        updateHighlightMode();
      },
    },
    el('option', { value: 'text' }, 'Text'),
    el('option', { value: 'area' }, 'Area'),
  );
  const highlightArea = () => highlightMode.value === 'area';
  const commentShape = el(
    'select',
    { 'aria-label': 'Comment shape', hidden: true },
    el('option', { value: 'square' }, 'Rectangle'),
    el('option', { value: 'circle' }, 'Oval'),
    el('option', { value: 'line' }, 'Line'),
    el('option', { value: 'arrow' }, 'Arrow'),
    el('option', { value: 'cloud' }, 'Cloud'),
  );
  // Measuring: a distance, a perimeter, or an area, in the units of a drawing scale.
  const measureScale = { unit: 'in', ratio: 1 };
  let measurePath = []; // points clicked so far for a perimeter or an area, in PDF space
  const measureMode = el(
    'select',
    {
      'aria-label': 'Measure',
      hidden: true,
      onchange: () => {
        measurePath = [];
        clearOverlay();
        hint.textContent = measureHint();
      },
    },
    el('option', { value: 'distance' }, 'Distance'),
    el('option', { value: 'perimeter' }, 'Perimeter'),
    el('option', { value: 'area' }, 'Area'),
  );
  const measureUnit = el(
    'select',
    {
      'aria-label': 'Measuring unit',
      hidden: true,
      onchange: () => (measureScale.unit = measureUnit.value),
    },
    ...Object.entries(MEASURE_UNITS).map(([key, unit]) =>
      el('option', { value: key, selected: key === measureScale.unit }, unit.label),
    ),
  );
  const measureRatio = el('input', {
    type: 'number',
    min: 0.0001,
    step: 'any',
    value: 1,
    hidden: true,
    'aria-label': 'Scale: one page unit stands for',
    title: 'Scale: one unit on the page stands for this many real units',
    onchange: () => {
      const value = Number(measureRatio.value);
      if (value > 0) measureScale.ratio = value;
      else measureRatio.value = measureScale.ratio;
    },
  });
  const measureHint = () =>
    measureMode.value === 'distance'
      ? 'Drag to measure a distance.'
      : `Click each corner of the ${measureMode.value === 'area' ? 'area' : 'path'}; double-click or press Enter to finish, Escape to start over.`;
  // Text markup: a highlight, an underline, or a strikethrough, each with its usual color.
  const MARKUP_COLORS = { highlight: '#f2c438', underline: '#2d9d5c', strikeout: '#dc3c3c' };
  const markupKind = el(
    'select',
    {
      'aria-label': 'Markup type',
      hidden: true,
      onchange: () => {
        color = toolColors.highlight = MARKUP_COLORS[markupKind.value];
        colorInput.value = color;
        labelMarkupButton();
        updateHighlightMode();
        toolsPanel.refresh();
      },
    },
    el('option', { value: 'highlight' }, 'Highlight'),
    el('option', { value: 'underline' }, 'Underline'),
    el('option', { value: 'strikeout' }, 'Strikethrough'),
    el('option', { value: 'redact', hidden: true }, 'Redaction'),
  );
  function labelMarkupButton() {
    const label = {
      highlight: 'Highlight selection',
      underline: 'Underline selection',
      strikeout: 'Strike through selection',
      redact: 'Mark selection for redaction',
    }[markupKind.value];
    highlightButton.querySelector('span').textContent = label;
    highlightButton.setAttribute('aria-label', label);
    highlightButton.title = label;
  }
  /** Choose the markup tool and its kind, as the comment tools do. */
  async function setMarkup(kind) {
    if (markupKind.value !== kind) {
      markupKind.value = kind;
      toolColors.highlight = MARKUP_COLORS[kind] || '#ff0000';
      labelMarkupButton();
    }
    await setTool('highlight');
  }
  // Redaction marks share the markup tool's text and area selection, and mark instead of
  // highlighting. These settings are what new marks look like once applied.
  const redactionStyle = { fill: '#000000', overlayText: '', repeat: false };
  const redacting = () => tool === 'highlight' && markupKind.value === 'redact';
  /** Rectangles [x1, y1, x2, y2] around the quads of a text selection. */
  const quadRects = (quads) =>
    quads.map((q) => {
      const xs = [q[0], q[2], q[4], q[6]],
        ys = [q[1], q[3], q[5], q[7]];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
  let redactionMarks = [];
  /** The marks waiting to be applied, read while the Redact tool is open. */
  async function refreshRedactionMarks() {
    if (toolsPanel.current !== 'redact' || !pdf) return;
    const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
    if (destroyed) return;
    redactionMarks = (await loadRedaction()).listRedactionMarks(doc);
    toolsPanel.refresh();
  }
  const highlightButton = button(
    'Highlight selection',
    'Highlighter',
    safe(() => applyHighlight()),
    'text-btn',
    { hidden: true, disabled: true },
  );
  // Toolbar clicks must retain the browser selection until its PDF coordinates are read.
  highlightButton.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (highlightCaptureTimer) measureHighlightSelection();
  });
  const toolOptions = el(
    'div',
    { class: 'tool-options', hidden: true },
    colorInput,
    widthInput,
    sizeInput,
    boldButton,
    italicButton,
    underlineButton,
    strikethroughButton,
    shapeSelect,
    commentShape,
    measureMode,
    measureUnit,
    measureRatio,
    markupKind,
    highlightMode,
    highlightButton,
    centerButton,
    cropMarginsButton,
    cropDoneButton,
  );
  const toolButtons = new Map();
  const toolDefs = [
    ['select', 'Select', 'MousePointer2'],
    ['hand', 'Hand', 'Hand'],
    ['text', 'Text', 'Type'],
    ['highlight', 'Highlight', 'Highlighter'],
    ['ink', 'Draw', 'Pencil'],
    ['shape', 'Shape', 'Square'],
    ['note', 'Note', 'StickyNote'],
  ];
  const toolGroup = el(
    'div',
    { class: 'tool-group', role: 'group', 'aria-label': 'Annotation tools' },
    ...toolDefs.map(([id, label, glyph]) => {
      const b = button(
        label,
        glyph,
        safe(() => setTool(id)),
        'tool-btn',
        {
          'aria-pressed': id === tool,
          'data-permission': toolPermission(id),
          'data-tool': id,
        },
      );
      toolButtons.set(id, b);
      return b;
    }),
  );
  const searchInput = el('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Find text or tools',
    'aria-label': 'Find in PDF',
  });
  const searchCount = el('span', { class: 'search-count', role: 'status' });
  let searchTimer;
  searchInput.addEventListener('input', () => {
    scheduleSearch(250, true);
    suggestTools();
  });
  // Typing a tool's name in the find box offers the tool too, beside the matches in the PDF.
  const toolSuggestions = el('div', {
    class: 'find-tool-suggestions',
    role: 'group',
    'aria-label': 'Matching tools',
    hidden: true,
  });
  function suggestTools() {
    const query = searchInput.value.trim().toLowerCase();
    const matches =
      query.length < 2
        ? []
        : toolCatalog()
            .filter(
              (entry) =>
                !entry.hidden &&
                `${entry.label} ${entry.keywords || ''} ${entry.description || ''}`
                  .toLowerCase()
                  .includes(query),
            )
            .slice(0, 5);
    toolSuggestions.hidden = !matches.length;
    toolSuggestions.replaceChildren(
      ...(matches.length ? [el('div', { class: 'find-tool-heading' }, 'Tools')] : []),
      ...matches.map((entry) =>
        el(
          'button',
          {
            type: 'button',
            class: 'find-tool-item',
            'aria-label': `Open tool: ${entry.label}`,
            onclick: safe(async () => {
              closeSearch();
              if (entry.run && !entry.sections) return toolsPanel.open(entry.id);
              toolsPanel.open(entry.id);
              if (editorRoot.classList.contains('hide-tools')) await toggleToolsPanel(true);
            }),
          },
          toolIcon(entry.icon || entry.id, 18),
          el('span', {}, entry.label),
        ),
      ),
    );
  }
  searchInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Escape closes the find bar and nothing else: the window handler would otherwise also
      // leave Crop or Link mode, discard a drawn crop area, or close a markup editor.
      e.stopPropagation();
      closeSearch();
    }
  });
  function closeSearch() {
    searchBar.hidden = true;
    toolSuggestions.hidden = true;
    searchInput.value = '';
    resetSearch();
    workspace.focus();
  }
  const searchBar = el(
    'div',
    { class: 'find-bar', hidden: true },
    icon('Search', 17),
    searchInput,
    searchCount,
    iconButton('Previous match', 'ChevronLeft', () => jumpMatch(-1)),
    iconButton('Next match', 'ChevronRight', () => jumpMatch(1)),
    iconButton('Close search', 'X', closeSearch),
    toolSuggestions,
  );
  const statusPage = el('span');
  const pagesButton = iconButton('Toggle pages panel', 'PanelRight', () => toggleSidebar(), {
    'aria-controls': 'page-sidebar',
    'aria-expanded': 'true',
  });
  // The menu bar sits in the title bar, where a desktop PDF editor's window keeps its menus.
  const menubar = createMenubar(
    [
      { label: 'File', open: openFileMenu },
      { label: 'Edit', open: openEditMenu },
      { label: 'View', open: openViewMenu },
      { label: 'Page', open: openPageMenu },
      { label: 'Insert', open: openInsertMenu },
    ],
    { label: 'PDF menus' },
  );
  // On a phone the menus fold into one button; its File menu ends with the others.
  const menuButton = iconButton(
    'Menu',
    'EllipsisVertical',
    (e) => openFileMenu(e.currentTarget, true),
    { class: 'icon-btn mobile-only', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
  );
  // The tools pane on the left lists every tool, then holds the chosen tool's commands.
  const toolsPanel = createToolsPanel({
    catalog: () => toolCatalog(),
    can: (permission) => !!access()[permission],
    onClose: () => toggleToolsPanel(false),
    onChange: () => syncTopTabs(),
    // Where the pane overlays the document, it steps aside once a command needs the page.
    onAct: () => {
      if (window.matchMedia('(max-width: 1000px)').matches) toggleToolsPanel(false);
    },
  });
  const toolsPane = el(
    'aside',
    { id: 'tools-pane', class: 'tools-pane', 'aria-label': 'Tools' },
    toolsPanel.root,
  );
  /** The tabs across the top open the most used tools, as in a desktop PDF editor. */
  const TOP_TABS = [
    ['all', 'Tools'],
    ['edit', 'Edit'],
    ['comment', 'Comment'],
    ['export', 'Export'],
    ['fill-sign', 'Fill & Sign'],
  ];
  const topTabs = el(
    'nav',
    { class: 'top-tabs', 'aria-label': 'Tool sets' },
    ...TOP_TABS.map(([id, label]) =>
      el(
        'button',
        {
          type: 'button',
          class: 'top-tab',
          'data-tool': id,
          'aria-pressed': 'false',
          onclick: safe(() => openToolSet(id)),
        },
        label,
      ),
    ),
  );
  function syncTopTabs() {
    const shown = !editorRoot.classList.contains('hide-tools');
    const current = toolsPanel.current || 'all';
    let chosen = null;
    topTabs.querySelectorAll('.top-tab').forEach((tab) => {
      const pressed = shown && tab.dataset.tool === current;
      if (pressed && tab.getAttribute('aria-pressed') !== 'true') chosen = tab;
      tab.setAttribute('aria-pressed', String(pressed));
    });
    // Measured once pressed, as the chosen tab's bolder label is wider.
    if (chosen) revealTab(chosen);
  }
  // Where the tool sets do not fit (a phone), they scroll sideways. A fade marks each side
  // with more tabs, and the chosen tab is brought clear of the fade.
  function markTabOverflow() {
    const { scrollLeft, scrollWidth, clientWidth } = topTabs;
    topTabs.classList.toggle('more-start', scrollLeft > 1);
    topTabs.classList.toggle('more-end', scrollLeft + clientWidth < scrollWidth - 1);
  }
  function revealTab(tab) {
    if (topTabs.scrollWidth <= topTabs.clientWidth) return;
    const bar = topTabs.getBoundingClientRect(),
      box = tab.getBoundingClientRect(),
      fade = 24;
    if (box.left < bar.left + fade) topTabs.scrollLeft -= bar.left + fade - box.left;
    else if (box.right > bar.right - fade) topTabs.scrollLeft += box.right - (bar.right - fade);
  }
  topTabs.addEventListener('scroll', markTabOverflow, { passive: true });
  const tabsObserver = new ResizeObserver(markTabOverflow);
  tabsObserver.observe(topTabs);
  /** Show the tools pane with a tool, or with the list of every tool. */
  async function openToolSet(id) {
    const shown = !editorRoot.classList.contains('hide-tools');
    // Where the pane overlays the page it steps aside while a tool is in use; Tools brings it
    // back with that tool rather than leaving it.
    const resume = !shown && toolsPanel.current && window.matchMedia('(max-width: 1000px)').matches;
    if (id === 'all' && resume) {
      await toggleToolsPanel(true);
      return;
    }
    if (id === 'all') toolsPanel.showAll();
    else toolsPanel.open(id);
    if (!shown) await toggleToolsPanel(true);
    syncTopTabs();
  }
  async function toggleToolsPanel(show = editorRoot.classList.contains('hide-tools')) {
    const hadFocus = toolsPane.contains(document.activeElement);
    editorRoot.classList.toggle('hide-tools', !show);
    if (!show && hadFocus) workspace.focus({ preventScroll: true });
    syncTopTabs();
    snapPaper();
    setTimeout(refitPage, 0);
  }
  const findToolsButton = el(
    'button',
    {
      type: 'button',
      class: 'find-tools',
      'aria-label': 'Find text or tools',
      title: withShortcut('Find text or tools', 'Mod+F'),
      onclick: () => openSearch(),
    },
    el('span', {}, 'Find text or tools'),
    icon('Search', 17),
  );
  // The quick tools are one stop in the tab order, as a toolbar is: the arrow keys move
  // between them and Home and End go to the ends. The stop stays on the last one used.
  let toolbarStop = null;
  const toolbarKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
  const quickTools = el(
    'div',
    {
      class: 'toolbar quick-tools',
      role: 'toolbar',
      'aria-label': 'PDF tools',
      onfocusin: (e) => {
        if (!(e.target instanceof HTMLButtonElement)) return;
        toolbarStop = e.target;
        syncToolbarStop();
      },
      onkeydown: (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !toolbarKeys.includes(e.key))
          return;
        const buttons = [...quickTools.querySelectorAll('button')].filter(
          (b) => !b.disabled && b.getClientRects().length,
        );
        const at = buttons.indexOf(document.activeElement);
        if (at === -1) return;
        // Home and End are the toolbar's here, not the document's first and last page.
        e.preventDefault();
        e.stopPropagation();
        const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
        const next =
          e.key === 'Home'
            ? buttons[0]
            : e.key === 'End'
              ? buttons.at(-1)
              : buttons[(at + step + buttons.length) % buttons.length];
        next.focus();
      },
    },
    toolGroup,
    el(
      'div',
      { class: 'tool-group' },
      button('Image', 'Image', safe(insertImage), 'tool-btn', {
        'data-permission': 'edit',
      }),
      button('Sign', 'Signature', safe(insertSignature), 'tool-btn', {
        'data-permission': 'edit',
      }),
      button('Fill forms', 'ListChecks', safe(formDialog), 'tool-btn', {
        'data-permission': 'fill',
      }),
    ),
  );
  /** Keep the toolbar's tab stop on a button that can take it. */
  function syncToolbarStop() {
    const buttons = [...quickTools.querySelectorAll('button')];
    // While busy every button is briefly disabled; the stop waits for them rather than moving.
    if (!toolbarStop || (toolbarStop.disabled && !busy)) {
      const usable = (b) => !b.disabled && b.getClientRects().length > 0;
      const pressed = (b) => b.getAttribute('aria-pressed') === 'true';
      // Before the toolbar is laid out nothing is usable yet; it must still keep a stop.
      toolbarStop =
        buttons.find((b) => pressed(b) && usable(b)) ||
        buttons.find(usable) ||
        toolbarStop ||
        buttons.find(pressed) ||
        buttons[0];
    }
    for (const b of buttons) {
      const index = b === toolbarStop ? 0 : -1;
      if (b.tabIndex !== index) b.tabIndex = index;
    }
  }
  const editorRoot = el(
    'div',
    { class: darkPages ? 'editor dark-pages' : 'editor', 'data-tool': tool },
    // One banner over the page: the title bar with the menus and the document, the tool sets
    // and file commands, and the find bar. Kept together so no control sits outside a
    // landmark for anyone browsing by region.
    el(
      'header',
      { class: 'editor-header' },
      el(
        'div',
        { class: 'topbar editor-topbar' },
        el(
          'div',
          { class: 'topbar-row' },
          iconButton('Back to your PDFs', 'House', goHome, { class: 'icon-btn home-btn' }),
          menubar.el,
          el(
            'div',
            { class: 'document-tab' },
            el('span', { class: 'editor-brand' }, appIcon(18, 'PDF Editor')),
            el(
              'div',
              { class: 'document-info' },
              el('h1', { class: 'document-title' }, nameButton),
              el('div', { class: 'status-row' }, saveStatus, protectionBadge),
            ),
          ),
          el(
            'div',
            { class: 'header-right' },
            menuButton,
            iconButton('Settings', 'Settings2', settings),
          ),
        ),
      ),
      el(
        'div',
        { class: 'appbar' },
        topTabs,
        el(
          'div',
          { class: 'appbar-end' },
          findToolsButton,
          el('span', { class: 'appbar-sep', 'aria-hidden': 'true' }),
          undoButton,
          redoButton,
          el('span', { class: 'appbar-sep', 'aria-hidden': 'true' }),
          iconButton(
            'Download',
            'Download',
            safe(() => downloadPdf()),
            {
              class: 'icon-btn download-btn',
              // On the Puter desktop the shortcut saves to another folder instead.
              ...(!P.isApp() && { title: withShortcut('Download', 'Mod+Shift+S') }),
            },
          ),
          iconButton(
            'Print file',
            'Printer',
            () => {
              if (!busy) pageDialog(printDialog)();
            },
            {
              class: 'icon-btn print-btn',
              'data-permission': 'print',
              title: withShortcut('Print file', 'Mod+P'),
            },
          ),
          saveButton,
        ),
      ),
      pageForms.error,
    ),
    el(
      'main',
      { id: 'main', class: 'editor-main', tabindex: '-1' },
      toolsPane,
      properties.root,
      el(
        'div',
        { class: 'document-area' },
        el('div', { class: 'contextbar' }, hint, toolOptions),
        searchBar,
        signatureBar.el,
        standardsBar,
        el(
          'div',
          { class: 'document-view' },
          quickTools,
          workspace,
          organizer.root,
          el(
            'div',
            { class: 'page-controls statusbar' },
            el('div', { class: 'page-navigation' }, prevButton, pageInput, pageTotal, nextButton),
            el(
              'div',
              { class: 'zoom-controls', role: 'group', 'aria-label': 'Zoom controls' },
              zoomOutButton,
              zoomSelect,
              zoomInButton,
            ),
          ),
        ),
      ),
      // The rail comes first in the keyboard order, so a tab leads straight into its panel.
      el('nav', { class: 'right-rail', 'aria-label': 'Panels' }, sidebarTabs, pagesButton),
      sidebar,
      accessibleText,
    ),
  );
  root.replaceChildren(editorRoot);
  const printNotice = el('p', { class: 'print-permissions-message' });
  document.body.append(printNotice);
  const restrictCopy = (event) => {
    if (
      access().copy ||
      destroyed ||
      event.target === searchInput ||
      ['owner-password', 'unlock-password'].includes(event.target?.id)
    )
      return;
    event.preventDefault();
    if (event.type !== 'dragstart')
      toast('Copying is not allowed by this PDF’s permissions.', { error: true });
  };
  document.addEventListener('copy', restrictCopy);
  document.addEventListener('cut', restrictCopy);
  document.addEventListener('dragstart', restrictCopy);
  editorRoot.addEventListener('contextmenu', (event) => {
    if (!access().copy && event.target.matches('canvas, img')) event.preventDefault();
  });
  function pendingTextEdit() {
    return Boolean(
      textEdit &&
      (textEdit.positionControl?.pending ||
        textEdit.widthControl?.pending ||
        textEdit.input.value !== (textEdit.run?.text || '') ||
        (textEdit.run?.parts &&
          JSON.stringify(textEdit.input.segments()) !== JSON.stringify(textEdit.run.segments)) ||
        (textEdit.run &&
          (styleChanged(textEdit) ||
            decorationChanged(textEdit) ||
            Math.abs(textEdit.size - textEdit.run.state.size) > 1e-8 ||
            textEdit.hex !== textColor(textEdit.run) ||
            Math.abs((textEdit.width || 0) - (textEdit.originalWidth || 0)) > 1e-8 ||
            textEdit.offset.some((n) => Math.abs(n) > 1e-8)))),
    );
  }
  function updateStatus() {
    if (destroyed) return;
    // A brief refresh must still block duplicate actions, without flashing every control
    // gray. Keep each button's resting appearance until the new page is ready; buttons
    // already unavailable (such as Redo with no history) retain their disabled appearance.
    const refreshing = !initializing && (busy || !pageReady);
    if (refreshing !== editorRoot.classList.contains('refreshing')) {
      editorRoot
        .querySelectorAll(
          '.editor-header button, .statusbar button, .quick-tools button, .right-rail button',
        )
        .forEach((button) => {
          button.classList.toggle('busy-enabled', refreshing && !button.disabled);
        });
      editorRoot.classList.toggle('refreshing', refreshing);
    }
    editorRoot.querySelectorAll('.toolbar button').forEach((b) => {
      b.disabled = busy || (b.dataset.permission && !access()[b.dataset.permission]);
    });
    syncToolbarStop();
    editorRoot.querySelector('.download-btn').disabled = busy || downloading;
    editorRoot.querySelector('.print-btn').disabled = busy || !access().print;
    textTargets.querySelectorAll('button').forEach((button) => {
      button.disabled = busy || !pageReady;
    });
    zoomInButton.disabled = busy || !pdf || zoom >= ZOOM_LEVELS.at(-1) - 1e-9;
    zoomOutButton.disabled = busy || !pdf || zoom <= ZOOM_LEVELS[0] + 1e-9;
    nameButton.querySelector('span').textContent = name.replace(/\.pdf$/i, '');
    nameButton.setAttribute('aria-label', `Rename ${name}`);
    // The name is clipped on narrow screens, so the tooltip carries it in full.
    nameButton.title = name;
    pageForms.setBusy(busy || !pageReady || !access().fill);
    pageImages.setBusy(busy || !pageReady || !access().edit);
    const pendingText =
      pendingTextEdit() || pendingNoteEdit() || pageForms.draft.dirty || pageImages.dirty;
    const unsaved = session.dirty || pendingText || protectionDirty;
    document.title = `${unsaved ? '* ' : ''}${shownTitle || name} · PDF Editor`;
    // The desktop window shows the file, marked while it has unsaved changes, as its neighbours do.
    P.setWindowTitle(`${unsaved ? '● ' : ''}${name}`);
    protectionBadge.hidden = !protection;
    if (tool === 'select' && !access().owner)
      hint.textContent =
        'This PDF has document permissions. Select Protected to view them or unlock editing.';
    protectionBadge.disabled = busy;
    protectionBadge.title = access().owner
      ? 'Protected. Change or remove the password and restrictions.'
      : 'View permissions or unlock editing with the permissions password.';
    document.body.classList.toggle('pdf-restricted-print', !access().printHighQuality);
    printNotice.textContent = access().print
      ? 'Use File → Print in PDF Editor to print this document at its allowed resolution.'
      : 'Printing is not allowed by this PDF’s permissions.';
    saveStatus.textContent = activity
      ? activity
      : saving
        ? 'Saving…'
        : initializing
          ? 'Opening PDF…'
          : unsaved
            ? 'Unsaved changes'
            : path && cloudRevision === session.revision
              ? 'Saved to Puter'
              : downloadedRevision === session.revision
                ? 'Downloaded'
                : 'Local file';
    saveStatus.title = saveStatus.textContent;
    saveButton.disabled = saving || busy;
    // Without a session the button says what saving needs first.
    const saveLabel = signedOut() ? 'Sign in to save' : path ? 'Save' : 'Save to Puter';
    saveButton.querySelector('span').textContent = saveLabel;
    saveButton.setAttribute('aria-label', saveLabel);
    saveButton.title = withShortcut(saveLabel, 'Mod+S');
    nameButton.disabled = busy || saving;
    centerButton.disabled = busy || !pageReady;
    highlightButton.disabled = busy || !pageReady || !(highlightSelection || highlightCaptureTimer);
    const markupDisabled = busy || !pageReady || !access().annotate;
    const setMarkupDisabled = (control) => {
      control.disabled = markupDisabled;
    };
    highlightTargets.querySelectorAll('button').forEach(setMarkupDisabled);
    properties.root.querySelectorAll('[data-markup-mutation]').forEach(setMarkupDisabled);
    undoButton.disabled =
      busy || (!session.past.length && !pendingText && !pageForms.draft.past.length);
    redoButton.disabled =
      busy ||
      pendingTextEdit() ||
      pendingNoteEdit() ||
      pageImages.dirty ||
      (!pageForms.draft.future.length && (pageForms.draft.dirty || !session.future.length));
    if (pdf) {
      if (!pageInputDirty) pageInput.value = String(pageIndex + 1);
      pageInput.max = String(pdf.numPages);
      pageTotal.textContent = `/ ${pdf.numPages}`;
      statusPage.textContent = `${pdf.numPages} ${pdf.numPages === 1 ? 'page' : 'pages'}`;
    }
    const destination = clampPageIndex(pendingNavigation?.index ?? pageIndex);
    prevButton.disabled = !pageCount || destination === 0;
    nextButton.disabled = !pageCount || destination >= pageCount - 1;
    editorRoot.setAttribute('aria-busy', String(busy));
    if (organizer.visible && organizer.busy !== busy) organizer.updateState();
    // The tools pane's commands follow the busy state; redraw only when it changes.
    if (toolsBusy !== busy) {
      toolsBusy = busy;
      toolsPanel.refresh();
    }
  }
  async function reload(retainedScale = null) {
    if (destroyed) return;
    const token = ++generation;
    editDocument = null;
    textRunCache.clear();
    imageRunCache.clear();
    searchTextCache.clear();
    resetSearch();
    pageRenderGeneration++;
    pageReady = false;
    pageImages.close(true, { preservePreview: true, preserveControls: true });
    gesture = null;
    discardCropDraft();
    if (!committingDrawing) clearOverlay();
    renderTask?.cancel();
    textLayer?.cancel();
    thumbnailObserver?.disconnect();
    // PDF.js removes its FontFaces when the old document is destroyed. A committing
    // draft still needs those faces until its replacement is painted; retaining just
    // the loaded faces avoids keeping the old PDF and its decoded images alive.
    const family = (name) => name.trim().replace(/^["']|["']$/g, '');
    const families = new Set(
      [...paper.querySelectorAll('.page-text-input, .page-text-input [data-part]')].flatMap(
        (node) => getComputedStyle(node).fontFamily.split(',').map(family),
      ),
    );
    const draftFonts = families.size
      ? [...document.fonts].filter((face) => families.has(family(face.family)))
      : [];
    const old = loadingTask;
    documentLayers = null;
    pdf = null;
    currentPage = null;
    loadingTask = null;
    await old?.destroy();
    const retainedFonts = draftFonts.filter((face) => !document.fonts.has(face));
    retainedFonts.forEach((face) => document.fonts.add(face));
    try {
      if (destroyed || token !== generation) return;
      const task = loadPdf(session.bytes.slice());
      loadingTask = task;
      const next = await task.promise;
      if (destroyed || token !== generation) {
        await task.destroy();
        return;
      }
      pdf = next;
      // One layer configuration per document, shared by every picture of its pages, so the
      // Layers panel's switches apply everywhere.
      documentLayers = next.getOptionalContentConfig({ intent: 'display' }).then((config) => {
        for (const [id, visible] of layerChoices)
          if (config.getGroup(id)) config.setVisibility(id, visible);
        return config;
      });
      // Keep the count available while the renderer is replaced after an edit, so
      // navigation requests can still be bounded against the displayed document.
      pageCount = pdf.numPages;
      pageIndex = Math.min(pageIndex, pdf.numPages - 1);
      const rebuilt = stack.count !== pageCount;
      if (rebuilt) stack.rebuild(pageCount);
      stack.loadSizes(next);
      renderThumbnails();
      toolsPanel.refresh();
      organizer.refresh();
      refreshRedactionMarks().catch(() => {});
      const isCurrent = () => !destroyed && pdf === next;
      outline.load(next, { isCurrent }).then((hasOutline) => {
        if (destroyed || pdf !== next) return;
        sidebarTabs.querySelector('[data-tab="outline"]').hidden = !hasOutline;
        if (!hasOutline && sidebarTab === 'outline') showSidebarTab('pages');
        if (hasOutline) outline.setCurrent(pageIndex);
      });
      attachments.load(next, { isCurrent });
      validateSignatures().catch(() => {});
      documentLayers
        .then((config) => {
          if (destroyed || pdf !== next) return;
          const any = layers.show(config);
          sidebarTabs.querySelector('[data-tab="layers"]').hidden = !any;
          if (!any && sidebarTab === 'layers') showSidebarTab('pages');
        })
        .catch(() => {});
      comments.load(next, { isCurrent }).then((result) => {
        if (destroyed || pdf !== next || !result) return;
        const { total, capped } = result;
        commentsBadge.textContent = total > 99 ? '99+' : String(total);
        commentsBadge.hidden = !total;
        // The badge is decorative, so its number is spelled into the tab's own name. A PDF with
        // more comments than the list holds is counted as "and more", not as that number.
        const commentsTab = sidebarTabs.querySelector('[data-tab="comments"]');
        const shown = capped ? `${total.toLocaleString()} or more` : String(total);
        const commentsLabel = total ? `Comments (${shown})` : 'Comments';
        commentsTab.setAttribute('aria-label', commentsLabel);
        commentsTab.setAttribute('title', commentsLabel);
      });
      updateStatus();
      await renderPage(retainedScale);
      // Pages added or removed move the others; the current page comes back into view.
      if (rebuilt && !destroyed && pdf === next) stack.scrollTo(pageIndex);
      if (!destroyed && pdf === next) stack.refresh();
      if (searchInput.value.trim()) scheduleSearch();
    } finally {
      // The draft is removed by finishTextEdit in this same microtask turn.
      retainedFonts.forEach((face) => document.fonts.delete(face));
    }
  }
  /**
   * Centering leaves the page at a half device pixel whenever the spare width is odd, which
   * blurs the rendered canvas and the text drafts drawn over it. Nudge it onto whole pixels.
   */
  function snapPaper() {
    if (paper.hidden) return;
    paper.style.left = '0px';
    const ratio = window.devicePixelRatio || 1;
    const left = paper.getBoundingClientRect().left;
    const shift = Math.round(left * ratio) / ratio - left;
    if (Math.abs(shift) > 1e-6) paper.style.left = `${shift}px`;
  }
  let pageRenderGeneration = 0;
  async function renderPage(retainedScale = null) {
    if (!pdf || destroyed) return;
    const token = ++pageRenderGeneration;
    pageReady = false;
    textTargets.replaceChildren();
    clearHighlightSelection();
    selectedHighlight = null;
    highlightTargets.replaceChildren();
    properties.clear('highlight');
    closeNoteEditor();
    noteTargets.replaceChildren();
    gesture = null;
    discardCropDraft();
    if (!committingDrawing) clearOverlay();
    paper.setAttribute('aria-busy', 'true');
    updateStatus();
    renderTask?.cancel();
    textLayer?.cancel();
    const rendered = el('canvas');
    try {
      const page = await pdf.getPage(pageIndex + 1);
      if (token !== pageRenderGeneration || destroyed) return;
      // The page left behind releases its decoded pictures (see the thumbnails).
      if (currentPage && currentPage !== page) currentPage.cleanup();
      currentPage = page;
      const natural = page.getViewport({ scale: 1 });
      // An object's properties dock must not refit the page when its edit redraws it.
      // Preserve the selection's scale until deselection; newer zoom/page choices still win.
      const keepScale =
        retainedScale &&
        retainedScale.page === pageIndex &&
        retainedScale.mode === scaleMode &&
        (retainedScale.request === pendingZoom || pendingZoom?.mode !== scaleMode);
      if (!textCheckpoint && !keepScale) {
        renderedWorkspaceWidth = workspace.clientWidth;
        renderedWorkspaceHeight = workspace.clientHeight;
        zoom = computeZoom(natural);
      }
      syncZoomSelect();
      const nextViewport = page.getViewport({ scale: zoom });
      // Match the device ratio within the pixel budget: drafts are DOM text rasterized at the
      // device ratio, so a page rendered at a lower ratio positions hinted glyphs differently.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(16000000 / (nextViewport.width * nextViewport.height)),
        8192 / nextViewport.width,
        8192 / nextViewport.height,
      );
      // Keep the last complete page visible while PDF.js clears and progressively paints
      // its replacement. Each render owns its buffer, including cancelled zoom/navigation.
      rendered.width = Math.max(1, Math.floor(nextViewport.width * ratio));
      rendered.height = Math.max(1, Math.floor(nextViewport.height * ratio));
      const layers = documentLayers || pdf.getOptionalContentConfig({ intent: 'display' });
      renderTask = page.render({
        canvasContext: rendered.getContext('2d'),
        viewport: nextViewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
        annotationMode: pdfjs.AnnotationMode.ENABLE,
        optionalContentConfigPromise: layers,
      });
      await renderTask.promise;
      if (token !== pageRenderGeneration || destroyed) return;
      const [content, annotations, layerConfig] = await Promise.all([
        page.getTextContent(),
        page.getAnnotations({ intent: 'display' }).catch(() => []),
        layers,
      ]);
      if (token !== pageRenderGeneration || destroyed) return;
      const hiddenAnnotations = new Set();
      const visibleAnnotations = annotations.filter((annotation) => {
        if (annotationLayerVisible(annotation, layerConfig)) return true;
        hiddenAnnotations.add(editorAnnotationId(annotation.id));
        return false;
      });
      viewport = nextViewport;
      pagePixelRatio = ratio;
      stack.place(paper, pageIndex);
      paintCanvas(canvas, rendered, viewport);
      paper.style.width = `${viewport.width}px`;
      paper.style.height = `${viewport.height}px`;
      paper.hidden = false;
      snapPaper();
      paper.style.setProperty('--scale-factor', zoom);
      paper.style.setProperty('--user-unit', page.userUnit || 1);
      const overlayRatio = Math.min(1, ratio);
      overlay.width = Math.max(1, Math.floor(viewport.width * overlayRatio));
      overlay.height = Math.max(1, Math.floor(viewport.height * overlayRatio));
      // PDF.js validates `url`; `unsafeUrl` is whatever the file said, so it is checked here
      // before it can be opened. A link whose address is refused stays listed so it
      // can still be edited or removed, but it opens nothing.
      links = visibleAnnotations
        .filter((a) => a.subtype === 'Link' && (a.url || a.unsafeUrl || a.dest))
        .map((a) => {
          const url = a.url || safeLinkUrl(a.unsafeUrl);
          return {
            id: a.id,
            rect: a.rect,
            url,
            address: a.unsafeUrl || a.url || '',
            dest: a.dest,
            blocked: !url && !a.dest && !!a.unsafeUrl,
            readOnly: !!(a.annotationFlags & 64),
            locked: !!(a.annotationFlags & 128),
          };
        });
      renderLinkTargets();
      textContainer.replaceChildren();
      textLayer = new pdfjs.TextLayer({
        textContentSource: content,
        container: textContainer,
        viewport,
      });
      await textLayer.render();
      if (token !== pageRenderGeneration || destroyed) return;
      alignTextLayer(textLayer, content, viewport);
      if (['text', 'select'].includes(tool) && access().edit && !(await indexTextRuns(page, token)))
        return;
      textRuns = textRunCache.get(pageIndex) || [];
      renderTextTargets();
      pageTextIndex = indexPageText(content.items);
      // PDF.js reports both an unselected button and the selected export "Off" as "Off".
      const ambiguousButtons = new Set(
        annotations
          .filter(
            (a) =>
              a.fieldType === 'Btn' &&
              a.fieldValue === 'Off' &&
              (a.buttonValue === 'Off' || a.exportValue === 'Off'),
          )
          .map((a) => a.fieldName),
      );
      let buttonSelections;
      if (ambiguousButtons.size) {
        const doc =
          editDocument || (await PDFDocument.load(session.bytes, { updateMetadata: false }));
        if (token !== pageRenderGeneration || destroyed) return;
        editDocument = doc;
        buttonSelections = formButtonSelections(doc, ambiguousButtons);
      }
      // A tooltip kept on a field above its widgets needs the document, when it is loaded.
      const tooltips =
        editDocument && annotations.some((a) => a.fieldName && !a.alternativeText)
          ? formFieldTooltips(editDocument)
          : undefined;
      pageForms.render(
        annotations,
        viewport,
        `${session.revision}:${pageIndex}`,
        layerConfig,
        buttonSelections,
        tooltips,
      );
      pageForms.setBusy(busy || !pageReady || !access().fill);
      pageForms.setEnabled(tool === 'select' && !preparing);
      highlights = [];
      if (
        visibleAnnotations.some((a) => ['Highlight', 'Underline', 'StrikeOut'].includes(a.subtype))
      ) {
        const doc =
          editDocument || (await PDFDocument.load(session.bytes, { updateMetadata: false }));
        if (token !== pageRenderGeneration || destroyed) return;
        editDocument = doc;
        highlights = listHighlights(doc, pageIndex).filter(
          (entry) => !hiddenAnnotations.has(entry.id),
        );
      }
      renderHighlightTargets();
      notes = [];
      if (visibleAnnotations.some((a) => a.subtype === 'Text')) {
        const doc =
          editDocument || (await PDFDocument.load(session.bytes, { updateMetadata: false }));
        if (token !== pageRenderGeneration || destroyed) return;
        editDocument = doc;
        notes = listNotes(doc, pageIndex).filter((entry) => !hiddenAnnotations.has(entry.id));
      }
      renderNoteTargets();
      let annotationEntries = [];
      if (visibleAnnotations.some((a) => ANNOTATION_KINDS.has(a.subtype))) {
        const doc =
          editDocument || (await PDFDocument.load(session.bytes, { updateMetadata: false }));
        if (token !== pageRenderGeneration || destroyed) return;
        editDocument = doc;
        try {
          annotationEntries = listAnnotations(doc, pageIndex).filter(
            (entry) => ANNOTATION_KINDS.has(entry.subtype) && !hiddenAnnotations.has(entry.id),
          );
        } catch {
          annotationEntries = [];
        }
      }
      annotationLayer.render(annotationEntries, viewport);
      annotationLayer.setEnabled(tool === 'select');
      if (tool === 'select' && !(await indexPageObjects(token))) return;
      pageImages.render(
        imageRunCache.get(pageIndex) || [],
        viewport,
        `${session.revision}:${pageIndex}`,
        pageIndex,
      );
      pageImages.setEnabled(tool === 'select' && access().edit);
      pageReady = true;
      accessibleText.textContent = access().accessibility
        ? content.items.map((i) => i.str || '').join(' ')
        : '';
      textContainer.setAttribute('aria-hidden', String(!access().accessibility));
      markSearch();
      // A comment chosen from the list opens once the page is ready to show its editor.
      if (revealComment) applyRevealComment().catch(() => {});
      pageCaption.textContent = `Page ${pageIndex + 1} of ${pdf.numPages}`;
      outline.setCurrent(pageIndex);
      thumbnails
        .querySelectorAll('.thumbnail')
        .forEach((node, i) =>
          node.setAttribute('aria-current', i === pageIndex ? 'page' : 'false'),
        );
      if (revealedThumbnail !== pageIndex) revealThumbnail();
      // Re-renders of the same page (zoom, edits) must not repeat the announcement.
      const announcer = document.querySelector('#announcer');
      if (announcer.textContent !== pageCaption.textContent)
        announcer.textContent = pageCaption.textContent;
      updateStatus();
      setTimeout(() => stack.recheck(), 0);
      if (preparing) refreshDesigner().catch(() => {});
    } catch (e) {
      if (e.name !== 'RenderingCancelledException' && token === pageRenderGeneration && !destroyed)
        toast('This page could not be rendered. Try another page or reopen the PDF.');
    } finally {
      rendered.width = rendered.height = 0;
      if (token === pageRenderGeneration && !destroyed) {
        paper.setAttribute('aria-busy', 'false');
        updateStatus();
      }
    }
  }
  /** Index editable text once per page and revision. False means the page moved on meanwhile. */
  async function indexTextRuns(page, token) {
    if (textRunCache.has(pageIndex)) return true;
    let runs = [];
    try {
      const [doc, layers] = await Promise.all([
        editDocument || PDFDocument.load(session.bytes, { updateMetadata: false }),
        documentLayers || pdf.getOptionalContentConfig({ intent: 'display' }),
      ]);
      if (token !== pageRenderGeneration || destroyed) return false;
      editDocument = doc;
      runs = groupTextParagraphs(
        groupTextRuns(await inspectText(doc, pageIndex, page, pdfjs.OPS, layers)),
      );
    } catch {
      // Editing support must not prevent an otherwise readable PDF from opening.
    }
    if (token !== pageRenderGeneration || destroyed) return false;
    textRunCache.set(pageIndex, runs);
    return true;
  }
  /** Index editable images, shapes, and drawings once per page and revision. */
  async function indexPageObjects(token) {
    if (imageRunCache.has(pageIndex)) return true;
    let images = [];
    try {
      const doc =
        editDocument || (await PDFDocument.load(session.bytes, { updateMetadata: false }));
      if (token !== pageRenderGeneration || destroyed) return false;
      editDocument = doc;
      images = inspectImages(doc, pageIndex).map((entry, i) => ({
        ...entry,
        kind: 'image',
        labelIndex: i,
      }));
      const counts = { shape: 0, drawing: 0 };
      const paths = inspectPaths(doc, pageIndex).map((entry, i) => ({
        ...entry,
        ordinal: images.length + i,
        labelIndex: counts[entry.kind]++,
      }));
      images.push(...paths);
      images.sort((a, b) => {
        const x = [...a.path.map((p) => p.start), a.start],
          y = [...b.path.map((p) => p.start), b.start];
        for (let i = 0; i < Math.min(x.length, y.length); i++)
          if (x[i] !== y[i]) return x[i] - y[i];
        return x.length - y.length;
      });
    } catch {
      /* Unsupported object structures do not prevent page rendering. */
    }
    if (token !== pageRenderGeneration || destroyed) return false;
    imageRunCache.set(pageIndex, images);
    return true;
  }
  let revealedThumbnail = -1;
  /** Keep the current page's thumbnail inside the panel's scroll viewport. */
  function revealThumbnail() {
    if (editorRoot.classList.contains('hide-pages')) return;
    thumbnails.children[pageIndex]?.scrollIntoView({ block: 'nearest' });
    revealedThumbnail = pageIndex;
  }
  function renderThumbnails() {
    // Rebuilding the list would drop the focus a thumbnail's menu returned there, so the same
    // page's button (or menu button) gets it back once the list exists again.
    const focused = document.activeElement;
    const restore = thumbnails.contains(focused)
      ? {
          index: Number(focused.closest('.thumb-item')?.dataset.index),
          menu: focused.classList.contains('thumb-menu'),
        }
      : null;
    const canvases = [...thumbnails.querySelectorAll('.thumb-paper canvas')];
    thumbnails.replaceChildren();
    const thisPdf = pdf;
    // Crisp previews on dense screens, within roughly the same memory budget as the page canvas.
    const ratio = Math.max(
      1,
      Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(16000000 / (thisPdf.numPages * 112 * 158)),
      ),
    );
    thumbnailObserver = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          thumbnailObserver.unobserve(entry.target);
          const c = entry.target.querySelector('canvas');
          const index = Number(entry.target.dataset.index);
          thisPdf
            .getPage(index + 1)
            .then(async (page) => {
              if (destroyed || pdf !== thisPdf || !c.isConnected) return;
              const natural = page.getViewport({ scale: 1 });
              const v = page.getViewport({
                scale: Math.min(112 / natural.width, 158 / natural.height),
              });
              const rendered = el('canvas', {
                width: Math.max(1, Math.floor(v.width * ratio)),
                height: Math.max(1, Math.floor(v.height * ratio)),
              });
              try {
                await page.render({
                  canvasContext: rendered.getContext('2d'),
                  viewport: v,
                  transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
                  optionalContentConfigPromise: documentLayers || undefined,
                }).promise;
                if (destroyed || pdf !== thisPdf || !c.isConnected) return;
                paintCanvas(c, rendered, v);
              } finally {
                rendered.width = rendered.height = 0;
              }
              // PDF.js keeps every decoded picture of a rendered page until told otherwise,
              // which a scan's thumbnails would turn into gigabytes; the page on view keeps
              // its pictures for the next zoom, and cleanup() declines while a render runs.
              if (pdf === thisPdf && index !== pageIndex) page.cleanup();
            })
            .catch(() => {});
        }),
      { root: thumbnails, rootMargin: '150px' },
    );
    for (let i = 0; i < pdf.numPages; i++) {
      const b = el(
        'button',
        {
          type: 'button',
          class: 'thumbnail',
          'data-index': i,
          'aria-label': `Go to page ${i + 1}`,
          'aria-current': i === pageIndex ? 'page' : 'false',
          onclick: () => {
            // On narrow screens the panel overlays the page, so choosing a page dismisses it.
            if (window.matchMedia('(max-width: 760px)').matches) hideSidebar();
            navigate(i);
          },
        },
        el('div', { class: 'thumb-paper' }, canvases[i] || el('canvas', { 'aria-hidden': 'true' })),
        el('span', {}, String(i + 1)),
      );
      // Each page has its own menu, on a button beside it and on a right click.
      const menuButton = iconButton(
        `Page ${i + 1} actions`,
        'EllipsisVertical',
        (e) => {
          // Safari does not focus buttons on pointer activation. Give the menu a stable
          // return target so page operations can restore focus when thumbnails rebuild.
          e.currentTarget.focus({ preventScroll: true });
          openMenu({
            anchor: e.currentTarget,
            items: pageItems(i),
            label: `Page ${i + 1}`,
            align: 'auto',
            minWidth: 230,
          });
        },
        { class: 'icon-btn thumb-menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      );
      const item = el(
        'div',
        {
          class: 'thumb-item',
          'data-index': i,
          oncontextmenu: (e) => {
            e.preventDefault();
            openMenu({
              anchor: menuButton,
              items: pageItems(i),
              label: `Page ${i + 1}`,
              x: e.clientX,
              y: e.clientY,
              minWidth: 230,
            });
          },
        },
        b,
        menuButton,
      );
      thumbnails.append(item);
      thumbnailObserver.observe(b);
    }
    if (restore && Number.isInteger(restore.index)) {
      const item = thumbnails.children[Math.min(restore.index, pdf.numPages - 1)];
      item
        ?.querySelector(restore.menu ? '.thumb-menu' : '.thumbnail')
        ?.focus({ preventScroll: true });
    }
  }
  // Pages can be dragged into a new order with a mouse or pen.
  const reorder = enableThumbnailReorder(thumbnails, {
    canDrag: () => !busy && pageReady && access().assemble,
    onMove: (from, to) => pageAction(() => movePageTo(from, to))(),
  });
  function clampPageIndex(index) {
    return Math.max(0, Math.min(pageCount - 1, Number.isFinite(index) ? Math.floor(index) : 0));
  }
  function navigateBy(direction) {
    const from = clampPageIndex(pendingNavigation?.index ?? pageIndex);
    // Side by side, the next or previous page is the first of the next or previous pair; the
    // other page of the pair on view is already in sight.
    if (stack.twoUp) return navigate(Math.max(0, (Math.floor(from / 2) + direction) * 2));
    return navigate(from + direction);
  }
  async function navigate(index, comment = null, { scroll = true } = {}) {
    if (destroyed || !pageCount) return false;
    // Resolve relative steps from the requested destination and let the latest choice
    // own the transition. The edit still belongs to its original page until it settles.
    const request = (pendingNavigation = { index: clampPageIndex(index) });
    navigationGeneration++;
    revealComment = null;
    cancelTextSelection();
    updateStatus();
    try {
      await idle();
      if (destroyed || pendingNavigation !== request) return false;
      await finishDrafts();
      if (destroyed || pendingNavigation !== request) return false;
      if (comment && tool !== 'select') {
        await setTool('select');
        if (destroyed || pendingNavigation !== request) return false;
      }
      // Register the comment's navigation before any draft commits or tool changes,
      // and reveal it only after those finish. A newer page choice retires both.
      revealComment = comment?.kind ? comment : null;
      if (comment && pageReady && pageIndex === clampPageIndex(request.index)) {
        await applyRevealComment();
        return !destroyed && pendingNavigation === request && pageReady;
      }
      // A page operation or undo may have changed the count while navigation waited.
      pageIndex = clampPageIndex(request.index);
      // A page chosen from the controls comes to the top; one reached by scrolling stays put.
      if (scroll) stack.scrollTo(pageIndex);
      updateStatus();
      await renderPage();
      return !destroyed && pendingNavigation === request && pageReady;
    } catch {
      return false;
    } finally {
      if (pendingNavigation === request) {
        pendingNavigation = null;
        updateStatus();
      }
    }
  }
  async function toggleSidebar(show = editorRoot.classList.contains('hide-pages')) {
    // A docked panel changes the page's width, so open drafts are finished first; on narrow
    // screens it overlays the page and a draft carries on underneath.
    if (!window.matchMedia('(max-width: 760px)').matches)
      try {
        await finishDrafts();
      } catch {
        return;
      }
    const hadFocus = sidebar.contains(document.activeElement);
    editorRoot.classList.toggle('hide-pages', !show);
    pagesButton.setAttribute('aria-expanded', String(show));
    // A control inside a panel that just closed would leave focus on nothing; hand it back to
    // the toggle that opens the panel again.
    if (!show && hadFocus) pagesButton.focus({ preventScroll: true });
    // A hidden panel could not scroll, so an opening one catches up with the current page.
    if (show) revealThumbnail();
    snapPaper();
    // Only a fit-width page whose workspace changed size needs another render: on narrow
    // screens the panel overlays the page, and a fixed zoom keeps its geometry either way.
    setTimeout(refitPage, 0);
  }
  /** Hide the panel without a re-render; as an overlay it does not change the page width. */
  function hideSidebar() {
    // A control chosen in the panel would leave focus on nothing; the page view takes it.
    if (sidebar.contains(document.activeElement)) workspace.focus({ preventScroll: true });
    editorRoot.classList.add('hide-pages');
    pagesButton.setAttribute('aria-expanded', 'false');
  }
  if (window.matchMedia('(max-width: 760px)').matches) hideSidebar();
  // The accessibility report has a tab once a check has run.
  sidebarTabs.querySelector('[data-tab="accessibility"]').hidden = true;
  // Scrolling through every page or one page (or spread) at a time, single pages or two side
  // by side; remembered on this device.
  const PAGE_DISPLAY_KEY = 'pdf-editor:page-display';
  const PAGE_DISPLAYS = {
    continuous: { continuous: true, twoUp: false },
    single: { continuous: false, twoUp: false },
    'two-continuous': { continuous: true, twoUp: true },
    two: { continuous: false, twoUp: true },
  };
  const pageDisplay = () =>
    Object.keys(PAGE_DISPLAYS).find(
      (key) =>
        PAGE_DISPLAYS[key].continuous === stack.continuous &&
        PAGE_DISPLAYS[key].twoUp === stack.twoUp,
    );
  function setPageDisplay(display, { remember = true } = {}) {
    const choice = PAGE_DISPLAYS[display] || PAGE_DISPLAYS.continuous;
    stack.setTwoUp(choice.twoUp);
    stack.setContinuous(choice.continuous);
    if (remember)
      try {
        if (display === 'continuous') localStorage.removeItem(PAGE_DISPLAY_KEY);
        else localStorage.setItem(PAGE_DISPLAY_KEY, display);
      } catch {
        /* The preference is optional. */
      }
    if (pdf) {
      safe(() => renderPage())();
      stack.scrollTo(pageIndex);
      stack.refresh();
    }
  }
  try {
    const stored = localStorage.getItem(PAGE_DISPLAY_KEY);
    if (PAGE_DISPLAYS[stored]) setPageDisplay(stored, { remember: false });
  } catch {
    /* The preference is optional. */
  }
  /** Read mode keeps only the pages and their controls on screen. */
  function setReadMode(on) {
    editorRoot.classList.toggle('read-mode', on);
    if (on) toast('Read mode. Press Escape to show the tools again.');
    setTimeout(refitPage, 0);
  }
  function toggleFullScreen() {
    const area = editorRoot.querySelector('.document-area');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else area.requestFullscreen?.().catch(() => toast('Full screen is not available here.'));
  }
  const onFullscreen = () => {
    editorRoot.classList.toggle('full-screen', !!document.fullscreenElement);
    setTimeout(refitPage, 50);
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  // The Hand tool, or Space held with any tool, drags the pages around.
  let panning = null,
    spaceHeld = false;
  const canPanWithSpace = (e) =>
    !e.repeat &&
    !textEdit &&
    !noteEdit &&
    !e.target.isContentEditable &&
    !/input|textarea|select|button/i.test(e.target.tagName) &&
    !document.querySelector('dialog[open]');
  const onSpace = (e) => {
    if (e.code !== 'Space') return;
    if (e.type === 'keydown' && !spaceHeld && canPanWithSpace(e)) {
      spaceHeld = true;
      editorRoot.classList.add('space-pan');
      e.preventDefault();
    } else if (e.type === 'keyup' && spaceHeld) {
      spaceHeld = false;
      editorRoot.classList.remove('space-pan');
    }
  };
  // A Space released while another window has the focus never comes back as a keyup here.
  const releaseSpace = () => {
    spaceHeld = false;
    editorRoot.classList.remove('space-pan');
  };
  window.addEventListener('keydown', onSpace);
  window.addEventListener('keyup', onSpace);
  window.addEventListener('blur', releaseSpace);
  workspace.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !(tool === 'hand' || spaceHeld)) return;
      e.preventDefault();
      e.stopPropagation();
      panning = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        left: workspace.scrollLeft,
        top: workspace.scrollTop,
      };
      workspace.setPointerCapture(e.pointerId);
      editorRoot.classList.add('panning');
    },
    true,
  );
  workspace.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== panning.id) return;
    workspace.scrollLeft = panning.left - (e.clientX - panning.x);
    workspace.scrollTop = panning.top - (e.clientY - panning.y);
  });
  const endPan = (e) => {
    if (!panning || e.pointerId !== panning.id) return;
    panning = null;
    editorRoot.classList.remove('panning');
  };
  workspace.addEventListener('pointerup', endPan);
  workspace.addEventListener('pointercancel', endPan);
  // Below desktop widths the tools pane overlays the page, so it starts closed there.
  if (window.matchMedia('(max-width: 1000px)').matches) editorRoot.classList.add('hide-tools');
  syncTopTabs();
  async function mutate(
    operation,
    message,
    permission = 'edit',
    { signal, canCommit, onCommit, retainScale = false } = {},
  ) {
    if (busy || destroyed) return;
    requireAccess(...(Array.isArray(permission) ? permission : [permission]));
    if (!(await confirmSignedEdit()) || busy || destroyed) return;
    const retainedScale = retainScale
      ? { page: pageIndex, mode: scaleMode, request: pendingZoom }
      : null;
    busy = true;
    updateStatus();
    try {
      const previousPage = pageIndex;
      try {
        if (
          (await session.change(operation, {
            signal,
            canCommit,
            streamProtection: protection?.original,
            saveOptions: pdfaClaim?.part === 1 ? { useObjectStreams: false } : undefined,
          })) === false
        )
          return;
      } catch (error) {
        pageIndex = previousPage;
        throw error;
      }
      onCommit?.();
      await reload(retainedScale);
      if (message && !destroyed) toast(message);
    } finally {
      busy = false;
      updateStatus();
      organizer.updateState();
    }
  }
  /** Keep a dialog edit local until it succeeds; closing the dialog abandons pending work. */
  async function mutateDialog(dialog, operation, message, permission = 'edit') {
    if (busy || destroyed || !dialog.open) return false;
    let committed = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    dialog.addEventListener('close', abort, { once: true });
    dialogController.signal.addEventListener('abort', abort, { once: true });
    const controls = [
      ...dialog.querySelectorAll('input, select, textarea, .dialog-actions .primary'),
    ].map((control) => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => {
      control.disabled = true;
    });
    dialog.setAttribute('aria-busy', 'true');
    try {
      await mutate(operation, message, permission, {
        signal: controller.signal,
        // Native close events are queued; the open flag changes synchronously.
        canCommit: () => dialog.open && !destroyed,
        onCommit: () => {
          committed = true;
          // Once committed, close before redrawing so Cancel never offers to undo a saved edit.
          dialog.removeEventListener('close', abort);
          if (dialog.open) dialog.close();
        },
      });
      if (dialog.open) dialog.close();
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      dialog.removeEventListener('close', abort);
      dialogController.signal.removeEventListener('abort', abort);
      dialog.removeAttribute('aria-busy');
      controls.forEach(({ control, disabled }) => {
        control.disabled = disabled;
      });
    }
    return committed;
  }
  let historyTail = Promise.resolve(),
    pendingHistory = 0;
  function history(action) {
    // Keyboard commands can arrive while a previous edit or history step redraws the PDF.
    // Preserve their order, including mixed Undo/Redo, and let output wait for the queue.
    pendingHistory++;
    const task = historyTail
      .then(async () => {
        await idle(false);
        if (!destroyed) await applyHistory(action);
      })
      .finally(() => pendingHistory--);
    // A failed step is reported by its caller, but must not poison later commands.
    historyTail = task.catch(() => {});
    return task;
  }
  async function applyHistory(action) {
    if (action === 'undo' && (pageImages.dirty || pageImages.active)) {
      pageImages.cancel();
      return;
    }
    if (action === 'undo' && pendingTextEdit()) {
      await finishTextEdit(false);
      overlay.focus();
      return;
    }
    // A note being typed is undone by discarding the draft, as text is; committing it first
    // would only put the unwanted note on the redo stack.
    if (action === 'undo' && pendingNoteEdit()) {
      closeNoteEditor();
      overlay.focus();
      return;
    }
    // The Redo button is disabled while a draft is pending; the shortcut must match it
    // instead of committing the draft as a side effect.
    if (action === 'redo' && (pendingTextEdit() || pendingNoteEdit() || pageImages.dirty)) return;
    if (pageForms[action]()) return;
    if (pageForms.draft.dirty) return;
    await finishDrafts();
    if (session[action]()) {
      busy = true;
      updateStatus();
      try {
        await reload();
      } finally {
        busy = false;
        updateStatus();
      }
    }
  }
  async function setTool(next) {
    const permission = toolPermission(next);
    if (permission) requireAccess(permission);
    cancelTextSelection();
    await finishDrafts();
    tool = next;
    selectedHighlight = null;
    gesture = null;
    discardCropDraft();
    clearOverlay();
    toolButtons.forEach((b, id) => b.setAttribute('aria-pressed', String(id === tool)));
    const passive = tool === 'select' || tool === 'hand';
    overlay.classList.toggle('active', !passive);
    overlay.tabIndex = passive ? -1 : 0;
    textTargets.hidden = !['text', 'select'].includes(tool);
    textTargets.classList.toggle('select-text-objects', tool === 'select');
    pageForms.setEnabled(tool === 'select' && !preparing);
    pageImages.setEnabled(tool === 'select' && access().edit);
    renderHighlightTargets();
    renderNoteTargets();
    renderLinkTargets();
    annotationLayer.setEnabled(tool === 'select');
    toolOptions.hidden = tool === 'select' || tool === 'hand';
    widthInput.hidden = !['shape', 'ink', 'cshape', 'pencil'].includes(tool);
    shapeSelect.hidden = tool !== 'shape';
    commentShape.hidden = tool !== 'cshape';
    measureMode.hidden = measureUnit.hidden = measureRatio.hidden = tool !== 'measure';
    measurePath = [];
    sizeInput.hidden = !['text', 'textbox', 'callout'].includes(tool);
    sizeInput.value = String(['textbox', 'callout'].includes(tool) ? commentSize : textSize);
    boldButton.hidden = italicButton.hidden = tool !== 'text';
    syncStyleButtons();
    centerButton.hidden = UNPLACEABLE.includes(tool);
    colorInput.hidden = ['crop', 'link', 'certsign', 'field'].includes(tool);
    cropMarginsButton.hidden = cropDoneButton.hidden = tool !== 'crop';
    color = toolColors[colorGroup()];
    colorInput.value = color;
    highlightMode.hidden = tool !== 'highlight';
    markupKind.hidden = tool !== 'highlight' || markupKind.value === 'redact';
    highlightButton.hidden = tool !== 'highlight' || highlightArea();
    hint.textContent = {
      select: 'Click to select, drag to move, or double-click text to edit.',
      text: 'Click existing text to edit, or click an empty area to add text.',
      highlight: 'Select text, then choose Highlight selection. Use Area for scanned pages.',
      ink: 'Draw on the page with a mouse, pen, or touch.',
      shape: SHAPE_HINTS[shapeSelect.value],
      note: 'Click where the note should go, or click a note to read or edit it.',
      crop: 'Drag over the part of the page to keep, then choose which pages to crop.',
      link: 'Drag over the text or area that should open a web address or another page.',
      hand: 'Drag to move through the pages. Hold Space with any tool to do the same.',
      certsign: 'Drag a box where the signature should appear.',
      textbox: 'Drag a box for the text comment, or click to place one.',
      callout: 'Drag from the spot the comment points at to where its box goes.',
      cshape: 'Drag to draw the shape as a comment. Hold Shift to keep it regular.',
      pencil: 'Draw on the page; each stroke becomes a comment you can move or delete.',
      measure: measureHint(),
      field:
        'Drag a box where the field goes. Drag fields to move them; double-click one for its properties.',
    }[tool];
    syncStyleButtons();
    if (redacting()) {
      hint.textContent =
        'Select text, then choose Mark selection for redaction. Choose Area to drag over pictures or any part of the page.';
      colorInput.hidden = true;
    }
    toolsPanel.refresh();
    editorRoot.dataset.tool = tool;
    if (tool === 'highlight') updateHighlightMode();
    else clearHighlightSelection();
    const unindexed =
      (['text', 'select'].includes(tool) && access().edit && !textRunCache.has(pageIndex)) ||
      (tool === 'select' && !imageRunCache.has(pageIndex));
    if (!pageReady || !currentPage) {
      // A render in flight reads the tool once it reaches indexing; restart it as before.
      if (unindexed) await renderPage();
      else renderTextTargets();
      return;
    }
    // The rendered page stays in place: indexing needs the PDF, not another canvas paint.
    const token = pageRenderGeneration;
    if (['text', 'select'].includes(tool) && access().edit) {
      if (!(await indexTextRuns(currentPage, token))) return;
      textRuns = textRunCache.get(pageIndex) || [];
    }
    if (tool === 'select' && !imageRunCache.has(pageIndex)) {
      if (!(await indexPageObjects(token))) return;
      pageImages.render(
        imageRunCache.get(pageIndex) || [],
        viewport,
        `${session.revision}:${pageIndex}`,
        pageIndex,
      );
      pageImages.setEnabled(tool === 'select' && access().edit);
    }
    renderTextTargets();
    updateStatus();
  }
  function updateHighlightMode() {
    const area = highlightArea();
    overlay.classList.toggle('active', area);
    overlay.tabIndex = area ? 0 : -1;
    highlightButton.hidden = area;
    hint.textContent = area
      ? 'Drag over an area to highlight it.'
      : 'Select text, then choose Highlight selection. Use Area for scanned pages.';
    if (area) {
      if (highlightSelection || highlightCaptureTimer) window.getSelection()?.removeAllRanges();
      clearHighlightSelection();
    } else captureHighlightSelection();
  }
  /**
   * Select the page's own words. In a PDF reader Select All means the text on the page, not
   * the application around it, which is what the browser's own command would reach for.
   * Returns whether the page had any text to select.
   */
  function selectPageText() {
    const selection = window.getSelection();
    if (!selection || !pageReady || !textContainer.firstChild) return false;
    const range = document.createRange();
    range.selectNodeContents(textContainer);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  let highlightCaptureTimer = null;
  function clearHighlightSelection() {
    clearTimeout(highlightCaptureTimer);
    highlightCaptureTimer = null;
    highlightSelection = null;
    highlightButton.disabled = true;
  }
  /** Read the selected glyph geometry now. */
  function measureHighlightSelection() {
    clearTimeout(highlightCaptureTimer);
    highlightCaptureTimer = null;
    highlightSelection = selectedTextQuads(textLayer, viewport, paper);
    highlightButton.disabled = !highlightSelection;
  }
  function captureHighlightSelection() {
    if (tool !== 'highlight' || highlightArea() || busy || !pageReady) return;
    if (!pageTextRange(textContainer)) {
      clearHighlightSelection();
      return;
    }
    // Measuring a dense selection still reads many glyph rectangles. Enable the action
    // at once and read the geometry after the selection settles.
    clearTimeout(highlightCaptureTimer);
    highlightSelection = null;
    highlightButton.disabled = false;
    highlightCaptureTimer = setTimeout(measureHighlightSelection, 100);
  }
  async function applyHighlight() {
    if (highlightCaptureTimer) measureHighlightSelection();
    if (!highlightSelection || busy || !pageReady) return;
    const selection = highlightSelection;
    await mutate(
      async (doc) =>
        markupKind.value === 'redact'
          ? (await loadRedaction()).addRedactionMarks(
              doc,
              pageIndex,
              quadRects(selection.quads),
              redactionStyle,
            )
          : addHighlight(doc, pageIndex, { ...selection, hex: color, kind: markupKind.value }),
      null,
      markupKind.value === 'redact' ? 'edit' : 'annotate',
    );
    window.getSelection()?.removeAllRanges();
    clearHighlightSelection();
  }
  document.addEventListener('selectionchange', captureHighlightSelection);
  // A text selection dragged off the page runs to the page's last (or first) word. Left to
  // itself, the browser maps the empty space below the last page back to where the drag began.
  let textDragPointer = null;
  textContainer.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && e.pointerType !== 'touch') textDragPointer = e.pointerId;
  });
  function endTextDrag(e) {
    if (e.pointerId === textDragPointer) textDragPointer = null;
  }
  function followTextDrag(e) {
    if (e.pointerId !== textDragPointer) return;
    const { clientX: x, clientY: y } = e;
    // After the browser has placed the selection for this move.
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      if (!selection?.anchorNode || !textContainer.contains(selection.anchorNode)) return;
      const box = paper.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return;
      const after = y > box.bottom || (x > box.right && y >= box.top);
      selection.extend(textContainer, after ? textContainer.childNodes.length : 0);
    });
  }
  document.addEventListener('pointermove', followTextDrag, true);
  document.addEventListener('pointerup', endTextDrag, true);
  document.addEventListener('pointercancel', endTextDrag, true);
  function renderHighlightTargets() {
    highlightTargets.hidden = tool !== 'select';
    highlightTargets.replaceChildren();
    properties.clear('highlight');
    if (tool !== 'select' || !viewport) return;
    for (const entry of highlights) {
      if (entry.readOnly) continue;
      const label = MARKUP_KINDS[entry.kind].label;
      entry.quads.forEach((quad, i) => {
        const points = [];
        for (let j = 0; j < 8; j += 2)
          points.push(viewport.convertToViewportPoint(quad[j], quad[j + 1]));
        const xs = points.map((p) => p[0]),
          ys = points.map((p) => p[1]);
        const x = Math.min(...xs),
          y = Math.min(...ys),
          w = Math.max(...xs) - x,
          h = Math.max(...ys) - y;
        const target = el('button', {
          class: 'highlight-target',
          type: 'button',
          'aria-label': `Edit ${label}${entry.text ? ': ' + entry.text.slice(0, 80) : ''}${i ? ` (part ${i + 1})` : ''}`,
          'aria-pressed': selectedHighlight?.id === entry.id,
          'data-highlight-id': entry.id,
          disabled: !access().annotate,
          onclick: safe(() =>
            selectionProperties(async () => {
              if (busy || !pageReady) return;
              const focusFrom = document.activeElement;
              cancelTextSelection();
              const ordinal = highlights.indexOf(entry);
              await finishDrafts();
              pageImages.close();
              annotationLayer.clear();
              // Finishing a related note may detach this reply and assign it a new ID.
              selectedHighlight = highlights.find((h) => h.id === entry.id) || highlights[ordinal];
              renderHighlightTargets();
              if (canFocusSelection(focusFrom))
                properties.root
                  .querySelector('.highlight-edit-panel input')
                  ?.focus({ preventScroll: true });
            }),
          ),
        });
        Object.assign(target.style, {
          left: `${x}px`,
          top: `${y}px`,
          width: `${w}px`,
          height: `${h}px`,
          clipPath: `polygon(${[0, 1, 3, 2].map((j) => `${points[j][0] - x}px ${points[j][1] - y}px`).join(',')})`,
        });
        highlightTargets.append(target);
      });
    }
    if (!selectedHighlight || !access().annotate) return;
    const entry = selectedHighlight,
      label = MARKUP_KINDS[entry.kind].label,
      Label = label[0].toUpperCase() + label.slice(1);
    const picker = el('input', {
      type: 'color',
      value: entry.hex,
      'aria-label': `${Label} color`,
      'data-markup-mutation': '',
      onchange: safe((e) =>
        selectionProperties(async () => {
          if (busy || !pageReady) return;
          const hex = e.target.value;
          try {
            // Typed field values must land in the PDF before the reload that follows the edit.
            await finishDrafts();
            let editedId = entry.id;
            await mutate(
              (doc) => {
                const changed = editHighlight(doc, pageIndex, entry.id, { hex });
                if (typeof changed === 'string') editedId = changed;
                return changed;
              },
              null,
              'annotate',
              { retainScale: true },
            );
            // The reload cleared the selection; keep the highlight selected, as the object panels
            // do, so the color can be adjusted again or the highlight deleted without reselecting.
            if (destroyed || tool !== 'select' || selectedHighlight) return;
            selectedHighlight = highlights.find((h) => h.id === editedId) || null;
            if (!selectedHighlight || !access().annotate) return;
            renderHighlightTargets();
            if (document.activeElement === document.body)
              properties.root
                .querySelector('.highlight-edit-panel input')
                ?.focus({ preventScroll: true });
          } catch (error) {
            picker.value = entry.hex;
            if (!destroyed && picker.isConnected && document.activeElement === document.body)
              picker.focus({ preventScroll: true });
            throw error;
          }
        }),
      ),
    });
    const panel = el(
      'div',
      { class: 'highlight-edit-panel', role: 'group', 'aria-label': `Edit ${label}` },
      picker,
      button(
        `Delete ${label}`,
        'Trash2',
        safe(async (e) => {
          const remove = e.currentTarget;
          try {
            await finishDrafts();
            await mutate(
              (doc) => editHighlight(doc, pageIndex, entry.id, { remove: true }),
              null,
              'annotate',
            );
          } catch (error) {
            if (!destroyed && remove.isConnected && document.activeElement === document.body)
              remove.focus({ preventScroll: true });
            throw error;
          }
          if (!destroyed && document.activeElement === document.body) overlay.focus();
        }),
        'text-btn',
        { 'data-markup-mutation': '' },
      ),
      iconButton(`Close ${label} editor`, 'X', closeHighlightEditor),
    );
    properties.show('highlight', Label, panel);
  }
  function closeHighlightEditor() {
    const id = selectedHighlight?.id;
    selectedHighlight = null;
    renderHighlightTargets();
    [...highlightTargets.querySelectorAll('button')]
      .find((button) => button.dataset.highlightId === id)
      ?.focus({ preventScroll: true });
  }
  /**
   * Scroll the workspace as little as it takes to show an editor: the whole of `nodes`
   * together when they fit, and the first of them when they do not.
   */
  function revealEditor(...nodes) {
    const boxes = nodes.filter(Boolean).map((node) => node.getBoundingClientRect());
    if (!boxes.length) return;
    const view = workspace.getBoundingClientRect();
    const pad = 8;
    // The distance that brings [start, end] into [from, to], preferring the start edge.
    const shift = (start, end, from, to) => {
      if (start < from) return start - from;
      if (end > to) return Math.min(end - to, start - from);
      return 0;
    };
    const span = (pick) => {
      const all = boxes.map(pick);
      return [Math.min(...all.map((b) => b[0])), Math.max(...all.map((b) => b[1]))];
    };
    const fit = (pick, from, to) => {
      const [start, end] = span(pick);
      if (end - start <= to - from) return shift(start, end, from, to);
      const [only] = [pick(boxes[0])];
      return shift(only[0], only[1], from, to);
    };
    workspace.scrollLeft += fit((b) => [b.left, b.right], view.left + pad, view.right - pad);
    workspace.scrollTop += fit((b) => [b.top, b.bottom], view.top + pad, view.bottom - pad);
  }
  function clearOverlay() {
    const ctx = overlay.getContext('2d');
    ctx.resetTransform();
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    return ctx;
  }
  const screenPoint = (e) => {
    const r = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(viewport.width, ((e.clientX - r.left) * viewport.width) / r.width)),
      y: Math.max(0, Math.min(viewport.height, ((e.clientY - r.top) * viewport.height) / r.height)),
    };
  };
  const pdfPoint = (p) => {
    const [x, y] = viewport.convertToPdfPoint(p.x, p.y);
    return { x, y };
  };
  /** Screen units per PDF unit on the page as shown. */
  const screenUnit = () => {
    const [ax, ay] = viewport.convertToViewportPoint(0, 0),
      [bx, by] = viewport.convertToViewportPoint(1, 0);
    return Math.hypot(bx - ax, by - ay);
  };
  /**
   * The PDF rectangle `width` by `height` units that runs right and down from screen point `p`
   * as the page is shown, so a box keeps its shape on a turned page.
   */
  const readerRect = (p, width, height) => {
    const unit = screenUnit();
    return normalizeRect(pdfPoint(p), pdfPoint({ x: p.x + width * unit, y: p.y + height * unit }));
  };
  overlay.addEventListener('pointerdown', (e) => {
    if (busy || !pageReady || gesture || !e.isPrimary || tool === 'select' || e.button !== 0)
      return;
    e.preventDefault();
    const p = screenPoint(e);
    if (tool === 'note') {
      if (noteEdit) {
        safe(deselectObjects)();
        return;
      }
      safe(() => openNoteEditor({ point: p }))();
      return;
    }
    if (tool === 'text') {
      if (textEdit) {
        safe(deselectObjects)();
        return;
      }
      const overText = textLayer?.textDivs.some((node) => {
        const r = node.getBoundingClientRect();
        return (
          node.textContent.trim() &&
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        );
      });
      if (overText) {
        toast('This text cannot yet be edited. Choose an empty area to add text.');
        return;
      }
      safe(() => textDialog(p))();
      return;
    }
    if (tool === 'crop') discardCropDraft();
    if (tool === 'measure' && measureMode.value !== 'distance') {
      measurePath.push(pdfPoint(p));
      measurePage = pageIndex;
      drawMeasurePath(p);
      return;
    }
    gesture = {
      pointerId: e.pointerId,
      event: e,
      start: p,
      points: [p],
      type: tool,
      kind: markupKind.value,
      shape:
        tool === 'cshape'
          ? { square: 'rectangle', circle: 'ellipse', cloud: 'rectangle' }[commentShape.value] ||
            commentShape.value
          : shapeSelect.value,
      commentKind: commentShape.value,
      hex: color,
      width: stroke / viewport.userUnit,
      page: pageIndex,
    };
    overlay.setPointerCapture(e.pointerId);
  });
  /** With Shift held, rectangles and ellipses stay regular and lines snap to 45 degrees. */
  function constrainShape(start, end, shape, shift) {
    if (!shift) return end;
    const dx = end.x - start.x,
      dy = end.y - start.y;
    if (shape === 'line' || shape === 'arrow') {
      const length = Math.hypot(dx, dy),
        angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
    }
    const side = Math.min(Math.abs(dx), Math.abs(dy));
    return { x: start.x + Math.sign(dx) * side, y: start.y + Math.sign(dy) * side };
  }
  function previewShape(ctx, shape, a, b) {
    const r = normalizeRect(a, b),
      head =
        shape === 'arrow' ? arrowHead(a, b, ctx.lineWidth, 8 * zoom * viewport.userUnit) : null;
    ctx.beginPath();
    if (shape === 'ellipse')
      ctx.ellipse(
        r.x + r.width / 2,
        r.y + r.height / 2,
        r.width / 2,
        r.height / 2,
        0,
        0,
        2 * Math.PI,
      );
    else if (shape === 'line' || shape === 'arrow') {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(head?.base.x ?? b.x, head?.base.y ?? b.y);
    } else if (shape === 'check' || shape === 'cross') {
      // Screen space runs downwards, so the mark's box is mirrored from the page version.
      const at = (fx, fy) => [r.x + r.width * fx, r.y + r.height * (1 - fy)];
      if (shape === 'check') {
        ctx.moveTo(...at(0.12, 0.52));
        ctx.lineTo(...at(0.4, 0.18));
        ctx.lineTo(...at(0.9, 0.86));
      } else {
        ctx.moveTo(...at(0.15, 0.85));
        ctx.lineTo(...at(0.85, 0.15));
        ctx.moveTo(...at(0.15, 0.15));
        ctx.lineTo(...at(0.85, 0.85));
      }
    } else ctx.rect(r.x, r.y, r.width, r.height);
    ctx.stroke();
    if (head) {
      ctx.beginPath();
      ctx.moveTo(head.tip.x, head.tip.y);
      ctx.lineTo(head.left.x, head.left.y);
      ctx.lineTo(head.right.x, head.right.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  function updateDrawingGesture(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    gesture.event = e;
    const p =
      gesture.type === 'shape' || gesture.type === 'cshape'
        ? constrainShape(gesture.start, screenPoint(e), gesture.shape, e.shiftKey)
        : screenPoint(e);
    gesture.end = p;
    if (gesture.type === 'ink' || gesture.type === 'pencil') {
      const last = gesture.points.at(-1);
      if (p.x !== last.x || p.y !== last.y) gesture.points.push(p);
    }
    const ctx = clearOverlay();
    ctx.setTransform(overlay.width / viewport.width, 0, 0, overlay.height / viewport.height, 0, 0);
    ctx.strokeStyle = gesture.hex;
    ctx.fillStyle = gesture.hex;
    ctx.lineWidth = gesture.width * zoom * viewport.userUnit;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (gesture.type === 'crop') drawCropPreview(ctx, normalizeRect(gesture.start, p));
    else if (['link', 'certsign', 'field'].includes(gesture.type)) {
      const r = normalizeRect(gesture.start, p);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
      ctx.globalAlpha = 0.18;
      ctx.fillRect(r.x, r.y, r.width, r.height);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--brand')
        .trim();
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    } else if (gesture.type === 'ink' || gesture.type === 'pencil') {
      ctx.beginPath();
      gesture.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else {
      const r = normalizeRect(gesture.start, p);
      if (gesture.type === 'highlight') {
        ctx.globalAlpha = 0.32;
        ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.globalAlpha = 1;
      } else if (gesture.type === 'measure') {
        previewShape(ctx, 'line', gesture.start, p);
        hint.textContent = measureLabel('distance', [pdfPoint(gesture.start), pdfPoint(p)], {
          ...measureScale,
          userUnit: viewport.userUnit,
        });
      } else if (gesture.type === 'textbox') previewShape(ctx, 'rectangle', gesture.start, p);
      else if (gesture.type === 'callout') previewShape(ctx, 'arrow', p, gesture.start);
      else previewShape(ctx, gesture.shape, gesture.start, p);
    }
  }
  overlay.addEventListener('pointermove', updateDrawingGesture);
  function updateDrawingModifier(e) {
    if (e.key !== 'Shift' || !['shape', 'cshape'].includes(gesture?.type) || e.isComposing) return;
    const { pointerId, clientX, clientY } = gesture.event;
    updateDrawingGesture({ pointerId, clientX, clientY, shiftKey: e.shiftKey });
  }
  window.addEventListener('keydown', updateDrawingModifier);
  window.addEventListener('keyup', updateDrawingModifier);
  async function commitDrawing(operation, permission = 'edit') {
    // Keep the released stroke visible until renderPage paints the PDF and resets
    // the overlay in the same task. Also discard it if saving or rendering fails.
    committingDrawing = true;
    try {
      await mutate(operation, null, permission);
    } finally {
      committingDrawing = false;
      clearOverlay();
    }
  }
  overlay.addEventListener(
    'pointerup',
    safe(async (e) => {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      const g = gesture;
      updateDrawingGesture(e);
      gesture = null;
      if (COMMENT_TOOLS.includes(g.type)) {
        clearOverlay();
        // A comment shape keeps the Shift constraint its preview showed.
        const end =
          g.type === 'cshape'
            ? constrainShape(g.start, screenPoint(e), g.shape, e.shiftKey)
            : screenPoint(e);
        await placeComment(g, end);
      } else if (g.type === 'field') {
        clearOverlay();
        const end = screenPoint(e);
        if (Math.hypot(end.x - g.start.x, end.y - g.start.y) < 8) return;
        await createField(normalizeRect(pdfPoint(g.start), pdfPoint(end)), g.page);
      } else if (g.type === 'certsign') {
        clearOverlay();
        const end = screenPoint(e);
        if (Math.hypot(end.x - g.start.x, end.y - g.start.y) < 8) return;
        await signWithCertificate({
          rect: normalizeRect(pdfPoint(g.start), pdfPoint(end)),
          page: g.page,
        });
      } else if (g.type === 'link') {
        clearOverlay();
        const end = screenPoint(e);
        if (Math.hypot(end.x - g.start.x, end.y - g.start.y) < 4) return;
        await placeLink(normalizeRect(pdfPoint(g.start), pdfPoint(end)), g.page);
      } else if (g.type === 'crop') {
        clearOverlay();
        const end = screenPoint(e);
        const screen = normalizeRect(g.start, end);
        if (screen.width < 4 || screen.height < 4) return;
        cropDraft = { page: g.page, screen, rect: normalizeRect(pdfPoint(g.start), pdfPoint(end)) };
        renderCropDraft();
      } else if (g.type === 'ink') {
        // A release may contain a newer sample than the last pointermove, or be
        // the only sample after a quick press. Keep it without turning taps into dots.
        const end = screenPoint(e),
          last = g.points.at(-1);
        if (end.x !== last.x || end.y !== last.y) g.points.push(end);
        if (g.points.length < 2) {
          clearOverlay();
          return;
        }
        const points = g.points.map(pdfPoint);
        await commitDrawing((doc) => drawMark(doc, g.page, { ...g, points }));
      } else {
        const end =
          g.type === 'shape'
            ? constrainShape(g.start, screenPoint(e), g.shape, e.shiftKey)
            : screenPoint(e);
        if (Math.hypot(end.x - g.start.x, end.y - g.start.y) < 4) {
          // A click drops a check mark or cross of a fixed size around the point.
          clearOverlay();
          if (g.type !== 'shape' || !['check', 'cross'].includes(g.shape)) return;
          const center = pdfPoint(g.start),
            half = MARK_SIZE / 2 / viewport.userUnit;
          const rect = {
            x: center.x - half,
            y: center.y - half,
            width: 2 * half,
            height: 2 * half,
          };
          await mutate((doc) => drawOrRedact(doc, g.page, { ...g, rect }));
          return;
        }
        const from = pdfPoint(g.start),
          to = pdfPoint(end);
        const rect = normalizeRect(from, to);
        await commitDrawing(
          (doc) => drawOrRedact(doc, g.page, { ...g, rect, from, to }),
          g.type === 'highlight' && g.kind !== 'redact' ? 'annotate' : 'edit',
        );
      }
    }),
  );
  for (const type of ['pointercancel', 'lostpointercapture'])
    overlay.addEventListener(type, (e) => {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      // An interrupted gesture must not survive into a later press or release.
      // Normal pointerup clears the gesture before implicit capture loss arrives.
      gesture = null;
      clearOverlay();
    });
  /* ---------- Links ---------- */
  const linkLabel = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'mailto:' || u.protocol === 'tel:') return u.pathname;
      return u.host + (u.pathname !== '/' ? u.pathname : '') + u.search;
    } catch {
      return url;
    }
  };
  async function followLink(link) {
    if (link.readOnly) return;
    if (link.url) {
      window.open(link.url, '_blank', 'noopener');
      return;
    }
    if (link.blocked) {
      toast('This link has an address that cannot be opened here.');
      return;
    }
    // Resolving a named destination or page reference can wait on the PDF worker.
    // Claim the navigation now so a newer page or link choice can supersede it.
    const request = (pendingNavigation = { index: pageIndex });
    navigationGeneration++;
    const thisPdf = pdf;
    revealComment = null;
    updateStatus();
    try {
      const index = await destinationPage(thisPdf, link.dest);
      if (destroyed || pdf !== thisPdf || pendingNavigation !== request) return;
      if (index == null) toast('This link points nowhere in the PDF.');
      else if (index !== pageIndex) await navigate(index);
    } finally {
      if (pendingNavigation === request) {
        pendingNavigation = null;
        updateStatus();
      }
    }
  }
  const canEditLink = (link) => access().annotate && !link.readOnly && !link.locked;
  function linkMenuItems(link) {
    return [
      {
        permission: 'annotate',
        label: 'Edit link…',
        icon: 'Link',
        disabled: busy || !canEditLink(link),
        onSelect: safe(() => editLink(link)),
      },
      !link.blocked && {
        label: link.url ? 'Open link' : 'Go to linked page',
        icon: link.url ? 'ExternalLink' : 'ArrowRight',
        disabled: link.readOnly,
        onSelect: safe(() => followLink(link)),
      },
      link.url && {
        label: 'Copy link address',
        icon: 'Copy',
        disabled: !access().copy,
        onSelect: safe(async () => {
          requireAccess('copy');
          await copyText(link.url);
          toast('Link address copied.');
        }),
      },
      !link.blocked && { separator: true },
      {
        permission: 'annotate',
        label: 'Remove link',
        icon: 'Unlink',
        disabled: busy || !canEditLink(link),
        onSelect: pageAction(() =>
          mutate((doc) => removeLink(doc, pageIndex, link.id), 'Link removed.', 'annotate'),
        ),
      },
    ].filter(Boolean);
  }
  /** Link targets edit on activation; following a destination is always an explicit action. */
  function renderLinkTargets() {
    linkTargets.replaceChildren();
    linkTargets.hidden = tool !== 'select';
    if (!viewport) return;
    for (const link of links) {
      const [x0, y0, x1, y1] = link.rect;
      const a = viewport.convertToViewportPoint(x0, y0),
        b = viewport.convertToViewportPoint(x1, y1);
      const width = Math.abs(b[0] - a[0]),
        height = Math.abs(b[1] - a[1]);
      if (width < 1 || height < 1) continue;
      const target = el('button', {
        type: 'button',
        class: 'link-target',
        title: canEditLink(link) ? 'Edit link' : 'Link options',
        'aria-label': link.url
          ? `Link to ${linkLabel(link.url)}`
          : link.blocked
            ? 'Link with an unsupported address'
            : 'Link to another page',
        'aria-haspopup': canEditLink(link) ? 'dialog' : 'menu',
        onclick: safe(() => {
          if (busy) return;
          if (canEditLink(link)) return editLink(link);
          openMenu({ anchor: target, items: linkMenuItems(link), label: 'Link' });
        }),
      });
      target.dataset.linkId = link.id;
      target.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu({
          anchor: target,
          items: linkMenuItems(link),
          label: 'Link',
          x: e.clientX,
          y: e.clientY,
        });
      });
      Object.assign(target.style, {
        left: `${Math.min(a[0], b[0])}px`,
        top: `${Math.min(a[1], b[1])}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      linkTargets.append(target);
    }
  }
  /** Ask where a link should go, then add it over `rect` on page `page`. */
  async function placeLink(rect, page) {
    const choice = await linkDialog();
    if (!choice || destroyed) return;
    await mutate((doc) => addLink(doc, page, { rect, ...choice }), 'Link added.', 'annotate');
    if (!destroyed && tool === 'link') await setTool('select');
  }
  let editingLink = null;
  async function editLink(link) {
    const sourcePage = pageIndex;
    if (editingLink) {
      // Native close() returns focus before its queued close event settles the dialog.
      // Preserve a rapid activation in that gap, after cleanup has restored focus.
      if (!editingLink.dialog || editingLink.dialog.open) return;
      await editingLink.closed;
    }
    if (
      editingLink ||
      busy ||
      destroyed ||
      sourcePage !== pageIndex ||
      link.readOnly ||
      link.locked
    )
      return;
    requireAccess('annotate');
    const version = beginDialogRequest();
    const operation = { dialog: null, closed: null };
    editingLink = operation;
    try {
      await deselectObjects();
      const destination = link.dest ? await destinationPage(pdf, link.dest) : null;
      if (!canOpenDialog(version) || sourcePage !== pageIndex) return;
      const initial = { url: link.url || link.address || '', page: destination };
      // Safari does not focus buttons on pointer activation. Give the dialog a
      // stable return target so Escape also allows immediate keyboard editing.
      linkTargets
        .querySelector(`[data-link-id="${CSS.escape(link.id)}"]`)
        ?.focus({ preventScroll: true });
      operation.closed = linkDialog(initial, link, (dialog) => (operation.dialog = dialog));
      const choice = await operation.closed;
      if (!choice || destroyed) return;
      // Opening, cancelling, or saving an unchanged link must not create history or
      // replace an existing page destination's precise position and zoom.
      if (choice.page != null ? choice.page === initial.page : choice.url === initial.url) return;
      const ordinal = links.findIndex((entry) => entry.id === link.id);
      await mutate(
        (doc) => updateLink(doc, sourcePage, link.id, choice),
        'Link updated.',
        'annotate',
      );
      if (destroyed || sourcePage !== pageIndex) return;
      // Changing a destination preserves link order, but detaching a shared link changes its ID.
      const edited = links.find((entry) => entry.id === link.id) || links[ordinal];
      if (edited && document.activeElement === document.body)
        linkTargets
          .querySelector(`[data-link-id="${CSS.escape(edited.id)}"]`)
          ?.focus({ preventScroll: true });
    } finally {
      if (editingLink === operation) editingLink = null;
    }
  }
  function linkDialog(initial = null, link = null, onOpen) {
    return new Promise((resolve) => {
      let result = null;
      const url = el('input', {
        class: 'input',
        id: 'link-url',
        inputmode: 'url',
        placeholder: 'example.com/page',
        value: initial?.url || '',
        autocomplete: 'off',
        'aria-label': 'Web address to link to',
      });
      const pageNumber = el('input', {
        type: 'number',
        class: 'input',
        id: 'link-page',
        min: 1,
        max: pdf.numPages,
        step: 1,
        value: initial?.page != null ? initial.page + 1 : Math.min(pdf.numPages, pageIndex + 2),
        'aria-label': 'Page to link to',
      });
      const kind = (value, label, checked) =>
        el(
          'label',
          { class: 'choice-row' },
          el('input', { type: 'radio', name: 'link-kind', value, checked }),
          el('span', {}, label),
        );
      const isPage = initial?.page != null;
      const webChoice = kind('url', 'Web address', !isPage),
        pageChoice = kind('page', 'Page in this PDF', isPage);
      url.addEventListener('input', () => {
        webChoice.querySelector('input').checked = true;
      });
      pageNumber.addEventListener('input', () => {
        pageChoice.querySelector('input').checked = true;
      });
      const list = el(
        'div',
        { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Link target' },
        el('div', { class: 'choice-with-input' }, webChoice, url),
        el('div', { class: 'choice-with-input' }, pageChoice, pageNumber),
      );
      const form = el('form', { class: 'stack', novalidate: true }, list);
      const apply = () => {
        const web = list.querySelector('input:checked')?.value !== 'page';
        try {
          if (web) {
            if (initial && url.value === initial.url && initial.page == null) {
              dialog.close();
              return;
            }
            result = { url: normalizeUrl(url.value) };
          } else {
            const to = Number(pageNumber.value);
            if (!Number.isInteger(to) || to < 1 || to > pdf.numPages)
              throw new Error(`Choose a page between 1 and ${pdf.numPages}.`);
            result = { page: to - 1 };
          }
        } catch (error) {
          toast(error.message, { error: true });
          (web ? url : pageNumber).focus();
          return;
        }
        dialog.close();
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        apply();
      };
      const actions = [
        button('Cancel', null, () => dialog.close()),
        button(initial ? 'Save link' : 'Add link', 'Link', apply, 'btn primary'),
      ];
      if (link && !link.blocked)
        actions.unshift(
          button(
            link.url ? 'Open link' : 'Go to linked page',
            link.url ? 'ExternalLink' : 'ArrowRight',
            safe(() => {
              dialog.close();
              return followLink(link);
            }),
          ),
        );
      const dialog = modal(initial ? 'Edit link' : 'Add link', form, actions);
      dialog.addEventListener('close', () => resolve(result), { once: true });
      onOpen?.(dialog);
      (isPage ? pageNumber : url).focus();
    });
  }
  /* ---------- Crop mode ---------- */
  /** Dim everything outside the kept area and outline it. */
  function drawCropPreview(ctx, r) {
    ctx.save();
    ctx.fillStyle = 'rgba(17, 17, 17, 0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, viewport.width, viewport.height);
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.fill('evenodd');
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
    ctx.strokeRect(r.x, r.y, r.width, r.height);
    ctx.restore();
  }
  function discardCropDraft() {
    cropDraft = null;
    properties.clear('crop');
  }
  /** Show the kept area with the choice of cropping this page or all of them. */
  function renderCropDraft() {
    if (!cropDraft || cropDraft.page !== pageIndex || !viewport) return;
    const ctx = clearOverlay();
    ctx.setTransform(overlay.width / viewport.width, 0, 0, overlay.height / viewport.height, 0, 0);
    drawCropPreview(ctx, cropDraft.screen);
    const panel = el(
      'div',
      { class: 'crop-panel', role: 'group', 'aria-label': 'Crop area' },
      button(
        'Crop this page',
        'Crop',
        safe(() => applyCrop([cropDraft.page])),
        'btn primary',
      ),
      button(
        'Crop all pages',
        'Files',
        safe(() => applyCrop(Array.from({ length: pdf.numPages }, (_, i) => i))),
        'btn',
      ),
      iconButton('Discard crop area', 'X', () => {
        discardCropDraft();
        clearOverlay();
        overlay.focus({ preventScroll: true });
      }),
    );
    properties.show('crop', 'Crop', panel);
    panel.querySelector('button').focus({ preventScroll: true });
  }
  async function applyCrop(indices) {
    const draft = cropDraft;
    if (!draft || busy) return;
    // The reload after the change drops the draft; a refused crop keeps it for another try.
    await mutate(
      (doc) => cropPages(doc, indices, cropMargins(doc, draft.page, draft.rect)),
      indices.length > 1 ? `All ${indices.length} pages cropped.` : 'Page cropped.',
    );
    if (!destroyed && tool === 'crop') await setTool('select');
  }
  /** Crop by typed margins: the keyboard's way into cropping, and exact when it matters. */
  function cropDialog() {
    if (!pdf) return;
    const fields = ['top', 'right', 'bottom', 'left'].map((key) => {
      const input = el('input', {
        type: 'number',
        class: 'input',
        min: 0,
        step: 'any',
        value: 0,
        required: true,
      });
      return {
        key,
        input,
        row: labeled(`crop-${key}`, `${key[0].toUpperCase()}${key.slice(1)} (pt)`, input),
      };
    });
    const choices = pageChoices('crop-pages', pdf.numPages);
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'Trim these margins from the edges of the page as you see it. The content stays in the file; Remove crop shows the full page again.',
      ),
      el('div', { class: 'field-grid' }, ...fields.map((f) => f.row)),
      el('p', { class: 'muted' }, 'Pages'),
      choices.list,
    );
    const apply = safe(async () => {
      if (!form.reportValidity()) return;
      const margins = Object.fromEntries(fields.map((f) => [f.key, Number(f.input.value)]));
      const indices = choices.indices();
      const committed = await mutateDialog(
        d,
        (doc) => cropPages(doc, indices, margins),
        indices.length > 1 ? `All ${indices.length} pages cropped.` : 'Page cropped.',
      );
      if (committed && !destroyed && tool === 'crop') await setTool('select');
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Crop pages', form, [
      button('Cancel', null, () => d.close()),
      button('Crop', 'Crop', apply, 'btn primary'),
    ]);
    fields[0].input.focus();
  }
  function textBox(run) {
    const m = matrix(viewport.transform, run.transform);
    const size = Math.hypot(m[2], m[3]);
    return {
      x: m[4] + m[2] * run.ascent,
      y: m[5] + m[3] * run.ascent,
      size,
      width: Math.max(8, (run.advance / run.state.size) * size),
      height: Math.max(size, (run.ascent - run.descent) * size),
      transform: `matrix(${m[0] / size},${m[1] / size},${-m[2] / size},${-m[3] / size},0,0)`,
    };
  }
  const textViewportPoint = (e) => {
    const rect = paper.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) * viewport.width) / rect.width,
      ((e.clientY - rect.top) * viewport.height) / rect.height,
    ];
  };
  const textPointerPoint = (e) => viewport.convertToPdfPoint(...textViewportPoint(e));
  function textCaretAtPdfPoint(edit, point) {
    const position = viewport.convertToViewportPoint(...point);
    const rect = paper.getBoundingClientRect();
    placeTextCaret(edit.input, {
      clientX: rect.left + (position[0] * rect.width) / viewport.width,
      clientY: rect.top + (position[1] * rect.height) / viewport.height,
    });
  }
  // A dock opening on a small screen can occupy the first click's location.
  // Keep native multi-click ownership with the selected text instead of letting
  // the newly inserted properties intercept the second click (or activate Delete).
  let textClickOwner = null;
  const dockInterceptsTextClick = (e) =>
    e.detail === 2 &&
    textClickOwner?.edit === textEdit &&
    textEdit &&
    !textEdit.editing &&
    properties.root.contains(e.target);
  editorRoot.addEventListener(
    'mousedown',
    (e) => {
      if (dockInterceptsTextClick(e)) e.preventDefault();
    },
    true,
  );
  editorRoot.addEventListener(
    'click',
    (e) => {
      if (dockInterceptsTextClick(e)) {
        e.preventDefault();
        e.stopPropagation();
        const { edit, point } = textClickOwner;
        textClickOwner = null;
        setTextEditing(edit, true);
        revealEditor(edit.input);
        textCaretAtPdfPoint(edit, point);
      } else if (e.detail === 1) {
        textClickOwner =
          textEdit && e.target.closest('.text-targets, .text-edit-handles')
            ? { edit: textEdit, point: textPointerPoint(e) }
            : null;
      }
    },
    true,
  );
  function cancelTextSelection() {
    textSelectionVersion++;
    textClickOwner = null;
    textPointer?.edit?.positionControl.cancel();
    textPointer = null;
  }
  function beginTextSelection(e, run) {
    if (tool !== 'select' || busy || !pageReady || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    cancelTextSelection();
    const request = (textPointer = {
      start: e,
      last: e,
      from: textPointerPoint(e),
      page: pageIndex,
      ended: false,
      editingPoint: null,
      edit: null,
      focusFrom: document.activeElement,
    });
    textTargets.setPointerCapture(e.pointerId);
    safe(async () => {
      let edit;
      try {
        edit = await textDialog(null, run, { editing: false, reveal: false });
      } finally {
        if (!edit && textPointer === request) textPointer = null;
      }
      if (textPointer !== request || !edit || request.page !== pageIndex || tool !== 'select')
        return;
      request.edit = edit;
      const focus =
        canFocusSelection(request.focusFrom) ||
        edit.handles.contains(document.activeElement) ||
        edit.input.contains(document.activeElement);
      edit.positionControl.begin(request.start, { capture: false, from: request.from, focus });
      edit.positionControl.drag(request.last);
      if (request.editingPoint) setTextEditing(edit, true, request.editingPoint, { focus });
      if (request.ended) {
        textPointer = null;
        edit.positionControl.end(request.last);
      }
    })();
  }
  workspace.addEventListener(
    'pointerdown',
    (e) => {
      const request = textPointer;
      if (
        !request?.ended ||
        e.button !== 0 ||
        !e.isPrimary ||
        e.timeStamp - request.start.timeStamp > 500 ||
        Math.hypot(e.clientX - request.start.clientX, e.clientY - request.start.clientY) > 4
      )
        return;
      // Own the second press at the workspace level: saving the preceding box
      // clears its text targets during rendering, so this press may hit the page
      // underneath. It must still edit the pending selection, not deselect it.
      e.preventDefault();
      e.stopPropagation();
      request.editingPoint = e;
    },
    true,
  );
  textTargets.addEventListener('pointermove', (e) => {
    if (textPointer?.start.pointerId !== e.pointerId || textPointer.ended) return;
    textPointer.last = e;
    textPointer.edit?.positionControl.drag(e);
  });
  textTargets.addEventListener('pointerup', (e) => {
    const request = textPointer;
    if (request?.start.pointerId !== e.pointerId || request.ended) return;
    request.last = e;
    request.ended = true;
    if (request.edit) {
      textPointer = null;
      request.edit.positionControl.end(e);
    }
  });
  textTargets.addEventListener('click', (e) => {
    if (tool !== 'select' || e.detail < 2) return;
    // The second click may arrive before the preceding text box finishes saving.
    if (textPointer) {
      textPointer.editingPoint = e;
      if (textPointer.edit) setTextEditing(textPointer.edit, true, e);
    } else if (textEdit && !textEdit.editing) setTextEditing(textEdit, true, e);
  });
  for (const type of ['pointercancel', 'lostpointercapture'])
    textTargets.addEventListener(type, (e) => {
      if (textPointer?.start.pointerId === e.pointerId && !textPointer.ended) cancelTextSelection();
    });
  function setTextEditing(edit, editing, point, { focus = true } = {}) {
    if (textEdit !== edit) return;
    edit.editing = editing;
    edit.handles.classList.toggle('is-typing', editing);
    edit.input.classList.toggle('text-object-selected', !editing);
    if (edit.input.tagName === 'TEXTAREA') edit.input.readOnly = !editing;
    else edit.input.contentEditable = String(editing);
    edit.input.setAttribute('aria-readonly', String(!editing));
    edit.input.tabIndex = editing ? 0 : -1;
    layoutTextEdit();
    if (focus && editing) {
      edit.input.focus({ preventScroll: true });
      if (point) placeTextCaret(edit.input, point);
      else edit.input.select();
    } else if (focus) edit.positionControl.handle.focus({ preventScroll: true });
    syncStyleButtons();
  }
  async function checkpointText(edit) {
    // Typing remains one native undo session. Object drags are individual document edits.
    if (textEdit !== edit || edit.editing || !pendingTextEdit()) return;
    const version = textSelectionVersion,
      page = pageIndex,
      selectedTool = tool;
    const focusedHandle = edit.handles.contains(document.activeElement)
      ? document.activeElement.getAttribute('aria-label')
      : null;
    const text = edit.input.value.replace(/\s/g, '');
    const anchor = edit.run
      ? [edit.run.transform[4] + edit.offset[0], edit.run.transform[5] + edit.offset[1]]
      : [edit.point.x, edit.point.y];
    textCheckpoint = edit;
    try {
      await finishTextEdit();
      if (
        destroyed ||
        textEdit ||
        textPointer ||
        version !== textSelectionVersion ||
        page !== pageIndex ||
        tool !== selectedTool
      )
        return;
      const candidates = textRuns.filter(
        (run) => run.editable && run.text.replace(/\s/g, '') === text,
      );
      candidates.sort(
        (a, b) =>
          Math.hypot(a.transform[4] - anchor[0], a.transform[5] - anchor[1]) -
          Math.hypot(b.transform[4] - anchor[0], b.transform[5] - anchor[1]),
      );
      if (candidates[0]) {
        const focus =
          document.activeElement === document.body || document.activeElement === overlay;
        const restored = await textDialog(null, candidates[0], {
          editing: false,
          reveal: false,
          focus,
        });
        if (focus && focusedHandle && restored)
          [...restored.handles.querySelectorAll('button')]
            .find((handle) => handle.getAttribute('aria-label') === focusedHandle)
            ?.focus({ preventScroll: true });
      }
    } finally {
      textCheckpoint = null;
      if (!textEdit) {
        properties.clear('text');
        syncStyleButtons();
        refitPage();
      }
    }
  }
  async function deselectObjects() {
    cancelTextSelection();
    await finishDrafts();
    pageImages.close();
    selectedHighlight = null;
    renderHighlightTargets();
    refitPage();
  }
  workspace.addEventListener('scroll', () => {
    // Scrolling moves the document under a stationary captured pointer. Refresh
    // from its last client position, using the page's current coordinate transform.
    textEdit?.positionControl.refresh();
    textEdit?.widthControl?.refresh();
    pageImages.refresh();
    if (gesture) updateDrawingGesture(gesture.event);
  });
  workspace.addEventListener('pointerdown', (e) => {
    // A press anywhere else lets go of a selected comment.
    if (annotationLayer.selected && !e.target.closest('.annotation-target'))
      annotationLayer.clear();
    if (e.button !== 0 || !e.isPrimary || (busy && !finishingText && !pageImages.selected)) return;
    if (
      e.target.closest(
        '.text-target, .text-edit-handles, .page-text-input, .image-target, .path-target, .image-controls button, .note-target, .highlight-target, .form-widget, .link-target, .drawing-overlay.active',
      )
    )
      return;
    if (
      !textEdit &&
      !finishingText &&
      !noteEdit &&
      !pageImages.selected &&
      !pageImages.active &&
      !selectedHighlight &&
      !textPointer
    )
      return;
    e.preventDefault();
    safe(async () => {
      const priorFocus = document.activeElement;
      await deselectObjects();
      if (
        document.activeElement === document.body ||
        document.activeElement === overlay ||
        document.activeElement === priorFocus
      )
        workspace.focus({ preventScroll: true });
    })();
  });
  function renderTextTargets() {
    textTargets.replaceChildren();
    textTargets.hidden = !['text', 'select'].includes(tool) || !access().edit;
    textTargets.classList.toggle('select-text-objects', tool === 'select');
    if (!access().edit) return;
    for (const run of textRuns) {
      if (!run.text.trim() || !run.editable) continue;
      const box = textBox(run);
      if (!Number.isFinite(box.size) || box.size < 1) continue;
      const target = el('button', {
        class: 'text-target',
        type: 'button',
        'aria-label': `Edit text: ${run.text}`,
        title: 'Edit text',
        onclick: safe(async (e) => {
          if (tool !== 'text' && e.detail) return;
          const point = e.detail ? textPointerPoint(e) : null;
          const edit = await textDialog(null, run, {
            editing: tool === 'text',
            reveal: !e.detail,
          });
          if (edit && point) {
            // A compact toolbar can lose a row when the placement button is hidden.
            // Keep the caret at the same PDF location even if the page shifts on screen.
            textCaretAtPdfPoint(edit, point);
          }
        }),
      });
      target.addEventListener('pointerdown', (e) => beginTextSelection(e, run));
      Object.assign(target.style, {
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        transform: box.transform,
      });
      textTargets.append(target);
    }
  }
  let finishingForms;
  async function finishDrafts(skipImages = false) {
    if (!skipImages) await pageImages.finish();
    await finishTextEdit();
    await finishNoteEdit();
    if (finishingForms) return finishingForms;
    if (!pageForms.draft.dirty) {
      pageForms.clearHistory();
      return;
    }
    if (busy || destroyed) throw new Error('Please wait for the current edit to finish.');
    const priorFocus = document.activeElement;
    const snapshot = pageForms.draft.snapshot();
    const values = pageForms.draft.values;
    pageForms.rememberFocus();
    pageForms.draft.reset();
    // Keep a baseline if the PDF operation is a no-op and does not trigger a reload.
    pageForms.draft.base = new Map([...snapshot.base, ...snapshot.changes]);
    finishingForms = (async () => {
      try {
        await mutate((doc) => fillFields(doc, values), null, 'fill');
        pageForms.clearError();
      } catch (error) {
        pageForms.restore(snapshot);
        pageForms.showError(error.message, {
          focus:
            document.activeElement === document.body ||
            document.activeElement === priorFocus ||
            pageForms.owns(document.activeElement),
        });
        updateStatus();
        throw error;
      } finally {
        finishingForms = null;
      }
    })();
    return finishingForms;
  }
  function finishTextEdit(apply = true) {
    if (finishingText) return finishingText;
    if (!textEdit) return Promise.resolve();
    finishingText = commitTextEdit(apply).finally(() => {
      finishingText = null;
    });
    return finishingText;
  }
  async function commitTextEdit(apply = true) {
    const edit = textEdit;
    if (!edit) return;
    if (busy) throw new Error('Please wait for the current edit to finish.');
    const priorFocus = document.activeElement;
    if (apply) {
      // Finishing from the keyboard can leave a numeric field focused. Blur it to
      // deliver its pending native change before reading the draft.
      const field = document.activeElement;
      if (edit.panel.contains(field) && field.matches('input')) field.blur();
      edit.positionControl.validate();
      edit.widthControl?.validate();
      if (hasKoreanText(edit.input.value)) {
        await ensureKoreanFontFaces(edit.input.value);
        if (textEdit !== edit) return;
        layoutTextEdit();
      }
    }
    let value = edit.input.value;
    let segments = edit.input.segments?.();
    const paragraphChanged =
      edit.run?.paragraph &&
      (value !== edit.run.text ||
        JSON.stringify(segments) !== JSON.stringify(edit.run.segments) ||
        Math.abs(edit.size - edit.run.state.size) > 1e-8 ||
        Math.abs(edit.width - edit.originalWidth) > 1e-8 ||
        edit.hex !== textColor(edit.run) ||
        styleChanged(edit));
    const fontStyle = styleChanged(edit)
      ? {
          ...(edit.bold !== edit.original.bold && { bold: edit.bold }),
          ...(edit.italic !== edit.original.italic && { italic: edit.italic }),
        }
      : undefined;
    const flow = apply && paragraphChanged ? edit.input.exportLayout() : null;
    if (flow) {
      value = flow.text;
      segments = flow.segments;
    }
    const lineOffsets =
      flow?.lineOffsets ??
      (apply && !edit.run?.paragraph && value.includes('\n')
        ? edit.input.measureLayout?.().lineOffsets
        : undefined);
    if (!apply || (!edit.run && !value.trim())) {
      clearTextPreview(edit);
      textEdit = null;
      edit.panel.remove();
      edit.input.remove();
      edit.handles.remove();
      properties.clear('text');
      syncStyleButtons();
      updateStatus();
      refitPage();
      return;
    }
    textEdit = null;
    // Keep the draft and its erased-source background over the old page until the
    // replacement is painted. Removing them first briefly resurrected the old words.
    // WebKit can keep editing a focused inert input. Release its native editing
    // focus before locking the draft, so keystrokes cannot change a value already saving.
    if (edit.input.contains(document.activeElement)) document.activeElement.blur();
    edit.input.inert = edit.panel.inert = edit.handles.inert = true;
    edit.previewController?.abort();
    edit.previewController = null;
    try {
      await mutate(
        (doc) =>
          edit.run
            ? replaceTextGroup(doc, edit.page, edit.run, value, {
                segments,
                lineOffsets,
                reflow: Boolean(flow),
                paragraph: flow
                  ? {
                      width: edit.width / edit.physicalScale / edit.widthScale,
                      leading: edit.run.paragraph.leading,
                      softBreaks: flow.softBreaks,
                    }
                  : undefined,
                size: edit.size,
                hex: edit.hex,
                offset: edit.offset,
                fontStyle,
                underline: edit.underline,
                strikethrough: edit.strikethrough,
              })
            : addText(doc, edit.page, {
                text: value,
                ...edit.point,
                size: edit.size,
                hex: edit.hex,
                rotation: edit.rotation,
                variant: textVariant(edit.bold, edit.italic),
                underline: edit.underline,
                strikethrough: edit.strikethrough,
              }),
        null,
        'edit',
        { retainScale: properties.switching },
      );
    } catch (error) {
      textEdit = edit;
      edit.input.inert = edit.panel.inert = edit.handles.inert = false;
      syncStyleButtons();
      if (!edit.background) startTextPreview(edit);
      edit.error.textContent = error.message;
      edit.error.hidden = false;
      layoutTextEdit();
      if (document.activeElement === document.body || document.activeElement === priorFocus)
        edit.input.focus();
      updateStatus();
      throw error;
    }
    clearTextPreview(edit);
    edit.panel.remove();
    edit.input.remove();
    edit.handles.remove();
    if (textCheckpoint !== edit) {
      properties.clear('text');
      syncStyleButtons();
      // A no-op commit does not reload, so apply any window resize that the draft deferred.
      refitPage();
    }
    // Return lost focus to the page. External output actions manage their own focus
    // recovery, and a control reached while saving must keep its focus.
    if (
      !destroyed &&
      document.activeElement === document.body &&
      (edit.input.contains(priorFocus) ||
        edit.panel.contains(priorFocus) ||
        edit.handles.contains(priorFocus) ||
        (!saving && !downloading))
    )
      overlay.focus({ preventScroll: true });
  }
  function textDialog(...args) {
    return selectionProperties(() => openTextEditor(...args));
  }
  async function openTextEditor(
    p,
    run = null,
    { editing = true, reveal = true, focus = true } = {},
  ) {
    const focusFrom = document.activeElement;
    const version = ++textSelectionVersion;
    if (finishingText) await finishingText;
    if (busy || !pageReady || destroyed || version !== textSelectionVersion) return;
    await finishDrafts();
    if (destroyed || version !== textSelectionVersion || !['select', 'text'].includes(tool)) return;
    pageImages.close();
    annotationLayer.clear();
    selectedHighlight = null;
    renderHighlightTargets();
    // A preceding edit reloads the PDF, so use the freshly indexed target.
    if (run)
      run = textRuns.find(
        (candidate) =>
          candidate.text === run.text &&
          candidate.transform.every((n, i) => Math.abs(n - run.transform[i]) < 0.0001),
      );
    if (!run && !p) return;
    const pageRect = paper.getBoundingClientRect();
    const box = run
      ? textBox(run)
      : {
          x: p.x,
          y: p.y - textSize * zoom * 0.85,
          size: textSize * zoom,
          width: Math.min(240, viewport.width - p.x),
          height: textSize * zoom * 1.35,
          transform: 'none',
        };
    const input = run?.parts
      ? textLineInput(run)
      : el('textarea', {
          class: 'page-text-input',
          rows: 1,
          maxlength: 5000,
          'aria-label': run ? 'Edit text' : 'Text to add',
          placeholder: run ? '' : 'Type your text',
          spellcheck: true,
          wrap: 'off',
        });
    if (!run?.parts) {
      input.value = run?.text || '';
      // Tabs from a copied table have no glyph in the text fonts; they paste as spaces.
      input.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text.includes('\t')) return;
        e.preventDefault();
        document.execCommand('insertText', false, draftText(text));
      });
    }
    Object.assign(input.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${Math.max(80, box.width + 12)}px`,
      height: `${Math.max(28, box.height + 4)}px`,
      fontSize: `${box.size}px`,
      fontFamily: run?.fontFamily || 'Noto Sans, sans-serif',
      transform: box.transform,
    });
    input.addEventListener('input', () => {
      if (textEdit?.input === input) applyDraftStyle(textEdit);
      layoutTextEdit();
      updateStatus();
    });
    input.addEventListener('keydown', (e) => {
      // Escape and Enter belong to the input method while it is composing a character.
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finishTextEdit(false);
        overlay.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        safe(() => finishTextEdit())();
      }
    });
    const error = el('p', { class: 'text-edit-error', role: 'alert', hidden: true });
    const panel = el(
      'div',
      { class: 'text-edit-actions', role: 'group', 'aria-label': 'Text properties' },
      el(
        'div',
        { class: 'text-edit-buttons' },
        button(
          'Delete',
          'Trash2',
          safe(async () => {
            input.value = '';
            await finishDrafts();
          }),
          'btn danger',
          { 'aria-label': 'Delete text' },
        ),
      ),
      error,
    );
    textEdit = {
      input,
      panel,
      error,
      run,
      editing,
      offset: [0, 0],
      page: pageIndex,
      point: p && pdfPoint(p),
      anchor: p,
      physicalScale: run
        ? (Math.hypot(run.transform[2], run.transform[3]) / run.state.size) * viewport.userUnit
        : viewport.userUnit,
      size: run?.state.size || textSize / viewport.userUnit,
      hex: run ? textColor(run) : color,
      rotation: viewport.rotation,
      bold: run ? runStyle(run, isBoldRun) : textBold,
      italic: run ? runStyle(run, isItalicRun) : textItalic,
      underline: run ? Boolean(run.underline) : textUnderline,
      strikethrough: run ? Boolean(run.strikethrough) : textStrikethrough,
    };
    textEdit.original = {
      bold: run ? textEdit.bold : false,
      italic: run ? textEdit.italic : false,
    };
    const edit = textEdit;
    applyDraftStyle(edit);
    syncStyleButtons();
    if (run?.paragraph) {
      edit.widthScale =
        Math.hypot(run.transform[0], run.transform[1]) /
        Math.hypot(run.transform[2], run.transform[3]);
      edit.width = edit.originalWidth = run.paragraph.width * edit.physicalScale * edit.widthScale;
      edit.widthControl = textWidthControls({
        input,
        getWidth: () => edit.width,
        setWidth: (width) => {
          edit.width = Math.abs(width - edit.originalWidth) < 0.0005 ? edit.originalWidth : width;
        },
        zoom,
        pointAt: textViewportPoint,
        edited: updateStatus,
        completed: safe(() => checkpointText(edit)),
        changed: () => {
          layoutTextEdit();
          updateStatus();
        },
      });
      panel.prepend(edit.widthControl.root);
    }
    edit.positionControl = textPositionControls({
      getPosition: () =>
        edit.run
          ? [edit.run.transform[4] + edit.offset[0], edit.run.transform[5] + edit.offset[1]]
          : [edit.point.x, edit.point.y],
      setPosition: ([x, y]) => {
        if (edit.run) edit.offset = [x - edit.run.transform[4], y - edit.run.transform[5]];
        else {
          edit.point = { x, y };
          const p = viewport.convertToViewportPoint(x, y);
          edit.anchor = { x: p[0], y: p[1] };
        }
      },
      viewport,
      edited: updateStatus,
      completed: safe(() => checkpointText(edit)),
      dragThreshold: 3,
      pointAt: textPointerPoint,
      changed: () => {
        layoutTextEdit();
        updateStatus();
      },
    });
    panel.prepend(edit.positionControl.root);
    const onTextKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finishTextEdit(false);
        overlay.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        safe(() => finishTextEdit())();
      } else if (
        e.target === edit.positionControl.handle &&
        (e.key === 'Enter' || e.key === 'F2')
      ) {
        e.preventDefault();
        setTextEditing(edit, true);
      } else if (
        e.target === edit.positionControl.handle &&
        ['Delete', 'Backspace'].includes(e.key)
      ) {
        e.preventDefault();
        input.value = '';
        safe(() => finishTextEdit())();
      }
    };
    edit.handles = el(
      'div',
      { class: 'text-edit-handles' },
      edit.positionControl.handle,
      edit.widthControl?.handle,
    );
    panel.addEventListener('keydown', onTextKey);
    edit.handles.addEventListener('keydown', onTextKey);
    const editOnDoubleClick = (e) => {
      if (!edit.editing) setTextEditing(edit, true, e);
    };
    edit.positionControl.handle.addEventListener('dblclick', editOnDoubleClick);
    edit.positionControl.handle.addEventListener('click', (e) => {
      if (e.detail > 1) editOnDoubleClick(e);
    });
    paper.append(input, edit.handles);
    properties.show('text', 'Text', panel);
    startTextPreview(edit);
    if (run) {
      const physicalSize = Number((textEdit.size * textEdit.physicalScale).toFixed(2));
      if (![...sizeInput.options].some((option) => Number(option.value) === physicalSize)) {
        const larger = [...sizeInput.options].find((option) => Number(option.value) > physicalSize);
        sizeInput.insertBefore(
          el('option', { value: physicalSize }, `${physicalSize} pt`),
          larger || null,
        );
      }
      sizeInput.value = String(physicalSize);
      textSize = physicalSize;
      colorInput.value = /^#[0-9a-f]{6}$/i.test(textEdit.hex) ? textEdit.hex : '#111111';
      color = colorInput.value;
    }
    setTextEditing(edit, editing, undefined, { focus: focus && canFocusSelection(focusFrom) });
    if (reveal) revealEditor(input);
    else {
      // Contextual controls can add a toolbar row on small screens. Keep the object
      // under the pointer so a drag or the second click of a double-click stays on it.
      const current = paper.getBoundingClientRect();
      workspace.scrollTop += current.top - pageRect.top;
      workspace.scrollLeft += current.left - pageRect.left;
    }
    updateStatus();
    return edit;
  }
  function layoutTextEdit() {
    if (!textEdit) return;
    const edit = textEdit;
    const box = edit.run
      ? textBox({
          ...edit.run,
          transform: edit.run.transform.map((n, i) =>
            i < 4 ? (n * edit.size) / edit.run.state.size : n + edit.offset[i - 4],
          ),
        })
      : {
          x: edit.anchor.x,
          y: edit.anchor.y - edit.size * viewport.userUnit * zoom * 0.85,
          size: edit.size * viewport.userUnit * zoom,
          width: 120,
          height: edit.size * viewport.userUnit * zoom * 1.35,
          transform: 'none',
        };
    const lines = edit.input.value.split('\n');
    // An empty draft shows its placeholder, which must fit too: a textarea that cannot wrap
    // would otherwise clip the hint and grow a scrollbar before anything is typed.
    const shown = edit.input.value ? lines : [edit.input.placeholder || ''];
    const measure = document.createElement('canvas').getContext('2d');
    const face = draftFace(edit);
    measure.fontKerning = 'none';
    measure.font = `${face.style} ${face.weight} ${box.size}px ${face.family || 'sans-serif'}`;
    // A single run keeps Tc/Tw in text-space units when its font size changes. Match
    // those distances in the draft and its width measurement, including page transforms.
    if (edit.run && !edit.run.parts) {
      const scale = box.size / edit.size;
      const letterSpacing = `${edit.run.state.charSpacing * scale}px`;
      const wordSpacing = `${
        !styleChanged(edit) && edit.run.widths.get(' ')?.space
          ? edit.run.state.wordSpacing * scale
          : 0
      }px`;
      Object.assign(edit.input.style, { letterSpacing, wordSpacing });
      Object.assign(measure, { letterSpacing, wordSpacing });
    }
    const metrics = measure.measureText('Mg');
    const lineHeight = box.size * 1.35;
    const ascent = metrics.fontBoundingBoxAscent ?? box.size * 0.9;
    const descent = metrics.fontBoundingBoxDescent ?? box.size * 0.2;
    const baselineOffset = ascent + (lineHeight - ascent - descent) / 2;
    const adjustment = box.size * (edit.run?.ascent || 0.85) - baselineOffset;
    const transform = new DOMMatrix(box.transform === 'none' ? undefined : box.transform);
    // Limit along the text's advance direction, including leftward and vertical writing on rotated pages.
    const availableWidth = Math.max(
      80,
      Math.min(
        ...[
          [transform.a, box.x, viewport.width],
          [transform.b, box.y, viewport.height],
        ]
          .filter(([direction]) => Math.abs(direction) > 1e-8)
          .map(([direction, start, limit]) =>
            direction > 0 ? (limit - start - 4) / direction : (start - 4) / -direction,
          ),
      ),
    );
    const paragraphWidth = edit.run?.paragraph && (edit.width / edit.widthScale) * zoom;
    edit.widthControl?.sync(Math.max(24, (availableWidth / zoom) * edit.widthScale));
    const characterWidths = new Map();
    const characterWidth = (char) => {
      if (!characterWidths.has(char)) characterWidths.set(char, measure.measureText(char).width);
      return characterWidths.get(char);
    };
    const width =
      paragraphWidth ||
      Math.max(
        80,
        box.width + 8,
        ...shown.map((line) => {
          // Canvas has no ligature switch. Summing individual standard-font letters
          // matches the draft's separate glyphs, including its character spacing.
          const width =
            face.ligatures === 'none'
              ? [...line].reduce((sum, char) => sum + characterWidth(char), 0)
              : measure.measureText(line).width;
          return width + 12;
        }),
      );
    Object.assign(edit.input.style, {
      left: `${box.x + transform.c * adjustment}px`,
      top: `${box.y + transform.d * adjustment}px`,
      width: `${Math.min(width, availableWidth)}px`,
      height: `${Math.max(28, box.height + 6, lines.length * box.size * 1.35 + 6)}px`,
      fontSize: `${box.size}px`,
      fontWeight: draftFace(edit).weight,
      fontStyle: draftFace(edit).style,
      color: edit.hex,
      textDecorationLine:
        [edit.underline && 'underline', edit.strikethrough && 'line-through']
          .filter(Boolean)
          .join(' ') || 'none',
      transform: box.transform,
    });
    edit.input.updateStyle?.(
      edit.hex,
      box.size,
      styleChanged(edit) ? (run) => draftFace(edit, run) : undefined,
    );
    const richLayout = edit.input.measureLayout?.();
    if (richLayout) {
      const shift = box.size * edit.run.ascent - richLayout.baseline;
      Object.assign(edit.input.style, {
        left: `${box.x + transform.c * shift}px`,
        top: `${box.y + transform.d * shift}px`,
        width: `${Math.min(paragraphWidth || Math.max(80, box.width + 8, richLayout.width + 12), availableWidth)}px`,
        height: `${Math.max(28, box.height + 6, richLayout.height + 6)}px`,
      });
    }
    if (edit.run?.state.mode === 1 || edit.run?.state.mode === 2) {
      const run = edit.run;
      // PDF.js strokes in text-matrix space, independently of the selected font size.
      const matrixScale = Math.hypot(run.state.tm[0], run.state.tm[1]);
      const strokeWidth =
        run.strokeWidth && matrixScale
          ? (run.strokeWidth / matrixScale) * edit.physicalScale * zoom
          : Math.max(Math.hypot(transform.a, transform.c), Math.hypot(transform.b, transform.d)) /
            Math.abs(transform.a * transform.d - transform.b * transform.c) /
            pagePixelRatio;
      // Leave room for the outline and antialiasing without shifting the glyph baseline.
      const padding = strokeWidth / 2 + 1;
      Object.assign(edit.input.style, {
        webkitTextFillColor: run.state.mode === 1 ? 'transparent' : edit.hex,
        webkitTextStrokeColor: edit.hex === textColor(run) ? run.strokeColor : edit.hex,
        webkitTextStrokeWidth: `${strokeWidth}px`,
        caretColor: edit.hex,
        padding: `${padding}px`,
        left: `${parseFloat(edit.input.style.left) - padding * (transform.a + transform.c)}px`,
        top: `${parseFloat(edit.input.style.top) - padding * (transform.b + transform.d)}px`,
        width: `${parseFloat(edit.input.style.width) + padding * 2}px`,
        height: `${parseFloat(edit.input.style.height) + padding * 2}px`,
      });
    }
    // The selection frame shares the text's own transform, including rotation and skew.
    for (const key of ['left', 'top', 'width', 'height', 'transform'])
      edit.handles.style[key] = edit.input.style[key];
  }
  async function placeCentered() {
    if (tool === 'field') {
      if (busy || !pageReady) return;
      const center = pdfPoint({ x: viewport.width / 2, y: viewport.height / 2 });
      const size = ['checkbox', 'radio'].includes(fieldType) ? [14, 14] : [160, 22];
      await createField(
        { x: center.x - size[0] / 2, y: center.y - size[1] / 2, width: size[0], height: size[1] },
        pageIndex,
      );
      return;
    }
    if (tool === 'certsign') {
      if (busy || !pageReady) return;
      const center = pdfPoint({ x: viewport.width / 2, y: viewport.height / 2 });
      await signWithCertificate({
        rect: { x: center.x - 100, y: center.y - 30, width: 200, height: 60 },
        page: pageIndex,
      });
      return;
    }
    if (tool === 'link') {
      if (busy || !pageReady) return;
      const center = pdfPoint({ x: viewport.width / 2, y: viewport.height / 2 });
      await placeLink({ x: center.x - 80, y: center.y - 14, width: 160, height: 28 }, pageIndex);
      return;
    }
    if (!pageReady || busy) return;
    if (tool === 'text') return textDialog({ x: viewport.width * 0.25, y: viewport.height / 2 });
    if (tool === 'note')
      return openNoteEditor({ point: { x: viewport.width * 0.45, y: viewport.height * 0.45 } });
    if (['textbox', 'callout', 'cshape'].includes(tool)) {
      // As if clicked (a text box or callout) or dragged (a shape) about the page's middle.
      const unit = screenUnit();
      const start =
        tool === 'textbox'
          ? { x: viewport.width / 2 - 90 * unit, y: viewport.height / 2 - 25 * unit }
          : { x: viewport.width * (tool === 'callout' ? 0.3 : 0.35), y: viewport.height * 0.5 };
      const end =
        tool === 'cshape' ? { x: viewport.width * 0.65, y: viewport.height * 0.6 } : start;
      return placeComment(
        {
          type: tool,
          start,
          page: pageIndex,
          hex: color,
          width: stroke / viewport.userUnit,
          commentKind: commentShape.value,
        },
        end,
      );
    }
    if (['highlight', 'shape'].includes(tool)) {
      const a = pdfPoint({ x: viewport.width * 0.25, y: viewport.height * 0.48 });
      const b = pdfPoint({
        x: viewport.width * 0.75,
        y: viewport.height * (tool === 'highlight' ? 0.51 : 0.65),
      });
      await mutate(
        (doc) =>
          drawOrRedact(doc, pageIndex, {
            type: tool,
            kind: markupKind.value,
            shape: shapeSelect.value,
            hex: color,
            width: stroke / viewport.userUnit,
            rect: normalizeRect(a, b),
            from: a,
            to: b,
          }),
        null,
        tool === 'highlight' && markupKind.value !== 'redact' ? 'annotate' : 'edit',
      );
    }
  }
  /** Draw a mark, or, for the Redact tool's area marks, add a redaction mark over it. */
  async function drawOrRedact(doc, page, mark) {
    if (mark.type !== 'highlight' || mark.kind !== 'redact') return drawMark(doc, page, mark);
    const { x, y, width, height } = mark.rect;
    const { addRedactionMarks } = await loadRedaction();
    return addRedactionMarks(doc, page, [[x, y, x + width, y + height]], redactionStyle);
  }
  async function renderObjectPreview(
    bytes,
    pageIndex,
    background,
    signal,
    { view, width, height, ratio },
  ) {
    signal.throwIfAborted();
    const task = loadPdf(bytes);
    let rendering;
    const abort = () => {
      rendering?.cancel();
      task.destroy().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const page = await (await task.promise).getPage(pageIndex + 1);
      signal.throwIfAborted();
      const vp = background ? view : page.getViewport({ scale: 1 });
      const out = el('canvas', {
        width: background ? width : Math.ceil(vp.width),
        height: background ? height : Math.ceil(vp.height),
      });
      rendering = page.render({
        canvasContext: out.getContext('2d'),
        viewport: vp,
        ...(background
          ? { transform: [ratio, 0, 0, ratio, 0, 0] }
          : { background: 'rgba(0,0,0,0)' }),
      });
      await rendering.promise;
      return out;
    } finally {
      signal.removeEventListener('abort', abort);
      await task.destroy();
    }
  }
  function clearTextPreview(edit) {
    edit?.previewController?.abort();
    edit?.background?.remove();
    if (edit) {
      edit.previewController = null;
      edit.background = null;
      edit.input.classList.remove('has-text-preview');
    }
  }
  function startTextPreview(edit) {
    if (!edit.run) return;
    clearTextPreview(edit);
    const controller = (edit.previewController = new AbortController()),
      signal = controller.signal;
    const bytes = session.bytes.slice(),
      geometry = {
        view: viewport,
        width: canvas.width,
        height: canvas.height,
        ratio: pagePixelRatio,
      };
    (async () => {
      const doc = await PDFDocument.load(bytes);
      signal.throwIfAborted();
      await replaceTextGroup(doc, edit.page, edit.run, '');
      const background = await renderObjectPreview(
        await savePdf(doc),
        edit.page,
        true,
        signal,
        geometry,
      );
      if (signal.aborted || textEdit !== edit) return;
      background.className = 'text-draft-background';
      background.style.width = `${geometry.view.width}px`;
      background.style.height = `${geometry.view.height}px`;
      edit.background = background;
      paper.append(background);
      edit.input.classList.add('has-text-preview');
    })().catch(() => {});
  }
  async function prepareImagePreview(entry, signal) {
    const source = editDocument,
      bytes = session.bytes.slice(),
      index = pageIndex;
    const view = viewport,
      width = canvas.width,
      height = canvas.height,
      ratio = pagePixelRatio;
    const imageBytes = await (entry.kind && entry.kind !== 'image' ? pathPreview : imagePreview)(
      source,
      entry,
    );
    const copy = await PDFDocument.load(bytes);
    signal.throwIfAborted();
    (entry.kind && entry.kind !== 'image' ? editPath : editImage)(copy, index, entry, {
      remove: true,
    });
    const without = await savePdf(copy);
    signal.throwIfAborted();
    const [background, image] = await Promise.all([
      renderObjectPreview(without, index, true, signal, { view, width, height, ratio }),
      renderObjectPreview(imageBytes, 0, false, signal, { view, width, height, ratio }),
    ]);
    return { background, image };
  }
  async function insertImage() {
    requireAccess('edit');
    try {
      await finishDrafts();
    } catch {
      return;
    }
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg' });
    input.onchange = safe(async () => {
      const file = input.files[0];
      if (!file || busy) return;
      if (file.size > MAX_IMAGE_SIZE) throw new Error('Choose an image smaller than 20 MB.');
      await setTool('select');
      const index = pageIndex,
        priorFocus = document.activeElement;
      await mutate(async (doc) => {
        // Reading belongs to the edit: output and navigation must wait for the chosen
        // image just as they wait for embedding and rendering it.
        const bytes = new Uint8Array(await file.arrayBuffer());
        await addImage(doc, index, bytes);
      }, 'Image added. Drag to move or resize it.');
      const entry = imageRunCache
        .get(pageIndex)
        ?.filter((entry) => entry.kind === 'image')
        .at(-1);
      if (entry)
        pageImages.selectOrdinal(
          entry.ordinal,
          document.activeElement === document.body || document.activeElement === priorFocus,
        );
    });
    input.click();
  }
  /* ---------- Sticky notes ---------- */
  const pendingNoteEdit = () =>
    !!noteEdit &&
    !noteEdit.entry?.readOnly &&
    (noteEdit.textarea.value.trim() !== (noteEdit.entry?.text || '') ||
      (!!noteEdit.entry && noteEdit.color.value !== noteEdit.entry.hex));
  /** Clickable icons for the page's notes, shown in Select and with the Note tool. */
  function renderNoteTargets() {
    noteTargets.replaceChildren();
    noteTargets.hidden = !['select', 'note'].includes(tool);
    if (!viewport) return;
    for (const entry of notes) {
      const corners = [
        viewport.convertToViewportPoint(entry.x, entry.y),
        viewport.convertToViewportPoint(entry.x + entry.width, entry.y - entry.height),
      ];
      const left = Math.min(corners[0][0], corners[1][0]),
        top = Math.min(corners[0][1], corners[1][1]);
      const target = el('button', {
        class: 'note-target',
        type: 'button',
        'aria-label': `${entry.readOnly || !access().annotate ? 'Read' : 'Edit'} note: ${entry.text.slice(0, 80)}`,
        title: entry.text.slice(0, 200),
        'aria-pressed': noteEdit?.entry?.id === entry.id,
        'data-note-id': entry.id,
        onclick: safe(() =>
          selectionProperties(async () => {
            if (busy || !pageReady) return;
            if (noteEdit?.entry?.id === entry.id) return;
            const focusFrom = document.activeElement;
            cancelTextSelection();
            const ordinal = notes.indexOf(entry);
            await finishDrafts();
            pageImages.close();
            selectedHighlight = null;
            renderHighlightTargets();
            // A shared thread can acquire new IDs while the previous note is committed.
            await openNoteEditor({
              entry: notes.find((note) => note.id === entry.id) || notes[ordinal],
              canFocus: () => canFocusSelection(focusFrom),
            });
          }),
        ),
      });
      Object.assign(target.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.abs(corners[1][0] - corners[0][0])}px`,
        height: `${Math.abs(corners[1][1] - corners[0][1])}px`,
      });
      // A note without its own appearance would be invisible on the canvas; show an icon.
      if (!entry.hasAppearance) {
        target.classList.add('no-appearance');
        target.style.setProperty('--note-color', entry.hex);
        target.style.setProperty('--note-ink', contrastInk(entry.hex));
        target.append(icon('StickyNote', 16, { plain: true }));
      }
      noteTargets.append(target);
    }
  }
  /** Open note properties while its icon remains selected on the page. */
  function openNoteEditor(options) {
    return selectionProperties(() => showNoteEditor(options));
  }
  async function showNoteEditor({ point, entry, canFocus }) {
    if (busy || !pageReady) return;
    const focusFrom = document.activeElement;
    canFocus ??= () => canFocusSelection(focusFrom);
    cancelTextSelection();
    await finishDrafts();
    if (busy || !pageReady || destroyed || (!point && !entry)) return;
    pageImages.close();
    annotationLayer.clear();
    selectedHighlight = null;
    renderHighlightTargets();
    const textarea = el('textarea', {
      class: 'input note-text',
      rows: 4,
      maxlength: 5000,
      placeholder: 'Write a note',
      'aria-label': entry ? 'Note text' : 'New note text',
      spellcheck: true,
    });
    textarea.value = entry?.text || '';
    const colorPick = el('input', {
      type: 'color',
      value: entry?.hex || toolColors.note,
      'aria-label': 'Note color',
    });
    const when = entry?.modified?.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const meta =
      entry && (entry.author || when)
        ? el('p', { class: 'note-meta muted' }, [entry.author, when].filter(Boolean).join(' · '))
        : null;
    const error = el('p', { class: 'text-edit-error', role: 'alert', hidden: true });
    const readOnly = !!entry?.readOnly || !access().annotate;
    textarea.readOnly = readOnly || !!entry?.contentsLocked;
    colorPick.disabled = readOnly || !!entry?.propertiesLocked;
    const panel = el(
      'div',
      {
        class: 'note-editor',
        role: 'group',
        'aria-label': entry ? (readOnly ? 'Read note' : 'Edit note') : 'New note',
      },
      meta,
      textarea,
      entry?.contentsLocked && el('p', { class: 'muted' }, 'Text is locked for this note.'),
      error,
      el(
        'div',
        { class: 'note-editor-actions' },
        colorPick,
        button(
          'Close',
          'X',
          safe(() => finishNoteEdit()),
          'btn',
          { 'aria-label': 'Close note' },
        ),
        entry &&
          !readOnly &&
          !entry.propertiesLocked &&
          button(
            'Delete',
            'Trash2',
            safe(() => finishNoteEdit(true)),
            'btn danger',
            { 'aria-label': 'Delete note' },
          ),
      ),
    );
    panel.addEventListener('keydown', (e) => {
      // Input-method confirmation and cancellation must leave the note draft intact.
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeNoteEditor();
        overlay.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        safe(() => finishNoteEdit())();
      }
    });
    textarea.addEventListener('input', updateStatus);
    noteEdit = {
      entry,
      point: entry ? { x: entry.x, y: entry.y } : pdfPoint(point),
      panel,
      textarea,
      color: colorPick,
      error,
      page: pageIndex,
    };
    properties.show('note', entry ? 'Note' : 'New note', panel);
    renderNoteTargets();
    if (canFocus()) textarea.focus({ preventScroll: true });
    updateStatus();
  }
  function closeNoteEditor() {
    const open = noteEdit;
    if (!open) return;
    noteEdit = null;
    open.panel.remove();
    properties.clear('note');
    renderNoteTargets();
    updateStatus();
  }
  /** Save the open note (or remove it) and close its panel; an untouched note just closes. */
  async function finishNoteEdit(remove = false) {
    const edit = noteEdit;
    if (!edit) return;
    if (busy) throw new Error('Please wait for the current edit to finish.');
    const priorFocus = document.activeElement;
    const returnFocus = () => {
      if (
        document.activeElement === document.body &&
        (edit.panel.contains(priorFocus) || (!saving && !downloading))
      )
        overlay.focus({ preventScroll: true });
    };
    const text = edit.textarea.value.trim(),
      hex = edit.color.value;
    const untouched =
      !access().annotate ||
      edit.entry?.readOnly ||
      (!edit.entry && !text) ||
      (edit.entry && text === edit.entry.text && hex === edit.entry.hex);
    if (!remove && untouched) {
      closeNoteEditor();
      returnFocus();
      return;
    }
    noteEdit = null;
    // Keep the dock in place until the edit finishes. Collapsing it while saving
    // expands the workspace and clamps its scroll position, even if the edit fails.
    // WebKit can retain a textarea's native editing focus after it becomes inert.
    if (edit.panel.contains(document.activeElement)) document.activeElement.blur();
    edit.panel.inert = true;
    try {
      await mutate(
        (doc) =>
          edit.entry
            ? editNote(doc, edit.page, edit.entry.id, remove ? { remove: true } : { text, hex })
            : addNote(doc, edit.page, {
                x: edit.point.x,
                y: edit.point.y,
                text,
                hex,
                author: getUser()?.username || '',
              }),
        null,
        'annotate',
        { retainScale: true },
      );
    } catch (error) {
      noteEdit = edit;
      edit.panel.inert = false;
      properties.show('note', edit.entry ? 'Note' : 'New note', edit.panel);
      edit.error.textContent = error.message;
      edit.error.hidden = false;
      if (document.activeElement === document.body || document.activeElement === priorFocus)
        edit.textarea.focus({ preventScroll: true });
      updateStatus();
      throw error;
    }
    edit.panel.remove();
    properties.clear('note');
    if (!remove) toolColors.note = hex;
    returnFocus();
  }
  /** Ask for a signature and place it in the middle of the page, selected and ready to drag. */
  async function insertSignature() {
    const version = beginDialogRequest();
    requireAccess('edit');
    if (busy || !pageReady) return;
    await finishDrafts();
    if (!canOpenDialog(version)) return;
    const choice = await signatureDialog(dialogOptions);
    if (!choice || destroyed || busy || !pageReady) return;
    const { signature, hex, outline } = choice;
    // About a third of the page across, in the middle, upright however the page is rotated.
    const pointsAcross = viewport.width / (zoom * viewport.userUnit);
    const width = Math.min(320, Math.max(120, pointsAcross * 0.35)),
      height = width * 0.4;
    const center = pdfPoint({ x: viewport.width / 2, y: viewport.height / 2 });
    const target = { x: center.x - width / 2, y: center.y - height / 2, width, height };
    const rotation = viewport.rotation,
      index = pageIndex;
    await setTool('select');
    const priorFocus = document.activeElement;
    await mutate(
      (doc) => drawSignature(doc, index, signature, target, { hex, outline, rotation }),
      'Signature added. Drag to move or resize it.',
    );
    const entry = imageRunCache
      .get(pageIndex)
      ?.filter((entry) => (signature.type === 'image') === (entry.kind === 'image'))
      .at(-1);
    if (entry)
      pageImages.selectOrdinal(
        entry.ordinal,
        document.activeElement === document.body || document.activeElement === priorFocus,
      );
  }
  /** A stamp lands centered like a signature and is selected for moving and resizing. */
  async function insertStamp() {
    const version = beginDialogRequest();
    requireAccess('edit');
    if (busy || !pageReady) return;
    await finishDrafts();
    if (!canOpenDialog(version) || busy || !pageReady) return;
    const pointsAcross = viewport.width / (zoom * viewport.userUnit);
    const width = Math.min(260, Math.max(110, pointsAcross * 0.32)),
      height = width * 0.45;
    const choice = await stampDialog({ ...dialogOptions, size: { width, height } });
    if (!choice || destroyed || busy || !pageReady) return;
    const center = pdfPoint({ x: viewport.width / 2, y: viewport.height / 2 });
    const target = { x: center.x - width / 2, y: center.y - height / 2, width, height };
    const rotation = viewport.rotation,
      index = pageIndex;
    await setTool('select');
    const priorFocus = document.activeElement;
    await mutate(
      (doc) => drawStamp(doc, index, choice, target, { rotation }),
      'Stamp added. Drag to move or resize it.',
    );
    const entry = imageRunCache
      .get(pageIndex)
      ?.filter((entry) => entry.kind !== 'image')
      .at(-1);
    if (entry)
      pageImages.selectOrdinal(
        entry.ordinal,
        document.activeElement === document.body || document.activeElement === priorFocus,
      );
  }
  /**
   * The working copy for a dialog to read, or null when the editor closed or the document
   * changed while it was being parsed, so a dialog never opens over the library or on a stale
   * copy after a quick Back, Undo, or edit.
   */
  async function workingDocument(version = dialogVersion()) {
    const revision = session.revision;
    const doc = editDocument || (await PDFDocument.load(session.bytes, { updateMetadata: false }));
    if (!canOpenDialog(version) || busy || session.revision !== revision) return null;
    editDocument = doc;
    return doc;
  }
  async function formDialog() {
    const version = beginDialogRequest();
    requireAccess('fill');
    if (busy) return;
    await finishDrafts();
    const doc = await workingDocument(version);
    if (!doc) return;
    const fields = listFields(doc);
    if (!fields.length) {
      toast('This PDF has no fillable fields. Use Text to write on the page.');
      return;
    }
    const controls = new Map();
    const changed = new WeakSet();
    const form = el(
      'form',
      {
        class: 'stack',
        oninput: (event) => changed.add(event.target),
        onchange: (event) => changed.add(event.target),
      },
      el(
        'p',
        { class: 'muted' },
        'Complete the PDF’s existing form fields. Changes apply when you save the form.',
      ),
    );
    fields.forEach((field, i) => {
      if (field.type === 'unsupported') {
        form.append(
          el(
            'p',
            { class: 'muted' },
            `${field.tooltip || field.name}: this field type is not editable here.`,
          ),
        );
        return;
      }
      const id = `field-${i}`;
      let control, inputOptions;
      if (field.type === 'checkbox')
        control = el('input', {
          type: 'checkbox',
          id,
          checked: field.value,
          disabled: field.readOnly,
        });
      else if (field.editableChoice) {
        inputOptions = choiceInputOptions(field.choices);
        const list = `${id}-options`;
        control = el('input', {
          id,
          type: 'text',
          class: 'input',
          list,
          placeholder: 'Choose or type an option',
          autocomplete: 'off',
          spellcheck: String(field.spellcheck),
          disabled: field.readOnly,
        });
        const selected = Array.isArray(field.value) ? field.value[0] : field.value;
        control.value =
          selected == null
            ? ''
            : inputOptions.find((choice) => choice.value === selected)?.label ||
              selected ||
              '(Empty option)';
        form.append(
          el(
            'datalist',
            { id: list },
            ...inputOptions.map((choice) => el('option', { value: choice.label })),
          ),
        );
      } else if (field.type === 'select')
        control = el(
          'select',
          { id, class: 'input', multiple: field.multiple, disabled: field.readOnly },
          !field.multiple &&
            el('option', { value: '', 'data-placeholder': true }, 'Choose an option'),
          ...field.options.map((option) =>
            el(
              'option',
              {
                value: option,
                selected: Array.isArray(field.value)
                  ? field.value.includes(option)
                  : option === field.value,
              },
              field.choices?.find((choice) => choice.value === option)?.label ||
                option ||
                '(Empty option)',
            ),
          ),
        );
      else {
        control = el(field.multiline ? 'textarea' : 'input', {
          id,
          type: field.multiline ? null : field.password ? 'password' : 'text',
          class: 'input',
          maxlength: field.maxLength,
          disabled: field.readOnly,
          autocomplete: field.password ? 'off' : null,
          spellcheck: String(field.spellcheck),
        });
        control.value = field.value;
      }
      controls.set(field.name, { control, field, inputOptions });
      form.append(
        el(
          'div',
          { class: field.type === 'checkbox' ? 'checkbox-row' : 'field' },
          // A tooltip is the form author's label for people; field names are often codes.
          el(
            'label',
            { for: id, title: field.tooltip ? field.name : null },
            (field.tooltip || field.name) + (field.readOnly ? ' (read only)' : ''),
          ),
          control,
        ),
      );
    });
    const apply = safe(async () => {
      if (!form.reportValidity()) return;
      const values = Object.create(null);
      controls.forEach(({ control, field, inputOptions }, key) => {
        // Native controls can normalize the source value without any user edit.
        if (field.readOnly || !changed.has(control)) return;
        if (field.type === 'checkbox') values[key] = control.checked;
        else if (field.editableChoice)
          values[key] = control.value
            ? [
                inputOptions.find((choice) => choice.label === control.value)?.value ??
                  control.value,
              ]
            : [];
        else if (field.type === 'select')
          values[key] = [...control.selectedOptions]
            .filter((o) => !o.hasAttribute('data-placeholder'))
            .map((o) => o.value);
        else values[key] = control.value;
      });
      await mutateDialog(d, (doc) => fillFields(doc, values), 'Form saved.', 'fill');
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Fill forms', form, [
      button('Cancel', null, () => d.close()),
      button('Save form', 'Check', apply, 'btn primary'),
    ]);
  }
  /** Resolve after page operations and queued history, including their redraws, settle. */
  const idle = (includeHistory = true) =>
    new Promise((resolve) => {
      const check = () =>
        !destroyed && (busy || (includeHistory && pendingHistory))
          ? setTimeout(check, 50)
          : resolve();
      check();
    });
  /** A question with a few answers: the chosen value, or 'cancel' when the dialog is dismissed. */
  function choose(title, message, choices) {
    return new Promise((resolve) => {
      const d = modal(
        title,
        el('p', {}, message),
        choices.map(([label, value, style]) =>
          button(
            label,
            null,
            () => {
              resolve(value);
              d.close();
            },
            style,
          ),
        ),
      );
      d.addEventListener('close', () => resolve('cancel'), { once: true });
    });
  }
  const reasonOf = (error) =>
    String(error?.message || error?.error?.message || (typeof error === 'string' ? error : ''))
      .trim()
      .replace(/\.$/, '');
  /**
   * Before a save replaces the cloud file this PDF came from, check it is still that file as
   * it was read or last written here. Someone may have saved it since from another window or
   * device, or moved, renamed, or deleted it. A file that moved is followed (it keeps its id);
   * anything else is put to the reader, since overwriting would quietly lose someone's work.
   * Resolves `{ path, name }` to write, null to save a new copy instead, or false to stop.
   */
  async function confirmDestination(target, signal) {
    const here = { path: target, name };
    if (!remote?.modified || !P.canStat()) return here;
    const look = (what) =>
      waitFor(() => P.statFile(what), signal).catch((error) => {
        if (signal.aborted) throw error;
        // A check that cannot be made is no reason to refuse the save: the write itself
        // reports a real failure.
        return undefined;
      });
    let file = await look(target),
      moved = false;
    if (file === undefined) return here;
    if (!file && remote.uid) {
      const found = await look({ uid: remote.uid });
      if (found && !found.dir && !P.inTrash(found.path) && /\.pdf$/i.test(found.name)) {
        file = found;
        moved = true;
      }
    }
    if (destroyed) return false;
    if (!file) {
      const choice = await choose(
        'This PDF was moved or deleted',
        `${name} is no longer where it was opened from in your Puter cloud. Your changes are still here: save them as a new file, or put the file back where it was.`,
        [
          ['Keep editing', 'cancel'],
          ['Put it back', 'restore'],
          ['Save as a new file', 'copy', 'btn primary'],
        ],
      );
      return choice === 'restore' ? here : choice === 'copy' ? null : false;
    }
    // A move or rename can restamp the file without changing it; only its size tells then.
    const changed = file.size !== remote.size || (!moved && file.modified > remote.modified);
    if (!changed) return { path: file.path, name: file.name };
    const choice = await choose(
      'This PDF changed elsewhere',
      `${file.name} was saved in your Puter cloud after you opened it here, perhaps in another window or on another device. Replace that version with yours, or keep both by saving yours as a new file.`,
      [
        ['Keep editing', 'cancel'],
        ['Replace it', 'replace', 'btn danger'],
        ['Save as a new file', 'copy', 'btn primary'],
      ],
    );
    return choice === 'replace'
      ? { path: file.path, name: file.name }
      : choice === 'copy'
        ? null
        : false;
  }
  /** After a failed write to an existing file: whether to keep the changes as a new file. */
  async function offerCopy(error) {
    const reason = reasonOf(error);
    return (
      (await choose(
        'This PDF could not be saved',
        `Puter could not save ${name}${reason ? ` (${reason})` : ''}. Your changes are still here. Save them as a new file in your PDF Editor folder instead?`,
        [
          ['Keep editing', 'cancel'],
          ['Save as a new file', 'copy', 'btn primary'],
        ],
      )) === 'copy'
    );
  }
  /** The file as just written, for the next save's check; null when it cannot be described. */
  async function written(item, filePath, size, signal) {
    const info = P.fileInfo(item);
    if (info?.modified) return { ...info, size };
    if (!P.canStat()) return null;
    const file = await waitFor(() => P.statFile(info?.path || filePath), signal).catch((error) => {
      if (signal?.aborted) throw error;
      return null;
    });
    return file?.modified ? { ...file, size } : null;
  }
  let runningSave = null;
  function save(asCopy = false) {
    if (saving) return;
    return (runningSave = saveNow(asCopy));
  }
  async function saveNow(asCopy) {
    const token = ++saveGeneration;
    const controller = (saveController = new AbortController());
    const { signal } = controller;
    const priorFocus = document.activeElement;
    // Claimed before the first await: settling drafts takes a turn of the event loop, and a
    // second press in that turn (a double click, or the shortcut twice) would otherwise write
    // the file a second time, which for a new file means a second, deduplicated copy of it.
    saving = true;
    updateStatus();
    try {
      // A save asked for during a page operation (the shortcut, or leaving) goes after it.
      await waitFor(idle, signal);
      if (destroyed || token !== saveGeneration) return;
      await waitFor(finishDrafts, signal);
      if (destroyed || token !== saveGeneration) return;
      const revision = session.revision,
        savedProtection = protection;
      let targetName = name,
        targetPath = asCopy ? null : path;
      const bytes = await waitFor(exportBytes, signal);
      if (destroyed || token !== saveGeneration) return;
      if (!getUser()) await waitFor(() => signIn(signal), signal);
      if (destroyed || token !== saveGeneration) return;
      const current = () => !destroyed && token === saveGeneration && !signal.aborted;
      if (targetPath) {
        const destination = await confirmDestination(targetPath, signal);
        if (!current() || destination === false) return;
        targetPath = destination?.path ?? null;
        if (destination) targetName = destination.name;
      }
      let item;
      try {
        item = await waitFor(() => P.saveFile(targetName, bytes, targetPath), signal);
      } catch (error) {
        // An existing file that cannot be written (shared to view only, its folder gone) need
        // not cost the changes: offer to keep them as a new file in the app's own folder.
        if (!targetPath || !current()) throw error;
        if (!(await offerCopy(error)) || !current()) return;
        targetPath = null;
        item = await waitFor(() => P.saveFile(targetName, bytes, null), signal);
      }
      if (!getUser()) await waitFor(() => signIn(signal), signal);
      if (!destroyed && token === saveGeneration) {
        const created = !targetPath;
        path = item?.path || targetPath || `${P.FOLDER}/${item?.name || targetName}`;
        name = item?.name || path.split('/').pop() || targetName;
        session.markSaved(revision);
        cloudRevision = revision;
        if (protection === savedProtection) protectionDirty = false;
        remote = await written(item, path, bytes.length, signal);
        if (destroyed || token !== saveGeneration) return;
        toast(created ? `Saved to Puter as ${name}.` : 'PDF saved to Puter.');
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (saveController === controller) {
        saveController = null;
        saving = false;
        if (!destroyed) {
          updateStatus();
          // Disabling the save control can drop keyboard focus while drafts are committed.
          if (document.activeElement === document.body && priorFocus?.isConnected)
            priorFocus.focus({ preventScroll: true });
        }
      }
    }
  }
  /** A file name for part of this PDF: its name, already trimmed to leave room, then `suffix`. */
  const exportName = (suffix) => `${safeName(name).replace(/\.pdf$/i, '')}${suffix}.pdf`;
  /** The bytes that leave the editor: the working copy, encrypted when a password is set. */
  async function exportBytes(bytes = session.bytes.slice(), savedProtection = protection) {
    const output = savedProtection ? await protectPdf(bytes, savedProtection) : bytes;
    if (output.length > MAX_FILE_SIZE)
      throw new Error(
        'This export would exceed the 100 MB PDF limit. Reduce file size before saving or downloading.',
      );
    return output;
  }
  async function downloadPdf() {
    // Claimed before the first await, so a second press while a protected PDF is being
    // encrypted cannot hand the browser a second copy of the same file.
    if (downloading) return;
    const priorFocus = document.activeElement;
    downloading = true;
    updateStatus();
    let bytes;
    try {
      await idle();
      if (destroyed) return;
      await finishDrafts();
      if (destroyed) return;
      const revision = session.revision,
        savedProtection = protection;
      activity = protection ? 'Encrypting…' : null;
      updateStatus();
      try {
        bytes = await exportBytes();
      } finally {
        // The status bar must not keep saying "Encrypting…" when the export fails.
        activity = null;
      }
      if (destroyed) return;
      download(bytes, name);
      session.markSaved(revision);
      downloadedRevision = revision;
      if (protection === savedProtection) protectionDirty = false;
      toast(protection ? 'Password-protected PDF downloaded.' : 'PDF downloaded.');
    } finally {
      downloading = false;
      if (!destroyed) {
        updateStatus();
        // Restore only lost focus; another control may have been chosen during the export.
        if (document.activeElement === document.body && priorFocus?.isConnected)
          priorFocus.focus({ preventScroll: true });
      }
    }
  }
  async function unlockOwner(request = { version: beginDialogRequest() }) {
    if (busy || destroyed) return false;
    await finishDrafts();
    if (!canOpenDialog(request.version)) return false;
    const current = protection;
    const next = await promptOwner(current, {
      ...dialogOptions,
      isCurrent: () => !destroyed && request.version === dialogVersion(),
      onOpen: () => (request.version = dialogVersion()),
    });
    if (!next || destroyed || protection !== current) return false;
    protection = next;
    await setTool(tool);
    if (destroyed || protection !== next) return false;
    await renderPage();
    if (destroyed || protection !== next) return false;
    updateStatus();
    toast('Editing unlocked. The PDF keeps its existing protection.');
    return true;
  }
  /** Set, change, or remove the password applied when the PDF is downloaded or saved. */
  async function securityDialog() {
    if (busy) return;
    const request = { version: beginDialogRequest() };
    // Encrypting needs Web Crypto, which a page served over plain http does not have; say so
    // before a password is typed rather than at the download that would fail.
    if (!passwordsSupported())
      throw new Error('Password protection needs a secure connection. Open this page over https.');
    if (!access().owner && !(await unlockOwner(request))) return;
    // Authentication still unlocks editing, but a later dialog retires this follow-up.
    if (!canOpenDialog(request.version)) return;
    const next = await protectDialog(protection, dialogOptions);
    if (next === undefined || destroyed) return;
    setProtection(next);
  }
  function setProtection(next) {
    requireAccess('owner');
    protection = next;
    protectionDirty = true;
    updateStatus();
    toast(
      next
        ? 'The password is applied when you download or save.'
        : 'The password is removed when you download or save.',
    );
  }
  async function saveAs() {
    if (saving) return;
    const token = ++saveGeneration;
    await idle();
    if (saving || destroyed || token !== saveGeneration) return;
    await finishDrafts();
    if (destroyed || token !== saveGeneration) return;
    if (!getUser()) await signIn();
    if (destroyed || token !== saveGeneration) return;
    const revision = session.revision,
      savedProtection = protection;
    let size = 0;
    // A cancelled Puter save picker can remain pending. Never lock the editor on it.
    exportBytes()
      .then(async (bytes) => {
        // Encryption can finish after a rename, replacement, or newer save. Do not open
        // an obsolete picker (or suggest the newer working copy's name for older bytes).
        if (destroyed || token !== saveGeneration) return;
        if (!getUser()) await signIn();
        if (destroyed || token !== saveGeneration) return;
        size = bytes.length;
        return P.saveAs(name, bytes);
      })
      .then(async (item) => {
        if (destroyed || token !== saveGeneration || !item) return;
        if (!getUser()) await signIn();
        if (destroyed || token !== saveGeneration) return;
        path = item.path || path;
        name = item.name || name;
        session.markSaved(revision);
        cloudRevision = revision;
        if (protection === savedProtection) protectionDirty = false;
        // The picker wrote a new file: later saves check that one, not the file opened before.
        remote = null;
        updateStatus();
        toast(`Saved to Puter as ${name}.`);
        const savedPath = path;
        const info = await written(item, savedPath, size);
        if (!destroyed && token === saveGeneration && path === savedPath) remote = info;
      })
      .catch((e) => {
        if (!destroyed && token === saveGeneration)
          toast(e?.message || 'Save cancelled.', { error: true });
      });
  }
  /* ---------- Menus ---------- */
  /** A page operation first settles any open draft, as navigation and saving do. */
  const pageAction = (fn) =>
    safe(async () => {
      await finishDrafts();
      await fn();
    });
  const canOpenDialog = (version) =>
    !destroyed && version === dialogVersion() && !document.querySelector('dialog[open]');
  /** A newer dialog choice retires pending preparation without cancelling the draft save. */
  const pageDialog = (fn) =>
    safe(async () => {
      const version = beginDialogRequest();
      try {
        await finishDrafts();
        if (canOpenDialog(version)) await fn(version);
      } catch (error) {
        if (canOpenDialog(version)) throw error;
      }
    });
  /** Menu entries as tool pane commands: submenus are spread out and headers dropped. */
  function menuCommands(items) {
    return permissionMenu(items.filter(Boolean)).flatMap((item) =>
      item.separator || item.header
        ? []
        : item.items
          ? menuCommands(item.items)
          : [
              {
                label: item.label,
                glyph: item.icon,
                onSelect: item.onSelect,
                disabled: item.disabled,
                danger: item.danger,
                shortcut: item.shortcut,
              },
            ],
    );
  }
  const toolPressed = (id) => tool === id;
  /**
   * Every tool in the tools pane. Entries are read when the pane draws, so their enabled and
   * pressed states are current; commands run through the same guards as the menus.
   */
  function toolCatalog() {
    const noDocument = () => busy || !pdf;
    return [
      {
        id: 'export',
        label: 'Export a PDF',
        group: 'Create & Edit',
        featured: true,
        description: 'Save the PDF, or its pages, in another format.',
        sections: () => [
          {
            title: 'Export to',
            items: [
              ...[
                ['docx', 'Microsoft Word (.docx)…', 'export-docx'],
                ['xlsx', 'Spreadsheet (.xlsx)…', 'export-xlsx'],
                ['pptx', 'Presentation (.pptx)…', 'export-pptx'],
                ['rtf', 'Rich text (.rtf)…', 'export-rtf'],
                ['html', 'Web page (.html)…', 'export-html'],
                ['txt', 'Plain text (.txt)…', 'export-txt'],
              ].map(([format, label, glyph]) => ({
                label,
                icon: glyph,
                permission: 'copy',
                disabled: noDocument(),
                onSelect: () => pageDialog(() => officeExportDialog(format))(),
              })),
              {
                label: 'Image (PNG or JPEG)…',
                icon: 'export-image',
                permission: 'copy',
                disabled: noDocument(),
                onSelect: () => pageDialog(pageImagesDialog)(),
              },
              {
                label: 'This page as a picture',
                glyph: 'ImageDown',
                permission: 'copy',
                disabled: noDocument(),
                onSelect: () => pageAction(() => downloadPageImage(pageIndex))(),
              },
              {
                label: 'PDF copy',
                glyph: 'Download',
                disabled: busy,
                onSelect: () => safe(downloadPdf)(),
              },
            ],
          },
        ],
      },
      {
        id: 'edit',
        label: 'Edit a PDF',
        group: 'Create & Edit',
        featured: true,
        description: 'Change text and images, or add new content to the pages.',
        permission: 'edit',
        sections: () => [
          {
            title: 'Add content',
            items: [
              {
                label: 'Add text',
                icon: 'add-text',
                pressed: toolPressed('text'),
                permission: 'edit',
                hint: 'Click existing text to edit it',
                onSelect: () => safe(() => setTool('text'))(),
              },
              {
                label: 'Add image',
                icon: 'add-image',
                permission: 'edit',
                disabled: busy,
                onSelect: () => safe(insertImage)(),
              },
              {
                label: 'Add link',
                icon: 'link',
                pressed: toolPressed('link'),
                permission: 'annotate',
                disabled: noDocument(),
                onSelect: () => pageAction(() => setTool('link'))(),
              },
            ],
          },
          {
            title: 'Edit content',
            items: [
              {
                label: 'Edit text and images',
                icon: 'edit',
                pressed: toolPressed('select'),
                hint: 'Double-click text; drag images and shapes',
                onSelect: () => safe(() => setTool('select'))(),
              },
              {
                label: 'Crop pages',
                icon: 'crop',
                pressed: toolPressed('crop'),
                permission: 'edit',
                disabled: busy,
                onSelect: () => pageAction(() => setTool('crop'))(),
              },
            ],
          },
          {
            title: 'Page design',
            items: [
              {
                label: 'Header and footer…',
                icon: 'header-footer',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => pageDialog(headerFooterDialog)(),
              },
              {
                label: 'Watermark…',
                icon: 'watermark',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => pageDialog(watermarkDialog)(),
              },
              {
                label: 'Page numbers…',
                icon: 'page-numbers',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => pageDialog(pageNumbersDialog)(),
              },
              {
                label: 'Bates numbering…',
                icon: 'bates',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () =>
                  pageDialog((version) => headerFooterDialog(version, { bates: true }))(),
              },
              {
                label: 'Remove headers and footers',
                icon: 'remove-header-footer',
                permission: 'edit',
                hint: 'Including page and Bates numbers',
                disabled: noDocument(),
                onSelect: () => safe(() => removeMarks(['Header', 'Footer']))(),
              },
              {
                label: 'Remove watermarks',
                icon: 'remove-watermark',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => safe(() => removeMarks(['Watermark']))(),
              },
            ],
          },
        ],
      },
      {
        id: 'create',
        label: 'Create a PDF',
        group: 'Create & Edit',
        featured: true,
        description: 'Start a new PDF, or turn pictures into PDF pages.',
        sections: () => [
          {
            title: 'Create',
            items: [
              { label: 'Blank PDF', icon: 'create', onSelect: () => onNew() },
              {
                label: 'From pictures or a PDF on this device…',
                glyph: 'FolderOpen',
                onSelect: () => onOpen(),
              },
              onOpenCloud && {
                label: 'From Puter…',
                glyph: 'Cloud',
                onSelect: () => onOpenCloud(),
              },
            ],
          },
          {
            title: 'Add to this PDF',
            items: [
              {
                label: 'Insert pictures as pages…',
                glyph: 'Images',
                permission: 'assemble',
                disabled: busy,
                onSelect: () => pageAction(() => insertPicturePages(pageIndex))(),
              },
            ],
          },
        ],
      },
      {
        id: 'combine',
        label: 'Combine files',
        group: 'Create & Edit',
        featured: true,
        keywords: 'merge join pdfs pictures images',
        description: 'Combine PDFs and pictures into one new PDF.',
        run: () =>
          onOpenBytes
            ? pageDialog(combineDialog)()
            : pageDialog((version) => mergeDialog(pageIndex, version))(),
      },
      {
        id: 'organize',
        label: 'Organize pages',
        group: 'Create & Edit',
        featured: true,
        keywords: 'rotate delete move reorder insert extract duplicate split pages',
        description:
          'Select pages in the grid, then rotate, move, insert, extract, or delete them. Drag pages to reorder.',
        enter: () => openOrganizer(),
        leave: () => closeOrganizer(),
        takesView: true,
        // The commands act on the pages selected in the grid, or the current page.
        sections: () => {
          const chosen =
            organizer.visible && organizer.selection.length ? organizer.selection : [pageIndex];
          const label = chosen.length === 1 ? `Page ${chosen[0] + 1}` : `${chosen.length} pages`;
          const after = chosen.at(-1);
          const run = (fn) => () => safe(fn)();
          return [
            {
              title: label,
              items: [
                {
                  label: 'Rotate clockwise',
                  glyph: 'RotateCw',
                  permission: 'assemble',
                  disabled: busy,
                  onSelect: run(() => organizeActions.rotate(chosen, 90)),
                },
                {
                  label: 'Rotate counterclockwise',
                  glyph: 'RotateCcw',
                  permission: 'assemble',
                  disabled: busy,
                  onSelect: run(() => organizeActions.rotate(chosen, -90)),
                },
                {
                  label: chosen.length === 1 ? 'Duplicate page' : 'Duplicate pages',
                  glyph: 'Copy',
                  permission: 'assemble',
                  disabled: busy,
                  onSelect: run(() => organizeActions.duplicate(chosen)),
                },
                {
                  label: chosen.length === 1 ? 'Extract page' : 'Extract pages',
                  icon: 'extract',
                  permission: 'copy',
                  disabled: busy,
                  onSelect: run(() => organizeActions.extract(chosen)),
                },
                {
                  label: chosen.length === 1 ? 'Delete page' : 'Delete pages',
                  glyph: 'Trash2',
                  danger: true,
                  permission: 'assemble',
                  disabled: busy || !pdf || chosen.length >= pdf.numPages,
                  onSelect: run(() => organizeActions.remove(chosen)),
                },
              ],
            },
            {
              title: `Insert after page ${after + 1}`,
              items: [
                {
                  label: 'Blank page',
                  glyph: 'FilePlus2',
                  permission: 'assemble',
                  disabled: busy,
                  onSelect: run(() => organizeActions.insertBlank(after)),
                },
                {
                  label: 'From a PDF…',
                  icon: 'insert-pages',
                  permission: 'assemble',
                  disabled: busy,
                  onSelect: () => organizeActions.insertFile(after),
                },
                {
                  label: 'Pictures…',
                  glyph: 'Images',
                  permission: 'assemble',
                  disabled: busy,
                  onSelect: () => organizeActions.insertPictures(after),
                },
              ],
            },
            {
              title: 'Whole document',
              items: [
                {
                  label: 'Split PDF…',
                  icon: 'split',
                  permission: 'copy',
                  disabled: noDocument() || pdf.numPages < 2,
                  onSelect: () => pageDialog(splitDialog)(),
                },
                {
                  label: 'Rotate all pages',
                  glyph: 'RotateCw',
                  permission: 'assemble',
                  disabled: busy,
                  onSelect: run(() => mutate((doc) => rotateAllPages(doc), null, 'assemble')),
                },
              ],
            },
          ];
        },
      },
      {
        id: 'comment',
        label: 'Add comments',
        group: 'Review',
        featured: true,
        description: 'Leave notes, highlight text, and mark up pages.',
        permission: 'annotate',
        enter: () => {
          showSidebarTab('comments');
          if (editorRoot.classList.contains('hide-pages')) toggleSidebar(true);
        },
        sections: () => [
          {
            title: 'Comment',
            items: [
              {
                label: 'Sticky note',
                icon: 'sticky-note',
                pressed: toolPressed('note'),
                permission: 'annotate',
                onSelect: () => safe(() => setTool('note'))(),
              },
              {
                label: 'Highlight text',
                glyph: 'Highlighter',
                pressed: toolPressed('highlight') && markupKind.value === 'highlight',
                permission: 'annotate',
                onSelect: () => safe(() => setMarkup('highlight'))(),
              },
              {
                label: 'Underline text',
                glyph: 'Underline',
                pressed: toolPressed('highlight') && markupKind.value === 'underline',
                permission: 'annotate',
                onSelect: () => safe(() => setMarkup('underline'))(),
              },
              {
                label: 'Strike through text',
                glyph: 'Strikethrough',
                pressed: toolPressed('highlight') && markupKind.value === 'strikeout',
                permission: 'annotate',
                onSelect: () => safe(() => setMarkup('strikeout'))(),
              },
              {
                label: 'Add text comment',
                icon: 'add-text',
                pressed: toolPressed('textbox'),
                permission: 'annotate',
                onSelect: () => safe(() => setTool('textbox'))(),
              },
              {
                label: 'Callout',
                icon: 'callout',
                pressed: toolPressed('callout'),
                permission: 'annotate',
                onSelect: () => safe(() => setTool('callout'))(),
              },
              {
                label: 'Pencil',
                glyph: 'Pencil',
                pressed: toolPressed('pencil'),
                permission: 'annotate',
                onSelect: () => safe(() => setTool('pencil'))(),
              },
              {
                label: 'Shapes',
                glyph: 'Square',
                pressed: toolPressed('cshape'),
                permission: 'annotate',
                hint: 'Rectangle, oval, line, arrow, or cloud',
                onSelect: () => safe(() => setTool('cshape'))(),
              },
              {
                label: 'Add stamp…',
                icon: 'stamp',
                permission: 'edit',
                disabled: busy,
                onSelect: () => safe(insertStamp)(),
              },
            ],
          },
          {
            title: 'Share comments',
            items: [
              {
                label: 'Export comments (XFDF)',
                glyph: 'Download',
                disabled: noDocument(),
                onSelect: () => safe(() => exportComments('xfdf'))(),
              },
              {
                label: 'Import comments…',
                glyph: 'Upload',
                permission: 'annotate',
                disabled: noDocument(),
                onSelect: () => importComments(),
              },
              {
                label: 'Comment summary',
                glyph: 'FileText',
                disabled: noDocument(),
                onSelect: () => safe(() => exportComments('summary'))(),
              },
            ],
          },
        ],
      },
      {
        id: 'fill-sign',
        label: 'Fill & Sign',
        group: 'Forms & Signatures',
        featured: true,
        description: 'Fill in forms and add your signature.',
        sections: () => [
          {
            title: 'Fill in',
            items: [
              {
                label: 'Fill in form fields…',
                icon: 'form',
                permission: 'fill',
                disabled: busy,
                onSelect: () => safe(formDialog)(),
              },
              {
                label: 'Add text',
                icon: 'add-text',
                pressed: toolPressed('text'),
                permission: 'edit',
                onSelect: () => safe(() => setTool('text'))(),
              },
              {
                label: 'Check mark or cross',
                icon: 'field-checkbox',
                pressed: toolPressed('shape') && ['check', 'cross'].includes(shapeSelect.value),
                permission: 'edit',
                onSelect: () =>
                  safe(async () => {
                    if (!['check', 'cross'].includes(shapeSelect.value))
                      shapeSelect.value = 'check';
                    await setTool('shape');
                  })(),
              },
            ],
          },
          {
            title: 'Sign',
            items: [
              {
                label: 'Add signature…',
                icon: 'fill-sign',
                permission: 'edit',
                disabled: busy,
                onSelect: () => safe(insertSignature)(),
              },
              {
                label: 'Sign with a certificate',
                icon: 'certificate',
                pressed: toolPressed('certsign'),
                permission: 'fill',
                hint: 'A digital ID proves who signed',
                disabled: noDocument(),
                onSelect: () => pageAction(() => setTool('certsign'))(),
              },
            ],
          },
        ],
      },
      {
        id: 'form',
        label: 'Prepare a form',
        group: 'Forms & Signatures',
        featured: true,
        permission: 'edit',
        keywords: 'form fields fillable acroform text field checkbox radio dropdown',
        description:
          'Add fillable fields: choose a field type, then drag a box on the page. Double-click a field for its properties.',
        enter: () => setPreparing(true),
        leave: () => {
          setPreparing(false);
          if (tool === 'field') safe(() => setTool('select'))();
        },
        sections: () => {
          const types = [
            ['text', 'Text field', 'field-text'],
            ['checkbox', 'Check box', 'field-checkbox'],
            ['radio', 'Radio button', 'field-radio'],
            ['dropdown', 'Dropdown', 'field-dropdown'],
            ['listbox', 'List box', 'field-listbox'],
            ['date', 'Date field', 'field-date'],
            ['button', 'Button', 'field-button'],
            ['signature', 'Signature field', 'field-signature'],
          ];
          const onPage = formFields.filter((field) => field.page === pageIndex);
          return [
            {
              title: 'Add a field',
              items: types.map(([type, label, glyph]) => ({
                label,
                icon: glyph,
                pressed: tool === 'field' && fieldType === type,
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () =>
                  safe(async () => {
                    fieldType = type;
                    await setTool('field');
                  })(),
              })),
            },
            {
              title: 'Find fields',
              items: [
                {
                  label: 'Detect form fields…',
                  glyph: 'find',
                  permission: 'edit',
                  disabled: noDocument(),
                  onSelect: () => pageDialog(detectFieldsDialog)(),
                },
                {
                  label: 'Tab order: by rows',
                  glyph: 'ListChecks',
                  permission: 'edit',
                  disabled: noDocument() || !formFields.length,
                  onSelect: () =>
                    safe(() =>
                      mutate(async (doc) => {
                        const { setFieldTabOrder } = await loadForms();
                        doc.getPageIndices().forEach((i) => setFieldTabOrder(doc, i, 'row'));
                      }, 'Fields are visited row by row.'),
                    )(),
                },
                {
                  label: 'Tab order: by columns',
                  glyph: 'ListChecks',
                  permission: 'edit',
                  disabled: noDocument() || !formFields.length,
                  onSelect: () =>
                    safe(() =>
                      mutate(async (doc) => {
                        const { setFieldTabOrder } = await loadForms();
                        doc.getPageIndices().forEach((i) => setFieldTabOrder(doc, i, 'column'));
                      }, 'Fields are visited column by column.'),
                    )(),
                },
              ],
            },
            {
              title: onPage.length
                ? `Fields on page ${pageIndex + 1} (${formFields.length} in all)`
                : `No fields on page ${pageIndex + 1}`,
              items: onPage.slice(0, 60).map((field) => ({
                label: `${field.name}`,
                hint: fieldTypeLabel(field.type),
                glyph: 'Pencil',
                permission: 'edit',
                onSelect: () => pageDialog(() => fieldPropertiesDialog(field))(),
              })),
            },
          ];
        },
      },
      {
        id: 'certificate',
        label: 'Use a certificate',
        group: 'Forms & Signatures',
        keywords: 'digital signature certify validate sign certificate pfx p12 id',
        description:
          'Sign or certify with a digital ID, and check the signatures already in the PDF.',
        sections: () => [
          {
            title: 'Sign',
            items: [
              {
                label: 'Digitally sign',
                icon: 'certificate',
                pressed: toolPressed('certsign'),
                permission: 'fill',
                hint: 'Then drag a box for the signature',
                disabled: noDocument(),
                onSelect: () => pageAction(() => setTool('certsign'))(),
              },
              {
                label: 'Certify (invisible signature)',
                icon: 'signatures',
                permission: 'fill',
                disabled: noDocument(),
                onSelect: () => safe(() => signWithCertificate({ certify: true }))(),
              },
            ],
          },
          {
            title: 'Check',
            items: [
              {
                label: 'Validate all signatures',
                glyph: 'RefreshCw',
                disabled: noDocument(),
                onSelect: () =>
                  safe(async () => {
                    await validateSignatures(true);
                    if (signatureReports.length) {
                      showSidebarTab('signatures');
                      if (editorRoot.classList.contains('hide-pages')) await toggleSidebar(true);
                    }
                  })(),
              },
            ],
          },
        ],
      },
      {
        id: 'ocr',
        label: 'Scan & OCR',
        group: 'Scan & OCR',
        featured: true,
        permission: 'edit',
        keywords: 'ocr recognize text scanned searchable',
        description: 'Make scanned pages searchable and selectable by recognizing their text.',
        sections: () => [
          {
            title: 'Recognize text',
            items: [
              {
                label: 'In this file…',
                icon: 'ocr',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => pageDialog(ocrDialog)(),
              },
              {
                label: 'Remove recognized text',
                glyph: 'Trash2',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => safe(removeRecognizedText)(),
              },
            ],
          },
          {
            title: 'Create from a scan',
            items: [
              {
                label: 'Pictures to PDF…',
                glyph: 'Images',
                onSelect: () => onOpen(),
              },
            ],
          },
        ],
      },
      {
        id: 'protect',
        label: 'Protect a PDF',
        group: 'Protect & Standardize',
        featured: true,
        description: 'Require a password to open the PDF, or limit what others can do with it.',
        sections: () => [
          {
            title: 'Password',
            items: [
              {
                label: protection ? 'Change password…' : 'Protect with password…',
                icon: 'protect',
                disabled: busy,
                onSelect: () => safe(securityDialog)(),
              },
              protection && {
                label: 'Remove password',
                glyph: 'LockOpen',
                disabled: busy,
                onSelect: () =>
                  safe(async () => {
                    if (access().owner || (await unlockOwner())) setProtection(null);
                  })(),
              },
            ],
          },
        ],
      },
      {
        id: 'redact',
        label: 'Redact a PDF',
        group: 'Protect & Standardize',
        featured: true,
        permission: 'edit',
        keywords: 'redaction black out remove sensitive sanitize hidden information',
        description:
          'Mark text, pictures, or areas, then apply to remove them from the file for good.',
        enter: () => refreshRedactionMarks().catch(() => {}),
        leave: () => {
          if (markupKind.value !== 'redact') return;
          markupKind.value = 'highlight';
          toolColors.highlight = MARKUP_COLORS.highlight;
          labelMarkupButton();
          if (tool === 'highlight') safe(() => setTool('select'))();
        },
        sections: () => [
          {
            title: 'Mark for redaction',
            items: [
              {
                label: 'Redact text and images',
                icon: 'redact',
                pressed: redacting(),
                hint: 'Select text, or choose Area and drag',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => safe(() => setMarkup('redact'))(),
              },
              {
                label: 'Find text and redact…',
                glyph: 'find',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => pageDialog(findRedactDialog)(),
              },
              {
                label: 'Redact pages…',
                glyph: 'Files',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => pageDialog(redactPagesDialog)(),
              },
              {
                label: 'Redaction properties…',
                glyph: 'Settings2',
                onSelect: () => redactionPropertiesDialog(),
              },
            ],
          },
          {
            title: redactionMarks.length
              ? `${redactionMarks.length} ${redactionMarks.length === 1 ? 'mark' : 'marks'} to apply`
              : 'No marks yet',
            items: redactionMarks.slice(0, 50).map((mark) => ({
              label: `Remove mark on page ${mark.page + 1}${mark.overlayText ? ` (${mark.overlayText})` : ''}`,
              glyph: 'X',
              permission: 'edit',
              disabled: busy,
              onSelect: () =>
                safe(() =>
                  mutate(
                    async (doc) =>
                      (await loadRedaction()).removeRedactionMark(doc, mark.page, mark.id),
                    'Redaction mark removed.',
                  ),
                )(),
            })),
          },
          {
            title: 'Apply',
            items: [
              {
                label: 'Apply redactions…',
                icon: 'redact',
                permission: 'edit',
                disabled: noDocument() || !redactionMarks.length,
                onSelect: () => pageDialog(applyRedactionsDialog)(),
              },
              {
                label: 'Remove hidden information…',
                glyph: 'sanitize',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => pageDialog(sanitizeDialog)(),
              },
            ],
          },
        ],
      },
      {
        id: 'compress',
        label: 'Compress a PDF',
        group: 'Protect & Standardize',
        featured: true,
        permission: 'edit',
        description: 'Make the file smaller by shrinking its pictures.',
        run: () => pageDialog(reduceSizeDialog)(),
      },
      {
        id: 'stamp',
        label: 'Stamp',
        group: 'Review',
        permission: 'edit',
        run: () => safe(insertStamp)(),
      },
      {
        id: 'split',
        label: 'Split a PDF',
        group: 'Create & Edit',
        permission: 'copy',
        run: () => pageDialog(splitDialog)(),
      },
      {
        id: 'extract',
        label: 'Extract pages',
        group: 'Create & Edit',
        permission: 'copy',
        run: () => pageDialog(extractDialog)(),
      },
      {
        id: 'insert-pages',
        label: 'Insert pages',
        group: 'Create & Edit',
        permission: 'assemble',
        run: () => pageDialog((version) => mergeDialog(pageIndex, version))(),
      },
      {
        id: 'crop',
        label: 'Crop pages',
        group: 'Create & Edit',
        permission: 'edit',
        run: () => pageAction(() => setTool('crop'))(),
      },
      {
        id: 'header-footer',
        label: 'Add header and footer',
        group: 'Create & Edit',
        permission: 'edit',
        run: () => pageDialog(headerFooterDialog)(),
      },
      {
        id: 'watermark',
        label: 'Add watermark',
        group: 'Create & Edit',
        permission: 'edit',
        run: () => pageDialog(watermarkDialog)(),
      },
      {
        id: 'bates',
        label: 'Bates numbering',
        group: 'Create & Edit',
        keywords: 'legal production stamp number',
        permission: 'edit',
        run: () => pageDialog((version) => headerFooterDialog(version, { bates: true }))(),
      },
      {
        id: 'page-numbers',
        label: 'Add page numbers',
        group: 'Create & Edit',
        permission: 'edit',
        run: () => pageDialog(pageNumbersDialog)(),
      },
      {
        id: 'flatten',
        label: 'Flatten',
        group: 'Print production',
        permission: ['edit', 'annotate'],
        run: () => pageDialog(flattenDialog)(),
      },
      {
        id: 'accessibility',
        label: 'Prepare for accessibility',
        group: 'Protect & Standardize',
        keywords: 'accessibility check tags alt text screen reader pdf/ua reading order',
        description:
          'Check the PDF for accessibility problems and fix them: tags, title, language, alternate text, and more.',
        sections: () => [
          {
            title: 'Check',
            items: [
              {
                label: 'Accessibility check',
                icon: 'accessibility',
                disabled: noDocument(),
                onSelect: () => safe(() => runAccessibilityCheck())(),
              },
            ],
          },
          {
            title: 'Fix',
            items: [
              ['tags', 'Autotag document', 'Tag headings, paragraphs, lists, and figures'],
              ['title', 'Set the document title…'],
              ['language', 'Set the document language…'],
              ['alt-text', 'Add alternate text…'],
              ['field-descriptions', 'Describe form fields…'],
              ['tab-order', 'Set tab order'],
              ['bookmarks', 'Add bookmarks from headings'],
            ].map(([fix, label, hint]) => ({
              label,
              hint,
              glyph: 'Check',
              permission: 'edit',
              disabled: noDocument(),
              onSelect: () => safe(() => fixAccessibility(fix))(),
            })),
          },
        ],
      },
      {
        id: 'standards',
        label: 'PDF standards',
        group: 'Protect & Standardize',
        keywords: 'pdf/a archive preflight compliance iso 19005 standard',
        description: 'Check a PDF against PDF/A for long-term archiving, or convert it.',
        sections: () => [
          {
            title: 'PDF/A',
            items: [
              {
                label: 'Check compliance…',
                icon: 'standards',
                disabled: noDocument(),
                onSelect: () => pageDialog(() => pdfaDialog('check'))(),
              },
              {
                label: 'Save as PDF/A…',
                icon: 'standards',
                permission: 'edit',
                disabled: noDocument(),
                onSelect: () => pageDialog(() => pdfaDialog('convert'))(),
              },
            ],
          },
        ],
      },
      {
        id: 'measure',
        label: 'Measure',
        group: 'Review',
        keywords: 'distance perimeter area ruler scale length',
        permission: 'annotate',
        description: 'Measure distances, perimeters, and areas at a drawing scale.',
        sections: () => [
          {
            title: 'Measure',
            items: [
              ['distance', 'Distance'],
              ['perimeter', 'Perimeter'],
              ['area', 'Area'],
            ].map(([mode, label]) => ({
              label,
              icon: `measure-${mode}`,
              pressed: tool === 'measure' && measureMode.value === mode,
              permission: 'annotate',
              disabled: noDocument(),
              onSelect: () =>
                safe(async () => {
                  measureMode.value = mode;
                  measurePath = [];
                  await setTool('measure');
                })(),
            })),
          },
        ],
      },
      {
        id: 'compare',
        label: 'Compare files',
        group: 'Review',
        keywords: 'difference diff versions changes',
        description: 'Find the differences between two versions of a PDF.',
        run: () => pageDialog(compareDialog)(),
      },
      {
        id: 'batch',
        label: 'Batch process',
        group: 'Customize',
        keywords: 'action wizard guided actions automate many files bulk',
        description: 'Apply the same steps to several PDFs at once.',
        run: () => pageDialog(batchDialog)(),
      },
      {
        id: 'print',
        label: 'Print',
        group: 'Print production',
        permission: 'print',
        run: () => pageDialog(printDialog)(),
      },
      {
        id: 'document-properties',
        label: 'Document properties',
        group: 'Protect & Standardize',
        run: () => pageDialog(detailsDialog)(),
      },
    ];
  }
  // Menus are built as they open, so every disabled and checked state is current.
  function fileItems(folded) {
    const cloud = saving || busy;
    // On the Puter desktop the shortcuts belong to the cloud, where its files are: Open
    // browses Puter and Save As chooses a Puter folder. Elsewhere they use this device.
    const desktop = P.isApp() && !!onOpenCloud;
    return [
      { label: 'New blank PDF', icon: 'FilePlus2', onSelect: onNew },
      desktop
        ? { label: 'Open from Puter…', icon: 'Cloud', shortcut: 'Mod+O', onSelect: onOpenCloud }
        : { label: 'Open…', icon: 'FolderOpen', shortcut: 'Mod+O', onSelect: onOpen },
      desktop
        ? { label: 'Open from this device…', icon: 'FolderOpen', onSelect: onOpen }
        : onOpenCloud && { label: 'Open from Puter…', icon: 'Cloud', onSelect: onOpenCloud },
      { separator: true },
      {
        label: signedOut() ? 'Sign in to save' : path ? 'Save' : 'Save to Puter',
        icon: 'CloudUpload',
        shortcut: 'Mod+S',
        disabled: cloud,
        onSelect: safe(() => save()),
      },
      {
        label: 'Save a copy to Puter',
        icon: 'Copy',
        disabled: cloud,
        onSelect: safe(() => save(true)),
      },
      {
        label: 'Save to another Puter folder…',
        icon: 'FolderInput',
        ...(desktop && { shortcut: 'Mod+Shift+S' }),
        disabled: cloud,
        onSelect: safe(saveAs),
      },
      {
        label: 'Download',
        icon: 'Download',
        ...(!desktop && { shortcut: 'Mod+Shift+S' }),
        disabled: busy,
        onSelect: safe(downloadPdf),
      },
      {
        permission: 'print',
        label: 'Print…',
        icon: 'Printer',
        shortcut: 'Mod+P',
        disabled: busy,
        onSelect: pageDialog(printDialog),
      },
      { separator: true },
      {
        label: 'Rename…',
        icon: 'Pencil',
        disabled: busy || saving,
        onSelect: () => nameButton.click(),
      },
      {
        label: 'Document details…',
        icon: 'Info',
        disabled: busy,
        onSelect: pageDialog(detailsDialog),
      },
      {
        permission: 'edit',
        label: 'Reduce file size…',
        icon: 'Shrink',
        disabled: busy,
        onSelect: pageDialog(reduceSizeDialog),
      },
      {
        permission: ['edit', 'annotate'],
        label: 'Flatten…',
        icon: 'Layers',
        disabled: busy,
        onSelect: pageDialog(flattenDialog),
      },
      {
        permission: 'copy',
        label: 'Split PDF…',
        icon: 'Scissors',
        disabled: busy || !pdf || pdf.numPages < 2,
        onSelect: pageDialog(splitDialog),
      },
      {
        permission: 'copy',
        label: 'Download pages as images…',
        icon: 'ImageDown',
        disabled: busy || !pdf,
        onSelect: pageDialog(pageImagesDialog),
      },
      {
        label: protection ? 'Change password…' : 'Protect with password…',
        icon: 'Lock',
        disabled: busy,
        onSelect: safe(securityDialog),
      },
      protection && {
        label: 'Remove password',
        icon: 'LockOpen',
        disabled: busy,
        onSelect: safe(async () => {
          if (access().owner || (await unlockOwner())) setProtection(null);
        }),
      },
      { separator: true },
      ...(folded
        ? [
            { label: 'Edit', icon: 'Undo2', items: editItems() },
            { label: 'View', icon: 'ZoomIn', items: viewItems() },
            { label: 'Page', icon: 'FileText', items: pageItems() },
            { label: 'Insert', icon: 'Plus', items: insertItems() },
            { separator: true },
          ]
        : []),
      { label: 'Back to your PDFs', icon: 'ArrowLeft', onSelect: goHome },
    ];
  }
  function editItems() {
    return [
      {
        label: 'Undo',
        icon: 'Undo2',
        shortcut: 'Mod+Z',
        disabled: undoButton.disabled,
        onSelect: safe(() => history('undo')),
      },
      {
        label: 'Redo',
        icon: 'Redo2',
        shortcut: 'Mod+Shift+Z',
        disabled: redoButton.disabled,
        onSelect: safe(() => history('redo')),
      },
      { separator: true },
      {
        label: 'Select all text',
        icon: 'Type',
        shortcut: 'Mod+A',
        disabled: !pageReady || !textContainer.firstChild,
        onSelect: () => {
          selectPageText();
          workspace.focus({ preventScroll: true });
        },
      },
      { label: 'Find in PDF', icon: 'Search', shortcut: 'Mod+F', onSelect: openSearch },
      {
        label: 'Go to page…',
        icon: 'Hash',
        disabled: !pdf || pdf.numPages < 2 || busy,
        onSelect: safe(goToPage),
      },
      { separator: true },
      {
        permission: 'fill',
        label: 'Fill forms…',
        icon: 'ListChecks',
        disabled: busy,
        onSelect: safe(formDialog),
      },
    ];
  }
  function viewItems() {
    return [
      {
        label: 'Fit width',
        shortcut: 'Mod+2',
        checked: scaleMode === 'fit',
        onSelect: safe(() => setZoom('fit')),
      },
      {
        label: 'Fit page',
        shortcut: 'Mod+0',
        checked: scaleMode === 'page',
        onSelect: safe(() => setZoom('page')),
      },
      {
        label: 'Actual size',
        shortcut: 'Mod+1',
        checked: scaleMode === '1',
        onSelect: safe(() => setZoom('1')),
      },
      { separator: true },
      {
        label: 'Zoom in',
        icon: 'ZoomIn',
        shortcut: 'Mod+Plus',
        disabled: zoomInButton.disabled,
        onSelect: safe(() => setZoom(zoomStep(1))),
      },
      {
        label: 'Zoom out',
        icon: 'ZoomOut',
        shortcut: 'Mod+Minus',
        disabled: zoomOutButton.disabled,
        onSelect: safe(() => setZoom(zoomStep(-1))),
      },
      { separator: true },
      {
        label: 'Page display',
        icon: 'Files',
        items: [
          ['continuous', 'Scrolling'],
          ['single', 'Single page'],
          ['two-continuous', 'Two-page scrolling'],
          ['two', 'Two-page'],
        ].map(([display, label]) => ({
          label,
          checked: pageDisplay() === display,
          onSelect: () => setPageDisplay(display),
        })),
      },
      { label: 'Read out loud', icon: 'Volume2', items: readingItems() },
      {
        label: 'Read mode',
        icon: 'BookOpen',
        checked: editorRoot.classList.contains('read-mode'),
        onSelect: () => setReadMode(!editorRoot.classList.contains('read-mode')),
      },
      {
        label: 'Full screen mode',
        icon: 'Maximize',
        shortcut: 'Mod+L',
        disabled: !document.fullscreenEnabled,
        onSelect: () => toggleFullScreen(),
      },
      {
        label: 'Tools pane',
        checked: !editorRoot.classList.contains('hide-tools'),
        shortcut: 'Shift+F4',
        onSelect: () => toggleToolsPanel(),
      },
      { separator: true },
      {
        label: 'Pages panel',
        checked: !editorRoot.classList.contains('hide-pages') && sidebarTab === 'pages',
        onSelect: safe(async () => {
          const shown = !editorRoot.classList.contains('hide-pages');
          if (shown && sidebarTab === 'pages') return toggleSidebar(false);
          showSidebarTab('pages');
          if (!shown) await toggleSidebar(true);
        }),
      },
      {
        label: 'Outline panel',
        checked: !editorRoot.classList.contains('hide-pages') && sidebarTab === 'outline',
        disabled: !outline.hasItems,
        onSelect: safe(async () => {
          const shown = !editorRoot.classList.contains('hide-pages');
          if (shown && sidebarTab === 'outline') return toggleSidebar(false);
          showSidebarTab('outline');
          if (!shown) await toggleSidebar(true);
        }),
      },
      {
        label: 'Comments panel',
        checked: !editorRoot.classList.contains('hide-pages') && sidebarTab === 'comments',
        onSelect: safe(async () => {
          const shown = !editorRoot.classList.contains('hide-pages');
          if (shown && sidebarTab === 'comments') return toggleSidebar(false);
          showSidebarTab('comments');
          if (!shown) await toggleSidebar(true);
        }),
      },
      {
        label: 'Dark page colors',
        icon: 'Moon',
        checked: darkPages,
        onSelect: safe(() => setDarkPages(!darkPages)),
      },
      { separator: true },
      {
        label: 'Previous page',
        icon: 'ChevronLeft',
        shortcut: 'Alt+←',
        disabled: prevButton.disabled,
        onSelect: () => navigateBy(-1),
      },
      {
        label: 'Next page',
        icon: 'ChevronRight',
        shortcut: 'Alt+→',
        disabled: nextButton.disabled,
        onSelect: () => navigateBy(1),
      },
      { separator: true },
      { label: 'Appearance and account…', icon: 'Settings2', onSelect: settings },
      shortcuts && { label: 'Keyboard shortcuts…', icon: 'Keyboard', onSelect: shortcuts },
    ];
  }
  /** The Page menu for the current page, or a thumbnail's menu for the page at `index`. */
  /**
   * Where the view lands once `count` pages have been inserted after `index`: on the first new
   * page when the insertion followed the page being read, else on the same page as before,
   * wherever the insertion moved it. A thumbnail's menu thereby edits its own page while the
   * reader stays put, as the other thumbnail actions do.
   */
  function afterInsert(index, count = 1) {
    if (index === pageIndex) pageIndex = index + 1;
    else if (index < pageIndex) pageIndex += count;
  }
  function pageItems(index = pageIndex) {
    const count = pdf?.numPages || 1;
    return [
      { header: `Page ${index + 1} of ${count}` },
      {
        permission: 'assemble',
        label: 'Rotate clockwise',
        icon: 'RotateCw',
        disabled: busy,
        onSelect: pageAction(() => mutate((doc) => rotatePage(doc, index), null, 'assemble')),
      },
      {
        permission: 'assemble',
        label: 'Rotate counterclockwise',
        icon: 'RotateCcw',
        disabled: busy,
        onSelect: pageAction(() => mutate((doc) => rotatePage(doc, index, -90), null, 'assemble')),
      },
      {
        label: 'All pages',
        icon: 'Files',
        items: [
          {
            permission: 'assemble',
            label: 'Rotate all pages clockwise',
            icon: 'RotateCw',
            disabled: busy,
            onSelect: pageAction(() => mutate((doc) => rotateAllPages(doc), null, 'assemble')),
          },
          {
            permission: 'assemble',
            label: 'Rotate all pages counterclockwise',
            icon: 'RotateCcw',
            disabled: busy,
            onSelect: pageAction(() => mutate((doc) => rotateAllPages(doc, -90), null, 'assemble')),
          },
        ],
      },
      { separator: true },
      {
        permission: 'assemble',
        label: 'Move page earlier',
        icon: 'ArrowUp',
        disabled: busy || index === 0,
        onSelect: pageAction(() => movePageTo(index, index - 1)),
      },
      {
        permission: 'assemble',
        label: 'Move page later',
        icon: 'ArrowDown',
        disabled: busy || index >= count - 1,
        onSelect: pageAction(() => movePageTo(index, index + 1)),
      },
      { separator: true },
      {
        permission: 'assemble',
        label: 'Add bookmark for this page…',
        icon: 'Bookmark',
        disabled: busy,
        onSelect: pageDialog(async () => {
          const title = await promptText('Add bookmark', 'Bookmark name', `Page ${index + 1}`);
          if (title == null || destroyed) return;
          await mutate(
            (doc) => addBookmark(doc, { title, pageIndex: index }),
            'Bookmark added. Find it in the Outline tab.',
            'assemble',
          );
          if (!destroyed && !editorRoot.classList.contains('hide-pages')) showSidebarTab('outline');
        }),
      },
      { separator: true },
      {
        permission: 'edit',
        label: 'Crop pages…',
        icon: 'Crop',
        disabled: busy,
        onSelect: pageAction(async () => {
          // Cropping is drawn on the page, so the chosen page comes into view first.
          if (index !== pageIndex && !(await navigate(index))) return;
          await setTool('crop');
        }),
      },
      {
        permission: 'edit',
        label: 'Remove crop',
        icon: 'Expand',
        disabled: busy,
        onSelect: pageAction(async () => {
          let changed = false;
          await mutate(
            (doc) => (changed = resetCrop(doc, [index])),
            'The full page is shown again.',
          );
          if (!changed) toast('This page is not cropped.');
        }),
      },
      { separator: true },
      {
        permission: 'assemble',
        label: 'Insert blank page after',
        icon: 'FilePlus2',
        disabled: busy,
        onSelect: pageAction(() =>
          mutate(
            (doc) => {
              insertBlankPage(doc, index);
              afterInsert(index);
            },
            null,
            'assemble',
          ),
        ),
      },
      {
        permission: 'assemble',
        label: 'Duplicate page',
        icon: 'Copy',
        disabled: busy,
        onSelect: pageAction(() =>
          mutate(
            async (doc) => {
              await duplicatePage(doc, index);
              afterInsert(index);
            },
            'Page duplicated.',
            'assemble',
          ),
        ),
      },
      {
        permission: 'assemble',
        label: 'Insert pictures as pages…',
        icon: 'Images',
        disabled: busy,
        onSelect: pageAction(() => insertPicturePages(index)),
      },
      {
        permission: 'assemble',
        label: 'Insert pages from PDF…',
        icon: 'FileInput',
        disabled: busy,
        onSelect: pageDialog((version) => mergeDialog(index, version)),
      },
      index === pageIndex
        ? {
            permission: 'copy',
            label: 'Extract pages…',
            icon: 'FileOutput',
            disabled: busy,
            onSelect: pageDialog(extractDialog),
          }
        : {
            permission: 'copy',
            label: 'Extract this page',
            icon: 'FileOutput',
            disabled: busy,
            onSelect: pageAction(async () => {
              if (destroyed) return;
              const savedProtection = protection;
              const extracted = await extractPages(session.bytes, [index]);
              if (destroyed) return;
              const bytes = await exportBytes(extracted, savedProtection);
              if (destroyed) return;
              download(bytes, exportName(` page ${index + 1}`));
              toast(`Page ${index + 1} downloaded as a new PDF.`);
            }),
          },
      {
        permission: 'copy',
        label: 'Download page as image',
        icon: 'ImageDown',
        disabled: busy,
        onSelect: pageAction(() => downloadPageImage(index)),
      },
      { separator: true },
      {
        permission: 'assemble',
        label: 'Delete page',
        icon: 'Trash2',
        danger: true,
        disabled: busy || count === 1,
        onSelect: pageDialog(() => deletePageAt(index)),
      },
    ];
  }
  function insertItems() {
    return [
      {
        permission: 'edit',
        label: 'Text',
        icon: 'Type',
        hint: 'Then click the page where the text goes',
        onSelect: safe(() => setTool('text')),
      },
      { permission: 'edit', label: 'Image…', icon: 'Image', disabled: busy, onSelect: insertImage },
      {
        permission: 'edit',
        label: 'Signature…',
        icon: 'Signature',
        disabled: busy,
        onSelect: safe(insertSignature),
      },
      {
        permission: 'edit',
        label: 'Stamp…',
        icon: 'Stamp',
        disabled: busy,
        onSelect: safe(insertStamp),
      },
      {
        permission: 'annotate',
        label: 'Link…',
        icon: 'Link',
        disabled: busy || !pdf,
        onSelect: pageAction(() => setTool('link')),
      },
      {
        permission: 'edit',
        label: 'Watermark…',
        icon: 'Droplets',
        disabled: busy || !pdf,
        onSelect: pageDialog(watermarkDialog),
      },
      {
        permission: 'edit',
        label: 'Page numbers…',
        icon: 'Hash',
        disabled: busy || !pdf,
        onSelect: pageDialog(pageNumbersDialog),
      },
      {
        permission: 'edit',
        label: 'Header and footer…',
        icon: 'PanelTopBottomDashed',
        disabled: busy || !pdf,
        onSelect: pageDialog(headerFooterDialog),
      },
      { separator: true },
      {
        permission: 'annotate',
        label: 'Note',
        icon: 'StickyNote',
        onSelect: safe(() => setTool('note')),
      },
      {
        permission: 'annotate',
        label: 'Highlight',
        icon: 'Highlighter',
        onSelect: safe(() => setTool('highlight')),
      },
      {
        permission: 'edit',
        label: 'Drawing',
        icon: 'Pencil',
        onSelect: safe(() => setTool('ink')),
      },
      {
        permission: 'edit',
        label: 'Shape',
        icon: 'Square',
        onSelect: safe(() => setTool('shape')),
      },
    ];
  }
  function openFileMenu(anchor, folded = false) {
    openMenu({
      anchor,
      items: fileItems(folded),
      align: folded ? 'end' : 'start',
      label: 'File',
      minWidth: 250,
    });
  }
  function openEditMenu(anchor) {
    openMenu({ anchor, items: editItems(), label: 'Edit', minWidth: 230 });
  }
  function openViewMenu(anchor) {
    openMenu({ anchor, items: viewItems(), label: 'View', minWidth: 230 });
  }
  function openPageMenu(anchor) {
    openMenu({ anchor, items: pageItems(), label: 'Page', minWidth: 240 });
  }
  function openInsertMenu(anchor) {
    openMenu({ anchor, items: insertItems(), label: 'Insert', minWidth: 230 });
  }
  /** Move a page; the page being viewed stays in view, wherever it lands in the new order. */
  function movePageTo(from, to) {
    if (!pdf || from === to || to < 0 || to >= pdf.numPages) return;
    const current = pageIndex;
    return mutate(
      (doc) => {
        movePage(doc, from, to);
        pageIndex =
          from === current
            ? to
            : from < current && to >= current
              ? current - 1
              : from > current && to <= current
                ? current + 1
                : current;
      },
      null,
      'assemble',
    );
  }
  /**
   * Sign with a certificate: choose a digital ID, then append a signature to the PDF as it is
   * now. A rectangle gives a visible signature on that page; none gives an invisible one.
   */
  async function signWithCertificate({ rect = null, page = pageIndex, certify = false } = {}) {
    requireAccess('fill');
    if (protection)
      throw new Error(
        'Remove the password before signing with a certificate. Encrypting the file again would invalidate the signature.',
      );
    await finishDrafts();
    const chosen = await chooseDigitalId(digitalIds, dialogOptions);
    if (!chosen || destroyed) return;
    if (!digitalIds.includes(chosen)) digitalIds.unshift(chosen);
    const details = await signatureDetailsDialog(chosen.summary, { certify, ...dialogOptions });
    if (!details || destroyed || busy) return;
    const { signPdf } = await import('./core/digital-signature.js');
    busy = true;
    activity = certify ? 'Certifying…' : 'Signing…';
    updateStatus();
    try {
      const signed = await signPdf(session.bytes, chosen.identity, {
        page,
        rect,
        reason: details.reason,
        location: details.location,
        contactInfo: details.contactInfo,
        certify: details.certify,
      });
      if (destroyed) return;
      session.adopt(signed);
      signedEditAccepted = false;
      if (tool === 'certsign') tool = 'select';
      await reload();
    } finally {
      busy = false;
      activity = null;
      if (!destroyed) updateStatus();
    }
    if (destroyed) return;
    await setTool('select');
    toast(
      certify
        ? 'Certified. Download or save the PDF to keep the certification.'
        : 'Signed. Download or save the PDF to keep the signature.',
    );
  }
  /** Delete several pages at once, after one confirmation. */
  async function deletePages(indices) {
    requireAccess('assemble');
    const list = [...new Set(indices)].sort((a, b) => b - a);
    if (!list.length) return false;
    if (list.length >= pdf.numPages) {
      toast('Keep at least one page in the PDF.', { error: true });
      return false;
    }
    if (list.length === 1) return deletePageAt(list[0]);
    if (
      !(await confirmAction(
        `Delete ${list.length} pages?`,
        `Remove pages ${formatPageRange([...list].reverse())}? Bookmarks and links to them will go to a neighbouring page. You can undo this while the PDF is open.`,
        'Delete pages',
      ))
    )
      return false;
    await mutate(
      (doc) => {
        deleteDocumentPages(doc, list);
        for (const index of list) if (index < pageIndex) pageIndex--;
        pageIndex = Math.min(pageIndex, doc.getPageCount() - 1);
      },
      `${list.length} pages deleted.`,
      'assemble',
    );
  }
  /** Move a set of pages, in their order, so the first lands at `to` among the others. */
  function movePages(indices, to) {
    const moving = [...new Set(indices)].sort((a, b) => a - b);
    const count = pdf.numPages;
    const rest = [...Array(count).keys()].filter((i) => !moving.includes(i));
    const order = [...rest.slice(0, to), ...moving, ...rest.slice(to)];
    if (order.every((i, k) => i === k)) return;
    return mutate(
      (doc) => {
        reorderPages(doc, order);
        pageIndex = order.indexOf(pageIndex);
      },
      moving.length === 1 ? 'Page moved.' : `${moving.length} pages moved.`,
      'assemble',
    );
  }
  /** Download chosen pages as a new PDF. */
  async function extractToDownload(indices) {
    requireAccess('copy');
    const list = [...new Set(indices)].sort((a, b) => a - b);
    const savedProtection = protection;
    const extracted = await extractPages(session.bytes, list);
    if (destroyed) return;
    const bytes = await exportBytes(extracted, savedProtection);
    if (destroyed) return;
    const label = formatPageRange(list);
    download(bytes, exportName(list.length === 1 ? ` page ${list[0] + 1}` : ` pages ${label}`));
    toast(
      list.length === 1
        ? `Page ${list[0] + 1} downloaded as a new PDF.`
        : `Pages ${label} downloaded as a new PDF.`,
    );
  }
  async function deletePageAt(index) {
    requireAccess('assemble');
    if (
      await confirmAction(
        'Delete this page?',
        `Remove page ${index + 1}? Bookmarks and links to it will go to the ${index + 1 < pdf.numPages ? 'next' : 'previous'} page. You can undo this while the PDF is open.`,
        'Delete page',
      )
    )
      await mutate(
        (doc) => {
          deletePage(doc, index);
          if (index < pageIndex) pageIndex--;
        },
        null,
        'assemble',
      );
  }
  /** Add a page per chosen picture after the given page, each fitted to a sheet of paper. */
  function insertPicturePages(after = pageIndex) {
    requireAccess('assemble');
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg', multiple: true });
    input.onchange = safe(async () => {
      const files = [...input.files];
      if (!files.length) return;
      await mutate(
        async (doc) => {
          const images = await normalizeImageFiles(files, {
            maxPages: MAX_PAGES - doc.getPageCount(),
            lazy: true,
            signal: dialogController.signal,
          });
          await addImagePages(doc, images, {
            after,
            paper: defaultPaper(),
            signal: dialogController.signal,
          });
          afterInsert(after, images.length);
        },
        files.length === 1
          ? 'Picture added as a page.'
          : `${files.length} pictures added as pages.`,
        'assemble',
        { signal: dialogController.signal },
      );
    });
    input.click();
  }
  /* ---------- Redaction ---------- */
  /** Find words or patterns on every page and mark the chosen matches for redaction. */
  async function findRedactDialog() {
    requireAccess('edit');
    const { REDACTION_PATTERNS, findTextRects, addRedactionMarks } = await loadRedaction();
    const query = el('input', { class: 'input', autocomplete: 'off', maxlength: 200 });
    const whole = el('input', { type: 'checkbox', id: 'redact-whole' });
    const patternBoxes = Object.entries(REDACTION_PATTERNS).map(([key, pattern]) => ({
      key,
      box: el('input', { type: 'checkbox', id: `redact-pattern-${key}` }),
      label: pattern.label,
    }));
    const results = el('ul', { class: 'redact-results', 'aria-label': 'Matches' });
    const status = el('p', { class: 'muted', role: 'status' });
    let found = [];
    const search = safe(async () => {
      const text = query.value.trim();
      const patterns = patternBoxes.filter((entry) => entry.box.checked);
      if (!text && !patterns.length) throw new Error('Enter text or choose a pattern to find.');
      searchButton.disabled = true;
      status.textContent = 'Searching…';
      try {
        const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
        found = [];
        for (let page = 0; page < doc.getPageCount(); page++) {
          if (!d.open) return;
          const queries = [
            ...(text ? [text] : []),
            ...patterns.map((entry) => REDACTION_PATTERNS[entry.key]),
          ];
          for (const q of queries)
            for (const match of await findTextRects(doc, page, q, { wholeWord: whole.checked }))
              found.push({ page, ...match });
        }
        status.textContent = found.length
          ? `${found.length} ${found.length === 1 ? 'match' : 'matches'} found. Choose the ones to mark.`
          : 'No matches found.';
        results.replaceChildren(
          ...found.map((match, i) =>
            el(
              'li',
              {},
              el(
                'label',
                { class: 'result-row' },
                el('input', { type: 'checkbox', checked: true, 'data-index': i }),
                el('span', {}, `Page ${match.page + 1}: ${match.text}`),
              ),
            ),
          ),
        );
        markButton.disabled = !found.length;
      } finally {
        searchButton.disabled = false;
      }
    });
    const mark = safe(async () => {
      const chosen = [...results.querySelectorAll('input:checked')].map(
        (box) => found[Number(box.dataset.index)],
      );
      if (!chosen.length) throw new Error('Choose at least one match to mark.');
      await mutateDialog(
        d,
        (doc) => {
          const byPage = new Map();
          for (const match of chosen)
            byPage.set(match.page, [...(byPage.get(match.page) || []), ...match.rects]);
          for (const [page, rects] of byPage) addRedactionMarks(doc, page, rects, redactionStyle);
        },
        `${chosen.length} ${chosen.length === 1 ? 'match' : 'matches'} marked for redaction. Choose Apply redactions to remove them.`,
      );
    });
    const form = el(
      'form',
      { class: 'stack' },
      labeled('redact-query', 'Find text', query),
      el(
        'label',
        { class: 'checkbox-row', for: 'redact-whole' },
        el('span', {}, 'Whole words only'),
        whole,
      ),
      el('p', { class: 'muted' }, 'Or find patterns'),
      el(
        'div',
        { class: 'redact-patterns' },
        ...patternBoxes.map((entry) =>
          el(
            'label',
            { class: 'checkbox-row', for: entry.box.id },
            el('span', {}, entry.label),
            entry.box,
          ),
        ),
      ),
      status,
      results,
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      search();
    };
    const searchButton = button('Search', 'Search', search, 'btn');
    const markButton = button('Mark selected', null, mark, 'btn primary', { disabled: true });
    const d = modal('Find text and redact', form, [
      button('Cancel', null, () => d.close()),
      searchButton,
      markButton,
    ]);
    query.focus();
  }
  /** What applied redactions look like: the fill color and optional overlay text. */
  function redactionPropertiesDialog() {
    const fill = el('input', { type: 'color', value: redactionStyle.fill });
    const overlay = el('input', {
      class: 'input',
      maxlength: 100,
      value: redactionStyle.overlayText,
      placeholder: 'For example: Redacted',
    });
    const repeat = el('input', {
      type: 'checkbox',
      id: 'redact-repeat',
      checked: redactionStyle.repeat,
    });
    const save = () => {
      redactionStyle.fill = fill.value;
      redactionStyle.overlayText = overlay.value;
      redactionStyle.repeat = repeat.checked;
      d.close();
      toast('New redaction marks use these settings.');
    };
    const form = el(
      'form',
      { class: 'stack' },
      labeled('redact-fill', 'Fill color', fill),
      labeled('redact-overlay', 'Overlay text', overlay),
      el(
        'label',
        { class: 'checkbox-row', for: 'redact-repeat' },
        el('span', {}, 'Repeat overlay text to fill the area'),
        repeat,
      ),
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      save();
    };
    const d = modal('Redaction properties', form, [
      button('Cancel', null, () => d.close()),
      button('Save', null, save, 'btn primary'),
    ]);
  }
  /** Mark whole pages for redaction. */
  async function redactPagesDialog() {
    requireAccess('edit');
    const { addRedactionMarks } = await loadRedaction();
    const choices = pageChoices('redact-pages', pdf.numPages);
    const apply = safe(async () => {
      const indices = choices.indices();
      await mutateDialog(
        d,
        (doc) => {
          for (const index of indices) {
            const page = doc.getPage(index);
            const box = page.getCropBox();
            addRedactionMarks(
              doc,
              index,
              [[box.x, box.y, box.x + box.width, box.y + box.height]],
              redactionStyle,
            );
          }
        },
        `${indices.length === 1 ? 'The page is' : `${indices.length} pages are`} marked for redaction.`,
      );
    });
    const d = modal('Redact pages', el('div', { class: 'stack' }, choices.list), [
      button('Cancel', null, () => d.close()),
      button('Mark pages', null, apply, 'btn primary'),
    ]);
  }
  /** Apply every mark: what lies under it is removed from the file, then it is filled. */
  async function applyRedactionsDialog() {
    requireAccess('edit');
    const { applyRedactions } = await loadRedaction();
    const { sanitizeDocument, SANITIZE_DEFAULTS } = await loadSanitize();
    const sanitize = el('input', { type: 'checkbox', id: 'redact-sanitize', checked: true });
    const apply = safe(async () => {
      let report = null;
      await mutateDialog(
        d,
        async (doc) => {
          report = await applyRedactions(doc, { codec: createImageCodec(loadPdf) });
          if (report === false) throw new Error('There are no redaction marks to apply.');
          if (sanitize.checked)
            await sanitizeDocument(doc, {
              ...SANITIZE_DEFAULTS,
              comments: false,
              formFields: false,
            });
        },
        null,
      );
      if (!report || destroyed) return;
      const removed = [
        report.text && `${report.text} characters`,
        report.images.redacted + report.images.removed &&
          `${report.images.redacted + report.images.removed} ${report.images.redacted + report.images.removed === 1 ? 'image' : 'images'}`,
        report.paths && `${report.paths} drawings`,
        report.annotations && `${report.annotations} annotations`,
      ].filter(Boolean);
      toast(
        `Redactions applied${removed.length ? `: removed ${removed.join(', ')}` : ''}. Save or download to keep the redacted file.`,
      );
    });
    const d = modal(
      'Apply redactions',
      el(
        'div',
        { class: 'stack' },
        el(
          'p',
          {},
          `${redactionMarks.length ? `${redactionMarks.length} ${redactionMarks.length === 1 ? 'mark' : 'marks'} will be applied. ` : ''}Text, pictures, drawings, links, comments, and form fields under each mark are removed from the PDF, not just covered.`,
        ),
        el(
          'label',
          { class: 'checkbox-row', for: 'redact-sanitize' },
          el(
            'span',
            {},
            'Also remove hidden information (metadata, scripts, attachments, hidden text and layers)',
          ),
          sanitize,
        ),
        el(
          'p',
          { class: 'muted' },
          'You can undo this while the PDF is open. Once saved, the removed content cannot be recovered.',
        ),
      ),
      [button('Cancel', null, () => d.close()), button('Apply', null, apply, 'btn primary')],
    );
  }
  /** Remove hidden information, choosing which kinds. */
  async function sanitizeDialog() {
    requireAccess('edit');
    const { sanitizeDocument, SANITIZE_DEFAULTS } = await loadSanitize();
    const LABELS = {
      metadata: 'Document metadata (author, title, XMP)',
      privateData: 'Private data of other applications',
      javascript: 'Scripts',
      actions: 'Links and actions that open other files or sites',
      attachments: 'File attachments',
      thumbnails: 'Embedded page thumbnails',
      searchIndex: 'Embedded search index',
      webCapture: 'Web capture information',
      hiddenText: 'Hidden text (including OCR text layers)',
      comments: 'Comments and markups',
      formFields: 'Form fields',
      hiddenLayers: 'Hidden layers',
      alternateImages: 'Alternate images',
      bookmarks: 'Bookmarks',
    };
    const boxes = Object.entries(LABELS).map(([key, label]) => ({
      key,
      label,
      box: el('input', {
        type: 'checkbox',
        id: `sanitize-${key}`,
        checked: SANITIZE_DEFAULTS[key],
      }),
    }));
    const apply = safe(async () => {
      const options = Object.fromEntries(boxes.map((entry) => [entry.key, entry.box.checked]));
      await mutateDialog(
        d,
        (doc) => sanitizeDocument(doc, options),
        'Hidden information removed. Save or download to keep the cleaned file.',
      );
    });
    const d = modal(
      'Remove hidden information',
      el(
        'div',
        { class: 'stack' },
        el('p', { class: 'muted' }, 'Choose what to remove from the PDF.'),
        ...boxes.map((entry) =>
          el(
            'label',
            { class: 'checkbox-row', for: entry.box.id },
            el('span', {}, entry.label),
            entry.box,
          ),
        ),
      ),
      [button('Cancel', null, () => d.close()), button('Remove', null, apply, 'btn primary')],
    );
  }
  /**
   * Combine files: PDFs and pictures, in an order the person sets, become one new PDF that
   * opens in place of this one (which can come first). Protected PDFs ask for their password.
   */
  function combineDialog() {
    const entries = [];
    const includeCurrent = el('input', { type: 'checkbox', id: 'combine-current', checked: true });
    const list = el('ol', { class: 'combine-list', 'aria-label': 'Files to combine' });
    const empty = el('p', { class: 'muted' }, 'Add PDFs or pictures to combine them.');
    const render = () => {
      empty.hidden = entries.length > 0;
      list.replaceChildren(
        ...entries.map((entry, i) =>
          el(
            'li',
            { class: 'combine-row' },
            el('span', { class: 'combine-name', title: entry.name }, entry.name),
            el(
              'span',
              { class: 'muted combine-kind' },
              entry.kind === 'pdf'
                ? `${entry.pages} ${entry.pages === 1 ? 'page' : 'pages'}`
                : 'Picture',
            ),
            iconButton(`Move ${entry.name} up`, 'ArrowUp', () => move(i, -1), {
              disabled: i === 0,
            }),
            iconButton(`Move ${entry.name} down`, 'ArrowDown', () => move(i, 1), {
              disabled: i === entries.length - 1,
            }),
            iconButton(`Remove ${entry.name}`, 'Trash2', () => {
              entries.splice(i, 1);
              render();
            }),
          ),
        ),
      );
    };
    const move = (i, step) => {
      const [entry] = entries.splice(i, 1);
      entries.splice(i + step, 0, entry);
      render();
      list.querySelectorAll('.combine-row')[i + step]?.querySelector('button')?.focus();
    };
    const addFiles = safe(async () => {
      const input = el('input', {
        type: 'file',
        multiple: true,
        accept: '.pdf,application/pdf,image/png,image/jpeg',
      });
      input.onchange = safe(async () => {
        for (const file of input.files) {
          if (!d.open) return;
          if (/^image\/(png|jpeg)$/.test(file.type)) {
            if (file.size > MAX_IMAGE_SIZE) throw new Error(`${file.name} is larger than 20 MB.`);
            entries.push({ kind: 'image', name: file.name, file });
            continue;
          }
          if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name} is larger than 100 MB.`);
          let bytes = new Uint8Array(await file.arrayBuffer());
          let source = await validatePdf(bytes).catch((error) => {
            if (error.code !== 'encrypted') throw error;
            return null;
          });
          if (!source) {
            const unlocked = await promptUnlock(bytes, file.name, dialogOptions);
            if (!unlocked || !d.open) continue;
            if (!documentAccess(unlocked.protection).copy) {
              const owner = await promptOwner(unlocked.protection, dialogOptions);
              if (!owner || !d.open) continue;
              requireDocumentAccess(owner, 'copy');
            }
            bytes = unlocked.bytes;
            source = await PDFDocument.load(bytes, { updateMetadata: false });
          }
          entries.push({ kind: 'pdf', name: file.name, bytes, pages: source.getPageCount() });
        }
        render();
      });
      input.click();
    });
    const combine = safe(async () => {
      const parts = [
        ...(includeCurrent.checked
          ? [{ kind: 'pdf', name, bytes: session.bytes.slice(), current: true }]
          : []),
        ...entries,
      ];
      if (parts.length < 2) throw new Error('Choose at least two files to combine.');
      if (parts[0]?.current) requireAccess('copy');
      combineButton.disabled = true;
      d.setAttribute('aria-busy', 'true');
      try {
        const doc = await PDFDocument.create();
        for (const part of parts) {
          if (!d.open) return;
          if (part.kind === 'pdf') await insertPdfPages(doc, part.bytes);
          else {
            const images = await normalizeImageFiles([part.file], {
              maxPages: MAX_PAGES - doc.getPageCount(),
              lazy: true,
              signal: dialogController.signal,
            });
            await addImagePages(doc, images, { paper: defaultPaper() });
          }
        }
        const bytes = await savePdf(doc);
        if (!d.open || destroyed) return;
        d.close();
        await onOpenBytes(bytes, 'Combined.pdf');
      } finally {
        combineButton.disabled = false;
        d.removeAttribute('aria-busy');
      }
    });
    const combineButton = button('Combine', 'Files', combine, 'btn primary');
    const d = modal(
      'Combine files',
      el(
        'div',
        { class: 'stack combine-dialog' },
        el(
          'label',
          { class: 'checkbox-row', for: 'combine-current' },
          el('span', {}, `Start with ${name}`),
          includeCurrent,
        ),
        button('Add files…', 'Plus', addFiles, 'btn'),
        empty,
        list,
        el(
          'p',
          { class: 'muted' },
          'Pages are copied in this order into a new PDF. Form fields are flattened so their values stay visible.',
        ),
      ),
      [button('Cancel', null, () => d.close()), combineButton],
    );
    render();
  }
  /** Pick a PDF, then choose which of its pages go where; "after" offers the given page. */
  async function mergeDialog(after = pageIndex, version = beginDialogRequest()) {
    requireAccess('assemble');
    const isCurrent = () => !destroyed && version === dialogVersion();
    const passwordOptions = {
      ...dialogOptions,
      isCurrent,
      // The import's own password prompts advance the dialog generation too.
      onOpen: () => (version = dialogVersion()),
    };
    const input = el('input', { type: 'file', accept: '.pdf,application/pdf' });
    input.onchange = safe(async () => {
      const f = input.files[0];
      if (!f || !canOpenDialog(version)) return;
      try {
        if (f.size > MAX_FILE_SIZE) throw new Error('Choose a PDF smaller than 100 MB.');
        let bytes = new Uint8Array(await f.arrayBuffer());
        if (!canOpenDialog(version)) return;
        let source = await validatePdf(bytes).catch((error) => {
          if (error.code !== 'encrypted') throw error;
          return null;
        });
        if (!canOpenDialog(version)) return;
        if (!source) {
          const unlocked = await promptUnlock(bytes, f.name, passwordOptions);
          if (!unlocked || !canOpenDialog(version)) return;
          if (!documentAccess(unlocked.protection).copy) {
            const owner = await promptOwner(unlocked.protection, passwordOptions);
            if (!owner || !canOpenDialog(version)) return;
            requireDocumentAccess(owner, 'copy');
          }
          bytes = unlocked.bytes;
          source = await PDFDocument.load(bytes, { updateMetadata: false });
        }
        if (!canOpenDialog(version)) return;
        await insertPagesDialog(bytes, f.name, source.getPageCount(), after);
      } catch (error) {
        if (isCurrent()) throw error;
      }
    });
    input.click();
  }
  function insertPagesDialog(bytes, sourceName, sourceCount, current = pageIndex) {
    const rangeInput = el('input', {
      type: 'text',
      class: 'input',
      placeholder: 'e.g. 1-3, 5',
      'aria-label': 'Pages of the other PDF',
      inputmode: 'numeric',
      autocomplete: 'off',
    });
    const choice = (group, value, label, checked) =>
      el(
        'label',
        { class: 'choice-row' },
        el('input', { type: 'radio', name: group, value, checked }),
        el('span', {}, label),
      );
    const rangeChoice = choice('insert-pages', 'range', 'Pages', false);
    rangeInput.addEventListener('input', () => {
      rangeChoice.querySelector('input').checked = true;
    });
    const pages = el(
      'div',
      { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Pages to insert' },
      choice('insert-pages', 'all', `All pages (${sourceCount})`, true),
      el('div', { class: 'choice-with-input' }, rangeChoice, rangeInput),
    );
    const where = el(
      'div',
      { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Where to insert' },
      choice('insert-where', 'after', `After page ${current + 1}`, true),
      choice('insert-where', 'end', 'At the end', false),
      choice('insert-where', 'start', 'At the beginning', false),
    );
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        `${sourceName} has ${sourceCount} ${sourceCount === 1 ? 'page' : 'pages'}. Filled forms in it become fixed page content.`,
      ),
      el('p', { class: 'muted' }, 'Pages'),
      pages,
      el('p', { class: 'muted' }, 'Place them'),
      where,
    );
    let inserting = false;
    const apply = safe(async () => {
      if (inserting || destroyed || !d.open) return;
      const indices =
        pages.querySelector('input:checked')?.value === 'range'
          ? parsePageRange(rangeInput.value, sourceCount)
          : Array.from({ length: sourceCount }, (_, i) => i);
      const placement = where.querySelector('input:checked')?.value;
      inserting = true;
      const controls = [insertButton, ...form.querySelectorAll('input')];
      controls.forEach((control) => (control.disabled = true));
      try {
        // Reading the chosen file can take long enough for more edits or history commands.
        // Preserve those changes before inserting pages replaces the rendered document.
        await idle();
        if (destroyed || !d.open) return;
        await finishDrafts();
        if (destroyed || !d.open) return;
        const after = placement === 'start' ? -1 : placement === 'end' ? pdf.numPages - 1 : current;
        d.close();
        await mutate(
          async (doc) => {
            const [first] = await insertPdfPages(doc, bytes, { pages: indices, after });
            // From the page being read the view moves to the new pages; from another page's
            // thumbnail it stays where it is.
            if (current === pageIndex) pageIndex = first;
            else if (after < pageIndex) pageIndex += indices.length;
          },
          `${indices.length === 1 ? '1 page' : `${indices.length} pages`} inserted ${
            placement === 'start'
              ? 'at the beginning'
              : placement === 'end'
                ? 'at the end'
                : `after page ${current + 1}`
          }.`,
          'assemble',
        );
      } finally {
        inserting = false;
        controls.forEach((control) => (control.disabled = false));
      }
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const insertButton = button('Insert pages', 'Files', apply, 'btn primary');
    const d = modal('Insert pages', form, [button('Cancel', null, () => d.close()), insertButton]);
    return new Promise((resolve) => d.addEventListener('close', () => resolve(), { once: true }));
  }
  function goToPage() {
    if (!pdf) return;
    const input = el('input', {
      type: 'number',
      class: 'input',
      id: 'go-to-page',
      min: 1,
      max: pdf.numPages,
      value: pageIndex + 1,
      required: true,
    });
    const form = el(
      'form',
      {},
      el('label', { for: 'go-to-page' }, `Page number (1 to ${pdf.numPages})`),
      input,
    );
    const go = () => {
      if (!input.reportValidity()) return;
      const target = Number(input.value) - 1;
      d.close();
      navigate(target);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      go();
    };
    const d = modal('Go to page', form, [
      button('Cancel', null, () => d.close()),
      button('Go', null, go, 'btn primary'),
    ]);
    input.focus();
    input.select();
  }
  /** A radio list of page choices shared by the print and extract dialogs. */
  function pageChoices(group, count, { all = group === 'print-pages' } = {}) {
    const rangeInput = el('input', {
      type: 'text',
      class: 'input',
      placeholder: 'e.g. 1-3, 5',
      'aria-label': 'Page range',
      inputmode: 'numeric',
      autocomplete: 'off',
    });
    const choice = (value, label, checked) =>
      el(
        'label',
        { class: 'choice-row' },
        el('input', { type: 'radio', name: group, value, checked }),
        el('span', {}, label),
      );
    const rangeChoice = choice('range', 'Pages', false);
    rangeInput.addEventListener('input', () => {
      rangeChoice.querySelector('input').checked = true;
    });
    const list = el(
      'div',
      { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Pages to include' },
      all && choice('all', `All pages (${count})`, true),
      choice('current', `Current page (${pageIndex + 1})`, !all),
      el('div', { class: 'choice-with-input' }, rangeChoice, rangeInput),
    );
    return {
      list,
      indices: () => {
        const selected = list.querySelector('input:checked')?.value;
        if (selected === 'all') return Array.from({ length: count }, (_, i) => i);
        return selected === 'current' ? [pageIndex] : parsePageRange(rangeInput.value, count);
      },
    };
  }
  /** A labeled control inside a dialog form; extra nodes sit in a row beside the control. */
  function labeled(id, label, control, ...beside) {
    control.id = id;
    return el(
      'div',
      { class: 'field' },
      el('label', { for: id }, label),
      beside.length ? el('div', { class: 'field-inline' }, control, ...beside) : control,
    );
  }
  function selectInput(id, options, value) {
    return el(
      'select',
      { id, class: 'input' },
      ...options.map(([key, label]) =>
        el('option', { value: key, selected: key === value }, label),
      ),
    );
  }
  /** Stamp a centered text watermark on the chosen pages. */
  function watermarkDialog() {
    if (!pdf) return;
    const text = el('input', {
      class: 'input',
      value: 'CONFIDENTIAL',
      maxlength: 200,
      autocomplete: 'off',
      required: true,
    });
    const layout = selectInput(
      'watermark-layout',
      [
        ['diagonal', 'Diagonal'],
        ['horizontal', 'Horizontal'],
      ],
      'diagonal',
    );
    const size = selectInput(
      'watermark-size',
      Object.keys(WATERMARK_SIZES).map((key) => [key, key[0].toUpperCase() + key.slice(1)]),
      'medium',
    );
    const colorPick = el('input', { type: 'color', value: '#000000' });
    const opacity = el('input', { type: 'range', min: 5, max: 100, step: 5, value: 25 });
    const opacityValue = el('output', { for: 'watermark-opacity' }, '25%');
    opacity.oninput = () => {
      opacityValue.textContent = `${opacity.value}%`;
    };
    const choices = pageChoices('watermark-pages', pdf.numPages, { all: true });
    const form = el(
      'form',
      { class: 'stack' },
      labeled('watermark-text', 'Text', text),
      el(
        'div',
        { class: 'field-grid' },
        labeled('watermark-layout', 'Layout', layout),
        labeled('watermark-size', 'Size', size),
        labeled('watermark-color', 'Color', colorPick),
        labeled('watermark-opacity', 'Opacity', opacity, opacityValue),
      ),
      el('p', { class: 'muted' }, 'Pages'),
      choices.list,
    );
    const apply = safe(async () => {
      if (!text.value.trim()) {
        toast('Enter the watermark text.', { error: true });
        text.focus();
        return;
      }
      const indices = choices.indices();
      await mutateDialog(
        d,
        (doc) =>
          addWatermark(doc, indices, {
            text: text.value.trim(),
            layout: layout.value,
            size: size.value,
            hex: colorPick.value,
            opacity: Number(opacity.value) / 100,
          }),
        `Watermark added to ${indices.length === 1 ? 'the page' : `${indices.length} pages`}.`,
      );
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Add watermark', form, [
      button('Cancel', null, () => d.close()),
      button('Add watermark', 'Stamp', apply, 'btn primary'),
    ]);
    text.focus();
    text.select();
  }
  /** Text in the corners and centers of the top and bottom edges, with tokens for numbers and dates. */
  async function headerFooterDialog(version = beginDialogRequest(), { bates = false } = {}) {
    if (!pdf) return;
    const { documentDetails } = await import('./core/details.js');
    const doc = await workingDocument(version);
    if (!doc) return;
    const details = documentDetails(doc, session.bytes);
    const labels = {
      topLeft: 'Top left',
      topCenter: 'Top center',
      topRight: 'Top right',
      bottomLeft: 'Bottom left',
      bottomCenter: 'Bottom center',
      bottomRight: 'Bottom right',
    };
    const inputs = Object.fromEntries(
      HEADER_SLOTS.map((slot) => [
        slot,
        el('input', {
          class: 'input',
          maxlength: 200,
          autocomplete: 'off',
          placeholder:
            slot === 'bottomCenter'
              ? 'Page {page} of {pages}'
              : slot === 'topLeft'
                ? '{title}'
                : slot === 'topRight'
                  ? '{date}'
                  : '',
        }),
      ]),
    );
    const size = el('input', {
      type: 'number',
      class: 'input',
      value: 10,
      min: 6,
      max: 36,
      step: 'any',
      required: true,
    });
    const choices = pageChoices('header-pages', pdf.numPages, { all: true });
    // Bates numbers count across the chosen pages with a fixed width, prefix, and suffix.
    const batesFields = {
      prefix: el('input', { class: 'input', maxlength: 40, autocomplete: 'off' }),
      start: el('input', { type: 'number', class: 'input', value: 1, min: 0, step: 1 }),
      digits: el('input', { type: 'number', class: 'input', value: 6, min: 1, max: 15, step: 1 }),
      suffix: el('input', { class: 'input', maxlength: 40, autocomplete: 'off' }),
    };
    const batesSection = el(
      'details',
      { class: 'bates-options', ...(bates && { open: true }) },
      el('summary', {}, 'Bates numbering'),
      el(
        'p',
        { class: 'muted' },
        'Put {bates} in any position to number the chosen pages, such as ABC000001.',
      ),
      el(
        'div',
        { class: 'field-grid' },
        labeled('bates-prefix', 'Prefix', batesFields.prefix),
        labeled('bates-start', 'Start number', batesFields.start),
        labeled('bates-digits', 'Number of digits', batesFields.digits),
        labeled('bates-suffix', 'Suffix', batesFields.suffix),
      ),
    );
    if (bates) inputs.bottomRight.value = '{bates}';
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'Write into any of the six places. {page}, {pages}, {date}, {title}, {file}, and {bates} are filled in for each page.',
      ),
      el(
        'div',
        { class: 'field-grid' },
        ...HEADER_SLOTS.map((slot) => labeled(`header-${slot}`, labels[slot], inputs[slot])),
      ),
      el('div', { class: 'field-grid' }, labeled('header-size', 'Size (pt)', size)),
      batesSection,
      el('p', { class: 'muted' }, 'Pages'),
      choices.list,
    );
    const apply = safe(async () => {
      const indices = choices.indices();
      const slots = Object.fromEntries(HEADER_SLOTS.map((slot) => [slot, inputs[slot].value]));
      await mutateDialog(
        d,
        (doc) =>
          addHeaderFooter(doc, indices, {
            slots,
            size: size.value,
            title: details.title || '',
            file: name.replace(/\.pdf$/i, ''),
            bates: Object.values(slots).some((text) => /\{bates\}/i.test(text))
              ? {
                  prefix: batesFields.prefix.value,
                  suffix: batesFields.suffix.value,
                  start: Number(batesFields.start.value),
                  digits: Number(batesFields.digits.value),
                }
              : null,
          }),
        `Header and footer added to ${indices.length === 1 ? 'the page' : `${indices.length} pages`}.`,
      );
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal(bates ? 'Bates numbering' : 'Header and footer', form, [
      button('Cancel', null, () => d.close()),
      button('Add header and footer', 'PanelTopBottomDashed', apply, 'btn primary'),
    ]);
    (bates ? batesFields.prefix : inputs.topLeft).focus();
  }
  /** Number the chosen pages in a corner or centered at the top or bottom. */
  function pageNumbersDialog() {
    if (!pdf) return;
    const position = selectInput(
      'numbers-position',
      NUMBER_POSITIONS.map((key) => {
        const [vertical, horizontal] = key.split('-');
        return [key, `${vertical[0].toUpperCase() + vertical.slice(1)} ${horizontal}`];
      }),
      'bottom-center',
    );
    const format = selectInput(
      'numbers-format',
      Object.entries(NUMBER_FORMATS).map(([key, template]) => [
        key,
        template.replace('{n}', '1').replace('{N}', String(pdf.numPages)),
      ]),
      'of',
    );
    const start = el('input', {
      type: 'number',
      class: 'input',
      value: 1,
      min: 0,
      max: 99999,
      step: 1,
      required: true,
    });
    const size = el('input', {
      type: 'number',
      class: 'input',
      value: 11,
      min: 6,
      max: 72,
      step: 'any',
      required: true,
    });
    const choices = pageChoices('numbers-pages', pdf.numPages, { all: true });
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'div',
        { class: 'field-grid' },
        labeled('numbers-position', 'Position', position),
        labeled('numbers-format', 'Format', format),
        labeled('numbers-start', 'Start at', start),
        labeled('numbers-size', 'Size (pt)', size),
      ),
      el('p', { class: 'muted' }, 'Pages'),
      choices.list,
    );
    const apply = safe(async () => {
      if (!form.reportValidity()) return;
      const indices = choices.indices();
      await mutateDialog(
        d,
        (doc) =>
          addPageNumbers(doc, indices, {
            format: format.value,
            position: position.value,
            start: start.value,
            size: size.value,
          }),
        `Page numbers added to ${indices.length === 1 ? 'the page' : `${indices.length} pages`}.`,
      );
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Add page numbers', form, [
      button('Cancel', null, () => d.close()),
      button('Add page numbers', 'Hash', apply, 'btn primary'),
    ]);
    position.focus();
  }
  /** Choose what to print, then hand the pages to the browser's print command. */
  function printDialog() {
    requireAccess('print');
    if (!pdf) return;
    const choices = pageChoices('print-pages', pdf.numPages);
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'Each page prints on its own sheet, scaled to fit. Your browser’s print dialog chooses the printer, paper, and copies.',
      ),
      choices.list,
    );
    const print = safe(async () => {
      const indices = choices.indices();
      d.close();
      await runPrint(indices);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      print();
    };
    const d = modal('Print', form, [
      button('Cancel', null, () => d.close()),
      button('Print', 'Printer', print, 'btn primary'),
    ]);
  }
  async function runPrint(indices) {
    requireAccess('print');
    if (busy || destroyed) return;
    busy = true;
    updateStatus();
    const controller = new AbortController();
    let handing = false;
    const progress = el('p', { class: 'muted', role: 'status' }, 'Preparing pages…');
    const d = modal('Printing', el('div', { class: 'stack' }, progress), [
      button('Cancel', null, () => controller.abort()),
    ]);
    // Escape and the close button cancel too; the dialog also closes on its own right before
    // the browser's print dialog takes over.
    d.addEventListener('close', () => {
      if (!handing) controller.abort();
    });
    try {
      await printPages(pdf, indices, {
        maxDpi: access().printHighQuality ? Infinity : 150,
        signal: controller.signal,
        onProgress: (done, total) => {
          if (done < total) {
            progress.textContent = `Preparing page ${done + 1} of ${total}…`;
            return;
          }
          handing = true;
          d.close();
        },
      });
    } catch (error) {
      if (!['AbortError', 'RenderingCancelledException'].includes(error?.name)) throw error;
    } finally {
      if (d.open) d.close();
      busy = false;
      updateStatus();
    }
  }
  /** Save one page as a PNG picture at 144 dpi, with its annotations. */
  function downloadPageImage(index) {
    return exportPageImages([index], { type: 'image/png', dpi: 144 });
  }
  /** Show and edit the document's title, author, subject, and keywords, with its facts. */
  async function detailsDialog(version = beginDialogRequest()) {
    if (!pdf) return;
    const { documentDetails, setDocumentDetails } = await import('./core/details.js');
    const doc = await workingDocument(version);
    if (!doc) return;
    const details = documentDetails(doc, session.bytes);
    const inputs = {};
    const initialValues = {};
    const rows = [
      ['title', 'Title'],
      ['author', 'Author'],
      ['subject', 'Subject'],
      ['keywords', 'Keywords'],
    ].map(([key, label]) => {
      const input = el('textarea', {
        class: 'input',
        id: `detail-${key}`,
        readOnly: !access().edit,
        maxlength: 1000,
        autocomplete: 'off',
      });
      input.value = details[key];
      inputs[key] = input;
      // Textareas display line breaks but normalize CR/CRLF to LF. Compare with
      // the initial control value so untouched source metadata remains exact.
      initialValues[key] = input.value;
      const resize = () => {
        input.rows = Math.max(key === 'subject' ? 2 : 1, input.value.split('\n', 4).length);
      };
      resize();
      input.addEventListener('input', resize);
      return el('div', { class: 'field' }, el('label', { for: `detail-${key}` }, label), input);
    });
    const when = (date) =>
      date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const facts = [
      ['Pages', String(details.pages)],
      ['File size', formatBytes(details.size)],
      ['Created', when(details.created)],
      ['Modified', when(details.modified)],
      ['Created with', details.creator],
      ['Produced by', details.producer],
    ].filter(([, value]) => value);
    // How the PDF asks to open, and the fonts its pages use.
    const view = readInitialView(doc);
    const layout = selectInput(
      'detail-layout',
      [
        ['default', 'Default'],
        ['single', 'Single page'],
        ['continuous', 'Single page, scrolling'],
        ['two', 'Two-page'],
        ['two-continuous', 'Two-page, scrolling'],
      ],
      view.layout,
    );
    const panel = selectInput(
      'detail-panel',
      [
        ['none', 'Page only'],
        ['bookmarks', 'Bookmarks panel and page'],
        ['pages', 'Pages panel and page'],
        ['attachments', 'Attachments panel and page'],
        ['layers', 'Layers panel and page'],
      ],
      view.panel,
    );
    const openPage = el('input', {
      class: 'input',
      type: 'number',
      min: 1,
      max: details.pages,
      step: 1,
      value: view.page + 1,
    });
    const zoom = selectInput(
      'detail-zoom',
      [
        ['default', 'Default'],
        ['fit', 'Fit width'],
        ['page', 'Fit page'],
        // A magnification the list lacks is offered as the file has it, so it is kept.
        ...[0.5, 0.75, 1, 1.25, 1.5, 2, view.zoom]
          .filter((value, i, all) => typeof value === 'number' && all.indexOf(value) === i)
          .sort((a, b) => a - b)
          .map((value) => [String(value), `${Math.round(value * 1000) / 10}%`]),
      ],
      String(view.zoom),
    );
    const displayTitle = el('input', {
      type: 'checkbox',
      id: 'detail-display-title',
      checked: view.displayTitle,
    });
    const initialView = el(
      'details',
      { class: 'detail-section' },
      el('summary', {}, 'Initial view'),
      el(
        'div',
        { class: 'field-grid' },
        labeled('detail-layout', 'Page layout', layout),
        labeled('detail-panel', 'Navigation', panel),
        labeled('detail-open-page', 'Open to page', openPage),
        labeled('detail-zoom', 'Magnification', zoom),
      ),
      el(
        'label',
        { class: 'checkbox-row', for: 'detail-display-title' },
        el('span', {}, 'Window shows the name stored in the document, not the file name'),
        displayTitle,
      ),
    );
    const fonts = listFonts(doc);
    const fontList = el(
      'details',
      { class: 'detail-section' },
      el('summary', {}, `Fonts (${fonts.length})`),
      fonts.length
        ? el(
            'ul',
            { class: 'detail-fonts' },
            ...fonts.map((font) =>
              el(
                'li',
                {},
                el('span', {}, font.name),
                el(
                  'span',
                  { class: 'muted' },
                  `${font.type}${font.encoding ? `, ${font.encoding}` : ''}, ${
                    font.embedded ? (font.subset ? 'embedded subset' : 'embedded') : 'not embedded'
                  }`,
                ),
              ),
            ),
          )
        : el('p', { class: 'muted' }, 'The pages use no fonts.'),
    );
    if (!access().edit)
      [layout, panel, openPage, zoom, displayTitle].forEach((control) => (control.disabled = true));
    const form = el(
      'form',
      { class: 'stack' },
      ...rows,
      el(
        'dl',
        { class: 'detail-facts' },
        ...facts.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)]),
      ),
      initialView,
      fontList,
    );
    const apply = safe(async () => {
      const values = Object.fromEntries(
        Object.entries(inputs)
          .filter(([key, input]) => input.value !== initialValues[key])
          .map(([key, input]) => [key, input.value]),
      );
      const zoomValue = ['default', 'fit', 'page'].includes(zoom.value)
        ? zoom.value
        : Number(zoom.value);
      const next = {
        layout: layout.value,
        panel: panel.value,
        page: Math.max(0, Math.min(details.pages - 1, Number(openPage.value) - 1 || 0)),
        zoom: zoomValue,
        displayTitle: displayTitle.checked,
      };
      const viewChanges = Object.fromEntries(
        Object.entries(next).filter(([key, value]) => value !== view[key]),
      );
      await mutateDialog(d, (doc) => {
        let changed = setDocumentDetails(doc, values);
        if (Object.keys(viewChanges).length) {
          writeInitialView(doc, viewChanges);
          changed = true;
        }
        return changed;
      });
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Document details', form, [
      button('Cancel', null, () => d.close()),
      ...(access().edit ? [button('Save details', 'Check', apply, 'btn primary')] : []),
    ]);
    inputs.title.focus();
  }
  /** Save the chosen pages as PNG or JPEG pictures, one file or a ZIP of them. */
  function pageImagesDialog() {
    requireAccess('copy');
    if (!pdf) return;
    const format = selectInput(
      'images-format',
      [
        ['image/png', 'PNG (sharp, larger files)'],
        ['image/jpeg', 'JPEG (smaller files)'],
      ],
      'image/png',
    );
    const dpi = selectInput(
      'images-dpi',
      [
        ['72', '72 dpi (screen)'],
        ['144', '144 dpi (sharp on screens)'],
        ['300', '300 dpi (print)'],
      ],
      '144',
    );
    const choices = pageChoices('images-pages', pdf.numPages, { all: true });
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'Each page becomes a picture with its annotations. One page downloads as a file; several download together as a ZIP.',
      ),
      el(
        'div',
        { class: 'field-grid' },
        labeled('images-format', 'Format', format),
        labeled('images-dpi', 'Resolution', dpi),
      ),
      el('p', { class: 'muted' }, 'Pages'),
      choices.list,
    );
    const apply = safe(async () => {
      const indices = choices.indices();
      d.close();
      await exportPageImages(indices, { type: format.value, dpi: Number(dpi.value) });
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Download pages as images', form, [
      button('Cancel', null, () => d.close()),
      button('Download', 'ImageDown', apply, 'btn primary'),
    ]);
    format.focus();
  }
  /**
   * Render the chosen pages to pictures and download them. Rendering a complex page or many
   * pages takes a while, so the editor is held busy behind a progress dialog that can
   * cancel it: an edit part way through would reload the document out from under the render.
   */
  async function exportPageImages(indices, { type, dpi }) {
    requireAccess('copy');
    if (busy || destroyed || !pdf) return;
    // Overlapping ranges describe the same picture. Render each page once, retaining
    // the requested order and avoiding duplicate filenames inside the archive.
    indices = [...new Set(indices)];
    busy = true;
    updateStatus();
    const controller = new AbortController();
    const progress = el('p', { class: 'muted', role: 'status' }, 'Preparing pages…');
    const d = modal('Downloading pages as images', el('div', { class: 'stack' }, progress), [
      button('Cancel', null, () => controller.abort()),
    ]);
    // Escape and the close button cancel too; the dialog closes on its own when done.
    let done = false;
    d.addEventListener('close', () => {
      if (!done) controller.abort();
    });
    const thisPdf = pdf,
      extension = type === 'image/jpeg' ? 'jpg' : 'png',
      base = safeName(name).replace(/\.pdf$/i, '');
    try {
      const files = [];
      let picture;
      for (const [k, index] of indices.entries()) {
        controller.signal.throwIfAborted();
        progress.textContent = `Rendering page ${k + 1} of ${indices.length}…`;
        const blob = await pageImage(thisPdf, index, { dpi, type, signal: controller.signal });
        if (destroyed) return;
        // Limit the base before adding the page number so long names cannot collide in a ZIP.
        const fileName = `${base} page ${index + 1}.${extension}`;
        // A single image can download directly; only a ZIP needs a copy of its bytes.
        if (indices.length === 1) picture = { name: fileName, blob };
        else files.push({ name: fileName, bytes: new Uint8Array(await blob.arrayBuffer()) });
      }
      controller.signal.throwIfAborted();
      done = true;
      if (picture) download(picture.blob, picture.name);
      else download(new Blob(zipParts(files), { type: 'application/zip' }), `${base} pages.zip`);
      const kind = type === 'image/jpeg' ? 'JPEG' : 'PNG';
      toast(
        indices.length === 1
          ? `Page ${indices[0] + 1} downloaded as a ${kind} picture.`
          : `${files.length} pages downloaded as ${kind} pictures in a ZIP.`,
      );
    } catch (error) {
      if (!['AbortError', 'RenderingCancelledException'].includes(error?.name)) throw error;
    } finally {
      done = true;
      if (d.open) d.close();
      busy = false;
      updateStatus();
    }
  }
  /* ---------- Comments drawn as annotations ---------- */
  /** Ask for a comment's text; resolves to it, or null when cancelled. */
  function commentTextDialog(title, value = '') {
    return new Promise((resolve) => {
      let result = null;
      const area = el('textarea', { class: 'input', rows: 4, maxlength: 20000 });
      area.value = value;
      const done = () => {
        result = area.value;
        d.close();
      };
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          done();
        }
      });
      const d = modal(
        title,
        el('div', { class: 'stack' }, labeled('comment-text', 'Text', area)),
        [button('Cancel', null, () => d.close()), button('Add', null, done, 'btn primary')],
        dialogOptions,
      );
      d.addEventListener('close', () => resolve(result), { once: true });
      area.focus();
    });
  }
  /** Draw the clicked corners of a perimeter or an area, and the edge to the pointer. */
  let measurePage = 0;
  function drawMeasurePath(pointer) {
    const ctx = clearOverlay();
    if (!measurePath.length) return;
    ctx.setTransform(overlay.width / viewport.width, 0, 0, overlay.height / viewport.height, 0, 0);
    ctx.strokeStyle = toolColors.comment;
    ctx.lineWidth = 1.5;
    const screen = measurePath.map((point) => viewport.convertToViewportPoint(point.x, point.y));
    ctx.beginPath();
    screen.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (pointer) ctx.lineTo(pointer.x, pointer.y);
    if (measureMode.value === 'area') ctx.closePath();
    ctx.stroke();
    const points = pointer ? [...measurePath, pdfPoint(pointer)] : measurePath;
    hint.textContent = measureLabel(measureMode.value === 'area' ? 'area' : 'distance', points, {
      ...measureScale,
      userUnit: viewport.userUnit,
    });
  }
  overlay.addEventListener('pointermove', (e) => {
    if (tool === 'measure' && measurePath.length && !gesture) drawMeasurePath(screenPoint(e));
  });
  overlay.addEventListener('dblclick', () => {
    if (tool === 'measure' && measurePath.length) safe(finishMeasure)();
  });
  /** Turn the clicked corners into a measured comment: a path or an area with its label. */
  async function finishMeasure() {
    // A double-click also clicked the last corner twice.
    const points = measurePath.filter(
      (point, i, all) => !i || Math.hypot(point.x - all[i - 1].x, point.y - all[i - 1].y) > 0.5,
    );
    const page = measurePage;
    measurePath = [];
    clearOverlay();
    const area = measureMode.value === 'area';
    if (points.length < (area ? 3 : 2)) {
      hint.textContent = measureHint();
      return;
    }
    await addMeasurement(page, area ? 'area' : 'perimeter', points);
  }
  async function addMeasurement(page, kind, points) {
    const scale = { ...measureScale, userUnit: viewport.userUnit };
    const label = measureLabel(kind === 'area' ? 'area' : 'distance', points, scale);
    const author = getUser()?.username || '';
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y);
    const center =
      kind === 'distance'
        ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
        : {
            x: (Math.min(...xs) + Math.max(...xs)) / 2,
            y: (Math.min(...ys) + Math.max(...ys)) / 2,
          };
    const fontSize = 9 / viewport.userUnit;
    const labelWidth = label.length * fontSize * 0.6 + 8,
      labelHeight = fontSize * 1.6;
    // The label sits centered just above the middle, as the page reads, turned or not.
    const [cx, cy] = viewport.convertToViewportPoint(center.x, center.y);
    const unit = screenUnit();
    const labelRect = readerRect(
      { x: cx - (labelWidth / 2) * unit, y: cy - (2 + labelHeight) * unit },
      labelWidth,
      labelHeight,
    );
    await mutate(
      async (doc) => {
        addShapeAnnotation(doc, page, {
          kind: kind === 'area' ? 'polygon' : kind === 'distance' ? 'line' : 'polyline',
          points,
          color: toolColors.comment,
          width: 1,
          author,
          text: label,
        });
        await addTextBox(doc, page, {
          rect: labelRect,
          text: label,
          fontSize,
          color: toolColors.comment,
          fill: '#ffffff',
          borderWidth: 0,
          align: 'center',
          author,
        });
      },
      `Measured: ${label}.`,
      'annotate',
    );
    hint.textContent = measureHint();
  }
  /** Place the comment a gesture drew: a text box, a callout, a shape, or a pencil stroke. */
  async function placeComment(g, end) {
    const author = getUser()?.username || '';
    const hex = g.hex;
    const width = Math.max(0.5, g.width);
    const moved = Math.hypot(end.x - g.start.x, end.y - g.start.y) >= 4;
    if (g.type === 'measure') {
      if (!moved) return;
      return addMeasurement(g.page, 'distance', [pdfPoint(g.start), pdfPoint(end)]);
    }
    if (g.type === 'pencil') {
      if (g.points.length < 2) return;
      const points = g.points.map(pdfPoint);
      return commitDrawing(
        (doc) => addInkAnnotation(doc, g.page, { strokes: [points], color: hex, width, author }),
        'annotate',
      );
    }
    if (g.type === 'cshape') {
      if (!moved) return;
      const from = pdfPoint(g.start),
        to = pdfPoint(end);
      const kind = g.commentKind;
      return commitDrawing(
        (doc) =>
          addShapeAnnotation(doc, g.page, {
            kind,
            ...(kind === 'line' || kind === 'arrow'
              ? { points: [from, to] }
              : { rect: normalizeRect(from, to) }),
            color: hex,
            width,
            author,
          }),
        'annotate',
      );
    }
    const fontSize = commentSize / viewport.userUnit;
    if (g.type === 'textbox') {
      const rect = moved
        ? normalizeRect(pdfPoint(g.start), pdfPoint(end))
        : readerRect(g.start, 180, 50);
      const text = await commentTextDialog('Text box');
      if (text == null || destroyed) return;
      return mutate(
        (doc) => addTextBox(doc, g.page, { rect, text, fontSize, borderColor: hex, author }),
        null,
        'annotate',
      );
    }
    if (g.type === 'callout') {
      const anchor = pdfPoint(g.start);
      const corner = moved ? end : { x: g.start.x + 60, y: g.start.y - 60 };
      // The box grows from the dragged-to corner away from its point, which it must not cover:
      // leftwards when dragged to the left, upwards when dragged straight up.
      const unit = screenUnit();
      const rect = readerRect(
        {
          x: corner.x < g.start.x ? corner.x - 180 * unit : corner.x,
          y: corner.x === g.start.x && corner.y < g.start.y ? corner.y - 50 * unit : corner.y,
        },
        180,
        50,
      );
      const text = await commentTextDialog('Callout');
      if (text == null || destroyed) return;
      return mutate(
        (doc) =>
          addCallout(doc, g.page, { rect, anchor, text, fontSize, borderColor: hex, author }),
        null,
        'annotate',
      );
    }
  }
  async function removeAnnotation(entry) {
    await mutate(
      (doc) => deleteAnnotation(doc, pageIndex, entry.id),
      `${entry.kind} deleted.`,
      'annotate',
    );
    // The deleted comment or its Delete button held the focus; keep it on the page, as
    // deleting a markup does.
    if (!destroyed && document.activeElement === document.body)
      overlay.focus({ preventScroll: true });
  }
  /** The selected comment's text, look, replies, and review status in the properties panel. */
  function showAnnotationProperties(entry) {
    if (!entry) return properties.clear('annotation');
    // A stamp keeps its own art and a read-only comment takes no change: offer only what applies.
    const editable = entry.editable && !entry.locked && !entry.readOnly && access().annotate;
    const accepts = (key) => editable && annotationAccepts(entry.subtype, key);
    const apply = (changes, message = null) =>
      safe(() =>
        mutate((doc) => editAnnotation(doc, pageIndex, entry.id, changes), message, 'annotate', {
          retainScale: true,
        }),
      )();
    const text = el('textarea', {
      class: 'input',
      rows: 3,
      maxlength: 20000,
      'aria-label': entry.subtype === 'FreeText' ? 'Text' : 'Comment',
      readOnly: !!entry.lockedContents || !!entry.readOnly || !access().annotate,
    });
    text.value = entry.contents || '';
    text.addEventListener('change', () => apply({ contents: text.value }));
    const color = el('input', {
      type: 'color',
      value: entry.color || '#e5322d',
      'aria-label': entry.subtype === 'FreeText' ? 'Text color' : 'Color',
      disabled: !accepts('color'),
      onchange: () => apply({ color: color.value }),
    });
    const fillable = ['Square', 'Circle', 'Polygon', 'FreeText'].includes(entry.subtype);
    const fill = el('input', {
      type: 'color',
      value: entry.fill || '#ffffff',
      'aria-label': 'Fill color',
      disabled: !accepts('fill'),
      onchange: () => apply({ fill: fill.value }),
    });
    const noFill = el('input', {
      type: 'checkbox',
      checked: !entry.fill,
      'aria-label': 'No fill',
      disabled: !accepts('fill'),
      onchange: () => apply({ fill: noFill.checked ? null : fill.value }),
    });
    const width = el(
      'select',
      {
        'aria-label': 'Line width',
        disabled: !accepts('width'),
        onchange: () => apply({ width: Number(width.value) }),
      },
      ...[0.5, 1, 2, 3, 4, 6, 8].map((n) =>
        el('option', { value: n, selected: Math.abs((entry.width ?? 1) - n) < 0.01 }, `${n} pt`),
      ),
    );
    const opacity = el('input', {
      type: 'range',
      min: 10,
      max: 100,
      step: 5,
      value: Math.round((entry.opacity ?? 1) * 100),
      'aria-label': 'Opacity',
      disabled: !accepts('opacity'),
      onchange: () => apply({ opacity: Number(opacity.value) / 100 }),
    });
    const fontSize =
      entry.subtype === 'FreeText' &&
      el('input', {
        type: 'number',
        min: 4,
        max: 144,
        value: entry.fontSize || 12,
        'aria-label': 'Font size',
        disabled: !accepts('fontSize'),
        onchange: () => apply({ fontSize: Number(fontSize.value) }),
      });
    const status = el(
      'select',
      {
        'aria-label': 'Review status',
        disabled: !access().annotate,
        onchange: () =>
          safe(() =>
            mutate(
              (doc) =>
                setReviewState(doc, pageIndex, entry.id, {
                  state: status.value,
                  author: getUser()?.username || '',
                }),
              `Status set to ${status.value}.`,
              'annotate',
              { retainScale: true },
            ),
          )(),
      },
      ...REVIEW_STATES.map((state) =>
        el('option', { value: state, selected: (entry.state?.state || 'None') === state }, state),
      ),
    );
    const replyText = el('textarea', {
      class: 'input',
      rows: 2,
      placeholder: 'Write a reply',
      'aria-label': 'Reply text',
    });
    const when = (date) =>
      date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const replies = (entry.replies || []).map((reply) =>
      el(
        'li',
        {},
        el(
          'span',
          { class: 'reply-meta muted' },
          [reply.author, when(reply.modified)].filter(Boolean).join(' · '),
        ),
        el('span', {}, reply.contents || ''),
      ),
    );
    const panel = el(
      'div',
      { class: 'annotation-props' },
      el(
        'p',
        { class: 'muted annotation-meta' },
        [entry.author, when(entry.modified)].filter(Boolean).join(' · ') || entry.kind,
      ),
      text,
      el(
        'div',
        { class: 'annotation-style' },
        el('label', {}, el('span', {}, 'Color'), color),
        fillable && el('label', {}, el('span', {}, 'Fill'), fill, noFill),
        annotationAccepts(entry.subtype, 'width') &&
          el('label', {}, el('span', {}, 'Width'), width),
        el('label', {}, el('span', {}, 'Opacity'), opacity),
        fontSize && el('label', {}, el('span', {}, 'Font size'), fontSize),
      ),
      el('label', { class: 'annotation-status' }, el('span', {}, 'Status'), status),
      replies.length > 0 &&
        el('ul', { class: 'annotation-replies', 'aria-label': 'Replies' }, ...replies),
      replyText,
      el(
        'div',
        { class: 'annotation-actions' },
        button(
          'Reply',
          null,
          safe(async () => {
            if (!replyText.value.trim()) return;
            await mutate(
              (doc) =>
                addReply(doc, pageIndex, entry.id, {
                  text: replyText.value.trim(),
                  author: getUser()?.username || '',
                }),
              'Reply added.',
              'annotate',
              { retainScale: true },
            );
          }),
          'btn',
          { disabled: !access().annotate },
        ),
        button('Delete', 'Trash2', () => safe(() => removeAnnotation(entry))(), 'btn danger', {
          disabled: entry.locked || entry.readOnly || !access().annotate,
        }),
      ),
    );
    properties.show('annotation', entry.kind, panel);
  }
  /** Comments out as XFDF (as other PDF editors exchange them) or a plain text summary. */
  async function exportComments(kind) {
    const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
    const base = safeName(name).replace(/\.pdf$/i, '');
    if (kind === 'summary') {
      download(
        new Blob([exportCommentSummary(doc)], { type: 'text/plain' }),
        `${base} comments.txt`,
      );
      return;
    }
    download(
      new Blob([exportXfdf(doc)], { type: 'application/vnd.adobe.xfdf' }),
      `${base} comments.xfdf`,
    );
  }
  function importComments() {
    requireAccess('annotate');
    const input = el('input', { type: 'file', accept: '.xfdf,application/vnd.adobe.xfdf,.xml' });
    input.onchange = safe(async () => {
      const file = input.files?.[0];
      if (!file) return;
      const xfdf = await file.text();
      let result = null;
      await mutate(
        async (doc) => {
          result = await importXfdf(doc, xfdf);
          return result.imported ? undefined : false;
        },
        null,
        'annotate',
      );
      if (result)
        toast(
          result.imported
            ? `${result.imported} ${result.imported === 1 ? 'comment' : 'comments'} imported.`
            : 'There were no new comments to import.',
        );
    });
    input.click();
  }
  /* ---------- Prepare a form ---------- */
  const FIELD_DEFAULTS = {
    dropdown: { options: ['Option 1', 'Option 2', 'Option 3'] },
    listbox: { options: ['Option 1', 'Option 2', 'Option 3'] },
    button: { label: 'Button' },
    radio: { exportValue: 'Choice 1' },
  };
  async function refreshDesigner() {
    if (!preparing || !pdf || !viewport) return;
    const doc = editDocument || (await PDFDocument.load(session.bytes, { updateMetadata: false }));
    if (!preparing || destroyed) return;
    editDocument = doc;
    const { listFormFields } = await loadForms();
    try {
      formFields = listFormFields(doc);
    } catch {
      formFields = [];
    }
    designer.render(
      formFields.filter((field) => field.page === pageIndex && field.rect),
      viewport,
    );
    designer.setEnabled(true);
    toolsPanel.refresh();
  }
  function setPreparing(on) {
    preparing = on;
    designer.setEnabled(on);
    pageForms.setEnabled(tool === 'select' && !preparing);
    if (on) refreshDesigner().catch(() => {});
  }
  async function createField(rect, page) {
    let created = null;
    await mutate(
      async (doc) => {
        created = await (
          await loadForms()
        ).addFormField(doc, page, {
          type: fieldType,
          rect,
          ...(FIELD_DEFAULTS[fieldType] || {}),
        });
      },
      null,
      'edit',
    );
    if (!created || destroyed) return;
    await refreshDesigner();
    const field = formFields.find((entry) => entry.name === created);
    designer.focusField(created);
    if (field) pageDialog(() => fieldPropertiesDialog(field, { created: true }))();
  }
  async function removeFormField(field) {
    await mutate(
      async (doc) => (await loadForms()).deleteFormField(doc, field.name, field.widgetIndex),
      `${fieldTypeLabel(field.type)} ${field.name} deleted.`,
      'edit',
    );
  }
  /** Name, tooltip, flags, and the settings of the field's type. */
  async function fieldPropertiesDialog(field, { created = false } = {}) {
    const { BUTTON_STYLES, updateFormField } = await loadForms();
    const props = field.props || {};
    const checkbox = (id, label, checked) => {
      const box = el('input', { type: 'checkbox', id, checked: !!checked });
      return {
        box,
        row: el('label', { class: 'checkbox-row', for: id }, el('span', {}, label), box),
      };
    };
    const nameInput = el('input', { class: 'input', value: field.name, maxlength: 120 });
    const tooltip = el('input', { class: 'input', value: props.tooltip || '', maxlength: 300 });
    const required = checkbox('field-required', 'Required', props.required);
    const readOnly = checkbox('field-readonly', 'Read only', props.readOnly);
    const border = el('input', { type: 'color', value: props.borderColor || '#000000' });
    const noBorder = checkbox('field-no-border', 'No border', !props.borderColor);
    const fill = el('input', { type: 'color', value: props.backgroundColor || '#ffffff' });
    const noFill = checkbox('field-no-fill', 'No fill', !props.backgroundColor);
    const fontSize = el('input', {
      class: 'input',
      type: 'number',
      min: 0,
      max: 72,
      step: 'any',
      value: props.fontSize ?? 0,
    });
    const specific = [];
    const read = {};
    if (field.type === 'text' || field.type === 'date') {
      const multiline = checkbox('field-multiline', 'Multi-line', props.multiline);
      const password = checkbox('field-password', 'Password (characters hidden)', props.password);
      const maxLength = el('input', {
        class: 'input',
        type: 'number',
        min: 0,
        step: 1,
        value: props.maxLength ?? '',
        placeholder: 'No limit',
      });
      const alignment = selectInput(
        'field-alignment',
        [
          ['left', 'Left'],
          ['center', 'Center'],
          ['right', 'Right'],
        ],
        props.alignment || 'left',
      );
      const defaultValue = el('input', { class: 'input', value: props.defaultValue || '' });
      specific.push(
        labeled('field-default', 'Default value', defaultValue),
        labeled('field-alignment', 'Alignment', alignment),
        labeled('field-maxlength', 'Character limit', maxLength),
        ...(field.type === 'text' ? [multiline.row, password.row] : []),
      );
      Object.assign(read, {
        defaultValue: () => defaultValue.value,
        alignment: () => alignment.value,
        maxLength: () => (maxLength.value ? Number(maxLength.value) : null),
        ...(field.type === 'text' && {
          multiline: () => multiline.box.checked,
          password: () => password.box.checked,
        }),
      });
    } else if (field.type === 'checkbox' || field.type === 'radio') {
      const exportValue = el('input', { class: 'input', value: props.exportValue || '' });
      const style = selectInput(
        'field-style',
        Object.keys(BUTTON_STYLES).map((key) => [key, key[0].toUpperCase() + key.slice(1)]),
        props.style || 'check',
      );
      const checked = checkbox('field-checked', 'Checked by default', props.checkedByDefault);
      specific.push(
        labeled('field-export', 'Export value', exportValue),
        labeled('field-style', 'Check style', style),
        checked.row,
      );
      Object.assign(read, {
        exportValue: () => exportValue.value,
        style: () => style.value,
        checked: () => checked.box.checked,
        widgetIndex: () => field.widgetIndex,
      });
    } else if (field.type === 'dropdown' || field.type === 'listbox') {
      const options = el('textarea', {
        class: 'input',
        rows: 5,
        'aria-describedby': 'field-options-hint',
      });
      options.value = (props.options || []).map((option) => option.label ?? option).join('\n');
      const editable = checkbox('field-editable', 'Allow typing a custom value', props.editable);
      const multi = checkbox('field-multi', 'Allow choosing several', props.multiSelect);
      specific.push(
        labeled('field-options', 'Options, one per line', options),
        field.type === 'dropdown' ? editable.row : multi.row,
      );
      Object.assign(read, {
        // A listed label keeps its own export value; a new line exports its label.
        options: () =>
          options.value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map(
              (line) =>
                (props.options || []).find((option) => (option.label ?? option) === line) ?? line,
            ),
        ...(field.type === 'dropdown'
          ? { editable: () => editable.box.checked }
          : { multiSelect: () => multi.box.checked }),
      });
    } else if (field.type === 'button') {
      const label = el('input', { class: 'input', value: props.label || 'Button' });
      specific.push(labeled('field-label', 'Label', label));
      read.label = () => label.value;
    }
    const collect = () => ({
      name: nameInput.value.trim() || field.name,
      tooltip: tooltip.value,
      required: required.box.checked,
      readOnly: readOnly.box.checked,
      borderColor: noBorder.box.checked ? null : border.value,
      backgroundColor: noFill.box.checked ? null : fill.value,
      fontSize: Number(fontSize.value) || 0,
      ...Object.fromEntries(Object.entries(read).map(([key, value]) => [key, value()])),
    });
    // Only what was changed is written: an unchanged default value or "Checked by default"
    // would otherwise reset what was filled in, and a widget is a target, not a change.
    const initial = collect();
    const save = safe(async () => {
      const next = Object.fromEntries(
        Object.entries(collect()).filter(
          ([key, value]) =>
            key === 'widgetIndex' || JSON.stringify(value) !== JSON.stringify(initial[key]),
        ),
      );
      await mutateDialog(
        d,
        async (doc) => {
          const renamed = await updateFormField(doc, field.name, next);
          if (renamed !== field.name) designer.renamed(field.name, renamed);
          return renamed;
        },
        null,
        'edit',
      );
    });
    const remove = safe(async () => {
      d.close();
      await removeFormField(field);
    });
    const form = el(
      'form',
      { class: 'stack' },
      labeled('field-name', 'Name', nameInput),
      labeled('field-tooltip', 'Tooltip (read to screen reader users)', tooltip),
      el('div', { class: 'field-grid' }, required.row, readOnly.row),
      ...specific,
      el(
        'div',
        { class: 'field-grid' },
        labeled('field-border', 'Border color', border, noBorder.row),
        labeled('field-fill', 'Fill color', fill, noFill.row),
      ),
      labeled('field-size', 'Font size (0 fits the box)', fontSize),
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      save();
    };
    const d = modal(`${fieldTypeLabel(field.type)} properties`, form, [
      button('Delete field', 'Trash2', remove, 'btn danger'),
      button(created ? 'Done' : 'Cancel', null, () => d.close()),
      button('Save', null, save, 'btn primary'),
    ]);
    nameInput.select();
  }
  /** Find fields on a flat form and create the chosen ones, as automatic detection does. */
  async function detectFieldsDialog() {
    requireAccess('edit');
    const { addFormField, detectFormFields } = await loadForms();
    const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
    const found = [];
    for (let page = 0; page < doc.getPageCount(); page++) {
      const textContent = await (await pdf.getPage(page + 1)).getTextContent();
      for (const candidate of detectFormFields(doc, page, { textContent }))
        found.push({ page, ...candidate });
    }
    if (destroyed) return;
    if (!found.length) {
      toast('No new form fields were found. Add fields with the field tools instead.');
      return;
    }
    const list = el(
      'ul',
      { class: 'redact-results', 'aria-label': 'Fields found' },
      ...found.map((field, i) =>
        el(
          'li',
          {},
          el(
            'label',
            { class: 'result-row' },
            el('input', { type: 'checkbox', checked: field.confidence >= 0.5, 'data-index': i }),
            el(
              'span',
              {},
              `Page ${field.page + 1}: ${fieldTypeLabel(field.type)} “${field.name || field.label || 'Untitled'}”`,
            ),
          ),
        ),
      ),
    );
    const create = safe(async () => {
      const chosen = [...list.querySelectorAll('input:checked')].map(
        (box) => found[Number(box.dataset.index)],
      );
      if (!chosen.length) throw new Error('Choose at least one field to create.');
      await mutateDialog(
        d,
        async (doc) => {
          for (const field of chosen)
            await addFormField(doc, field.page, {
              type: field.type,
              rect: field.rect,
              name: field.name || undefined,
              multiline: field.multiline || undefined,
            });
        },
        `${chosen.length} ${chosen.length === 1 ? 'field' : 'fields'} created.`,
        'edit',
      );
    });
    const d = modal(
      'Fields found',
      el(
        'div',
        { class: 'stack' },
        el(
          'p',
          { class: 'muted' },
          `${found.length} possible ${found.length === 1 ? 'field was' : 'fields were'} found in blanks, lines, and boxes. Choose the ones to create.`,
        ),
        list,
      ),
      [
        button('Cancel', null, () => d.close()),
        button('Create fields', null, create, 'btn primary'),
      ],
    );
  }
  /** Take out headers, footers, page numbers, or watermarks on every page. */
  async function removeMarks(kinds) {
    const { removePageMarks } = await import('./core/page-mark-removal.js');
    let removed = 0;
    await mutate((doc) => {
      removed = removePageMarks(doc, doc.getPageIndices(), kinds);
      return removed ? undefined : false;
    }, null);
    const watermarks = kinds.includes('Watermark');
    toast(
      removed
        ? `Removed ${removed} ${watermarks ? 'watermark' : 'header or footer'}${removed === 1 ? '' : watermarks ? 's' : ' entries'}.`
        : `This PDF has no ${watermarks ? 'watermarks' : 'headers or footers'} to remove.`,
    );
  }
  /* ---------- Accessibility ---------- */
  let accessibilityChecked = false;
  async function runAccessibilityCheck({ open = true } = {}) {
    if (!pdf || destroyed) return;
    const { checkAccessibility } = await import('./core/accessibility.js');
    accessibilityReport.setBusy(true);
    try {
      const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
      if (destroyed) return;
      accessibilityReport.show(checkAccessibility(doc, { access: access() }));
      accessibilityChecked = true;
      sidebarTabs.querySelector('[data-tab="accessibility"]').hidden = false;
      if (open) {
        showSidebarTab('accessibility');
        if (editorRoot.classList.contains('hide-pages')) await toggleSidebar(true);
      }
    } finally {
      accessibilityReport.setBusy(false);
    }
  }
  /** Apply one of the report's fixes, asking for what it needs, then check again. */
  async function fixAccessibility(fix) {
    const a11y = await import('./core/accessibility.js');
    const { autotagDocument, tagAnnotations } = await import('./core/autotag.js');
    const run = (operation, message) => mutate(operation, message, 'edit');
    switch (fix) {
      case 'title': {
        const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
        const title = await promptText('Document title', 'Title', doc.getTitle() || '');
        if (title == null) return;
        await run((d) => a11y.setTitle(d, title), 'Title set; readers will show it.');
        break;
      }
      case 'language': {
        const lang = await promptText(
          'Document language',
          'Language (for example en-US or fr-CA)',
          navigator.language || 'en-US',
        );
        if (lang == null) return;
        await run((d) => a11y.setLanguage(d, lang.trim()), 'Language set.');
        break;
      }
      case 'alt-text':
        await altTextDialog();
        break;
      case 'field-descriptions':
        await fieldDescriptionsDialog();
        break;
      case 'protection':
        await securityDialog();
        break;
      case 'tags':
        await run(
          (d) => autotagDocument(d, { lang: navigator.language || undefined }),
          'Tags added. Review the reading order and alternate text.',
        );
        break;
      case 'tag-annotations':
        await run((d) => tagAnnotations(d), 'Annotations tagged.');
        break;
      case 'tab-order':
        await run((d) => a11y.setTabOrder(d), 'Tab order follows the document structure.');
        break;
      case 'mark-info':
        await run((d) => a11y.setMarked(d), 'Marked as a tagged PDF.');
        break;
      case 'link-descriptions':
        await run((d) => a11y.describeLinks(d), 'Links described.');
        break;
      case 'bookmarks':
        await run((d) => a11y.addBookmarksFromHeadings(d), 'Bookmarks added from the headings.');
        break;
      default:
        return;
    }
    if (!destroyed && accessibilityChecked) await runAccessibilityCheck();
  }
  /** Alternate text for every figure the tags list. */
  async function altTextDialog() {
    const { listFigures, setFigureAltText } = await import('./core/accessibility.js');
    const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
    const figures = listFigures(doc);
    if (!figures.length) {
      toast('The tags list no figures. Autotag the document first if it has none.');
      return;
    }
    const inputs = figures.map((figure, i) => {
      const input = el('textarea', {
        class: 'input',
        rows: 2,
        maxlength: 1000,
        placeholder: 'Describe the picture for someone who cannot see it',
      });
      input.value = figure.alt || '';
      return input;
    });
    const save = safe(async () => {
      const changes = figures
        .map((figure, i) => [figure.ref, inputs[i].value.trim(), figure.alt || ''])
        .filter(([, value, before]) => value !== before);
      if (!changes.length) return d.close();
      await mutateDialog(
        d,
        (doc) => changes.forEach(([ref, value]) => setFigureAltText(doc, ref, value)),
        `Alternate text set for ${changes.length} ${changes.length === 1 ? 'figure' : 'figures'}.`,
      );
    });
    const d = modal(
      'Alternate text',
      el(
        'div',
        { class: 'stack alt-text-list' },
        ...figures.map((figure, i) =>
          labeled(`alt-${i}`, `Figure ${i + 1} on page ${figure.page + 1}`, inputs[i]),
        ),
      ),
      [button('Cancel', null, () => d.close()), button('Save', null, save, 'btn primary')],
    );
  }
  /** Tooltips that name each form field for screen reader users. */
  async function fieldDescriptionsDialog() {
    const { listFormFields } = await loadForms();
    const { setFieldDescriptions } = await import('./core/accessibility.js');
    const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
    const fields = [...new Map(listFormFields(doc).map((field) => [field.name, field])).values()];
    if (!fields.length) return toast('This PDF has no form fields.');
    const inputs = fields.map((field) =>
      el('input', { class: 'input', value: field.props?.tooltip || '', maxlength: 300 }),
    );
    const save = safe(async () => {
      const descriptions = Object.fromEntries(
        fields
          .map((field, i) => [field.name, inputs[i].value.trim(), field.props?.tooltip || ''])
          .filter(([, value, before]) => value !== before)
          .map(([fieldName, value]) => [fieldName, value]),
      );
      if (!Object.keys(descriptions).length) return d.close();
      await mutateDialog(d, (doc) => setFieldDescriptions(doc, descriptions), 'Fields described.');
    });
    const d = modal(
      'Field descriptions',
      el(
        'div',
        { class: 'stack' },
        ...fields.map((field, i) => labeled(`field-tip-${i}`, field.name, inputs[i])),
      ),
      [button('Cancel', null, () => d.close()), button('Save', null, save, 'btn primary')],
    );
  }
  /* ---------- PDF standards ---------- */
  function showStandardsBar() {
    standardsBar.hidden = !pdfaClaim;
    if (pdfaClaim)
      standardsText.textContent = `This file claims compliance with PDF/A-${pdfaClaim.part}${pdfaClaim.conformance}. Edits keep that claim only if the result still complies.`;
  }
  /** Check against a PDF/A level, or convert to it, and show what is left to fix. */
  async function pdfaDialog(mode = 'check') {
    const { PDFA_LEVELS } = await import('./core/pdfa.js');
    const levelSelect = selectInput(
      'pdfa-level',
      PDFA_LEVELS.map((entry) => [`${entry.part}${entry.conformance}`, entry.label]),
      pdfaClaim ? `${pdfaClaim.part}${pdfaClaim.conformance}` : '2b',
    );
    const run = safe(async () => {
      const [part, conformance] = [Number(levelSelect.value[0]), levelSelect.value[1]];
      d.close();
      if (mode === 'check') await preflight(part, conformance);
      else await convertPdfA(part, conformance);
    });
    const d = modal(
      mode === 'check' ? 'Check PDF/A compliance' : 'Save as PDF/A',
      el(
        'div',
        { class: 'stack' },
        el(
          'p',
          { class: 'muted' },
          mode === 'check'
            ? 'Preflight the PDF against a PDF/A level and list what does not comply.'
            : 'Fix what can be fixed automatically (color profile, metadata, fonts of the standard 14, scripts, annotation appearances) and report what remains. Password protection is not allowed in PDF/A.',
        ),
        labeled('pdfa-level', 'Level', levelSelect),
      ),
      [
        button('Cancel', null, () => d.close()),
        button(mode === 'check' ? 'Check' : 'Convert', null, run, 'btn primary'),
      ],
    );
  }
  function showPdfaReport(title, report, fixed = []) {
    const issues = report.issues || report.remaining || [];
    const list = el(
      'ul',
      { class: 'pdfa-issues' },
      ...issues.map((issue) =>
        el(
          'li',
          { class: `pdfa-${issue.severity}` },
          el('span', { class: 'pdfa-rule muted' }, issue.rule || ''),
          el(
            'span',
            {},
            `${issue.message}${issue.count > 1 ? ` (${issue.count})` : ''}${Number.isInteger(issue.page) ? ` — page ${issue.page + 1}` : ''}`,
          ),
        ),
      ),
    );
    const d = modal(
      title,
      el(
        'div',
        { class: 'stack' },
        el(
          'p',
          {},
          report.compliant
            ? 'No problems were found for this level.'
            : `${issues.length} ${issues.length === 1 ? 'problem remains' : 'problems remain'}.`,
        ),
        fixed.length > 0 &&
          el(
            'details',
            { open: true },
            el('summary', {}, `Fixed (${fixed.length})`),
            el(
              'ul',
              {},
              ...fixed.map((item) =>
                el('li', {}, `${item.message}${item.count > 1 ? ` (${item.count})` : ''}`),
              ),
            ),
          ),
        issues.length ? list : null,
        el(
          'p',
          { class: 'muted' },
          'This check covers the PDF/A rules that matter most in practice; a dedicated validator checks every clause.',
        ),
      ),
      [button('Close', null, () => d.close(), 'btn primary')],
    );
  }
  async function preflight(part, conformance) {
    const { preflightPdfA } = await import('./core/pdfa.js');
    const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
    const report = preflightPdfA(doc, { part, conformance, bytes: session.bytes });
    showPdfaReport(`PDF/A-${part}${conformance} check`, report);
  }
  async function convertPdfA(part, conformance) {
    requireAccess('edit');
    if (protection) throw new Error('Remove the password first: PDF/A files cannot be encrypted.');
    const { convertToPdfA, pdfaIdentification } = await import('./core/pdfa.js');
    let result = null;
    const previous = pdfaClaim;
    pdfaClaim = { part, conformance };
    try {
      await mutate(async (doc) => {
        result = await convertToPdfA(doc, { part, conformance });
      }, null);
    } catch (error) {
      pdfaClaim = previous;
      throw error;
    }
    if (!result || destroyed) return;
    const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
    pdfaClaim = pdfaIdentification(doc);
    showStandardsBar();
    showPdfaReport(`Saved as PDF/A-${part}${conformance}`, result, result.fixed);
  }
  /* ---------- Compare files ---------- */
  let comparison = null; // { view, task }
  /** Compare this PDF with another version, side by side with every change listed. */
  function compareDialog() {
    if (!pdf) return;
    let chosen = null;
    const fileName = el('span', { class: 'muted' }, 'No file chosen');
    const newer = el('input', { type: 'checkbox', id: 'compare-newer' });
    const choose = () => {
      const input = el('input', { type: 'file', accept: '.pdf,application/pdf' });
      input.onchange = safe(async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > MAX_FILE_SIZE) throw new Error('Choose a PDF smaller than 100 MB.');
        let bytes = new Uint8Array(await file.arrayBuffer());
        const source = await validatePdf(bytes).catch((error) => {
          if (error.code !== 'encrypted') throw error;
          return null;
        });
        if (!source) {
          const unlocked = await promptUnlock(bytes, file.name, dialogOptions);
          if (!unlocked) return;
          bytes = unlocked.bytes;
        }
        chosen = { name: file.name, bytes };
        fileName.textContent = file.name;
        compareButton.disabled = false;
      });
      input.click();
    };
    const run = safe(async () => {
      if (!chosen) throw new Error('Choose the other version of the PDF.');
      d.close();
      await runCompare(chosen, { currentIsNew: newer.checked });
    });
    const compareButton = button('Compare', null, run, 'btn primary', { disabled: true });
    const d = modal(
      'Compare files',
      el(
        'div',
        { class: 'stack' },
        el(
          'p',
          { class: 'muted' },
          `Compare ${name} with another version. Text that was inserted, deleted, or replaced, formatting changes, pictures, and added, removed, or moved pages are shown side by side.`,
        ),
        el(
          'div',
          { class: 'field-inline' },
          button('Choose file…', 'FolderOpen', choose, 'btn'),
          fileName,
        ),
        el(
          'label',
          { class: 'checkbox-row', for: 'compare-newer' },
          el('span', {}, `${name} is the newer version`),
          newer,
        ),
      ),
      [button('Cancel', null, () => d.close()), compareButton],
    );
  }
  async function runCompare(other, { currentIsNew = false } = {}) {
    if (busy || destroyed || !pdf) return;
    const { compareDocuments } = await import('./core/compare.js');
    const { createCompareView } = await import('./compare-view.js');
    closeComparison();
    busy = true;
    updateStatus();
    const controller = new AbortController();
    const bar = el('progress', { max: 1, value: 0, 'aria-label': 'Comparison progress' });
    const progress = el('p', { class: 'muted', role: 'status' }, 'Reading both versions…');
    const d = modal('Comparing', el('div', { class: 'stack' }, progress, bar), [
      button('Cancel', null, () => controller.abort()),
    ]);
    let done = false;
    d.addEventListener('close', () => {
      if (!done) controller.abort();
    });
    const task = loadPdf(other.bytes.slice());
    try {
      const otherPdf = await task.promise;
      const [oldPdf, newPdf] = currentIsNew ? [otherPdf, pdf] : [pdf, otherPdf];
      const [oldName, newName] = currentIsNew ? [other.name, name] : [name, other.name];
      const result = await compareDocuments(oldPdf, newPdf, {
        signal: controller.signal,
        onProgress: ({ phase, done: finished, total }) => {
          bar.value = total ? (phase === 'read' ? 0.9 : 1) * (finished / total) : 0;
          progress.textContent =
            phase === 'read' ? `Reading pages (${finished} of ${total})…` : 'Comparing…';
        },
      });
      done = true;
      if (d.open) d.close();
      if (destroyed) return;
      const view = createCompareView({
        oldPdf,
        newPdf,
        oldName,
        newName,
        result,
        onClose: () => closeComparison(),
      });
      comparison = { view, task };
      editorRoot.querySelector('.document-view').append(view.root);
      editorRoot.classList.add('comparing');
      view.focus();
    } catch (error) {
      task.destroy().catch(() => {});
      if (!['AbortError', 'RenderingCancelledException'].includes(error?.name)) throw error;
    } finally {
      done = true;
      if (d.open) d.close();
      busy = false;
      updateStatus();
    }
  }
  function closeComparison() {
    if (!comparison) return;
    const { view, task } = comparison;
    comparison = null;
    view.destroy();
    view.root.remove();
    task.destroy().catch(() => {});
    editorRoot.classList.remove('comparing');
    workspace.focus({ preventScroll: true });
  }
  /* ---------- Batch processing ---------- */
  /**
   * Apply one list of steps to several PDFs, as an action wizard does, and download the
   * results together in a ZIP. This PDF can be one of them, as it is now.
   */
  async function batchDialog() {
    const { BATCH_STEPS: BATCH_STEP_LABELS } = await import('./core/batch.js');
    const files = [];
    const includeCurrent = el('input', { type: 'checkbox', id: 'batch-current', checked: true });
    const list = el('ul', { class: 'combine-list', 'aria-label': 'Files to process' });
    const renderFiles = () =>
      list.replaceChildren(
        ...files.map((file, i) =>
          el(
            'li',
            { class: 'combine-row' },
            el('span', { class: 'combine-name', title: file.name }, file.name),
            iconButton(`Remove ${file.name}`, 'Trash2', () => {
              files.splice(i, 1);
              renderFiles();
            }),
          ),
        ),
      );
    const addFiles = () => {
      const input = el('input', { type: 'file', multiple: true, accept: '.pdf,application/pdf' });
      input.onchange = safe(async () => {
        for (const file of input.files) {
          if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name} is larger than 100 MB.`);
          files.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        }
        renderFiles();
      });
      input.click();
    };
    // Each step's setting, labelled by the step's own row.
    const controls = {
      rotate: selectInput(
        'batch-rotate-degrees',
        [
          ['90', 'Clockwise'],
          ['270', 'Counterclockwise'],
          ['180', 'Upside down'],
        ],
        '90',
      ),
      watermark: el('input', {
        id: 'batch-watermark-text',
        class: 'input',
        value: 'CONFIDENTIAL',
        maxlength: 200,
        'aria-label': 'Watermark text',
      }),
      pageNumbers: selectInput(
        'batch-numbers-format',
        Object.entries(NUMBER_FORMATS).map(([key, value]) => [
          key,
          value.replace('{n}', '1').replace('{N}', '9'),
        ]),
        'of',
      ),
      bates: el('input', {
        id: 'batch-bates-prefix',
        class: 'input',
        placeholder: 'Prefix, e.g. ABC',
        maxlength: 40,
        'aria-label': 'Bates prefix',
      }),
      compress: selectInput(
        'batch-compress-level',
        Object.entries(COMPRESSION_LEVELS).map(([key, level]) => [key, level.label]),
        'balanced',
      ),
      protect: el('input', {
        id: 'batch-protect-password',
        class: 'input',
        type: 'password',
        autocomplete: 'new-password',
        placeholder: 'Password to open',
        'aria-label': 'Password for the processed files',
      }),
    };
    controls.rotate.setAttribute('aria-label', 'Rotation');
    controls.pageNumbers.setAttribute('aria-label', 'Page number format');
    controls.compress.setAttribute('aria-label', 'File size level');
    const steps = Object.entries(BATCH_STEP_LABELS).map(([type, label]) => ({
      type,
      box: el('input', { type: 'checkbox', id: `batch-step-${type}` }),
      label,
    }));
    const stepRows = steps.map((step) =>
      el(
        'div',
        { class: 'batch-step' },
        el(
          'label',
          { class: 'checkbox-row', for: step.box.id },
          el('span', {}, step.label),
          step.box,
        ),
        controls[step.type] && el('div', { class: 'batch-option' }, controls[step.type]),
      ),
    );
    const run = safe(async () => {
      const chosen = steps
        .filter((step) => step.box.checked)
        .map((step) => {
          const value = controls[step.type]?.value;
          switch (step.type) {
            case 'rotate':
              return { type: 'rotate', degrees: Number(value) };
            case 'watermark':
              return { type: 'watermark', text: value };
            case 'pageNumbers':
              return { type: 'pageNumbers', format: value, position: 'bottom-center' };
            case 'bates':
              return {
                type: 'bates',
                prefix: value,
                start: 1,
                digits: 6,
                position: 'bottom-right',
              };
            case 'compress':
              return { type: 'compress', level: value };
            case 'protect':
              if (!value) throw new Error('Enter the password for the protected files.');
              return { type: 'protect', open: value };
            default:
              return { type: step.type };
          }
        });
      const inputs = [
        ...(includeCurrent.checked ? [{ name, bytes: session.bytes.slice() }] : []),
        ...files,
      ];
      if (includeCurrent.checked) requireAccess('copy');
      d.close();
      await runBatchSteps(inputs, chosen);
    });
    const d = modal(
      'Batch process',
      el(
        'div',
        { class: 'stack batch-dialog' },
        el(
          'p',
          { class: 'muted' },
          'Apply the same steps to several PDFs. The results download together.',
        ),
        el(
          'label',
          { class: 'checkbox-row', for: 'batch-current' },
          el('span', {}, `Include ${name}`),
          includeCurrent,
        ),
        button('Add PDFs…', 'Plus', addFiles, 'btn'),
        list,
        el('h3', { class: 'batch-heading' }, 'Steps, in this order'),
        ...stepRows,
      ),
      [button('Cancel', null, () => d.close()), button('Run', null, run, 'btn primary')],
    );
  }
  async function runBatchSteps(inputs, steps) {
    if (busy || destroyed) return;
    const { runBatch } = await import('./core/batch.js');
    busy = true;
    updateStatus();
    const controller = new AbortController();
    const progress = el('p', { class: 'muted', role: 'status' }, 'Starting…');
    const bar = el('progress', { max: inputs.length, value: 0, 'aria-label': 'Batch progress' });
    const d = modal('Processing files', el('div', { class: 'stack' }, progress, bar), [
      button('Cancel', null, () => controller.abort()),
    ]);
    let done = false;
    d.addEventListener('close', () => {
      if (!done) controller.abort();
    });
    const opened = new Map();
    try {
      const results = await runBatch(inputs, steps, {
        signal: controller.signal,
        codec: createImageCodec(loadPdf),
        onProgress: ({ file, step, index, files }) => {
          bar.value = index;
          progress.textContent = `${file} (${index + 1} of ${files}): ${step}…`;
        },
        recognize: async (bytes, page, { pageNeedsOcr }) => {
          let task = opened.get(bytes);
          if (!task) {
            // Files are recognized one after another; let the last one go before reading the
            // next, so a long batch does not hold every PDF in memory until it ends.
            for (const old of opened.values()) old.destroy().catch(() => {});
            opened.clear();
            opened.set(bytes, (task = loadPdf(bytes.slice())));
          }
          const doc = await task.promise;
          const pdfPage = await doc.getPage(page + 1);
          const view = pdfPage.getViewport({ scale: 1 });
          const content = await pdfPage.getTextContent({ includeMarkedContent: true });
          if (!pageNeedsOcr(content, view.width * view.height)) return null;
          const { createOcrEngine } = await import('./ocr-engine.js');
          ocrEngine ??= createOcrEngine();
          const picture = await pageImage(doc, page, {
            dpi: 300,
            type: 'image/png',
            signal: controller.signal,
          });
          return ocrEngine.recognize(picture, { signal: controller.signal });
        },
      });
      done = true;
      if (d.open) d.close();
      if (destroyed) return;
      const good = results.filter((result) => result.bytes);
      const failed = results.filter((result) => result.error);
      if (good.length) {
        const used = new Set();
        const parts = good.map((result) => {
          let fileName = `${safeName(result.name).replace(/\.pdf$/i, '')} processed.pdf`;
          for (let n = 2; used.has(fileName); n++)
            fileName = fileName.replace(/( \(\d+\))?\.pdf$/, ` (${n}).pdf`);
          used.add(fileName);
          return { name: fileName, bytes: result.bytes };
        });
        if (parts.length === 1) download(parts[0].bytes, parts[0].name);
        else download(new Blob(zipParts(parts), { type: 'application/zip' }), 'Processed PDFs.zip');
      }
      toast(
        failed.length
          ? `${good.length} processed; ${failed.length} could not be: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`
          : `${good.length} ${good.length === 1 ? 'file' : 'files'} processed.`,
        { error: failed.length > 0 && !good.length },
      );
    } catch (error) {
      if (!['AbortError', 'RenderingCancelledException'].includes(error?.name)) throw error;
    } finally {
      done = true;
      if (d.open) d.close();
      for (const task of opened.values()) task.destroy().catch(() => {});
      busy = false;
      updateStatus();
    }
  }
  /* ---------- Read out loud ---------- */
  // The browser's own speech voices read the page text, page after page when asked.
  let reading = null; // { generation, toEnd }
  const canSpeak = () => !!globalThis.speechSynthesis && access().accessibility;
  async function pageWords(index) {
    const page = await pdf.getPage(index + 1);
    const content = await page.getTextContent();
    return content.items
      .map((item) => item.str + (item.hasEOL ? '\n' : ''))
      .join('')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }
  async function readAloud(toEnd = false) {
    if (!canSpeak()) throw new Error('Reading aloud is not available here.');
    stopReading();
    const generation = Symbol('reading');
    reading = { generation, toEnd };
    for (let index = pageIndex; index < pageCount; index++) {
      const text = await pageWords(index);
      if (reading?.generation !== generation || destroyed) return;
      if (index !== pageIndex) await navigate(index);
      if (text) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = document.documentElement.lang || 'en';
        await new Promise((resolve) => {
          utterance.onend = utterance.onerror = resolve;
          speechSynthesis.speak(utterance);
        });
      }
      if (!toEnd || reading?.generation !== generation) break;
    }
    if (reading?.generation === generation) reading = null;
  }
  function stopReading() {
    reading = null;
    globalThis.speechSynthesis?.cancel();
  }
  function readingItems() {
    const speaking = !!reading;
    return [
      {
        label: 'Read this page',
        icon: 'BookOpen',
        disabled: !pdf || !canSpeak(),
        onSelect: safe(() => readAloud(false)),
      },
      {
        label: 'Read to end of document',
        disabled: !pdf || !canSpeak(),
        onSelect: safe(() => readAloud(true)),
      },
      {
        label: globalThis.speechSynthesis?.paused ? 'Resume' : 'Pause',
        disabled: !speaking,
        onSelect: () =>
          speechSynthesis.paused ? speechSynthesis.resume() : speechSynthesis.pause(),
      },
      { label: 'Stop', disabled: !speaking, onSelect: () => stopReading() },
    ];
  }
  /* ---------- Scan & OCR ---------- */
  // One recognition engine per editor, started on first use and stopped with the editor.
  let ocrEngine = null;
  /** Recognize text on scanned pages and add it as an invisible, searchable text layer. */
  function ocrDialog() {
    requireAccess('edit');
    if (!pdf) return;
    const choices = pageChoices('ocr-pages', pdf.numPages, { all: true });
    const skip = el('input', { type: 'checkbox', id: 'ocr-skip', checked: true });
    const dpi = selectInput(
      'ocr-dpi',
      [
        ['200', '200 dpi (faster)'],
        ['300', '300 dpi (recommended)'],
        ['400', '400 dpi (small print)'],
      ],
      '300',
    );
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'Text found in scanned pages becomes selectable and searchable. The pages look the same; recognition runs on this device. Language: English.',
      ),
      el(
        'label',
        { class: 'checkbox-row', for: 'ocr-skip' },
        el('span', {}, 'Skip pages that already have text'),
        skip,
      ),
      el('div', { class: 'field-grid' }, labeled('ocr-dpi', 'Resolution', dpi)),
      el('p', { class: 'muted' }, 'Pages'),
      choices.list,
    );
    const apply = safe(async () => {
      const pages = [...new Set(choices.indices())].sort((a, b) => a - b);
      d.close();
      await recognizeText(pages, { skipText: skip.checked, dpi: Number(dpi.value) });
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Recognize text', form, [
      button('Cancel', null, () => d.close()),
      button('Recognize text', null, apply, 'btn primary'),
    ]);
  }
  async function recognizeText(pages, { skipText = true, dpi = 300 } = {}) {
    requireAccess('edit');
    if (busy || destroyed || !pdf) return;
    if (!(await confirmSignedEdit())) return;
    busy = true;
    updateStatus();
    const controller = new AbortController();
    const bar = el('progress', { max: 1, value: 0, 'aria-label': 'Recognition progress' });
    const progress = el('p', { class: 'muted', role: 'status' }, 'Starting text recognition…');
    const d = modal('Recognizing text', el('div', { class: 'stack' }, progress, bar), [
      button('Cancel', null, () => controller.abort()),
    ]);
    let done = false;
    d.addEventListener('close', () => {
      if (!done) controller.abort();
    });
    const thisPdf = pdf;
    const results = [];
    let skipped = 0;
    try {
      const { createOcrEngine } = await import('./ocr-engine.js');
      const { pageNeedsOcr, addOcrTextLayer } = await import('./core/ocr.js');
      ocrEngine ??= createOcrEngine();
      for (const [k, index] of pages.entries()) {
        controller.signal.throwIfAborted();
        const page = await thisPdf.getPage(index + 1);
        if (skipText) {
          const view = page.getViewport({ scale: 1 });
          const content = await page.getTextContent({ includeMarkedContent: true });
          if (!pageNeedsOcr(content, view.width * view.height)) {
            skipped++;
            continue;
          }
        }
        progress.textContent = `Recognizing page ${index + 1} (${k + 1} of ${pages.length})…`;
        const picture = await pageImage(thisPdf, index, {
          dpi,
          type: 'image/png',
          signal: controller.signal,
        });
        const result = await ocrEngine.recognize(picture, {
          signal: controller.signal,
          onProgress: (fraction) => {
            bar.value = (k + fraction) / pages.length;
          },
        });
        if (result.words.length) results.push({ index, result });
        bar.value = (k + 1) / pages.length;
      }
      controller.signal.throwIfAborted();
      done = true;
      if (d.open) d.close();
      if (destroyed) return;
      if (!results.length) {
        toast(
          skipped === pages.length
            ? 'These pages already have text, so there was nothing to recognize.'
            : 'No text was found on these pages.',
        );
        return;
      }
      const words = results.reduce((sum, entry) => sum + entry.result.words.length, 0);
      busy = false;
      await mutate(
        async (doc) => {
          for (const { index, result } of results) await addOcrTextLayer(doc, index, result);
        },
        `Recognized ${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} on ${results.length} ${results.length === 1 ? 'page' : 'pages'}. The text can now be searched and selected.`,
      );
    } catch (error) {
      if (!['AbortError', 'RenderingCancelledException'].includes(error?.name)) throw error;
    } finally {
      done = true;
      if (d.open) d.close();
      busy = false;
      updateStatus();
    }
  }
  /** Remove text layers this app added by recognition. */
  async function removeRecognizedText() {
    requireAccess('edit');
    const { removeOcrTextLayer } = await import('./core/ocr.js');
    let removed = 0;
    await mutate((doc) => {
      for (let i = 0; i < doc.getPageCount(); i++) if (removeOcrTextLayer(doc, i)) removed++;
      return removed ? undefined : false;
    }, null);
    toast(
      removed
        ? `Recognized text removed from ${removed} ${removed === 1 ? 'page' : 'pages'}.`
        : 'This PDF has no text recognized here.',
    );
  }
  /** Export to an Office or text format: choose the pages (and slide pictures for PPTX). */
  function officeExportDialog(format) {
    requireAccess('copy');
    if (!pdf) return;
    const labels = {
      docx: 'Microsoft Word document',
      xlsx: 'Spreadsheet',
      pptx: 'Presentation',
      txt: 'Plain text',
      html: 'Web page',
      rtf: 'Rich text',
    };
    const choices = pageChoices('office-pages', pdf.numPages, { all: true });
    const backgrounds = el('input', { type: 'checkbox', id: 'office-backgrounds' });
    const singleSheet = el('input', { type: 'checkbox', id: 'office-single-sheet' });
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        {
          docx: 'Text becomes editable paragraphs, headings, lists, and tables, with the pictures in place.',
          xlsx: 'Tables and aligned text become worksheet cells, one sheet per page; numbers, money, and dates stay numbers.',
          pptx: 'Each page becomes a slide with its text in editable boxes and its pictures in place.',
          txt: 'The text of each page in reading order.',
          html: 'Headings, paragraphs, lists, tables, and pictures as a web page.',
          rtf: 'Formatted text that most word processors open.',
        }[format],
      ),
      format === 'pptx' &&
        el(
          'label',
          { class: 'checkbox-row', for: 'office-backgrounds' },
          el('span', {}, 'Put a picture of each page behind its slide (keeps drawings and charts)'),
          backgrounds,
        ),
      format === 'xlsx' &&
        el(
          'label',
          { class: 'checkbox-row', for: 'office-single-sheet' },
          el('span', {}, 'Put every page on one worksheet'),
          singleSheet,
        ),
      el('p', { class: 'muted' }, 'Pages'),
      choices.list,
    );
    const apply = safe(async () => {
      const pages = [...new Set(choices.indices())].sort((a, b) => a - b);
      d.close();
      await runOfficeExport(format, pages, {
        slideBackgrounds: backgrounds.checked,
        singleSheet: singleSheet.checked,
        label: labels[format],
      });
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal(`Export to ${labels[format]}`, form, [
      button('Cancel', null, () => d.close()),
      button('Export', 'Download', apply, 'btn primary'),
    ]);
  }
  async function runOfficeExport(format, pages, { slideBackgrounds, singleSheet, label }) {
    requireAccess('copy');
    if (busy || destroyed || !pdf) return;
    busy = true;
    updateStatus();
    const controller = new AbortController();
    const bar = el('progress', { max: 1, value: 0, 'aria-label': 'Export progress' });
    const progress = el('p', { class: 'muted', role: 'status' }, 'Reading the pages…');
    const d = modal(`Exporting to ${label}`, el('div', { class: 'stack' }, progress, bar), [
      button('Cancel', null, () => controller.abort()),
    ]);
    let done = false;
    d.addEventListener('close', () => {
      if (!done) controller.abort();
    });
    const thisPdf = pdf;
    try {
      const { exportDocument } = await import('./core/export-office.js');
      const { documentDetails } = await import('./core/details.js');
      const details = documentDetails(
        await PDFDocument.load(session.bytes, { updateMetadata: false }),
        session.bytes,
      );
      const result = await exportDocument(thisPdf, session.bytes, format, {
        pages,
        signal: controller.signal,
        slideBackgrounds,
        singleSheet,
        title: details.title || name.replace(/\.pdf$/i, ''),
        author: details.author || '',
        onProgress: (finished, total) => {
          bar.value = total ? finished / total : 0;
          progress.textContent =
            finished < total ? `Page ${finished + 1} of ${total}…` : 'Writing the file…';
        },
        renderPage: async (index, scale = 2) =>
          new Uint8Array(
            await (
              await pageImage(thisPdf, index, {
                dpi: 72 * scale,
                type: 'image/png',
                signal: controller.signal,
              })
            ).arrayBuffer(),
          ),
      });
      controller.signal.throwIfAborted();
      if (destroyed) return;
      done = true;
      const base = safeName(name).replace(/\.pdf$/i, '');
      download(
        result.blob || new Blob([result.bytes], { type: result.mime }),
        `${base}.${result.extension}`,
        result.mime,
      );
      toast(`Exported to ${label}.`);
    } catch (error) {
      if (!['AbortError', 'RenderingCancelledException'].includes(error?.name)) throw error;
    } finally {
      done = true;
      if (d.open) d.close();
      busy = false;
      updateStatus();
    }
  }
  /** Download the PDF as several files in one ZIP. */
  function splitDialog() {
    requireAccess('copy');
    if (!pdf || pdf.numPages < 2) return;
    const count = pdf.numPages;
    const every = el('input', {
      type: 'number',
      class: 'input',
      min: 1,
      max: count - 1,
      step: 1,
      value: Math.max(Math.min(count - 1, 2), Math.ceil(count / MAX_SPLIT_FILES)),
      'aria-label': 'Pages per part',
      inputmode: 'numeric',
    });
    const points = el('input', {
      type: 'text',
      class: 'input',
      placeholder: 'e.g. 3, 7',
      'aria-label': 'Pages where new parts begin',
      inputmode: 'numeric',
      autocomplete: 'off',
    });
    const choice = (value, label, checked, control) =>
      el(
        'div',
        { class: control ? 'choice-with-input' : undefined },
        el(
          'label',
          { class: 'choice-row' },
          el('input', { type: 'radio', name: 'split-mode', value, checked }),
          el('span', {}, label),
        ),
        control,
      );
    const list = el(
      'div',
      { class: 'choice-list', role: 'radiogroup', 'aria-label': 'How to split' },
      choice('each', `Each page as its own PDF (${count} files)`, count <= MAX_SPLIT_FILES),
      choice('every', 'Every', count > MAX_SPLIT_FILES, every),
      choice('at', 'New part before pages', false, points),
    );
    for (const [input, value] of [
      [every, 'every'],
      [points, 'at'],
    ])
      input.addEventListener('input', () => {
        list.querySelector(`input[value="${value}"]`).checked = true;
        preview();
      });
    list.addEventListener('change', preview);
    const summary = el('p', { class: 'muted', role: 'status' });
    const plan = () => {
      const mode = list.querySelector('input:checked')?.value || 'each';
      const ranges = splitRanges(count, {
        mode,
        every: Number(every.value),
        at: mode === 'at' ? parseSplitPoints(points.value, count) : [],
      });
      if (ranges.length > MAX_SPLIT_FILES)
        throw new Error(
          `Split into at most ${MAX_SPLIT_FILES} files. Choose more pages per part or fewer split points.`,
        );
      return ranges;
    };
    function preview() {
      try {
        const ranges = plan();
        summary.textContent = `${ranges.length} PDFs, downloaded together as a ZIP.`;
        downloadButton.disabled = false;
      } catch (error) {
        summary.textContent = error.message;
        downloadButton.disabled = true;
      }
    }
    const form = el(
      'form',
      { class: 'stack', novalidate: true },
      el(
        'p',
        { class: 'muted' },
        'The parts are saved on this device in one ZIP file. Form fields in them become fixed page content.',
      ),
      list,
      summary,
    );
    const apply = safe(async () => {
      const ranges = plan();
      const base = name.replace(/\.pdf$/i, '');
      d.close();
      activity = 'Splitting…';
      updateStatus();
      try {
        requireAccess('copy');
        // The source bytes and protection belong to one export, even if the open document
        // changes while its parts are being copied or encrypted.
        const savedProtection = protection;
        const { signal } = dialogController;
        const files = await splitPdf(session.bytes.slice(), ranges, base, { signal });
        for (const file of files) {
          signal.throwIfAborted();
          file.bytes = await exportBytes(file.bytes, savedProtection);
        }
        signal.throwIfAborted();
        download(new Blob(zipParts(files), { type: 'application/zip' }), `${base} split.zip`);
      } finally {
        activity = null;
        updateStatus();
      }
      toast(`${ranges.length} PDFs downloaded as a ZIP.`);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const downloadButton = button('Download ZIP', 'Download', apply, 'btn primary');
    preview();
    const d = modal('Split PDF', form, [button('Cancel', null, () => d.close()), downloadButton]);
  }
  /** Turn form fields and comments into fixed page content. */
  async function flattenDialog(version = beginDialogRequest()) {
    requireAccess('edit', 'annotate');
    if (!pdf) return;
    const doc = await workingDocument(version);
    if (!doc) return;
    const counts = flattenCounts(doc);
    if (!counts.fields && !counts.annotations) {
      toast('This PDF has no form fields or comments to flatten.');
      return;
    }
    const option = (id, label, count) => {
      const box = el('input', { type: 'checkbox', id, checked: count > 0, disabled: !count });
      return {
        box,
        row: el(
          'label',
          { class: 'checkbox-row', for: id },
          el('span', {}, `${label} (${count})`),
          box,
        ),
      };
    };
    const fields = option('flatten-fields', 'Form fields', counts.fields);
    const annotations = option('flatten-annotations', 'Comments and markups', counts.annotations);
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'Flattened fields and comments become part of the page: every reader shows them the same way, and nobody can fill, move, or delete them afterwards. Anything that cannot be flattened safely stays in the PDF. Links stay clickable. Undo brings the original back.',
      ),
      fields.row,
      annotations.row,
    );
    const apply = safe(async () => {
      const choice = { fields: fields.box.checked, annotations: annotations.box.checked };
      if (!choice.fields && !choice.annotations) {
        toast('Choose what to flatten.', { error: true });
        return;
      }
      d.close();
      let done = false;
      await mutate((doc) => {
        done = flattenDocument(doc, choice);
        return !!(done && (done.fields || done.annotations));
      });
      if (done) {
        const describe = (counts) =>
          [
            counts.fields && `${counts.fields} ${counts.fields === 1 ? 'field' : 'fields'}`,
            counts.annotations &&
              `${counts.annotations} ${counts.annotations === 1 ? 'comment' : 'comments'}`,
          ]
            .filter(Boolean)
            .join(' and ');
        const flattened = describe(done);
        const kept = done.unflattened && describe(done.unflattened);
        toast(
          [
            flattened && `Flattened ${flattened}.`,
            kept &&
              `Kept ${kept} unflattened to preserve ${done.unflattened.fields + done.unflattened.annotations === 1 ? 'its' : 'their'} content.`,
          ]
            .filter(Boolean)
            .join(' '),
        );
      }
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Flatten', form, [
      button('Cancel', null, () => d.close()),
      button('Flatten', 'Layers', apply, 'btn primary'),
    ]);
  }
  /** Shrink pictures to their printed resolution and clear leftovers from earlier edits. */
  function reduceSizeDialog() {
    requireAccess('edit');
    if (!pdf) return;
    const rows = Object.entries(COMPRESSION_LEVELS).map(([key, level]) =>
      el(
        'label',
        { class: 'choice-row' },
        el('input', {
          type: 'radio',
          name: 'reduce-level',
          value: key,
          checked: key === 'balanced',
        }),
        el('span', {}, level.label, ' ', el('span', { class: 'muted' }, `· ${level.hint}`)),
      ),
    );
    const list = el(
      'div',
      { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Picture quality' },
      ...rows,
    );
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        `This PDF is ${formatBytes(session.bytes.length)}. Pictures are shrunk to the chosen resolution and saved as JPEG; text, drawings, and form fields stay sharp, and leftovers from earlier edits are removed. Undo brings the original back.`,
      ),
      list,
    );
    const apply = safe(async () => {
      const level = list.querySelector('input:checked')?.value || 'balanced';
      d.close();
      await reduceSize(level);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const d = modal('Reduce file size', form, [
      button('Cancel', null, () => d.close()),
      button('Reduce size', 'Shrink', apply, 'btn primary'),
    ]);
    list.querySelector('input:checked')?.focus();
  }
  async function reduceSize(level) {
    requireAccess('edit');
    if (busy || destroyed) return;
    busy = true;
    activity = 'Reducing file size…';
    updateStatus();
    try {
      const before = session.bytes.length;
      const result = await compressPdf(session.bytes, {
        level,
        codec: createImageCodec(loadPdf),
        signal: dialogController.signal,
      });
      if (destroyed) return;
      if (result.after >= before * 0.99) {
        toast('This PDF is already as small as it gets here.');
        return;
      }
      session.adopt(result.bytes);
      await reload();
      toast(`File size reduced from ${formatBytes(before)} to ${formatBytes(result.after)}.`);
    } finally {
      busy = false;
      activity = null;
      if (!destroyed) updateStatus();
    }
  }
  /** Save chosen pages as a new PDF on this device. */
  function extractDialog() {
    requireAccess('copy');
    if (!pdf) return;
    const choices = pageChoices('extract-pages', pdf.numPages);
    const progress = el(
      'p',
      { class: 'muted', role: 'status', hidden: true },
      'Preparing your PDF…',
    );
    let extracting = false;
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'The chosen pages are saved as a new PDF on this device. Form fields in them become fixed page content.',
      ),
      choices.list,
      progress,
    );
    const extract = safe(async () => {
      if (extracting || destroyed || !d.open) return;
      const indices = choices.indices();
      requireAccess('copy');
      extracting = true;
      const controls = [downloadButton, ...form.querySelectorAll('input')];
      controls.forEach((control) => (control.disabled = true));
      progress.hidden = false;
      try {
        const extracted = await extractPages(session.bytes, indices);
        if (destroyed || !d.open) return;
        const bytes = await exportBytes(extracted);
        if (destroyed || !d.open) return;
        const label = formatPageRange(indices);
        // A long list of scattered pages would not fit a file name; their count does.
        const suffix = ` pages ${label}`;
        download(bytes, exportName(suffix.length <= 64 ? suffix : ` ${indices.length} pages`));
        d.close();
        toast(`${indices.length === 1 ? 'Page' : 'Pages'} ${label} downloaded as a new PDF.`);
      } catch (error) {
        if (!destroyed && d.open) throw error;
      } finally {
        extracting = false;
        controls.forEach((control) => (control.disabled = false));
        progress.hidden = true;
      }
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      extract();
    };
    const downloadButton = button('Download pages', 'Download', extract, 'btn primary');
    const d = modal(
      'Extract pages',
      form,
      [button('Cancel', null, () => d.close()), downloadButton],
      dialogOptions,
    );
  }
  function openSearch() {
    searchBar.hidden = false;
    searchInput.focus();
    searchInput.select();
  }
  function resetSearch() {
    clearTimeout(searchTimer);
    searchTimer = null;
    searchGeneration++;
    pendingSearch = null;
    matchedQuery = '';
    searchResults = [];
    activeMatch = -1;
    searchCount.textContent = '';
    clearSearchMarks();
  }
  function claimSearchNavigation() {
    // A new search choice retires older destinations before either lookup finishes.
    pendingNavigation = null;
    revealComment = null;
    navigationGeneration++;
    updateStatus();
    return navigationGeneration;
  }
  function scheduleSearch(delay = 0, takeNavigation = false) {
    resetSearch();
    const query = searchQuery(searchInput.value);
    if (!query || !pdf) return;
    const request = {
      token: searchGeneration,
      query,
      direction: 1,
      navigation: takeNavigation ? claimSearchNavigation() : navigationGeneration,
    };
    // A refresh after committing an edit must not inherit the pending page choice's
    // permission to navigate. An explicit search action can claim it again later.
    if (!takeNavigation && pendingNavigation) request.navigation = null;
    pendingSearch = request;
    searchCount.textContent = 'Searching…';
    if (delay) searchTimer = setTimeout(() => findText(request), delay);
    else findText(request);
  }
  async function findText(request) {
    clearTimeout(searchTimer);
    searchTimer = null;
    const { token, query } = request;
    const thisPdf = pdf;
    const isCurrent = () => !destroyed && token === searchGeneration && pdf === thisPdf;
    // Publish one complete result set. A slow page must not expose partial results to
    // navigation, or let an obsolete query append matches to its replacement's results.
    const results = [];
    try {
      for (let i = 0; i < thisPdf.numPages; i++) {
        let haystack = searchTextCache.get(i);
        if (haystack === undefined) {
          // Extraction is the slow part of a search; keep it for the next query.
          const page = await thisPdf.getPage(i + 1);
          if (!isCurrent()) return;
          const text = await page.getTextContent();
          if (!isCurrent()) return;
          haystack = indexPageText(text.items).text;
          searchTextCache.set(i, haystack);
        }
        const count = countMatches(haystack, query);
        if (count) results.push({ page: i, count });
      }
      if (!isCurrent()) return;
      pendingSearch = null;
      matchedQuery = query;
      searchResults = results;
      if (totalMatches()) {
        if (request.navigation === navigationGeneration) jumpMatch(request.direction);
        else {
          // Keep the results available, but a newer page choice owns navigation.
          const total = totalMatches();
          searchCount.textContent = `${total} ${total === 1 ? 'match' : 'matches'}`;
          markSearch();
        }
      } else {
        searchCount.textContent = 'No matches';
        markSearch();
      }
    } catch {
      if (isCurrent()) {
        pendingSearch = null;
        searchCount.textContent = 'Search unavailable';
      }
    }
  }
  /** Non-overlapping occurrences of `query` in folded page text, as markSearch finds them. */
  function countMatches(haystack, query) {
    let count = 0;
    for (
      let at = haystack.indexOf(query);
      at !== -1;
      at = haystack.indexOf(query, at + query.length)
    )
      count++;
    return count;
  }
  const totalMatches = () => searchResults.reduce((sum, result) => sum + result.count, 0);
  /** The page holding match `index` across the document, and its ordinal on that page. */
  function locateMatch(index) {
    let offset = 0;
    for (const { page, count } of searchResults) {
      if (index < offset + count) return { page, ordinal: index - offset };
      offset += count;
    }
    return null;
  }
  function jumpMatch(direction) {
    if (pendingSearch) {
      pendingSearch.direction = direction;
      pendingSearch.navigation = claimSearchNavigation();
      if (searchTimer !== null) findText(pendingSearch);
      return;
    }
    const total = totalMatches();
    if (!total) return;
    if (activeMatch < 0) {
      // Start at the current page's first/last match, wrapping when needed. This also
      // applies when a search finished after navigation and has no selected result yet.
      let start = direction > 0 ? 0 : total - 1,
        offset = 0;
      for (const result of searchResults) {
        if (direction > 0 && result.page >= pageIndex) {
          start = offset;
          break;
        }
        if (direction < 0 && result.page <= pageIndex) start = offset + result.count - 1;
        offset += result.count;
      }
      activeMatch = start;
    } else activeMatch = (activeMatch + direction + total) % total;
    searchCount.textContent = `${activeMatch + 1} of ${total}`;
    const { page } = locateMatch(activeMatch);
    // A same-page match is still a navigation choice when an older request is pending.
    if (page === pageIndex && !pendingNavigation) markSearch();
    else navigate(page);
  }
  function markSearch() {
    if (!pageReady || !pageTextIndex) return;
    const q = matchedQuery;
    const { text, ranges, origins } = pageTextIndex;
    const matches = [];
    if (q)
      for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length))
        matches.push([at, at + q.length]);
    const current = locateMatch(activeMatch);
    const currentOrdinal = current?.page === pageIndex ? current.ordinal : -1;
    let next = 0;
    textLayer.textDivs.forEach((node, index) => {
      const range = ranges[index],
        origin = origins[index];
      while (next < matches.length && matches[next][1] <= range.start) next++;
      const hits = [];
      for (let m = next; m < matches.length && matches[m][0] < range.end; m++) {
        const from = Math.max(matches[m][0], range.start) - range.start,
          to = Math.min(matches[m][1], range.end) - range.start;
        if (to > from) hits.push([origin[from], origin[to - 1] + 1, m === currentOrdinal]);
      }
      markSpan(node, hits);
    });
    revealCurrentMatch();
  }
  /** Scroll the workspace just enough to show the current match. */
  function revealCurrentMatch() {
    const mark = textContainer.querySelector('.search-hit-current');
    if (!mark) return;
    const box = mark.getBoundingClientRect();
    if (!box.width && !box.height) return;
    revealBox(box);
  }
  /** Scroll the workspace to center a box (client coordinates) that is not fully in view. */
  function revealBox(box) {
    const view = workspace.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom)
      workspace.scrollTop += box.top - view.top - (view.height - box.height) / 2;
    if (box.left < view.left || box.right > view.right)
      workspace.scrollLeft += box.left - view.left - (view.width - box.width) / 2;
  }
  /** Wrap only the matched characters of a text span, leaving unchanged spans untouched. */
  function markSpan(node, hits) {
    const key = hits.join(';');
    if ((node.dataset.searchHits || '') === key) return;
    const source = node.textContent;
    if (!hits.length) {
      node.textContent = source;
      delete node.dataset.searchHits;
      return;
    }
    const fragment = document.createDocumentFragment();
    let at = 0;
    for (let [from, to, active] of hits) {
      from = Math.max(from, at);
      if (to <= from) continue;
      if (from > at) fragment.append(source.slice(at, from));
      const mark = document.createElement('mark');
      mark.className = active ? 'search-hit search-hit-current' : 'search-hit';
      mark.textContent = source.slice(from, to);
      fragment.append(mark);
      at = to;
    }
    if (at < source.length) fragment.append(source.slice(at));
    node.replaceChildren(fragment);
    node.dataset.searchHits = key;
  }
  function clearSearchMarks() {
    for (const node of textContainer.querySelectorAll('[data-search-hits]')) {
      node.textContent = node.textContent;
      delete node.dataset.searchHits;
    }
  }
  function onKey(e) {
    // Native dialogs own the keyboard while open, including Escape.
    if (e.isComposing || document.querySelector('dialog[open]')) return;
    const formatKey = { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
    if (
      textEdit &&
      !busy &&
      formatKey &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      (e.target === textEdit.input ||
        textEdit.input.contains(e.target) ||
        textEdit.handles.contains(e.target) ||
        toolOptions.contains(e.target))
    ) {
      e.preventDefault();
      toggleTextStyle(formatKey);
      return;
    }
    if (e.key === 'Escape' && (textEdit || textPointer)) {
      e.preventDefault();
      cancelTextSelection();
      safe(() => finishTextEdit(false))();
      workspace.focus({ preventScroll: true });
      return;
    }
    if (e.key === 'Escape' && selectedHighlight) {
      closeHighlightEditor();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && (highlightSelection || highlightCaptureTimer)) {
      window.getSelection()?.removeAllRanges();
      clearHighlightSelection();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && gesture) {
      gesture = null;
      clearOverlay();
      e.preventDefault();
      return;
    }
    if (tool === 'measure' && measurePath.length && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault();
      if (e.key === 'Enter') safe(finishMeasure)();
      else {
        measurePath = [];
        clearOverlay();
        hint.textContent = measureHint();
      }
      return;
    }
    if (e.key === 'Escape' && tool === 'link') {
      e.preventDefault();
      safe(() => setTool('select'))();
      return;
    }
    if (e.key === 'Escape' && tool === 'crop') {
      e.preventDefault();
      if (cropDraft) {
        discardCropDraft();
        clearOverlay();
        overlay.focus({ preventScroll: true });
      } else safe(() => setTool('select'))();
      return;
    }
    const modifier = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const typing = e.target.isContentEditable || /input|textarea|select/i.test(e.target.tagName);
    // Only a field that takes typed text has a native undo of its own; a focused select,
    // checkbox, or color picker (a zoom or size choice, for instance) leaves Undo to the app.
    const textEntry =
      e.target.isContentEditable ||
      /textarea/i.test(e.target.tagName) ||
      (/input/i.test(e.target.tagName) &&
        !['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file'].includes(
          e.target.type,
        ));
    if (modifier && key === 's') {
      e.preventDefault();
      // On the Puter desktop, Save As chooses a folder in the cloud; elsewhere it downloads.
      if (e.shiftKey) safe(P.isApp() ? saveAs : downloadPdf)();
      else safe(() => save())();
    } else if (modifier && key === 'f') {
      e.preventDefault();
      openSearch();
    } else if ((modifier && !e.altKey && key === 'g') || e.key === 'F3') {
      // Find next and previous, as browsers and editors bind them.
      e.preventDefault();
      if (searchBar.hidden) openSearch();
      else jumpMatch(e.shiftKey ? -1 : 1);
    } else if (modifier && !e.shiftKey && !e.altKey && key === 'p') {
      e.preventDefault();
      if (!busy) pageDialog(printDialog)();
    } else if (modifier && !e.altKey && ['=', '+', '-', '_'].includes(e.key)) {
      // The application zooms the page where a browser would zoom the whole interface.
      e.preventDefault();
      safe(() => setZoom(zoomStep(e.key === '-' || e.key === '_' ? -1 : 1)))();
    } else if (modifier && !e.altKey && !e.shiftKey && ['0', '1', '2'].includes(e.key)) {
      // Fit page, actual size, and fit width, as desktop PDF editors bind them.
      e.preventDefault();
      safe(() => setZoom({ 0: 'page', 1: '1', 2: 'fit' }[e.key]))();
    } else if (modifier && e.shiftKey && !e.altKey && key === 'n') {
      e.preventDefault();
      if (pdf && pdf.numPages > 1 && !busy) safe(goToPage)();
    } else if (modifier && !e.shiftKey && !e.altKey && key === 'd') {
      e.preventDefault();
      if (!busy) pageDialog(detailsDialog)();
    } else if (modifier && e.shiftKey && !e.altKey && key === 'r' && !typing) {
      e.preventDefault();
      if (!busy && access().assemble)
        pageAction(() => mutate((doc) => rotatePage(doc, pageIndex), null, 'assemble'))();
    } else if (modifier && e.shiftKey && !e.altKey && key === 'd' && !typing) {
      e.preventDefault();
      if (!busy && access().assemble && pdf?.numPages > 1)
        pageDialog(() => deletePageAt(pageIndex))();
    } else if (modifier && !e.shiftKey && !e.altKey && key === 'l') {
      e.preventDefault();
      toggleFullScreen();
    } else if (e.key === 'F4' && !modifier && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) toggleToolsPanel();
      else safe(() => toggleSidebar())();
    } else if (!modifier && !e.altKey && !typing && (e.key === 'Home' || e.key === 'End')) {
      if (!pdf || e.target.closest?.('.page-sidebar, .tools-pane, .menu')) return;
      e.preventDefault();
      navigate(e.key === 'Home' ? 0 : pageCount - 1);
    } else if (
      !modifier &&
      !e.altKey &&
      !e.shiftKey &&
      !typing &&
      !textEdit &&
      ['v', 'h'].includes(key) &&
      !e.target.closest?.('.page-sidebar, .tools-pane, .menu, .form-layer')
    ) {
      // Single-key tool shortcuts: V for Select, H for Hand.
      e.preventDefault();
      safe(() => setTool(key === 'v' ? 'select' : 'hand'))();
    } else if (e.key === 'Escape' && editorRoot.classList.contains('read-mode')) {
      e.preventDefault();
      setReadMode(false);
    } else if (modifier && !e.altKey && !e.shiftKey && key === 'a' && !typing) {
      // Select All belongs to the page's words; a field with the focus keeps its own.
      if (selectPageText()) e.preventDefault();
    } else if (modifier && key === 'z' && !textEntry) {
      e.preventDefault();
      safe(() => history(e.shiftKey ? 'redo' : 'undo'))();
    } else if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && key === 'y' && !textEntry) {
      // Ctrl Y is the Windows and Linux redo convention alongside Ctrl Shift Z.
      e.preventDefault();
      safe(() => history('redo'))();
    } else if (e.altKey && !typing && e.key === 'ArrowRight') {
      // Alt/Option + Arrow moves the caret by word inside fields; only navigate outside them.
      e.preventDefault();
      navigateBy(1);
    } else if (e.altKey && !typing && e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateBy(-1);
    }
  }
  window.addEventListener('keydown', onKey);
  /** Whether a fitted page was rendered for a workspace of another size than the current one. */
  const needsRefit = () =>
    (scaleMode === 'fit' && workspace.clientWidth !== renderedWorkspaceWidth) ||
    (scaleMode === 'page' &&
      (workspace.clientWidth !== renderedWorkspaceWidth ||
        workspace.clientHeight !== renderedWorkspaceHeight));
  /** Defer refitting while properties are open, keeping page handles and selection stable. */
  function refitPage() {
    if (!busy && !destroyed && !properties.active && !textEdit && !noteEdit && needsRefit())
      safe(async () => {
        if (pageImages.dirty) await pageImages.finish();
        if (needsRefit()) await renderPage();
      })();
  }
  // Ctrl + wheel, which is also what a trackpad pinch sends, zooms the page around the pointer
  // instead of letting the browser zoom the whole application.
  let wheelDistance = 0,
    wheelZooming = false;
  workspace.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !pdf) return;
      e.preventDefault();
      wheelDistance += e.deltaMode === 0 ? e.deltaY : e.deltaY * 24;
      // Pinches arrive as many small deltas; a notch of a mouse wheel as one large one.
      if (Math.abs(wheelDistance) < 24) return;
      const direction = wheelDistance < 0 ? 1 : -1;
      wheelDistance = 0;
      if (wheelZooming || busy) return;
      const next = zoomStep(direction);
      if (next === scaleMode) return;
      wheelZooming = true;
      safe(() => setZoom(next, { x: e.clientX, y: e.clientY }))().finally(() => {
        wheelZooming = false;
      });
    },
    { passive: false },
  );
  let resizeTimer;
  const resizeObserver = new ResizeObserver(() => {
    // Where the page starts below the tool rows: on narrow screens the navigation panel
    // overlays only the page, so the tools stay in reach while it is open.
    editorRoot.style.setProperty(
      '--document-bars',
      `${workspace.parentNode.offsetTop + workspace.offsetTop}px`,
    );
    snapPaper();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refitPage, 150);
  });
  resizeObserver.observe(workspace);
  updateStatus();
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    closeComparison();
    stopReading();
    stack.destroy();
    Promise.resolve(ocrEngine?.terminate()).catch(() => {});
    document.removeEventListener('fullscreenchange', onFullscreen);
    window.removeEventListener('keydown', onSpace);
    window.removeEventListener('keyup', onSpace);
    window.removeEventListener('blur', releaseSpace);
    saveController?.abort();
    cancelTextSelection();
    dialogController.abort();
    printNotice.remove();
    document.body.classList.remove('pdf-restricted-print');
    document.removeEventListener('copy', restrictCopy);
    document.removeEventListener('cut', restrictCopy);
    document.removeEventListener('dragstart', restrictCopy);
    clearTextPreview(textEdit);
    pageImages.destroy();
    generation++;
    pageRenderGeneration++;
    searchGeneration++;
    clearTimeout(searchTimer);
    clearTimeout(resizeTimer);
    clearTimeout(highlightCaptureTimer);
    resizeObserver.disconnect();
    tabsObserver.disconnect();
    thumbnailObserver?.disconnect();
    renderTask?.cancel();
    textLayer?.cancel();
    loadingTask?.destroy().catch(() => {});
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', updateDrawingModifier);
    window.removeEventListener('keyup', updateDrawingModifier);
    document.removeEventListener('selectionchange', captureHighlightSelection);
    document.removeEventListener('pointermove', followTextDrag, true);
    document.removeEventListener('pointerup', endTextDrag, true);
    document.removeEventListener('pointercancel', endTextDrag, true);
    menubar.destroy();
    reorder.destroy();
    closeMenu();
    document.querySelector('#announcer').textContent = '';
  }
  const ready = (async () => {
    try {
      await reload();
    } catch (error) {
      if (!destroyed) {
        destroy();
        throw error;
      }
    } finally {
      initializing = false;
      busy = false;
      updateStatus();
    }
    // The PDF can say how it opens: its layout, a side panel, a page, and a zoom.
    if (!destroyed) await applyInitialView().catch(() => {});
  })();
  async function applyInitialView() {
    const doc = await PDFDocument.load(session.bytes, { updateMetadata: false });
    if (destroyed) return;
    const view = readInitialView(doc);
    pdfaClaim = readPdfaClaim(doc);
    showStandardsBar();
    if (view.displayTitle) {
      const title = doc.getTitle?.()?.trim();
      if (title) shownTitle = title;
    }
    if (view.layout !== 'default') setPageDisplay(view.layout, { remember: false });
    const panel = {
      bookmarks: 'outline',
      pages: 'pages',
      attachments: 'attachments',
      layers: 'layers',
    }[view.panel];
    if (panel && !sidebarTabs.querySelector(`[data-tab="${panel}"]`)?.hidden) {
      showSidebarTab(panel);
      if (editorRoot.classList.contains('hide-pages')) await toggleSidebar(true);
    }
    if (view.page > 0 && view.page < pageCount) await navigate(view.page);
    if (view.zoom !== 'default') await setZoom(String(view.zoom === 'fit' ? 'fit' : view.zoom));
    updateStatus();
  }
  return {
    ready,
    get dirty() {
      return (
        session.dirty ||
        protectionDirty ||
        saving ||
        (busy && !initializing) ||
        pendingTextEdit() ||
        pendingNoteEdit() ||
        pageForms.draft.dirty ||
        pageImages.dirty
      );
    },
    updateAccount: ({ resetCloud = false } = {}) => {
      if (resetCloud) {
        // Cloud destinations and pending saves belong to the account that chose them.
        // A later sign-in starts with a new copy, leaving local content and history available.
        saveGeneration++;
        // SDK writes and encryption have no cancellation API. Stop waiting so an ended
        // account cannot leave the retained document locked behind its pending save.
        saveController?.abort();
        path = null;
        remote = null;
        cloudRevision = null;
      }
      updateStatus();
    },
    get name() {
      return name;
    },
    // Leaving asks to save; one already under way is awaited, and its own caller reports a
    // failure. The caller then checks `dirty` to see whether the PDF was saved.
    save: () =>
      saving
        ? Promise.resolve(runningSave).then(
            () => {},
            () => {},
          )
        : save(),
    destroy,
  };
}
