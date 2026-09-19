# Online-Build: statische Web-App ohne Backend (ONLINE_MODE_PLAN §P7).
# Gegenstueck zum Dockerfile im Wurzelverzeichnis, das den Selfhost-Build
# samt Backend baut.

FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci
# Handed in by the deploy tooling so the bundle can name its own origin.
# Defaults keep a plain `docker build` working; the stamp then says "unknown".
ARG SOURCE_COMMIT=unknown
ARG SOURCE_DIRTY=0
# verify is the gate: lint, type-check including tests, node tests. A red tree
# does not build, and every deploy goes through this image build.
RUN npm run verify && npm run build:online

FROM nginx:alpine
COPY docker/online/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/online/security-headers.conf /etc/nginx/conf.d/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
