import "./i18n.js";
import { bounds, item, uid } from "../model.js";
import { inferParents, nextFrameOrder } from "../scene.js";
import { language, t } from "../i18n.js";
import {
  STATUS_LABELS,
  dayNumber,
  dateFromDay,
  formatDate,
  localDate,
  dependencyEdges,
  hasTask,
} from "./task.js";
import { groupTasks } from "./tasks.js";
import { canonicalLanguage } from "../accessibility/language-tag.js";
import { appendRun, sliceTextRuns } from "../rich-text.js";

// Bars and lanes show a task's opening words; its full text stays on the
// task, and long text would exceed an object's text limit.
function short(value, sourceLanguage, sourceRuns = [], max = 200) {
  let end = value.length;
  if (end > max) {
    end = max - 1;
    if (
      /[\uD800-\uDBFF]/.test(value[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(value[end])
    )
      end--;
    end = value.slice(0, end).trimEnd().length;
  }
  const lang = canonicalLanguage(sourceLanguage),
    runs = [];
  for (const run of sliceTextRuns(sourceRuns, 0, end)) {
    const tag = canonicalLanguage(run.style.lang);
    if (tag) appendRun(runs, run.start, run.end, { lang: tag });
  }
  return {
    text: value.slice(0, end) + (value.length > max ? "…" : ""),
    ...(lang ? { lang } : {}),
    ...(runs.length ? { textRuns: runs } : {}),
  };
}

export const BAR_COLORS = {
  todo: "#e3e7ec",
  "in-progress": "#dce5f7",
  blocked: "#f3d6c8",
  done: "#d9e9d2",
};

// Ticks at a readable density: days for a month, Mondays for half a year,
// months for about a year, quarters for a few years, and whole years at a
// step that keeps about a dozen labels beyond that.
const monthDay = (year, month) => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 1);
  return Math.round(date.getTime() / 86400000);
};
function ticks(first, last, lang) {
  const span = last - first + 1,
    out = [];
  // The padding day after 9999-12-31 is not a date that can be labelled.
  last = Math.min(last, dayNumber("9999-12-31"));
  if (span <= 190) {
    const unit = span <= 31 ? "day" : "week";
    for (let day = first; day <= last; day++)
      if (unit === "day" || new Date(day * 86400000).getUTCDay() === 1)
        out.push({ day, label: formatDate(dateFromDay(day), lang) });
    // Daily labels thin out on longer ranges so they stay legible.
    const step = unit === "day" && span > 14 ? 2 : 1;
    return { unit, ticks: out.filter((_, n) => n % step === 0) };
  }
  const start = new Date(first * 86400000),
    year = start.getUTCFullYear();
  if (span <= 1100) {
    const unit = span <= 400 ? "month" : "quarter",
      months = unit === "month" ? 1 : 3;
    let month = start.getUTCMonth();
    month = Math.ceil(month / months) * months;
    if (monthDay(year, month) < first) month += months;
    for (let day; (day = monthDay(year, month)) <= last; month += months)
      out.push({
        day,
        // Without the day the default options would add.
        label: formatDate(dateFromDay(day), lang, {
          month: "short",
          year: "numeric",
          day: undefined,
        }),
      });
    return { unit, ticks: out };
  }
  const years = span / 365.25,
    step =
      [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].find(
        (s) => years / s <= 12,
      ) || 5000;
  let y = Math.ceil(year / step) * step;
  if (monthDay(y, 0) < first) y += step;
  for (let day; (day = monthDay(y, 0)) <= last; y += step)
    out.push({ day, label: String(y) });
  return { unit: "year", ticks: out };
}

