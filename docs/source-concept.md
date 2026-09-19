# PhotoLib — Quellen-Konzept (Detail)

## Was ein User konkret tun will

1. Fotos aus einer Quelle browsen
2. Schnell Thumbnails sehen
3. Fotos bewerten, flaggen, labeln
4. Fotos bearbeiten (Adjustments)
5. Bearbeitungen auf einem anderen Gerät sehen
6. Nichts verlieren wenn Browser-Daten gelöscht werden
7. Fotos in Alben organisieren
8. Offline arbeiten können (optional)

---

## Korrektur: Wer kann wirklich Dateien schreiben?

Meine bisherige Einteilung war falsch. Dropbox, Google Drive und OneDrive sind
KEINE read-only Quellen — sie haben volle Upload/Write-APIs:

| Quelle | Beliebige Dateien schreiben | Methode |
|---|---|---|
| Local | ✓ | File System Access API |
| ServerPath | ✓ | Backend-API |
| WebDAV | ✓ | PUT |
| S3 | ✓ | PUT Object |
| FTP/SFTP | ✓ | STOR / write (via Backend) |
| SMB | ✓ | via Backend |
| **Dropbox** | **✓** | `POST /2/files/upload` — kann jede Datei in jeden Ordner schreiben |
| **Google Drive** | **✓** | `POST /drive/v3/files` — kann Dateien in beliebige Ordner erstellen |
| **OneDrive** | **✓** | `PUT /me/drive/items/{parent}:/{name}:/content` |
| Immich | Nein | Nur Foto-Upload, keine beliebigen Dateien |
| Photoprism | Nein (API) | Aber: Filesystem-Zugriff da self-hosted |
| Synology | Nein (API) | Aber: SMB/SSH zum NAS möglich |
| Piwigo | Nein (API) | Aber: Filesystem-Zugriff da self-hosted |
| Lychee | Nein (API) | Aber: Filesystem-Zugriff da self-hosted |
| Flickr | Nein | Nur Foto-Upload/-Replace, keine beliebigen Dateien |
| SmugMug | Nein | Nur Foto-Upload, keine beliebigen Dateien |
| Google Photos | Nein | Nur Foto-Upload in eigene App-Alben |

**Erkenntnis:** .dat neben den Originalen ist bei 9 von 16 Quellen möglich.
Die Self-Hosted Quellen (Photoprism, Synology, Piwigo, Lychee) könnten das über
einen zweiten Zugang (SMB/SSH → als ServerPath/Local anbinden).

---

## Jede Quelle im Detail

### Local

**Browsen:** Voller rekursiver Scan via File System Access API. User wählt Root-Ordner.
**Alben:** Ordnerstruktur = natürliche Alben. Keine vom User erstellbaren Alben außer neue Ordner.
**Thumbnails:** Wir generieren, speichern in `.photolib/{label}.dat`.
**Edits speichern:** In .dat neben den Originalen → überlebt Browser-Clear.
**Anderes Gerät:** .dat reist mit bei Ordner-Sync (Syncthing, rsync, Cloud-Sync).
**Offline:** Voll offline-fähig.
**Ratings zurückschreiben:** In .dat. Nicht ins Original-EXIF (könnte man aber).
**Limitierungen:**
- Browser muss bei jedem Besuch Permission re-granten (bei Chrome merkt er sich das)
- Safari unterstützt kein File System Access API → Fallback auf FileList (read-only)

### ServerPath (+ SMB/FTP)

**Browsen:** Backend liest Filesystem, liefert Dateiliste via REST API.
**Alben:** Ordnerstruktur. User gibt Root-Pfad ein, Backend validiert gegen ALLOWED_ROOTS.
**Thumbnails:** Backend könnte generieren. Oder: Client generiert, Backend schreibt .dat.
**Edits speichern:** Backend schreibt .dat neben Originale → persistent.
**Anderes Gerät:** Alle Geräte lesen vom gleichen Backend → .dat ist sofort überall.
**Offline:** Nein — braucht Backend-Verbindung.
**Besonderheit:** Idealer Hybrid für Self-Hosted-Quellen:
- Photoprism-Ordner als ServerPath mounten → .dat schreiben
- Synology-Share als SMB-Pfad → .dat schreiben
- Damit werden Photoprism/Synology-Fotos auch offline bearbeitbar

