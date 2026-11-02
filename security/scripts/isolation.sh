#!/usr/bin/env bash
# Network-level isolation checks between two running deployments. Usage: isolation.sh <container-a> <container-b> <report.json>
# Uses `docker exec` into the app containers only; the Docker socket is never mounted anywhere.
set -uo pipefail
A="$1"; B="$2"; REPORT="${3:-/dev/null}"
fails=0; rows=()
probe() { # container url
  docker exec "$1" node -e "fetch('$2',{signal:AbortSignal.timeout(4000)}).then(r=>console.log('REACHED '+r.status)).catch(e=>console.log('BLOCKED '+(e.cause&&e.cause.code||e.name)))" 2>/dev/null
}
check() { # id title expected(BLOCKED|REACHED) actual
  local ok=pass; [[ "$4" == "$3"* ]] || { ok=FAIL; fails=$((fails+1)); }
  printf '%-6s %-9s %s [%s]\n' "$ok" "$1" "$2" "$4"
  rows+=("{\"id\":\"$1\",\"title\":\"$2\",\"status\":\"$ok\",\"observed\":\"$4\"}")
}
ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
gw_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' "$1"; }
IPB="$(ip_of "$B")"; GWA="$(gw_of "$A")"
check NET-1 "deployment A cannot open deployment B's container address (separate networks)" BLOCKED "$(probe "$A" "http://$IPB:8080/api/health")"
check NET-2 "deployment A cannot reach B through the host gateway on B's loopback-only published port" BLOCKED "$(probe "$A" "http://$GWA:${PORT_B:-18081}/api/health")"
check NET-3 "the Docker socket is not present inside a deployment" BLOCKED "$(docker exec "$A" sh -c 'test -S /var/run/docker.sock && echo REACHED || echo BLOCKED')"
check NET-4 "the app process runs unprivileged with no capabilities" BLOCKED "$(docker exec "$A" sh -c 'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = node ] && awk "/^Uid/{u=\$2} /CapEff/{c=\$2} END{ if (u!=0 && c ~ /^0+\$/) print \"BLOCKED\"; else print \"REACHED uid=\" u \" caps=\" c}" $p/status; done | head -1')"
STRAY="$(docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' "$A" | grep -vE '^(/config|/galleries|/incoming|/cache)?$' || true)"
check NET-5 "no host path other than the four data volumes is mounted" BLOCKED "$([ -z "$STRAY" ] && echo BLOCKED || echo "REACHED $STRAY")"
printf '{"at":"%s","failed":%d,"results":[%s]}\n' "$(date -u +%FT%TZ)" "$fails" "$(IFS=,; echo "${rows[*]}")" > "$REPORT"
exit $(( fails > 0 ))
