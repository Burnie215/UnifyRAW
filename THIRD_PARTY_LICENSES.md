# Third-Party Licenses

PhotoLib bundles or dynamically links several open-source libraries. This
file lists the components, their upstream sources, and license terms.

UnifyRAW itself (PhotoLib is its former name, still used in package and
storage names) is licensed under the GNU AGPL v3 (`AGPL-3.0-only`), see
[LICENSE](LICENSE). Where a component below is dual-licensed, UnifyRAW uses it
under the licence compatible with that: LibRaw under LGPL-2.1, not CDDL-1.0.

For distributed builds (e.g. the Docker image), please ship this file
alongside the binary, and keep the license texts of the libraries below
available — either bundled or via a URL pointing to the upstream project.

## RAW decoding

### LibRaw — backend native (`dcraw_emu`)

- **Used as:** native CLI shipped via Alpine `libraw-tools` package, invoked
  by `packages/backend/src/routes/raw.ts`
- **Upstream:** https://www.libraw.org/ — https://github.com/LibRaw/LibRaw
- **License:** LGPL-2.1 OR CDDL-1.0 (dual; you may pick either)
- **Distribution notes:**
  - Dynamically invoked as a subprocess. No code linkage with PhotoLib.
  - If you redistribute the Docker image (which bundles libraw), include
    the LGPL/CDDL text and a pointer to the libraw source.

### libraw-wasm — browser WASM port

- **Used as:** npm dependency, loaded dynamically in
  [src/engine/RawDecoder.ts](src/engine/RawDecoder.ts) (libraw-wasm strategy)
- **Upstream:** https://github.com/ybouane/libraw-wasm
- **License:** ISC (wrapper); bundled libraw remains LGPL-2.1/CDDL-1.0
- **Distribution notes:**
  - WASM blob is statically bundled into the frontend chunk.
  - Same LGPL/CDDL obligations as native libraw apply to the bundled
    binary. Source link: https://github.com/LibRaw/LibRaw

## HEIF/HEIC decoding

### libheif-js

- **Used as:** npm dependency, loaded dynamically in
  [src/engine/HeifDecoder.ts](src/engine/HeifDecoder.ts)
- **Upstream:** https://github.com/catdad-experiments/libheif-js, wrapping
  https://github.com/strukturag/libheif
- **License:** LGPL-3.0
- **Distribution notes:** dynamic linkage via JS, source link must be
  available. PhotoLib does not modify libheif.

## Image processing

### sharp — backend image resize / JPEG encode

- **Used as:** npm dependency in
  [packages/backend/src/routes/raw.ts](packages/backend/src/routes/raw.ts),
  [packages/backend/src/routes/files.ts](packages/backend/src/routes/files.ts),
  [packages/backend/src/libraries/library.scanner.ts](packages/backend/src/libraries/library.scanner.ts)
  and
  [packages/backend/src/libraries/library.thumbnails.ts](packages/backend/src/libraries/library.thumbnails.ts)
- **Upstream:** https://github.com/lovell/sharp
- **License:** Apache-2.0 — **for the JavaScript wrapper only.** The native
  library it loads is LGPL; see libvips below.
- **Distribution notes:** permissive; ship NOTICE file if you redistribute
  modified sharp binaries.

### libvips — native library underneath sharp

- **Used as:** prebuilt native binary that sharp pulls in as an optional
  platform package (`@img/sharp-libvips-<platform>`, plus the combined
  `@img/sharp-win32-*` and `@img/sharp-wasm32` builds). Never imported by
  PhotoLib code directly — every call goes through sharp's public API.
- **Upstream:** https://github.com/libvips/libvips
- **License:** **LGPL-3.0-or-later**
- **Distribution notes:**
  - A *production* dependency: it ships inside the Docker image, so the LGPL
    obligations in the summary below apply to every distributed build.
  - PhotoLib does not modify libvips.
  - Easy to miss: sharp's own `package.json` declares Apache-2.0, and the
    LGPL sits one level down in an optional platform package. Use the
    lockfile scan under "Other notable dependencies" rather than trusting a
    top-level license report.

## AI Denoise

### onnxruntime-web — neural-network inference

- **Used as:** npm dependency, loaded dynamically in
  [src/engine/ai/denoise/onnxRuntime.ts](src/engine/ai/denoise/onnxRuntime.ts).