### WebDAV / Nextcloud

**Browsen:** PROPFIND rekursiv. basePath schränkt auf Unterverzeichnis ein.
**Alben:** Ordnerstruktur via WebDAV. Nextcloud hat zusätzlich eigene Album-API
(nicht implementiert — würde OCS API brauchen, nicht WebDAV).
**Thumbnails:** Nextcloud: Preview-API (`/index.php/core/preview`). Standard-WebDAV: keine
→ wir generieren und könnten .dat via PUT hochladen.
**Edits speichern:** PUT .dat neben Originale möglich.
**Anderes Gerät:** .dat liegt auf dem WebDAV-Server → von überall lesbar.
**Offline:** Nein.
**Ratings zurückschreiben:** Nextcloud hat OCS-API für Tags/Favorites, aber nicht via WebDAV.
**.dat schreiben getestet?** Nein — muss implementiert werden (PUT-Request).

### S3 / MinIO

**Browsen:** ListBucketV2 mit Prefix/Delimiter. Prefix schränkt ein.
**Alben:** Prefix-basierte "Ordner" (photos/2024/urlaub/).
**Thumbnails:** Keine vom Server. Wir generieren.
**Edits speichern:** PUT Object `.photolib/{label}.dat` im Bucket möglich.
**Anderes Gerät:** .dat liegt im S3-Bucket → von überall lesbar.
**Offline:** Nein.
**Besonderheit:** MinIO ist Self-Hosted S3. Viele NAS-Systeme bieten S3-kompatiblen Zugang.

### Dropbox

**Browsen:** `list_folder` mit recursive=true. Ordner-Pfad als Root.
**Alben:** Nur Ordner, kein Album-Konzept.
**Thumbnails:** API liefert via `get_thumbnail_v2` (256px JPEG).
**Edits speichern:** `files/upload` kann .dat neben Originale schreiben!
Pfad: z.B. `/Photos/.photolib/Dropbox.dat`
**Anderes Gerät:** .dat liegt in der Dropbox → synct automatisch auf alle Geräte!
**Offline:** Nur wenn Dropbox-Desktop-App die Dateien lokal synct (dann → Local Source).
**Ratings zurückschreiben:** Nein — Dropbox hat kein Metadaten-API.
**.dat in Dropbox ist besonders wertvoll** — automatischer Multi-Device-Sync ohne Sync-Server!

### Google Drive

**Browsen:** `files.list` mit `'{folderId}' in parents`. Ordner-ID als Root.
**Alben:** Nur Ordner. Google Drive hat kein Album-Konzept.
User muss Ordner-ID kennen oder Browse-Dialog bekommen.
**Thumbnails:** `thumbnailLink` in File-Response, Größe via URL-Parameter.
**Edits speichern:** `files.create` kann .dat in den gleichen Ordner schreiben!
**Anderes Gerät:** .dat liegt in Google Drive → synct via Drive auf alle Geräte.
**Offline:** Nur wenn Google Drive Desktop die Dateien lokal synct.
**Ratings zurückschreiben:** Nein.
**Besonderheit:** Braucht `drive.file` Scope (nur Dateien die unsere App erstellt hat zugänglich)
ODER `drive` Scope (voller Zugriff — schwerer durch Google App Review zu bekommen).

### OneDrive

**Browsen:** Graph API, Ordner-basiert. Special Folders: `cameraroll`, `photos`.
**Alben:** Ordner + Bundles (Beta, schlecht dokumentiert). Special Folders als Einstiegspunkt.
**Thumbnails:** Graph API liefert small/medium/large + Custom-Größen.
**Edits speichern:** PUT .dat neben Originale — voll unterstützt!
**Anderes Gerät:** .dat synct via OneDrive auf alle Geräte.
**Offline:** Nur wenn OneDrive Desktop die Dateien lokal synct.
**Ratings zurückschreiben:** Nein.
**Webhooks:** ✓ — einziger Cloud-Dienst mit Change-Notifications!
Subscription + Delta API → wir könnten live auf Änderungen reagieren.
**EXIF:** Photo-Facet hat Camera/GPS/Datum — aber nur bei Personal OneDrive, nicht Business.

### Immich

