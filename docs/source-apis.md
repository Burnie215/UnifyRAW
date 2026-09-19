# PhotoLib — Source Provider API Reference

## Übersicht: Album/Folder-Auswahl

### Kategorie A — Filesystem

| Quelle | Album/Ordner wählbar | Verschachtelt | Multi-Select | Konzept |
|---|---|---|---|---|
| **Local** | Ja (Ordner-Picker) | Ja (Filesystem) | Nein | User wählt Root-Ordner, Unterordner = Struktur |
| **ServerPath** | Ja (Pfad-Eingabe) | Ja (Filesystem) | Nein | Backend exponiert lokalen/NFS/SMB-Pfad |
| **WebDAV** | Ja (basePath Config) | Ja (PROPFIND recursive) | Nein | URL + basePath als Root, Ordnerstruktur via WebDAV |
| **S3/MinIO** | Ja (prefix Config) | Ja (Delimiter `/`) | Nein | Bucket + Prefix als Root, `/` simuliert Ordner |
| **FTP/SFTP** | Ja (Pfad-Eingabe) | Ja (Filesystem) | Nein | Backend-Proxy, Standard-Verzeichnisstruktur |
| **SMB** | Ja (Share + Pfad) | Ja (Filesystem) | Nein | Via ServerPath-Backend, Windows-Freigaben |

### Kategorie C — Self-Hosted Server

| Quelle | Album/Ordner wählbar | Verschachtelt | Multi-Select | Konzept |
|---|---|---|---|---|
| **Immich** | Ja (Alben) | Nein (flach) | Ja (Multi-Album) | Album-Auswahl bei Setup, oder "Alle Fotos" |
| **Photoprism** | Ja (Album/Folder/Moment) | Nein (flach) | Nein | 5 Album-Typen: album, folder, moment, month, state |
| **Synology Photos** | Ja (Folder + Album) | Ja (Folders) | Nein | 2 Namespaces: Personal (SYNO.Foto) + Shared (SYNO.FotoTeam) |
| **Piwigo** | Ja (Kategorie) | Ja (unbegrenzt) | **Ja (cat_id Array)** | Verschachtelte Kategorien, rekursive Abfrage, Smart Albums via Plugin |
| **Lychee** | Ja (Album) | Ja (parent_id Tree) | Nein | Tree-Endpoint, Smart Albums (Recent, Starred, Tag-basiert) |
| **QNAP QuMagie** | Ja (Album) | Unklar | Nein | API schlecht dokumentiert |

### Kategorie B — Cloud (read-only)

| Quelle | Album/Ordner wählbar | Verschachtelt | Multi-Select | Konzept |
|---|---|---|---|---|
| **Google Photos** | **Eingeschränkt** (siehe unten) | Nein | Nein | Picker API = UI-Dialog, Library API = nur app-eigene |
| **Google Drive** | Ja (Ordner) | Ja | Nein | Ordner-ID, manuell traversieren |
| **Dropbox** | Ja (Ordner-Pfad) | Ja (recursive Flag) | Nein | Pfad + `recursive: true` deckt Subtree ab |
| **OneDrive** | Ja (Ordner + Special Folders) | Ja | Nein | Special Folders: `cameraroll`, `photos` als Einstieg |
| **Flickr** | Ja (Photoset) | Ja (Collections > Sets) | Nein | 3 Ebenen: Collections, Photosets, Groups |
| **SmugMug** | Ja (Folder + Album) | Ja (max 5 Ebenen) | Nein | Pfad-basierte URLs, Nodes als Abstraktion |
| **Amazon Photos** | — | — | — | Kein offizielles API |
| **iCloud** | — | — | — | Kein Web-API, nur via Local (Ordner-Sync) |

## Übersicht: Persistenz & Fähigkeiten

