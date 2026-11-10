#!/usr/bin/env bash
# Static and supply-chain scans. Everything runs in throwaway containers or as local CLIs; the Docker socket is never
# mounted (the image is exported with `docker save` and scanned as a tarball). Reports go to security/reports/.
#   IMAGE=openportrait:security security/scripts/scan.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${OUT:-security/reports}"; mkdir -p "$OUT"
IMAGE="${IMAGE:-}"
TRIVY="${TRIVY_IMAGE:-aquasec/trivy:0.58.1@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7}"
GITLEAKS="${GITLEAKS_IMAGE:-ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f}"
HADOLINT="${HADOLINT_IMAGE:-hadolint/hadolint:v2.14.0-debian@sha256:158cd0184dcaa18bd8ec20b61f4c1cabdf8b32a592d062f57bdcb8e4c1d312e2}"
SEMGREP="${SEMGREP_IMAGE:-semgrep/semgrep@sha256:2e45517a85e13a9cca14a2a00df6bb48affd66b8ebfae1b0991cd57578362fb0}"
# If a TLS-inspecting proxy sits in front of the network, point this at its CA bundle so the scanners can fetch their databases.
CA_ARGS=(); [ -n "${SECURITY_CA_BUNDLE:-}" ] && CA_ARGS=(-e SSL_CERT_FILE=/ca.crt -v "$SECURITY_CA_BUNDLE:/ca.crt:ro")
CACHE="${TRIVY_CACHE:-$HOME/.cache/trivy-op}"; mkdir -p "$CACHE"
rc=0

echo "== secrets (gitleaks, full history)"
leak_status=0
docker run --rm -v "$PWD:/repo:ro" "$GITLEAKS" detect --source /repo --no-banner --redact=100 --exit-code 42 -f json -r /dev/stdout >"$OUT/gitleaks.json" 2>"$OUT/gitleaks.log" || leak_status=$?
case "$leak_status" in
  0) [ -s "$OUT/gitleaks.json" ] || printf '[]\n' >"$OUT/gitleaks.json" ;;
  42) echo "   LEAKS FOUND, see $OUT/gitleaks.json" ;;
  *) rm -f "$OUT/gitleaks.json"; rc=1 ;;
esac

echo "== dependencies, IaC and secrets in the tree (trivy fs)"
docker run --rm -v "$CACHE:/root/.cache" -v "$PWD:/repo:ro" "${CA_ARGS[@]}" "$TRIVY" fs --skip-dirs node_modules --skip-dirs .git --scanners vuln,secret,misconfig --format json -o /dev/stdout /repo >"$OUT/trivy-fs.json" 2>"$OUT/trivy-fs.log" || rc=1

echo "== Dockerfile lint (hadolint)"
docker run --rm -i "$HADOLINT" hadolint -f json - <Dockerfile >"$OUT/hadolint.json" 2>/dev/null || true

echo "== static analysis (semgrep: project rules always; community rules when reachable)"
CONFIGS=(--config security/config/semgrep/openportrait.yaml)
RULES_MOUNT=()
if [ -n "${SEMGREP_RULES_DIR:-}" ]; then
  RULES_MOUNT=(-v "$(realpath "$SEMGREP_RULES_DIR"):/rules:ro")
  for d in typescript javascript dockerfile generic/secrets; do CONFIGS+=(--config "/rules/$d"); done
else
  CONFIGS+=(--config p/typescript --config p/nodejs --config p/dockerfile --config p/secrets)
fi
docker run --rm --entrypoint semgrep --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/repo:ro" -w /repo "${RULES_MOUNT[@]}" "${CA_ARGS[@]}" "$SEMGREP" scan "${CONFIGS[@]}" \
  --exclude node_modules --exclude security/reports --metrics=off --disable-version-check \
  --json apps packages Dockerfile docker >"$OUT/semgrep.json" 2>"$OUT/semgrep.log" || rc=1

if [ -n "$IMAGE" ]; then
  echo "== image ($IMAGE): export to a tarball and scan it, no socket"
  TAR="$(mktemp -d)/image.tar"; docker save "$IMAGE" -o "$TAR" || rc=1
  docker run --rm -v "$CACHE:/root/.cache" -v "$(dirname "$TAR"):/in" "${CA_ARGS[@]}" "$TRIVY" image --input /in/image.tar --scanners vuln,secret --format json -o /in/trivy-image.json >/dev/null 2>"$OUT/trivy-image.log" || rc=1
  cp "$(dirname "$TAR")/trivy-image.json" "$OUT/trivy-image.json" 2>/dev/null || rc=1
  rm -rf "$(dirname "$TAR")"
fi
echo "scan reports in $OUT (exit $rc means a tool failed to run, not that it found something; use gate.mjs to judge)"
exit "$rc"