**Browsen:** Volle Bibliothek oder gefiltert nach Alben.
**Alben:**
- `GET /api/albums` — alle Alben mit Name, Foto-Count, Cover
- Multi-Album-Select bei Setup (bereits implementiert!)
- `POST /api/albums` — Alben erstellen
- `POST /api/albums/{id}/assets` — Fotos zu Album hinzufügen
- Flach, keine Verschachtelung
**Thumbnails:** API liefert schnelle Vorschauen (thumbnail + preview Größe).
**Edits speichern:** Immich hat KEIN Adjustments-API. Optionen:
1. OPFS .dat (nur dieses Gerät)
2. Sync-Server (Multi-Device)
3. Immich-Ordner als ServerPath anbinden → .dat auf Immich-Server
4. Bearbeitetes Foto als neues Asset hochladen (`POST /api/assets`)
**Anderes Gerät:** Nur via Sync-Server oder Option 3/4.
**Offline:** Nein — braucht Immich-Server.
**Ratings/Tags zurückschreiben:**
- Favorites: `PUT /api/assets` mit `isFavorite: true` → könnte als Flag sync
- Tags: Immich hat Tags seit v1.100+
- Faces: Immich erkennt Gesichter, wir könnten die Daten lesen
**Besonderheit:** Immich ist der feature-reichste Self-Hosted-Dienst.

### Photoprism

**Browsen:** `GET /api/v1/photos` mit umfangreichen Filtern.
**Alben:**
- 5 Typen: album (manuell), folder (Filesystem), moment (Datum/Ort auto), month, state
- `GET /api/v1/albums?type=album` — Liste
- `GET /api/v1/photos?album={uid}` — Fotos in Album
- `POST /api/v1/albums` — erstellen
- Flach, keine Verschachtelung
- Momente/Monate sind automatisch generierte "virtuelle Alben"
**Thumbnails:** 25 Größen, Cookie-frei. Sehr schnell.
**Edits speichern:** Kein Adjustments-API. Optionen:
1. OPFS .dat (lokal)
2. Sync-Server
3. Photoprism-Ordner als Local/ServerPath anbinden → .dat schreiben
**Anderes Gerät:** Nur via Sync-Server oder Option 3.
**Offline:** Nein.
**Ratings zurückschreiben:** Keine Star-Ratings in Photoprism.
- Favorites: `POST /api/v1/photos/{uid}/like`
- Labels: AI-generiert, manuell hinzufügbar
**Besonderheit:** AI-Labels, Faces, Farberkennung — reichste Metadaten aller Self-Hosted.

### Synology Photos

**Browsen:** Zwei separate API-Namespaces!
- `SYNO.Foto.Browse.Item` — Personal Space
- `SYNO.FotoTeam.Browse.Item` — Shared Space
- Müssen beide abgefragt werden für vollständige Bibliothek
**Alben:**
- `SYNO.Foto.Browse.Album` — normale Alben
- `SYNO.Foto.Browse.ConditionAlbum` — Smart/Conditional Alben (nach Regeln)
- `SYNO.Foto.Browse.Folder` — Ordner-Navigation (spiegelt NAS-Filesystem)
- Erstellen möglich
**Thumbnails:** API liefert gecachte Varianten.
**Edits speichern:** Kein Adjustments-API. Optionen:
1. OPFS .dat (lokal)
2. Sync-Server
3. **NAS-Share als SMB-Quelle anbinden** → .dat auf dem NAS schreiben
   Fotos liegen unter `/volume1/photo/` (shared) oder Home-Ordner (personal)
   → als ServerPath oder SMB direkt zugreifbar
**Anderes Gerät:** Option 3 ist ideal — alle Geräte im Netzwerk sehen die .dat.
**Offline:** Nein (außer NAS-Ordner wird lokal gesynct).
**Ratings zurückschreiben:** Unklar — API schlecht dokumentiert.
**ACHTUNG:** API ist inoffiziell. Kann mit DSM-Updates brechen.

### Piwigo

