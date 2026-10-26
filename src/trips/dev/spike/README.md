# F0 platform probes

Preparation only. No live check has run. Importing these modules performs no SDK calls. They do not sign in, deploy, share, request permissions, read email, call AI or inspect billing. Use dedicated test accounts and synthetic fixtures.

## Local verification

From `src/trips`:

```sh
npm test -- --run tests/unit/spike.test.js
node dev/spike/build-worker.mjs
```

The second command produces only `dev/spike/dist/trips-f0-worker.js`. It neither uploads nor deploys. No root script, Vite input or production worker is required. The spike modules are absent from the normal production build.

## Browser setup

An operator must first sign into a dedicated test account through Puter's normal UI, then open a controlled Trips app origin serving these modules. Confirm that the origin resolves to the intended registered app namespace and the deployed spike will be bound to that same app. Stop if it does not. Two browser profiles are needed for later two-account checks; use role labels A/B in evidence, never usernames or uuids.

During controlled Vite development, import the module from the Trips dev origin:

```js
const spike = await import('/dev/spike/index.js');
const runId = spike.newRunId();
```

A published app does not automatically contain this dev module. Publishing a controlled runner/bundle is a separate integration step; do not change the registered production app or deploy from an unregistered scratch origin to make this work. No browser/account connection is available in the preparation environment.

## KV semantics: explicit writes, automatic exact-key cleanup

Run only after deliberately accepting synthetic writes in the test account. The returned evidence contains fixed probe names, pass/fail/error/pending results, numeric/boolean measurements and a random run id. It excludes keys, paths, identities, error text, values and tokens.

```js
const kvEvidence = await spike.runKvProbes({
  puter, runId, environment: 'live', permit: spike.KV_PERMIT,
  ttl: false, size: false, conditional: false,
});
```

Default checks cover batch get ordering; update on a missing entity; independent nested path updates; `incr` and `add` return/state semantics; object-form list values; and the string-plus-config list quirk. Each run uses ten exact keys under `spike:f0-<random>:`. It never flushes or enumerates other keys. The runner attempts deletion of all ten keys in `finally`, even when probes fail. Report cleanup failure before treating a run as finished.

Optional checks require an explicit fresh run:

```js
const optionalEvidence = await spike.runKvProbes({
  puter, runId: spike.newRunId(), environment: 'live', permit: spike.KV_PERMIT,
  ttl: true, size: true, conditional: true,
});
```

- TTL waits 2.5 seconds around a 2-second expiry; a fail may require investigation of propagation/timing. It is not a cross-region guarantee.
- Size writes and reads a 398 KiB JSON string, then tries a 401 KiB JSON string. A pass brackets the approximate cap; it does not locate the exact byte boundary or prove the rejection's cause.
- Conditional put checks first-claim acceptance, second-claim rejection and retained data. An ignored option fails; an unsupported API records an error. This does not prove cross-region atomicity.
- There are at most 40 probe KV calls and 20 probe write calls, plus ten reserved delete attempts and one starting browser identity read. Only synthetic fixtures are used; the optional size probes send about 800 KiB before the readback. No retries or parallel call bursts occur.

If a browser is interrupted or cleanup fails, save the random run id and retry only exact-key cleanup in the same test account:

```js
await spike.cleanupKv({ puter, runId, permit: spike.CLEANUP_PERMIT });
```

Browser runs pin the starting verified account and session. Every SDK call checks that session immediately before dispatch and after settlement; cleanup reuses the original guard. If the account changes, subsequent probes stop and cleanup reports `cleanupRequired:true` and `originalAccountRequired:true` without issuing deletes in the replacement account. Return to the original account through Puter's UI, confirm the account role, then explicitly call fresh exact-key cleanup. Never rerun an interrupted run in a different account. Worker KV uses the trusted deployer binding and verified owner instead; it does not depend on browser `authToken` or `isSignedIn` properties.

Do not copy console objects from the SDK into the evidence. Record 402/403/429 as statuses; never paste their raw messages, network headers or URLs containing tokens. A probe error is evidence to investigate, not an instruction to retry repeatedly. SDK calls that never settle cannot reach `finally`; wait for the request to stop before manually cleaning up.

## Spike worker: preparation and separate manual deployment

The worker is **not F5**. It has `/health` and three bounded `/probe` actions: restricted owner proof verification, synthetic 5,000-entity gzip, and the default KV semantics suite. It has no spaces, members, sync, files, sharing, invites, deployment or public-trip endpoints.

Create a temporary proof identity only by an explicit call:

```js
const session = await spike.createSpikeSession({
  puter, environment: 'live', permit: spike.IDENTITY_PERMIT,
});
```

