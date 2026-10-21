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

Collections are numbered with `incr` and read back by key in batches, so nothing calls `kv.list`:

- `vsr:r:<id>` review; `vsr:r:<id>:vseq` and `:v:<n>` versions; `vsr:project:<projectId>` review of a project; `vsr:pub:<clientId>` finished publishes.
- `vsr:r:<id>:m:<uuid>` members; `:mseq` and `:mi:<n>` the member list.
- `vsr:invite:<sha256(token)>` invites (tokens are never stored); `:iseq` and `:ii:<n>` the invite list.
- `vsr:r:<id>:seq` change counter; `:log:<n>` comment snapshot saved as change n; `:c:<commentId>` latest snapshot.
- `vsr:r:<id>:url:<n>` cached video read link; `vsr:rate:...` and `vsr:joinfail:...` counters with expiry.

Every value stays small (a few KB at most). A change number taken but never written (a crashed request) is skipped once a later change is a minute old; until then sync waits for it, so nothing is missed.

## Authentication

Nobody sends a Puter session to a worker, not even its owner. The app writes a small file with this device's public key to the person's own drive and makes a read-only access token for that one file (`puter.fs.getReadURL`, kept in their app KV for a day because minting is rate limited). Each request carries that token and a signature over the worker origin, the file path and the SHA-256 of the body. The worker stats the file with the token (Puter checks expiry and revocation; the file must be unshared and owned by the caller) and takes the caller's username from the file's owner. Session and app tokens are refused. Worker addresses outside `https://<name>.puter.work` are refused before anything is sent.

## How the video reaches reviewers

The worker hands members a **short-lived read link for that one file**: `getReadURL(path, '4h')`, which mints an access token whose only permission is `fs:<file uid>:read`. Links are cached per version and renewed when less than 30 minutes remain, because Puter allows about 20 credential mints an hour per account. Removing someone revokes the cached links of that review with `fs.revokeReadURL` (an app may revoke links it created) so the next request gets a fresh one.

Why not stream through the worker: the worker would hold whole files in memory (no ranged reads from `fs.read`), pay for every byte twice, and a `<video>` element cannot send the worker's auth headers.

Range requests: Puter's `/token-read` handler (read in Puter's public source, `LegacyFSController.tokenRead`) forwards to the same reader as `/read`, passes the `Range` header to the file service, answers 206 with `Content-Range`, and sets the file's real MIME type with `Content-Disposition: inline`. So the browser can start playback before the download finishes and seek in large files. This was **not tried against a real Puter account**. In the harness a service worker answers fake read links from IndexedDB with the same token checks and Range handling; Chrome requested `bytes=0-` and played and seeked the 206 responses.

What a link does and does not protect: anyone holding a link can fetch that one video until it expires or is revoked; it grants nothing else. A removed person loses comments and new links at once; links they already hold stop working when revocation succeeds, otherwise within 4 hours.

## Limits (enforced by the worker)

Comment text up to 2000 characters; 12 comments a minute per person per review; ranges up to 10 minutes and inside the video; 20,000 comment changes, 50 versions, 200 people and 50 invite links per review; 10 failed joins per person per 10 minutes; review videos up to 4 GB; request bodies up to 64 KB.

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
