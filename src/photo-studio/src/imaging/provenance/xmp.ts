// The provenance XMP packet (ISO 16684-1): an xpacket wrapper around rdf:RDF
// (the optional outer metadata element is left out), Dublin Core format and
// title, and properties in Photo Studio's own namespace: a compact JSON-LD
// manifest (schema.org vocabulary), the pixel hash with its method, and the
// full provenance record so it can be read back exactly.
import { keptSteps, type ProvenanceRecord } from '../../model/provenance';

/** Photo Studio's XMP and JSON-LD namespace (a fixed UUID URN, claims no domain). */
export const PSTUDIO_NS = 'urn:uuid:5f1b6a0e-8c2d-4f7a-9b3e-2d4c6e8a1f07#';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp', tiff: 'image/tiff', tif: 'image/tiff', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' };
export const mimeOf = (format: string) => MIME[format.toLowerCase()] ?? (format ? `application/x-${format.toLowerCase()}` : 'application/octet-stream');

export type XmpContent = {
  format: string;
  title: string;
  pixelHash: string;
  pixelHashMethod: string;
  record?: ProvenanceRecord;
  manifest?: unknown;
};

/** The compact JSON-LD summary of a record (undone steps left out). */
export function jsonLdManifest(record: ProvenanceRecord, o: { title: string; format: string; pixelHash: string; pixelHashMethod: string; modified: string; maxSteps?: number }) {
  const steps = record.steps.filter((s) => !s.undone);
  const shown = o.maxSteps !== undefined ? steps.slice(Math.max(0, steps.length - o.maxSteps)) : steps;
  return {
    '@context': { '@vocab': 'https://schema.org/', pstudio: PSTUDIO_NS },
    '@type': 'CreativeWork',
    '@id': `urn:uuid:${record.id}`,
    name: o.title,
    encodingFormat: mimeOf(o.format),
    dateCreated: record.created,
    dateModified: o.modified,
    'pstudio:origin': record.origin,
    isBasedOn: record.sources.map((s) => ({ '@type': 'MediaObject', name: s.name, encodingFormat: mimeOf(s.format), contentSize: s.size, 'pstudio:sha256': s.sha256, 'pstudio:role': s.role, dateCreated: s.when })),
    'pstudio:editCount': keptSteps(record),
    ...(shown.length < steps.length ? { 'pstudio:stepsOmitted': steps.length - shown.length } : {}),
    'pstudio:steps': shown.map((s) => ({ label: s.label, ...(s.command ? { command: s.command } : {}), ...(s.tool ? { tool: s.tool } : {}), ...(s.count ? { count: s.count } : {}), when: s.when })),
    'pstudio:ai': record.ai.map((a) => ({ command: a.command, kind: a.kind, when: a.when, ...(a.prompt ? { prompt: a.prompt } : {}), ...(a.model ? { model: a.model } : {}) })),
    'pstudio:exports': record.exports.map((x) => ({ name: x.name, encodingFormat: mimeOf(x.format), when: x.when, ...(x.pixelHash ? { pixelHash: x.pixelHash } : {}) })),
    'pstudio:pixelHash': o.pixelHash,
    'pstudio:pixelHashMethod': o.pixelHashMethod,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, n: string, d?: string, h?: string) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[n.toLowerCase()] ?? m));

export function buildXmpPacket(c: XmpContent): string {
  const prop = (name: string, value: string) => `   <pstudio:${name}>${esc(value)}</pstudio:${name}>\n`;
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<rdf:RDF xmlns:rdf="${RDF_NS}">\n` +
    `  <rdf:Description rdf:about="" xmlns:dc="${DC_NS}" xmlns:pstudio="${PSTUDIO_NS}">\n` +
    `   <dc:format>${esc(mimeOf(c.format))}</dc:format>\n` +
    `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(c.title)}</rdf:li></rdf:Alt></dc:title>\n` +
    prop('pixelHash', c.pixelHash) +
    prop('pixelHashMethod', c.pixelHashMethod) +
    (c.manifest !== undefined ? prop('manifest', JSON.stringify(c.manifest)) : '') +
    (c.record ? prop('record', JSON.stringify(c.record)) : '') +
    `  </rdf:Description>\n</rdf:RDF>\n<?xpacket end="r"?>`
  );
}

export type ParsedXmp = { format?: string; title?: string; pixelHash?: string; pixelHashMethod?: string; manifest?: unknown; record?: unknown; errors: string[] };
/** Read a packet written by buildXmpPacket (elements or attributes). */
export function parseXmpPacket(packet: string): ParsedXmp {
  const out: ParsedXmp = { errors: [] };
  // The prefix bound to our namespace (normally "pstudio").
  const prefix = new RegExp(`xmlns:([A-Za-z_][\\w.-]*)="${PSTUDIO_NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(packet)?.[1];
  const value = (qname: string) => {
    const el = new RegExp(`<${qname}>([\\s\\S]*?)</${qname}>`).exec(packet);
    if (el) return unesc(el[1]);
    const at = new RegExp(`\\s${qname}="([^"]*)"`).exec(packet);
    return at ? unesc(at[1]) : undefined;
  };
  out.format = value('dc:format');
  const title = /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(packet);
  if (title) out.title = unesc(title[1]);
  if (!prefix) return out;
  out.pixelHash = value(`${prefix}:pixelHash`);
  out.pixelHashMethod = value(`${prefix}:pixelHashMethod`);
  for (const key of ['manifest', 'record'] as const) {
    const text = value(`${prefix}:${key}`);
    if (text === undefined) continue;
    try {
      out[key] = JSON.parse(text);
    } catch {
      out.errors.push(`The ${key} in the XMP packet is not valid JSON.`);
    }
  }
  return out;
}
