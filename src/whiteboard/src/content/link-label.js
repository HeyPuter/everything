// Titles for new link cards. A link to a meeting, chat, project, or file
// tool is named after the service, such as "Microsoft Teams meeting" or
// "Jira issue PS-12", which people recognize more readily than its host
// name, which the card shows below the title anyway. Other links keep the
// host name. Only new cards are titled here; stored cards keep their text.
import { toUnicode } from "../idn.js";
import { t } from "../i18n.js";
import { normalizeEmbed, providerName } from "./providers.js";
import "./strings.js";

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,9}-\d{1,9}$/;
const NUMBER = /^\d{1,9}$/;

// The service a link belongs to, as an English name and an optional detail
// such as an issue key, or null for a link to anything else. Pure, so it
// can be tested without the interface.
export function linkService(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  const under = (...domains) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  const parts = url.pathname.split("/").filter(Boolean);
  const named = (name, detail = "") => ({ name, detail });
  if (host === "meet.google.com") return named("Google Meet");
  if (under("zoom.us", "zoom.com", "zoomgov.com")) {
    if (["j", "my", "s", "w", "wc"].includes(parts[0]))
      return named("Zoom meeting");
    if (parts[0] === "rec") return named("Zoom recording");
    return named("Zoom");
  }
  if (under("teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"))
    return named(
      (parts[0] === "l" && parts[1] === "meetup-join") || parts[0] === "meet"
        ? "Microsoft Teams meeting"
        : "Microsoft Teams",
    );
  if (under("slack.com")) return named("Slack");
  if (under("atlassian.net")) {
    const issue =
      parts[0] === "browse" ? parts[1] : url.searchParams.get("selectedIssue");
    if (ISSUE_KEY.test(issue || "")) return named("Jira issue", issue);
    if (parts[0] === "wiki") return named("Confluence");
    if (parts[0] === "jira") return named("Jira");
    return named("Atlassian");
  }
  if (under("notion.so", "notion.site")) return named("Notion");
  if (host === "trello.com")
    return named(
      parts[0] === "b"
        ? "Trello board"
        : parts[0] === "c"
          ? "Trello card"
          : "Trello",
    );
  if (under("asana.com")) return named("Asana");
  if (host === "linear.app") {
    const n = parts.indexOf("issue");
    return n > 0 && ISSUE_KEY.test(parts[n + 1] || "")
      ? named("Linear issue", parts[n + 1])
      : named("Linear");
  }
  if (host === "github.com") {
    if (parts.length >= 4 && NUMBER.test(parts[3])) {
      if (parts[2] === "issues") return named("GitHub issue", `#${parts[3]}`);
      if (parts[2] === "pull")
        return named("GitHub pull request", `#${parts[3]}`);
    }
    return named("GitHub");
  }
  if (host === "gitlab.com") {
    const n = parts.indexOf("-");
    if (n > 1 && NUMBER.test(parts[n + 2] || "")) {
      if (parts[n + 1] === "issues")
        return named("GitLab issue", `#${parts[n + 2]}`);
      if (parts[n + 1] === "merge_requests")
        return named("GitLab merge request", `!${parts[n + 2]}`);
    }
    return named("GitLab");
  }
  if (under("dropbox.com")) return named("Dropbox");
  if (under("box.com")) return named("Box");
  // Personal OneDrive for work or school lives on <tenant>-my.sharepoint.com.
  if (
    under("onedrive.live.com", "1drv.ms") ||
    /-my\.sharepoint\.com$/.test(host)
  )
    return named("OneDrive");
  if (under("sharepoint.com")) return named("SharePoint");
  if (host === "drive.google.com")
    return named(
      parts.includes("folders")
        ? "Google Drive folder"
        : parts[0] === "file"
          ? "Google Drive file"
          : "Google Drive",
    );
  if (host === "docs.google.com") {
    const kinds = {
      document: "Google Docs",
      spreadsheets: "Google Sheets",
      presentation: "Google Slides",
      forms: "Google Forms",
      drawings: "Google Drawings",
    };
    const kind = kinds[parts[0] === "u" ? parts[2] : parts[0]];
    if (kind) return named(kind);
  }
  if (host === "forms.gle") return named("Google Forms");
  if (host === "calendar.google.com") return named("Google Calendar");
  return null;
}

// A new link card's title, in the interface language: the service the
// paste chooser recognized, else the service from the address, else the
// host name.
export function linkCardTitle(value, provider) {
  if (provider && provider !== "web") return t(providerName(provider));
  const service = linkService(value);
  if (service)
    return service.detail
      ? `${t(service.name)} ${service.detail}`
      : t(service.name);
  // A video or design link that could have been embedded, as when embeds
  // are turned off, is named after its provider too.
  const embed = normalizeEmbed(value, { generic: false });
  if (embed) return t(providerName(embed.provider));
  return toUnicode(new URL(value).hostname);
}

// The line under a link card's title: its host name. A card titled with
// just its host name, as every pasted link was before cards were named
// after their service, would say the same thing twice, so it shows the
// service instead, or else the rest of the address, cut to `width` in the
// context's current font. Stored cards are left as they are.
export function linkCardFooter(i, ctx, width) {
  let url;
  try {
    url = new URL(i.url);
  } catch {
    return "";
  }
  const host = url.hostname,
    bare = (name) =>
      name
        .trim()
        .toLowerCase()
        .replace(/^www\./, "");
  const title = bare(i.text || "");
  if (title !== bare(host) && title !== bare(toUnicode(host))) return host;
  const service = linkService(url.href);
  if (service)
    return service.detail
      ? `${t(service.name)} ${service.detail}`
      : t(service.name);
  let path = url.pathname;
  try {
    path = decodeURI(path);
  } catch {}
  if (path.length <= 1) return host;
  const text = `${host}${path}`.slice(0, 200);
  if (ctx.measureText(text).width <= width) return text;
  // The longest start that fits with an ellipsis, found by halving, as
  // cards are drawn on every frame.
  let low = 0,
    high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= width) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}
