# Attack surface inventory

Everything a hostile party could reach, with who can reach it and what stands in the way. Counts and routes come from the
running app (route table dumped by the test harness), not from documentation.

## Network listeners

| Port (container) | Protocol | Default state | Reachable by | Authentication | Notes |
|---|---|---|---|---|---|
| 8080 | HTTP | Always on | Whoever can route to the host port, plus the internet through the tunnel | Per route (below) | Plain HTTP; TLS terminates at Cloudflare. Published on all interfaces by the example compose file and the Unraid template |
| 2222 | SFTP | **Off** until the owner opens it (on demand / schedule / always) | LAN, or internet if forwarded | Per-camera password or public key | Upload-only; ssh2 server; host key persisted |
| 2121 | FTP / FTPS | Off, and only if the owner chooses that protocol | LAN | Per-camera password | Plain FTP is cleartext; FTPS uses a self-signed certificate |
| 30000-30009 | FTP passive data | Off with the above | LAN | (control channel) | |
| none | cloudflared | Outbound only | Cloudflare | Tunnel token | Metrics port bound to loopback |

No database, Redis or message-queue port exists: SQLite is a file. The Docker socket is not mounted and `Privileged` is
false in the Unraid template.

## HTTP surface (209 registered routes)

| Group | Routes | Auth | Who is meant to call it | Abuse controls |
|---|---|---|---|---|
| `/api/studio/*` staff API | 167 | Session cookie; 162/162 protected routes returned 401 anonymously (test AUTHZ-1); 5 are public by design | The owner's browser | Login 10/min per IP key (SEC-001) |
| `/api/studio/setup` | 2 | **None until the first owner exists** | First visitor | 10/min per address (SEC-002) |
| `/api/studio/auth/{login,logout,me}` | 3 | Public by design | Browser | 10/min on login |
| `/api/g/:slug…` client galleries | 10 | The private link (+ optional password) | Clients | Unlock 10/min, identify 20/min; **others unlimited** (SEC-005) |
| `/media/:id/:version/:variant?s=` | 1 | HMAC-signed URL, no expiry | Clients' browsers, CDN | Signature only (SEC-004) |
| `/api/public/inquiry`, `/book/*`, `/book-cancel/:token` | 7 | Public by design | Prospective clients | 6-60/min per address, honeypot field |
| `/api/public/order/:token…` | 5 | 24-byte random token in the URL | Clients paying/accepting | 10-60/min |
| `/api/public/paypal/webhook` | 1 | PayPal signature, verified by calling PayPal | PayPal | 120/min |
| `/mcp` | 3 (POST only) | Bearer token | AI assistants | 120/min per connection, 25 approval requests/day |
| `/oauth/{register,authorize,token}`, `/.well-known/*` | 6 | Public endpoints of an OAuth server; consent needs the owner session | AI apps | register 20/min, token 60/min (shared bucket) |
| `/api/branding/logo`, `/api/health` | 2 | Public | Anyone | none (static) |
| Static web app and assets | served by `@fastify/static` | Public | Browsers | none |

Content types the server parses: JSON (1 MB cap), form-encoded (OAuth token endpoint only, 16 KB), `image/png|jpeg|webp`
(logo, 5 MB), `application/offset+octet-stream` (photo upload chunks, 64 MB each, staff only).

## Inputs that become files or commands

| Input | Becomes | Control |
|---|---|---|
| Photo upload (staff, resumable) | A file in a shoot folder | Extension allow-list; filename reduced to basename (tested GAL-4/5); 2 GB cap; **no quota** |
| Camera upload (SFTP/FTP) | A file in `/incoming/<camera>/…` | Path jail with symlink check (tested SFTP-2); no read, no delete; **can overwrite** (SEC-007); **no quota** |
| Files already on the share | Gallery photos | Extension allow-list; decoded by `sharp` with default pixel limit |
| Logo upload | `/config/logo.png` | Re-encoded through `sharp` to PNG |
| Tunnel token | Environment variable of the `cloudflared` child | Not on the command line, no shell |
| Extension modules | Imported code | Owner-controlled folder |
| SMTP host / public URL / LAN URL settings | Outbound connections, links in email | Owner only; **not restricted to public addresses** (owner-level SSRF, informational) |

There is no archive extraction, no PDF rendering and no shell-out in the application code (only `cloudflared`).

## Data an unauthenticated visitor can obtain by design

Studio name, contact email and logo (client pages); public booking page text and free slots; invitation-only content by
link: galleries, quotes and invoices (token). Health returns app version and a non-secret instance id.

## Data reachable with each credential

| Credential | Reaches |
|---|---|
| Staff session | Everything in the studio |
| AI token / OAuth grant | Only the tools its level and areas allow; outward and money actions wait for the owner |
| Gallery link | That gallery's photos, downloads and its visitors' own favorites |
| Order link | That quote or invoice, payment start/finish |
| Booking cancel link | That booking |
| Camera login | Write-only access to its own incoming folder |
| `/config` volume | All of the above, plus the key that decrypts stored credentials |
| Extension folder write access | Code execution in the container |
