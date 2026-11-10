# Hiring · Applicant Tracking

**Live app:** [hiring.puter.com](https://hiring.puter.com/)

Job pages, candidate pipeline, interview scheduling, scorecards, offers, and onboarding: a complete, calm hiring workflow in one app. Built with vanilla JavaScript and [Puter.js](https://docs.puter.com); no frameworks.

## Features

- **Jobs**: postings with description, salary range, department, location, work mode, and a draft / open / closed lifecycle. Every job has its own page with a per-job pipeline and a copyable link.
- **Pipeline**: a kanban board from Applied to Hired with drag-and-drop, per-job and per-tag filtering, search, bulk move/tag/archive, and an archive for rejected or withdrawn candidates (restorable any time). Tags live on the candidate in any stage, with typeahead over the vocabulary already in use; quick find matches names, emails, tags, and note text.
- **Candidate profiles**: contact chips, source, notes, a full activity timeline — every email draft the app opens is logged on it, with a one-click "Mark as sent" and a "last contacted" reading on the header and the board card — and every interview, scorecard, and offer in one place.
- **Interviews**: phone, video, or onsite, with panel lists, meeting links, and non-blocking double-booking warnings. Instead of one fixed time you can propose two to four slots — suggested from open windows in your working week — email them as a numbered list, and turn the reply into a booking with one click; unanswered proposals resurface under "Needs attention". Every interview carries a time zone (defaulting to the account's, then the device's), so conflicts are compared as real instants, invitations name the zone, a candidate with a zone of their own gets both readings, and the `.ics` pins the event to the moment it happens — it drops into Apple/Google/Outlook calendars at the right time anywhere. The whole schedule can also be published as one subscribable calendar feed (public but unlisted, minimal payload, revocable in a click) that keeps itself up to date.
- **Scorecards**: structured feedback (four rated dimensions plus an overall recommendation) that rolls up into an average and a panel leaning, keeping debriefs comparable. Reusable interview guides carry the questions behind an interview — attached to a format or a stage, printable during the call, and laid out in the scorecard beside the dimension each question feeds, with the answers snapshotted onto the feedback.
- **Offers**: a validated status machine (draft → sent → signed / declined / withdrawn), expiry warnings, a generated plain-text offer letter, and a recorded e-signature step that hires the candidate automatically.
- **Onboarding**: signing an offer stamps a checklist onto the new hire from an editable template — named plans, attachable to a job or a department, with an optional day offset per task so work comes due against the start date and surfaces under "Needs attention" — plus progress tracking and custom tasks.
- Light / dark / system theme (system by default), responsive from phone to desktop, keyboard- and screen-reader-friendly.

## Data & integrations

All data is stored in the signed-in user's own Puter account via `puter.kv`; nothing touches third-party servers. The app keeps dated snapshots of the whole dataset in the user's own drive (`hiring-backups/`) — one a day, one immediately before a wipe, a restore, or a purge — listed in Settings with per-entry restore and download. Calendar integration is file-based (`.ics` download, plus an optional self-hosted subscription feed), video meetings attach via meeting links, contacts via `mailto:` / `tel:` links, and offer letters copy or download as documents with typed-signature records.

When running inside Puter (`puter.env === 'app'`), the platform owns the session, so the app hides its sign-out control.

## Development

```sh
npm install
npm run dev        # then open http://localhost:5173/?mock for a local, no-account session
npm test           # vitest suite over the core domain logic
npm run build      # production build to dist/
```

The `?mock` query flag (dev builds only) swaps in `dev/puter-mock.js`, a tiny localStorage-backed stand-in for the Puter SDK, so the app can be developed without a Puter session.

## Architecture

```
src/
  core/      domain logic, framework- and DOM-free (fully unit tested)
    backend.js    storage adapters: Puter KV + in-memory (tests)
    store.js      state, actions, persistence, subscriptions
    pipeline.js   stages, funnel, staleness
    interviews.js validation, conflicts, ordering
    scorecards.js ratings, recommendations, aggregation
    offers.js     status machine, validation, letter generation
    onboard.js    checklist template and progress
    seed.js       sample dataset (relative to "now")
  lib/       small utilities: DOM builder, dates, money, ics, icons
  ui/        shell, router, views, editors, modals, toasts
tests/       vitest suites for everything in core/ and lib/
```

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