// Bars run from the start to the due date, inclusive. Tasks with only one
// date become one-day bars; undated tasks are listed separately.
export function timelineModel(rows, options = {}) {
  const lang = options.language || language,
    today = options.today || localDate(),
    groupBy = options.groupBy || "assignee";
  const scheduled = [],
    unscheduled = [];
  for (const row of rows) {
    if (!row.start && !row.due) {
      unscheduled.push(row);
      continue;
    }
    const start = dayNumber(row.start || row.due),
      end = dayNumber(row.due || row.start);
    scheduled.push({ row, start, end });
  }
  if (!scheduled.length)
    return {
      lanes: [],
      unscheduled,
      first: null,
      last: null,
      ticks: [],
      edges: [],
    };
  const todayDay = dayNumber(today);
  let first = Math.min(...scheduled.map((b) => b.start)),
    last = Math.max(...scheduled.map((b) => b.end));
  if (todayDay >= first - 14 && todayDay <= last + 14) {
    first = Math.min(first, todayDay);
    last = Math.max(last, todayDay);
  }
  first -= 1;
  last += 1;
  const span = last - first + 1;
  const percent = (day) => ((day - first) / span) * 100;
  const byRow = new Map(scheduled.map((b) => [b.row.id, b]));
  const lanes = groupTasks(
    scheduled.map((b) => b.row),
    groupBy === "frame"
      ? "frame"
      : groupBy === "status"
        ? "status"
        : "assignee",
  ).map((group) => ({
    key: group.key,
    label: group.label,
    ...(groupBy === "frame"
      ? {
          labelGenerated: group.labelGenerated,
          labelLang: group.labelLang,
          labelRuns: group.labelRuns,
        }
      : {}),
    bars: group.rows
      .map((row) => byRow.get(row.id))
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .map((b) => ({
        ...b,
        left: percent(b.start),
        width: ((b.end - b.start + 1) / span) * 100,
        label: `${b.row.title}, ${t(STATUS_LABELS[b.row.status], "task")}, ${formatDate(dateFromDay(b.start), lang)} ${t("to")} ${formatDate(dateFromDay(b.end), lang)}`,
      })),
  }));
  const ids = new Set(scheduled.map((b) => b.row.id));
  return {
    lanes,
    unscheduled,
    first,
    last,
    span,
    today: todayDay >= first && todayDay <= last ? percent(todayDay) : null,
    todayDay,
    ...ticks(first, last, lang),
    edges: (options.edges || []).filter(
      (e) => ids.has(e.from) && ids.has(e.to),
    ),
    percent,
  };
}

