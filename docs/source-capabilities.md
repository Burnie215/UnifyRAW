
# PhotoLib — Source Capabilities (Detail)

## Legende

- ✓ = voll unterstützt
- ◐ = teilweise / eingeschränkt
- ✗ = nicht möglich
- ✗ nicht impl. = das Protokoll könnte es, UnifyRAW hat die Methode nicht
- ? = unklar / undokumentiert

Die Schreib-Spalten (§4, §5, §8) sind kein Wunschzettel: seit 4473fb8 leitet
`writeCapabilitiesOf()` ([src/sources/writeCapabilities.ts](../src/sources/writeCapabilities.ts))
jede Fähigkeit aus dem VORHANDENSEIN der Methode ab. Was hier ✓ steht, muss der
Provider also implementieren — sonst meldet die App es dem Nutzer als ✗.

FTP/SFTP, SMB, SSH und NFS bleiben nur als Typen für alte Katalogzeilen erhalten;
sie haben keine Provider-Factory und erscheinen deshalb nicht in den Tabellen.

---

## 1. Fotos lesen

| Quelle | Alle Fotos listen | Ordner filtern | Album filtern | Rekursiv | Pagination | Inkrementell (Delta) |
|---|---|---|---|---|---|---|
| **Local** | ✓ walk | ✓ Unterordner | ✗ kein Albumkonzept | ✓ | ✗ alles auf einmal | ✗ |
| **ServerPath** | ✓ Backend | ✓ rootPath | ✗ | ✓ | ✓ 200/Seite | ✗ |
| **WebDAV** | ✓ PROPFIND | ✓ basePath | ✗ | ✓ | ✗ | ✗ |
| **S3** | ✓ ListV2 | ✓ prefix | ✗ | ✓ delimiter | ✓ ContinuationToken | ✗ |
| **Immich** | ✓ /assets | ✗ kein Ordnerkonzept | ✓ albumId + Multi-Select | ✗ flach | ✓ page/size | ✗ |
| **Photoprism** | ✓ /photos | ✓ path-Filter | ✓ album UID, 5 Typen | ✗ flach | ✓ count/offset | ✗ |
| **Synology** | ✓ Browse.Item | ✓ folder_id | ✓ album_id | ✓ Ordner | ✓ offset/limit | ✗ |
| **Piwigo** | ✓ getImages | ✓ cat_id rekursiv | ✓ cat_id Array(!) | ✓ recursive=true | ✓ page/per_page | ✗ |
| **Lychee** | ✓ Album::photos | ✗ | ✓ album_id (Query) | ✗ | ✓ page | ✗ |
| **Dropbox** | ✓ list_folder | ✓ path | ✗ kein Albumkonzept | ✓ recursive=true | ✓ cursor | ✓ list_folder/longpoll |
| **Google Drive** | ✓ files.list | ✓ folderId in parents | ✗ | ✗ manuell traversieren | ✓ pageToken | ✓ changes.list |
| **OneDrive** | ✓ items/children | ✓ itemId/path | ◐ Bundles (Beta) | ✗ manuell traversieren | ✓ skipToken | ✓ delta API |
| **Flickr** | ✓ photos.search | ✗ | ✓ photoset_id | ✗ | ✓ page/per_page | ✗ |
| **SmugMug** | ✓ album!images | ✓ folder/{path} | ✓ albumKey | ✗ | ✓ | ✗ |
| **Google Photos** | ◐ nur Picker-Auswahl | ✗ | ◐ Picker zeigt Alben | ✗ | ✓ pageToken | ✗ |

---

## 2. Thumbnails

