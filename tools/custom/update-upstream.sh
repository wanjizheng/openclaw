#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'The old -X ours updater is retired. Use tools/custom/release-integrate-and-build.sh; it creates an isolated candidate and never merges or pushes.' >&2
exit 2
