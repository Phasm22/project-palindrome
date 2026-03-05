#!/usr/bin/env bash
# Notify via pnotify (Pushover). Tries current PATH first, then sources ~/.bashrc and retries.
# Use for "task done" / long-running completion so the exit code is always 0 (don't fail the step).
#
# Usage:
#   scripts/pnotify-done.sh "Title" "Message"
#   scripts/pnotify-done.sh "Palindrome: Done" "Feature X implemented and tests pass."
#
# Why the fallback: in some environments (e.g. Cursor agent, CI) pnotify may not be in PATH
# until .bashrc is sourced (e.g. it adds ~/bin). Sourcing and retrying avoids "pnotify not available".

set -e
TITLE="${1:-Palindrome}"
MESSAGE="${2:-Done.}"

run_pnotify() {
  if command -v pnotify >/dev/null 2>&1; then
    pnotify "$TITLE" "$MESSAGE" || true
    return 0
  fi
  return 1
}

if run_pnotify; then
  exit 0
fi

# Fallback: source bashrc then retry (so ~/bin or custom PATH is available)
if [ -r "${HOME:-~}/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "${HOME:-~}/.bashrc" 2>/dev/null || true
fi
run_pnotify || true
exit 0
