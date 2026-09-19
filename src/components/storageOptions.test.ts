import { describe, expect, it } from 'vitest';
import {
  activeStorageTier,
  folderStartupStep,
  folderTierAvailable,
  memoryCatalogOffered,
  multiDeviceAnswer,
  onboardingCopy,
  serverTierState,
  shouldAskForPersistence,
  storageCalloutKey,
  switchLeavesCatalogBehind,
} from './storageOptions';

const modern = { opfs: true, filesystem: true };
const firefoxLike = { opfs: true, filesystem: false };
const ancient = { opfs: false, filesystem: false };

describe('the in-memory catalog is not a choice any more', () => {
  it('is hidden wherever a durable catalog is possible', () => {
    expect(memoryCatalogOffered(modern, 'opfs')).toBe(false);
    expect(memoryCatalogOffered(modern, 'filesystem')).toBe(false);
    expect(memoryCatalogOffered(modern, null)).toBe(false);
    // Can only pick OPFS - still a durable catalog, so still no memory row.
    expect(memoryCatalogOffered(firefoxLike, null)).toBe(false);
  });

  it('is offered to a browser that has nothing else', () => {
    expect(memoryCatalogOffered(ancient, null)).toBe(true);
  });

  it('stays visible while a catalog is actually running in memory', () => {
    // Otherwise the state is invisible, and an invisible state cannot be left.
    expect(memoryCatalogOffered(modern, 'memory')).toBe(true);
    expect(memoryCatalogOffered(ancient, 'memory')).toBe(true);
  });
});

describe('the storage dialog says why it is there', () => {
  it('asks where the catalog should live only when that is the question', () => {
    expect(onboardingCopy('switch').heading).toBe('firstLaunch.headingSwitch');
  });

  it('opens on the missing folder when a folder went missing', () => {
    // "Where should your catalog live?" answers a question nobody asked here.
    expect(onboardingCopy('folder-lost')).toEqual({
      heading: 'firstLaunch.headingFolderLost',
      intro: 'firstLaunch.introFolderLost',
      multiDevice: true,
    });
  });

  it('spares the multi-device advice where no storage can be chosen', () => {
    // Nothing persists in that browser; syncing is not that user's problem.
    expect(onboardingCopy('no-durable-storage').multiDevice).toBe(false);
    expect(onboardingCopy('switch').multiDevice).toBe(true);
    expect(onboardingCopy('folder-lost').multiDevice).toBe(true);
  });

  it('opens on the browser when the browser is the problem', () => {
    expect(onboardingCopy('no-durable-storage')).toEqual({
      heading: 'firstLaunch.headingNoDurable',
      intro: 'firstLaunch.introNoDurable',
      multiDevice: false,
    });
  });
});

describe('the answer to "I use two devices"', () => {
  it('is the hub wherever one is configured', () => {
    expect(multiDeviceAnswer('https://photo.example.com')).toBe('hub');
  });

  it('is "you need a server" when none is - never a cloud folder', () => {
    // The online build defaults to no hub at all (defaultSyncSettings).
    expect(multiDeviceAnswer(null)).toBe('own-server');
    expect(multiDeviceAnswer(undefined)).toBe('own-server');
    expect(multiDeviceAnswer('')).toBe('own-server');
  });
});

describe('warning before a switch that leaves the catalog behind', () => {
  it('stays quiet when there is nothing to leave behind', () => {
    expect(switchLeavesCatalogBehind(null, 'opfs', 0)).toBe(false);
    expect(switchLeavesCatalogBehind('opfs', 'filesystem', 0)).toBe(false);
  });

  it('warns when a filled catalog is swapped for another store', () => {
    expect(switchLeavesCatalogBehind('opfs', 'filesystem', 120)).toBe(true);
    expect(switchLeavesCatalogBehind('filesystem', 'opfs', 1)).toBe(true);
    expect(switchLeavesCatalogBehind('memory', 'opfs', 3)).toBe(true);
  });

  it('says nothing about re-opening the store already open', () => {
    expect(switchLeavesCatalogBehind('opfs', 'opfs', 500)).toBe(false);
    expect(switchLeavesCatalogBehind('memory', 'memory', 500)).toBe(false);
  });

  it('warns on a second folder, because a second folder is a second catalog', () => {
    expect(switchLeavesCatalogBehind('filesystem', 'filesystem', 500)).toBe(true);
  });
});

