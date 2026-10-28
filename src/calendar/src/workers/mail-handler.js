/**
 * Published Puter events handler for `fs:~/.mail/objects/**:add`. Runs on the
 * app's events worker and, in-page, as the foreground/rescan path via
 * mailbox.js's `new Function` instantiation of this same source — one
 * implementation, one hash.
 *
 * MUST stay a single bare async function expression: no imports, no exports,
 * no statement before or after it (a leading comment is fine). Everything it
 * needs is declared INSIDE the function — it cannot close over anything, and
 * the publish-time free-variable scan refuses any global outside a fixed
 * allowlist (fetch/crypto/atob/TextDecoder/… — no `puter`, no `me`).
 *
 * It only ever extracts and records; it never writes `cal:evt:` — every
 * calendar mutation happens in-app (mail-intake.js), where contacts,
 * settings, the recurrence engine and the offline gate exist.
 *
 * Message reading is `user.email.get({ id })` (puter.email API) — no
 * hand-written MIME parsing here. The iCalendar allowlist filter below is
 * what bounds and sanitizes what actually gets stored.
 */
async function calendarMailHandler({ event, ctx, user, fetch, ack }) {
  const RECORD_VERSION = 1;

  // ---- caps ---------------------------------------------------------------
  const MAX_MESSAGE_BYTES = 3 << 20; // 3 MiB — Outlook invites with inline images
  const MAX_CALENDAR_PARTS = 4;
  const MAX_VEVENTS = 30;
  const MAX_ICAL_LINES = 400;
  const MAX_ICAL_CHARS = 12288;
  const MAX_PER_DAY = 60; // records WRITTEN
  const MAX_SCANNED_PER_DAY = 600; // files PROCESSED
  const MAX_RECORDS = 150;
  const RECORD_TTL = 30 * 86400;
  const SEEN_TTL = 45 * 86400;
  const MAX_RECORD_CHARS = 20000;

  // A mail object is named `<uuidv7 id>--<base64url subject>`.
  const ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})--/i;

  const VEVENT_PROP_ALLOW = new Set([
    'UID', 'SEQUENCE', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'LOCATION',
    'DESCRIPTION', 'URL', 'ORGANIZER', 'ATTENDEE', 'RRULE', 'EXDATE', 'RECURRENCE-ID', 'STATUS',
    'TRANSP', 'COMMENT', 'CLASS',
  ]);
  const PARAM_ALLOW = new Set([
    'TZID', 'VALUE', 'CN', 'PARTSTAT', 'ROLE', 'RSVP', 'RANGE', 'CUTYPE',
    'DELEGATED-FROM', 'DELEGATED-TO',
  ]);

  /* ---- small primitives ------------------------------------------------ */

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function yyyymmdd(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  }

  // 64-bit FNV-1a as two 32-bit halves, hex — same shape as invites.js's
  // digest(). Not a secret: only used to fingerprint an id for idempotency.
  function hash64(str) {
    const s = String(str);
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function ts36() {
    return Date.now().toString(36).padStart(9, '0');
  }

  function isTransientError(err) {
    const code = err && (err.code || err.status);
    if (code === 429 || code === 'too_many_requests') return true;
    if (typeof code === 'number' && code >= 500) return true;
    const msg = (err && (err.message || (typeof err === 'string' ? err : ''))) || '';
    if (!msg) return true; // no message at all — treat as transient, per spec
    return /\b429\b|\b5\d\d\b|network|timeout|econn/i.test(String(msg));
  }

  function sanitizeText(s, max) {
    return String(s || '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function normalizeEmail(v) {
    const s = String(v || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
  }

  // For headers postal-mime doesn't parse into a structured address (e.g.
  // Sender): pull the address out of "Name <addr>" or a bare address.
  function extractAddress(value) {
    const v = String(value || '').trim();
    const m = /<([^>]*)>/.exec(v);
    const raw = (m ? m[1] : v).replace(/^mailto:/i, '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : '';
  }

  function domainOf(email) {
    const at = String(email || '').lastIndexOf('@');
    return at === -1 ? '' : email.slice(at + 1).toLowerCase();
  }

  function domainMatches(dkimDomain, fromDomain) {
    if (!dkimDomain || !fromDomain) return false;
    return dkimDomain === fromDomain || fromDomain.endsWith('.' + dkimDomain);
  }

  /**
   * Only the FIRST Authentication-Results header counts — the topmost one,
   * which is the one our own MX prepended. A sender can put anything they
   * like in the body of the message they submit, `Authentication-Results:
   * x; dkim=pass header.d=puter.email` included; honouring every occurrence
   * would let that forged line supply the verdict and the signing domain.
   */
  function parseAuthResults(value) {
    const v = String(value || '');
    const result = (re) => {
      const m = re.exec(v);
      if (!m) return 'none';
      const r = m[1].toLowerCase();
      return r === 'pass' ? 'pass' : r === 'fail' ? 'fail' : 'none';
    };
    const dd = /header\.d=([a-z0-9.-]+)/i.exec(v);
    return {
      dkim: result(/dkim=(\w+)/i),
      spf: result(/spf=(\w+)/i),
      dkimDomain: dd ? dd[1].toLowerCase() : '',
    };
  }

  function parseDateMs(value) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }

  function looksLikeCalendarStart(text) {
    const s = String(text || '').replace(/^[ \t\r\n\uFEFF]+/, '');
    return s.slice(0, 15).toUpperCase() === 'BEGIN:VCALENDAR';
  }

  function decodeAttachmentText(att) {
    try {
      return new TextDecoder('utf-8').decode(att && att.content);
    } catch {
      return '';
    }
  }

  function idFromFilename(name) {
    const m = ID_RE.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  /* ---- iCalendar filter (bounded, allowlisted; not a full parse) --------- */

  function sanitizeICalValue(v) {
    return String(v).replace(/\p{Cc}/gu, '');
  }

  // RFC 5545 line unfolding: continuation lines start with a space or tab,
  // and real-world calendars sometimes use a lone '\r' as a terminator.
  function unfoldIcalLines(text) {
    const raw = String(text).split(/\r\n|\n|\r/);
    const out = [];
    for (const line of raw) {
      if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
        out[out.length - 1] += line;
      } else if (line.length) {
        out.push(line);
      }
    }
    return out;
  }

  function parseICalLine(line) {
    let idx = -1;
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuote = !inQuote;
      else if (ch === ':' && !inQuote) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return null;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const semi = left.indexOf(';');
    return {
      name: (semi === -1 ? left : left.slice(0, semi)).toUpperCase().trim(),
      paramsRaw: semi === -1 ? '' : left.slice(semi + 1),
      value,
    };
  }

  function parseICalParams(paramsRaw) {
    const out = [];
    let i = 0;
    const n = paramsRaw.length;
    while (i < n) {
      while (i < n && paramsRaw[i] === ';') i++;
      const start = i;
      while (i < n && paramsRaw[i] !== '=' && paramsRaw[i] !== ';') i++;
      const name = paramsRaw.slice(start, i).toUpperCase().trim();
      let value = '';
      if (i < n && paramsRaw[i] === '=') {
        i++;
        if (paramsRaw[i] === '"') {
          i++;
          const vstart = i;
          while (i < n && paramsRaw[i] !== '"') i++;
          value = paramsRaw.slice(vstart, i);
          if (i < n) i++;
        } else {
          const vstart = i;
          while (i < n && paramsRaw[i] !== ';') i++;
          value = paramsRaw.slice(vstart, i);
        }
      }
      if (name) out.push({ name, value });
      while (i < n && paramsRaw[i] !== ';') i++;
    }
    return out;
  }

  function mailtoAddress(value) {
    const v = String(value || '').trim().replace(/^"|"$/g, '').replace(/^mailto:/i, '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
  }

  function cleanICalProperty(prop) {
    if (prop.name === 'URL') {
      const val = sanitizeICalValue(prop.value).trim();
      if (!/^https?:\/\//i.test(val)) return null; // never an anchor either way — kept only as text
    }
    const params = parseICalParams(prop.paramsRaw || '')
      .filter((p) => PARAM_ALLOW.has(p.name))
      .map((p) => ({ name: p.name, value: sanitizeICalValue(p.value).slice(0, 200) }));
    const value = sanitizeICalValue(prop.value);
    const paramStr = params
      .map((p) => {
        const quoted = /[:;,]/.test(p.value) ? '"' + p.value + '"' : p.value;
        return ';' + p.name + '=' + quoted;
      })
      .join('');
    const line = `${prop.name}${paramStr}:${value}`;
    return line.length > 900 ? line.slice(0, 900) : line;
  }

  function findValue(props, name) {
    const p = props.find((x) => x.name === name);
    return p ? p.value : '';
  }

  function assembleICal(calMethod, cleanedEvents) {
    const header = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
    if (calMethod) header.push('METHOD:' + calMethod);
    const footer = ['END:VCALENDAR'];

    let truncated = cleanedEvents.length > MAX_VEVENTS;
    const capped = cleanedEvents.slice(0, MAX_VEVENTS);

    const lines = [...header];
    let usedEvents = 0;
    for (const evLines of capped) {
      const block = ['BEGIN:VEVENT', ...evLines, 'END:VEVENT'];
      const nextLineCount = lines.length + block.length + footer.length;
      const nextChars = [...lines, ...block, ...footer].join('\r\n').length + 2;
      if (nextLineCount > MAX_ICAL_LINES || nextChars > MAX_ICAL_CHARS) {
        truncated = true;
        break;
      }
      lines.push(...block);
      usedEvents++;
    }
    lines.push(...footer);
    return { text: lines.join('\r\n') + '\r\n', count: usedEvents, truncated };
  }

  function filterICalText(text, mimeMethod) {
    const lines = unfoldIcalLines(text);
    let calMethod = '';
    const stack = [];
    let curEventProps = null;
    const veventsRaw = [];

    for (const original of lines) {
      const line = original.length > 900 ? original.slice(0, 900) : original;
      const beginM = /^BEGIN:([A-Za-z0-9-]+)/i.exec(line);
      if (beginM) {
        const name = beginM[1].toUpperCase();
        // VCALENDAR itself isn't tracked: it's the document, not a component
        // to nest under, and "calendar-level" (stack empty) below means
        // exactly here — directly inside VCALENDAR, not inside anything else.
        if (name !== 'VCALENDAR') stack.push(name);
        if (name === 'VEVENT') curEventProps = [];
        continue;
      }
      const endM = /^END:([A-Za-z0-9-]+)/i.exec(line);
      if (endM) {
        const name = endM[1].toUpperCase();
        if (name === 'VEVENT' && stack[stack.length - 1] === 'VEVENT') {
          veventsRaw.push(curEventProps || []);
          curEventProps = null;
        }
        if (name !== 'VCALENDAR' && stack.length) stack.pop();
        continue;
      }
      const parentIsVEvent = stack[stack.length - 1] === 'VEVENT';
      if (!parentIsVEvent) {
        if (stack.length === 0 && /^METHOD[:;]/i.test(line)) {
          const v = line.slice(line.indexOf(':') + 1).trim().toUpperCase();
          if (/^[A-Z-]{1,20}$/.test(v)) calMethod = v;
        }
        continue;
      }
      if (!curEventProps) continue;
      const prop = parseICalLine(line);
      if (!prop || !VEVENT_PROP_ALLOW.has(prop.name)) continue;
      // Bounded well above the final per-VEVENT line cap: a hostile VEVENT
      // with thousands of ATTENDEEs must not grow this array unbounded.
      if (curEventProps.length < MAX_ICAL_LINES) curEventProps.push(prop);
    }
    // An unterminated VEVENT at EOF (missing END): keep what was parsed rather
    // than drop the whole message over one malformed line.
    if (curEventProps && curEventProps.length) veventsRaw.push(curEventProps);

    if (!veventsRaw.length) return null;

    const first = veventsRaw[0];
    const uid = (findValue(first, 'UID') || '').trim().slice(0, 255);
    const summary = sanitizeICalValue(findValue(first, 'SUMMARY') || '').slice(0, 120);
    const organizer = mailtoAddress(findValue(first, 'ORGANIZER') || '');
    const attendees = [];
    for (const p of first) {
      if (p.name !== 'ATTENDEE') continue;
      const email = mailtoAddress(p.value);
      if (email && !attendees.includes(email) && attendees.length < 20) attendees.push(email);
    }

    const cleanedEvents = veventsRaw.map((props) => props.map(cleanICalProperty).filter(Boolean));
    const assembled = assembleICal(calMethod, cleanedEvents);

    return {
      method: calMethod,
      mimeMethod: mimeMethod || '',
      uid,
      summary,
      organizer,
      attendees,
      count: assembled.count,
      truncated: assembled.truncated,
      text: assembled.text,
    };
  }

  /* ---- record size ceiling ------------------------------------------------ */

  function firstVeventOnly(icalText) {
    const start = icalText.indexOf('BEGIN:VEVENT');
    const end = icalText.indexOf('END:VEVENT');
    if (start === -1 || end === -1) return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
    const inner = icalText.slice(start, end + 'END:VEVENT'.length);
    const methodLine = /METHOD:[A-Z-]+/.exec(icalText);
    const header = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...(methodLine ? [methodLine[0]] : [])];
    return header.join('\r\n') + '\r\n' + inner + '\r\nEND:VCALENDAR\r\n';
  }

  function shrinkToFit(record) {
    if (JSON.stringify(record).length <= MAX_RECORD_CHARS) return record;
    const noSnippet = { ...record, snippet: '' };
    if (JSON.stringify(noSnippet).length <= MAX_RECORD_CHARS) return noSnippet;
    const shrunk = { ...noSnippet, ical: firstVeventOnly(noSnippet.ical), events: 1, truncated: true };
    if (JSON.stringify(shrunk).length <= MAX_RECORD_CHARS) return shrunk;
    return null;
  }

  /* ---- main flow ----------------------------------------------------------- */

  let seenKey = null;
  let recordWritten = false;

  async function markSeen() {
    if (!seenKey) return;
    await user.kv.set(seenKey, 1);
    await user.kv.expire(seenKey, SEEN_TTL);
  }

  async function trimRecords() {
    const keys = await user.kv.list('cal:mail:inv:*'); // keys only — never flat-list with values
    if (!Array.isArray(keys) || keys.length <= MAX_RECORDS) return;
    const sorted = [...keys].sort();
    const toDelete = sorted.slice(0, sorted.length - MAX_RECORDS);
    for (const k of toDelete) {
      try {
        await user.kv.del(k);
      } catch {
        /* best-effort — a stray extra record is not worth failing the run over */
      }
    }
  }

  try {
    if (!event || typeof event !== 'object') return;

    if (event.op === 'gap') {
      const reason = typeof event.reason === 'string' ? event.reason.slice(0, 200) : '';
      await user.kv.set('cal:mail:gap', { at: Date.now(), reason });
      return;
    }
    if (event.op !== 'add') return;
    if (typeof event.path !== 'string' || event.path.indexOf('/.mail/objects/') === -1) return;

    const path = event.path;
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const id = idFromFilename(filename);
    if (!id) return; // not a mail object name we understand — nothing to get

    // Keyed on the message id, not the path: a worker delivery and the
    // in-page rescan spell the same file's path differently, but both agree
    // on the id, so whichever sees a message first makes the other a no-op.
    const h = hash64(id);
    seenKey = 'cal:mail:seen:' + h;
    if (await user.kv.get(seenKey)) return; // redelivery, or an already-scanned message

    // Files SCANNED and records WRITTEN are separate budgets, so a
    // mailbox full of newsletters can't starve the afternoon's invitations.
    const day = yyyymmdd(Date.now());
    const scanKey = 'cal:mail:scan:' + day;
    const scanned = await user.kv.incr(scanKey);
    await user.kv.expire(scanKey, 3 * 86400);
    if (scanned > MAX_SCANNED_PER_DAY) return;

    const st = await user.fs.stat(path);
    const size = st ? Number(st.size) : NaN;
    if (Number.isFinite(size) && size > MAX_MESSAGE_BYTES) {
      await markSeen();
      return;
    }

    let msg;
    try {
      msg = await user.email.get({ id });
    } catch (err) {
      if (err && err.code === 'not_found') {
        await markSeen(); // the file vanished between the fs event and the read
        return;
      }
      throw err; // let the outer catch apply the transient-vs-ignore policy
    }

    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    const calendarTexts = [];
    for (const att of attachments) {
      if (calendarTexts.length >= MAX_CALENDAR_PARTS) break;
      if (!att) continue;
      const mimeType = String(att.mimeType || '').toLowerCase();
      const filenameAtt = String(att.filename || '');
      if (mimeType === 'text/calendar' || mimeType === 'application/ics' || /\.(ics|ical)$/i.test(filenameAtt)) {
        calendarTexts.push(decodeAttachmentText(att));
      } else if (mimeType === 'application/octet-stream') {
        const text = decodeAttachmentText(att);
        if (looksLikeCalendarStart(text)) calendarTexts.push(text);
      }
    }

    let filtered = null;
    for (const text of calendarTexts) {
      const f = filterICalText(text);
      if (f && f.count > 0) {
        filtered = f;
        break; // document order, first usable wins — not largest-first
      }
    }
    if (!filtered) {
      await markSeen(); // a normal, extremely common outcome — most mail isn't an invitation
      return;
    }

    // Only a message that actually carries a usable invitation spends
    // the (much smaller) records-written budget — incremented right after a
    // calendar part is found, before anything is built or written.
    const dayKey = 'cal:mail:day:' + day;
    const n = await user.kv.incr(dayKey);
    await user.kv.expire(dayKey, 3 * 86400);
    if (n > MAX_PER_DAY) {
      await markSeen();
      return;
    }

    const headers = Array.isArray(msg.headers) ? msg.headers : [];
    // Only the FIRST Authentication-Results header counts.
    const authHeader = headers.find((hd) => hd && hd.key === 'authentication-results');
    const hasAuthResults = Boolean(authHeader);
    const received = headers.some((hd) => hd && hd.key === 'received');
    const senderHeader = headers.find((hd) => hd && hd.key === 'sender');

    // Identity is the From header — never the iCalendar ORGANIZER/ATTENDEE,
    // which the filter below still records, but only as event data, not as a
    // trust decision. Sender: is kept for display only.
    const fromEmail = normalizeEmail(msg.from && msg.from.address);
    const fromDomain = domainOf(fromEmail);
    const isPuterDomain = fromDomain === 'puter.email' || fromDomain === 'puterstaging.email';
    const authResults = parseAuthResults(authHeader && authHeader.value);

    const from = { email: fromEmail, name: sanitizeText(msg.from && msg.from.name, 100) };
    const replyTo = normalizeEmail(msg.replyTo && msg.replyTo[0] && msg.replyTo[0].address);
    const sender = extractAddress(senderHeader && senderHeader.value);
    const subject = sanitizeText(msg.subject, 200);
    const date = parseDateMs(msg.date);
    const auth = {
      internal: isPuterDomain && !received && !hasAuthResults,
      dkim: authResults.dkim,
      dkimAligned: authResults.dkim === 'pass' && domainMatches(authResults.dkimDomain, fromDomain),
      spf: authResults.spf,
      received,
    };

    let record = {
      v: RECORD_VERSION,
      at: Date.now(),
      file: { path: path.slice(0, 400), uid: String(event.uid || '').slice(0, 80) },
      from,
      replyTo,
      sender,
      subject,
      date,
      auth,
      method: filtered.method,
      mimeMethod: filtered.mimeMethod,
      uid: filtered.uid,
      summary: filtered.summary,
      organizer: filtered.organizer,
      attendees: filtered.attendees,
      events: filtered.count,
      truncated: filtered.truncated,
      snippet: sanitizeText(msg.text, 500), // msg.html is never read
      ical: filtered.text,
    };

    record = shrinkToFit(record);
    if (!record) {
      await markSeen();
      return;
    }

    const key = 'cal:mail:inv:' + ts36() + '-' + h.slice(0, 8);
    await user.kv.set(key, record);
    await user.kv.expire(key, RECORD_TTL);
    recordWritten = true;

    await markSeen();
    await user.kv.set('cal:mail:tick', Date.now());

    if (n % 20 === 0) await trimRecords();
  } catch (err) {
    if (recordWritten) return; // the record landed — ack, don't retry
    // Only an error marked temporary is retried; any other throw drops the event.
    if (isTransientError(err)) {
      throw Object.assign(new Error((err && err.message) || String(err)), { retry: true, cause: err });
    }
    // Never terminal: anything else the handler can't use is ignored.
    try {
      await markSeen();
    } catch {
      /* best-effort */
    }
  }
}
