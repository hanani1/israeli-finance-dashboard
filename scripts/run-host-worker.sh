#!/bin/zsh
# Safety class: TOUCHES PROVIDER, WRITES DB, SENSITIVE (loads .env, logs in to every bank
# with the stored credentials and ingests into the live database). Host worker entrypoint
# for launchd: runs one ingestion + categorization cycle (`npm run sync:once`).
set -euo pipefail

# Run from the repository root regardless of where launchd starts us.
cd "$(dirname "$0")/.."

# Load local configuration without copying credentials into the LaunchAgent plist.
set -a
source .env
set +a

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# Scraped dates (and so transaction ids) depend on the process zone; keep it
# identical to the Docker image (ADR-0020). Ingestion also pins it in-process.
export TZ="Asia/Jerusalem"
export DATABASE_URL="postgresql://${POSTGRES_USER:-finance}:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@127.0.0.1:5432/${POSTGRES_DB:-finance}?schema=public"
export ISRACARD_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export ISRACARD_USER_DATA_DIR="${HOME}/.finance-dashboard/isracard-chrome-profile"
# LLM categorization is opt-in; set these in .env (see .env.example).
export LLM_CATEGORIZATION_ENABLED="${LLM_CATEGORIZATION_ENABLED:-false}"
export CATEGORIZATION_CLI="${CATEGORIZATION_CLI:-hermes}"

exec npm run sync:once -- "$@"
