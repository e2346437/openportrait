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

All of these are in scope for 1.0. The milestones in section 11 set the build order.

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

### Stack

- **Language:** TypeScript end to end, so contributors work in one language.
- **Server:** Node.js 22 LTS with Fastify (HTTP API, auth, uploads).
- **Web UI:** React and Vite, with a small in-repo design system built on the brand tokens (Ink, Paper, Lens). The admin app and client-facing pages (booking, galleries, questionnaires, quotes) share components but have separate layouts.
- **Database:** SQLite in WAL mode through Drizzle ORM, stored in `/config`. One studio's data is small, SQLite needs no second container, and backup is a single file. Drizzle keeps a later PostgreSQL option open.
- **Background jobs:** an in-process job queue persisted in SQLite. It handles thumbnail generation, Google Calendar sync, email sending, and zip building.
- **Images:** sharp (libvips) for previews and watermarks, and exifr for metadata and capture dates. Derivatives are WebP and AVIF at a few fixed sizes in `/cache`.
- **Uploads:** the tus resumable upload protocol (tus server plus Uppy in the browser). Uploads survive dropped connections and get past proxy request-size limits; the Cloudflare free plan caps a request at 100 MB, so chunking is required.
- **Packaging:** one multi-arch image (amd64 and arm64) built by GitHub Actions and published to `ghcr.io/e2346437/openportrait`.

### Routes

