// Embed providers and their official embed addresses. This module is pure:
// the board validator and the collaboration worker import it, so it must not
// touch the DOM, storage, or translations.
//
// Every embed stores a canonical `url` and a `provider` key. The iframe
// address is always derived again from the canonical URL, so a board file
// cannot point an iframe anywhere the normalizer would not produce itself.

export const EMBED_PROVIDERS = {
  "google-docs": {
    name: "Google Docs",
    group: "google",
    badge: "D",
    color: "#4285f4",
  },
  "google-sheets": {
    name: "Google Sheets",
    group: "google",
    badge: "S",
    color: "#0f9d58",
  },
  "google-slides": {
    name: "Google Slides",
    group: "google",
    badge: "P",
    color: "#f4b400",
  },
  "google-forms": {
    name: "Google Forms",
    group: "google",
    badge: "F",
    color: "#7248b9",
  },
  "google-drawings": {
    name: "Google Drawings",
    group: "google",
    badge: "Dr",
    color: "#db4437",
  },
  "google-drive": {
    name: "Google Drive",
    group: "google",
    badge: "Dv",
    color: "#1a73e8",
  },
  "google-calendar": {
    name: "Google Calendar",
    group: "google",
    badge: "C",
    color: "#1967d2",
  },
  youtube: {
    name: "YouTube",
    group: "embeds",
    badge: "YT",
    color: "#e62117",
    video: true,
  },
  vimeo: {
    name: "Vimeo",
    group: "embeds",
    badge: "V",
    color: "#1ab7ea",
    video: true,
  },
  "microsoft-forms": {
    name: "Microsoft Forms",
    group: "embeds",
    badge: "F",
    color: "#03787c",
  },
  office: {
    name: "Microsoft Office viewer",
    group: "embeds",
    badge: "O",
    color: "#d83b01",
  },
  figma: { name: "Figma", group: "embeds", badge: "Fi", color: "#a259ff" },
  loom: {
    name: "Loom",
    group: "embeds",
    badge: "L",
    color: "#625df5",
    video: true,
  },
  miro: {
    name: "Miro",
    group: "embeds",
    badge: "M",
    color: "#ffd02f",
    dark: true,
  },
  web: { name: "Web page", group: "embeds", badge: "W", color: "#687169" },
};

const MAX_URL = 2048;
const GOOGLE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const PUBLISHED_ID = /^[A-Za-z0-9_-]{10,300}$/;

