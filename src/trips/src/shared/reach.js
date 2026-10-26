// Reach rules for URLs Trips fetches or posts to on a user's behalf (worker link previews, notify webhooks and ntfy).
// Callers choose schemes and ports (`PAGE`, `RECEIVER`). DNS rebinding can't be caught here: Puter deploys workers with
// `global_fetch_strictly_public` and self-hosted workerd refuses private ranges (docs/live-checks.md).

export const URL_CHARS = 2048;
/** Public web pages: http(s) on the default ports. */
export const PAGE = Object.freeze({ protocols: Object.freeze(['http:', 'https:']), ports: Object.freeze(['', '80', '443']) });
/** Push receivers: https on 443 or 8443. */
export const RECEIVER = Object.freeze({ protocols: Object.freeze(['https:']), ports: Object.freeze(['', '443', '8443']) });

const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'lan', 'localdomain', 'intranet', 'corp', 'private', 'test', 'invalid', 'example', 'onion'];
// Services that answer any embedded address, including private ones.
const WILDCARD_DNS = ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'vcap.me', 'traefik.me', 'localhost.run'];

function ipv4Blocked(a, b, c) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
}

/**
 * True for an IP literal no public host lives at: loopback, private, shared (CGNAT), link-local, documentation,
 * benchmarking, multicast, reserved and broadcast IPv4; IPv6 unspecified, loopback, unique local, link- and
 * site-local, multicast, reserved, documentation, discard-only, and every form carrying an IPv4 address (mapped,
 * compatible, NAT64, 6to4, Teredo). Expects the hostname as `URL` serializes it (dotted quad, bracketed IPv6).
 */
export function isBlockedIp(host) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    return parts.some((n) => n > 255) || ipv4Blocked(...parts);
  }
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return false;
  if (h.startsWith('::') || h.startsWith('0:')) return true;
  if (/^f[c-d]/.test(h) || /^fe[89a-f]/.test(h) || h.startsWith('ff')) return true;
  if (h.startsWith('64:ff9b:') || h.startsWith('2001:db8:') || h.startsWith('2002:')) return true;
  if (/^2001:(0{1,4})?:/.test(h)) return true;
  if (/^100:(0{1,4}:){0,3}:/.test(h) || /^100:0:0:0:/.test(h)) return true;
  return false;
}

const endsWith = (host, suffix) => host === suffix || host.endsWith(`.${suffix}`);
const embedsPrivateIpv4 = (host) => [...host.matchAll(/(?:^|[.-])(?=(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?:$|[.-]))/g)]
  .some((m) => { const parts = m.slice(1, 5).map(Number); return parts.every((n) => n <= 255) && ipv4Blocked(...parts); });

/** True when `host` (lowercase, as `URL` serializes it) may be reached. */
export function publicHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return !isBlockedIp(host);
  if (!host.includes('.') || LOCAL_SUFFIXES.some((suffix) => endsWith(host, suffix)) || WILDCARD_DNS.some((suffix) => endsWith(host, suffix))) return false;
  if (embedsPrivateIpv4(host)) return false;
  // A numeric last label is never a public name; URL already turned real IPv4 forms into dotted quads.
  return !/^\d+$/.test(host.split('.').at(-1));
}

/** Why `raw` may not be reached under `policy` (`invalid`, `scheme`, `credentials`, `port`, `private`), or null. */
export function reachProblem(raw, policy = PAGE) {
  if (typeof raw !== 'string' || !raw || raw.length > URL_CHARS || /\s/.test(raw)) return 'invalid';
  let url;
  try { url = new URL(raw); } catch { return 'invalid'; }
  if (!policy.protocols.includes(url.protocol)) return 'scheme';
  if (url.username || url.password) return 'credentials';
  if (!policy.ports.includes(url.port)) return 'port';
  if (!url.hostname) return 'invalid';
  return publicHost(url.hostname) ? null : 'private';
}

/** The URL without its fragment when `raw` may be reached under `policy`, else null. */
export function reachableUrl(raw, policy = PAGE) {
  if (reachProblem(raw, policy)) return null;
  const url = new URL(raw);
  url.hash = '';
  return url;
}
