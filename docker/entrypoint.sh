#!/bin/sh
# Runs OpenPortrait as PUID:PGID so files on your shares get the owner you expect.
# Unraid uses 99:100 (nobody:users); most other hosts use 1000:1000.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
umask "${UMASK:-022}"

if [ "$(id -u)" = "0" ]; then
  # Give the app user the requested ids, reusing an existing group/user if one already has them.
  group="$(getent group "$PGID" | cut -d: -f1)"
  if [ -z "$group" ]; then
    groupadd -o -g "$PGID" openportrait
    group=openportrait
  fi
  user="$(getent passwd "$PUID" | cut -d: -f1)"
  if [ -z "$user" ]; then
    useradd -o -u "$PUID" -g "$group" -d /config -s /usr/sbin/nologin -K UID_MIN=1 openportrait
    user=openportrait
  fi

  # /config and /cache belong to the app. Photo shares are only fixed at the top level,
  # so a large library is never walked or re-owned on start.
  for d in /config /cache; do
    mkdir -p "$d"
    chown -R "$PUID:$PGID" "$d"
  done
  for d in /galleries /incoming; do
    mkdir -p "$d"
    [ "$(stat -c %u "$d")" = "$PUID" ] || chown "$PUID:$PGID" "$d" 2>/dev/null || \
      echo "openportrait: warning: can't change the owner of $d; make sure user $PUID can write to it" >&2
  done

  export HOME=/config
  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
