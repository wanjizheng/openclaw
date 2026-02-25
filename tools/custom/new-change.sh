#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 \"Title\""
  exit 1
fi

TITLE="$1"
DATE_STR="$(date +%Y-%m-%d)"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

cat >> CUSTOM_CHANGES.md << LOG

## $DATE_STR

### $TITLE
- What changed:
  - 
- Why:
  - 
- Files:
  - 
- User-visible behavior:
  - 
LOG

echo "[ok] template appended to CUSTOM_CHANGES.md"
