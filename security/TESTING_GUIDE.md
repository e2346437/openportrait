# Security testing guide

How to run, read and extend the OpenPortrait security tests. Everything here runs against a build you make yourself, with synthetic data. Never point any of it at a real install.

## Safety rules

- Test only containers you started for the purpose. The live suite refuses any URL that is not loopback or a private address.
- Use synthetic data only. No real clients, galleries, payment credentials or email accounts.
- Do not mount the Docker socket into any container and do not run containers with `--privileged`. The scripts do neither.
- No denial-of-service or load testing. The upload and image checks use small, bounded inputs.
- Never put secrets in the repository, issues or chat. The scripts create throwaway credentials that live and die with the container.

## What exists

| Layer | What it checks | Command | Needs Docker |
|---|---|---|---|
| In-process regression suite | Authorization on every route, MCP levels and approvals, tenant isolation, one test per finding | `pnpm --filter ./apps/server test -- test/security` | No |
| Strict mode | The same suite, but open findings count as failures | `SECURITY_STRICT=1 pnpm --filter ./apps/server test -- test/security` | No |
| Live black-box suite | 24 checks over HTTP and SFTP against a hardened container | `security/scripts/run-local.sh` | Yes |
| Isolation checks | Two photographers' containers cannot reach each other; what a container can reach | run by `run-local.sh` (`security/scripts/isolation.sh`) | Yes |
| Static and supply chain | Secrets, dependencies, Dockerfile, Semgrep rules | `IMAGE=openportrait:security security/scripts/scan.sh` | Yes |
| Dynamic scan | Authenticated OWASP ZAP baseline | `IMAGE=openportrait:security security/scripts/zap.sh` | Yes |
| Release gate | Reads all reports and `findings.json`, says pass or blocked | `node security/scripts/gate.mjs [--enforce]` | No |
| Summary | One readable page from the reports | `node security/scripts/report.mjs` | No |

## Running it locally

```bash
pnpm install
pnpm --filter "./packages/*" build

# 1. Fast checks, no Docker
pnpm --filter ./apps/server test -- test/security

# 2. Build the image, run the live suite and isolation checks
security/scripts/run-local.sh            # builds openportrait:security
IMAGE=openportrait:security security/scripts/scan.sh
IMAGE=openportrait:security security/scripts/zap.sh

# 3. Decide
node security/scripts/report.mjs         # writes security/reports/SUMMARY.md
node security/scripts/gate.mjs           # prints the verdict
```

Reports go to `security/reports/`, which is gitignored.

Behind a TLS-inspecting proxy, set `SECURITY_CA_BUNDLE` to the proxy's CA file so the scanners can download their databases. `SEMGREP_RULES_DIR` and `TRIVY_CACHE` let you point at pre-downloaded rules and a vulnerability database. Options for `run-local.sh`: `IMAGE=` to test an existing image, `HARDEN=0` to run with Docker defaults and compare, `SECURITY_STRICT=1` to treat open findings as failures.

## How to read the results

The suite has two kinds of test:

- **Control** tests prove something that is supposed to hold, such as "anonymous requests to staff routes get 401". A control that fails is a regression. Fix it before merging.
- **Open finding** tests describe a confirmed weakness. They are written as the assertion that will be true once the fix lands, and are marked expected-to-fail so CI stays green while the finding is open. When you fix the issue, the test starts passing, vitest reports it as an unexpected pass, and you flip it to a control (`openFinding` becomes `control`) and set the finding's status to `fixed` in `security/findings.json`. Run with `SECURITY_STRICT=1` to see open findings as real failures.

In the live suite the statuses are `PASS`, `FAIL` (a control broke), `OPEN` (known finding still present), `FIXED-flip-to-control` (an open finding now passes) and `INFO`.

## Adding a test

1. **A new route or tool.** Nothing to do for routes: the authorization test enumerates every registered route and fails if a staff route answers an anonymous request with anything but 401. New MCP tools are enumerated the same way and must declare an area, a tier and a capability.
2. **A new finding.** Add an entry to `security/findings.json` (id, severity, CVSS v4 vector, status, `confirmed`, affected deployments). Add an `openFinding` test in `apps/server/test/security/findings.test.ts` and, if it can be shown over the wire, a check in `security/tests/live/suite.mjs`. Describe the weakness in neutral terms.
3. **A fix.** Make the change, flip the test to `control`, mark the finding `fixed`, and add the regression test to the PR.
4. **A repeatable code pattern.** Add a rule to `security/config/semgrep/openportrait.yaml`.
5. **A scanner exception.** Add it to `security/config/allowlist.json` with a justification and an expiry date. Exceptions expire on purpose; the gate warns when one lapses and blocks again when the underlying issue is a fixable High or Critical.

Test files live in `apps/server/test/security/`:

- `harness.ts`: boots the app in a temporary directory with a synthetic owner, records every route, provides `openFinding` and `control`.
- `authz.test.ts`: route enumeration, anonymous access, cookie flags, client versus staff separation.
- `mcp.test.ts`: tool levels, approvals, area limits, prompt-injection wrapping, OAuth.
- `isolation.test.ts`: one studio's data and files cannot be reached from another.
- `findings.test.ts`: one test per registered finding.

## Continuous integration

`.github/workflows/security.yml` has three jobs:

- **regression**: the in-process suite on every pull request.
- **static**: gitleaks, Trivy filesystem scan, hadolint, Semgrep on every pull request.
- **image-and-live**: builds the image, runs the live suite, isolation checks, the Trivy image scan and ZAP.

The gate runs in report mode on pull requests and in `--enforce` mode on release tags and manual runs. A weekly schedule re-runs the scanners so new advisories surface without a code change.

## What this does not cover

Be honest about gaps when reading a clean result. These were not exercised: the PayPal checkout end to end, Google and SMTP integrations, FTP and FTPS camera upload, TLS termination, denial of service and very large images, a real Unraid host, and any code that is not in this repository. Clean scanner output is a baseline, not a statement that the app is secure.
