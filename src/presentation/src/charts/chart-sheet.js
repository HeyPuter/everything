// The chart's data sheet: a small spreadsheet window beside the slide. The
// first row names the series and the first column the categories (or the
// x values of an X/Y chart). Edits reach the chart as they are typed, and
// the chart's embedded workbook with it, so other editors open the same
// data. Rows pasted from a spreadsheet fill the grid from the cell chosen.
import { el, icon, toast } from "../ui.js";
import {
  deleteColumn,
  deleteRow,
  gridLayout,
  gridToSpec,
  insertColumn,
  insertRow,
  parseTsv,
  pasteBlock,
  specToGrid,
  switchRowColumn,
  canSwitchRowColumn,
  isXYKind,
  toTsv,
} from "./chart-data.js";

const columnName = (i) => {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
};
const MIN_ROWS = 6,
  MIN_COLS = 4;

// `target()` gives the chart shape now (or null once it is gone), `read(shape)`
// its definition and `write(spec)` applies one; `seriesColor(i)` the colour a
// series is drawn in, for the header swatches.
export function openChartSheet({ title, target, read, write, seriesColor }) {
  let spec = read(target());
  if (!spec) return null;
  let grid = specToGrid(spec);
  let focus = { row: 1, col: 1 };
  let timer = null;
  let disposed = false;

  const table = el("table", {
    class: "chart-sheet-grid",
    role: "grid",
    "aria-label": "Chart data",
  });
  const status = el("p", { class: "chart-sheet-status", role: "status" });
  const tool = (label, name, run, extra = {}) =>
    el(
      "button",
      {
        type: "button",
        class: "btn icon-btn",
        "aria-label": label,
        title: label,
        onclick: run,
        ...extra,
      },
      icon(name, 16),
    );
  const head = el(
    "div",
    { class: "chart-sheet-head" },
    el("h2", { class: "chart-sheet-title", id: "chart-sheet-title" }, title),
    el(
      "div",
      { class: "chart-sheet-tools", role: "toolbar", "aria-label": "Data" },
      tool("Insert row above", "o:insertAbove", () =>
        edit(insertRow(grid, Math.max(1, focus.row)), {
          row: Math.max(1, focus.row),
          col: focus.col,
        }),
      ),
      tool("Delete row", "o:deleteRows", () =>
        edit(deleteRow(grid, focus.row), {
          row: Math.max(1, Math.min(focus.row, grid.length - 2)),
          col: focus.col,
        }),
      ),
      tool("Insert column to the left", "o:insertLeft", () =>
        edit(insertColumn(grid, Math.max(1, focus.col)), {
          row: focus.row,
          col: Math.max(1, focus.col),
        }),
      ),
      tool("Delete column", "o:deleteColumns", () =>
        edit(deleteColumn(grid, focus.col), {
          row: focus.row,
          col: Math.max(1, Math.min(focus.col, grid[0].length - 2)),
        }),
      ),
      tool("Switch Row/Column", "o:switchRowColumn", () => {
        if (isXYKind(spec.kind)) {
          toast(
            "X Y charts plot their columns as series; there is nothing to switch.",
          );
          return;
        }
        if (!canSwitchRowColumn(spec.kind)) {
          toast(
            "A pie chart plots a single series; there is nothing to switch.",
          );
          return;
        }
        commitNow();
        apply(switchRowColumn(spec), true);
      }),
      tool("Copy all data", "o:copy", () => {
        navigator.clipboard?.writeText?.(toTsv(grid)).then(
          () => (status.textContent = "Data copied as tab-separated text."),
          () => {},
        );
      }),
      tool("Close data sheet", "X", () => close()),
    ),
  );
  const panel = el(
    "section",
    {
      class: "chart-sheet",
      role: "dialog",
      "aria-modal": "false",
      "aria-labelledby": "chart-sheet-title",
      tabindex: -1,
    },
    head,
    el("div", { class: "chart-sheet-scroll" }, table),
    el(
      "p",
      { class: "chart-sheet-hint helper" },
      "Changes appear on the chart as you type. Paste rows from a spreadsheet to fill the grid.",
    ),
    status,
  );
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  dragBy(head, panel);

  function shown() {
    const rows = Math.max(grid.length + 1, MIN_ROWS);
    const cols = Math.max((grid[0]?.length || 1) + 1, MIN_COLS);
    return { rows, cols };
  }
  function draw() {
    const { rows, cols } = shown();
    const layout = gridLayout(spec);
    const used = { rows: grid.length, cols: grid[0]?.length || 0 };
    const headRow = el(
      "tr",
      {},
      el("th", { class: "corner", "aria-hidden": "true" }),
      ...Array.from({ length: cols }, (_, c) =>
        el("th", { scope: "col", class: "col-head" }, columnName(c)),
      ),
    );
    const body = [];
    for (let r = 0; r < rows; r++) {
      const tr = el(
        "tr",
        {},
        el("th", { scope: "row", class: "row-head" }, String(r + 1)),
      );
      for (let c = 0; c < cols; c++) {
        const inside = r < used.rows && c < used.cols;
        const value = inside ? (grid[r][c] ?? "") : "";
        const role =
          r === 0 && c === 0
            ? "corner-cell"
            : r === 0
              ? "series-cell"
              : c === 0
                ? "category-cell"
                : "value-cell";
        const seriesIndex =
          r === 0 && c > 0
            ? layout === "bubble"
              ? c % 2 === 1
                ? (c - 1) / 2
                : null
              : c - 1
            : null;
        const swatch =
          seriesIndex != null && inside
            ? el("span", {
                class: "chart-sheet-swatch",
                style: `background:${seriesColor(seriesIndex)}`,
                "aria-hidden": "true",
              })
            : null;
        const input = el("input", {
          class: `chart-sheet-cell ${role} ${inside ? "" : "outside"}`,
          value,
          "aria-label": `${columnName(c)}${r + 1}${describe(r, c)}`,
          inputmode: r > 0 && c > 0 ? "decimal" : null,
          tabindex: r === focus.row && c === focus.col ? 0 : -1,
          "data-row": r,
          "data-col": c,
          onfocus: () => {
            focus = { row: r, col: c };
            for (const other of table.querySelectorAll("input[tabindex='0']"))
              if (other !== input) other.tabIndex = -1;
            input.tabIndex = 0;
          },
          oninput: () => {
            setCell(r, c, input.value);
            schedule();
          },
          onchange: () => commitNow(),
          onkeydown: (e) => move(e, r, c),
          onpaste: (e) => paste(e, r, c),
        });
        tr.append(el("td", { role: "gridcell" }, swatch, input));
      }
      body.push(tr);
    }
    table.replaceChildren(el("thead", {}, headRow), el("tbody", {}, ...body));
  }
  function describe(r, c) {
    const layout = gridLayout(spec);
    if (r === 0 && c === 0) return "";
    if (r === 0)
      return layout === "bubble" && c % 2 === 0
        ? ", bubble size heading"
        : ", series name";
    if (c === 0) return layout === "category" ? ", category" : ", x value";
    return "";
  }
  function setCell(r, c, value) {
    while (grid.length <= r) grid.push(Array(grid[0]?.length || 1).fill(""));
    const width = Math.max(grid[0].length, c + 1);
    for (const row of grid) while (row.length < width) row.push("");
    grid[r][c] = value;
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => commitNow(), 280);
  }
  function commitNow() {
    clearTimeout(timer);
    timer = null;
    let next;
    try {
      next = gridToSpec(grid, spec);
    } catch (error) {
      status.textContent = error.message;
      return;
    }
    apply(next, false);
  }
  function apply(next, redraw) {
    if (JSON.stringify(next) === JSON.stringify(spec)) return;
    spec = next;
    status.textContent = "";
    Promise.resolve(write(next)).then((ok) => {
      if (ok === false)
        status.textContent = "That change could not be applied.";
    });
    if (redraw) {
      grid = specToGrid(spec);
      draw();
      focusCell(focus.row, focus.col);
    }
  }
  function edit(next, at) {
    grid = next;
    commitNow();
    draw();
    focusCell(at.row, at.col);
  }
  function focusCell(r, c) {
    const input = table.querySelector(
      `input[data-row="${r}"][data-col="${c}"]`,
    );
    if (input) {
      input.focus();
      input.select?.();
    }
  }
  function move(e, r, c) {
    const { rows, cols } = shown();
    const input = e.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd =
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length;
    let next = null;
    if (e.key === "Enter") next = [r + (e.shiftKey ? -1 : 1), c];
    else if (e.key === "Tab") next = [r, c + (e.shiftKey ? -1 : 1)];
    else if (e.key === "ArrowDown") next = [r + 1, c];
    else if (e.key === "ArrowUp") next = [r - 1, c];
    else if (e.key === "ArrowLeft" && atStart) next = [r, c - 1];
    else if (e.key === "ArrowRight" && atEnd) next = [r, c + 1];
    if (!next) return;
    const [nr, nc] = next;
    if (nr < 0 || nc < 0 || nc >= cols) {
      if (e.key === "Tab") return;
      e.preventDefault();
      return;
    }
    e.preventDefault();
    commitNow();
    if (nr >= rows - 1 || nc >= cols - 1) {
      // Typing past the end grows the sheet by one row or column.
      draw();
    }
    focusCell(nr, nc);
  }
  function paste(e, r, c) {
    const text = e.clipboardData?.getData("text/plain");
    if (!text || (!text.includes("\t") && !text.includes("\n"))) return;
    e.preventDefault();
    const block = parseTsv(text);
    grid = pasteBlock(grid, r, c, block);
    commitNow();
    draw();
    focusCell(r, c);
    status.textContent = `Pasted ${block.length} row${block.length === 1 ? "" : "s"}.`;
  }

  // The chart changed elsewhere (undo, the ribbon): show its data unless a
  // cell is being typed in.
  function sync() {
    if (disposed) return;
    const shape = target();
    if (!shape) {
      close();
      return;
    }
    if (timer) return;
    const now = read(shape);
    if (!now) {
      close();
      return;
    }
    if (JSON.stringify(now) === JSON.stringify(spec)) return;
    const typing = panel.contains(document.activeElement);
    spec = now;
    const nextGrid = specToGrid(now);
    if (typing && JSON.stringify(nextGrid) === JSON.stringify(grid)) return;
    grid = nextGrid;
    draw();
    if (typing) focusCell(focus.row, focus.col);
  }
  function close() {
    if (disposed) return;
    if (timer) commitNow();
    disposed = true;
    panel.remove();
    onClose?.();
  }
  let onClose = null;

  draw();
  document.body.append(panel);
  fitToViewport(panel);
  requestAnimationFrame(() => focusCell(1, 1));
  return {
    panel,
    sync,
    close,
    set onClose(fn) {
      onClose = fn;
    },
    get open() {
      return !disposed;
    },
  };
}

// A phone's layout can be wider than its screen; keep the window on screen.
export function fitToViewport(panel) {
  const width = document.documentElement.clientWidth;
  const rect = panel.getBoundingClientRect();
  if (rect.right <= width && rect.left >= 0) return;
  panel.style.left = "8px";
  panel.style.right = "auto";
  panel.style.width = `${Math.max(200, width - 16)}px`;
}
// The sheet moves by its title bar, inside the window.
function dragBy(handle, panel) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    const dx = e.clientX - rect.left,
      dy = e.clientY - rect.top;
    handle.setPointerCapture(e.pointerId);
    const moveTo = (ev) => {
      const x = Math.max(
        0,
        Math.min(window.innerWidth - rect.width, ev.clientX - dx),
      );
      const y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    };
    const up = () => {
      handle.removeEventListener("pointermove", moveTo);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", moveTo);
    handle.addEventListener("pointerup", up);
  });
}
