#!/bin/sh
# Apply timezone at runtime so TZ env var in compose overrides the default
if [ -f "/usr/share/zoneinfo/$TZ" ]; then
  ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
  echo "$TZ" > /etc/timezone
fi

# Start the always-on sync service. It clears its own Actual cache before each
# run and listens for POST /run (button) plus its built-in nightly schedule.
exec node sync.js