| Quelle | Quelle liefert | Größen | Format | Haltbarkeit | Geschwindigkeit |
|---|---|---|---|---|---|
| **Local** | ✗ selbst generieren | 300px | JPEG | ∞ (.dat) | langsam (FS API ~1ms/Datei) |
| **ServerPath** | ◐ Backend könnte | konfigurierbar | JPEG | ∞ | mittel (Netzwerk) |
| **WebDAV** | ◐ nur Nextcloud | 300px | JPEG | ∞ Server-Cache | mittel |
| **S3** | ✗ selbst generieren | 300px | JPEG | ∞ (.dat) | langsam (Download → resize) |
| **Immich** | ✓ /thumbnail | thumbnail(250), preview(1440) | JPEG | ∞ Server-Cache | schnell |
| **Photoprism** | ✓ /t/:hash/:token/:size | 25 Größen (50-7680px) | JPEG | ∞ Server-Cache | sehr schnell (CDN-fähig) |
| **Synology** | ✓ Foto.Thumbnail | sm, m, xl | JPEG | ∞ NAS-Cache | schnell (LAN) |
| **Piwigo** | ✓ derivatives | 7 Größen (sq-xxl) | JPEG | ∞ Server-Cache | schnell |
| **Lychee** | ✓ size_variants | thumb, small, medium | JPEG | ∞ Server-Cache | schnell |
| **Dropbox** | ✓ get_thumbnail_v2 | 9 Größen (32-2048px) | JPEG | on-demand | mittel |
| **Google Drive** | ✓ thumbnailLink | beliebig via =s{N} | JPEG | ? (URL kann verfallen) | schnell (CDN) |
| **OneDrive** | ✓ thumbnails | small(96), medium(176), large(800), custom | JPEG | ∞ | schnell (CDN) |
| **Flickr** | ✓ URL-Schema | 15+ Größen (75-6144px) | JPEG | ∞ (statische URLs) | sehr schnell (CDN) |
| **SmugMug** | ✓ ImageSizes | 8+ Größen (tiny-original) | JPEG | ∞ | schnell |
| **Google Photos** | ✓ baseUrl | beliebig via =w{N}-h{N} | JPEG | **60 Minuten!** | schnell (CDN) |

---

## 3. Metadaten lesen

| Quelle | EXIF Camera/Lens | ISO/Blende/Zeit | GPS | Datum | Maße (W×H) | Tags/Keywords | Faces | Rating |
|---|---|---|---|---|---|---|---|---|
| **Local** | ✓ aus Datei | ✓ | ✓ | ✓ | ✓ | ✓ EXIF/XMP | ✗ | ✗ |
| **ServerPath** | ✓ Backend extrahiert | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **WebDAV** | ✗ nur contentType/size/date | ✗ | ✗ | ✓ lastModified | ✗ | ✗ | ✗ | ✗ |
| **S3** | ✗ nur size/date | ✗ | ✗ | ✓ lastModified | ✗ | ✗ | ✗ | ✗ |
| **Immich** | ✓ exifInfo | ✓ | ✓ lat/lng/city/country | ✓ createdAt | ✓ | ✓ seit v1.100 | ✓ Personen | ✗ nur Favorit |
| **Photoprism** | ✓ Camera/Lens Objekte | ✓ | ✓ Lat/Lng | ✓ TakenAt | ✓ | ✓ AI-Labels | ✓ | ✗ nur Favorit |
| **Synology** | ✓ get_exif | ✓ | ? | ✓ | ✓ | ✓ GeneralTag | ? | ? |
| **Piwigo** | ✓ getExif (alle Tags) | ✓ | ✓ in DB | ✓ date_creation | ✓ | ✓ Tags | ✗ | ✓ 1-5 |
| **Lychee** | ✓ make/model/lens | ✓ aperture/focal/iso/shutter | ✓ lat/lng | ✓ taken_at | ✓ | ✓ Tags | ✗ | ✗ nur Starred |
| **Dropbox** | ✗ | ✗ | ✓ media_info.location | ✓ time_taken | ✓ dimensions | ✗ | ✗ | ✗ |
| **Google Drive** | ✓ imageMediaMetadata | ✓ | ✓ location | ✓ createdTime | ✓ | ✗ | ✗ | ✗ |
| **OneDrive** | ✓ photo facet (nur Personal!) | ✓ (nur Personal) | ✓ location facet | ✓ takenDateTime | ✓ image facet | ✗ | ✗ | ✗ |
| **Flickr** | ✓ photos.getExif (komplett) | ✓ | ✓ geo.getLocation | ✓ datetaken | ✓ | ✓ Tags + Machine Tags | ✗ | ✗ |
| **SmugMug** | ✓ in Image | ✓ Aperture/Focal/ISO | ✓ Lat/Lng | ✓ DateTimeOriginal | ✓ | ✓ Keywords | ✗ | ✗ |
| **Google Photos** | ✓ mediaMetadata.photo | ✓ | **✗ kein GPS über API!** | ✓ creationTime | ✓ | ✗ | ✗ | ✗ |

