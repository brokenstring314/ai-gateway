#!/usr/bin/env bash
# Print GitHub release notes for <version>: its CHANGELOG.md section, install
# pointers, and the Ferro Labs acknowledgement.
# Usage: scripts/release-notes.sh <version>   (e.g. 0.2.0)
set -euo pipefail

VERSION="${1:?usage: $0 <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${GITHUB_REPOSITORY:-brokenstring314/ai-gateway}"
IMAGE="ghcr.io/${REPO,,}"

section="$(awk -v v="$VERSION" '
  /^## / { if (found) exit; if (index($0, "## " v " ") == 1 || $0 == "## " v) { found = 1; next } }
  found { print }
' "$ROOT/CHANGELOG.md")"
if [ -z "${section//[$'\n\t ']/}" ]; then
  echo "error: no CHANGELOG.md section for $VERSION" >&2
  exit 1
fi

cat <<MD
## Install

- Docker (linux/amd64, linux/arm64): \`docker pull $IMAGE:$VERSION\`
- Standalone binary: download the archive for your platform below, check it
  against \`SHA256SUMS\`, then run \`./ai-gateway serve -c config.yaml\`
  (start from the bundled \`config.example.yaml\`). Binaries are not code-signed.

$section

## Acknowledgements

The design of this project originates from
[Ferro Labs AI Gateway](https://github.com/ferro-labs/ai-gateway), licensed
under the Apache License 2.0. Many thanks to the Ferro Labs team; attribution
is kept in the NOTICE file shipped with every artifact. This project is
distributed under the Apache License 2.0 (see LICENSE).
MD
