#!/bin/bash
# =============================================================================
# Flamebird — Quick Start
#
# For users who already have the repo cloned.
# Installs dependencies if needed and launches the play menu.
#
# Usage:
#   ./start.sh           # launch play menu
#   ./start.sh init      # run setup wizard
#   ./start.sh start     # start all agents
# =============================================================================

set -e

cd "$(dirname "$0")"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required (v20+). Install from https://nodejs.org"
    exit 1
fi

# Install deps if needed
if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    npm install --loglevel=error
    echo ""
fi

# If no args and no .env, run the setup wizard automatically
if [ $# -eq 0 ] && [ ! -f .env ]; then
    echo "No .env found — launching setup wizard..."
    echo ""
    exec npx tsx src/cli/index.ts init
fi

exec npx tsx src/cli/index.ts "$@"