**Browsen:** Kategorien (= Alben), verschachtelt, unlimitierte Tiefe.
**Alben:**
- `pwg.categories.getList` mit `recursive=true`, `tree_output=true`
- **Einziger Dienst mit Multi-Kategorie-Filter** (`cat_id` als Array)
- `pwg.categories.getImages` mit `recursive=true` für Sub-Kategorien
- `pwg.categories.add` — erstellen mit Parent
- Smart Albums via Plugin
**Thumbnails:** Server-generierte Derivate (7 Größen).
**Edits speichern:** Kein Adjustments-API. Optionen wie Photoprism.
**Anderes Gerät:** Via Sync-Server oder Filesystem-Zugriff.
**Ratings zurückschreiben:** ✓ `pwg.images.rate` — einziger Dienst mit echtem Rating-API!
**Tags zurückschreiben:** ✓ `pwg.images.setTags`
**Besonderheit:** Bestes Album-System (verschachtelt, multi-select, rekursiv) +
einziger mit bidirektionalem Rating/Tag-Sync.

### Lychee (v7+)

**Browsen:** Albums-Baum (rekursiv über `Album::albums?album_id=…` aufgebaut).
**Alben:**
- `GET /Albums` — Wurzel-Listing (Top-Level + Smart + Tag + shared)
- `GET /Album::head?album_id=…` — Album-Header (lightweight)
- `GET /Album::albums?album_id=…&page=…` — Kind-Alben (paginiert)
- `GET /Album::photos?album_id=…&page=…` — Photos (paginiert)
- `POST /Album` — erstellen, Body: `{ title, parent_album }`
- Smart Albums (v7-IDs): `recent`, `highlighted` (ehem. starred), `on_this_day`, `unsorted`, `untagged`, `1star`…`5star`
- Tag Albums: dynamisch via `POST /TagAlbum` mit `{ title, tags, is_and }`
**Thumbnails:** Server-generiert (`thumb`, `small`, `small2x`, `medium`, `medium2x`, `original`).
**Edits speichern:** Kein Adjustments-API. Optionen wie Photoprism.
**Ratings zurückschreiben:** **Ja**, Rating 1–5 via `POST /Photo::setRating` (neu in v7) + Highlight-Flag via `POST /Photo::highlight`.
**Tags:** Ja, Tag Albums + `PATCH /Photo::tags`.
**Besonderheit:** Multipart-Upload ist **chunked** (`uuid_name` + `chunk_number`/`total_chunks`).

### Flickr

**Browsen:** `photos.search` mit umfangreichen Filtern.
**Alben:**
- 3 Ebenen: Collections > Photosets (Albums) > Fotos
- `photosets.getList` — alle Alben
- `photosets.getPhotos` — Fotos in Album
- `collections.getTree` — verschachtelter Baum
- `photosets.create` — erstellen (braucht primary_photo_id)
- Galleries: kuratierte Sets fremder Fotos (separates Konzept)
**Thumbnails:** 15+ Größen via URL-Schema. Sehr schnell.
**Edits speichern:** KANN KEINE beliebigen Dateien speichern. Optionen:
1. OPFS .dat (lokal)
2. Sync-Server
3. Bearbeitetes Foto als Replace hochladen: `services/replace/`
**Anderes Gerät:** Nur via Sync-Server.
**Ratings zurückschreiben:** Nein (kein Rating-API). Aber:
- Tags: ✓ `photos.addTags`
- Favorites: ✓ `favorites.add`
- Description: ✓ `photos.setMeta`
- Geo: ✓ `photos.geo.setLocation`
**Offline:** Nein.
**Limitierungen:** 3.600 Req/h pro API-Key. Free-Accounts: kein Original-Download.

### SmugMug

**Browsen:** REST-Style, Node/Folder/Album-Hierarchie.
**Alben:**
- Pfad-basierte URLs: `/folder/user/{username}/Path/To/Folder`
- Max 5 Ordner-Ebenen (Alben zählen nicht)
- Max 5.001 Items pro Album
- `!children` Expansion für Sub-Nodes
- Erstellen möglich
**Thumbnails:** Server-generierte Renditions.
**Edits speichern:** KANN KEINE beliebigen Dateien speichern. Optionen:
1. OPFS .dat (lokal)
2. Sync-Server
3. Bearbeitetes Foto hochladen (neues Image, max 500MB)
**Anderes Gerät:** Nur via Sync-Server.
**Ratings zurückschreiben:** Keywords ja, sonst wenig.
**Offline:** Nein.
**Limitierungen:** Braucht aktives SmugMug-Abo. OAuth 1.0a.

### Google Photos (Picker API)

