#!/usr/bin/env bash
# Static and supply-chain scans. Everything runs in throwaway containers or as local CLIs; the Docker socket is never
# mounted (the image is exported with `docker save` and scanned as a tarball). Reports go to security/reports/.
#   IMAGE=openportrait:security security/scripts/scan.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${OUT:-security/reports}"; mkdir -p "$OUT"
IMAGE="${IMAGE:-}"
TRIVY="${TRIVY_IMAGE:-aquasec/trivy:0.58.1}"
GITLEAKS="${GITLEAKS_IMAGE:-zricethezav/gitleaks:latest}"
HADOLINT="${HADOLINT_IMAGE:-hadolint/hadolint:latest}"
# If a TLS-inspecting proxy sits in front of the network, point this at its CA bundle so the scanners can fetch their databases.
CA_ARGS=(); [ -n "${SECURITY_CA_BUNDLE:-}" ] && CA_ARGS=(-e SSL_CERT_FILE=/ca.crt -v "$SECURITY_CA_BUNDLE:/ca.crt:ro")
CACHE="${TRIVY_CACHE:-$HOME/.cache/trivy-op}"; mkdir -p "$CACHE"
rc=0

echo "== secrets (gitleaks, full history)"
docker run --rm -v "$PWD:/repo:ro" "$GITLEAKS" detect --source /repo --no-banner -f json -r /dev/stdout >"$OUT/gitleaks.json" 2>"$OUT/gitleaks.log" || rc=1
[ "$(wc -c <"$OUT/gitleaks.json")" -le 3 ] && echo "   no leaks found" || echo "   LEAKS FOUND, see $OUT/gitleaks.json"

echo "== dependencies, IaC and secrets in the tree (trivy fs)"
docker run --rm -v "$CACHE:/root/.cache" -v "$PWD:/repo:ro" "${CA_ARGS[@]}" "$TRIVY" fs --skip-dirs node_modules --skip-dirs .git --scanners vuln,secret,misconfig --format json -o /dev/stdout /repo >"$OUT/trivy-fs.json" 2>"$OUT/trivy-fs.log" || rc=1

echo "== Dockerfile lint (hadolint)"
docker run --rm -i "$HADOLINT" hadolint -f json - <Dockerfile >"$OUT/hadolint.json" 2>/dev/null || true

echo "== static analysis (semgrep: project rules always; community rules when reachable)"
CONFIGS=(--config security/config/semgrep/openportrait.yaml)
if [ -n "${SEMGREP_RULES_DIR:-}" ]; then for d in typescript javascript dockerfile generic/secrets; do CONFIGS+=(--config "$SEMGREP_RULES_DIR/$d"); done
else CONFIGS+=(--config p/typescript --config p/nodejs --config p/dockerfile --config p/secrets); fi
if command -v semgrep >/dev/null; then semgrep "${CONFIGS[@]}" --exclude node_modules --exclude security/reports --metrics=off --disable-version-check --json -o "$OUT/semgrep.json" apps packages Dockerfile docker >"$OUT/semgrep.log" 2>&1 || rc=1
else echo "   semgrep not installed (pip install semgrep); skipped"; fi

if [ -n "$IMAGE" ]; then
  echo "== image ($IMAGE): export to a tarball and scan it, no socket"
  TAR="$(mktemp -d)/image.tar"; docker save "$IMAGE" -o "$TAR"
  docker run --rm -v "$CACHE:/root/.cache" -v "$(dirname "$TAR"):/in" "${CA_ARGS[@]}" "$TRIVY" image --input /in/image.tar --scanners vuln,secret --format json -o /in/trivy-image.json >/dev/null 2>"$OUT/trivy-image.log" || rc=1
  cp "$(dirname "$TAR")/trivy-image.json" "$OUT/trivy-image.json" 2>/dev/null || rc=1
  rm -rf "$(dirname "$TAR")"
fi
echo "scan reports in $OUT (exit $rc means a tool failed to run, not that it found something; use gate.mjs to judge)"
exit 0
