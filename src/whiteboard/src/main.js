import { CAP_CHOICES } from "./connector-caps.js";
import { fold, compareNames } from "./libraries.js";
import { wordContext } from "./search-fold.js";
import { shortcutLetter } from "./shortcut-keys.js";
import { createAttentionUI } from "./attention-ui.js";
import { createLiveUI } from "./live-ui.js";
import {
  PRECISE_SELECTION_KEY,
  readPreciseSelection,
  createMarqueeIndex,
  marqueeSelection,
} from "./marquee.js";
import {
  DIMENSIONS_STORAGE_KEY,
  readDimensions,
  createDimensionIndex,
  dimensionBadge,
  dimensionBounds,
} from "./dimensions.js";
import {
  GRID_STORAGE_KEY,
  readGrid,
  gridSettings as normalizeGrid,
  gridStep,
  snapGridPoint,
  snapGridMove,
} from "./grid.js";
import { createTimerUI } from "./timer-ui.js";
import { createFacilitationUI } from "./facilitation/ui.js";
import {
  portableWorkshop,
  adoptWorkshop,
  voteFollowingTimer,
  facilitatorTimer,
  contributionKey,
  workshopSettings,
} from "./facilitation/model.js";
import "./facilitation/facilitation.css";
import { timerRemaining } from "./timer.js";
import { tagFooter } from "./tags.js";
import { createTagsUI, taggable } from "./tags-ui.js";
import { autoLayoutMindMaps, preserveManualMindMoves } from "./mind-map.js";
import { createMindMapUI } from "./mind-map-ui.js";
import { createMindMapHandles } from "./mind-map-handles.js";
import { createMindView } from "./mind-view.js";
import { createMindCollapse } from "./mind-collapse.js";
import {
  createMindDrag,
  validMindDrag,
  mindDragCandidate,
  planMindReparent,
} from "./mind-map-drag.js";
import { textLinkURL } from "./text-link-data.js";
import { objectAddress, boardDestination } from "./object-link-data.js";
import { freeSpot } from "./placement.js";
import { createObjectLinks } from "./object-links.js";
import { createTableEditor } from "./table-editor.js";
import { tableCellAt } from "./table-cells.js";
import { tableHeight } from "./bulk-content.js";
import { tableLanguagePatch } from "./table-language.js";
import {
  sizedTableCells,
  grownTableRows,
  tableFontSize,
  tableTextAlign,
} from "./table-sizing.js";
import { createCommentsUI } from "./comments-ui.js";
import {
  objectRelationships,
  outlineOrder,
} from "./accessibility/object-relationships.js";
import { validateComments, updateCommentAnchors } from "./comments.js";
import {
  planDuplication,
  placeDuplicates,
  checkDuplicateGeometry,
} from "./duplication.js";
import {
  FONT_FAMILIES,
  fontFamily,
  validFontFamily,
  fontFamilyReady,
  loadFontFamily,
} from "./fonts.js";
import "./font-assets.js";
import {
  STYLE_STORAGE_KEY,
  copyObjectStyle,
  readObjectStyle,
  readLastStyle,
  LAST_STYLE_KEY,
  canCopyStyle,
  canPasteStyle,
  objectStylePatch,
  applyObjectStyle,
} from "./object-style.js";
import {
  FRAME_FORMATS,
  frameFormatById,
  frameFormatOf,
  nextSlideSpot,
} from "./frame-formats.js";
import {
  createTextLinkPreview,
  textLinkHit,
  textOffsetAt,
  wordAt,
} from "./text-links.js";
import {
  formatTextBlocks,
  indentTextBlocks,
  textParagraphs,
  spliceTextBlocks,
} from "./text-blocks.js";
import { createTextEditor } from "./text-editor.js";
import {
  TEXT_STYLE_KEYS,
  equalTextRuns,
  formatTextRuns,
  replaceTextRuns,
  textSegments,
  textDifference,
} from "./rich-text.js";
import { commandEntries, addCommands } from "./commands.js";
import { createCommandPalette } from "./command-palette.js";
import { createContextMenu, ALIGN_MENU } from "./context-menu.js";
import { installTooltips } from "./tooltips.js";
import { createBoardSearch, itemSearchText } from "./board-search.js";
import { createFramesPanel } from "./frames-panel.js";
import { createImageCropUI } from "./image-crop-ui.js";
import { createImageReplacement } from "./image-replace-ui.js";
import { createMinimap } from "./minimap-ui.js";
import {
  createCanvasNavigation,
  DOUBLE_CLICK_MS,
  pointerFocus,
  keyboardFocus,
  busiestPart,
} from "./navigation.js";
import { createResizePlan, resizeLimits, applyResize } from "./resize.js";
import {
  rotationOf,
  worldPoint,
  rotatePoint,
  setObjectHeight,
  objectBounds,
} from "./geometry.js";
import {
  rotationBox,
  rotationHit,
  createRotationPlan,
  rotationDelta,
  applyRotation,
  rotationSignature,
} from "./rotation.js";
import { createSnapIndex, snapMove, snapResize } from "./snapping.js";
import { hasLocked as objectLocked, setLocked } from "./locking.js";
import {
  createIcons,
  Bold,
  Italic,
  Link,
  RefreshCw,
  Settings2,
  LogIn,
  LogOut,
  Underline,
  Strikethrough,
  SlidersHorizontal,
  Scaling,
  RotateCw,
  Check,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUpRight,
  BringToFront,
  SendToBack,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  ClipboardPaste,
  CopyPlus,
  Scissors,
  Ungroup,
  Circle,
  CircleHelp,
  Command,
  Cloud,
  CloudCheck,
  CloudUpload,
  Columns3,
  HardDrive,
  Copy,
  CopyCheck,
  PaintRoller,
  Crop,
  Download,
  LayoutGrid,
  ALargeSmall,
  Ellipsis,
  Eraser,
  EyeOff,
  FileJson,
  ListFilter,
  Hand,
  Image,
  ImagePlus,
  Layers,
  LayoutDashboard,
  Lightbulb,
  List,
  ListOrdered,
  IndentIncrease,
  IndentDecrease,
  LockKeyhole,
  Unlock,
  Maximize,
  MessageSquare,
  Magnet,
  Map as MapIcon,
  Minus,
  MousePointer2,
  MoveUpRight,
  Network,
  GitBranchPlus,
  GitPullRequestArrow,
  ListPlus,
  Pencil,
  PencilRuler,
  Plus,
  Presentation,
  Redo2,
  Scan,
  Search,
  Shapes,
  SmilePlus,
  Sparkles,
  Square,
  Star,
  StickyNote,
  Tags,
  Timer,
  Group,
  SunMoon,
  Trash2,
  Type,
  Undo2,
  Upload,
  UserRound,
  Users,
  Vote,
  X,
  LayoutTemplate,
  CirclePlus,
  Table,
  Paperclip,
  AppWindow,
  Component,
  SquareCheck,
  SquareDashed,
} from "lucide";
// A web page embedded on a board can redirect to this app's own address,
// which would run the app inside the board with that page's access to it,
// so the app does not start inside its own embeds.
let ownEmbed = false;
try {
  ownEmbed = !!window.frameElement?.closest?.(".embed-layer");
} catch {}
if (ownEmbed) throw Error("Whiteboard does not run inside its own embeds.");
const icons = {
  ...EXTRA_ICONS,
  SquareDashed,
  LayoutTemplate,
  CirclePlus,
  Table,
  Paperclip,
  AppWindow,
  Component,
  SquareCheck,
  ListFilter,
  Bold,
  Italic,
  Link,
  RefreshCw,
  Settings2,
  LogIn,
  LogOut,
  Underline,
  Strikethrough,
  SlidersHorizontal,
  Scaling,
  RotateCw,
  Check,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUpRight,
  BringToFront,
  SendToBack,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  ClipboardPaste,
  CopyPlus,
  Scissors,
  Ungroup,
  Circle,
  CircleHelp,
  Command,
  Cloud,
  CloudCheck,
  CloudUpload,
  Columns3,
  HardDrive,
  Copy,
  CopyCheck,
  PaintRoller,
  Crop,
  Download,
  LayoutGrid,
  ALargeSmall,
  Ellipsis,
  Eraser,
  EyeOff,
  FileJson,
  Hand,
  Image,
  ImagePlus,
  Layers,
  LayoutDashboard,
  Lightbulb,
  List,
  ListOrdered,
  IndentIncrease,
  IndentDecrease,
  LockKeyhole,
  Unlock,
  Maximize,
  MessageSquare,
  Magnet,
  Map: MapIcon,
  Minus,
  MousePointer2,
  MoveUpRight,
  Network,
  GitBranchPlus,
  GitPullRequestArrow,
  ListPlus,
  Pencil,
  PencilRuler,
  Plus,
  Presentation,
  Redo2,
  Scan,
  Search,
  Shapes,
  SmilePlus,
  Sparkles,
  Square,
  Star,
  StickyNote,
  Tags,
  Timer,
  Group,
  SunMoon,
  Trash2,
  Type,
  Undo2,
  Upload,
  UserRound,
  Users,
  Vote,
  X,
};
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/dm-sans/latin-400-italic.css";
import "@fontsource/dm-sans/latin-600-italic.css";
import {
  connectorEndpointHit,
  setConnectorEnd,
  connectorLabel,
} from "./connectors.js";
import {
  canEditText,
  textStyle,
  shapeTextLayout,
  boxedText,
  textValign,
  canAutoFitText,
  fitTextLayout,
  cachedFitTextLayout,
  growsWithText,
  autoHeightLayout,
  cachedAutoHeightLayout,
  reflowTextItems,
  TABLE_TEXT_KEYS,
} from "./text.js";
import { CUSTOM_SHAPES, canSwitchShape, shapeDefaults } from "./shapes.js";
import { hasBorder } from "./shape-specs.js";
import { canQuickConnect, quickConnectPlan } from "./quick-connect.js";
import { createQuickConnectUI } from "./quick-connect-ui.js";
import {
  board,
  item,
  uid,
  clone,
  sharedCopy,
  undoCopy,
  keepUnchanged,
  startDrawing,
  escape,
  COLORS,
  History,
  bounds,
  zoomAt,
  zoomStep,
  MIN_ZOOM,
  DETAIL_ZOOM,
  validateBoard,
  extendDrawing,
  assertImagePixels,
  hitTest,
  selectedAt,
  resizeHit,
  resizeHandleAt,
  RESIZE_HANDLES,
  resizeBounds,
  truncate,
  MAX_OBJECTS,
} from "./model.js";
import { local, CloudStore } from "./storage.js";
import { CollaborationSession } from "./collaboration/session.js";
import { SharedDocument, rebase } from "./collaboration/document.js";
import {
  ASSET,
  canEditContent,
  canManage,
  encode,
  parseLink,
  shareLink,
  workerURL,
} from "./collaboration/protocol.js";
import {
  call as collaborationCall,
  deploy,
  refreshDeployment,
} from "./collaboration/api.js";
import {
  createOrganization,
  readOrganizationLink,
} from "./organization/client.js";
import "./organization/admin-strings.js";
import "./worker-strings.js";
import { createOrganizationHome } from "./organization/home-ui.js";
import { createOrganizationLibrary } from "./organization/library-ui.js";
import {
  createBoardAccess,
  assignableRoles,
  sectionLink,
  ROLE_LABELS,
} from "./organization/board-access.js";
import "./organization/organization.css";
import { EXTRA_ICONS } from "./extra-icons.js";
import { createAI } from "./ai/ai-ui.js";
import { createAccountUI } from "./account-ui.js";
import { createOnboarding } from "./help/onboarding.js";
import { createHelpCenter } from "./help/help-center.js";
import { createAltText } from "./accessibility/alt-text.js";
import { canonicalLanguage } from "./accessibility/language-tag.js";
import {
  authoredTextHTML,
  objectNameHTML,
  languageAttribute,
} from "./accessibility/object-content.js";
import { createPlanning } from "./planning/index.js";
import "./planning/planning.css";
import {
  PresenceLayer,
  color as participantColor,
} from "./collaboration/presence.js";
import { bindText } from "./collaboration/text-binding.js";
import {
  paint,
  paintPreviews,
  holdPreviews,
  refreshTextLayouts,
  exportPNG,
  preview,
  frameLabelAt,
  shownFrameLabels,
} from "./render.js";
import { track } from "./analytics.js";
import "./style.css";
import {
  descendants,
  selectionGroupId,
  isConnector,
  movesWith,
  unlockedSelection,
  inferParents,
  inferMovedParents,
  updateConnectors,
  removeItems,
  moveItems,
  reorderItems,
  group,
  isWholeGroup,
  ungroup,
  nextFrameOrder,
  nextFrameTitle,
  orderedFrames,
  layoutUnits,
} from "./scene.js";
import { TEMPLATE_CATALOG, fromTemplate } from "./templates.js";
import {
  language,
  setLanguage,
  t,
  translateUI,
  objectName,
  kindLabel,
  editTitle,
  plural,
  labelled,
} from "./i18n.js";
import { createFeatures } from "./features.js";
import {
  createTransfer,
  textObject,
  decodeImage,
  IMAGE_ACCEPT,
} from "./transfer.js";
import { createBulkContent } from "./bulk-content.js";
import { createImageClipboard } from "./image-clipboard.js";
import { createContentTools } from "./content/content.js";
import { loadPdfjs } from "./content/pdf-loader.js";
import { busy } from "./accessibility/busy.js";
import "./content/content.css";
import {
  canClearContent,
  hasClearableContent,
  clearContent,
} from "./clear-content.js";
const app = document.querySelector("#app");
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const button = (name, label, action, extra = "") =>
  `<button class="icon-btn" aria-label="${label}" title="${label}" data-action="${action}" ${extra}>${icon(name)}</button>`;
const brandImage = `<img src="/icons/icon-64.png" srcset="/icons/icon-128.png 2x" width="33" height="33" alt="" draggable="false">`;
const logo = `<span class="brand-mark">${brandImage}</span><span>whiteboard<span class="brand-dot">.</span></span>`;
let boards = [],
  current = null,
  history = new History(),
  selection = new Set(),
  selectionAnchor = null,
  focusedGroup = null,
  tool = "select",
  view = { x: 90, y: 75, z: 1 },
  filter = "all",
  search = "",
  librarySort = "recent",
  cloud = null,
  cloudIds = new Set(),
  // Boards the signed-in account keeps in its Puter drive, by the index
  // read at sign-in; the library marks them.
  cloudIndex = new Set(),
  cloudTitles = new Map(),
  // Boards in Puter opened from this device's copy, by the copy's time: the
  // first upload of the visit checks that Puter holds nothing newer.
  cloudUnverified = new Map(),
  // Cloud boards with edits awaiting upload, by the time of the latest.
  pendingCloud = new Map(),
  // Personal boards whose latest edits could not be saved on this device,
  // as when storage is full; closing the tab then asks first.
  unsavedLocal = new Set(),
  cloudTimer,
  saveChain = Promise.resolve(),
  // Recovery versions are written apart from boards: a board write queued
  // behind a version write would only start after it, which a closing tab
  // may not wait for.
  revisionChain = Promise.resolve(),
  // See keepRefusedEdits.
  refusedVersion = null,
  // See storeShared.
  queuedShared = null,
  space = false,
  drag = null,
  lastTap = null,
  theme = "system",
  characterShortcuts = true,
  snapping = true,
  // Whether shared sticky notes show who added them, on this device.
  showAuthors = false,
  boardGrid = readGrid(null),
  showDimensions = false,
  preciseSelection = false,
  exportRegion = null,
  editing = null;
// The kind of pointer last used on the board, which handles suit.
let lastPointerType = "mouse";
let hoveredMind = null,
  // The object a click would select under a resting pointer, outlined.
  hovered = null;
// The last arrow-key move or resize, which a held key continues.
let nudge = null;
// A held key makes the same change to the same objects as one undo step, so
// it cannot fill the undo history or push out recovery versions. Anything
// undone or changed since ends the step.
function heldKeyChange(e, kind, change) {
  const ids = [...selection].sort().join(),
    continues =
      e.repeat &&
      nudge?.kind === kind &&
      nudge.ids === ids &&
      nudge.board === current &&
      nudge.items === current.items &&
      (collaboration || nudge.step === history.past.at(-1));
  mutate(change, { continues });
  nudge = {
    kind,
    ids,
    board: current,
    items: current.items,
    step: history.past.at(-1),
  };
}
const mindView = createMindView({
  board: () => current,
  readOnly: isSharedReadOnly,
  editing: () => editing?.item.id,
  persist: (fn) => mutate(fn, { mindLayout: true }),
  redraw: () => {
    minimap.invalidate();
    draw();
  },
});
// Staged frames and private notes stay hidden in every view of the board.
const visibleItems = () => facilitation.visible(mindView.scene().visible);
const visualBoard = () =>
  current && facilitation.masked({ ...current, items: mindView.scene().items });
let copiedStyle = null;
try {
  copiedStyle = readObjectStyle(localStorage.getItem(STYLE_STORAGE_KEY));
} catch {}
// The colour of the last sticky note or shape restyled, and the look of the
// last line, which new ones take, as in Miro.
let lastStyle = {};
try {
  lastStyle = readLastStyle(localStorage.getItem(LAST_STYLE_KEY));
} catch {}
function rememberStyle(type, patch) {
  lastStyle = readLastStyle(
    JSON.stringify({ ...lastStyle, [type]: { ...lastStyle[type], ...patch } }),
  );
  try {
    localStorage.setItem(LAST_STYLE_KEY, JSON.stringify(lastStyle));
  } catch {}
}
// Shared boards left with edits not yet sent, by room.
const unsentBoards = new Map();
// Where the library was scrolled when a board was opened from it.
let libraryReturn = null;
// Invitation links already made in a shared session, by access chosen.
const boardInvitations = new WeakMap();
// Where each shared board's session keeps its rows on this device.
const collaborationScopes = new WeakMap();
let collaboration = null,
  // Counts connection attempts, so an earlier one still connecting, as
  // after reopening the board meanwhile, stops instead of running as well.
  collaborationAttempt = 0,
  collaborationBusy = false,
  collaborationRendered = null,
  collaborationLastSaved = null,
  collaborationEdits = Promise.resolve(),
  presenceLayer = null,
  // The selection and edited object last sent to the others.
  presenceSelection = "",
  // Collaborators' live preview of each object, reused between draws.
  previewCopies = new WeakMap(),
  // Counts changes to the board's content, as against its view: what the
  // screen reader outline shows is made again only when it moves on.
  contentVersion = 0,
  // Counts formatting choices, undos and redos, so a font family applied
  // once it has loaded gives way to anything chosen or undone meanwhile.
  formatRequests = 0,
  collaborationPeople = new Map(),
  collaborationRoster = [],
  collaborationCursor = null,
  collaborationPendingEdits = 0,
  collaborationFrame = null,
  collaborationHadPreview = false,
  // Who was on the board when the facilitation panel last heard of it.
  collaborationRosterSeen = null,
  collaborationRosterSignature = "";
const attention = createAttentionUI({
  session: () => collaboration,
  canBring: () => !facilitation.boardLocked(),
  canManage: () => canManage(collaboration?.role || ""),
  anonymous: () => !!workshopSettings(current).anonymous,
  lowerHand: (sessions) => lowerHands(sessions),
  handsChanged: (list) => {
    liveUI.hands(list);
    facilitation.handsChanged();
    renderParticipants();
  },
  view: () => view,
  size: () => {
    const r = document.querySelector("#canvas")?.getBoundingClientRect();
    return { width: r?.width || 800, height: r?.height || 600 };
  },
  busy: () =>
    !!(
      editing ||
      drag ||
      imageCrop.id() ||
      tableEditor.isOpen() ||
      document.querySelector("dialog[open]") ||
      document.activeElement?.closest("input,textarea,select,[contenteditable]")
    ),
  prepare: () => {
    canvasNavigation.finish();
    pointerUp();
    finishTextEdit();
  },
  navigate: (next) => {
    view = next;
    draw();
  },
  focusCanvas: () => document.querySelector("#canvas")?.focus(),
  redrawCursors: () => draw(),
  paintSlide: (canvas, camera, slide) =>
    features.followSlide(canvas, camera, slide),
  toast,
});
// Live reactions on a shared board: the control in the navigation row, its
// popover, and the reactions floating up the board.
const liveUI = createLiveUI({
  session: () => collaboration,
  shared: () => !!current?.shared,
  anonymous: () => !!workshopSettings(current).anonymous,
  canManage: () => canManage(collaboration?.role || ""),
  handChanged: () => attention.refresh(),
  reducedMotion: () =>
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  announce,
  refreshIcons: () => iconsRefresh(),
});
// Lowers raised hands, from Participants or the People tab: "all", or the
// sessions of one person, which may be this person's own. Only owners and
// facilitators lower others' hands, which the others' clients check too.
async function lowerHands(sessions) {
  const session = collaboration;
  if (!session) return;
  const targets = sessions === "all" ? ["all"] : sessions.split(" ");
  const own = targets.includes(session.session);
  await Promise.all(targets.map((id) => session.lowerHand(id)));
  if (collaboration !== session) return;
  if (own) announce(t("Your hand is lowered."));
  else if (!session.linked())
    toast("A live connection is needed to lower raised hands.");
  liveUI.render();
  attention.refresh();
}
// Why this person cannot change the board timer while a facilitator's
// activity runs on it, or null.
const timerRefusal = (timer) =>
  canManage(collaboration?.role || "owner")
    ? null
    : facilitatorTimer(
        current?.workshop,
        timer,
        collaboration?.now() ?? Date.now(),
      );
const workshopTimer = createTimerUI({
  board: () => current,
  now: () => collaboration?.now() ?? Date.now(),
  // Participants of a locked board follow the facilitator's timer, as they
  // do while it counts a running agenda step or a timed vote.
  canEdit: () =>
    !!current &&
    !isSharedReadOnly() &&
    !facilitation.boardLocked() &&
    !timerRefusal(current.timer),
  ready: () => !collaborationBusy,
  save: (timer) => {
    if (!current || isSharedReadOnly()) return;
    const refused = timerRefusal(current.timer) || timerRefusal(timer);
    if (refused) throw Error(refused);
    // A vote timed by this timer keeps to it, in the same save.
    const vote = voteFollowingTimer(current.workshop?.vote, timer);
    if (vote) {
      if (!canManage(collaboration?.role || "owner") || isCommentReadOnly())
        throw Error(
          "Only the owner or a facilitator can change the time left to vote.",
        );
      current.workshop = { ...current.workshop, vote };
    }
    current.timer = timer;
    save();
    // The voting banner shows the new time at once.
    if (vote) draw();
  },
  // The side panels that take the timer's place on a phone.
  uncover: () => {
    comments.close(false);
    tags.close();
    objectLinks.close();
    planning.close();
    boardSearch.close(false);
    framesPanel.close(false);
  },
  layout: reflowSelectionTools,
  toast,
});
const facilitation = createFacilitationUI({
  board: () => current,
  editing: () => !!editing,
  identity: () =>
    collaboration
      ? {
          id: collaboration.user.uuid,
          name: collaboration.user.username || "Member",
        }
      : { id: commentIdentity, name: "Local author" },
  role: () => collaboration?.role || "owner",
  canParticipate: () => !!current && !isCommentReadOnly(),
  managesAccess: () => managesBoard(collaboration),
  // The most a guest may be given on this board.
  guestRole: () => boardAccess.sharing(collaboration?.sharing).guestRole,
  canEdit: () => !!current && !isSharedReadOnly(),
  now: () => collaboration?.now() ?? Date.now(),
  view: () => view,
  canvas: () => document.querySelector("#canvas"),
  hidden: () => mindView.scene().hidden,
  selection: () => selection,
  select: (ids) => {
    setTool("select");
    selectItems(ids);
    draw();
  },
  commit: (workshop) => {
    if (!current || isCommentReadOnly()) return toast(sharedReadOnlyReason());
    if (workshop) current.workshop = workshop;
    else delete current.workshop;
    save();
    draw();
  },
  setTimer: (timer) => {
    if (!current || isSharedReadOnly()) return;
    current.timer = timer;
    save();
    draw();
  },
  focusFrame: (frame) => focusRegion(bounds([frame])),
  bring: () => collaboration && attention.bring("all"),
  follow: (session) => collaboration && attention.bring(session),
  hands: () => attention.hands(),
  lowerHand: (sessions) => lowerHands(sessions),
  session: () => collaboration,
  roster: () => collaborationRoster,
  prepare: () => {
    objectLinks.close();
    comments.close(false);
    boardSearch.close(false);
    framesPanel.close(false);
    tags.close();
    planning.close();
  },
  refreshIcons: () => iconsRefresh(),
  layout: reflowSelectionTools,
  // A change the workshop refused was undone; show the board as saved.
  draw: () => {
    const title = document.querySelector("#board-title");
    if (current && title) {
      title.value = current.title;
      showBoardTitle(current.title);
    }
    draw();
  },
  icon,
  toast,
  download,
});
const features = createFeatures({
  board: () => current,
  // Viewers and commenters browse history and open copies; restoring is
  // an edit.
  readOnly: isSharedReadOnly,
  canImportFile: (i) => contentTools.canImport(i),
  importAttachment: (i) => contentTools.importAttachment(i),
  visualBoard,
  objectURL: (id, target = current) => objectAddress(target, id, location.href),
  selection: () => selection,
  selectionOptions,
  focusedGroup: () => focusedGroup,
  select: selectItems,
  region: () => exportRegion,
  clearRegion: clearExportRegion,
  exactRegion: exactRegionDialog,
  canEdit: canEditSelection,
  // Why a facilitator's lock keeps this person from adding or switching
  // shapes, or null.
  boardLocked: () =>
    facilitation.frozen() ||
    (facilitation.boardLocked()
      ? "While the board is locked, you can only add sticky notes."
      : null),
  unlockAll,
  copyImage: () => imageClipboard.copy(),
  copyStyle,
  pasteStyle,
  clearContent: clearSelectionContent,
  moveSelection: moveSelectionDialog,
  replaceImage: () => imageReplacement.open(),
  bulkNotes: () => bulkContent.open(),
  commands: () => commandPalette.open(),
  mindMap: () => mindMap.create(),
  minimap: () => minimap.toggle(),
  timer: () => workshopTimer.open(),
  facilitation: () => facilitation.toggle(),
  portable: (exported) => facilitation.portable(exported),
  includeSharedMedia: (copy) => includeSharedMedia(copy),
  portableCopy: (copy) => facilitation.portableCopy(copy),
  runsWorkshop: () => facilitation.canHide(),
  concealedIn: (b) => facilitation.concealedIn(b),
  hiddenFromParticipants: (id) => facilitation.hiddenFromParticipants(id),
  presentTimer: (dialog) => workshopTimer.present(dialog),
  presentAttention: (dialog, rect, slide) =>
    attention.present(dialog, rect, slide),
  navigation: () => navigationSettings(),
  grid: () => openGridSettings(),
  dimensions: () => openDimensionSettings(),
  selectionSettings: () => openSelectionSettings(),
  placeItems: gridPlaceItems,
  addShape,
  mutate,
  draw,
  save,
  modal,
  toast,
  download,
  center,
  viewCenter,
  viewBounds,
  openSpot: (p, size) => openSpot("object", p, size),
  fileInput,
  local,
  help,
  // Guides are reached from the board too, where people invited by link
  // first arrive.
  helpCenter: () => helpCenter.open(),
  notificationsAvailable: () => organizationHome.available(),
  notifications: () => organizationHome.notifications(),
  setTool,
  focusRegion,
  focusClusters: (box) => focusRegion(box, undefined, true),
  addSlideFrame,
  frames: () => framesPanel.toggle(),
  // A participant of a locked board adds sticky notes only.
  canAddFrames: () => !isSharedReadOnly() && !facilitation.boardLocked(),
  waitForSaves: () => Promise.all([saveChain, revisionChain]),
  refresh: iconsRefresh,
  // Shared boards record exports in the organization's audit log.
  exported: (format, scope) => {
    track("Board exported", { format, scope });
    collaboration?.request("export", { format, scope }).catch(() => {});
  },
  sharedHistory: () => {
    if (!collaboration) return collaboration;
    // Where each page of versions ended, so the worker reads the next page
    // from there rather than from the newest edit (see history.list).
    const ends = new Map();
    return {
      list: async (before) => {
        const page = await collaboration.request(
          "history.list",
          before === undefined
            ? {}
            : { before, ...(ends.has(before) && { cursor: ends.get(before) }) },
        );
        const last = page?.versions?.at?.(-1)?.at;
        if (typeof page?.next === "string" && last !== undefined)
          ends.set(last, page.next);
        return page;
      },
      load: (at) => collaboration.versionBoard(at),
      // `{ items, tags }` added or there at `after` and removed by `at`.
      removed: (at, after) => collaboration.removedObjects(at, after),
      note: (details) =>
        collaboration.request("history.restored", details).catch(() => {}),
    };
  },
  replaceItems: (items) =>
    mutate(() => {
      current.items = validateBoard({ ...current, items }).items;
      selection.clear();
    }),
  restore: (b) => {
    // Throw so the caller cannot report a restoration that did not happen.
    if (isSharedReadOnly()) throw Error("This board is read-only.");
    const { items } = validateBoard(b);
    // One step, like any other edit: Undo takes the board back to what it
    // was, and the steps before it stay.
    mutate(
      () => {
        current.title = b.title;
        current.items = items;
        if (b.tags?.length) current.tags = clone(b.tags);
        else delete current.tags;
        selection.clear();
      },
      // The version's mind maps keep their own layout settings, rather than
      // being read as moved by hand from where they are now.
      { titled: true, mindLayout: true },
    );
    const title = document.querySelector("#board-title");
    if (title && document.activeElement !== title) title.value = current.title;
    showBoardTitle(current.title);
    fit();
  },
  addBoard: adoptBoard,
  undo: () => action("undo"),
});
const transfer = createTransfer({
  board: () => current,
  objectURL: (id, target = current) => objectAddress(target, id, location.href),
  selection: () => selection,
  selectionOptions,
  select: selectItems,
  mutate,
  toast,
  center,
  pastePoint: (box) => {
    const c = viewCenter();
    return { x: c.x - box.w / 2, y: c.y - box.h / 2 };
  },
  point: canvasPoint,
  placeItems: gridPlaceItems,
  finishEditing: finishTextEdit,
  canAdd: () => canEditSelection(new Set()),
  canDrop: () => !isSharedReadOnly(),
  canCut: (ids) => canEditSelection(ids, { deleting: true }),
  concealed: () => facilitation.concealedIds(),
  pasteCells: (...args) => bulkContent.open(...args),
  receiveText: (...args) => contentTools.receiveText(...args),
  receiveFiles: (...args) => contentTools.receiveFiles(...args),
});
const bulkContent = createBulkContent({
  board: () => current,
  center,
  modal,
  canAdd: () => canEditSelection(new Set()),
  insert: (...args) => transfer.insert(...args),
  textObject,
});
// Embeds, Google Workspace imports, and document import (src/content/).
const contentTools = createContentTools({
  board: () => current,
  selection: () => selection,
  view: () => view,
  readOnly: isSharedReadOnly,
  busy: () => !!(editing || drag || imageCrop.id() || tableEditor.isOpen()),
  // Collapsed mind-map branches and workshop content hidden from this
  // person never show live.
  hidden: (id) =>
    mindView.scene().hidden.has(id) || facilitation.concealedIds().has(id),
  canAdd: () => canEditSelection(new Set()),
  canEdit: canEditSelection,
  allows: (feature) => organization.allows(feature),
  // What a shared board's organization allows, for guests too.
  boardAllows: (feature) =>
    collaboration?.features?.integrations?.[feature] !== false,
  insert: (...args) => transfer.insert(...args),
  measure: () => document.createElement("canvas").getContext("2d"),
  focus: (frames) => frames.length && focusRegion(bounds(frames)),
  action: (name) => action(name),
  loadPdfjs,
  // Images whose size is not in their first bytes are measured by the
  // browser.
  decodeImage,
  mutate,
  toast,
  modal,
  viewCenter,
  openSpot: (p, size) => openSpot("object", p, size),
  fileInput,
});
Object.assign(features.actions, contentTools.actions);
const imageClipboard = createImageClipboard({
  board: () => current,
  visualBoard,
  selection: () => selection,
  selectionOptions,
  modal,
  toast,
  download,
});
const boardSearch = createBoardSearch({
  board: () => facilitation.masked(current),
  draw,
  // The matched object itself is selected, inside its group if it has one,
  // ready to be edited as it was found.
  select: (ids) => {
    setTool("select");
    selectItems(ids, { withinGroup: true });
  },
  icon,
  reveal: (id) => mindView.preview(id),
  focus: (box, panel) => focusRegion(box, panel),
  hold: () => {
    heldSelection = { board: current, ids: selection, group: focusedGroup };
    selection = new Set();
    focusedGroup = null;
  },
  release: (chosen) => {
    // Branches opened to show results close again; a result selected on
    // the board stays shown, as selecting it anywhere does.
    mindView.endPreview();
    if (chosen) mindView.reveal(chosen);
    const held = heldSelection;
    heldSelection = null;
    // Back as it was, less what was deleted meanwhile, unless a result was
    // selected or the board was left.
    if (chosen || !held || held.board !== current || selection.size) return;
    const ids = new Set(current.items.map((i) => i.id));
    selection = new Set([...held.ids].filter((id) => ids.has(id)));
    // The next draw lets the group go if none of its members is left.
    focusedGroup = held.group;
  },
});
// What was selected when Find opened, kept until it closes.
let heldSelection = null;
// Frames and navigation, a side panel that stays open while going from
// frame to frame.
const framesPanel = createFramesPanel({
  board: () => current,
  visualBoard,
  // Bumped by every edit, undo and collaborator's change.
  version: () => contentVersion,
  concealedIn: (b) => facilitation.concealedIn(b),
  canEdit: canEditSelection,
  // A participant of a locked board adds sticky notes only.
  canAddFrames: () => !isSharedReadOnly() && !facilitation.boardLocked(),
  // Reordering frames is an edit, which a facilitator's lock also stops.
  canArrange: () => !isSharedReadOnly() && !facilitation.boardLocked(),
  addFrame: addSlideFrame,
  // The frame is framed beside the panel, or below it on a phone, as a step
  // Back undoes.
  go: (frame, panel) => {
    pushObjectAddress(frame.id);
    focusRegion(bounds([frame]), panel, true);
  },
  present: () => features.actions.present(),
  copyLink: (frame) => objectLinks.copy(frame),
  announce,
  view: viewBounds,
  canvas: () => document.querySelector("#canvas"),
  // Side panels share the right edge; one opening closes the others.
  prepare: () => {
    finishTextEdit();
    objectLinks.close();
    comments.close(false);
    tags.close();
    planning.close();
    facilitation.close(false);
    boardSearch.close(false);
  },
  mutate,
  toast,
  refreshIcons: () => iconsRefresh(),
  layout: reflowSelectionTools,
});
const tags = createTagsUI({
  board: () => current,
  selection: () => selection,
  canvas: () => document.querySelector("#canvas"),
  canEdit: (ids) =>
    !!current && !isSharedReadOnly() && !hasLocked(current.items, ids),
  concealed: () => facilitation.concealedIds(),
  mutate,
  draw,
  toast,
  prepare: () => {
    finishTextEdit();
    tableEditor.close();
    objectLinks.close();
    comments.close(false);
    boardSearch.close(false);
    framesPanel.close(false);
    planning.close();
    facilitation.close(false);
    imageCrop.close(false);
    imageReplacement.close();
  },
  find: (tagId) => boardSearch.open({ tagId }),
  layout: reflowSelectionTools,
});
let commentIdentity,
  boardMembers = [],
  // On a board shared with the whole organization, its members who have
  // not opened it yet, whom a comment can mention too.
  boardColleagues = [];
try {
  commentIdentity = localStorage.getItem("whiteboard-comment-author");
} catch {}
if (!commentIdentity || !/^device:[\da-f-]{36}$/.test(commentIdentity)) {
  commentIdentity = `device:${uid()}`;
  try {
    localStorage.setItem("whiteboard-comment-author", commentIdentity);
  } catch {}
}
const comments = createCommentsUI({
  state: () => ({
    board: current,
    view,
    selection,
    // Pins on hidden content would show where it is.
    hidden: hiddenFromView(),
    concealed: facilitation.concealedIds(),
    readOnly: isCommentReadOnly(),
    author: collaboration
      ? {
          id: collaboration.user.uuid,
          name: collaboration.user.username || "Member",
        }
      : { id: commentIdentity, name: "Local author" },
  }),
  canvas: () => document.querySelector("#canvas"),
  now: () => collaboration?.now() ?? Date.now(),
  icon,
  draw,
  toast,
  prepare: () => {
    refreshBoardMembers();
    objectLinks.close();
    facilitation.close(false);
    canvasNavigation.finish();
    pointerUp();
    finishTextEdit();
    boardSearch.close(false);
    framesPanel.close(false);
    imageCrop.close(false);
    imageReplacement.close();
    // The task panel sits where the comments panel opens.
    planning.close();
  },
  add: () => addComment(),
  // Board members, people present and, on a board the whole organization
  // can open, its other members can be mentioned with @name.
  people: () =>
    [
      ...boardMembers
        .filter((m) => m.role !== "removed" && !m.inactive)
        .map((m) => ({ id: m.uuid, name: m.username })),
      ...collaborationRoster.map((p) => ({ id: p.user, name: p.username })),
      ...boardColleagues.map((p) => ({ id: p.uuid, name: p.username })),
    ].filter((p) => p.id !== collaboration?.user?.uuid),
  reactions: (thread, message) =>
    facilitation.commentReactions(thread, message),
  anchor: (p) => hitTest(visibleItems(), p, 8 / view.z),
  reveal: (id) => mindView.reveal(id),
  focus: (p, panel) => {
    // Opening a discussion moves the view, so it stops following, as other
    // panel navigation does; otherwise the leader's next move undoes it.
    attention.stop();
    const r = document.querySelector("#canvas").getBoundingClientRect(),
      box = panel.getBoundingClientRect();
    const width =
      r.width > 760 ? Math.max(160, r.width - box.width - 32) : r.width;
    // On a phone the panel spans the top of the canvas, so the pin is shown
    // in the room between it and the tool rail and zoom controls at the
    // bottom, as Find on board shows its matches below it. With too little
    // room there, it is centred as if the panel were closed.
    let middle = r.height / 2;
    if (r.width <= 760) {
      const above = box.bottom - r.top,
        below = [
          ...document.querySelectorAll(
            ".canvas-wrap .left-rail > .panel, .canvas-wrap .zoom-tools",
          ),
        ]
          .map((el) => el.getBoundingClientRect())
          .filter((b) => b.height && b.top > r.top + r.height / 2)
          .reduce((end, b) => Math.min(end, b.top - r.top), r.height);
      if (below - above >= 60) middle = (above + below) / 2;
    }
    view.x = width / 2 - p.x * view.z;
    view.y = middle - p.y * view.z;
    draw();
  },
  save: (value) => {
    if (isCommentReadOnly()) return toast(sharedReadOnlyReason());
    validateComments(value);
    current.comments = value;
    save();
    draw();
  },
});
const organization = createOrganization({
  puter: () => window.puter,
  call: collaborationCall,
  deploy,
  refreshDeployment,
});
// The Miro migration and the administration console load when first opened.
// A failed load is retried the next time.
function lazily(load) {
  let pending;
  return () =>
    (pending ??= load().catch(() => {
      pending = null;
      throw Error(
        t("This feature could not load. Check your connection and try again."),
      );
    }));
}
const migrationHost = lazily(() =>
  import("./migration/host.js").then(({ createMigrationHost }) =>
    createMigrationHost(migrationOptions),
  ),
);
const migration = { open: async () => (await migrationHost()).open() };
const migrationOptions = {
  org: organization,
  puter: () => window.puter,
  modal,
  toast,
  download,
  addLocalBoard: async (b) => {
    boards.push(b);
    try {
      await local.save(b);
    } catch (error) {
      // A board that could not be kept is not shown as if it had been.
      boards.splice(boards.indexOf(b), 1);
      throw error;
    }
    refreshLibrary();
  },
  device: () => commentIdentity.slice("device:".length),
  removeLocalBoard: async (id) => {
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    b.deletedAt = Date.now();
    await saveLibrary(b, "deletedAt");
    refreshLibrary();
  },
};
async function openMigration() {
  try {
    await connect();
    if (!organization.allows("miro"))
      return toast("Your organization has turned off Miro imports.");
    await migration.open();
  } catch (error) {
    toast(error.message || "Could not connect to Puter.");
  }
}
const adminLoader = lazily(() =>
  import("./organization/admin-ui.js").then(({ createAdminConsole }) =>
    createAdminConsole({
      org: organization,
      migrate: openMigration,
      modal,
      toast,
      icon,
      download,
      refresh: iconsRefresh,
      openBoard: (room) => openShared(organization.server, room),
      changed: () => organizationHome.forgetLists(),
    }),
  ),
);
const adminConsole = {
  open: (tab) =>
    adminLoader().then(
      (admin) => admin.open(tab),
      (error) => toast(error.message),
    ),
};
const organizationLibrary = createOrganizationLibrary({
  org: organization,
  modal,
  toast,
  icon,
  refresh: iconsRefresh,
  // A template from the library becomes a new board on this device.
  useBoard: async (json, name) => {
    const b = validateBoard(JSON.parse(json));
    assertImagePixels(b.items);
    b.id = uid();
    for (const key of ["shared", "timer", "deletedAt", "comments"])
      delete b[key];
    b.workshop = portableWorkshop(b.workshop);
    if (!b.workshop) delete b.workshop;
    b.favorite = false;
    adoptFrameMembers(b);
    b.updated = Date.now();
    b.title = (name || b.title).slice(0, 200);
    await adoptBoard(b);
  },
  canInsert: () => !!current && !isSharedReadOnly(),
  // A template from the library goes into the open board, like a built-in
  // one: beside what is there, with its tags.
  insertBoard: (json) => {
    const b = validateBoard(JSON.parse(json));
    assertImagePixels(b.items);
    return features.insertTemplate(b.items, b.tags);
  },
  // The open board as this person may see it, without its discussion.
  shareable: () => {
    if (!current) return null;
    const copy = clone(current);
    facilitation.portableCopy(copy);
    for (const key of ["shared", "timer", "comments", "favorite", "deletedAt"])
      delete copy[key];
    copy.id = uid();
    return copy;
  },
  includeSharedMedia: (copy) => includeSharedMedia(copy),
});
addCommands(({ add }) => {
  if (!organization.isMember) return;
  add(
    "org-library",
    "Organization library",
    "Board",
    "organization library templates bibliotheque organisation modeles",
  );
  add(
    "org-library-share",
    "Share to organization library",
    "Board",
    "share template library publish partager modele bibliotheque",
  );
});
// Notifications are asked for only when opened from a board, never on a
// timer: hundreds of people asking one worker repeatedly would use up its
// listing quota.
addCommands(({ add }) => {
  if (!organizationHome.available()) return;
  add(
    "notifications",
    "Notifications",
    "Navigate",
    "mentions replies assignments tasks inbox alerts mentions reponses taches",
  );
});
const organizationHome = createOrganizationHome({
  org: organization,
  modal,
  toast,
  icon,
  refresh: iconsRefresh,
  openShared,
  // Notifications about shared boards are kept by the servers hosting them.
  sharedServers: () =>
    boards
      .filter((b) => b.shared?.server && !b.deletedAt)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
      .flatMap((b) => {
        try {
          return [workerURL(b.shared.server)];
        } catch {
          return [];
        }
      }),
  request: (server, op, data) =>
    collaborationCall(window.puter, server, { op, ...data }),
  signedIn: () => !!window.puter?.auth?.isSignedIn?.(),
  admin: adminConsole,
  library: () => organizationLibrary.open(),
  connect: () => connect(),
  rerender: () => {
    if (!current) home();
  },
});
const boardAccess = createBoardAccess({
  org: organization,
  session: () => collaboration,
  // Section links list only frames this person may see, and say which
  // participants do not see yet.
  board: () => facilitation.masked(current),
  hidden: (id) => facilitation.hidden(id),
  modal,
  toast,
  icon,
  refresh: iconsRefresh,
  home: () => home(),
});
const ai = createAI({
  org: organization,
  session: () => collaboration,
  board: () => current,
  view: () => facilitation.masked(current),
  concealed: () => facilitation.concealedIds(),
  outcomes: () => facilitation.outcomes(),
  selection: () => selection,
  modal,
  toast,
  icon,
  mutate,
  center,
  select: (ids) => {
    selectItems(ids);
    draw();
  },
  canEdit: canEditSelection,
  fileInput,
  refresh: iconsRefresh,
  signIn: () => connect(),
});
const account = createAccountUI({
  icon,
  action: (name) => action(name),
  refresh: iconsRefresh,
});
const altText = createAltText({
  board: () => current,
  view: () => facilitation.masked(current),
  modal,
  mutate,
  toast,
  ai,
  canEdit: canEditSelection,
});
const onboarding = createOnboarding({
  focusCanvas: () => document.querySelector("#canvas")?.focus(),
});
const helpCenter = createHelpCenter({
  modal,
  icon,
  refresh: iconsRefresh,
  tour: () => startTour(),
  shortcuts: () => help(),
  org: organization,
  toast,
});
function startTour() {
  document.querySelector("#tour-offer")?.remove();
  if (current)
    // By role, not by whether the board is still connecting.
    onboarding.start(undefined, {
      canEdit: !collaboration?.readOnly && !collaboration?.contentReadOnly,
      canComment: !collaboration?.readOnly,
    });
  else toast("Open a board to take the tour.");
}
const planning = createPlanning({
  board: () => current,
  view: () => facilitation.masked(current),
  concealed: () => facilitation.concealedIds(),
  locked: (ids) => hasLocked(current.items, ids),
  // Why a facilitator's lock keeps this person from changing the board's
  // plan and adding objects other than sticky notes, or null.
  boardLocked: () =>
    facilitation.frozen() ||
    (facilitation.boardLocked() ? "The facilitator locked this board." : null),
  selection: () => selection,
  select: (ids) => {
    setTool("select");
    selectItems(ids);
    draw();
  },
  canvas: () => document.querySelector("#canvas"),
  readOnly: isSharedReadOnly,
  session: () => collaboration,
  org: organization,
  now: () => collaboration?.now() ?? Date.now(),
  prepare: () => {
    finishTextEdit();
    tags.close();
    tableEditor.close();
    objectLinks.close();
    comments.close(false);
    boardSearch.close(false);
    framesPanel.close(false);
    // Side panels share the right edge; one opening closes the other.
    facilitation.close(false);
  },
  addObject,
  mutate,
  focusRegion: (box) => focusRegion(box, undefined, true),
  layout: reflowSelectionTools,
  modal,
  toast,
  download,
});
addCommands(({ board: b, selection: chosen, add }) => {
  if (!b || !chosen.size || !facilitation.canHide()) return;
  const shown = [...chosen].every((id) => facilitation.hidden(id));
  add(
    shown ? "show-objects" : "hide-objects",
    shown ? "Show to participants" : "Hide from participants",
    "Workshop",
    "hide conceal hidden facilitator reveal masquer cacher afficher participants",
  );
});
function selectedLinkObject() {
  const id = selection.has(selectionAnchor)
    ? selectionAnchor
    : selection.size === 1
      ? [...selection][0]
      : null;
  return current?.items.find((i) => i.id === id);
}
// The object a command for one object acts on: the anchor, else a selected
// object no other selected object holds, as a frame selected with its
// contents or a mind map node with its branch.
function primarySelected() {
  return (
    selectedLinkObject() ||
    current.items.find(
      (i) =>
        selection.has(i.id) &&
        !selection.has(i.parentId) &&
        !selection.has(i.mindMap?.parent),
    ) ||
    current.items.find((i) => selection.has(i.id))
  );
}
const mindMap = createMindMapUI({
  board: () => current,
  source: () => (editing?.item?.mindMap ? editing.item : selectedLinkObject()),
  concealed: () => facilitation.concealedIds(),
  collapsed: (id) => !!mindView.scene().counts.has(id),
  toggle: (id) => toggleMindBranch(id),
  canEdit: canEditSelection,
  mutate: (fn) => mutate(fn, { mindLayout: true }),
  select: selectItems,
  finish: finishTextEdit,
  edit: beginTextEdit,
  center: () => snapGridPoint(center(), activeGridStep()),
  draw,
  modal,
  toast,
  focus: () =>
    document.querySelector("#canvas")?.focus({ preventScroll: true }),
  reveal: (i, overview = false) => {
    if (!i) return;
    const rect = document.querySelector("#canvas").getBoundingClientRect();
    if (!rect.width || !rect.height) {
      draw();
      return;
    }
    if (overview) {
      const top = Math.min(180, rect.height / 3),
        bottom = 100;
      const z = Math.max(
        DETAIL_ZOOM,
        Math.min(
          1.25,
          (rect.width - 140) / (i.w + 40),
          (rect.height - top - bottom) / (i.h + 40),
        ),
      );
      view = {
        x: rect.width / 2 - (i.x + i.w / 2) * z,
        y: top + (rect.height - top - bottom) / 2 - (i.y + i.h / 2) * z,
        z,
      };
      draw();
      return;
    }
    const z = Math.min(1.5, Math.max(0.8, view.z));
    const x = view.x + i.x * view.z,
      y = view.y + i.y * view.z;
    if (
      view.z < 0.8 ||
      x < 90 ||
      y < 160 ||
      x + i.w * view.z > rect.width - 90 ||
      y + i.h * view.z > rect.height - 90
    )
      view = {
        x: rect.width / 2 - (i.x + i.w / 2) * z,
        y: rect.height / 2 - (i.y + i.h / 2) * z,
        z,
      };
    draw();
  },
});
const tableEditor = createTableEditor({
  state: () => ({ board: current, view }),
  canvas: () => document.querySelector("#canvas"),
  selected: (i) => selectedLinkObject() === i,
  writable: (i) =>
    !!i && !isSharedReadOnly() && !hasLocked(current.items, new Set([i.id])),
  prepare: () => {
    canvasNavigation.finish();
    pointerUp();
    finishTextEdit();
    objectLinks.close();
    comments.close(false);
    boardSearch.close(false);
    imageCrop.close(false);
    imageReplacement.close();
  },
  resize: (i, patch) => {
    if (current.items.includes(i) && canEditSelection(new Set([i.id])))
      mutate(() => Object.assign(i, patch));
  },
  change: (i, cells, structure, languages) => {
    if (!current.items.includes(i) || !canEditSelection(new Set([i.id])))
      return;
    const languagePatch = tableLanguagePatch(i, cells, structure, languages);
    if (i.columnWidths || i.rowHeights) {
      const patch = sizedTableCells(
        i,
        cells,
        document.querySelector("#canvas").getContext("2d"),
        structure,
      );
      return mutate(() => Object.assign(i, patch, languagePatch));
    }
    const w = (i.w * cells[0].length) / i.cells[0].length;
    const h = Math.max(
      (i.h * cells.length) / i.cells.length,
      tableHeight(
        cells,
        w,
        document.querySelector("#canvas").getContext("2d"),
        i,
      ),
    );
    if (w > 1e6 || h > 1e6)
      throw Error("The table is too tall. Use a smaller font or fewer lines.");
    mutate(() => Object.assign(i, { w, h }, languagePatch));
  },
  reveal: (box, editing = false) => {
    const rect = document.querySelector("#canvas").getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (editing && view.z < 0.8)
      view = zoomAt(
        view,
        {
          x: view.x + (box.x + box.w / 2) * view.z,
          y: view.y + (box.y + box.h / 2) * view.z,
        },
        0.8,
      );
    const toolbar = document
      .querySelector(".table-cell-tools")
      ?.getBoundingClientRect();
    const left = Math.min(80, rect.width / 8),
      top = Math.min(
        Math.max(80, (toolbar?.bottom || rect.top) - rect.top + 16),
        rect.height - 140,
      ),
      right = rect.width - 30,
      bottom = rect.height - 90;
    const x = view.x + box.x * view.z,
      y = view.y + box.y * view.z;
    if (x < left) view.x += left - x;
    else if (x + box.w * view.z > right)
      view.x -= Math.min(x - left, x + box.w * view.z - right);
    if (y < top) view.y += top - y;
    else if (y + box.h * view.z > bottom)
      view.y -= Math.min(y - top, y + box.h * view.z - bottom);
    draw();
  },
  draw,
  toast,
});
// Collapsed mind map branches, and content the workshop hides from this
// person, such as others' private notes.
function hiddenFromView() {
  const collapsed = mindView.scene().hidden,
    concealed = facilitation.concealedIds();
  return concealed.size ? new Set([...collapsed, ...concealed]) : collapsed;
}
const objectLinks = createObjectLinks({
  state: () => ({
    board: current,
    view,
    hidden: hiddenFromView(),
    concealed: facilitation.concealedIds(),
  }),
  selected: selectedLinkObject,
  base: () => location.href,
  address: (id) => objectAddress(current, id, location.href),
  canvas: () => document.querySelector("#canvas"),
  writable: (i) =>
    !!i && !isSharedReadOnly() && !hasLocked(current.items, new Set([i.id])),
  prepare: () => {
    canvasNavigation.finish();
    pointerUp();
    finishTextEdit();
    comments.close(false);
    boardSearch.close(false);
    framesPanel.close(false);
    imageCrop.close(false);
    imageReplacement.close();
    textLinkPreview.close();
  },
  change: (i, link) => {
    if (!current.items.includes(i) || !canEditSelection(new Set([i.id])))
      return;
    mutate(() => {
      if (link) i.objectLink = link;
      else delete i.objectLink;
    });
  },
  navigate: focusLinkedObject,
  icon,
  draw,
  toast,
  modal,
});
function focusLinkedObject(id, updateAddress = true) {
  const i = current?.items.find((i) => i.id === id);
  // Content hidden from this person is treated as absent, not selected,
  // and not called deleted: it may be shown later.
  if (!i) return toast("The linked object is no longer on this board.");
  if (facilitation.absent(id))
    return toast("The linked part of the board is not shown yet.");
  canvasNavigation.finish();
  pointerUp();
  finishTextEdit();
  objectLinks.close();
  comments.close(false);
  boardSearch.close(false);
  imageCrop.close(false);
  imageReplacement.close();
  if (updateAddress) pushObjectAddress(id);
  selectItems(new Set([id]));
  focusRegion(bounds(visibleItems().filter((i) => selection.has(i.id))));
  document.querySelector("#canvas").focus({ preventScroll: true });
}
// Going to an object, by its link or from Frames and navigation, is a step
// Back undoes: the view left is kept with its address, and the address then
// names the object, a link to it to share.
function pushObjectAddress(id) {
  window.history.replaceState(
    {
      whiteboard: {
        boardId: current.id,
        view: { ...view },
        selection: [...selection],
        anchor: selectionAnchor,
        focusedGroup,
      },
    },
    "",
    location.href,
  );
  const address = objectAddress(current, id, location.href);
  // Going again to what the address names is no new step.
  if (address && address !== location.href)
    window.history.pushState(null, "", address);
}
async function followBoardAddress(value) {
  const destination = boardDestination(value, location.href);
  // Back to the library's own address closes the board.
  if (!destination) {
    if (!current) return;
    const open = current;
    closeDialogs();
    await home({ keepAddress: true });
    // A board that could not be left, as one still saving its shared
    // edits, keeps its address.
    if (current === open && location.href === value)
      window.history.replaceState(
        null,
        "",
        objectAddress(open, undefined, location.href),
      );
    return;
  }
  const origin = current;
  if (origin) {
    pointerUp();
    finishTextEdit();
    clearTimeout(cloudTimer);
    if (cloudIds.has(origin.id)) await sync(clone(origin));
    flushNudgeSave();
    await saveChain;
    if (current !== origin || location.href !== value) return;
  }
  // An invitation joins through the dialog, as it does when the page loads,
  // even for a board already on this device: it may be for another account,
  // or renew access that lapsed.
  if (destination.token) return joinDialog(value);
  let target = destination.localId
    ? boards.find((b) => b.id === destination.localId)
    : boards.find(
        (b) =>
          b.shared?.server === destination.server &&
          b.shared?.room === destination.room,
      );
  if (destination.localId && !target) {
    // Only that board is read, not every board in the library.
    target = await local.get(destination.localId);
    if (Array.isArray(target?.items)) boards.push(target);
    else target = undefined;
  }
  if (location.href !== value) return;
  if (!target || target.deletedAt) {
    if (destination.localId || target?.deletedAt)
      return toast(
        "This board is unavailable on this device. Check your boards or Trash.",
      );
    return joinDialog(value);
  }
  if (current !== target) {
    if (!current) closeDialogs();
    await openBoard(target, { keepAddress: true });
  }
  if (current !== target || location.href !== value) return;
  if (destination.objectId) focusLinkedObject(destination.objectId, false);
  // An empty board opens at 100%, as it does from the board library.
  else if (current.items.length) fit();
  if (destination.thread) comments.show(destination.thread);
}
function addComment() {
  // A frame or mind-map node chosen alone also selects its contents; the
  // comment belongs to the object that was chosen.
  const target = selectedLinkObject() || null;
  const p = target
    ? { x: target.x + target.w - 12, y: target.y + 12 }
    : center();
  comments.compose(p, target, { avoidPins: true });
}
const minimap = createMinimap({
  state: () => ({
    board: current,
    view,
    narrowSearch:
      !!current &&
      document.querySelector("#canvas").getBoundingClientRect().width <= 760 &&
      (boardSearch.isOpen() || comments.isOpen()),
  }),
  canvas: () => document.querySelector("#canvas"),
  prepare: (opening = false) => {
    attention.stop();
    canvasNavigation.finish();
    minimap.cancel();
    pointerUp();
    finishTextEdit();
    // On a narrow screen the minimap and these panels share one place;
    // opening it would otherwise change nothing visible.
    if (
      opening &&
      document.querySelector("#canvas").getBoundingClientRect().width <= 760
    ) {
      boardSearch.close(false);
      comments.close(false);
    }
  },
  navigate: (next) => {
    attention.stop();
    view = next;
    draw();
  },
  fit,
  draw,
});
const textLinkPreview = createTextLinkPreview({
  state: () => ({
    board: current,
    editing,
    drag,
    view,
    concealed: facilitation.concealedIds(),
  }),
  canvas: () => document.querySelector("#canvas"),
  writable: (i) =>
    !isSharedReadOnly() && !hasLocked(current.items, new Set([i.id])),
  edit: (i, link) => {
    if (!current?.items.includes(i) || !canEditSelection(new Set([i.id])))
      return;
    beginTextEdit(i);
    editing.input.setSelectionRange(link.start, link.end);
    openTextLinkEditor();
  },
});
// What a press or the pointer at this board point is on: an object, or,
// zoomed out, the name drawn above a frame (frameLabels in render.js).
function boardHit(p, reach) {
  const hit = hitTest(visibleItems(), p, reach);
  if (hit) return hit;
  const id = frameLabelAt(p.x * view.z + view.x, p.y * view.z + view.y);
  return id ? visibleItems().find((i) => i.id === id) || null : null;
}
// Whether a press lands on the current selection or one of its handles,
// where it moves or reshapes the selection rather than selecting anew.
function pressesSelection(e) {
  if (isSharedReadOnly()) return false;
  const p = canvasPoint(e),
    touch = e.pointerType === "touch";
  const hit = boardHit(p, hitReach(e));
  // A press on an unlocked selected object drags it even when a locked
  // object is selected too: the selection narrows to it. The handles of
  // such a selection, though, move nothing.
  if (hasLocked(current.items, selection))
    return (
      !!hit &&
      selection.has(hit.id) &&
      !hasLocked(current.items, new Set([hit.id]))
    );
  return (
    !!resizeHit(
      current.items,
      selection,
      p,
      view.z,
      selectionAnchor,
      touch,
      resizeSides(),
    ) ||
    rotationHit(current.items, selection, p, view.z, touch) ||
    selection.has(hit?.id) ||
    // An empty part of a selected object's box drags it too.
    (!hit && !!selectedAt(visibleItems(), selection, p, 4 / view.z))
  );
}
const canvasNavigation = createCanvasNavigation({
  state: () => ({ board: current, view, tool }),
  contextMenu: (e) => openContextMenu(e),
  deferTap: () =>
    !space &&
    ["note", "text", "rect", "ellipse", "frame", "comment"].includes(tool),
  sizes: () =>
    !space &&
    !isSharedReadOnly() &&
    ["note", "text", "rect", "ellipse", "frame"].includes(tool),
  // A finger, or a mouse button that only pans, may be navigating: the
  // board takes focus, and so ends an open text edit, once the gesture
  // turns out to be a tap or a drag of content (navigation.js).
  prepare: (e) => {
    attention.stop();
    comments.cancel();
    minimap.cancel();
    pointerUp();
    imageCrop.close(false);
    imageReplacement.close();
    boardSearch.close(false);
    if (!e || (e.pointerType !== "touch" && e.button !== 1 && e.button !== 2))
      document.querySelector("#canvas").focus({ preventScroll: true });
  },
  selection: () => ({
    ids: [...selection],
    anchor: selectionAnchor,
    focusedGroup,
  }),
  restoreSelection: (saved) => {
    const existing = new Set(current.items.map((i) => i.id));
    selection = new Set(saved.ids.filter((id) => existing.has(id)));
    selectionAnchor = selection.has(saved.anchor) ? saved.anchor : null;
    focusedGroup = saved.focusedGroup || null;
    draw();
  },
  touchEdit: (e) => {
    lastPointerType = "touch";
    return pressesSelection(e);
  },
  // A press on the current selection or its handles drags it, however long
  // it rests first, so a hold there never turns into a marquee.
  pressesSelection,
  canMarquee: () =>
    tool === "select" &&
    !space &&
    !editing &&
    !tableEditor.isOpen() &&
    !objectLinks.isOpen() &&
    (!drag ||
      (["move", "link", "marquee"].includes(drag.kind) &&
        !drag.active &&
        !drag.changed)),
  resetTap: () => {
    lastTap = null;
  },
  begin: pointerDown,
  move: pointerMove,
  hover: pointerMove,
  end: pointerUp,
  cancel: cancelTransform,
  // Gestures that keep their last pointer follow a view change under it, as
  // does a pan, which the wheel only moves along.
  continues: () => !!drag?.pointer || drag?.kind === "pan",
  navigate: (next) => {
    attention.stop();
    view = next;
    if (drag?.pointer) pointerMove(drag.pointer);
    draw();
  },
});
const imageCrop = createImageCropUI({
  state: () => ({ board: current, view, snapping, selection }),
  visibleItems: () => visibleItems(),
  canvas: () => document.querySelector("#canvas"),
  canEdit: (id) =>
    !!current &&
    !isSharedReadOnly() &&
    !hasLocked(current.items, new Set([id])),
  draw,
  toast,
  focus: (box) => {
    const r = document.querySelector("#canvas").getBoundingClientRect();
    const narrow = r.width <= 760,
      top = narrow ? 264 : 0;
    const width = Math.max(80, r.width - (narrow ? 0 : 322));
    const height = Math.max(80, r.height - top);
    view.z = Math.max(
      DETAIL_ZOOM,
      Math.min(2, (width - 48) / box.w, (height - 48) / box.h),
    );
    view.x = width / 2 - (box.x + box.w / 2) * view.z;
    view.y = top + height / 2 - (box.y + box.h / 2) * view.z;
    draw();
  },
  commit: (id, next) => {
    if (!canEditSelection(new Set([id]))) return;
    mutate(() => {
      const i = current.items.find((i) => i.id === id);
      Object.assign(i, next);
      if (!i.crop) delete i.crop;
    });
  },
  wheel: (e) => canvasNavigation.wheel(e),
});
const imageReplacement = createImageReplacement({
  board: () => current,
  selection: () => selection,
  concealed: () => facilitation.concealedIds(),
  readOnly: isSharedReadOnly,
  canEdit: (id) =>
    !!current &&
    !isSharedReadOnly() &&
    !hasLocked(current.items, new Set([id])),
  modal,
  fileInput,
  toast,
  commit: (id, next) => {
    if (!canEditSelection(new Set([id]))) return;
    mutate(() =>
      Object.assign(
        current.items.find((i) => i.id === id),
        next,
      ),
    );
  },
});
const commandPalette = createCommandPalette({
  context: () => current,
  version: () => [
    current,
    current?.updated,
    current?.items,
    mindView.scene(),
    selection,
    selection.size,
    isSharedReadOnly(),
    collaboration?.shared.undo.undoStack.length,
    collaboration?.shared.undo.redoStack.length,
    history.past.length,
    history.future.length,
    language,
    copiedStyle,
    boards.length,
  ],
  entries: (recent) => boardCommands(recent),
  prepare: () => {
    pointerUp();
    finishTextEdit();
    boardSearch.close(false);
    objectLinks.close();
  },
  modal,
  toast,
  run: runCommand,
});
function boardCommands(recent = []) {
  return commandEntries({
    board: current ? { ...current, items: mindView.scene().items } : null,
    selection,
    anchor: selectionAnchor,
    focusedGroup,
    selectionOptions: selectionOptions(),
    readOnly: isSharedReadOnly(),
    commentReadOnly: isCommentReadOnly(),
    copiedStyle,
    boards,
    recent,
    frames: current ? orderedFrames(visualBoard().items) : [],
    authorsShown: showAuthors,
    undo: collaboration
      ? !!collaboration.shared.undo.undoStack.length
      : !!history.past.length,
    redo: collaboration
      ? !!collaboration.shared.undo.redoStack.length
      : !!history.future.length,
  });
}
// A right-click offers the board commands that suit what is under the
// pointer, plus the clipboard, which only the keyboard reached before.
installTooltips();
const contextMenu = createContextMenu({
  host: () => document.querySelector(".canvas-wrap"),
  icon,
  refresh: () => iconsRefresh(),
  focusCanvas: () =>
    document.querySelector("#canvas")?.focus({ preventScroll: true }),
  entries: () => {
    const entries = boardCommands();
    if (!current) return entries;
    const hidden = facilitation.concealedIds();
    const chosen = [...selection].some((id) => !hidden.has(id));
    const clipboard = globalThis.navigator?.clipboard;
    const add = (id, label, shortcut, disabled = "") =>
      entries.push({ id, label: t(label), shortcut, disabled });
    add("clipboard:copy", "Copy", "Ctrl/Cmd+C", chosen ? "" : "unavailable");
    add(
      "clipboard:cut",
      "Cut",
      "Ctrl/Cmd+X",
      chosen ? entries.find((e) => e.id === "delete")?.disabled : "unavailable",
    );
    add(
      "clipboard:paste",
      "Paste",
      "Ctrl/Cmd+V",
      isSharedReadOnly() || !(clipboard?.read || clipboard?.readText)
        ? "unavailable"
        : "",
    );
    add(
      "select-all",
      "Select all",
      "Ctrl/Cmd+A",
      current.items.some((i) => !hidden.has(i.id)) ? "" : "unavailable",
    );
    // Selected frames present from the first of them, or export as slides
    // or pages, with both dialogs starting from the frames chosen.
    if (
      current.items.some(
        (i) => i.type === "frame" && selection.has(i.id) && !hidden.has(i.id),
      )
    ) {
      add("frames:present", "Present from this frame");
      add("frames:export", "Export selected frames");
    }
    return entries;
  },
  run: (entry, point) => {
    if (entry.id === "clipboard:copy") return transfer.clipboard("copy");
    if (entry.id === "clipboard:cut") return transfer.clipboard("cut");
    if (entry.id === "clipboard:paste")
      return transfer.pasteClipboard(
        canvasPoint({ clientX: point.x, clientY: point.y }),
      );
    if (entry.id === "select-all") return selectAll();
    if (entry.id === "frames:present") return features.actions.present();
    if (entry.id === "frames:export") return features.actions.export();
    return runCommand(entry);
  },
});
// What a right-click without a drag, the context menu key or Shift+F10
// opens. A press on an object selects it first, as a left click would; a
// press on the empty board drops the selection.
function openContextMenu(e, keyboard = false) {
  // A right-click elsewhere on the board ends a text edit, keeping what was
  // typed, as a left click does, and opens the menu for what it is on.
  if (!keyboard && current && (editing || tableEditor.isOpen()))
    finishTextEdit();
  if (
    !current ||
    editing ||
    drag ||
    tableEditor.isOpen() ||
    document.querySelector("dialog[open]")
  )
    return false;
  const canvas = document.querySelector("#canvas"),
    r = canvas.getBoundingClientRect();
  let x = e?.clientX,
    y = e?.clientY,
    scope = "canvas";
  if (keyboard) {
    const chosen = visibleItems().filter((i) => selection.has(i.id));
    scope = chosen.length ? "object" : "canvas";
    const box = chosen.length ? bounds(chosen) : null;
    const middle = box
      ? {
          x: r.left + view.x + (box.x + box.w / 2) * view.z,
          y: r.top + view.y + (box.y + box.h / 2) * view.z,
        }
      : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    x = Math.max(r.left, Math.min(r.right - 1, middle.x));
    y = Math.max(r.top, Math.min(r.bottom - 1, middle.y));
  } else {
    const p = canvasPoint(e);
    const id =
      boardHit(p, hitReach(e))?.id ||
      selectedAt(visibleItems(), selection, p, 4 / view.z)?.id;
    if (id) {
      scope = "object";
      if (!selection.has(id)) {
        const hit = current.items.find((i) => i.id === id);
        selectItems(new Set([id]), {
          withinGroup: !!focusedGroup && hit.groupId === focusedGroup,
        });
        lastTap = null;
        draw();
      }
    } else if (selection.size) {
      selectItems(new Set());
      draw();
    }
  }
  return contextMenu.open({ x, y, scope, focus: keyboard });
}
// Ctrl/Cmd+A: every visible object that is not locked.
function selectAll() {
  pointerUp();
  selectionAnchor = null;
  focusedGroup = null;
  const hidden = facilitation.concealedIds();
  selection = unlockedSelection(
    current.items,
    new Set(current.items.filter((i) => !hidden.has(i.id)).map((i) => i.id)),
  );
  // A visible frame brings its contents back in; hidden ones stay out.
  if (hidden.size)
    selection = new Set([...selection].filter((id) => !hidden.has(id)));
  draw();
}
// Goes to a frame from the command palette as Frames and navigation does:
// as a step Back undoes, beside that panel when it is open, and said aloud.
function goToFrame(id) {
  const shown = orderedFrames(visualBoard().items),
    n = shown.findIndex((f) => f.id === id),
    frame = current.items.find((i) => i.id === id && i.type === "frame");
  if (!frame || n < 0) return;
  pushObjectAddress(id);
  focusRegion(
    bounds([frame]),
    document.querySelector("#frames-panel")?.getBoundingClientRect(),
    true,
  );
  announce(
    labelled(
      t("Showing frame {number} of {count}")
        .replace("{number}", n + 1)
        .replace("{count}", shown.length),
      shown[n].text || `${t("Frame")} ${n + 1}`,
    ),
  );
}
async function runCommand(entry) {
  if (entry.frameId) return goToFrame(entry.frameId);
  if (entry.boardId) {
    const destination = boards.find(
      (b) => b.id === entry.boardId && !b.deletedAt,
    );
    if (!destination) return;
    const origin = current;
    if (origin) {
      clearTimeout(cloudTimer);
      if (cloudIds.has(origin.id)) await sync(clone(origin));
      flushNudgeSave();
      await saveChain;
      if (current !== origin) return;
    }
    return openBoard(destination);
  }
  if (entry.id.startsWith("add:")) return addObject(entry.id.slice(4));
  if (entry.id.startsWith("shape:")) return addShape(entry.id.slice(6));
  if (entry.id.startsWith("format:")) return formatSelection(entry.id.slice(7));
  if (entry.id.startsWith("font:"))
    return formatSelection("fontFamily", entry.id.slice(5));
  if (entry.id.startsWith("duplicate:")) return duplicate(entry.id.slice(10));
  if (entry.id.startsWith("arrange:"))
    return features.organizeSelection(entry.id.slice(8));
  if (entry.id === "zoom-selection")
    return focusRegion(
      bounds(visibleItems().filter((i) => selection.has(i.id))),
    );
  return action(entry.id);
}
const quickPorts = createQuickConnectUI({
  state: () => ({
    board: current,
    view,
    source:
      current &&
      selection.size === 1 &&
      tool === "select" &&
      !space &&
      !drag &&
      !editing &&
      !isSharedReadOnly() &&
      !boardSearch.isOpen() &&
      !objectLinks.isOpen() &&
      !hasLocked(current.items, selection)
        ? current.items.find((i) => selection.has(i.id) && canQuickConnect(i))
        : null,
    skip: quickConnectSkip,
  }),
  draw,
  activate: quickConnect,
  start: startQuickConnection,
  move: pointerMove,
  end: pointerUp,
  cancel: cancelTransform,
  focusCanvas: () => document.querySelector("#canvas")?.focus(),
});
const mindHandles = createMindMapHandles({
  state: () => {
    const source = selectedLinkObject();
    const available =
      source?.mindMap &&
      tool === "select" &&
      !space &&
      !drag &&
      !editing &&
      !isSharedReadOnly() &&
      !boardSearch.isOpen() &&
      !objectLinks.isOpen() &&
      !tableEditor.isOpen() &&
      !imageCrop.id() &&
      !document.querySelector("dialog[open]") &&
      !hasLocked(current.items, selection);
    return {
      board: current,
      view,
      source: available ? source : null,
      size: available
        ? document.querySelector("#canvas")?.getBoundingClientRect()
        : null,
    };
  },
  add: (direction) => mindMap.add(false, direction),
  focus: () =>
    document.querySelector("#canvas")?.focus({ preventScroll: true }),
});
const mindCollapse = createMindCollapse({
  state: () => ({
    board: current,
    scene: mindView.scene(),
    view,
    size: document.querySelector("#canvas")?.getBoundingClientRect() || {
      width: 0,
      height: 0,
    },
    selected: selectedLinkObject()?.id,
    hovered: hoveredMind,
    concealed: facilitation.concealedIds(),
    enabled:
      !!current &&
      tool === "select" &&
      !space &&
      !drag &&
      !editing &&
      !boardSearch.isOpen() &&
      !objectLinks.isOpen() &&
      !document.querySelector("dialog[open]"),
  }),
  toggle: toggleMindBranch,
  focus: () =>
    document.querySelector("#canvas")?.focus({ preventScroll: true }),
});
function toggleMindBranch(id = selectedLinkObject()?.id) {
  pointerUp();
  finishTextEdit();
  if (!mindView.scene().branches.has(id)) return;
  selectionAnchor = id;
  selection = descendants(current.items, new Set([id]));
  mindView.toggle(id);
}
// Selection is expanded at the interaction boundary. Commands receive the
// resolved ids so editing a member cannot silently expand back to its group.
function selectionOptions() {
  return { groups: false, withinGroup: focusedGroup };
}
function selectionGroup(
  chosen = current.items.filter((i) => selection.has(i.id)),
) {
  return selectionGroupId(chosen);
}
function selectItems(ids, { withinGroup = false } = {}) {
  // Objects left out of this person's view, such as ones a facilitator
  // hid, are not selected when asked for, as from a vote's top results.
  if ([...ids].some((id) => facilitation.absent(id)))
    ids = new Set([...ids].filter((id) => !facilitation.absent(id)));
  attention.stop();
  pointerUp();
  mindView.invalidate();
  if (ids.size === 1) mindView.reveal([...ids][0]);
  selectionAnchor = ids.size === 1 ? [...ids][0] : null;
  focusedGroup = withinGroup
    ? current.items.find((i) => ids.has(i.id) && i.groupId)?.groupId || null
    : null;
  selection = descendants(current.items, ids, { groups: !focusedGroup });
}
function enterGroup(id = selectionAnchor) {
  const groupId = selectionGroup();
  if (!groupId || focusedGroup) return false;
  const member =
    current.items.find((i) => i.id === id && i.groupId === groupId) ||
    current.items.find((i) => selection.has(i.id) && i.groupId === groupId);
  selectItems(new Set([member.id]), { withinGroup: true });
  lastTap = null;
  draw();
  document.querySelector("#canvas")?.focus({ preventScroll: true });
  return true;
}
function exitGroup() {
  if (!focusedGroup) return false;
  const ids = new Set(
    current.items.filter((i) => i.groupId === focusedGroup).map((i) => i.id),
  );
  selectItems(ids);
  lastTap = null;
  draw();
  document.querySelector("#canvas")?.focus({ preventScroll: true });
  return true;
}
// Facilitator locks and hidden contributions protect objects like object locks.
// Deleting a frame or group would also delete what it holds, including
// content hidden from this person, so that is checked too.
function hasLocked(items, ids, options) {
  return (
    objectLocked(items, ids, options) ||
    facilitation.locked(
      options?.deleting ? descendants(items, ids, selectionOptions()) : ids,
    )
  );
}
// A control placed on the board, such as a vote button or a comment pin,
// that takes keyboard focus while a panel or toolbar covers it is brought
// into view beside what covers it (WCAG 2.4.11).
function revealCovered(control) {
  const box = control.getBoundingClientRect?.(),
    canvas = document.querySelector("#canvas")?.getBoundingClientRect();
  if (!current || !box?.width || !box.height || !canvas?.width) return;
  const cx = box.left + box.width / 2,
    cy = box.top + box.height / 2;
  const top = document.elementFromPoint?.(cx, cy);
  if (!top || top === control || control.contains(top)) return;
  if (top === document.querySelector("#canvas")) return;
  const cover = top.getBoundingClientRect(),
    room = {
      left: cover.left - canvas.left,
      right: canvas.right - cover.right,
      above: cover.top - canvas.top,
      below: canvas.bottom - cover.bottom,
    },
    need = Math.max(box.width, box.height) + 32;
  let dx = 0,
    dy = 0;
  if (Math.max(room.left, room.right) >= need)
    dx =
      room.left >= room.right
        ? (canvas.left + cover.left) / 2 - cx
        : (cover.right + canvas.right) / 2 - cx;
  else if (Math.max(room.above, room.below) >= need)
    dy =
      room.above >= room.below
        ? (canvas.top + cover.top) / 2 - cy
        : (cover.bottom + canvas.bottom) / 2 - cy;
  if (!dx && !dy) return;
  view = { ...view, x: view.x + dx, y: view.y + dy };
  draw();
}
document.addEventListener("focusin", (e) => {
  if (
    e.target instanceof Element &&
    e.target.closest(".fac-item, .comment-pin")
  )
    revealCovered(e.target);
});
// Why a change to these objects is refused: a facilitator's lock or a
// private note is explained as such, since a participant cannot unlock it.
function lockedReason(items, ids, options) {
  if (facilitation.facilitatorLocked?.(ids))
    return "Only a facilitator can unlock or change this object.";
  if (
    !objectLocked(items, ids, options) &&
    !(options?.deleting && removalMovesLocked(ids))
  ) {
    const reason = facilitation.lockReason?.(
      options?.deleting ? descendants(items, ids, selectionOptions()) : ids,
    );
    if (reason) return reason;
  }
  return "Unlock protected objects before changing this selection.";
}
function isSharedReadOnly() {
  return (
    collaborationBusy ||
    !!collaboration?.readOnly ||
    !!collaboration?.contentReadOnly ||
    (!!current?.shared && !collaboration)
  );
}
// Why the board takes no content edits right now.
function sharedReadOnlyReason() {
  return collaborationBusy
    ? "Still connecting to the shared board. Try again in a moment."
    : reconnecting && reconnecting === current
      ? "Cannot reach the shared board. It is view only until it reconnects."
      : "This board is read-only.";
}
// Commenters cannot change content but can still discuss it.
function isCommentReadOnly() {
  return (
    collaborationBusy ||
    !!collaboration?.readOnly ||
    (!!current?.shared && !collaboration)
  );
}
function canEditSelection(ids = selection, options) {
  if (isSharedReadOnly()) {
    toast(sharedReadOnlyReason());
    return false;
  }
  if (
    !hasLocked(current.items, ids, options) &&
    !(options?.deleting && removalMovesLocked(ids))
  )
    return true;
  toast(lockedReason(current.items, ids, options));
  return false;
}
// Removing a mind map node lays its map out again. Like moving a branch,
// it is refused when that would move a locked node.
function removalMovesLocked(ids) {
  const locked = current.items.filter((i) => i.locked && i.mindMap);
  if (!locked.length) return false;
  const laidOut = (remove) => {
    const copy = current.items.map((i) =>
      i.mindMap ? { ...i, mindMap: { ...i.mindMap } } : { ...i },
    );
    const items = remove ? removeItems(copy, ids, selectionOptions()) : copy;
    preserveManualMindMoves(current.items, items);
    autoLayoutMindMaps(items);
    return new Map(items.map((i) => [i.id, i]));
  };
  let before, after;
  try {
    before = laidOut(false);
    after = laidOut(true);
  } catch {
    return false;
  }
  return locked.some((i) => {
    const a = before.get(i.id),
      b = after.get(i.id);
    return a && b && (a.x !== b.x || a.y !== b.y);
  });
}
function toggleLock() {
  if (!selection.size) return;
  if (isSharedReadOnly()) return toast(sharedReadOnlyReason());
  pointerUp();
  const locked = current.items.some((i) => selection.has(i.id) && i.locked);
  const frame = current.items.find(
    (i) =>
      i.id === selectionAnchor &&
      selection.has(i.id) &&
      i.type === "frame" &&
      !i.groupId,
  );
  const ids = !locked && frame ? new Set([frame.id]) : selection;
  if (locked && facilitation.facilitatorLocked?.(ids))
    return toast("Only a facilitator can unlock or change this object.");
  mutate(() => setLocked(current.items, ids, !locked));
  // A facilitator's lock can refuse it, saying why.
  if (!lockedAs(ids, !locked)) return;
  facilitation.recordLocks?.(withGroups(ids), !locked);
  toast(
    locked
      ? "Selection unlocked."
      : frame
        ? "Frame locked. Its contents remain editable."
        : "Selection locked.",
  );
}
function unlockAll() {
  if (isSharedReadOnly()) return toast(sharedReadOnlyReason());
  // Participants unlock only what they can see and what no facilitator
  // locked.
  const concealed = facilitation.concealedIn?.(current) || new Set();
  const shown = current.items.filter((i) => i.locked && !concealed.has(i.id));
  const ids = new Set(
    shown
      .filter((i) => !facilitation.facilitatorLocked?.(new Set([i.id])))
      .map((i) => i.id),
  );
  if (!ids.size)
    return toast(
      shown.length
        ? "Only a facilitator can unlock the remaining objects."
        : "No locked objects.",
    );
  mutate(() => setLocked(current.items, ids, false));
  if (!lockedAs(ids, false)) return;
  facilitation.recordLocks?.(ids, false);
  toast("All objects unlocked.");
}
// The objects setLocked changes: these and the rest of their groups.
function withGroups(ids) {
  const groups = new Set(
    current.items
      .filter((i) => ids.has(i.id) && i.groupId)
      .map((i) => i.groupId),
  );
  return new Set(
    current.items
      .filter((i) => ids.has(i.id) || (i.groupId && groups.has(i.groupId)))
      .map((i) => i.id),
  );
}
// Whether the objects ended up locked, or unlocked, as asked.
const lockedAs = (ids, locked) =>
  current.items
    .filter((i) => ids.has(i.id))
    .every((i) => !!i.locked === locked);
// Every snapshot passed here is a copy made for this version alone, so the
// store keeps it without copying it again. Like an undo step, it may share
// finished drawings' points with the board, which never change in place.
function checkpoint(label = "Board edit", snapshot = undoCopy(current)) {
  if (!snapshot) return;
  queuedShared = null;
  revisionChain = revisionChain
    .catch(() => {})
    .then(() => local.checkpoint(snapshot, label, { owned: true }))
    .catch(() => toast("Could not save a recovery version. Export a backup."));
}
// A save refused because another tab saved the board since leaves this
// tab's edits in no stored copy, and reloading shows the other tab's. They
// are kept as a version instead, one for as long as saves keep being
// refused, updated with each, so they can be restored after the reload.
function keepRefusedEdits(snapshot, error) {
  revisionChain = revisionChain
    .catch(() => {})
    .then(() =>
      local.checkpoint(snapshot, "Unsaved changes from another tab", {
        owned: true,
        kept: true,
        replaces:
          refusedVersion?.boardId === snapshot.id ? refusedVersion.id : null,
      }),
    )
    .then(
      (revision) => {
        refusedVersion = { boardId: snapshot.id, id: revision.id };
        toast(
          "This board changed in another tab. Your changes here are kept in Version history. Reload to see the latest copy.",
        );
      },
      () => toast(error.message),
    );
}
function focusRegion(a, searchPanel, avoidSelection = false) {
  attention.stop();
  const r = document.querySelector("#canvas").getBoundingClientRect();
  const availableWidth =
    searchPanel && r.width > 760
      ? Math.max(160, r.width - searchPanel.width - 32)
      : r.width;
  const selectionTools =
    avoidSelection && document.querySelector("#selection-tools");
  const belowPanel =
      searchPanel && r.width <= 760 ? searchPanel.bottom - r.top + 16 : 0,
    belowTools =
      selectionTools && !selectionTools.hidden
        ? floatingToolbar(r)
          ? toolbarTopInset() +
            selectionTools.getBoundingClientRect().height +
            16
          : selectionTools.getBoundingClientRect().bottom - r.top + 16
        : 0;
  // On a phone the search panel can cover nearly all of the canvas. Rather
  // than shrinking the result into the sliver left below it, the result is
  // framed as if the panel were closed, ready for when it is.
  // On a phone the row of board buttons floats over the top of the board,
  // as the tools do along its bottom: what is framed goes between them.
  const bar =
      r.width <= 760
        ? document.querySelector(".canvas-top")?.getBoundingClientRect()
        : null,
    belowHeader =
      bar?.height && bar.bottom < r.top + r.height / 2
        ? bar.bottom - r.top + 8
        : 0;
  const top = Math.max(
    belowHeader,
    belowPanel && r.height - Math.max(belowPanel, belowTools) - 200 < 120
      ? belowTools
      : Math.max(belowPanel, belowTools),
  );
  // On a phone the tools sit along the bottom of the board, over it: what
  // is framed goes in the strip between them and whatever is above.
  const bars =
      r.width <= 760
        ? [".left-rail .tools", ".canvas-bottom"]
            .map((q) => document.querySelector(q)?.getBoundingClientRect())
            .filter((b) => b?.height && b.top > r.top + r.height / 2)
        : [],
    below = bars.length
      ? r.top + r.height - Math.min(...bars.map((b) => b.top)) + 8
      : 0;
  const availableHeight = Math.max(100, r.height - top - below),
    // The bottom bars are kept clear of, by measure on a phone and by a
    // margin otherwise.
    margin = below ? 40 : 200;
  // Only room to frame it in may zoom out past readable text.
  const room = availableWidth - 70 > 0 && availableHeight - margin > 0;
  view.z = Math.max(
    room ? MIN_ZOOM : DETAIL_ZOOM,
    Math.min(
      2,
      Math.min(
        (availableWidth - 70) / (a.w + 30),
        (availableHeight - margin) / (a.h + 30),
      ),
    ),
  );
  view.x = availableWidth / 2 - (a.x + a.w / 2) * view.z;
  view.y =
    top +
    (below ? availableHeight : availableHeight - 80) / 2 -
    (a.y + a.h / 2) * view.z;
  draw();
}
// Shows an object chosen from the keyboard, as in the object outline: the
// view pans only when the object's middle is off screen, so that at most
// half of it shows, centring it clear of the tools around the canvas where
// there is room, and zooms out only when it does not fit.
function revealObject(box) {
  const r = document.querySelector("#canvas").getBoundingClientRect();
  const x = view.x + box.x * view.z,
    y = view.y + box.y * view.z,
    w = box.w * view.z,
    h = box.h * view.z;
  // A canvas not laid out yet shows nothing to bring it into.
  if (!r.width || !r.height) return;
  const middle = { x: x + w / 2, y: y + h / 2 };
  if (
    middle.x >= 0 &&
    middle.y >= 0 &&
    middle.x <= r.width &&
    middle.y <= r.height
  )
    return;
  if (w > r.width || h > r.height) return focusRegion(box, undefined, true);
  attention.stop();
  const left = r.width < 760 ? 24 : 90,
    right = r.width - 30,
    top = 140,
    bottom = r.height - (r.width < 760 ? 200 : 70);
  view.x += (w <= right - left ? left + right : r.width) / 2 - w / 2 - x;
  view.y += (h <= bottom - top ? top + bottom : r.height) / 2 - h / 2 - y;
}
try {
  theme = localStorage.getItem("whiteboard-theme") || "system";
  characterShortcuts =
    localStorage.getItem("whiteboard-character-shortcuts") !== "false";
  snapping = localStorage.getItem("whiteboard-snapping") !== "false";
  showAuthors = localStorage.getItem("whiteboard-show-authors") === "true";
  boardGrid = readGrid(localStorage.getItem(GRID_STORAGE_KEY));
  showDimensions = readDimensions(localStorage.getItem(DIMENSIONS_STORAGE_KEY));
  preciseSelection = readPreciseSelection(
    localStorage.getItem(PRECISE_SELECTION_KEY),
  );
} catch {}
function applyTheme() {
  document.documentElement.dataset.theme =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
}
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyTheme();
  if (current) draw();
  else paintPreviews();
});
function iconsRefresh() {
  // Rendered SVGs keep data-lucide, so every call rebuilt every icon on each
  // pointer move. Convert placeholders only, then unmark the new SVGs.
  if (document.querySelector("i[data-lucide]")) {
    createIcons({ icons, attrs: { "stroke-width": 1.65 } });
    for (const svg of document.querySelectorAll("svg[data-lucide]"))
      svg.removeAttribute("data-lucide");
  }
  paintPreviews();
  translateUI();
}
// A modal dialog covers the page and makes it inert, so show toasts inside
// the topmost open dialog and return them to the page when it closes.
const toastElement = document.querySelector("#toast");
document.addEventListener(
  "close",
  (e) => {
    if (e.target.contains?.(toastElement)) document.body.append(toastElement);
  },
  true,
);
// A notification, with one action when there is something to do about
// it; that one stays longer, as it asks to be read and acted on.
function toast(message, action) {
  const el = toastElement;
  const host =
    [...document.querySelectorAll("dialog[open]")].at(-1) || document.body;
  if (el.parentNode !== host) host.append(el);
  // Keep the source text in the translation cache so a still-visible
  // notification follows subsequent interface language changes.
  el.textContent = message;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.onclick = () => {
      el.classList.remove("visible");
      action.run();
    };
    el.append(button);
  }
  translateUI(el);
  el.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => el.classList.remove("visible"),
    action ? 10000 : 4500,
  );
}
// A message inside a dialog: what happened, marked as success or an error
// so the two are told apart at a glance and not only by their wording.
function notice(el, text, kind = "") {
  if (!el) return;
  el.textContent = text ? t(text) : "";
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}
// Statuses that mean the board is cut off from the others or at risk, and
// how badly. They are shown in the warning or error colour with an icon, so
// they do not read as one more "Saved". Those that are told as well say so:
// the connection's, once it has lasted a moment, and once more when it is
// back. An access change is told by the role change itself, and a local
// save that failed by its own notification.
const DISRUPTIONS = {
  "Offline · changes saved on this device": ["warning", "connection"],
  "Uploading images · waiting for the board's server": ["warning"],
  "Cannot reach the shared board · retrying · view only": [
    "warning",
    "connection",
  ],
  "Could not connect · local copy available": ["warning", "connection"],
  "Access changed · unsent changes stay on this device": ["warning"],
  "Access changed · local changes retained": ["warning", "board"],
  "Board unavailable · local changes retained": ["error", "board"],
  "Local recovery failed. Keep this tab open.": ["error", "board"],
  "This board needs a newer version of the app · reload": ["error", "board"],
  "Not saved": ["error"],
  "Storage full": ["error"],
  "Sharing failed · try again": ["error"],
};
const statusTone = (text) => DISRUPTIONS[text]?.[0] || "";
// What is said about a disruption, and about its end.
const DISRUPTION_NOTICES = {
  connection: [
    "Connection lost. Changes are saved on this device and sync when it returns.",
    "Back online · changes synced",
  ],
  board: [
    "The shared board cannot be reached. Changes stay on this device.",
    "Shared board available again · changes synced",
  ],
};
// A disruption waits this long before it is told, so a blip of a second or
// two, as when the network changes, passes without a notification.
const DISRUPTION_DELAY = 2500;
const disruption = { timer: null, told: null };
function followDisruption(text) {
  const kind = DISRUPTIONS[text]?.[1];
  if (kind) {
    if (disruption.told || disruption.timer) return;
    const board = current?.id;
    disruption.timer = setTimeout(() => {
      disruption.timer = null;
      const still = DISRUPTIONS[status.text]?.[1];
      if (!still || status.board !== board || current?.id !== board) return;
      disruption.told = still;
      // Another notification already showing, such as why connecting
      // failed, is not covered by this one; the status still shows it.
      if (!toastElement.classList.contains("visible"))
        toast(DISRUPTION_NOTICES[still][0]);
    }, DISRUPTION_DELAY);
    return;
  }
  // Still under way, as "Saving shared changes…" while reconnecting, is
  // neither the disruption nor its end.
  if (text.endsWith("…")) return;
  clearTimeout(disruption.timer);
  disruption.timer = null;
  const told = disruption.told;
  disruption.told = null;
  if (told && /^(Saved|Connected) · /.test(text))
    toast(DISRUPTION_NOTICES[told][1]);
}
function status(text) {
  // Another board's disruption is not this one's, nor is its end.
  if (status.board !== current?.id) {
    clearTimeout(disruption.timer);
    disruption.timer = null;
    disruption.told = null;
  }
  // Kept so rebuilding the editor, as for a language change, shows it again.
  status.text = text;
  status.board = current?.id;
  clearTimeout(status.timer);
  followDisruption(text);
  const show = () => {
    const el = document.querySelector("#save-state");
    if (!el) return;
    const tone = statusTone(text);
    if ((el.dataset.tone || "") !== tone)
      if (tone) el.dataset.tone = tone;
      else delete el.dataset.tone;
    // The same text set again would be read out again. The tooltip gives
    // the whole of a status cut short beside the board name.
    if (el.textContent !== t(text)) el.textContent = el.title = t(text);
  };
  // A state still under way is shown once it has lasted a moment: a save
  // that finishes at once, or a burst of edits, reads as one saved state
  // rather than "Saving…" and "Saved" for each.
  if (text.endsWith("…")) status.timer = setTimeout(show, 600);
  else show();
}
// Others' changes can arrive several times a second, each asking for a copy
// of the whole board on this device. A copy still waiting to be written
// stands for the later ones too: it is taken when it is written, so it is
// the latest. Any other write queued after it ends that.
function storeShared(target) {
  if (queuedShared?.target === target) return;
  const job = (queuedShared = { target });
  saveChain = saveChain
    .catch(() => {})
    .then(() => {
      if (queuedShared === job) queuedShared = null;
      // Unfinished gestures are previews; save their rebased originals.
      return local.save(
        clone(
          drag?.original && current === target
            ? { ...target, items: drag.original }
            : target,
        ),
      );
    })
    .catch(() =>
      toast("Could not save locally. Export your board to keep a copy."),
    );
}
// A held arrow key moves objects on every repeat; the board is written once
// the key is released or the moves pause, not once per repeat, as a board
// with pictures is megabytes each time.
let nudgeSave = null;
function saveSoon() {
  clearTimeout(nudgeSave);
  nudgeSave = setTimeout(flushNudgeSave, 250);
}
function flushNudgeSave() {
  if (!nudgeSave) return;
  clearTimeout(nudgeSave);
  nudgeSave = null;
  save();
}
// mutate() and undo pass `outlined`, having drawn the change already.
function save({ outlined = false } = {}) {
  if (!current) return;
  if (current.comments?.length)
    current.comments = updateCommentAnchors(current.comments, current.items);
  if (
    !facilitation.beforeSave(
      collaboration && !collaborationBusy
        ? collaborationLastSaved || collaborationRendered
        : null,
    )
  )
    return;
  minimap.invalidate();
  boardSearch.refresh();
  current.updated = Date.now();
  // Some changes are made in place and saved without passing through
  // mutate(); the outline catches up with them here.
  if (!outlined) {
    contentVersion++;
    renderOutline();
  }
  // Stored, uploaded and shared copies only read the snapshot, so it shares
  // finished drawings' points with the board as undo steps do: copying them
  // took most of each save on a board of long drawings.
  const snapshot = undoCopy(current);
  if (collaboration && !collaborationBusy) {
    // Plain copies, as for undo: structuredClone() takes several times as
    // long on a large board, for every edit.
    const session = collaboration,
      before = sharedCopy(collaborationLastSaved || collaborationRendered);
    collaborationLastSaved = sharedCopy(snapshot);
    collaborationPendingEdits++;
    collaborationEdits = collaborationEdits
      .then(() => session.commit(snapshot, before))
      .catch((e) => {
        session.failure(e);
        toast(e.message);
      })
      .finally(() => {
        collaborationPendingEdits--;
      });
  }
  status("Saving…");
  queuedShared = null;
  saveChain = saveChain
    .catch(() => {})
    .then(() => local.save(snapshot))
    .then((saved) => {
      unsavedLocal.delete(saved.id);
      // A save that goes through ends a run of refused ones: edits refused
      // after it are kept in a version of their own.
      if (refusedVersion?.boardId === saved.id) refusedVersion = null;
      // Another tab's library choice, carried by the save, shows here too.
      const b = boards.find((b) => b.id === saved.id);
      for (const key of ["favorite", "deletedAt"])
        for (const target of new Set([b, current?.id === saved.id && current]))
          if (target)
            if (saved[key] === undefined) delete target[key];
            else target[key] = saved[key];
      return (
        !snapshot.shared &&
        // A save that finishes after another board was opened says
        // nothing about that board's state.
        current?.id === snapshot.id &&
        status(
          cloudIds.has(snapshot.id)
            ? "Saving to Puter…"
            : "Saved on this device",
        )
      );
    })
    .catch((error) => {
      if (!snapshot.shared && error?.name !== "DeletedBoardError")
        unsavedLocal.add(snapshot.id);
      if (["StaleBoardError", "DeletedBoardError"].includes(error?.name)) {
        if (current?.id === snapshot.id) status("Not saved");
        if (error.name === "StaleBoardError")
          return keepRefusedEdits(snapshot, error);
        return toast(error.message);
      }
      if (current?.id === snapshot.id) status("Storage full");
      toast("Could not save locally. Export your board to keep a copy.");
    });
  if (cloudIds.has(snapshot.id) && !snapshot.shared) {
    pendingCloud.set(snapshot.id, snapshot.updated);
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => sync(snapshot), 1500);
  }
}
async function sync(snapshot) {
  if (!cloud) return;
  // A save that finishes after another board was opened says nothing
  // about that board's state.
  const report = (text) => current?.id === snapshot.id && status(text);
  try {
    report("Saving to Puter…");
    if (cloudUnverified.has(snapshot.id)) {
      // Another device may have saved this board since this copy was
      // made; that copy is kept rather than written over.
      const opened = cloudUnverified.get(snapshot.id);
      const remote = await cloud
        .read(`whiteboard/${snapshot.id}.json`)
        .catch(() => null);
      cloudUnverified.delete(snapshot.id);
      if (remote && remote.updated > opened) {
        // This device's copy is not the one in Puter now.
        cloudIds.delete(snapshot.id);
        cloudIndex.delete(snapshot.id);
        pendingCloud.delete(snapshot.id);
        report("Newer copy in Puter");
        renderBoardTag();
        refreshLibrary();
        toast("A newer copy of this board is saved in Puter.", {
          label: "Open newer copy",
          run: () =>
            openCloudBoard(
              { name: `${snapshot.id}.json` },
              { replace: true },
            ).catch((e) =>
              toast(e.message || "Could not open the copy in Puter."),
            ),
        });
        return;
      }
    }
    await cloud.save(snapshot);
    cloudIndex.add(snapshot.id);
    if (pendingCloud.get(snapshot.id) <= snapshot.updated)
      pendingCloud.delete(snapshot.id);
    report("Saved to Puter");
  } catch {
    report("Cloud save failed");
    toast(
      "Cloud save failed. Your local copy is safe. Use Save to Puter to retry.",
    );
  }
}
// A local undo step holds the objects, the tags, and the board's planning
// settings, so turning Kanban status sync on or off can be undone.
function undoState(items = current.items) {
  return { items, tags: current.tags || [], planning: current.planning };
}
function restoreUndoState(state) {
  contentVersion++;
  formatRequests++;
  // Objects the step leaves as they are stay the board's own, with their
  // text already laid out.
  state.items = keepUnchanged(state.items, current.items);
  Object.assign(current, state);
  if (!current.tags?.length) delete current.tags;
  if (!current.planning) delete current.planning;
  if ("title" in state) {
    const title = document.querySelector("#board-title");
    if (title && document.activeElement !== title) title.value = current.title;
    showBoardTitle(current.title);
  }
}
// The state to keep for the other direction of an undo or redo step. A step
// that changed the title, as restoring a version does, keeps it both ways;
// other steps leave the title as it is.
function undoStateFor(step) {
  return step && "title" in step
    ? { ...undoState(), title: current.title }
    : undoState();
}
// A change that continues the one before it, as a held arrow key does,
// records no undo step or recovery version of its own. One that may change
// the board's title says so, and its undo step takes the title back too.
function mutate(
  fn,
  { mindLayout = false, continues = false, titled = false } = {},
) {
  if (isSharedReadOnly()) return toast(sharedReadOnlyReason());
  pointerUp();
  const future = history.future,
    recorded = !continues && !collaboration;
  // The recovery version of the board as it was is written once the change
  // has gone through: a refused change leaves none.
  const before = continues ? null : undoCopy(current);
  if (recorded)
    history.push(
      titled ? { ...undoState(), title: current.title } : undoState(),
    );
  const priorMind = mindLayout
    ? []
    : current.items
        .filter((i) => i.mindMap)
        .map((i) => ({ ...i, mindMap: { ...i.mindMap } }));
  const taskParents = planning.parents();
  try {
    fn();
  } catch (error) {
    // A refused change leaves no undo step and keeps what can be redone.
    if (recorded) {
      history.past.pop();
      history.future = future;
    }
    throw error;
  }
  contentVersion++;
  if (before) checkpoint("Board edit", before);
  planning.syncStatus(taskParents);
  mindView.invalidate();
  if (!mindLayout) preserveManualMindMoves(priorMind, current.items);
  autoLayoutMindMaps(current.items);
  minimap.invalidate();
  updateConnectors(current.items);
  draw();
  if (continues) saveSoon();
  else {
    clearTimeout(nudgeSave);
    nudgeSave = null;
    save({ outlined: true });
  }
}
// The library sidebar shows an icon beside each preference, like its other rows.
function themeControl(labelled = false) {
  return `<label class="language-control">${labelled ? icon("languages") : ""}<span class="sr-only">Language</span><select id="language" aria-label="Language"><option value="en" lang="en" ${language === "en" ? "selected" : ""}>English</option><option value="fr" lang="fr" ${language === "fr" ? "selected" : ""}>Français</option></select></label><label class="theme-control">${icon("sun-moon")}<span class="sr-only">Appearance</span><select aria-label="Appearance" id="theme"><option value="system" ${theme === "system" ? "selected" : ""}>System</option><option value="light" ${theme === "light" ? "selected" : ""}>Light</option><option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option></select></label>`;
}
// The strip of templates on the home page: a blank board, then templates
// from the catalog under the names their boards get, in the interface's
// language.
const featuredTemplates = () => [
  ["blank", "Blank board", "A fresh start", "plus"],
  ...[
    ["brainstorm", "lightbulb"],
    ["mindmap", "network"],
    ["kanban", "columns-3"],
    ["retro", "layout-template"],
    ["crazy-8s", "layout-template"],
    ["project-kickoff", "layout-template"],
  ].map(([id, symbol]) => {
    const def = TEMPLATE_CATALOG.find((d) => d.id === id);
    const n = language === "fr" ? 1 : 0;
    return [id, def.name[n], def.description[n], symbol];
  }),
];
// The boards show as cards with previews or as a list, as each person
// last chose.
const LIBRARY_VIEW_KEY = "whiteboard-library-view";
let libraryView = "grid";
try {
  if (localStorage.getItem(LIBRARY_VIEW_KEY) === "list") libraryView = "list";
} catch {}
let keptPreviews = new Map();
// The library shows its boards a page at a time: thousands of cards, each
// with a preview, made every keystroke of a search, a sort or a favourite
// take a third of a second. A new search, sort or list starts again at one
// page; going back from a board keeps the pages that were shown.
const LIBRARY_PAGE = 200;
let libraryShown = LIBRARY_PAGE;
// The board's name titles the tab and, for screen readers, the page, whose
// visible name is the field that renames it.
function showBoardTitle(title) {
  document.title = title + " · Whiteboard";
  const heading = document.querySelector("#board-heading");
  if (heading && heading.textContent !== title) heading.textContent = title;
}
// Without `previews`, the library's previews wait until holdPreviews(false),
// as when the board the page's address names opens over it.
async function home({
  keepAddress = false,
  push = false,
  previews = true,
} = {}) {
  const left = current?.id;
  flushNudgeSave();
  onboarding.close(false);
  tags.close();
  objectLinks.close();
  comments.close(false);
  textLinkPreview.close();
  canvasNavigation.finish();
  imageCrop.close(false);
  imageReplacement.close();
  commandPalette.close();
  pointerUp();
  finishTextEdit();
  boardSearch.close(false);
  framesPanel.close(false);
  if ((await leaveCollaboration()) === false) return;
  // Going to the library from a board is a step Back can undo.
  if (!keepAddress)
    window.history[push ? "pushState" : "replaceState"](
      null,
      "",
      location.pathname + location.search,
    );
  canvasNavigation.detach();
  minimap.detach();
  workshopTimer.detach();
  facilitation.detach();
  attention.detach();
  liveUI.detach();
  current = null;
  // Signing out or leaving the organization takes its boards list away, so
  // the library goes back to all boards.
  if (filter === "organization" && !organization.info) filter = "all";
  holdPreviews(!previews);
  document.title = t("Your boards") + " · Whiteboard";
  // Board previews already painted move into the new cards instead of
  // being painted again, as they do when a search redraws the cards.
  keptPreviews = new Map(
    [
      ...document.querySelectorAll(
        "#board-grid canvas[data-preview][data-painted]",
      ),
    ].map((canvas) => [canvas.dataset.preview, canvas]),
  );
  app.innerHTML = `<div class="workspace"><aside class="sidebar"><a class="brand" href="#" aria-label="Whiteboard home">${logo}</a><div class="workspace-label">Personal workspace</div><nav aria-label="Board library"><button data-filter="all" class="nav-item ${filter === "all" ? "active" : ""}">${icon("layout-dashboard")}All boards<span>${libraryFigure(boards.filter((b) => !b.deletedAt).length + cloudOnly().length)}</span></button><button data-filter="favorites" class="nav-item ${filter === "favorites" ? "active" : ""}">${icon("star")}Favorites<span>${libraryFigure(boards.filter((b) => b.favorite && !b.deletedAt).length)}</span></button><button data-filter="trash" class="nav-item ${filter === "trash" ? "active" : ""}">${icon("trash-2")}Trash</button>${organizationHome.notificationsItem()}</nav>${organizationHome.sidebar()}<div class="sidebar-bottom">${window.puter?.auth?.isSignedIn?.() ? "" : `<div class="sidebar-note" role="note">${icon("hard-drive")}<span>${t("Boards stay in this browser until you sign in.")}</span><button class="text-btn" data-action="sign-in">${t("Sign in")}</button></div>`}${themeControl(true)}<a class="powered" href="https://developer.puter.com" target="_blank" rel="noopener">Powered by Puter ${icon("arrow-up-right")}</a></div></aside><main class="library"><h1 class="sr-only">Whiteboard</h1><header class="library-top"><span class="crumbs"><span class="crumb-parent">Workspace <span class="slash">/</span></span> <strong>${filter === "trash" ? "Trash" : filter === "favorites" ? "Favorites" : "All boards"}</strong></span><div class="top-right">${button("command", "Command palette (Ctrl/Cmd K)", "commands")}${button("users", "Join shared board", "join-shared")}${button("circle-help", "Help and training", "help-center")}${button("keyboard", "Keyboard shortcuts", "help")}${account.markup()}</div></header><div class="library-body">${
    filter === "trash"
      ? ""
      : `<section aria-labelledby="start-heading"><div class="section-heading"><h2 id="start-heading">Start with a little inspiration</h2><button class="text-btn" data-action="templates">Browse all templates ${icon("arrow-up-right")}</button></div><div class="templates">${featuredTemplates()
          .map(
            ([key, title, sub, ic]) =>
              `<button class="template" data-template="${key}"><div class="template-art art-${key}">${key === "blank" ? `<span class="blank-plus">${icon("plus")}</span>` : preview(key === "blank" ? board("") : fromTemplate(key, language), { ink: "#30342f" })}</div><div class="template-caption"><span class="template-icon">${icon(ic)}</span><span><strong>${title}</strong><small>${sub}</small></span>${icon("arrow-up-right")}</div></button>`,
          )
          .join("")}</div></section>`
  }<section class="boards-section" aria-labelledby="boards-heading"><div class="boards-heading"><div><h2 id="boards-heading">${filter === "trash" ? "Trash" : filter === "favorites" ? "Favorite boards" : "Your boards"} <span class="count">${libraryFigure(libraryCount())}</span></h2></div><button class="primary" data-action="new">${icon("plus")}New board</button></div><div class="board-filters"><label class="search">${icon("search")}<input id="search" type="search" aria-label="Search boards" placeholder="Search your boards" value="${escape(search)}"><button type="button" class="icon-btn search-clear" aria-label="Clear search" title="Clear search" ${search ? "" : "hidden"}>${icon("x")}</button></label><label class="sort">${icon("arrow-down-wide-narrow")}<select id="sort" aria-label="Sort boards"><option value="recent">Last edited</option><option value="name" ${librarySort === "name" ? "selected" : ""}>Name</option></select></label>${filter === "trash" ? "" : button("upload", "Import board file", "import") + button("import", "Migrate from Miro", "migrate-miro")}<div class="view-toggle" role="group" aria-label="Board layout">${button("layout-grid", "Grid view", "view-grid", `aria-pressed="${libraryView === "grid"}"`)}${button("list", "List view", "view-list", `aria-pressed="${libraryView === "list"}"`)}</div></div><p id="library-results" class="sr-only" role="status"></p><div class="board-list-head" aria-hidden="true"><span>Name</span><span>Objects</span><span>Last edited</span><span>Location</span></div><div id="board-grid" class="board-grid ${libraryView === "list" ? "is-list" : ""}"></div></section><footer class="library-footer"><button class="text-btn" data-action="help">Keyboard shortcuts ${icon("arrow-up-right")}</button></footer></div></main></div>`;
  renderCards();
  bindShared();
  account.bind();
  organizationHome.bind();
  document
    .querySelector('[data-filter="organization"]')
    ?.classList.toggle("active", filter === "organization");
  document
    .querySelectorAll("[data-template]")
    .forEach((el) => (el.onclick = () => newBoard(el.dataset.template)));
  document.querySelectorAll("[data-filter]").forEach((el) => {
    // Screen readers hear which list is showing, not only sighted users.
    if (el.dataset.filter === filter) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
    el.onclick = async () => {
      filter = el.dataset.filter;
      libraryShown = LIBRARY_PAGE;
      await home();
      // The library is rebuilt, so keep the keyboard on the chosen list, or
      // on the organization's space chosen.
      if (!current && document.activeElement === document.body)
        (
          organizationHome.chosenSpace() ||
          document.querySelector(`[data-filter="${filter}"]`)
        )?.focus();
    };
  });
  const searchField = document.querySelector("#search"),
    clearSearch = document.querySelector(".search-clear");
  const searchFor = (value) => {
    search = value;
    clearSearch.hidden = !value;
    libraryShown = LIBRARY_PAGE;
    renderCards();
  };
  searchField.oninput = (e) => searchFor(e.target.value);
  // Escape or the clear button empties the search, as in Miro.
  searchField.onkeydown = (e) => {
    if (e.key !== "Escape" || !searchField.value || e.isComposing) return;
    e.preventDefault();
    searchField.value = "";
    searchFor("");
  };
  clearSearch.onclick = (e) => {
    e.preventDefault();
    searchField.value = "";
    searchFor("");
    searchField.focus();
  };
  document.querySelector("#sort").onchange = (e) => {
    librarySort = e.target.value;
    libraryShown = LIBRARY_PAGE;
    renderCards();
  };
  for (const view of ["grid", "list"]) {
    const toggle = document.querySelector(`[data-action="view-${view}"]`);
    if (!toggle) continue;
    toggle.onclick = () => {
      libraryView = view;
      try {
        localStorage.setItem(LIBRARY_VIEW_KEY, view);
      } catch {}
      document
        .querySelector("#board-grid")
        ?.classList.toggle("is-list", view === "list");
      for (const other of document.querySelectorAll(".view-toggle button"))
        other.setAttribute(
          "aria-pressed",
          String(other.dataset.action === `view-${view}`),
        );
      // Previews take the new size instead of the old bitmap stretched.
      paintPreviews();
    };
  }
  iconsRefresh();
  // Back from a board opened here, the library is where it was, with the
  // keyboard on that board's card, as in Miro.
  if (left && libraryReturn?.board === left) {
    revealLibraryCard(left);
    if (libraryReturn.scroll && window.scrollY !== libraryReturn.scroll)
      window.scrollTo(0, libraryReturn.scroll);
    document
      .querySelector(`[data-open="${escape(left)}"]`)
      ?.focus({ preventScroll: true });
  }
  libraryReturn = null;
  warmLibrarySearch();
}
// Each board's search text is prepared while the browser is idle once the
// library shows, a few milliseconds at a time, so the first search of a
// library of hundreds of large boards does not wait for all of them.
let warming = 0;
function warmLibrarySearch() {
  const run = ++warming,
    queue = boards.filter((b) => Array.isArray(b.items)),
    idle =
      window.requestIdleCallback ||
      ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 50));
  const step = (deadline) => {
    if (run !== warming || current) return;
    const end = performance.now() + Math.min(10, deadline.timeRemaining());
    while (queue.length && performance.now() < end)
      libraryContent(queue.shift());
    if (queue.length) idle(step);
  };
  idle(step);
}
// Board counts read with the language's digit grouping: 1,500, not 1500.
function libraryFigure(n) {
  return new Intl.NumberFormat(language === "fr" ? "fr-CA" : "en-CA").format(n);
}
// How many boards the chosen list holds, those only in Puter included.
function libraryCount() {
  return (
    boards.filter(
      (b) =>
        (filter === "trash" ? !!b.deletedAt : !b.deletedAt) &&
        (filter !== "favorites" || b.favorite),
    ).length + (filter === "all" ? cloudOnly().length : 0)
  );
}
// Update the library's counts and cards in place, keeping scroll position,
// sorting, and focus.
function refreshLibrary() {
  if (current || !document.querySelector("#board-grid")) return;
  const live = boards.filter((b) => !b.deletedAt);
  document.querySelector('[data-filter="all"] > span:last-child').textContent =
    libraryFigure(live.length + cloudOnly().length);
  document.querySelector(
    '[data-filter="favorites"] > span:last-child',
  ).textContent = libraryFigure(live.filter((b) => b.favorite).length);
  document.querySelector("#boards-heading .count").textContent =
    libraryFigure(libraryCount());
  if (filter !== "organization") renderCards();
}
// The account's boards in Puter that are not on this device yet, which the
// library lists and counts with the boards here.
function cloudOnly() {
  const here = new Set(boards.map((b) => b.id));
  return [...cloudTitles].filter(([id]) => !here.has(id));
}
// Cards for boards in the account's Puter drive that are not on this device.
// The card of a board in the account's Puter drive that is not on this
// device.
function cloudCard({ id, title }, n) {
  return `<article class="board-card cloud-card"><button class="board-open" data-open-cloud="${escape(id)}" aria-label="Open ${escape(title)}" aria-describedby="cloud-card-${n}-meta"><div class="board-preview"><span class="empty-preview">${icon("cloud")}<span>${t("Open from Puter")}</span></span></div><div class="board-info"><h3>${escape(title)}</h3><p id="cloud-card-${n}-meta"><span class="meta-count"></span><span class="meta-date">${t("Not on this device yet")}</span></p><span class="card-storage" data-storage="cloud">${icon("cloud")}${t("Saved to Puter")}</span></div></button></article>`;
}
// A card's badge says where the board is kept, in the words the open
// board uses.
function storageBadge(b) {
  const kind = boardStorage(b),
    [name, label] = STORAGE_TAGS[kind];
  return `<span class="card-storage" data-storage="${kind}">${icon(name)}${t(label)}</span>`;
}
function renderCards() {
  if (filter === "organization") {
    document.querySelector(".board-filters")?.setAttribute("hidden", "");
    const heading = document.querySelector("#boards-heading");
    if (heading) {
      // The organization view counts its own results below the filters.
      heading.firstChild.textContent = t("Organization boards");
      heading.querySelector(".count")?.setAttribute("hidden", "");
    }
    const crumb = document.querySelector(".library-top strong");
    if (crumb) crumb.textContent = t("Organization boards");
    // The organization's cards have their own layout; the personal list
    // view, whose toggle is hidden here, does not apply to them.
    const grid = document.querySelector("#board-grid");
    grid.classList.remove("is-list");
    return organizationHome.renderBoards(grid);
  }
  const words = searchWords(),
    matches = libraryMatches(words),
    list = matches.slice(0, libraryShown);
  const grid = document.querySelector("#board-grid");
  // Cards are rebuilt on each keystroke of a search; their painted previews
  // move into the new cards instead of being painted again.
  const painted = new Map([
    ...keptPreviews,
    ...[...grid.querySelectorAll("canvas[data-preview][data-painted]")].map(
      (canvas) => [canvas.dataset.preview, canvas],
    ),
  ]);
  keptPreviews = new Map();
  grid.innerHTML = list.length
    ? list
        .map(
          // The name is the title alone; the object count and date are
          // read as the description. A shared board's card shows what its
          // workshop lets this person see there.
          (b, n) => {
            if (b.cloud) return cloudCard(b, n);
            const shown = cardView(b),
              found = words.length ? libraryFound(b, words) : "";
            return `<article class="board-card"><button class="board-open" data-open="${escape(b.id)}" aria-label="${b.deletedAt ? "Restore or delete" : "Open"} ${escape(b.title)}" aria-describedby="board-card-${n}-meta${found ? ` board-card-${n}-found` : ""}"><div class="board-preview">${shown.items.length ? preview(shown) : `<span class="empty-preview">${icon("pencil-ruler")}<span>A world of possibility</span></span>`}</div><div class="board-info"><h3 data-user-content title="${escape(b.title)}">${escape(b.title)}</h3><p id="board-card-${n}-meta"><span class="meta-count">${plural(shown.items.length, "{count} object", "{count} objects")}</span> <span class="meta-sep">·</span> <span class="meta-date">${cardDate(b.updated)}</span></p>${found ? `<p class="card-found" id="board-card-${n}-found">${found}</p>` : ""}${storageBadge(b)}</div></button>${b.deletedAt ? "" : `<button class="favorite ${b.favorite ? "is-favorite" : ""}" data-favorite="${escape(b.id)}" aria-label="Favorite ${escape(b.title)}" aria-pressed="${!!b.favorite}">${icon("star")}</button>`}<button class="card-more" data-more="${escape(b.id)}" aria-label="Options for ${escape(b.title)}" aria-haspopup="dialog">${icon("ellipsis")}</button></article>`;
          },
        )
        .join("")
    : `<div class="empty-state">${icon(search ? "search" : filter === "trash" ? "trash-2" : "layers")}<h3>${search ? "No boards found" : filter === "favorites" ? "Keep your best ideas close" : filter === "trash" ? "Trash is empty" : "Your next idea starts here"}</h3><p>${search ? "Try different words." : filter === "favorites" ? "Star a board to find it here." : filter === "trash" ? "Boards you move to the trash wait here until you restore them or delete them permanently." : "Create a board or choose a template above."}</p></div>`;
  for (const canvas of grid.querySelectorAll("canvas[data-preview]")) {
    const kept = painted.get(canvas.dataset.preview);
    if (kept) canvas.replaceWith(kept);
  }
  libraryMore(grid, list.length, matches.length);
  // Screen readers hear how many boards match a search, not only sighted
  // users, also when the list changes under it, as on choosing Favorites.
  const results = document.querySelector("#library-results");
  if (results)
    results.textContent = search.trim()
      ? matches.length
        ? plural(matches.length, "{count} board found", "{count} boards found")
        : t("No boards found")
      : "";
  document.querySelectorAll("[data-open]").forEach(
    (el) =>
      (el.onclick = async () => {
        const b = boards.find((b) => b.id === el.dataset.open);
        if (b.deletedAt) return boardOptions(b);
        // A board found by what it holds opens on what was found: Find on
        // board searches for the words its name lacks that the object shown
        // on the card holds, words other objects hold left out, and shows
        // the first match.
        const hit = libraryHit(b, searchWords()),
          held = hit && fold(hit.raw);
        const query = hit
          ? search
              .split(/\s+/)
              .filter(
                (word) =>
                  word &&
                  !fold(b.title).includes(fold(word)) &&
                  held.includes(fold(word)),
              )
              .join(" ")
          : "";
        await openBoard(b);
        if (query && current === b && !document.querySelector("dialog[open]"))
          openBoardSearch(query);
      }),
  );
  document.querySelectorAll("[data-open-cloud]").forEach(
    (el) =>
      (el.onclick = async () => {
        const id = el.dataset.openCloud,
          done = busy(el);
        try {
          await connect();
          await openCloudBoard({
            name: id + ".json",
            title: cloudTitles.get(id),
          });
        } catch (e) {
          toast(e.message || "Could not open cloud board.");
        } finally {
          done();
        }
      }),
  );
  document.querySelectorAll("[data-favorite]").forEach(
    (el) =>
      (el.onclick = async () => {
        const b = boards.find((b) => b.id === el.dataset.favorite);
        b.favorite = !b.favorite;
        try {
          await saveLibrary(b, "favorite");
        } catch (error) {
          b.favorite = !b.favorite;
          if (!(await followStore(b, error)))
            toast("Could not save this change on this device.");
        }
        refreshLibrary();
        (
          [...document.querySelectorAll("[data-favorite]")].find(
            (button) => button.dataset.favorite === b.id,
          ) || document.querySelector('[data-filter="favorites"]')
        )?.focus();
      }),
  );
  document
    .querySelectorAll("[data-more]")
    .forEach(
      (el) =>
        (el.onclick = () =>
          boardOptions(boards.find((b) => b.id === el.dataset.more))),
    );
  iconsRefresh();
  return matches.length;
}
// Each word of the search matches somewhere in the title or the content,
// so a pasted or double-spaced search finds the board.
function searchWords() {
  return fold(search).split(/\s+/).filter(Boolean);
}
// What this person sees of a board: a shared board's workshop may keep
// some of its content from them.
function cardView(b) {
  return b.shared ? facilitation.libraryView(b, canManage(b.shared.role)) : b;
}
// What each board holds, folded as the search is, so the library finds a
// board by what is on it as well as by its name, as Find on board would.
// Built when a search first needs it and kept until the board changes.
const libraryTexts = new WeakMap();
function libraryContent(b) {
  const role = b.shared?.role || "",
    kept = libraryTexts.get(b);
  if (
    kept &&
    kept.items === b.items &&
    kept.updated === b.updated &&
    kept.role === role
  )
    return kept;
  const shown = cardView(b),
    names = new Map((shown.tags || []).map((tag) => [tag.id, tag.name])),
    items = [],
    starts = [];
  let text = "";
  for (const i of shown.items) {
    const value = itemSearchText(i, names);
    if (!value) continue;
    items.push(i);
    starts.push(text.length);
    text += fold(value) + "\n";
  }
  const content = {
    items: b.items,
    updated: b.updated,
    role,
    text,
    starts,
    list: items,
    names,
  };
  libraryTexts.set(b, content);
  return content;
}
// The boards of the chosen list that match the search, in the chosen
// order: those whose names match first, a name that is the search or
// begins with it before others, then those matched by content. All boards
// include those the account keeps in Puter that are not on this device
// yet (`cloud`), in name order among the others; with no date to go by,
// they follow the others by last edit.
function libraryMatches(words = searchWords()) {
  const listed = boards
    .filter(
      (b) =>
        (filter === "trash" ? !!b.deletedAt : !b.deletedAt) &&
        (filter !== "favorites" || b.favorite),
    )
    .concat(
      filter === "all"
        ? cloudOnly().map(([id, title]) => ({ id, title, cloud: true }))
        : [],
    )
    .sort(
      librarySort === "name"
        ? (a, b) => compareNames(a.title, b.title)
        : (a, b) =>
            !!a.cloud - !!b.cloud ||
            (a.cloud ? compareNames(a.title, b.title) : b.updated - a.updated),
    );
  if (!words.length) return listed;
  const query = words.join(" "),
    named = [[], [], []],
    holding = [];
  for (const b of listed) {
    const title = fold(b.title),
      rest = words.filter((word) => !title.includes(word));
    if (!rest.length) {
      const name = title.split(/\s+/).filter(Boolean).join(" ");
      named[name === query ? 0 : name.startsWith(query) ? 1 : 2].push(b);
    } else if (!b.cloud) {
      const { text } = libraryContent(b);
      if (rest.every((word) => text.includes(word))) holding.push(b);
    }
  }
  return named.flat().concat(holding);
}
// The object holding the first searched word a board's name lacks, with
// its search text, for a board matched by its content; null when the name
// holds every word.
function libraryHit(b, words) {
  const title = fold(b.title),
    word = words.find((w) => !title.includes(w));
  if (!word) return null;
  const { text, starts, list, names } = libraryContent(b),
    at = text.indexOf(word);
  if (at < 0) return null;
  let low = 0,
    high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= at) low = mid;
    else high = mid - 1;
  }
  const item = list[low];
  return {
    item,
    word,
    raw: itemSearchText(item, names).replace(/\s+/g, " "),
  };
}
// Where a board matched by its content was found: the object's kind and
// the words around the match, the word marked. Empty when the name holds
// every word.
function libraryFound(b, words) {
  const hit = libraryHit(b, words);
  if (!hit) return "";
  const { item: i, raw, word } = hit,
    found = wordContext(raw, word) || {
      before: "",
      hit: "",
      after: raw.length > 160 ? raw.slice(0, 160) + "…" : raw,
    },
    lang = i.lang ? ` lang="${escape(i.lang)}"` : "";
  return `<span class="found-kind">${escape(kindLabel(i))}</span> <span data-user-content${lang}>${escape(found.before)}${found.hit ? `<mark>${escape(found.hit)}</mark>` : ""}${escape(found.after)}</span>`;
}
// Under a partly shown list, how many boards show and a button for the
// next page, which keeps the keyboard on the first of the new cards.
function libraryMore(grid, shown, total) {
  grid.parentElement.querySelector(".library-more")?.remove();
  if (shown >= total) return;
  grid.insertAdjacentHTML(
    "afterend",
    `<div class="library-more"><p>${t("Showing {shown} of {total} boards.").replace("{shown}", libraryFigure(shown)).replace("{total}", libraryFigure(total))}</p><button type="button" class="secondary" id="library-more">${t("Show more boards")}</button></div>`,
  );
  grid.parentElement.querySelector("#library-more").onclick = () => {
    libraryShown += LIBRARY_PAGE;
    renderCards();
    grid.querySelectorAll(".board-open")[shown]?.focus();
  };
}
// Shows the pages down to a board's card, for the keyboard to go back to
// it. Whether the card is now drawn.
function revealLibraryCard(id) {
  if (!id || current || filter === "organization") return false;
  if (document.querySelector(`#board-grid [data-open="${escape(id)}"]`))
    return true;
  const at = libraryMatches().findIndex((b) => b.id === id);
  if (at < libraryShown) return false;
  libraryShown = Math.ceil((at + 1) / LIBRARY_PAGE) * LIBRARY_PAGE;
  renderCards();
  return true;
}
// One board at a time: a second click while the first is being stored and
// opened would make two.
let creatingBoard = null;
async function newBoard(template = "blank") {
  if (creatingBoard) return creatingBoard;
  track("Board created", { template });
  creatingBoard = adoptBoard(
    template === "blank"
      ? board(t("Untitled board"))
      : fromTemplate(template, language),
  ).finally(() => {
    creatingBoard = null;
  });
  return creatingBoard;
}
// A new board opens even when this device could not store it, with the
// notice its later edits would give, so it can be exported or saved to
// Puter rather than silently kept in memory alone.
async function adoptBoard(b) {
  boards.push(b);
  try {
    await local.save(b);
  } catch {
    toast("Could not save locally. Export your board to keep a copy.");
  }
  await openBoard(b);
}
// When frames began to record their contents (25 September 2026).
const FRAME_MEMBERSHIP_SINCE = Date.UTC(2026, 8, 26);
// Boards last saved before frames recorded their contents take them in
// once, by position. A newer board without frame members has none: a
// frame added over objects, or emptied, keeps them out when reopened.
// Imported and duplicated boards are checked before their time is set.
function adoptFrameMembers(b) {
  if (
    !(b.updated >= FRAME_MEMBERSHIP_SINCE) &&
    !b.items.some((i) => i.parentId)
  )
    inferParents(b.items);
}
async function openBoard(b, { keepAddress = false } = {}) {
  // A board opened from the library is a step Back returns from, as in
  // Miro; one opened from another board, or again, takes its place.
  const fromLibrary =
    !current && !boardDestination(location.href, location.href);
  if (fromLibrary) libraryReturn = { board: b.id, scroll: window.scrollY || 0 };
  const address = () =>
    window.history[fromLibrary ? "pushState" : "replaceState"](
      null,
      "",
      objectAddress(b, undefined, location.href),
    );
  flushNudgeSave();
  // The open board stays as it is, with its view and undo history.
  if (current === b) {
    if (!keepAddress) address();
    return;
  }
  if ((await leaveCollaboration()) === false) return;
  // An edit of the board being left that still waits for its upload goes
  // now; the next board's saves would otherwise discard the upload timer.
  if (current && pendingCloud.has(current.id)) {
    clearTimeout(cloudTimer);
    sync(clone(current));
  }
  current = b;
  // A board the account keeps in Puter goes on being saved there, as it
  // was before the page was reloaded.
  if (
    !b.shared &&
    !cloudIds.has(b.id) &&
    cloudIndex.has(b.id) &&
    window.puter?.auth?.isSignedIn?.()
  ) {
    cloudIds.add(b.id);
    cloudUnverified.set(b.id, b.updated);
  }
  if (!keepAddress) address();
  commandPalette.recordBoard(b.id);
  exportRegion = null;
  adoptFrameMembers(b);
  updateConnectors(b.items);
  selection.clear();
  history = new History();
  tool = "select";
  view = { x: 110, y: 85, z: 1 };
  status.board = null;
  // A board still being shared stays read-only until the shared copy,
  // made from it as it was, takes over; edits meanwhile would be lost.
  if (sharing && !sharing.done && sharing.target === b) {
    collaborationBusy = true;
    status("Setting up sharing…");
  }
  editor();
  if (b.items.length) fit();
  if (!b.shared) restoreTextDraft(b);
  // The board takes the focus the library's button had, so the keyboard
  // and a screen reader start on it rather than at the top of the page.
  if (!document.activeElement || document.activeElement === document.body)
    document.querySelector("#canvas")?.focus({ preventScroll: true });
  if (b.shared && !collaboration) await connectShared(b);
}
// A shared board that could not connect, as during a short outage or a rush
// of people joining, tries again by itself, at once when the browser is
// back online; access that was refused is not tried again.
let cancelReconnect = () => {},
  // The shared board waiting to try again, view only meanwhile.
  reconnecting = null;
function connectShared(b, attempt = 0) {
  cancelReconnect();
  return startCollaboration(b).catch((e) => {
    if (current !== b) return;
    collaborationBusy = false;
    if (!attempt) toast(e.message);
    if (e.status && e.status < 500 && ![408, 429].includes(e.status)) return;
    reconnecting = b;
    status("Cannot reach the shared board · retrying · view only");
    const retry = () => {
      cancelReconnect();
      if (current === b && b.shared && (!collaboration || collaboration.closed))
        connectShared(b, attempt + 1);
    };
    const timer = setTimeout(retry, Math.min(60000, 5000 * 2 ** attempt));
    window.addEventListener("online", retry);
    cancelReconnect = () => {
      clearTimeout(timer);
      window.removeEventListener("online", retry);
      reconnecting = null;
      cancelReconnect = () => {};
    };
  });
}
const tools = [
  ["select", "mouse-pointer-2", "Select", "V"],
  ["hand", "hand", "Pan", "H"],
  ["note", "sticky-note", "Sticky note", "N"],
  ["text", "type", "Text", "T"],
  ["rect", "square", "Rectangle", "R"],
  ["ellipse", "circle", "Ellipse", "O"],
  ["arrow", "move-up-right", "Arrow", "A"],
  ["pen", "pencil", "Draw", "P"],
  ["frame", "scan", "Frame", "F"],
  ["comment", "message-square", "Comment", "C"],
];
const TOOL_HINTS = {
  select: "Select and move · Double-click to edit · Space to pan",
  hand: "Drag to move around your board",
  note: "Click to add a sticky note · Drag to draw one at a size",
  text: "Click to add text · Drag to set its width",
  rect: "Click to add a rectangle · Drag to draw one at a size",
  ellipse: "Click to add an ellipse · Drag to draw one at a size",
  arrow: "Drag between objects to connect · Alt/Option for a free endpoint",
  pen: "Draw freely on the canvas",
  frame: "Click to add a frame · Drag to draw one around objects",
  comment: "Click the canvas to add a comment",
  region: "Drag across the board to choose the area to export",
};
// On wider screens the header's two groups float over the board, and the
// canvas's own top row (board tag, participants, navigation) fills the space
// between them, so the stylesheet needs their widths. Where the row's
// buttons do not fit there, it moves to a second row under the actions.
let chromeObserver = null;
function observeChrome() {
  chromeObserver?.disconnect();
  chromeObserver = null;
  const editorEl = document.querySelector(".editor");
  const heading = editorEl?.querySelector(".editor-heading");
  const actions = editorEl?.querySelector(".editor-actions");
  const nav = editorEl?.querySelector(".canvas-navigation");
  const tag = editorEl?.querySelector(".board-tag");
  const participants = editorEl?.querySelector(".canvas-top > .participants");
  if (!heading || !actions || typeof ResizeObserver !== "function") return;
  const measure = () => {
    if (!heading.isConnected) return chromeObserver?.disconnect();
    editorEl.style.setProperty("--heading-width", `${heading.offsetWidth}px`);
    editorEl.style.setProperty("--actions-width", `${actions.offsetWidth}px`);
    placeNoteColors();
    placeFrameFormats();
    if (!nav) return;
    const shown = [...nav.children].filter((b) => !b.hidden);
    // The board tag and the participants button share the row, 8px apart.
    // The tag counts at its full length, which does not change with the
    // layout, so the row cannot flap between the two.
    const label = tag?.querySelector(":scope > span");
    const tagWidth = tag
      ? tag.offsetWidth + (label ? label.scrollWidth - label.clientWidth : 0)
      : 0;
    const needed =
      shown.reduce((sum, b) => sum + b.offsetWidth, 0) +
      2 * Math.max(0, shown.length - 1) +
      8 +
      (tag ? tagWidth + 8 : 0) +
      (participants && !participants.hidden ? participants.offsetWidth + 8 : 0);
    const room =
      editorEl.clientWidth - heading.offsetWidth - actions.offsetWidth - 32;
    editorEl.classList.toggle("chrome-stacked", needed > room);
    liveUI.place();
  };
  chromeObserver = new ResizeObserver(measure);
  chromeObserver.observe(editorEl);
  chromeObserver.observe(heading);
  chromeObserver.observe(actions);
  // The tag changes with where the board is kept, and the participants
  // button shows once a session starts.
  for (const el of [tag, participants]) if (el) chromeObserver.observe(el);
  // Buttons such as Tags or Table cells come and go with the selection.
  if (nav && typeof MutationObserver === "function") {
    const watch = new MutationObserver(measure);
    watch.observe(nav, {
      subtree: true,
      childList: true,
      attributeFilter: ["hidden"],
    });
    const disconnect = chromeObserver.disconnect.bind(chromeObserver);
    chromeObserver.disconnect = () => {
      watch.disconnect();
      disconnect();
    };
  }
}
function editor() {
  tags.close();
  objectLinks.close();
  comments.close(false);
  textLinkPreview.close();
  canvasNavigation.finish();
  canvasNavigation.detach();
  minimap.detach();
  workshopTimer.detach();
  facilitation.detach();
  attention.detach();
  liveUI.detach();
  imageCrop.close(false);
  imageReplacement.close();
  commandPalette.close();
  pointerUp();
  finishTextEdit();
  boardSearch.close(false);
  framesPanel.close(false);
  document.title = current.title + " · Whiteboard";
  const shownStatus =
      status.board === current.id ? status.text : savedStatus(current),
    saveState = escape(shownStatus),
    saveTone = statusTone(shownStatus);
  // The canvas's top row comes before the tool rail so Tab reaches the
  // controls in the order they are laid out: header, top row, rail, then the
  // zoom controls at the bottom. Comment pins and link badges, which can
  // number hundreds, come after all of them.
  app.innerHTML = `<main class="editor"><h1 id="board-heading" class="sr-only" data-user-content>${escape(current.title)}</h1><p id="board-announcer" class="sr-only" role="status" aria-live="polite"></p><header class="editor-header"><div class="editor-heading">${button("arrow-left", "Back to boards", "home")}<span class="mini-brand">${brandImage}</span><div><input id="board-title" aria-label="Board name" maxlength="200" value="${escape(current.title)}"><span id="save-state" role="status" aria-live="polite" title="${saveState}"${saveTone ? ` data-tone="${saveTone}"` : ""}>${saveState}</span></div></div><div class="editor-actions">${button("command", "Command palette (Ctrl/Cmd K)", "commands")}<details class="preferences"><summary class="icon-btn" aria-label="${t("Preferences")}" title="${t("Preferences")}">${icon("settings-2")}</summary><div class="preferences-menu" role="group" aria-label="${t("Preferences")}">${themeControl(true)}${current.shared ? `<label class="preferences-check"><input type="checkbox" id="show-authors" ${showAuthors ? "checked" : ""}><span>${t("Show sticky note authors")}</span></label>` : ""}</div></details>${button(boardStorage(current) === "cloud" ? "cloud-check" : "cloud-upload", cloudSaveLabel(current), "cloud-save", `data-storage="${boardStorage(current)}"`)}${button("history", "Version history (Ctrl/Cmd Alt/Option Shift H)", "history")}${button("download", "Export board", "export")}${button("ellipsis", "More tools", "more-tools")}<button class="primary share-button" data-action="share" aria-label="Share board">${icon("users")}<span>Share</span></button>${account.markup()}</div></header><div class="canvas-wrap"><canvas id="canvas" role="img" aria-label="Whiteboard canvas. Use Board objects to select and edit objects with the keyboard." tabindex="0"></canvas><div id="hover-outline" class="hover-outline" aria-hidden="true" hidden></div><div id="board-outline" class="sr-only" role="group" aria-label="Canvas objects" aria-describedby="board-outline-hint"></div><p id="board-outline-hint" class="sr-only">Arrow keys, Home and End move between objects. Page Down and Page Up move to the next or previous frame.</p><div class="canvas-top"><span class="board-tag" data-storage="${boardStorage(current)}" title="${escape(storageLabel(current))}">${storageTag(current)}</span><button class="participants" data-action="participants" hidden></button><div class="canvas-navigation"><button type="button" class="icon-btn live-access" data-action="live" aria-label="${t("Live reactions and raise hand")}" title="${t("Live reactions and raise hand")}" aria-haspopup="dialog" aria-controls="live-popover" aria-expanded="false" hidden>${icon("smile-plus")}</button>${button("tags", "Tags", "tags", 'id="tag-access" hidden')}${button("columns-3", "Table cells", "table-cells", 'id="table-cell-access" hidden')}${button("arrow-up-right", "Object link", "object-link", 'id="object-link-access" hidden')}${button("link", "Text links", "text-links", 'id="text-link-access" hidden')}<button type="button" class="icon-btn timer-access" data-action="timer" data-timer-access aria-label="${t("Timer")}" title="${t("Timer")}" aria-controls="workshop-timer" aria-expanded="false">${icon("timer")}<span class="timer-badge" hidden></span></button><button type="button" class="icon-btn facilitation-access" data-action="facilitation" aria-label="${t("Facilitation")}" title="${t("Facilitation")}" aria-controls="facilitation-panel" aria-expanded="false">${icon("vote")}</button>${button("sparkles", "AI assistant", "ai")}${button("message-square", "Comments", "comments", 'aria-expanded="false" aria-controls="comments-panel"')}${button("search", "Find on board (Ctrl/Cmd F)", "board-search", 'aria-expanded="false" aria-controls="board-search"')}${button("map", "Minimap (M)", "minimap", 'aria-controls="minimap" aria-expanded="false" aria-pressed="false"')}${button("scan", "Frames and navigation", "frames", 'aria-expanded="false" aria-controls="frames-panel"')}${button("list", "Board objects", "objects")}${button("presentation", "Presentation", "present")}</div></div><div class="left-rail"><div class="tools panel" role="toolbar" aria-label="Drawing tools">${tools.map(([key, ic, label, shortcut]) => button(ic, `${label} (${shortcut})`, `tool-${key}`, `aria-pressed="${tool === key}"`)).join("")}<span class="tool-divider"></span>${button("layout-template", "Templates", "templates")}${button("shapes", "Shapes (S)", "shapes")}${button("image-plus", "Add image", "image")}${button("circle-plus", "Add content", "add-content", 'aria-haspopup="dialog"')}</div><div class="panel history-tools">${button("undo-2", "Undo (Ctrl/Cmd Z)", "undo")}${button("redo-2", "Redo (Ctrl/Cmd Shift Z)", "redo")}${button("magnet", "Snap to objects", "toggle-snapping", `aria-pressed="${snapping}"`)}</div></div><div class="drop-hint" aria-hidden="true"><strong>Drop content here</strong><span>Images, files, text, and links</span></div><div id="selection-tools" class="selection-tools panel" hidden></div><div id="quick-ports" role="group" hidden></div><section id="minimap" class="minimap panel" hidden></section><div class="canvas-bottom"><span id="tool-hint" class="tool-hint">Select and move · Double-click to edit · Space to pan</span><div class="panel zoom-tools">${button("maximize", "Fit board to screen", "fit")}<span class="tool-divider"></span>${button("minus", "Zoom out", "zoom-out")}<button class="zoom-label" data-action="reset-zoom" title="Reset zoom to 100 percent">100%</button>${button("plus", "Zoom in", "zoom-in")}<span class="tool-divider"></span>${button("circle-help", "Help and training", "help-center")}</div></div><div id="object-link-badges" class="object-link-badges" role="group" aria-label="Object links"></div><div id="comment-pins" class="comment-pins" role="group" aria-label="Board comments"></div></div></main>`;
  bindShared();
  account.bind();
  workshopTimer.bind();
  facilitation.bind(document.querySelector(".canvas-wrap"));
  attention.bind(document.querySelector(".canvas-wrap"));
  liveUI.bind(document.querySelector(".canvas-wrap"));
  quickPorts.bind(document.querySelector("#quick-ports"));
  const mindPorts = document.createElement("div");
  mindPorts.id = "mind-ports";
  mindPorts.setAttribute("role", "group");
  mindPorts.hidden = true;
  document.querySelector(".canvas-wrap").append(mindPorts);
  mindHandles.bind(mindPorts);
  const dimensions = document.createElement("output");
  dimensions.id = "object-dimensions";
  dimensions.className = "object-dimensions";
  dimensions.setAttribute("aria-label", t("Object dimensions"));
  dimensions.setAttribute("aria-live", "off");
  dimensions.hidden = true;
  document.querySelector(".canvas-wrap").append(dimensions);
  const collapsePorts = document.createElement("div");
  collapsePorts.id = "mind-collapse-ports";
  collapsePorts.setAttribute("role", "group");
  document.querySelector(".canvas-wrap").append(collapsePorts);
  mindCollapse.bind(collapsePorts);
  const mindHint = document.createElement("div");
  mindHint.id = "mind-drop-hint";
  mindHint.className = "mind-drop-hint panel";
  mindHint.setAttribute("role", "status");
  mindHint.hidden = true;
  document.querySelector(".canvas-wrap").append(mindHint);
  comments.bind(document.querySelector("#comment-pins"));
  objectLinks.bind(document.querySelector("#object-link-badges"));
  minimap.bind(document.querySelector("#minimap"));
  presenceLayer?.close();
  presenceLayer = new PresenceLayer(document.querySelector(".canvas-wrap"));
  renderParticipants();
  document
    .querySelector("#selection-tools")
    .addEventListener("keydown", (e) => {
      if (e.key !== "F10" || !e.altKey || e.ctrlKey || e.metaKey || !editing)
        return;
      const text = document.querySelector("#canvas-text-editor");
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      text.focus({ preventScroll: true });
    });
  document.querySelector("#board-title").onchange = (e) => {
    checkpoint();
    // The field's maxlength counts what the browser counts, which may be
    // more than the 200 code units a title may hold.
    current.title = truncate(e.target.value.trim(), 200) || t("Untitled board");
    e.target.value = current.title;
    showBoardTitle(current.title);
    save();
  };
  // Enter keeps the new name and Escape the old one, as in Miro; either
  // way the keyboard goes back to the board, so the next shortcut is not
  // typed into the name.
  document.querySelector("#board-title").onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    if (e.key === "Escape") e.target.value = current.title;
    document.querySelector("#canvas").focus({ preventScroll: true });
  };
  const canvas = document.querySelector("#canvas");
  transfer.bindCanvas(document.querySelector(".canvas-wrap"));
  canvasNavigation.bind(canvas);
  canvasNavigation.bindOverlays(
    document.querySelector(".canvas-wrap"),
    "#canvas-text-editor,#selection-tools,#table-editor,#comment-pins,#object-link-badges,#quick-ports,#mind-ports,#mind-collapse-ports",
  );
  canvas.addEventListener("pointerleave", () => {
    collaborationCursor = null;
    hovered = null;
    renderHover();
    sendPresence();
  });
  observeChrome();
  // Offer the guided tour once, without interrupting anyone's work.
  if (onboarding.shouldStart()) {
    const offer = document.createElement("div");
    offer.id = "tour-offer";
    offer.className = "tour-offer panel";
    offer.setAttribute("role", "region");
    offer.setAttribute("aria-label", t("Getting started"));
    offer.innerHTML = `<span>${t("New here?")}</span><button class="text-btn" data-action="tour">${t("Take a one-minute tour")}</button>${button("x", "Dismiss", "dismiss-tour")}`;
    document.querySelector(".canvas-wrap").append(offer);
    offer
      .querySelectorAll("[data-action]")
      .forEach((b) => (b.onclick = () => action(b.dataset.action)));
  }
  // The header is drawn again on a language change or a restored version
  // with the tool still chosen, so its hint and cursor follow that tool.
  showTool();
  draw();
}
function mindTargetText(text) {
  let end = Math.min(100, text.length);
  const previous = text.charCodeAt(end - 1),
    next = text.charCodeAt(end);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  )
    end--;
  return text.slice(0, end);
}

// Board coordinates end at ±1,000,000, so the view's center stays within
// them and what is placed in view lands on the board.
const BOARD_LIMIT = 1e6;
function keepViewOnBoard() {
  const r = document.querySelector("#canvas")?.getBoundingClientRect();
  if (!r || !(view.z > 0)) return;
  for (const [axis, size] of [
    ["x", r.width],
    ["y", r.height],
  ]) {
    const middle = (size / 2 - view[axis]) / view.z;
    if (Math.abs(middle) > BOARD_LIMIT)
      view[axis] = size / 2 - Math.sign(middle) * BOARD_LIMIT * view.z;
  }
}
// A collaborator's live preview shows while they keep sending it, and
// finished typing until their edit arrives or its hold ends; see the
// session's receive().
function showsPreview(person, now) {
  return person.settling ? now <= person.settleUntil : now - person.at < 2500;
}
// What someone is moving or drawing now, while their presence is recent, and
// what they finished, each until its edit arrives or its hold ends.
function shownPreviews(person, now) {
  const live = showsPreview(person, now) ? person.live || person.preview : [];
  const held = (person.held || []).filter((h) => now <= h.until);
  return held.length ? [...live, ...held.map((h) => h.item)] : live;
}
// Whether what others are moving, drawing or typing shows in this view:
// the object where it was, where it is going, or a line attached to it.
// Anywhere else, their cursors are all that needs drawing, so a busy room
// does not repaint the board for every packet from someone far away.
function previewsInView(people, now) {
  const ids = new Set(),
    previews = new Map();
  for (const person of people) {
    for (const preview of shownPreviews(person, now)) {
      ids.add(preview.id);
      if (!previews.has(preview.id)) previews.set(preview.id, preview);
    }
    if (person.text !== null && showsPreview(person, now) && person.editing)
      ids.add(person.editing);
  }
  if (!ids.size) return false;
  const r = document.querySelector("#canvas")?.getBoundingClientRect();
  if (!r?.width || !r?.height) return true;
  const margin = 240 / view.z,
    left = -view.x / view.z - margin,
    top = -view.y / view.z - margin,
    right = left + r.width / view.z + margin * 2,
    bottom = top + r.height / view.z + margin * 2;
  // Half the diagonal around the centre holds the object at any rotation.
  const meets = (i) => {
    if (![i?.x, i?.y, i?.w, i?.h].every(Number.isFinite)) return true;
    const reach = Math.hypot(i.w, i.h) / 2,
      x = i.x + i.w / 2,
      y = i.y + i.h / 2;
    return (
      x - reach <= right &&
      x + reach >= left &&
      y - reach <= bottom &&
      y + reach >= top
    );
  };
  const onBoard = new Set();
  for (const i of current.items) {
    if (ids.has(i.id)) {
      onBoard.add(i.id);
      if (
        meets(i) ||
        (previews.has(i.id) && meets({ ...i, ...previews.get(i.id) }))
      )
        return true;
    } else if (
      isConnector(i) &&
      (ids.has(i.startId) || ids.has(i.endId)) &&
      meets(i)
    )
      return true;
  }
  // Something still being drawn is not on the board yet.
  for (const [id, preview] of previews)
    if (!onBoard.has(id) && meets(preview)) return true;
  return false;
}
// The canvas is a picture to a screen reader, so what is selected, and
// what is deleted, is said aloud. A selection is said once it settles, not
// at each step of a drag.
const announced = { key: "", timer: null, id: null, message: "" };
function announce(message) {
  const region = document.querySelector("#board-announcer");
  if (!region) return;
  // Emptied first, so the same words said twice are read twice.
  region.textContent = "";
  setTimeout(() => {
    if (region.isConnected) region.textContent = message;
  }, 50);
}
// What an object selected alone is announced as, from the board as this
// person sees it: hidden objects are left out and face-down notes stay so.
const selectionMessage = (i) => labelled(t("Selection"), objectName(i));
function announceSelection() {
  // An object named in the announcement that a facilitator has since
  // hidden or turned face down is no longer named there.
  if (announced.id) {
    const shown = facilitation
      .masked(current)
      .items.find((i) => i.id === announced.id);
    if (!shown || selectionMessage(shown) !== announced.message) {
      const region = document.querySelector("#board-announcer");
      if (region?.textContent === announced.message) region.textContent = "";
      announced.id = null;
    }
  }
  const key = selection.size
    ? `${selection.size}:${selection.values().next().value}`
    : "";
  if (key === announced.key) return;
  announced.key = key;
  clearTimeout(announced.timer);
  if (!key) return;
  announced.timer = setTimeout(() => {
    // Mid-drag the next draw schedules it again.
    if (drag) return void (announced.key = "");
    const chosen =
      facilitation.masked(current)?.items.filter((i) => selection.has(i.id)) ||
      [];
    announced.id = chosen.length === 1 ? chosen[0].id : null;
    if (chosen.length)
      announce(
        (announced.message =
          chosen.length === 1
            ? selectionMessage(chosen[0])
            : plural(
                chosen.length,
                "{count} object selected",
                "{count} objects selected",
              )),
      );
  }, 300);
}
function draw() {
  if (!current) return;
  attention.redraw();
  announceSelection();
  keepViewOnBoard();
  if (focusedGroup) {
    const chosen = current.items.filter((i) => selection.has(i.id));
    if (chosen.some((i) => i.groupId && i.groupId !== focusedGroup)) {
      focusedGroup = selectionGroup(chosen);
      if (!focusedGroup) selection = descendants(current.items, selection);
    } else if (!chosen.some((i) => i.groupId === focusedGroup))
      focusedGroup = null;
  }
  workshopTimer.render();
  const mindScene = mindView.scene();
  // A chosen node folded away selects its collapsed branch instead; an
  // anchor left from an earlier, cleared selection selects nothing.
  if (
    selectionAnchor &&
    selection.has(selectionAnchor) &&
    mindScene.hidden.has(selectionAnchor)
  ) {
    selectionAnchor = mindScene.hidden.get(selectionAnchor);
    selection = descendants(current.items, new Set([selectionAnchor]));
  } else if (mindScene.hidden.size) {
    const ids = [...selection].filter(
      (id) =>
        !mindScene.hidden.has(id) || selection.has(mindScene.hidden.get(id)),
    );
    if (ids.length !== selection.size) selection = new Set(ids);
  }
  tableEditor.render();
  // Losing edit access mid-gesture restores every kind of editing drag.
  if (
    (drag?.duplicate ||
      drag?.mind ||
      drag?.groupFocus ||
      ["move", "resize", "rotate", "endpoint", "arrow", "pen"].includes(
        drag?.kind,
      )) &&
    isSharedReadOnly()
  ) {
    // Access ended mid-gesture: dropped with the reason, never silently.
    const explain = drag.changed || ["arrow", "pen"].includes(drag.kind);
    cancelTransform();
    if (explain) toast(sharedReadOnlyReason());
    return;
  }
  const ctx = document.querySelector("#canvas").getContext("2d");
  if (tool === "select")
    document.querySelector("#canvas").style.cursor = drag?.duplicate
      ? "copy"
      : drag?.kind === "rotate" || drag?.kind === "pan"
        ? "grabbing"
        : drag?.kind === "resize"
          ? resizeCursor(drag.box, drag.handle)
          : drag
            ? "default"
            : idleCursor() || "default";
  // Other tools show the hand while Space or the hand tool pans, closed
  // while the view is being dragged.
  else
    document.querySelector("#canvas").style.cursor =
      drag?.kind === "pan" ? "grabbing" : space ? "grab" : toolCursor();
  if (reflowTextItems(current.items, ctx)) {
    updateConnectors(current.items);
    if (drag?.kind === "rotate") {
      const byId = new Map(current.items.map((i) => [i.id, i]));
      if (
        drag.plan.items.some((original) => {
          const item = byId.get(original.id);
          return !item || item.w !== original.w || item.h !== original.h;
        })
      )
        return cancelTransform();
    }
    if (drag?.kind === "marquee") drag.index = null;
    minimap.invalidate();
  }
  const searching = boardSearch.isOpen();
  imageCrop.render();
  imageReplacement.refresh();
  const cropping = imageCrop.id();
  const selectionLocked = hasLocked(current.items, selection);
  let textPreview = false;
  let geometryPreview = false;
  const tablePreview = tableEditor.preview();
  // Others' recent drag previews and typing, looked up once per draw rather
  // than searched for every object; the first person listed wins.
  const now = Date.now(),
    remotePreviews = new Map(),
    remoteWriters = new Map();
  for (const person of collaborationPeople.values()) {
    for (const preview of shownPreviews(person, now))
      if (!remotePreviews.has(preview.id))
        remotePreviews.set(preview.id, preview);
    if (!showsPreview(person, now)) continue;
    if (
      person.editing &&
      person.text !== null &&
      !remoteWriters.has(person.editing)
    )
      remoteWriters.set(person.editing, person);
  }
  let liveItems = mindScene.items.map((i) => {
    if (tablePreview?.id === i.id) {
      geometryPreview = true;
      return tablePreview;
    }
    if (editing?.item.id === i.id && growsWithText(i)) {
      textPreview = true;
      // The same preview object each frame keeps its layout cached between
      // keystrokes, as collaborators' previews do.
      const preview = reusedPreview(i, {
        ...i,
        text: editing.input.value,
        textRuns: editing.input.textRuns,
        textBlocks: editing.input.textBlocks,
      });
      setObjectHeight(preview, autoHeightLayout(preview, ctx).height);
      return preview;
    }
    if (selection.has(i.id) && drag) return i;
    // No one moves or retypes a locked object, and a preview never turns an
    // object into a drawing of another kind.
    if (i.locked) return i;
    const shown = remotePreviews.get(i.id);
    const { type, color, points, ...place } = shown || {};
    const p = shown && type !== undefined && type !== i.type ? place : shown;
    const writer = remoteWriters.get(i.id);
    if (!p && !writer) return i;
    if (p) geometryPreview = true;
    const preview = reusedPreview(i, {
      ...i,
      ...p,
      ...(writer
        ? {
            text: writer.text,
            textBlocks:
              writer.text === i.text
                ? i.textBlocks
                : replacedBlocks(i, writer.text),
            textRuns:
              writer.text === i.text
                ? i.textRuns
                : replaceTextRuns(i.text || "", writer.text, i.textRuns),
          }
        : {}),
    });
    if (growsWithText(preview)) {
      setObjectHeight(preview, autoHeightLayout(preview, ctx).height);
      textPreview = true;
    }
    return preview;
  });
  // Drawings and connectors others are still creating.
  if (collaborationPeople.size) {
    const shown = new Set(liveItems.map((i) => i.id));
    for (const person of collaborationPeople.values()) {
      for (const preview of shownPreviews(person, now))
        if (preview.type && !shown.has(preview.id)) {
          shown.add(preview.id);
          liveItems.push(preview);
          geometryPreview = true;
        }
    }
  }
  if (textPreview || tablePreview || geometryPreview) {
    // Connector previews must never modify the saved scene or undo snapshots.
    liveItems = liveItems.map((i) => (i.type === "arrow" ? { ...i } : i));
    updateConnectors(liveItems);
  }
  liveItems = facilitation.conceal(
    facilitation.visible(liveItems.filter((i) => !mindScene.hidden.has(i.id))),
  );
  const resizeBox =
    selectionLocked || searching
      ? null
      : resizeBounds(liveItems, selection, selectionAnchor);
  const quickPreview = quickPorts.render();
  const badge =
    showDimensions &&
    !searching &&
    !editing &&
    !cropping &&
    !tableEditor.isOpen()
      ? dimensionBadge(
          resizeBox || dimensionBounds(liveItems, selection, selectionAnchor),
          view,
          document.querySelector("#canvas").getBoundingClientRect(),
        )
      : null;
  const dimensions = document.querySelector("#object-dimensions");
  dimensions.hidden = !badge;
  if (badge) {
    if (dimensions.textContent !== badge.label)
      dimensions.textContent = badge.label;
    dimensions.style.left = `${badge.x}px`;
    dimensions.style.top = `${badge.y}px`;
  }
  mindHandles.render();
  mindCollapse.render();
  const mindHint = document.querySelector("#mind-drop-hint");
  mindHint.hidden = !drag?.mind || !drag.active;
  if (!mindHint.hidden) {
    const candidate = drag.mindPreview;
    const target = current.items.find((i) => i.id === candidate?.id);
    const label = candidate?.error
      ? escape(t(candidate.error))
      : candidate
        ? `${escape(t("Release to attach to"))}: ${target?.text ? authoredTextHTML(target, mindTargetText(target.text)) : escape(t("Untitled node"))} · ${escape(t("Hold Ctrl/Cmd to move without reassigning"))}`
        : escape(
            t(
              drag.pointer?.ctrlKey || drag.pointer?.metaKey
                ? "Moving branch without reassigning"
                : "Drag onto another node to move this branch · Hold Ctrl/Cmd to move freely",
            ),
          );
    if (mindHint._label !== label) {
      mindHint._label = label;
      mindHint.innerHTML = label;
    }
  }
  paint(document.querySelector("#canvas"), liveItems, view, {
    coarse: true,
    frameLabels: true,
    authors: showAuthors ? noteAuthors() : null,
    grid: boardGrid.mode,
    mindBadges: false,
    tags: current.tags,
    repaint: draw,
    selection:
      searching || cropping || tableEditor.isOpen() ? new Set() : selection,
    groupFocus:
      !searching && !cropping && !tableEditor.isOpen() ? focusedGroup : null,
    cropId: cropping,
    editingId: editing?.item.id,
    selectionLocked,
    ...boardSearch.highlights(),
    // People who cannot change the board see no handles to change it with.
    resizeBox:
      editing ||
      cropping ||
      tableEditor.isOpen() ||
      drag?.kind === "rotate" ||
      isSharedReadOnly()
        ? null
        : resizeBox,
    resizeSides: resizeSides(),
    dropFrames: drag?.kind === "move" && drag.active ? drag.dropFrames : null,
    guides: imageCrop.guides() || drag?.guides,
    connectorTarget: drag?.targetId,
    rotationAngle: drag?.kind === "rotate" ? drag.angle : undefined,
    rotationBox:
      drag?.kind === "rotate"
        ? { ...drag.plan.box, rotation: drag.angle }
        : undefined,
    rotationDisabled: isSharedReadOnly() || !!editing,
    endpointsDisabled: isSharedReadOnly(),
    quickPreview,
    marquee: drag?.marquee || exportRegion,
  });
  warmTextLater(liveItems);
  renderOutline();
  const zoomLabel = document.querySelector(".zoom-label"),
    zoomText = Math.round(view.z * 100) + "%";
  if (zoomLabel.textContent !== zoomText) zoomLabel.textContent = zoomText;
  document.querySelector('[data-action="undo"]').disabled = collaboration
    ? !collaboration.shared.undo.undoStack.length ||
      collaboration.contentReadOnly
    : !history.past.length;
  document.querySelector('[data-action="redo"]').disabled = collaboration
    ? !collaboration.shared.undo.redoStack.length ||
      collaboration.contentReadOnly
    : !history.future.length;
  const chosenLive = liveItems.filter((i) => selection.has(i.id));
  renderSelectionTools(
    selectionLocked,
    resizeBox,
    resizeBox ||
      dimensionBounds(liveItems, selection, selectionAnchor) ||
      (chosenLive.length ? bounds(chosenLive) : null),
  );
  const linkedItem =
    selection.size === 1 &&
    current.items.find(
      (i) => selection.has(i.id) && i.textRuns?.some((r) => r.style.link),
    );
  // A control hidden while the keyboard is on it hands focus to the board,
  // as the selection toolbar does, rather than dropping it to the page.
  const hideAccess = (id, hidden) => {
    const button = document.querySelector(id);
    // Each change re-measures the header's top row, so a redraw that
    // changes nothing leaves the attribute alone.
    if (button.hidden === hidden) return;
    if (hidden && document.activeElement === button)
      document.querySelector("#canvas")?.focus({ preventScroll: true });
    button.hidden = hidden;
  };
  hideAccess("#text-link-access", !linkedItem || !!editing);
  textLinkPreview.update();
  comments.render();
  objectLinks.render();
  facilitation.render();
  contentTools.render();
  tags.render();
  hideAccess(
    "#tag-access",
    !current.tags?.length &&
      !current.items.some((i) => selection.has(i.id) && taggable(i)),
  );
  hideAccess("#object-link-access", !selectedLinkObject() || !!editing);
  renderHover();
  hideAccess("#table-cell-access", selectedLinkObject()?.type !== "table");
  minimap.render(
    liveItems,
    textPreview ||
      geometryPreview ||
      !!(drag && !["pan", "marquee", "region"].includes(drag.kind)),
  );
  commandPalette.refresh();
  positionTextEditor();
  updateTextFitStatus();
  presenceLayer?.render(
    facilitation.people(collaborationPeople),
    visibleItems(),
    view,
    collaboration?.session,
    attention.showCursors(),
    collaborationRoster.length,
  );
  attention.capture();
  planning.render();
  framesPanel.render();
  iconsRefresh();
  // Selections changed without the pointer, with the keyboard, the object
  // list or search, reach the others too, and a cleared one stops showing.
  if (collaboration && sharedSelectionKey() !== presenceSelection)
    sendPresence();
}
// The screen reader outline lists every object the person may see, by name
// and relationships.
function renderOutline() {
  const outline = document.querySelector("#board-outline");
  if (!outline) return;
  buildOutline(outline);
  // Which buttons are pressed is set on them in place: a marquee changes
  // the selection on every pointer move, which must not rebuild the outline.
  for (const id of outline.pressed)
    if (!selection.has(id)) {
      outline.pressed.delete(id);
      outline.buttons.get(id)?.setAttribute("aria-pressed", "false");
    }
  for (const id of selection) {
    const button = outline.buttons.get(id);
    if (button && !outline.pressed.has(id)) {
      outline.pressed.add(id);
      button.setAttribute("aria-pressed", "true");
    }
  }
  rovingOutline(outline);
}
// A board opened with more objects than this lists them in the outline a
// part at a time while the browser is idle, so that it shows at once.
const OUTLINE_LATER = 500;
function buildOutline(outline) {
  const outlined = facilitation.conceal(visibleItems());
  followEditedByOthers();
  // Panning, zooming and dragging redraw often and change no object's name
  // or relationships, so they are worked out only when the content moved
  // on, a language was chosen, what may be seen changed, or someone else
  // began or stopped typing in an object.
  const key = [
    outlined,
    outlined.length,
    language,
    contentVersion,
    editedByOthers.key,
  ];
  if (outline.key?.every((value, n) => value === key[n])) return;
  outline.key = key;
  return writeOutline(outline, outlineOrder(outlined));
}
function writeOutline(outline, outlined) {
  const relationships = objectRelationships(outlined);
  if (
    !outline.renderedParts &&
    outlined.length > OUTLINE_LATER &&
    !outline.contains(document.activeElement)
  )
    return writeOutlineLater(outline, outlined, relationships);
  const parts = outlined.map((i) => outlineButton(i, relationships.get(i.id)));
  // Compare with the buttons last written, object by object: most edits,
  // adding or deleting one among thousands too, change few of them, and
  // only those are written again, so one edit on a large board neither
  // parses nor lays out its whole list again.
  if (outline.renderedParts && patchOutline(outline, outlined, parts)) return;
  // The keyboard keeps its place in the list when the button it was on
  // is replaced, as after deleting that object.
  const focused = outline.contains(document.activeElement)
    ? [...outline.querySelectorAll("button")].indexOf(document.activeElement)
    : -1;
  outline.renderedParts = parts;
  outline.renderedIds = outlined.map((i) => i.id);
  outline.innerHTML = parts.join("");
  outline.finish = null;
  outline.removeAttribute("aria-busy");
  outline.removeAttribute("tabindex");
  outline.stop = null;
  outline.buttons = new Map();
  outline.pressed = new Set();
  for (const b of outline.querySelectorAll("button"))
    outline.buttons.set(b.dataset.id, b);
  if (focused >= 0) {
    const buttons = outline.querySelectorAll("button");
    (
      buttons[Math.min(focused, buttons.length - 1)] ||
      document.querySelector("#canvas")
    )?.focus({ preventScroll: true });
  }
}
// Brings the outline from the buttons last written to these, removing the
// buttons of objects gone or changed and writing those of objects new or
// changed in their places, while every other button stays as it is. An
// object that moved in the list is written again at its new place, unless
// the others moved around it instead. Says whether it did, which it does
// not when so much changed that writing the whole list is quicker, or when
// the list does not hold the buttons it last wrote.
function patchOutline(outline, outlined, parts) {
  const ids = outlined.map((i) => i.id),
    oldIds = outline.renderedIds,
    oldParts = outline.renderedParts,
    place = new Map(ids.map((id, n) => [id, n]));
  // Where each button that could stay is now, in the order it was written.
  const reused = [];
  for (let n = 0; n < oldIds.length; n++) {
    const m = place.get(oldIds[n]);
    if (m !== undefined && parts[m] === oldParts[n]) reused.push(m);
  }
  const staying = longestRise(reused);
  if (ids.length + oldIds.length - 2 * staying.size > 100) return false;
  if (ids.length === oldIds.length && staying.size === ids.length) return true;
  const removed = [];
  for (const id of oldIds)
    if (!staying.has(place.get(id))) {
      const button = outline.buttons.get(id);
      if (!button?.isConnected) return false;
      removed.push(button);
    }
  for (const n of staying)
    if (!outline.buttons.get(ids[n])?.isConnected) return false;
  // The keyboard keeps its place in the list, by position, as when the
  // whole list is written: on the next object after deleting the one it
  // was on.
  const active = document.activeElement,
    focused = outline.contains(active) ? oldIds.indexOf(active.dataset.id) : -1;
  for (const button of removed) {
    const description =
      button.nextElementSibling?.tagName === "SPAN"
        ? button.nextElementSibling
        : null;
    button.remove();
    description?.remove();
    outline.buttons.delete(button.dataset.id);
    outline.pressed.delete(button.dataset.id);
  }
  // From the end, each run of new buttons goes in before the button that
  // stays after it, or last.
  const template = document.createElement("template");
  let anchor = null;
  for (let n = ids.length - 1; n >= 0;) {
    if (staying.has(n)) {
      anchor = outline.buttons.get(ids[n--]);
      continue;
    }
    const last = n;
    while (n >= 0 && !staying.has(n)) n--;
    template.innerHTML = parts.slice(n + 1, last + 1).join("");
    for (const b of template.content.querySelectorAll("button"))
      outline.buttons.set(b.dataset.id, b);
    outline.insertBefore(template.content, anchor);
  }
  // A change in how many objects the board shows sends the Tab stop back
  // to the selection, or else the first object, as writing the whole list
  // does.
  if (ids.length !== oldIds.length) {
    outline.buttons.get(outline.stop)?.setAttribute("tabindex", "-1");
    outline.stop = null;
  }
  outline.renderedParts = parts;
  outline.renderedIds = ids;
  if (focused >= 0) {
    const target =
      outline.buttons.get(ids[Math.min(focused, ids.length - 1)]) ||
      document.querySelector("#canvas");
    if (target !== document.activeElement)
      target?.focus({ preventScroll: true });
  }
  return true;
}
// The places in the longest run of the given numbers that only rises, kept
// in their order: the buttons that can stay while the others move.
function longestRise(values) {
  const tails = [],
    previous = new Array(values.length);
  for (let n = 0; n < values.length; n++) {
    let low = 0,
      high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]] < values[n]) low = middle + 1;
      else high = middle;
    }
    previous[n] = low ? tails[low - 1] : -1;
    tails[low] = n;
  }
  const rise = new Set();
  for (let n = tails.at(-1) ?? -1; n >= 0; n = previous[n]) rise.add(values[n]);
  return rise;
}
// Writes the outline in parts between other work, marked busy for screen
// readers until it is whole. It is a Tab stop meanwhile: reaching it from
// the keyboard writes the rest at once. A change before it is whole starts
// it again.
function writeOutlineLater(outline, outlined, relationships) {
  const key = outline.key,
    parts = [];
  outline.renderedParts = null;
  outline.innerHTML = "";
  outline.stop = null;
  outline.buttons = new Map();
  outline.pressed = new Set();
  outline.setAttribute("aria-busy", "true");
  outline.tabIndex = 0;
  const write = (budget) => {
    if (outline.key !== key || !outline.isConnected) return;
    const until = performance.now() + budget;
    while (parts.length < outlined.length && performance.now() < until) {
      const html = [];
      for (
        let n = parts.length;
        n < Math.min(outlined.length, parts.length + 20);
        n++
      )
        html.push(
          outlineButton(outlined[n], relationships.get(outlined[n].id)),
        );
      parts.push(...html);
      const last = outline.lastElementChild;
      outline.insertAdjacentHTML("beforeend", html.join(""));
      for (
        let b = last ? last.nextElementSibling : outline.firstElementChild;
        b;
        b = b.nextElementSibling
      )
        if (b.dataset.id) outline.buttons.set(b.dataset.id, b);
    }
    if (parts.length < outlined.length) return later(() => write(8));
    outline.renderedParts = parts;
    outline.renderedIds = outlined.map((i) => i.id);
    outline.finish = null;
    outline.removeAttribute("aria-busy");
    outline.removeAttribute("tabindex");
    renderOutline();
  };
  const later = (f) =>
    window.requestIdleCallback
      ? requestIdleCallback(f, { timeout: 500 })
      : setTimeout(f, 0);
  outline.finish = () => write(Infinity);
  later(() => write(8));
}
// Collaborators' live previews reuse one copy per object from draw to draw.
// Text layouts are cached per object, so a copy made afresh each frame would
// fit and wrap every previewed text again, however little it changed.
// Each object's button in the screen reader outline, made again only when
// something its name shows changes.
const outlineButtons = new WeakMap();
// The outline is one Tab stop, however many objects the board holds: the
// object the keyboard was on, else the first selected, else the first.
// Arrow keys, Home and End move within it, so Tab reaches the tools.
function rovingOutline(outline) {
  if (!outline.roving) {
    outline.roving = true;
    // One listener for every object's button, however many there are.
    outline.addEventListener("click", (e) => {
      const b = e.target.closest?.("button[data-id]");
      if (!b || b.parentElement !== outline) return;
      selectItems(new Set([b.dataset.id]));
      const chosen = current.items.find((i) => i.id === b.dataset.id);
      if (chosen) revealObject(bounds([chosen]));
      draw();
      document.querySelector("#canvas").focus();
    });
    outline.addEventListener("focusin", (e) => {
      if (e.target === outline && outline.finish) {
        outline.finish();
        outline.buttons.get(outline.stop)?.focus({ preventScroll: true });
      }
      if (e.target.dataset?.id) rovingStop(outline, e.target.dataset.id);
    });
    outline.addEventListener("keydown", (e) =>
      rovingKeys(e, outline.querySelectorAll("button")),
    );
  }
  // While it is being written, the outline itself is the Tab stop.
  if (outline.finish) return;
  const active = document.activeElement;
  let stop = outline.contains(active) ? active.dataset.id : null;
  if (!stop)
    for (const id of selection)
      if (outline.buttons.has(id)) {
        stop = id;
        break;
      }
  if (!stop || !outline.buttons.has(stop))
    stop = outline.buttons.has(outline.stop)
      ? outline.stop
      : outline.querySelector("button")?.dataset.id;
  rovingStop(outline, stop);
}
// Arrow keys, Home and End move the keyboard through a list of buttons for
// objects, and Page Down and Page Up to the next or previous frame, which
// such a list shows before what it holds.
function rovingKeys(e, list) {
  const keys = [
    "ArrowDown",
    "ArrowRight",
    "ArrowUp",
    "ArrowLeft",
    "Home",
    "End",
    "PageDown",
    "PageUp",
  ];
  if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
  const buttons = [...list],
    at = buttons.indexOf(e.target);
  if (at < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const page = (step) => {
    for (let n = at + step; n >= 0 && n < buttons.length; n += step)
      if (buttons[n].hasAttribute("data-frame")) return n;
    return at;
  };
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? buttons.length - 1
        : e.key === "PageDown"
          ? page(1)
          : e.key === "PageUp"
            ? page(-1)
            : Math.max(
                0,
                Math.min(
                  buttons.length - 1,
                  at + (["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : -1),
                ),
              );
  buttons[next].focus();
}
function rovingStop(outline, id) {
  if (outline.stop === id && outline.buttons.get(id)?.tabIndex === 0) return;
  outline.buttons.get(outline.stop)?.setAttribute("tabindex", "-1");
  outline.buttons.get(id)?.setAttribute("tabindex", "0");
  outline.stop = id;
}
// A facilitator hears which objects participants cannot see, as the board
// marks them with a badge.
// Someone else typing in an object is said too, as its tag on the canvas
// is a picture a screen reader does not reach.
function objectDescription(i, relationship) {
  const concealed = facilitation.canHide() && facilitation.hidden(i.id),
    author = noteAuthors()?.get(i.id),
    editors = editedByOthers.names.get(i.id);
  return [
    concealed && t("Hidden from participants"),
    editors && t("Being edited by {names}").replace("{names}", escape(editors)),
    author && `${t("Added by")} ${escape(author)}`,
    relationship,
  ]
    .filter(Boolean)
    .join(". ");
}
// Who added each sticky note on a shared board, by name: the person a
// workshop recorded, or else the owner of the browser session whose edit
// first wrote the note, which the worker keeps for good and tells on
// request (see askCreators). Notes added under anonymous input, notes face
// down for this person, and, while anonymous input is on, notes no workshop
// recorded name no one. Worked out again only when the board, its members,
// or the known owners change, so the outline and each frame read it as a
// lookup.
const creators = { room: null, owners: new Map(), asked: new Set() };
let authorsKept = null;
function noteAuthors() {
  const session = collaboration;
  if (!current?.shared || !session || session.closed || !session.shared)
    return null;
  if (creators.room !== current.shared.room) {
    creators.room = current.shared.room;
    creators.owners = new Map();
    creators.asked = new Set();
    clearTimeout(creators.timer);
    creators.wanted = null;
  }
  const key = [
    current,
    contentVersion,
    current.workshop,
    boardMembers,
    collaborationRoster,
    creators.owners.size,
  ];
  if (authorsKept?.key.every((value, n) => value === key[n]))
    return authorsKept.found;
  const names = new Map();
  for (const p of collaborationRoster) names.set(p.user, p.username);
  for (const m of boardMembers) names.set(m.uuid, m.username);
  const w = current.workshop || {},
    anonymous = !!workshopSettings(current).anonymous,
    concealed = facilitation.concealedIds(),
    found = new Map(),
    missing = new Set();
  for (const i of current.items) {
    if (i.type !== "note" || concealed.has(i.id)) continue;
    const record = w[contributionKey(i.id)];
    if (record) {
      if (record.name && !record.anonymous) found.set(i.id, record.name);
      continue;
    }
    if (anonymous) continue;
    const client = session.shared.creator(i.id);
    if (client === undefined) continue;
    const owner = creators.owners.get(client);
    if (owner === undefined) {
      if (!creators.asked.has(client)) missing.add(client);
    } else if (names.has(owner)) found.set(i.id, names.get(owner));
  }
  if (missing.size) askCreators(session, missing);
  authorsKept = { key, found };
  return found;
}
// The owners of browser sessions not known yet, asked together once the
// board settles, never twice for the same one.
function askCreators(session, clients) {
  creators.wanted ??= new Set();
  for (const client of clients) {
    creators.asked.add(client);
    creators.wanted.add(client);
  }
  clearTimeout(creators.timer);
  creators.timer = setTimeout(async () => {
    const wanted = [...(creators.wanted || [])];
    creators.wanted = null;
    for (let n = 0; n < wanted.length; n += 500) {
      let owners;
      try {
        ({ owners } = await session.request("creators", {
          clients: wanted.slice(n, n + 500),
        }));
      } catch {
        // A worker from before this request, or one unreachable for now,
        // leaves those notes unnamed.
        return;
      }
      if (collaboration !== session || creators.room !== current?.shared?.room)
        return;
      for (const [client, owner] of Object.entries(owners || {}))
        if (typeof owner === "string")
          creators.owners.set(Number(client), owner);
    }
    contentVersion++;
    renderOutline();
    draw();
  }, 400);
}
// Who else is typing in which object, named as on the canvas, where an
// anonymous workshop calls everyone "Participant". Says whether that
// changed since it was last worked out.
let editedByOthers = { key: "", names: new Map() };
function followEditedByOthers() {
  const names = new Map();
  if (collaboration)
    for (const person of facilitation.people(collaborationPeople).values())
      if (person.editing)
        names.set(person.editing, [
          ...new Set([...(names.get(person.editing) || []), person.username]),
        ]);
  const key = JSON.stringify([...names]);
  if (key === editedByOthers.key) return false;
  editedByOthers = {
    key,
    names: new Map([...names].map(([id, list]) => [id, list.join(", ")])),
  };
  return true;
}
function outlineButton(i, relationship) {
  relationship = objectDescription(i, relationship);
  const key = [
    i.id,
    language,
    i.type,
    i.shape,
    i.locked,
    i.text,
    i.alt,
    i.fileName,
    i.cells,
    i.lang,
    i.textRuns,
    relationship,
  ];
  const cached = outlineButtons.get(i);
  if (cached?.key.every((value, n) => value === key[n])) return cached.html;
  // Named after the object rather than its place, so a button stays the
  // same when objects before it come or go. An object's id may hold spaces,
  // which would split the reference in two, so they are written as codes.
  const description = `outline-relationship-${escape(
    i.id.replace(
      /[%\t\n\f\r ]/g,
      (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
    ),
  )}`;
  const html = `<button data-id="${escape(i.id)}"${i.type === "frame" ? " data-frame" : ""} tabindex="-1" aria-pressed="false"${relationship ? ` aria-describedby="${description}"` : ""}>${objectNameHTML(i)}</button>${relationship ? `<span class="sr-only" id="${description}">${relationship}</span>` : ""}`;
  outlineButtons.set(i, { key, html });
  return html;
}
function reusedPreview(item, next) {
  let copy = previewCopies.get(item);
  if (!copy) previewCopies.set(item, (copy = {}));
  for (const key of Object.keys(copy)) if (!(key in next)) delete copy[key];
  return Object.assign(copy, next);
}
function sharedSelection() {
  const ids = [];
  for (const id of selection) {
    if (ids.length === 100) break;
    ids.push(id);
  }
  return ids;
}
function sharedSelectionKey() {
  return sharedSelection().join(" ") + "|" + (editing?.item.id || "");
}
function textRangeValue(i, key) {
  if (editing?.item.id === i.id) return editing.input.rangeStyle(key);
  const base = key === "bold" ? textStyle(i).bold : (i[key] ?? false);
  const values = textSegments(i.text || "", i.textRuns).map(
    (s) => s.style[key] ?? base,
  );
  return values.every((v) => v === (values[0] ?? base))
    ? (values[0] ?? base)
    : "mixed";
}
function updateTextRangeControls() {
  updateListControls();
  const linkButton = document.querySelector("#text-link-options");
  if (linkButton)
    linkButton.setAttribute(
      "aria-pressed",
      String(!!editing?.input.linkRange().url),
    );
  if (!editing) return;
  for (const key of ["bold", "italic", "underline", "strike"]) {
    document
      .querySelector(`#format-${key}`)
      ?.setAttribute(
        "aria-pressed",
        String(editing.input.rangeStyle(key) || false),
      );
  }
  for (const [id, key] of [
    ["text-color", "textColor"],
    ["text-highlight", "highlight"],
  ]) {
    const value = editing.input.rangeStyle(key);
    const control = document.getElementById(id);
    if (control)
      control.value =
        value && value !== "mixed"
          ? value
          : key === "textColor"
            ? editing.input.defaultTextColor
            : "#fff099";
  }
}
function closeTextLinkEditor(focus = true) {
  const controls = document.querySelector("#text-link-controls");
  if (controls) {
    controls.hidden = true;
    controls.replaceChildren();
  }
  document
    .querySelector("#text-link-options")
    ?.setAttribute("aria-expanded", "false");
  if (focus && editing) editing.input.focus({ preventScroll: true });
}
function openTextLinkEditor() {
  if (!canEditSelection()) return;
  if (!editing) {
    const chosen = current.items.filter(
      (i) => selection.has(i.id) && canEditText(i),
    );
    if (chosen.length !== 1) return;
    beginTextEdit(chosen[0]);
  }
  const editor = editing,
    input = editor.input,
    range = input.linkRange();
  input.setSelectionRange(range.start, range.end);
  const controls = document.querySelector("#text-link-controls");
  if (!controls) return;
  controls.hidden = false;
  document
    .querySelector("#text-link-options")
    .setAttribute("aria-expanded", "true");
  const removable = input.textRuns.some(
    (r) => r.style.link && r.start < range.end && r.end > range.start,
  );
  controls.innerHTML = `<form class="text-link-form"><label class="field">Link URL<input id="text-link-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="https://example.com" value="${escape(range.url)}" aria-describedby="text-link-error" required></label><p id="text-link-error" role="alert" hidden></p><div class="text-link-actions">${range.url ? `<a class="text-btn" href="${escape(range.url)}" target="_blank" rel="noopener noreferrer">Open link in new tab</a>` : ""}${removable ? '<button id="text-link-remove" class="text-btn" type="button">Remove link</button>' : ""}<button id="text-link-cancel" class="secondary" type="button">Cancel</button><button class="primary" type="submit">Apply link</button></div></form>`;
  const field = controls.querySelector("input"),
    error = controls.querySelector("[role=alert]");
  const apply = (url) => {
    if (
      editing !== editor ||
      !current?.items.includes(editor.item) ||
      !canEditSelection(new Set([editor.item.id]))
    )
      return closeTextLinkEditor(false);
    if (
      range.start !== range.end &&
      input.selectionStart === input.selectionEnd
    ) {
      error.hidden = false;
      error.textContent = t("The selected text changed. Select it again.");
      return;
    }
    input.setLink(url);
    closeTextLinkEditor();
    positionTextEditor();
    updateTextRangeControls();
    updateTextFitStatus();
  };
  controls.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    const url = textLinkURL(field.value, true);
    if (!url) {
      field.setAttribute("aria-invalid", "true");
      error.textContent = t("Enter a valid http or https link.");
      error.hidden = false;
      field.focus();
      return;
    }
    apply(url);
  };
  field.oninput = () => {
    field.removeAttribute("aria-invalid");
    error.hidden = true;
  };
  controls
    .querySelector("#text-link-remove")
    ?.addEventListener("click", () => apply(null));
  controls.querySelector("#text-link-cancel").onclick = () =>
    closeTextLinkEditor();
  controls.onkeydown = (e) => {
    if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      closeTextLinkEditor();
    }
  };
  translateUI(controls);
  updateTextRangeControls();
  field.focus();
  field.select();
}
function replacedBlocks(i, text) {
  const prev = i.text || "",
    { start, end, insert } = textDifference(prev, text);
  return spliceTextBlocks(prev, i.textBlocks, start, end, insert);
}
function updateListControls() {
  const chosen =
    current?.items.filter((i) => selection.has(i.id) && canEditText(i)) || [];
  const values = editing
    ? [editing.input.listStyle()]
    : chosen.flatMap((i) =>
        textParagraphs(i.text || "", i.textBlocks).map((p) => p.list || false),
      );
  for (const kind of ["bullet", "number"]) {
    const value =
      values.length && values.every((v) => v === kind)
        ? "true"
        : values.some((v) => v === kind || v === "mixed")
          ? "mixed"
          : "false";
    document
      .querySelector(`#list-${kind}`)
      ?.setAttribute("aria-pressed", value);
  }
}
function formatListSelection(kind, indent) {
  if (!canEditSelection()) return;
  if (editing) {
    if (indent) editing.input.indentList(indent);
    else editing.input.setList(kind);
    positionTextEditor();
    updateTextFitStatus();
    return;
  }
  const chosen = current.items.filter(
    (i) => selection.has(i.id) && canEditText(i),
  );
  const remove = chosen.every((i) =>
    textParagraphs(i.text || "", i.textBlocks).every((p) => p.list === kind),
  );
  const changes = chosen.map((i) => ({
    i,
    blocks: indent
      ? indentTextBlocks(
          i.text || "",
          i.textBlocks,
          0,
          (i.text || "").length,
          indent,
        )
      : formatTextBlocks(
          i.text || "",
          i.textBlocks,
          0,
          (i.text || "").length,
          remove ? null : kind,
        ),
  }));
  if (
    !changes.some(
      ({ i, blocks }) =>
        JSON.stringify(blocks) !== JSON.stringify(i.textBlocks || []),
    )
  )
    return;
  mutate(() =>
    changes.forEach(({ i, blocks }) => {
      if (blocks.length) i.textBlocks = blocks;
      else delete i.textBlocks;
    }),
  );
}
function renderSelectionTools(locked, resizeBox, anchor) {
  const panel = document.querySelector("#selection-tools");
  const chosen = current.items.filter((i) => selection.has(i.id));
  const updateStyleControls = () => {
    const paste = panel.querySelector("#paste-style");
    if (paste)
      paste.disabled =
        locked ||
        isSharedReadOnly() ||
        !chosen.some((i) => canPasteStyle(i, copiedStyle));
  };
  // The controls follow the selection and its content, not the view: a pan
  // or zoom with thousands of objects selected only moves the toolbar.
  const inputs = [
    current,
    current.items,
    current.items.length,
    contentVersion,
    [...selection].join(" "),
    selectionAnchor,
    focusedGroup,
    editing,
    locked,
    !!resizeBox,
    language,
    isSharedReadOnly(),
    isCommentReadOnly(),
    facilitation.canHide(),
    mindView.scene(),
  ];
  if (panel._inputs?.every((value, n) => value === inputs[n])) {
    updateStyleControls();
    updateTextRangeControls();
    placeSelectionTools(panel, anchor);
    return;
  }
  panel._inputs = inputs;
  const frame = chosen.find(
    (i) => i.id === selectionAnchor && i.type === "frame" && !i.groupId,
  );
  // A line without a label shows its line controls only, as in Miro; the
  // text controls come with a label, or while one is being typed.
  const textItems = locked
    ? []
    : chosen.filter(
        (i) =>
          canEditText(i) &&
          (i.type !== "arrow" || i.text || editing?.item.id === i.id),
      );
  // Tables take the size, family, weight, slant and alignment of all their
  // cells from the same controls.
  const tableItems = locked ? [] : chosen.filter((i) => i.type === "table");
  const formatItems = [...textItems, ...tableItems];
  const fitItems = textItems.filter(canAutoFitText);
  const heightItems = textItems.filter((i) => i.type === "text");
  const heightPressed = heightItems.every(growsWithText)
    ? "true"
    : heightItems.some(growsWithText)
      ? "mixed"
      : "false";
  const allAuto =
    formatItems.length && formatItems.every((i) => i.autoFontSize);
  const fitPressed = fitItems.every((i) => i.autoFontSize)
    ? "true"
    : fitItems.some((i) => i.autoFontSize)
      ? "mixed"
      : "false";
  // What the text controls show, the same for every object or "" when
  // mixed, read in one pass: with thousands of objects selected, reading
  // the objects again for each control and option took a tenth of a second.
  const shared = new Map();
  for (const i of formatItems) {
    const table = i.type === "table",
      style = table ? null : textStyle(i);
    const values = [
      ["family", table ? fontFamily(i) : style.family],
      ["size", table ? tableFontSize(i) : style.size],
      ["align", table ? tableTextAlign(i) : style.align],
      // While editing, the editor reports the formatting instead.
      ...(editing
        ? []
        : (table
            ? ["bold", "italic"]
            : ["bold", "italic", "underline", "strike"]
          ).map((key) => [key, textRangeValue(i, key)])),
    ];
    for (const [key, value] of values)
      if (!shared.has(key)) shared.set(key, value);
      else if (shared.get(key) !== value) shared.set(key, "");
  }
  const common = (key) => shared.get(key);
  // Scaling objects together scales their text by any factor; the field
  // shows the nearest whole size, which it accepts, not 25.9666….
  const shownSize =
    typeof common("size") === "number"
      ? Math.round(common("size"))
      : common("size");
  const lines = locked ? [] : chosen.filter((i) => i.type === "arrow");
  // Shapes take their border's dashes and thickness from the same fields.
  const bordered = locked ? [] : chosen.filter(hasBorder);
  const lineControl = (
    key,
    label,
    choices,
    fallback,
    items = lines,
    kind = "line",
  ) => {
    const value = items.every(
      (i) => (i[key] ?? fallback) === (items[0][key] ?? fallback),
    )
      ? (items[0][key] ?? fallback)
      : "";
    if (
      key === "lineWidth" &&
      value !== "" &&
      !choices.some(([v]) => v === value)
    )
      choices.push([value, String(value)]);
    return `<label class="line-control"><span>${label}</span><select id="${kind}-${key}" data-${kind}="${key}"><option value="" disabled ${value === "" ? "selected" : ""}>Mixed</option>${choices.map(([v, name]) => `<option value="${v}" ${String(value) === String(v) ? "selected" : ""}>${name}</option>`).join("")}</select></label>`;
  };
  const strokeChoices = () => [
    ["solid", "Solid"],
    ["dashed", "Dashed"],
    ["dotted", "Dotted"],
  ];
  const formats = [
    ["bold", "bold", "Bold"],
    ["italic", "italic", "Italic"],
    ["underline", "underline", "Underline"],
    ["strike", "strikethrough", "Strikethrough"],
  ];
  const groupButton = focusedGroup
    ? button("group", "Select whole group", "exit-group")
    : selectionGroup(chosen)
      ? button("mouse-pointer-2", "Select object in group", "enter-group")
      : "";
  // A labelled menu holds the less frequent actions, so the toolbar beside
  // the selection stays short. Each item keeps its action and id.
  const item = (name, label, action, extra = "") =>
    `<button class="menu-item" aria-label="${label}" title="${label}" data-action="${action}" ${extra}>${icon(name)}<span>${label}</span></button>`;
  const menu = (items) => {
    const entries = items.filter(Boolean);
    return entries.length
      ? `<button class="icon-btn" id="selection-more" aria-label="More options" title="More options" aria-expanded="false" aria-controls="selection-more-menu">${icon("ellipsis")}</button></div><div id="selection-more-menu" class="selection-menu" role="group" aria-label="More options" hidden>${entries.join("")}</div>`
      : "</div>";
  };
  const styleItems = [
    item(
      "copy-check",
      "Copy style (Ctrl/Cmd Alt/Option C)",
      "copy-style",
      `id="copy-style" ${chosen.length === 1 && canCopyStyle(chosen[0]) ? "" : "disabled"}`,
    ),
    item(
      "paint-roller",
      "Paste style (Ctrl/Cmd Alt/Option V)",
      "paste-style",
      'id="paste-style" disabled',
    ),
  ];
  const mindSource = selectedLinkObject();
  const linkItem = selectedLinkObject()
    ? item("arrow-up-right", "Object link", "object-link")
    : "";
  const hideItem = facilitation.canHide()
    ? [...selection].every((id) => facilitation.hidden(id))
      ? item("eye", "Show to participants", "show-objects")
      : item("eye-off", "Hide from participants", "hide-objects")
    : "";
  const collapseItem =
    mindSource && mindView.scene().branches.has(mindSource.id)
      ? item(
          mindView.scene().counts.has(mindSource.id) ? "plus" : "minus",
          mindView.scene().counts.has(mindSource.id)
            ? "Expand branch"
            : "Collapse branch",
          "mind-collapse",
        )
      : "";
  const mindButtons =
    !locked && mindSource?.mindMap
      ? button("git-branch-plus", "Add child node", "mind-child") +
        button("list-plus", "Add sibling node", "mind-sibling")
      : "";
  const filterItem =
    chosen.length > 1
      ? item(
          "list-filter",
          "Filter selection",
          "filter-selection",
          'id="filter-selection"',
        )
      : "";
  const mindItems =
    !locked && mindSource?.mindMap
      ? [
          item("network", "Mind map controls", "mind-settings"),
          item("git-pull-request-arrow", "Move mind map branch", "mind-move"),
        ]
      : [];
  const lineRow = lines.length
    ? `<div class="selection-row line-format-tools" role="group" aria-label="Connection line formatting">
      ${lineControl(
        "lineType",
        "Path",
        [
          ["straight", "Straight"],
          ["elbow", "Elbow"],
          ["curved", "Curved"],
        ],
        "straight",
      )}
      ${lineControl("lineStyle", "Stroke", strokeChoices(), "solid")}
      ${lineControl(
        "lineWidth",
        "Thickness",
        [
          [1, "1"],
          [2.5, "2.5"],
          [4, "4"],
          [6, "6"],
          [8, "8"],
          [12, "12"],
        ],
        2.5,
      )}
      ${lineControl("startCap", "Start", [...CAP_CHOICES], "none")}
      ${lineControl("endCap", "End", [...CAP_CHOICES], "arrow")}
      ${chosen.length === 1 ? button("sliders-horizontal", "Connection endpoints", "connection-endpoints") : ""}
    </div>`
    : "";
  const textRow = formatItems.length
    ? `<div class="selection-row text-format-tools" role="group" aria-label="Text formatting">
      <label class="font-family-control"><span class="sr-only">Font family</span><select id="font-family" aria-label="Font family"><option value="" disabled ${common("family") ? "" : "selected"}>Mixed</option>${FONT_FAMILIES.map((f) => `<option value="${f.id}" ${common("family") === f.id ? "selected" : ""}>${f.name}</option>`).join("")}</select></label>
      <label class="font-size-control"><span class="sr-only">${allAuto ? "Maximum font size" : "Font size"}</span><input id="font-size" type="number" min="8" max="100" step="1" value="${shownSize}" placeholder="Mixed" title="${allAuto ? "Maximum font size" : "Font size"}"></label>
      ${formats
        .slice(0, 2)
        .map(
          ([key, ic, label]) =>
            `<button id="format-${key}" class="icon-btn" data-format="${key}" aria-label="${label}" title="${label}" aria-pressed="${editing ? "false" : common(key) === "" ? "mixed" : common(key)}">${icon(ic)}</button>`,
        )
        .join("")}
      ${textItems.length ? `<button id="text-list-options" class="icon-btn" type="button" aria-label="Lists" title="Lists" aria-expanded="false" aria-controls="text-list-controls">${icon("list")}</button>` : ""}
      ${textItems.length === 1 && !tableItems.length ? `<button id="text-link-options" class="icon-btn" type="button" aria-label="Insert or edit text link" title="Insert or edit text link" aria-pressed="false" aria-expanded="false" aria-controls="text-link-controls">${icon("link")}</button>` : ""}
      <button id="text-style-options" class="icon-btn" type="button" aria-label="Text style" title="Text style" aria-expanded="false" aria-controls="text-style-popover" data-popover="text-style-popover">${icon("a-large-small")}</button>
      <div id="text-style-popover" class="selection-popover text-style-popover" role="group" aria-label="Text style" hidden>
      ${formats
        .slice(2, textItems.length ? 4 : 2)
        .map(
          ([key, ic, label]) =>
            `<button id="format-${key}" class="icon-btn" data-format="${key}" aria-label="${label}" title="${label}" aria-pressed="${editing ? "false" : common(key) === "" ? "mixed" : common(key)}">${icon(ic)}</button>`,
        )
        .join("")}
      <label class="text-align-control"><span class="sr-only">Text alignment</span><select id="text-align" title="Text alignment">${[
        ["", "Mixed"],
        ["left", "Align text left"],
        ["center", "Align text center"],
        ["right", "Align text right"],
      ]
        .map(
          ([value, label]) =>
            `<option value="${value}" ${common("align") === value ? "selected" : ""} ${value ? "" : "disabled"}>${label}</option>`,
        )
        .join("")}</select></label>
      ${
        fitItems.length
          ? `<label class="text-align-control"><span class="sr-only">Vertical alignment</span><select id="text-valign" title="Vertical alignment">${[
              ["", "Mixed"],
              ["top", "Align text top"],
              ["middle", "Align text middle"],
              ["bottom", "Align text bottom"],
            ]
              .map(
                ([value, label]) =>
                  `<option value="${value}" ${(fitItems.every((i) => textValign(i) === textValign(fitItems[0])) ? textValign(fitItems[0]) : "") === value ? "selected" : ""} ${value ? "" : "disabled"}>${label}</option>`,
              )
              .join("")}</select></label>`
          : ""
      }
      ${
        textItems.length
          ? `<label class="color-control" title="Text color"><span class="sr-only">Text color</span><input id="text-color" type="color" value="${textStyle(textItems[0]).color}"></label>
      <button class="text-btn" id="text-color-auto" aria-label="Automatic text color" title="Automatic text color">Auto</button>
      <label class="color-control" title="Highlight text"><span class="sr-only">Highlight text</span><input id="text-highlight" type="color" value="${textItems[0].highlight || "#fff099"}"></label>
      <button class="text-btn" id="text-highlight-clear" title="Remove highlight">No highlight</button>`
          : ""
      }
      ${fitItems.length ? `<button type="button" id="auto-fit-text" class="text-btn" aria-label="Auto-fit text" title="Shrink text to fit. The font size is the maximum." aria-pressed="${fitPressed}">Auto-fit</button>` : ""}
      ${heightItems.length ? `<button type="button" id="auto-height-text" class="text-btn" title="Adjust height to fit the text. Resize to change its width." aria-pressed="${heightPressed}">Auto height</button>` : ""}
      </div>
    </div>`
    : "";
  // Link and list settings, the fit status and the editing actions open
  // under the row.
  const textExtras = textItems.length
    ? `<div id="text-link-controls" hidden></div><div id="text-list-controls" class="selection-row list-format-tools" role="group" aria-label="List formatting" hidden>
      <button id="list-bullet" class="text-btn" type="button" aria-pressed="false">${icon("list")}<span>Bulleted list</span></button>
      <button id="list-number" class="text-btn" type="button" aria-pressed="false">${icon("list-ordered")}<span>Numbered list</span></button>
      <button id="list-outdent" class="icon-btn" type="button" aria-label="Decrease indent" title="Decrease indent">${icon("indent-decrease")}</button>
      <button id="list-indent" class="icon-btn" type="button" aria-label="Increase indent" title="Increase indent">${icon("indent-increase")}</button>
    </div>${fitItems.length || heightItems.length ? '<p id="text-fit-status" class="text-fit-status" role="status" hidden></p>' : ""}${editing ? `<div class="text-edit-actions"><span>Editing text</span><button class="secondary" data-action="cancel-text" aria-label="Cancel text edit">Cancel</button><button class="primary" data-action="finish-text">${icon("check")}Done</button></div>` : ""}`
    : "";
  const markup = !chosen.length
    ? ""
    : isSharedReadOnly() && !isCommentReadOnly()
      ? // Commenters can discuss and copy what they select, not change it.
        `<div class="selection-row object-tools">${button("message-square", "Add comment", "add-comment")}${button("image", "Copy as image (Ctrl/Cmd Shift C)", "copy-image")}${menu([filterItem])}`
      : locked
        ? `<div class="selection-row object-tools locked-selection"><span class="selection-badge" title="Unlock to move, edit, or delete.">${icon("lock-keyhole")}<span>Protected selection</span></span>${groupButton}${button("unlock", "Unlock selection", "lock", 'id="selection-lock"')}${button("copy", "Duplicate selection", "duplicate")}${button("message-square", "Add comment", "add-comment")}${menu([filterItem, linkItem, hideItem, item("image", "Copy as image (Ctrl/Cmd Shift C)", "copy-image"), ...styleItems])}`
        : `${textRow}${lineRow}<div class="selection-row object-tools">${selection.size > 1 ? `<span class="selection-count">${selection.size} selected</span>` : ""}${groupButton}${
            // Text, frames and images have no fill to colour. The swatches
            // open from one button showing the current colour.
            chosen.some(paintsColor)
              ? `<button id="fill-options" class="icon-btn fill-options" type="button" aria-label="Fill color" title="Fill color" aria-expanded="false" aria-controls="fill-popover" data-popover="fill-popover" style="--swatch:${chosen.find(paintsColor).color || COLORS[0]}"><span class="fill-chip" aria-hidden="true"></span></button><div id="fill-popover" class="selection-popover fill-popover" role="group" aria-label="Fill color" hidden>${COLORS.map((c, n) => `<button class="swatch" style="--swatch:${c}" data-color="${c}" aria-label="${["Butter", "Sage", "Blue", "Lilac", "Peach", "White"][n]} color"></button>`).join("")}<label class="color-control" title="Custom color"><span class="sr-only">Custom color</span><input id="fill-color" type="color" value="${chosen.find(paintsColor).color || COLORS[0]}"></label></div>`
              : ""
          }${
            // A shape's border can be dashed or dotted, as for a boundary,
            // or thicker for emphasis.
            bordered.length
              ? `<button id="border-options" class="icon-btn" type="button" aria-label="Border" title="Border" aria-expanded="false" aria-controls="border-popover" data-popover="border-popover">${icon("square-dashed")}</button><div id="border-popover" class="selection-popover border-popover" role="group" aria-label="Border" hidden>${lineControl("lineStyle", "Stroke", strokeChoices(), "solid", bordered, "border")}${lineControl(
                  "lineWidth",
                  "Thickness",
                  [1, 2, 3, 4, 6, 8, 12].map((n) => [n, String(n)]),
                  1,
                  bordered,
                  "border",
                )}</div>`
              : ""
          }${mindButtons}${button("pencil", "Edit selected object", "edit")}${chosen.length === 1 && chosen[0].type === "image" ? button("crop", "Crop image", "crop-image") : ""}${chosen.some(canSwitchShape) ? button("shapes", "Change shape", "change-shape") : ""}${
            // Several objects or groups line up from one button, as in Miro.
            layoutUnits(current.items, selection, selectionOptions()).length > 1
              ? button(
                  "align-start-vertical",
                  "Align and distribute",
                  "align-menu",
                  'id="selection-align" aria-haspopup="menu"',
                )
              : ""
          }${button("copy", "Duplicate selection", "duplicate")}${button("message-square", "Add comment", "add-comment")}${button("lock-keyhole", frame ? "Lock frame" : focusedGroup ? "Lock group" : "Lock selection", "lock", 'id="selection-lock"')}${button("trash-2", "Delete selection", "delete")}${menu(
            [
              collapseItem,
              ...mindItems,
              // A timeline placed from the Tasks view is a copy of the plan
              // that this draws again from the tasks.
              planning.timelineSelected()
                ? item("refresh-cw", "Refresh timeline", "timeline-refresh")
                : "",
              linkItem,
              chosen.some(taggable) ? item("tags", "Tags", "tags") : "",
              chosen.some((i) => i.type === "note")
                ? item("group", "Cluster sticky notes", "cluster")
                : "",
              chosen.length === 1 && chosen[0].type === "image"
                ? item("image-plus", "Replace image", "replace-image")
                : "",
              hideItem,
              item("sliders-horizontal", "Object properties", "properties"),
              resizeBox
                ? item(
                    "scaling",
                    frame ? "Resize frame" : "Resize selection",
                    "resize",
                  )
                : "",
              rotationBox(current.items, selection)
                ? item("rotate-cw", "Rotate selection", "rotate")
                : "",
              item("bring-to-front", "Bring to front", "front"),
              item("layers", "Organize selection", "organize"),
              item(
                "layout-template",
                "Save as reusable content",
                "save-snippet",
              ),
              filterItem,
              item("image", "Copy as image (Ctrl/Cmd Shift C)", "copy-image"),
              ...styleItems,
              chosen.some(canClearContent)
                ? item(
                    "eraser",
                    "Clear content (Ctrl/Cmd Backspace)",
                    "clear-content",
                  )
                : "",
            ],
          )}
    ${textExtras}`;
  panel.hidden = !chosen.length;
  const hiddenCount = [...selection].filter((id) =>
    mindView.scene().hidden.has(id),
  ).length;
  const markupKey = markup + hiddenCount;
  if (panel._markup === markupKey) {
    // Another selection with the same toolbar starts with popovers closed.
    if (panel._popover && panel._popover.key !== [...selection].join(" "))
      closeSelectionPopover(panel);
    updateStyleControls();
    updateTextRangeControls();
    placeSelectionTools(panel, anchor);
    return;
  }
  // The keyboard returns to the same control once the toolbar is drawn
  // again, such as a colour that was just applied.
  const focused = panel.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusKey = ["id", "data-color", "data-format", "data-action"].find(
    (name) => focused?.getAttribute(name),
  );
  const focusValue = focusKey && focused.getAttribute(focusKey);
  const focusedPopover = focused?.closest(".selection-popover:not([hidden])");
  if (focusedPopover && !panel._popover)
    panel._popover = { id: focusedPopover.id, key: [...selection].join(" ") };
  panel._markup = markupKey;
  panel.innerHTML = markup;
  const row = panel.querySelector(".selection-row");
  if (row) {
    const more = panel.querySelector("#selection-more-menu");
    if (!locked && !isSharedReadOnly() && chosen.length === 1 && more) {
      more.insertAdjacentHTML(
        "beforeend",
        `<button id="content-language-options" class="menu-item" type="button" aria-expanded="false" aria-controls="content-language-controls">${icon("languages")}<span>${t("Content language")}</span></button>`,
      );
      const controls = document.createElement("div");
      controls.id = "content-language-controls";
      controls.hidden = true;
      panel.append(controls);
      panel.querySelector("#content-language-options").onclick =
        openContentLanguage;
    }
    if (more) bindSelectionMenu(panel, more);
    if (groupButton) {
      const hint = document.createElement("p");
      hint.className = "locked-hint";
      hint.textContent = t(
        focusedGroup
          ? "Inside group · Double-click to edit · Escape selects the group"
          : "Double-click an object to select it within this group.",
      );
      panel.append(hint);
    }
    if (hiddenCount) {
      const hint = document.createElement("p");
      hint.className = "locked-hint";
      hint.textContent = `${hiddenCount} ${t("hidden in collapsed branches")}`;
      panel.append(hint);
    }
  }
  updateStyleControls();
  panel.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = () => {
        if (b.classList.contains("menu-item")) closeSelectionMenu(panel, true);
        action(b.dataset.action);
      }),
  );
  const alignButton = panel.querySelector("#selection-align");
  if (alignButton)
    alignButton.onclick = (e) => {
      if (contextMenu.isOpen()) return contextMenu.close(true);
      const r = alignButton.getBoundingClientRect();
      contextMenu.open({
        x: r.left,
        y: r.bottom + 6,
        scope: ALIGN_MENU,
        // From the keyboard, the first choice takes focus.
        focus: e.detail === 0,
        from: alignButton,
      });
    };
  panel
    .querySelectorAll("[data-color]")
    .forEach((b) => (b.onclick = () => fillSelection(b.dataset.color)));
  panel.querySelectorAll("[data-line]").forEach((input) => {
    input.onchange = () => {
      if (!canEditSelection()) return;
      // The same controls stay for another connector with the same style,
      // and an undo or cancelled drag replaces the objects, so the lines
      // are found when they change.
      const targets = current.items.filter(
        (i) => selection.has(i.id) && i.type === "arrow",
      );
      const key = input.dataset.line;
      const value = key === "lineWidth" ? Number(input.value) : input.value;
      if (targets.every((i) => i[key] === value)) return;
      mutate(() =>
        targets.forEach((i) => {
          i[key] = value;
        }),
      );
      rememberStyle("arrow", { [key]: value });
    };
  });
  panel.querySelectorAll("[data-border]").forEach((input) => {
    input.onchange = () => {
      if (!canEditSelection()) return;
      const targets = current.items.filter(
        (i) => selection.has(i.id) && hasBorder(i),
      );
      const key = input.dataset.border;
      const value = key === "lineWidth" ? Number(input.value) : input.value;
      const usual = key === "lineWidth" ? 1 : "solid";
      if (targets.every((i) => (i[key] ?? usual) === value)) return;
      // The usual border is the absence of one set, so boards keep only
      // the borders people changed.
      mutate(() =>
        targets.forEach((i) => {
          if (value === usual) delete i[key];
          else i[key] = value;
        }),
      );
    };
  });
  const fill = panel.querySelector("#fill-color");
  if (fill) fill.onchange = () => fillSelection(fill.value);
  panel
    .querySelectorAll("[data-format]")
    .forEach((b) => (b.onclick = () => formatSelection(b.dataset.format)));
  const listOptions = panel.querySelector("#text-list-options"),
    listControls = panel.querySelector("#text-list-controls");
  const linkOptions = panel.querySelector("#text-link-options");
  if (linkOptions) linkOptions.onclick = openTextLinkEditor;
  if (listOptions) {
    listOptions.onclick = () => {
      listControls.hidden = !listControls.hidden;
      listOptions.setAttribute("aria-expanded", String(!listControls.hidden));
      if (editing) {
        // The taller toolbar may push the view down to keep the caret in
        // sight; the canvas then follows along with the editor.
        const { x, y } = view;
        revealTextCaret();
        if (view.x !== x || view.y !== y) draw();
        else positionTextEditor();
      }
    };
    listControls.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        listControls.hidden = true;
        listOptions.setAttribute("aria-expanded", "false");
        listOptions.focus();
      }
    };
    for (const kind of ["bullet", "number"])
      panel.querySelector(`#list-${kind}`).onclick = () =>
        formatListSelection(kind);
    panel.querySelector("#list-indent").onclick = () =>
      formatListSelection(null, 1);
    panel.querySelector("#list-outdent").onclick = () =>
      formatListSelection(null, -1);
  }
  const size = panel.querySelector("#font-size");
  const family = panel.querySelector("#font-family");
  if (family)
    family.onchange = () => formatSelection("fontFamily", family.value);
  if (size)
    size.onchange = () => {
      if (!size.value || !size.reportValidity()) return;
      formatSelection("fontSize", Number(size.value));
    };
  const align = panel.querySelector("#text-align");
  if (align) align.onchange = () => formatSelection("textAlign", align.value);
  const valign = panel.querySelector("#text-valign");
  if (valign)
    valign.onchange = () => formatSelection("textValign", valign.value);
  const color = panel.querySelector("#text-color");
  if (color) color.onchange = () => formatSelection("textColor", color.value);
  const auto = panel.querySelector("#text-color-auto");
  if (auto) auto.onclick = () => formatSelection("textColor", null);
  const highlight = panel.querySelector("#text-highlight");
  if (highlight)
    highlight.onchange = () => formatSelection("highlight", highlight.value);
  const clearHighlight = panel.querySelector("#text-highlight-clear");
  if (clearHighlight)
    clearHighlight.onclick = () => formatSelection("highlight", null);
  const fit = panel.querySelector("#auto-fit-text");
  if (fit)
    fit.onclick = () => formatSelection("autoFontSize", fitPressed !== "true");
  const height = panel.querySelector("#auto-height-text");
  if (height)
    height.onclick = () =>
      formatSelection("autoHeight", heightPressed !== "true");
  bindSelectionPopovers(panel);
  if (focused) {
    const next =
      focusKey &&
      !panel.hidden &&
      [...panel.querySelectorAll(`[${focusKey}]`)].find(
        (control) => control.getAttribute(focusKey) === focusValue,
      );
    const closedPopover = next && next.closest(".selection-popover[hidden]");
    if (next && next.closest("#selection-more-menu")?.hidden)
      panel.querySelector("#selection-more")?.focus({ preventScroll: true });
    else if (closedPopover)
      panel
        .querySelector(`[data-popover="${closedPopover.id}"]`)
        ?.focus({ preventScroll: true });
    else if (next) next.focus({ preventScroll: true });
    // Without its control, as after deleting the selection, the keyboard
    // stays on the board instead of the page. A text edit keeps going.
    else if (!editing)
      document.querySelector("#canvas")?.focus({ preventScroll: true });
  }
  updateTextRangeControls();
  placeSelectionTools(panel, anchor);
}
// Below the floating header and the canvas navigation row, which may have a
// row of its own.
const TOOLBAR_TOP_INSET = 66;
const toolbarTopInset = () =>
  document.querySelector(".editor.chrome-stacked")
    ? TOOLBAR_TOP_INSET + 56
    : TOOLBAR_TOP_INSET;
// Quick-connect handles reach 52 pixels outside a single object; the toolbar
// sits beyond them so moving to it never opens a handle.
const TOOLBAR_GAP = 14,
  TOOLBAR_PORT_GAP = 58;
function floatingToolbar(rect) {
  return rect.width > 760;
}
// Keeps the toolbar beside the selection: above it, below it when the top of
// the view is full, and inside the canvas clear of the tool rail, open side
// panels, and the bottom controls. Phones keep it docked under the header.
function placeSelectionTools(panel, box) {
  const rect = document.querySelector("#canvas").getBoundingClientRect();
  panel.classList.toggle(
    "is-interacting",
    !!drag &&
      (drag.active ||
        ["marquee", "region", "pan", "erase", "arrow", "endpoint"].includes(
          drag.kind,
        )),
  );
  const floating = !panel.hidden && !!box && floatingToolbar(rect);
  panel.classList.toggle("is-floating", floating);
  panel._anchor = floating ? box : null;
  if (!floating) {
    panel.style.transform = "";
    panel.style.maxWidth = "";
    return;
  }
  if (!panel._observer && typeof ResizeObserver === "function") {
    panel._observer = new ResizeObserver(() => {
      if (panel._anchor && panel.isConnected)
        placeSelectionTools(panel, panel._anchor);
    });
    panel._observer.observe(panel);
  }
  const visual = objectBounds(box, box.rotation || 0);
  const left = view.x + visual.x * view.z,
    right = left + visual.w * view.z,
    bottom = view.y + (visual.y + visual.h) * view.z;
  // Zoomed out, a selected frame's name sits above it, which the toolbar
  // keeps clear of as it does the frame.
  let top = view.y + visual.y * view.z;
  for (const label of shownFrameLabels())
    if (selection.has(label.id)) top = Math.min(top, label.y);
  const margin = 12;
  const rail = document.querySelector(".canvas-wrap .left-rail");
  const railRect = rail?.getBoundingClientRect();
  const minX =
    railRect?.width && railRect.top < rect.top + rect.height / 2
      ? railRect.right - rect.left + margin
      : margin;
  let limit = rect.width - margin;
  for (const side of document.querySelectorAll(
    "#comments-panel, #tags-panel, #object-links-panel, #facilitation-panel, #task-panel, #frames-panel",
  )) {
    const r = side.getBoundingClientRect();
    if (r.width) limit = Math.min(limit, r.left - rect.left - margin);
  }
  const gap = document.querySelector("#quick-ports")?.hidden
    ? TOOLBAR_GAP
    : TOOLBAR_PORT_GAP;
  const offer = document.querySelector("#tour-offer")?.getBoundingClientRect();
  const place = (minX) => {
    // Between the tool rail and the edge or a side panel the toolbar may be
    // narrower than it would like: its rows then scroll rather than run off
    // the canvas, as on a tablet.
    const room = `${Math.max(200, Math.floor(limit - minX))}px`;
    if (panel.style.maxWidth !== room) panel.style.maxWidth = room;
    const width = panel.offsetWidth,
      height = panel.offsetHeight;
    const maxX = limit - width;
    const x = Math.max(minX, Math.min(maxX, (left + right) / 2 - width / 2));
    // The getting-started offer floats above the bottom controls; where the
    // two would meet, the toolbar stays above it.
    const aboveOffer =
      offer?.height &&
      offer.left < rect.left + x + width &&
      offer.right > rect.left + x
        ? offer.top - rect.top - margin - height
        : Infinity;
    const lowest = Math.min(rect.height - height - 72, aboveOffer);
    let y = Math.min(top - gap - height, aboveOffer);
    if (y < toolbarTopInset())
      y =
        bottom + gap <= lowest
          ? bottom + gap
          : Math.max(toolbarTopInset(), Math.min(lowest, y));
    return { x, y, width, height };
  };
  let spot = place(minX);
  // The open timer stands beside the tool rail; a toolbar that would cross
  // it moves to its right instead.
  const timer = document
    .querySelector(".canvas-wrap > #workshop-timer:not([hidden])")
    ?.getBoundingClientRect();
  if (
    timer?.width &&
    timer.left < rect.left + spot.x + spot.width &&
    timer.right > rect.left + spot.x &&
    timer.top < rect.top + spot.y + spot.height &&
    timer.bottom > rect.top + spot.y
  )
    spot = place(Math.max(minX, timer.right - rect.left + margin));
  panel.style.transform = `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px)`;
}
// A side panel or the timer opening or closing changes the room beside the
// selection, so a floating toolbar takes its place again.
function reflowSelectionTools() {
  const panel = document.querySelector("#selection-tools");
  if (panel?._anchor && !panel.hidden)
    placeSelectionTools(panel, panel._anchor);
}
function closeSelectionMenu(panel, focus = false) {
  const menu = panel.querySelector("#selection-more-menu"),
    more = panel.querySelector("#selection-more");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  more?.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", panel._menuOutside, true);
  if (focus) more?.focus({ preventScroll: true });
}
// Colour and text style settings open in small popovers under their
// buttons. One stays open while the toolbar is drawn again for the same
// selection, as after choosing a colour.
function closeSelectionPopover(panel, focus = false) {
  const pop = panel.querySelector(".selection-popover:not([hidden])");
  panel._popover = null;
  document.removeEventListener("pointerdown", panel._popoverOutside, true);
  if (!pop) return;
  pop.hidden = true;
  const toggle = panel.querySelector(`[data-popover="${pop.id}"]`);
  toggle?.setAttribute("aria-expanded", "false");
  if (focus) toggle?.focus({ preventScroll: true });
}
function openSelectionPopover(panel, toggle, focus = false) {
  const pop = panel.querySelector(`#${toggle.dataset.popover}`);
  if (!pop) return;
  closeSelectionMenu(panel);
  closeSelectionPopover(panel);
  pop.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  panel._popover = { id: pop.id, key: [...selection].join(" ") };
  const t = toggle.getBoundingClientRect(),
    p = panel.getBoundingClientRect(),
    canvas = document.querySelector("#canvas")?.getBoundingClientRect();
  pop.style.left = `${Math.round(Math.max(0, Math.min(t.left - p.left, p.width - pop.offsetWidth)))}px`;
  // It opens upward when it would run past the canvas below and there is
  // more room above the toolbar than under it.
  pop.classList.toggle(
    "is-above",
    !!canvas?.height &&
      p.bottom + pop.offsetHeight + 14 > canvas.bottom &&
      p.top - canvas.top > canvas.bottom - p.bottom,
  );
  panel._popoverOutside ??= (e) => {
    const open = panel.querySelector(".selection-popover:not([hidden])");
    if (
      open &&
      !open.contains(e.target) &&
      !panel.querySelector(`[data-popover="${open.id}"]`)?.contains(e.target)
    )
      closeSelectionPopover(panel);
  };
  document.addEventListener("pointerdown", panel._popoverOutside, true);
  if (focus)
    pop
      .querySelector("button:not(:disabled), input, select")
      ?.focus({ preventScroll: true });
}
function bindSelectionPopovers(panel) {
  for (const toggle of panel.querySelectorAll("[data-popover]")) {
    const pop = panel.querySelector(`#${toggle.dataset.popover}`);
    if (!pop) continue;
    // From the keyboard the first setting takes focus.
    toggle.onclick = (e) =>
      pop.hidden
        ? openSelectionPopover(panel, toggle, e.detail === 0)
        : closeSelectionPopover(panel, true);
    pop.onkeydown = (e) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      closeSelectionPopover(panel, true);
    };
  }
  const open = panel._popover;
  if (!open) return;
  const toggle =
    open.key === [...selection].join(" ") &&
    panel.querySelector(`[data-popover="${open.id}"]`);
  if (toggle) openSelectionPopover(panel, toggle);
  else closeSelectionPopover(panel);
}
function bindSelectionMenu(panel, menu) {
  const more = panel.querySelector("#selection-more");
  panel._menuOutside ??= (e) => {
    // The button's own click toggles the menu; closing here first would
    // let that click reopen it.
    if (
      !panel.querySelector("#selection-more-menu")?.contains(e.target) &&
      !panel.querySelector("#selection-more")?.contains(e.target)
    )
      closeSelectionMenu(panel);
  };
  more.onclick = () => {
    if (!menu.hidden) return closeSelectionMenu(panel, true);
    closeSelectionPopover(panel);
    menu.hidden = false;
    more.setAttribute("aria-expanded", "true");
    // The menu opens where it has the most room, inside the canvas.
    const canvas = document.querySelector("#canvas").getBoundingClientRect(),
      toolbar = panel.getBoundingClientRect();
    const below = canvas.bottom - toolbar.bottom - 14,
      above = toolbar.top - canvas.top - toolbarTopInset() - 14;
    menu.classList.toggle(
      "is-above",
      menu.scrollHeight > below && above > below,
    );
    menu.style.maxHeight = `${Math.max(120, Math.floor(menu.classList.contains("is-above") ? above : below))}px`;
    document.addEventListener("pointerdown", panel._menuOutside, true);
    menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  };
  menu.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSelectionMenu(panel, true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      const at = items.indexOf(document.activeElement);
      items
        .at((at + (e.key === "ArrowDown" ? 1 : -1)) % items.length)
        ?.focus({ preventScroll: true });
    }
  };
  more.onkeydown = (e) => {
    if (e.key === "ArrowDown" && menu.hidden) {
      e.preventDefault();
      more.onclick();
    }
  };
}
function clearSelectionContent() {
  if (!selection.size) return toast("Select objects first.");
  const chosen = current.items.filter((i) => selection.has(i.id));
  if (!chosen.some(canClearContent))
    return toast("Select sticky notes or shapes to clear.");
  if (!canEditSelection()) return;
  if (!chosen.some(hasClearableContent))
    return toast("The selected content is already empty.");
  mutate(() => clearContent(current.items, selection));
  toast("Content cleared. Undo restores it.");
}
// Text, frames and images draw no fill, so a colour would change nothing.
const paintsColor = (i) => !["text", "frame", "image"].includes(i.type);
function fillSelection(color) {
  if (!canEditSelection()) return;
  const chosen = current.items.filter(
    (i) => selection.has(i.id) && paintsColor(i),
  );
  // Choosing the color the objects already have keeps what can be redone.
  if (chosen.every((i) => i.color === color)) return;
  mutate(() => chosen.forEach((i) => (i.color = color)));
  for (const type of new Set(chosen.map((i) => i.type)))
    if (["note", "rect", "ellipse", "arrow"].includes(type))
      rememberStyle(type, { color });
}
function formatSelection(key, value, fontLoaded = false) {
  if (!fontLoaded) formatRequests++;
  if (!canEditSelection()) return;
  if (key === "fontFamily" && !validFontFamily(value)) return;
  if (editing && TEXT_STYLE_KEYS.includes(key)) {
    editing.input.format(key, value);
    positionTextEditor();
    updateTextFitStatus();
    return;
  }
  // A table takes these for all its cells, unless one of its cells is open
  // in the cell editor.
  const chosen = current.items.filter(
    (i) =>
      selection.has(i.id) &&
      (canEditText(i) ||
        (i.type === "table" &&
          TABLE_TEXT_KEYS.includes(key) &&
          !tableEditor.isOpen())) &&
      (!["autoFontSize", "textValign"].includes(key) || canAutoFitText(i)) &&
      (key !== "autoHeight" || i.type === "text"),
  );
  if (!chosen.length) return;
  // Table rows grow to fit text measured in the new family, so it loads
  // first; a family that fails to load is measured in its fallback.
  if (
    key === "fontFamily" &&
    !fontLoaded &&
    !fontFamilyReady(value) &&
    chosen.some((i) => i.type === "table")
  ) {
    // Only if, once it has loaded, the same objects are still chosen and
    // nothing else has been chosen, undone or redone since.
    const board = current,
      chosenIds = [...selection].join(),
      request = formatRequests;
    const retry = () => {
      if (
        current === board &&
        request === formatRequests &&
        [...selection].join() === chosenIds
      )
        formatSelection(key, value, true);
    };
    loadFontFamily(value).then(retry, retry);
    return;
  }
  if (value === undefined)
    value = !chosen.every((i) => textRangeValue(i, key) === true);
  if (
    chosen.every(
      (i) =>
        // null clears a style, which matches an unset property.
        ((key === "fontFamily" ? fontFamily(i) : i[key]) ?? null) ===
          (value ?? null) && !i.textRuns?.some((r) => key in r.style),
    )
  )
    return;
  const ctx = document.querySelector("#canvas").getContext("2d");
  mutate(() =>
    chosen.forEach((i) => {
      if (value === null) delete i[key];
      else i[key] = value;
      // Rows grow to fit larger, bolder or wider text, in the same step.
      if (i.type === "table" && key !== "textAlign")
        Object.assign(i, grownTableRows(i, ctx));
      if (i.textRuns && TEXT_STYLE_KEYS.includes(key)) {
        const runs = formatTextRuns(
          i.text || "",
          i.textRuns,
          0,
          (i.text || "").length,
          { [key]: null },
        );
        if (runs.length) i.textRuns = runs;
        else delete i.textRuns;
      }
    }),
  );
}
function copyStyle() {
  const chosen = current?.items.filter((i) => selection.has(i.id)) || [];
  if (chosen.length !== 1 || !canCopyStyle(chosen[0]))
    return toast("Select one object with a copyable style.");
  copiedStyle = copyObjectStyle(chosen[0]);
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(copiedStyle));
  } catch {}
  toast("Style copied. Select objects and paste style.");
  draw();
}
function pasteStyle() {
  if (!current) return;
  if (!copiedStyle) return toast("Copy a style first.");
  if (!selection.size) return toast("Select objects first.");
  if (!canEditSelection()) return;
  const chosen = current.items.filter(
    (i) => selection.has(i.id) && canPasteStyle(i, copiedStyle),
  );
  if (!chosen.length)
    return toast("The copied style does not apply to this selection.");
  const changes = chosen
    .map((i) => ({ i, patch: objectStylePatch(i, copiedStyle) }))
    .filter(({ patch }) => patch);
  if (!changes.length) return toast("This style is already applied.");
  mutate(() => changes.forEach(({ i, patch }) => applyObjectStyle(i, patch)));
  toast("Style pasted.");
}
// Whether the selected text fits is read from each object's fitted layout.
// Layouts already made cost next to nothing, but selecting thousands of
// notes whose text was never laid out, as at a zoom too far out to show
// it, would fit them all at once, freezing the board for a second. A draw
// lays out at most ten of them, enough for an edit or a small selection;
// the rest are laid out while the browser is idle, and the status changes
// once every one is known.
let fitStatusLater = 0;
function updateTextFitStatus(budget = 0) {
  const status = document.querySelector("#text-fit-status");
  // While a marquee, a move or a resize goes on, the toolbar is out of
  // sight and hearing, and the selection changes with every pointer move:
  // the status is worked out once it ends, when the toolbar shows again.
  if (!status || status.closest(".is-interacting")) return;
  const ctx = document.querySelector("#canvas").getContext("2d");
  // Ten new layouts are always made, so each pass gets on, however slow.
  const until = performance.now() + budget,
    editingId = editing?.item.id;
  let made = 0,
    unknown = false,
    overflow = false;
  for (const i of current.items) {
    if (!selection.has(i.id) || !i.autoFontSize || !canAutoFitText(i)) continue;
    const own = i.id === editingId,
      text = own ? editing.input.value : i.text || "",
      runs = own ? editing.input.textRuns : i.textRuns,
      blocks = own ? editing.input.textBlocks : i.textBlocks;
    let layout = cachedFitTextLayout(i, ctx, text, undefined, runs, blocks);
    if (!layout) {
      if (made++ >= 10 && performance.now() > until) {
        unknown = true;
        continue;
      }
      layout = fitTextLayout(i, ctx, text, undefined, runs, blocks);
    }
    if (layout.overflow) {
      overflow = true;
      break;
    }
  }
  const overflowKnown = overflow || !unknown;
  unknown = false;
  let tooTall = false;
  for (const i of current.items) {
    if (!selection.has(i.id) || !growsWithText(i)) continue;
    const own = i.id === editingId,
      text = own ? editing.input.value : i.text || "",
      runs = own ? editing.input.textRuns : i.textRuns,
      blocks = own ? editing.input.textBlocks : i.textBlocks;
    let layout = cachedAutoHeightLayout(i, ctx, text, runs, blocks);
    if (!layout) {
      if (made++ >= 10 && performance.now() > until) {
        unknown = true;
        continue;
      }
      layout = autoHeightLayout(i, ctx, text, runs, blocks);
    }
    if (layout.overflow) {
      tooTall = true;
      break;
    }
  }
  // Too tall is said first, so overflow alone waits until no object can
  // be too tall. Until then the status stays as it was.
  if (!tooTall && (unknown || !overflowKnown)) {
    if (!fitStatusLater) {
      const again = (deadline) => {
        fitStatusLater = 0;
        // An idle browser lends more time, short of a long task.
        updateTextFitStatus(Math.min(16, deadline?.timeRemaining?.() || 0));
      };
      fitStatusLater = window.requestIdleCallback
        ? requestIdleCallback(again, { timeout: 500 })
        : setTimeout(again, 0);
    }
    return;
  }
  status.hidden = !overflow && !tooTall;
  const message = tooTall
    ? t(
        "Text exceeds the board height limit. Widen the box or split the text into separate boxes.",
      )
    : overflow
      ? t(
          "Some text does not fit at the minimum size. Enlarge the object or shorten the text.",
        )
      : "";
  if (status.textContent !== message) status.textContent = message;
}
// Zoomed out past the point where text is drawn, notes are painted without
// it and their text is never laid out, so the first draw that shows text
// again, zooming in past 15% or out to near it, would lay out every note it
// shows at once: one frame of 200 ms on a large board of wordy notes. While
// the browser is idle, the text such a draw would show is laid out ahead,
// from the middle of the view outwards, as painting lays it out, so the
// draw finds it ready and shows the same.
const warmText = {
  board: null,
  items: null,
  key: null,
  queue: [],
  at: 0,
  later: 0,
};
function warmTextLater(items) {
  warmText.board = current;
  warmText.items = items;
  if (!warmText.later && !document.hidden && window.requestIdleCallback)
    warmText.later = requestIdleCallback(warmTextNow);
}
function warmTextNow(deadline) {
  warmText.later = 0;
  const canvas = document.querySelector("#canvas");
  if (!canvas || !current || warmText.board !== current) {
    // A board closed, or left for another, lets its objects go; the next
    // board's first draw starts again.
    Object.assign(warmText, {
      board: null,
      items: null,
      key: null,
      queue: [],
      at: 0,
    });
    return;
  }
  // A hidden tab waits until it is seen again.
  if (document.hidden) return;
  // Beyond the view, what the view would show at the zoom where text
  // begins, around its middle.
  const shown = viewBounds(),
    grow = Math.max(1, view.z / DETAIL_ZOOM),
    middle = { x: shown.x + shown.w / 2, y: shown.y + shown.h / 2 },
    area = {
      x: middle.x - (shown.w * grow) / 2,
      y: middle.y - (shown.h * grow) / 2,
      w: shown.w * grow,
      h: shown.h * grow,
    };
  const key = [warmText.items, area.x, area.y, area.w, area.h];
  if (!warmText.key?.every((value, n) => value === key[n])) {
    warmText.key = key;
    warmText.at = 0;
    const distance = (b) =>
      (b.x + b.w / 2 - middle.x) ** 2 + (b.y + b.h / 2 - middle.y) ** 2;
    const near = [];
    for (const i of warmText.items) {
      if (!i.text || !i.autoFontSize || !canAutoFitText(i)) continue;
      const b = bounds([i]);
      if (
        b.x < area.x + area.w &&
        b.x + b.w > area.x &&
        b.y < area.y + area.h &&
        b.y + b.h > area.y
      )
        near.push([distance(b), i]);
    }
    warmText.queue = near.sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  }
  // A frame's time at most at once, so input is never kept waiting long.
  const ctx = canvas.getContext("2d"),
    font = ctx.font,
    until = performance.now() + 16;
  while (
    warmText.at < warmText.queue.length &&
    deadline.timeRemaining() > 1 &&
    performance.now() < until
  )
    fitTextLayout(warmText.queue[warmText.at++], ctx);
  ctx.font = font;
  if (warmText.at < warmText.queue.length)
    warmText.later = requestIdleCallback(warmTextNow);
}
document.addEventListener("visibilitychange", () => {
  if (
    !document.hidden &&
    warmText.items &&
    warmText.board === current &&
    !warmText.later &&
    window.requestIdleCallback
  )
    warmText.later = requestIdleCallback(warmTextNow);
});
function positionTextEditor() {
  if (!editing) return;
  const { item: i, input } = editing;
  const defaults =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--text")
      .trim() || "#30342f";
  const ctx = document.querySelector("#canvas").getContext("2d");
  const fitted =
    i.autoFontSize && canAutoFitText(i)
      ? fitTextLayout(
          i,
          ctx,
          input.value,
          defaults,
          input.textRuns,
          input.textBlocks,
        )
      : null;
  const style = fitted?.style || textStyle(i, defaults);
  const layout =
    fitted ||
    (boxedText(i)
      ? shapeTextLayout(i, ctx, input.value, input.textRuns, input.textBlocks)
      : null);
  const box =
    i.type === "arrow"
      ? connectorLabel({
          ...i,
          text: input.value,
          textRuns: input.textRuns,
          textBlocks: input.textBlocks,
        })
      : layout
        ? { ...layout.box, x: i.x + layout.box.x, y: i.y + layout.box.y }
        : growsWithText(i)
          ? {
              ...i,
              h: autoHeightLayout(
                i,
                ctx,
                input.value,
                input.textRuns,
                input.textBlocks,
              ).height,
            }
          : { ...i, h: i.h - tagFooter(i) };
  const origin = worldPoint(i, box);
  Object.assign(input.style, {
    left: `${view.x + origin.x * view.z}px`,
    top: `${view.y + origin.y * view.z}px`,
    width: `${box.w}px`,
    height: `${box.h}px`,
    background: i.type === "arrow" ? "#ffffff" : "transparent",
    transform: `scale(${view.z}) rotate(${rotationOf(i)}deg)`,
    padding: `${style.padding}px`,
    paddingTop: `${layout?.top ?? style.padding}px`,
    font: style.font,
    lineHeight: "1.35",
    color: style.color,
    textAlign: style.align,
    textDecoration: "none",
    overflow:
      growsWithText(i) &&
      !autoHeightLayout(i, ctx, input.value, input.textRuns, input.textBlocks)
        .overflow
        ? "hidden"
        : "auto",
  });
  input.setBaseStyle(
    i,
    textStyle({ ...i, textColor: undefined }, defaults).color,
  );
  input.setListMetrics(ctx, style);
  if (input.style.overflow === "hidden") input.scrollTop = 0;
}
function revealTextCaret() {
  if (!editing || !growsWithText(editing.item)) return;
  const canvas = document.querySelector("#canvas");
  const rect = canvas.getBoundingClientRect();
  if (!rect.height) return;
  const { item: i, input } = editing;
  const height = autoHeightLayout(
    i,
    canvas.getContext("2d"),
    input.value.slice(
      0,
      input.selectionDirection === "backward"
        ? input.selectionStart
        : input.selectionEnd,
    ),
    input.textRuns,
    input.textBlocks,
  ).height;
  if (rotationOf(i)) {
    const selection = window.getSelection(),
      range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const caret = range?.getBoundingClientRect?.();
    if (caret?.height) {
      const margin = Math.min(120, rect.height / 4);
      if (caret.bottom > rect.bottom - margin)
        view.y -= caret.bottom - rect.bottom + margin;
      else if (caret.top < rect.top + margin)
        view.y += rect.top + margin - caret.top;
      if (caret.right > rect.right - margin)
        view.x -= caret.right - rect.right + margin;
      else if (caret.left < rect.left + margin)
        view.x += rect.left + margin - caret.left;
    }
    return;
  }
  const lineHeight = textStyle(i).size * 1.35 * view.z;
  const bottom = view.y + (i.y + height) * view.z;
  const top = bottom - lineHeight;
  const margin = Math.min(120, rect.height / 4);
  const toolbar = document
    .querySelector("#selection-tools")
    .getBoundingClientRect();
  const topMargin = Math.max(margin, toolbar.bottom - rect.top + 12);
  if (bottom > rect.height - margin) view.y -= bottom - rect.height + margin;
  else if (top < topMargin) view.y += topMargin - top;
}
// Whether a shortcut held with Alt/Option is one of `keys`. Option on a Mac
// changes the character a key types (Option K types "˚"), so the key's
// position counts when no plain letter or sign comes through; otherwise the
// character does, as on layouts that place letters elsewhere.
function optionKey(e, keys, codes) {
  if (!e.altKey) return false;
  const key = e.key.toLowerCase();
  if (/^[a-z0-9=+_-]$/.test(key)) return keys.includes(key);
  return codes.includes(e.code);
}
function beginTextEdit(i, { inheritLanguage = true, point } = {}) {
  if (!canEditSelection(new Set([i.id]))) return;
  finishTextEdit();
  // A shared text can already be longer than may be typed, after
  // simultaneous edits; editing keeps it rather than cutting its end.
  const maxLength = Math.max(20000, (i.text || "").length);
  const input = createTextEditor(document, i, {
    maxLength,
    inheritLanguage,
    onSelection: updateTextRangeControls,
    history: collaboration
      ? (redo) => sharedStep(redo ? "redo" : "undo")
      : undefined,
  });
  input.addEventListener("keydown", (e) => mindMap.keydown(e, true), true);
  input.id = "canvas-text-editor";
  input.className = "canvas-text-editor";
  input.setAttribute("aria-label", t("Edit text on canvas"));
  input.setAttribute("aria-describedby", "text-edit-hint");
  input.maxLength = maxLength;
  input.value = i.text || "";
  input.spellcheck = true;
  input.addEventListener("focus", () => closeTextLinkEditor(false));
  input.addEventListener("input", () => {
    if (growsWithText(editing?.item || i)) {
      revealTextCaret();
      draw();
    } else positionTextEditor();
    updateTextFitStatus();
    keepTextDraft();
  });
  input.addEventListener("keydown", (e) => {
    if (
      !e.isComposing &&
      growsWithText(editing?.item || i) &&
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].includes(e.key)
    ) {
      // Wait for native caret movement. Safari can omit keyup for Cmd+arrows.
      requestAnimationFrame(() => {
        if (editing?.input !== input || document.activeElement !== input)
          return;
        revealTextCaret();
        draw();
      });
    }
  });
  const hint = document.createElement("span");
  hint.id = "text-edit-hint";
  hint.className = "sr-only";
  hint.textContent = t(
    i.mindMap
      ? "Ctrl or Cmd + Enter to finish. Escape to cancel."
      : "Ctrl or Cmd + Enter to finish. Escape to cancel. Enter adds a new line.",
  );
  editing = { item: i, input, hint };
  if (collaboration) {
    hint.textContent = t("Changes are shared as you type. Escape to finish.");
    editing.sharedChange = (text, runs, blocks) => {
      const row = current.items.find((r) => r.id === i.id);
      if (row) {
        row.text = text;
        if (runs?.length) row.textRuns = runs;
        else delete row.textRuns;
        if (blocks?.length) row.textBlocks = blocks;
        else delete row.textBlocks;
      }
      if (row && growsWithText(row)) draw();
      else positionTextEditor();
      updateTextFitStatus();
      sendPresence();
    };
    editing.unbind = bindText(collaboration, i.id, input, editing.sharedChange);
  }
  if (!i.mindMap)
    hint.textContent +=
      " " +
      t(
        "In lists, Tab changes indent, Shift+Enter continues an item, and Enter on an empty item exits the list.",
      );
  if (i.type === "note" && !i.mindMap)
    hint.textContent +=
      " " + t("Elsewhere, Tab or Ctrl/Cmd+D goes on to a new sticky note.");
  if (i.mindMap)
    hint.textContent +=
      " " +
      t(
        "Tab adds a child · Enter adds a sibling · Shift+Enter adds a line · Arrow keys navigate nodes",
      );
  selection = new Set([i.id]);
  selectionAnchor = i.id;
  focusedGroup = i.groupId || null;
  document.querySelector(".canvas-wrap").append(input, hint);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && optionKey(e, ["k"], ["KeyK"])) {
      e.preventDefault();
      e.stopPropagation();
      openTextLinkEditor();
      return;
    }
    if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
      e.preventDefault();
      e.stopPropagation();
      finishTextEdit(e.key !== "Escape", true);
    } else if (e.key === "F10" && e.altKey && !e.ctrlKey && !e.metaKey) {
      // Alt+F10 goes to the formatting toolbar, as in other text editors;
      // the same keys there come back to the text.
      const control = [
        ...document.querySelectorAll(
          "#selection-tools button, #selection-tools select, #selection-tools input",
        ),
      ].find((c) => !c.disabled && !c.closest("[hidden]"));
      if (control) {
        e.preventDefault();
        e.stopPropagation();
        control.focus();
      }
    } else if (
      i.type === "note" &&
      !i.mindMap &&
      // A list item takes Tab for its indent first.
      !e.defaultPrevented &&
      !e.altKey &&
      ((e.key === "Tab" && !e.metaKey && !e.ctrlKey) ||
        ((e.metaKey || e.ctrlKey) && !e.shiftKey && shortcutLetter(e) === "d"))
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) nextNote(i.id, e.key === "Tab" && e.shiftKey ? -1 : 1);
    } else if (
      (e.metaKey || e.ctrlKey) &&
      ["b", "i", "u"].includes(shortcutLetter(e))
    ) {
      e.preventDefault();
      formatSelection(
        { b: "bold", i: "italic", u: "underline" }[shortcutLetter(e)],
      );
    }
  });
  draw();
  input.focus({ preventScroll: true });
  // A double click puts the caret where it was, selecting the word there,
  // so that typing replaces that word rather than all the text. A new
  // object, or Enter, selects all of it, ready to be written over.
  const caret = point && textCaretAt(i, point);
  if (caret) input.setSelectionRange(caret.start, caret.end);
  else input.select();
  sendPresence();
}
function textCaretAt(i, point) {
  const { offset, onText } = textOffsetAt(
    i,
    document.querySelector("#canvas").getContext("2d"),
    point,
  );
  return onText ? wordAt(i.text || "", offset) : { start: offset, end: offset };
}
// Tab or Ctrl/Cmd+D while typing on a sticky note keeps going on a new one
// beside it, the same size and colour, as in Miro: Shift+Tab goes left. A
// spot already taken moves the new note along until it is free.
function nextNote(id, direction = 1) {
  finishTextEdit(true);
  const source = current?.items.find((i) => i.id === id);
  if (!source) return;
  const gap = 24,
    step = (source.w + gap) * direction;
  const free = (x) =>
    !visibleItems().some(
      (i) =>
        i.type !== "frame" &&
        !isConnector(i) &&
        i.x < x + source.w &&
        x < i.x + i.w &&
        i.y < source.y + source.h &&
        source.y < i.y + i.h,
    );
  let x = source.x + step;
  for (let n = 0; n < 50 && !free(x); n++) x += step;
  const style = {};
  for (const key of [
    "color",
    "w",
    "h",
    "fontSize",
    "fontFamily",
    "textAlign",
    "textValign",
    "autoFontSize",
  ])
    if (source[key] !== undefined) style[key] = source[key];
  const created = addObject("note", { x, y: source.y }, style);
  if (created) revealQuickObject(created, { minimal: true });
}
// Text being typed on a personal board joins the board when editing ends.
// Until then it is kept on the device as a draft, a moment after each
// change, so a crash or a killed tab does not lose it; opening the board
// again puts it back. Shared boards save as people type.
const TEXT_DRAFT_KEY = "whiteboard-text-draft";
let textDraftTimer = null;
function keepTextDraft() {
  if (collaboration || textDraftTimer) return;
  textDraftTimer = setTimeout(() => {
    textDraftTimer = null;
    if (!editing || collaboration || !current) return;
    const { item: i, input } = editing;
    try {
      localStorage.setItem(
        TEXT_DRAFT_KEY,
        JSON.stringify({
          board: current.id,
          item: i.id,
          base: i.text || "",
          text: input.value.slice(0, input.maxLength),
          runs: input.textRuns,
          blocks: input.textBlocks,
        }),
      );
    } catch {
      /* Storage full or unavailable: the edit still saves when it ends. */
    }
  }, 400);
}
function dropTextDraft() {
  clearTimeout(textDraftTimer);
  textDraftTimer = null;
  try {
    localStorage.removeItem(TEXT_DRAFT_KEY);
  } catch {
    /* Nothing was kept. */
  }
}
function restoreTextDraft(b) {
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(TEXT_DRAFT_KEY) || "null");
  } catch {
    draft = null;
  }
  if (draft?.board !== b.id) return;
  dropTextDraft();
  const i = b.items.find((o) => o.id === draft.item);
  // Only onto the text it was typed over, so a later change is never undone.
  if (
    !i ||
    typeof draft.text !== "string" ||
    (i.text || "") !== draft.base ||
    draft.text === draft.base ||
    !canEditSelection(new Set([i.id]))
  )
    return;
  mutate(() => {
    i.text = draft.text.slice(0, 20000);
    if (Array.isArray(draft.runs) && draft.runs.length) i.textRuns = draft.runs;
    else delete i.textRuns;
    if (Array.isArray(draft.blocks) && draft.blocks.length)
      i.textBlocks = draft.blocks;
    else delete i.textBlocks;
  });
  toast(t("Text you were typing when the board closed was put back."));
}
function finishTextEdit(commit = true, focus = false) {
  tableEditor.close(commit);
  if (!editing) return;
  dropTextDraft();
  const { item: i, input, hint, unbind } = editing;
  unbind?.();
  if (collaboration) {
    commit = true;
    collaboration.settle();
  }
  editing = null;
  const text = input.value.slice(0, input.maxLength);
  const runs = input.textRuns,
    blocks = input.textBlocks;
  input.destroy();
  input.remove();
  hint.remove();
  // A plain text box with nothing left in it would stay as an invisible
  // object; it leaves the board, as a note or shape keeps its colour and
  // stays. One connected to a line or locked stays for what holds it.
  const emptied =
    commit &&
    i.type === "text" &&
    !text &&
    !runs.length &&
    !blocks.length &&
    !i.locked &&
    !current.items.some((o) => o.startId === i.id || o.endId === i.id);
  if (emptied) {
    mutate(() => {
      current.items = removeItems(current.items, new Set([i.id]));
      selection.delete(i.id);
    });
    sendPresence();
    if (focus)
      document.querySelector("#canvas")?.focus({ preventScroll: true });
    return;
  }
  if (
    commit &&
    (text !== (i.text || "") ||
      JSON.stringify(runs) !== JSON.stringify(i.textRuns || []) ||
      JSON.stringify(blocks) !== JSON.stringify(i.textBlocks || []))
  )
    mutate(() => {
      i.text = text;
      if (runs.length) i.textRuns = runs;
      else delete i.textRuns;
      if (blocks.length) i.textBlocks = blocks;
      else delete i.textBlocks;
    });
  else draw();
  sendPresence();
  if (focus) document.querySelector("#canvas")?.focus({ preventScroll: true });
}
// Commit before another control changes the board; formatting retains the draft.
document.addEventListener(
  "pointerdown",
  (e) => {
    textLinkPreview.outside(e.target);
    if (
      editing &&
      !e.target.closest("#canvas-text-editor,#selection-tools") &&
      // A finger or a pan button on the board may only be moving the view
      // under the editor, as the wheel does; the gesture decides.
      !(
        e.target.id === "canvas" &&
        (e.pointerType === "touch" || e.button === 1 || e.button === 2)
      )
    )
      finishTextEdit();
  },
  true,
);
document.addEventListener("focusin", (e) => {
  if (e.target.id !== "canvas") canvasNavigation.finish();
  if (drag && e.target.id !== "canvas") pointerUp();
  if (editing && !e.target.closest("#canvas-text-editor,#selection-tools"))
    finishTextEdit();
});
// Back in the library after a while away, its notification count is asked
// again, at most once a minute.
const refreshNotificationBadge = () => {
  if (!current && !document.hidden) organizationHome.refreshBadge();
};
window.addEventListener("focus", refreshNotificationBadge);
document.addEventListener("visibilitychange", () => {
  refreshNotificationBadge();
  if (document.hidden) {
    flushNudgeSave();
    canvasNavigation.cancel();
    minimap.cancel();
    quickPorts.cancel();
    mindHandles.cancel();
    mindCollapse.cancel();
    tableEditor.cancelResize();
    pointerUp();
    finishTextEdit();
  }
});

// How far from a line, stroke or frame edge a press still finds it: a
// finger covers more of the board than a pointer.
const hitReach = (e) => (e?.pointerType === "touch" ? 20 : 8) / view.z;
function canvasPoint(e) {
  const r = document.querySelector("#canvas").getBoundingClientRect();
  return {
    x: (e.clientX - r.left - view.x) / view.z,
    y: (e.clientY - r.top - view.y) / view.z,
  };
}
// The board point in the middle of the view.
function viewCenter() {
  const r = document.querySelector("#canvas").getBoundingClientRect();
  return {
    x: (r.width / 2 - view.x) / view.z,
    y: (r.height / 2 - view.y) / view.z,
  };
}
// The board area the view shows.
function viewBounds() {
  const r = document.querySelector("#canvas").getBoundingClientRect();
  return {
    x: -view.x / view.z,
    y: -view.y / view.z,
    w: r.width / view.z,
    h: r.height / view.z,
  };
}
// Where a new sticky note's corner goes for it to sit in the middle.
function center() {
  const c = viewCenter();
  return { x: c.x - 95, y: c.y - 80 };
}
// The side of a new sticky note.
const NOTE_SIZE = 200;
// Where an object made with a click or a shortcut goes: centred on the
// point, as in Miro. Text starts at the point instead, where typing begins.
function placeAt(type, p, size) {
  if (type === "text") return p;
  const [w, h] = size
    ? [size.w, size.h]
    : type === "frame"
      ? [newFrameFormat().w, newFrameFormat().h]
      : type === "note"
        ? [NOTE_SIZE, NOTE_SIZE]
        : [190, 160];
  return { x: p.x - w / 2, y: p.y - h / 2 };
}
// An object added without a pointer goes where asked, in the middle of the
// view, unless something there would hide it or be hidden by it; then it
// goes beside it. See freeSpot.
function openSpot(type, p, size = {}) {
  if (type === "frame") return p;
  const [w, h] =
    type === "note"
      ? [NOTE_SIZE, NOTE_SIZE]
      : type === "text"
        ? [280, 60]
        : [190, 160];
  // With others on the board, each person starts looking in their own
  // direction, by their place among the people present.
  const sessions = collaborationRoster.map((r) => r.session).sort(),
    mine = sessions.indexOf(collaboration?.session);
  return freeSpot(
    visibleItems(),
    { x: p.x, y: p.y, w: size.w ?? w, h: size.h ?? h },
    viewBounds(),
    { turn: mine > 0 ? mine / sessions.length : 0 },
  );
}
function setTool(value) {
  attention.stop();
  if (
    isSharedReadOnly() &&
    !["select", "hand", "region"].includes(value) &&
    // Commenters discuss content they cannot change.
    !(value === "comment" && !isCommentReadOnly())
  )
    return;
  canvasNavigation.finish();
  pointerUp();
  tool = value;
  armedShape = null;
  onboarding.tip(value, toast);
  selection.clear();
  showTool();
  draw();
}
const toolCursor = () =>
  tool === "hand" ? "grab" : tool === "select" ? "default" : "crosshair";
function showTool() {
  document
    .querySelectorAll('[data-action^="tool-"]')
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.action === "tool-" + tool),
    );
  document.querySelector("#canvas").style.cursor = toolCursor();
  document.querySelector("#tool-hint").textContent = t(
    armedShape
      ? "Click to add the shape · Drag to draw it at a size"
      : TOOL_HINTS[tool] || "",
  );
  renderNoteColors();
  renderFrameFormats();
}
// While the sticky note tool is on, its colours stand beside the tool rail;
// the one chosen is the colour new sticky notes take.
const COLOR_NAMES = ["Butter", "Sage", "Blue", "Lilac", "Peach", "White"];
function renderNoteColors() {
  const wrap = document.querySelector(".canvas-wrap");
  if (!wrap) return;
  let palette = wrap.querySelector("#note-colors");
  if (tool !== "note" || isSharedReadOnly()) {
    if (palette) palette.hidden = true;
    return;
  }
  if (!palette) {
    palette = document.createElement("div");
    palette.id = "note-colors";
    palette.className = "note-colors panel";
    palette.setAttribute("role", "group");
    palette.setAttribute("aria-label", t("Sticky note color"));
    wrap.append(palette);
  }
  const chosen = lastStyle.note?.color || COLORS[0];
  palette.innerHTML = COLORS.map(
    (c, n) =>
      `<button type="button" class="swatch" style="--swatch:${c}" data-note-color="${c}" aria-label="${t(`${COLOR_NAMES[n]} color`)}" aria-pressed="${c === chosen}"></button>`,
  ).join("");
  for (const swatch of palette.querySelectorAll("[data-note-color]"))
    swatch.onclick = () => {
      rememberStyle("note", { color: swatch.dataset.noteColor });
      renderNoteColors();
      palette
        .querySelector(`[data-note-color="${swatch.dataset.noteColor}"]`)
        ?.focus({ preventScroll: true });
    };
  placeNoteColors();
  palette.hidden = false;
}
// The palette sits beside the Sticky note button, clear of the rail, which
// wraps into two columns in a short window.
function placeNoteColors() {
  const wrap = document.querySelector(".canvas-wrap"),
    palette = wrap?.querySelector("#note-colors");
  if (!palette || tool !== "note") return;
  const rail = wrap.querySelector(".left-rail")?.getBoundingClientRect(),
    note = wrap
      .querySelector('[data-action="tool-note"]')
      ?.getBoundingClientRect(),
    box = wrap.getBoundingClientRect();
  palette.style.left = rail?.width
    ? `${Math.round(rail.right - box.left + 8)}px`
    : "";
  palette.style.top = note?.height
    ? `${Math.round(note.top - box.top - 4)}px`
    : "";
}
// While the frame tool is on, the formats stand beside the tool rail, as in
// Miro: a slide, a printed page or a screen. The one chosen is the size a
// click or the F key gives a new frame; dragging still draws any size.
const newFrameFormat = () => frameFormatById(lastStyle.frame?.format);
function renderFrameFormats() {
  const wrap = document.querySelector(".canvas-wrap");
  if (!wrap) return;
  let panel = wrap.querySelector("#frame-formats");
  // A participant of a board locked to sticky notes adds no frames.
  if (tool !== "frame" || isSharedReadOnly() || facilitation.boardLocked()) {
    if (panel) panel.hidden = true;
    return;
  }
  // One choice of several, as radio buttons: one Tab stop, right after the
  // tool rail, and the arrow keys move between formats and choose them.
  if (!panel || panel.dataset.language !== language) {
    panel?.remove();
    panel = document.createElement("div");
    panel.id = "frame-formats";
    panel.className = "frame-formats panel";
    panel.dataset.language = language;
    panel.setAttribute("role", "radiogroup");
    panel.setAttribute("aria-label", t("Frame format"));
    // Each choice is drawn at its proportions, the longer side 18px.
    panel.innerHTML = FRAME_FORMATS.map((f) => {
      const scale = 18 / Math.max(f.w, f.h);
      return `<button type="button" role="radio" class="frame-format" data-frame-format="${f.id}"><span class="frame-format-box" aria-hidden="true"><span class="frame-format-shape" style="width:${Math.round(f.w * scale)}px;height:${Math.round(f.h * scale)}px"></span></span><span>${t(f.name)}</span></button>`;
    }).join("");
    const choose = (choice) => {
      rememberStyle("frame", { format: choice.dataset.frameFormat });
      renderFrameFormats();
      choice.focus({ preventScroll: true });
    };
    panel.addEventListener("click", (e) => {
      const choice = e.target.closest("[data-frame-format]");
      if (choice) choose(choice);
    });
    panel.addEventListener("keydown", (e) => {
      const choices = [...panel.querySelectorAll("[data-frame-format]")],
        at = choices.indexOf(document.activeElement),
        step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[
          e.key
        ];
      if (at < 0 || (!step && !["Home", "End"].includes(e.key))) return;
      e.preventDefault();
      e.stopPropagation();
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? choices.length - 1
            : (at + step + choices.length) % choices.length;
      choose(choices[next]);
    });
    const rail = wrap.querySelector(".left-rail");
    if (rail) rail.after(panel);
    else wrap.append(panel);
  }
  const chosen = newFrameFormat().id;
  for (const choice of panel.querySelectorAll("[data-frame-format]")) {
    const on = choice.dataset.frameFormat === chosen;
    choice.setAttribute("aria-checked", String(on));
    choice.tabIndex = on ? 0 : -1;
  }
  placeFrameFormats();
  panel.hidden = false;
}
// The formats sit beside the Frame button, as the note colours do.
function placeFrameFormats() {
  const wrap = document.querySelector(".canvas-wrap"),
    panel = wrap?.querySelector("#frame-formats");
  if (!panel || tool !== "frame") return;
  const rail = wrap.querySelector(".left-rail")?.getBoundingClientRect(),
    frame = wrap
      .querySelector('[data-action="tool-frame"]')
      ?.getBoundingClientRect(),
    box = wrap.getBoundingClientRect();
  panel.style.left = rail?.width
    ? `${Math.round(rail.right - box.left + 8)}px`
    : "";
  // It stays inside the board area when the button is low in a short window.
  const top = frame?.height ? frame.top - box.top - 4 : null;
  panel.style.top =
    top === null
      ? ""
      : `${Math.round(Math.max(8, Math.min(top, box.height - panel.offsetHeight - 8)))}px`;
}
function activeGridStep(event) {
  return boardGrid.snap && !event?.altKey && !event?.ctrlKey && !event?.metaKey
    ? gridStep(view.z)
    : 0;
}
function gridPlaceItems(items) {
  const step = activeGridStep();
  if (!step || !items.length) return;
  const box = bounds(items),
    point = snapGridPoint(box, step),
    dx = point.x - box.x,
    dy = point.y - box.y;
  if (items.some((i) => Math.abs(i.x + dx) > 1e6 || Math.abs(i.y + dy) > 1e6))
    return;
  for (const i of items) {
    i.x += dx;
    i.y += dy;
  }
}
// The frames that moved objects will join where they are dropped, by the
// rule the drop uses (inferParents): the smallest frame holding an object's
// middle. They are outlined during the drag, as in Miro; a frame an object
// is already in, or one moving with it, is not.
function dropFrames(moving) {
  if (!moving?.length || moving.length > 300) return null;
  const ids = new Set(moving.map(({ item }) => item.id));
  const hidden = facilitation.concealedIds();
  const frames = visibleItems()
    .filter((i) => i.type === "frame" && !ids.has(i.id) && !hidden.has(i.id))
    .sort((a, b) => a.w * a.h - b.w * b.h);
  if (!frames.length) return null;
  const found = new Set();
  for (const { item: i } of moving) {
    if (i.type === "frame" || ids.has(i.parentId) || i.locked) continue;
    const cx = i.x + i.w / 2,
      cy = i.y + i.h / 2;
    const frame = frames.find(
      (f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h,
    );
    if (frame && frame.id !== i.parentId) found.add(frame.id);
  }
  return found.size ? found : null;
}
// A frame resized on its own takes in what its middle now covers and lets
// go of what it no longer does, as in Miro, however it was resized.
function reframeResized(plan, skip = facilitation.concealedIds()) {
  if (!plan?.frameOnly) return;
  const frame = current.items.find((i) => plan.ids.has(i.id));
  if (!frame) return;
  const covers = (box, i) =>
    i.x + i.w / 2 >= box.x &&
    i.x + i.w / 2 <= box.x + box.w &&
    i.y + i.h / 2 >= box.y &&
    i.y + i.h / 2 <= box.y + box.h;
  inferParents(
    current.items,
    new Set(
      current.items
        .filter(
          (i) =>
            i.type !== "frame" &&
            !skip.has(i.id) &&
            (covers(plan.box, i) || covers(frame, i)),
        )
        .map((i) => i.id),
    ),
    { skip },
  );
}
function addObject(type, p, extra = {}, event, after) {
  if (isSharedReadOnly()) return toast("This board is read-only.");
  if (current.items.length >= MAX_OBJECTS)
    return toast("A board can contain at most 5,000 objects.");
  p ??= openSpot(
    type,
    type === "text" ? center() : placeAt(type, viewCenter()),
    extra,
  );
  p = snapGridPoint(p, activeGridStep(event));
  // An object made at the edge of the view stays on the board.
  p = {
    x: Math.max(-BOARD_LIMIT, Math.min(BOARD_LIMIT - 400, p.x)),
    y: Math.max(-BOARD_LIMIT, Math.min(BOARD_LIMIT - 400, p.y)),
  };
  const generatedText =
    type === "text" && extra.text === undefined ? t("Your text") : null;
  let created;
  mutate(() => {
    const i = item(type, p.x, p.y, {
      // Shapes start white, as in Miro, apart from yellow sticky notes;
      // each kind then takes the colour last given to one.
      color:
        lastStyle[type]?.color ||
        (["rect", "ellipse"].includes(type) ? "#ffffff" : COLORS[0]),
      ...(type === "text" ? { autoHeight: true } : {}),
      // As in Miro, a new sticky note or shape holds its text in the middle.
      ...(["note", "rect", "ellipse"].includes(type)
        ? { textAlign: "center", textValign: "middle" }
        : {}),
      ...(generatedText !== null
        ? {
            text: generatedText,
            textRuns: [
              {
                start: 0,
                end: generatedText.length,
                style: { lang: language },
              },
            ],
          }
        : {}),
      // A new sticky note is square, as in Miro.
      ...(type === "note" ? { w: NOTE_SIZE, h: NOTE_SIZE } : {}),
      // A new frame presents after every frame already on the board.
      ...(type === "frame"
        ? {
            w: newFrameFormat().w,
            h: newFrameFormat().h,
            text: nextFrameTitle(current.items, t("Frame")),
            order: nextFrameOrder(current.items),
          }
        : {}),
      ...extra,
    });
    if (growsWithText(i))
      i.h = autoHeightLayout(
        i,
        document.querySelector("#canvas").getContext("2d"),
      ).height;
    current.items.push(i);
    created = i;
    inferParents(current.items, new Set([i.id]), {
      skip: facilitation.concealedIds(),
    });
    after?.(i);
    selection = new Set([i.id]);
  });
  setToolAfterAdd();
  // A save the board refused, as on a board the facilitator froze, took
  // the object back and said why; there is nothing to edit.
  if (!current.items.some((i) => i.id === created.id)) return;
  if (["note", "text"].includes(type))
    beginTextEdit(created, { inheritLanguage: generatedText === null });
  return created;
}
// A new slide, as Miro's Frames panel adds one: a frame the size of the
// last one in the presentation, beside it, or the chosen format in the
// middle of the view on a board with no frames yet. The view goes to it.
function addSlideFrame() {
  if (!canEditSelection(new Set())) return null;
  const last = orderedFrames(current.items).at(-1),
    size = last ? { w: last.w, h: last.h } : newFrameFormat();
  const made = addObject(
    "frame",
    last ? nextSlideSpot(current.items, last) : placeAt("frame", viewCenter()),
    { w: size.w, h: size.h },
  );
  if (made) focusRegion(made, undefined, true);
  return made || null;
}
// A library shape chosen with a pointer, waiting to be placed with the
// rectangle or ellipse tool.
let armedShape = null;
const shapeProps = (key) => ({
  w: 280,
  h: 180,
  ...shapeDefaults(key),
  ...(CUSTOM_SHAPES.has(key) ? { shape: key } : {}),
});
// What the rectangle or ellipse tool adds: the chosen library shape, or
// the plain one.
const armedProps = (type) =>
  armedShape && ["rect", "ellipse"].includes(type)
    ? shapeProps(armedShape)
    : {};
function addShape(key, { arm = false } = {}) {
  if (!canEditSelection(new Set())) return;
  if (current.items.length >= MAX_OBJECTS)
    return toast("A board can contain at most 5,000 objects.");
  if (arm) {
    setTool(key === "ellipse" ? "ellipse" : "rect");
    armedShape = key;
    showTool();
    return;
  }
  // Library shapes come in many sizes; each lands centred in the view.
  const props = shapeProps(key),
    c = viewCenter();
  const type = key === "ellipse" ? "ellipse" : "rect";
  const created = addObject(
    type,
    openSpot(type, { x: c.x - props.w / 2, y: c.y - props.h / 2 }, props),
    props,
  );
  if (created) beginTextEdit(created);
}
function setToolAfterAdd() {
  tool = "select";
  armedShape = null;
  // The buttons, cursor, and hint all follow the select tool.
  showTool();
}
// Objects quick connect neither joins nor avoids: content hidden from this
// person and nodes folded into collapsed mind-map branches.
function quickConnectSkip() {
  return new Set([
    ...facilitation.concealedIds(),
    ...mindView.scene().hidden.keys(),
  ]);
}
function quickConnect(id, direction) {
  if (!canEditSelection(new Set([id]))) return;
  try {
    const plan = quickConnectPlan(
      current.items,
      id,
      direction,
      quickConnectSkip(),
      lastStyle.arrow,
    );
    if (plan.existing) {
      selectItems(new Set([plan.line.id]));
      draw();
      document.querySelector("#canvas").focus();
      return;
    }
    mutate(() => {
      current.items.push(...plan.added);
      selection = new Set([plan.node?.id || plan.line.id]);
      selectionAnchor = plan.node?.id || plan.line.id;
    });
    // Refused, as on a board the facilitator locked: the refusal says why.
    if (!current.items.includes(plan.added[0])) return;
    if (plan.node) {
      revealQuickObject(plan.node);
      beginTextEdit(plan.node);
    } else document.querySelector("#canvas").focus();
  } catch (error) {
    toast(error.message);
  }
}
function revealQuickObject(i, { minimal = false } = {}) {
  const r = document.querySelector("#canvas").getBoundingClientRect();
  const left = r.width < 760 ? 24 : 90,
    right = r.width - (minimal ? 90 : 30);
  const top = minimal ? 180 : 140,
    bottom = r.height - (r.width < 760 ? 200 : minimal ? 100 : 70);
  view.z = Math.max(
    DETAIL_ZOOM,
    Math.min(
      view.z,
      Math.max(80, right - left) / i.w,
      Math.max(80, bottom - top) / i.h,
    ),
  );
  const x = view.x + i.x * view.z,
    y = view.y + i.y * view.z;
  const w = i.w * view.z,
    h = i.h * view.z;
  if (x < left || x + w > right)
    view.x += minimal
      ? x < left
        ? left - x
        : right - x - w
      : (left + right - w) / 2 - x;
  if (y < top || y + h > bottom)
    view.y += minimal
      ? y < top
        ? top - y
        : bottom - y - h
      : (top + bottom - h) / 2 - y;
  draw();
}
function startQuickConnection(id, event) {
  const source = current?.items.find((i) => i.id === id);
  if (!canQuickConnect(source) || !canEditSelection(new Set([id])))
    return false;
  if (current.items.length >= MAX_OBJECTS) {
    toast("A board can contain at most 5,000 objects.");
    return false;
  }
  pointerUp();
  document.querySelector("#canvas").focus({ preventScroll: true });
  const original = undoCopy(current.items),
    previousSelection = new Set(selection);
  const line = item("arrow", source.x + source.w / 2, source.y + source.h / 2, {
    ...lastStyle.arrow,
    w: 0,
    h: 0,
    startId: id,
  });
  current.items.push(line);
  selection = new Set([line.id]);
  drag = {
    kind: "arrow",
    id: line.id,
    start: canvasPoint(event),
    original,
    previousSelection,
    previousAnchor: selectionAnchor,
    previousGroup: focusedGroup,
    line: clone(line),
    changed: false,
    gridStep: activeGridStep(),
  };
  lastTap = null;
  draw();
  return true;
}
function snapViewport() {
  const r = document.querySelector("#canvas").getBoundingClientRect();
  return {
    x: -view.x / view.z,
    y: -view.y / view.z,
    w: (r.width || 300) / view.z,
    h: (r.height || 150) / view.z,
  };
}
function snapIndex() {
  return createSnapIndex(visibleItems(), selection, snapViewport());
}
// The side panels share the right edge: the search opening closes whichever
// is open, from the button or the shortcut alike.
function openBoardSearch(query) {
  objectLinks.close();
  comments.close(false);
  tags.close();
  planning.close();
  facilitation.close(false);
  framesPanel.close(false);
  boardSearch.open({ query });
}
// Removes the drawings under the stylus eraser, each once per gesture.
function eraseAt(p) {
  for (;;) {
    const hit = hitTest(
      visibleItems(),
      p,
      12 / view.z,
      (i) => i.type === "pen" && !drag.erased.has(i.id),
    );
    if (!hit) return;
    drag.erased.add(hit.id);
    if (hasLocked(current.items, new Set([hit.id]), { deleting: true })) {
      if (!drag.lockedTold)
        toast(
          lockedReason(current.items, new Set([hit.id]), { deleting: true }),
        );
      drag.lockedTold = true;
      continue;
    }
    current.items = removeItems(
      current.items,
      new Set([hit.id]),
      selectionOptions(),
    );
    selection.delete(hit.id);
    if (selectionAnchor === hit.id) selectionAnchor = null;
    drag.changed = true;
  }
}
// The objects a move, resize, or endpoint drag changes.
function draggedIds() {
  if (drag?.kind === "resize") return drag.plan.ids;
  if (drag?.kind === "endpoint") return new Set([drag.id]);
  return selection;
}
function cancelTransform() {
  quickPorts.resetGesture();
  if (drag?.kind === "create") {
    drag = null;
    lastTap = null;
    draw();
    return;
  }
  if (drag?.kind === "table-cells") {
    tableEditor.end(true);
    drag = null;
    draw();
    return;
  }
  if (drag && ["marquee", "region"].includes(drag.kind)) {
    if (drag.kind === "region") exportRegion = drag.previousRegion;
    else {
      const existing = new Set(current.items.map((i) => i.id));
      selection = new Set(
        [...drag.previousSelection].filter((id) => existing.has(id)),
      );
      focusedGroup = drag.previousGroup || null;
      selectionAnchor = selection.has(drag.previousAnchor)
        ? drag.previousAnchor
        : null;
    }
    drag = null;
    lastTap = null;
    draw();
    return;
  }
  if (drag?.kind === "pan") {
    view = drag.view;
    drag = null;
    draw();
    return;
  }
  if (
    !drag ||
    !["move", "resize", "rotate", "endpoint", "arrow", "pen", "erase"].includes(
      drag.kind,
    )
  )
    return pointerUp();
  if (["arrow", "pen"].includes(drag.kind)) {
    selection = drag.previousSelection;
    selectionAnchor = drag.previousAnchor;
    focusedGroup = drag.previousGroup;
  }
  if (drag.duplicate) {
    selection = drag.duplicate.sourceSelection;
    selectionAnchor = drag.duplicate.sourceAnchor;
    focusedGroup = drag.duplicate.sourceGroup;
  }
  current.items = drag.original;
  drag = null;
  collaboration?.settle(false);
  sendPresence();
  lastTap = null;
  draw();
}
function startMarquee(p, e, precise = preciseSelection) {
  const previousSelection = new Set(selection),
    previousAnchor = selectionAnchor,
    previousGroup = focusedGroup;
  selection = e.shiftKey ? descendants(current.items, selection) : new Set();
  focusedGroup = null;
  selectionAnchor = null;
  drag = {
    kind: "marquee",
    start: p,
    precise,
    previousSelection,
    previousAnchor,
    previousGroup,
    baseSelection: descendants(current.items, previousSelection),
    index: createMarqueeIndex(current.items, visibleItems()),
  };
}
function updateMarqueeSelection(rect, shiftKey) {
  drag.index ||= createMarqueeIndex(current.items, visibleItems());
  drag.shift = shiftKey;
  selection = new Set([
    ...(shiftKey ? drag.baseSelection : []),
    ...marqueeSelection(drag.index, rect, drag.precise),
  ]);
}
function pointerDown(
  e,
  { marquee = false, precise = preciseSelection, size = false } = {},
) {
  imageCrop.close(false);
  imageReplacement.close();
  if (e.pointerType) lastPointerType = e.pointerType;
  const eraser =
    e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) === 32);
  if (e.button !== 0 && e.button !== 1 && e.button !== 2 && !eraser) return;
  // A stationary long press replaces an uncommitted click. Do not activate its
  // link/table or finish a drag before starting precise selection over it.
  if (marquee) drag = null;
  pointerUp();
  e.preventDefault();
  // A button that only pans leaves focus, and so an open text edit, where
  // it is, as the wheel does.
  if (e.button !== 1 && e.button !== 2)
    pointerFocus(document.querySelector("#canvas"));
  const canvas = e.currentTarget;
  try {
    canvas.setPointerCapture?.(e.pointerId);
  } catch {}
  boardSearch.close(false);
  if (space || tool === "hand" || e.button === 1 || e.button === 2) {
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, view: { ...view } };
    return;
  }
  const p = canvasPoint(e);
  // The eraser end of a stylus, or its eraser button, rubs out drawings
  // whatever the tool, as it does on paper.
  if (eraser) {
    if (isSharedReadOnly()) return toast(sharedReadOnlyReason());
    if (tableEditor.isOpen()) tableEditor.close();
    drag = {
      kind: "erase",
      original: undoCopy(current.items),
      erased: new Set(),
      changed: false,
    };
    eraseAt(p);
    draw();
    return;
  }
  let id = boardHit(p, hitReach(e))?.id;
  if (tableEditor.isOpen()) {
    if (tool === "select" && id === tableEditor.id() && !e.altKey) {
      if (tableEditor.down(e, p)) drag = { kind: "table-cells" };
      return;
    }
    tableEditor.close();
  }
  if (
    objectLinks.isOpen() &&
    objectLinks.pick(current.items.find((i) => i.id === id))
  )
    return;
  if (tool === "comment") {
    if (!isCommentReadOnly())
      comments.compose(
        p,
        current.items.find((i) => i.id === id),
      );
    return;
  }
  const resize = resizeHandleAt(
    current.items,
    selection,
    p,
    view.z,
    selectionAnchor,
    e.pointerType === "touch",
    resizeSides(),
  );
  if (tool === "region") {
    const previousRegion = exportRegion;
    exportRegion = null;
    selection.clear();
    drag = { kind: "region", start: p, previousRegion };
    return;
  }
  if (marquee) {
    startMarquee(p, e, precise);
    toast("Precise selection: enclose at least 90% of each object.");
    draw();
    return;
  }
  if (isSharedReadOnly() && tool !== "select") return;
  const selectedLine =
    tool === "select" &&
    selection.size === 1 &&
    !hasLocked(current.items, selection) &&
    !isSharedReadOnly()
      ? current.items.find((i) => selection.has(i.id) && i.type === "arrow")
      : null;
  const endpoint =
    selectedLine &&
    connectorEndpointHit(selectedLine, p, view.z, e.pointerType === "touch");
  if (endpoint) {
    drag = {
      kind: "endpoint",
      id: selectedLine.id,
      end: endpoint,
      start: p,
      line: clone(selectedLine),
      original: undoCopy(current.items),
      changed: false,
      gridStep: activeGridStep(),
    };
    lastTap = null;
    return;
  }
  // Locks include the workshop's, as on a board the facilitator froze. The
  // rotation handle below the left corner wins over that corner's handle.
  if (
    resize &&
    !(
      resize === "sw" &&
      tool === "select" &&
      rotationHit(
        current.items,
        selection,
        p,
        view.z,
        e.pointerType === "touch",
      )
    ) &&
    !isSharedReadOnly() &&
    !hasLocked(current.items, selection)
  ) {
    const plan = createResizePlan(
      current.items,
      selection,
      selectionAnchor,
      selectionOptions(),
    );
    drag = {
      kind: "resize",
      handle: resize,
      groupFocus: focusedGroup,
      plan,
      start: p,
      box: plan.box,
      original: undoCopy(current.items),
      snapIndex: snapIndex(),
      dimensions: showDimensions
        ? createDimensionIndex(
            visibleItems(),
            selection,
            snapViewport(),
            plan.box,
          )
        : null,
      gridStep: activeGridStep(),
      changed: false,
    };
    return;
  }
  if (
    tool === "select" &&
    !isSharedReadOnly() &&
    rotationHit(current.items, selection, p, view.z, e.pointerType === "touch")
  ) {
    const plan = createRotationPlan(
      current.items,
      selection,
      selectionOptions(),
    );
    drag = {
      kind: "rotate",
      groupFocus: focusedGroup,
      plan,
      start: p,
      original: undoCopy(current.items),
      changed: false,
      angle: plan.box.rotation || 0,
    };
    lastTap = null;
    return;
  }
  if (tool === "select") {
    if (
      id &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      facilitation.voteByClick(id)
    ) {
      lastTap = null;
      draw();
      return;
    }
    // Inside a selected object's box, where it has nothing drawn, a press
    // still takes that object, so a drag moves it. Shift starts a marquee.
    if (!id && !e.shiftKey)
      id = selectedAt(visibleItems(), selection, p, 4 / view.z)?.id;
    if (id) {
      const linkedItem = current.items.find((i) => i.id === id);
      let link =
        !e.shiftKey &&
        !e.altKey &&
        textLinkHit(linkedItem, canvas.getContext("2d"), p);
      const now = performance.now();
      const doubleClick =
        !e.altKey &&
        !e.shiftKey &&
        lastTap?.id === id &&
        now - lastTap.time < DOUBLE_CLICK_MS;
      // A second press within the double-click window opens the object's
      // editor on its release. A press that moves first is a drag: a click
      // followed at once by a drag moves the object rather than editing it.
      let editOnRelease = false;
      if (doubleClick) {
        link = null;
        lastTap = null;
        drag = null;
        if (linkedItem.groupId && focusedGroup !== linkedItem.groupId) {
          selectItems(new Set([id]), { withinGroup: true });
        } else editOnRelease = true;
      } else lastTap = e.altKey ? null : { id, time: now };
      const clickedCell =
        !doubleClick &&
        linkedItem.type === "table" &&
        selection.size === 1 &&
        selection.has(id) &&
        !e.shiftKey &&
        !e.altKey
          ? tableCellAt(linkedItem, p)
          : null;
      if (e.shiftKey) {
        selectionAnchor = null;
        if (focusedGroup && linkedItem.groupId !== focusedGroup) {
          focusedGroup = null;
          selection = descendants(current.items, selection);
        }
        const members = descendants(current.items, new Set([id]), {
          groups: !focusedGroup,
        });
        if (selection.has(id)) {
          members.forEach((id) => selection.delete(id));
          // Taking an object out of the selection starts no drag: a slight
          // wobble would otherwise move what is left and record an undo step.
          selection = descendants(current.items, selection, {
            groups: !focusedGroup,
          });
          draw();
          return;
        }
        members.forEach((id) => selection.add(id));
      } else if (
        !selection.has(id) ||
        (linkedItem.mindMap &&
          !e.altKey &&
          selectionAnchor &&
          selectionAnchor !== id) ||
        (hasLocked(current.items, selection) &&
          !hasLocked(current.items, new Set([id])))
      )
        selectItems(new Set([id]), {
          withinGroup: !!focusedGroup && linkedItem.groupId === focusedGroup,
        });
      selection = descendants(current.items, selection, {
        groups: !focusedGroup,
      });
      // Pressing one of several selected objects, such as something in a
      // selected frame, drags them all; a click without moving selects
      // just that one, as a group stays whole.
      const alone = descendants(current.items, new Set([id]), {
        groups: !focusedGroup,
      });
      const narrow = !e.shiftKey &&
        !e.altKey &&
        [...selection].some((other) => !alone.has(other)) && {
          id,
          withinGroup: !!focusedGroup && linkedItem.groupId === focusedGroup,
        };
      if (hasLocked(current.items, selection) || isSharedReadOnly()) {
        // Nothing here can be dragged, so the editor opens at once.
        if (editOnRelease) return editObject(linkedItem, false, p);
        drag = link
          ? {
              kind: "link",
              id,
              link,
              linkText: linkedItem.text,
              linkRuns: linkedItem.textRuns,
              start: p,
            }
          : null;
        draw();
        return;
      }
      const moving = current.items
        .filter((i) => selection.has(i.id) && movesWith(i, selection))
        .map((i) => ({ item: i, x: i.x, y: i.y }));
      drag = {
        kind: "move",
        groupFocus: focusedGroup,
        narrow: editOnRelease ? false : narrow,
        edit: editOnRelease ? { id, point: p } : null,
        tableCell: clickedCell,
        link,
        id,
        linkText: linkedItem.text,
        linkRuns: linkedItem.textRuns,
        start: p,
        original: undoCopy(current.items),
        mind:
          !e.altKey && linkedItem.mindMap
            ? createMindDrag(current.items, id, selection)
            : null,
        duplicate: e.altKey
          ? {
              sourceSelection: new Set(selection),
              sourceAnchor: selectionAnchor,
              sourceGroup: focusedGroup,
            }
          : null,
        moving,
        box: moving.length ? bounds(moving.map((entry) => entry.item)) : null,
        snapIndex: snapIndex(),
        gridStep: activeGridStep(),
        active: false,
        changed: false,
      };
    } else {
      startMarquee(p, e);
    }
    draw();
    return;
  }
  if (tool === "arrow" || tool === "pen") {
    // Said now, rather than drawing a stroke that is dropped on release.
    if (isSharedReadOnly()) return toast(sharedReadOnlyReason());
    if (current.items.length >= MAX_OBJECTS)
      return toast("A board can contain at most 5,000 objects.");
    const original = undoCopy(current.items),
      previousSelection = new Set(selection);
    const target = tool === "arrow" && !e.altKey ? connectorTarget(p) : null;
    const start =
      tool === "arrow" && !target ? snapGridPoint(p, activeGridStep(e)) : p;
    const i = item(tool, start.x, start.y, {
      ...(tool === "arrow" ? lastStyle.arrow : {}),
      w: 0,
      h: 0,
      ...(tool === "pen" ? { points: startDrawing() } : {}),
    });
    if (target) i.startId = target.id;
    current.items.push(i);
    inferParents(current.items, new Set([i.id]), {
      skip: facilitation.concealedIds(),
    });
    // A new connector is selected to label or restyle it. Drawing selects
    // nothing, so no selection box or toolbar follows the pencil.
    selection = tool === "pen" ? new Set() : new Set([i.id]);
    drag = {
      kind: tool,
      id: i.id,
      start: p,
      original,
      previousSelection,
      previousAnchor: selectionAnchor,
      previousGroup: focusedGroup,
      line: clone(i),
      changed: false,
      gridStep: activeGridStep(),
    };
    draw();
  } else if (
    size &&
    ["note", "text", "rect", "ellipse", "frame"].includes(tool)
  ) {
    // Dragging draws the note, text, shape or frame at the size dragged; it
    // is added on release, as one undo step.
    const gridStep = activeGridStep(e);
    drag = {
      kind: "create",
      type: tool,
      start: snapGridPoint(p, gridStep),
      gridStep,
      marquee: null,
    };
    draw();
  } else {
    const props = armedProps(tool);
    addObject(tool, placeAt(tool, p, props.w ? props : null), props, e);
  }
}
// The size a dragged shape or frame takes: the drag, kept to at least the
// size a shape can be resized to, and square with Shift held.
function createRect(drag, p, e) {
  const end = snapGridPoint(
    p,
    e.altKey || e.ctrlKey || e.metaKey ? 0 : drag.gridStep,
  );
  let w = end.x - drag.start.x,
    h = end.y - drag.start.y;
  if (e.shiftKey) {
    const side = Math.max(Math.abs(w), Math.abs(h));
    w = (w < 0 ? -1 : 1) * side;
    h = (h < 0 ? -1 : 1) * side;
  }
  return {
    x: Math.min(drag.start.x, drag.start.x + w),
    y: Math.min(drag.start.y, drag.start.y + h),
    w: Math.abs(w),
    h: Math.abs(h),
  };
}
function connectorTarget(p, excluded) {
  return hitTest(
    visibleItems(),
    p,
    8 / view.z,
    (i) => !["arrow", "pen", "frame"].includes(i.type) && i.id !== excluded,
  );
}
function previewMindDrop(e, p) {
  if (!drag?.mind || !drag.active) return;
  const candidate =
    e.ctrlKey || e.metaKey || e.altKey
      ? null
      : mindDragCandidate(current.items, drag.mind, p, view.z);
  if (!candidate) {
    drag.mindPreview = null;
    drag.targetId = null;
    return;
  }
  if (
    drag.mindPreview?.id !== candidate.id ||
    drag.mindPreview?.direction !== candidate.direction
  ) {
    try {
      planMindReparent(
        current,
        drag.mind.id,
        candidate.id,
        candidate.direction,
        { validate: false },
      );
      drag.mindPreview = candidate;
    } catch (error) {
      drag.mindPreview = { ...candidate, error: error.message };
    }
  }
  drag.targetId = drag.mindPreview.error ? null : candidate.id;
}
// The resize corner's cursor points along the diagonal it drags, turned
// with a rotated object.
function resizeCursor(box, handle = "se") {
  const base = { se: 45, nw: 45, ne: 135, sw: 135, e: 0, w: 0, n: 90, s: 90 }[
    handle
  ];
  const angle = (((base + (box?.rotation || 0)) % 180) + 180) % 180;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][
    Math.round(angle / 45) % 4
  ];
}
// A thin outline around what a click would select, as the pointer rests on
// it: the object, or its whole group or frame contents. Lines show their own
// handles when selected, and frames would outline most of the board.
function renderHover() {
  const outline = document.querySelector("#hover-outline");
  if (!outline) return;
  const target =
    hovered &&
    tool === "select" &&
    !space &&
    !drag &&
    !editing &&
    !selection.has(hovered)
      ? visibleItems().find((i) => i.id === hovered)
      : null;
  if (!target || ["arrow", "frame"].includes(target.type)) {
    outline.hidden = true;
    return;
  }
  const unit = descendants(current.items, new Set([target.id]), {
    groups: focusedGroup !== target.groupId,
  });
  const members =
    unit.size > 1 ? visibleItems().filter((i) => unit.has(i.id)) : [target];
  const box =
    members.length > 1
      ? bounds(members)
      : {
          x: Math.min(target.x, target.x + target.w),
          y: Math.min(target.y, target.y + target.h),
          w: Math.abs(target.w),
          h: Math.abs(target.h),
        };
  const angle = members.length > 1 ? 0 : rotationOf(target);
  outline.hidden = false;
  Object.assign(outline.style, {
    width: `${box.w * view.z}px`,
    height: `${box.h * view.z}px`,
    transform: `translate(${view.x + box.x * view.z}px, ${view.y + box.y * view.z}px)${angle ? ` rotate(${angle}deg)` : ""}`,
  });
}
// The select tool's cursor while nothing is dragged: a hand where Space
// pans, otherwise what the pointer last rested on. Repaints use it too, so
// a redraw under a resting pointer does not take a resize cursor away.
function idleCursor() {
  if (space) return "grab";
  const p = collaborationCursor;
  if (!p) return "";
  if (tableEditor.isOpen()) return tableEditor.cursor(p);
  // The corner that resizes takes precedence, as pressing it does.
  const editable = !isSharedReadOnly() && !hasLocked(current.items, selection);
  const handle =
    editable &&
    resizeHandleAt(
      current.items,
      selection,
      p,
      view.z,
      selectionAnchor,
      false,
      resizeSides(),
    );
  const rotates =
    !isSharedReadOnly() && rotationHit(current.items, selection, p, view.z);
  return handle && !(handle === "sw" && rotates)
    ? resizeCursor(
        resizeBounds(current.items, selection, selectionAnchor),
        handle,
      )
    : rotates
      ? "grab"
      : "";
}
// Which sides of the selection resize it on their own, as in Miro: a
// single shape, text box, frame, card or drawing. Sticky notes and images
// keep to their corners, and text whose height follows its lines resizes
// only across.
function resizeSides() {
  const chosen = visibleItems().filter((i) => selection.has(i.id));
  const frame = chosen.find(
    (i) => i.id === selectionAnchor && i.type === "frame" && !i.groupId,
  );
  const single = frame || (chosen.length === 1 ? chosen[0] : null);
  if (!single || ["note", "image", "table"].includes(single.type)) return [];
  if (single.mindMap) return [];
  // A side too short on screen for its handle and room to move the object
  // by goes without one; a finger needs more room than a pointer.
  const box = resizeBounds(current.items, selection, selectionAnchor);
  if (!box) return [];
  const least = lastPointerType === "touch" ? 120 : 60;
  return [
    ...(box.w * view.z >= least ? ["e", "w"] : []),
    ...(box.h * view.z >= least && !growsWithText(single) ? ["n", "s"] : []),
  ];
}
// Dragging an object, a handle, a line's end, a marquee or a new object
// within this far of the canvas edge pans the board towards it, faster the
// deeper in, so the drag can go on past what is in view, as in Miro. The
// drag is applied again each frame at the pointer's place on the moved
// board. One frame loop runs, and only while the board pans.
const EDGE_PAN_ZONE = 24;
let edgePan = null;
function edgePanStep() {
  const kinds = ["move", "resize", "endpoint", "arrow", "marquee", "create"];
  if (!drag?.pointer || space || !kinds.includes(drag.kind)) return null;
  // A press must have dragged first: one resting near the edge pans nothing.
  if (!drag.edgeArmed) {
    const p = canvasPoint(drag.pointer);
    if (
      drag.start &&
      Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * view.z <= 3
    )
      return null;
    drag.edgeArmed = true;
  }
  const r = document.querySelector("#canvas").getBoundingClientRect();
  // A canvas not laid out has no edge to pan towards.
  if (!(r.width > 0 && r.height > 0)) return null;
  // Past the edge, as pointer capture allows, it pans at most twice as fast.
  const depth = (near, far) =>
    Math.min(2, Math.max(0, EDGE_PAN_ZONE - near) / EDGE_PAN_ZONE) -
    Math.min(2, Math.max(0, EDGE_PAN_ZONE - far) / EDGE_PAN_ZONE);
  const { clientX: x, clientY: y } = drag.pointer;
  const dx = depth(x - r.left, r.left + r.width - x),
    dy = depth(y - r.top, r.top + r.height - y);
  return dx || dy ? { dx, dy } : null;
}
function edgePanFrame(now) {
  const step = edgePanStep();
  if (!step || !edgePan) {
    edgePan = null;
    return;
  }
  // About 15px a frame at full depth, whatever the frame rate.
  const elapsed = Math.min(50, Math.max(0, now - edgePan.time));
  edgePan.time = now;
  view = {
    ...view,
    x: view.x + step.dx * elapsed * 0.9,
    y: view.y + step.dy * elapsed * 0.9,
  };
  // Objects come into view as the board moves, and snapping finds them.
  if (drag.snapIndex && now - edgePan.indexed > 250) {
    drag.snapIndex = snapIndex();
    edgePan.indexed = now;
  }
  pointerMove(drag.pointer);
  draw();
  if (edgePan) edgePan.frame = requestAnimationFrame(edgePanFrame);
}
function edgePanSoon() {
  if (edgePan || !edgePanStep()) return;
  attention.stop();
  const now = performance.now();
  edgePan = {
    time: now,
    indexed: now,
    frame: requestAnimationFrame(edgePanFrame),
  };
}
function pointerMove(e) {
  if (e.pointerType) lastPointerType = e.pointerType;
  collaborationCursor = canvasPoint(e);
  if (drag?.kind === "table-cells") {
    tableEditor.move(collaborationCursor);
    return;
  }
  if (!drag) {
    if (tool === "select")
      document.querySelector("#canvas").style.cursor = idleCursor();
    const hit =
      tool === "select" && !space && !editing
        ? boardHit(collaborationCursor, hitReach(e))
        : null;
    const next = hit?.mindMap && mindView.scene().branches.size ? hit.id : null;
    if (hoveredMind !== next) {
      hoveredMind = next;
      mindCollapse.render();
    }
    if (hovered !== (hit?.id ?? null)) {
      hovered = hit?.id ?? null;
      renderHover();
    }
    sendPresence();
    return;
  }
  if (
    [
      "move",
      "resize",
      "rotate",
      "endpoint",
      "arrow",
      "marquee",
      "create",
    ].includes(drag.kind)
  ) {
    drag.pointer = {
      clientX: e.clientX,
      clientY: e.clientY,
      altKey: !!e.altKey,
      shiftKey: !!e.shiftKey,
      ctrlKey: !!e.ctrlKey,
      metaKey: !!e.metaKey,
    };
    edgePanSoon();
  }
  const p = canvasPoint(e);
  if (drag.kind === "link") {
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * view.z > 3)
      drag.active = true;
    return;
  }
  if (drag.kind === "pan") {
    // Step by step from the last position, so a wheel zoom in the middle of
    // the pan is kept rather than undone by the next move.
    view.x += e.clientX - drag.sx;
    view.y += e.clientY - drag.sy;
    drag.sx = e.clientX;
    drag.sy = e.clientY;
    draw();
    return;
  } else if (drag.kind === "move") {
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * view.z > 3) {
      drag.active = true;
      lastTap = null;
    }
    if (drag.active) {
      if (drag.duplicate && !drag.duplicate.ids) {
        try {
          const plan = planDuplication(current.items, selection, {
            ...selectionOptions(),
            hidden: facilitation.concealedIds(),
            dx: 0,
            dy: 0,
          });
          current.items.push(...plan.copies);
          drag.duplicate.ids = plan.selection;
          drag.duplicate.copies = plan.copies;
          selection = plan.selection;
          focusedGroup = null;
          selectionAnchor = plan.idMap.get(drag.duplicate.sourceAnchor) || null;
          drag.moving = plan.copies
            .filter((i) => movesWith(i, plan.selection))
            .map((i) => ({ item: i, x: i.x, y: i.y }));
          drag.box = bounds(plan.copies);
          drag.snapIndex = snapIndex();
        } catch (error) {
          toast(error.message);
          return cancelTransform();
        }
      }
      // Shift keeps the move straight: along whichever axis the pointer
      // has gone further, as in Miro.
      let dx = p.x - drag.start.x,
        dy = p.y - drag.start.y;
      const axis = e.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? "x" : "y") : "";
      if (axis === "x") dy = 0;
      if (axis === "y") dx = 0;
      const snapped = snapGridMove(
        drag.box,
        snapMove(
          drag.snapIndex,
          drag.box,
          dx,
          dy,
          view.z,
          !snapping || e.altKey,
        ),
        e.altKey || e.ctrlKey || e.metaKey ? 0 : drag.gridStep,
      );
      if (axis === "x") snapped.dy = 0;
      if (axis === "y") snapped.dx = 0;
      // Objects stop at the edge of the board rather than leave it.
      drag.limits ||= drag.moving.reduce(
        (l, { x, y }) => ({
          left: Math.max(l.left, -BOARD_LIMIT - x),
          right: Math.min(l.right, BOARD_LIMIT - x),
          up: Math.max(l.up, -BOARD_LIMIT - y),
          down: Math.min(l.down, BOARD_LIMIT - y),
        }),
        { left: -Infinity, right: Infinity, up: -Infinity, down: Infinity },
      );
      snapped.dx = Math.max(
        drag.limits.left,
        Math.min(drag.limits.right, snapped.dx),
      );
      snapped.dy = Math.max(
        drag.limits.up,
        Math.min(drag.limits.down, snapped.dy),
      );
      for (const { item: i, x, y } of drag.moving) {
        i.x = x + snapped.dx;
        i.y = y + snapped.dy;
      }
      drag.guides = axis
        ? snapped.guides.filter((g) => g.axis === axis)
        : snapped.guides;
      drag.dropFrames = dropFrames(drag.moving);
      drag.changed =
        drag.moving.length > 0 &&
        (Math.abs(snapped.dx) > 1e-9 || Math.abs(snapped.dy) > 1e-9);
      previewMindDrop(e, p);
    }
  } else if (drag.kind === "erase") {
    if (isSharedReadOnly()) return cancelTransform();
    eraseAt(p);
  } else if (drag.kind === "rotate") {
    if (isSharedReadOnly() || hasLocked(current.items, drag.plan.ids))
      return cancelTransform();
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * view.z > 3)
      drag.active = true;
    if (drag.active) {
      const delta = rotationDelta(drag.plan, drag.start, p, e.shiftKey);
      try {
        applyRotation(current.items, drag.plan, delta);
        drag.changed = Math.abs(delta % 360) > 1e-9;
        drag.angle = (drag.plan.box.rotation || 0) + delta;
      } catch (error) {
        toast(error.message);
        return cancelTransform();
      }
    }
  } else if (drag.kind === "resize") {
    const delta = rotatePoint(
      { x: p.x - drag.start.x, y: p.y - drag.start.y },
      { x: 0, y: 0 },
      -(drag.box.rotation || 0),
    );
    // A left or top handle grows the box the other way, and a side handle
    // changes only its own dimension; the opposite side stays in place.
    const handle = drag.handle || "se",
      [fx, fy] = RESIZE_HANDLES[handle],
      side = handle.length === 1,
      width = fx === 0.5 ? drag.box.w : drag.box.w + (fx ? delta.x : -delta.x),
      height =
        fy === 0.5 || drag.plan.autoHeight
          ? drag.box.h
          : drag.box.h + (fy ? delta.y : -delta.y);
    // Snapping and the grid line up the right and bottom edges.
    const aligned = fx !== 0 && fy !== 0;
    const limits = resizeLimits(drag.plan);
    // Objects resized together scale their text, which stays between 8 and
    // 100 pixels; when that is what stops the selection, it says so once
    // rather than stopping without a word.
    if (drag.plan.scaleText && !drag.textLimitShown) {
      const free = resizeLimits(drag.plan, false),
        past = (value, low, high, freeLow, freeHigh) =>
          (value > high + 1e-6 && high < freeHigh - 1e-6) ||
          (value < low - 1e-6 && low > freeLow + 1e-6);
      if (
        (fx !== 0.5 &&
          past(width, limits.minW, limits.maxW, free.minW, free.maxW)) ||
        (fy !== 0.5 &&
          !drag.plan.autoHeight &&
          past(height, limits.minH, limits.maxH, free.minH, free.maxH))
      ) {
        drag.textLimitShown = true;
        toast(
          "Text stays between 8 and 100 pixels, so this selection cannot be resized further.",
        );
      }
    }
    const snapped = snapResize(
      drag.snapIndex,
      drag.box,
      width,
      height,
      view.z,
      !snapping || e.altKey || !!drag.box.rotation || !aligned,
      {
        ...limits,
        gridStep:
          e.altKey || e.ctrlKey || e.metaKey || drag.box.rotation || !aligned
            ? 0
            : drag.gridStep,
        gridY: !drag.plan.autoHeight && fy !== 0.5,
        dimensions: drag.dimensions,
        dimensionY: !drag.plan.autoHeight,
        proportional:
          !side &&
          !drag.plan.autoHeight &&
          (drag.plan.fixedProportions ||
            drag.plan.proportional !== !!e.shiftKey),
      },
    );
    if (side && fx === 0.5) snapped.w = drag.box.w;
    if (side && fy === 0.5) snapped.h = drag.box.h;
    try {
      applyResize(
        current.items,
        drag.plan,
        snapped.w,
        snapped.h,
        drag.plan.scaleText,
        { x: fx === 0 ? 1 : 0, y: fy === 0 ? 1 : 0 },
      );
      drag.error = null;
      drag.guides = drag.plan.autoHeight
        ? snapped.guides.filter((g) => g.axis === "x")
        : snapped.guides;
      drag.changed =
        Math.abs(snapped.w - drag.box.w) > 1e-9 ||
        (!drag.plan.autoHeight && Math.abs(snapped.h - drag.box.h) > 1e-9);
    } catch (error) {
      if (drag.error !== error.message) toast(error.message);
      drag.error = error.message;
      drag.guides = [];
    }
  } else if (["arrow", "endpoint"].includes(drag.kind)) {
    const i = current.items.find((i) => i.id === drag.id);
    if (!i || isSharedReadOnly() || hasLocked(current.items, new Set([i.id])))
      return cancelTransform();
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * view.z > 3)
      drag.active = true;
    if (drag.active) {
      const geometry = ["x", "y", "w", "h", "startId", "endId", "routeAxis"];
      for (const key of geometry) {
        if (Object.hasOwn(drag.line, key)) i[key] = drag.line[key];
        else delete i[key];
      }
      const end = drag.end || "end";
      const fixed =
        end === "start" ? { x: i.x + i.w, y: i.y + i.h } : { x: i.x, y: i.y };
      let point = p;
      const target = e.altKey
        ? null
        : connectorTarget(p, i[end === "start" ? "endId" : "startId"]);
      if (e.shiftKey && !target) {
        const angle =
          (Math.round(
            Math.atan2(p.y - fixed.y, p.x - fixed.x) / (Math.PI / 4),
          ) *
            Math.PI) /
          4;
        const length = Math.hypot(p.x - fixed.x, p.y - fixed.y);
        point = {
          x: fixed.x + Math.cos(angle) * length,
          y: fixed.y + Math.sin(angle) * length,
        };
      } else if (!target && !e.altKey && !e.ctrlKey && !e.metaKey) {
        point = snapGridPoint(point, drag.gridStep);
      }
      setConnectorEnd(i, end, point, target);
      updateConnectors(current.items);
      drag.targetId = target?.id;
      drag.changed = geometry.some((key) => i[key] !== drag.line[key]);
    }
  } else if (drag.kind === "create") {
    drag.marquee = createRect(drag, p, e);
    draw();
    return;
  } else if (drag.kind === "marquee" || drag.kind === "region") {
    const a = {
      x: Math.min(p.x, drag.start.x),
      y: Math.min(p.y, drag.start.y),
      w: Math.abs(p.x - drag.start.x),
      h: Math.abs(p.y - drag.start.y),
    };
    if (drag.kind !== "region") {
      // A press that wobbles a pixel or two is a click, not a marquee: it
      // must not take the frame whose interior it happens to be in.
      if (Math.max(a.w, a.h) * view.z > 3)
        updateMarqueeSelection(a, e.shiftKey);
      a.precise = drag.precise;
    }
    drag.marquee = a;
    draw();
    return;
  } else {
    const i = current.items.find((i) => i.id === drag.id);
    i.w = p.x - drag.start.x;
    i.h = p.y - drag.start.y;
    if (
      drag.kind === "pen" &&
      !extendDrawing(i.points, i.w, i.h, view.z) &&
      !drag.full
    ) {
      drag.full = true;
      toast("This drawing is full. Draw again to continue.");
    }
  }
  updateConnectors(current.items);
  if (drag.duplicate?.copies) {
    try {
      checkDuplicateGeometry(drag.duplicate.copies);
    } catch (error) {
      toast(error.message);
      return cancelTransform();
    }
  }
  sendPresence();
  draw();
}
function pointerUp(event) {
  if (!drag) return;
  if (drag.kind === "rotate" && event?.type === "pointerup") {
    pointerMove(event);
    if (!drag) return;
  }
  if (drag.kind === "marquee" && (event?.type === "pointerup" || drag.pointer))
    pointerMove(event?.type === "pointerup" ? event : drag.pointer);
  if (drag.kind === "table-cells") {
    tableEditor.end();
    drag = null;
    return;
  }
  if (drag.kind === "create") {
    const { type, start, marquee } = drag;
    drag = null;
    // Only a release adds the object; anything else that ends the gesture,
    // such as the window losing focus, leaves the board as it was.
    if (!["pointerup", "lostpointercapture"].includes(event?.type))
      return draw();
    // Text keeps growing with what is typed, so a drag sets its width. A
    // drag too small for the smallest size, as a press that wobbled, places
    // the default at the press as a click does, not a blob of that size.
    const least = type === "text" ? { w: 60 } : { w: 24, h: 24 };
    if (
      !marquee ||
      Object.keys(least).every((axis) => marquee[axis] < least[axis])
    )
      return void addObject(
        type,
        placeAt(type, start, armedProps(type).w ? armedProps(type) : null),
        armedProps(type),
        event,
      );
    const created = addObject(
      type,
      { x: marquee.x, y: marquee.y },
      type === "text"
        ? { w: Math.max(least.w, marquee.w) }
        : {
            ...armedProps(type),
            w: Math.max(least.w, marquee.w),
            h: Math.max(least.h, marquee.h),
          },
      event,
      // A frame drawn around objects takes them in, as its tip says.
      type === "frame"
        ? (frame) => {
            const hidden = facilitation.concealedIds();
            const within = () =>
              current.items.filter(
                (i) =>
                  i !== frame &&
                  i.type !== "frame" &&
                  !hidden.has(i.id) &&
                  i.x + i.w / 2 >= frame.x &&
                  i.x + i.w / 2 <= frame.x + frame.w &&
                  i.y + i.h / 2 >= frame.y &&
                  i.y + i.h / 2 <= frame.y + frame.h,
              );
            // Its title is drawn inside its top edge, behind what it holds,
            // so a frame drawn tightly around objects grows upward enough
            // to keep the title clear of those under it, as a frame made
            // around a selection does.
            const style = textStyle(frame),
              ctx = document.querySelector("#canvas").getContext("2d");
            ctx.font = style.font;
            const title = {
                x: frame.x,
                w: Math.min(
                  frame.w,
                  style.padding * 2 + ctx.measureText(frame.text || "").width,
                ),
                h: style.padding + style.size * 1.35 + 8,
              },
              under = within()
                .filter((i) => i.type !== "arrow")
                .map((i) => bounds([i]))
                .filter(
                  (b) =>
                    b.x < title.x + title.w &&
                    b.x + b.w > title.x &&
                    b.y < frame.y + title.h,
                );
            if (under.length) {
              const step = activeGridStep(event),
                overlap =
                  frame.y + title.h - Math.min(...under.map((b) => b.y)),
                grow = step ? Math.ceil(overlap / step) * step : overlap,
                top = Math.max(-BOARD_LIMIT, frame.y - grow);
              frame.h += frame.y - top;
              frame.y = top;
            }
            const inside = new Set(within().map((i) => i.id));
            if (inside.size)
              inferParents(current.items, inside, { skip: hidden });
          }
        : undefined,
    );
    if (created) lastTap = null;
    return;
  }
  if (drag.mind && drag.active) {
    // WebKit ends a drag released past the canvas by taking its capture
    // away; the branch then lands where it was last previewed.
    const release =
      event?.type === "pointerup"
        ? event
        : event?.type === "lostpointercapture"
          ? drag.pointer
          : null;
    if (
      !release ||
      isSharedReadOnly() ||
      !validMindDrag(current.items, drag.mind) ||
      hasLocked(current.items, selection)
    )
      return cancelTransform();
    pointerMove(release);
    if (!drag) return;
    if (drag.mindPreview) {
      try {
        const { id, direction } = drag.mindPreview;
        const plan = planMindReparent(current, drag.mind.id, id, direction);
        const byId = new Map(current.items.map((i) => [i.id, i]));
        for (const patch of plan.patch) {
          const node = byId.get(patch.id);
          node.x = patch.x;
          node.y = patch.y;
          if (patch.order !== undefined) node.order = patch.order;
          node.mindMap = { ...patch.mindMap };
          if (patch.mindCollapsed !== undefined)
            node.mindCollapsed = patch.mindCollapsed;
        }
        mindView.invalidate();
        drag.mindReparented = plan.patch.length > 0;
        drag.changed ||= drag.mindReparented;
      } catch (error) {
        toast(error.message);
        return cancelTransform();
      }
    }
  }
  const clickedCell =
    event?.type === "pointerup" && !drag.active && drag.tableCell;
  const editOnRelease =
    event?.type === "pointerup" && drag.kind === "move" && !drag.active
      ? drag.edit
      : null;
  const narrowTo =
    event?.type === "pointerup" &&
    drag.kind === "move" &&
    !drag.active &&
    !drag.duplicate &&
    drag.narrow;
  const clickedTable =
    clickedCell && current.items.find((i) => i.id === drag.id);
  if (
    drag.duplicate &&
    (!drag.changed || isSharedReadOnly() || current.items.length > MAX_OBJECTS)
  )
    return cancelTransform();
  const linkedItem = drag.link && current.items.find((i) => i.id === drag.id);
  const clickedLink =
    event?.type === "pointerup" &&
    !drag.active &&
    linkedItem?.text === drag.linkText &&
    linkedItem?.textRuns === drag.linkRuns
      ? drag.link
      : null;
  if (drag.kind === "region") {
    const region = drag.marquee;
    // A tap selects no region: keep the previous one.
    if (!region || region.w * view.z < 3 || region.h * view.z < 3)
      return cancelTransform();
    exportRegion = region;
    drag = null;
    setTool("select");
    toast(
      "Region selected. Open Export to use it, or press Escape to clear it.",
    );
    return;
  }
  const createdLine =
    drag.kind === "arrow" && current.items.find((i) => i.id === drag.id);
  if (
    drag.kind === "arrow" &&
    (!createdLine ||
      !drag.changed ||
      Math.hypot(createdLine.w, createdLine.h) * view.z < 3)
  ) {
    cancelTransform();
    return;
  }
  if (drag.kind === "erase" && !drag.changed) {
    drag = null;
    draw();
    return;
  }
  if (
    isSharedReadOnly() &&
    ["move", "resize", "rotate", "endpoint", "arrow", "pen", "erase"].includes(
      drag.kind,
    )
  ) {
    // Never dropped without a word: the reason names what to wait for, and
    // outlasts any tip the cancelled gesture shows.
    const explain = drag.changed || ["arrow", "pen"].includes(drag.kind);
    cancelTransform();
    if (explain) toast(sharedReadOnlyReason());
    return;
  }
  if (
    ["move", "resize", "endpoint"].includes(drag.kind) &&
    drag.changed &&
    !drag.duplicate &&
    hasLocked(current.items, draggedIds())
  ) {
    const ids = draggedIds();
    cancelTransform();
    return toast(lockedReason(current.items, ids));
  }
  // Moving a dependency line's end onto another task can close a loop of
  // tasks waiting for each other, which choosing the dependency refuses.
  if (
    drag.kind === "endpoint" &&
    drag.changed &&
    planning.dependencyLoop(current.items, drag.id)
  ) {
    cancelTransform();
    return toast(
      "This dependency would make these tasks wait for each other in a loop, so none of them could start.",
    );
  }
  if (
    (["move", "resize", "rotate", "endpoint", "arrow", "erase"].includes(
      drag.kind,
    ) &&
      drag.changed) ||
    drag.kind === "pen"
  ) {
    checkpoint("Board edit", {
      ...sharedCopy({ ...current, items: [] }),
      items: undoCopy(drag.original),
    });
    if (!collaboration) history.push(undoState(drag.original));
  }
  if (["arrow", "pen"].includes(drag.kind) || drag.changed) {
    if (drag.kind === "pen") {
      const i = current.items.find((i) => i.id === drag.id);
      const xs = i.points.map((p) => p[0]),
        ys = i.points.map((p) => p[1]);
      const minX = Math.min(...xs),
        minY = Math.min(...ys);
      i.points = i.points.map((p) => [p[0] - minX, p[1] - minY]);
      i.x += minX;
      i.y += minY;
      i.w = Math.max(...xs) - minX;
      i.h = Math.max(...ys) - minY;
    }
    // A new drawing or line belongs to the frame its middle is in, as a
    // moved object does, not the one it was started in.
    if (["arrow", "pen"].includes(drag.kind))
      inferParents(current.items, new Set([drag.id]), {
        skip: facilitation.concealedIds(),
      });
    if (["move", "resize", "rotate"].includes(drag.kind)) {
      const moved = selection;
      const skip = facilitation.concealedIds();
      if (drag.duplicate) placeDuplicates(current.items, moved, skip);
      else inferMovedParents(current.items, drag.plan?.ids || moved, { skip });
      if (drag.kind === "resize") reframeResized(drag.plan, skip);
      planning.syncStatus(planning.parents(drag.original));
    }
    if (drag.original && !drag.mindReparented)
      preserveManualMindMoves(drag.original, current.items);
    autoLayoutMindMaps(current.items);
    updateConnectors(current.items);
    save();
    collaboration?.settle();
  }
  if (drag.kind === "marquee") {
    // Only what the marquee itself took leaves out protected objects: one
    // chosen before, kept with Shift, stays chosen as with Shift-click.
    const kept = drag.shift ? drag.baseSelection : new Set();
    selection = new Set([
      ...[...selection].filter((id) => kept.has(id)),
      ...unlockedSelection(
        current.items,
        new Set([...selection].filter((id) => !kept.has(id))),
      ),
    ]);
  }
  const movedBranch = drag.mindReparented
    ? bounds(
        current.items.filter(
          (i) => i.id === drag.mind.id || i.id === drag.mindPreview.id,
        ),
      )
    : null;
  drag = null;
  if (narrowTo && current.items.some((i) => i.id === narrowTo.id))
    selectItems(new Set([narrowTo.id]), { withinGroup: narrowTo.withinGroup });
  sendPresence();
  if (movedBranch) revealQuickObject(movedBranch, { minimal: true });
  else draw();
  if (clickedTable) tableEditor.open(clickedTable, clickedCell);
  if (editOnRelease) {
    const target = current.items.find((i) => i.id === editOnRelease.id);
    if (target) editObject(target, false, editOnRelease.point);
  }
  if (clickedLink) {
    const rect = document.querySelector("#canvas").getBoundingClientRect();
    textLinkPreview.show(linkedItem, clickedLink, {
      x: event.clientX - rect.left + 12,
      y: event.clientY - rect.top + 12,
    });
  }
}
function fit() {
  attention.stop();
  const shown = visibleItems(),
    r = document.querySelector("#canvas").getBoundingClientRect(),
    across = Math.max(80, r.width - (r.width < 760 ? 32 : 160)),
    down = Math.max(80, r.height - 180),
    room = (a) => Math.min(across / (a.w + 80), down / (a.h + 80));
  let a = bounds(shown);
  // A board spread wider than the furthest zoom out shows would be
  // centred on the empty middle between its parts. The part holding the
  // most objects is fitted instead, and the person told.
  if (r.width && r.height && room(a) < MIN_ZOOM) {
    a = bounds(
      busiestPart(shown, across / MIN_ZOOM - 80, down / MIN_ZOOM - 80),
    );
    toast(
      "This board is too spread out to show whole. Showing the part with the most objects.",
    );
  }
  // A canvas not laid out yet has no room to fit into; it keeps the zoom
  // limit readable text needs rather than shrinking the board to a speck.
  view.z = Math.max(
    r.width && r.height ? MIN_ZOOM : DETAIL_ZOOM,
    Math.min(1.25, room(a)),
  );
  view.x = r.width / 2 - (a.x + a.w / 2) * view.z;
  view.y = r.height / 2 - (a.y + a.h / 2) * view.z;
  draw();
}
// Browser Back and Forward between the library and a board close the
// dialogs of the page they leave, so none acts on a board that is not open.
// Moving from one board to another leaves them open: those that act on
// their board check they are still on it, as version history and AI
// reviews do.
function closeDialogs() {
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
}
function modal(title, content, onReady) {
  canvasNavigation.finish();
  minimap.cancel();
  const previous = document.activeElement;
  const d = document.createElement("dialog");
  d.setAttribute("aria-label", title);
  d.innerHTML = `<div class="dialog-header"><h2>${title}</h2><button class="icon-btn" aria-label="Close dialog">${icon("x")}</button></div>${content}`;
  document.body.append(d);
  d.querySelector(".dialog-header button").onclick = () => d.close();
  d.addEventListener("close", () => {
    const restoreFocus =
      document.activeElement === document.body ||
      d.contains(document.activeElement);
    d.remove();
    if (restoreFocus) {
      if (previous?.isConnected) previous.focus();
      else document.querySelector("#canvas")?.focus();
    }
  });
  // A click on the backdrop closes the dialog. A press inside it that is
  // released over the backdrop, as when text in a field is selected by
  // dragging, also arrives as a click on the dialog itself, so a press
  // that began inside is not a close.
  const onBackdrop = (e) => {
    const box = d.getBoundingClientRect();
    return (
      e.target === d &&
      (e.clientX < box.left ||
        e.clientX > box.right ||
        e.clientY < box.top ||
        e.clientY > box.bottom)
    );
  };
  let pressedBackdrop = null;
  d.addEventListener("pointerdown", (e) => {
    pressedBackdrop = onBackdrop(e);
  });
  d.addEventListener("click", (e) => {
    const pressed = pressedBackdrop;
    pressedBackdrop = null;
    if (pressed !== false && onBackdrop(e)) d.close();
  });
  d.showModal();
  // The keyboard starts on what the dialog is for: its first field, or
  // else the choice that changes nothing, never on Close or on a button
  // that acts. A dialog's own setup may move it afterwards.
  const first = [
    ...d.querySelectorAll(
      "[autofocus], input, select, textarea, button.secondary, button.text-btn",
    ),
  ].find(
    (el) =>
      !el.closest(".dialog-header") &&
      !el.disabled &&
      !el.closest("[hidden]") &&
      !el.classList.contains("danger"),
  );
  first?.focus({ preventScroll: true });
  iconsRefresh();
  onReady?.(d);
  translateUI(d);
  return d;
}
function rotateSelectionDialog() {
  if (!canEditSelection()) return;
  const plan = createRotationPlan(current.items, selection, selectionOptions());
  if (!plan)
    return toast("Select shapes, text, images, cards, or drawings to rotate.");
  const target = current,
    signatureOptions = { groups: !focusedGroup },
    signature = rotationSignature(current.items, plan.ids, signatureOptions);
  const single = plan.items.length === 1,
    initial = single ? rotationOf(plan.items[0]) : 0,
    displayed = String(Math.round(initial * 1000) / 1000);
  modal(
    "Rotate selection",
    `<form>
    <label class="field">${single ? "Angle (degrees)" : "Rotate by (degrees)"}<input id="rotation-angle" type="number" step="any" value="${displayed}" aria-describedby="rotation-error" required></label>
    <div class="dialog-footer"><button type="button" class="secondary" data-turn="-90">−90°</button><button type="button" class="secondary" data-turn="90">+90°</button>${single ? '<button type="button" class="secondary" id="rotation-reset">Reset angle</button>' : ""}</div>
    <p class="dialog-copy">Drag the rotation handle below the left corner. Hold Shift to snap to 15° steps. Escape cancels.</p>
    <p id="rotation-error" class="dialog-copy" role="alert" hidden></p>
    <div class="dialog-footer"><button class="primary" type="submit">Apply rotation</button></div></form>`,
    (d) => {
      const input = d.querySelector("#rotation-angle"),
        errorMessage = d.querySelector("#rotation-error");
      const clearError = () => {
        errorMessage.textContent = "";
        errorMessage.hidden = true;
        input.removeAttribute("aria-invalid");
      };
      let edited = false;
      input.oninput = () => {
        edited = true;
        clearError();
      };
      for (const button of d.querySelectorAll("[data-turn]"))
        button.onclick = () => {
          input.value =
            (input.value === displayed ? initial : +input.value || 0) +
            +button.dataset.turn;
          edited = true;
          clearError();
        };
      const reset = d.querySelector("#rotation-reset");
      if (reset)
        reset.onclick = () => {
          input.value = 0;
          edited = true;
          clearError();
        };
      input.focus();
      input.select();
      d.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        clearError();
        if (!d.querySelector("form").reportValidity()) return;
        if (
          current !== target ||
          signature !==
            rotationSignature(current.items, plan.ids, signatureOptions)
        ) {
          d.close();
          return toast("The selection changed. Select it again.");
        }
        if (!canEditSelection(plan.ids)) return;
        const delta =
          !edited && input.value === displayed ? 0 : +input.value - initial;
        try {
          applyRotation(clone(current.items), plan, delta);
          if (Math.abs(delta % 360) > 1e-9)
            mutate(() => {
              applyRotation(current.items, plan, delta);
              inferMovedParents(current.items, plan.ids, {
                skip: facilitation.concealedIds(),
              });
            });
          d.close();
        } catch (error) {
          errorMessage.textContent = t(error.message);
          errorMessage.hidden = false;
          input.setAttribute("aria-invalid", "true");
          input.focus();
        }
      };
    },
  );
}
// The export region stays until it is replaced, the board changes, or it is
// cleared with Escape or More tools.
function clearExportRegion() {
  if (!exportRegion) return false;
  exportRegion = null;
  draw();
  toast("Export region cleared.");
  return true;
}
function exactRegionDialog() {
  if (!current) return;
  const target = current,
    canvas = document.querySelector("#canvas"),
    size = canvas.getBoundingClientRect(),
    region = exportRegion || {
      x: Math.max(-1e6, Math.min(1e6, -view.x / view.z)),
      y: Math.max(-1e6, Math.min(1e6, -view.y / view.z)),
      w: Math.max(2, Math.min(1e6, (size.width || 1200) / view.z)),
      h: Math.max(2, Math.min(1e6, (size.height || 900) / view.z)),
    };
  modal(
    "Set export region",
    `<form id="region-form"><p class="dialog-copy" id="region-help">Enter the top-left position and size of the export region in board pixels.</p><div class="field-row"><label class="field">Horizontal position<input id="region-x" type="number" step="any" min="-1000000" max="1000000" value="${region.x}" required aria-describedby="region-help"></label><label class="field">Vertical position<input id="region-y" type="number" step="any" min="-1000000" max="1000000" value="${region.y}" required aria-describedby="region-help"></label></div><div class="field-row"><label class="field">Width<input id="region-width" type="number" step="any" min="2" max="1000000" value="${region.w}" required aria-describedby="region-help"></label><label class="field">Height<input id="region-height" type="number" step="any" min="2" max="1000000" value="${region.h}" required aria-describedby="region-help"></label></div><div class="dialog-footer"><button class="primary" type="submit">Use region</button></div></form>`,
    (d) => {
      d.querySelector("#region-x").focus();
      d.querySelector("#region-x").select();
      d.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        if (!d.querySelector("form").reportValidity()) return;
        if (current !== target) return d.close();
        exportRegion = {
          x: d.querySelector("#region-x").valueAsNumber,
          y: d.querySelector("#region-y").valueAsNumber,
          w: d.querySelector("#region-width").valueAsNumber,
          h: d.querySelector("#region-height").valueAsNumber,
        };
        selection.clear();
        setTool("select");
        d.close();
        draw();
        toast(
          "Region selected. Open Export to use it, or press Escape to clear it.",
        );
      };
    },
  );
}
function moveSelectionDialog() {
  if (!selection.size) return toast("Select objects first.");
  if (!canEditSelection()) return;
  const target = current,
    ids = new Set(selection),
    options = selectionOptions(),
    expanded = descendants(current.items, ids, options);
  if (!current.items.some((i) => expanded.has(i.id) && !isConnector(i)))
    return toast("Select objects that can be moved.");
  const selected = [...ids].sort().join(),
    signature = rotationSignature(current.items, ids, options);
  modal(
    "Move selection",
    `<form><p class="dialog-copy" id="move-help">Move the selection and its contents by a distance in board pixels. Positive values move right or down; negative values move left or up.</p><div class="field-row"><label class="field">Horizontal distance<input id="move-x" type="number" step="any" min="-2000000" max="2000000" value="0" aria-describedby="move-help move-error" required></label><label class="field">Vertical distance<input id="move-y" type="number" step="any" min="-2000000" max="2000000" value="0" aria-describedby="move-help move-error" required></label></div><p id="move-error" role="alert" hidden></p><div class="dialog-footer"><button class="primary" type="submit">Apply move</button></div></form>`,
    (d) => {
      const x = d.querySelector("#move-x"),
        y = d.querySelector("#move-y");
      x.focus();
      x.select();
      d.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        if (!d.querySelector("form").reportValidity()) return;
        if (
          current !== target ||
          [...selection].sort().join() !== selected ||
          rotationSignature(current.items, ids, options) !== signature
        ) {
          d.close();
          return toast("The selection changed. Select it again.");
        }
        if (!canEditSelection(ids)) return;
        const dx = x.valueAsNumber,
          dy = y.valueAsNumber;
        // Check the complete move before recording history or changing a
        // frame, its contents, or connectors attached to the selection.
        const trial = clone(current.items);
        moveItems(trial, ids, dx, dy, options);
        if (
          trial.some((i) =>
            [i.x, i.y, i.w, i.h].some(
              (n) => !Number.isFinite(n) || Math.abs(n) > 1e6,
            ),
          )
        ) {
          const error = d.querySelector("#move-error");
          error.textContent = t(
            "Move exceeds the board limits. Enter a smaller distance.",
          );
          error.hidden = false;
          return;
        }
        if (dx || dy)
          mutate(() => {
            moveItems(current.items, ids, dx, dy, options);
            inferMovedParents(current.items, ids, {
              skip: facilitation.concealedIds(),
            });
          });
        d.close();
      };
    },
  );
}
function resizeSelectionDialog() {
  if (!canEditSelection()) return;
  const plan = createResizePlan(
    current.items,
    selection,
    selectionAnchor,
    selectionOptions(),
  );
  if (!plan) return toast("Select objects with a resizable area.");
  const target = current,
    signatureOptions = { groups: !focusedGroup },
    signature = rotationSignature(current.items, plan.ids, signatureOptions);
  const round = (n) => Math.round(n * 1000) / 1000;
  // A frame resized alone, its contents staying where they are, or an
  // empty one, can take a slide, page or screen format.
  const frameAlone =
    plan.frameOnly ||
    (plan.items.length === 1 && plan.items[0].type === "frame");
  modal(
    frameAlone ? "Resize frame" : "Resize selection",
    `<form>
    <p class="dialog-copy">${plan.autoHeight ? "Height adjusts to the text. Change the width to rewrap it." : frameAlone ? "Frame contents stay in place." : "Resize objects and their spacing together."}</p>
    ${frameAlone ? `<label class="field">${t("Frame format")}<select id="resize-format">${FRAME_FORMATS.map((f) => `<option value="${f.id}" ${f.id === frameFormatOf(plan.box) ? "selected" : ""}>${t(f.name)}${f.id === "custom" ? "" : ` (${f.w} × ${f.h})`}</option>`).join("")}</select></label>` : ""}
    <div class="field-row"><label class="field">Width<input id="resize-width" type="number" min="0.001" step="any" value="${round(plan.box.w)}" aria-describedby="resize-feedback" required></label>
    <label class="field">Height<input id="resize-height" type="number" min="0.001" step="any" value="${round(plan.box.h)}" aria-describedby="resize-feedback" ${plan.autoHeight ? "readonly" : "required"}></label></div>
    <label class="resize-option" ${plan.autoHeight ? "hidden" : ""}><input id="resize-proportions" type="checkbox" ${plan.proportional ? "checked" : ""} ${plan.fixedProportions ? "disabled" : ""}>Keep proportions</label>
    ${plan.scaleText ? '<label class="resize-option"><input id="resize-text" type="checkbox" checked>Scale text with objects</label>' : ""}
    <p class="dialog-copy">${plan.autoHeight ? "Drag the corner horizontally to change text width. Alt/Option bypasses snapping." : plan.fixedProportions ? "Rotated selections keep their proportions. Alt/Option bypasses snapping." : "Drag the corner to resize. Shift toggles proportions; Alt/Option bypasses snapping."}</p>
    <p id="resize-feedback" class="dialog-copy" role="alert" hidden></p>
    <div class="dialog-footer"><button class="primary" type="submit">Apply size</button></div></form>`,
    (d) => {
      const width = d.querySelector("#resize-width"),
        height = d.querySelector("#resize-height"),
        proportions = d.querySelector("#resize-proportions"),
        feedback = d.querySelector("#resize-feedback"),
        form = d.querySelector("form");
      const clearFeedback = () => {
        feedback.textContent = "";
        feedback.hidden = true;
      };
      const showFeedback = (message) => {
        feedback.textContent = t(message);
        feedback.hidden = false;
      };
      form.addEventListener("input", clearFeedback);
      form.addEventListener("change", clearFeedback);
      let axis = "w";
      const sync = (from) => {
        axis = from;
        if (plan.autoHeight) {
          if (+width.value > 0)
            height.value = autoHeightLayout(
              { ...plan.items[0], w: +width.value },
              document.querySelector("#canvas").getContext("2d"),
            ).height;
          return;
        }
        if (!proportions.checked) return;
        if (from === "w" && +width.value > 0)
          height.value = round((+width.value * plan.box.h) / plan.box.w);
        else if (from === "h" && +height.value > 0)
          width.value = round((+height.value * plan.box.w) / plan.box.h);
      };
      // A frame takes a slide, page or screen size from its format, which
      // follows the size typed: the one it matches, or Custom.
      const format = d.querySelector("#resize-format");
      const shownFormat = () => {
        if (format)
          format.value = frameFormatOf({ w: +width.value, h: +height.value });
      };
      if (format)
        format.onchange = () => {
          const chosen = frameFormatById(format.value);
          if (format.value === "custom") return;
          proportions.checked = false;
          width.value = chosen.w;
          height.value = chosen.h;
          axis = "w";
          clearFeedback();
        };
      width.oninput = () => (sync("w"), shownFormat());
      height.oninput = () => (sync("h"), shownFormat());
      proportions.onchange = () => sync(axis);
      width.focus();
      width.select();
      form.onsubmit = (e) => {
        e.preventDefault();
        clearFeedback();
        if (!form.reportValidity()) return;
        if (
          current !== target ||
          signature !==
            rotationSignature(current.items, plan.ids, signatureOptions)
        ) {
          d.close();
          return toast("The selection changed. Select it again.");
        }
        if (!canEditSelection(plan.ids)) return;
        const scaleText = d.querySelector("#resize-text")?.checked || false;
        let w = +width.value,
          h = plan.autoHeight ? plan.box.h : +height.value;
        if (proportions.checked) {
          if (axis === "w") h = (w * plan.box.h) / plan.box.w;
          else w = (h * plan.box.w) / plan.box.h;
        }
        const size = snapResize({ x: [], y: [] }, plan.box, w, h, 1, true, {
          ...resizeLimits(plan, scaleText),
          proportional: proportions.checked,
        });
        if (Math.abs(size.w - w) > 0.001 || Math.abs(size.h - h) > 0.001) {
          width.value = round(size.w);
          height.value = round(size.h);
          return showFeedback(
            "Size adjusted to keep content readable. Review and apply again.",
          );
        }
        try {
          if (
            Math.abs(size.w - plan.box.w) > 1e-9 ||
            Math.abs(size.h - plan.box.h) > 1e-9
          ) {
            // Validate against a detached copy before recording an undo step.
            applyResize(clone(current.items), plan, size.w, size.h, scaleText);
            mutate(() => {
              applyResize(current.items, plan, size.w, size.h, scaleText);
              inferMovedParents(current.items, plan.ids, {
                skip: facilitation.concealedIds(),
              });
              reframeResized(plan);
            });
          }
          d.close();
        } catch (error) {
          showFeedback(error.message);
        }
      };
    },
  );
}
function resizeBy(factor, e) {
  pointerUp();
  if (!canEditSelection()) return;
  const plan = createResizePlan(
    current.items,
    selection,
    selectionAnchor,
    selectionOptions(),
  );
  if (!plan) return;
  const size = snapResize(
    { x: [], y: [] },
    plan.box,
    plan.box.w * factor,
    plan.autoHeight ? plan.box.h : plan.box.h * factor,
    1,
    true,
    { ...resizeLimits(plan), proportional: !plan.autoHeight },
  );
  if (
    Math.abs(size.w - plan.box.w) < 1e-9 &&
    Math.abs(size.h - plan.box.h) < 1e-9
  )
    return;
  try {
    applyResize(clone(current.items), plan, size.w, size.h);
    heldKeyChange(e, "resize", () => {
      applyResize(current.items, plan, size.w, size.h);
      inferMovedParents(current.items, plan.ids, {
        skip: facilitation.concealedIds(),
      });
      reframeResized(plan);
    });
  } catch (error) {
    toast(error.message);
  }
}
function connectionEndpoints(i) {
  if (!i || i.type !== "arrow" || !canEditSelection(new Set([i.id]))) return;
  const board = current,
    signature = (line) =>
      JSON.stringify([
        line.x,
        line.y,
        line.w,
        line.h,
        line.startId || "",
        line.endId || "",
      ]),
    opened = signature(i);
  // Objects the workshop hides from this person are neither named nor
  // offered; an end already attached to one keeps it, unnamed.
  const concealed = facilitation.concealedIds();
  const nodes = current.items.filter(
    (n) => !["arrow", "pen", "frame"].includes(n.type) && !concealed.has(n.id),
  );
  const shown = new Set(nodes.map((n) => n.id));
  const choice = (end, value, title, checked) =>
    `<label><input type="radio" name="connection-${end}" value="${escape(value)}" aria-describedby="connection-error" ${checked ? "checked" : ""}><span>${title}</span></label>`;
  // The choices for one end: a long list is cut short, the search narrows
  // it, and the chosen object is always among them.
  const choices = (end, query = "", checked = i[`${end}Id`] || "") => {
    const attached = i[`${end}Id`];
    const matches = query
      ? nodes.filter((n) => fold(objectName(n)).includes(fold(query)))
      : nodes;
    const list = matches.slice(0, 300);
    const chosen = nodes.find((n) => n.id === checked);
    if (chosen && !list.includes(chosen)) list.unshift(chosen);
    const hidden =
      attached && !shown.has(attached)
        ? choice(end, attached, t("Hidden object"), checked === attached)
        : "";
    const more =
      matches.length > list.length
        ? `<p class="dialog-copy">${escape(t("Showing the first {shown} of {total} matching objects. Search to narrow the list.").replace("{shown}", list.length).replace("{total}", matches.length))}</p>`
        : "";
    return `${choice(end, "", t("Free endpoint"), !checked)}${hidden}${list.map((node) => choice(end, node.id, objectNameHTML(node, 100), checked === node.id)).join("")}${more}`;
  };
  const endpoint = (end, label) => {
    const attached = i[`${end}Id`];
    const node = nodes.find((n) => n.id === attached),
      title = node
        ? objectNameHTML(node, 100)
        : t(attached ? "Hidden object" : "Free endpoint");
    const point = concealed.has(attached)
      ? { x: 0, y: 0 }
      : end === "start"
        ? { x: i.x, y: i.y }
        : { x: i.x + i.w, y: i.y + i.h };
    const search =
      nodes.length > 10
        ? `<label class="search"><input class="connection-search" data-end="${end}" aria-label="${escape(t("Search objects"))}" placeholder="${escape(t("Search objects"))}"></label>`
        : "";
    return `<fieldset id="connection-${end}" class="connection-choices"><legend>${label}</legend><details><summary>${title}</summary>${search}<div class="slide-choices">${choices(end)}</div></details></fieldset><div id="connection-${end}-position" hidden><div class="field-row">${["x", "y"].map((axis) => `<label class="field">${t(`${end === "start" ? "Start" : "End"} ${axis === "x" ? "horizontal" : "vertical"} position`)}<input id="connection-${end}-${axis}" type="number" step="any" min="-2000000" max="2000000" value="${point[axis]}" required aria-describedby="connection-help connection-error"></label>`).join("")}</div></div>`;
  };
  modal(
    "Connection endpoints",
    `<form><p class="dialog-copy" id="connection-help">Choose an object for each end, or select Free endpoint and enter its position in board pixels.</p>${endpoint("start", "Start object")}${endpoint("end", "End object")}<p id="connection-error" role="alert" hidden></p><div class="dialog-footer"><button class="primary" type="submit">Save changes</button></div></form>`,
    (d) => {
      const form = d.querySelector("form"),
        error = d.querySelector("#connection-error");
      const clearError = () => {
        error.textContent = "";
        error.hidden = true;
        for (const input of form.querySelectorAll('[aria-invalid="true"]'))
          input.removeAttribute("aria-invalid");
      };
      const showChoiceError = (message, ends) => {
        error.textContent = t(message);
        error.hidden = false;
        for (const end of ends)
          d.querySelector(`#connection-${end} input:checked`).setAttribute(
            "aria-invalid",
            "true",
          );
        d.querySelector(`#connection-${ends[0]} details`).open = true;
        d.querySelector(`#connection-${ends[0]} input:checked`).focus();
      };
      form.addEventListener("input", clearError);
      form.addEventListener("change", clearError);
      const sync = () => {
        for (const end of ["start", "end"]) {
          const attached = !!d.querySelector(`#connection-${end} input:checked`)
            .value;
          d.querySelector(`#connection-${end}-position`).hidden = attached;
          for (const input of d.querySelectorAll(
            `#connection-${end}-position input`,
          ))
            input.disabled = attached;
        }
      };
      for (const end of ["start", "end"]) {
        const fieldset = d.querySelector(`#connection-${end}`);
        fieldset.onchange = () => {
          const selected = fieldset.querySelector("input:checked");
          fieldset.querySelector("summary").innerHTML = selected
            .closest("label")
            .querySelector("span").innerHTML;
          sync();
        };
        const search = fieldset.querySelector(".connection-search");
        if (search) {
          search.oninput = () => {
            const checked =
              fieldset.querySelector("input:checked")?.value || "";
            fieldset.querySelector(".slide-choices").innerHTML = choices(
              end,
              search.value.trim(),
              checked,
            );
            sync();
          };
          // Enter in the search narrows the list; it does not save the form.
          search.onkeydown = (e) => {
            if (e.key === "Enter") e.preventDefault();
          };
        }
      }
      sync();
      form.onsubmit = (e) => {
        e.preventDefault();
        clearError();
        const target = current?.items.find((line) => line.id === i.id);
        if (
          current !== board ||
          !target ||
          target.type !== "arrow" ||
          signature(target) !== opened
        )
          return toast("This object changed. Open it again to edit it.");
        if (!canEditSelection(new Set([target.id]))) return;
        sync();
        if (!form.reportValidity()) return;
        const start = d.querySelector("#connection-start input:checked").value,
          end = d.querySelector("#connection-end input:checked").value;
        if (start && start === end)
          return showChoiceError("Choose two different objects.", [
            "end",
            "start",
          ]);
        // Only an end already attached may stay on an object now hidden.
        const hidden = facilitation.concealedIds();
        const unavailable = ["start", "end"].filter((edge) => {
          const attached = edge === "start" ? start : end;
          return (
            attached &&
            ((attached !== target[`${edge}Id`] && hidden.has(attached)) ||
              !current.items.some((node) => node.id === attached))
          );
        });
        if (unavailable.length)
          return showChoiceError("Choose a visible object.", unavailable);
        const point = (end, attached) =>
          attached
            ? end === "start"
              ? { x: target.x, y: target.y }
              : { x: target.x + target.w, y: target.y + target.h }
            : {
                x: d.querySelector(`#connection-${end}-x`).valueAsNumber,
                y: d.querySelector(`#connection-${end}-y`).valueAsNumber,
              };
        const a = point("start", start),
          b = point("end", end);
        if (
          (target.startId || "") === start &&
          (target.endId || "") === end &&
          a.x === target.x &&
          a.y === target.y &&
          b.x === target.x + target.w &&
          b.y === target.y + target.h
        )
          return d.close();
        const trial = clone(current.items),
          line = trial.find((line) => line.id === target.id);
        Object.assign(line, {
          x: a.x,
          y: a.y,
          w: b.x - a.x,
          h: b.y - a.y,
          startId: start || undefined,
          endId: end || undefined,
        });
        updateConnectors(trial);
        if (
          ![line.x, line.y, line.w, line.h].every(
            (value) => Number.isFinite(value) && Math.abs(value) <= 1e6,
          )
        ) {
          const error = d.querySelector("#connection-error");
          error.hidden = false;
          error.textContent = t(
            "The endpoints exceed the board limits. Choose closer positions.",
          );
          return;
        }
        if (planning.dependencyLoop(trial, target.id)) {
          const error = d.querySelector("#connection-error");
          error.hidden = false;
          error.textContent = t(
            "This dependency would make these tasks wait for each other in a loop, so none of them could start.",
          );
          return;
        }
        if (signature(line) !== signature(target))
          mutate(() => {
            Object.assign(target, {
              x: line.x,
              y: line.y,
              w: line.w,
              h: line.h,
            });
            if (start) target.startId = start;
            else delete target.startId;
            if (end) target.endId = end;
            else delete target.endId;
          });
        d.close();
      };
    },
  );
}
function editObject(i, properties = false, point) {
  pointerUp();
  if (i && contentTools.edit(i, properties)) return;
  if (!properties && i?.type === "table") {
    if (!focusedGroup) selectItems(new Set([i.id]));
    return tableEditor.open(
      i,
      point ? tableCellAt(i, point, true) : undefined,
      !!point,
    );
  }
  if (!i || !canEditSelection(new Set([i.id]))) return;
  if (!properties && canEditText(i)) return beginTextEdit(i, { point });
  if (!properties && i.type === "image") return imageCrop.open(i);
  if (i.type === "arrow") return connectionEndpoints(i);
  if (features.edit(i)) return;
  if (i.type === "pen") {
    return altText.open(i);
  }
  // Match resize limits so existing large or small objects remain editable.
  const minimum = (size, limit) =>
    Math.max(1, Math.min(limit, Math.floor(Math.abs(size))));
  const width = Math.round(i.w),
    height = Math.round(i.h);
  modal(
    editTitle(i),
    `<form id="edit-form" aria-describedby="object-error"><div class="field"><span id="object-text-label">Text</span><div id="object-text"></div></div>${i.type === "image" ? `<label class="field">${t("Alternative text")}<textarea id="object-alt"${languageAttribute(i.lang)} rows="3" maxlength="1000" aria-describedby="object-alt-hint object-error">${escape(i.alt || "")}</textarea><small id="object-alt-hint">${t("Read by screen readers. Leave empty for decorative images. The command palette's Alternative text can suggest one with AI.")}</small></label>` : ""}<div class="field-row"><label class="field">Width<input id="object-width" aria-describedby="object-error" type="number" min="${minimum(i.w, 60)}" max="1000000" value="${width}" required></label><label class="field">Height<input id="object-height" aria-describedby="object-error" type="number" min="${minimum(i.h, i.type === "text" ? 1 : 45)}" max="1000000" value="${height}" ${growsWithText(i) ? "readonly" : "required"}></label></div>${growsWithText(i) ? '<p class="dialog-copy">Height adjusts to the text. Change the width to rewrap it.</p>' : ""}<p id="object-error" class="dialog-copy" role="alert" tabindex="-1" hidden></p><div class="dialog-footer"><button class="primary" type="submit">Save changes</button></div></form>`,
    (d) => {
      const form = d.querySelector("form"),
        error = d.querySelector("#object-error");
      const clearError = () => {
        error.textContent = "";
        error.hidden = true;
      };
      const showConflict = () => {
        error.textContent = t("This object changed. Open it again to edit it.");
        error.hidden = false;
        error.focus();
      };
      form.addEventListener("input", clearError);
      form.addEventListener("change", clearError);
      const field = createTextEditor(document, i, { plainTextOnly: true });
      field.id = "object-text";
      field.className = "authored-text-field";
      field.tabIndex = 0;
      field.dataset.userContent = "";
      field.setAttribute("aria-labelledby", "object-text-label");
      field.setAttribute("aria-describedby", "object-error");
      d.querySelector("#object-text").replaceWith(field);
      d.addEventListener("close", () => field.destroy(), { once: true });
      field.focus();
      const openedText = i.text || "",
        openedAlt = i.alt || "",
        openedRuns = clone(i.textRuns || []),
        openedLanguage = i.lang;
      form.onsubmit = (e) => {
        e.preventDefault();
        clearError();
        // A collaborator may have removed, locked, or rewritten the object
        // while the dialog was open. Only fields changed here are saved,
        // and never over someone else's newer words.
        if (!current.items.includes(i)) return showConflict();
        if (!canEditSelection(new Set([i.id]))) return;
        const text = field.value,
          alt = d.querySelector("#object-alt")?.value.trim();
        const textChanged = text !== openedText,
          altChanged = alt !== undefined && alt !== openedAlt;
        if (
          (textChanged &&
            ((i.text || "") !== openedText ||
              i.lang !== openedLanguage ||
              !equalTextRuns(i.textRuns, openedRuns))) ||
          (altChanged && (i.alt || "") !== openedAlt)
        )
          return showConflict();
        mutate(() => {
          if (textChanged) {
            const runs = clone(field.textRuns);
            const blocks = replacedBlocks(i, text);
            if (blocks.length) i.textBlocks = blocks;
            else delete i.textBlocks;
            if (runs.length) i.textRuns = runs;
            else delete i.textRuns;
            i.text = text;
          }
          if (altChanged) {
            if (alt) i.alt = alt;
            else delete i.alt;
          }
          // Untouched fields keep their exact size instead of rounding it.
          const nextWidth = +d.querySelector("#object-width").value,
            nextHeight = +d.querySelector("#object-height").value;
          if (nextWidth !== width) i.w = nextWidth;
          if (!growsWithText(i) && nextHeight !== height) i.h = nextHeight;
        });
        d.close();
      };
    },
  );
}
function download(data, name, type) {
  const a = document.createElement("a"),
    url = URL.createObjectURL(new Blob([data], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fileInput(accept, callback, { multiple = false } = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  input.onchange = () =>
    input.files[0] &&
    callback(multiple ? Array.from(input.files) : input.files[0]);
  input.click();
}
function titleWithSuffix(title, suffix) {
  let end = Math.min(title.length, Math.max(0, 200 - suffix.length));
  const last = title.charCodeAt(end - 1),
    next = title.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
    end--;
  return title.slice(0, end) + suffix;
}

async function importBoard(file) {
  try {
    // Any board this app can export fits: a browser cannot write a larger
    // file as one piece of text, nor read one back.
    if (file.size > 500 * 1024 * 1024)
      throw Error("Choose a file smaller than 500 MB.");
    let b;
    // What exactly is wrong inside a file means nothing to the person
    // importing it, and the parser's wording is not translated.
    try {
      b = validateBoard(JSON.parse(await file.text()));
    } catch {
      throw Error("This is not a supported Whiteboard file.");
    }
    assertImagePixels(b.items);
    b.id = uid();
    delete b.shared;
    delete b.timer;
    b.workshop = portableWorkshop(b.workshop);
    if (!b.workshop) delete b.workshop;
    // Library state from another device must not place the board in Trash
    // or inject markup through unvalidated fields.
    delete b.deletedAt;
    b.favorite = b.favorite === true;
    adoptFrameMembers(b);
    b.updated = Date.now();
    // Titles are limited to 200 characters, including the suffix.
    const imported = ` (${t("imported")})`;
    b.title = titleWithSuffix(b.title.trim() || t("Untitled board"), imported);
    boards.push(b);
    try {
      await local.save(b);
    } catch {
      boards.splice(boards.indexOf(b), 1);
      throw Error("Could not import this file.");
    }
    openBoard(b);
    toast("Board imported.");
  } catch (e) {
    toast(
      e instanceof DOMException
        ? "Could not import this file."
        : e.message || "Could not import this file.",
    );
  }
}
function imageInput() {
  const target = current,
    canvas = document.querySelector("#canvas"),
    point = viewCenter();
  fileInput(
    IMAGE_ACCEPT,
    (files) => {
      if (current === target && canvas.isConnected)
        transfer.addFiles(files, point, { imagesOnly: true, centre: true });
    },
    { multiple: true },
  );
}

async function leaveCollaboration() {
  collaborationAttempt++;
  const session = collaboration;
  if (session) {
    await collaborationEdits;
    await session.queue;
    if (session.recoveryFailed && session.unsaved) {
      toast("Local recovery failed. Keep this tab open.");
      return false;
    }
    // Edits still waiting for their batch are sent now, briefly, so others
    // get them without this person opening the board again.
    if (session.pending.size && session.connected && !session.readOnly)
      await Promise.race([
        session.flush().catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    // What could not be sent waits on this device for the board to be
    // opened again; closing the tab meanwhile warns.
    if (session.unsaved) unsentBoards.set(session.room, session);
    else unsentBoards.delete(session.room);
    await session.finishView();
    attention.reset();
    liveUI.close(false);
    collaboration = null;
    session.close();
  }
  collaborationBusy = false;
  collaborationRendered = collaborationLastSaved = null;
  collaborationPeople = new Map();
  collaborationRoster = [];
  boardMembers = [];
  boardColleagues = [];
  if (collaborationFrame) cancelAnimationFrame(collaborationFrame);
  collaborationFrame = null;
  collaborationHadPreview = false;
  presenceLayer?.close();
  presenceLayer = null;
}
// Who else has the object being typed in selected, and when they last did:
// an object is selected to be deleted, and the deletion arrives after the
// presence that clears that selection, so it is remembered for a while.
function noteEditingSelectors(people) {
  const id = editing.item.id,
    now = Date.now();
  editing.selectors ??= new Map();
  for (const person of people.values())
    if (person.selection?.includes(id) || person.editing === id)
      editing.selectors.set(person.user, now);
}
// Whoever deleted the object being typed in, when one person alone had it
// selected just before and the board does not hide who is who; otherwise
// nobody is named rather than the wrong person.
function editingDeletedBy(session) {
  const now = Date.now(),
    recent = [...(editing.selectors || [])]
      .filter(([, at]) => now - at < 10000)
      .map(([user]) => user);
  if (recent.length !== 1 || recent[0] === session.user?.uuid) return "";
  const people = collaborationPeople;
  if (facilitation.people(people) !== people) return "";
  for (const person of people.values())
    if (person.user === recent[0]) return person.username;
  return collaborationRoster.find((p) => p.user === recent[0])?.username || "";
}
function sendPresence() {
  if (!collaboration) return;
  presenceSelection = sharedSelectionKey();
  // What a facilitator types or draws where participants cannot see it,
  // such as in a hidden or staged frame, is not sent to them live either,
  // nor what anyone types in a note that private mode keeps face down.
  const secret =
    editing &&
    (facilitation.unseen(editing.item) ||
      facilitation.privateNote(
        editing.item,
        (id) => !!collaboration.shared?.items?.has(id),
      ));
  collaboration.presence({
    cursor: collaborationCursor,
    selection: sharedSelection(),
    editing: (!secret && editing?.item.id) || null,
    text: secret ? null : (editing?.input.value.slice(0, 20000) ?? null),
    preview:
      drag &&
      ["move", "resize", "rotate", "pen", "arrow", "endpoint"].includes(
        drag.kind,
      )
        ? current.items
            .filter(
              (i) =>
                (selection.has(i.id) ||
                  (drag.kind === "pen" && i.id === drag.id)) &&
                !facilitation.unseen(i),
            )
            .slice(0, 100)
            .map(({ id, type, color, points, x, y, w, h, rotation }) => ({
              id,
              x,
              y,
              w,
              h,
              rotation: rotation || 0,
              // A move or rotation leaves a drawing's own points as they
              // were, so only creating or resizing one sends them.
              ...(["pen", "arrow"].includes(type) &&
              ["pen", "arrow", "endpoint", "resize"].includes(drag.kind)
                ? {
                    type,
                    color,
                    points: points?.filter(
                      (_, index) =>
                        index % Math.max(1, Math.ceil(points.length / 256)) ===
                        0,
                    ),
                  }
                : {}),
            }))
        : [],
  });
}
// Whether this person may invite and change roles: a role refused since,
// as after being removed, grants nothing.
const managesBoard = (session) =>
  !!session && !session.denied && canManage(session.role);
const accessKey = () =>
  collaboration ? `${collaboration.role}:${!!collaboration.denied}` : "";
// The tag over the canvas names the board's kind. It follows sharing along
// with the controls, so a board being shared is not called personal once
// its name can be edited again.
// Where a board is kept: on the shared server, in the account's Puter
// drive, or on this device alone.
// A card's date: the day, with its year when that is not this year, so an
// old board is not mistaken for one edited this spring.
function cardDate(updated) {
  const date = new Date(updated);
  return date.toLocaleDateString(language === "fr" ? "fr-CA" : "en-CA", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}
function boardStorage(b) {
  return b.shared
    ? "shared"
    : cloudIds.has(b.id) || (!b.shared && cloudIndex.has(b.id))
      ? "cloud"
      : "device";
}
const STORAGE_TAGS = {
  shared: ["users", "Shared board"],
  cloud: ["cloud", "Saved to Puter"],
  device: ["hard-drive", "On this device"],
};
// A shared board this person may not change says so for as long as that
// lasts, beside where it is kept.
const ACCESS_TAGS = { view: "View only", comment: "Comment only" };
const restrictedAccess = (b) =>
  (b.shared && b === current && ACCESS_TAGS[collaboration?.access]) || "";
function storageLabel(b) {
  const label = t(STORAGE_TAGS[boardStorage(b)][1]),
    access = restrictedAccess(b);
  return b.shared
    ? access
      ? `${label} · ${t(access)}`
      : label
    : `${t("Personal board")} · ${label}`;
}
// The words sit in their own element so a narrow row cuts them with an
// ellipsis; the tag's title still names them in full.
function storageTag(b) {
  return `${icon(STORAGE_TAGS[boardStorage(b)][0])}<span>${storageLabel(b)}</span>`;
}
// The status a board shows when it opens, before any save of this visit.
function savedStatus(b) {
  return boardStorage(b) === "cloud"
    ? "Saved to Puter"
    : "Saved on this device";
}
// The header's cloud button says whether the board is already in Puter.
function cloudSaveLabel(b) {
  return b.shared
    ? "Save shared changes now"
    : boardStorage(b) === "cloud"
      ? "Saved to Puter · Save again"
      : "Save to Puter";
}
function renderBoardTag() {
  const tag = document.querySelector(".board-tag");
  if (!tag || !current) return;
  // This runs for every cursor frame; an unchanged tag is left as it is.
  const kind = boardStorage(current),
    access = restrictedAccess(current);
  let changed = false;
  if (tag.dataset.storage !== kind || (tag.dataset.access || "") !== access) {
    tag.dataset.storage = kind;
    if (access) tag.dataset.access = access;
    else delete tag.dataset.access;
    tag.innerHTML = storageTag(current);
    tag.title = storageLabel(current);
    changed = true;
  }
  const save = document.querySelector('[data-action="cloud-save"]');
  if (save && save.dataset.storage !== kind) {
    save.dataset.storage = kind;
    const label = t(cloudSaveLabel(current));
    save.setAttribute("aria-label", label);
    save.title = label;
    save.innerHTML = icon(kind === "cloud" ? "cloud-check" : "cloud-upload");
    changed = true;
  }
  if (changed) iconsRefresh();
}
// Up to two letters for a face: the first of two words, or the first two.
function initials(name = "") {
  const words = String(name)
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => Array.from(word));
  const letters =
    words.length > 1
      ? [words[0][0], words[1][0]]
      : (words[0] || ["?"]).slice(0, 2);
  return letters.join("").toUpperCase();
}
// Joins and departures are said to a screen reader, as the faces on the
// participants button show them, by the names the button lists. Changes
// over a few seconds are gathered, so a rush of people reads as one count;
// in a room larger than thirty, where people come and go all the time,
// they are not said at all. Those on the board on arriving are not news.
const ARRIVALS_WAIT = 3000,
  ARRIVALS_ROOM = 30;
let arrivals = { session: null, people: null };
function followArrivals() {
  const session = collaboration,
    self = collaborationRoster.find((p) => p.session === session?.session);
  // A roster without this session, as while access is refused, says
  // nothing about who came or went; the next one is taken as it is.
  if (!self) return void (arrivals.people = null);
  const people = new Map();
  for (const p of collaborationRoster)
    if (p.user !== self.user) people.set(p.user, p.username);
  if (arrivals.session !== session || !arrivals.people) {
    clearTimeout(arrivals.timer);
    arrivals = { session, people, joined: new Map(), left: new Map() };
    return;
  }
  const { joined, left } = arrivals;
  // Someone who leaves and comes back within the wait did neither.
  for (const [user, name] of people)
    if (!arrivals.people.has(user))
      if (left.has(user)) left.delete(user);
      else joined.set(user, name);
  for (const [user, name] of arrivals.people)
    if (!people.has(user))
      if (joined.has(user)) joined.delete(user);
      else left.set(user, name);
  arrivals.people = people;
  if ((joined.size || left.size) && !arrivals.timer)
    arrivals.timer = setTimeout(() => {
      arrivals.timer = null;
      const said = (names, one, many) =>
        names.size === 1
          ? t(one).replace("{name}", [...names.values()][0])
          : names.size
            ? t(many).replace("{count}", names.size)
            : "";
      const message = [
        said(joined, "{name} joined", "{count} people joined"),
        said(left, "{name} left", "{count} people left"),
      ]
        .filter(Boolean)
        .join(". ");
      arrivals.joined = new Map();
      arrivals.left = new Map();
      if (
        message &&
        collaboration === session &&
        arrivals.people.size < ARRIVALS_ROOM
      )
        announce(message);
    }, ARRIVALS_WAIT);
}
// A change in what this person may do on the board is told as it happens:
// tools turn off and an open editor closes, which would otherwise go
// unexplained. The role known on opening a board is not a change.
const ACCESS_CHANGES = {
  manage:
    "You can now manage this board's participants and run its facilitation.",
  edit: "You can now edit this board.",
  comment: "You can now comment on this board, but not change its content.",
  view: "You can now only view this board.",
};
let accessSeen = { board: null, access: "" };
function followAccess() {
  const edits = (current?.shared && collaboration?.access) || "";
  if (!edits) return;
  // Owners and facilitators also manage the board: becoming or ceasing to
  // be one changes what they can do as much as edit access does.
  const access =
    edits === "edit" && canManage(collaboration.role) ? "manage" : edits;
  // The library offers what this role may do with the board, such as
  // renaming it, even before any content arrives with the change.
  if (collaboration.role) current.shared.role = collaboration.role;
  const seen = accessSeen.board === current;
  if (seen && accessSeen.access === access) return;
  if (seen)
    toast(
      accessSeen.access === "manage" && access === "edit"
        ? "You can still edit this board, but no longer manage its participants or facilitation."
        : ACCESS_CHANGES[access],
    );
  accessSeen = { board: current, access };
}
function renderParticipants() {
  followAccess();
  renderBoardTag();
  liveUI.render();
  const button = document.querySelector(".participants");
  if (!button) return;
  button.hidden = !collaboration;
  if (collaboration) {
    // The roster has an entry per open tab; count each person once.
    const people = new Map(collaborationRoster.map((p) => [p.user, p]));
    // Without a peer link no one's cursor or changes in progress show,
    // though saved edits do; a link back within seconds goes unmentioned.
    const unlinked = collaboration.liveUnavailable(),
      count = `${people.size || 1} · ${t("Participants")}`,
      note = unlinked ? ` · ${t("Live cursors off")}` : "",
      // A big room names a few people, not hundreds.
      listed = [...people.values()].map((p) => p.username),
      names =
        listed.length > 10
          ? `${listed.slice(0, 10).join(", ")} ${t("and {count} more").replace("{count}", listed.length - 10)}`
          : listed.join(", "),
      title = unlinked
        ? `${names}\n${t("Others’ cursors and changes in progress cannot be shown right now. Their saved edits still appear.")}`
        : names;
    // As in Miro, the others on the board show as a stack of faces in
    // their colours, four at most and then how many more; the count stays
    // the button's name. Initials come from CSS, so the name reads cleanly.
    const self = collaborationRoster.find(
        (p) => p.session === collaboration.session,
      )?.user,
      others = [...people.values()].filter((p) => p.user !== self),
      faces = others
        .slice(0, others.length > 4 ? 3 : 4)
        .map((p) => [p.user, initials(p.username)]),
      more = others.length - faces.length,
      // Owners and facilitators see how many hands are up, to call on
      // people; the button's name says it too.
      hands = canManage(collaboration.role || "")
        ? attention.hands().length
        : 0,
      handsText = hands
        ? ` · ${plural(hands, "{count} raised hand", "{count} raised hands")}`
        : "",
      signature = JSON.stringify([faces, more, count, note, hands, language]);
    // This runs for every cursor frame; unchanged content is left as it is.
    if (button.dataset.signature !== signature) {
      button.dataset.signature = signature;
      const stack = document.createElement("span");
      stack.className = "participant-faces";
      stack.setAttribute("aria-hidden", "true");
      for (const [user, letters] of faces) {
        const face = document.createElement("span");
        face.className = "participant-face";
        face.dataset.initials = letters;
        face.style.setProperty("--participant", participantColor(user));
        stack.append(face);
      }
      if (more) {
        const face = document.createElement("span");
        face.className = "participant-face more";
        // How many more, shortened only past a thousand, as "+1.2K".
        face.dataset.initials = `+${new Intl.NumberFormat(language, {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(more)}`;
        stack.append(face);
      }
      const label = document.createElement("span");
      label.className = faces.length ? "sr-only" : "participant-count";
      label.textContent = count;
      button.replaceChildren(...(faces.length ? [stack] : []), label);
      if (hands) {
        const badge = document.createElement("span");
        badge.className = "hand-count";
        badge.innerHTML = `${icon("hand")}<span aria-hidden="true">${hands}</span><span class="sr-only">${handsText}</span>`;
        button.append(badge);
        iconsRefresh();
      }
      if (note) {
        const span = document.createElement("span");
        span.className = "live-note";
        span.textContent = note;
        button.append(span);
      }
    }
    if (button.title !== title) button.title = title;
  }
  const shareDialog = document
    .querySelector("dialog[open] #share-link")
    ?.closest("dialog");
  if (shareDialog?.showAccess && shareDialog.shareRole !== accessKey())
    shareDialog.showAccess();
  const participants = document
    .querySelector("dialog[open] #participant-list")
    ?.closest("dialog");
  if (participants?.refreshAccess && participants.accessRole !== accessKey())
    participants.refreshAccess();
  const readOnly = isSharedReadOnly(),
    canComment = !isCommentReadOnly();
  const editor = document.querySelector(".editor");
  // Losing edit access closes the text being typed and any creation tool,
  // which could no longer save anything. Connecting is only briefly
  // read-only and leaves them.
  if (
    readOnly &&
    !collaborationBusy &&
    editor &&
    !editor.classList.contains("shared-viewer")
  ) {
    if (editing) finishTextEdit();
    if (
      !["select", "hand", "region"].includes(tool) &&
      !(tool === "comment" && canComment)
    ) {
      tool = "select";
      showTool();
    }
  }
  editor?.classList.toggle("shared-viewer", readOnly);
  editor?.classList.toggle("shared-commenter", readOnly && canComment);
  const title = document.querySelector("#board-title");
  if (title) title.disabled = readOnly;
  for (const button of document.querySelectorAll(
    '[data-action^="tool-"], [data-action="shapes"], .left-rail [data-action="templates"], .left-rail [data-action="add-content"]',
  ))
    button.disabled =
      readOnly &&
      !["tool-select", "tool-hand"].includes(button.dataset.action) &&
      !(button.dataset.action === "tool-comment" && canComment);
}
// The board's members, offered for @mentions. Fetched on joining and again
// whenever comments open, so people who joined since can be mentioned; a
// failed fetch keeps the list from before.
function refreshBoardMembers() {
  const session = collaboration;
  if (!session || session.closed || !session.connected) return;
  session
    .request("members")
    .then(({ members, colleagues = [] }) => {
      if (collaboration !== session) return;
      const named = (list) => list.map((m) => `${m.uuid}:${m.username}`).join();
      const renamed = named(members) !== named(boardMembers);
      boardMembers = members;
      boardColleagues = colleagues;
      // Sticky notes name who added them by these names.
      if (renamed && creators.owners.size) {
        contentVersion++;
        renderOutline();
        draw();
      }
    })
    .catch(() => {});
}
async function startCollaboration(target, token, localTimer) {
  if (collaboration) {
    if ((await leaveCollaboration()) === false)
      throw Error(t("Local recovery failed. Keep this tab open."));
    // Reconnecting keeps the board open, so the live cursors and follow
    // controls that leaving removed come back.
    const wrap = current === target && document.querySelector(".canvas-wrap");
    if (wrap) {
      presenceLayer = new PresenceLayer(wrap);
      attention.bind(wrap);
    }
  }
  const attempt = ++collaborationAttempt;
  // Opening it again sends what was left.
  unsentBoards.delete(target.shared.room);
  collaborationBusy = true;
  renderParticipants();
  status("Connecting to shared board…");
  try {
    await connect();
    const user = await window.puter.auth.getUser();
    if (current !== target || attempt !== collaborationAttempt) return;
    const session = new CollaborationSession({
      puter: window.puter,
      ...target.shared,
      user,
      changed: (board) => {
        if (collaboration !== session || current !== target) return;
        const before = collaborationRendered;
        const next = before ? rebase(target, before, board) : board;
        if (collaborationLastSaved && before)
          collaborationLastSaved = rebase(
            collaborationLastSaved,
            before,
            board,
          );
        else collaborationLastSaved = sharedCopy(next);
        collaborationRendered = sharedCopy(board);
        contentVersion++;
        target.title = next.title;
        target.tags = next.tags;
        target.timer = next.timer;
        target.planning = next.planning;
        if (next.workshop) target.workshop = next.workshop;
        else delete target.workshop;
        if (next.comments) target.comments = next.comments;
        const existing = new Map(target.items.map((item) => [item.id, item]));
        target.items = next.items.map((item) => {
          const previous = existing.get(item.id);
          if (!previous) return item;
          if (
            JSON.stringify(previous.textRuns) ===
              JSON.stringify(item.textRuns) &&
            item.textRuns
          )
            item.textRuns = previous.textRuns;
          if (
            JSON.stringify(previous.textBlocks) ===
              JSON.stringify(item.textBlocks) &&
            item.textBlocks
          )
            item.textBlocks = previous.textBlocks;
          for (const key of Object.keys(previous))
            if (!(key in item)) delete previous[key];
          return Object.assign(previous, item);
        });
        target.updated = Date.now();
        // Remembered so a copy made from the library, while the board is
        // closed, keeps what this person may see as a facilitator.
        if (target.shared) target.shared.role = session.role;
        if (editing) {
          const item = target.items.find((i) => i.id === editing.item.id);
          // Locked meanwhile, by someone or a facilitator's lock: typing
          // stops, after what was typed until now reaches the others.
          const locked = item && hasLocked(target.items, new Set([item.id]));
          if (item && !locked) editing.item = item;
          else {
            const focused = editing.input.contains(document.activeElement);
            // Deleted meanwhile, the object takes what was typed with it;
            // the person is told, by whom when that is known, and may
            // copy their text before it is gone.
            const deleted = !item && {
              by: editingDeletedBy(session),
              text: editing.input.value.trim() ? editing.input.value : "",
            };
            editing.unbind?.();
            editing.input.destroy();
            editing.input.remove();
            editing.hint.remove();
            editing = null;
            sendPresence();
            if (focused)
              document.querySelector("#canvas")?.focus({ preventScroll: true });
            if (locked)
              toast(
                facilitation.frozen() ||
                  "Someone locked this object while you were editing it.",
              );
            if (deleted)
              toast(
                deleted.by
                  ? t(
                      "{name} deleted this object while you were editing it.",
                    ).replace("{name}", deleted.by)
                  : "This object was deleted by someone else while you were editing it.",
                deleted.text && {
                  label: t("Copy text"),
                  run: () =>
                    navigator.clipboard.writeText(deleted.text).then(
                      () => toast("Text copied."),
                      () => toast("Could not copy the text."),
                    ),
                },
              );
          }
        }
        if (drag?.original && before) {
          drag.original = rebase(
            { ...target, items: drag.original },
            before,
            board,
          ).items;
          // A replacement source and its crop must not be combined with a
          // geometry draft made against the previous source.
          const movingIds =
            drag.duplicate?.sourceSelection || drag.plan?.ids || selection;
          const oldImages = new Map(
            before.items
              .filter((i) => movingIds.has(i.id) && i.type === "image")
              .map((i) => [i.id, i.src]),
          );
          // An image arriving from the server is the same source.
          const arrived = (before, after) =>
            before?.startsWith("asset:") &&
            session.assetIds.get(after) === before.slice(6);
          if (
            board.items.some(
              (i) =>
                oldImages.has(i.id) &&
                oldImages.get(i.id) !== i.src &&
                !arrived(oldImages.get(i.id), i.src),
            )
          )
            cancelTransform();
          if (drag?.groupFocus) {
            const ids =
              drag.duplicate?.sourceSelection || drag.plan?.ids || selection;
            const oldMembers = before.items.filter((i) => ids.has(i.id));
            const nextById = new Map(board.items.map((i) => [i.id, i]));
            if (
              isSharedReadOnly() ||
              hasLocked(target.items, ids) ||
              oldMembers.some((i) => {
                const next = nextById.get(i.id);
                return (
                  !next ||
                  ["groupId", "parentId", "x", "y", "w", "h", "rotation"].some(
                    (key) => i[key] !== next[key],
                  )
                );
              })
            )
              cancelTransform();
          }
          if (
            drag?.kind === "rotate" &&
            (isSharedReadOnly() ||
              hasLocked(target.items, drag.plan.ids) ||
              rotationSignature(before.items, drag.plan.ids, {
                groups: !drag.groupFocus,
              }) !==
                rotationSignature(board.items, drag.plan.ids, {
                  groups: !drag.groupFocus,
                }))
          )
            cancelTransform();
          // Locked meanwhile, by someone or a facilitator's lock: the move
          // stops where it started, as rotating and editing do.
          if (
            drag &&
            !drag.duplicate &&
            !drag.mind &&
            ["move", "resize", "endpoint"].includes(drag.kind) &&
            hasLocked(target.items, draggedIds())
          ) {
            cancelTransform();
            toast(
              facilitation.frozen() ||
                "Someone locked this object while you were moving it.",
            );
          }
          const hidden = mindView.scene().hidden;
          if (
            (drag?.id && hidden.has(drag.id)) ||
            [...selection].some(
              (id) => hidden.has(id) && !selection.has(hidden.get(id)),
            )
          )
            cancelTransform();
          if (
            drag?.mind &&
            (!validMindDrag(drag.original, drag.mind, true) ||
              isSharedReadOnly() ||
              hasLocked(target.items, selection) ||
              (drag.mindPreview &&
                !target.items.some((i) => i.id === drag.mindPreview.id)))
          )
            cancelTransform();
          if (drag?.moving) {
            const byId = new Map(target.items.map((i) => [i.id, i]));
            for (const entry of drag.moving)
              entry.item = byId.get(entry.item.id);
            // Restore every moved object, not only the removed one.
            if (drag.moving.some((e) => !e.item)) cancelTransform();
          }
          if (drag?.duplicate) {
            const present = new Set(target.items.map((i) => i.id));
            if (
              isSharedReadOnly() ||
              target.items.length > MAX_OBJECTS ||
              hasLocked(target.items, drag.duplicate.sourceSelection) ||
              [...drag.duplicate.sourceSelection].some((id) => !present.has(id))
            )
              cancelTransform();
          }
          if (drag?.mind) {
            drag.mindPreview = null;
            if (drag.pointer)
              previewMindDrop(drag.pointer, canvasPoint(drag.pointer));
          }
          if (drag?.dimensions) {
            drag.dimensions = createDimensionIndex(
              visibleItems(),
              selection,
              snapViewport(),
              drag.plan.box,
            );
            drag.guides = [];
          }
        }
        const present = new Set(target.items.map((i) => i.id));
        selection = new Set([...selection].filter((id) => present.has(id)));
        updateConnectors(target.items);
        if (drag?.kind === "marquee") {
          drag.index = null;
          drag.baseSelection = new Set(
            [...drag.baseSelection].filter((id) => present.has(id)),
          );
          if (drag.marquee)
            updateMarqueeSelection(drag.marquee, drag.pointer?.shiftKey);
        }
        const title = document.querySelector("#board-title");
        if (title && document.activeElement !== title)
          title.value = target.title;
        showBoardTitle(target.title);
        boardSearch.refresh();
        storeShared(target);
        renderParticipants();
        draw();
      },
      viewChanged: (views, roster) => {
        if (collaboration === session && current === target)
          attention.update(views, roster);
      },
      reaction: (person) => {
        if (collaboration === session && current === target)
          liveUI.receive(person);
      },
      handLowered: () => {
        if (collaboration !== session || current !== target) return;
        liveUI.loweredBy();
      },
      attention: (person) => {
        // A participant of a locked workshop board cannot move the others.
        if (
          collaboration === session &&
          current === target &&
          !facilitation.lockedFor(person.role)
        )
          attention.receive(person);
      },
      activity: (people, roster) => {
        if (collaboration !== session || current !== target) return;
        collaborationPeople = people;
        collaborationRoster = roster;
        if (editing) noteEditingSelectors(people);
        if (!collaborationFrame)
          collaborationFrame = requestAnimationFrame(() => {
            collaborationFrame = null;
            if (collaboration !== session || current !== target) return;
            const preview = previewsInView(
              collaborationPeople.values(),
              Date.now(),
            );
            // Viewers and commenters are both read-only for content, but
            // only commenters get the comment controls.
            const classes = document.querySelector(".editor")?.classList;
            const accessChanged =
              classes?.contains("shared-viewer") !== isSharedReadOnly() ||
              classes?.contains("shared-commenter") !==
                (isSharedReadOnly() && !isCommentReadOnly());
            renderParticipants();
            // Joins, departures and role changes reach the facilitator's
            // People tab and attendance at once, not on the next edit.
            if (collaborationRoster !== collaborationRosterSeen) {
              collaborationRosterSeen = collaborationRoster;
              followArrivals();
              const signature = collaborationRoster
                .map((p) => `${p.session}:${p.role}`)
                .join();
              if (signature !== collaborationRosterSignature) {
                collaborationRosterSignature = signature;
                facilitation.rosterChanged();
              }
            }
            if (preview || collaborationHadPreview || accessChanged) draw();
            else {
              if (followEditedByOthers()) renderOutline();
              presenceLayer?.render(
                facilitation.people(collaborationPeople),
                visibleItems(),
                view,
                session.session,
                attention.showCursors(),
                collaborationRoster.length,
              );
            }
            collaborationHadPreview = preview;
          });
      },
      status: (message) => {
        if (collaboration === session && current === target) status(message);
      },
      // Synchronized, with edits recorded from here on: the board takes
      // edits now, not after the check-in and upload that follow.
      ready: () => {
        if (collaboration !== session || current !== target) return;
        collaborationBusy = false;
        renderParticipants();
        draw();
      },
      rejected: ({ remade, reason } = {}) => {
        if (collaboration !== session || current !== target) return;
        // Recovery replaced the shared document; bind the open editor to it.
        if (editing?.unbind) {
          editing.unbind();
          // The editor shows the shared text again, without the refused
          // words, rather than saving them once more.
          editing.unbind = bindText(
            session,
            editing.item.id,
            editing.input,
            editing.sharedChange,
            { reload: true },
          );
        }
        // A change made again without the names anonymous input leaves
        // out was not lost.
        if (!remade)
          toast(
            reason ||
              "Some changes could not be saved because they conflicted with the shared board.",
          );
      },
    });
    collaboration = session;
    collaborationScopes.set(target, session.scope);
    // Check the account's own deployment independently of joining: an old or
    // broken worker must not have to accept a join before it can be updated.
    refreshDeployment(window.puter, session.server).catch(() => {
      if (collaboration === session && !session.closed)
        toast("Sharing update could not finish. Reopen this board to retry.");
    });
    boardMembers = [];
    boardColleagues = [];
    await session.start(token).catch((error) => {
      // Joined and running, a session whose first upload of edits kept on
      // this device failed shows that and retries by itself; the board is
      // open and editable, so the rest of opening it goes on.
      if (!session.connected || session.closed) throw error;
      session.failure(error);
    });
    if (collaboration !== session) return;
    refreshBoardMembers();
    if (localTimer?.state === "running" && target.timer?.id === localTimer.id) {
      const remaining = Math.round(timerRemaining(localTimer, Date.now()));
      session.shared.setTimer({
        ...localTimer,
        remaining,
        endsAt: Math.round(session.now() + remaining),
      });
      await session.publish();
      await session.queue;
      await session.flush().catch((error) => session.failure(error));
    }
    if (collaboration !== session || current !== target) return;
    collaborationBusy = false;
    // Images the first render could not download may have arrived since;
    // they reach the board the way any other change does, so the board and
    // what it was last rendered from agree.
    await session.publish();
    if (collaboration !== session || current !== target) return;
    collaborationLastSaved = clone(target);
    renderParticipants();
    draw();
    return session;
  } catch (error) {
    if (current === target) {
      collaborationBusy = false;
      if (collaboration) {
        // A session that never got its timers is closed and stays read-only;
        // one that is running, as after a failed first upload, recovers
        // through them, so editing goes on and its outbox is sent again.
        if (collaboration.closed) {
          collaboration.readOnly = true;
          collaboration.contentReadOnly = true;
        }
        collaboration.failure(error);
      }

      renderParticipants();
      status("Could not connect · local copy available");
    }
    throw error;
  }
}
// Sharing sets up a server, uploads the board, and connects, which can take
// several seconds. A dialog says so at once and names each step; closing it
// lets the work finish in the background.
let sharing = null;
function shareProgress(target) {
  const state = {
    target,
    text: t("Setting up sharing…"),
    dialog: null,
    dismissed: false,
    done: false,
  };
  state.show = () => {
    state.dismissed = false;
    state.dialog = modal(
      "Share board",
      `<div class="share-progress"><span class="spinner" aria-hidden="true"></span><p id="share-progress-text" role="status"></p></div><p class="dialog-copy">${t("This can take a few seconds. You can close this and look around; editing resumes once sharing is ready.")}</p>`,
      (d) => (d.querySelector("#share-progress-text").textContent = state.text),
    );
    state.dialog.addEventListener("close", () => {
      if (!state.done) state.dismissed = true;
    });
  };
  state.step = (text) => {
    state.text = t(text);
    const line = state.dialog?.querySelector("#share-progress-text");
    if (line) line.textContent = state.text;
  };
  state.finish = () => {
    state.done = true;
    if (state.dialog?.open) state.dialog.close();
  };
  return state;
}
// What sharing a personal board does, before it does it: the board moves
// into the person's Puter account and stays shared.
function confirmSharing(target) {
  return new Promise((resolve) => {
    let chosen = false;
    modal(
      "Share this board?",
      `<p class="dialog-copy">${t("Sharing moves this board into your Puter account, so the people you invite can open it and work on it with you. It stays a shared board from then on; Duplicate still makes a personal copy.")}</p><div class="dialog-footer"><button class="secondary" id="cancel-share">${t("Cancel")}</button><button class="primary" id="confirm-share">${icon("users")}${t("Share board")}</button></div>`,
      (d) => {
        d.querySelector("#cancel-share").onclick = () => d.close();
        d.querySelector("#confirm-share").onclick = () => {
          chosen = true;
          d.close();
        };
        d.addEventListener(
          "close",
          () => resolve(chosen && current === target && !target.shared),
          { once: true },
        );
      },
    );
  });
}
async function shareBoard() {
  const target = current;
  if (!target) return;
  // Pressing Share again while it is being set up shows the progress again.
  if (sharing && !sharing.done) {
    if (sharing.target !== target)
      return toast(
        "Another board is still being shared. Try again in a moment.",
      );
    if (!sharing.dialog?.open) sharing.show();
    return;
  }
  if (collaborationBusy)
    return toast(
      "Still connecting to the shared board. Try again in a moment.",
    );
  // Sharing a personal board cannot be taken back, so it is asked first.
  if (!target.shared && !(await confirmSharing(target))) return;
  let progress = null;
  try {
    pointerUp();
    finishTextEdit();
    if (!target.shared) {
      collaborationBusy = true;
      renderParticipants();
      await connect();
      // After signing in, which may open Puter's own window.
      progress = sharing = shareProgress(target);
      progress.show();
      const user = await window.puter.auth.getUser();
      // Members create shared boards on their organization's worker, where
      // its policies, directory, and audit log apply.
      let server;
      if (organization.server && organization.isMember) {
        server = organization.server;
        // When this account deployed the organization's worker, it is
        // brought up to date before the board is created on it, as opening
        // a shared board does: an outdated worker refuses the new board.
        progress.step("Preparing collaboration…");
        await refreshDeployment(window.puter, server).catch(() => {});
      } else
        server = await deploy(window.puter, (message) => {
          if (current === target) status(message);
          progress.step(message);
        });
      const room = uid();
      const staging = new CollaborationSession({
        puter: window.puter,
        server,
        room,
        user,
        changed() {},
        activity() {},
        status,
      });
      const seed = new SharedDocument();
      progress.step("Uploading the board…");
      try {
        const prepared = await staging.prepare(target);
        for (const thread of prepared.comments || [])
          for (const message of thread.messages)
            if (message.authorId === commentIdentity) {
              message.authorId = user.uuid;
              message.authorName = user.username || "Member";
            }
        if (prepared.workshop)
          prepared.workshop = adoptWorkshop(
            prepared.workshop,
            commentIdentity,
            user,
            "Local author",
          );
        seed.commit(prepared);
        await staging.request("create", { update: encode(seed.update()) });
        try {
          await staging.uploadAssets();
        } catch (error) {
          // Without its files the shared copy cannot be used, and trying
          // again creates another, so this one goes to the trash.
          await staging.request("delete").catch(() => {});
          throw error;
        }
        if (prepared.comments) target.comments = prepared.comments;
        if (prepared.workshop) target.workshop = prepared.workshop;
        target.tags = prepared.tags;
      } finally {
        seed.destroy();
        staging.shared.destroy();
      }
      target.shared = { server, room };
      track("Board shared");
      await local.save(target);
      clearTimeout(cloudTimer);
      pendingCloud.delete(target.id);
      // The shared board exists now. The copy in Puter is told about it so
      // other devices open the shared one; if that write fails, sharing
      // has still succeeded and only that copy is behind.
      await cloud
        .save(target)
        .catch(() =>
          toast("Shared, but the copy in Puter could not be updated."),
        );
      if (current !== target) return;
      progress.step("Connecting to shared board…");
      await startCollaboration(
        target,
        undefined,
        target.timer && clone(target.timer),
      );
      renderBoardTag();
    } else if (!collaboration?.connected || collaboration.closed) {
      await connect();
      progress = sharing = shareProgress(target);
      progress.show();
      progress.step("Connecting to shared board…");
      await startCollaboration(target);
    }
    if (current !== target || !collaboration) return;
    const linkedId = boardDestination(location.href, location.href)?.objectId;
    window.history.replaceState(
      window.history.state,
      "",
      objectAddress(target, linkedId, location.href),
    );
    draw();
    const session = collaboration;
    progress?.finish();
    // Closed while it was being set up: say it is ready rather than open
    // a dialog the person did not ask for just now.
    if (progress?.dismissed)
      return toast("Sharing is ready. Select Share board to invite people.");
    modal(
      "Share board",
      `<p class="dialog-copy">${t("Invite people to edit, comment on, or view this board. Invitation links expire after seven days.")}</p><label class="field">${t("Link access")}<select id="share-role">${boardAccess.roleOptions(collaboration.role === "facilitator" ? "facilitator" : "owner")}</select></label>${boardAccess.shareControls()}<div class="share-link-row"><label class="field">${t("Board link")}<input id="share-link" readonly aria-label="${t("Board link")}"></label><button class="primary" id="copy-share">${icon("link")}${t("Copy link")}</button></div><p id="share-message" class="dialog-status" role="status"></p><div class="dialog-footer"><button class="secondary" id="board-settings-open">${icon("settings")}${t("Board settings")}</button><button class="text-btn" id="revoke-invites">${icon("refresh-cw")}${t("Reset link")}</button></div>`,
      (d) => {
        const field = d.querySelector("#share-link"),
          message = d.querySelector("#share-message"),
          role = d.querySelector("#share-role"),
          members = d.querySelector("#share-members"),
          scope = d.querySelector("#share-scope"),
          copy = d.querySelector("#copy-share");
        let invitation, making, joined;
        // The link always works: a manager's invitation is created as soon
        // as the dialog opens, and again when other access is chosen, so
        // the field never shows a link that will not open. Others see the
        // board's own link, which opens for people who already have access.
        const showLink = () => {
          const manager = managesBoard(session);
          field.value =
            invitation || !manager
              ? sectionLink(
                  shareLink(session.server, session.room, invitation),
                  scope?.value,
                )
              : "";
          field.placeholder = field.value ? "" : t("Creating link…");
        };
        const invite = async ({ fresh = false } = {}) => {
          if (!managesBoard(session)) return showLink();
          // Opening the dialog again shows the same link for the same
          // access, as in Miro, rather than creating (and auditing) a new
          // invitation each time; one is reused for six of its seven days.
          const kept = boardInvitations.get(session) || new Map(),
            key = `${role.value}|${!!members?.checked}`,
            reuse = kept.get(key);
          boardInvitations.set(session, kept);
          const access = {
            role: role.value,
            ...(members?.checked ? { membersOnly: true } : {}),
          };
          invitation = undefined;
          showLink();
          // A link reset elsewhere, as from another device, is not shown
          // again; a worker that cannot tell makes a new one. The check and
          // any new link are one request, which Copy waits for.
          const pending = (making =
            !fresh && reuse && Date.now() - reuse.at < 6 * 86400000
              ? session
                  .request("invite-status", { token: reuse.token, ...access })
                  .then(
                    (result) => result?.valid === true,
                    () => false,
                  )
                  .then((valid) =>
                    valid
                      ? { token: reuse.token, at: reuse.at }
                      : session.request("invite", access),
                  )
              : session.request("invite", access));
          try {
            const { token, at = Date.now() } = await pending;
            // Other access chosen meanwhile: that request's link is shown.
            if (making !== pending) return;
            invitation = token;
            kept.set(key, { token, at });
            showLink();
            if (message.dataset.kind === "error") notice(message, "");
          } catch (error) {
            if (making === pending) notice(message, t(error.message), "error");
          } finally {
            if (making === pending) making = null;
          }
        };
        scope?.addEventListener("change", showLink);
        // An invitation grants the access chosen when it was created, so
        // choosing other access makes a new link with that access.
        const accessChanged = () => {
          notice(
            message,
            "The link now gives the chosen access. Links copied earlier keep the access they had.",
          );
          invite();
        };
        role.addEventListener("change", accessChanged);
        members?.addEventListener("change", accessChanged);
        d.querySelector("#board-settings-open").onclick = () => {
          d.close();
          boardAccess.settings();
        };
        // Everyone can copy the board link; only managers invite. A role
        // changed by someone else while this is open updates the controls.
        const showAccess = () => {
          const manager = managesBoard(session),
            chosen = role.value,
            focused = d.contains(document.activeElement)
              ? document.activeElement
              : null;
          d.shareRole = accessKey();
          role.innerHTML = boardAccess.roleOptions(
            session.role === "facilitator" ? "facilitator" : "owner",
          );
          if ([...role.options].some((o) => o.value === chosen))
            role.value = chosen;
          d.querySelector("#board-settings-open").hidden = !manager;
          for (const control of d.querySelectorAll(
            "#share-role, #share-members",
          ))
            control.disabled = !manager;
          d.querySelector("#revoke-invites").hidden = !manager;
          const refused = t(
            "Only the owner or a facilitator can invite new participants.",
          );
          if (!manager) {
            invitation = undefined;
            making = null;
            showLink();
            notice(message, refused);
          } else {
            if (message.textContent === refused) notice(message, "");
            if (!invitation && !making) invite();
            else showLink();
          }
          // A control withdrawn while focused hands focus to Copy link.
          if (
            focused &&
            (focused.matches(":disabled") || focused.closest("[hidden]"))
          )
            copy.focus();
        };
        d.showAccess = showAccess;
        showAccess();
        // Copying waits for a link still being created, and tries again
        // for one that could not be made.
        copy.onclick = async (e) => {
          const done = busy(e.currentTarget);
          try {
            if (making) await making.catch(() => {});
            if (!field.value) await invite();
            if (!field.value) return;
            // The platform may prompt for a cross-user event grant, so it is
            // asked when the link is handed out, not as the dialog opens.
            // The invitation works either way, so a failure is not reported.
            if (invitation && !joined) {
              joined = true;
              session
                .request("join")
                .then((result) => {
                  if (result.app && window.puter.perms?.request)
                    window.puter.perms
                      .request(
                        `manage:kv-share:${result.owner}:${result.app}:wb`,
                      )
                      .catch(() => {});
                })
                .catch(() => {
                  /* Live updates fall back to periodic synchronization. */
                });
            }
            const sharing = boardAccess.sharing();
            const reach = !managesBoard(session)
              ? "It opens for people who already have access."
              : !sharing.organization
                ? "Anyone signed in with it can join."
                : members?.checked || !sharing.guests
                  ? "Members of the organization signed in with it can join."
                  : assignableRoles("owner", sharing.guestRole).includes(
                        role.value,
                      )
                    ? "Anyone signed in with it can join. People outside the organization join as guests."
                    : t(
                        "Anyone signed in with it can join. People outside the organization join as guests with “{role}” access, the most your organization gives guests.",
                      ).replace("{role}", () =>
                        t(ROLE_LABELS[sharing.guestRole]),
                      );
            try {
              await navigator.clipboard.writeText(field.value);
              notice(message, `${t("Link copied.")} ${t(reach)}`, "success");
            } catch {
              field.focus();
              field.select();
              notice(message, `${t("Copy the selected link.")} ${t(reach)}`);
            }
          } finally {
            done();
          }
        };
        // Resetting withdraws every invitation link handed out so far and
        // shows a fresh one, as members already on the board keep access.
        d.querySelector("#revoke-invites").onclick = async (e) => {
          const done = busy(e.currentTarget);
          try {
            await session.request("revoke-invite");
            boardInvitations.get(session)?.clear();
            await invite({ fresh: true });
            notice(
              message,
              "Earlier links no longer work. People already on the board keep access.",
              "success",
            );
          } catch (error) {
            notice(message, t(error.message), "error");
          } finally {
            done();
          }
        };
      },
    );
  } catch (error) {
    progress?.finish();
    if (current === target && !collaboration)
      status("Sharing failed · try again");
    toast(error.message || "Could not connect to Puter.");
  } finally {
    progress?.finish();
    if (sharing === progress) sharing = null;
    if (current === target) {
      collaborationBusy = false;
      renderParticipants();
    }
  }
}
// Open a shared board by its worker and room, creating the local entry the
// first time. Organization boards, invitations, and notifications use this.
async function openShared(
  server,
  room,
  { token, objectId, thread, query } = {},
) {
  await connect();
  if ((await leaveCollaboration()) === false)
    throw Error(t("Local recovery failed. Keep this tab open."));
  const same = (b) => b.shared?.server === server && b.shared?.room === room;
  let target = boards.find(same);
  // Joining is a request to use the board: its entry in Trash is restored
  // rather than opened as trashed, or doubled by a second entry. The store
  // keeps a board's library choices through content saves, so the restore
  // is written as one.
  if (target?.deletedAt) {
    delete target.deletedAt;
    await local.save(target, { library: "deletedAt" }).catch(() => {});
  }
  // Another tab may have joined it since this one read the library; its
  // entry, and what that tab keeps for it on this device, are used as they
  // are, rather than a second entry being made and cleared on a failure.
  // Only the boards this tab has not read are read, not the whole library.
  if (!target) {
    const known = new Set(boards.map((b) => b.id));
    for (const id of await local.ids()) {
      if (known.has(id)) continue;
      const stored = await local.get(id);
      if (Array.isArray(stored?.items) && same(stored) && !stored.deletedAt) {
        target = stored;
        boards.push(target);
        break;
      }
    }
  }
  const created = !target;
  if (created) {
    target = board(t("Shared board"));
    target.shared = { server, room };
    boards.push(target);
  }
  current = target;
  // Reset per-board state as openBoard does.
  exportRegion = null;
  selection.clear();
  history = new History();
  tool = "select";
  view = { x: 110, y: 85, z: 1 };
  status.board = null;
  editor();
  try {
    await startCollaboration(target, token);
  } catch (error) {
    // A board this browser could not join has no local copy to show, so
    // its empty placeholder leaves the library again.
    if (
      created &&
      current === target &&
      (!collaboration || collaboration.closed)
    ) {
      boards.splice(boards.indexOf(target), 1);
      forgetJoin(target);
      await home();
    }
    throw error;
  }
  if (created) track("Shared board joined");
  // Left before it connected: there is nothing more to open, and a board
  // this browser had not joined before leaves the library again.
  if (current !== target) {
    if (created && boards.includes(target)) {
      boards.splice(boards.indexOf(target), 1);
      refreshLibrary();
      forgetJoin(target);
    }
    return target;
  }
  await local.save(target);
  fit();
  window.history.replaceState(
    null,
    "",
    objectId
      ? objectAddress(target, objectId, location.href)
      : shareLink(server, room),
  );
  if (objectId) focusLinkedObject(objectId, false);
  if (thread && current === target) comments.show(thread);
  // Found in the organization's boards by what it holds: Find on board
  // shows the first match.
  else if (query && current === target) openBoardSearch(query);
  return target;
}
// A board this browser joined for the first time and did not keep: its
// first synchronization may already have saved it on this device, with its
// images and files.
function forgetJoin(target) {
  const scope = collaborationScopes.get(target);
  queuedShared = null;
  saveChain = saveChain
    .catch(() => {})
    .then(() => local.remove(target.id))
    .then(() => scope && local.collaborationClear(scope))
    .catch(() => {});
}
// Images and files of a shared board that have not downloaded yet are
// references to its server, which no file or other board can use. Before
// `copy` leaves the board, the open board's session downloads them; for a
// board that is not open, what this device kept of them is used. Any still
// missing are reported rather than left in the copy.
// Nothing is returned, and nothing waited for, when there are none.
function includeSharedMedia(copy, source = current) {
  const missing = () =>
    copy.items.some((i) =>
      ["src", "data"].some((key) => ASSET.test(i[key] || "")),
    );
  if (source?.shared && missing())
    return fetchSharedMedia(copy, source, missing);
}
async function fetchSharedMedia(copy, source, missing) {
  const open = source === current && collaboration && !collaboration.closed;
  if (open) await collaboration.hydrate(copy);
  else {
    const kept = new Map(
      (await local.collaborationBoardRows(source.shared).catch(() => []))
        .filter((r) => r.kind === "asset")
        .map((r) => [r.asset, r.data]),
    );
    for (const i of copy.items)
      for (const key of ["src", "data"]) {
        const data = kept.get(ASSET.exec(i[key] || "")?.[1]);
        if (data) i[key] = data;
      }
  }
  if (missing())
    throw Error(
      open
        ? "Some images or files have not downloaded from the shared board yet. Try again in a moment."
        : "Some images or files of this shared board are not on this device yet. Open the board to download them, then try again.",
    );
}
function joinDialog(link = "") {
  modal(
    "Join shared board",
    `<form><label class="field">${t("Board link")}<input id="join-link" type="url" required value="${escape(link)}" placeholder="https://…" aria-label="${t("Board link")}"></label><p class="dialog-copy">${t(window.puter?.auth?.isSignedIn?.() ? "Paste the link you were given to open the board." : "Sign in with Puter to join this board.")}</p><p id="join-error" class="dialog-status" role="status"></p><div class="dialog-footer"><button class="primary" type="submit">${t("Join board")}</button></div></form>`,
    (d) => {
      d.querySelector("form").onsubmit = async (event) => {
        event.preventDefault();
        const done = busy(d.querySelector('[type="submit"]'));
        try {
          const inputURL = new URL(
            d.querySelector("#join-link").value,
            location.href,
          ).href;
          const { server, room, token } = parseLink(inputURL);
          const { objectId, thread } =
            boardDestination(inputURL, inputURL) || {};
          await openShared(server, room, { token, objectId, thread });
          d.close();
        } catch (error) {
          notice(d.querySelector("#join-error"), error.message, "error");
        } finally {
          done();
        }
      };
    },
  );
}
function participantsDialog() {
  const session = collaboration;
  if (!session) return;
  modal(
    "Participants",
    '<div id="participant-list" class="participant-list"></div><p id="participant-status" class="dialog-copy" role="status" aria-live="polite"></p><p id="participant-error" class="dialog-copy" role="alert" hidden></p>',
    async (d) => {
      attention.mountDialog(d);
      const list = d.querySelector("#participant-list");
      const heading = document.createElement("h3");
      heading.textContent = t("Board access");
      list.before(heading);
      try {
        const { members } = await session.request("members");
        if (collaboration === session) boardMembers = members;
        // A change still saving is kept by person, with the role chosen, so
        // a row shown anew by a search or another page keeps showing it and
        // cannot be changed again until it is done.
        const rows = [],
          pending = new Map();
        // Choices follow this person's own role, which can change while
        // the dialog is open. Removing someone is a separate button, not a
        // role: arrow keys on a closed menu choose an option at once on
        // some systems, and removal takes a second press.
        const fill = (select, member) => {
          const focused = document.activeElement,
            remove = select.nextElementSibling;
          select.replaceChildren();
          const limit = member.guest
            ? boardAccess.sharing(session.sharing).guestRole
            : undefined;
          for (const role of member.role === "owner"
            ? ["owner"]
            : [
                ...new Set([
                  member.role,
                  ...assignableRoles(session.role, limit),
                ]),
              ]) {
            const option = document.createElement("option");
            option.value = role;
            option.textContent = t(ROLE_LABELS[role]);
            select.append(option);
          }
          const saving = pending.get(member.uuid);
          select.value = [...select.options].some((o) => o.value === saving)
            ? saving
            : member.role;
          const locked =
            !managesBoard(session) ||
            member.role === "owner" ||
            (session.role !== "owner" && member.role === "facilitator");
          select.disabled = locked || pending.has(member.uuid);
          remove.disabled = pending.has(member.uuid);
          remove.hidden = locked || member.role === "removed";
          // A guest's access that ends can be renewed by those who manage
          // their role, while the organization admits guests.
          const renew = select
            .closest(".participant-row")
            ?.querySelector("[data-renew-member]");
          if (renew) {
            const hadFocus = document.activeElement === renew;
            renew.hidden =
              locked ||
              !member.guest ||
              member.role === "removed" ||
              member.accessEnds === undefined ||
              !boardAccess.sharing(session.sharing).guests;
            renew.disabled = pending.has(member.uuid);
            if (hadFocus && renew.hidden) d.querySelector("button")?.focus();
          }
          if (
            (focused === select && locked) ||
            (focused === remove && remove.hidden)
          )
            d.querySelector("button")?.focus();
        };
        d.refreshAccess = () => {
          d.accessRole = accessKey();
          for (const [select, member] of rows) fill(select, member);
        };
        const said = d.querySelector("#participant-status");
        // A role saved, or someone removed, is said in the dialog.
        const change = async (select, member, role) => {
          const failure = d.querySelector("#participant-error");
          failure.hidden = true;
          said.textContent = "";
          if (pending.has(member.uuid)) return;
          const done = busy(select);
          select.nextElementSibling.disabled = true;
          pending.set(member.uuid, role);
          try {
            await session.request("role", { uuid: member.uuid, role });
            member.role = role;
            said.textContent = t(
              role === "removed" ? "Participant removed." : "Role changed.",
            );
            await session.heartbeat();
            return true;
          } catch (error) {
            // The reason stays in the dialog rather than a fading toast.
            failure.textContent = t(error.message);
            failure.hidden = false;
          } finally {
            done();
            pending.delete(member.uuid);
            // The row now shown for this person, which a search or another
            // page may have put in place of the one changed.
            const live = rows.find(([, m]) => m.uuid === member.uuid);
            if (live) fill(...live);
          }
        };
        d.accessRole = accessKey();
        // Under a name: when a guest's access ends, or that the person can
        // no longer open the board.
        const accessNote = (member) => {
          if (member.role === "removed") return "";
          const ended =
            member.accessEnds !== undefined && member.accessEnds < Date.now();
          if (member.inactive)
            return t(
              member.guest && ended
                ? "Guest access ended"
                : "Can no longer open this board",
            );
          return member.guest && member.accessEnds !== undefined
            ? t("Access until {date}").replace("{date}", () =>
                cardDate(member.accessEnds),
              )
            : "";
        };
        const renewAccess = async (button, member, note, name) => {
          const failure = d.querySelector("#participant-error");
          failure.hidden = true;
          said.textContent = "";
          if (pending.has(member.uuid)) return;
          const done = busy(button);
          pending.set(member.uuid, member.role);
          try {
            const result = await session.request("renew", {
              uuid: member.uuid,
            });
            member.accessEnds = result.member.accessEnds;
            delete member.inactive;
            note.textContent = accessNote(member);
            said.textContent =
              member.accessEnds === undefined
                ? t("Access renewed.")
                : t("Access renewed until {date}.").replace("{date}", () =>
                    cardDate(member.accessEnds),
                  );
          } catch (error) {
            failure.textContent = t(error.message);
            failure.hidden = false;
          } finally {
            done();
            pending.delete(member.uuid);
            const live = rows.find(([, m]) => m.uuid === member.uuid);
            if (live) fill(...live);
          }
        };
        const makeRow = (member) => {
          const row = document.createElement("div");
          row.className = "participant-row";
          const who = document.createElement("div");
          who.className = "participant-who";
          const name = document.createElement("span");
          name.className = "participant-name";
          name.textContent = member.username || member.uuid;
          name.style.borderColor = participantColor(member.uuid);
          const note = document.createElement("small");
          note.className = "participant-note";
          const status = document.createElement("span");
          status.textContent = accessNote(member);
          const renew = document.createElement("button");
          renew.type = "button";
          renew.className = "text-btn";
          renew.dataset.renewMember = member.uuid;
          renew.textContent = t("Renew access");
          renew.setAttribute(
            "aria-label",
            t("Renew access for {name}").replace(
              "{name}",
              () => name.textContent,
            ),
          );
          renew.hidden = true;
          renew.onclick = () => renewAccess(renew, member, status, name);
          note.append(status, renew);
          // The name, with a guest's badge beside it, over the note.
          const line = document.createElement("span");
          line.className = "participant-line";
          line.append(name);
          who.append(line, note);
          row.append(who);
          const select = document.createElement("select");
          select.setAttribute(
            "aria-label",
            t("Access for") + " " + name.textContent,
          );
          if (member.guest) {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = t("Guest");
            line.append(badge);
          }
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "text-btn";
          remove.dataset.removeMember = member.uuid;
          const unarm = () => {
            delete remove.dataset.confirm;
            remove.classList.remove("danger");
            remove.textContent = t("Remove");
            remove.setAttribute(
              "aria-label",
              `${t("Remove")} ${name.textContent}`,
            );
          };
          unarm();
          remove.onblur = unarm;
          const access = document.createElement("span");
          access.className = "participant-access";
          access.append(select, remove);
          row.append(access);
          fill(select, member);
          rows.push([select, member]);
          select.onchange = () => change(select, member, select.value);
          remove.onclick = async () => {
            if (!remove.dataset.confirm) {
              remove.dataset.confirm = "true";
              remove.classList.add("danger");
              remove.textContent = t("Confirm remove");
              remove.setAttribute(
                "aria-label",
                `${t("Confirm remove")} ${name.textContent}`,
              );
              return;
            }
            const focused = document.activeElement === remove;
            unarm();
            const removed = await change(select, member, "removed");
            if (!removed || !row.isConnected) return;
            // Removed people leave the list unless it shows them, and the
            // keyboard moves on to the search field.
            show();
            if (focused) d.querySelector("#access-search").focus();
          };
          return row;
        };
        // A large board has hundreds of members: they are found by name,
        // role or status and shown fifty at a time, and people who were
        // removed stay out of the way unless asked for.
        const controls = document.createElement("div");
        controls.className = "access-controls";
        controls.innerHTML = `<label class="field">${t("Find a person")}<input id="access-search" type="search" maxlength="100"></label><label hidden><input type="checkbox" id="access-removed">${t("Show removed people")}</label><p id="access-count" class="dialog-copy" role="status" aria-live="polite" aria-atomic="true"></p>`;
        list.before(controls);
        const pages = document.createElement("div");
        pages.className = "access-pages";
        pages.innerHTML = `<button class="secondary" id="access-prev">${t("Previous")}</button><button class="secondary" id="access-next">${t("Next")}</button>`;
        list.after(pages);
        let page = 0;
        const fold = (text) =>
          String(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
        const show = () => {
          const needle = fold(d.querySelector("#access-search").value.trim());
          const toggle = d.querySelector("#access-removed");
          toggle.parentElement.hidden = !members.some(
            (m) => m.role === "removed",
          );
          const removed = toggle.checked;
          const matching = members.filter(
            (m) =>
              (removed || m.role !== "removed") &&
              (!needle ||
                fold(
                  `${m.username || m.uuid} ${t(ROLE_LABELS[m.role] || "")} ${m.guest ? t("Guest") : ""}`,
                ).includes(needle)),
          );
          page = Math.min(
            page,
            Math.max(0, Math.ceil(matching.length / 50) - 1),
          );
          rows.length = 0;
          list.replaceChildren(
            ...matching.slice(page * 50, page * 50 + 50).map(makeRow),
          );
          const count = d.querySelector("#access-count");
          count.textContent = matching.length
            ? plural(matching.length, "{count} person", "{count} people")
            : t("No one matches your search.");
          pages.hidden = matching.length <= 50;
          d.querySelector("#access-prev").disabled = page === 0;
          d.querySelector("#access-next").disabled =
            (page + 1) * 50 >= matching.length;
        };
        d.querySelector("#access-search").oninput = () => {
          page = 0;
          show();
        };
        d.querySelector("#access-removed").onchange = () => {
          page = 0;
          show();
        };
        for (const [button, step] of [
          ["#access-prev", -1],
          ["#access-next", 1],
        ])
          d.querySelector(button).onclick = (e) => {
            page += step;
            show();
            // The keyboard stays on the paging buttons.
            if (e.currentTarget.disabled)
              d.querySelector(
                step < 0 ? "#access-next" : "#access-prev",
              ).focus();
          };
        show();
      } catch (error) {
        // The list itself is not announced as it loads, which would read
        // out every member; only a failure is.
        const message = document.createElement("p");
        message.className = "dialog-copy";
        message.setAttribute("role", "alert");
        message.textContent = t(error.message);
        list.replaceChildren(message);
      }
    },
  );
}
async function connect() {
  if (!window.puter)
    throw Error("Puter could not load. Check your connection and try again.");
  if (!window.puter.auth.isSignedIn()) {
    // Closing Puter's sign-in window rejects with a plain object, which
    // would show no message at all.
    await window.puter.auth.signIn().catch((error) => {
      throw error instanceof Error
        ? error
        : Error("Sign in with Puter to continue.");
    });
    // Every header now shows who is signed in.
    await account.refresh();
    // Someone who signs in now gets their organization's policies, such as
    // its AI settings, just as if they had been signed in on arrival.
    await reconnectOrganization().catch(() => {});
    cloud ??= new CloudStore(window.puter);
    loadCloudIndex();
  }
  cloud ??= new CloudStore(window.puter);
  return cloud;
}
// Reconnect to a remembered or site-configured organization quietly.
async function reconnectOrganization() {
  if (organization.info) return;
  const found = await organization.discover();
  if (!found || readOrganizationLink(location.href)) return;
  if (!window.puter?.auth?.isSignedIn?.()) return;
  await organization.use(found.server);
  if (!current) home({ keepAddress: true });
}
async function cloudSave() {
  if (collaboration) {
    await collaborationEdits;
    return collaboration.flush().catch((e) => {
      collaboration.failure(e);
      toast(e.message);
    });
  }
  // The board the save was asked for: signing in can take a while, during
  // which another board may be opened or the library shown.
  const target = current;
  if (!target) return;
  try {
    await connect();
    if (!boards.includes(target) || target.shared) return;
    cloudIds.add(target.id);
    await sync(clone(target));
  } catch (e) {
    toast(e.message || "Could not connect to Puter.");
  }
}
// Which boards the account keeps in Puter, so the library and the open
// board can say so. The index is one small file; nothing else is read.
async function loadCloudIndex() {
  if (!window.puter?.auth?.isSignedIn?.()) return;
  try {
    cloud ??= new CloudStore(window.puter);
    const files = await cloud.list();
    if (!window.puter.auth.isSignedIn()) return;
    cloudIndex = new Set(files.map((f) => f.name.slice(0, -5)));
    cloudTitles = new Map(files.map((f) => [f.name.slice(0, -5), f.title]));
  } catch {
    return;
  }
  refreshLibrary();
  renderBoardTag();
}
// Signing in from the header is its own step, with its own confirmation,
// rather than a side effect of saving or sharing.
async function signInAccount() {
  try {
    await connect();
  } catch (e) {
    return toast(e.message || "Could not sign in. Try again.");
  }
  loadCloudIndex();
  // The library's reminder that boards stay in this browser is answered.
  document.querySelector(".sidebar-note")?.remove();
  const name = account.name();
  toast(
    name
      ? t("Signed in as {name}.").replace("{name}", () => name)
      : "Signed in with Puter.",
  );
}
async function signOutAccount() {
  if (!window.puter?.auth?.isSignedIn?.()) return;
  // A shared board lives in the account that is leaving; it is closed first.
  if (current?.shared) {
    await home();
    if (current) return;
  }
  // An edit still waiting for its upload goes before the account leaves;
  // it would otherwise be dropped with the header still saying it is saving.
  clearTimeout(cloudTimer);
  if (current && pendingCloud.has(current.id)) await sync(clone(current));
  await cloud?.queue.catch(() => {});
  window.puter.auth.signOut();
  cloud = null;
  cloudIds.clear();
  cloudIndex.clear();
  cloudTitles.clear();
  cloudUnverified.clear();
  pendingCloud.clear();
  // The organization belonged to that account; the next person to sign in
  // finds their own.
  organization.reset();
  await account.refresh();
  if (!current) await home({ keepAddress: true });
  else {
    status(savedStatus(current));
    renderBoardTag();
  }
  toast("Signed out. Your local boards are still available.");
}
// Open a board from the account's Puter drive: its saved copy, unless this
// device holds a newer one. The library's Puter cards and the notice about
// a newer copy both use it.
async function openCloudBoard(f, { replace = false } = {}) {
  const b = await cloud.read(f.path || `whiteboard/${f.name}`);
  const existing = boards.find((x) => x.id === b.id);
  if (existing && replace) {
    // Asked for Puter's copy outright, after an edit here could not go up:
    // the edits made on this device are kept as a board of their own
    // rather than lost.
    const kept = clone(existing);
    kept.id = uid();
    kept.title = `${existing.title} (${t("copy on this device")})`.slice(
      0,
      200,
    );
    delete kept.favorite;
    boards.push(kept);
    await local.save(kept);
    toast(
      "Opened the copy from Puter. The edits made on this device are kept as their own board.",
    );
  } else if (existing && existing.updated > b.updated) {
    toast("A newer local copy was kept.");
    cloudIds.add(existing.id);
    cloudUnverified.delete(existing.id);
    // Opening a copy that is in the trash takes it out again.
    if (existing.deletedAt) {
      delete existing.deletedAt;
      await saveLibrary(existing, "deletedAt").catch(() => {});
    }
    return openBoard(
      boards.find((board) => board.id === existing.id) || existing,
    );
  }
  b.id = f.name.slice(0, -5);
  const index = boards.findIndex((x) => x.id === b.id);
  if (index >= 0) boards[index] = b;
  else boards.push(b);
  try {
    await local.save(b);
  } catch (error) {
    // Another tab keeps a newer copy this tab had not read: it is opened
    // instead of being written over.
    const stored = error?.name === "StaleBoardError" && (await local.get(b.id));
    if (!stored) throw error;
    boards[boards.indexOf(b)] = stored;
    toast("A newer local copy was kept.");
    cloudIds.add(stored.id);
    cloudUnverified.delete(stored.id);
    if (stored.deletedAt) {
      delete stored.deletedAt;
      await saveLibrary(stored, "deletedAt").catch(() => {});
    }
    return openBoard(stored);
  }
  // Opening a copy that is in the trash takes it out again, here too: the
  // save above kept the stored copy's place in the trash.
  if (b.deletedAt) {
    delete b.deletedAt;
    await local.save(b, { library: "deletedAt" }).catch(() => {});
  }
  cloudIds.add(b.id);
  cloudIndex.add(b.id);
  cloudUnverified.delete(b.id);
  return openBoard(b);
}
// After the library is drawn again, the keyboard goes back to the card it
// was on, or to the chosen list when that card is gone.
function focusLibraryCard(id) {
  revealLibraryCard(id);
  (
    document.querySelector(`[data-more="${escape(id)}"]`) ||
    document.querySelector(".nav-item.active")
  )?.focus();
}
// Update a completed library operation without moving focus from later work.
function refreshLibraryKeepingFocus() {
  const focused = document.activeElement,
    action = ["open", "more", "favorite"].find((key) => focused?.dataset[key]),
    focusedId = action && focused.dataset[action];
  refreshLibrary();
  if (
    action &&
    !focused.isConnected &&
    document.activeElement === document.body
  ) {
    const replacement = [...document.querySelectorAll(`[data-${action}]`)].find(
      (control) => control.dataset[action] === focusedId,
    );
    if (replacement) replacement.focus();
    else focusLibraryCard(focusedId);
  }
}
// Adopt the stored content and its conflict boundary together, unless a
// current editor still owns its earlier copy and unsaved draft.
function saveLibrary(b, library) {
  return local.save(b, {
    library,
    accept: (latest, changed) => {
      if (current?.id === b.id) {
        if (changed && !current.shared) {
          status("Not saved");
          toast(
            "This board changed in another tab. Reload to see the latest copy.",
          );
        }
        return false;
      }
      const index = boards.findIndex((board) => board.id === b.id);
      if (index < 0) return false;
      boards[index] = latest;
      return true;
    },
  });
}
// A library change refused because another tab changed or deleted the
// board since this tab listed it: the library shows the board as the store
// holds it now, or no board at all, and says why.
async function followStore(b, error) {
  if (!["StaleBoardError", "DeletedBoardError"].includes(error?.name))
    return false;
  toast(error.message);
  let stored;
  try {
    stored = await local.get(b.id, {
      accept: (latest) => {
        // Adopt and acknowledge together. A board opened while this read
        // waits still owns its draft and its earlier conflict guard.
        const index = boards.indexOf(b);
        if (current === b || index < 0) return false;
        boards[index] = latest;
        return true;
      },
    });
  } catch {
    // A failed read gives no evidence that the board is missing.
    if (current === b) {
      status("Not saved");
      return true;
    }
    return false;
  }
  if (current === b) {
    status("Not saved");
    return true;
  }
  if (!stored) {
    const index = boards.indexOf(b);
    if (index >= 0) boards.splice(index, 1);
  }
  return true;
}
function boardOptions(b) {
  if (b.deletedAt) {
    modal(
      "Trash",
      `<p data-user-content>${escape(b.title)}</p><div class="dialog-footer"><button class="text-btn danger" id="purge-board">Delete permanently</button><button class="primary" id="restore-board">Restore board</button></div>`,
      (d) => {
        d.querySelector("#restore-board").onclick = async () => {
          const deletedAt = b.deletedAt;
          delete b.deletedAt;
          try {
            await saveLibrary(b, "deletedAt");
          } catch (error) {
            b.deletedAt = deletedAt;
            if (!(await followStore(b, error)))
              return toast("Could not save this change on this device.");
            if (!d.open || !d.isConnected) return refreshLibraryKeepingFocus();
            d.close();
            return home();
          }
          if (!d.open || !d.isConnected) return refreshLibraryKeepingFocus();
          d.close();
          await home();
          focusLibraryCard(b.id);
          toast("Board restored.");
        };
        d.querySelector("#purge-board").onclick = () => {
          d.close();
          modal(
            "Delete this board permanently?",
            `<p class="dialog-copy">${t("This removes the board and its recovery versions from this device. It cannot be undone.")}${boardStorage(b) === "cloud" ? ` ${t("The copy saved in Puter is kept.")}` : ""} <span data-user-content>${escape(b.title)}</span></p><div class="dialog-footer"><button class="secondary" id="cancel-purge">Keep in trash</button><button class="primary danger-fill" id="confirm-purge">Delete permanently</button></div>`,
            (dialog) => {
              dialog.querySelector("#cancel-purge").onclick = () =>
                dialog.close();
              dialog.querySelector("#confirm-purge").onclick = async (e) => {
                const button = e.currentTarget;
                if (button.disabled) return;
                button.disabled = true;
                try {
                  await local.remove(b.id);
                } catch {
                  button.disabled = false;
                  return toast("Could not delete this board from this device.");
                }
                // Its versions go too; what cannot be removed now is only
                // space, not a board anyone can still reach.
                await local.removeRevisions(b.id).catch(() => {});
                // So do a shared board's synchronized copy and images,
                // unless another board here is the same shared board.
                if (
                  b.shared &&
                  !boards.some(
                    (x) =>
                      x !== b &&
                      x.shared?.server === b.shared.server &&
                      x.shared?.room === b.shared.room,
                  )
                )
                  await local.collaborationClearBoard(b.shared).catch(() => {});
                boards.splice(boards.indexOf(b), 1);
                dialog.close();
                await home();
                focusLibraryCard(b.id);
                toast("Board deleted permanently.");
              };
            },
          );
        };
      },
    );
    return;
  }
  modal(
    "Board options",
    `<label class="field">Board name<input id="rename" maxlength="200" value="${escape(b.title)}" aria-describedby="board-rename-status"></label><p id="board-rename-status" class="dialog-status" role="status" aria-live="polite" hidden></p><div class="dialog-footer"><button class="text-btn danger" id="remove-board">Move to trash</button><button class="secondary" id="copy-board">Duplicate</button><button class="primary" id="rename-board">Save name</button></div>`,
    (d) => {
      const name = d.querySelector("#rename"),
        controls = [...d.querySelectorAll(".dialog-footer button")],
        requestedName = () =>
          truncate(name.value.trim(), 200) || t("Untitled board"),
        feedback = (message) => {
          const status = d.querySelector("#board-rename-status");
          status.textContent = message;
          status.hidden = false;
        };
      let keptDraft = false,
        unavailable = false;
      const withdraw = () => {
        unavailable = true;
        const focused = document.activeElement;
        for (const control of controls) control.disabled = true;
        if (
          d.isConnected &&
          (focused === document.body || controls.includes(focused))
        )
          name.focus();
      };
      // Refreshing the cards keeps the field intact, but replaces the old
      // launcher. Closing returns focus to the replacement card or list.
      d.addEventListener("close", () => {
        if (!current && document.activeElement === document.body)
          focusLibraryCard(b?.id);
      });
      if (b.shared) {
        d.querySelector("#rename").readOnly = true;
        d.querySelector("#rename-board").textContent = t("Open to rename");
        // Viewers and commenters cannot rename it there either.
        if (b.shared.role && !canEditContent(b.shared.role)) {
          d.querySelector("#rename-board").hidden = true;
          feedback(t("Only people who can edit this board rename it."));
        }
      }
      // Enter in the name field saves, as it does in every other dialog.
      d.querySelector("#rename").onkeydown = (e) => {
        if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        d.querySelector("#rename-board").click();
      };
      d.querySelector("#rename-board").onclick = async () => {
        const button = d.querySelector("#rename-board");
        if (button.disabled || unavailable) return;
        if (b.shared) {
          d.close();
          await openBoard(b);
          document.querySelector("#board-title")?.focus();
          return;
        }
        const id = b.id,
          title = b.title,
          updated = b.updated,
          submitted = requestedName(),
          submittedUpdated = Date.now(),
          held = controls.filter((control) => !control.disabled).map(busy);
        b.title = submitted;
        b.updated = submittedUpdated;
        let written = false;
        try {
          await local.save(b);
          written = true;
          // The copy in Puter takes the new name too, as it does when the
          // board is renamed in the editor; the library would otherwise
          // show one name here and another on every other device.
          if (
            boardStorage(b) === "cloud" &&
            cloud &&
            window.puter?.auth?.isSignedIn?.()
          ) {
            if (!cloudIds.has(id)) {
              cloudIds.add(id);
              cloudUnverified.set(id, updated);
            }
            pendingCloud.set(id, b.updated);
            sync(clone(b));
          }
        } catch (error) {
          const conflict = ["StaleBoardError", "DeletedBoardError"].includes(
              error?.name,
            ),
            message = conflict
              ? error.message
              : "Could not save this change on this device.";
          let followed = false;
          if (current === b) {
            // An opened editor owns its newer state. Reading a foreign
            // copy here would let its stale contents pass the next save.
            if (conflict || status.board !== id) status("Not saved");
            toast(message);
          } else {
            if (b.title === submitted && b.updated === submittedUpdated) {
              b.title = title;
              b.updated = updated;
            }
            followed = await followStore(b, error);
            if (!followed) toast(message);
          }
          if (d.isConnected && (keptDraft || requestedName() !== submitted)) {
            keptDraft = true;
            if (followed && current !== b) {
              const latest = boards.find((board) => board.id === id);
              if (latest && !latest.deletedAt && !latest.shared) {
                b = latest;
                feedback(
                  t(
                    "This board changed in another tab. Your name draft is kept. Save again to rename the latest copy.",
                  ),
                );
              } else {
                unavailable = true;
                feedback(
                  `${t(error.message)} ${t("Your name draft is kept here.")}`,
                );
              }
            } else feedback(t(message));
            refreshLibrary();
            return;
          }
        } finally {
          for (const done of held) done();
          if (unavailable) withdraw();
        }
        if (written && d.isConnected && requestedName() !== submitted) {
          keptDraft = true;
          if (b.deletedAt) {
            withdraw();
            feedback(
              t("This board is in the trash. Your name draft is kept here."),
            );
          } else
            feedback(
              t(
                "Board name saved. You changed it while saving. Save again to update the name.",
              ),
            );
          refreshLibrary();
          return;
        }
        // A completed write belongs to this board, but a closed dialog no
        // longer owns navigation or focus on the user's next board.
        if (!d.open || !d.isConnected) {
          const focused = document.activeElement,
            action = ["open", "more", "favorite"].find(
              (key) => focused?.dataset[key],
            ),
            focusedId = action && focused.dataset[action];
          refreshLibrary();
          if (
            action &&
            !focused.isConnected &&
            document.activeElement === document.body
          ) {
            const replacement = [
              ...document.querySelectorAll(`[data-${action}]`),
            ].find((control) => control.dataset[action] === focusedId);
            if (replacement) replacement.focus();
            else focusLibraryCard(focusedId);
          }
          return;
        }
        d.close();
        await home();
        focusLibraryCard(id);
      };
      d.querySelector("#copy-board").onclick = async (e) => {
        // One copy per press: a double click must not make two.
        const button = e.currentTarget;
        if (button.disabled) return;
        button.disabled = true;
        const copy = clone(b);
        copy.id = uid();
        delete copy.timer;
        // A copy is a new board: it is not starred because the original is.
        copy.favorite = false;
        // A shared board's copy leaves out what this person may not see
        // there, judged by the role they last had on it.
        const covered = facilitation.portableCopy(
          copy,
          b.shared
            ? {
                id: await window.puter?.auth
                  ?.getUser?.()
                  .then((u) => u?.uuid)
                  .catch(() => null),
                manager: canManage(b.shared.role),
              }
            : { id: commentIdentity, manager: true },
        );
        const media = includeSharedMedia(copy, b);
        if (media)
          try {
            await media;
          } catch (error) {
            button.disabled = false;
            return toast(error.message);
          }
        delete copy.shared;
        const suffix = ` (${t("copy")})`;
        copy.title = titleWithSuffix(copy.title, suffix);
        adoptFrameMembers(copy);
        copy.updated = Date.now();
        boards.push(copy);
        try {
          await local.save(copy);
        } catch {
          boards.splice(boards.indexOf(copy), 1);
          button.disabled = false;
          return toast("Could not save the copy on this device.");
        }
        // A completed copy stays in the library. A closed dialog no longer
        // owns navigation or focus on the user's next board.
        if (!d.open || !d.isConnected) {
          const focused = document.activeElement,
            action = ["open", "more", "favorite"].find(
              (key) => focused?.dataset[key],
            ),
            focusedId = action && focused.dataset[action];
          refreshLibrary();
          if (
            action &&
            !focused.isConnected &&
            document.activeElement === document.body
          ) {
            const replacement = [
              ...document.querySelectorAll(`[data-${action}]`),
            ].find((control) => control.dataset[action] === focusedId);
            if (replacement) replacement.focus();
            else focusLibraryCard(focusedId);
          }
          if (covered)
            toast("Workshop content hidden from you was left out of the copy.");
          return;
        }
        d.close();
        await home();
        focusLibraryCard(copy.id);
        if (covered)
          toast("Workshop content hidden from you was left out of the copy.");
      };
      d.querySelector("#remove-board").onclick = () => {
        if (unavailable || d.querySelector("#remove-board").disabled) return;
        d.close();
        modal(
          "Move this board to the trash?",
          `<p class="dialog-copy"><span data-user-content>${escape(b.title)}</span> · ${t("Boards in the trash can be restored from there.")}${boardStorage(b) === "cloud" ? ` ${t("The copy saved in Puter is kept.")}` : ""}</p><div class="dialog-footer"><button class="secondary" id="cancel-delete">Keep board</button><button class="primary danger-fill" id="confirm-delete">Move to trash</button></div>`,
          (dialog) => {
            dialog.querySelector("#cancel-delete").onclick = () =>
              dialog.close();
            dialog.querySelector("#confirm-delete").onclick = async (e) => {
              const button = e.currentTarget;
              if (button.disabled) return;
              button.disabled = true;
              // Trash keeps the board, so a version that cannot be saved,
              // as on a full device, does not stop it from being deleted.
              await local
                .checkpoint(b, "Before deletion", { kept: true })
                .catch(() => {});
              b.deletedAt = Date.now();
              try {
                await saveLibrary(b, "deletedAt");
              } catch (error) {
                delete b.deletedAt;
                if (await followStore(b, error)) {
                  if (!dialog.open || !dialog.isConnected)
                    return refreshLibraryKeepingFocus();
                  dialog.close();
                  return home();
                }
                button.disabled = false;
                return toast("Could not move this board to the trash.");
              }
              if (!dialog.open || !dialog.isConnected)
                return refreshLibraryKeepingFocus();
              dialog.close();
              await home();
              focusLibraryCard(b.id);
            };
          },
        );
      };
    },
  );
}
window.addEventListener("storage", (e) => {
  if (e.key === "whiteboard-character-shortcuts" || e.key === null) {
    characterShortcuts = e.newValue !== "false";
    const input = document.querySelector("#character-shortcuts");
    if (input) input.checked = characterShortcuts;
  }
  if (e.key === PRECISE_SELECTION_KEY || e.key === null) {
    if (drag?.kind === "marquee") {
      canvasNavigation.cancel();
      cancelTransform();
    }
    preciseSelection = readPreciseSelection(e.newValue);
    const input = document.querySelector("#precise-selection");
    if (input) input.checked = preciseSelection;
  }
  if (e.key === DIMENSIONS_STORAGE_KEY || e.key === null) {
    if (drag?.kind === "resize") {
      canvasNavigation.cancel();
      cancelTransform();
    }
    showDimensions = readDimensions(e.newValue);
    const input = document.querySelector("#show-dimensions");
    if (input) input.checked = showDimensions;
    if (current) draw();
  }
  if (e.key === GRID_STORAGE_KEY || e.key === null) {
    if (drag && ["move", "resize", "arrow", "endpoint"].includes(drag.kind)) {
      canvasNavigation.cancel();
      cancelTransform();
    }
    boardGrid = readGrid(e.newValue);
    syncGridControls();
    if (current) draw();
  }
  if (e.key === STYLE_STORAGE_KEY || e.key === null) {
    copiedStyle = readObjectStyle(e.newValue);
    if (current) draw();
  }
  // Appearance and snapping chosen in another tab apply here too, as the
  // other preferences do.
  if (
    (e.key === "whiteboard-language" || e.key === null) &&
    (e.key === null
      ? localStorage.getItem("whiteboard-language")
      : e.newValue) !== language
  ) {
    // The language chosen in another tab applies here once nothing is
    // being typed or moved, as the page is drawn again in it.
    const chosen =
      e.key === null ? localStorage.getItem("whiteboard-language") : e.newValue;
    const apply = () => {
      if (
        language === (chosen === "fr" ? "fr" : "en") ||
        document.querySelector("#language") === null
      )
        return;
      if (editing || drag) return setTimeout(apply, 1000);
      setLanguage(chosen);
      if (current) editor();
      else home();
    };
    apply();
  }
  if (e.key === "whiteboard-theme" || e.key === null) {
    theme = e.newValue || "system";
    applyTheme();
    const select = document.querySelector("#theme");
    if (select) select.value = theme;
    if (current) draw();
    else paintPreviews();
  }
  if (e.key === "whiteboard-snapping" || e.key === null) {
    snapping = e.newValue !== "false";
    document
      .querySelector('[data-action="toggle-snapping"]')
      ?.setAttribute("aria-pressed", String(snapping));
  }
  canvasNavigation.storage(e);
  const input = document.querySelector("#navigation-mode");
  if (input) input.value = canvasNavigation.mode();
});
function syncGridControls() {
  document.querySelectorAll('[name="board-grid-mode"]').forEach((input) => {
    input.checked = input.value === boardGrid.mode;
  });
  const snap = document.querySelector("#snap-grid");
  if (snap) {
    snap.checked = boardGrid.snap;
    snap.disabled = boardGrid.mode === "none";
  }
}
function setGrid(value) {
  boardGrid = normalizeGrid(value);
  try {
    localStorage.setItem(GRID_STORAGE_KEY, JSON.stringify(boardGrid));
  } catch {}
  syncGridControls();
  if (current) draw();
}
function openGridSettings() {
  modal(
    "Grid and snapping",
    `<fieldset class="grid-options"><legend>Canvas grid</legend>${[
      ["none", "No grid"],
      ["lines", "Line grid"],
      ["dots", "Dot grid"],
    ]
      .map(
        ([mode, label]) =>
          `<label><input type="radio" name="board-grid-mode" value="${mode}"><span class="grid-preview grid-preview-${mode}" aria-hidden="true"></span><span>${label}</span></label>`,
      )
      .join(
        "",
      )}</fieldset><label class="grid-snap-option"><input type="checkbox" id="snap-grid">Snap to grid</label><p class="dialog-copy">New objects, moves, and resize edges snap to the visible grid. Object alignment guides take priority.</p><p class="dialog-copy">Hold Ctrl/Cmd or Alt/Option during a gesture to bypass grid snapping. Keyboard nudges and exact dimensions stay precise.</p><p class="dialog-copy">This preference is saved on this device and shared with other open tabs.</p>`,
    (d) => {
      syncGridControls();
      d.querySelectorAll('[name="board-grid-mode"]').forEach((input) => {
        input.onchange = () => setGrid({ ...boardGrid, mode: input.value });
      });
      d.querySelector("#snap-grid").onchange = (e) =>
        setGrid({ ...boardGrid, snap: e.target.checked });
    },
  );
}
function openDimensionSettings() {
  modal(
    "Object dimensions",
    `<label class="grid-snap-option"><input type="checkbox" id="show-dimensions">Show dimensions and matching-size guides</label><p class="dialog-copy">See the selection’s width and height in board pixels. Resize near another object’s width or height to match its size.</p><p class="dialog-copy">Matching sizes uses Snap to objects. Hold Alt/Option to bypass snapping. Exact numeric dimensions stay precise.</p><p class="dialog-copy">This preference is saved on this device and shared with other open tabs.</p>`,
    (d) => {
      const input = d.querySelector("#show-dimensions");
      input.checked = showDimensions;
      input.onchange = () => {
        showDimensions = input.checked;
        try {
          localStorage.setItem(DIMENSIONS_STORAGE_KEY, String(showDimensions));
        } catch {}
        draw();
      };
    },
  );
}
function navigationSettings() {
  modal(
    "Mouse, trackpad, and touch",
    `<label class="field">Navigation mode<select id="navigation-mode"><option value="auto">Auto-detect</option><option value="mouse">Mouse</option><option value="trackpad">Trackpad</option></select></label>
    <p class="dialog-copy">Auto-detect recognizes wheel steps and smooth scrolling. Choose a device if scrolling feels wrong.</p>
    <div class="navigation-help">
      <p><strong>Mouse</strong><span>Scroll to zoom. Right-drag, middle-drag, or Space-drag to pan.</span></p>
      <p><strong>Trackpad</strong><span>Scroll with two fingers to pan. Pinch or Ctrl/Cmd-scroll to zoom. Shift-scroll pans horizontally.</span></p>
      <p><strong>Touch</strong><span>Drag to pan and pinch to zoom. Tap an object to select it, then drag it to move. Hold for a moment, then drag to select several objects. Drawing tools still draw with one finger.</span></p>
    </div><p class="dialog-copy">This preference is saved on this device and shared with other open tabs.</p>`,
    (d) => {
      const input = d.querySelector("#navigation-mode");
      input.value = canvasNavigation.mode();
      input.onchange = () => canvasNavigation.setMode(input.value);
    },
  );
}
function openSelectionSettings() {
  modal(
    "Selection settings",
    `<label class="grid-snap-option"><input id="precise-selection" type="checkbox">Precise selection</label><p class="dialog-copy">Select objects when at least 90% is inside the selection box. Turn off to select touched objects. Tables and mind map nodes always require 90% coverage.</p><p class="dialog-copy">Hold the mouse or your finger still for a moment, then drag to use precise selection over background objects. Hold Shift while dragging to add to your selection. Escape cancels.</p><p class="dialog-copy">This preference is saved on this device and shared with other open tabs.</p>`,
    (d) => {
      const input = d.querySelector("#precise-selection");
      input.checked = preciseSelection;
      input.onchange = () => {
        preciseSelection = input.checked;
        try {
          localStorage.setItem(PRECISE_SELECTION_KEY, String(preciseSelection));
        } catch {}
      };
    },
  );
}
function help() {
  modal(
    "Keyboard shortcuts",
    `<label class="grid-snap-option"><input type="checkbox" id="character-shortcuts" aria-describedby="character-shortcuts-help">Enable letter and symbol shortcuts</label><p id="character-shortcuts-help" class="dialog-copy">Turn off shortcuts such as N, Shift + N, and ? to avoid accidental actions. Ctrl/Cmd and Alt/Option shortcuts remain available. This preference is saved on this device and shared with other open tabs.</p><p class="dialog-copy">Choose a tool, then click the canvas. Double-click an object to edit its text. Drag a corner to resize. Paste text, links, or images, or drop files onto the canvas.</p><div class="shortcuts">${[
      ["V / H", "Select / pan"],
      ["N / T", "Sticky note / text"],
      ["C", "Comment"],
      ["Shift + C", "Show or hide comment pins"],
      ["Shift + N", "Bulk sticky notes"],
      ["R / O", "Rectangle / ellipse"],
      ["S", "Shapes"],
      ["A or L / P / F", "Arrow / draw / frame"],
      ["Space / right / middle + drag", "Move around the canvas"],
      ["Right-click / Shift + F10", "Open the menu of the selection or board"],
      ["Ctrl or Cmd + scroll", "Zoom toward the pointer"],
      ["M", "Minimap"],
      ["Ctrl/Cmd + Plus/Minus", "Zoom in or out"],
      ["Ctrl/Cmd + 0", "Reset zoom to 100 percent"],
      ["Alt/Option + 1 / 2", "Fit board / zoom to selection"],
      ["Shift + click", "Select multiple objects"],
      ["Ctrl/Cmd + F", "Find on board"],
      ["Ctrl/Cmd + K", "Command palette"],
      ["Arrow keys", "Move selected objects"],
      ["Shift + Arrow keys", "Move selected objects by 10"],
      ["Arrow keys with nothing selected", "Move around the canvas"],
      ["Alt / Option + drag", "Drag a copy"],
      ["Alt / Option + Arrow keys", "Duplicate in a direction"],
      ["Alt / Option during drag", "Temporarily bypass snapping"],
      ["Escape", "Cancel the current move or resize"],
      ["Shift + resize", "Toggle proportions while resizing"],
      ["Shift + drag", "Move straight across or down"],
      ["Ctrl/Cmd + Alt/Option + Shift + Plus/Minus", "Resize selection"],
      ["Enter", "Select a group member or edit the focused object"],
      ["Ctrl/Cmd + Shift + Down / Up", "Select a group member / whole group"],
      ["Tab / Shift + Tab", "Indent / outdent a list item"],
      ["Alt + F10", "Move between the text and its formatting toolbar"],
      ["Shift + Enter", "Continue a list item on a new line"],
      ["Ctrl/Cmd + B / I / U", "Bold, italic, or underline while typing"],
      ["Ctrl/Cmd + Alt/Option + K", "Insert or edit text link"],
      ["Ctrl/Cmd + Alt/Option + Shift + K", "Object link"],
      ["Ctrl/Cmd + Alt/Option + Shift + C", "Copy link to object"],
      ["Ctrl/Cmd + Alt/Option + Shift + H", "Version history"],
      ["Ctrl or Cmd + Z", "Undo"],
      ["Ctrl or Cmd + Shift + Z or Ctrl or Cmd + Y", "Redo"],
      ["Ctrl or Cmd + S", "Save to Puter"],
      ["Ctrl or Cmd + A", "Select all objects"],
      ["Ctrl or Cmd + G / Shift + G", "Group / ungroup selection"],
      ["Ctrl or Cmd + D", "Duplicate selection"],
      ["Ctrl or Cmd + Shift + L", "Lock or unlock selection"],
      ["Ctrl or Cmd + C / X / V", "Copy, cut, or paste objects"],
      ["Ctrl/Cmd + Shift + C", "Copy as image"],
      ["Ctrl/Cmd + Alt/Option + C", "Copy style"],
      ["Ctrl/Cmd + Alt/Option + V", "Paste style"],
      ["Ctrl or Cmd + [ / ]", "Send backward / bring forward"],
      ["Ctrl or Cmd + Shift + [ / ]", "Send to back / bring to front"],
      ["Page Down / Page Up", "Send to back / bring to front"],
      ["Ctrl/Cmd + Backspace", "Clear content of sticky notes and shapes"],
      ["Delete / Backspace", "Delete selection"],
      ["?", "Show these shortcuts"],
    ]
      .map(([k, v]) => `<div><span>${v}</span><kbd>${k}</kbd></div>`)
      .join(
        "",
      )}</div><p class="dialog-copy">Keyboard-only? Use Board objects to select an object. Tool shortcuts add objects in the center of your view.</p>`,
    (d) => {
      const input = d.querySelector("#character-shortcuts");
      input.checked = characterShortcuts;
      input.onchange = () => {
        characterShortcuts = input.checked;
        try {
          localStorage.setItem(
            "whiteboard-character-shortcuts",
            String(characterShortcuts),
          );
        } catch {}
      };
    },
  );
}
function openContentLanguage() {
  const root = document.querySelector("#content-language-controls");
  const trigger = document.querySelector("#content-language-options");
  const board = current;
  const i = primarySelected();
  if (!root || !i || !canEditSelection(new Set([i.id]))) return;
  const close = () => {
    root.hidden = true;
    root.replaceChildren();
    trigger.setAttribute("aria-expanded", "false");
    document.querySelector("#content-language-options")?.focus();
  };
  if (!root.hidden) return close();
  const input = editing?.item.id === i.id ? editing.input : null;
  const openedLanguage = i.lang;
  const openedText = input?.value;
  const openedRuns = input && JSON.stringify(input.textRuns);
  root.innerHTML = `<form><label class="field">${t("Apply to")}<select id="content-language-scope">${input ? `<option value="text">${t("Selected text or next typed text")}</option>` : ""}<option value="object">${t("Whole object")}</option></select></label><label class="field">${t("Language tag")}<input id="content-language-tag" maxlength="64" placeholder="fr-CA" aria-describedby="content-language-help content-language-error" autocomplete="off" spellcheck="false"></label><p id="content-language-help" class="dialog-copy">${t("Enter a language tag, such as en, fr-CA, or es. Leave empty to inherit the surrounding language.")}</p><p id="content-language-error" role="alert" hidden></p><div class="dialog-footer"><button id="content-language-cancel" class="secondary" type="button">${t("Cancel")}</button><button id="content-language-save" class="primary" type="submit">${t("Apply language")}</button></div></form>`;
  const tag = root.querySelector("#content-language-tag");
  const scope = root.querySelector("#content-language-scope");
  const sync = () => {
    const value = scope.value === "text" ? input.rangeStyle("lang") : i.lang;
    tag.value = value && value !== "mixed" ? value : "";
  };
  scope.onchange = sync;
  sync();
  root.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  root.querySelector("#content-language-cancel").onclick = close;
  root.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  root.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    const target = current?.items.find((item) => item.id === i.id);
    if (current !== board || !target || !selection.has(i.id))
      return toast("This object changed. Open it again to edit it.");
    if (!canEditSelection(new Set([i.id]))) return;
    const value = tag.value.trim();
    const languageTag = value ? canonicalLanguage(value) : null;
    if (value && !languageTag) {
      const error = root.querySelector("#content-language-error");
      error.hidden = false;
      error.textContent = t("Enter a valid language tag, such as en or fr-CA.");
      tag.focus();
      return;
    }
    if (scope.value === "text") {
      if (
        editing?.input !== input ||
        input.value !== openedText ||
        JSON.stringify(input.textRuns) !== openedRuns
      )
        return toast("This object changed. Open it again to edit it.");
      input.format("lang", languageTag);
    } else {
      if (target.lang !== openedLanguage)
        return toast("This object changed. Open it again to edit it.");
      if ((target.lang || null) !== languageTag)
        mutate(() => {
          if (languageTag) target.lang = languageTag;
          else delete target.lang;
        });
    }
    close();
  };
  tag.focus();
}
// A list of objects too long to show is cut short evenly: each frame is
// kept, with as many of the objects it holds as every frame can have, so
// the last frames' objects show as the first frames' do.
function shortList(listed, cap) {
  if (listed.length <= cap) return listed;
  const groups = [];
  let group = null;
  for (const i of listed)
    if (i.type === "frame") groups.push((group = { frame: i, held: [] }));
    else {
      if (!group || (group.frame && group.frame.id !== i.parentId))
        groups.push((group = { frame: null, held: [] }));
      group.held.push(i);
    }
  let left = cap - groups.filter((g) => g.frame).length,
    share = Infinity;
  const sizes = groups.map((g) => g.held.length).sort((a, b) => a - b);
  for (let n = 0; n < sizes.length; n++) {
    const even = Math.floor(Math.max(0, left) / (sizes.length - n));
    if (sizes[n] > even) {
      share = even;
      break;
    }
    left -= sizes[n];
  }
  return groups
    .flatMap((g) => [...(g.frame ? [g.frame] : []), ...g.held.slice(0, share)])
    .slice(0, cap);
}
function objectsDialog() {
  const board = current;
  modal(
    "Board objects",
    `<label class="search"><input id="object-search" aria-label="Search objects" placeholder="Search objects"></label><p class="dialog-copy">Select an object to move it with the arrow keys. Press Enter to edit.</p><label class="grid-snap-option"><input id="objects-multiple" type="checkbox">Select multiple objects</label><p class="dialog-copy">Turn on Select multiple objects, then click objects to add or remove them. Choose Done to use the selection.</p><p id="objects-keys" class="dialog-copy">Arrow keys, Home and End move between objects. Page Down and Page Up move to the next or previous frame.</p><p id="objects-selection-status" role="status" hidden></p><div class="object-list" role="group" aria-label="Board objects" aria-describedby="objects-keys"></div><div class="dialog-footer" id="objects-selection-footer" hidden><button id="objects-done" class="primary">Done</button></div>`,
    (d) => {
      const multiple = d.querySelector("#objects-multiple");
      const finish = () => {
        d.close();
        if (selection.size)
          focusRegion(
            bounds(visibleItems().filter((i) => selection.has(i.id))),
          );
        draw();
        document.querySelector("#canvas").focus();
      };
      const states = () => {
        d.querySelector("#objects-selection-footer").hidden = !multiple.checked;
        const status = d.querySelector("#objects-selection-status");
        status.hidden = !multiple.checked;
        status.textContent = t(`${selection.size} selected`);
        for (const button of d.querySelectorAll("[data-object]")) {
          if (multiple.checked)
            button.setAttribute(
              "aria-pressed",
              String(selection.has(button.dataset.object)),
            );
          else button.removeAttribute("aria-pressed");
        }
      };
      // The list is one Tab stop, which the arrow keys move.
      const objects = d.querySelector(".object-list");
      let stop = null;
      objects.addEventListener("keydown", (e) =>
        rovingKeys(e, objects.querySelectorAll("[data-object]")),
      );
      objects.addEventListener("focusin", (e) => {
        const id = e.target.dataset?.object;
        if (!id || id === stop) return;
        objects
          .querySelector('[data-object][tabindex="0"]')
          ?.setAttribute("tabindex", "-1");
        e.target.tabIndex = 0;
        stop = id;
      });
      // Relationships are worked out once per board state, not per keystroke.
      let related = null;
      const render = () => {
        // The board as this person sees it: hidden objects are left out and
        // others' private notes stay face down.
        const query = fold(d.querySelector("input").value),
          items = facilitation.masked(current).items;
        if (related?.items !== items)
          related = {
            items,
            ordered: outlineOrder(items),
            map: objectRelationships(items),
          };
        // Each frame is listed with what it holds, as in the outline, and a
        // frame found by its name brings what it holds with it.
        const relationships = related.map,
          found = new Set(),
          matches = related.ordered.filter((i) => {
            const named = fold(objectName(i)).includes(query);
            if (named && query && i.type === "frame") found.add(i.id);
            return named || found.has(i.parentId);
          }),
          // A long list is cut short: the search narrows it.
          list = shortList(matches, 300),
          listed = new Set(list.map((i) => i.id));
        if (!listed.has(stop))
          stop =
            [...selection].find((id) => listed.has(id)) ?? list[0]?.id ?? null;
        let frame = null;
        objects.innerHTML = list.length
          ? list
              .map((i, n) => {
                const relationship = objectDescription(
                  i,
                  relationships.get(i.id),
                );
                const description = `objects-relationship-${n}`;
                if (i.type === "frame") frame = i.id;
                // What a frame holds is set in under it.
                const place =
                  i.type === "frame"
                    ? " data-frame"
                    : i.parentId && i.parentId === frame
                      ? " data-in-frame"
                      : "";
                return `<button data-object="${escape(i.id)}" tabindex="${i.id === stop ? 0 : -1}"${place} ${multiple.checked ? `aria-pressed="${selection.has(i.id)}"` : ""}${relationship ? ` aria-describedby="${description}"` : ""}><span data-user-content>${objectNameHTML(i)}</span></button>${relationship ? `<span class="sr-only" id="${description}">${relationship}</span>` : ""}`;
              })
              .join("") +
            (matches.length > list.length
              ? `<p class="dialog-copy">${t(
                  frame
                    ? "Showing {shown} of {total} matching objects. Search for a frame's name to list everything it holds, or search to narrow the list."
                    : "Showing the first {shown} of {total} matching objects. Search to narrow the list.",
                )
                  .replace("{shown}", list.length)
                  .replace("{total}", matches.length)}</p>`
              : "")
          : `<p>${t("No matching objects.")}</p>`;
        d.querySelectorAll("[data-object]").forEach(
          (btn) =>
            (btn.onclick = () => {
              const i = current.items.find((i) => i.id === btn.dataset.object);
              if (
                current !== board ||
                !i ||
                facilitation.concealedIds().has(i.id)
              )
                return toast("This object changed. Open it again to edit it.");
              if (!multiple.checked) {
                selectItems(new Set([i.id]));
                return finish();
              }
              const concealed = facilitation.concealedIds();
              const chosen = new Set(
                [...selection].filter(
                  (id) =>
                    current.items.some((i) => i.id === id) &&
                    !concealed.has(id),
                ),
              );
              if (chosen.has(i.id))
                descendants(current.items, new Set([i.id])).forEach((id) =>
                  chosen.delete(id),
                );
              else chosen.add(i.id);
              selectItems(chosen);
              draw();
              states();
            }),
        );
        states();
      };
      render();
      d.querySelector("#object-search").oninput = render;
      multiple.onchange = render;
      d.querySelector("#objects-done").onclick = finish;
    },
  );
}
function duplicate(direction) {
  if (!selection.size) return;
  if (isSharedReadOnly()) return toast("This board is read-only.");
  // A copy would show hidden content to everyone.
  const hidden = facilitation.concealedIds();
  if ([...selection].some((id) => hidden.has(id)))
    return toast("Hidden objects cannot be copied.");
  pointerUp();
  try {
    const plan = planDuplication(current.items, selection, {
      ...selectionOptions(),
      hidden,
      direction,
    });
    if (!plan.copies.length) return;
    mutate(() => {
      current.items.push(...plan.copies);
      selection = plan.selection;
      focusedGroup = null;
      selectionAnchor = plan.idMap.get(selectionAnchor) || null;
      placeDuplicates(current.items, selection, facilitation.concealedIds());
    });
  } catch (error) {
    toast(error.message);
  }
}
// Undo and redo on a shared board change the shared document directly, not
// through the editor's save, so the facilitator's lock is checked here. A
// step the lock refuses is put back, keeping the rest of the history.
function sharedStep(step) {
  formatRequests++;
  const session = collaboration;
  // An edit still on its way into the shared document, as while its images
  // are stored, is the newest step: undoing before it lands would undo the
  // one before it. The step waits its turn behind it.
  if (collaborationPendingEdits) {
    collaborationEdits = collaborationEdits.then(() => {
      if (collaboration === session) sharedStep(step);
    });
    return;
  }
  if (session.readOnly || session.contentReadOnly) return;
  const { shared } = session,
    manager = shared.undo;
  if (!(step === "undo" ? manager.canUndo() : manager.canRedo())) return;
  // Every step changes content, which a frozen board refuses; the shared
  // document is left untouched so the step waits for the board to open.
  const frozen = facilitation.frozen();
  if (frozen) return toast(frozen);
  const before = facilitation.restricts() ? shared.snapshot() : null;
  // Tried on a copy first: undoing and redoing a refused step would still
  // save its writes, which the worker refuses as they could overwrite a
  // facilitator's concurrent changes.
  if (before) {
    const stack = step === "undo" ? "undoStack" : "redoStack",
      // Keeping deleted content, which the step may bring back.
      trial = new SharedDocument(shared.update(), { gc: false });
    let reason;
    try {
      trial.undo[stack].push(manager[stack].at(-1));
      trial.undo[step]();
      reason = facilitation.refusal(before, trial.snapshot());
    } finally {
      trial.destroy();
    }
    if (reason) return toast(reason);
  }
  manager[step]();
  const reason = before && facilitation.refusal(before, shared.snapshot());
  if (reason) {
    manager[step === "undo" ? "redo" : "undo"]();
    return toast(reason);
  }
  session.publish().catch((e) => toast(e.message));
}
// Buttons over the board that open a panel or a dialog, change a setting
// or edit content are not navigation: following goes on through them.
// What moves the view, such as zooming or opening a discussion, stops it
// where it moves it.
const FOLLOWED_ACTIONS = new Set([
  "participants",
  "commands",
  "more-tools",
  "timer",
  "comments",
  "add-comment",
  "toggle-comment-pins",
  "tags",
  "toggle-snapping",
  "toggle-authors",
  "objects",
  "templates",
  "shapes",
  "undo",
  "redo",
  "lock",
  "delete",
  "properties",
  "share",
  "export",
  "cloud-save",
  "help",
  "ai",
  "facilitation",
]);
async function action(a) {
  if (!FOLLOWED_ACTIONS.has(a)) attention.stop();
  if (a !== "tags") tags.close();
  if (!planning.actions[a]) planning.close();
  if (!["object-link", "copy-object-link"].includes(a)) objectLinks.close();
  canvasNavigation.finish();
  minimap.cancel();
  imageCrop.close(false);
  imageReplacement.close();
  if (a === "cancel-text") return finishTextEdit(false, true);
  if (a === "finish-text") return finishTextEdit(true, true);
  if (a !== "toggle-snapping") pointerUp();
  finishTextEdit();
  if (features.actions[a]) return features.actions[a]();
  if (planning.actions[a]) return planning.actions[a]();
  if (a.startsWith("tool-")) return setTool(a.slice(5));
  switch (a) {
    case "toggle-authors":
      showAuthors = !showAuthors;
      try {
        localStorage.setItem("whiteboard-show-authors", String(showAuthors));
      } catch {}
      if (document.querySelector("#show-authors"))
        document.querySelector("#show-authors").checked = showAuthors;
      toast(
        showAuthors
          ? "Sticky notes show who added them."
          : "Sticky note authors hidden.",
      );
      draw();
      return;
    case "toggle-snapping":
      snapping = !snapping;
      try {
        localStorage.setItem("whiteboard-snapping", String(snapping));
      } catch {}
      document
        .querySelector('[data-action="toggle-snapping"]')
        .setAttribute("aria-pressed", String(snapping));
      if (drag?.pointer) pointerMove(drag.pointer);
      toast(
        snapping ? "Snapping on. Hold Alt/Option to bypass." : "Snapping off.",
      );
      draw();
      return;
    case "new":
      return newBoard();
    case "home":
      if (current) {
        clearTimeout(cloudTimer);
        if (cloudIds.has(current.id)) await sync(clone(current));
        flushNudgeSave();
        await saveChain;
      }
      return home({ push: true });
    case "help":
      return help();
    case "sign-in":
      return signInAccount();
    case "sign-out":
      return signOutAccount();
    case "cloud-save":
      return cloudSave();
    case "migrate-miro":
      return openMigration();
    case "org-library":
      return organizationLibrary.open();
    case "notifications":
      return organizationHome.notifications();
    case "org-library-share":
      return organizationLibrary.share();
    case "ai":
      return ai.open();
    case "hide-objects":
    case "show-objects":
      return facilitation.setHidden([...selection], a === "hide-objects");
    case "alt-text":
      return altText.open(selectedLinkObject());
    case "help-center":
      return helpCenter.open();
    case "tour":
      return startTour();
    case "dismiss-tour":
      onboarding.dismiss();
      document.querySelector("#tour-offer")?.remove();
      return document.querySelector("#canvas")?.focus();
    case "import":
      return fileInput(".json", importBoard);
    case "image":
      return imageInput();
    case "crop-image":
      if (selection.size !== 1 || !canEditSelection()) return;
      return imageCrop.open(current.items.find((i) => selection.has(i.id)));
    case "add-note":
      return addObject("note");
    case "tags":
      return tags.open();
    case "comments":
      return comments.toggle();
    case "add-comment":
      return addComment();
    case "toggle-comment-pins":
      return comments.togglePins();
    case "board-search":
      // The toolbar button promises to expand and collapse the panel.
      if (boardSearch.isOpen()) return boardSearch.close();
      return openBoardSearch();
    case "objects":
      return objectsDialog();
    case "mind-child":
      return mindMap.add();
    case "mind-collapse":
      return toggleMindBranch();
    case "mind-sibling":
      return mindMap.add(true);
    case "mind-settings":
      return mindMap.settings();
    case "mind-layout":
      return mindMap.layout();
    case "mind-move":
      return mindMap.moveDialog();
    case "mind-earlier":
      return mindMap.reorder(-1);
    case "mind-later":
      return mindMap.reorder(1);
    case "table-cells": {
      const i = selectedLinkObject();
      if (i?.type === "table") return editObject(i);
      return;
    }
    case "object-link":
      return objectLinks.show();
    case "copy-object-link":
      return objectLinks.copy();
    case "text-link":
      return openTextLinkEditor();
    case "text-links": {
      const i =
        selection.size === 1 && current.items.find((i) => selection.has(i.id));
      if (i) textLinkPreview.show(i);
      return;
    }
    case "properties":
      return editObject(primarySelected(), true);
    case "enter-group":
      return enterGroup();
    case "exit-group":
      return exitGroup();
    case "edit":
      return editObject(primarySelected());
    case "duplicate":
      return duplicate();
    case "connection-endpoints":
      return connectionEndpoints(primarySelected());
    case "rotate":
      rotateSelectionDialog();
      break;
    case "resize":
      return resizeSelectionDialog();
    case "move-selection":
      return moveSelectionDialog();
    case "lock":
      return toggleLock();
    case "delete": {
      if (!canEditSelection(selection, { deleting: true })) return;
      if (!selection.size) return;
      const chosen = current.items.filter((i) => selection.has(i.id)),
        before = current.items.length;
      mutate(() => {
        current.items = removeItems(
          current.items,
          selection,
          selectionOptions(),
        );
        selection.clear();
      });
      if (current.items.length < before)
        announce(
          chosen.length === 1
            ? labelled(t("Deleted"), objectName(chosen[0]))
            : plural(
                chosen.length,
                "{count} object deleted",
                "{count} objects deleted",
              ),
        );
      return;
    }
    case "front":
    case "back":
    case "forward":
    case "backward": {
      if (!canEditSelection()) return;
      const next = reorderItems(
        current.items,
        selection,
        a,
        selectionOptions(),
      );
      if (next !== current.items) mutate(() => (current.items = next));
      return;
    }
    case "share":
      return shareBoard();
    case "join-shared":
      return joinDialog();
    case "participants":
      return participantsDialog();
    case "live":
      return liveUI.toggle();
    case "undo":
      if (collaboration) return sharedStep("undo");
      // Key repeat must not replace recovery versions with unchanged copies.
      if (isSharedReadOnly()) return toast("This board is read-only.");
      if (!history.past.length) return;
      checkpoint();
      restoreUndoState(history.undo(undoStateFor(history.past.at(-1))));
      selection.clear();
      draw();
      save({ outlined: true });
      return;
    case "redo":
      if (collaboration) return sharedStep("redo");
      if (isSharedReadOnly()) return toast("This board is read-only.");
      if (!history.future.length) return;
      checkpoint();
      restoreUndoState(history.redo(undoStateFor(history.future.at(-1))));
      selection.clear();
      draw();
      save({ outlined: true });
      return;
    case "minimap":
      return minimap.toggle();
    case "fit":
    case "zoom-selection":
    case "zoom-in":
    case "zoom-out":
    case "reset-zoom":
      return changeView(a);
  }
}
function changeView(a) {
  if (a === "fit") return fit();
  if (a === "zoom-selection") {
    if (selection.size)
      focusRegion(bounds(visibleItems().filter((i) => selection.has(i.id))));
    return;
  }
  const r = document.querySelector("#canvas").getBoundingClientRect();
  view = zoomAt(
    view,
    { x: r.width / 2, y: r.height / 2 },
    a === "reset-zoom" ? 1 : zoomStep(view.z, a === "zoom-in"),
  );
  draw();
}
// A zoom or fit key pressed during a drag changes the view under it, as the
// wheel does, and the drag goes on from the pointer's place on the new view.
function viewShortcut(a) {
  if (!drag?.pointer) return action(a);
  attention.stop();
  changeView(a);
  pointerMove(drag.pointer);
  draw();
}
function bindShared() {
  document.querySelector("#language").onchange = async (e) => {
    setLanguage(e.target.value);
    if (current) editor();
    else await home();
    // The page is drawn again in the new language; the keyboard stays on
    // the language control, in the editor's Preferences popover if there.
    const select = document.querySelector("#language");
    const popover = select?.closest("details.preferences");
    if (popover) popover.open = true;
    select?.focus();
  };
  // The Preferences popover closes when the pointer or the focus leaves
  // it, and on Escape, which hands focus back to its button.
  const preferences = document.querySelector("details.preferences");
  if (preferences) {
    preferences.onkeydown = (e) => {
      if (e.key !== "Escape" || !preferences.open) return;
      e.preventDefault();
      e.stopPropagation();
      preferences.open = false;
      preferences.querySelector("summary").focus();
    };
    preferences.addEventListener("focusout", () => {
      setTimeout(() => {
        if (
          preferences.isConnected &&
          !preferences.contains(document.activeElement)
        )
          preferences.open = false;
      });
    });
  }
  document
    .querySelectorAll("[data-action]")
    .forEach((b) => (b.onclick = () => action(b.dataset.action)));
  const authors = document.querySelector("#show-authors");
  if (authors) authors.onchange = () => action("toggle-authors");
  document.querySelector("#theme").onchange = (e) => {
    theme = e.target.value;
    try {
      localStorage.setItem("whiteboard-theme", theme);
    } catch {}
    applyTheme();
    if (current) draw();
    else paintPreviews();
  };
}
// The Preferences popover closes on a press outside it. One listener
// serves every board opened, finding the popover of the moment.
document.addEventListener("pointerdown", (e) => {
  const preferences = document.querySelector("details.preferences");
  if (preferences?.open && !preferences.contains(e.target))
    preferences.open = false;
});
document.addEventListener("keydown", (e) => {
  // Keyboard use shows the focus ring a click had hidden.
  keyboardFocus(document.querySelector("#canvas"));
  keyboardFocus(document.querySelector("#minimap-canvas"));
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  if (commandPalette.keydown(e)) return;
  // Ctrl/Cmd+S saves the board wherever on it the keyboard is, as in other
  // editors, Find on board included, so typing in a note, a search or the
  // board's name never opens the browser's Save Page dialog. What is being
  // typed is kept first.
  if (
    current &&
    (e.metaKey || e.ctrlKey) &&
    shortcutLetter(e) === "s" &&
    !document.querySelector("dialog[open]")
  ) {
    e.preventDefault();
    if (editing || tableEditor.isOpen()) finishTextEdit(true, true);
    const title = document.querySelector("#board-title");
    if (e.target === title && title.value !== current.title)
      title.dispatchEvent(new Event("change"));
    pointerUp();
    cloudSave();
    return;
  }
  if (!document.querySelector("dialog[open]") && boardSearch.keydown(e)) return;
  if (
    document.querySelector("dialog[open]") ||
    e.target.closest("input,textarea,select,[contenteditable],#context-menu")
  )
    return;
  // Board shortcuts would act on the board hidden behind a followed
  // presenter's slide. Escape stops following, as the banner's button does.
  if (attention.showingSlide()) {
    if (e.key === "Escape") {
      e.preventDefault();
      attention.stop();
    }
    return;
  }
  // Keys on a control of an open text or table editor, as after a click
  // left the focus on a toolbar button, edit nothing there: a letter must
  // not run a tool shortcut and Backspace must not delete the object being
  // edited. Escape still leaves the edit.
  if (
    e.key !== "Escape" &&
    (editing || tableEditor.isOpen()) &&
    e.target.closest("#selection-tools,#table-editor")
  )
    return;
  if (e.key === "Escape" && drag?.kind === "table-cells") {
    e.preventDefault();
    canvasNavigation.cancel();
    cancelTransform();
    return;
  }
  // A colour or text style popover opened with the mouse leaves focus on
  // its button or the board, so Escape there closes it before it reaches
  // the selection. Focus returns to the button only from the toolbar.
  const selectionTools = document.querySelector("#selection-tools");
  if (
    e.key === "Escape" &&
    selectionTools?.querySelector(".selection-popover:not([hidden])")
  ) {
    e.preventDefault();
    closeSelectionPopover(selectionTools, selectionTools.contains(e.target));
    return;
  }
  if (tableEditor.keydown(e)) return;
  // Shift still produces character-only shortcuts such as N and ?.
  // Component-local typing (e.g. native selects) is handled before here.
  if (
    !characterShortcuts &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    e.key.length === 1 &&
    e.key !== " "
  )
    return;
  if (!current) {
    if (e.key === "?") help();
    return;
  }
  if (
    (e.key === "ContextMenu" ||
      (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.metaKey)) &&
    e.target.id === "canvas"
  ) {
    e.preventDefault();
    openContextMenu(null, true);
    return;
  }
  if (!drag && mindMap.keydown(e)) return;
  if (
    ["Control", "Meta"].includes(e.key) &&
    (drag?.mind || drag?.gridStep) &&
    drag.pointer
  ) {
    e.preventDefault();
    pointerMove({ ...drag.pointer, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
    return;
  }
  if (e.key === "Alt" && drag?.pointer) {
    e.preventDefault();
    pointerMove({ ...drag.pointer, altKey: true });
    return;
  }
  if (
    e.key === "Shift" &&
    [
      "resize",
      "rotate",
      "endpoint",
      "arrow",
      "marquee",
      "create",
      "move",
    ].includes(drag?.kind) &&
    drag.pointer
  ) {
    e.preventDefault();
    pointerMove({ ...drag.pointer, shiftKey: true });
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (
    mod &&
    e.altKey &&
    e.shiftKey &&
    ["KeyC", "KeyK", "KeyH"].includes(e.code || `Key${e.key.toUpperCase()}`)
  ) {
    e.preventDefault();
    const key = e.code || `Key${e.key.toUpperCase()}`;
    if (!e.repeat)
      action(
        key === "KeyH"
          ? "history"
          : key === "KeyC" || shortcutLetter(e) === "c"
            ? "copy-object-link"
            : "object-link",
      );
    return;
  }
  if (!mod && !e.altKey && e.shiftKey && shortcutLetter(e) === "c") {
    e.preventDefault();
    if (!e.repeat) action("toggle-comment-pins");
    return;
  }
  if (
    mod &&
    e.altKey &&
    !e.shiftKey &&
    ["KeyC", "KeyV"].includes(e.code || `Key${e.key.toUpperCase()}`)
  ) {
    e.preventDefault();
    if (!e.repeat)
      action(
        e.code === "KeyC" || (!e.code && shortcutLetter(e) === "c")
          ? "copy-style"
          : "paste-style",
      );
    return;
  }
  if (mod && !e.shiftKey && optionKey(e, ["k"], ["KeyK"])) {
    e.preventDefault();
    openTextLinkEditor();
    return;
  }
  if (!mod && !e.altKey && !e.shiftKey && shortcutLetter(e) === "m") {
    e.preventDefault();
    if (!e.repeat) action("minimap");
    return;
  }
  if (mod && !e.altKey && ["+", "=", "-", "_", "0"].includes(e.key)) {
    e.preventDefault();
    viewShortcut(
      e.key === "0"
        ? "reset-zoom"
        : ["+", "="].includes(e.key)
          ? "zoom-in"
          : "zoom-out",
    );
    return;
  }
  if (
    e.altKey &&
    !mod &&
    !e.shiftKey &&
    ["Digit1", "Digit2"].includes(e.code)
  ) {
    e.preventDefault();
    viewShortcut(e.code === "Digit1" ? "fit" : "zoom-selection");
    return;
  }
  if (!mod && !e.altKey && !e.shiftKey && shortcutLetter(e) === "s") {
    e.preventDefault();
    if (!e.repeat) action("shapes");
    return;
  }
  if (!mod && !e.altKey && e.shiftKey && shortcutLetter(e) === "n") {
    e.preventDefault();
    if (!e.repeat) action("bulk-notes");
    return;
  }
  if (mod && e.shiftKey && !e.altKey && shortcutLetter(e) === "c") {
    e.preventDefault();
    if (!e.repeat) action("copy-image");
    return;
  }
  if (mod && !e.altKey && shortcutLetter(e) === "f") {
    e.preventDefault();
    // The shortcut always brings the search, as browsers' own does.
    openBoardSearch();
    return;
  }
  if (
    mod &&
    e.shiftKey &&
    optionKey(e, ["+", "=", "-", "_"], ["Equal", "Minus"])
  ) {
    e.preventDefault();
    const larger = /^[+=_-]$/.test(e.key)
      ? ["+", "="].includes(e.key)
      : e.code === "Equal";
    resizeBy(larger ? 1.1 : 1 / 1.1, e);
    return;
  }
  if (e.code === "Space") {
    if (e.target.closest("button,a,summary")) return;
    e.preventDefault();
    // A held key repeats; the board is drawn once for it.
    if (space) return;
    space = true;
    draw();
    return;
  }
  if (mod && ["b", "i", "u"].includes(shortcutLetter(e))) {
    e.preventDefault();
    formatSelection(
      { b: "bold", i: "italic", u: "underline" }[shortcutLetter(e)],
    );
    return;
  }
  if (mod && !e.altKey && ["BracketLeft", "BracketRight"].includes(e.code)) {
    e.preventDefault();
    const forward = e.code === "BracketRight";
    action(
      e.shiftKey
        ? forward
          ? "front"
          : "back"
        : forward
          ? "forward"
          : "backward",
    );
    return;
  }
  // Page Up and Page Down bring the selection to the front or send it to
  // the back, as in Miro (Fn+Up and Fn+Down on a Mac keyboard).
  if (
    ["PageUp", "PageDown"].includes(e.key) &&
    !mod &&
    !e.altKey &&
    !e.shiftKey &&
    selection.size
  ) {
    e.preventDefault();
    if (!e.repeat) action(e.key === "PageUp" ? "front" : "back");
    return;
  }
  if (mod && e.shiftKey && shortcutLetter(e) === "l") {
    e.preventDefault();
    // A held key locks or unlocks once rather than flipping on each repeat.
    if (!e.repeat) action("lock");
    return;
  }
  if (
    mod &&
    e.shiftKey &&
    !e.altKey &&
    ["ArrowDown", "ArrowUp"].includes(e.key)
  ) {
    e.preventDefault();
    if (e.key === "ArrowUp") exitGroup();
    else enterGroup();
    return;
  }
  if (mod && shortcutLetter(e) === "g") {
    e.preventDefault();
    if (!canEditSelection()) return;
    // With nothing to group or ungroup, the history and redo stay as they
    // were and the reason is said, as in the command palette.
    if (
      e.shiftKey
        ? !current.items.some((i) => selection.has(i.id) && i.groupId)
        : descendants(current.items, selection, selectionOptions()).size < 2
    )
      return toast(
        e.shiftKey
          ? "Select a group first."
          : "Select at least two objects to group.",
      );
    if (
      !e.shiftKey &&
      isWholeGroup(current.items, selection, selectionOptions())
    )
      return toast("Already grouped.");
    mutate(() => {
      if (e.shiftKey) ungroup(current.items, selection);
      else {
        selection = group(current.items, selection, selectionOptions());
        focusedGroup = null;
      }
    });
    return;
  }
  if (mod && shortcutLetter(e) === "z") {
    e.preventDefault();
    action(e.shiftKey ? "redo" : "undo");
    return;
  }
  // Ctrl+Y redoes too, as on Windows and Linux and in the text editor.
  if (mod && !e.shiftKey && !e.altKey && shortcutLetter(e) === "y") {
    e.preventDefault();
    action("redo");
    return;
  }
  if (mod && shortcutLetter(e) === "a") {
    e.preventDefault();
    selectAll();
    return;
  }
  if (mod && shortcutLetter(e) === "d") {
    e.preventDefault();
    // A held key duplicates once rather than flooding the board with copies.
    if (!e.repeat) duplicate();
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && e.key === "Backspace") {
    e.preventDefault();
    if (!e.repeat) action("clear-content");
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    action("delete");
    return;
  }
  if (e.key === "Escape") {
    if (canvasNavigation.cancel()) {
      e.preventDefault();
      return;
    }
    if (
      drag &&
      ["move", "resize", "rotate", "endpoint", "arrow", "create"].includes(
        drag.kind,
      )
    ) {
      e.preventDefault();
      cancelTransform();
      return;
    }
    // The object link panel asks for a click on the board, so Escape on the
    // board closes it first; otherwise the next click would still pick a
    // destination for a selection that is already gone.
    if (objectLinks.isOpen()) {
      e.preventDefault();
      objectLinks.close(true);
      draw();
      return;
    }
    if (exitGroup()) {
      e.preventDefault();
      return;
    }
    // With nothing selected, Escape clears the export region.
    if (!selection.size && tool === "select" && clearExportRegion()) {
      e.preventDefault();
      return;
    }
    selection.clear();
    setTool("select");
    return;
  }
  if (e.key === "Enter") {
    if (e.target.closest("button,a,summary")) return;
    e.preventDefault();
    const id = e.target.closest("[data-id]")?.dataset.id;
    if (id) selectItems(new Set([id]));
    if (enterGroup(id)) return;
    editObject(primarySelected());
    return;
  }
  if (e.key.startsWith("Arrow") && selection.size) {
    e.preventDefault();
    if (e.altKey && !mod && !e.shiftKey) {
      if (!e.repeat && !drag) duplicate(e.key.slice(5).toLowerCase());
      return;
    }
    if (!canEditSelection()) return;
    // Connectors follow what they join, so a selection of only connectors
    // has nothing to move and leaves the undo history as it was.
    const reach = descendants(current.items, selection, selectionOptions());
    if (current.items.every((i) => !reach.has(i.id) || isConnector(i))) return;
    const delta = e.shiftKey ? 10 : 1;
    // Objects stop at the edge of the board rather than leave it.
    const dx =
        e.key === "ArrowRight" ? delta : e.key === "ArrowLeft" ? -delta : 0,
      dy = e.key === "ArrowDown" ? delta : e.key === "ArrowUp" ? -delta : 0;
    if (
      current.items.some(
        (i) =>
          reach.has(i.id) &&
          !isConnector(i) &&
          (Math.abs(i.x + dx) > BOARD_LIMIT ||
            Math.abs(i.y + dy) > BOARD_LIMIT),
      )
    )
      return;
    heldKeyChange(e, "move", () => {
      moveItems(current.items, selection, dx, dy, selectionOptions());
      // Like dragging, moving objects into or out of a frame updates which
      // frame they belong to (and so a task's Kanban status).
      inferMovedParents(current.items, selection, {
        skip: facilitation.concealedIds(),
      });
    });
    return;
  }
  if (
    e.key.startsWith("Arrow") &&
    e.target.id === "canvas" &&
    !mod &&
    !e.altKey
  ) {
    e.preventDefault();
    const step = e.shiftKey ? 160 : 40;
    view.x += e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
    view.y += e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
    draw();
    return;
  }
  if (!mod && !e.altKey) {
    // The tool letters are plain keys: Shift + N and Shift + C mean other
    // things, so Shift with any other letter means nothing rather than
    // the tool.
    // L is the connection line too, as in Miro.
    const letter = shortcutLetter(e) === "l" ? "a" : shortcutLetter(e);
    const t = !e.shiftKey && tools.find((t) => t[3].toLowerCase() === letter);
    if (t) {
      e.preventDefault();
      // A held key adds one object, not a stack of them on each repeat.
      if (e.repeat) return;
      if (["note", "text", "rect", "ellipse", "frame"].includes(t[0]))
        addObject(t[0]);
      else setTool(t[0]);
    }
    if (e.key === "?") help();
  }
});
document.addEventListener("keyup", (e) => {
  // A held key's changes are written once it is released.
  flushNudgeSave();
  if (
    ["Control", "Meta"].includes(e.key) &&
    (drag?.mind || drag?.gridStep) &&
    drag.pointer
  )
    pointerMove({ ...drag.pointer, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
  if (
    e.key === "Shift" &&
    [
      "resize",
      "rotate",
      "endpoint",
      "arrow",
      "marquee",
      "create",
      "move",
    ].includes(drag?.kind) &&
    drag.pointer
  )
    pointerMove({ ...drag.pointer, shiftKey: false });
  if (e.key === "Alt" && drag?.pointer)
    pointerMove({ ...drag.pointer, altKey: false });
  if (e.code === "Space") {
    space = false;
    if (current) draw();
  }
});
window.addEventListener("blur", () => {
  flushNudgeSave();
  comments.cancel();
  canvasNavigation.cancel();
  minimap.cancel();
  quickPorts.cancel();
  mindHandles.cancel();
  mindCollapse.cancel();
  tableEditor.cancelResize();
  space = false;
  pointerUp();
});
window.addEventListener("beforeunload", (e) => {
  flushNudgeSave();
  canvasNavigation.finish();
  pointerUp();
  finishTextEdit();
  if (
    pendingCloud.size ||
    unsavedLocal.size ||
    collaboration?.unsaved ||
    collaborationBusy ||
    collaborationPendingEdits ||
    unsentBoards.size
  ) {
    e.preventDefault();
    e.returnValue = "";
  }
});
try {
  // A record another version or a failed write left without objects would
  // fail every board in the library; it is left in the store and skipped.
  boards = (await local.list()).filter((b) => {
    const usable = b && typeof b.id === "string" && Array.isArray(b.items);
    if (!usable) console.warn("Skipping an unreadable board record", b?.id);
    return usable;
  });
  // A board the address names opens over the library, whose previews are
  // painted only once it is clear that the library shows.
  const arrival = boardDestination(location.href, location.href);
  await home({ keepAddress: true, previews: !arrival });
  account.refresh().catch(() => {});
  loadCloudIndex();
  // A shared board already on this device opens directly for a signed-in
  // account, as it does when the address changes while the page is open:
  // reloading it asks nothing. Otherwise, as for an invitation, the dialog's
  // button lets Puter's sign-in window open from a press.
  const known =
    arrival?.room &&
    !arrival.token &&
    window.puter?.auth?.isSignedIn?.() &&
    boards.some(
      (b) =>
        !b.deletedAt &&
        b.shared?.server === arrival.server &&
        b.shared?.room === arrival.room,
    );
  if (new URLSearchParams(location.hash.slice(1)).has("board") && !known)
    joinDialog(location.href);
  else if (readOrganizationLink(location.href))
    organizationHome.joinDialog(location.href);
  else await followBoardAddress(location.href);
  holdPreviews(false);
  reconnectOrganization().catch(() => {});
} catch (error) {
  console.error("Whiteboard initialization failed", error);
  app.innerHTML =
    '<main class="fatal"><h1>Your browser storage is unavailable.</h1><p>Enable site storage and reload to start creating safely.</p><button onclick="location.reload()">Reload</button></main>';
}

let addressQueue = Promise.resolve();
function addressChanged() {
  const requested = location.href,
    saved = window.history.state?.whiteboard;
  addressQueue = addressQueue
    .catch(() => {})
    .then(async () => {
      if (location.href !== requested) return;
      if (saved) {
        const target = boards.find(
          (b) => b.id === saved.boardId && !b.deletedAt,
        );
        if (!target) return;
        canvasNavigation.finish();
        pointerUp();
        finishTextEdit();
        flushNudgeSave();
        await saveChain;
        if (location.href !== requested) return;
        if (current !== target) {
          if (!current) closeDialogs();
          await openBoard(target, { keepAddress: true });
        }
        if (current !== target || location.href !== requested) return;
        objectLinks.close();
        comments.close(false);
        boardSearch.close(false);
        imageCrop.close(false);
        imageReplacement.close();
        view = { ...saved.view };
        selection = new Set(
          saved.selection.filter((id) => target.items.some((i) => i.id === id)),
        );
        selectionAnchor = selection.has(saved.anchor) ? saved.anchor : null;
        focusedGroup = saved.focusedGroup || null;
        draw();
      } else await followBoardAddress(requested);
    })
    .catch((e) => toast(e.message));
}
window.addEventListener("hashchange", addressChanged);
window.addEventListener("popstate", addressChanged);

window.addEventListener("resize", () => {
  // A window that changes size mid-gesture, as when a tablet turns or a
  // window snaps, ends the gesture where it is rather than undoing it.
  canvasNavigation.finish();
  attention.resize();
  onboarding.reposition();
  if (current) draw();
  else paintPreviews();
});
// Previews already painted with the loaded fonts are not painted again.
document.fonts?.ready.then(() => {
  refreshTextLayouts();
  if (current) draw();
  else paintPreviews();
});
document.fonts?.addEventListener("loadingdone", () => {
  refreshTextLayouts();
  if (current) draw();
  else paintPreviews();
});
