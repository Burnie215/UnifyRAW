# PhotoLib — Source API Reference (vollständig)

Alle Endpoints, Auth-Flows und Verbindungsmethoden pro Quelle.
Vollständige Referenz für die Implementierung aller SourceProvider-Methoden.

---

## Local (File System Access API)

**Verbindung:** Browser-API, kein Server.

```
// Permission
handle = await showDirectoryPicker({ mode: 'readwrite' })
perm = await handle.requestPermission({ mode: 'readwrite' })  // 'granted' | 'denied'

// Browse (rekursiv)
for await (entry of dirHandle.values())
  entry.kind      // 'file' | 'directory'
  entry.name      // Dateiname

// Datei lesen
fileHandle = await dirHandle.getFileHandle('photo.jpg')
file = await fileHandle.getFile()           // → File (Blob mit name, size, type, lastModified)

// Verzeichnis navigieren
subDir = await dirHandle.getDirectoryHandle('subfolder')
subDir = await dirHandle.getDirectoryHandle('.photolib', { create: true })

// Datei schreiben
handle = await dirHandle.getFileHandle('data.dat', { create: true })
writable = await handle.createWritable()
await writable.write(blob)                  // Blob, ArrayBuffer, string, oder WriteParams
await writable.close()

// Random-Access Write
await writable.seek(offset)
await writable.write(data)
await writable.truncate(newSize)

// Datei löschen
await dirHandle.removeEntry('file.jpg')
await dirHandle.removeEntry('subdir', { recursive: true })
```

**Limitierungen:**
- Safari: kein `showDirectoryPicker`, nur `<input webkitdirectory>` (read-only, keine Handles)
- Permission muss bei jedem Page-Load neu erteilt werden (Chrome merkt sich, Firefox nicht)
- Keine Symlinks, keine versteckten System-Ordner

---

## Immich v2 (2.x)