describe('asking the browser to keep the catalog', () => {
  it('is asked for OPFS once there is something to lose', () => {
    expect(shouldAskForPersistence('opfs', 1, false)).toBe(true);
  });

  it('is not asked on an empty catalog', () => {
    // Firefox turns this into a permission prompt; on an empty library it
    // would cost a dialog and protect nothing.
    expect(shouldAskForPersistence('opfs', 0, false)).toBe(false);
  });

  it('is asked once, not on every load', () => {
    expect(shouldAskForPersistence('opfs', 900, true)).toBe(false);
  });

  it('is no business of a picked folder or of memory', () => {
    expect(shouldAskForPersistence('filesystem', 900, false)).toBe(false);
    expect(shouldAskForPersistence('memory', 900, false)).toBe(false);
    expect(shouldAskForPersistence(null, 900, false)).toBe(false);
  });
});

describe('the three tiers the first run offers', () => {
  it('opens on the choice itself, without the multi-device aside', () => {
    // The tiers say it themselves; a second sentence above them competes.
    expect(onboardingCopy('first-run')).toEqual({
      heading: 'firstLaunch.headingFirstRun',
      intro: 'firstLaunch.introFirstRun',
      multiDevice: false,
    });
  });

  it('offers a folder only where a folder can be picked', () => {
    expect(folderTierAvailable({ filesystem: true })).toBe(true);
    // Firefox and Safari ship OPFS and no directory picker.
    expect(folderTierAvailable({ filesystem: false })).toBe(false);
  });
});

describe('how far the server tier is set up', () => {
  it('has nothing to point at in a build without a hub', () => {
    expect(serverTierState(null)).toBe('needs-address');
    expect(serverTierState({})).toBe('needs-address');
  });

  it('needs a sign-in once an address is known', () => {
    // The selfhost build pre-fills its own origin and starts here.
    expect(serverTierState({ serverUrl: 'https://photo.example.com' })).toBe('needs-signin');
  });

  it('is ready only with an address and a token', () => {
    expect(serverTierState({ serverUrl: 'https://photo.example.com', token: 'jwt' })).toBe('ready');
  });
});

describe('which tier is running', () => {
  it('reads a picked folder as the folder tier', () => {
    expect(activeStorageTier('filesystem', null)).toBe('folder');
  });

  it('reads browser storage and memory alike as trial', () => {
    expect(activeStorageTier('opfs', null)).toBe('trial');
    expect(activeStorageTier('memory', null)).toBe('trial');
  });

  it('lets a signed-in hub win over the local store beneath it', () => {
    // That is where the work survives, and it is what the user picked.
    const signedIn = { serverUrl: 'https://photo.example.com', token: 'jwt' };
    expect(activeStorageTier('opfs', signedIn)).toBe('server');
    expect(activeStorageTier('filesystem', signedIn)).toBe('server');
  });

  it('does not count a hub that is only half configured', () => {
    expect(activeStorageTier('opfs', { serverUrl: 'https://photo.example.com' })).toBe('trial');
  });

  it('is nothing at all before a catalog is open', () => {
    expect(activeStorageTier(null, null)).toBe(null);
  });
});

describe('which sentence the storage tab shows', () => {
  it('follows the running tier', () => {
    expect(storageCalloutKey('trial', 'needs-address')).toBe('storage.calloutTrial');
    expect(storageCalloutKey('folder', 'needs-address')).toBe('storage.calloutFolder');
    expect(storageCalloutKey('server', 'ready')).toBe('storage.calloutServer');
  });

  it('names the half-finished server instead of calling it the trial tier', () => {
    // Somebody who just picked "my own server" must not read that they are
    // trying things out; the address is recorded, it just carries nothing yet.
    expect(storageCalloutKey('trial', 'needs-signin')).toBe('storage.calloutServerPending');
    expect(storageCalloutKey('folder', 'needs-signin')).toBe('storage.calloutServerPending');
  });

  it('says nothing before a catalog is open', () => {
    expect(storageCalloutKey(null, 'needs-address')).toBe(null);
  });
});

describe('opening a folder catalog on page load', () => {
  it('opens a folder the browser still grants', () => {
    expect(folderStartupStep(true, 'granted')).toBe('open');
  });

  it('asks through a button when the permission is due again, never by itself', () => {
    expect(folderStartupStep(true, 'prompt')).toBe('ask');
  });

  it('treats a refusal or a missing handle as a lost folder', () => {
    expect(folderStartupStep(true, 'denied')).toBe('lost');
    expect(folderStartupStep(false, 'granted')).toBe('lost');
  });

  it('opens without asking where the browser has no permission API', () => {
    expect(folderStartupStep(true, 'unsupported')).toBe('open');
  });
});