**Quellen ohne EXIF über API (WebDAV, S3, FTP, SMB, Dropbox):** EXIF muss aus der Datei extrahiert werden (getFile → extractExif). Ergebnis in .dat cachen.

---

## 4. Dateien/Daten schreiben

| Quelle | Beliebige Datei schreiben | .dat neben Originalen | Foto uploaden | Foto ersetzen | Ordner erstellen |
|---|---|---|---|---|---|
| **Local** | ✓ createWritable | ✓ | ✓ | ✓ | ✓ getDirectoryHandle(create) |
| **ServerPath** | ✗ nicht impl. | ✗ nicht impl. | ✗ nicht impl. | ✗ nicht impl. | ✗ keine Backend-Route |
| **WebDAV** | ✓ PUT | ✓ | ✓ PUT | ✓ PUT overwrite | ✓ MKCOL |
| **S3** | ✗ Provider gesperrt | ✗ Provider gesperrt | ✗ Provider gesperrt | ✗ Provider gesperrt | ✗ Provider gesperrt |
| **Immich** | ✗ | ✗ | ✓ POST /assets | ✗ | — (Alben, nicht Ordner) |
| **Photoprism** | ✗ | ✗ (aber Filesystem) | ✓ POST /upload | ✗ | ✓ Alben |
| **Synology** | ✗ | ✗ (aber SMB/SSH) | ✓ Upload API | ✗ | ✓ Alben |
| **Piwigo** | ✗ | ✗ (aber Filesystem) | ✓ images.upload | ✗ | ✓ categories.add |
| **Lychee** | ✗ | ✗ (aber Filesystem) | ✓ POST /Photo (chunked) | ✗ | ✓ POST /Album |
| **Dropbox** | **✓ files/upload** | **✓** | ✓ | ✓ upload mode:overwrite | ✓ create_folder_v2 |
| **Google Drive** | **✓ files.create** | ✗ nicht impl. | ✓ | ✓ files.update | ✓ folder erstellen |
| **OneDrive** | **✓ PUT content** | **✓** | ✓ | ✓ PUT overwrite | ✓ POST children |
| **Flickr** | ✗ | ✗ | ✓ upload | ✓ replace | ✓ photosets.create |
| **SmugMug** | ✗ | ✗ | ✓ upload (500MB) | ✗ | ✓ folders + albums |
| **Google Photos** | ✗ | ✗ | ✓ uploads (nur in eigene Alben) | ✗ | ✓ albums (nur eigene) |

---

## 5. Metadaten zurückschreiben

| Quelle | Rating (1-5) | Favorit | Tags/Keywords | GPS | Titel/Beschreibung | In Album sortieren |
|---|---|---|---|---|---|---|
| **Local** | ◐ in EXIF/XMP möglich | ✗ | ◐ in EXIF/XMP | ◐ in EXIF/XMP | ✗ | ✓ Datei verschieben |
| **ServerPath** | ✗ nicht impl. | ✗ | ✗ nicht impl. | ✗ nicht impl. | ✗ | ✗ nicht impl. |
| **WebDAV** | ✗ | ✗ | ✗ (Nextcloud OCS hätte Tags) | ✗ | ✗ | ✗ nicht impl. (MOVE möglich) |
| **S3** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ nicht impl. (COPY+DELETE möglich) |
| **Immich** | ✗ | ✓ isFavorite | ✓ Tags API | ✗ | ✗ | ✓ album/assets |
| **Photoprism** | ✗ | ✓ photos/like | ✓ Labels | ✗ | ✓ | ✓ |
| **Synology** | ? | ? | ✓ add_tag | ? | ? | ✓ |
| **Piwigo** | **✓ images.rate** | ✗ | ✓ images.setTags | ✗ | ✓ images.setInfo | ✓ images.setCategory |
| **Lychee** | ✓ Photo::setRating (1-5) | ✓ Photo::highlight | ✓ Photo::tags | ✗ | ✓ | ✓ Photo::move |
| **Dropbox** | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ files/move_v2 |
| **Google Drive** | ✗ | ✗ | ✗ | ✗ | ✓ files.update (name) | ✓ PATCH parents |
| **OneDrive** | ✗ | ✗ | ✗ | ✗ | ✓ PATCH name | ✓ PATCH parentReference |
| **Flickr** | ✗ | ✓ favorites.add | ✓ photos.addTags | ✓ geo.setLocation | ✓ photos.setMeta | ✓ photosets.addPhoto |
| **SmugMug** | ✗ | ✗ | ✓ Keywords | ✗ | ✓ Caption | ✓ |
| **Google Photos** | ✗ | ✗ | ✗ | ✗ | ✓ (nur eigene) | ✓ (nur eigene Alben) |

