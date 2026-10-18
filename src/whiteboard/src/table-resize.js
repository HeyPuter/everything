import {
  TABLE_AXES,
  tableTracks,
  tableLayout,
  resizeTableTracks,
} from "./table-layout.js";
import { fitTableTracks, tableBorderAt } from "./table-sizing.js";
import { t } from "./i18n.js";

export function createTableResize(api) {
  let root, gesture;
  const handles = new Map();
  const world = (e) => {
    const r = api.canvas().getBoundingClientRect(),
      v = api.state().view;
    return {
      x: (e.clientX - r.left - v.x) / v.z,
      y: (e.clientY - r.top - v.y) / v.z,
    };
  };
  function valid() {
    if (!gesture) return false;
    const i = api.current(),
      v = api.state().view;
    return (
      !!i &&
      api.writable(i) &&
      api.state().board === gesture.board &&
      i.id === gesture.id &&
      i.x === gesture.x &&
      i.y === gesture.y &&
      i.cells.length === gesture.rows &&
      i.cells[0].length === gesture.cols &&
      v.x === gesture.view.x &&
      v.y === gesture.view.y &&
      v.z === gesture.view.z &&
      Math.abs(tableTracks(i, gesture.axis)[gesture.index] - gesture.base) <
        1e-8
    );
  }
  function preview() {
    if (!valid()) {
      gesture = null;
      return null;
    }
    if (!gesture.changed) return null;
    const i = api.current();
    try {
      return {
        ...i,
        ...resizeTableTracks(i, gesture.axis, [gesture.index], gesture.size),
      };
    } catch {
      gesture = null;
      return null;
    }
  }
  function cancel(redraw = true) {
    const active = !!gesture;
    gesture = null;
    if (active && redraw) api.draw();
    return active;
  }
  function start(axis, index, p, e) {
    if (gesture) return false;
    const i = api.current();
    if (!i || !api.writable(i) || e.button !== 0 || !api.finish()) return false;
    const live = api.current();
    gesture = {
      axis,
      index,
      pointerId: e.pointerId,
      id: live.id,
      board: api.state().board,
      x: live.x,
      y: live.y,
      rows: live.cells.length,
      cols: live.cells[0].length,
      base: tableTracks(live, axis)[index],
      point: p,
      view: { ...api.state().view },
      changed: false,
    };
    e.preventDefault();
    api.draw();
    return true;
  }
  function move(p) {
    if (!gesture) return false;
    if (!valid()) {
      cancel();
      return true;
    }
    const axis = gesture.axis,
      coordinate = axis === "column" ? "x" : "y",
      delta = p[coordinate] - gesture.point[coordinate];
    if (Math.abs(delta) * gesture.view.z < 3 && !gesture.changed) return true;
    const i = api.current(),
      values = tableTracks(i, axis),
      remaining = values.reduce(
        (sum, value, n) => (n === gesture.index ? sum : sum + value),
        0,
      );
    const maximum = 1e6 - remaining - 1e-8;
    if (maximum < TABLE_AXES[axis].minimum) {
      cancel();
      return true;
    }
    gesture.size = Math.max(
      TABLE_AXES[axis].minimum,
      Math.min(maximum, gesture.base + delta),
    );
    gesture.changed = Math.abs(gesture.size - gesture.base) > 1e-8;
    api.draw();
    return true;
  }
  function end(abort = false) {
    if (!gesture) return false;
    const g = gesture,
      commit = !abort && valid() && g.changed;
    gesture = null;
    if (commit) apply(g.axis, [g.index], g.size);
    else api.draw();
    return true;
  }
  // A key held on a handle passes its event on, so its repeats make one
  // undo step.
  function apply(axis, indices, mode, key) {
    if (!api.finish()) return;
    const i = api.current();
    if (!i || !api.writable(i)) return;
    try {
      const sizes = tableTracks(i, axis);
      const patch =
        mode === "fit"
          ? fitTableTracks(i, axis, indices, api.canvas().getContext("2d"))
          : resizeTableTracks(
              i,
              axis,
              indices,
              mode === "equal"
                ? indices.reduce((total, n) => total + sizes[n], 0) /
                    indices.length
                : mode,
            );
      if (
        tableTracks({ ...i, ...patch }, axis).every(
          (value, n) => Math.abs(value - sizes[n]) < 1e-8,
        )
      )
        return;
      api.commit(i, patch, key);
    } catch (error) {
      api.error(error.message);
    }
    api.draw();
  }
  function selected(axis) {
    const r = api.range();
    return Array.from(
      { length: axis === "column" ? r.cols : r.rows },
      (_, n) => n + (axis === "column" ? r.c : r.r),
    );
  }
  function bind(element) {
    root = element;
    handles.clear();
    gesture = null;
    const controls = root.ownerDocument.createElement("div");
    controls.className = "table-size-controls";
    controls.innerHTML = ["column", "row"]
      .map(
        (axis) =>
          `<label>${t(axis === "column" ? "Column width" : "Row height")}<input type="number" id="table-${axis}-size" min="${TABLE_AXES[axis].minimum}" max="1000000" step="1" placeholder="${t("Mixed")}" aria-label="${t(axis === "column" ? "Column width" : "Row height")}"></label><button type="button" class="text-btn" data-table-size="${axis}:fit">${t(axis === "column" ? "Fit columns to text" : "Fit rows to text")}</button><button type="button" class="text-btn" data-table-size="${axis}:equal">${t(axis === "column" ? "Equal column widths" : "Equal row heights")}</button>`,
      )
      .join("");
    root.querySelector(".table-cell-tools").append(controls);
    for (const axis of ["column", "row"]) {
      const field = controls.querySelector(`#table-${axis}-size`);
      field.onchange = () => {
        apply(axis, selected(axis), field.valueAsNumber);
        render();
      };
      field.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          apply(axis, selected(axis), field.valueAsNumber);
        }
      };
      const handle = root.ownerDocument.createElement("button");
      handle.type = "button";
      handle.className = `table-size-handle table-size-${axis}`;
      handle.dataset.tableResize = axis;
      handle.setAttribute("role", "separator");
      handle.setAttribute(
        "aria-orientation",
        axis === "column" ? "vertical" : "horizontal",
      );
      handle.innerHTML = `<span aria-hidden="true">${axis === "column" ? "↔" : "↕"}</span>`;
      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (start(axis, selected(axis).at(-1), world(e), e)) {
          handle.focus({ preventScroll: true });
          try {
            handle.setPointerCapture?.(e.pointerId);
          } catch {}
        }
      });
      handle.addEventListener("pointermove", (e) => {
        if (gesture?.pointerId === e.pointerId) move(world(e));
      });
      handle.addEventListener("pointerup", (e) => {
        if (gesture?.pointerId === e.pointerId) {
          move(world(e));
          end();
        }
      });
      for (const type of ["pointercancel", "lostpointercapture"])
        handle.addEventListener(type, (e) => {
          if (gesture?.pointerId === e.pointerId) cancel();
        });
      handle.ondblclick = (e) => {
        e.preventDefault();
        apply(axis, [selected(axis).at(-1)], "fit");
      };
      handle.onkeydown = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
          api.canvas().focus();
        }
        const delta = {
          ArrowRight: axis === "column" ? 1 : 0,
          ArrowLeft: axis === "column" ? -1 : 0,
          ArrowDown: axis === "row" ? 1 : 0,
          ArrowUp: axis === "row" ? -1 : 0,
        }[e.key];
        if (delta && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          const index = selected(axis).at(-1);
          apply(
            axis,
            [index],
            Math.max(
              TABLE_AXES[axis].minimum,
              tableTracks(api.current(), axis)[index] +
                delta * (e.shiftKey ? 10 : 1),
            ),
            e,
          );
        }
      };
      root.append(handle);
      handles.set(axis, handle);
    }
    for (const b of controls.querySelectorAll("button"))
      b.onclick = () => {
        const [axis, mode] = b.dataset.tableSize.split(":");
        apply(axis, selected(axis), mode);
      };
  }
  function render() {
    if (!root?.isConnected || !api.current()) return;
    const i = preview() || api.current(),
      v = api.state().view,
      size = api.canvas().getBoundingClientRect(),
      layout = tableLayout(i),
      writable = api.writable(api.current()),
      tools = root.querySelector(".table-cell-tools")?.getBoundingClientRect();
    for (const axis of ["column", "row"]) {
      const indices = selected(axis),
        values = tableTracks(i, axis),
        index = indices.at(-1),
        field = root.querySelector(`#table-${axis}-size`),
        handle = handles.get(axis);
      if (root.ownerDocument.activeElement !== field)
        field.value = indices.every(
          (n) => Math.abs(values[n] - values[indices[0]]) < 1e-8,
        )
          ? String(Math.round(values[indices[0]] * 100) / 100)
          : "";
      field.disabled = !writable;
      root
        .querySelectorAll(`[data-table-size^="${axis}:"]`)
        .forEach((b) => (b.disabled = !writable));
      const x =
        v.x + i.x * v.z + (axis === "column" ? layout.x[index + 1] * v.z : -24);
      let y =
        v.y + i.y * v.z + (axis === "row" ? layout.y[index + 1] * v.z : -24);
      // Above a table whose top is under the table's toolbar, the column
      // handle sits just below the toolbar, where it can be reached.
      if (axis === "column" && tools?.width) {
        const below = tools.bottom - size.top + 26;
        if (
          y < below &&
          x + 22 > tools.left - size.left &&
          x - 22 < tools.right - size.left
        )
          y = Math.min(below, v.y + (i.y + i.h) * v.z);
      }
      handle.hidden =
        !writable ||
        api.editing() ||
        !!(
          size.width &&
          (x < 22 || y < 22 || x > size.width - 22 || y > size.height - 22)
        );
      handle.style.left = `${x}px`;
      handle.style.top = `${y}px`;
      handle.setAttribute(
        "aria-label",
        `${t(axis === "column" ? "Resize column" : "Resize row")} ${index + 1}`,
      );
      handle.setAttribute("aria-valuemin", String(TABLE_AXES[axis].minimum));
      handle.setAttribute("aria-valuemax", "1000000");
      handle.setAttribute("aria-valuenow", String(Math.round(values[index])));
    }
  }
  return {
    bind,
    render,
    preview,
    cancel,
    move,
    end,
    cursor(p) {
      const i = api.current();
      if (!i || api.editing() || !api.writable(i)) return "default";
      const hit = tableBorderAt(i, p, 6 / api.state().view.z);
      return hit
        ? hit.axis === "column"
          ? "col-resize"
          : "row-resize"
        : "default";
    },
    down(e, p) {
      if (api.editing()) return false;
      const i = api.current(),
        hit = i && tableBorderAt(i, p, 6 / api.state().view.z);
      return hit ? start(hit.axis, hit.index, p, e) : false;
    },
    keydown(e) {
      if (gesture && e.key === "Escape") {
        e.preventDefault();
        cancel();
        return true;
      }
      return false;
    },
  };
}
