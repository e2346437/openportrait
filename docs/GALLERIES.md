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
    2026-11-14 Smith Family OP-1042/        ← one gallery (matched by the shoot code)
      Highlights/                           ← a set
      Full Gallery/                         ← a set
      _hidden/                              ← ignored (leading underscore)
  .openportrait/                            ← OpenPortrait's own temp area (uploads in progress)
```

Rules:

- **A gallery is a folder.** Any folder that holds images directly, or holds subfolders that do, is a gallery candidate. The year folder above is only a convention; any depth works.
- **Subfolders are sets.** One level only. Images loose in the gallery folder go into a set named after the gallery, which is hidden if it is empty. Deeper folders are flattened into their top-level set.
- **Ignored:** names starting with `.` or `_`, `@eaDir`, `#recycle`, `Thumbs.db`, `.DS_Store`, AppleDouble `._*` files, sidecars (`.xmp`, `.json`, `.txt`), RAW files, and partial files (`*.tmp`, `*.part`, `*.crdownload`).
- **Image types:** JPEG, PNG, TIFF, WebP, and AVIF. HEIC is accepted if the image's libvips build supports it; otherwise the file is flagged as unsupported. Video is out of scope for 1.0.
- **Creating a gallery in the admin creates its folder** (`/galleries/<year>/<date> <client> <code>/`), so a later local export can go straight there. The folder pattern is a setting.

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
2. **Shoot code.** The folder name, or any parent folder name, contains a shoot code. The pattern is `<PREFIX>-<number>` with the prefix from Settings (default `OP`), matched case-insensitively and on word boundaries. A code that matches a shoot attaches the folder to that shoot's gallery, creating the gallery if needed.
3. **Otherwise the Unmatched inbox.** The folder waits in the admin with up to three suggestions, scored on the client's surname appearing in the folder name, the shoot date matching a date in the folder name or the photos' capture dates, and recency. One click attaches it, and the photographer can tick "Rename the folder to include the code" so it matches on its own next time.

Nothing is published or emailed automatically from a suggestion. Only an exact code match or a photographer's click attaches a folder.

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
- **Where files land:** chunks are written to `/galleries/.openportrait/uploads/`, which the watcher ignores, then moved into the target set folder once complete. The watcher therefore never sees a half-uploaded file, and remote uploads take exactly the same import path as local exports.
- **Resume:** Uppy keeps a fingerprint of each file in the browser, so reopening the page and re-adding the same files continues where they stopped. Incomplete server-side uploads expire after 7 days.
- **Duplicates:** a file whose hash already exists in the gallery is skipped and reported as "already in gallery".
- **Concurrency:** 3 files at once by default. The page shows overall progress, per-file progress, speed, and time remaining, plus a clear "connection lost, retrying" state.
- **Mobile:** the page works from a phone (pick photos from the camera roll) for quick sneak peeks.

## 5. Admin experience

### 5.1 Gallery lifecycle

`Draft` → `Live` → `Archived`, plus `Expired` when the expiry date passes (clients see an "expired" page with a contact link, and the photographer can extend with one click).

- New galleries start as **Draft**. The photographer reviews, picks a cover, then clicks **Publish and email client**. The publish dialog sets the **download lock** for this gallery (section 6.4), starting from the studio default in Settings › Galleries, then sends the gallery email template and logs it on the shoot.
- **Auto-publish** is a switch on each shoot type, off by default. When it is on, a matched export goes live once the folder is quiet, using the studio defaults, for workflows such as mini sessions.
- A gallery added to a Live gallery's folder later (for example a second batch) appears to clients right away, and the photographer can choose whether to notify them.

### 5.2 Screens

1. **Galleries list.** Cover thumbnail, title, client, shoot code, status chip, photo count, processing progress, views, favorites, downloads, and expiry. Filters by status, search by client or code, sorted by most recent activity.
2. **Gallery detail.** A header with status, client, the share link (copy), "Preview as client", and the primary action (Publish, or Email client again). Tabs:
   - **Photos:** sets as a sidebar list (reorder, rename, hide), the photo grid with per-photo state (processing, updated, missing, hidden), multi-select to hide, move, or set the cover, and sort by capture time, filename, or manual order. Drag to reorder.
   - **Favorites:** each client's lists with counts, submitted state, and notes; export the filenames as a Lightroom-ready search string (`DSC_0012 OR DSC_0047 …`) and as CSV.
   - **Activity:** views, downloads (which photos, which size), favorites, and emails sent, in one timeline.
   - **Settings:** access, download size, download lock, favorites lists, expiry, and the linked order or invoice.
3. **Unmatched inbox.** Folders waiting for a shoot, each with its path, photo count, capture date range, sample thumbnails, state (still copying, or ready), and suggested shoots. Actions: attach, create a new shoot from the folder, or ignore.
4. **Upload.** Choose a gallery and set (or create one), drop files, and watch progress. The same page is reachable from the gallery detail with the gallery preselected.

A count of unmatched folders appears as a badge on the Galleries item in the main navigation.

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
| `gallery` | `id`, `shoot_id` (nullable), `slug`, `title`, `folder_path` (relative to `/galleries`), `status` (draft, live, archived), `cover_photo_id`, `access_mode` (link, password, invited), `password_hash`, `download_size` (none, web, full), `download_lock` (until_paid, highlights_early, none), `unlocked_at`, `download_pin_hash`, `theme` (light, dark), `expires_at`, `published_at` |
| `gallery_set` | `id`, `gallery_id`, `name`, `folder_name`, `sort`, `hidden`, `early_download` (bool, the set Highlights-early unlocks) |
| `photo` | `id`, `gallery_id`, `set_id`, `rel_path`, `filename`, `content_hash` (SHA-256), `size_bytes`, `mtime`, `width`, `height`, `taken_at`, `exif` (JSON, GPS removed), `placeholder` (tiny base64), `state` (pending, ready, missing, unsupported, error), `missing_since`, `derivatives_version`, `sort`, `hidden` |
| `ingest_folder` | `id`, `rel_path`, `state` (stabilizing, unmatched, matched, ignored), `file_count`, `taken_from`, `taken_to`, `first_seen_at`, `last_change_at`, `suggestions` (JSON), `gallery_id` |
| `favorite_list` | `id`, `gallery_id`, `name`, `max_count`, `sort` (photographer-defined lists) |
| `favorite_selection` | `id`, `favorite_list_id`, `client_email`, `submitted_at`, `locked` |
| `favorite_item` | `selection_id`, `photo_id`, `note`, `created_at` |
| `shoot_type` (existing) | adds `gallery_auto_publish` (bool, default false) |
| `download_event` | `id`, `gallery_id`, `photo_id` (nullable for zips), `scope` (photo, set, gallery, favorites), `variant` (web, full), `client_email`, `ip`, `created_at` |
| `gallery_view` | `id`, `gallery_id`, `client_email` (nullable), `ip_hash`, `created_at` |
| `zip_job` | `id`, `gallery_id`, `scope`, `variant`, `state`, `parts` (JSON), `expires_at` |

Gallery views, favorites, downloads and emails also write to the shared `activity` timeline on the contact and the shoot.

## 8. Settings

In the app's Settings, under Galleries (not in the Unraid template):

- Shoot code prefix (default `OP`) and new-folder pattern.
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
