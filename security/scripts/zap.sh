#!/usr/bin/env bash
# Authenticated OWASP ZAP scan against a disposable container (never production). Usage: IMAGE=openportrait:security security/scripts/zap.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="$(cd "${OUT:-security/reports}" 2>/dev/null && pwd || (mkdir -p security/reports && cd security/reports && pwd))"
IMAGE="${IMAGE:?set IMAGE to the image to scan}"
ZAP_IMAGE="${ZAP_IMAGE:-zaproxy/zap-stable:20261008@sha256:7aaa659b0d43078febd82e29bad112285c370727e86ab8340444220e17d9f0d2}"
RUN="op-zap-$$"; WORK="$(mktemp -d)"
cleanup() { docker rm -f "$RUN-app" "$RUN-zap" >/dev/null 2>&1 || true; docker network rm "$RUN" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT
docker network create "$RUN" >/dev/null
mkdir -p "$WORK"/{config,galleries,incoming,cache}; chmod -R 777 "$WORK"
docker run -d --name "$RUN-app" --network "$RUN" --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER \
  --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --pids-limit 512 --memory 2g \
  -p 127.0.0.1:18095:8080 -e SETUP_CODE=zap-setup-code -e PUID=1000 -e PGID=1000 \
  -v "$WORK/config:/config" -v "$WORK/galleries:/galleries" -v "$WORK/incoming:/incoming" -v "$WORK/cache:/cache" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:18095/api/health >/dev/null 2>&1 && break; sleep 1; done
JAR="$WORK/jar"
curl -fsS -c "$JAR" -X POST http://127.0.0.1:18095/api/studio/setup -H 'content-type: application/json' \
  -d '{"studioName":"ZAP Studio","ownerName":"Owner Z","email":"owner-z@audit.invalid","password":"synthetic-Pass-12345","timezone":"UTC","setupCode":"zap-setup-code"}' >/dev/null
SESSION="op_session=$(awk '$6=="op_session"{print $7}' "$JAR")"
curl -fsS -b "$JAR" -X PUT http://127.0.0.1:18095/api/studio/ai -H 'content-type: application/json' -d '{"enabled":true}' >/dev/null
curl -fsS -b "$JAR" -X PUT http://127.0.0.1:18095/api/studio/inquiry -H 'content-type: application/json' -d '{"enabled":true}' >/dev/null
cp security/zap/plan.yaml "$WORK/plan.yaml"; chmod 777 "$WORK"
mkdir -p "$WORK/wrk"; chmod 777 "$WORK/wrk"; cp "$WORK/plan.yaml" "$WORK/wrk/plan.yaml"
# ZAP runs on the same private network as the target and has no Docker socket and no access to anything else of ours.
docker run --name "$RUN-zap" --network "$RUN" -v "$WORK/wrk:/zap/wrk:rw" -e TARGET="http://$RUN-app:8080" -e ZAP_SESSION="$SESSION" \
  "$ZAP_IMAGE" zap.sh -cmd -silent -autorun /zap/wrk/plan.yaml || true
cp "$WORK/wrk/zap.json" "$OUT/zap.json" 2>/dev/null && echo "wrote $OUT/zap.json" || echo "ZAP produced no report"
cp "$WORK/wrk/zap.html" "$OUT/zap.html" 2>/dev/null || true