// An editable timeline frame for the canvas: a date header, one lane per
// group, a bar per task linked to its object, a today marker, and
// dependency connectors between bars.
export function timelineItems(board, rows, options = {}) {
  const model = timelineModel(rows, {
    ...options,
    edges: dependencyEdges(board.items),
  });
  if (!model.lanes.length)
    throw Error("Add start or due dates to tasks first.");
  const origin = options.origin || { x: 0, y: 0 };
  // Days get at least 4 pixels until the chart would pass 24,000 pixels,
  // so a date far in the future cannot make the frame unusably wide.
  const dayW = Math.min(
      60,
      Math.max(1400 / model.span, Math.min(4, 24000 / model.span)),
    ),
    labelW = 180,
    header = 96,
    rowH = 44,
    barH = 34,
    lanePad = 10,
    chartW = model.span * dayW;
  const x0 = origin.x + labelW + 20,
    dayX = (day) => x0 + (day - model.first) * dayW;
  const lanesH = model.lanes.reduce(
    (sum, lane) => sum + lane.bars.length * rowH + lanePad * 2,
    0,
  );
  const frame = item("frame", origin.x, origin.y, {
    w: labelW + 40 + chartW,
    h: header + lanesH + 30,
    text: options.title || t("Timeline"),
    ...(!options.title ? { lang: language } : {}),
    color: "#ffffff",
    order: nextFrameOrder(board.items),
  });
  const inside = (i) => ({ ...i, parentId: frame.id });
  const items = [frame];
  const text = (x, y, w, h, value, extra = {}) =>
    inside(
      item("text", x, y, {
        w,
        h,
        text: value,
        fontSize: 13,
        color: "#30342f",
        ...extra,
      }),
    );
  // Lane backgrounds first so labels and bars stack above them.
  let y = origin.y + header;
  const laneTops = [];
  model.lanes.forEach((lane, n) => {
    const h = lane.bars.length * rowH + lanePad * 2;
    laneTops.push(y);
    items.push(
      inside(
        item("rect", origin.x + 10, y, {
          w: labelW + 20 + chartW,
          h,
          color: n % 2 ? "#ffffff" : "#f3f5f8",
          text: "",
        }),
      ),
    );
    y += h;
  });
  // Labels stay inside the frame; the day of room after the last task has
  // none for one.
  const right = frame.x + frame.w - 10;
  for (const tick of model.ticks) {
    const x = dayX(tick.day),
      w = Math.min(Math.max(60, dayW * 2), right - x);
    if (w < 30) continue;
    items.push(
      text(x, origin.y + 56, w, 30, tick.label, {
        fontSize: 12,
        // Match formatDate's supported interface language codes.
        lang: (options.language || language) === "fr" ? "fr-CA" : "en-CA",
      }),
    );
  }
  if (model.today !== null) {
    const x = dayX(model.todayDay) + dayW / 2 - 1;
    items.push(
      inside(
        item("rect", x, origin.y + header - 8, {
          w: 2,
          h: lanesH + 8,
          color: "#b3261e",
          text: "",
        }),
      ),
      // It sits on the canvas, so the red keeps a white band behind it to
      // stay readable in the dark theme too. It goes below the lanes, at
      // the foot of its line, where no date label is.
      text(x + 4, origin.y + header + lanesH + 4, 90, 22, t("Today"), {
        fontSize: 12,
        textColor: "#8c1d18",
        highlight: "#ffffff",
        bold: true,
        lang: language,
      }),
    );
  }
  const bars = new Map();
  model.lanes.forEach((lane, n) => {
    const generated =
      lane.labelGenerated ||
      options.groupBy === "status" ||
      (options.groupBy !== "frame" && !lane.key);
    const caption = short(
      lane.label,
      generated ? language : lane.labelLang,
      generated ? [] : lane.labelRuns,
    );
    items.push(
      text(
        origin.x + 20,
        laneTops[n] + lanePad,
        labelW - 20,
        40,
        caption.text,
        {
          bold: true,
          fontSize: 14,
          // The lanes are light in both themes, so the caption is not in
          // the theme's ink.
          textColor: "#30342f",
          ...caption,
        },
      ),
    );
    lane.bars.forEach((b, m) => {
      const title = short(
        b.row.title,
        b.row.titleGenerated ? language : b.row.titleLang,
        b.row.titleGenerated ? [] : b.row.titleRuns,
      );
      const status = ` (${t(STATUS_LABELS[b.row.status], "task")})`;
      title.textRuns ||= [];
      appendRun(
        title.textRuns,
        title.text.length,
        title.text.length + status.length,
        { lang: language },
      );
      title.text += status;
      const bar = inside(
        item("rect", dayX(b.start), laneTops[n] + lanePad + m * rowH + 5, {
          w: Math.max(dayW, 4, (b.end - b.start + 1) * dayW),
          h: barH,
          ...title,
          fontSize: 12,
          color: BAR_COLORS[b.row.status],
          autoFontSize: true,
          objectLink: { objectId: b.row.id },
        }),
      );
      bars.set(b.row.id, bar);
      items.push(bar);
    });
  });
  for (const edge of model.edges) {
    const a = bars.get(edge.from),
      b = bars.get(edge.to);
    items.push(
      inside({
        id: uid(),
        type: "arrow",
        x: a.x + a.w,
        y: a.y + a.h / 2,
        w: b.x - a.x - a.w,
        h: b.y - a.y,
        text: "",
        color: "#5f6b7a",
        lineType: "elbow",
        startId: a.id,
        endId: b.id,
      }),
    );
  }
  return { items, frame, model };
}

const BAR_FILLS = new Set(Object.values(BAR_COLORS));
const LANE_FILLS = new Set(["#f3f5f8", "#ffffff"]);

