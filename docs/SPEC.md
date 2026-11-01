# OpenPortrait: product spec and architecture

Status: draft for review (step 1 of the project plan). Open questions are listed at the end.

## 1. What OpenPortrait is

OpenPortrait is a self-hosted replacement for Sprout Studio. One install serves one studio: the photographer, any staff, and their clients. It runs as a single Docker container. Gallery images stay on the photographer's own storage (an Unraid share) instead of paid cloud storage.

It is built first for ERW Photography and released as open source, so everything studio-specific (name, logo, colors, email copy, packages) is a setting, not code.

### Goals

- Cover the Sprout Studio workflows ERW Photography uses every week (section 2).
- Get edited photos into client galleries with no manual upload when the editing machine is on the local network.
- Install from Unraid Community Applications with an icon, a WebUI link, and clearly labeled settings.
- Feel like a polished product. See the design standards in `CLAUDE.md`.

### Non-goals (for now)

- Multi-tenant hosting, where one install serves many studios.
- Being a photo editor or DAM. Editing stays in Lightroom and Aftershoot.
- Print lab fulfilment (WHCC, Miller's, and others). The data model leaves room for it later.

## 2. Feature scope

All of these are in scope for 1.0. The milestones in section 9 set the build order.

| Area | What it covers |
|---|---|
| **CRM** | Contacts (people) and optional households or companies, tags, notes, activity timeline (emails, payments, shoots, gallery views), search. |
| **Leads** | Inquiries from a public contact form or booking page, a lead pipeline with configurable stages, lead source tracking, convert lead to shoot. |
| **Shoots** | A job for a client: type (wedding, portrait, mini session, and so on), one or more dates and locations, status, linked quote, orders, questionnaires, gallery, and tasks. |
| **Calendar** | Studio calendar of shoots, appointments, and personal blocks, with two-way Google Calendar sync. |
| **Booking pages** | Public, branded pages that sell a package or session type: pick a time, answer questions, pay a deposit, and get a shoot created automatically. |
| **Schedulers** | Availability rules (weekly hours, date overrides, buffers, minimum notice, max per day), session types and lengths, and mini-session slot lists. Used by booking pages and by direct "book a call" links. |
| **Quotes and orders** | Package and product catalog, quotes with line items and options, client acceptance, then orders or invoices with payment schedules, card payments through Stripe, and manual payments (cash, check, Venmo). |
| **Credits and coupons** | Client account credit (gift cards, package print credit) applied to orders. Coupon codes (percent or fixed, expiry, usage limits, scoped to products or booking pages). |
| **Questionnaires** | A form builder (text, choice, date, file upload, and so on), templates attached to shoot types, sent automatically or by hand, and answers stored on the shoot. |
| **Galleries** | Client galleries fed from the Unraid share or a web upload, with sets, cover images, favorites and proofing, downloads (full, web-size, or per photo), optional watermark, password or email access, expiry dates, and view and download tracking. |
| **Email** | SMTP sending, branded templates with merge fields, a message log per contact. Automated workflows (for example "send questionnaire 14 days before the shoot") come after 1.0. |

## 3. Architecture

```
               Internet (clients)                    LAN (editing workstation)
                     │                                        │
     Cloudflare Tunnel / reverse proxy                 SMB export from Lightroom
                     │                                 or Aftershoot
┌────────────────────┼────────────────────────────────────────┼──────────────┐
│ openportrait container                                      │              │
│                                                             ▼              │
│  Web app (admin UI + client portal) ◄──► API ◄──► Job runner ◄── Folder     │
│                                         │        (thumbnails,    watcher    │
│                                         │         sync, email)              │
│                                    SQLite (WAL)                             │
└──────────┬───────────────────────┬──────────────────────┬──────────────────┘
       /config                 /galleries (Unraid share)  /cache
   (db, settings, keys)     originals, read-mostly       thumbnails, previews, zips
```

### Stack (proposed)

- **Language:** TypeScript end to end, so contributors work in one language.
- **Server:** Node.js 22 LTS with Fastify (HTTP API, auth, uploads).
- **Web UI:** React and Vite, with a small in-repo design system built on the brand tokens (Ink, Paper, Lens). The admin app and client-facing pages (booking, galleries, questionnaires, quotes) share components but have separate layouts.
- **Database:** SQLite in WAL mode through Drizzle ORM, stored in `/config`. One studio's data is small, SQLite needs no second container, and backup is a single file. Drizzle keeps a later PostgreSQL option open.
- **Background jobs:** an in-process job queue persisted in SQLite. It handles thumbnail generation, Google Calendar sync, email sending, and zip building.
- **Images:** sharp (libvips) for previews and watermarks, and exifr for metadata and capture dates. Derivatives are WebP and AVIF at a few fixed sizes in `/cache`.
- **Uploads:** the tus resumable upload protocol (tus server plus Uppy in the browser). Uploads survive dropped connections and get past proxy request-size limits; the Cloudflare free plan caps a request at 100 MB, so chunking is required.
- **Packaging:** one multi-arch image (amd64 and arm64) built by GitHub Actions and published to `ghcr.io/e2346437/openportrait`.

### Why one container

Unraid users expect one template and one container. Postgres or Redis sidecars make installs and updates harder, and a single studio does not need them.

## 4. Getting photos into galleries

Neither Lightroom (cloud or Classic) nor Aftershoot has an integration point OpenPortrait can rely on, but both can export to a folder. So the folder is the integration.

### Local: export to the share (no upload)

1. In the Unraid template, the photographer maps a gallery share such as `/mnt/user/galleries` to `/galleries`.
2. From the workstation, they export from Lightroom Classic, Lightroom (cloud desktop app), or Aftershoot straight into that share over SMB.
3. OpenPortrait watches `/galleries`. It uses inotify where it works and a periodic rescan as a backstop, because SMB writes onto Unraid's user-share filesystem are not always reported.
4. Each new folder is matched to a shoot:
   - **By shoot code:** each shoot gets a short code (for example `OP-1042`). A folder whose name contains the code attaches automatically.
   - **Otherwise:** the folder lands in an **Unmatched folders** inbox in the admin UI. One click attaches it to a shoot, with fuzzy matching on client name and date as suggestions.
5. Subfolders become gallery sets. A file counts as stable once its size stops changing for a short time, so half-written exports are never picked up.
6. Originals are never modified or moved. Previews go to `/cache`.

Suggested layout, which is not required:

```
/galleries/2026/2026-11-14 Smith Family OP-1042/
    Highlights/
    Full Gallery/
```

### Remote: web upload page

The admin UI has an upload page (desktop and mobile) for a gallery or set. Files go through tus into the same `/galleries` tree, in the folder for that shoot, so local and remote photos end up in one place.

### Lightroom cloud API (later, optional)

Adobe has a Lightroom Partner API that could pull albums straight from Lightroom cloud. It needs Adobe to approve each integration, which makes it a poor fit for a self-hosted app. It stays a stretch goal, and the folder workflow is the supported path.

## 5. Data model (core entities)

- **Contact**, **Household** (optional grouping), **Tag**, **Note**, **Activity**
- **Lead** (source, stage, inquiry answers) → converts to **Shoot**
- **Shoot** (code, type, status, contacts, dates/locations as **ShootEvent**)
- **CalendarEvent** (shoot events, appointments, blocks, with a Google event ID and etag for sync)
- **Scheduler** (availability rules, overrides, buffers) and **SessionType**; **Appointment**
- **BookingPage** (public slug, linked packages, scheduler, questionnaire, deposit rule)
- **Product** and **Package** (catalog); **Quote** and **QuoteLine**
- **Order** (invoice) and **OrderLine**, **PaymentSchedule**, **Payment** (Stripe or manual)
- **Credit** (ledger of client credit) and **Coupon** with **CouponRedemption**
- **QuestionnaireTemplate** and **Questionnaire** (sent instance with answers)
- **Gallery**, **GallerySet**, **Photo** (path, content hash, EXIF, derivative status), **FavoriteList**, **DownloadEvent**
- **EmailTemplate**, **Message** (log)
- **User** (staff, roles, TOTP), **ClientAccess** (magic-link sessions), **Setting**, **AuditLog**

## 6. Integrations

| Integration | Approach |
|---|---|
| **Google Calendar** | OAuth 2.0 with the photographer's own Google Cloud OAuth client (setup guide in the docs). Two-way sync using sync tokens and incremental polling every few minutes. Push notifications are optional when the install has a public HTTPS URL. Studio events go in a dedicated "OpenPortrait" calendar, and other calendars are read only for busy times. |
| **Stripe** | Checkout Sessions for deposits and invoice payments, and webhooks for confirmation. Keys are entered in Settings. |
| **Email** | Any SMTP provider. |
| **Sprout Studio import** | A one-time importer for CSV exports (contacts, leads, shoots or projects, invoices and payments where available). Mapping is shown before anything is written. ERW Photography's exports are the test data. |
| **Lightroom / Aftershoot** | Folder export (section 4). |

## 7. Access and security

- **Staff:** email and password with Argon2id hashing, optional TOTP 2FA, and the roles Owner, Staff, and Assistant.
- **Clients:** no passwords. Magic-link email sign-in to a client portal (quotes, invoices, questionnaires, galleries). Galleries can also have an optional gallery password or a public link.
- **Exposure:** the admin UI and client pages run on one port. The docs cover Cloudflare Tunnel (recommended), Nginx Proxy Manager, and SWAG. `APP_URL` sets the public base URL used in emails and links.
- **Secrets:** a session key is generated on first run and stored in `/config`. Stripe and Google secrets are encrypted at rest with that key.
- **Backups:** a nightly SQLite snapshot in `/config/backups` with retention, plus a one-click export.

## 8. Unraid packaging

- The template lives in this repo at `unraid/openportrait.xml`. It is later submitted to Community Applications through a templates repo and an Unraid forum support thread.
- Icon: `docs/brand/openportrait-icon-512.png` (served from the raw GitHub URL).
- WebUI: `http://[IP]:[PORT:8080]/`. Category: Productivity and Media Servers: Photos.
- Template settings (infrastructure only; everything else is in the app's Settings page):

| Setting | Type | Default | Notes |
|---|---|---|---|
| WebUI port | Port | `8080` | |
| App data | Path | `/mnt/user/appdata/openportrait` → `/config` | Database, keys, backups |
| Galleries | Path | `/mnt/user/galleries` → `/galleries` | Gallery originals share |
| Cache | Path | `/mnt/user/appdata/openportrait/cache` → `/cache` | Previews; can live on a cache pool |
| `PUID` / `PGID` / `UMASK` | Variable | `99` / `100` / `022` | Unraid's nobody:users |
| `TZ` | Variable | from Unraid | |
| `APP_URL` | Variable | empty | Public URL, for example `https://studio.example.com` |
| `WATCH_RESCAN_MINUTES` | Variable (advanced) | `5` | Backstop rescan interval |
| `LOG_LEVEL` | Variable (advanced) | `info` | |

## 9. Milestones

1. **Spec** (this document).
2. **Skeleton and packaging:** repo tooling, Dockerfile, CI image build to GHCR, Unraid template, first-run setup wizard (studio name, owner account), login, Settings, the design system and app shell.
3. **Business core:** CRM, leads, shoots, calendar and Google sync, schedulers and booking pages, questionnaires, quotes, orders and payments, credits and coupons, and the Sprout import.
4. **Galleries:** folder watcher and matching, the upload page, client gallery experience, favorites, downloads, and links to orders.

Each milestone ships as a tagged release that installs and runs on Unraid.

## 10. Open questions

1. **Contracts and e-signatures.** Sprout includes contracts with e-signing. Do you use them, and should they be in 1.0?
2. **Payments.** Is Stripe right, or do you take card payments through Square or PayPal today?
3. **License.** AGPL-3.0 is recommended, since it keeps hosted forks open and leaves room for a paid OpenPortrait Pro under a separate license. MIT is the alternative if maximum adoption matters more.
4. **Gallery store.** Should clients order prints in the gallery in 1.0, or can that wait?
5. **Sprout exports.** Which CSV exports can you pull (contacts, leads, projects, invoices, payments)? A sample of each, with personal details redacted, is enough to build the importer.