| Quelle | Kat. | Auth | Thumbs | .dat schreiben | Webhooks | Limits |
|---|---|---|---|---|---|---|
| Local | A | — | generieren | ✓ direkt | — | — |
| ServerPath | A | — | Backend | ✓ via Backend | — | — |
| WebDAV | A | Basic Auth | Nextcloud-API / gen. | ✓ PUT | — | — |
| S3/MinIO | A | Access Key | generieren | ✓ als Objekt | — | — |
| FTP/SFTP | A | User/Pass, Key | generieren | ✓ via Backend | — | — |
| SMB | A | User/Pass | generieren | ✓ via Backend | — | — |
| Immich | C | API-Key | ✓ API | — | — | — |
| Photoprism | C | Session/App-PW | ✓ API (25 Größen) | ✓ Filesystem | Nein (geplant) | — |
| Synology Photos | C | Session + OTP | ✓ API | ✓ NAS-FS | — | — |
| Piwigo | C | API-Key/Session | ✓ Server-Derivate | ✓ Filesystem | Nein | — |
| Lychee | C | Session/API-Token | ✓ Server-Derivate | ✓ Filesystem | Nein | — |
| Google Photos | B | OAuth 2.0 PKCE | API (60min TTL) | Nein | Nein | 10k Req/Tag |
| Google Drive | B | OAuth 2.0 PKCE | API (cached Link) | Nein | — | — |
| Dropbox | B | OAuth 2.0 PKCE | ✓ API (256px) | Nein | — | — |
| OneDrive | B | OAuth 2.0 PKCE | ✓ Graph API | **✓ via API** | ✓ Subscriptions | ~130k/10s |
| Flickr | B | OAuth 1.0a | ✓ 15+ Größen | Nein | Nein | 3.600/h pro Key |
| SmugMug | B | OAuth 1.0a | ✓ Renditions | Nein | Begrenzt | Rate-limit Headers |

**Kategorien:** A = Filesystem (kann .dat schreiben), B = Cloud/read-only, C = Self-Hosted Server

---

## Detaillierte API-Dokumentation

### Kategorie A — Filesystem-Quellen

#### Local (File System Access API)

**Auth:** Browser-Permission-Dialog (readwrite)
**Browse:** Rekursiver `for await (dir.values())` Walk, max 20 Ebenen
**Thumbnails:** Lokal generiert, gespeichert in `.photolib/{label}.dat`
**Download:** `FileHandle.getFile()` → File-Objekt
**Schreiben:** ✓ Voll — `.dat`, Sidecar JSON, Exports
**Metadaten:** Aus EXIF-Extraktion, gespeichert in `.dat` Index
**Ordner:** User wählt Root-Ordner via `showDirectoryPicker()`, Unterordner = natürliche Struktur

#### ServerPath (Backend-Proxy)

**Auth:** Keine (Backend läuft im eigenen Netz)
**Browse:** `GET /api/files/list?path={rootPath}` — Backend liest Filesystem
**Thumbnails:** `GET /api/files/thumb?path={filePath}` — Backend generiert
**Download:** `GET /api/files/read?path={filePath}`
**Schreiben:** ✓ Via Backend-API — `.dat` neben Originalen möglich
**Metadaten:** Backend kann EXIF extrahieren
**Ordner:** User gibt Pfad ein (z.B. `/mnt/photos`), Backend validiert gegen `ALLOWED_ROOTS`

#### WebDAV / Nextcloud

**Auth:** Basic Auth (username:password)
**Browse:** `PROPFIND` mit `Depth: 1`, rekursiv pro Verzeichnis. Properties: resourcetype, getcontenttype, getcontentlength, getlastmodified
**Thumbnails:** Nextcloud: `GET /index.php/core/preview?file={path}&x=300&y=300&a=1` (erkennt `/remote.php` im URL). Fallback: `GET /index.php/apps/files/api/v1/thumbnail/300/300/{path}`. Standard-WebDAV: keine Thumbnails.
**Download:** `GET {url}/{path}` mit Auth-Header
**Schreiben:** ✓ `PUT {url}/{path}` — `.dat` neben Originalen möglich
**Ordner:** `basePath` in Config schränkt auf Unterverzeichnis ein

#### S3 / MinIO

**Auth:** Access Key ID + Secret Access Key
**Browse:** `GET /?list-type=2&prefix={prefix}&delimiter=/` — ListBucketV2, Pagination via ContinuationToken, max 500/Seite
**Thumbnails:** Keine vom Server — lokal generieren
**Download:** `GET /{key}` mit Auth-Header (AWS Signature)
**Schreiben:** ✓ `PUT /{key}` — `.dat` als S3-Objekt neben Originalen möglich
**Ordner:** `prefix` in Config als Root, `/` als Delimiter simuliert Ordnerstruktur

