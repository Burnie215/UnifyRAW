# UnifyRAW

**Photo library and RAW editor in the browser. Your sources, no cloud lock-in.**

UnifyRAW connects the photo sources you already have into one library and develops
RAW files right in the browser: rate, sort, edit non-destructively, export. Reachable
from any device with a browser, without Adobe's cloud in the background.

- Website: https://unifyraw.com
- App (hosted, currently free): https://photo.beseb.de

## What this repository is for

This repository is the public **issue tracker** for UnifyRAW: bug reports, feature
requests and questions. It deliberately contains **no source code**. Whether
UnifyRAW becomes open source or stays proprietary has not been decided yet.

- [Report a bug](https://github.com/Burnie215/UnifyRAW/issues/new?template=bug_report.yml)
- [Request a feature or a new source](https://github.com/Burnie215/UnifyRAW/issues/new?template=feature_request.yml)
- Browse existing issues and upvote with a thumbs-up before opening a duplicate.

Deutsch ist genauso willkommen wie Englisch.

## Status

UnifyRAW is a one-person project in an early test phase.

| Area | Status |
|---|---|
| Sources | Local folders, Immich, Lychee are available. PhotoPrism, Nextcloud Photos, Synology Photos, Piwigo, LibrePhotos, Ente, WebDAV, S3, Dropbox, Google Drive, OneDrive, Google Photos, Flickr, SmugMug, FTP/SFTP, SMB, SSH, NFS are planned. |
| Editor | Basic, white balance, presence, tone curve, levels, HSL / colour editor, colour grading, sharpening, denoise (incl. in-browser AI models), B&W mixer, vignette, grain, lens correction, geometry, masks, layers, presets. |
| RAW | LibRaw compiled to WebAssembly, linear 16-bit-capable WebGL pipeline, HEIC support. |
| Devices | Optional sync of edits, ratings and collections between devices; optional end-to-end encryption. |
| Licence | Open. Not decided between open source and proprietary. |
| Self-hosting | Not available yet; depends on the licence decision. |
| Price | Currently free on the hosted instance. |

## Privacy in one paragraph

Catalog, previews and edits live in your browser. Editing and rendering happen in the
browser with WebGL. Files from local folders never leave the browser. For server sources
such as Immich or Lychee, your browser talks to your server; where browser restrictions
(CORS) prevent that, the UnifyRAW server relays the request without keeping files, and it
may cache downsized RAW previews for speed (can be disabled in the settings). The optional
device sync transfers parameters, never pictures. Details on the website.

## Trademarks

Lightroom and Adobe are trademarks of Adobe Inc. Immich, Lychee and other products named
here are trademarks of their respective owners; they are mentioned only to describe
compatibility.
