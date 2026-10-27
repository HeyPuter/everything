# Parameterized multi-stage image for any Vite app under src/<name>.
# Build context must be the repository root so apps can import ../../dev/*.
#
#   docker build -f deploy/Dockerfile --build-arg APP_DIR=src/documents -t everything-documents .
#
# NGINX_PROFILE selects deploy/nginx/profiles/<name>.inc (default | chess).

ARG NODE_IMAGE=node:22-bookworm
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

FROM ${NODE_IMAGE} AS build
ARG APP_DIR=src/documents
WORKDIR /repo
COPY . .
WORKDIR /repo/${APP_DIR}
RUN test -f package.json \
  && npm ci \
  && npm run build \
  && test -d dist

FROM ${NGINX_IMAGE} AS runtime
ARG APP_DIR=src/documents
ARG NGINX_PROFILE=default
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx/app.conf /etc/nginx/conf.d/app.conf
COPY deploy/nginx/profiles/${NGINX_PROFILE}.inc /etc/nginx/conf.d/profile.inc
COPY --from=build /repo/${APP_DIR}/dist /usr/share/nginx/html
RUN chown -R nginx:nginx /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
