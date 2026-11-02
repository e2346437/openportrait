# Docker and infrastructure hardening

**Status: the hardened profile is now the shipped default** (`docker-compose.yml` and the Unraid template's ExtraParams), the runtime image no longer contains npm, corepack or yarn, set-uid/set-gid bits are stripped, the base image is pinned by digest, and Unraid's default ids (99:100) have an account in the image so a read-only root works. Verified by `run-local.sh` and a manual start at PUID 99 / PGID 100. The tables below describe the image as audited, before those changes.

Facts first (observed on the image built from `1601f66`), then the profile that was verified, then what an operator who hosts
several studios must add. Run `security/scripts/run-local.sh` to repeat every check.

## Current image: what was observed

| Item | Observed | Risk |
|---|---|---|
| Base | `node:22-bookworm-slim` (Debian 12.15), multi-stage, production dependencies only | Not pinned by digest |
| Process model | tini (root) → `entrypoint.sh` (root; chown, user setup) → `gosu` → node as `PUID:PGID` | Root until the app starts |
| App process | uid 1000 (Unraid: 99), `CapEff=0` | Good |
| Capabilities of PID 1 | Docker default 14 (`CapEff=a80425fb`) | Unneeded |
| Docker socket / privileged / host network / extra host mounts | None. Only `/config`, `/galleries`, `/incoming`, `/cache` | Good |
| Exposed ports | 8080, 2222, 2121, 30000-30009; compose publishes all on every interface | Camera ports should be LAN-only |
| Healthcheck | Node one-liner against `/api/health` | Fine |
| Secrets in image/env | None found (Trivy secret scan, gitleaks, `env` inspection) | Good |
| Build-time downloads | `cloudflared`, `tini`, `gosu` fetched by URL with version pins but **no checksum verification** | Supply-chain risk (SEC-014) |
| Unused tooling in runtime | `npm`, `corepack` (10 High findings, never used at run time) | Remove |
| Limits | None (memory, pids, cpu) | A runaway job can starve the host |
| Updates | Image is rebuilt on `main`; `latest` tag is what the compose file pulls | Pin tags and rebuild weekly |

## Verified hardened profile

Tested on 2026-11-02: the container starts, healthchecks pass, **and the whole live suite passes** (gallery ingest and
thumbnails, uploads, SFTP, OAuth, MCP) with:

```bash
docker run -d --name openportrait \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --pids-limit 512 --memory 2g \
  -p 127.0.0.1:8080:8080 \
  -e PUID=1000 -e PGID=1000 \
  -v /srv/op/config:/config -v /srv/op/galleries:/galleries -v /srv/op/incoming:/incoming -v /srv/op/cache:/cache \
  ghcr.io/e2346437/openportrait:<pinned-tag>
```

Compose equivalent:

```yaml
services:
  openportrait:
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, FOWNER]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs: ["/tmp:rw,noexec,nosuid,size=256m"]
    pids_limit: 512
    mem_limit: 2g
```

Findings from the experiment: with **all** capabilities dropped the entrypoint fails (`chown: Operation not permitted`), so
those four are the minimum for the current entrypoint. A future "rootless" mode (run as `PUID:PGID` from the start, require
correctly owned volumes) would remove the need for all four. `noexec` on `/tmp` does not break `sharp`.

### Unraid

The template already sets `Privileged=false`. Add under **Extra Parameters**:
`--cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --memory 2g --pids-limit 512`.
Keep 8080 (host 8090) bound to the LAN only; never forward it on the router. The tunnel needs no inbound port. Camera ports
(2222, 2121, 30000-30009) should be opened only while shooting, which is what the "on demand" mode is for.
**Not yet verified on a real Unraid host** (done in a cloud sandbox); try on a non-production container first.

## Network

- Use a dedicated user-defined network per deployment. Docker's *default* bridge has no isolation between containers
  (observed: a neighbour on the default bridge was reachable on port 8080).
- Bind published ports to `127.0.0.1` (or a specific LAN address) unless a service must be reachable from the network.
  A port published on `0.0.0.0` is reachable from other containers through the host's gateway address (observed).
- No database or cache port exists, so nothing else needs publishing.
- Egress: the app needs Cloudflare (tunnel), PayPal, Google, and the owner's SMTP host. A host firewall that drops container
  → RFC1918 and → `169.254.169.254` closes the SSRF-to-internal-network path for settings-driven fetches.

## Volumes and files

- `/config` holds the database, the instance key and backups: mode 0700, owned by the app user, excluded from any share.
- `/galleries` and `/incoming` are the photographers' own data; the app can read and write them. Keep them on a share the
  app user owns; avoid mounting a parent directory.
- Do not mount the Docker socket anywhere near the app or the test tools.
- `/cache` is disposable; mount it on cheap storage and cap it.

## Image build

1. Pin base by digest (`node:22-bookworm-slim@sha256:…`) and update it on a schedule.
2. Verify downloaded binaries against published checksums (`cloudflared`, `tini`, `gosu`) in the build.
3. In the runtime stage: `rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx` and `find / -perm /6000 -type f -exec chmod a-s {} +`.
4. Add `LABEL`s for SBOM; produce one with `trivy image --format cyclonedx` and attach it to releases.
5. Sign images (cosign keyless via GitHub OIDC) and let users verify.
6. Rebuild weekly even without code changes so Debian fixes arrive; Dependabot for npm, Actions and Docker.

## For an operator hosting several studios

Container separation is not VM separation. Tested here: separate networks, volumes, keys and secrets keep honest tenants
apart. **Not** protected against a tenant who escapes the container: that tenant reaches the host and every neighbour.

Minimum for sharing a host: the hardened profile as the only option; per-tenant network; no `0.0.0.0` publishing; firewall
rules for host ports and the metadata address; per-tenant host directories owned by distinct uids; user namespaces
(`--userns-remap`) or a sandboxed runtime (gVisor/Kata); separate backup keys and buckets per tenant; no control-plane
credential, token or socket in any tenant container. Preferred: one small VM per tenant and treat containers as packaging.

Automation to add when the provisioning code exists: after creating two stacks, run `security/scripts/run-local.sh`-style
checks against them (`isolation.sh` takes any two container names).
