/**
 * Which shell this bundle is running in, and by which route a finished file
 * leaves the app.
 *
 * The same `dist/` is served three ways: a browser tab, an Android WebView and
 * an iOS WKWebView (docs/CAPACITOR.md). Only the browser has an `<a download>`
 * that reaches something the user can find again; in a native WebView the same
 * click writes into the app sandbox, or does nothing at all, and the export is
 * gone. The native shells instead get the bytes written by
 * `@capacitor/filesystem` and handed on by `@capacitor/share`.
 *
 * This module decides the route and imports nothing. That is deliberate:
 *
 *  - It mirrors the detection of the installed `@capacitor/core`
 *    (`getPlatformId` / `isNativePlatform` in
 *    node_modules/@capacitor/core/dist/index.cjs.js): the bridge object is
 *    INJECTED by the native runtime, it is not something the bundle has to
 *    carry. Importing `@capacitor/core` to ask "am I native" would ship the
 *    runtime to every browser user in order to be told "no".
 *  - Without an import the decision runs in the `node` vitest project, with a
 *    plain object standing in for `window` - no React, no WebView, no plugin.
 *
 * The impure half - writing and sharing - lives in ./fileDelivery.ts and pulls
 * the plugins in through `await import()`, the way the rest of the repo defers
 * everything the web path does not need.
 */

/** The three shells a `deliverFile` call can find itself in. */
export type ShellPlatform = 'web' | 'ios' | 'android';

/** What a Capacitor WebView injects on `window`. All of it is optional. */
export interface ShellGlobal {
  Capacitor?: {
    getPlatform?: () => string;
    isPluginAvailable?: (name: string) => boolean;
  };
  /** Android bridge object, present only inside the Android WebView. */
  androidBridge?: unknown;
  /** iOS bridge, reached as `webkit.messageHandlers.bridge`. */
  webkit?: { messageHandlers?: { bridge?: unknown } };
}

/**
 * Names of the plugins whose absence changes the route. They are the strings
 * the native bridge registers under, not the npm package names.
 */
const FILESYSTEM_PLUGIN = 'Filesystem';
const SHARE_PLUGIN = 'Share';

function bridgePlatform(win: ShellGlobal): ShellPlatform {
  if (win.androidBridge) return 'android';
  if (win.webkit?.messageHandlers?.bridge) return 'ios';
  return 'web';
}

/**
 * The shell as the injected runtime reports it, falling back to the same
 * bridge sniffing `@capacitor/core` uses when no runtime answered.
 *
 * A platform name we have no file bridge for - a custom platform such as
 * Electron sets one - counts as `web`, because the browser route is exactly
 * what such a shell can still do.
 */
export function detectShellPlatform(win: ShellGlobal | null | undefined): ShellPlatform {
  if (!win) return 'web';

  const getPlatform = win.Capacitor?.getPlatform;
  if (typeof getPlatform === 'function') {
    let reported: string;
    try {
      reported = getPlatform();
    } catch {
      return bridgePlatform(win);
    }
    if (reported === 'android' || reported === 'ios') return reported;
    if (reported === 'web') return 'web';
    // Unknown platform name: the runtime is there but not one we can write
    // files on. Do not guess it is native.
    return 'web';
  }

  return bridgePlatform(win);
}

/** True when a native file bridge could exist at all. */
export function isNativeShell(win: ShellGlobal | null | undefined): boolean {
  return detectShellPlatform(win) !== 'web';
}

export interface ShellCapabilities {
  platform: ShellPlatform;
  /** `@capacitor/filesystem` answered for this platform. */
  filesystem: boolean;
  /** `@capacitor/share` answered for this platform. */
  share: boolean;
}

/**
 * What the shell can actually do, not what package.json declares. A native
 * build that was never `cap sync`ed has the packages in node_modules and no
 * plugin behind the bridge; asking the bridge is the only way to tell.
 *
 * When the runtime is native but too old to offer `isPluginAvailable`, the
 * plugins count as present: they are declared dependencies, and ./fileDelivery
 * falls back to the browser route if the call throws anyway. Guessing
 * "missing" there would send every such device down the route that loses the
 * file.
 */
export function readShellCapabilities(win: ShellGlobal | null | undefined): ShellCapabilities {
  const platform = detectShellPlatform(win);
  if (platform === 'web') return { platform, filesystem: false, share: false };

  const probe = win?.Capacitor?.isPluginAvailable;
  if (typeof probe !== 'function') return { platform, filesystem: true, share: true };

  const available = (name: string): boolean => {
    try {
      return probe(name) === true;
    } catch {
      return false;
    }
  };
  return {
    platform,
    filesystem: available(FILESYSTEM_PLUGIN),
    share: available(SHARE_PLUGIN),
  };
}

/**
 * - `web-download`: the existing `<a download>` click. Browsers, and any
 *   native shell that cannot write a file - a broken bridge should still
 *   produce the browser behaviour rather than an error dialog.
 * - `native-save`: write the file and report where it landed. Used when the
 *   filesystem plugin is there but the share sheet is not.
 * - `native-share`: write the file, then offer it to the system share sheet,
 *   which is the only way a phone user gets an export into Photos, Files,
 *   mail or a chat.
 */
export type DeliveryRoute = 'web-download' | 'native-save' | 'native-share';

/**
 * Where the file is written, as the plain `Directory` enum VALUE of
 * `@capacitor/filesystem` - a string, so this module keeps its no-import
 * promise and stays readable in a test assertion. ./fileDelivery maps it back
 * onto the enum after its dynamic import.
 */
export type DeliveryDirectory = 'CACHE' | 'DOCUMENTS';

export interface DeliveryPlan {
  route: DeliveryRoute;
  /** Absent exactly when the route is `web-download`. */
  directory?: DeliveryDirectory;
}

/**
 * The whole routing table, over capabilities alone so a test can state every
 * row without a WebView.
 *
 * A shared file goes to `CACHE`: the share sheet copies it wherever the user
 * picks, and leaving the source copy in a directory the OS may reclaim is the
 * point. A file that is only saved goes to `DOCUMENTS`, which is the directory
 * a user can reach later - on iOS through the Files app, on Android through
 * the documents provider.
 */
export function chooseDeliveryRoute(capabilities: ShellCapabilities): DeliveryPlan {
  if (capabilities.platform === 'web') return { route: 'web-download' };
  if (!capabilities.filesystem) return { route: 'web-download' };
  if (!capabilities.share) return { route: 'native-save', directory: 'DOCUMENTS' };
  return { route: 'native-share', directory: 'CACHE' };
}

/** Detection and routing in one step - what ./fileDelivery calls. */
export function planFileDelivery(win: ShellGlobal | null | undefined): DeliveryPlan {
  return chooseDeliveryRoute(readShellCapabilities(win));
}