#### FTP/SFTP (geplant)

**Auth:** User/Pass oder SSH-Key
**Browse:** `LIST` (FTP) / `readdir` (SFTP) — via Backend-Proxy
**Thumbnails:** Lokal generieren
**Download:** `RETR` (FTP) / `read` (SFTP) — via Backend-Proxy
**Schreiben:** ✓ `STOR` (FTP) / `write` (SFTP) — `.dat` möglich
**Ordner:** Pfad-Eingabe, Standard-Verzeichnisstruktur

#### SMB / Netzlaufwerk (geplant)

**Auth:** User/Pass + optionale Domain
**Browse:** Via ServerPath-Backend (SMB-Share wird als lokaler Pfad gemountet)
**Thumbnails:** Lokal generieren
**Download:** Via Backend
**Schreiben:** ✓ Via Backend — `.dat` möglich
**Ordner:** Share + Pfad Eingabe, Backend mountet und validiert

---

### Kategorie C — Self-Hosted Server

#### Immich

Zwei Provider, weil Immich 3.0 die Upload- und Album-API bricht:
`immich` (2.x) und `immich-v3` (3.0+). Endpunkt-Details und die vollständige
Breaking-Change-Tabelle in [source-api-reference.md](source-api-reference.md).

**Auth:** API-Key (aus Immich-Einstellungen), Header `x-api-key`
**Version erkennen:** `GET /api/server/version` → `{ major, minor, patch }` (ohne Auth)
**Browse:** `POST /api/search/metadata` mit `{ page, size, type: "IMAGE" }` — es gibt *kein* `GET /api/assets` zum Auflisten
**Album-Filter:** v2 über `GET /api/albums/{id}` (enthält `assets[]`); v3 über `POST /api/search/metadata` mit `albumIds`
**Thumbnails:** `GET /api/assets/{id}/thumbnail?size=thumbnail` (klein) / `?size=preview` (groß)
**Download:** `GET /api/assets/{id}/original`
**Upload:** `POST /api/assets` (multipart). v2 verlangt `deviceAssetId`+`deviceId`; v3 kennt beide nicht mehr und dedupliziert über Header `x-immich-checksum` (SHA1)
**Alben:** `GET /api/albums` — Liste. Assets zuordnen mit **`PUT`** `/api/albums/{id}/assets` (nicht POST). Bei Setup wählbar (Multi-Album-Select implementiert).
**Stacking:** `POST /api/stacks` mit `{ assetIds: [primary, ...] }` — es gibt kein `stackParentId`
**Metadaten:** EXIF, GPS, Faces, Tags, Smart-Search. Server verwaltet alles.
**Ordner:** Keine echten Ordner — Album-basiert. Hierarchie: `Alle Fotos` oder spezifische Alben.

---

## Detaillierte API-Dokumentation

### Google Photos

#### Option 1: Photos Library API (stark eingeschränkt seit 03/2025)

**Auth:** OAuth 2.0 PKCE
**Scopes (seit März 2025):** `photoslibrary.appendonly`, `photoslibrary.readonly.appcreateddata`, `photoslibrary.edit.appcreateddata`

**EINSCHRÄNKUNG:** Seit März 2025 kann man nur noch **app-erstellte Fotos** lesen. Die volle User-Bibliothek ist nicht mehr zugänglich.

#### Option 2: Picker API (UI-basiert)
- Öffnet einen Google-Dialog im Browser
- User wählt Fotos/Alben manuell aus
- Ausgewählte Fotos werden an die App übergeben (mediaItems mit baseUrl)
- **Pro:** Funktioniert, Zugriff auf die volle Bibliothek
- **Contra:** User muss jedes Mal manuell auswählen, kein automatischer Scan/Sync

#### Option 3: Google Takeout → Local
- User exportiert seine Google Photos via takeout.google.com
- Ergebnis: ZIP mit allen Fotos + JSON-Metadaten
- Import als lokale Quelle (Kategorie A)
- **Pro:** Voller Zugriff auf alles
- **Contra:** Manueller Export, kein Live-Sync

