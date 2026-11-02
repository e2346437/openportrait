# Remediation plan

Ordered by risk (exploitability × impact × exposure). Items 1 to 4 and 7 (SEC-001, 002, 003, 008, 005) were approved by the owner and are **implemented and verified**; the rest
need approval first, as the "Needs approval" column says. Each
fix comes with its regression test already in the repository, so the work is: make the change, flip the test from
`openFinding` to `control` (vitest reports the `it.fails` as a failure the moment the fix works, which is the prompt to do so),
and update `findings.json`.

> Update: SEC-004, 006, 007, 010, 011, 015 (tag length) and 017 are also fixed and tested. SEC-009 (CSP) and SEC-012
> (visitor email proof, when email is set up) are fixed on follow-up branches. Still open: SEC-016 (MFA).

## Before a public launch (blocks release)

| Order | Finding | Change | Size | Needs approval | Breaks anything? |
|---|---|---|---|---|---|
| 1 ✅ | SEC-001 | One `clientIp()` that trusts `CF-Connecting-IP` only from loopback (+ optional `TRUSTED_PROXIES`); use it as the key for every rate limit; per-account failure delay | ~60 lines | **Yes** (auth) | Anyone running cloudflared in a *separate* container must set `TRUSTED_PROXIES`; documented in the install guide |
| 2 ✅ | SEC-002 | Setup code printed to the container log at first start (or `SETUP_CODE` env for automated installs); required by `POST /setup` and shown in the wizard | ~50 lines + UI field | **Yes** (first-run flow) | Wizard gains one field |
| 3 ✅ | SEC-003 | Fetch-Metadata / Origin check on non-GET studio requests | ~30 lines | **Yes** (public API behaviour) | Scripts that call the API with a cookie from another origin stop working; same-origin browser use is unaffected |
| 4 ✅ | SEC-008 | Hardened defaults in `docker-compose.yml` and the Unraid template (`ExtraParams`); delete `npm`/`corepack` and set-uid bits from the runtime image; pin base by digest | Config + 5 Dockerfile lines | **Yes** (deployment) | Verified to start and pass the live suite. Read-only root needs `/tmp` as tmpfs |
| 5 | SEC-014 | Remove npm/corepack from runtime; bump cloudflared and gosu when fixed builds exist; weekly rebuild; Dependabot | Small | No | No |
| 6 | SEC-004 ✅ | Time-limited media signatures + gallery-state check; shorter cache | ~40 lines | **Yes** (URL format) | Pages cache URLs for an hour, not a year; first view after expiry re-fetches the gallery JSON |
| 7 ✅ | SEC-005 | 128-bit slugs for new galleries, keep old; throttle unknown-slug 404s; warn on short custom slugs | ~30 lines | **Yes** (URL format) | Existing links keep working |

## Before the first outside users

| Order | Finding | Change | Needs approval |
|---|---|---|---|
| 8 | SEC-006 ✅ | Escape the wrapper, wrap every outside-sourced field, label approval source | No |
| 9 | SEC-007 ✅ | Never overwrite in camera folders; byte cap per camera; free-space floor | No |
| 10 | SEC-009 | CSP in report-only, then enforce; HSTS when HTTPS | **Yes** (UI risk) |
| 11 ✅ | SEC-012 | Email confirmation for favorites; apply the password gate to identify/list routes | **Yes** (gallery flow) |
| 12 | SEC-016 | TOTP/passkey for the owner; idle timeout | **Yes** (auth feature) |

## Hygiene (no approval needed)

SEC-010 (use configured address), SEC-011 (Origin check on `/mcp`, consent-page wording), SEC-015 (pin GCM tag length; option
to keep the key outside `/config`), SEC-017 (neutral example address), pin Actions by SHA, CODEOWNERS for `security/` and
`Dockerfile`, a `SECURITY.md` with a reporting address.

## For anyone hosting other people's studios (design requirements, not bugs)

1. One VM per customer where the budget allows; if containers share a host, add a user-namespaced or sandboxed runtime.
2. The hardened profile as the only profile; per-tenant bridge networks; host firewall dropping container → host and
   container → `169.254.169.254`; ports published to loopback only, with the reverse proxy on the same host.
3. Per-tenant secrets generated at provisioning and never reused; the control plane's credentials never mounted or passed
   to a customer container (isolation test NET-3 and an env-var check belong in the provisioning pipeline).
4. Backups and logs written per tenant with separate keys; restore tested; a legal notice that data is not recoverable
   without a backup.
5. Re-run `security/scripts/run-local.sh` against *two real provisioned stacks* in staging before first customer.

## Residual risk after the plan

Application-level RCE in a dependency (mitigated by non-root, zero capabilities, read-only root, limits); a malicious
extension module (trust decision); kernel/runtime escape on shared hosts (only VM separation removes it); a compromised
owner machine (MFA reduces, doesn't remove); the model-behaviour half of prompt injection, which no server can fix: the
design assumes the assistant *will* sometimes obey a stranger and makes sure that costs at most a queued request.
