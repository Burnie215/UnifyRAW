import { installChunkRecovery } from './platform/chunkRecovery'
import { renderInsecureNotice } from './platform/insecureNotice'
import { startVerdict } from './platform/secureContext'

// Armed before the app loads: a chunk that disappeared in a deployment - the
// bootstrap chunk included - still ends in one reload instead of a blank page.
installChunkRecovery()

// The switch. On a page without a secure context the app's own modules die
// while they load (./platform/secureContext), so nothing of the app is imported
// until that is settled. ./platform/secureContext.test.ts keeps this file's
// static imports to the few that cannot fail there.
if (startVerdict(window) === 'app') {
  void import('./bootstrap')
} else {
  renderInsecureNotice(document, window.location, navigator.languages ?? [navigator.language])
}