> Verifiziert gegen `open-api/immich-openapi-specs.json` @ Tag `v2.7.5`.
> Für Immich 3.0+ siehe den Abschnitt [Immich v3](#immich-v3-30) — die
> Upload- und Album-APIs haben dort Breaking Changes.

**Auth:**
```
Header: x-api-key: {apiKey}
// API-Key aus Immich UI → Account Settings → API Keys
```

**Endpoints:** Base = `{serverUrl}/api`

### Basis

```
// Verbindungstest
GET /server/ping                             → { "res": "pong" }

// Server-Info
GET /server/version                          → { major, minor, patch }
GET /server/about                            → Server-Version, Features (auth-pflichtig)
GET /server/config                           → Konfiguration
GET /server/statistics                       → Statistiken (Fotos, Videos, Speicher)
```

`GET /server/version` ist der zuverlässigste Weg, v2 von v3 zu unterscheiden —
er ist unauthentifiziert erreichbar und liefert `major` direkt.

### Assets (Fotos)

```
// Metadaten-Suche (paginiert) — der Weg, Assets zu listen.
// Es gibt KEIN "GET /assets" zum Auflisten.
POST /search/metadata                        → { assets: { items, total, count, nextPage } }
  Body: { size: 1..1000, page: >=1, type: "IMAGE", albumIds?, tagIds?, withExif? }

// Smart/CLIP-Suche
POST /search/smart                           → { assets: { items: Asset[] } }
  Body: { query: "sunset at beach", ... }

// Asset-Details
GET /assets/{id}                             → Asset (vollständig)
  Asset: { id, type, originalPath, originalFileName, originalMimeType,
           checksum, width, height, duration, fileCreatedAt, fileModifiedAt,
           localDateTime, isFavorite, isArchived, isTrashed, isOffline,
           isEdited, hasMetadata, thumbhash, visibility, ownerId, owner,
           deviceId, deviceAssetId,          // ← in v3 ENTFERNT
           exifInfo: { make, model, fNumber, focalLength, iso, exposureTime,
                       lensModel, latitude, longitude, city, state, country,
                       fileSizeInByte, description, exifImageWidth/Height },
           tags, people, stack, libraryId, duplicateId, livePhotoVideoId }

// Thumbnails
GET /assets/{id}/thumbnail?size=thumbnail    → JPEG (klein, ~250px)
GET /assets/{id}/thumbnail?size=preview      → JPEG (groß, ~1440px)
  size: original | fullsize | preview | thumbnail

// Original-Datei
GET /assets/{id}/original                    → Originaldatei

// Asset aktualisieren (einzeln)
PUT /assets/{id}                             → Asset
  Body: { isFavorite, isArchived, description, dateTimeOriginal,
          latitude, longitude, rating, visibility }

// Assets aktualisieren (bulk)
PUT /assets                                  → 204
  Body: { ids: [...], isFavorite?, rating?, description?, ... }
  // Achtung: KEIN stackParentId — Stacking läuft über /stacks (s.u.)

// Assets löschen (bulk)
DELETE /assets                               → 204
  Body: { ids: [...], force: true }
  // Schlägt komplett fehl, wenn EINE id unbekannt ist → per-id-Fallback nötig

// Asset ersetzen (in v3 ENTFERNT)
PUT /assets/{id}/original                    → Asset ersetzen

// Weitere
GET  /assets/{id}/metadata                   → MetadataPair[]
PUT  /assets/{id}/metadata                   → Metadaten setzen
GET  /assets/{id}/edits                      → Edit-Actions (Crop/Rotate/Mirror)
GET  /assets/{id}/ocr                        → OCR-Daten
GET  /assets/statistics                      → { images, videos, total }
POST /assets/jobs                            → Job starten
```

### Upload

```
POST /assets                                 → multipart/form-data → { id, status }
  Required: assetData (file), deviceAssetId, deviceId, fileCreatedAt, fileModifiedAt
  Optional: filename, isFavorite, duration, livePhotoVideoId, sidecarData, visibility
  Header (optional): x-immich-checksum        // sha1, hex oder base64
  status: created | replaced | duplicate
```

**Idempotenz in v2:** `deviceAssetId` + `deviceId` identifizieren ein Asset
logisch. Ein erneuter Upload mit demselben Paar liefert `status: "duplicate"`
und die bestehende `id`, statt ein zweites Asset anzulegen.

### Stacking

```
POST   /stacks                               → Stack
  Body: { assetIds: [primaryId, ...weitere] }   // erstes Element = Primary
GET    /stacks                               → Stack[]
DELETE /stacks/{id}                          → Stack auflösen
DELETE /stacks/{id}/assets/{assetId}         → Asset aus Stack lösen
```

### Alben

```
// Alle Alben
GET /albums                                  → Album[]
  Query: assetId?, shared?                    // v3: shared → isShared/isOwned
  Album: { id, albumName, description, assetCount, albumThumbnailAssetId,
           createdAt, updatedAt, shared, hasSharedLink, isActivityEnabled,
           owner, ownerId, albumUsers, order, startDate, endDate }

// Album-Details INKLUSIVE Assets
GET /albums/{id}                             → Album + assets: Asset[]
  Query: withoutAssets?                       // v3: Param UND assets entfallen

GET    /albums/statistics                    → Statistiken über Alben
POST   /albums                               → Album erstellen; Body: { albumName, description?, assetIds? }
PATCH  /albums/{id}                          → Body: { albumName, description, order }
DELETE /albums/{id}                          → 204

// Assets zu Album hinzufügen / entfernen  — PUT, nicht POST!
PUT    /albums/{id}/assets                   → Result[]; Body: { ids: [...] }
DELETE /albums/{id}/assets                   → Result[]; Body: { ids: [...] }
PUT    /albums/assets                        → bulk: Assets zu mehreren Alben

// Sharing
PUT    /albums/{id}/users                    → mit Usern teilen
PUT    /albums/{id}/user/{userId}            → Rolle ändern
DELETE /albums/{id}/user/{userId}            → User entfernen
```

### Tags

```
GET    /tags                                 → Tag[] { id, name, value, color, parentId }
POST   /tags                                 → Body: { name: "TagName" }
PUT    /tags/{id}/assets                     → Body: { assetIds: [...] }
DELETE /tags/{id}/assets                     → Assets vom Tag lösen
DELETE /tags/{id}                            → Tag löschen
```

### Weitere Bereiche

```
GET /people | /people/{id} | /faces          → Personen & Gesichter
GET /activities                              → Likes/Comments (Query: albumId)
GET /api-keys                                → API-Key-Verwaltung
GET /admin/users                             → User-Verwaltung
```

**Fehlerformat v2:**
```json
{ "message": "...", "error": "Unauthorized", "statusCode": 401, "correlationId": "abc" }
```

---

## Immich v3 (3.0+)

> Verifiziert gegen `open-api/immich-openapi-specs.json` @ Tags `v3.0.0`
> **und `v3.1.0`** (aktuellstes Release, 2026-07-29). 3.1.0 ändert an den hier
> dokumentierten Routen und DTOs nichts: null Pfad-Diffs zu 3.0.0, und keines
> der von den Providern genutzten Schemas wurde angefasst. Die Angaben gelten
> damit für die gesamte 3.x-Linie.
>
> Auth, Base-URL und der Großteil der Endpunkte sind identisch zu v2 —
> hier stehen nur die **Unterschiede**. Alles nicht Genannte gilt wie oben.

### Breaking Changes v2 → v3 (relevant für Source-Provider)

| Bereich | v2 | v3 | Auswirkung |
|---|---|---|---|
| **Upload** | `deviceAssetId` + `deviceId` **required** | Felder **entfernt** | Idempotenz muss über `x-immich-checksum` laufen |
| **Upload-Status** | `created \| replaced \| duplicate` | `created \| duplicate` | `replaced` entfällt (Ersetzen-Endpoint weg) |
| **Album-Detail** | `GET /albums/{id}` liefert `assets[]` | `assets` **entfernt** | Album-Assets über `POST /search/metadata` + `albumIds` |
| **Album-Besitz** | `owner`, `ownerId` | **entfernt** → `albumUsers` | Owner aus `albumUsers` lesen |
| **Album-Filter** | `?shared=` | `?isShared=`, `?isOwned=` (beide optional) | alter Param wirkungslos |
| **Asset-DTO** | `deviceId`, `deviceAssetId`, `unassignedFaces` | **entfernt** | Felder nicht mehr lesbar |
| **Fehler** | `{ message, error, statusCode, correlationId }` | `{ message }` + sanitisiert | Text-Heuristiken auf Fehlermeldungen brechen |
| **Correlation-ID** | im Body | Header `X-Correlation-ID` | — |
| **Suche** | `deviceAssetId`/`deviceId` filterbar | **entfernt** | kein Lookup per Device-ID mehr |
| **Dauer** | uneinheitlich | Millisekunden, `null` wenn leer | nur für Videos relevant |
| **Rating** | beliebig | `< 1` unzulässig | — |

### Entfernte Endpunkte

```
GET  /assets/device/{deviceId}      GET  /assets/random
POST /assets/exist                  PUT  /assets/{id}/original
GET  /server/theme                  GET  /plugins/triggers
POST /sync/delta-sync               POST /sync/full-sync
```

### Upload (v3)

```
POST /assets                                 → multipart/form-data → { id, status }
  Required: assetData (file), fileCreatedAt, fileModifiedAt
  Optional: filename, isFavorite, duration, livePhotoVideoId, sidecarData, visibility
  Header:   x-immich-checksum: {sha1}         // hex oder base64 — Dedup-Schlüssel
  status: created | duplicate
```

**Idempotenz in v3:** Es gibt keine client-seitige logische ID mehr. Immich
dedupliziert über die **SHA1-Prüfsumme des Dateiinhalts**. Zwei Wege:

```
// a) Header beim Upload — Immich antwortet direkt mit status: "duplicate"
POST /assets   Header: x-immich-checksum: <sha1-hex>

// b) Vorab prüfen, ohne Bytes hochzuladen
POST /assets/bulk-upload-check
  Body: { assets: [{ id: "<client-key>", checksum: "<sha1 hex|base64>" }] }
  →     { results: [{ id, action: "accept"|"reject", assetId? }] }
        // action "reject" + assetId = existiert bereits
```

Weil der Hash über den **Bytes** liegt, ist er nur stabil, wenn der Export
deterministisch rendert. Ein bit-identischer Re-Export dedupliziert; ein
minimal abweichender Render erzeugt ein neues Asset.

### Album-Assets auflisten (v3)

`GET /albums/{id}` liefert keine Assets mehr. Stattdessen paginiert über die
Metadaten-Suche:

```
POST /search/metadata
  Body: { albumIds: [albumId], type: "IMAGE", page: 1, size: 200 }
  →     { assets: { items: Asset[], total, count, nextPage } }
```

`nextPage` ist `null`, wenn keine weitere Seite folgt — verlässlicher als
`items.length >= size` zu vergleichen.

### Album-DTO (v3)

```
Album: { id, albumName, description, assetCount, albumThumbnailAssetId,
         createdAt, updatedAt, shared, hasSharedLink, isActivityEnabled,
         albumUsers, order, startDate, endDate,
         lastModifiedAssetTimestamp, contributorCounts }
         // KEIN assets, KEIN owner/ownerId
```

**Fehlerformat v3:**
```json
{ "message": "..." }
```
Plus Header `X-Correlation-ID`. Meldungen sind sanitisiert und nennen keine
Ressourcendetails mehr — auf ihren Wortlaut darf keine Logik aufbauen.
Für „schon gelöscht" statt Textvergleich den HTTP-Status auswerten (400/404).

---

## Photoprism

**Auth:**
```
POST /api/v1/session
  Body: { username: "admin", password: "..." }
  Response: { id, config: { downloadToken }, ... }
  → Header: X-Auth-Token: {id}
  // App-Passwords: photoprism auth add --name="PhotoLib" --scope="*"
```

**Endpoints:** Base = `{serverUrl}/api/v1`

### Fotos

```
// Fotos suchen/listen
GET /photos?q={query}&count=60&offset=0      → Photo[]
  Filter: before, after, country, lat, lng, dist, label, album,
          camera, lens, color, type, face, path, name, title,
          favorite, private, archived, review, stack, unsorted
  Photo: { UID, Type, Title, FileName, Hash, Width, Height,
           TakenAt, Lat, Lng, Camera: {Make, Model}, Lens: {Make, Model},
           Iso, FNumber, FocalLength, Exposure, Favorite, Private,
           Description, Details: { Keywords } }

// Foto-Details
GET /photos/{uid}                            → Photo (vollständig mit Files[])

// Foto aktualisieren (Titel, Beschreibung, Datum, Ort, etc.)
PUT /photos/{uid}                            → Photo
  Body: { Title, Description, TakenAt, Lat, Lng, ... }

// Download
GET /photos/{uid}/dl                         → Originaldatei (application/octet-stream)

// YAML-Export
GET /photos/{uid}/yaml                       → Photo als YAML

// Review approven
POST /photos/{uid}/approve                   → Photo aus Review freigeben

// Primäre Datei setzen
POST /photos/{uid}/files/{fileuid}/primary   → primäre Datei ändern
```

### Favoriten

```
POST /photos/{uid}/like                      → Favorit setzen
DELETE /photos/{uid}/like                    → Favorit entfernen
```

### Labels (AI-generiert + manuell)

```
GET /labels?count=100&offset=0               → Label[]
POST /labels                                 → Label erstellen
GET /labels/{id}                             → Label-Details
PUT /labels/{id}                             → Label umbenennen
DELETE /labels/{id}                          → Label löschen

// Label zu Foto
POST /photos/{uid}/label                     → Label hinzufügen
  Body: { Name: "landscape", Uncertainty: 0 }
PUT /photos/{uid}/label/{id}                 → Label-Uncertainty ändern
DELETE /photos/{uid}/label/{id}              → Label von Foto entfernen
```

### Thumbnails

```
GET /t/{hash}/{token}/{size}
  Sizes: tile_50, tile_100, tile_224, tile_500, fit_720, fit_1280,
         fit_1920, fit_2048, fit_2560, fit_3840, fit_4096, fit_7680
  // token = downloadToken aus Session-Config
  // CDN-kompatibel, keine Auth-Header nötig
```

### Upload

```
POST /upload/{path}                          → multipart/form-data
```

### Alben

```
GET /albums?type={type}&count=60&offset=0    → Album[]
  Types: album, folder, moment, month, state
  Album: { UID, Type, Title, Description, PhotoCount, CreatedAt, UpdatedAt }

POST /albums                                 → Album erstellen
  Body: { Title: "Name", Type: "album" }

GET /albums/{uid}                            → Album-Details
PUT /albums/{uid}                            → Album aktualisieren (Titel, Beschreibung)
DELETE /albums/{uid}                         → Album löschen (?force=true)

// Favorit
POST /albums/{uid}/like                      → Album als Favorit
DELETE /albums/{uid}/like                    → Favorit entfernen

// Fotos in Album
POST /albums/{uid}/photos                    → Fotos hinzufügen
  Body: { photos: ["uid1", "uid2"] }
DELETE /albums/{uid}/photos                  → Fotos entfernen
  Body: { photos: [...] }

// Album klonen
POST /albums/{uid}/clone                     → Album mit Fotos duplizieren
```

### Personen/Gesichter (Subjects)

```
GET /subjects                                → Subject[] (erkannte Personen)
GET /subjects/search                         → Subjects suchen
POST /subjects                               → Subject erstellen
GET /subjects/{id}                           → Subject-Details
PUT /subjects/{id}                           → Subject umbenennen
  Body: { Name: "Max Mustermann" }
```

### Batch-Operationen

```
POST /batch/photos/archive                   → mehrere Fotos archivieren
  Body: { photos: ["uid1", "uid2"] }
POST /batch/photos/restore                   → aus Archiv wiederherstellen
POST /batch/photos/approve                   → mehrere aus Review freigeben
POST /batch/photos/private                   → Private-Status toggeln
POST /batch/photos/delete                    → permanent löschen (aus Archiv)
POST /batch/albums                           → Batch-Album-Operationen
POST /batch/labels                           → Batch-Label-Operationen
```

### Markers (Gesichtsregionen in Fotos)

```
GET /markers                                 → alle Marker listen
PUT /photos/{uid}/marker/{id}                → Marker aktualisieren (Name zuweisen)
  Body: { SubjSrc: "manual", Name: "Person Name" }
DELETE /photos/{uid}/marker/{id}             → Marker ablehnen
POST /photos/{uid}/marker/{id}/subject       → neues Subject aus Marker erstellen
```

### Dateien & Downloads

```
GET /files/{hash}                            → Datei-Details nach Hash
DELETE /files/{hash}                         → Datei unlinkern
GET /dl/{hash}                               → Original herunterladen
GET /videos/{hash}/{token}/{format}          → Video streamen (avc, vp8, vp9, av1)
POST /zip                                    → ZIP erstellen
  Body: { photos: ["uid1", "uid2"] }
GET /zip                                     → ZIP herunterladen
```

### Share-Links

```
GET /links/{uid}                             → Share-Links für Entität
POST /links/{uid}                            → Share-Link erstellen
  Body: { Password: "", Expires: 0 }
PUT /links/{uid}/{linkuid}                   → Share-Link aktualisieren
DELETE /links/{uid}/{linkuid}                → Share-Link löschen
GET /s/{token}/{uid}                         → geteiltes Album (public, keine Auth)
```

### Ordner & Kameras

```
GET /folders                                 → Originals-Ordner-Baum browsen
GET /folders/{path}                          → bestimmten Ordner browsen
GET /cameras                                 → Kameras listen
GET /lenses                                  → Objektive listen
GET /countries                               → Länder listen
```

### Suche — vollständige Filter-Liste

```
GET /photos?{filter}=...
  Basis:    q, count, offset, order
  Typen:    type (image|video|raw|live|animated), photo, video, raw, live, panorama
  Orte:     lat, lng, dist, country, state, city, geo
  Zeit:     year, month, day, before, after
  Album:    album, albums, s (scope)
  Labels:   label, category, color, keywords
  Kamera:   camera, lens
  Gesicht:  face, faces, subject, person, people
  Status:   favorite, private, public, archived, review, unsorted, stack
  Qualität: quality (1-7), chroma (0-100)
  Sort:     order=newest|oldest|added|edited|name|place|favorites|relevance|size|random|similar
```

### Config & Status

```
GET /config                                  → Server-Konfiguration (inkl. downloadToken, previewToken)
GET /config/options                          → erweiterte Config (Admin)
POST /config/options                         → Config speichern (Admin)
GET /settings                                → User-Einstellungen
POST /settings                               → User-Einstellungen speichern
GET /status                                  → System-Status
GET /errors                                  → Server-Error-Log
```

### WebSocket Events

```
ws://{host}/api/v1/ws
  Events: config.updated, count, photos, albums, labels,
          subjects, people, sync, import, index, upload, log
  Format: { event: "photos", data: {...} }
```

### Swagger-Docs

```
GET /docs/index.html                         → interaktive API-Docs pro Instanz
```

---

## Synology Photos (DSM 7, inoffiziell)

**Auth:**
```
POST /photo/webapi/auth.cgi
  Params: api=SYNO.API.Auth&method=login&version=1
          &account={user}&passwd={pass}
  Response: { success: true, data: { sid: "..." } }
  → Cookie: id={sid}  ODER  _sid={sid} als Query-Parameter
```

**Alle Calls:** `POST /photo/webapi/entry.cgi` mit Formdata

**WICHTIG:** Zwei Namespaces — `SYNO.Foto.*` (Personal) und `SYNO.FotoTeam.*` (Shared).
Alle folgenden Endpoints existieren in beiden Varianten.

### Ordner

```
api=SYNO.Foto.Browse.Folder&method=list&version=1
  &offset=0&limit=100&id=0                  → Folder[]
  Folder: { id, name, parent, owner_user_id, passphrase, shared }
```

### Fotos

```
// Fotos in Ordner
api=SYNO.Foto.Browse.Item&method=list&version=1
  &offset=0&limit=100&folder_id={id}
  &additional=["thumbnail","resolution","orientation","video_convert","video_meta"]
  Item: { id, filename, filesize, time, indexed_time, type,
          additional: { thumbnail: { m, xl }, resolution: { width, height } } }

// EXIF
api=SYNO.Foto.Browse.Item&method=get_exif&version=1
  &id=[{itemId}]
  → EXIF-Daten (Camera, Lens, ISO, Blende, etc.)
```

### Alben

```
// Alben listen
api=SYNO.Foto.Browse.Album&method=list&version=1
  &offset=0&limit=100
  Album: { id, name, type, item_count, create_time, ... }

// Smart/Conditional Alben
api=SYNO.Foto.Browse.ConditionAlbum&method=list&version=1

// Fotos in Album
api=SYNO.Foto.Browse.Item&method=list&version=1
  &album_id={id}&offset=0&limit=100
```

### Thumbnails & Download

```
// Thumbnail
api=SYNO.Foto.Thumbnail&method=get&version=1
  &id={itemId}&size=sm                       → JPEG
  Sizes: sm, m, xl

// Download
api=SYNO.Foto.Download&method=download&version=1
  &unit_id=[{id}]
```

### Tags

```
// Tags listen
api=SYNO.Foto.Browse.GeneralTag&method=list&version=1

// Tag zu Foto hinzufügen
api=SYNO.Foto.Browse.Item&method=add_tag&version=1
  &id=[{itemId}]&tag=[{tagId}]
```

### Upload

```
api=SYNO.Foto.Upload&method=upload&version=1
  // multipart/form-data mit Datei
```

### Filesystem-Zugriff

```
Personal Space: /homes/{username}/Photos/
Shared Space:   /volume1/photo/

Zugang via SMB: smb://{nas-ip}/photo/    (Shared)
                smb://{nas-ip}/homes/    (Personal, braucht Admin)
```

---

## Piwigo

**Auth:**
```
// Option 1: Session
POST /ws.php?format=json
  method=pwg.session.login&username={user}&password={pass}
  → Set-Cookie: pwg_id=...

// Option 2: API-Key (Piwigo 16+)
Header: X-PIWIGO-API: pkid-{keyId}:{secret}
```

**Alle Calls:** `POST /ws.php?format=json` mit `method=...`

### Session

```
method=pwg.session.login                     → Login
method=pwg.session.logout                    → Logout
method=pwg.session.getStatus                 → Session-Info (username, status, theme, etc.)
```

### Kategorien (= Alben)

```
method=pwg.categories.getList
  &recursive=true                            → verschachtelter Baum
  &tree_output=true                          → als Tree-Struktur
  Category: { id, name, id_uppercat, nb_images, nb_categories,
              total_nb_images, representative_picture_id,
              comment, permalink, url }

method=pwg.categories.add
  &name={name}&parent={parentCatId}          → neue Kategorie erstellen

method=pwg.categories.delete
  &category_id={id}                          → Kategorie löschen

method=pwg.categories.setInfo
  &category_id={id}&name={name}&comment={desc}  → Kategorie bearbeiten

method=pwg.categories.move
  &category_id={id}&parent={newParentId}     → Kategorie verschieben
```

### Fotos

```
// Fotos in Kategorie
method=pwg.categories.getImages
  &cat_id={id}                               → oder Array [1,2,3] für Multi-Select!
  &recursive=true                            → inkl. Sub-Kategorien
  &per_page=100&page=0
  Image: { id, file, name, width, height, date_creation, date_available,
           categories, tags, element_url, derivatives: { square, thumb, small,
           medium, large, xlarge, xxlarge: { url, width, height } } }

// Einzelfoto-Details
method=pwg.images.getInfo
  &image_id={id}
  → wie oben + hit (Views), comment_count, EXIF, IPTC, rating_score

// EXIF
method=pwg.images.getExif
  &image_id={id}                             → key/value Paare aller EXIF-Tags

// Suche
method=pwg.images.search
  &query={text}                              → Volltextsuche
```

### Rating (einziger Dienst mit 1-5!)

```
method=pwg.images.rate
  &image_id={id}&rate={1-5}                  → Rating setzen
```

### Tags

```
method=pwg.tags.getList                      → alle Tags
  Tag: { id, name, url_name, counter }

method=pwg.tags.getAdminList                 → alle Tags (Admin, inkl. ungenutzte)

method=pwg.tags.add
  &name={tagName}                            → neuen Tag erstellen

method=pwg.images.setTags
  &image_id={id}&tags={tagId1,tagId2}        → Tags setzen (ersetzt alle!)
```

### Foto-Metadaten setzen

```
method=pwg.images.setInfo
  &image_id={id}
  &name={title}                              → Titel
  &comment={description}                     → Beschreibung
  &author={author}                           → Autor
  &date_creation={YYYY-MM-DD}               → Aufnahmedatum
  &level={privacy_level}                     → 0=alle, 1=Kontakte, 2=Freunde, 4=Admins, 8=nur ich

method=pwg.images.setCategory
  &image_id={id}&category_id={catId}         → Foto in Kategorie verschieben
```

### Upload

```
// Einfacher Upload (Piwigo 2.7+)
method=pwg.images.upload
  → multipart/form-data mit file, category, name, etc.

// Einfacher HTTP-Upload
method=pwg.images.addSimple
  → multipart/form-data

// Chunked Upload (für große Dateien)
method=pwg.images.addChunk
  &original_sum={md5}&position={n}&type={file|thumb|high}
  + method=pwg.images.add                    → nach allen Chunks
```

### API-Browser

```
GET /tools/ws.htm                            → interaktiver API-Browser (100+ Methoden)
```

---

## Lychee (v7+)

> **HINWEIS:** Diese Dokumentation gilt für Lychee **v6.x / v7.x** (REST-API).
> Die alte RPC-API (`POST /api/v2/Albums::get`, `Album::get` mit `{albumID}` im Body,
> `Photo::setStar`, `Photo::setTitle`, …) wurde **komplett ersetzt**.
> Quelle der Wahrheit: Swagger pro Instanz unter `GET /docs/api` und
> [routes/api_v2.php auf master](https://github.com/LycheeOrg/Lychee/blob/master/routes/api_v2.php).

### Migration v4/v5 RPC → v7 REST

| alt (vor v6) | neu (v6/v7) |
|---|---|
| `POST /api/Session::login` | `POST /api/v2/Auth::login` |
| `POST /api/v2/Albums::get` | `GET /api/v2/Albums` |
| `POST /api/v2/Albums::tree` | weg — Tree rekursiv via `GET /Album::albums?album_id=…` |
| `POST /api/v2/Album::get { albumID }` | aufgespalten in `GET /Album::head`, `GET /Album::albums`, `GET /Album::photos`, `GET /Album::tags` (jeweils `?album_id=`) |
| `POST /api/v2/Albums::add` | `POST /api/v2/Album` (Singular) |
| `POST /api/v2/Albums::move` | `POST /api/v2/Album::move` |
| `POST /api/v2/Albums::delete` | `DELETE /api/v2/Album` mit Body `{ albumIds }` |
| `POST /api/v2/Album::setTitle` | `PATCH /api/v2/Album::rename` |
| `POST /api/v2/Album::setDescription` | `PATCH /api/v2/Album` (generic) |
| `POST /api/v2/Photo::add` | `POST /api/v2/Photo` (multipart, **chunked**) |
| `POST /api/v2/Photo::setTitle` | `PATCH /api/v2/Photo::rename` |
| `POST /api/v2/Photo::setDescription` | `PATCH /api/v2/Photo` (generic) |
| `POST /api/v2/Photo::setTags` | `PATCH /api/v2/Photo::tags` |
| `POST /api/v2/Photo::setStar` | `POST /api/v2/Photo::highlight` (Feldname: `is_highlighted`) |
| `POST /api/v2/Photos::move` | `POST /api/v2/Photo::move` (Singular) |
| Smart-Album `starred` | `highlighted` |

### Auth

```
// --- Option 1: Personal Access Token (empfohlen für PhotoLib) ---
Header: Authorization: Bearer {token}
Token erzeugen (UI):  Lychee → Profile → Reset Token  (einmalig im Klartext)
Token erzeugen (API): POST /api/v2/Profile::resetToken
                      → UserToken { token: "<plaintext>" }   ← einmalig speichern
Token deaktivieren:   POST /api/v2/Profile::unsetToken
.env-Voraussetzung:   ENABLE_TOKEN_AUTH=true  (default)

// --- Option 2: Session ---
POST /api/v2/Auth::login
  Body: { username, password, secret? (TOTP), remember? }
  Throttle: 10 / 60min
  → 204 + Session-Cookie + XSRF-TOKEN-Cookie
  Fehler → 401 UnauthenticatedException

POST /api/v2/Auth::logout      → 204
GET  /api/v2/Auth::user        → UserResource
GET  /api/v2/Auth::rights      → GlobalRightsResource
GET  /api/v2/Auth::config      → AuthConfig

// --- Pflicht-Header ---
Accept:       application/json
Content-Type: application/json     (entfällt bei Multipart-Upload!)
```

### Alben — Listing

```
// Wurzel-Listing (Top-Level + Smart + Tag + Shared)
GET /api/v2/Albums
  → RootAlbumResource: {
      smart_albums: { recent, on_this_day, unsorted, untagged, … },
      tag_albums:   AlbumThumbResource[],
      albums:       AlbumThumbResource[],
      shared_albums: AlbumThumbResource[],
      config:       RootConfig
    }

// Album-Header (Metadaten OHNE Children/Photos — schnelles Init für Pagination)
GET /api/v2/Album::head?album_id={id}
  → HeadAbstractAlbumResource: { rights, config,
      album: HeadAlbumResource | HeadSmartAlbumResource | HeadTagAlbumResource }

// Kind-Alben (paginiert)
GET /api/v2/Album::albums?album_id={id}&page={n}
  → PaginatedAlbumsResource

// Fotos im Album (paginiert; optional Tag-Filter)
GET /api/v2/Album::photos?album_id={id}&page={n}&tag_ids={ids}&tag_logic={and|or}
  → PaginatedPhotosResource: {
      data: PhotoResource[],
      current_page, last_page, per_page, total,
      photo_timeline, can_access_full_photo
    }

// Tags im Album
GET /api/v2/Album::tags?album_id={id}      → string[]

// Liste möglicher Ziel-Alben (für Move-Dialog, ohne sich-selbst-Move)
GET /api/v2/Album::getTargetListAlbums?albums[]={id1}&albums[]={id2}
  → TargetAlbumResource[]
```

### Alben — Mutationen

```
// Erstellen (regulär)
POST /api/v2/Album
  Body: { title: "Name", parent_album: "parentId" | null }
  → string (neue Album-ID)

// Erstellen (Tag-Album)
POST /api/v2/TagAlbum
  Body: { title, tags: ["t1","t2"], is_and: bool }
  → string

// Generisches Update
PATCH /api/v2/Album
  Body: { album: "id", title?, description?, license?, copyright?,
          aspectRatio?, photoSortingCriterion?, albumSortingCriterion?,
          photoLayout?, is_pinned?, album_timeline?, photo_timeline?,
          is_compact?, photo? (Cover-PhotoID) }
  → EditableBaseAlbumResource

PATCH /api/v2/TagAlbum
  Body: { album, title?, description?, copyright?, photoSortingCriterion?,
          photoLayout?, photo_timeline?, is_pinned?, is_and?, tags? }
  → EditableBaseAlbumResource

// Schnellaktionen
PATCH /api/v2/Album::rename       Body: { album, title }
PATCH /api/v2/Album::setPinned    Body: { album, is_pinned }

// Schutz / Sichtbarkeit
POST /api/v2/Album::updateProtectionPolicy
  Body: { album, albumProtectionPolicy: { is_public, … }, password? }
  → AlbumProtectionPolicy

// Bewegen / Mergen / Übertragen
POST /api/v2/Album::move      Body: { album: "destParent", albums: ["src1",...] }
POST /api/v2/Album::merge     Body: { album: "destId",     albums: ["src1",...] }
POST /api/v2/Album::transfer  Body: { album: "id", user2: userId }

// Cover / Header
POST  /api/v2/Album::cover    Body: { album, photo }
POST  /api/v2/Album::header   Body: { album, photo, is_compact }
PATCH /api/v2/Album::header   Body: { album, photo, is_compact }

// Audio-Track
POST   /api/v2/Album::track   Body (multipart): { album, file }
DELETE /api/v2/Album::track   Body: { album }

// Watermark auf alle Photos im Album
POST /api/v2/Album::watermark Body: { album }

// Passwort-geschütztes Album entsperren (Session-only)
POST /api/v2/Album::unlock    Body: { album, password }

// Löschen (Plural)
DELETE /api/v2/Album          Body: { albumIds: ["id1","id2"] }
```

### Fotos — Resource-Shape

```
PhotoResource: {
  id, album_id, title, description,
  type, license, tags: string[],
  created_at, updated_at, taken_at, taken_at_orig_tz,
  is_highlighted, is_validated,
  checksum, original_checksum,
  live_photo_url, live_photo_checksum, live_photo_content_id,
  size_variants: {
    thumb:    { url, width, height, filesize },
    small:    { url, width, height, filesize },
    small2x:  { url, width, height, filesize },
    medium:   { url, width, height, filesize },
    medium2x: { url, width, height, filesize },
    original: { url, width, height, filesize }
  },
  preformatted: { aperture, focal, iso, lens, make, model, shutter,
                  latitude, longitude, … },
  precomputed:  { … },
  palette?, statistics?, rating?
}
```

### Fotos — Mutationen

```
// Generisches Update
PATCH /api/v2/Photo
  Body: { photo: "id", title?, description?, uploadDate?, tags?, license?, takenAt? }
  → PhotoResource

// Schnellaktionen
PATCH /api/v2/Photo::rename   Body: { photo, title }
PATCH /api/v2/Photo::tags     Body: { photos: ["id1",…], tags: ["t1",…], shall_override: bool }
PATCH /api/v2/Photo::license  Body: { photoIds: [...], license: "CC0"|"CC-BY"|… }

// Highlight (= ehemaliger Star/Favorit)
POST /api/v2/Photo::highlight Body: { photos: ["id"], is_highlighted: bool }

// Rating (1-5, neu in v7)
POST /api/v2/Photo::setRating Body: { photo, rating: 1..5 }   → PhotoResource

// Bewegen / Kopieren
POST /api/v2/Photo::move      Body: { photos: [...], album: "destId" }
POST /api/v2/Photo::copy      Body: { photos: [...], album: "destId" }

// Drehen
POST /api/v2/Photo::rotate    Body: { photo, direction: 1 | -1 }   → PhotoResource

// Watermark
POST /api/v2/Photo::watermark Body: { photoIds: [...] }   (dispatched async)

// Reverse-Lookup: in welchen Alben ist dieses Photo?
GET /api/v2/Photo/{photo_id}/albums   → PhotoAlbumResource[]

// Random-Photo (Frame-Modus)
GET /api/v2/Photo::random

// Löschen
DELETE /api/v2/Photo          Body: { photoIds: [...], from_id?: "albumId" }
```

### Upload (chunked Multipart)

```
POST /api/v2/Photo            Content-Type: multipart/form-data
  Fields:
    album_id                   — Ziel-Album-ID oder null/"" (Wurzel)
    file                       — Binary-Chunk (Pflicht)
    file_name                  — Original-Dateiname (Pflicht)
    uuid_name                  — clientseitige UUID, **gleich für alle Chunks** einer Datei (Pflicht)
    extension                  — z.B. ".jpg" (Pflicht, validiert)
    chunk_number               — 1-basiert (Pflicht, ≥1)
    total_chunks               — Anzahl Gesamt-Chunks (Pflicht, ≥chunk_number)
    file_last_modified_time?   — Unix-Sekunden (optional)
    apply_watermark?           — bool (optional)
  → UploadMetaResource: { stage, uuid_name, extension }

  Hinweis: Bei `total_chunks=1` ist es ein Single-Shot-Upload.
           Sonst werden N Requests mit gleichem `uuid_name` gesendet;
           das Photo wird erst beim letzten Chunk persistiert.

// URL-Import (kein Multipart, kein Chunking)
POST /api/v2/Photo::fromUrl
  Body: { album: "id", urls: ["https://..."] }
  → "success"
```

### Smart-Album-IDs (v7)

```
recent                — Uploads der letzten X Tage (configurable)
highlighted           — entspricht ehemaligem "starred"
on_this_day           — Heute vor 1, 2, 3 … Jahren
unsorted              — Photos ohne Album
untagged              — Photos ohne Tags
1star … 5star         — gefiltert nach Rating
my_rated_pictures     — eigene rated photos
best_pictures         — globale Best-of (Rating ≥ Threshold)
my_best_pictures      — eigene Best-of
```

Verwendung wie reguläre Album-IDs: `GET /Album::head?album_id=highlighted`,
`GET /Album::photos?album_id=recent&page=1`.

### Profile / Token-Management

```
POST /api/v2/Profile::resetToken
  → UserToken { token: "<plaintext-bearer-token>" }
  ⚠ Token wird nur EINMAL im Klartext zurückgegeben — sofort speichern.
  ⚠ Ersetzt einen evtl. existierenden Token desselben Users.

POST /api/v2/Profile::unsetToken            → 204

POST /api/v2/Profile::update
  Body: { username, email?, oldPassword, password?, password_confirmation? }

PUT  /api/v2/Profile                        Body: { … } (generisch)
POST /api/v2/Profile::updateSharedAlbumsVisibility  Body: { … }
```

### Suche

```
GET /api/v2/Search::init                    → SearchConfig
GET /api/v2/Search?term={query}&album_id={scope?}
  → paginierte Treffer (Photos + Alben)
```

### Sharing

```
GET    /api/v2/Sharing                      → eigene Shares
GET    /api/v2/Sharing::all                 → alle (Admin)
GET    /api/v2/Sharing::albums              → teilbare Alben
POST   /api/v2/Sharing                      Body: { albums, users, … }
PUT    /api/v2/Sharing                      Body: { share_id, … }
PATCH  /api/v2/Sharing                      Body: { … }
DELETE /api/v2/Sharing                      Body: { share_ids }
```

### Diverses (selten gebraucht in PhotoLib)

```
GET /api/v2/Timeline                        — Timeline-Ansicht
GET /api/v2/Map                             — Karten-Ansicht (GPS)
GET /api/v2/Flow                            — Feed-Ansicht
GET /api/v2/Tags                            — alle Tags der Instanz
GET /api/v2/Users / Users::count            — Userliste / -count
GET /api/v2/Statistics::userSpace           — Storage-Statistik

// Embed (public, kein Auth)
GET /api/v2/Embed/{album_id}
GET /api/v2/Embed/stream
```

### Filesystem (innerhalb des Lychee-Containers/Hosts)

```
Originale:    {lychee-storage}/uploads/big/
Medium:       {lychee-storage}/uploads/medium/
Medium2x:     {lychee-storage}/uploads/medium2x/
Small:        {lychee-storage}/uploads/small/
Small2x:      {lychee-storage}/uploads/small2x/
Thumb:        {lychee-storage}/uploads/thumb/
Live-Photos:  {lychee-storage}/uploads/live/
```

### Swagger / OpenAPI

```
GET /docs/api    → interaktive OpenAPI-Doku der Instanz
                   (immer Quelle der Wahrheit, je nach installierter Version)
```

---

## LibrePhotos

**Auth:**
```
POST /api/auth/token/obtain/
  Body: { username: "...", password: "..." }
  → { access: "jwt-token", refresh: "refresh-token" }

POST /api/auth/token/refresh/
  Body: { refresh: "refresh-token" }
  → { access: "new-jwt-token" }

Header: Authorization: Bearer {access-token}
```

**Endpoints:** Base = `{serverUrl}/api`

### Fotos

```
// Alle Fotos (paginiert)
GET /photos                                  → Photo[] (DRF-paginated)
GET /photos/notimestamp                       → Fotos ohne Timestamp
GET /photos/recentlyadded                    → kürzlich hinzugefügt
GET /photos/searchlist                       → Suchliste

// Foto-Details
GET /photos/{id}                             → Photo Detail

// Foto bearbeiten
POST /photosedit/favorite                    → Favorit setzen/entfernen
  Body: { image_hashes: ["hash1"], favorite: true }
POST /photosedit/hide                        → Foto verstecken
POST /photosedit/delete                      → Foto löschen
POST /photosedit/setdeleted                  → als gelöscht markieren
POST /photosedit/makepublic                  → öffentlich machen
POST /photosedit/share                       → teilen
POST /photosedit/generateim2txt              → Bildbeschreibung generieren
POST /photosedit/savecaption                 → Beschreibung speichern
POST /photosedit/rotate                      → Foto rotieren

// Metadaten
GET /photos/{photo_id}/metadata              → Metadaten mit History
POST /savemetadata                           → Metadaten speichern
```

### Gesichter

```
GET /faces                                   → Face[]
GET /faces/incomplete                        → unvollständige Gesichter

POST /labelfaces                             → Gesicht benennen
POST /deletefaces                            → Gesicht löschen
POST /trainfaces                             → Gesichtserkennung trainieren
POST /scanfaces                              → Gesichter scannen
GET /clusterfaces                            → Gesichter clustern
```

### Alben

```
// Auto-generierte Alben
GET /albums/auto/list                        → Auto-Album-Liste
GET /albums/auto/{id}                        → Auto-Album Details

// Datums-Alben
GET /albums/date/list                        → Datums-Album-Liste
GET /albums/date/{id}                        → Datums-Album

// Themen-Alben
GET /albums/thing/list                       → Thing-Album-Liste
GET /albums/thing/{id}                       → Thing-Album

// Orts-Alben
GET /albums/place/list                       → Place-Album-Liste
GET /albums/place/{id}                       → Place-Album

// Personen-Alben
GET /albums/person/{id}                      → Person-Album

// User-Alben (manuell)
GET /albums/user/list                        → User-Album-Liste
GET /albums/user/{id}                        → User-Album
POST /albums/user/edit                       → Album bearbeiten

// Geteilte Alben
GET /albums/user/shared/tome                 → mit mir geteilt
GET /albums/user/shared/fromme               → von mir geteilt
POST /useralbum/share                        → Album teilen
POST /useralbum/makepublic                   → Album öffentlich machen
```

### Ordner

```
GET /folders                                 → Ordner-Struktur
GET /dirtree                                 → Verzeichnisbaum
```

### Stacks (Foto-Gruppierung)

```
POST /stacks/detect                          → Stacks automatisch erkennen
GET /stacks/stats                            → Stack-Statistiken
POST /stacks/manual                          → manuellen Stack erstellen
POST /stacks/merge                           → Stacks zusammenführen
```

### Duplikate

```
POST /duplicates/detect                      → Duplikate erkennen
GET /duplicates/stats                        → Duplikat-Statistiken
```

### Upload

```
POST /upload/                                → Foto hochladen (multipart)
POST /upload/complete/                       → Upload abschließen
GET /exists                                  → prüfen ob Datei existiert
```

### Scanning

```
POST /scanphotos                             → Fotos scannen
POST /scanuploadedphotos                     → hochgeladene scannen
POST /fullscanphotos                         → vollständiger Scan
POST /deletemissingphotos                    → fehlende Fotos entfernen
POST /autoalbumgen                           → Auto-Alben generieren
POST /autoalbumtitlegen                      → Auto-Album-Titel generieren
```

### Statistiken & Analytics

```
GET /stats                                   → allgemeine Statistiken
GET /storagestats                            → Speicher-Statistiken
GET /serverstats                             → Server-Statistiken
GET /serverlogs                              → Server-Logs
GET /photomonthcounts                        → Fotos pro Monat
GET /wordcloud                               → Wort-Wolke (aus Tags/Beschreibungen)
GET /locationsunburst                        → Standort-Sunburst
GET /locationtimeline                        → Standort-Timeline
GET /locclust                                → Location-Clustering
GET /socialgraph                             → Sozialer Graph (wer mit wem auf Fotos)
```

### Personen

```
GET /persons                                 → alle erkannten Personen
```

### Einstellungen

```
GET /sitesettings                            → Site-Einstellungen
POST /firsttimesetup                         → Ersteinrichtung
GET /timezones                               → verfügbare Zeitzonen
GET /searchtermexamples                      → Such-Beispiele
```

### Öffentliche Alben

```
GET /public/albums/s/{slug}/                 → öffentliches Album
GET /public/albums/s/{slug}/photos/{photo_id}/  → Foto in öffentlichem Album
```

### Foto-Dateien

```
GET /photos/{image_hash}/file/{file_hash}    → Datei-Variante
POST /photos/{image_hash}/main-file          → Hauptdatei setzen
GET /photos/download                         → Download
```

### Services

```
GET /services                                → Services listen
GET /services/{id}                           → Service-Details
POST /services/{id}/start                    → Service starten
POST /services/{id}/stop                     → Service stoppen
```

### Tags

```
GET /imagetag                                → Bild-Tags
```

### User-Management

```
GET /user                                    → aktueller User
GET /manage/user                             → User verwalten (Admin)
DELETE /delete/user                           → User löschen
```

### API-Docs (nur im Debug-Modus)

```
GET /swagger                                 → Swagger UI
GET /redoc                                   → ReDoc
GET /schema                                  → OpenAPI Schema
```

---

## Nextcloud Photos

**Auth:**
```
// Basic Auth (mit App-Password empfohlen)
Authorization: Basic base64({username}:{app-password})

// Header für OCS-Requests:
OCS-APIRequest: true
```

**Basis-URLs:**
- WebDAV: `{serverUrl}/remote.php/dav`
- OCS: `{serverUrl}/ocs/v1.php` oder `/ocs/v2.php`
- Preview: `{serverUrl}/core/preview`

### Dateien (WebDAV)

```
// Dateien/Ordner listen
PROPFIND /remote.php/dav/files/{user}/{path}
  Header: Depth: 1
  Body: <?xml version="1.0"?>
    <d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
      <d:prop>
        <d:getcontenttype/><d:getcontentlength/><d:getlastmodified/>
        <oc:id/><oc:fileid/><oc:size/>
        <nc:has-preview/>
      </d:prop>
    </d:propfind>

// Datei herunterladen
GET /remote.php/dav/files/{user}/{path}

// Datei hochladen
PUT /remote.php/dav/files/{user}/{path}
  Body: Datei-Bytes
  Header: X-OC-MTime: {timestamp}            // optional: Modification-Time setzen
          X-NC-WebDAV-AutoMkcol: 1            // optional: fehlende Ordner erstellen

// Ordner erstellen
MKCOL /remote.php/dav/files/{user}/{path}

// Datei/Ordner löschen
DELETE /remote.php/dav/files/{user}/{path}

// Datei verschieben
MOVE /remote.php/dav/files/{user}/{path}
  Header: Destination: {serverUrl}/remote.php/dav/files/{user}/{newPath}
          Overwrite: T|F

// Datei kopieren
COPY /remote.php/dav/files/{user}/{path}
  Header: Destination: ...
```

### Previews/Thumbnails

```
// Preview per fileId (empfohlen)
GET /core/preview?fileId={fileId}&x={width}&y={height}
  // Auth via Basic Auth Header
  // Gibt JPEG zurück, 404 wenn kein Preview verfügbar

// Preview per Pfad
GET /core/preview?file={path}&x={width}&y={height}

// Gängige Größen: x=256&y=256 (Thumb), x=1024&y=1024 (Preview)
```

### Favoriten (WebDAV)

```
// Favorit setzen
PROPPATCH /remote.php/dav/files/{user}/{path}
  Body: <?xml version="1.0"?>
    <d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
      <d:set><d:prop>
        <oc:favorite>1</oc:favorite>
      </d:prop></d:set>
    </d:propertyupdate>
  // 0 = unfavorite, 1 = favorite

// Alle Favoriten listen
REPORT /remote.php/dav/files/{user}
  Body: <?xml version="1.0"?>
    <oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
      <d:prop><d:getcontenttype/><oc:fileid/></d:prop>
      <oc:filter-rules>
        <oc:favorite>1</oc:favorite>
      </oc:filter-rules>
    </oc:filter-files>
```

### Tags (SystemTags WebDAV)

```
// Alle Tags listen
PROPFIND /remote.php/dav/systemtags
  Body: <?xml version="1.0"?>
    <d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
      <d:prop>
        <oc:id/><oc:display-name/><oc:user-visible/><oc:user-assignable/>
      </d:prop>
    </d:propfind>

// Tag erstellen
POST /remote.php/dav/systemtags
  Body: {"name":"tagname","userVisible":"true","userAssignable":"true"}
  → 201 Created

// Tag aktualisieren
PROPPATCH /remote.php/dav/systemtags/{tagId}
  Body: XML propertyupdate mit display-name

// Tag löschen
DELETE /remote.php/dav/systemtags/{tagId}
  → 204 No Content

// Tag zu Datei zuweisen
PUT /remote.php/dav/systemtags-relations/files/{fileId}/{tagId}
  → 201 Created

// Tag von Datei entfernen
DELETE /remote.php/dav/systemtags-relations/files/{fileId}/{tagId}
  → 204 No Content

// Tags einer Datei listen
PROPFIND /remote.php/dav/systemtags-relations/files/{fileId}

// Tag erstellen und sofort zuweisen (atomar)
POST /remote.php/dav/systemtags-relations/files/{fileId}
  Body: {"name":"tagname","userVisible":"true","userAssignable":"true"}

// Dateien nach Tag suchen
REPORT /remote.php/webdav/
  Body: <?xml version="1.0"?>
    <oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
      <d:prop><d:getcontenttype/><oc:fileid/></d:prop>
      <oc:filter-rules>
        <oc:systemtag>{tagId}</oc:systemtag>
      </oc:filter-rules>
    </oc:filter-files>
```

### OCS Endpoints

```
// User-Info
GET /ocs/v1.php/cloud/users/{userId}         → User-Metadaten
  Response: OCS-Format { ocs: { data: { ... } } }

// Capabilities (welche Features aktiv)
GET /ocs/v1.php/cloud/capabilities           → Server + App Capabilities

// Direct Download Link (8h gültig)
POST /ocs/v2.php/apps/dav/api/v1/direct
  Body: fileId={fileId}
  → { url: "https://..." }
```

### Photos App (WebDAV Albums, NC 25+)

```
// Alben listen
PROPFIND /remote.php/dav/photos/{user}/albums
  Header: Depth: 1
  Props: nc:last-photo, nc:nbItems, nc:location, nc:dateRange, nc:collaborators

// Album erstellen
MKCOL /remote.php/dav/photos/{user}/albums/{albumName}

// Fotos in Album listen
PROPFIND /remote.php/dav/photos/{user}/albums/{albumName}
  Header: Depth: 1

// Foto zu Album hinzufügen
COPY /remote.php/dav/files/{user}/{photoPath}
  Header: Destination: {serverUrl}/remote.php/dav/photos/{user}/albums/{albumName}/{filename}

// Foto aus Album entfernen (entfernt nur Verknüpfung, nicht Datei)
DELETE /remote.php/dav/photos/{user}/albums/{albumName}/{filename}

// Album löschen
DELETE /remote.php/dav/photos/{user}/albums/{albumName}

// Geteilte Alben
PROPFIND /remote.php/dav/photos/{user}/sharedalbums
  Header: Depth: 1

// Gesichter (Recognize App, NC 25+)
PROPFIND /remote.php/dav/photos/{user}/faces
PROPFIND /remote.php/dav/photos/{user}/faces/{faceName}

// Orte
PROPFIND /remote.php/dav/photos/{user}/places
PROPFIND /remote.php/dav/photos/{user}/places/{placeName}
```

### EXIF-Metadaten (WebDAV, NC 28+)

```
// EXIF-Properties in PROPFIND abfragen
PROPFIND /remote.php/dav/files/{user}/{path}
  Props:
    nc:metadata-photos-exif              → vollständiges EXIF als JSON
    nc:metadata-photos-size              → { width, height }
    nc:metadata-photos-gps               → { latitude, longitude }
    nc:metadata-photos-original_date_time → "2024-03-15T14:30:00+00:00"
    nc:metadata-photos-place             → "Paris, France"
```

### Sidecar via WebDAV

```
// .photolib Ordner erstellen
MKCOL /remote.php/dav/files/{user}/{photoDir}/.photolib

// Sidecar schreiben
PUT /remote.php/dav/files/{user}/{photoDir}/.photolib/{filename}.json
  Body: JSON-Daten

// Sidecar lesen
GET /remote.php/dav/files/{user}/{photoDir}/.photolib/{filename}.json
```

---

## Ente (End-to-End Encrypted)

**ACHTUNG:** Ente verschlüsselt alles client-seitig. API gibt nur verschlüsselte Blobs zurück!

**Auth:**
```
// 1. OTT (One-Time Token) anfordern
POST /users/ott
  Body: { email: "user@example.com" }
  → OTT wird per E-Mail gesendet

// 2. E-Mail verifizieren
POST /users/verify-email
  Body: { email: "...", ott: "..." }
  → { keyAttributes, encryptedToken, ... }

// 3. SRP-Session erstellen
POST /users/srp/create-session
  Body: { srpUserID, srpA }
  → { sessionID, srpB }

// 4. SRP-Session verifizieren
POST /users/srp/verify-session
  Body: { sessionID, srpM1 }
  → { id (auth token), keyAttributes, encryptedToken }

// Danach:
Header: X-Auth-Token: {token}
```

### Encryption Architecture

```
Algorithmen:
  Key-Derivation: Argon2id (min 128 MiB Memory)
  Symmetric Keys: XSalsa20 + Poly1305 (crypto_secretbox_easy)
  File Data:      XChaCha20 + Poly1305 (crypto_secretstream, chunked)
  Asymmetric:     X25519 + XSalsa20 + Poly1305 (crypto_box_seal)
  Alle Keys:      256-bit

Key-Hierarchie:
  password → keyEncryptionKey (Argon2id)
           → masterKey (entschlüsselt mit keyEncryptionKey)
             → collectionKey (entschlüsselt mit masterKey)
               → fileKey (entschlüsselt mit collectionKey)
                 → Datei/Thumbnail/Metadaten (entschlüsselt mit fileKey)

Decryption-Flow:
  1. Password → Argon2id → keyEncryptionKey
  2. keyEncryptionKey → decrypt(encryptedMasterKey) → masterKey
  3. masterKey → decrypt(encryptedCollectionKey) → collectionKey
  4. collectionKey → decrypt(encryptedFileKey) → fileKey
  5. fileKey → crypto_secretstream_pull → Datei-Chunks
```

### Collections (Alben)

```
// Collections listen
GET /collections                             → Collection[]
GET /collections/v2                          → mit mehr Details
GET /collections/v3                          → mit Limit/Pagination

// Collection-Details
GET /collections/{collectionId}              → Collection

// Collection erstellen
POST /collections
  Body: { encryptedKey, keyDecryptionNonce, name (encrypted), ... }

// Collection umbenennen
POST /collections/rename
  Body: { collectionID, encryptedName, nameDecryptionNonce }

// Magic Metadata (verschlüsselt)
PUT /collections/magic-metadata              → private Metadaten
PUT /collections/public-magic-metadata       → öffentliche Metadaten

// Collection teilen
POST /collections/share                      → mit User teilen
POST /collections/unshare                    → Teilen aufheben
GET /collections/sharees                     → geteilte User
POST /collections/leave/{collectionId}       → Collection verlassen
POST /collections/share-url                  → Share-URL erstellen
PUT /collections/share-url                   → Share-URL aktualisieren
DELETE /collections/share-url/{collectionId} → Share-URL löschen

// Dateien in Collection
POST /collections/add-files                  → Dateien hinzufügen
POST /collections/move-files                 → Dateien verschieben
POST /collections/v3/remove-files            → Dateien entfernen
POST /collections/restore-files              → Dateien wiederherstellen

// Änderungen (Sync)
GET /collections/v2/diff                     → Änderungen seit Token
  Params: sinceTime={timestamp}

// Collection löschen
DELETE /collections/v3/{collectionId}        → in Papierkorb
```

### Dateien (verschlüsselt)

```
// Datei erstellen/aktualisieren
POST /files                                  → verschlüsselte Datei registrieren
  Body: { collectionID, encryptedKey, keyDecryptionNonce,
          file: { encryptedData, decryptionHeader },
          thumbnail: { encryptedData, decryptionHeader },
          metadata: { encryptedData, decryptionHeader } }
PUT /files/update                            → Datei aktualisieren

// Upload-URLs
GET /files/upload-urls                       → Pre-signed Upload URLs
POST /files/upload-url                       → Upload URL (v2)
GET /files/multipart-upload-urls             → Multipart Upload URLs

// Datei-Daten abrufen
POST /files/data/fetch                       → Datei-Daten (batch)
GET /files/data/fetch                        → einzelne Datei-Daten
GET /files/count                             → Gesamt-Dateianzahl

// Download (verschlüsselt!)
GET /files/download/{fileId}                 → verschlüsselte Datei
GET /files/download/v2/{fileId}              → v2 Download

// Thumbnail (verschlüsselt!)
GET /files/preview/{fileId}                  → verschlüsselter Thumbnail
GET /files/preview/v2/{fileId}               → v2 Thumbnail
GET /files/data/preview-upload-url           → Upload-URL für Preview
GET /files/data/preview                      → Preview-URL

// Datei-Info
POST /files/info                             → Datei-Informationen
POST /files/size                             → Dateigröße

// Datei-Metadaten
PUT /files/data                              → Datei-Daten setzen
PUT /files/video-data                        → Video-Daten setzen
PUT /files/magic-metadata                    → Magic Metadata (verschlüsselt)
PUT /files/public-magic-metadata             → öffentliche Magic Metadata
PUT /files/thumbnail                         → Thumbnail aktualisieren
POST /files/data/status-diff                 → Status-Diff

// Kopieren
POST /files/copy                             → Dateien kopieren

// Duplikate
GET /files/duplicates                        → Duplikate finden
GET /files/large-thumbnails                  → große Thumbnails

// Share-URLs
POST /files/share-url                        → Share-Link erstellen
GET /files/share-url                         → Share-Links abrufen
PUT /files/share-url                         → Share-Link aktualisieren
DELETE /files/share-url/{fileId}             → Share-Link löschen
```

### Papierkorb

```
GET /trash/diff                              → Papierkorb-Änderungen
GET /trash/v2/diff                           → v2 Papierkorb-Diff
POST /trash/delete                           → endgültig löschen
POST /trash/empty                            → Papierkorb leeren
```

### User-Management

```
GET /users/details/v2                        → User-Details
GET /users/public-key                        → öffentlicher Schlüssel
GET /users/session-validity/v2               → Session prüfen
POST /users/logout                           → Logout
GET /users/sessions                          → aktive Sessions
DELETE /users/session                        → Session beenden
POST /users/change-email                     → E-Mail ändern
DELETE /users/delete                         → Account löschen

// 2FA
GET /users/two-factor/status                 → 2FA-Status
POST /users/two-factor/setup                 → 2FA einrichten
POST /users/two-factor/enable                → 2FA aktivieren
POST /users/two-factor/disable               → 2FA deaktivieren

// Passkeys
GET /passkeys                                → Passkeys listen
POST /passkeys/registration/begin            → Registrierung starten
POST /passkeys/registration/finish           → Registrierung abschließen
DELETE /passkeys/{passkeyId}                 → Passkey löschen
```

### Memory Shares

```
POST /memory-share                           → Memory-Share erstellen
GET /memory-share                            → alle Memory-Shares
GET /memory-share/{shareId}                  → Share-Details
DELETE /memory-share/{shareId}               → Share löschen
```

### Wichtig für PhotoLib

```
PROBLEM: Jede heruntergeladene Datei muss client-seitig entschlüsselt werden!
  1. fileKey aus Collection-Response entschlüsseln (masterKey → collectionKey → fileKey)
  2. Verschlüsselte Datei herunterladen (GET /files/download/{id})
  3. crypto_secretstream_pull mit fileKey → Klartext-Datei
  4. Dasselbe für Thumbnails (GET /files/preview/{id})

BENÖTIGT: libsodium-wrappers (npm) für alle Crypto-Operationen
```

---

## Dropbox (API v2)

**Auth:**
```
// OAuth 2.0 PKCE
Auth URL:  https://www.dropbox.com/oauth2/authorize
Token URL: https://api.dropboxapi.com/oauth2/token
Params:    token_access_type=offline  (für Refresh Token)

Header: Authorization: Bearer {accessToken}
Content-Type: application/json       (für JSON-Endpoints)
```

### Account

```
POST https://api.dropboxapi.com/2/users/get_current_account
  Body: null                                 → Account-Info
```

### Dateien

```
// Ordner auflisten
POST https://api.dropboxapi.com/2/files/list_folder
  Body: { path: "/Photos", recursive: true, limit: 500,
          include_media_info: true }
  → { entries: Entry[], has_more: bool, cursor: string }
  Entry: { .tag: "file"|"folder", name, path_display, id,
           size, server_modified, content_hash,
           media_info: { metadata: { dimensions: {width,height},
                                     time_taken, location: {latitude,longitude} } } }

// Pagination
POST https://api.dropboxapi.com/2/files/list_folder/continue
  Body: { cursor: "..." }

// Metadaten einer Datei
POST https://api.dropboxapi.com/2/files/get_metadata
  Body: { path: "/photo.jpg", include_media_info: true }
```

### Thumbnails & Download

```
// Thumbnail
POST https://content.dropboxapi.com/2/files/get_thumbnail_v2
  Header: Dropbox-API-Arg: {"resource":{".tag":"path","path":"/photo.jpg"},
           "size":{".tag":"w256h256"}, "format":{".tag":"jpeg"}}
  Sizes: w32h32, w64h64, w128h128, w256h256, w480h320, w640h480,
         w960h640, w1024h768, w2048h1536

// Download
POST https://content.dropboxapi.com/2/files/download
  Header: Dropbox-API-Arg: {"path":"/photo.jpg"}
  → Datei als Response-Body

// Temporärer Download-Link (4h gültig)
POST https://api.dropboxapi.com/2/files/get_temporary_link
  Body: { path: "/photo.jpg" }
  → { link: "https://..." }
```

### Schreiben

```
// Upload (max 150MB, darüber: upload_session)
POST https://content.dropboxapi.com/2/files/upload
  Header: Dropbox-API-Arg: {"path":"/.photolib/data.json","mode":"overwrite"}
  Body: Datei-Bytes

// Ordner erstellen
POST https://api.dropboxapi.com/2/files/create_folder_v2
  Body: { path: "/.photolib" }

// Datei verschieben
POST https://api.dropboxapi.com/2/files/move_v2
  Body: { from_path: "/a/photo.jpg", to_path: "/b/photo.jpg" }

// Datei löschen
POST https://api.dropboxapi.com/2/files/delete_v2
  Body: { path: "/photo.jpg" }
```

---

## Google Drive (API v3)

**Auth:**
```
// OAuth 2.0 PKCE
Auth URL:  https://accounts.google.com/o/oauth2/v2/auth
Token URL: https://oauth2.googleapis.com/token
Scopes:    https://www.googleapis.com/auth/drive.readonly
           https://www.googleapis.com/auth/drive.file  (nur eigene Dateien)
           https://www.googleapis.com/auth/drive       (voller Zugriff)

Header: Authorization: Bearer {accessToken}
```

**Endpoints:** Base = `https://www.googleapis.com/drive/v3`

### Dateien

```
// Verbindungstest
GET /about?fields=user                       → User-Info

// Dateien in Ordner
GET /files?q='{folderId}' in parents and trashed=false
  &fields=nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,
           thumbnailLink,imageMediaMetadata)
  &pageSize=500
  imageMediaMetadata: { width, height, cameraMake, cameraModel, focalLength,
                        aperture, isoSpeed, exposureTime, rotation,
                        location: { latitude, longitude, altitude } }

// Nur Bilder
GET /files?q=mimeType contains 'image/' and '{folderId}' in parents

// Alle Ordner
GET /files?q=mimeType='application/vnd.google-apps.folder'

// Download
GET /files/{id}?alt=media                    → Datei als Response

// Thumbnail
// thumbnailLink aus files.list Response, Größe via URL-Param:
// https://lh3.googleusercontent.com/...=s300
```

### Schreiben

```
// Datei erstellen (Upload)
POST /upload/drive/v3/files?uploadType=multipart
  Body: multipart (metadata JSON + file bytes)
  Metadata: { name: "photo.jpg", parents: ["{folderId}"] }

// Datei aktualisieren
PATCH /upload/drive/v3/files/{id}?uploadType=media
  Body: neue Datei-Bytes

// Titel/Name setzen
PATCH /files/{id}
  Body: { name: "Neuer Name.jpg" }

// Ordner erstellen
POST /files
  Body: { name: "FolderName", mimeType: "application/vnd.google-apps.folder",
          parents: ["{parentId}"] }

// Datei verschieben
PATCH /files/{id}?addParents={newFolderId}&removeParents={oldFolderId}
```

### Shared Drives

```
GET /drives                                  → Drive[]
GET /files?driveId={id}&includeItemsFromAllDrives=true&supportsAllDrives=true
```

### Changes (Delta)

```
GET /changes/startPageToken                  → Start-Token
GET /changes?pageToken={token}               → Änderungen seit Token
```

---

## OneDrive (Microsoft Graph API)

**Auth:**
```
// OAuth 2.0 PKCE
Auth URL:  https://login.microsoftonline.com/common/oauth2/v2.0/authorize
Token URL: https://login.microsoftonline.com/common/oauth2/v2.0/token
Scopes:    Files.Read Files.ReadWrite User.Read offline_access

Header: Authorization: Bearer {accessToken}
```

**Endpoints:** Base = `https://graph.microsoft.com/v1.0`

### Dateien

```
// Verbindungstest
GET /me                                      → User-Info

// Ordner auflisten
GET /me/drive/items/{id}/children
  &$expand=thumbnails
  &$select=id,name,size,file,folder,photo,image,lastModifiedDateTime
  Item: { id, name, size, file: { mimeType }, folder: { childCount },
          photo: { cameraMake, cameraModel, fNumber, focalLength,
                   iso, exposureNumerator, exposureDenominator, takenDateTime },
          image: { width, height },
          location: { latitude, longitude, altitude },
          thumbnails: [{ small, medium, large: { url, width, height } }] }

// Pfad-basiert
GET /me/drive/root:/{path}:/children

// Special Folders
GET /me/drive/special/cameraroll             → Camera Roll Ordner
GET /me/drive/special/photos                 → Fotos Ordner

// Download
GET /me/drive/items/{id}/content             → 302 Redirect zu Download-URL
```

### Thumbnails

```
GET /me/drive/items/{id}/thumbnails
  → [{ small: {url,w,h}, medium: {url,w,h}, large: {url,w,h} }]

// Custom Größe:
GET /me/drive/items/{id}/thumbnails/0/{size}
  size: c{w}x{h}  (crop) oder {w}x{h}
```

### Schreiben

```
// Datei erstellen/schreiben
PUT /me/drive/items/{parentId}:/{filename}:/content
  Body: Datei-Bytes
  // Für Dateien > 4MB: Upload Session
  POST /me/drive/items/{parentId}:/{filename}:/createUploadSession

// Ordner erstellen
POST /me/drive/items/{parentId}/children
  Body: { name: "FolderName", folder: {} }

// Datei umbenennen
PATCH /me/drive/items/{id}
  Body: { name: "Neuer Name.jpg" }

// Datei verschieben
PATCH /me/drive/items/{id}
  Body: { parentReference: { id: "{newParentId}" } }
```

### Delta API (Inkrementeller Sync)

```
GET /me/drive/root/delta                     → geänderte Items seit letztem Call
  → { value: Item[], @odata.deltaLink: "..." }
GET /me/drive/root/delta?token={deltaToken}  → nächste Änderungen
```

### Webhooks

```
POST /subscriptions
  Body: { changeType: "updated", notificationUrl: "{webhookUrl}",
          resource: "/me/drive/root", expirationDateTime: "..." }
  // Max 30 Tage, muss erneuert werden
```

---

## Google Photos (Picker API — einzig nutzbare Option)

**Auth:**
```
// OAuth 2.0 für Picker
// Client-ID aus Google Cloud Console
```

**Picker Integration:**
```javascript
const picker = new google.picker.PickerBuilder()
  .addView(google.picker.ViewId.PHOTOS)
  .addView(google.picker.ViewId.PHOTO_ALBUMS)
  .setOAuthToken(accessToken)
  .setCallback(pickerCallback)
  .build()
picker.setVisible(true)

function pickerCallback(data) {
  if (data.action === 'picked') {
    data.docs.forEach(doc => {
      doc.id, doc.name, doc.mimeType, doc.url, doc.thumbnails
    })
  }
}
```

### Nach Picker-Auswahl: Library API

```
// Einzelnes Foto (nur wenn via Picker ausgewählt)
GET https://photoslibrary.googleapis.com/v1/mediaItems/{id}
  → { id, baseUrl, mimeType, filename,
      mediaMetadata: { creationTime, width, height,
        photo: { cameraMake, cameraModel, focalLength, apertureFNumber,
                 isoEquivalent, exposureTime } } }

// Thumbnail: baseUrl + "=w300-h300"     (beliebige Größe)
// Download:  baseUrl + "=d"             (Original mit EXIF)
// ACHTUNG: baseUrl verfällt nach 60 Minuten!

// Upload (in app-eigenes Album)
POST https://photoslibrary.googleapis.com/v1/uploads
  Header: X-Goog-Upload-Protocol: raw
  Body: Datei-Bytes
  → uploadToken

POST https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate
  Body: { albumId: "...", newMediaItems: [{ simpleMediaItem: { uploadToken } }] }

// Album erstellen (nur eigene)
POST https://photoslibrary.googleapis.com/v1/albums
  Body: { album: { title: "Name" } }
```

**Limitierungen:**
- 10.000 API Requests/Tag, 75.000 Media-Byte-Requests/Tag
- baseUrl verfällt nach 60min → muss regelmäßig neu abgerufen werden
- Kein GPS über API verfügbar
- Kein programmatisches Browsen der vollen Bibliothek
- Titel/Beschreibung nur für eigene Medien änderbar

---

## Flickr (REST API)

**Auth:**
```
// OAuth 1.0a (komplexer als PKCE!)
Request Token: https://www.flickr.com/services/oauth/request_token
Authorize:     https://www.flickr.com/services/oauth/authorize
Access Token:  https://www.flickr.com/services/oauth/access_token

// Jeder Request braucht oauth_signature (HMAC-SHA1)
// API-Key aus https://www.flickr.com/services/apps/create/

// Alle REST-Calls:
GET https://www.flickr.com/services/rest/
  ?method={method}&api_key={key}&format=json&nojsoncallback=1
  // + oauth_* Parameter für signierte Requests
```

### Fotos

```
// Fotos suchen
method=flickr.photos.search
  &user_id=me                               → eigene Fotos
  &tags=landscape,sunset                     → Tag-Filter
  &text=mountains                            → Volltextsuche
  &min_taken_date=2024-01-01
  &bbox=lon1,lat1,lon2,lat2                  → Geo Bounding Box
  &per_page=500&page=1
  &extras=url_sq,url_t,url_s,url_m,url_l,url_o,date_taken,geo,tags,machine_tags,views
  Photo: { id, owner, secret, server, farm, title, ispublic,
           url_sq, url_t, url_s, url_m, url_l, url_o,
           datetaken, latitude, longitude, tags }

// Foto-Info
method=flickr.photos.getInfo
  &photo_id={id}
  → { title, description, dates, tags: [{raw, _content}],
      location: {latitude, longitude, accuracy}, urls, usage }

// Alle Größen
method=flickr.photos.getSizes
  &photo_id={id}
  → [{ label, source, url, width, height }]
  Labels: Square(75), Thumbnail(100), Small(240,320,400),
          Medium(500,640,800), Large(1024,1600,2048),
          X-Large(3k,4k,5k,6k), Original

// Thumbnail URL-Schema (ohne API-Call):
https://live.staticflickr.com/{server}/{id}_{secret}_{suffix}.jpg
  suffix: s(75sq) q(150sq) t(100) m(240) n(320) w(400) (500) z(640)
          c(800) b(1024) h(1600) k(2048)

// EXIF
method=flickr.photos.getExif
  &photo_id={id}
  → [{ tagspace, tag, label, raw }]         → alle EXIF/XMP Tags

// GPS
method=flickr.photos.geo.getLocation
  &photo_id={id}
  → { latitude, longitude, accuracy, context }
```

### Alben (Photosets)

```
method=flickr.photosets.getList
  &user_id={userId}&per_page=500
  Photoset: { id, title, description, photos, count_views,
              date_create, date_update, primary }

method=flickr.photosets.getPhotos
  &photoset_id={id}&extras=url_sq,url_m,url_o,date_taken,geo,tags

// Collections (übergeordnete Ordner)
method=flickr.collections.getTree
  &user_id={userId}
  → verschachtelter Baum von Collections > Sets
```

### Schreiben (braucht OAuth 1.0a Signatur!)

```
// Tags setzen
method=flickr.photos.addTags
  &photo_id={id}&tags="tag1 tag2"

method=flickr.photos.removeTag
  &tag_id={tagId}

// Favorit
method=flickr.favorites.add
  &photo_id={id}
method=flickr.favorites.remove
  &photo_id={id}

// Titel/Beschreibung
method=flickr.photos.setMeta
  &photo_id={id}&title={title}&description={desc}

// GPS setzen
method=flickr.photos.geo.setLocation
  &photo_id={id}&lat={lat}&lon={lon}

// Upload
POST https://up.flickr.com/services/upload/
  multipart: photo={file}, title, description, tags, is_public, is_friend, is_family

// Foto ersetzen
POST https://up.flickr.com/services/replace/
  multipart: photo={file}, photo_id={id}

// Album erstellen
method=flickr.photosets.create
  &title={title}&primary_photo_id={photoId}

// Foto zu Album
method=flickr.photosets.addPhoto
  &photoset_id={id}&photo_id={photoId}
```

**Limits:** 3.600 Requests/Stunde pro API-Key.
**Free-Accounts:** Kein Original-Download via API.

---

## SmugMug (API v2)

**Auth:**
```
// OAuth 1.0a (wie Flickr)
Request Token: https://api.smugmug.com/services/oauth/1.0a/getRequestToken
Authorize:     https://api.smugmug.com/services/oauth/1.0a/authorize
Access Token:  https://api.smugmug.com/services/oauth/1.0a/getAccessToken

// Braucht aktives SmugMug-Abo
```

**Endpoints:** Base = `https://api.smugmug.com/api/v2`

### Navigation

```
// User-Root
GET /user/{nickname}                         → User mit Links

// Ordner navigieren (pfad-basiert)
GET /folder/user/{username}                  → Root-Folder
GET /folder/user/{username}/Path/SubPath     → Sub-Folder
  → { Uris: { Folders, FolderAlbums, FolderPages } }

// Sub-Ordner
GET {FoldersUri}                             → Folder[]
  Folder: { Name, UrlName, Description, DateAdded, DateModified,
            Privacy, Uris: { ... } }

// Alben in Ordner
GET {FolderAlbumsUri}                        → Album[]
  Album: { AlbumKey, Name, UrlName, ImageCount, Description, ... }

// Nodes (generische Abstraktion)
GET /node/{nodeId}                           → Node
GET /node/{nodeId}!children                  → Kinder (Ordner + Alben gemischt)
  Node: { NodeID, Name, Type: "Folder"|"Album"|"Page", UrlName }
```

### Fotos

```
GET /album/{albumKey}!images                 → Image[]
  &_expand=ImageSizes
  Image: { ImageKey, FileName, Title, Caption, Keywords, Format,
           OriginalWidth, OriginalHeight, OriginalSize, DateTimeOriginal,
           Latitude, Longitude, Aperture, FocalLength, ISO }

// Thumbnails (in ImageSizes-Expansion):
  ImageSizes: { TinyImageUrl, ThumbImageUrl, SmallImageUrl, MediumImageUrl,
                LargeImageUrl, XLargeImageUrl, X2LargeImageUrl, X3LargeImageUrl,
                OriginalImageUrl }
```

### Schreiben

```
// Upload
POST https://upload.smugmug.com/
  Header: X-Smug-AlbumUri: /api/v2/album/{albumKey}
          X-Smug-FileName: photo.jpg
  Body: Datei-Bytes
  // Max 500MB/Foto, 3GB/Video

// Foto-Metadaten setzen
PATCH /image/{imageKey}
  Body: { Title, Caption, Keywords, ... }

// Ordner erstellen
POST /folder/user/{username}/{path}!folders
  Body: { Name: "NewFolder", UrlName: "newFolder", Privacy: "Private" }

// Album erstellen
POST /folder/user/{username}/{path}!albums
  Body: { Name: "Album", UrlName: "album" }
```

**Limits:** Max 5.001 Items pro Ordner/Album. Max 5 Ordner-Ebenen.

---

## Nicht-API Verbindungen

### SMB / CIFS (Windows-Shares, NAS)

```
// Kein Browser-API — braucht Backend-Proxy
mount -t cifs //server/share /mnt/photos -o username=user,password=pass

// Node.js (@nicedoc/smb2):
const files = await smb.readdir('Photos/')
const data = await smb.readFile('Photos/photo.jpg')
await smb.writeFile('Photos/.photolib/source.dat', buffer)
```

### FTP / SFTP

```
// FTP (basic-ftp):
await client.access({ host, port: 21, user, password, secure: true })
const list = await client.list('/photos/')
await client.downloadTo(localPath, '/photos/img.jpg')
await client.uploadFrom(localPath, '/photos/.photolib/source.dat')

// SFTP (ssh2-sftp-client):
await sftp.connect({ host, port: 22, username, password })
const list = await sftp.list('/photos/')
const buffer = await sftp.get('/photos/img.jpg')
await sftp.put(buffer, '/photos/.photolib/source.dat')
```

### ServerPath (Backend-managed)

```
// Browse
GET /api/files/browse?path={rootPath}&page={n}&pageSize=200
  → { files: FileInfo[], hasMore }
  FileInfo: { name, path, size, mimeType, mtime }

// Rekursiv
GET /api/files/browse?path={rootPath}/{subDir}&page=1&pageSize=200

// Download
GET /api/files/download?path={filePath}

// Thumbnail (Backend-generiert)
GET /api/files/thumbnail?path={filePath}&size=300
```

### WebDAV (generisch)

```
// Dateien listen
PROPFIND {baseUrl}/{path}
  Header: Depth: 1
  → XML Multistatus mit Datei-Einträgen

// Download
GET {baseUrl}/{path}

// Upload
PUT {baseUrl}/{path}
  Body: Datei-Bytes

// Ordner erstellen
MKCOL {baseUrl}/{path}

// Sidecar
PUT {baseUrl}/{photoDir}/.photolib/{filename}.json
GET {baseUrl}/{photoDir}/.photolib/{filename}.json
```

### S3 (AWS, MinIO, etc.)

```
// Objekte listen (ListV2)
GET /{bucket}?list-type=2&prefix={prefix}&max-keys=1000
  &continuation-token={token}
  → XML: Contents[]: { Key, Size, LastModified, ETag }

// Download
GET /{bucket}/{key}

// Upload
PUT /{bucket}/{key}
  Body: Datei-Bytes

// Sidecar
PUT /{bucket}/.photolib/{filename}.json
GET /{bucket}/.photolib/{filename}.json

// Signing: AWS Signature V4
```

### Google Takeout (Export → Local)

```
// Kein API — manueller Export
// takeout.google.com → Google Photos → Export
// ZIP-Dateien mit Originalen + {filename}.json Metadaten:
//   { title, description, imageViews, creationTime, photoTakenTime,
//     geoData: { latitude, longitude, altitude } }
// Entpacken → als lokale Quelle einbinden
```
