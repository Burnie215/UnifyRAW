# UnifyRAW on iOS / Android (Capacitor)

This document covers the native iOS and Android wrappers around the existing
React/Vite codebase. The web build is unchanged - the same `dist/` output goes
into web hosting and into both mobile wrappers.

**Read the honesty section first**: everything below is either marked as
verified on the Linux dev container, or marked as unverified because no JDK,
no Android SDK, no Xcode and no CocoaPods exist here. Nothing in this repo has
ever run on a phone.

## What's in the repo

- `@capacitor/core` + `@capacitor/cli` + the platform packages (`ios`,
  `android`) and the plugins `filesystem`, `preferences`, `share`, all at
  Capacitor 7, declared in `package.json`.
- `capacitor.config.ts` at the project root - bundle-id `de.beseb.photolib`,
  webDir `dist`. It is type-checked by `tsconfig.node.json`, so a key the
  installed `CapacitorConfig` does not know fails `npm run verify`.
- `vite.config.ts` builds with `base: './'` so the bundle works under
  `capacitor://localhost/`.
- `src/platform/nativeShell.ts` + `src/platform/fileDelivery.ts` - the one seam
  between browser and native shell, described below.
- `src/platform/config.ts` exports `getBackendUrl()` / `setBackendUrl()` that
  persist into `localStorage`. The mobile app needs a backend URL set
  (Settings -> Data -> Storage -> Server); the web build leaves it empty for
  same-origin fetches.
- **No `android/` and no `ios/` directory.** Both are generated, and the
  decision to commit them or regenerate them is open - see
  "Platform directories" below.

## The config, and why it drifted

`capacitor.config.ts` carried `bundledWebRuntime: false` until 2026-09-13. That
key was a Capacitor 4 option and was dropped with Capacitor 5; it does not
appear anywhere in the installed packages:

```sh
grep -rl bundledWebRuntime node_modules/@capacitor/   # no hits
```

`CapacitorConfig` in `node_modules/@capacitor/cli/dist/declarations.d.ts`
(7.6.5) knows exactly: `appId`, `appName`, `webDir`, `loggingBehavior`,
`overrideUserAgent`, `appendUserAgent`, `backgroundColor`, `zoomEnabled`,
`initialFocus`, `android`, `ios`, `server`, `cordova`, `plugins`,
`includePlugins`, `CapacitorCookies`, `CapacitorHttp`.

Nothing caught it, because no `tsconfig` included the file: `tsconfig.app.json`
covers `src`, `tsconfig.node.json` covered only `vite.config.ts`. The file is
now in `tsconfig.node.json`, and a removed key reads as
`error TS2353: Object literal may only specify known properties` in
`npm run typecheck`. That is the guard, not a comment.

One open question is left in the config: `server.allowNavigation` lists
`app.unifyraw.com`, the hosted instance. `allowNavigation` controls which hosts the
WebView may *navigate* to and still treat as app content. It has nothing to do
with backend traffic, which is `fetch`/XHR and is governed by CORS, and no code
in `src/` navigates to those hosts - the only outbound `window.open` is the
OAuth popup in `src/platform/oauth.ts`, which goes to the identity provider.
The list is most likely removable; it is kept until someone with a device can
confirm that.

## How a file leaves the app

A browser downloads with `<a download>`. Inside a WebView the same click writes
into the app sandbox, or silently does nothing - the user's export is gone.
Every export therefore goes through one seam:

| File | Role |
|---|---|
| `src/platform/nativeShell.ts` | Pure. Detects the shell and chooses the route. Imports nothing - not React, not Capacitor. |
| `src/platform/fileDelivery.ts` | Executes the chosen route. The only file in `src/` that names `@capacitor/*`, and only inside `await import()`. |

Detection mirrors `@capacitor/core`'s own `getPlatformId`
(`node_modules/@capacitor/core/dist/index.cjs.js`): the `Capacitor` object is
injected by the native runtime, so asking it costs a browser nothing. Importing
`@capacitor/core` to ask "am I native" would ship the runtime to every web user
in order to be told "no".

The routing table (`chooseDeliveryRoute`), over capabilities the bridge
reports, not over what `package.json` declares:

