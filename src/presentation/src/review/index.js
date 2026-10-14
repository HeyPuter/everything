// The Review features: comments, proofing (spelling, thesaurus, AutoCorrect,
// translation, language), accessibility, compare, and the read-only mark.
// main.js gives this module an `env` with what it needs of the editor and
// calls the hooks it returns: mount (after the editor is built), the slide
// and thumbnail hooks, the status bar button, the keyboard handler, the
// edit guard, and the Review tab and Tools menu.
import "./review.css";
import { MOD_KEY, toast } from "../ui.js";
import { P, shapeLabel, visibleSlideShapes } from "../model.js";
import { createPaneHost } from "./pane.js";
import { createComments } from "./comments.js";
import { createSpelling } from "./spelling.js";
import { createThesaurus } from "./thesaurus.js";
import { createTranslate } from "./translate.js";
import { createAccessibility } from "./accessibility.js";
import { createCompare } from "./compare.js";
import { createFinal } from "./final.js";
import { attachAutoCorrect, autoCorrectDialog } from "./autocorrect.js";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createReview(base) {
  const host = createPaneHost({
    onChange: () => {
      comments?.syncStatus();
      base.syncToolbar();
      base.onPaneChange?.();
    },
  });
  const final = createFinal(base);
  // What the panes are given: the editor's surface plus the read-only lock
  // and the text helpers built here.
  const env = {
    ...base,
    blocksEdits: () => final.blocksEdits(),
    blockedEdit: () => final.blockedEdit(),
    shapeLabel: (shape) => shapeLabel(shape, base.pres()),
    selectedWord() {
      const editor = base.editor();
      const text = editor?.selectedText?.().trim() || "";
      if (text && !/\s/.test(text))
        return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (text) return text.split(/\s+/)[0];
      return "";
    },
    async insertText(value, { replacing } = {}) {
      const editor = base.editor();
      if (editor?.selectedText?.()) return editor.replaceSelection(value);
      const shape = base.currentShape();
      if (shape && replacing && !base.isTable(shape)) {
        const re = new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRe(replacing)}(?![\\p{L}\\p{N}])`,
          "gu",
        );
        if (!re.test(P.getShapeText(shape) || "")) return false;
        return base.mutateShape(shape, (s) =>
          base.replaceInShape(s, re, value, 0) ? undefined : base.SKIP,
        );
      }
      return false;
    },
    selectionTexts() {
      const editor = base.editor();
      const chosen = editor?.selectedText?.();
      if (chosen?.trim())
        return [{ kind: "editor", text: chosen, label: "Selection" }];
      if (!base.pres()) return [];
      const ids = new Set(base.selectionIds());
      return visibleSlideShapes(base.slide())
        .filter((s) => ids.has(P.getShapeId(s)) && !base.isTable(s))
        .map(textItem)
        .filter((i) => i.text.trim());
    },
    slideTexts() {
      if (!base.pres()) return [];
      return visibleSlideShapes(base.slide())
        .filter((s) => !base.isTable(s))
        .map(textItem)
        .filter((i) => i.text.trim());
    },
    async replaceTexts(items, language) {
      const editor = base.editor();
      const inEditor = items.find((i) => i.kind === "editor");
      if (inEditor) return editor?.replaceSelection(inEditor.text) ?? false;
      const part = base.pres() && P.getSlidePartName(base.slide());
      const target = P.getSlides(base.pres()).find(
        (s) => P.getSlidePartName(s) === items[0]?.part,
      );
      if (!target) return false;
      return base.mutateSlide(target, (slide) => {
        let changed = false;
        for (const item of items) {
          const shape = P.findShapeById(slide, item.id);
          if (!shape) continue;
          base.setText(shape, item.text);
          if (language) base.setLanguage(shape, language);
          changed = true;
        }
        if (!changed) return base.SKIP;
        void part;
      });
    },
  };
  function textItem(shape) {
    return {
      kind: "shape",
      part: P.getSlidePartName(P.getShapeSlide(shape)),
      id: P.getShapeId(shape),
      label: shapeLabel(shape, base.pres()),
      text: (() => {
        try {
          return P.getShapeText(shape) || "";
        } catch {
          return "";
        }
      })(),
    };
  }

  const comments = createComments(env, host);
  const spelling = createSpelling(env, host);
  const thesaurus = createThesaurus(env, host);
  const translate = createTranslate(env, host);
  const accessibility = createAccessibility(env, host);
  const compare = createCompare(env, host);

  // ---- Ribbon --------------------------------------------------------------

  function tab(api) {
    const one = () => api.selection().length === 1;
    return {
      id: "review",
      label: "Review",
      groups: [
        {
          id: "proofing",
          label: "Proofing",
          icon: "spelling",
          items: [
            {
              type: "large",
              id: "spelling",
              label: "Spelling",
              icon: "spelling",
              title: "Spelling (F7)",
              description:
                "Check the spelling of the text in the presentation.",
              pressed: () => host.isOpen("spelling"),
              run: () => spelling.open(),
            },
            {
              type: "large",
              id: "thesaurus",
              label: "Thesaurus",
              icon: "thesaurus",
              title: "Thesaurus (Shift+F7)",
              description: "Find other words for the selected word.",
              pressed: () => host.isOpen("thesaurus"),
              run: () => thesaurus.open(),
            },
          ],
        },
        {
          id: "accessibility",
          label: "Accessibility",
          icon: "accessibility",
          items: [
            {
              type: "large",
              id: "check-accessibility",
              label: "Check\nAccessibility",
              icon: "accessibility",
              title: "Check Accessibility",
              description:
                "Find content that people with disabilities might find hard to read.",
              split: true,
              pressed: () => host.isOpen("accessibility"),
              run: () => accessibility.open(),
              menu: () => [
                {
                  label: "Check Accessibility",
                  icon: "o:accessibility",
                  onSelect: () => accessibility.open(),
                },
                {
                  label: "Alt Text…",
                  icon: "o:altText",
                  disabled: !one(),
                  onSelect: () => base.altText(),
                },
                {
                  label: "Reading Order Pane",
                  icon: "o:readingOrder",
                  onSelect: () => accessibility.openReadingOrder(),
                },
              ],
              menuLabel: "Accessibility options",
            },
            {
              type: "large",
              id: "alt-text",
              label: "Alt\nText",
              icon: "altText",
              title: "Alt Text",
              description:
                "Describe the selected picture or object for people who use screen readers.",
              enabled: () => one(),
              run: () => base.altText(),
            },
          ],
        },
        {
          id: "language",
          label: "Language",
          icon: "language",
          items: [
            {
              type: "large",
              id: "translate",
              label: "Translate",
              icon: "translate",
              title: "Translate",
              description:
                "Translate the selected text or the slide into another language.",
              pressed: () => host.isOpen("translate"),
              run: () => translate.open(),
            },
            {
              type: "large",
              id: "language",
              label: "Language",
              icon: "language",
              title: "Language",
              description: "Choose the proofing language of the selected text.",
              menu: () => [
                ...base.languageItems(),
                { separator: true },
                {
                  label: "AutoCorrect Options…",
                  icon: "o:autoCorrect",
                  onSelect: () => autoCorrectDialog(),
                },
              ],
            },
          ],
        },
        {
          id: "review-comments",
          label: "Comments",
          icon: "newComment",
          items: [
            {
              type: "large",
              id: "new-comment",
              label: "New\nComment",
              icon: "newComment",
              title: `New Comment (${MOD_KEY}+Shift+M)`,
              description: "Add a comment about the selection or the slide.",
              run: () => comments.newComment(),
            },
            {
              type: "large",
              id: "delete-comment",
              label: "Delete",
              icon: "deleteComment",
              title: "Delete Comment",
              enabled: () => comments.canDelete(),
              menu: () => comments.deleteMenu(),
            },
            {
              type: "large",
              id: "previous-comment",
              label: "Previous",
              icon: "previousComment",
              title: "Previous Comment",
              enabled: () => comments.hasComments(),
              run: () => comments.step(-1),
            },
            {
              type: "large",
              id: "next-comment",
              label: "Next",
              icon: "nextComment",
              title: "Next Comment",
              enabled: () => comments.hasComments(),
              run: () => comments.step(1),
            },
            {
              type: "large",
              id: "show-comments",
              label: "Show\nComments",
              icon: "showComments",
              title: "Show Comments",
              description:
                "Open the Comments pane, and show or hide comment markers on the slides.",
              split: true,
              pressed: () => comments.isOpen(),
              run: () => comments.toggle(),
              menu: () => comments.showMenu(),
              menuLabel: "Show Comments options",
            },
          ],
        },
        {
          id: "compare",
          label: "Compare",
          icon: "compare",
          items: [
            {
              type: "large",
              id: "compare",
              label: "Compare",
              icon: "compare",
              title: "Compare",
              description:
                "Compare this presentation with another version and choose which changes to keep.",
              run: () => compare.start(),
            },
            {
              type: "stack",
              items: [
                {
                  type: "small",
                  id: "accept-all-changes",
                  label: "Accept All",
                  icon: "acceptChange",
                  visible: () => compare.active(),
                  run: () => compare.acceptAll(),
                },
                {
                  type: "toggle",
                  id: "revisions-pane",
                  label: "Revisions",
                  icon: "showComments",
                  visible: () => compare.active(),
                  pressed: () => host.isOpen("revisions"),
                  run: () => host.toggle("revisions"),
                },
                {
                  type: "small",
                  id: "end-review",
                  label: "End Review",
                  icon: "rejectChange",
                  visible: () => compare.active(),
                  run: () => compare.end(),
                },
              ],
            },
          ],
        },
        {
          id: "protect",
          label: "Protect",
          icon: "readOnly",
          items: [
            {
              type: "large",
              id: "always-read-only",
              label: "Always Open\nRead-Only",
              icon: "readOnly",
              title: "Always Open Read-Only",
              description:
                "Mark the presentation as final so it opens read-only, to discourage changes.",
              pressed: () => final.marked(),
              run: () => final.toggle(),
            },
          ],
        },
      ],
    };
  }

  // The Tools menu of the menu bar.
  function toolsMenu() {
    return [
      {
        label: "Spelling…",
        icon: "o:spelling",
        shortcut: "F7",
        onSelect: () => spelling.open(),
      },
      {
        label: "Thesaurus…",
        icon: "o:thesaurus",
        shortcut: "Shift+F7",
        onSelect: () => thesaurus.open(),
      },
      {
        label: "Translate…",
        icon: "o:translate",
        onSelect: () => translate.open(),
      },
      { label: "Language", icon: "o:language", items: base.languageItems() },
      {
        label: "AutoCorrect Options…",
        icon: "o:autoCorrect",
        onSelect: () => autoCorrectDialog(),
      },
      { separator: true },
      {
        label: "Check Accessibility",
        icon: "o:accessibility",
        onSelect: () => accessibility.open(),
      },
      {
        label: "Reading Order Pane",
        icon: "o:readingOrder",
        onSelect: () => accessibility.openReadingOrder(),
      },
      { separator: true },
      { label: "Compare…", icon: "o:compare", onSelect: () => compare.start() },
      {
        label: "Comments",
        icon: "o:showComments",
        checked: comments.isOpen(),
        onSelect: () => comments.toggle(),
      },
    ];
  }
  // Items for the File menu.
  function fileMenuItems() {
    return [
      { label: "Compare…", icon: "o:compare", onSelect: () => compare.start() },
      {
        label: "Mark as Final",
        icon: "Lock",
        checked: final.marked(),
        onSelect: () => final.toggle(),
      },
    ];
  }

  // F7, Shift+F7 and Ctrl/Cmd+Shift+M. Returns true when handled.
  function keydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "F7" && !mod && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) thesaurus.open();
      else {
        base.commitText?.();
        spelling.open();
      }
      return true;
    }
    if (mod && e.shiftKey && !e.altKey && e.code === "KeyM") {
      e.preventDefault();
      comments.newComment();
      return true;
    }
    // Thesaurus also on Ctrl+Alt+Cmd+R, as desktop editors on a Mac have it.
    if (e.metaKey && e.ctrlKey && e.altKey && e.code === "KeyR") {
      e.preventDefault();
      thesaurus.open();
      return true;
    }
    return false;
  }

  return {
    host,
    comments,
    spelling,
    thesaurus,
    translate,
    accessibility,
    compare,
    final,
    tab,
    toolsMenu,
    fileMenuItems,
    keydown,
    // After the editor is built.
    mount() {
      host.mount(document.querySelector(".editor-split"));
      final.mount();
      comments.invalidate();
      if (host.current()) host.refresh();
    },
    // After the slide area is drawn.
    afterRenderSlide() {
      comments.renderMarkers();
      if (host.current() && host.current() !== "spelling") host.refresh();
      comments.syncStatus();
    },
    decorateThumb: (thumb, slide) => comments.decorateThumb(thumb, slide),
    accessibilityStatus: () => accessibility.statusText(),
    blocksEdits: () => final.blocksEdits(),
    blockedEdit: () => final.blockedEdit(),
    attachEditor: (editor) => attachAutoCorrect(editor),
    newComment: () => comments.newComment(),
    openAccessibility: () => accessibility.open(),
    toast,
  };
}
