// Check Accessibility: finds what makes the deck hard to use with a screen
// reader or hard to read, sorted into errors, warnings and tips, each with
// why it matters, a recommended action and one-click fixes. The Reading
// Order pane sets the order a screen reader reads a slide's objects in (the
// order they are stacked in, back to front).
import { el, icon, iconButton, openMenu } from "../ui.js";
import { P, visibleSlideShapes, slideTitle, shapeLabel } from "../model.js";

export const SEVERITIES = [
  ["error", "Errors"],
  ["warning", "Warnings"],
  ["tip", "Tips"],
];

export const KINDS = {
  missingAlt: {
    severity: "error",
    title: "Missing alternative text",
    why: "People who use a screen reader hear the alternative text of a picture, chart or diagram in place of seeing it.",
    action:
      "Describe the object, or mark it as decorative if it adds nothing to the content.",
  },
  missingTitle: {
    severity: "error",
    title: "Missing slide title",
    why: "Slide titles let people who use screen readers or keyboards find their way and jump to a slide.",
    action: "Give the slide a title. A hidden title is read out but not shown.",
  },
  tableHeader: {
    severity: "error",
    title: "Missing table header",
    why: "A header row tells screen readers what each column holds as they read the cells.",
    action: "Use the table's first row as its header row.",
  },
  duplicateTitle: {
    severity: "warning",
    title: "Duplicate slide title",
    why: "Slides with the same title are hard to tell apart in a list of slides.",
    action: "Give each slide a title of its own.",
  },
  contrast: {
    severity: "warning",
    title: "Hard-to-read text contrast",
    why: "Text close in color to what is behind it is hard to read for people with low vision, and for anyone in bright light.",
    action: "Use a text color that stands out from the background.",
  },
  emptyPlaceholder: {
    severity: "warning",
    title: "Empty placeholder",
    why: "An empty placeholder is invisible in the slide show but a screen reader may still announce it.",
    action: "Add content to the placeholder or delete it.",
  },
  readingOrder: {
    severity: "tip",
    title: "Check reading order",
    why: "Screen readers read a slide's objects in the order they were added, which may not match the order they appear in.",
    action:
      "Open the Reading Order pane and put the objects in the order they should be read.",
  },
};

// Relative luminance and contrast ratio, per WCAG.
export function luminanceOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const v = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
export function contrastRatio(a, b) {
  const x = luminanceOf(a),
    y = luminanceOf(b);
  if (x == null || y == null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The visual order of boxes: top to bottom in rows, left to right within a
 * row. Boxes whose tops lie within `tolerance` of a row's first one share
 * it.
 */
export function visualOrder(items, tolerance) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - item.y) <= tolerance);
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

const ALT_KINDS = new Set(["picture", "graphicFrame", "group"]);
const isTitlePh = (type) => type === "title" || type === "ctrTitle";

/**
 * Every issue in the deck: [{ id, kind, severity, index, part, slide,
 * shapeId, label }]. `env` gives isTable, slideBounds(shape), size() and
 * textColors(shape) → { text, background, size, bold } | null.
 */
