#!/bin/bash
# Run me (Linux) to put SnapVote online:  ./deploy-linux.sh
cd "$(dirname "$0")" || exit 1
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is needed: https://nodejs.org (or your package manager). Then run this again."
  exit 1
fi
exec node scripts/deploy.mjs "$@"
