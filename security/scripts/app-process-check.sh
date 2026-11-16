#!/bin/sh
# NET-4 helper. Runs INSIDE the container (isolation.sh pipes it to `docker exec -i <c> sh -s`), POSIX sh only.
# Finds the OpenPortrait app process by identity, not by "the first node": the image has no USER, so a
# `docker exec ... node -e` probe or the HEALTHCHECK node probe runs as root with the container's capability
# set and can be listed before the app. The app is the node process whose command line runs APP_MAIN
# (entrypoint.sh drops to PUID:PGID with `exec gosu`, so it is one process, no wrapper).
# Output, one line: "BLOCKED ..." only when exactly one app process exists, none of its uids is 0 and CapEff is
# all zero. Anything else starts with "REACHED" (isolation.sh treats that as failure) and names pid, uid, caps
# and the command line so a bad selection can be diagnosed from the CI log.
# PROC_ROOT and APP_MAIN exist so the check can be tested against a fake /proc.
PROC_ROOT="${PROC_ROOT:-/proc}"
APP_MAIN="${APP_MAIN:-/app/apps/server/dist/main.js}"
found=0; verdict=""; others=""
for p in "$PROC_ROOT"/[0-9]*; do
  [ -r "$p/comm" ] || continue
  [ "$(cat "$p/comm" 2>/dev/null)" = node ] || continue
  pid="${p##*/}"
  cmd="$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null | sed 's/ *$//')"
  case " $cmd " in
    *" $APP_MAIN "*) ;;
    *) others="$others [pid=$pid cmd=$cmd]"; continue ;;
  esac
  found=$((found + 1))
  line="$(awk '/^Uid:/{u=$2 "/" $3 "/" $4 "/" $5; z=($2==0||$3==0||$4==0||$5==0)} /^CapEff:/{c=$2} END{ if (z || c !~ /^0+$/) print "REACHED"; else print "BLOCKED"; print " uid=" u " caps=" c }' "$p/status" 2>/dev/null | tr -d '\n')"
  verdict="$verdict${verdict:+ ; }$line pid=$pid cmd=$cmd"
done
if [ "$found" -eq 0 ]; then
  echo "REACHED no app process found (looking for node running $APP_MAIN); other node processes:${others:- none}"
elif [ "$found" -gt 1 ]; then
  echo "REACHED ambiguous: $found app processes: $verdict"
else
  echo "$verdict"
fi
