import { fold } from "./libraries.js";
import { item, validateBoard, bounds, truncate, MAX_OBJECTS } from "./model.js";
import { language, t } from "./i18n.js";
import { planMindReparent } from "./mind-map-drag.js";
import { inferMovedParents } from "./scene.js";
import { mindAncestors, visibleMindItems } from "./mind-visibility.js";
import {
  mindIndex,
  mindRoot,
  mindBranch,
  applyMindLayout,
  mindNavigate,
  MIND_DIRECTIONS,
} from "./mind-map.js";
import { keepPageFocus } from "./paging.js";
import { authoredTextHTML } from "./accessibility/object-content.js";

export function createMindMapUI(api) {
  const source = () => (api.source()?.mindMap ? api.source() : null);
  const working = () =>
    api
      .board()
      .items.map((i) => (i.mindMap ? { ...i, mindMap: { ...i.mindMap } } : i));
  // The objects `next` changes or adds.
  function changes(next, before) {
    return next.filter((i) => {
      const old = before.get(i.id);
      return (
        !old ||
        ["x", "y", "order", "mindMap", "mindCollapsed", "parentId"].some(
          (k) => JSON.stringify(i[k]) !== JSON.stringify(old[k]),
        )
      );
    });
  }
  // Laying a map out again moves its other nodes too, so a locked one there
  // refuses the change. The refusal names it: the lock also protects the
  // nodes above it, so a selection holding no locked object is refused too.
  function refusePinned(patch, before) {
    const pinned = patch.map((i) => before.get(i.id)).find((i) => i?.locked);
    if (pinned)
      throw Error(
        t("Unlock “{name}” first: the mind map’s layout moves it.").replace(
          "{name}",
          () =>
            truncate(pinned.text?.replace(/\s+/g, " ").trim(), 60) ||
            t("Untitled node"),
        ),
      );
  }
  function commit(next, selected, edit = false, overview = false) {
    const board = api.board(),
      before = new Map(board.items.map((i) => [i.id, i]));
    if (next.length > MAX_OBJECTS)
      throw Error("A board can contain at most 5,000 objects.");
    validateBoard({ ...board, items: next });
    const patch = changes(next, before);
    if (!patch.length) return true;
    refusePinned(patch, before);
    if (
      !api.canEdit(
        new Set(patch.filter((i) => before.has(i.id)).map((i) => i.id)),
      )
    )
      return false;
    api.mutate(() => {
      for (const i of patch) {
        const old = before.get(i.id);
        if (old) {
          old.x = i.x;
          old.y = i.y;
          if (i.order !== undefined) old.order = i.order;
          if (i.mindMap) old.mindMap = { ...i.mindMap };
          if (i.mindCollapsed !== undefined)
            old.mindCollapsed = i.mindCollapsed;
          if (i.parentId) old.parentId = i.parentId;
          else delete old.parentId;
        } else board.items.push(i);
      }
      api.select(new Set([selected]));
    });
    // A refused save, as on a board the facilitator froze, leaves no node
    // to show; the refusal says why.
    const node = api.board()?.items.find((i) => i.id === selected);
    if (!node) return false;
    if (overview) {
      const index = mindIndex(board.items),
        root = mindRoot(index, selected);
      api.reveal(
        bounds(
          visibleMindItems(
            [...mindBranch(index, root.id)].map((id) => index.nodes.get(id)),
          ),
        ),
        true,
      );
    } else api.reveal(node);
    if (edit) api.edit(node);
    else api.focus();
    return true;
  }
  function run(fn) {
    try {
      return fn();
    } catch (e) {
      api.toast(e.message);
      return false;
    }
  }
  function add(sibling = false, direction) {
    const id = source()?.id;
    if (!id) return;
    api.finish();
    run(() => {
      const next = working(),
        index = mindIndex(next),
        selected = index.nodes.get(id);
      if (!selected || !api.canEdit(new Set())) return;
      const parent = sibling
        ? index.nodes.get(selected.mindMap.parent) || selected
        : selected;
      for (const node of [parent, ...mindAncestors(next, parent.id)])
        if (node.mindCollapsed) node.mindCollapsed = false;
      const root = mindRoot(index, parent.id),
        children = index.children.get(parent.id) || [];
      const node = item("rect", parent.x + parent.w + 80, parent.y, {
        w: 200,
        h: 76,
        color: parent.color || "#ffffff",
        fontSize: parent.fontSize || 20,
        fontFamily: parent.fontFamily || "dm-sans",
        textAlign: "center",
        autoFontSize: true,
        text: t("New idea"),
        lang: language,
        order: Math.max(0, ...children.map((i) => i.order || 0)) + 1,
        ...(parent.parentId ? { parentId: parent.parentId } : {}),
        mindMap: {
          parent: parent.id,
          direction: direction || selected.mindMap.direction,
          auto: true,
          line: root.mindMap.line,
        },
      });
      next.push(node);
      if (root.mindMap.auto) applyMindLayout(next, root.id);
      else {
        // Lay out a temporary branch to choose a non-overlapping insertion point
        // without moving the existing manual arrangement.
        // The branch is laid out where automatic layout would put it, so the
        // new node keeps its place beside the parent, wherever that was moved.
        const projected = next.map((i) => (i.mindMap ? { ...i } : i));
        applyMindLayout(projected, root.id);
        const position = projected.find((i) => i.id === node.id),
          placed = projected.find((i) => i.id === parent.id);
        node.x = position.x + parent.x - placed.x;
        node.y = position.y + parent.y - placed.y;
        const horizontal = ["right", "left"].includes(node.mindMap.direction);
        const axis = horizontal ? "y" : "x",
          size = horizontal ? "h" : "w";
        // Only branches on the new node's side of the parent are in its way.
        for (const i of children)
          if (i.mindMap.direction === node.mindMap.direction)
            node[axis] = Math.max(node[axis], i[axis] + i[size] + 28);
      }
      // A locked node the new one would move is named before the nodes it
      // protects are refused.
      const before = new Map(api.board().items.map((i) => [i.id, i]));
      refusePinned(changes(next, before), before);
      if (!api.canEdit(new Set([id])) || !api.canEdit(new Set([parent.id])))
        return;
      commit(next, node.id, true);
    });
  }
  function create() {
    api.finish();
    run(() => {
      if (!api.canEdit(new Set())) return;
      const p = api.center(),
        node = item("rect", p.x - 110, p.y - 45, {
          w: 220,
          h: 90,
          text: t("Central idea"),
          lang: language,
          fontSize: 24,
          textAlign: "center",
          color: "#dce5f7",
          autoFontSize: true,
          mindMap: {
            parent: null,
            direction: "right",
            auto: true,
            line: "curved",
          },
        });
      commit([...api.board().items, node], node.id, true);
    });
  }
  function layout(direction) {
    const id = source()?.id;
    if (!id) return;
    api.finish();
    run(() => {
      const next = working(),
        index = mindIndex(next),
        root = mindRoot(index, id);
      if (!root) return;
      if (direction)
        for (const child of mindBranch(index, root.id))
          index.nodes.get(child).mindMap.direction = direction;
      applyMindLayout(next, root.id);
      commit(next, id, false, true);
    });
  }
  function reorder(delta) {
    const id = source()?.id;
    if (!id) return;
    api.finish();
    run(() => {
      const next = working(),
        index = mindIndex(next),
        node = index.nodes.get(id);
      if (!node?.mindMap.parent) return;
      const parent = index.nodes.get(node.mindMap.parent),
        all = index.children.get(parent.id) || [];
      // A root's children are drawn per side, so the branches moved past are
      // those on this side; the other sides keep their places.
      const beside = (i) =>
        index.nodes.has(parent.mindMap.parent) ||
        i.mindMap.direction === node.mindMap.direction;
      const rows = all.filter(beside),
        at = rows.findIndex((i) => i.id === id);
      if (!rows[at + delta]) return;
      [rows[at], rows[at + delta]] = [rows[at + delta], rows[at]];
      let n = 0;
      all
        .map((i) => (beside(i) ? rows[n++] : i))
        .forEach((i, k) => (i.order = k + 1));
      const root = mindRoot(index, id);
      if (root.mindMap.auto) applyMindLayout(next, root.id);
      commit(next, id, false, true);
    });
  }
  function reparent(id, target) {
    if (!api.canEdit(new Set([id, ...(target ? [target] : [])]))) return false;
    // The branch belongs to the frame it now lies in, as when it is dragged
    // to its new parent; one left in its old frame would go with that frame.
    const next = planMindReparent(api.board(), id, target).items.map((i) => ({
      ...i,
    }));
    inferMovedParents(next, mindBranch(mindIndex(next), id), {
      skip: api.concealed?.(),
    });
    return commit(next, id, false, true);
  }
  function moveDialog() {
    const id = source()?.id;
    if (!id) return;
    api.finish();
    const board = api.board(),
      initial = JSON.stringify(board.items.find((i) => i.id === id)?.mindMap);
    api.modal(
      "Move mind map branch",
      `<label class="field">${t("Find parent node")}<input id="mind-parent-search" maxlength="200"></label><button class="secondary" id="mind-detach">${t("Make a separate mind map")}</button><div id="mind-parent-results" class="object-list"></div><p class="dialog-copy" id="mind-parent-count" role="status"></p><div class="dialog-footer"><button class="secondary" id="mind-parent-prev">${t("Previous page")}</button><button class="secondary" id="mind-parent-next">${t("Next page")}</button></div>`,
      (d) => {
        const move = (target) =>
          run(() => {
            if (
              api.board() !== board ||
              JSON.stringify(board.items.find((i) => i.id === id)?.mindMap) !==
                initial
            )
              throw Error("This mind map changed. Reopen its controls.");
            if (reparent(id, target)) d.close();
          });
        d.querySelector("#mind-detach").onclick = () => move(null);
        let offset = 0;
        const render = () => {
          const index = mindIndex(board.items),
            excluded = mindBranch(index, id),
            hidden = api.concealed?.() || new Set(),
            query = fold(d.querySelector("input").value);
          // Nodes hidden from this person are neither listed nor searched.
          const candidates = [...index.nodes.values()].filter(
            (i) =>
              !excluded.has(i.id) &&
              !hidden.has(i.id) &&
              fold(i.text || "").includes(query),
          );
          const list = d.querySelector("#mind-parent-results");
          list.replaceChildren();
          offset = Math.max(
            0,
            Math.min(
              offset,
              Math.floor(Math.max(0, candidates.length - 1) / 50) * 50,
            ),
          );
          for (const i of candidates.slice(offset, offset + 50)) {
            const button = document.createElement("button");
            button.className = "secondary";
            button.dataset.mindParent = i.id;
            if (i.text) button.innerHTML = authoredTextHTML(i);
            else button.textContent = t("Untitled node");
            button.dataset.userContent = "";
            button.onclick = () => move(i.id);
            list.append(button);
          }
          d.querySelector("#mind-parent-count").textContent =
            `${candidates.length ? offset + 1 : 0}–${Math.min(offset + 50, candidates.length)} / ${candidates.length}`;
          d.querySelector("#mind-parent-prev").disabled = offset === 0;
          d.querySelector("#mind-parent-next").disabled =
            offset + 50 >= candidates.length;
        };
        d.querySelector("input").oninput = () => {
          offset = 0;
          render();
        };
        const previous = d.querySelector("#mind-parent-prev"),
          next = d.querySelector("#mind-parent-next");
        previous.onclick = () => {
          offset -= 50;
          render();
          keepPageFocus(previous, next);
        };
        next.onclick = () => {
          offset += 50;
          render();
          keepPageFocus(next, previous);
        };
        render();
      },
    );
  }
  function settings() {
    const id = source()?.id;
    if (!id) return;
    api.finish();
    const board = api.board(),
      root = mindRoot(mindIndex(board.items), id),
      initial = JSON.stringify(root.mindMap);
    api.modal(
      "Mind map",
      `<form><label class="field">${t("Branch direction")}<select id="mind-direction"><option value="">${t("Keep current directions")}</option>${MIND_DIRECTIONS.map((dir) => `<option value="${dir}">${t({ right: "Right", left: "Left", down: "Down", up: "Up" }[dir])}</option>`).join("")}</select></label><label class="field">${t("Branch lines")}<select id="mind-lines"><option value="curved">${t("Curved")}</option><option value="straight">${t("Straight")}</option></select></label><label class="check-row"><input type="checkbox" id="mind-auto" ${root.mindMap.auto ? "checked" : ""}>${t("Automatically lay out new branches")}</label><p class="dialog-copy">${t("Moving a child without reassignment, or resizing it, switches to manual layout.")}</p><p class="dialog-copy">${t("Tab adds a child · Enter adds a sibling · Shift+Enter adds a line · Arrow keys navigate nodes")}</p><div class="dialog-footer"><button class="secondary" type="button" id="mind-tidy">${t("Layout nodes")}</button><button class="primary">${t("Save changes")}</button></div></form>`,
      (d) => {
        d.querySelector("#mind-lines").value = root.mindMap.line;
        const apply = (force) =>
          run(() => {
            const next = working(),
              index = mindIndex(next),
              current = index.nodes.get(root.id);
            if (
              api.board() !== board ||
              !current ||
              JSON.stringify(current.mindMap) !== initial
            )
              throw Error("This mind map changed. Reopen its controls.");
            const direction = d.querySelector("#mind-direction").value,
              auto = d.querySelector("#mind-auto").checked,
              line = d.querySelector("#mind-lines").value;
            current.mindMap.auto = auto;
            for (const child of mindBranch(index, current.id)) {
              const node = index.nodes.get(child);
              if (direction) node.mindMap.direction = direction;
              node.mindMap.line = line;
            }
            if (force || auto || direction) applyMindLayout(next, current.id);
            if (commit(next, id, false, true)) d.close();
          });
        d.querySelector("form").onsubmit = (e) => {
          e.preventDefault();
          apply(false);
        };
        d.querySelector("#mind-tidy").onclick = () => apply(true);
      },
    );
  }
  function keydown(e, editing = false) {
    const node = source();
    if (
      !node ||
      e.defaultPrevented ||
      e.isComposing ||
      e.keyCode === 229 ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.shiftKey ||
      e.target.closest?.("button,a,select")
    )
      return false;
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) add(e.key === "Enter");
      return true;
    }
    if (!editing && e.key === "F2") {
      e.preventDefault();
      api.edit(node);
      return true;
    }
    if (!editing && e.key.startsWith("Arrow")) {
      const forward = {
        right: "ArrowRight",
        left: "ArrowLeft",
        up: "ArrowUp",
        down: "ArrowDown",
      }[node.mindMap.direction];
      if (api.collapsed?.(node.id) && e.key === forward) {
        e.preventDefault();
        api.toggle(node.id);
        return true;
      }
      const next = mindNavigate(mindIndex(api.board().items), node.id, e.key);
      e.preventDefault();
      // Entering a collapsed branch from any side expands it first.
      if (next?.mindMap.parent === node.id && api.collapsed?.(node.id)) {
        api.toggle(node.id);
        return true;
      }
      // A node hidden from this person is not selected or shown.
      if (next && !api.concealed?.().has(next.id)) {
        api.select(new Set([next.id]));
        api.reveal(next);
        api.draw();
      }
      return true;
    }
    return false;
  }
  return { create, add, layout, reorder, settings, moveDialog, keydown };
}
