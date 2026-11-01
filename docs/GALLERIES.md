# Galleries: design

Status: reviewed by Eric (decisions in section 11). This expands sections 2, 4 and 5 of [`SPEC.md`](SPEC.md) for milestone 4. Where the two disagree, this file is newer, and SPEC.md gets updated when it merges.

Clickable prototype of every screen below: https://claude.ai/artifact/EEJivTCVktFUipZEGrUYug (private to the project owner).

## 1. Goals

- **Zero-step ingest when local.** Export from Lightroom (cloud or Classic) or Aftershoot into the gallery share, and the photos show up in the right gallery with no upload and no clicks.
- **Reliable upload when remote.** A resumable upload page that survives a hotel Wi-Fi drop, a closed laptop lid, and Cloudflare's 100 MB request cap.
- **A client gallery that feels like the photographer's, not like software.** Photos first, studio branding, no account to create, and favorites and downloads that work on a phone.
- **One source of truth.** Originals live once, on the share, in a folder a person can browse. OpenPortrait never moves, renames, or edits them.

## 2. Folder model

```
/galleries                                  ← Unraid share, mapped in the template
  2026/
    2026-11-14 Family - Smith Family/       ← shoot folder: the match target, named from date, type and subject
      Originals/RAW/                        ← camera files; never read by the gallery watcher, never shown to clients
      Gallery/                              ← delivery folder: the gallery root (Lightroom/Aftershoot export here)
        Highlights/                         ← a set
        Full Gallery/                       ← a set
        _hidden/                            ← ignored (leading underscore)
  .openportrait/                            ← OpenPortrait's own temp area (uploads in progress)

/incoming                                   ← separate share for in-camera uploads (SPEC.md section 4)
  Z9/2026-11-14/                            ← one folder per camera and day
```

Rules:

- **A shoot folder holds a gallery.** The shoot folder is what gets matched to a shoot. Its **delivery folder** (default `Gallery/`, a setting) is the gallery root. The other subfolders created at booking (default `Originals/RAW/`, also a setting) are skipped entirely by the gallery watcher.
- **Subfolders of the delivery folder are sets.** One level only. Images loose in the delivery folder go into a set named after the gallery, which is hidden if it is empty. Deeper folders are flattened into their top-level set.
- **Hand-made folders without a delivery folder:** if a matched shoot folder has images but no `Gallery/` subfolder (for example an export straight into the shoot folder), its images and non-reserved subfolders are treated as the gallery, and the gallery detail offers to tidy them into `Gallery/`.
- **Ignored:** names starting with `.` or `_`, `@eaDir`, `#recycle`, `Thumbs.db`, `.DS_Store`, AppleDouble `._*` files, sidecars (`.xmp`, `.json`, `.txt`), RAW files, and partial files (`*.tmp`, `*.part`, `*.crdownload`).
- **Image types:** JPEG, PNG, TIFF, WebP, and AVIF. HEIC is accepted if the image's libvips build supports it; otherwise the file is flagged as unsupported. Video is out of scope for 1.0.
- **OpenPortrait creates the shoot folder and its subfolders when a shoot is booked**, from the folder pattern in Settings › Galleries, and stores its path on the shoot. Exporting into that folder is an exact match with nothing to type.
- **Folder pattern** tokens: `{year}` `{month}` `{date}` `{type}` `{subject}` `{client}` `{location}`. The default is `{year}/{date} {type} - {subject}`, for example `2026/2026-11-14 Headshot - Jane Smith/`. `{type}` is the shoot type's folder label (Headshot, Wedding, Lifestyle, Family…), and `{subject}` is the shoot's subject, which defaults to the client's name.
- Names are made SMB-safe (no `\ / : * ? " < > |`, no trailing dots or spaces), and a name already in use gets a ` (2)` suffix.
- **Renaming a shoot never moves its folder.** The gallery detail offers a **Rename folder** button that renames it to the current pattern and updates the stored path.