| Shell | Filesystem plugin | Share plugin | Route | Directory |
|---|---|---|---|---|
| web | - | - | `web-download` | - |
| ios / android | no | any | `web-download` | - |
| ios / android | yes | no | `native-save` | `DOCUMENTS` |
| ios / android | yes | yes | `native-share` | `CACHE` |

A shared file goes to `CACHE` because the share sheet copies it wherever the
user picks. A file that is only saved goes to `DOCUMENTS`, the directory a user
can reach again (Files app on iOS, documents provider on Android). Any native
failure - refused write, dismissed share sheet, plugin that is not really
there - falls back to the browser download rather than losing the export; the
result then carries `fellBackFrom`.

Wired up:

- `src/App.tsx` - the exported image (replaces the former
  `downloadBlob` in `src/engine/Exporter.ts`, which moved into
  `fileDelivery.ts` as `downloadBlobViaAnchor`).
- `src/data/xmp.ts` - `downloadXMP`, now async, so the sidecar travels the same
  way as its image.

Deliberately not wired: `SidecarStoreV2.exportIndex` / `exportThumbBin`. They
are the Safari fallback of the folder-backed source, which needs
`window.showDirectoryPicker()` - unavailable in a mobile WebView, so that whole
path is unreachable there anyway.

Cost to know about: `@capacitor/filesystem` takes binary content as a **base64
string**, so a native write peaks at roughly 3x the blob in memory. A 60 MB
TIFF export is worth watching on a phone. That is the plugin's contract, not a
choice in `fileDelivery.ts`.

Tests: `src/platform/nativeShell.test.ts` (every row of the table, the
detection fallbacks) and `src/platform/fileDelivery.test.ts` (the routes with
mocked plugins, the fallbacks, base64 over a chunk boundary). Two of them are
guards rather than tests: the browser route must never call into a plugin, and
no file in `src/` may import `@capacitor/*` statically - a static import would
put the plugin runtime into the main chunk of every browser user.

Measured on the online build (`npm run build`, 2026-09-13): the entry chunk
`dist/assets/index-*.js` contains no Capacitor code at all; `@capacitor/core`,
`filesystem` and `share` sit in separate chunks that only the native branch
ever requests.

## What was verified here, and what was not

Verified on the Linux dev container (no JDK, no Android SDK, no Xcode, no
CocoaPods):

- `npx cap add android` - succeeds. It only copies a template; no SDK needed.
- `npm run build && npx cap sync android` - succeeds, copies `dist/` into
  `android/app/src/main/assets/public` and reports
  `Found 3 Capacitor plugins for android: filesystem, preferences, share`.
- `npx cap add ios` - the project is created and the web assets are copied, but
  the log says `Skipping pod install because CocoaPods is not installed` and
  `Unable to find "xcodebuild"`. The result is therefore **incomplete**: no
  `Pods/`, no `Podfile.lock`, nothing that could open in Xcode.
- `npm run verify` - green with the seam in place.

Not verified, and not verifiable here:

- No compile of either platform. `./gradlew assembleDebug` needs a JDK and the
  Android SDK; `xcodebuild` needs macOS. `cap run` / `cap open` likewise.
- No plugin has ever executed. `Filesystem.writeFile` and `Share.share` are
  exercised against mocks; the real bridge, the real sandbox paths and the
  real share sheet are untested.
- Detection is tested against a hand-built `Capacitor` object, not against a
  runtime a WebView injected.
- Touch behaviour, HEIC decoding in the WebViews, the app icon, the splash
  screen, permissions and the store metadata are all untouched.

## Platform directories

`android/` and `ios/` are **not committed**. Both were generated here to prove
the commands work, then deleted: nothing on this machine can compile them, and
whether a Capacitor project commits its platform directories or regenerates
them is a standing project decision that belongs to a human with a device.

Regenerating is cheap:

```sh
npm install
npm run build          # webDir is dist/, so this has to come first
npx cap add android    # or: npx cap add ios   (Mac only, needs CocoaPods)
npx cap sync
```

