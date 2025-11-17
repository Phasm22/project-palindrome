#!/usr/bin/env bash

# Load .env file if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Set defaults if not already set from .env
export OPNSENSE_URL="${OPNSENSE_URL:-https://10.10.31.1}"
export OPNSENSE_API_KEY="${OPNSENSE_API_KEY:-xxx}"
export OPNSENSE_API_SECRET="${OPNSENSE_API_SECRET:-yyy}"
export OPNSENSE_VERIFY_SSL="${OPNSENSE_VERIFY_SSL:-false}"

npx -y @richard-stovall/opnsense-mcp-server

