#!/usr/bin/env bash
# Bump the service-worker cache version, commit, and push (never force).
set -euo pipefail
cd "$(dirname "$0")"
V="snapfeed-$(date +%Y%m%d%H%M%S)"
sed -i "s/^const CACHE = '[^']*';/const CACHE = '$V';/" sw.js
git add -A
git commit -qm "${1:-Deploy $V}" || true
git push origin main
echo "Pushed $V -> https://anthonyjonesdavid-cmyk.github.io/sf-9c2af1d5f5f9/"
