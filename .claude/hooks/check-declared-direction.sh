#!/usr/bin/env bash
# Blocks "gh pr create"/"gh pr edit" commands whose body is missing Quire's
# <!-- declared-direction: ... --> marker. Installed by Quire's repo setup — see CLAUDE.md.
set -euo pipefail

input="$(cat)"

# Match directly against the raw JSON payload rather than trying to isolate a clean
# "command" substring first: the command is JSON-escaped, so any quoted argument before
# the body (e.g. --title "...") truncates a naive `"[^"]*"` extraction at its first
# embedded quote, well before the body/marker is ever reached.
if ! printf '%s' "$input" | grep -qE 'gh pr (create|edit)'; then
  exit 0
fi

if printf '%s' "$input" | grep -qE '<!--[[:space:]]*declared-direction:[[:space:]]*[^[:space:]].*-->'; then
  exit 0
fi

echo "This PR body is missing a <!-- declared-direction: ... --> marker. Add one describing this PR's product-direction intent before opening/editing the PR." >&2
exit 2
