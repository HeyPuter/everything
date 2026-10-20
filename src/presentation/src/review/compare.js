// Compare: another version of the presentation is opened beside this one
// and its differences listed per slide in the Revisions pane: slides it adds
// or removes, objects whose text or form changed, objects it adds or
// removes, and changed speaker notes. Each can be accepted (this deck takes
// the other version's) or rejected (left as it is); Accept All takes them
// all. The other file is only read.
import { el, icon, iconButton, toast } from "../ui.js";
import {
  P,
  parseDeck,
  visibleSlideShapes,
  slideTitle,
  shapeLabel,
  removeSlides,
} from "../model.js";

// ---- Matching ---------------------------------------------------------------

// Pairs of indices of a longest common subsequence of keys; a null key never
// matches.
export function lcsPairs(a, b) {
  const n = a.length,
    m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        a[i] != null && a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] != null && a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Aligns two lists: matches by the first key wherever it can, then fills the
 * gaps between those matches with the next key, and so on. Returns pairs of
 * indices in order.
 */
export function alignLists(a, b, keys) {
  const out = [];
  const walk = (ai, bi, level) => {
    if (!ai.length || !bi.length || level >= keys.length) return;
    const key = keys[level];
    const pairs = lcsPairs(
      ai.map((i) => key(a[i], "a")),
      bi.map((j) => key(b[j], "b")),
    );
    let pa = 0,
      pb = 0;
    for (const [x, y] of pairs) {
      walk(ai.slice(pa, x), bi.slice(pb, y), level + 1);
      out.push([ai[x], bi[y]]);
      pa = x + 1;
      pb = y + 1;
    }
    walk(ai.slice(pa), bi.slice(pb), level + 1);
  };
  walk(
    a.map((_, i) => i),
    b.map((_, j) => j),
    0,
  );
  return out.sort((x, y) => x[0] - y[0]);
}

// ---- Differences -------------------------------------------------------------

const topLevel = (slide) => {
  const shapes = P.getSlideShapes(slide);
  const nested = new Set();
  for (const s of shapes)
    if (P.getShapeKind(s) === "group")
      for (const c of P.getGroupChildren(s)) nested.add(P.getShapeId(c));
  return shapes.filter((s) => !nested.has(P.getShapeId(s)));
};
const textOf = (shape) => {
  try {
    return P.getShapeText(shape) || "";
  } catch {
    return "";
  }
};
// The object's form: where it is, its size, turn and flips, its outline
// shape and, for a picture, which image it shows. Formatting written out in
// full when a slide is copied in does not count as a change.
const formOf = (shape) => {
  const xml = P.getShapeXmlString(shape);
  return JSON.stringify([
    P.getShapeKind(shape),
    P.getShapeBounds(shape),
    P.getShapeRotation(shape),
    P.getShapeFlip(shape),
    /<a:prstGeom prst="([^"]+)"/.exec(xml)?.[1] || null,
    /<a:custGeom/.test(xml),
    P.getShapeKind(shape) === "picture" ? imageSize(shape) : null,
  ]);
};
const imageSize = (shape) => {
  try {
    return P.getShapeImageBytes(shape)?.byteLength ?? null;
  } catch {
    return null;
  }
};
// How much two texts share: the Jaccard index of their words.
export function similarity(a, b) {
  const words = (t) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const x = words(a),
    y = words(b);
  if (!x.size && !y.size) return 1;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}
const slideText = (slide) =>
  visibleSlideShapes(slide).map(textOf).join("\n").trim();

/**
 * The differences between `mine` and `theirs`: [{ id, type, aPart, bPart,
 * aIndex, bIndex, shapeId, label }], with `type` one of slideInserted,
 * slideDeleted, textChanged, objectChanged, objectInserted, objectDeleted,
 * notesChanged. Accepting an item makes `mine` match `theirs` there.
 */
