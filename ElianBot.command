#!/bin/bash
# ElianBot.command — double-click to launch ElianBot.
# Installs dependencies on first run, then starts the app.

set -e
cd "$(dirname "$0")"

# Node is required. Check the usual locations even when Terminal has a bare PATH.
for p in /opt/homebrew/bin /usr/local/bin; do
  [ -x "$p/node" ] && export PATH="$p:$PATH"
done
if ! command -v node >/dev/null 2>&1; then
  echo "ElianBot needs Node.js. Install it from https://nodejs.org and run this again."
  read -r -p "Press Enter to close."
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  echo "First run — installing Electron (one time)…"
  npm install --no-fund --no-audit
fi

echo "Starting ElianBot…"
exec npm start
