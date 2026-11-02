# Security release checklist

Complete this for every tagged release. The first section is automated by `security/scripts/gate.mjs --enforce`; the rest needs a person.

## Release-blocking criteria (automated)

A release is blocked when any of these is true:

1. A confirmed finding with severity Critical or High is open in `security/findings.json`.
2. Any control in the in-process suite or the live suite fails, or an open finding now passes and has not been flipped to a control.
3. Any isolation check fails.
4. A secret is found in the tree or history (gitleaks) or in the image (Trivy).
5. The image or dependency scan reports a High or Critical vulnerability that has a fixed version, unless covered by an unexpired entry in `security/config/allowlist.json`.
6. A High or Critical misconfiguration is reported for the Dockerfile or image and is not excepted.
7. Semgrep reports an ERROR-level finding in `apps/`.
8. ZAP reports a High alert.
9. The gate could not evaluate (missing registry or reports): treated as blocked in enforce mode.

Medium findings do not block, but each must have an owner and a target release in `REMEDIATION_PLAN.md`.

## Before tagging

- [ ] `pnpm test` and typecheck pass on the release commit.
- [ ] `security/scripts/run-local.sh`, `scan.sh` and `zap.sh` ran against the release image, not an older build.
- [ ] `node security/scripts/gate.mjs --enforce` exits 0.
- [ ] Every entry in `security/config/allowlist.json` is still justified and none expires within 30 days without a plan.
- [ ] `security/findings.json` and `AUDIT_REPORT.md` match reality: fixed items are marked fixed, new ones are registered.
- [ ] New routes, MCP tools, ports, volumes or environment variables are reflected in `ATTACK_SURFACE.md` and `ARCHITECTURE.md`.
- [ ] Base image, Node, cloudflared and gosu versions reviewed; the image was rebuilt without cache.

## Deployment guidance in the release notes

- [ ] The recommended container profile in `DOCKER_HARDENING.md` is current and the sample Unraid template matches it.
- [ ] Any change to authentication, sessions, OAuth, uploads or the public API is called out.
- [ ] Upgrade steps that touch secrets or the encryption key are explicit.
- [ ] The documentation still tells operators to publish only through the tunnel and not to expose the app port directly.

## Maintainer sign-off

- [ ] Changes to authentication, authorization, deployment layout or the public API had explicit owner approval.
- [ ] Security-relevant dependencies were bumped or consciously deferred.
- [ ] Release tagged by: __________  Date: __________  Gate output attached: __________

## After release

- [ ] The weekly scheduled scan is green on the released image digest.
- [ ] Reported vulnerabilities are triaged within 7 days; confirmed High or Critical ones are fixed or mitigated before the next release.