**Browsen:** KEIN automatischer Scan möglich. User muss im Google Picker-Dialog
manuell Fotos/Alben auswählen. Kein Hintergrund-Sync.
**Alben:** Picker zeigt User-Alben, aber wir haben keinen programmatischen Zugriff.
**Thumbnails:** `baseUrl` + Größenparameter. **Verfällt nach 60 Minuten.**
**Edits speichern:** Nur OPFS .dat oder Sync-Server.
**Anderes Gerät:** Nur via Sync-Server.
**Upload:** Kann bearbeitete Fotos als neue Medien hochladen (in app-eigenes Album).
**Offline:** Nein + Thumbnail-URLs verfallen → muss regelmäßig refreshen.
**Fazit:** Schlechte User-Experience. Nur sinnvoll als "Import einmalig" → dann wie Local.
**Alternative:** Google Takeout Export → als lokale Quelle importieren.

---

## Was kann der Sync-Server fixen?

| Problem | Sync-Server löst es? | Wie? |
|---|---|---|
| Edits auf anderem Gerät sehen | ✓ | Push/Pull Adjustments via LWW-Merge |
| Ratings/Flags auf anderem Gerät | ✓ | Push/Pull Metadata |
| Browser-Daten gelöscht | ✓ | Alles vom Server neu pullen |
| Thumbnails persistent speichern | ✓ | Server könnte Thumb-Blobs speichern |
| Quelle offline | Teilweise | Sync-Server hat Edits, aber keine Originale |
| Alben auf Quelle erstellen | Nein | Sync-Server kennt die Quelle nicht |
| Ratings zur Quelle zurückschreiben | Nein | Nur PhotoLib ↔ Sync-Server, nicht Quelle |
| .dat schreiben wo API es nicht erlaubt | Nein | Server hat keinen Zugang zur Quelle |

**Sync-Server ist wertvoll für:** Cloud-Quellen ohne Schreibzugriff (Flickr, SmugMug, Google Photos).
**Sync-Server ist unnötig für:** Quellen wo .dat neben Originalen liegt (Local, Dropbox, OneDrive, S3).

---

## Praktische Empfehlung pro Quelle

### .dat neben Originalen (bester Fall — kein Sync-Server nötig)

| Quelle | .dat Pfad | Sync zwischen Geräten |
|---|---|---|
| Local | `.photolib/{label}.dat` im Root | Via Ordner-Sync (Syncthing, etc.) |
| ServerPath | `.photolib/{label}.dat` via Backend | Automatisch (alle lesen vom selben Server) |
| WebDAV | `.photolib/{label}.dat` via PUT | Automatisch (WebDAV-Server) |
| S3 | `.photolib/{label}.dat` als Objekt | Automatisch (S3-Bucket) |
| Dropbox | `.photolib/{label}.dat` via Upload-API | **Automatisch via Dropbox-Sync!** |
| Google Drive | `.photolib/{label}.dat` via Files-API | Automatisch via Drive-Sync |
| OneDrive | `.photolib/{label}.dat` via Graph-API | Automatisch via OneDrive-Sync |

### Hybrid: API zum Browsen + Filesystem für .dat

| Quelle | API für | Filesystem für .dat |
|---|---|---|
| Synology | Browse, Thumbnails, Alben | SMB/SSH zum NAS → `.dat` auf Share |
| Photoprism | Browse, Thumbnails, AI-Labels | Ordner als Local/ServerPath → `.dat` |
| Piwigo | Browse, Thumbnails, Ratings | Ordner als Local/ServerPath → `.dat` |
| Lychee | Browse, Thumbnails | Ordner als Local/ServerPath → `.dat` |

### OPFS + Sync-Server (kein anderer Weg)

| Quelle | Warum kein .dat? | Sync-Server nötig für Multi-Device? |
|---|---|---|
| Flickr | Nur Foto-Upload, keine Dateien | Ja |
| SmugMug | Nur Foto-Upload, keine Dateien | Ja |
| Google Photos | Kein Dateizugriff, Picker nur | Ja |
| Immich | Kein Datei-API (oder Hybrid) | Ja (oder Hybrid) |

---

## Album-Funktionalität: Was können wir anbieten?

### Stufe 1: Alben nur lesen (alle Quellen)

User wählt bei Setup welche Alben/Ordner importiert werden.
Fotos werden nach Album/Ordner gruppiert in der Grid-Ansicht.

