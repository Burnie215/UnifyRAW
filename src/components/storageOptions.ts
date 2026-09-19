import type { StorageKind } from '../storage/CatalogStorage';

/**
 * Whether the in-memory catalog is offered as a choice.
 *
 * It is not one any more. A catalog in RAM loses every rating, collection and
 * edit when the tab closes - the price is the user's work, not a few seconds
 * of decoding - so OPFS and a folder are the two real answers and the only
 * ones normally shown.
 *
 * Two cases keep it visible. A browser that can neither open OPFS nor pick a
 * folder has nothing else at all; hiding the row there would leave it without
 * a way in. And a catalog already running in memory has to stay on screen,
 * because a state nobody can see is a state nobody can leave.
 */
export function memoryCatalogOffered(
  caps: { opfs: boolean; filesystem: boolean },
  currentKind: StorageKind | null,
): boolean {
  if (currentKind === 'memory') return true;
  return !caps.opfs && !caps.filesystem;
}

/**
 * Why the storage dialog is on screen.
 *
 * It is no longer a first-launch dialog: a browser with OPFS opens the
 * default catalog without asking, so the only ways here are a deliberate
 * switch, a folder the browser can no longer reach, and a browser that has no
 * durable storage to default to. Those are three different conversations, and
 * asking "where should your catalog live?" of someone whose folder just
 * vanished answers a question they did not ask.
 */
export type OnboardingReason = 'first-run' | 'switch' | 'folder-lost' | 'no-durable-storage';

export interface OnboardingCopy {
  heading: string;
  intro: string;
  /**
   * Whether the multi-device line belongs here. It does wherever the dialog
   * ends in picking a place for the catalog, because that is where the cloud
   * folder tempts. It does not where the browser can store nothing at all:
   * that user has no choice to inform, and syncing is not their problem.
   */
  multiDevice: boolean;
}

/** The i18n keys the storage dialog opens with, per reason. */
export function onboardingCopy(reason: OnboardingReason): OnboardingCopy {
  if (reason === 'first-run') {
    return {
      heading: 'firstLaunch.headingFirstRun',
      intro: 'firstLaunch.introFirstRun',
      // The three tiers say the multi-device answer themselves.
      multiDevice: false,
    };
  }
  if (reason === 'folder-lost') {
    return {
      heading: 'firstLaunch.headingFolderLost',
      intro: 'firstLaunch.introFolderLost',
      multiDevice: true,
    };
  }
  if (reason === 'no-durable-storage') {
    return {
      heading: 'firstLaunch.headingNoDurable',
      intro: 'firstLaunch.introNoDurable',
      multiDevice: false,
    };
  }
  return {
    heading: 'firstLaunch.headingSwitch',
    intro: 'firstLaunch.introSwitch',
    multiDevice: true,
  };
}

/**
 * What to tell someone who uses two devices.
 *
 * A hub keeps ratings, collections and edits in step per row. A catalog in a
 * cloud folder does not: every flush rewrites the whole catalog.sqlite
 * (FolderStorage), and the lock that guards it is a Web Lock, which reaches no
 * further than one browser - so the second device does not merge, it
 * overwrites. Where a hub address is known the answer is "sign in"; where none
 * is, it is "you need a server", and never the cloud folder.
 */
export function multiDeviceAnswer(syncServerUrl: string | null | undefined): 'hub' | 'own-server' {
  return syncServerUrl ? 'hub' : 'own-server';
}

/**
 * Whether switching to `target` leaves the open catalog's content behind.
 *
 * Nothing is copied between storages: opening a folder builds a fresh catalog
 * inside it, and the ratings and edits made so far stay where they were. They
 * are not lost - switching back finds them - but a library that comes up empty
 * reads as data loss, so the user gets told before, not after.
 *
 * An empty catalog is worth no warning. Neither is re-opening OPFS or memory,
 * which is the same store either way; picking a folder is asked even when one
 * is already open, because a second folder is a second catalog.
 */
export function switchLeavesCatalogBehind(
  currentKind: StorageKind | null,
  target: StorageKind,
  photoCount: number,
): boolean {
  if (currentKind === null || photoCount <= 0) return false;
  if (currentKind === target && target !== 'filesystem') return false;
  return true;
}