#### Option 4: Google Drive Sync
- Google Photos kann automatisch in Google Drive synchronisieren
- Dann als Google Drive Quelle einbinden
- **Pro:** Live-Zugang via Drive API
- **Contra:** Google hat die automatische Drive-Sync für neue Accounts 2019 abgeschaltet, funktioniert nur bei bestehender Aktivierung

**Endpoints:**
- `GET /v1/albums` — nur app-erstellte Alben
- `POST /v1/mediaItems:search` — Suche mit Filtern (Datum, Kategorie, albumId). Nur ein albumId pro Request.
- `GET /v1/mediaItems/{id}` — Einzelnes Foto

**Thumbnails:** `baseUrl` + `=w{width}-h{height}` (beliebige Größe, `-c` für Crop). **URL verfällt nach 60 Minuten!**

**Download:** `baseUrl` + `=d` — Original mit EXIF

**Upload:** `POST /v1/uploads` → uploadToken, dann `POST /v1/mediaItems:batchCreate`

**Metadaten:** cameraMake, cameraModel, focalLength, aperture, ISO, exposureTime, creationTime, width, height. **Kein GPS, keine Tags, keine Faces, keine Ratings.**

**Alben:**
- `GET /v1/albums` — Liste (nur app-erstellte)
- `POST /v1/albums` — Erstellen
- `POST /v1/albums/{id}:batchAddMediaItems` — Fotos hinzufügen
- Metadaten: id, title, mediaItemsCount, coverPhotoBaseUrl, isWriteable
- Flach, keine Verschachtelung

**Limits:** 10.000 API Requests/Tag, 75.000 Media-Byte-Requests/Tag

---

### Google Drive (Drive API v3)

**Auth:** OAuth 2.0 PKCE
**Scopes:** `drive.readonly`, `drive.file`, `drive`

**Endpoints:**
- `GET /drive/v3/files?q='{folderId}' in parents` — Dateien in Ordner
- `GET /drive/v3/files?q=mimeType contains 'image/'` — Alle Bilder
- `GET /drive/v3/files/{id}?alt=media` — Download
- `GET /drive/v3/about?fields=user` — Verbindungstest

**Thumbnails:** `thumbnailLink` in der File-Response, Größe via `=s300` URL-Parameter

**Upload:** `POST /drive/v3/files` (Simple ≤5MB) + Resumable Upload

**Metadaten:** name, mimeType, size, createdTime, modifiedTime, imageMediaMetadata (cameraMake, cameraModel, fNumber, focalLength, ISO, exposureTime, width, height), thumbnailLink

**Ordner:**
- Volle verschachtelte Hierarchie
- `mimeType='application/vnd.google-apps.folder'` für Ordner-Suche
- Shared Drives: `GET /drive/v3/drives`, dann mit `driveId` + `supportsAllDrives=true`
- Ein Parent pro Query, manuell traversieren

---

### Dropbox (API v2)

**Auth:** OAuth 2.0 PKCE
**Extra Params:** `token_access_type=offline`

**Endpoints:**
- `POST /2/files/list_folder` — `path` (leer = Root), `recursive: true` für alle Unterordner
- `POST /2/files/list_folder/continue` — Pagination via Cursor
- `POST /2/files/get_temporary_link` — Temporärer Download-Link
- `POST /2/users/get_current_account` — Verbindungstest

**Thumbnails:**
- `POST /content.dropboxapi.com/2/files/get_thumbnail_v2`
- Header: `Dropbox-API-Arg: {"resource": {".tag": "path", "path": "..."}, "size": {".tag": "w256h256"}, "format": {".tag": "jpeg"}}`

**Download:** `POST /content.dropboxapi.com/2/files/download` mit `Dropbox-API-Arg` Header

**Upload:** `POST /content.dropboxapi.com/2/files/upload`
**Ordner erstellen:** `POST /2/files/create_folder_v2`

**Metadaten:** name, path_display, id, size, server_modified, content_hash. Fotos: media_info mit Dimensionen, time_taken, location

**Ordner:** Volle Verschachtelung, rein Filesystem-basiert, kein Album-Konzept. Recursive-Flag deckt ganzen Subtree ab.

---

### OneDrive (Microsoft Graph API)

**Auth:** OAuth 2.0 PKCE (Microsoft Identity Platform)
**Scopes:** `Files.Read`, `Files.ReadWrite`, `User.Read`