export function diffDecks(mine, theirs) {
  const A = P.getSlides(mine),
    B = P.getSlides(theirs);
  const sig = (s) => `${slideTitle(s) || ""}\u0000${slideText(s)}`;
  // Slides paired only by position in the file are kept apart when they
  // have little in common: one was removed and another added.
  const pairs = alignLists(A, B, [
    sig,
    (s) => (slideTitle(s) || "").trim() || null,
    (s) => P.getSlideNumericId(s),
  ]).filter(
    ([i, j]) =>
      ((slideTitle(A[i]) || "").trim() !== "" &&
        (slideTitle(A[i]) || "").trim() === (slideTitle(B[j]) || "").trim()) ||
      similarity(slideText(A[i]), slideText(B[j])) >= 0.3,
  );
  const items = [];
  const matchedA = new Set(pairs.map((p) => p[0]));
  const matchedB = new Set(pairs.map((p) => p[1]));
  A.forEach((s, i) => {
    if (matchedA.has(i)) return;
    items.push({
      type: "slideDeleted",
      aPart: P.getSlidePartName(s),
      aIndex: i,
      bIndex: null,
      label: slideTitle(s) || slideText(s).split("\n")[0] || "Untitled slide",
    });
  });
  B.forEach((s, j) => {
    if (matchedB.has(j)) return;
    // It goes after the slide of mine that matches the one before it there.
    const before = pairs.filter((p) => p[1] < j).at(-1);
    items.push({
      type: "slideInserted",
      bPart: P.getSlidePartName(s),
      bIndex: j,
      aIndex: before ? before[0] + 0.5 : -0.5,
      label: slideTitle(s) || slideText(s).split("\n")[0] || "Untitled slide",
    });
  });
  for (const [i, j] of pairs) {
    const a = A[i],
      b = B[j];
    const aPart = P.getSlidePartName(a),
      bPart = P.getSlidePartName(b);
    const aShapes = topLevel(a),
      bShapes = topLevel(b);
    const aById = new Map(aShapes.map((s) => [P.getShapeId(s), s]));
    const bById = new Map(bShapes.map((s) => [P.getShapeId(s), s]));
    const base = { aPart, bPart, aIndex: i, bIndex: j };
    for (const [id, sa] of aById) {
      const sb = bById.get(id);
      if (!sb) {
        items.push({
          ...base,
          type: "objectDeleted",
          shapeId: id,
          label: shapeLabel(sa, mine),
        });
        continue;
      }
      if (textOf(sa) !== textOf(sb))
        items.push({
          ...base,
          type: "textChanged",
          shapeId: id,
          label: shapeLabel(sb, theirs),
          before: textOf(sa),
          after: textOf(sb),
        });
      else if (formOf(sa) !== formOf(sb))
        items.push({
          ...base,
          type: "objectChanged",
          shapeId: id,
          label: shapeLabel(sb, theirs),
        });
    }
    for (const [id, sb] of bById)
      if (!aById.has(id))
        items.push({
          ...base,
          type: "objectInserted",
          shapeId: id,
          label: shapeLabel(sb, theirs),
        });
    const na = (P.getSlideNotes(a) || "").trim(),
      nb = (P.getSlideNotes(b) || "").trim();
    if (na !== nb)
      items.push({
        ...base,
        type: "notesChanged",
        label: "Speaker notes",
        before: na,
        after: nb,
      });
  }
  for (const item of items)
    item.id = [
      item.type,
      item.aPart || "",
      item.bPart || "",
      item.shapeId ?? "",
    ].join("|");
  const order = { slideDeleted: 0, slideInserted: 0, notesChanged: 2 };
  return items.sort(
    (x, y) =>
      (x.aIndex ?? 0) - (y.aIndex ?? 0) ||
      (order[x.type] ?? 1) - (order[y.type] ?? 1),
  );
}

export const DESCRIBE = {
  slideInserted: "Slide inserted",
  slideDeleted: "Slide deleted",
  textChanged: "Text changed",
  objectChanged: "Object changed",
  objectInserted: "Object inserted",
  objectDeleted: "Object deleted",
  notesChanged: "Notes changed",
};

// ---- Accepting ---------------------------------------------------------------

const slideByPart = (pres, part) =>
  P.getSlides(pres).find((s) => P.getSlidePartName(s) === part) || null;
const layoutFor = (pres, source) => {
  const name = P.getSlideLayout(source)
    ? P.getSlideLayoutName(P.getSlideLayout(source))
    : null;
  const layouts = P.getSlideLayouts(pres);
  return layouts.find((l) => P.getSlideLayoutName(l) === name) || layouts[0];
};
const IMPORT = {
  preserveTextFormatting: true,
  preservePaintFormatting: true,
};

