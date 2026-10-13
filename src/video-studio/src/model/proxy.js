/**
 * Proxy media: small, easy to decode copies of heavy videos that the preview
 * plays instead of the original. Export, project files and every tool that
 * reads pixels or sound for the result keep using the original file.
 *
 * The project setting (settings.proxy) is 'off', 'on' or 'auto' (the
 * default, stored as no field): auto makes proxies only for media that is
 * hard to play back (4K and larger, very high bitrate, high frame rate at
 * high resolution, or files the preview has struggled to decode).
 *
 * Proxies are a device cache, named after the media's content hash and the
 * proxy format version, so a changed file or a new format never reuses an
 * old proxy. Timing is kept exactly: same timestamps, same duration.
 */

/** Bump when the proxy format changes; older proxies are deleted on start. */
export const PROXY_VERSION = 1;
/** Short side of a proxy in pixels (720p landscape, 720 wide portrait). */
export const PROXY_SHORT = 720;
/** Seconds between key frames, so seeking only decodes a few frames. */
export const PROXY_KEYFRAME = 0.5;
/** Folder of the local cache that holds proxy files. */
export const PROXY_DIR = 'proxies';

export const PROXY_MODES = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'auto', label: 'Auto' },
];

/** Bits per second above which a file counts as high bitrate. */
const HEAVY_BITRATE = 30e6;
/** Below this a file at proxy size or smaller gains nothing from a proxy. */
const LIGHT_BITRATE = 8e6;

/** The project's proxy mode ('auto' when unset). */
export function proxyMode(project) {
  const m = project?.settings?.proxy;
  return m === 'off' || m === 'on' ? m : 'auto';
}

/** Value to store for a mode: auto is the default and is not stored. */
export function normalizeProxyMode(v) {
  return v === 'off' || v === 'on' ? v : undefined;
}

/** Whether an asset is video with a picture that a proxy could stand in for. */
export function canProxy(asset) {
  return Boolean(asset && asset.kind === 'video' && asset.hasVideo !== false && asset.hash);
}

/** Average bits per second of a file (0 when unknown). */
export function bitrateOf(asset) {
  const sec = (asset?.duration || 0) / 1e6;
  return sec > 0 && asset.size > 0 ? (asset.size * 8) / sec : 0;
}

/**
 * Why a video is heavy to play back, or null: '4k' (3200 px or more on the
 * long side, or 2000 on the short side), 'bitrate' (30 Mbit/s or more),
 * 'fps' (1440p or larger at 48 fps or more).
 */
export function heavyReason(asset) {
  if (!canProxy(asset)) return null;
  const w = asset.width || 0;
  const h = asset.height || 0;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long >= 3200 || short >= 2000) return '4k';
  if (bitrateOf(asset) >= HEAVY_BITRATE) return 'bitrate';
  if (short >= 1400 && (asset.fps || 0) >= 48) return 'fps';
  return null;
}

/** Why a proxy is made (heavyReason() or slow decoding), to read mid-sentence. */
export const REASON_LABEL = { '4k': '4K or larger', bitrate: 'high bitrate', fps: 'high frame rate', slow: 'slow to decode' };

/** Whether a proxy would be smaller or lighter than the original. */
export function proxyWorthwhile(asset) {
  if (!canProxy(asset)) return false;
  const short = Math.min(asset.width || 0, asset.height || 0);
  return short === 0 || short > PROXY_SHORT * 1.1 || bitrateOf(asset) > LIGHT_BITRATE;
}

/**
 * Whether the mode asks for a proxy of this asset: 'on' for every video a
 * proxy helps, 'auto' for heavy or slow ones, 'off' never. slow: the
 * preview has had trouble decoding it on this device.
 */
export function wantsProxy(asset, mode, { slow = false } = {}) {
  if (!canProxy(asset) || mode === 'off') return false;
  if (slow) return true;
  if (mode === 'on') return proxyWorthwhile(asset);
  return Boolean(heavyReason(asset));
}

/**
 * Which file the preview shows: 'proxy' when proxies are not off, the proxy
 * is ready and the original is not being compared, else 'original'.
 */
export function previewSource({ mode, state, original = false }) {
  return mode !== 'off' && state === 'ready' && !original ? 'proxy' : 'original';
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Encoding plan for an asset's proxy: display size scaled so the short side
 * is PROXY_SHORT (never enlarged), a bitrate for that size, key frames every
 * PROXY_KEYFRAME seconds, and the facts used to check the result.
 */
export function proxyPlan(asset) {
  const w = asset.width || 0;
  const h = asset.height || 0;
  const short = Math.min(w, h);
  const k = short > PROXY_SHORT ? PROXY_SHORT / short : 1;
  const width = w ? even(w * k) : 0;
  const height = h ? even(h * k) : PROXY_SHORT;
  const fps = Math.min(60, asset.fps || 30);
  const bitrate = Math.round(Math.min(5e6, Math.max(1e6, (width || (height * 16) / 9) * height * fps * 0.09)));
  return {
    width,
    height,
    shortSide: PROXY_SHORT,
    bitrate,
    keyFrameInterval: PROXY_KEYFRAME,
    duration: (asset.duration || 0) / 1e6,
    fps,
    hasAudio: Boolean(asset.hasAudio),
  };
}

/** How far a proxy's duration may differ from the original's (seconds). */
export function durationTolerance(plan) {
  return 1.5 / (plan.fps || 30) + 0.05;
}

/** File name of a proxy (without folder): "<hash>.v<version>.<short>.<ext>". */
export function proxyFileName(hash, ext, { version = PROXY_VERSION, short = PROXY_SHORT } = {}) {
  return `${hash}.v${version}.${short}.${ext}`;
}

/** Parse a proxy file name: { hash, version, short, ext } or null. */
export function parseProxyName(name) {
  const m = /^([a-z0-9_-]{1,128})\.v(\d+)\.(\d+)\.(mp4|webm)$/i.exec(String(name || ''));
  return m ? { hash: m[1], version: Number(m[2]), short: Number(m[3]), ext: m[4].toLowerCase() } : null;
}

/** Whether a stored proxy file matches the current format (others are stale). */
export function isCurrentProxy(name) {
  const p = parseProxyName(name);
  return Boolean(p && p.version === PROXY_VERSION && p.short === PROXY_SHORT);
}
