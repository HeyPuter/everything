// Marker list import: reads the tab- or comma-separated text written by
// File > Export > Markers (Name, Start, Duration, Time Format, Type,
// Description), the same column layout pro editors exchange.

import { parseTime, TIME_FORMATS } from '../lib/time.js';
import { MARKER_TYPES } from '../model/markers.js';

/** Splits delimited text into rows of fields, honouring "quoted ""fields""". */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = String(text).replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (c === '\r' && s[i + 1] === '\n') i++;
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const FORMAT_IDS = new Set(TIME_FORMATS.map((f) => f.id));

function readTime(text, rate, format, music) {
  const fmt = FORMAT_IDS.has(format) ? format : 'decimal';
  let v = parseTime(text, rate, fmt, music);
  if (!Number.isFinite(v)) for (const f of ['decimal', 'samples', 'smpte30', 'smpte25', 'smpte24']) if (Number.isFinite((v = parseTime(text, rate, f, music)))) break;
  return v;
}

function readType(text) {
  const t = String(text || '').trim().toLowerCase();
  const hit = MARKER_TYPES.find((m) => m.id === t || m.label.toLowerCase() === t);
  if (hit) return hit.id;
  if (t === 'track' || t === 'cd track') return 'cd';
  return 'cue';
}

/**
 * Parses marker text into { start, duration, name, type, description }
 * objects (frames at `rate`). Throws a readable Error when nothing is usable.
 * @param {string} text
 * @param {number} rate
 * @param {{ timeFormat?: string, tempo?: number, beatsPerBar?: number, beatNote?: number, subdivisions?: number, fps?: number }} [o] fallback time format and Time Display options
 */
export function parseMarkerText(text, rate, { timeFormat = 'decimal', tempo, beatsPerBar, beatNote, subdivisions, fps } = {}) {
  const first = String(text).split(/\r?\n/, 1)[0] || '';
  const delimiter = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) throw new Error('The marker file is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes('start') || header.includes('name');
  const col = (name, fallback) => {
    const i = header.indexOf(name);
    return hasHeader ? i : fallback;
  };
  const cName = col('name', 0);
  const cStart = col('start', 1);
  const cDur = col('duration', 2);
  const cFmt = col('time format', 3);
  const cType = col('type', 4);
  const cDesc = col('description', 5);
  // Exact positions written by Export Markers, used when the sample rate matches.
  const cStartS = col('start samples', -1);
  const cDurS = col('duration samples', -1);
  const cRate = col('sample rate', -1);
  if (cStart < 0) throw new Error('The marker file has no Start column.');
  const music = { tempo, beatsPerBar, beatNote, subdivisions, fps };
  const out = [];
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    const fmt = cFmt >= 0 ? (r[cFmt] || '').trim() : timeFormat;
    const exactRate = cRate >= 0 ? Number(r[cRate]) : NaN;
    const scale = exactRate > 0 ? rate / exactRate : 1;
    const exact = (c) => (c >= 0 && /^\d+$/.test((r[c] ?? '').trim()) ? Math.round(Number(r[c]) * scale) : NaN);
    let start = exact(cStartS);
    if (!Number.isFinite(start)) start = readTime(r[cStart] ?? '', rate, fmt || timeFormat, music);
    if (!Number.isFinite(start) || start < 0) continue;
    const durText = cDur >= 0 ? (r[cDur] ?? '').trim() : '';
    let dur = exact(cDurS);
    if (!Number.isFinite(dur)) dur = durText ? readTime(durText, rate, fmt || timeFormat, music) : 0;
    out.push({
      start,
      duration: Number.isFinite(dur) && dur > 0 ? dur : 0,
      name: cName >= 0 ? (r[cName] ?? '').trim() : '',
      type: readType(cType >= 0 ? r[cType] : ''),
      description: cDesc >= 0 ? (r[cDesc] ?? '').trim() : '',
    });
  }
  if (!out.length) throw new Error('None of its lines has a start time that could be read.');
  return out;
}
