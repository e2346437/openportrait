# Threat model

Method: STRIDE over the trust boundaries in `ARCHITECTURE.md`, ranked by how exposed the door is and what is behind it.
Findings (`SEC-nnn`) are in `AUDIT_REPORT.md`; "held" means the control was tested and passed.

## What is worth protecting

1. Clients' personal data and unreleased photos (names, emails, phone numbers, event dates, notes, invoices, contracts).
2. The studio's money paths: quotes, invoices, payment records, PayPal credentials.
3. Availability of the studio during a shoot season (galleries, booking page, camera ingest).
4. The owner's other accounts reachable from here: email (SMTP), Google calendar, the Cloudflare tunnel.
5. The Docker host and, where one operator hosts many studios, every other customer's data.

## Who might attack

| Actor | Capability | Motivation | Where they start |
|---|---|---|---|
| Internet scanner / opportunist | Automated requests, credential stuffing, known CVEs | Foothold, spam relay, ransomware | Public hostname or an exposed port |
| Someone holding a gallery link | A legitimate link, maybe forwarded | See or take photos not meant for them | Client gallery |
| Prospective "client" | Public forms | Spam, injection aimed at the studio's AI | Inquiry and booking forms |
| Malicious or compromised site on the same parent domain | Same-site requests with the owner's cookie | Act as the owner | A browser the owner is signed into |
| Compromised AI assistant or prompt-injected AI | Valid AI token, level/areas as granted | Exfiltrate, spend, message clients | `/mcp` |
| Stolen camera / leaked camera password | Camera login | Destroy or fill the ingest folder | SFTP/FTP |
| Malicious file | A crafted photo | Crash or exploit the image decoder | Upload, share, camera |
| Another tenant (managed hosting) | Code execution inside their own container | Reach other customers or the host | Their own container |
| Insider / supply chain | A bad dependency, image or extension | Backdoor | Build and update path |

## Scenarios

| # | Scenario | Entry | Impact | Mitigation today | Gap |
|---|---|---|---|---|---|
| T1 | Guess the owner's password | Login | Full compromise | Argon2id, 10 chars minimum, 10/min limit, equal responses | Limit is bypassable with a forged header and has no per-account lockout; no MFA (**SEC-001**, **SEC-016**) |
| T2 | Take over a fresh install | Setup page | Full compromise | Transactional single owner | Anyone can be that owner (**SEC-002**) |
| T3 | Make the owner's browser act | Cross-site / same-site request | Any staff action, including approving AI requests | SameSite=Lax, JSON bodies | No Origin / Fetch-Metadata check (**SEC-003**) |
| T4 | Find a private gallery | Guess slug, forward link | See photos | Random slug tail, optional password, 404 for unknown | ~31-bit slug, no throttle (**SEC-005**); URLs outlive unpublishing (**SEC-004**) |
| T5 | Pretend to be another client | Identify with their email | See / edit their favorites and notes | Link needed first | Email unverified (**SEC-012**) |
| T6 | Prompt-inject the studio's AI through a form | Inquiry message, name, notes | AI creates records, queues messages | Wrapper tag + instruction line; **server-side approvals, levels, areas, daily cap (held, MCP-8..11)** | Wrapper can be closed by the text; names unwrapped (**SEC-006**) |
| T7 | Use a stolen AI token | Bearer token | Only what its level allows; outward/money still need approval | Revocation, expiry, pause switch, short OAuth tokens, refresh-reuse detection (held) | None beyond Origin check (**SEC-011**) |
| T8 | Malicious image | Upload, share, camera | Decoder crash or exploit | `sharp`/libvips with default limits; failures isolated per job (held) | Memory use under a very large image not measured; keep libvips patched (**SEC-014**) |
| T9 | Path traversal via names | Upload, SFTP, rename | Write outside the folder | `resolveInside`, `jailPath`, basename (held GAL-4, SFTP-2) | none found |
| T10 | Camera credential misuse | SFTP/FTP | Overwrite or fill incoming | No read/delete; timed blocks | Overwrite allowed, no quota (**SEC-007**) |
| T11 | Break out of the container | RCE in the app → kernel | Host and neighbours | App runs as non-root with zero capabilities (held NET-4) | Root entrypoint, default capabilities, no `no-new-privileges`, writable root fs, no limits (**SEC-008**) |
| T12 | Reach a neighbour's deployment | Own container → network | Other tenant's app | Separate networks, volumes, keys, secrets (held ISO-*, NET-1/2) | Default bridge, published ports and cloud metadata need operator rules (`DOCKER_HARDENING.md`) |
| T13 | Poisoned dependency or base image | Build | Backdoor | Lockfile, `--frozen-lockfile`, pinned tool versions | Unpinned base digest; scanner findings (**SEC-014**) |
| T14 | Steal secrets from a backup | Copied `/config` | All stored credentials | Encrypted values | Key stored beside the data (**SEC-015**) |
| T15 | Forge a payment | Webhook, checkout | Mark invoices paid | Signature verified through PayPal; amount fixed server-side; idempotent attempts | Not exercised dynamically: needs PayPal sandbox credentials (see Not tested) |
| T16 | Learn the studio's home network | Shipped text | Minor recon | Private address only | Example uses a real home address (**SEC-017**) |

## Out of scope for this build

Multi-user roles (none exist), an in-app email inbox, print ordering, and anything in a separate closed-source add-on.
When roles arrive, T3, T5 and the authorization suite need to be repeated with two users.