- Staff pages live under `/studio/*` and the staff API under `/api/studio/*`. One Cloudflare Access application on those two paths protects the whole back office.
- Client pages (`/g`, `/book`, `/portal`, `/sign`) and `/api/health` stay public. The AI endpoints (`/mcp`, `/oauth/*`, `/.well-known/oauth-*`) are public paths with their own authentication (section 10). `/` redirects to `/studio` until client pages exist.
- `/api/health` returns the version and an instance id (an HMAC of the instance's secret key), which the tunnel test uses to confirm the public hostname reaches this server.

### Repository layout

A pnpm monorepo: `apps/server` (Fastify API, job runner, cloudflared supervisor, `openportrait` maintenance CLI), `apps/web` (React), `packages/db` (Drizzle schema in `src/schema/<area>.ts`, SQL migrations in `migrations/`), `packages/jobs` (`defineJob`, `enqueue`, `JobRunner`), `packages/config` (environment and folder paths), and `packages/ui` (tokens, base styles, components).

### Why one container

Unraid users expect one template and one container. Postgres or Redis sidecars make installs and updates harder, and a single studio does not need them.

## 4. Getting photos into galleries

Neither Lightroom (cloud or Classic) nor Aftershoot has an integration point OpenPortrait can rely on, but both can export to a folder. So the folder is the integration.

### Local: export to the share (no upload)

1. In the Unraid template, the photographer maps a gallery share such as `/mnt/user/galleries` to `/galleries`.
2. From the workstation, they export from Lightroom Classic, Lightroom (cloud desktop app), or Aftershoot straight into that share over SMB.
3. OpenPortrait watches `/galleries`. It uses inotify where it works and a periodic rescan as a backstop, because SMB writes onto Unraid's user-share filesystem are not always reported.
4. Each new folder is matched to a shoot by its name (see **Folder names** below). A folder OpenPortrait created, or one whose name parses to a single shoot's date, type, and subject, attaches automatically. Anything else lands in an **Unmatched folders** inbox in the admin UI. One click attaches it to a shoot, with suggestions ranked by date, type, and subject name.
5. Only the shoot's **delivery folder** (default `Gallery/`) feeds the client gallery, and its subfolders become gallery sets. Other subfolders, such as `Originals/RAW/`, are never shown to clients. A file counts as stable once its size stops changing for a short time, so half-written exports are never picked up.
6. Originals are never modified or moved. Previews go to `/cache`.

### Folder names

Gallery folders are named from the shoot's **subject name**, **shoot date**, and **shoot type** (Headshot, Wedding, Lifestyle, and so on), not from codes.

- Every shoot has a **subject** field, the people being photographed (for example "Jane Smith" or "Emma & Liam"). It defaults to the client's name and can differ from the person paying.
- When a shoot is booked, OpenPortrait creates its folder on the share right away, so it's ready as an export target in Lightroom or Aftershoot. The folder path is stored on the shoot, so it always matches exactly, even if names are later edited.
- The pattern is a setting (Settings > Galleries) built from tokens: `{year}`, `{month}`, `{date}` (YYYY-MM-DD), `{type}`, `{subject}`, `{client}`, and `{location}`. A live preview shows the result. The default is:

```
{year}/{date} {type} - {subject}

/galleries/2026/2026-11-14 Headshot - Jane Smith/
    Originals/RAW/       ← camera files (from in-camera upload or a card)
    Gallery/             ← Lightroom/Aftershoot exports; this is what clients see
        Highlights/
        Full Gallery/
```

- The subfolders created inside each shoot folder are a setting too (default `Originals/RAW` and `Gallery`), as is which one is the delivery folder.
- Names are made safe for Windows, macOS, and SMB (no `/ \ : * ? " < > |`, no trailing dots or spaces). If two shoots would get the same name, a short suffix is added (`... - Jane Smith (2)`).
- For folders created by hand, the watcher parses the name with the same pattern. If the date, type, and subject match exactly one shoot, it attaches. If not, the folder goes to the Unmatched inbox.
- Renaming a shoot or changing its date doesn't silently move its folder, because that would break export presets that point at it. The shoot page offers a **Rename folder** button instead.
- Shoots still have an internal ID for links and the database, but it never needs to appear in folder names.

### In-camera upload (FTP/SFTP from the camera)

Cameras such as the Nikon Z9 can send each photo over the network as it is taken. OpenPortrait includes a built-in upload server for this.

**Server**
- A built-in server for **SFTP** (recommended, one port, encrypted), plus **FTPS** and plain **FTP** for cameras that need them. Each protocol is off until it's turned on in Settings > Camera upload.
- Each camera gets its own login, created in Settings with a generated password and a printable setup card listing the exact values to enter on the camera (host, port, protocol, user, password, folder). Logins can upload only, cannot delete or overwrite, and are limited to their own folder.
- Files land in an **Incoming** area, a separate Unraid share (for example `/mnt/user/incoming` mapped to `/incoming`), in one folder per camera and day: `/incoming/Z9/2026-11-14/`. It's visible on the network, so Lightroom or Aftershoot can import straight from it.
- Brute-force protection: failed logins are rate-limited and repeat offenders are blocked for a while, and the activity log shows every connection.

**Getting from the camera to the server**

Cloudflare Tunnel only carries web traffic for free. Raw FTP or SFTP from a camera can't go through it, because the camera can't run Cloudflare's client software, and Cloudflare's TCP proxying (Spectrum) for arbitrary ports is an Enterprise feature. So in-camera upload supports these routes, and both remote options are fully supported with their own setup wizard and documentation:

1. **Direct SFTP (recommended for remote shoots):** forward a single port on the router (for example 2222) to the container. Add a **DNS-only (grey cloud)** Cloudflare record such as `upload.example.com` that points at the home IP, kept current by a dynamic-DNS updater that OpenPortrait can run using a Cloudflare API token. The camera connects over a phone hotspot or venue Wi-Fi. Only SFTP is exposed, never the web admin or plain FTP.
2. **Travel router with WireGuard:** the camera joins a small travel router (for example a GL.iNet) that tunnels home over WireGuard, so the camera reaches the server as if it were on the LAN, with no SFTP port exposed. This is the most secure option and needs extra hardware.
3. **LAN only:** in the studio, the camera uploads over home Wi-Fi with no internet exposure at all.

**Setup wizards (Settings > Camera upload)**

- **Direct SFTP wizard:** turns on the SFTP server and creates the camera login, then shows the router port-forward values (with links to guides for common routers). It creates the DNS-only `upload.` record and keeps it current through dynamic DNS using a Cloudflare API token limited to DNS edits for that zone. It checks from outside that the port is reachable and the record points home, and finishes with the camera setup card.
- **WireGuard travel router wizard:** uses Unraid's built-in WireGuard (Settings > VPN Manager), so the container needs no extra privileges. It walks through creating a peer for the travel router, importing the config on a GL.iNet-style router, and pointing the camera at the server's LAN address. It finishes with a test upload and the camera setup card.
- **At home:** the same camera login works directly on the LAN with no extra setup. The setup card lists both the LAN address and the remote address.
- Each wizard ends with a live **Send a test photo** check that waits for the camera's first file and confirms it arrived in Incoming.

**Documentation:** `docs/camera-upload-sftp.md` and `docs/camera-upload-wireguard.md` include step-by-step Nikon Z9 menus (other cameras with FTP/SFTP follow the same values), plus troubleshooting for timeouts, authentication failures, and hotspot NAT.

**Sorting incoming photos**

The **Incoming** screen shows thumbnails of new camera files, using the JPEG preview embedded in each RAW file (NEF, CR3, ARW, and so on), grouped by camera and capture time.
- OpenPortrait suggests a shoot for each group by matching capture times against shoots on the calendar.
- The photographer selects photos (or a whole group) and picks **Move to shoot**. They are moved into that shoot's `Originals/RAW/` folder, with checksums verified before the incoming copy is removed.
- Or the photographer ignores the screen and points Lightroom or Aftershoot at the Incoming folder directly. Nothing in Incoming is ever deleted automatically. An optional cleanup only offers to remove files older than N days that have already been moved.

**Delivery**

After editing, Lightroom or Aftershoot exports to the shoot's `Gallery/` folder, and the normal watcher picks the photos up from there for the client gallery (and auto-publishes them if the shoot type allows it).

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
- **AiConnection**, **Approval**, **AutomationSetting**, **WorkItem** (section 10)

## 6. Integrations

| Integration | Approach |
|---|---|
| **Google Calendar** | OAuth 2.0 with the photographer's own Google Cloud OAuth client (setup guide in the docs). Two-way sync using sync tokens and incremental polling every few minutes. Push notifications are optional when the install has a public HTTPS URL. Studio events go in a dedicated "OpenPortrait" calendar, and other calendars are read only for busy times. |

Google sync details (as built): shoot times are the source of truth, so one deleted in Google is restored on the next pass, while appointments and time off deleted in Google are deleted locally. Edits made in Google to a time or place come back; a shoot time's title is always rebuilt from the shoot. Events created in the OpenPortrait Google calendar import as appointments. Other calendars store busy times only, never titles. All-day items end at the start of the day after their last day. Changes in the app are pushed within seconds, and a five-minute poll is the backstop. Setup guide: [`docs/google-calendar.md`](google-calendar.md).
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

## 8. Packaging: Docker and Unraid

There is one image, `ghcr.io/e2346437/openportrait` (mirrored to Docker Hub as `openportrait/openportrait` if that name is available), for amd64 and arm64. Unraid and plain Docker run exactly the same container, and the Unraid template is just a friendly front end for it.

- **Plain Docker:** the repo ships a `docker-compose.yml` and a `docker run` example in `docs/install-docker.md`, with the same volumes (`/config`, `/galleries`, `/incoming`, `/cache`), ports, and variables. `PUID`/`PGID` default to `1000` outside Unraid. This works on Synology, TrueNAS, a Linux server, or Docker Desktop.
- **Unraid:** the Community Applications template described below, with Unraid's defaults (`99`/`100`, `/mnt/user/...` paths).
- **Platform-specific features:** the app detects Unraid and adjusts its guides. The WireGuard camera-upload wizard uses Unraid's VPN Manager on Unraid. On other systems it walks through WireGuard on the router or a `wg-easy` container instead. Everything else is identical.
- CI tests the image with both the compose file and the Unraid template's settings before each release.
- **Image contents:** `node:22-bookworm-slim` plus three static release binaries: `cloudflared`, `tini` (PID 1) and `gosu`. The entrypoint creates a user for `PUID`/`PGID`, applies `UMASK`, takes ownership of `/config` and `/cache`, fixes only the top level of `/galleries` and `/incoming` (never walking a photo library), and drops privileges. better-sqlite3 and argon2 use their bundled prebuilt binaries, so no compiler is needed for amd64 or arm64.
- **Tags:** until 1.0, `latest` and `edge` follow `main`; release tags `vX.Y.Z` publish `X.Y.Z` and `X.Y`. At 1.0, `latest` moves to releases only.
- **Maintenance CLI:** `docker exec -it openportrait openportrait reset-password <email>` sets a temporary password and signs the account out everywhere; `openportrait backup` writes a snapshot to `/config/backups` (nightly snapshots are automatic, 14 kept).

### Unraid template


- The template lives in this repo at `unraid/openportrait.xml`. It is later submitted to Community Applications through a templates repo and an Unraid forum support thread.
- Icon: `docs/brand/openportrait-icon-512.png` (served from the raw GitHub URL).
- WebUI: `http://[IP]:[PORT:8080]/studio`. Category: Productivity and Media Servers: Photos.
- Template settings (infrastructure only; everything else is in the app's Settings page):

| Setting | Type | Default | Notes |
|---|---|---|---|
| WebUI port | Port | `8080` | |
| App data | Path | `/mnt/user/appdata/openportrait` → `/config` | Database, keys, backups |
| Galleries | Path | `/mnt/user/galleries` → `/galleries` | Gallery originals share |
| Incoming | Path | `/mnt/user/incoming` → `/incoming` | Camera uploads (SFTP/FTP) before sorting |
| SFTP port | Port | `2222` | In-camera upload over SFTP (off until turned on in Settings) |
| FTP ports | Port (advanced) | `2121`, passive `30000-30009` | Only needed for cameras without SFTP |
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

- The image bundles `cloudflared`, and the app runs it as a child process (with restart backoff) only when a tunnel token is set. Without a token, nothing extra runs. Pasting any of the install commands Cloudflare shows works; the app finds the token in it. Common cloudflared failures (bad token, no DNS, port 7844 blocked) are shown in plain language.
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

## 10. AI access (MCP) and automation

OpenPortrait ships a built-in MCP (Model Context Protocol) server so the owner can connect an AI assistant (Claude, ChatGPT, Claude Code, Cursor, or any MCP client) and have it run the studio. The same release adds an **automation mode**: the owner chooses whether routine decisions are made by OpenPortrait's built-in schedulers or by the connected AI. Safety controls are part of the design, not an add-on.

### Principles

1. **One service layer.** The UI, the API, and MCP tools all call the same domain services. Permission checks, validation, and audit logging live there once, so the AI can never do something the UI would refuse.
2. **MCP parity.** Every feature module registers its tools next to its routes (`defineTool`), and a feature is not done until its tools exist. The business-core and gallery work grows the tool list without touching the MCP plumbing.
3. **Safe by default.** A new connection starts read-only. The AI can look at everything it is allowed to see, and anything that reaches a client or touches money waits for the owner's OK until the owner says otherwise.
4. **Easy to connect, easy to cut off.** Connecting takes one pasted URL. One switch pauses all AI access.

### Server and transport

- **Streamable HTTP** MCP endpoint at `/mcp` (stateless, using the official TypeScript SDK). No stdio and no extra process. It works through the Cloudflare Tunnel like any other route, and on the LAN at `http://[IP]:8080/mcp`.
- **Routes.** `/mcp`, `/oauth/*`, and `/.well-known/oauth-*` are public paths that carry their own authentication, so they stay outside the Cloudflare Access application that protects `/studio/*`. (AI clients cannot pass an Access login.) The Access guide in section 9 says so.
- **Off until enabled.** `/mcp` returns 404 until the owner turns on **Settings > Connect your AI**. It also requires a healthy public URL for remote clients.

### Authentication

| Method | For | How |
|---|---|---|
| **OAuth 2.1** (authorization code with PKCE, dynamic client registration, protected-resource and authorization-server metadata) | Claude and ChatGPT custom connectors, and any client that supports remote MCP | The owner pastes the URL into the client. The client opens an OpenPortrait consent page, the owner signs in (or is already signed in), reviews the requested access, and approves. Access tokens are short-lived and refresh tokens rotate. |
| **Access token** | Claude Code, Cursor, scripts, and clients without OAuth | Created in Connect your AI with a label, access level, and optional expiry. Shown once, stored as a SHA-256 hash, sent as `Authorization: Bearer`. |

Only the Owner role can connect an AI or create tokens. An AI acts as a non-human actor named after its connection ("Claude (laptop)"), never as a user, and has no session, password, or TOTP. Staff and Assistant roles cannot raise an AI's access.

### The "Connect your AI" screen (Settings > Connect your AI)

1. **Turn on.** A single toggle, with a banner linking to Internet access if the tunnel is not healthy.
2. **Copy your address.** The MCP URL with a copy button.
3. **Pick your assistant.** Tabs for Claude, ChatGPT, Claude Code, and "Other", each with the exact steps and a copy-paste snippet (for example `claude mcp add --transport http openportrait <url>`). Token-based tabs create the token inline.
4. **Choose what it can do.** Access presets (below), then per-area toggles (Contacts and leads, Shoots and calendar, Quotes and orders, Galleries, Email).
5. **Live check.** "Waiting for your assistant to connect" turns into a green "Connected: Claude (last seen just now)" the first time a client calls the server. A test button runs a harmless read tool and shows the result.
6. **Manage.** A list of connections with label, access level, last used, and requests today, with Edit and Revoke. A prominent **Pause all AI access** switch sits at the top.

All states are designed: not enabled, tunnel down, waiting, connected, paused, revoked, and token expired.

### Access levels and risk tiers

Every tool declares an area and a **risk tier**. A connection's access level decides which tiers it may call at all, and the approval policy decides which of those run immediately.

| Tier | Examples | Read only | Assist (default for new connections) | Full |
|---|---|---|---|---|
| **Read** | List and search contacts, leads, shoots, calendar, orders, galleries; read the work queue | Yes | Yes | Yes |
| **Draft** (internal and reversible) | Add notes and tasks, move a lead stage, create a draft quote or email, create a shoot, propose an appointment time | No | Yes | Yes |
| **Outward** (reaches a client or goes public) | Send an email, send a quote or contract, publish a gallery, confirm a booking, send a questionnaire | No | Queued for approval | Approval by default, can be set to auto per action |
| **Money** | Create an invoice, record a payment, issue a credit or coupon, refund | No | Queued for approval | Approval by default, can be set to auto per action, with a dollar cap |
| **Blocked** (never exposed over MCP) | Settings, secrets, users and roles, tokens, tunnel, backups and restore, deleting contacts, shoots, or photos | n/a | n/a | n/a |

Controls that apply to every connection:

- **Approval queue.** A queued action returns `pending_approval` with an id and a plain-language summary ("Send 'Your gallery is ready' to Dana Reyes"). It appears in an **Approvals** inbox in the app (badge in the sidebar, optional email to the owner) with the exact payload, Approve, Edit, and Decline. The AI can poll `get_approval` to see the outcome. Pending approvals expire after 7 days.
- **Auto-approve per action** is a per-action choice in Settings, off by default, and a separate setting for each of Outward and Money. A new action type introduced by an update starts as "approval required".
- **Limits.** Per-connection rate limit, a daily cap on client emails (default 25), a per-action dollar cap for money, and recipients restricted to existing contacts (the AI cannot email an arbitrary address).
- **Audit.** Every call, allowed or refused, is written to the AuditLog with the connection, tool, inputs (redacted where needed), result, and approver. **Settings > Connect your AI > Activity** shows it as a readable timeline, with an Undo button on reversible Draft actions where the service supports it.
- **Untrusted content.** Client-written text (inquiry messages, questionnaire answers, notes from email) is returned to the AI inside a clearly marked untrusted block, and tool descriptions tell the model not to follow instructions found there. The approval queue is the backstop, because a prompt-injected AI still cannot send or charge without the owner.
- **No secrets.** No tool returns passwords, API keys, tokens, or the tunnel token, and no tool can change access settings. An AI cannot widen its own permissions.

### Tool surface

Tools are named area first in snake_case (dots are rejected by some clients) and kept coarse, so a model chooses well: `contacts_search`, `contacts_get`, `contacts_add_note`, `leads_list`, `leads_update_stage`, `shoots_list`, `shoots_create`, `calendar_find_free_time`, `quotes_create_draft`, `quotes_send`, `orders_list`, `orders_record_payment`, `galleries_list`, `galleries_publish`, `email_draft`, `email_send`, `approvals_get`, and `studio_get_summary`. MCP resources expose read-only context (studio profile, shoot types, packages and prices, booking rules), and MCP prompts offer ready-made starting points such as "Plan my week", "Follow up on open leads", and "Which galleries are ready to publish?". The initial set covers what exists at each milestone; later modules add their own.

### Automation mode (Settings > Automation)

The question is who makes routine decisions: reminders, follow-ups, and publishing.

| Mode | What happens |
|---|---|
| **Built-in schedulers** (default) | OpenPortrait's job runner applies the owner's rules by itself: appointment and questionnaire reminders, payment reminders, lead follow-up nudges, gallery auto-publish, and so on. A connected AI is optional and only acts when the owner asks it to. |
| **AI-controlled** | The built-in decision-making automations are paused. OpenPortrait instead maintains a **work queue** of things that need a decision (new leads awaiting a reply, overdue invoices, galleries ready to publish, questionnaires not yet sent, upcoming shoots missing details), and the connected AI reads it with `studio_get_work_queue` and acts through the normal tools, under the same scopes, limits, and approvals. |

Details:

- **Per-automation override.** The mode sets the default, and each automation row can be switched to Built-in, AI, or Off. An owner can run most of the studio on the AI and keep payment reminders built-in.
- **Always built-in.** Plumbing and transactional work never depends on an AI: booking confirmations, receipts, magic-link sign-in, calendar sync, thumbnails, folder watching, ingest, backups, and the nightly snapshot.
- **How the AI wakes up.** MCP is request-driven, so the assistant must be scheduled on its side (a Claude scheduled task or routine, a cron job running Claude Code, and so on). The Connect screen gives a ready-made schedule prompt ("Every morning, call `studio_get_work_queue` and handle each item"). Optionally, OpenPortrait can ping a webhook URL when new items arrive, for example a Zapier or Claude trigger, signed with an HMAC.
- **Failsafe.** Each queue item has an age. If the AI has not checked in within a window the owner picks (default 24 hours), the dashboard shows a warning and the owner can choose, per automation, to fall back to Built-in after that window. The default is to warn only, so nothing starts sending on its own unexpectedly.
- **Transparency.** The dashboard shows the current mode, the last AI check-in, queue size, and pending approvals. Every action is attributed to Built-in or to the named AI connection in the activity timeline.
- **Registration.** Automations are declared with `defineAutomation({ id, trigger, defaultOwner, ... })`. Business-core and gallery threads register theirs, so one table in Settings lists them all.

### Data model additions

**AiConnection** (type: oauth or token, label, token hash, scopes, access level, per-action policies, expiry, last used, revoked at), **OAuthClient** and **OAuthGrant** (registered clients, auth codes, rotating refresh tokens), **Approval** (connection, tool, summary, payload, status, decided by and at, expires at), **AutomationSetting** (automation id, owner: built-in, ai, or off), **WorkItem** (the queue, derived from existing data and cached), and an actor type and connection id on **AuditLog**. Setting keys: `ai.enabled`, `ai.paused`, `ai.emailDailyCap`, `automation.mode`, `automation.aiCheckinWindowHours`.

### Build plan

Delivered as its own milestone after the skeleton, and extended as each module lands:

1. **Foundation:** `/mcp` endpoint, tool registry (`defineTool`), access tokens, the Connect your AI screen (turn on, copy URL, token tab, connection list, pause), audit trail, and a first read-only tool set over what exists (studio summary, settings that are safe to read).
2. **OAuth:** dynamic registration, consent page, refresh rotation, verified against Claude and ChatGPT custom connectors.
3. **Write tools and approvals:** access levels, the Approvals inbox, limits, undo, and the Draft/Outward/Money tiers, enabled per module as the business core ships.
4. **Automation mode:** the automation registry, Settings > Automation, the work queue, schedule prompts, webhook ping, and the failsafe.

Tests cover the auth paths, tier enforcement (a Read-only token cannot call a Draft tool; a blocked action does not exist), approval flow, and an end-to-end run with the MCP SDK client against the real server.

### Email, inquiry and booking (step 3c)

- Outgoing email uses the studio's own SMTP account (Settings > Email), queued as a retrying job, with a log of recent sends. If email isn't configured, nothing fails; the client just isn't emailed.
- Public pages live under `/inquire`, `/book/:slug` and `/book/cancel/:token`, backed by `/api/public/*`, which is outside the Cloudflare Access paths and rate limited. `?embed=1` drops the page frame for use in an iframe.
- A booking page ("scheduler") has weekly hours, length, buffers, minimum notice and a horizon. Slots are computed from the weekly hours minus calendar busy time and re-checked when booked. Requests hold a "Pending" calendar entry until confirmed or declined. Details: [`booking.md`](booking.md).
- Booking pages that include packages, contracts or deposits arrive with quotes and contracts (steps 3d and 3e).

## 11. Milestones

1. **Spec** (this document).
2. **Skeleton and packaging:** repo tooling, Dockerfile with built-in cloudflared, CI image build to GHCR, Unraid template, first-run setup wizard (studio name, owner account), login, Settings including the Internet access guide, the design system and app shell.
3. **Business core:** CRM, leads, shoots, calendar and Google sync, schedulers and booking pages, questionnaires, contracts and e-signatures, quotes, orders and PayPal payments, credits and coupons, and the Sprout import.
4. **Galleries:** folder watcher and matching, the upload page, client gallery experience, favorites, downloads, and links to orders.

5. **AI access (MCP) and automation mode:** section 10. The foundation and OAuth can land right after the skeleton, and write tools and automations arrive with the modules they control.

Each milestone ships as a tagged release that installs and runs on Unraid.

## 12. Decisions

Decided by Eric on 2026-11-01:

1. **Contracts and e-signatures** are in 1.0.
2. **Payments:** PayPal first, behind a provider interface. Manual payments are always available.
3. **License:** AGPL-3.0 (see `LICENSE`). Outside contributions are accepted under a contributor agreement (see `CONTRIBUTING.md`), so a future paid edition can be offered under a separate license.
4. **Print store:** after 1.0.
5. **Database:** SQLite only in 1.0, with the code kept Postgres-ready (Drizzle) so Postgres can be added later. Keep `/config` on a cache pool or disk path, not a `/mnt/user` FUSE path.
6. **Internet access:** always through a Cloudflare Tunnel, with cloudflared built into the container, an in-app setup guide, and docs (section 9).
7. **In-camera upload:** a built-in SFTP/FTP server writes to an Incoming share, with a sorting screen that moves files into each shoot's `Originals/RAW/`. Because Cloudflare Tunnel can't carry it, both remote routes are supported, each with a setup wizard and docs: direct SFTP on a DNS-only Cloudflare record with dynamic DNS, and a WireGuard travel router through Unraid's VPN Manager. At home the camera uploads straight over the LAN (section 4).
8. **Galleries:** private link by default, a payment-lock mode picked per gallery with the default in Settings, multiple favorites lists with optional caps, auto-publish per shoot type (off by default), and the watermark only while downloads are locked. Details are in `docs/GALLERIES.md`.

9. **AI access:** proposed in section 10. Eric chose on 2026-11-01 that outward and money actions need approval by default. The rest of the design, the failsafe default, and the first clients to verify are awaiting confirmation.

Still needed: sample Sprout Studio CSV exports (contacts, leads, projects, invoices, payments), with names scrambled, to build the importer.