**Endpoints:**
- `GET /me/drive/items/{id}/children` — Ordner-Inhalt
- `GET /me/drive/root:/{path}:/children` — Pfad-basiert
- `GET /me/drive/special/{name}` — Special Folders: `photos`, `cameraroll`, `documents`
- `GET /me/drive/items/{id}/content` — Download (302 Redirect)
- `GET /me/drive/items/{id}/thumbnails` — Thumbnails

**Thumbnails:**
- Preset: small (96px), medium (176px), large (800px)
- Custom: `?select=c300x400_crop`
- Direkte URLs

**Upload:**
- Simple: `PUT /me/drive/items/{parent}:/{filename}:/content` (≤4MB)
- Resumable Upload Session für größere Dateien
- **Kann beliebige Dateien schreiben** — inkl. .dat Sidecars!

**Metadaten:**
- Photo-Facet: cameraMake, cameraModel, fNumber, focalLength, ISO, exposureNumerator/Denominator, takenDateTime
- Location-Facet: latitude, longitude, altitude
- **Nur Personal OneDrive hat volles EXIF, Business nur takenDateTime**

**Alben:** Bundles mit album-Facet. `GET /me/drive/bundles` (Beta). Schlecht dokumentiert.

**Ordner:** Volle Verschachtelung. Special Folders (cameraroll) als Einstiegspunkt.

**Webhooks:** `POST /subscriptions` — changeType=updated, max 30 Tage, muss erneuert werden. Delta API für Change-Tracking.

**Limits:** Dynamisches Throttling, ~130.000 Req/10s/App, HTTP 429 mit Retry-After

**Besonderheit:** Einziger Cloud-Dienst der .dat neben Originale via API schreiben kann.

---

### Flickr (REST API)

**Auth:** OAuth 1.0a + API-Key (für alle Requests nötig)

**Endpoints:**
- `flickr.photos.search` — Umfangreiche Filter: user, tags, text, date, geo bounding box, license, content type. Max 500/Seite.
- `flickr.photosets.getList` — Alben eines Users
- `flickr.photosets.getPhotos` — Fotos in Album. Supports `extras` für Metadaten.
- `flickr.photos.getSizes` — Alle verfügbaren Größen + URLs
- `flickr.photos.getExif` — Vollständige EXIF/XMP-Daten
- `flickr.photos.getInfo` — Titel, Beschreibung, Dates, Tags, Location, License
- `flickr.photos.geo.getLocation` — GPS-Koordinaten

**Thumbnails:** 15+ Größen via URL-Schema:
`https://live.staticflickr.com/{server}/{id}_{secret}_{suffix}.jpg`
Suffixe: s(75sq), q(150sq), t(100), m(240), n(320), w(400), (500), z(640), c(800), b(1024), h(1600), k(2048), 3k-6k

**Download:** Original-URL via `getSizes` mit `originalsecret`. **Free-Accounts eingeschränkt.**

**Upload:** `POST https://up.flickr.com/services/upload/`, Replace via `/services/replace/`

**Alben/Hierarchie:**
- Collections > Sets (Albums) — 3 Ebenen
- `flickr.collections.getTree` — Verschachtelte Baum-Struktur
- `flickr.photosets.create` — Album erstellen (braucht primary_photo_id)
- Galleries: kuratierte Sets von fremden Fotos
- Ein photoset_id pro Query

**Metadaten:** EXIF, XMP, GPS, Tags, Machine-Tags, Favorites, Kommentare, Gruppen, Views

**Limits:** 3.600 Req/Stunde **pro API-Key** (nicht pro User!)

---

### SmugMug (API v2)

**Auth:** OAuth 1.0a + API-Key (braucht aktives SmugMug-Abo)

**Endpoints:** REST-Style, self-documenting (HTML im Browser)
- `GET /api/v2/user/{nickname}` — User-Root
- `GET /api/v2/folder/user/{username}/{path}` — Ordner
- Follow `Folders` Link → Sub-Folders
- Follow `FolderAlbums` Link → Alben im Ordner
- `GET /api/v2/node/{nodeId}` mit `!children` Expansion
- `GET /api/v2/album/{albumKey}!images` — Fotos in Album

