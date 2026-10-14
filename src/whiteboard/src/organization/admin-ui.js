import { escape } from "../model.js";
import { busy } from "../accessibility/busy.js";
import { keepPaginationFocus } from "../paging.js";
import { t, language, singular, labelled, nameOrder } from "../i18n.js";
import "./admin-strings.js";
import { boardFilters, organizationLink } from "./client.js";
import { asciiDomain, domainProblem } from "./email-domains.js";
import { toUnicode } from "../idn.js";
import { call } from "../collaboration/api.js";
import {
  authoredTextHTML,
  languageAttribute,
} from "../accessibility/object-content.js";
import { textSegments, validateTextRuns } from "../rich-text.js";

// Organization settings for administrators: adoption reports, people and
// teams, the board directory, policy, security integrations, and the audit
// log. Every change goes through the organization worker, which enforces it.
const TABS = [
  ["overview", "Overview", "chart-column"],
  ["people", "People", "users"],
  ["boards", "Boards", "layout-dashboard"],
  ["policies", "Policies", "shield-check"],
  ["integrations", "Integrations", "plug"],
  ["security", "Security", "lock-keyhole"],
  ["audit", "Audit log", "scroll-text"],
];
const date = (at) =>
  at
    ? new Date(at).toLocaleDateString(language === "fr" ? "fr-CA" : "en-CA", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "-";
const dateTime = (at) =>
  at ? new Date(at).toLocaleString(language === "fr" ? "fr-CA" : "en-CA") : "-";
const user = (value) => `<span data-user-content>${escape(value ?? "")}</span>`;
// An event's details read as what was recorded, not as JSON: each value
// with its name, people's text in its own language, and the presentation
// metadata (language tags and style runs) folded into that text. The raw
// JSON stays in the export and in the cell's tooltip.
const detailName = (key) =>
  key.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase();
const detailText = (details, key, value) => {
  const lang = details[`${key}Lang`],
    runs = details[`${key}Runs`];
  if (lang === undefined && runs === undefined) return escape(value);
  let parts;
  try {
    validateTextRuns(value, runs);
    parts = textSegments(value, runs);
  } catch {
    parts = [{ text: value, style: {} }];
  }
  return (
    `<span${languageAttribute(lang)}>` +
    parts
      .map(
        (part) =>
          `<span${languageAttribute(part.style.lang)}>${escape(part.text)}</span>`,
      )
      .join("") +
    "</span>"
  );
};
const auditDetails = (event) => {
  const details = event.details || {};
  return Object.entries(details)
    .filter(
      ([key, value]) =>
        value !== undefined && value !== null && !/(Runs|Lang)$/.test(key),
    )
    .map(([key, value]) => {
      const shown =
        typeof value === "boolean"
          ? t(value ? "yes" : "no")
          : typeof value === "string"
            ? detailText(details, key, value)
            : escape(
                typeof value === "number"
                  ? value.toLocaleString(language === "fr" ? "fr-CA" : "en-CA")
                  : JSON.stringify(value),
              );
      return `<span class="audit-detail"><span class="audit-detail-name">${escape(t(detailName(key), "detail"))}</span> ${shown}</span>`;
    })
    .join(" · ");
};
const auditDetailsJSON = (event) => escape(JSON.stringify(event.details || {}));
// A translated message with its {placeholders} filled, numbers formatted
// for the language.
const fill = (text, values) =>
  Object.entries(values).reduce(
    (out, [key, value]) =>
      out.replaceAll(
        `{${key}}`,
        (Number(value) || 0).toLocaleString(
          language === "fr" ? "fr-CA" : "en-CA",
        ),
      ),
    t(text),
  );
const names = nameOrder;
// Numbers from the organization's server are shown as numbers only.
const num = (value) => Number(value) || 0;
// A figure reads with the language's digit grouping: 1,500, not 1500.
const figure = (value) =>
  typeof value === "number"
    ? value.toLocaleString(language === "fr" ? "fr-CA" : "en-CA")
    : String(value);
// Time spent on boards, in hours once minutes stop being readable.
const duration = (minutes) =>
  minutes >= 120
    ? `${figure(Math.round(minutes / 60))} h`
    : `${figure(minutes)} min`;
// A count with its noun, in the singular where the language takes it.
const count = (value, one, many) =>
  `${figure(num(value))} ${t(singular(num(value)) ? one : many)}`;
// Text that spreadsheets would evaluate as a formula gets an apostrophe
// prefix (OWASP CSV injection guidance).
const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Semicolons split cells where Excel uses them as the list separator.
  return /[",;\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
// Each column is a field name, or a [header, (row) => value] pair.
export const toCSV = (rows, columns) =>
  "﻿" +
  [
    columns.map((c) => csvCell(Array.isArray(c) ? c[0] : c)).join(","),
    ...rows.map((r) =>
      columns.map((c) => csvCell(Array.isArray(c) ? c[1](r) : r[c])).join(","),
    ),
  ].join("\r\n");
const lines = (value) =>
  String(value || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
// The settings in `now` that differ from `before`, nested as they are: a
// save sends only these, so it never undoes what another administrator
// changed after this form was loaded. Lists are compared whole.
const changes = (now, before = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(now)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner = changes(value, before[key]);
      if (Object.keys(inner).length) out[key] = inner;
    } else if (JSON.stringify(value) !== JSON.stringify(before[key]))
      out[key] = value;
  }
  return out;
};

// A single-series bar chart: bars are anchored to the baseline, values show
// on hover and focus, and the same numbers are available as a table.
export function barChart(series, label) {
  const width = 560,
    height = 140,
    pad = 24,
    max = Math.max(1, ...series.map((d) => d.value)),
    step = (width - pad * 2) / Math.max(1, series.length),
    bar = Math.max(1, step - Math.min(2, step / 3));
  const bars = series
    .map((d, n) => {
      const h = Math.max(d.value ? 3 : 0, ((height - pad * 2) * d.value) / max);
      const x = pad + n * step,
        y = height - pad - h;
      // Rounded top corners never make a bar wider than its slot, and a
      // zero day draws nothing.
      const r = Math.min(4, bar / 2, h);
      const mark = h
        ? `<path d="M${x},${height - pad}V${y + r}q0,${-r} ${r},${-r}h${bar - 2 * r}q${r},0 ${r},${r}V${height - pad}Z" class="chart-mark"></path>`
        : "";
      // One bar per chart is a tab stop; arrow keys move between bars.
      return `<g class="chart-bar" role="img" tabindex="${n === series.length - 1 ? 0 : -1}" aria-label="${escape(`${d.date}: ${figure(num(d.value))}`)}"><rect class="chart-hit" x="${x}" y="${pad}" width="${step}" height="${height - pad * 2}"></rect>${mark}<title>${escape(`${d.date}: ${figure(num(d.value))}`)}</title></g>`;
    })
    .join("");
  return `<figure class="admin-chart"><figcaption>${escape(t(label))}</figcaption><svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${escape(t(label))}"><line x1="${pad}" x2="${width - pad}" y1="${height - pad}" y2="${height - pad}" class="chart-axis"></line><text x="${pad}" y="${pad - 8}" class="chart-tick">${escape(figure(max))}</text><text x="${pad}" y="${height - 6}" class="chart-tick">${escape(series[0]?.date || "")}</text><text x="${width - pad}" y="${height - 6}" text-anchor="end" class="chart-tick">${escape(series.at(-1)?.date || "")}</text>${bars}</svg><details><summary>${t("Show as table")}</summary><table class="admin-table"><thead><tr><th scope="col">${t("Date")}</th><th scope="col">${t("Value")}</th></tr></thead><tbody>${series.map((d) => `<tr><td>${escape(d.date)}</td><td>${figure(num(d.value))}</td></tr>`).join("")}</tbody></table></details></figure>`;
}
const tile = (label, value, detail = "") =>
  `<div class="stat-tile"><span class="stat-label">${t(label)}</span><strong class="stat-value">${escape(figure(value))}</strong>${detail ? `<span class="stat-detail">${t(detail)}</span>` : ""}</div>`;
const check = (id, label, checked, hint = "") =>
  `<label class="check-field"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}><span>${t(label)}${hint ? `<small>${t(hint)}</small>` : ""}</span></label>`;
const text = (id, label, value = "", extra = "") =>
  `<label class="field">${t(label)}<input id="${id}" value="${escape(value ?? "")}" ${extra}></label>`;
// Options marked as named by people, such as teams, are shown as written.
// Options are [value, label, named, context]; a named option shows a name
// as written, and a context picks the label's translation for its use.
const select = (id, label, value, options) =>
  `<label class="field">${t(label)}<select id="${id}">${options
    .map(
      ([v, l, named, context]) =>
        `<option value="${escape(v)}" ${v === value ? "selected" : ""}${named ? " data-user-content" : ""}>${escape(named ? l : t(l, context))}</option>`,
    )
    .join("")}</select></label>`;

// The labels shown for a person's role and status in the people list.
const PERSON_ROLES = {
  member: "Member",
  admin: "Administrator",
  guest: "Guest",
};
// The status a person's select shows. Someone not signed in yet is
// "active" there unless they will arrive deactivated.
const statusValue = (u) =>
  u.status === "pending"
    ? u.active === false
      ? "deactivated"
      : "active"
    : u.status;
const PERSON_STATUSES = {
  active: "Active",
  deactivated: "Deactivated",
  pending: "Provisioned, awaiting sign-in",
};

// Delivery failures name the HTTP status, and Entra its error code, inside
// the message; the rest of each message is translated around them.
const DELIVERY_MESSAGES = [
  [/^SIEM endpoint returned (\d+)\.$/, "SIEM endpoint returned {status}."],
  [/^Webhook returned (\d+)\.$/, "Webhook returned {status}."],
  [
    /^Sentinel ingestion failed \((\d+)\)\.$/,
    "Sentinel ingestion failed ({status}).",
  ],
  [
    /^Microsoft Entra sign-in failed \((\d+)\): (.*)$/s,
    "Microsoft Entra sign-in failed ({status}): {error}",
  ],
  [
    /^Slack refused the message \((\d+)\)\.$/,
    "Slack refused the message ({status}).",
  ],
  [
    /^Slack refused the message \((\d+)\): (.*)$/s,
    "Slack refused the message ({status}): {error}",
  ],
];
export function deliveryText(message) {
  for (const [pattern, template] of DELIVERY_MESSAGES) {
    const m = pattern.exec(message);
    if (m)
      return t(template)
        .replace("{status}", () => m[1])
        .replace("{error}", () => m[2] ?? "");
  }
  return t(message);
}
// What a request says when the organization's server cannot be reached.
const UNREACHABLE =
  "Could not reach the shared board. Check your connection and try again.";
export function createAdminConsole({
  org,
  modal,
  toast,
  icon,
  download,
  refresh = () => {},
  openBoard = async () => {},
  migrate = null,
  // Told when spaces or teams change here, for lists shown elsewhere.
  changed = () => {},
  // Archive, legal hold, delete and restore go to the board's own server.
  govern = (input) => call(window.puter, org.server, input),
}) {
  let dialog = null,
    closeNow = null,
    cache = {};
  const request = (op, data) => {
    const result = org.request(op, data);
    if (/^(spaces|teams)\.(?!list)/.test(op))
      Promise.resolve(result).then(changed, () => {});
    return result;
  };
  // Each tab loads its data with `load`; a load finishing after another tab
  // was opened is dropped so it never renders over the newer tab.
  let turn = 0;
  const STALE = Symbol("stale");
  // Counts the tabs people open, not the reloads after actions, so one
  // action's reload never discards another's result or its error.
  let visits = 0,
    shown = null;
  const load = (op, data) => {
    const mine = turn;
    return request(op, data).then((result) => {
      if (mine !== turn) throw STALE;
      return result;
    });
  };
  const panel = () => dialog?.querySelector("#admin-panel");
  const status = (message) => {
    const el = dialog?.querySelector("#admin-status");
    if (el) el.textContent = t(message);
  };
  // A failed action's explanation stays visible until the next action or
  // tab, rather than in a notification that fades.
  // Closing with changes not saved asks once; any later action or tab
  // asks again. Leaving the console for a board asks the same way.
  let discarding = false;
  const unsaved = () =>
    TABS.filter(([key]) => cache.drafts?.[key]).map(([, label]) => t(label));
  const mayDiscard = (again) => {
    const tabs = unsaved();
    if (!tabs.length || discarding) return true;
    report(
      t(`Changes in {tabs} are not saved. ${again}`).replace(
        "{tabs}",
        tabs.join(", "),
      ),
    );
    discarding = true;
    return false;
  };
  const report = (message) => {
    const el = dialog?.querySelector("#admin-error");
    if (!el) return;
    el.textContent = message ? deliveryText(message) : "";
    el.hidden = !message;
    if (!message) discarding = false;
  };
  // Irreversible actions take a second press on the same button.
  const confirmFirst = (button, label) => {
    if (button.dataset.confirmed) return false;
    button.dataset.confirmed = "1";
    button.dataset.label ??= button.textContent;
    button.textContent = t(label);
    status(label);
    return true;
  };
  // A confirmed action that failed is armed no longer: the next press
  // asks again rather than acting at once.
  const disarm = (button) => {
    if (!button?.dataset.confirmed) return;
    delete button.dataset.confirmed;
    if (button.dataset.label) button.textContent = button.dataset.label;
  };
  // `reload` shows a tab again after the action, unless another tab opened
  // while the action was running.
  async function guarded(button, fn) {
    report("");
    const done = busy(button);
    const started = visits;
    const reload = (tab) => (started === visits ? show(tab) : undefined);
    try {
      return await fn(reload);
    } catch (error) {
      // Another tab opened meanwhile; its result has nowhere to go.
      if (error === STALE || started !== visits) return;
      disarm(button);
      report(error.message || "Something went wrong.");
    } finally {
      done();
    }
  }
  function show(tab) {
    if (tab !== shown) visits++;
    shown = tab;
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    for (const el of tabs) {
      const active = el.dataset.tab === tab;
      el.setAttribute("aria-selected", String(active));
      el.tabIndex = active ? 0 : -1;
    }
    revealTab();
    panel().setAttribute("aria-labelledby", "admin-tab-" + tab);
    panel().innerHTML = `<p class="dialog-copy">${t("Loading…")}</p>`;
    status("");
    report("");
    // Filters applied on one tab are not announced on another.
    if (cache.applied !== tab) delete cache.applied;
    const mine = ++turn;
    return render[tab]().then(
      () => {
        if (mine !== turn) return;
        restoreFocus();
        refresh();
        revealTab();
      },
      (error) => {
        if (mine !== turn || !panel()) return;
        // A section that did not load says why in the console's words, as
        // the request's own message speaks of a shared board, and offers
        // to load it again.
        const message =
          error.message === UNREACHABLE
            ? "Could not reach your organization's server. Check your connection and try again."
            : error.message || "Could not load this section.";
        panel().innerHTML = `<p class="dialog-copy" role="alert">${escape(t(message))}</p><button type="button" class="secondary" id="admin-retry">${t("Try again")}</button>`;
        panel().querySelector("#admin-retry").onclick = () => show(tab);
        restoreFocus();
      },
    );
  }
  // On a phone the tabs are a row that scrolls sideways; the selected one
  // is brought into it, without scrolling the console.
  function revealTab() {
    const el = dialog?.querySelector('[role="tab"][aria-selected="true"]');
    if (!el) return;
    const row = el.parentElement.getBoundingClientRect(),
      box = el.getBoundingClientRect();
    if (box.left < row.left) el.parentElement.scrollLeft -= row.left - box.left;
    else if (box.right > row.right)
      el.parentElement.scrollLeft += box.right - row.right;
  }
  // Re-rendering a panel removes the control that had focus; keyboard and
  // screen reader users return to the same control, or to the panel. A row
  // control, such as a board's Archive button, is found again by its data
  // attributes; when its row is gone, the same control on the row now in
  // its place keeps their place in the list.
  let panelFocus = null;
  const IGNORED = ["data-confirmed", "data-label", "data-enabled"];
  const locate = (el) => {
    if (/^[\w-]+$/.test(el.id)) return { exact: `#${el.id}` };
    const attributes = [...el.attributes].filter(
      (a) => a.name.startsWith("data-") && !IGNORED.includes(a.name),
    );
    if (!attributes.length) return {};
    const family = attributes.map((a) => `[${a.name}]`).join("");
    return {
      exact: attributes
        .map((a) => `[${a.name}="${a.value.replace(/["\\]/g, "\\$&")}"]`)
        .join(""),
      family,
      index: [...panel().querySelectorAll(family)].indexOf(el),
    };
  };
  function restoreFocus() {
    const active = document.activeElement;
    if (panelFocus === null || (active && active !== document.body)) return;
    const { exact, family, index } = panelFocus;
    const similar = family ? [...panel().querySelectorAll(family)] : [];
    const target =
      (exact && panel().querySelector(exact)) ||
      similar[Math.min(index, similar.length - 1)] ||
      panel();
    target.focus();
  }
  // A settings form keeps what was typed while another tab is open, until
  // it is saved or the console closes, and says when it holds changes not
  // saved yet. The returned function forgets them once saved.
  const fieldKey = (el) =>
    el.id
      ? `#${el.id}`
      : el.name
        ? `[name="${el.name}"][value="${el.value}"]`
        : null;
  const fieldValues = (form) =>
    Object.fromEntries(
      [...form.querySelectorAll("input, select, textarea")]
        .map((el) => [
          fieldKey(el),
          el.type === "checkbox" ? el.checked : el.value,
        ])
        .filter(([key]) => key),
    );
  function draft(tab, form) {
    let saved = fieldValues(form);
    for (const [key, value] of Object.entries(cache.drafts?.[tab] || {})) {
      const el = key in saved && form.querySelector(key);
      if (el?.type === "checkbox") el.checked = value;
      else if (el) el.value = value;
    }
    const note = form.querySelector(".unsaved-note");
    // A draft holds only the fields typed in, so coming back to the tab
    // shows everything else as it is saved now.
    const keep = () => {
      const now = changes(fieldValues(form), saved);
      cache.drafts ||= {};
      if (!Object.keys(now).length) delete cache.drafts[tab];
      else cache.drafts[tab] = now;
      note.hidden = !cache.drafts[tab];
    };
    form.addEventListener("input", keep);
    form.addEventListener("change", keep);
    keep();
    // Saved is what was sent, taken when Save was pressed: a change typed
    // while the request was on its way is still unsaved afterwards.
    const drafts = cache;
    return Object.assign(
      (sent) => {
        saved = sent;
        const now = changes(
          form.isConnected
            ? fieldValues(form)
            : { ...sent, ...drafts.drafts?.[tab] },
          sent,
        );
        if (!Object.keys(now).length) delete drafts.drafts?.[tab];
        else (drafts.drafts ||= {})[tab] = now;
        note.hidden = !drafts.drafts?.[tab];
      },
      { snapshot: () => fieldValues(form) },
    );
  }
  const unsavedNote = () =>
    `<span class="unsaved-note" hidden>${t("Unsaved changes")}</span>`;
  const render = {
    async overview() {
      const days = cache.days || 30;
      const r = await load("org.reports", { days });
      cache.report = r;
      panel().innerHTML = `<div class="admin-toolbar">${select(
        "report-days",
        "Period",
        String(days),
        [
          ["7", "Last 7 days"],
          ["30", "Last 30 days"],
          ["90", "Last 90 days"],
          ["180", "Last 180 days"],
        ],
      )}<button class="secondary" id="report-json">${icon("download")}${t("Export report")}</button><button class="secondary" id="report-users">${icon("download")}${t("Inactive users (CSV)")}</button></div>
<div class="stat-grid">${tile("Active users", r.users.active, `${figure(num(r.users.activeLast30Days))} ${t("active in the last 30 days", singular(num(r.users.activeLast30Days)) ? "one" : undefined)}`)}${tile("Inactive users", r.users.inactiveCount ?? r.users.inactive.length, "No activity in 30 days")}${tile("Guests", r.users.guests)}${tile("Deactivated", r.users.deactivated)}${tile("Boards", r.boards.total, `${figure(num(r.boards.activeLast30Days))} ${t("active in the last 30 days", singular(num(r.boards.activeLast30Days)) ? "one" : undefined)}`)}${tile("Stale boards", r.boards.stale, "No activity in 90 days")}${tile("Boards with guests", r.sharing.withGuests, count(r.sharing.guestMemberships, "guest membership", "guest memberships"))}${tile("Public links", r.sharing.publicLinks)}${tile("Largest session", r.sessions.largest[0]?.participants || 0, count(r.sessions.sessionsOver50, "session with 50 or more people", "sessions with 50 or more people"))}${tile("Time on boards", duration(r.usage.minutesPerDay.reduce((n, d) => n + num(d.value), 0)), "Total in this period")}${tile("Ease of use", r.feedback.averageEase ?? "-", count(r.feedback.responses, "rating out of 5", "ratings out of 5"))}</div>
${barChart(r.usage.dailyActiveUsers, "Daily active users")}${barChart(r.usage.peakConcurrent, "Largest simultaneous session per day")}${barChart(r.usage.minutesPerDay, "Minutes spent on boards per day")}${barChart(
        r.boards.createdByWeek.map((w) => ({ date: w.week, value: w.created })),
        "Boards created per week",
      )}
<div class="admin-columns"><section><h3>${t("Top board owners")}</h3><table class="admin-table"><thead><tr><th scope="col">${t("Owner")}</th><th scope="col">${t("Boards")}</th></tr></thead><tbody>${r.boards.topOwners.map((o) => `<tr><td>${user(o.username || o.uuid)}</td><td>${figure(num(o.count))}</td></tr>`).join("") || `<tr><td colspan="2">${t("None")}</td></tr>`}</tbody></table></section><section><h3>${t("Largest sessions")}</h3><table class="admin-table"><thead><tr><th scope="col">${t("Board")}</th><th scope="col">${t("People")}</th><th scope="col">${t("When")}</th></tr></thead><tbody>${r.sessions.largest.map((s) => `<tr><td>${user(s.title)}</td><td>${figure(num(s.participants))}</td><td class="date-cell">${date(s.at)}</td></tr>`).join("") || `<tr><td colspan="3">${t("None")}</td></tr>`}</tbody></table></section></div>
<section><h3>${t("Feedback")}</h3>${r.feedback.responses ? `<table class="admin-table"><thead><tr><th scope="col">${t("Rating")}</th><th scope="col">${t("Responses")}</th></tr></thead><tbody>${r.feedback.distribution.map((n, i) => `<tr><td>${i + 1} / 5</td><td>${figure(num(n))}</td></tr>`).join("")}</tbody></table><ul class="feedback-comments">${r.feedback.recent.map((f) => `<li><strong>${figure(num(f.ease))} / 5</strong> ${authoredTextHTML(f, f.comment)}</li>`).join("")}</ul>` : `<p class="dialog-copy">${t("No feedback yet. People can rate their experience from Help and training.")}</p>`}</section><section><h3>${t("Boards shared outside the organization")}</h3>${num(r.sharing.sharedOutside) > r.sharing.boardsWithGuests.length ? `<div class="admin-results"><p class="dialog-copy">${fill("Showing the {shown} with the most guests of {total} boards shared outside the organization. Export CSV on the Boards tab lists every board with its guests.", { shown: r.sharing.boardsWithGuests.length, total: r.sharing.sharedOutside })}</p><div class="admin-results-actions"><button type="button" class="secondary" id="report-link-boards">${t("Show boards open to anyone with the link")}</button></div></div>` : ""}<table class="admin-table"><thead><tr><th scope="col">${t("Board")}</th><th scope="col">${t("Guests")}</th><th scope="col">${t("Visibility")}</th></tr></thead><tbody>${r.sharing.boardsWithGuests.map((b) => `<tr><td>${user(b.title)}</td><td>${figure(num(b.guests))}</td><td>${t(b.visibility === "link" ? "Anyone with the link" : b.visibility === "organization" ? "Organization" : "Invited people")}</td></tr>`).join("") || `<tr><td colspan="3">${t("None")}</td></tr>`}</tbody></table></section>`;
      panel().querySelector("#report-days").onchange = (e) => {
        cache.days = Number(e.target.value);
        show("overview");
      };
      // The directory lists the boards past the report's 50, with the one
      // filter that finds boards shared outside the organization.
      panel()
        .querySelector("#report-link-boards")
        ?.addEventListener("click", () => {
          cache.boardFilters = {
            archived: false,
            sort: "updated",
            visibility: "link",
          };
          cache.boardLimit = 200;
          show("boards");
        });
      panel().querySelector("#report-json").onclick = () =>
        download(
          JSON.stringify(r, null, 2),
          "organization-report.json",
          "application/json",
        );
      // The report lists the first 5,000 inactive people; the export
      // holds them all.
      panel().querySelector("#report-users").onclick = (e) =>
        guarded(e.currentTarget, async () => {
          const people =
            (r.users.inactiveCount ?? 0) > r.users.inactive.length
              ? (await request("org.reports", { days, allInactive: true }))
                  .users.inactive
              : r.users.inactive;
          download(
            toCSV(people, [
              "username",
              "email",
              [
                "lastActive",
                (u) => u.lastActive && new Date(u.lastActive).toISOString(),
              ],
            ]),
            "inactive-users.csv",
            "text/csv",
          );
        });
    },
    async people() {
      const [{ users: listed, owner }, { teams: listedTeams }] =
        await Promise.all([load("org.users.list"), load("teams.list")]);
      // The worker lists people and teams in storage order; with hundreds
      // of people they read by name instead, in every list on this tab.
      const byName = names();
      const users = [...listed].sort((a, b) =>
        byName(a.username || a.email || "", b.username || b.email || ""),
      );
      const teams = [...listedTeams].sort((a, b) => byName(a.name, b.name));
      const teamName = new Map(teams.map((tm) => [tm.id, tm.name]));
      const managesAdmins = org.info?.role !== "admin";
      const pageSize = 50;
      let peoplePage = cache.peoplePage || 0;
      const matchingPeople = (filter = "") =>
        users.filter(
          (u) =>
            !filter ||
            [
              u.username,
              u.email,
              u.role,
              u.status,
              // And the labels on screen, so a search in French finds them.
              t(PERSON_ROLES[u.role]),
              t(PERSON_STATUSES[u.status], "person"),
            ]
              .join(" ")
              .toLowerCase()
              .includes(filter),
        );
      const rows = (shown) =>
        shown
          .map(
            (u, n) =>
              `<tr><th scope="row" id="person-name-${n}">${user(u.username || t("Not signed in yet"))}<br><small>${user(u.email || "")}${u.email && !u.emailVerified ? ` · ${t("unverified")}` : ""}</small></th><td><select data-role="${escape(u.uuid)}" ${!managesAdmins && u.role === "admin" ? 'disabled aria-describedby="admin-permissions"' : ""} aria-label="${escape(t("Role for") + " " + (u.username || u.email || ""))}">${["member", "admin", "guest"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""} ${!managesAdmins && r === "admin" ? "disabled" : ""}>${t(PERSON_ROLES[r])}</option>`).join("")}</select></td><td><select data-status="${escape(u.uuid)}" ${!managesAdmins && u.role === "admin" ? 'disabled aria-describedby="admin-permissions"' : ""} aria-label="${escape(t("Status for") + " " + (u.username || u.email || ""))}">${["active", "deactivated"].map((v) => `<option value="${v}" ${statusValue(u) === v ? "selected" : ""}>${v === "active" && u.status === "pending" ? t(PERSON_STATUSES.pending) : t(PERSON_STATUSES[v], "person")}</option>`).join("")}</select></td><td>${(u.teams || []).map((id) => user(teamName.get(id) || id)).join(", ")}</td><td class="date-cell">${date(u.lastActive)}</td><td><button class="text-btn" data-transfer="${escape(u.uuid)}" aria-describedby="person-name-${n}${!managesAdmins && u.role === "admin" ? ' admin-permissions" disabled' : '"'}>${t("Transfer boards")}</button></td></tr>`,
          )
          .join("") ||
        `<tr><td colspan="6">${t(cache.peopleQuery?.trim() ? "No people match your search." : "No one has joined yet.")}</td></tr>`;
      panel().innerHTML = `<div class="admin-toolbar"><label class="search">${icon("search")}<input id="people-search" type="search" value="${escape(cache.peopleQuery || "")}" aria-label="${t("Search people")}" placeholder="${t("Search people")}"></label>${select(
        "invite-role",
        "Invite as",
        "member",
        [
          ["member", "Member"],
          ["guest", "Guest"],
          ...(managesAdmins ? [["admin", "Administrator"]] : []),
        ],
      )}<button class="primary" id="invite-people">${icon("user-plus")}${t("Create invitation link")}</button><button class="secondary" id="revoke-org-invites">${t("Revoke invitation links")}</button></div><div class="share-link-row" hidden id="invite-output-field"><label class="field">${t("Organization invitation link")}<input id="invite-output" readonly aria-describedby="invite-output-note"></label><button type="button" class="secondary" data-copy="invite-output" data-copied="Link copied.">${icon("copy")}${t("Copy link")}</button></div><p class="dialog-copy" hidden id="invite-output-note"></p>
<p class="dialog-copy">${labelled(t("Account owner"), "")}${user(owner.username)}. ${t("People who verify an email address in your organization's domains join automatically when domain capture is on. SCIM provisioning adds people before they first sign in.")}</p>
${!managesAdmins ? `<p id="admin-permissions" class="dialog-copy">${t("Only the account owner can invite administrators, change their roles and status, or transfer their boards.")}</p>` : ""}
<div class="admin-pagination admin-results"><p id="people-count" class="dialog-copy" role="status"></p><div class="admin-results-actions"><button class="secondary" id="export-people">${icon("download")}${t("Export CSV")}</button></div><div id="people-pages"><button type="button" class="secondary" id="people-prev" aria-label="${t("Previous page")}">${t("Previous")}</button><button type="button" class="secondary" id="people-next" aria-label="${t("Next page")}">${t("Next")}</button></div></div>
<div class="table-scroll"><table class="admin-table"><thead><tr><th scope="col">${t("Person")}</th><th scope="col">${t("Role")}</th><th scope="col">${t("Status")}</th><th scope="col">${t("Teams")}</th><th scope="col">${t("Last active")}</th><th scope="col"><span class="sr-only">${t("Actions")}</span></th></tr></thead><tbody id="people-rows"></tbody></table></div>
<section><div class="section-heading"><h3>${t("Teams")}</h3><button class="secondary" id="new-team">${icon("plus")}${t("New team")}</button></div><div id="team-list">${teams.map((tm, n) => `<div class="team-row"><strong id="team-name-${n}" data-user-content>${escape(tm.name)}</strong><span>${count(tm.members.length, "member", "members")}</span><button class="text-btn" data-edit-team="${escape(tm.id)}" aria-describedby="team-name-${n}">${t("Edit")}</button><button class="text-btn danger" data-delete-team="${escape(tm.id)}" aria-describedby="team-name-${n}">${t("Delete")}</button></div>`).join("") || `<p>${t("No teams yet. Teams can also be synchronized from Google Workspace groups through SCIM.")}</p>`}</div></section>`;
      // Keep the loaded list in step with the server, so searching redraws
      // the saved values, and put back a value the server refused.
      const peopleRows = panel().querySelector("#people-rows");
      const pendingPeople = new Map();
      const syncPerson = (person) => {
        if (!person || !peopleRows.isConnected) return;
        for (const el of peopleRows.querySelectorAll(
          "[data-role], [data-status]",
        )) {
          const field = el.hasAttribute("data-role") ? "role" : "status";
          if (el.dataset[field] !== person.uuid) continue;
          const pending = pendingPeople.get(person.uuid);
          el.value =
            pending?.field === field
              ? pending.value
              : field === "status"
                ? statusValue(person)
                : person[field];
          const restricted = !managesAdmins && person.role === "admin";
          // The select being saved keeps the keyboard, which browsers drop
          // from a disabled control: it reads unavailable instead, and a
          // choice made meanwhile springs back.
          const waiting = pendingPeople.has(person.uuid),
            focused = waiting && el === document.activeElement;
          el.disabled = (waiting && !focused) || restricted;
          if (focused) el.setAttribute("aria-disabled", "true");
          else el.removeAttribute("aria-disabled");
          if (restricted)
            el.setAttribute("aria-describedby", "admin-permissions");
          else el.removeAttribute("aria-describedby");
        }
      };
      const change = async (uuid, field, el) => {
        if (pendingPeople.has(uuid)) return;
        const person = users.find((u) => u.uuid === uuid);
        const value = el.value;
        pendingPeople.set(uuid, { field, value });
        syncPerson(person);
        try {
          const { user: saved } = await request("org.users.update", {
            uuid,
            [field]: value,
          });
          // The saved record leaves out activity, which the list merges in.
          if (person)
            Object.assign(person, saved, {
              lastActive:
                Math.max(person.lastActive || 0, saved?.lastActive || 0) ||
                null,
            });
        } catch (error) {
          if (person)
            el.value = field === "status" ? statusValue(person) : person[field];
          throw error;
        } finally {
          pendingPeople.delete(uuid);
          syncPerson(person);
        }
      };
      // One person at a time waits for the second choice of Deactivated,
      // or of a role that gives or takes away administration.
      const disarmDeactivate = () => {
        for (const el of panel().querySelectorAll(
          "[data-status][data-confirmed], [data-role][data-confirmed]",
        )) {
          delete el.dataset.confirmed;
          el.removeAttribute("aria-describedby");
        }
        panel().querySelector("#deactivate-note")?.remove();
        panel().querySelector("#role-note")?.remove();
      };
      // The request for a second choice shows in a note under the select as
      // well as to screen readers.
      const askAgain = (el, id, message) => {
        const note = document.createElement("small");
        note.id = id;
        note.className = "row-note";
        note.textContent = message;
        el.after(note);
        el.setAttribute("aria-describedby", note.id);
        status(message);
      };
      const bindRows = () => {
        for (const uuid of pendingPeople.keys())
          syncPerson(users.find((u) => u.uuid === uuid));
        panel()
          .querySelectorAll("[data-role]")
          .forEach((el) => {
            el.onchange = () => {
              const person = users.find((u) => u.uuid === el.dataset.role);
              if (pendingPeople.has(el.dataset.role)) return syncPerson(person);
              // Making someone an administrator, or no longer one, changes
              // what they control, and a select changes as the arrow keys
              // pass through it: as with Deactivated, the first choice
              // springs back and asks for a second.
              const value = el.value,
                was = person?.role;
              const asking =
                (value === "admin" || was === "admin") &&
                el.dataset.confirmed !== value;
              disarmDeactivate();
              if (asking && was) {
                el.dataset.confirmed = value;
                el.value = was;
                askAgain(
                  el,
                  "role-note",
                  value === "admin"
                    ? t(
                        "Choose Administrator again to make this person an administrator.",
                      )
                    : t(
                        "Choose {role} again to take away this person's administrator rights.",
                      ).replace("{role}", () => t(PERSON_ROLES[value])),
                );
                return;
              }
              guarded(null, () =>
                change(el.dataset.role, "role", el).then(() =>
                  toast("Role updated."),
                ),
              );
            };
          });
        panel()
          .querySelectorAll("[data-status]")
          .forEach((el) => {
            el.onchange = () => {
              // Deactivating ends the person's sessions at once, and a
              // select changes as the arrow keys pass through it: the
              // first choice springs back and asks for a second, in a
              // note under the select as well as to screen readers.
              const person = users.find((u) => u.uuid === el.dataset.status);
              if (pendingPeople.has(el.dataset.status))
                return syncPerson(person);
              const asking =
                el.value === "deactivated" && !el.dataset.confirmed;
              disarmDeactivate();
              if (asking) {
                el.dataset.confirmed = "1";
                el.value = person ? statusValue(person) : "active";
                askAgain(
                  el,
                  "deactivate-note",
                  t("Choose Deactivated again to end this person's sessions."),
                );
                return;
              }
              guarded(null, () =>
                change(el.dataset.status, "status", el).then(() =>
                  toast(
                    el.value === "deactivated"
                      ? "Account deactivated. Their sessions end now."
                      : "Account reactivated.",
                  ),
                ),
              );
            };
          });
        panel()
          .querySelectorAll("[data-transfer]")
          .forEach((el) => {
            el.onclick = () => {
              const choices = [
                owner,
                ...users.filter(
                  (u) =>
                    u.status === "active" &&
                    u.role !== "guest" &&
                    u.uuid !== el.dataset.transfer,
                ),
              ];
              // One transfer form at a time, in a row under its person.
              dialog.querySelector("#transfer-target")?.closest("tr")?.remove();
              const target = document.createElement("div");
              target.id = "transfer-target";
              target.className = "inline-form";
              target.innerHTML = `<label class="field">${t("New owner")}<select id="transfer-to">${choices.map((c) => `<option value="${escape(c.uuid)}" data-user-content>${escape(c.username || c.email || c.uuid)}</option>`).join("")}</select></label><button type="button" class="secondary" id="transfer-cancel">${t("Cancel")}</button><button class="primary" id="transfer-go">${t("Transfer all boards")}</button>`;
              el.closest("tr").after(
                Object.assign(document.createElement("tr"), {
                  innerHTML: `<td colspan="6"></td>`,
                }),
              );
              el.closest("tr").nextElementSibling.firstChild.append(target);
              target.querySelector("#transfer-to").focus();
              const go = target.querySelector("#transfer-go");
              // Every board the person owns moves at once: the button asks
              // for a second press, and choosing another owner asks again.
              target.querySelector("#transfer-to").onchange = () => disarm(go);
              target.querySelector("#transfer-cancel").onclick = () => {
                target.closest("tr").remove();
                el.focus();
              };
              go.onclick = () =>
                confirmFirst(go, "Confirm transfer") ||
                guarded(go, async () => {
                  // The worker moves boards a batch at a time.
                  const to = target.querySelector("#transfer-to").value;
                  let transferred = 0,
                    after = null;
                  do {
                    const moved = await request("org.users.transfer", {
                      from: el.dataset.transfer,
                      to,
                      ...(after ? { after } : {}),
                    });
                    transferred += moved.transferred;
                    after = moved.next || null;
                  } while (after);
                  toast(
                    count(
                      transferred,
                      "board transferred.",
                      "boards transferred.",
                    ),
                  );
                  // Focus returns to the row's button, not the page.
                  target.closest("tr").remove();
                  el.focus();
                });
              refresh();
            };
          });
      };
      const search = panel().querySelector("#people-search"),
        previous = panel().querySelector("#people-prev"),
        next = panel().querySelector("#people-next"),
        pages = panel().querySelector("#people-pages"),
        summary = panel().querySelector("#people-count");
      const paintPeople = () => {
        const focused = document.activeElement;
        const matching = matchingPeople(search.value.trim().toLowerCase());
        peoplePage = Math.min(
          peoplePage,
          Math.max(0, Math.ceil(matching.length / pageSize) - 1),
        );
        cache.peoplePage = peoplePage;
        cache.peopleQuery = search.value;
        const start = peoplePage * pageSize;
        panel().querySelector("#people-rows").innerHTML = rows(
          matching.slice(start, start + pageSize),
        );
        summary.textContent = matching.length
          ? fill("Showing people {from}–{to} of {total}.", {
              from: start + 1,
              to: Math.min(start + pageSize, matching.length),
              total: matching.length,
            })
          : t(
              search.value.trim()
                ? "No people match your search."
                : "No one has joined yet.",
            );
        previous.disabled = peoplePage === 0;
        next.disabled = start + pageSize >= matching.length;
        pages.hidden = matching.length <= pageSize;
        bindRows();
        keepPaginationFocus(focused, previous, next, search);
        refresh();
      };
      search.oninput = () => {
        peoplePage = 0;
        paintPeople();
      };
      previous.onclick = () => {
        peoplePage--;
        paintPeople();
      };
      next.onclick = () => {
        peoplePage++;
        paintPeople();
      };
      paintPeople();
      panel().querySelector("#invite-people").onclick = (e) =>
        guarded(e.currentTarget, async () => {
          const role = panel().querySelector("#invite-role").value;
          // The link goes in the People tab; once another tab has opened
          // there is nowhere to show it.
          const { token } = await load("org.invite", { role });
          const field = panel().querySelector("#invite-output");
          field.value = organizationLink(org.server, token);
          panel().querySelector("#invite-output-field").hidden = false;
          field.select();
          // Who the link admits and for how long shows beside it, not only
          // to screen readers.
          const message =
            role === "admin"
              ? "Invitation link created. It works for one person and expires in 14 days."
              : "Invitation link created. It expires in 14 days.";
          const note = panel().querySelector("#invite-output-note");
          note.textContent = t(message);
          note.hidden = false;
          status(message);
        });
      panel().querySelector("#revoke-org-invites").onclick = (e) => {
        const button = e.currentTarget;
        if (confirmFirst(button, "Confirm revoke")) return;
        guarded(button, async () => {
          await load("org.invite.revoke");
          delete button.dataset.confirmed;
          button.textContent = t("Revoke invitation links");
          // A link shown before no longer works, so it is not offered.
          panel().querySelector("#invite-output-field").hidden = true;
          panel().querySelector("#invite-output").value = "";
          panel().querySelector("#invite-output-note").hidden = true;
          toast("Invitation links revoked.");
        });
      };
      // The export lists everyone in the organization, the account owner
      // first, as the people list names them above the table.
      panel().querySelector("#export-people").onclick = () =>
        download(
          toCSV(
            [
              ...(owner?.uuid
                ? [{ status: "active", ...owner, role: "owner" }]
                : []),
              ...users.filter((u) => u.uuid !== owner?.uuid),
            ],
            [
              "username",
              "email",
              "role",
              "status",
              "license",
              [
                "teams",
                (u) =>
                  (u.teams || [])
                    .map((id) => teamName.get(id) || id)
                    .join("; "),
              ],
              [
                "lastActive",
                (u) => u.lastActive && new Date(u.lastActive).toISOString(),
              ],
              "source",
            ],
          ),
          "people.csv",
          "text/csv",
        );
      const editTeam = (team, opener) => {
        // One team form at a time, so its fields keep unique ids.
        panel().querySelector("#team-list > form")?.remove();
        const form = document.createElement("form");
        form.className = "inline-form";
        const eligible = users.filter((u) => u.status !== "deactivated");
        // Selection belongs to the draft, rather than just visible checkboxes.
        // Deactivated and missing members stay selected unless explicitly changed.
        const before = new Set(team?.members || []);
        const selected = new Set(before);
        let memberPage = 0;
        form.innerHTML = `${text("team-name", "Team name", team?.name || "", 'required maxlength="120"')}<fieldset><legend>${t("Members")}</legend><label class="search"><input type="search" id="team-member-search" aria-label="${t("Search team members")}" placeholder="${t("Search team members")}"></label><div class="admin-pagination"><p id="team-member-count" role="status"></p><div id="team-member-pages"><button type="button" class="secondary" id="team-member-prev" aria-label="${t("Previous members")}">${t("Previous")}</button><button type="button" class="secondary" id="team-member-next" aria-label="${t("Next members")}">${t("Next")}</button></div></div><div id="team-member-list" class="check-list team-member-list"></div><p id="team-member-selected" role="status"></p></fieldset><div class="dialog-footer"><button type="button" class="secondary" id="team-cancel">${t("Cancel")}</button><button class="primary">${t("Save team")}</button></div>`;
        const search = form.querySelector("#team-member-search"),
          list = form.querySelector("#team-member-list"),
          previous = form.querySelector("#team-member-prev"),
          next = form.querySelector("#team-member-next"),
          pages = form.querySelector("#team-member-pages"),
          summary = form.querySelector("#team-member-count"),
          selectedSummary = form.querySelector("#team-member-selected");
        const selectionSummary = () => {
          selectedSummary.textContent = fill("Selected members: {count}.", {
            count: selected.size,
          });
        };
        const paintMembers = () => {
          const focused = document.activeElement;
          const query = search.value.trim().toLowerCase();
          const matching = eligible.filter((u) =>
            [u.username, u.email].join(" ").toLowerCase().includes(query),
          );
          memberPage = Math.min(
            memberPage,
            Math.max(0, Math.ceil(matching.length / pageSize) - 1),
          );
          const start = memberPage * pageSize;
          list.innerHTML = matching
            .slice(start, start + pageSize)
            .map(
              (u) =>
                `<label><input type="checkbox" value="${escape(u.uuid)}" ${selected.has(u.uuid) ? "checked" : ""}><span data-user-content>${escape(u.username || u.email)}${u.username && u.email ? `<small>${escape(u.email)}</small>` : ""}</span></label>`,
            )
            .join("");
          list.scrollTop = 0;
          summary.textContent = matching.length
            ? fill("Showing members {from}–{to} of {total}.", {
                from: start + 1,
                to: Math.min(start + pageSize, matching.length),
                total: matching.length,
              })
            : t("No people match your search.");
          previous.disabled = memberPage === 0;
          next.disabled = start + pageSize >= matching.length;
          pages.hidden = matching.length <= pageSize;
          selectionSummary();
          keepPaginationFocus(focused, previous, next, search);
        };
        search.oninput = () => {
          memberPage = 0;
          paintMembers();
        };
        // Enter in the search filters, as typing does; it never saves the
        // team before its members are chosen.
        search.onkeydown = (e) => {
          if (e.key === "Enter" && !e.isComposing) e.preventDefault();
        };
        previous.onclick = () => {
          memberPage--;
          paintMembers();
        };
        next.onclick = () => {
          memberPage++;
          paintMembers();
        };
        list.onchange = (e) => {
          const checkbox = e.target;
          if (!checkbox.matches('input[type="checkbox"]')) return;
          if (checkbox.checked) selected.add(checkbox.value);
          else selected.delete(checkbox.value);
          selectionSummary();
        };
        paintMembers();
        panel().querySelector("#team-list").prepend(form);
        form.querySelector("#team-cancel").onclick = () => {
          form.remove();
          opener.focus();
        };
        form.onsubmit = (e) => {
          e.preventDefault();
          if (form.querySelector(".primary").disabled) return;
          guarded(form.querySelector(".primary"), async (reload) => {
            const fieldset = form.querySelector("fieldset");
            const name = form.querySelector("#team-name");
            fieldset.disabled = true;
            name.disabled = true;
            try {
              if (!team)
                await request("teams.create", {
                  name: name.value,
                  members: [...selected],
                });
              else {
                // Only who joined or left here is sent, so people another
                // administrator or SCIM added meanwhile stay in the team.
                const add = [...selected].filter((id) => !before.has(id)),
                  remove = [...before].filter((id) => !selected.has(id));
                const { team: saved } = await request("teams.update", {
                  id: team.id,
                  name: name.value,
                  add,
                  remove,
                });
                // A worker from before additions and removals ignores
                // them; it gets the whole list, built on its own.
                const now = new Set(saved?.members || []);
                if (
                  saved &&
                  (add.some((id) => !now.has(id)) ||
                    remove.some((id) => now.has(id)))
                )
                  await request("teams.update", {
                    id: team.id,
                    name: name.value,
                    members: [...now, ...add].filter(
                      (id) => !remove.includes(id),
                    ),
                  });
              }
            } finally {
              fieldset.disabled = false;
              name.disabled = false;
            }
            reload("people");
          });
        };
        refresh();
        form.querySelector("#team-name").focus();
      };
      panel().querySelector("#new-team").onclick = (e) =>
        editTeam(null, e.currentTarget);
      panel()
        .querySelectorAll("[data-edit-team]")
        .forEach((el) => {
          el.onclick = () =>
            editTeam(
              teams.find((tm) => tm.id === el.dataset.editTeam),
              el,
            );
        });
      panel()
        .querySelectorAll("[data-delete-team]")
        .forEach((el) => {
          el.onclick = () =>
            confirmFirst(el, "Confirm delete") ||
            guarded(el, async (reload) => {
              await request("teams.delete", { id: el.dataset.deleteTeam });
              reload("people");
            });
        });
    },
    async boards() {
      const filters = cache.boardFilters || {
        archived: false,
        sort: "updated",
      };
      const limit = cache.boardLimit || 200;
      const [
        { boards, total: listed = boards.length },
        listedTeams,
        listedSpaces,
        people,
        settings,
      ] = await Promise.all([
        load("org.boards", boardFilters({ ...filters, scope: "all", limit })),
        load("teams.list"),
        load("spaces.list"),
        load("org.users.list"),
        // Only to tell whether the organization-wide legal hold is on; the
        // directory still opens without it.
        load("org.policy.get").catch((error) => {
          if (error === STALE) throw error;
          return null;
        }),
      ]);
      // A board under a legal hold, its own or the organization's, cannot
      // be deleted: Delete is unavailable, and the note says why.
      const heldByOrganization = !!settings?.policy?.retention?.legalHold;
      const holdNote = t(
        heldByOrganization
          ? "The organization-wide legal hold is on, so no board can be deleted until it is turned off in Policies."
          : "A board under a legal hold cannot be deleted until its hold is released.",
      );
      const held = (b) => heldByOrganization || !!b.legalHold;
      // How many boards match, which an action or a later page can change.
      let total = listed;
      const byName = names();
      // Everyone who can own a board: the account owner and the people.
      const owners = [
        ...(people?.owner?.uuid
          ? [[people.owner.uuid, people.owner.username || people.owner.uuid]]
          : []),
        ...(people?.users || []).map((u) => [
          u.uuid,
          u.username || u.email || u.uuid,
        ]),
      ].sort((a, b) => byName(a[1], b[1]));
      const [teams, spaces] = [listedTeams.teams, listedSpaces.spaces].map(
        (list) => [...list].sort((a, b) => byName(a.name, b.name)),
      );
      // A team or space deleted since it was chosen can no longer show in
      // its filter, which would read Any while still narrowing the list.
      const gone = (key, list) =>
        filters[key] && !list.some((item) => item.id === filters[key]);
      if (gone("team", teams) || gone("space", spaces)) {
        cache.boardFilters = {
          ...filters,
          team: gone("team", teams) ? undefined : filters.team,
          space: gone("space", spaces) ? undefined : filters.space,
        };
        return render.boards();
      }
      // A board's row; its name heads the row, and each action's
      // description names the board it acts on. Rows added later number
      // on from those shown, so each keeps its own id.
      let rowCount = 0;
      // Boards chosen for an action on many at once, by room.
      const chosen = new Set();
      const boardRow = (b, n = rowCount++) =>
        `<tr><td class="row-select"><input type="checkbox" data-select="${escape(b.room)}" aria-labelledby="board-name-${n}"${chosen.has(b.room) ? " checked" : ""}></td><th scope="row" id="board-name-${n}">${user(b.title)}${b.legalHold ? ` <span class="badge">${t("Legal hold")}</span>` : ""}${b.archived ? ` <span class="badge">${t("Archived")}</span>` : ""}</th><td>${user(b.ownerName || b.owner)}</td><td class="date-cell">${date(b.lastActivity || b.created)}</td><td>${figure(num(b.objectCount))}</td><td>${t(b.visibility === "link" ? "Anyone with the link" : b.visibility === "organization" ? "Organization" : "Invited people")}${b.guestCount ? ` · ${count(b.guestCount, "guest", "guests")}` : ""}</td><td class="row-actions"><button class="text-btn" aria-describedby="board-name-${n}" data-open-board="${escape(b.room)}">${t("Open", "action")}</button><button class="text-btn" aria-describedby="board-name-${n}" data-activity="${escape(b.room)}">${t("Activity")}</button>${b.deleted ? `<button class="text-btn" aria-describedby="board-name-${n}" data-govern="restore" data-room="${escape(b.room)}">${t("Restore")}</button>` : `<button class="text-btn" aria-describedby="board-name-${n}" data-govern="${b.archived ? "unarchive" : "archive"}" data-room="${escape(b.room)}">${t(b.archived ? "Unarchive" : "Archive")}</button><button class="text-btn" aria-describedby="board-name-${n}" data-govern="hold" data-enabled="${!b.legalHold}" data-room="${escape(b.room)}">${t(b.legalHold ? "Release hold" : "Legal hold")}</button><button class="text-btn danger" data-govern="delete" data-room="${escape(b.room)}" aria-describedby="board-name-${n}${held(b) ? ` board-hold-note" disabled title="${escape(holdNote)}` : ""}">${t("Delete")}</button>`}</td></tr>`;
      // The actions for many boards at once, as the State listed allows.
      const BULK = {
        archive: "Archive selected",
        unarchive: "Unarchive selected",
        restore: "Restore selected",
        hold: "Place legal hold on selected",
        delete: "Delete selected",
      };
      const bulk = filters.deleted
        ? ["restore"]
        : [filters.archived ? "unarchive" : "archive", "hold", "delete"];
      // The directory shows up to 1,000 boards, 200 more at a time.
      const more = () => total > boards.length && boards.length < 1000;
      const countText = () =>
        total > boards.length
          ? `${fill("Showing {shown} of {total} boards.", { shown: boards.length, total })}${boards.length >= 1000 ? ` ${t("Refine the filters to find others; Export CSV includes them all.")}` : ""}`
          : count(boards.length, "board", "boards");
      panel().innerHTML = `<form class="admin-filters" id="board-filters">${text("bf-query", "Search", filters.query || "", 'type="search"')}${select(
        "bf-activity",
        "Activity",
        filters.activity || "",
        [
          ["", "Any"],
          ["active", "Active in 30 days"],
          ["stale", "No activity in 90 days"],
          ["unused", "Empty boards"],
        ],
      )}${select("bf-visibility", "Visibility", filters.visibility || "", [
        ["", "Any"],
        ["private", "Invited people"],
        ["organization", "Organization"],
        ["link", "Anyone with the link"],
      ])}${select("bf-owner", "Owner", filters.owner || "", [["", "Anyone"], ...owners.map(([uuid, name]) => [uuid, name, true])])}${select("bf-team", "Team", filters.team || "", [["", "Any"], ...teams.map((tm) => [tm.id, tm.name, true])])}${select("bf-space", "Space", filters.space || "", [["", "Any", false, "space"], ...spaces.map((s) => [s.id, s.name, true])])}${select(
        "bf-type",
        "Contains",
        filters.type || "",
        [
          ["", "Anything"],
          ["note", "Sticky notes"],
          ["table", "Tables"],
          ["image", "Images"],
          ["file", "Files"],
          ["frame", "Frames"],
          ["link", "Links"],
        ],
      )}${select(
        "bf-state",
        "State",
        filters.deleted ? "deleted" : filters.archived ? "archived" : "",
        [
          ["", "Current"],
          ["archived", "Archived", false, "boards"],
          ["deleted", "Deleted (recoverable)"],
        ],
      )}<label class="field">${t("Updated after")}<input type="date" min="0100-01-01" max="9999-12-31" id="bf-after" value="${escape(filters.updatedAfter || "")}"></label>${select(
        "bf-sort",
        "Sort",
        filters.sort || "updated",
        [
          ["updated", "Last activity"],
          ["created", "Created"],
          ["title", "Name"],
          ["size", "Size"],
        ],
      )}<button class="primary" id="bf-apply">${t("Apply")}</button><button type="button" class="secondary" id="bf-duplicates">${t("Find duplicates")}</button></form>
<div class="admin-results"><p id="board-count" class="dialog-copy" role="status">${countText()}</p><div class="admin-results-actions"><button type="button" class="secondary" id="bf-export">${icon("download")}${t("Export CSV")}</button>${migrate ? `<button type="button" class="secondary" id="bf-migrate">${icon("import")}${t("Migrate from Miro")}</button>` : ""}</div></div><p id="board-hold-note" class="dialog-copy"${boards.some(held) ? "" : " hidden"}>${escape(holdNote)}</p>${boards.length ? `<div class="bulk-actions" role="group" aria-labelledby="bf-selected"><p id="bf-selected" class="dialog-copy" role="status"></p>${bulk.map((op) => `<button type="button" class="secondary${op === "delete" ? " danger" : ""}" id="bf-bulk-${op}" data-bulk="${op}">${t(BULK[op])}</button>`).join("")}</div>` : ""}<div class="table-scroll"><table class="admin-table"><thead><tr><td class="row-select">${boards.length ? `<input type="checkbox" id="bf-select-all" aria-label="${t("Select all boards shown")}">` : ""}</td><th scope="col">${t("Board")}</th><th scope="col">${t("Owner")}</th><th scope="col">${t("Last activity")}</th><th scope="col">${t("Objects")}</th><th scope="col">${t("Sharing")}</th><th scope="col"><span class="sr-only">${t("Actions")}</span></th></tr></thead><tbody>${boards.map((b) => boardRow(b)).join("") || `<tr><td colspan="7">${t("No boards match these filters.")}</td></tr>`}</tbody></table></div>${more() ? `<button type="button" class="secondary" id="bf-more">${t("Show more boards")}</button>` : ""}<div id="board-detail"></div>
<section><h3>${t("Spaces")}</h3><p class="dialog-copy">${t("Deleting a space keeps its boards, which are then in no space.")}</p><div id="space-list">${spaces.map((s, n) => `<div class="team-row"><strong id="space-name-${n}" data-user-content>${escape(s.name)}</strong><button class="text-btn danger" data-delete-space="${escape(s.id)}" aria-describedby="space-name-${n}">${t("Delete")}</button></div>`).join("") || `<p>${t("No spaces yet. Members create them from the organization's boards.")}</p>`}</div></section>`;
      const form = panel().querySelector("#board-filters");
      const tbody = panel().querySelector(".admin-table tbody");
      // The count, the legal hold note, and Show more follow the boards
      // listed as they are added, changed, or leave the list.
      // An action that empties the boards shown, while more match, brings
      // in the next ones rather than saying that none match.
      const paintCount = () => {
        panel().querySelector("#board-count").textContent = countText();
        panel().querySelector("#board-hold-note").hidden = !boards.some(held);
        if (!more()) panel().querySelector("#bf-more")?.remove();
        if (!boards.length)
          tbody.innerHTML = `<tr><td colspan="7">${t(more() ? "Loading…" : "No boards match these filters.")}</td></tr>`;
        paintSelection();
        if (!boards.length && more()) showMore(true);
      };
      // How many boards are chosen, said beside the actions for them, which
      // are unavailable until one is, and while one of them runs, as are
      // the choices it acts on. A changed choice asks again before
      // deleting.
      let running = false;
      // Board activity and duplicates share the space below the table: only
      // the one asked for last is shown, whichever reply arrives first.
      let detailRequest = 0;
      const paintSelection = () => {
        const all = panel().querySelector("#bf-select-all");
        if (!all) return;
        for (const room of chosen)
          if (!boards.some((b) => b.room === room)) chosen.delete(room);
        panel().querySelector("#bf-selected").textContent = chosen.size
          ? fill(
              singular(chosen.size)
                ? "{count} board selected."
                : "{count} boards selected.",
              { count: chosen.size },
            )
          : t("No boards selected.");
        for (const button of panel().querySelectorAll("[data-bulk]")) {
          disarm(button);
          button.disabled = running || !chosen.size;
        }
        all.disabled = running;
        for (const box of tbody.querySelectorAll("[data-select]"))
          box.disabled = running;
        all.checked = !!boards.length && chosen.size === boards.length;
        all.indeterminate = !!chosen.size && chosen.size < boards.length;
      };
      tbody.addEventListener("change", (e) => {
        const box = e.target.closest?.("[data-select]");
        if (!box) return;
        if (box.checked) chosen.add(box.dataset.select);
        else chosen.delete(box.dataset.select);
        paintSelection();
      });
      panel()
        .querySelector("#bf-select-all")
        ?.addEventListener("change", (e) => {
          for (const b of boards)
            if (e.target.checked) chosen.add(b.room);
            else chosen.delete(b.room);
          for (const box of tbody.querySelectorAll("[data-select]"))
            box.checked = e.target.checked;
          paintSelection();
        });
      // The next boards are added below those shown, without redrawing the
      // panel, and the keyboard moves on to the first of them. Brought in on
      // their own, they take the keyboard only where the rows that went, or
      // a button now unavailable, left it.
      let loadingMore = null;
      const showMore = (auto = false) =>
        (loadingMore ||= guarded(
          panel().querySelector("#bf-more"),
          async () => {
            const page = await load(
              "org.boards",
              boardFilters({
                ...filters,
                scope: "all",
                limit: Math.min(200, 1000 - boards.length),
                offset: boards.length,
              }),
            );
            // Nothing more came back: the boards counted earlier are gone.
            total = page.boards.length ? (page.total ?? total) : boards.length;
            // A board edited since the last page may have moved into this
            // one; it stays listed once.
            const known = new Set(boards.map((b) => b.room));
            const added = page.boards.filter((b) => !known.has(b.room));
            boards.push(...added);
            cache.boardLimit = boards.length;
            // The note that stood in for an emptied list goes.
            for (const row of [...tbody.rows])
              if (!row.querySelector("[data-select]")) row.remove();
            const first = tbody.rows.length;
            tbody.insertAdjacentHTML(
              "beforeend",
              added.map((b) => boardRow(b)).join(""),
            );
            const rows = [...tbody.rows].slice(first);
            rows.forEach(bind);
            paintCount();
            const heading = rows[0]?.querySelector("th");
            const active = document.activeElement;
            if (
              !auto ||
              !active ||
              active.disabled ||
              active === document.body ||
              active === panel()
            ) {
              heading?.setAttribute("tabindex", "-1");
              heading?.focus();
            }
            refresh();
          },
        ).finally(() => {
          loadingMore = null;
          // Not loaded after all: the count, the reason, and Show more say
          // what is left, rather than a list still loading.
          if (!boards.length && more()) tbody.innerHTML = "";
        }));
      panel()
        .querySelector("#bf-more")
        ?.addEventListener("click", () => showMore());
      form.onsubmit = (e) => {
        e.preventDefault();
        const state = form.querySelector("#bf-state").value;
        cache.boardLimit = 200;
        cache.boardFilters = {
          query: form.querySelector("#bf-query").value,
          activity: form.querySelector("#bf-activity").value || undefined,
          visibility: form.querySelector("#bf-visibility").value || undefined,
          owner: form.querySelector("#bf-owner").value || undefined,
          team: form.querySelector("#bf-team").value || undefined,
          space: form.querySelector("#bf-space").value || undefined,
          type: form.querySelector("#bf-type").value || undefined,
          updatedAfter: form.querySelector("#bf-after").value || undefined,
          sort: form.querySelector("#bf-sort").value,
          archived: state === "deleted" ? undefined : state === "archived",
          deleted: state === "deleted",
          content: !!form.querySelector("#bf-query").value,
        };
        cache.applied = "boards";
        show("boards");
      };
      // The export includes every matching board, read a page at a time
      // by board id, an order that editing a board never changes, so one
      // edited meanwhile is neither repeated nor missed. A worker without
      // that order keeps its own; a board it repeats is listed once. The
      // file then lists the boards in the order chosen here.
      const exportOrder = {
        title: (a, b) => byName(String(a.title), String(b.title)),
        created: (a, b) => b.created - a.created,
        size: (a, b) => (b.objectCount || 0) - (a.objectCount || 0),
        updated: (a, b) =>
          (b.lastActivity || b.updated || b.created) -
          (a.lastActivity || a.updated || a.created),
      };
      panel().querySelector("#bf-export").onclick = (e) =>
        guarded(e.currentTarget, async () => {
          const all = new Map();
          for (let offset = 0, more = true; more; offset += 1000) {
            const page = await load(
              "org.boards",
              boardFilters({
                ...filters,
                sort: "room",
                scope: "all",
                limit: 1000,
                offset,
              }),
            );
            for (const b of page.boards) all.set(b.room, b);
            more =
              page.boards.length === 1000 &&
              offset + 1000 < (page.total ?? total);
          }
          exportBoards(
            [...all.values()].sort(
              exportOrder[filters.sort] || exportOrder.updated,
            ),
          );
        });
      const exportBoards = (rows) =>
        download(
          toCSV(rows, [
            "title",
            "ownerName",
            "owner",
            ["created", (b) => b.created && new Date(b.created).toISOString()],
            [
              "lastActivity",
              (b) => b.lastActivity && new Date(b.lastActivity).toISOString(),
            ],
            "objectCount",
            "visibility",
            "memberCount",
            "guestCount",
            "peakParticipants",
            "room",
          ]),
          "boards.csv",
          "text/csv",
        );
      panel()
        .querySelector("#bf-migrate")
        ?.addEventListener("click", () => migrate());
      form.querySelector("#bf-duplicates").onclick = (e) =>
        guarded(e.currentTarget, async () => {
          const request = ++detailRequest;
          const { groups } = await load("org.boards.duplicates");
          if (request !== detailRequest) return;
          // Each set is a short table of its boards, ten at most, with
          // what tells them apart and a way to open each one.
          const detail = panel().querySelector("#board-detail");
          detail.innerHTML = `<h3 id="board-detail-heading" tabindex="-1">${t("Possible duplicates")}</h3>${
            groups
              .map((g, i) => {
                const shown = g.boards.slice(0, 10),
                  rest = num(g.count) - shown.length;
                return `<h4 id="duplicates-${i}">${t(g.reason === "same content" ? "Same content" : "Same name")} · ${count(g.count, "board", "boards")}</h4><div class="table-scroll"><table class="admin-table" aria-labelledby="duplicates-${i}"><thead><tr><th scope="col">${t("Board")}</th><th scope="col">${t("Owner")}</th><th scope="col">${t("Objects")}</th><th scope="col">${t("Last activity")}</th><th scope="col"><span class="sr-only">${t("Actions")}</span></th></tr></thead><tbody>${shown.map((b, n) => `<tr><th scope="row" id="duplicate-${i}-${n}">${user(b.title)}</th><td>${user(b.ownerName || b.owner)}</td><td>${figure(num(b.objectCount))}</td><td class="date-cell">${date(b.lastActivity)}</td><td class="row-actions"><button class="text-btn" aria-describedby="duplicate-${i}-${n}" data-open-board="${escape(b.room)}">${t("Open", "action")}</button></td></tr>`).join("")}</tbody></table></div>${rest > 0 ? `<p class="dialog-copy">${fill(singular(rest) ? "and {count} more board" : "and {count} more boards", { count: rest })}</p>` : ""}`;
              })
              .join("") || `<p>${t("No duplicates found.")}</p>`
          }`;
          detail.querySelectorAll("tbody tr").forEach(bind);
          // The results appear below the table, out of sight of the button:
          // the keyboard, and the view, move to them.
          panel().querySelector("#board-detail-heading").focus();
          status(
            groups.length
              ? fill(
                  singular(groups.length)
                    ? "{count} set of possible duplicates found."
                    : "{count} sets of possible duplicates found.",
                  { count: groups.length },
                )
              : "No duplicates found.",
          );
          refresh();
        });
      // Binds the actions in a board's row.
      function bind(row) {
        row.querySelectorAll("[data-open-board]").forEach((el) => {
          // The console closes once the board has opened; a board that
          // cannot be opened leaves the console, and its filters, in place
          // with the reason shown.
          el.onclick = () =>
            mayDiscard("Open the board again to discard them.") &&
            guarded(el, async () => {
              await openBoard(el.dataset.openBoard);
              closeNow?.();
            });
        });
        row.querySelectorAll("[data-activity]").forEach((el) => {
          el.onclick = () =>
            guarded(el, async () => {
              const room = el.dataset.activity;
              const request = ++detailRequest;
              let { entries, cursor } = await load("org.board.activity", {
                room,
              });
              if (request !== detailRequest) return;
              // Shown below the table, named for its board, and brought
              // into view with the keyboard on it.
              const title = el
                .closest("tr")
                .querySelector("[data-user-content]")?.textContent;
              const detail = panel().querySelector("#board-detail");
              const paint = () => {
                detail.innerHTML = `<h3 id="board-detail-heading" tabindex="-1">${t("Board activity")}${title ? ` · ${user(title)}` : ""}</h3>${auditTable(entries, "Board activity")}${cursor ? `<button type="button" class="secondary" id="board-activity-more">${t("Show older activity")}</button>` : ""}`;
                // Older events load below the ones shown, as many times as
                // there are more.
                detail
                  .querySelector("#board-activity-more")
                  ?.addEventListener("click", (e) =>
                    guarded(e.currentTarget, async () => {
                      const shown = entries.length;
                      const next = await load("org.board.activity", {
                        room,
                        cursor,
                      });
                      if (request !== detailRequest) return;
                      entries = [...entries, ...next.entries];
                      cursor = next.cursor;
                      paint();
                      // The keyboard goes on to the first event added.
                      const rows = detail.querySelectorAll("tbody tr");
                      (rows[shown] || rows[rows.length - 1])
                        ?.querySelector("td")
                        ?.setAttribute("tabindex", "-1");
                      (rows[shown] || rows[rows.length - 1])
                        ?.querySelector("td")
                        ?.focus();
                      announce();
                    }),
                  );
              };
              const announce = () =>
                status(
                  fill(
                    singular(entries.length)
                      ? "Board activity: {count} event."
                      : "Board activity: {count} events.",
                    { count: entries.length },
                  ) + (cursor ? ` ${t("Older activity is available.")}` : ""),
                );
              paint();
              detail.querySelector("#board-detail-heading").focus();
              announce();
              refresh();
            });
        });
        row.querySelectorAll("[data-govern]").forEach((el) => {
          // Deleting a board, and releasing its legal hold so that it can
          // be deleted, take a second press.
          const confirm =
            el.dataset.govern === "delete"
              ? "Confirm delete"
              : el.dataset.govern === "hold" && el.dataset.enabled === "false"
                ? "Confirm release"
                : null;
          el.onclick = () =>
            (confirm && confirmFirst(el, confirm)) ||
            guarded(el, async () => {
              const op = el.dataset.govern,
                enabled = el.dataset.enabled === "true";
              await govern({ op, room: el.dataset.room, enabled });
              // Only this row changes, in place, rather than every list on
              // the tab being read again; another tab opened meanwhile has
              // nothing to update.
              if (!el.isConnected) return;
              // The keyboard goes on to the same action in the row now in
              // this one's place.
              const next = applied(el.dataset.room, op, enabled);
              (
                next?.querySelector(`[data-govern="${op}"]`) ||
                next?.querySelector("button") ||
                panel()
              ).focus();
              paintCount();
              status(
                {
                  archive: "Board archived.",
                  unarchive: "Board unarchived.",
                  restore: "Board restored.",
                  delete:
                    "Board deleted. It can be restored during the retention period.",
                  hold: enabled ? "Legal hold placed." : "Legal hold released.",
                }[op],
              );
              refresh();
            });
        });
      }
      // Shows an action's outcome in the board's row and returns the row
      // now in its place: a legal hold redraws the row, and archiving,
      // unarchiving, restoring, or deleting moves the board to another
      // State than the one listed, so its row leaves.
      function applied(room, op, enabled) {
        const row = tbody
          .querySelector(`[data-select="${room.replace(/["\\]/g, "\\$&")}"]`)
          ?.closest("tr");
        const at = boards.findIndex((b) => b.room === room);
        if (!row || at < 0) return null;
        if (op === "hold") {
          boards[at] = { ...boards[at], legalHold: enabled };
          row.insertAdjacentHTML("afterend", boardRow(boards[at]));
          const next = row.nextElementSibling;
          row.remove();
          bind(next);
          return next;
        }
        boards.splice(at, 1);
        chosen.delete(room);
        total = Math.max(boards.length, total - 1);
        const near = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        return near;
      }
      // An action on the chosen boards runs a few at a time; those it could
      // not change stay chosen, with the reason shown. Deleting leaves out
      // boards under a legal hold, and the second press names how many go.
      for (const button of panel().querySelectorAll("[data-bulk]"))
        button.onclick = () => {
          const op = button.dataset.bulk;
          const targets = boards.filter(
            (b) => chosen.has(b.room) && !(op === "delete" && held(b)),
          );
          const kept = chosen.size - targets.length;
          if (
            op === "delete" &&
            confirmFirst(
              button,
              fill(
                singular(targets.length)
                  ? "Confirm deleting {count} board"
                  : "Confirm deleting {count} boards",
                { count: targets.length },
              ),
            )
          )
            return;
          running = true;
          paintSelection();
          guarded(button, async () => {
            const failed = [];
            let done = 0;
            for (let n = 0; n < targets.length; n += 5) {
              const batch = targets.slice(n, n + 5);
              const results = await Promise.allSettled(
                batch.map((b) =>
                  govern({ op, room: b.room, enabled: op === "hold" }),
                ),
              );
              if (!tbody.isConnected) return;
              results.forEach((result, i) => {
                if (result.status === "rejected") failed.push(result.reason);
                else {
                  done++;
                  applied(batch[i].room, op, true);
                }
              });
              // A row redrawn with its outcome stays unavailable too.
              paintSelection();
            }
            disarm(button);
            paintCount();
            status(
              [
                fill(
                  singular(done)
                    ? "{count} board updated."
                    : "{count} boards updated.",
                  { count: done },
                ),
                kept && op === "delete"
                  ? fill(
                      singular(kept)
                        ? "{count} board under a legal hold was not deleted."
                        : "{count} boards under a legal hold were not deleted.",
                      { count: kept },
                    )
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
            );
            if (failed.length)
              report(
                `${fill(
                  singular(failed.length)
                    ? "{count} board could not be changed:"
                    : "{count} boards could not be changed:",
                  { count: failed.length },
                )} ${deliveryText(failed[0]?.message || "Something went wrong.")}`,
              );
            refresh();
          }).then(
            // The button comes back available once the action is done,
            // unless nothing is chosen any more; then the keyboard goes on
            // to choosing boards rather than to the page.
            () => {
              running = false;
              if (!tbody.isConnected) return;
              paintSelection();
              const active = document.activeElement;
              if (
                button.disabled &&
                (active === button || !active || active === document.body)
              )
                (
                  panel().querySelector("#bf-select-all:not(:disabled)") ||
                  panel()
                ).focus();
            },
          );
        };
      [...tbody.rows].forEach(bind);
      paintSelection();
      // Members create spaces; administrators remove those no longer used.
      panel()
        .querySelectorAll("[data-delete-space]")
        .forEach((el) => {
          el.onclick = () =>
            confirmFirst(el, "Confirm delete") ||
            guarded(el, async (reload) => {
              await request("spaces.delete", { id: el.dataset.deleteSpace });
              toast("Space deleted.");
              reload("boards");
            });
        });
      // What the filters found is said once they are applied, as the
      // count in the panel was redrawn rather than changed.
      if (cache.applied === "boards") {
        delete cache.applied;
        status(countText());
      }
    },
    async policies() {
      const data = await load("org.policy.get");
      cache.policy = data;
      const p = data.policy;
      panel().innerHTML = `<form id="policy-form" class="policy-form">
<fieldset><legend>${t("Organization")}</legend>${text("p-name", "Organization name", p.name, 'maxlength="120"')}<label class="field">${t("Email domains")}<textarea id="p-domains" rows="2" aria-describedby="p-domains-hint">${escape(p.domains.map(toUnicode).join("\n"))}</textarea><small id="p-domains-hint">${t("One per line.")}</small></label>${check("p-capture", "Domain capture", p.domainCapture, "People who verify an email address in these domains or their subdomains join the organization automatically.")}${check("p-create", "Members can create boards", p.membersCanCreate)}${select(
        "p-visibility",
        "Default board visibility",
        p.defaultVisibility,
        [
          ["private", "Invited people"],
          ["organization", "Everyone in the organization"],
        ],
      )}</fieldset>
<fieldset><legend>${t("External collaboration")}</legend>${select(
        "p-external",
        "Sharing outside the organization",
        p.externalSharing,
        [
          ["none", "Not allowed"],
          ["guests", "Invited guests only"],
          ["anyone", "Guests and public links"],
        ],
      )}${check("p-guests", "Allow guest access", p.guestAccess, "Requires sharing outside the organization, with boards not restricted to members.")}<label class="field">${t("Guest access expires after (days, 0 for never)")}<input id="p-guest-days" type="number" required min="0" max="365" value="${num(p.guestExpiryDays)}"></label>${select(
        "p-guest-role",
        "Highest board role for guests",
        p.guestRole || "facilitator",
        [
          ["facilitator", "Facilitator"],
          ["editor", "Can edit"],
          ["commenter", "Can comment"],
          ["viewer", "Can view"],
        ],
      )}${check("p-links", "Allow boards to be opened by anyone with the link", p.publicLinks, "Requires guests and public links above. Viewers still sign in with Puter.")}${check("p-restrict", "Restrict boards to organization members", p.restrictToOrganization)}</fieldset>
<fieldset><legend>${t("AI features")}</legend>${check("p-ai", "Turn on AI features", p.ai.enabled, "Requests run through the organization's worker so this setting is enforced for everyone.")}${check("p-ai-summaries", "Summaries and generation", p.ai.summaries)}${check("p-ai-clustering", "Grouping ideas into themes", p.ai.clustering)}${check("p-ai-handwriting", "Converting photos of handwritten notes", p.ai.handwriting)}${text("p-ai-model", "AI model (optional)", p.ai.model || "", 'maxlength="100" placeholder="gpt-5-nano"')}</fieldset>
<fieldset><legend>${t("Retention and legal hold")}</legend><label class="field">${t("Keep audit logs for (days)")}<input id="p-audit-days" type="number" required min="30" max="3650" value="${num(p.retention.auditDays)}"></label><label class="field">${t("Keep deleted boards recoverable for (days)")}<input id="p-deleted-days" type="number" required min="1" max="3650" value="${num(p.retention.deletedBoardDays)}"></label>${check("p-hold", "Organization-wide legal hold", p.retention.legalHold, "While on, nothing is deleted: not audit logs, not deleted boards.")}</fieldset>
<fieldset><legend>${t("Scheduled reports")}</legend>${select(
        "p-report",
        "Email an administrative report",
        p.reports.schedule,
        [
          ["none", "Never"],
          ["weekly", "Weekly"],
          ["monthly", "Monthly"],
        ],
      )}${text("p-report-emails", "Report recipients", p.reports.emails.join(", "))}</fieldset>
<div class="dialog-footer">${unsavedNote()}<button class="primary">${t("Save policies")}</button></div></form>`;
      const f = panel().querySelector("#policy-form");
      const v = (id) => f.querySelector("#" + id);
      // A setting that cannot take effect under the ones it depends on is
      // shown unavailable, and keeps its value for when it can: guests need
      // sharing outside the organization, public links need "Guests and
      // public links" (and nothing else: a board can be given one while
      // guests are off), and AI features need AI turned on.
      const dependents = () => {
        const restricted =
          v("p-external").value === "none" || v("p-restrict").checked;
        v("p-guests").disabled = restricted;
        v("p-guest-days").disabled = restricted || !v("p-guests").checked;
        v("p-guest-role").disabled = restricted || !v("p-guests").checked;
        v("p-links").disabled = v("p-external").value !== "anyone";
        // Scheduled reports need someone to send them to.
        v("p-report-emails").required = v("p-report").value !== "none";
        for (const id of [
          "p-ai-summaries",
          "p-ai-clustering",
          "p-ai-handwriting",
          "p-ai-model",
        ])
          v(id).disabled = !v("p-ai").checked;
      };
      const values = () => ({
        name: v("p-name").value,
        domains: lines(v("p-domains").value).map(asciiDomain),
        domainCapture: v("p-capture").checked,
        membersCanCreate: v("p-create").checked,
        defaultVisibility: v("p-visibility").value,
        externalSharing: v("p-external").value,
        guestAccess: v("p-guests").checked,
        guestRole: v("p-guest-role").value,
        // An unavailable field is not checked by the form; left
        // empty, it keeps the period it had.
        guestExpiryDays:
          v("p-guest-days").value === ""
            ? num(p.guestExpiryDays)
            : Number(v("p-guest-days").value),
        publicLinks: v("p-links").checked,
        restrictToOrganization: v("p-restrict").checked,
        ai: {
          enabled: v("p-ai").checked,
          summaries: v("p-ai-summaries").checked,
          clustering: v("p-ai-clustering").checked,
          handwriting: v("p-ai-handwriting").checked,
          model: v("p-ai-model").value,
        },
        retention: {
          auditDays: Number(v("p-audit-days").value) || 365,
          deletedBoardDays: Number(v("p-deleted-days").value) || 30,
          legalHold: v("p-hold").checked,
        },
        reports: {
          schedule: v("p-report").value,
          emails: lines(v("p-report-emails").value),
        },
      });
      // The policy as loaded, before any draft is put back in the form.
      let loaded = values();
      const saved = draft("policies", f);
      f.addEventListener("change", dependents);
      dependents();
      // An entry that cannot be claimed is named, and the field marked,
      // until it is changed.
      const domainsField = v("p-domains");
      domainsField.addEventListener("input", () =>
        domainsField.removeAttribute("aria-invalid"),
      );
      f.onsubmit = (e) => {
        e.preventDefault();
        guarded(f.querySelector(".primary"), async () => {
          const sent = saved.snapshot();
          const now = values();
          // Capture with no domains would capture no one.
          if (now.domainCapture && !now.domains.length) {
            domainsField.setAttribute("aria-invalid", "true");
            throw Error(t("Add an email domain for domain capture to use."));
          }
          const problem = domainProblem(now.domains, loaded.domains);
          if (problem) {
            domainsField.setAttribute("aria-invalid", "true");
            throw Error(
              t(
                problem.reason === "public"
                  ? "{domain} is a public email domain: anyone can have an address there, so it cannot be the organization's."
                  : problem.reason === "suffix"
                    ? "Anyone can register a domain under {domain}, so it cannot be the organization's. Enter the organization's own domain, such as example.co.uk."
                    : "{domain} is not a valid email domain. Enter one per line, such as example.ca.",
              ).replace("{domain}", () => toUnicode(problem.domain)),
            );
          }
          await request("org.policy.set", { policy: changes(now, loaded) });
          loaded = now;
          // The policy is saved; a refresh that fails changes nothing about that.
          saved(sent);
          await org.refresh().catch(() => {});
          toast("Policies saved.");
        });
      };
    },
    async integrations() {
      const data = await load("org.policy.get");
      const p = data.policy.integrations;
      panel().innerHTML = `<form id="integrations-form" class="policy-form">
<fieldset><legend>Google Workspace</legend>${check("i-google", "Allow Google Docs, Sheets, Slides, and Drive embeds and Sheets import", p.google.enabled)}<p class="dialog-copy">${t("People can sign in with their Google Workspace accounts, using Sign in with Google when they sign in to Puter. Google Workspace SAML single sign-on needs the Puter account platform and is not available yet. Provision users and groups from Google Workspace with the SCIM endpoint or the REST API on the Security tab.")}</p></fieldset>
<fieldset><legend>Slack</legend>${check("i-slack", "Send notifications to Slack", p.slack.enabled)}<label class="field">${t("Slack incoming webhook URL")} ${data.secrets.slack ? `<span class="badge">${t("Configured")}</span>` : ""}<input id="i-slack-url" type="url" placeholder="https://hooks.slack.com/services/…" autocomplete="off"></label>${data.secrets.slack ? check("i-slack-off", "Disconnect Slack") : ""}<p class="dialog-copy">${t("Security alerts can go to this channel. Board owners can also connect a board to its own channel for mentions.")}</p>${data.secrets.slack ? `<p class="dialog-copy" role="status">${data.slack?.lastError ? `${labelled(t("Last error"), "")}${escape(deliveryText(data.slack.lastError))}` : data.slack?.lastSuccess ? `${labelled(t("Last post"), "")}${dateTime(data.slack.lastSuccess)}` : t("Nothing posted yet.")}</p>` : ""}<button type="button" class="secondary" id="i-slack-test">${t("Send test message")}</button></fieldset>
<fieldset><legend>Jira</legend>${check("i-jira", "Send items to Jira and show their status on boards", p.jira.enabled)}${text("i-jira-site", "Jira Cloud site", p.jira.site, 'placeholder="team.atlassian.net"')}${text("i-jira-email", "Integration account email", p.jira.email)}${text("i-jira-project", "Project key", p.jira.project, 'placeholder="OPS"')}<label class="field">${t("API token")} ${data.secrets.jira ? `<span class="badge">${t("Configured")}</span>` : ""}<input id="i-jira-token" type="password" autocomplete="off"></label>${data.secrets.jira ? check("i-jira-off", "Remove the stored API token") : ""}</fieldset>
<fieldset><legend>${t("Other integrations")}</legend>${check("i-embeds", "Allow embedded web content (video, design files, forms)", p.embeds.enabled)}${check("i-webhooks", "Deliver events to webhooks", p.webhooks.enabled)}${check("i-miro", "Allow Miro imports", p.miro.enabled)}</fieldset>
<div class="dialog-footer">${unsavedNote()}<button class="primary">${t("Save integrations")}</button></div></form>`;
      const f = panel().querySelector("#integrations-form");
      const v = (id) => f.querySelector("#" + id);
      const values = () => ({
        google: { enabled: v("i-google").checked },
        slack: { enabled: v("i-slack").checked },
        jira: {
          enabled: v("i-jira").checked,
          site: v("i-jira-site").value,
          email: v("i-jira-email").value,
          project: v("i-jira-project").value,
        },
        embeds: { enabled: v("i-embeds").checked },
        webhooks: { enabled: v("i-webhooks").checked },
        miro: { enabled: v("i-miro").checked },
      });
      let loaded = values();
      const saved = draft("integrations", f);
      const saveIntegrations = async () => {
        const sent = saved.snapshot();
        const now = values();
        // A field left empty keeps the stored secret; one marked for
        // removal clears it, unless a new one was entered.
        const secrets = {};
        if (v("i-slack-url").value) secrets.slack = v("i-slack-url").value;
        else if (v("i-slack-off")?.checked) secrets.slack = null;
        if (v("i-jira-token").value) secrets.jira = v("i-jira-token").value;
        else if (v("i-jira-off")?.checked) secrets.jira = null;
        await request("org.policy.set", {
          policy: changes({ integrations: now }, { integrations: loaded }),
          secrets,
        });
        loaded = now;
        saved(sent);
        await org.refresh().catch(() => {});
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        guarded(f.querySelector(".primary"), async (reload) => {
          await saveIntegrations();
          toast("Integrations saved.");
          reload("integrations");
        });
      };
      // The test goes to the channel as entered, so what was typed is saved
      // first, as the SIEM test does.
      v("i-slack-test").onclick = (e) =>
        guarded(e.currentTarget, async (reload) => {
          await saveIntegrations();
          try {
            await request("org.slack.test");
            // A test posts while notifications are off, so the channel can
            // be checked before turning them on.
            toast(
              v("i-slack").checked
                ? "Test message posted to Slack."
                : "Test message posted to Slack. Slack notifications are off in Integrations, so nothing else is posted yet.",
            );
          } finally {
            reload("integrations");
          }
        });
    },
    async security() {
      const [data, keys, hooks] = await Promise.all([
        load("org.policy.get"),
        load("apikeys.list"),
        load("webhooks.list"),
      ]);
      const s = data.policy.siem,
        a = data.policy.alerts;
      panel().innerHTML = `<section class="policy-form"><h3>${t("Sign-in and identity")}</h3><p class="dialog-copy">${t("People sign in with Puter accounts, including with Sign in with Google, so members can use their Google Workspace accounts under Google's sign-in policies, such as 2-Step Verification. Puter enforces multifactor authentication at sign-in. SAML single sign-on, and requiring Google sign-in for the organization's domains, are account platform features; this organization verifies email domains itself and supports SCIM provisioning today.")}</p><dl class="admin-facts"><dt>${t("SCIM base URL")}</dt><dd><code data-user-content>${escape(org.server + "/scim/v2")}</code></dd><dt>${t("REST API reference")}</dt><dd><a href="${escape(org.server + "/v1/openapi.json")}" target="_blank" rel="noopener">${escape(org.server + "/v1/openapi.json")}</a></dd></dl></section>
<form id="siem-form" class="policy-form"><fieldset><legend>${t("SIEM export")}</legend>${select(
        "s-mode",
        "Destination",
        s.mode,
        [
          ["none", "Off"],
          ["sentinel", "Microsoft Sentinel (Logs Ingestion API)"],
          ["https", "Other HTTPS endpoint"],
        ],
      )}<fieldset class="nested" id="s-sentinel"><legend>Microsoft Sentinel</legend>${text("s-tenant", "Tenant ID", s.sentinel.tenantId)}${text("s-client", "Application (client) ID", s.sentinel.clientId)}<label class="field">${t("Client secret")} ${data.secrets.sentinel ? `<span class="badge">${t("Configured")}</span>` : ""}<input id="s-secret" type="password" autocomplete="off"></label>${data.secrets.sentinel ? check("s-secret-off", "Remove the stored client secret") : ""}${text("s-endpoint", "Data collection endpoint", s.sentinel.endpoint, 'placeholder="https://….ingest.monitor.azure.com"')}${text("s-dcr", "Data collection rule immutable ID", s.sentinel.dcrId, 'placeholder="dcr-…"')}${text("s-stream", "Stream name", s.sentinel.stream, 'placeholder="Custom-WhiteboardAudit"')}</fieldset><fieldset class="nested" id="s-https"><legend>${t("HTTPS endpoint")}</legend>${text("s-url", "Endpoint URL", s.url)}<label class="field">${t("Bearer token")} ${data.secrets["siem-token"] ? `<span class="badge">${t("Configured")}</span>` : ""}<input id="s-token" type="password" autocomplete="off"></label>${data.secrets["siem-token"] ? check("s-token-off", "Remove the stored bearer token") : ""}</fieldset><fieldset class="nested" id="s-categories"><legend>${t("Event categories")}</legend><div class="check-list">${["admin", "security", "access", "sharing", "content", "api"].map((c) => `<label><input type="checkbox" name="s-category" value="${c}" ${s.categories.includes(c) ? "checked" : ""}> ${t({ admin: "Administration", security: "Security", access: "Board access", sharing: "Sharing", content: "Board content", api: "API and SCIM" }[c], "category")}</label>`).join("")}</div></fieldset><p class="dialog-copy" role="status">${data.siem ? `${labelled(t("Last delivery"), "")}${dateTime(data.siem.lastSuccess)} · ${count(data.siem.sent, "event sent", "events sent")}${data.siem.lastError ? ` · ${labelled(t("Last error"), "")}${escape(deliveryText(data.siem.lastError))}` : ""}` : t("Nothing sent yet.")}</p><p class="dialog-copy">${t("Events are exported within seconds of the activity that creates them. Sentinel can also poll the audit API with an API key that has the audit:read scope.")}</p></fieldset>
<fieldset><legend>${t("Security alerts")}</legend>${check("a-public", "A board is opened to anyone with the link", a.publicSharing)}${check("a-guest", "A guest joins a board", a.guestAccess)}${check("a-perm", "Roles or permissions change", a.permissionChanges)}${check("a-policy", "Organization policy changes", a.policyChanges)}${text("a-emails", "Alert email recipients", a.emails.join(", "))}${check("a-slack", "Also post alerts to Slack", a.slack)}</fieldset><div class="dialog-footer">${unsavedNote()}<button type="button" class="secondary" id="siem-test">${t("Send test event")}</button><button class="primary">${t("Save security settings")}</button></div></form>
<section class="policy-form"><h3>${t("API keys")}</h3><p class="dialog-copy">${t("Keys authenticate the REST API and SCIM provisioning. A key is shown once.")}</p><form id="key-form" class="inline-form">${text("k-name", "Key name", "", 'required maxlength="80"')}<fieldset><legend>${t("Scopes")}</legend><div class="check-list">${keys.scopes.map((sc) => `<label><input type="checkbox" name="k-scope" value="${escape(sc)}"> <code>${escape(sc)}</code></label>`).join("")}</div></fieldset>${text("k-days", "Expires after (days, blank for never)", "", 'type="number" min="1" max="730"')}<button class="primary">${t("Create API key")}</button></form><div class="share-link-row" hidden id="k-output-field"><label class="field">${t("New API key")}<input id="k-output" readonly></label><button type="button" class="secondary" data-copy="k-output" data-copied="Key copied.">${icon("copy")}${t("Copy key")}</button></div><p class="dialog-copy" hidden id="k-output-note"></p><div class="table-scroll"><table class="admin-table"><thead><tr><th scope="col">${t("Name")}</th><th scope="col">${t("Scopes")}</th><th scope="col">${t("Last used")}</th><th scope="col">${t("Expires")}</th><th scope="col"><span class="sr-only">${t("Actions")}</span></th></tr></thead><tbody>${keys.keys.map((k) => `<tr><td>${user(k.name)} <code>${escape(k.prefix)}…</code></td><td>${k.scopes.map((sc) => `<code>${escape(sc)}</code>`).join(" ")}</td><td class="date-cell">${dateTime(k.lastUsed)}</td><td>${k.expires ? date(k.expires) : t("Never")}</td><td><button class="text-btn danger" data-revoke-key="${escape(k.id)}">${t("Revoke")}</button></td></tr>`).join("") || `<tr><td colspan="5">${t("No API keys.")}</td></tr>`}</tbody></table></div></section>
<section class="policy-form"><h3>${t("Webhooks")}</h3><p class="dialog-copy">${t("Deliveries are signed with an X-Whiteboard-Signature header (HMAC SHA-256 of the body with the webhook secret). Turn webhooks on in Integrations.")} ${hooks.pending ? count(hooks.pending, "delivery waiting to retry.", "deliveries waiting to retry.") : ""}</p><form id="hook-form" class="inline-form">${text("h-url", "HTTPS endpoint", "", 'type="url" required')}<fieldset><legend>${t("Events")}</legend><div class="check-list">${hooks.events.map((ev) => `<label><input type="checkbox" name="h-event" value="${escape(ev)}" ${ev === "*" ? "checked" : ""}> <code>${ev === "*" ? t("All events") : escape(ev)}</code></label>`).join("")}</div></fieldset><button class="primary">${t("Add webhook")}</button></form><div class="share-link-row" hidden id="h-output-field"><label class="field">${t("Signing secret")}<input id="h-output" readonly></label><button type="button" class="secondary" data-copy="h-output" data-copied="Secret copied.">${icon("copy")}${t("Copy secret")}</button></div><p class="dialog-copy" hidden id="h-output-note"></p><div class="table-scroll"><table class="admin-table"><tbody>${hooks.webhooks.map((h) => `<tr><td><code data-user-content>${escape(h.url)}</code></td><td>${h.events.map((ev) => `<code>${escape(ev)}</code>`).join(" ")}</td><td><button class="text-btn" data-test-hook="${escape(h.id)}">${t("Test")}</button><button class="text-btn danger" data-delete-hook="${escape(h.id)}">${t("Delete")}</button></td></tr>`).join("") || `<tr><td>${t("No webhooks.")}</td></tr>`}</tbody></table></div></section>`;
      const f = panel().querySelector("#siem-form");
      const v = (id) => panel().querySelector("#" + id);
      const values = () => ({
        siem: {
          mode: v("s-mode").value,
          categories: [
            ...f.querySelectorAll('[name="s-category"]:checked'),
          ].map((i) => i.value),
          sentinel: {
            tenantId: v("s-tenant").value,
            clientId: v("s-client").value,
            endpoint: v("s-endpoint").value,
            dcrId: v("s-dcr").value,
            stream: v("s-stream").value,
          },
          url: v("s-url").value,
        },
        alerts: {
          publicSharing: v("a-public").checked,
          guestAccess: v("a-guest").checked,
          permissionChanges: v("a-perm").checked,
          policyChanges: v("a-policy").checked,
          emails: lines(v("a-emails").value),
          slack: v("a-slack").checked,
        },
      });
      let loaded = values();
      const saved = draft("security", f);
      // Only the chosen destination's settings are available, and none
      // while the export is off; the others keep their values.
      const destination = () => {
        const mode = v("s-mode").value;
        v("s-sentinel").disabled = mode !== "sentinel";
        v("s-https").disabled = mode !== "https";
        v("s-categories").disabled = mode === "none";
      };
      v("s-mode").addEventListener("change", destination);
      destination();
      const saveSecurity = async () => {
        const sent = saved.snapshot();
        const now = values();
        const secrets = {};
        if (v("s-secret").value) secrets.sentinel = v("s-secret").value;
        else if (v("s-secret-off")?.checked) secrets.sentinel = null;
        if (v("s-token").value) secrets["siem-token"] = v("s-token").value;
        else if (v("s-token-off")?.checked) secrets["siem-token"] = null;
        await request("org.policy.set", {
          policy: changes(now, loaded),
          secrets,
        });
        loaded = now;
        saved(sent);
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        guarded(f.querySelector(".primary"), async (reload) => {
          await saveSecurity();
          toast("Security settings saved.");
          reload("security");
        });
      };
      v("siem-test").onclick = (e) =>
        guarded(e.currentTarget, async () => {
          await saveSecurity();
          const result = await request("org.siem.test");
          toast(
            `${t("Test delivered.")} ${count(result.sent, "event sent", "events sent")}`,
          );
        });
      panel().querySelector("#key-form").onsubmit = (e) => {
        e.preventDefault();
        guarded(e.target.querySelector(".primary"), async (reload) => {
          const secretsCache = cache;
          const { key, record } = await request("apikeys.create", {
            name: v("k-name").value,
            scopes: [
              ...panel().querySelectorAll('[name="k-scope"]:checked'),
            ].map((i) => i.value),
            days: Number(v("k-days").value) || undefined,
          });
          // Kept until the Security tab shows it, even if reloading the tab
          // fails or another tab opens first: it cannot be shown again.
          secretsCache.revealed ||= {};
          secretsCache.revealed.k = {
            id: record?.id,
            value: key,
            message: "Copy this key now. It will not be shown again.",
          };
          await reload("security");
          if (
            dialog &&
            cache === secretsCache &&
            !panel().querySelector("#k-output-field:not([hidden])")
          )
            toast("Open the Security tab again to copy the new secret.");
        });
      };
      panel()
        .querySelectorAll("[data-revoke-key]")
        .forEach((el) => {
          el.onclick = () =>
            confirmFirst(el, "Confirm revoke") ||
            guarded(el, async (reload) => {
              const secretsCache = cache;
              await request("apikeys.revoke", { id: el.dataset.revokeKey });
              if (secretsCache.revealed?.k?.id === el.dataset.revokeKey)
                delete secretsCache.revealed.k;
              reload("security");
            });
        });
      panel().querySelector("#hook-form").onsubmit = (e) => {
        e.preventDefault();
        guarded(e.target.querySelector(".primary"), async (reload) => {
          const secretsCache = cache;
          const { secret, webhook } = await request("webhooks.create", {
            url: v("h-url").value,
            events: [
              ...panel().querySelectorAll('[name="h-event"]:checked'),
            ].map((i) => i.value),
          });
          secretsCache.revealed ||= {};
          secretsCache.revealed.h = {
            id: webhook?.id,
            value: secret,
            message:
              "Copy this signing secret now. It will not be shown again.",
          };
          await reload("security");
          if (
            dialog &&
            cache === secretsCache &&
            !panel().querySelector("#h-output-field:not([hidden])")
          )
            toast("Open the Security tab again to copy the new secret.");
        });
      };
      panel()
        .querySelectorAll("[data-test-hook]")
        .forEach((el) => {
          el.onclick = () =>
            guarded(el, async () => {
              await request("webhooks.test", { id: el.dataset.testHook });
              // A test reaches the endpoint even while deliveries are off,
              // so the endpoint can be checked before turning them on.
              toast(
                data.policy.integrations.webhooks.enabled
                  ? "Webhook test delivered."
                  : "Webhook test delivered. Webhooks are off in Integrations, so events are not sent yet.",
              );
            });
        });
      panel()
        .querySelectorAll("[data-delete-hook]")
        .forEach((el) => {
          el.onclick = () =>
            confirmFirst(el, "Confirm delete") ||
            guarded(el, async (reload) => {
              const secretsCache = cache;
              await request("webhooks.delete", { id: el.dataset.deleteHook });
              if (secretsCache.revealed?.h?.id === el.dataset.deleteHook)
                delete secretsCache.revealed.h;
              reload("security");
            });
        });
      // Retain each newly issued secret until this dialog closes. Another
      // creation or settings save must not erase a key before it is copied.
      const revealed = Object.entries(cache.revealed || {});
      for (const [field, secret] of revealed) {
        v(field + "-output-field").hidden = false;
        v(field + "-output").value = secret.value;
        // Shown beside the secret, not only announced: it is the one chance
        // to copy it.
        const note = v(field + "-output-note");
        if (note) {
          note.textContent = t(secret.message);
          note.hidden = false;
        }
      }
      const unseen = revealed.filter(([, secret]) => !secret.seen);
      if (unseen.length) {
        v(unseen.at(-1)[0] + "-output").select();
        status(unseen.map(([, secret]) => t(secret.message)).join(" "));
        for (const [, secret] of unseen) secret.seen = true;
      }
    },
    async audit() {
      // The board filter keeps the name it was chosen by, to show it again.
      const { boardLabel, ...filters } = cache.auditFilters || {};
      // The form keeps plain dates in local time, like the times shown in
      // the table; "From" starts its day and "To" ends at its last moment.
      const local = (value, time) =>
        value ? new Date(`${value}T${time}`).toISOString() : undefined;
      const query = {
        ...filters,
        from: local(filters.from, "00:00:00"),
        to: local(filters.to, "23:59:59.999"),
      };
      // The worker reads a bounded number of records per request, so a
      // filter that matches little can come back empty while older events
      // remain; a few more requests are made before showing nothing.
      const page = async (cursor, limit) => {
        const found = { entries: [], cursor };
        for (let n = 0; n < 8; n++) {
          const next = await load("org.audit", {
            ...query,
            ...(found.cursor ? { cursor: found.cursor } : {}),
            limit: limit - found.entries.length,
          });
          if (next.range) {
            found.range ??= next.range;
            query.from ??= new Date(next.range.from).toISOString();
            query.to ??= new Date(next.range.to).toISOString();
          }
          found.entries.push(...next.entries);
          const moved = next.cursor !== found.cursor;
          found.cursor = next.cursor;
          if (!found.cursor || !moved || found.entries.length) break;
        }
        return found;
      };
      // People to narrow the log to, read once while the console is open;
      // the log still shows without them.
      const [result, people] = await Promise.all([
        page(null, 200),
        (cache.auditPeople ||= load("org.users.list").catch((error) => {
          if (error === STALE) {
            delete cache.auditPeople;
            throw error;
          }
          return null;
        })),
      ]);
      const byName = names();
      const actors = [
        ...(people?.owner?.uuid ? [people.owner] : []),
        ...(people?.users || []),
      ]
        .map((u) => [u.uuid, u.username || u.email || u.uuid, true])
        .sort((a, b) => byName(a[1], b[1]));
      const loadedAt = performance.now();
      // Use the worker's clock, not the device's, to pin default bounds.
      // Older workers keep their original defaults until they are updated.
      if (result.range) {
        query.from ??= new Date(result.range.from).toISOString();
        query.to ??= new Date(result.range.to).toISOString();
      }
      cache.auditEntries = result.entries;
      const range =
        query.from && query.to
          ? t("Showing events from {from} to {to}")
              .replaceAll("{from}", dateTime(Date.parse(query.from)))
              .replaceAll("{to}", dateTime(Date.parse(query.to)))
          : t(
              query.from
                ? "With no end date, events are shown up to now."
                : "Without a start date, events cover the 30 days ending at the selected end date or now.",
            );
      panel().innerHTML = `<form class="admin-filters" id="audit-filters"><label class="field">${t("From", "dates")}<input type="date" min="0100-01-01" max="9999-12-31" id="au-from" value="${escape(filters.from || "")}"></label><label class="field">${t("To", "dates")}<input type="date" min="0100-01-01" max="9999-12-31" id="au-to" value="${escape(filters.to || "")}"></label>${select(
        "au-category",
        "Category",
        filters.category || "",
        [
          ["", "All", false, "category"],
          ["admin", "Administration"],
          ["security", "Security"],
          ["access", "Board access", false, "category"],
          ["sharing", "Sharing"],
          ["content", "Board content"],
          ["api", "API and SCIM"],
        ],
      )}${text("au-action", "Action starts with", filters.action || "", 'placeholder="board.role"')}${select("au-actor", "Person", filters.actor || "", [["", "Anyone"], ...actors])}${text("au-board", "Board", boardLabel || "", 'type="search" list="au-board-list" autocomplete="off"')}<datalist id="au-board-list"></datalist><button class="primary" id="au-apply">${t("Apply")}</button></form><div class="admin-results"><p id="audit-range" class="dialog-copy">${escape(range)}</p><div class="admin-results-actions"><button type="button" class="secondary" id="au-csv">${icon("download")}${t("Export CSV")}</button><button type="button" class="secondary" id="au-json">${icon("download")}${t("Export JSON")}</button></div></div>${auditTable(result.entries, "Audit log", "audit-range")}${result.cursor ? `<button class="secondary" id="au-more">${t("Load older events")}</button>` : ""}`;
      const f = panel().querySelector("#audit-filters");
      const validateRange = () => {
        const from = f.querySelector("#au-from").value;
        const to = f.querySelector("#au-to");
        const end = to.value
          ? Date.parse(`${to.value}T23:59:59.999`)
          : Number.isFinite(result.range?.now)
            ? result.range.now + performance.now() - loadedAt
            : NaN;
        const start = Date.parse(`${from}T00:00:00`);
        to.setCustomValidity(
          Number.isFinite(start) && Number.isFinite(end) && start > end
            ? t("The end date must be on or after the start date.")
            : "",
        );
      };
      f.addEventListener("input", validateRange);
      // Boards are suggested from the whole directory as their name is
      // typed, a few at a time; boards with the same name are told apart by
      // their owner, then the day they were created, then the end of their
      // id, so each suggestion stands for one board.
      const boardField = f.querySelector("#au-board");
      const suggested = new Map(
        filters.board && boardLabel ? [[boardLabel, filters.board]] : [],
      );
      let searching = null;
      boardField.addEventListener("input", () => {
        boardField.setCustomValidity("");
        clearTimeout(searching);
        const query = boardField.value.trim();
        if (!query || suggested.has(boardField.value)) return;
        searching = setTimeout(async () => {
          const found = await load("org.boards", {
            scope: "all",
            query,
            sort: "title",
            limit: 20,
          }).catch(() => null);
          if (!found || boardField.value.trim() !== query) return;
          const details = [
            () => [],
            (b) => [b.ownerName || b.owner],
            (b) => [b.ownerName || b.owner, b.created && date(b.created)],
            (b) => [
              b.ownerName || b.owner,
              b.created && date(b.created),
              b.room.slice(-6),
            ],
          ];
          const labels = details.map((detail) =>
            found.boards.map((b) => {
              const parts = detail(b).filter(Boolean);
              return parts.length
                ? `${b.title} (${parts.join(", ")})`
                : b.title;
            }),
          );
          const options = found.boards.map((b, n) => [
            (labels.find(
              (shown) =>
                shown.indexOf(shown[n]) === shown.lastIndexOf(shown[n]),
            ) || labels.at(-1))[n],
            b.room,
          ]);
          for (const [label, room] of options) suggested.set(label, room);
          f.querySelector("#au-board-list").innerHTML = options
            .map(([label]) => `<option value="${escape(label)}"></option>`)
            .join("");
        }, 250);
      });
      f.onsubmit = (e) => {
        e.preventDefault();
        validateRange();
        const boardName = boardField.value;
        boardField.setCustomValidity(
          boardName && !suggested.has(boardName)
            ? t("Choose a board from the suggestions.")
            : "",
        );
        if (!f.reportValidity()) return;
        cache.auditFilters = {
          from: f.querySelector("#au-from").value || undefined,
          to: f.querySelector("#au-to").value || undefined,
          category: f.querySelector("#au-category").value || undefined,
          action: f.querySelector("#au-action").value || undefined,
          actor: f.querySelector("#au-actor").value || undefined,
          board: suggested.get(boardName) || undefined,
          boardLabel: boardName || undefined,
        };
        cache.applied = "audit";
        show("audit");
      };
      const columns = [
        "time",
        "category",
        "action",
        ["actor", (e) => e.actor?.username],
        ["actorId", (e) => e.actor?.uuid],
        ["targetType", (e) => e.target?.type],
        ["target", (e) => e.target?.name || e.target?.id],
        "board",
        "ip",
        ["details", (e) => JSON.stringify(e.details || {})],
      ];
      // The export includes every matching event, read a page at a time,
      // not only the pages loaded in the table.
      const allEntries = async () => {
        const all = [...cache.auditEntries];
        for (let cursor = result.cursor; cursor;) {
          const page = await load("org.audit", {
            ...query,
            cursor,
            limit: 500,
          });
          all.push(...page.entries);
          // A page can hold no events while older ones remain; one that
          // does not move the cursor ends the export.
          cursor = page.cursor !== cursor ? page.cursor : null;
        }
        return all;
      };
      panel().querySelector("#au-csv").onclick = (e) =>
        guarded(e.currentTarget, async () =>
          download(
            toCSV(await allEntries(), columns),
            "audit-log.csv",
            "text/csv",
          ),
        );
      panel().querySelector("#au-json").onclick = (e) =>
        guarded(e.currentTarget, async () =>
          download(
            JSON.stringify(await allEntries(), null, 2),
            "audit-log.json",
            "application/json",
          ),
        );
      panel()
        .querySelector("#au-more")
        ?.addEventListener("click", (e) =>
          guarded(e.currentTarget, async () => {
            const more = await page(result.cursor, 200);
            cache.auditEntries.push(...more.entries);
            result.cursor = more.cursor;
            panel()
              .querySelector(".admin-table tbody")
              .insertAdjacentHTML("beforeend", auditRows(more.entries));
            // Removing the focused button would drop the keyboard to the
            // page; it goes back to the panel instead.
            if (!more.cursor) e.target.remove();
            restoreFocus();
            refresh();
          }),
        );
      if (cache.applied === "audit") {
        delete cache.applied;
        status(
          result.entries.length
            ? fill(
                singular(result.entries.length)
                  ? "Audit log: {count} event."
                  : "Audit log: {count} events.",
                { count: result.entries.length },
              ) + (result.cursor ? ` ${t("Older events are available.")}` : "")
            : "No events in this range.",
        );
      }
    },
  };
  const CATEGORY_LABELS = {
    admin: "Administration",
    security: "Security",
    access: "Board access",
    sharing: "Sharing",
    content: "Board content",
    api: "API and SCIM",
  };
  const auditRows = (entries) =>
    entries
      .map(
        (e) =>
          `<tr><td class="date-cell">${dateTime(e.at)}</td><td>${escape(t(CATEGORY_LABELS[e.category] || e.category || "", "category"))}</td><td class="audit-action"><code>${escape(e.action)}</code></td><td>${user(e.actor?.username || "")}</td><td class="audit-target">${user(e.target?.name || e.target?.id || "")}</td><td class="audit-details" data-user-content title="${auditDetailsJSON(e)}">${auditDetails(e)}</td></tr>`,
      )
      .join("");
  const auditTable = (entries, label = "Audit log", describedBy = "") =>
    `<div id="audit-table" class="table-scroll" role="region" aria-label="${t(label)}"${describedBy ? ` aria-describedby="${escape(describedBy)}"` : ""} tabindex="0"><table class="admin-table"><thead><tr><th scope="col">${t("Time")}</th><th scope="col">${t("Category")}</th><th scope="col">${t("Action")}</th><th scope="col">${t("Who")}</th><th scope="col">${t("Target")}</th><th scope="col">${t("Details")}</th></tr></thead><tbody>${auditRows(entries) || `<tr><td colspan="6">${t("No events in this range.")}</td></tr>`}</tbody></table></div>`;
  return {
    open(tab = "overview") {
      if (!org.isAdmin)
        return toast(
          "Only organization administrators can open these settings.",
        );
      cache = {};
      dialog = modal(
        "Organization settings",
        `<div class="admin-console"><div role="tablist" aria-label="${t("Organization settings")}" class="admin-tabs">${TABS.map(([key, label, ic]) => `<button role="tab" id="admin-tab-${key}" data-tab="${key}" aria-controls="admin-panel" aria-selected="false" tabindex="-1">${icon(ic)}<span>${label}</span></button>`).join("")}</div><div id="admin-panel" role="tabpanel" tabindex="0" class="admin-panel"></div><p id="admin-error" class="admin-error" role="alert" hidden></p><p id="admin-status" class="sr-only" role="status" aria-live="polite"></p></div>`,
        (d) => {
          d.classList.add("admin-dialog");
          // A stray Escape, or a click outside the console, would discard
          // settings typed but not saved: the first close says so, and a
          // second one discards them.
          const close = (d.close || (() => {})).bind(d);
          closeNow = close;
          d.close = (...args) => {
            if (mayDiscard("Close again to discard them."))
              return close(...args);
          };
          d.addEventListener("cancel", (e) => {
            if (!unsaved().length || discarding) return;
            e.preventDefault();
            d.close();
          });
          // Typing again takes back the warning, and the next close asks
          // again.
          d.addEventListener("input", () => discarding && report(""));
          d.addEventListener("close", () => {
            if (dialog !== d) return;
            ++turn;
            ++visits;
            shown = null;
            cache = {};
            dialog = null;
          });
          panelFocus = null;
          // A link or a secret shown once copies with one press; where the
          // clipboard is refused, the field is left selected to copy.
          d.addEventListener("click", async (e) => {
            const button = e.target.closest?.("[data-copy]");
            if (!button) return;
            const field = d.querySelector("#" + button.dataset.copy);
            try {
              await navigator.clipboard.writeText(field.value);
              toast(button.dataset.copied);
            } catch {
              field.focus();
              field.select();
              toast("Copy the selected text.");
            }
          });
          d.addEventListener("focusin", (e) => {
            panelFocus = panel().contains(e.target) ? locate(e.target) : null;
          });
          d.addEventListener("keydown", (event) => {
            const scrolling = event.target;
            if (scrolling.id !== "audit-table") return;
            if (
              event.defaultPrevented ||
              event.isComposing ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              !["ArrowLeft", "ArrowRight"].includes(event.key)
            )
              return;
            const maximum = scrolling.scrollWidth - scrolling.clientWidth;
            if (maximum <= 0) return;
            event.preventDefault();
            scrolling.scrollLeft = Math.max(
              0,
              Math.min(
                maximum,
                scrolling.scrollLeft + (event.key === "ArrowRight" ? 48 : -48),
              ),
            );
          });
          d.addEventListener("keydown", (e) => {
            const bar = e.target.closest?.(".chart-bar");
            if (!bar) return;
            const bars = [...bar.parentNode.querySelectorAll(".chart-bar")];
            const n = bars.indexOf(bar);
            const next = {
              ArrowRight: bars[n + 1],
              ArrowLeft: bars[n - 1],
              Home: bars[0],
              End: bars.at(-1),
            }[e.key];
            if (!next) return;
            e.preventDefault();
            bar.setAttribute("tabindex", "-1");
            next.setAttribute("tabindex", "0");
            next.focus();
          });
          const tabs = [...d.querySelectorAll('[role="tab"]')];
          tabs.forEach((el, n) => {
            el.onclick = () => show(el.dataset.tab);
            el.onkeydown = (e) => {
              const next =
                e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? tabs[(n + 1) % tabs.length]
                  : e.key === "ArrowLeft" || e.key === "ArrowUp"
                    ? tabs[(n - 1 + tabs.length) % tabs.length]
                    : e.key === "Home"
                      ? tabs[0]
                      : e.key === "End"
                        ? tabs.at(-1)
                        : null;
              if (!next) return;
              e.preventDefault();
              next.focus();
              show(next.dataset.tab);
            };
          });
        },
      );
      show(tab);
      // The keyboard starts on the tab shown, as in any set of tabs, not
      // on Close, the one control the dialog had before its panel loads.
      dialog.querySelector('[role="tab"][aria-selected="true"]')?.focus();
      return dialog;
    },
  };
}
