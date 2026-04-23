#!/usr/bin/env bash
# start-mobile.sh — start the Expo dev server from any directory
# Usage:  ./scripts/start-mobile.sh
#         bash scripts/start-mobile.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$SCRIPT_DIR/../mobile"

if [ ! -d "$MOBILE_DIR/node_modules" ]; then
  echo "📦 node_modules not found — running npm install first…"
  (cd "$MOBILE_DIR" && npm install)
fi

echo "🚀 Starting Expo dev server in $MOBILE_DIR"
cd "$MOBILE_DIR"
npx expo start