function parse(value) {
  if (typeof value !== "string" || value.length > MAX_URL) return null;
  const text = value.trim();
  // Only absolute HTTPS addresses qualify. javascript:, data:, blob:, and
  // relative addresses never parse into an https: URL here.
  if (!/^https:\/\//i.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  return url;
}
const hostIs = (url, ...hosts) =>
  hosts.includes(url.hostname.toLowerCase().replace(/\.$/, ""));
// Path segments without the optional /u/<n>/ account selector Google adds.
function segments(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[0] === "u" && /^\d+$/.test(parts[1] || "")
    ? parts.slice(2)
    : parts[1] === "u" && /^\d+$/.test(parts[2] || "")
      ? [parts[0], ...parts.slice(3)]
      : parts;
}
const hashParams = (url) => new URLSearchParams(url.hash.slice(1));
const decimal = (value) => (/^\d{1,12}$/.test(value || "") ? value : "");
const RANGE = /^[A-Z]{1,3}[1-9]\d{0,6}(:[A-Z]{1,3}[1-9]\d{0,6})?$/;
const RESOURCE_KEY = /^0-[\w-]{1,80}$/;

function google(url) {
  if (hostIs(url, "drive.google.com")) {
    const parts = segments(url);
    // Files shared by link before 2021 also need their resource key, which
    // Google adds to their links; without it they show as not found.
    const key = url.searchParams.get("resourcekey") || "";
    const resourceKey = RESOURCE_KEY.test(key) ? key : "";
    let id = "";
    if (parts[0] === "file" && parts[1] === "d") id = parts[2];
    else if (parts[0] === "open" || parts[0] === "uc")
      id = url.searchParams.get("id") || "";
    if (id && GOOGLE_ID.test(id))
      return {
        provider: "google-drive",
        url: `https://drive.google.com/file/d/${id}/view${resourceKey ? `?resourcekey=${resourceKey}` : ""}`,
        embed: `https://drive.google.com/file/d/${id}/preview${resourceKey ? `?resourcekey=${resourceKey}` : ""}`,
        id,
      };
    const folder =
      parts[0] === "drive" && parts[1] === "folders"
        ? parts[2]
        : parts[0] === "embeddedfolderview"
          ? url.searchParams.get("id")
          : "";
    if (folder && GOOGLE_ID.test(folder))
      return {
        provider: "google-drive",
        url: `https://drive.google.com/drive/folders/${folder}${resourceKey ? `?resourcekey=${resourceKey}` : ""}`,
        embed: `https://drive.google.com/embeddedfolderview?id=${folder}${resourceKey ? `&resourcekey=${resourceKey}` : ""}#grid`,
        id: folder,
        folder: true,
      };
    return null;
  }
  if (hostIs(url, "calendar.google.com")) {
    const parts = segments(url);
    if (parts[0] !== "calendar") return null;
    let sources = url.searchParams.getAll("src");
    if (!sources.length && url.searchParams.get("cid")) {
      try {
        sources = [
          atob(
            url.searchParams.get("cid").replace(/-/g, "+").replace(/_/g, "/"),
          ),
        ];
      } catch {
        return null;
      }
    }
    // Public holiday calendars have a # in their ID, such as
    // en.canadian#holiday@group.v.calendar.google.com.
    sources = sources.filter((s) => /^[\w.+#-]{1,120}@[\w.-]{1,120}$/.test(s));
    if (!sources.length || sources.length > 10) return null;
    const params = new URLSearchParams();
    for (const src of sources) params.append("src", src);
    const ctz = url.searchParams.get("ctz");
    // IANA zone names, including ones with digits such as Etc/GMT+5.
    if (ctz && /^[A-Za-z][\w+-]*(\/[\w+-]+){0,2}$/.test(ctz))
      params.set("ctz", ctz);
    const mode = url.searchParams.get("mode");
    if (["WEEK", "MONTH", "AGENDA"].includes(mode)) params.set("mode", mode);
    const canonical = `https://calendar.google.com/calendar/embed?${params}`;
    return { provider: "google-calendar", url: canonical, embed: canonical };
  }
  if (!hostIs(url, "docs.google.com")) return null;
  const parts = segments(url);
  const kinds = {
    document: "google-docs",
    spreadsheets: "google-sheets",
    presentation: "google-slides",
    forms: "google-forms",
    drawings: "google-drawings",
  };
  const provider = kinds[parts[0]];
  if (!provider || parts[1] !== "d") return null;
  const base = `https://docs.google.com/${parts[0]}/d`;
  // Published ("Publish to the web") and form response links use /d/e/<id>.
  if (parts[2] === "e") {
    const id = parts[3];
    if (!id || !PUBLISHED_ID.test(id)) return null;
    if (provider === "google-forms")
      return {
        provider,
        url: `${base}/e/${id}/viewform`,
        embed: `${base}/e/${id}/viewform?embedded=true`,
        published: true,
        id,
      };
    if (provider === "google-sheets") {
      const gid = decimal(
        url.searchParams.get("gid") || hashParams(url).get("gid"),
      );
      const range = hashParams(url).get("range") || "";
      const valid = RANGE.test(range) ? range : "";
      return {
        provider,
        url: `${base}/e/${id}/pubhtml${gid ? `?gid=${gid}` : ""}${valid ? `#range=${valid}` : ""}`,
        embed: `${base}/e/${id}/pubhtml?widget=true&headers=false${gid ? `&gid=${gid}` : ""}`,
        published: true,
        id,
        gid,
        range: valid,
      };
    }
    if (provider === "google-slides")
      return {
        provider,
        url: `${base}/e/${id}/pub`,
        embed: `${base}/e/${id}/embed?start=false&loop=false`,
        published: true,
        id,
      };
    if (provider === "google-docs")
      return {
        provider,
        url: `${base}/e/${id}/pub`,
        embed: `${base}/e/${id}/pub?embedded=true`,
        published: true,
        id,
      };
    // A published drawing is an image of it.
    if (provider === "google-drawings")
      return {
        provider,
        url: `${base}/e/${id}/pub`,
        embed: `${base}/e/${id}/pub?w=960&h=720`,
        published: true,
        id,
      };
    return null;
  }
  const id = parts[2];
  if (!id || !GOOGLE_ID.test(id)) return null;
  if (provider === "google-sheets") {
    const hash = hashParams(url);
    const gid = decimal(hash.get("gid") || url.searchParams.get("gid"));
    const range = hash.get("range") || "";
    const valid = RANGE.test(range) ? range : "";
    const fragment = [gid && `gid=${gid}`, valid && `range=${valid}`]
      .filter(Boolean)
      .join("&");
    return {
      provider,
      url: `${base}/${id}/edit${fragment ? `#${fragment}` : ""}`,
      embed: `${base}/${id}/preview${gid ? `?gid=${gid}` : ""}`,
      id,
      gid,
      range: valid,
    };
  }
  if (provider === "google-slides")
    return {
      provider,
      url: `${base}/${id}/edit`,
      embed: `${base}/${id}/embed?start=false&loop=false`,
      id,
    };
  if (provider === "google-forms")
    return {
      provider,
      url: `${base}/${id}/viewform`,
      embed: `${base}/${id}/viewform?embedded=true`,
      id,
    };
  return {
    provider,
    url: `${base}/${id}/edit`,
    embed: `${base}/${id}/preview`,
    id,
  };
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_LIST = /^[A-Za-z0-9_-]{10,64}$/;
function seconds(value) {
  if (!value) return 0;
  if (/^\d{1,6}s?$/.test(value)) return parseInt(value, 10);
  const m = value.match(/^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
function youtube(url) {
  let id = "";
  if (hostIs(url, "youtu.be")) id = url.pathname.split("/")[1] || "";
  else if (
    hostIs(
      url,
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "www.youtube-nocookie.com",
      "youtube-nocookie.com",
    )
  ) {
    const parts = url.pathname.split("/").filter(Boolean);
    // Playlists, as a page or an embed code, play the whole list.
    const list = url.searchParams.get("list") || "";
    if (
      (parts[0] === "playlist" ||
        (parts[0] === "embed" && parts[1] === "videoseries")) &&
      YOUTUBE_LIST.test(list)
    )
      return {
        provider: "youtube",
        url: `https://www.youtube.com/playlist?list=${list}`,
        embed: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`,
        id: list,
      };
    if (parts[0] === "watch") id = url.searchParams.get("v") || "";
    else if (["embed", "shorts", "live", "v"].includes(parts[0]))
      id = parts[1] || "";
  } else return null;
  // Embed paths such as live_stream look like video ids but are not.
  if (!YOUTUBE_ID.test(id) || ["videoseries", "live_stream"].includes(id))
    return null;
  const start = Math.min(
    359999,
    seconds(url.searchParams.get("t") || url.searchParams.get("start")),
  );
  return {
    provider: "youtube",
    url: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}`,
    embed: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ""}`,
    id,
  };
}

function vimeo(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  let id = "",
    hash = "";
  if (hostIs(url, "player.vimeo.com") && parts[0] === "video") {
    id = parts[1] || "";
    hash = url.searchParams.get("h") || "";
  } else if (hostIs(url, "vimeo.com", "www.vimeo.com")) {
    const n = parts.findIndex((p) => /^\d+$/.test(p));
    if (n < 0) return null;
    // Only plain video pages, channel and group video pages, and the
    // owner's video manager page qualify.
    if (
      n > 0 &&
      !["channels", "groups", "video"].includes(parts[0]) &&
      !(parts[0] === "manage" && parts[1] === "videos" && n === 2)
    )
      return null;
    id = parts[n];
    if (parts[n + 1] && /^[a-f0-9]{6,20}$/.test(parts[n + 1]))
      hash = parts[n + 1];
  } else return null;
  if (!/^\d{1,12}$/.test(id) || (hash && !/^[a-f0-9]{6,20}$/.test(hash)))
    return null;
  // A "start at" link keeps its time, as YouTube links do.
  const start = seconds(hashParams(url).get("t") || "");
  const at = start ? `#t=${start}s` : "";
  return {
    provider: "vimeo",
    url: `https://vimeo.com/${id}${hash ? `/${hash}` : ""}${at}`,
    embed: `https://player.vimeo.com/video/${id}?${hash ? `h=${hash}&` : ""}dnt=1${at}`,
    id,
  };
}

function microsoftForms(url) {
  if (
    !hostIs(
      url,
      "forms.office.com",
      "forms.microsoft.com",
      "forms.cloud.microsoft",
      "forms.office365.us",
    )
  )
    return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  // Sharing links that use /e/ stay generic web embeds, as boards already
  // store them that way and a stored embed must keep validating.
  if (parts[0] === "r" && /^[A-Za-z0-9]{6,40}$/.test(parts[1] || "")) {
    const canonical = `https://${host}/r/${parts[1]}`;
    return {
      provider: "microsoft-forms",
      url: canonical,
      embed: `${canonical}?embed=true`,
    };
  }
  const page = parts.join("/").toLowerCase();
  const id = url.searchParams.get("id") || "";
  if (
    ["pages/responsepage.aspx", "forms/responsepage.aspx"].includes(page) &&
    /^[A-Za-z0-9_-]{10,400}$/.test(id)
  ) {
    const canonical = `https://${host}/Pages/ResponsePage.aspx?id=${id}`;
    return {
      provider: "microsoft-forms",
      url: canonical,
      embed: `${canonical}&embed=true`,
    };
  }
  return null;
}

function office(url) {
  if (hostIs(url, "view.officeapps.live.com")) {
    const page = url.pathname.toLowerCase();
    if (!["/op/view.aspx", "/op/embed.aspx"].includes(page)) return null;
    const src = parse(url.searchParams.get("src") || "");
    if (!src || !isPublicHost(src.hostname)) return null;
    const encoded = encodeURIComponent(src.href);
    return {
      provider: "office",
      url: `https://view.officeapps.live.com/op/view.aspx?src=${encoded}`,
      embed: `https://view.officeapps.live.com/op/embed.aspx?src=${encoded}`,
    };
  }
  if (
    hostIs(url, "onedrive.live.com") &&
    url.pathname.toLowerCase() === "/embed"
  ) {
    const params = new URLSearchParams();
    for (const key of ["resid", "cid", "authkey", "em", "wdAr", "wdStartOn"]) {
      const value = url.searchParams.get(key);
      if (value && /^[\w!.%=-]{1,200}$/.test(value)) params.set(key, value);
    }
    if (!params.get("resid")) return null;
    const canonical = `https://onedrive.live.com/embed?${params}`;
    return { provider: "office", url: canonical, embed: canonical };
  }
  return null;
}

function figma(url) {
  // embed.figma.com addresses are Figma's current embed codes for files.
  if (!hostIs(url, "figma.com", "www.figma.com", "embed.figma.com"))
    return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "embed") {
    const inner = parse(url.searchParams.get("url") || "");
    return inner && !hostIs(inner, "figma.com", "www.figma.com")
      ? null
      : inner && figma(inner);
  }
  if (
    !["file", "design", "proto", "board", "slides", "deck"].includes(parts[0])
  )
    return null;
  const key = parts[1] || "";
  if (!/^[A-Za-z0-9]{10,64}$/.test(key)) return null;
  // A branch is a file of its own, shown from its main file's address.
  const branch =
    parts[2] === "branch" && /^[A-Za-z0-9]{10,64}$/.test(parts[3] || "")
      ? `/branch/${parts[3]}`
      : "";
  const node = url.searchParams.get("node-id") || "";
  const params =
    node && /^[\d]+[-:][\d]+$/.test(node)
      ? `?node-id=${node.replace(":", "-")}`
      : "";
  const canonical = `https://www.figma.com/${parts[0]}/${key}${branch}${params}`;
  return {
    provider: "figma",
    url: canonical,
    embed: `https://www.figma.com/embed?embed_host=whiteboard&url=${encodeURIComponent(canonical)}`,
    id: key,
  };
}

function loom(url) {
  if (!hostIs(url, "loom.com", "www.loom.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    !["share", "embed"].includes(parts[0]) ||
    !/^[a-f0-9]{32}$/.test(parts[1] || "")
  )
    return null;
  return {
    provider: "loom",
    url: `https://www.loom.com/share/${parts[1]}`,
    embed: `https://www.loom.com/embed/${parts[1]}`,
    id: parts[1],
  };
}

function miro(url) {
  if (!hostIs(url, "miro.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "app" || !["board", "live-embed"].includes(parts[1]))
    return null;
  const id = parts[2] || "";
  if (!/^[A-Za-z0-9_=-]{6,40}$/.test(id)) return null;
  return {
    provider: "miro",
    url: `https://miro.com/app/board/${id}/`,
    embed: `https://miro.com/app/live-embed/${id}/?embedMode=view_only_without_ui&autoplay=true`,
    id,
  };
}

// Generic embeds exclude local, private, and bare IP addresses so a board
// cannot frame services on the viewer's network.
export function isPublicHost(host) {
  host = String(host).toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.length > 253) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || host.includes(":"))
    return false;
  if (
    /(^|\.)(localhost|local|localdomain|internal|intranet|intra|lan|home|private|corp|test|example|invalid|onion|arpa)$/.test(
      host,
    )
  )
    return false;
  return (
    /^[a-z0-9.-]+$/.test(host) &&
    !host.split(".").some((label) => !label || label.length > 63)
  );
}
function web(url) {
  if (!isPublicHost(url.hostname)) return null;
  // Keep the query, which many embed pages need; drop the fragment unless
  // it is short, since some widgets route by fragment.
  const canonical = `https://${url.hostname.toLowerCase()}${url.pathname}${url.search}${url.hash.length <= 200 ? url.hash : ""}`;
  return canonical.length > MAX_URL
    ? null
    : { provider: "web", url: canonical, embed: canonical };
}

const NORMALIZERS = [
  google,
  youtube,
  vimeo,
  microsoftForms,
  office,
  figma,
  loom,
  miro,
];

// Returns { provider, url, embed, ... } or null. Known providers are matched
// first; `generic: true` allows any other public HTTPS page.
export function normalizeEmbed(value, { generic = true } = {}) {
  const url = parse(value);
  if (!url) return null;
  for (const normalize of NORMALIZERS) {
    const result = normalize(url);
    if (result) return result.url.length > MAX_URL ? null : result;
  }
  // A Looker Studio report's sharing link shows the report full-page; its
  // embed address is the same report under /embed/. A link copied while
  // editing ends in /edit.
  if (hostIs(url, "lookerstudio.google.com", "datastudio.google.com")) {
    const parts = segments(url);
    if (parts.at(-1) === "edit") parts.pop();
    if (
      parts[0] === "reporting" &&
      /^[\w-]{1,100}$/.test(parts[1] || "") &&
      (parts.length === 2 ||
        (parts.length === 4 &&
          parts[2] === "page" &&
          /^[\w-]{1,100}$/.test(parts[3])))
    )
      return generic
        ? web(
            new URL(`https://lookerstudio.google.com/embed/${parts.join("/")}`),
          )
        : null;
  }
  // Google pages made to be framed embed as web pages.
  if (
    (hostIs(url, "www.google.com", "google.com") &&
      (url.pathname.startsWith("/maps/embed") ||
        /^\/maps\/d\/(u\/\d+\/)?embed$/.test(url.pathname))) ||
    (hostIs(url, "lookerstudio.google.com", "datastudio.google.com") &&
      url.pathname.startsWith("/embed/"))
  )
    return generic ? web(url) : null;
  // A recognized provider host that did not normalize is not a web page
  // embed either: it is probably a page the provider refuses to frame. A
  // trailing dot names the same host.
  if (
    /(^|\.)(google\.com|youtube\.com|youtu\.be|vimeo\.com|figma\.com|loom\.com|miro\.com|officeapps\.live\.com)\.?$/i.test(
      url.hostname,
    )
  )
    return null;
  return generic ? web(url) : null;
}

// Chat, meeting, project, design, map, code and file tools whose pages
// refuse to be framed (X-Frame-Options or a CSP frame-ancestors list), so a
// web embed of them shows an empty frame. Their links belong on link cards.
// Embeds of them already on a board stay valid; only new ones are steered
// away. Google Maps short links (maps.app.goo.gl) lead to map pages that
// refuse framing too; a map's embed code is on google.com/maps/embed.
const REFUSES_FRAMING =
  /(^|\.)(slack\.com|teams\.microsoft\.com|teams\.live\.com|notion\.so|notion\.site|atlassian\.net|atlassian\.com|trello\.com|asana\.com|linear\.app|app\.clickup\.com|monday\.com|github\.com|gitlab\.com|bitbucket\.org|dropbox\.com|onedrive\.live\.com|1drv\.ms|sharepoint\.com|linkedin\.com|discord\.com|discord\.gg|webex\.com|canva\.com|goo\.gl)\.?$/i;
// Pages those sites make to be framed: a Canva design's ?embed view and an
// Office document's embedview link on SharePoint.
const madeToFrame = (url) =>
  (/(^|\.)canva\.com\.?$/i.test(url.hostname) &&
    url.searchParams.has("embed")) ||
  (/(^|\.)sharepoint\.com\.?$/i.test(url.hostname) &&
    (url.searchParams.get("action") === "embedview" ||
      /\/_layouts\/15\/embed\.aspx$/i.test(url.pathname)));
export function refusesFraming(value) {
  const url = parse(value);
  return !!url && REFUSES_FRAMING.test(url.hostname) && !madeToFrame(url);
}
export const providerGroup = (provider) => EMBED_PROVIDERS[provider]?.group;
export const providerName = (provider) =>
  EMBED_PROVIDERS[provider]?.name || "Embed";

// The iframe address of a stored embed, or null if the stored data no longer
// normalizes to the same provider and canonical URL.
export function embedSource(i) {
  const result = normalizeEmbed(i?.url, { generic: i?.provider === "web" });
  return result && result.provider === i.provider && result.url === i.url
    ? result.embed
    : null;
}

export function validEmbed(i) {
  return (
    i.type === "embed" &&
    typeof i.provider === "string" &&
    Object.hasOwn(EMBED_PROVIDERS, i.provider) &&
    typeof i.url === "string" &&
    !!embedSource(i)
  );
}

// Browser sandbox and permission policy for a provider's iframe. Frames run
// cross-origin, so allow-same-origin only lets the provider use its own
// cookies (needed for Google file permissions); it never grants our origin.
export function frameAttributes(provider) {
  const info = EMBED_PROVIDERS[provider];
  if (!info) return null;
  return {
    sandbox: [
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      ...(info.video || provider === "google-slides"
        ? ["allow-presentation"]
        : []),
    ].join(" "),
    // Any page can be a web embed, so only named providers may write to the
    // clipboard, which a paste on the board would read.
    allow: info.video
      ? "fullscreen; picture-in-picture; encrypted-media; autoplay"
      : provider === "web"
        ? "fullscreen"
        : "fullscreen; clipboard-write",
    // Video players verify the embedding site; others receive no referrer.
    referrerpolicy:
      info.video || provider === "figma" || provider === "miro"
        ? "strict-origin-when-cross-origin"
        : "no-referrer",
  };
}

// Google Workspace export endpoints used by imports. These are the only
// remote addresses the importer fetches.
export function googleFile(value) {
  const url = parse(value);
  const result = url && google(url);
  if (!result) return null;
  const kind = result.provider.replace("google-", "");
  return { ...result, kind };
}
export function sheetExportURL(file) {
  if (!file || file.provider !== "google-sheets") return null;
  const gid = file.gid ? `&gid=${file.gid}` : "";
  return file.published
    ? `https://docs.google.com/spreadsheets/d/e/${file.id}/pub?output=csv${gid}`
    : `https://docs.google.com/spreadsheets/d/${file.id}/export?format=csv${gid}`;
}
export function docExportURL(file, format = "txt") {
  if (
    !file ||
    file.provider !== "google-docs" ||
    !["txt", "md"].includes(format)
  )
    return null;
  return file.published
    ? `https://docs.google.com/document/d/e/${file.id}/pub?output=${format}`
    : `https://docs.google.com/document/d/${file.id}/export?format=${format}`;
}
export function slidesExportURL(file) {
  if (!file || file.provider !== "google-slides" || file.published) return null;
  return `https://docs.google.com/presentation/d/${file.id}/export/pptx`;
}
// Tables imported from Google Sheets keep their source for refreshing.
export function validSheetSource(value) {
  const file =
    typeof value === "string" && value.length <= MAX_URL && googleFile(value);
  return !!file && file.provider === "google-sheets" && file.url === value;
}
// A1 range helpers used for refreshing split imports.
export function columnName(n) {
  let name = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
export function columnIndex(name) {
  let n = 0;
  for (const char of name) n = n * 26 + char.charCodeAt(0) - 64;
  return n - 1;
}
export function parseRange(range) {
  const m = /^([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?$/.exec(
    range || "",
  );
  if (!m) return null;
  const top = +m[2] - 1,
    left = columnIndex(m[1]);
  const bottom = m[4] ? +m[4] - 1 : top,
    right = m[3] ? columnIndex(m[3]) : left;
  return bottom < top || right < left ? null : { top, left, bottom, right };
}
export function sheetSourceURL(file, range) {
  const valid = range && RANGE.test(range) ? range : "";
  if (file.published)
    return `https://docs.google.com/spreadsheets/d/e/${file.id}/pubhtml${file.gid ? `?gid=${file.gid}` : ""}${valid ? `#range=${valid}` : ""}`;
  const fragment = [file.gid && `gid=${file.gid}`, valid && `range=${valid}`]
    .filter(Boolean)
    .join("&");
  return `https://docs.google.com/spreadsheets/d/${file.id}/edit${fragment ? `#${fragment}` : ""}`;
}
