#!/bin/sh
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
export LIBVA_DRIVER_NAME=nvidia
export NVD_BACKEND=direct
export LIBVA_DRIVERS_PATH=/app/lib/dri
exec zypak-wrapper /app/midnightcord/midnightcord --ozone-platform-hint=auto --disable-features=Vulkan "$@"
