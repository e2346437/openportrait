#!/usr/bin/env bash
# Runs the live security suite against two disposable OpenPortrait containers (two synthetic photographers).
# Safe by construction: synthetic data, throwaway volumes, ports bound to 127.0.0.1, no Docker socket mounted,
# no real credentials. Never point this at a production install.
#
#   security/scripts/run-local.sh                 # build the image from this checkout, then test it
#   IMAGE=openportrait:ci security/scripts/run-local.sh   # test an image you already have
#   HARDEN=0 security/scripts/run-local.sh        # run the containers with Docker defaults instead of the hardened profile
#   SECURITY_STRICT=1 ...                         # treat open findings as failures (use after fixes land)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${OUT:-security/reports}"; mkdir -p "$OUT"
IMAGE="${IMAGE:-}"
HARDEN="${HARDEN:-1}"
RUN="op-sec-$$"
WORK="$(mktemp -d)"
PORT_A="${PORT_A:-18080}"; PORT_B="${PORT_B:-18081}"; SFTP_A="${SFTP_A:-12222}"

if [ -z "$IMAGE" ]; then IMAGE="openportrait:security"; docker build -t "$IMAGE" .; fi

cleanup() { docker rm -f "$RUN-a" "$RUN-b" >/dev/null 2>&1 || true; docker network rm "$RUN-a" "$RUN-b" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

for t in a b; do mkdir -p "$WORK/$t"/{config,galleries,incoming,cache}; chmod -R 777 "$WORK/$t"; docker network create "$RUN-$t" >/dev/null; done

# The hardened profile is documented in security/DOCKER_HARDENING.md and verified to start and pass this suite.
HARD=()
if [ "$HARDEN" = "1" ]; then
  HARD=(--cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER --security-opt no-new-privileges
        --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --pids-limit 512 --memory 2g)
fi
start() { # name port extra-args...
  local t="$1" port="$2"; shift 2
  docker run -d --name "$RUN-$t" --network "$RUN-$t" "${HARD[@]}" "$@" \
    -p "127.0.0.1:$port:8080" -e PUID=1000 -e PGID=1000 \
    -v "$WORK/$t/config:/config" -v "$WORK/$t/galleries:/galleries" -v "$WORK/$t/incoming:/incoming" -v "$WORK/$t/cache:/cache" "$IMAGE" >/dev/null
  for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0; sleep 1; done
  docker logs "$RUN-$t" | tail -20; echo "container $t did not become healthy" >&2; return 1
}
# A gets a fixed setup code through the environment. B gets none, so it prints a random one to its log, which is what
# an operator does in real life; the suite reads it back from there.
SETUP_A="audit-setup-A1"
start a "$PORT_A" -p "127.0.0.1:$SFTP_A:2222" -e "SETUP_CODE=$SETUP_A"
start b "$PORT_B"
SETUP_B="$(docker logs "$RUN-b" 2>&1 | grep -o 'setup code: [A-Z0-9-]*' | head -1 | sed 's/.*: //')"
[ -n "$SETUP_B" ] || { echo "no setup code was printed to the log of deployment b" >&2; exit 1; }

echo "== live suite (hardened=$HARDEN)"
set +e
OP_SETUP_A="$SETUP_A" OP_SETUP_B="$SETUP_B" OP_A_URL="http://127.0.0.1:$PORT_A" OP_B_URL="http://127.0.0.1:$PORT_B" OP_A_GALLERIES="$WORK/a/galleries" OP_A_INCOMING="$WORK/a/incoming" \
OP_A_SFTP_PORT="$SFTP_A" OP_REPORT="$OUT/live-suite.json" node security/tests/live/suite.mjs
LIVE=$?

echo "== network isolation between the two deployments"
bash security/scripts/isolation.sh "$RUN-a" "$RUN-b" "$OUT/isolation.json"
ISO=$?
set -e
docker logs "$RUN-a" 2>&1 | tail -5 >/dev/null
exit $(( LIVE != 0 || ISO != 0 ))
