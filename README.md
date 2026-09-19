# UnifyRAW

**Photo library and RAW editor in the browser. Your sources, no cloud lock-in.**

UnifyRAW connects the photo sources you already have into one library and develops
RAW files right in the browser: rate, sort, edit non-destructively, export. Reachable
from any device with a browser, without Adobe's cloud in the background.

- Website: https://unifyraw.com
- App (hosted, currently free): https://app.unifyraw.com
- Licence: [GNU AGPL v3](LICENSE) (`AGPL-3.0-only`)

Technically it is a React SPA with an optional Express backend, source types
governed by [one capability table](src/sources/capabilities.ts), a graph-based
WebGL editor with layers, and optional multi-device edit sync.

## Status

UnifyRAW is a one-person project in an early test phase (alpha).

| Area | Status |
|---|---|
| Sources | Local folders, Immich and Lychee are available; WebDAV and server-side libraries only with the self-hosted build. PhotoPrism, Nextcloud Photos, Synology Photos, Piwigo, LibrePhotos and others are planned. |
| Editor | Basic, white balance, presence, tone curve, levels, HSL / colour editor, colour grading, sharpening, denoise (incl. in-browser AI models), B&W mixer, vignette, grain, lens correction, geometry, masks, layers, presets. |
| RAW | LibRaw compiled to WebAssembly, linear 16-bit-capable WebGL pipeline, HEIC support. |
| Devices | Optional sync of edits, ratings and collections between devices through a sync hub; optional end-to-end encryption. |
| Self-hosting | Docker Compose, with HTTPS for the home network included - see [Secure backend bootstrap](#secure-backend-bootstrap). |
| Price | Free: the hosted instance, and the software itself. |

## Privacy in one paragraph

Catalog, previews and edits live in your browser. Editing and rendering happen in the
browser with WebGL. Files from local folders never leave the browser. The hosted app has
no backend: for server sources such as Immich or Lychee, your browser talks to your
server directly. In the self-hosted build, your own UnifyRAW server can relay requests
that browser restrictions (CORS) would block, without keeping files, and may cache
downsized RAW previews for speed (can be disabled in the settings). The optional device
sync transfers parameters, never pictures. The full privacy policy is on the
[website](https://unifyraw.com/en-privacy.html).

## Issues and contributions

Bug reports, feature requests and questions are welcome as issues:

- [Report a bug](https://github.com/Burnie215/UnifyRAW/issues/new?template=bug_report.yml)
- [Request a feature or a new source](https://github.com/Burnie215/UnifyRAW/issues/new?template=feature_request.yml)
- Browse existing issues and upvote with a thumbs-up before opening a duplicate.

Deutsch ist genauso willkommen wie Englisch.

**Code contributions are not accepted.** UnifyRAW is open source, not open
contribution: pull requests will be closed without review, so that the code stays
under a single copyright holder. Ideas from issues are welcome and may well end up in
the code. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

```
┌────────────────────────────────┐       ┌─────────────────────────────┐
│ Frontend (React + Vite)        │ HTTPS │ Backend (Node + Express)     │
│ – CatalogStorage + repos       │ ─────►│ – sql.js / SQLite            │
│   (Memory / Folder / OPFS)     │       │ – /api/proxy + /api/files   │
│ – append-only thumbnail bins   │       │ – /api/raw + /api/libraries │
│ – capabilities + SourceManager │       │ – /api/sync + /api/auth     │
│ – SyncedStorage (LWW)          │       └─────────────────────────────┘
│ – documentGraph → render worker│                      ▲
└────────────────────────────────┘                      │ via Sync-Hub
                                            ┌───────────┴──────────┐
                                            │ Sync-Hub (SYNC_ONLY) │
                                            │ own address          │
                                            │ per-user isolation   │
                                            └──────────────────────┘
```

### Catalog storage layout

A persistent folder-backed catalog has this fixed structure:

```
~/photolib/
├── catalog.sqlite                — structured data (sources, photos, edits, …)
├── thumbs/
│   ├── small/{00..ff}.bin        — encoded source or generated thumbnails
│   └── large/{00..ff}.bin        — reserved large-preview namespace
└── version.json                  — schema version + last open
```

`catalog.sqlite` schema lives in [packages/shared/src/catalog-schema.sql](packages/shared/src/catalog-schema.sql)
(mirror as TypeScript constant in [catalog-schema.ts](packages/shared/src/catalog-schema.ts)).

Three transports:
- `MemoryStorage` — sql.js in-RAM, `exportDb()` for snapshot download
- `FolderStorage` — one class, two roots: File System Access API folder, or OPFS
- Thumb-bin format: `[uint32-BE length][encoded-image-bytes…]`, append-only.
  Source-supplied blobs retain their format and dimensions.

Sync is optional: `SyncedStorage` wraps any `CatalogStorage` and runs LWW two-way
delta sync against `/api/sync/*` (sources/photos/photoMeta/edits/presets/
developProfiles/lensProfiles/collections).
Per-table watermarks live in `schema_meta` so they travel with the catalog folder.

The full backend protects `/api/proxy`, `/api/files`, `/api/raw`, and
`/api/libraries` with administrator authorization. Ordinary sync accounts use
only `/api/auth`, `/api/sync`, and browser-direct sources.

### Integrated libraries (backend foundation)

The backend can register server-side libraries without exposing absolute host
paths to the browser. An external library indexes existing files read-only; a
managed library receives a dedicated directory below the PhotoLib data root.
The source configuration sent to the frontend contains a `libraryId`, not a
server URL or filesystem path.

```sh
PHOTOLIB_LIBRARY_ROOTS=/photos,/archive
PHOTOLIB_MANAGED_ROOT=/data/library
PHOTOLIB_THUMB_ROOT=/data/thumbs
PHOTOLIB_SCAN_CONCURRENCY=2
PHOTOLIB_MAX_IMPORT_BYTES=0
```

External mounts should normally be mounted read-only. `ALLOWED_ROOTS` remains
the compatibility setting for the legacy `/api/files` source; when
`PHOTOLIB_LIBRARY_ROOTS` is omitted it is also used as the integrated-library
fallback.

`PHOTOLIB_MAX_IMPORT_BYTES=0` disables the additional per-file application
limit. Imports are streamed into `.incoming`, checked against available disk
space and their declared size, validated as supported image content, hashed
with SHA-256, and only then atomically committed to managed storage.

See [docs/integrated-libraries.md](docs/integrated-libraries.md) for mode
semantics, trash/restore, integrity checks, API groups, and backup/restore.

### Build and run

#### Local dev
```sh
npm install
npm run dev                    # vite, port 5173
npm run dev:backend            # backend on 3001, explicitly disables auth
npm run dev:all                # frontend + local development backend
npm test                       # vitest
```

#### Secure backend bootstrap

Hosted and sync-only deployments require authentication by default. Copy
`.env.example` to `.env`, generate a persistent `AUTH_SECRET`, and provide the
administrator credentials for the first startup. Then pick one of the two
compose files:

- `docker-compose.yml` — for the home network, also by bare IP address. Caddy
  sits in front and serves HTTPS with a certificate from its own authority;
  set `UNIFYRAW_HOST` in `.env` to the address the app is reached under.
- `docker-compose.proxy.yml` — behind a reverse proxy you already run. The app
  speaks plain HTTP on port 3000 and your proxy terminates TLS.

```sh
cp .env.example .env
openssl rand -hex 32                                        # -> AUTH_SECRET
docker compose up -d --build                                # with Caddy
docker compose -f docker-compose.proxy.yml up -d --build    # behind your proxy
```

Either way the browser has to reach the app over HTTPS, or over
`http://localhost` on the same machine: over `http://<ip>` browsers switch off
what the app needs to start (no secure context). With Caddy, other devices warn
until they trust its root certificate, which you can copy out with

```sh
docker compose cp https:/data/caddy/pki/authorities/local/root.crt ./unifyraw-root.crt
```

Keep the `caddy-data` volume: it holds that authority, and a new one means
installing a new root certificate on every device. How to trust it, per system:
[Running on your home network](#running-on-your-home-network).

`AUTH_BOOTSTRAP_USERNAME` and `AUTH_BOOTSTRAP_PASSWORD` are read only while the
users table is empty and may be removed after the administrator exists. Public
registration is disabled unless `AUTH_REGISTRATION_ENABLED=true`; ordinary
sync accounts can never access the global file, proxy, RAW, or integrated
library routes. Leave `CORS_ALLOWED_ORIGINS` empty for a same-origin web
deployment, or list exact trusted origins separated by commas.

Behind a reverse proxy, set `TRUST_PROXY` to the number of proxy hops in front
of the backend (`1` for Traefik or nginx, `2` for a Cloudflare tunnel plus
Traefik); `docker-compose.yml` sets it to `1` for its own Caddy. Otherwise every client appears with the proxy's address and all users
share one login rate limit; the backend logs a warning once when it sees
`X-Forwarded-For` without it. Failed logins are limited per username (10 in
15 minutes) and per client address (50 in 15 minutes). `TRUST_PROXY=true` is
refused at startup with a message naming the hop count: it would mean trusting
the whole forwarded chain, so any client could claim someone else's address.
`false`, `off` and `no` are the same as `0`.

The container runs as uid 1000 (`node`) with every capability dropped, without
new privileges and with a read-only root filesystem; writable are the `/data`
volume, a `/tmp` tmpfs and `/dev/shm`. A `/data` volume that an older root
container created needs one chown before the first start, otherwise the
backend cannot open its database:

```sh
docker compose run --rm --user root photolib chown -R node:node /data
# behind your own proxy: docker compose -f docker-compose.proxy.yml run ...
```

Photo directories mounted under `/photos` have to be readable for uid 1000.

Local infrastructure — LAN resolvers, a search domain, extra mounts — belongs
in `docker-compose.override.yml`. The file is gitignored and `docker compose`
merges it into `docker-compose.yml` automatically; with the proxy variant name
it as well (`-f docker-compose.proxy.yml -f docker-compose.override.yml`):

```yaml
services:
  photolib:
    dns:
      - 192.168.1.10
    dns_search:
      - home.arpa
```

The backend resolves the target of every proxy and RAW request inside the
container. Without a resolver that knows your LAN names, server-routed sources
fail with a DNS error while the same name works in your browser.

For server-routed LAN sources, prefer an exact hostname allowlist, for example
`PROXY_ALLOWED_PRIVATE_HOSTS=immich.home.arpa,nas.internal`. If remote RAW
fast-paths access the same source, add it independently to
`RAW_ALLOWED_PRIVATE_HOSTS`. Entries are comma-separated DNS hostnames without
schemes, ports, wildcards or IP literals. Matching is case-insensitive but
otherwise exact, so allowing `immich.home.arpa` does not allow its subdomains.

The legacy `PROXY_ALLOW_PRIVATE_TARGETS=true` and
`RAW_ALLOW_PRIVATE_FETCH=true` switches permit every RFC1918/ULA target for
their respective route and should remain false when an exact allowlist is
sufficient. DNS is validated by the lookup used for the socket connection and
every returned address must pass the policy. Redirects are not followed;
loopback, link-local, cloud metadata and reserved targets remain blocked in all
modes. Upload, upstream response and RAW decode queue limits are configurable
through the corresponding values in `.env.example`.

#### Running on your home network

With `docker-compose.yml`, UnifyRAW runs on a machine in your home network and
is reached from every device there by its IP address - no domain needed.

1. In `.env`, set `UNIFYRAW_HOST` to that machine's address, e.g. `192.168.1.50`.
2. `docker compose up -d --build`, then open `https://192.168.1.50` on any device.
3. The browser warns once ("Your connection is not private"). Continuing works:
   the app runs, only its service worker (the offline cache) stays off until
   the certificate is trusted. To get rid of the warning for good, trust
   Caddy's root certificate on each device, as below.

`http://192.168.1.50` does not work, and cannot be made to: browsers switch off
what the app needs to start on any unencrypted address except `localhost`.
Opened that way, UnifyRAW shows a page saying so instead of starting.

Copy the root certificate out of the container once:

```sh
docker compose cp https:/data/caddy/pki/authorities/local/root.crt ./unifyraw-root.crt
```

Then trust it on each device:

- **macOS** (Safari, Chrome, Edge):
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain unifyraw-root.crt`,
  or double-click the file, add it to the *System* keychain, open it and set
  *Trust > When using this certificate* to *Always Trust*.
- **Windows** (Chrome, Edge): in an administrator prompt
  `certutil -addstore -f Root unifyraw-root.crt`, or double-click the file,
  *Install Certificate*, *Local Machine*, *Trusted Root Certification Authorities*.
- **Linux, Chrome and other Chromium browsers**: they read their own NSS
  database, not the system store:
  `certutil -d sql:$HOME/.local/share/pki/nssdb -A -t "C,," -n UnifyRAW -i unifyraw-root.crt`
  (package `libnss3-tools`; if `~/.pki/nssdb` already exists, Chromium uses that
  one instead - use its path). Alternatively `chrome://settings/certificates`.
  Restart the browser afterwards.
- **Firefox** (every system): *Settings > Privacy & Security > Certificates >
  View Certificates > Authorities > Import*, and tick *Trust this CA to identify
  websites*.
- **iPhone and iPad**: send the file to the device (AirDrop, mail), install the
  profile under *Settings > Profile Downloaded*, then turn on full trust under
  *Settings > General > About > Certificate Trust Settings*. Without that second
  step the certificate is installed but not trusted.
- **Android**: *Settings > Security > Encryption & credentials > Install a
  certificate > CA certificate* (names vary by manufacturer). Chrome trusts
  certificates installed there; many other apps do not.

The certificate authority lives in the `caddy-data` volume. As long as that
volume exists, every device has to do this only once.

#### Running the sync hub on its own

`SYNC_ONLY=true` turns the full backend into a hub that serves `/api/auth` and
`/api/sync` and nothing else. When the hub gets its own machine and its own
address, build it from its own image instead:

```sh
cp .env.hub.example .env.hub
openssl rand -hex 32                      # -> AUTH_SECRET
docker compose -f docker-compose.hub.yml --env-file .env.hub up -d --build
```

`Dockerfile.hub` produces the same code with a different payload: no frontend
bundle, no `dcraw_emu`, no `exiftool`, no `/photos` volume, and `SYNC_ONLY=true`
baked into the image rather than supplied by the compose file. Running the hub
from the full image with `SYNC_ONLY=true` in the environment still works and
behaves identically; the separate image exists so that the defaults do not
describe capabilities the hub does not have. Note that `SYNC_ONLY` is compared
strictly against `"true"` — `SYNC_ONLY=1` silently yields the full backend.

`CORS_ALLOWED_ORIGINS` is required here, not optional. A hub on its own address
is by definition called cross-origin, and the login request carries
`Content-Type: application/json`, so the browser sends a preflight first. Without
the list the hub answers without CORS headers, the preflight is discarded, and
the app cannot tell a missing entry from an unreachable host — both surface as
the same `TypeError`. List exact origins, comma-separated; `*` is refused at
startup.

**A standalone hub has to be reachable from the public internet.** This is a
requirement, not a recommendation. Chromium enforces Private Network Access: a
page served from a public address may not open a connection into a private one,
whatever CORS says. A hub on `192.168.x.x`, or behind a split-horizon DNS name
that resolves to one, is therefore unreachable from an app on a public domain —
and the failure looks exactly like the CORS failure above, so it is easy to
misread as a configuration mistake. A valid TLS certificate does not help; the
restriction is about the address space, not the transport.

So a standalone hub needs a public DNS name and a way in — a reverse proxy with
a certificate, or a tunnel. Keeping app and hub on one private network is the
other way to satisfy the browser, but that is the full self-hosted build, where
they already share one origin and need neither CORS nor a second address.

Accounts created on a hub have `role: 'user'` and can reach only `/api/auth` and
`/api/sync`; the file, proxy, RAW and library routes do not exist in this image.
That makes `AUTH_REGISTRATION_ENABLED=true` a real option here, unlike on a full
deployment. With registration disabled the administrator creates accounts
directly in the database — there is no user-management UI yet.

#### Denoise model

The AI denoise model is not part of the repository. Fetch it once before
building; the script verifies its SHA-256:

```sh
scripts/fetch-denoise-models.sh
```

## Conventions

- camelCase identifiers in DB columns + TS types (no SQL-side snake_case)
- `updatedAt` + `deletedAt` on every sync table; LWW resolution

## Further documentation

- [docs/integrated-libraries.md](docs/integrated-libraries.md) - server-side libraries
- [docs/source-capabilities.md](docs/source-capabilities.md) - what each source type can do
- [docs/CAPACITOR.md](docs/CAPACITOR.md) - the mobile shell (never run on a device yet)

## Licence

Copyright (C) 2026 Sebastian Bernhard

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, version 3 of the License (`AGPL-3.0-only`). It is distributed in the hope
that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the
full text.

If you run a modified version as a network service, the AGPL requires you to offer its
source code to the users of that service.

Third-party components and their licences: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md);
the denoise model: [public/models/denoise/MODEL_LICENSES.md](public/models/denoise/MODEL_LICENSES.md).

## Trademarks

Lightroom and Adobe are trademarks of Adobe Inc. Immich, Lychee and other products named
here are trademarks of their respective owners; they are mentioned only to describe
compatibility.
