# Contract Manager

**Live app:** [contracts.puter.com](https://contracts.puter.com/)

Store agreements, track renewal dates, extract obligations, and connect documents to contacts. A fast, app-like PWA-style web app built entirely on [Puter](https://developer.puter.com): your data lives in your own Puter cloud, never on anyone's servers.

## Features

- **Contract book**: every agreement with type, counterparty, value, term, tags, and notes. Search and filter across all of it.
- **Renewal tracking**: auto-renewing terms roll forward; notice periods produce clear "cancel or renegotiate by" deadlines. The Renewals view groups everything by urgency, and the dashboard surfaces what needs attention now.
- **Renewal decisions, on the record**: say what you decided — notice given, renewing, not renewing, or snooze until a date — and the contract leaves the attention list with a date and a note. "Notice given" ends the term instead of rolling it forward, and every completed term is kept as history with what it cost and how it ended.
- **Recurring obligations**: monthly, quarterly, or annual duties are one record with one live occurrence, not twelve rows. Tick it off and the next due date appears; completed occurrences are kept underneath, so "did we pay in March?" has an answer.
- **Obligations**: track what each side owes (payments, deliverables, notices) with due dates and owners. Paste contract text and let AI suggest the obligations it creates; you review every suggestion before it is saved. The Obligations view collects them across every contract, grouped by urgency, filtered by who owes what, with a badge for anything overdue.
- **Deadlines in your calendar**: download an `.ics` of every renewal, notice date and dated obligation — with reminders 7 days and 1 day before and a link back to the contract — or publish a subscribable feed from your own Puter storage so your calendar keeps itself up to date. The feed link is opt-in, replaceable, and revocable; because it is the only thing keeping that calendar private, it is treated as a secret — no export carries a copy of it, and restoring a backup never changes whether a feed is live.
- **Documents that can be read**: attach signed agreements and amendments, stored in your Puter cloud, and read them in the app — PDF pages, images, or text — without downloading anything. A PDF's text goes straight into obligation extraction; a scan with no text layer falls back to OCR, which asks first — once, and Settings can turn it back into a question — and then says plainly that it was read that way.
- **Contacts**: the people and companies behind your agreements, linked both ways.
- **Import and restore**: bring in a CSV of contracts with a column-mapping step that shows the first rows exactly as they will be saved, or restore a JSON export as a real backup. Unmapped columns land in the notes, and rows that can't be read are listed with the reason instead of being dropped.
- **Nothing is lost by accident**: deleting a contract, contact, document, or obligation is undoable from the toast, and the first three wait in Settings → Trash for 30 days with their files still in your cloud, so a restore brings the signed PDF back too.
- **Mixed currencies, honestly**: every contract carries its own currency, and totals are grouped per currency rather than added together. One comparable figure is available if you enter your own exchange rates, always shown as an estimate with the date you entered them.
- **Light / dark / system theme**, responsive from phone to desktop, keyboard- and screen-reader-friendly.

## Stack

- Vanilla JavaScript (no framework), [Vite](https://vitejs.dev) for dev/build
- [pdf.js](https://mozilla.github.io/pdf.js/) for reading and rendering PDFs, loaded lazily so it never sits in the boot path
- [Puter.js](https://docs.puter.com) for auth, key-value settings, file storage, and AI
- [Lucide](https://lucide.dev) icons
- [Vitest](https://vitest.dev) for unit tests

## Storage design

| Where | What |
| --- | --- |
| Puter KV `cm:settings:v1` | theme, currency, defaults, onboarding flags |
| Puter FS `contract-manager/contracts.json` | all contract metadata incl. obligations and document pointers |
| Puter FS `contract-manager/contacts.json` | contacts |
| Puter FS `contract-manager/docs/<contractId>/` | uploaded documents |
| Puter FS `contract-manager/calendar/deadlines.ics` | the published calendar feed, when one exists |

A boot is exactly three reads; documents are streamed to the FS and only referenced from contract metadata.

## Development

```sh
npm install
npm run dev      # dev server (real Puter SDK, requires sign-in)
npm test         # unit tests
npm run build    # production build to dist/
```

For UI work without a Puter account, open `/mock.html` on the dev server: it stubs the SDK in memory (`dev/puter-mock.js`), including a canned `puter.ai.chat` response so the extraction flow is testable offline. The mock is not part of the production build.

## Tests

`tests/` covers the pure logic the app depends on:

- `dates.test.js`: ISO date math, term rollover, renewal phases and notice windows
- `extract.test.js`: prompt construction and defensive parsing of AI output
- `store.test.js`: normalization, CRUD, obligations and their repeats, documents, the trash, term reconciliation, and the sample-data round trip against an in-memory Puter mock
- `csv.test.js`: the CSV parser (quoted fields, delimiters, BOM/CRLF), column guessing, and the value parsing that turns a spreadsheet row into a contract
- `money.test.js`: currency codes, per-currency totals, and manual conversion
- `ical.test.js`: RFC 5545 escaping and 75-octet folding, all-day events, alarms, stable UIDs, and which deadlines become events
- `doctext.test.js`: which documents can be read, the OCR consent gate, and the text/OCR paths

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