**Thumbnails:** Serverseitig generiert, verschiedene Renditions pro Image-Resource

**Upload:** POST zum Upload-Endpoint, max 500MB/Foto, 3GB/Video, HEIF/HEIC Support

**Ordner/Alben:**
- Pfad-basierte URLs: `/api/v2/folder/user/{username}/Folder1/Folder2`
- Max 5 Ordner-Ebenen, Alben zählen nicht mit
- Nodes: generische Abstraktion über Folders/Albums/Pages
- Max 5.001 Items pro Folder/Album
- Album erstellen: POST zum FolderAlbums-Endpoint

**Metadaten:** EXIF, Keywords, GPS, Captions

**Limits:** Rate-limit Headers, spezifische Zahlen nicht veröffentlicht

---

### PhotoPrism (Self-Hosted REST API)

**Auth:** Session-based `POST /api/v1/session` (username/password) → Token. App-Passwords möglich. `Authorization: Bearer <token>` oder `X-Auth-Token: <token>`.

**Endpoints:**
- `GET /api/v1/photos?q={query}&count=60&offset=0` — Fotos mit Filtern
- `GET /api/v1/photos/{uid}` — Einzelfoto
- `GET /api/v1/photos/{uid}/download` — Original-Download
- `POST /api/v1/upload` — Upload
- `GET /api/v1/albums?type={type}` — Alben nach Typ

**Filter:** before, after, country, lat, lng, dist, label, album, camera, lens, color, type

**Thumbnails:** `GET /api/v1/t/:hash/:token/:size` — 25 Größen (3x3 bis 7680px), Cookie-frei für CDN

**Alben:**
- Typen: `album` (manuell), `folder` (Filesystem), `moment` (auto: Datum/Ort), `month`, `state`
- `GET /api/v1/albums` — Liste mit Suche/Filter
- `POST /api/v1/albums` — Erstellen
- `GET /api/v1/photos?album={uid}` — Fotos in Album
- Flache Struktur, keine Verschachtelung

**Metadaten:** EXIF, GPS, AI-Labels, Faces, Alben, Farben. Keine Star-Ratings.

**Swagger:** `/api/v1/docs/index.html` pro Instanz

---

### Synology Photos (DSM 7, inoffiziell)

**Auth:** `POST /photo/webapi/auth.cgi` mit `api=SYNO.API.Auth`, account, password → `sid` Cookie

**WICHTIG:** Zwei getrennte API-Namespaces:
- `SYNO.Foto.*` — Personal Space
- `SYNO.FotoTeam.*` — Shared Space

**Endpoints:**
- `SYNO.Foto.Browse.Item` method `list` — Fotos auflisten
- `SYNO.Foto.Browse.Folder` method `list` — Ordner-Navigation
- `SYNO.Foto.Browse.Album` — Alben (normal + conditional/smart)
- `SYNO.Foto.Browse.NormalAlbum` / `SYNO.Foto.Browse.ConditionAlbum` — Filterung
- `SYNO.Foto.Thumbnail` — Thumbnails
- `SYNO.Foto.Download` — Original-Download
- `SYNO.Foto.Upload` — Upload
- `SYNO.Foto.Browse.Item` method `get_exif` — EXIF-Daten

**Ordner/Alben:**
- Ordner verschachtelt (spiegelt NAS-Filesystem)
- Alben flach
- Fotos unter `/volume1/photo/` (Shared) oder Home-Ordner (Personal)

**Metadaten:** EXIF via get_exif, Tags (add_tag), Alben

**ACHTUNG:** API nicht offiziell dokumentiert — reverse-engineered, kann sich mit jedem DSM-Update ändern.

---

### Piwigo (REST/JSON API)

**Auth:** API-Key seit v16 (Header `X-PIWIGO-API: pkid-XXXXXXXX:YYYYYYYY`) oder Session via `pwg.session.login`

**Alle Calls:** `POST /ws.php?format=json` mit `method=...`

