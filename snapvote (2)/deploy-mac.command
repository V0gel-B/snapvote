#!/bin/bash
# Double-click me (macOS) to put SnapVote online.
cd "$(dirname "$0")" || exit 1
# Finder doesn't load your shell profile, so look in the usual Node.js places.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is needed (free). Opening https://nodejs.org — install the LTS version,"
  echo "  then double-click this file again."
  open "https://nodejs.org/en/download"
  read -r -p "  Press Enter to close… " _
  exit 1
fi
node scripts/deploy.mjs "$@"
echo ""
read -r -p "  Press Enter to close… " _