export function findAccessibilityIssues(pres, env) {
  const issues = [];
  if (!pres) return issues;
  const slides = P.getSlides(pres);
  const titles = new Map();
  slides.forEach((slide, index) => {
    const part = P.getSlidePartName(slide);
    const add = (kind, shape = null, label = null) =>
      issues.push({
        id: `${kind}:${part}:${shape ? P.getShapeId(shape) : ""}`,
        kind,
        severity: KINDS[kind].severity,
        index,
        part,
        slide,
        shapeId: shape ? P.getShapeId(shape) : null,
        label:
          label || (shape ? shapeLabel(shape, pres) : `Slide ${index + 1}`),
      });
    const shapes = visibleSlideShapes(slide);
    const ownGroupChildren = new Set();
    for (const shape of shapes) {
      const kind = P.getShapeKind(shape);
      const placeholder = P.getShapePlaceholderType?.(shape) || null;
      const decorative = P.isShapeDecorative(shape);
      if (kind === "group")
        for (const child of P.getGroupChildren(shape) || [])
          ownGroupChildren.add(P.getShapeId(child));
      // Alternative text: pictures, charts, diagrams and groups.
      if (
        ALT_KINDS.has(kind) &&
        !env.isTable(shape) &&
        !decorative &&
        !ownGroupChildren.has(P.getShapeId(shape)) &&
        !(P.getShapeDescription(shape) || "").trim()
      )
        add("missingAlt", shape);
      if (env.isTable(shape)) {
        try {
          if (!P.getTableStyleFlags(shape).firstRow) add("tableHeader", shape);
        } catch {}
      }
      // Placeholders left empty (titles are reported as missing titles).
      if (placeholder && !isTitlePh(placeholder) && kind === "shape") {
        const text = (P.getShapeText(shape) || "").trim();
        if (!text && !["sldNum", "dt", "ftr", "hdr"].includes(placeholder))
          add("emptyPlaceholder", shape);
      }
      // Text contrast.
      const colors = env.textColors(shape);
      if (colors && (P.getShapeText(shape) || "").trim()) {
        const ratio = contrastRatio(colors.text, colors.background);
        const large = colors.size >= 18 || (colors.bold && colors.size >= 14);
        if (ratio != null && ratio < (large ? 3 : 4.5)) add("contrast", shape);
      }
    }
    const title = (slideTitle(slide, pres) || "").trim();
    if (!title) add("missingTitle");
    else {
      const key = title.toLowerCase().replace(/\s+/g, " ");
      titles.set(key, [...(titles.get(key) || []), { slide, index, part }]);
    }
    // Reading order: objects read in an order unlike the one they show in.
    const boxes = shapes
      .filter((s) => !ownGroupChildren.has(P.getShapeId(s)))
      .map((s) => ({ id: P.getShapeId(s), ...(env.slideBounds(s) || {}) }))
      .filter((b) => Number.isFinite(b.x) && b.y > -1e9);
    if (boxes.length >= 3) {
      const size = env.size();
      const seen = visualOrder(boxes, size.cy * 0.05).map((b) => b.id);
      const read = boxes.map((b) => b.id);
      const titleShape = shapes.find((s) =>
        isTitlePh(P.getShapePlaceholderType?.(s)),
      );
      const titleFirst = !titleShape || read[0] === P.getShapeId(titleShape);
      if (!titleFirst || seen.join() !== read.join())
        issues.push({
          id: `readingOrder:${part}:`,
          kind: "readingOrder",
          severity: "tip",
          index,
          part,
          slide,
          shapeId: null,
          label: `Slide ${index + 1}`,
        });
    }
  });
  for (const list of titles.values())
    if (list.length > 1)
      for (const { slide, index, part } of list)
        issues.push({
          id: `duplicateTitle:${part}:`,
          kind: "duplicateTitle",
          severity: "warning",
          index,
          part,
          slide,
          shapeId: null,
          label: `Slide ${index + 1}: ${slideTitle(slide, pres)}`,
        });
  const rank = { error: 0, warning: 1, tip: 2 };
  return issues.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.index - b.index,
  );
}

