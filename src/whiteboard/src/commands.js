import { hasLocked } from "./locking.js";
import { canClearContent } from "./clear-content.js";
import {
  isConnector,
  isWholeGroup,
  layoutUnits,
  selectionGroupId,
} from "./scene.js";
import { resizeBounds, MAX_OBJECTS } from "./model.js";
import { rotationBox } from "./rotation.js";
import { canSwitchShape, SHAPES } from "./shapes.js";
import { canEditText, canAutoFitText, formatsText } from "./text.js";
import { canCopyStyle, canPasteStyle } from "./object-style.js";
import { FONT_FAMILIES } from "./fonts.js";
import { duplicateSourceIds } from "./duplication.js";
import { t } from "./i18n.js";
import { fold } from "./search-fold.js";

// Feature modules contribute board commands: provider({ board, selection,
// readOnly, add }) calls add() like the built-in entries below.
const providers = [];
export function addCommands(provider) {
  providers.push(provider);
}

const normalize = (value) =>
  fold(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Only metadata is indexed: opening/searching the palette never scans board text,
// decodes media, or changes selection/history.
export function commandEntries({
  board,
  selection = new Set(),
  anchor,
  focusedGroup,
  selectionOptions,
  readOnly = false,
  // Commenters cannot edit content but can still comment.
  commentReadOnly = readOnly,
  copiedStyle = null,
  undo = false,
  redo = false,
  boards = [],
  recent = [],
  // The frames of the open board this person may see, in presentation
  // order, to go to by name.
  frames = [],
  // Whether sticky notes on a shared board show who added them.
  authorsShown = false,
}) {
  const entries = [];
  const add = (
    id,
    label,
    category,
    keywords = "",
    shortcut = "",
    disabled = "",
  ) => {
    const title = t(label);
    entries.push({
      id,
      label: title,
      category: t(category),
      shortcut,
      disabled: t(disabled),
      name: normalize(title),
      search: normalize(
        `${title} ${label} ${t(category)} ${category} ${keywords}`,
      ),
    });
  };
  const edit = readOnly ? "This board is read-only." : "";
  if (board) {
    const items = board.items,
      chosen = items.filter((i) => selection.has(i.id));
    const locked = hasLocked(items, selection);
    const selected = chosen.length ? "" : "Select objects first.";
    const writable =
      edit ||
      selected ||
      (locked
        ? "Unlock protected objects before changing this selection."
        : "");
    const capacity =
      items.length >= MAX_OBJECTS
        ? "A board can contain at most 5,000 objects."
        : "";
    const create = edit || capacity;
    for (const [type, label, shortcut, aliases] of [
      [
        "note",
        "Sticky note",
        "N",
        "post it sticky memo note adhesive pense bete",
      ],
      ["text", "Text", "T", "write type texte"],
      ["rect", "Rectangle", "R", "square box carre"],
      ["ellipse", "Ellipse", "O", "circle oval cercle"],
      ["frame", "Frame", "F", "section cadre"],
    ])
      add(`add:${type}`, label, "Create", aliases, shortcut, create);
    // "note" means a sticky note, even though a library shape is named Note,
    // as "table" means Add table below.
    entries.find((e) => e.id === "add:note").claims = ["note"];
    add(
      "mind-map",
      "Mind map",
      "Create",
      "branches hierarchy ideas arbre carte mentale",
      "",
      create,
    );
    add("shapes", "Shapes", "Create", "flowchart diagram formes", "S", create);
    add(
      "bulk-notes",
      "Bulk sticky notes",
      "Create",
      "multiple notes ideas list idees",
      "Shift+N",
      create,
    );
    add("image", "Add image", "Create", "upload picture photo", "", create);
    add(
      "table",
      "Add table",
      "Create",
      "grid spreadsheet cells grille tableau",
      "",
      create,
    );
    entries.at(-1).claims = ["table"];
    add("link", "Add link", "Create", "url hyperlink lien", "", create);
    add(
      "text-link",
      "Insert or edit text link",
      "Edit",
      "url hyperlink inline selected words lien texte",
      "Ctrl/Cmd+Alt/Option+K",
      writable ||
        (chosen.length !== 1 || !canEditText(chosen[0])
          ? "Select one text object."
          : ""),
    );
    add(
      "file",
      "Attach file",
      "Create",
      "upload document pdf fichier",
      "",
      create,
    );
    // Embeds, Google Workspace, and document import (src/content/).
    const single = chosen.length === 1 ? chosen[0] : null;
    add(
      "import-document",
      "Import document",
      "Create",
      "pdf powerpoint pptx slides word docx excel xlsx csv markdown text extract paste importer",
      "",
      create,
    );
    add(
      "embed",
      "Embed content",
      "Create",
      "iframe live video youtube vimeo figma loom miro forms office google integrer integration",
      "",
      create,
    );
    add(
      "google-workspace",
      "Google Workspace",
      "Create",
      "google docs sheets slides forms drawings drive calendar agenda",
      "",
      create,
    );
    add(
      "google-sheet",
      "Import Google Sheet as table",
      "Create",
      "google sheets spreadsheet csv table tableau importer",
      "",
      create,
    );
    add(
      "refresh-sheet",
      "Refresh from Google Sheets",
      "Edit",
      "update sync reload google sheets table actualiser",
      "",
      edit ||
        (single?.type === "table" && single.sourceUrl
          ? ""
          : "Select a table imported from Google Sheets."),
    );
    add(
      "open-embed",
      "Open live embed",
      "View",
      "iframe live interactive open embed direct",
      "Enter",
      single?.type === "embed" ? "" : "Select an embed first.",
    );
    for (const [n, shape] of SHAPES.entries()) {
      if (["rectangle", "ellipse"].includes(shape.key)) continue;
      add(
        `shape:${shape.key}`,
        shape.name,
        "Create",
        `shape diagram flowchart ${shape.hint || ""}`,
        "",
        create,
      );
      // Library shapes such as Tablet frame come after familiar commands
      // that match a word like "table", unless named exactly.
      if (n >= 9) entries.at(-1).secondary = true;
    }
    add(
      "tool-arrow",
      "Arrow",
      "Create",
      "connection connector line fleche connexion",
      "A",
      create,
    );
    add(
      "tool-pen",
      "Draw",
      "Create",
      "pen pencil freehand dessin",
      "P",
      create,
    );
    add(
      "comments",
      "Comments",
      "Board",
      "discussion feedback threads commentaires avis",
    );
    add(
      "tags",
      "Tags",
      "Board",
      "sticky note tag label category etiquette classement",
    );
    const linkSource =
      chosen.find((i) => i.id === anchor) ||
      (chosen.length === 1 ? chosen[0] : null);
    if (
      linkSource?.mindMap &&
      items.some((i) => i.mindMap?.parent === linkSource.id)
    )
      add(
        "mind-collapse",
        linkSource.mindCollapsed ? "Expand branch" : "Collapse branch",
        "View",
        "mind map branch collapse expand carte mentale replier déplier",
      );
    for (const [id, label, shortcut] of [
      ["mind-child", "Add child node", "Tab"],
      ["mind-sibling", "Add sibling node", "Enter"],
      ["mind-settings", "Mind map controls", ""],
      ["mind-layout", "Layout nodes", ""],
      ["mind-move", "Move mind map branch", ""],
      ["mind-earlier", "Move branch earlier", ""],
      ["mind-later", "Move branch later", ""],
    ])
      add(
        id,
        label,
        "Edit",
        "mind map branch node carte mentale branche noeud",
        shortcut,
        writable ||
          (!linkSource?.mindMap ? "Select a mind map node first." : "") ||
          (["mind-child", "mind-sibling"].includes(id) ? capacity : ""),
      );
    add(
      "table-cells",
      "Table cells",
      "Edit",
      "grid spreadsheet cells rows columns tableau cellules",
      "",
      linkSource?.type === "table" ? "" : "Select one table first.",
    );
    add(
      "object-link",
      "Object link",
      "Edit",
      "link to website destination object lien objet",
      "Ctrl/Cmd+Alt/Option+Shift+K",
      linkSource ? "" : "Select one object first.",
    );
    add(
      "copy-object-link",
      "Copy link to object",
      "Share",
      "direct link deep link copy object lien objet",
      "Ctrl/Cmd+Alt/Option+Shift+C",
      linkSource ? "" : "Select one object first.",
    );
    add(
      "add-comment",
      "Add comment",
      "Create",
      "discussion feedback reply commentaire",
      "",
      commentReadOnly ? "This board is read-only." : "",
    );
    add(
      "toggle-comment-pins",
      "Show or hide comment pins",
      "View",
      "comments pins commentaires",
      "Shift+C",
    );
    add(
      "undo",
      "Undo",
      "Edit",
      "history annuler",
      "Ctrl/Cmd+Z",
      edit || (!undo ? "Nothing to undo." : ""),
    );
    add(
      "redo",
      "Redo",
      "Edit",
      "history retablir",
      "Ctrl/Cmd+Shift+Z",
      edit || (!redo ? "Nothing to redo." : ""),
    );
    add(
      "edit",
      "Edit selected object",
      "Edit",
      "text label modifier texte",
      "Enter",
      writable,
    );
    add(
      "properties",
      "Object properties",
      "Edit",
      "dimensions size style proprietes",
      "",
      writable,
    );
    const duplicateCount = chosen.length
      ? duplicateSourceIds(items, selection, selectionOptions).size
      : 0;
    add(
      "replace-image",
      "Replace image",
      "Edit",
      "swap photo picture upload remplacer image",
      "",
      writable ||
        (chosen.length !== 1 || chosen[0].type !== "image"
          ? "Select one image."
          : ""),
    );
    add(
      "crop-image",
      "Crop image",
      "Edit",
      "picture photo rectangle circle oval recadrer image",
      "",
      writable ||
        (chosen.length !== 1 || chosen[0].type !== "image"
          ? "Select one image."
          : ""),
    );
    add(
      "duplicate",
      "Duplicate selection",
      "Edit",
      "copy duplicate copier",
      "Ctrl/Cmd+D",
      edit ||
        selected ||
        (items.length + duplicateCount > MAX_OBJECTS
          ? "A board can contain at most 5,000 objects."
          : ""),
    );
    for (const [direction, label, arrow] of [
      ["left", "Duplicate left", "←"],
      ["right", "Duplicate right", "→"],
      ["up", "Duplicate above", "↑"],
      ["down", "Duplicate below", "↓"],
    ])
      add(
        `duplicate:${direction}`,
        label,
        "Edit",
        "copy repeat row column dupliquer",
        `Alt/Option+${arrow}`,
        edit ||
          selected ||
          (items.length + duplicateCount > MAX_OBJECTS
            ? "A board can contain at most 5,000 objects."
            : ""),
      );
    add(
      "copy-image",
      "Copy as image",
      "Edit",
      "png clipboard screenshot capture",
      "Ctrl/Cmd+Shift+C",
      selected,
    );
    add(
      "copy-style",
      "Copy style",
      "Edit",
      "format appearance paintbrush copier mise forme",
      "Ctrl/Cmd+Alt/Option+C",
      chosen.length === 1 && canCopyStyle(chosen[0])
        ? ""
        : "Select one object with a copyable style.",
    );
    add(
      "paste-style",
      "Paste style",
      "Edit",
      "format appearance paintbrush coller mise forme",
      "Ctrl/Cmd+Alt/Option+V",
      writable ||
        (!copiedStyle
          ? "Copy a style first."
          : !chosen.some((i) => canPasteStyle(i, copiedStyle))
            ? "The copied style does not apply to this selection."
            : ""),
    );
    add(
      "clear-content",
      "Clear content",
      "Edit",
      "empty reset text tags sticky shape effacer contenu vider",
      "Ctrl/Cmd+Backspace",
      writable ||
        (!chosen.some(canClearContent)
          ? "Select sticky notes or shapes to clear."
          : ""),
    );
    add(
      "change-shape",
      "Change shape",
      "Edit",
      "convert type transformer",
      "",
      writable ||
        (!chosen.every(canSwitchShape)
          ? "Select shapes, notes, or text boxes."
          : ""),
    );
    add(
      "move-selection",
      "Move selection",
      "Edit",
      "position distance horizontal vertical move deplacer distance",
      "",
      writable ||
        (!chosen.some((i) => !isConnector(i))
          ? "Select objects that can be moved."
          : ""),
    );
    add(
      "resize",
      "Resize selection",
      "Edit",
      "width height dimensions taille",
      "",
      writable ||
        (!resizeBounds(items, selection, anchor)
          ? "Select objects with a resizable area."
          : ""),
    );
    add(
      "rotate",
      "Rotate selection",
      "Edit",
      "angle rotation degrees tourner",
      "",
      writable ||
        (!rotationBox(items, selection)
          ? "Select shapes, text, images, cards, or drawings to rotate."
          : ""),
    );
    add(
      "lock",
      chosen.some((i) => i.locked) ? "Unlock selection" : "Lock selection",
      "Edit",
      "lock unlock protect verrouiller deverrouiller",
      "Ctrl/Cmd+Shift+L",
      edit || selected,
    );
    add(
      "unlock-all",
      "Unlock all objects",
      "Edit",
      "unlock protect deverrouiller",
      "",
      edit || (!items.some((i) => i.locked) ? "No locked objects." : ""),
    );
    for (const [key, label, shortcut] of [
      ["bold", "Bold", "Ctrl/Cmd+B"],
      ["italic", "Italic", "Ctrl/Cmd+I"],
      ["underline", "Underline", "Ctrl/Cmd+U"],
      ["strike", "Strikethrough", ""],
      ["autoFontSize", "Auto-fit text", ""],
      ["autoHeight", "Automatic text height", ""],
    ])
      add(
        `format:${key}`,
        label,
        "Edit",
        "text font typography texte police",
        shortcut,
        writable ||
          (!chosen.some(
            key === "autoFontSize"
              ? canAutoFitText
              : key === "autoHeight"
                ? (i) => i.type === "text"
                : ["bold", "italic"].includes(key)
                  ? formatsText
                  : canEditText,
          )
            ? "Select an object with editable text."
            : ""),
      );
    for (const family of FONT_FAMILIES)
      add(
        `font:${family.id}`,
        family.name,
        "Edit",
        `font family typography police ${family.id}`,
        "",
        writable ||
          (!chosen.some(formatsText)
            ? "Select an object with editable text."
            : ""),
      );
    add(
      "delete",
      "Delete selection",
      "Edit",
      "remove erase supprimer",
      "Delete",
      edit ||
        selected ||
        (hasLocked(items, selection, { deleting: true })
          ? "Unlock protected objects before changing this selection."
          : ""),
    );
    const units = chosen.length
      ? layoutUnits(items, selection, selectionOptions).length
      : 0;
    for (const [key, label] of [
      ["left", "Align left"],
      ["right", "Align right"],
      ["top", "Align top"],
      ["bottom", "Align bottom"],
      ["center", "Center horizontally"],
      ["middle", "Center vertically"],
      ["horizontal", "Distribute horizontally"],
      ["vertical", "Distribute vertically"],
    ]) {
      const count = ["horizontal", "vertical"].includes(key) ? 3 : 2;
      add(
        `arrange:${key}`,
        label,
        "Arrange",
        "align distribute spacing aligner repartir espacement",
        "",
        writable ||
          (units < count
            ? count === 3
              ? "Select at least three objects or groups."
              : "Select at least two objects or groups."
            : ""),
      );
    }
    for (const [key, label, shortcut] of [
      ["front", "Bring to front", "Ctrl/Cmd+Shift+]"],
      ["forward", "Bring forward", "Ctrl/Cmd+]"],
      ["backward", "Send backward", "Ctrl/Cmd+["],
      ["back", "Send to back", "Ctrl/Cmd+Shift+["],
    ])
      add(
        key,
        label,
        "Arrange",
        "layer order stack calque ordre",
        shortcut,
        writable,
      );
    const singleGroup = selectionGroupId(chosen);
    add(
      "enter-group",
      "Select object in group",
      "Selection",
      "inside group member individual",
      "Ctrl/Cmd+Shift+Down",
      focusedGroup || !singleGroup ? "Select a group first." : "",
    );
    add(
      "exit-group",
      "Select whole group",
      "Selection",
      "leave exit group",
      "Ctrl/Cmd+Shift+Up",
      focusedGroup ? "" : "Select an object inside a group first.",
    );
    add(
      "arrange:group",
      "Group selection",
      "Arrange",
      "group grouper",
      "Ctrl/Cmd+G",
      writable ||
        (chosen.length < 2
          ? "Select at least two objects to group."
          : isWholeGroup(items, selection, selectionOptions)
            ? "Already grouped."
            : ""),
    );
    add(
      "arrange:ungroup",
      "Ungroup selection",
      "Arrange",
      "ungroup degrouper",
      "Ctrl/Cmd+Shift+G",
      writable ||
        (!chosen.some((i) => i.groupId) ? "Select a group first." : ""),
    );
    add(
      "arrange:connect",
      "Connect selected objects",
      "Arrange",
      "arrow line connector connexion fleche",
      "",
      writable ||
        capacity ||
        (chosen.filter((i) => !["arrow", "pen", "frame"].includes(i.type))
          .length !== 2
          ? "Select exactly two objects to connect."
          : ""),
    );
    add(
      "arrange:frame",
      "Create frame around selection",
      "Arrange",
      "frame section cadre",
      "",
      writable || capacity,
    );
    add(
      "save-snippet",
      "Save as reusable content",
      "Arrange",
      "template reuse modele",
      "",
      selected,
    );
    add(
      "filter-selection",
      "Filter selection",
      "Arrange",
      "type sticky shape narrow filter filtrer",
      "",
      selected,
    );
    add(
      "organize",
      "Organize selection",
      "Arrange",
      "move into frame regrouper",
      "",
      writable,
    );
    add(
      "cluster",
      "Cluster sticky notes",
      "Arrange",
      "cluster color tag sticky note group regrouper couleur etiquette notes",
      "",
      writable ||
        (!chosen.some((i) => i.type === "note")
          ? "Select sticky notes first."
          : ""),
    );
    add(
      "board-search",
      "Find on board",
      "Navigate",
      "search find rechercher trouver",
      "Ctrl/Cmd+F",
    );
    add(
      "objects",
      "Board objects",
      "Navigate",
      "outline select objects liste objets",
    );
    add("frames", "Frames and navigation", "Navigate", "sections cadre");
    add(
      "grid",
      "Grid and snapping",
      "Navigate",
      "lines dots none snap grille points lignes aimant preferences",
    );
    add("timer", "Timer", "Board", "workshop countdown time minuteur atelier");
    add(
      "ai",
      "AI assistant",
      "Board",
      "ai summarize summary themes cluster handwriting photo ocr generate ideas ia résumer thèmes manuscrit générer",
    );
    add(
      "facilitation",
      "Facilitation",
      "Board",
      "workshop vote voting dot poll reactions private anonymous agenda lock freeze stage participants analytics summary atelier sondage réactions animation ordre du jour verrouiller",
    );
    add(
      "dimensions",
      "Object dimensions",
      "Navigate",
      "size width height match resize dimensions largeur hauteur taille",
    );
    add(
      "navigation",
      "Mouse, trackpad, and touch",
      "Navigate",
      "preferences settings wheel pinch pan gestures souris tactile pavé",
    );
    add(
      "selection-settings",
      "Selection settings",
      "Navigate",
      "precise marquee touched select selection coverage accessibility preferences",
    );
    add(
      "minimap",
      "Minimap",
      "Navigate",
      "map overview navigate carte apercu",
      "M",
    );
    add(
      "fit",
      "Fit board to screen",
      "Navigate",
      "zoom all overview tout afficher",
      "Alt/Option+1",
    );
    add(
      "zoom-selection",
      "Zoom to selection",
      "Navigate",
      "focus selected zoom",
      "Alt/Option+2",
      selected,
    );
    add("zoom-in", "Zoom in", "Navigate", "", "Ctrl/Cmd+Plus");
    add("zoom-out", "Zoom out", "Navigate", "", "Ctrl/Cmd+Minus");
    add(
      "reset-zoom",
      "Reset zoom to 100 percent",
      "Navigate",
      "actual size reset zoom",
      "Ctrl/Cmd+0",
    );
    add("tool-select", "Select", "Navigate", "cursor selection", "V");
    add("tool-hand", "Pan", "Navigate", "hand move deplacer", "H");
    add(
      "toggle-snapping",
      "Snap to objects",
      "Navigate",
      "guides magnet snapping aimant aligner",
    );
    if (board.shared)
      add(
        "toggle-authors",
        authorsShown ? "Hide sticky note authors" : "Show sticky note authors",
        "Board",
        "author contributor creator who added names auteur contributeur qui",
      );
    add(
      "present",
      "Presentation",
      "Board",
      "slides slideshow presenter diaporama",
    );
    add(
      "export",
      "Export board",
      "Board",
      "download png svg pdf json exporter telecharger",
    );
    add("region", "Select export region", "Board", "area crop region export");
    add(
      "exact-region",
      "Set export region",
      "Board",
      "area crop region export position width height without dragging",
    );
    add(
      "history",
      "Version history",
      "Board",
      "recovery restore versions restaurer",
      "Ctrl/Cmd+Alt/Option+Shift+H",
    );
    add(
      "share",
      "Share board",
      "Board",
      "invite collaboration partager inviter",
    );
    add(
      "cloud-save",
      "Save to Puter",
      "Board",
      "save backup cloud sauvegarder",
      "Ctrl/Cmd+S",
    );
    add(
      "home",
      "Back to boards",
      "Navigate",
      "home library accueil bibliotheque",
    );
    for (const provider of providers)
      provider({ board, selection, readOnly, add, edit, create, writable });
  }
  add("new", "New board", "Board", "create blank nouveau tableau");
  add(
    "templates",
    "Template library",
    "Board",
    "templates reusable modeles",
    "",
    board
      ? edit ||
          (board.items.length >= MAX_OBJECTS
            ? "A board can contain at most 5,000 objects."
            : "")
      : "",
  );
  if (board)
    for (const [id, title, words] of [
      [
        "components",
        "Components",
        "component library design system web wireframe kit composants systeme conception maquette",
      ],
      [
        "icons",
        "Icons and stickers",
        "icons pictograms stickers images library icones pictogrammes autocollants",
      ],
    ])
      add(
        id,
        title,
        "Create",
        words,
        "",
        edit ||
          (board.items.length >= MAX_OBJECTS
            ? "A board can contain at most 5,000 objects."
            : ""),
      );
  add(
    "join-shared",
    "Join shared board",
    "Board",
    "invite collaboration rejoindre",
  );
  add("cloud", "Cloud boards", "Board", "puter cloud nuage");
  add("import", "Import board file", "Board", "json import importer");
  add(
    "help",
    "Keyboard shortcuts",
    "Help",
    "help shortcuts commands aide raccourcis",
    "?",
  );
  if (board)
    add(
      "alt-text",
      "Alternative text",
      "Accessibility",
      "alt description screen reader image drawing accessibility texte de remplacement dessin lecteur d’écran",
      "",
      board.items.filter((i) => selection.has(i.id)).length === 1 &&
        ["image", "pen"].includes(
          board.items.find((i) => selection.has(i.id))?.type,
        )
        ? edit
        : "Select one image or drawing first.",
    );
  add(
    "help-center",
    "Help and training",
    "Help",
    "help guides training onboarding documentation aide guides formation",
  );
  add("tour", "Take the tour", "Help", "tour onboarding tips visite astuces");
  add(
    "migrate-miro",
    "Migrate from Miro",
    "Board",
    "miro migration import migrer importer",
  );
  const recentRank = new Map(recent.map((id, n) => [id, n]));
  const available = boards
    .filter((b) => !b.deletedAt && b.id !== board?.id)
    .sort(
      (a, b) =>
        (recentRank.get(a.id) ?? Infinity) -
          (recentRank.get(b.id) ?? Infinity) ||
        (b.updated || 0) - (a.updated || 0) ||
        a.id.localeCompare(b.id),
    );
  for (const b of available) {
    add(`board:${b.id}`, b.title, "Recent boards", "open board ouvrir tableau");
    const entry = entries.at(-1);
    // Authored titles are literal, including ones that match a translated command.
    entry.label = b.title;
    entry.name = normalize(b.title);
    entry.search = normalize(
      `${b.title} ${t("Recent boards")} open board ouvrir tableau`,
    );
    entry.boardId = b.id;
  }
  frames.forEach((f, n) => {
    const name = f.text || `${t("Frame")} ${n + 1}`;
    add(`frame:${f.id}`, "Go to frame", "Frames", "frame cadre go aller");
    const entry = entries.at(-1);
    // Authored titles are literal, as board names are.
    entry.label = name;
    entry.name = normalize(name);
    entry.search = normalize(
      `${name} ${t("Go to frame")} Go to frame ${t("Frames")} frames frame cadre`,
    );
    entry.frameId = f.id;
    // A command named alike comes first.
    entry.secondary = true;
  });
  return entries;
}

export function searchCommands(entries, query) {
  const needle = normalize(query),
    words = needle.split(" ").filter(Boolean);
  if (!words.length) {
    // Frames are listed last, after every command and board.
    const commands = entries.filter((e) => !e.boardId && !e.frameId);
    const boards = entries.filter((e) => e.boardId);
    const enabled = commands.filter((e) => !e.disabled);
    return [
      ...enabled.slice(0, 6),
      ...boards.slice(0, 5),
      ...enabled.slice(6),
      ...commands.filter((e) => e.disabled),
      ...boards.slice(5),
      ...entries.filter((e) => e.frameId),
    ];
  }
  const rank = (e) =>
    e.name === needle || e.claims?.includes(needle)
      ? 0
      : e.name.startsWith(needle)
        ? 1
        : words.every((w) => e.name.includes(w))
          ? 2
          : 3;
  return entries
    .filter((e) => words.every((w) => e.search.includes(w)))
    .sort((a, b) => {
      // An exact name wins; otherwise familiar commands come before
      // library shapes that match as well or better.
      const ra = rank(a),
        rb = rank(b);
      return (
        Number(rb === 0) - Number(ra === 0) ||
        Number(!!a.secondary) - Number(!!b.secondary) ||
        ra - rb ||
        Number(!!a.disabled) - Number(!!b.disabled)
      );
    });
}