// A timeline placed on the board is recognised by what timelineItems
// draws, not by a saved marker, which older versions and collaborators
// would refuse: a frame holding bars that link to tasks, with lanes or
// date labels beside them. Returns the frame, the objects it generated,
// its bars by task, and each bar's lane caption, or null. Objects people
// added inside are not among the generated ones.
export function placedTimeline(items, frameId) {
  let frame = null;
  const inside = [];
  for (const i of items)
    if (i.id === frameId) frame = i;
    else if (i.parentId === frameId) inside.push(i);
  if (frame?.type !== "frame") return null;
  // Bars are drawn with a fitted 12-pixel label, which a button or card
  // linking to a task elsewhere on the board is not.
  const linked = inside.filter(
    (i) =>
      i.type === "rect" &&
      !i.shape &&
      i.fontSize === 12 &&
      i.autoFontSize === true &&
      typeof i.objectLink?.objectId === "string",
  );
  if (!linked.length) return null;
  // A bar links to a task, or to one deleted or no longer a task since.
  const targets = new Map(linked.map((i) => [i.objectLink.objectId, null]));
  for (const i of items) if (targets.has(i.id)) targets.set(i.id, i);
  const bars = linked.filter((i) => {
    const target = targets.get(i.objectLink.objectId);
    return !target || hasTask(target) || BAR_FILLS.has(i.color);
  });
  if (!bars.length) return null;
  const left = Math.min(...bars.map((b) => b.x)),
    right = Math.max(...bars.map((b) => b.x + b.w));
  const plain = (i) => i.type === "rect" && !i.text && !i.objectLink;
  // Lanes run behind the captions and every bar.
  const lanes = inside.filter(
    (i) =>
      plain(i) &&
      LANE_FILLS.has(i.color) &&
      i.x < left &&
      i.x + i.w >= right - 0.5,
  );
  const top = Math.min(...[...lanes, ...bars].map((i) => i.y));
  const dates = inside.filter(
    (i) =>
      i.type === "text" &&
      i.fontSize === 12 &&
      !i.bold &&
      !i.textColor &&
      (i.lang === "en-CA" || i.lang === "fr-CA") &&
      i.y + i.h <= top + 0.5,
  );
  // Every placed timeline has its dates above the lanes.
  if (!dates.length) return null;
  const captions = inside
    .filter(
      (i) =>
        i.type === "text" &&
        i.bold &&
        i.fontSize === 14 &&
        i.textColor === "#30342f" &&
        i.x + i.w <= left + 0.5,
    )
    .sort((a, b) => a.y - b.y);
  const today = inside.filter(
    (i) =>
      (plain(i) && i.color === "#b3261e" && i.w === 2) ||
      (i.type === "text" &&
        i.bold &&
        i.fontSize === 12 &&
        i.textColor === "#8c1d18" &&
        i.highlight === "#ffffff"),
  );
  const barIds = new Set(bars.map((b) => b.id));
  const lines = inside.filter(
    (i) =>
      i.type === "arrow" &&
      barIds.has(i.startId) &&
      barIds.has(i.endId) &&
      i.color === "#5f6b7a" &&
      i.lineType === "elbow" &&
      !i.dependency &&
      !i.text,
  );
  const byTask = new Map(),
    lane = new Map();
  for (const bar of bars) {
    const id = bar.objectLink.objectId;
    if (byTask.has(id)) continue;
    byTask.set(id, bar);
    const caption = captions.findLast((c) => c.y <= bar.y + 0.5);
    if (caption) lane.set(id, caption.text || "");
  }
  return {
    frame,
    generated: [...lanes, ...dates, ...captions, ...today, ...bars, ...lines],
    bars: byTask,
    lanes: lane,
  };
}

