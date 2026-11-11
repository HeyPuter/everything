# Cloud Studio

Browser-local cloud primitives with a real management console: object storage, access keys, and an experimental function runtime. An open-source starting point inspired by workflows people know from Amazon S3 and AWS Lambda — **not** an AWS clone and **not** a claim of full API compatibility.

## What works in v0

- **Object storage** — create/list/delete buckets; put/get/delete/list objects; metadata; SHA-256 etags; prefix listing; continuation-token pagination; 16 MiB object cap
- **Access keys** — bootstrap admin key, create keys with permission strings, enforce authorization on every operation
- **Functions** — deploy JS handlers (`exports.handler`), invoke with JSON events, timeouts, structured logs
- **Console** — every button calls a real service method (no fabricated success states)

Persistence uses IndexedDB in the browser (and `fake-indexeddb` under Vitest).

## Non-goals / limitations

- Not wire-compatible with the AWS SDKs end-to-end
- Function sandbox is a constrained `AsyncFunction` for demos — **not** a hardened multi-tenant isolator (no network/DOM injection; still treat code as trusted)
- No VPC, IAM policy language, CloudWatch metrics product, or paid cloud provisioning
- Does not talk to real AWS unless you later add an optional adapter

## Development

Requires Node.js 22.12+.

```sh
npm install
npm run dev      # http://cloud-studio.puter.localhost:<port>/
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE).

## Related

Upstream proposal: HeyPuter/everything#106