/**
 * Whether to ask the browser to keep this catalog for good.
 *
 * OPFS is best-effort storage until somebody asks otherwise: browsers evict it
 * under storage pressure, and WebKit drops script-written storage after seven
 * days without a visit. navigator.storage.persist() is the documented way out,
 * and Firefox turns it into a permission prompt - which is why it is not asked
 * on an empty catalog, where the answer costs the user a dialog and protects
 * nothing. A picked folder is a real file on a real disk and no business of
 * the quota system; memory is gone at tab close whatever anyone grants.
 */
export function shouldAskForPersistence(
  currentKind: StorageKind | null,
  photoCount: number,
  askedBefore: boolean,
): boolean {
  if (currentKind !== 'opfs' || askedBefore) return false;
  return photoCount > 0;
}

/**
 * The three answers the storage dialog offers, in the order of what they cost
 * the user and what they are worth.
 *
 * `trial` is the browser's own storage: nothing to set up, and the browser may
 * clear it whenever it likes. `folder` is a directory the user picks: visible
 * in the file manager and backed up with everything else there. `server` adds
 * the user's own hub, which is the only one of the three that reaches a second
 * device.
 *
 * They are not three mutually exclusive stores - a hub always has a local
 * catalog underneath it - but they are three different answers to "where does
 * my work live", which is the question being asked.
 */
export type StorageTier = 'trial' | 'folder' | 'server';

/**
 * Whether a folder can be picked at all.
 *
 * Only Chromium-based browsers ship the directory picker; Firefox and Safari
 * expose the origin private file system and nothing else. The tier stays on
 * screen where it is impossible, greyed out and with the reason spelled out -
 * a missing option teaches nothing, a disabled one with a reason does.
 */
export function folderTierAvailable(caps: { filesystem: boolean }): boolean {
  return caps.filesystem;
}

/** What the server tier still needs before it can carry anything. */
export type ServerTierState = 'ready' | 'needs-signin' | 'needs-address';

/**
 * How far the hub is already set up.
 *
 * The selfhost build pre-fills its own origin (defaultSyncSettings), so there
 * it starts at `needs-signin`; the online build has no hub to offer and starts
 * at `needs-address`. Saying which of the two it is keeps the tier from
 * looking like a button that does nothing.
 */
export function serverTierState(sync: { serverUrl?: string; token?: string } | null): ServerTierState {
  if (!sync?.serverUrl) return 'needs-address';
  return sync.token ? 'ready' : 'needs-signin';
}

/**
 * Which tier describes the storage that is running.
 *
 * A signed-in hub wins over the local store beneath it: that is where the work
 * actually survives, and it is what the user chose. Everything else is read off
 * the local catalog, and memory counts as trial storage - more so than OPFS.
 */
export function activeStorageTier(
  currentKind: StorageKind | null,
  sync: { serverUrl?: string; token?: string } | null,
): StorageTier | null {
  if (serverTierState(sync) === 'ready') return 'server';
  if (currentKind === null) return null;
  return currentKind === 'filesystem' ? 'folder' : 'trial';
}

/**
 * Which sentence describes the arrangement in the storage tab.
 *
 * Mostly it follows the running tier, with one exception worth its own line: a
 * server whose address is set but which nobody has signed in to yet. Nothing
 * syncs in that state, so the tier is still the local one - but telling
 * somebody who just picked "my own server" that they are on the trial tier
 * reads as if the choice had been thrown away. The pending state says both:
 * the choice is recorded, and it does not carry anything yet.
 */
export function storageCalloutKey(
  tier: StorageTier | null,
  serverState: ServerTierState,
): string | null {
  if (tier === null) return null;
  if (tier !== 'server' && serverState === 'needs-signin') return 'storage.calloutServerPending';
  if (tier === 'server') return 'storage.calloutServer';
  return tier === 'folder' ? 'storage.calloutFolder' : 'storage.calloutTrial';
}

/**
 * What the page load does with a catalog kept in a picked folder.
 *
 * It only asks the browser, never the user: `requestPermission` needs a click
 * (transient user activation), and on page load there is none. Calling it
 * anyway failed with "User activation is required to request permissions",
 * and the splash showed that error with no way out. A folder whose permission
 * is merely due again (`prompt`, the normal state after a browser restart) is
 * therefore handed to a button; only a missing handle or a refusal is a lost
 * folder.
 */
export type FolderStartupStep = 'open' | 'ask' | 'lost';

export function folderStartupStep(
  hasHandle: boolean,
  permission: PermissionState | 'unsupported',
): FolderStartupStep {
  if (!hasHandle) return 'lost';
  if (permission === 'granted' || permission === 'unsupported') return 'open';
  if (permission === 'prompt') return 'ask';
  return 'lost';
}