- **Upstream:** https://github.com/microsoft/onnxruntime
- **License:** MIT (Microsoft Corporation)
- **Distribution notes:** Permissive; ship copyright + license text.
  The WASM/WebGPU shader assets are statically bundled into the frontend
  chunk and inherit the same MIT terms.

### SCUNet — denoise model weights (`scunet-psnr.v1.onnx`)

- **Used as:** runtime asset under
  [public/models/denoise/](public/models/denoise/) (fetched on demand,
  cached in user's browser OPFS — see
  [`MODEL_LICENSES.md`](public/models/denoise/MODEL_LICENSES.md) for the
  per-file record).
- **Upstream:** Zhang et al., *Practical Blind Denoising via Swin-Conv-UNet
  and Data Synthesis*, Machine Intelligence Research 2023 —
  https://github.com/cszn/SCUNet (weights `scunet_color_real_psnr`).
  ONNX export redistributed via
  https://huggingface.co/deepghs/image_restoration.
- **License:** Apache-2.0 (upstream cszn/SCUNet repository).
- **Distribution notes:**
  - Ship the Apache-2.0 NOTICE text when redistributing the weights.
  - Attribution required — credit Kai Zhang et al. in user-facing
    credits (already present in the About dialog).

## Other notable dependencies

The full dependency tree is in `package-lock.json`. The vast majority are
MIT or Apache-2.0 (React, Vite, Express, etc.). Some highlights:

- React — MIT
- Vite — MIT
- Express — MIT
- sql.js — MIT
- Dexie — Apache-2.0 (will be removed in upcoming phase)

Build-time only — never shipped to users, so no distribution obligation:

- lightningcss — MPL-2.0 (`devDependency`, part of the Vite CSS toolchain)

To regenerate a full report:

```sh
npx license-checker --production --csv > LICENSES.csv
```

A wrapper package's declared license does not always cover the native binary
it installs (sharp/libvips is exactly that case). To catch copyleft hiding in
optional platform packages, scan the lockfile directly — this lists shipped
dependencies only, skipping `devDependencies`:

```sh
node -e "const l=require('./package-lock.json');for(const[k,p]of Object.entries(l.packages||{}))if(!p.dev&&/GPL|MPL|CDDL|EPL|SSPL/i.test(p.license||''))console.log((p.license+'').padEnd(22),k)"
```

## License obligations summary

| License | Distribution-time obligation |
|---|---|
| LGPL-2.1 / LGPL-3.0(-or-later) | Provide source of the LGPL component (or upstream link). Allow replacement of the LGPL component in user's build. |
| CDDL-1.0 | Ship CDDL text. File-level changes require CDDL distribution. |
| Apache-2.0 | Ship NOTICE file if present. Patent grant. |
| ISC / MIT | Ship copyright + license text. |

PhotoLib itself does not redistribute modified versions of libraw, libheif,
libvips, or sharp. Linkage is dynamic (subprocess for dcraw_emu; JS module
loading for the WASM/JS libraries; sharp loads libvips itself at runtime).

Note that calling a library's C API directly is still use, not modification:
[src/engine/heif16.ts](src/engine/heif16.ts) drives libheif's exported C
functions instead of the JS wrapper, but the WASM build it calls is the
unmodified npm artifact, so the LGPL's modified-work clause does not apply.

LGPL/CDDL "must allow swap" requirement is satisfied because the bundled
WASM, the Docker image's `dcraw_emu` binary, and the `@img/sharp-libvips-*`
package can each be replaced.

## Referenced source code

### Immich v1.94.1 library management

- **Used as:** frozen architectural reference for PhotoLib's integrated
  library scanner and filesystem reconciliation. Any copied or substantially
  derived code must carry a file-level provenance notice.
- **Upstream:** https://github.com/immich-app/immich/tree/v1.94.1
- **Exact source:** tag `v1.94.1`, commit
  `07466fa7b7e3cc7696cd239db2507f1a08374fee`
- **License:** MIT, Copyright (c) 2022 Hau Tran
- **Bundled license:**
  [licenses/immich-v1.94.1-MIT.txt](licenses/immich-v1.94.1-MIT.txt)
- **Source boundary:** no Immich code or implementation details from v1.95 or
  any later revision may be copied or used as the basis for this feature.
