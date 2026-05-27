#!/bin/sh
# Apply timezone at runtime so TZ env var in compose overrides the default
if [ -f "/usr/share/zoneinfo/$TZ" ]; then
  ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
  echo "$TZ" > /etc/timezone
fi

# Clear stale Actual Budget cache then run sync
rm -rf /tmp/actual-cache/*
exec node sync.js