If they are committed later, keep the `.gitignore` Capacitor writes into
`android/` - it already excludes the copied web assets
(`app/src/main/assets/public`) and the generated
`capacitor.config.json` / `capacitor.plugins.json`.

## First-time setup on a Mac / Windows dev machine

```sh
git clone <repo> unifyraw && cd unifyraw
npm install
npm run build           # produces dist/
```

### iOS (Mac only)

```sh
npx cap add ios
npx cap sync ios
npx cap open ios        # opens Xcode
```

Needs CocoaPods (`sudo gem install cocoapods` or `brew install cocoapods`);
`cap sync` skips `pod install` without it and the Xcode project will not
resolve its plugin dependencies. In Xcode: select your developer team, run on
simulator (Cmd-R) or device.

### Android (Mac, Windows, Linux)

```sh
npx cap add android
npx cap sync android
npx cap open android    # opens Android Studio
```

Needs JDK 21 and the Android SDK on `ANDROID_HOME` -
`node_modules/@capacitor/android/capacitor/build.gradle` pins
`JavaVersion.VERSION_21` and `compileSdk 35`. Or build from the CLI:
`cd android && ./gradlew assembleDebug`.

## Day-to-day loop

1. Edit React / TS in `src/`
2. `npm run build` (or run vite dev for browser testing)
3. `npx cap sync` - copies `dist/` into both platform projects
4. `npx cap run ios` / `npx cap run android` to install on a connected device

The web origin in the WebView is `capacitor://localhost`, so all relative
`/api/*` calls resolve there. Because the WebView ships no backend, configure
the backend URL under Settings -> Data -> Storage -> Server, or from the
WebView DevTools:
`localStorage.setItem('photolib.backendUrl','https://photos.example.com')`.

## Plugins used

| Plugin | Purpose | Wired up? |
|---|---|---|
| `@capacitor/filesystem` | Writes an export where the OS can pass it on | yes, `src/platform/fileDelivery.ts` |
| `@capacitor/share` | iOS/Android share sheet for exported images and sidecars | yes, `src/platform/fileDelivery.ts` |
| `@capacitor/preferences` | Persistent key/value store | no - nothing imports it; `localStorage` still holds the settings |

## App-Store distribution

### iOS
- Apple Developer Account (99 USD/yr)
- Configure signing in Xcode -> product -> archive -> distribute to App Store Connect
- App Store Connect: listing, screenshots (6.5", 5.5"), privacy manifest
- Review: typically 1-3 days

### Android
- Google Play Developer Account (25 USD one-time)
- `./gradlew bundleRelease` -> upload AAB to Play Console
- Reviews typically 1 day for new apps, hours for updates

## Known gaps (to be filled before users see it)

- **Nothing has run on a device.** See the verification section above.
- **Touch UX**: editor canvas pan/zoom and slider controls are still
  mouse-centric. Each editor tool needs pointer-event handlers plus
  pinch-to-zoom.
- **Auth flow**: `requireAuth` is on the backend but the mobile app has no
  login screen - needs a token-paste or username/password UI.
- **LocalSource**: uses `window.showDirectoryPicker()`, which mobile WebViews
  do not have. Needs a Capacitor-Filesystem-backed `DevicePhotoSource` for
  native photo-album access.
- **HEIF on iOS**: native WKWebView decodes HEIC natively, so libheif-js could
  be conditionally disabled there. Android WebView is unreliable - keep the
  WASM fallback for Android.
- **`@capacitor/preferences` is installed and unused.** Either give it a job or
  drop the dependency.
- **Memory**: the base64 detour of `Filesystem.writeFile` triples peak memory
  for large exports and has never been measured on a device.

## File map

- `capacitor.config.ts` - bundle ID, plugin config, navigation allowlist;
  type-checked through `tsconfig.node.json`
- `vite.config.ts` - `base: './'` for relative asset paths
- `src/platform/nativeShell.ts` - shell detection and the delivery routing table
- `src/platform/fileDelivery.ts` - executes a route; the only `@capacitor/*` importer
- `src/platform/config.ts` - `getBackendUrl()` / `setBackendUrl()`
- `ios/` - generated by `cap add ios`, not in git
- `android/` - generated by `cap add android`, not in git