## 3. Ingest pipeline

```
 watcher event or rescan ─► IngestFolder (stabilizing) ─► stable ─► match ─┬─► matched ─► import ─► derivatives ─► ready
                                                                           └─► Unmatched inbox ─► photographer picks a shoot ─┘
```

### 3.1 Watching

- inotify (via chokidar) on `/galleries`, with a full rescan every `WATCH_RESCAN_MINUTES` (default 5) as a backstop, because SMB writes into Unraid's user-share FUSE layer are not always reported.
- A rescan compares path, size and mtime against the `photo` table, so it costs a directory walk, not a re-read of every file.
- An admin "Rescan now" button runs the same scan for one gallery or for the whole share.

### 3.2 Stability

Lightroom and Aftershoot write files over several seconds and exports can run for an hour. A file is imported only when:

1. its size and mtime are unchanged across two checks `INGEST_SETTLE_SECONDS` apart (default 10), and
2. it opens and decodes (catches a file that was truncated but has stopped growing).

A folder counts as **quiet** when nothing in it has changed for 2 minutes. "Quiet" is what triggers the "47 new photos in Smith Family" notification, so the photographer gets one notice per export, not one per file.

Files are imported as soon as they are stable, so a large export appears in the admin progressively. Clients see nothing until the gallery is published (section 5.1).

### 3.3 Matching a folder to a shoot

In order:

1. **Already known.** The folder path belongs to an existing gallery.
2. **Shoot folder.** The folder is, or is inside, a shoot folder OpenPortrait created (its stored path). Only new files under that shoot's delivery folder are imported.
3. **Parsed name.** For a folder made by hand, the watcher parses its path with the same folder pattern. If the date, type and subject it reads match exactly one shoot (case- and accent-insensitive), the folder attaches to that shoot's gallery, creating the gallery if needed.
4. **Otherwise the Unmatched inbox.** The folder waits in the admin with up to three suggested shoots, ranked by date (from the folder name, or the photos' capture dates when the name has none), then type, then subject. One click attaches it, and the photographer can tick "Rename the folder to match the shoot" so it follows the pattern from then on.

Nothing is published or emailed automatically from a suggestion. Only an exact match or a photographer's click attaches a folder.

### 3.4 Re-exports, renames and deletions

Photographers re-export edits. These rules keep favorites and download history attached to the right photo:

| On disk | OpenPortrait |
|---|---|
| Same path, new content (re-export over the top) | Same photo. Content hash updated, derivatives rebuilt, favorites kept. The admin shows "updated". |
| New path, same content hash (file renamed or moved to another set) | Same photo, path updated. |
| New file | New photo, appended in capture-time order. |
| File gone | Photo marked **missing** and hidden from clients. Favorites are kept so the photographer can see what was lost. It is restored if the file comes back within 30 days and purged after that. |
| Whole folder gone | Gallery marked **source missing** in the admin. Nothing is deleted. This usually means the share is not mounted. |

### 3.5 Derivatives

Built by the job queue with sharp, stored in `/cache/<gallery id>/`, never next to originals:

| Name | Size (long edge) | Format | Use |
|---|---|---|---|
| `thumb` | 640 px | WebP | Grid (covers 2x density at 320 px tiles) |
| `preview` | 2048 px | WebP | Lightbox, cover image |
| `web` | 2048 px | JPEG, sRGB, EXIF kept except GPS | "Web size" downloads |
| `wm-*` | as above | WebP | Watermarked previews, built only while a gallery's downloads are payment-locked |

- Orientation is applied, everything is converted to sRGB, and GPS data is stripped from anything served to clients.
- A tiny blurred placeholder (about 24 px, stored inline in the database) shows while each thumbnail loads, so the grid never jumps.
- Jobs for the cover and the first screen of photos run first. A full re-render (for example after the watermark image changes) runs at low priority.
- Downloads are never watermarked: web-size downloads come from `web`, full resolution from the original.
- Full-resolution downloads stream the original file unchanged.
- `/cache` is disposable: deleting it rebuilds everything.

## 4. Remote upload

- **Protocol:** tus 1.0 (`@tus/server` with a file store, and Uppy in the browser). Chunks are 50 MB to stay under Cloudflare's 100 MB request limit.
- **Where files land:** chunks are written to `/galleries/.openportrait/uploads/`, which the watcher ignores, then moved into the target set folder under the shoot's `Gallery/` once complete. The watcher therefore never sees a half-uploaded file, and remote uploads take exactly the same import path as local exports.
- **Resume:** Uppy keeps a fingerprint of each file in the browser, so reopening the page and re-adding the same files continues where they stopped. Incomplete server-side uploads expire after 7 days.
- **Duplicates:** a file whose hash already exists in the gallery is skipped and reported as "already in gallery".
- **Concurrency:** 3 files at once by default. The page shows overall progress, per-file progress, speed, and time remaining, plus a clear "connection lost, retrying" state.
- **Mobile:** the page works from a phone (pick photos from the camera roll) for quick sneak peeks.

## 4a. Behind Cloudflare Tunnel

OpenPortrait is always exposed through Cloudflare Tunnel (SPEC.md section 9), so the gallery pipeline is built for it:

- **Uploads:** tus chunks are 50 MB, under Cloudflare's 100 MB request-body limit. Each chunk is its own request, so a slow connection never hits an edge timeout.
- **Edge-cacheable previews:** `thumb` and `preview` URLs include the photo's content hash and derivatives version (`/media/<photo>/<hash>/preview.webp`) and carry a short-lived signature, so the edge can cache them with `Cache-Control: public, max-age=31536000, immutable`. A re-export changes the hash and therefore the URL, so a stale cache never needs purging. Watermarked and clean variants have different URLs, so lifting a lock never serves a cached watermark.
- **Never cached at the edge:** full-resolution originals, web-size downloads and zips are sent `Cache-Control: private, no-store` after an access check.
- **Long responses:** zip downloads stream, and their headers go out immediately, so Cloudflare's 100-second wait for the first byte never applies. Builds that take longer use the background zip job and an email link (section 6.4).
- **Real client IPs:** download and view logs use `CF-Connecting-IP`, trusted only on requests that arrive from the built-in cloudflared on loopback. Anything else uses the socket address.
- **Links in emails** use the public hostname from the tunnel settings (`APP_URL`), never the LAN address.

## 5. Admin experience

### 5.1 Gallery lifecycle

`Draft` → `Live` → `Archived`, plus `Expired` when the expiry date passes (clients see an "expired" page with a contact link, and the photographer can extend with one click).

- New galleries start as **Draft**. The photographer reviews, picks a cover, then clicks **Publish and email client**. The publish dialog sets the **download lock** for this gallery (section 6.4), starting from the studio default in Settings › Galleries, then sends the gallery email template and logs it on the shoot.
- **Auto-publish** is a switch on each shoot type, off by default. When it is on, a matched export goes live once the folder is quiet, using the studio defaults, for workflows such as mini sessions.
- A gallery added to a Live gallery's folder later (for example a second batch) appears to clients right away, and the photographer can choose whether to notify them.

### 5.2 Screens

1. **Galleries list.** Cover thumbnail, title, client, shoot type and date, status chip, photo count, processing progress, views, favorites, downloads, and expiry. Filters by status, search by client, subject or type, sorted by most recent activity.
2. **Gallery detail.** A header with status, client, the share link (copy), "Preview as client", and the primary action (Publish, or Email client again). Tabs:
   - **Photos:** sets as a sidebar list (reorder, rename, hide), the photo grid with per-photo state (processing, updated, missing, hidden), multi-select to hide, move, or set the cover, and sort by capture time, filename, or manual order. Drag to reorder.
   - **Favorites:** each client's lists with counts, submitted state, and notes; export the filenames as a Lightroom-ready search string (`DSC_0012 OR DSC_0047 …`) and as CSV.
   - **Activity:** views, downloads (which photos, which size), favorites, and emails sent, in one timeline.
   - **Settings:** access, download size, download lock, favorites lists, expiry, and the linked order or invoice.
3. **Unmatched inbox.** Folders waiting for a shoot, each with its path, photo count, capture date range, sample thumbnails, state (still copying, or ready), and suggested shoots. Actions: attach, create a new shoot from the folder, or ignore.
4. **Upload.** Choose a gallery and set (or create one), drop files, and watch progress. The same page is reachable from the gallery detail with the gallery preselected.
5. **Incoming** (in-camera uploads, specified in SPEC.md section 4). Camera files grouped by camera and capture time, shown with the JPEG preview embedded in each RAW. Each group gets a suggested shoot (capture time against the calendar). Select photos or a whole group, then **Move to shoot**, which moves them into that shoot's `Originals/RAW/` with checksums verified first. A banner shows the network path of `/incoming` for photographers who would rather point Lightroom or Aftershoot at it directly. Nothing here ever reaches a client gallery. Only exports into `Gallery/` do.

Counts of unmatched folders and unsorted incoming photos appear as badges in the main navigation.

## 6. Client experience

### 6.1 Getting in

- The link is `APP_URL/g/<slug>`, for example `/g/smith-family-2026`.
- Access modes, per gallery: **private link** (the default: an unguessable URL), **password**, or **invited emails only** (magic link, same as the client portal). The default for new galleries is set in Settings › Galleries.
- In private-link and password mode, the client is asked for an email only at the first action that needs one (first favorite or first download), never before seeing the photos. This keeps the first visit to zero steps while still tracking who favorited what.
- Signed-in portal clients go straight in, and their galleries are listed in the portal.

### 6.2 Layout

- **Cover:** the cover photo full-bleed with the gallery title, date, and studio logo. One tap or scroll goes to the photos. The cover can be turned off.
- **Header (sticky):** studio logo, set tabs, and the actions Favorites (count), Download, Share, and Order.
- **Grid:** justified rows that keep each photo's aspect ratio, about 280 px tall on desktop and two columns on a phone, with lazy loading and blurred placeholders. A favorite shows as a filled heart on the tile.
- **Lightbox:** full-screen photo, swipe or arrow keys, actions for favorite, download this photo, and add a note. The URL updates (`#photo-0047`) so a client can send a link to one photo.
- **Expiry notice:** a quiet banner when a gallery expires within 14 days.
- **Branding:** studio logo, studio accent color, and a light or dark gallery theme, all from Settings. OpenPortrait appears only as a small "Powered by OpenPortrait" footer link, which can be turned off.

### 6.2a Presentation (Design tab)

Eric wants presentation control close to what Sprout galleries offer (cover photo, focal point, and how the cover carries through the main page and set pages). OpenPortrait matches the capability with its own design. Each gallery has a **Design** tab in the admin:

- **Cover photo and focal point.** Pick any photo as the gallery cover, then click or drag a point on it (arrow keys nudge it) to mark what must stay in frame. Every crop of that photo uses the point: the desktop cover, the phone cover, the gallery-list thumbnail, the email header, and the social share image. Live crop previews show all of these while dragging.
- **Set covers.** Each set has its own cover photo and focal point, used for its card on the gallery's main page and the banner at the top of its set page. A new set defaults to its first photo with a centered point.
- **Cover layout:** full bleed, split (text panel beside the photo), framed (inset photo with a centered title below), or text only.
- **Pages:** open on set cards (a main page with one card per set, then a page per set) or straight on the first set's photos; photo grid as rows (justified), columns (masonry) or squares; photo size small, medium or large; spacing none, tight, normal or airy; light or dark background; serif or sans titles.
- **Save as studio default** stores the current choices as the default for new galleries (Settings › Galleries).

Focal points are stored as percentages (`focal_x`, `focal_y`, 0 to 100) and applied with CSS `object-position`/`background-position`, so no extra derivatives are needed. The `og:image` share crop and the email header are rendered server-side with sharp using the same point (attention-based crop as a fallback when none is set).

### 6.3 Favorites and proofing

- Every gallery has a default list called **Favorites**. The photographer can add more named lists, each with an optional limit, such as "Album picks (40)" or "Wall print (1)". The limit is shown as a counter, and the heart refuses with an explanation when the list is full.
- A client can add a note to any favorite ("crop tighter", "remove the exit sign").
- Each list is submitted separately. **Submit to photographer** locks that list (the client can ask to unlock it) and notifies the photographer. Favorites from different emails on the same gallery are kept as separate lists, so a couple can each choose.

### 6.4 Downloads

- **Download size**, per gallery: no downloads, web size only, or web size and full resolution.
- **Download lock**, tied to the shoot's final invoice. The studio owner picks one of three modes when publishing, starting from the studio default in Settings › Galleries:
  - **Lock until paid:** nothing downloads until the balance is paid.
  - **Highlights early:** the Highlights set (any set marked "early") downloads now; the rest unlocks when paid.
  - **No lock:** downloads open as soon as the gallery is published.
- While anything is locked, the download dialog says why ("Full gallery downloads open once your final balance is paid") and links to the invoice. When the payment clears (PayPal webhook or a manual payment entry), the lock lifts automatically and the client can be emailed.
- **Watermark:** previews of locked photos are watermarked, and the watermark disappears automatically once the balance is paid. Downloaded files are never watermarked. Galleries with no lock never show a watermark.
- Optional download PIN, separate from the gallery password.
- **Download all** or a whole set or the favorites builds a zip in the background. Zips of up to 2 GB stream immediately. Larger ones are split into parts, and the client gets an email when they are ready. Zips are cached in `/cache` for 7 days.
- Single photos download straight from the lightbox.
- Every download is logged with who, what, and which size.

### 6.5 Orders

The gallery links to the client's orders in the portal: an **Order** button opens the client's order and invoice list for the shoot, and when an unpaid balance gates downloads, the download dialog links to that invoice. Print ordering comes after 1.0 (SPEC.md). Until then, a lightweight **Request prints** action on favorites lists sends the photographer a print request (photos plus notes), which they turn into a quote or order in the existing Orders feature.

## 7. Data model

Adds to the Gallery entities in SPEC.md section 5. Names follow the Drizzle schema conventions set up in milestone 2.

| Table | Key columns |
|---|---|
| `gallery` | `id`, `shoot_id` (nullable), `slug`, `title`, `folder_path` (relative to `/galleries`), `status` (draft, live, archived), `cover_photo_id`, `access_mode` (link, password, invited), `password_hash`, `download_size` (none, web, full), `download_lock` (until_paid, highlights_early, none), `unlocked_at`, `download_pin_hash`, `theme` (light, dark), `expires_at`, `published_at`, `cover_focal_x`, `cover_focal_y`, `design` (JSON: layout, landing, grid, size, spacing, theme, title font) |
| `gallery_set` | `id`, `gallery_id`, `name`, `folder_name`, `sort`, `hidden`, `early_download` (bool, the set Highlights-early unlocks), `cover_photo_id`, `cover_focal_x`, `cover_focal_y` |
| `photo` | `id`, `gallery_id`, `set_id`, `rel_path`, `filename`, `content_hash` (SHA-256), `size_bytes`, `mtime`, `width`, `height`, `taken_at`, `exif` (JSON, GPS removed), `placeholder` (tiny base64), `state` (pending, ready, missing, unsupported, error), `missing_since`, `derivatives_version`, `sort`, `hidden` |
| `ingest_folder` | `id`, `rel_path`, `state` (stabilizing, unmatched, matched, ignored), `file_count`, `taken_from`, `taken_to`, `first_seen_at`, `last_change_at`, `suggestions` (JSON), `gallery_id` |
| `favorite_list` | `id`, `gallery_id`, `name`, `max_count`, `sort` (photographer-defined lists) |
| `favorite_selection` | `id`, `favorite_list_id`, `client_email`, `submitted_at`, `locked` |
| `favorite_item` | `selection_id`, `photo_id`, `note`, `created_at` |
| `shoot` (existing) | uses `subject`, `shoot_type_id` and `folder_path` from SPEC.md |
| `shoot_type` (existing) | `name`, `folder_label`, `gallery_auto_publish` (bool, default false) |
| `download_event` | `id`, `gallery_id`, `photo_id` (nullable for zips), `scope` (photo, set, gallery, favorites), `variant` (web, full), `client_email`, `ip`, `created_at` |
| `gallery_view` | `id`, `gallery_id`, `client_email` (nullable), `ip_hash`, `created_at` |
| `zip_job` | `id`, `gallery_id`, `scope`, `variant`, `state`, `parts` (JSON), `expires_at` |

Gallery views, favorites, downloads and emails also write to the shared `activity` timeline on the contact and the shoot.

## 8. Settings

In the app's Settings, under Galleries (not in the Unraid template):

- Folder pattern for new shoots, with a live example (section 2).
- Defaults for new galleries: access mode (private link), download size, **download lock** (until paid, Highlights early, or no lock), expiry (days after publish), theme, and cover on or off.
- Watermark for payment-locked previews: image (PNG with transparency), position, size, and opacity, with a live preview.
- Gallery email template, and whether the photographer is emailed when a list is submitted.
- Advanced: settle seconds, zip cache days, missing-photo purge days.

Template variables already in SPEC.md section 8 (`WATCH_RESCAN_MINUTES`) stay. One more advanced variable: `INGEST_SETTLE_SECONDS` (default 10).

## 9. API sketch

Admin (session auth): `GET/POST /api/galleries`, `GET/PATCH /api/galleries/:id`, `POST /api/galleries/:id/publish`, `POST /api/galleries/:id/rescan`, `GET /api/ingest/folders`, `POST /api/ingest/folders/:id/attach`, `PATCH /api/photos/:id`, `POST /api/photos/bulk`, `/api/uploads/*` (tus).

Client (gallery session cookie, scoped to one gallery): `GET /g/:slug`, `GET /g/:slug/api/photos`, `PUT/DELETE /g/:slug/api/favorites/:listId/:photoId`, `POST /g/:slug/api/favorites/:listId/submit`, `POST /g/:slug/api/downloads` (returns a file or a zip job), `GET /media/:photoId/:variant` (signed, cacheable URLs).

## 10. Where the code goes

Following the milestone 2 layout (tentative until the skeleton lands):

- Schema: `packages/db/src/schema/galleries.ts`, migrations in `packages/db/migrations`.
- Watcher, matcher, importer, derivatives and zip jobs: `apps/server/src/galleries/`, registered with `defineJob` from `packages/jobs`. Paths come from `GALLERIES_DIR` and `CACHE_DIR` in `packages/config`.
- Admin screens: `apps/web` admin layout. Client gallery: `apps/web` client layout.
- Shared pieces (justified grid, lightbox, upload queue, status chip): `packages/ui`.

## 11. Decisions (from Eric, 2026-11-01)

1. **Access:** new galleries default to a private link; the email is captured at the first favorite or download. Password and invited-email access stay available per gallery, and the default is a setting.
2. **Downloads and payment:** all three lock modes (lock until paid, Highlights early, no lock). The owner picks per gallery when publishing; the studio default lives in Settings › Galleries.
3. **Favorites:** several lists per gallery, each with an optional cap, each submitted separately.
4. **Auto-publish:** a switch on each shoot type, off by default.
5. **Watermarks:** only on previews while downloads are payment-locked; removed automatically once paid. Downloads are never watermarked.

Payments go through PayPal behind a `PaymentProvider` interface (SPEC.md), and print ordering is after 1.0.