---

## 6. Album-Management

| Quelle | Alben listen | Fotos in Album | Album erstellen | Verschachtelt | Album-Typen | Multi-Album-Query |
|---|---|---|---|---|---|---|
| **Local** | ✗ (Ordner) | Ordner = Album | ✓ Ordner erstellen | ✓ Filesystem | Ordner | ✗ |
| **ServerPath** | ✗ (Ordner) | Ordner = Album | ✗ keine Backend-Route | ✗ | Ordner | ✗ |
| **WebDAV** | ✗ (Ordner) | Ordner = Album | ✓ MKCOL | ✓ | Ordner | ✗ |
| **S3** | ✗ (Prefix) | Prefix = Album | ✗ (Prefix simuliert) | ✓ | Prefix | ✗ |
| **Immich** | ✓ GET /albums | ✓ Album-Assets | ✓ POST /albums | ✗ flach | Alben | ◐ (bei Setup Multi-Select) |
| **Photoprism** | ✓ GET /albums | ✓ ?album=uid | ✓ POST /albums | ✗ flach | album, folder, moment, month, state | ✗ |
| **Synology** | ✓ Browse.Album | ✓ album_id | ✓ | ✗ flach | Normal + Conditional (Smart) | ✗ |
| **Piwigo** | ✓ categories.getList | ✓ cat_id rekursiv | ✓ categories.add | ✓ unbegrenzt | Kategorien + Smart (Plugin) | **✓ cat_id Array** |
| **Lychee** | ✓ GET /Albums + Album::albums | ✓ album_id | ✓ POST /Album | ✓ parent_album | Alben + Smart (recent/highlighted/on_this_day/unsorted/untagged/1-5star) + Tag-Alben | ✗ |
| **Dropbox** | ✗ (Ordner) | Ordner = Album | ✓ create_folder_v2 | ✓ | Ordner | ✗ |
| **Google Drive** | ✗ (Ordner) | folderId in parents | ✓ Ordner erstellen | ✓ | Ordner | ✗ |
| **OneDrive** | ◐ Bundles (Beta) | ✓ itemId/children | ✓ Ordner erstellen | ✓ (Ordner) | Ordner + Special Folders + Bundles | ✗ |
| **Flickr** | ✓ photosets.getList | ✓ photosets.getPhotos | ✓ photosets.create | ✓ Collections > Sets | Collections, Photosets, Galleries | ✗ |
| **SmugMug** | ✓ FolderAlbums | ✓ album!images | ✓ POST folders/albums | ✓ max 5 Ebenen | Folders + Albums | ✗ |
| **Google Photos** | ◐ nur Picker-UI | ◐ nur Picker-Auswahl | ✓ nur eigene | ✗ | Alben (nur eigene) | ✗ |

---

## 7. Echtzeit / Change Detection

