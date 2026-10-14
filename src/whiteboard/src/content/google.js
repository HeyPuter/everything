// Google Workspace imports through public export endpoints. Only
// docs.google.com export addresses built by providers.js are fetched. Files
// must be shared with anyone who has the link, or published to the web.
import {
  googleFile,
  sheetExportURL,
  docExportURL,
  slidesExportURL,
  parseRange,
} from "./providers.js";
import { parseCSV, rangeCells } from "./tables.js";
import { parseText } from "./text-import.js";
import { extractPptx } from "./office.js";
import { decodeText } from "./binary.js";

const TEXT_BYTES = 5 * 1024 * 1024,
  // A document's Markdown export carries its pictures as data.
  MARKDOWN_BYTES = 20 * 1024 * 1024,
  SLIDES_BYTES = 50 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]),
  GOOGLE_HOST =
    /^https:\/\/(docs\.google\.com|[a-z0-9-]+\.googleusercontent\.com)\//;
export const ACCESS_ERROR =
  "Google did not share this file. Set sharing to “Anyone with the link” or publish it to the web, then try again.";
// Google says plainly when a file is gone, and a sheet's export answers 400
// for a tab that is gone. Blaming sharing for those sends people to fix
// settings that are not the problem.
export const NOT_FOUND_ERROR =
  "This Google file wasn’t found. It may have been deleted, or the link is wrong.";
export const TAB_ERROR =
  "This sheet tab no longer exists. It may have been deleted from the spreadsheet.";

// Google's export endpoints let any page read files shared by link, so they
// are asked directly, signed in to Puter or not. Puter's CORS-free fetch,
// which needs a signed-in account (and opens a sign-in window without one),
// is tried only when a direct request is refused. Without it, a refusal
// while online means Google would not hand the file over, as it does for a
// file that is not shared.
export async function defaultFetcher(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    const puter = typeof window !== "undefined" ? window.puter : null;
    if (init?.signal?.aborted) throw error;
    if (puter?.net?.fetch && puter.auth?.isSignedIn?.())
      return puter.net.fetch(url, init);
    if (typeof navigator !== "undefined" && navigator.onLine === false)
      throw error;
    throw Object.assign(Error(ACCESS_ERROR), { access: true, cause: error });
  }
}

const cancelled = () => new DOMException("Cancelled", "AbortError");
// Puter's fetch ignores `signal`, so a cancelled download stops waiting for
// the request and its body here instead of hanging until Google answers.
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const stop = () => reject(cancelled());
    signal.addEventListener("abort", stop, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

const TOO_LARGE = "This Google file is too large to import.";
// A file without a declared size stops downloading once it passes the
// limit, rather than after all of it has arrived.
async function readBody(response, limit, signal) {
  const reader = response.body?.getReader?.();
  if (!reader)
    return new Uint8Array(await abortable(response.arrayBuffer(), signal));
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.length;
      if (size > limit) throw Error(TOO_LARGE);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

export function createGoogle({ fetcher = defaultFetcher, DOMParser } = {}) {
  async function download(url, { limit, binary = false, signal } = {}) {
    // Defense in depth: only Google export endpoints are ever requested.
    if (
      !/^https:\/\/docs\.google\.com\/(spreadsheets|document|presentation)\/d\//.test(
        url || "",
      )
    )
      throw Error("This Google link is not supported.");
    // Google answers export requests with a redirect to its file host.
    // Puter's fetch returns redirects as they are, so they are followed here,
    // only to Google's own hosts; a sign-in page elsewhere means no access.
    const sheetTab =
      /^https:\/\/docs\.google\.com\/spreadsheets\/.*[?&]gid=\d/.test(url);
    let response;
    for (let hop = 0; ; hop++) {
      try {
        response = await abortable(
          fetcher(url, { credentials: "omit", redirect: "follow", signal }),
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (error?.access) throw Error(ACCESS_ERROR);
        throw Error(
          "Could not reach Google. Check your connection and try again.",
          {
            cause: error,
          },
        );
      }
      const location = REDIRECTS.has(response.status)
        ? response.headers?.get?.("location")
        : null;
      if (!location) break;
      let next = "";
      try {
        next = new URL(location, url).href;
      } catch {
        // An unreadable address is refused below.
      }
      if (hop >= 5 || !GOOGLE_HOST.test(next)) throw Error(ACCESS_ERROR);
      url = next;
    }
    if (signal?.aborted) throw cancelled();
    const type = response.headers?.get?.("content-type") || "";
    // Puter's fetch passes Google's status on as a direct request does.
    if (response.status === 404 || response.status === 410)
      throw Object.assign(Error(NOT_FOUND_ERROR), { missing: true });
    if (response.status === 400 && sheetTab)
      throw Object.assign(Error(TAB_ERROR), { missing: true });
    if (!response.ok || /text\/html/i.test(type)) throw Error(ACCESS_ERROR);
    const declared = +(response.headers?.get?.("content-length") || 0);
    if (declared > limit) throw Error(TOO_LARGE);
    const bytes = await readBody(response, limit, signal);
    if (bytes.length > limit) throw Error(TOO_LARGE);
    // A sign-in page served without an HTML content type is still refused.
    const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
    if (/^<!doctype html|^<html/i.test(head)) throw Error(ACCESS_ERROR);
    return binary ? bytes : decodeText(bytes);
  }
  function file(url, provider) {
    const found = googleFile(url);
    if (!found || (provider && found.provider !== provider))
      throw Error(
        {
          "google-sheets": "Paste a link to a Google Sheets spreadsheet.",
          "google-docs": "Paste a link to a Google Docs document.",
          "google-slides": "Paste a link to a Google Slides presentation.",
        }[provider] || "Paste a link to a Google Docs, Sheets, or Slides file.",
      );
    return found;
  }
  async function sheetRows(source, signal) {
    const text = await download(sheetExportURL(source), {
      limit: TEXT_BYTES,
      signal,
    });
    return parseCSV(text, ",");
  }
  return {
    file,
    async sheet(url, { signal } = {}) {
      const source = file(url, "google-sheets");
      const { rows, truncated } = await sheetRows(source, signal);
      return { source, rows, truncated };
    },
    // New cells for a table imported from Google Sheets, and its new source.
    async refresh(i, { signal } = {}) {
      const source = file(i.sourceUrl, "google-sheets");
      const { rows } = await sheetRows(source, signal);
      const range = parseRange(source.range) || {
        top: 0,
        left: 0,
        bottom: 19,
        right: i.cells[0].length - 1,
      };
      return rangeCells(rows, range);
    },
    async document(url, { signal } = {}) {
      const source = file(url, "google-docs");
      // Markdown keeps headings; older published documents only offer text.
      try {
        const md = await download(docExportURL(source, "md"), {
          limit: MARKDOWN_BYTES,
          signal,
        });
        return { source, model: parseText(md, { markdown: true }) };
      } catch (error) {
        // Too much text is final; plain text would hold as much, and a
        // file that is gone has no plain text either.
        if (error.name === "AbortError" || error.limit || error.missing)
          throw error;
        const txt = await download(docExportURL(source, "txt"), {
          limit: TEXT_BYTES,
          signal,
        });
        return { source, model: parseText(txt) };
      }
    },
    async slides(url, { signal } = {}) {
      const source = file(url, "google-slides");
      const address = slidesExportURL(source);
      if (!address)
        throw Error(
          "Use the presentation’s sharing link rather than a published link.",
        );
      const bytes = await download(address, {
        limit: SLIDES_BYTES,
        binary: true,
        signal,
      });
      return { source, model: await extractPptx(bytes, { signal, DOMParser }) };
    },
  };
}
