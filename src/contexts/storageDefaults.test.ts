import { describe, expect, it } from 'vitest';
import { defaultSyncSettings } from './storageDefaults';

const APP_ORIGIN = 'https://app.unifyraw.com';
const BACKEND = 'https://photos.example.com';

describe('defaultSyncSettings', () => {
  it('offers its own origin in the selfhost build', () => {
    expect(defaultSyncSettings({ mode: 'hosted', backendUrl: '' }, APP_ORIGIN))
      .toEqual({ serverUrl: APP_ORIGIN });
  });

  it('pre-fills the hub with the server set under Settings', () => {
    expect(defaultSyncSettings({ mode: 'online', backendUrl: BACKEND }, APP_ORIGIN))
      .toEqual({ serverUrl: BACKEND });
  });

  it('offers nothing in the online build without a server', () => {
    expect(defaultSyncSettings({ mode: 'online', backendUrl: '' }, APP_ORIGIN)).toBeNull();
  });
});
