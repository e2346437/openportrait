# Changelog

All notable changes to OpenPortrait. The format follows [Keep a Changelog](https://keepachangelog.com/), and releases will follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0-beta.1] - 2026-11-07

The first build for the limited beta. Pin this tag; do not use `latest` during the beta.

### Changed
- The Pro add-on notes inside the app link to the beta page instead of the pricing page while pricing is not promoted.
- "Deposit" is now "retainer" everywhere a client or the studio sees it: booking pages, the scheduler form, payment schedules, quotes and invoices, emails, Home, the docs and the example contract. Existing bookings, invoices and signed contracts are not changed.
- The example contract has a retainer clause, proofs, delivery after the final payment, copyright and usage, and chargeback wording. Have a lawyer review it before you rely on it.

### Fixed
- A client can no longer get the same email twice after a restart or crash. Each email is claimed before it is sent and sent at most once; if an attempt is cut off mid-send, it is marked "Check Sent folder" instead of being sent again, and every email carries one fixed Message-ID. Connection failures that happen before anything is sent still retry.
- AI approvals are checked again when you approve: if the connection was revoked, expired, cut back to read-only or lost the area or feature since the request was made, the action no longer runs. Revoking a connection now cancels everything it had waiting.
- The AI rate limiter forgets connections that have gone quiet instead of growing without bound.

### Changed
- The `docker run` example in the README and install guide is hardened: a pinned version tag, dropped capabilities, read-only root, resource limits, real host folders, and no secrets on the command line (`--env-file` if you need one).

### Added
- Docs: how to restore a backup onto a new install, and why `secret.key` is not in a backup.
- Gallery expiry and archive: galleries now expire 12 months after their first publish (change or turn off in Settings > Galleries; existing published galleries are untouched). Clients attached to the shoot get reminder emails 90, 30 and 7 days before. When a gallery expires it is packed into one zip in an Archive folder next to your shoots and taken offline; nothing is deleted. Download or restore the zip from the gallery's Settings tab, and see the status on the shoot record.
- Check Out: on a gallery's Storage tab, bring its offsite Originals (RAW) and/or Gallery (JPG) files back to this server to edit. You see progress, get a task and an email when everything is back, and the shoot returns offsite when you check it in or after 14 idle days. A cost warning appears first because storage providers can bill for retrieval.
- Each shoot's Originals/RAW folder is now tracked, so an extension that adds remote storage can move those files and bring them back (they are never shown to clients). Each gallery can also choose, per folder, to follow the studio default, stay on this server, or go to remote storage.
- Extension settings cards can show a connection block (a clear tick or warning with title, detail and buttons) and keep their form closed behind an Edit button, pre-filled with the saved values. Secret fields show "Saved" and never receive the stored secret.
- Protected proofing for client galleries. Previews are re-drawn on the server at a smaller size (Light 1800 px, Balanced 1400 px, Strong 1000 px, or your own size) with your watermark scattered irregularly and textured, differently on every photo, so a saved preview is less useful to copy. Set the studio default in Settings > Galleries and override it per gallery. "Protect previews" is its own choice, separate from the download lock: while downloads are locked (the default and the previous behavior), always, or never. Protected previews are never cached by browsers or shared caches, and a link issued before a lock or a setting change can no longer show a clean copy. Originals and downloads are untouched. It deters casual copying; it cannot stop screenshots or all AI recreation.
- A day-of timeline on every shoot: add what happens at each time, with length, place and notes, then print it as a one-page run sheet with the shoot details and contacts.
- Per-client download limits. In a gallery's Settings you can cap how many downloads and how many files each client may take, counted by the email they gave. Clients see what they have left before they download, and you are never counted when you preview.
- Data import reads richer JSON files: nested records (name.first, address.city), lists of values, a list under a key such as "clients", a single record, and JSON Lines. Columns are matched automatically like a CSV.
- A quiet, dismissible note where optional add-on features would appear (QuickBooks Online, Microsoft 365, bucket storage, second shooters). It shows to the owner only and goes away once the add-on is installed.
- Backups can be copied to one or more other places after they are made: a folder or network share built in, and extensions can add more (cloud buckets). Each destination is tested when added, shows its last result, and keeps its own retention.
- Settings > Backups: choose how often to back up and how many to keep, optionally include gallery photos and originals, download any backup as a zip, start one on demand, and delete old ones.
- Built-in automation rules now work in the default mode: the dashboard lists leads awaiting a first reply or follow-up and upcoming shoots with no location.
- Clients and leads, shoots and a studio calendar with two-way Google Calendar sync.
- Booking pages with special dates, daily limits, deposits and coupons, and automatic shoots from confirmed bookings.
- Questionnaires, contracts with e-signatures and a signed PDF audit trail, and a signing step before booking payment.
- Quotes, invoices, manual payments, PayPal checkout, coupon codes and client credit.
- Galleries with favorites, downloads and an optional payment lock.
- Camera upload over SFTP, FTP or FTPS, and SFTP tethering with a live view.
- Shoot tasks with starter checklists, households, and financial reports.
- Import from CSV or JSON, and CSV export of clients, shoots and invoices.
- Static website builder.
- Built-in MCP server with approvals for anything that reaches a client or moves money.
- Extension loader with settings cards, sidebar pages and mail-sender hooks.
- Content-Security-Policy and security headers, and email proof for gallery visitors.
- Accessibility pass: contrast, link names, a skip link and reduced-motion support.
- Docker image for amd64 and arm64, a Compose file and an Unraid template.

[Unreleased]: https://github.com/e2346437/openportrait/commits/main
