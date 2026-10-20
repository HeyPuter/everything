import { textEditHistory } from "./text-edit-history.js";
import { TextFieldEdits, trackTextFields } from "./text-fields.js";
import { createSlideAdvanceClock } from "./slide-advance-clock.js";
import { createSlideLaserPointer } from "./slide-laser-pointer.js";
import { createSlideAnimator } from "./slide-animator.js";
import { selectionHandleLayout } from "./selection-handles.js";
import { reflowShapeDiagram } from "../lib/pptx/src/api/fn/diagram-reflow.ts";
import { buildDiagramDrawing } from "../lib/pptx/src/api/fn/diagram-build.ts";
import { readOpenTypeFont } from "../lib/pptx/src/internal/fonts/index.ts";
import "./style.css";
import { slideFontResolver } from "./fonts.js";
import {
  resolveFontKerning,
  presentationFontFamilies,
} from "./font-resources.js";
import {
  disposeDocumentFonts,
  retainDocumentFonts,
  documentFontStatus,
  documentFontStamp,
} from "./document-font-resources.js";
import { slideFieldStamp, slideHasDateFields } from "./slide-fields.js";
import {
  P,
  MIME,
  THEMES,
  sectionTextColor,
  createDeck,
  addDesignedSlide,
  text,
  shape,
  line,
  SHAPES,
  ARROW_SHAPES,
  SQUARE_PRESETS,
  WIDE_PRESETS,
  shapeLabel,
  shapeText,
  shapeIcon,
  visibleSlideShapes,
  groupParents,
  slideBounds,
  tableLayout,
  setSlideBounds,
  slideRotation,
  ownRotation,
  carriedByGroup,
  removeAnyShape,
  groupFlip,
  hasSlideJump,
  slideTitle,
  slideDescription,
  pruneUnusedMedia,
  removeSlides,
  dedupeSlideMedia,
  canHoldText,
  hasTextBody,
  textRuns,
  textParagraphSpacing,
  textEditorRectangle,
  displayShapeText,
  displayTableCellText,
  shapeTextFields,
  tableTextFields,
  retainTextFields,
  fieldFormattingRange,
  firstTextElement,
  setRichText,
  slideNumberRun,
  splitFieldEdges,
  SOFT_BREAK,
  setParagraphIndentLevel,
  LEVEL_INDENTS,
  listOf,
  ensureTextBody,
  clearListIndent,
  preview,
  templateStamp,
  slideDiagramDataStamp,
  prepareDeckFonts,
  parseDeck,
  validateImportSize,
  restoreDeck,
  History,
  cleanName,
} from "./model.js";
import * as cloud from "./cloud.js";
import { createAssistantPanel } from "./assistant-panel.js";
import { createRibbon } from "./ribbon/ribbon.js";
import { buildTabs } from "./ribbon/tabs.js";
import { colorMenuItems, modulate } from "./color-palette.js";
import { createDrawTools } from "./draw-tab.js";
import { createFormatTools } from "./format/index.js";
import {
  formatFrame,
  preferTab,
  sectionsFromHeadings,
  sheetHandle,
  showFormatTab,
} from "./format/pane-frame.js";
import { section } from "./format/controls.js";
import { createTransitionTools } from "./transitions/editor.js";
import { prefersReducedMotion } from "./transitions/player.js";
import { createLayoutCommands } from "./layouts/slide-layouts.js";
import { createMasterView } from "./layouts/master-view.js";
import { decoratePlaceholders, fitInto } from "./layouts/placeholders.js";
import { createSlidesFrom } from "./layouts/slides-from.js";
import {
  libraryMeta,
  homeRail,
  promptBox,
  themeStrip,
  libraryFilter,
} from "./start/start-screen.js";
import { generateDeck, themeDeck } from "./start/deck-from-prompt.js";
import { createThemeTools, themeStartPicture } from "./themes/design-tab.js";
import { createBackgroundPane } from "./themes/format-background.js";
import { lucide } from "./draw/draw-icons.js";
import { SHOW_PEN_COLORS } from "./draw/show-ink.js";
import { createReview } from "./review/index.js";
import { createChartTools } from "./charts/chart-tools.js";
import { createSmartArtTools } from "./smartart/smartart-tools.js";
import { createFileTools } from "./export/file-tools.js";
import { createInsertFeatures } from "./insert/index.js";
import { createShowFeatures } from "./show/index.js";
import { createAnimationTools } from "./animations/editor.js";
import { createViews, readingBar, placeReadingDialog } from "./views/index.js";
import "./chrome/chrome.css";
import { NO_CHANGE } from "./assistant-tools.js";
import { AI_MODEL } from "./assistant.js";
import { zipSync } from "fflate";
import * as drafts from "./drafts.js";
import * as recent from "./recent.js";
import {
  el,
  icon,
  button,
  iconButton,
  toast,
  dialog,
  promptName,
  menu,
  openMenu,
  createMenubar,
  dismissMenuWithin,
  closeMenu,
  MOD_KEY,
  IS_MAC,
} from "./ui.js";

const app = document.querySelector("#app");
let accountRequest = 0,
  documentRequest = 0,
  fontRequest = 0;
let loginPromise = null;
let account = null,
  doc = null,
  index = 0,
  selected = null,
  history = new History(),
  theme = "studio",
  view = "home",
  signingOut = false,
  savingDocument = null;
let accountPicture = null,
  accountPictureRequest = 0;
let files = [],
  localDrafts = [],
  // Presentations opened from elsewhere on the drive (see recent.js).
  recentFiles = [],
  loadError = "",
  // The library starts in its loading state so the empty-library message
  // never appears before the account and local drafts have been checked.
  loading = true,
  query = "",
  sort = "modified",
  // The list shows every presentation ("recent") or only the pinned ones.
  libraryView = "recent",
  revision = 0,
  savedRevision = -1,
  draftRevision = -1;
let autosaveTimer,
  fileDateTimer,
  pendingMutations = 0,
  mutationTail = Promise.resolve(),
  homeRequest = 0;
const saveQueue = new cloud.SaveQueue();
// Autosave waits this long after an edit. A failed one is tried again after
// RETRY_MS, then at doubling intervals up to RETRY_MAX_MS.
const AUTOSAVE_MS = 1400;
const RETRY_MS = 8000;
const RETRY_MAX_MS = 5 * 60_000;
let retryDelay = 0;
// A file up to this size is read back, when its time is newer but its size
// the same, to tell a rename or move made elsewhere (which the drive stamps
// as a modification) from a change made there.
const COMPARE_MAX_BYTES = 4 * 1024 * 1024;
const pendingCloudOpens = new Set();
const pendingFontCandidates = new Set();
const readOnlyDocument = () => !!doc && documentFontStatus(doc.pres).readOnly;
function cancelFontCandidates() {
  for (const pres of pendingFontCandidates) disposeDocumentFonts(pres);
  pendingFontCandidates.clear();
}
const deletingDrafts = new Set();
let pendingRecovery = null;
// The AI assistant beside the open presentation, one per document.
let assistant = null;
let canvasObserver = null;
const inspectorContexts = new WeakMap();
const canvasContexts = new WeakMap();
let activeDrag = null,
  lastCoalesce = null;
const SKIP_MUTATION = Symbol("skip mutation");
const COALESCE_WINDOW = 1000;
const owner = () => account?.uuid || account?.username || "guest";
// crypto.randomUUID exists only in a secure context, which a LAN address over
// plain http is not; the random bytes it is built from are always there.
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
// Buttons that open a menu say so, and whether it is open, for assistive
// technology.
const MENU_BUTTON = { "aria-haspopup": "menu", "aria-expanded": "false" };
// Nobody has to sign in to work: the app opens into a new presentation, and
// the library has a URL of its own so a reload or a link can land there.
const LIBRARY_HASH = "#/home";
// (`history` is the undo history in this module; the browser's is on window.)
function showLibraryUrl() {
  if (location.hash !== LIBRARY_HASH)
    window.history.replaceState(null, "", LIBRARY_HASH);
}
function showEditorUrl() {
  if (location.hash || location.href.endsWith("#"))
    window.history.replaceState(null, "", location.pathname + location.search);
}
// The presentation the app opened with, still blank: nothing to keep or warn
// about until it is edited, named, or saved.
const untouchedLanding = () => !!doc?.pristine && revision === 0 && !doc.path;
// In a master view the canvas edits the open master or layout instead.
const slide = () =>
  (masterView.active && masterView.slide()) || P.getSlides(doc.pres)[index];
// A slide, or the master or layout a master view has open, by part name.
const slideByPart = (part) =>
  P.getSlides(doc.pres).find((s) => P.getSlidePartName(s) === part) ||
  masterView.slideByPart(part) ||
  undefined;
const shapes = () => P.getSlideShapes(slide());
const currentShape = () => (selected == null ? null : shapes()[selected]);
// Objects selected alongside the primary one, by id. The primary keeps the
// handles and the format panel; every selected object moves, copies, aligns,
// groups, and deletes together.
let extras = new Set();
function clearSelection() {
  selected = null;
  extras.clear();
}
function selectionIds() {
  const ids = new Set();
  const primary = currentShape();
  if (primary) ids.add(P.getShapeId(primary));
  for (const id of extras) ids.add(id);
  return ids;
}
function selectedShapes() {
  const ids = selectionIds();
  return shapes().filter((s) => ids.has(P.getShapeId(s)));
}
const multiSelected = () => selectionIds().size > 1;
// The selected objects an action places or copies reaches: one a selected
// group carries goes with its group rather than on its own, as it already
// does when the selection is dragged or stepped with the arrow keys.
function selectedApart() {
  const ids = selectionIds();
  const parents = groupParents(slide());
  return selectedShapes().filter(
    (s) => !carriedByGroup(P.getShapeId(s), parents, ids),
  );
}
// Slides selected alongside the current one in the navigator, by part name.
// They duplicate, hide, move, drag, and delete together with it.
let slideExtras = new Set();
function selectedSlideParts() {
  const parts = new Set([P.getSlidePartName(slide())]);
  const existing = new Set(P.getSlides(doc.pres).map(P.getSlidePartName));
  for (const part of slideExtras)
    if (existing.has(part)) parts.add(part);
    else slideExtras.delete(part);
  return parts;
}
function selectedSlides() {
  const parts = selectedSlideParts();
  return P.getSlides(doc.pres).filter((s) => parts.has(P.getSlidePartName(s)));
}
// Shift-click selects every slide between the current one and this one.
function extendSlideSelection(target) {
  const all = P.getSlides(doc.pres);
  const part = P.getSlidePartName(target);
  const to = all.findIndex((s) => P.getSlidePartName(s) === part);
  if (to < 0) return;
  slideExtras.clear();
  for (let i = Math.min(index, to); i <= Math.max(index, to); i++)
    if (i !== index) slideExtras.add(P.getSlidePartName(all[i]));
  renderSlideSelection();
}
// Ctrl-click adds a slide to the selection or takes it out again. Taking out
// the current slide hands the canvas to the first slide still selected.
function toggleSlideSelected(target) {
  const part = P.getSlidePartName(target);
  if (part === P.getSlidePartName(slide())) {
    const rest = P.getSlides(doc.pres)
      .map(P.getSlidePartName)
      .filter((p) => p !== part && slideExtras.has(p));
    if (!rest.length) return;
    const next = P.getSlides(doc.pres).find(
      (s) => P.getSlidePartName(s) === rest[0],
    );
    chooseSlide(next, { extras: rest.slice(1) });
    return;
  }
  if (slideExtras.has(part)) slideExtras.delete(part);
  else slideExtras.add(part);
  renderSlideSelection();
}
function selectAllSlides() {
  const part = P.getSlidePartName(slide());
  slideExtras = new Set(
    P.getSlides(doc.pres)
      .map(P.getSlidePartName)
      .filter((p) => p !== part),
  );
  renderSlideSelection();
}
function thumbLabel(s, i, chosen) {
  const flags = [P.isSlideHidden(s) && "hidden", chosen && "selected"].filter(
    Boolean,
  );
  return `Slide ${i + 1}${flags.length ? ` (${flags.join(", ")})` : ""}: ${slideTitle(s, doc?.pres) || slideDescription(s, doc?.pres).split("\n")[0] || "Blank"}`;
}
function renderSlideSelection() {
  const list = document.querySelector("#slide-list");
  if (!list || !doc) return;
  const parts = selectedSlideParts();
  const many = parts.size > 1;
  const all = P.getSlides(doc.pres);
  [...list.querySelectorAll(".slide-item")].forEach((row, i) => {
    const s = all[i];
    if (!s || P.getSlidePartName(s) !== row.dataset.slidePart) return;
    const chosen = many && parts.has(row.dataset.slidePart);
    row.classList.toggle("selected", chosen);
    row
      .querySelector(".slide-thumb")
      ?.setAttribute("aria-label", thumbLabel(s, i, chosen));
  });
  updateSlideCount();
}
function updateSlideCount() {
  const count = document.querySelector("#slide-count");
  if (!count || !doc) return;
  const total = P.getSlides(doc.pres).length;
  const chosen = selectedSlideParts().size;
  count.textContent =
    chosen > 1 ? `${chosen} of ${total} selected` : String(total);
}
function selectOnly(index) {
  extras.clear();
  selected = index;
}
// Selects these ids; the last one becomes the primary.
function selectIds(ids) {
  const all = shapes();
  const indices = ids
    .map((id) => all.findIndex((s) => P.getShapeId(s) === id))
    .filter((i) => i >= 0);
  extras.clear();
  selected = indices.length ? indices.at(-1) : null;
  for (const i of indices.slice(0, -1)) extras.add(P.getShapeId(all[i]));
}
function toggleSelected(index) {
  const all = shapes();
  const id = P.getShapeId(all[index]);
  if (selected === index) {
    const [next] = extras;
    if (next == null) selected = null;
    else {
      extras.delete(next);
      selected = all.findIndex((s) => P.getShapeId(s) === next);
    }
  } else if (extras.has(id)) extras.delete(id);
  else if (selected == null) selected = index;
  else extras.add(id);
}
// Every visible object at the slide's top level; grouped children come
// along with their group.
function selectAll() {
  const parents = groupParents(slide());
  selectIds(
    visibleSlideShapes(slide())
      .map(P.getShapeId)
      .filter((id) => !parents.has(id)),
  );
  renderSelection();
  renderInspector();
}
function shapeIndex(target) {
  if (
    !target ||
    P.getSlidePartName(P.getShapeSlide(target)) !== P.getSlidePartName(slide())
  )
    return -1;
  const id = P.getShapeId(target);
  return shapes().findIndex((s) => P.getShapeId(s) === id);
}
const currentSize = () => {
  // The notes and handout masters are drawn on the notes page.
  const page = masterView.pageSize();
  if (page) return page;
  const size = P.getSlideSize(doc.pres);
  return {
    cx: size?.width || P.inches(13.333),
    cy: size?.height || P.inches(7.5),
  };
};
let appearance = "system";
try {
  appearance = localStorage.getItem("presentation:theme") || "system";
} catch {}
// What a new presentation starts with: a Title Slide waiting for its title,
// or one blank slide.
let startWith = "title";
try {
  if (localStorage.getItem("presentation:start") === "blank")
    startWith = "blank";
} catch {}
function setStartWith(value) {
  startWith = value === "blank" ? "blank" : "title";
  try {
    localStorage.setItem("presentation:start", startWith);
  } catch {}
}
// The canvas fits the window unless a zoom level was chosen; the choice
// carries over to the next presentation.
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
];
let zoom = "fit";
try {
  const stored = Number(localStorage.getItem("presentation:zoom"));
  if (stored >= 0.25 && stored <= 4) zoom = stored;
} catch {}
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
// Keep browser chrome in step with the brand's accessible appearance variant.
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", color);
}
darkScheme.addEventListener("change", syncThemeColor);
function setAppearance(value) {
  appearance = ["light", "dark", "system"].includes(value) ? value : "system";
  document.documentElement.dataset.theme = appearance;
  syncThemeColor();
  try {
    localStorage.setItem("presentation:theme", appearance);
  } catch {}
}
setAppearance(appearance);
function fail(error) {
  // Puter's SDK sometimes rejects with `{ msg }` objects instead of Errors.
  toast(
    error?.message || error?.msg || "Something went wrong. Please try again.",
  );
}
function run(fn) {
  return async (e) => {
    try {
      await fn(e);
    } catch (err) {
      fail(err);
    }
  };
}
function brand() {
  return el(
    "div",
    { class: "brand" },
    appIcon(),
    el("span", {}, "Presentation"),
  );
}
function appIcon(className = "brand-mark") {
  return el("img", {
    class: className,
    // The build is served from wherever it is put, as the page's own links
    // are, so the icon beside it is asked for through the same base.
    src: `${import.meta.env.BASE_URL}icon.png`,
    alt: "",
    "aria-hidden": "true",
    width: 35,
    height: 35,
  });
}
function accountMenu(e) {
  openMenu({
    anchor: e.currentTarget,
    label: "Account",
    align: "end",
    minWidth: 230,
    items: accountItems(),
  });
}
function accountItems() {
  return [
    { header: account ? account.username : "Not signed in" },
    { label: "Appearance", icon: "Monitor", onSelect: appearanceDialog },
    {
      label: "Keyboard shortcuts",
      icon: "Keyboard",
      onSelect: shortcutsDialog,
    },
    ...(!account
      ? [
          { separator: true },
          {
            label: "Sign in with Puter",
            icon: "User",
            hint: "Save presentations to your own cloud",
            onSelect: () => login(),
          },
        ]
      : cloud.canSignOut()
        ? [
            { separator: true },
            { label: "Sign out", icon: "LogOut", onSelect: run(logout) },
          ]
        : []),
  ];
}
// A picture is optional and never holds up signing in or opening a document.
function setAccount(connected) {
  account = connected;
  accountPicture = null;
  const request = ++accountPictureRequest;
  if (!account) return;
  cloud.profilePicture().then((picture) => {
    if (request !== accountPictureRequest || !picture) return;
    accountPicture = picture;
    refreshAccountPictureUi();
  });
}
function accountAvatar() {
  if (accountPicture) {
    const picture = accountPicture;
    return el("img", {
      class: "account-avatar account-picture",
      src: picture,
      alt: "",
      "aria-hidden": "true",
      width: 28,
      height: 28,
      onerror: () => {
        if (accountPicture !== picture) return;
        accountPicture = null;
        refreshAccountPictureUi();
      },
    });
  }
  const fallback = icon("User");
  fallback.classList.add("account-avatar");
  return fallback;
}
function refreshAccountPictureUi() {
  // Keep the button itself in place so focus and an open menu survive.
  for (const avatar of document.querySelectorAll(
    ".account-button .account-avatar",
  ))
    avatar.replaceWith(accountAvatar());
}
// The editor's phone layout keeps the account menu inside File options.
function accountButton() {
  const control = button(
    account?.username || "Account",
    null,
    accountMenu,
    `account-button ${view === "editor" ? "desktop-only" : ""}`,
    {
      "aria-label": account
        ? `${account.username}: account and settings`
        : "Account and settings",
      ...MENU_BUTTON,
    },
  );
  control.prepend(accountAvatar());
  return control;
}
// Saving is where Puter comes in: a guest's button says so up front, and the
// click opens the sign-in before the save.
function saveButton() {
  return button(
    account ? "Save" : "Sign in to save",
    "Cloud",
    run(() => saveCloud()),
    "secondary save-button",
    account
      ? {}
      : { title: "Sign in to Puter to keep this presentation in your cloud" },
  );
}
// The header's account and save buttons follow the account; a focused button
// keeps the focus through the swap.
function refreshAccountUi() {
  for (const [selector, make] of [
    [".account-button", accountButton],
    [".save-button", saveButton],
  ]) {
    const current = document.querySelector(selector);
    if (!current) continue;
    const focused = document.activeElement === current;
    const next = make();
    current.replaceWith(next);
    if (focused) next.focus();
  }
  updateSaveStatus();
}
async function appearanceDialog() {
  const select = el(
    "select",
    {
      class: "input",
      "aria-label": "Color mode",
      autofocus: true,
      onchange: (e) => setAppearance(e.target.value),
    },
    ...["system", "light", "dark"].map((v) =>
      el("option", { value: v }, v.charAt(0).toUpperCase() + v.slice(1)),
    ),
  );
  select.value = appearance;
  const start = el(
    "select",
    {
      class: "input",
      "aria-label": "New presentations start with",
      onchange: (e) => setStartWith(e.target.value),
    },
    el("option", { value: "title" }, "A title slide"),
    el("option", { value: "blank" }, "A blank slide"),
  );
  start.value = startWith;
  await dialog({
    title: "Appearance",
    body: el(
      "div",
      { class: "dialog-body" },
      el("label", {}, "Color mode", select),
      el(
        "p",
        { class: "muted" },
        "System follows your device. Your slide colors stay the same.",
      ),
      el("label", {}, "New presentations start with", start),
    ),
    cancel: null,
  });
}
async function shortcutsDialog() {
  await dialog({
    title: "Keyboard shortcuts",
    body: el(
      "div",
      { class: "dialog-body shortcuts" },
      ...[
        ["Ctrl / ⌘ + S", "Save to Puter"],
        ["Ctrl / ⌘ + Shift + S", "Save a copy to Puter"],
        ["Ctrl / ⌘ + O", "Open from Puter"],
        ["Ctrl / ⌘ + P", "Print"],
        ["Ctrl / ⌘ + F or H", "Find, or find and replace"],
        ["Ctrl / ⌘ + G or Shift + G", "Find next or previous"],
        ["Ctrl / ⌘ + = or -", "Zoom in or out"],
        ["Ctrl / ⌘ + 0", "Fit the slide to the window"],
        ["Ctrl / ⌘ + Z", "Undo"],
        ["Ctrl / ⌘ + Shift + Z or Ctrl / ⌘ + Y", "Redo"],
        ["Ctrl / ⌘ + B / I / U", "Bold, italic, or underline"],
        ["Ctrl / ⌘ + Shift + > or <", "Larger or smaller text"],
        ["Ctrl / ⌘ + D", "Duplicate selected object"],
        ["Ctrl / ⌘ + Shift + D", "Duplicate slide"],
        ["Ctrl / ⌘ + Alt + R", "Show or hide the ribbon"],
        ["Ctrl / ⌘ + C / X / V", "Copy, cut, or paste objects"],
        ["Ctrl / ⌘ + A", "Select every object on the slide"],
        ["Ctrl / ⌘ + K", "Add or edit a link on the selected object"],
        ["Ctrl / ⌘ + J", "Open or close the AI assistant"],
        ["Ctrl / ⌘ + Shift + M", "New comment"],
        ["F7", "Check spelling"],
        ["Shift + F7", "Thesaurus"],
        [
          "Ctrl / ⌘ + 1 / 2 / 3 / 4 / 5",
          "Normal, Slide Sorter, Notes Page, Outline View, Reading View",
        ],
        ["Ctrl + Shift + Tab", "Show or hide the outline"],
        ["Ctrl / ⌘ + '", "Show or hide the gridlines"],
        [
          "Tab / Shift + Tab in the outline",
          "Move a line down or up a level; a title becomes a paragraph",
        ],
        ["Alt + arrow keys in the slide sorter", "Move the selected slides"],
        ["F5", "Present from the first slide"],
        ["Shift + F5", "Present from the current slide"],
        [
          "Ctrl / ⌘ + Shift + Enter, Ctrl / ⌘ + Enter",
          "Present from the first slide, or from the current one",
        ],
        ["Alt + F5, or Alt + Enter", "Presenter View"],
        ["? during a slide show", "List the slide show's shortcuts"],
        ["Ctrl + M, or ⌘ + Shift + N on a Mac", "New slide"],
        ["Enter in the thumbnails pane", "New slide after the selected one"],
        ["Ctrl / ⌘ + L / E / R / J", "Align left, center, right, or justify"],
        ["Ctrl + Space", "Clear character formatting"],
        [
          "Ctrl / ⌘ + Shift + C, then Ctrl / ⌘ + Shift + V",
          "Copy formatting, then paste it onto the selection",
        ],
        ["Shift + click", "Add an object to the selection"],
        [
          "Shift + click / Ctrl / ⌘ + click on a thumbnail",
          "Select a range of slides, or one more",
        ],
        [
          "Arrow keys / Home / End in the navigator",
          "Move between slides; Shift extends the selection",
        ],
        ["Ctrl / ⌘ + A in the navigator", "Select every slide"],
        ["Delete in the navigator", "Delete the selected slides"],
        ["Ctrl / ⌘ + Alt + G", "Group the selected objects"],
        ["Ctrl / ⌘ + Alt + Shift + G", "Ungroup the selected group"],
        ["Ctrl / ⌘ + ] or [", "Bring forward or send backward"],
        ["Ctrl / ⌘ + Shift + ] or [", "Bring to front or send to back"],
        ["Enter", "Edit text of the selected object"],
        ["Ctrl / ⌘ + Enter", "Finish editing text"],
        [
          "Tab / Shift + Tab while editing text",
          "Nest or un-nest the paragraph",
        ],
        ["Tab / Shift + Tab in a table cell", "Next or previous cell"],
        ["Arrow keys", "Move selected object"],
        ["Shift + Arrow keys", "Move by a larger step"],
        ["Delete / Backspace", "Delete selected object"],
        ["Escape", "Finish editing text, deselect, or exit presentation"],
        ["P / ← in presentation", "Previous slide"],
        ["N / → in presentation", "Next slide"],
        ["Home / End in presentation", "First or last slide"],
        [
          "Tab, then Enter / Space in presentation",
          "Activate a control, including speaker notes",
        ],
        ["B / W in presentation", "Black or white screen"],
        ["S in presentation", "Pause or resume automatic advance"],
        ["I in presentation", "Pen on or off"],
        ["E in presentation", "Erase the ink on the slide"],
        ["Number, then Enter, in presentation", "Go to that slide"],
      ].map(([keys, action]) =>
        el("div", {}, el("span", {}, action), el("kbd", {}, keys)),
      ),
    ),
    cancel: null,
  });
}
function login() {
  if (!loginPromise) {
    const pending = connectAccount().finally(() => {
      if (loginPromise === pending) loginPromise = null;
    });
    loginPromise = pending;
  }
  return loginPromise;
}
async function connectAccount() {
  const request = ++accountRequest;
  try {
    const connected = await cloud.signIn();
    if (request !== accountRequest) return false;
    return applyAccount(connected, request);
  } catch (e) {
    // Closing the sign-in window is not an error worth reporting.
    if (request === accountRequest && e?.code !== "cancelled") fail(e);
    return false;
  }
}
async function applyAccount(connected, request) {
  setAccount(connected);
  if (view === "home") await home(false);
  else {
    doc.owner = owner();
    if (doc.path) rememberOpened(doc);
    refreshAccountUi();
    await mutationTail;
    if (request !== accountRequest) return false;
    const recovered = await persistDraft().then(
      () => true,
      () => false,
    );
    if (request !== accountRequest) return false;
    toast(
      recovered
        ? `Signed in as ${account.username}. Save to keep this presentation in Puter.`
        : `Signed in as ${account.username}. Local recovery is unavailable. Save to Puter to keep your work.`,
    );
  }
  return request === accountRequest;
}
// The SDK opens its own sign-in before a cloud call made without a session
// and reports the user afterwards; the app follows it like its own sign-in.
function adoptAccount(user) {
  if (!user || account || loginPromise || signingOut) return;
  applyAccount(user, ++accountRequest).catch(fail);
}

async function logout() {
  if (signingOut) return;
  signingOut = true;
  documentRequest++;
  const before = document.activeElement;
  const progress = el(
    "dialog",
    { class: "dialog", "aria-label": "Signing out" },
    el("p", { class: "dialog-body", role: "status" }, "Signing out…"),
  );
  progress.addEventListener("cancel", (e) => e.preventDefault());
  document.body.append(progress);
  progress.showModal();
  try {
    if (!(await leaveEditor())) return;
    accountRequest++;
    loginPromise = null;
    await cloud.signOut();
    setAccount(null);
    return home();
  } finally {
    signingOut = false;
    progress.close();
    progress.remove();
    if (before?.isConnected) before.focus();
  }
}

// Replacing the whole screen drops focus onto <body>; land keyboard and
// screen reader users on the new main region instead.
function focusView() {
  if (!document.activeElement || document.activeElement === document.body)
    document.querySelector("#main")?.focus({ preventScroll: true });
}
async function home(cancelOpen = true, { focus = true } = {}) {
  activeDrag?.cancel();
  if (cancelOpen) {
    documentRequest++;
    cancelFontCandidates();
  }
  if (doc) disposeDocumentFonts(doc.pres);
  history = new History();
  setTitle(null);
  view = "home";
  showLibraryUrl();
  assistant?.destroy();
  assistant = null;
  doc = null;
  clearSelection();
  clearTimeout(autosaveTimer);
  clearThumbnailQueue();
  const req = ++homeRequest;
  const requestOwner = owner();
  files = [];
  localDrafts = [];
  recentFiles = [];
  loading = true;
  loadError = "";
  renderHome();
  if (focus) focusView();
  await loadLibrary(req, requestOwner);
}
async function loadLibrary(req = ++homeRequest, requestOwner = owner()) {
  const [cloudResult, draftResult] = await Promise.allSettled([
    account ? cloud.listFiles() : [],
    drafts.listDrafts(requestOwner),
  ]);
  if (req !== homeRequest || view !== "home" || owner() !== requestOwner)
    return;
  files = cloudResult.status === "fulfilled" ? cloudResult.value : [];
  localDrafts = draftResult.status === "fulfilled" ? draftResult.value : [];
  // Listed at once from this device's record, then again once each file has
  // been looked up where the drive keeps it now.
  recentFiles = account ? recent.recentFiles(requestOwner) : [];
  if (recentFiles.length)
    recent.refreshRecent(requestOwner).then((found) => {
      if (req !== homeRequest || view !== "home" || owner() !== requestOwner)
        return;
      recentFiles = found;
      renderFileList();
    });
  loadError = "";
  if (cloudResult.status === "rejected" || draftResult.status === "rejected") {
    loadError =
      draftResult.status === "rejected" &&
      draftResult.reason?.code === "blocked"
        ? draftResult.reason.message
        : "Could not load your presentations. Check your connection and try again.";
  }
  loading = false;
  renderFileList();
}
function renderHome() {
  dismissMenuWithin(app);
  canvasObserver?.disconnect();
  app.replaceChildren(
    el(
      "div",
      { class: "home with-rail" },
      el(
        "header",
        { class: "home-header" },
        brand(),
        el(
          "div",
          { class: "header-right" },
          button("Open from Puter", "FolderOpen", run(openPicker), "secondary"),
          accountButton(),
        ),
      ),
      homeRail([
        {
          id: "home",
          label: "Home",
          icon: "House",
          run: () => homeSection(".home-main", "#main"),
        },
        {
          id: "new",
          label: "New",
          icon: "FilePlus",
          run: () => homeSection(".home-prompt", ".home-prompt-input"),
        },
        {
          id: "recent",
          label: "Recent",
          icon: "Clock",
          run: () => homeSection(".library", ".search-box input"),
        },
        {
          id: "open",
          label: "Open",
          icon: "FolderOpen",
          action: true,
          run: run(openPicker),
        },
      ]),
      el(
        "main",
        { id: "main", class: "home-main", tabindex: -1 },
        el(
          "div",
          { class: "home-title" },
          el(
            "div",
            {},
            el("p", { class: "eyebrow" }, "YOUR WORKSPACE"),
            el("h1", {}, "Good ideas deserve a stage."),
            el(
              "p",
              { class: "muted" },
              "Start with a blank canvas, or a little inspiration.",
            ),
          ),
          button(
            "New presentation",
            "Plus",
            run(() => newDeck("blank")),
            "primary",
          ),
        ),
        promptBox({
          themes: deckThemes(),
          theme: promptTheme,
          available: () => cloud.canAI(),
          create: (description, options) =>
            deckFromPrompt(description, options),
        }),
        el(
          "section",
          { class: "templates", "aria-label": "Start a presentation" },
          templateCard(
            "blank",
            "Blank presentation",
            "A fresh canvas",
            "studio",
          ),
          templateCard(
            "story",
            "The big idea",
            "A clear, considered story",
            "studio",
          ),
          templateCard("pitch", "The pitch", "Make your next move", "cobalt"),
          templateCard(
            "story",
            "A new perspective",
            "A warmer point of view",
            "clay",
          ),
        ),
        themeStrip(
          deckThemes().map((t) => ({ ...t, preview: themePreview(t.key) })),
          (key) => run(() => newThemeDeck(key))(),
        ),
        !account &&
          el(
            "div",
            { class: "cloud-banner" },
            el("div", { class: "banner-icon" }, icon("Cloud", 22)),
            el(
              "div",
              {},
              el("strong", {}, "Your ideas, wherever you go."),
              el(
                "p",
                {},
                "Sign in to save real PowerPoint files in your Puter cloud.",
              ),
            ),
            button("Connect Puter", "ArrowRight", () => login(), "secondary"),
          ),
        el(
          "section",
          { class: "library", "aria-label": "Your presentations" },
          el(
            "div",
            { class: "library-head" },
            el(
              "div",
              { class: "library-heading" },
              el("h2", {}, "Your presentations"),
              libraryFilter(libraryView, (id) => {
                libraryView = id;
                for (const b of document.querySelectorAll(
                  ".library-filter-btn",
                ))
                  b.setAttribute(
                    "aria-pressed",
                    String(b.dataset.filter === id),
                  );
                renderFileList();
              }),
            ),
            el(
              "div",
              { class: "library-tools" },
              el(
                "label",
                { class: "search-box" },
                icon("Search", 17),
                el("input", {
                  type: "search",
                  placeholder: "Search presentations",
                  "aria-label": "Search presentations",
                  value: query,
                  oninput: (e) => {
                    query = e.target.value;
                    renderFileList();
                  },
                }),
              ),
              el(
                "select",
                {
                  "aria-label": "Sort presentations",
                  class: "sort-select",
                  onchange: (e) => {
                    sort = e.target.value;
                    renderFileList();
                  },
                },
                // "modified" sorts by when each was last opened here, or
                // else changed; the value keeps its first name.
                el(
                  "option",
                  { value: "modified", selected: sort === "modified" },
                  "Last opened",
                ),
                el(
                  "option",
                  { value: "name", selected: sort === "name" },
                  "Name",
                ),
              ),
              button("Import PPTX", "Upload", () => pickLocal(), "secondary"),
            ),
          ),
          el("div", { id: "file-list" }),
        ),
      ),
      el(
        "footer",
        { class: "home-footer" },
        el("span", {}, "Made for the way you think."),
        el("span", {}, "PPTX files · Powered by Puter"),
      ),
    ),
  );
  renderFileList();
}
// Template artwork never changes, so each card is rendered once per session
// instead of on every return to the home screen.
const templatePreviews = new Map();
function templatePreview(type, color) {
  const key = `${type}:${color}`;
  if (!templatePreviews.has(key)) {
    const pres = createDeck(type, color);
    templatePreviews.set(key, preview(pres, P.getSlides(pres)[0]));
  }
  return templatePreviews.get(key);
}
// The palettes a new deck can start in, from the app's themes.
function deckThemes() {
  return Object.entries(THEMES).map(([key, t]) => ({ key, name: t.name }));
}
let promptTheme = "studio";
function themePreview(key) {
  const cacheKey = `theme:${key}`;
  const designed = themeStartPicture(key);
  if (designed) return designed;
  if (!templatePreviews.has(cacheKey)) {
    const pres = themeDeck(key);
    templatePreviews.set(cacheKey, preview(pres, P.getSlides(pres)[0]));
  }
  return templatePreviews.get(cacheKey);
}
async function newThemeDeck(key) {
  await openDocument(() => ({
    pres: themeDeck(key),
    name: "Untitled presentation",
    color: key,
  }));
}
// Scrolls the library to one of its parts and puts the keyboard there.
function homeSection(selector, focusSelector) {
  const target = document.querySelector(selector);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
  document.querySelector(focusSelector)?.focus({ preventScroll: true });
}
// A deck written by the AI from a description opens as a new presentation.
async function deckFromPrompt(description, options) {
  promptTheme = options.theme;
  const { pres, name } = await generateDeck(description, {
    ...options,
    chat: (messages, opts) => cloud.aiChatStream(messages, opts),
    model: AI_MODEL,
  });
  if (options.signal?.aborted || view !== "home") return;
  await openDocument(() => ({ pres, name, color: options.theme }));
}
const libraryRecords = () => libraryMeta(owner());
function templateCard(type, title, subtitle, color) {
  const thumb = el(
    "div",
    { class: `template-preview ${type === "blank" ? "blank-preview" : ""}` },
    type === "blank"
      ? icon("Plus", 32)
      : el("img", {
          src: templatePreview(type, color),
          alt: "",
          loading: "lazy",
          draggable: "false",
        }),
  );
  // The new presentation is named after the card that was chosen.
  return el(
    "button",
    {
      class: "template-card",
      onclick: run(() => newDeck(type, color, type === "blank" ? null : title)),
    },
    thumb,
    el("span", { class: "template-name" }, title),
    el("span", { class: "template-meta" }, subtitle),
  );
}
function renderFileList() {
  clearTimeout(fileDateTimer);
  const list = document.querySelector("#file-list");
  if (!list) return;
  dismissMenuWithin(list);
  const focused = document.activeElement;
  const focusedRow = focused?.closest(".file-row");
  const previousRows = focusedRow
    ? [...list.querySelectorAll(".file-row")]
    : [];
  const rowIndex = previousRows.indexOf(focusedRow);
  const buttonIndex = focusedRow
    ? [...focusedRow.querySelectorAll("button")].indexOf(focused)
    : -1;
  function restoreFocus() {
    if (
      rowIndex < 0 ||
      buttonIndex < 0 ||
      document.activeElement !== document.body
    )
      return;
    const rows = [...list.querySelectorAll(".file-row")];
    const row =
      rows.find((row) => row.dataset.fileKey === focusedRow.dataset.fileKey) ||
      rows[Math.min(rowIndex, rows.length - 1)];
    const target =
      row?.querySelectorAll("button")[buttonIndex] ||
      document.querySelector('.home-title [aria-label="New presentation"]');
    target?.focus();
  }
  list.replaceChildren();
  if (loading) {
    list.append(
      el(
        "div",
        { class: "empty-state", role: "status" },
        "Loading your presentations…",
      ),
    );
    restoreFocus();
    return;
  }
  if (loadError)
    list.append(
      el(
        "div",
        { class: "error-row" },
        el("span", {}, loadError),
        button("Retry", null, () => home(), "secondary"),
      ),
    );
  const searchText = query.normalize("NFC").toLowerCase();
  const records = libraryRecords();
  const rows = [
    ...localDrafts.map((d) => ({
      kind: "draft",
      ...d,
      modified: d.updated,
      name: d.name,
    })),
    ...files.map((f) => ({
      kind: "cloud",
      ...f,
      modified: Number(f.modified || f.created || 0) * 1000,
    })),
    ...recentFiles
      .filter((r) => !files.some((f) => f.path === r.path))
      .map((r) => ({
        kind: "recent",
        ...r,
        modified: cloud.modifiedMs(r) ?? r.at,
      })),
  ]
    // Search and sort by the displayed title so the .pptx extension of cloud
    // files neither matches queries nor shifts alphabetical order.
    .map((f) => ({ ...f, title: fileTitle(f) }))
    .map((f) => {
      const opened = records.openedAt(f);
      return {
        ...f,
        pinned: records.isPinned(f),
        // The date shown and sorted by: when it was last opened here, or
        // else last changed.
        modified: opened && opened > (f.modified || 0) ? opened : f.modified,
      };
    })
    .filter((f) => libraryView !== "pinned" || f.pinned)
    .filter((f) => f.title.normalize("NFC").toLowerCase().includes(searchText))
    // Names sort the way file browsers do: "Deck 2" before "Deck 10".
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        : b.modified - a.modified,
    )
    // Pinned presentations lead the list.
    .sort((a, b) => b.pinned - a.pinned);
  if (!rows.length) {
    // A failed load already explains itself and offers a retry; do not also
    // claim the library is empty.
    if (loadError) {
      restoreFocus();
      return;
    }
    list.append(
      el(
        "div",
        { class: "empty-state" },
        el(
          "div",
          { class: "empty-icon" },
          icon(query ? "Search" : "Presentation", 27),
        ),
        el(
          "h3",
          {},
          query
            ? "No matching presentations"
            : libraryView === "pinned"
              ? "Nothing pinned yet"
              : "Your next story starts here",
        ),
        el(
          "p",
          {},
          query
            ? "Try another name."
            : libraryView === "pinned"
              ? "Pin a presentation from its options to keep it here."
              : "Create a presentation above or bring in a PowerPoint file.",
        ),
        !query &&
          libraryView !== "pinned" &&
          button(
            "Import a presentation",
            "Upload",
            () => pickLocal(),
            "secondary",
          ),
      ),
    );
    restoreFocus();
    return;
  }
  list.append(
    el(
      "div",
      { class: "file-table-head" },
      el("span", {}, "NAME"),
      el("span", {}, "LOCATION"),
      el("span", {}, "LAST OPENED"),
      el("span"),
    ),
  );
  for (const f of rows) {
    const label = f.title;
    list.append(
      el(
        "div",
        { class: "file-row", "data-file-key": fileKey(f) },
        el(
          "button",
          {
            class: "file-open",
            title: label,
            onclick: run(() => {
              records.noteOpened(f);
              return f.kind === "draft" ? recover(f) : openCloud(f);
            }),
          },
          el("span", { class: "file-icon" }, icon("Presentation", 21)),
          el(
            "span",
            { class: "file-text" },
            el(
              "strong",
              {},
              label,
              f.pinned &&
                el(
                  "span",
                  { class: "file-pin", title: "Pinned" },
                  lucide("Pin", 12),
                  el("span", { class: "visually-hidden" }, " (pinned)"),
                ),
            ),
            el(
              "small",
              {},
              f.kind === "draft" ? "Recovery draft" : "PowerPoint presentation",
            ),
          ),
        ),
        el(
          "span",
          {
            class: "file-location",
            title: f.kind === "recent" ? f.path : null,
          },
          icon(f.kind === "draft" ? "Monitor" : "Cloud", 15),
          f.kind === "draft"
            ? "This device"
            : f.kind === "recent"
              ? `Puter · ${cloud.folderName(f.path) || "Home"}`
              : "Puter",
        ),
        el(
          "span",
          { class: "file-date", "data-modified": f.modified },
          relativeDate(f.modified),
        ),
        iconButton(
          `Options for ${label}`,
          "MoreHorizontal",
          (e) => libraryFileMenu(e, f),
          MENU_BUTTON,
        ),
      ),
    );
  }
  refreshFileDates();
  restoreFocus();
}
function fileKey(file) {
  return JSON.stringify([file.kind, file.id || file.path]);
}
function fileTitle(file) {
  return cleanName(file.name, {
    stripExtension: file.kind !== "draft",
    maxLength: Infinity,
  });
}
function nameChanged(name, current) {
  return Boolean(
    name &&
    name !== current &&
    cleanName(name, { stripExtension: false }) !== current &&
    cleanName(name) !== current,
  );
}
function refreshFileDates() {
  clearTimeout(fileDateTimer);
  if (view !== "home" || document.visibilityState !== "visible") return;
  const dates = document.querySelectorAll(".file-date");
  for (const date of dates) {
    const label = relativeDate(Number(date.dataset.modified));
    if (date.textContent !== label) date.textContent = label;
  }
  if (dates.length) fileDateTimer = setTimeout(refreshFileDates, 60000);
}
document.addEventListener("visibilitychange", refreshFileDates);
function relativeDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "Date unavailable";
  const now = new Date();
  const minutes = (now.getTime() - date.getTime()) / 60000;
  // A cloud timestamp can run seconds ahead of this device's clock.
  if (minutes > -60 && minutes < 1) return "Just now";
  if (minutes >= 1 && minutes < 60) return `${Math.floor(minutes)} min ago`;
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}
function libraryFileMenu(e, f) {
  const anchor = e.currentTarget;
  const currentRow = () =>
    [...document.querySelectorAll(".file-row")].find(
      (row) => row.dataset.fileKey === fileKey(f),
    );
  const returnFocus = () => {
    if (anchor.isConnected) return anchor;
    if (view !== "home") return null;
    return (
      currentRow()?.querySelector(".icon-btn") ||
      document.querySelector('.home-title [aria-label="New presentation"]')
    );
  };
  const records = libraryRecords();
  const pinned = records.isPinned(f);
  menu(anchor, [
    {
      label: "Open",
      icon: "FolderOpen",
      action: run(() => {
        records.noteOpened(f);
        return f.kind === "draft" ? recover(f) : openCloud(f);
      }),
    },
    {
      label: pinned ? "Unpin" : "Pin to Top",
      icon: pinned ? "o:unpinItem" : "o:pinItem",
      action: () => {
        records.togglePin(f);
        renderFileList();
      },
    },
    ...(f.kind === "recent"
      ? [
          {
            label: "Download PPTX",
            icon: "Download",
            action: run(async () =>
              reportExport(
                await cloud.download(
                  await cloud.readFile(f.path),
                  fileTitle(f),
                ),
                "PowerPoint file downloaded.",
              ),
            ),
          },
          { separator: true },
          {
            // The file is not the app's to delete: it lives elsewhere on the
            // drive, and only leaves this list.
            label: "Remove from list",
            icon: "X",
            action: () => {
              recent.forgetRecent(owner(), f.path);
              libraryRecords().forget(f);
              recentFiles = recentFiles.filter((r) => r.path !== f.path);
              renderFileList();
            },
          },
        ]
      : []),
    ...(f.kind === "cloud"
      ? [
          {
            label: "Rename",
            icon: "Pencil",
            action: run(async () => {
              const requestOwner = owner();
              const accountVersion = accountRequest;
              const name = await promptName(
                "Rename presentation",
                fileTitle(f),
                returnFocus,
              );
              if (nameChanged(name, fileTitle(f))) {
                await saveQueue.run(async () => {
                  if (
                    accountVersion !== accountRequest ||
                    !nameChanged(name, fileTitle(f))
                  )
                    return;
                  const path = f.path;
                  const renamedPath = await renameCloudPath(path, name);
                  const row = currentRow();
                  libraryRecords().rename(f, { path: renamedPath });
                  f.path = renamedPath;
                  f.name = `${cleanName(name)}.pptx`;
                  if (row) row.dataset.fileKey = fileKey(f);
                  try {
                    if (doc?.path === path && doc.owner === requestOwner) {
                      const target = doc;
                      target.path = f.path;
                      target.name = cleanName(name);
                      revision++;
                      await mutationTail;
                      if (doc !== target) return;
                      await persistDraft().catch(warnStorage);
                      if (doc !== target) return;
                      showDocumentName(target.name);
                      scheduleSave();
                    }
                  } finally {
                    await drafts
                      .renameCloudFile(
                        requestOwner,
                        path,
                        f.path,
                        cleanName(name),
                      )
                      .catch(warnStorage);
                  }
                });
                if (view === "home") await loadLibrary();
              }
            }),
          },
          {
            label: "Download PPTX",
            icon: "Download",
            action: run(async () =>
              reportExport(
                await cloud.download(
                  await cloud.readFile(f.path),
                  fileTitle(f),
                ),
                "PowerPoint file downloaded.",
              ),
            ),
          },
        ]
      : []),
    ...(f.kind === "recent" ? [] : [{ separator: true }]),
    f.kind !== "recent" && {
      label: f.kind === "draft" ? "Delete draft" : "Delete presentation",
      icon: "Trash2",
      danger: true,
      action: run(async () => {
        const requestOwner = owner();
        const accountVersion = accountRequest;
        if (
          f.kind === "draft" &&
          pendingRecovery?.id === f.id &&
          pendingRecovery.request === documentRequest
        )
          documentRequest++;
        if (
          await dialog({
            title: `Delete “${fileTitle(f)}”?`,
            // A draft lives on this device only; the cloud file it may be
            // linked to stays in Puter.
            body: el(
              "p",
              { class: "dialog-body" },
              f.kind === "draft"
                ? "This removes the recovery draft from this device. Work that was not saved to Puter or downloaded is lost."
                : "This removes the file from your Puter cloud permanently. This action cannot be undone.",
            ),
            confirm: "Delete",
            danger: true,
            returnFocus,
          })
        ) {
          if (f.kind === "draft") {
            if (accountVersion !== accountRequest || deletingDrafts.has(f.id))
              return;
            deletingDrafts.add(f.id);
            try {
              await drafts.deleteDraft(f.id);
            } finally {
              deletingDrafts.delete(f.id);
            }
          } else
            await saveQueue.run(async () => {
              if (accountVersion !== accountRequest) return;
              const path = f.path;
              await cloud.deleteFile(path);
              for (const pending of pendingCloudOpens) {
                if (
                  pending.owner === requestOwner &&
                  pending.path === path &&
                  pending.request === documentRequest
                )
                  documentRequest++;
              }
              if (doc?.owner === requestOwner && doc.path === path) {
                const target = doc;
                target.path = null;
                savedRevision = -1;
                revision++;
                clearTimeout(autosaveTimer);
                await mutationTail;
                if (doc === target) await persistDraft().catch(warnStorage);
              }
              await drafts
                .detachCloudFile(requestOwner, path)
                .catch(warnStorage);
            });
          if (view === "home") await loadLibrary();
        }
      }),
    },
  ]);
}

function activeEditorInput() {
  const input = document.activeElement;
  return input?.matches(
    "#speaker-notes, .inline-editor, #inspector input, #inspector textarea, #inspector select",
  )
    ? input
    : null;
}
async function leaveEditor() {
  const target = doc;
  for (;;) {
    if (doc !== target) return false;
    activeEditorInput()?.blur();
    richEditor?.close();
    const pending = mutationTail;
    await pending;
    if (doc !== target) return false;
    if (!doc) return true;
    if (pending !== mutationTail || activeEditorInput()) continue;
    if (untouchedLanding()) return true;
    if (revision !== draftRevision) {
      try {
        await persistDraft();
      } catch {}
    }
    if (doc !== target) return false;
    if (pending !== mutationTail || activeEditorInput()) continue;
    // A presentation kept in Puter takes its latest edits there on the way
    // out, rather than leaving them waiting in a recovery draft. A save that
    // fails, or that finds the file changed elsewhere, is put to the person:
    // the draft keeps the edits if they leave anyway.
    if (
      doc.path &&
      account &&
      revision !== savedRevision &&
      !doc.leaveUnsaved
    ) {
      clearTimeout(autosaveTimer);
      const saved = await saveCloud(false, { quiet: true }).catch(() => false);
      if (doc !== target) return false;
      if (pending !== mutationTail || activeEditorInput()) continue;
      if (!saved && revision !== savedRevision) {
        const choice = await dialog(
          target.conflict
            ? conflictPrompt(target, { leaving: true })
            : saveFailedPrompt(target),
        );
        if (doc !== target) return false;
        if (choice === "leave") return true;
        if (choice === "retry") continue;
        if (choice === "overwrite" || choice === "restore") {
          await saveCloud(true, { force: true }).catch(fail);
          continue;
        }
        if (choice === "new") {
          await saveAsNewFile(target).catch(fail);
          continue;
        }
        return false;
      }
    }
    if (revision !== savedRevision && revision !== draftRevision) {
      const leave = await dialog({
        title: "Leave without saving?",
        body: el(
          "p",
          { class: "dialog-body" },
          "Your latest changes could not be saved on this device. Download a copy or save to Puter before leaving to keep them.",
        ),
        confirm: "Leave anyway",
        danger: true,
      });
      return leave && doc === target;
    }
    return true;
  }
}
// The save on the way out failed: stay, leave (the draft keeps the edits),
// or try again.
function saveFailedPrompt(target) {
  const kept = revision === draftRevision;
  const error = target.saveError;
  const reason = error?.offline
    ? " because you are offline"
    : error?.message
      ? ` (${String(error.message).replace(/\.$/, "")})`
      : "";
  return {
    title: "Your latest changes aren't saved to Puter",
    body: el(
      "p",
      { class: "dialog-body" },
      `Puter could not save “${target.name}”${reason}. ${
        kept
          ? "Your changes are kept on this device and listed under Your presentations if you leave."
          : "This device could not keep a copy of them either, so leaving now loses them."
      }`,
    ),
    actions: [
      { label: "Keep editing", value: "stay" },
      {
        label: kept ? "Leave" : "Leave without saving",
        value: "leave",
        kind: kept ? "secondary" : "danger",
      },
      { label: "Try again", value: "retry", kind: "primary" },
    ],
  };
}
async function newDeck(
  template = "blank",
  color = "studio",
  name = null,
  options = {},
) {
  await openDocument(
    () => ({
      // A new presentation starts on the Title Slide layout, or with a
      // blank slide when that is the chosen start.
      pres: createDeck(
        template === "blank" && startWith === "title" ? "title" : template,
        color,
      ),
      name:
        name ||
        (template === "blank"
          ? "Untitled presentation"
          : template === "pitch"
            ? "The pitch"
            : "The big idea"),
      color,
    }),
    options,
  );
}
// What the drive holds for the document's file, as of a read or a write: a
// save compares the file with it before writing over it. `item` is the file
// as the drive describes it, or a draft's record of one; `bytes` what was
// read from or written to it.
function noteRemote(target, item, bytes = null) {
  target.uid = item?.uid || item?.id || target.uid || null;
  target.remoteModified = cloud.modifiedMs(item);
  target.remoteSize = bytes?.byteLength || cloud.sizeOf(item);
  target.written =
    bytes && bytes.byteLength <= COMPARE_MAX_BYTES ? bytes : null;
}
// A file opened from elsewhere on the drive joins the library's list.
function rememberOpened(target) {
  recent.rememberRecent(target.owner, {
    path: target.path,
    name: `${target.name}.pptx`,
    uid: target.uid,
  });
}
// `pristine` marks the deck the app opened with: it gets a recovery draft
// only once it is edited, so opening the app never litters the library.
async function openDocument(load, { pristine = false } = {}) {
  if (signingOut) return false;
  const request = ++documentRequest;
  cancelFontCandidates();
  let candidate = null;
  try {
    const loaded = await load();
    if (request !== documentRequest) return false;
    const { pres, draft = null, color = "studio" } = loaded;
    candidate = pres;
    pendingFontCandidates.add(pres);
    await prepareDeckFonts(pres);
    if (request !== documentRequest) return false;
    const nextTheme = Object.hasOwn(THEMES, draft?.theme) ? draft.theme : color;
    const nextHistory = new History();
    await nextHistory.reset(pres, nextTheme);
    if (request !== documentRequest) return false;
    if (!(await leaveEditor()) || request !== documentRequest) return false;
    const { name, path = null, remote = null, bytes = null } = loaded;
    if (doc) disposeDocumentFonts(doc.pres);
    pendingFontCandidates.delete(pres);
    theme = nextTheme;
    doc = {
      pres,
      name: cleanName(name, {
        stripExtension: !draft,
        maxLength: path || draft ? Infinity : 180,
      }),
      path,
      id: draft?.id || uuid(),
      owner: draft?.owner || owner(),
      pristine,
      // Slide renders keyed by part name and compared by XML, so unchanged
      // slides survive edits, undo, and redo without re-rendering.
      previews: new Map(),
      // The file on the drive as this document last saw it (see noteRemote),
      // and what stands between the edits and it: a change made elsewhere
      // or a save that failed.
      uid: null,
      remoteModified: null,
      remoteSize: null,
      written: null,
      conflict: null,
      saveError: null,
    };
    if (path) noteRemote(doc, remote, bytes);
    index = 0;
    slideExtras = new Set();
    clearSelection();
    lastCoalesce = null;
    // A search and a current cell belong to the presentation they were set
    // in; another one starts with neither.
    tableCell = null;
    Object.assign(find, { query: "", matches: [], at: -1 });
    revision = 0;
    savedRevision = path && (!draft || draft.cloudSaved) ? 0 : -1;
    draftRevision = -1;
    history = nextHistory;
    view = "editor";
    retryDelay = 0;
    if (path && !draft) rememberOpened(doc);
    renderEditor();
    showEditorUrl();
    focusView();
    if ((!path || draft) && !pristine) await persistDraft().catch(warnStorage);
    return request === documentRequest;
  } catch (error) {
    if (request === documentRequest) throw error;
    return false;
  } finally {
    if (candidate && doc?.pres !== candidate) disposeDocumentFonts(candidate);
    pendingFontCandidates.delete(candidate);
  }
}
async function recover(draft) {
  if (signingOut) return;
  if (deletingDrafts.has(draft.id)) {
    toast("This draft is being deleted.");
    return;
  }
  const pending = { id: draft.id, request: ++documentRequest };
  pendingRecovery = pending;
  try {
    if (
      // Keep the stored path and the editor commit in order with cloud changes.
      await saveQueue.run(() => {
        if (pending.request !== documentRequest) return false;
        return openDocument(async () => {
          pending.request = documentRequest;
          const stored = await drafts.getDraft(draft.id);
          if (!stored || stored.owner !== owner())
            throw new Error("This recovery draft is no longer available.");
          return {
            pres: await restoreDeck(stored.bytes, { prepareFonts: false }),
            name: stored.name,
            path: stored.path,
            draft: stored,
            // The file as it was when these edits were made: a save finds
            // out whether it changed since.
            remote: {
              uid: stored.uid,
              modified: stored.remoteModified,
              size: stored.remoteSize,
            },
          };
        });
      })
    )
      toast("Draft recovered from this device.");
  } finally {
    if (pendingRecovery === pending) pendingRecovery = null;
  }
}
// Resolves to whether the file became the open presentation.
async function openCloud(file) {
  const pending = { name: file.name, path: file.path, owner: owner() };
  pendingCloudOpens.add(pending);
  try {
    return await openDocument(async () => {
      const request = documentRequest;
      pending.request = request;
      let bytes;
      for (;;) {
        const path = pending.path;
        try {
          // The file is looked up before its bytes are read: a look-up after
          // a slow read could describe a newer file than the one read, and
          // the first save would then write over that newer file unasked.
          pending.remote = await locateFile(pending, file.uid);
          bytes = await cloud.readFile(pending.path, { importing: true });
          break;
        } catch (error) {
          if (request !== documentRequest) return;
          if (path === pending.path) throw openError(error, pending);
        }
      }
      if (request !== documentRequest) return;
      pending.bytes = bytes;
      pending.pres = await parseDeck(bytes, { prepareFonts: false });
      return pending;
    });
  } finally {
    pendingCloudOpens.delete(pending);
  }
}
// The file `pending` names, as the drive describes it; its address becomes
// the one the drive reports. A file gone from its address but known by its id
// is followed to where it is now. Undefined when the file cannot be looked up
// (an SDK without the call, a look-up that failed): it opens without a
// baseline, and its saves write without checking, as they always did.
async function locateFile(pending, uid) {
  if (!cloud.canStat()) return undefined;
  const found = await cloud.stat(pending.path).catch(() => undefined);
  if (found === undefined) return undefined;
  if (!found && uid) {
    const moved = await cloud.statByUid(uid).catch(() => null);
    if (followable(moved)) {
      recent.moveRecent(pending.owner, pending.path, moved.path, moved.name);
      pending.name = moved.name || cloud.displayName(moved.path);
      pending.path = moved.path;
      return moved;
    }
  }
  if (!found)
    throw Object.assign(new Error("not found"), {
      code: "subject_does_not_exist",
    });
  if (cloud.isDirItem(found))
    throw new Error(`“${pending.name}” is a folder, not a presentation.`);
  // `~/Desktop/Deck.pptx` from a launch and `/nj/Desktop/Deck.pptx` from the
  // library are one file; it is known by the address the drive reports.
  if (
    found.path?.startsWith?.("/") &&
    cloud.displayName(found.path) === cloud.displayName(pending.path)
  )
    pending.path = found.path;
  return found;
}
// Found again by its id, a file is somewhere a document can follow it: not
// in the trash, where a deleted file waits under its bare id, and still named
// as a .pptx file, which a save would otherwise replace with one.
function followable(moved) {
  return (
    !!moved?.path &&
    !cloud.inTrash(moved.path) &&
    !cloud.isDirItem(moved) &&
    cloud.isPptxName(moved.path)
  );
}
// A failed open, in words that say what happened to the file.
function openError(error, file) {
  const name = cleanName(file.name || cloud.displayName(file.path));
  if (cloud.isNotFound(error)) {
    recent.forgetRecent(file.owner || owner(), file.path);
    return new Error(
      `“${name}” is no longer there. It may have been moved or deleted.`,
      { cause: error },
    );
  }
  const code = error?.code || error?.error?.code;
  if (code === "access_denied" || code === "forbidden")
    return new Error(`You don't have access to “${name}”.`, { cause: error });
  return error;
}
async function renameCloudPath(path, name) {
  const requestOwner = owner();
  const result = await cloud.renameFile(path, name);
  const renamed =
    result?.path ||
    path.slice(0, path.lastIndexOf("/") + 1) + cleanName(name) + ".pptx";
  recent.moveRecent(requestOwner, path, renamed, `${cleanName(name)}.pptx`);
  // The drive stamps the rename as a modification; it is not a change made
  // elsewhere, and the open presentation's next save must not take it for one.
  if (doc?.path === path && doc.remoteModified != null) {
    const target = doc;
    const item =
      cloud.modifiedMs(result) != null
        ? result
        : await cloud.stat(renamed).catch(() => null);
    const size = cloud.sizeOf(item);
    if (size == null || size === target.remoteSize)
      target.remoteModified = cloud.modifiedMs(item) ?? target.remoteModified;
  }
  for (const pending of pendingCloudOpens) {
    if (pending.owner === requestOwner && pending.path === path) {
      pending.path = renamed;
      pending.name = `${cleanName(name)}.pptx`;
    }
  }
  return renamed;
}
async function openPicker() {
  if (signingOut) return;
  const request = ++documentRequest;
  if (!account && !(await login())) return;
  if (request !== documentRequest) return;
  if (!cloud.canPickFiles())
    throw new Error(
      "Puter's file picker is unavailable. Reload and try again.",
    );
  const accountVersion = accountRequest;
  const file = await cloud.pickFile();
  if (
    file &&
    request === documentRequest &&
    accountVersion === accountRequest &&
    !signingOut
  )
    await openCloud(file);
}
function pickLocalFile(accept, handle) {
  const input = el("input", {
    type: "file",
    accept,
    hidden: true,
    onchange: run(async () => {
      const file = input.files[0];
      if (file) await handle(file);
    }),
  });
  // Keep the input alive until the picker finishes. A detached input can
  // disappear between opening the chooser and receiving the selected file.
  const remove = () => input.remove();
  input.addEventListener("change", remove, { once: true });
  input.addEventListener("cancel", remove, { once: true });
  document.body.append(input);
  try {
    input.click();
  } catch (error) {
    remove();
    throw error;
  }
}
function pickLocal() {
  pickLocalFile(".pptx", importFile);
}
function pickFont() {
  const target = doc;
  if (!target || readOnlyDocument()) return;
  const request = ++fontRequest;
  commitText();
  pickLocalFile(".ttf,.otf", (file) => embedLocalFont(file, target, request));
}
async function embedLocalFont(file, target, request) {
  const current = () => doc === target && request === fontRequest;
  try {
    if (!current() || readOnlyDocument()) return;
    validateImportSize(file.size, "font");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!current() || readOnlyDocument()) return;
    const info = readOpenTypeFont(bytes);
    const family = info.englishNames.get(1);
    if (!family) throw Error("This font has no supported family name.");
    if (
      !info.permissions.canEmbed ||
      !info.permissions.canEdit ||
      (info.permissions.bitmapOnly && info.hasOutlines)
    )
      throw Error("This font does not permit editable outline embedding.");
    if (
      ![...presentationFontFamilies(target.pres)].some(
        (name) => name.toLowerCase() === family.toLowerCase(),
      )
    )
      throw Error(`Use ${family} in the presentation before embedding it.`);
    // Validate glyph data with the browser before changing the package. This
    // face is never installed globally; the document pool owns the final faces.
    await new FontFace("Presentation font validation", bytes).load();
    if (!current() || readOnlyDocument()) return;
    const rights = el("input", { type: "checkbox", required: true });
    const pending = dialog({
      title: "Embed font",
      body: el(
        "form",
        { class: "dialog-body" },
        el("p", {}, `${family} — ${info.subfamily || "Regular"}`),
        el(
          "p",
          { class: "muted" },
          "The full font face will be saved in this PowerPoint file. Text keeps its authored font names.",
        ),
        el(
          "label",
          { class: "check-field" },
          rights,
          el("span", {}, "I have permission to embed this font."),
        ),
      ),
      confirm: "Embed",
    });
    const apply = rights.closest("dialog").querySelector(".primary");
    apply.disabled = true;
    rights.addEventListener("change", () => (apply.disabled = !rights.checked));
    rights.focus();
    if (!(await pending) || !rights.checked || !current()) return;
    await mutate(async () => {
      if (!current()) return SKIP_MUTATION;
      if (
        ![...presentationFontFamilies(target.pres)].some(
          (name) => name.toLowerCase() === family.toLowerCase(),
        )
      )
        throw Error(`Use ${family} in the presentation before embedding it.`);
      // A separate model keeps pending shows and failed edits on their original
      // document. Publication happens only after native encoding and size checks.
      const next = await P.loadPresentation(
        await P.savePresentation(target.pres),
      );
      const pkg = P._internalPackageOf(next);
      const before = pkg.parts.map((part) => [
        part.name,
        part.contentType,
        part.data,
      ]);
      P.embedFont(next, bytes, { embeddingAuthorized: true });
      if (
        pkg.parts.length === before.length &&
        pkg.parts.every(
          (part, i) =>
            part.name === before[i][0] &&
            part.contentType === before[i][1] &&
            part.data === before[i][2],
        )
      )
        return SKIP_MUTATION;
      validateImportSize((await P.savePresentation(next)).byteLength);
      if (!current()) return SKIP_MUTATION;
      target.pres = next;
    });
  } catch (error) {
    if (current()) throw error;
  }
}
async function importFile(file) {
  if (!/\.pptx$/i.test(file.name))
    throw new Error("Choose a PowerPoint (.pptx) file.");
  validateImportSize(file.size);
  if (
    await openDocument(async () => ({
      pres: await parseDeck(new Uint8Array(await file.arrayBuffer()), {
        prepareFonts: false,
      }),
      name: file.name,
    }))
  )
    toast(
      "Imported. Complex effects may look different in preview; original content is retained in the PPTX.",
    );
}
// Storage that fails is reported once, in plain words, for as long as it
// keeps failing, whatever the browser's own words for it; the save status
// goes on showing that the work is unsaved.
const STORAGE_WARNING =
  "Device storage is unavailable. Save to Puter or download a copy to keep your work.";
function warnStorage() {
  if (doc?.storageWarned) return;
  if (doc) doc.storageWarned = true;
  toast(STORAGE_WARNING);
}
async function persistDraft() {
  if (!doc) return;
  if (doc.pristine) {
    if (untouchedLanding()) {
      updateSaveStatus();
      return;
    }
    doc.pristine = false;
  }
  const snapshot = doc,
    rev = revision;
  try {
    await drafts.saveDraft({
      id: snapshot.id,
      owner: snapshot.owner,
      name: snapshot.name,
      path: snapshot.path,
      cloudSaved: savedRevision === rev,
      uid: snapshot.uid,
      remoteModified: snapshot.remoteModified,
      remoteSize: snapshot.remoteSize,
      theme,
      // The undo history already holds this revision serialized; reuse it
      // instead of serializing the whole package a second time per edit.
      bytes: history.bytes,
    });
    if (doc === snapshot) draftRevision = rev;
    snapshot.storageWarned = false;
  } finally {
    if (doc === snapshot) updateSaveStatus();
  }
}
// `delay` is given by a retry; an edit starts the retries over.
function scheduleSave(delay) {
  clearTimeout(autosaveTimer);
  if (delay == null) retryDelay = 0;
  const target = doc;
  autosaveTimer = setTimeout(() => {
    // A file that changed elsewhere waits for the person's decision.
    if (doc !== target || !target?.path || !account || target.conflict) return;
    // The online listener saves once the connection returns.
    if (navigator.onLine === false) {
      target.saveError = { message: "You are offline.", offline: true };
      updateSaveStatus();
      return;
    }
    saveCloud(false).catch(fail);
  }, delay ?? AUTOSAVE_MS);
}
// `onError` hears an edit that failed, in place of the error toast;
// `onApplied(before, after)` hears the history's snapshots on either side of
// an edit that was recorded. `takesBack` is the snapshot of an edit this one
// undoes: while it is still the latest, both leave the history. `amends` is
// the snapshot of an edit this one finishes: while it is still the latest,
// the two are one undo step.
function mutate(
  fn,
  {
    coalesce = null,
    onError = fail,
    onApplied = null,
    takesBack = null,
    amends = null,
  } = {},
) {
  if (!doc || readOnlyDocument()) return Promise.resolve(false);
  if (review.blocksEdits()) {
    review.blockedEdit();
    return Promise.resolve(false);
  }
  pendingMutations++;
  const active = doc;
  // Resolves to whether the edit was applied: a control that committed a
  // value resets when nothing changed.
  const action = mutationTail
    .then(async () => {
      if (doc !== active || readOnlyDocument()) return false;
      const previous = active.pres;
      try {
        if ((await fn()) === SKIP_MUTATION) return false;
        // Formatting given to a master's or layout's placeholder text
        // becomes the style slides inherit.
        if (masterView.active) masterView.afterEdit();
        await prepareDeckFonts(active.pres, { reuseFrom: previous });
        if (active.pres !== previous) disposeDocumentFonts(previous);
        if (doc !== active) {
          disposeDocumentFonts(active.pres);
          return false;
        }
        // The slide shows the edit first; the snapshot for the history and
        // the draft, a serialization of the whole file, follows it.
        refreshMatches();
        if (readOnlyDocument()) renderEditor();
        else {
          document
            .querySelector("#font-load-notice")
            ?.replaceWith(fontLoadNotice());
          renderSlideArea();
          renderInspector();
        }
        // Color pickers fire a change per adjustment; merge a burst of edits
        // to the same property into one undo step.
        const merge =
          (amends && history.bytes === amends) ||
          (coalesce &&
            lastCoalesce?.key === coalesce &&
            Date.now() - lastCoalesce.time < COALESCE_WINDOW);
        const before = history.bytes;
        if (takesBack && history.bytes === takesBack && history.past.length)
          history.drop(doc.pres);
        else if (merge) await history.amend(doc.pres, theme);
        else await history.capture(doc.pres, theme);
        onApplied?.(before, history.bytes);
        lastCoalesce = coalesce ? { key: coalesce, time: Date.now() } : null;
        revision++;
        // What is worked out once per revision (the accessibility status)
        // catches up with the edit.
        syncToolbar();
        await persistDraft().catch(warnStorage);
        updateHistoryButtons();
        scheduleSave();
        return true;
      } catch (e) {
        onError(e);
        await restoreSnapshot();
        return false;
      }
    })
    .finally(() => pendingMutations--);
  mutationTail = action;
  return action;
}
// An edit that fails part-way leaves the presentation between two states:
// what it had done is neither shown, nor in the history, nor in the draft,
// and the next edit would carry it along as its own. The last snapshot, the
// state everything else still shows, comes back.
async function restoreSnapshot() {
  const active = doc;
  if (!active || !history.bytes) return;
  try {
    const pres = await P.loadPresentation(history.bytes);
    if (doc !== active) return;
    const previous = active.pres;
    await prepareDeckFonts(pres, { reuseFrom: previous });
    if (doc !== active) {
      disposeDocumentFonts(pres);
      return;
    }
    active.pres = pres;
    disposeDocumentFonts(previous);
    renderSlideArea();
    renderInspector();
  } catch {}
}
function mutateSlide(target, fn, options) {
  const part = P.getSlidePartName(target);
  return mutate(() => {
    const targetSlide = slideByPart(part);
    return targetSlide ? fn(targetSlide) : SKIP_MUTATION;
  }, options);
}
function mutateShape(shape, fn, options) {
  const id = P.getShapeId(shape);
  return mutateSlide(
    P.getShapeSlide(shape),
    (targetSlide) => {
      const target = P.findShapeById(targetSlide, id);
      return target ? fn(target, targetSlide) : SKIP_MUTATION;
    },
    options,
  );
}
const coalesceKey = (property, target, shape = null) =>
  [property, P.getSlidePartName(target), shape && P.getShapeId(shape)].join(
    ":",
  );
// Text still open in the canvas text editor is held there until the editor
// closes, and a menu or the toolbar keeps the editor open while it is used.
// Work that reads the presentation commits it first, and so does anything
// that adds, removes, or copies an object or a slide: the editor would
// otherwise stand over the slide beside what has just arrived, and a copy
// would carry the text from before the typing.
function commitText() {
  richEditor?.close();
  // A table cell's editor keeps its text as it loses the focus.
  document.querySelector("#slide-canvas textarea.inline-editor")?.blur();
}
async function settled() {
  commitText();
  await mutationTail;
}
// Resolves to whether the open presentation's latest revision is in Puter.
// `force` writes over a file that changed elsewhere (the person chose to);
// `quiet` leaves a conflict for the caller to put to the person.
async function saveCloud(
  explicit = true,
  { force = false, quiet = false } = {},
) {
  const target = doc;
  await settled();
  if (!target || doc !== target) return false;
  if (!account) {
    if (!explicit) return false;
    if (!(await login())) return false;
  }
  const accountVersion = accountRequest;
  const saved = await saveQueue.run(async () => {
    // An autosave that waited behind a save of the same revision has nothing
    // left to upload.
    if (doc !== target) return false;
    if (!explicit && (!target.path || savedRevision === revision))
      return savedRevision === revision;
    savingDocument = target;
    updateSaveStatus();
    const rev = revision;
    const firstSave = !target.path;
    try {
      if (!firstSave && !force) {
        // Each check answers afresh; one that fails leaves no stale answer.
        target.conflict = null;
        const conflict = await remoteConflict(target);
        if (conflict) {
          target.conflict = conflict;
          if (!quiet) queueMicrotask(() => askAboutConflict(target));
          return false;
        }
      }
      const bytes = await P.savePresentation(target.pres);
      const file = await cloud.saveFile(bytes, target.name, target.path);
      target.path = file.path || target.path;
      if (!target.path)
        throw new Error("Puter did not return the saved file location.");
      if (firstSave)
        target.name = cleanName(file.name || target.path.split("/").pop(), {
          maxLength: Infinity,
        });
      // A write that reports no time is looked up, or the next save could not
      // tell whether the file changed elsewhere since.
      const written =
        cloud.modifiedMs(file) == null && cloud.canStat()
          ? { ...(await cloud.stat(target.path).catch(() => null)), ...file }
          : file;
      noteRemote(target, written, bytes);
      target.conflict = null;
      target.saveError = null;
      if (doc === target) {
        retryDelay = 0;
        if (firstSave) showDocumentName(target.name);
        target.owner = owner();
        savedRevision = rev;
        const recovered = await persistDraft().then(
          () => true,
          () => false,
        );
        if (explicit)
          toast(
            recovered
              ? "Saved to your Puter cloud."
              : "Saved to your Puter cloud. Local recovery is unavailable.",
          );
      } else if (firstSave)
        await drafts
          .linkCloudFile(target.id, target.owner, target.path, target.name)
          .catch(warnStorage);
      return true;
    } catch (error) {
      // The edits stay dirty and on this device. A failure that passes (the
      // connection dropped, say) must not need another edit to be tried
      // again; one that lasts is not helped by sending the whole file every
      // few seconds, so the pauses grow.
      target.saveError = {
        message:
          error?.message || error?.msg || "Puter could not save the file.",
        offline: navigator.onLine === false,
      };
      if (doc === target && target.path && account) {
        retryDelay = Math.min(
          retryDelay ? retryDelay * 2 : RETRY_MS,
          RETRY_MAX_MS,
        );
        scheduleSave(retryDelay);
      }
      if (explicit) throw error;
      return false;
    } finally {
      savingDocument = null;
      if (doc === target) updateSaveStatus();
    }
  });
  if (saved && view === "home" && accountVersion === accountRequest)
    await loadLibrary();
  return saved === true;
}
// Is the file still as this document last saw it? "changed" when it was
// written elsewhere since (another tab or device), "missing" when it is gone
// from its address and cannot be followed, and null when the save may go
// ahead. A file moved or renamed elsewhere keeps its id, and the document
// follows it. With no baseline (an SDK that cannot look files up, a look-up
// that failed at open) there is nothing to compare, and the save goes ahead
// as it always did. A look-up that fails now fails the save, which retries.
async function remoteConflict(target) {
  if (!cloud.canStat() || target.remoteModified == null) return null;
  let found = await cloud.stat(target.path);
  if (!found) {
    const moved = await cloud.statByUid(target.uid).catch(() => null);
    if (!followable(moved)) return "missing";
    await followFile(target, moved);
    found = moved;
  }
  const modified = cloud.modifiedMs(found);
  const size = cloud.sizeOf(found);
  const resized =
    target.remoteSize != null && size != null && size !== target.remoteSize;
  const newer = modified != null && modified > target.remoteModified;
  // The drive stamps a rename or a move as a modification, though the bytes
  // stay the same: still the ones read or written here, the new time is the
  // baseline from now on, not a change made elsewhere.
  if (newer && !resized && (await holdsLastWrite(target, found)) === true) {
    target.remoteModified = modified;
    return null;
  }
  return newer || resized ? "changed" : null;
}
// Does the file hold the bytes this document last read or wrote? Null when
// that cannot be told cheaply.
async function holdsLastWrite(target, found) {
  const mine = target.written;
  if (!mine || cloud.sizeOf(found) !== mine.byteLength) return null;
  try {
    const theirs = await cloud.readFile(target.path);
    return (
      theirs.byteLength === mine.byteLength &&
      theirs.every((byte, i) => byte === mine[i])
    );
  } catch {
    return null;
  }
}
// The file was moved or renamed elsewhere: the document, its drafts, and the
// library's records follow it to where it is now.
async function followFile(target, moved) {
  const from = target.path;
  target.path = moved.path;
  target.name = cleanName(moved.name || cloud.displayName(moved.path), {
    maxLength: Infinity,
  });
  recent.moveRecent(target.owner, from, target.path, `${target.name}.pptx`);
  if (cloud.sizeOf(moved) === target.remoteSize)
    target.remoteModified = cloud.modifiedMs(moved) ?? target.remoteModified;
  if (doc === target) {
    showDocumentName(target.name);
    toast(
      `“${target.name}” was moved or renamed. It is saved where it is now.`,
    );
  }
  await drafts
    .renameCloudFile(target.owner, from, target.path, target.name)
    .catch(warnStorage);
}
// The file changed, moved, or went away since this presentation was opened:
// the person decides what becomes of the two versions. Autosave holds off
// until then; Save asks again.
let conflictAsked = null;
async function askAboutConflict(target) {
  if (doc !== target || !target.conflict || conflictAsked === target) return;
  conflictAsked = target;
  try {
    const choice = await dialog(conflictPrompt(target));
    if (doc !== target) return;
    if (choice === "overwrite" || choice === "restore")
      await saveCloud(true, { force: true });
    else if (choice === "reload") await reloadFromCloud(target);
    else if (choice === "copy") await saveCopy();
    else if (choice === "new") await saveAsNewFile(target);
  } catch (error) {
    fail(error);
  } finally {
    if (conflictAsked === target) conflictAsked = null;
  }
}
function conflictPrompt(target, { leaving = false } = {}) {
  const kept = revision === draftRevision;
  const keptNote = kept
    ? " Your changes are kept on this device."
    : " This device could not keep a copy of your changes.";
  const stay = leaving ? [{ label: "Keep editing", value: "stay" }] : [];
  const leave = leaving
    ? [
        {
          label: kept ? "Leave" : "Leave without saving",
          value: "leave",
          kind: kept ? "secondary" : "danger",
        },
      ]
    : [];
  if (target.conflict === "missing")
    return {
      title: "This presentation was moved or deleted",
      body: el(
        "p",
        { class: "dialog-body" },
        `“${target.name}” is no longer where it was in your Puter, and could not be found elsewhere. Your changes are not saved there.${keptNote}`,
      ),
      actions: [
        ...stay,
        ...leave,
        { label: "Put it back", value: "restore" },
        { label: "Save as a new file", value: "new", kind: "primary" },
      ],
    };
  return {
    title: "This presentation changed elsewhere",
    body: el(
      "p",
      { class: "dialog-body" },
      `“${target.name}” was saved from another tab or device since you opened it. Saving your version would replace those changes.${keptNote}`,
    ),
    actions: [
      ...stay,
      ...leave,
      ...(leaving
        ? []
        : [
            { label: "Open their version", value: "reload" },
            { label: "Save mine as a copy", value: "copy" },
          ]),
      { label: "Replace with mine", value: "overwrite", kind: "danger" },
    ],
  };
}
// Their version replaces this one, whose edits are discarded with its draft.
async function reloadFromCloud(target) {
  const { id, owner: draftOwner, path, name, uid } = target;
  target.leaveUnsaved = true;
  try {
    if (await openCloud({ path, name: `${name}.pptx`, uid })) {
      if (draftOwner === owner())
        await drafts.deleteDraft(id).catch(warnStorage);
      toast(`Opened the latest version of “${name}”.`);
    }
  } finally {
    target.leaveUnsaved = false;
  }
}
// The file is gone: the presentation becomes a new one in the Presentations
// folder, and its first save puts it there.
async function saveAsNewFile(target) {
  const from = target.path;
  target.path = null;
  target.uid = null;
  target.remoteModified = null;
  target.conflict = null;
  savedRevision = -1;
  await drafts.detachCloudFile(target.owner, from).catch(warnStorage);
  recent.forgetRecent(target.owner, from);
  await saveCloud(true);
}
// A copy of the presentation under a new name in Puter, which then becomes
// the open presentation; the original stays as it was last saved. Inside the
// Puter desktop, Puter's own Save dialog chooses the folder as well as the
// name; elsewhere the copy goes to the Presentations folder.
async function saveCopy() {
  const target = doc;
  if (!target) return;
  const useDialog = cloud.isApp() && cloud.canSaveFiles();
  const name = useDialog
    ? `${target.name} copy`
    : await promptName("Save a copy", `${target.name} copy`, null, {
        keep: true,
      });
  if (!name?.trim() || doc !== target) return;
  if (!account && !(await login())) return;
  if (doc !== target) return;
  await settled();
  if (doc !== target) return;
  const rev = revision;
  const file = await saveQueue.run(async () => {
    if (doc !== target) return null;
    const bytes = await P.savePresentation(target.pres);
    // Puter's dialog writes the file itself and never settles when it is
    // closed, so it is not kept in the queue that later saves wait on.
    if (useDialog) return { forDialog: bytes };
    // A typed ".pptx" is not part of the name; saveFile adds the extension.
    return cloud.saveFile(bytes, cleanName(name), null);
  });
  const saved = file?.forDialog
    ? await cloud.saveFileAs(
        new Blob([file.forDialog], { type: MIME }),
        `${cleanName(name)}.pptx`,
      )
    : file;
  if (!saved || doc !== target) return;
  if (!saved.path)
    throw new Error("Puter did not return the saved file location.");
  const copyName = cleanName(saved.name || saved.path.split("/").pop(), {
    maxLength: Infinity,
  });
  // The edits go with the copy: the original is not saved on the way out,
  // and its draft, holding nothing the copy does not, goes once the copy is
  // open.
  const unchanged = revision === rev;
  const { id, owner: draftOwner } = target;
  target.leaveUnsaved = true;
  try {
    if (
      !(await openCloud({ name: copyName, path: saved.path, uid: saved.uid }))
    )
      return;
  } finally {
    target.leaveUnsaved = false;
  }
  if (unchanged && draftOwner === owner())
    await drafts.deleteDraft(id).catch(warnStorage);
  if (doc?.path === saved.path || (saved.uid && doc?.uid === saved.uid))
    toast(`Saved a copy as ${copyName}.`);
  if (view === "home") await loadLibrary();
}
// The tab and, inside the Puter desktop, the window are titled after the
// open presentation, and after the app in the library.
function setTitle(name) {
  document.title = name ? `${name} | Presentation` : "Presentation";
  cloud.setWindowTitle(name || "Presentation");
}
// The header's title button is named by the name it shows, and says on
// hover what a press does; the window's title follows the name too.
const renameHint = (name) => `Rename “${name}”`;
function showDocumentName(name) {
  const title = document.querySelector(".document-title");
  if (title) {
    title.querySelector("span").textContent = name;
    title.title = renameHint(name);
  }
  setTitle(name);
}
// The status is a live region; it is rewritten only when it changes, so
// a screen reader hears each state once rather than after every edit.
function updateSaveStatus() {
  const status = document.querySelector("#save-status");
  if (!status || !doc) return;
  const busy = savingDocument === doc;
  const cloudSaved = savedRevision === revision;
  const onDevice = draftRevision === revision;
  // What keeps the edits of a presentation in Puter from reaching it.
  const problem =
    !busy && !cloudSaved && doc.path
      ? doc.conflict ||
        (doc.saveError?.offline ? "offline" : doc.saveError && "error")
      : null;
  const [state, glyph, label] = busy
    ? ["saving", "Cloud", "Saving…"]
    : cloudSaved
      ? ["cloud", "Check", "Saved to Puter"]
      : problem === "changed"
        ? ["conflict", "CircleAlert", "Changed elsewhere"]
        : problem === "missing"
          ? ["conflict", "CircleAlert", "Moved or deleted"]
          : problem === "offline"
            ? [
                "offline",
                "CloudOff",
                onDevice ? "Offline · saved on this device" : "Offline",
              ]
            : problem === "error"
              ? [
                  "error",
                  "CircleAlert",
                  onDevice
                    ? "Not saved to Puter · on this device"
                    : "Not saved",
                ]
              : onDevice
                ? ["device", "Monitor", "Saved on this device"]
                : untouchedLanding()
                  ? ["new", "CloudOff", "Not saved yet"]
                  : ["unsaved", "CloudOff", "Unsaved changes"];
  const hint =
    problem === "changed"
      ? "This presentation was saved from another tab or device since you opened it. Save to choose which version to keep."
      : problem === "missing"
        ? "This presentation is no longer where it was in your Puter. Save to choose where it goes."
        : problem === "offline"
          ? "You are offline. Changes save to Puter when you reconnect."
          : problem === "error"
            ? `Puter could not save: ${doc.saveError.message} Trying again shortly.`
            : doc.path ||
              "Save to Puter to access this presentation on other devices.";
  if (
    status.dataset.state === state &&
    status.title === hint &&
    status.textContent === label
  )
    return;
  status.dataset.state = state;
  status.title = hint;
  status.replaceChildren(icon(glyph, 14), el("span", {}, label));
}
async function downloadDeck() {
  const target = doc;
  await settled();
  if (!target) return;
  const name = target.name;
  reportExport(
    await cloud.download(await P.savePresentation(target.pres), name),
    "PowerPoint file downloaded.",
  );
}
// Inside the Puter desktop a file the app produces is saved through Puter's
// Save dialog rather than downloaded; the message says which happened, and
// nothing when the dialog was closed.
function reportExport(result, downloaded) {
  if (result?.saved)
    toast(`Saved ${result.saved.name || "the file"} to your Puter.`);
  else if (!result?.cancelled) toast(downloaded);
}
/* ---------- Slide size ---------- */
const SLIDE_SIZES = [
  ["16:9", "Widescreen (16:9)", 12192000, 6858000, "screen16x9"],
  ["16:10", "Widescreen (16:10)", 12192000, 7620000, "screen16x10"],
  ["4:3", "Standard (4:3)", 9144000, 6858000, "screen4x3"],
];
function aspectLabel(size = currentSize()) {
  const ratio = size.cx / size.cy;
  const known = SLIDE_SIZES.find(
    ([, , w, h]) => Math.abs(ratio - w / h) < 0.02,
  );
  return known ? known[0] : "Custom";
}
function updateAspectLabel() {
  const label = document.querySelector(".zoom-control > span");
  if (label) label.textContent = aspectLabel();
}
// A new slide size. When asked, everything on every slide scales to fit,
// keeping its proportions, and sits centered in whatever room is left over.
async function slideSizeDialog(preset = null) {
  const target = doc;
  const current = aspectLabel();
  const choice = el(
    "select",
    { class: "input", "aria-label": "Slide size", autofocus: true },
    ...SLIDE_SIZES.map(([key, label]) => el("option", { value: key }, label)),
  );
  if (current === "Custom")
    choice.prepend(el("option", { value: "Custom" }, "Custom (current)"));
  choice.value = typeof preset === "string" ? preset : current;
  const scale = el("input", { type: "checkbox", checked: true });
  const ok = await dialog({
    title: "Slide size",
    body: el(
      "form",
      { class: "dialog-body" },
      el("label", {}, "Size", choice),
      el(
        "label",
        { class: "check-field" },
        scale,
        el("span", {}, "Scale the slides' content to the new size"),
      ),
      el(
        "p",
        { class: "muted" },
        "Widescreen slides are 13.33 by 7.5 inches; standard slides are 10 by 7.5.",
      ),
    ),
    confirm: "Apply",
  });
  if (!ok || doc !== target) return;
  const size = SLIDE_SIZES.find(([key]) => key === choice.value);
  if (!size || choice.value === current) return;
  const [, , width, height, type] = size;
  const fit = scale.checked;
  mutate(() => {
    const before = currentSize();
    P.setSlideSize(doc.pres, { width, height, type });
    // Masters and layouts stretch to the new size, so new slides fill it;
    // slides placed by them have taken their places first.
    const stretchTemplates = () =>
      P.scaleTemplates(doc.pres, width / before.cx, height / before.cy);
    if (!fit) return stretchTemplates();
    const k = Math.min(width / before.cx, height / before.cy);
    const dx = (width - before.cx * k) / 2,
      dy = (height - before.cy * k) / 2;
    const scaled = (b) => ({
      x: Math.round(b.x * k + dx),
      y: Math.round(b.y * k + dy),
      w: Math.round(b.w * k),
      h: Math.round(b.h * k),
    });
    const scaleText = (size) => Math.max(1, Math.round(size * k * 2) / 2);
    for (const s of P.getSlides(doc.pres)) {
      const parents = groupParents(s);
      for (const obj of P.getSlideShapes(s)) {
        // A grouped shape moves and shrinks with its group; its text does
        // not, so only the text is scaled below.
        if (!parents.has(P.getShapeId(obj))) {
          // A placeholder that takes its position from the layout is given
          // the one it shows, scaled, since the layout stays as it was.
          const b = slideBounds(doc.pres, obj);
          if (!b) continue;
          const next = scaled(b);
          P.setShapeBounds(obj, next);
          if (isTable(obj)) {
            fitTableGrid(obj, next);
            for (const row of P.getTableCells(obj))
              for (const cell of row) {
                const size = cellFormat(cell).size;
                if (size)
                  P.setTableCellTextFormat(cell, { size: scaleText(size) });
              }
            continue;
          }
        }
        if (!hasTextBody(obj)) continue;
        // A run without a size of its own inherits one; it is written out
        // scaled, since the layout it came from stays as it was.
        for (let pi = 0; pi < P.getShapeParagraphCount(obj); pi++)
          for (let ri = 0; ri < P.getShapeRunCount(obj, pi); ri++) {
            let size = P.getShapeRunFormat(obj, pi, ri)?.size;
            if (!size) {
              try {
                size = P.getShapeRunFormatEffective(
                  doc.pres,
                  obj,
                  pi,
                  ri,
                )?.size;
              } catch {}
            }
            if (size)
              P.setShapeRunFormat(obj, pi, ri, { size: scaleText(size) });
          }
      }
    }
    stretchTemplates();
  });
}
// Slides as pictures: the current slide as a PNG, or every visible slide as
// PNGs in a ZIP. Each is drawn from the same render the canvas shows, at
// twice the size of the slide at 100%.
const IMAGE_SCALE = 2;
async function rasterizeSlide(pres, s, previews) {
  const size = P.getSlideSize(pres) || { width: 12192000, height: 6858000 };
  const width = Math.round((size.width / 914400) * 96 * IMAGE_SCALE);
  const height = Math.round((size.height / 914400) * 96 * IMAGE_SCALE);
  const image = new Image();
  image.decoding = "async";
  image.src = cachedPreview(previews, pres, s);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("The slide could not be drawn as an image.");
  return blob;
}
async function exportImages(all) {
  const target = doc;
  await settled();
  if (!target || doc !== target) return;
  const slides = all
    ? P.getSlides(doc.pres).filter((s) => !P.isSlideHidden(s))
    : [slide()];
  if (!slides.length) {
    toast("There are no visible slides to export.");
    return;
  }
  const name = cleanName(target.name, { maxLength: Infinity });
  if (!all) {
    const blob = await rasterizeSlide(target.pres, slides[0], target.previews);
    if (doc !== target) return;
    reportExport(
      await cloud.downloadBlob(blob, `${name} - Slide ${index + 1}.png`),
      "Slide downloaded as a PNG image.",
    );
    return;
  }
  // Drawing every slide takes a moment on a long deck; say so up front.
  toast(`Preparing ${slides.length} slides as PNG images…`);
  const files = {};
  const digits = String(slides.length).length;
  for (const [i, s] of slides.entries()) {
    const blob = await rasterizeSlide(target.pres, s, target.previews);
    if (doc !== target) return;
    files[`${name} - Slide ${String(i + 1).padStart(digits, "0")}.png`] =
      new Uint8Array(await blob.arrayBuffer());
  }
  const zip = zipSync(files, { level: 0 });
  reportExport(
    await cloud.downloadBlob(
      new Blob([zip], { type: "application/zip" }),
      `${name} - slides.zip`,
    ),
    `${slides.length} slides downloaded as PNG images.`,
  );
}
async function renameDoc() {
  const target = doc;
  const name = await promptName("Rename presentation", target.name);
  if (!nameChanged(name, target.name)) return;
  await mutationTail;
  return saveQueue.run(async () => {
    if (doc !== target || !nameChanged(name, target.name)) return;
    const path = target.path;
    if (path) {
      target.path = await renameCloudPath(path, name);
    }
    target.name = cleanName(name);
    try {
      if (doc !== target) return;
      revision++;
      await mutationTail;
      if (doc !== target) return;
      await persistDraft().catch(warnStorage);
      if (doc !== target) return;
      showDocumentName(target.name);
      scheduleSave();
    } finally {
      if (path)
        await drafts
          .renameCloudFile(target.owner, path, target.path, target.name)
          .catch(warnStorage);
      // The library may already be showing; it lists the new name.
      if (path && view === "home") await loadLibrary();
    }
  });
}

function fontLoadNotice() {
  const { errors } = documentFontStatus(doc.pres);
  return el(
    "div",
    {
      id: "font-load-notice",
      class: "font-load-notice",
      hidden: !errors.length,
    },
    errors.length
      ? el(
          "details",
          {},
          el(
            "summary",
            {},
            "Some embedded fonts could not load. Text may look different.",
          ),
          el(
            "ul",
            {},
            ...errors.map((error) =>
              el(
                "li",
                {},
                `${error.family || "Font resources"}: ${error.message}`,
              ),
            ),
          ),
        )
      : null,
  );
}
function renderReadOnly() {
  clearTimeout(fileDateTimer);
  clearThumbnailQueue();
  canvasObserver?.disconnect();
  assistant?.destroy();
  assistant = null;
  dismissMenuWithin(app);
  view = "viewer";
  const slides = P.getSlides(doc.pres);
  const image = el("img", { class: "slide-image", alt: "" });
  const counter = el("span", { role: "status", "aria-live": "polite" });
  const previous = button(
    "Previous slide",
    "ChevronLeft",
    () => show(index - 1),
    "secondary",
  );
  const next = button(
    "Next slide",
    "ChevronRight",
    () => show(index + 1),
    "secondary",
  );
  function show(position) {
    index = Math.max(0, Math.min(slides.length - 1, position));
    const part = P.getSlidePartName(slides[index]);
    if (!doc.previews.has(part)) doc.previews.set(part, { src: null });
    image.src = cachedPreview(doc.previews, doc.pres, slides[index]);
    image.alt = slideDescription(slides[index], doc.pres);
    counter.textContent = `Slide ${index + 1} of ${slides.length}`;
    const focused = document.activeElement;
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    if (
      (focused === previous && previous.disabled) ||
      (focused === next && next.disabled)
    )
      document.querySelector("#main")?.focus({ preventScroll: true });
  }
  app.replaceChildren(
    el(
      "div",
      {
        class: "editor font-viewer",
        onkeydown(e) {
          if (
            e.defaultPrevented ||
            e.ctrlKey ||
            e.metaKey ||
            e.altKey ||
            e.shiftKey
          )
            return;
          const direction = ["ArrowLeft", "PageUp"].includes(e.key)
            ? -1
            : ["ArrowRight", "PageDown"].includes(e.key)
              ? 1
              : 0;
          if (direction) {
            e.preventDefault();
            show(index + direction);
          }
        },
      },
      el(
        "header",
        { class: "editor-header" },
        el(
          "div",
          { class: "font-viewer-actions" },
          iconButton(
            "Back to presentations",
            "ArrowLeft",
            run(async () => {
              if (await leaveEditor()) await home();
            }),
          ),
          el("h1", { class: "font-viewer-title" }, doc.name),
          button(
            "Download PowerPoint",
            "Download",
            run(downloadDeck),
            "secondary",
          ),
          button(
            "Print",
            "Printer",
            run(() => fileTools.openPrintDialog()),
            "secondary",
          ),
          button("Present", "Play", run(present)),
        ),
      ),
      el(
        "p",
        { class: "font-viewer-message" },
        "View only. An embedded font permits viewing and printing, but not editing this presentation.",
      ),
      fontLoadNotice(),
      el(
        "main",
        { id: "main", class: "font-viewer-stage", tabindex: -1 },
        image,
      ),
      el("footer", { class: "font-viewer-actions" }, previous, counter, next),
    ),
  );
  show(index);
  setTitle(doc.name);
}
function renderEditor() {
  if (readOnlyDocument()) return renderReadOnly();
  clearTimeout(fileDateTimer);
  view = "editor";
  dismissMenuWithin(app);
  app.replaceChildren(
    el(
      "div",
      {
        class: `editor ${chrome.formatPane ? "" : "hide-inspector"} ${chrome.thumbnails ? "" : "hide-slides"} ${chrome.notes ? "" : "hide-notes"}`,
        "data-view": editorView,
      },
      editorTopbar(),
      fontLoadNotice(),
      editorRibbon(),
      findBar(),
      el(
        "div",
        { class: "editor-split" },
        el(
          "div",
          { class: "editor-body" },
          el(
            "aside",
            {
              class: "slide-sidebar",
              id: "slide-navigator",
              "aria-label": "Slide navigator",
            },
            el(
              "div",
              { class: "panel-heading sr-only" },
              el("span", {}, "Slides"),
              el("span", { id: "slide-count", class: "muted" }),
            ),
            el("div", {
              id: "slide-list",
              class: "slide-list",
              oncontextmenu: (e) => {
                // The empty space under the thumbnails offers what a slide
                // would: a new slide, and pasting one.
                if (e.target.closest(".slide-item")) return;
                e.preventDefault();
                openMenu({
                  x: e.clientX,
                  y: e.clientY,
                  contextual: true,
                  label: "Slides",
                  items: [
                    {
                      label: "New Slide",
                      icon: "o:newSlide",
                      shortcut: IS_MAC ? "⌘+Shift+N" : "Ctrl+M",
                      onSelect: () => addSlideAfter(slide()),
                    },
                  ],
                });
              },
            }),
            el("div", {
              class: "pane-resize",
              role: "separator",
              "aria-orientation": "vertical",
              "aria-label": "Resize slide thumbnails",
              "data-pane": "thumbnails",
              tabindex: 0,
              onpointerdown: (e) => resizePane(e, "thumbnails"),
              onkeydown: (e) => resizePaneKey(e, "thumbnails"),
            }),
          ),
          el(
            "main",
            { id: "main", class: "workspace", tabindex: -1 },
            el(
              "div",
              {
                class: "canvas-area",
                id: "canvas-area",
                onwheel: (e) => wheelZoom(e),
              },
              el(
                "div",
                { class: "canvas-stage" },
                el(
                  "div",
                  { class: "canvas-label", "aria-hidden": "true" },
                  el("span", { id: "slide-label" }),
                ),
                el("div", { class: "slide-canvas", id: "slide-canvas" }),
              ),
            ),
            el(
              "div",
              { class: "notes-area" },
              el("div", {
                class: "pane-resize horizontal",
                role: "separator",
                "aria-orientation": "horizontal",
                "aria-label": "Resize notes",
                "data-pane": "notes",
                tabindex: 0,
                onpointerdown: (e) => resizePane(e, "notes"),
                onkeydown: (e) => resizePaneKey(e, "notes"),
              }),
              el(
                "label",
                { for: "speaker-notes", class: "sr-only" },
                "Speaker notes",
              ),
              el("textarea", {
                id: "speaker-notes",
                placeholder: "Click to add notes",
                onchange: (e) => {
                  const target = slide(),
                    value = e.target.value;
                  mutateSlide(target, (target) =>
                    P.setSlideNotes(target, value),
                  );
                },
              }),
            ),
          ),
          // Slide Sorter and Notes Page take the place of the panes.
          el("section", { id: "view-host", class: "view-host" }),
          el("aside", {
            class: "inspector",
            id: "inspector",
            "aria-label": "Format panel",
            tabindex: -1,
          }),
        ),
      ),
      statusBar(),
    ),
  );
  mountAssistant();
  review.mount();
  updateSaveStatus();
  renderSlideArea();
  renderInspector();
  updateHistoryButtons();
  setTitle(doc.name);
  updatePanelToggles();
  canvasObserver?.disconnect();
  canvasObserver = new ResizeObserver(() => fitCanvas());
  canvasObserver.observe(document.querySelector("#canvas-area"));
  fitCanvas();
  applyPaneSizes();
  views.mounted();
}
// The title bar: the way back to the library, the quick access commands
// (save, undo, redo), the menu bar, the presentation's name with its save
// status, and on the right a command search and the presentation's actions.
// On a phone the menu bar gives way to the File options button, whose menu
// carries the other menus.
function editorTopbar() {
  const menubar = createMenubar(
    [
      ["File", fileMenu],
      ["Edit", editMenu],
      ["View", viewMenu],
      ["Insert", insertMenu],
      ["Format", formatMenu],
      ["Arrange", arrangeMenuBar],
      ["Slide", slidesMenu],
      ["Tools", menuFor("Tools", () => review.toolsMenu())],
      ["Slide Show", slideShowMenuBar],
      ["Help", helpMenu],
    ].map(([label, open]) => ({ label, open })),
    {
      label: "Presentation menus",
      // Text being edited takes the keyboard back, where it was.
      returnFocus: () =>
        (richEditor?.input?.isConnected
          ? richEditor.input
          : workspace()
        )?.focus({ preventScroll: true }),
    },
  );
  menubar.el.classList.add("desktop-only");
  const quick = (label, name, handler, attrs = {}) =>
    el(
      "button",
      {
        type: "button",
        class: "qat-btn",
        "aria-label": label,
        "data-tip-title": attrs.title || label,
        onclick: handler,
        ...attrs,
        title: null,
      },
      icon(`o:${name}`, 18),
    );
  return el(
    "header",
    { class: "editor-header" },
    el(
      "div",
      { class: "topbar-row" },
      iconButton(
        "Back to presentations",
        "ArrowLeft",
        run(async () => {
          if (await leaveEditor()) await home();
        }),
      ),
      appIcon("brand-mark editor-brand desktop-only"),
      el(
        "div",
        {
          class: "qat desktop-only",
          role: "toolbar",
          "aria-label": "Quick Access Toolbar",
        },
        quick(
          "Save to Puter",
          "save",
          run(() => saveCloud()),
          {
            title: `Save (${MOD_KEY}+S)`,
            class: "qat-btn qat-save",
          },
        ),
        quick("Undo", "undo", () => undo(), {
          id: "undo",
          title: `Undo (${MOD_KEY}+Z)`,
        }),
        quick("Redo", "redo", () => redo(), {
          id: "redo",
          title: `Redo (${MOD_KEY}+Shift+Z)`,
        }),
      ),
      menubar.el,
      el(
        "div",
        { class: "topbar-title-wrap" },
        el(
          "h1",
          { class: "editor-title" },
          // Named by the name it shows, which follows a rename; the hint
          // says what a press does.
          button(doc.name, null, run(renameDoc), "document-title", {
            "aria-label": null,
            title: renameHint(doc.name),
          }),
        ),
        el("div", {
          id: "save-status",
          class: "save-status",
          role: "status",
        }),
      ),
      el(
        "div",
        { class: "header-right topbar-actions" },
        commandSearch(),
        saveButton(),
        assistantToggle(),
        button("Present", "Play", run(present), "primary present-button", {
          "data-tip-title": "Present (F5)",
        }),
        iconButton(
          "File options",
          "MoreHorizontal",
          (e) => fileMenu(e.currentTarget),
          { class: "btn icon-btn mobile-only", ...MENU_BUTTON },
        ),
        accountButton(),
      ),
    ),
  );
}
// Command search: finds any command on the ribbon by name and runs it.
function commandSearch() {
  const input = el("input", {
    type: "search",
    class: "command-search-input",
    placeholder: "Search",
    "aria-label": "Search for commands",
    autocomplete: "off",
    spellcheck: "false",
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        showMatches(true);
      } else if (e.key === "Escape") {
        input.value = "";
        workspace()?.focus({ preventScroll: true });
      }
    },
    oninput: () => showMatches(false),
  });
  function showMatches(focus) {
    const query = input.value.trim().toLowerCase();
    if (!query || !ribbon) return closeMenu();
    const words = query.split(/\s+/);
    const seen = new Set();
    const items = [];
    for (const { item, tab } of ribbon.commands()) {
      const label = item.ariaLabel || item.label;
      const hay =
        `${label} ${item.title || ""} ${item.description || ""} ${tab.label}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const key = `${label}|${tab.label}`;
      if (seen.has(key) || seen.has(label)) continue;
      seen.add(key);
      seen.add(label);
      const enabled = item.enabled ? !!item.enabled() : true;
      const visible = item.visible ? !!item.visible() : true;
      if (!visible) continue;
      const entry = {
        label,
        hint: tab.label,
        icon: item.icon ? `o:${item.icon}` : null,
        disabled: !enabled,
      };
      if (item.menu && !item.split) entry.items = item.menu();
      else
        entry.onSelect = () => {
          ribbon.select(tab.id);
          item.run?.();
          setTimeout(() => ribbon.refresh());
        };
      if (entry.items && !entry.items.length) continue;
      items.push(entry);
      if (items.length >= 12) break;
    }
    if (!items.length)
      items.push({
        label: `No commands match “${input.value.trim()}”`,
        disabled: true,
      });
    openMenu({
      anchor: wrap,
      label: "Commands",
      items,
      align: "end",
      minWidth: Math.max(280, wrap.offsetWidth),
      focusFirst: focus,
    });
  }
  const wrap = el(
    "div",
    { class: "command-search desktop-only", role: "search" },
    icon("o:search", 15),
    input,
  );
  return wrap;
}
// Export, print, properties and pictures (src/export): they read the open
// presentation through these and edit it through mutate.
const fileTools = createFileTools({
  P,
  doc: () => doc,
  // Recorded narrations go into exported videos (src/show/narration.js).
  narrationOf: (s) => showFeatures.narrationOf(s),
  settled,
  mutate,
  SKIP: SKIP_MUTATION,
  previewSrc: (target, s) => cachedPreview(target.previews, target.pres, s),
  slideDescription,
  displayShapeText,
  visibleSlideShapes,
  slideBounds: (pres, shape) => slideBounds(pres, shape),
  currentIndex: () => index,
  selectedSlides: () => selectedSlides(),
  selectedShapes: () => (view === "editor" && doc ? selectedShapes() : []),
  readOnly: () => readOnlyDocument(),
  pruneUnusedMedia,
  cleanName,
  toast,
  fail,
  refreshFields() {
    if (P.getSlides(doc.pres).some((s) => slideHasDateFields(doc.pres, s))) {
      P.refreshPresentationFields(doc.pres);
      renderSlideArea();
    }
  },
  async download(blob, filename, message) {
    reportExport(await cloud.downloadBlob(blob, filename), message);
  },
});
// The ribbon, built once per editor from the tab definitions, and refreshed
// whenever the selection or the presentation changes.
let ribbon = null;
let ribbonTab = "home";
// Tabs other modules add to the ribbon: functions returning tab definitions
// (see tabs.js), each with `after` naming the tab it follows or
// `contextual: true`.
const extraTabProviders = [
  () => [drawTools.tab()],
  () => insertFeatures.tabs(),
  () => chartTools.tabs(),
  () => smartArtTools.tabs(),
  () => [animationTools.tab()],
  () => [showFeatures.recordTab()],
  () => masterView.tabs(),
];
// Layouts: New Slide on a layout, changing a slide's layout, and Reset.
const layoutCommands = createLayoutCommands({
  pres: () => doc.pres,
  current: () => slide(),
  targets: () => actionSlides(slide()),
  mutate: (fn) => mutate(fn),
  commitText: () => commitText(),
  skip: SKIP_MUTATION,
  available: () => !!doc && !masterView.active && !readOnlyDocument(),
  afterAdd: (position) => {
    index = position;
    clearSelection();
    slideExtras.clear();
  },
});
// Reuse Slides and Slides from Outline (New Slide menu, Insert menu).
const slidesFrom = createSlidesFrom({
  pres: () => doc.pres,
  current: () => slide(),
  mutate: (fn) => mutate(fn),
  commitText: () => commitText(),
  available: () => !!doc && !masterView.active && !readOnlyDocument(),
  chooseFile: (accept) =>
    new Promise((resolve) => pickLocalFile(accept, (file) => resolve(file))),
  parseDeck: (bytes) => parseDeck(bytes),
  preview: (pres, s) => preview(pres, s),
  fail: (e) => fail(e),
  afterAdd: (position) => {
    if (position >= 0) index = position;
    clearSelection();
    slideExtras.clear();
  },
});
// Slide Master, Notes Master and Handout Master views.
const masterView = createMasterView({
  pres: () => doc.pres,
  mutate: (fn) => mutate(fn),
  skip: SKIP_MUTATION,
  currentSlide: () => P.getSlides(doc.pres)[index],
  setView: (id) => setView(id),
  render: () => {
    renderSlideArea();
    renderInspector();
    syncToolbar();
  },
  clearSelection: () => clearSelection(),
  selectShape: (id) => selectIds([id]),
  startDrawing: (tool) => startDrawing(tool),
  commitText: () => commitText(),
  ribbon: () => ribbon,
  themeGroups: () => themeTools.masterThemeGroups(),
});

// Themes: the Design tab's gallery, variants, colors, fonts, effects and
// background styles (themes/).
const themeTools = createThemeTools({
  pres: () => doc.pres,
  slide: () =>
    masterView.active ? P.getSlides(doc.pres)[index] || null : slide(),
  selectedSlides: () =>
    masterView.active ? P.getSlides(doc.pres) : selectedSlides(),
  masterView: () => masterView.active,
  mutate: (fn, options) => {
    commitText();
    return mutate(fn, options);
  },
  skip: SKIP_MUTATION,
  palette: () => theme,
  setPalette: (key) => {
    if (THEMES[key]) theme = key;
  },
  preview: (view) => preview(doc.pres, view),
  formatBackground: () => ribbonApi().formatBackground(),
  pickFile: (accept, handle) => pickLocalFile(accept, handle),
  download: async (blob, name, message) =>
    reportExport(await cloud.downloadBlob(blob, name), message),
  fontList: () => FONTS,
  docName: () => doc?.name || "",
});
// The Format Background pane, shown in the format panel when nothing on the
// slide is selected.
const backgroundPane = createBackgroundPane({
  pres: () => doc.pres,
  target: () => slide(),
  slides: () => P.getSlides(doc.pres),
  mutateTarget: (fn, options) => mutateSlide(slide(), fn, options),
  mutateDeck: (fn) => mutate(fn),
  skip: SKIP_MUTATION,
  fail,
  rerender: () => renderInspector(),
  resolved: (target) => slideBackground(target),
  colorInput: (label, value, onchange, options) =>
    colorInput(label, value, onchange, options),
  colorField: (target) =>
    colorInput(
      "Background color",
      slideBackground(target).color,
      (c) =>
        mutateSlide(target, (s) => P.setSlideBackground(s, c), {
          coalesce: coalesceKey("background", target),
        }),
      {
        empty: BACKGROUND_LABELS[slideBackground(target).kind] || null,
        fallback: THEMES[theme].bg,
      },
    ),
  imageButtons: (target) =>
    el(
      "div",
      { class: "arrange-buttons" },
      button(
        slideBackground(target).kind === "image"
          ? "Change background image"
          : "Background image",
        "Image",
        () => pickImage(setBackgroundImage),
        "secondary",
      ),
      slideBackground(target).kind === "image" &&
        button(
          "Remove background image",
          null,
          removeBackgroundImage,
          "secondary",
        ),
    ),
  afterPicture: (target) => {
    doc.previews.delete(P.getSlidePartName(target));
    pruneUnusedMedia(doc.pres, target);
    dedupeSlideMedia(doc.pres, target);
  },
});
// Comments, proofing, accessibility, compare and the read-only mark
// (review/). It reaches the editor through this surface.
const review = createReview({
  doc: () => doc,
  pres: () => doc?.pres || null,
  slide: () => slide(),
  index: () => index,
  revision: () => revision,
  chooseSlide: (target) => chooseSlide(target),
  showObjects: (part, ids) => showObjects(part, ids),
  selectionIds: () => (doc ? [...selectionIds()] : []),
  currentShape: () => (doc ? currentShape() : null),
  mutate: (fn) => mutate(fn),
  mutateSlide: (target, fn) => mutateSlide(target, fn),
  mutateShape: (shape, fn) => mutateShape(shape, fn),
  SKIP: SKIP_MUTATION,
  size: () => currentSize(),
  slideBounds: (shape) => slideBounds(doc.pres, shape),
  account: () => account,
  isTable: (shape) => isTable(shape),
  replaceInShape: (shape, re, value, only) =>
    replaceInShape(shape, re, value, only),
  replaceInCell: (cell, re, value, only) =>
    replaceInCell(cell, re, value, only),
  editor: () => richEditor,
  editShapeText: (part, id) => {
    if (P.getSlidePartName(slide()) !== part) return;
    const target = P.findShapeById(slide(), id);
    if (target) editText(target);
  },
  altText: () => altText().catch(fail),
  setText: (shape, value) => setText(shape, value),
  setLanguage: (shape, language) =>
    formatText(withTextBody(shape), { language }),
  languageItems: () => languageItems(),
  textColors: (shape) => reviewTextColors(shape),
  fixContrast: (shape) => fixTextContrast(shape),
  addTitle: (issue, options) => addAccessibleTitle(issue, options),
  showIssue: async (issue) => {
    if (P.getSlidePartName(slide()) !== issue.part)
      await chooseSlide(issue.slide);
    showObjects(issue.part, issue.shapeId != null ? [issue.shapeId] : []);
  },
  syncToolbar: () => syncToolbar(),
  refreshEditor: () => {
    if (view !== "editor") return;
    renderSlideArea();
    renderInspector();
    syncToolbar();
  },
  commitText: () => commitText(),
  settled: () => settled(),
  fail: (e) => fail(e),
});
// The text's colour and the colour behind it, for the contrast check.
function reviewTextColors(shape) {
  try {
    if (!canHoldText(shape) || isTable(shape)) return null;
    const format = P.getShapeRunFormatEffective(doc.pres, shape, 0, 0);
    const text = format?.color;
    if (!text || !/^#?[0-9a-f]{6}$/i.test(text)) return null;
    const background =
      P.getShapeFillColorResolvedEffective(doc.pres, shape) ||
      slideBackground(P.getShapeSlide(shape)).color;
    if (!background) return null;
    return {
      text,
      background,
      size: format.size || 18,
      bold: !!format.bold,
    };
  } catch {
    return null;
  }
}
function fixTextContrast(shape) {
  if (!shape) return;
  return mutateShape(shape, (target) => {
    const colors = reviewTextColors(target);
    if (!colors) return SKIP_MUTATION;
    const color = legibleColor(
      colors.background,
      [THEMES[theme].ink, "#000000", "#FFFFFF"],
      4.5,
    );
    formatText(target, { color });
  });
}
// A title for a slide without one: in the layout's title position, or just
// above the slide where only screen readers find it.
function addAccessibleTitle(issue, { hidden }) {
  const value = hidden
    ? (slideDescription(issue.slide, doc.pres) || "")
        .split("\n")[0]
        .slice(0, 80) || `Slide ${issue.index + 1}`
    : `Slide ${issue.index + 1}`;
  return mutateSlide(issue.slide, (target) => {
    const size = currentSize();
    const layout = P.getSlideLayout(target);
    const fromLayout =
      layout &&
      P.getSlideLayoutPlaceholders(layout).some((ph) =>
        ["title", "ctrTitle"].includes(ph.type),
      );
    const added = P.addSlideTitlePlaceholder(target, value, {
      hidden,
      slideHeight: size.cy,
      box: hidden
        ? {
            x: 0,
            y: -Math.round(size.cy * 0.2),
            w: size.cx,
            h: Math.round(size.cy * 0.12),
          }
        : fromLayout
          ? undefined
          : {
              x: Math.round(size.cx * 0.06),
              y: Math.round(size.cy * 0.05),
              w: Math.round(size.cx * 0.88),
              h: Math.round(size.cy * 0.16),
            },
    });
    if (!hidden) selectIds([P.getShapeId(added)]);
  });
}
// Format dialogs, galleries, the pane's detailed sections, Edit Points and
// Merge Shapes (src/format). They reach the editor through these primitives.
const formatTools = createFormatTools({
  P,
  doc: () => doc,
  pres: () => doc.pres,
  slide: () => slide(),
  shapes: () => shapes(),
  currentShape: () => currentShape(),
  selectedShapes: () => selectedShapes(),
  selectionIds: () => selectionIds(),
  selectIds: (ids) => {
    selectIds(ids);
    renderSelection();
    renderInspector();
  },
  selectFromPane: (id, extend) => {
    const i = shapes().findIndex((s) => P.getShapeId(s) === id);
    if (i < 0) return;
    if (extend) toggleSelected(i);
    else selectOnly(i);
    renderSelection();
    renderInspector();
    renderSelectionPane();
  },
  shapeLabel: (s) => shapeLabel(s, doc.pres),
  renderInspector: () => renderInspector(),
  show: (pane, on) => show(pane, on),
  mutate: (fn, options) => mutate(fn, options),
  mutateShape: (obj, fn, options) => mutateShape(obj, fn, options),
  mutateSlide: (target, fn, options) => mutateSlide(target, fn, options),
  textMutation: (obj, fn, options) => textMutation(obj, fn, options),
  SKIP: SKIP_MUTATION,
  coalesce: (key, obj) => coalesceKey(key, P.getShapeSlide(obj), obj),
  canEditText: (obj) => canEditText(obj),
  isTable: (obj) => isTable(obj),
  hasTextBody: (obj) => hasTextBody(obj),
  listStyle: (obj) => listStyle(obj),
  textFormat: (obj) => editorFor(obj)?.selectionFormat() || textFormat(obj),
  applyText: (obj, fmt) => applyTextFormat(obj, fmt),
  editorFor: (obj) => editorFor(obj),
  editorParagraphs: (obj) => editorFor(obj)?.paragraphRange?.() ?? null,
  selectedText: (obj) => editorFor(obj)?.selectedText?.() || "",
  commitText: () => commitText(),
  fonts: () => FONTS,
  slideBounds: (obj) => slideBounds(doc.pres, obj),
  setSlideBounds: (obj, b) => setSlideBounds(doc.pres, obj, b),
  slideSize: () => currentSize(),
  pickImageBytes: () =>
    new Promise((resolve) => {
      pickImage(async (file) => {
        try {
          resolve(new Uint8Array(await file.arrayBuffer()));
        } catch {
          resolve(null);
        }
      });
    }),
  insertImageFile: (file, placement) =>
    insertImageFile(file, placement ? { box: placement } : null),
  clipboardInfo: () => clipboard,
  pasteClipboard: (options) => pasteClipboard(options),
  pasteText: (value) => pasteText(value),
  pasteRichText: (paragraphs) => pasteRichText(paragraphs),
  renderSlide: (pres, target) => preview(pres, target),
  groupSelection: () => groupSelection(),
  toggleSelectionPane: () => toggleSelectionPane(),
  flipObject: (obj, axis) => flipObject(obj, axis),
  deleteSelection: () => deleteObject(),
  toast: (message) => toast(message),
  pickUpStyle: () => {
    const obj = currentShape();
    if (!obj) return;
    painter = { format: pickUpFormat(obj), sticky: true, keyboard: true };
    toast(`Style picked up. Select an object and choose Apply Object Style.`);
  },
  applyStyle: () => {
    const obj = currentShape();
    if (!obj || !painter) return;
    const held = painter;
    paintFormat(obj);
    if (held.keyboard) painter = held;
  },
  canApplyStyle: () => !!painter && !!currentShape(),
});
const drawTools = createDrawTools({
  P,
  canvas: () => document.querySelector("#slide-canvas"),
  slideSize: () => currentSize(),
  currentSlide: () => slide(),
  mutateSlide: (target, fn) => mutateSlide(target, fn),
  theme: () => doc && P.getPresentationTheme(doc.pres),
  onToolChange: () => {
    if (drawTools.tool) cancelDrawing();
    syncToolbar();
  },
  selectedShapes: () => (doc ? selectedShapes() : []),
  selectShapes: (ids) => {
    if (!doc) return;
    selectIds(ids);
    renderSelection();
    updateSelectionUi();
    renderInspector();
  },
  renderSlide: (s) => preview(doc.pres, s),
  chat: () =>
    cloud.canAI() ? globalThis.puter.ai.chat.bind(globalThis.puter.ai) : null,
  aiModel: AI_MODEL,
  // Ink to Math sets what it reads as an equation object (src/insert),
  // looked up when used: the insert features are made after the Draw tab.
  equation: () => insertFeatures?.equations || null,
  shapeLabels: Object.fromEntries(
    SHAPES.map(([preset, label]) => [preset, label]),
  ),
}); // Charts: Insert Chart, the data sheet, and the Chart Design and Format tabs.
const chartTools = createChartTools({
  P,
  pres: () => doc.pres,
  slide: () => slide(),
  selection: () => selectedShapes(),
  mutateShape: (shape, fn, options) => mutateShape(shape, fn, options),
  mutateSlide: (target, fn, options) => mutateSlide(target, fn, options),
  selectIds: (ids) => selectIds(ids),
  slideSize: () => currentSize(),
  theme: () => doc && P.getPresentationTheme(doc.pres),
  commitText: () => commitText(),
  skip: SKIP_MUTATION,
  readOnly: () => readOnlyDocument(),
  selectTab: (id) => ribbon?.select(id),
  // Formatting a chart element shows the chart's own tab.
  showFormatPane: () => {
    showFormatTab("chart", "chart", "chart");
    show("formatPane", true);
  },
  refresh: () => {
    renderInspector();
  },
  fields: {
    field: (...a) => field(...a),
    colorInput: (...a) => colorInput(...a),
    numInput: (...a) => numInput(...a),
  },
}); // SmartArt: inserting graphics, the Text Pane, the SmartArt Design tab, and
// Convert to SmartArt for bulleted text.
const smartArtTools = createSmartArtTools({
  P,
  pres: () => doc.pres,
  slide: () => slide(),
  selection: () => selectedShapes(),
  mutateShape: (shape, fn, options) => mutateShape(shape, fn, options),
  mutateSlide: (target, fn, options) => mutateSlide(target, fn, options),
  selectIds: (ids) => selectIds(ids),
  slideSize: () => currentSize(),
  theme: () => doc && P.getPresentationTheme(doc.pres),
  commitText: () => commitText(),
  skip: SKIP_MUTATION,
  readOnly: () => readOnlyDocument(),
  selectTab: (id) => ribbon?.select(id),
  refreshRibbon: () => syncToolbar(),
  removeShape: (target, shape) => removeAnyShape(target, shape),
  bounds: (shape) => slideBounds(doc.pres, shape),
  pickPicture: (use) =>
    pickImage(async (file) => use(await readImageFile(file))),
  refreshCanvas: () => renderSelection(),
  setIndentLevel: (shape, i, level, bulleted) =>
    setParagraphIndentLevel(shape, i, level, bulleted),
  canHoldText: (shape) => canHoldText(shape),
  displayText: (shape) => displayShapeText(doc.pres, shape),
  fields: {
    field: (...a) => field(...a),
    colorInput: (...a) => colorInput(...a),
    numInput: (...a) => numInput(...a),
  },
});
const transitionTools = createTransitionTools({
  P,
  pres: () => doc.pres,
  slide: () => slide(),
  mutateSlide: (target, fn) => mutateSlide(target, fn),
  skip: SKIP_MUTATION,
  picture: (s) => cachedPreview(doc.previews, doc.pres, s),
  render: (s, layer) => preview(doc.pres, s, layer),
  canvas: () => document.querySelector("#slide-canvas"),
  chooseFile: (accept) =>
    new Promise((resolve) => pickLocalFile(accept, (file) => resolve(file))),
  report: (error) => fail(error),
});
// Icons, media, screenshots, photo albums, equations, header and footer,
// zooms, action settings and embedded objects (src/insert).
const insertFeatures = createInsertFeatures({
  doc: () => doc,
  slide: () => slide(),
  currentShape: () => currentShape(),
  selectedShapes: () => selectedShapes(),
  selectedIds: () => selectionIds(),
  selectIds: (ids) => selectIds(ids),
  selectedSlideParts: () => selectedSlideParts(),
  commitText: () => commitText(),
  fail: (e) => fail(e),
  mutate: (fn) => mutate(fn),
  mutateSlide: (target, fn) => mutateSlide(target, fn),
  mutateShape: (obj, fn) => mutateShape(obj, fn),
  currentSize: () => currentSize(),
  ribbon: () => ribbon,
  theme: () => THEMES[theme],
  readImage: (file) => readImage(file),
  insertImageFile: (file) => insertImageFile(file),
  altText: () => altText().catch(fail),
  goToSlide: (i) => {
    index = Math.max(0, Math.min(i, P.getSlides(doc.pres).length - 1));
    clearSelection();
    renderSlideArea();
    renderInspector();
  },
  previewSrc: (s) => slidePreview(s),
  language: () => deckLanguage(),
  normalizeUrl: (value) => normalizeUrl(value),
  startDrawing: (preset) => startDrawing(preset),
  refreshCanvas: () => renderSelection(),
});
// Slide Show and Record: presenter view, custom shows, set up, rehearsal,
// recording, subtitles and the in-show tools (src/show).
const showFeatures = createShowFeatures({
  P,
  doc: () => doc,
  slide: () => slide(),
  present: (options) => present(options),
  mutate: (fn) => mutate(fn),
  mutateSlide: (target, fn) => mutateSlide(target, fn),
  SKIP: SKIP_MUTATION,
  fail: (e) => fail(e),
  slideBounds: (pres, shape) => slideBounds(pres, shape),
  picture: (s) => cachedPreview(doc.previews, doc.pres, s),
  title: (s) =>
    slideTitle(s, doc.pres) ||
    slideDescription(s, doc.pres).split("\n")[0] ||
    "",
  currentSize: () => currentSize(),
  select: (ids) => selectIds(ids),
  exportVideo: () => fileTools.openExportDialog("video"),
});
// The Animations tab, the Animation Pane and animation previews.
const animationTools = createAnimationTools({
  P,
  modKey: MOD_KEY,
  doc: () => doc,
  slide: () => doc && slide(),
  selectedShapes: () => (doc ? selectedShapes() : []),
  selectShapes: (ids) => {
    selectIds(ids);
    renderSelection();
    renderInspector();
  },
  topLevelShapes: (s) => {
    const parents = groupParents(s);
    return P.getSlideShapes(s).filter((x) => !parents.has(P.getShapeId(x)));
  },
  bounds: (shape) => slideBounds(doc.pres, shape),
  slideSize: () => currentSize(),
  // One line, for lists and menus.
  shapeLabel: (shape) =>
    truncateLabel(shapeLabel(shape, doc.pres).replace(/\s+/g, " ").trim(), 60),
  renderLayer: (s, layer) => preview(doc.pres, s, layer),
  mutateSlide: (target, fn, options) => mutateSlide(target, fn, options),
  canvas: () => document.querySelector("#slide-canvas"),
  editorBody: () => document.querySelector(".editor-body"),
  refresh: () => syncToolbar(),
  chooseFile: (accept) =>
    new Promise((resolve) => pickLocalFile(accept, (file) => resolve(file))),
});

// On a short screen the ribbon starts folded away, leaving the height to the
// slide, without changing the collapse the person chose; it opens again when
// the screen grows tall (a phone turned upright), unless they folded it.
const SHORT_SCREEN = matchMedia("(max-height: 500px)");
let ribbonAutoCollapsed = false;
function fitRibbonToScreen() {
  if (!ribbon || chrome.ribbonCollapsed) return;
  if (SHORT_SCREEN.matches === ribbon.collapsed) return;
  if (!SHORT_SCREEN.matches && !ribbonAutoCollapsed) return;
  ribbonAutoCollapsed = SHORT_SCREEN.matches;
  ribbon.setCollapsed(SHORT_SCREEN.matches, { remember: false });
}
SHORT_SCREEN.addEventListener("change", fitRibbonToScreen);
function editorRibbon() {
  ribbon?.destroy();
  ribbonAutoCollapsed = false;
  ribbon = createRibbon({
    tabs: buildTabs(ribbonApi()),
    initial: ribbonTab,
    focusFallback: workspace,
    onTabChange: (id) => {
      ribbonTab = id;
      document.querySelector(".editor")?.setAttribute("data-ribbon-tab", id);
      animationTools.setTabActive(id === "animations");
    },
    onCollapse: (on) => {
      chrome.ribbonCollapsed = on;
      saveChrome();
    },
  });
  ribbon.onError(fail);
  animationTools.setTabActive(ribbonTab === "animations");
  if (chrome.ribbonCollapsed) ribbon.setCollapsed(true);
  else fitRibbonToScreen();
  return ribbon.el;
}
/* ---------- Window chrome ----------
 * The panes around the slide (thumbnails, notes, format pane), the status
 * bar, and what the View tab shows. Their state outlives the presentation.
 */
const CHROME_KEY = "presentation:chrome";
const chrome = {
  thumbnails: true,
  notes: true,
  formatPane: false,
  ruler: false,
  gridlines: false,
  guides: false,
  ribbonCollapsed: false,
  thumbnailWidth: 210,
  notesHeight: 70,
  colorMode: "color",
  ...(() => {
    try {
      return JSON.parse(localStorage.getItem(CHROME_KEY) || "{}");
    } catch {
      return {};
    }
  })(),
};
function saveChrome() {
  try {
    localStorage.setItem(CHROME_KEY, JSON.stringify(chrome));
  } catch {}
}
function applyPaneSizes() {
  const editor = document.querySelector(".editor");
  if (!editor) return;
  editor.style.setProperty("--thumbnail-width", `${chrome.thumbnailWidth}px`);
  editor.style.setProperty("--notes-height", `${chrome.notesHeight}px`);
  // A focusable separator says where it is between its limits.
  for (const handle of editor.querySelectorAll(".pane-resize[data-pane]")) {
    const [key, min, max] = PANE_LIMITS[handle.dataset.pane];
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(chrome[key]));
  }
  editor.classList.toggle("show-gridlines", !!chrome.gridlines);
  editor.classList.toggle("show-guides", !!chrome.guides);
  editor.classList.toggle("show-ruler", !!chrome.ruler);
  editor.dataset.colorMode = chrome.colorMode;
  editor.setAttribute("data-ribbon-tab", ribbonTab);
}
// The thumbnails pane and the notes pane are resized by the rule between
// them and the slide: by dragging it, or with the arrow keys on it.
const PANE_LIMITS = {
  thumbnails: ["thumbnailWidth", 120, 420],
  notes: ["notesHeight", 34, 400],
};
function resizePane(e, pane) {
  if (e.button !== 0) return;
  e.preventDefault();
  const [key, min, max] = PANE_LIMITS[pane];
  const start = pane === "notes" ? e.clientY : e.clientX;
  const from = chrome[key];
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const delta =
      (pane === "notes" ? start - ev.clientY : ev.clientX - start) || 0;
    chrome[key] = Math.round(Math.min(max, Math.max(min, from + delta)));
    applyPaneSizes();
    fitCanvas();
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    saveChrome();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}
function resizePaneKey(e, pane) {
  const [key, min, max] = PANE_LIMITS[pane];
  const grow = pane === "notes" ? "ArrowUp" : "ArrowRight";
  const shrink = pane === "notes" ? "ArrowDown" : "ArrowLeft";
  if (e.key !== grow && e.key !== shrink) return;
  e.preventDefault();
  chrome[key] = Math.min(
    max,
    Math.max(min, chrome[key] + (e.key === grow ? 16 : -16)),
  );
  applyPaneSizes();
  fitCanvas();
  saveChrome();
}
function showing(what) {
  const editor = document.querySelector(".editor");
  if (what === "thumbnails") return navigatorVisible();
  if (what === "formatPane") return inspectorVisible();
  if (what === "notes") return !editor?.classList.contains("hide-notes");
  if (what === "assistant") return !!assistant?.isOpen;
  return !!chrome[what];
}
function show(what, on) {
  const editor = document.querySelector(".editor");
  if (!editor) return;
  if (what === "thumbnails") {
    editor.classList.toggle("hide-slides", !on);
    chrome.thumbnails = on;
  } else if (what === "formatPane") {
    editor.classList.toggle("hide-inspector", !on);
    editor.classList.toggle("show-inspector", on);
    chrome.formatPane = on;
    if (on && sidePanelsExclusive() && assistant?.isOpen)
      assistant.close({ focusWorkspace: false });
    if (on)
      document.querySelector("#inspector")?.focus({ preventScroll: true });
  } else if (what === "notes") {
    editor.classList.toggle("hide-notes", !on);
    chrome.notes = on;
  } else if (what === "assistant") {
    toggleAssistant(on);
    return;
  } else chrome[what] = on;
  saveChrome();
  applyPaneSizes();
  if (what === "ruler" || what === "gridlines" || what === "guides")
    renderCanvasAids();
  updatePanelToggles();
}
// Rulers above and beside the slide, a grid over it, and the two centre
// guides, drawn for the slide's size at the current zoom.
function renderCanvasAids() {
  const canvas = document.querySelector("#slide-canvas");
  if (!canvas) return;
  canvas
    .querySelectorAll(".canvas-aids, .ruler")
    .forEach((node) => node.remove());
  const size = currentSize();
  const inchesWide = size.cx / 914400,
    inchesHigh = size.cy / 914400;
  if (chrome.gridlines || chrome.guides) {
    // The grid at the deck's spacing, and the drawing guides, which can be
    // dragged (see views/grid-guides.js).
    const aids = el("div", { class: "canvas-aids" });
    views.grid.decorate(aids, canvas);
    canvas.append(aids);
  }
  if (chrome.ruler) {
    const ticks = (n, vertical) => {
      const ruler = el("div", {
        class: `ruler ${vertical ? "vertical" : "horizontal"}`,
        "aria-hidden": "true",
      });
      // Numbered from the centre outwards.
      const half = n / 2;
      for (let i = 0; i <= n * 4; i++) {
        const at = i / 4;
        const major = i % 4 === 0;
        const tick = el("span", {
          class: `tick ${major ? "major" : i % 2 === 0 ? "half" : ""}`,
          style: `${vertical ? "top" : "left"}:${(at / n) * 100}%`,
        });
        if (major && Math.abs(at - half) > 0.01)
          tick.dataset.label = String(Math.round(Math.abs(at - half)));
        ruler.append(tick);
      }
      return ruler;
    };
    canvas.append(ticks(inchesWide, false), ticks(inchesHigh, true));
  }
}
// The status bar: the slide's position, the proofing language and the
// accessibility check on the left; the notes and comments panes, the views,
// and the zoom on the right.
function statusBar() {
  const viewButton = (id, label, name, handler) =>
    el(
      "button",
      {
        type: "button",
        class: "status-view",
        "aria-label": label,
        "data-tip-title": label,
        "data-view": id,
        onclick: handler,
      },
      icon(`o:${name}`, 16),
    );
  const slider = el("input", {
    type: "range",
    class: "zoom-slider",
    min: "0",
    max: "100",
    step: "1",
    "aria-label": "Zoom",
    oninput: (e) => {
      // The slider runs from 10% to 400%, with 100% at its middle.
      const v = Number(e.target.value);
      const level = v <= 50 ? 0.1 + (v / 50) * 0.9 : 1 + ((v - 50) / 50) * 3;
      setZoom(Math.round(level * 100) / 100);
    },
  });
  return el(
    "footer",
    { class: "editor-footer status-bar" },
    el(
      "div",
      { class: "status-left" },
      el("span", { id: "slide-position", class: "status-item" }),
      el(
        "button",
        {
          type: "button",
          class: "status-item status-button desktop-only",
          id: "status-language",
          "data-tip-title": "Proofing language",
          onclick: (e) =>
            openMenu({
              anchor: e.currentTarget,
              label: "Language",
              items: languageItems(),
              align: "start",
            }),
        },
        languageName(),
      ),
      el(
        "button",
        {
          type: "button",
          class: "status-item status-button desktop-only",
          id: "status-accessibility",
          onclick: () => checkAccessibility(),
        },
        icon("o:accessibility", 15),
        el("span", {}, "Accessibility: Investigate"),
      ),
    ),
    el(
      "div",
      { class: "status-right" },
      el(
        "button",
        {
          type: "button",
          class: "status-item status-button",
          id: "status-notes",
          "aria-pressed": "true",
          onclick: () => show("notes", !showing("notes")),
        },
        icon("o:notesPane", 15),
        el("span", {}, "Notes"),
      ),
      // Shown once the editor has a comments pane to open.
      el(
        "button",
        {
          type: "button",
          class: "status-item status-button desktop-only",
          id: "status-comments",
          "aria-pressed": "false",
          hidden: true,
          onclick: () => statusComments()?.toggle(),
        },
        icon("o:showComments", 15),
        el("span", {}, "Comments"),
      ),
      el(
        "div",
        {
          class: "status-views desktop-only",
          role: "group",
          "aria-label": "Views",
        },
        viewButton("normal", "Normal", "normalViewSmall", () =>
          setView("normal"),
        ),
        viewButton("sorter", "Slide Sorter", "slideSorter", () =>
          setView("sorter"),
        ),
        viewButton("reading", "Reading View", "readingViewSmall", () =>
          setView("reading"),
        ),
        viewButton(
          "show",
          "Slide Show",
          "slideShowSmall",
          run(() => present({ from: "current" })),
        ),
      ),
      el(
        "div",
        { class: "zoom-control" },
        el("span", { class: "sr-only" }, aspectLabel()),
        iconButton("Zoom out", "Minus", () => stepZoom(-1), {
          title: `Zoom out (${MOD_KEY}+-)`,
          class: "btn icon-btn zoom-step",
        }),
        slider,
        iconButton("Zoom in", "Plus", () => stepZoom(1), {
          title: `Zoom in (${MOD_KEY}+=)`,
          class: "btn icon-btn zoom-step",
        }),
        button("Fit", null, (e) => zoomMenu(e), "zoom-level", {
          "aria-label": "Zoom level",
          ...MENU_BUTTON,
        }),
        el(
          "button",
          {
            type: "button",
            class: "status-view fit",
            "aria-label": "Fit slide to current window",
            "data-tip-title": `Fit slide to current window (${MOD_KEY}+0)`,
            onclick: () => setZoom("fit"),
          },
          icon("o:fitWindow", 16),
        ),
      ),
    ),
  );
}
function updateZoomUi() {
  const factor = zoomFactor();
  const level = document.querySelector(".zoom-level span");
  if (level) level.textContent = `${Math.round(factor * 100)}%`;
  const slider = document.querySelector(".zoom-slider");
  if (slider && document.activeElement !== slider)
    slider.value = String(
      Math.round(
        factor <= 1
          ? ((factor - 0.1) / 0.9) * 50
          : 50 + ((factor - 1) / 3) * 50,
      ),
    );
  document
    .querySelector(".status-view.fit")
    ?.setAttribute(
      "aria-pressed",
      String(viewZoom() ? viewZoom().isFit() : zoom === "fit"),
    );
  const zoomIn = document.querySelector('.zoom-control [aria-label="Zoom in"]');
  const zoomOut = document.querySelector(
    '.zoom-control [aria-label="Zoom out"]',
  );
  disableControl(zoomIn, !nextZoomStep(1), workspace);
  disableControl(zoomOut, !nextZoomStep(-1), workspace);
}
// The comments pane, when the editor has one.
let statusApi = null;
function statusComments() {
  const api = (statusApi ??= ribbonApi());
  return typeof api.toggleComments === "function"
    ? {
        toggle: () => api.toggleComments(),
        open: () => !!api.commentsOpen?.(),
      }
    : null;
}
function updateStatusBar() {
  const notes = document.querySelector("#status-notes");
  if (notes) notes.setAttribute("aria-pressed", String(showing("notes")));
  const comments = document.querySelector("#status-comments");
  if (comments) {
    const pane = statusComments();
    comments.hidden = !pane;
    comments.setAttribute("aria-pressed", String(!!pane?.open()));
  }
  for (const node of document.querySelectorAll(".status-views [data-view]"))
    node.setAttribute(
      "aria-pressed",
      String(node.dataset.view === currentView()),
    );
  const a11y = document.querySelector("#status-accessibility span");
  if (a11y && doc) a11y.textContent = review.accessibilityStatus();
}
// The proofing language of the deck's text: what the browser's spell checker
// is told, and what new text is marked with.
const LANGUAGES = [
  ["en-US", "English (United States)"],
  ["en-GB", "English (United Kingdom)"],
  ["fr-FR", "French (France)"],
  ["de-DE", "German (Germany)"],
  ["es-ES", "Spanish (Spain)"],
  ["it-IT", "Italian (Italy)"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["nl-NL", "Dutch (Netherlands)"],
  ["ja-JP", "Japanese"],
  ["zh-CN", "Chinese (Simplified)"],
  ["ko-KR", "Korean"],
];
function deckLanguage() {
  try {
    const obj = currentShape();
    const fmt = obj && canEditText(obj) ? textFormat(obj) : null;
    return fmt?.language || "en-US";
  } catch {
    return "en-US";
  }
}
const languageName = (code = deckLanguage()) =>
  LANGUAGES.find(([c]) => c === code)?.[1] || code;
function languageItems() {
  const current = deckLanguage();
  const obj = currentShape();
  const textual = selectedShapes().filter(canEditText);
  return [
    {
      header: textual.length
        ? "Mark selected text as"
        : "Select text to set its language",
    },
    ...LANGUAGES.map(([code, name]) => ({
      label: name,
      checked: code === current,
      disabled: !textual.length,
      onSelect: () => {
        if (!obj) return;
        mutateSlide(slide(), (target) => {
          for (const id of selectionIds()) {
            const shape = P.findShapeById(target, id);
            if (shape && canEditText(shape))
              formatText(withTextBody(shape), { language: code });
          }
        });
      },
    })),
  ];
}
// The accessibility checker lives with the review panes (review/).
function checkAccessibility() {
  review.openAccessibility();
}
// Alternative text for the selected object, in a dialog of its own.
async function altText() {
  const obj = currentShape();
  if (!obj) return;
  const input = el("textarea", {
    class: "input",
    rows: 4,
    "aria-label": "Alt text",
    value: P.getShapeDescription?.(obj) || "",
  });
  const decorative = el("input", { type: "checkbox" });
  const ok = await dialog({
    title: "Alt Text",
    body: el(
      "div",
      { class: "dialog-body" },
      el(
        "p",
        { class: "helper" },
        "How would you describe this object and its context to someone who is blind or has low vision?",
      ),
      input,
      el(
        "label",
        { class: "check-field" },
        decorative,
        el("span", {}, "Mark as decorative"),
      ),
    ),
    confirm: "Done",
  });
  if (!ok) return;
  const value = decorative.checked ? "" : input.value.trim();
  mutateShape(obj, (obj) => P.setShapeDescription(obj, value));
}
// The editor's views: Normal, Outline View, Slide Sorter and Notes Page
// (src/views), and Reading View, which plays the show inside the window.
let editorView = "normal";
const currentView = () => editorView;
const VIEW_HANDLERS = {};
for (const kind of ["slide", "notes", "handout"])
  VIEW_HANDLERS[masterView.viewId(kind)] = {
    enter: () => {
      masterView.enter(kind);
      renderSlideArea();
      renderInspector();
    },
    leave: () => {
      masterView.leave();
      renderSlideArea();
      renderInspector();
    },
  };
function supportsView(id) {
  return id === "normal" || id === "reading" || !!VIEW_HANDLERS[id];
}
// `remount` enters the view again after the editor was drawn anew.
function setView(id, { remount = false } = {}) {
  if (id === "reading") return present({ from: "current", reading: true });
  if (!supportsView(id)) return;
  const previous = editorView;
  if (previous === id && !remount) {
    syncToolbar();
    return;
  }
  if (previous !== id) {
    commitText();
    VIEW_HANDLERS[previous]?.leave?.();
  }
  editorView = id;
  document.querySelector(".editor")?.setAttribute("data-view", id);
  if (id !== "normal") {
    clearSelection();
    VIEW_HANDLERS[id].enter();
  }
  if (!remount) views.viewChanged(id);
  renderSelection();
  updatePanelToggles();
  updateZoomUi();
  if (id === "normal" && previous !== "normal")
    document.querySelector("#main")?.focus({ preventScroll: true });
}
// The zoom of the view in front, when it keeps its own.
const viewZoom = () => VIEW_HANDLERS[editorView]?.zoom || null;
const views = createViews({
  P,
  doc: () => doc,
  docKey: () => doc && (doc.path || doc.id),
  currentSlide: () => slide(),
  currentSize: () => currentSize(),
  currentView,
  setView,
  show,
  showing,
  chrome,
  saveChrome,
  renderCanvasAids: () => renderCanvasAids(),
  sync: () => syncToolbar(),
  thumbnail: (s) => cachedPreview(doc.previews, doc.pres, s),
  slideLabel: (s, i) => thumbLabel(s, i, false),
  markers: (s) => ({
    transition: (transitionDetails(s)?.effect || "none") !== "none",
    animation: /<(\w+:)?timing[\s>]/.test(P.getSlideXmlString(s)),
  }),
  selectedParts: () => selectedSlideParts(),
  choose: (part, extras) => {
    const s = P.getSlides(doc.pres).find((x) => P.getSlidePartName(x) === part);
    return s ? chooseSlide(s, { extras }) : Promise.resolve();
  },
  settle: (parts) => settleIndex(parts),
  settleIndex: (i) => {
    index = Math.max(0, Math.min(i, P.getSlides(doc.pres).length - 1));
  },
  mutate: (fn, options) => mutate(fn, options),
  mutateSlide: (target, fn, options) => mutateSlide(target, fn, options),
  SKIP: SKIP_MUTATION,
  undo: () => undo(),
  redo: () => redo(),
  addSlideAfter: (s) => addSlideAfter(s),
  duplicateSlides: (list) => duplicateSlides(list),
  deleteSlides: (list) => deleteSlides(list),
  setSlidesHidden: (list, hidden) => setSlidesHidden(list, hidden),
  moveSlides: (list, direction) =>
    moveSlides(list, direction, [P.getSlidePartName(slide())]),
  stepZoom: (direction) => stepZoom(direction),
  setZoom: (level) => setZoom(level),
  zoomFactor: () => zoomFactor(),
  zoomIsFit: () => (viewZoom() ? viewZoom().isFit() : zoom === "fit"),
  zoomChanged: () => updateZoomUi(),
  toast,
  fail,
});
Object.assign(VIEW_HANDLERS, views.handlers);
function setColorMode(id) {
  chrome.colorMode = id;
  saveChrome();
  applyPaneSizes();
  syncToolbar();
}
// New slides take the layout of the slide they follow (a title slide is
// followed by Title and Content); the menu offers every layout. In Slide
// Master view the command adds a layout instead.
function addSlideAfter(target, layoutPart = null) {
  if (masterView.active) {
    if (masterView.mode === "slide") masterView.insertLayout();
    return;
  }
  return layoutCommands.addSlide(target, layoutPart);
}
// The Arrange and Slide Show menus of the menu bar.
function arrangeMenuBar(anchor) {
  return menuFor("Arrange", arrangeMenuItems)(anchor);
}
function arrangeMenuItems() {
  const obj = currentShape();
  return [
    {
      label: "Order",
      icon: "o:bringForward",
      disabled: !obj,
      items: orderItems(obj),
    },
    ...arrangeItems(),
    ...formatTools.arrangeMenuItems(),
    { separator: true },
    {
      label: "Selection Pane",
      icon: "o:selectionPane",
      shortcut: `${M}+Alt+U`,
      onSelect: toggleSelectionPane,
    },
  ];
}
function slideShowMenuBar(anchor) {
  return menuFor("Slide Show", slideShowMenuItems)(anchor);
}
const slideShowMenuItems = () => [
  {
    label: "Play from Start",
    icon: "o:playFromStart",
    shortcut: "F5",
    onSelect: run(() => present({ from: "beginning" })),
  },
  {
    label: "Play from Current Slide",
    icon: "o:playFromCurrent",
    shortcut: "Shift+F5",
    onSelect: run(() => present({ from: "current" })),
  },
  { separator: true },
  {
    label: "Transition",
    icon: "o:previewTransition",
    items: transitionItems(slide()),
  },
  ...showFeatures.menuItems(),
  { separator: true },
  {
    label: P.isSlideHidden(slide()) ? "Show Slide" : "Hide Slide",
    icon: "o:hideSlide",
    onSelect: () =>
      setSlidesHidden(actionSlides(slide()), !P.isSlideHidden(slide())),
  },
];
// The Selection Pane: every object on the slide, top of the stack first, to
// select, show or hide, and rename.
let selectionPane = null;
function selectionPaneOpen() {
  return !!selectionPane?.isConnected;
}
function toggleSelectionPane() {
  if (selectionPaneOpen()) {
    // Closed from within, the keyboard goes back to the slide rather than
    // being dropped onto the page.
    const within = selectionPane.contains(document.activeElement);
    selectionPane.remove();
    selectionPane = null;
    if (within) workspace()?.focus({ preventScroll: true });
    return;
  }
  selectionPane = el("aside", {
    class: "task-pane selection-pane",
    "aria-label": "Selection",
    tabindex: -1,
  });
  document.querySelector(".editor-body")?.append(selectionPane);
  renderSelectionPane();
  syncToolbar();
  // The keyboard follows into the pane, on the selected object's row.
  (
    selectionPane.querySelector('.selection-name[aria-pressed="true"]') ||
    selectionPane
  ).focus({ preventScroll: true });
}
function renderSelectionPane() {
  if (!selectionPaneOpen() || !doc) return;
  // A name being typed stays until it is committed.
  if (selectionPane.querySelector(".selection-rename")) return;
  formatTools.renderSelectionPane(
    selectionPane,
    el(
      "div",
      { class: "task-pane-head" },
      el("h2", {}, "Selection"),
      iconButton("Close Selection Pane", "X", toggleSelectionPane),
    ),
  );
}
// Format Painter: the selection's formatting is picked up, and applied to the
// next object clicked; a double-click keeps it for several, until Escape.
let painter = null;
function formatPainterActive() {
  return !!painter;
}
function pickUpFormat(obj) {
  const format = {
    part: P.getSlidePartName(P.getShapeSlide(obj)),
    id: P.getShapeId(obj),
  };
  try {
    if (canEditText(obj)) format.text = { ...textFormat(obj) };
  } catch {}
  return format;
}
function formatPainter(sticky = false) {
  if (painter) {
    painter = null;
    document.querySelector(".editor")?.classList.remove("painting");
    syncToolbar();
    return;
  }
  const obj = currentShape();
  if (!obj) return;
  painter = { format: pickUpFormat(obj), sticky };
  document.querySelector(".editor")?.classList.add("painting");
  syncToolbar();
}
function paintFormat(target) {
  if (!painter) return false;
  const { format } = painter;
  mutateShape(target, (obj) => {
    const sourceSlide = slideByPart(format.part);
    const source = sourceSlide && P.findShapeById(sourceSlide, format.id);
    let changed = false;
    if (source && source !== obj) changed = P.copyShapeFormatting(source, obj);
    if (format.text && canEditText(obj)) {
      const keys = [
        "font",
        "size",
        "bold",
        "italic",
        "underline",
        "strike",
        "color",
        "underlineColor",
        "cap",
        "spc",
        "kern",
        "baseline",
        "highlight",
        "outline",
        "gradient",
        "effects",
        "normalizeHeight",
      ];
      formatText(
        withTextBody(obj),
        Object.fromEntries(
          keys
            .map((key) => [key, format.text[key]])
            .filter(([, v]) => v != null),
        ),
      );
      changed = true;
    }
    if (!changed) return SKIP_MUTATION;
  });
  if (!painter.sticky) formatPainter();
  return true;
}
// Change Case: the selected text, or the object's, retyped in another case.
function changeCase(mode) {
  const obj = currentShape();
  if (!obj || !canEditText(obj)) return;
  const convert = (value) => {
    if (mode === "upper") return value.toLocaleUpperCase();
    if (mode === "lower") return value.toLocaleLowerCase();
    if (mode === "title")
      return value
        .toLocaleLowerCase()
        .replace(
          /(^|[\s\-–—(“"'])(\p{L})/gu,
          (m, a, b) => a + b.toLocaleUpperCase(),
        );
    if (mode === "toggle")
      return [...value]
        .map((ch) =>
          ch === ch.toLocaleUpperCase()
            ? ch.toLocaleLowerCase()
            : ch.toLocaleUpperCase(),
        )
        .join("");
    // Sentence case: the first letter of each sentence capitalised.
    return value
      .toLocaleLowerCase()
      .replace(
        /(^\s*|[.!?]\s+)(\p{L})/gu,
        (m, a, b) => a + b.toLocaleUpperCase(),
      );
  };
  const editor = editorFor(obj);
  if (editor?.transform) return editor.transform(convert);
  if (isTable(obj)) return;
  mutateShape(obj, (obj) => {
    const paragraphs = textRuns(doc.pres, obj).map((p) => ({
      ...p,
      runs: p.runs.map((r) => (r.fld ? r : { ...r, text: convert(r.text) })),
    }));
    setRichText(obj, paragraphs);
  });
}
// The colour commands remember the colour last applied with each and show it
// on the button's face.
const lastColors = {
  text: { value: "#C00000", hex: "#C00000" },
  highlight: { value: "#FFFF00", hex: "#FFFF00" },
  fill: { value: "scheme:accent1", hex: null },
  line: { value: "scheme:tx1", hex: null },
  textOutline: { value: "scheme:tx1", hex: null },
  cell: { value: "scheme:accent1/lumMod=20000/lumOff=80000", hex: null },
};
function themeHex(value) {
  if (!value?.startsWith("scheme:")) return value;
  const theme = doc && P.getPresentationTheme(doc.pres);
  if (!theme) return null;
  const [token, ...mods] = value.slice(7).split("/");
  const key =
    { bg1: "light1", tx1: "dark1", bg2: "light2", tx2: "dark2" }[token] ||
    token;
  const base = `#${String(theme[key] || "000000").replace("#", "")}`;
  const mod = Object.fromEntries(
    mods.map((m) => m.split("=")).map(([k, v]) => [k, Number(v)]),
  );
  return modulate(base, mod.lumMod ?? 100000, mod.lumOff ?? 0);
}
function lastColor(kind) {
  const entry = lastColors[kind];
  return entry.hex || themeHex(entry.value);
}
function applyColor(kind, value) {
  const targets = selectedShapes();
  const obj = currentShape();
  if (kind === "text" || kind === "highlight" || kind === "textOutline") {
    if (!obj || !canEditText(obj)) return;
    if (kind === "textOutline") {
      // An outline on the text is drawn with a line round each letter.
      return applyTextFormat(obj, {
        outline: value ? { color: value, widthEmu: P.pt(0.75) } : null,
      });
    }
    return applyTextFormat(obj, {
      [kind === "text" ? "color" : "highlight"]: value,
    });
  }
  if (kind === "cell") {
    if (!obj || !isTable(obj)) return;
    return mutateShape(obj, (obj) =>
      value
        ? P.setTableCellFill(cellOf(obj), themeHex(value) || value)
        : P.clearTableCellFill(cellOf(obj)),
    );
  }
  const part = P.getSlidePartName(slide());
  const ids = targets.map(P.getShapeId);
  return mutate(() => {
    const s = slideByPart(part);
    let changed = false;
    for (const id of ids) {
      const shape = s && P.findShapeById(s, id);
      if (!shape) continue;
      const kindOf = P.getShapeKind(shape);
      if (kind === "fill") {
        if (kindOf !== "shape") continue;
        if (value) P.setShapeFill(shape, value);
        else P.setShapeNoFill(shape);
        changed = true;
      } else if (kind === "line") {
        if (!["shape", "connector", "picture"].includes(kindOf)) continue;
        if (value) {
          const current = strokeInfo(shape);
          P.setShapeStroke(shape, {
            color: value,
            widthEmu: P.pt(
              current.color
                ? current.widthPt
                : kindOf === "picture"
                  ? 1
                  : current.widthPt || 1,
            ),
          });
        } else P.setShapeNoStroke(shape);
        changed = true;
      }
    }
    return changed ? undefined : SKIP_MUTATION;
  });
}
function applyLastColor(kind) {
  return applyColor(kind, lastColors[kind].value);
}
function colorMenu(kind) {
  const theme = doc && P.getPresentationTheme(doc.pres);
  const pick = (value, hex) => {
    lastColors[kind] = { value, hex };
    applyColor(kind, value);
    syncToolbar();
  };
  const noun = {
    fill: "No Fill",
    line: "No Outline",
    highlight: "No Color",
    cell: "No Fill",
    textOutline: "No Outline",
  }[kind];
  const extra = [];
  if (kind === "line") {
    const obj = currentShape();
    const info = obj ? strokeInfo(obj) : null;
    extra.push(
      { separator: true },
      {
        label: "Weight",
        icon: "o:lineSpacing",
        disabled: !obj,
        items: [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map((w) => ({
          label: `${w} pt`,
          checked: info?.color ? info.widthPt === w : false,
          onSelect: () => setStrokeAll({ widthPt: w }),
        })),
      },
      {
        label: "Dashes",
        icon: "o:borders",
        disabled: !obj,
        items: DASHES.map(([value, label]) => ({
          label,
          checked: info?.dash === value,
          onSelect: () => setStrokeAll({ dash: value }),
        })),
      },
    );
    if (obj && isLine(obj))
      extra.push({
        label: "Arrows",
        icon: "MoveRight",
        items: [
          ["none", "none", "Line"],
          ["none", "triangle", "Arrow at end"],
          ["triangle", "none", "Arrow at start"],
          ["triangle", "triangle", "Arrows at both ends"],
          ["none", "stealth", "Pointed arrow at end"],
          ["oval", "oval", "Circles at both ends"],
        ].map(([head, tail, label]) => ({
          label,
          onSelect: () =>
            mutateShape(obj, (obj) => {
              P.setShapeStrokeArrow(obj, "head", { type: head });
              P.setShapeStrokeArrow(obj, "tail", { type: tail });
            }),
        })),
      });
  }
  if (kind === "fill" || kind === "line")
    extra.push(
      { separator: true },
      {
        label: `Format ${kind === "fill" ? "Fill" : "Outline"}…`,
        icon: "o:formatPane",
        onSelect: () => show("formatPane", true),
      },
    );
  return colorMenuItems({
    theme,
    current: lastColor(kind),
    onPick: pick,
    automatic:
      kind === "text"
        ? {
            label: "Automatic",
            icon: "o:textColor",
            onSelect: () => applyColor("text", "scheme:tx1"),
          }
        : null,
    none: noun
      ? {
          label: noun,
          icon: "Ban",
          onSelect: () => {
            applyColor(kind, null);
          },
        }
      : null,
    extra,
  });
}
function setStrokeAll(changes) {
  const part = P.getSlidePartName(slide());
  const ids = selectedShapes().map(P.getShapeId);
  return mutate(() => {
    const s = slideByPart(part);
    let changed = false;
    for (const id of ids) {
      const shape = s && P.findShapeById(s, id);
      if (
        !shape ||
        !["shape", "connector", "picture"].includes(P.getShapeKind(shape))
      )
        continue;
      const current = strokeInfo(shape);
      if (changes.widthPt != null || !current.color)
        P.setShapeStroke(shape, {
          color: current.color || themeHex("scheme:tx1") || "#000000",
          widthEmu: P.pt(changes.widthPt ?? current.widthPt ?? 1),
        });
      if (changes.dash) P.setShapeStrokeDash(shape, changes.dash);
      changed = true;
    }
    return changed ? undefined : SKIP_MUTATION;
  });
}
// Shape Effects: a shadow, kept to the effects the app can draw and save.
function effectsMenu() {
  const targets = selectedShapes().filter(canShadow);
  const on = targets.length > 0 && targets.every(hasShadow);
  const shadow = (label, preset) => ({
    label,
    checked: on && preset !== null && sameShadow(targets, preset),
    disabled: !targets.length,
    onSelect: () => setShadowAll(preset),
  });
  return [
    { header: "Shadow" },
    shadow("No Shadow", null),
    shadow("Offset: Bottom Right", { ...SHADOW, angleDeg: 45 }),
    shadow("Offset: Bottom", { ...SHADOW, angleDeg: 90 }),
    shadow("Offset: Bottom Left", { ...SHADOW, angleDeg: 135 }),
    shadow("Offset: Right", { ...SHADOW, angleDeg: 0 }),
    shadow("Offset: Center", { ...SHADOW, offsetEmu: 0, blurEmu: 76200 }),
    shadow("Perspective: Soft", {
      ...SHADOW,
      opacity: 0.25,
      blurEmu: 152400,
      offsetEmu: 76200,
      angleDeg: 90,
    }),
    { separator: true },
    {
      label: "Shadow Options…",
      icon: "o:formatPane",
      onSelect: () => show("formatPane", true),
    },
  ];
}
function sameShadow(targets, preset) {
  try {
    return targets.every((obj) => {
      const s = P.getShapeEffects(doc.pres, obj).find(
        (e) => e.kind === "outerShadow",
      );
      return (
        !!s &&
        Math.abs((s.angleDeg ?? 45) - preset.angleDeg) < 1 &&
        Math.abs((s.distEmu ?? s.offsetEmu ?? 0) - preset.offsetEmu) < 2
      );
    });
  } catch {
    return false;
  }
}
function setShadowAll(preset) {
  const part = P.getSlidePartName(slide());
  const ids = selectedShapes().filter(canShadow).map(P.getShapeId);
  return mutate(() => {
    const s = slideByPart(part);
    let changed = false;
    for (const id of ids) {
      const obj = s && P.findShapeById(s, id);
      if (!obj) continue;
      if (preset) P.setShapeShadow(obj, preset);
      else if (hasShadow(obj)) P.clearShapeEffects(obj);
      else continue;
      changed = true;
    }
    return changed ? undefined : SKIP_MUTATION;
  });
}
// Quick Styles and the Shape Styles gallery: theme-coloured fills and
// outlines in three patterns (outline only, a solid fill with a light
// outline, a light fill with a coloured outline).
const STYLE_ACCENTS = [
  "tx1",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
];
function shapeStyleChoices() {
  const out = [];
  const rows = [
    [
      "Colored Outline",
      (a) => ({
        fill: "scheme:bg1",
        line: `scheme:${a}`,
        text: `scheme:${a === "tx1" ? "tx1" : "tx1"}`,
      }),
    ],
    [
      "Colored Fill",
      (a) => ({
        fill: `scheme:${a}`,
        line: `scheme:${a}/lumMod=75000`,
        text: "scheme:bg1",
      }),
    ],
    [
      "Light 1 Outline, Colored Fill",
      (a) => ({ fill: `scheme:${a}`, line: "scheme:bg1", text: "scheme:bg1" }),
    ],
    [
      "Subtle Effect",
      (a) => ({
        fill: `scheme:${a}/lumMod=20000/lumOff=80000`,
        line: `scheme:${a}`,
        text: "scheme:tx1",
      }),
    ],
    [
      "Moderate Effect",
      (a) => ({
        fill: `scheme:${a}/lumMod=60000/lumOff=40000`,
        line: "none",
        text: "scheme:tx1",
      }),
    ],
    [
      "Intense Effect",
      (a) => ({
        fill: `scheme:${a}/lumMod=75000`,
        line: "none",
        text: "scheme:bg1",
        shadow: true,
      }),
    ],
  ];
  for (const [rowLabel, make] of rows)
    for (const accent of STYLE_ACCENTS) {
      const style = make(accent);
      const name = accent === "tx1" ? "Dark 1" : `Accent ${accent.slice(-1)}`;
      out.push({
        id: `${rowLabel}|${accent}`,
        label: `${rowLabel} - ${name}`,
        style,
        render: () => {
          const fill = themeHex(style.fill) || "#fff";
          const line =
            style.line === "none"
              ? "transparent"
              : themeHex(style.line) || "#000";
          return el(
            "span",
            {
              class: "style-swatch",
              style: `background:${fill};border-color:${line};color:${themeHex(style.text) || "#000"};${style.shadow ? "box-shadow:1px 2px 3px rgb(0 0 0 / .35);" : ""}`,
            },
            "Abc",
          );
        },
      });
    }
  return out;
}
function applyShapeStyle(id) {
  const choice = shapeStyleChoices().find((c) => c.id === id);
  if (!choice) return;
  const { style } = choice;
  const part = P.getSlidePartName(slide());
  const ids = selectedShapes().map(P.getShapeId);
  return mutate(() => {
    const s = slideByPart(part);
    let changed = false;
    for (const sid of ids) {
      const obj = s && P.findShapeById(s, sid);
      if (!obj) continue;
      const kind = P.getShapeKind(obj);
      if (kind === "shape") {
        P.setShapeFill(obj, style.fill);
        if (style.line === "none") P.setShapeNoStroke(obj);
        else P.setShapeStroke(obj, { color: style.line, widthEmu: P.pt(1) });
        if (canShadow(obj)) {
          if (style.shadow) P.setShapeShadow(obj, SHADOW);
          else if (hasShadow(obj)) P.clearShapeEffects(obj);
        }
        if (hasTextBody(obj) && firstTextElement(obj))
          P.setShapeTextFormat(obj, { color: style.text });
        changed = true;
      } else if (kind === "connector") {
        P.setShapeStroke(obj, {
          color: style.line === "none" ? style.fill : style.line,
          widthEmu: P.pt(1.5),
        });
        changed = true;
      }
    }
    return changed ? undefined : SKIP_MUTATION;
  });
}
function quickStylesMenu() {
  const grid = el("div", {
    class: "quick-styles",
    role: "group",
    "aria-label": "Quick Styles",
  });
  for (const choice of shapeStyleChoices())
    grid.append(
      el(
        "button",
        {
          type: "button",
          class: "quick-style",
          role: "menuitem",
          tabindex: -1,
          "aria-label": choice.label,
          title: choice.label,
          onclick: () => {
            closeMenu();
            applyShapeStyle(choice.id);
          },
        },
        choice.render(),
      ),
    );
  return [{ custom: grid }];
}
// A picker grid for the Table command: hover to size the table, click to
// insert it; or Insert Table… for a dialog.
function tableMenu() {
  const grid = el("div", {
    class: "table-picker",
    role: "grid",
    "aria-label": "Insert table",
  });
  const label = el("div", { class: "table-picker-label" }, "Insert Table");
  const cells = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 10; c++) {
      const cell = el("button", {
        type: "button",
        class: "table-picker-cell",
        role: "gridcell",
        tabindex: -1,
        "aria-label": `${c + 1} by ${r + 1} table`,
        onpointerenter: () => mark(r, c),
        onfocus: () => mark(r, c),
        onclick: () => {
          closeMenu();
          insertTable(r + 1, c + 1);
        },
      });
      cell.dataset.r = r;
      cell.dataset.c = c;
      cells.push(cell);
      grid.append(cell);
    }
  function mark(r, c) {
    for (const cell of cells)
      cell.classList.toggle(
        "on",
        Number(cell.dataset.r) <= r && Number(cell.dataset.c) <= c,
      );
    label.textContent = `${c + 1}x${r + 1} Table`;
  }
  return [
    { custom: el("div", { class: "table-picker-wrap" }, label, grid) },
    { separator: true },
    { label: "Insert Table…", icon: "o:table", onSelect: run(tableDialog) },
  ];
}
function tableInsert(where) {
  const map = {
    rowAbove: (obj, row) => P.insertTableRow(obj, row),
    rowBelow: (obj, row) => P.insertTableRow(obj, row + 1),
    colLeft: (obj, row, col) => P.insertTableColumn(obj, col),
    colRight: (obj, row, col) => P.insertTableColumn(obj, col + 1),
  };
  return tableAction(map[where]);
}
function tableDeleteMenu() {
  return [
    {
      label: "Delete Columns",
      icon: "o:deleteColumns",
      onSelect: () =>
        tableAction((obj, row, col) => {
          if (P.getTableDimensions(obj).cols < 2) return SKIP_MUTATION;
          P.removeTableColumn(obj, col);
        }),
    },
    {
      label: "Delete Rows",
      icon: "o:deleteRows",
      onSelect: () =>
        tableAction((obj, row) => {
          if (P.getTableDimensions(obj).rows < 2) return SKIP_MUTATION;
          P.removeTableRow(obj, row);
        }),
    },
    { label: "Delete Table", icon: "o:deleteTable", onSelect: deleteObject },
  ];
}
function distributeTable(axis) {
  const obj = currentShape();
  if (!obj || !isTable(obj)) return;
  mutateShape(obj, (obj) => {
    if (axis === "cols") {
      const widths = P.getTableColumnWidths(obj);
      const total = widths.reduce((a, b) => a + b, 0);
      widths.forEach((_, i) =>
        P.setTableColumnWidth(obj, i, Math.round(total / widths.length)),
      );
    } else if (P.getTableRowHeights && P.setTableRowHeight) {
      const heights = P.getTableRowHeights(obj);
      const total = heights.reduce((a, b) => a + b, 0);
      heights.forEach((_, i) =>
        P.setTableRowHeight(obj, i, Math.round(total / heights.length)),
      );
    } else return SKIP_MUTATION;
  });
}
// The size of the selection in inches, for the Height and Width boxes.
function selectionSize(axis) {
  const obj = currentShape();
  if (!obj) return null;
  const b = slideBounds(doc.pres, obj);
  if (!b) return null;
  return Math.round(((axis === "h" ? b.h : b.w) / 914400) * 100) / 100;
}
function setSelectionSize(axis, inches) {
  const obj = currentShape();
  if (!obj) return;
  mutateShape(obj, (obj) => {
    const b = slideBounds(doc.pres, obj);
    if (!b) return SKIP_MUTATION;
    const value = Math.round(inches * 914400);
    // Pictures keep their proportions by default.
    const keep =
      (P.getShapeKind(obj) === "picture" || P.getShapeAspectLock(obj)) &&
      b.w > 0 &&
      b.h > 0;
    const next =
      axis === "h"
        ? { ...b, h: value, w: keep ? Math.round((b.w * value) / b.h) : b.w }
        : { ...b, w: value, h: keep ? Math.round((b.h * value) / b.w) : b.h };
    setSlideBounds(doc.pres, obj, next);
  });
}
// The Section command: sections group the slides in the thumbnails pane.
function sectionMenu() {
  const sections = (() => {
    try {
      return P.getSlideSections(doc.pres) || [];
    } catch {
      return [];
    }
  })();
  const part = P.getSlidePartName(slide());
  const here = sections.find((sec) =>
    sec.slides?.some((s) => P.getSlidePartName(s) === part),
  );
  return [
    { label: "Add Section", icon: "o:section", onSelect: run(addSection) },
    {
      label: "Rename Section",
      icon: "Pencil",
      disabled: !here,
      onSelect: run(() => renameSection(here)),
    },
    {
      label: "Remove Section",
      icon: "Trash2",
      disabled: !here,
      onSelect: () => removeSections(here ? [here] : []),
    },
    { separator: true },
    {
      label: "Remove All Sections",
      icon: "Trash2",
      disabled: !sections.length,
      onSelect: () => removeSections(sections),
    },
  ];
}
function sectionList() {
  try {
    return (P.getSlideSections(doc.pres) || []).map((sec) => ({
      name: sec.name,
      slides: sec.slides.map(P.getSlidePartName),
    }));
  } catch {
    return [];
  }
}
function writeSections(list) {
  mutate(() => {
    const byPart = new Map(
      P.getSlides(doc.pres).map((s) => [P.getSlidePartName(s), s]),
    );
    P.setSlideSections(
      doc.pres,
      list.map((sec) => ({
        name: sec.name,
        slides: sec.slides.map((p) => byPart.get(p)).filter(Boolean),
      })),
    );
  });
}
async function addSection() {
  const name = await promptName("Rename Section", "Untitled Section", null, {
    confirm: "Rename",
  });
  if (!name) return;
  const parts = P.getSlides(doc.pres).map(P.getSlidePartName);
  const at = Math.max(0, index);
  let list = sectionList();
  if (!list.length) {
    list =
      at > 0
        ? [
            { name: "Default Section", slides: parts.slice(0, at) },
            { name, slides: parts.slice(at) },
          ]
        : [{ name, slides: parts }];
  } else {
    const part = parts[at];
    const i = list.findIndex((sec) => sec.slides.includes(part));
    const sec = list[i];
    const k = sec.slides.indexOf(part);
    const head = { ...sec, slides: sec.slides.slice(0, k) };
    const tail = { name, slides: sec.slides.slice(k) };
    list.splice(i, 1, ...(head.slides.length ? [head, tail] : [tail]));
  }
  writeSections(list);
}
async function renameSection(section) {
  if (!section) return;
  const name = await promptName("Rename Section", section.name, null, {
    confirm: "Rename",
  });
  if (!name) return;
  const list = sectionList();
  const first = P.getSlidePartName(section.slides[0]);
  const target = list.find(
    (sec) => sec.slides[0] === first && sec.name === section.name,
  );
  if (target) target.name = name;
  writeSections(list);
}
function removeSections(sections) {
  if (!sections.length) return;
  const names = new Set(
    sections.map(
      (sec) => `${sec.name}|${P.getSlidePartName(sec.slides[0] || slide())}`,
    ),
  );
  const list = sectionList();
  const kept = [];
  for (const sec of list) {
    if (
      names.has(`${sec.name}|${sec.slides[0] || P.getSlidePartName(slide())}`)
    ) {
      // A removed section's slides join the section before it.
      if (kept.length) kept.at(-1).slides.push(...sec.slides);
      else if (list.length > 1) kept.push({ ...sec, name: "Default Section" });
    } else kept.push(sec);
  }
  writeSections(
    kept.length === list.length - sections.length || kept.length
      ? kept.filter((s) => s.slides.length)
      : [],
  );
}
// The Symbol command: a grid of characters to insert at the text cursor.
const SYMBOLS =
  "©®™°±×÷≠≈≤≥∞√∑∏∫∂πΩµαβγδθλσφψω€£¥¢§¶•…–—‘’“”«»←↑→↓↔⇒⇔✓✗★☆♥♦♣♠☐☑☒";
async function insertSymbol() {
  const obj = currentShape();
  if (!obj || !canEditText(obj)) return;
  let chosen = null;
  // One tab stop: the arrow keys move between the symbols (twelve a row, as
  // drawn), Home and End go to the first and the last.
  const COLUMNS = 12;
  const grid = el("div", {
    class: "symbol-grid",
    role: "group",
    "aria-label": "Symbols",
    onkeydown: (e) => {
      const cells = [...grid.children];
      const at = cells.indexOf(document.activeElement);
      if (at < 0) return;
      const step = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -COLUMNS,
        ArrowDown: COLUMNS,
      }[e.key];
      let next = null;
      if (step) next = at + step;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = cells.length - 1;
      if (next == null) return;
      e.preventDefault();
      const cell = cells[Math.max(0, Math.min(cells.length - 1, next))];
      for (const c of cells) c.tabIndex = c === cell ? 0 : -1;
      cell.focus();
    },
  });
  for (const [i, ch] of [...SYMBOLS].entries())
    grid.append(
      el(
        "button",
        {
          type: "button",
          class: "symbol-cell",
          "aria-label": ch,
          tabindex: i === 0 ? 0 : -1,
          onclick: (e) => {
            chosen = ch;
            e.currentTarget
              .closest("dialog")
              ?.dispatchEvent(new Event("cancel"));
          },
        },
        ch,
      ),
    );
  await dialog({
    title: "Symbol",
    body: el("div", { class: "dialog-body" }, grid),
    cancel: "Cancel",
    confirm: null,
  });
  if (chosen) insertTextAtCursor(obj, chosen);
}
// Text added to an object: at the cursor while it is edited, otherwise at the
// end of its text.
function insertTextAtCursor(obj, value) {
  const editor = editorFor(obj);
  if (editor?.insertText) return editor.insertText(value);
  if (isTable(obj)) return;
  mutateShape(obj, (obj) => {
    const paragraphs = textRuns(doc.pres, obj);
    const last = paragraphs.at(-1);
    if (last?.runs.length) last.runs.at(-1).text += value;
    else if (last) last.runs.push({ text: value, format: {} });
    setRichText(withTextBody(obj), paragraphs);
  });
}
function dateTimeMenu() {
  const now = new Date();
  const formats = [
    { month: "numeric", day: "numeric", year: "numeric" },
    { weekday: "long", month: "long", day: "numeric", year: "numeric" },
    { day: "numeric", month: "long", year: "numeric" },
    { month: "long", day: "numeric", year: "numeric" },
    { year: "numeric", month: "2-digit", day: "2-digit" },
    { month: "long", year: "numeric" },
    { hour: "numeric", minute: "2-digit" },
    { hour: "numeric", minute: "2-digit", second: "2-digit" },
  ];
  return formats.map((f) => {
    const value = new Intl.DateTimeFormat(undefined, f).format(now);
    return {
      label: value,
      onSelect: () => insertTextAtCursor(currentShape(), value),
    };
  });
}
// The number goes in as a live field, so it follows the slide when slides
// are added, removed, or moved.
function insertSlideNumber() {
  const obj = currentShape();
  if (!obj) return;
  const value = String(index + 1);
  const field = (source) => slideNumberRun(source, value);
  const editor = editorFor(obj);
  if (editor) return editor.insertField(value, field);
  if (isTable(obj)) return;
  mutateShape(obj, (obj) => {
    const paragraphs = textRuns(doc.pres, obj);
    const last = paragraphs.at(-1);
    if (last) last.runs.push(field(last.runs.at(-1)));
    setRichText(withTextBody(obj), paragraphs);
  });
}
// WordArt: a text box styled as one of a few decorative presets.
const WORDART = [
  [
    "Fill: Black, Text color 1; Shadow",
    { color: "scheme:tx1", bold: false },
    true,
  ],
  [
    "Fill: Blue, Accent color 1; Shadow",
    { color: "scheme:accent1", bold: false },
    true,
  ],
  [
    "Fill: Orange, Accent color 2; Outline",
    { color: "scheme:accent2", bold: true },
    false,
  ],
  [
    "Fill: White; Outline: Blue, Accent color 1",
    {
      color: "scheme:bg1",
      bold: true,
      outline: { color: "scheme:accent1", widthEmu: P.pt(0.75) },
    },
    true,
  ],
  [
    "Gradient Fill: Gold, Accent color 4",
    {
      bold: true,
      gradient: {
        stops: [
          { offset: 0, color: "scheme:accent4/lumMod=60000/lumOff=40000" },
          { offset: 1, color: "scheme:accent4/lumMod=75000" },
        ],
        angleDeg: 90,
      },
    },
    false,
  ],
  [
    "Fill: Gray, Background color 2; Inner Shadow",
    { color: "scheme:bg2/lumMod=50000", bold: true },
    false,
  ],
];
function wordArtMenu() {
  const grid = el("div", {
    class: "wordart-grid",
    role: "group",
    "aria-label": "WordArt styles",
  });
  WORDART.forEach(([label, format, shadow]) => {
    const hex = themeHex(format.color) || "#000";
    // Each choice shows the text as it goes in: its fill, gradient, outline.
    const fill = format.gradient
      ? `background:linear-gradient(${format.gradient.stops.map((s) => `${themeHex(s.color) || "#000"} ${s.offset * 100}%`).join(", ")});-webkit-background-clip:text;background-clip:text;color:transparent;`
      : `color:${hex};`;
    const stroke = format.outline
      ? `-webkit-text-stroke:1px ${themeHex(format.outline.color) || "#000"};`
      : "";
    grid.append(
      el(
        "button",
        {
          type: "button",
          role: "menuitem",
          tabindex: -1,
          class: "wordart-choice",
          "aria-label": label,
          title: label,
          onclick: () => {
            closeMenu();
            insertWordArt(format, shadow);
          },
        },
        el(
          "span",
          {
            style: `${fill}${stroke}${shadow ? "text-shadow:1px 1px 2px rgb(0 0 0 / .35);" : ""}font-weight:${format.bold ? 700 : 400}`,
          },
          "A",
        ),
      ),
    );
  });
  return [{ custom: grid }];
}
function insertWordArt(format, shadow) {
  commitText();
  mutateSlide(slide(), (target) => {
    const size = currentSize();
    const w = 7.5,
      h = 1.4;
    const s = text(
      target,
      "Your text here",
      (size.cx / 914400 - w) / 2,
      (size.cy / 914400 - h) / 2,
      w,
      h,
      54,
      "#000000",
    );
    P.setShapeTextFormat(s, { ...format });
    P.setParagraphAlignment(s, 0, "center");
    if (shadow && canShadow(s))
      P.setShapeShadow(s, { ...SHADOW, opacity: 0.35 });
    selectIds([P.getShapeId(s)]);
  });
  setTimeout(() => {
    const obj = currentShape();
    if (obj) editText(obj);
  });
}
// Shapes: every shape the app draws, grouped by kind. Choosing one arms the
// drawing tool; a click or drag on the slide places it.
function shapesMenu() {
  const grid = (title, list) => {
    const node = el("div", {
      class: "shape-gallery-row",
      role: "group",
      "aria-label": title,
    });
    for (const [preset, label] of list)
      node.append(
        el(
          "button",
          {
            type: "button",
            class: "shape-choice",
            role: "menuitem",
            tabindex: -1,
            "aria-label": label,
            title: label,
            onclick: () => {
              closeMenu();
              startDrawing(preset);
            },
          },
          shapeGlyph(preset),
        ),
      );
    return [{ header: title }, { custom: node }];
  };
  return [
    ...grid("Lines", [
      ["line", "Line"],
      ["arrow", "Line Arrow"],
    ]),
    ...grid("Rectangles", [
      ["rect", "Rectangle"],
      ["roundRect", "Rectangle: Rounded Corners"],
    ]),
    ...grid(
      "Basic Shapes",
      SHAPES.filter(
        ([p]) =>
          !["rect", "roundRect", "star5", "wedgeRectCallout"].includes(p),
      ).map(([p, l]) => [p, l]),
    ),
    ...grid(
      "Block Arrows",
      ARROW_SHAPES.map(([p, l]) => [p, l]),
    ),
    ...grid("Stars and Banners", [["star5", "Star: 5 Points"]]),
    ...grid("Callouts", [["wedgeRectCallout", "Speech Bubble: Rectangle"]]),
  ];
}
// A small drawing of a preset for the gallery, from the same geometry the
// slide renders.
function shapeGlyph(preset) {
  const paths = {
    line: "M3 17 17 3",
    arrow: "M3 17 15.5 4.5M10 4h6v6",
    rect: "M3 5h14v10H3z",
    roundRect:
      "M6 5h8a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z",
    ellipse: "M10 4a7 6 0 1 1 0 12a7 6 0 1 1 0-12z",
    triangle: "M10 3 17 17H3z",
    rtTriangle: "M3 3v14h14z",
    diamond: "M10 2l8 8-8 8-8-8z",
    pentagon: "M10 2.5 17.5 8l-2.8 9H5.3L2.5 8z",
    hexagon: "M6 3h8l4 7-4 7H6l-4-7z",
    octagon: "M7 2.5h6l4.5 4.5v6L13 17.5H7L2.5 13V7z",
    star5:
      "M10 2l2.3 5.3 5.7.5-4.3 3.8 1.3 5.6L10 14.3 5 17.2l1.3-5.6L2 7.8l5.7-.5z",
    heart:
      "M10 17S3 12.5 3 7.8A3.6 3.6 0 0 1 10 6a3.6 3.6 0 0 1 7 1.8C17 12.5 10 17 10 17z",
    cloud:
      "M6 16a3.5 3.5 0 0 1-.5-7 4.5 4.5 0 0 1 8.6-1.4A3.5 3.5 0 0 1 15 16z",
    plus: "M7.5 3h5v4.5H17v5h-4.5V17h-5v-4.5H3v-5h4.5z",
    wedgeRectCallout: "M3 4h14v9H9l-4 4v-4H3z",
    rightArrow: "M2.5 7.5h9V4l6 6-6 6v-3.5h-9z",
    leftArrow: "M17.5 7.5h-9V4l-6 6 6 6v-3.5h9z",
    upArrow: "M7.5 17.5v-9H4l6-6 6 6h-3.5v9z",
    downArrow: "M7.5 2.5v9H4l6 6 6-6h-3.5v-9z",
    leftRightArrow: "M2 10l4-4.5v2.5h8V5.5l4 4.5-4 4.5V12H6v2.5z",
    chevron: "M3 4h9l5 6-5 6H3l5-6z",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "shape-glyph");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[preset] || paths.rect);
  svg.append(path);
  return svg;
}
// The drawing tool: armed by Shapes or Text Box, a click on the slide places
// the object at its default size there, and a drag draws it to the size
// dragged (Shift keeps it in proportion). Escape disarms it.
let drawingTool = null;
function startDrawing(preset) {
  if (drawingTool === preset && preset === "text") return cancelDrawing();
  drawTools.stop();
  drawingTool = preset;
  document.querySelector(".editor")?.classList.add("drawing");
  syncToolbar();
}
function cancelDrawing() {
  drawingTool = null;
  document.querySelector(".editor")?.classList.remove("drawing");
  document.querySelector(".draw-preview")?.remove();
  syncToolbar();
}
function drawOnCanvas(e) {
  if (!drawingTool || e.button !== 0) return false;
  e.preventDefault();
  e.stopPropagation();
  const canvas = document.querySelector("#slide-canvas");
  const rect = canvas.getBoundingClientRect();
  const size = currentSize();
  const toEmu = (px, total, emu) =>
    Math.round(
      ((px - total) / rect[emu === "cx" ? "width" : "height"]) * size[emu],
    );
  const start = { x: e.clientX, y: e.clientY };
  const preview = el("div", { class: "draw-preview" });
  canvas.append(preview);
  const tool = drawingTool;
  let end = start;
  const box = (shift) => {
    let dx = end.x - start.x,
      dy = end.y - start.y;
    if (shift && tool !== "line" && tool !== "arrow") {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * d;
      dy = Math.sign(dy || 1) * d;
    }
    return {
      x: Math.min(start.x, start.x + dx),
      y: Math.min(start.y, start.y + dy),
      w: Math.abs(dx),
      h: Math.abs(dy),
      dx,
      dy,
    };
  };
  const move = (ev) => {
    end = { x: ev.clientX, y: ev.clientY };
    const b = box(ev.shiftKey);
    Object.assign(preview.style, {
      left: `${b.x - rect.left}px`,
      top: `${b.y - rect.top}px`,
      width: `${b.w}px`,
      height: `${b.h}px`,
    });
  };
  const up = (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    preview.remove();
    // The click that ends the drag is the drawing's, not a click on the
    // empty slide that would clear the selection.
    marqueeEnded = performance.now();
    // Escape during the drag put the tool down: nothing is drawn.
    if (drawingTool !== tool) return;
    end = { x: ev.clientX, y: ev.clientY };
    const b = box(ev.shiftKey);
    const dragged = b.w > 4 || b.h > 4;
    cancelDrawing();
    placeDrawn(
      tool,
      dragged
        ? {
            x: toEmu(b.x, rect.left, "cx"),
            y: toEmu(b.y, rect.top, "cy"),
            w: Math.max(1, Math.round((b.w / rect.width) * size.cx)),
            h: Math.max(1, Math.round((b.h / rect.height) * size.cy)),
            flipH: b.dx < 0,
            flipV: b.dy < 0,
          }
        : {
            x: toEmu(start.x, rect.left, "cx"),
            y: toEmu(start.y, rect.top, "cy"),
            click: true,
          },
    );
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  return true;
}
async function placeDrawn(tool, at) {
  commitText();
  // Master view's Insert Placeholder draws a placeholder on the layout.
  if (tool.startsWith("placeholder:"))
    return masterView.placePlaceholder(tool.slice("placeholder:".length), at);
  const isText = tool === "text";
  const applied = await addObject(isText ? "text" : tool, (obj) => {
    const b = slideBounds(doc.pres, obj);
    if (!b) return;
    const size = currentSize();
    let next;
    if (at.click) {
      // A click places the default size with its corner where clicked; a
      // text box starts one line high and grows as it is typed into.
      const w = isText ? Math.min(b.w, P.inches(3)) : b.w;
      next = {
        ...b,
        w,
        x: Math.max(0, Math.min(at.x, size.cx - w)),
        y: Math.max(0, Math.min(at.y, size.cy - b.h)),
      };
    } else {
      next = {
        ...b,
        x: at.x,
        y: at.y,
        w: at.w,
        h: isText ? Math.max(at.h, b.h) : at.h,
      };
      // A line drawn up and to the right runs between the drag's corners.
      if ((tool === "line" || tool === "arrow") && at.flipH !== at.flipV)
        P.setShapeFlip(obj, { vertical: true, horizontal: false });
    }
    setSlideBounds(doc.pres, obj, next);
    if (isText) setText(obj, "");
    insertFeatures.afterDraw(obj, tool, at);
  });
  if (!applied) return;
  ribbon?.select("shape-format");
  if (isText) {
    const obj = currentShape();
    if (obj) editText(obj, null, { inserted: history.bytes });
  }
}
// The ribbon's command surface: what tabs.js may call.
function ribbonApi() {
  const textTarget = () => {
    const obj = currentShape();
    return obj && canEditText(obj) ? obj : null;
  };
  const fmtNow = () => {
    const obj = textTarget();
    if (!obj) return {};
    return editorFor(obj)?.selectionFormat() || textFormat(obj);
  };
  const kindOfSelection = () => {
    const list = selectedShapes();
    if (!list.length) return null;
    if (list.length === 1 && isTable(list[0])) return "table";
    if (list.length === 1 && chartTools.isChart(list[0])) return "chart";
    if (list.length === 1 && smartArtTools.isSmartArt(list[0]))
      return "smartart";
    if (list.every((s) => P.getShapeKind(s) === "picture")) return "picture";
    return "shape";
  };
  const base = {
    extraTabs: () => extraTabProviders.flatMap((provide) => provide()),
    insertChart: () => chartTools.insert(),
    ...(P.addSlideSmartArt
      ? {
          insertSmartArt: () => smartArtTools.insert(),
          canConvertToSmartArt: () => smartArtTools.canConvert(),
          convertToSmartArtMenu: () => smartArtTools.convertMenu(),
        }
      : {}),
    modKey: MOD_KEY,
    newSlideKeys: IS_MAC ? "⌘+Shift+N" : "Ctrl+M",
    selection: () => selectedShapes(),
    selectionKind: kindOfSelection,
    textTarget,
    textFormat: fmtNow,
    // Clipboard
    paste: () => pasteFromMenu(),
    pasteMenu: () => [
      {
        label: "Paste",
        icon: "o:paste",
        shortcut: `${MOD_KEY}+V`,
        onSelect: () => pasteFromMenu().catch(fail),
      },
      {
        label: "Paste as Text Only",
        icon: "o:textBox",
        onSelect: run(async () => {
          const value = await navigator.clipboard?.readText?.();
          if (value) pasteText(value);
        }),
      },
      { separator: true },
      {
        label: "Duplicate",
        icon: "o:duplicate",
        shortcut: `${MOD_KEY}+D`,
        disabled: !currentShape(),
        onSelect: duplicateObject,
      },
    ],
    cut: () => copyObjects({ cut: true }),
    copy: () => copyObjects(),
    formatPainter: () => formatPainter(),
    formatPainterActive,
    // Slides
    newSlide: () => addSlideAfter(slide()),
    newSlideMenu: () => [
      ...layoutItems(slide()),
      { separator: true },
      {
        label: "Duplicate Selected Slides",
        icon: "o:duplicate",
        onSelect: () => duplicateSlides(actionSlides(slide())),
      },
      ...slidesFrom.menuItems(),
      ...(assistant
        ? [
            {
              label: "New Slide from Prompt…",
              icon: "o:newSlidePrompt",
              onSelect: () => newSlideFromPrompt().catch(fail),
            },
          ]
        : []),
    ],
    canChangeLayout: () => layoutCommands.canChangeLayout(),
    layoutMenu: () => layoutCommands.layoutItems(actionSlides(slide())),
    canResetSlide: () => layoutCommands.canReset(),
    resetSlide: () => layoutCommands.resetSlides(actionSlides(slide())),
    masterView: (kind) => setView(masterView.viewId(kind)),
    masterViewActive: () => masterView.active,
    sectionMenu,
    // Font
    fontList: () => FONTS,
    fontPreviewFamily: (name) => `"${name}", system-ui`,
    fontSizes: () => FONT_SIZES,
    applyText: (format) => {
      const obj = textTarget();
      if (obj) return applyTextFormat(obj, format);
    },
    stepTextSize: (direction) => {
      const obj = textTarget();
      if (obj) stepTextSize(obj, direction);
    },
    toggleText: (key) => {
      const obj = textTarget();
      if (obj) toggleTextFormat(obj, key);
    },
    textToggleState: (key) => {
      if (!textTarget()) return false;
      const fmt = fmtNow();
      return key === "underline" || key === "strike"
        ? decorated(fmt[key])
        : !!fmt[key];
    },
    clearFormatting: () => {
      const obj = textTarget();
      if (!obj) return;
      applyTextFormat(obj, {
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        baseline: 0,
        spc: 0,
        highlight: null,
        cap: "none",
      });
    },
    toggleBaseline: (amount) => {
      const obj = textTarget();
      if (!obj) return;
      const current = fmtNow().baseline || 0;
      applyTextFormat(obj, {
        baseline: Math.sign(current) === Math.sign(amount) ? 0 : amount / 100,
      });
    },
    charSpacingMenu: () => {
      const current = fmtNow().spc || 0;
      return [
        ["Very Tight", -300],
        ["Tight", -150],
        ["Normal", 0],
        ["Loose", 300],
        ["Very Loose", 600],
      ].map(([label, spc]) => ({
        label,
        checked: current === spc,
        onSelect: () => applyTextFormat(textTarget(), { spc }),
      }));
    },
    changeCaseMenu: () =>
      [
        ["sentence", "Sentence case."],
        ["lower", "lowercase"],
        ["upper", "UPPERCASE"],
        ["title", "Capitalize Each Word"],
        ["toggle", "tOGGLE cASE"],
      ].map(([mode, label]) => ({ label, onSelect: () => changeCase(mode) })),
    lastColor,
    applyLastColor,
    colorMenu,
    canTextOutline: () => true,
    // Paragraph
    canList: () => {
      const obj = textTarget();
      return !!obj && !isTable(obj);
    },
    listStyle: () => {
      const obj = textTarget();
      return obj ? listStyle(obj) : "none";
    },
    toggleList: (style) => {
      const obj = textTarget();
      if (obj) toggleList(obj, style);
    },
    bulletMenu: () => {
      const obj = textTarget();
      const current = obj ? listStyle(obj) : "none";
      return [
        {
          label: "None",
          checked: current === "none",
          onSelect: () =>
            current !== "none" && toggleList(textTarget(), current),
        },
        {
          label: "Filled Round Bullets",
          checked: current === "bullet",
          onSelect: () =>
            current !== "bullet" && toggleList(textTarget(), "bullet"),
        },
      ];
    },
    numberingMenu: () => {
      const obj = textTarget();
      const current = obj ? listStyle(obj) : "none";
      return [
        {
          label: "None",
          checked: current === "none",
          onSelect: () =>
            current !== "none" && toggleList(textTarget(), current),
        },
        {
          label: "1. 2. 3.",
          checked: current === "number",
          onSelect: () =>
            current !== "number" && toggleList(textTarget(), "number"),
        },
      ];
    },
    indent: (delta) => {
      const obj = textTarget();
      if (obj) changeIndent(obj, delta);
    },
    lineSpacingMenu: () => {
      const obj = textTarget();
      const current = obj ? lineSpacing(obj) : null;
      return [
        ...[
          [1, "1.0"],
          [1.15, "1.15"],
          [1.5, "1.5"],
          [2, "2.0"],
          [2.5, "2.5"],
          [3, "3.0"],
        ].map(([value, label]) => ({
          label,
          checked: current === value,
          onSelect: () => setLineSpacing(textTarget(), value),
        })),
        { separator: true },
        {
          label: "Line Spacing Options…",
          icon: "o:formatPane",
          onSelect: () => show("formatPane", true),
        },
      ];
    },
    canColumns: () => {
      const obj = textTarget();
      return !!obj && !isTable(obj) && !!P.setShapeTextColumns;
    },
    columnsMenu: () =>
      [1, 2, 3].map((n) => ({
        label: ["One Column", "Two Columns", "Three Columns"][n - 1],
        checked: (P.getShapeTextColumns?.(textTarget())?.count || 1) === n,
        onSelect: () =>
          mutateShape(textTarget(), (obj) =>
            P.setShapeTextColumns(obj, { count: n }),
          ),
      })),
    textDirectionMenu: () =>
      [
        ["horz", "Horizontal"],
        ["vert", "Rotate all text 90°"],
        ["vert270", "Rotate all text 270°"],
        ["wordArtVert", "Stacked"],
      ].map(([value, label]) => ({
        label,
        checked: (P.getShapeTextDirection?.(textTarget()) || "horz") === value,
        onSelect: () =>
          mutateShape(textTarget(), (obj) =>
            P.setShapeTextDirection(obj, value),
          ),
      })),
    alignment: () => {
      const obj = textTarget();
      return obj ? paragraphAlignment(obj) : null;
    },
    setAlignment: (value) => {
      const obj = textTarget();
      if (obj) setAlignment(obj, value);
    },
    anchor: () => {
      const obj = textTarget();
      return obj ? textAnchor(obj) : null;
    },
    setAnchor: (value) => {
      const obj = textTarget();
      if (obj) setAnchor(obj, value);
    },
    alignTextMenu: () => {
      const obj = textTarget();
      const current = obj ? textAnchor(obj) : null;
      return TEXT_ANCHORS.map(([value, label]) => ({
        label:
          { top: "Top", center: "Middle", bottom: "Bottom" }[value] || label,
        icon: `o:${{ top: "valignTop", center: "valignMiddle", bottom: "valignBottom" }[value]}`,
        checked: current === value,
        onSelect: () => setAnchor(textTarget(), value),
      }));
    },
    // Drawing
    insertPicture: () => insertImage(),
    pictureMenu: () => [
      {
        label: "Picture from File…",
        icon: "o:pictures",
        onSelect: () => insertImage(),
      },
      {
        label: "Picture from Clipboard",
        icon: "o:paste",
        onSelect: () => pasteFromMenu().catch(fail),
      },
    ],
    shapesMenu,
    drawingTool: () => drawingTool,
    startDrawing,
    arrangeMenu: () => {
      const obj = currentShape();
      return [
        { header: "Order Objects" },
        ...orderItems(obj),
        { header: "Group Objects" },
        ...arrangeItems().filter(
          (i) => i.label === "Group" || i.label === "Ungroup",
        ),
        { header: "Position Objects" },
        ...arrangeItems().filter(
          (i) => !["Group", "Ungroup"].includes(i.label) && !i.separator,
        ),
        { separator: true },
        {
          label: "Selection Pane…",
          icon: "o:selectionPane",
          onSelect: toggleSelectionPane,
        },
      ];
    },
    canStyleShape: () =>
      selectedShapes().some((s) =>
        ["shape", "connector"].includes(P.getShapeKind(s)),
      ),
    quickStylesMenu,
    canFill: () => selectedShapes().some((s) => P.getShapeKind(s) === "shape"),
    canOutline: () =>
      selectedShapes().some((s) =>
        ["shape", "connector", "picture"].includes(P.getShapeKind(s)),
      ),
    canEffects: () => selectedShapes().some(canShadow),
    effectsMenu,
    // Editing
    find: () => openFind(),
    replace: () => openFind({ replace: true }),
    selectMenu: () => [
      {
        label: "Select All",
        icon: "o:selectAll",
        shortcut: `${MOD_KEY}+A`,
        onSelect: selectAll,
      },
      {
        label: "Selection Pane…",
        icon: "o:selectionPane",
        onSelect: toggleSelectionPane,
      },
    ],
    hasAssistant: () => !!assistant,
    newSlideFromPrompt: () => newSlideFromPrompt().catch(fail),
    designIdeas: () => {
      openAssistant(
        "Suggest a cleaner, more professional design for the current slide and apply it, keeping all of its content.",
      );
    },
    // Insert
    tableMenu,
    canLink: () => canLink(currentShape()),
    insertLink: () => linkDialog().catch(fail),
    actionMenu: () => [
      { label: "Hyperlink to…", icon: "o:link", onSelect: run(linkDialog) },
      { separator: true },
      ...[
        ["nextSlide", "Next Slide"],
        ["prevSlide", "Previous Slide"],
        ["firstSlide", "First Slide"],
        ["lastSlide", "Last Slide"],
      ].map(([kind, label]) => ({
        label: `Go to ${label}`,
        disabled: !canLink(currentShape()),
        onSelect: () =>
          mutateShape(currentShape(), (obj) => setLink(obj, { kind })),
      })),
      { separator: true },
      {
        label: "Remove Action",
        icon: "o:unlink",
        disabled: !linkOf(currentShape() || {}),
        onSelect: removeLink,
      },
    ],
    wordArtMenu,
    canInsertField: () => !!textTarget() && !isTable(textTarget()),
    dateTimeMenu,
    insertSlideNumber,
    insertSymbol: () => insertSymbol().catch(fail),
    // Design
    themeChoices: () => themeTools.themeChoices(),
    themeSections: (choices) => themeTools.themeSections(choices),
    currentTheme: () => themeTools.currentTheme(),
    chooseTheme: (id) => themeTools.chooseTheme(id),
    applyTheme: (id) => themeTools.chooseTheme(id),
    themeContextMenu: (choice) => themeTools.themeContextMenu(choice),
    themeGalleryFooter: () => [
      ...themeTools.themeGalleryFooter(),
      { separator: true },
      { label: "Theme Options…", icon: "o:themes", onSelect: run(themeDialog) },
    ],
    variantChoices: () => (doc ? themeTools.variantChoices() : []),
    currentVariant: () => themeTools.currentVariant(),
    applyVariant: (i) => themeTools.applyVariant(i),
    variantFooter: () => themeTools.variantFooter(),
    themeColorsMenu: () => themeTools.colorsMenu(),
    themeFontsMenu: () => themeTools.fontsMenu(),
    themeEffectsMenu: () => themeTools.effectsMenu(),
    backgroundStylesMenu: () => themeTools.backgroundStylesMenu(),
    backgroundGraphicsHidden: () =>
      !!doc && themeTools.backgroundGraphicsHidden(),
    setBackgroundGraphicsHidden: (on) =>
      themeTools.setBackgroundGraphicsHidden(on),
    slideSizeMenu: () => [
      ...SLIDE_SIZES.map(([key, label, cx, cy]) => ({
        label,
        checked: currentSize().cx === cx && currentSize().cy === cy,
        onSelect: run(() => slideSizeDialog(key)),
      })),
      { separator: true },
      {
        label: "Custom Slide Size…",
        icon: "o:slideSize",
        onSelect: run(slideSizeDialog),
      },
    ],
    formatBackground: () => {
      clearSelection();
      renderSelection();
      renderInspector();
      show("formatPane", true);
    },
    // Transitions
    ...transitionTools.ribbonApi(),
    formatSeconds: (n) => {
      const m = Math.floor(n / 60),
        s = n - m * 60;
      return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
    },
    parseSeconds: (value) => {
      const parts = String(value).trim().split(":").map(Number);
      if (parts.some((n) => !Number.isFinite(n))) return NaN;
      return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
    },
    // Slide Show
    present: (options) => present(options),
    ...showFeatures.ribbonApi(),
    slideHidden: () => P.isSlideHidden(slide()),
    toggleHideSlide: () =>
      setSlidesHidden(actionSlides(slide()), !P.isSlideHidden(slide())),
    // Review
    spelling: () => review.spelling.open(),
    reviewTab: (api) => review.tab(api),
    newComment: () => review.newComment(),
    toggleComments: () => review.comments.toggle(),
    commentsOpen: () => review.comments.isOpen(),
    checkAccessibility: () => checkAccessibility(),
    altText: () => altText().catch(fail),
    languageMenu: languageItems,
    // View
    supportsView,
    currentView,
    setView,
    showing,
    show,
    zoomMenu: () => zoomItems(),
    zoomDialog: () => views.openZoomDialog(),
    gridDialog: () => views.grid.gridDialog(),
    fitToWindow: () => setZoom("fit"),
    colorMode: () => chrome.colorMode,
    setColorMode,
    // Arrange
    order: (direction) => {
      const obj = currentShape();
      if (obj)
        arrangeObject(
          obj,
          direction === "forward" ? P.bringShapeForward : P.sendShapeBackward,
        );
    },
    orderMenu: (direction) => {
      const obj = currentShape();
      return orderItems(obj).filter((item) =>
        direction === "forward"
          ? /Bring/.test(item.label)
          : /Send/.test(item.label),
      );
    },
    selectionPaneOpen,
    toggleSelectionPane,
    alignMenu: () => {
      const count = selectionIds().size;
      return [
        ...ALIGN_ACTIONS.map(([edge, , ic]) => ({
          label: {
            left: "Align Left",
            hcenter: "Align Center",
            right: "Align Right",
            top: "Align Top",
            vcenter: "Align Middle",
            bottom: "Align Bottom",
          }[edge],
          icon: `o:${{ left: "alignObjLeft", hcenter: "alignObjCenter", right: "alignObjRight", top: "alignObjTop", vcenter: "alignObjMiddle", bottom: "alignObjBottom" }[edge]}`,
          disabled: !count,
          onSelect: () => alignSelection(edge),
        })),
        { separator: true },
        {
          label: "Distribute Horizontally",
          icon: "o:distributeH",
          disabled: count < 3,
          onSelect: () => distributeSelection("x"),
        },
        {
          label: "Distribute Vertically",
          icon: "o:distributeV",
          disabled: count < 3,
          onSelect: () => distributeSelection("y"),
        },
      ];
    },
    groupMenu: () =>
      arrangeItems()
        .filter((i) => i.label === "Group" || i.label === "Ungroup")
        .map((i) => ({
          ...i,
          icon: i.label === "Group" ? "o:group" : "o:ungroup",
        })),
    rotateMenu: () => {
      const obj = currentShape();
      const turn = (deg) =>
        obj &&
        mutateShape(obj, (obj) =>
          P.setShapeRotation(
            obj,
            ((((P.getShapeRotation(obj) || 0) + deg) % 360) + 360) % 360,
          ),
        );
      const flippable =
        !!obj && ["shape", "picture"].includes(P.getShapeKind(obj));
      return [
        {
          label: "Rotate Right 90°",
          icon: "o:rotate",
          disabled: !obj,
          onSelect: () => turn(90),
        },
        {
          label: "Rotate Left 90°",
          icon: "o:rotate",
          disabled: !obj,
          onSelect: () => turn(-90),
        },
        {
          label: "Flip Vertical",
          icon: "o:flipV",
          disabled: !flippable,
          onSelect: () => flipObject(obj, "vertical"),
        },
        {
          label: "Flip Horizontal",
          icon: "o:flipH",
          disabled: !flippable,
          onSelect: () => flipObject(obj, "horizontal"),
        },
        { separator: true },
        {
          label: "More Rotation Options…",
          icon: "o:formatPane",
          onSelect: () => show("formatPane", true),
        },
      ];
    },
    size: selectionSize,
    setSize: setSelectionSize,
    canChangeShape: () => {
      const obj = currentShape();
      return (
        !!obj && P.getShapeKind(obj) === "shape" && !!P.setShapePresetGeometry
      );
    },
    changeShapeMenu: () => {
      const obj = currentShape();
      return [...SHAPES, ...ARROW_SHAPES].map(([preset, label]) => ({
        label,
        onSelect: () =>
          mutateShape(obj, (obj) => P.setShapePresetGeometry(obj, preset)),
      }));
    },
    shapeStyleChoices,
    applyShapeStyle,
    textEffectsMenu: () => [
      { header: "Shadow" },
      { label: "No Shadow", onSelect: () => setShadowAll(null) },
      {
        label: "Offset: Bottom Right",
        onSelect: () => setShadowAll({ ...SHADOW, angleDeg: 45 }),
      },
    ],
    // Picture
    correctionsMenu: () => {
      const obj = currentShape();
      return [-40, -20, 0, 20, 40].map((pct) => ({
        label: `Brightness: ${pct > 0 ? "+" : ""}${pct}%`,
        onSelect: () =>
          mutateShape(obj, (obj) => P.setShapeImageBrightness(obj, pct / 100)),
      }));
    },
    transparencyMenu: () => {
      const obj = currentShape();
      return [0, 15, 30, 50, 65, 80, 95].map((pct) => ({
        label: `Transparency: ${pct}%`,
        onSelect: () =>
          mutateShape(obj, (obj) => P.setShapeImageOpacity(obj, 1 - pct / 100)),
      }));
    },
    changePicture: () => {
      const obj = currentShape();
      if (obj) pickImage((file) => replaceImage(obj, file).catch(fail));
    },
    resetPicture: () => {
      const obj = currentShape();
      if (!obj) return;
      mutateShape(obj, (obj) => {
        P.setShapeImageOpacity(obj, 1);
        P.setShapeImageBrightness(obj, 0);
        P.setShapeImageCrop?.(obj, { left: 0, top: 0, right: 0, bottom: 0 });
        P.setShapeFlip?.(obj, { horizontal: false, vertical: false });
      });
    },
    cropMenu: () => [
      {
        label: "Crop…",
        icon: "o:crop",
        onSelect: () => show("formatPane", true),
      },
      {
        label: "Fit",
        icon: "o:fitWindow",
        onSelect: () =>
          mutateShape(currentShape(), (obj) =>
            P.setShapeImageCrop?.(obj, {
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
            }),
          ),
      },
    ],
    // Table
    tableFlag: (key) => {
      const obj = currentShape();
      return !!(obj && isTable(obj) && P.getTableStyleFlags(obj)[key]);
    },
    setTableFlag: (key, on) => {
      const obj = currentShape();
      if (obj && isTable(obj))
        mutateShape(obj, (obj) => P.setTableStyleFlags(obj, { [key]: on }));
    },
    tableStyleChoices: () => tableStyleChoices(),
    currentTableStyle: () => currentTableStyle(),
    applyTableStyle: (id) => applyTableStyle(id),
    tableInsert,
    tableDeleteMenu,
    distributeTable,
    ...insertFeatures.api(),
    shapesMenu: () => [...shapesMenu(), ...insertFeatures.shapesGallery()],
  };
  return { ...base, ...formatTools.api(base) };
}
// Table styles: the ones the engine can write (the predefined table styles by
// GUID), drawn as small samples in the theme's colours.
// The built-in styles the engine writes: no style, the plain grid, and the
// medium style the editor gives new tables.
const TABLE_STYLES = [
  {
    id: "{2D5ABB26-0587-4C30-8999-92F81FD0307C}",
    name: "No Style, No Grid",
    light: true,
    plain: true,
  },
  {
    id: "{5940675A-B579-460E-94D1-54222C63F5DA}",
    name: "No Style, Table Grid",
    light: true,
    plain: true,
    grid: true,
  },
  {
    id: "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}",
    name: "Medium Style 2 - Accent 1",
    accent: "accent1",
  },
];
function tableStyleChoices() {
  const list = P.getBuiltInTableStyles?.() || TABLE_STYLES;
  return list.map((style) => ({
    id: style.id,
    label: style.name,
    render: () => {
      const accent =
        themeHex(`scheme:${style.accent || "accent1"}`) || "#4472C4";
      const sample = el("span", {
        class: `table-sample ${style.grid ? "grid" : ""}`,
      });
      if (style.plain) {
        for (let i = 0; i < 16; i++)
          sample.append(el("span", { style: "background:#fff" }));
        return sample;
      }
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++)
          sample.append(
            el("span", {
              style:
                r === 0
                  ? `background:${style.dark ? "#000" : accent}`
                  : r % 2
                    ? `background:${modulate(accent, 20000, 80000)}`
                    : `background:${style.light ? "#fff" : modulate(accent, 40000, 60000)}`,
            }),
          );
      return sample;
    },
  }));
}
function currentTableStyle() {
  const obj = currentShape();
  return obj && isTable(obj) ? P.getTableStyleId?.(obj) || null : null;
}
function applyTableStyle(id) {
  const obj = currentShape();
  if (obj && isTable(obj) && P.setTableStyleId)
    mutateShape(obj, (obj) => P.setTableStyleId(obj, id));
}
// The toolbar's font and size lists are built once and follow the selection.
// A value they do not carry, as an imported deck's font or half-point size,
// joins the list in its own order rather than on top of it, and only for as
// long as it is the value in use, so moving between objects neither reorders
// the list nor makes it grow.
function showSelectionValue(select, value, order) {
  for (const option of select.querySelectorAll("option[data-selection]"))
    if (option.value !== value) option.remove();
  if (![...select.options].some((option) => option.value === value)) {
    const option = el("option", { value, "data-selection": "" }, value);
    select.insertBefore(
      option,
      [...select.options].find((other) => order(other.value, value) > 0) ||
        null,
    );
  }
  select.value = value;
}
// A control disabled while it has the focus drops the focus onto the page,
// where the next Tab starts over from the top; the focus goes to `fallback`
// instead.
function disableControl(node, disabled, fallback) {
  if (!node) return;
  const focused = document.activeElement === node;
  node.disabled = disabled;
  if (disabled && focused) fallback()?.focus({ preventScroll: true });
}
const workspace = () => document.querySelector("#main");
// The ribbon shows the selected object's text format and enables what
// applies to the selection; it follows every change of either.
let ribbonSync = 0;
function syncToolbar() {
  if (!ribbon || !doc) return;
  // Several changes in one task refresh the ribbon once.
  if (ribbonSync) return;
  ribbonSync = requestAnimationFrame(() => {
    ribbonSync = 0;
    ribbon?.refresh();
    updateStatusBar();
    renderSelectionPane();
    animationTools.sync();
  });
}
const navigatorVisible = () =>
  !document.querySelector(".editor")?.classList.contains("hide-slides");
function toggleNavigator() {
  document.querySelector(".editor").classList.toggle("hide-slides");
  updatePanelToggles();
}
const inspectorVisible = () => {
  const panel = document.querySelector("#inspector");
  return !!panel && getComputedStyle(panel).display !== "none";
};
function toggleInspector() {
  const editor = document.querySelector(".editor");
  const visible = inspectorVisible();
  editor.classList.toggle("hide-inspector", visible);
  editor.classList.toggle("show-inspector", !visible);
  // Where the format panel lies over the slide, the assistant beside it
  // would leave no slide to see: one of the two is open at a time.
  if (!visible && sidePanelsExclusive() && assistant?.isOpen)
    assistant.close({ focusWorkspace: false });
  updatePanelToggles();
}
const sidePanelsExclusive = () => matchMedia("(max-width: 1150px)").matches;
// Size the slide to the space available in both directions so short windows
// show the whole slide instead of a scrollbar.
function fitCanvas() {
  const area = document.querySelector("#canvas-area");
  const canvas = document.querySelector("#slide-canvas");
  if (!area || !canvas || !doc) return;
  const label = area.querySelector(".canvas-label");
  const style = getComputedStyle(area);
  const availableWidth = Math.min(
    1200,
    area.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight),
  );
  const availableHeight =
    area.clientHeight -
    parseFloat(style.paddingTop) -
    parseFloat(style.paddingBottom) -
    label.offsetHeight -
    parseFloat(getComputedStyle(label).marginBottom);
  const size = currentSize();
  // Very short windows scroll rather than shrinking the slide past half width
  // (a portrait notes or handout page, past a quarter).
  const fitWidth = Math.floor(
    Math.max(
      availableWidth / (size.cy > size.cx ? 4 : 2),
      Math.min(availableWidth, (availableHeight * size.cx) / size.cy),
    ),
  );
  // At 100% an inch of slide is 96 pixels, as it is in print.
  const width =
    zoom === "fit" ? fitWidth : Math.round((size.cx / 914400) * 96 * zoom);
  if (!(width > 0)) return;
  canvas.style.width = `${width}px`;
  layoutCurrentSelection(canvas, width);
  label.style.width = `${width}px`;
  area.classList.toggle("zoomed", zoom !== "fit");
  updateZoomUi();
}
// The step above or below the current zoom, or undefined at the ladder's end.
function nextZoomStep(direction, current = zoomFactor()) {
  const steps = viewZoom()?.steps || ZOOM_STEPS;
  return direction > 0
    ? steps.find((step) => step > current + 0.01)
    : [...steps].reverse().find((step) => step < current - 0.01);
}
// The slide's scale on screen, whatever set it.
function zoomFactor() {
  if (viewZoom()) return viewZoom().factor();
  if (zoom !== "fit") return zoom;
  const canvas = document.querySelector("#slide-canvas");
  const size = currentSize();
  return canvas?.clientWidth
    ? canvas.clientWidth / ((size.cx / 914400) * 96)
    : 1;
}
// A new zoom keeps the middle of the view where it was.
function setZoom(next) {
  // Slide Sorter and Notes Page zoom on their own.
  if (viewZoom()) {
    viewZoom().set(next);
    updateZoomUi();
    return;
  }
  const area = document.querySelector("#canvas-area");
  const center = area && {
    x: (area.scrollLeft + area.clientWidth / 2) / Math.max(1, area.scrollWidth),
    y:
      (area.scrollTop + area.clientHeight / 2) / Math.max(1, area.scrollHeight),
  };
  zoom = next;
  try {
    if (next === "fit") localStorage.removeItem("presentation:zoom");
    else localStorage.setItem("presentation:zoom", String(next));
  } catch {}
  fitCanvas();
  if (area && center) {
    area.scrollLeft = center.x * area.scrollWidth - area.clientWidth / 2;
    area.scrollTop = center.y * area.scrollHeight - area.clientHeight / 2;
  }
}
function stepZoom(direction) {
  const next = nextZoomStep(direction);
  if (next) setZoom(next);
}
function zoomItems() {
  const setting = viewZoom() ? viewZoom().setting() : zoom;
  return [
    {
      label: "Fit to screen",
      icon: "Maximize",
      shortcut: `${MOD_KEY}+0`,
      checked: setting === "fit",
      onSelect: () => setZoom("fit"),
    },
    { separator: true },
    ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((level) => ({
      label: `${Math.round(level * 100)}%`,
      checked: setting === level,
      onSelect: () => setZoom(level),
    })),
    { separator: true },
    {
      label: "Zoom…",
      icon: "o:zoom",
      onSelect: () => views.openZoomDialog().catch(fail),
    },
  ];
}
function zoomMenu(e) {
  openMenu({
    anchor: e.currentTarget,
    label: "Zoom",
    align: "end",
    minWidth: 180,
    items: zoomItems(),
  });
}
// Ctrl (or Cmd) with the wheel, and a trackpad pinch, zoom the slide; the
// steps come one per notch of movement rather than per event. Browsers
// report the movement in pixels, or in lines or pages as Firefox does for a
// mouse wheel; a line counts as a text line's height and a page as a notch.
let wheelZoomBudget = 0;
const WHEEL_NOTCH = 40;
function wheelPixels(e) {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 16;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE)
    return Math.sign(e.deltaY) * WHEEL_NOTCH;
  return e.deltaY;
}
function wheelZoom(e) {
  if (!(e.ctrlKey || e.metaKey) || !doc) return;
  e.preventDefault();
  const movement = wheelPixels(e);
  // Movement the other way starts its own notch, so a pinch that wavers
  // does not have to undo itself before it tells.
  if (movement * wheelZoomBudget < 0) wheelZoomBudget = 0;
  wheelZoomBudget += movement;
  if (Math.abs(wheelZoomBudget) < WHEEL_NOTCH) return;
  stepZoom(wheelZoomBudget < 0 ? 1 : -1);
  wheelZoomBudget = 0;
}
function updatePanelToggles() {
  // Panel commands change the available space synchronously. Refit before the
  // next pointer event; ResizeObserver alone can leave stale hit coordinates.
  fitCanvas();
  syncToolbar();
}
window.addEventListener("resize", updatePanelToggles);
/* ---------- AI assistant ----------
 * A chat beside the slide in which Puter's AI reads and edits the deck
 * (assistant-panel.js). Its edits go through mutate like any other, one undo
 * step each, and keep the user on the slide and selection they had.
 */
function assistantToggle() {
  return button("Ask AI", "Sparkles", () => toggleAssistant(), "ai-toggle", {
    "aria-controls": "ai-panel",
    "aria-expanded": "false",
    title: `AI assistant (${MOD_KEY}+J)`,
  });
}
function syncAssistantToggle() {
  const open = !!assistant?.isOpen;
  for (const toggle of document.querySelectorAll(".ai-toggle")) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("active", open);
  }
  document.querySelector(".editor")?.classList.toggle("show-assistant", open);
}
function toggleAssistant(force) {
  if (!assistant) return;
  assistant.toggle(force);
}
function openAssistant(prompt = null) {
  assistant?.open({ prompt });
}
// The assistant drafts a slide, after the current one, from a description.
async function newSlideFromPrompt() {
  if (!assistant || !doc) return;
  const input = el("textarea", {
    class: "input",
    rows: 3,
    maxlength: 2000,
    autofocus: true,
    placeholder:
      "For example: our three goals for next year, with a line on each",
    "aria-label": "Describe the slide",
  });
  const after = index + 1;
  const ok = await dialog({
    title: "New Slide from Prompt",
    body: el(
      "form",
      { class: "dialog-body" },
      el("label", {}, "What should the new slide say?", input),
    ),
    confirm: "Draft Slide",
  });
  const text = input.value.trim();
  if (!ok || !text || !assistant) return;
  assistant.ask(
    `Add one new slide right after slide ${after} about the following, with its title, content and speaker notes, matching the palette and style of the slides around it:\n${text}`,
  );
}
// Text typed on the slide is committed when its editor closes, and text
// typed in the notes or the outline when it loses the focus; the assistant's
// edits wait for that rather than cut the typing short or be typed over.
const assistantTyping = () =>
  !!richEditor ||
  !!document.activeElement?.matches(
    "#speaker-notes, .inline-editor, .outline-text, .notes-page-text",
  );
function assistantIdle() {
  if (!assistantTyping()) return null;
  return new Promise((resolve) => {
    const check = () => {
      if (!assistantTyping() || view !== "editor") resolve();
      else setTimeout(check, 250);
    };
    setTimeout(check, 250);
  });
}
// One assistant edit as one undo step. The slide the user is on and the
// objects they selected stay theirs, found again by part and id, whatever the
// edit added or removed around them.
async function assistantEdit(work) {
  const active = doc;
  if (!active) throw new Error("No presentation is open.");
  let result,
    error = null,
    step = null;
  const applied = await mutate(
    async () => {
      const part = P.getSlidePartName(slide());
      const primary = currentShape() && P.getShapeId(currentShape());
      const keep = [...extras, primary].filter((id) => id != null);
      const out = await work(doc.pres);
      if (out === NO_CHANGE) return SKIP_MUTATION;
      result = out;
      settleIndex([part]);
      if (P.getSlidePartName(slide()) === part)
        selectIds(keep.filter((id) => P.findShapeById(slide(), id)));
      else clearSelection();
      slideExtras = new Set([...slideExtras].filter((p) => positionOf(p) >= 0));
    },
    {
      onError: (e) => {
        error = e;
      },
      onApplied: (before, after) => {
        step = { before, after };
      },
    },
  );
  if (error) throw error;
  if (doc !== active) throw new Error("The presentation was closed.");
  return { applied, result, step };
}
// Shows the user a slide and selects objects on it.
async function showObjects(part, ids = []) {
  if (!doc) return;
  const target = P.getSlides(doc.pres).find(
    (s) => P.getSlidePartName(s) === part,
  );
  if (!target) return;
  if (P.getSlidePartName(slide()) !== part) await chooseSlide(target);
  if (!doc || P.getSlidePartName(slide()) !== part) return;
  selectIds(ids.filter((id) => P.findShapeById(slide(), id)));
  updateSelectionUi();
  renderInspector();
}
function assistantEnv() {
  return {
    pres: () => doc.pres,
    docName: () => doc?.name || "",
    slideIndex: () => index,
    slidePart: () => (doc ? P.getSlidePartName(slide()) : null),
    slideCount: () => (doc ? P.getSlides(doc.pres).length : 0),
    selectionIds: () => (doc ? [...selectionIds()] : []),
    theme: () => theme,
    edit: assistantEdit,
    withTextBody,
    setText: (obj, value) => setText(obj, value),
    textColor: (target) =>
      legibleColor(
        slideBackground(target).color,
        [THEMES[theme].ink, sectionTextColor(theme)],
        4.5,
      ),
    slideBackground,
    fitTable: (obj) => fitTableGrid(obj, P.getShapeBounds(obj)),
    applyTheme: (key) => recolorDeck(key),
    replaceIn: (shape, regex, replacement) =>
      replaceInShape(shape, regex, replacement),
    replaceInCell: (cell, regex, replacement) =>
      replaceInCell(cell, regex, replacement),
    select: (part, ids) => showObjects(part, ids).catch(fail),
    goToSlide: (n) => {
      const target = P.getSlides(doc.pres)[n - 1];
      if (target) chooseSlide(target).catch(fail);
    },
    whenIdle: assistantIdle,
    isTyping: assistantTyping,
    history: () => ({ bytes: history.bytes }),
    undoTurn: (first, count) => undoAssistantTurn(first, count),
    focusWorkspace: () => workspace()?.focus({ preventScroll: true }),
    onToggle: (open) => {
      if (open && sidePanelsExclusive() && inspectorVisible())
        toggleInspector();
      syncAssistantToggle();
      updatePanelToggles();
    },
  };
}
// Each presentation gets a chat of its own: what was said about one deck
// means nothing beside another.
function mountAssistant() {
  assistant?.destroy();
  assistant = createAssistantPanel(assistantEnv());
  document.querySelector(".editor-split").append(assistant.el);
  // Left open, it opens again beside the next presentation.
  if (assistant.wantsOpen) assistant.open({ focus: false });
  syncAssistantToggle();
}
/* ---------- Menus ---------- */
const M = MOD_KEY;
const menuFor = (label, items) => (anchor) =>
  openMenu({
    anchor,
    label,
    items: items(anchor),
    align: "auto",
    minWidth: 240,
  });
// Presentations to reopen from the File menu: the newest in the library and
// those opened from elsewhere on the drive, without the one already open.
function recentMenuItems() {
  const open = doc?.path;
  const seen = new Set();
  const list = [
    ...files.map((f) => ({
      ...f,
      at: Number(f.modified || f.created || 0) * 1000,
    })),
    ...recentFiles.map((r) => ({ ...r, at: cloud.modifiedMs(r) ?? r.at ?? 0 })),
  ]
    .filter(
      (f) => f.path && f.path !== open && !seen.has(f.path) && seen.add(f.path),
    )
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 8);
  if (!list.length)
    return [{ label: "No recent presentations", disabled: true }];
  return list.map((f) => ({
    label: cleanName(f.name || cloud.displayName(f.path), {
      maxLength: Infinity,
    }),
    icon: "Presentation",
    hint: cloud.folderName(f.path) || null,
    onSelect: run(() => openCloud(f)),
  }));
}
// The File menu. The phone's File options button, the only menu button its
// layout keeps, carries the other menus too.
function fileMenu(anchor) {
  const mobile = anchor.classList.contains("mobile-only");
  openMenu({
    anchor,
    label: "File",
    align: "auto",
    minWidth: 250,
    items: [
      {
        label: "New presentation",
        icon: "FilePlus",
        onSelect: run(() => newDeck("blank")),
      },
      {
        label: "Open from Puter",
        icon: "FolderOpen",
        shortcut: `${M}+O`,
        onSelect: run(openPicker),
      },
      {
        label: "Open recent",
        icon: "Clock",
        items: recentMenuItems(),
      },
      { label: "Import PPTX", icon: "Upload", onSelect: pickLocal },
      { separator: true },
      {
        label: "Save to Puter",
        icon: "Save",
        shortcut: `${M}+S`,
        onSelect: run(() => saveCloud()),
      },
      {
        label: "Save a copy to Puter",
        icon: "CopyPlus",
        shortcut: `${M}+Shift+S`,
        onSelect: run(saveCopy),
      },
      {
        label: "Save as template…",
        icon: "LayoutTemplate",
        onSelect: run(() => fileTools.saveAsTemplate()),
      },
      {
        label: "Export…",
        icon: "o:exportFile",
        onSelect: run(() => fileTools.openExportDialog()),
      },
      { label: "Rename", icon: "Pencil", onSelect: run(renameDoc) },
      {
        label: "Close",
        icon: "X",
        onSelect: run(async () => {
          if (await leaveEditor()) await home();
        }),
      },
      { separator: true },
      {
        label: "Compress pictures…",
        icon: "o:compressPictures",
        disabled: readOnlyDocument(),
        onSelect: run(() => fileTools.openCompressDialog()),
      },
      {
        label: "File size…",
        icon: "o:fileSize",
        onSelect: run(() => fileTools.openFileSizeDialog()),
      },
      {
        label: "Embed font",
        icon: "Type",
        disabled: readOnlyDocument(),
        onSelect: pickFont,
      },
      ...review.fileMenuItems(),
      { separator: true },
      {
        label: "Page setup (slide size)…",
        icon: "Maximize",
        onSelect: run(slideSizeDialog),
      },
      {
        label: "Print…",
        icon: "Printer",
        shortcut: `${M}+P`,
        onSelect: run(() => fileTools.openPrintDialog()),
      },
      {
        label: "Properties",
        icon: "Info",
        onSelect: run(() => fileTools.openPropertiesDialog()),
      },
      { separator: true },
      {
        label: "Download PowerPoint (.pptx)",
        icon: "Download",
        onSelect: run(downloadDeck),
      },
      {
        label: "Download as images",
        icon: "Image",
        items: [
          {
            label: "This slide as PNG",
            icon: "Image",
            onSelect: run(() => exportImages(false)),
          },
          {
            label: "All slides as PNG (ZIP)",
            icon: "Download",
            onSelect: run(() => exportImages(true)),
          },
        ],
      },
      ...(mobile
        ? [
            { separator: true },
            { label: "Edit", icon: "Pencil", items: editItems() },
            { label: "View", icon: "Eye", items: viewItems() },
            { label: "Insert", icon: "Plus", items: insertItems() },
            { label: "Format", icon: "Type", items: formatItems() },
            { label: "Slide", icon: "LayoutTemplate", items: slideItems() },
            {
              label: "Review",
              icon: "o:showComments",
              items: [
                {
                  label: "New Comment",
                  icon: "o:newComment",
                  onSelect: () => review.newComment(),
                },
                { separator: true },
                ...review.toolsMenu(),
              ],
            },
            {
              label: "Account and settings",
              icon: "User",
              items: accountItems(),
            },
          ]
        : []),
      { separator: true },
      {
        label: "Keyboard shortcuts",
        icon: "Keyboard",
        onSelect: shortcutsDialog,
      },
      {
        label: "Back to presentations",
        icon: "ArrowLeft",
        onSelect: run(async () => {
          if (await leaveEditor()) await home();
        }),
      },
    ],
  });
}
function editItems() {
  const obj = currentShape();
  return [
    {
      label: "Undo",
      icon: "Undo2",
      shortcut: `${M}+Z`,
      disabled: !history.past.length,
      onSelect: () => undo(),
    },
    {
      label: "Redo",
      icon: "Redo2",
      shortcut: `${M}+Shift+Z`,
      disabled: !history.future.length,
      onSelect: () => redo(),
    },
    { separator: true },
    ...clipboardItems(),
    { separator: true },
    {
      label: "Select all",
      icon: "SquareDashedMousePointer",
      shortcut: `${M}+A`,
      onSelect: selectAll,
    },
    {
      label: "Find and replace",
      icon: "Search",
      shortcut: `${M}+F`,
      onSelect: () => openFind(),
    },
    {
      label: "Find next",
      icon: "ChevronDown",
      shortcut: `${M}+G`,
      onSelect: () => findAgain(1),
    },
    {
      label: "Find previous",
      icon: "ChevronUp",
      shortcut: `${M}+Shift+G`,
      onSelect: () => findAgain(-1),
    },
    {
      label: "Replace…",
      icon: "o:replace",
      shortcut: `${M}+H`,
      onSelect: () => openFind({ replace: true }),
    },
    {
      label: "Select data…",
      icon: "o:selectData",
      disabled: !obj || !chartTools.isChart(obj) || readOnlyDocument(),
      onSelect: () => chartTools.selectData(obj),
    },
    {
      label: "Duplicate",
      icon: "CopyPlus",
      shortcut: `${M}+D`,
      disabled: !obj,
      onSelect: duplicateObject,
    },
    {
      label: "Delete",
      icon: "Trash2",
      shortcut: "Delete",
      disabled: !obj,
      onSelect: deleteObject,
    },
    {
      label: "Delete slide",
      icon: "o:deleteSlide",
      disabled:
        !doc ||
        masterView.active ||
        readOnlyDocument() ||
        P.getSlides(doc.pres).length <= actionSlides(slide()).length,
      onSelect: () => deleteSlides(actionSlides(slide())),
    },
    // Rename Section and Remove Section, for the current slide's section.
    ...sectionMenu().filter((item) =>
      ["Rename Section", "Remove Section"].includes(item.label),
    ),
    { separator: true },
    ...formatTools.editMenuItems(),
  ];
}
const editMenu = menuFor("Edit", editItems);
function viewItems() {
  return [
    ...views.menuItems(),
    { separator: true },
    {
      label: "Slide navigator",
      icon: "PanelLeft",
      checked: navigatorVisible(),
      onSelect: toggleNavigator,
    },
    {
      label: "Format panel",
      icon: "PanelRight",
      checked: inspectorVisible(),
      onSelect: toggleInspector,
    },
    {
      label: "AI assistant",
      icon: "Sparkles",
      shortcut: `${M}+J`,
      checked: !!assistant?.isOpen,
      onSelect: () => toggleAssistant(),
    },
    {
      label: "Ribbon",
      icon: "PanelTop",
      shortcut: `${M}+${IS_MAC ? "⌥" : "Alt"}+R`,
      checked: !!ribbon && !ribbon.collapsed,
      onSelect: toggleRibbon,
    },
    { separator: true },
    {
      label: "Zoom in",
      icon: "ZoomIn",
      shortcut: `${M}+=`,
      disabled: !nextZoomStep(1),
      onSelect: () => stepZoom(1),
    },
    {
      label: "Zoom out",
      icon: "ZoomOut",
      shortcut: `${M}+-`,
      disabled: !nextZoomStep(-1),
      onSelect: () => stepZoom(-1),
    },
    { label: "Zoom", icon: "Maximize", items: zoomItems() },
    { separator: true },
    {
      label: "Ruler",
      icon: "o:ruler",
      checked: !!chrome.ruler,
      onSelect: () => show("ruler", !chrome.ruler),
    },
    {
      label: "Grid and Guides",
      icon: "o:gridlines",
      items: views.grid.menuItems(),
    },
    { separator: true },
    {
      label: "Master",
      icon: "o:slideMaster",
      items: [
        ["slide", "Slide Master", "o:slideMaster", "1"],
        ["handout", "Handout Master", "o:handoutMaster", "2"],
        ["notes", "Notes Master", "o:notesMaster", "3"],
      ].map(([kind, label, icon, key]) => ({
        label,
        icon,
        shortcut: `${M}+${IS_MAC ? "⌥" : "Alt"}+${key}`,
        checked: masterView.mode === kind,
        onSelect: () => setView(masterView.viewId(kind)),
      })),
    },
    {
      label: "Close Master View",
      icon: "o:closeMasterView",
      disabled: !masterView.active,
      onSelect: () => setView("normal"),
    },
    { separator: true },
    {
      label: "Header and Footer…",
      icon: "o:headerFooter",
      onSelect: () => ribbonCommands().headerFooter?.(),
    },
    { separator: true },
    { label: "Present", icon: "Play", onSelect: run(present) },
    { separator: true },
    { label: "Appearance", icon: "Monitor", onSelect: appearanceDialog },
  ];
}
const viewMenu = menuFor("View", viewItems);
function insertItems() {
  return [
    { label: "Text box", icon: "Type", onSelect: () => addObject("text") },
    { label: "Image", icon: "Image", onSelect: () => insertImage() },
    { label: "Shape", icon: "Square", items: shapeItems() },
    { label: "Table", icon: "Table", onSelect: run(tableDialog) },
    { label: "Chart…", icon: "o:chart", onSelect: () => chartTools.insert() },
    P.addSlideSmartArt && {
      label: "SmartArt…",
      icon: "o:smartArt",
      onSelect: () => smartArtTools.insert(),
    },
    { separator: true },
    {
      label: "Link",
      icon: "Link",
      shortcut: `${M}+K`,
      disabled: !canLink(currentShape()),
      onSelect: run(linkDialog),
    },
    { separator: true },
    { label: "New slide", icon: "Plus", items: layoutItems(slide()) },
    {
      label: "Duplicate slide",
      icon: "o:duplicate",
      shortcut: `${M}+Shift+D`,
      disabled: !doc || masterView.active || readOnlyDocument(),
      onSelect: () => duplicateSlides(actionSlides(slide())),
    },
    {
      label: "Slides from",
      icon: "o:reuseSlides",
      items: slidesFrom.menuItems(),
    },
    { label: "Section", icon: "o:section", items: sectionMenu() },
    {
      label: "Comment",
      icon: "o:newComment",
      shortcut: `${M}+Shift+M`,
      onSelect: () => review.newComment(),
    },
    { separator: true },
    { label: "WordArt", icon: "o:wordArt", items: wordArtMenu() },
    {
      label: "Date and time",
      icon: "o:dateTime",
      disabled: !ribbonCommands().canInsertField(),
      items: dateTimeMenu(),
    },
    {
      label: "Slide number",
      icon: "o:slideNumber",
      disabled: !ribbonCommands().canInsertField(),
      onSelect: insertSlideNumber,
    },
    {
      label: "Symbol…",
      icon: "o:symbol",
      disabled: !ribbonCommands().canInsertField(),
      onSelect: () => insertSymbol().catch(fail),
    },
    { separator: true },
    ...insertFeatures.menuItems(),
  ];
}
const insertMenu = menuFor("Insert", insertItems);
function formatItems() {
  const obj = currentShape();
  const textCapable = !!obj && canEditText(obj);
  const fmt = textCapable ? textFormat(obj) : {};
  const alignment = textCapable ? paragraphAlignment(obj) : null;
  const anchor = textCapable ? textAnchor(obj) : null;
  const list = textCapable ? listStyle(obj) : null;
  const spacing = textCapable ? lineSpacing(obj) : null;
  const shadowed = obj ? selectedShapes().filter(canShadow) : [];
  const toggle = (key, label, icon, shortcut) => ({
    label,
    icon,
    shortcut,
    checked:
      key === "underline" || key === "strike"
        ? decorated(fmt[key])
        : !!fmt[key],
    disabled: !textCapable,
    onSelect: () => toggleTextFormat(obj, key),
  });
  return [
    ...formatTools.formatMenuItems(),
    { separator: true },
    toggle("bold", "Bold", "Bold", `${M}+B`),
    toggle("italic", "Italic", "Italic", `${M}+I`),
    toggle("underline", "Underline", "Underline", `${M}+U`),
    toggle("strike", "Strikethrough", "Strikethrough"),
    {
      label: "Text size",
      icon: "ALargeSmall",
      disabled: !textCapable,
      items: [
        {
          label: "Larger",
          shortcut: `${M}+Shift+>`,
          onSelect: () => stepTextSize(obj, 1),
        },
        {
          label: "Smaller",
          shortcut: `${M}+Shift+<`,
          onSelect: () => stepTextSize(obj, -1),
        },
      ],
    },
    { separator: true },
    {
      label: "Align",
      icon: "AlignLeft",
      disabled: !textCapable,
      items: TEXT_ALIGNMENTS.map(([a, label, icon]) => ({
        label,
        icon,
        checked: alignment === a,
        onSelect: () => setAlignment(obj, a),
      })),
    },
    {
      label: "Vertical align",
      icon: "AlignVerticalJustifyCenter",
      disabled: !textCapable,
      items: TEXT_ANCHORS.map(([a, label, icon]) => ({
        label,
        icon,
        checked: anchor === a,
        onSelect: () => setAnchor(obj, a),
      })),
    },
    {
      label: "Lists",
      icon: "List",
      disabled: !textCapable || isTable(obj),
      items: [
        {
          label: "Bulleted list",
          icon: "List",
          checked: list === "bullet",
          onSelect: () => toggleList(obj, "bullet"),
        },
        {
          label: "Numbered list",
          icon: "ListOrdered",
          checked: list === "number",
          onSelect: () => toggleList(obj, "number"),
        },
        { separator: true },
        {
          label: "Increase indent",
          icon: "IndentIncrease",
          shortcut: richEditor ? "Tab" : null,
          onSelect: () => changeIndent(obj, 1),
        },
        {
          label: "Decrease indent",
          icon: "IndentDecrease",
          shortcut: richEditor ? "Shift+Tab" : null,
          onSelect: () => changeIndent(obj, -1),
        },
      ],
    },
    {
      label: "Line spacing",
      icon: "AlignVerticalSpaceAround",
      disabled: !textCapable || isTable(obj),
      items: LINE_SPACINGS.map(([value, label]) => ({
        label,
        checked: spacing === value,
        onSelect: () => setLineSpacing(obj, value),
      })),
    },
    { separator: true },
    {
      label: "Drop shadow",
      icon: "Blend",
      checked: shadowed.length > 0 && shadowed.every(hasShadow),
      disabled: !shadowed.length,
      onSelect: () => toggleShadow(),
    },
    { label: "Order", icon: "Layers", disabled: !obj, items: orderItems(obj) },
    {
      label: "Arrange",
      icon: "AlignStartVertical",
      disabled: !obj,
      items: arrangeItems(),
    },
    {
      label: "Animation Painter",
      icon: "o:animationPainter",
      shortcut: `${MOD_KEY}+Alt+Shift+C`,
      checked: animationTools.painting,
      disabled: !animationTools.painting && !animationTools.current().length,
      onSelect: () => animationTools.startPainter(false),
    },
    { separator: true },
    { label: "Theme", icon: "Palette", onSelect: run(themeDialog) },
  ];
}
const formatMenu = menuFor("Format", formatItems);
function orderItems(obj) {
  if (!obj) return [];
  return [
    ["Bring to front", "BringToFront", P.bringShapeToFront, `${M}+Shift+]`],
    ["Bring forward", "ArrowUp", P.bringShapeForward, `${M}+]`],
    ["Send backward", "ArrowDown", P.sendShapeBackward, `${M}+[`],
    ["Send to back", "SendToBack", P.sendShapeToBack, `${M}+Shift+[`],
  ].map(([label, icon, move, shortcut]) => ({
    label,
    icon,
    shortcut,
    onSelect: () => arrangeObject(obj, move),
  }));
}
function slideItems() {
  return [
    { label: "New slide", icon: "Plus", items: layoutItems(slide()) },
    ...slideActions(slide()),
    { separator: true },
    { label: "Transition", icon: "Film", items: transitionItems(slide()) },
    {
      label: "Speaker notes",
      icon: "FileText",
      onSelect: () => document.querySelector("#speaker-notes")?.focus(),
    },
  ];
}
const slidesMenu = menuFor("Slide", slideItems);
function helpItems() {
  return [
    {
      label: "Keyboard shortcuts",
      icon: "Keyboard",
      onSelect: shortcutsDialog,
    },
    { label: "About Presentation", icon: "Info", onSelect: aboutDialog },
  ];
}
const helpMenu = menuFor("Help", helpItems);
async function aboutDialog() {
  await dialog({
    title: "About Presentation",
    body: el(
      "div",
      { class: "dialog-body" },
      brand(),
      el(
        "p",
        {},
        "A clean, responsive presentation editor. Every presentation is a real PowerPoint file (.pptx) that opens in PowerPoint, Keynote, and Google Slides.",
      ),
      el(
        "p",
        { class: "muted" },
        "Saved presentations live in your own Puter cloud under Presentations/. Recovery drafts stay on this device.",
      ),
    ),
    cancel: null,
  });
}
function shapeItems() {
  const item = ([preset, label, icon]) => ({
    label,
    icon,
    onSelect: () => addObject(preset),
  });
  return [
    ...SHAPES.map(item),
    { separator: true },
    { label: "Arrows", icon: "ArrowRight", items: ARROW_SHAPES.map(item) },
    { separator: true },
    { label: "Line", icon: "Minus", onSelect: () => addObject("line") },
    { label: "Arrow", icon: "MoveRight", onSelect: () => addObject("arrow") },
  ];
}
function shapeMenu(e) {
  menu(e.currentTarget, shapeItems(), { label: "Shape" });
}
function updateHistoryButtons() {
  const u = document.querySelector("#undo"),
    r = document.querySelector("#redo");
  // The button used up hands the focus to the workspace rather than to its
  // partner, where one press too many would take the last step back.
  disableControl(u, !history.past.length, workspace);
  disableControl(r, !history.future.length, workspace);
  assistant?.historyChanged();
}
function undo() {
  return restoreHistory("undo");
}
function redo() {
  return restoreHistory("redo");
}
function restoreHistory(direction, steps = 1) {
  // Text still open in the canvas editor is committed first, so the step
  // undone is the typing rather than the edit before it.
  richEditor?.close({ keep: true });
  pendingMutations++;
  const active = doc;
  const action = mutationTail
    .then(async () => {
      if (!active || doc !== active || readOnlyDocument()) return;
      const part = P.getSlidePartName(slide());
      let pres = null;
      // Several steps go back as one: the slide shows only where they end.
      for (let i = 0; i < steps; i++) {
        const next = await history[direction]();
        if (!next) break;
        pres = next;
      }
      if (pres) {
        const previous = active.pres;
        await prepareDeckFonts(pres, { reuseFrom: previous });
        if (doc !== active) {
          disposeDocumentFonts(pres);
          return;
        }
        lastCoalesce = null;
        doc.pres = pres;
        disposeDocumentFonts(previous);
        // A step that changed only other slides goes to the first of them,
        // so the change is never made out of sight.
        const shown = changedSlide(previous, pres, part);
        const position = P.getSlides(pres).indexOf(shown);
        if (position >= 0) index = position;
        theme = history.state;
        await afterHistory();
      }
    })
    .catch(fail)
    .finally(() => pendingMutations--);
  mutationTail = action;
  return action;
}
// The slide to show after a history step from `before` to `after`: the one
// shown, by part name, unless only other slides changed, then the first of
// those, or a slide the step brought back.
function changedSlide(before, after, part) {
  const old = new Map(
    P.getSlides(before).map((s) => [P.getSlidePartName(s), s]),
  );
  const differs = (s) => {
    const was = old.get(P.getSlidePartName(s));
    return !was || P.getSlideXmlString(was) !== P.getSlideXmlString(s);
  };
  const slides = P.getSlides(after);
  const shown = slides.find((s) => P.getSlidePartName(s) === part);
  if (shown && differs(shown)) return shown;
  return slides.find(differs) || shown;
}
// The assistant's Undo for one reply: its steps back through the history
// when the history still holds them all, or else the deck from before the
// reply, restored as an edit of its own that Undo can take back in turn.
async function undoAssistantTurn(first, count) {
  if (history.past.length >= count && history.past.at(-count) === first)
    return restoreHistory("undo", count);
  commitText();
  const active = doc;
  // The palette goes back with the slides: the history keeps the one each
  // snapshot was taken under.
  const palette = history.states.get(first) ?? theme;
  const pres = await P.loadPresentation(first);
  if (doc !== active) return false;
  P.refreshPresentationFields(pres, P.getPresentationFieldDate(doc.pres));
  return mutate(() => {
    const part = P.getSlidePartName(slide());
    doc.pres = pres;
    theme = palette;
    settleIndex([part]);
    clearSelection();
  });
}
async function afterHistory() {
  index = Math.min(index, P.getSlides(doc.pres).length - 1);
  clearSelection();
  revision++;
  // The step shows first; the draft follows it, as an edit's does.
  refreshMatches();
  renderSlideArea();
  renderInspector();
  updateHistoryButtons();
  await persistDraft().catch(warnStorage);
  scheduleSave();
}
// The New Slide gallery: every layout of the deck's masters, drawn.
function layoutItems(target) {
  return layoutCommands.newSlideItems(target);
}
function layoutMenu(e) {
  menu(e.currentTarget, layoutItems(slide()), { label: "New slide" });
}
async function chooseSlide(target, { extras = null } = {}) {
  const active = doc;
  const part = P.getSlidePartName(target);
  for (;;) {
    if (doc !== active || view !== "editor") return;
    activeEditorInput()?.blur();
    richEditor?.close();
    await mutationTail;
    if (doc !== active || view !== "editor") return;
    if (!activeEditorInput()) break;
  }
  const i = P.getSlides(doc.pres).findIndex(
    (s) => P.getSlidePartName(s) === part,
  );
  if (i < 0) return;
  index = i;
  slideExtras = new Set((extras || []).filter((p) => p !== part));
  clearSelection();
  renderSlideArea(false);
  renderInspector();
  renderSlideSelection();
}
// Thumbnails outside the current slide's neighbourhood render when they
// scroll into view or during idle time, so a large deck opens without a long
// freeze. Pending entries keep a null src until then.
const EAGER_THUMBNAILS = 8;
let thumbnailQueue = [];
let thumbnailWork = 0;
const pendingThumbnails = new WeakMap();
const thumbnailObserver = new IntersectionObserver((entries) => {
  for (const entry of entries)
    if (entry.isIntersecting) renderThumbnail(entry.target);
});
function deferThumbnail(img, s, distance) {
  pendingThumbnails.set(img, {
    pres: doc.pres,
    slide: s,
    part: P.getSlidePartName(s),
    distance,
  });
  thumbnailQueue.push(img);
  thumbnailObserver.observe(img);
}
function clearThumbnailQueue() {
  thumbnailQueue = [];
  thumbnailObserver.disconnect();
}
function renderThumbnail(img) {
  if (!img) return;
  const pending = pendingThumbnails.get(img);
  pendingThumbnails.delete(img);
  thumbnailObserver.unobserve(img);
  if (!pending || !img.isConnected || doc?.pres !== pending.pres) return;
  const entry = doc.previews.get(pending.part);
  if (!entry) return;
  img.src = cachedPreview(doc.previews, doc.pres, pending.slide);
}
function scheduleThumbnails() {
  if (thumbnailWork || !thumbnailQueue.length) return;
  const idle =
    window.requestIdleCallback ||
    ((fn) => setTimeout(() => fn({ timeRemaining: () => 12 }), 16));
  thumbnailWork = idle(
    (deadline) => {
      thumbnailWork = 0;
      const start = performance.now();
      do renderThumbnail(thumbnailQueue.shift());
      while (
        thumbnailQueue.length &&
        performance.now() - start < 10 &&
        deadline.timeRemaining() > 5
      );
      scheduleThumbnails();
    },
    { timeout: 300 },
  );
}
// A slide's render from the navigator's cache; a thumbnail still waiting for
// idle time is rendered now and cached so it is not rendered twice.
function cachedPreview(previews, pres, s) {
  const entry = previews.get(P.getSlidePartName(s));
  if (!entry) return preview(pres, s);
  const fields = slideFieldStamp(pres, s);
  const fonts = documentFontStamp(pres);
  const diagrams = slideDiagramDataStamp(pres, s);
  if (
    !entry.src ||
    entry.fields !== fields ||
    entry.fonts !== fonts ||
    entry.diagrams !== diagrams
  ) {
    entry.src = preview(pres, s);
    entry.fields = fields;
    entry.fonts = fonts;
    entry.diagrams = diagrams;
  }
  return entry.src;
}
const MASTER_VIEW_NAMES = {
  slide: "Slide Master",
  notes: "Notes Master",
  handout: "Handout Master",
};
// The canvas draws empty placeholders with their prompts ("Click to add
// title"), which thumbnails, shows and files never contain. A slide without
// one shows the navigator's render.
const promptPreviews = new WeakMap();
function canvasPreview(s) {
  const prompting =
    masterView.active || P.getSlideShapes(s).some(P.isPlaceholderEmpty);
  if (!prompting) return slidePreview(s);
  let cache = promptPreviews.get(doc.pres);
  if (!cache) promptPreviews.set(doc.pres, (cache = new Map()));
  const part = P.getSlidePartName(s);
  const size = currentSize();
  const key = [
    P.getSlideXmlString(s),
    templateStamp(doc.pres, s),
    slideFieldStamp(doc.pres, s),
    documentFontStamp(doc.pres),
    `${size.cx}x${size.cy}`,
  ].join("|");
  const hit = cache.get(part);
  if (hit?.key === key) return hit.src;
  const src = preview(doc.pres, s, null, { prompts: true });
  cache.set(part, { key, src });
  return src;
}
function slidePreview(s) {
  const part = P.getSlidePartName(s);
  const pending = !doc.previews.get(part)?.src;
  const src = cachedPreview(doc.previews, doc.pres, s);
  if (pending) {
    // Part names come from the file and may hold selector syntax.
    const img = document.querySelector(
      `#slide-list [data-slide-part="${CSS.escape(part)}"] img`,
    );
    if (img && img.getAttribute("src") !== src) img.src = src;
  }
  return src;
}
function renderSlideArea(refreshNavigator = true) {
  if (view !== "editor") return;
  const focusSelection = document.activeElement?.matches(
    ".object-hit.selected",
  );
  // The focused object may be about to disappear (Delete key); the object
  // now at its place, or the workspace, takes the focus instead.
  const focusedObject = document.activeElement?.matches(".object-hit")
    ? Number(document.activeElement.dataset.object)
    : null;
  const all = P.getSlides(doc.pres);
  index = Math.min(index, all.length - 1);
  const list = document.querySelector("#slide-list");
  const scroll = { left: list.scrollLeft, top: list.scrollTop };
  let focusTarget;
  const editor = document.querySelector(".editor");
  if (masterView.active)
    editor?.setAttribute("data-master-view", masterView.mode);
  else editor?.removeAttribute("data-master-view");
  // A master view lists the masters and layouts where the slides were.
  if (masterView.active) {
    if (refreshNavigator || !list.querySelector(".master-pane")) {
      dismissMenuWithin(list);
      slideDragCancel?.();
      clearThumbnailQueue();
      list.style.setProperty(
        "--slide-aspect",
        `${currentSize().cx} / ${currentSize().cy}`,
      );
      const hadFocus = list.contains(document.activeElement);
      masterView.renderPane(list);
      if (hadFocus)
        list
          .querySelector(".master-pane-item.active .master-pane-thumb")
          ?.focus();
    }
  } else if (refreshNavigator || list.querySelector(".master-pane")) {
    list.querySelector(".master-pane")?.remove();
    dismissMenuWithin(list);
    const focused = document.activeElement;
    const focusedRow = list.contains(focused)
      ? focused.closest(".slide-item")
      : null;
    const rowIndex = focusedRow ? [...list.children].indexOf(focusedRow) : -1;
    const buttonIndex = focusedRow
      ? [...focusedRow.querySelectorAll("button")].indexOf(focused)
      : -1;
    const previous = doc.previews;
    const next = new Map();
    slideDragCancel?.();
    clearThumbnailQueue();
    list.style.setProperty(
      "--slide-aspect",
      `${currentSize().cx} / ${currentSize().cy}`,
    );
    const chosenParts = selectedSlideParts();
    // A render depends on the slide's XML and on the deck's slide size,
    // which lives outside the slide.
    const stamp = `${currentSize().cx}x${currentSize().cy}`;
    const fonts = documentFontStamp(doc.pres);
    // Rows are kept by slide and brought up to date in place, so an edit
    // leaves the other thumbnails as the browser has drawn them rather
    // than making it draw every one again.
    const rows = new Map(
      [...list.querySelectorAll(":scope > .slide-item")].map((row) => [
        row.dataset.slidePart,
        row,
      ]),
    );
    all.forEach((s, i) => {
      const part = P.getSlidePartName(s);
      const xml = P.getSlideXmlString(s);
      const cached = previous.get(part);
      const distance = Math.abs(i - index);
      const fields = slideFieldStamp(doc.pres, s);
      const diagrams = slideDiagramDataStamp(doc.pres, s);
      // A slide also redraws when its layout, master or theme changed.
      const template = templateStamp(doc.pres, s);
      const src =
        cached?.xml === xml &&
        cached.template === template &&
        cached.diagrams === diagrams &&
        cached.stamp === stamp &&
        cached.fields === fields &&
        cached.fonts === fonts &&
        cached.src
          ? cached.src
          : distance <= EAGER_THUMBNAILS
            ? preview(doc.pres, s)
            : null;
      next.set(part, { xml, stamp, fields, fonts, diagrams, template, src });
      // Hidden slides stay editable but are skipped when presenting and
      // printing, so the navigator says so.
      const hidden = P.isSlideHidden(s);
      const chosen = chosenParts.size > 1 && chosenParts.has(part);
      let row = rows.get(part);
      rows.delete(part);
      if (!row) row = slideRow(part);
      row.className = `slide-item ${i === index ? "active" : ""} ${hidden ? "hidden-slide" : ""} ${chosen ? "selected" : ""}`;
      // A slide with animations is marked beside its number.
      if (P.slideHasAnimations(s)) row.classList.add("has-animations");
      row.querySelector(".slide-number").textContent = i + 1;
      const thumb = row.querySelector(".slide-thumb");
      thumb.setAttribute("aria-label", thumbLabel(s, i, chosen));
      review.decorateThumb(thumb, s);
      if (i === index) thumb.setAttribute("aria-current", "true");
      else thumb.removeAttribute("aria-current");
      const badge = thumb.querySelector(".slide-hidden");
      if (hidden && !badge)
        thumb.append(
          el("span", { class: "slide-hidden" }, icon("EyeOff", 11), "Hidden"),
        );
      else if (!hidden && badge) badge.remove();
      transitionTools.markRow(row, s, i + 1);
      row
        .querySelector(":scope > .icon-btn")
        .setAttribute("aria-label", `Options for slide ${i + 1}`);
      const img = thumb.querySelector("img");
      // A thumbnail waiting for its render keeps showing what it has.
      if (src) {
        if (img.getAttribute("src") !== src) img.src = src;
      } else deferThumbnail(img, s, distance);
      if (list.children[i] !== row)
        list.insertBefore(row, list.children[i] || null);
    });
    for (const row of rows.values()) row.remove();
    doc.previews = next;
    thumbnailQueue.sort(
      (a, b) =>
        pendingThumbnails.get(a).distance - pendingThumbnails.get(b).distance,
    );
    scheduleThumbnails();
    if (buttonIndex >= 0 && document.activeElement === document.body) {
      const rows = [...list.children];
      const row =
        rows.find(
          (row) => row.dataset.slidePart === focusedRow.dataset.slidePart,
        ) || rows[Math.min(rowIndex, rows.length - 1)];
      focusTarget = row?.querySelectorAll("button")[buttonIndex];
    }
  } else {
    [...list.children].forEach((row, i) => {
      row.classList.toggle("active", i === index);
      const thumb = row.querySelector(".slide-thumb");
      if (i === index) thumb.setAttribute("aria-current", "true");
      else thumb.removeAttribute("aria-current");
    });
  }
  list.scrollLeft = scroll.left;
  list.scrollTop = scroll.top;
  const part = P.getSlidePartName(slide());
  // Reveal the active slide when it changes, but leave the navigator's own
  // scroll position alone during ordinary edits.
  if (list.dataset.activePart !== part) {
    list.dataset.activePart = part;
    list
      .querySelector(".slide-item.active, .master-pane-item.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  updateSlideCount();
  document.querySelector("#slide-label").textContent = masterView.active
    ? masterView.label()
    : `SLIDE ${String(index + 1).padStart(2, "0")}${P.isSlideHidden(slide()) ? " · HIDDEN" : ""}`;
  document.querySelector("#slide-position").textContent = masterView.active
    ? MASTER_VIEW_NAMES[masterView.mode]
    : `Slide ${index + 1} of ${all.length}`;
  const notes = document.querySelector("#speaker-notes");
  if (document.activeElement !== notes || notes.dataset.slide !== part)
    notes.value = P.getSlideNotes(slide()) || "";
  notes.defaultValue = P.getSlideNotes(slide()) || "";
  notes.dataset.slide = part;
  const size = currentSize();
  const canvas = document.querySelector("#slide-canvas");
  canvas.style.aspectRatio = `${size.cx} / ${size.cy}`;
  updateAspectLabel();
  fitCanvas();
  // The navigator already rendered this slide from the same XML; reuse it
  // rather than paying for a second render of image-heavy slides.
  const image = el("img", {
    class: "slide-image",
    src: canvasPreview(slide()),
    alt: masterView.active
      ? masterView.label()
      : `Slide ${index + 1}: ${slideDescription(slide(), doc.pres) || "Blank slide"}`,
    draggable: "false",
  });
  const previous = canvasContexts.get(canvas);
  if (previous?.pres === doc.pres && previous.part === part)
    canvas.querySelector(".slide-image").replaceWith(image);
  else canvas.replaceChildren(image);
  canvasContexts.set(canvas, { pres: doc.pres, part });
  canvas.onclick = (e) => {
    if (performance.now() - marqueeEnded < 400) return;
    if (e.target === canvas || e.target.classList.contains("slide-image")) {
      clearSelection();
      renderSelection();
      renderInspector();
    }
  };
  canvas.onpointerdown = (e) => drawOnCanvas(e) || startMarquee(e);
  // An armed drawing tool draws over objects too, and Format Painter
  // applies to the object clicked rather than selecting it.
  if (!canvas.dataset.tools) {
    canvas.dataset.tools = "1";
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (drawingTool) {
          drawOnCanvas(e);
          return;
        }
        const hit =
          painter && !painter.keyboard && e.target.closest?.(".object-hit");
        if (!hit || e.button !== 0) return;
        const target = shapes().find(
          (s) => String(P.getShapeId(s)) === hit.dataset.shapeId,
        );
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        marqueeEnded = performance.now();
        paintFormat(target);
      },
      { capture: true },
    );
  }
  canvas.oncontextmenu = (e) => {
    if (e.target === canvas || e.target.classList.contains("slide-image"))
      canvasContextMenu(e);
  };
  renderCanvasAids();
  drawTools.attach();
  formatTools.afterRender();
  animationTools.attach();
  renderSelection();
  review.afterRenderSlide();
  focusTarget?.focus();
  const selectedHit =
    focusSelection && canvas.querySelector(".object-hit.selected");
  if (selectedHit) selectedHit.focus({ preventScroll: true });
  else if (focusedObject != null && document.activeElement === document.body) {
    const hits = canvas.querySelectorAll(".object-hit");
    (
      hits[Math.min(focusedObject, hits.length - 1)] ||
      document.querySelector("#main")
    )?.focus({ preventScroll: true });
  }
  views.refresh();
}
// A navigator row for one slide, built once and kept. Its buttons look the
// slide up when used: the deck behind the row changes with every edit and
// history step, so the slide they were built with may not be the one shown.
function slideRow(part) {
  const current = () =>
    P.getSlides(doc.pres).find((s) => P.getSlidePartName(s) === part);
  return el(
    "div",
    { class: "slide-item", "data-slide-part": part },
    el("span", { class: "slide-number" }),
    el(
      "button",
      {
        class: "slide-thumb",
        onclick: (e) => {
          if (slideDragClick) return;
          const s = current();
          if (!s) return;
          if (e.shiftKey) extendSlideSelection(s);
          else if (e.ctrlKey || e.metaKey) toggleSlideSelected(s);
          else chooseSlide(s);
        },
        onpointerdown: (e) => {
          const s = current();
          if (s) startSlideDrag(e, s);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          const s = current();
          if (s) slideMenu(e, s, { x: e.clientX, y: e.clientY });
        },
      },
      el("img", { alt: "", loading: "lazy", draggable: "false" }),
    ),
    iconButton(
      "Options for slide",
      "MoreHorizontal",
      (e) => {
        const s = current();
        if (s) slideMenu(e, s);
      },
      MENU_BUTTON,
    ),
  );
}
// Slides are reordered by dragging their thumbnails along the navigator. A
// line between two thumbnails shows where the dragged slide will land; the
// move happens on release. Touch keeps its scrolling and uses the menu.
let slideDragClick = false;
// The press or drag in progress along the navigator, if any; a rebuild of
// the list ends it, since the thumbnail holding its listeners is replaced.
let slideDragCancel = null;
function startSlideDrag(e, target) {
  if (e.button !== 0 || e.pointerType === "touch" || activeDrag) return;
  slideDragCancel?.();
  const list = document.querySelector("#slide-list");
  const thumb = e.currentTarget;
  const part = P.getSlidePartName(target);
  // A selected slide brings the rest of the selection along.
  const chosenParts = selectedSlideParts();
  const parts =
    chosenParts.size > 1 && chosenParts.has(part)
      ? chosenParts
      : new Set([part]);
  const start = { x: e.clientX, y: e.clientY };
  // Phones lay the thumbnails out in a row; elsewhere they stack.
  const items = [...list.querySelectorAll(".slide-item")];
  const horizontal =
    items.length > 1 &&
    Math.abs(
      items[1].getBoundingClientRect().top -
        items[0].getBoundingClientRect().top,
    ) < 1;
  let dragging = false;
  let indicator = null;
  let drop = null;
  const rows = () => [...list.querySelectorAll(".slide-item")];
  function place(ev) {
    // The slot the pointer is nearest: before the row whose middle it is
    // above (or left of), otherwise after the last one.
    const all = rows();
    let position = all.length;
    for (const [i, item] of all.entries()) {
      const r = item.getBoundingClientRect();
      const middle = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      if ((horizontal ? ev.clientX : ev.clientY) < middle) {
        position = i;
        break;
      }
    }
    drop = position;
    const anchor = all[Math.min(position, all.length - 1)];
    const r = anchor.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const after = position === all.length;
    if (horizontal) {
      indicator.style.left = `${(after ? r.right : r.left) - listRect.left + list.scrollLeft - 1}px`;
      indicator.style.top = `${r.top - listRect.top + list.scrollTop}px`;
      indicator.style.height = `${r.height}px`;
    } else {
      indicator.style.top = `${(after ? r.bottom : r.top) - listRect.top + list.scrollTop - 1}px`;
      indicator.style.left = `${r.left - listRect.left + list.scrollLeft}px`;
      indicator.style.width = `${r.width}px`;
    }
  }
  function move(ev) {
    // A release outside the thumbnail before the drag began never reached
    // it; the pointer coming back with no button down ends the press.
    if (!ev.buttons) {
      finish(false);
      return;
    }
    if (!dragging) {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 6)
        return;
      dragging = true;
      thumb.setPointerCapture(e.pointerId);
      for (const r of rows())
        if (parts.has(r.dataset.slidePart)) r.classList.add("dragging");
      list.classList.add("reordering");
      indicator = el("div", {
        class: `slide-drop ${horizontal ? "vertical" : "horizontal"}`,
        "aria-hidden": "true",
      });
      list.append(indicator);
    }
    place(ev);
  }
  function finish(apply) {
    if (slideDragCancel === cancel) slideDragCancel = null;
    thumb.removeEventListener("pointermove", move);
    thumb.removeEventListener("pointerup", end);
    thumb.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", escape, true);
    if (!dragging) return;
    if (thumb.hasPointerCapture(e.pointerId))
      thumb.releasePointerCapture(e.pointerId);
    for (const r of rows()) r.classList.remove("dragging");
    list.classList.remove("reordering");
    indicator?.remove();
    // The click that follows the release is the drag's, not a slide choice.
    slideDragClick = true;
    setTimeout(() => (slideDragClick = false), 0);
    if (!apply || drop == null) return;
    // The new order: the slides not moving, with the moving ones as a block
    // in the slot the pointer chose.
    const all = P.getSlides(doc.pres);
    const isMoving = (s) => parts.has(P.getSlidePartName(s));
    const moving = all.filter(isMoving);
    if (!moving.length) return;
    const rest = all.filter((s) => !isMoving(s));
    const before = all.slice(0, drop).filter((s) => !isMoving(s)).length;
    const order = [
      ...rest.slice(0, before),
      ...moving,
      ...rest.slice(before),
    ].map(P.getSlidePartName);
    if (order.every((p, i) => p === P.getSlidePartName(all[i]))) return;
    const currentPart = P.getSlidePartName(slide());
    const focus = parts.has(currentPart) ? [currentPart, part] : [part];
    mutate(() => {
      const slides = P.getSlides(doc.pres);
      const byPart = new Map(slides.map((s) => [P.getSlidePartName(s), s]));
      if (order.length !== slides.length || !order.every((p) => byPart.has(p)))
        return SKIP_MUTATION;
      // Each moving slide goes in front of the slide after the slot, so only
      // the moving slides change place (and join the section they land in).
      const anchor = order[before + moving.length];
      for (const p of order.slice(before, before + moving.length)) {
        const names = P.getSlides(doc.pres).map(P.getSlidePartName);
        const from = names.indexOf(p);
        let to = anchor ? names.indexOf(anchor) : names.length;
        if (to > from) to--;
        if (to !== from) P.moveSlide(doc.pres, byPart.get(p), to);
      }
      settleIndex(focus);
      clearSelection();
    });
  }
  const end = () => finish(true);
  const cancel = () => finish(false);
  function escape(ev) {
    if (ev.key === "Escape" && dragging) {
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    }
  }
  thumb.addEventListener("pointermove", move);
  thumb.addEventListener("pointerup", end);
  thumb.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", escape, true);
  slideDragCancel = cancel;
}
// The actions on a slide, for its options button in the navigator and for
// the Slide menu. When the slide is part of a selection they cover every
// selected slide. The navigator's menu leaves out a move that cannot happen;
// the Slide menu shows it disabled.
function slideActions(target, { hideUnavailable = false } = {}) {
  const all = P.getSlides(doc.pres);
  const part = P.getSlidePartName(target);
  const i = all.findIndex((s) => P.getSlidePartName(s) === part);
  if (i < 0) return [];
  const group = actionSlides(target);
  const noun = group.length > 1 ? `${group.length} slides` : "slide";
  const positions = group.map((s) =>
    all.findIndex((x) => P.getSlidePartName(x) === P.getSlidePartName(s)),
  );
  const first = Math.min(...positions),
    last = Math.max(...positions);
  const currentPart = P.getSlidePartName(slide());
  const focus = group.some((s) => P.getSlidePartName(s) === currentPart)
    ? [currentPart, part]
    : [part];
  const allHidden = group.every((s) => P.isSlideHidden(s));
  const unavailable = (condition) =>
    condition ? (hideUnavailable ? null : { disabled: true }) : {};
  return [
    {
      label: `Duplicate ${noun}`,
      icon: "Copy",
      onSelect: () => duplicateSlides(group),
    },
    {
      label: "Layout",
      icon: "o:layout",
      items: layoutCommands.layoutItems(group),
    },
    {
      label: `Reset ${noun}`,
      icon: "o:resetSlide",
      onSelect: () => layoutCommands.resetSlides(group),
    },
    {
      label: `${allHidden ? "Show" : "Hide"} ${noun}`,
      icon: allHidden ? "Eye" : "EyeOff",
      onSelect: () => setSlidesHidden(group, !allHidden),
    },
    unavailable(first === 0) && {
      label: "Move up",
      icon: "ArrowUp",
      ...unavailable(first === 0),
      onSelect: () => moveSlides(group, -1, focus),
    },
    unavailable(last === all.length - 1) && {
      label: "Move down",
      icon: "ArrowDown",
      ...unavailable(last === all.length - 1),
      onSelect: () => moveSlides(group, 1, focus),
    },
    { separator: true },
    {
      label: `Delete ${noun}`,
      icon: "Trash2",
      danger: true,
      onSelect: () => deleteSlides(group),
    },
  ].filter(Boolean);
}
// The slides an action on `target` covers: the whole selection when the
// target is part of one, otherwise the target alone.
function actionSlides(target) {
  const parts = selectedSlideParts();
  const part = P.getSlidePartName(target);
  return parts.has(part) && parts.size > 1
    ? P.getSlides(doc.pres).filter((s) => parts.has(P.getSlidePartName(s)))
    : [target];
}
const partsOf = (slides) => new Set(slides.map(P.getSlidePartName));
// Slides looked up again by part name inside a mutation, in deck order.
const resolveSlides = (parts) =>
  P.getSlides(doc.pres).filter((s) => parts.has(P.getSlidePartName(s)));
const positionOf = (part) =>
  P.getSlides(doc.pres).findIndex((s) => P.getSlidePartName(s) === part);
// After slides move, the first of these parts still in the deck is current.
function settleIndex(preferred) {
  for (const part of preferred) {
    const i = positionOf(part);
    if (i >= 0) {
      index = i;
      return;
    }
  }
  index = Math.min(index, P.getSlides(doc.pres).length - 1);
}
// Copies follow the last of the slides as a block; the first copy becomes
// current and the others stay selected with it.
function duplicateSlides(targets) {
  commitText();
  const parts = partsOf(targets);
  return mutate(() => {
    const chosen = resolveSlides(parts);
    if (!chosen.length) return SKIP_MUTATION;
    if (P.getSlides(doc.pres).length + chosen.length > 300)
      throw new Error("The slide limit is 300.");
    let at = positionOf(P.getSlidePartName(chosen.at(-1))) + 1;
    const copies = [];
    for (const s of chosen) {
      const copy = P.duplicateSlide(doc.pres, s);
      P.moveSlide(doc.pres, copy, at++);
      copies.push(P.getSlidePartName(copy));
    }
    index = at - copies.length;
    slideExtras = new Set(copies.slice(1));
    clearSelection();
  });
}
function setSlidesHidden(targets, hidden) {
  commitText();
  const parts = partsOf(targets);
  return mutate(() => {
    const chosen = resolveSlides(parts);
    if (!chosen.length) return SKIP_MUTATION;
    for (const s of chosen) P.setSlideHidden(s, hidden);
  });
}
// Each slide moves one place, the block keeping its gaps; nothing moves when
// the first is already at the top or the last at the bottom.
function moveSlides(targets, direction, focus) {
  commitText();
  const parts = partsOf(targets);
  return mutate(() => {
    const chosen = resolveSlides(parts);
    if (!chosen.length) return SKIP_MUTATION;
    const edge = positionOf(
      P.getSlidePartName(direction < 0 ? chosen[0] : chosen.at(-1)),
    );
    if (edge === (direction < 0 ? 0 : P.getSlides(doc.pres).length - 1))
      return SKIP_MUTATION;
    for (const s of direction < 0 ? chosen : [...chosen].reverse())
      P.moveSlide(doc.pres, s, positionOf(P.getSlidePartName(s)) + direction);
    settleIndex(focus);
    clearSelection();
  });
}
function deleteSlides(targets) {
  commitText();
  const parts = partsOf(targets);
  return mutate(() => {
    const chosen = resolveSlides(parts);
    if (!chosen.length) return SKIP_MUTATION;
    if (chosen.length >= P.getSlides(doc.pres).length) {
      toast("Keep at least one slide in your presentation.");
      return SKIP_MUTATION;
    }
    const activePart = P.getSlidePartName(slide());
    const first = positionOf(P.getSlidePartName(chosen[0]));
    removeSlides(doc.pres, chosen);
    const activeIndex = positionOf(activePart);
    if (activeIndex >= 0) index = activeIndex;
    else {
      index = Math.min(first, P.getSlides(doc.pres).length - 1);
      clearSelection();
    }
    slideExtras.clear();
  });
}
function slideMenu(e, target, at = null) {
  const items = slideActions(target, { hideUnavailable: true });
  if (items.length)
    menu(e.currentTarget, items, at ? { at, contextual: true } : {});
}
function renderSelection() {
  const canvas = document.querySelector("#slide-canvas");
  if (activeDrag) {
    if (
      activeDrag.canvas === canvas &&
      activeDrag.pres === doc.pres &&
      activeDrag.part === P.getSlidePartName(slide()) &&
      P.findShapeById(slide(), activeDrag.id)
    )
      return;
    activeDrag.cancel();
    return;
  }
  canvas
    .querySelectorAll(".object-hit,.selection-box,.snap-guide")
    .forEach((n) => n.remove());
  const size = currentSize();
  const visibleIds = new Set(visibleSlideShapes(slide()).map(P.getShapeId));
  const parents = groupParents(slide());
  pruneSelection();
  const ids = selectionIds();
  const activePart = P.getSlidePartName(slide());
  const minimum = hitMinimum(size);
  shapes().forEach((s, i) => {
    const b = slideBounds(doc.pres, s, parents);
    if (!b || !visibleIds.has(P.getShapeId(s))) return;
    const chosen = ids.has(P.getShapeId(s));
    const found =
      find.query &&
      find.matches.some(
        (m) => m.part === activePart && m.id === P.getShapeId(s),
      );
    const hit = el("button", {
      class: `object-hit ${chosen ? "selected" : ""} ${found ? "match" : ""}`,
      "aria-label": `${shapeLabel(s, doc.pres)}. Select to edit`,
      "aria-pressed": chosen ? "true" : "false",
      ondblclick: (e) => editText(s, e),
      onclick: (e) => {
        e.stopPropagation();
        // The click that ends a drag is the drag's, not a new selection.
        if (dragClick) return;
        const current = shapeIndex(s);
        if (current < 0) return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSelected(current);
        else {
          // A click on a selected SmartArt graphic picks the shape under it.
          if (chosen && smartArtTools.isSmartArt(s))
            smartArtTools.pickAt(
              s,
              e.offsetX / (hit.clientWidth || 1),
              e.offsetY / (hit.clientHeight || 1),
            );
          selectOnly(current);
        }
        updateSelectionUi();
        renderInspector();
      },
      oncontextmenu: (e) => objectContextMenu(e, s),
      onpointerdown: (e) => startDrag(e, s),
      "data-object": i,
      "data-shape-id": P.getShapeId(s),
    });
    placeHit(hit, b, size, slideRotation(s, parents), minimum);
    canvas.append(hit);
    if (selected === i && ids.size === 1)
      canvas.append(selectionBox(s, b, size));
  });
  if (ids.size > 1) canvas.append(multiBox(size));
  decoratePlaceholders({
    canvas,
    slide: slide(),
    masterView: masterView.active,
    available: placeholderInsertAvailable,
    insert: fillPlaceholder,
  });
  masterView.decorateCanvas(canvas);
  insertFeatures.decorateCanvas(canvas);
  smartArtTools.decorateCanvas(canvas);
}
// What an empty content placeholder's buttons can insert: tables and
// pictures always, and what else the Insert tab offers.
const PLACEHOLDER_COMMANDS = {
  chart: "insertChart",
  smartArt: "insertSmartArt",
  icons: "insertIcons",
  video: "insertVideo",
};
function placeholderInsertAvailable(id) {
  if (readOnlyDocument() || masterView.active) return false;
  if (id === "table" || id === "picture") return true;
  return typeof ribbonCommands()[PLACEHOLDER_COMMANDS[id]] === "function";
}
let ribbonCommandCache = null;
function ribbonCommands() {
  return (ribbonCommandCache ??= ribbonApi());
}
// An insert from a placeholder's button takes the placeholder's place.
function fillPlaceholder(id, shape) {
  commitText();
  const place = {
    part: P.getSlidePartName(slide()),
    id: P.getShapeId(shape),
    bounds: slideBounds(doc.pres, shape),
  };
  if (!place.bounds) return;
  if (id === "table") return tableDialog(place).catch(fail);
  if (id === "picture")
    return pickImage((file) => insertImageFile(file, place).catch(fail));
  const command = ribbonCommands()[PLACEHOLDER_COMMANDS[id]];
  if (typeof command === "function") fillAfter(() => command(), place);
}
// Another module's insert command runs as it would from the ribbon; when
// it adds one object, that object moves into the placeholder.
async function fillAfter(command, place) {
  const target = slideByPart(place.part);
  if (!target) return;
  const before = new Set(P.getSlideShapes(target).map(P.getShapeId));
  await command();
  await mutationTail;
  const after = slideByPart(place.part);
  const added = after
    ? P.getSlideShapes(after).filter((x) => !before.has(P.getShapeId(x)))
    : [];
  if (added.length !== 1) return;
  const id = P.getShapeId(added[0]);
  // The move into the placeholder is part of the insert's undo step.
  const inserted = history.bytes;
  mutateSlide(
    after,
    (s) => {
      const obj = P.findShapeById(s, id);
      const holder = P.findShapeById(s, place.id);
      if (!obj || !holder || !P.isPlaceholderEmpty(holder))
        return SKIP_MUTATION;
      const b = P.getShapeBoundsResolved(doc.pres, obj);
      P.setShapeBounds(obj, fitInto(place.bounds, b && b.h ? b.w / b.h : null));
      fillSlot(s, place, id);
      selectIds([id]);
    },
    { amends: inserted },
  );
}
// What an insert put where an empty placeholder was takes the
// placeholder's slot, and the empty placeholder goes.
function fillSlot(target, place, id) {
  const holder = place && P.findShapeById(target, place.id);
  if (!holder || !P.isPlaceholderEmpty(holder)) return;
  const filled = P.findShapeById(target, id);
  if (filled) P.adoptPlaceholderSlot(filled, holder);
  removeAnyShape(target, P.findShapeById(target, place.id));
}
// Ids of objects that have gone stay out of the selection.
function pruneSelection() {
  const present = new Set(shapes().map(P.getShapeId));
  const primary = currentShape();
  for (const id of extras)
    if (!present.has(id) || (primary && P.getShapeId(primary) === id))
      extras.delete(id);
}
// Several selected objects share one dashed outline around them all.
function multiBox(size) {
  const bounds = selectedShapes()
    .map((s) => slideBounds(doc.pres, s))
    .filter(Boolean);
  const box = el("div", {
    class: "selection-box multi",
    "aria-hidden": "true",
  });
  if (bounds.length) placeSelection(box, unionBounds(bounds), size, 0);
  return box;
}
// The upright box around an object turned about its center.
function turnedBounds(b, rotation) {
  if (!rotation) return b;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)),
    sin = Math.abs(Math.sin(rad));
  const w = b.w * cos + b.h * sin,
    h = b.w * sin + b.h * cos;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}
function unionBounds(list) {
  const x = Math.min(...list.map((b) => b.x)),
    y = Math.min(...list.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...list.map((b) => b.x + b.w)) - x,
    h: Math.max(...list.map((b) => b.y + b.h)) - y,
  };
}
const MIN_HIT_PX = 12;
// The least a hit region spans, in slide units: a finger's width on the
// canvas as it is laid out now. Reading the canvas costs a layout, so a
// render reads it once for every region it places. A canvas not yet laid
// out would make the minimum span the slide.
function hitMinimum(size) {
  const canvas = document.querySelector("#slide-canvas");
  return canvas?.clientWidth > 100
    ? (MIN_HIT_PX * size.cx) / canvas.clientWidth
    : 0;
}
// A line has no thickness to press on; its region grows to the minimum
// around it while the handles keep the true bounds.
function hitBounds(b, minimum) {
  const w = Math.max(b.w, minimum),
    h = Math.max(b.h, minimum);
  return { x: b.x - (w - b.w) / 2, y: b.y - (h - b.h) / 2, w, h };
}
function placeHit(hit, b, size, rotation, minimum = hitMinimum(size)) {
  const region = hitBounds(b, minimum);
  Object.assign(hit.style, {
    left: `${(region.x / size.cx) * 100}%`,
    top: `${(region.y / size.cy) * 100}%`,
    width: `${(region.w / size.cx) * 100}%`,
    height: `${(region.h / size.cy) * 100}%`,
    transform: `rotate(${rotation}deg)`,
  });
}
// A drag across empty canvas draws a marquee and selects what it touches;
// with Shift the objects join the selection. Touch keeps its scrolling.
let marqueeEnded = 0;
function startMarquee(e) {
  const canvas = e.currentTarget;
  if (e.button !== 0 || activeDrag || e.pointerType === "touch") return;
  if (e.target !== canvas && !e.target.classList.contains("slide-image"))
    return;
  const rect = canvas.getBoundingClientRect();
  const size = currentSize();
  const start = { x: e.clientX, y: e.clientY };
  let current = start;
  let box = null;
  const toSlide = (point) => ({
    x: ((point.x - rect.left) / rect.width) * size.cx,
    y: ((point.y - rect.top) / rect.height) * size.cy,
  });
  const area = () => {
    const a = toSlide(start),
      b = toSlide(current);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  };
  canvas.setPointerCapture(e.pointerId);
  function move(ev) {
    current = { x: ev.clientX, y: ev.clientY };
    if (!box) {
      if (Math.abs(current.x - start.x) + Math.abs(current.y - start.y) < 4)
        return;
      box = el("div", { class: "marquee", "aria-hidden": "true" });
      canvas.append(box);
    }
    const r = area();
    Object.assign(box.style, {
      left: `${(r.x / size.cx) * 100}%`,
      top: `${(r.y / size.cy) * 100}%`,
      width: `${(r.w / size.cx) * 100}%`,
      height: `${(r.h / size.cy) * 100}%`,
    });
  }
  function finish(ev, apply) {
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", end);
    canvas.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", escape, true);
    if (canvas.hasPointerCapture(e.pointerId))
      canvas.releasePointerCapture(e.pointerId);
    if (!box) return;
    box.remove();
    marqueeEnded = performance.now();
    if (!apply) return;
    const r = area();
    const parents = groupParents(slide());
    const visible = new Set(visibleSlideShapes(slide()).map(P.getShapeId));
    const hits = shapes()
      .filter((s) => {
        const id = P.getShapeId(s);
        if (!visible.has(id) || parents.has(id)) return false;
        const b = slideBounds(doc.pres, s, parents);
        if (!b) return false;
        // A turned object is met where the slide shows it.
        const shown = turnedBounds(b, slideRotation(s, parents));
        return (
          shown.x < r.x + r.w &&
          shown.x + shown.w > r.x &&
          shown.y < r.y + r.h &&
          shown.y + shown.h > r.y
        );
      })
      .map(P.getShapeId);
    const kept = ev.shiftKey ? [...selectionIds()] : [];
    selectIds([...new Set([...kept, ...hits])]);
    renderSelection();
    renderInspector();
  }
  const end = (ev) => finish(ev, true);
  const cancel = (ev) => finish(ev, false);
  // Escape lets go of the marquee before the pointer is released, as it
  // does of a dragged object; the selection goes with it, as it would then.
  function escape(ev) {
    if (ev.key === "Escape") cancel(ev);
  }
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", escape, true);
}
// The chrome around the selected object: eight handles to resize from any
// edge or corner, and a handle above it to rotate. The keyboard resizes and
// rotates through the format panel's fields, so the handles stay out of the
// tab order.
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const isLine = (obj) => P.getShapeKind(obj) === "connector";
// A line's handles are its two ends, which lie on the box's diagonal: the
// falling one, or the rising one when the line is flipped once.
function lineHandles(obj) {
  const flip = P.getShapeFlip(obj) || {};
  return !!flip.horizontal !== !!flip.vertical ? ["sw", "ne"] : ["nw", "se"];
}
function selectionBox(obj, b, size) {
  const cell = isTable(obj) ? currentCell(obj) : null;
  const rect = cell && cellRect(obj, cell.row, cell.col);
  const box = el(
    "div",
    {
      class: `selection-box ${isLine(obj) ? "line" : ""}`,
      "aria-hidden": "true",
    },
    el(
      "div",
      { class: "handle-targets" },
      ...(isLine(obj) ? lineHandles(obj) : HANDLES).map((handle) =>
        el("button", {
          type: "button",
          class: "resize-target",
          "data-handle": handle,
          tabindex: -1,
          onpointerdown: (e) => startDrag(e, obj, handle),
        }),
      ),
      el("button", {
        type: "button",
        class: "rotate-target",
        tabindex: -1,
        onpointerdown: (e) => startDrag(e, obj, "rotate"),
      }),
    ),
    el(
      "div",
      { class: "handle-controls" },
      cell &&
        el("span", {
          class: "cell-focus",
          style: `left:${((rect.x - b.x) / b.w) * 100}%;top:${((rect.y - b.y) / b.h) * 100}%;width:${(rect.w / b.w) * 100}%;height:${(rect.h / b.h) * 100}%`,
        }),
      ...(isLine(obj) ? lineHandles(obj) : HANDLES).map((handle) =>
        el("button", {
          type: "button",
          class: "resize-handle",
          "data-handle": handle,
          tabindex: -1,
          onpointerdown: (e) => startDrag(e, obj, handle),
        }),
      ),
      ...(isLine(obj) ? lineHandles(obj) : ["nw", "ne", "se", "sw"]).map(
        (corner) => el("span", { class: "corner-stem", "data-corner": corner }),
      ),
      el("span", { class: "rotate-stem" }),
      el("button", {
        type: "button",
        class: "rotate-handle",
        tabindex: -1,
        onpointerdown: (e) => startDrag(e, obj, "rotate"),
      }),
    ),
  );
  placeSelection(box, b, size, slideRotation(obj));
  return box;
}
// Small selections keep a usable center and distinct handle targets. Control
// sizes come from CSS. Enlarged capture regions have a separate layer behind
// object hits, so they never take the object's center or a neighbor's click.
function placeSelection(box, b, size, rotation, canvasWidth) {
  Object.assign(box.style, {
    left: `${(b.x / size.cx) * 100}%`,
    top: `${(b.y / size.cy) * 100}%`,
    width: `${(b.w / size.cx) * 100}%`,
    height: `${(b.h / size.cy) * 100}%`,
  });
  box.style.setProperty("--selection-rotation", `${rotation}deg`);
  if (box.classList.contains("multi") || activeDrag?.box === box) return;
  const canvas = document.querySelector("#slide-canvas");
  const scale = (canvasWidth ?? canvas?.clientWidth ?? 0) / size.cx;
  const grip = parseFloat(
    getComputedStyle(canvas).getPropertyValue("--resize-handle-size"),
  );
  const layout = selectionHandleLayout(
    b.w * scale,
    b.h * scale,
    grip,
    MIN_HIT_PX,
    box.classList.contains("line"),
  );
  box.classList.toggle("short", !layout.leftRight);
  box.classList.toggle("narrow", !layout.topBottom);
  box.style.setProperty("--handle-offset-x", `${layout.offsetX}px`);
  box.style.setProperty("--handle-offset-y", `${layout.offsetY}px`);
  for (const stem of box.querySelectorAll(".corner-stem")) {
    const corner = stem.dataset.corner;
    const x = layout.offsetX * (corner.includes("w") ? -1 : 1);
    const y = layout.offsetY * (corner.includes("n") ? -1 : 1);
    stem.style.width = `${Math.hypot(x, y)}px`;
    stem.style.transform = `rotate(${Math.atan2(y, x)}rad)`;
  }
}
function layoutCurrentSelection(canvas, width) {
  if (activeDrag) return;
  const box = canvas.querySelector(".selection-box");
  if (!box || box.classList.contains("multi")) return;
  const obj = currentShape();
  const bounds = obj && slideBounds(doc.pres, obj);
  if (bounds)
    placeSelection(box, bounds, currentSize(), slideRotation(obj), width);
}
function updateSelectionUi() {
  const canvas = document.querySelector("#slide-canvas");
  pruneSelection();
  const ids = selectionIds();
  canvas.querySelectorAll(".object-hit").forEach((n) => {
    const active = ids.has(Number(n.dataset.shapeId));
    n.classList.toggle("selected", active);
    n.setAttribute("aria-pressed", String(active));
  });
  canvas.querySelectorAll(".selection-box").forEach((n) => n.remove());
  const obj = currentShape();
  if (!obj) return;
  const size = currentSize();
  if (ids.size > 1) {
    canvas.append(multiBox(size));
    return;
  }
  const b = slideBounds(doc.pres, obj);
  if (!b) return;
  canvas.append(selectionBox(obj, b, size));
}
// Moving, resizing from a handle, or rotating the pressed object. Only that
// object shows selection chrome while the pointer is down, and the chrome
// follows the outline so the selection moves as one.
// The click the browser sends after a drag's pointer release lasts until the
// event loop turns; the flag is set for exactly that long.
let dragClick = false;
function startDrag(e, shape, mode = "move") {
  if (e.button !== 0 || activeDrag) return;
  // A press on an object with Shift, Ctrl, or Cmd adds to or takes from the
  // selection through the click that follows; it does not start a drag.
  // Handles still take Shift, which keeps the proportions.
  if (mode === "move" && (e.shiftKey || e.ctrlKey || e.metaKey)) return;
  e.stopPropagation();
  const i = shapeIndex(shape);
  if (i < 0) return;
  const obj = shapes()[i],
    b = slideBounds(doc.pres, obj),
    size = currentSize();
  if (!b) return;
  const canvas = document.querySelector("#slide-canvas");
  const overlay = [...canvas.querySelectorAll(".object-hit")].find(
    (node) => node.dataset.shapeId === String(P.getShapeId(obj)),
  );
  if (!overlay) return;
  const rect = canvas.getBoundingClientRect();
  const startX = e.clientX,
    startY = e.clientY;
  const keepRatio =
    P.getShapeKind(obj) === "picture" || P.getShapeAspectLock(obj);
  const line = isLine(obj);
  const rotation = slideRotation(obj);
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  let next = null;
  let nextRotation = null;
  activeDrag = {
    canvas,
    pres: doc.pres,
    part: P.getSlidePartName(slide()),
    id: P.getShapeId(obj),
    cancel,
  };
  // A press on one of several selected objects moves them all; any other
  // press selects the pressed object alone.
  const chosen = selectionIds();
  // A grouped object whose group moves too moves with it, not on its own.
  const parents = groupParents(slide());
  const carriedBy = (id) => carriedByGroup(id, parents, chosen);
  const together =
    mode === "move" && chosen.size > 1 && chosen.has(P.getShapeId(obj))
      ? selectedShapes().filter(
          (s) =>
            P.getShapeId(s) !== P.getShapeId(obj) &&
            !carriedBy(P.getShapeId(s)),
        )
      : [];
  const carried = together.length > 0 && carriedBy(P.getShapeId(obj));
  if (!together.length) selectOnly(i);
  renderInspector();
  const companions = together
    .map((s) => ({
      id: P.getShapeId(s),
      bounds: slideBounds(doc.pres, s),
      rotation: slideRotation(s),
      overlay: [...canvas.querySelectorAll(".object-hit")].find(
        (node) => node.dataset.shapeId === String(P.getShapeId(s)),
      ),
    }))
    .filter((c) => c.bounds && c.overlay);
  const moving = new Set([P.getShapeId(obj), ...companions.map((c) => c.id)]);
  // The objects in motion stay on the slide, and they move as one: by the
  // step the pointer asks for, or by the room the one nearest the slide's
  // edge has left, so their arrangement holds. Artwork already past an edge
  // keeps the overflow it came with.
  const held = [...(carried ? [] : [b]), ...companions.map((c) => c.bounds)];
  const withinSlide = (candidate) => {
    let dx = candidate.x - b.x,
      dy = candidate.y - b.y;
    for (const item of held) {
      const roomX =
        clampMovement(item.x + dx, item.x, size.cx - item.w) - item.x;
      const roomY =
        clampMovement(item.y + dy, item.y, size.cy - item.h) - item.y;
      if (Math.abs(roomX) < Math.abs(dx)) dx = roomX;
      if (Math.abs(roomY) < Math.abs(dy)) dy = roomY;
    }
    return { ...candidate, x: b.x + dx, y: b.y + dy };
  };
  for (const node of canvas.querySelectorAll(".object-hit")) {
    const active = moving.has(Number(node.dataset.shapeId));
    node.classList.toggle("selected", active);
    node.setAttribute("aria-pressed", String(active));
  }
  let box = canvas.querySelector(".selection-box");
  if (companions.length) {
    for (const node of canvas.querySelectorAll(".selection-box")) node.remove();
    box = null;
  } else if (!box || !box.contains(target)) {
    for (const node of canvas.querySelectorAll(".selection-box")) node.remove();
    box = selectionBox(obj, b, size);
    canvas.append(box);
  }
  if (mode === "rotate") box?.classList.add("rotating");
  // While captured, the pressed grip follows the pointer with its original
  // offset. On release the layout can settle around the new object bounds.
  activeDrag.box = box;
  // Guides: the slide's edges and center, and every other object's edges
  // and centers, that the dragged edges settle on when they come close.
  // A few pixels on a large screen; on a phone the same pixels would span a
  // good part of the slide, so the reach is capped in slide terms.
  const targets =
    rotation || line || mode === "rotate"
      ? null
      : snapTargets(
          obj,
          size,
          Math.min((SNAP_PX * size.cx) / rect.width, SNAP_MAX_EMU),
          moving,
        );
  // The angle of the pointer around the object's center, in slide space.
  const angleAt = (ev) => {
    const cx = rect.left + ((b.x + b.w / 2) / size.cx) * rect.width;
    const cy = rect.top + ((b.y + b.h / 2) / size.cy) * rect.height;
    return (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
  };
  const startAngle = mode === "rotate" ? angleAt(e) : 0;
  function move(ev) {
    const dx = ((ev.clientX - startX) / rect.width) * size.cx,
      dy = ((ev.clientY - startY) / rect.height) * size.cy;
    if (
      !next &&
      nextRotation == null &&
      Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4
    )
      return;
    if (mode === "rotate") {
      // Shift turns in 15° steps; otherwise the object settles on a right
      // angle when it comes within a few degrees of one.
      let angle = rotation + angleAt(ev) - startAngle;
      angle = ((angle % 360) + 360) % 360;
      if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
      else {
        const near = Math.round(angle / 90) * 90;
        if (Math.abs(angle - near) < 3) angle = near;
      }
      nextRotation = Math.round(angle * 10) / 10;
      overlay.style.transform = `rotate(${nextRotation}deg)`;
      if (box)
        box.style.setProperty("--selection-rotation", `${nextRotation}deg`);
      return;
    }
    let candidate =
      mode === "move"
        ? { ...b, x: b.x + dx, y: b.y + dy }
        : resizedBounds(
            b,
            dx,
            dy,
            size,
            keepRatio !== ev.shiftKey,
            mode,
            rotation,
            line,
          );
    // Alt drags freely; otherwise the edges in motion snap to the guides. A
    // resize that keeps the proportions is left alone, since a snapped edge
    // would break them.
    const snapped =
      targets && !ev.altKey && (mode === "move" || keepRatio === ev.shiftKey)
        ? snapBounds(candidate, mode, targets, { dx, dy })
        : null;
    if (snapped) candidate = snapped.bounds;
    showGuides(canvas, snapped?.guides || [], size);
    next = mode === "move" ? withinSlide(candidate) : candidate;
    placeHit(overlay, normalized(next), size, rotation);
    if (box) placeSelection(box, normalized(next), size, rotation);
    for (const c of companions)
      placeHit(
        c.overlay,
        {
          ...c.bounds,
          x: c.bounds.x + next.x - b.x,
          y: c.bounds.y + next.y - b.y,
        },
        size,
        c.rotation,
      );
  }
  function end(ev) {
    activeDrag = null;
    if (next || nextRotation != null) {
      dragClick = true;
      setTimeout(() => (dragClick = false), 0);
    }
    showGuides(canvas, [], size);
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", cancel);
    if (target.hasPointerCapture(e.pointerId))
      target.releasePointerCapture(e.pointerId);
    box?.classList.remove("rotating");
    if (nextRotation != null) {
      ev.preventDefault();
      mutateShape(obj, (obj) => {
        // The handle turns the object as the slide shows it; a grouped
        // object's own turn is what is left once its groups' turns are off.
        const angle = ownRotation(obj, nextRotation);
        if ((P.getShapeRotation(obj) || 0) === angle) {
          updateSelectionUi();
          return SKIP_MUTATION;
        }
        P.setShapeRotation(obj, angle);
      });
    } else if (next && companions.length) {
      ev.preventDefault();
      const delta = {
        x: Math.round(next.x - b.x),
        y: Math.round(next.y - b.y),
      };
      if (!delta.x && !delta.y) updateSelectionUi();
      else
        mutateSlide(slide(), (target) => {
          for (const item of [
            ...(carried ? [] : [{ id: P.getShapeId(obj), bounds: b }]),
            ...companions,
          ]) {
            const s = P.findShapeById(target, item.id);
            if (s)
              setSlideBounds(doc.pres, s, {
                ...item.bounds,
                x: item.bounds.x + delta.x,
                y: item.bounds.y + delta.y,
              });
          }
        });
    } else if (next) {
      ev.preventDefault();
      mutateShape(obj, (obj) => {
        const bounds = Object.fromEntries(
          Object.entries(normalized(next)).map(([k, v]) => [k, Math.round(v)]),
        );
        const current = slideBounds(doc.pres, obj);
        if (
          ["x", "y", "w", "h"].every(
            (key) => current && bounds[key] === Math.round(current[key]),
          )
        ) {
          updateSelectionUi();
          return SKIP_MUTATION;
        }
        // A line end dragged past the other end turns the line around.
        if (line && (next.w < 0 || next.h < 0)) {
          const flip = P.getShapeFlip(obj) || {};
          P.setShapeFlip(obj, {
            horizontal: next.w < 0 ? !flip.horizontal : !!flip.horizontal,
            vertical: next.h < 0 ? !flip.vertical : !!flip.vertical,
          });
        }
        setSlideBounds(doc.pres, obj, bounds);
        fitTableGrid(obj, bounds);
      });
    } else {
      updateSelectionUi();
    }
  }
  function cancel() {
    next = null;
    nextRotation = null;
    end(e);
    renderSelection();
  }
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", cancel);
}
/* ---------- Snapping ----------
 * While an object is dragged or resized, its edges and centers settle on the
 * slide's edges and center and on the other objects' edges and centers when
 * they come within a few pixels, and a guide line shows what they met.
 */
const SNAP_PX = 6;
const SNAP_MAX_EMU = P.inches(0.08);
// The objects in motion, the dragged one and any moving along with it,
// offer no guides: they go wherever it goes.
function snapTargets(
  obj,
  size,
  threshold,
  moving = new Set([P.getShapeId(obj)]),
) {
  // The drawing guides always offer themselves; the slide and the other
  // objects do while smart guides are on.
  const guides = views.grid.snapTargets();
  const smart = views.grid.smartGuides();
  const xs = [...guides.xs, ...(smart ? [0, size.cx / 2, size.cx] : [])];
  const ys = [...guides.ys, ...(smart ? [0, size.cy / 2, size.cy] : [])];
  if (!smart) return { xs, ys, threshold };
  const parents = groupParents(slide());
  const visible = new Set(visibleSlideShapes(slide()).map(P.getShapeId));
  for (const other of shapes()) {
    const otherId = P.getShapeId(other);
    if (moving.has(otherId) || !visible.has(otherId) || parents.has(otherId))
      continue;
    const b = slideBounds(doc.pres, other, parents);
    if (!b || slideRotation(other)) continue;
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys, threshold };
}
// The closest guide to any of the edges in motion, on each axis.
function nearest(values, targets, threshold) {
  let best = null;
  for (const value of values)
    for (const target of targets) {
      const distance = Math.abs(target - value);
      if (distance <= threshold && (!best || distance < best.distance))
        best = { distance, delta: target - value, target };
    }
  return best;
}
// An axis the pointer has barely moved along is left alone, so an object
// that starts near a guide is not pulled onto it by a drag the other way.
function snapBounds(b, mode, { xs, ys, threshold }, { dx = 0, dy = 0 } = {}) {
  const moving = mode === "move";
  const left = moving || mode.includes("w");
  const right = moving || mode.includes("e");
  const top = moving || mode.includes("n");
  const bottom = moving || mode.includes("s");
  const xEdges = [
    left && b.x,
    moving && b.x + b.w / 2,
    right && b.x + b.w,
  ].filter((v) => v !== false);
  const yEdges = [
    top && b.y,
    moving && b.y + b.h / 2,
    bottom && b.y + b.h,
  ].filter((v) => v !== false);
  const x = Math.abs(dx) >= threshold ? nearest(xEdges, xs, threshold) : null;
  const y = Math.abs(dy) >= threshold ? nearest(yEdges, ys, threshold) : null;
  const bounds = { ...b };
  const guides = [];
  // An edge that meets no guide settles on the grid when snapping is on.
  const onGrid = (values) => views.grid.gridDelta(values);
  const gx = !x && Math.abs(dx) > 0 ? onGrid(xEdges.slice(0, 1)) : null;
  const gy = !y && Math.abs(dy) > 0 ? onGrid(yEdges.slice(0, 1)) : null;
  if (gx != null) {
    if (moving) bounds.x += gx;
    else if (left) {
      bounds.x += gx;
      bounds.w -= gx;
    } else bounds.w += gx;
  }
  if (gy != null) {
    if (moving) bounds.y += gy;
    else if (top) {
      bounds.y += gy;
      bounds.h -= gy;
    } else bounds.h += gy;
  }
  if (x) {
    if (moving) bounds.x += x.delta;
    else if (left) {
      bounds.x += x.delta;
      bounds.w -= x.delta;
    } else bounds.w += x.delta;
    guides.push({ axis: "x", at: x.target });
  }
  if (y) {
    if (moving) bounds.y += y.delta;
    else if (top) {
      bounds.y += y.delta;
      bounds.h -= y.delta;
    } else bounds.h += y.delta;
    guides.push({ axis: "y", at: y.target });
  }
  return { bounds, guides };
}
function showGuides(canvas, guides, size) {
  canvas.querySelectorAll(".snap-guide").forEach((n) => n.remove());
  for (const guide of guides) {
    const node = el("div", {
      class: `snap-guide ${guide.axis === "x" ? "vertical" : "horizontal"}`,
      "aria-hidden": "true",
    });
    if (guide.axis === "x") node.style.left = `${(guide.at / size.cx) * 100}%`;
    else node.style.top = `${(guide.at / size.cy) * 100}%`;
    canvas.append(node);
  }
}
// Bounds whose width or height ran negative, as a line's may, read as a box.
const normalized = (b) => ({
  x: b.w < 0 ? b.x + b.w : b.x,
  y: b.h < 0 ? b.y + b.h : b.y,
  w: Math.abs(b.w),
  h: Math.abs(b.h),
});
// The bounds after dragging one handle. The opposite edge or corner stays
// where it is, also for a rotated object, whose pointer movement is read in
// its own frame. Pictures keep their proportions unless Shift is held, and
// other objects keep theirs while Shift is held. A line's end may cross the
// other end, so its width or height may come back negative.
function resizedBounds(
  b,
  dx,
  dy,
  size,
  keepRatio,
  handle = "se",
  rotation = 0,
  line = false,
) {
  const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad),
    sin = Math.sin(rad);
  // The pointer's movement in the object's own frame.
  const ldx = dx * cos + dy * sin,
    ldy = -dx * sin + dy * cos;
  const minW = Math.min(P.inches(0.15), b.w),
    minH = Math.min(P.inches(0.15), b.h);
  let w = b.w + sx * ldx,
    h = b.h + sy * ldy;
  if (line) {
    // Nothing to keep in proportion or clamp: the ends go where the pointer is.
  } else if (keepRatio && b.w > 0 && b.h > 0) {
    // Corners follow the larger movement; an edge scales the other side along.
    const scale =
      sx && sy
        ? Math.abs(ldx) / b.w >= Math.abs(ldy) / b.h
          ? w / b.w
          : h / b.h
        : sx
          ? w / b.w
          : h / b.h;
    w = b.w * Math.max(scale, minW / b.w, minH / b.h);
    h = (b.h * w) / b.w;
  } else {
    w = Math.max(minW, w);
    h = Math.max(minH, h);
  }
  if (!rotation && !line) {
    // Unrotated objects stay on the slide, save for artwork already past
    // its edge, which may shrink but not grow further.
    if (sx > 0) w = Math.min(w, Math.max(b.w, size.cx - b.x));
    if (sx < 0) w = Math.min(w, Math.max(b.w, b.x + b.w));
    if (sy > 0) h = Math.min(h, Math.max(b.h, size.cy - b.y));
    if (sy < 0) h = Math.min(h, Math.max(b.h, b.y + b.h));
    if (keepRatio && b.w > 0 && b.h > 0) {
      const scale = Math.min(w / b.w, h / b.h);
      w = b.w * scale;
      h = b.h * scale;
    }
  }
  // The fixed point (opposite the handle) stays put in slide space, so the
  // center moves by half the change, turned by the rotation.
  const fx = sx ? -sx : 0,
    fy = sy ? -sy : 0;
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  const fixedX = cx + ((fx * b.w) / 2) * cos - ((fy * b.h) / 2) * sin;
  const fixedY = cy + ((fx * b.w) / 2) * sin + ((fy * b.h) / 2) * cos;
  const ncx = fixedX + ((-fx * w) / 2) * cos - ((-fy * h) / 2) * sin;
  const ncy = fixedY + ((-fx * w) / 2) * sin + ((-fy * h) / 2) * cos;
  return { x: ncx - w / 2, y: ncy - h / 2, w, h };
}
// Any shape can take text; a shape drawn without any gets
// its text body the moment text or formatting reaches it.
// Tables take text formatting too: it goes to the current cell.
const canEditText = (obj) => canHoldText(obj) || isTable(obj);
const cellOf = (obj) => {
  const { row, col } = currentCell(obj);
  return P.getTableCell(obj, row, col);
};
// Cell text starts from the table style's defaults where a run says nothing.
const CELL_TEXT_DEFAULTS = { font: "Arial", size: 18 };
const FONTS = [
  "Arial",
  "Calibri",
  "Cambria",
  "Comic Sans MS",
  "Courier New",
  "Garamond",
  "Georgia",
  "Helvetica",
  "Impact",
  "Palatino",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];
const FONT_SIZES = [
  8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72,
  80, 88, 96,
];
const LINE_SPACINGS = [
  [1, "Single"],
  [1.15, "1.15"],
  [1.5, "1.5"],
  [2, "Double"],
];
const TEXT_ALIGNMENTS = [
  ["left", "Align left", "AlignLeft"],
  ["center", "Align center", "AlignCenter"],
  ["right", "Align right", "AlignRight"],
  ["justify", "Justify", "TextAlignJustify"],
];
const TEXT_ANCHORS = [
  ["top", "Align top", "AlignVerticalJustifyStart"],
  ["center", "Align middle", "AlignVerticalJustifyCenter"],
  ["bottom", "Align bottom", "AlignVerticalJustifyEnd"],
];
// The next size up or down the ladder from `current`.
function stepFontSize(current, direction) {
  const size = Number(current) || 18;
  if (direction > 0)
    return FONT_SIZES.find((n) => n > size + 0.01) ?? Math.min(400, size + 8);
  return (
    [...FONT_SIZES].reverse().find((n) => n < size - 0.01) ??
    Math.max(1, size - 1)
  );
}
// Text typed into a shape that had none reads on the shape's own fill.
function defaultShapeTextFormat(obj) {
  const surface =
    P.getShapeFillColorResolvedEffective(doc.pres, obj) ||
    slideBackground(P.getShapeSlide(obj)).color;
  return {
    font: "Arial",
    size: 18,
    color: legibleColor(surface, [THEMES[theme].ink, "#ffffff"], 4.5),
  };
}
// Gives a plain shape its text body before an edit that needs one.
function withTextBody(obj) {
  if (ensureTextBody(obj))
    P.setShapeTextFormat(obj, defaultShapeTextFormat(obj));
  return obj;
}
// The objects a text change from the toolbar, the Format menu, or the
// keyboard reaches: every selected object that takes text when the changed
// object is one of several selected, otherwise that object
// alone. A table among several is left out, since its change would land on
// one cell of it.
function textTargets(obj) {
  const ids = selectionIds();
  const id = P.getShapeId(obj);
  if (ids.size < 2 || !ids.has(id)) return [obj];
  return selectedShapes().filter(
    (s) => canEditText(s) && (P.getShapeId(s) === id || !isTable(s)),
  );
}
// One change to one object, or the same change to each of several selected
// objects as one undo step, recorded when at least one of them changed.
function textMutation(obj, fn, options) {
  const targets = textTargets(obj);
  if (targets.length === 1)
    return mutateShape(
      obj,
      (obj, targetSlide) => fn(withTextBody(obj), targetSlide),
      options,
    );
  const ids = targets.map(P.getShapeId);
  return mutateSlide(
    P.getShapeSlide(obj),
    (targetSlide) => {
      let changed = false;
      for (const id of ids) {
        const target = P.findShapeById(targetSlide, id);
        if (target && fn(withTextBody(target), targetSlide) !== SKIP_MUTATION)
          changed = true;
      }
      return changed ? undefined : SKIP_MUTATION;
    },
    options,
  );
}
// The panel's Content field writes its lines back paragraph by paragraph.
// A paragraph's soft breaks showed as lines too: while the lines still match
// up they rejoin their paragraphs; otherwise each line is a paragraph. Each
// keeps the settings, and the formatting its text started with, of the
// paragraph at its place, or of the last one.
function contentTextField(obj, props) {
  const input = el("textarea", props);
  const fields = shapeTextFields(doc.pres, obj);
  if (fields.length) input.fieldEdits = trackTextFields(input, fields);
  return input;
}
function setText(obj, value, fields = []) {
  withTextBody(obj);
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const before = textRuns(doc.pres, obj);
  const shown = before.flatMap((paragraph, i) =>
    paragraph.runs
      .map((run) => run.text)
      .join("")
      .split(SOFT_BREAK)
      .map((_, k) => ({ paragraph: i, first: k === 0 })),
  );
  const matched = shown.length === lines.length;
  const paragraphs = [];
  lines.forEach((line, i) => {
    if (matched && !shown[i].first) {
      paragraphs.at(-1).runs[0].text += SOFT_BREAK + line;
      return;
    }
    const source = matched
      ? before[shown[i].paragraph]
      : before[Math.min(i, before.length - 1)];
    const run =
      source?.runs.find((r) => !r.fld && r.text.replaceAll(SOFT_BREAK, "")) ||
      source?.runs[0];
    paragraphs.push({
      level: source?.level ?? 0,
      ppr: source?.ppr ?? null,
      runs: [
        {
          text: line,
          format: { ...(run?.format || {}) },
          rpr: run?.rpr ?? null,
          changes: {},
        },
      ],
    });
  });
  setRichText(obj, retainTextFields(paragraphs, fields, before));
}
// The format of the shape's text: that of its first run or field, or for an
// empty placeholder the format typed text would take, resolved through the
// paragraph and the layout and master it inherits from. A shape without a
// text body reports the format its text would get.
function textFormat(obj) {
  if (isTable(obj))
    return { ...CELL_TEXT_DEFAULTS, ...cellFormat(cellOf(obj)) };
  if (!hasTextBody(obj)) return defaultShapeTextFormat(obj);
  const first = firstTextElement(obj);
  if (first)
    return (
      (first.kind === "fld"
        ? P.getShapeFieldFormatEffective(doc.pres, obj, first.paragraphIndex, 0)
        : P.getShapeRunFormatEffective(
            doc.pres,
            obj,
            first.paragraphIndex,
            0,
          )) || {}
    );
  return (
    P.getShapeRunFormatEffective(
      doc.pres,
      obj,
      Math.max(0, P.getShapeParagraphCount(obj) - 1),
      0,
    ) || {}
  );
}
// Underline and strikethrough come back as style tokens; "none" is off.
const decorated = (value) =>
  !!value && value !== "none" && value !== "noStrike";
// Formatting lives on text runs, and an empty placeholder has none until text
// is typed. Give it an empty run so the format applies and typed text keeps it.
// A live field already carries character properties and must not be replaced.
function formatText(obj, format) {
  if (isTable(obj)) {
    P.setTableCellTextFormat(cellOf(obj), format);
    return;
  }
  withTextBody(obj);
  if (!firstTextElement(obj)) P.setShapeText(obj, "");
  P.setShapeTextFormat(obj, format);
}
// Font, size, and color from the toolbar or the panel: on the open editor's
// selection while text is edited, otherwise on the whole shape.
function applyTextFormat(obj, format, options) {
  const editor = editorFor(obj);
  if (editor) {
    editor.apply(format, { refocus: !("color" in format) });
    return;
  }
  return textMutation(obj, (obj) => formatText(obj, format), options);
}
// Indenting steps every paragraph's level, or the editor's selection while
// text is edited.
function changeIndent(obj, delta) {
  const editor = editorFor(obj);
  if (editor) {
    editor.indent(delta);
    return;
  }
  return textMutation(obj, (obj) => {
    if (isTable(obj)) return SKIP_MUTATION;
    let changed = false;
    for (let i = 0; i < P.getShapeParagraphCount(obj); i++) {
      const level = P.getParagraphLevel(obj, i) || 0;
      const next = Math.max(
        0,
        Math.min(LEVEL_INDENTS.length - 1, level + delta),
      );
      if (next === level) continue;
      let bulleted = false;
      try {
        const bullet = P.getParagraphBullet(obj, i);
        bulleted = !!bullet && bullet !== "none";
      } catch {}
      setParagraphIndentLevel(obj, i, next, bulleted);
      changed = true;
    }
    if (!changed) return SKIP_MUTATION;
  });
}
// Bold, italic, underline, and strikethrough come on unless the object
// already has them; of several selected objects, the primary decides, and
// the rest take the same state.
function toggleTextFormat(obj, key) {
  const editor = editorFor(obj);
  if (editor) {
    editor.toggle(key);
    return;
  }
  const primaryId = P.getShapeId(obj);
  let on = null;
  return textMutation(obj, (target, targetSlide) => {
    if (on == null) {
      const primary = P.findShapeById(targetSlide, primaryId) || target;
      const current = textFormat(withTextBody(primary))[key];
      on = !(key === "underline" || key === "strike"
        ? decorated(current)
        : current);
    }
    formatText(target, { [key]: on });
  });
}
function stepTextSize(obj, direction) {
  const editor = editorFor(obj);
  if (editor) {
    const current = editor.selectionFormat().size || textFormat(obj).size;
    editor.apply({ size: stepFontSize(current, direction) });
    return;
  }
  return textMutation(obj, (obj) => {
    const current = Number(textFormat(obj).size) || 18;
    const next = stepFontSize(current, direction);
    // At either end of the ladder there is nothing to record.
    return next === current ? SKIP_MUTATION : formatText(obj, { size: next });
  });
}
function setAlignment(obj, alignment) {
  const editor = editorFor(obj);
  if (editor) {
    editor.align(alignment);
    return;
  }
  return textMutation(obj, (obj) =>
    textAligned(obj, alignment)
      ? SKIP_MUTATION
      : isTable(obj)
        ? P.setTableCellAlignment(cellOf(obj), alignment)
        : P.setShapeAlignment(obj, alignment),
  );
}
// Where the text sits in its box: top, middle, or bottom.
function textAnchor(obj) {
  if (isTable(obj)) {
    try {
      return P.getTableCellAnchor(cellOf(obj)) || "top";
    } catch {
      return "top";
    }
  }
  if (!hasTextBody(obj)) return "center";
  try {
    return P.getShapeBodyPrEffective(doc.pres, obj).anchor || "top";
  } catch {
    return "top";
  }
}
function setAnchor(obj, anchor) {
  return textMutation(obj, (obj) =>
    textAnchor(obj) === anchor
      ? SKIP_MUTATION
      : isTable(obj)
        ? P.setTableCellAnchor(cellOf(obj), anchor)
        : P.setShapeTextAnchor(obj, anchor),
  );
}
// The list style of the text: bullets, numbers, or none.
// A paragraph's list style, alignment-like settings read the first
// paragraph's for the toolbar; a change to the whole box looks at all of them.
function paragraphList(obj, i) {
  try {
    return listOf(
      P.getParagraphBullet(obj, i) ??
        P.getParagraphPropertiesEffective(doc.pres, obj, i)?.bullet,
    );
  } catch {
    return "none";
  }
}
const eachParagraph = (obj, read) =>
  Array.from({ length: P.getShapeParagraphCount(obj) }, (_, i) => read(obj, i));
function listStyle(obj) {
  const editor = editorFor(obj);
  if (editor) return editor.paragraphState().list;
  if (!hasTextBody(obj)) return "none";
  return paragraphList(obj, 0);
}
function toggleList(obj, style) {
  const editor = editorFor(obj);
  if (editor) {
    editor.toggleListStyle(style);
    return;
  }
  const primaryId = P.getShapeId(obj);
  let next = null;
  return textMutation(obj, (target, targetSlide) => {
    if (isTable(target)) return SKIP_MUTATION;
    if (next == null) {
      // The style comes off only when every paragraph already has it; of
      // several selected objects, the primary's paragraphs decide.
      const primary = P.findShapeById(targetSlide, primaryId) || target;
      const list = isTable(primary) ? target : withTextBody(primary);
      next = eachParagraph(list, paragraphList).every((l) => l === style)
        ? "none"
        : style;
    }
    P.setShapeBullets(target, next);
    if (next === "none") clearListIndent(target);
  });
}
// A paragraph's line spacing as a multiple of single spacing, as the library
// counts it: 1.5 is 150%. A fixed spacing in points is none of the multiples
// and reads as its points, "20pt".
function paragraphLineSpacing(obj, i) {
  try {
    const spacing = P.getParagraphPropertiesEffective(
      doc.pres,
      obj,
      i,
    )?.lineSpacing;
    if (!spacing) return 1;
    if (spacing.kind === "pct") return Math.round(spacing.value * 100) / 100;
    return spacing.kind === "pts" && spacing.value > 0
      ? `${Math.round(spacing.value * 10) / 10}pt`
      : 1;
  } catch {
    return 1;
  }
}
const spacingLabel = (spacing) =>
  typeof spacing === "string"
    ? `Exactly ${parseFloat(spacing)} pt`
    : String(spacing);
function lineSpacing(obj) {
  const editor = editorFor(obj);
  if (editor) return editor.paragraphState().lineSpacing;
  if (!hasTextBody(obj)) return 1;
  return paragraphLineSpacing(obj, 0);
}
function setLineSpacing(obj, factor) {
  // Only a multiple of single spacing is on offer.
  if (!(factor > 0)) return;
  const editor = editorFor(obj);
  if (editor) {
    editor.setParagraphs({ lineSpacing: factor }, "lineSpacingChanged");
    return;
  }
  return textMutation(obj, (obj) => {
    if (
      isTable(obj) ||
      eachParagraph(obj, paragraphLineSpacing).every((s) => s === factor)
    )
      return SKIP_MUTATION;
    for (let i = 0; i < P.getShapeParagraphCount(obj); i++)
      P.setParagraphLineSpacing(
        obj,
        i,
        factor === 1 ? null : { kind: "pct", value: factor },
      );
  });
}
// The space before and after paragraphs, in points: the caret's paragraph
// while editing, otherwise the first paragraph's, set on all of them.
function paragraphSpacing(obj) {
  const editor = editorFor(obj);
  if (editor) {
    const { spaceBefore, spaceAfter, spaceBeforePct, spaceAfterPct } =
      editor.paragraphState();
    return {
      before: spaceBefore,
      after: spaceAfter,
      beforePct: spaceBeforePct,
      afterPct: spaceAfterPct,
    };
  }
  if (!hasTextBody(obj) || isTable(obj)) return { before: 0, after: 0 };
  return paragraphSpacingAt(obj, 0);
}
function paragraphSpacingAt(obj, i) {
  try {
    const spacing = P.getParagraphPropertiesEffective(doc.pres, obj, i);
    return {
      before: spacing.spcBefPts ?? 0,
      after: spacing.spcAftPts ?? 0,
      beforePct: spacing.spcBefPct,
      afterPct: spacing.spcAftPct,
    };
  } catch {
    return { before: 0, after: 0 };
  }
}
function setParagraphSpacing(obj, change) {
  const editor = editorFor(obj);
  if (editor) {
    editor.setParagraphs(
      {
        ...(change.before != null && {
          spaceBefore: change.before,
          spaceBeforePct: undefined,
          spaceBeforeChanged: true,
        }),
        ...(change.after != null && {
          spaceAfter: change.after,
          spaceAfterPct: undefined,
          spaceAfterChanged: true,
        }),
        ...(change.beforePct != null && {
          spaceBeforePct: change.beforePct,
          spaceBeforeChanged: true,
        }),
        ...(change.afterPct != null && {
          spaceAfterPct: change.afterPct,
          spaceAfterChanged: true,
        }),
      },
      "spacingChanged",
    );
    return;
  }
  return textMutation(obj, (obj) => {
    if (isTable(obj)) return SKIP_MUTATION;
    const spacing = {};
    for (const side of ["before", "after"]) {
      if (change[side] != null) spacing[`${side}Pts`] = change[side];
      else if (change[`${side}Pct`] != null)
        spacing[`${side}Pct`] = change[`${side}Pct`];
    }
    for (let i = 0; i < P.getShapeParagraphCount(obj); i++)
      P.setParagraphSpacing(obj, i, spacing);
  });
}
function paragraphSpacingInput(obj, side) {
  const spacing = paragraphSpacing(obj);
  const percent = spacing[`${side}Pct`];
  const value =
    percent != null ? Math.round(percent * 100000) / 1000 : spacing[side];
  return numInput(
    `Space ${side} (${percent != null ? "%" : "pt"})`,
    value,
    (n) =>
      setParagraphSpacing(
        obj,
        percent != null ? { [`${side}Pct`]: n / 100 } : { [side]: n },
      ),
    0,
    200,
    1,
  );
}
function clampMovement(value, origin, limit) {
  // Include existing overflow so imported artwork moves without snapping.
  return Math.max(
    Math.min(0, limit, origin),
    Math.min(Math.max(0, limit, origin), value),
  );
}
async function editDiagramText(target) {
  const owner = doc,
    part = P.getSlidePartName(P.getShapeSlide(target)),
    id = P.getShapeId(target);
  await settled();
  if (doc !== owner || readOnlyDocument()) return;
  const pres = owner.pres,
    source = P.getSlides(pres).find((s) => P.getSlidePartName(s) === part),
    obj = source && P.findShapeById(source, id);
  if (!obj) return;
  let entries;
  try {
    entries = P.getShapeDiagramTextEntries(obj);
    const result = reflowShapeDiagram(obj, { textFits: () => true });
    if (!result) return;
    buildDiagramDrawing(obj, result);
  } catch {
    toast("This diagram’s layout isn’t supported for text editing yet.");
    return;
  }
  if (!entries.length) {
    toast("This diagram has no text items to edit.");
    return;
  }
  const fields = entries.map((entry, index) => ({
    entry,
    input: el("textarea", {
      class: "input",
      rows: Math.max(2, Math.min(6, entry.text.split("\n").length)),
      value: entry.text,
      "aria-label": `Item ${index + 1} text`,
      autofocus: index === 0,
    }),
  }));
  for (const field of fields) {
    const { input, entry } = field;
    field.history = textEditHistory(entry.text);
    let pending = null,
      line = false;
    input.addEventListener("keydown", (event) => {
      line =
        event.key === "Enter" &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey;
    });
    input.addEventListener("beforeinput", (event) => {
      pending = {
        start: input.selectionStart,
        end: input.selectionEnd,
        type: event.inputType,
        line,
      };
    });
    input.addEventListener("input", (event) => {
      field.history.input(input.value, {
        ...pending,
        type: event.inputType || pending?.type,
        afterStart: input.selectionStart,
      });
      pending = null;
      line = false;
    });
  }
  const body = el(
    "form",
    { class: "dialog-body" },
    el("p", {}, "Replace the text of individual items in this diagram."),
    el(
      "div",
      { class: "diagram-text-fields" },
      ...fields.map(({ entry, input }, index) =>
        el(
          "label",
          {
            style: {
              marginInlineStart: `${Math.max(0, Math.min(8, entry.depth - 1)) * 12}px`,
            },
          },
          `Item ${index + 1}`,
          input,
        ),
      ),
    ),
  );
  body.addEventListener("keydown", (e) => {
    if (!e.isComposing && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      body.requestSubmit();
    }
  });
  const ok = await dialog({
    title: "Edit diagram text",
    body,
    confirm: "Apply",
    returnFocus: () =>
      (doc === owner &&
        P.getSlidePartName(slide()) === part &&
        document.querySelector(`.object-hit[data-shape-id="${id}"]`)) ||
      workspace(),
  });
  if (!ok || doc !== owner || doc.pres !== pres) return;
  const changes = fields
    .filter(({ entry, input }) => input.value !== entry.text)
    .map(({ entry, input, history }) => ({
      modelId: entry.modelId,
      text: input.value,
      edits: history.edits(),
    }));
  if (!changes.length) return;
  await mutateShape(
    obj,
    (shape) => P.replaceShapeDiagramText(shape, changes) || SKIP_MUTATION,
  );
  if (doc === owner && P.getSlidePartName(slide()) === part)
    document.querySelector(`.object-hit[data-shape-id="${id}"]`)?.focus();
}

// `inserted` is the history's snapshot of the insert that drew the object,
// for a text box opened for typing as it is drawn.
function editText(target, event = null, { inserted = null } = {}) {
  if (readOnlyDocument()) return;
  if (review.blocksEdits()) return review.blockedEdit();
  const i = shapeIndex(target);
  if (i < 0) return;
  const obj = shapes()[i];
  if (insertFeatures.open(obj)) return;
  if (P.isDiagramShape(obj)) {
    if (P.getShapeSmartArt?.(obj)?.layout) smartArtTools.openPane(obj);
    else editDiagramText(obj);
    return;
  }
  if (chartTools.isChart(obj)) {
    chartTools.editData(obj);
    return;
  }
  if (isTable(obj)) {
    let { row, col } = currentCell(obj);
    if (event) {
      const canvas = document.querySelector("#slide-canvas");
      const rect = canvas.getBoundingClientRect();
      const size = currentSize();
      ({ row, col } = cellAt(
        obj,
        ((event.clientX - rect.left) / rect.width) * size.cx,
        ((event.clientY - rect.top) / rect.height) * size.cy,
      ));
    }
    editTableCell(obj, row, col);
    return;
  }
  if (!canEditText(obj)) return;
  // Text is edited in one object; the rest of a selection lets go.
  if (selected !== i || extras.size) {
    selectOnly(i);
    updateSelectionUi();
    renderInspector();
  }
  const canvas = document.querySelector("#slide-canvas"),
    size = currentSize(),
    b = slideBounds(doc.pres, obj);
  if (!b) return;
  const format = textFormat(obj);
  // A resized group scales its text along with its shapes.
  const own = P.getShapeBoundsResolved(doc.pres, obj);
  const groupScale = own?.h && b.h ? b.h / own.h : 1;
  // The text as runs, with paragraph breaks as newlines inside them. The
  // editor shows one span per run and reads them back after every edit, so
  // typing lands in the run it touches and keeps that run's formatting.
  const copyRun = (run, text = run.text) => ({
    text,
    format: { ...run.format },
    rpr: run.rpr,
    changes: { ...run.changes },
    // A field keeps its element, and goes back as a field for as long as
    // its text is left alone.
    ...(run.fld ? { fld: run.fld } : {}),
  });
  const paragraphs = textRuns(doc.pres, obj);
  let runs = [];
  paragraphs.forEach((paragraph, pi) => {
    const list = paragraph.runs.length
      ? paragraph.runs
      : [{ text: "", format: { ...format }, rpr: null, changes: {} }];
    runs.push(...list.map((run) => copyRun(run)));
    if (pi < paragraphs.length - 1) runs.at(-1).text += "\n";
  });
  const base = runs[0]
    ? copyRun(runs[0], "")
    : { text: "", format: { ...format }, rpr: null, changes: {} };
  runs = runs.filter((run) => run.text);
  // One entry per paragraph: its list level, shown as an indent, and its
  // own properties, kept with the paragraph block the editor renders. The
  // shape's alignment is read once, before the editor stands in for it.
  const shapeAlignment = paragraphAlignment(obj) || "left";
  const blank = () => ({
    level: 0,
    ppr: null,
    changed: false,
    align: shapeAlignment,
    list: "none",
    lineSpacing: 1,
    spaceBefore: 0,
    spaceAfter: 0,
  });
  let paras = paragraphs.map((paragraph) => ({
    ...blank(),
    level: paragraph.level || 0,
    ppr: paragraph.ppr,
    align: paragraph.align || "left",
    list: paragraph.list || "none",
    lineSpacing: paragraph.lineSpacing || 1,
    spaceBefore: paragraph.spaceBefore || 0,
    spaceAfter: paragraph.spaceAfter || 0,
    spaceBeforePct: paragraph.spaceBeforePct,
    spaceAfterPct: paragraph.spaceAfterPct,
  }));
  if (!paras.length) paras = [blank()];
  const serialize = (list, blocks) =>
    JSON.stringify([
      list.map((run) => [run.text, run.changes]),
      blocks.map((b) => [
        b.level,
        b.align,
        b.list,
        b.lineSpacing,
        b.spaceBefore,
        b.spaceAfter,
        b.spaceBeforePct,
        b.spaceAfterPct,
      ]),
    ]);
  // What the editor holds before any edit, read back the way a commit reads
  // it, so opening and leaving the editor never counts as an edit.
  let initial = "";
  // The presentation the text belongs to. Undo, redo, and a switch to another
  // presentation close the editor first; should one slip through, a commit
  // never lands on a presentation the text was not typed in.
  const owner = doc,
    pres = doc.pres;
  const input = el("div", {
    class: "inline-editor",
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": "Edit text",
    contenteditable: "true",
    spellcheck: "true",
  });
  // The editor shows the text the way the slide does: its font, weight, and
  // colors on the shape's fill or the slide background, as long as the pair
  // stays readable.
  const surface =
    P.getShapeFillColorResolvedEffective(doc.pres, obj) ||
    slideBackground(slide()).color;
  const legible = (color) =>
    luminance(color) != null &&
    luminance(surface) != null &&
    contrast(luminance(color), luminance(surface)) >= 3;
  const readable = legible(format.color);
  const baseSize = format.size || 24;
  const resolveFont = slideFontResolver(slide(), doc.pres);
  const decoration = (f) =>
    [
      decorated(f.underline) && "underline",
      decorated(f.strike) && "line-through",
    ]
      .filter(Boolean)
      .join(" ") || "none";
  const geometryTextRect = textEditorRectangle(doc.pres, obj);
  const editorRect = geometryTextRect || b;
  Object.assign(input.style, {
    left: `${(editorRect.x / size.cx) * 100}%`,
    top: `${(editorRect.y / size.cy) * 100}%`,
    width: `${(editorRect.w / size.cx) * 100}%`,
    height: `${(editorRect.h / size.cy) * 100}%`,
    fontSize: `${Math.max(14, (baseSize * groupScale * canvas.clientWidth) / (size.cx / 914400) / 72)}px`,
    fontFamily: format.font ? resolveFont(format.font) : "",
    fontWeight: format.bold ? "700" : "400",
    fontStyle: format.italic ? "italic" : "normal",
    fontKerning:
      resolveFontKerning({ ...format, family: resolveFont(format.font) }) ||
      "auto",
    textDecoration: decoration(format),
    textAlign: paragraphAlignment(obj) || "left",
    // Text stays where the box anchors it (a title slide's title sits at
    // the bottom of its box) while it is typed.
    display: "flex",
    flexDirection: "column",
    justifyContent:
      { ctr: "center", b: "flex-end" }[textAnchor(obj)] || "flex-start",
    color: readable ? format.color : "",
    background: readable ? surface : "",
    // The editor lies over the box as the slide turns it, about the same
    // center, so the text is edited where it is shown.
    transform: `rotate(${geometryTextRect?.rotation ?? slideRotation(obj)}deg)`,
    ...(geometryTextRect
      ? {
          padding: "0",
          border: "0",
          outline: "2px solid var(--accent)",
        }
      : {}),
  });
  const text = () => runs.map((run) => run.text).join("");
  // The paragraph an offset falls in, counted in the text given: the runs
  // fall behind the text on screen while the browser types, so a reading
  // of the screen measures its own text.
  const paragraphAt = (offset, value = text()) =>
    value.slice(0, offset).split("\n").length - 1;
  const textOf = (list) => list.map((run) => run.text).join("");
  const styleRun = (span, f) =>
    Object.assign(span.style, {
      fontWeight: f.bold ? "700" : "400",
      fontStyle: f.italic ? "italic" : "normal",
      fontKerning:
        resolveFontKerning({
          ...f,
          family: resolveFont(f.font || format.font),
        }) || "auto",
      textDecoration: decoration(f),
      fontSize:
        f.size && Math.abs(f.size - baseSize) > 0.01
          ? `${f.size / baseSize}em`
          : "",
      fontFamily: f.font && f.font !== format.font ? resolveFont(f.font) : "",
      color:
        readable && f.color && f.color !== format.color && legible(f.color)
          ? f.color
          : "",
    });
  // One block per paragraph, indented by its level, holding a span per run.
  function render() {
    const spacing = textParagraphSpacing(
      pres,
      obj,
      runParagraphs(runs).map((p, i) => ({ ...p, ...(paras[i] || blank()) })),
    );
    const blocks = [];
    let block = null;
    const open = () => {
      const k = blocks.length;
      const para = paras[k] || blank();
      const level = para.level || 0;
      block = el("div", {
        class: "para",
        "data-para": String(k),
        "data-level": String(level),
        "data-list": para.list || "none",
      });
      block.style.paddingLeft = level ? `${level * 1.5}em` : "";
      block.style.textAlign = para.align || "";
      block.style.lineHeight =
        para.lineSpacing && para.lineSpacing !== 1
          ? String(Math.round(1.2 * para.lineSpacing * 100) / 100)
          : "";
      const before =
        spacing?.[k]?.beforePx != null
          ? spacing[k].beforePx * 0.75
          : para.spaceBefore;
      const after =
        spacing?.[k]?.afterPx != null
          ? spacing[k].afterPx * 0.75
          : para.spaceAfter;
      block.style.marginTop = before ? `${before / baseSize}em` : "";
      block.style.marginBottom = after ? `${after / baseSize}em` : "";
      blocks.push(block);
    };
    open();
    runs.forEach((run, i) => {
      run.text.split("\n").forEach((piece, j) => {
        if (j > 0) open();
        if (!piece) return;
        // A soft break shows as a line break inside the paragraph.
        const span = el("span", { "data-run": String(i) });
        piece.split(SOFT_BREAK).forEach((line, k) => {
          if (k > 0) span.append(el("br", { "data-break": "" }));
          if (line) span.append(line);
        });
        styleRun(span, run.format);
        block.append(span);
      });
    });
    // An empty paragraph needs a line break to give the caret a home, and so
    // does the empty line after a soft break at the end of one.
    for (const b of blocks)
      if (!b.childNodes.length || endsWithBreak(b)) b.append(el("br"));
    input.replaceChildren(...blocks);
  }
  const isBlock = (node) => ["DIV", "P", "LI"].includes(node.nodeName);
  const isBreak = (node) =>
    node instanceof Element && node.matches("br[data-break]");
  const endsWithBreak = (block) => {
    let node = block;
    while (node?.lastChild) node = node.lastChild;
    return isBreak(node);
  };
  // The runs and levels as the editor's DOM now holds them: text inside a
  // run's span keeps that run's formatting; text the browser put elsewhere
  // continues the run before it, or the first run's when there is none. Each
  // block is a paragraph with its level.
  function read() {
    const next = [];
    const blocks = [];
    let last = null;
    let started = false;
    const fallback = () => paras[0] || blank();
    const add = (value, source) => {
      const from = source || last?.source || base;
      if (last && last.source === from) {
        last.text += value;
        return;
      }
      last = { ...copyRun(from, value), source: from };
      next.push(last);
    };
    const paragraph = (props) => {
      if (started) add("\n", null);
      started = true;
      blocks.push({ ...props });
    };
    const walk = (parent, props) => {
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (!started) paragraph(props);
          const span = child.parentElement?.closest("[data-run]");
          add(child.data, span ? runs[Number(span.dataset.run)] : null);
        } else if (isBreak(child)) {
          if (!started) paragraph(props);
          const span = child.closest("[data-run]");
          add(SOFT_BREAK, span ? runs[Number(span.dataset.run)] : null);
        } else if (isBlock(child)) {
          const own =
            paras[Number(child.dataset.para)] || blocks.at(-1) || props;
          paragraph(own);
          walk(child, own);
        } else if (child.nodeName !== "BR") walk(child, props);
      }
    };
    walk(input, fallback());
    if (!started) paragraph(fallback());
    return {
      runs: splitFieldEdges(
        next.filter((run) => run.text).map(({ source, ...run }) => run),
      ),
      paras: blocks,
    };
  }
  function readRuns() {
    const current = read();
    paras = current.paras;
    return current.runs;
  }
  // Offsets count the text of the blocks in order, with a newline between
  // blocks and a soft break's element as one character; within a block a
  // range measures the text before a point.
  const blocks = () =>
    [...input.childNodes].filter((n) => n.nodeType === Node.ELEMENT_NODE);
  const breaksIn = (root) => root.querySelectorAll("br[data-break]").length;
  function blockStarts() {
    const list = blocks();
    const starts = [];
    let pos = 0;
    list.forEach((b, i) => {
      starts.push(pos);
      pos += b.textContent.length + breaksIn(b) + (i < list.length - 1 ? 1 : 0);
    });
    return { list, starts, length: pos };
  }
  function pointOffset(node, offset) {
    const { list, starts, length } = blockStarts();
    const measure = (root) => {
      const r = document.createRange();
      r.setStart(root, 0);
      r.setEnd(node, offset);
      const breaks = [...root.querySelectorAll("br[data-break]")].filter(
        (br) => r.comparePoint(br, 0) === 0,
      ).length;
      return r.toString().length + breaks;
    };
    if (!list.length) return measure(input);
    if (node === input) return offset >= list.length ? length : starts[offset];
    const block = list.find((b) => b === node || b.contains(node));
    return block ? starts[list.indexOf(block)] + measure(block) : 0;
  }
  function selectionOffsets() {
    const sel = getSelection();
    if (!sel?.rangeCount || !input.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    return [
      pointOffset(range.startContainer, range.startOffset),
      pointOffset(range.endContainer, range.endOffset),
    ];
  }
  function setSelection(start, end) {
    const place = (offset) => {
      const { list, starts } = blockStarts();
      let root = input;
      let rel = offset;
      if (list.length) {
        let k = list.length - 1;
        while (k > 0 && starts[k] > offset) k--;
        root = list[k];
        rel = offset - starts[k];
      }
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      );
      let node,
        lastNode = null;
      while ((node = walker.nextNode())) {
        if (isBreak(node)) {
          const at = [...node.parentNode.childNodes].indexOf(node);
          if (rel <= 0) return [node.parentNode, at];
          rel -= 1;
          if (rel === 0) return [node.parentNode, at + 1];
          continue;
        }
        if (node.nodeType !== Node.TEXT_NODE) continue;
        if (rel <= node.data.length) return [node, Math.max(0, rel)];
        rel -= node.data.length;
        lastNode = node;
      }
      return lastNode ? [lastNode, lastNode.data.length] : [root, 0];
    };
    const range = document.createRange();
    range.setStart(...place(start));
    range.setEnd(...place(Math.max(start, end)));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // Splits the runs so `offset` falls on a boundary and returns the index of
  // the run that starts there.
  function splitAt(offset) {
    let pos = 0;
    for (let i = 0; i < runs.length; i++) {
      const len = runs[i].text.length;
      if (offset === pos) return i;
      if (offset < pos + len) {
        const run = runs[i];
        runs.splice(
          i,
          1,
          copyRun(run, run.text.slice(0, offset - pos)),
          copyRun(run, run.text.slice(offset - pos)),
        );
        return i + 1;
      }
      pos += len;
    }
    return runs.length;
  }
  // Typed or pasted text continues the run before it; `field` makes the run
  // for a field shown as `value` from that run instead.
  function replaceRange(start, end, value, field = null) {
    remember();
    runs = readRuns();
    // Paragraphs removed with the text go; new ones take after the one split.
    const at = paragraphAt(start);
    paras.splice(at + 1, text().slice(start, end).split("\n").length - 1);
    const added = value.split("\n").length - 1;
    paras.splice(
      at + 1,
      0,
      ...Array.from({ length: added }, () => ({ ...paras[at] })),
    );
    const from = splitAt(start),
      to = splitAt(end);
    const source = runs[from - 1] || runs[from] || base;
    runs.splice(
      from,
      to - from,
      field ? field(source) : copyRun(source, value),
    );
    runs = runs.filter((run) => run.text);
    render();
    setSelection(start + value.length, start + value.length);
  }
  // The runs between two offsets, whole; a collapsed selection stands for
  // the run its caret ends.
  function runsBetween(list, start, end) {
    const found = [];
    let pos = 0;
    for (const run of list) {
      const to = pos + run.text.length;
      if (start === end ? start > pos && start <= to : start < to && end > pos)
        found.push(run);
      pos = to;
    }
    return found.length ? found : list.slice(0, 1);
  }
  const isOn = (run, key) =>
    key === "underline" || key === "strike"
      ? decorated(run.format[key])
      : !!run.format[key];
  // While a toolbar or panel control has the focus the editor stays open,
  // suspended, with the selection it had; the control's change applies to
  // that selection and, unless the control keeps going, hands the focus back.
  let suspended = false,
    saved = null;
  const selection = () => selectionOffsets() || saved;
  // Undo and redo inside the editor. The browser's own undo loses track of
  // the text once the editor redraws it, as it does for a paragraph break
  // or a change of format, so the editor keeps its own steps: the runs and
  // the paragraphs before each change, with the selection to put back.
  const undoSteps = [],
    redoSteps = [];
  let typingKind = null,
    typingSince = 0;
  const TYPING_STEP_MS = 1000;
  const snapshot = () => {
    const current = read();
    return { runs: current.runs, paras: current.paras, sel: selection() };
  };
  // A burst of typing, or of deleting, is one step; anything else is its own.
  function remember(kind = null) {
    const now = Date.now();
    if (kind && kind === typingKind && now - typingSince < TYPING_STEP_MS) {
      typingSince = now;
      return;
    }
    typingKind = kind;
    typingSince = kind ? now : 0;
    undoSteps.push(snapshot());
    if (undoSteps.length > 200) undoSteps.shift();
    redoSteps.length = 0;
  }
  function stepHistory(from, to) {
    const entry = from.pop();
    if (!entry) return false;
    to.push(snapshot());
    typingKind = null;
    runs = entry.runs.map((run) => copyRun(run));
    paras = entry.paras.map((para) => ({ ...para }));
    render();
    if (entry.sel) setSelection(entry.sel[0], entry.sel[1]);
    syncToolbar();
    return true;
  }
  // With nothing left to take back here, the step before the edit is the
  // one to take back: the editor closes, as it does for undo elsewhere, and
  // the presentation's own history steps.
  function undoWithin() {
    if (stepHistory(undoSteps, redoSteps)) return;
    // The box stays for the undo to find: a text box just drawn goes with
    // its insert.
    keepEmpty = true;
    finish(false);
    undo();
  }
  const redoWithin = () => stepHistory(redoSteps, undoSteps);
  // Formatting applies to the selected text, or to the whole box when
  // nothing is selected.
  function apply(change, { refocus = true } = {}) {
    remember(`apply:${Object.keys(change).join()}`);
    runs = readRuns();
    const sel = selection() || [0, text().length];
    const [start, end] = sel[0] === sel[1] ? [0, text().length] : sel;
    const [from, to] = fieldFormattingRange(runs, start, end);
    const list = runs.slice(splitAt(from), splitAt(to));
    // With no text left, the change goes to the run the text typed next
    // takes after.
    for (const run of list.length ? list : [base]) {
      Object.assign(run.format, change);
      Object.assign(run.changes, change);
    }
    runs = runs.filter((run) => run.text);
    render();
    saved = sel;
    if (refocus) {
      suspended = false;
      input.focus();
    }
    setSelection(sel[0], sel[1]);
    syncToolbar();
  }
  function toggle(key) {
    const sel = selection() || [0, text().length];
    const [start, end] = sel[0] === sel[1] ? [0, text().length] : sel;
    const list = runsBetween(read().runs, start, end);
    // With no text left, the run the text typed next takes after decides.
    const on = list.length
      ? list.every((run) => isOn(run, key))
      : isOn(base, key);
    apply({ [key]: !on });
  }
  // Tab and Shift+Tab step the selected paragraphs in and out.
  function indent(delta) {
    const current = read();
    const blocks = current.paras.map((para) => ({ ...para }));
    const sel = selection() || [0, 0];
    const value = textOf(current.runs);
    const from = paragraphAt(sel[0], value),
      to = paragraphAt(sel[1], value);
    let changed = false;
    for (let i = from; i <= to; i++) {
      const para = blocks[i] || (blocks[i] = blank());
      const next = Math.max(
        0,
        Math.min(LEVEL_INDENTS.length - 1, para.level + delta),
      );
      if (next === para.level) continue;
      blocks[i] = { ...para, level: next, changed: true };
      changed = true;
    }
    if (!changed) return;
    remember();
    runs = current.runs;
    paras = blocks;
    render();
    saved = sel;
    setSelection(sel[0], sel[1]);
  }
  // The paragraphs the selection touches, by index.
  // The paragraphs the selection touches, by index. A caller about to
  // change them takes the text as the editor now holds it; one only asking,
  // as the toolbar does on every selection change, leaves the editor's runs
  // alone, since the spans on screen index the runs they were drawn from.
  function coveredParagraphs({ take = true } = {}) {
    const current = read();
    if (take) {
      runs = current.runs;
      paras = current.paras;
    }
    const sel = selection() || [0, 0];
    const value = textOf(current.runs);
    const list = [];
    for (
      let i = paragraphAt(sel[0], value);
      i <= paragraphAt(sel[1], value);
      i++
    )
      list.push(i);
    return { sel, list, blocks: current.paras };
  }
  // Restore after the command's menu cleanup, before another keyboard event
  // can reach the menu anchor. A timer leaves focus stranded for a task.
  function refocusSoon(sel) {
    saved = sel;
    queueMicrotask(() => {
      if (closed) return;
      suspended = false;
      input.focus();
      setSelection(sel[0], sel[1]);
      syncToolbar();
    });
  }
  // Alignment and lists apply to the paragraphs the selection touches.
  function align(alignment) {
    remember();
    const { sel, list } = coveredParagraphs();
    for (const i of list)
      paras[i] = {
        ...(paras[i] || blank()),
        align: alignment,
        alignChanged: true,
      };
    render();
    refocusSoon(sel);
  }
  function toggleListStyle(style) {
    remember();
    const { sel, list } = coveredParagraphs();
    const on = list.every((i) => (paras[i] || blank()).list === style);
    for (const i of list)
      paras[i] = {
        ...(paras[i] || blank()),
        list: on ? "none" : style,
        listChanged: true,
      };
    render();
    refocusSoon(sel);
  }
  // What the toolbar shows for the caret's paragraph.
  // Line spacing and the space before and after apply to the paragraphs the
  // selection touches.
  function setParagraphs(change, flag) {
    remember();
    const { sel, list } = coveredParagraphs();
    for (const i of list)
      paras[i] = { ...(paras[i] || blank()), ...change, [flag]: true };
    render();
    refocusSoon(sel);
  }
  function paragraphState() {
    const { list, blocks } = coveredParagraphs({ take: false });
    const para = blocks[list[0]] || blank();
    return {
      align: para.align || "left",
      list: para.list || "none",
      lineSpacing: para.lineSpacing || 1,
      spaceBefore: para.spaceBefore || 0,
      spaceAfter: para.spaceAfter || 0,
      spaceBeforePct: para.spaceBeforePct,
      spaceAfterPct: para.spaceAfterPct,
    };
  }
  // What the toolbar shows for the selection: on when every run in it is.
  function selectionFormat() {
    const sel = selection() || [0, 0];
    const list = runsBetween(read().runs, sel[0], sel[1]);
    const result = { ...(list[0] || base).format };
    for (const key of ["bold", "italic", "underline", "strike"])
      result[key] = list.length
        ? list.every((run) => isOn(run, key))
        : isOn(base, key);
    return result;
  }
  let cancelled = false,
    keepEmpty = false;
  const finish = (cancel) => {
    cancelled = cancel;
    input.blur();
    [...canvas.querySelectorAll(".object-hit")]
      .find((hit) => hit.dataset.shapeId === String(P.getShapeId(obj)))
      ?.focus({ preventScroll: true });
  };
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["s", "p"].includes(e.key.toLowerCase()))
      return;
    // The Font and Paragraph dialogs open from the text being edited.
    if (!e.isComposing && formatTools.onKeydown(e, { typing: true })) {
      e.stopPropagation();
      return;
    }
    // Spelling, Thesaurus and New Comment work from inside the text too.
    if (
      e.key === "F7" ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyM")
    )
      return;
    // Keys pressed while an input method composes text belong to the
    // composition: Escape there drops a candidate, not the whole edit.
    if (e.isComposing) {
      e.stopPropagation();
      return;
    }
    // Shortcuts that leave the object alone reach the presentation from the
    // text too: alignment, find, zoom, the views, presenting. The editor
    // keeps its own, the keys that move through or change the text, and on a
    // Mac the Control+letter keys that move through it there.
    if (!sharedEditorKey(e)) e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "z" || key === "y") {
        e.preventDefault();
        if (key === "y" || e.shiftKey) redoWithin();
        else undoWithin();
        return;
      }
      // Larger or smaller text, on the selected text.
      if (e.shiftKey && [">", "<", ".", ","].includes(e.key)) {
        e.preventDefault();
        stepTextSize(obj, [">", "."].includes(e.key) ? 1 : -1);
        return;
      }
      // Duplicating the object waits until the text is left; the browser's
      // bookmark does not take the key meanwhile.
      if (key === "d" && (IS_MAC ? e.metaKey : e.ctrlKey)) {
        e.preventDefault();
        return;
      }
    }
    const style = { b: "bold", i: "italic", u: "underline" }[
      e.key.toLowerCase()
    ];
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && style) {
      e.preventDefault();
      toggle(style);
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      // In a paragraph with tab stops of its own, Tab types a tab.
      const sel = selectionOffsets();
      if (!e.shiftKey && sel) {
        const current = read();
        const block = current.paras[paragraphAt(sel[0], textOf(current.runs))];
        if (block?.ppr?.children?.some((c) => c.name?.localName === "tabLst")) {
          replaceRange(sel[0], sel[1], "\t");
          return;
        }
      }
      indent(e.shiftKey ? -1 : 1);
      return;
    }
    // Escape leaves the text, keeping what was typed, and selects the
    // object; undo takes the typing back.
    if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
      e.preventDefault();
      finish(false);
    }
  });
  // Line breaks and pasted text go through the runs; the browser's own rich
  // formatting and drops stay out.
  input.addEventListener("beforeinput", (e) => {
    // The browser's undo, asked for through its menu, is the editor's.
    if (["historyUndo", "historyRedo"].includes(e.inputType)) {
      e.preventDefault();
      if (e.inputType === "historyRedo") redoWithin();
      else undoWithin();
      return;
    }
    // Enter starts a paragraph; Shift+Enter breaks the line inside it.
    if (["insertParagraph", "insertLineBreak"].includes(e.inputType)) {
      e.preventDefault();
      const sel = selectionOffsets();
      if (sel)
        replaceRange(
          sel[0],
          sel[1],
          e.inputType === "insertParagraph" ? "\n" : SOFT_BREAK,
        );
    } else if (
      e.inputType.startsWith("format") ||
      ["insertFromDrop", "insertLink", "insertFromPaste"].includes(e.inputType)
    )
      e.preventDefault();
    // Anything else the browser types or deletes itself.
    else remember(e.inputType.startsWith("delete") ? "delete" : "insert");
  });
  input.addEventListener("paste", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const value = (e.clipboardData?.getData("text/plain") || "").replace(
      /\r\n?/g,
      "\n",
    );
    const sel = selectionOffsets();
    if (value && sel) replaceRange(sel[0], sel[1], value);
  });
  input.addEventListener("drop", (e) => e.preventDefault());
  input.addEventListener("input", () => syncToolbar());
  const controls = (node) =>
    node instanceof Element &&
    node.closest(
      ".ribbon, .ribbon-gallery-panel, .ribbon-fold-panel, #inspector, .menu, .menubar, .mobile-only, .review-pane, .format-dialog",
    );
  let closed = false;
  // `keep` leaves an emptied box in place for an undo to find.
  function close({ keep = false } = {}) {
    if (closed) return;
    if (keep) keepEmpty = true;
    closed = true;
    document.removeEventListener("focusin", elsewhere);
    document.removeEventListener("pointerdown", elsewhere);
    const next = readRuns();
    const blocks = paras;
    input.remove();
    if (richEditor?.input === input) richEditor = null;
    syncToolbar();
    const live = !cancelled && doc === owner && doc.pres === pres;
    // A text box left with no text and nothing to draw goes, as it would
    // otherwise stay an invisible object; one just drawn goes with its
    // insert, so no undo step is left behind for it.
    if (
      live &&
      !keepEmpty &&
      !next.some((run) => run.text) &&
      emptyFrame(obj)
    ) {
      const id = P.getShapeId(obj);
      mutateSlide(
        P.getShapeSlide(obj),
        (target) => {
          const shape = P.findShapeById(target, id);
          if (!shape || !removeAnyShape(target, shape)) return SKIP_MUTATION;
          if (P.getSlidePartName(slide()) === P.getSlidePartName(target))
            selectIds([...selectionIds()].filter((other) => other !== id));
        },
        { takesBack: inserted },
      );
    } else if (live && serialize(next, blocks) !== initial)
      mutateShape(obj, (obj) => {
        withTextBody(obj);
        const paragraphs = runParagraphs(next);
        paragraphs.forEach((paragraph, i) => {
          const block = blocks[i] || blocks.at(-1) || {};
          paragraph.level = block.level || 0;
          paragraph.ppr = block.ppr || null;
          paragraph.levelChanged = !!block.changed;
          paragraph.align = block.align;
          paragraph.alignChanged = !!block.alignChanged;
          paragraph.list = block.list;
          paragraph.listChanged = !!block.listChanged;
          paragraph.lineSpacing = block.lineSpacing || 1;
          paragraph.lineSpacingChanged = !!block.lineSpacingChanged;
          paragraph.spaceBefore = block.spaceBefore || 0;
          paragraph.spaceAfter = block.spaceAfter || 0;
          paragraph.spacingChanged = !!block.spacingChanged;
          paragraph.spaceBeforePct = block.spaceBeforePct;
          paragraph.spaceAfterPct = block.spaceAfterPct;
          paragraph.spaceBeforeChanged = !!block.spaceBeforeChanged;
          paragraph.spaceAfterChanged = !!block.spaceAfterChanged;
        });
        setRichText(obj, paragraphs);
      });
  }
  // Focus or a press anywhere but the editor and its controls ends a
  // suspended edit.
  function elsewhere(e) {
    if (suspended && !input.contains(e.target) && !controls(e.target)) close();
  }
  input.addEventListener("blur", (e) => {
    if (closed) return;
    if (controls(e.relatedTarget)) {
      suspended = true;
      saved = selectionOffsets() || saved;
      return;
    }
    close();
  });
  input.addEventListener("focus", () => {
    if (suspended) {
      suspended = false;
      if (saved) setSelection(saved[0], saved[1]);
    }
  });
  document.addEventListener("focusin", elsewhere);
  document.addEventListener("pointerdown", elsewhere);
  render();
  {
    const current = read();
    initial = serialize(current.runs, current.paras);
  }
  canvas.append(input);
  richEditor = {
    input,
    part: P.getSlidePartName(slide()),
    id: P.getShapeId(obj),
    // Whether the text differs from the shape's, for the unload warning.
    dirty: () => {
      const current = read();
      return serialize(current.runs, current.paras) !== initial;
    },
    close,
    toggle,
    apply,
    indent,
    align,
    toggleListStyle,
    setParagraphs,
    paragraphState,
    selectionFormat,
    // The paragraphs the selection touches, for dialogs that change them.
    paragraphRange: () => coveredParagraphs({ take: false }).list,
    // For the review panes and AutoCorrect: the text as typed so far.
    text: () =>
      read()
        .runs.map((run) => run.text)
        .join(""),
    selectionOffsets: () => selection(),
    setSelection,
    replaceRange,
    selectedText: () => {
      const sel = selection();
      return sel
        ? read()
            .runs.map((run) => run.text)
            .join("")
            .slice(sel[0], sel[1])
        : "";
    },
    // A field put in at the caret, or over the selection.
    insertField: (value, field) => {
      const sel = selection();
      if (!sel) return false;
      replaceRange(sel[0], sel[1], value, field);
      refocusSoon([sel[0] + value.length, sel[0] + value.length]);
      return true;
    },
    replaceSelection: (value) => {
      const sel = selection();
      if (!sel || sel[0] === sel[1]) return false;
      replaceRange(sel[0], sel[1], value);
      saved = [sel[0], sel[0] + value.length];
      return true;
    },
    superscript: (from, to) => {
      setSelection(from, to);
      apply({ baseline: 30000 }, { refocus: false });
    },
  };
  review.attachEditor(richEditor);
  input.focus();
  getSelection()?.selectAllChildren(input);
}
// The text editor open on the canvas, if any: the toolbar's bold, italic,
// underline, and strikethrough act on its selection while it is.
let richEditor = null;
// Whether a key pressed in a canvas text editor goes on to the app's own
// shortcuts: a Ctrl or ⌘ shortcut other than the editor's own and the ones
// that move through or change the text, or F5. On a Mac, Control with some
// letters moves through the text, as it does in every text field there.
function sharedEditorKey(e) {
  if (e.key === "F5") return true;
  if (!e.ctrlKey && !e.metaKey) return false;
  if (IS_MAC && !e.metaKey && /^Key[ABDEFHKLNOPTVY]$/.test(e.code))
    return false;
  return !/^([abcdiuvxyz]|Arrow.*|Page.*|Home|End|Enter|Escape|Backspace|Delete)$/i.test(
    e.key,
  );
}
// A text box of the slide's own with no fill and no outline: with no text,
// nothing of it shows.
function emptyFrame(obj) {
  if (!P.isShapeTextBox(obj) || P.isShapePlaceholder(obj)) return false;
  if (groupParents(P.getShapeSlide(obj)).has(P.getShapeId(obj))) return false;
  const unpainted = (paint) => ["none", "inherit"].includes(paint?.kind);
  return (
    unpainted(P.getShapeFillEffective(doc.pres, obj)) &&
    unpainted(P.getShapeStrokeEffective(doc.pres, obj))
  );
}
const editorFor = (obj) =>
  richEditor &&
  obj &&
  richEditor.id === P.getShapeId(obj) &&
  richEditor.part === P.getSlidePartName(P.getShapeSlide(obj))
    ? richEditor
    : null;
// Runs with newlines inside them, as paragraphs of runs without.
function runParagraphs(runs) {
  const paragraphs = [{ runs: [] }];
  for (const run of runs) {
    run.text.split("\n").forEach((piece, i) => {
      if (i > 0) paragraphs.push({ runs: [] });
      if (piece) paragraphs.at(-1).runs.push({ ...run, text: piece });
    });
  }
  return paragraphs;
}
document.addEventListener("selectionchange", () => {
  if (richEditor) syncToolbar();
});
const luminance = (color) => {
  const hex = normalizeColor(color);
  if (!/^[a-f\d]{6}$/.test(hex)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
// Prefer the first palette color that stays legible on the slide's own
// background, falling back to whichever candidate contrasts most.
function legibleColor(background, candidates, minimum) {
  const base = luminance(background);
  if (base == null) return candidates[0];
  const ratio = (color) => contrast(luminance(color), base);
  return (
    candidates.find((color) => ratio(color) >= minimum) ||
    candidates.reduce((best, color) =>
      ratio(color) > ratio(best) ? color : best,
    )
  );
}
// `place`, when given, positions the new object before it is shown: the
// drawing tool uses it for an object clicked or dragged onto the slide.
function addObject(type, place = null) {
  commitText();
  return mutateSlide(slide(), (target) => {
    const t = THEMES[theme];
    const background = slideBackground(target).color;
    // Shapes that read as a square keep equal sides, arrows lie wide, and
    // all are centered where the rectangle would sit.
    const [x, y, w, h] = SQUARE_PRESETS.has(type)
      ? [3.7, 2.2, 2.2, 2.2]
      : WIDE_PRESETS.has(type)
        ? [3.3, 2.5, 3, 1.5]
        : [3.3, 2.3, 3, 2];
    const s =
      type === "text"
        ? text(
            target,
            "Your text here",
            1.2,
            1.6,
            6.5,
            1,
            28,
            legibleColor(background, [t.ink, sectionTextColor(theme)], 4.5),
          )
        : type === "line" || type === "arrow"
          ? line(
              target,
              3.3,
              3.3,
              8.3,
              3.3,
              legibleColor(background, [t.ink, t.accent, t.panel], 3),
              { arrow: type === "arrow" },
            )
          : shape(
              target,
              x,
              y,
              w,
              h,
              legibleColor(background, [t.accent, t.panel, t.ink], 2),
              type,
            );
    place?.(s);
    if (P.getSlidePartName(slide()) === P.getSlidePartName(target))
      selectIds([P.getShapeId(s)]);
  });
}
const IMAGE_TYPES = ["image/png", "image/jpeg"];
const isImageFile = (file) => IMAGE_TYPES.includes(file?.type);
function pickImage(handle) {
  pickLocalFile(IMAGE_TYPES.join(","), handle);
}
function insertImage() {
  pickImage(insertImageFile);
}
// A picture behind everything on the slide. The image part it replaces, and
// any earlier background image, leave the file with it.
async function setBackgroundImage(file) {
  const target = doc,
    part = P.getSlidePartName(slide());
  const bytes = await readImageFile(file);
  if (doc !== target) return;
  await mutate(() => {
    const destination = slideByPart(part);
    if (!destination) throw new Error("The slide was removed.");
    P.setSlideBackgroundImage(destination, bytes);
    // New bytes under the same part name leave the slide's XML as it was.
    doc.previews.delete(part);
    pruneUnusedMedia(doc.pres, destination);
    dedupeSlideMedia(doc.pres, destination);
  });
}
function removeBackgroundImage() {
  const target = slide();
  mutateSlide(target, (target) => {
    if (P.getSlideBackground(target).kind !== "image") return SKIP_MUTATION;
    P.setSlideBackground(target, THEMES[theme].bg);
    pruneUnusedMedia(doc.pres, target);
  });
}
// New bytes for an existing picture, which keeps its place, size, and text.
async function replaceImage(obj, file) {
  const target = doc;
  const bytes = await readImageFile(file);
  if (doc !== target) return;
  await mutateShape(obj, (obj, targetSlide) => {
    P.setShapeImage(obj, bytes);
    P.setShapeDescription(obj, file.name);
    // New bytes under the same part name leave the slide's XML as it was.
    doc.previews.delete(P.getSlidePartName(targetSlide));
    pruneUnusedMedia(doc.pres, targetSlide);
    dedupeSlideMedia(doc.pres, targetSlide);
  });
}
function checkImageFile(file) {
  if (!isImageFile(file)) throw new Error("Choose a PNG or JPEG image.");
  if (file.size > 12 * 1024 * 1024)
    throw new Error("Choose an image smaller than 12 MB.");
}
// A file named like a picture but holding something else would reach the
// slide as a broken image, or be refused in the browser's own words.
async function decodeImage(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(
      "This file could not be read as an image. Choose a PNG or JPEG.",
    );
  }
}
// A picture larger than a slide can show at twice its size on screen is
// scaled down as it comes in, keeping its kind: a photo straight from a
// phone would otherwise make every edit of its slide redraw many megabytes
// of it. The original stays when the scaled copy would not be smaller.
const MAX_IMAGE_PX = 2560;
async function readImage(file) {
  checkImageFile(file);
  const bitmap = await decodeImage(file);
  const image = { width: bitmap.width, height: bitmap.height };
  let bytes = new Uint8Array(await file.arrayBuffer());
  const scale = MAX_IMAGE_PX / Math.max(bitmap.width, bitmap.height);
  if (scale < 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, file.type, 0.92),
    );
    if (blob && blob.size < bytes.byteLength) {
      bytes = new Uint8Array(await blob.arrayBuffer());
      image.width = canvas.width;
      image.height = canvas.height;
    }
  }
  bitmap.close();
  return { bytes, ...image };
}
async function readImageFile(file) {
  return (await readImage(file)).bytes;
}
// `place` puts the picture in an empty placeholder, which it replaces; a
// place with a `box` puts it there (EMU), as a picture pasted in place of
// copied objects does.
async function insertImageFile(file, place = null) {
  commitText();
  const target = doc,
    part = place?.part ?? P.getSlidePartName(slide());
  const image = await readImage(file);
  const bytes = image.bytes;
  const width = 5,
    height = Math.min(4, (width * image.height) / image.width);
  const w = (height * image.width) / image.height;
  if (doc !== target) return;
  await mutate(() => {
    const destination = slideByPart(part);
    if (!destination)
      throw new Error(
        "The original slide was removed. Insert the image again on another slide.",
      );
    const s = P.addSlideImage(
      destination,
      bytes,
      place?.box
        ? {
            x: Math.round(place.box.x),
            y: Math.round(place.box.y),
            w: Math.max(1, Math.round(place.box.w)),
            h: Math.max(1, Math.round(place.box.h)),
          }
        : place
          ? fitInto(place.bounds, image.width / image.height)
          : {
              x: P.inches(1),
              y: P.inches(1.5),
              w: P.inches(w),
              h: P.inches(height),
            },
    );
    P.setShapeDescription(s, file.name);
    fillSlot(destination, place, P.getShapeId(s));
    // The same picture inserted twice travels once in the file.
    dedupeSlideMedia(doc.pres, destination);
    if (P.getSlidePartName(slide()) === part) selectIds([P.getShapeId(s)]);
  });
}
function field(label, control) {
  return el("label", { class: "field" }, el("span", {}, label), control);
}
function numInput(label, value, onchange, min = 0, max = 100, step = 0.1) {
  // Imported decks may contain values outside our normal editing limits.
  const input = el("input", {
    type: "number",
    class: "input",
    value,
    min: Math.min(min, value),
    max: Math.max(max, value),
    step,
    "aria-label": label,
    onchange: (e) => {
      let n = e.target.valueAsNumber;
      if (!Number.isFinite(n)) {
        e.target.value = e.target.defaultValue;
        return;
      }
      // A value past the field's range takes the nearest end of it, as the
      // field shows.
      n = Math.max(Number(e.target.min), Math.min(Number(e.target.max), n));
      e.target.value = String(n);
      // "0.80" for 0.8 is not an edit; keep the history and redo stack as is.
      if (n === Number(e.target.defaultValue)) {
        e.target.value = e.target.defaultValue;
        return;
      }
      // The committed value follows the model's once the edit lands, which
      // may have clamped or normalized it; an edit that changed nothing
      // shows the model's value again.
      e.target.dataset.committed = e.target.value;
      Promise.resolve(onchange(n)).then((applied) => {
        if (applied === false && e.target.dataset.committed === e.target.value)
          e.target.value = e.target.defaultValue;
      });
    },
  });
  input.defaultValue = String(value);
  return field(label, input);
}
function colorInput(
  label,
  value,
  onchange,
  { empty = null, fallback = "#202420" } = {},
) {
  const current = /^#?[a-f\d]{6}$/i.test(value || "")
    ? value.startsWith("#")
      ? value
      : `#${value}`
    : null;
  const normalized = current || fallback;
  // Browsers differ on whether pickers fire input, change, or both while a
  // color is being adjusted; apply each distinct value once.
  let applied = current?.toLowerCase() ?? null;
  const apply = (e) => {
    const next = e.target.value;
    if (next.toLowerCase() === applied) return;
    applied = next.toLowerCase();
    onchange(next);
  };
  return field(
    label,
    el(
      "div",
      { class: `color-field ${current || !empty ? "" : "empty"}` },
      el("input", {
        type: "color",
        value: normalized,
        "aria-label": label,
        oninput: apply,
        onchange: apply,
      }),
      el("span", {}, current || !empty ? normalized.toUpperCase() : empty),
    ),
  );
}
function renderInspector() {
  syncToolbar();
  chartTools.sync();
  smartArtTools.sync();
  assistant?.refresh();
  const panel = document.querySelector("#inspector");
  if (!panel) return;
  const obj = currentShape();
  const context = {
    pres: doc.pres,
    part: P.getSlidePartName(slide()),
    shape: obj ? P.getShapeId(obj) : null,
  };
  const previous = inspectorContexts.get(panel);
  const active = panel.contains(document.activeElement)
    ? document.activeElement
    : null;
  const preserve =
    active &&
    previous?.pres === context.pres &&
    previous.part === context.part &&
    previous.shape === context.shape;
  const value = active?.value;
  const start = active?.selectionStart;
  const end = active?.selectionEnd;
  const direction = active?.selectionDirection;
  const scrollTop = active?.scrollTop;
  inspectorContexts.set(panel, context);
  // Keep native selection, picker state, and the Content textarea's edit
  // history (including live-field ranges) while pending writes finish.
  const keepControl =
    preserve &&
    active.matches(
      'input[type="number"], input[type="color"], textarea.content-field',
    );
  const output = keepControl ? el("div") : panel;
  renderInspectorContents(output, obj);
  // A control the person was using stays focused through the refresh. When
  // the panel now shows another object (a duplicate) the same control of that
  // object takes the focus, and when there is no such control, or it can no
  // longer be used (the object was deleted, a link removed, the last row but
  // one deleted), the panel itself does, so keyboard focus never drops to
  // the page.
  if (active) {
    const replacement = [...output.querySelectorAll("[aria-label]")].find(
      (node) =>
        node.tagName === active.tagName &&
        node.getAttribute("aria-label") === active.getAttribute("aria-label"),
    );
    if (!replacement || replacement.disabled)
      panel.focus({ preventScroll: true });
    else if (!preserve) replacement.focus({ preventScroll: true });
    else {
      if (keepControl) {
        if (active.type === "number") {
          // A value the person committed takes the model's, which may have
          // clamped it; one still being typed stays as typed.
          if (active.dataset.committed === active.value) {
            active.value = replacement.value;
            delete active.dataset.committed;
          }
          active.defaultValue = replacement.defaultValue;
          active.min = replacement.min;
          active.max = replacement.max;
        }
        refreshAroundControl(panel, active, replacement);
        return;
      }
      if (value !== undefined && active.matches("input,textarea,select"))
        replacement.value = value;
      replacement.focus({ preventScroll: true });
      if (typeof start === "number")
        replacement.setSelectionRange(start, end, direction);
      replacement.scrollTop = scrollTop;
    }
  }
  if (keepControl) panel.replaceChildren(...output.childNodes);
}
function refreshAroundControl(panel, active, replacement) {
  // Keep the focused control and its ancestors attached so native text
  // selection and open pickers survive the refresh.
  let current = active,
    next = replacement;
  while (current !== panel) {
    const parent = current.parentNode,
      nextParent = next.parentNode;
    const siblings = [...nextParent.childNodes];
    const position = siblings.indexOf(next);
    for (const sibling of [...parent.childNodes])
      if (sibling !== current) sibling.remove();
    current.before(...siblings.slice(0, position));
    current.after(...siblings.slice(position + 1));
    current = parent;
    next = nextParent;
  }
}
const ALIGNMENTS = {
  l: "left",
  left: "left",
  ctr: "center",
  center: "center",
  r: "right",
  right: "right",
  just: "justify",
  justify: "justify",
  justLow: "justify",
  dist: "justify",
  distribute: "justify",
  thaiDist: "justify",
};
function paragraphAlignment(obj, paragraph = 0) {
  const editor = editorFor(obj);
  if (editor) return editor.paragraphState().align;
  if (isTable(obj)) {
    try {
      return ALIGNMENTS[P.getTableCellAlignment(cellOf(obj))] || "left";
    } catch {
      return "left";
    }
  }
  if (!hasTextBody(obj)) return "center";
  try {
    const props = P.getParagraphPropertiesEffective(doc.pres, obj, paragraph);
    if (props?.align) return ALIGNMENTS[props.align] || null;
    return props?.rtl ? "right" : "left";
  } catch {
    return null;
  }
}
// Reapplying the current state must not add an undo step or discard redo.
function textAligned(obj, alignment) {
  if (isTable(obj)) return paragraphAlignment(obj) === alignment;
  const count = P.getShapeParagraphCount(obj);
  for (let i = 0; i < count; i++)
    if (paragraphAlignment(obj, i) !== alignment) return false;
  return count > 0;
}
// Long object labels end at a word with an ellipsis rather than mid-word,
// and a cut that lands between the halves of one character, as an emoji is
// written, takes the whole character off rather than leaving half of it.
function truncateLabel(label, max = 80) {
  const text = label.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${cut
    .slice(0, space > max / 2 ? space : max)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd()}…`;
}
// The format panel's title: what is being formatted.
function inspectorTitle(obj) {
  if (!obj) return "Format Background";
  if (multiSelected()) return "Format";
  return (
    chartTools.formatTitle(obj) ||
    smartArtTools.formatTitle(obj) ||
    (P.getShapeKind(obj) === "picture"
      ? "Format Picture"
      : isTable(obj)
        ? "Format Table"
        : P.getShapeKind(obj) === "connector"
          ? "Format Line"
          : "Format Shape")
  );
}
// Closing the panel while text is being edited goes back to the text, where
// the selection it had is restored; otherwise the slide takes the focus.
function closeFormatPane() {
  if (richEditor?.input?.isConnected)
    richEditor.input.focus({ preventScroll: true });
  else workspace()?.focus({ preventScroll: true });
  show("formatPane", false);
}
function renderInspectorContents(panel, obj) {
  const heading = el(
    "div",
    { class: "panel-heading" },
    el("h2", {}, inspectorTitle(obj)),
    iconButton("Close format panel", "X", closeFormatPane, {
      class: "btn icon-btn inspector-close",
    }),
  );
  sheetHandle(heading);
  panel.replaceChildren(heading, formatFrame(inspectorModel(obj)));
}
// The tabs and sections of the format panel for what is selected: the
// slide's background when nothing is, several objects, or one object.
function inspectorModel(obj) {
  if (!obj) return backgroundModel();
  if (multiSelected()) return multiModel();
  const kind = P.getShapeKind(obj);
  const table = isTable(obj);
  const chart = chartTools.inspector(obj);
  const diagram = !chart && smartArtTools.inspector(obj);
  const textCapable = canEditText(obj);
  const parts = table ? {} : formatTools.paneParts(obj, paneExtras(obj, kind));
  const sizeSub = {
    id: "size",
    label: "Size & Properties",
    icon: "o:paneSize",
    build: () => [
      table
        ? section("Size", sizeFields(obj), { key: "size", open: true })
        : parts.size(),
      table
        ? section("Position", positionFields(obj), {
            key: "position",
            open: true,
          })
        : parts.position(),
      parts.textBox?.(),
      parts.altText?.(),
      canLink(obj) && sectionsFromHeadings(linkFields(obj), "link"),
      section("Arrange", arrangeFields(obj, kind), {
        key: "arrange",
        open: true,
      }),
    ],
  };
  const textTops =
    textCapable && !table
      ? [
          {
            id: "text",
            label: "Text Options",
            subs: [
              {
                id: "text",
                label: "Text",
                icon: "o:paneText",
                build: () => textSections(obj),
              },
              parts.textFill && {
                id: "textFill",
                label: "Text Fill & Outline",
                icon: "o:paneTextFill",
                build: parts.textFill,
              },
              parts.textEffects && {
                id: "textEffects",
                label: "Text Effects",
                icon: "o:paneTextEffects",
                build: parts.textEffects,
              },
              parts.textBox && {
                id: "textBox",
                label: "Text Box",
                icon: "o:paneTextBox",
                build: () => [parts.textBox()],
              },
            ].filter(Boolean),
          },
        ]
      : [];
  if (table) {
    preferTab("table", "table", "table");
    return {
      family: "table",
      tops: [
        {
          id: "table",
          label: "Table Options",
          subs: [
            {
              id: "table",
              label: "Table",
              icon: "o:paneTable",
              build: () => sectionsFromHeadings(tableFields(obj), "table"),
            },
            sizeSub,
          ],
        },
        {
          id: "text",
          label: "Text Options",
          subs: [
            {
              id: "text",
              label: "Text",
              icon: "o:paneText",
              build: () => textSections(obj),
            },
          ],
        },
      ],
    };
  }
  if (chart || diagram) {
    const family = chart ? "chart" : "smartart";
    preferTab(family, family, family);
    // The chart's element picker leads the panel, as the part it formats.
    let lead = [];
    let nodes = chart || diagram;
    if (chart && nodes[0]?.tagName === "H3" && nodes[1]) {
      lead = [el("div", { class: "fmt-frame-lead" }, nodes[1])];
      nodes = nodes.slice(2);
    }
    return {
      family,
      lead,
      tops: [
        {
          id: family,
          label: chart ? "Chart Options" : "SmartArt Options",
          subs: [
            {
              id: family,
              label: chart ? "Chart" : "SmartArt",
              icon: chart ? "o:paneChart" : "o:paneDiagram",
              build: () => sectionsFromHeadings(nodes, family),
            },
            sizeSub,
          ],
        },
        ...textTops,
      ],
    };
  }
  const family =
    kind === "picture"
      ? "picture"
      : kind === "connector"
        ? "line"
        : kind === "group"
          ? "group"
          : "shape";
  preferTab(family, "shape", family === "picture" ? "picture" : "fill");
  return {
    family,
    tops: [
      {
        id: "shape",
        label: "Shape Options",
        subs: [
          (parts.fill || parts.line) && {
            id: "fill",
            label: "Fill & Line",
            icon: "o:paneFillLine",
            build: () => [parts.fill?.(), parts.line?.()],
          },
          parts.effects && {
            id: "effects",
            label: "Effects",
            icon: "o:paneEffects",
            build: parts.effects,
          },
          sizeSub,
          parts.picture && {
            id: "picture",
            label: "Picture",
            icon: "o:panePicture",
            build: parts.picture,
          },
        ].filter(Boolean),
      },
      ...textTops,
    ],
  };
}
// The editor's own controls that join the Format pane's sections.
function paneExtras(obj, kind) {
  const extras = {
    sizeFields: () => sizeFields(obj),
    positionFields: () => positionFields(obj),
  };
  if (kind === "shape") {
    extras.fillColor = () =>
      // Imported shapes often reference theme colors; show the color they
      // resolve to rather than "No fill".
      colorInput(
        "Fill color",
        P.getShapeFillColorResolvedEffective(doc.pres, obj),
        (c) =>
          mutateShape(
            obj,
            (obj) => {
              if (P.getShapeBackgroundFill(obj))
                P.setShapeBackgroundFill(obj, false);
              P.setShapeFill(obj, c);
            },
            { coalesce: coalesceKey("fill", P.getShapeSlide(obj), obj) },
          ),
        { empty: "No fill", fallback: THEMES[theme].accent },
      );
    extras.removeFill = () =>
      iconButton(
        "Remove fill",
        "Ban",
        () =>
          mutateShape(obj, (obj) =>
            P.getShapeFill(obj).kind === "none"
              ? SKIP_MUTATION
              : P.setShapeNoFill(obj),
          ),
        { class: "btn secondary icon-btn", title: "Remove fill" },
      );
    extras.shadowToggle = () =>
      el(
        "label",
        { class: "check-field" },
        el("input", {
          type: "checkbox",
          checked: hasShadow(obj),
          onchange: (e) => toggleShadow(e.target.checked),
        }),
        el("span", {}, "Drop shadow"),
      );
  }
  if (kind === "shape" || kind === "picture" || kind === "connector") {
    const stroke = strokeFields(obj, kind);
    extras.lineColor = stroke.color;
    if (stroke.remove) extras.removeLine = stroke.remove;
  }
  if (kind === "picture") {
    const picture = pictureFields(obj);
    Object.assign(extras, picture);
  }
  return extras;
}
// Text Options > Text: what the object says, its font, and its paragraphs.
// A table cell's text is formatted here too.
function textSections(obj) {
  const fmt = textFormat(obj);
  const alignment = paragraphAlignment(obj);
  const anchor = textAnchor(obj);
  const list = listStyle(obj);
  const cell = isTable(obj);
  const out = [];
  if (cell) {
    const { row, col } = currentCell(obj);
    out.push(
      section(
        "Cell text",
        [
          el(
            "p",
            { class: "helper" },
            `Row ${row + 1}, column ${col + 1}. Double-click another cell to format it.`,
          ),
        ],
        { key: "cellText", open: true },
      ),
    );
  } else
    out.push(
      section(
        "Text",
        [
          field(
            "Content",
            contentTextField(obj, {
              class: "input content-field",
              "aria-label": "Object text",
              value: displayShapeText(doc.pres, obj) || "",
              onchange: (e) => {
                const value = e.target.value;
                const fields = e.target.fieldEdits?.fields || [];
                mutateShape(obj, (obj) => setText(obj, value, fields));
              },
            }),
          ),
        ],
        { key: "text", open: true },
      ),
    );
  const font = el(
    "select",
    {
      class: "input",
      "aria-label": "Font family",
      onchange: (e) => {
        const font = e.target.value;
        applyTextFormat(obj, { font });
      },
    },
    ...FONTS.map((f) => el("option", { value: f }, f)),
  );
  if (
    fmt.font &&
    ![...font.options].some((option) => option.value === fmt.font)
  )
    font.prepend(el("option", { value: fmt.font }, fmt.font));
  font.value = fmt.font || "Arial";
  out.push(
    section(
      "Font",
      [
        field("Font family", font),
        // Arrow keys step whole points; typed half sizes such as 10.5 still
        // apply.
        numInput(
          "Font size",
          fmt.size || 24,
          (n) => applyTextFormat(obj, { size: n }),
          6,
          144,
          1,
        ),
        el(
          "div",
          { class: "format-buttons" },
          iconButton("Bold", "Bold", () => toggleTextFormat(obj, "bold"), {
            "aria-pressed": fmt.bold ? "true" : "false",
          }),
          iconButton(
            "Italic",
            "Italic",
            () => toggleTextFormat(obj, "italic"),
            { "aria-pressed": fmt.italic ? "true" : "false" },
          ),
          iconButton(
            "Underline",
            "Underline",
            () => toggleTextFormat(obj, "underline"),
            { "aria-pressed": decorated(fmt.underline) ? "true" : "false" },
          ),
          iconButton(
            "Strikethrough",
            "Strikethrough",
            () => toggleTextFormat(obj, "strike"),
            { "aria-pressed": decorated(fmt.strike) ? "true" : "false" },
          ),
        ),
        colorInput("Text color", fmt.color, (c) =>
          applyTextFormat(
            obj,
            { color: c },
            { coalesce: coalesceKey("text-color", P.getShapeSlide(obj), obj) },
          ),
        ),
      ],
      { key: "font", open: true },
    ),
  );
  const paragraph = [
    el(
      "div",
      { class: "format-buttons" },
      ...TEXT_ALIGNMENTS.map(([a, label, ic]) =>
        iconButton(label, ic, () => setAlignment(obj, a), {
          "aria-pressed": alignment === a ? "true" : "false",
        }),
      ),
      ...(cell
        ? []
        : [
            el("span", { class: "separator" }),
            iconButton(
              "Bulleted list",
              "List",
              () => toggleList(obj, "bullet"),
              {
                "aria-pressed": list === "bullet" ? "true" : "false",
              },
            ),
            iconButton(
              "Numbered list",
              "ListOrdered",
              () => toggleList(obj, "number"),
              { "aria-pressed": list === "number" ? "true" : "false" },
            ),
          ]),
    ),
    el(
      "div",
      { class: "format-buttons" },
      ...TEXT_ANCHORS.map(([a, label, ic]) =>
        iconButton(label, ic, () => setAnchor(obj, a), {
          "aria-pressed": anchor === a ? "true" : "false",
        }),
      ),
    ),
  ];
  if (!cell) {
    const spacing = lineSpacing(obj);
    const spacingSelect = el(
      "select",
      {
        class: "input",
        "aria-label": "Line spacing",
        onchange: (e) => setLineSpacing(obj, Number(e.target.value)),
      },
      ...LINE_SPACINGS.map(([value, label]) => el("option", { value }, label)),
    );
    if (!LINE_SPACINGS.some(([value]) => value === spacing))
      spacingSelect.prepend(
        el("option", { value: spacing }, spacingLabel(spacing)),
      );
    spacingSelect.value = String(spacing);
    paragraph.push(
      field("Line spacing", spacingSelect),
      el(
        "div",
        { class: "field-grid" },
        paragraphSpacingInput(obj, "before"),
        paragraphSpacingInput(obj, "after"),
      ),
    );
  }
  out.push(section("Paragraph", paragraph, { key: "paragraph", open: true }));
  return out;
}
// The object's size and turn in the editor's fields, in inches and degrees,
// and a rounded rectangle's corners.
function sizeFields(obj) {
  const b = slideBounds(doc.pres, obj);
  if (!b) return [];
  const size = currentSize();
  return [
    el(
      "div",
      { class: "field-grid" },
      ...["w", "h"].map((key, i) =>
        boundsInput(obj, key, ["Width (in)", "Height (in)"][i], b, size),
      ),
      numInput(
        "Rotation (°)",
        Math.round((P.getShapeRotation(obj) || 0) * 10) / 10,
        (n) =>
          mutateShape(obj, (obj) => {
            // -90 and 270 are the same angle; neither is a change from it.
            const angle = ((n % 360) + 360) % 360;
            return (P.getShapeRotation(obj) || 0) === angle
              ? SKIP_MUTATION
              : P.setShapeRotation(obj, angle);
          }),
        -360,
        360,
        1,
      ),
    ),
    ...(P.getShapeKind(obj) === "shape" ? cornerField(obj) : []),
  ];
}
// Where the object's top left corner sits on the slide, in inches.
function positionFields(obj) {
  const b = slideBounds(doc.pres, obj);
  if (!b) return [];
  const size = currentSize();
  return [
    el(
      "div",
      { class: "field-grid" },
      ...["x", "y"].map((key, i) =>
        boundsInput(obj, key, ["X (in)", "Y (in)"][i], b, size),
      ),
    ),
  ];
}
function boundsInput(obj, key, label, b, size) {
  return numInput(
    label,
    Math.round((b[key] / 914400) * 100) / 100,
    (n) =>
      mutateShape(obj, (obj) => {
        const bounds = {
          ...slideBounds(doc.pres, obj),
          [key]: P.inches(n),
        };
        setSlideBounds(doc.pres, obj, bounds);
        fitTableGrid(obj, bounds);
      }),
    key === "w" || key === "h" ? 0.15 : 0,
    (key === "x" || key === "w" ? size.cx : size.cy) / 914400,
    0.01,
  );
}
// Alignment, stacking order, copies, flips and ungrouping for one object.
// Rows an object lacks are left out; append() would write them as text.
function arrangeFields(obj, kind) {
  return [
    alignRow(),
    el(
      "div",
      { class: "arrange-buttons" },
      button(
        "To front",
        "BringToFront",
        () => arrangeObject(obj, P.bringShapeToFront),
        "secondary",
      ),
      button(
        "Forward",
        "ArrowUp",
        () => arrangeObject(obj, P.bringShapeForward),
        "secondary",
      ),
    ),
    el(
      "div",
      { class: "arrange-buttons" },
      button(
        "Backward",
        "ArrowDown",
        () => arrangeObject(obj, P.sendShapeBackward),
        "secondary",
      ),
      button(
        "To back",
        "SendToBack",
        () => arrangeObject(obj, P.sendShapeToBack),
        "secondary",
      ),
    ),
    el(
      "div",
      { class: "arrange-buttons" },
      button("Duplicate", "Copy", duplicateObject, "secondary"),
      button("Delete", "Trash2", deleteObject, "secondary"),
    ),
    (kind === "shape" || kind === "picture") &&
      el(
        "div",
        { class: "arrange-buttons" },
        button(
          "Flip horizontal",
          "FlipHorizontal2",
          () => flipObject(obj, "horizontal"),
          "secondary",
        ),
        button(
          "Flip vertical",
          "FlipVertical2",
          () => flipObject(obj, "vertical"),
          "secondary",
        ),
      ),
    kind === "group" &&
      el(
        "div",
        { class: "arrange-buttons" },
        button("Ungroup", "Ungroup", ungroupSelection, "secondary"),
      ),
  ].filter(Boolean);
}
// A picture's own settings: replacing it, its transparency and brightness,
// its crop by side, and its description for screen readers.
function pictureFields(obj) {
  let opacity = 1;
  let crop = {};
  let brightness = 0;
  try {
    opacity = P.getShapeImageOpacity(obj) ?? 1;
    crop = P.getShapeImageCrop(obj) || {};
    brightness = P.getShapeImageBrightness(obj) ?? 0;
  } catch {}
  const signed = (n) => `${n > 0 ? "+" : ""}${n}%`;
  return {
    imageFields: () => [
      el(
        "div",
        { class: "arrange-buttons" },
        button(
          "Replace image",
          "Replace",
          () => pickImage((file) => replaceImage(obj, file)),
          "secondary",
        ),
      ),
      field(
        "Transparency (%)",
        el(
          "div",
          { class: "range-field" },
          el("input", {
            type: "range",
            min: 0,
            max: 100,
            step: 5,
            value: Math.round((1 - opacity) * 100),
            "aria-label": "Transparency (%)",
            oninput: (e) => {
              e.target.nextElementSibling.textContent = `${e.target.value}%`;
            },
            onchange: (e) => {
              const value = Number(e.target.value);
              mutateShape(
                obj,
                (obj) =>
                  P.setShapeImageOpacity(
                    obj,
                    value === 0 ? null : Math.round(100 - value) / 100,
                  ),
                { coalesce: coalesceKey("opacity", P.getShapeSlide(obj), obj) },
              );
            },
          }),
          el("span", {}, `${Math.round((1 - opacity) * 100)}%`),
        ),
      ),
    ],
    brightness: () =>
      field(
        "Brightness (%)",
        el(
          "div",
          { class: "range-field" },
          el("input", {
            type: "range",
            min: -100,
            max: 100,
            step: 5,
            value: Math.round(brightness * 100),
            "aria-label": "Brightness (%)",
            oninput: (e) => {
              e.target.nextElementSibling.textContent = signed(
                Number(e.target.value),
              );
            },
            onchange: (e) => {
              const value = Number(e.target.value);
              mutateShape(
                obj,
                (obj) =>
                  P.setShapeImageBrightness(
                    obj,
                    value === 0 ? null : Math.round(value) / 100,
                  ),
                {
                  coalesce: coalesceKey(
                    "brightness",
                    P.getShapeSlide(obj),
                    obj,
                  ),
                },
              );
            },
          }),
          el("span", {}, signed(Math.round(brightness * 100))),
        ),
      ),
    cropFields: () =>
      el(
        "div",
        { class: "field-grid" },
        ...["left", "top", "right", "bottom"].map((side) =>
          numInput(
            `Crop ${side} (%)`,
            Math.round((crop[side] || 0) * 100),
            (n) =>
              mutateShape(obj, (obj) => {
                const current = P.getShapeImageCrop(obj) || {};
                // The two sides of an axis leave at least 1% of the picture.
                const opposite = {
                  left: "right",
                  right: "left",
                  top: "bottom",
                  bottom: "top",
                }[side];
                const value = Math.max(
                  0,
                  Math.min(n / 100, 0.99 - (current[opposite] || 0)),
                );
                const next = { ...current, [side]: value };
                P.setShapeImageCrop(
                  obj,
                  Object.values(next).some(Boolean) ? next : null,
                );
              }),
            0,
            90,
            1,
          ),
        ),
      ),
    altText: () => [
      field(
        "Alternative text",
        el("textarea", {
          class: "input",
          value: P.getShapeDescription(obj) || "",
          "aria-label": "Image alternative text",
          onchange: (e) => {
            const value = e.target.value;
            mutateShape(obj, (obj) => P.setShapeDescription(obj, value));
          },
        }),
      ),
      el(
        "p",
        { class: "helper" },
        "Describe what the image communicates for people using screen readers.",
      ),
    ],
  };
}
// Nothing selected: the slide's background, then the slide's transition and
// the objects on it.
function backgroundModel() {
  return {
    family: "background",
    tops: [
      {
        id: "background",
        label: "Background",
        subs: [
          {
            id: "fill",
            label: "Fill",
            icon: "o:paneBackground",
            build: () => {
              const pane = backgroundPane.render();
              pane.querySelector(":scope > h3")?.remove();
              return [
                section("Fill", [pane], { key: "background", open: true }),
                section("Transition", transitionFields(), {
                  key: "transition",
                  open: true,
                }),
                section("Slide objects", slideObjectFields(), {
                  key: "objects",
                  open: true,
                }),
              ];
            },
          },
        ],
      },
    ],
  };
}
function transitionFields() {
  const current = slideTransition(slide());
  const select = el(
    "select",
    {
      class: "input",
      "aria-label": "Transition",
      onchange: (e) => setTransition(slide(), e.target.value),
    },
    ...transitionTools.groups.map((group) =>
      el(
        "optgroup",
        { label: group.label },
        ...transitionTools.entries
          .filter((entry) => entry.group === group.id)
          .map((entry) => el("option", { value: entry.id }, entry.label)),
      ),
    ),
  );
  if (current === "other")
    select.prepend(el("option", { value: "other" }, "Imported"));
  select.value = current;
  return [
    field("Transition", select),
    button(
      "Apply to all slides",
      null,
      () => setTransition(slide(), slideTransition(slide()), { all: true }),
      "text-button",
      // An imported transition is none of the three on offer and has no
      // name to give the other slides, as the Slide menu also has it.
      current === "other"
        ? {
            disabled: true,
            title:
              "This slide's transition came with the file. Choose one of the transitions above to apply it to every slide.",
          }
        : {},
    ),
  ];
}
function slideObjectFields() {
  const shapes = visibleSlideShapes(slide());
  return [
    el(
      "p",
      { class: "helper" },
      "Select an object on the slide to edit its text, style, or position.",
    ),
    el(
      "div",
      { class: "object-list" },
      // Match the canvas: hidden artwork stays out of reach and images are
      // identified by their description.
      ...shapes.map((s) =>
        button(
          truncateLabel(shapeLabel(s, doc.pres)),
          shapeIcon(s),
          () => {
            const current = shapeIndex(s);
            if (current < 0) return;
            selectOnly(current);
            renderSelection();
            renderInspector();
          },
          "object-list-item",
        ),
      ),
    ),
    !shapes.length &&
      el(
        "p",
        { class: "helper" },
        "An open canvas. Add text, a shape, or an image to get started.",
      ),
  ].filter(Boolean);
}
// Several objects: aligning, distributing and arranging them together.
function multiModel() {
  const count = selectionIds().size;
  return {
    family: "multi",
    lead: [
      el(
        "div",
        { class: "fmt-frame-lead" },
        el("h3", {}, `${count} objects selected`),
        el(
          "p",
          { class: "helper" },
          "Drag to move them together. Shift-click adds or removes an object.",
        ),
      ),
    ],
    tops: [
      {
        id: "arrange",
        label: "Arrange",
        subs: [
          {
            id: "arrange",
            label: "Align & Arrange",
            icon: "o:paneArrange",
            build: () => [
              section(
                "Align",
                [
                  alignRow(),
                  el(
                    "div",
                    { class: "format-buttons" },
                    iconButton(
                      "Distribute horizontally",
                      "AlignHorizontalDistributeCenter",
                      () => distributeSelection("x"),
                      { disabled: count < 3 },
                    ),
                    iconButton(
                      "Distribute vertically",
                      "AlignVerticalDistributeCenter",
                      () => distributeSelection("y"),
                      { disabled: count < 3 },
                    ),
                    el(
                      "span",
                      { class: "helper" },
                      count < 3
                        ? "Select three or more to distribute"
                        : "Distribute evenly",
                    ),
                  ),
                ],
                { key: "multiAlign", open: true },
              ),
              section(
                "Arrange",
                [
                  el(
                    "div",
                    { class: "arrange-buttons" },
                    button(
                      "To front",
                      "BringToFront",
                      () => arrangeObject(currentShape(), P.bringShapeToFront),
                      "secondary",
                    ),
                    button(
                      "To back",
                      "SendToBack",
                      () => arrangeObject(currentShape(), P.sendShapeToBack),
                      "secondary",
                    ),
                  ),
                  el(
                    "div",
                    { class: "arrange-buttons" },
                    button("Group", "Group", groupSelection, "secondary"),
                  ),
                  el(
                    "div",
                    { class: "arrange-buttons" },
                    button("Duplicate", "Copy", duplicateObject, "secondary"),
                    button("Delete", "Trash2", deleteObject, "secondary"),
                  ),
                ],
                { key: "multiArrange", open: true },
              ),
            ],
          },
        ],
      },
    ],
  };
}
function flipObject(obj, axis) {
  mutateShape(obj, (obj) => {
    const flip = P.getShapeFlip(obj) || {};
    P.setShapeFlip(obj, {
      horizontal: axis === "horizontal" ? !flip.horizontal : !!flip.horizontal,
      vertical: axis === "vertical" ? !flip.vertical : !!flip.vertical,
    });
  });
}
// The six alignments as icon buttons: to the slide for one object, to each
// other for several.
function alignRow() {
  return el(
    "div",
    { class: "format-buttons" },
    ...ALIGN_ACTIONS.map(([edge, label, icon]) =>
      iconButton(label, icon, () => alignSelection(edge)),
    ),
  );
}
// The outline of a shape or picture, or the line itself for a connector:
// color, width, dash, and for a line its arrowheads.
const DASHES = [
  ["solid", "Solid"],
  ["dash", "Dashed"],
  ["sysDot", "Dotted"],
  ["lgDash", "Long dashes"],
  ["dashDot", "Dash-dot"],
  ["dot", "Dots"],
  ["lgDashDot", "Long dash-dot"],
  ["lgDashDotDot", "Long dash-dot-dot"],
  ["sysDash", "Short dashes"],
  ["sysDashDot", "Short dash-dot"],
  ["sysDashDotDot", "Short dash-dot-dot"],
];
function strokeInfo(obj) {
  try {
    const stroke = P.getShapeStrokeEffective(doc.pres, obj);
    const dash = P.getShapeStrokeFormattingEffective(obj).dash;
    const color =
      stroke.kind === "solid"
        ? P.getShapeStrokeColorResolvedEffective(doc.pres, obj) || stroke.color
        : null;
    return {
      color,
      widthPt:
        Math.round(
          ((stroke.widthEmu ?? P.getShapeStrokeWidth(obj) ?? P.pt(1)) / 12700) *
            4,
        ) / 4,
      dash: dash?.kind === "custom" ? "custom" : dash?.value || "solid",
    };
  } catch {
    return { color: null, widthPt: 1, dash: "solid" };
  }
}
// A rounded rectangle's corners, as a share of its shorter side: the file
// stores the radius in 100,000ths, and 50,000 rounds the corners fully.
function cornerField(obj) {
  let preset = null;
  try {
    preset = P.getShapePreset(obj);
  } catch {}
  if (preset !== "roundRect") return [];
  let radius = 16667;
  try {
    const bounds = P.getShapeBoundsResolved(doc.pres, obj);
    const arc = P.getShapeGeometryResolved(
      doc.pres,
      obj,
    )?.geometry?.paths[0]?.commands.find((c) => c.kind === "arcTo");
    const shortSide = bounds && Math.min(bounds.w, bounds.h);
    radius =
      arc && shortSide > 0
        ? (100000 * arc.wR) / shortSide
        : (P.getShapeAdjustValues(obj)?.adj ?? 16667);
  } catch {}
  const percent = Math.round(radius / 1000);
  return [
    field(
      "Corner radius (%)",
      el(
        "div",
        { class: "range-field" },
        el("input", {
          type: "range",
          min: 0,
          max: 50,
          step: 1,
          value: percent,
          "aria-label": "Corner radius (%)",
          oninput: (e) => {
            e.target.nextElementSibling.textContent = `${e.target.value}%`;
          },
          onchange: (e) => {
            const value = Number(e.target.value);
            mutateShape(
              obj,
              (obj) => P.setShapeAdjustValues(obj, { adj: value * 1000 }),
              { coalesce: coalesceKey("corners", P.getShapeSlide(obj), obj) },
            );
          },
        }),
        el("span", {}, `${percent}%`),
      ),
    ),
  ];
}
/* ---------- Shadow ---------- */
// The one shadow on offer: a soft shadow down and to the right.
const SHADOW = { opacity: 0.4, blurEmu: 50800, offsetEmu: 38100, angleDeg: 45 };
const canShadow = (obj) => !!obj && P.getShapeKind(obj) === "shape";
function hasShadow(obj) {
  try {
    return P.getShapeEffect(obj)?.kind === "shadow";
  } catch {
    return false;
  }
}
// Shadows go on every selected shape at once; when only some have one, the
// rest get one too.
function toggleShadow(on = null) {
  const targets = selectedShapes().filter(canShadow);
  if (!targets.length) return;
  const next = on ?? !targets.every(hasShadow);
  const part = P.getSlidePartName(slide());
  const ids = targets.map(P.getShapeId);
  return mutate(() => {
    const s = slideByPart(part);
    if (!s) return SKIP_MUTATION;
    let changed = false;
    for (const id of ids) {
      const obj = P.findShapeById(s, id);
      if (!obj || !canShadow(obj) || hasShadow(obj) === next) continue;
      if (next) P.setShapeShadow(obj, SHADOW);
      else P.clearShapeEffects(obj);
      changed = true;
    }
    return changed ? undefined : SKIP_MUTATION;
  });
}
// The outline's color for the Format pane's Line section: a field that takes
// a typed or picked color, and for a shape or picture a way to remove it.
function strokeFields(obj, kind) {
  const isLine = kind === "connector";
  const noun = isLine ? "Line" : "Border";
  const ink = THEMES[theme].ink;
  return {
    color: () =>
      colorInput(
        `${noun} color`,
        strokeInfo(obj).color,
        (c) =>
          mutateShape(
            obj,
            (obj) => {
              const current = strokeInfo(obj);
              if (P.getShapeLineGradient(doc.pres, obj))
                P.setShapeLineGradient(obj, null);
              P.setShapeStroke(obj, {
                color: c ?? current.color ?? ink,
                widthEmu: P.pt(current.widthPt),
              });
            },
            { coalesce: coalesceKey("stroke", P.getShapeSlide(obj), obj) },
          ),
        { empty: isLine ? null : "No border", fallback: ink },
      ),
    remove: isLine
      ? null
      : () =>
          iconButton(
            "Remove border",
            "Ban",
            () =>
              mutateShape(obj, (obj) =>
                strokeInfo(obj).color ? P.setShapeNoStroke(obj) : SKIP_MUTATION,
              ),
            { class: "btn secondary icon-btn", title: "Remove border" },
          ),
  };
}
// Reordering several objects keeps their order among themselves: the ones
// heading up go from the bottom, the ones heading down from the top.
function arrangeObject(obj, move) {
  const ids = selectionIds();
  const items = ids.has(P.getShapeId(obj)) ? selectedShapes() : [obj];
  const upward = move === P.bringShapeToFront || move === P.bringShapeForward;
  const ordered = [...items].sort(
    (a, b) => (P.getShapeZIndex(a) - P.getShapeZIndex(b)) * (upward ? 1 : -1),
  );
  const orderedIds = ordered.map(P.getShapeId);
  mutateSlide(P.getShapeSlide(obj), (target) => {
    // Whatever is selected by the time the move runs stays selected; the
    // ids hold while the order changes.
    const keep = [...selectionIds()];
    const primaryId = currentShape() && P.getShapeId(currentShape());
    let changed = false;
    for (const id of orderedIds) {
      const shape = P.findShapeById(target, id);
      if (!shape) continue;
      const before = P.getShapeZIndex(shape);
      move(shape);
      if (P.getShapeZIndex(shape) !== before) changed = true;
    }
    if (!changed) return SKIP_MUTATION;
    if (P.getSlidePartName(slide()) === P.getSlidePartName(target))
      selectIds(
        [...keep.filter((id) => id !== primaryId), primaryId].filter(
          (id) => id != null,
        ),
      );
  });
}
// Copies land a little down and to the right of their originals and take
// over the selection, unless the selection has moved on meanwhile.
function duplicateObject() {
  commitText();
  const items = selectedApart();
  if (!items.length) return;
  const ids = items.map(P.getShapeId);
  const primaryId = P.getShapeId(currentShape());
  mutateSlide(slide(), (target) => {
    const copies = new Map();
    const parents = groupParents(target);
    const sources = ids
      .map((id) => P.findShapeById(target, id))
      .filter(Boolean);
    const pasted = P.copyShapes(target, sources);
    sources.forEach((source, i) => {
      const id = P.getShapeId(source);
      // The copy joins the slide's top level, retaining the way its groups
      // placed, turned and mirrored it on the slide.
      const b = slideBounds(doc.pres, source, parents);
      const copy = pasted[i];
      if (b)
        setSlideBounds(doc.pres, copy, {
          ...b,
          x: b.x + P.inches(0.15),
          y: b.y + P.inches(0.15),
        });
      detachFromGroups(copy, source, parents);
      copies.set(id, P.getShapeId(copy));
    });
    if (!copies.size) return SKIP_MUTATION;
    const stillSelected = [...selectionIds()].some((id) => copies.has(id));
    if (
      P.getSlidePartName(slide()) === P.getSlidePartName(target) &&
      stillSelected
    )
      selectIds(
        [...ids.filter((id) => id !== primaryId), primaryId]
          .map((id) => copies.get(id))
          .filter((id) => id != null),
      );
  });
}
// A copy of a grouped object stands on its own: it takes the turn and the
// mirroring the original's groups gave it, so it shows as the original did.
function detachFromGroups(copy, source, parents) {
  if (!parents.has(P.getShapeId(source))) return;
  const rotation = slideRotation(source, parents);
  if (rotation !== (P.getShapeRotation(copy) || 0))
    P.setShapeRotation(copy, rotation);
  const mirrored = groupFlip(source, parents);
  if (!mirrored.horizontal && !mirrored.vertical) return;
  const own = P.getShapeFlip(copy) || {};
  P.setShapeFlip(copy, {
    horizontal: !!own.horizontal !== mirrored.horizontal,
    vertical: !!own.vertical !== mirrored.vertical,
  });
}
function deleteObject() {
  commitText();
  const items = selectedShapes();
  if (!items.length) return;
  const ids = items.map(P.getShapeId);
  mutateSlide(slide(), (target) => {
    const keep = [...selectionIds()].filter((id) => !ids.includes(id));
    const detach = detachComments(target, ids);
    let removed = false;
    for (const id of ids) {
      const shape = P.findShapeById(target, id);
      if (shape && removeAnyShape(target, shape)) removed = true;
    }
    if (!removed) return SKIP_MUTATION;
    detach();
    pruneUnusedMedia(doc.pres, target);
    if (P.getSlidePartName(slide()) === P.getSlidePartName(target))
      selectIds(keep);
  });
}
// Comments on objects being deleted stay where their markers were, on the
// slide itself: the next object added could be given a deleted one's id.
// Read before the objects go; the returned step writes the comments after.
function detachComments(target, ids) {
  let threads;
  try {
    threads = P.getSlideCommentThreads(target);
  } catch {
    return () => {};
  }
  const gone = new Map();
  const visit = (shape) => {
    gone.set(String(P.getShapeId(shape)), shape);
    if (P.getShapeKind(shape) === "group")
      P.getGroupChildren(shape).forEach(visit);
  };
  for (const id of ids) {
    const shape = P.findShapeById(target, id);
    if (shape) visit(shape);
  }
  if (!threads.some((t) => t.shapeId && gone.has(String(t.shapeId))))
    return () => {};
  const next = threads.map((t) => {
    const shape = t.shapeId && gone.get(String(t.shapeId));
    if (!shape) return t;
    const b = !t.pos && slideBounds(doc.pres, shape);
    return {
      ...t,
      shapeId: null,
      pos:
        t.pos || (b ? { x: Math.round(b.x + b.w), y: Math.round(b.y) } : null),
    };
  });
  return () => {
    P.setSlideCommentThreads(target, next);
    // The slide redraws before this edit is counted; comments read afresh.
    review.comments.invalidate();
  };
}
/* ---------- Find and replace ----------
 * A bar under the toolbar looks through every slide's text, including table
 * cells, and walks the matches by selecting the object each is in. Replacing
 * writes into the run that holds the match, so the rest of the formatting
 * stays; a match that spans runs is found but left for a whole-text replace.
 */
const find = { query: "", caseSensitive: false, matches: [], at: -1 };
function findBar() {
  const query = el("input", {
    class: "input find-input",
    type: "search",
    placeholder: "Find",
    "aria-label": "Find",
    autocomplete: "off",
    spellcheck: "false",
    oninput: () => search(),
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        moveMatch(e.shiftKey ? -1 : 1);
      }
    },
  });
  const replacement = el("input", {
    class: "input find-input",
    type: "text",
    placeholder: "Replace with",
    "aria-label": "Replace with",
    autocomplete: "off",
    spellcheck: "false",
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        replaceMatch(false);
      }
    },
  });
  const count = el("span", {
    class: "find-count",
    role: "status",
    "aria-live": "polite",
  });
  const caseButton = iconButton(
    "Match case",
    "CaseSensitive",
    () => {
      find.caseSensitive = !find.caseSensitive;
      caseButton.setAttribute("aria-pressed", String(find.caseSensitive));
      search();
    },
    { "aria-pressed": "false" },
  );
  return el(
    "div",
    {
      class: "findbar",
      role: "search",
      "aria-label": "Find and replace",
      hidden: true,
      onkeydown: (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closeFind();
        }
      },
    },
    el(
      "div",
      { class: "find-row" },
      query,
      count,
      iconButton("Previous match", "ChevronUp", () => moveMatch(-1)),
      iconButton("Next match", "ChevronDown", () => moveMatch(1)),
      caseButton,
    ),
    el(
      "div",
      { class: "find-row" },
      replacement,
      button(
        "Replace",
        null,
        () => replaceMatch(false),
        "secondary find-action",
      ),
      button(
        "Replace all",
        null,
        () => replaceMatch(true),
        "secondary find-action",
      ),
    ),
    iconButton("Close find and replace", "X", closeFind),
  );
}
function openFind({ replace = false } = {}) {
  const bar = document.querySelector(".findbar");
  if (!bar) return;
  bar.hidden = false;
  const obj = currentShape();
  const input = bar.querySelector('input[aria-label="Find"]');
  if (!input.value && obj && !isTable(obj)) {
    const text = (P.getShapeText(obj) || "").split("\n")[0].trim();
    if (text && text.length <= 60) input.value = text;
  }
  search();
  bar
    .querySelector(
      replace ? 'input[aria-label="Replace with"]' : 'input[aria-label="Find"]',
    )
    .focus();
  if (!replace) input.select();
}
// Find Next / Find Previous: the next match of the last search, or the
// find bar when there is no search yet.
function findAgain(step) {
  const bar = document.querySelector(".findbar");
  if (!bar || bar.hidden || !find.query) return openFind();
  // Text still being typed on the canvas is kept before the match moves on.
  commitText();
  moveMatch(step).catch(fail);
}
// View > Ribbon: shows or hides the ribbon's commands (its tabs stay).
function toggleRibbon() {
  if (!ribbon) return;
  ribbon.setCollapsed(!ribbon.collapsed);
  syncToolbar();
}
function closeFind() {
  const bar = document.querySelector(".findbar");
  if (!bar || bar.hidden) return;
  bar.hidden = true;
  find.query = "";
  find.matches = [];
  find.at = -1;
  renderSelection();
  document.querySelector("#main")?.focus({ preventScroll: true });
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function findRegExp(flags = "") {
  return new RegExp(
    escapeRegExp(find.query),
    `${flags}${find.caseSensitive ? "" : "i"}`,
  );
}
// Every place the text appears, in slide order: text shapes by run and
// table cells by cell.
function collectMatches() {
  const matches = [];
  if (!find.query) return matches;
  const regex = findRegExp("g");
  const countIn = (text) => (text.match(regex) || []).length;
  for (const s of P.getSlides(doc.pres)) {
    const part = P.getSlidePartName(s);
    for (const shape of visibleSlideShapes(s)) {
      const id = P.getShapeId(shape);
      if (isTable(shape)) {
        P.getTableCells(shape).forEach((row, r) =>
          row.forEach((cell, c) => {
            // A cell merged into a neighbor shows no text of its own.
            const span = P.getTableCellSpan(cell);
            if (span?.hMerge || span?.vMerge) return;
            const n = countIn(displayTableCellText(doc.pres, cell));
            for (let k = 0; k < n; k++)
              matches.push({ part, id, cell: { row: r, col: c }, k });
          }),
        );
      } else if (P.isDiagramShape(shape)) {
        // SmartArt text lives in its items, as the Text Pane shows it.
        let n = 0;
        for (const item of smartArtItems(shape)) n += countIn(item.text || "");
        for (let k = 0; k < n; k++) matches.push({ part, id, k });
      } else if (hasTextBody(shape)) {
        // Matches are counted the way Replace reaches them: within one run.
        let n = 0;
        for (let p = 0; p < P.getShapeParagraphCount(shape); p++)
          for (let r = 0; r < P.getShapeRunCount(shape, p); r++)
            n += countIn(P.getShapeRunText(shape, p, r) || "");
        for (let k = 0; k < n; k++) matches.push({ part, id, k });
      }
    }
  }
  return matches;
}
function search({ keep = false } = {}) {
  const bar = document.querySelector(".findbar");
  if (!bar || !doc) return;
  find.query = bar.querySelector('input[aria-label="Find"]').value;
  const before = find.matches[find.at];
  find.matches = collectMatches();
  find.at = find.matches.length ? 0 : -1;
  if (keep && before) {
    const same = find.matches.findIndex(
      (m) => m.part === before.part && m.id === before.id && m.k === before.k,
    );
    if (same >= 0) find.at = same;
  }
  // The first match is shown from the current slide onwards.
  if (!keep && find.matches.length) {
    const here = P.getSlidePartName(slide());
    const order = P.getSlides(doc.pres).map(P.getSlidePartName);
    const from = order.indexOf(here);
    const ahead = find.matches.findIndex((m) => order.indexOf(m.part) >= from);
    if (ahead >= 0) find.at = ahead;
  }
  showMatchCount();
  // The current match takes the selection as the search changes.
  if (find.matches.length) revealMatch(find.matches[find.at]).catch(fail);
  else renderSelection();
}
// Edits and history steps change the text under an open search: the matches
// follow, and the current one stays current where it survives.
function refreshMatches() {
  if (!find.query || document.querySelector(".findbar")?.hidden !== false)
    return;
  const before = find.matches[find.at];
  find.matches = collectMatches();
  const same = before
    ? find.matches.findIndex(
        (m) =>
          m.part === before.part &&
          m.id === before.id &&
          m.k === before.k &&
          m.cell?.row === before.cell?.row &&
          m.cell?.col === before.cell?.col,
      )
    : -1;
  find.at =
    same >= 0
      ? same
      : find.matches.length
        ? Math.max(0, Math.min(find.at, find.matches.length - 1))
        : -1;
  showMatchCount();
}
function showMatchCount() {
  const bar = document.querySelector(".findbar");
  if (!bar) return;
  const count = bar.querySelector(".find-count");
  count.textContent = !find.query
    ? ""
    : find.matches.length
      ? `${find.at + 1} of ${find.matches.length}`
      : "No matches";
  bar.classList.toggle("no-match", !!find.query && !find.matches.length);
  for (const node of bar.querySelectorAll(
    ".find-action, [aria-label$=' match']",
  ))
    node.disabled = !find.matches.length;
}
async function moveMatch(step) {
  if (!find.matches.length) return;
  find.at = (find.at + step + find.matches.length) % find.matches.length;
  showMatchCount();
  await revealMatch(find.matches[find.at]);
}
// The slide and object a match is in come into view and take the selection.
async function revealMatch(match) {
  const target = P.getSlides(doc.pres).find(
    (s) => P.getSlidePartName(s) === match.part,
  );
  if (!target) return;
  if (P.getSlidePartName(slide()) !== match.part) await chooseSlide(target);
  const index = shapes().findIndex((s) => P.getShapeId(s) === match.id);
  if (index < 0) return;
  selectOnly(index);
  if (match.cell) tableCell = { id: match.id, ...match.cell };
  renderSelection();
  renderInspector();
  document
    .querySelector(`.object-hit[data-shape-id="${match.id}"]`)
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
// Replaces the k-th occurrence within one object's text, run by run.
function replaceInShape(shape, regex, replacement, only = null) {
  let seen = 0;
  let changed = false;
  const paragraphs = P.getShapeParagraphCount(shape);
  for (let p = 0; p < paragraphs; p++) {
    const runs = P.getShapeRunCount(shape, p);
    for (let r = 0; r < runs; r++) {
      const text = P.getShapeRunText(shape, p, r);
      if (!regex.test(text)) continue;
      regex.lastIndex = 0;
      const next = text.replace(regex, (hit) => {
        const mine = only == null || seen === only;
        seen++;
        return mine ? replacement : hit;
      });
      if (next !== text) {
        P.setShapeRunText(shape, p, r, next);
        changed = true;
      }
      if (only != null && seen > only) return changed;
    }
  }
  return changed;
}
function smartArtItems(shape) {
  try {
    return P.getShapeSmartArt(shape)?.items || [];
  } catch {
    return [];
  }
}
// Replaces in a SmartArt graphic's items, written back the way the Text
// Pane writes them.
function replaceInSmartArt(shape, regex, replacement, only = null) {
  const model = P.getShapeSmartArt(shape);
  if (!model) return false;
  let seen = 0;
  let changed = false;
  const items = model.items.map((item) => {
    const text = item.text || "";
    const next = text.replace(regex, (hit) => {
      const mine = only == null || seen === only;
      seen++;
      return mine ? replacement : hit;
    });
    if (next === text) return item;
    changed = true;
    return { ...item, text: next };
  });
  if (changed) P.setShapeSmartArt(shape, { ...model, items });
  return changed;
}
function replaceInCell(cell, regex, replacement, only = null) {
  const text = displayTableCellText(doc.pres, cell);
  const edits = new TextFieldEdits(
    text,
    tableTextFields(doc.pres, cell, { normalizeNewlines: false }),
  );
  const matches = [...text.matchAll(regex)].filter(
    (_, i) => only == null || i === only,
  );
  for (const hit of matches.reverse())
    edits.replace(hit.index, hit.index + hit[0].length, replacement);
  if (edits.text === text) return false;
  P.setTableCellText(cell, edits.text, { fields: edits.fields });
  return true;
}

function replaceMatch(all) {
  const bar = document.querySelector(".findbar");
  if (!bar || !find.matches.length) return;
  const replacement = bar.querySelector(
    'input[aria-label="Replace with"]',
  ).value;
  const targets = (all ? find.matches : [find.matches[find.at]]).filter(
    Boolean,
  );
  if (!targets.length) return;
  const regex = findRegExp("g");
  const current = find.matches[find.at];
  mutate(() => {
    let changed = false;
    const done = new Set();
    for (const match of targets) {
      const key = `${match.part}:${match.id}:${match.cell ? `${match.cell.row},${match.cell.col}` : ""}`;
      if (all && done.has(key)) continue;
      done.add(key);
      const target = P.getSlides(doc.pres).find(
        (s) => P.getSlidePartName(s) === match.part,
      );
      const shape = target && P.findShapeById(target, match.id);
      if (!shape) continue;
      if (match.cell)
        changed =
          replaceInCell(
            P.getTableCell(shape, match.cell.row, match.cell.col),
            regex,
            replacement,
            all ? null : match.k,
          ) || changed;
      else if (P.isDiagramShape(shape))
        changed =
          replaceInSmartArt(shape, regex, replacement, all ? null : match.k) ||
          changed;
      else
        changed =
          replaceInShape(shape, regex, replacement, all ? null : match.k) ||
          changed;
    }
    if (!changed) {
      toast(
        "That match runs across differently formatted text. Edit it in place instead.",
      );
      return SKIP_MUTATION;
    }
  }).then(async (applied) => {
    const open = document.querySelector(".findbar");
    if (!open || open.hidden) return;
    search({ keep: true });
    // The text written may itself hold what is looked for; a single replace
    // moves on past it rather than finding its own work again.
    const within = (replacement.match(findRegExp("g")) || []).length;
    const at = find.matches[find.at];
    if (
      applied &&
      !all &&
      within &&
      at &&
      current &&
      at.part === current.part &&
      at.id === current.id &&
      at.k === current.k
    )
      await moveMatch(within);
    // Buttons that ran out of matches let go of the focus; the bar keeps it.
    if (!open.contains(document.activeElement))
      open.querySelector('input[aria-label="Find"]')?.focus();
  });
}
/* ---------- Transitions ----------
 * A slide's transition plays as it arrives while presenting. The gallery,
 * its effect options, timing and sounds live in src/transitions/; it is saved
 * in the file as standard PresentationML with the newer effects in
 * compatibility alternatives, and every slide can take the same one at once.
 */
const PLAYABLE_TRANSITIONS = transitionTools.playable;
function transitionDetails(target, options) {
  return transitionTools.details(target, options);
}
function slideTransition(target) {
  return transitionTools.current(target);
}
function setTransition(target, id, { all = false } = {}) {
  if (all) transitionTools.applyToAll(target);
  else transitionTools.choose(target, id, { preview: false });
}
function transitionItems(target) {
  return transitionTools.menuItems(target);
}
/* ---------- Tables ----------
 * A table is a grid of cells inside a graphic frame. Cells are edited in
 * place, rows and columns come and go around the current cell, and the grid
 * follows the frame when the table is resized.
 */
let tableCell = null; // { id, row, col } of the cell last edited or chosen
const isTable = (obj) => {
  try {
    return P.isTableShape(obj);
  } catch {
    return false;
  }
};
function currentCell(obj) {
  const dims = P.getTableDimensions(obj);
  const cell =
    tableCell && tableCell.id === P.getShapeId(obj)
      ? tableCell
      : { row: 0, col: 0 };
  return {
    row: Math.min(cell.row, dims.rows - 1),
    col: Math.min(cell.col, dims.cols - 1),
  };
}
// A cell merged into a neighbor is the neighbor: its own text is never
// shown, so typing into it would vanish.
function mergedInto(obj, row, col) {
  for (let step = 0; step < 64; step++) {
    let span;
    try {
      span = P.getTableCellSpan(P.getTableCell(obj, row, col));
    } catch {
      break;
    }
    if (span?.hMerge && col > 0) col--;
    else if (span?.vMerge && row > 0) row--;
    else break;
  }
  return { row, col };
}
// Resolved bounds follow the table grid, even when an imported graphic
// frame has a stale extent. Map cells into slide space for grouped tables.
function tableGrid(obj) {
  const b = slideBounds(doc.pres, obj);
  const grid = tableLayout(doc.pres, obj);
  const drawn = (sizes, span) => {
    const total = sizes.reduce((sum, v) => sum + v, 0);
    return total ? sizes.map((v) => (v * span) / total) : sizes;
  };
  const widths = drawn(grid.columnWidths, b.w);
  const heights = drawn(grid.rowHeights, b.h);
  const xs = [b.x];
  for (const w of widths) xs.push(xs.at(-1) + w);
  const ys = [b.y];
  for (const h of heights) ys.push(ys.at(-1) + h);
  return { b, xs, ys, widths, heights };
}
// The rectangle a cell is drawn in: its own column and row, together with
// the ones a merge makes it reach across.
function cellRect(obj, row, col) {
  const { xs, ys, widths, heights } = tableGrid(obj);
  let span = null;
  try {
    span = P.getTableCellSpan(P.getTableCell(obj, row, col));
  } catch {}
  const total = (list) => list.reduce((sum, value) => sum + value, 0);
  const across = Math.max(
    1,
    Math.min(span?.gridSpan || 1, widths.length - col),
  );
  const down = Math.max(1, Math.min(span?.rowSpan || 1, heights.length - row));
  return {
    x: xs[col],
    y: ys[row],
    w: total(widths.slice(col, col + across)),
    h: total(heights.slice(row, row + down)),
  };
}
function cellAt(obj, x, y) {
  const { xs, ys } = tableGrid(obj);
  // A point past the far edge belongs to the last row or column.
  const at = (edges, value) => {
    const next = edges.findIndex((edge, i) => i > 0 && value < edge);
    return next < 0 ? edges.length - 2 : Math.max(0, next - 1);
  };
  return { row: at(ys, y), col: at(xs, x) };
}
// The grid stretches or shrinks with the frame, column by column and row by
// row, so a resized table keeps its proportions.
function fitTableGrid(obj, bounds) {
  if (!isTable(obj)) return;
  // The frame has already been written in the table's local coordinate
  // system. Its displayed rows, including content growth, are what resize.
  bounds = P.getShapeBounds(obj) || bounds;
  const grid = tableLayout(doc.pres, obj);
  const widths = grid.columnWidths;
  const heights = grid.rowHeights;
  const totalW = widths.reduce((a, b) => a + b, 0);
  const totalH = heights.reduce((a, b) => a + b, 0);
  if (totalW && Math.round(totalW) !== Math.round(bounds.w))
    widths.forEach((w, i) =>
      P.setTableColumnWidth(obj, i, Math.round((w * bounds.w) / totalW)),
    );
  if (totalH && Math.round(totalH) !== Math.round(bounds.h))
    heights.forEach((h, i) =>
      P.setTableRowHeight(obj, i, Math.round((h * bounds.h) / totalH)),
    );
}
function cellFormat(cell) {
  try {
    const paragraphs = P.getTableCellParagraphs(cell);
    const run = paragraphs[0]?.elements.find(
      (e) => e.kind === "r" || e.kind === "fld",
    );
    return run?.format || {};
  } catch {
    return {};
  }
}
// The cell Tab moves to, or null past either end of the table. A cell merged
// into a neighbor shows none of its own text, so the step passes over the
// cells a merge covers instead of landing back on the merged cell itself.
function nextCell(obj, from, step) {
  const dims = P.getTableDimensions(obj);
  let { row, col } = from;
  for (let guard = dims.rows * dims.cols; guard > 0; guard--) {
    col += step;
    if (col >= dims.cols) {
      row++;
      col = 0;
    } else if (col < 0) {
      row--;
      col = dims.cols - 1;
    }
    if (row < 0 || row >= dims.rows) return null;
    const origin = mergedInto(obj, row, col);
    if (origin.row === row && origin.col === col) return { row, col };
  }
  return null;
}
// The in-place editor for one cell. Tab moves on to the next cell and
// Shift+Tab back, committing on the way.
function editTableCell(target, row, col) {
  const i = shapeIndex(target);
  if (i < 0) return;
  const obj = shapes()[i];
  if (!isTable(obj)) return;
  const dims = P.getTableDimensions(obj);
  row = Math.max(0, Math.min(dims.rows - 1, row));
  col = Math.max(0, Math.min(dims.cols - 1, col));
  ({ row, col } = mergedInto(obj, row, col));
  selectOnly(i);
  tableCell = { id: P.getShapeId(obj), row, col };
  updateSelectionUi();
  renderInspector();
  const cell = P.getTableCell(obj, row, col);
  const value = displayTableCellText(doc.pres, cell).replace(/\r\n?/g, "\n");
  const rect = cellRect(obj, row, col);
  const canvas = document.querySelector("#slide-canvas"),
    size = currentSize();
  const format = cellFormat(cell);
  const input = el("textarea", {
    class: "inline-editor",
    "aria-label": `Edit cell, row ${row + 1}, column ${col + 1}`,
    value,
  });
  Object.assign(input.style, {
    left: `${(rect.x / size.cx) * 100}%`,
    top: `${(rect.y / size.cy) * 100}%`,
    width: `${(rect.w / size.cx) * 100}%`,
    height: `${(rect.h / size.cy) * 100}%`,
    fontSize: `${Math.max(14, ((format.size || 18) * canvas.clientWidth) / (size.cx / 914400) / 72)}px`,
    fontWeight: format.bold ? "700" : "400",
    fontStyle: format.italic ? "italic" : "normal",
    minHeight: "0",
  });
  const fields = tableTextFields(doc.pres, cell);
  const fieldEdits = fields.length ? trackTextFields(input, fields) : null;
  let move = null;
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["s", "p"].includes(e.key.toLowerCase()))
      return;
    if (e.isComposing || !sharedEditorKey(e)) e.stopPropagation();
    if (e.isComposing) return;
    // The browser's bookmark does not take Duplicate's key.
    if (e.key.toLowerCase() === "d" && (IS_MAC ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      move = nextCell(obj, { row, col }, e.shiftKey ? -1 : 1);
      input.blur();
      return;
    }
    // Escape leaves the cell keeping what was typed, as in a text box; undo
    // takes the typing back.
    if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
      e.preventDefault();
      input.blur();
      [...canvas.querySelectorAll(".object-hit")]
        .find((hit) => hit.dataset.shapeId === String(P.getShapeId(obj)))
        ?.focus({ preventScroll: true });
    }
  });
  input.addEventListener(
    "blur",
    () => {
      const next = input.value;
      input.remove();
      if (next !== value)
        mutateShape(obj, (obj) =>
          P.setTableCellText(P.getTableCell(obj, row, col), next, {
            fields: fieldEdits?.fields || [],
          }),
        );
      // The next cell opens at once, so typing carries straight on while the
      // last cell's text is still being written.
      if (move) editTableCell(obj, move.row, move.col);
    },
    { once: true },
  );
  canvas.append(input);
  input.focus();
  input.select();
}
function tableAction(fn) {
  const obj = currentShape();
  if (!obj || !isTable(obj)) return;
  const { row, col } = currentCell(obj);
  mutateShape(obj, (obj) => {
    const b = slideBounds(doc.pres, obj);
    if (!b) return;
    const before = tableLayout(doc.pres, obj);
    if (fn(obj, row, col) === SKIP_MUTATION) return SKIP_MUTATION;
    // Column insertion/deletion shares the previous width. Remeasure after
    // that change because the narrower cells may wrap onto more lines.
    const widths = P.getTableColumnWidths(obj);
    const width = widths.reduce((sum, w) => sum + w, 0);
    if (width > 0 && width !== before.width)
      widths.forEach((w, i) =>
        P.setTableColumnWidth(obj, i, Math.round((w * before.width) / width)),
      );
    const after = tableLayout(doc.pres, obj);
    const bounds = {
      ...b,
      h: Math.round(after.height * (before.height ? b.h / before.height : 1)),
    };
    setSlideBounds(doc.pres, obj, bounds);
  });
}
function tableFields(obj) {
  const dims = P.getTableDimensions(obj);
  const { row, col } = currentCell(obj);
  const flags = P.getTableStyleFlags(obj);
  const toggle = (label, key) =>
    el(
      "label",
      { class: "check-field" },
      el("input", {
        type: "checkbox",
        checked: !!flags[key],
        onchange: (e) => {
          const on = e.target.checked;
          mutateShape(obj, (obj) => P.setTableStyleFlags(obj, { [key]: on }));
        },
      }),
      el("span", {}, label),
    );
  let cellFill = null;
  try {
    cellFill = P.getTableCellFill(P.getTableCell(obj, row, col));
  } catch {}
  return [
    el("h3", {}, "Table"),
    el(
      "p",
      { class: "helper" },
      `${dims.rows} × ${dims.cols}. Row ${row + 1}, column ${col + 1} is current; rows and columns are added beside it. Double-click a cell to type in it.`,
    ),
    colorInput(
      "Cell fill",
      cellFill,
      (c) =>
        mutateShape(obj, (obj) => P.setTableCellFill(cellOf(obj), c), {
          coalesce: coalesceKey("cell-fill", P.getShapeSlide(obj), obj),
        }),
      { empty: "No fill", fallback: THEMES[theme].accent },
    ),
    button(
      "Remove cell fill",
      null,
      () =>
        mutateShape(obj, (obj) =>
          P.getTableCellFill(cellOf(obj))
            ? P.clearTableCellFill(cellOf(obj))
            : SKIP_MUTATION,
        ),
      "text-button",
    ),
    el(
      "div",
      { class: "arrange-buttons" },
      button(
        "Row above",
        "ArrowUp",
        () =>
          tableAction((obj, row) => {
            P.insertTableRow(obj, row);
            tableCell = { id: P.getShapeId(obj), row: row + 1, col };
          }),
        "secondary",
      ),
      button(
        "Row below",
        "ArrowDown",
        () => tableAction((obj, row) => P.insertTableRow(obj, row + 1)),
        "secondary",
      ),
    ),
    el(
      "div",
      { class: "arrange-buttons" },
      button(
        "Column left",
        "ArrowLeft",
        () =>
          tableAction((obj, row, col) => {
            P.insertTableColumn(obj, col);
            tableCell = { id: P.getShapeId(obj), row, col: col + 1 };
          }),
        "secondary",
      ),
      button(
        "Column right",
        "ArrowRight",
        () => tableAction((obj, row, col) => P.insertTableColumn(obj, col + 1)),
        "secondary",
      ),
    ),
    el(
      "div",
      { class: "arrange-buttons" },
      button(
        "Delete row",
        "Trash2",
        () =>
          tableAction((obj, row) => {
            if (P.getTableDimensions(obj).rows < 2) {
              toast(
                "A table keeps at least one row. Delete the table instead.",
              );
              return SKIP_MUTATION;
            }
            P.removeTableRow(obj, row);
          }),
        "secondary",
        { disabled: dims.rows < 2 },
      ),
      button(
        "Delete column",
        "Trash2",
        () =>
          tableAction((obj, row, col) => {
            if (P.getTableDimensions(obj).cols < 2) {
              toast(
                "A table keeps at least one column. Delete the table instead.",
              );
              return SKIP_MUTATION;
            }
            P.removeTableColumn(obj, col);
          }),
        "secondary",
        { disabled: dims.cols < 2 },
      ),
    ),
    toggle("Header row", "firstRow"),
    toggle("Banded rows", "bandRow"),
  ];
}
async function tableDialog(place = null) {
  const target = doc;
  const rows = el("input", {
    class: "input",
    type: "number",
    min: 1,
    max: 30,
    value: 3,
    "aria-label": "Rows",
    autofocus: true,
  });
  const cols = el("input", {
    class: "input",
    type: "number",
    min: 1,
    max: 12,
    value: 3,
    "aria-label": "Columns",
  });
  const ok = await dialog({
    title: "Insert table",
    body: el(
      "form",
      { class: "dialog-body" },
      el(
        "div",
        { class: "field-grid" },
        el("label", {}, "Rows", rows),
        el("label", {}, "Columns", cols),
      ),
    ),
    confirm: "Insert",
  });
  if (!ok || doc !== target) return;
  // An empty field takes the default; a number past the range its end.
  const count = (input, max) =>
    Number.isFinite(input.valueAsNumber)
      ? Math.max(1, Math.min(max, Math.round(input.valueAsNumber)))
      : 3;
  insertTable(count(rows, 30), count(cols, 12), place);
}
// `place` puts the table in an empty placeholder, which it replaces.
function insertTable(rows, cols, place = null) {
  commitText();
  mutateSlide(place ? slideByPart(place.part) : slide(), (target) => {
    const size = currentSize();
    const width = place ? place.bounds.w : size.cx - P.inches(2);
    const rowHeight = P.inches(0.5);
    const s = P.addSlideTable(target, {
      x: place ? place.bounds.x : P.inches(1),
      y: place ? place.bounds.y : P.inches(1.5),
      w: width,
      h: rowHeight * rows,
      rows: Array.from({ length: rows }, () => Array(cols).fill("")),
      firstRow: true,
      bandRow: true,
    });
    P.renameShape(s, `Table ${P.getShapeId(s)}`);
    const id = P.getShapeId(s);
    fillSlot(target, place, id);
    if (P.getSlidePartName(slide()) === P.getSlidePartName(target)) {
      selectIds([id]);
      tableCell = { id, row: 0, col: 0 };
    }
  });
}
/* ---------- Links ----------
 * A link on an object opens a web address or goes to a slide while
 * presenting. Text takes the address on its runs too, so it reads as a link;
 * pictures and plain shapes carry it as a click action.
 */
// A group and a graphic frame hold no link in this editor: the format panel
// has no room to show one and the right-click menu leaves it out, so the
// Insert menu and the shortcut refuse it too.
const canLink = (obj) =>
  !!obj && !["group", "graphicFrame"].includes(P.getShapeKind(obj));
function linkOf(obj) {
  try {
    const action = P.getShapeClickAction(obj);
    if (action) return action;
    const url = hasTextBody(obj) ? P.getShapeHyperlink(obj) : null;
    return url ? { kind: "url", url } : null;
  } catch {
    return null;
  }
}
function setLink(obj, action) {
  if (hasTextBody(obj) && P.hasShapeText(obj))
    P.setShapeHyperlink(obj, action?.kind === "url" ? action.url : null);
  P.setShapeClickAction(obj, action);
}
const SLIDE_LINKS = [
  ["nextSlide", "Next slide"],
  ["prevSlide", "Previous slide"],
  ["firstSlide", "First slide"],
  ["lastSlide", "Last slide"],
];
function describeLink(action) {
  if (!action) return "No link";
  if (action.kind === "url") return action.url;
  if (action.kind === "slide") {
    const slides = P.getSlides(doc.pres);
    const i = slides.findIndex(
      (s) => P.getSlidePartName(s) === P.getSlidePartName(action.slide),
    );
    return i < 0 ? "A removed slide" : `Slide ${i + 1}`;
  }
  return SLIDE_LINKS.find(([kind]) => kind === action.kind)?.[1] || "Link";
}
// A slide's name for a list: its title, or its first line of text.
const slideLabel = (s) =>
  slideTitle(s, doc?.pres) || slideDescription(s, doc?.pres).split("\n")[0];
// The addresses a link may open: web pages, mail, and phone numbers. An
// imported file can carry any address at all, and one with a "javascript:"
// scheme would run in the page the moment it was followed while presenting.
const OPENABLE_URL = /^\s*(https?:|mailto:|tel:)/i;
const canOpenUrl = (url) => OPENABLE_URL.test(String(url || ""));
// Web addresses without a scheme are taken as https.
function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (canOpenUrl(trimmed)) return trimmed;
  // Another scheme is refused; "localhost:3000" or "example.com:8080/x"
  // carry a port, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(trimmed)) return null;
  return `https://${trimmed}`;
}
async function linkDialog() {
  const obj = currentShape();
  if (!canLink(obj)) return;
  const target = doc;
  const current = linkOf(obj);
  const slides = P.getSlides(doc.pres);
  const kind = el(
    "select",
    { class: "input", "aria-label": "Link to" },
    el("option", { value: "url" }, "Web address"),
    ...SLIDE_LINKS.map(([value, label]) => el("option", { value }, label)),
    ...slides.map((s, i) =>
      el(
        "option",
        { value: `slide:${P.getSlidePartName(s)}` },
        `Slide ${i + 1}${slideLabel(s) ? `: ${truncateLabel(slideLabel(s), 40)}` : ""}`,
      ),
    ),
  );
  // A text field: the browser's own address check would refuse "example.com"
  // on Enter while the dialog's Done accepts it and adds the scheme.
  const url = el("input", {
    class: "input",
    type: "text",
    inputmode: "url",
    autocomplete: "url",
    spellcheck: "false",
    "aria-label": "Web address",
    placeholder: "https://example.com",
    value: current?.kind === "url" ? current.url : "",
    autofocus: true,
  });
  kind.value =
    current?.kind === "slide"
      ? `slide:${P.getSlidePartName(current.slide)}`
      : current?.kind || "url";
  const address = el("label", {}, "Web address", url);
  const syncKind = () => {
    address.hidden = kind.value !== "url";
  };
  kind.addEventListener("change", syncKind);
  syncKind();
  const ok = await dialog({
    title: current ? "Edit link" : "Add link",
    body: el(
      "form",
      { class: "dialog-body" },
      el("label", {}, "Link to", kind),
      address,
      el(
        "p",
        { class: "muted" },
        "Links open while presenting. A web address opens in a new tab.",
      ),
    ),
    confirm: "Done",
  });
  if (!ok || doc !== target) return;
  let action = null;
  if (kind.value === "url") {
    action = normalizeUrl(url.value);
    if (url.value.trim() && !action) {
      toast("Enter a web address such as https://example.com.");
      return;
    }
    action = action && { kind: "url", url: action };
  } else if (kind.value.startsWith("slide:")) {
    const part = kind.value.slice("slide:".length);
    const slide = P.getSlides(doc.pres).find(
      (s) => P.getSlidePartName(s) === part,
    );
    action = slide && { kind: "slide", slide };
  } else action = { kind: kind.value };
  mutateShape(obj, (obj, targetSlide) => {
    if (action?.kind === "slide") {
      const slide = P.getSlides(doc.pres).find(
        (s) => P.getSlidePartName(s) === P.getSlidePartName(action.slide),
      );
      if (!slide) return SKIP_MUTATION;
      action = { kind: "slide", slide };
    }
    setLink(obj, action);
  });
}
function removeLink() {
  const obj = currentShape();
  if (!obj || !linkOf(obj)) return;
  mutateShape(obj, (obj) => setLink(obj, null));
}
function linkFields(obj) {
  const link = linkOf(obj);
  return [
    el("h3", {}, "Link"),
    el(
      "p",
      { class: `helper link-target ${link ? "" : "empty"}` },
      describeLink(link),
    ),
    el(
      "div",
      { class: "arrange-buttons" },
      button(
        link ? "Edit link" : "Add link",
        "Link",
        run(linkDialog),
        "secondary",
      ),
      link && button("Remove link", null, removeLink, "secondary"),
    ),
  ];
}
/* ---------- Align, distribute, group ---------- */
const ALIGN_ACTIONS = [
  ["left", "Left edges", "AlignStartVertical"],
  ["hcenter", "Horizontal centers", "AlignCenterVertical"],
  ["right", "Right edges", "AlignEndVertical"],
  ["top", "Top edges", "AlignStartHorizontal"],
  ["vcenter", "Vertical centers", "AlignCenterHorizontal"],
  ["bottom", "Bottom edges", "AlignEndHorizontal"],
];
// Several objects line up on the edge or center of the space they span; a
// single object lines up on the slide's.
function alignSelection(edge) {
  const items = selectedApart();
  if (!items.length) return;
  const ids = items.map(P.getShapeId);
  mutateSlide(slide(), (target) => {
    const size = currentSize();
    const parents = groupParents(target);
    const list = ids.map((id) => P.findShapeById(target, id)).filter(Boolean);
    const bounds = list.map((s) => slideBounds(doc.pres, s, parents));
    // A turned object lines up where the slide shows it.
    const shown = bounds.map(
      (b, i) => b && turnedBounds(b, slideRotation(list[i], parents)),
    );
    const known = shown.filter(Boolean);
    if (!known.length) return SKIP_MUTATION;
    const ref =
      list.length > 1 && !formatTools.alignToSlide()
        ? unionBounds(known)
        : { x: 0, y: 0, w: size.cx, h: size.cy };
    let changed = false;
    list.forEach((s, i) => {
      const b = bounds[i],
        v = shown[i];
      if (!b) return;
      let x = v.x,
        y = v.y;
      if (edge === "left") x = ref.x;
      if (edge === "hcenter") x = ref.x + ref.w / 2 - v.w / 2;
      if (edge === "right") x = ref.x + ref.w - v.w;
      if (edge === "top") y = ref.y;
      if (edge === "vcenter") y = ref.y + ref.h / 2 - v.h / 2;
      if (edge === "bottom") y = ref.y + ref.h - v.h;
      if (
        Math.round(x) === Math.round(v.x) &&
        Math.round(y) === Math.round(v.y)
      )
        return;
      setSlideBounds(doc.pres, s, { ...b, x: b.x + x - v.x, y: b.y + y - v.y });
      changed = true;
    });
    if (!changed) return SKIP_MUTATION;
  });
}
// Three or more objects spread out with equal gaps between them; the two at
// the ends stay where they are.
function distributeSelection(axis) {
  const items = selectedApart();
  if (items.length < 3) return;
  const ids = items.map(P.getShapeId);
  mutateSlide(slide(), (target) => {
    const parents = groupParents(target);
    // A turned object takes the room the slide shows it in.
    const list = ids
      .map((id) => P.findShapeById(target, id))
      .filter(Boolean)
      .map((s) => ({ s, b: slideBounds(doc.pres, s, parents) }))
      .filter((item) => item.b)
      .map((item) => ({
        ...item,
        v: turnedBounds(item.b, slideRotation(item.s, parents)),
      }));
    if (list.length < 3) return SKIP_MUTATION;
    const pos = axis === "x" ? "x" : "y",
      len = axis === "x" ? "w" : "h";
    list.sort((a, b) => a.v[pos] - b.v[pos]);
    const first = list[0].v,
      last = list.at(-1).v;
    const span = last[pos] + last[len] - first[pos];
    const gap =
      (span - list.reduce((n, item) => n + item.v[len], 0)) / (list.length - 1);
    let cursor = first[pos];
    let changed = false;
    for (const item of list) {
      if (Math.round(cursor) !== Math.round(item.v[pos])) {
        setSlideBounds(doc.pres, item.s, {
          ...item.b,
          [pos]: item.b[pos] + cursor - item.v[pos],
        });
        changed = true;
      }
      cursor += item.v[len] + gap;
    }
    if (!changed) return SKIP_MUTATION;
  });
}
function groupSelection() {
  const items = selectedShapes();
  if (items.length < 2) return;
  const ids = items.map(P.getShapeId);
  mutateSlide(slide(), (target) => {
    const parents = groupParents(target);
    const list = ids.map((id) => P.findShapeById(target, id)).filter(Boolean);
    if (list.length < 2) return SKIP_MUTATION;
    if (list.some((s) => parents.has(P.getShapeId(s)))) {
      toast("Ungroup the grouped objects first, then group them together.");
      return SKIP_MUTATION;
    }
    // A placeholder that takes its position from the layout has none of its
    // own to be grouped by; it is given the one it shows.
    for (const s of list)
      if (!P.getShapeBounds(s)) {
        const b = slideBounds(doc.pres, s);
        if (b) P.setShapeBounds(s, b);
      }
    const group = P.groupShapes(list);
    P.renameShape(group, `Group ${P.getShapeId(group)}`);
    if (P.getSlidePartName(slide()) === P.getSlidePartName(target))
      selectIds([P.getShapeId(group)]);
  });
}
function ungroupSelection() {
  const obj = currentShape();
  if (!obj || P.getShapeKind(obj) !== "group") return;
  mutateShape(obj, (target, targetSlide) => {
    // The children come back as the group held them, unturned and
    // unmirrored; each takes the place, the turn, and the mirroring the
    // slide showed it with, so nothing moves when the group goes.
    const parents = groupParents(targetSlide);
    const flip = P.getShapeFlip(target) || {};
    const shown = new Map(
      P.getGroupChildren(target).map((child) => [
        P.getShapeId(child),
        {
          bounds: slideBounds(doc.pres, child, parents),
          rotation: slideRotation(child, parents),
          flip: P.getShapeFlip(child) || {},
        },
      ]),
    );
    const children = P.ungroupShapes(target);
    for (const child of children) {
      const was = shown.get(P.getShapeId(child));
      if (!was) continue;
      if (was.bounds) setSlideBounds(doc.pres, child, was.bounds);
      const own = ownRotation(child, was.rotation);
      if (own !== (P.getShapeRotation(child) || 0))
        P.setShapeRotation(child, own);
      // A group mirrored along one axis mirrors each child along it; a child
      // mirrored the same way already comes out straight.
      if (flip.horizontal || flip.vertical)
        P.setShapeFlip(child, {
          horizontal: !!was.flip.horizontal !== !!flip.horizontal,
          vertical: !!was.flip.vertical !== !!flip.vertical,
        });
    }
    formatTools.rememberUngroup(
      P.getSlidePartName(targetSlide),
      children.map(P.getShapeId),
    );
    if (P.getSlidePartName(slide()) === P.getSlidePartName(targetSlide))
      selectIds(children.map(P.getShapeId));
  });
}
function arrangeItems() {
  const count = selectionIds().size;
  const obj = currentShape();
  const canGroup = count > 1;
  const canUngroup = !!obj && count === 1 && P.getShapeKind(obj) === "group";
  return [
    {
      label: count > 1 ? "Align" : "Align to slide",
      icon: "AlignStartVertical",
      disabled: !obj,
      items: ALIGN_ACTIONS.map(([edge, label, icon]) => ({
        label,
        icon,
        onSelect: () => alignSelection(edge),
      })),
    },
    {
      label: "Distribute",
      icon: "AlignHorizontalDistributeCenter",
      disabled: count < 3,
      items: [
        {
          label: "Horizontally",
          icon: "AlignHorizontalDistributeCenter",
          onSelect: () => distributeSelection("x"),
        },
        {
          label: "Vertically",
          icon: "AlignVerticalDistributeCenter",
          onSelect: () => distributeSelection("y"),
        },
      ],
    },
    { separator: true },
    {
      label: "Flip horizontal",
      icon: "FlipHorizontal2",
      disabled: !obj || !["shape", "picture"].includes(P.getShapeKind(obj)),
      onSelect: () => flipObject(obj, "horizontal"),
    },
    {
      label: "Flip vertical",
      icon: "FlipVertical2",
      disabled: !obj || !["shape", "picture"].includes(P.getShapeKind(obj)),
      onSelect: () => flipObject(obj, "vertical"),
    },
    { separator: true },
    {
      label: "Group",
      icon: "Group",
      shortcut: `${M}+Alt+G`,
      disabled: !canGroup,
      onSelect: groupSelection,
    },
    {
      label: "Ungroup",
      icon: "Ungroup",
      shortcut: `${M}+Alt+Shift+G`,
      disabled: !canUngroup,
      onSelect: ungroupSelection,
    },
  ];
}
/* ---------- Clipboard ----------
 * Copied objects live in a small package of their own, so the clipboard
 * survives later edits, undo, and opening another presentation. A paste
 * imports that package's slide into the deck for a moment, copies the objects
 * onto the current slide, and removes it again. The system clipboard gets
 * the objects' text and a token that lets a paste here recognise its own copy.
 */
const CLIPBOARD_TYPE = "text/x-presentation-clipboard";
let clipboard = null;
let clipboardSync = false;
let pendingPaste = 0;
function copySelection() {
  if (readOnlyDocument()) return false;
  const items = selectedApart();
  if (!items.length) return false;
  const source = slide();
  const pkg = P.createPresentation();
  const held = P.importSlide(pkg, source, P.getSlideLayouts(pkg)[0], {
    preserveTextFormatting: true,
    preservePaintFormatting: true,
  });
  for (const s of P.getSlides(pkg)) if (s !== held) P.removeSlide(pkg, s);
  const parents = groupParents(source);
  const ids = [];
  const bounds = [];
  const links = [];
  const supported = items
    .map((item) => ({
      item,
      source: P.findShapeById(held, P.getShapeId(item)),
    }))
    .filter((pair) => pair.source);
  // Individual group members need extraction to the clipboard's top level.
  // Extract that selection together so internal endpoints follow its copies.
  // A selection already at the top level retains the imported objects.
  const extract = supported.some(({ item }) => parents.has(P.getShapeId(item)));
  const copies = extract
    ? P.copyShapes(
        held,
        supported.map((pair) => pair.source),
      )
    : supported.map((pair) => pair.source);
  supported.forEach(({ item }, i) => {
    const copy = copies[i];
    const b = slideBounds(doc.pres, item, parents);
    if (parents.has(P.getShapeId(item))) {
      if (b) P.setShapeBounds(copy, roundBounds(b));
      detachFromGroups(copy, item, parents);
    }
    ids.push(P.getShapeId(copy));
    bounds.push(b);
    const link = linkOf(item);
    links.push(link?.kind === "slide" ? P.getSlidePartName(link.slide) : null);
  });
  // The clipboard keeps a package of its own so it survives later edits and
  // other presentations, and an embedded object cannot travel in
  // one: its parts stay with the slide it sits on. Say so rather than
  // putting nothing on the clipboard, which a cut would delete for nothing.
  if (ids.length < items.length) {
    toast(
      ids.length
        ? "An embedded object stays on its slide; the rest was copied."
        : "An embedded object stays on its slide; it cannot be copied.",
    );
    if (!ids.length) return false;
  }
  const keep = new Set(ids);
  const heldParents = groupParents(held);
  for (const s of P.getSlideShapes(held))
    if (!keep.has(P.getShapeId(s)) && !heldParents.has(P.getShapeId(s)))
      P.removeShape(s);
  // The held slide is alone in its package, so a jump to a slide points at
  // nothing there and would come back pointing at whatever the pasted slide
  // holds under the same relationship id, or at nothing.
  for (const s of P.getSlideShapes(held))
    if (hasSlideJump(s)) P.setShapeClickAction(s, null);
  pruneUnusedMedia(pkg);
  importReferencedEmbeddedFonts(pkg, doc.pres);
  clipboard = {
    pkg,
    slide: held,
    ids,
    bounds,
    links,
    deck: doc.id,
    token: uuid(),
    text: items
      .map((s) =>
        P.getShapeKind(s) === "picture" ? "" : displayShapeText(doc.pres, s),
      )
      .filter(Boolean)
      .join("\n"),
    origin: `${doc.id}:${P.getSlidePartName(source)}`,
    pastes: new Map(),
  };
  return true;
}
function importReferencedEmbeddedFonts(target, source) {
  // importSlide materializes inherited/theme text formatting before selection
  // pruning. Keep each surviving DrawingML family, including EA/CS/symbol and
  // bullet declarations, rather than guessing from Latin text alone.
  const names = new Set(
    [...presentationFontFamilies(target)].map((name) => name.toLowerCase()),
  );
  const used = P.getEmbeddedFonts(source, {
    onError(error, family) {
      if (!family || names.has(family.toLowerCase())) throw error;
    },
  }).filter((font) => names.has(font.typeface.toLowerCase()));
  if (used.length)
    P.importEmbeddedFonts(
      target,
      source,
      used.map((font) => font.typeface),
    );
}
const roundBounds = (b) =>
  Object.fromEntries(
    Object.entries(b).map(([key, value]) => [key, Math.round(value)]),
  );
// Copying through a menu or a shortcut writes the system clipboard through
// the copy event, so the text travels to other apps and the token comes back
// with a paste here.
function copyObjects({ cut = false } = {}) {
  if (!copySelection()) return;
  clipboardSync = true;
  let written = false;
  try {
    written = document.execCommand("copy");
  } catch {
  } finally {
    clipboardSync = false;
  }
  if (!written)
    navigator.clipboard?.writeText?.(clipboard.text).catch(() => {});
  stampSystemClipboard();
  if (cut) deleteObject();
}
// Menus cannot see a paste event and read the clipboard directly; a token in
// a web custom format is the only kind that survives that trip.
function stampSystemClipboard() {
  const clip = clipboard;
  try {
    navigator.clipboard
      .write([
        new ClipboardItem({
          "text/plain": new Blob([clip.text], { type: "text/plain" }),
          [`web ${CLIPBOARD_TYPE}`]: new Blob([clip.token], {
            type: `web ${CLIPBOARD_TYPE}`,
          }),
        }),
      ])
      .catch(() => {});
  } catch {}
}
function writeClipboardData(e) {
  e.preventDefault();
  e.clipboardData.setData("text/plain", clipboard.text);
  e.clipboardData.setData(CLIPBOARD_TYPE, clipboard.token);
}
// Clipboard events belong to the canvas only while nothing editable has the
// focus and nothing is selected as text; a textarea keeps its own copy and
// paste.
function clipboardEventAllowed(e) {
  return (
    view === "editor" &&
    !!doc &&
    !readOnlyDocument() &&
    !document.querySelector("dialog[open]") &&
    !e.target.closest?.("input, textarea, select, [contenteditable], .menu")
  );
}
document.addEventListener("copy", (e) => {
  if (clipboardSync) {
    writeClipboardData(e);
    return;
  }
  if (!clipboardEventAllowed(e) || !currentShape() || String(getSelection()))
    return;
  if (copySelection()) writeClipboardData(e);
});
document.addEventListener("cut", (e) => {
  if (!clipboardEventAllowed(e) || !currentShape() || String(getSelection()))
    return;
  if (copySelection()) {
    writeClipboardData(e);
    deleteObject();
  }
});
document.addEventListener("paste", (e) => {
  pendingPaste = 0;
  if (!clipboardEventAllowed(e)) return;
  e.preventDefault();
  pasteData(e.clipboardData).catch(fail);
});
// What a paste brings: an object copied here, an image, or text, in that
// order; an older copy made here stands in when the event carries nothing.
async function pasteData(data) {
  const marker =
    data.getData(CLIPBOARD_TYPE) || data.getData(`web ${CLIPBOARD_TYPE}`);
  if (marker && clipboard && marker === clipboard.token)
    return pasteClipboard();
  const image =
    [...data.files].find(isImageFile) ||
    [...data.files].find((file) => file.type.startsWith("image/"));
  if (image) return insertImageFile(image);
  const value = data.getData("text/plain");
  if (value.trim()) return pasteText(value);
  if (clipboard) return pasteClipboard();
}
// A paste asked for through a menu or a shortcut the browser did not turn
// into a paste event reads the clipboard directly, when allowed.
async function pasteFromMenu() {
  let items = null;
  try {
    items = await navigator.clipboard.read();
  } catch {}
  if (items) {
    for (const item of items) {
      const stamp = item.types.find((type) => type === `web ${CLIPBOARD_TYPE}`);
      if (stamp && clipboard) {
        const token = await (await item.getType(stamp)).text();
        if (token === clipboard.token) return pasteClipboard();
      }
    }
    for (const item of items) {
      const type = item.types.find((type) => IMAGE_TYPES.includes(type));
      if (type) {
        const blob = await item.getType(type);
        return insertImageFile(
          new File(
            [blob],
            `Pasted image.${type === "image/png" ? "png" : "jpg"}`,
            {
              type,
            },
          ),
        );
      }
    }
    const textItem = items.find((item) => item.types.includes("text/plain"));
    if (textItem) {
      const value = await (await textItem.getType("text/plain")).text();
      if (value.trim() && value !== clipboard?.text) return pasteText(value);
    }
  }
  if (clipboard) return pasteClipboard();
  toast("Nothing to paste. Copy an object, an image, or text first.");
}
// Pasted objects land where the originals were on another slide, and step
// down and to the right with each further paste onto the same slide.
function pasteClipboard({ destinationTheme = false } = {}) {
  const clip = clipboard;
  if (!clip) return;
  commitText();
  const target = slide();
  const key = `${doc.id}:${P.getSlidePartName(target)}`;
  return mutateSlide(target, (target) => {
    P.importEmbeddedFonts(
      doc.pres,
      clip.pkg,
      P.getEmbeddedFonts(clip.pkg).map((font) => font.typeface),
    );
    const layout = P.getSlideLayout(target) || P.getSlideLayouts(doc.pres)[0];
    // Pasted objects keep the colors and fonts they showed, unless asked
    // to take this presentation's theme.
    const temp = P.importSlide(doc.pres, clip.slide, layout, {
      preserveTextFormatting: !destinationTheme,
      preservePaintFormatting: !destinationTheme,
    });
    const pasted = [];
    try {
      const steps = clip.pastes.get(key) ?? (key === clip.origin ? 1 : 0);
      const offset = P.inches(0.15) * steps;
      const sources = clip.ids
        .map((id, i) => ({ shape: P.findShapeById(temp, id), i }))
        .filter((item) => item.shape);
      const copies = P.copyShapes(
        target,
        sources.map((item) => item.shape),
      );
      sources.forEach(({ i }, n) => {
        const copy = copies[n];
        const b = clip.bounds[i];
        if (b)
          setSlideBounds(doc.pres, copy, {
            ...b,
            x: b.x + offset,
            y: b.y + offset,
          });
        // A link to a slide of this presentation comes back; one to a slide
        // of another presentation has nothing here to point at.
        const linked =
          clip.deck === doc.id &&
          clip.links[i] &&
          P.getSlides(doc.pres).find(
            (s) => P.getSlidePartName(s) === clip.links[i],
          );
        if (linked) setLink(copy, { kind: "slide", slide: linked });
        pasted.push(P.getShapeId(copy));
      });
      clip.pastes.set(key, steps + 1);
    } finally {
      P.removeSlide(doc.pres, temp);
      P.compactPackage(doc.pres);
    }
    if (!pasted.length) return SKIP_MUTATION;
    dedupeSlideMedia(doc.pres, target);
    if (P.getSlidePartName(slide()) === P.getSlidePartName(target))
      selectIds(pasted);
  });
}
// Text from another app becomes a text box sized to its lines.
function pasteText(value) {
  commitText();
  const lines = value.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  mutateSlide(slide(), (target) => {
    const t = THEMES[theme];
    const background = slideBackground(target).color;
    const size = currentSize();
    const width = Math.min(8, size.cx / 914400 - 2.4);
    const height = Math.min(
      size.cy / 914400 - 3.2,
      Math.max(0.6, lines.length * 0.42),
    );
    const s = text(
      target,
      lines.join("\n"),
      1.2,
      1.6,
      width,
      height,
      20,
      legibleColor(background, [t.ink, sectionTextColor(theme)], 4.5),
    );
    if (P.getSlidePartName(slide()) === P.getSlidePartName(target))
      selectIds([P.getShapeId(s)]);
  });
}
// Formatted text from another app (HTML on the clipboard) becomes a text
// box whose runs keep their bold, italic, underline, strikethrough and color.
function pasteRichText(paragraphs) {
  commitText();
  const plain = paragraphs.map((p) => p.runs.map((r) => r.text).join(""));
  return mutateSlide(slide(), (target) => {
    const t = THEMES[theme];
    const background = slideBackground(target).color;
    const size = currentSize();
    const width = Math.min(8, size.cx / 914400 - 2.4);
    const height = Math.min(
      size.cy / 914400 - 3.2,
      Math.max(0.6, plain.length * 0.42),
    );
    const s = text(
      target,
      plain.join("\n"),
      1.2,
      1.6,
      width,
      height,
      20,
      legibleColor(background, [t.ink, sectionTextColor(theme)], 4.5),
    );
    const before = textRuns(doc.pres, s);
    setRichText(
      s,
      paragraphs.map((p, i) => {
        const base = before[i]?.runs[0] || before[0]?.runs[0];
        return {
          level: 0,
          ppr: before[i]?.ppr ?? null,
          runs: p.runs.map((r) => ({
            text: r.text,
            format: { ...(base?.format || {}), ...r.format },
            rpr: base?.rpr ?? null,
            changes: { ...r.format },
          })),
        };
      }),
    );
    if (P.getSlidePartName(slide()) === P.getSlidePartName(target))
      selectIds([P.getShapeId(s)]);
  });
}
function clipboardItems() {
  const obj = currentShape();
  return [
    {
      label: "Cut",
      icon: "Scissors",
      shortcut: `${M}+X`,
      disabled: !obj,
      onSelect: () => copyObjects({ cut: true }),
    },
    {
      label: "Copy",
      icon: "Copy",
      shortcut: `${M}+C`,
      disabled: !obj,
      onSelect: () => copyObjects(),
    },
    {
      label: "Paste",
      icon: "ClipboardPaste",
      shortcut: `${M}+V`,
      onSelect: () => pasteFromMenu().catch(fail),
    },
  ];
}
/* ---------- Context menus ---------- */
function objectContextMenu(e, s) {
  e.preventDefault();
  e.stopPropagation();
  activeDrag?.cancel();
  const current = shapeIndex(s);
  if (current < 0) return;
  if (!selectionIds().has(P.getShapeId(s))) {
    selectOnly(current);
    updateSelectionUi();
    renderInspector();
  }
  const obj = currentShape();
  // The items follow the selection the press made, so an unselected object
  // gets its Align to slide and an unselected group its Ungroup.
  const arrange = arrangeItems();
  openMenu({
    anchor: e.currentTarget,
    x: e.clientX,
    y: e.clientY,
    label: "Object options",
    contextual: true,
    items: [
      ...(chartTools.isChart(obj)
        ? [
            {
              label: "Edit Data",
              icon: "o:editData",
              shortcut: "Enter",
              onSelect: () => chartTools.editData(obj),
            },
            {
              label: "Change Chart Type…",
              icon: "o:changeChartType",
              onSelect: () => chartTools.changeType(obj),
            },
            { separator: true },
          ]
        : []),
      ...(canEditText(obj) || isTable(obj) || P.isDiagramShape(obj)
        ? [
            {
              label: P.isDiagramShape(obj)
                ? P.getShapeSmartArt?.(obj)?.layout
                  ? "Show Text Pane"
                  : "Edit diagram text"
                : isTable(obj)
                  ? "Edit cell"
                  : "Edit text",
              icon: "Pencil",
              shortcut: "Enter",
              onSelect: () => editText(obj, isTable(obj) ? e : null),
            },
            { separator: true },
          ]
        : []),
      ...insertFeatures.contextItems(obj),
      ...clipboardItems(),
      {
        label: "Duplicate",
        icon: "CopyPlus",
        shortcut: `${M}+D`,
        onSelect: duplicateObject,
      },
      { separator: true },
      {
        label: "Ask AI about this",
        icon: "Sparkles",
        onSelect: () =>
          openAssistant(
            multiSelected()
              ? "About the selected objects: "
              : "About the selected object: ",
          ),
      },
      { separator: true },
      ...(canLink(obj)
        ? [
            {
              label: linkOf(obj) ? "Edit link" : "Add link",
              icon: "Link",
              shortcut: `${M}+K`,
              onSelect: run(linkDialog),
            },
            ...(linkOf(obj)
              ? [{ label: "Remove link", icon: "Link", onSelect: removeLink }]
              : []),
            { separator: true },
          ]
        : []),
      { label: "Order", icon: "Layers", items: orderItems(obj) },
      ...arrange.slice(0, 2),
      // Group or Ungroup, found by name: the list's order changes as items
      // are added to it.
      ...arrange.filter(
        (item) =>
          item.label ===
          (multiSelected()
            ? "Group"
            : P.getShapeKind(obj) === "group"
              ? "Ungroup"
              : ""),
      ),
      { separator: true },
      {
        label: "Delete",
        icon: "Trash2",
        shortcut: "Delete",
        danger: true,
        onSelect: deleteObject,
      },
    ],
  });
}
function canvasContextMenu(e) {
  e.preventDefault();
  clearSelection();
  renderSelection();
  renderInspector();
  // The menu for the slide itself: paste, the slide's layout and
  // background, and the rulers and guides.
  openMenu({
    anchor: document.querySelector("#main"),
    x: e.clientX,
    y: e.clientY,
    label: "Slide options",
    contextual: true,
    items: [
      { ...clipboardItems()[2], icon: "o:paste" },
      { separator: true },
      {
        label: "Text Box",
        icon: "o:textBox",
        onSelect: () => addObject("text"),
      },
      { label: "Picture…", icon: "o:picture", onSelect: () => insertImage() },
      { separator: true },
      !masterView.active && {
        label: "New Slide",
        icon: "o:newSlide",
        items: layoutItems(slide()),
      },
      ...slideActions(slide(), { hideUnavailable: true }),
      { separator: true },
      {
        label: "Ruler",
        checked: !!chrome.ruler,
        onSelect: () => show("ruler", !chrome.ruler),
      },
      {
        label: "Grid and Guides",
        icon: "o:gridlines",
        items: views.grid.menuItems(),
      },
      {
        label: "Format Background…",
        icon: "o:formatBackground",
        onSelect: () => show("formatPane", true),
      },
    ],
  });
}
async function themeDialog() {
  const target = doc;
  let chosen = theme;
  const options = el(
    "div",
    { class: "theme-options" },
    ...Object.entries(THEMES).map(([key, t]) => {
      const choice = button(
        t.name,
        null,
        (e) => {
          chosen = key;
          options
            .querySelectorAll("button")
            .forEach((b) =>
              b.setAttribute("aria-pressed", String(b === e.currentTarget)),
            );
        },
        "theme-choice",
        { "aria-pressed": String(key === theme), autofocus: key === theme },
      );
      choice.prepend(
        el(
          "span",
          {
            class: "theme-swatch",
            style: `background:${t.bg};border-color:${t.accent};color:${t.ink}`,
          },
          "Aa",
        ),
      );
      return choice;
    }),
  );
  const ok = await dialog({
    title: "Presentation theme",
    body: el(
      "div",
      { class: "dialog-body" },
      options,
      el(
        "p",
        { class: "helper" },
        "Applies this palette to slides created with our templates. Custom colors and imported artwork are preserved.",
      ),
    ),
    confirm: "Apply theme",
  });
  if (ok && doc === target)
    mutate(() => (recolorDeck(chosen) === false ? SKIP_MUTATION : undefined));
}
// Recolors every slide from the current palette to `chosen`: what uses the
// current palette's colors takes the new one's, and custom colors and
// imported artwork stay. False when the deck already uses it.
function recolorDeck(chosen) {
  // The theme's master comes in, and what the slides paint in the current
  // palette's colors takes the new one's (themes/engine.js).
  return themeTools.applyPalette(chosen);
}
const normalizeColor = (c) =>
  String(c || "")
    .replace("#", "")
    .toLowerCase();
// Theme color tokens as the file stores them ("scheme:bg1"), read through
// the slide's color map to the theme's named colors.
const THEME_COLOR_KEYS = {
  lt1: "light1",
  dk1: "dark1",
  lt2: "light2",
  dk2: "dark2",
  hlink: "hyperlink",
  folHlink: "followedHyperlink",
};
function resolveSchemeColor(color, target) {
  if (!String(color || "").startsWith("scheme:")) return color || null;
  const token = color.slice("scheme:".length);
  const mapped = P.getEffectiveColorMap(target)[token] || token;
  return (
    P.getPresentationTheme(doc.pres)?.[THEME_COLOR_KEYS[mapped] || mapped] ||
    null
  );
}
// The background a slide shows: its own, or the one inherited from its layout
// or master, with theme colors resolved to hex.
function slideBackground(target) {
  try {
    const context = {
      // Hex colors and non-solid backgrounds need no theme/master lookup.
      get theme() {
        return P.getPresentationTheme(doc.pres);
      },
      get clrMap() {
        return P.getEffectiveColorMap(target);
      },
    };
    let background = P.getSlideBackground(target, context);
    const layout = P.getSlideLayout(target);
    if (background.kind === "inherit" && layout)
      background = P.getSlideLayoutBackground(layout, context);
    if (background.kind === "inherit" && layout)
      background = P.getSlideMasterBackground(doc.pres, layout, context);
    if (background.kind !== "solid") return background;
    let color = resolveSchemeColor(background.color, target);
    // Match the preview's white page beneath translucent backgrounds so the
    // swatch and automatic text contrast use the color the user actually sees.
    if (background.opacity < 1 && /^#[0-9a-f]{6}$/i.test(color || "")) {
      const opacity = background.opacity;
      color =
        "#" +
        [1, 3, 5]
          .map((offset) =>
            Math.round(
              parseInt(color.slice(offset, offset + 2), 16) * opacity +
                255 * (1 - opacity),
            )
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")
          .toUpperCase();
    }
    return { kind: "solid", color };
  } catch {
    return { kind: "inherit" };
  }
}
const BACKGROUND_LABELS = {
  gradient: "Gradient",
  pattern: "Pattern",
  image: "Image",
  inherit: "From layout",
};
// Ink drawn during a show stays on the slides only if the presenter says so.
// `reading` plays the show in Reading View: inside the window, under its
// title bar, with a status bar for moving through it.
// A show on its way up (its inserted media still loading) counts as open.
let presentOpening = false;
async function present(options = {}) {
  // Before anything waits: a window for the audience needs the click.
  options = showFeatures.begin(options);
  await settled();
  if (presentOpening || document.querySelector("dialog.presenter[open]")) {
    options.audience?.close();
    return;
  }
  const pres = doc.pres;
  const previews = doc.previews;
  const slides = P.getSlides(pres);
  // The file's Set Up Show choices, and a custom show asked for by name.
  const plan = showFeatures.plan(pres, options);
  const reading = plan.reading;
  const selection = plan.selection ?? P.getSlideShowSelection(pres);
  let all;
  if (selection.kind === "custom") {
    const byName = new Map(
      slides.map((s) => [P.getSlidePartName(s).toLowerCase(), s]),
    );
    all = selection.slidePartNames.map((name) => {
      const slide = byName.get(name.toLowerCase());
      if (!slide)
        throw Error("A custom slide show references a missing slide.");
      return slide;
    });
  } else {
    if (selection.kind === "range" && selection.end > slides.length)
      throw Error(
        "The slide show range exceeds the presentation's slide count.",
      );
    all = (
      selection.kind === "range"
        ? slides.slice(selection.start - 1, selection.end)
        : slides
    ).filter((s) => !P.isSlideHidden(s));
  }
  if (!all.length) {
    toast(
      selection.kind === "all"
        ? "There are no visible slides to present."
        : "The configured slide show has no slides to present.",
    );
    return;
  }
  const showTiming = plan.timing(P.getSlideShowTimingOptions(pres));
  const refreshDates = slides.some((s) => slideHasDateFields(pres, s));
  if (refreshDates) P.refreshPresentationFields(pres);
  const start = slides.slice(index).find((s) => !P.isSlideHidden(s));
  let n =
    options.from === "beginning"
      ? 0
      : selection.kind === "all"
        ? start
          ? all.indexOf(start)
          : all.length - 1
        : 0;
  const before = document.activeElement;
  const d = el("dialog", {
    class: "presenter",
    "aria-label": "Presentation mode",
  });
  const stage = el("div", { class: "presenter-stage", tabindex: -1 });
  const status = el("p", { class: "presenter-status", role: "status" });
  const image = el("img", {
    class: "presenter-slide",
    tabindex: -1,
    draggable: "false",
  });
  // Linked objects get a region over the slide: a web address opens in a
  // new tab, a slide link goes there.
  const links = el("div", { class: "presenter-links" });
  const endMessage = el(
    "p",
    { class: "presenter-end", hidden: true, tabindex: -1, role: "status" },
    "End of presentation. Click to exit.",
  );
  const frame = el(
    "div",
    { class: "presenter-frame" },
    image,
    links,
    endMessage,
  );
  const laser = createSlideLaserPointer(frame, {
    appearance: () =>
      P.getSlideShowLaserColor(pres) ?? { color: "#FF0000", opacity: 1 },
    onError: pointerError,
  });
  function pointerError(error) {
    status.textContent = error.message;
    stage.classList.add("has-status");
  }
  // The presenter's pen: the show's ink (src/show/ink.js), kept per slide
  // while the show runs and offered to keep on the slides when it ends.
  const showInk = {
    get enabled() {
      return session?.inkTool() === "pen";
    },
    setEnabled: (on) => session?.setInkTool(on ? "pen" : null),
    get color() {
      return session?.inkColor();
    },
    setColor: (value) => session?.setInkColor(value),
    clearSlide: () => session?.clearInk(),
  };
  const inkButton = iconButton("Pen", "Pencil", () => toggleInk(), {
    "aria-pressed": "false",
    title: "Pen (I). E erases the ink on this slide.",
  });
  const inkMenuButton = iconButton(
    "Pen color and ink",
    "ChevronDown",
    (e) =>
      menu(
        e.currentTarget,
        [
          ...SHOW_PEN_COLORS.map(([name, value]) => ({
            label: name,
            checked: showInk.color === value,
            onSelect: () => {
              showInk.setColor(value);
              toggleInk(true);
            },
          })),
          { separator: true },
          {
            label: "Erase Ink on Slide",
            shortcut: "E",
            onSelect: () => showInk.clearSlide(),
          },
        ],
        { label: "Pen" },
      ),
    { ...MENU_BUTTON, class: "btn icon-btn presenter-ink-menu" },
  );
  function toggleInk(on = !showInk.enabled) {
    if (on && laser.enabled) toggleLaser();
    showInk.setEnabled(on);
    inkButton.setAttribute("aria-pressed", String(on));
  }
  const laserButton = iconButton(
    "Laser pointer",
    "Pointer",
    () => toggleLaser(),
    {
      "aria-pressed": "false",
      title: "Laser pointer (L). Hold Control and drag to point temporarily.",
    },
  );
  function toggleLaser() {
    try {
      if (!laser.enabled && showInk.enabled) toggleInk(false);
      laser.setEnabled(!laser.enabled);
      laserButton.setAttribute("aria-pressed", String(laser.enabled));
      status.textContent = "";
      stage.classList.remove("has-status");
    } catch (error) {
      pointerError(error);
    }
  }
  const size = P.getSlideSize(pres) || { width: 12192000, height: 6858000 };
  // Media, zooms and action settings (src/insert/show.js).
  // The show's tools and views beside it (src/show/session.js).
  let session = null;
  const showInserted = insertFeatures.slideShow({
    pres,
    all,
    frame,
    size,
    skipMedia: (shape) => !!session?.skipMedia(shape),
    show: (i) => show(i),
    close: () => close(),
  });
  function fitFrame() {
    const area = frame.parentElement;
    if (!area) return;
    const ratio = size.width / size.height;
    const w = Math.min(area.clientWidth, area.clientHeight * ratio);
    frame.style.width = `${Math.floor(w)}px`;
    frame.style.height = `${Math.floor(w / ratio)}px`;
  }
  const frameObserver = new ResizeObserver(fitFrame);
  // The stage keeps clear of the control bar, which wraps onto two rows on
  // a phone.
  const controlsObserver = new ResizeObserver(([entry]) =>
    stage.style.setProperty(
      "--presenter-controls",
      `${entry.target.offsetHeight}px`,
    ),
  );
  function placeLinks(current) {
    links.replaceChildren();
    const parents = groupParents(current);
    for (const shape of visibleSlideShapes(current)) {
      if (showInserted.claims(shape)) continue;
      const link = linkOf(shape);
      // An address the app would not accept in its own link dialog gets no
      // region: the file may have been written elsewhere.
      if (link?.kind === "url" && !canOpenUrl(link.url)) continue;
      const b = link && slideBounds(pres, shape, parents);
      if (!b) continue;
      const style = {
        left: `${(b.x / size.width) * 100}%`,
        top: `${(b.y / size.height) * 100}%`,
        width: `${(b.w / size.width) * 100}%`,
        height: `${(b.h / size.height) * 100}%`,
        // The region turns with the object, about the same center.
        transform: `rotate(${slideRotation(shape, parents)}deg)`,
      };
      const label = describeLink(link);
      const node =
        link.kind === "url"
          ? el("a", {
              class: "presenter-link",
              href: link.url,
              target: "_blank",
              // The site opened learns nothing of the page it was opened from.
              rel: "noopener noreferrer",
              title: label,
              "aria-label": `Open ${label}`,
            })
          : el("button", {
              type: "button",
              class: "presenter-link",
              title: `Go to ${label.toLowerCase()}`,
              "aria-label": `Go to ${label.toLowerCase()}`,
              onclick: (e) => {
                e.stopPropagation();
                follow(link);
              },
            });
      Object.assign(node.style, style);
      links.append(node);
    }
  }
  // Shapes that play effects when clicked get a region of their own.
  function placeTriggers() {
    for (const { shapeId, box } of animator?.triggers || []) {
      if (!box) continue;
      const shape = P.findShapeById(all[n], Number(shapeId));
      const name = shape ? P.getShapeName(shape) || "object" : "object";
      const node = el("button", {
        type: "button",
        class: "presenter-link presenter-trigger",
        title: `Play the effects of ${name}`,
        "aria-label": `Play the effects of ${name}`,
        onclick: (e) => {
          e.stopPropagation();
          animator?.playTrigger(shapeId);
        },
      });
      Object.assign(node.style, {
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
      });
      links.append(node);
    }
  }
  function follow(link) {
    if (link.kind === "slide") {
      const i = all.findIndex(
        (s) => P.getSlidePartName(s) === P.getSlidePartName(link.slide),
      );
      if (i >= 0) show(i);
      else toast("That slide is hidden or was removed.");
    } else if (link.kind === "nextSlide") show(n + 1, { step: "click" });
    else if (link.kind === "prevSlide") showPrevious();
    else if (link.kind === "firstSlide") show(0);
    else if (link.kind === "lastSlide") show(all.length - 1);
  }
  const counter = el("span", {
    class: "presenter-counter",
    "aria-live": "polite",
  });
  const previous = iconButton("Previous slide", "ChevronLeft", () =>
      showPrevious(),
    ),
    next = iconButton("Next slide", "ChevronRight", () => advance());
  // Speaker notes and the slide to come sit beside the slide when asked for.
  const notesText = el("p", { class: "presenter-notes-text" });
  const upcoming = el("img", {
    class: "presenter-next",
    alt: "",
    draggable: "false",
  });
  const upcomingLabel = el("p", { class: "presenter-next-label" });
  const notes = el(
    "aside",
    { class: "presenter-notes", "aria-label": "Speaker notes", hidden: true },
    el("h2", {}, "Notes"),
    notesText,
    el("h2", {}, "Next"),
    upcoming,
    upcomingLabel,
  );
  const notesButton = iconButton(
    "Speaker notes",
    "FileText",
    () => toggleNotes(),
    { "aria-pressed": "false", title: "Speaker notes" },
  );
  function toggleNotes(on = notes.hidden) {
    notes.hidden = !on;
    stage.classList.toggle("show-notes", on);
    notesButton.setAttribute("aria-pressed", String(on));
  }
  // The time since the show began; a press starts it over.
  const started = { at: Date.now() };
  const timer = button(
    "00:00",
    "Timer",
    () => (started.at = Date.now()),
    "presenter-timer",
    {
      "aria-label": "Time elapsed, press to start over",
      title: "Time elapsed. Press to start over.",
    },
  );
  const tick = () => {
    const seconds = Math.floor((Date.now() - started.at) / 1000);
    const text = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    if (timer.lastChild.textContent !== text)
      timer.lastChild.textContent = text;
  };
  const clock = setInterval(tick, 250);
  // Typing a slide's number and Enter goes straight to it.
  let typed = "";
  let typedTimer;
  let typedWasPaused = false;
  let shown = false;
  let ended = false;
  let currentTransition;
  // The current slide's animations: an advance plays its next click step
  // before the show moves on.
  let animator = null;
  // Once a timed slide's time is up, its remaining click steps play one
  // after another before the show moves on.
  let timeUp = false;
  function advance(auto = false) {
    if (!ended && animator?.next()) {
      session?.stepped(1);
      if (timeUp) advanceClock.select(0, animator.played);
      return;
    }
    show(n + 1, { step: auto ? "auto" : "click" });
  }
  const advanceClock = createSlideAdvanceClock(() => {
    timeUp = true;
    advance(true);
  });
  const pauseButton = iconButton(
    "Pause automatic advance",
    "Pause",
    () => {
      restoreBlank();
      setPaused(!advanceClock.paused);
    },
    { "aria-pressed": "false", title: "Pause automatic advance (S)" },
  );
  pauseButton.hidden =
    !showTiming.useTimings ||
    !all.some(
      (s) =>
        transitionDetails(s, { supportedEffects: PLAYABLE_TRANSITIONS })
          ?.advanceAfterMs !== undefined,
    );
  function setPaused(on) {
    advanceClock.setPaused(on);
    syncPause();
  }
  function restoreBlank() {
    laser.hide();
    stage.classList.remove("blank", "blank-white");
    if (document.activeElement === stage) (ended ? endMessage : image).focus();
  }
  function syncPause() {
    const paused = advanceClock.paused;
    const label = `${paused ? "Resume" : "Pause"} automatic advance`;
    pauseButton.setAttribute("aria-pressed", String(paused));
    pauseButton.setAttribute("aria-label", label);
    pauseButton.title = `${label} (S)`;
    pauseButton.replaceChildren(icon(paused ? "Play" : "Pause"));
  }
  function clearTyped() {
    clearTimeout(typedTimer);
    typed = "";
  }
  function showPrevious() {
    if (!ended && animator?.previous()) {
      session?.stepped(-1);
      // Stepping back starts the slide's time over.
      if (timeUp) {
        timeUp = false;
        advanceClock.select(
          showTiming.useTimings ? currentTransition?.advanceAfterMs : undefined,
        );
      }
      return;
    }
    show(ended ? n : n - 1, { backward: true });
  }
  // The transition playing over the frame (see src/transitions/player.js).
  let playing = null;
  function clearTransition() {
    playing?.cancel();
    playing = null;
  }
  // `step` marks a plain advance ("click", or "auto" from the timer), as
  // opposed to a jump to a slide.
  function show(i, { backward = false, step } = {}) {
    const redirected = ended ? i : showInserted.navigate(i, n, { step });
    if (redirected === null) return;
    i = redirected;
    timeUp = false;
    laser.hide();
    clearTyped();
    const wrapped = showTiming.loop && (i < 0 || i >= all.length);
    if (showTiming.loop && i < 0) i = all.length - 1;
    if (i >= all.length) {
      if (showTiming.loop) i = 0;
      else if (ended) {
        close();
        return;
      } else {
        ended = true;
        pauseButton.disabled = true;
        advanceClock.clear();
        syncPause();
        clearTransition();
        stage.classList.remove("blank", "blank-white");
        stage.classList.add("ended");
        endMessage.hidden = false;
        links.replaceChildren();
        previous.disabled = false;
        upcoming.removeAttribute("src");
        upcoming.hidden = true;
        upcomingLabel.textContent = "End of presentation.";
        endMessage.focus();
        session?.ended();
        return;
      }
    }
    const focused = document.activeElement;
    const from = n;
    ended = false;
    pauseButton.disabled = false;
    endMessage.hidden = true;
    stage.classList.remove("ended");
    n = Math.max(0, Math.min(all.length - 1, i));
    stage.classList.remove("blank", "blank-white");
    const transition = transitionDetails(all[n], {
      supportedEffects: PLAYABLE_TRANSITIONS,
    });
    currentTransition = transition;
    // Going back reverses the transition of the slide
    // being left. Direct jumps (including to a lower index) play the arriving
    // slide's transition forward. Advance settings always belong to that slide.
    const playbackTransition = backward
      ? transitionDetails(all[from], {
          supportedEffects: PLAYABLE_TRANSITIONS,
        })
      : transition;
    let readiness;
    const effect = playbackTransition?.effect || "none";
    clearTransition();
    animator?.destroy();
    animator = null;
    const leaving = shown ? image.getAttribute("src") : null;
    const arriving =
      showInserted.imageFor(all[n]) ?? cachedPreview(previews, pres, all[n]);
    if (
      shown &&
      (n !== from || wrapped) &&
      effect !== "none" &&
      !prefersReducedMotion()
    ) {
      playing = transitionTools.play({
        host: frame,
        fromSlide: all[from],
        toSlide: all[n],
        from: leaving,
        to: arriving,
        transition: playbackTransition,
        backward,
      });
      readiness = playing.finished;
    }
    if (shown && !backward && (n !== from || wrapped))
      transitionTools.playArrivalSound(all[n]);
    shown = true;
    // The navigator already rendered nearby slides from this same state;
    // distant ones render once here and are kept for the navigator.
    image.src = arriving;
    image.alt = slideDescription(all[n], pres) || `Slide ${n + 1}`;
    animator = createSlideAnimator({ pres, slide: all[n], frame, image });
    // Set Up Show can show every slide without its animations.
    if (backward || !plan.setup.showAnimation) animator.finish();
    else {
      const playing = animator;
      Promise.resolve(readiness).then(() => {
        if (animator !== playing) return;
        playing.start();
        session?.stepped(0);
      });
    }
    placeLinks(all[n]);
    showInserted.slideShown(all[n], n);
    placeTriggers();
    counter.textContent = reading
      ? `Slide ${n + 1} of ${all.length}`
      : `${n + 1} / ${all.length}`;
    previous.disabled = n === 0 && !showTiming.loop;
    next.disabled = false;
    const text = P.getSlideNotes(all[n]) || "";
    notesText.textContent = text || "No notes for this slide.";
    notesText.classList.toggle("empty", !text);
    const comingIndex = n + 1 < all.length ? n + 1 : showTiming.loop ? 0 : -1;
    const coming = all[comingIndex];
    if (coming) {
      upcoming.src = cachedPreview(previews, pres, coming);
      upcoming.hidden = false;
      upcomingLabel.textContent = `Slide ${comingIndex + 1}: ${slideTitle(coming, pres) || slideDescription(coming, pres).split("\n")[0] || "Blank"}`;
    } else {
      upcoming.removeAttribute("src");
      upcoming.hidden = true;
      upcomingLabel.textContent = "This is the last slide.";
    }
    if (
      (previous.disabled && focused === previous) ||
      (next.disabled && focused === next) ||
      focused === endMessage ||
      focused === stage
    )
      image.focus();
    advanceClock.select(
      showTiming.useTimings ? transition?.advanceAfterMs : undefined,
      readiness,
    );
    syncPause();
    session?.shown(n, { finished: backward || !plan.setup.showAnimation });
  }
  function close() {
    if (!d.isConnected) return;
    session?.dispose();
    showInserted.dispose();
    animator?.destroy();
    animator = null;
    transitionTools.stopSound();
    laser.dispose();
    releaseFonts();
    advanceClock.dispose();
    clearTransition();
    clearInterval(clock);
    clearTimeout(typedTimer);
    frameObserver.disconnect();
    controlsObserver.disconnect();
    document.removeEventListener("fullscreenchange", syncFullscreen);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    d.close();
    d.remove();
    // Reading View ends on the slide it reached, as its view buttons do.
    let reached = false;
    if (reading && all[n] && doc?.pres === pres) {
      const part = P.getSlidePartName(all[n]);
      const at = P.getSlides(pres).findIndex(
        (s) => P.getSlidePartName(s) === part,
      );
      if (at >= 0 && at !== index) {
        index = at;
        reached = true;
      }
    }
    if ((refreshDates || reached) && doc?.pres === pres) renderSlideArea();
    if (before?.isConnected) before.focus();
    else if (before?.matches(".object-hit"))
      document
        .querySelector(
          `.object-hit[data-object="${CSS.escape(before.dataset.object)}"]`,
        )
        ?.focus();
  }
  const fullscreen = iconButton(
    "Toggle fullscreen",
    "Maximize",
    async () => {
      status.textContent = "";
      stage.classList.remove("has-status");
      const entering = !document.fullscreenElement;
      try {
        if (entering) await stage.requestFullscreen();
        else await document.exitFullscreen();
      } catch {
        if (!d.isConnected) return;
        status.textContent = entering
          ? "Fullscreen is unavailable in this window."
          : "Could not exit fullscreen. Use Exit to close presentation mode.";
        stage.classList.add("has-status");
      }
    },
    { "aria-pressed": "false" },
  );
  // Fullscreen can also end through the browser itself, such as Escape.
  function syncFullscreen() {
    const active = document.fullscreenElement === stage;
    fullscreen.setAttribute("aria-pressed", String(active));
    fullscreen.replaceChildren(icon(active ? "Minimize" : "Maximize"));
  }
  document.addEventListener("fullscreenchange", syncFullscreen);
  const slideArea = el("div", { class: "presenter-slide-area" }, frame);
  frameObserver.observe(slideArea);
  const controls = reading
    ? readingBar({
        previous,
        next,
        counter,
        count: all.length,
        current: () => n,
        show: (i) => show(i, { backward: i < n }),
        close,
        titleOf: (i) => slideTitle(all[i], pres),
        // Another view from the bar: the show ends on the slide it reached.
        switchTo: (id) => {
          const part = P.getSlidePartName(all[n]);
          close();
          const at = P.getSlides(doc.pres).findIndex(
            (s) => P.getSlidePartName(s) === part,
          );
          if (at >= 0) index = at;
          if (id === "show") present({ from: "current" }).catch(fail);
          else {
            renderSlideArea();
            setView(id);
          }
        },
      })
    : el(
        "div",
        { class: "presenter-controls" },
        button("Exit", "X", close),
        previous,
        counter,
        next,
        notesButton,
        laserButton,
        inkButton,
        inkMenuButton,
        pauseButton,
        timer,
        fullscreen,
      );
  if (reading) placeReadingDialog(d);
  controlsObserver.observe(controls);
  stage.append(slideArea, notes, status, controls);
  d.append(stage);
  session = showFeatures.session({
    pres,
    all,
    options,
    setup: plan.setup,
    reading,
    dialog: d,
    stage,
    frame,
    slideArea,
    controls,
    status,
    size,
    current: () => n,
    isEnded: () => ended,
    go: (i) => show(i),
    next: () => next.click(),
    previous: () => previous.click(),
    close: () => close(),
    fit: () => fitFrame(),
    focus: () => (ended ? endMessage : image).focus(),
    setPaused: (on) => {
      restoreBlank();
      setPaused(on);
    },
    paused: () => advanceClock.paused,
    autoAdvance: !pauseButton.hidden,
    toggleLaser: () => toggleLaser(),
    laserEnabled: () => laser.enabled,
    picture: (s) => cachedPreview(previews, pres, s),
    // The current slide as its animations have built it so far.
    currentPicture: () =>
      animator?.snapshot() ?? cachedPreview(previews, pres, all[n]),
    animationPlayed: () => animator?.played,
    title: (s) => slideTitle(s, pres),
    // Click steps of the slide's animations, and whether it opened on its
    // last one (reached by going back, or shown without animation).
    animationSteps: () => animator?.steps ?? 0,
    inkChanged: () =>
      inkButton.setAttribute("aria-pressed", String(showInk.enabled)),
  });
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (laser.enabled) toggleLaser();
    else if (showInk.enabled) toggleInk(false);
    else close();
  });
  d.addEventListener("keydown", (e) => {
    // Composition keys belong to the input method, including its Escape.
    if (e.isComposing) return;
    if (session?.keydown(e)) return;
    // Native presentation tools leave pointing mode before ending the show.
    if (e.key === "Escape" && laser.enabled) {
      e.preventDefault();
      toggleLaser();
      return;
    }
    if (e.key === "Escape" && showInk.enabled) {
      e.preventDefault();
      toggleInk(false);
      return;
    }
    if (
      [" ", "Enter"].includes(e.key) &&
      e.target.closest("button,a") &&
      !(e.key === "Enter" && typed)
    )
      return;
    // The editor's save and print shortcuts keep working here; the browser's
    // own print would only produce a blank page behind the slideshow.
    if ((e.ctrlKey || e.metaKey) && ["p", "s"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      (e.key.toLowerCase() === "p"
        ? fileTools.openPrintDialog()
        : saveCloud()
      ).catch(fail);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const wasBlank =
      stage.classList.contains("blank") ||
      stage.classList.contains("blank-white");
    const key = e.key.toLowerCase();
    if (key === "l") {
      e.preventDefault();
      toggleLaser();
    }
    if (key === "i") {
      e.preventDefault();
      toggleInk();
    }
    if (key === "e") {
      e.preventDefault();
      showInk.clearSlide();
    }
    if (key !== "b" && key !== "w" && wasBlank) {
      restoreBlank();
      setPaused(false);
    }
    if (
      key === "n" ||
      ["ArrowRight", "ArrowDown", " ", "PageDown"].includes(e.key) ||
      (e.key === "Enter" && !typed)
    ) {
      e.preventDefault();
      advance();
    }
    if (
      key === "p" ||
      ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)
    ) {
      e.preventDefault();
      showPrevious();
    }
    if (e.key === "Home") show(0);
    if (e.key === "End") show(all.length - 1);
    if (key === "s") {
      e.preventDefault();
      if (!wasBlank) setPaused(!advanceClock.paused);
    }
    // B and W blank the screen to black or white until the next key.
    if (key === "b" || key === "w") {
      const cls = key === "b" ? "blank" : "blank-white";
      const on = stage.classList.contains(cls);
      restoreBlank();
      if (!on) {
        stage.classList.add(cls);
        // Hiding the focused image otherwise drops keyboard input outside
        // the dialog, leaving B/W unable to restore the show.
        stage.focus();
      }
      setPaused(!on);
    }
    if (/^[0-9]$/.test(e.key)) {
      if (!typed) {
        typedWasPaused = advanceClock.paused;
        setPaused(true);
      }
      typed += e.key;
      counter.textContent = `Go to ${typed}…`;
      clearTimeout(typedTimer);
      typedTimer = setTimeout(() => {
        typed = "";
        counter.textContent = `${n + 1} / ${all.length}`;
        setPaused(typedWasPaused);
      }, 2000);
    } else if (e.key === "Enter" && typed) {
      e.preventDefault();
      clearTimeout(typedTimer);
      const target = Number(typed);
      typed = "";
      show(Math.max(1, Math.min(all.length, target)) - 1);
    }
  });
  let touch = null;
  let swiped = false;
  frame.addEventListener("pointerdown", () => {
    swiped = false;
  });
  frame.addEventListener("click", (e) => {
    if (e.target.closest(".presenter-link")) return;
    if (swiped) {
      swiped = false;
      return;
    }
    if (ended) {
      close();
      return;
    }
    if (currentTransition?.advanceOnClick !== false) advance();
  });
  stage.addEventListener("click", (e) => {
    if (e.target.closest(".presenter-controls")) return;
    if (
      stage.classList.contains("blank") ||
      stage.classList.contains("blank-white")
    ) {
      restoreBlank();
      setPaused(false);
    }
  });
  stage.addEventListener(
    "touchstart",
    (e) => {
      const first = e.touches[0];
      swiped = false;
      touch =
        e.touches.length === 1 && e.target === image
          ? { id: first.identifier, x: first.clientX, y: first.clientY }
          : null;
    },
    { passive: true },
  );
  stage.addEventListener(
    "touchend",
    (e) => {
      const start = touch;
      touch = null;
      if (!start || e.touches.length) return;
      const end = [...e.changedTouches].find(
        (point) => point.identifier === start.id,
      );
      if (!end) return;
      const dx = end.clientX - start.x;
      const dy = end.clientY - start.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        swiped = true;
        if (dx < 0) advance();
        else showPrevious();
      }
    },
    { passive: true },
  );
  stage.addEventListener(
    "touchcancel",
    () => {
      touch = null;
    },
    { passive: true },
  );
  presentOpening = true;
  try {
    await showInserted.prepare();
  } finally {
    presentOpening = false;
  }
  const releaseFonts = retainDocumentFonts(pres);
  document.body.append(d);
  try {
    show(n);
    d.showModal();
    image.focus();
  } catch (error) {
    close();
    throw error;
  }
}
document.addEventListener("keydown", (e) => {
  if (
    e.defaultPrevented ||
    e.isComposing ||
    view !== "editor" ||
    document.querySelector("dialog[open]") ||
    e.target.closest(".menu")
  )
    return;
  // Keys pressed in a field, or anywhere in the find bar, edit text rather
  // than the selected object. A picker, a slider, a switch, or a list of
  // options holds no text of its own, so undo and redo still reach the
  // presentation from them and take back the choice just made there.
  const editing = e.target.closest(
    "input,textarea,select,[contenteditable],.findbar",
  );
  const typing =
    editing &&
    !e.target.matches(
      'select, input[type="color"], input[type="range"], input[type="checkbox"]',
    );
  const mod = e.ctrlKey || e.metaKey;
  if (formatTools.onKeydown(e, { typing })) return;
  if (review.keydown(e)) return;
  if (!typing && animationTools.onKey(e)) return;
  // Presenter View (Alt+F5) and the show's Enter shortcuts.
  if (showFeatures.onKey(e, { typing })) {
    if (editing) e.target.blur();
    return;
  }
  if (mod && !e.altKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (editing) e.target.blur();
    (e.shiftKey ? saveCopy() : saveCloud()).catch(fail);
    return;
  }
  // The views by number (Cmd/Ctrl+1 to 5), Show Outline, and the grid.
  if (views.keydown(e)) return;
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    if (editing) e.target.blur();
    openPicker().catch(fail);
    return;
  }
  if (mod && e.key.toLowerCase() === "p") {
    e.preventDefault();
    if (editing) e.target.blur();
    fileTools.openPrintDialog().catch(fail);
    return;
  }
  // F5 presents from the first slide, Shift+F5 from the current one.
  if (e.key === "F5" && !mod && !e.altKey) {
    e.preventDefault();
    if (editing) e.target.blur();
    present({ from: e.shiftKey ? "current" : "beginning" }).catch(fail);
    return;
  }
  // The master views: Ctrl+Alt+1, 2 and 3 (Cmd+Option on a Mac).
  if (
    doc &&
    view === "editor" &&
    (IS_MAC ? e.metaKey : e.ctrlKey) &&
    e.altKey &&
    !e.shiftKey &&
    ["Digit1", "Digit2", "Digit3"].includes(e.code)
  ) {
    e.preventDefault();
    const kind = { Digit1: "slide", Digit2: "handout", Digit3: "notes" }[
      e.code
    ];
    setView(masterView.mode === kind ? "normal" : masterView.viewId(kind));
    return;
  }
  // A new slide: Ctrl+M, or Cmd+Shift+N on a Mac where Cmd+M minimizes.
  if (
    !typing &&
    ((IS_MAC && e.metaKey && e.shiftKey && e.code === "KeyN") ||
      (!IS_MAC && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyM"))
  ) {
    e.preventDefault();
    addSlideAfter(slide());
    return;
  }
  // Paragraph alignment, on the selected object or the text being edited.
  if (
    mod &&
    !e.shiftKey &&
    !e.altKey &&
    ["KeyL", "KeyE", "KeyR", "KeyJ"].includes(e.code) &&
    (!typing || e.target.closest(".inline-editor")) &&
    currentShape() &&
    canEditText(currentShape())
  ) {
    e.preventDefault();
    setAlignment(
      currentShape(),
      { KeyL: "left", KeyE: "center", KeyR: "right", KeyJ: "justify" }[e.code],
    );
    return;
  }
  // Clear All Formatting.
  if (
    e.ctrlKey &&
    !e.metaKey &&
    e.code === "Space" &&
    (!typing || e.target.closest(".inline-editor")) &&
    currentShape() &&
    canEditText(currentShape())
  ) {
    e.preventDefault();
    applyTextFormat(currentShape(), {
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      baseline: 0,
      spc: 0,
      highlight: null,
      cap: "none",
    });
    return;
  }
  // The assistant opens with its message box ready, and closes again.
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
    e.preventDefault();
    if (editing && !e.target.closest("#ai-panel")) e.target.blur();
    toggleAssistant();
    return;
  }
  if (
    mod &&
    !e.altKey &&
    !e.shiftKey &&
    ["f", "h"].includes(e.key.toLowerCase())
  ) {
    e.preventDefault();
    openFind({ replace: e.key.toLowerCase() === "h" });
    return;
  }
  // Find Next / Find Previous, also from the find bar.
  if (mod && !e.altKey && e.code === "KeyG") {
    e.preventDefault();
    findAgain(e.shiftKey ? -1 : 1);
    return;
  }
  // The ribbon folds away and comes back.
  if (mod && e.altKey && !e.shiftKey && e.code === "KeyR") {
    e.preventDefault();
    toggleRibbon();
    return;
  }
  // The slide zooms in place of the page.
  if (mod && !e.altKey && ["=", "+", "-", "0"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "0") setZoom("fit");
    else stepZoom(e.key === "-" ? -1 : 1);
    return;
  }
  if (mod && ["z", "y"].includes(e.key.toLowerCase())) {
    // A box holding the value it applied (a ribbon box, or a number field
    // in the Format pane) has nothing of its own to undo: the shortcut takes
    // back the change it made. Typing not yet applied is the box's to undo.
    const box = e.target;
    const applied =
      box instanceof HTMLInputElement &&
      (box.matches(".ribbon-combo-input, .ribbon-spin-input")
        ? box.value === (box.dataset.value ?? "")
        : box.type === "number" &&
          (box.value === box.defaultValue ||
            box.value === box.dataset.committed));
    if (typing && !applied) return;
    e.preventDefault();
    // With nothing to redo, Ctrl/⌘+Y repeats the last format command.
    if (
      e.key.toLowerCase() === "y" &&
      !e.shiftKey &&
      !history.future.length &&
      formatTools.repeat()
    )
      return;
    if (e.key.toLowerCase() === "y" || e.shiftKey) redo();
    else undo();
    return;
  }
  if (editing) return;
  // Other keys pressed in the assistant are the chat's: Delete, an arrow, or
  // a copy on one of its buttons must not reach the selected object. Find,
  // zoom, undo, and redo above reach the presentation from there too.
  if (e.target instanceof Element && e.target.closest("#ai-panel")) return;
  // Copy and paste formatting, as Format Painter does from the keyboard.
  if (mod && e.shiftKey && !e.altKey && e.code === "KeyC" && currentShape()) {
    e.preventDefault();
    painter = {
      format: pickUpFormat(currentShape()),
      sticky: true,
      keyboard: true,
    };
    toast(
      "Formatting copied. Select an object and press Shift+" +
        MOD_KEY +
        "+V to apply it.",
    );
    return;
  }
  if (
    mod &&
    e.shiftKey &&
    !e.altKey &&
    e.code === "KeyV" &&
    currentShape() &&
    painter
  ) {
    e.preventDefault();
    const held = painter;
    paintFormat(currentShape());
    if (held.keyboard) painter = held;
    return;
  }
  // Enter in the thumbnails pane adds a slide after the focused one.
  if (
    e.key === "Enter" &&
    !mod &&
    !e.shiftKey &&
    e.target instanceof Element &&
    e.target.closest("#slide-list .slide-thumb")
  ) {
    e.preventDefault();
    const part = e.target.closest(".slide-item")?.dataset.slidePart;
    addSlideAfter(
      P.getSlides(doc.pres).find((s) => P.getSlidePartName(s) === part) ||
        slide(),
    );
    return;
  }
  // Duplicate Slide.
  if (mod && e.shiftKey && !e.altKey && e.code === "KeyD") {
    e.preventDefault();
    if (!masterView.active && !readOnlyDocument())
      duplicateSlides(actionSlides(slide()));
    return;
  }
  if (mod && e.key.toLowerCase() === "d" && currentShape()) {
    e.preventDefault();
    duplicateObject();
    return;
  }
  if (
    mod &&
    !e.shiftKey &&
    ["c", "x"].includes(e.key.toLowerCase()) &&
    currentShape() &&
    !String(getSelection())
  ) {
    e.preventDefault();
    copyObjects({ cut: e.key.toLowerCase() === "x" });
    return;
  }
  // The browser turns the key into a paste event; one that does not is
  // answered by reading the clipboard directly.
  if (mod && !e.shiftKey && e.key.toLowerCase() === "v") {
    const request = (pendingPaste = performance.now());
    setTimeout(() => {
      if (pendingPaste !== request) return;
      pendingPaste = 0;
      pasteFromMenu().catch(fail);
    }, 60);
    return;
  }
  if (
    mod &&
    !e.shiftKey &&
    ["b", "i", "u"].includes(e.key.toLowerCase()) &&
    currentShape() &&
    canEditText(currentShape())
  ) {
    e.preventDefault();
    toggleTextFormat(
      currentShape(),
      { b: "bold", i: "italic", u: "underline" }[e.key.toLowerCase()],
    );
    return;
  }
  if (
    mod &&
    e.shiftKey &&
    [">", "<", ".", ","].includes(e.key) &&
    currentShape() &&
    canEditText(currentShape())
  ) {
    e.preventDefault();
    stepTextSize(currentShape(), [">", "."].includes(e.key) ? 1 : -1);
    return;
  }
  if (
    mod &&
    ["BracketRight", "BracketLeft"].includes(e.code) &&
    currentShape()
  ) {
    e.preventDefault();
    const forward = e.code === "BracketRight";
    arrangeObject(
      currentShape(),
      e.shiftKey
        ? forward
          ? P.bringShapeToFront
          : P.sendShapeToBack
        : forward
          ? P.bringShapeForward
          : P.sendShapeBackward,
    );
    return;
  }
  if (e.key === "Escape" && (drawingTool || painter || drawTools.tool)) {
    // An armed drawing tool, pen or Format Painter is put down first.
    if (drawingTool) cancelDrawing();
    if (painter) formatPainter();
    if (drawTools.tool) drawTools.stop();
    return;
  }
  if (e.key === "Escape") {
    // An open find bar closes first; the selection goes on a second press.
    const bar = document.querySelector(".findbar");
    if (bar && !bar.hidden) {
      closeFind();
      return;
    }
    if (slideExtras.size) {
      slideExtras.clear();
      renderSlideSelection();
      return;
    }
    // The format panel laid over a narrow screen's canvas closes next, and
    // hands the focus to its toggle.
    const panelNode = document.querySelector("#inspector");
    if (
      panelNode &&
      inspectorVisible() &&
      getComputedStyle(panelNode).position === "absolute"
    ) {
      closeFormatPane();
      return;
    }
    activeDrag?.cancel();
    // The object the focus was on keeps it, deselected; its rebuilt region
    // would otherwise drop the focus onto the page.
    const focusedId = e.target.closest?.(".object-hit")?.dataset.shapeId;
    clearSelection();
    renderSelection();
    renderInspector();
    if (focusedId != null && document.activeElement === document.body)
      (
        document.querySelector(`.object-hit[data-shape-id="${focusedId}"]`) ||
        workspace()
      )?.focus({ preventScroll: true });
    return;
  }
  // In the navigator, Ctrl+A selects every slide and Delete removes the
  // selected ones.
  const inNavigator =
    e.target instanceof Element && e.target.closest("#slide-list");
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
    e.preventDefault();
    if (inNavigator) selectAllSlides();
    else selectAll();
    return;
  }
  if (inNavigator && !mod && ["Delete", "Backspace"].includes(e.key)) {
    e.preventDefault();
    // The focused thumbnail's slide goes, with the selection when it is
    // part of one; the current slide only when no row has the focus.
    const row = e.target.closest(".slide-item");
    const focused =
      row &&
      P.getSlides(doc.pres).find(
        (s) => P.getSlidePartName(s) === row.dataset.slidePart,
      );
    deleteSlides(focused ? actionSlides(focused) : selectedSlides());
    return;
  }
  // In the navigator the arrows step along the slides from the focused
  // thumbnail, Home and End go to the ends, and Shift extends the selection
  // from the current slide, as a Shift-click does. The selected object on
  // the canvas stays where it is.
  if (
    inNavigator &&
    !mod &&
    !e.altKey &&
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
      e.key,
    )
  ) {
    e.preventDefault();
    const all = P.getSlides(doc.pres);
    const row = e.target.closest(".slide-item");
    const from = row
      ? all.findIndex((s) => P.getSlidePartName(s) === row.dataset.slidePart)
      : index;
    const step = ["ArrowDown", "ArrowRight"].includes(e.key)
      ? 1
      : ["ArrowUp", "ArrowLeft"].includes(e.key)
        ? -1
        : 0;
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? all.length - 1
          : Math.max(
              0,
              Math.min(all.length - 1, (from < 0 ? index : from) + step),
            );
    const target = all[to];
    if (!target) return;
    const part = P.getSlidePartName(target);
    const focusThumb = () =>
      document
        .querySelector(
          `#slide-list [data-slide-part="${CSS.escape(part)}"] .slide-thumb`,
        )
        ?.focus();
    if (e.shiftKey) {
      extendSlideSelection(target);
      focusThumb();
    } else chooseSlide(target).then(focusThumb);
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (canLink(currentShape())) linkDialog().catch(fail);
    return;
  }
  if (mod && e.altKey && e.code === "KeyG") {
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else groupSelection();
    return;
  }
  if (["Delete", "Backspace"].includes(e.key) && currentShape()) {
    e.preventDefault();
    deleteObject();
    return;
  }
  if (
    e.key === "Enter" &&
    e.target.closest(".object-hit") &&
    currentShape() &&
    e.target.closest(".object-hit").dataset.shapeId ===
      String(P.getShapeId(currentShape()))
  ) {
    e.preventDefault();
    editText(currentShape());
    return;
  }
  if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) &&
    currentShape() &&
    // The arrows move the object from the canvas or the page; on a control
    // elsewhere they have work of their own.
    (e.target === document.body || e.target.closest("#main"))
  ) {
    e.preventDefault();
    const ids = [...selectionIds()];
    const d = P.inches(e.shiftKey ? 0.1 : 0.01);
    const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
    const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
    mutateSlide(slide(), (target) => {
      const size = currentSize();
      // A grouped object whose group moves too moves with it, not on its own.
      const parents = groupParents(target);
      const chosen = new Set(ids);
      const carried = (id) => carriedByGroup(id, parents, chosen);
      const items = [];
      for (const id of ids) {
        if (carried(id)) continue;
        const obj = P.findShapeById(target, id);
        const b = obj && slideBounds(doc.pres, obj);
        if (b) items.push({ obj, b });
      }
      // The objects move as one: by the step, or by the room the one nearest
      // the slide's edge has left, so their arrangement holds.
      let stepX = dx,
        stepY = dy;
      for (const { b } of items) {
        const roomX = clampMovement(b.x + dx, b.x, size.cx - b.w) - b.x;
        const roomY = clampMovement(b.y + dy, b.y, size.cy - b.h) - b.y;
        if (Math.abs(roomX) < Math.abs(stepX)) stepX = roomX;
        if (Math.abs(roomY) < Math.abs(stepY)) stepY = roomY;
      }
      if (!items.length || (!stepX && !stepY)) return SKIP_MUTATION;
      for (const { obj, b } of items)
        setSlideBounds(doc.pres, obj, {
          ...b,
          x: b.x + stepX,
          y: b.y + stepY,
        });
    });
  }
});
window.addEventListener("beforeunload", (e) => {
  // The canvas text editor holds its text as content rather than a value,
  // and says itself whether that text has changed.
  const pendingInput = [
    ...document.querySelectorAll(
      '#speaker-notes, .inline-editor, #inspector textarea, #inspector input[type="number"]',
    ),
  ].some((input) =>
    input.isContentEditable
      ? richEditor?.input !== input || richEditor.dirty()
      : input.matches('input[type="number"]')
        ? input.valueAsNumber !== Number(input.defaultValue)
        : input.value !== input.defaultValue.replace(/\r\n?/g, "\n"),
  );
  if (
    doc &&
    (pendingInput ||
      pendingMutations > 0 ||
      (revision !== savedRevision &&
        revision !== draftRevision &&
        !untouchedLanding()))
  ) {
    e.preventDefault();
    e.returnValue = "";
  }
});
// A file held over the window is told what letting go will do, so the drop
// is never a guess. A drag withholds the file's name and bytes, but not its
// type, so the promise made here matches the drop below.
function dropPromise(transfer) {
  // A modal dialog or slideshow owns the screen and the drop is ignored
  // behind it, so promise nothing.
  if (document.querySelector("dialog[open]")) return null;
  const file = [...transfer.items].find((item) => item.kind === "file");
  return view === "editor" && doc && file?.type.startsWith("image/")
    ? "Drop to add the image to this slide"
    : "Drop to open a presentation";
}
const dropOverlay = document.querySelector("#drop-overlay");
let dropOverlayTimer;
function showDropPromise(promise) {
  dropOverlay.firstElementChild.textContent = promise;
  dropOverlay.classList.add("visible");
  // `dragover` repeats while the file stays over the window and stops once it
  // leaves, so the repeat keeps the overlay alive. Waiting on `dragleave`
  // instead would flicker as the drag crosses between elements, and would
  // strand the overlay whenever a leave went missing.
  clearTimeout(dropOverlayTimer);
  dropOverlayTimer = setTimeout(hideDropPromise, 500);
}
function hideDropPromise() {
  clearTimeout(dropOverlayTimer);
  dropOverlay.classList.remove("visible");
}
// Fields take dragged text and links as usual; dropped anywhere else they
// would navigate the tab away, so the page refuses them.
const inField = (target) =>
  target instanceof Element &&
  !!target.closest("input, textarea, [contenteditable]");
document.addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes("Files")) {
    if (!inField(e.target)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    }
    return;
  }
  e.preventDefault();
  const promise = dropPromise(e.dataTransfer);
  if (promise) showDropPromise(promise);
  else hideDropPromise();
});
document.addEventListener("drop", (e) => {
  hideDropPromise();
  // Files dragged in from the Puter desktop or one of its folder windows do
  // not come the browser's way: the SDK dispatches a drop of its own, with
  // the drive's entries in its detail and no dataTransfer.
  if (!e.dataTransfer) {
    if (!Array.isArray(e.detail?.items)) return;
    e.preventDefault();
    if (!document.querySelector("dialog[open]")) openDriveItems(e.detail.items);
    return;
  }
  const file = e.dataTransfer.files[0];
  if (!file) {
    if (!inField(e.target)) e.preventDefault();
    return;
  }
  e.preventDefault();
  // A modal dialog or slideshow owns the screen; do not open files behind it.
  if (document.querySelector("dialog[open]")) return;
  // Images dropped while editing belong on the current slide, and an
  // unsupported image format is reported as such rather than as a non-PPTX
  // file.
  if (view === "editor" && doc && file.type.startsWith("image/"))
    insertImageFile(file).catch(fail);
  else importFile(file).catch(fail);
});
// A bookmark or the address bar can ask for a screen too. Changing only the
// fragment does not reload the page, so the address is followed here the way
// a fresh load would: the library address opens the library, any other
// address opens a new presentation.
window.addEventListener(
  "hashchange",
  run(async () => {
    if (signingOut) return;
    if (location.hash === LIBRARY_HASH) {
      if (view === "home") return;
      if (await leaveEditor()) await home();
      else showEditorUrl();
    } else if (view === "home") {
      // Only the bare address asks for a new presentation; another fragment,
      // such as the skip link's, is the browser's to follow, after which the
      // library takes its own address back.
      if (location.hash.slice(1)) showLibraryUrl();
      else await newDeck("blank", "studio", null, { pristine: true });
    } else showEditorUrl();
  }),
);
window.addEventListener("online", () => {
  if (!doc) return;
  if (doc.saveError?.offline) doc.saveError = null;
  updateSaveStatus();
  if (doc.path && account && revision !== savedRevision && !doc.conflict)
    saveCloud(false).catch(fail);
});
window.addEventListener("offline", () => {
  if (!doc?.path || revision === savedRevision) return;
  doc.saveError = { message: "You are offline.", offline: true };
  updateSaveStatus();
});
// Files on the drive handed to the app by the Puter desktop: the one it was
// launched with (a double-click, "Open with"), or those dragged onto the
// window. A presentation opens where it lives, so its edits go back to it;
// an image goes on the current slide, as one dropped from the device does.
const DRIVE_IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
function openDriveItems(items) {
  const item = items.find((it) => it?.path && !cloud.isDirItem(it));
  if (!item) {
    toast(
      items.some(cloud.isDirItem)
        ? "A folder can't be opened. Choose a PowerPoint (.pptx) file."
        : "That item can't be opened. Choose a PowerPoint (.pptx) file.",
    );
    return;
  }
  const name = item.name || cloud.displayName(item.path);
  if (cloud.isPptxName(name)) {
    openCloud({ path: item.path, name, uid: item.uid }).catch(fail);
    return;
  }
  const type =
    DRIVE_IMAGE_TYPES[/\.([^.]+)$/.exec(name.toLowerCase())?.[1]] || null;
  if (type && view === "editor" && doc && !readOnlyDocument()) {
    const target = doc;
    cloud
      .readFile(item.path)
      .then((bytes) => {
        if (doc === target)
          return insertImageFile(new File([bytes], name, { type }));
      })
      .catch(fail);
    return;
  }
  toast(
    `“${name}” can't be opened here. Choose a PowerPoint (.pptx) file${view === "editor" ? " or an image" : ""}.`,
  );
}
// The presentation the app was launched with is the first screen, in place
// of a new one: a moment's "Opening…" rather than a blank deck that the file
// then replaces.
async function openLaunched(items) {
  const item = items.find(
    (it) =>
      it?.path && !cloud.isDirItem(it) && cloud.isPptxName(it.name || it.path),
  );
  if (!item) {
    openDriveItems(items);
    return newDeck("blank", "studio", null, { pristine: true });
  }
  const name = item.name || cloud.displayName(item.path);
  app.replaceChildren(
    el(
      "main",
      { id: "main", class: "opening-file", tabindex: -1 },
      el(
        "p",
        { role: "status" },
        el("span", { class: "opening-spinner" }, icon("LoaderCircle", 20)),
        `Opening “${cleanName(name)}”…`,
      ),
    ),
  );
  setTitle(cleanName(name));
  try {
    if (await openCloud({ path: item.path, name, uid: item.uid })) return;
  } catch (error) {
    fail(error);
  }
  // The file could not be opened: the library lists what can be.
  if (view !== "editor") {
    showLibraryUrl();
    setTitle(null);
    renderHome();
  }
}
// The Puter desktop window's close button waits for this. A presentation
// kept in Puter saves what autosave has not sent yet, and asks, as leaving it
// for the library does, when that save cannot go through; one never saved to
// Puter asks whether to save it, as a desktop app does. Without this the
// window went at once, leaving the edits to a recovery draft nobody was told
// about.
let closing = null;
function closeWindow() {
  if (closing) {
    // Pressed again while the way out is still saving, with no question up:
    // the draft holds the edits, so a save that will not finish cannot keep
    // the window open.
    if (!document.querySelector("dialog[open]") && draftRevision === revision)
      cloud.exitApp();
    return;
  }
  closing = readyToClose()
    .then(
      (ok) => ok && cloud.exitApp(),
      (error) => fail(error),
    )
    .finally(() => (closing = null));
}
async function readyToClose() {
  if (view !== "editor" || !doc || signingOut) return true;
  const target = doc;
  await settled();
  if (doc !== target) return false;
  if (!target.path && !untouchedLanding() && revision !== savedRevision) {
    if (revision !== draftRevision) await persistDraft().catch(() => {});
    if (doc !== target) return false;
    const kept = revision === draftRevision;
    const choice = await dialog({
      title: `Save “${target.name}” to Puter before closing?`,
      body: el(
        "p",
        { class: "dialog-body" },
        kept
          ? "If you don't save, your changes stay on this device and are listed under Your presentations."
          : "If you don't save, your changes are lost.",
      ),
      actions: [
        { label: "Cancel", value: "stay" },
        {
          label: "Don't save",
          value: "discard",
          kind: kept ? "secondary" : "danger",
        },
        { label: "Save", value: "save", kind: "primary" },
      ],
    });
    if (doc !== target) return false;
    if (choice === "discard") return true;
    if (choice !== "save") return false;
    if (!(await saveCloud(true))) return false;
  }
  return leaveEditor();
}
// What the app was launched with is handed over as soon as the handler is
// registered: before the first screen, so that screen can be the file.
let launchItems = null;
let booting = true;
cloud.onLaunch((items) => {
  if (booting) launchItems = items;
  else openDriveItems(items);
});
cloud.onWindowClose(closeWindow);
// The app opens into a new presentation without waiting for, or asking for,
// a sign-in; #/home opens the library instead. The account is looked up
// alongside and the header follows once it is known.
const initialAccountRequest = accountRequest;
const initialAccount = cloud.user();
if (launchItems) await openLaunched(launchItems).catch(fail);
else if (location.hash === LIBRARY_HASH) renderHome();
else
  await newDeck("blank", "studio", null, { pristine: true }).catch((error) => {
    fail(error);
    renderHome();
  });
booting = false;
// A lookup that hangs, as it can when the SDK cannot reach its service,
// would hold the library forever; the app carries on as a guest and takes
// the account if it arrives later.
const resolvedAccount = await Promise.race([
  initialAccount,
  new Promise((resolve) => setTimeout(() => resolve(undefined), 6000)),
]);
if (resolvedAccount === undefined)
  initialAccount.then((user) => user && adoptAccount(user)).catch(() => {});
if (accountRequest === initialAccountRequest) {
  setAccount(resolvedAccount ?? null);
  if (doc) {
    doc.owner = owner();
    if (doc.path) rememberOpened(doc);
    refreshAccountUi();
    await mutationTail;
    await persistDraft().catch(warnStorage);
  } else if (view === "home") {
    // A signed-in account changes the header and banner, so rebuild the
    // screen; a guest screen is already correct and only needs its library.
    if (account) await home(false, { focus: false });
    else await loadLibrary();
  }
}
// A sign-in tried while the lookup was still out takes the account over; one
// that came to nothing would otherwise leave the library waiting for an
// answer that has already arrived.
if (view === "home" && loading) await loadLibrary();
cloud.onAuth(adoptAccount);