| Quelle | Webhooks | Delta/Polling | Live-Watch | Wie? |
|---|---|---|---|---|
| **Local** | ✗ | ✗ | ◐ möglich aber nicht impl. | File System Observer API (Chrome Origin Trial) |
| **ServerPath** | ✗ | ✗ | ◐ möglich | Backend könnte fswatch/inotify nutzen |
| **WebDAV** | ✗ | ✗ | ✗ | — |
| **S3** | ◐ | ✗ | ◐ | S3 Event Notifications (SNS/SQS) |
| **Immich** | ✗ | ✗ | ✗ | — (Feature Request offen) |
| **Photoprism** | ✗ | ✗ | ✗ | Feature geplant |
| **Synology** | ✗ | ✗ | ✗ | — |
| **Piwigo** | ✗ | ✗ | ✗ | — |
| **Lychee** | ✗ | ✗ | ✗ | — |
| **Dropbox** | ✗ | ✓ | ✗ | `list_folder/longpoll` — long-polling auf Cursor |
| **Google Drive** | ✗ | ✓ | ✗ | `changes.list` + `changes.watch` (Push via Webhook an Server) |
| **OneDrive** | **✓** | ✓ | ✗ | `POST /subscriptions` + Delta API. Einziger mit echten Webhooks. |
| **Flickr** | ✗ | ✗ | ✗ | — |
| **SmugMug** | ◐ | ✗ | ✗ | Begrenzte Event-Integrations |
| **Google Photos** | ✗ | ✗ | ✗ | — |

---

## 8. Persistenz-Optionen

| Quelle | .dat neben Originalen | .dat Methode | OPFS lokal | Sync-Server | Duplikat hochladen |
|---|---|---|---|---|---|
| **Local** | ✓ | FS API write | Fallback | optional | ✗ (Datei ist schon lokal) |
| **ServerPath** | ✗ nicht impl. | — kein writeSidecar | ✓ | für Multi-Device | ✗ |
| **WebDAV** | ✓ | PUT Request | Fallback | optional | ✗ |
| **S3** | ✓ | PUT Object | Fallback | optional | ✗ |
| **Dropbox** | ✓ | files/upload | Fallback | optional | ✓ upload mode:overwrite |
| **Google Drive** | ✗ nicht impl. | — kein writeSidecar | ✓ | für Multi-Device | ✓ files.update |
| **OneDrive** | ✓ | PUT content | Fallback | optional | ✓ PUT overwrite |
| **Immich** | ✗ | — | ✓ | für Multi-Device | ✓ POST /assets (neues Asset) |
| **Photoprism** | ✗ (API) | ✗ (aber FS via SSH/SMB) | ✓ | für Multi-Device | ✓ POST /upload |
| **Synology** | ✗ (API) | ✗ (aber SMB zum NAS) | ✓ | für Multi-Device | ✓ Upload API |
| **Piwigo** | ✗ (API) | ✗ (aber FS-Zugriff) | ✓ | für Multi-Device | ✓ images.upload |
| **Lychee** | ✗ (API) | ✗ (aber FS-Zugriff) | ✓ | für Multi-Device | ✓ POST /Photo (chunked multipart) |
| **Flickr** | ✗ | — | ✓ | für Multi-Device | ✓ services/replace/ |
| **SmugMug** | ✗ | — | ✓ | für Multi-Device | ✓ upload |
| **Google Photos** | ✗ | — | ✓ | für Multi-Device | ✓ uploads (eigenes Album) |

---

## 9. Auth-Komplexität

| Quelle | Methode | Implementierungsaufwand | Token-Refresh nötig | Besonderheiten |
|---|---|---|---|---|
| **Local** | Browser Permission | keiner | Nein | Chrome merkt sich, Firefox nicht |
| **ServerPath** | keine (internes Netz) | keiner | Nein | ALLOWED_ROOTS Validierung |
| **WebDAV** | Basic Auth | gering | Nein | Base64 username:password |
| **S3** | Access Key + Secret | mittel | Nein | AWS Signature V4 nicht implementiert; Provider gesperrt |
| **Immich** | API-Key | gering | Nein | Key aus Immich UI kopieren |
| **Photoprism** | Session oder App-PW | gering | Ja (Session-Timeout) | App-Passwords haben kein Timeout |
| **Synology** | Session + OTP | mittel | Ja (Session-Timeout) | 2FA/OTP macht es komplexer |
| **Piwigo** | API-Key (v16+) oder Session | gering | Nein (API-Key) | API-Key nur für bestimmte Methoden |
| **Lychee** | Session oder API-Token | gering | Ja (Session) / Nein (Token) | XSRF-Token Handling |
| **Dropbox** | OAuth 2.0 PKCE | mittel | Ja (Refresh Token) | bereits implementiert |
| **Google Drive** | OAuth 2.0 PKCE | mittel | Ja (Refresh Token) | App Review für drive Scope |
| **OneDrive** | OAuth 2.0 PKCE | mittel | Ja (Refresh Token) | Microsoft Identity Platform |
| **Flickr** | OAuth 1.0a | **hoch** | Nein (Token permanent) | HMAC-SHA1 Signing pro Request |
| **SmugMug** | OAuth 1.0a | **hoch** | Nein (Token permanent) | Braucht aktives Abo |
| **Google Photos** | OAuth 2.0 PKCE + Picker | mittel | Ja | Picker API = separate JS-Library |