**Endpoints:**
- `pwg.categories.getList` — Kategorien (= Alben). `recursive=true`, `tree_output=true` für Baum
- `pwg.categories.getImages` — Fotos in Kategorie. `cat_id`, `recursive=true` für Sub-Kategorien. **Multi-category: cat_id akzeptiert Array!**
- `pwg.images.search` — Suche
- `pwg.images.getInfo` — Einzelfoto mit Original-URL
- `pwg.images.upload` / `pwg.images.addChunk` + `pwg.images.add` — Upload (chunked)
- `pwg.categories.add` — Kategorie erstellen (mit parent)

**Thumbnails:** Serverseitig generiert: square, thumb, small, medium, large, xlarge, xxlarge. URLs in Image-Responses.

**Kategorien/Alben:**
- Volle Verschachtelung, unbegrenzte Tiefe
- `id_uppercat` = Parent-ID
- **Einziger Dienst mit Multi-Album-Filter** (cat_id als Array)
- Smart Albums via Plugin (Piwigo-SmartAlbums)
- Metadaten: id, name, id_uppercat, nb_images, nb_categories, representative_picture_id, total_nb_images (rekursiv)

**Metadaten:** EXIF, IPTC, GPS, Tags, Kategorien, Rating, Autor, Beschreibung

**API-Browser:** `/tools/ws.htm` pro Instanz

---

### Lychee (Self-Hosted, v7+)

**Auth:** Bearer-Token (Personal Access Token) **oder** Session-Cookie.
- Token generieren: Lychee-Web-UI → Profile → **Reset Token** (einmalig im Klartext angezeigt) — entspricht `POST /api/v2/Profile::resetToken`.
- Header: `Authorization: Bearer {token}`, `Accept: application/json`, `Content-Type: application/json` (außer Multipart-Upload).
- Voraussetzung in Lychee-`.env`: `ENABLE_TOKEN_AUTH=true` (default).

**HINWEIS — Breaking Change ab v6/v7:** Die alte RPC-API (`POST /api/v2/Albums::get`, `Album::get` mit `albumID`-Body, `Photo::setStar`, `Photo::setTitle`, …) **gibt es nicht mehr**. Lychee benutzt jetzt REST-Verben (GET/PATCH/POST/DELETE) mit `?album_id=`-Query-Parametern. Siehe Migration-Tabelle in `source-api-reference.md → ## Lychee`.

**Kern-Endpoints (v7):**
- `GET /api/v2/Albums` — Wurzel-Listing (alle Top-Level-Alben + Smart Albums + Tag-Alben + shared)
- `GET /api/v2/Album::head?album_id={id}` — Album-Header (Metadaten ohne Children/Photos)
- `GET /api/v2/Album::albums?album_id={id}&page={n}` — Kind-Alben paginiert
- `GET /api/v2/Album::photos?album_id={id}&page={n}` — Fotos paginiert
- `POST /api/v2/Album` — Album erstellen, Body: `{ title, parent_album }`
- `POST /api/v2/Photo` — Multipart-Upload (chunked, Pflichtfelder: `album_id`, `file`, `file_name`, `uuid_name`, `extension`, `chunk_number`, `total_chunks`)
- `POST /api/v2/Photo::fromUrl` — URL-Import, Body: `{ album, urls: [...] }`
- `PATCH /api/v2/Photo::rename` / `Photo::tags` / `Photo` (generic update)
- `POST /api/v2/Photo::highlight` (= ehem. „Star/Favorit"), `Photo::setRating` (1–5), `Photo::move`, `Photo::copy`

**Thumbnails:** Serverseitig generiert. URLs in `PhotoResource.size_variants`: `thumb`, `small`, `small2x`, `medium`, `medium2x`, `original` (jeweils `{url, width, height, filesize}`).

**Alben:**
- Verschachtelt via `parent_album` (null = Wurzel) — Tree wird rekursiv über `Album::albums?parent_id=…` aufgebaut (kein Tree-Endpoint mehr).
- **Smart Albums** (v7-IDs): `recent`, `highlighted` (ehem. starred), `on_this_day`, `unsorted`, `untagged`, `1star`…`5star`, `best_pictures`, `my_best_pictures`, `my_rated_pictures`.
- **Tag-Alben** (dynamisch via Tags): `POST /api/v2/TagAlbum` mit `{ title, tags, is_and }`.

**Metadaten:** EXIF, GPS, Tags, Titel, Beschreibung, **Rating** (1–5, neu in v7), `is_highlighted`. Keine Faces.
