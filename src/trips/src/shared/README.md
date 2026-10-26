# Shared contracts

These ES modules run in the browser and worker without SDK or DOM dependencies. Frozen at the Phase 0 contract gate; changes follow PLAN §7. Validators return their input or throw `DomainError` with machine-readable `code`, HTTP `status` and bounded `{path, rule}` issues. UI code translates codes with `t()`.

## Encodings

- `newId()` returns 16 lowercase Crockford base32 characters (no i/l/o/u): 9 timestamp digits and 7 random digits. A generator increments its suffix for same-millisecond or backwards-clock calls. Collision resistance between devices is 35 random bits per millisecond; ids are not secret tokens.
- `orderBetween(left = null, right = null)` uses base62 ASCII order; `orderKeys(count)` produces balanced keys. Keys never end in `0` and are capped at 128 characters. Exhaustion is explicit; rebalancing is a domain operation, never silent.
- `createClock({node, now}).tick(remote?)` returns a lexically ordered HLC: ten base36 time digits, six counter digits, sixteen id digits, separated by colons. Only worker-generated versions are authoritative. `compareHlc()` validates both versions.
- `workerOrigin(name)` and `trustedWorkerURL(url)` accept only HTTPS `trips-<10 lowercase alphanumeric>.puter.work` hosts, without credentials, explicit nondefault ports or fragments. `validateSpaceRef({w,s,k})` and `spaceRoute(ref)` validate every part.
- `reachProblem(raw, policy)` and `reachableUrl(raw, policy)` (`reach.js`) are the one SSRF guard for URLs fetched or posted to for a user (link previews, webhooks, ntfy). Hosts: public only (no private, loopback, link-local, CGNAT, documentation, multicast or reserved IPs, IPv4-carrying IPv6 forms, single-label, local-only or wildcard-DNS names, or names embedding a private IPv4); no credentials or whitespace. `PAGE` allows http(s) on 80/443, `RECEIVER` https on 443/8443.

## Money and dates

- Money is always a safe integer in currency minor units. `toMinor(decimalString, currency)` rejects excess decimal places unless `{round:true}` is explicit. `fromMinor()` preserves decimal digits. Currency support follows the runtime's `Intl.supportedValuesOf('currency')` plus CLF (four decimal places).
- `convertMinor(amount, decimalRate, fromCurrency, toCurrency)` uses BigInt rational math and accounts for both currencies' minor-unit scales. Rates are positive decimal strings with up to 18 fraction digits. Rounding is half away from zero.
- `allocate(total, weights, {seed})` uses largest remainders with deterministic rotated ties. Weights are nonnegative numbers or decimal strings; numeric fractional weights are converted to their canonical decimal strings before exact rational math. `splitAmount(total, split, {expenseId})` handles equal/amounts/percent/shares/items. Ledger callers must supply the expense id to rotate remainder recipients; the default empty seed is for shape validation. Percentages must total exactly 100; explicit amounts and item totals must match. Refunds preserve the sign. `validatePayers()` permits an empty unpaid list and otherwise requires an exact total, or at most the total with `{partial: true}` (an expense with a due date). No payer or participant is rewritten.
- `isDate()`, `addDays()`, `daysBetween()` and `dateRange()` operate on Gregorian calendar dates without a local time zone. Dates span 0001–9999, trips at most 999 inclusive days. `isTime()` uses 24-hour HH:mm.
- `zonedInstant(date, time, IANAZone, {disambiguation})` rejects missing local times in DST gaps. Repeated local times require explicit `earlier`/`later`; default is `reject`. `zonedParts()` converts an instant back to local fields and `zoneOffset()` gives a zone's UTC offset in minutes. `localDate()` is the device's calendar date. Browser-zone failure falls back to UTC. Reservation endpoints remain independent: no trip-range clamping or same-zone ordering is imposed.

## Helpers

- `geo.js`: haversine distances on the mean Earth radius, for `{lat, lng}` points (`distanceMeters`) and GeoJSON positions (`lngLatMeters`).
- `pool(items, limit, task)` (`pool.js`): bounded concurrency, results in input order.

## Schemas and writes

`validateEntity(kind, type, data)` accepts only client fields. `{server:true}` additionally requires `id, v, rev, upd, by, cr`. `meta` ids are `meta`; member ids are UUIDs; other ids are client ids. `validateTombstone()` accepts the separate deletion envelope. `validateVacay(type, data)` validates personal data outside spaces.

The DSL supports exact objects, bounded arrays, records, nullable/optional fields, enums, ranges and cross-field constraints. Unknown fields, unsafe keys, nonfinite numbers and invalid URLs fail. Nested maps are capped and prototype-related segments are rejected.

- `validateOperation(op, {kind})` accepts exactly one create, patch, delete or registered domain-op envelope. Patches use dotted object paths; arrays are replaced whole. Parent/child overlaps are rejected, required fields cannot be unset, and server stamps cannot be patched.
- `validateCommit(ops, {kind})` bounds the request and rejects duplicate op ids. Domain operations may expand into several writes, so the worker must also count the expanded entity writes.
- `authorizeOperation(op, {kind, role, uid, creator, entity, pollHasVoted, perms, now})` expects identity, role, creator and current entity from trusted worker storage. It never trusts these from the op. `creator` is read from the private immutable authorship record, never from `by`. Poll question/options changes require explicit `pollHasVoted:false` from private storage, which never reverts after voting. The worker must validate the complete result with `applyPatch()` before persisting it; final entity bytes are bounded by the KV cap.
- Per-user map patches require exactly the authenticated UUID's path. Any member may update their own place ratings/tags/visited or packing doneBy/bring. Votes and reactions additionally require `collab.post`. Creates cannot pre-fill another user's map entries.
- `meta` and `member` creates and file ingestion are worker-only. File location/storage metadata cannot be patched by clients. `meta` deletion and file deletion need their domain paths. Message deletes are authorized through `del:true` but the worker must soft-delete them, clearing text and reactions rather than writing a generic tombstone. Domain ops have their own state/permission/budget validators; the generic authorizer deliberately refuses them.

## Notes

`rtPrefs` is one entity per trip with the fixed id `ROAD_PREFS_ID` (the worker refuses others), written with `plan.edit`. Journey `type/status/vis/mood/weather` are bounded text in the schema; the worker hooks in `worker/ops/journey/` enforce their values (data-model §3.3). Visibility values never grant confidentiality to shared data. Book document revisions use the common worker-stamped `rev`, rather than accepting a client revision.