// The lanes a timeline was placed with, read from the lane each bar sits
// in: its status in the bar's own text, or the task's assignee or frame.
// The Tasks dialog's default, by assignee, wins a tie.
export function timelineGrouping(found, rows) {
  const byId = new Map(rows.map((r) => [r.id, r])),
    caption = (label) => short(label, "").text;
  const scores = { assignee: 0, status: 0, frame: 0 };
  for (const [id, label] of found.lanes) {
    if (found.bars.get(id).text?.endsWith(` (${label})`)) scores.status++;
    const row = byId.get(id);
    if (!row) continue;
    if (caption(row.assigneeName || t("Unassigned")) === label)
      scores.assignee++;
    if (caption(row.frame || t("No frame")) === label) scores.frame++;
  }
  return ["assignee", "status", "frame"].reduce((best, key) =>
    scores[key] > scores[best] ? key : best,
  );
}

// A placed timeline drawn again from the tasks now on the board, in its
// place: the frame keeps its id, title, order, and lock, and bars of
// tasks still shown keep theirs, so connectors and comments on them stay.
// What people added inside stays too, and the frame grows to hold it.
// Objects its new size covers are taken in, as when resizing a frame,
// except those in `options.skip`, such as objects hidden from this person.
// Returns the board's new item list and leaves the board unchanged.
export function refreshedTimeline(board, found, rows, options = {}) {
  const old = found.frame;
  const plan = timelineItems(board, rows, {
    ...options,
    groupBy: options.groupBy || timelineGrouping(found, rows),
    origin: { x: old.x, y: old.y },
  });
  const ids = new Map([[plan.frame.id, old.id]]);
  for (const i of plan.items) {
    const previous = i.objectLink && found.bars.get(i.objectLink.objectId);
    if (previous) ids.set(i.id, previous.id);
  }
  const generated = new Set(found.generated.map((i) => i.id)),
    reused = new Set(ids.values());
  const gone = new Set([...generated].filter((id) => !reused.has(id)));
  // Connectors to bars that are gone go with them, as when deleting.
  const dropped = (i) =>
    generated.has(i.id) || gone.has(i.startId) || gone.has(i.endId);
  const kept = board.items.filter((i) => i.id !== old.id && !dropped(i));
  const extra = kept.filter((i) => i.parentId === old.id);
  let { w, h } = plan.frame;
  if (extra.length) {
    const box = bounds(extra);
    w = Math.max(w, Math.ceil(box.x + box.w - old.x + 10));
    h = Math.max(h, Math.ceil(box.y + box.h - old.y + 10));
  }
  const previous = new Map(found.generated.map((i) => [i.id, i]));
  const fresh = plan.items.slice(1).map((i) => {
    const copy = { ...i, id: ids.get(i.id) ?? i.id, parentId: old.id };
    if (copy.startId) copy.startId = ids.get(copy.startId) ?? copy.startId;
    if (copy.endId) copy.endId = ids.get(copy.endId) ?? copy.endId;
    const groupId = previous.get(copy.id)?.groupId;
    if (groupId) copy.groupId = groupId;
    return copy;
  });
  // A group is two or more objects, as after deleting.
  const members = new Map();
  for (const i of [...kept, ...fresh])
    if (i.groupId) members.set(i.groupId, (members.get(i.groupId) || 0) + 1);
  const single = (i) => {
    if (!i.groupId || members.get(i.groupId) > 1) return i;
    const { groupId: _, ...rest } = i;
    return rest;
  };
  const frame = { ...old, w, h };
  const covers = (box, i) =>
    i.x + i.w / 2 >= box.x &&
    i.x + i.w / 2 <= box.x + box.w &&
    i.y + i.h / 2 >= box.y &&
    i.y + i.h / 2 <= box.y + box.h;
  const taken = new Set(
    kept
      .filter(
        (i) =>
          i.type !== "frame" &&
          i.parentId !== old.id &&
          !options.skip?.has(i.id) &&
          (covers(old, i) || covers(frame, i)),
      )
      .map((i) => i.id),
  );
  const out = [];
  for (const i of board.items)
    if (i.id === old.id) out.push(frame, ...fresh.map(single));
    else if (taken.has(i.id)) out.push({ ...single(i) });
    else if (!dropped(i)) out.push(single(i));
  if (taken.size) inferParents(out, taken, { skip: options.skip });
  return out;
}
