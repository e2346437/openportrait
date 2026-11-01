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
- Print ordering from galleries and lab fulfilment (WHCC, Miller's, and others). These come after 1.0, and the data model leaves room for them.

## 2. Feature scope

All of these are in scope for 1.0. The milestones in section 10 set the build order.

| Area | What it covers |
|---|---|
| **CRM** | Contacts (people) and optional households or companies, tags, notes, activity timeline (emails, payments, shoots, gallery views), search. |
| **Leads** | Inquiries from a public contact form or booking page, a lead pipeline with configurable stages, lead source tracking, convert lead to shoot. |
| **Shoots** | A job for a client: type (wedding, portrait, mini session, and so on), one or more dates and locations, status, linked quote, orders, questionnaires, gallery, and tasks. |
| **Calendar** | Studio calendar of shoots, appointments, and personal blocks, with two-way Google Calendar sync. |
| **Booking pages** | Public, branded pages that sell a package or session type: pick a time, answer questions, pay a deposit, and get a shoot created automatically. |
| **Schedulers** | Availability rules (weekly hours, date overrides, buffers, minimum notice, max per day), session types and lengths, and mini-session slot lists. Used by booking pages and by direct "book a call" links. |
| **Quotes and orders** | Package and product catalog, quotes with line items and options, client acceptance, then orders or invoices with payment schedules, online payments through PayPal (behind a provider interface, so Stripe or Square can be added later), and manual payments (cash, check, Venmo). |
| **Contracts** | Contract templates with merge fields, client e-signature on booking pages and in the portal (typed or drawn signature, consent checkbox), countersignature by the studio, and a signed PDF with an audit trail (signer name, email, IP address, user agent, timestamps, document hash) stored on the shoot. A booking can require a signed contract before the deposit. |
| **Credits and coupons** | Client account credit (gift cards, package print credit) applied to orders. Coupon codes (percent or fixed, expiry, usage limits, scoped to products or booking pages). |
| **Questionnaires** | A form builder (text, choice, date, file upload, and so on), templates attached to shoot types, sent automatically or by hand, and answers stored on the shoot. |
| **Galleries** | Client galleries fed from the Unraid share or a web upload, with sets, cover images, multiple favorites lists (each with an optional cap, submitted by the client), downloads (full, web-size, or per photo), access by private link (default), password, or invited emails, expiry dates, and view and download tracking. Each gallery has a payment-lock mode chosen when it is published (lock all downloads until paid, Highlights early with the rest when paid, or no lock), and the studio default lives in Settings > Galleries. The watermark shows only while downloads are payment-locked and goes away automatically once the balance is paid; downloaded files are never watermarked. Each shoot type has an auto-publish switch (off by default) that sends the gallery live as soon as an export finishes. |
| **Email** | SMTP sending, branded templates with merge fields, a message log per contact. Automated workflows (for example "send questionnaire 14 days before the shoot") come after 1.0. |

## 3. Architecture

```
               Internet (clients)                    LAN (editing workstation)
                     │                                        │
     Cloudflare edge (HTTPS, Access)                   SMB export from Lightroom
                     │                                 or Aftershoot
┌────────────────────┼────────────────────────────────────────┼──────────────┐
│ openportrait container + cloudflared (outbound only)        │              │
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
4. Each new folder is matched to a shoot by its name (see **Folder names** below). A folder OpenPortrait created, or one whose name parses to a single shoot's date, type, and subject, attaches automatically. Anything else lands in an **Unmatched folders** inbox in the admin UI. One click attaches it to a shoot, with suggestions ranked by date, type, and subject name.
5. Subfolders become gallery sets. A file counts as stable once its size stops changing for a short time, so half-written exports are never picked up.
6. Originals are never modified or moved. Previews go to `/cache`.

### Folder names

Gallery folders are named from the shoot's **subject name**, **shoot date**, and **shoot type** (Headshot, Wedding, Lifestyle, and so on), not from codes.

- Every shoot has a **subject** field, the people being photographed (for example "Jane Smith" or "Emma & Liam"). It defaults to the client's name and can differ from the person paying.
- When a shoot is booked, OpenPortrait creates its folder on the share right away, so it's ready as an export target in Lightroom or Aftershoot. The folder path is stored on the shoot, so it always matches exactly, even if names are later edited.
- The pattern is a setting (Settings > Galleries) built from tokens: `{year}`, `{month}`, `{date}` (YYYY-MM-DD), `{type}`, `{subject}`, `{client}`, and `{location}`. A live preview shows the result. The default is:

```
{year}/{date} {type} - {subject}

/galleries/2026/2026-11-14 Headshot - Jane Smith/
    Highlights/
    Full Gallery/
```

- Names are made safe for Windows, macOS, and SMB (no `/ \ : * ? " < > |`, no trailing dots or spaces). If two shoots would get the same name, a short suffix is added (`... - Jane Smith (2)`).
- For folders created by hand, the watcher parses the name with the same pattern. If the date, type, and subject match exactly one shoot, it attaches. If not, the folder goes to the Unmatched inbox.
- Renaming a shoot or changing its date doesn't silently move its folder, because that would break export presets that point at it. The shoot page offers a **Rename folder** button instead.
- Shoots still have an internal ID for links and the database, but it never needs to appear in folder names.

### Remote: web upload page

The admin UI has an upload page (desktop and mobile) for a gallery or set. Files go through tus into the same `/galleries` tree, in the folder for that shoot, so local and remote photos end up in one place.

### Lightroom cloud API (later, optional)

Adobe has a Lightroom Partner API that could pull albums straight from Lightroom cloud. It needs Adobe to approve each integration, which makes it a poor fit for a self-hosted app. It stays a stretch goal, and the folder workflow is the supported path.

## 5. Data model (core entities)

- **Contact**, **Household** (optional grouping), **Tag**, **Note**, **Activity**
- **Lead** (source, stage, inquiry answers) → converts to **Shoot**
- **Shoot** (subject name, type, status, folder path, contacts, dates/locations as **ShootEvent**); **ShootType** (name, folder label, auto-publish switch, default questionnaire and contract)
- **CalendarEvent** (shoot events, appointments, blocks, with a Google event ID and etag for sync)
- **Scheduler** (availability rules, overrides, buffers) and **SessionType**; **Appointment**
- **BookingPage** (public slug, linked packages, scheduler, questionnaire, deposit rule)
- **Product** and **Package** (catalog); **Quote** and **QuoteLine**
- **Order** (invoice) and **OrderLine**, **PaymentSchedule**, **Payment** (PayPal or manual; `provider` column for future processors)
- **ContractTemplate**, **Contract** (rendered snapshot, status, signed PDF path), **Signature** (signer, method, IP, user agent, timestamp, document hash)
- **Credit** (ledger of client credit) and **Coupon** with **CouponRedemption**
- **QuestionnaireTemplate** and **Questionnaire** (sent instance with answers)
- **Gallery**, **GallerySet**, **Photo** (path, content hash, EXIF, derivative status), **FavoriteList**, **DownloadEvent**
- **EmailTemplate**, **Message** (log)
- **User** (staff, roles, TOTP), **ClientAccess** (magic-link sessions), **Setting**, **AuditLog**

## 6. Integrations

| Integration | Approach |
|---|---|
| **Google Calendar** | OAuth 2.0 with the photographer's own Google Cloud OAuth client (setup guide in the docs). Two-way sync using sync tokens and incremental polling every few minutes. Push notifications are optional when the install has a public HTTPS URL. Studio events go in a dedicated "OpenPortrait" calendar, and other calendars are read only for busy times. |
| **PayPal** | PayPal Checkout (Orders v2 API) for deposits and invoice payments, with webhooks for confirmation. The client ID and secret are entered in Settings. Payments go through a `PaymentProvider` interface, so Stripe and Square can be added as connectors later. |
| **Email** | Any SMTP provider. |
| **Sprout Studio import** | A one-time importer for CSV exports (contacts, leads, shoots or projects, invoices and payments where available). Mapping is shown before anything is written. ERW Photography's exports are the test data. |
| **Lightroom / Aftershoot** | Folder export (section 4). |

## 7. Access and security

- **Staff:** email and password with Argon2id hashing, optional TOTP 2FA, and the roles Owner, Staff, and Assistant.
- **Clients:** no passwords. Magic-link email sign-in to a client portal (quotes, invoices, questionnaires, galleries). Galleries can also have an optional gallery password or a public link.
- **Exposure:** OpenPortrait assumes it is published through a Cloudflare Tunnel (section 9). No router ports are opened. Port 8080 stays available on the LAN for local access. Other reverse proxies may work but aren't supported.
- **Secrets:** a session key is generated on first run and stored in `/config`. PayPal and Google secrets are encrypted at rest with that key.
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
| `CLOUDFLARE_TUNNEL_TOKEN` | Variable (masked) | empty | Token for the built-in cloudflared. It can also be pasted in Settings > Internet access. |
| `APP_URL` | Variable | empty | Public URL, for example `https://studio.example.com`. Filled in automatically from the tunnel when left empty. |
| `WATCH_RESCAN_MINUTES` | Variable (advanced) | `5` | Backstop rescan interval |
| `LOG_LEVEL` | Variable (advanced) | `info` | |

## 9. Cloudflare Tunnel (the standard deployment)

Every install is assumed to be reached from the internet through a Cloudflare Tunnel. Setup should take a photographer with a domain on Cloudflare about five minutes and no networking knowledge.

### Built-in cloudflared

- The image bundles `cloudflared` and runs it under the same supervisor as the app, but only when a tunnel token is set. Without a token, nothing extra runs.
- It uses a remotely managed tunnel. The photographer creates the tunnel in the Cloudflare dashboard, adds a public hostname pointing to `http://localhost:8080`, and pastes the token. No config files and no second container.
- The token can come from the Unraid template (`CLOUDFLARE_TUNNEL_TOKEN`) or from **Settings > Internet access**. It is stored encrypted, and changing it restarts the tunnel without restarting the app.
- Anyone who already runs cloudflared in its own container can leave the token empty and point their existing tunnel at port 8080. The app detects Cloudflare traffic either way.

### In-app setup guide (Settings > Internet access)

A guided screen with numbered steps, short screenshots, and live checks:

1. **Domain on Cloudflare:** explains what this means, with a link to add a site in Cloudflare.
2. **Create the tunnel:** a deep link to Zero Trust > Networks > Tunnels, the exact values to enter (service type HTTP, URL `localhost:8080`), and a field to suggest a subdomain such as `studio`.
3. **Paste the token:** a masked field that validates the token format and starts the tunnel.
4. **Live status:** connector state (from cloudflared's local metrics endpoint), the public hostname, and an end-to-end test where the app fetches its own public URL. Each failure shows a plain-language fix.
5. **Protect the admin (recommended):** step-by-step Cloudflare Access setup for the admin paths only. Client pages (`/g`, `/book`, `/portal`, `/sign`) stay public.

The first-run setup wizard links to this screen, and the dashboard shows a banner until the tunnel is healthy.

### Settings that help behind Cloudflare

| Setting | Default | Purpose |
|---|---|---|
| Tunnel token | empty | Starts the built-in cloudflared. |
| Public URL | from the tunnel hostname | Used in emails, booking links, gallery links, and PayPal and Google callback URLs. |
| Trust Cloudflare headers | on when traffic arrives through Cloudflare | Uses `CF-Connecting-IP` for real client IPs in contract audit trails, download logs, and rate limits. Requests that didn't come through Cloudflare (LAN) use the socket address. |
| Cloudflare Access protection | off | When on, admin routes require a valid `Cf-Access-Jwt-Assertion` (team domain and AUD tag set here) in addition to the OpenPortrait login. LAN access can be exempted. |
| Upload chunk size | 50 MB | Kept under Cloudflare's 100 MB request limit on the free plan. |
| Image caching | on | Sends long-lived, immutable cache headers on signed preview URLs so Cloudflare's edge caches gallery previews. Full-res downloads bypass the cache. |
| LAN address | detected | Shown on the guide so the photographer can always reach the admin locally if the tunnel is down. |

### Documentation

`docs/cloudflare-tunnel.md`, also linked from the in-app guide, covers: prerequisites, the step-by-step setup with screenshots, using an existing cloudflared container instead, Cloudflare Access for the admin, recommended Cloudflare settings (SSL mode Full, caching rules, and turning off Rocket Loader for the app), troubleshooting (error 1033, 502s, redirect loops, uploads failing), and what to do when the tunnel is down.

## 10. Milestones

1. **Spec** (this document).
2. **Skeleton and packaging:** repo tooling, Dockerfile with built-in cloudflared, CI image build to GHCR, Unraid template, first-run setup wizard (studio name, owner account), login, Settings including the Internet access guide, the design system and app shell.
3. **Business core:** CRM, leads, shoots, calendar and Google sync, schedulers and booking pages, questionnaires, contracts and e-signatures, quotes, orders and PayPal payments, credits and coupons, and the Sprout import.
4. **Galleries:** folder watcher and matching, the upload page, client gallery experience, favorites, downloads, and links to orders.

Each milestone ships as a tagged release that installs and runs on Unraid.

## 11. Decisions

Decided by Eric on 2026-11-01:

1. **Contracts and e-signatures** are in 1.0.
2. **Payments:** PayPal first, behind a provider interface. Manual payments are always available.
3. **License:** AGPL-3.0 (see `LICENSE`). Outside contributions are accepted under a contributor agreement (see `CONTRIBUTING.md`), so a future paid edition can be offered under a separate license.
4. **Print store:** after 1.0.
5. **Database:** SQLite only in 1.0, with the code kept Postgres-ready (Drizzle) so Postgres can be added later. Keep `/config` on a cache pool or disk path, not a `/mnt/user` FUSE path.
6. **Internet access:** always through a Cloudflare Tunnel, with cloudflared built into the container, an in-app setup guide, and docs (section 9).
7. **Galleries:** private link by default, a payment-lock mode picked per gallery with the default in Settings, multiple favorites lists with optional caps, auto-publish per shoot type (off by default), and the watermark only while downloads are locked. Details are in `docs/GALLERIES.md`.

Still needed: sample Sprout Studio CSV exports (contacts, leads, projects, invoices, payments), with names scrambled, to build the importer.
