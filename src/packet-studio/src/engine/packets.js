/**
 * Packet Studio decode helpers (original). Omnipeek-inspired UI — not LiveAction Omnipeek.
 * No LIVE NIC capture in v0; demo frames only (DOCUMENTED).
 */

/** @typedef {{ id:number, timeMs:number, proto:string, src:string, dst:string, summary:string, bytes:Uint8Array }} Frame */

const DEMO = [
  {
    id: 1,
    timeMs: 0,
    proto: 'ARP',
    src: '10.0.0.1',
    dst: '10.0.0.2',
    summary: 'Who has 10.0.0.2? Tell 10.0.0.1',
    hex: '00010800450000000000000000000000',
  },
  {
    id: 2,
    timeMs: 12,
    proto: 'DNS',
    src: '10.0.0.5',
    dst: '1.1.1.1',
    summary: 'Standard query A example.com',
    hex: 'abcd01000001000000000000076578616d706c6503636f6d00',
  },
  {
    id: 3,
    timeMs: 40,
    proto: 'TCP',
    src: '10.0.0.5:443',
    dst: '10.0.0.9:51234',
    summary: 'HTTPS [SYN, ACK] seq=1 ack=1',
    hex: '45000034000040004006abcd0a0000050a00000901bb c882',
  },
  {
    id: 4,
    timeMs: 88,
    proto: 'HTTP',
    src: '10.0.0.9:51234',
    dst: '10.0.0.5:80',
    summary: 'GET /index.html HTTP/1.1',
    hex: '474554202f696e6465782e68746d6c20485454502f312e31',
  },
  {
    id: 5,
    timeMs: 120,
    proto: 'UDP',
    src: '10.0.0.8:5353',
    dst: '224.0.0.251:5353',
    summary: 'mDNS query _http._tcp.local',
    hex: '000000000001000000000000055f68747470045f746370',
  },
];

/** @returns {Frame[]} */
export function demoCapture() {
  return DEMO.map((d) => ({
    id: d.id,
    timeMs: d.timeMs,
    proto: d.proto,
    src: d.src,
    dst: d.dst,
    summary: d.summary,
    bytes: hexToBytes(d.hex.replace(/\s+/g, '')),
  }));
}

/** @param {string} hex */
export function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** @param {Uint8Array} bytes */
export function bytesToHex(bytes, group = 2) {
  const parts = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  if (!group) return parts.join('');
  /** @type {string[]} */
  const grouped = [];
  for (let i = 0; i < parts.length; i += group) {
    grouped.push(parts.slice(i, i + group).join(''));
  }
  return grouped.join(' ');
}

/**
 * @param {Frame[]} frames
 * @param {{ proto?:string, text?:string }} filter
 */
export function filterFrames(frames, filter = {}) {
  const proto = (filter.proto || '').trim().toUpperCase();
  const text = (filter.text || '').trim().toLowerCase();
  return frames.filter((f) => {
    if (proto && proto !== 'ALL' && f.proto.toUpperCase() !== proto) return false;
    if (!text) return true;
    const hay = `${f.src} ${f.dst} ${f.summary} ${f.proto}`.toLowerCase();
    return hay.includes(text);
  });
}

/** Guess Ethernet/IP-ish layout notes from first bytes (toy decoder). */
export function decodeSummary(bytes) {
  if (bytes.length === 0) return 'Empty';
  if (bytes[0] === 0x47 && bytes[1] === 0x45 && bytes[2] === 0x54) return 'ASCII HTTP request start';
  if (bytes[0] === 0x45) return `IPv4 header (IHL nibble), len=${bytes.length}`;
  return `${bytes.length} bytes`;
}
