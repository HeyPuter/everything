# Share for review

Owners share a render of a project with other Puter users, who watch it and leave comments pinned to frames. Everything runs on the owner's own Puter account: their files hold the videos and a small worker deployed from the app holds the review data.

## Flow

1. **Share** (top bar Share button, File menu, or the command list): the project, or its in/out range, is rendered with the exporter as a review copy (720p, H.264 MP4, the project's frame rate, balanced quality, with sound; VP9 WebM if the browser cannot encode H.264). It is saved at `video-studio/reviews/<projectId>/<time>-<id>.mp4` in the app's folder and published on the owner's review worker. Sharing the same project again adds a version to the same review.
2. **Invite**: the owner creates links with a role (can comment or can view) and an expiry (1, 7 or 30 days), can turn links off, sees who joined, changes roles and removes people.
3. **Review page** (`#review=<id>&server=<worker host>&invite=<token>`): reviewers sign in to Puter, join, and the token is removed from the address bar. They watch, step frames, comment at a frame or a range, reply, resolve and reopen, edit and delete their own comments, and switch versions. Keys: Space, K, J and L or the arrow keys (Shift for ten frames), C to comment.
4. **Editor Review panel** (File > Review comments): the owner sees the comments of each version, polled every 15 seconds while the panel is open (plus Refresh). Clicking a time moves the playhead there, mapped through the range the version was rendered from, on the timeline it was shared from (opened first when another one is open). "Add as markers" turns comments into markers on that timeline (one undo step).

## Files

| File | Role |
| --- | --- |
| `src/review/protocol.js` | Roles, limits, ids, hashing and signing, trusted worker addresses, review links, token metadata, comment validation (shared by app and worker) |
| `src/review/time.js` | Frames, frame-accurate timecode, seeking to the middle of a frame, review and editor time mapping, strip markers |
| `src/review/comments.js` | Merging comment snapshots, threads, counts, permissions |
| `src/review/auth.js` | Restricted credential for calling workers |
| `src/review/api.js` | Deploying and updating the owner's worker, calling any review worker |
| `src/review/session.js` | One open review: join or load, polling sync since a cursor, comment writes |
| `src/review/share.js` | Render, save, publish |
| `src/ui/review/*` | Share dialog, review page, editor panel, thread list |
| `worker/` | The review worker (`index.js` entry, `http.js`, `auth.js`, `service.js`) |
| `vite.worker.config.js` | Bundles the worker into `public/worker/video-studio-review-worker.js` (part of `npm run build`) |
| `dev/` | Fake Puter for tests and the browser harness (`/dev/review-mock.html?as=alice`) |

## Worker operations (POST /api)

| Operation | Who | What |
| --- | --- | --- |
| `review.find` | owner | The review shared from a project, if any |
| `review.publish` | owner | New review or new version (idempotent by client id; the video file must exist in the owner's files) |
| `review.get` | members | Review details, versions, the caller's role |
| `join` | anyone signed in | Join with an invite token (or return membership) |
| `video.url` | members | A read link for one version's video |
| `sync` | members | Comment changes after a cursor, up to 100 at a time |
| `comment.add`, `comment.edit`, `comment.delete`, `comment.resolve` | commenters and owner | Writes, all safe to repeat |
| `invite.create`, `invite.list`, `invite.revoke` | owner | Invite links |
| `members`, `member.role`, `member.remove` | owner | People |

`GET /health` reports the build so the app can update an out-of-date worker. Updates only move forward and operations stay backward compatible, since a worker is updated only when its owner opens the app.

## Data (owner's app KV, no listing)

Most collections are numbered with `incr` and read back by key in batches. New member entries use a directory map written with partial updates. Nothing calls `kv.list`:

- `vsr:r:<id>` review; `vsr:r:<id>:vseq` and `:v:<n>` versions; `vsr:project:<projectId>` review of a project; `vsr:pub:<clientId>` finished publishes.
- `vsr:r:<id>:m:<uuid>` members; `:mdir` maps escaped UUID fields to member UUIDs. Legacy `:mseq` and `:mi:<n>` entries remain readable.
- `vsr:invite:<sha256(token)>` invites (tokens are never stored); `:iseq` and `:ii:<n>` the invite list.
- `vsr:r:<id>:seq` change counter; `:log:<n>` comment snapshot saved as change n; `:c:<commentId>` latest snapshot.
- `vsr:r:<id>:url:<n>` cached video read link; `vsr:rate:...`, `vsr:wrate:...` and `vsr:joinfail:...` counters with expiry.

Member grant history is bounded by the review’s 50-invite limit; removal retires old grant payloads in the same update. Normal review polling still reads one member record. The member directory is about 100 KB for 1,000 UUIDs; other values stay small (a few KB at most). A change number taken but never written (a crashed request) is skipped once a later change is a minute old; until then sync waits for it, so nothing is missed.

## Authentication

Nobody sends a Puter session to a worker, not even its owner. The app writes a small file with this device's public key to the person's own drive and makes a read-only access token for that one file (`puter.fs.getReadURL`, kept in their app KV for a day because minting is rate limited). Each request carries that token and a signature over the worker origin, the file path and the SHA-256 of the body. The worker stats the file with the token (Puter checks expiry and revocation; the file must be unshared and owned by the caller) and takes the caller's username from the file's owner. Session and app tokens are refused. Worker addresses outside `https://<name>.puter.work` are refused before anything is sent.

## How the video reaches reviewers

The worker hands members a **short-lived read link for that one file**: `getReadURL(path, '4h')`, which mints an access token whose only permission is `fs:<file uid>:read`. Links are cached per version and renewed when less than 30 minutes remain, because Puter allows about 20 credential mints an hour per account. Removing someone revokes the cached links of that review with `fs.revokeReadURL` (an app may revoke links it created) so the next request gets a fresh one.

Why not stream through the worker: the worker would hold whole files in memory (no ranged reads from `fs.read`), pay for every byte twice, and a `<video>` element cannot send the worker's auth headers.

Range requests: Puter's `/token-read` handler (read in Puter's public source, `LegacyFSController.tokenRead`) forwards to the same reader as `/read`, passes the `Range` header to the file service, answers 206 with `Content-Range`, and sets the file's real MIME type with `Content-Disposition: inline`. So the browser can start playback before the download finishes and seek in large files. This was **not tried against a real Puter account**. In the harness a service worker answers fake read links from IndexedDB with the same token checks and Range handling; Chrome requested `bytes=0-` and played and seeked the 206 responses.

What a link does and does not protect: anyone holding a link can fetch that one video until it expires or is revoked; it grants nothing else. A removed person loses comments and new links at once; links they already hold stop working when revocation succeeds, otherwise within 4 hours.

Role changes, invite-based upgrades for current members, and removals use [Puter's partial KV updates](https://docs.puter.com/KV/update/). They update only their own fields so a delayed role save cannot erase a removal. If the updated record is already removed, the role change returns 404 and an invite upgrade returns 403. These operations retain the original base fields and use the same number of KV calls.

Role and display-name overrides are scoped to the membership's granting invite (`role_<invite>` and `username_<invite>`). Reads fall back to the original fields when no override exists. A delayed write for an older grant cannot raise the permissions of a new viewer membership; it returns 409 if the granting invite changed while saving. These fields use the same record and do not add storage calls to normal polling.

First-time membership creation uses [`onlyIfAbsent`](https://docs.puter.com/KV/set/#writing-only-if-absent). If another join already created the record, the losing request rechecks membership and invite validity once rather than overwriting the saved record. Directory registration reuses the same UUID field, so simultaneous joins do not add duplicate list entries. Puter documents that simultaneous conditional writes and counters across regions can both succeed; these guards do not provide global serialization. Cross-region consistency remains a separate concern.

New joins persist their UUID in the member directory before creating access. A failed directory write grants no access; a failed member write leaves a reusable directory entry that lists no active member. Retries and lost acknowledgements cannot create an active member without a discoverable entry. Existing numbered lists remain in their original order; new entries are ordered by the base grant's join time. Older records are checked once on their next join or authenticated visit: missing entries are repaired and an `indexed` marker is added with a partial update that preserves removals and role changes. Normal polling still reads one member record, with no directory read after that migration. A new join uses one fewer KV call than the previous numbered-index writes. These guarantees cover the local storage orderings tested; cross-region consistency and simultaneous old/new worker deployments remain unverified.

Rejoins add `grant_<invite>` snapshots instead of replacing the member record. New invites carry their reserved list ordinal. Removal reads the member and current invite counter together, blocks all issued ordinals, and retires old grant payloads in one partial update. Those revocation flags are never cleared by a rejoin. If different fresh invites race, the grant with the later ordinal wins; scoped owner role changes still apply to that grant. Legacy records remain readable, and a legacy invite’s ordinal is recovered from the existing invite index only when needed for rejoining. A genuinely new invite can grant access after removal even in the same clock tick.

Invite revocation updates only `revoked`; completed joins increment only `uses` with [a field counter](https://docs.puter.com/KV/incr/). A delayed usage update therefore does not rewrite an older `revoked: false` value, and revocation does not overwrite the usage count. Usage counting remains best effort if its storage request fails.

## Limits (enforced by the worker)

Comment text up to 2000 characters; 12 comments and 60 edits, deletes, resolves or reopens a minute per person per review; ranges up to 10 minutes and inside the video; 20,000 comment changes, 50 versions, 200 people (people removed don't count; 1,000 ever joined) and 50 invite links per review; 10 failed joins per person per 10 minutes; review videos up to 4 GB; request bodies up to 64 KB.

Publishing checks the allocated version number as well as the initial count. A concurrent request that reserves a number beyond the limit is rejected before writing a version or changing the review title. It returns the unused reservation with a negative increment so normal sync does not announce a nonexistent version. Successful publishes use the same storage calls as before; reservation cleanup is best effort if storage fails. The provider's cross-region counter limitations still apply.

## Needs a real Puter account to confirm

- That a worker deployed from the app can `stat` and `getReadURL` the files the app wrote (Puter binds such workers to the app's AppData, so it should).
- `/token-read` playback and seeking of a large review video in Safari, Chrome and Firefox, and its behaviour under Puter's signed-read rate limit while seeking.
- `fs.revokeReadURL` from the worker for links it minted.
- `kv.get` with an array of keys, `kv.incr` and `kv.expire` from the worker.
- Worker start-up and update timing after the first Share.

## Known limitations

- Comments are polled (8 seconds on the review page, 15 in the editor panel, paused while the page is hidden), not pushed. Each poll costs the owner's KV about five reads, so a few dozen people watching at once stay well inside Puter's KV request rate.
- Editing a comment while someone resolves it at the same moment can drop one of the two changes.
- Comments map to the editor through the range a version was made from; edits made to the timeline after sharing can move things.
- Invite links are shown once (only their hash is kept); make a new one to share again.
- No email invitations, notifications, drawings on frames, or download button for reviewers.
