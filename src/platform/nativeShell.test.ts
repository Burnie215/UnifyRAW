import { describe, expect, it } from 'vitest';
import {
  chooseDeliveryRoute,
  detectShellPlatform,
  isNativeShell,
  planFileDelivery,
  readShellCapabilities,
  type DeliveryPlan,
  type ShellCapabilities,
  type ShellGlobal,
} from './nativeShell';

/** A Capacitor runtime as the native bridge injects it. */
function nativeRuntime(
  platform: 'ios' | 'android' | 'web',
  plugins: readonly string[] = ['Filesystem', 'Share'],
): ShellGlobal {
  return {
    Capacitor: {
      getPlatform: () => platform,
      isPluginAvailable: (name) => plugins.includes(name),
    },
  };
}

describe('detectShellPlatform', () => {
  it('reads a plain browser tab as web', () => {
    expect(detectShellPlatform({})).toBe('web');
    expect(isNativeShell({})).toBe(false);
  });

  it('reads no window at all as web', () => {
    expect(detectShellPlatform(undefined)).toBe('web');
    expect(detectShellPlatform(null)).toBe('web');
  });

  it('believes the injected runtime over anything else', () => {
    expect(detectShellPlatform(nativeRuntime('ios'))).toBe('ios');
    expect(detectShellPlatform(nativeRuntime('android'))).toBe('android');
    expect(isNativeShell(nativeRuntime('android'))).toBe(true);
  });

  it('reads the Capacitor web runtime, which a PWA build also loads, as web', () => {
    expect(detectShellPlatform(nativeRuntime('web'))).toBe('web');
    expect(isNativeShell(nativeRuntime('web'))).toBe(false);
  });

  // Same bridge sniffing as @capacitor/core's getPlatformId, for the window
  // between WebView start and runtime injection.
  it('falls back to the bridge objects when no runtime answered yet', () => {
    expect(detectShellPlatform({ androidBridge: {} })).toBe('android');
    expect(detectShellPlatform({ webkit: { messageHandlers: { bridge: {} } } })).toBe('ios');
    expect(detectShellPlatform({ webkit: { messageHandlers: {} } })).toBe('web');
  });

  it('falls back to the bridge objects when the runtime throws', () => {
    const win: ShellGlobal = {
      Capacitor: { getPlatform: () => { throw new Error('bridge gone'); } },
      androidBridge: {},
    };
    expect(detectShellPlatform(win)).toBe('android');
  });

  // A custom platform (Electron sets one) has no file bridge we can use, so
  // it must not be mistaken for a phone.
  it('treats an unknown platform name as web rather than guessing native', () => {
    expect(detectShellPlatform(nativeRuntime('electron' as 'ios'))).toBe('web');
  });
});

describe('readShellCapabilities', () => {
  it('reports no plugins in a browser, whatever the page claims', () => {
    expect(readShellCapabilities({})).toEqual({ platform: 'web', filesystem: false, share: false });
    expect(readShellCapabilities(nativeRuntime('web'))).toEqual(
      { platform: 'web', filesystem: false, share: false },
    );
  });

  it('asks the bridge which plugins actually answered', () => {
    expect(readShellCapabilities(nativeRuntime('ios', ['Filesystem']))).toEqual(
      { platform: 'ios', filesystem: true, share: false },
    );
    expect(readShellCapabilities(nativeRuntime('android', []))).toEqual(
      { platform: 'android', filesystem: false, share: false },
    );
  });

  it('assumes the declared plugins when the runtime cannot be asked', () => {
    expect(readShellCapabilities({ Capacitor: { getPlatform: () => 'ios' } })).toEqual(
      { platform: 'ios', filesystem: true, share: true },
    );
    expect(readShellCapabilities({ androidBridge: {} })).toEqual(
      { platform: 'android', filesystem: true, share: true },
    );
  });

  it('counts a probe that throws as missing', () => {
    const win: ShellGlobal = {
      Capacitor: {
        getPlatform: () => 'android',
        isPluginAvailable: () => { throw new Error('no bridge'); },
      },
    };
    expect(readShellCapabilities(win)).toEqual(
      { platform: 'android', filesystem: false, share: false },
    );
  });
});

describe('chooseDeliveryRoute', () => {
  const rows: ReadonlyArray<readonly [ShellCapabilities, DeliveryPlan]> = [
    [{ platform: 'web', filesystem: false, share: false }, { route: 'web-download' }],
    // A browser that somehow reported plugins is still a browser.
    [{ platform: 'web', filesystem: true, share: true }, { route: 'web-download' }],
    // Native but no file bridge: the anchor is all that is left, and it beats
    // throwing at the user.
    [{ platform: 'ios', filesystem: false, share: true }, { route: 'web-download' }],
    [{ platform: 'android', filesystem: false, share: false }, { route: 'web-download' }],
    [{ platform: 'ios', filesystem: true, share: false }, { route: 'native-save', directory: 'DOCUMENTS' }],
    [{ platform: 'android', filesystem: true, share: false }, { route: 'native-save', directory: 'DOCUMENTS' }],
    [{ platform: 'ios', filesystem: true, share: true }, { route: 'native-share', directory: 'CACHE' }],
    [{ platform: 'android', filesystem: true, share: true }, { route: 'native-share', directory: 'CACHE' }],
  ];

  it.each(rows)('routes %o to %o', (capabilities, plan) => {
    expect(chooseDeliveryRoute(capabilities)).toEqual(plan);
  });

  it('names a directory exactly for the native routes', () => {
    for (const [capabilities, plan] of rows) {
      const hasDirectory = chooseDeliveryRoute(capabilities).directory !== undefined;
      expect(hasDirectory, JSON.stringify(capabilities)).toBe(plan.route !== 'web-download');
    }
  });
});

describe('planFileDelivery', () => {
  // The one guarantee the web build depends on: nothing about a browser tab
  // sends it down a native route.
  it('keeps a browser on the download route', () => {
    expect(planFileDelivery({})).toEqual({ route: 'web-download' });
    expect(planFileDelivery(undefined)).toEqual({ route: 'web-download' });
  });

  it('sends a fully equipped phone to the share sheet', () => {
    expect(planFileDelivery(nativeRuntime('ios'))).toEqual({ route: 'native-share', directory: 'CACHE' });
  });

  it('degrades a phone without the share plugin to a plain save', () => {
    expect(planFileDelivery(nativeRuntime('android', ['Filesystem']))).toEqual(
      { route: 'native-save', directory: 'DOCUMENTS' },
    );
  });
});