---

## 10. Zusammenfassung: Was geht wirklich?

### Vollständig self-contained (kein Sync-Server nötig)

| Quelle | Browse | Thumbs | EXIF | Edits in .dat | Multi-Device .dat Sync |
|---|---|---|---|---|---|
| **Local** | ✓ FS walk | ✓ generieren → .dat | ✓ aus Datei → .dat | ✓ | via Ordner-Sync Tools |
| **WebDAV** | ✓ PROPFIND | ✓ Nextcloud oder gen. → .dat PUT | ◐ aus Datei → .dat | ✓ PUT | automatisch (WebDAV-Server) |
| **S3** | ✓ ListV2 | ✓ generieren → .dat PUT | ◐ aus Datei → .dat | ✓ PUT | automatisch (S3-Bucket) |
| **Dropbox** | ✓ list_folder | ✓ API liefert | ◐ nur GPS+Datum | ✓ upload .dat | **automatisch via Dropbox-Sync!** |
| **OneDrive** | ✓ items/children | ✓ Graph thumbnails | ✓ photo facet (Personal) | ✓ PUT .dat | automatisch via OneDrive-Sync |

### Braucht Sync-Server ODER Hybrid-Zugang für Multi-Device Edits

| Quelle | Browse | Thumbs | EXIF | Edits wo? | Alternative zu Sync-Server |
|---|---|---|---|---|---|
| **ServerPath** | ✓ Backend | ✓ Backend generiert | ✓ Backend liest | OPFS (nur lokal) | Denselben Ordner als Local-Quelle öffnen → .dat dort |
| **Google Drive** | ✓ files.list | ✓ thumbnailLink | ✓ imageMediaMetadata | OPFS (nur lokal) | Lokal gesyncten Drive-Ordner als Local-Quelle → .dat dort |
| **Immich** | ✓ API | ✓ API | ✓ exifInfo | OPFS (nur lokal) | Immich-Ordner als Local-Quelle → .dat dort |
| **Photoprism** | ✓ API | ✓ API | ✓ voll | OPFS (nur lokal) | Originals-Ordner als Local-Quelle → .dat |
| **Synology** | ✓ API | ✓ API | ✓ get_exif | OPFS (nur lokal) | NAS-Share als SMB-Quelle → .dat auf NAS |
| **Piwigo** | ✓ API | ✓ Server-Derivate | ✓ getExif | OPFS (nur lokal) | galleries/ als Local-Quelle → .dat |
| **Lychee** | ✓ API | ✓ Server-Derivate | ✓ voll | OPFS (nur lokal) | uploads/ als Local-Quelle → .dat |

### Braucht zwingend Sync-Server für Multi-Device Edits

| Quelle | Browse | Thumbs | EXIF | Edits wo? | Bearbeitetes Foto zurück? |
|---|---|---|---|---|---|
| **Flickr** | ✓ photos.search | ✓ URL-Schema | ✓ photos.getExif | OPFS oder Sync-Server | ✓ services/replace/ |
| **SmugMug** | ✓ album!images | ✓ ImageSizes | ✓ in Image | OPFS oder Sync-Server | ✓ upload |
| **Google Photos** | ◐ nur Picker | ✓ baseUrl (60min!) | ◐ kein GPS | OPFS oder Sync-Server | ✓ uploads (eigenes Album) |
