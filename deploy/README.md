# Self-hosting with Docker

Reference container layout for serving built Everything apps (Vite `dist/`) behind nginx, with cache and wasm headers aligned to root `customHttp.yml`.

## Quick start

From the repository root (Docker 24+ with Compose v2):

```sh
docker compose up -d --build documents spreadsheet
```

| Service       | URL                         |
|---------------|-----------------------------|
| documents     | http://localhost:8081/      |
| spreadsheet   | http://localhost:8082/      |
| chess         | http://localhost:8083/      |
| parametric    | http://localhost:8084/      |

Build a single app image without Compose:

```sh
docker build -f deploy/Dockerfile \
  --build-arg APP_DIR=src/documents \
  --build-arg NGINX_PROFILE=default \
  -t everything-documents .
docker run --rm -p 8081:8080 everything-documents
```

## Layout

| Path | Role |
|------|------|
| `deploy/Dockerfile` | Multi-stage: Node 22 build → unprivileged nginx on `:8080` |
| `deploy/nginx/app.conf` | HTML/`sw.js`/`manifest.json`/`worker/` no-cache; `/assets/*` immutable; `.wasm` → `application/wasm` |
| `deploy/nginx/profiles/*.inc` | Optional headers (`default`, `chess` CSP set) |
| `docker-compose.yml` | Reference services for documents, spreadsheet, chess, parametric |
| `.dockerignore` | Skips `node_modules`, `dist`, `.git`, etc. |

## Adding another app

1. Copy a service in `docker-compose.yml`.
2. Set `APP_DIR: src/<app>` and a free host port.
3. Use `NGINX_PROFILE: chess` only when you need that CSP; otherwise `default`.
4. Rebuild: `docker compose up -d --build <service>`.

Apps that import `../../dev/puter-localhost.mjs` (or other repo-root paths) need the **repository root** as the build context — the Dockerfile already does that.

## Limitations

- **Workers** (`build:worker` / Cloudflare email workers for documents, spreadsheet, teamchat, …) are built into static assets when the app’s `npm run build` does so; live `wrangler` / `workerd` processes are not started by Compose.
- **Puter SDK** still loads from `https://js.puter.com` / `api.puter.com` unless you change the app. Board-game CSPs allow those origins.
- Path-based reverse proxying (`/documents/` on one port) is not configured: Vite `base` and absolute `/assets/` URLs are simplest with **one port per app** (as in Compose).
- Building `documents` / `spreadsheet` downloads full dependency trees and can take several minutes per image.

## License

Same as the repository root (per-app licenses still apply under `src/<app>/LICENSE`).