// Runs `work(temp)` with their slide brought into this package for a moment.
function withImported(mine, theirSlide, work) {
  const temp = P.importSlide(
    mine,
    theirSlide,
    layoutFor(mine, theirSlide),
    IMPORT,
  );
  try {
    return work(temp);
  } finally {
    P.removeSlide(mine, temp);
    P.compactPackage(mine);
  }
}

/** Makes `mine` match `theirs` for one item. Returns false if it could not. */
export function acceptChange(mine, theirs, item) {
  const a = item.aPart ? slideByPart(mine, item.aPart) : null;
  const b = item.bPart ? slideByPart(theirs, item.bPart) : null;
  switch (item.type) {
    case "slideDeleted":
      if (!a) return false;
      removeSlides(mine, [a]);
      return true;
    case "slideInserted": {
      if (!b) return false;
      const added = P.importSlide(mine, b, layoutFor(mine, b), IMPORT);
      const notes = P.getSlideNotes(b);
      if (notes) P.setSlideNotes(added, notes);
      P.moveSlide(mine, added, Math.max(0, Math.ceil(item.aIndex)));
      return true;
    }
    case "objectDeleted": {
      const shape = a && P.findShapeById(a, item.shapeId);
      if (!shape) return false;
      P.removeShape(shape);
      return true;
    }
    case "textChanged":
    case "objectChanged":
    case "objectInserted": {
      if (!a || !b) return false;
      return withImported(mine, b, (temp) => {
        const source = P.findShapeById(temp, item.shapeId);
        if (!source) return false;
        // The slide as it is now: the import read the slides afresh.
        const target = slideByPart(mine, item.aPart);
        const old =
          item.type === "objectInserted"
            ? null
            : P.findShapeById(target, item.shapeId);
        const tops = topLevel(target);
        const z = old ? tops.indexOf(old) : tops.length;
        if (old) P.removeShape(old);
        const [copy] = P.copyShapes(target, [source], IMPORT);
        if (!P.findShapeById(target, item.shapeId))
          P.setShapeIdentifier(copy, item.shapeId);
        const placed = P.findShapeById(target, item.shapeId) || copy;
        P.setShapeZIndex(placed, z);
        return true;
      });
    }
    case "notesChanged":
      if (!a) return false;
      P.setSlideNotes(a, item.after || "");
      return true;
  }
  return false;
}

// ---- The Revisions pane --------------------------------------------------------

