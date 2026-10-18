import { shortcutLetter } from "./shortcut-keys.js";
import { DOUBLE_CLICK_MS } from "./navigation.js";
import {
  tableCellContent,
  tableLanguagePatch,
  normalizedCellLanguage,
} from "./table-language.js";
import {
  createAuthoredField,
  fieldContent,
} from "./facilitation/authored-field.js";
import { authoredTextHTML } from "./accessibility/object-content.js";
import { t } from "./i18n.js";
import { tableFont, tableFontSize, tableTextAlign } from "./table-sizing.js";
import { fitsTable, readTableContent, TABLE_LIMIT } from "./bulk-content.js";
import { createTableResize } from "./table-resize.js";
import {
  tableCellAt,
  tableCellBox,
  tableRange,
  tableRangeClipboard,
  pasteTableRange,
  fillTableRange,
} from "./table-cells.js";

export function createTableEditor(api) {
  let state = null,
    root,
    input,
    draft,
    pointer,
    lastClick,
    controlsKey;
  const drafts = new Map();
  const sizing = createTableResize({
    ...api,
    current: () => current(),
    range: () => range(),
    editing: () => !!input,
    finish: () => finish(),
    commit: (i, patch, key) => api.resize?.(i, patch, key),
    error: (message) => error(message),
  });
  const current = () =>
    state &&
    api.state().board === state.board &&
    state.board.items.find((i) => i.id === state.id && i.type === "table");
  // The range as it fits the table now: a collaborator may have removed
  // rows or columns since it was chosen, before the next repaint.
  const range = () => {
    const i = current(),
      clamp = (cell) =>
        i
          ? {
              r: Math.min(cell.r, i.cells.length - 1),
              c: Math.min(cell.c, i.cells[0].length - 1),
            }
          : cell;
    return tableRange(clamp(state.anchor), clamp(state.end));
  };
  const draftKey = (cell = state.end) =>
    `${state.board.id}/${state.id}/${cell.r}/${cell.c}`;
  function retain() {
    if (
      !input ||
      !draft ||
      JSON.stringify(fieldContent(input)) === JSON.stringify(draft.original)
    )
      return;
    drafts.delete(draft.key);
    drafts.set(draft.key, { ...draft, content: fieldContent(input) });
    while (drafts.size > 100) drafts.delete(drafts.keys().next().value);
  }
  function error(message) {
    const output = root?.querySelector("#table-cell-error");
    if (output) {
      output.textContent = t(message);
      output.hidden = false;
    } else api.toast(message);
  }
  function validDraft(i) {
    return (
      i &&
      api.writable(i) &&
      i.cells.length === draft.rows &&
      i.cells[0].length === draft.cols &&
      i.cells[draft.r]?.[draft.c] === draft.value &&
      JSON.stringify(tableCellContent(i, draft.r, draft.c, false)) ===
        JSON.stringify(draft.original)
    );
  }
  function finish(commit = true) {
    if (!input) return true;
    const i = current(),
      content = fieldContent(input),
      text = content.text,
      changed = JSON.stringify(content) !== JSON.stringify(draft.original);
    if (commit && changed && !validDraft(i)) {
      retain();
      error(
        "This cell changed or is protected. Your draft is kept; copy it or use the latest value.",
      );
      return false;
    }
    const previous = draft,
      field = input,
      focused = document.activeElement === field;
    drafts.delete(previous.key);
    const wrapper = input.parentElement,
      controls = input.languageControls,
      languageButton = root.querySelector("#table-cell-language"),
      languageHandler = languageButton.onclick;
    wrapper.remove();
    controls.remove();
    resetLanguageButton();
    input = null;
    draft = null;
    root?.querySelector("#table-cell-reset")?.setAttribute("hidden", "");
    if (commit && changed) {
      const cells = i.cells.map((row) => [...row]);
      cells[previous.r][previous.c] = text;
      if (
        !write(cells, undefined, {
          [`${previous.r},${previous.c}`]: normalizedCellLanguage(text, {
            lang: content.lang,
            textRuns: content.textRuns,
          }),
        })
      ) {
        input = field;
        draft = previous;
        root.append(wrapper);
        root.querySelector(".table-cell-tools").append(controls);
        languageButton.onclick = languageHandler;
        languageButton.setAttribute("aria-controls", controls.id);
        languageButton.setAttribute("aria-expanded", String(!controls.hidden));
        retain();
        render();
        if (focused && document.activeElement === document.body)
          input.focus({ preventScroll: true });
        return false;
      }
    }
    field.destroy();
    return true;
  }
  function resetLanguageButton() {
    const button = root?.querySelector("#table-cell-language");
    if (!button) return;
    button.removeAttribute("aria-controls");
    button.setAttribute("aria-expanded", "false");
    button.onclick = () => {
      edit();
      if (input) button.onclick();
    };
  }
  function close(commit = true) {
    if (!state) return;
    sizing.cancel(false);
    if (!finish(commit)) {
      api.toast("Cell draft kept. Reopen the cell to review it.");
      input?.languageControls.remove();
      input?.destroy();
      input?.parentElement.remove();
      input = null;
      draft = null;
    }
    root?.remove();
    root = null;
    state = null;
    pointer = null;
    lastClick = null;
    controlsKey = null;
  }
  function write(cells, structure, languages) {
    const i = current();
    if (!i || !api.writable(i)) {
      error("This table is protected.");
      return false;
    }
    if (
      !fitsTable(cells) ||
      !cells.every((row) => row.length === cells[0].length)
    ) {
      error(TABLE_LIMIT);
      return false;
    }
    const patch = tableLanguagePatch(i, cells, structure, languages);
    if (
      JSON.stringify(cells) === JSON.stringify(i.cells) &&
      JSON.stringify(patch.cellLanguages) === JSON.stringify(i.cellLanguages)
    )
      return true;
    try {
      api.change(i, cells, structure, languages);
    } catch (err) {
      error(err.message);
      return false;
    }
    return true;
  }
  function open(i, cell = { r: 0, c: 0 }, editing = false) {
    close();
    api.prepare();
    if (!i || i.type !== "table") return;
    state = {
      board: api.state().board,
      id: i.id,
      anchor: { ...cell },
      end: { ...cell },
    };
    root = document.createElement("div");
    root.id = "table-editor";
    root.innerHTML = `<div class="table-cell-outline" aria-hidden="true"></div><div class="table-cell-tools panel" role="toolbar" aria-label="${t("Table cells")}"><span id="table-cell-position" role="status"></span><button id="table-cell-edit" class="secondary">${t("Edit cell")}</button><label class="sr-only" for="table-row-action">${t("Rows")}</label><select id="table-row-action" aria-label="${t("Rows")}"><option value="">${t("Rows")}</option><option value="before">${t("Insert row above")}</option><option value="after">${t("Insert row below")}</option><option value="delete">${t("Delete selected rows")}</option></select><label class="sr-only" for="table-column-action">${t("Columns")}</label><select id="table-column-action" aria-label="${t("Columns")}"><option value="">${t("Columns")}</option><option value="before">${t("Insert column left")}</option><option value="after">${t("Insert column right")}</option><option value="delete">${t("Delete selected columns")}</option></select><button id="table-cell-language" class="secondary" aria-describedby="table-cell-position">${t("Content language")}</button><button id="table-cell-clear" class="text-btn">${t("Clear cells")}</button><button id="table-cell-reset" class="text-btn" hidden>${t("Use latest value")}</button><button id="table-cell-done" class="primary">${t("Done")}</button><p id="table-cell-error" role="alert" hidden></p><span class="table-cell-help">${t("Arrows select cells · Shift extends selection · Enter edits · Tab moves · Escape cancels")}</span></div><div id="table-cell-grid" class="sr-only" role="grid" aria-label="${t("Table cells")}" tabindex="0" aria-activedescendant="table-active-cell"><div role="row"><div role="gridcell" id="table-active-cell" aria-selected="true" data-user-content></div></div></div>`;
    api.canvas().parentElement.append(root);
    sizing.bind(root);
    resetLanguageButton();
    const extend = document.createElement("button");
    extend.id = "table-cell-extend";
    extend.className = "secondary";
    extend.textContent = t("Extend selection");
    extend.setAttribute("aria-pressed", "false");
    extend.title = t(
      "Turn on Extend selection, then click another cell to select a range.",
    );
    root.querySelector("#table-cell-edit").after(extend);
    root.querySelector(".table-cell-help").textContent += ` · ${extend.title}`;
    extend.onclick = () => {
      if (!finish() || !state) return;
      state.extend = !state.extend;
      lastClick = null;
      render();
    };
    root.querySelector("#table-cell-edit").onclick = () => edit();
    root.querySelector("#table-cell-clear").onclick = () => {
      if (finish()) {
        clearRange();
        render();
      }
    };
    root.querySelector("#table-cell-done").onclick = () => {
      if (!finish()) return;
      close();
      api.draw();
      api.canvas().focus({ preventScroll: true });
    };
    root.querySelector("#table-cell-reset").onclick = () => {
      const cell = { ...state.end };
      finish(false);
      select(cell);
      edit();
    };
    for (const axis of ["row", "column"])
      root.querySelector(`#table-${axis}-action`).onchange = (e) => {
        const action = e.target.value;
        e.target.value = "";
        structure(axis, action);
      };
    root.addEventListener("keydown", (e) => {
      if (keydown(e)) e.stopPropagation();
    });
    render();
    api.draw();
    if (!state || !root) return;
    if (editing) edit();
    else {
      api.reveal(tableCellBox(current(), state.end));
      root?.querySelector("#table-cell-grid").focus({ preventScroll: true });
    }
  }
  function select(cell, extend = false, reveal = true) {
    const i = current();
    if (!i) return;
    cell = {
      r: Math.max(0, Math.min(i.cells.length - 1, cell.r)),
      c: Math.max(0, Math.min(i.cells[0].length - 1, cell.c)),
    };
    if (!extend) state.anchor = cell;
    state.end = cell;
    if (reveal) api.reveal(tableCellBox(i, cell));
    render();
  }
  function edit(replacement) {
    const i = current();
    if (!i || !api.writable(i)) return error("This table is protected.");
    if (input) {
      input.focus();
      return;
    }
    const { r, c } = state.end;
    state.anchor = { r, c };
    draft = drafts.get(draftKey()) || {
      key: draftKey(),
      r,
      c,
      rows: i.cells.length,
      cols: i.cells[0].length,
      value: i.cells[r][c],
      original: tableCellContent(i, r, c, false),
    };
    const placeholder = document.createElement("textarea");
    placeholder.id = "table-cell-input";
    const label = document.createElement("span");
    label.id = "table-cell-input-label";
    label.className = "sr-only";
    label.textContent = `${t("Rows")} ${r + 1}, ${t("Columns")} ${c + 1}`;
    const holder = document.createElement("div");
    holder.className = "table-cell-field";
    holder.append(label, placeholder);
    root.append(holder);
    const source = draft.content || draft.original;
    input = createAuthoredField(placeholder, source, {
      maxLength: 2000,
      inheritFontStyle: true,
      inheritedLanguage: i.lang,
      languageButton: root.querySelector("#table-cell-language"),
    });
    const wrapper = input.parentElement;
    wrapper.prepend(label);
    holder.replaceWith(wrapper);
    wrapper.className = "table-cell-field";
    root.querySelector(".table-cell-tools").append(input.languageControls);
    if (replacement !== undefined) input.setRichText(replacement, []);
    input.addEventListener("input", retain);
    api.reveal(tableCellBox(i, state.end), true);
    render();
    input.focus({ preventScroll: true });
    if (replacement === undefined) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
  }
  function clearRange() {
    const i = current(),
      a = range(),
      changes = {};
    for (let r = a.r; r < a.r + a.rows; r++)
      for (let c = a.c; c < a.c + a.cols; c++) {
        const lang = i.cellLanguages?.[`${r},${c}`]?.lang;
        changes[`${r},${c}`] = lang ? { lang } : {};
      }
    return write(fillTableRange(i.cells, a), undefined, changes);
  }
  function structure(axis, action) {
    if (!action || !finish()) return;
    const i = current();
    if (!i || !api.writable(i)) return error("This table is protected.");
    const a = range(),
      rows = i.cells.length,
      cols = i.cells[0].length;
    let cells = i.cells.map((row) => [...row]);
    if (axis === "row") {
      if (action === "delete") {
        if (a.rows === rows)
          return error("Keep at least one row and one column.");
        cells.splice(a.r, a.rows);
      } else
        cells.splice(
          a.r + (action === "after" ? a.rows : 0),
          0,
          Array(cols).fill(""),
        );
    } else {
      if (action === "delete" && a.cols === cols)
        return error("Keep at least one row and one column.");
      cells.forEach((row) =>
        action === "delete"
          ? row.splice(a.c, a.cols)
          : row.splice(a.c + (action === "after" ? a.cols : 0), 0, ""),
      );
    }
    const index = axis === "row" ? a.r : a.c,
      count = axis === "row" ? a.rows : a.cols;
    if (
      write(cells, {
        axis,
        index: index + (action === "after" ? count : 0),
        remove: action === "delete" ? count : 0,
        insert: action === "delete" ? 0 : 1,
      })
    )
      select({ r: a.r, c: a.c });
  }
  function step(key, extend = false) {
    const i = current();
    let { r, c } = state.end;
    if (key === "Tab") {
      c += extend ? -1 : 1;
      if (c < 0 && r > 0) {
        c = i.cells[0].length - 1;
        r--;
      } else if (c >= i.cells[0].length && r < i.cells.length - 1) {
        c = 0;
        r++;
      }
    } else {
      r += { ArrowDown: 1, ArrowUp: -1 }[key] || 0;
      c += { ArrowRight: 1, ArrowLeft: -1 }[key] || 0;
    }
    select({ r, c }, key !== "Tab" && extend);
  }
  function keydown(e) {
    if (sizing.keydown(e)) return true;
    if (
      !state ||
      e.defaultPrevented ||
      e.isComposing ||
      e.keyCode === 229 ||
      e.target.closest?.("select,input") ||
      (e.target.closest?.("button") && e.key !== "Escape")
    )
      return false;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Tab" && !mod && !e.altKey) {
      const i = current(),
        cell = state.end;
      if (
        e.shiftKey
          ? cell.r === 0 && cell.c === 0
          : cell.r === i.cells.length - 1 && cell.c === i.cells[0].length - 1
      ) {
        if (input && !finish()) {
          e.preventDefault();
          return true;
        }
        const control = e.shiftKey
          ? root.querySelector(
              ".table-cell-tools button:not(:disabled):last-child",
            )
          : root.querySelector("[data-table-resize]:not([hidden])");
        (control || root.querySelector("#table-cell-done")).focus();
        e.preventDefault();
        return true;
      }
    }
    let handled = true;
    if (input) {
      if (e.key === "Escape") {
        finish(false);
        render();
        api.canvas().focus({ preventScroll: true });
      } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        if (finish()) {
          if (!mod) step(e.key === "Enter" ? "ArrowDown" : "Tab", e.shiftKey);
          if (!mod) edit();
          else api.canvas().focus({ preventScroll: true });
        }
      } else handled = false;
    } else if (e.key === "Escape") {
      close(false);
      api.draw();
      api.canvas().focus({ preventScroll: true });
    } else if (
      (e.key.startsWith("Arrow") && !mod && !e.altKey) ||
      (e.key === "Tab" && !mod && !e.altKey)
    )
      step(e.key, e.shiftKey);
    else if (e.key === "Enter" || e.key === "F2") edit();
    else if (mod && shortcutLetter(e) === "a") {
      state.anchor = { r: 0, c: 0 };
      const i = current();
      state.end = { r: i.cells.length - 1, c: i.cells[0].length - 1 };
      render();
    } else if (["Backspace", "Delete"].includes(e.key)) {
      clearRange();
      render();
    } else if (!mod && !e.altKey && e.key.length === 1 && e.key !== " ")
      edit(e.key);
    else handled = false;
    if (handled) e.preventDefault();
    return handled;
  }
  function down(e, p) {
    if (sizing.down(e, p)) return true;
    const i = current(),
      cell = tableCellAt(i, p);
    if (!cell) {
      close();
      return false;
    }
    if (!finish()) return true;
    const now = performance.now();
    if (
      !e.shiftKey &&
      !state.extend &&
      lastClick?.r === cell.r &&
      lastClick?.c === cell.c &&
      now - lastClick.at < DOUBLE_CLICK_MS
    ) {
      lastClick = null;
      edit();
      return true;
    }
    lastClick = { ...cell, at: now };
    pointer = { anchor: { ...state.anchor }, end: { ...state.end } };
    select(cell, e.shiftKey || state.extend, false);
    return true;
  }
  function move(p) {
    if (sizing.move(p)) return;
    if (pointer && current()) {
      const cell = tableCellAt(current(), p, true);
      if (cell.r !== state.end.r || cell.c !== state.end.c) {
        select(cell, true, false);
        lastClick = null;
      }
    }
  }
  function end(cancel = false) {
    if (sizing.end(cancel)) return;
    if (cancel && pointer && state) {
      state.anchor = pointer.anchor;
      state.end = pointer.end;
      render();
    }
    pointer = null;
  }
  function clipboard(e) {
    if (
      !state ||
      !current() ||
      !e.clipboardData ||
      e.defaultPrevented ||
      document.querySelector("dialog[open]")
    )
      return;
    if (
      e.target.closest?.("input,textarea,[contenteditable]") &&
      e.target !== input
    )
      return;
    // Text selected elsewhere, as in a comment, is what a copy or cut is
    // for; the cells are copied when the board or the grid has the focus.
    const selection = document.getSelection?.();
    if (
      e.type !== "paste" &&
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount &&
      !root?.contains(selection.anchorNode) &&
      !api.canvas()?.contains(selection.anchorNode)
    )
      return;
    // While a cell is being edited, what is pasted goes into its field at
    // the caret, as in a spreadsheet; the cells are pasted over only from
    // the grid.
    if (input) return;
    try {
      if (e.type === "paste") {
        // Spreadsheets send a picture of copied cells with them; the cells
        // are what is pasted. Files alone, or a clipboard with nothing to
        // put in a cell, such as a copied image, are left to the board
        // rather than emptying the chosen cells.
        const incomingContent = readTableContent(e.clipboardData);
        let incoming = incomingContent?.cells;
        if (!incoming && e.clipboardData.files?.length) return;
        if (!incoming) {
          const text = e.clipboardData.getData("text/plain");
          if (!text) return;
          incoming = [[text]];
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!fitsTable(incoming)) return error(TABLE_LIMIT);
        if (!finish()) return;
        const i = current(),
          a = range(),
          cells = pasteTableRange(i.cells, incoming, a),
          changes = {};
        const fill = incoming.length === 1 && incoming[0].length === 1,
          height = fill ? a.rows : incoming.length,
          width = fill ? a.cols : incoming[0].length;
        for (let r = 0; r < height; r++)
          for (let c = 0; c < width; c++) {
            const key = `${a.r + r},${a.c + c}`,
              lang = i.cellLanguages?.[key]?.lang;
            changes[key] =
              incomingContent?.cellLanguages?.[
                `${fill ? 0 : r},${fill ? 0 : c}`
              ] || (lang ? { lang } : {});
          }
        write(cells, undefined, changes);
        render();
      } else {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.type === "cut" && !api.writable(current()))
          return error("This table is protected.");
        for (const [type, value] of Object.entries(
          tableRangeClipboard(current().cells, range(), current()),
        ))
          e.clipboardData.setData(type, value);
        if (e.type === "cut") {
          clearRange();
          render();
        }
      }
    } catch (err) {
      e.preventDefault();
      e.stopImmediatePropagation();
      error(err.message);
    }
  }
  for (const kind of ["copy", "cut", "paste"])
    document.addEventListener(kind, clipboard, true);
  function render() {
    if (!state) return;
    const original = current();
    if (!original || !api.selected(original)) {
      if (input) retain();
      close();
      return;
    }
    const i = sizing.preview() || original;
    for (const cell of [state.anchor, state.end]) {
      cell.r = Math.min(cell.r, i.cells.length - 1);
      cell.c = Math.min(cell.c, i.cells[0].length - 1);
    }
    sizing.render();
    root
      .querySelector("#table-cell-extend")
      .setAttribute("aria-pressed", String(!!state.extend));
    const { view } = api.state(),
      a = range(),
      box = tableCellBox(i, a),
      outline = root.querySelector(".table-cell-outline");
    Object.assign(outline.style, {
      left: `${view.x + box.x * view.z}px`,
      top: `${view.y + box.y * view.z}px`,
      width: `${box.w * view.z}px`,
      height: `${box.h * view.z}px`,
    });
    const key = `${state.end.r}/${state.end.c}/${a.rows}/${a.cols}/${api.writable(i)}`;
    if (key !== controlsKey) {
      controlsKey = key;
      root.querySelector("#table-cell-position").textContent =
        `${t("Rows")} ${a.r + 1}${a.rows > 1 ? `–${a.r + a.rows}` : ""} · ${t("Columns")} ${a.c + 1}${a.cols > 1 ? `–${a.c + a.cols}` : ""}`;
      for (const id of [
        "table-cell-edit",
        "table-cell-clear",
        "table-cell-language",
        "table-row-action",
        "table-column-action",
      ])
        root.querySelector(`#${id}`).disabled = !api.writable(i);
    }
    const grid = root.querySelector("#table-cell-grid"),
      active = root.querySelector("#table-active-cell");
    grid.setAttribute("aria-rowcount", i.cells.length);
    grid.setAttribute("aria-colcount", i.cells[0].length);
    active.setAttribute("aria-rowindex", state.end.r + 1);
    active.setAttribute("aria-colindex", state.end.c + 1);
    const content = tableCellContent(i, state.end.r, state.end.c);
    active.innerHTML = authoredTextHTML(content);
    if (content.lang) active.lang = content.lang;
    else active.removeAttribute("lang");
    if (input) {
      input.inheritLanguage(i.lang);
      const cell = tableCellBox(i, { r: draft.r, c: draft.c }),
        size = tableFontSize(i) * view.z;
      Object.assign(input.style, {
        left: `${view.x + cell.x * view.z}px`,
        top: `${view.y + cell.y * view.z}px`,
        width: `${cell.w * view.z}px`,
        height: `${cell.h * view.z}px`,
        padding: `${9 * view.z}px`,
        font: tableFont(i, size),
        lineHeight: "1.35",
        textAlign: tableTextAlign(i),
        background: draft.r === 0 ? "#e6ebdf" : i.color || "#ffffff",
      });
      input.contentEditable = String(api.writable(i));
      input.setAttribute("contenteditable", String(api.writable(i)));
      input.setAttribute("aria-readonly", String(!api.writable(i)));
      if (!validDraft(i)) {
        error(
          "This cell changed or is protected. Your draft is kept; copy it or use the latest value.",
        );
        root.querySelector("#table-cell-reset").hidden = false;
      }
    }
  }
  return {
    open,
    close,
    finish,
    render,
    preview: sizing.preview,
    cursor: sizing.cursor,
    cancelResize: sizing.cancel,
    keydown,
    down,
    move,
    end,
    isOpen: () => !!state,
    id: () => state?.id,
  };
}