This creates a fresh `dev/spike/<runId>/identity.json`, a non-extractable in-memory private key and one 15-minute restricted `getReadURL` credential. Existing run directories are refused. The public key and token remain inside the session closure; none are returned as evidence. SDK-origin/token metadata checks are local guards; the worker still validates the restricted token with Puter on every request.

Record `session.runId` as the run id. The only permitted worker target is the generated `session.workerName` at `https://trips-f0-<random>.puter.work`. **The operator must separately review the local bundle and explicitly upload/deploy it while signed into the owner account in the same app.** No harness function does this. Deployment consumes a worker slot and incurs worker rent.

For a later authorized manual deployment, the equivalent SDK operations are:

```js
// trustedBundleText must be the locally reviewed dev/spike/dist/trips-f0-worker.js.
const workerPath = `dev/spike-workers/${session.runId}.js`;
await puter.fs.write(workerPath, trustedBundleText, {
  overwrite: false, dedupeName: false, createMissingParents: true,
});
await puter.workers.create(session.workerName, workerPath);
```

Keep that source outside the identity directory: deleting worker source destroys the worker. Do not point these statements at the production worker or app. This preparation task has not executed them.

Once a spike worker exists, each operation remains separately triggered:

```js
const health = await spike.runHealthProbe({
  puter, runId: session.runId, environment: 'live', permit: spike.WORKER_PERMIT,
});
const auth = await session.request('auth', { permit: spike.WORKER_PERMIT });
const compression = await session.request('compress', { permit: spike.WORKER_PERMIT });
const workerKv = await session.request('kv', { permit: spike.WORKER_PERMIT });
```

Health uses `x-puter-no-auth`; the response reports only whether an auth header arrived. Other calls explicitly supply the restricted token, sign `[workerOrigin, identityPath, sha256(body)]`, omit cookies and refuse redirects. The worker rejects session tokens, altered signatures, foreign owners, unexpected body fields, oversized bodies, non-spike paths and identity files outside the owner's app/run namespace. Owner identity comes from `me.puter.auth.getUser()`, never from the first caller. No identity or underlying SDK exception is returned.

The worker caps bodies at 2 KiB, identity files at 2 KiB, attempts at 12/minute and successful probes at eight per isolate lifetime. It processes one handler at a time; stream consumption may outlive the handler. The KV suite runs once per run per isolate and receives fixed synthetic keys only. These are preparation guards, not distributed abuse controls; a replay after eviction or in another region can rerun synthetic operations. Use one operator, one run and one region at a time.

Compression returns a streamed gzip of 5,000 in-memory synthetic records. `prepareMs` measures worker serialization/stream preparation wall time; `elapsedMs` includes caller/network/decompression time. **Neither is worker CPU time, a KV snapshot rebuild, nor proof that the edge forwards early chunks without buffering.** Full rebuild scans and CPU/streaming observations remain manual live work. The client bounds compressed/decompressed reads and validates only synthetic fixture contents.

The exact live token claims, `stat.owner.uuid`, `stat.path`, returned Blob type and `owner.app_name` shapes are still unverified. The harness fails closed on mismatches; update the probe from observed platform evidence before claiming F0 passes. Do not weaken owner/proof checks to work around an SDK mismatch.

## Cleanup and evidence

After all in-flight requests settle, explicitly remove the proof identity:

```js
const identityCleanup = await session.cleanup({ permit: spike.CLEANUP_PERMIT });
```

Deletion invalidates subsequent file-token access. The session closes even if deletion fails; cleanup can be retried. Account checks also surround key generation/export, each identity FS operation and worker requests. A switch after an identity mutation blocks further writes, minting and deletion, and reports that the original account needs cleanup. A setup error exposes only its safe `runId`, `cleanupRequired` and `originalAccountRequired` recovery fields. If the page is lost or the original browser session changed, return to the original account and delete only `dev/spike/<saved-runId>/` through the file UI. Empty shared parent containers may remain; never recursively delete `dev/` or `dev/spike/`.

Then separately delete the exact `dev/spike-workers/<runId>.js` source file to destroy the manually deployed worker. Verify it is absent from the test account's worker listing and note cleanup completion. Do not leave worker rent or a source file behind. No worker is created by the preparation tests.

Only serialize the returned evidence records; preserve their `environment` field. Fake results never satisfy a live checklist. Add operator-controlled UTC time, harness commit/build and account roles A/B when transcribing a real run into `docs/platform-verified.md`. Do not attach HARs, tokens, public keys, identity paths, account names/ids, signed URLs, private mail, PDFs or billing screenshots containing identity details. Check 7 billing needs a redacted before/after usage comparison by account role; this harness does not infer payer from mock counters.

For checks 1–3 and 7–9, follow the pending manual procedures in `docs/platform-verified.md`. This module deliberately provides no sharing, consent, email or AI automation.