export function createCompare(env, host) {
  const state = {
    theirs: null,
    name: "",
    rejected: new Set(),
    items: [],
    busy: false,
  };
  const pending = () => state.items.filter((i) => !state.rejected.has(i.id));
  function recompute() {
    state.items =
      state.theirs && env.pres() ? diffDecks(env.pres(), state.theirs) : [];
  }

  function pick() {
    return new Promise((resolve) => {
      const input = el("input", {
        type: "file",
        accept:
          ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation",
        hidden: true,
      });
      input.addEventListener("change", () => {
        resolve(input.files?.[0] || null);
        input.remove();
      });
      input.addEventListener("cancel", () => {
        resolve(null);
        input.remove();
      });
      document.body.append(input);
      input.click();
    });
  }
  async function start(file = null) {
    file ??= await pick();
    if (!file) return;
    let theirs;
    try {
      theirs = await parseDeck(new Uint8Array(await file.arrayBuffer()), {
        prepareFonts: false,
      });
    } catch (e) {
      env.fail(
        new Error(
          `That file could not be opened for comparing: ${e.message || e}`,
        ),
      );
      return;
    }
    await env.settled?.();
    state.theirs = theirs;
    state.name = file.name || "the other presentation";
    state.rejected = new Set();
    recompute();
    host.open("revisions");
    if (!state.items.length) toast("The presentations are the same.");
  }

  async function accept(items) {
    if (!items.length || state.busy) return;
    if (env.blocksEdits()) return env.blockedEdit();
    state.busy = true;
    try {
      // Each accepted item is matched again against a fresh comparison, as
      // slides and objects move under earlier ones.
      await env.mutate(() => {
        let done = 0;
        for (const item of items) {
          const fresh = diffDecks(env.pres(), state.theirs).find(
            (x) =>
              x.id === item.id ||
              (x.type === item.type &&
                x.bPart === item.bPart &&
                x.shapeId === item.shapeId &&
                x.label === item.label),
          );
          if (fresh && acceptChange(env.pres(), state.theirs, fresh)) done++;
        }
        if (!done) return env.SKIP;
      });
    } finally {
      state.busy = false;
    }
    recompute();
    host.refresh("revisions");
  }
  function reject(items) {
    for (const i of items) state.rejected.add(i.id);
    host.refresh("revisions");
  }
  function end() {
    state.theirs = null;
    state.items = [];
    state.rejected = new Set();
    host.close();
    env.syncToolbar();
  }

  function show(item) {
    const part = item.aPart;
    if (!part) return;
    const slide = P.getSlides(env.pres()).find(
      (s) => P.getSlidePartName(s) === part,
    );
    if (!slide) return;
    env.showObjects(
      part,
      item.shapeId != null && item.type !== "objectInserted"
        ? [item.shapeId]
        : [],
    );
  }

  function render() {
    const wrap = el("div", { class: "revisions-pane" });
    if (!state.theirs) {
      wrap.append(
        el(
          "div",
          { class: "review-empty" },
          icon("o:compare", 32),
          el("p", {}, "Compare this presentation with another version of it."),
          el(
            "button",
            { type: "button", class: "btn primary", onclick: () => start() },
            "Choose a File…",
          ),
        ),
      );
      return wrap;
    }
    const list = pending();
    wrap.append(
      el(
        "p",
        { class: "helper" },
        `Changes in ${state.name}, compared with this presentation.`,
      ),
      el(
        "div",
        { class: "review-footer top" },
        el(
          "span",
          { class: "review-status", role: "status" },
          list.length
            ? `${list.length} change${list.length === 1 ? "" : "s"}`
            : "No changes left to review.",
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn secondary small",
            disabled: !list.length || null,
            onclick: () => reject(list),
          },
          "Reject All",
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn primary small",
            disabled: !list.length || state.busy || null,
            onclick: () => accept(list),
          },
          "Accept All",
        ),
      ),
    );
    let lastSlide = null;
    const ul = el("ul", { class: "revision-list" });
    for (const item of list) {
      const slideNo =
        item.type === "slideInserted"
          ? `New slide ${item.bIndex + 1}`
          : `Slide ${item.aIndex + 1}`;
      if (slideNo !== lastSlide) {
        lastSlide = slideNo;
        ul.append(el("li", { class: "revision-slide" }, slideNo));
      }
      ul.append(
        el(
          "li",
          { class: `revision-item ${item.type}` },
          el(
            "button",
            {
              type: "button",
              class: "revision-show",
              "data-focus-key": `rev:${item.id}`,
              onclick: () => show(item),
            },
            el("span", { class: "revision-type" }, DESCRIBE[item.type]),
            el("span", { class: "revision-label" }, item.label),
            item.after != null &&
              el(
                "span",
                { class: "revision-detail" },
                el("del", {}, item.before || "(empty)"),
                " → ",
                el("ins", {}, item.after || "(empty)"),
              ),
          ),
          iconButton(
            `Accept: ${DESCRIBE[item.type]}, ${item.label}`,
            "Check",
            () => accept([item]),
            {
              class: "btn icon-btn revision-accept",
              disabled: state.busy || null,
            },
          ),
          iconButton(
            `Reject: ${DESCRIBE[item.type]}, ${item.label}`,
            "X",
            () => reject([item]),
            {
              class: "btn icon-btn revision-reject",
            },
          ),
        ),
      );
    }
    wrap.append(
      ul,
      el(
        "button",
        { type: "button", class: "btn secondary end-review", onclick: end },
        "End Review",
      ),
    );
    return wrap;
  }

  host.register("revisions", {
    title: "Revisions",
    render: () => {
      // The deck may have changed by other edits since.
      if (state.theirs) recompute();
      return render();
    },
  });
  return {
    start,
    end,
    active: () => !!state.theirs,
    openPane: () => host.open("revisions"),
    acceptAll: () => accept(pending()),
    state,
  };
}