export function createAccessibility(env, host) {
  const state = {
    expanded: new Set(["error", "warning", "tip"]),
    selected: null,
  };
  const issues = () => findAccessibilityIssues(env.pres(), env);

  // What each kind of issue can do about it.
  function fixes(issue) {
    const shape = () => {
      const s = P.getSlides(env.pres()).find(
        (x) => P.getSlidePartName(x) === issue.part,
      );
      return s && issue.shapeId != null
        ? P.findShapeById(s, issue.shapeId)
        : null;
    };
    const go = () => env.showIssue(issue);
    switch (issue.kind) {
      case "missingAlt":
        return [
          {
            label: "Add a Description",
            run: async () => (await go(), env.altText()),
          },
          {
            label: "Mark as Decorative",
            run: () =>
              env.mutateShape(shape(), (s) => P.setShapeDecorative(s, true)),
          },
        ];
      case "missingTitle": {
        const s = issue.slide;
        const empty = visibleSlideShapes(s).find((x) =>
          isTitlePh(P.getShapePlaceholderType?.(x)),
        );
        return [
          empty
            ? {
                label: "Edit the Title",
                run: async () => {
                  await env.showObjects(issue.part, [P.getShapeId(empty)]);
                  env.editShapeText(issue.part, P.getShapeId(empty));
                },
              }
            : {
                label: "Add a Slide Title",
                run: () => env.addTitle(issue, { hidden: false }),
              },
          !empty && {
            label: "Add a Hidden Slide Title",
            run: () => env.addTitle(issue, { hidden: true }),
          },
        ].filter(Boolean);
      }
      case "tableHeader":
        return [
          {
            label: "Use the First Row as Header",
            run: () =>
              env.mutateShape(shape(), (s) =>
                P.setTableStyleFlags(s, { firstRow: true }),
              ),
          },
        ];
      case "duplicateTitle": {
        const t = visibleSlideShapes(issue.slide).find((x) =>
          isTitlePh(P.getShapePlaceholderType?.(x)),
        );
        return [
          t && {
            label: "Edit the Title",
            run: async () => {
              await env.showObjects(issue.part, [P.getShapeId(t)]);
              env.editShapeText(issue.part, P.getShapeId(t));
            },
          },
        ].filter(Boolean);
      }
      case "contrast":
        return [
          {
            label: "Use a Readable Text Color",
            run: () => env.fixContrast(shape()),
          },
        ];
      case "emptyPlaceholder":
        return [
          {
            label: "Add Text",
            run: async () => {
              await go();
              env.editShapeText(issue.part, issue.shapeId);
            },
          },
          {
            label: "Delete the Placeholder",
            run: () =>
              env.mutateSlide(issue.slide, (s) => {
                const target = P.findShapeById(s, issue.shapeId);
                if (!target) return env.SKIP;
                P.removeShape(target);
              }),
          },
        ];
      case "readingOrder":
        return [
          {
            label: "Open Reading Order Pane",
            run: async () => {
              await env.chooseSlide(issue.slide);
              host.open("readingOrder");
            },
          },
        ];
    }
    return [];
  }

  function render() {
    const list = issues();
    const wrap = el("div", { class: "a11y-pane" });
    if (!list.length) {
      wrap.append(
        el(
          "div",
          { class: "review-empty", role: "status" },
          icon("o:accessibility", 32),
          el("p", {}, "No accessibility issues found."),
          el(
            "p",
            { class: "helper" },
            "People with disabilities should not have difficulty reading this presentation.",
          ),
        ),
      );
      return wrap;
    }
    wrap.append(
      el(
        "p",
        { class: "review-status", role: "status" },
        `${list.length} result${list.length === 1 ? "" : "s"}`,
      ),
    );
    for (const [severity, heading] of SEVERITIES) {
      const ofSeverity = list.filter((i) => i.severity === severity);
      if (!ofSeverity.length) continue;
      const open = state.expanded.has(severity);
      const section = el("section", { class: `a11y-section ${severity}` });
      section.append(
        el(
          "h3",
          {},
          el(
            "button",
            {
              type: "button",
              class: "a11y-toggle",
              "aria-expanded": String(open),
              onclick: () => {
                if (open) state.expanded.delete(severity);
                else state.expanded.add(severity);
                host.refresh("accessibility");
              },
            },
            icon(open ? "ChevronDown" : "ChevronRight", 14),
            icon(
              {
                error: "CircleAlert",
                warning: "TriangleAlert",
                tip: "Lightbulb",
              }[severity],
              15,
            ),
            `${heading} (${ofSeverity.length})`,
          ),
        ),
      );
      if (open) {
        const byKind = new Map();
        for (const i of ofSeverity)
          byKind.set(i.kind, [...(byKind.get(i.kind) || []), i]);
        for (const [kind, items] of byKind) {
          const info = KINDS[kind];
          section.append(
            el("h4", { class: "a11y-kind" }, `${info.title} (${items.length})`),
            el(
              "ul",
              { class: "a11y-items" },
              items.map((issue) => {
                const selected = state.selected === issue.id;
                return el(
                  "li",
                  { class: selected ? "selected" : "" },
                  el(
                    "button",
                    {
                      type: "button",
                      class: "a11y-item",
                      "aria-expanded": String(selected),
                      "data-focus-key": `issue:${issue.id}`,
                      onclick: () => {
                        state.selected = selected ? null : issue.id;
                        env.showIssue(issue);
                        host.refresh("accessibility");
                      },
                    },
                    el("span", { class: "a11y-label" }, issue.label),
                    el(
                      "span",
                      { class: "a11y-where" },
                      `Slide ${issue.index + 1}`,
                    ),
                  ),
                  iconButton(
                    "Recommended actions",
                    "ChevronDown",
                    (e) =>
                      openMenu({
                        anchor: e.currentTarget,
                        label: "Recommended actions",
                        align: "end",
                        items: fixes(issue).map((f) => ({
                          label: f.label,
                          onSelect: () =>
                            Promise.resolve(f.run()).catch(env.fail),
                        })),
                      }),
                    {
                      class: "btn icon-btn a11y-fix-menu",
                      "aria-haspopup": "menu",
                    },
                  ),
                  selected &&
                    el(
                      "div",
                      { class: "a11y-detail" },
                      el("p", { class: "review-label" }, "Why fix"),
                      el("p", {}, info.why),
                      el("p", { class: "review-label" }, "How to fix"),
                      el("p", {}, info.action),
                      el(
                        "div",
                        { class: "a11y-fixes" },
                        fixes(issue).map((f, k) =>
                          el(
                            "button",
                            {
                              type: "button",
                              class: `btn ${k === 0 ? "primary" : "secondary"} small`,
                              onclick: () =>
                                Promise.resolve(f.run()).catch(env.fail),
                            },
                            f.label,
                          ),
                        ),
                      ),
                    ),
                );
              }),
            ),
          );
        }
      }
      wrap.append(section);
    }
    return wrap;
  }

  // ---- Reading order ------------------------------------------------------

  // The slide's top-level objects, in the order a screen reader reads them.
  function readingList() {
    if (!env.pres()) return [];
    const slide = env.slide();
    const all = visibleSlideShapes(slide);
    const inGroups = new Set();
    for (const s of all)
      if (P.getShapeKind(s) === "group")
        for (const c of P.getGroupChildren(s) || [])
          inGroups.add(P.getShapeId(c));
    return all.filter((s) => !inGroups.has(P.getShapeId(s)));
  }
  // Moves the object at `from` to `to` in reading order; the stacking order
  // changes with it, as they are the same.
  function move(from, to) {
    const list = readingList();
    if (to < 0 || to >= list.length || from === to) return;
    const id = P.getShapeId(list[from]);
    const targetId = P.getShapeId(list[to]);
    return env
      .mutateSlide(env.slide(), (slide) => {
        const shapes = P.getSlideShapes(slide);
        const nested = new Set();
        for (const s of shapes)
          if (P.getShapeKind(s) === "group")
            for (const c of P.getGroupChildren(s)) nested.add(P.getShapeId(c));
        const tops = shapes.filter((s) => !nested.has(P.getShapeId(s)));
        const shape = P.findShapeById(slide, id);
        const anchor = P.findShapeById(slide, targetId);
        if (!shape || !anchor) return env.SKIP;
        P.setShapeZIndex(shape, tops.indexOf(anchor));
      })
      .then(() => {
        host.refresh("readingOrder");
        host.el.querySelector(`[data-focus-key="order:${id}"]`)?.focus();
      });
  }
  function renderOrder() {
    const list = readingList();
    const wrap = el("div", { class: "order-pane" });
    wrap.append(
      el(
        "p",
        { class: "helper" },
        "Screen readers read these objects from top to bottom. Drag an object, or use the arrow buttons or Alt+Up and Alt+Down, to change the order.",
      ),
    );
    if (!list.length) {
      wrap.append(
        el("p", { class: "review-status" }, "This slide has no objects."),
      );
      return wrap;
    }
    const selected = new Set(env.selectionIds());
    let dragFrom = null;
    const ol = el("ol", { class: "order-list", "aria-label": "Reading order" });
    list.forEach((shape, i) => {
      const id = P.getShapeId(shape);
      const row = el(
        "li",
        {
          class: `order-item ${selected.has(id) ? "selected" : ""}`,
          draggable: env.blocksEdits() ? null : "true",
          ondragstart: (e) => {
            dragFrom = i;
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(i));
          },
          ondragover: (e) => {
            if (dragFrom == null) return;
            e.preventDefault();
            row.classList.add("drop-target");
          },
          ondragleave: () => row.classList.remove("drop-target"),
          ondrop: (e) => {
            e.preventDefault();
            row.classList.remove("drop-target");
            if (dragFrom != null) move(dragFrom, i);
            dragFrom = null;
          },
        },
        el(
          "span",
          { class: "order-number", "aria-hidden": "true" },
          String(i + 1),
        ),
        icon("GripVertical", 14),
        el(
          "button",
          {
            type: "button",
            class: "order-name",
            "data-focus-key": `order:${id}`,
            "aria-label": `${i + 1}. ${shapeLabel(shape, env.pres())}`,
            onclick: () =>
              env.showObjects(P.getSlidePartName(env.slide()), [id]),
            onkeydown: (e) => {
              if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                e.preventDefault();
                move(i, i + (e.key === "ArrowUp" ? -1 : 1));
              }
            },
          },
          shapeLabel(shape, env.pres()),
        ),
        iconButton("Move up", "ArrowUp", () => move(i, i - 1), {
          disabled: i === 0 || null,
        }),
        iconButton("Move down", "ArrowDown", () => move(i, i + 1), {
          disabled: i === list.length - 1 || null,
        }),
      );
      ol.append(row);
    });
    wrap.append(ol);
    return wrap;
  }

  host.register("accessibility", { title: "Accessibility", render });
  host.register("readingOrder", {
    title: "Reading Order",
    render: renderOrder,
  });

  return {
    issues,
    open: () => host.open("accessibility"),
    openReadingOrder: () => host.open("readingOrder"),
    statusText: () => {
      const list = issues();
      if (!list.length) return "Accessibility: Good to go";
      if (list.some((i) => i.severity !== "tip"))
        return "Accessibility: Investigate";
      return "Accessibility: Good to go";
    },
  };
}
