# Changelog

All notable changes to OpenPortrait. The format follows [Keep a Changelog](https://keepachangelog.com/), and releases will follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Heading toward 1.0.

### Added
- Per-client download limits. In a gallery's Settings you can cap how many downloads and how many files each client may take, counted by the email they gave. Clients see what they have left before they download, and you are never counted when you preview.
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
