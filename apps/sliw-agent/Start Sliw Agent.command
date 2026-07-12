#!/bin/bash
# Double-click this file in Finder to open the Sliw Agent web desk.
cd "$(dirname "$0")"

echo "══════════════════════════════════════════"
echo "  Sliw Agent · Edyta Śliwińska"
echo "  Representation desk"
echo "══════════════════════════════════════════"
echo ""

python3 -m pip install -q -r requirements.txt 2>/dev/null

echo "Starting desk at http://127.0.0.1:8787"
echo "Leave this window open. Press Ctrl+C to stop."
echo ""

# Open browser shortly after server binds
(sleep 1.5 && open "http://127.0.0.1:8787") &

python3 -m uvicorn sliw_agent.server:app --host 127.0.0.1 --port 8787