| Quelle | Album-Typ | Bei Setup wählbar | In PhotoLib gruppierbar |
|---|---|---|---|
| Local | Ordner | Root-Ordner Picker | Nach Ordnerpfad |
| Immich | Alben | Multi-Select ✓ | Nach Album |
| Photoprism | Album/Folder/Moment | Typ-Auswahl | Nach Album-Typ |
| Synology | Album + Ordner | Personal/Shared + Album | Nach Album/Ordner |
| Piwigo | Kategorien (verschachtelt) | Kategorie-Baum | Nach Kategorie-Hierarchie |
| Lychee | Alben (verschachtelt) | Album-Baum | Nach Album-Hierarchie |
| Flickr | Photosets + Collections | Photoset-Liste | Nach Photoset |
| SmugMug | Folder + Album | Folder/Album-Baum | Nach Ordner/Album |
| Dropbox | Ordner | Ordner-Pfad | Nach Ordnerpfad |
| Google Drive | Ordner | Ordner-ID | Nach Ordnerpfad |
| OneDrive | Ordner + Special | Ordner/Camera Roll | Nach Ordnerpfad |

### Stufe 2: Alben schreiben (wo API es erlaubt)

| Quelle | Album erstellen | Foto zu Album | Foto aus Album |
|---|---|---|---|
| Immich | ✓ `POST /api/albums` | ✓ `POST /api/albums/{id}/assets` | ✓ `DELETE` |
| Photoprism | ✓ `POST /api/v1/albums` | ✓ | ✓ |
| Piwigo | ✓ `pwg.categories.add` | ✓ `pwg.images.setCategory` | ✓ |
| Lychee | ✓ `POST /Album` | ✓ `POST /Photo::move` | ✓ `DELETE /Photo` |
| Flickr | ✓ `photosets.create` | ✓ `photosets.addPhoto` | ✓ `photosets.removePhoto` |
| SmugMug | ✓ POST FolderAlbums | ✓ | ✓ |
| Google Drive | ✓ Ordner erstellen | ✓ Datei verschieben | ✓ |
| Dropbox | ✓ `create_folder_v2` | ✓ `move_v2` | ✓ |
| OneDrive | ✓ Ordner erstellen | ✓ PATCH move | ✓ |
| Local | ✓ Ordner erstellen | ✓ Datei verschieben | ✓ |

### Stufe 3: Metadaten zurückschreiben (wo API es erlaubt)

| Quelle | Ratings | Tags/Keywords | Favorit | GPS | Beschreibung |
|---|---|---|---|---|---|
| Piwigo | ✓ `images.rate` | ✓ `images.setTags` | — | — | ✓ `images.setInfo` |
| Flickr | — | ✓ `photos.addTags` | ✓ `favorites.add` | ✓ `geo.setLocation` | ✓ `photos.setMeta` |
| Immich | — | ✓ (seit v1.100) | ✓ `isFavorite` | — | — |
| Photoprism | — | ✓ Labels | ✓ `photos/like` | — | — |
| Lychee | — | ✓ Tag Albums | ✓ Starred | — | ✓ |
| SmugMug | — | ✓ Keywords | — | — | ✓ Caption |
| Local | In EXIF/XMP | In EXIF/XMP | — | In EXIF | — |

---

## Zusammenfassung: Drei Implementierungs-Gruppen

### Gruppe 1: .dat neben Originalen (Self-Contained)
**Local, ServerPath, WebDAV, S3, FTP, SMB, Dropbox, Google Drive, OneDrive**

Kein Sync-Server nötig. .dat reist mit den Dateien.
Cloud-Quellen (Dropbox/Drive/OneDrive) syncen .dat automatisch zwischen Geräten.

### Gruppe 2: API + optionaler Filesystem-Zugriff (Hybrid)
**Immich, Photoprism, Synology, Piwigo, Lychee**

API für Browse/Thumbnails, Filesystem (als zweite Quelle) für .dat.
Sync-Server als Alternative wenn kein Filesystem-Zugang.
Einige (Piwigo, Flickr) können Ratings/Tags direkt zurückschreiben.

### Gruppe 3: Nur API, kein Dateizugriff
**Flickr, SmugMug, Google Photos**

OPFS für lokale Persistenz. Sync-Server für Multi-Device.
Bearbeitete Fotos als neue Version hochladen (Flickr Replace, SmugMug Upload).
