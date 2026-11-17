#!/bin/sh
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
export XDG_SESSION_TYPE=x11
exec zypak-wrapper /app/midnightcord/midnightcord --ozone-platform=x11 "$@"
