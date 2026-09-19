import { describe, expect, it } from 'vitest';
import {
  isMissingJavaScriptAsset,
  STALE_ASSET_RECOVERY_MODULE,
} from './stale-asset-recovery.js';

describe('stale asset recovery', () => {
  it('recognizes missing Vite JavaScript chunks only', () => {
    expect(isMissingJavaScriptAsset('/assets/PhotoEditor-old.js')).toBe(true);
    expect(isMissingJavaScriptAsset('/assets/worker-old.mjs')).toBe(true);
    expect(isMissingJavaScriptAsset('/assets/PhotoEditor-old.css')).toBe(false);
    expect(isMissingJavaScriptAsset('/api/assets/PhotoEditor-old.js')).toBe(false);
  });

  it('reloads once per cooldown and then rejects the stale import', () => {
    expect(STALE_ASSET_RECOVERY_MODULE).toContain('window.location.reload()');
    expect(STALE_ASSET_RECOVERY_MODULE).toContain('sessionStorage');
    expect(STALE_ASSET_RECOVERY_MODULE).toContain('10000');
    expect(STALE_ASSET_RECOVERY_MODULE).toContain('throw new Error');
  });
});
