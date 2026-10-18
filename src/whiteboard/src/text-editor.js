import { shortcutLetter } from "./shortcut-keys.js";
import {
  textLinkURL,
  textLinkRange,
  linkColor,
  inkOn,
} from "./text-link-data.js";
import { textClipboardHTML } from "./text-clipboard.js";
import {
  listRows,
  paragraphAt,
  textParagraphs,
  selectedParagraphs,
  formatTextBlocks,
  indentTextBlocks,
  spliceTextBlocks,
  validateTextBlocks,
  listPlainText,
  readTextHTML,
} from "./text-blocks.js";
import {
  TEXT_STYLE_KEYS,
  textSegments,
  styleAt,
  textDifference,
  spliceTextRuns,
  replaceTextRuns,
  formatTextRuns,
  validateTextRuns,
  sliceTextRuns,
} from "./rich-text.js";

const LIMIT = 20000;
const MIME = "application/x-whiteboard-text";
function limit(value, length = LIMIT) {
  let result = value.slice(0, Math.max(0, length));
  if (
    /[\uD800-\uDBFF]$/.test(result) &&
    /[\uDC00-\uDFFF]/.test(value[result.length] || "")
  )
    result = result.slice(0, -1);
  return result;
}

// Native selection, spelling and IME stay in a contenteditable surface. The
// adapter exposes text/selection offsets to the shared-text binding. All DOM
// output is built from text nodes and validated, finite formatting properties.
export function createTextEditor(
  doc,
  item,
  {
    onSelection = () => {},
    history,
    plainTextOnly = false,
    maxLength = LIMIT,
    multiline = true,
    inheritLanguage = true,
    // The field's own weight and slant show through plain text, as a
    // table's do in its cells.
    inheritFontStyle = false,
  } = {},
) {
  const input = doc.createElement("div");
  input.dataset.userContent = "";
  input.contentEditable = "true";
  input.setAttribute("contenteditable", "true");
  input.setAttribute("role", "textbox");
  input.setAttribute("aria-multiline", String(multiline));
  const normalize = (text) => (multiline ? text : text.replace(/[\r\n]/g, "")),
    originalText = item.text || "";
  let value = originalText,
    runs = item.textRuns || [];
  // A single-line field drops each line break on its own, so the styles
  // and languages between two breaks stay with their words.
  if (!multiline)
    for (
      let at = value.search(/[\r\n]/);
      at >= 0;
      at = value.search(/[\r\n]/)
    ) {
      runs = spliceTextRuns(runs, at, at + 1, "");
      value = value.slice(0, at) + value.slice(at + 1);
    }
  let blocks = plainTextOnly ? [] : item.textBlocks || [],
    base = item,
    defaultColor = "#30342f";
  let remembered = { start: 0, end: value.length, direction: "forward" };
  let pending,
    composing = false,
    before,
    beforeType,
    undo = [],
    redo = [],
    lastEdit = 0,
    rebuilding = false,
    domCache,
    dragged,
    compositionInitial,
    renderVersion = 0,
    listMetricKey;
  const style = (overrides = {}) =>
    plainTextOnly
      ? {
          lang: overrides.lang || base.lang,
        }
      : {
          bold: base.bold ?? base.type === "frame",
          italic: !!base.italic,
          underline: !!base.underline,
          strike: !!base.strike,
          ...(base.textColor ? { textColor: base.textColor } : {}),
          ...(base.highlight ? { highlight: base.highlight } : {}),
          ...(base.lang ? { lang: base.lang } : {}),
          ...overrides,
        };
  function domText() {
    if (domCache) return domCache;
    let text = "",
      paragraph = false;
    const positions = new WeakMap();
    const visit = (node) => {
      if (node.nodeType === 3) {
        positions.set(node, text.length);
        text += node.data;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.hasAttribute("data-editor-tail")) {
        positions.set(node, [text.length]);
        return;
      }
      if (node.tagName === "BR") {
        positions.set(node, [text.length]);
        // The editor writes line breaks as text; a <br> is the browser's,
        // and one ending a block is the placeholder Chrome leaves when a
        // native deletion empties it, not a line.
        if (node.nextSibling) text += "\n";
        return;
      }
      if (node.hasAttribute("data-paragraph")) {
        if (paragraph) text += "\n";
        paragraph = true;
      }
      const block =
        node !== input &&
        !node.hasAttribute("data-paragraph") &&
        !node.hasAttribute("data-list-group") &&
        ["DIV", "P"].includes(node.tagName);
      if (block && text && !text.endsWith("\n")) text += "\n";
      const offsets = [text.length];
      for (const child of node.childNodes) {
        visit(child);
        offsets.push(text.length);
      }
      positions.set(node, offsets);
    };
    visit(input);
    return (domCache = { text, positions });
  }
  function selection() {
    const sel = doc.getSelection();
    if (
      sel?.anchorNode &&
      input.contains(sel.anchorNode) &&
      input.contains(sel.focusNode)
    ) {
      const { positions } = domText();
      const offset = (node, n) => {
        const position = positions.get(node);
        return Math.min(
          value.length,
          Math.max(
            0,
            typeof position === "number"
              ? position + n
              : (position?.[n] ?? value.length),
          ),
        );
      };
      const a = offset(sel.anchorNode, sel.anchorOffset),
        b = offset(sel.focusNode, sel.focusOffset);
      remembered = {
        start: Math.min(a, b),
        end: Math.max(a, b),
        direction: a > b ? "backward" : "forward",
      };
    }
    return remembered;
  }
  function setSelection(
    start,
    end = start,
    direction = "forward",
    focus = false,
  ) {
    start = Math.max(0, Math.min(value.length, start));
    end = Math.max(start, Math.min(value.length, end));
    remembered = { start, end, direction };
    if (!input.isConnected) return;
    if (focus) input.focus({ preventScroll: true });
    const { positions } = domText();
    const nodes = [],
      walk = doc.createTreeWalker(input, 4);
    while (walk.nextNode())
      if (typeof positions.get(walk.currentNode) === "number")
        nodes.push(walk.currentNode);
    const point = (at) => {
      for (const node of nodes) {
        const from = positions.get(node);
        if (at >= from && at <= from + node.length) return [node, at - from];
      }
      for (const row of input.querySelectorAll("[data-paragraph]")) {
        if (positions.get(row)?.[0] === at) {
          const tail = row.querySelector("[data-editor-tail]");
          return tail
            ? [tail.parentNode, [...tail.parentNode.childNodes].indexOf(tail)]
            : [row, row.childNodes.length];
        }
      }
      return [input, 0];
    };
    const a = point(start),
      b = point(end),
      sel = doc.getSelection();
    if (direction === "backward") sel.setBaseAndExtent(...b, ...a);
    else sel.setBaseAndExtent(...a, ...b);
  }
  function render() {
    if (composing) return;
    rebuilding = true;
    const active = doc.activeElement === input;
    const saved = { ...remembered };
    const fragment = doc.createDocumentFragment();
    const appendText = (parent, text, formatting) => {
      for (const part of textSegments(text, formatting)) {
        const span = doc.createElement(
            !plainTextOnly && part.style.link ? "a" : "span",
          ),
          s = style(part.style);
        if (s.link) {
          span.href = textLinkURL(s.link);
          span.dataset.textLink = "";
          span.target = "_blank";
          span.rel = "noopener noreferrer";
          span.tabIndex = -1;
        }
        if (!inheritFontStyle) {
          span.style.fontWeight = s.bold ? "600" : "400";
          span.style.fontStyle = s.italic ? "italic" : "normal";
        }
        span.style.textDecoration =
          [(s.underline || s.link) && "underline", s.strike && "line-through"]
            .filter(Boolean)
            .join(" ") || "none";
        // As on the canvas, text in the theme's ink over a highlight takes
        // the ink the highlight's lightness asks for.
        const ink =
          s.highlight && !s.textColor
            ? inkOn(s.highlight, defaultColor)
            : defaultColor;
        if (s.textColor !== undefined || s.link || s.highlight)
          span.style.color = s.textColor || (s.link ? linkColor(ink) : ink);
        if (s.highlight) span.style.backgroundColor = s.highlight;
        if (s.lang) span.lang = s.lang;
        span.textContent = part.text;
        parent.append(span);
      }

      if (!text || text.endsWith("\n") || text.endsWith("\u2028")) {
        const tail = doc.createElement("br");
        tail.setAttribute("data-editor-tail", "");
        parent.append(tail);
      }
    };
    if (!blocks.length) appendText(fragment, value, runs);
    else {
      let group;
      for (const row of listRows(value, blocks)) {
        const paragraph = doc.createElement("div");
        paragraph.setAttribute("data-paragraph", "");
        paragraph.style.minHeight = "1.35em";
        if (row.list) {
          if (!group) {
            group = doc.createElement("div");
            group.setAttribute("role", "list");
            group.setAttribute("data-list-group", "");
            fragment.append(group);
          }
          paragraph.setAttribute("role", "listitem");
          paragraph.setAttribute("aria-level", String(row.indent + 1));
          paragraph.dataset.indent = row.indent;
          paragraph.style.position = "relative";
          paragraph.style.marginLeft = `${(row.indent + 1) * 1.5}em`;
          paragraph.dataset.listMarker = row.marker;
          group.append(paragraph);
        } else {
          group = null;
          fragment.append(paragraph);
        }
        appendText(
          paragraph,
          row.text,
          sliceTextRuns(runs, row.start, row.end),
        );
      }
    }
    input.replaceChildren(fragment);
    renderVersion++;
    domCache = undefined;
    if (active) setSelection(saved.start, saved.end, saved.direction);
    rebuilding = false;
  }
  const snapshot = () => ({
    value,
    runs,
    blocks,
    selection: { ...selection() },
    pending,
    inheritLanguage,
  });
  function remember(group = false) {
    if (history) return;
    const now = Date.now();
    if (!group || now - lastEdit > 500 || redo.length) {
      undo.push(snapshot());
      if (undo.length > 100) undo.shift();
    }
    redo = [];
    lastEdit = group ? now : 0;
  }
  const notify = () =>
    input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  function restore(state) {
    value = state.value;
    runs = state.runs;
    blocks = state.blocks;
    pending = state.pending;
    inheritLanguage = state.inheritLanguage;
    remembered = state.selection;
    render();
    setSelection(remembered.start, remembered.end, remembered.direction, true);
    notify();
    onSelection();
  }
  function travel(forward) {
    if (history) {
      history(forward);
      return;
    }
    const from = forward ? redo : undo,
      to = forward ? undo : redo;
    if (!from.length) return;
    to.push(snapshot());
    restore(from.pop());
    lastEdit = 0;
  }
  function replace(
    insert,
    insertedRuns,
    record = true,
    insertedBlocks,
    group = false,
  ) {
    const { start, end } = selection();
    // Line breaks are normalized; in a single-line field they become the
    // space between the lines' words, as a browser pastes them into an
    // input. The styles and paragraphs that came with the text keep their
    // words.
    const offsets = [0];
    let normalized = "";
    for (let at = 0; at < insert.length; at++) {
      const c = insert[at];
      if (c === "\r" && insert[at + 1] === "\n") {
        offsets.push(normalized.length);
        continue;
      }
      if (c === "\r" || c === "\n") {
        if (multiline) normalized += "\n";
        else if (normalized && !/\s$/.test(normalized)) normalized += " ";
      } else normalized += c;
      offsets.push(normalized.length);
    }
    const shift = (at) => offsets[Math.min(at, offsets.length - 1)];
    insertedRuns = insertedRuns
      ?.map((r) => ({ ...r, start: shift(r.start), end: shift(r.end) }))
      .filter((r) => r.end > r.start);
    insertedBlocks = insertedBlocks?.map((b) => ({
      ...b,
      start: shift(b.start),
    }));
    insert = limit(normalized, maxLength - value.length + end - start);
    if (!insert && start === end) return;
    if (record) remember(group);
    runs = spliceTextRuns(
      runs,
      start,
      end,
      insert,
      typingStyle(start, end, insert),
      insertedRuns,
    );
    blocks = spliceTextBlocks(value, blocks, start, end, insert);
    value = value.slice(0, start) + insert + value.slice(end);
    if (insertedBlocks) {
      const byStart = new Map(blocks.map((block) => [block.start, block]));
      // Text of the destination paragraph left on either side of the paste.
      const multiline = insert.includes("\n"),
        before = start > 0 && value[start - 1] !== "\n",
        tail = value[start + insert.length],
        after = tail !== undefined && tail !== "\n";
      for (const row of textParagraphs(insert, insertedBlocks)) {
        const at = start + row.start;
        const from = at === 0 ? 0 : value.lastIndexOf("\n", at - 1) + 1;
        if (row.list)
          byStart.set(from, {
            start: from,
            list: row.list,
            indent: row.indent,
          });
        // Inline text joins the destination paragraph and keeps its list.
        // Pasted paragraphs that start a line and end with a line break
        // bring their own style; the last pasted line joins what is left
        // of the destination paragraph and keeps its list, unless the
        // paste replaced that paragraph's whole text.
        else if (
          multiline &&
          (row.end < insert.length
            ? row.start > 0 || !before
            : !before && !after)
        )
          byStart.delete(from);
      }
      blocks = [...byStart.values()].sort((a, b) => a.start - b.start);
    }

    remembered = {
      start: start + insert.length,
      end: start + insert.length,
      direction: "forward",
    };
    render();
    setSelection(remembered.start, remembered.end, "forward", true);
    notify();
    onSelection();
  }
  function typingStyle(start, end, insert) {
    let current = pending || styleAt(runs, start, start === end);
    // Typing before a link at the very start of the text extends it no more
    // than typing before one elsewhere does.
    if (!pending && start === 0 && start === end && current.link) {
      const { link, ...rest } = current;
      current = rest;
    }
    // A generated prompt declares its own language, not the author's next
    // words. Explicit language formatting restores normal typing inheritance.
    if (!inheritLanguage) {
      const { lang, ...rest } = current;
      current = rest;
    }
    if (
      current.link &&
      (/[\n\u2028]/.test(insert) ||
        (start === end &&
          /^\s/.test(insert) &&
          textLinkRange(value, runs, start).end === start))
    ) {
      const { link, ...rest } = current;
      if (pending) pending = rest;
      return rest;
    }
    return current;
  }
  input.addEventListener("beforeinput", (e) => {
    if (e.isComposing || composing) return;
    if (["historyUndo", "historyRedo"].includes(e.inputType)) {
      e.preventDefault();
      travel(e.inputType === "historyRedo");
    } else if (["insertParagraph", "insertLineBreak"].includes(e.inputType)) {
      e.preventDefault();
      if (!multiline) return;
      const selected = selection(),
        paragraph = selectedParagraphs(
          value,
          blocks,
          selected.start,
          selected.end,
        )[0];
      if (
        e.inputType === "insertParagraph" &&
        paragraph?.list &&
        !paragraph.text &&
        selected.start === selected.end
      ) {
        if (paragraph.indent) input.indentList(-1);
        else input.setList(null);
      } else
        replace(
          e.inputType === "insertLineBreak" && paragraph?.list
            ? "\u2028"
            : "\n",
        );
    } else if (
      [
        "formatBold",
        "formatItalic",
        "formatUnderline",
        "formatStrikeThrough",
      ].includes(e.inputType)
    ) {
      e.preventDefault();
      input.format(
        {
          formatBold: "bold",
          formatItalic: "italic",
          formatUnderline: "underline",
          formatStrikeThrough: "strike",
        }[e.inputType],
      );
    } else {
      const selected = selection(),
        paragraph = selectedParagraphs(
          value,
          blocks,
          selected.start,
          selected.end,
        )[0];
      if (
        e.inputType === "deleteContentBackward" &&
        selected.start === selected.end &&
        paragraph?.list &&
        selected.start === paragraph.start
      ) {
        e.preventDefault();
        if (paragraph.indent) input.indentList(-1);
        else input.setList(null);
        return;
      }
      const prefix = paragraph && value.slice(paragraph.start, selected.start);
      // Typing "- " or "1. " starts a list only where lists are kept: a
      // plain or single-line field would lose the marker and keep nothing.
      if (
        !plainTextOnly &&
        multiline &&
        e.inputType === "insertText" &&
        e.data === " " &&
        !paragraph?.list &&
        selected.start === selected.end &&
        /^(?:[-*]|1[.)])$/.test(prefix)
      ) {
        e.preventDefault();
        input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
        remember();
        runs = spliceTextRuns(runs, paragraph.start, selected.start, "");
        blocks = spliceTextBlocks(
          value,
          blocks,
          paragraph.start,
          selected.start,
          "",
        );
        value = value.slice(0, paragraph.start) + value.slice(selected.start);
        blocks = formatTextBlocks(
          value,
          blocks,
          paragraph.start,
          paragraph.start,
          prefix.startsWith("1") ? "number" : "bullet",
        );
        remembered = {
          start: paragraph.start,
          end: paragraph.start,
          direction: "forward",
        };
        render();
        setSelection(paragraph.start);
        notify();
        input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
        onSelection();
        return;
      }
      if (
        blocks.length &&
        e.cancelable &&
        e.inputType === "insertText" &&
        e.data !== null
      ) {
        e.preventDefault();
        replace(
          e.data,
          undefined,
          true,
          undefined,
          selected.start === selected.end,
        );
        return;
      }
      if (
        blocks.length &&
        e.cancelable &&
        e.inputType.startsWith("delete") &&
        selected.start !== selected.end
      ) {
        e.preventDefault();
        replace("");
        return;
      }
      before = snapshot();
      beforeType = e.inputType;
      if (
        e.data &&
        value.length -
          (before.selection.end - before.selection.start) +
          e.data.length >
          maxLength
      ) {
        e.preventDefault();
        replace(e.data);
      }
    }
  });
  // Where native input changed the text, from the selection just before it.
  // Comparing the texts cannot tell which of two matching characters was
  // typed or removed, and so which one's style to keep.
  function caretChange(saved, type = "", prev, next) {
    if (!saved || saved.value !== prev) return null;
    const { start, end } = saved.selection,
      tail = prev.length - end;
    if (
      next.length >= start + tail &&
      next.startsWith(prev.slice(0, start)) &&
      next.endsWith(prev.slice(end))
    )
      return { start, end, insert: next.slice(start, next.length - tail) };
    const removed = prev.length - next.length;
    if (start !== end || removed <= 0 || !type.startsWith("delete"))
      return null;
    const from = type.endsWith("Forward") ? start : start - removed;
    return from >= 0 &&
      next === prev.slice(0, from) + prev.slice(from + removed)
      ? { start: from, end: from + removed, insert: "" }
      : null;
  }
  function acceptInput() {
    domCache = undefined;
    // Imported labels can be longer than the field's authoring limit. A
    // native deletion should not silently discard their remaining text.
    const next = limit(
      normalize(domText().text),
      maxLength < LIMIT ? Math.max(maxLength, value.length) : maxLength,
    );
    if (next === value) return;
    const saved = selection(),
      change =
        caretChange(before, beforeType, value, next) ||
        textDifference(value, next);
    // Capture the selection from before native mutation, not its new caret.
    if (!history && !composing) {
      if (Date.now() - lastEdit > 500 || redo.length)
        undo.push(before || snapshot());
      if (undo.length > 100) undo.shift();
      redo = [];
      lastEdit = Date.now();
    }
    runs = spliceTextRuns(
      runs,
      change.start,
      change.end,
      change.insert,
      typingStyle(change.start, change.end, change.insert),
    );
    blocks = spliceTextBlocks(
      value,
      blocks,
      change.start,
      change.end,
      change.insert,
    );
    value = next;
    // Selection offsets may extend beyond the previous value after insertion.
    const sel = doc.getSelection(),
      { positions } = domText();
    const point = (node, offset) =>
      typeof positions.get(node) === "number"
        ? positions.get(node) + offset
        : positions.get(node)?.[offset];
    const a = point(sel?.anchorNode, sel?.anchorOffset),
      b = point(sel?.focusNode, sel?.focusOffset);
    remembered =
      Number.isFinite(a) && Number.isFinite(b)
        ? {
            start: Math.min(a, b),
            end: Math.max(a, b),
            direction: a > b ? "backward" : "forward",
          }
        : saved;
    before = null;
    render();
    onSelection();
  }
  input.addEventListener("input", acceptInput);
  input.addEventListener("compositionstart", () => {
    before = compositionInitial = snapshot();
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    acceptInput();
    if (!history && compositionInitial && compositionInitial.value !== value) {
      undo.push(compositionInitial);
      if (undo.length > 100) undo.shift();
      redo = [];
    }
    compositionInitial = undefined;
    lastEdit = 0;
    composing = false;
    render();
    notify();
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || composing || e.keyCode === 229) return;
    if (!multiline && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (!e.metaKey && !e.ctrlKey && !e.altKey)
        input.closest("form")?.requestSubmit();
      return;
    }
    // WebKit can report Shift+Enter as insertParagraph. Handle the physical
    // shortcut here; beforeinput also covers virtual keyboards and menus.
    if (
      e.key === "Enter" &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      paragraphAt(value, blocks, selection().start)
    ) {
      e.preventDefault();
      e.stopPropagation();
      replace("\u2028");
      return;
    }
    if (e.key === "Tab" && paragraphAt(value, blocks, selection().start)) {
      e.preventDefault();
      e.stopPropagation();
      input.indentList(e.shiftKey ? -1 : 1);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && ["z", "y"].includes(shortcutLetter(e))) {
      e.preventDefault();
      e.stopPropagation();
      travel(shortcutLetter(e) === "y" || e.shiftKey);
    }
  });
  function readTransfer(data) {
    let text = data.getData("text/plain");
    if (plainTextOnly) return { text };
    try {
      const saved = JSON.parse(data.getData(MIME));
      // Windows gives the plain text back with CRLF line breaks.
      const lines = (value) => value.replace(/\r\n?/g, "\n");
      if (
        typeof saved.text === "string" &&
        lines(saved.plainText ?? saved.text) === lines(text) &&
        saved.text.length <= maxLength
      ) {
        validateTextRuns(saved.text, saved.runs);
        validateTextBlocks(saved.text, saved.blocks);
        return {
          text: saved.text,
          formatting: saved.runs,
          paragraphs: saved.blocks,
        };
      }
    } catch {
      /* Other applications use their standard clipboard formats. */
    }
    const rich = readTextHTML(doc, data.getData("text/html"));
    return rich
      ? {
          text: rich.text,
          paragraphs: rich.blocks,
          formatting: rich.runs || [],
        }
      : { text };
  }
  // The field turns read-only when the object stops being writable while
  // it is open, as a table a collaborator protects; the browser then
  // refuses typing, and these do the same.
  const readOnly = () => input.getAttribute("contenteditable") === "false";
  input.addEventListener("paste", (e) => {
    if (!e.clipboardData || readOnly()) return;
    e.preventDefault();
    e.stopPropagation();
    const { text, formatting, paragraphs } = readTransfer(e.clipboardData);
    const url =
      !plainTextOnly &&
      !formatting?.length &&
      !e.clipboardData.getData(MIME) &&
      textLinkURL(text);
    if (url) {
      if (selection().start !== selection().end) input.setLink(url);
      else {
        const pasted = text.trim();
        input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
        replace(pasted, [
          {
            start: 0,
            end: pasted.length,
            style: { ...styleAt(runs, selection().start), link: url },
          },
        ]);
        input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
      }
      return;
    }
    if (text) replace(text, formatting, true, paragraphs);
  });
  function selectedContent() {
    const { start, end } = selection(),
      text = value.slice(start, end),
      copied = [];
    for (const part of textSegments(value, runs)) {
      const a = Math.max(start, part.start),
        b = Math.min(end, part.end);
      if (a < b)
        copied.push({
          start: a - start,
          end: b - start,
          style: { textColor: false, highlight: false, ...style(part.style) },
        });
    }
    // Words from inside one list item are copied as plain text; the item
    // comes along once the selection includes its start or another line.
    const copiedBlocks = selectedParagraphs(value, blocks, start, end)
      .filter((p) => p.list && (p.start >= start || end > p.end))
      .map((p) => ({
        start: Math.max(0, p.start - start),
        list: p.list,
        indent: p.indent,
      }));
    return {
      text,
      plainText: copiedBlocks.length ? listPlainText(text, copiedBlocks) : text,
      runs: copied,
      blocks: copiedBlocks,
      start,
      end,
    };
  }
  for (const type of ["copy", "cut"])
    input.addEventListener(type, (e) => {
      const content = selectedContent();
      if (!content.text || !e.clipboardData) return;
      if (type === "cut" && readOnly()) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        e.clipboardData.setData("text/plain", content.plainText);
        if (!plainTextOnly)
          e.clipboardData.setData(MIME, JSON.stringify(content));
        if (
          !plainTextOnly &&
          (content.blocks.length ||
            content.runs.some((r) => r.style.link || r.style.lang))
        )
          e.clipboardData.setData(
            "text/html",
            textClipboardHTML(doc, content.text, content.runs, content.blocks),
          );
      } catch {
        return;
      }
      if (type === "cut") replace("");
    });
  input.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    dragged = selectedContent();
    e.dataTransfer.setData("text/plain", dragged.plainText);
    e.dataTransfer.setData(MIME, JSON.stringify(dragged));
    e.dataTransfer.effectAllowed = "copyMove";
  });
  input.addEventListener("dragend", () => {
    dragged = undefined;
  });
  input.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  input.addEventListener("drop", (e) => {
    // Files go on the board, as they do when dropped beside the text; the
    // board also takes down its drop target as the drop passes it.
    if (Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();
    if (!e.dataTransfer || readOnly()) return;
    const { text, formatting, paragraphs } = readTransfer(e.dataTransfer);
    if (!text) return;
    const caret = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
    const range = caret
      ? null
      : doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = caret?.offsetNode || range?.startContainer;
    const offset = caret?.offset ?? range?.startOffset;
    if (node && input.contains(node))
      doc.getSelection().setBaseAndExtent(node, offset, node, offset);
    let at = selection().start;
    if (
      dragged &&
      e.dataTransfer.dropEffect !== "copy" &&
      !e.altKey &&
      !e.ctrlKey
    ) {
      const { start, end } = dragged;
      if (at >= start && at <= end) {
        dragged = undefined;
        return;
      }
      remember();
      runs = spliceTextRuns(runs, start, end, "");
      blocks = spliceTextBlocks(value, blocks, start, end, "");
      value = value.slice(0, start) + value.slice(end);
      if (at > end) at -= end - start;
      remembered = { start: at, end: at, direction: "forward" };
      render();
      setSelection(at);
      replace(text, formatting, false, paragraphs);
    } else {
      setSelection(at);
      replace(text, formatting, true, paragraphs);
    }
    dragged = undefined;
  });

  function selectionChanged() {
    if (rebuilding || composing || doc.activeElement !== input) return;
    const old = remembered,
      next = selection();
    if (old.start !== next.start || old.end !== next.end) {
      pending = undefined;
      lastEdit = 0;
    }
    onSelection();
  }
  doc.addEventListener("selectionchange", selectionChanged);
  input.destroy = () =>
    doc.removeEventListener("selectionchange", selectionChanged);
  input.setRichText = (text, formatting = [], paragraphs = []) => {
    remembered = { ...selection() };
    value = text;
    runs = formatting;
    blocks = plainTextOnly ? [] : paragraphs;
    // A style chosen for the next typed text outlasts a collaborator's
    // edit; it goes when the caret itself moves.
    render();
  };
  let baseSignature;
  input.setBaseStyle = (next, color = defaultColor) => {
    if (next.lang) inheritLanguage = true;
    const signature = JSON.stringify([
      next.type,
      color,
      ...TEXT_STYLE_KEYS.map((key) => next[key]),
    ]);
    if (baseSignature === signature) return;
    remembered = { ...selection() };
    base = next;
    defaultColor = color;
    baseSignature = signature;
    render();
  };
  input.rangeStyle = (key) => {
    const { start, end } = selection();
    if (start === end) return style(pending || styleAt(runs, start))[key];
    const values = textSegments(value, runs)
      .filter((s) => s.start < end && s.end > start)
      .map((s) => style(s.style)[key]);
    return values.every((v) => v === values[0]) ? values[0] : "mixed";
  };
  input.linkRange = () => {
    const { start, end } = selection();
    return textLinkRange(value, runs, start, end);
  };
  input.setLink = (url) => {
    if (plainTextOnly) return false;
    if (composing) return false;
    if (url && !textLinkURL(url)) return false;
    url = url ? textLinkURL(url) : null;
    const { start, end } = input.linkRange();
    if (start === end && !url) return false;
    input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
    if (start === end) {
      const inherited = { ...styleAt(runs, start), link: url };
      replace(url, [{ start: 0, end: url.length, style: inherited }]);
    } else {
      const next = formatTextRuns(value, runs, start, end, { link: url });
      if (JSON.stringify(next) === JSON.stringify(runs)) return false;
      remember();
      runs = next;
      render();
      setSelection(start, end, "forward", true);
      notify();
      onSelection();
    }
    pending = undefined;
    input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
    return true;
  };
  input.addEventListener("click", (e) => {
    if (e.target.closest("[data-text-link]")) e.preventDefault();
  });
  function applyBlocks(next) {
    if (composing || JSON.stringify(next) === JSON.stringify(blocks)) return;
    const selected = { ...selection() };
    input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
    remember();
    blocks = next;
    render();
    notify();
    input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
    setSelection(selected.start, selected.end, selected.direction, true);
    onSelection();
  }
  input.listStyle = () => {
    const { start, end } = selection(),
      rows = selectedParagraphs(value, blocks, start, end);
    return rows.every((p) => p.list === rows[0].list)
      ? rows[0].list || false
      : "mixed";
  };
  input.setList = (list) => {
    const { start, end } = selection();
    applyBlocks(
      formatTextBlocks(
        value,
        blocks,
        start,
        end,
        input.listStyle() === list ? null : list,
      ),
    );
  };
  input.indentList = (delta) => {
    const { start, end } = selection();
    applyBlocks(indentTextBlocks(value, blocks, start, end, delta));
  };
  input.setListMetrics = (ctx, style) => {
    const key = `${renderVersion}:${style.font}`;
    if (listMetricKey === key) return;
    listMetricKey = key;
    ctx.font = style.font;
    for (const row of input.querySelectorAll("[data-indent]")) {
      const gutter =
        Number(row.dataset.indent) * style.size * 1.5 +
        Math.max(
          style.size * 1.5,
          ctx.measureText(row.dataset.listMarker).width + style.size * 0.5,
        );
      row.style.marginLeft = `${gutter}px`;
    }
  };
  input.format = (key, next) => {
    if (plainTextOnly && key !== "lang") return;
    if (key === "link") return input.setLink(next);
    if (composing || !TEXT_STYLE_KEYS.includes(key)) return;
    const { start, end, direction } = selection();
    if (next === undefined) next = input.rangeStyle(key) !== true;
    if (next === null && ["textColor", "highlight"].includes(key)) next = false;
    if (start === end) {
      if (key === "lang") inheritLanguage = true;
      pending = { ...(pending || styleAt(runs, start)) };
      if (next === null) delete pending[key];
      else pending[key] = next;
    } else {
      input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
      remember();
      if (key === "lang" && !inheritLanguage) {
        pending = undefined;
        inheritLanguage = true;
      }
      runs = formatTextRuns(value, runs, start, end, { [key]: next });
      render();
      notify();
      input.dispatchEvent(new doc.defaultView.Event("formatboundary"));
    }
    setSelection(start, end, direction, true);
    onSelection();
  };
  Object.defineProperties(input, {
    value: {
      get: () => value,
      set: (next) => {
        next = limit(normalize(String(next)), maxLength);
        if (next === value) return;
        remembered = {
          start: next.length,
          end: next.length,
          direction: "forward",
        };
        const change = textDifference(value, next);
        runs = inheritLanguage
          ? replaceTextRuns(value, next, runs)
          : spliceTextRuns(
              runs,
              change.start,
              change.end,
              change.insert,
              typingStyle(change.start, change.end, change.insert),
            );
        blocks = spliceTextBlocks(
          value,
          blocks,
          change.start,
          change.end,
          change.insert,
        );
        value = next;
        render();
      },
    },
    textRuns: { get: () => runs },
    textBlocks: { get: () => blocks },
    defaultTextColor: { get: () => defaultColor },
    selectionStart: { get: () => selection().start },
    selectionEnd: { get: () => selection().end },
    selectionDirection: { get: () => selection().direction },
  });
  input.setSelectionRange = setSelection;
  input.select = () => setSelection(0, value.length);
  render();
  return input;
}
