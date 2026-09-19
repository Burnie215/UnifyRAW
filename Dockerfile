FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/

# Install all workspace dependencies
RUN npm ci --workspace=packages/shared --workspace=packages/backend

# Copy source
COPY packages/shared packages/shared
COPY packages/backend packages/backend

# Build backend (tsc -b follows the project reference to ../shared)
WORKDIR /app/packages/backend
RUN npx tsc -b

# Install a separate production-only dependency tree. The final image must not
# inherit TypeScript, tsx or other backend build tooling from the build stage.
FROM node:20-alpine AS backend-runtime-deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN npm ci --omit=dev --workspace=packages/shared --workspace=packages/backend

# ─── Frontend build stage ───
FROM node:20-alpine AS frontend-build

WORKDIR /app
COPY . .
RUN npm ci
# build:selfhost sets VITE_MODE=hosted at build time. This replaces the inline
# script that used to be sed'ed into index.html: the online build cannot use
# one under the CSP (§P6), so both variants now decide at build time.
# Handed in by the deploy tooling so the bundle can name its own origin.
# Defaults keep a plain `docker build` working; the stamp then says "unknown".
ARG SOURCE_COMMIT=unknown
ARG SOURCE_DIRTY=0
# verify is the gate: lint, type-check including tests, node tests. A red tree
# does not build, and every deploy goes through this image build.
RUN npm run verify && npm run build:selfhost

# ─── Production ───
FROM node:20-alpine

WORKDIR /app

# Install RAW-decoding CLI. libraw-tools ships `dcraw_emu` from libraw 0.21+
# which handles X-Trans, modern Sony/Canon sensors etc. correctly.
# exiftool copies descriptive capture metadata (Make/Model, ISO, focal length,
# orientation) into smart-preview TIFFs; RAW calibration is already baked.
RUN apk add --no-cache libraw-tools exiftool

# Copy backend
COPY --from=build /app/packages/backend/dist ./backend
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=backend-runtime-deps /app/node_modules ./node_modules

# Copy frontend dist
COPY --from=frontend-build /app/dist ./frontend/dist

ENV MODE=hosted
ENV PORT=3000
ENV DB_PATH=/data/photolib.db
ENV ALLOWED_ROOTS=/photos

# dcraw_emu, exiftool and libvips parse files that a user-configured source
# delivers, so they must not run as root. node:20-alpine ships uid/gid 1000;
# /data is chowned here so a fresh volume inherits the ownership. This has to
# happen BEFORE the VOLUME line: docker discards changes to a declared volume
# path. A volume an older root container created needs one chown, see README.
RUN mkdir -p /data /photos && chown node:node /data

EXPOSE 3000
VOLUME ["/data", "/photos"]

USER node

CMD ["node", "backend/index.js"]
